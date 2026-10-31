// Judgeiverse: files each Claude Code thread into a GitHub manifest, so a session can be cleared
// once it goes cold and its thread picked up again from any machine. After each turn, once the
// conversation has paused, a fork of it judges the thread (what it is about, where it stands, its
// project, the next step) and the verdict is filed as threads/<account>/<session>.json; the mod
// bundles every thread into projects, and at session start it says which open threads already
// cover this project. A pane lists them beside the chat; threads merge within a project, and a
// deleted thread leaves the manifest for its project's sub-manifest (projects/<slug>.json) as one
// line. Keeping the prompt cache warm is left to a mod of its own: this one began as a fork of
// Cache Keep-Warm (AndreiC81, MIT), and its keep-warm engine was taken out in 0.8.0.
import { update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  ArchivedThread,
  JudgeVerdict,
  Manifest,
  ManifestProject,
  ManifestThread,
  PaneEdit,
  ProjectArchive,
  ThreadEntry,
  TidyPlan,
  TidyProposal,
} from '../types'
import { ago, mdCode, mdText, pickMark, plural, proposalLabel, shortAgo, summaryQuote, threadSubtitle, threadsReply, tidyDone, tidyReply } from './format'
import type { Assignment } from './judge'
import { RECENT_MS, guardTidy, parseTidy, pickedProposals, protectedIds, stillValid, tidyPrompt, tidyRefs, tidyRules } from './tidy'
import type { RawTidy, TidyRef } from './tidy'
import { RELEASE } from './version'
import {
  ARCHIVE_DIR,
  ENTRY_GONE,
  JUDGE_PROMPT,
  MANIFEST_FILE,
  THREADS_DIR,
  TRANSCRIPT_GONE,
  addToArchives,
  archiveJson,
  archivePath,
  archivedFrom,
  attachArchives,
  bundle,
  bundlePrompt,
  buildOf,
  deletedHow,
  describeThread,
  entryJson,
  findThreads,
  fromBase64,
  keptEntries,
  localVerdict,
  manifestJson,
  parseArchive,
  parseAssignment,
  parseEntry,
  parseManifest,
  parseRepo,
  parseVerdict,
  pathSegment,
  previousAssignment,
  projectOf,
  relatedThreads,
  renderMarkdown,
  statusOf,
  threadPath,
  titleFrom,
  toBase64,
  tombstones,
  unplacedThreads,
} from './judge'

// A thread is filed once its conversation has paused this long after a turn. A cloud container
// stops about 5 minutes after the last turn, so the judge and the commit still have time to
// finish there; and the judge's fork reads a cache the turn has just written, whatever its length.
const FILE_AFTER_IDLE_MS = 2 * 60_000
// One check every 15 s: local reads only (the clock and the state), no model call.
const TICK_MS = 15_000
const DETAIL_GAP = 2
// The keep-warm builds put this in front of the app's session title while keep-warm was on.
const TITLE_MARK = '🟢 '
const TITLE_SYNC_MS = 5 * 60_000
const GET_SESSION_TOOL = 'mcp__ccd_session_mgmt__get_session'
const SET_TITLE_TOOL = 'mcp__ccd_session_mgmt__set_session_title'
const TITLE_FIELD = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/
const JUDGE_COMMAND = 'judge'
// What the keep-warm builds kept in the store (a session's countdown, the plan's cache length);
// nothing reads it now, so it is taken out at start.
const OLD_STORE_KEY = /^(session:|plan-ttl$)/

// The judge layer's own constants.
const GITHUB_API = 'https://api.github.com'
const GITHUB_API_VERSION = '2022-11-28'
// The userConfig keys in plugin.json.
const REPO_OPTION = 'manifest_repo'
const ACCOUNT_OPTION = 'account_label'
const TOKEN_OPTION = 'github_token'
const FILE_THREADS_OPTION = 'file_threads'
const JUDGE_MODEL_OPTION = 'judge_model'
const SWEEP_OPTION = 'sweep_deleted'
const MANIFEST_MD = 'MANIFEST.md'
// Files of the manifest repository are kept in the store by blob sha, so a filing fetches only
// what changed since the last one.
const BLOB_PREFIX = 'blob:'
// How many related threads the start-of-session notice names.
const RELATED_SHOWN = 3
const PLUGIN_NAME = 'judge-keep-warm'
// The line's name, first on it, so it reads as this mod's at a glance.
const LABEL = 'Judgeiverse'
const LABEL_COLOR = 'cyan'
// Where no surface draws the band above the prompt (a cloud session's chat), the same content
// goes into a pane, opened this long after start unless the band has been asked for by then.
const PANE = 'judgeiverse'
const PANE_TITLE = 'Judgeiverse'
const PANE_DECIDE_MS = 6000
// The thread's title in the line is cut to this many characters.
const TITLE_SHOWN = 40
const TITLE_MIN = 12
// Room the File now button and the gaps take, in columns, when fitting the details to the line;
// and the Threads button beside it.
const BUTTON_COLUMNS = 14
const THREADS_BUTTON_COLUMNS = 12
// A manifest older than this is read again when the person opens the pane.
const PANE_FRESH_MS = 5 * 60_000
// The thread titles the pane's buttons show are cut to this.
const BUTTON_TITLE_MAX = 48
const FILED_BY: Record<ThreadEntry['filedBy'], string> = { judge: 'by the judge', local: 'local summary', end: 'at the end' }
const FIT_MARGIN = 4
// How long a filing's outcome stays lit on the line before it goes back to dim.
const FLASH_MS = 8000
// The start-of-session notice suggests /judge tidy once this many open threads cover the project.
const TIDY_NUDGE = 5
// The tools the model calls to read the manifest and tidy it, listed as mcp__judge-keep-warm__<name>.
const LIST_TOOL = 'list_threads'
const TIDY_TOOL = 'tidy_threads'
const LIST_TOOL_ID = 'mcp__judge-keep-warm__list_threads'
const TIDY_TOOL_ID = 'mcp__judge-keep-warm__tidy_threads'
// What list_threads shows of each summary.
const TOOL_SUMMARY_MAX = 300

const NOW = { plugin: 'judge-keep-warm', key: 'now' } as const
const FILE_DUE = { plugin: 'judge-keep-warm', key: 'fileDueAt' } as const
const FILING_NOW = { plugin: 'judge-keep-warm', key: 'filingNow' } as const
const VERDICT = { plugin: 'judge-keep-warm', key: 'verdict' } as const
const FILING = { plugin: 'judge-keep-warm', key: 'filing' } as const
const RELATED = { plugin: 'judge-keep-warm', key: 'related' } as const
const ACTIVE = { plugin: 'judge-keep-warm', key: 'lastActiveAt' } as const
const MANIFEST_THREADS = { plugin: 'judge-keep-warm', key: 'manifestThreads' } as const
const MANIFEST_PROJECTS = { plugin: 'judge-keep-warm', key: 'manifestProjects' } as const
const UPDATES = { plugin: 'judge-keep-warm', key: 'updates' } as const
const UPDATED_AT = { plugin: 'judge-keep-warm', key: 'updatedAt' } as const
const FLASH_FAILED = { plugin: 'judge-keep-warm', key: 'flashFailed' } as const
const FLASH_UNTIL = { plugin: 'judge-keep-warm', key: 'flashUntil' } as const
const TITLE = { plugin: 'judge-keep-warm', key: 'title' } as const
const MANIFEST = { plugin: 'judge-keep-warm', key: 'manifest' } as const
const MANIFEST_READ_AT = { plugin: 'judge-keep-warm', key: 'manifestReadAt' } as const
const MANIFEST_ERROR = { plugin: 'judge-keep-warm', key: 'manifestError' } as const
const PANE_VIEW = { plugin: 'judge-keep-warm', key: 'paneView' } as const
const PANE_EDIT = { plugin: 'judge-keep-warm', key: 'paneEdit' } as const
const PANE_NOTICE = { plugin: 'judge-keep-warm', key: 'paneNotice' } as const
const IS_BUSY = { plugin: 'judge-keep-warm', key: 'isBusy' } as const
const SELF_ARCHIVED = { plugin: 'judge-keep-warm', key: 'selfArchived' } as const
const PANE_OPEN_THREAD = { plugin: 'judge-keep-warm', key: 'paneOpenThread' } as const
const PANE_OPEN_ARCHIVE = { plugin: 'judge-keep-warm', key: 'paneOpenArchive' } as const
const TIDY_PLAN = { plugin: 'judge-keep-warm', key: 'tidyPlan' } as const
const TIDY_OFF = { plugin: 'judge-keep-warm', key: 'tidyOff' } as const

// The module's own variables start over on a reload; what must survive one is in $.state.
const live: {
  // The session this process files for, to tell a /clear or another session resumed here from a
  // relaunch of the same one; '' before the first start.
  sessionId: string
  // True from a main-loop turn's start to its end: a filing waits for the pause after it.
  isTurnRunning: boolean
  // The minute the line last showed, so the clock redraws it once a minute, not every tick.
  shownMinute: number
  // A thread a /clear ended before its filing was due: captured as it ended, filed by the next tick.
  endedThread: { snap: ThreadSnapshot; verdict: JudgeVerdict } | null
  // The judge layer: the manifest repository (owner/repo, '' = not configured), the account's
  // label, whether threads are filed by themselves, the token option, the token once resolved
  // (null = not yet tried), the host's names, and whether a filing is under way.
  repo: string
  account: string
  fileThreads: boolean
  tokenOption: string
  tokens: string[] | null
  tokenIndex: number
  judgeModel: string
  branch: string
  // 'api': GitHub's REST git data; 'git': the clone, once a REST write was refused.
  backend: 'api' | 'git'
  host: string
  user: string
  isFiling: boolean
  // Whether a surface has asked for the band since this process started, and whether the pane
  // was opened in its place.
  bandSeen: boolean
  paneOpen: boolean
  // The mod's own build, from its manifest or its install folder, for the line, the pane and /judge.
  version: string
  // Take threads whose session was deleted on this machine out of the manifest.
  sweepDeleted: boolean
} = {
  sessionId: '',
  isTurnRunning: false,
  shownMinute: 0,
  endedThread: null,
  repo: '',
  account: '',
  fileThreads: true,
  tokenOption: '',
  tokens: null,
  tokenIndex: 0,
  judgeModel: '',
  branch: '',
  backend: 'api',
  host: '',
  user: '',
  isFiling: false,
  bandSeen: false,
  paneOpen: false,
  version: '',
  sweepDeleted: true,
}

function minutes(ms: number) {
  return Math.max(0, Math.floor(ms / 60_000))
}

