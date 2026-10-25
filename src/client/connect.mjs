// `warifuri connect`: sets up a machine that uses a warifuri server. It finds the harnesses
// on PATH (Claude Code, Codex), registers the server's MCP endpoint in each, puts this
// machine's device key in its file (issuing it when the server's ledger is on this machine),
// wires the start gate hook (`warifuri hook gate`) and copies the package's skills.
//
// Every step looks at what is already there first, so running it again changes nothing.
// A harness file that is changed is copied next to itself first (<file>.bak-warifuri-<time>);
// other hooks in it are kept. With dryRun nothing is written and nothing is issued; the plan
// is only described. The device key is never part of what is printed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openLedger } from '../ledger/ledger.mjs';
import { oauthConfig } from '../server/oauth.mjs';
import { initHome, decodeText, SETTINGS_FILE } from '../config.mjs';
import { readKey } from './gate.mjs';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BIN = path.join(PACKAGE_ROOT, 'bin', 'warifuri.mjs');
export const SERVER_NAME = 'warifuri';
// Codex reads a bearer token from an environment variable, never from its config.
export const CODEX_KEY_ENV = 'WARIFURI_DEVICE_KEY';
export const CLAUDE_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';
// In Codex, Edit and Write are matcher aliases of apply_patch.
export const CODEX_MATCHER = 'apply_patch|Edit|Write';
const HOOK_TIMEOUT = 10;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// The person's home directory: %USERPROFILE% on Windows, $HOME elsewhere.
export function userHome(env = process.env, platform = process.platform) {
  const h = platform === 'win32' ? env.USERPROFILE : env.HOME;
  return h && h.trim() !== '' ? h : os.homedir();
}

// The full path of a command on PATH, or null. On Windows it tries the PATHEXT endings
// (warifuri.cmd, claude.cmd, codex.exe and so on).
export function findOnPath(name, env = process.env, platform = process.platform) {
  const sep = platform === 'win32' ? ';' : ':';
  const dirs = (env.PATH ?? env.Path ?? '').split(sep).filter(Boolean);
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) continue;
        if (platform !== 'win32' && !(st.mode & 0o111)) continue;
        return file;
      } catch {
        // not here
      }
    }
  }
  return null;
}

// Hides device keys in text that goes to the person.
export const redact = (text) => String(text ?? '').replace(/wf_[A-Za-z0-9_-]+/g, 'wf_********');

// Runs a harness's command line. A .cmd or .bat file on Windows needs the shell; the
// arguments are quoted for it.
function defaultRun(file, args, { env, platform }) {
  const viaShell = platform === 'win32' && /\.(cmd|bat)$/i.test(file);
  const quote = (a) => `"${String(a).replace(/"/g, '""')}"`;
  const res = viaShell
    ? spawnSync(quote(file), args.map(quote), { encoding: 'utf8', env, shell: true, timeout: 60_000 })
    : spawnSync(file, args, { encoding: 'utf8', env, timeout: 60_000 });
  return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? (res.error ? res.error.message : '') };
}

// The server's base URL: no trailing slash, no /mcp.
export function baseUrl(url) {
  return url.trim().replace(/\/+$/, '').replace(/\/mcp$/, '');
}

function isLoopback(url) {
  try {
    return LOOPBACK.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

const sameOrigin = (a, b) => {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
};

// The default device name: this machine's host name, cut to what a device name may hold.
export function defaultDeviceName() {
  const n = os.hostname().split('.')[0].toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return n || 'this-machine';
}

const stamp = (now) => now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { json: null, exists: false };
    return { error: `cannot read ${file}: ${err.message}` };
  }
  if (text.trim() === '') return { json: {}, exists: true };
  try {
    const json = JSON.parse(text);
    if (!json || typeof json !== 'object' || Array.isArray(json)) return { error: `${file} is not a JSON object; left as it is` };
    return { json, exists: true };
  } catch (err) {
    return { error: `${file} is not valid JSON (${err.message}); left as it is` };
  }
}

