// Pure helpers of the judge layer: nothing here touches `$` (the engine only lets `$` into
// functions declared in the hooks module itself). Text, JSON and paths alone.
import type { JudgeVerdict, Manifest, ManifestProject, ManifestThread, ThreadEntry } from '../types'

export const THREADS_DIR = 'threads'
export const MANIFEST_FILE = 'manifest.json'
export const SUMMARY_MAX = 600
export const TITLE_MAX = 80
export const TOPICS_MAX = 8

// The ping's one question. The fork reads the whole conversation from cache (which is what keeps
// it warm) and answers with the verdict the manifest entry is built from.
export const JUDGE_PROMPT = [
  'Judge Keep Warm ping. Use no tools. Answer with one JSON object on one line and nothing else:',
  '{"summary": "<2-3 sentences: what this thread is about and where it stands>",',
  ' "topics": ["<3-6 short lowercase tags>"],',
  ' "project": "<a short, stable name for the project or body of work this thread belongs to>",',
  ' "nextStep": "<the next concrete step, one line; empty if none>",',
  ' "isDone": <true only if the work of this thread is finished and nothing is pending>}',
].join('\n')

function clip(text: string, max: number) {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

// A user row that is a slash command or a hook's notice, not something the person wrote: the
// transcript wraps those in tags. Such a row names no thread.
const MACHINE_ROW = /^\s*<(command-name|command-message|local-command-stdout|local-command-caveat|system-reminder|task-notification)\b/

function isPersonText(text: string) {
  return text.trim() !== '' && !MACHINE_ROW.test(text)
}

// Text with any remaining tags and their bodies dropped: what the person typed.
function plainText(text: string) {
  return text.replace(/<(system-reminder|task-notification)>[\s\S]*?<\/\1>/g, '').replace(/<\/?[a-z][\w-]*(?:\s[^>]*)?>/g, '')
}

// The fork's reply: the first `{` to the last `}` parsed as JSON, each field checked. Null when
// the model answered something else, so the local summary is used instead.
export function parseVerdict(text: string): JudgeVerdict | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o['summary'] !== 'string' || !o['summary'].trim()) return null
  const topics = Array.isArray(o['topics'])
    ? o['topics'].filter((t): t is string => typeof t === 'string' && t.trim() !== '').map(t => clip(t.toLowerCase(), 32)).slice(0, TOPICS_MAX)
    : []
  return {
    summary: clip(o['summary'], SUMMARY_MAX),
    topics,
    project: typeof o['project'] === 'string' ? clip(o['project'], 64) : '',
    nextStep: typeof o['nextStep'] === 'string' ? clip(o['nextStep'], 200) : '',
    isDone: o['isDone'] === true,
  }
}

// With no judge (keep-warm off, or the fork unavailable), the entry carries what the transcript
// itself says: the first prompt and the last answer, clipped. Costs nothing.
export function localVerdict(messages: readonly { role: 'user' | 'assistant'; text: string }[]): JudgeVerdict {
  const first = plainText(messages.find(m => m.role === 'user' && isPersonText(m.text))?.text ?? '')
  const last = plainText([...messages].reverse().find(m => m.role === 'assistant' && m.text.trim() !== '')?.text ?? '')
  const parts = []
  if (first) parts.push(`Started with: ${clip(first, 240)}`)
  if (last) parts.push(`Last answer: ${clip(last, 240)}`)
  return { summary: parts.join(' ') || 'No messages yet.', topics: [], project: '', nextStep: '', isDone: false }
}

// A title when the surface gives none: the first prompt's first line.
export function titleFrom(messages: readonly { role: 'user' | 'assistant'; text: string }[], cwd: string) {
  const first = plainText(messages.find(m => m.role === 'user' && isPersonText(m.text))?.text ?? '')
  const line = first.split('\n').find(l => l.trim() !== '') ?? ''
  if (line.trim()) return clip(line, TITLE_MAX)
  const base = cwd.split(/[\\/]/).filter(Boolean).pop()
  return base ?? 'untitled'
}

// What of the account label or a session id may be a path segment: letters, digits, dot, dash, underscore.
export function pathSegment(text: string) {
  const safe = text.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return safe || 'unknown'
}

export function threadPath(account: string, sessionId: string) {
  return `${THREADS_DIR}/${pathSegment(account)}/${pathSegment(sessionId)}.json`
}

// "owner/repo", a github.com URL with or without .git: the API's "owner/repo"; '' when not one.
export function parseRepo(text: string) {
  const t = text.trim().replace(/\.git$/, '').replace(/\/+$/, '')
  const m = /^(?:https?:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(t)
  return m ? `${m[1]}/${m[2]}` : ''
}

// Two remotes of one repository, however spelled (https, ssh, with or without .git), compare equal.
export function sameRepo(a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b) return false
  const norm = (u: string) =>
    u
      .trim()
      .replace(/^git@([^:]+):/, 'https://$1/')
      .replace(/^ssh:\/\/git@/, 'https://')
      .replace(/\.git$/, '')
      .replace(/\/+$/, '')
      .toLowerCase()
  return norm(a) === norm(b)
}

