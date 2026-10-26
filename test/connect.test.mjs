// Tests for `warifuri connect`, in a made-up home directory with fake `claude` and `codex`
// commands on PATH that record their arguments. Nothing here touches the real harnesses.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CLI } from './cli.mjs';
import { openLedger } from '../src/ledger/ledger.mjs';
import { connect, mergeGateHook, setEnvLine, codexServer, gateCommand, CLAUDE_MATCHER, CALENDAR_MATCHER } from '../src/client/connect.mjs';
import { loadConfig } from '../src/config.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warifuri-connect-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// The fake harness: it logs its arguments, and keeps the registration where the real one
// would, so that connect can see it on the next run. claude echoes the header it was given,
// as a harness might, to check that connect hides it.
// fake.cjs does the work; claude and codex (claude.cmd and codex.cmd on Windows, run through
// the shell as npm's shims are) only start it with their own name.
const FAKE = `const fs = require('fs');
const path = require('path');
const name = process.argv[2];
const args = process.argv.slice(3);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ name, args }) + '\\n');
const home = process.env.HOME;
if (name === 'claude' && args[1] === 'add') {
  const f = path.join(home, '.claude.json');
  let j = {};
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  j.mcpServers = j.mcpServers || {};
  const h = args.indexOf('--header');
  j.mcpServers[args[6]] = { type: 'http', url: args[7], ...(h > 0 ? { headers: { Authorization: args[h + 1].replace(/^Authorization: /, '') } } : {}) };
  fs.writeFileSync(f, JSON.stringify(j));
  console.log('Added HTTP MCP server ' + args[6] + (h > 0 ? ' with header ' + args[h + 1] : ''));
}
if (name === 'claude' && args[1] === 'remove') {
  const f = path.join(home, '.claude.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  delete j.mcpServers[args[4]];
  fs.writeFileSync(f, JSON.stringify(j));
}
if (name === 'codex' && args[1] === 'add') {
  const b = args.indexOf('--bearer-token-env-var');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '[mcp_servers.' + args[2] + ']\\nurl = "' + args[4] + '"\\n' + (b > 0 ? 'bearer_token_env_var = "' + args[b + 1] + '"\\n' : ''));
}
if (name === 'codex' && args[1] === 'remove') fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '');
`;

// A world: a user home, a data directory, a bin with the fake harnesses, a log.
function world({ harnesses = ['claude', 'codex'], ledger = true } = {}) {
  const root = fs.mkdtempSync(path.join(tmp, 'world-'));
  const user = path.join(root, 'user');
  const data = path.join(root, 'data');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(user);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'fake.cjs'), FAKE);
  for (const h of harnesses) {
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(bin, `${h}.cmd`), `@"${process.execPath}" "%~dp0fake.cjs" ${h} %*\r\n`);
    } else {
      fs.writeFileSync(path.join(bin, h), `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, 'fake.cjs')}" ${h} "$@"\n`);
      fs.chmodSync(path.join(bin, h), 0o755);
    }
  }
  if (ledger) {
    fs.mkdirSync(data);
    openLedger(path.join(data, 'ledger.sqlite')).close();
  }
  const log = path.join(root, 'log.jsonl');
  fs.writeFileSync(log, '');
  // Only the fake bin and node: a real harness can never be reached. Windows also needs its
  // own folder, for cmd.exe.
  const sys = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: '.COM;.EXE;.BAT;.CMD' } : {};
  // node comes from a folder of its own, since a warifuri installed beside it would
  // otherwise be found on PATH (Windows uses node's folder, as copying node is heavy).
  let nodeDir = path.dirname(process.execPath);
  if (process.platform !== 'win32') {
    nodeDir = path.join(root, 'node');
    fs.mkdirSync(nodeDir);
    fs.symlinkSync(process.execPath, path.join(nodeDir, 'node'));
  }
  const dirs = [bin, nodeDir, ...(process.platform === 'win32' ? [path.join(process.env.SystemRoot, 'System32')] : [])];
  const env = { ...sys, PATH: dirs.join(path.delimiter), HOME: user, USERPROFILE: user, WARIFURI_HOME: data, FAKE_LOG: log };
  const calls = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { root, user, data, bin, env, log, calls };
}

