// Tests for the end-of-work reminder: `warifuri hook stop` against a stub server answering
// /api/held, once per conversation and task, and letting the stop through when it cannot ask.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CLI, cliEnv } from './cli.mjs';
import { remindOnce, STATE_FILE } from '../src/client/stop-hook.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warifuri-stop-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const KEY = 'wf_stop-test-key-0123456789';
const work = path.join(tmp, 'work');
for (const d of ['held', 'free', 'outside', 'boom']) fs.mkdirSync(path.join(work, d), { recursive: true });

const asked = [];
let server;
let url;
before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const dir = u.searchParams.get('dir') ?? '';
    asked.push({ path: u.pathname, dir, auth: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${KEY}`) return res.writeHead(401).end();
    const last = path.basename(dir);
    const place = { id: 'p1', name: 'work', profile: 'hobby' };
    if (last === 'boom') return res.writeHead(500).end('{}');
    const body = last === 'held' ? { task: { id: 't1', title: '手引きを直す' }, place } : last === 'outside' ? { task: null, place: null } : { task: null, place };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

function home({ serverUrl = url, key = KEY, stop } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'home-'));
  const lines = [];
  if (serverUrl) lines.push(`WARIFURI_SERVER_URL=${serverUrl}`);
  if (stop) lines.push(`WARIFURI_STOP=${stop}`);
  fs.writeFileSync(path.join(dir, 'warifuri.env'), `${lines.join('\n')}\n`);
  if (key) fs.writeFileSync(path.join(dir, 'device.key'), `${key}\n`, { mode: 0o600 });
  return dir;
}

function stop(payload, { dir = home() } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', CLI, 'hook', 'stop'], { env: cliEnv({ home: dir }) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

const ending = (sub, session = 's1', extra = {}) => ({ hook_event_name: 'Stop', session_id: session, cwd: path.join(work, sub), stop_hook_active: false, ...extra });

test('a held task blocks the stop once, with what to do, and the key goes in the header', async () => {
  const dir = home();
  asked.length = 0;
  const r = await stop(ending('held'), { dir });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /「手引きを直す」\(t1\)/);
  assert.match(out.reason, /作業フォルダ「work」/);
  assert.match(out.reason, /close/);
  assert.match(out.reason, /release/);
  assert.match(out.reason, /next/);
  assert.deepEqual(asked.map((a) => [a.path, a.dir, a.auth]), [['/api/held', path.join(work, 'held'), `Bearer ${KEY}`]]);
  assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY));

  // The same conversation is not asked again; another conversation is.
  assert.equal((await stop(ending('held'), { dir })).stdout, '');
  assert.equal(JSON.parse((await stop(ending('held', 's2'), { dir })).stdout).decision, 'block');
  const state = JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8'));
  assert.deepEqual(Object.keys(state).sort(), ['s1 t1', 's2 t1']);
});

test('a stop already sent back by a Stop hook goes through without asking', async () => {
  asked.length = 0;
  const r = await stop(ending('held', 's3', { stop_hook_active: true }));
  assert.equal(r.stdout, '');
  assert.equal(asked.length, 0);
});

test('no held task, no place, or nothing to read: the stop goes through', async () => {
  for (const p of [ending('free'), ending('outside'), 'not json', '', { session_id: 'x' }, { cwd: 'relative' }]) {
    const r = await stop(p);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
});

test('fails open: no key, no URL, stop off, server errors, server down', async () => {
  for (const dir of [home({ key: null }), home({ serverUrl: null }), home({ stop: 'off' }), home({ key: 'wf_wrong' })]) {
    const r = await stop(ending('held'), { dir });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', r.stderr);
  }
  assert.equal((await stop(ending('boom'))).stdout, '');
  const closed = http.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const dead = `http://127.0.0.1:${closed.address().port}`;
  await new Promise((r) => closed.close(r));
  assert.equal((await stop(ending('held'), { dir: home({ serverUrl: dead }) })).stdout, '');
});

test('reminders are forgotten after a week', () => {
  const file = path.join(tmp, 'state', STATE_FILE);
  assert.equal(remindOnce(file, 'a', 't', new Date('2026-01-01T00:00:00Z')), true);
  assert.equal(remindOnce(file, 'a', 't', new Date('2026-01-02T00:00:00Z')), false);
  assert.equal(remindOnce(file, 'b', 't', new Date('2026-01-10T00:00:00Z')), true);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), ['b t']);
  // No session id: it cannot remember, so it reminds.
  assert.equal(remindOnce(file, null, 't'), true);
});
