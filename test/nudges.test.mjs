// Tests for the secretary's notes at no set time: the deadline watch (src/secretary/deadlines.mjs)
// and how the notifier sends its notes, in the night too; the questions the secretary
// withdraws (ledger, screen, Discord); and the one note of the tasks it closed without asking.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openLedger } from '../src/ledger/ledger.mjs';
import { MIGRATIONS, SCHEMA_VERSION } from '../src/ledger/schema.mjs';
import { createDiscord } from '../src/notify/discord.mjs';
import { createNotifier } from '../src/notify/notifier.mjs';
import { withdrawnMessages, askComponents } from '../src/notify/discord-chat.mjs';
import { createDeadlineWatch, stageOf, deadlineNote } from '../src/secretary/deadlines.mjs';
import { closedNote } from '../src/secretary/chat.mjs';

const S = { actor: 'device-key', device: 'secretary' };
const W = { actor: 'web' };
const NIGHT = { start: 23 * 60, end: 7 * 60 };

function dir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-nudges-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function ledgerFor(t) {
  const ledger = openLedger(':memory:');
  t.after(() => ledger.close());
  return ledger;
}

const task = (ledger, title, due, more = {}) => ledger.createTask({ title, mode: 'human', done_when: '出した', due, ...more }, W);

test('stageOf: two days before and the day before; in the night only a deadline within the night', () => {
  const noon = (d) => new Date(2026, 10, d, 12);
  assert.equal(stageOf('2026-11-18', noon(16)), 'd2');
  assert.equal(stageOf('2026-11-18', noon(17)), 'd1');
  assert.equal(stageOf('2026-11-18', noon(18)), null, 'the day itself in the day: not told');
  assert.equal(stageOf('2026-11-18', noon(15)), null);
  assert.equal(stageOf('2026-11-18', noon(19)), null, 'past');
  // A due time counts by its local day.
  assert.equal(stageOf(new Date(2026, 10, 18, 9).toISOString(), noon(17), NIGHT), 'd1');
  // In the night: only what ends before 07:00.
  assert.equal(stageOf('2026-11-18', new Date(2026, 10, 18, 23, 30), NIGHT), 'today', 'a date alone ends at midnight');
  assert.equal(stageOf('2026-11-19', new Date(2026, 10, 18, 23, 30), NIGHT), null, 'tomorrow waits for the morning');
  assert.equal(stageOf(new Date(2026, 10, 19, 6).toISOString(), new Date(2026, 10, 19, 1), NIGHT), 'today');
  assert.equal(stageOf(new Date(2026, 10, 19, 9).toISOString(), new Date(2026, 10, 19, 1), NIGHT), null);
  assert.equal(stageOf('2026-11-18', new Date(2026, 10, 16, 23, 30), NIGHT), null, 'the two days before waits for the morning');
  assert.equal(stageOf('2026-11-18', new Date(2026, 10, 16, 7, 0), NIGHT), 'd2');
});

test('deadline watch: one note for what is new, each stage once, nothing for what is done; a moved due is told again', (t) => {
  const ledger = ledgerFor(t);
  const file = path.join(dir(t), 'deadlines.json');
  const told = [];
  let clock = new Date(2026, 10, 16, 12);
  const watch = createDeadlineWatch({ ledger, file, night: NIGHT, now: () => clock, tell: (body, data) => (told.push({ body, data }), { body, data }) });
  const report = task(ledger, '報告書', '2026-11-18');
  const slides = task(ledger, 'スライド', '2026-11-17');
  const done = task(ledger, '申込み', '2026-11-17');
  ledger.setState(done.id, 'done', { result: '出した' }, W);
  task(ledger, '来月の準備', '2026-12-20');

  const first = watch.check();
  assert.ok(first);
  assert.equal(told.length, 1, 'one note for all');
  assert.deepEqual(told[0].data.deadline.map((x) => [x.task, x.stage]).sort(), [[report.id, 'd2'], [slides.id, 'd1']].sort());
  assert.equal(told[0].data.urgent, undefined);
  assert.match(told[0].body, /^締切が近いのに、まだ終わっていないタスクがあります。やりましょう。/);
  assert.match(told[0].body, /あした 11\/17\(火\)が締切: スライド/);
  assert.match(told[0].body, /あさって 11\/18\(水\)が締切: 報告書/);
  assert.ok(!told[0].body.includes('申込み'), 'a task done is not told');

  // The same stage again: nothing, also after a restart (the file).
  assert.equal(watch.check(), null);
  const again = createDeadlineWatch({ ledger, file, night: NIGHT, now: () => clock, tell: (body, data) => told.push({ body, data }) });
  assert.equal(again.check(), null);

  // The next day: the day before of 報告書; スライド is due today and is not told in the day.
  clock = new Date(2026, 10, 17, 12);
  watch.check();
  assert.equal(told.length, 2);
  assert.deepEqual(told[1].data.deadline.map((x) => [x.task, x.stage]), [[report.id, 'd1']]);

  // 報告書 done before the night: not told at 23:30.
  ledger.setState(report.id, 'done', { result: '出した' }, W);
  clock = new Date(2026, 10, 17, 23, 30);
  watch.check();
  assert.equal(told.length, 3, 'only スライド, due tonight');
  assert.deepEqual(told[2].data.deadline.map((x) => [x.task, x.stage]), [[slides.id, 'today']]);
  assert.equal(told[2].data.urgent, true);
  assert.match(told[2].body, /今夜 24:00が締切: スライド/);

  // A due moved later is told again at its stages.
  ledger.update(slides.id, { due: '2026-11-20' }, W);
  clock = new Date(2026, 10, 18, 12);
  watch.check();
  assert.deepEqual(told[3].data.deadline.map((x) => [x.task, x.stage]), [[slides.id, 'd2']]);

  // tick looks at most every checkMs.
  const quiet = createDeadlineWatch({ ledger, file: path.join(dir(t), 'd.json'), now: () => clock, checkMs: 60_000, tell: () => ({}) });
  assert.ok(quiet.tick());
  assert.equal(quiet.tick(), null);
});

