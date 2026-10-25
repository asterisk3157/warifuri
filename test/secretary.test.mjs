// Tests for the secretary plug-in: the schedule math, the clock in serve (no overlap, no
// backlog), the runner's command line, and `warifuri secretary enable|disable|run` with a
// fake claude on PATH. The real claude is never started.

// Local times below are read in a zone with no daylight saving time.
process.env.TZ = 'Asia/Tokyo';

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { cli } from './cli.mjs';
import { openLedger } from '../src/ledger/ledger.mjs';
import { loadConfig } from '../src/config.mjs';
import { parseWhen, parseNight, inNight, latestSlot, nextSlot, countSlots, localIso } from '../src/secretary/schedule.mjs';
import { createScheduler } from '../src/secretary/scheduler.mjs';
import { runJob, claudeArgs, scheduleFrom, buildPrompt, writeMcpConfig, readSecretaryKey, paths } from '../src/secretary/secretary.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warifuri-secretary-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// 2026-10-25 is a Sunday.
const at = (s) => new Date(`${s}+09:00`);

test('times: daily, weekly and off; the night may cross midnight', () => {
  assert.deepEqual(parseWhen('23:00'), { days: null, hour: 23, minute: 0 });
  assert.deepEqual(parseWhen('sun 23:00'), { days: [0], hour: 23, minute: 0 });
  assert.deepEqual(parseWhen(' Thu,mon 07:30 '), { days: [1, 4], hour: 7, minute: 30 });
  assert.deepEqual(parseWhen('off'), { off: true });
  for (const bad of ['24:00', '7:00', 'sunday 23:00', 'sun mon 23:00', '']) assert.ok(parseWhen(bad).error, bad);
  const night = parseNight('23:00-07:00');
  assert.ok(inNight(night, at('2026-10-25T23:30:00')));
  assert.ok(inNight(night, at('2026-10-26T06:59:00')));
  assert.ok(!inNight(night, at('2026-10-26T07:00:00')));
  assert.ok(parseNight('07:00-07:00').error);
  assert.equal(localIso(at('2026-10-25T23:00:00')), '2026-10-25T23:00:00+09:00');
});

test('the latest and the next run, in local time, with Sunday-only jobs', () => {
  const nightly = parseWhen('23:00');
  const inbox = parseWhen('sun 23:00');
  assert.deepEqual(latestSlot(nightly, at('2026-10-25T22:59:30'), at('2026-10-25T23:00:00')), at('2026-10-25T23:00:00'));
  assert.equal(latestSlot(nightly, at('2026-10-25T23:00:00'), at('2026-10-25T23:00:30')), null);
  assert.deepEqual(latestSlot(inbox, at('2026-10-25T22:59:30'), at('2026-10-25T23:00:10')), at('2026-10-25T23:00:00'));
  assert.equal(latestSlot(inbox, at('2026-10-26T22:59:30'), at('2026-10-26T23:00:10')), null);
  assert.deepEqual(nextSlot(inbox, at('2026-10-26T08:00:00')), at('2026-11-01T23:00:00'));
  assert.deepEqual(nextSlot(parseWhen('07:00'), at('2026-10-25T23:00:00')), at('2026-10-26T07:00:00'));
  // Over a long gap, the latest run in it, and how many there were.
  assert.deepEqual(latestSlot(nightly, at('2026-10-20T12:00:00'), at('2026-10-25T12:00:00')), at('2026-10-24T23:00:00'));
  assert.equal(countSlots(nightly, at('2026-10-20T12:00:00'), at('2026-10-25T12:00:00')), 5);
  assert.equal(latestSlot(parseWhen('off'), at('2026-10-20T12:00:00'), at('2026-10-25T12:00:00')), null);
});

// A clock the test moves, and a run that resolves when the test says so.
function rig(jobsText = { nightly: '23:00', morning: '07:00', inbox: 'sun 23:00' }) {
  let t = at('2026-10-25T22:00:00');
  const lines = [];
  const started = [];
  const pending = [];
  const jobs = Object.fromEntries(Object.entries(jobsText).map(([k, v]) => [k, parseWhen(v)]));
  const s = createScheduler({
    jobs,
    now: () => t,
    log: (l) => lines.push(l),
    run: (job) => {
      started.push(job);
      return new Promise((resolve) => pending.push(() => resolve({ code: 0 })));
    },
    timers: { setInterval: () => ({}), clearInterval: () => {} },
  });
  s.start();
  const finish = async () => {
    pending.shift()();
    await new Promise((r) => setImmediate(r));
  };
  return { s, lines, started, pending, finish, set: (x) => (t = at(x)) };
}

