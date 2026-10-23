// Markdown for the chat and the pane: what `/judge` prints (the command's row draws its text as
// markdown on every surface) and the thread lists the pane draws. Pure: text in, text out.
import type { ArchivedThread, ManifestProject, ManifestThread } from '../types'
import { briefOf, deletedHow } from './judge'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

// Text from a summary or a title, safe inline: one line, emphasis markers dropped, and every
// character markdown would read as syntax escaped. A title like `<command-name>` stays visible.
export function mdText(text: string) {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\*\*|__/g, '')
    .replace(/[\\`*_{}[\]<>#|~]/g, ch => `\\${ch}`)
}

// Inline code that survives a backtick inside it.
export function mdCode(text: string) {
  const fence = text.includes('`') ? '``' : '`'
  return `${fence}${fence.length > 1 ? ' ' : ''}${text}${fence.length > 1 ? ' ' : ''}${fence}`
}

export function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

// How long ago an ISO time was, in words: "just now", "12 min ago", "3 h ago", "yesterday", "4 days ago".
export function ago(iso: string, now: number) {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const ms = Math.max(0, now - at)
  if (ms < MINUTE_MS) return 'just now'
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)} min ago`
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)} h ago`
  if (ms < 2 * DAY_MS) return 'yesterday'
  return `${Math.floor(ms / DAY_MS)} days ago`
}

// The summary as a quote: the local summary's two halves on lines of their own, labelled.
export function summaryQuote(summary: string) {
  const local = /^Started with:\s*([\s\S]*?)(?:\s+Last answer:\s*([\s\S]*))?$/.exec(summary.trim())
  if (local) {
    const lines = [`> **Started with:** ${mdText(local[1] ?? '')}`]
    if (local[2]) lines.push('>', `> **Last answer:** ${mdText(local[2])}`)
    return lines.join('\n')
  }
  return `> ${mdText(summary) || '*No summary yet.*'}`
}

// The line naming a thread: its title, where it runs, and when it was last active.
export function threadHeading(t: ManifestThread, now: number) {
  const parts = [`**${mdText(t.title) || 'Untitled'}**`, `${mdText(t.account)} on ${mdText(t.host)}`]
  const when = ago(t.lastActiveAt, now)
  if (when) parts.push(when)
  if (t.status !== 'open') parts.push(t.status)
  return parts.join(' · ')
}

// One thread in full: heading, summary, the threads merged into it, and its resume command.
export function threadBlock(t: ManifestThread, now: number) {
  const lines = [threadHeading(t, now), '', summaryQuote(t.summary), '']
  if (t.merged?.length) lines.push(`*Merged in:* ${t.merged.map(m => mdText(m.title)).join(', ')}`, '')
  lines.push(mdCode(t.resume))
  return lines.join('\n')
}

// One thread on one line, for the pane's list of every project.
export function threadLine(t: ManifestThread, now: number, isSelf = false) {
  const brief = briefOf(t.summary, t.title)
  const self = isSelf ? ' · *this thread*' : ''
  return `- ${threadHeading(t, now)}${self}: ${mdText(brief)}`
}

// One archived thread on one line: what it was, and where it went.
export function archivedLine(a: ArchivedThread, threads: readonly ManifestThread[]) {
  const target = a.into ? threads.find(t => t.sessionId === a.into)?.title : undefined
  const how = a.reason === 'merged' ? `merged into ${target ? `**${mdText(target)}**` : mdCode(a.into?.slice(0, 8) ?? '?')}` : mdText(deletedHow(a.by))
  return `- ~~${mdText(a.title)}~~ · ${how}, ${a.archivedAt.slice(0, 10)}: ${mdText(a.brief)}`
}

// `/judge threads`: the open threads that cover this project, each in full.
export function threadsReply(related: readonly ManifestThread[], now: number) {
  if (related.length === 0) return '**Judge:** no other open thread in the manifest covers this project (repository or directory).'
  const head = `**Judge:** ${plural(related.length, 'open thread')} already ${related.length === 1 ? 'covers' : 'cover'} this project. Resume one instead of starting another.`
  return [head, ...related.map(t => threadBlock(t, now)), '`/judge panel` shows them beside the chat.'].join('\n\n')
}

// One project for the pane: its threads in full (this project's view) or one line each.
export function projectMarkdown(p: ManifestProject, now: number, selfId: string, isFull: boolean) {
  const lines: string[] = []
  if (p.description) lines.push(`*${mdText(p.description)}*`, '')
  const threads = p.threads.filter(t => t.status !== 'closed')
  if (threads.length === 0) lines.push('*No open thread.*')
  else if (isFull) lines.push(threads.map(t => (t.sessionId === selfId ? `${threadBlock(t, now)} · *this thread*` : threadBlock(t, now))).join('\n\n'))
  else lines.push(...threads.map(t => threadLine(t, now, t.sessionId === selfId)))
  const closed = p.threads.length - threads.length
  if (closed > 0) lines.push('', `*${plural(closed, 'closed thread')} not shown.*`)
  if (p.archived?.length) lines.push('', `**Archived** (${p.archived.length})`, '', ...p.archived.slice(0, 10).map(a => archivedLine(a, p.threads)))
  if ((p.archived?.length ?? 0) > 10) lines.push(`- *and ${p.archived!.length - 10} more in its sub-manifest*`)
  return lines.join('\n')
}