test('deadlineNote: a provisional due is marked', () => {
  const body = deadlineNote([{ task: { title: '準備', due: '2026-11-18', due_provisional: true }, stage: 'd1' }]);
  assert.match(body, /あした 11\/18\(水\)が締切\(仮\): 準備/);
});

function notifyWorld(t, { night = NIGHT } = {}) {
  const ledger = ledgerFor(t);
  const posts = [];
  const edits = [];
  let n = 0;
  const discord = {
    post: async (text, opts) => {
      n += 1;
      posts.push({ text, ...opts, id: `d${n}` });
      return { id: `d${n}` };
    },
    edit: async (id, opts) => {
      edits.push({ id, ...opts });
      return {};
    },
  };
  let clock = new Date(2026, 10, 16, 12);
  const notifier = createNotifier({ ledger, discord, file: path.join(dir(t), 'discord.json'), night, now: () => clock });
  const thread = ledger.ensureThread('secretary', W);
  return { ledger, notifier, posts, edits, thread, set: (d) => { clock = d; } };
}

test('notifier: deadline notes go with a ping; in the night only the urgent one, and it is not sent again in the morning', async (t) => {
  const w = notifyWorld(t);
  await w.notifier.tick();
  w.ledger.addMessage(w.thread.id, { role: 'system', body: '締切が近いです(昼)', data: { deadline: [{ task: 't', stage: 'd1' }] } }, S);
  assert.equal(await w.notifier.tick(), 1);
  assert.deepEqual([w.posts[0].text, w.posts[0].mention], ['締切が近いです(昼)', true]);

  w.set(new Date(2026, 10, 17, 23, 30));
  w.ledger.addMessage(w.thread.id, { role: 'system', body: 'ふつうのお知らせ', data: { failure: 'exit' } }, S);
  w.ledger.addMessage(w.thread.id, { role: 'system', body: '今夜が締切です', data: { deadline: [{ task: 't', stage: 'today' }], urgent: true } }, S);
  assert.equal(await w.notifier.tick(), 1, 'only the urgent one in the night');
  assert.equal(w.posts.at(-1).text, '今夜が締切です');
  assert.equal(await w.notifier.tick(), 0, 'not twice in the night');

  w.set(new Date(2026, 10, 18, 7, 5));
  assert.equal(await w.notifier.tick(), 1, 'the rest in the morning, the urgent one not again');
  assert.deepEqual(w.posts.map((p) => p.text), ['締切が近いです(昼)', '今夜が締切です', 'ふつうのお知らせ']);
});