test('jobs due together run one after another: the Sunday inbox waits for the nightly run', async () => {
  const r = rig();
  r.set('2026-10-25T22:59:40');
  assert.equal(r.s.tick(), null);
  r.set('2026-10-25T23:00:10');
  const done = r.s.tick();
  assert.deepEqual(r.started, ['nightly']);
  await r.finish();
  assert.deepEqual(r.started, ['nightly', 'inbox']);
  await r.finish();
  await done;
  assert.equal(r.s.busy, false);
  assert.ok(r.lines.some((l) => /nightly finished in \d+s \(exit 0\)/.test(l)), r.lines.join('\n'));
  // Monday: only the nightly run.
  r.set('2026-10-26T07:00:05');
  r.s.tick();
  r.set('2026-10-26T23:00:05');
  r.s.tick();
  assert.deepEqual(r.started, ['nightly', 'inbox', 'morning']);
});

test('a job that comes due while a run is still going is skipped with one line', async () => {
  const r = rig({ nightly: '23:00', morning: '07:00' });
  r.set('2026-10-25T23:00:05');
  r.s.tick();
  // The nightly run is still going at 07:00.
  r.set('2026-10-26T07:00:05');
  r.s.tick();
  assert.deepEqual(r.started, ['nightly']);
  assert.equal(r.lines.filter((l) => /morning skipped: the previous run is still going/.test(l)).length, 1);
  await r.finish();
  r.set('2026-10-26T23:00:05');
  r.s.tick();
  assert.deepEqual(r.started, ['nightly', 'nightly']);
});

test('no backlog after downtime: the latest missed run only, and only within the hour', async () => {
  // Times before the scheduler started never count.
  const fresh = rig({ nightly: '23:00' });
  fresh.set('2026-10-25T22:30:00');
  assert.equal(fresh.s.tick(), null);

  // Asleep from Sunday 22:00 to Tuesday 06:30: Sunday's and Monday's 23:00 are missed, and
  // the latest is over an hour late, so nothing runs.
  const long = rig({ nightly: '23:00' });
  long.set('2026-10-27T06:30:00');
  assert.equal(long.s.tick(), null);
  assert.deepEqual(long.started, []);
  assert.ok(long.lines.some((l) => /nightly of 2026-10-26T23:00:00\+09:00 was missed \(and 1 earlier\); not run now/.test(l)), long.lines.join('\n'));

  // Asleep until Monday 23:20: Sunday's is dropped and Monday's runs once.
  const short = rig({ nightly: '23:00' });
  short.set('2026-10-26T23:20:00');
  short.s.tick();
  assert.deepEqual(short.started, ['nightly']);
  assert.ok(short.lines.some((l) => /nightly: 1 earlier time was missed; only the latest runs/.test(l)));
  await short.finish();
});

// A data directory with the secretary's config, and a fake claude on PATH.
function world({ claude = true } = {}) {
  const root = fs.mkdtempSync(path.join(tmp, 'world-'));
  const home = path.join(root, 'data');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  const log = path.join(root, 'claude-calls.jsonl');
  // The fake claude records its arguments, its stdin and the connector variable, and prints a line.
  fs.writeFileSync(
    path.join(bin, 'fake.cjs'),
    `const fs = require('fs');
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), input, connectors: process.env.ENABLE_CLAUDEAI_MCP_SERVERS ?? null, warifuriEnv: Object.keys(process.env).filter((k) => k.startsWith('WARIFURI_')) }) + '\\n');
  console.log('fake claude: done');
});
`,
  );
  if (claude) {
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(bin, 'claude.cmd'), `@"${process.execPath}" "%~dp0fake.cjs" %*\r\n`);
    } else {
      fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, 'fake.cjs')}" "$@"\n`);
      fs.chmodSync(path.join(bin, 'claude'), 0o755);
    }
  }
  const sys = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: '.COM;.EXE;.BAT;.CMD' } : {};
  const dirs = [bin, ...(process.platform === 'win32' ? [path.join(process.env.SystemRoot, 'System32')] : [])];
  const env = { ...sys, PATH: dirs.join(path.delimiter) };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { root, home, bin, env, calls };
}

