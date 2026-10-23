/**
 * What the mod remembers per session id in `$.store`, so a relaunch keeps it. `ttl` is the cache
 * length in effect when it was saved; `savedAt` when it was saved, which ages the entry for the
 * weekly clean-up. Inherited from Cache Keep-Warm.
 */
export type KeepWarmSaved = { lastRequestAt: number; keepWarm: boolean; stopAt: number; ttl?: KeepWarmTtl; savedAt?: number }

/** One keep-warm ping: when it started, whether the cache still held the conversation, how much it read. */
export type KeepWarmPing = { at: number; isHit: boolean; read: number }

/**
 * How long the main conversation's cache lives, and why: from a setting, from the plan, or
 * corrected by what the cache actually did. Null until it can be told.
 */
export type KeepWarmTtl = { ms: number; reason: 'subscription' | 'api' | 'overage' | 'setting' | 'observed' } | null

/** What the judge (the ping's reply) says about this thread; the local fallback fills `summary` alone. */
export type JudgeVerdict = {
  summary: string
  topics: string[]
  project: string
  nextStep: string
  isDone: boolean
}

/** Whether a thread is still in play. The judge action marks `stale` by age; `closed` comes from the session's end or the judge's `isDone`. */
export type ThreadStatus = 'open' | 'closed'

/**
 * One thread's entry in the manifest repository, at `threads/<account>/<session id>.json`.
 * The judge action reads every entry and bundles them into projects in `manifest.json`.
 */
export type ThreadEntry = {
  schema: 1
  sessionId: string
  account: string
  host: string
  surface: string
  title: string
  cwd: string
  repo: string | null
  model: string
  contextTokens: number
  turns: number
  startedAt: string
  lastActiveAt: string
  cacheExpiresAt: string
  keepWarm: boolean
  status: ThreadStatus
  filedAt: string
  filedBy: 'judge' | 'local' | 'end'
  summary: string
  topics: string[]
  project: string
  nextStep: string
  resume: string
}

/** A thread folded into another one, as the survivor lists it in `manifest.json`. */
export type MergedThread = { sessionId: string; title: string; brief: string }

/** One thread as `manifest.json` lists it under a project (what the judge action writes). */
export type ManifestThread = {
  sessionId: string
  account: string
  host: string
  title: string
  summary: string
  repo: string | null
  cwd: string
  lastActiveAt: string
  status: ThreadStatus | 'stale'
  resume: string
  /** The threads merged into this one, newest first; absent when none. */
  merged?: MergedThread[]
}

/**
 * A thread taken out of the manifest, kept as one line in its project's sub-manifest
 * (`projects/<slug>.json`). Its session id stays a tombstone: a later filing of it is not listed.
 */
export type ArchivedThread = {
  sessionId: string
  account: string
  host: string
  title: string
  /** One sentence: what the thread was, kept after it left the manifest. */
  brief: string
  lastActiveAt: string
  archivedAt: string
  /** `merged`: folded into `into`. `deleted`: its session was deleted, or `/judge delete` removed it. */
  reason: 'merged' | 'deleted'
  /** The thread it was merged into; merged only. */
  into?: string
  /** What took it out: an account label, or `transcript gone` for the deletion hook. */
  by: string
}

/** `projects/<slug>.json`: one project's sub-manifest, the threads taken out of it. */
export type ProjectArchive = {
  schema: 1
  name: string
  slug: string
  threads: ArchivedThread[]
}

/** One project of `manifest.json`: a bundle of like threads, named by the judge action. */
export type ManifestProject = {
  name: string
  slug: string
  description: string
  repos: string[]
  threads: ManifestThread[]
  /** Its sub-manifest's threads, newest first; absent when none. */
  archived?: ArchivedThread[]
}

/** `manifest.json` as the judge action writes it. */
export type Manifest = {
  schema: 1
  generatedAt: string
  projects: ManifestProject[]
}

