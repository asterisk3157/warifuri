import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLedger, LedgerError } from '../src/ledger/ledger.mjs';
import { chunks } from '../src/notify/discord.mjs';
import { createDiscordChat, askComponents, replyComponents } from '../src/notify/discord-chat.mjs';
import { createGateway, INTENTS } from '../src/notify/gateway.mjs';
import { createNotifier } from '../src/notify/notifier.mjs';

const S = { actor: 'device-key', device: 'secretary' };
const PERSON = '456';

function world(t) {
  const ledger = openLedger(':memory:');
  t.after(() => ledger.close());
  const thread = ledger.ensureThread('secretary', S);
  const sent = [];
  let on = true;
  // The secretary's conversation as discord-chat uses it: stores what is written.
  const chat = {
    send(text, writer) {
      if (!on) throw new LedgerError(['秘書が止まっているので、送れません']);
      sent.push({ text, writer });
      return ledger.addMessage(thread.id, { role: 'user', body: text }, writer);
    },
    answer: (id, fields, writer) => ledger.answerAsk(id, fields, writer),
  };
  const calls = [];
  const discord = {
    channel: '123', user: PERSON,
    post: async (text, opts) => calls.push({ post: text, ...opts }),
    respond: async (i, body) => calls.push({ respond: i.id, ...body }),
    typing: async () => calls.push({ typing: true }),
  };
  const talk = createDiscordChat({ chat, ledger, discord });
  return { ledger, thread, talk, sent, calls, off: () => { on = false; } };
}

const ask = (ledger) => ledger.ask({
  questions: [
    { header: '期日', question: '延ばしますか？', options: [{ label: '延ばす' }, { label: 'そのまま' }] },
    { header: '分野', question: 'どれに入れますか？', multiSelect: true, options: [{ label: '研究' }, { label: '仕事', description: '会社の分' }] },
  ],
}, S);

test('discord chat: only what the person writes in the channel goes to the secretary', async (t) => {
  const w = world(t);
  const msg = (over) => w.talk.onEvent('MESSAGE_CREATE', { channel_id: '123', content: ' 今日の予定は？ ', author: { id: PERSON }, ...over });
  await msg();
  await msg({ author: { id: '999' } });
  await msg({ author: { id: PERSON, bot: true } });
  await msg({ channel_id: '777' });
  assert.deepEqual(w.sent, [{ text: '今日の予定は？', writer: { actor: 'discord', device: null } }]);
  assert.equal(w.ledger.listMessages(w.thread.id).at(-1).actor, 'discord');
  assert.ok(w.calls.some((c) => c.typing), 'shows that a reply is being written');
  // A file alone is not passed on; the person is told where to send it.
  await msg({ content: '', attachments: [{ filename: 'a.png' }] });
  assert.equal(w.sent.length, 1);
  assert.match(w.calls.at(-1).post, /ファイルは画面から送ってください/);
  // With the secretary off, the person is told.
  w.off();
  await msg({ content: 'もしもし' });
  assert.equal(w.calls.at(-1).post, '秘書が止まっているので、送れません');
});

test('discord chat: a question as buttons and a menu; pressing answers it', async (t) => {
  const w = world(t);
  const q = ask(w.ledger);
  const rows = askComponents(q);
  assert.equal(rows.length, 3, 'a row per question, then あとで');
  assert.deepEqual(rows[0].components.map((b) => [b.custom_id, b.label, b.style]), [[`wf:a:${q.id}:0:0`, '延ばす', 1], [`wf:a:${q.id}:0:1`, 'そのまま', 2]]);
  assert.equal(rows[1].components[0].type, 3);
  assert.equal(rows[1].components[0].max_values, 2);
  assert.equal(rows[2].components[0].custom_id, `wf:l:${q.id}`);
  const press = (custom_id, extra = {}) => w.talk.onEvent('INTERACTION_CREATE', { id: 'i1', token: 'tk', type: 3, member: { user: { id: PERSON } }, message: { content: '秘書から質問があります。' }, data: { custom_id, ...extra } });
  await press(`wf:a:${q.id}:0:1`);
  let now = w.ledger.getMessage(q.id);
  assert.deepEqual(now.data.answers[0].picked, ['そのまま']);
  const update = w.calls.at(-1);
  assert.equal(update.type, 7);
  assert.equal(update.data.components[0].components[1].style, 3, 'the pick is shown');
  await press(`wf:a:${q.id}:1`, { values: ['0', '1'] });
  now = w.ledger.getMessage(q.id);
  assert.deepEqual(now.data.answers[1].picked, ['研究', '仕事']);
  assert.equal(now.state, 'answered');
  assert.equal(w.calls.at(-1).data.components.length, 2, 'あとで goes once all is answered');
  // The same answer again is refused, shown only to the person.
  await press(`wf:a:${q.id}:0:1`);
  assert.equal(w.calls.at(-1).type, 4);
  assert.equal(w.calls.at(-1).data.flags, 64);
  // Someone else cannot answer.
  await w.talk.onEvent('INTERACTION_CREATE', { id: 'i2', token: 'tk', type: 3, member: { user: { id: '999' } }, data: { custom_id: `wf:a:${q.id}:0:0` } });
  assert.equal(w.calls.at(-1).data.content, 'このボタンは使えません');
  assert.deepEqual(w.ledger.getMessage(q.id).data.answers[0].picked, ['そのまま']);
});

