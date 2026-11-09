import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLedger, LedgerError } from '../src/ledger/ledger.mjs';
import { chunks } from '../src/notify/discord.mjs';
import { createDiscordChat, askComponents, askMessages, replyComponents } from '../src/notify/discord-chat.mjs';
import { createGateway, INTENTS } from '../src/notify/gateway.mjs';
import { createNotifier } from '../src/notify/notifier.mjs';
import { createThreadMap } from '../src/notify/discord-threads.mjs';

const S = { actor: 'device-key', device: 'secretary' };
const PERSON = '456';

function world(t, { threads = null } = {}) {
  const ledger = openLedger(':memory:');
  t.after(() => ledger.close());
  const thread = ledger.ensureThread('secretary', S);
  const sent = [];
  let on = true;
  // The secretary's conversation as discord-chat uses it: stores what is written.
  const chat = {
    send(text, writer, opts) {
      if (!on) throw new LedgerError(['秘書が止まっているので、送れません']);
      sent.push({ text, writer, ...(opts ? { opts } : {}) });
      return ledger.addMessage(opts?.thread ?? thread.id, { role: 'user', body: text }, writer);
    },
    answer: (id, fields, writer) => ledger.answerAsk(id, fields, writer),
  };
  const calls = [];
  const discord = {
    channel: '123', user: PERSON,
    post: async (text, opts) => calls.push({ post: text, ...opts }),
    respond: async (i, body) => calls.push({ respond: i.id, ...body }),
    typing: async (channel) => calls.push({ typing: channel ?? true }),
    startThread: async (message, name) => {
      calls.push({ startThread: message, name });
      return { id: `th-${message}` };
    },
  };
  const talk = createDiscordChat({ chat, ledger, discord, threads });
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

test('discord chat: a question with two questions goes as a message per question, each with its own buttons', async (t) => {
  const w = world(t);
  const q = ask(w.ledger);
  const msgs = askMessages(q);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].text, '秘書から質問が2つあります。\n\n質問1【期日】延ばしますか？');
  assert.equal(msgs[1].text, '質問2【分野】どれに入れますか？');
  const ids = (m) => m.components.flatMap((r) => r.components.map((c) => c.custom_id));
  assert.deepEqual(ids(msgs[0]), [`wf:a:${q.id}:0:0`, `wf:a:${q.id}:0:1`], 'the first holds only its own buttons');
  assert.deepEqual(ids(msgs[1]), [`wf:a:${q.id}:1`, `wf:l:${q.id}`], 'まとめてあとで goes under the last');
  assert.equal(msgs[1].components[1].components[0].label, 'まとめてあとで');
  // One question: one message with あとで, as before.
  const one = { id: 'm_x', state: 'open', data: { questions: [{ header: '期日', question: '延ばしますか？', options: [{ label: '延ばす' }, { label: 'そのまま' }] }] } };
  assert.equal(askMessages(one).length, 1);
  assert.equal(askMessages(one)[0].components.at(-1).components[0].label, 'あとで');
  // Pressing on the first message rewrites it with its own question only.
  const press = (m, custom_id, extra = {}) => w.talk.onEvent('INTERACTION_CREATE', { id: 'i1', token: 'tk', type: 3, user: { id: PERSON }, message: { content: m.text, components: m.components }, data: { custom_id, ...extra } });
  await press(msgs[0], `wf:a:${q.id}:0:0`);
  assert.deepEqual(w.calls.at(-1).data.components.flatMap((r) => r.components.map((c) => [c.custom_id, c.style])), [[`wf:a:${q.id}:0:0`, 3], [`wf:a:${q.id}:0:1`, 2]]);
  assert.equal(w.calls.at(-1).data.content, msgs[0].text);
  // まとめてあとで on the last one: it keeps its menu, あとで goes.
  await press(msgs[1], `wf:l:${q.id}`);
  assert.equal(w.ledger.getMessage(q.id).state, 'later');
  assert.deepEqual(w.calls.at(-1).data.components.flatMap((r) => r.components.map((c) => c.custom_id)), [`wf:a:${q.id}:1`]);
});

test('notifier: a question with two questions is posted as two messages, the person pinged once', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-ask-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = openLedger(':memory:');
  t.after(() => ledger.close());
  ledger.ensureThread('secretary', S);
  const posts = [];
  const notifier = createNotifier({ ledger, discord: { post: async (text, opts) => posts.push({ text, ...opts }) }, file: path.join(dir, 'd.json'), publicUrl: 'https://w.example.com' });
  await notifier.tick();
  const q = ask(ledger);
  assert.equal(await notifier.tick(), 1);
  assert.deepEqual(posts.map((p) => p.mention), [true, false]);
  assert.match(posts[0].text, /^秘書から質問が2つあります。/);
  assert.match(posts[1].text, /^質問2【分野】.*\nhttps:\/\/w\.example\.com\/secretary$/);
  assert.equal(posts[1].components.at(-1).components[0].custom_id, `wf:l:${q.id}`);
});