/** What the last filing came to, for the line and `/judge`. */
export type JudgeFiling = { at: number; ok: boolean; path: string; error: string; by: ThreadEntry['filedBy'] }

/** Which threads the pane lists: this project's, or every project's. */
export type PaneView = 'project' | 'all'

/** The pane's edit mode on one project: the threads picked, in the order picked (the first is kept on a merge). */
export type PaneEdit = { slug: string; picked: string[] } | null

declare module 'claude-code' {
  interface PluginState {
    'judge-keep-warm': {
      /** When the main conversation's last model request started (ms since epoch); 0 = unknown. */
      lastRequestAt: number
      /** Whether this session keeps its cache warm. */
      keepWarm: boolean
      /** When keep-warm switches itself off (ms since epoch); 0 = after the ping limit. */
      stopAt: number
      /** The clock as the band last showed it. */
      now: number
      /** Pings since keep-warm was last switched on, oldest first. */
      pings: KeepWarmPing[]
      /** The cache lifetime as last worked out. */
      ttl: KeepWarmTtl
      /** Tokens the last request sent: what a cold cache would make the next message re-write. */
      contextTokens: number
      /** True while Claude waits on an answer to its question. */
      isWaiting: boolean
      /** True once this process has seen a main-thread response. Reset by /clear. */
      sawResponse: boolean
      /** The idle gap after which the cache was found cold although it should have lasted; 0 = none seen. */
      shortAfterMs: number
      /** True when the invisible ping found nothing to repeat, so the visible one is used, until the next request. */
      waitsForMessage: boolean
      /** True once this process has restored the session's saved values from the store. */
      restored: boolean
      /** Why the last ping did not reach the model; '' = none. */
      pingError: string
      /** True while the conversation fills too much of the context window for a visible ping. */
      nearlyFull: boolean
      /** The judge's last verdict on this thread; null before the first. */
      verdict: JudgeVerdict | null
      /** The last filing of this thread into the manifest; null before the first. */
      filing: JudgeFiling | null
      /** The cache expiry (ms) the thread was last filed for; 0 = not yet. A new expiry files again. */
      filedForExpiry: number
      /** Open threads of this session's project, from the manifest, read at start. */
      related: ManifestThread[]
      /** When the conversation last had a real turn (ms since epoch), pings left out; 0 = unknown. */
      lastActiveAt: number
      /** The thread's title as the line shows it: the app's session title, else the first prompt's first line; '' = unknown. */
      title: string
      /** Threads the manifest held when this session last read or wrote it; 0 = not known yet. */
      manifestThreads: number
      /** Projects the manifest held when this session last read or wrote it; 0 = not known yet. */
      manifestProjects: number
      /** Commits this session made to the manifest: filings, merges, deletions, deleted threads taken out. */
      updates: number
      /** When this session last updated the manifest (ms since epoch); 0 = not yet. */
      updatedAt: number
      /** Until when (ms since epoch) the line shows the last update's or failure's outcome lit; 0 = not lit. */
      flashUntil: number
      /** True when what the line shows lit is a failed filing, not an update. */
      flashFailed: boolean
      /** The manifest as last read or written by this session; null before the first read. */
      manifest: Manifest | null
      /** When the manifest was last read or written (ms since epoch); 0 = not yet. */
      manifestReadAt: number
      /** Why the last read of the manifest failed; '' = it did not. */
      manifestError: string
      /** Which threads the pane lists. */
      paneView: PaneView
      /** The project the pane edits (merge or delete), and the threads picked; null = not editing. */
      paneEdit: PaneEdit
      /** The pane's last action and how it went, shown under its buttons; '' = none. */
      paneNotice: string
      /** True while the pane's action (refresh, merge, delete) runs. */
      isBusy: boolean
      /** This thread's own record when a merge or a deletion took it out of the manifest; null = listed. */
      selfArchived: ArchivedThread | null
    }
  }
}