const read = (f) => fs.readFileSync(f, 'utf8');

test('enable refuses when claude is not on PATH, and writes nothing', () => {
  const w = world({ claude: false });
  const r = cli(['secretary', 'enable'], { home: w.home, env: w.env });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /claude \(Claude Code\) is not on PATH.*Nothing was scheduled/);
  assert.deepEqual(fs.readdirSync(w.home), []);
});

test('enable issues the key once, writes an owner-only config and turns the schedule on; disable undoes it', () => {
  const w = world();
  const r = cli(['secretary', 'enable'], { home: w.home, env: w.env });
  assert.equal(r.status, 0, r.stderr);
  const key = readSecretaryKey(w.home);
  assert.match(key, /^wf_/);
  assert.ok(!`${r.stdout}${r.stderr}`.includes(key));
  assert.match(r.stdout, /Log in to Claude Code once/);
  assert.match(r.stdout, /schedule: nightly 23:00, morning 07:00, inbox sun 23:00 \(night 23:00-07:00\)/);
  const mcp = paths(w.home).mcp;
  assert.equal(JSON.parse(read(mcp)).mcpServers.warifuri.url, 'http://127.0.0.1:8787/mcp');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(mcp).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(mcp)).mode & 0o777, 0o700);
  }
  assert.match(read(path.join(w.home, 'warifuri.env')), /^WARIFURI_SECRETARY=on$/m);
  let l = openLedger(path.join(w.home, 'ledger.sqlite'));
  assert.equal(l.deviceForKey(key).name, 'secretary');
  l.close();

  const again = cli(['secretary', 'enable'], { home: w.home, env: w.env });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /kept the key of device secretary/);
  assert.equal(readSecretaryKey(w.home), key);

  // A lost config gets a new key, and the old one stops working.
  fs.renameSync(mcp, `${mcp}.lost`);
  assert.equal(cli(['secretary', 'enable'], { home: w.home, env: w.env }).status, 0);
  const renewed = readSecretaryKey(w.home);
  assert.notEqual(renewed, key);

  const off = cli(['secretary', 'disable'], { home: w.home, env: w.env });
  assert.equal(off.status, 0, off.stderr);
  assert.match(read(path.join(w.home, 'warifuri.env')), /^WARIFURI_SECRETARY=off$/m);
  l = openLedger(path.join(w.home, 'ledger.sqlite'));
  assert.equal(l.deviceForKey(renewed), null);
  assert.equal(l.deviceForKey(key), null);
  l.close();
});