function run(w, args) {
  const r = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', CLI, 'connect', ...args], { encoding: 'utf8', env: w.env, timeout: 20_000 });
  return { ...r, all: `${r.stdout}${r.stderr}` };
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const listing = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

test('--dry-run tells the plan and changes nothing', () => {
  const w = world();
  const r = run(w, ['--dry-run', '--device', 'laptop']);
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /would issue a key for device laptop/);
  assert.match(r.stdout, /would run claude mcp add --scope user --transport http warifuri http:\/\/127\.0\.0\.1:8787\/mcp --header "Authorization: Bearer wf_\*\*\*\*\*\*\*\*"/);
  assert.match(r.stdout, /would run codex mcp add warifuri --url http:\/\/127\.0\.0\.1:8787\/mcp --bearer-token-env-var WARIFURI_DEVICE_KEY/);
  assert.match(r.stdout, /would claude: put the start gate in .*settings\.json/);
  assert.deepEqual(w.calls(), []);
  assert.deepEqual(listing(w.user), []);
  assert.deepEqual(listing(w.data), ['ledger.sqlite']);
  const l = openLedger(path.join(w.data, 'ledger.sqlite'));
  assert.deepEqual(l.listDevices(), []);
  l.close();
});

test('connects a local server: key issued once, MCP registered with it, gate wired; a second run changes nothing', () => {
  const w = world();
  const r = run(w, ['--device', 'laptop']);
  assert.equal(r.status, 0, r.all);

  const keyFile = path.join(w.data, 'device.key');
  const key = fs.readFileSync(keyFile, 'utf8').trim();
  assert.match(key, /^wf_/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  const l = openLedger(path.join(w.data, 'ledger.sqlite'));
  assert.equal(l.deviceForKey(key).name, 'laptop');
  l.close();
  // The key is never shown, not even when a harness echoes it.
  assert.ok(!r.all.includes(key), r.all);
  assert.match(r.stdout, /wf_\*\*\*\*\*\*\*\*/);

  const calls = w.calls();
  assert.deepEqual(calls.map((c) => c.name), ['claude', 'codex']);
  assert.deepEqual(calls[0].args, ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'warifuri', 'http://127.0.0.1:8787/mcp', '--header', `Authorization: Bearer ${key}`]);
  assert.deepEqual(calls[1].args, ['mcp', 'add', 'warifuri', '--url', 'http://127.0.0.1:8787/mcp', '--bearer-token-env-var', 'WARIFURI_DEVICE_KEY']);

  assert.match(fs.readFileSync(path.join(w.data, 'warifuri.env'), 'utf8'), /^WARIFURI_SERVER_URL=http:\/\/127\.0\.0\.1:8787$/m);
  const claude = readJson(path.join(w.user, '.claude', 'settings.json'));
  assert.equal(claude.hooks.PreToolUse.length, 2);
  assert.equal(claude.hooks.PreToolUse[0].matcher, CLAUDE_MATCHER);
  assert.match(claude.hooks.PreToolUse[0].hooks[0].command, /warifuri\.mjs" hook gate --home "[^"]+"$/);
  assert.equal(claude.hooks.PreToolUse[1].matcher, CALENDAR_MATCHER);
  assert.match(claude.hooks.PreToolUse[1].hooks[0].command, /warifuri\.mjs" hook calendar claude --home "[^"]+"$/);
  assert.match(readJson(path.join(w.user, ".codex", "hooks.json")).hooks.PreToolUse[1].hooks[0].command, / hook calendar codex --home /);
  const codex = readJson(path.join(w.user, '.codex', 'hooks.json'));
  assert.equal(codex.hooks.PreToolUse[0].matcher, 'apply_patch|Edit|Write');
  assert.equal(codex.hooks.PreToolUse[1].matcher, CALENDAR_MATCHER);
  assert.match(r.stdout, /trust the new hooks/);

  const before = { user: listing(path.join(w.user, '.claude')), codex: listing(path.join(w.user, '.codex')), settings: fs.readFileSync(path.join(w.user, '.claude', 'settings.json'), 'utf8') };
  const again = run(w, ['--device', 'laptop']);
  assert.equal(again.status, 0, again.all);
  assert.doesNotMatch(again.stdout, /^would/m);
  assert.match(again.stdout, /kept the key/);
  assert.match(again.stdout, /claude: kept the MCP server/);
  assert.match(again.stdout, /codex: kept the MCP server/);
  assert.match(again.stdout, /claude: kept the start gate/);
  assert.match(again.stdout, /claude: kept the calendar hook/);
  assert.equal(w.calls().length, 2);
  assert.equal(fs.readFileSync(keyFile, 'utf8').trim(), key);
  assert.deepEqual(listing(path.join(w.user, '.claude')), before.user);
  assert.deepEqual(listing(path.join(w.user, '.codex')), before.codex);
  assert.equal(fs.readFileSync(path.join(w.user, '.claude', 'settings.json'), 'utf8'), before.settings);
});

test('other hooks are kept, the old file is backed up, and an old gate is replaced, not doubled', () => {
  const w = world({ harnesses: ['claude'] });
  const file = path.join(w.user, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file));
  const original = {
    model: 'x',
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] },
        { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'lint.sh' }, { type: 'command', command: 'warifuri hook gate' }] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'stop.sh' }] }],
    },
  };
  fs.writeFileSync(file, JSON.stringify(original, null, 2));
  const r = run(w, ['--harness', 'claude', '--no-skills']);
  assert.equal(r.status, 0, r.all);
  const now = readJson(file);
  assert.equal(now.model, 'x');
  assert.deepEqual(now.hooks.Stop, original.hooks.Stop);
  assert.deepEqual(now.hooks.PreToolUse[0], original.hooks.PreToolUse[0]);
  assert.deepEqual(now.hooks.PreToolUse[1], { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'lint.sh' }] });
  assert.equal(now.hooks.PreToolUse.length, 4);
  assert.equal(now.hooks.PreToolUse.flatMap((g) => g.hooks).filter((h) => /hook gate/.test(h.command)).length, 1);
  assert.equal(now.hooks.PreToolUse.flatMap((g) => g.hooks).filter((h) => /hook calendar/.test(h.command)).length, 1);
  const backups = listing(path.dirname(file)).filter((f) => f.startsWith('settings.json.bak-warifuri-'));
  assert.equal(backups.length, 1);
  assert.deepEqual(readJson(path.join(path.dirname(file), backups[0])), original);
  assert.deepEqual(w.calls().map((c) => c.name), ['claude']);

  // A file that is not JSON is left alone.
  fs.writeFileSync(file, '{ broken');
  const broken = run(w, ['--harness', 'claude']);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ broken');
});

