import { expect, mock, test } from 'claude-code/testing'

import { localVerdict, parseRepo, parseVerdict, relatedThreads, sameRepo, threadPath, titleFrom, toBase64, fromBase64 } from '../hooks/judge'
import type { Manifest } from '../types'

const OPTIONS = { manifest_repo: 'me/claude-threads', account_label: 'work', github_token: 'ghp_test', file_threads: true }

const BAND = {
  plugin: 'judge-keep-warm',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

test('the judge reply parses into a verdict, and anything else does not', async () => {
  const v = parseVerdict('Sure. {"summary": "Porting the billing job.", "topics": ["Billing", "cron"], "project": "Billing", "nextStep": "run it", "isDone": false} done')
  expect(v?.summary).toBe('Porting the billing job.')
  expect(v?.topics).toEqual(['billing', 'cron'])
  expect(v?.isDone).toBe(false)
  expect(parseVerdict('ok')).toBe(null)
  expect(parseVerdict('{"topics": []}')).toBe(null)
})

test('the local verdict and title come from the transcript', async () => {
  const messages = [
    { role: 'user' as const, text: 'Fix the login bug\nplease' },
    { role: 'assistant' as const, text: 'Done: the token check was inverted.' },
  ]
  expect(localVerdict(messages).summary).toBe('Started with: Fix the login bug please Last answer: Done: the token check was inverted.')
  expect(titleFrom(messages, '/home/me/app')).toBe('Fix the login bug')
  expect(titleFrom([], '/home/me/app')).toBe('app')
  // A slash command's row is not the person's words: the title falls through to the directory.
  const command = [{ role: 'user' as const, text: '<command-name>/plugin</command-name> <command-message>plugin</command-message> <command-args>configure x</command-args>' }]
  expect(titleFrom(command, '/home/me/app')).toBe('app')
  expect(localVerdict(command).summary).toBe('No messages yet.')
  expect(titleFrom([...command, { role: 'user' as const, text: 'Now <b>fix</b> it' }], '/x')).toBe('Now fix it')
})

test('paths, repositories and base64 round-trip', async () => {
  expect(threadPath('work@my mac', 'abc-123')).toBe('threads/work-my-mac/abc-123.json')
  expect(parseRepo('https://github.com/me/claude-threads.git')).toBe('me/claude-threads')
  expect(parseRepo('me/claude-threads')).toBe('me/claude-threads')
  expect(parseRepo('not a repo at all')).toBe('')
  expect(sameRepo('git@github.com:me/app.git', 'https://github.com/me/app')).toBe(true)
  expect(fromBase64(toBase64('héllo ✓'))).toBe('héllo ✓')
})

test('related threads share the repository or directory, this session left out', async () => {
  const manifest: Manifest = {
    schema: 1,
    generatedAt: '2026-10-23T00:00:00.000Z',
    projects: [
      {
        name: 'App',
        slug: 'app',
        description: '',
        repos: ['me/app'],
        threads: [
          { sessionId: 's1', account: 'work', host: 'mac', title: 'A', summary: '', repo: 'git@github.com:me/app.git', cwd: '/x', lastActiveAt: '2026-10-22T10:00:00.000Z', status: 'open', resume: 'claude --resume s1' },
          { sessionId: 'me', account: 'work', host: 'mac', title: 'Me', summary: '', repo: 'https://github.com/me/app', cwd: '/x', lastActiveAt: '2026-10-23T10:00:00.000Z', status: 'open', resume: 'claude --resume me' },
          { sessionId: 's3', account: 'home', host: 'pc', title: 'C', summary: '', repo: null, cwd: '/home/me/app', lastActiveAt: '2026-10-21T10:00:00.000Z', status: 'closed', resume: 'claude --resume s3' },
        ],
      },
    ],
  }
  const related = relatedThreads(manifest, 'me', 'https://github.com/me/app.git', '/home/me/app')
  expect(related.map(r => r.sessionId)).toEqual(['s1'])
})

test('the line draws on every surface with the judge part', { options: OPTIONS }, async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  mock.store(on)
  mock.env(on, { HOSTNAME: 'mac', USER: 'me' })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 1_700_000_000_000, context: { tokens: 1000, window: 200_000 }, rateLimits: [], cost: {} } }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.repo', () => ({ value: null }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('settings.read', () => ({ value: {} }))
  on('tool.call', () => ({ result: {}, isError: true, text: 'no such tool' }))
  // No manifest in the repository yet: the start-of-session read finds nothing.
  on('http.fetch', () => ({ value: { status: 404, ok: false, headers: {}, text: '{"message":"Not Found"}' } }))

  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const row = await ui.find({ type: 'Text', text: /nothing cached yet/ })
    expect(row?.text).toBe('nothing cached yet')
    // The line's name leads it, on every surface.
    const label = await ui.find({ type: 'Text', text: /Judgeiverse/ })
    expect(label?.text).toBe('Judgeiverse')
    // Nothing filed and no manifest read yet: no counter, no flash.
    expect(await ui.find({ type: 'Text', text: /filed|manifest updated/ })).toBe(undefined)
    await ui.unmount()
  }
})

