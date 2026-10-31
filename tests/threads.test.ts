import { expect, mock, test } from 'claude-code/testing'

import { mdText, threadsReply } from '../hooks/format'
import { briefOf, bundle, buildOf, fromBase64, previousAssignment, toBase64 } from '../hooks/judge'
import { guardTidy, parseTidy, protectedIds, stillValid, tidyRefs, tidyRules, titleKey } from '../hooks/tidy'
import { RELEASE } from '../hooks/version'
import type { Manifest, ManifestProject, ManifestThread, ProjectArchive, ThreadEntry } from '../types'

const OPTIONS = { manifest_repo: 'me/claude-threads', account_label: 'work', github_token: 'ghp_test', file_threads: true }
const START = 1_700_000_000_000
const PLUGIN_FOOTER = 'judge-keep-warm '

const KEEP = 'aaaa1111-0000-4000-8000-000000000001'
const DROP = 'bbbb2222-0000-4000-8000-000000000002'
const MINE = 'cccc3333-0000-4000-8000-000000000003'
const ELSEWHERE = 'dddd4444-0000-4000-8000-000000000004'

type Thread = { id: string; account: string; host: string; title: string; summary: string; repo?: string | null }

const THREADS: Thread[] = [
  { id: KEEP, account: 'home', host: 'pc', title: 'Keep me', summary: 'Started with: Fix the queue retries Last answer: Retries are capped at five.' },
  { id: DROP, account: 'home', host: 'pc', title: 'Fold me', summary: 'Porting the queue tests to the new runner. Two suites left.' },
  { id: MINE, account: 'work', host: 'mac', title: 'Old thread on this mac', summary: 'Started with: Draft the release notes' },
  { id: ELSEWHERE, account: 'work', host: 'other-mac', title: 'Thread on another mac', summary: 'Tidying the CI cache.' },
]

function entryText(t: Thread) {
  return JSON.stringify({
    schema: 1, sessionId: t.id, account: t.account, host: t.host, surface: 'terminal', title: t.title, cwd: '/h/app', repo: t.repo === undefined ? 'https://github.com/me/app' : t.repo,
    model: 'opus', contextTokens: 1, turns: 1, startedAt: '2023-11-14T18:00:00.000Z', lastActiveAt: '2023-11-14T20:00:00.000Z', cacheExpiresAt: '', keepWarm: false,
    status: 'open', filedAt: '2023-11-14T20:05:00.000Z', filedBy: 'local', summary: t.summary, topics: [], project: '', nextStep: '', resume: `claude --resume ${t.id}`,
  })
}

function listed(t: Thread): ManifestThread {
  return { sessionId: t.id, account: t.account, host: t.host, title: t.title, summary: t.summary, repo: t.repo === undefined ? 'https://github.com/me/app' : (t.repo ?? null), cwd: '/h/app', lastActiveAt: '2023-11-14T20:00:00.000Z', status: 'open', resume: `claude --resume ${t.id}` }
}

function manifestText(threads: Thread[]) {
  const m: Manifest = { schema: 1, generatedAt: '2023-11-14T20:05:00.000Z', projects: [{ name: 'app', slug: 'me-app', description: 'Threads in me/app', repos: ['me/app'], threads: threads.map(listed) }] }
  return JSON.stringify(m)
}

// A repository holding the manifest and an entry file per thread, unless `without` names one.
function repoFiles(threads: Thread[], without: string[] = []) {
  const files: Record<string, string> = { 'README.md': 'hi', 'manifest.json': manifestText(threads) }
  for (const t of threads) if (!without.includes(t.id)) files[`threads/${t.account}/${t.id}.json`] = entryText(t)
  return files
}

type Commit = { message: string; files: Record<string, string>; deletes: string[] }
type Repo = { files: Record<string, string>; commits: Commit[]; modelCalls: number; fetches: number; failing: boolean; tidyPrompts: string[] }