test('discord chat: a reply button sends its words; the thread pair is not offered', async (t) => {
  const w = world(t);
  const m = w.ledger.addMessage(w.thread.id, { role: 'secretary', body: '入れますか？', data: { options: ['入れて', 'やめる'] } }, S);
  const rows = replyComponents(m);
  assert.deepEqual(rows[0].components.map((b) => b.label), ['入れて', 'やめる']);
  assert.deepEqual(replyComponents({ id: 'x', data: { options: ['スレッドで話す', 'ここで続ける'] } }), []);
  await w.talk.onEvent('INTERACTION_CREATE', { id: 'i1', token: 'tk', type: 3, user: { id: PERSON }, message: { content: '入れますか？' }, data: { custom_id: `wf:r:${m.id}:0` } });
  assert.deepEqual(w.sent.map((x) => x.text), ['入れて']);
  assert.deepEqual(w.calls.at(-1).data, { content: '入れますか？\n→ 入れて', components: [] });
});

test('notifier: the replies go to Discord while the person talks there, at night too', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-talk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = new Date(2026, 10, 9, 23, 30);
  const ledger = openLedger(':memory:', { now: () => clock });
  t.after(() => ledger.close());
  const thread = ledger.ensureThread('secretary', S);
  const posts = [];
  const discord = { post: async (text, opts) => posts.push({ text, ...opts }) };
  const notifier = createNotifier({ ledger, discord, file: path.join(dir, 'd.json'), publicUrl: 'https://w.example.com', night: { start: 23 * 60, end: 7 * 60 }, now: () => clock });
  await notifier.tick();
  const say = (role, body, writer, data) => ledger.addMessage(thread.id, { role, body, ...(data ? { data } : {}) }, writer);
  // From the screen: the reply stays there.
  say('user', '画面からです', { actor: 'web' });
  say('secretary', '画面への返事です', S);
  // From Discord, in the night: the reply goes, whole, with its buttons and no link.
  say('user', 'Discord からです', { actor: 'discord' });
  say('secretary', `${'あ'.repeat(1990)}\n${'い'.repeat(50)}`, S, { options: ['はい', 'いいえ'] });
  assert.equal(await notifier.tick(), 1);
  assert.equal(posts.length, 2, 'a long reply is cut in two');
  assert.equal(posts[0].text, 'あ'.repeat(1990));
  assert.equal(posts[1].text, 'い'.repeat(50));
  assert.deepEqual(posts[1].components[0].components.map((b) => b.label), ['はい', 'いいえ']);
  assert.deepEqual(posts[0].components, []);
  // Half an hour later the talk is over: in the night, nothing goes again.
  clock = new Date(clock.getTime() + 31 * 60 * 1000);
  say('secretary', 'あとからの返事です', S);
  assert.equal(await notifier.tick(), 0);
});

test('chunks: cut at line ends where it can', () => {
  assert.deepEqual(chunks('short'), ['short']);
  assert.deepEqual(chunks(`${'a'.repeat(6)}\n${'b'.repeat(6)}`, 10), ['a'.repeat(6), 'b'.repeat(6)]);
  assert.deepEqual(chunks('c'.repeat(25), 10), ['c'.repeat(10), 'c'.repeat(10), 'c'.repeat(5)]);
});

test('gateway: says who it is after hello, beats, and resumes after a drop', async (t) => {
  const sockets = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.sent = [];
      sockets.push(this);
    }
    send(text) {
      this.sent.push(JSON.parse(text));
    }
    close(code) {
      this.readyState = 3;
      this.onclose?.({ code });
    }
    hear(msg) {
      this.onmessage({ data: JSON.stringify(msg) });
    }
  }
  const events = [];
  const logs = [];
  const gw = createGateway({ token: 'DISCORD_BOT_TOKEN=t0k', onEvent: (type, d) => events.push([type, d]), log: (l) => logs.push(l), WebSocketImpl: FakeSocket, retryMs: 1 });
  t.after(() => gw.stop());
  gw.start();
  const a = sockets[0];
  a.hear({ op: 10, d: { heartbeat_interval: 60_000 } });
  assert.deepEqual(a.sent.at(-1), { op: 2, d: { token: 't0k', intents: INTENTS, properties: { os: process.platform, browser: 'warifuri', device: 'warifuri' } } });
  a.hear({ op: 0, s: 1, t: 'READY', d: { session_id: 'sess', resume_gateway_url: 'wss://resume.example' } });
  a.hear({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: { content: 'hi' } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(events.map(([type]) => type), ['READY', 'MESSAGE_CREATE']);
  // A drop: it comes back on the resume address and picks up the session.
  a.close(1006);
  await new Promise((r) => setTimeout(r, 20));
  const b = sockets[1];
  assert.match(b.url, /^wss:\/\/resume\.example\//);
  b.hear({ op: 10, d: { heartbeat_interval: 60_000 } });
  assert.deepEqual(b.sent.at(-1), { op: 6, d: { token: 't0k', session_id: 'sess', seq: 2 } });
  // A refused token stops it for good.
  b.close(4004);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sockets.length, 2);
  assert.match(logs.at(-1), /トークンを受けつけませんでした/);
});
