# Judgeiverse

A Claude Code mod that files each thread into a GitHub manifest, so you can clear a session once it goes cold and pick its thread up again from any machine. Two minutes after each turn, once the conversation has paused, it judges the thread and files it. Before pushing, it bundles every thread there, from every account and machine, into projects through your own Claude Code connection, so you resume an open thread instead of opening another. No action, no API key.

It doesn't keep the prompt cache warm: pair it with a mod that does, such as cache-tax, when you want a thread kept warm. Its plugin id is still `judge-keep-warm`, so existing installs keep updating.

It began as a fork of [Cache Keep-Warm](https://github.com/andreichiritescu/claude-code-cache-keep-warm) (MIT). Release 0.8.0 took out the keep-warm engine, the countdown and `/keepwarm`; the judge layer and the line's layout remain.

## What it does

- **Filing after each turn.** With a manifest repository set, two minutes after a turn, once no other turn has started, a fork of the conversation answers one question: what the thread is about, where it stands, its topics, its project, the next step, and whether it is done. The reply is written to `threads/<account>/<session id>.json` in the repository. The fork reads the conversation from the cache the turn just wrote, so the judgment costs a cache read and a few hundred output tokens. Two minutes leaves the filing time to finish in a cloud container, which stops about five minutes after the last turn.
- **Clearing.** A `/clear` within those two minutes files the thread it ends a few seconds later, with a free local summary (the first prompt and the last answer) and the project and topics the judge gave it last.
- **Bundling, done by the mod.** Before it pushes, the mod reads every thread the other accounts and machines filed and bundles them into projects: one project per git repository, named after it; threads with no repository are bundled by likeness through your own Claude Code connection (no API key), keeping the project names the manifest already has. Then it commits the thread entry together with `manifest.json` and `MANIFEST.md` in one commit. What lands in the repository is already classified. Threads go stale after 14 days; closed ones drop out after 30. Each row of `MANIFEST.md` carries the thread's `claude --resume` command.
- **At session start,** the mod reads `manifest.json` and tells you which open threads already cover the repository or directory you are in. The line shows `N related threads`; `/judge threads` lists them with their resume commands.
- **The Judgeiverse pane.** A status card (the release, the thread's title, where it stands in the manifest, and **File now**), then the threads: this project's or every project's (**This project**, **All**). Each thread is one compact row, its title and age, then its account and where it stands; a press opens its summary, where it ran, and its resume command, ready to copy. Each project has **Merge / delete**: pick the thread to keep first, then the ones to fold into it, and press **Merge**; or pick threads and press **Delete**. Its archived threads fold away under it. **Refresh** reads the manifest again. `/judge pane`, or **Threads** on the line, opens it; in a cloud session it opens by itself.
- **Replies in the chat.** `/judge`, `/judge threads`, `/judge file` and the merge and delete commands answer in markdown: each thread as a bold title with where and when it ran, its summary as a quote, and its resume command as code.
- **Merging.** Threads merge within one project. The ones folded in leave the manifest; the one kept lists them as merged in.
- **Tidying.** When the list has grown, **Tidy up** in the pane (or `/judge tidy`) reviews every listed thread at once and proposes steps: merge threads that continue the same work, and archive threads that are finished, abandoned, empty or idle. Simple rules flag same-titled threads in one project and empty, done or stale ones; the judge model then checks those against the summaries, drops the wrong ones and adds what the rules missed. Each step shows its reason; untick any you disagree with and press **Apply**, and every step left ticked goes in one commit. This session's thread, and any thread active in the last 6 hours (it may be running in another session), is never merged away or archived: in a merge it is the thread kept. When 5 or more other open threads cover this project, the start-of-session notice points at `/judge tidy`.
- **Tools for Claude.** The mod gives Claude two tools, `list_threads` and `tidy_threads`, so you can ask in plain words ("clean up my threads", "merge the DFY Hub threads"). Claude reads the manifest with `list_threads`, judges which threads continue the same work or are done, shows you the steps, and on your go-ahead applies them with `tidy_threads`, under the same guards as **Tidy up**. Your permission rules apply to `tidy_threads` as to any other tool, so in the default permission mode Claude Code asks before it runs.
- **Deleting, and the deletion hook.** A thread leaves the manifest when you delete it (`/judge delete` or the pane), when its session is deleted on the machine that filed it (its transcript is gone from `~/.claude/projects`), or when its entry file is deleted from the manifest repository. Either way it keeps one line, its title and a one-sentence brief, in its project's sub-manifest, `projects/<slug>.json`, and is never listed again. The mod checks at session start and at every filing; it never judges transcripts in a cloud container, where they do not persist.

## Reading the line

The line above the prompt reads, left to right:

- **`Judgeiverse`**, in cyan: the line's name, so you can tell it from any other line at a glance, then the release, dim (`v0.9.0`). The pane and `/judge` add the commit the install came from (`v0.9.0 · 806d383`).
- **Where this thread stands,** bold: `not filed yet`; `files at HH:MM` once a turn has made it due; `filing…`; `filed HH:MM`, in green; `in the manifest`, in green, for a thread an earlier run of the session filed; `filing failed`, in red; `merged into another thread` or `taken out of the manifest`; or `files on /judge file` with filing turned off.
- **The tally,** dim: `3 updates`, this session's commits to the manifest (its filings, merges, deletions and deleted threads taken out). It keeps its place however narrow the window.
- **The details,** dim: the thread's title, `N related threads`, and what the manifest held when this session last read or wrote it (`12 threads · 4 projects`). Details that do not fit are left off from the right.
- **Threads**, then **File now**, at the right end. **Threads** opens the Judgeiverse pane; where the app shows no panes, it lists the threads in the chat instead, as `/judge threads` does. **File now** judges and files this thread at once.

Each time this session updates the manifest, the line lights up for about 8 seconds: `Judgeiverse` turns bold green and `✓ manifest updated HH:MM` takes the place of where the thread stands, then the line goes back to dim with the tally one higher. A failed filing lights it red with `✗ filing failed` the same way. The toasts still come for the first filing, a new entry and a recovery. The line stays one row on a narrow window; the details are cut at the right, never wrapped.

## Install

In any Claude Code session (2.1.287 or newer, or the desktop app):

```text
/plugin install judge-keep-warm --marketplace judgedice/judgeclaudemaudes
```

Or in a terminal:

```bash
claude plugin marketplace add https://github.com/judgedice/judgeclaudemaudes.git
claude plugin install judge-keep-warm@judge-keep-warm
```

Install it under the user scope on every account and machine you use Claude Code with. They all write to the same manifest repository; the account label tells their threads apart.

Turn on auto-update for the `judge-keep-warm` marketplace on each machine: in `/plugin`, open **Marketplaces**, pick `judge-keep-warm` and enable auto-update. Claude Code then updates the mod when it starts. `plugin.json` carries no `version`, so every commit to `main` counts as a new version and reaches the machine without a release.

In a cloud environment, put these commands in the environment's setup script, and the token in the environment's variables as `JUDGE_KEEP_WARM_TOKEN`. The Python step turns on auto-update: it sets `autoUpdate` on the marketplace's entry under `extraKnownMarketplaces` in user settings, which Claude Code reads when it starts.

```bash
claude plugin marketplace add https://github.com/judgedice/judgeclaudemaudes.git
python3 - <<'PY'
import json, os, pathlib
p = pathlib.Path(os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude')) / 'settings.json'
s = json.loads(p.read_text()) if p.exists() else {}
entry = s.setdefault('extraKnownMarketplaces', {}).setdefault('judge-keep-warm', {'source': {'source': 'git', 'url': 'https://github.com/judgedice/judgeclaudemaudes.git'}})
entry['autoUpdate'] = True
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(json.dumps(s, indent=2) + '\n')
PY
claude plugin install judge-keep-warm@judge-keep-warm
echo '{"account_label":"cloud"}' | claude plugin configure judge-keep-warm@judge-keep-warm --values-stdin
```

A new container installs the latest commit anyway; auto-update covers a container you come back to, when Claude Code starts again there.

### The pane in a cloud session

A cloud session (claude.ai/code, or a cloud session in the desktop or mobile app) has no line above the prompt, so a few seconds after start the mod opens the **Judgeiverse** pane where the app seats panes: beside the chat where the window is wide enough, else above the prompt. It holds the line in rows, then the threads. Closed, it comes back with `/judge pane`. Update every machine and cloud environment to the same build: an older one rebuilds `manifest.json` without the sub-manifests, so merged and deleted threads show again until a newer one files.

## Set up the manifest

1. The manifest lives in a private repository of its own, `judgedice/judgeiverse` by default: the mod commits `threads/<account>/<session id>.json`, `manifest.json` and `MANIFEST.md` there. Nothing runs in it: no action, no secret. This plugin's repository is public and holds no thread. To keep the manifest elsewhere, set **Manifest repository** to another `owner/repo`; an empty private repository is enough, and the mod's first filing puts a README in it.
2. Give each machine a token that can write to the manifest repository: a fine-grained personal access token with **Contents: read and write** on it. Put it in the plugin's **GitHub token** option, or in the `JUDGE_KEEP_WARM_TOKEN` environment variable. Where the `gh` CLI is logged in, no token is needed in a terminal session.
3. Set the plugin's options with `/plugin configure judge-keep-warm@judge-keep-warm` or in `/config`:

   | Option | What it does |
   | --- | --- |
   | Manifest repository | `owner/repo` of the manifest. Default `judgedice/judgeiverse`. Empty: threads are not filed. |
   | Account label | How this account appears in the manifest (`work`, `personal`). Empty: `user@host`. |
   | GitHub token | The token above. Empty: `JUDGE_KEEP_WARM_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, then `gh auth token`. |
   | File threads in the manifest | On: two minutes after each turn, once the conversation pauses. Off: only `/judge file` writes an entry. |
   | Judge model | The model that bundles the threads: `haiku`, `sonnet`, `opus` or a full id. Empty: this session's own model. |
   | Take deleted threads out of the manifest | Off: a thread whose session was deleted on this machine stays listed. Entries deleted from the repository are taken out either way. |

That is all. The first thread filed from any machine creates `threads/`, `manifest.json` and `MANIFEST.md`.

## Commands

| Command | What it does |
| --- | --- |
| `/judge` | The manifest's state for this thread: last filing, the judge's verdict, related threads |
| `/judge file` | Judge and file this thread now |
| `/judge close` | Judge and file this thread as closed |
| `/judge threads` | The open threads in the manifest that cover this repository or directory |
| `/judge pane` | Open the Judgeiverse pane: the line, then the threads, with merge and delete (it opens by itself where no line can be drawn). `/judge panel` is the same |
| `/judge merge <keep> <other>…` | Fold the other threads into the first, all of one project. Name each by its session id or its first eight characters |
| `/judge delete <id>…` | Take threads out of the manifest, keeping one line on each in its project's sub-manifest |
| `/judge tidy` | Review every listed thread and propose merges and archives, numbered |
| `/judge tidy apply [n…]` | Apply the review's steps in one commit: all of them (less any unticked in the pane), or the numbered ones |

### Tools Claude can call

| Tool | What it does |
| --- | --- |
| `mcp__judge-keep-warm__list_threads` | Read-only: every listed thread by project (session id, title, status, age, account, summary), which ones are protected, and what the rules flag. `project` narrows it to projects whose name contains that text |
| `mcp__judge-keep-warm__tidy_threads` | Applies `merge` groups (`{ keep, drop }`) and `archive` ids in one commit, under the tidy's guards, and says what it left alone and why |

## Where the line shows

In a terminal and in the desktop app's Code tab for local sessions, the line is drawn above the prompt. A cloud session's chat has no such slot, so there the mod opens a **Judgeiverse** pane a few seconds after start: the line as a status card, the flash after an update in its border, then the threads (see The Judgeiverse pane, above). `/judge pane`, or **Threads** on the line, opens it anywhere panes exist.

## How filing is paced

A thread is filed two minutes after a turn, once the conversation has paused. A turn that starts sooner holds the filing until the pause after it, so a back-and-forth is filed once, when it stops. Nothing is filed again until another turn, and a failed filing is not retried before the next turn. A `/clear` (or `/resume` to another session) within the two minutes files the ending thread a few seconds later, with the local summary. Merges, deletions and the deletion hook commit when they happen, and the deletion hook's work rides along with a filing's commit when one is due.

**File now** and `/judge file` judge and file at any time. On a session whose cache has gone cold, the judge's fork writes the cache afresh, at full price, so the filing after a turn is the one to rely on.

## What it runs, reads and sends

- **To GitHub, with your token:** the thread entry (the fields in `types/index.d.ts`: session id, account label, host name, surface, title, working directory, repository remote, model, token counts, times, the judge's summary, topics, project and next step, and the resume command), `manifest.json`, `MANIFEST.md`, and the sub-manifests a merge or deletion changes, committed together through the git data API. Every thread entry and the manifest are read back from the repository before each filing (kept in the plugin's store by blob sha, so only new ones are fetched), and the manifest at session start and on `/judge threads`. An empty repository gets a README first, through the Contents API. Where the host refuses GitHub's REST writes (a cloud session behind a proxy that allows only git), the mod switches to git for the rest of the process: a shallow clone of the manifest repository under `~/.claude/judge-keep-warm/`, committed and pushed as `judge-keep-warm`, the token passed to git through its environment and never stored in the clone. Nothing else leaves the machine, and nothing reaches the mod's author.
- **Model calls** go to Anthropic through Claude Code's own connection, on your account, never an API key of yours: the judge question (a fork of this conversation two minutes after a turn, which reads it from cache); the bundling question, one completion over the titles, summaries, topics and repositories of every thread in the manifest, at low effort, on the judge model (this session's model unless set); and, only when you ask for a tidy, the tidy question, one completion over the titles, summaries, statuses and ages of every listed thread, at medium effort, on the judge model. None reads your other conversations: only what their own sessions filed.
- **Commands run on the host:** `gh auth token` (only when no token is configured), `hostname` (only when the environment names no host), and `git` (clone, fetch, reset, add, commit, push) in the mod's own clone, only once a REST write was refused.
- **Files read on the machine:** the mod's own `plugin.json` (for its build), and the names of the transcript files under `~/.claude/projects` (never their contents), for the deletion hook.
- **Environment variables read:** `JUDGE_KEEP_WARM_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `HOSTNAME`, `COMPUTERNAME`, `USER`, `USERNAME`, `HOME`, `USERPROFILE`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_REMOTE`.
- **The desktop app's session tools** are called to read the session's title, and to take off the green dot an older build put in front of it while keep-warm was on.

Check it before installing: `claude plugin validate --strict ./.claude-plugin/plugin.json` lists every event, call and environment read.

## Development

The mod is `hooks/register.tsx` (the filing schedule, the GitHub layer, the manifest transaction, the pane and the tools), `hooks/judge.ts` (pure helpers: the judge prompt, the bundling, the sub-manifests, the manifest's rendering), `hooks/tidy.ts` (pure helpers for tidying: the rules, the tidy question and the guards its answer is held to) and `hooks/format.ts` (the markdown `/judge` and the pane print); `hooks/version.ts` holds the release the line names: raise it with each release, while `plugin.json` stays without a `version` so every commit still reaches installed machines; its state contract is `types/index.d.ts`; the README the mod puts into an empty manifest repository is `manifest-repo/README.md`. `claude plugin validate --strict .` checks it; `claude plugin test .` runs `tests/`, which drive a filing against a GitHub kept in memory.

MIT. A community mod, not made by Anthropic.