test('a server elsewhere: registered by URL for the GitHub login, and told how to get a key; a new URL re-registers', () => {
  const w = world({ ledger: false });
  const r = run(w, ['--url', 'https://ledger.example/mcp', '--device', 'desk']);
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /run warifuri key add desk/);
  assert.deepEqual(w.calls()[0].args, ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'warifuri', 'https://ledger.example/mcp']);
  assert.deepEqual(w.calls()[1].args, ['mcp', 'add', 'warifuri', '--url', 'https://ledger.example/mcp']);
  assert.ok(!fs.existsSync(path.join(w.data, 'device.key')));
  assert.match(fs.readFileSync(path.join(w.data, 'warifuri.env'), 'utf8'), /^WARIFURI_SERVER_URL=https:\/\/ledger\.example$/m);

  const moved = run(w, ['--url', 'https://new.example', '--no-hook']);
  assert.equal(moved.status, 0, moved.all);
  const names = w.calls().slice(2).map((c) => `${c.name} ${c.args.slice(0, 2).join(' ')}`);
  assert.deepEqual(names, ['claude mcp remove', 'claude mcp add', 'codex mcp remove', 'codex mcp add']);
  assert.equal(readJson(path.join(w.user, '.claude.json')).mcpServers.warifuri.url, 'https://new.example/mcp');
});