test('run starts claude with only warifuri tools, the connectors off, the key only in the config file', () => {
  const w = world();
  assert.equal(cli(['secretary', 'enable'], { home: w.home, env: w.env }).status, 0);
  const key = readSecretaryKey(w.home);
  const r = cli(['secretary', 'run', 'morning'], { home: w.home, env: { ...w.env, WARIFURI_GITHUB_CLIENT_SECRET: 'gh-secret' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /morning finished \(exit 0\); output in .*morning\.log/);
  const [call] = w.calls();
  assert.deepEqual(call.args, [
    '-p',
    '--mcp-config', paths(w.home).mcp,
    '--strict-mcp-config',
    '--allowedTools', 'mcp__warifuri',
    '--disallowedTools', call.args[7],
  ]);
  assert.match(call.args[7], /(^|,)Bash(,|$)/);
  assert.match(call.args[7], /(^|,)Write(,|$)/);
  assert.equal(call.connectors, 'false');
  assert.deepEqual(call.warifuriEnv, []);
  assert.match(call.input, /朝の報告\(`morning`\)/);
  assert.match(call.input, /期日は作りません/);
  // The key is in no argument, no output and no log.
  const logFile = path.join(paths(w.home).logs, 'morning.log');
  for (const text of [JSON.stringify(call.args), call.input, r.stdout, r.stderr, read(logFile)]) assert.ok(!text.includes(key));
  assert.match(read(logFile), /fake claude: done/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(paths(w.home).lock));

  // A second run keeps the one before as morning.prev.log.
  assert.equal(cli(['secretary', 'run', 'morning'], { home: w.home, env: w.env }).status, 0);
  assert.ok(fs.existsSync(path.join(paths(w.home).logs, 'morning.prev.log')));
  assert.equal(cli(['secretary', 'run', 'lunch'], { home: w.home, env: w.env }).status, 2);
});

test('run says what is missing: no config, or claude gone', () => {
  const w = world();
  const none = cli(['secretary', 'run', 'nightly'], { home: w.home, env: w.env });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /run warifuri secretary enable/);
  assert.equal(cli(['secretary', 'enable'], { home: w.home, env: w.env }).status, 0);
  const gone = cli(['secretary', 'run', 'nightly'], { home: w.home, env: { PATH: '' } });
  assert.equal(gone.status, 1);
  assert.match(gone.stderr, /not on PATH/);
});

test('a calendar is given only on purpose: its tools, and the connectors when turned on', () => {
  const base = scheduleFrom({});
  assert.equal(base.connectors, false);
  const cal = scheduleFrom({ WARIFURI_SECRETARY_CALENDAR_TOOLS: 'mcp__calendar, mcp__claude_ai_Google_Calendar', WARIFURI_SECRETARY_CONNECTORS: 'on' });
  const args = claudeArgs({ mcpFile: '/x/mcp.json', schedule: cal });
  assert.ok(!args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__warifuri,mcp__calendar,mcp__claude_ai_Google_Calendar');
  assert.match(buildPrompt('nightly', { schedule: cal }), /`mcp__calendar`/);
  assert.match(buildPrompt('nightly', { schedule: base }), /カレンダーの MCP はつながっていません/);
  const wrong = loadConfig({ env: { WARIFURI_HOME: tmp, WARIFURI_SECRETARY_CALENDAR_TOOLS: 'Bash' }, command: 'serve' });
  assert.ok(wrong.problems.some((p) => /WARIFURI_SECRETARY_CALENDAR_TOOLS must be MCP tool names/.test(p)));
});

test('the runner: connectors on leaves the variable out, a busy lock skips, a run past the limit is stopped', async () => {
  const w = world();
  const cfgFor = (env) => loadConfig({ env: { WARIFURI_HOME: w.home, ...env }, command: 'secretary' });
  writeMcpConfig(w.home, { url: 'http://127.0.0.1:8787/mcp', key: 'wf_test-key' });
  const seen = [];
  const fake = (close = true) => (file, args, options) => {
    const child = new EventEmitter();
    let input = '';
    child.stdin = new Writable({ write: (c, _e, cb) => ((input += c), cb()) });
    child.kill = () => setImmediate(() => child.emit('close', null, 'SIGTERM'));
    seen.push({ file, args, options, input: () => input });
    if (close) setImmediate(() => child.emit('close', 0, null));
    return child;
  };
  const on = await runJob('inbox', cfgFor({ WARIFURI_SECRETARY_CONNECTORS: 'on' }), { env: w.env, spawn: fake() });
  assert.equal(on.code, 0);
  assert.equal(seen[0].options.env.ENABLE_CLAUDEAI_MCP_SERVERS, undefined);
  assert.ok(!JSON.stringify(seen[0].args).includes('wf_test-key'));
  assert.ok(!JSON.stringify(seen[0].options.env).includes('wf_test-key'));
  const off = await runJob('inbox', cfgFor({}), { env: w.env, spawn: fake() });
  assert.equal(off.code, 0);
  assert.equal(seen[1].options.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
  assert.match(seen[1].input(), /受信箱の整理/);

  // Another live process holds the lock.
  fs.writeFileSync(paths(w.home).lock, `${process.pid}\n`);
  assert.deepEqual(await runJob('inbox', cfgFor({}), { env: w.env, spawn: fake() }), { busy: true });
  // A lock left by a process that is gone is taken over.
  fs.writeFileSync(paths(w.home).lock, '999999999\n');
  assert.equal((await runJob('inbox', cfgFor({}), { env: w.env, spawn: fake() })).code, 0);

  // The time limit, made short for the test, and serve stopping a run.
  const late = await runJob('nightly', cfgFor({}), { env: w.env, spawn: fake(false), timeoutMs: 20 });
  assert.equal(late.timedOut, true);
  const ctl = new AbortController();
  const stopped = runJob('nightly', cfgFor({}), { env: w.env, spawn: fake(false), signal: ctl.signal });
  await new Promise((r) => setImmediate(r));
  ctl.abort();
  const out = await stopped;
  assert.equal(out.signal, 'SIGTERM');
  assert.equal(out.timedOut, false);
});
