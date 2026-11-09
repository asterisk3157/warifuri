import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLedger } from '../src/ledger/ledger.mjs';
import { botToken, createDiscord } from '../src/notify/discord.mjs';
import { createNotifier } from '../src/notify/notifier.mjs';
import { failureOf } from '../src/secretary/secretary.mjs';

const S = { actor: 'device-key', device: 'secretary' };
const W = { actor: 'web' };

test('discord: the token from its file, and only the person can be pinged', async () => {
  assert.equal(botToken('# bot\nDISCORD_BOT_TOKEN=abc.def\n'), 'abc.def');
  assert.equal(botToken('abc.def\n'), 'abc.def');
  assert.equal(botToken(''), null);
  assert.equal(createDiscord({ token: 'x', channel: undefined }), null);
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ id: '1' }) };
  };
  const d = createDiscord({ token: 'DISCORD_BOT_TOKEN=t0k', channel: '123', user: '456', fetch });
  await d.post('@everyone 質問です', { mention: true });
  await d.post('朝の報告です');
  assert.equal(calls[0].url, 'https://discord.com/api/v10/channels/123/messages');
  assert.equal(calls[0].init.headers.Authorization, 'Bot t0k');
  const first = JSON.parse(calls[0].init.body);
  assert.equal(first.content, '<@456> @everyone 質問です');
  assert.deepEqual(first.allowed_mentions, { parse: [], users: ['456'] });
  assert.deepEqual(JSON.parse(calls[1].init.body).allowed_mentions, { parse: [], users: [] });
  const long = JSON.parse((await (async () => {
    await d.post('あ'.repeat(3000));
    return calls[2].init.body;
  })())).content;
  assert.equal([...long].length, 2000);
  const failing = createDiscord({ token: 't', channel: '1', fetch: async () => ({ ok: false, status: 401, json: async () => ({ message: '401: Unauthorized' }) }) });
  await assert.rejects(failing.post('x'), /Discord: 401 401: Unauthorized/);
});

test('failureOf: a lost login, a run that did not start, one that timed out or stopped', () => {
  assert.equal(failureOf({ code: 0 }), null);
  assert.equal(failureOf({ busy: true }), null);
  assert.equal(failureOf({ skipped: 'it is the night' }), null);
  assert.equal(failureOf({ code: 1 }, 'Failed to authenticate: OAuth session expired and could not be refreshed').reason, 'login');
  assert.match(failureOf({ code: 1 }, 'Failed to authenticate').text, /\/login でログインし直してください/);
  assert.equal(failureOf({ error: 'claude is not on PATH' }).reason, 'start');
  assert.equal(failureOf({ timedOut: true, code: null }).reason, 'timeout');
  assert.equal(failureOf({ code: 2, logFile: '/x/sync.log' }).reason, 'exit');
});

function world(t, { night = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-notify-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = openLedger(':memory:');
  t.after(() => ledger.close());
  const posts = [];
  let down = false;
  const discord = { post: async (text, opts) => { if (down) throw new Error('Discord: 503'); posts.push({ text, ...opts }); } };
  let clock = new Date(2026, 10, 9, 12, 0);
  const notifier = createNotifier({ ledger, discord, file: path.join(dir, 'discord.json'), publicUrl: 'https://w.example.com/', night, now: () => clock });
  const thread = ledger.ensureThread('secretary', W);
  return { ledger, notifier, posts, thread, set: (d) => { clock = d; }, down: (v) => { down = v; } };
}

test('notifier: from now on, the questions, the morning report and failures; not the replies to the person', async (t) => {
  const w = world(t);
  ledger_say(w, 'secretary', '前からある返事です。', { scheduled: 'morning' });
  assert.equal(await w.notifier.tick(), 0, 'the first run starts from now');
  ledger_say(w, 'user', '今日の予定は？');
  ledger_say(w, 'secretary', '今日は2件です。');
  w.ledger.ask({ questions: [{ header: '期日', question: '延ばしますか？', options: [{ label: '延ばす' }, { label: 'そのまま' }] }] }, S);
  ledger_say(w, 'secretary', '今日は会議が1件あります。', { scheduled: 'morning' });
  w.ledger.addMessage(w.thread.id, { role: 'system', body: 'カレンダーの同期が失敗しました。', data: { failure: 'login' } }, S);
  assert.equal(await w.notifier.tick(), 3);
  assert.deepEqual(w.posts.map((p) => [p.text, p.mention]), [
    ['秘書から質問があります。\n【期日】延ばしますか？\nhttps://w.example.com/secretary', true],
    ['朝の報告です。\n今日は会議が1件あります。\nhttps://w.example.com/secretary', false],
    ['カレンダーの同期が失敗しました。\nhttps://w.example.com/secretary', true],
  ]);
  assert.equal(await w.notifier.tick(), 0, 'nothing twice');
  // The same failure again is not sent until the secretary has answered again.
  w.ledger.addMessage(w.thread.id, { role: 'system', body: '毎晩の見張りが失敗しました。', data: { failure: 'login' } }, S);
  assert.equal(await w.notifier.tick(), 0);
  ledger_say(w, 'secretary', '直りました。');
  w.ledger.addMessage(w.thread.id, { role: 'system', body: '毎晩の見張りが失敗しました。', data: { failure: 'login' } }, S);
  assert.equal(await w.notifier.tick(), 1);
});

test('notifier: nothing in the night, all of it once the night is over; tried again when Discord is down', async (t) => {
  const w = world(t, { night: { start: 23 * 60, end: 7 * 60 } });
  await w.notifier.tick();
  w.set(new Date(2026, 10, 9, 23, 30));
  w.ledger.addMessage(w.thread.id, { role: 'system', body: '毎晩の見張りが失敗しました。', data: { failure: 'exit' } }, S);
  assert.equal(await w.notifier.tick(), 0);
  w.set(new Date(2026, 10, 10, 7, 0));
  w.down(true);
  assert.equal(await w.notifier.tick(), 0);
  w.down(false);
  assert.equal(await w.notifier.tick(), 1);
  assert.match(w.posts[0].text, /^毎晩の見張りが失敗しました。/);
});

function ledger_say(w, role, body, data) {
  return w.ledger.addMessage(w.thread.id, { role, body, ...(data ? { data } : {}) }, role === 'user' ? W : S);
}