// GitHub in memory: one branch, a tree of files, blobs by sha; a tree entry with a null sha deletes its path.
function fakeGithub(repo: Repo) {
  const blobs = new Map<string, string>()
  const shaOf = (text: string) => `sha-${text.length}-${[...text].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7)}`
  let head = 'c0'
  const trees = new Map<string, Record<string, string>>()
  const pending = { blobs: new Map<string, string>(), tree: {} as Record<string, string>, deletes: [] as string[], message: '' }
  return (method: string, url: string, body?: string) => {
    repo.fetches++
    if (repo.failing) return { status: 500, text: '{"message":"Server Error"}' }
    const path = url.replace('https://api.github.com/repos/me/claude-threads', '')
    const json = body ? (JSON.parse(body) as Record<string, unknown>) : {}
    if (method === 'GET' && path === '') return { status: 200, text: '{"default_branch":"main"}' }
    if (method === 'GET' && path === '/git/ref/heads/main') return { status: 200, text: JSON.stringify({ object: { sha: head } }) }
    if (method === 'GET' && path === `/git/commits/${head}`) {
      trees.set(`t-${head}`, { ...repo.files })
      return { status: 200, text: JSON.stringify({ tree: { sha: `t-${head}` } }) }
    }
    if (method === 'GET' && path.startsWith('/git/trees/')) {
      const files = trees.get(path.slice('/git/trees/'.length).replace('?recursive=1', '')) ?? {}
      const tree = Object.entries(files).map(([p, text]) => {
        blobs.set(shaOf(text), text)
        return { path: p, type: 'blob', sha: shaOf(text) }
      })
      return { status: 200, text: JSON.stringify({ tree }) }
    }
    if (method === 'GET' && path.startsWith('/git/blobs/')) {
      const text = blobs.get(path.slice('/git/blobs/'.length))
      return text === undefined ? { status: 404, text: '{"message":"Not Found"}' } : { status: 200, text: JSON.stringify({ content: toBase64(text), encoding: 'base64' }) }
    }
    if (method === 'POST' && path === '/git/blobs') {
      const text = fromBase64(String(json['content']))
      pending.blobs.set(shaOf(text), text)
      return { status: 201, text: JSON.stringify({ sha: shaOf(text) }) }
    }
    if (method === 'POST' && path === '/git/trees') {
      pending.tree = {}
      pending.deletes = []
      for (const e of json['tree'] as { path: string; sha: string | null }[]) {
        if (e.sha === null) pending.deletes.push(e.path)
        else pending.tree[e.path] = pending.blobs.get(e.sha) ?? ''
      }
      return { status: 201, text: '{"sha":"new-tree"}' }
    }
    if (method === 'POST' && path === '/git/commits') {
      pending.message = String(json['message'])
      return { status: 201, text: `{"sha":"c${repo.commits.length + 1}"}` }
    }
    if (method === 'PATCH' && path === '/git/refs/heads/main') {
      Object.assign(repo.files, pending.tree)
      for (const d of pending.deletes) delete repo.files[d]
      repo.commits.push({ message: pending.message, files: { ...pending.tree }, deletes: [...pending.deletes] })
      head = `c${repo.commits.length}`
      return { status: 200, text: '{}' }
    }
    return { status: 500, text: `{"message":"unexpected ${method} ${path}"}` }
  }
}

// `tidyAnswer`: what the model answers the tidy review (its system prompt starts "You tidy"); null: no answer.
type Extra = { env?: Record<string, string>; local?: string[]; version?: string; sessionId?: string; noPanes?: boolean; tidyAnswer?: string | null }
const PROJECTS_DIR = '/home/me/.claude/projects'

