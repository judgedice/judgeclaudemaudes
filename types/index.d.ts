/** What the judge (a fork of the conversation) says about this thread; the local fallback fills `summary` alone. */
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
  /** Always '' from 0.8.0 on, which keeps no cache warm; kept for the readers of older builds. */
  cacheExpiresAt: string
  /** Always false from 0.8.0 on; kept for the readers of older builds. */
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

/** One step a tidy review proposes: fold `drop` into `keep`, or archive the one thread in `drop`. */
export type TidyProposal = {
  /** Stable within a plan: `merge:<keep>` or `archive:<session id>`. */
  id: string
  kind: 'merge' | 'archive'
  /** The thread kept; a merge's only. */
  keep?: string
  /** The threads folded into `keep` (merge), or the one taken out (archive). */
  drop: string[]
  /** Why, in one line the person can check at a glance. */
  reason: string
  /** The project's name, as the manifest lists it. */
  project: string
}

/** A tidy review of the manifest's threads: what to merge and what to archive. */
export type TidyPlan = {
  /** When it was made (ms since epoch). */
  at: number
  /** `model`: the judge model reviewed the threads. `rules`: it gave no answer, so the plan is the rules' finds alone. */
  by: 'model' | 'rules'
  /** How many listed threads the review looked at. */
  reviewed: number
  proposals: TidyProposal[]
}

declare module 'claude-code' {
  interface PluginState {
    'judge-keep-warm': {
      /** The clock as the line last showed it, moved on once a minute. */
      now: number
      /** When this thread is due to be filed (ms since epoch), the conversation having paused after a real turn; 0 = nothing due. */
      fileDueAt: number
      /** True while this process files a thread into the manifest. */
      filingNow: boolean
      /** The judge's last verdict on this thread; null before the first. */
      verdict: JudgeVerdict | null
      /** The last filing of this thread into the manifest; null before the first. */
      filing: JudgeFiling | null
      /** Open threads of this session's project, from the manifest, read at start. */
      related: ManifestThread[]
      /** When the conversation last had a real turn (ms since epoch); 0 = unknown. */
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
      /** The thread whose row the pane shows open (summary, resume command); null = none. */
      paneOpenThread: string | null
      /** The project whose archived threads the pane shows; null = none. */
      paneOpenArchive: string | null
      /** The last tidy review, until it is applied or dismissed; null = none. */
      tidyPlan: TidyPlan | null
      /** The ids of the tidy plan's proposals the person unticked; the rest apply. */
      tidyOff: string[]
    }
  }
}
