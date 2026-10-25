// Tests for the endpoints of the secretary's window (src/server/web.mjs): the event stream of
// replies being written (login, and nothing but words and the kinds of steps), messages with
// files and in threads, answers to questions, threads and their unread counts, and uploads
// (login, this origin only, the size cap, owner-only files). The chat is a stand-in here; the
// runner is tested in window-chat.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openLedger } from '../src/ledger/ledger.mjs';
import { createServer } from '../src/server/mcp.mjs';
import { UPLOAD_MAX } from '../src/server/web.mjs';
import { paths } from '../src/secretary/secretary.mjs';

const WEB = { actor: 'web', device: null };
const S = { actor: 'device-key', device: 'secretary' };
const SECRET = 'wf_should-never-leave-0123456789';

// A chat that stores what is sent as the real one does, and lets the test speak as the runner.
function stubChat(ledger) {
  const listeners = new Set();
  const live = [];
  const sent = [];
  return {
    on: true,
    sent,
    live: () => live,
    setLive: (l) => live.splice(0, live.length, ...l),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit: (e) => listeners.forEach((fn) => fn(e)),
    listeners,
    send(text, writer, { thread, attachments } = {}) {
      sent.push({ text, thread, attachments });
      const id = thread ?? ledger.ensureThread('secretary', writer).id;
      return ledger.addMessage(id, { role: 'user', body: text, ...(attachments?.length ? { attachments } : {}) }, writer);
    },
    answer: (id, fields, writer) => ledger.answerAsk(id, fields, writer),
    status: () => ({ on: true, replying: false, waiting: 0 }),
    replying: () => false,
  };
}

async function start(t, options = {}) {
  let tick = 0;
  const ledger = openLedger(':memory:', { now: () => new Date(Date.now() + (tick += 1)) });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-window-'));
  const chat = options.chat === null ? null : stubChat(ledger);
  const server = createServer({ ledger, home, chat, ...options.server });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    ledger.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const post = (p, body, headers = {}) =>
    fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { base, ledger, home, chat, server, post };
}