// Writes a harness file, first copying the old one next to it. Returns the backup's path.
function writeWithBackup(file, text, now) {
  let backup = null;
  if (fs.existsSync(file)) {
    backup = `${file}.bak-warifuri-${stamp(now)}`;
    for (let i = 2; fs.existsSync(backup); i++) backup = `${file}.bak-warifuri-${stamp(now)}-${i}`;
    fs.copyFileSync(file, backup);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  fs.writeFileSync(file, text);
  return backup;
}

// Is this hook handler warifuri's start gate?
export const isGateHook = (h) => !!h && typeof h.command === 'string' && /warifuri(?:\.mjs|\.cmd)?"?\s+hook\s+gate\b/.test(h.command);

// The hooks JSON with exactly one start gate in PreToolUse: { changed, json }. Other hooks,
// other events and other keys are kept as they are.
export function mergeGateHook(json, { matcher, handler }) {
  const out = structuredClone(json ?? {});
  if (out.hooks !== undefined && (typeof out.hooks !== 'object' || Array.isArray(out.hooks))) throw new Error('"hooks" is not an object');
  out.hooks ??= {};
  const groups = out.hooks.PreToolUse ?? [];
  if (!Array.isArray(groups)) throw new Error('"hooks.PreToolUse" is not a list');
  const ours = [];
  groups.forEach((g, gi) => (Array.isArray(g?.hooks) ? g.hooks : []).forEach((h, hi) => isGateHook(h) && ours.push({ g, gi, hi, h })));
  if (ours.length === 1 && ours[0].g.matcher === matcher && JSON.stringify(ours[0].h) === JSON.stringify(handler)) {
    return { changed: false, json };
  }
  const kept = [];
  for (const g of groups) {
    if (!Array.isArray(g?.hooks) || !g.hooks.some(isGateHook)) {
      kept.push(g);
      continue;
    }
    const rest = g.hooks.filter((h) => !isGateHook(h));
    if (rest.length) kept.push({ ...g, hooks: rest });
  }
  kept.push({ matcher, hooks: [handler] });
  out.hooks.PreToolUse = kept;
  return { changed: true, json: out };
}

// The command line of the hook. `warifuri` when it is on PATH, or `warifuri.cmd` on Windows:
// npm also puts a warifuri.ps1 there, which PowerShell may refuse to run under its execution
// policy. Otherwise node and this package's bin.
export function gateCommand({ env, platform, home, homeIsDefault }) {
  const q = (s) => `"${s}"`;
  const onPath = findOnPath('warifuri', env, platform) ? (platform === 'win32' ? 'warifuri.cmd' : 'warifuri') : null;
  const head = onPath ?? `${q(process.execPath)} ${q(BIN)}`;
  return `${head} hook gate${homeIsDefault ? '' : ` --home ${q(home)}`}`;
}

// Sets NAME=value in a settings file's text: an uncommented line wins, then the commented
// template line, else a new line at the end.
export function setEnvLine(text, name, value) {
  const line = `${name}=${value}`;
  const live = new RegExp(`^[ \\t]*${name}[ \\t]*=.*$`, 'm');
  const commented = new RegExp(`^[ \\t]*#[ \\t]*${name}[ \\t]*=.*$`, 'm');
  if (live.test(text)) return text.replace(live, line);
  if (commented.test(text)) return text.replace(commented, line);
  return `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`;
}

// The [mcp_servers.<name>] table of Codex's config.toml: { url, bearer } or null.
export function codexServer(toml, name = SERVER_NAME) {
  const lines = toml.split(/\r?\n/);
  const head = new RegExp(`^\\s*\\[\\s*mcp_servers\\.(?:"${name}"|${name})\\s*\\]\\s*$`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  const out = {};
  for (const l of lines.slice(start + 1)) {
    if (/^\s*\[/.test(l)) break;
    const m = /^\s*(url|bearer_token_env_var)\s*=\s*"([^"]*)"/.exec(l);
    if (m) out[m[1] === 'url' ? 'url' : 'bearer'] = m[2];
  }
  return out;
}

// The skills this package carries: [{ name, files: [relative paths] }].
export function packageSkills(root = PACKAGE_ROOT) {
  const dir = path.join(root, 'harness', 'skills');
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return [];
  }
  const walk = (base, rel = '') =>
    fs.readdirSync(path.join(base, rel), { withFileTypes: true }).flatMap((d) => {
      const r = path.join(rel, d.name);
      return d.isDirectory() ? walk(base, r) : d.isFile() ? [r] : [];
    });
  return names.map((name) => ({ name, dir: path.join(dir, name), files: walk(path.join(dir, name)) }));
}

