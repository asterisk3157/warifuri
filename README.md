# warifuri

[日本語](README.ja.md)

A shared database of goals, tasks and schedule for people and their AI agents. You run the server on your own PC, and Claude Code or Codex reads and writes it over MCP. An agent holds a task before it works and closes it when it is done.

This is v0.1, meant first for one person on their own PC. The ideas are in [Principles](docs/principles.md) and the overall shape in [Architecture](docs/architecture.md), both in Japanese for now.

## Install

It runs on Node.js 22.13 or later, on Windows, macOS and Linux.

```bash
npm install -g warifuri
```

Then make the data directory, run the server, and connect Claude Code and Codex from another terminal.

```bash
warifuri init
```

```bash
warifuri serve
```

```bash
warifuri connect
```

While the server is running, open http://127.0.0.1:8787/ in a browser to see your goals, tasks and schedule. Setting the key for Codex, the start gate, the light secretary skill, using it from another machine, and updating or removing it are in [Getting started](docs/getting-started.en.md). The list of settings is in [Configuration](docs/configuration.md) (in Japanese).

## License

[Apache-2.0](LICENSE)
