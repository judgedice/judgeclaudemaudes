// Judge Keep Warm: Cache Keep-Warm (AndreiC81, MIT) with a judge layer. The keep-warm engine is
// the upstream's: a countdown line, pings 5 minutes before the cache would expire, never on a
// cold cache. The judge layer is new: when the cache is about to expire, the thread is filed into
// a GitHub manifest (threads/<account>/<session>.json); with keep-warm on, the ping itself is the
// judge, its reply the thread's summary; the mod bundles every thread into projects, and at session
// start it says which open threads already cover this project. A pane lists them beside the chat;
// threads merge within a project, and a deleted thread leaves the manifest for its project's
// sub-manifest (projects/<slug>.json) as one line.
import { update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, SessionUsage } from 'claude-code'

import type {
  ArchivedThread,
  JudgeVerdict,
  KeepWarmPing,
  KeepWarmSaved,
  KeepWarmTtl,
  Manifest,
  ManifestProject,
  ManifestThread,
  PaneEdit,
  ProjectArchive,
  ThreadEntry,
} from '../types'
import { ago, mdCode, mdText, plural, projectMarkdown, summaryQuote, threadsReply } from './format'
import type { Assignment } from './judge'
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

const HOUR_MS = 60 * 60_000
const FIVE_MIN_MS = 5 * 60_000
// The cache lengths Claude Code offers today; a value seen elsewhere is still accepted.
const KNOWN_TTLS_MS = [FIVE_MIN_MS, HOUR_MS]
// Keep-warm only for a cache this long or longer: on a short cache, pinging every few
// minutes costs more than the single re-write it saves after any real break.
const KEEP_WARM_MIN_TTL_MS = 30 * 60_000
// A ping goes out this long before the cache would expire (55 min into a 1-hour cache), and
// never in its last minute: a cold cache is never pinged.
const PING_LEAD_MS = 5 * 60_000
const PING_MARGIN_MS = 60_000
// After a failed ping, wait this long before trying again inside the window.
const PING_RETRY_MS = 30_000
// Without an explicit stop time, keep-warm stops itself after this many pings in a row.
const MAX_PINGS = 20
// One check every 15 s: local reads only (clock, session figures, settings), no model call.
const TICK_MS = 15_000
const PING_PENDING_MS = 5 * 60_000
// A request reading at least this share of the conversation from cache found it still warm.
const HIT_SHARE = 0.5
// A re-write after a shorter gap is a change to the prompt (compaction, a model switch),
// not an expiry, so it says nothing about the cache's length.
const EVIDENCE_GAP_MS = FIVE_MIN_MS + 30_000
// A reopened session reports how long ago its last answer came; count from a little before.
const RESUME_MARGIN_MS = 3 * 60_000
// With keep-warm off, the band names what is at stake once this little time is left.
const EXPIRING_MS = 10 * 60_000
const BAR_CELLS = 10
const BAR_FULL = '▰'
const BAR_EMPTY = '▱'
const DETAIL_GAP = 2
const CIRCLE_BY_QUARTER = ['◔', '◑', '◕', '⚫︎']
const CIRCLE_COLD = '○'
const TITLE_MARK = '🟢 '
const TITLE_MARK_OPTION = 'title_mark'
const TITLE_SYNC_MS = 5 * 60_000
const GET_SESSION_TOOL = 'mcp__ccd_session_mgmt__get_session'
const SET_TITLE_TOOL = 'mcp__ccd_session_mgmt__set_session_title'
const TITLE_FIELD = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/
const HISTORY_SHOWN = 5
const PING_TEXT = 'Keep-warm ping. Reply with just "ok".'
const COMMAND = 'keepwarm'
const JUDGE_COMMAND = 'judge'
const STORE_PREFIX = 'session:'
const STORE_MAX_AGE_MS = 7 * 24 * HOUR_MS
const PLAN_TTL_KEY = 'plan-ttl'
const PLAN_WINDOWS = ['five_hour', 'seven_day']
const PLAN_LIMIT_PERCENT = 100
const TTL_VALUE = /^(\d+)\s*(s|m|h)$/
const DURATION = /^(\d+(?:\.\d+)?)\s*(h|m|min)$/
const UNTIL = /^until\s+(\d{1,2}):(\d{2})$/
const WAITS_TEXT = 'keep-warm starts after your next message'
const VISIBLE_PING_TEXT = 'Keep-warm ping from the Judge Keep Warm mod. Reply with exactly "ok" and nothing else. Use no tools.'
const SHOWS_IN_CHAT = ' (shows in chat)'
const VISIBLE_PING_ROOM = 30_000
const VISIBLE_PING_MAX_FILL = 0.75
const NEARLY_FULL_TEXT = 'conversation nearly full: keep-warm waits for you'

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
// A thread already filed for this expiry is filed again only when the judge's verdict changed,
// or this much later: a thread kept warm all night is not re-judged (and the action not re-run)
// every 55 minutes for nothing.
const REFILE_MS = 6 * HOUR_MS
// How many related threads the start-of-session notice names.
const RELATED_SHOWN = 3
const PLUGIN_NAME = 'judge-keep-warm'
// The line's name, first on it, so it reads as this mod's at a glance.
const LABEL = 'Judgeiverse'
const LABEL_COLOR = 'cyan'
// Where no surface draws the band above the prompt (a cloud session's chat), the same content
// goes into a pane, opened this long after start unless the band has been asked for by then.
const PANE = 'judgeiverse'
const PANE_TITLE = 'Judgeiverse keep warm'
const PANE_DECIDE_MS = 6000
// The thread's title in the line is cut to this many characters.
const TITLE_SHOWN = 40
const TITLE_MIN = 12
// Room the toggle button and the gaps take, in columns, when fitting the details to the line;
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

const LAST = { plugin: 'judge-keep-warm', key: 'lastRequestAt' } as const
const KEEP_WARM = { plugin: 'judge-keep-warm', key: 'keepWarm' } as const
const STOP_AT = { plugin: 'judge-keep-warm', key: 'stopAt' } as const
const NOW = { plugin: 'judge-keep-warm', key: 'now' } as const
const PINGS = { plugin: 'judge-keep-warm', key: 'pings' } as const
const TTL = { plugin: 'judge-keep-warm', key: 'ttl' } as const
const CONTEXT = { plugin: 'judge-keep-warm', key: 'contextTokens' } as const
const WAITING = { plugin: 'judge-keep-warm', key: 'isWaiting' } as const
const SAW_RESPONSE = { plugin: 'judge-keep-warm', key: 'sawResponse' } as const
const SHORT_AFTER = { plugin: 'judge-keep-warm', key: 'shortAfterMs' } as const
const WAITS = { plugin: 'judge-keep-warm', key: 'waitsForMessage' } as const
const RESTORED = { plugin: 'judge-keep-warm', key: 'restored' } as const
const PING_ERROR = { plugin: 'judge-keep-warm', key: 'pingError' } as const
const NEARLY_FULL = { plugin: 'judge-keep-warm', key: 'nearlyFull' } as const
const VERDICT = { plugin: 'judge-keep-warm', key: 'verdict' } as const
const FILING = { plugin: 'judge-keep-warm', key: 'filing' } as const
const FILED_FOR = { plugin: 'judge-keep-warm', key: 'filedForExpiry' } as const
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

