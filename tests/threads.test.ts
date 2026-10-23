import { expect, mock, test } from 'claude-code/testing'

import { mdText, threadsReply } from '../hooks/format'
import { briefOf, fromBase64, toBase64 } from '../hooks/judge'
import type { Manifest, ManifestThread, ProjectArchive } from '../types'

const OPTIONS = { manifest_repo: 'me/claude-threads', account_label: 'work', github_token: 'ghp_test', file_threads: true }
const START = 1_700_000_000_000

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
type Repo = { files: Record<string, string>; commits: Commit[]; modelCalls: number; fetches: number; failing: boolean }

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

type Extra = { env?: Record<string, string>; local?: string[]; version?: string; sessionId?: string }
const PROJECTS_DIR = '/home/me/.claude/projects'

// Stands for the engine beneath the mod. `local` lists the session ids whose transcripts this
// machine keeps under PROJECTS_DIR; without it there is no such folder.
function engine(on: Parameters<Parameters<typeof test>[1]>[1], files: Record<string, string>, extra: Extra = {}) {
  const repo: Repo = { files, commits: [], modelCalls: 0, fetches: 0, failing: false }
  const github = fakeGithub(repo)
  const toasts: string[] = []
  const opened: string[] = []
  mock.env(on, { HOSTNAME: 'mac.local', USER: 'me', ...(extra.local ? { HOME: '/home/me' } : {}), ...(extra.env ?? {}) })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
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
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
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
  on('model.complete', () => {
    repo.modelCalls++
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
  props: { title: 'Judgeiverse keep warm', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
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

test('the pane lists the threads on every surface, and merges the ones picked', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  mock.store(on)
  const { repo } = engine(on, repoFiles(THREADS.slice(0, 2)))

  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await clock.advance(1)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^Judgeiverse$/ }))?.text).toBe('Judgeiverse')
    expect((await ui.find({ type: 'Text', text: /^judge-keep-warm / }))?.text).toBe('judge-keep-warm v9.9.9')
    expect((await ui.find({ type: 'Text', text: /open threads? ·/ }))?.text).toContain('2 open threads · 1 project · read ')
    expect((await ui.find({ key: 'view-project' }))?.props['label']).toBe('This project (2)')
    const list = await ui.find({ type: 'Markdown' })
    expect(list?.text).toContain('**Keep me** · home on pc')
    expect(list?.text).toContain('> Porting the queue tests to the new runner. Two suites left.')
    expect(await ui.find({ key: 'edit:me-app' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'edit:me-app' })
  await ui.press({ key: `pick:${KEEP}` })
  expect(await ui.find({ key: 'merge:me-app' })).toBe(undefined)
  await ui.press({ key: `pick:${DROP}` })
  expect((await ui.find({ key: `pick:${KEEP}` }))?.text).toContain('[1] Keep me')
  expect((await ui.find({ key: 'merge:me-app' }))?.props['label']).toBe('Merge 1 into “Keep me”')
  expect((await ui.find({ key: 'delete:me-app' }))?.props['label']).toBe('Delete 2')
  await ui.press({ key: 'merge:me-app' })

  expect(repo.commits.length).toBe(1)
  expect(archiveOf(repo, 'me-app').threads.map(a => [a.sessionId, a.reason, a.into])).toEqual([[DROP, 'merged', KEEP]])
  expect((await ui.find({ type: 'Text', text: /^Merged / }))?.text).toBe('Merged 1 thread into “Keep me”; the one-line summaries are in the project\'s sub-manifest.')
  expect(await ui.find({ key: 'merge:me-app' })).toBe(undefined)
  const list = await ui.find({ type: 'Markdown' })
  expect(list?.text).toContain('*Merged in:* Fold me')
  expect(list?.text).toContain('**Archived** (1)')
  await ui.unmount()

  // The band counts the merge as an update to the manifest.
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /^\d+ updates?$/ }))?.text).toBe('1 update')
  expect((await band.find({ type: 'Text', text: /^v\d/ }))?.text).toBe('v9.9.9')
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

test('a failed filing is tried once per cache expiry, not on every tick', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  mock.store(on)
  const { repo } = engine(on, repoFiles(THREADS.slice(0, 1)))
  repo.failing = true

  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  // Reopened 50 minutes after its last answer: about 7 minutes of a 1-hour cache are left.
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 50 * 60, context_tokens: 120_000 })
  await clock.advance(4 * 60_000)
  const afterFirst = repo.fetches
  expect(afterFirst).toBeGreaterThan(0)
  await clock.advance(2 * 60_000)
  expect(repo.fetches).toBe(afterFirst)

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /^filing failed$/ }))?.text).toBe('filing failed')
  await band.unmount()
})