// UTF-8 text as the Contents API wants it (base64), and back.
export function toBase64(text: string) {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

export function fromBase64(b64: string) {
  const bin = atob(b64.replace(/\s/g, ''))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

// Reads a manifest.json the action wrote; null for anything else.
export function parseManifest(text: string): Manifest | null {
  try {
    const m = JSON.parse(text) as Manifest
    if (!m || m.schema !== 1 || !Array.isArray(m.projects)) return null
    return m
  } catch {
    return null
  }
}

// The manifest's open threads that share this session's repository or directory, this session
// itself left out: what to resume instead of starting another.
export function relatedThreads(manifest: Manifest, sessionId: string, repo: string | null, cwd: string): ManifestThread[] {
  const out: ManifestThread[] = []
  for (const project of manifest.projects) {
    for (const t of project.threads) {
      if (t.sessionId === sessionId || t.status === 'closed') continue
      if (sameRepo(t.repo, repo) || (cwd !== '' && t.cwd === cwd)) out.push(t)
    }
  }
  return out.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
}

export function entryJson(entry: ThreadEntry) {
  return `${JSON.stringify(entry, null, 2)}\n`
}

// The entry's one-line description for a toast or the command.
export function describeThread(t: ManifestThread) {
  const when = t.lastActiveAt.slice(0, 16).replace('T', ' ')
  return `${t.title} (${t.account} on ${t.host}, ${when}${t.status === 'stale' ? ', stale' : ''})`
}

// ---- Bundling threads into projects ------------------------------------------------------------

export const DAY_MS = 24 * 60 * 60_000
export const STALE_DAYS = 14
export const CLOSED_DAYS = 30

/** What the model answers when asked to bundle: a project per group, each naming its thread ids. */
export type Assignment = { name: string; description: string; threadIds: string[] }[]

export function slugify(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'project'
}

// "owner/name" of a GitHub remote, else the remote as given without .git; null for none.
export function repoName(repo: string | null | undefined) {
  if (!repo) return null
  const m = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(repo)
  return m ? m[1]! : repo.replace(/\.git$/, '')
}

export function statusOf(t: ThreadEntry, now: number): ManifestThread['status'] {
  if (t.status === 'closed') return 'closed'
  const last = Date.parse(t.lastActiveAt) || 0
  return now - last > STALE_DAYS * DAY_MS ? 'stale' : 'open'
}

// One entry per session id: the newest filing wins.
export function latestEntries(entries: readonly ThreadEntry[]) {
  const byId = new Map<string, ThreadEntry>()
  for (const t of entries) {
    const have = byId.get(t.sessionId)
    if (!have || t.filedAt > have.filedAt) byId.set(t.sessionId, t)
  }
  return [...byId.values()]
}

// The threads the manifest lists: every live one, and closed ones for a while after.
export function keptEntries(entries: readonly ThreadEntry[], now: number) {
  return latestEntries(entries).filter(t => statusOf(t, now) !== 'closed' || now - (Date.parse(t.lastActiveAt) || 0) <= CLOSED_DAYS * DAY_MS)
}

// The model's one question: the live threads and the projects the manifest already has.
export function bundlePrompt(live: readonly ThreadEntry[], previous: readonly ManifestProject[]) {
  const existing = previous.map(p => ({ name: p.name, description: p.description, repos: p.repos }))
  const rows = live.map(t => ({
    id: t.sessionId,
    account: t.account,
    title: t.title,
    summary: t.summary,
    topics: t.topics,
    projectHint: t.project,
    repo: repoName(t.repo),
    cwd: t.cwd,
    lastActiveAt: t.lastActiveAt,
  }))
  const system = [
    'You bundle Claude Code conversation threads into projects so their owner can see, per body of work, which threads are open and resume one instead of starting another.',
    'Rules:',
    '- Every thread id appears in exactly one project. Invent no ids.',
    '- Threads about the same repository, product, client or piece of work belong together, across accounts and machines.',
    "- Keep an existing project's exact name when its threads still fit it; rename or split only when the threads clearly ask for it. New projects get short, stable names (2-5 words), no dates.",
    "- A project's description is one sentence on what the work is.",
    '- Prefer fewer, meaningful projects over many thin ones, but do not merge unrelated work.',
    'Answer with one JSON object and nothing else: {"projects": [{"name": "...", "description": "...", "threadIds": ["..."]}]}',
  ].join('\n')
  const prompt = ['Existing projects (keep their names where they still fit):', JSON.stringify(existing), '', 'Threads to bundle:', JSON.stringify(rows)].join('\n')
  return { system, prompt }
}

// The model's answer, checked; null when it is not the shape asked for.
export function parseAssignment(text: string): Assignment | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  const projects = (raw as { projects?: unknown })?.projects
  if (!Array.isArray(projects)) return null
  const out: Assignment = []
  for (const p of projects) {
    if (!p || typeof p !== 'object') continue
    const o = p as Record<string, unknown>
    if (typeof o['name'] !== 'string' || !o['name'].trim() || !Array.isArray(o['threadIds'])) continue
    out.push({
      name: o['name'].trim(),
      description: typeof o['description'] === 'string' ? o['description'].trim() : '',
      threadIds: o['threadIds'].filter((id): id is string => typeof id === 'string'),
    })
  }
  return out
}

// With no model answer, or for a thread the answer left out: a project per repository (or per
// directory where there is none), named after it.
function fallbackProject(t: ThreadEntry) {
  const repo = repoName(t.repo)
  if (repo) return { name: repo.split('/').pop()!, description: `Threads in ${repo}` }
  if (t.project) return { name: t.project, description: '' }
  const base = t.cwd.split(/[\\/]/).filter(Boolean).pop() ?? 'misc'
  return { name: base, description: `Threads in ${t.cwd || 'no directory'}` }
}

export function bundle(entries: readonly ThreadEntry[], assigned: Assignment, previous: readonly ManifestProject[], now: number): ManifestProject[] {
  const byId = new Map(entries.map(t => [t.sessionId, t]))
  const projects = new Map<string, { name: string; slug: string; description: string; repos: Set<string>; threads: ManifestThread[] }>()
  const place = (name: string, description: string, t: ThreadEntry) => {
    const slug = slugify(name)
    let p = projects.get(slug)
    if (!p) {
      p = { name, slug, description, repos: new Set(), threads: [] }
      projects.set(slug, p)
    }
    if (!p.description && description) p.description = description
    const repo = repoName(t.repo)
    if (repo) p.repos.add(repo)
    p.threads.push({
      sessionId: t.sessionId,
      account: t.account,
      host: t.host,
      title: t.title,
      summary: t.summary,
      repo: t.repo,
      cwd: t.cwd,
      lastActiveAt: t.lastActiveAt,
      status: statusOf(t, now),
      resume: t.resume,
    })
  }
  const seen = new Set<string>()
  for (const a of assigned) {
    for (const id of a.threadIds) {
      const t = byId.get(id)
      if (!t || seen.has(id)) continue
      seen.add(id)
      place(a.name, a.description, t)
    }
  }
  // Closed threads keep the project the last manifest had them in; anything the model left
  // out, and everything when there was no answer, goes by repository.
  const previousProject = new Map<string, ManifestProject>()
  for (const p of previous) for (const t of p.threads) previousProject.set(t.sessionId, p)
  for (const t of entries) {
    if (seen.has(t.sessionId)) continue
    const prior = previousProject.get(t.sessionId)
    const f = prior ? { name: prior.name, description: prior.description } : fallbackProject(t)
    place(f.name, f.description, t)
  }
  const out = [...projects.values()].map(p => ({
    name: p.name,
    slug: p.slug,
    description: p.description,
    repos: [...p.repos].sort(),
    threads: p.threads.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt)),
  }))
  const latest = (p: ManifestProject) => p.threads[0]?.lastActiveAt ?? ''
  return out.sort((a, b) => latest(b).localeCompare(latest(a)))
}