test('discord chat: a reply button sends its words', async (t) => {
  const w = world(t);
  const m = w.ledger.addMessage(w.thread.id, { role: 'secretary', body: '入れますか？', data: { options: ['入れて', 'やめる'] } }, S);
  const rows = replyComponents(m);
  assert.deepEqual(rows[0].components.map((b) => b.label), ['入れて', 'やめる']);
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

test('notifier: with Discord chat on, what is written on the screen and its reply go to Discord too', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-mirror-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = new Date(2026, 10, 9, 20, 0);
  const ledger = openLedger(':memory:', { now: () => clock });
  t.after(() => ledger.close());
  const thread = ledger.ensureThread('secretary', S);
  const say = (role, body, writer, data) => ledger.addMessage(thread.id, { role, body, ...(data ? { data } : {}) }, writer);
  const run = async (mirror) => {
    const posts = [];
    const notifier = createNotifier({ ledger, discord: { post: async (text, opts) => posts.push({ text, ...opts }) }, file: path.join(dir, `${mirror}.json`), publicUrl: 'https://w.example.com', mirror, now: () => clock });
    await notifier.tick();
    say('user', '明日の予定は？', { actor: 'web' });
    say('secretary', '明日は2件です。', S);
    say('user', '入れて', { actor: 'discord' });
    say('secretary', '入れました。', S);
    await notifier.tick();
    return posts.map((p) => p.text);
  };
  assert.deepEqual(await run(true), ['(Web から)\n明日の予定は？', '明日は2件です。', '入れました。']);
  assert.deepEqual(await run(false), ['入れました。'], 'without it, only the replies to Discord');
});

test('discord chat: スレッドで話す opens a Discord thread tied to the thread; what is said there goes both ways', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-threads-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const threads = createThreadMap(path.join(dir, 'discord-threads.json'));
  const w = world(t, { threads });
  const reply = w.ledger.addMessage(w.thread.id, { role: 'secretary', body: '来週の計画を立てましょうか', data: { options: ['スレッドで話す', 'ここで続ける'] } }, S);
  assert.deepEqual(replyComponents(reply)[0].components.map((b) => b.label), ['スレッドで話す', 'ここで続ける'], 'the thread pair is offered');
  const notifier = createNotifier({ ledger: w.ledger, discord: { post: async (text, opts) => w.calls.push({ post: text, ...opts }) }, file: path.join(dir, 'd.json'), threads });
  await notifier.tick();
  // Pressing スレッドで話す: a Discord thread from the message the button is on.
  const press = () => w.talk.onEvent('INTERACTION_CREATE', { id: 'i1', token: 'tk', type: 3, user: { id: PERSON }, message: { id: 'dm1', content: reply.body }, data: { custom_id: `wf:r:${reply.id}:0` } });
  await press();
  const sub = w.ledger.threadCounts()[reply.id];
  assert.ok(sub, 'the thread of the conversation is opened');
  assert.deepEqual(w.calls.find((c) => c.startThread), { startThread: 'dm1', name: '来週の計画を立てましょうか' });
  assert.equal(threads.thread('th-dm1'), sub.id);
  assert.deepEqual(w.calls.find((c) => c.respond)?.data, { content: '来週の計画を立てましょうか\n→ スレッドで話す', components: [] });
  assert.equal(w.calls.at(-1).channel, 'th-dm1');
  assert.equal(w.sent.length, 0, 'スレッドで話す is not sent as words');
  // Pressed again: the same thread, shown only to the person.
  await press();
  assert.equal(w.calls.filter((c) => c.startThread).length, 1);
  assert.equal(w.calls.at(-1).data.content, 'スレッドはこちらです: <#th-dm1>');
  // What the person writes in the Discord thread goes into the thread; elsewhere, nowhere.
  await w.talk.onEvent('MESSAGE_CREATE', { channel_id: 'th-dm1', content: '月曜から考えたい', author: { id: PERSON } });
  await w.talk.onEvent('MESSAGE_CREATE', { channel_id: 'th-other', content: '別のスレッド', author: { id: PERSON } });
  assert.deepEqual(w.sent.map((x) => [x.text, x.opts?.thread]), [['月曜から考えたい', sub.id]]);
  assert.ok(w.calls.some((c) => c.typing === 'th-dm1'));
  // The secretary's reply in the thread, and what is written there on the screen, go to the
  // Discord thread; what came from Discord does not come back.
  const before = w.calls.length;
  w.ledger.addMessage(sub.id, { role: 'secretary', body: '月曜は空いています', data: { options: ['入れて', 'やめる'] } }, S);
  w.ledger.addMessage(sub.id, { role: 'user', body: '火曜も見て' }, { actor: 'web', device: null });
  w.ledger.addMessage(w.thread.id, { role: 'secretary', body: '本題の返事' }, S);
  await notifier.tick();
  const posts = w.calls.slice(before).filter((c) => c.post);
  assert.deepEqual(posts.map((c) => [c.post, c.channel]), [['月曜は空いています', 'th-dm1'], ['(Web から)\n火曜も見て', 'th-dm1']]);
  // A reply button in the thread answers in the thread.
  const button = posts[0].components[0].components[0].custom_id;
  await w.talk.onEvent('INTERACTION_CREATE', { id: 'i3', token: 'tk', type: 3, user: { id: PERSON }, channel_id: 'th-dm1', message: { id: 'dm2', content: '月曜は空いています' }, data: { custom_id: button } });
  assert.deepEqual(w.sent.at(-1), { text: '入れて', writer: { actor: 'discord', device: null }, opts: { thread: sub.id } });
  // Sent once: across a restart too.
  const again = createNotifier({ ledger: w.ledger, discord: { post: async (text, opts) => w.calls.push({ post: text, ...opts }) }, file: path.join(dir, 'd.json'), threads: createThreadMap(path.join(dir, 'discord-threads.json')) });
  const n = w.calls.length;
  await again.tick();
  assert.equal(w.calls.slice(n).filter((c) => c.post && c.channel === 'th-dm1').length, 0);
});