function clockTime(ms: number) {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// The counter's parts: what the manifest held when last read or written, and the tally of
// updates this session made to it. Empty before any of them is known.
function counter(threads: number, projects: number, updates: number) {
  const parts: string[] = []
  if (threads > 0 || projects > 0) parts.push(plural(threads, 'thread'), plural(projects, 'project'))
  if (updates > 0) parts.push(plural(updates, 'update'))
  return parts
}

// The conversation starts over (a /clear, or another session resumed in this process): what the
// mod knew of the thread was the old one's.
async function startOver($: EngineInterface) {
  await $.state.set(FILE_DUE, 0)
  await $.state.set(ACTIVE, 0)
  await $.state.set(VERDICT, null)
  await $.state.set(FILING, null)
  await $.state.set(SELF_ARCHIVED, null)
  await $.state.set(TITLE, '')
  await $.state.set(NOW, await $.clock.now())
}

// The session's title as the desktop app's list has it, without the mark; '' outside the app.
async function readTitle($: EngineInterface) {
  try {
    const found = await $.tool.call({ tool: GET_SESSION_TOOL, session_id: 'self' })
    if ('deny' in found && found.deny) return ''
    const match = TITLE_FIELD.exec(found.text ?? '')
    if (!match) return ''
    const title: string = JSON.parse(`"${match[1]}"`)
    return title.startsWith(TITLE_MARK) ? title.slice(TITLE_MARK.length) : title
  } catch {
    return ''
  }
}

// The thread's title for the line: the app's session title, else the first prompt's first line.
async function rememberTitle($: EngineInterface) {
  let title = await readTitle($)
  if (!title) {
    const messages = await $.session.messages()
    title = messages.length > 0 ? titleFrom(messages, await $.session.cwd()) : ''
  }
  const { value: was = '' } = await $.state.get(TITLE)
  if (title && title !== was) await $.state.set(TITLE, title)
}

// Keeps the line's title current, and takes off the green dot a keep-warm build left in front of
// the app's session title.
async function syncTitle($: EngineInterface) {
  try {
    await rememberTitle($)
    const found = await $.tool.call({ tool: GET_SESSION_TOOL, session_id: 'self' })
    if ('deny' in found && found.deny) return
    const match = TITLE_FIELD.exec(found.text ?? '')
    if (!match) return
    const title: string = JSON.parse(`"${match[1]}"`)
    if (!title.startsWith(TITLE_MARK)) return
    await $.tool.call({ tool: SET_TITLE_TOOL, session_id: 'self', title: title.slice(TITLE_MARK.length) })
  } catch {
    // No session tools here (a terminal session), the app declined the rename, or the transcript
    // could not be read: leave the title as it is.
  }
}

// ---- The judge layer: GitHub ------------------------------------------------------------------

function isJudging() {
  return live.repo !== ''
}

// The tokens this host offers, in order: the option, the environment, the gh CLI's login. The
// first is used until GitHub answers 401 to it (a stale variable in a long-lived process), then
// the next; '' when none is left.
async function githubTokens($: EngineInterface) {
  if (live.tokens !== null) return live.tokens
  const found: string[] = []
  const add = (t: string | undefined) => {
    const v = (t ?? '').trim()
    if (v && !found.includes(v)) found.push(v)
  }
  add(live.tokenOption)
  add(await $.env.get('JUDGE_KEEP_WARM_TOKEN'))
  add(await $.env.get('GH_TOKEN'))
  add(await $.env.get('GITHUB_TOKEN'))
  try {
    const r = await $.process.run(['gh', 'auth', 'token'], { timeoutMs: 10_000 })
    if (r.exitCode === 0) add(r.stdout)
  } catch {
    // No gh here (the desktop app, or not installed): nothing to add.
  }
  live.tokens = found
  return found
}

async function githubToken($: EngineInterface) {
  const tokens = await githubTokens($)
  return tokens[live.tokenIndex] ?? ''
}

// GitHub's own words on a failed request, for the error.
function hint(r: { status: number; text: string }) {
  try {
    const j = JSON.parse(r.text) as { message?: string }
    return j.message ? `: ${j.message}` : ''
  } catch {
    return ''
  }
}

async function githubFetch($: EngineInterface, method: string, path: string, body?: unknown) {
  const tokens = await githubTokens($)
  if (tokens.length === 0) throw new Error('no GitHub token: set the GitHub token option, JUDGE_KEEP_WARM_TOKEN, or log in with gh')
  for (;;) {
    // Past the last token, one try with no credential of the mod's own: a host whose proxy
    // signs GitHub requests itself (a cloud session) answers that one.
    const token = await githubToken($)
    const r = await $.http.fetch(`${GITHUB_API}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    // Bad credentials: this token is stale; the next source gets its turn, for good.
    if (r.status !== 401 || !token) return r
    live.tokenIndex++
    $.ui.log(`judge: GitHub refused a token (401); trying ${live.tokenIndex < tokens.length ? 'the next one' : 'without one'}`, { to: 'debug' })
  }
}

async function githubJson<T>($: EngineInterface, method: string, path: string, what: string, body?: unknown): Promise<T> {
  const r = await githubFetch($, method, path, body)
  if (!r.ok) throw new Error(`GitHub answered ${r.status} ${what}${hint(r)}`)
  return JSON.parse(r.text) as T
}

type RepoHead = { branch: string; commit: string; tree: string }
type TreeEntry = { path: string; sha: string; type: string }
type RepoFile = { path: string; text: string }

// The default branch and its head commit and tree; null while the repository has no commit.
async function repoHead($: EngineInterface): Promise<RepoHead | null> {
  if (!live.branch) {
    const info = await githubJson<{ default_branch?: string }>($, 'GET', `/repos/${live.repo}`, `reading ${live.repo}`)
    live.branch = info.default_branch ?? 'main'
  }
  const ref = await githubFetch($, 'GET', `/repos/${live.repo}/git/ref/heads/${live.branch}`)
  if (ref.status === 404 || ref.status === 409) return null
  if (!ref.ok) throw new Error(`GitHub answered ${ref.status} reading the ${live.branch} branch${hint(ref)}`)
  const commit = (JSON.parse(ref.text) as { object: { sha: string } }).object.sha
  const c = await githubJson<{ tree: { sha: string } }>($, 'GET', `/repos/${live.repo}/git/commits/${commit}`, 'reading the head commit')
  return { branch: live.branch, commit, tree: c.tree.sha }
}

// Every file of the repository, in one request.
async function readTree($: EngineInterface, treeSha: string) {
  const t = await githubJson<{ tree?: TreeEntry[] }>($, 'GET', `/repos/${live.repo}/git/trees/${treeSha}?recursive=1`, 'reading the tree')
  return (t.tree ?? []).filter(e => e.type === 'blob')
}

// A file's text by its blob sha: from the store when seen before (a blob never changes), else
// fetched once. So a filing fetches only the threads other machines filed since the last one.
async function readBlob($: EngineInterface, sha: string) {
  const cached = await $.store.get(BLOB_PREFIX + sha)
  if (typeof cached === 'string') return cached
  const b = await githubJson<{ content: string; encoding: string }>($, 'GET', `/repos/${live.repo}/git/blobs/${sha}`, 'reading a file')
  const text = b.encoding === 'base64' ? fromBase64(b.content) : b.content
  await $.store.set(BLOB_PREFIX + sha, text)
  return text
}

async function pruneBlobs($: EngineInterface, keep: Set<string>) {
  for (const key of await $.store.keys()) {
    if (key.startsWith(BLOB_PREFIX) && !keep.has(key.slice(BLOB_PREFIX.length))) await $.store.delete(key)
  }
}

// One commit of several files on the default branch: their blobs, a tree over the head's (a null
// sha deletes a path), the commit, the branch moved to it. False when the branch moved meanwhile
// (another machine filed a thread): the caller reads the repository again and retries.
async function commitFiles($: EngineInterface, head: RepoHead, files: RepoFile[], deletes: string[], message: string) {
  const tree: { path: string; mode: '100644'; type: 'blob'; sha: string | null }[] = []
  for (const f of files) {
    const b = await githubJson<{ sha: string }>($, 'POST', `/repos/${live.repo}/git/blobs`, `writing ${f.path}`, { content: toBase64(f.text), encoding: 'base64' })
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: b.sha })
  }
  for (const path of deletes) tree.push({ path, mode: '100644', type: 'blob', sha: null })
  const t = await githubJson<{ sha: string }>($, 'POST', `/repos/${live.repo}/git/trees`, 'writing the tree', { base_tree: head.tree, tree })
  const c = await githubJson<{ sha: string }>($, 'POST', `/repos/${live.repo}/git/commits`, 'writing the commit', { message, tree: t.sha, parents: [head.commit] })
  const r = await githubFetch($, 'PATCH', `/repos/${live.repo}/git/refs/heads/${head.branch}`, { sha: c.sha })
  if (r.status === 422) return false
  if (!r.ok) throw new Error(`GitHub answered ${r.status} moving the ${head.branch} branch${hint(r)}`)
  return true
}

// An empty repository takes no git-data writes: its README goes in through the Contents API,
// which makes the default branch; every later write is a commit as above.
async function bootstrapRepo($: EngineInterface) {
  const text = await $.fs.read(`${$.plugin.root}/manifest-repo/README.md`)
  const r = await githubFetch($, 'PUT', `/repos/${live.repo}/contents/README.md`, { message: 'judge: start the thread manifest', content: toBase64(text) })
  if (!r.ok) throw new Error(`GitHub answered ${r.status} starting ${live.repo}${hint(r)}`)
}

// ---- The git fallback -------------------------------------------------------------------------
// A host whose proxy refuses GitHub's REST writes (a cloud session) still allows git itself: the
// mod then keeps a shallow clone of the manifest repository on the machine, and commits and
// pushes with git. Chosen by itself on the first refused write, for the rest of the process.

function isWriteRefused(err: unknown) {
  return err instanceof Error && /GitHub answered 403/.test(err.message)
}

async function gitDir($: EngineInterface) {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '.'
  return `${home}/.claude/judge-keep-warm/${live.repo.replace('/', '--')}`
}

// Runs git in the clone, the token (when there is one) as a header through the environment,
// never on the command line or in the clone's config.
async function git($: EngineInterface, cwd: string, args: string[], timeoutMs = 60_000) {
  const token = await githubToken($)
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' }
  if (token) Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` })
  const r = await $.process.run(['git', ...args], { cwd, env, timeoutMs })
  if (r.exitCode !== 0) {
    const why = (r.stderr || r.stdout).trim().split('\n').filter(Boolean).pop() ?? `exit ${r.exitCode}`
    throw new Error(`git ${args.find(a => !a.startsWith('-')) ?? ''} failed: ${why}`)
  }
  return r.stdout
}

// Brings the clone to the branch's head: a fresh shallow clone, or a fetch and a hard reset.
// Returns the branch; an empty repository gets its README committed and pushed first.
async function gitSync($: EngineInterface, dir: string) {
  const parent = dir.slice(0, dir.lastIndexOf('/'))
  if (!(await $.fs.exists(`${dir}/.git`))) {
    await $.fs.write(`${parent}/.keep`, '')
    await git($, parent, ['clone', '--quiet', '--depth', '1', `https://github.com/${live.repo}.git`, dir], 300_000)
  }
  let branch = (await git($, dir, ['symbolic-ref', '--short', 'HEAD'])).trim() || 'main'
  const hasCommit = (await $.process.run(['git', 'rev-parse', '--verify', '-q', 'HEAD'], { cwd: dir })).exitCode === 0
  if (!hasCommit) {
    await $.fs.write(`${dir}/README.md`, await $.fs.read(`${$.plugin.root}/manifest-repo/README.md`))
    await git($, dir, ['add', '-A'])
    await git($, dir, ['-c', 'user.name=judge-keep-warm', '-c', 'user.email=judge-keep-warm@users.noreply.github.com', 'commit', '-q', '-m', 'judge: start the thread manifest'])
    await git($, dir, ['push', '-q', 'origin', `HEAD:${branch}`], 120_000)
    return branch
  }
  await git($, dir, ['fetch', '-q', '--depth', '1', 'origin', branch], 120_000)
  await git($, dir, ['reset', '-q', '--hard', 'FETCH_HEAD'])
  branch = (await git($, dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || branch
  return branch
}

// Writes the files into the clone, removes the deleted ones, commits and pushes. False when the
// push was rejected because the branch moved: the caller syncs again and retries.
async function commitGit($: EngineInterface, dir: string, branch: string, files: RepoFile[], deletes: string[], message: string) {
  for (const f of files) await $.fs.write(`${dir}/${f.path}`, f.text)
  if (deletes.length > 0) await git($, dir, ['rm', '-q', '--ignore-unmatch', '--', ...deletes])
  await git($, dir, ['add', '-A'])
  await git($, dir, ['-c', 'user.name=judge-keep-warm', '-c', 'user.email=judge-keep-warm@users.noreply.github.com', 'commit', '-q', '-m', message])
  try {
    await git($, dir, ['push', '-q', 'origin', `HEAD:${branch}`], 120_000)
    return true
  } catch (err) {
    if (err instanceof Error && /rejected|fetch first|non-fast-forward|failed to push/.test(err.message)) return false
    throw err
  }
}

async function hostNames($: EngineInterface) {
  if (live.host) return
  let host = ((await $.env.get('HOSTNAME')) ?? (await $.env.get('COMPUTERNAME')) ?? '').trim()
  if (!host) {
    try {
      const r = await $.process.run(['hostname'], { timeoutMs: 5000 })
      if (r.exitCode === 0) host = r.stdout.trim()
    } catch {
      // No command here: the host stays unnamed.
    }
  }
  live.host = host.split('.')[0] || 'unknown-host'
  live.user = ((await $.env.get('USER')) ?? (await $.env.get('USERNAME')) ?? 'user').trim() || 'user'
}

function accountLabel() {
  return live.account || `${live.user}@${live.host}`
}

// Bundles the live threads into projects with one completion through the session's own
// connection (the judge model option, else the session's model). An answer that does not come
// or does not parse leaves the bundling to the repository rule.
async function classify($: EngineInterface, threads: readonly ThreadEntry[], previous: readonly ManifestProject[]): Promise<Assignment> {
  if (threads.length === 0) return []
  const { system, prompt } = bundlePrompt(threads, previous)
  const model = live.judgeModel || (await $.session.model())
  const r = await $.model.complete({ model, system, prompt, maxTokens: 8192, effort: 'low', timeoutMs: 120_000 })
  if (!r.isAnswered) {
    $.ui.log(`judge: bundling by repository, the model gave no answer (${r.reason})`, { to: 'debug' })
    return []
  }
  const assigned = parseAssignment(r.text)
  if (!assigned) $.ui.log('judge: bundling by repository, the model\'s answer did not parse', { to: 'debug' })
  return assigned ?? []
}

// ---- The manifest transaction -----------------------------------------------------------------

// What the repository holds at its head (every thread entry with its path, the manifest's
// projects, every project's sub-manifest), and how to commit over that head.
type Snapshot = {
  entries: { path: string; entry: ThreadEntry }[]
  previous: ManifestProject[]
  archives: { path: string; archive: ProjectArchive }[]
  hasPath: (path: string) => Promise<boolean>
  write: (files: RepoFile[], deletes: string[], message: string) => Promise<boolean>
}

// Through GitHub's REST git data: one tree read, the blobs from the store when seen before.
async function snapshotApi($: EngineInterface): Promise<Snapshot> {
  let head = await repoHead($)
  if (!head) {
    await bootstrapRepo($)
    head = await repoHead($)
    if (!head) throw new Error(`${live.repo} stays empty after its first commit`)
  }
  const tree = await readTree($, head.tree)
  const keep = new Set<string>()
  const entries: Snapshot['entries'] = []
  const archives: Snapshot['archives'] = []
  let previous: ManifestProject[] = []
  for (const e of tree) {
    if (e.path.startsWith(`${THREADS_DIR}/`) && e.path.endsWith('.json')) {
      keep.add(e.sha)
      const entry = parseEntry(await readBlob($, e.sha))
      if (entry) entries.push({ path: e.path, entry })
    } else if (e.path.startsWith(`${ARCHIVE_DIR}/`) && e.path.endsWith('.json')) {
      keep.add(e.sha)
      const archive = parseArchive(await readBlob($, e.sha))
      if (archive) archives.push({ path: e.path, archive })
    } else if (e.path === MANIFEST_FILE) {
      keep.add(e.sha)
      previous = parseManifest(await readBlob($, e.sha))?.projects ?? []
    }
  }
  await pruneBlobs($, keep)
  const paths = new Set(tree.map(e => e.path))
  const at = head
  return { entries, previous, archives, hasPath: async path => paths.has(path), write: (files, deletes, message) => commitFiles($, at, files, deletes, message) }
}

// Through the clone, once the host refused a REST write.
async function snapshotGit($: EngineInterface): Promise<Snapshot> {
  const dir = await gitDir($)
  const branch = await gitSync($, dir)
  const entries: Snapshot['entries'] = []
  const archives: Snapshot['archives'] = []
  if (await $.fs.exists(`${dir}/${THREADS_DIR}`)) {
    for (const account of await $.fs.list(`${dir}/${THREADS_DIR}`)) {
      if (account.kind !== 'dir') continue
      for (const file of await $.fs.list(`${dir}/${THREADS_DIR}/${account.name}`)) {
        if (file.kind !== 'file' || !file.name.endsWith('.json')) continue
        const path = `${THREADS_DIR}/${account.name}/${file.name}`
        const entry = parseEntry(await $.fs.read(`${dir}/${path}`))
        if (entry) entries.push({ path, entry })
      }
    }
  }
  if (await $.fs.exists(`${dir}/${ARCHIVE_DIR}`)) {
    for (const file of await $.fs.list(`${dir}/${ARCHIVE_DIR}`)) {
      if (file.kind !== 'file' || !file.name.endsWith('.json')) continue
      const path = `${ARCHIVE_DIR}/${file.name}`
      const archive = parseArchive(await $.fs.read(`${dir}/${path}`))
      if (archive) archives.push({ path, archive })
    }
  }
  const manifestPath = `${dir}/${MANIFEST_FILE}`
  const previous = (await $.fs.exists(manifestPath)) ? (parseManifest(await $.fs.read(manifestPath))?.projects ?? []) : []
  return {
    entries,
    previous,
    archives,
    hasPath: path => $.fs.exists(`${dir}/${path}`),
    write: (files, deletes, message) => commitGit($, dir, branch, files, deletes, message),
  }
}

/** What one commit to the manifest repository is asked to do; `by` names who asked. */
type Change = {
  /** This session's own entry, filed. */
  entry?: ThreadEntry
  /** Each group: fold `drop` into `keep`, all of one project. */
  merges?: { keep: string; drop: string[] }[]
  /** Take these threads out by hand. */
  remove?: string[]
  by: string
}

/** What it came to. `kind`: this thread's entry `created` or `updated`; `archived` when a merge or
 * deletion took this thread out (it is not filed again); `committed` for a commit with no entry of
 * this thread's; `unchanged` when there was nothing to write. */
type Outcome = {
  kind: 'created' | 'updated' | 'archived' | 'committed' | 'unchanged'
  path: string
  manifest: Manifest
  threads: number
  projects: number
  /** Every thread this commit took out, the deletion hook's among them. */
  archived: ArchivedThread[]
  /** The threads the deletion hook took out: their session or their entry file was gone. */
  cleared: ArchivedThread[]
  self: ArchivedThread | null
}

function commitMessage(self: ThreadEntry | undefined, keepTitles: readonly string[], archived: readonly ArchivedThread[], threads: number, projects: number) {
  const parts: string[] = []
  if (self) parts.push(`${self.status === 'closed' ? 'close' : 'file'} ${self.title.slice(0, 60)} (${self.account})`)
  const merged = archived.filter(a => a.reason === 'merged')
  const byHand = archived.filter(a => a.reason === 'deleted' && a.by !== TRANSCRIPT_GONE && a.by !== ENTRY_GONE)
  const cleared = archived.length - merged.length - byHand.length
  if (merged.length) parts.push(`merge ${plural(merged.length, 'thread')} into ${keepTitles.length === 1 ? keepTitles[0]!.slice(0, 60) : plural(keepTitles.length, 'thread')}`)
  if (byHand.length > 3) parts.push(`delete ${plural(byHand.length, 'thread')}`)
  else if (byHand.length) parts.push(`delete ${byHand.map(a => a.title.slice(0, 40)).join(', ')}`)
  if (cleared) parts.push(`archive ${plural(cleared, 'deleted thread')}`)
  return `judge: ${parts.join('; ') || 'tidy'}; ${threads} threads in ${projects} projects`
}

// The one way the repository changes: reads every thread entry, the manifest and the projects'
// sub-manifests; files this thread's entry, merges or deletes what was asked, and takes out every
// thread that was deleted (its session's transcript gone from this machine, or its entry file
// gone from the repository), each kept as one line in its project's sub-manifest; bundles what
// is left into the manifest; and commits it all at once. A thread a sub-manifest holds is never
// listed again. Retried over a head another machine moved meanwhile, and once more over the git
// fallback when the host's proxy refuses REST writes.
async function transact($: EngineInterface, change: Change): Promise<Outcome> {
  const now = await $.clock.now()
  const at = change.entry?.filedAt ?? new Date(now).toISOString()
  await hostNames($)
  const local = await localSessionIds($)
  for (let attempt = 0; attempt < 3; attempt++) {
    const snap = live.backend === 'git' ? await snapshotGit($) : await snapshotApi($)
    const archives = snap.archives.map(a => a.archive)
    const archivePaths = new Map(snap.archives.map(a => [a.archive, a.path]))
    const dead = tombstones(archives)
    const latest = new Map<string, ThreadEntry>()
    for (const { entry } of snap.entries) {
      const have = latest.get(entry.sessionId)
      if (!have || entry.filedAt > have.filedAt) latest.set(entry.sessionId, entry)
    }
    const self = change.entry
    const selfRecord = self ? (archives.flatMap(a => a.threads).find(t => t.sessionId === self.sessionId) ?? null) : null
    const isFiling = self !== undefined && selfRecord === null
    if (isFiling) latest.set(self.sessionId, self)

    const records: { record: ArchivedThread; entry?: ThreadEntry }[] = []
    const isListed = (id: string) => latest.has(id) && !dead.has(id)
    const take = (t: ThreadEntry | ManifestThread, reason: ArchivedThread['reason'], by: string, into?: string) => {
      if (dead.has(t.sessionId) || records.some(r => r.record.sessionId === t.sessionId)) return false
      records.push({ record: archivedFrom(t, reason, by, at, into), entry: latest.get(t.sessionId) })
      return true
    }
    for (const { keep, drop } of change.merges ?? []) {
      if (!isListed(keep)) throw new Error(`the thread to keep (${keep.slice(0, 8)}) is not in the manifest any more`)
      const home = projectOf(snap.previous, keep)?.slug
      for (const id of drop) {
        if (id === keep) continue
        const entry = latest.get(id)
        if (!entry || !isListed(id)) throw new Error(`thread ${id.slice(0, 8)} is not in the manifest any more`)
        if (projectOf(snap.previous, id)?.slug !== home) throw new Error('threads merge only within one project, and these are in different ones')
        take(entry, 'merged', change.by, keep)
      }
    }
    for (const id of change.remove ?? []) {
      const entry = latest.get(id)
      if (!entry || !isListed(id)) throw new Error(`thread ${id.slice(0, 8)} is not in the manifest any more`)
      take(entry, 'deleted', change.by)
    }
    // The deletion hook. A thread this machine filed whose session's transcript is gone was
    // deleted in Claude Code; a thread the manifest lists whose entry file is gone was deleted in
    // the repository. Either leaves a line in its project's sub-manifest.
    const cleared: ArchivedThread[] = []
    if (local) {
      for (const [id, entry] of latest) {
        if (id === self?.sessionId || local.has(id) || entry.account !== accountLabel() || entry.host !== live.host) continue
        if (take(entry, 'deleted', TRANSCRIPT_GONE)) cleared.push(records[records.length - 1]!.record)
      }
    }
    for (const t of snap.previous.flatMap(p => p.threads)) {
      if (latest.has(t.sessionId) || t.status === 'closed') continue
      if (take(t, 'deleted', ENTRY_GONE)) cleared.push(records[records.length - 1]!.record)
    }

    const out = new Set([...dead, ...records.map(r => r.record.sessionId)])
    const kept = keptEntries([...latest.values()].filter(t => !out.has(t.sessionId)), now)
    const deletes = [...new Set(snap.entries.filter(e => out.has(e.entry.sessionId)).map(e => e.path))]
    const listedCount = snap.previous.reduce((n, p) => n + p.threads.length, 0)
    if (!isFiling && records.length === 0 && deletes.length === 0) {
      const manifest: Manifest = { schema: 1, generatedAt: at, projects: snap.previous }
      return { kind: selfRecord ? 'archived' : 'unchanged', path: '', manifest, threads: listedCount, projects: snap.previous.length, archived: [], cleared: [], self: selfRecord }
    }
    // A filing bundles anew through the model; a merge or a deletion keeps every other thread in
    // the project it was in.
    const assigned = isFiling ? await classify($, unplacedThreads(kept.filter(t => statusOf(t, now) !== 'closed')), snap.previous) : previousAssignment(snap.previous)
    const projects = bundle(kept, assigned, snap.previous, now)
    const changed = addToArchives(archives, records, snap.previous, projects)
    const orphans = attachArchives(projects, archives)
    const manifest: Manifest = { schema: 1, generatedAt: at, projects }
    const files: RepoFile[] = []
    let path = ''
    let isNew = false
    if (isFiling) {
      path = threadPath(self.account, self.sessionId)
      isNew = !(await snap.hasPath(path))
      files.push({ path, text: entryJson(self) })
    }
    for (const a of changed) files.push({ path: archivePaths.get(a) ?? archivePath(a.slug), text: archiveJson(a) })
    files.push({ path: MANIFEST_FILE, text: manifestJson(manifest) }, { path: MANIFEST_MD, text: renderMarkdown(manifest, orphans) })
    const archived = records.map(r => r.record)
    const keepTitles = (change.merges ?? []).filter(m => records.some(r => r.record.into === m.keep)).map(m => latest.get(m.keep)?.title ?? '')
    const message = commitMessage(isFiling ? self : undefined, keepTitles, archived, kept.length, projects.length)
    let isDone: boolean
    try {
      isDone = await snap.write(files, deletes, message)
    } catch (err) {
      if (live.backend === 'api' && isWriteRefused(err)) {
        live.backend = 'git'
        $.ui.log(`judge: GitHub's REST writes are refused here; using git from now on (${err instanceof Error ? err.message : String(err)})`, { to: 'debug' })
        continue
      }
      throw err
    }
    if (isDone) {
      await rememberManifest($, manifest)
      await noteUpdate($)
      const kind = isFiling ? (isNew ? 'created' : 'updated') : selfRecord ? 'archived' : 'committed'
      return { kind, path, manifest, threads: kept.length, projects: projects.length, archived, cleared, self: selfRecord }
    }
  }
  throw new Error('the manifest branch kept moving under the commit; try again')
}

// The manifest as last read or written: for the pane, the line's counter, the related threads,
// and whether this thread was taken out of it.
async function rememberManifest($: EngineInterface, manifest: Manifest) {
  const sessionId = await $.session.id()
  const repo = await $.session.repo()
  await $.state.set(MANIFEST, manifest)
  await $.state.set(MANIFEST_READ_AT, await $.clock.now())
  await $.state.set(MANIFEST_ERROR, '')
  await $.state.set(RELATED, relatedThreads(manifest, sessionId, repo?.remote ?? null, await $.session.cwd()))
  await $.state.set(MANIFEST_THREADS, manifest.projects.reduce((n, p) => n + p.threads.length, 0))
  await $.state.set(MANIFEST_PROJECTS, manifest.projects.length)
  const self = manifest.projects.flatMap(p => p.archived ?? []).find(a => a.sessionId === sessionId)
  if (self) await $.state.set(SELF_ARCHIVED, self)
}

// The session ids whose transcripts this machine keeps (`<config>/projects/<dir>/<id>.jsonl`), so
// the deletion hook can tell which of its threads' sessions are gone. Null where that cannot be
// told safely: the option is off, a cloud container (whose transcripts never persist), or this
// session's own transcript is not among them (another layout, another config directory).
async function localSessionIds($: EngineInterface): Promise<Set<string> | null> {
  if (!live.sweepDeleted || (await $.env.get('CLAUDE_CODE_REMOTE')) === 'true') return null
  try {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
    const config = ((await $.env.get('CLAUDE_CONFIG_DIR')) ?? '').trim() || (home ? `${home}/.claude` : '')
    const root = `${config}/projects`
    if (!config || !(await $.fs.exists(root))) return null
    const ids = new Set<string>()
    for (const dir of await $.fs.list(root)) {
      if (dir.kind !== 'dir') continue
      for (const file of await $.fs.list(`${root}/${dir.name}`)) {
        if (file.kind === 'file' && file.name.endsWith('.jsonl')) ids.add(file.name.slice(0, -'.jsonl'.length))
      }
    }
    return ids.has(await $.session.id()) ? ids : null
  } catch {
    return null
  }
}

// At session start, with the manifest read: when a thread it lists was deleted (its session on
// this machine, or its entry file in the repository), one commit takes it out.
async function sweepDeleted($: EngineInterface, entryIds: ReadonlySet<string> | null) {
  if (!isJudging() || live.isFiling) return
  const { value: manifest = null } = await $.state.get(MANIFEST)
  if (!manifest) return
  await hostNames($)
  const local = await localSessionIds($)
  const threads = manifest.projects.flatMap(p => p.threads).filter(t => t.status !== 'closed')
  const isGone = (t: ManifestThread) =>
    (entryIds !== null && !entryIds.has(t.sessionId)) || (local !== null && t.account === accountLabel() && t.host === live.host && !local.has(t.sessionId))
  if (!threads.some(isGone)) return
  live.isFiling = true
  try {
    const done = await transact($, { by: accountLabel() })
    const n = done.cleared.length
    if (n > 0) $.ui.toast(`Judge: ${plural(n, 'deleted thread')} taken out of the manifest; ${n === 1 ? 'its' : 'their'} one-line summary is in ${n === 1 ? 'its' : 'their'} project's sub-manifest.`)
  } catch (err) {
    $.ui.log(`judge: taking deleted threads out of the manifest failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  } finally {
    live.isFiling = false
  }
}

// A merge or a deletion asked for by hand (the pane or /judge), one at a time with the filings.
async function changeThreads($: EngineInterface, change: Omit<Change, 'by' | 'entry'>): Promise<{ ok: true; done: Outcome } | { ok: false; error: string }> {
  if (live.isFiling) return { ok: false, error: 'a filing is under way; try again in a moment' }
  live.isFiling = true
  try {
    await hostNames($)
    return { ok: true, done: await transact($, { ...change, by: accountLabel() }) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    live.isFiling = false
  }
}

// What a merge or a deletion did, in one markdown paragraph and a list.
function changeReply(done: Outcome, project: string) {
  const merged = done.archived.filter(a => a.reason === 'merged')
  const deleted = done.archived.filter(a => a.reason === 'deleted')
  const keep = merged[0]?.into ? done.manifest.projects.flatMap(p => p.threads).find(t => t.sessionId === merged[0]!.into) : undefined
  const lines: string[] = []
  if (merged.length) lines.push(`**Merged ${plural(merged.length, 'thread')}** into **${mdText(keep?.title ?? merged[0]!.into ?? '')}** in *${mdText(project)}*.`)
  if (deleted.length) lines.push(`**Deleted ${plural(deleted.length, 'thread')}** from *${mdText(project)}*.`)
  lines.push('', ...done.archived.map(a => `- ~~${mdText(a.title)}~~: ${mdText(a.brief)}`), '')
  lines.push(`${done.archived.length === 1 ? 'Its' : 'Their'} one-line summary is kept in the project's sub-manifest under ${mdCode(`${ARCHIVE_DIR}/`)}.`)
  return lines.join('\n')
}

function selfArchivedText(self: ArchivedThread, manifest: Manifest | null) {
  if (self.reason === 'merged') {
    const into = manifest?.projects.flatMap(p => p.threads).find(t => t.sessionId === self.into)
    return `merged into “${into?.title ?? self.into?.slice(0, 8) ?? '?'}” on ${self.archivedAt.slice(0, 10)}; it is no longer filed`
  }
  return `taken out of the manifest on ${self.archivedAt.slice(0, 10)}; it is no longer filed`
}

// The pane's picks on one project: a press picks a thread or lets it go; the first picked is kept.
function togglePick(current: PaneEdit | undefined, slug: string, sessionId: string): PaneEdit {
  const picked = current && current.slug === slug ? current.picked : []
  return { slug, picked: picked.includes(sessionId) ? picked.filter(id => id !== sessionId) : [...picked, sessionId] }
}

function clipTitle(title: string) {
  const one = title.replace(/\s+/g, ' ').trim()
  return one.length > BUTTON_TITLE_MAX ? `${one.slice(0, BUTTON_TITLE_MAX - 1)}…` : one || 'Untitled'
}

// Opens the Judgeiverse pane at the person's ask (a command or a press), and reads the manifest
// again when what the pane would list is more than a few minutes old. Says whether it is placed.
async function showPane($: EngineInterface) {
  const isPlaced = await openPane($)
  const { value: readAt = 0 } = await $.state.get(MANIFEST_READ_AT)
  if ((await $.clock.now()) - readAt > PANE_FRESH_MS) void refreshPane($)
  return isPlaced
}

async function refreshPane($: EngineInterface) {
  const { value: isBusy = false } = await $.state.get(IS_BUSY)
  if (isBusy) return
  await $.state.set(IS_BUSY, true)
  try {
    await loadRelated($, true)
    const { value: error = '' } = await $.state.get(MANIFEST_ERROR)
    await $.state.set(PANE_NOTICE, error ? `Reading the manifest failed: ${error}` : '')
  } finally {
    await $.state.set(IS_BUSY, false)
  }
}

// The pane's Merge or Delete on the picked threads of the project it edits.
async function paneAction($: EngineInterface, action: 'merge' | 'delete') {
  const { value: edit = null } = await $.state.get(PANE_EDIT)
  const { value: isBusy = false } = await $.state.get(IS_BUSY)
  if (!edit || edit.picked.length === 0 || isBusy) return
  if (action === 'merge' && edit.picked.length < 2) return
  await $.state.set(IS_BUSY, true)
  await $.state.set(PANE_NOTICE, action === 'merge' ? 'Merging…' : 'Deleting…')
  try {
    const [keep = '', ...drop] = edit.picked
    const r = await changeThreads($, action === 'merge' ? { merges: [{ keep, drop }] } : { remove: edit.picked })
    if (!r.ok) {
      await $.state.set(PANE_NOTICE, `${action === 'merge' ? 'Merge' : 'Delete'} failed: ${r.error}`)
      return
    }
    const n = r.done.archived.filter(a => a.reason === (action === 'merge' ? 'merged' : 'deleted')).length
    const keepTitle = r.done.manifest.projects.flatMap(p => p.threads).find(t => t.sessionId === keep)?.title ?? ''
    await $.state.set(
      PANE_NOTICE,
      action === 'merge'
        ? `Merged ${plural(n, 'thread')} into “${clipTitle(keepTitle)}”; the one-line summaries are in the project's sub-manifest.`
        : `Deleted ${plural(n, 'thread')}; the one-line summaries are in the project's sub-manifest.`,
    )
    await $.state.set(PANE_EDIT, null)
  } finally {
    await $.state.set(IS_BUSY, false)
  }
}

// ---- Tidying ----------------------------------------------------------------------------------

// The manifest read afresh, with what a tidy needs of it: every thread by short name, and the
// threads it must leave listed (this session's, and any active in the last few hours).
async function tidyContext($: EngineInterface) {
  await loadRelated($, true)
  const { value: manifest = null } = await $.state.get(MANIFEST)
  const { value: error = '' } = await $.state.get(MANIFEST_ERROR)
  if (!manifest) return { ok: false as const, error: error || 'the manifest could not be read' }
  const now = await $.clock.now()
  const refs = tidyRefs(manifest.projects)
  return { ok: true as const, manifest, now, refs, guard: protectedIds(manifest.projects, await $.session.id(), now) }
}

// Asks the judge model which threads to merge and which to archive, the rules' finds given as
// hints; with no answer the rules' finds stand alone. Held to the guards either way.
async function reviewRaw($: EngineInterface, refs: readonly TidyRef[], guard: ReadonlySet<string>, now: number): Promise<{ raw: RawTidy; by: TidyPlan['by'] }> {
  const rules = tidyRules(refs, now)
  if (refs.length === 0) return { raw: rules, by: 'model' }
  const { system, prompt } = tidyPrompt(refs, rules, guard, now)
  const model = live.judgeModel || (await $.session.model())
  const r = await $.model.complete({ model, system, prompt, maxTokens: 8192, effort: 'medium', timeoutMs: 180_000 })
  const parsed = r.isAnswered ? parseTidy(r.text) : null
  if (parsed) return { raw: parsed, by: 'model' }
  $.ui.log(`judge: the tidy review falls back to the rules: ${r.isAnswered ? "the model's answer did not parse" : `the model gave no answer (${r.reason})`}`, { to: 'debug' })
  return { raw: rules, by: 'rules' }
}

// A tidy review of every listed thread: kept in the state for the pane and /judge tidy apply.
async function reviewThreads($: EngineInterface): Promise<{ ok: true; plan: TidyPlan } | { ok: false; error: string }> {
  const ctx = await tidyContext($)
  if (!ctx.ok) return ctx
  const { raw, by } = await reviewRaw($, ctx.refs, ctx.guard, ctx.now)
  const plan: TidyPlan = { at: ctx.now, by, reviewed: ctx.refs.length, proposals: guardTidy(raw, ctx.refs, ctx.guard).proposals }
  await $.state.set(TIDY_PLAN, plan)
  await $.state.set(TIDY_OFF, [])
  return { ok: true, plan }
}

// Applies tidy steps in one commit. A step whose threads changed since the review (merged or
// archived elsewhere, bundled into another project) is left out rather than failing the rest.
async function applyTidy($: EngineInterface, proposals: readonly TidyProposal[]): Promise<{ ok: true; done: Outcome; text: string } | { ok: false; error: string }> {
  await loadRelated($, true)
  const { value: manifest = null } = await $.state.get(MANIFEST)
  if (!manifest) return { ok: false, error: 'the manifest could not be read' }
  const { merges, remove, dropped } = stillValid(proposals, manifest.projects)
  if (merges.length === 0 && remove.length === 0) return { ok: false, error: 'none of these steps holds any more: their threads changed since the review' }
  const r = await changeThreads($, { merges, remove })
  if (!r.ok) return r
  const merged = r.done.archived.filter(a => a.reason === 'merged').length
  const archived = r.done.archived.filter(a => a.reason === 'deleted' && remove.includes(a.sessionId)).length
  return { ok: true, done: r.done, text: tidyDone(merged, merges.length, archived, dropped) }
}

// A thread's title as the tidy shows it, from the manifest; its id's start when it is not listed.
function titleIn(manifest: Manifest | null) {
  const titles = new Map((manifest?.projects ?? []).flatMap(p => p.threads.map(t => [t.sessionId, t.title] as const)))
  return (id: string) => clipTitle(titles.get(id) ?? id.slice(0, 8))
}

async function paneTidy($: EngineInterface) {
  const { value: isBusy = false } = await $.state.get(IS_BUSY)
  if (isBusy) return
  await $.state.set(IS_BUSY, true)
  await $.state.set(PANE_NOTICE, 'Reviewing the threads…')
  try {
    const r = await reviewThreads($)
    await $.state.set(PANE_NOTICE, !r.ok ? `The review failed: ${r.error}` : r.plan.proposals.length ? '' : `Reviewed ${plural(r.plan.reviewed, 'thread')}: nothing to tidy.`)
  } finally {
    await $.state.set(IS_BUSY, false)
  }
}

async function paneApplyTidy($: EngineInterface) {
  const { value: plan = null } = await $.state.get(TIDY_PLAN)
  const { value: off = [] } = await $.state.get(TIDY_OFF)
  const { value: isBusy = false } = await $.state.get(IS_BUSY)
  const picked = plan ? pickedProposals(plan, off) : []
  if (picked.length === 0 || isBusy) return
  await $.state.set(IS_BUSY, true)
  await $.state.set(PANE_NOTICE, 'Tidying…')
  try {
    const r = await applyTidy($, picked)
    await $.state.set(PANE_NOTICE, r.ok ? r.text : `The tidy failed: ${r.error}`)
    if (r.ok) {
      await $.state.set(TIDY_PLAN, null)
      await $.state.set(TIDY_OFF, [])
    }
  } finally {
    await $.state.set(IS_BUSY, false)
  }
}

// list_threads: every listed thread for the model to judge, with the rules' finds and the guards.
async function listThreadsText($: EngineInterface, project: string) {
  const ctx = await tidyContext($)
  if (!ctx.ok) return `The manifest could not be read: ${ctx.error}`
  const want = project.trim().toLowerCase()
  const projects = ctx.manifest.projects.filter(p => !want || p.name.toLowerCase().includes(want) || p.slug.includes(want))
  const n = projects.reduce((k, p) => k + p.threads.length, 0)
  const selfId = await $.session.id()
  const lines = [
    `Judgeiverse manifest ${live.repo}: ${plural(n, 'thread')} in ${plural(projects.length, 'project')}${want ? ` matching "${project.trim()}"` : ''}. This session is ${selfId}.`,
    `Protected threads (this session, or active in the last ${RECENT_MS / 3_600_000} hours) are never merged away or archived; one can be the thread a merge keeps.`,
  ]
  for (const p of projects) {
    lines.push('', `## ${p.name} (${p.threads.length})${p.description ? `: ${p.description}` : ''}`)
    for (const t of p.threads) {
      const marks = [t.status, ago(t.lastActiveAt, ctx.now), `${t.account} on ${t.host}`]
      if (ctx.guard.has(t.sessionId)) marks.push('protected')
      if (t.merged?.length) marks.push(`${t.merged.length} merged in`)
      const summary = t.summary.replace(/\s+/g, ' ').trim()
      lines.push(`- ${t.sessionId} · ${t.title.replace(/\s+/g, ' ').trim() || 'Untitled'} · ${marks.join(' · ')}`, `  ${summary.length > TOOL_SUMMARY_MAX ? `${summary.slice(0, TOOL_SUMMARY_MAX - 1)}…` : summary}`)
    }
  }
  const shown = new Set(projects.flatMap(p => p.threads.map(t => t.sessionId)))
  const refs = ctx.refs.filter(r => shown.has(r.thread.sessionId))
  const hints = guardTidy(tidyRules(refs, ctx.now), refs, ctx.guard).proposals
  const titleOf = titleIn(ctx.manifest)
  if (hints.length) {
    lines.push('', 'What simple rules found (same titles, empty, done, idle over two weeks); check each against the summaries:')
    for (const h of hints) lines.push(`- ${proposalLabel(h, titleOf)}: ${h.kind === 'merge' ? `keep ${h.keep}, drop ${h.drop.join(', ')}` : h.drop[0]} (${h.reason})`)
  }
  lines.push('', `To clean up, show the person the steps you propose and, once they agree, call ${TIDY_TOOL} with them.`)
  return lines.join('\n')
}

// tidy_threads: the model's merges and archives, held to the same guards, in one commit.
async function tidyThreadsText($: EngineInterface, input: Record<string, unknown>) {
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(x => x.trim()) : [])
  const groups = (Array.isArray(input['merge']) ? input['merge'] : [])
    .filter((g): g is Record<string, unknown> => !!g && typeof g === 'object')
    .map(g => ({ keep: typeof g['keep'] === 'string' ? g['keep'].trim() : '', drop: strings(g['drop']) }))
  const archive = strings(input['archive'])
  if (groups.length === 0 && archive.length === 0) return 'Nothing changed: give `merge` groups ({ keep, drop }) or `archive` ids.'
  const ctx = await tidyContext($)
  if (!ctx.ok) return `Nothing changed: the manifest could not be read: ${ctx.error}`
  // Every id named, a full session id or one's first characters, resolved before anything is written.
  const named = [...groups.flatMap(g => [g.keep, ...g.drop]), ...archive]
  const { found, errors } = findThreads(ctx.manifest.projects, named)
  if (errors.length) return `Nothing changed: ${errors.join('; ')}.`
  const idOf = (name: string) => found.find(f => f.thread.sessionId === name || f.thread.sessionId.startsWith(name))?.thread.sessionId ?? name
  const refOf = new Map(ctx.refs.map(r => [r.thread.sessionId, r.ref]))
  const ref = (name: string) => refOf.get(idOf(name)) ?? name
  const raw: RawTidy = {
    merge: groups.filter(g => g.keep && g.drop.length).map(g => ({ keep: ref(g.keep), drop: g.drop.map(ref), reason: 'asked by the model' })),
    archive: archive.map(a => ({ id: ref(a), reason: 'asked by the model' })),
  }
  const { proposals, skipped } = guardTidy(raw, ctx.refs, ctx.guard)
  const byRef = new Map(ctx.refs.map(r => [r.ref, r.thread]))
  const left = skipped.map(s => `- ${byRef.get(s.ref)?.sessionId ?? s.ref} (${byRef.get(s.ref)?.title ?? 'unknown'}): ${s.why}`)
  if (proposals.length === 0) return ['Nothing changed: every step was turned down.', ...left].join('\n')
  const r = await applyTidy($, proposals)
  if (!r.ok) return `Nothing changed: ${r.error}`
  const titleOf = titleIn(ctx.manifest)
  const lines = [r.text, '', ...proposals.map(p => `- ${proposalLabel(p, titleOf)}${p.kind === 'merge' ? `: ${p.drop.map(titleOf).join(', ')}` : ''}`)]
  if (left.length) lines.push('', 'Left alone:', ...left)
  lines.push('', `The manifest now lists ${plural(r.done.threads, 'thread')} in ${plural(r.done.projects, 'project')}.`)
  return lines.join('\n')
}

// What build this is, for the pane and /judge: the manifest's version when it carries one, else
// the commit the install came from (the plugin's cache folder is named after it; plugin.json
// leaves `version` out on purpose, so every commit reaches installed machines without a bump).
async function readVersion($: EngineInterface) {
  let version = ''
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: string }
    if (typeof manifest.version === 'string') version = manifest.version
  } catch {
    // No readable manifest: go by the folder.
  }
  if (!version) {
    const leaf = $.plugin.root.split(/[\\/]/).filter(Boolean).pop() ?? ''
    version = buildOf(leaf, $.plugin.name)
  }
  live.version = version || 'dev'
}

// The release as the line shows it, short: `v0.6.0`.
function buildLabel() {
  return `v${RELEASE}`
}

// The release and the build it came from, for the pane and /judge: `v0.6.0 · 806d383`.
function buildDetail() {
  const build = live.version && live.version !== RELEASE ? live.version : ''
  return build ? `${buildLabel()} · ${build}` : buildLabel()
}

// The Threads button: the pane where a surface places one; else the list goes into the chat,
// as /judge threads prints it, so the press always shows the threads.
async function showThreads($: EngineInterface) {
  if (await showPane($)) return
  $.ui.toast('Judge: no pane can open here, so the threads are listed in the chat.')
  try {
    await $.command.run({ command: JUDGE_COMMAND, args: 'threads' })
  } catch (err) {
    $.ui.log(`judge: listing the threads in the chat failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
}

// Opens the pane that stands in for the band; says whether a surface placed it.
async function openPane($: EngineInterface) {
  try {
    const opened = await $.ui.open({ id: PANE, title: PANE_TITLE })
    live.paneOpen = opened.isPlaced
    return opened.isPlaced
  } catch {
    // A host with no panes at all: the line stays where it is.
    return false
  }
}

// Every commit this session makes to the manifest: the tally goes up, and the line lights with it.
async function noteUpdate($: EngineInterface) {
  const { value: updates = 0 } = await $.state.get(UPDATES)
  await $.state.set(UPDATES, updates + 1)
  await $.state.set(UPDATED_AT, await $.clock.now())
  await $.state.set(FLASH_FAILED, false)
  await flash($)
}

// Lights the line with the last update's or failure's outcome for FLASH_MS, then lets it go dim
// again. The timer clears the key (the write redraws the line); the tick clears one a reload left.
async function flash($: EngineInterface) {
  const until = (await $.clock.now()) + FLASH_MS
  await $.state.set(FLASH_UNTIL, until)
  $.clock.after(FLASH_MS, () => void endFlash($))
}

async function endFlash($: EngineInterface) {
  const { value: until = 0 } = await $.state.get(FLASH_UNTIL)
  if (until > 0 && (await $.clock.now()) >= until) await $.state.set(FLASH_UNTIL, 0)
}

/** What a filing needs of the thread, read at once before anything slow: a /clear may end the
 * conversation while the judge or the commit runs, and the entry is still the ended thread's. */
type ThreadSnapshot = {
  sessionId: string
  cwd: string
  repo: string | null
  messages: Parameters<typeof localVerdict>[0]
  title: string
  model: string
  turns: number
  surface: string
  startedAt: number
  contextTokens: number
  lastActiveAt: number
}

async function captureThread($: EngineInterface): Promise<ThreadSnapshot> {
  const cwd = await $.session.cwd()
  const messages = await $.session.messages()
  const usage = await $.session.usage()
  const { value: title = '' } = await $.state.get(TITLE)
  const { value: active = 0 } = await $.state.get(ACTIVE)
  return {
    sessionId: await $.session.id(),
    cwd,
    repo: (await $.session.repo())?.remote ?? null,
    messages,
    title: title || titleFrom(messages, cwd),
    model: await $.session.model(),
    turns: await $.session.turns(),
    surface: (await $.session.surfaces())[0] ?? 'none',
    startedAt: usage.startedAt,
    contextTokens: usage.context.tokens ?? 0,
    lastActiveAt: active,
  }
}

// Builds the thread's entry from the snapshot and the verdict, and publishes it with the
// manifest. `status` closed marks the thread done. Never throws: while the snapshot is still this
// session's thread, the outcome goes to the FILING state, which the line and /judge show; a thread
// a /clear ended meanwhile gets a toast alone.
async function fileThread($: EngineInterface, verdict: JudgeVerdict, by: ThreadEntry['filedBy'], status: ThreadEntry['status'], snap: ThreadSnapshot) {
  if (!isJudging() || live.isFiling) return
  live.isFiling = true
  await $.state.set(FILING_NOW, true)
  const t = await $.clock.now()
  let path = ''
  try {
    await hostNames($)
    const entry: ThreadEntry = {
      schema: 1,
      sessionId: snap.sessionId,
      account: accountLabel(),
      host: live.host,
      surface: snap.surface,
      title: snap.title,
      cwd: snap.cwd,
      repo: snap.repo,
      model: snap.model,
      contextTokens: snap.contextTokens,
      turns: snap.turns,
      startedAt: new Date(snap.startedAt).toISOString(),
      lastActiveAt: new Date(snap.lastActiveAt || t).toISOString(),
      // Kept for the readers of older builds; this build keeps no cache warm.
      cacheExpiresAt: '',
      keepWarm: false,
      status,
      filedAt: new Date(t).toISOString(),
      filedBy: by,
      summary: verdict.summary,
      topics: verdict.topics,
      project: verdict.project,
      nextStep: verdict.nextStep,
      resume: `claude --resume ${snap.sessionId}`,
    }
    path = threadPath(entry.account, snap.sessionId)
    const done = await transact($, { entry, by: accountLabel() })
    if (snap.sessionId !== (await $.session.id())) {
      if (done.kind !== 'archived') $.ui.toast(`Judge: the thread before the clear was ${done.kind} in ${live.repo}.`)
      return
    }
    if (done.kind === 'archived' && done.self) {
      // A merge or a deletion took this thread out: it is not filed again.
      const { value: wasArchived = null } = await $.state.get(SELF_ARCHIVED)
      await $.state.set(SELF_ARCHIVED, done.self)
      if (!wasArchived) $.ui.toast(`Judge: this thread was ${selfArchivedText(done.self, done.manifest)}.`)
      return
    }
    const { value: was = null } = await $.state.get(FILING)
    await $.state.set(FILING, { at: t, ok: true, path, error: '', by })
    await $.state.set(TITLE, snap.title)
    await $.state.set(MANIFEST_THREADS, done.threads)
    await $.state.set(MANIFEST_PROJECTS, done.projects)
    const cleared = done.cleared.length ? ` ${plural(done.cleared.length, 'deleted thread')} taken out.` : ''
    // Filed after every pause: a toast for the first filing, a recovery, a new entry or deleted
    // threads taken out; the line lights for every one.
    if (!was || !was.ok || done.kind === 'created' || cleared) $.ui.toast(`Judge: thread ${done.kind} in ${live.repo}; ${done.threads} threads in ${done.projects} projects.${cleared}`)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    if (snap.sessionId !== (await $.session.id())) {
      $.ui.toast(`Judge: filing the thread before the clear failed: ${error}`, { timeoutMs: 8000 })
      return
    }
    const { value: was = null } = await $.state.get(FILING)
    await $.state.set(FILING, { at: t, ok: false, path, error, by })
    await $.state.set(FLASH_FAILED, true)
    await flash($)
    if (!was || was.ok || was.error !== error) $.ui.toast(`Judge: filing the thread failed: ${error}`, { timeoutMs: 8000 })
  } finally {
    live.isFiling = false
    await $.state.set(FILING_NOW, false)
  }
}

// Judges the thread with a fork of the conversation and files the verdict; the local summary
// when the fork cannot run. The fork reads the conversation from cache: right after a turn, where
// the idle filing runs it, that is a cache read; on a cold cache it writes the cache afresh.
async function judgeAndFile($: EngineInterface, status: ThreadEntry['status']) {
  await rememberTitle($)
  const snap = await captureThread($)
  // A thread merged or deleted away is not filed again: no fork for it.
  const { value: self = null } = await $.state.get(SELF_ARCHIVED)
  const r = self ? null : await $.model.fork({ prompt: JUDGE_PROMPT })
  const judged = r?.isAnswered ? parseVerdict(r.text) : null
  if (judged) {
    if (snap.sessionId === (await $.session.id())) await $.state.set(VERDICT, judged)
    await fileThread($, judged, 'judge', status === 'open' && judged.isDone ? 'closed' : status, snap)
    return judged
  }
  const verdict = localVerdict(snap.messages)
  await fileThread($, verdict, status === 'closed' ? 'end' : 'local', status, snap)
  return verdict
}

// Reads manifest.json and keeps it (the pane draws it), and the open threads that share this
// session's repository or directory, so the line and the start-of-session notice can point at
// them. Also answers which threads have an entry file, for the deletion hook.
async function loadRelated($: EngineInterface, isQuiet: boolean): Promise<{ related: ManifestThread[]; entryIds: Set<string> | null }> {
  const none = { related: [], entryIds: null }
  if (!isJudging()) return none
  try {
    const head = await repoHead($)
    if (!head) return none
    const tree = await readTree($, head.tree)
    const found = tree.find(e => e.path === MANIFEST_FILE)
    const manifest = found ? parseManifest(await readBlob($, found.sha)) : null
    if (!manifest) return none
    await rememberManifest($, manifest)
    const { value: related = [] } = await $.state.get(RELATED)
    if (related.length > 0 && !isQuiet) {
      const named = related.slice(0, RELATED_SHOWN).map(describeThread).join('; ')
      const tidy = related.length >= TIDY_NUDGE ? ' /judge tidy proposes which to merge or archive.' : ''
      $.ui.toast(`Judge: ${related.length} open thread${related.length === 1 ? '' : 's'} already cover this project: ${named}. /judge panel shows them.${tidy}`, { timeoutMs: 12_000 })
    }
    const files = tree.filter(e => e.path.startsWith(`${THREADS_DIR}/`) && e.path.endsWith('.json')).map(e => e.path.slice(e.path.lastIndexOf('/') + 1, -'.json'.length))
    const segments = new Set(files)
    const entryIds = new Set(manifest.projects.flatMap(p => p.threads).filter(t => segments.has(pathSegment(t.sessionId))).map(t => t.sessionId))
    return { related, entryIds }
  } catch (err) {
    // No manifest yet, no token, or no network: nothing to point at.
    await $.state.set(MANIFEST_ERROR, err instanceof Error ? err.message : String(err))
    return none
  }
}

// ---- Filing when the conversation pauses -------------------------------------------------------

// Each tick: the clock the line shows, once a minute; a thread a /clear ended, filed as captured;
// and the filing a real turn made due, once the conversation has paused past its time with no turn
// running. The due time is cleared before the filing runs, so a failed filing waits for the next
// turn, not the next tick.
async function tick($: EngineInterface) {
  const t = await $.clock.now()
  await endFlash($)
  const minute = Math.floor(t / 60_000)
  if (minute !== live.shownMinute) {
    live.shownMinute = minute
    await $.state.set(NOW, t)
  }
  if (live.endedThread && !live.isFiling) {
    const { snap, verdict } = live.endedThread
    live.endedThread = null
    await fileThread($, verdict, 'end', 'open', snap)
  }
  const { value: due = 0 } = await $.state.get(FILE_DUE)
  if (due === 0 || t < due || live.isTurnRunning || live.isFiling) return
  await $.state.set(FILE_DUE, 0)
  const { value: self = null } = await $.state.get(SELF_ARCHIVED)
  if (!isJudging() || !live.fileThreads || self) return
  await judgeAndFile($, 'open')
}

// The details that fit beside the fixed parts in `columns`, in order, so nothing runs under the
// button: a surface's own clipping is not relied on. Each detail costs its text and a separator.
function fitParts(parts: readonly string[], columns: number, fixed: number) {
  let room = columns - fixed - FIT_MARGIN
  const kept: string[] = []
  for (const p of parts) {
    const cost = p.length + DETAIL_GAP * 2 + 1
    if (cost > room) {
      // The first detail (the title) is cut to the room rather than dropped, when there is any.
      const shorter = room - DETAIL_GAP * 2 - 1
      if (kept.length === 0 && shorter >= TITLE_MIN) kept.push(`${p.slice(0, shorter - 1)}…`)
      break
    }
    room -= cost
    kept.push(p)
  }
  return kept
}

// Everything the band and the pane show, worked out once from the state: the same line on
// either surface.
async function lineModel($: EngineInterface) {
  const { value: due = 0 } = await $.state.get(FILE_DUE)
  const { value: filingNow = false } = await $.state.get(FILING_NOW)
  const { value: filing = null } = await $.state.get(FILING)
  const { value: related = [] } = await $.state.get(RELATED)
  const { value: manifestThreads = 0 } = await $.state.get(MANIFEST_THREADS)
  const { value: manifestProjects = 0 } = await $.state.get(MANIFEST_PROJECTS)
  const { value: updates = 0 } = await $.state.get(UPDATES)
  const { value: updatedAt = 0 } = await $.state.get(UPDATED_AT)
  const { value: flashFailed = false } = await $.state.get(FLASH_FAILED)
  const { value: flashUntil = 0 } = await $.state.get(FLASH_UNTIL)
  const { value: selfArchived = null } = await $.state.get(SELF_ARCHIVED)
  const { value: manifest = null } = await $.state.get(MANIFEST)
  // Lit for FLASH_MS after a commit to the manifest (green) or a failed filing (red), in place
  // of where the thread stands.
  const isFlash = isJudging() && flashUntil > 0 && (await $.clock.now()) < flashUntil && (flashFailed ? filing !== null : updatedAt > 0)
  const flashColor = flashFailed ? 'red' : 'green'
  const flashText = flashFailed ? '✗ filing failed' : `✓ manifest updated ${clockTime(updatedAt)}`

  // Where this thread stands in the manifest: green once filed (by this process, or by an earlier
  // one, so a relaunched session reads as safe to clear), red when the last filing failed.
  const isListed = manifest?.projects.some(p => p.threads.some(t => t.sessionId === live.sessionId)) ?? false
  let main = live.fileThreads ? 'not filed yet' : 'files on /judge file'
  let tone: 'plain' | 'ok' | 'failed' = 'plain'
  if (!isJudging()) {
    main = 'no manifest repository set'
  } else if (selfArchived) {
    main = selfArchived.reason === 'merged' ? 'merged into another thread' : 'taken out of the manifest'
  } else if (filingNow) {
    main = 'filing…'
  } else if (due > 0) {
    main = `files at ${clockTime(due)}`
  } else if (filing && !filing.ok) {
    main = 'filing failed'
    tone = 'failed'
  } else if (filing) {
    main = `filed ${clockTime(filing.at)}`
    tone = 'ok'
  } else if (isListed) {
    main = 'in the manifest'
    tone = 'ok'
  }

  // How many other open threads the manifest holds for this project, and what it holds in all.
  const parts: string[] = []
  if (isJudging()) {
    if (related.length > 0) parts.push(`${related.length} related thread${related.length === 1 ? '' : 's'}`)
    parts.push(...counter(manifestThreads, manifestProjects, 0))
  }

  const { value: fullTitle = '' } = await $.state.get(TITLE)
  const title = fullTitle.length > TITLE_SHOWN ? `${fullTitle.slice(0, TITLE_SHOWN - 1)}…` : fullTitle
  // The tally of this session's updates to the manifest: a fixed part of the line, not a detail.
  const tally = isJudging() && updates > 0 ? plural(updates, 'update') : ''
  const canFile = isJudging() && !selfArchived
  return { isFlash, flashColor, flashText, main, tone, parts, title, fullTitle, tally, canFile }
}

// Declares the model's two tools. A host that takes no plugin tools keeps the rest of the mod.
async function registerTools($: EngineInterface) {
  try {
    await $.tool.register({
      name: LIST_TOOL,
      description:
        "List the threads in the person's Judgeiverse manifest: every Claude Code conversation they filed, by project, with session id, title, status, age, account and summary, plus what simple rules flag as duplicates, finished or idle. Read-only. Use it when the person wants to see, review, merge or clean up their open threads; judge from the summaries which ones continue the same work or are done, then propose steps with tidy_threads.",
      inputSchema: {
        type: 'object',
        properties: { project: { type: 'string', description: "Only projects whose name contains this text. Empty: every project." } },
      },
    })
    await $.tool.register({
      name: TIDY_TOOL,
      description:
        "Clean up the person's Judgeiverse manifest in one commit: merge threads that continue the same work (each group folds `drop` into `keep`, all in one project) and archive threads that are finished, abandoned or empty. A thread leaving the list keeps one line in its project's sub-manifest. This session's thread and any thread active in the last 6 hours are never merged away or archived. Name threads by session id or its first 8 characters, as list_threads gives them. Show the person the steps and get their go-ahead before calling it.",
      inputSchema: {
        type: 'object',
        properties: {
          merge: {
            type: 'array',
            description: 'Merge groups.',
            items: {
              type: 'object',
              properties: {
                keep: { type: 'string', description: 'The thread kept: usually the most recent or the most complete.' },
                drop: { type: 'array', items: { type: 'string' }, description: 'The threads folded into it.' },
              },
              required: ['keep', 'drop'],
            },
          },
          archive: { type: 'array', items: { type: 'string' }, description: 'Threads to take off the list.' },
        },
      },
    })
  } catch (err) {
    $.ui.log(`judge: the thread tools could not be registered: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
}

export const register: Register = (on, options) => {
  live.repo = parseRepo(String(options[REPO_OPTION] ?? ''))
  live.account = String(options[ACCOUNT_OPTION] ?? '').trim()
  live.tokenOption = String(options[TOKEN_OPTION] ?? '')
  live.fileThreads = options[FILE_THREADS_OPTION] !== false
  live.judgeModel = String(options[JUDGE_MODEL_OPTION] ?? '').trim()
  live.sweepDeleted = options[SWEEP_OPTION] !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: JUDGE_COMMAND,
      description: 'The thread manifest: status, file or close this thread, list the open threads of this project, open the pane, merge, delete or tidy threads',
      argumentHint: '[status | file | close | threads | pane | tidy [apply [n…]] | merge <keep> <other>… | delete <id>…]',
      immediate: true,
    })

    live.sessionId = await $.session.id()
    await readVersion($)
    if (isJudging()) await registerTools($)
    for (const key of await $.store.keys()) {
      if (OLD_STORE_KEY.test(key)) await $.store.delete(key)
    }

    await tick($)
    $.clock.every(TICK_MS, () => void tick($))
    void syncTitle($)
    $.clock.every(TITLE_SYNC_MS, () => void syncTitle($))
    // The related threads come from the network: never hold the start on them. Once read, any
    // thread deleted since (its session here, or its entry in the repository) is taken out.
    void loadRelated($, false).then(r => sweepDeleted($, r.entryIds))
    // Where nothing has drawn the band by now, the pane shows the line instead.
    $.clock.after(PANE_DECIDE_MS, () => {
      if (!live.bandSeen && !live.paneOpen) void openPane($)
    })

    return next(e)
  })

  // A /clear, or another session resumed in this process, starts a new thread; a relaunch of the
  // same session keeps it, and dates its last activity from the gap the engine reports.
  on('classic.SessionStart', async ($, e, next) => {
    const id = await $.session.id()
    if (e.source === 'clear' || (live.sessionId !== '' && id !== live.sessionId)) await startOver($)
    live.sessionId = id
    if ((e.source === 'resume' || e.source === 'fork') && typeof e.seconds_since_last_response === 'number') {
      const lastAt = (await $.clock.now()) - e.seconds_since_last_response * 1000
      const { value: active = 0 } = await $.state.get(ACTIVE)
      if (lastAt > active) await $.state.set(ACTIVE, lastAt)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) live.isTurnRunning = true
    return next(e)
  })

  // A real turn makes the thread due to be filed once the conversation pauses; a turn that ends
  // with nothing from the model (an interrupt, an API error) moves a filing already due past it.
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      live.isTurnRunning = false
      const t = await $.clock.now()
      if (e.usage) {
        await $.state.set(ACTIVE, t)
        await rememberTitle($)
      }
      const { value: due = 0 } = await $.state.get(FILE_DUE)
      if (isJudging() && live.fileThreads && (e.usage || due > 0)) await $.state.set(FILE_DUE, t + FILE_AFTER_IDLE_MS)
    }
    return next(e)
  })

  // A /clear, or another session resumed here, ends the thread before its filing was due. The hook
  // has a second and a half and no fork can follow a /clear, so it captures the thread with what
  // its transcript says, and the next tick, a few seconds on, commits it.
  on('session.end', async ($, e, next) => {
    const { value: due = 0 } = await $.state.get(FILE_DUE)
    if (due > 0 && (e.reason === 'clear' || e.reason === 'resume') && isJudging() && live.fileThreads) {
      await $.state.set(FILE_DUE, 0)
      const snap = { ...(await captureThread($)), sessionId: e.sessionId }
      // The judge's project and topics from the last filing still hold; the summary is the transcript's.
      const { value: judged = null } = await $.state.get(VERDICT)
      live.endedThread = { snap, verdict: { ...localVerdict(snap.messages), topics: judged?.topics ?? [], project: judged?.project ?? '' } }
    }
    return next(e)
  })
  on('command.run', { command: JUDGE_COMMAND }, async ($, e) => {
    const [first = 'status', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    const word = first.toLowerCase()
    if (!isJudging()) {
      return { text: `**Judge:** no manifest repository is set. Set **Manifest repository** to \`owner/repo\` in \`/config\` (plugin ${PLUGIN_NAME}); an empty private repository is enough.` }
    }
    if (word === 'pane' || word === 'panel') {
      const isPlaced = await showPane($)
      return { text: isPlaced ? '**Judge:** the Judgeiverse pane is open: the line, then the threads.' : '**Judge:** no surface here places a pane; the line is drawn above the prompt where one exists, and `/judge threads` lists the threads.' }
    }
    if (word === 'file' || word === 'close') {
      const verdict = await judgeAndFile($, word === 'close' ? 'closed' : 'open')
      const { value: filing = null } = await $.state.get(FILING)
      const { value: self = null } = await $.state.get(SELF_ARCHIVED)
      const { value: manifest = null } = await $.state.get(MANIFEST)
      const head = self
        ? `**Not filed:** this thread was ${mdText(selfArchivedText(self, manifest))}.`
        : filing?.ok
          ? `**Thread ${word === 'close' ? 'closed' : 'filed'}** at ${mdCode(filing.path)} in ${mdCode(live.repo)}; manifest bundled.`
          : `**Filing failed:** ${mdText(filing?.error ?? 'unknown')}`
      const lines = [head, '', summaryQuote(verdict.summary)]
      const facts: string[] = []
      if (verdict.project) facts.push(`- **Project:** ${mdText(verdict.project)}`)
      if (verdict.topics.length) facts.push(`- **Topics:** ${verdict.topics.map(mdText).join(', ')}`)
      if (verdict.nextStep) facts.push(`- **Next:** ${mdText(verdict.nextStep)}`)
      if (facts.length) lines.push('', ...facts)
      return { text: lines.join('\n') }
    }
    if (word === 'threads') {
      const { related } = await loadRelated($, true)
      return { text: threadsReply(related, await $.clock.now()) }
    }
    if (word === 'tidy') {
      if (rest[0]?.toLowerCase() === 'apply') {
        const { value: plan = null } = await $.state.get(TIDY_PLAN)
        const { value: off = [] } = await $.state.get(TIDY_OFF)
        if (!plan || plan.proposals.length === 0) return { text: '**Tidy:** no review to apply. `/judge tidy` makes one.' }
        const numbers = rest.slice(1).map(n => Number.parseInt(n, 10))
        if (numbers.some(n => !Number.isInteger(n) || n < 1 || n > plan.proposals.length)) {
          return { text: `**Tidy:** name steps by their numbers, 1 to ${plan.proposals.length}.` }
        }
        const steps = numbers.length ? plan.proposals.filter((_, i) => numbers.includes(i + 1)) : pickedProposals(plan, off)
        if (steps.length === 0) return { text: '**Tidy:** every step is unticked; nothing to apply.' }
        const r = await applyTidy($, steps)
        if (!r.ok) return { text: `**Tidy:** nothing changed: ${mdText(r.error)}` }
        await $.state.set(TIDY_PLAN, null)
        await $.state.set(TIDY_OFF, [])
        return { text: `**${mdText(r.text)}**\n\nThe manifest now lists ${plural(r.done.threads, 'thread')} in ${plural(r.done.projects, 'project')}.` }
      }
      const r = await reviewThreads($)
      if (!r.ok) return { text: `**Tidy:** the review failed: ${mdText(r.error)}` }
      const { value: manifest = null } = await $.state.get(MANIFEST)
      return { text: tidyReply(r.plan, titleIn(manifest)) }
    }
    if (word === 'merge' || word === 'delete') {
      const usage = word === 'merge'
        ? '**Judge:** `/judge merge <keep> <other>…` folds the other threads into the first, all of one project. Name each by its session id or its first eight characters; `/judge pane` lets you pick them instead.'
        : '**Judge:** `/judge delete <id>…` takes threads out of the manifest and keeps one line on each in its project\'s sub-manifest. Name each by its session id or its first eight characters.'
      if (rest.length < (word === 'merge' ? 2 : 1)) return { text: usage }
      await loadRelated($, true)
      const { value: manifest = null } = await $.state.get(MANIFEST)
      const { value: error = '' } = await $.state.get(MANIFEST_ERROR)
      if (!manifest) return { text: `**Judge:** the manifest could not be read${error ? `: ${mdText(error)}` : ''}.` }
      const { found, errors } = findThreads(manifest.projects, rest)
      if (errors.length) return { text: `**Judge:** ${errors.join('; ')}.` }
      const projectNames = [...new Set(found.map(f => f.project.name))]
      if (word === 'merge' && projectNames.length > 1) {
        return { text: `**Judge:** threads merge only within one project, and these are in ${projectNames.map(n => `*${mdText(n)}*`).join(' and ')}.` }
      }
      if (word === 'merge' && found.length < 2) return { text: usage }
      const ids = found.map(f => f.thread.sessionId)
      const [keep = '', ...drop] = ids
      const r = await changeThreads($, word === 'merge' ? { merges: [{ keep, drop }] } : { remove: ids })
      if (!r.ok) return { text: `**Judge:** the ${word} failed: ${mdText(r.error)}` }
      return { text: changeReply(r.done, projectNames.join(', ')) }
    }
    const { value: verdict = null } = await $.state.get(VERDICT)
    const { value: filing = null } = await $.state.get(FILING)
    const { value: related = [] } = await $.state.get(RELATED)
    const { value: self = null } = await $.state.get(SELF_ARCHIVED)
    const { value: manifest = null } = await $.state.get(MANIFEST)
    const { value: manifestThreads = 0 } = await $.state.get(MANIFEST_THREADS)
    const { value: manifestProjects = 0 } = await $.state.get(MANIFEST_PROJECTS)
    const { value: updates = 0 } = await $.state.get(UPDATES)
    const { value: updatedAt = 0 } = await $.state.get(UPDATED_AT)
    const lines = [
      `**Judge** ${mdText(buildDetail())} · manifest ${mdCode(live.repo)} · account ${mdCode(accountLabel())}`,
      '',
      `- **Filing:** ${live.fileThreads ? `${minutes(FILE_AFTER_IDLE_MS)} minutes after each turn, once the conversation pauses` : 'only on `/judge file`'}`,
      `- **Last filed:** ${filing ? (filing.ok ? `${clockTime(filing.at)}, ${FILED_BY[filing.by]}, at ${mdCode(filing.path)}` : `${clockTime(filing.at)}, failed: ${mdText(filing.error)}`) : 'not yet this session'}`,
    ]
    if (self) lines.push(`- **This thread:** ${mdText(selfArchivedText(self, manifest))}`)
    if (verdict) lines.push(`- **Verdict:** ${mdText(verdict.summary)}${verdict.project ? ` *(project: ${mdText(verdict.project)})*` : ''}`)
    lines.push(`- **Manifest:** ${counter(manifestThreads, manifestProjects, updates).join(' · ') || 'not read yet'}${updatedAt ? `; last updated ${clockTime(updatedAt)}` : ''}`)
    if (related.length) lines.push(`- **This project:** ${plural(related.length, 'other open thread')}; \`/judge threads\` lists them`)
    lines.push('', '`/judge file` · `/judge close` · `/judge threads` · `/judge pane` · `/judge tidy` · `/judge merge <keep> <other>…` · `/judge delete <id>…`')
    return { text: lines.join('\n') }
  })

  // The model's tools: list_threads reads the manifest for it to judge; tidy_threads applies the
  // merges and archives it settled on with the person, under the same guards as the pane's tidy.
  on('tool.call', { tool: LIST_TOOL_ID }, async ($, e) => {
    if (!isJudging()) return { result: 'No manifest repository is set, so there are no threads to list.' }
    // The tool's arguments ride on the event beside `tool`.
    const project = (e as Record<string, unknown>)['project']
    return { result: await listThreadsText($, typeof project === 'string' ? project : '') }
  }).catch(($, e, next) => ({ result: 'Listing the threads failed; nothing changed.' }))

  on('tool.call', { tool: TIDY_TOOL_ID }, async ($, e) => {
    if (!isJudging()) return { result: 'Nothing changed: no manifest repository is set.' }
    return { result: await tidyThreadsText($, e as Record<string, unknown>) }
  }).catch(($, e, next) => ({ result: 'The tidy failed before it committed anything, or its outcome is unknown; list_threads shows the manifest as it stands.' }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    live.bandSeen = true

    const { Box, Button, Text } = $.ui.resolve(e)
    const m = await lineModel($)
    // The title leads the details; the rest follows as far as the width allows.
    const details = [...(m.title ? [m.title] : []), ...m.parts]
    const build = buildLabel()
    const fixed =
      LABEL.length + DETAIL_GAP + build.length + DETAIL_GAP + (m.isFlash ? m.flashText : m.main).length +
      (m.tally ? DETAIL_GAP + m.tally.length : 0) + (m.canFile ? BUTTON_COLUMNS : 0) + (isJudging() ? THREADS_BUTTON_COLUMNS : 0)
    const shown = fitParts(details, e.props.bodyColumns, fixed)

    return (
      <Box alignItems="center" flexWrap="nowrap">
        <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden" flexWrap="nowrap" alignItems="center" columnGap={DETAIL_GAP}>
          <Box flexShrink={0} width={LABEL.length}>
            {m.isFlash ? <Text color={m.flashColor} bold>{LABEL}</Text> : <Text color={LABEL_COLOR}>{LABEL}</Text>}
          </Box>
          <Box flexShrink={0}>
            <Text dimColor>{build}</Text>
          </Box>
          <Box flexShrink={0}>
            {m.isFlash ? (
              <Text color={m.flashColor} bold>{m.flashText}</Text>
            ) : m.tone === 'plain' ? (
              <Text bold>{m.main}</Text>
            ) : (
              <Text color={m.tone === 'ok' ? 'green' : 'red'} bold>{m.main}</Text>
            )}
          </Box>
          {m.tally !== '' && (
            <Box flexShrink={0}>
              <Text dimColor>{m.tally}</Text>
            </Box>
          )}
          {shown.flatMap(p => [
            <Box flexShrink={0}><Text dimColor>·</Text></Box>,
            <Box flexShrink={0}>{m.title !== '' && p === shown[0] && details[0] === m.title ? <Text>{p}</Text> : <Text dimColor>{p}</Text>}</Box>,
          ])}
        </Box>
        {isJudging() && (
          <Box flexShrink={0}>
            <Button key="threads" label="Threads" onPress={() => showThreads($)} />
          </Box>
        )}
        {m.canFile && (
          <Box flexShrink={0}>
            <Button key="file" label="File now" onPress={() => void judgeAndFile($, 'open')} />
          </Box>
        )}
      </Box>
    )
  })

  // The Judgeiverse pane, where no band is drawn (a cloud session's chat) or when asked for: a
  // status card with the line in rows, then the threads, project by project, each thread one
  // compact row that opens to its summary and resume command.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Code, Markdown, Text } = $.ui.resolve(e)
    const m = await lineModel($)
    const flashKey = m.flashColor === 'red' ? 'error' : 'success'

    const card = (
      <Box flexDirection="column" rowGap="xs" paddingX="sm" paddingY="xs" borderStyle="round" borderColor={m.isFlash ? flashKey : 'subtle'}>
        <Box justifyContent="space-between" alignItems="center" columnGap="sm">
          <Text color={m.isFlash ? flashKey : LABEL_COLOR} weight="semibold">{LABEL}</Text>
          <Text size="caption" dimColor>{buildLabel()}</Text>
        </Box>
        {m.fullTitle !== '' && (
          <Text size="heading" weight="semibold" wrap="truncate-end">{m.fullTitle}</Text>
        )}
        {m.isFlash ? (
          <Text color={flashKey} weight="semibold">{m.flashText}</Text>
        ) : (
          <Text weight="medium" tabular color={m.tone === 'ok' ? 'success' : m.tone === 'failed' ? 'error' : undefined}>{m.main}</Text>
        )}
        {m.tally !== '' && <Text size="footnote" dimColor>{m.tally}</Text>}
        {m.canFile && (
          <Box columnGap="sm" flexWrap="wrap">
            <Button key="file" label="File now" onPress={() => void judgeAndFile($, 'open')} />
          </Box>
        )}
      </Box>
    )
    const threads = isJudging() ? await threadsSection() : null

    return (
      <Box flexDirection="column" rowGap="md">
        {card}
        {threads}
        <Text size="caption" dimColor>{`${PLUGIN_NAME} ${buildDetail()}`}</Text>
      </Box>
    )

    // This project's threads, or every project's: a header with the view and Refresh, then a
    // section per project, its threads one row each, its archived ones folded away.
    async function threadsSection() {
      const { value: manifest = null } = await $.state.get(MANIFEST)
      const { value: readAt = 0 } = await $.state.get(MANIFEST_READ_AT)
      const { value: error = '' } = await $.state.get(MANIFEST_ERROR)
      const { value: view = 'project' } = await $.state.get(PANE_VIEW)
      const { value: edit = null } = await $.state.get(PANE_EDIT)
      const { value: notice = '' } = await $.state.get(PANE_NOTICE)
      const { value: isBusy = false } = await $.state.get(IS_BUSY)
      const { value: related = [] } = await $.state.get(RELATED)
      const { value: selfArchived = null } = await $.state.get(SELF_ARCHIVED)
      const { value: openThread = null } = await $.state.get(PANE_OPEN_THREAD)
      const { value: openArchive = null } = await $.state.get(PANE_OPEN_ARCHIVE)
      const { value: tidyPlan = null } = await $.state.get(TIDY_PLAN)
      const { value: tidyOff = [] } = await $.state.get(TIDY_OFF)
      const { value: shownAt = 0 } = await $.state.get(NOW)
      const now = shownAt || (await $.clock.now())
      const selfId = await $.session.id()

      const all = manifest?.projects ?? []
      const near = new Set([selfId, ...related.map(t => t.sessionId)])
      const mine = all.filter(p => p.threads.some(t => near.has(t.sessionId)))
      const shown = view === 'all' ? all : mine
      const openOf = (p: ManifestProject) => p.threads.filter(t => t.status !== 'closed')
      const openIn = (ps: readonly ManifestProject[]) => ps.reduce((n, p) => n + openOf(p).length, 0)
      const head = manifest
        ? `${plural(openIn(all), 'open thread')} in ${plural(all.length, 'project')} · read ${clockTime(readAt)}`
        : error
          ? `The manifest could not be read: ${error}`
          : 'Reading the manifest…'

      // One thread: its title and age, then who and where it stands; a press opens its summary,
      // the threads merged into it, where it ran, and the command that resumes it.
      const row = (t: ManifestThread) => {
        const isOpen = openThread === t.sessionId
        const isSelf = t.sessionId === selfId
        const label = `${isOpen ? '▾' : '▸'} ${clipTitle(t.title)}`
        return (
          <Box flexDirection="column">
            <Box justifyContent="space-between" alignItems="center" columnGap="sm">
              <Box flexShrink={1} minWidth={0}>
                <Button key={`open:${t.sessionId}`} plain onPress={() => $.state.set(PANE_OPEN_THREAD, isOpen ? null : t.sessionId)}>
                  {isSelf ? [label, <Text color="suggestion">{'  this thread'}</Text>] : label}
                </Button>
              </Box>
              <Text size="caption" dimColor tabular color={t.status === 'stale' ? 'warning' : undefined}>
                {t.status === 'stale' ? `stale · ${shortAgo(t.lastActiveAt, now)}` : shortAgo(t.lastActiveAt, now)}
              </Text>
            </Box>
            <Box paddingLeft="md">
              <Text size="footnote" dimColor wrap="truncate-end">{`${t.account} · ${threadSubtitle(t)}`}</Text>
            </Box>
            {isOpen && (
              <Box flexDirection="column" rowGap="xs" paddingLeft="md" paddingY="xs">
                <Markdown text={summaryQuote(t.summary)} />
                {(t.merged?.length ?? 0) > 0 && (
                  <Text size="footnote" dimColor>{`Merged in: ${(t.merged ?? []).map(x => x.title).join(', ')}`}</Text>
                )}
                <Text size="caption" dimColor>{`${t.account} on ${t.host} · last active ${ago(t.lastActiveAt, now)}`}</Text>
                <Code source={t.resume} language="bash" />
              </Box>
            )}
          </Box>
        )
      }

      // A project's edit mode: picks in order (the first kept on a merge), then the actions.
      const editor = (p: ManifestProject, open: readonly ManifestThread[]) => {
        const picked = edit?.slug === p.slug ? edit.picked : []
        const keep = open.find(t => t.sessionId === picked[0])
        return (
          <Box flexDirection="column" rowGap="xs" paddingLeft="sm">
            <Text size="caption" dimColor>Pick threads. A merge keeps the first one you pick and folds the rest into it.</Text>
            {open.map(t => (
              <Button key={`pick:${t.sessionId}`} plain onPress={() => update($, PANE_EDIT, current => togglePick(current ?? undefined, p.slug, t.sessionId))}>
                {`${pickMark(picked.indexOf(t.sessionId))} ${clipTitle(t.title)}`}
                <Text dimColor>{`  ${t.account} · ${shortAgo(t.lastActiveAt, now)}`}</Text>
              </Button>
            ))}
            <Box columnGap="sm" flexWrap="wrap" paddingTop="xs">
              {picked.length >= 2 && keep && (
                <Button key={`merge:${p.slug}`} variant="primary" label={`Merge ${picked.length - 1} into “${clipTitle(keep.title)}”`} onPress={() => paneAction($, 'merge')} />
              )}
              {picked.length >= 1 && <Button key={`delete:${p.slug}`} label={`Delete ${picked.length}`} onPress={() => paneAction($, 'delete')} />}
              <Button key={`cancel:${p.slug}`} plain label="Cancel" onPress={() => $.state.set(PANE_EDIT, null)} />
            </Box>
          </Box>
        )
      }

      // The tidy review: each step one row the person ticks or unticks, then Apply and Dismiss.
      const tidyCard = (plan: TidyPlan) => {
        const titleOf = titleIn(manifest)
        const picked = pickedProposals(plan, tidyOff).length
        return (
          <Box flexDirection="column" rowGap="xs" paddingX="sm" paddingY="xs" borderStyle="round" borderColor="subtle">
            <Box justifyContent="space-between" alignItems="center" columnGap="sm">
              <Text weight="semibold">Tidy up</Text>
              <Text size="caption" dimColor>{`${plural(plan.proposals.length, 'step')} · ${plural(plan.reviewed, 'thread')} reviewed`}</Text>
            </Box>
            {plan.by === 'rules' && plan.proposals.length > 0 && (
              <Text size="caption" color="warning">The model gave no answer, so these are the rules' finds alone: same titles, empty, done, idle.</Text>
            )}
            {plan.proposals.length === 0 && <Text size="footnote" dimColor>Nothing to tidy: no thread looks like a duplicate, finished or abandoned.</Text>}
            {plan.proposals.map(step => {
              const isOn = !tidyOff.includes(step.id)
              return (
                <Box flexDirection="column">
                  <Button key={`tidy-pick:${step.id}`} plain onPress={() => update($, TIDY_OFF, off => ((off ?? []).includes(step.id) ? (off ?? []).filter(id => id !== step.id) : [...(off ?? []), step.id]))}>
                    {`${isOn ? '☑' : '☐'} ${proposalLabel(step, titleOf)}`}
                  </Button>
                  <Box flexDirection="column" paddingLeft="md">
                    {step.kind === 'merge' && step.drop.map(id => <Text size="footnote" dimColor strikethrough wrap="truncate-end">{titleOf(id)}</Text>)}
                    <Text size="caption" dimColor>{`${step.project} · ${step.reason}`}</Text>
                  </Box>
                </Box>
              )
            })}
            <Box columnGap="sm" flexWrap="wrap" paddingTop="xs">
              {picked > 0 && <Button key="tidy-apply" variant="primary" label={isBusy ? 'Working…' : `Apply ${picked}`} onPress={() => paneApplyTidy($)} />}
              <Button key="tidy-dismiss" plain label="Dismiss" onPress={() => $.state.set(TIDY_PLAN, null)} />
            </Box>
          </Box>
        )
      }

      const section = (p: ManifestProject) => {
        const open = openOf(p)
        const isEditing = edit?.slug === p.slug
        const archived = p.archived ?? []
        const isArchiveOpen = openArchive === p.slug
        return (
          <Box flexDirection="column" rowGap="xs">
            <Box justifyContent="space-between" alignItems="center" columnGap="sm">
              <Box columnGap="sm" alignItems="center" flexShrink={1} minWidth={0}>
                <Text weight="semibold" wrap="truncate-end">{p.name}</Text>
                <Text size="caption" dimColor>{String(open.length)}</Text>
              </Box>
              {!isEditing && open.length > 0 && (
                <Button key={`edit:${p.slug}`} plain label="Merge / delete" onPress={() => $.state.set(PANE_EDIT, { slug: p.slug, picked: [] })} />
              )}
            </Box>
            {p.description !== '' && <Text size="caption" dimColor wrap="truncate-end">{p.description}</Text>}
            {isEditing ? editor(p, open) : open.length > 0 ? open.map(row) : <Text size="footnote" dimColor>No open thread.</Text>}
            {archived.length > 0 && (
              <Button key={`archived:${p.slug}`} plain label={`${isArchiveOpen ? '▾' : '▸'} ${archived.length} archived`} onPress={() => $.state.set(PANE_OPEN_ARCHIVE, isArchiveOpen ? null : p.slug)} />
            )}
            {isArchiveOpen &&
              archived.map(a => (
                <Box flexDirection="column" paddingLeft="md">
                  <Text size="footnote" dimColor strikethrough wrap="truncate-end">{a.title}</Text>
                  <Text size="caption" dimColor wrap="truncate-end">
                    {`${a.reason === 'merged' ? `merged into ${p.threads.find(t => t.sessionId === a.into)?.title ?? a.into?.slice(0, 8) ?? '?'}` : deletedHow(a.by)} · ${a.archivedAt.slice(0, 10)} · ${a.brief}`}
                  </Text>
                </Box>
              ))}
          </Box>
        )
      }

      return (
        <Box flexDirection="column" rowGap="sm">
          <Box justifyContent="space-between" alignItems="center" columnGap="sm">
            <Text size="heading" weight="semibold">Threads</Text>
            <Box columnGap="sm" alignItems="center">
              {manifest && <Button key="tidy" plain label="Tidy up" onPress={() => paneTidy($)} />}
              <Button key="refresh" plain label={isBusy ? 'Working…' : '↻ Refresh'} onPress={() => refreshPane($)} />
            </Box>
          </Box>
          <Text size="caption" dimColor color={error && !manifest ? 'warning' : undefined}>{head}</Text>
          <Box columnGap="sm" flexWrap="wrap">
            <Button key="view-project" variant={view === 'project' ? 'primary' : 'secondary'} label={`This project · ${openIn(mine)}`} onPress={() => $.state.set(PANE_VIEW, 'project')} />
            <Button key="view-all" variant={view === 'all' ? 'primary' : 'secondary'} label={`All · ${openIn(all)}`} onPress={() => $.state.set(PANE_VIEW, 'all')} />
          </Box>
          {notice !== '' && <Text size="footnote" dimColor>{notice}</Text>}
          {tidyPlan && tidyCard(tidyPlan)}
          {selfArchived && <Text size="footnote" color="warning">{`This thread was ${selfArchivedText(selfArchived, manifest)}.`}</Text>}
          {manifest && shown.length === 0 && (
            <Text size="footnote" dimColor>
              {view === 'project' ? 'No thread in the manifest covers this repository or directory yet. All lists every project.' : 'The manifest lists no project yet.'}
            </Text>
          )}
          {shown.map(section)}
        </Box>
      )
    }
  })
}