// Works out the plan and, unless dryRun, carries it out. Returns { lines, problems }.
//   cfg: loadConfig() for 'connect'. homeIsDefault: whether the data directory was not given.
//   opts: { device, harness ('claude' | 'codex' | 'all'), hook, skills, dryRun, force }
//   ctx: { env, platform, run, now, packageRoot } (tests stand in for the world here)
export function connect(cfg, opts, ctx = {}) {
  const env = ctx.env ?? process.env;
  const platform = ctx.platform ?? process.platform;
  const run = ctx.run ?? ((file, args) => defaultRun(file, args, { env, platform }));
  const now = ctx.now ?? new Date();
  const dry = !!opts.dryRun;
  const lines = [];
  const problems = [];
  const say = (text) => lines.push(dry ? `would ${text}` : text);
  const home = userHome(env, platform);

  // Which harnesses.
  const wanted = opts.harness === 'all' || !opts.harness ? ['claude', 'codex'] : [opts.harness];
  const harnesses = [];
  for (const h of wanted) {
    const bin = findOnPath(h, env, platform);
    if (bin) harnesses.push({ name: h, bin });
    else if (opts.harness === h) problems.push(`${h} is not on PATH`);
  }
  if (harnesses.length === 0 && problems.length === 0) problems.push('neither claude nor codex is on PATH; nothing to connect');
  // Nothing is changed for a harness that is not there.
  if (problems.length) return { lines, problems };

  // Is the server on this machine? Its ledger file is here, and the URL points at it.
  const values = cfg.values;
  const dbHere = !!values.WARIFURI_DB && fs.existsSync(values.WARIFURI_DB);
  const oauth = oauthConfig({ env: values }).config;
  let url = values.WARIFURI_SERVER_URL;
  if (!url) url = dbHere && oauth ? oauth.publicUrl : `http://127.0.0.1:${values.WARIFURI_PORT ?? '8787'}`;
  url = baseUrl(url);
  const local = dbHere && (isLoopback(url) || (oauth && sameOrigin(url, oauth.publicUrl)));
  // A server with no GitHub login takes device keys only, so the harness sends the key.
  const auth = local && !oauth ? 'key' : 'login';
  const mcpUrl = `${url}/mcp`;
  lines.push(`server: ${url} (${local ? 'on this machine' : 'elsewhere'}; harnesses sign in with ${auth === 'key' ? 'the device key' : 'the GitHub login'})`);

  // Remember the URL in warifuri.env, where the hook reads it.
  const settingsFile = cfg.files.settings;
  // A file saved as UTF-16 or with a BOM is read as text, and written back as UTF-8.
  const readSettings = () => decodeText(fs.readFileSync(settingsFile)).text;
  let settingsText = '';
  try {
    settingsText = readSettings();
  } catch {
    // written below
  }
  const want = setEnvLine(settingsText, 'WARIFURI_SERVER_URL', url);
  if (want !== settingsText || !fs.existsSync(settingsFile)) {
    say(`write WARIFURI_SERVER_URL=${url} in ${settingsFile}`);
    if (!dry) {
      try {
        if (!fs.existsSync(settingsFile)) initHome(cfg.home);
        fs.writeFileSync(settingsFile, setEnvLine(readSettings(), 'WARIFURI_SERVER_URL', url));
      } catch (err) {
        problems.push(`cannot write ${settingsFile}: ${err.message}`);
      }
    }
  } else {
    lines.push(`kept ${SETTINGS_FILE}: WARIFURI_SERVER_URL is already ${url}`);
  }

  // The device key: needed by the hook, and by the harnesses when they sign in with it.
  const keyFile = values.WARIFURI_DEVICE_KEY_FILE;
  let key = readKey(keyFile);
  const device = opts.device ?? defaultDeviceName();
  if (opts.hook || auth === 'key') {
    if (local) {
      let ledger;
      try {
        ledger = openLedger(values.WARIFURI_DB);
        const owner = key ? ledger.deviceForKey(key) : null;
        if (owner) {
          lines.push(`kept the key in ${keyFile} (device ${owner.name})`);
        } else {
          say(`issue a key for device ${device} and write it to ${keyFile}`);
          if (dry) {
            key = 'wf_dry-run';
          } else {
            key = ledger.issueKey(device, { actor: 'connect' }).key;
            fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
            fs.writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
            if (platform !== 'win32') fs.chmodSync(keyFile, 0o600);
          }
        }
      } catch (err) {
        key = null;
        const detail = err.problems ? err.problems.join('; ') : err.message;
        problems.push(`no device key: ${redact(detail)}. Give another name with --device, or run warifuri key revoke ${device} and connect again`);
      } finally {
        ledger?.close();
      }
    } else if (key) {
      lines.push(`kept the key in ${keyFile}`);
    } else {
      lines.push(
        `no device key yet: on the server's machine, run warifuri key add ${device}, and put the key on one line in ${keyFile} (readable only by you). Until then the start gate lets every edit through.`,
      );
    }
  }

  const command = gateCommand({ env, platform, home: cfg.home, homeIsDefault: ctx.homeIsDefault ?? true });
  const skills = opts.skills ? packageSkills(ctx.packageRoot) : [];
  const skillTargets = new Set();

  for (const h of harnesses) {
    // MCP registration.
    if (auth === 'key' && !key) {
      problems.push(`${h.name}: not registered, since there is no device key to sign in with`);
    } else if (h.name === 'claude') {
      registerClaude({ h, env, home, mcpUrl, auth, key, run, dry, say, lines, problems });
    } else {
      registerCodex({ h, env, home, mcpUrl, auth, run, dry, say, lines, problems });
    }

    const dir = h.name === 'claude' ? env.CLAUDE_CONFIG_DIR || path.join(home, '.claude') : env.CODEX_HOME || path.join(home, '.codex');

    // The start gate.
    if (opts.hook) {
      const file = h.name === 'claude' ? path.join(dir, 'settings.json') : path.join(dir, 'hooks.json');
      const handler =
        h.name === 'claude'
          ? { type: 'command', command, timeout: HOOK_TIMEOUT }
          : { type: 'command', command, timeout: HOOK_TIMEOUT, statusMessage: 'warifuri: checking the held task' };
      const matcher = h.name === 'claude' ? CLAUDE_MATCHER : CODEX_MATCHER;
      const read = readJson(file);
      if (read.error) {
        problems.push(`${h.name}: ${read.error}`);
      } else {
        try {
          const { changed, json } = mergeGateHook(read.json ?? {}, { matcher, handler });
          if (!changed) {
            lines.push(`${h.name}: kept the start gate in ${file}`);
          } else {
            say(`${h.name}: put the start gate in ${file} (PreToolUse, ${matcher})${read.exists ? ', backing up the old file next to it' : ''}`);
            if (!dry) {
              const backup = writeWithBackup(file, `${JSON.stringify(json, null, 2)}\n`, now);
              if (backup) lines.push(`${h.name}: backup ${backup}`);
            }
            if (h.name === 'codex') lines.push('codex: open /hooks in Codex once and trust the new hook; Codex runs a hook only after that');
          }
        } catch (err) {
          problems.push(`${h.name}: ${file}: ${err.message}; left as it is`);
        }
      }
    }

    // Skills.
    if (skills.length) {
      const target = path.join(dir, 'skills');
      if (h.name === 'codex' && !fs.existsSync(target)) {
        lines.push(`codex: no ${target}; skills not copied`);
      } else {
        let real = target;
        try {
          real = fs.realpathSync(target);
        } catch {
          // made below
        }
        if (skillTargets.has(real)) {
          lines.push(`${h.name}: skills already copied to ${target}`);
        } else {
          skillTargets.add(real);
          copySkills({ name: h.name, skills, target, force: opts.force, dry, say, lines, problems });
        }
      }
    }
  }

  if (harnesses.some((h) => h.name === 'codex') && auth === 'key') {
    lines.push(`codex: Codex reads the key from ${CODEX_KEY_ENV}; set it to the contents of ${keyFile} where Codex starts`);
  }
  return { lines, problems };
}