test('notifier: a thread opened on the screen gets a Discord thread once something is said in it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-webthread-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = openLedger(':memory:');
  t.after(() => ledger.close());
  const main = ledger.ensureThread('secretary', S);
  const W = { actor: 'web', device: null };
  // A thread of before: left alone.
  const old = ledger.addMessage(main.id, { role: 'secretary', body: '前の話' }, S);
  const oldThread = ledger.openThread(old.id, W);
  ledger.addMessage(oldThread.id, { role: 'user', body: '前のスレッド' }, W);
  await new Promise((r) => setTimeout(r, 5));
  const threads = createThreadMap(path.join(dir, 'discord-threads.json'));
  const calls = [];
  let n = 0;
  const discord = {
    post: async (text, opts) => {
      calls.push({ post: text, ...opts });
      n += 1;
      return { id: `dm${n}` };
    },
    startThread: async (message, name) => {
      calls.push({ startThread: message, name });
      return { id: `th${calls.length}` };
    },
  };
  const notifier = createNotifier({ ledger, discord, file: path.join(dir, 'd.json'), mirror: true, threads });
  await notifier.tick();
  await new Promise((r) => setTimeout(r, 5));
  // A reply that went to Discord; a thread opened from it on the screen.
  ledger.addMessage(main.id, { role: 'user', body: '計画は？' }, W);
  const reply = ledger.addMessage(main.id, { role: 'secretary', body: '来週の計画です' }, S);
  await notifier.tick();
  assert.equal(threads.posted(reply.id), 'dm2');
  const sub = ledger.openThread(reply.id, W);
  await notifier.tick();
  assert.equal(threads.channelOf(sub.id), null, 'not until something is said in it');
  ledger.addMessage(sub.id, { role: 'user', body: 'テストです' }, W);
  ledger.addMessage(sub.id, { role: 'secretary', body: '届いています' }, S);
  await notifier.tick();
  assert.deepEqual(calls.find((c) => c.startThread), { startThread: 'dm2', name: '来週の計画です' });
  const channel = threads.channelOf(sub.id);
  assert.ok(channel);
  assert.deepEqual(calls.filter((c) => c.channel === channel).map((c) => c.post), ['(Web から)\nテストです', '届いています']);
  assert.equal(threads.channelOf(oldThread.id), null, 'a thread of before is left alone');
  // From a message that did not go to Discord: a thread of its own, the message quoted.
  const quiet = ledger.addMessage(main.id, { role: 'secretary', kind: 'text', body: '画面だけの発言' }, S);
  const sub2 = ledger.openThread(quiet.id, W);
  ledger.addMessage(sub2.id, { role: 'user', body: 'こちらも' }, W);
  const before = calls.length;
  await notifier.tick();
  const after = calls.slice(before);
  assert.deepEqual(after.find((c) => 'startThread' in c), { startThread: null, name: '画面だけの発言' });
  const channel2 = threads.channelOf(sub2.id);
  assert.deepEqual(after.filter((c) => c.channel === channel2).map((c) => c.post), ['秘書のこの発言から始まったスレッドです。\n> 画面だけの発言', '(Web から)\nこちらも']);
});