test('notifier: the note of tasks closed without asking goes, without a ping; a reply on a broken plan goes with one', async (t) => {
  const w = notifyWorld(t);
  await w.notifier.tick();
  const body = closedNote('nightly', [
    { id: 't1', title: '発表の申込み', state: 'done', result: '申し込んだ。秘書が閉じた。根拠: PR がマージされた' },
    { id: 't2', title: '古い調べもの', state: 'discarded', reason: 'もう要らない' },
  ]);
  w.ledger.addMessage(w.thread.id, { role: 'system', body, data: { auto_closed: { job: 'nightly', tasks: ['t1', 't2'] } } }, S);
  w.ledger.addMessage(w.thread.id, { role: 'secretary', body: '面談が作業の時間に重なりました。', data: { scheduled: 'calendar', alert: true } }, S);
  w.ledger.addMessage(w.thread.id, { role: 'secretary', body: 'ほかの予定には響きません。', data: { scheduled: 'calendar' } }, S);
  assert.equal(await w.notifier.tick(), 2);
  assert.equal(w.posts[0].mention, false);
  assert.equal(w.posts[0].text, [
    '毎晩の見張りで、終わっていたタスクを2件閉じました。',
    '- 発表の申込み: 申し込んだ。秘書が閉じた。根拠: PR がマージされた',
    '- 古い調べもの(やめた): もう要らない',
    '違っていたら「〇〇を戻して」と言ってください。',
  ].join('\n'));
  assert.deepEqual([w.posts[1].text, w.posts[1].mention], ['面談が作業の時間に重なりました。', true]);
});

const question = (header, q) => ({ header, question: q, options: [{ label: 'はい' }, { label: 'いいえ' }] });

test('withdraw: the question is kept as withdrawn, cannot be answered, and lets the next one be asked', (t) => {
  const ledger = ledgerFor(t);
  const ask = ledger.ask({ questions: [question('期日', '延ばしますか？')] }, S);
  assert.throws(() => ledger.ask({ questions: [question('次', 'つぎは？')] }, S), /まだ答えを待っている質問があります/);
  const out = ledger.withdrawAsk(ask.id, {}, S);
  assert.equal(out.state, 'withdrawn');
  assert.equal(out.data.withdrawn.reason, '答えが出たため');
  assert.throws(() => ledger.answerAsk(ask.id, { index: 0, picked: ['はい'] }, W), /取り下げました/);
  assert.throws(() => ledger.answerAsk(ask.id, { later: true }, W), /取り下げました/);
  assert.throws(() => ledger.withdrawAsk(ask.id, {}, S), /もう取り下げています/);
  assert.equal(ledger.openAsk(ask.thread_id), undefined);
  assert.ok(ledger.ask({ questions: [question('次', 'つぎは？')] }, S));
  // A question answered in full cannot be withdrawn; one answered あとで can.
  const later = ledger.listMessages(ask.thread_id).filter((m) => m.kind === 'ask').at(-1);
  ledger.answerAsk(later.id, { later: true }, W);
  assert.equal(ledger.withdrawAsk(later.id, { reason: 'タスクが閉じられたため' }, S).data.withdrawn.reason, 'タスクが閉じられたため');
  const third = ledger.ask({ questions: [question('三', 'みっつめ？')] }, S);
  ledger.answerAsk(third.id, { index: 0, picked: ['はい'] }, W);
  assert.throws(() => ledger.withdrawAsk(third.id, {}, S), /もう全部答えがあります/);
  assert.equal(ledger.records(ask.id).at(-1).action, 'withdraw');
});

test('withdraw in Discord: the messages of the question lose their buttons and say 取り下げ済み', async (t) => {
  const w = notifyWorld(t);
  await w.notifier.tick();
  const two = w.ledger.ask({ questions: [question('期日', '延ばしますか？'), question('順番', '先にしますか？')] }, S);
  assert.equal(await w.notifier.tick(), 1);
  assert.equal(w.posts.length, 2, 'two questions, two messages');
  assert.ok(w.posts[0].components.length > 0);
  assert.equal(await w.notifier.tick(), 0);
  assert.equal(w.edits.length, 0, 'an open question is left as it is');

  w.ledger.withdrawAsk(two.id, {}, S);
  await w.notifier.tick();
  assert.deepEqual(w.edits.map((e) => [e.id, e.components]), [['d1', []], ['d2', []]]);
  assert.match(w.edits[0].content, /^【取り下げ済み】答えが出たため、この質問は取り下げました。\n~~秘書から質問が2つあります。/);
  assert.match(w.edits[1].content, /~~質問2【順番】先にしますか？~~$/);
  await w.notifier.tick();
  assert.equal(w.edits.length, 2, 'rewritten once');

  // The words alone, as rewritten.
  const ask = w.ledger.getMessage(two.id);
  assert.equal(withdrawnMessages(ask).every((m) => m.components.length === 0), true);
  assert.deepEqual(askComponents({ ...ask, state: 'withdrawn' }).flatMap((r) => r.components).filter((c) => c.custom_id.startsWith('wf:l:')), [], 'no あとで under a withdrawn one');
});