// Stands for the engine beneath the mod. `local` lists the session ids whose transcripts this
// machine keeps under PROJECTS_DIR; without it there is no such folder.
function engine(on: Parameters<Parameters<typeof test>[1]>[1], files: Record<string, string>, extra: Extra = {}) {
  const repo: Repo = { files, commits: [], modelCalls: 0, fetches: 0, failing: false, tidyPrompts: [] }
  const github = fakeGithub(repo)
  const toasts: string[] = []
  const opened: string[] = []
  mock.env(on, { HOSTNAME: 'mac.local', USER: 'me', ...(extra.local ? { HOME: '/home/me' } : {}), ...(extra.env ?? {}) })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__judge-keep-warm__${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: START, context: { tokens: 120_000, window: 1_000_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 10 }], cost: { usd: 0 } } }))
  on('session.id', () => ({ value: extra.sessionId ?? 'sess-1' }))
  on('session.repo', () => ({ value: { root: '/work/app', remote: 'git@github.com:me/app.git', internal: false, name: null } }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('session.model', () => ({ value: 'opus' }))
  on('session.turns', () => ({ value: 3 }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'Port the billing job', toolUses: [] }] }))
  on('settings.read', () => ({ value: {} }))
  on('tool.call', () => ({ result: {}, isError: true, text: 'no such tool' }))
  on('classic.SessionStart', () => ({}))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    toasts.push(`log: ${e.text}`)
    return { value: undefined }
  })
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: extra.noPanes ? { isPlaced: false, reason: 'no surface places panes' } : { isPlaced: true } }
  })
  on('fs.read', (_, e) => {
    if (e.path.endsWith('/.claude-plugin/plugin.json')) return { value: JSON.stringify({ name: 'judge-keep-warm', version: extra.version ?? '9.9.9' }) }
    throw new Error(`no file ${e.path}`)
  })
  on('fs.exists', (_, e) => ({ value: extra.local !== undefined && e.path === PROJECTS_DIR }))
  on('fs.list', (_, e) => {
    const file = (name: string, kind: 'file' | 'dir') => ({ name, kind, size: 1, mtimeMs: 0, isLink: false })
    if (e.path === PROJECTS_DIR) return { value: [file('-work-app', 'dir'), file('notes.txt', 'file')] }
    if (e.path === `${PROJECTS_DIR}/-work-app`) return { value: (extra.local ?? []).map(id => file(`${id}.jsonl`, 'file')) }
    return { value: [] }
  })
  on('model.complete', (_, e) => {
    repo.modelCalls++
    if (e.system?.startsWith('You tidy')) {
      repo.tidyPrompts.push(e.prompt)
      const answer = extra.tidyAnswer ?? null
      const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      return { value: answer === null ? { isAnswered: false, reason: 'empty-reply', usage } : { isAnswered: true, text: answer, usage } }
    }
    return { value: { isAnswered: true, text: `{"projects": [{"name": "App", "description": "The app and its queue.", "threadIds": ["sess-1", "${KEEP}", "${DROP}", "${MINE}", "${ELSEWHERE}"]}]}`, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('model.fork', () => ({
    value: { isAnswered: true, text: '{"summary": "Porting the billing job.", "topics": [], "project": "App", "nextStep": "", "isDone": false}', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } },
  }))
  on('http.fetch', (_, e) => {
    const r = github(e.init?.method ?? 'GET', e.url, e.init?.body)
    return { value: { status: r.status, ok: r.status < 300, headers: {}, text: r.text } }
  })
  return { repo, toasts, opened }
}

const manifestOf = (repo: Repo) => JSON.parse(repo.files['manifest.json']!) as Manifest
const archiveOf = (repo: Repo, slug: string) => JSON.parse(repo.files[`projects/${slug}.json`]!) as ProjectArchive

const PANE = {
  plugin: 'judge-keep-warm',
  component: 'Pane',
  requestId: 'judgeiverse',
  props: { title: 'Judgeiverse', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const BAND = {
  plugin: 'judge-keep-warm',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 240, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

test('markdown keeps titles visible and the brief is one sentence', async () => {
  expect(mdText('<command-name>/plugin</command-name> **bold**')).toBe('\\<command-name\\>/plugin\\</command-name\\> bold')
  expect(briefOf('Porting the queue tests to the new runner. Two suites left.', 'x')).toBe('Porting the queue tests to the new runner.')
  expect(briefOf('Started with: Fix the queue retries Last answer: Retries are capped.', 'x')).toBe('Fix the queue retries')
  expect(briefOf('No messages yet.', 'The title')).toBe('The title')
  const text = threadsReply([listed(THREADS[0]!)], Date.parse('2023-11-17T20:00:00.000Z'))
  expect(text).toContain('**Judge:** 1 open thread already covers this project.')
  expect(text).toContain('**Keep me** · home on pc · 3 days ago')
  expect(text).toContain('> **Started with:** Fix the queue retries\n>\n> **Last answer:** Retries are capped at five.')
  expect(text).toContain(`\`claude --resume ${KEEP}\``)
})

test('/judge merge folds a thread into another of its project, keeping one line on it', { options: OPTIONS }, async ($, on) => {
  mock.clock(on, { now: START })
  mock.store(on)
  const { repo } = engine(on, repoFiles(THREADS.slice(0, 2)))

  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  const { text } = await $.command.run({ command: 'judge', args: `merge ${KEEP.slice(0, 8)} ${DROP.slice(0, 8)}` })

  expect(text).toContain('**Merged 1 thread** into **Keep me** in *app*.')
  expect(text).toContain('- ~~Fold me~~: Porting the queue tests to the new runner.')
  expect(repo.commits.length).toBe(1)
  expect(repo.commits[0]?.message).toBe('judge: merge 1 thread into Keep me; 1 threads in 1 projects')
  // No model call: the other threads stay where they were.
  expect(repo.modelCalls).toBe(0)
  expect(repo.commits[0]?.deletes).toEqual([`threads/home/${DROP}.json`])
  const archived = archiveOf(repo, 'me-app').threads
  expect(archived.map(a => [a.sessionId, a.reason, a.into, a.by, a.brief])).toEqual([[DROP, 'merged', KEEP, 'work', 'Porting the queue tests to the new runner.']])
  const project = manifestOf(repo).projects[0]!
  expect(project.threads.map(t => t.sessionId)).toEqual([KEEP])
  expect(project.threads[0]?.merged).toEqual([{ sessionId: DROP, title: 'Fold me', brief: 'Porting the queue tests to the new runner.' }])
  expect(project.archived?.map(a => a.sessionId)).toEqual([DROP])
  expect(repo.files['MANIFEST.md']).toContain('<details><summary>1 archived thread</summary>')
  expect(repo.files['MANIFEST.md']).toContain('- **Fold me** (merged into Keep me, ')

  // The merged thread is a tombstone: a later merge naming it finds nothing.
  const again = await $.command.run({ command: 'judge', args: `merge ${KEEP.slice(0, 8)} ${DROP.slice(0, 8)}` })
  expect(again.text).toContain('no thread in the manifest has a session id starting `bbbb2222`')
})

test('/judge delete takes a thread out and its one line stays in the sub-manifest', { options: OPTIONS }, async ($, on) => {
  mock.clock(on, { now: START })
  mock.store(on)
  const { repo } = engine(on, repoFiles(THREADS.slice(0, 2)))

  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  const { text } = await $.command.run({ command: 'judge', args: `delete ${DROP}` })

  expect(text).toContain('**Deleted 1 thread** from *app*.')
  expect(repo.commits[0]?.message).toBe('judge: delete Fold me; 1 threads in 1 projects')
  expect(archiveOf(repo, 'me-app').threads.map(a => [a.reason, a.by])).toEqual([['deleted', 'work']])
  expect(manifestOf(repo).projects[0]?.threads.map(t => t.sessionId)).toEqual([KEEP])

  const short = await $.command.run({ command: 'judge', args: 'delete ab' })
  expect(short.text).toContain('is too short to name a thread')
})

test('a thread whose entry file was deleted from the repository leaves the manifest at session start', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  mock.store(on)
  const { repo, toasts } = engine(on, repoFiles(THREADS.slice(0, 2), [DROP]))

  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await clock.advance(1)

  expect(repo.commits.length).toBe(1)
  expect(repo.commits[0]?.message).toBe('judge: archive 1 deleted thread; 1 threads in 1 projects')
  expect(archiveOf(repo, 'me-app').threads.map(a => [a.sessionId, a.by, a.brief])).toEqual([[DROP, 'entry deleted', 'Porting the queue tests to the new runner.']])
  expect(manifestOf(repo).projects[0]?.threads.map(t => t.sessionId)).toEqual([KEEP])
  expect(toasts.some(t => t.startsWith('Judge: 1 deleted thread taken out of the manifest'))).toBe(true)
})

test('a thread whose session was deleted on this machine leaves the manifest; never in a cloud container', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  mock.store(on)
  // This machine keeps this session's transcript, not MINE's: MINE was deleted here. ELSEWHERE
  // was filed from another host, so its transcript is not this machine's to judge.
  const { repo } = engine(on, repoFiles(THREADS), { local: ['sess-1', 'unrelated'] })

  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await clock.advance(1)

  expect(repo.commits.length).toBe(1)
  expect(archiveOf(repo, 'me-app').threads.map(a => [a.sessionId, a.by, a.brief])).toEqual([[MINE, 'transcript gone', 'Draft the release notes']])
  expect(manifestOf(repo).projects[0]?.threads.map(t => t.sessionId).sort()).toEqual([KEEP, DROP, ELSEWHERE].sort())
  expect(repo.commits[0]?.deletes).toEqual([`threads/work/${MINE}.json`])
})

test('in a cloud container the deletion hook leaves transcripts alone', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  mock.store(on)
  const { repo } = engine(on, repoFiles(THREADS), { local: ['sess-1'], env: { CLAUDE_CODE_REMOTE: 'true' } })

  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  expect(repo.commits.length).toBe(0)
})

test('the deletion hook does nothing when this session is not among the transcripts', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  mock.store(on)
  const { repo } = engine(on, repoFiles(THREADS), { local: ['someone-else'] })

  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  expect(repo.commits.length).toBe(0)
})

test('the pane draws a status card and compact thread rows on every surface, and merges the ones picked', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  mock.store(on)
  const { repo } = engine(on, repoFiles(THREADS.slice(0, 2)))

  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await clock.advance(1)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^Judgeiverse$/ }))?.text).toBe('Judgeiverse')
    expect((await ui.find({ type: 'Text', text: /^v\d/ }))?.text).toBe(`v${RELEASE}`)
    // No cache bar: keeping the cache warm is another mod's job.
    expect(await ui.find({ type: 'Svg' })).toBe(undefined)
    expect((await ui.find({ type: 'Text', text: /open threads? in/ }))?.text).toContain('2 open threads in 1 project · read ')
    expect((await ui.find({ key: 'view-project' }))?.props['label']).toBe('This project · 2')
    expect((await ui.find({ key: `open:${KEEP}` }))?.text).toBe('▸ Keep me')
    // The second line says where the thread stands, not its title again.
    expect((await ui.find({ type: 'Text', text: /^home · Retries/ }))?.text).toBe('home · Retries are capped at five.')
    expect((await ui.find({ type: 'Text', text: /^home · Porting/ }))?.text).toBe('home · Porting the queue tests to the new runner.')
    expect((await ui.find({ type: 'Text', text: new RegExp(`^${PLUGIN_FOOTER}`) }))?.text).toBe(`judge-keep-warm v${RELEASE} · 9.9.9`)
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // A row opens to its summary and its resume command.
  expect(await ui.find({ type: 'Code' })).toBe(undefined)
  await ui.press({ key: `open:${KEEP}` })
  expect((await ui.find({ key: `open:${KEEP}` }))?.text).toBe('▾ Keep me')
  expect((await ui.find({ type: 'Code' }))?.text).toBe(`claude --resume ${KEEP}`)
  expect((await ui.find({ type: 'Markdown' }))?.text).toContain('> **Started with:** Fix the queue retries')

  await ui.press({ key: 'edit:me-app' })
  await ui.press({ key: `pick:${KEEP}` })
  expect(await ui.find({ key: 'merge:me-app' })).toBe(undefined)
  await ui.press({ key: `pick:${DROP}` })
  expect((await ui.find({ key: `pick:${KEEP}` }))?.text).toContain('① Keep me')
  expect((await ui.find({ key: `pick:${DROP}` }))?.text).toContain('② Fold me')
  expect((await ui.find({ key: 'merge:me-app' }))?.props['label']).toBe('Merge 1 into “Keep me”')
  expect((await ui.find({ key: 'delete:me-app' }))?.props['label']).toBe('Delete 2')
  await ui.press({ key: 'merge:me-app' })

  expect(repo.commits.length).toBe(1)
  expect(archiveOf(repo, 'me-app').threads.map(a => [a.sessionId, a.reason, a.into])).toEqual([[DROP, 'merged', KEEP]])
  expect((await ui.find({ type: 'Text', text: /^Merged / }))?.text).toBe('Merged 1 thread into “Keep me”; the one-line summaries are in the project\'s sub-manifest.')
  expect(await ui.find({ key: 'merge:me-app' })).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: /^Merged in:/ }))?.text).toBe('Merged in: Fold me')
  // The archived threads fold away under the project until opened.
  expect(await ui.find({ type: 'Text', text: /^Fold me$/ })).toBe(undefined)
  await ui.press({ key: 'archived:me-app' })
  expect((await ui.find({ type: 'Text', text: /^Fold me$/ }))?.props['strikethrough']).toBe(true)
  expect((await ui.find({ type: 'Text', text: /^merged into Keep me/ }))?.text).toContain('Porting the queue tests to the new runner.')
  await ui.unmount()

  // The band counts the merge as an update to the manifest.
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /^\d+ updates?$/ }))?.text).toBe('1 update')
  expect((await band.find({ type: 'Text', text: /^v\d/ }))?.text).toBe(`v${RELEASE}`)
  expect(await band.find({ key: 'threads' })).toBeDefined()
  await band.unmount()
})