// Reads an event stream until `until` has come, then stops.
async function readEvents(base, p, { headers = {}, until, act } = {}) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}${p}`, { headers, signal: ctrl.signal });
  if (res.status !== 200) return { status: res.status, text: await res.text(), headers: res.headers };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  let acted = false;
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value);
      if (!acted && text.includes('event: hello')) {
        acted = true;
        await act?.();
      }
      if (until(text)) break;
    }
  } catch {
    // aborted
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
  const events = text.split('\n\n').filter((b) => b.startsWith('event: ')).map((b) => {
    const [ev, data] = b.split('\n');
    return { event: ev.slice(7), data: JSON.parse(data.slice(6)) };
  });
  return { status: res.status, text, events, headers: res.headers };
}

test('the event stream: what is being written now, then each piece and the end; only words and the kinds of steps', async (t) => {
  const { base, chat } = await start(t);
  chat.setLive([{ thread: 'c_1', phase: 'writing', text: 'いま', steps: [{ kind: 'read', label: '予定を読みました', input: SECRET }], scheduled: null }]);
  const out = await readEvents(base, '/web/api/secretary/stream', {
    act: () => {
      chat.emit({ type: 'live', thread: 'c_1', phase: 'writing', text: 'いま書いて', steps: [{ kind: 'read', label: '予定を読みました', input: { key: SECRET } }], scheduled: 'morning', extra: SECRET });
      chat.emit({ type: 'done', thread: 'c_1', message: 'm_x', secret: SECRET });
    },
    until: (t) => t.includes('event: done'),
  });
  assert.equal(out.status, 200);
  assert.match(out.headers.get('content-type'), /^text\/event-stream/);
  assert.equal(out.headers.get('cache-control'), 'no-store');
  assert.deepEqual(out.events.map((e) => e.event), ['hello', 'live', 'done']);
  assert.deepEqual(out.events[0].data, { on: true, live: [{ thread: 'c_1', phase: 'writing', text: 'いま', steps: [{ kind: 'read', label: '予定を読みました' }], scheduled: null }] });
  assert.deepEqual(out.events[1].data, { thread: 'c_1', phase: 'writing', text: 'いま書いて', steps: [{ kind: 'read', label: '予定を読みました' }], scheduled: 'morning' });
  assert.deepEqual(out.events[2].data, { thread: 'c_1', message: 'm_x' });
  assert.ok(!out.text.includes(SECRET));
  // The listener goes when the screen goes.
  for (let i = 0; i < 50 && chat.listeners.size; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(chat.listeners.size, 0);
});

test('the event stream needs a login beyond this machine, and works with the secretary off', async (t) => {
  const { base } = await start(t, { server: { host: '0.0.0.0' } });
  const res = await readEvents(base, '/web/api/secretary/stream', { until: () => true });
  assert.equal(res.status, 401);
  assert.ok(!res.text.includes('event:'));
  const off = await start(t, { chat: null });
  const hello = await readEvents(off.base, '/web/api/secretary/stream', { until: (x) => x.includes('event: hello') });
  assert.deepEqual(hello.events[0].data, { on: false, live: [] });
});

test('uploads: this origin only, at most the cap, kept owner-only by id; a message takes them once', async (t) => {
  const { base, ledger, home, chat, post } = await start(t);
  const upload = (bytes, { name = '時間割.png', type = 'image/png', headers = {} } = {}) =>
    fetch(`${base}/web/api/secretary/uploads`, { method: 'POST', headers: { 'Content-Type': type, 'X-File-Name': encodeURIComponent(name), Origin: base, ...headers }, body: bytes });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]);
  assert.equal((await upload(png, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await upload(png, { headers: { Origin: '', 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await upload(Buffer.alloc(UPLOAD_MAX + 1))).status, 413);
  assert.equal((await upload(Buffer.alloc(0))).status, 400);
  const badName = await upload(png, { name: '../../etc/passwd' });
  assert.equal(badName.status, 400);
  const res = await upload(png);
  assert.equal(res.status, 201);
  const a = await res.json();
  assert.deepEqual([a.name, a.type, a.size], ['時間割.png', 'image/png', png.length]);
  const file = path.join(paths(home).uploads, a.id);
  assert.deepEqual(fs.readFileSync(file), png);
  assert.equal(ledger.getAttachment(a.id).sha256, createHash('sha256').update(png).digest('hex'));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(paths(home).uploads).mode & 0o777, 0o700);
  }
  // A file is not served back before it goes with a message, and not by its upload path.
  assert.equal((await fetch(`${base}/web/api/secretary/uploads/${a.id}`)).status, 404);
  assert.equal((await fetch(`${base}/web/api/secretary/files/${a.id}`)).status, 404);

  const sent = await post('/web/api/secretary/messages', { text: 'この時間割、来週の予定に入れておいて', attachments: [a.id] });
  assert.equal(sent.status, 202);
  const out = await sent.json();
  const mine = out.items.at(-1);
  // A picture that went with a message is shown in its bubble, as a picture only.
  assert.deepEqual(mine.files, [{ name: '時間割.png', type: 'image/png', size: png.length, preview: `/web/api/secretary/files/${a.id}` }]);
  const pic = await fetch(`${base}${mine.files[0].preview}`);
  assert.equal(pic.status, 200);
  assert.equal(pic.headers.get('content-type'), 'image/png');
  assert.match(pic.headers.get('content-security-policy'), /sandbox/);
  assert.deepEqual(Buffer.from(await pic.arrayBuffer()), png);
  assert.equal((await fetch(`${base}/web/api/secretary/files/..%2Fmcp.json`)).status, 404);
  assert.deepEqual(chat.sent.at(-1).attachments, [a.id]);
  const again = await post('/web/api/secretary/messages', { text: 'もう一度', attachments: [a.id] });
  assert.equal(again.status, 400);
  assert.match((await again.json()).problems[0], /もう送ってあります/);
  assert.equal((await post('/web/api/secretary/messages', { text: 'x', attachments: ['a', 'b', 'c', 'd', 'e'] })).status, 400);

  // Without a login beyond this machine, nothing is taken.
  const other = await start(t, { server: { host: '0.0.0.0' } });
  const r = await fetch(`${other.base}/web/api/secretary/uploads`, { method: 'POST', headers: { 'Content-Type': 'image/png', Origin: other.base }, body: png });
  assert.equal(r.status, 401);
  assert.equal(fs.existsSync(paths(other.home).uploads), false);
});

test('questions: answered from the window one at a time, あとで, changed; refused when the shape is wrong', async (t) => {
  const { ledger, post } = await start(t);
  const a = ledger.ask({ questions: [
    { header: 'タスク整理', question: 'どうしますか？', options: [{ label: '残す' }, { label: '閉じる' }], kind: 'close_forgotten' },
    { header: '期日', question: '延ばしますか？', options: [{ label: '今日のまま' }, { label: '延ばす' }] },
  ] }, S);
  const answer = (body, headers) => post(`/web/api/secretary/asks/${a.id}`, body, headers);
  assert.equal((await answer({ index: 0, picked: ['残す'] }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await answer({ index: 0, picked: '残す' })).status, 400);
  assert.equal((await answer({ index: 0, picked: ['残す'], by: 'me' })).status, 400);
  assert.equal((await post('/web/api/secretary/asks/m_20261025000000_nothin', { index: 0, picked: ['残す'] })).status, 404);
  const wrong = await answer({ index: 0, picked: ['飛ぶ'] });
  assert.equal(wrong.status, 400);
  assert.deepEqual((await wrong.json()).problems, ['「飛ぶ」という選択肢はありません']);

  const one = await (await answer({ index: 0, picked: ['残す'] })).json();
  const ask = one.items.find((x) => x.type === 'ask');
  assert.deepEqual([ask.state, ask.answers[0].picked, ask.answers[1]], ['open', ['残す'], null]);
  const mine = one.items.find((x) => x.id === one.id);
  assert.deepEqual([mine.role, mine.kind, mine.body, mine.answer.header, mine.answer.changed], ['user', 'answer', '残す', 'タスク整理', false]);
  // 戻る then a new choice: the answer changes, with one line.
  const back = await (await answer({ index: 0, picked: ['閉じる'] })).json();
  assert.equal(back.items.find((x) => x.id === back.id).answer.changed, true);
  assert.match(back.items.at(-1).body, /「タスク整理」の答えを「残す」から「閉じる」に変えました/);
  const later = await (await answer({ later: true })).json();
  assert.equal(later.items.find((x) => x.type === 'ask').state, 'later');
  assert.equal(later.items.find((x) => x.id === later.id).answer.later, true);
});

test('threads: one per message, opened from the window, with their messages; unread until read; a message goes into one', async (t) => {
  const { ledger, base, post, chat } = await start(t);
  const main = ledger.ensureThread('secretary', WEB);
  const m = ledger.addMessage(main.id, { role: 'secretary', body: 'おはようございます' }, S);
  const sys = ledger.addMessage(main.id, { role: 'system', body: 'お知らせ' }, S);
  assert.equal((await post('/web/api/secretary/threads', { parent: m.id }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/web/api/secretary/threads', { parent: sys.id })).status, 400);
  const opened = await (await post('/web/api/secretary/threads', { parent: m.id })).json();
  assert.equal(opened.parent.body, 'おはようございます');
  assert.deepEqual(opened.items, []);
  const id = opened.thread.id;
  assert.equal((await (await post('/web/api/secretary/threads', { parent: m.id })).json()).thread.id, id, 'one thread per message');

  const sent = await post('/web/api/secretary/messages', { text: '先に残りを教えて', thread: id });
  assert.equal(sent.status, 202);
  assert.equal(chat.sent.at(-1).thread, id);
  assert.equal((await post('/web/api/secretary/messages', { text: 'x', thread: main.id })).status, 404, 'the thread field names a thread of a message');
  ledger.addMessage(id, { role: 'secretary', body: '残りは3件です' }, S);
  ledger.addMessage(id, { role: 'system', kind: 'text', body: '答えを変えました' }, S);
  let top = await (await fetch(`${base}/web/api/secretary`)).json();
  assert.deepEqual(top.threads[m.id], { id, count: 2, unread: 1 });
  const view = await (await fetch(`${base}/web/api/secretary/threads/${id}`)).json();
  assert.deepEqual(view.items.map((x) => x.body), ['先に残りを教えて', '残りは3件です', '答えを変えました']);
  assert.equal((await fetch(`${base}/web/api/secretary/threads/${main.id}`)).status, 404);
  const read = await (await post(`/web/api/secretary/threads/${id}/read`, {})).json();
  assert.deepEqual(read.threads[m.id], { id, count: 2, unread: 0 });
  top = await (await fetch(`${base}/web/api/secretary`)).json();
  assert.equal(top.threads[m.id].unread, 0);
  // A question in the thread is answered there.
  const q = ledger.ask({ thread: id, questions: [{ header: '進め方', question: 'どれから？', options: [{ label: '時間割' }, { label: '夜の一覧' }] }] }, S);
  const ans = await (await post(`/web/api/secretary/asks/${q.id}`, { index: 0, picked: ['時間割'] })).json();
  assert.equal(ans.thread.id, id);
  assert.equal(ans.items.at(-1).body, '時間割');
});
