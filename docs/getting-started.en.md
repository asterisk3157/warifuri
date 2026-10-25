# Getting started

How to install warifuri on your own PC and connect Claude Code or Codex to it.

## Requirements

- Node.js 22.13 or later (the database uses Node's `node:sqlite`)
- Claude Code, Codex or both, with the `claude` or `codex` command on PATH

It runs on Windows, macOS and Linux.

## Install

```bash
npm install -g warifuri
```

`warifuri --help` lists the commands.

If Windows PowerShell refuses with "running scripts is disabled on this system", type `warifuri.cmd` instead of `warifuri`. The `warifuri.ps1` that npm puts there is being stopped by the PowerShell execution policy.

## Getting started

### 1. Make the data directory

```bash
warifuri init
```

This makes the data directory `~/.warifuri/` (`%USERPROFILE%\.warifuri` on Windows) with a template settings file `warifuri.env`, an empty `secrets.env` and an empty `profiles/`. Files that are already there are left as they are.

### 2. Run the server

```bash
warifuri serve
```

When it prints `warifuri: serving http://127.0.0.1:8787/mcp`, it is running. The database (`~/.warifuri/ledger.sqlite`) is made on the first start. The server only accepts connections from this PC (`127.0.0.1`). Keep this terminal open while you use it; press Ctrl+C to stop it.

### 3. Connect Claude Code and Codex

Open another terminal and run the command below. Run it after the server has started once, so that the database exists.

```bash
warifuri connect
```

`connect` does the following on this PC:

- Issues a key for this device (machine) and puts it in `~/.warifuri/device.key`, readable only by you. The device name is the PC's host name unless you give `--device <name>`.
- Registers the MCP server as `warifuri` in the `claude` and `codex` it finds on PATH.
- Adds the start gate hook to Claude Code's `~/.claude/settings.json` and Codex's `~/.codex/hooks.json`.
- Copies the light secretary skill (see below).

Before it changes a settings file, it copies the old one next to it as `<file>.bak-warifuri-<time>`. Other hooks and settings are kept. Running it again changes nothing. To only see what it would do, run `warifuri connect --dry-run`; to connect only one of them, add `--harness claude` or `--harness codex`.

#### Claude Code

After `connect`, start Claude Code and it is ready. To check the registration:

```bash
claude mcp list
```

If `warifuri` is listed, it is connected. Inside Claude Code, `/mcp` shows it too.

#### Codex

Codex reads the key from the environment variable `WARIFURI_DEVICE_KEY`. In the terminal you start Codex from, put the contents of the key file in this variable, then start `codex`.

macOS and Linux:

```bash
export WARIFURI_DEVICE_KEY="$(cat ~/.warifuri/device.key)"
```

Windows PowerShell:

```powershell
$env:WARIFURI_DEVICE_KEY = (Get-Content "$env:USERPROFILE\.warifuri\device.key" -Raw).Trim()
```

To avoid doing this every time, on macOS and Linux put the same line in your shell's startup file (such as `~/.zshrc`). On Windows you can keep it in your user environment variables; terminals opened afterwards have it.

```powershell
[Environment]::SetEnvironmentVariable('WARIFURI_DEVICE_KEY', (Get-Content "$env:USERPROFILE\.warifuri\device.key" -Raw).Trim(), 'User')
```

Finally, open `/hooks` inside Codex and trust the start gate hook once. Codex runs only hooks you have trusted. `codex mcp list` shows the registration.

### The start gate

The start gate is a hook that runs before an agent edits a file. In a registered place (working directory), if this device holds no task there, it stops the edit and tells the agent to find or create a task and `start` it first. It does not stop edits in folders that are not registered as places, nor when the server cannot be reached.

To turn it off, write `WARIFURI_GATE=off` in `warifuri.env`. To connect without it, run `warifuri connect --no-hook`.

## Web screen

While `warifuri serve` is running, open http://127.0.0.1:8787/ in a browser to see your goals, tasks and schedule.

## The light secretary skill

The package carries a light secretary skill, `warifuri-secretary` (`harness/skills/warifuri-secretary/`). It does not stay running: when you call it, it reads the database, sorts out what to do today, books time on the schedule, tidies up what is stuck and suggests the next step. It writes only what you have agreed to.

`warifuri connect` copies the skill to `~/.claude/skills/warifuri-secretary/` and `~/.codex/skills/warifuri-secretary/`. For Codex it copies only when `~/.codex/skills/` exists. Files that are already there are kept, so to replace them with a newer version of the skill, run `warifuri connect --force`. To leave the skill out, add `--no-skills`.

The skill is written in Japanese. Ask Claude Code or Codex things like "what should I do today", "book time for this", "anything stuck?" or "what's next" and it is used.

## Using it from another machine (GitHub login)

To use it from other machines, or from Claude on the web or in the app, put the server where they can reach it and set up the GitHub login. How to make the GitHub OAuth App, the settings the server needs, and running `warifuri connect --url https://<server> --device <device name>` on each machine are in the sections つなぎ方 (connecting) and 着手ゲート (the start gate) of [Architecture](architecture.md). Put HTTPS in front when the server is reachable from outside.

## Settings

Settings go in `warifuri.env` in the data directory, one `NAME=value` per line; secrets go in `secrets.env`. The list of settings and the order they are read in are in [Configuration](configuration.md) (in Japanese). To see the current values and where each came from:

```bash
warifuri config
```

## Updating and removing

To update, stop the server, install again, and replace the skill with the new version.

```bash
npm install -g warifuri@latest
```

```bash
warifuri connect --force
```

You can copy the database to a dated file. The newest `--keep` copies (7 by default) stay and older ones are removed.

```bash
warifuri backup --dir <folder to copy to>
```

To remove it, uninstall the package and remove the MCP server that `connect` registered.

```bash
npm uninstall -g warifuri
```

```bash
claude mcp remove --scope user warifuri
```

```bash
codex mcp remove warifuri
```

Remove the start gate hook by hand: in `~/.claude/settings.json` and `~/.codex/hooks.json`, delete the `PreToolUse` entry that runs `warifuri hook gate`. Delete the skill's `skills/warifuri-secretary/` folders. The data directory `~/.warifuri/` holds the database, the settings and the key, so delete it only when you no longer need them.
