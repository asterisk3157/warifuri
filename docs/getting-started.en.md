# Getting started

How to install warifuri on your own PC and connect Claude Code or Codex to it.

## Requirements

- Node.js 22.13 or later (the database uses Node's `node:sqlite`)
- Claude Code, Codex or both, with the `claude` or `codex` command on PATH
- For Codex, a recent Codex that has `codex mcp add` and hooks (`/hooks`). For example, 0.164 or later works; very old versions such as 0.23 lack `codex mcp add`

It runs on Windows, macOS and Linux.

## Install

```bash
npm install -g warifuri
```

`warifuri --help` lists the commands, and `warifuri --version` prints the installed version.

On some PCs, `warifuri` works directly in Windows PowerShell. Only if PowerShell refuses with "running scripts is disabled on this system", type `warifuri.cmd` instead of `warifuri`. The `warifuri.ps1` that npm puts there is being stopped by the PowerShell execution policy. The start gate hook that `connect` writes calls `warifuri.cmd` on Windows from the start, so the execution policy does not affect it.

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

When it starts, it prints lines like these:

```
warifuri: serving http://127.0.0.1:8787/mcp
warifuri: GitHub login off (missing …); only device keys work
warifuri: web screens at http://127.0.0.1:8787/calendar (open from this machine, no login)
```

The first line means it is running. The second says that the GitHub login is not set up, so harnesses connect with device keys only. It always appears when you use warifuri alone on one PC, and you can leave it so. The GitHub login is only needed for using warifuri from other machines (see "Using it from another machine" below). The third line is the address of the web screen.

The database (`~/.warifuri/ledger.sqlite`) is made on the first start. The server only accepts connections from this PC (`127.0.0.1`).

Keep this terminal open while you use it; press Ctrl+C to stop it. Keeping the server running after the terminal is closed is not covered here. On Windows, one way is to register it in Task Scheduler to start when you sign in.

#### Changing the port

If another application already uses port 8787 and the server cannot start, write a line such as `WARIFURI_PORT=8788` in `warifuri.env`. Both `serve` and `connect` read it, so the `connect` that follows uses that port too. For a single try, `warifuri serve --port 8788` also works; then give `connect` the same `--port 8788`. After changing the port, read `8787` in the URLs of this guide as your number.

If you change the port after running `connect`, delete the `WARIFURI_SERVER_URL` line that `connect` wrote in `warifuri.env`, then run `connect` again.

### 3. Connect Claude Code and Codex

Open another terminal and run the command below. Run it after the server has started once, so that the database exists.

```bash
warifuri connect
```

`connect` does the following on this PC:

- Issues a key for this device (machine) and puts it in `~/.warifuri/device.key`, readable only by you. On macOS and Linux the file's mode is set to 600. On Windows it is protected by the permissions (ACL) of your user folder, so other users cannot read it, though administrators of the PC can. The device name is the PC's host name unless you give `--device <name>`.
- Registers the MCP server as `warifuri` in the `claude` and `codex` it finds on PATH.
- Adds the start gate hook to Claude Code's `~/.claude/settings.json` and Codex's `~/.codex/hooks.json`.
- Copies the light secretary skill (see below).

Before it rewrites an existing settings file, it copies the old one next to it as `<file>.bak-warifuri-<time>`. No copy is made for a file it creates or a file it does not need to change. Other hooks and settings are kept. Running it again changes nothing. To only see what it would do, run `warifuri connect --dry-run`; to connect only one of them, add `--harness claude` or `--harness codex`.

If `connect` fails on Codex, your Codex may be too old. Update Codex, then run `warifuri connect --harness codex` again.

#### Claude Code

After `connect`, start Claude Code and it is ready. To check the registration:

```bash
claude mcp list
```

If `warifuri` is listed as `Connected`, it is connected. It shows `Failed` while `warifuri serve` is stopped; start the server and check again. Inside Claude Code, `/mcp` shows it too.

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

Finally, open `/hooks` inside Codex and trust the start gate hook once. Codex runs only hooks you have trusted.

`codex mcp list` shows whether `warifuri` is registered. It shows only the registration, not whether Codex can reach the server. To check the connection, ask inside Codex for something like "show me the warifuri board" and see whether the warifuri tools work.

### The start gate

The start gate is a hook that runs before an agent edits a file. In a registered place (working directory), if this device holds no task there, it stops the edit and tells the agent to find or create a task and `start` it first. It does not stop edits when the server cannot be reached.

The start gate acts only inside folders registered as places. In a folder that is not registered, it stops nothing. To register a folder, start Claude Code or Codex in it and ask something like "register this folder as a place". The agent registers it with the MCP tool `place`, and can give it a profile (work, research and so on) at the same time.

To turn it off, write `WARIFURI_GATE=off` in `warifuri.env`. To connect without it, run `warifuri connect --no-hook`.

## Web screen

While `warifuri serve` is running, open http://127.0.0.1:8787/ in a browser. It moves to the calendar (`/calendar`), where you see your goals, tasks and schedule. The address `serve` prints when it starts is this `/calendar`.

## The light secretary skill

The package carries a light secretary skill, `warifuri-secretary` (`harness/skills/warifuri-secretary/`). It does not stay running: when you call it, it reads the database, sorts out what to do today, books time on the schedule, tidies up what is stuck and suggests the next step. It writes only what you have agreed to.

`warifuri connect` copies the skill to `~/.claude/skills/warifuri-secretary/` and `~/.codex/skills/warifuri-secretary/`. For Codex it copies only when `~/.codex/skills/` exists; to add it to Codex, make that folder and run `warifuri connect --force`. Files that are already there are kept, so to replace them with a newer version of the skill, run `warifuri connect --force` as well. To leave the skill out, add `--no-skills`.

The skill is written in Japanese. Ask Claude Code or Codex things like "what should I do today", "book time for this", "anything stuck?" or "what's next" and it is used.

## Running the secretary

On the server machine, the secretary can do its work at set times: every day at 23:00 it checks whether each goal can meet its due date and rebooks task time, at 07:00 it writes a morning report, and on Sunday at 23:00 it tidies the inboxes. Its brain is Claude Code on that machine (`claude -p`). No cron job or Task Scheduler entry is needed; `warifuri serve` keeps the clock and wakes it.

1. Install Claude Code on the server machine, start `claude` once and log in yourself. warifuri never reads that login.
2. Turn the secretary on.

   ```bash
   warifuri secretary enable
   ```

3. Restart `warifuri serve`. On start it prints `secretary on:` with the times of the jobs.

To try a job right away, keep `warifuri serve` running and run the command below. claude's output is kept in `secretary/logs/` in the data directory.

```bash
warifuri secretary run morning
```

To stop it, run `warifuri secretary disable` and restart `warifuri serve`. The times and the night hours are [settings](configuration.md). The secretary can use warifuri's tools only; the claude.ai connectors (mail, calendar) are off for it by default. Give it a calendar only on purpose; how, and how it works, is in the secretary plug-in section of the [architecture](architecture.md) (Japanese).

## Using it from another machine (GitHub login)

To use it from other machines, or from Claude on the web or in the app, put the server where they can reach it and set up the GitHub login. How to make the GitHub OAuth App, the settings the server needs, and running `warifuri connect --url https://<server> --device <device name>` on each machine are in the sections つなぎ方 (connecting) and 着手ゲート (the start gate) of [Architecture](architecture.md) (in Japanese). Put HTTPS in front when the server is reachable from outside.

## Settings

Settings go in `warifuri.env` in the data directory, one `NAME=value` per line; secrets go in `secrets.env`. The list of settings and the order they are read in are in [Configuration](configuration.md) (in Japanese). To see the current values and where each came from:

```bash
warifuri config
```

Example settings for a made-up person, ready to copy and edit, are in [examples/](../examples/README.md) (in Japanese). They also show how to write the profile files (`profiles/`).

Edit `warifuri.env` in an editor such as Notepad, and save it as UTF-8. In Windows PowerShell 5.1, do not append lines with `>>`: the appended part is written in UTF-16, and a file that mixes two encodings cannot be read. warifuri also reads UTF-8 files with a BOM and files that are entirely UTF-16, and warns you to save a UTF-16 file as UTF-8 again. Saving as UTF-8 is still the recommended way.

## Updating and removing

To update, stop the server, install again, and replace the skill with the new version.

```bash
npm install -g warifuri@latest
```

```bash
warifuri connect --force
```

You can copy the database to a dated file. The newest `--keep` copies (7 by default) stay and older ones are removed. The copy can be taken while `warifuri serve` is running.

```bash
warifuri backup --dir <folder to copy to>
```

To remove it, go in this order:

1. Stop the server: press Ctrl+C in the terminal running `warifuri serve`.
2. Remove the start gate hook and the skill. Open Claude Code's `~/.claude/settings.json` and Codex's `~/.codex/hooks.json`, and in `hooks`, under `PreToolUse`, delete by hand the entry that runs `warifuri hook gate` (`warifuri.cmd hook gate` on Windows). In Claude Code, the entry looks like this:

   ```json
   {
     "matcher": "Edit|Write|MultiEdit|NotebookEdit",
     "hooks": [
       { "type": "command", "command": "warifuri hook gate", "timeout": 10 }
     ]
   }
   ```

   In Codex, the `matcher` is `apply_patch|Edit|Write` and there is a `statusMessage` as well. If it sits in the same `hooks` list as other hooks, delete only the warifuri one. For the skill, delete the folders `~/.claude/skills/warifuri-secretary/` and `~/.codex/skills/warifuri-secretary/`.
3. Remove the MCP server that `connect` registered.

   ```bash
   claude mcp remove --scope user warifuri
   ```

   ```bash
   codex mcp remove warifuri
   ```

4. Remove the environment variable that holds the key for Codex. On Windows, remove it from your user environment variables. On macOS and Linux, delete the `export WARIFURI_DEVICE_KEY=…` line from your shell's startup file.

   ```powershell
   [Environment]::SetEnvironmentVariable('WARIFURI_DEVICE_KEY', $null, 'User')
   ```

5. Uninstall the package.

   ```bash
   npm uninstall -g warifuri
   ```

6. Last, delete the data directory `~/.warifuri/`. It holds the database, the settings and the key, so delete it only when you no longer need them.