test('discord: edit rewrites a message with a PATCH, and pings nobody', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const d = createDiscord({ token: 'tkn', channel: '123', user: '456', fetch });
  await d.edit('789', { content: '取り下げました', components: [] });
  assert.equal(calls[0].url, 'https://discord.com/api/v10/channels/123/messages/789');
  assert.equal(calls[0].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[0].init.body), { content: '取り下げました', components: [], allowed_mentions: { parse: [], users: [] } });
});

test('closedTasksSince: what the secretary closed after the mark and is still closed, not what others closed', (t) => {
  const ledger = ledgerFor(t);
  const a = task(ledger, 'A', '2026-11-30');
  const b = task(ledger, 'B', '2026-11-30');
  const c = task(ledger, 'C', '2026-11-30');
  const old = task(ledger, '前に閉じた', '2026-11-30');
  ledger.setState(old.id, 'done', { result: 'x' }, S);
  const mark = ledger.recordMark();
  ledger.setState(a.id, 'done', { result: '出した。秘書が閉じた。根拠: 後ろのタスクが完了' }, S);
  ledger.setState(b.id, 'discarded', { reason: 'もう要らない' }, S);
  ledger.setState(c.id, 'done', { result: '本人が閉じた' }, W);
  const reopened = task(ledger, '戻したもの', '2026-11-30');
  ledger.setState(reopened.id, 'done', { result: 'y' }, S);
  ledger.reopen(reopened.id, W);
  assert.deepEqual(ledger.closedTasksSince(mark, 'secretary').map((x) => [x.title, x.state]), [['A', 'done'], ['B', 'discarded']]);
  assert.match(closedNote('weekly', ledger.closedTasksSince(mark, 'secretary')), /^週の完了確認で、終わっていたタスクを2件閉じました。/);
});

// --- schema --------------------------------------------------------------------------------

test('schema 18: a version 17 file keeps its threads, messages, files and travel, and takes withdrawn', (t) => {
  assert.equal(SCHEMA_VERSION, 18);
  const file = path.join(dir(t), 'v17.sqlite');
  const raw = new DatabaseSync(file);
  raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const m of MIGRATIONS.slice(0, 17)) raw.exec(m);
  raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '17')").run();
  raw.prepare("INSERT INTO threads (id, kind, title, session_id, created_at, updated_at) VALUES ('c_20261001000000_aaaaaa', 'secretary', '秘書', 's-1', 'x', 'x')").run();
  raw.prepare("INSERT INTO messages (id, thread_id, role, kind, body, state, actor, created_at) VALUES ('m_20261001000000_aaaaaa', 'c_20261001000000_aaaaaa', 'secretary', 'ask', '終わりましたか', 'open', 'web', '2026-10-01T00:00:00.000Z')").run();
  raw.prepare("INSERT INTO threads (id, kind, title, parent_id, created_at, updated_at) VALUES ('c_20261001000001_bbbbbb', 'sub', '終わりましたか', 'm_20261001000000_aaaaaa', 'x', 'x')").run();
  raw.prepare("INSERT INTO attachments (id, name, type, size, sha256, message_id, created_at) VALUES ('a_20261001000000_cccccc', 'メモ.txt', 'text/plain', 3, 'h', 'm_20261001000000_aaaaaa', 'x')").run();
  raw.prepare("INSERT INTO bookings (id, title, kind, starts_at, ends_at, created_at, updated_at) VALUES ('b_20261001000000_dddddd', '移動', 'travel', '2026-11-03T03:45:00.000Z', '2026-11-03T04:00:00.000Z', 'x', 'x')").run();
  assert.throws(() => raw.prepare("UPDATE messages SET state = 'withdrawn' WHERE id = 'm_20261001000000_aaaaaa'").run(), /CHECK/);
  raw.close();

  const L = openLedger(file);
  assert.equal(L.getThread().session_id, 's-1');
  assert.equal(L.getBooking('b_20261001000000_dddddd').kind, 'travel');
  assert.equal(L.withdrawAsk('m_20261001000000_aaaaaa', {}, S).state, 'withdrawn');
  L.close();

  const check = new DatabaseSync(file);
  assert.equal(check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '18');
  for (const n of ['threads_v17', 'messages_v17', 'attachments_v17']) assert.equal(check.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(n), undefined);
  assert.equal(check.prepare("SELECT message_id FROM attachments WHERE id = 'a_20261001000000_cccccc'").get().message_id, 'm_20261001000000_aaaaaa');
  assert.equal(check.prepare("SELECT parent_id FROM threads WHERE id = 'c_20261001000001_bbbbbb'").get().parent_id, 'm_20261001000000_aaaaaa');
  assert.equal(check.prepare('PRAGMA foreign_key_check').all().length, 0);
  check.close();
});