test('/judge pane opens the pane, and a thread merged away is not filed again', { options: OPTIONS }, async ($, on) => {
  mock.clock(on, { now: START })
  mock.store(on)
  const files = repoFiles(THREADS.slice(0, 1))
  const archive: ProjectArchive = {
    schema: 1, name: 'app', slug: 'me-app',
    threads: [{ sessionId: 'sess-1', account: 'work', host: 'mac', title: 'Port the billing job', brief: 'Port the billing job', lastActiveAt: '2023-11-14T20:00:00.000Z', archivedAt: '2023-11-14T21:00:00.000Z', reason: 'merged', into: KEEP, by: 'work' }],
  }
  files['projects/me-app.json'] = JSON.stringify(archive)
  const { repo, opened } = engine(on, files)

  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  const panel = await $.command.run({ command: 'judge', args: 'pane' })
  expect(panel.text).toBe('**Judge:** the Judgeiverse pane is open: the line, then the threads.')
  expect(opened).toEqual(['judgeiverse'])

  const filed = await $.command.run({ command: 'judge', args: 'file' })
  expect(filed.text).toContain('**Not filed:** this thread was merged into “Keep me” on 2023-11-14; it is no longer filed.')
  expect(repo.commits.length).toBe(0)
})

test('a failed filing is tried once per pause, not on every tick', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  mock.store(on)
  const { repo } = engine(on, repoFiles(THREADS.slice(0, 1)))
  repo.failing = true

  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'Port it', turnId: 't1' })
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 0, model: 'opus' }
  await $.turn.complete({ answer: 'Ported.', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer', usage })
  await clock.advance(2 * 60_000 + 15_000)
  const afterFirst = repo.fetches
  expect(afterFirst).toBeGreaterThan(0)
  await clock.advance(2 * 60_000)
  expect(repo.fetches).toBe(afterFirst)

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /^filing failed$/ }))?.text).toBe('filing failed')
  await band.unmount()
})