const MESSAGES = [
  { role: 'user' as const, text: 'Port the billing job to the queue', toolUses: [] },
  { role: 'assistant' as const, text: 'The worker is written; the migration is next.', toolUses: [] },
]

// Stands for the engine beneath the mod, with a small GitHub in memory: one branch, a tree of
// files, blobs by sha. Records every commit's files.
type Repo = { files: Record<string, string>; commits: { message: string; files: Record<string, string> }[]; modelCalls: number }

function fakeGithub(repo: Repo) {
  const blobs = new Map<string, string>()
  const shaOf = (text: string) => `sha-${text.length}-${[...text].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7)}`
  let head = 'c0'
  const trees = new Map<string, Record<string, string>>()
  const treeSha = () => {
    const sha = `t-${head}`
    trees.set(sha, { ...repo.files })
    return sha
  }
  const pending = { blobs: new Map<string, string>(), tree: null as null | Record<string, string>, commit: '' }
  return (method: string, url: string, body?: string) => {
    const path = url.replace('https://api.github.com/repos/me/claude-threads', '')
    const json = body ? (JSON.parse(body) as Record<string, unknown>) : {}
    if (method === 'GET' && path === '') return { status: 200, text: '{"default_branch":"main"}' }
    if (method === 'GET' && path === '/git/ref/heads/main') return { status: 200, text: JSON.stringify({ object: { sha: head } }) }
    if (method === 'GET' && path === `/git/commits/${head}`) return { status: 200, text: JSON.stringify({ tree: { sha: treeSha() } }) }
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
      const files: Record<string, string> = {}
      for (const e of json['tree'] as { path: string; sha: string }[]) files[e.path] = pending.blobs.get(e.sha) ?? ''
      pending.tree = files
      return { status: 201, text: '{"sha":"new-tree"}' }
    }
    if (method === 'POST' && path === '/git/commits') {
      pending.commit = String(json['message'])
      return { status: 201, text: '{"sha":"c1"}' }
    }
    if (method === 'PATCH' && path === '/git/refs/heads/main') {
      Object.assign(repo.files, pending.tree)
      repo.commits.push({ message: pending.commit, files: pending.tree ?? {} })
      head = 'c1'
      return { status: 200, text: '{}' }
    }
    return { status: 500, text: `{"message":"unexpected ${method} ${path}"}` }
  }
}