export function renderMarkdown(manifest: Manifest) {
  const lines = [
    '# Open threads',
    '',
    `Written by Judge Keep Warm at ${manifest.generatedAt}. One section per project; resume a thread with its command on the machine and account it names.`,
    '',
  ]
  const count = (p: ManifestProject, s: ManifestThread['status']) => p.threads.filter(t => t.status === s).length
  for (const p of manifest.projects) {
    const open = count(p, 'open')
    const stale = count(p, 'stale')
    lines.push(`## ${p.name}`, '')
    if (p.description) lines.push(p.description, '')
    if (p.repos.length) lines.push(`Repositories: ${p.repos.map(r => `\`${r}\``).join(', ')}`, '')
    if (open > 1) lines.push(`> ${open} open threads here. Resume one before opening another.`, '')
    else if (open === 0 && stale > 0) lines.push(`> Nothing active; ${stale} stale thread${stale === 1 ? '' : 's'} left.`, '')
    lines.push('| Status | Account · host | Thread | Last active | Resume |', '| --- | --- | --- | --- | --- |')
    for (const t of p.threads) {
      const when = t.lastActiveAt.slice(0, 16).replace('T', ' ')
      const title = t.title.replace(/\|/g, '\\|')
      const summary = t.summary.replace(/\|/g, '\\|').replace(/\s+/g, ' ')
      lines.push(`| ${t.status} | ${t.account} · ${t.host} | **${title}**<br>${summary} | ${when} | \`${t.resume}\` |`)
    }
    lines.push('')
  }
  if (manifest.projects.length === 0) lines.push('No threads filed yet.', '')
  return lines.join('\n')
}

export function manifestJson(manifest: Manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

// Reads a thread entry a session filed; null for anything else.
export function parseEntry(text: string): ThreadEntry | null {
  try {
    const t = JSON.parse(text) as ThreadEntry
    return t && t.schema === 1 && typeof t.sessionId === 'string' && typeof t.filedAt === 'string' ? t : null
  } catch {
    return null
  }
}
