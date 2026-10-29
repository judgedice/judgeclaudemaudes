# Thread manifest

This repository is written by the **Judgeiverse** Claude Code mod (`judge-keep-warm`), from every account and machine it is installed on.

- `threads/<account>/<session id>.json`: one entry per Claude Code conversation, filed by the mod two minutes after each turn, once the conversation has paused (or with `/judge file`).
- `manifest.json`: the threads bundled into projects. The mod classifies them itself, through your own Claude Code connection, every time it files a thread, so the manifest is never behind the threads.
- `MANIFEST.md`: the same, for reading. Each row carries the `claude --resume` command of its thread.
- `projects/<slug>.json`: each project's sub-manifest, the threads taken out of it, one line each: merged into another thread (`/judge merge` or the pane), deleted by hand (`/judge delete`), or deleted elsewhere (the session deleted on its machine, or its entry file deleted here). A thread listed there is never listed in the manifest again.

Nothing runs in this repository: no action, no API key.