function engine(on: Parameters<Parameters<typeof test>[1]>[1], startedAt: number, repo: Repo) {
  const github = fakeGithub(repo)
  mock.env(on, { HOSTNAME: 'mac.local', USER: 'me' })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt, context: { tokens: 120_000, window: 1_000_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 10 }], cost: {} } }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.repo', () => ({ value: { root: '/work/app', remote: 'git@github.com:me/app.git', internal: false, name: null } }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('session.model', () => ({ value: 'opus' }))
  on('session.turns', () => ({ value: 3 }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('settings.read', () => ({ value: {} }))
  on('tool.call', () => ({ result: {}, isError: true, text: 'no such tool' }))
  on('classic.SessionStart', () => ({}))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no surface places panes' } }))
  on('model.complete', () => {
    repo.modelCalls++
    return {
      value: {
        isAnswered: true,
        text: '{"projects": [{"name": "App billing", "description": "The billing job and its queue.", "threadIds": ["sess-1", "s-other"]}]}',
        usage: { input_tokens: 500, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('http.fetch', (_, e) => {
    const r = github(e.init?.method ?? 'GET', e.url, e.init?.body)
    return { value: { status: r.status, ok: r.status < 300, headers: {}, text: r.text } }
  })
  return repo
}

function filedEntries(repo: Repo) {
  return repo.commits.map(c => {
    const path = Object.keys(c.files).find(p => p.startsWith('threads/'))!
    return { path, entry: JSON.parse(c.files[path]!) as { filedBy: string; status: string; account: string; host: string; title: string; summary: string; resume: string; project: string; topics: string[] }, manifest: JSON.parse(c.files['manifest.json']!) as { projects: { name: string; threads: { sessionId: string }[] }[] }, md: c.files['MANIFEST.md']! }
  })
}

const OTHER_THREAD = JSON.stringify({
  schema: 1, sessionId: 's-other', account: 'home', host: 'pc', surface: 'terminal', title: 'Queue tests', cwd: '/h/app', repo: 'https://github.com/me/app', model: 'opus', contextTokens: 1, turns: 1,
  startedAt: '2023-11-13T00:00:00.000Z', lastActiveAt: '2023-11-14T00:00:00.000Z', cacheExpiresAt: '', keepWarm: false, status: 'open', filedAt: '2023-11-14T00:05:00.000Z', filedBy: 'local',
  summary: 'Started with: tests', topics: [], project: '', nextStep: '', resume: 'claude --resume s-other',
})

test('with keep-warm off, the thread is filed locally when 5 minutes of the cache are left', { options: OPTIONS }, async ($, on) => {
  const start = 1_700_000_000_000
  const clock = mock.clock(on, { now: start })
  mock.store(on)
  const repo = engine(on, start, { files: { 'README.md': 'hi', 'threads/home/s-other.json': OTHER_THREAD }, commits: [], modelCalls: 0 })

  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  // The session was reopened 50 minutes after its last answer: the cache has ~7 minutes left.
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 50 * 60, context_tokens: 120_000 })
  await clock.advance(60_000)
  expect(repo.commits.length).toBe(0)

  // Three minutes on: inside the last 5 minutes, so the thread is filed, once, with the manifest
  // bundled over it and the thread another machine filed.
  await clock.advance(3 * 60_000)
  const filed = filedEntries(repo)
  expect(filed.length).toBe(1)
  expect(filed[0]?.path).toBe('threads/work/sess-1.json')
  expect(filed[0]?.entry.filedBy).toBe('local')
  expect(repo.modelCalls).toBe(1)
  expect(filed[0]?.manifest.projects.map(p => p.name)).toEqual(['App billing'])
  expect(filed[0]?.manifest.projects[0]?.threads.map(t => t.sessionId)).toEqual(['sess-1', 's-other'])
  expect(filed[0]?.md).toContain('> 2 open threads here. Resume one before opening another.')
  expect(repo.commits[0]?.message).toBe('judge: file Port the billing job to the queue (work); 2 threads in 1 projects')
  expect(filed[0]?.entry.status).toBe('open')
  expect(filed[0]?.entry.account).toBe('work')
  expect(filed[0]?.entry.host).toBe('mac')
  expect(filed[0]?.entry.title).toBe('Port the billing job to the queue')
  expect(filed[0]?.entry.summary).toBe('Started with: Port the billing job to the queue Last answer: The worker is written; the migration is next.')
  expect(filed[0]?.entry.resume).toBe('claude --resume sess-1')

  await clock.advance(5 * 60_000)
  expect(repo.commits.length).toBe(1)
})

test('/judge file asks the fork for a verdict and files it', { options: OPTIONS }, async ($, on) => {
  const start = 1_700_000_000_000
  mock.clock(on, { now: start })
  mock.store(on)
  const repo = engine(on, start, { files: { 'README.md': 'hi' }, commits: [], modelCalls: 0 })
  let prompt = ''
  on('model.fork', (_, e) => {
    prompt = e.prompt
    return {
      value: {
        isAnswered: true,
        text: '{"summary": "Porting the billing job to the queue; the worker is done.", "topics": ["billing"], "project": "App billing", "nextStep": "run the migration", "isDone": false}',
        usage: { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 120_000, cache_creation_input_tokens: 0 },
      },
    }
  })

  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  const { text } = await $.command.run({ command: 'judge', args: 'file' })

  expect(prompt.startsWith('Judge Keep Warm ping.')).toBe(true)
  expect(text).toContain('thread filed at threads/work/sess-1.json')
  const filed = filedEntries(repo)
  expect(filed.length).toBe(1)
  expect(filed[0]?.entry.filedBy).toBe('judge')
  expect(filed[0]?.entry.project).toBe('App billing')
  expect(filed[0]?.entry.topics).toEqual(['billing'])
})

function hhmm(ms: number) {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

test('a filing lights the line with the manifest update, then the counter stays', { options: OPTIONS }, async ($, on) => {
  const start = 1_700_000_000_000
  const clock = mock.clock(on, { now: start })
  mock.store(on)
  const repo = engine(on, start, { files: { 'README.md': 'hi', 'threads/home/s-other.json': OTHER_THREAD }, commits: [], modelCalls: 0 })
  on('model.fork', () => ({
    value: {
      isAnswered: true,
      text: '{"summary": "Porting the billing job to the queue.", "topics": ["billing"], "project": "App billing", "nextStep": "run the migration", "isDone": false}',
      usage: { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 120_000, cache_creation_input_tokens: 0 },
    },
  }))

  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'judge', args: 'file' })
  expect(repo.commits.length).toBe(1)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /Judgeiverse/ }))?.text).toBe('Judgeiverse')
    expect((await ui.find({ type: 'Text', text: /manifest updated/ }))?.text).toBe(`✓ manifest updated ${hhmm(start)}`)
    expect((await ui.find({ type: 'Text', text: /^\d+ threads?$/ }))?.text).toBe('2 threads')
    expect((await ui.find({ type: 'Text', text: /^\d+ projects?$/ }))?.text).toBe('1 project')
    expect((await ui.find({ type: 'Text', text: /^\d+ filed$/ }))?.text).toBe('1 filed')
    // While lit, the dim "filed HH:MM" part gives way to the flash.
    expect(await ui.find({ type: 'Text', text: /^filed / })).toBe(undefined)
    await ui.unmount()
  }

  // Past the flash, the line goes back to dim: the flash is gone, the counter stays.
  await clock.advance(8_001)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /manifest updated/ })).toBe(undefined)
    expect((await ui.find({ type: 'Text', text: /^filed / }))?.text).toBe(`filed ${hhmm(start)}`)
    expect((await ui.find({ type: 'Text', text: /^\d+ filed$/ }))?.text).toBe('1 filed')
    expect((await ui.find({ type: 'Text', text: /^\d+ threads?$/ }))?.text).toBe('2 threads')
    await ui.unmount()
  }

  // A second filing counts on, and lights the line again.
  await $.command.run({ command: 'judge', args: 'file' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^\d+ filed$/ }))?.text).toBe('2 filed')
  expect((await ui.find({ type: 'Text', text: /manifest updated/ }))?.text).toBe(`✓ manifest updated ${hhmm(clock.now())}`)
  await clock.advance(8_001)
  expect(await ui.find({ type: 'Text', text: /manifest updated/ })).toBe(undefined)
  await ui.unmount()
})

