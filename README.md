# warifuri

[日本語](README.ja.md)

A secretary for people who work alongside AI agents.

You decide what you are working toward, by when, and how far. warifuri and your agents decide when to do what, and in which order. You stop carrying the plan in your head; you keep your promises.

> **Status: early design.** There is no code yet. The design is in `docs/` (in Japanese for now). The repository is private while a few friends try it; it becomes public at v0.1.0, once someone can set it up from this README alone.

## The idea

- One ledger of goals and tasks, on a server you own. A goal has an outcome and a deadline that you set. A task is one block of work toward it.
- Opened through MCP. Claude Code on each of your machines (Mac, Windows, any PC) reads and writes the same ledger over HTTPS, from any network.
- Everything else plugs in. Scheduling, calendar, the secretary that watches your deadlines every night, Discord and a web page to talk to it: add the ones you want.
- Your agents close their own tasks. The secretary picks up what they forget. You can override anything at any time.

## Documents

| File | What it says |
|---|---|
| [`docs/思想.md`](docs/思想.md) | The philosophy: who decides what, and 21 principles. Rewrite the ones that do not fit you. |
| [`docs/構成.md`](docs/構成.md) | The architecture: the core (ledger and MCP endpoint), plug-ins, how it is reached, and settings. |

## What comes first

The ledger and read-only MCP tools (`board`, `get`, `search`), reachable from more than one machine.

## Feedback

If you try it, please open a [feedback issue](../../issues/new?template=feedback.yml): where you got stuck matters most. Security problems go through [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE)
