// Tests for the runner behind the secretary's window (src/secretary/chat.mjs, stream.mjs) with
// a fake claude: the reply read as it is written and the fallback to a whole reply, the steps
// and reply buttons kept with it, the answers to questions, warifuri's call in the morning and
// the night, threads with their own sessions and the digests queued in order for the main
// session, and files given to claude (pictures as image content). The real claude is never run.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { cli } from './cli.mjs';
import { openLedger } from '../src/ledger/ledger.mjs';
import { loadConfig } from '../src/config.mjs';
import { createChat } from '../src/secretary/chat.mjs';
import { createStreamReader, stepFor } from '../src/secretary/stream.mjs';
import { createScheduler } from '../src/secretary/scheduler.mjs';
import { parseWhen } from '../src/secretary/schedule.mjs';
import { writeMcpConfig, paths } from '../src/secretary/secretary.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warifuri-window-chat-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const WEB = { actor: 'web', device: null };
const SECRETARY = { actor: 'device-key', device: 'secretary' };
const KEY = 'wf_window-test-key-0123456789abcdef';
const SHA = 'b'.repeat(64);
const tick = () => new Promise((r) => setImmediate(r));

const ticking = () => {
  let n = 0;
  return () => new Date(Date.parse('2026-10-25T23:00:00Z') + (n += 1));
};

// Lines of claude's stream-json for one reply: a session, a tool call, words in pieces, the result.
const streamed = (text, session, { tools = [], pieces = 3 } = {}) => {
  const lines = [{ type: 'system', subtype: 'init', session_id: session }];
  for (const name of tools) {
    lines.push({ type: 'assistant', message: { content: [{ type: 'text', text: '確かめます' }, { type: 'tool_use', name, input: { secret: KEY } }] } });
  }
  const chars = [...text];
  const size = Math.ceil(chars.length / pieces);
  for (let i = 0; i < chars.length; i += size) {
    lines.push({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: chars.slice(i, i + size).join('') } } });
  }
  lines.push({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  lines.push({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: session });
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
};
const whole = (text, session) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: session });

