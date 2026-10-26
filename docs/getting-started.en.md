# Getting started

## Requirements

| Item | Requirement |
|---|---|
| OS | Windows, macOS, Linux |
| Node.js | 22.13 or later |
| AI agent | Claude Code (v2.1.310 or later), Codex (v0.164 or later). Either one, or both |

## Install

```bash
npm install -g warifuri
```

<details>
<summary>If it doesn't work in Windows PowerShell</summary>

If it says running scripts is disabled on this system, type `warifuri.cmd` instead of `warifuri`.

</details>

<details>
<summary>If it doesn't work on macOS or Linux</summary>

If `npm install -g` fails with EACCES, don't use `sudo`; install Node.js for your own user with nvm or similar.

If it says `command not found: warifuri`, add the `bin` folder under the path that `npm prefix -g` prints to your PATH.

</details>

## Setup

| Use | What it means | Where to read |
|---|---|---|
| On one PC | Use it only on your own PC | Steps 1 to 3 below |
| Host it | Put the server on a VM or an always-on PC and use it from other PCs too | Steps 1 and 2 below, and [Hosting](#hosting) |
| Use it as a client | Connect from another PC to a hosted server | [Using it as a client](#using-it-as-a-client) |

### 1. Create the data folder

```bash
warifuri init
```

This creates a template of the settings file `warifuri.env` and a few other files in `~/.warifuri/` (`%USERPROFILE%\.warifuri` on Windows). Files that already exist are left as they are.

### 2. Start the server

```bash
warifuri serve
```

When it prints `warifuri: serving http://127.0.0.1:8787/mcp`, the server is running. The database (`~/.warifuri/ledger.sqlite`) is created on the first start, and the server only accepts connections from this PC (`127.0.0.1`).

<details>
<summary>About "GitHub login off"</summary>

GitHub login isn't set up, so connections use only the device key. On one PC this is fine as it is. To use it from other PCs, see [Hosting](#hosting).

</details>

<details>
<summary>Change the port (use something other than 8787)</summary>

If another app uses port 8787, write `WARIFURI_PORT=8788` (for example) in `warifuri.env`. Both `serve` and `connect` read it. If you change it after running `connect`, delete the `WARIFURI_SERVER_URL` line in `warifuri.env` and run `connect` again.

</details>

### 3. Connect Claude Code and Codex

Once the server has started, run this in another terminal.

```bash
warifuri connect
```

<details>
<summary>Details of connect</summary>

- Issues a device key for this PC (a string starting with `wf_`) and saves it in `~/.warifuri/device.key`, readable only by you. The device name is the PC's host name; change it with `--device <name>`.
- Registers the MCP server as `warifuri` in `claude` and `codex`.
- Adds the task check to Claude Code's `~/.claude/settings.json` and Codex's `~/.codex/hooks.json`.
- Copies the warifuri skill. If the secretary skill of an earlier version (`warifuri-secretary`) is there, moves it out of the skills folder.

Before changing a settings file, it backs it up as `<file>.bak-warifuri-<date>`. Running it again gives the same result.

| Option | What it does |
|---|---|
| `--dry-run` | Only show what it would do |
| `--harness claude` / `--harness codex` | Connect only one of them |
| `--no-hook` | Don't set up the task check |
| `--no-skills` | Don't copy the warifuri skill |
| `--force` | Replace the skill with the new version |

</details>

> 🟧 **Claude Code**
>
> After starting it, if `warifuri` shows `Connected` in `/mcp` (or `claude mcp list` in a terminal), you can use it right away.

> ⬛ **Codex**
>
> Set the environment variable `WARIFURI_DEVICE_KEY` to the contents of the device key file that `connect` made (`~/.warifuri/device.key`), then start `codex`. Once it starts, open `/hooks` in Codex and trust the task check once.
>
> On macOS and Linux:
>
> ```bash
> export WARIFURI_DEVICE_KEY="$(cat ~/.warifuri/device.key)"
> ```
>
> On Windows (PowerShell):
>
> ```powershell
> $env:WARIFURI_DEVICE_KEY = (Get-Content "$env:USERPROFILE\.warifuri\device.key" -Raw).Trim()
> ```
>
> <details>
> <summary>Keep it set (Windows)</summary>
>
> ```powershell
> [Environment]::SetEnvironmentVariable('WARIFURI_DEVICE_KEY', (Get-Content "$env:USERPROFILE\.warifuri\device.key" -Raw).Trim(), 'User')
> ```
>
> </details>
>
> To check the connection, ask Codex something like "show me the warifuri board".

### Hosting

With GitHub login, other PCs and Claude on the web or in the app can connect to a server on a VM or an always-on PC.

<details>
<summary>Steps (example with the public URL https://warifuri.example.com)</summary>

1. On the server PC, run `warifuri init` and `warifuri serve` as in steps 1 and 2 above.
2. Put HTTPS in front of the server and prepare a URL reachable from outside (the public URL). For example, with Caddy on the same PC, this setting also gets the HTTPS certificate automatically.

   ```
   warifuri.example.com {
     reverse_proxy 127.0.0.1:8787
   }
   ```

   If HTTPS runs on a different PC from the server, also change `WARIFURI_HOST` in `warifuri.env`.
3. In GitHub, go to Settings → Developer settings → OAuth Apps and create an OAuth App like this.

   | Field | Example |
   |---|---|
   | Application name | `warifuri` |
   | Homepage URL | `https://warifuri.example.com` |
   | Authorization callback URL | `https://warifuri.example.com/oauth/github/callback` |

4. Write the following in the two files in the data folder and restart `warifuri serve`.

   `warifuri.env`:

   ```
   WARIFURI_PUBLIC_URL=https://warifuri.example.com
   WARIFURI_GITHUB_USER=<your GitHub user name>
   WARIFURI_GITHUB_CLIENT_ID=<the OAuth App's Client ID>
   ```

   `secrets.env`:

   ```
   WARIFURI_GITHUB_CLIENT_SECRET=<the OAuth App's Client Secret>
   ```

</details>

If "GitHub login off" no longer appears at startup, GitHub login works. `warifuri config` shows what is missing.

### Using it as a client

Connect from another PC to a hosted server. Install warifuri on this PC too, then run:

```bash
warifuri connect --url https://<server> --device <device name>
```

The first time you use it, a browser opens; log in with GitHub and choose this PC's device name.

<details>
<summary>The consent screen</summary>

After you log in with GitHub, this screen opens (the screen is in Japanese).

![The consent screen](images/consent.png)

- The top box: the name of the app that wants to connect, and where it returns to. The app gives its own name, so check that the return address (such as `claude.ai`) is right.
- このデバイスを登録 (register this device): if another agent on this PC already gave it a name, choose it here.
- 新しいデバイス (new device): for a PC connecting for the first time, type a name using letters, digits and `.` `_` `-`.
- 許可する (allow): the agent can then read and write the database.

</details>

The task check also needs a device key on this PC. On the server PC, run the following and write the key it prints on one line in this PC's `~/.warifuri/device.key`.

```bash
warifuri key add <device name>
```

## Secretary

The secretary is an AI agent that runs task management and scheduling on a timer. It is off by default. What it does is described in [Usage](usage.md#3-秘書) (in Japanese).

On the server PC, log in to Claude Code, run the following and restart `warifuri serve`.

```bash
warifuri secretary enable
```

To stop it, run `warifuri secretary disable` and restart `warifuri serve`. The times can be changed in [Configuration](configuration.md) (in Japanese).

<details>
<summary>What the secretary can use</summary>

The secretary can use only warifuri's tools; claude.ai connectors (mail, calendar) are off by default. How to let it use a calendar will be described in [Integrations](integrations.md).

</details>

## Settings

Settings go in `warifuri.env` in the data folder as `NAME=value`. Secret values go in `secrets.env`. The list of settings is in [Configuration](configuration.md) (in Japanese) and examples are in [examples/](../examples/README.md). `warifuri config` shows the current values.

<details>
<summary>File encoding (Windows)</summary>

Save `warifuri.env` as UTF-8. Appending lines with `>>` in Windows PowerShell 5.1 writes that part as UTF-16, and the file can no longer be read.

</details>

## Update, backup and uninstall

### Update

Stop the server, then run:

```bash
npm install -g warifuri@latest
```

```bash
warifuri connect --force
```

### Backup

Backs up the database to a dated file. It works while the server is running and keeps the newest 7 (change with `--keep`).

```bash
warifuri backup --dir <backup folder>
```

### Uninstall

<details>
<summary>Steps</summary>

1. Stop the server.
2. In Claude Code's `~/.claude/settings.json` and Codex's `~/.codex/hooks.json`, delete the entry under `hooks` → `PreToolUse` that calls `warifuri hook gate` (`warifuri.cmd hook gate` on Windows). Leave other hooks alone.
3. Delete the skill folders `~/.claude/skills/warifuri/` and `~/.codex/skills/warifuri/`.
4. Remove the MCP server registrations.

   ```bash
   claude mcp remove --scope user warifuri
   ```

   ```bash
   codex mcp remove warifuri
   ```

5. If you set the environment variable `WARIFURI_DEVICE_KEY`, remove it.
6. Uninstall the package.

   ```bash
   npm uninstall -g warifuri
   ```

7. If you no longer need it, delete the data folder `~/.warifuri/`. It holds the database, settings and device key.

</details>