function readClaudeServer(env, home) {
  const file = env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json');
  const { json } = readJson(file);
  return json?.mcpServers?.[SERVER_NAME] ?? null;
}

function runStep({ h, args, shown, problems, lines }) {
  const res = (h.run ?? (() => {}))(h.bin, args);
  if (res.status !== 0) {
    problems.push(`${h.name}: ${shown} failed: ${redact(res.stderr || res.stdout).trim()}`);
    return false;
  }
  lines.push(`${h.name}: ${shown}`);
  return true;
}

function registerClaude({ h, env, home, mcpUrl, auth, key, run, dry, say, lines, problems }) {
  const current = readClaudeServer(env, home);
  const header = auth === 'key' ? `Authorization: Bearer ${key}` : null;
  const currentHeader = current?.headers?.Authorization ?? current?.headers?.authorization ?? null;
  if (current && current.url === mcpUrl && (header ? currentHeader === `Bearer ${key}` : !currentHeader)) {
    lines.push(`claude: kept the MCP server ${SERVER_NAME} at ${mcpUrl}`);
    return;
  }
  const add = ['mcp', 'add', '--scope', 'user', '--transport', 'http', SERVER_NAME, mcpUrl, ...(header ? ['--header', header] : [])];
  const shown = `claude mcp add --scope user --transport http ${SERVER_NAME} ${mcpUrl}${header ? ' --header "Authorization: Bearer wf_********"' : ''}`;
  if (dry) {
    if (current) say(`run claude mcp remove --scope user ${SERVER_NAME}`);
    say(`run ${shown}`);
    return;
  }
  const hh = { ...h, run };
  if (current) runStep({ h: hh, args: ['mcp', 'remove', '--scope', 'user', SERVER_NAME], shown: `claude mcp remove --scope user ${SERVER_NAME}`, problems: [], lines });
  if (runStep({ h: hh, args: add, shown, problems, lines }) && auth === 'login') {
    lines.push(`claude: open Claude Code, choose ${SERVER_NAME} in /mcp and sign in with GitHub`);
  }
}

