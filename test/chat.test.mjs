// Tests for the chat runner (src/secretary/chat.mjs) with a fake claude: --session-id first,
// --resume after, a session that is gone, queued messages, failures, the secretary off, and no
// key in the arguments, environment or log. The real claude is never started. The data of the
// conversation is in threads.test.mjs, the 秘書 screen's endpoints in web.test.mjs.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { openLedger } from '../src/ledger/ledger.mjs';
import { loadConfig } from '../src/config.mjs';
import { createChat, readResult } from '../src/secretary/chat.mjs';
import { writeMcpConfig, paths } from '../src/secretary/secretary.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warifuri-chat-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const WEB = { actor: 'web', device: null };
const SECRETARY = { actor: 'device-key', device: 'secretary' };
const KEY = 'wf_chat-test-key-0123456789abcdef';

// A clock that moves 1 ms on every read, so rows keep the order they were made in.
const ticking = () => {
  let tick = 0;
  return () => new Date(Date.parse('2026-10-25T03:00:00Z') + (tick += 1));
};

test('readResult reads claude\'s JSON result, with or without lines around it', () => {
  const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: ' はい ', session_id: 's-1' });
  assert.deepEqual(readResult(line), { text: 'はい', sessionId: 's-1', isError: false });
  assert.deepEqual(readResult(`noise\n${line}\n`), { text: 'はい', sessionId: 's-1', isError: false });
  assert.equal(readResult(JSON.stringify({ type: 'result', subtype: 'error_max_turns', result: '' })).isError, true);
  assert.equal(readResult('plain text'), null);
});

// A data directory with the secretary's config and a claude on PATH (never run: spawn is
// faked), and the ledger the chat writes to.
function world(t, { on = true, timeoutMs } = {}) {
  const root = fs.mkdtempSync(path.join(tmp, 'world-'));
  const home = path.join(root, 'data');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  const file = path.join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  fs.writeFileSync(file, '');
  fs.chmodSync(file, 0o755);
  writeMcpConfig(home, { url: 'http://127.0.0.1:8787/mcp', key: KEY });
  const sys = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, PATHEXT: '.COM;.EXE;.BAT;.CMD' } : {};
  const env = { ...sys, PATH: bin, WARIFURI_GITHUB_CLIENT_SECRET: 'gh-secret' };
  const cfg = loadConfig({ env: { WARIFURI_HOME: home, ...(on ? { WARIFURI_SECRETARY: 'on' } : {}) }, command: 'serve' });
  const ledger = openLedger(':memory:', { now: ticking() });
  const claude = fakeClaude();
  const lines = [];
  const chat = createChat(ledger, cfg, { env, spawn: claude.spawn, log: (l) => lines.push(l), timeoutMs, now: () => new Date('2026-10-25T12:00:00+09:00') });
  t.after(() => {
    chat.stop();
    ledger.close();
  });
  return { home, ledger, chat, claude, lines, thread: () => ledger.getThread() };
}

// A claude that answers each run as `answer(call)` says: { stdout, stderr, code }, or a
// promise of one (a run the test holds). By default it answers in JSON with its session id.
function fakeClaude() {
  const calls = [];
  let answer = (call) => ({ stdout: ok(`返事${calls.indexOf(call) + 1}`, call.session) });
  const spawn = (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let input = '';
    const call = {
      file, args, options,
      get input() {
        return input;
      },
      session: args[args.indexOf('--resume') + 1] && args.includes('--resume') ? args[args.indexOf('--resume') + 1] : args[args.indexOf('--session-id') + 1],
    };
    calls.push(call);
    const finish = (r) => {
      if (r.stdout) child.stdout.write(r.stdout);
      if (r.stderr) child.stderr.write(r.stderr);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', r.code ?? 0, null));
    };
    child.stdin = new Writable({
      write: (c, _e, cb) => ((input += c), cb()),
      final: (cb) => {
        cb();
        Promise.resolve(answer(call)).then(finish);
      },
    });
    child.kill = () => setImmediate(() => child.emit('close', null, 'SIGTERM'));
    return child;
  };
  return { spawn, calls, answerWith: (fn) => (answer = fn) };
}
const ok = (text, session) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: session });