test('the build is the release, and a commit folder is cut to seven characters', async () => {
  expect(buildOf('806d383b9573', 'judge-keep-warm')).toBe('806d383')
  expect(buildOf('806d383b9573ae96d9b021861d18b7737aec7187', 'judge-keep-warm')).toBe('806d383')
  expect(buildOf('judge-keep-warm', 'judge-keep-warm')).toBe('')
  expect(RELEASE).toMatch(/^\d+\.\d+\.\d+$/)
})

test('on a narrow line the release and the tally stay, the details give way', { options: OPTIONS }, async ($, on) => {
  mock.clock(on, { now: START })
  mock.store(on)
  engine(on, repoFiles(THREADS.slice(0, 2)))

  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'judge', args: `delete ${DROP}` })

  const band = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 100 }, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /^v\d/ }))?.text).toBe(`v${RELEASE}`)
  expect((await band.find({ type: 'Text', text: /^\d+ updates?$/ }))?.text).toBe('1 update')
  expect(await band.find({ key: 'threads' })).toBeDefined()
  await band.unmount()
})

test('Threads lists the threads in the chat where no pane can open', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  mock.store(on)
  const { toasts, opened } = engine(on, repoFiles(THREADS.slice(0, 2)), { noPanes: true })
  // The kit runs a mod's own $.command.run past the mod's hooks, so this hook stands for the
  // engine running /judge: in a session the mod's own /judge hook answers it.
  const runs: string[] = []
  on('command.run', (_, e) => {
    runs.push(`${e.command} ${e.args}`)
    return { text: '' }
  })

  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await clock.advance(1)

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'threads' })
  await band.unmount()

  expect(opened).toContain('judgeiverse')
  expect(toasts).toContain('Judge: no pane can open here, so the threads are listed in the chat.')
  expect(runs).toEqual(['judge threads'])
  expect(toasts.filter(t => t.startsWith('log: '))).toEqual([])
})

test('Threads opens the pane where one can, and runs nothing in the chat', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  mock.store(on)
  const { toasts, opened } = engine(on, repoFiles(THREADS.slice(0, 2)))
  const runs: string[] = []
  on('command.run', (_, e) => {
    runs.push(`${e.command} ${e.args}`)
    return { text: '' }
  })

  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'threads' })
  await band.unmount()

  expect(opened).toEqual(['judgeiverse'])
  expect(runs).toEqual([])
  expect(toasts.some(t => t.includes('no pane can open'))).toBe(false)
})

test('this session\'s own row is marked in the pane', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  mock.store(on)
  const own: Thread = { id: 'sess-1', account: 'work', host: 'mac', title: 'Port the billing job', summary: 'Porting the billing job to the queue. The worker is next.' }
  engine(on, repoFiles([THREADS[0]!, own]))

  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await clock.advance(1)
  // Filed by an earlier process: the line says so, not "not filed yet".
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /^in the manifest$/ }))?.text).toBe('in the manifest')
  await band.unmount()
  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'open:sess-1' }))?.text).toBe('▸ Port the billing job  this thread')
    expect((await ui.find({ type: 'Text', text: /^work · Porting/ }))?.text).toBe('work · Porting the billing job to the queue.')
    await ui.unmount()
  }
})