test('a failed filing lights the line red for a moment', { options: { ...OPTIONS, github_token: '' } }, async ($, on) => {
  const start = 1_700_000_000_000
  const clock = mock.clock(on, { now: start })
  mock.store(on)
  const repo = engine(on, start, { files: { 'README.md': 'hi' }, commits: [], modelCalls: 0 })
  // No token anywhere: no option, no variable, no gh.
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'gh: not found' } }))
  on('model.fork', () => ({
    value: { isAnswered: true, text: '{"summary": "Billing.", "topics": [], "project": "", "nextStep": "", "isDone": false}', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }))

  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'judge', args: 'file' })
  expect(repo.commits.length).toBe(0)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /✗/ }))?.text).toBe('✗ filing failed')
  expect(await ui.find({ type: 'Text', text: /^\d+ filed$/ })).toBe(undefined)
  await clock.advance(8_001)
  expect(await ui.find({ type: 'Text', text: /✗/ })).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: /^filing failed$/ }))?.text).toBe('filing failed')
  await ui.unmount()
})

const PANE = {
  plugin: 'judge-keep-warm',
  component: 'Pane',
  requestId: 'judgeiverse',
  props: { title: 'Judgeiverse keep warm', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('the pane draws the same line in rows, on every surface', { options: OPTIONS }, async ($, on) => {
  const start = 1_700_000_000_000
  mock.clock(on, { now: start })
  mock.store(on)
  engine(on, start, { files: { 'README.md': 'hi' }, commits: [], modelCalls: 0 })
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Judgeiverse/ }))?.text).toBe('Judgeiverse')
    expect((await ui.find({ type: 'Text', text: /nothing cached yet/ }))?.text).toBe('nothing cached yet')
    expect((await ui.find({ type: 'Button', text: /File now/ }))?.text).toBe('File now')
    await ui.unmount()
  }
})

test('the pane opens only where nothing has drawn the band', { options: OPTIONS }, async ($, on) => {
  const start = 1_700_000_000_000
  const clock = mock.clock(on, { now: start })
  mock.store(on)
  engine(on, start, { files: { 'README.md': 'hi' }, commits: [], modelCalls: 0 })
  const opened: string[] = []
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })

  // A session whose surface draws the band: the band is asked for before the decision falls.
  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.unmount()
  await clock.advance(7000)
  expect(opened).toEqual([])
})

test('a session with no band gets the pane after a moment', { options: OPTIONS }, async ($, on) => {
  const start = 1_700_000_000_000
  const clock = mock.clock(on, { now: start })
  mock.store(on)
  engine(on, start, { files: { 'README.md': 'hi' }, commits: [], modelCalls: 0 })
  const opened: string[] = []
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })

  await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  expect(opened).toEqual([])
  await clock.advance(2000)
  expect(opened).toEqual(['judgeiverse'])
})