// The module's own variables start over on a reload; what must survive one is in $.state.
const live: {
  storeKey: string
  pingPendingUntil: number
  shownKey: string
  titleMark: boolean
  planTtl: KeepWarmTtl | undefined
  savedTtl: KeepWarmTtl | undefined
  isFirstRequest: boolean
  visiblePingAt: number
  pingTurnId: string
  roomChecked: boolean
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
  storeKey: '',
  pingPendingUntil: 0,
  shownKey: '',
  titleMark: true,
  planTtl: undefined,
  savedTtl: undefined,
  isFirstRequest: true,
  visiblePingAt: 0,
  pingTurnId: '',
  roomChecked: false,
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

function tokens(n: number) {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`
}

function timeLeft(ms: number) {
  return ms < 60_000 ? 'under a minute left' : `${minutes(ms)} min left`
}

// The counter's parts: what the manifest held when last read or written, and the tally of
// updates this session made to it. Empty before any of them is known.
function counter(threads: number, projects: number, updates: number) {
  const parts: string[] = []
  if (threads > 0 || projects > 0) parts.push(plural(threads, 'thread'), plural(projects, 'project'))
  if (updates > 0) parts.push(plural(updates, 'update'))
  return parts
}

function cacheLength(ms: number) {
  return ms >= HOUR_MS && ms % HOUR_MS === 0 ? `${ms / HOUR_MS}-hour` : `${minutes(ms)}-minute`
}

function parseTtl(value: unknown) {
  if (typeof value !== 'string') return 0
  const m = TTL_VALUE.exec(value.trim())
  if (!m) return 0
  return Number(m[1]) * (m[2] === 'h' ? HOUR_MS : m[2] === 'm' ? 60_000 : 1000)
}

async function rememberPlan($: EngineInterface, ttl: NonNullable<KeepWarmTtl>): Promise<KeepWarmTtl> {
  if (live.planTtl?.ms !== ttl.ms || live.planTtl?.reason !== ttl.reason) {
    live.planTtl = ttl
    await $.store.set(PLAN_TTL_KEY, ttl)
  }
  return ttl
}

// The same precedence Claude Code itself applies, then the plan: a subscription within its
// limits gets the hour, one over its limit (paying usage credits) and an API key get 5 minutes.
async function detectTtl($: EngineInterface, usage: SessionUsage): Promise<KeepWarmTtl> {
  if ((await $.env.get('FORCE_PROMPT_CACHING_5M')) === '1') return { ms: FIVE_MIN_MS, reason: 'setting' }
  const fromEnv = parseTtl(await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'))
  if (fromEnv) return { ms: fromEnv, reason: 'setting' }
  const settings = await $.settings.read()
  const fromSettings = parseTtl(settings['promptCacheTtl'])
  if (fromSettings) return { ms: fromSettings, reason: 'setting' }
  if ((await $.env.get('ENABLE_PROMPT_CACHING_1H')) === '1') return { ms: HOUR_MS, reason: 'setting' }

  const plan = usage.rateLimits.filter(w => PLAN_WINDOWS.includes(w.kind))
  if (plan.length === 0) {
    const { value: sawResponse = false } = await $.state.get(SAW_RESPONSE)
    if (!sawResponse) return live.savedTtl ?? live.planTtl ?? null
    return rememberPlan($, { ms: FIVE_MIN_MS, reason: 'api' })
  }
  return rememberPlan(
    $,
    plan.some(w => w.percentUsed >= PLAN_LIMIT_PERCENT) ? { ms: FIVE_MIN_MS, reason: 'overage' } : { ms: HOUR_MS, reason: 'subscription' },
  )
}

function correctTtl(base: KeepWarmTtl, shortAfterMs: number): KeepWarmTtl {
  if (!base || shortAfterMs <= 0 || shortAfterMs >= base.ms - PING_MARGIN_MS) return base
  const shorter = KNOWN_TTLS_MS.filter(ms => ms < shortAfterMs)
  return { ms: shorter.length ? Math.max(...shorter) : FIVE_MIN_MS, reason: 'observed' }
}

async function observe($: EngineInterface, gapMs: number, usage: ModelUsage) {
  const total = usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  if (total === 0 || gapMs < EVIDENCE_GAP_MS) return
  if (usage.cache_read_input_tokens >= HIT_SHARE * total) {
    await $.state.set(SHORT_AFTER, 0)
    return
  }
  const { value: ttl = null } = await $.state.get(TTL)
  const { value: shortAfter = 0 } = await $.state.get(SHORT_AFTER)
  const expected = ttl?.reason === 'observed' ? HOUR_MS : (ttl?.ms ?? HOUR_MS)
  if (gapMs < expected - PING_MARGIN_MS) await $.state.set(SHORT_AFTER, shortAfter > 0 ? Math.min(shortAfter, gapMs) : gapMs)
}

async function save($: EngineInterface) {
  if (!live.storeKey) return
  const { value: lastRequestAt = 0 } = await $.state.get(LAST)
  const { value: keepWarm = false } = await $.state.get(KEEP_WARM)
  const { value: stopAt = 0 } = await $.state.get(STOP_AT)
  const { value: ttl = null } = await $.state.get(TTL)
  const saved: KeepWarmSaved = { lastRequestAt, keepWarm, stopAt, ttl, savedAt: await $.clock.now() }
  await $.store.set(live.storeKey, saved)
}

async function setKeepWarm($: EngineInterface, isOn: boolean, stopAt: number) {
  await $.state.set(KEEP_WARM, isOn)
  await $.state.set(STOP_AT, isOn ? stopAt : 0)
  await $.state.set(PINGS, [])
  await $.state.set(PING_ERROR, '')
  await save($)
  await syncTitle($)
}

// The conversation starts over (cleared, or replaced by its summary): nothing of it is cached
// until the next request writes it.
async function startOver($: EngineInterface) {
  await $.state.set(LAST, 0)
  await $.state.set(PINGS, [])
  await $.state.set(SAW_RESPONSE, false)
  await $.state.set(CONTEXT, 0)
  await $.state.set(PING_ERROR, '')
  await $.state.set(FILED_FOR, 0)
  await $.state.set(NOW, await $.clock.now())
  live.roomChecked = false
  const { value: restored = false } = await $.state.get(RESTORED)
  if (restored) await save($)
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
    const { value: sawResponse = false } = await $.state.get(SAW_RESPONSE)
    title = sawResponse ? titleFrom(await $.session.messages(), await $.session.cwd()) : ''
  }
  const { value: was = '' } = await $.state.get(TITLE)
  if (title && title !== was) await $.state.set(TITLE, title)
}

async function syncTitle($: EngineInterface) {
  const { value: isOn = false } = await $.state.get(KEEP_WARM)
  const { value: ttl = null } = await $.state.get(TTL)
  const wantsMark = live.titleMark && isOn && !(ttl && ttl.ms < KEEP_WARM_MIN_TTL_MS)
  await rememberTitle($)
  try {
    const found = await $.tool.call({ tool: GET_SESSION_TOOL, session_id: 'self' })
    if ('deny' in found && found.deny) return
    const match = TITLE_FIELD.exec(found.text ?? '')
    if (!match) return
    const title: string = JSON.parse(`"${match[1]}"`)
    const hasMark = title.startsWith(TITLE_MARK)
    if (wantsMark === hasMark) return
    const base = hasMark ? title.slice(TITLE_MARK.length) : title
    await $.tool.call({ tool: SET_TITLE_TOOL, session_id: 'self', title: wantsMark ? TITLE_MARK + base : base })
  } catch {
    // No session tools here (a terminal session), or the app declined the rename: leave the title.
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
  /** Fold `drop` into `keep`, all of one project. */
  merge?: { keep: string; drop: string[] }
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

function commitMessage(self: ThreadEntry | undefined, keepTitle: string, archived: readonly ArchivedThread[], threads: number, projects: number) {
  const parts: string[] = []
  if (self) parts.push(`${self.status === 'closed' ? 'close' : 'file'} ${self.title.slice(0, 60)} (${self.account})`)
  const merged = archived.filter(a => a.reason === 'merged')
  const byHand = archived.filter(a => a.reason === 'deleted' && a.by !== TRANSCRIPT_GONE && a.by !== ENTRY_GONE)
  const cleared = archived.length - merged.length - byHand.length
  if (merged.length) parts.push(`merge ${plural(merged.length, 'thread')} into ${keepTitle.slice(0, 60)}`)
  if (byHand.length) parts.push(`delete ${byHand.map(a => a.title.slice(0, 40)).join(', ')}`)
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
    if (change.merge) {
      const { keep, drop } = change.merge
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
    const keepTitle = change.merge ? (latest.get(change.merge.keep)?.title ?? '') : ''
    const message = commitMessage(isFiling ? self : undefined, keepTitle, archived, kept.length, projects.length)
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
    const r = await changeThreads($, action === 'merge' ? { merge: { keep, drop } } : { remove: edit.picked })
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
    if (leaf && leaf !== $.plugin.name) version = /^[0-9a-f]{40}$/.test(leaf) ? leaf.slice(0, 7) : leaf
  }
  live.version = version || 'dev'
}

// The build as the line shows it: `v0.4.0` for a release, the commit or `dev` as it is.
function buildLabel() {
  return /^\d+\.\d+/.test(live.version) ? `v${live.version}` : live.version
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

// Builds this thread's entry from what the session knows and the verdict, and publishes it with
// the manifest. `status` closed marks the thread done. Never throws: the outcome goes to the
// FILING state, which the line and /judge show.
async function fileThread($: EngineInterface, verdict: JudgeVerdict, by: ThreadEntry['filedBy'], status: ThreadEntry['status']) {
  if (!isJudging() || live.isFiling) return
  live.isFiling = true
  const t = await $.clock.now()
  let path = ''
  // The expiry this filing is for: filed or failed, the thread is not filed again before it.
  let expiresAt = 0
  try {
    await hostNames($)
    const sessionId = await $.session.id()
    const cwd = await $.session.cwd()
    const repo = await $.session.repo()
    const messages = await $.session.messages()
    const usage = await $.session.usage()
    const { value: last = 0 } = await $.state.get(LAST)
    const { value: active = 0 } = await $.state.get(ACTIVE)
    const { value: ttl = null } = await $.state.get(TTL)
    const { value: contextTokens = 0 } = await $.state.get(CONTEXT)
    const { value: keepWarm = false } = await $.state.get(KEEP_WARM)
    const surfaces = await $.session.surfaces()
    const title = (await readTitle($)) || titleFrom(messages, cwd)
    await $.state.set(TITLE, title)
    expiresAt = last > 0 ? last + (ttl?.ms ?? HOUR_MS) : 0
    const entry: ThreadEntry = {
      schema: 1,
      sessionId,
      account: accountLabel(),
      host: live.host,
      surface: surfaces[0] ?? 'none',
      title,
      cwd,
      repo: repo?.remote ?? null,
      model: await $.session.model(),
      contextTokens,
      turns: await $.session.turns(),
      startedAt: new Date(usage.startedAt).toISOString(),
      lastActiveAt: new Date(active || last || t).toISOString(),
      cacheExpiresAt: expiresAt ? new Date(expiresAt).toISOString() : '',
      keepWarm,
      status,
      filedAt: new Date(t).toISOString(),
      filedBy: by,
      summary: verdict.summary,
      topics: verdict.topics,
      project: verdict.project,
      nextStep: verdict.nextStep,
      resume: `claude --resume ${sessionId}`,
    }
    path = threadPath(entry.account, sessionId)
    const done = await transact($, { entry, by: accountLabel() })
    if (done.kind === 'archived' && done.self) {
      // A merge or a deletion took this thread out: it is not filed again.
      const { value: wasArchived = null } = await $.state.get(SELF_ARCHIVED)
      await $.state.set(SELF_ARCHIVED, done.self)
      await $.state.set(FILED_FOR, expiresAt)
      if (!wasArchived) $.ui.toast(`Judge: this thread was ${selfArchivedText(done.self, done.manifest)}.`)
      return
    }
    const { value: was = null } = await $.state.get(FILING)
    await $.state.set(FILING, { at: t, ok: true, path, error: '', by })
    await $.state.set(FILED_FOR, expiresAt)
    await $.state.set(MANIFEST_THREADS, done.threads)
    await $.state.set(MANIFEST_PROJECTS, done.projects)
    const cleared = done.cleared.length ? ` ${plural(done.cleared.length, 'deleted thread')} taken out.` : ''
    if (!was || !was.ok || by !== 'judge' || cleared) $.ui.toast(`Judge: thread ${done.kind} in ${live.repo}; ${done.threads} threads in ${done.projects} projects.${cleared}`)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    const { value: was = null } = await $.state.get(FILING)
    await $.state.set(FILING, { at: t, ok: false, path, error, by })
    if (expiresAt > 0) await $.state.set(FILED_FOR, expiresAt)
    await $.state.set(FLASH_FAILED, true)
    await flash($)
    if (!was || was.ok || was.error !== error) $.ui.toast(`Judge: filing the thread failed: ${error}`, { timeoutMs: 8000 })
  } finally {
    live.isFiling = false
  }
}

// Judges the thread with a fork (reads the cache: keeps it warm too) and files the verdict;
// falls back to the local summary when the fork cannot run. For /judge file and /judge close.
async function judgeAndFile($: EngineInterface, status: ThreadEntry['status']) {
  const r = await $.model.fork({ prompt: JUDGE_PROMPT })
  if (r.isAnswered) {
    const verdict = parseVerdict(r.text)
    if (verdict) {
      await $.state.set(VERDICT, verdict)
      await fileThread($, verdict, 'judge', status === 'open' && verdict.isDone ? 'closed' : status)
      return verdict
    }
  }
  const verdict = localVerdict(await $.session.messages())
  await fileThread($, verdict, status === 'closed' ? 'end' : 'local', status)
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
      $.ui.toast(`Judge: ${related.length} open thread${related.length === 1 ? '' : 's'} already cover this project: ${named}. /judge panel shows them.`, { timeoutMs: 12_000 })
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

// ---- The keep-warm engine ---------------------------------------------------------------------

// The ping re-sends the main thread's last request outside the conversation with one short
// question after it: it reads the conversation from cache (restarting its life) and adds no
// message. With the judge on, the question is the judge's, and its reply files the thread.
async function ping($: EngineInterface, startedAt: number, lastRequestAt: number) {
  const isJudge = isJudging() && live.fileThreads
  const r = await $.model.fork({ prompt: isJudge ? JUDGE_PROMPT : PING_TEXT })
  if (!r.isAnswered && r.reason === 'nothing-to-fork') {
    await $.state.set(WAITS, true)
    const { value: contextTokens = 0 } = await $.state.get(CONTEXT)
    const { context } = await $.session.usage()
    if (!(await checkRoom($, context.window, contextTokens))) await visiblePing($, startedAt)
    return
  }
  if (!r.isAnswered && r.reason === 'api-error') {
    const status = r.status ?? 0
    if (status >= 400 && status < 500 && status !== 429) {
      await $.state.set(PING_ERROR, `HTTP ${status}`)
      $.ui.toast(`Keep-warm ping failed (HTTP ${status}); the cache will expire normally.`)
      return
    }
    $.ui.toast(`Keep-warm ping failed (HTTP ${status || '?'}); retrying in ${PING_RETRY_MS / 1000} s.`)
    live.pingPendingUntil = startedAt + PING_RETRY_MS
    return
  }
  const { cache_read_input_tokens: read, cache_creation_input_tokens: written } = r.usage
  const isHit = read > 0 && read >= HIT_SHARE * (read + written)
  const done: KeepWarmPing = { at: startedAt, isHit, read }
  const { value: pings = [] } = await $.state.get(PINGS)
  await $.state.set(PINGS, [...pings, done].slice(-MAX_PINGS))
  await observe($, startedAt - lastRequestAt, r.usage)
  await $.state.set(LAST, startedAt)
  await save($)
  if (isJudge && r.isAnswered) {
    const verdict = parseVerdict(r.text)
    if (verdict) {
      const { value: previous = null } = await $.state.get(VERDICT)
      const { value: filing = null } = await $.state.get(FILING)
      await $.state.set(VERDICT, verdict)
      // The thread was filed for this process already: file again only when the verdict moved,
      // the last filing failed, or it has been a while.
      const isSame = previous !== null && previous.summary === verdict.summary && previous.isDone === verdict.isDone
      if (!filing || !filing.ok || !isSame || startedAt - filing.at >= REFILE_MS) {
        await fileThread($, verdict, 'judge', verdict.isDone ? 'closed' : 'open')
      } else {
        const { value: ttl = null } = await $.state.get(TTL)
        await $.state.set(FILED_FOR, startedAt + (ttl?.ms ?? HOUR_MS))
      }
    }
  }
}

async function visiblePingWontFit($: EngineInterface, window: number, contextTokens: number) {
  try {
    const { breakdown } = (await $.session.usage({ breakdown: 'summary' })).context
    if (breakdown) {
      const free = breakdown.categories.filter(c => c.kind === 'free').reduce((n, c) => n + c.tokens, 0)
      const instructions = breakdown.memoryFiles.reduce((n, f) => n + f.tokens, 0)
      return free < instructions + VISIBLE_PING_ROOM
    }
  } catch {
    // No breakdown here: go by the share of the window below.
  }
  return window > 0 && contextTokens >= VISIBLE_PING_MAX_FILL * window
}

async function checkRoom($: EngineInterface, window: number, contextTokens: number) {
  live.roomChecked = true
  const wontFit = await visiblePingWontFit($, window, contextTokens)
  const { value: was = false } = await $.state.get(NEARLY_FULL)
  if (wontFit !== was) await $.state.set(NEARLY_FULL, wontFit)
  return wontFit
}

async function visiblePing($: EngineInterface, startedAt: number) {
  live.visiblePingAt = startedAt
  const r = await $.prompt.submit({ text: VISIBLE_PING_TEXT })
  if (typeof r.drop === 'string') {
    live.visiblePingAt = 0
    $.ui.toast(`Keep-warm ping not sent: ${r.drop}`)
  }
}

// With the judge on, a thread whose cache is about to expire is filed once per expiry: at the
// window's start when keep-warm is off (nothing else will), in its last minute when keep-warm is
// on and the ping did not file it (blocked, failed, or visible).
async function fileIfExpiring($: EngineInterface, t: number, last: number, ttl: KeepWarmTtl, isOn: boolean) {
  if (!isJudging() || !live.fileThreads || !ttl || last === 0 || live.isFiling) return
  const expiresAt = last + ttl.ms
  const { value: filedFor = 0 } = await $.state.get(FILED_FOR)
  if (filedFor === expiresAt) return
  const canPing = isOn && ttl.ms >= KEEP_WARM_MIN_TTL_MS
  const due = canPing ? expiresAt - PING_MARGIN_MS : expiresAt - PING_LEAD_MS
  if (t < due) return
  await fileThread($, localVerdict(await $.session.messages()), 'local', 'open')
}

async function tick($: EngineInterface) {
  const t = await $.clock.now()
  await endFlash($)
  const usage = await $.session.usage()
  const { value: shortAfter = 0 } = await $.state.get(SHORT_AFTER)
  const ttl = correctTtl(await detectTtl($, usage), shortAfter)
  const { value: last = 0 } = await $.state.get(LAST)

  const { value: knownContext = 0 } = await $.state.get(CONTEXT)
  const contextTokens = usage.context.tokens ?? knownContext
  const shownKey = `${Math.floor(t / 60_000)}|${ttl?.ms ?? 0}|${ttl?.reason ?? ''}|${contextTokens}|${last}|${shortAfter}`
  if (shownKey !== live.shownKey) {
    live.shownKey = shownKey
    await $.state.set(TTL, ttl)
    await $.state.set(CONTEXT, contextTokens)
    await $.state.set(NOW, t)
  }

  const { value: isOn = false } = await $.state.get(KEEP_WARM)
  if (!isOn) {
    await fileIfExpiring($, t, last, ttl, false)
    return
  }
  const { value: sawResponse = false } = await $.state.get(SAW_RESPONSE)
  const { value: waits = false } = await $.state.get(WAITS)
  const needsVisible = !sawResponse || waits
  if (needsVisible && !live.roomChecked) await checkRoom($, usage.context.window, contextTokens)
  const { value: stopAt = 0 } = await $.state.get(STOP_AT)
  if (stopAt > 0 && t >= stopAt) {
    await setKeepWarm($, false, 0)
    $.ui.toast(`Keep-warm stopped at ${clockTime(stopAt)} as asked; the cache will expire normally.`)
    return
  }
  const idle = t - last
  const isPingWindow =
    ttl !== null &&
    ttl.ms >= KEEP_WARM_MIN_TTL_MS &&
    last > 0 &&
    idle >= ttl.ms - PING_LEAD_MS &&
    idle < ttl.ms - PING_MARGIN_MS
  if (!isPingWindow || t < live.pingPendingUntil) {
    await fileIfExpiring($, t, last, ttl, true)
    return
  }

  const { value: pings = [] } = await $.state.get(PINGS)
  if (stopAt === 0 && pings.length >= MAX_PINGS) {
    await setKeepWarm($, false, 0)
    $.ui.toast(`Keep-warm stopped itself after ${MAX_PINGS} pings in a row; the cache will expire.`)
    return
  }
  live.pingPendingUntil = t + PING_PENDING_MS
  const { value: nearlyFull = false } = await $.state.get(NEARLY_FULL)
  if (!needsVisible) await ping($, t, last)
  else if (!nearlyFull) await visiblePing($, t)
}

function parseStop(text: string, now: number) {
  if (text === '') return 0
  const duration = DURATION.exec(text)
  if (duration) return now + Number(duration[1]) * (duration[2] === 'h' ? HOUR_MS : 60_000)
  const until = UNTIL.exec(text)
  if (!until) return -1
  const at = new Date(now)
  at.setHours(Number(until[1]), Number(until[2]), 0, 0)
  return at.getTime() > now ? at.getTime() : at.getTime() + 24 * HOUR_MS
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
  const { value: last = 0 } = await $.state.get(LAST)
  const { value: now = 0 } = await $.state.get(NOW)
  const { value: isOn = false } = await $.state.get(KEEP_WARM)
  const { value: stopAt = 0 } = await $.state.get(STOP_AT)
  const { value: pings = [] } = await $.state.get(PINGS)
  const { value: ttl = null } = await $.state.get(TTL)
  const { value: contextTokens = 0 } = await $.state.get(CONTEXT)
  const { value: isWaiting = false } = await $.state.get(WAITING)
  const { value: shortAfter = 0 } = await $.state.get(SHORT_AFTER)
  const { value: waits = false } = await $.state.get(WAITS)
  const { value: sawResponse = false } = await $.state.get(SAW_RESPONSE)
  const { value: pingError = '' } = await $.state.get(PING_ERROR)
  const { value: nearlyFull = false } = await $.state.get(NEARLY_FULL)
  const { value: filing = null } = await $.state.get(FILING)
  const { value: related = [] } = await $.state.get(RELATED)
  const { value: manifestThreads = 0 } = await $.state.get(MANIFEST_THREADS)
  const { value: manifestProjects = 0 } = await $.state.get(MANIFEST_PROJECTS)
  const { value: updates = 0 } = await $.state.get(UPDATES)
  const { value: updatedAt = 0 } = await $.state.get(UPDATED_AT)
  const { value: flashFailed = false } = await $.state.get(FLASH_FAILED)
  const { value: flashUntil = 0 } = await $.state.get(FLASH_UNTIL)
  const { value: selfArchived = null } = await $.state.get(SELF_ARCHIVED)
  const isBlocked = (!sawResponse || waits) && nearlyFull
  // Lit for FLASH_MS after a commit to the manifest (green) or a failed filing (red).
  const isFlash = isJudging() && flashUntil > 0 && (await $.clock.now()) < flashUntil && (flashFailed ? filing !== null : updatedAt > 0)
  const flashColor = flashFailed ? 'red' : 'green'

  const t = Math.max(now, last)
  const ttlMs = ttl?.ms ?? HOUR_MS
  const canKeepWarm = ttl !== null && ttl.ms >= KEEP_WARM_MIN_TTL_MS
  const isGreen = isOn && canKeepWarm && !pingError && !isBlocked
  const expiresAt = last + ttlMs
  const remaining = expiresAt - t
  const isWarm = last > 0 && remaining > 0
  const filled = isWarm ? Math.max(1, Math.ceil((remaining / ttlMs) * BAR_CELLS)) : 0
  const quarters = CIRCLE_BY_QUARTER.length
  const circle = isWarm
    ? CIRCLE_BY_QUARTER[Math.min(quarters, Math.max(1, Math.ceil((remaining / ttlMs) * quarters))) - 1]
    : CIRCLE_COLD

  const main = last === 0 ? 'nothing cached yet' : isWarm ? timeLeft(remaining) : `cold since ${clockTime(expiresAt)}`
  const expiresText = isWarm ? ` (${clockTime(expiresAt)})` : ''
  const parts: string[] = []
  if (isWaiting && isWarm) parts.push('waiting for your answer')

  if (ttl && !canKeepWarm) {
    if (ttl.reason === 'observed') parts.push(`cache expired after ${minutes(shortAfter)} min, sooner than expected`, 'keep-warm paused')
    else if (ttl.reason === 'overage') parts.push(`${cacheLength(ttl.ms)} cache while over your plan limit`, 'keep-warm paused')
    else parts.push(`${cacheLength(ttl.ms)} cache (${ttl.reason === 'api' ? 'API key' : 'your settings'})`, 'keep-warm needs the 1-hour cache')
  } else if (isOn) {
    const lastPing = pings[pings.length - 1]
    if (stopAt) parts.push(`keep-warm stops ${clockTime(stopAt)}`)
    if (pingError) parts.push(`ping failed: ${pingError}`)
    else if (!ttl) parts.push(WAITS_TEXT)
    else if (isBlocked) parts.push(NEARLY_FULL_TEXT)
    else if (isWarm) parts.push(`next ping ${clockTime(last + ttlMs - PING_LEAD_MS)}${sawResponse && !waits ? '' : SHOWS_IN_CHAT}`)
    if (lastPing) parts.push(`${pings.length} ping${pings.length === 1 ? '' : 's'} ${lastPing.isHit ? '✓' : '✗'}`)
  }

  if (contextTokens > 0 && last > 0) {
    if (!isWarm) parts.push(`your next message re-writes ${tokens(contextTokens)}`, ...(isGreen ? ['keep-warm restarts after it'] : []))
    else if (!isGreen && remaining < EXPIRING_MS) parts.push(`after ${clockTime(expiresAt)} your next message re-writes ${tokens(contextTokens)}`)
    else parts.push(`${tokens(contextTokens)} cached`)
  }

  // The judge's part: when this session last updated the manifest, or that a filing failed; how
  // many other open threads the manifest holds for this project; and the tally of updates.
  if (isJudging()) {
    if (selfArchived) parts.push(selfArchived.reason === 'merged' ? 'merged into another thread' : 'taken out of the manifest')
    else if (!isFlash && filing && !filing.ok && filing.at >= updatedAt) parts.push('filing failed')
    else if (!isFlash && updatedAt > 0) parts.push(`manifest updated ${clockTime(updatedAt)}`)
    if (updates > 0) parts.push(plural(updates, 'update'))
    if (related.length > 0) parts.push(`${related.length} related thread${related.length === 1 ? '' : 's'}`)
    parts.push(...counter(manifestThreads, manifestProjects, 0))
  }

  const canToggle = isOn || !ttl || canKeepWarm || ttl.reason === 'overage' || ttl.reason === 'observed'
  const flashText = flashFailed ? '✗ filing failed' : `✓ manifest updated ${clockTime(updatedAt)}`
  const { value: fullTitle = '' } = await $.state.get(TITLE)
  const title = fullTitle.length > TITLE_SHOWN ? `${fullTitle.slice(0, TITLE_SHOWN - 1)}…` : fullTitle
  return { isFlash, flashColor, flashText, isGreen, circle, filled, main, expiresText, parts, canToggle, isOn, title }
}

export const register: Register = (on, options) => {
  live.titleMark = options[TITLE_MARK_OPTION] !== false
  live.repo = parseRepo(String(options[REPO_OPTION] ?? ''))
  live.account = String(options[ACCOUNT_OPTION] ?? '').trim()
  live.tokenOption = String(options[TOKEN_OPTION] ?? '')
  live.fileThreads = options[FILE_THREADS_OPTION] !== false
  live.judgeModel = String(options[JUDGE_MODEL_OPTION] ?? '').trim()
  live.sweepDeleted = options[SWEEP_OPTION] !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: "Keep this session's prompt cache warm: on [3h | until 18:00], off, or status",
      argumentHint: '[on [3h|until 18:00] | off]',
      immediate: true,
    })
    await $.command.register({
      name: JUDGE_COMMAND,
      description: 'The thread manifest: status, file or close this thread, list the open threads of this project, open the pane, merge or delete threads',
      argumentHint: '[status | file | close | threads | pane | merge <keep> <other>… | delete <id>…]',
      immediate: true,
    })

    live.storeKey = STORE_PREFIX + (await $.session.id())
    live.isFirstRequest = true
    await readVersion($)
    const plan = (await $.store.get(PLAN_TTL_KEY)) as KeepWarmTtl | undefined
    if (plan && typeof plan.ms === 'number') live.planTtl = plan

    const { value: restored = false } = await $.state.get(RESTORED)
    if (!restored) {
      const saved = (await $.store.get(live.storeKey)) as KeepWarmSaved | undefined
      if (saved) {
        if (saved.ttl && typeof saved.ttl.ms === 'number') live.savedTtl = saved.ttl
        const { value: last = 0 } = await $.state.get(LAST)
        if (saved.lastRequestAt > last) await $.state.set(LAST, saved.lastRequestAt)
        await $.state.set(KEEP_WARM, saved.keepWarm)
        await $.state.set(STOP_AT, saved.stopAt ?? 0)
      }
      await $.state.set(RESTORED, true)
      await save($)
    }

    const t = await $.clock.now()
    for (const key of await $.store.keys()) {
      if (!key.startsWith(STORE_PREFIX) || key === live.storeKey) continue
      const old = (await $.store.get(key)) as KeepWarmSaved | undefined
      const at = old ? (old.savedAt ?? old.lastRequestAt) : 0
      if (!old || (at > 0 ? t - at > STORE_MAX_AGE_MS : !old.keepWarm)) await $.store.delete(key)
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

  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') await startOver($)
    else if ((e.source === 'resume' || e.source === 'fork') && typeof e.seconds_since_last_response === 'number') {
      const t = await $.clock.now()
      const lastAt = t - e.seconds_since_last_response * 1000 - RESUME_MARGIN_MS
      const { value: last = 0 } = await $.state.get(LAST)
      if (lastAt > last) await $.state.set(LAST, lastAt)
      const { value: active = 0 } = await $.state.get(ACTIVE)
      if (lastAt > active) await $.state.set(ACTIVE, lastAt)
      if (e.context_tokens) await $.state.set(CONTEXT, e.context_tokens)
      await $.state.set(NOW, t)
      const { value: restored = false } = await $.state.get(RESTORED)
      if (restored) await save($)
    }
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && e.trigger !== 'precompute' && result.skip === undefined) {
      try {
        await startOver($)
      } catch {
        // Never fail a compaction over the countdown.
      }
    }
    return result
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    const t = await $.clock.now()
    const { value: previous = 0 } = await $.state.get(LAST)
    live.pingPendingUntil = 0
    await $.state.set(LAST, t)
    await $.state.set(NOW, t)
    await save($)
    const result = yield* next(e)
    const u = result?.usage
    if (!u || u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens === 0) {
      await $.state.set(LAST, previous)
      await save($)
      return result
    }
    await $.state.set(WAITS, false)
    await $.state.set(PING_ERROR, '')
    if (live.visiblePingAt > 0) {
      const { cache_read_input_tokens: read, cache_creation_input_tokens: written } = u
      const done: KeepWarmPing = { at: live.visiblePingAt, isHit: read > 0 && read >= HIT_SHARE * (read + written), read }
      const { value: pings = [] } = await $.state.get(PINGS)
      await $.state.set(PINGS, [...pings, done].slice(-MAX_PINGS))
      live.visiblePingAt = 0
      live.pingTurnId = e.turnId
    }
    const isFirst = live.isFirstRequest
    live.isFirstRequest = false
    if (previous > 0 && !isFirst) await observe($, t - previous, u)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      const isPingTurn = e.turnId === live.pingTurnId
      if (isPingTurn) live.pingTurnId = ''
      if (e.usage) {
        await $.state.set(SAW_RESPONSE, true)
        if (!isPingTurn) {
          await $.state.set(PINGS, [])
          // A real turn: the thread is active, and its next expiry is a new one to file.
          await $.state.set(ACTIVE, await $.clock.now())
          await rememberTitle($)
        }
      } else if (live.visiblePingAt > 0) {
        live.visiblePingAt = 0
        if (e.reason === 'error') {
          const why = e.answer.trim() || 'an API error'
          await $.state.set(PING_ERROR, why)
          $.ui.toast(`Keep-warm ping failed: ${why}. The cache will expire normally.`)
        }
      }
    }
    return next(e)
  })

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    await $.state.set(WAITING, true)
    try {
      return await next(e)
    } finally {
      await $.state.set(WAITING, false)
    }
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const t = await $.clock.now()
    const words = e.args.trim().toLowerCase()
    const [first = ''] = words.split(/\s+/)
    if (first === 'off') {
      await setKeepWarm($, false, 0)
    } else if (words !== '' && words !== 'status') {
      const stopAt = parseStop(first === 'on' ? words.slice(2).trim() : words, t)
      if (stopAt < 0) return { text: 'Not understood. Try: /keepwarm on, /keepwarm 3h, /keepwarm until 18:00, /keepwarm off' }
      await setKeepWarm($, true, stopAt)
    }

    const { value: isOn = false } = await $.state.get(KEEP_WARM)
    const { value: stopAt = 0 } = await $.state.get(STOP_AT)
    const { value: ttl = null } = await $.state.get(TTL)
    const { value: pings = [] } = await $.state.get(PINGS)
    const { value: waits = false } = await $.state.get(WAITS)
    const { value: sawResponse = false } = await $.state.get(SAW_RESPONSE)
    const lines = [
      isOn
        ? `Keep-warm on${stopAt ? ` until ${clockTime(stopAt)}` : ` (stops itself after ${MAX_PINGS} pings in a row)`}: about ${minutes(PING_LEAD_MS)} min before the cache would expire, it re-reads the conversation from cache in the background. A cold cache is never pinged.`
        : 'Keep-warm off: the cache expires normally.',
    ]
    if (isOn && isJudging() && live.fileThreads) lines.push('Each ping is also the judge: its reply files this thread into the manifest.')
    if (isOn && (waits || !sawResponse)) lines.push('Claude Code can repeat this conversation invisibly only once it has answered since the app started, so the next ping is a short message in the chat.')
    if (ttl) lines.push(`This session's cache lasts ${cacheLength(ttl.ms)} (${ttl.reason === 'observed' ? 'seen expiring sooner than expected' : ttl.reason}).`)
    if (ttl && ttl.ms < KEEP_WARM_MIN_TTL_MS) lines.push(`Keep-warm only pings a cache of ${minutes(KEEP_WARM_MIN_TTL_MS)} min or longer.`)
    for (const p of pings.slice(-HISTORY_SHOWN)) {
      lines.push(`${clockTime(p.at)} · ${p.isHit ? `read ${tokens(p.read)} from cache` : 'found the cache cold'}`)
    }
    return { text: lines.join('\n') }
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
      const r = await changeThreads($, word === 'merge' ? { merge: { keep, drop } } : { remove: ids })
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
      `**Judge** ${mdText(buildLabel())} · manifest ${mdCode(live.repo)} · account ${mdCode(accountLabel())}`,
      '',
      `- **Filing:** ${live.fileThreads ? "when this thread's cache is about to expire" : 'only on `/judge file`'}`,
      `- **Last filed:** ${filing ? (filing.ok ? `${clockTime(filing.at)}, ${FILED_BY[filing.by]}, at ${mdCode(filing.path)}` : `${clockTime(filing.at)}, failed: ${mdText(filing.error)}`) : 'not yet this session'}`,
    ]
    if (self) lines.push(`- **This thread:** ${mdText(selfArchivedText(self, manifest))}`)
    if (verdict) lines.push(`- **Verdict:** ${mdText(verdict.summary)}${verdict.project ? ` *(project: ${mdText(verdict.project)})*` : ''}`)
    lines.push(`- **Manifest:** ${counter(manifestThreads, manifestProjects, updates).join(' · ') || 'not read yet'}${updatedAt ? `; last updated ${clockTime(updatedAt)}` : ''}`)
    if (related.length) lines.push(`- **This project:** ${plural(related.length, 'other open thread')}; \`/judge threads\` lists them`)
    lines.push('', '`/judge file` · `/judge close` · `/judge threads` · `/judge pane` · `/judge merge <keep> <other>…` · `/judge delete <id>…`')
    return { text: lines.join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    live.bandSeen = true

    const { Box, Button, Text } = $.ui.resolve(e)
    const m = await lineModel($)
    // The title leads the details; the rest follows as far as the width allows.
    const details = [...(m.title ? [m.title] : []), ...m.parts]
    const build = buildLabel()
    const fixed =
      LABEL.length + DETAIL_GAP + build.length + DETAIL_GAP + 1 + DETAIL_GAP + BAR_CELLS + DETAIL_GAP + m.main.length + m.expiresText.length +
      (m.isFlash ? DETAIL_GAP + m.flashText.length : 0) + (m.canToggle ? BUTTON_COLUMNS : 0) + (isJudging() ? THREADS_BUTTON_COLUMNS : 0)
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
            {m.isGreen ? <Text color="green" bold>{m.circle}</Text> : <Text dimColor>{m.circle}</Text>}
          </Box>
          <Box flexShrink={0}>
            {m.isGreen ? <Text color="green">{BAR_FULL.repeat(m.filled)}</Text> : <Text dimColor>{BAR_FULL.repeat(m.filled)}</Text>}
            <Text dimColor>{BAR_EMPTY.repeat(BAR_CELLS - m.filled)}</Text>
          </Box>
          <Box flexShrink={0}>
            <Text bold>{m.main}</Text>
            <Text dimColor>{m.expiresText}</Text>
          </Box>
          {m.isFlash && (
            <Box flexShrink={0}>
              <Text color={m.flashColor} bold>{m.flashText}</Text>
            </Box>
          )}
          {shown.flatMap(p => [
            <Box flexShrink={0}><Text dimColor>·</Text></Box>,
            <Box flexShrink={0}>{m.title !== '' && p === shown[0] && details[0] === m.title ? <Text>{p}</Text> : <Text dimColor>{p}</Text>}</Box>,
          ])}
        </Box>
        {isJudging() && (
          <Box flexShrink={0}>
            <Button key="threads" label="Threads" onPress={() => showPane($)} />
          </Box>
        )}
        {m.canToggle && (
          <Box flexShrink={0}>
            <Button
              key="toggle"
              label={m.isOn ? 'Stop' : 'Keep warm'}
              onPress={() => setKeepWarm($, !m.isOn, 0)}
            />
          </Box>
        )}
      </Box>
    )
  })

  // The same line as a pane, in rows, where no band is drawn (a cloud session's chat).
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const m = await lineModel($)
    // Below the line: this project's threads, or every project's, each project with its
    // archived threads and an edit mode that merges or deletes the threads picked.
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
      const { value: shownAt = 0 } = await $.state.get(NOW)
      const now = shownAt || (await $.clock.now())
      const selfId = await $.session.id()

      const all = manifest?.projects ?? []
      const near = new Set([selfId, ...related.map(t => t.sessionId)])
      const mine = all.filter(p => p.threads.some(t => near.has(t.sessionId)))
      const shown = view === 'all' ? all : mine
      const openIn = (ps: readonly ManifestProject[]) => ps.reduce((n, p) => n + p.threads.filter(t => t.status !== 'closed').length, 0)
      const head = manifest
        ? `${plural(openIn(all), 'open thread')} · ${plural(all.length, 'project')} · read ${clockTime(readAt)}`
        : error
          ? `manifest not read: ${error}`
          : 'reading the manifest…'

      const editor = (p: ManifestProject, open: readonly ManifestThread[]) => {
        const picked = edit?.slug === p.slug ? edit.picked : []
        const keep = open.find(t => t.sessionId === picked[0])
        return (
          <Box flexDirection="column">
            <Text dimColor>Pick the thread to keep first, then the ones to fold into it; or pick threads to delete.</Text>
            {open.map(t => {
              const at = picked.indexOf(t.sessionId)
              return (
                <Button key={`pick:${t.sessionId}`} plain onPress={() => update($, PANE_EDIT, current => togglePick(current ?? undefined, p.slug, t.sessionId))}>
                  {`${at >= 0 ? `[${at + 1}]` : '[ ]'} ${clipTitle(t.title)}`} <Text dimColor>{`${t.account} · ${ago(t.lastActiveAt, now)}`}</Text>
                </Button>
              )
            })}
            <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
              {picked.length >= 2 && keep && (
                <Button key={`merge:${p.slug}`} variant="primary" label={`Merge ${picked.length - 1} into “${clipTitle(keep.title)}”`} onPress={() => paneAction($, 'merge')} />
              )}
              {picked.length >= 1 && <Button key={`delete:${p.slug}`} label={`Delete ${picked.length}`} onPress={() => paneAction($, 'delete')} />}
              <Button key={`cancel:${p.slug}`} label="Cancel" onPress={() => $.state.set(PANE_EDIT, null)} />
            </Box>
          </Box>
        )
      }

      const section = (p: ManifestProject) => {
        const open = p.threads.filter(t => t.status !== 'closed')
        const isEditing = edit?.slug === p.slug
        const counts = [plural(open.length, 'open thread'), ...(p.archived?.length ? [`${p.archived.length} archived`] : [])].join(' · ')
        return (
          <Box flexDirection="column">
            <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
              <Text bold>{p.name}</Text>
              <Text dimColor>{counts}</Text>
              {!isEditing && open.length > 0 && (
                <Button key={`edit:${p.slug}`} label="Merge or delete" onPress={() => $.state.set(PANE_EDIT, { slug: p.slug, picked: [] })} />
              )}
            </Box>
            {isEditing ? editor(p, open) : <Markdown text={projectMarkdown(p, now, selfId, view === 'project')} />}
          </Box>
        )
      }

      return (
        <Box flexDirection="column" rowGap={1} marginTop={1}>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
            <Text bold>Threads</Text>
            <Text dimColor>{head}</Text>
          </Box>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Button key="view-project" label={`This project (${openIn(mine)})`} variant={view === 'project' ? 'primary' : 'secondary'} onPress={() => $.state.set(PANE_VIEW, 'project')} />
            <Button key="view-all" label={`All (${openIn(all)})`} variant={view === 'all' ? 'primary' : 'secondary'} onPress={() => $.state.set(PANE_VIEW, 'all')} />
            <Button key="refresh" label={isBusy ? 'Working…' : 'Refresh'} onPress={() => refreshPane($)} />
          </Box>
          {notice !== '' && <Text dimColor>{notice}</Text>}
          {selfArchived && <Text color="yellow">{`This thread was ${selfArchivedText(selfArchived, manifest)}.`}</Text>}
          {manifest && shown.length === 0 && (
            <Markdown text={view === 'project' ? '*No thread in the manifest covers this repository or directory yet. **All** lists every project.*' : '*The manifest lists no project yet.*'} />
          )}
          {shown.map(section)}
        </Box>
      )
    }

    const threads = isJudging() ? await threadsSection() : null

    return (
      <Box flexDirection="column" rowGap={0}>
        <Box flexWrap="nowrap" alignItems="center" columnGap={DETAIL_GAP}>
          <Box flexShrink={0}>
            {m.isFlash ? <Text color={m.flashColor} bold>{LABEL}</Text> : <Text color={LABEL_COLOR} bold>{LABEL}</Text>}
          </Box>
          <Box flexShrink={0}>
            {m.isGreen ? <Text color="green" bold>{m.circle}</Text> : <Text dimColor>{m.circle}</Text>}
          </Box>
          <Box flexShrink={0}>
            {m.isGreen ? <Text color="green">{BAR_FULL.repeat(m.filled)}</Text> : <Text dimColor>{BAR_FULL.repeat(m.filled)}</Text>}
            <Text dimColor>{BAR_EMPTY.repeat(BAR_CELLS - m.filled)}</Text>
          </Box>
          <Box flexShrink={0}>
            <Text bold>{m.main}</Text>
            <Text dimColor>{m.expiresText}</Text>
          </Box>
        </Box>
        {m.title !== '' && <Text>{m.title}</Text>}
        {m.isFlash && <Text color={m.flashColor} bold>{m.flashText}</Text>}
        {m.parts.map(p => (
          <Text dimColor>{p}</Text>
        ))}
        <Box columnGap={DETAIL_GAP}>
          {m.canToggle && <Button key="toggle" label={m.isOn ? 'Stop' : 'Keep warm'} onPress={() => setKeepWarm($, !m.isOn, 0)} />}
          {isJudging() && <Button key="file" label="File now" onPress={() => void judgeAndFile($, 'open')} />}
        </Box>
        {live.version !== '' && <Text dimColor>{`${PLUGIN_NAME} ${buildLabel()}`}</Text>}
        {threads}
      </Box>
    )

  })
}