// ---- Tidying ------------------------------------------------------------------------------------

// Three days after the threads' last activity: none of them is protected by being recent.
const LATER = Date.parse('2023-11-17T20:00:00.000Z')
const TIDY_ANSWER = '```json\n{"merge": [{"keep": "t1", "drop": ["t2"], "reason": "Both work on the queue"}], "archive": [{"id": "t3", "reason": "The release notes are drafted"}]}\n```'

function project(slug: string, threads: Partial<ManifestThread>[]): ManifestProject {
  return {
    name: slug, slug, description: '', repos: [],
    threads: threads.map((t, i) => ({ sessionId: `${slug}-${i}`, account: 'a', host: 'h', title: `T${i}`, summary: 'Some work.', repo: null, cwd: '/x', lastActiveAt: '2023-11-10T00:00:00.000Z', status: 'open', resume: '', ...t })),
  }
}

test('the rules fold same-titled threads into the newest and archive empty, done and stale ones', async () => {
  expect(titleKey('🛞 DFY Hub')).toBe('dfy hub')
  expect(titleKey('DFY HUB')).toBe('dfy hub')
  expect(titleKey('Odoo profile setup (fork)')).toBe('odoo profile setup')
  expect(titleKey('This session is being continued from a previous conversation that ran out')).toBe('')

  const projects = [
    project('hub', [
      { title: 'DFY HUB', lastActiveAt: '2023-11-12T00:00:00.000Z' },
      { title: '🛞 DFY Hub', lastActiveAt: '2023-11-13T00:00:00.000Z' },
      { title: 'This session is being continued from a previous conversation' },
      { title: 'This session is being continued from a previous conversation' },
      { title: 'Old', status: 'stale', lastActiveAt: '2023-10-20T00:00:00.000Z' },
      { title: 'Done', status: 'closed' },
      { title: 'Empty', summary: 'No messages yet.' },
    ]),
    // The same title in another project is other work.
    project('site', [{ title: 'DFY HUB' }]),
  ]
  const refs = tidyRefs(projects)
  const rules = tidyRules(refs, LATER)
  expect(rules.merge).toEqual([{ keep: 't2', drop: ['t1'], reason: 'Same title: “🛞 DFY Hub”' }])
  expect(rules.archive.map(a => [a.id, a.reason])).toEqual([['t5', 'Idle for 28 days'], ['t6', 'The judge marked it done'], ['t7', 'Empty: nothing was said in it']])
})

test('the guards keep protected threads listed, merge within one project, and use each thread once', async () => {
  const projects = [
    project('hub', [
      { lastActiveAt: '2023-11-17T19:00:00.000Z' }, // t1: an hour ago, protected
      {}, // t2
      {}, // t3
      { sessionId: 'self' }, // t4: this session
    ]),
    project('site', [{}]), // t5
  ]
  const refs = tidyRefs(projects)
  const guard = protectedIds(projects, 'self', LATER)
  expect([...guard].sort()).toEqual(['hub-0', 'self'])

  const { proposals, skipped } = guardTidy(
    {
      merge: [
        // The model kept t2, but t1 may be running now: t1 is the one kept.
        { keep: 't2', drop: ['t1', 't5', 'nope'], reason: 'Same work' },
        // t2 is in the step above already.
        { keep: 't3', drop: ['t2'], reason: 'Again' },
      ],
      archive: [{ id: 't4', reason: 'Done' }, { id: 't3', reason: 'Done' }, { id: 't2', reason: 'Done' }],
    },
    refs,
    guard,
  )
  expect(proposals).toEqual([
    { id: 'merge:hub-0', kind: 'merge', keep: 'hub-0', drop: ['hub-1'], reason: 'Same work', project: 'hub' },
    { id: 'archive:hub-2', kind: 'archive', drop: ['hub-2'], reason: 'Done', project: 'hub' },
  ])
  expect(skipped.map(s => [s.ref, s.why.split(':')[0]])).toEqual([
    ['t5', 'in another project (site); threads merge only within one'],
    ['nope', 'no such thread'],
    ['t2', 'already in another step'],
    ['t4', 'protected'],
  ])

  expect(parseTidy('Sure! Here it is.')).toBe(null)
  expect(parseTidy('{"projects": []}')).toBe(null)
  expect(parseTidy(TIDY_ANSWER)?.merge).toEqual([{ keep: 't1', drop: ['t2'], reason: 'Both work on the queue' }])

  // A step whose threads left the manifest since the review drops out; the rest still apply.
  // Only hub-0 is still listed: the merge has nothing left to fold in, the archived thread is gone.
  const now = stillValid(proposals, [project('hub', [{}])])
  expect(now).toEqual({ merges: [], remove: [], dropped: 2 })
  const kept = stillValid(proposals, projects)
  expect(kept).toEqual({ merges: [{ keep: 'hub-0', drop: ['hub-1'] }], remove: ['hub-2'], dropped: 0 })
})

