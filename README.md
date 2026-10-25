# warifuri

[日本語](README.ja.md)

[![npm](https://img.shields.io/npm/v/warifuri)](https://www.npmjs.com/package/warifuri)
[![CI](https://github.com/asterisk3157/warifuri/actions/workflows/ci.yml/badge.svg)](https://github.com/asterisk3157/warifuri/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/warifuri)](LICENSE)

warifuri is a task manager shared by people and their AI agents (Claude Code, Codex).

## Features

| Feature | What it does |
|---|---|
| Tasks | Set goals and tasks |
| Scheduling | Put tasks on the calendar around the events already there |
| Web UI | See goals, tasks and schedule in a browser |
| Secretary (v0.2) | An AI agent runs task management and scheduling on a timer |

## Install

It runs on Node.js 22.13 or later, on Windows, macOS and Linux.

```bash
npm install -g warifuri
```

```bash
warifuri init
```

```bash
warifuri serve
```

Once the server is running, connect Claude Code and Codex from another terminal.

```bash
warifuri connect
```

While the server is running, open http://127.0.0.1:8787/ in a browser to see the Web UI.

## If it doesn't work

<details>
<summary>Windows PowerShell</summary>

If it says running scripts is disabled on this system, type `warifuri.cmd` instead of `warifuri`.

</details>

<details>
<summary>macOS and Linux</summary>

If `npm install -g` fails with EACCES, don't use `sudo`; install Node.js for your own user with nvm or similar.

If it says `command not found: warifuri`, add the `bin` folder under the path that `npm prefix -g` prints to your PATH.

</details>

## Docs

- Principles: [the ideas behind it](docs/principles.md) (Japanese)
- Getting started: [from install to connecting](docs/getting-started.en.md)
- Architecture: [how it fits together](docs/architecture.md) (Japanese)
- Configuration: [the list of settings](docs/configuration.md) (Japanese)

## Version history

| Version | Date | Changes |
|---|---|---|
| v0.2.0 | (planned) | Secretary, task order |
| v0.1.0 | 2026-10-25 | Tasks, scheduling, Web UI, MCP, the task check |

Details are [here](https://github.com/asterisk3157/warifuri/releases).

## License

[Apache-2.0](LICENSE)