test('a harness that is asked for but missing, or a device that already has a key, is reported', () => {
  const w = world({ harnesses: ['claude'] });
  const r = run(w, ['--harness', 'codex']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /codex is not on PATH/);

  const l = openLedger(path.join(w.data, 'ledger.sqlite'));
  l.issueKey('taken', { actor: 'test' });
  l.close();
  const t = run(w, ['--device', 'taken']);
  assert.equal(t.status, 1);
  assert.match(t.stderr, /no device key/);
  assert.match(t.stderr, /claude: not registered/);
  assert.deepEqual(w.calls(), []);
});

test('skills are copied, and files already there are kept unless --force', () => {
  const w = world({ harnesses: ['claude', 'codex'] });
  const pkg = path.join(w.root, 'pkg');
  fs.mkdirSync(path.join(pkg, 'harness', 'skills', 'helper', 'refs'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'harness', 'skills', 'helper', 'SKILL.md'), 'new');
  fs.writeFileSync(path.join(pkg, 'harness', 'skills', 'helper', 'refs', 'a.md'), 'a');
  const mine = path.join(w.user, '.claude', 'skills', 'helper');
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(mine, 'SKILL.md'), 'mine');
  const cfg = loadConfig({ env: w.env, command: 'connect' });
  const opts = { harness: 'claude', hook: false, skills: true, force: false };
  const ctx = { env: w.env, packageRoot: pkg, run: () => ({ status: 0, stdout: '', stderr: '' }) };

  const dry = connect(cfg, { ...opts, dryRun: true }, ctx);
  assert.ok(dry.lines.some((l) => /would claude: copy the skill helper .*1 file, 1 kept/.test(l)), dry.lines.join('\n'));
  assert.ok(!fs.existsSync(path.join(mine, 'refs')));

  connect(cfg, opts, ctx);
  assert.equal(fs.readFileSync(path.join(mine, 'SKILL.md'), 'utf8'), 'mine');
  assert.equal(fs.readFileSync(path.join(mine, 'refs', 'a.md'), 'utf8'), 'a');
  const second = connect(cfg, opts, ctx);
  assert.ok(second.lines.some((l) => /claude: kept the skill helper/.test(l)));

  connect(cfg, { ...opts, force: true }, ctx);
  assert.equal(fs.readFileSync(path.join(mine, 'SKILL.md'), 'utf8'), 'new');

  // Codex gets them only when it has a skills folder.
  const c = connect(cfg, { ...opts, harness: 'codex' }, ctx);
  assert.ok(c.lines.some((l) => /codex: no .* skills not copied/.test(l)));
});

test('a skill copied under its old name is moved out of the skills folder', () => {
  const w = world({ harnesses: ['claude'] });
  const pkg = path.join(w.root, 'pkg');
  fs.mkdirSync(path.join(pkg, 'harness', 'skills', 'warifuri'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'harness', 'skills', 'warifuri', 'SKILL.md'), '---\nname: warifuri\n---\n');
  const skills = path.join(w.user, '.claude', 'skills');
  fs.mkdirSync(path.join(skills, 'warifuri-secretary'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'warifuri-secretary', 'SKILL.md'), '---\nname: warifuri-secretary\n---\n');
  fs.writeFileSync(path.join(skills, 'warifuri-secretary', 'examples.md'), 'old');
  const cfg = loadConfig({ env: w.env, command: 'connect' });
  const opts = { harness: 'claude', hook: false, skills: true, force: false };
  const now = new Date('2026-10-26T08:00:00Z');
  const ctx = { env: w.env, packageRoot: pkg, now, run: () => ({ status: 0, stdout: '', stderr: '' }) };

  const dry = connect(cfg, { ...opts, dryRun: true }, ctx);
  assert.ok(dry.lines.some((l) => /would claude: move the old skill warifuri-secretary/.test(l)), dry.lines.join('\n'));
  assert.ok(fs.existsSync(path.join(skills, 'warifuri-secretary')));

  const r = connect(cfg, opts, ctx);
  assert.deepEqual(r.problems, []);
  assert.ok(!fs.existsSync(path.join(skills, 'warifuri-secretary')));
  const moved = path.join(`${skills}.bak-warifuri-20261026-080000`, 'warifuri-secretary');
  assert.equal(fs.readFileSync(path.join(moved, 'examples.md'), 'utf8'), 'old');
  assert.ok(fs.existsSync(path.join(skills, 'warifuri', 'SKILL.md')));

  // A folder of that name that is someone else's skill stays.
  fs.mkdirSync(path.join(skills, 'warifuri-secretary'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'warifuri-secretary', 'SKILL.md'), '---\nname: my-own\n---\n');
  const again = connect(cfg, opts, ctx);
  assert.ok(!again.lines.some((l) => /move the old skill/.test(l)));
  assert.ok(fs.existsSync(path.join(skills, 'warifuri-secretary', 'SKILL.md')));
});