test('/judge tidy reviews the threads through the model, and /judge tidy apply commits every step at once', { options: OPTIONS }, async ($, on) => {
  mock.clock(on, { now: LATER })
  mock.store(on)
  const { repo } = engine(on, repoFiles(THREADS), { tidyAnswer: TIDY_ANSWER })

  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  const review = await $.command.run({ command: 'judge', args: 'tidy' })
  expect(review.text).toContain('**Tidy:** reviewed 4 threads, 2 steps proposed.')
  expect(review.text).toContain('1. **Merge** into **Keep me** · *app*\n   - ~~Fold me~~\n   Both work on the queue')
  expect(review.text).toContain('2. **Archive** **Old thread on this mac** · *app*\n   The release notes are drafted')
  // The model sees short names, never session ids, and the rules' finds as hints.
  expect(repo.tidyPrompts[0]).toContain('"id":"t1","title":"Keep me"')
  expect(repo.tidyPrompts[0]).not.toContain(KEEP)
  expect(repo.commits.length).toBe(0)

  const applied = await $.command.run({ command: 'judge', args: 'tidy apply' })
  expect(applied.text).toContain('**Tidied: merged 1 thread into 1 kept thread, archived 1 thread.')
  expect(applied.text).toContain('The manifest now lists 2 threads in 1 project.')
  expect(repo.commits.length).toBe(1)
  expect(repo.commits[0]?.message).toBe('judge: merge 1 thread into Keep me; delete Old thread on this mac; 2 threads in 1 projects')
  expect(repo.commits[0]?.deletes.sort()).toEqual([`threads/home/${DROP}.json`, `threads/work/${MINE}.json`].sort())
  expect(archiveOf(repo, 'me-app').threads.map(a => [a.sessionId, a.reason, a.into ?? ''])).toEqual([[DROP, 'merged', KEEP], [MINE, 'deleted', '']])
  expect(manifestOf(repo).projects[0]?.threads.map(t => t.sessionId).sort()).toEqual([KEEP, ELSEWHERE].sort())
  // One model call for the review, none for the commit: the other threads stay where they were.
  expect(repo.modelCalls).toBe(1)

  const again = await $.command.run({ command: 'judge', args: 'tidy apply' })
  expect(again.text).toBe('**Tidy:** no review to apply. `/judge tidy` makes one.')
})

test('with no model answer the tidy falls back to the rules, and a numbered step applies alone', { options: OPTIONS }, async ($, on) => {
  mock.clock(on, { now: LATER })
  mock.store(on)
  const twin: Thread = { id: 'eeee5555-0000-4000-8000-000000000005', account: 'home', host: 'pc', title: 'Keep me (fork)', summary: 'Started with: Fix the queue retries' }
  const { repo } = engine(on, repoFiles([...THREADS.slice(0, 2), twin]), { tidyAnswer: null })

  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  const review = await $.command.run({ command: 'judge', args: 'tidy' })
  expect(review.text).toContain("The model gave no answer, so these are the rules' finds alone")
  expect(review.text).toContain('1. **Merge** into **Keep me**')
  expect(review.text).toContain('~~Keep me (fork)~~')

  const bad = await $.command.run({ command: 'judge', args: 'tidy apply 4' })
  expect(bad.text).toBe('**Tidy:** name steps by their numbers, 1 to 1.')
  await $.command.run({ command: 'judge', args: 'tidy apply 1' })
  expect(repo.commits.length).toBe(1)
  expect(archiveOf(repo, 'me-app').threads.map(a => a.sessionId)).toEqual([twin.id])
})

test('the pane reviews on Tidy up, and applies only the steps left ticked', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: LATER })
  mock.store(on)
  const { repo } = engine(on, repoFiles(THREADS), { tidyAnswer: TIDY_ANSWER })

  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await clock.advance(1)

  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'tidy' })).toBeDefined()
    expect(await ui.find({ key: 'tidy-apply' })).toBe(undefined)
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tidy' })
  expect((await ui.find({ type: 'Text', text: /steps? · \d+ threads? reviewed/ }))?.text).toBe('2 steps · 4 threads reviewed')
  expect((await ui.find({ key: `tidy-pick:merge:${KEEP}` }))?.text).toBe('☑ Merge 1 into “Keep me”')
  expect((await ui.find({ key: `tidy-pick:archive:${MINE}` }))?.text).toBe('☑ Archive “Old thread on this mac”')
  expect((await ui.find({ type: 'Text', text: /^app · Both/ }))?.text).toBe('app · Both work on the queue')
  expect((await ui.find({ key: 'tidy-apply' }))?.props['label']).toBe('Apply 2')

  await ui.press({ key: `tidy-pick:archive:${MINE}` })
  expect((await ui.find({ key: `tidy-pick:archive:${MINE}` }))?.text).toBe('☐ Archive “Old thread on this mac”')
  expect((await ui.find({ key: 'tidy-apply' }))?.props['label']).toBe('Apply 1')
  await ui.press({ key: 'tidy-apply' })

  expect(repo.commits.length).toBe(1)
  expect(archiveOf(repo, 'me-app').threads.map(a => [a.sessionId, a.reason])).toEqual([[DROP, 'merged']])
  expect(manifestOf(repo).projects[0]?.threads.map(t => t.sessionId).sort()).toEqual([KEEP, MINE, ELSEWHERE].sort())
  expect((await ui.find({ type: 'Text', text: /^Tidied:/ }))?.text).toBe("Tidied: merged 1 thread into 1 kept thread. One line on each is kept in its project's sub-manifest.")
  expect(await ui.find({ key: 'tidy-apply' })).toBe(undefined)
  await ui.unmount()
})

