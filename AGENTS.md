# AGENTS.md

For AI agents (Claude Code, Codex and others) working in this repository.

## What this is

warifuri is a secretary for people who work with AI agents: a ledger of goals and tasks, opened through an MCP endpoint, with plug-ins around it. Read these before changing anything:

1. `docs/principles.md` — the principles (1–22). It is the spine of the design.
2. `docs/architecture.md` — the architecture derived from it. When the two disagree, `principles.md` wins; fix `architecture.md`.

## Rules

- **Nothing private.** This repository will become public. Never commit personal names, home directory paths, private domains, host names, or anything about anyone's work. Before every commit, `scripts/check-private-terms.sh` runs (through lefthook) against the maintainer's private list; you can run `scripts/check-private-terms.sh --all` yourself. Examples use a made-up person.
- **Vanilla first.** warifuri must run from settings alone. Anything specific to one person's environment belongs in their own settings repository or a personal plug-in, not here.
- **Plug-ins touch the core only through its API**, never each other.
- **Words.** Say "schedule" and "block" (スケジュール, ブロック). Do not use 時間割 or コマ.
- **Two READMEs.** `README.md` (English) and `README.ja.md` (Japanese) say the same things. Change both in the same commit.
- **Commit locally only.** Pushing, opening pull requests and releasing are done after the maintainer approves.

## Writing

Keep the README to what warifuri is, its status and links; explanations go in `docs/`, written as prose like a technical article. Say what something does, without examples that stand in for an argument or claims about people in general. Write Japanese in です・ます.