test('the stream reader: words in pieces, whole messages, tool calls as steps, the result; tool arguments never pass', () => {
  const events = [];
  const r = createStreamReader({ onEvent: (e) => events.push(e) });
  const out = streamed('はい、置きました。', 's-1', { tools: ['mcp__warifuri__schedule', 'mcp__warifuri__reply_options', 'mcp__calendar__list'] });
  // Cut anywhere: a line may come in two chunks.
  r.push(out.slice(0, 50));
  r.push(out.slice(50));
  const end = r.end();
  assert.deepEqual(end.result, { text: 'はい、置きました。', sessionId: 's-1', isError: false });
  assert.equal(end.streamed, true);
  assert.deepEqual(end.steps.map((s) => [s.kind, s.label]), [
    ['say', '確かめます'], ['read', '予定を読みました'], ['say', '確かめます'], ['say', '確かめます'], ['tool', 'ツールを使いました'],
  ]);
  const texts = events.filter((e) => e.type === 'text').map((e) => e.text).filter(Boolean);
  assert.equal(texts.at(-1), 'はい、置きました。', 'the whole message after the pieces does not double the words');
  assert.ok(texts.length >= 3);
  assert.ok(!JSON.stringify(events).includes(KEY));

  // Without the pieces (an older claude), the words come a message at a time; with json, only the result.
  const older = createStreamReader();
  older.push(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'まとめて' }] } })}\n${whole('まとめて', 's-2')}`);
  const o = older.end();
  assert.deepEqual([o.text, o.streamed, o.result.text], ['まとめて', false, 'まとめて']);
  const json = createStreamReader();
  json.push(whole('はい', 's-3'));
  assert.deepEqual(json.end().result, { text: 'はい', sessionId: 's-3', isError: false });
  assert.deepEqual(stepFor('mcp__warifuri__free_time'), { kind: 'search', label: '空き時間を探しました' });
  assert.equal(stepFor('mcp__warifuri__reply_options'), null);
});

// A data directory with the secretary's config and a claude on PATH (never run: spawn is faked).
function world(t, { values = {}, now } = {}) {
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
  const env = { ...sys, PATH: bin };
  const cfg = loadConfig({ env: { WARIFURI_HOME: home, WARIFURI_SECRETARY: 'on', ...values }, command: 'serve' });
  const ledger = openLedger(':memory:', { now: ticking() });
  const claude = fakeClaude();
  const lines = [];
  const clock = { now: now ?? new Date(2026, 9, 26, 7, 0, 0) };
  const chat = createChat(ledger, cfg, { env, spawn: claude.spawn, log: (l) => lines.push(l), now: () => clock.now });
  const events = [];
  chat.subscribe((e) => events.push(e));
  t.after(() => {
    chat.stop();
    ledger.close();
  });
  return { home, ledger, chat, claude, lines, events, clock, main: () => ledger.getThread() };
}

// A claude that answers each run as answer(call) says; by default it streams 返事N.
function fakeClaude() {
  const calls = [];
  let answer = (call) => ({ stdout: streamed(`返事${calls.indexOf(call) + 1}`, call.session) });
  const spawn = (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let input = '';
    const at = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
    const call = {
      args, options, at,
      get input() {
        return input;
      },
      session: at('--resume') ?? at('--session-id'),
      mcp: at('--mcp-config'),
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
        Promise.resolve(answer(call, child)).then(finish);
      },
    });
    child.kill = () => setImmediate(() => child.emit('close', null, 'SIGTERM'));
    return child;
  };
  return { spawn, calls, answerWith: (fn) => (answer = fn) };
}

test('live replies: the dots, then the words as they come, then the stored reply with its steps; no key in any event', async (t) => {
  const w = world(t);
  let release;
  w.claude.answerWith((call, child) => new Promise((resolve) => {
    // Half the reply first, the rest when the test lets it go.
    const all = streamed('今日は予定がありません。置きますか？', call.session, { tools: ['mcp__warifuri__schedule'] }).split('\n');
    child.stdout.write(`${all.slice(0, 4).join('\n')}\n`);
    release = () => resolve({ stdout: `${all.slice(4).join('\n')}` });
  }));
  w.chat.send('今日の予定は？', WEB);
  while (!release) await tick();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(w.chat.status().replying, true);
  const [first] = w.events;
  assert.deepEqual([first.type, first.phase, first.text, first.thread], ['live', 'thinking', '', w.main().id]);
  const now = w.chat.live();
  assert.equal(now.length, 1);
  assert.equal(now[0].phase, 'writing');
  assert.ok(now[0].text.length > 0 && now[0].text.length < '今日は予定がありません。置きますか？'.length);
  assert.deepEqual(now[0].steps.map((s) => s.label), ['確かめます', '予定を読みました']);
  release();
  await w.chat.idle();
  const done = w.events.at(-1);
  assert.equal(done.type, 'done');
  const reply = w.ledger.getMessage(done.message);
  assert.equal(reply.body, '今日は予定がありません。置きますか？');
  assert.deepEqual(reply.data.steps.map((s) => s.kind), ['say', 'read']);
  assert.equal(w.chat.live().length, 0);
  assert.ok(!JSON.stringify(w.events).includes(KEY));
  const call = w.claude.calls[0];
  assert.equal(call.at('--output-format'), 'stream-json');
  assert.ok(call.args.includes('--include-partial-messages'));
  assert.ok(!call.args.includes('--input-format'), 'plain text goes in as text');
});

test('fallback: a claude that does not know the streaming flags is asked again for a whole reply, and not asked to stream again', async (t) => {
  const w = world(t);
  w.claude.answerWith((call) =>
    call.args.includes('--include-partial-messages')
      ? { stderr: "error: unknown option '--include-partial-messages'\n", code: 1 }
      : { stdout: whole('まとめて返します', call.session) });
  w.chat.send('一つ目', WEB);
  await w.chat.idle();
  assert.deepEqual(w.claude.calls.map((c) => c.at('--output-format')), ['stream-json', 'json']);
  assert.equal(w.claude.calls[0].session, w.claude.calls[1].session, 'the same session is asked again');
  assert.equal(w.ledger.listMessages(w.main().id).at(-1).body, 'まとめて返します');
  assert.ok(w.lines.some((l) => /does not stream its reply/.test(l)));
  w.chat.send('二つ目', WEB);
  await w.chat.idle();
  assert.equal(w.claude.calls.at(-1).at('--output-format'), 'json');
  assert.equal(w.claude.calls.length, 3);
});

test('reply buttons asked for during a turn go with its reply, and are cleared for the next', async (t) => {
  const w = world(t);
  w.claude.answerWith((call) => {
    if (w.claude.calls.length === 1) w.ledger.setReplyOptions(w.main().id, ['置いて', '今日は置かない'], SECRETARY);
    return { stdout: streamed('2時間置けます。置いておきますか？', call.session) };
  });
  w.chat.send('今日の予定は？', WEB);
  await w.chat.idle();
  const reply = w.ledger.listMessages(w.main().id).at(-1);
  assert.deepEqual(reply.data.options, ['置いて', '今日は置かない']);
  assert.equal(w.main().pending_options, null);
  w.chat.send('置いて', WEB);
  await w.chat.idle();
  assert.equal(w.ledger.listMessages(w.main().id).at(-1).data?.options, undefined);
});

test('answers: an answer starts a turn and comes in the prompt; a changed answer asks to undo the old one first', async (t) => {
  const w = world(t);
  const a = w.ledger.ask({ questions: [{ header: 'タスク整理', question: '「調べもの」はどうしますか？', options: [{ label: '残す' }, { label: '閉じる' }], kind: 'close_forgotten' }] }, SECRETARY);
  w.chat.answer(a.id, { index: 0, picked: ['残す'] }, WEB);
  await w.chat.idle();
  assert.match(w.claude.calls[0].input, /質問「タスク整理」\(「調べもの」はどうしますか？\)への答え: 残す\n$/);
  w.chat.answer(a.id, { index: 0, picked: ['閉じる'] }, WEB);
  await w.chat.idle();
  const input = w.claude.calls[1].input;
  assert.match(input, /お知らせ: 「タスク整理」の答えを「残す」から「閉じる」に変えました/);
  assert.match(input, /への答えを変えました: 閉じる\n前の答えで行ったことを取り消してから、新しい答えのとおりに行います。/);
  assert.equal(w.ledger.listAutonomy().kinds.find((k) => k.kind === 'close_forgotten').revokes, 1);
  // Its own questions are not given back to the session.
  assert.ok(!input.includes('【タスク整理】'));
});

test('answers: the secretary is woken once every question of the card is answered, with all the answers together', async (t) => {
  const w = world(t);
  const a = w.ledger.ask({ questions: [
    { header: 'タスク整理', question: '「調べもの」はどうしますか？', options: [{ label: '残す' }, { label: '閉じる' }] },
    { header: '期日', question: '期日はどうしますか？', options: [{ label: '今日のまま' }, { label: '延ばす' }] },
  ] }, SECRETARY);
  w.chat.answer(a.id, { index: 0, picked: ['残す'] }, WEB);
  await w.chat.idle();
  assert.equal(w.claude.calls.length, 0, 'not woken for the first answer');
  // The clock looks into the conversation every 30 seconds: it does not start a turn for it either.
  await w.chat.kick();
  assert.equal(w.claude.calls.length, 0, 'not woken by the clock while a question is open');
  assert.equal(w.chat.status().waiting, 0);
  w.chat.answer(a.id, { index: 1, picked: ['延ばす'] }, WEB);
  await w.chat.idle();
  assert.equal(w.claude.calls.length, 1);
  const input = w.claude.calls[0].input;
  assert.match(input, /質問「タスク整理」\(「調べもの」はどうしますか？\)への答え: 残す/);
  assert.match(input, /質問「期日」\(期日はどうしますか？\)への答え: 延ばす/);
});

test('answers: while another card in the conversation is still waiting, answering one does not wake the secretary', async (t) => {
  const w = world(t);
  const Qs = (header) => ({ header, question: `${header}はどうしますか？`, options: [{ label: '残す' }, { label: '閉じる' }] });
  // A card put off with あとで lets the next one come, so two can be waiting at once.
  const a = w.ledger.ask({ questions: [Qs('期日')] }, SECRETARY);
  w.ledger.answerAsk(a.id, { later: true }, WEB);
  const b = w.ledger.ask({ questions: [Qs('やってみたい')] }, SECRETARY);
  w.chat.answer(a.id, { index: 0, picked: ['残す'] }, WEB);
  await w.chat.idle();
  assert.equal(w.claude.calls.length, 0, 'the other card is still waiting');
  w.chat.answer(b.id, { index: 0, picked: ['閉じる'] }, WEB);
  await w.chat.idle();
  assert.equal(w.claude.calls.length, 1);
  assert.match(w.claude.calls[0].input, /質問「期日」\(期日はどうしますか？\)への答え: 残す/);
  assert.match(w.claude.calls[0].input, /質問「やってみたい」\(やってみたいはどうしますか？\)への答え: 閉じる/);
});

test('the morning: a call into the same session, answered with the morning\'s instructions and marked as scheduled; not in the night', async (t) => {
  const w = world(t);
  w.chat.send('おはよう', WEB);
  await w.chat.idle();
  const sid = w.main().session_id;
  const out = w.chat.trigger('morning');
  assert.equal(out.sent.kind, 'trigger');
  assert.equal(out.sent.body, '朝の時間です');
  await w.chat.idle();
  const call = w.claude.calls[1];
  assert.equal(call.at('--resume'), sid, 'the morning resumes the conversation\'s session');
  assert.match(call.input, /# 決まった時刻の仕事[\s\S]*「朝の時間です」[\s\S]*# 朝の時間\(morning\)/);
  assert.ok(!call.input.includes('# 本人のメッセージ'));
  const reply = w.ledger.listMessages(w.main().id).at(-1);
  assert.deepEqual([reply.role, reply.data.scheduled], ['secretary', 'morning']);

  w.clock.now = new Date(2026, 9, 26, 23, 30, 0);
  assert.deepEqual(w.chat.trigger('morning'), { skipped: 'it is the night' });
  w.clock.now = new Date(2026, 9, 27, 6, 59, 0);
  assert.deepEqual(w.chat.trigger('morning'), { skipped: 'it is the night' });
  assert.ok(w.chat.trigger('morning', { force: true }).sent);
  await w.chat.idle();

  // The clock sends it at the morning's time and logs one line; the nightly run stays a run of its own.
  const ran = [];
  const logs = [];
  let at = new Date(2026, 9, 27, 6, 59, 30);
  let ticks = 0;
  const s = createScheduler({
    jobs: { nightly: parseWhen('23:00'), morning: parseWhen('07:00'), inbox: parseWhen('off') },
    now: () => at,
    log: (l) => logs.push(l),
    onTick: () => (ticks += 1),
    run: async (job) => (ran.push(job), job === 'morning' ? w.chat.trigger(job) : { code: 0 }),
  });
  s.start();
  s.stop();
  at = new Date(2026, 9, 27, 7, 0, 10);
  w.clock.now = at;
  await s.tick();
  assert.deepEqual(ran, ['morning']);
  assert.equal(ticks, 1);
  assert.ok(logs.includes('secretary: morning sent into the conversation'));
  await w.chat.idle();
  const nightOnly = createScheduler({ jobs: { nightly: parseWhen('off'), morning: parseWhen('23:30'), inbox: parseWhen('off') }, now: () => at, log: (l) => logs.push(l), run: async () => w.chat.trigger('morning') });
  nightOnly.start();
  at = new Date(2026, 9, 27, 23, 30, 10);
  w.clock.now = at;
  await nightOnly.tick();
  nightOnly.stop();
  assert.ok(logs.includes('secretary: morning not sent: it is the night'));
});

test('warifuri secretary run morning writes the call into the conversation for serve to answer', () => {
  const home = fs.mkdtempSync(path.join(tmp, 'cli-'));
  const r = cli(['secretary', 'run', 'morning'], { home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /sent 朝の時間です into the conversation/);
  const L = openLedger(path.join(home, 'ledger.sqlite'));
  const [m] = L.listMessages(L.getThread().id);
  assert.deepEqual([m.kind, m.role, m.data.job, m.actor], ['trigger', 'system', 'morning', 'cli']);
  L.close();
});

test('threads: their own session and MCP config naming the thread; each exchange queues a digest that the main session takes, in order, without a visible reply', async (t) => {
  const w = world(t);
  w.chat.send('おはよう', WEB);
  await w.chat.idle();
  const main = w.main();
  const parent = w.ledger.listMessages(main.id).at(-1);
  const sub = w.ledger.openThread(parent.id, WEB);

  // The main session is busy while two exchanges happen in the thread.
  const held = [];
  w.claude.answerWith((call) => (call.mcp === paths(w.home).mcp && call.input.includes('メインの話')
    ? new Promise((resolve) => held.push(() => resolve({ stdout: streamed('メインの返事', call.session) })))
    : { stdout: streamed(call.mcp === paths(w.home).mcp ? '了解' : `スレッドの返事${w.claude.calls.length}`, call.session) }));
  w.chat.send('メインの話', WEB);
  while (!held.length) await tick();
  w.chat.send('先に残りを教えて', WEB, { thread: sub.id });
  await w.chat.kick(sub.id);
  w.chat.send('どれから？', WEB, { thread: sub.id });
  await w.chat.kick(sub.id);
  const subCalls = w.claude.calls.filter((c) => c.mcp === paths(w.home).threadMcp(sub.id));
  assert.equal(subCalls.length, 2, w.lines.join('\n'));
  assert.ok(subCalls[0].at('--session-id'));
  assert.notEqual(subCalls[0].session, main.session_id, 'a thread has its own session');
  assert.equal(subCalls[1].at('--resume'), subCalls[0].session);
  assert.match(subCalls[0].input, /スレッドでの会話\(`thread`\)/);
  assert.match(subCalls[0].input, /# スレッドの元の発言[\s\S]*返事1/);
  const config = JSON.parse(fs.readFileSync(paths(w.home).threadMcp(sub.id), 'utf8'));
  assert.equal(config.mcpServers.warifuri.headers['X-Warifuri-Thread'], sub.id);
  if (process.platform !== 'win32') assert.equal(fs.statSync(paths(w.home).threadMcp(sub.id)).mode & 0o777, 0o600);

  // Two digests wait in the main thread, in order, while its reply is being made.
  const digests = () => w.ledger.listMessages(main.id).filter((m) => m.kind === 'digest');
  assert.equal(digests().length, 2);
  assert.match(digests()[0].body, /^スレッド「返事1」\(c_[^)]+\)で 本人: 先に残りを教えて 秘書: スレッドの返事\d+$/);
  assert.match(digests()[1].body, /本人: どれから？/);
  const mainCalls = () => w.claude.calls.filter((c) => c.mcp === paths(w.home).mcp);
  assert.equal(mainCalls().length, 2, 'nothing else ran in the main session yet');
  held.shift()();
  await w.chat.idle();
  assert.equal(mainCalls().length, 3);
  const ingest = mainCalls()[2];
  assert.match(ingest.input, /# スレッドで話したこと[\s\S]*先に残りを教えて[\s\S]*どれから？/);
  assert.match(ingest.input, /返事は本人に見えません/);
  // No reply of the digests' turn in the main window; the thread's counts.
  const visible = w.ledger.listMessages(main.id).filter((m) => m.role === 'secretary').map((m) => m.body);
  assert.deepEqual(visible, ['返事1', 'メインの返事']);
  assert.deepEqual(w.ledger.threadCounts()[parent.id], { id: sub.id, count: 4, unread: 2 });
  assert.equal(w.main().seen_until, digests()[1].id);
});

test('files: a picture goes as image content through stream-json input, a text file\'s words in the prompt, another file by name', async (t) => {
  const w = world(t);
  const dir = paths(w.home).uploads;
  fs.mkdirSync(dir, { recursive: true });
  const put = (name, type, bytes) => {
    const a = w.ledger.addAttachment({ name, type, size: bytes.length, sha256: SHA }, WEB);
    fs.writeFileSync(path.join(dir, a.id), bytes);
    return a.id;
  };
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const ids = [put('時間割.png', 'image/png', png), put('メモ.md', 'text/markdown', Buffer.from('# 月曜\n授業は午前')), put('表.pdf', 'application/pdf', Buffer.from('%PDF-1.7'))];
  w.chat.send('この時間割、来週の予定に入れておいて', WEB, { attachments: ids });
  await w.chat.idle();
  const call = w.claude.calls[0];
  assert.equal(call.at('--input-format'), 'stream-json');
  const sent = JSON.parse(call.input.trim());
  assert.equal(sent.type, 'user');
  const [text, image] = sent.message.content;
  assert.equal(image.type, 'image');
  assert.deepEqual(image.source, { type: 'base64', media_type: 'image/png', data: png.toString('base64') });
  assert.match(text.text, /# 添えられたファイル[\s\S]*## メモ\.md[\s\S]*授業は午前/);
  assert.ok(!text.text.includes('%PDF'), 'a file that is not text goes by name only');
  assert.match(text.text, /\(ファイルを添えました: 表\.pdf、1 KB\)/);
  assert.match(text.text, /\(ファイルを添えました: 時間割\.png、1 KB\)/);
  assert.ok(!fs.readFileSync(path.join(paths(w.home).logs, 'chat.log'), 'utf8').includes(png.toString('base64')), 'the picture is not in the log');

  // A claude that does not take stream-json input gets the names of the pictures only.
  w.claude.answerWith((c) => (c.args.includes('--input-format') ? { stderr: "error: option '--input-format <format>' argument 'stream-json' is invalid\n", code: 1 } : { stdout: streamed('はい', c.session) }));
  const again = put('2枚目.png', 'image/png', png);
  w.chat.send('これも', WEB, { attachments: [again] });
  await w.chat.idle();
  const last = w.claude.calls.at(-1);
  assert.ok(!last.args.includes('--input-format'));
  assert.match(last.input, /画像 2枚目\.png は、この claude には渡せませんでした/);
  assert.equal(w.ledger.listMessages(w.main().id).at(-1).body, 'はい');
});

test('an agent\'s request: it starts a turn with the request and its conditions, and the agent gets the reply', async (t) => {
  const w = world(t);
  const LAPTOP = { actor: 'device-key', device: 'laptop' };
  const out = await w.chat.request({ from: 'laptop', text: '資料作りに時間を取ってください', task_id: 't_1', minutes: 120, by: '2026-10-30', prefer: '午前' }, LAPTOP);
  assert.equal(out.timedOut, undefined);
  assert.equal(out.reply.body, '返事1');
  assert.equal(out.request.role, 'system');
  assert.equal(out.request.data.request.from, 'laptop');
  const input = w.claude.calls[0].input;
  assert.match(input, /# エージェントからの依頼/);
  assert.match(input, /laptop のエージェントからの依頼: 資料作りに時間を取ってください\nタスク: t_1\n長さ: 120分\n期限: 2026-10-30\n希望: 午前/);
  // The person sees the request and the reply in the conversation.
  const rows = w.ledger.listMessages(w.main().id);
  assert.deepEqual(rows.map((m) => m.role), ['system', 'secretary']);
});

test('an agent\'s request: past the wait the agent is told it waits; the request stays and gets its reply', async (t) => {
  const w = world(t);
  let release;
  w.claude.answerWith((call) => new Promise((resolve) => {
    release = () => resolve({ stdout: streamed('金曜の10時に入れました', call.session) });
  }));
  const out = await w.chat.request({ from: 'laptop', text: '2時間ください' }, WEB, { waitMs: 5 });
  assert.equal(out.timedOut, true);
  assert.equal(w.chat.status().replying, true);
  release();
  await w.chat.idle();
  assert.equal(w.ledger.listMessages(w.main().id).at(-1).body, '金曜の10時に入れました');
});

test('an agent\'s request: refused with the secretary off, and without words', async (t) => {
  const w = world(t);
  await assert.rejects(w.chat.request({ from: 'laptop', text: '  ' }, WEB), /頼むことを text に書きます/);
  const off = world(t, { values: { WARIFURI_SECRETARY: 'off' } });
  await assert.rejects(off.chat.request({ from: 'laptop', text: '2時間ください' }, WEB), /秘書が止まっているので、頼めません/);
});