test('the model lists the threads with list_threads and tidies them with tidy_threads, under the same guards', { options: OPTIONS }, async ($, on) => {
  mock.clock(on, { now: LATER })
  mock.store(on)
  const own: Thread = { id: 'sess-1', account: 'work', host: 'mac', title: 'Port the billing job', summary: 'Porting the billing job.' }
  const twin: Thread = { id: 'eeee5555-0000-4000-8000-000000000005', account: 'home', host: 'pc', title: 'Keep me', summary: 'Started with: Fix the queue retries' }
  const { repo } = engine(on, repoFiles([...THREADS, own, twin]))

  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  const listed = await $.tool.call({ tool: 'mcp__judge-keep-warm__list_threads' })
  const text = String(listed.result)
  expect(text).toContain('6 threads in 1 project. This session is sess-1.')
  expect(text).toContain(`- ${KEEP} · Keep me · open · 3 days ago · home on pc`)
  expect(text).toContain('- sess-1 · Port the billing job · open · 3 days ago · work on mac · protected')
  expect(text).toContain(`- Merge 1 into “Keep me”: keep `)

  const tidied = await $.tool.call({ tool: 'mcp__judge-keep-warm__tidy_threads', merge: [{ keep: KEEP.slice(0, 8), drop: [twin.id.slice(0, 8)] }], archive: ['sess-1', MINE] })
  const done = String(tidied.result)
  expect(done).toContain('Tidied: merged 1 thread into 1 kept thread, archived 1 thread.')
  expect(done).toContain('Left alone:\n- sess-1 (Port the billing job): protected')
  expect(done).toContain('The manifest now lists 4 threads in 1 project.')
  expect(repo.commits.length).toBe(1)
  expect(archiveOf(repo, 'me-app').threads.map(a => a.sessionId).sort()).toEqual([twin.id, MINE].sort())

  const bad = await $.tool.call({ tool: 'mcp__judge-keep-warm__tidy_threads', archive: ['zz'] })
  expect(String(bad.result)).toBe('Nothing changed: `zz` is too short to name a thread: give at least four characters of its session id.')
  expect(repo.commits.length).toBe(1)
})

// ---- Bundling into existing projects ------------------------------------------------------------

function entry(sessionId: string, repo: string | null): ThreadEntry {
  return {
    schema: 1, sessionId, account: 'a', host: 'h', surface: 'terminal', title: sessionId, cwd: '/home/me', repo, model: 'opus', contextTokens: 1, turns: 1,
    startedAt: '2023-11-14T18:00:00.000Z', lastActiveAt: '2023-11-14T20:00:00.000Z', cacheExpiresAt: '', keepWarm: false, status: 'open',
    filedAt: '2023-11-14T20:05:00.000Z', filedBy: 'judge', summary: 'Work.', topics: [], project: '', nextStep: '', resume: '',
  }
}

test("a thread with no repository joins a repository's project by its name, not a second project of that name", async () => {
  const entries = [
    entry('in-repo', 'https://github.com/judgedice/judgeiverse.git'),
    entry('by-name', null),
    entry('by-repo', null),
    entry('elsewhere', null),
    entry('mine', 'https://github.com/me/app'),
    entry('yours', 'https://github.com/you/app'),
    entry('which-app', null),
  ]
  const projects = bundle(
    entries,
    [
      { name: 'Judgeiverse', description: 'The thread manifest.', threadIds: ['by-name'] },
      { name: 'judgedice/judgeiverse', description: '', threadIds: ['by-repo'] },
      { name: 'Notes', description: 'Loose notes.', threadIds: ['elsewhere'] },
      // Two repositories' projects are named "app": the name alone cannot say which, so it starts its own.
      { name: 'app', description: '', threadIds: ['which-app'] },
    ],
    [],
    LATER,
  )
  const ids = (slug: string) => projects.find(p => p.slug === slug)?.threads.map(t => t.sessionId).sort()
  expect(ids('judgedice-judgeiverse')).toEqual(['by-name', 'by-repo', 'in-repo'])
  expect(projects.find(p => p.slug === 'judgedice-judgeiverse')?.name).toBe('judgeiverse')
  expect(projects.filter(p => p.name.toLowerCase() === 'judgeiverse').length).toBe(1)
  expect(ids('notes')).toEqual(['elsewhere'])
  expect(ids('me-app')).toEqual(['mine'])
  expect(ids('you-app')).toEqual(['yours'])
  expect(ids('app')).toEqual(['which-app'])

  // A merge or a deletion re-bundles with no model call: every thread stays where it was.
  const again = bundle(entries, previousAssignment(projects), projects, LATER)
  expect(ids('judgedice-judgeiverse')).toEqual(again.find(p => p.slug === 'judgedice-judgeiverse')?.threads.map(t => t.sessionId).sort())
  // So does a filing whose model gave no answer.
  const unanswered = bundle(entries, [], projects, LATER)
  expect(unanswered.find(p => p.slug === 'judgedice-judgeiverse')?.threads.map(t => t.sessionId).sort()).toEqual(['by-name', 'by-repo', 'in-repo'])
  expect(unanswered.map(p => p.slug).sort()).toEqual(projects.map(p => p.slug).sort())
})
