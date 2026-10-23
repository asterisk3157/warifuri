# AGENTS.md

For AI agents (Claude Code, Codex and others) working in this repository.

## What this is

warifuri is a secretary for people who work with AI agents: a ledger of goals and tasks, opened through an MCP endpoint, with plug-ins around it. Read these before changing anything:

1. `docs/思想.md` — the philosophy (principles 1–21). It is the spine of the design.
2. `docs/構成.md` — the architecture derived from it. When the two disagree, `思想.md` wins; fix `構成.md`.

## Rules

- **Nothing private.** This repository will become public. Never commit personal names, home directory paths, private domains, host names, or anything about anyone's work. Before every commit, `scripts/check-private-terms.sh` runs (through lefthook) against the maintainer's private list; you can run `scripts/check-private-terms.sh --all` yourself. Examples use a made-up person.
- **Vanilla first.** warifuri must run from settings alone. Anything specific to one person's environment belongs in their own settings repository or a personal plug-in, not here.
- **Plug-ins touch the core only through its API**, never each other.
- **Words.** Say "schedule" and "block" (スケジュール, ブロック). Do not use 時間割 or コマ.
- **Two READMEs.** `README.md` (English) and `README.ja.md` (Japanese) say the same things. Change both in the same commit.
- **Commit locally only.** Pushing, opening pull requests and releasing are done after the maintainer approves.

## Writing

Short sentences. Say what something does, not how impressive it is. In Japanese, use plain です・ます in the READMEs and だ・である in `docs/`, as the existing files do.
