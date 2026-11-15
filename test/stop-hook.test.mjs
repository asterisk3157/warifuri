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
import { decideStop, remindOnce, STATE_FILE } from '../src/client/stop-hook.mjs';
import { CAPTURE_REASON, hasDateWords, isLedgerWrite, lastSaying, unrecorded } from '../src/client/capture.mjs';

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

function home({ serverUrl = url, key = KEY, stop, capture } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'home-'));
  const lines = [];
  if (serverUrl) lines.push(`WARIFURI_SERVER_URL=${serverUrl}`);
  if (stop) lines.push(`WARIFURI_STOP=${stop}`);
  if (capture) lines.push(`WARIFURI_CAPTURE=${capture}`);
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

// --- the write-it-down check ---

const said = (text, uuid) => ({ type: 'user', uuid, message: { role: 'user', content: text } });
const used = (...names) => ({ type: 'assistant', message: { role: 'assistant', content: names.map((name) => ({ type: 'tool_use', id: name, name, input: {} })) } });
const answered = () => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } });
const replied = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

let nTranscript = 0;
function transcript(lines) {
  nTranscript += 1;
  const file = path.join(tmp, `t${nTranscript}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
}

test('date and deadline words are found; everyday words are not', () => {
  for (const t of ['資料は金曜までに出す', '締切は来週', '期限を決めた', '11/20 にやる', '１１／２０', '3日までに', '12月3日', '明日やる', '月末で', 'due next week', 'the deadline moved', 'by Friday', '2026-12-01 に']) {
    assert.ok(hasDateWords(t), t);
  }
  for (const t of ['ここまでで大丈夫', '今までどおり', 'この関数を直して', 'テストを足して', '', null]) {
    assert.ok(!hasDateWords(t), String(t));
  }
});

test('only warifuri\'s writing tools count as writing to the ledger', () => {
  assert.ok(isLedgerWrite('mcp__warifuri__create_task'));
  assert.ok(isLedgerWrite('mcp__plugin_x_warifuri__note'));
  assert.ok(!isLedgerWrite('mcp__warifuri__board'));
  assert.ok(!isLedgerWrite('mcp__warifuri__start'));
  assert.ok(!isLedgerWrite('mcp__other__create_task'));
  assert.ok(!isLedgerWrite('Edit'));
});

test('the last message is the person\'s, not tool results, reminders or hook feedback', () => {
  const lines = [
    said('締切は金曜', 'u1'),
    used('Read'),
    answered(),
    said('<system-reminder>来週の予定</system-reminder>'),
    { type: 'user', isMeta: true, message: { content: '明日' } },
    said('Stop hook feedback: 締切'),
    replied('はい'),
  ];
  assert.deepEqual(lastSaying(lines), { id: 'u1', text: '締切は金曜', wrote: false });
  assert.equal(lastSaying([...lines, used('mcp__warifuri__update')]).wrote, true);
  // A write before the message does not count for it.
  assert.equal(lastSaying([used('mcp__warifuri__update'), said('明日まで', 'u2')]).wrote, false);
  assert.equal(lastSaying([replied('x')]), null);
});

test('a date with nothing written blocks once per message, and a new message is asked again', async () => {
  const dir = home();
  const file = transcript([said('この資料は金曜までに出すことにした', 'm1'), replied('わかりました')]);
  const r = await stop(ending('free', 'c1', { transcript_path: file }), { dir });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
  assert.equal(out.reason, CAPTURE_REASON);
  // The same message is not asked about again, even in a later stop.
  assert.equal((await stop(ending('free', 'c1', { transcript_path: file }), { dir })).stdout, '');
  // A new message with a date is.
  fs.appendFileSync(file, `${JSON.stringify(said('締切は来週の水曜', 'm2'))}\n`);
  assert.equal(JSON.parse((await stop(ending('free', 'c1', { transcript_path: file }), { dir })).stdout).reason, CAPTURE_REASON);
});

test('no date words, or a write after the message: nothing is asked', async () => {
  const quiet = [
    transcript([said('この関数を直して', 'n1'), replied('直しました')]),
    transcript([said('締切は 11/20', 'n2'), used('mcp__warifuri__create_task'), answered(), replied('書きました')]),
    transcript([said('明日決める', 'n3'), used('mcp__warifuri__note')]),
  ];
  for (const f of quiet) assert.equal((await stop(ending('free', 'q', { transcript_path: f }))).stdout, '', f);
});

test('a transcript it cannot read lets the stop through', async () => {
  const codexLike = transcript([{ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '締切は明日' }] } }]);
  const garbage = transcript(['not json', '{"type":"user"']);
  for (const t of [path.join(tmp, 'missing.jsonl'), 'relative.jsonl', 42, null, codexLike, garbage, tmp]) {
    const r = await stop(ending('free', 'r', { transcript_path: t }));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', String(t));
  }
  assert.equal(unrecorded(path.join(tmp, 'missing.jsonl')), null);
});

test('WARIFURI_CAPTURE=off, or no key, never asks', async () => {
  const file = transcript([said('締切は明日', 'o1')]);
  for (const dir of [home({ capture: 'off' }), home({ key: null })]) {
    assert.equal((await stop(ending('free', 'o', { transcript_path: file }), { dir })).stdout, '');
  }
});

test('a held task and an unwritten date go in one reason', async () => {
  const file = transcript([said('期限は月末', 'h1')]);
  const out = JSON.parse((await stop(ending('held', 'both', { transcript_path: file }))).stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /「手引きを直す」/);
  assert.ok(out.reason.includes(CAPTURE_REASON));
});

test('decideStop asks about a message once, on any later day too', async () => {
  const stateFile = path.join(tmp, 'decide', STATE_FILE);
  const file = transcript([said('来週までに', 'd1')]);
  const fetchImpl = async () => new Response(JSON.stringify({ task: null, place: null }), { status: 200 });
  const settings = { url: 'http://x', key: 'k', stateFile };
  const payload = { session_id: 'd', cwd: tmp, transcript_path: file };
  assert.equal(JSON.parse(await decideStop(payload, settings, { fetchImpl, now: new Date(2026, 10, 15, 12) })).reason, CAPTURE_REASON);
  assert.equal(await decideStop(payload, settings, { fetchImpl, now: new Date(2026, 10, 16, 12) }), null);
});
