// Tidying the manifest: which threads to merge (they continue the same work) and which to archive
// (finished, abandoned, empty), so fewer stay open. Pure, like judge.ts: the rules' finds, the
// model's question and its answer held to the guards. The hooks module asks and applies.
import type { ManifestProject, ManifestThread, TidyPlan, TidyProposal } from '../types'

import { DAY_MS } from './judge'

/** A thread active this recently may be running in another session now: it is never folded away or archived. */
export const RECENT_MS = 6 * 60 * 60_000
const REASON_MAX = 140
const SUMMARY_SHOWN = 360

// A first prompt that says nothing about the work: the compacted session's opening line.
const CONTINUED = /^this session is being continued from a previous conversation/i

function clip(text: string, max: number) {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** One listed thread with the short name (`t1`, `t2`, …) the model's question gives it. */
export type TidyRef = { ref: string; thread: ManifestThread; project: ManifestProject }

/** Every thread the manifest lists, named `t1`… in its order: the model copies a short name, never a session id. */
export function tidyRefs(projects: readonly ManifestProject[]): TidyRef[] {
  const out: TidyRef[] = []
  for (const project of projects) for (const thread of project.threads) out.push({ ref: `t${out.length + 1}`, thread, project })
  return out
}

/** The threads a tidy leaves listed whatever it is told: this session's, and any active within RECENT_MS. */
export function protectedIds(projects: readonly ManifestProject[], selfId: string, now: number) {
  const ids = new Set<string>([selfId])
  for (const p of projects) for (const t of p.threads) if (now - (Date.parse(t.lastActiveAt) || 0) < RECENT_MS) ids.add(t.sessionId)
  return ids
}

/** A title as the rules compare it: lowercase letters and digits, "(fork)" and emoji dropped; '' for one that names nothing. */
export function titleKey(title: string) {
  if (CONTINUED.test(title.trim())) return ''
  return title.toLowerCase().replace(/\(fork\)/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function idleDays(t: ManifestThread, now: number) {
  return Math.floor((now - (Date.parse(t.lastActiveAt) || 0)) / DAY_MS)
}

function isEmpty(t: ManifestThread) {
  const s = t.summary.trim()
  return s === '' || s === 'No messages yet.'
}

/** What a review answers, by short name: merge groups and threads to archive, each with its reason. */
export type RawTidy = {
  merge: { keep: string; drop: string[]; reason: string }[]
  archive: { id: string; reason: string }[]
}

/**
 * The rules' finds, with no model: threads of one project under the same title fold into the
 * newest; empty, done and stale threads go. A hint for the model, and the plan when it gives no answer.
 */
export function tidyRules(refs: readonly TidyRef[], now: number): RawTidy {
  const groups = new Map<string, TidyRef[]>()
  for (const r of refs) {
    const key = titleKey(r.thread.title)
    if (!key) continue
    const k = `${r.project.slug}\n${key}`
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  const merge: RawTidy['merge'] = []
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const [keep, ...drop] = [...group].sort((a, b) => b.thread.lastActiveAt.localeCompare(a.thread.lastActiveAt))
    merge.push({ keep: keep!.ref, drop: drop.map(r => r.ref), reason: `Same title: “${clip(keep!.thread.title, 60)}”` })
  }
  const archive: RawTidy['archive'] = []
  for (const r of refs) {
    const t = r.thread
    if (isEmpty(t)) archive.push({ id: r.ref, reason: 'Empty: nothing was said in it' })
    else if (t.status === 'closed') archive.push({ id: r.ref, reason: 'The judge marked it done' })
    else if (t.status === 'stale') archive.push({ id: r.ref, reason: `Idle for ${idleDays(t, now)} days` })
  }
  return { merge, archive }
}

/** The model's one question: every listed thread by project, the rules' finds, and which threads are protected. */
export function tidyPrompt(refs: readonly TidyRef[], hints: RawTidy, guard: ReadonlySet<string>, now: number) {
  const system = [
    "You tidy a person's list of Claude Code conversation threads, filed by project, so fewer stay open. They resume threads from this list, so every thread left open should be one worth resuming.",
    'Propose two kinds of step:',
    '- merge: threads of one project that continue the same piece of work (the same feature, bug, task or question; a fork or a continuation of another) fold into one. Keep the one most worth resuming: usually the most recent, or the one whose summary says the most.',
    '- archive: a thread whose work is finished, abandoned, superseded by another thread, empty, or a one-off question already answered leaves the list. One line on it is kept.',
    'Rules:',
    '- Use only the short names given (t1, t2, …). A thread appears in at most one step. Merge only within one project.',
    '- Never fold away or archive a thread marked protected: it may be running now. It may be the one a merge keeps.',
    "- A title that is a worktree or session name (like 'elastic-chaplygin-fa6f7d'), a project name, or 'This session is being continued…' says nothing: go by the summary.",
    '- Threads with the same title are not always the same work, and different titles can be. The summaries decide.',
    '- When unsure, leave the thread alone: a wrong merge or archive costs more than one more open thread.',
    '- Each step has a reason of one short line the person can check at a glance.',
    'Answer with one JSON object and nothing else: {"merge": [{"keep": "t1", "drop": ["t2"], "reason": "..."}], "archive": [{"id": "t3", "reason": "..."}]}',
  ].join('\n')
  const byProject = new Map<string, { project: string; description: string; threads: unknown[] }>()
  for (const r of refs) {
    const t = r.thread
    let p = byProject.get(r.project.slug)
    if (!p) {
      p = { project: r.project.name, description: r.project.description, threads: [] }
      byProject.set(r.project.slug, p)
    }
    p.threads.push({
      id: r.ref,
      title: t.title,
      summary: clip(t.summary, SUMMARY_SHOWN),
      status: t.status,
      idleDays: idleDays(t, now),
      account: t.account,
      ...(t.merged?.length ? { mergedIn: t.merged.map(m => m.title) } : {}),
      ...(guard.has(t.sessionId) ? { protected: true } : {}),
    })
  }
  const prompt = [
    'Threads, by project:',
    JSON.stringify([...byProject.values()]),
    '',
    'What simple rules found (same titles, empty, done, idle over two weeks). Check each against the summaries; drop the wrong ones and add what they missed:',
    JSON.stringify(hints),
  ].join('\n')
  return { system, prompt }
}

/** The model's answer, checked for shape; null when it is not the object asked for. */
export function parseTidy(text: string): RawTidy | null {
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
  if (!Array.isArray(o['merge']) && !Array.isArray(o['archive'])) return null
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const merge: RawTidy['merge'] = []
  for (const m of Array.isArray(o['merge']) ? o['merge'] : []) {
    if (!m || typeof m !== 'object') continue
    const g = m as Record<string, unknown>
    const drop = Array.isArray(g['drop']) ? g['drop'].map(str).filter(Boolean) : []
    if (str(g['keep']) && drop.length) merge.push({ keep: str(g['keep']), drop, reason: str(g['reason']) })
  }
  const archive: RawTidy['archive'] = []
  for (const a of Array.isArray(o['archive']) ? o['archive'] : []) {
    if (!a || typeof a !== 'object') continue
    const g = a as Record<string, unknown>
    if (str(g['id'])) archive.push({ id: str(g['id']), reason: str(g['reason']) })
  }
  return { merge, archive }
}

/** A step the guards turned down, and why, for the tool's answer. */
export type TidySkip = { ref: string; why: string }

/**
 * A review's answer as proposals over session ids, held to the guards: known names only, each
 * thread in one step, a merge within its kept thread's project, and a protected thread never
 * folded away or archived (in a merge it becomes the one kept). What they turned down is listed.
 */
export function guardTidy(raw: RawTidy, refs: readonly TidyRef[], guard: ReadonlySet<string>): { proposals: TidyProposal[]; skipped: TidySkip[] } {
  const byRef = new Map(refs.map(r => [r.ref, r]))
  const used = new Set<string>()
  const proposals: TidyProposal[] = []
  const skipped: TidySkip[] = []
  const skip = (ref: string, why: string) => {
    if (!skipped.some(s => s.ref === ref)) skipped.push({ ref, why })
  }
  for (const m of raw.merge) {
    const names = [...new Set([m.keep, ...m.drop])]
    const home = byRef.get(m.keep)?.project ?? byRef.get(names.find(n => byRef.has(n)) ?? '')?.project
    if (!home) continue
    const members: TidyRef[] = []
    for (const name of names) {
      const r = byRef.get(name)
      if (!r) skip(name, 'no such thread')
      else if (used.has(r.thread.sessionId)) skip(name, 'already in another step')
      else if (r.project.slug !== home.slug) skip(name, `in another project (${r.project.name}); threads merge only within one`)
      else members.push(r)
    }
    if (members.length < 2) continue
    const newest = (a: TidyRef, b: TidyRef) => b.thread.lastActiveAt.localeCompare(a.thread.lastActiveAt)
    const guarded = members.filter(r => guard.has(r.thread.sessionId)).sort(newest)
    const stated = members.find(r => r.ref === m.keep)
    const keep = guarded.length ? (guarded.find(r => r === stated) ?? guarded[0]!) : (stated ?? [...members].sort(newest)[0]!)
    const drop = members.filter(r => r !== keep && !guard.has(r.thread.sessionId))
    for (const r of guarded) if (r !== keep) skip(r.ref, 'protected: this session, or active in the last 6 hours')
    if (drop.length === 0) continue
    used.add(keep.thread.sessionId)
    for (const r of drop) used.add(r.thread.sessionId)
    proposals.push({
      id: `merge:${keep.thread.sessionId}`,
      kind: 'merge',
      keep: keep.thread.sessionId,
      drop: drop.map(r => r.thread.sessionId),
      reason: clip(m.reason || 'The same work', REASON_MAX),
      project: home.name,
    })
  }
  for (const a of raw.archive) {
    const r = byRef.get(a.id)
    if (!r) skip(a.id, 'no such thread')
    else if (guard.has(r.thread.sessionId)) skip(a.id, 'protected: this session, or active in the last 6 hours')
    else if (used.has(r.thread.sessionId)) continue
    else {
      used.add(r.thread.sessionId)
      proposals.push({ id: `archive:${r.thread.sessionId}`, kind: 'archive', drop: [r.thread.sessionId], reason: clip(a.reason || 'Done or abandoned', REASON_MAX), project: r.project.name })
    }
  }
  return { proposals, skipped }
}

/** The plan's proposals still to apply: every one the person did not untick. */
export function pickedProposals(plan: TidyPlan, off: readonly string[]) {
  return plan.proposals.filter(p => !off.includes(p.id))
}

/**
 * The proposals that still hold against the manifest as it reads now: a thread another machine
 * merged or archived since the review drops out, and so does a merge whose threads a filing has
 * bundled into different projects meanwhile. Returns the changes for one commit, and how many were dropped.
 */
export function stillValid(proposals: readonly TidyProposal[], projects: readonly ManifestProject[]) {
  const projectOfId = new Map<string, string>()
  for (const p of projects) for (const t of p.threads) projectOfId.set(t.sessionId, p.slug)
  const merges: { keep: string; drop: string[] }[] = []
  const remove: string[] = []
  let dropped = 0
  for (const p of proposals) {
    if (p.kind === 'merge') {
      const home = p.keep ? projectOfId.get(p.keep) : undefined
      const drop = p.drop.filter(id => home !== undefined && projectOfId.get(id) === home)
      if (!p.keep || home === undefined || drop.length === 0) dropped++
      else merges.push({ keep: p.keep, drop })
    } else {
      const id = p.drop[0]
      if (id && projectOfId.has(id)) remove.push(id)
      else dropped++
    }
  }
  return { merges, remove, dropped }
}
