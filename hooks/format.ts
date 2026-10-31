// Markdown for the chat and the pane: what `/judge` prints (the command's row draws its text as
// markdown on every surface) and the thread lists the pane draws. Pure: text in, text out.
import type { ManifestThread, TidyPlan, TidyProposal } from '../types'

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

// `/judge threads`: the open threads that cover this project, each in full.
export function threadsReply(related: readonly ManifestThread[], now: number) {
  if (related.length === 0) return '**Judge:** no other open thread in the manifest covers this project (repository or directory).'
  const head = `**Judge:** ${plural(related.length, 'open thread')} already ${related.length === 1 ? 'covers' : 'cover'} this project. Resume one instead of starting another.`
  return [head, ...related.map(t => threadBlock(t, now)), '`/judge panel` shows them beside the chat.'].join('\n\n')
}

// ---- Tidying ---------------------------------------------------------------------------------

// A tidy step as one line of plain text: "Merge 2 into “Title”" or "Archive “Title”".
export function proposalLabel(p: TidyProposal, titleOf: (id: string) => string) {
  return p.kind === 'merge' ? `Merge ${p.drop.length} into “${titleOf(p.keep ?? '')}”` : `Archive “${titleOf(p.drop[0] ?? '')}”`
}

// `/judge tidy`: the review's steps, numbered for `/judge tidy apply <n>…`.
export function tidyReply(plan: TidyPlan, titleOf: (id: string) => string) {
  const by = plan.by === 'model' ? '' : ' The model gave no answer, so these are the rules\' finds alone (same titles, empty, done, idle).'
  if (plan.proposals.length === 0) return `**Tidy:** reviewed ${plural(plan.reviewed, 'thread')}; none looks like a duplicate, finished or abandoned.`
  const lines = [`**Tidy:** reviewed ${plural(plan.reviewed, 'thread')}, ${plural(plan.proposals.length, 'step')} proposed.${by}`, '']
  plan.proposals.forEach((p, i) => {
    const head = p.kind === 'merge' ? `**Merge** into **${mdText(titleOf(p.keep ?? ''))}**` : `**Archive** **${mdText(titleOf(p.drop[0] ?? ''))}**`
    lines.push(`${i + 1}. ${head} · *${mdText(p.project)}*`)
    if (p.kind === 'merge') for (const id of p.drop) lines.push(`   - ~~${mdText(titleOf(id))}~~`)
    lines.push(`   ${mdText(p.reason)}`)
  })
  lines.push('', '`/judge tidy apply` applies every step; `/judge tidy apply 1 3` applies those alone. The pane\'s **Tidy up** lets you untick steps.')
  return lines.join('\n')
}

// What a tidy did, in one line for the pane and the chat.
export function tidyDone(merged: number, groups: number, archived: number, dropped: number) {
  const parts: string[] = []
  if (merged) parts.push(`merged ${plural(merged, 'thread')} into ${plural(groups, 'kept thread')}`)
  if (archived) parts.push(`archived ${plural(archived, 'thread')}`)
  const gone = dropped ? ` ${plural(dropped, 'step')} left out: ${dropped === 1 ? 'its threads' : 'their threads'} changed since the review.` : ''
  return `Tidied: ${parts.join(', ') || 'nothing changed'}. One line on each is kept in its project's sub-manifest.${gone}`
}

// ---- The pane's rows: plain text, no markdown -------------------------------------------------

// Text from a summary with markdown's marks taken out: emphasis, code ticks, link syntax.
export function plainText(text: string) {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// How long ago, in a few characters for the right edge of a row: "now", "12m", "3h", "4d".
export function shortAgo(iso: string, now: number) {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const ms = Math.max(0, now - at)
  if (ms < MINUTE_MS) return 'now'
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)}m`
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)}h`
  return `${Math.floor(ms / DAY_MS)}d`
}

// A thread's second line: where it stands, not its title again. The local summary's last answer
// when it has one (its first prompt is the title already), else the judge's first sentence.
export function threadSubtitle(t: ManifestThread) {
  const text = t.summary.trim()
  if (!text || text === 'No messages yet.') return 'No messages yet'
  const local = /^Started with:\s*([\s\S]*?)(?:\s+Last answer:\s*([\s\S]*))?$/.exec(text)
  if (local) return plainText(local[2] || local[1] || t.title)
  const plain = plainText(text)
  return /^[\s\S]*?[.!?](?=\s|$)/.exec(plain)?.[0] ?? plain
}

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'

// The mark of a picked thread in the pane's edit mode: its place in the picks, circled.
export function pickMark(index: number) {
  if (index < 0) return '○'
  return [...CIRCLED][index] ?? `(${index + 1})`
}