test('the small pieces: hook merge, env lines, the Codex table', () => {
  const handler = { type: 'command', command: 'warifuri hook gate', timeout: 10 };
  const once = mergeGateHook({}, { matcher: 'Edit', handler });
  assert.equal(once.changed, true);
  assert.equal(mergeGateHook(once.json, { matcher: 'Edit', handler }).changed, false);
  assert.equal(mergeGateHook(once.json, { matcher: 'Write', handler }).changed, true);
  assert.throws(() => mergeGateHook({ hooks: [] }, { matcher: 'Edit', handler }), /not an object/);

  assert.equal(setEnvLine('', 'A', '1'), 'A=1\n');
  assert.equal(setEnvLine('# x\n# A=\nB=2', 'A', '1'), '# x\nA=1\nB=2');
  assert.equal(setEnvLine('# A=\nA=0\n', 'A', '1'), '# A=\nA=1\n');

  assert.deepEqual(codexServer('[other]\nurl = "x"\n[mcp_servers.warifuri]\nurl = "https://a/mcp"\nbearer_token_env_var = "K"\n[next]\nurl = "y"'), { url: 'https://a/mcp', bearer: 'K' });
  assert.equal(codexServer('[mcp_servers.other]\nurl = "x"'), null);
});

test('the hook runs warifuri.cmd on Windows when warifuri is on PATH, so the execution policy does not matter', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'path-'));
  // Named as PATHEXT spells it: Windows ignores case, but Linux, where this also runs, does not.
  fs.writeFileSync(path.join(dir, 'warifuri.CMD'), '');
  const win = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  assert.equal(gateCommand({ env: win, platform: 'win32', home: dir, homeIsDefault: true }), 'warifuri.cmd hook gate');
  assert.equal(gateCommand({ env: win, platform: 'win32', home: 'C:\\data', homeIsDefault: false }), 'warifuri.cmd hook gate --home "C:\\data"');
  if (process.platform !== 'win32') {
    fs.writeFileSync(path.join(dir, 'warifuri'), '');
    fs.chmodSync(path.join(dir, 'warifuri'), 0o755);
    assert.equal(gateCommand({ env: { PATH: dir }, platform: 'linux', home: dir, homeIsDefault: true }), 'warifuri hook gate');
  }
  // Not on PATH: node and this package's bin, on every platform.
  assert.match(gateCommand({ env: { PATH: '' }, platform: 'win32', home: dir, homeIsDefault: true }), /warifuri\.mjs" hook gate$/);
});

test('a warifuri.env saved as UTF-16 is written back as UTF-8, with its lines kept', () => {
  const w = world({ harnesses: ['claude'] });
  const text = 'WARIFURI_GATE=on\r\n';
  fs.writeFileSync(path.join(w.data, 'warifuri.env'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
  const r = run(w, ['--device', 'laptop', '--no-skills']);
  assert.equal(r.status, 0, r.all);
  const now = fs.readFileSync(path.join(w.data, 'warifuri.env'), 'utf8');
  assert.ok(!now.includes('\0'), now);
  assert.match(now, /^WARIFURI_GATE=on\r?$/m);
  assert.match(now, /^WARIFURI_SERVER_URL=http:\/\/127\.0\.0\.1:8787$/m);
});
