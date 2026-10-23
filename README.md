# Judge Keep Warm

A Claude Code mod that keeps a session's prompt cache warm and, when the cache is about to expire, files the thread into a GitHub manifest. Before pushing, it bundles every thread there, from every account and machine, into projects through your own Claude Code connection, so you resume an open thread instead of opening another. No action, no API key.

A fork of [Cache Keep-Warm](https://github.com/andreichiritescu/claude-code-cache-keep-warm) (MIT). The countdown line, the keep-warm pings and `/keepwarm` are the original's; the judge layer is new.

## What it does

- **Countdown.** A line above the prompt shows how long the cache stays warm and what a cold restart would re-write.
- **Keep warm.** Click **Keep warm** or type `/keepwarm on`: 5 minutes before the cache would expire, a background read keeps it warm. A cold cache is never pinged.
- **Judge.** With a manifest repository set, the keep-warm ping asks the model one question instead of "ok": what the thread is about, where it stands, its topics, its project, the next step, and whether it is done. The reply is written to `threads/<account>/<session id>.json` in the repository. The ping already reads the whole conversation from cache, so the judgment costs a few hundred output tokens on top.
- **Without keep-warm,** the thread is still filed when its cache is about to expire, with a free local summary (the first prompt and the last answer).
- **Bundling, done by the mod.** Before it pushes, the mod reads every thread the other accounts and machines filed, asks your own Claude Code connection (no API key) to bundle them all into projects, keeping the project names the manifest already has, and commits the thread entry together with `manifest.json` and `MANIFEST.md` in one commit. What lands in the repository is already classified. Threads go stale after 14 days; closed ones drop out after 30. Each row of `MANIFEST.md` carries the thread's `claude --resume` command.
- **At session start,** the mod reads `manifest.json` and tells you which open threads already cover the repository or directory you are in. The line shows `N related threads`; `/judge threads` lists them with their resume commands.

## Reading the line

The line above the prompt reads, left to right:

- **`Judgeiverse`**, in cyan: the line's name, so you can tell it from any other line at a glance.
- **The circle and the bar:** how much of the cache's life is left, green while keep-warm holds it.
- **The time left** and when the cache expires, or `cold since HH:MM`.
- **The details,** dim: keep-warm's state and next ping, what a cold cache would re-write, `filed HH:MM` or `filing failed`, and `N related threads`.
- **The counter,** dim: `12 threads · 4 projects · 3 filed`. The threads and projects are what the manifest held at this session's last filing (before the first, what it held when the session started); `filed` counts this session's filings.
- **Keep warm** or **Stop** at the right end.

Each time the manifest is updated, the line lights up for about 8 seconds: `Judgeiverse` turns bold green and `✓ manifest updated HH:MM` appears after the time left, then the line goes back to dim and the details say `filed HH:MM` again. A failed filing lights it red with `✗ filing failed` the same way. The toasts still come as before. The line stays one row on a narrow window; the details are cut at the right, never wrapped.

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

Install it under the user scope on every account and machine you use Claude Code with. They all write to the same manifest repository; the account label tells their threads apart. In a cloud environment, put the same three commands in the environment's setup script (`claude plugin marketplace add https://github.com/judgedice/judgeclaudemaudes.git`, `claude plugin install judge-keep-warm@judge-keep-warm`, and `echo '{"account_label":"cloud"}' | claude plugin configure judge-keep-warm@judge-keep-warm --values-stdin`) and the token in the environment's variables as `JUDGE_KEEP_WARM_TOKEN`.

## Set up the manifest

1. The manifest lives in a private repository of its own, `judgedice/judgeiverse` by default: the mod commits `threads/<account>/<session id>.json`, `manifest.json` and `MANIFEST.md` there. Nothing runs in it: no action, no secret. This plugin's repository is public and holds no thread. To keep the manifest elsewhere, set **Manifest repository** to another `owner/repo`; an empty private repository is enough, and the mod's first filing puts a README in it.
2. Give each machine a token that can write to the manifest repository: a fine-grained personal access token with **Contents: read and write** on it. Put it in the plugin's **GitHub token** option, or in the `JUDGE_KEEP_WARM_TOKEN` environment variable. Where the `gh` CLI is logged in, no token is needed in a terminal session.
3. Set the plugin's options with `/plugin configure judge-keep-warm@judge-keep-warm` or in `/config`:

   | Option | What it does |
   | --- | --- |
   | Manifest repository | `owner/repo` of the manifest. Default `judgedice/judgeiverse`. Empty: threads are not filed. |
   | Account label | How this account appears in the manifest (`work`, `personal`). Empty: `user@host`. |
   | GitHub token | The token above. Empty: `JUDGE_KEEP_WARM_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, then `gh auth token`. |
   | File threads in the manifest | Off: only `/judge file` writes an entry. |
   | Judge model | The model that bundles the threads: `haiku`, `sonnet`, `opus` or a full id. Empty: this session's own model. |
   | Mark the session title | A green dot before the title in the desktop app's list while keep-warm is on. |

That is all. The first thread filed from any machine creates `threads/`, `manifest.json` and `MANIFEST.md`.

## Commands

| Command | What it does |
| --- | --- |
| `/keepwarm on`, `/keepwarm 3h`, `/keepwarm until 18:00`, `/keepwarm off`, `/keepwarm` | Keep-warm, as in Cache Keep-Warm |
| `/judge` | The manifest's state for this thread: last filing, the judge's verdict, related threads |
| `/judge file` | Judge and file this thread now |
| `/judge close` | Judge and file this thread as closed |
| `/judge threads` | The open threads in the manifest that cover this repository or directory |

## How filing is paced

A thread is filed once per cache expiry. With keep-warm on, the ping files it, and files it again only when the judge's verdict changed, the last filing failed, or six hours have passed, so a thread kept warm all night is not re-bundled every 55 minutes. With keep-warm off, it is filed when 5 minutes of the cache are left. A real turn in the conversation makes the next expiry a new one to file.

## What it runs, reads and sends

Everything Cache Keep-Warm does, and:

- **To GitHub, with your token:** the thread entry (the fields in `types/index.d.ts`: session id, account label, host name, surface, title, working directory, repository remote, model, token counts, times, the judge's summary, topics, project and next step, and the resume command), `manifest.json` and `MANIFEST.md`, committed together through the git data API. Every thread entry and the manifest are read back from the repository before each filing (kept in the plugin's store by blob sha, so only new ones are fetched), and the manifest at session start and on `/judge threads`. An empty repository gets a README first, through the Contents API. Where the host refuses GitHub's REST writes (a cloud session behind a proxy that allows only git), the mod switches to git for the rest of the process: a shallow clone of the manifest repository under `~/.claude/judge-keep-warm/`, committed and pushed as `judge-keep-warm`, the token passed to git through its environment and never stored in the clone. Nothing else leaves the machine, and nothing reaches the mod's author.
- **Two model calls** go to Anthropic through Claude Code's own connection, on your account, never an API key of yours: the judge question (the keep-warm ping, which reads this conversation from cache) and the bundling question, one completion over the titles, summaries, topics and repositories of every thread in the manifest, at low effort, on the judge model (this session's model unless set). Neither reads your other conversations: only what their own sessions filed.
- **Commands run on the host:** `gh auth token` (only when no token is configured), `hostname` (only when the environment names no host), and `git` (clone, fetch, reset, add, commit, push) in the mod's own clone, only once a REST write was refused.
- **Environment variables read:** `JUDGE_KEEP_WARM_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `HOSTNAME`, `COMPUTERNAME`, `USER`, `USERNAME`, plus the cache-length variables Cache Keep-Warm reads.
- **The desktop app's session tools** are called to read the session's title (and to mark it while keep-warm is on).

Check it before installing: `claude plugin validate --strict ./.claude-plugin/plugin.json` lists every event, call and environment read.

## Development

The mod is `hooks/register.tsx` (the keep-warm engine, the GitHub layer and the filing) and `hooks/judge.ts` (pure helpers: the judge prompt, the bundling, the manifest's rendering); its state contract is `types/index.d.ts`; the README the mod puts into an empty manifest repository is `manifest-repo/README.md`. `claude plugin validate --strict .` checks it; `claude plugin test .` runs `tests/`, which drive a filing against a GitHub kept in memory.

MIT. A community mod, not made by Anthropic.