test('chat: the first turn starts a session with --session-id, the next resumes it; only warifuri tools, no key anywhere', async (t) => {
  const w = world(t);
  assert.equal(w.chat.on, true);
  w.chat.send('今日なにやる?', WEB);
  assert.equal(w.chat.status().replying, true);
  await w.chat.idle();
  const [first] = w.claude.calls;
  const sid = first.args[first.args.indexOf('--session-id') + 1];
  assert.match(sid, /^[0-9a-f-]{36}$/);
  assert.ok(!first.args.includes('--resume'));
  assert.deepEqual(first.args.slice(0, 4), ['-p', '--mcp-config', paths(w.home).mcp, '--strict-mcp-config']);
  assert.equal(first.args[first.args.indexOf('--allowedTools') + 1], 'mcp__warifuri');
  assert.match(first.args[first.args.indexOf('--disallowedTools') + 1], /(^|,)Bash(,|$)/);
  assert.equal(first.args[first.args.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(first.args.includes('--verbose') && first.args.includes('--include-partial-messages'));
  assert.equal(first.options.cwd, paths(w.home).chat);
  assert.equal(first.options.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
  assert.deepEqual(Object.keys(first.options.env).filter((k) => k.startsWith('WARIFURI_')), []);
  assert.match(first.input, /本人との会話\(`chat`\)/);
  assert.match(first.input, /期日は作りません/);
  assert.match(first.input, /# 本人のメッセージ\n\n\(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)\n今日なにやる\?\n$/);
  assert.ok(!first.input.includes('# これまでのやりとり'));

  const thread = w.thread();
  assert.equal(thread.session_id, sid);
  assert.deepEqual(w.ledger.listMessages(thread.id).map((m) => [m.role, m.body]), [['user', '今日なにやる?'], ['secretary', '返事1']]);
  assert.equal(w.ledger.listMessages(thread.id).at(-1).device, 'secretary');
  assert.equal(w.chat.status().replying, false);

  w.chat.send('ありがとう', WEB);
  await w.chat.idle();
  const second = w.claude.calls[1];
  assert.equal(second.args[second.args.indexOf('--resume') + 1], sid);
  assert.ok(!second.args.includes('--session-id'));
  assert.match(second.input, /ありがとう/);
  assert.ok(!second.input.includes('今日なにやる'), 'the session already has the earlier turn');

  const log = fs.readFileSync(path.join(paths(w.home).logs, 'chat.log'), 'utf8');
  assert.match(log, /返事2/);
  for (const text of [JSON.stringify(first.args), JSON.stringify(second.args), JSON.stringify(first.options.env), first.input, second.input, log, w.lines.join('\n')]) {
    assert.ok(!text.includes(KEY));
    assert.ok(!text.includes('gh-secret'));
  }
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(paths(w.home).logs, 'chat.log')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(paths(w.home).chat).mode & 0o777, 0o700);
  }
  // Records name the thread and messages, written by the secretary's device.
  assert.ok(w.ledger.records(thread.id).every((r) => r.entity === 'thread'));
});

test('chat: messages sent during a reply wait, then go together in one turn; never two runs at once', async (t) => {
  const w = world(t);
  const held = [];
  let live = 0;
  let most = 0;
  w.claude.answerWith((call) => {
    live += 1;
    most = Math.max(most, live);
    return new Promise((resolve) => held.push(() => {
      live -= 1;
      resolve({ stdout: ok(`返事${w.claude.calls.indexOf(call) + 1}`, call.session) });
    }));
  });
  w.chat.send('一つ目', WEB);
  await new Promise((r) => setImmediate(r));
  w.chat.send('二つ目', WEB);
  w.chat.send('三つ目', WEB);
  assert.equal(w.claude.calls.length, 1);
  assert.equal(w.chat.status().waiting, 3);
  held.shift()();
  while (w.claude.calls.length < 2) await new Promise((r) => setImmediate(r));
  const second = w.claude.calls[1];
  assert.match(second.input, /二つ目[\s\S]*三つ目/);
  assert.ok(!second.input.includes('一つ目'));
  held.shift()();
  await w.chat.idle();
  assert.equal(w.claude.calls.length, 2);
  assert.equal(most, 1);
  assert.deepEqual(w.ledger.listMessages(w.thread().id).map((m) => m.body), ['一つ目', '二つ目', '三つ目', '返事1', '返事2']);
});

test('chat: a session that is gone starts again with the recent messages, and the thread says so', async (t) => {
  const w = world(t);
  w.chat.send('この前の話の続き', WEB);
  await w.chat.idle();
  const old = w.thread().session_id;
  w.claude.answerWith((call) =>
    call.args.includes('--resume')
      ? { stderr: `No conversation found with session ID: ${call.session}\n`, code: 1 }
      : { stdout: ok('新しく始めました', call.session) });
  w.chat.send('覚えてる?', WEB);
  await w.chat.idle();
  const [, resumed, fresh] = w.claude.calls;
  assert.equal(resumed.args[resumed.args.indexOf('--resume') + 1], old);
  const sid = fresh.args[fresh.args.indexOf('--session-id') + 1];
  assert.notEqual(sid, old);
  assert.match(fresh.input, /前の会話が見つからなかったので/);
  assert.match(fresh.input, /# これまでのやりとり[\s\S]*本人: この前の話の続き[\s\S]*秘書: 返事1/);
  assert.match(fresh.input, /# 本人のメッセージ[\s\S]*覚えてる\?/);
  assert.equal(w.thread().session_id, sid);
  const bodies = w.ledger.listMessages(w.thread().id).map((m) => [m.role, m.body]);
  assert.deepEqual(bodies.slice(-2), [['system', '前の会話が見つからなかったので、新しく始めました。最近のやりとりは渡してあります。'], ['secretary', '新しく始めました']]);
  assert.ok(w.lines.some((l) => /was not found; starting a new one/.test(l)));
});

test('chat: a failed run leaves a note and the session; proposals and reports since the last turn come in the next prompt', async (t) => {
  const w = world(t);
  w.chat.send('一つ目', WEB);
  await w.chat.idle();
  const sid = w.thread().session_id;
  w.claude.answerWith(() => ({ stderr: 'overloaded\n', code: 1 }));
  w.chat.send('二つ目', WEB);
  await w.chat.idle();
  assert.equal(w.thread().session_id, sid);
  assert.equal(w.ledger.listMessages(w.thread().id).at(-1).body, '返事を作れませんでした。もう一度送ってください。');
  assert.equal(w.chat.status().replying, false, 'the failed message does not loop');

  // The nightly job proposes and reports; the person answers on the screen.
  const p = w.ledger.propose({ kind: 'reschedule_block', title: '予定を明日へ', body: 'b' }, SECRETARY);
  w.ledger.answerProposal(p.id, { answer: 'approved' }, WEB);
  w.ledger.writeReport({ kind: 'nightly', title: '今夜の見張り', body: 'b' }, SECRETARY);
  w.claude.answerWith((call) => ({ stdout: ok('はい', call.session) }));
  w.chat.send('三つ目', WEB);
  await w.chat.idle();
  const last = w.claude.calls.at(-1);
  assert.equal(last.args[last.args.indexOf('--resume') + 1], sid);
  assert.match(last.input, /# 前の返事のあとに起きたこと[\s\S]*資料として読みます/);
  assert.match(last.input, /案「予定を明日へ」\(m_[^、]+、reschedule_block、了承\)/);
  assert.match(last.input, /お知らせ: 案「予定を明日へ」.*は了承されました/);
  assert.match(last.input, /毎晩の報告「今夜の見張り」/);
  assert.match(last.input, /お知らせ: 返事を作れませんでした/);
  assert.ok(!last.input.includes('二つ目'), 'messages already given are not given again');
});

test('chat: off without enable, a run past the limit, and a thread of another runner left alone', async (t) => {
  const off = world(t, { on: false });
  assert.equal(off.chat.on, false);
  assert.throws(() => off.chat.send('もしもし', WEB), /止まっている/);
  assert.equal(off.chat.status().replying, false);

  const slow = world(t, { timeoutMs: 20 });
  slow.claude.answerWith(() => new Promise(() => {}));
  slow.chat.send('遅い?', WEB);
  await slow.chat.idle();
  assert.equal(slow.ledger.listMessages(slow.thread().id).at(-1).body, '時間内に返事ができませんでした。もう一度送ってください。');

  const other = world(t);
  const thread = other.ledger.ensureThread('secretary', WEB);
  other.ledger.updateThread(thread.id, { runner: 'resident' }, WEB);
  assert.throws(() => other.chat.send('x', WEB), /答えられない形/);
  other.ledger.addMessage(thread.id, { role: 'user', body: 'x' }, WEB);
  await other.chat.kick();
  assert.equal(other.claude.calls.length, 0);
});