function registerCodex({ h, env, home, mcpUrl, auth, run, dry, say, lines, problems }) {
  const config = path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml');
  let toml = '';
  try {
    toml = fs.readFileSync(config, 'utf8');
  } catch {
    // no config yet
  }
  const current = codexServer(toml);
  const bearer = auth === 'key' ? CODEX_KEY_ENV : undefined;
  if (current && current.url === mcpUrl && current.bearer === bearer) {
    lines.push(`codex: kept the MCP server ${SERVER_NAME} at ${mcpUrl}`);
    return;
  }
  const add = ['mcp', 'add', SERVER_NAME, '--url', mcpUrl, ...(bearer ? ['--bearer-token-env-var', bearer] : [])];
  const shown = `codex ${add.join(' ')}`;
  if (dry) {
    if (current) say(`run codex mcp remove ${SERVER_NAME}`);
    say(`run ${shown}`);
    return;
  }
  const hh = { ...h, run };
  if (current) runStep({ h: hh, args: ['mcp', 'remove', SERVER_NAME], shown: `codex mcp remove ${SERVER_NAME}`, problems: [], lines });
  if (runStep({ h: hh, args: add, shown, problems, lines }) && auth === 'login') {
    lines.push(`codex: run codex mcp login ${SERVER_NAME} to sign in with GitHub`);
  }
}

function copySkills({ name, skills, target, force, dry, say, lines, problems }) {
  for (const s of skills) {
    let copied = 0;
    let kept = 0;
    for (const rel of s.files) {
      const to = path.join(target, s.name, rel);
      if (fs.existsSync(to) && !force) {
        kept++;
        continue;
      }
      copied++;
      if (!dry) {
        try {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(path.join(s.dir, rel), to);
        } catch (err) {
          problems.push(`${name}: cannot copy ${to}: ${err.message}`);
        }
      }
    }
    if (copied) say(`${name}: copy the skill ${s.name} to ${path.join(target, s.name)} (${copied} file${copied === 1 ? '' : 's'}${kept ? `, ${kept} kept` : ''})`);
    else lines.push(`${name}: kept the skill ${s.name} in ${path.join(target, s.name)}`);
  }
}
