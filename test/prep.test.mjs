// Tests for 下調べ (prep): what an AI found out ahead of the person, written back to a task
// (src/ledger/ledger.mjs writePrep, preps, prepCandidates), the tools prep and prep_candidates,
// a guest's limits on them (src/server/scope.mjs), and where it shows: get, start, the Web
// screen's tasks and activity.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openLedger, LedgerError } from '../src/ledger/ledger.mjs';
import { MIGRATIONS, SCHEMA_VERSION } from '../src/ledger/schema.mjs';
import { createServer } from '../src/server/mcp.mjs';

const ACTOR = { actor: 'human' };
const W = { actor: 'cli' };
const AGENT = { actor: 'agent', device: 'laptop' };
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warifuri-prep-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

// A clock at noon of a fixed day that moves 1 ms on every read; later() moves it on by days.
function clock() {
  let at = new Date(2026, 10, 16, 12).getTime();
  const now = () => new Date((at += 1));
  now.later = (days) => {
    at += days * 24 * 60 * 60 * 1000;
  };
  return now;
}

const FULL = {
  summary: 'ライブラリを3つ比べた。A が速い',
  artifacts: [{ label: '比べた表', url: 'https://example.com/compare' }, { url: 'notes/compare.md' }],
  unknowns: ['ライセンスの条件'],
  next: 'A で試作する',
};

test('ledger: writePrep adds a 下調べ to an open task, keeps the task as it was, and records it', () => {
  const now = clock();
  const L = openLedger(':memory:', { now });
  L.issueKey('laptop', W);
  const task = L.createTask({ title: 'ライブラリを選ぶ', mode: 'ai_worker' }, ACTOR);
  const before = L.get(task.id);
  const prep = L.writePrep(task.id, { ...FULL, summary: `  ${FULL.summary}\r\n` }, AGENT);
  assert.deepEqual(
    { ...prep, id: undefined, created_at: undefined },
    {
      id: undefined, task_id: task.id, device: 'laptop', actor: 'agent', summary: FULL.summary,
      artifacts: [{ label: '比べた表', url: 'https://example.com/compare' }, { label: null, url: 'notes/compare.md' }],
      unknowns: ['ライセンスの条件'], next: 'A で試作する', created_at: undefined,
      rating: null, rating_note: null, rated_by: null, rated_at: null,
    },
  );
  const got = L.get(task.id);
  assert.equal(got.state, 'ready');
  assert.equal(got.updated_at, before.updated_at);
  assert.deepEqual(got.preps.map((p) => p.id), [prep.id]);
  const rec = got.records.at(-1);
  assert.deepEqual([rec.action, rec.device, rec.changes.prep.summary, rec.changes.prep.unknowns], ['prep', 'laptop', FULL.summary, ['ライセンスの条件']]);

  // Newest first; summary alone is enough.
  const second = L.writePrep(task.id, { summary: '続きを調べた' }, AGENT);
  assert.deepEqual(L.preps(task.id).map((p) => p.id), [second.id, prep.id]);
  assert.deepEqual([second.artifacts, second.unknowns, second.next], [[], [], null]);

  // activity counts it, with its summary.
  const moved = L.activity();
  assert.equal(moved.counts.prepped, 2);
  assert.equal(moved.items.find((i) => i.kind === 'prepped').summary, '続きを調べた');
  L.close();
});

test('ledger: writePrep refuses a closed task, a missing one and a bad shape', () => {
  const L = openLedger(':memory:', { now: clock() });
  const task = L.createTask({ title: 'x', mode: 'ai_worker' }, ACTOR);
  const closed = L.createTask({ title: 'y', mode: 'ai_worker' }, ACTOR);
  L.setState(closed.id, 'done', { result: 'ok' }, ACTOR);
  assert.throws(() => L.writePrep(closed.id, { summary: 'a' }, ACTOR), /閉じています/);
  const dropped = L.createTask({ title: 'z', mode: 'ai_worker' }, ACTOR);
  L.setState(dropped.id, 'discarded', { reason: 'no' }, ACTOR);
  assert.throws(() => L.writePrep(dropped.id, { summary: 'a' }, ACTOR), /閉じています/);
  assert.throws(() => L.writePrep('t_20261116000000_nonexi', { summary: 'a' }, ACTOR), /ありません/);
  const bad = (fields) => {
    try {
      L.writePrep(task.id, fields, ACTOR);
    } catch (err) {
      assert.ok(err instanceof LedgerError);
      return err.problems.join('\n');
    }
    return assert.fail('not refused');
  };
  assert.match(bad({ summary: ' ' }), /要約\(summary\)が要ります/);
  assert.match(bad({ summary: 'a', artifacts: [{ label: 'no url' }] }), /url は/);
  assert.match(bad({ summary: 'a', artifacts: [{ url: 'x', size: 1 }] }), /知らない項目/);
  assert.match(bad({ summary: 'a', artifacts: 'x' }), /\{ label, url \} の一覧/);
  assert.match(bad({ summary: 'a', unknowns: ['two\nlines'] }), /1件を1行/);
  assert.match(bad({ summary: 'a', next: 'a\nb' }), /続きの提案/);
  assert.match(bad({ summary: 'a', state: 'done' }), /state はここでは書けません/);
  assert.deepEqual(L.preps(task.id), []);
  assert.equal(L.get(task.id).state, 'ready');
  L.close();
});

test('ledger: prepCandidates scores open, unstarted tasks, asked ones first, and sends recent ones last', () => {
  const now = clock();
  const L = openLedger(':memory:', { now });
  L.issueKey('laptop', W);
  const goal = L.createGoal({ title: '作品', mode: 'human_with_ai', outcome: '飾れる', due: '2026-11-26', profile: '趣味' }, ACTOR);
  const late = L.createTask({ title: '期限の遠い AI の仕事', mode: 'ai_worker', due: '2026-12-20' }, ACTOR);
  const soon = L.createTask({ title: '期限の近い AI の仕事', mode: 'human_with_ai', due: '2026-11-20', done_when: 'x' }, ACTOR);
  const words = L.createTask({ title: '部品を比較する', mode: 'human', done_when: 'x', goal_id: goal.id }, ACTOR);
  const after1 = L.createTask({ title: '組み立てる', mode: 'human', done_when: 'x', goal_id: goal.id, after: [words.id] }, ACTOR);
  L.createTask({ title: '塗る', mode: 'human', done_when: 'x', goal_id: goal.id, after: [after1.id] }, ACTOR);
  L.link(words.id, late.id, ACTOR);
  const asked = L.createTask({ title: '電話する', mode: 'human', done_when: 'x' }, ACTOR);
  const plain = L.createTask({ title: 'メールを書く', mode: 'human', done_when: 'x' }, ACTOR);
  const held = L.createTask({ title: '着手済みの AI の仕事', mode: 'ai_worker' }, ACTOR);
  L.start(held.id, { device: 'laptop' }, AGENT);
  const waiting = L.createTask({ title: '待っている AI の仕事', mode: 'ai_worker' }, ACTOR);
  L.setState(waiting.id, 'waiting', { waiting_on: 'だれか', waiting_for: '返事' }, ACTOR);
  const done = L.createTask({ title: '終わった AI の仕事', mode: 'ai_worker' }, ACTOR);
  L.setState(done.id, 'done', { result: 'ok' }, ACTOR);
  // The 印 alone: a plain human task becomes a candidate, and it is not "worked on".
  const marked = L.update(asked.id, { prep_wanted: true }, ACTOR);
  assert.equal(marked.prep_wanted, true);
  assert.ok(marked.prep_wanted_at);

  const ids = (out) => out.candidates.map((c) => c.id);
  const out = L.prepCandidates({ limit: 10 });
  assert.deepEqual(ids(out), [asked.id, words.id, soon.id, late.id, waiting.id]);
  assert.ok(![plain.id, held.id, done.id].some((id) => ids(out).includes(id)));
  const by = (o, id) => o.candidates.find((c) => c.id === id);
  assert.deepEqual([by(out, asked.id).score, by(out, asked.id).why], [110, ['下調べを頼まれている', 'まだ下調べがない']]);
  const first = by(out, words.id);
  assert.deepEqual(
    [first.blocks, first.score, first.why, first.goal, first.profile, first.preps, first.recent_prep, first.recently_touched, first.prep_wanted],
    [2, 51, ['ほかの2件を待たせている', '本人が手を動かす前に調べものがありそう', 'ゴールの期限まで残り10日', 'まだ下調べがない'],
      { id: goal.id, title: '作品', due: '2026-11-26' }, '趣味', 0, false, false, false],
  );
  assert.deepEqual([by(out, soon.id).score, by(out, soon.id).why], [35, ['期限まで残り4日', '本人と AI で進める', 'まだ下調べがない']]);
  assert.equal(by(out, late.id).score, 10);
  // The default limit is small, and says how many to look into.
  const short = L.prepCandidates();
  assert.deepEqual([short.candidates.length, short.more, short.suggest, short.today], [5, 0, 5, { daily: 8, written: 0, left: 8 }]);
  assert.deepEqual([L.prepCandidates({ limit: 2 }).candidates.length, L.prepCandidates({ limit: 2 }).more], [2, 3]);

  // A 下調べ in the last 3 days sends it to the end, marked; after that it comes back.
  const p = L.writePrep(words.id, { summary: '調べた' }, AGENT);
  const again = L.prepCandidates({ limit: 10 });
  // Both last: words (just prepped) and waiting (put to waiting just now), by score.
  assert.deepEqual(ids(again), [asked.id, soon.id, late.id, words.id, waiting.id]);
  assert.equal(by(again, waiting.id).recently_touched, true);
  assert.deepEqual([by(again, words.id).recent_prep, by(again, words.id).preps, by(again, words.id).last_prep_at, by(again, words.id).score], [true, 1, p.created_at, 41]);
  assert.ok(by(again, words.id).why.includes('最近下調べを書いた'));
  // The asked one, once a 下調べ is written after the ask, loses its points.
  L.writePrep(asked.id, { summary: '番号を調べた' }, AGENT);
  const answered = by(L.prepCandidates({ limit: 10 }), asked.id);
  assert.deepEqual([answered.score, answered.why.includes('頼まれた下調べはもう書いてある')], [0, true]);
  assert.equal(L.prepCandidates({ limit: 10 }).candidates.at(-1).id, asked.id);
  now.later(4);
  // Four days on: soon is due today, words' goal is nearer; a tie goes to the nearer due.
  const later = L.prepCandidates({ limit: 10 });
  assert.deepEqual(later.candidates.slice(0, 2).map((c) => [c.id, c.score]), [[soon.id, 43], [words.id, 43]]);
  assert.ok(by(later, soon.id).why.includes('期限が今日'));
  assert.equal(L.prepCandidates({ recentDays: 7, limit: 10 }).candidates.at(-1).id, asked.id);
  // Taking the 印 back.
  assert.equal(L.update(asked.id, { prep_wanted: false }, ACTOR).prep_wanted_at, null);
  assert.throws(() => L.update(goal.id, { prep_wanted: true }, ACTOR), /タスクにだけ/);
  assert.throws(() => L.update(asked.id, { prep_wanted: 'yes' }, ACTOR), /true か false/);

  assert.deepEqual(ids(L.prepCandidates({ profile: '趣味' })), [words.id]);
  assert.ok(!ids(L.prepCandidates({ keep: (t) => t.id !== soon.id, limit: 10 })).includes(soon.id));
  assert.throws(() => L.prepCandidates({ limit: 0 }), /limit/);
  L.close();
});

test('ledger: a task someone worked on lately goes last, marked; the secretary, a guest and the 印 do not count', () => {
  const now = clock();
  const L = openLedger(':memory:', { now });
  L.issueKey('laptop', W);
  L.addDevice('muse', W);
  L.setDeviceScope('muse', {}, W);
  const mk = (title) => L.createTask({ title: `${title}を調べる`, mode: 'ai_worker' }, ACTOR).id;
  const [worked, bySecretary, byGuest, fresh, asked] = ['作業', '秘書', '外', '新しい', '頼んだ'].map(mk);
  L.start(worked, { device: 'laptop' }, AGENT);
  L.release(worked, { next: '比べる表を作る' }, AGENT);
  L.update(bySecretary, { due: '2026-11-30' }, { actor: 'device-key', device: 'secretary' });
  L.update(byGuest, { next: 'x' }, { actor: 'device-key', device: 'muse' });
  L.update(asked, { body: '説明を足した' }, ACTOR);
  L.update(asked, { prep_wanted: true }, ACTOR);

  const out = L.prepCandidates({ limit: 10, quiet: ['secretary'] });
  const by = (id) => out.candidates.find((c) => c.id === id);
  assert.deepEqual([by(worked).recently_touched, by(bySecretary).recently_touched, by(byGuest).recently_touched, by(fresh).recently_touched], [true, false, false, false]);
  assert.ok(by(worked).why.includes('最近だれかが手を付けた'));
  // Asked: kept in front though worked on.
  assert.equal(out.candidates[0].id, asked);
  assert.deepEqual([by(asked).recently_touched, by(asked).why.at(-1)], [true, '最近だれかが手を付けたが、頼まれているので前に置く']);
  assert.equal(out.candidates.at(-1).id, worked);
  // Without quiet, the secretary's write counts.
  assert.equal(L.prepCandidates({ limit: 10 }).candidates.find((c) => c.id === bySecretary).recently_touched, true);
  // After 2 days it is no longer recent.
  now.later(2);
  assert.equal(L.prepCandidates({ limit: 10 }).candidates.find((c) => c.id === worked).recently_touched, false);
  L.close();
});

test('ledger: known says what is already known of a candidate', () => {
  const L = openLedger(':memory:', { now: clock() });
  L.issueKey('laptop', W);
  const long = `${'あ'.repeat(450)}`;
  const task = L.createTask({ title: '部品を比較する', mode: 'ai_worker', body: long, done_when: '表がある' }, ACTOR);
  L.start(task.id, { device: 'laptop' }, AGENT);
  L.release(task.id, { next: '価格を見る' }, AGENT);
  L.update(task.id, { next: '在庫を見る' }, ACTOR);
  L.setState(task.id, 'waiting', { waiting_on: '店', waiting_for: '見積もり' }, ACTOR);
  const p1 = L.writePrep(task.id, { summary: '3社を比べた', unknowns: ['送料'], next: 'A 社に聞く' }, AGENT);
  L.ratePrep(p1.id, 'useful', { note: '表をそのまま使えた' }, AGENT);
  L.writePrep(task.id, { summary: 'x'.repeat(320) }, AGENT);

  const [c] = L.prepCandidates().candidates;
  const k = c.known;
  assert.equal(k.body, `${'あ'.repeat(400)}…`);
  assert.equal(k.body_cut, true);
  assert.deepEqual([k.next, k.done_when, k.waiting, k.defer_until], ['在庫を見る', '表がある', { on: '店', for: '見積もり' }, null]);
  assert.deepEqual(k.recent.map((r) => r.what), ['待ちにした: 店 の 見積もり', '次の一手: 在庫を見る', '手放した。次: 価格を見る', '着手した']);
  assert.deepEqual(k.recent.map((r) => r.by), ['human', 'human', 'laptop', 'laptop']);
  assert.equal(k.preps.length, 2);
  assert.equal(k.preps[0].summary, `${'x'.repeat(300)}…`);
  assert.deepEqual([k.preps[1].summary, k.preps[1].unknowns, k.preps[1].next, k.preps[1].rating, k.preps[1].rating_note, k.preps[1].by], ['3社を比べた', ['送料'], 'A 社に聞く', 'useful', '表をそのまま使えた', 'laptop']);
  assert.deepEqual([k.last_moved.by, k.last_moved.what], ['human', '待ちにした: 店 の 見積もり']);
  L.close();
});

test('ledger: ratePrep keeps a rating, its reason and who; feedback sums them and bad ones lower the score', () => {
  const now = clock();
  const L = openLedger(':memory:', { now });
  L.issueKey('laptop', W);
  const goal = L.createGoal({ title: '研究', mode: 'ai_worker', profile: '研究' }, ACTOR);
  const a = L.createTask({ title: '論文を調べる', mode: 'ai_worker', goal_id: goal.id }, ACTOR);
  const b = L.createTask({ title: '手法を比べる', mode: 'ai_worker', goal_id: goal.id }, ACTOR);
  const other = L.createTask({ title: '道具を調べる', mode: 'ai_worker' }, ACTOR);
  const before = L.prepCandidates({ limit: 10 }).candidates.find((c) => c.id === b.id).score;
  const p = L.writePrep(a.id, { summary: '論文を3本読んだ' }, { actor: 'device-key', device: 'muse' });

  const rated = L.ratePrep(p.id, 'duplicate', { note: 'もう読んでいた\n要約も手元にあった' }, AGENT);
  assert.deepEqual([rated.rating, rated.rating_note, rated.rated_by], ['duplicate', 'もう読んでいた\n要約も手元にあった', 'laptop']);
  assert.ok(rated.rated_at);
  const rec = L.records(a.id).at(-1);
  assert.deepEqual([rec.action, rec.changes.prep_id, rec.changes.rating], ['prep_rating', p.id, { before: null, after: 'duplicate' }]);
  // Rating it does not count as working on the task, nor change it.
  assert.equal(L.get(a.id).state, 'ready');

  const out = L.prepCandidates({ limit: 10 });
  const cb = out.candidates.find((c) => c.id === b.id);
  assert.equal(cb.score, before - 6);
  assert.ok(cb.why.includes('このゴールやプロフィールの下調べに、二度手間や的外れの評価が多い'));
  assert.equal(out.candidates.find((c) => c.id === other.id).why.includes('このゴールやプロフィールの下調べに、二度手間や的外れの評価が多い'), false);
  assert.deepEqual(
    { ...out.feedback, bad: out.feedback.bad.map((x) => [x.task_title, x.rating, x.rating_word, x.note, x.by, x.rated_by]) },
    { days: 30, useful: 0, duplicate: 1, off: 0, by: { laptop: 1 }, bad: [['論文を調べる', 'duplicate', '二度手間', 'もう読んでいた\n要約も手元にあった', 'muse', 'laptop']] },
  );

  // The Web screen rates as web; null takes it back.
  assert.equal(L.ratePrep(p.id, 'useful', {}, { actor: 'web' }).rated_by, 'web');
  assert.deepEqual(L.prepCandidates().feedback.by, { web: 1 });
  const back = L.ratePrep(p.id, null, {}, ACTOR);
  assert.deepEqual([back.rating, back.rating_note, back.rated_by, back.rated_at], [null, null, null, null]);
  assert.deepEqual([L.prepCandidates().feedback.useful, L.prepCandidates().feedback.bad], [0, []]);
  assert.throws(() => L.ratePrep(p.id, 'great', {}, ACTOR), /useful, duplicate, off/);
  assert.throws(() => L.ratePrep(p.id, 'off', { note: 'a\nb\nc' }, ACTOR), /2行/);
  assert.throws(() => L.ratePrep(9999, 'off', {}, ACTOR), /ありません/);

  // Ratings older than 30 days are not counted.
  L.ratePrep(p.id, 'off', {}, ACTOR);
  now.later(31);
  assert.equal(L.prepCandidates().feedback.off, 0);
  L.close();
});

test('ledger: the day\'s aim counts this device\'s 下調べ since midnight', () => {
  const now = clock();
  const L = openLedger(':memory:', { now });
  const tasks = ['a', 'b', 'c'].map((x) => L.createTask({ title: `${x}を調べる`, mode: 'ai_worker' }, ACTOR).id);
  const MUSE = { actor: 'device-key', device: 'muse' };
  L.writePrep(tasks[0], { summary: '1' }, MUSE);
  L.writePrep(tasks[1], { summary: '2' }, MUSE);
  L.writePrep(tasks[2], { summary: '3' }, AGENT);
  const out = L.prepCandidates({ device: 'muse', daily: 2 });
  assert.deepEqual([out.today, out.suggest, out.notice], [{ daily: 2, written: 2, left: 0 }, 0, '今日の目安の2件に達しました。今日はここまでです']);
  assert.equal(out.candidates.length, 3);
  assert.deepEqual(L.prepCandidates({ device: 'muse', daily: 3 }).today, { daily: 3, written: 2, left: 1 });
  assert.equal(L.prepCandidates({ device: 'muse', daily: 3 }).suggest, 1);
  now.later(1);
  assert.deepEqual(L.prepCandidates({ device: 'muse', daily: 2 }).today, { daily: 2, written: 0, left: 2 });
  L.close();
});

test('ledger: a snapshot that drops a task drops its 下調べ; the records keep them', () => {
  const L = openLedger(':memory:', { now: clock() });
  const T1 = 't_20261002090000_keep01';
  const T2 = 't_20261002090000_gone01';
  const doc = (tasks) => ({ format: 'warifuri-snapshot', version: 1, source: 'tracker', places: [], goals: [], blocks: [], tasks });
  const both = [{ id: T1, title: 'Keep', mode: 'ai_worker', state: 'ready' }, { id: T2, title: 'Gone', mode: 'ai_worker', state: 'ready' }];
  L.replaceFromSnapshot(doc(both), ACTOR);
  L.writePrep(T1, { summary: 'keep' }, ACTOR);
  L.writePrep(T2, { summary: 'gone' }, ACTOR);
  assert.equal(L.replaceFromSnapshot(doc(both), ACTOR).counts.tasks, 2);
  assert.equal(L.preps(T2).length, 1);
  L.replaceFromSnapshot(doc([both[0]]), ACTOR);
  assert.deepEqual(L.preps(T1).map((p) => p.summary), ['keep']);
  assert.deepEqual(L.preps(T2), []);
  assert.equal(L.records(T2).find((r) => r.action === 'prep').changes.prep.summary, 'gone');
  assert.equal(L.records('tracker').at(-1).changes.dropped_preps, 1);
  L.close();
});

test('schema: a version 19 file gains preps, empty, and its tasks take one', () => {
  const file = path.join(tmpRoot, 'v19.sqlite');
  const raw = new DatabaseSync(file);
  raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const m of MIGRATIONS.slice(0, 19)) raw.exec(m);
  raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '19')").run();
  raw.prepare("INSERT INTO tasks (id, title, state, mode, created_at, updated_at) VALUES ('t_20261001000000_aaaaaa', 'Old task', 'ready', 'ai_worker', 'x', 'x')").run();
  raw.close();

  assert.equal(SCHEMA_VERSION, 21);
  const L = openLedger(file);
  assert.deepEqual(L.get('t_20261001000000_aaaaaa').preps, []);
  assert.equal(L.writePrep('t_20261001000000_aaaaaa', { summary: 'a' }, ACTOR).summary, 'a');
  L.close();
  const check = new DatabaseSync(file);
  assert.equal(check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '21');
  assert.throws(() => check.exec("INSERT INTO preps (task_id, actor, summary, created_at) VALUES ('t_none', 'x', 'a', 'x')"), /FOREIGN KEY/);
  check.close();
});

test('schema: a version 20 file keeps its 下調べ, unrated, and its tasks gain the 印, unset', () => {
  const file = path.join(tmpRoot, 'v20.sqlite');
  const raw = new DatabaseSync(file);
  raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const m of MIGRATIONS.slice(0, 20)) raw.exec(m);
  raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '20')").run();
  raw.prepare("INSERT INTO tasks (id, title, state, mode, created_at, updated_at) VALUES ('t_20261001000000_bbbbbb', 'Old task', 'ready', 'ai_worker', 'x', 'x')").run();
  raw.prepare("INSERT INTO preps (task_id, actor, summary, created_at) VALUES ('t_20261001000000_bbbbbb', 'agent', 'old', '2026-10-01T00:00:00.000Z')").run();
  raw.close();

  const L = openLedger(file);
  const task = L.get('t_20261001000000_bbbbbb');
  assert.deepEqual([task.prep_wanted, task.prep_wanted_at], [false, null]);
  assert.deepEqual([task.preps[0].summary, task.preps[0].rating], ['old', null]);
  assert.equal(L.ratePrep(task.preps[0].id, 'useful', {}, ACTOR).rating, 'useful');
  L.close();
  const check = new DatabaseSync(file);
  assert.throws(() => check.exec("UPDATE preps SET rating = 'great'"), /CHECK/);
  check.close();
});

// A server with an agent's key, a guest's key (仕事 fully hidden, 研究 with only its people
// hidden, サークル not shown), and tasks of each profile.
async function serve(t, { scope = { profiles: ['仕事', '趣味', '研究'], hide: { 仕事: ['people', 'knowledge', 'details'], 研究: ['people'] } } } = {}) {
  const now = clock();
  const ledger = openLedger(':memory:', { now });
  const home = path.join(tmpRoot, `home-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(home, { recursive: true });
  const keys = { laptop: ledger.issueKey('laptop', W).key };
  ledger.addDevice('muse', W);
  ledger.setDeviceScope('muse', scope, W);
  keys.muse = ledger.issueKey('muse', W).key;
  const goal = (profile) => ledger.createGoal({ title: `${profile}のゴール`, mode: 'ai_worker', profile }, ACTOR).id;
  const task = (title, goalId, extra = {}) => ledger.createTask({ title, mode: 'ai_worker', goal_id: goalId, body: `${title}の説明`, ...extra }, ACTOR).id;
  const ids = {
    work: task('見積もりを調べる', goal('仕事')),
    hobby: task('塗料を比べる', goal('趣味')),
    research: task('論文を探す', goal('研究')),
    club: task('会場を調べる', goal('サークル')),
    loose: task('どこにも入らない調べもの'),
  };
  const office = ledger.createPlace({ name: 'office', profile: '仕事', paths: [{ device: 'laptop', path: '/home/alex/office' }] }, ACTOR);
  const hobbyPlace = ledger.createPlace({ name: 'hobby', profile: '趣味', paths: [{ device: 'laptop', path: '/home/alex/hobby' }] }, ACTOR);
  const server = createServer({ ledger, home, secretary: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const clients = [];
  t.after(async () => {
    for (const c of clients) await c.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    ledger.close();
  });
  async function connect(name) {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${keys[name]}` } } }));
    clients.push(client);
    return client;
  }
  return { ledger, base, connect, ids, places: { office: office.id, hobby: hobbyPlace.id } };
}

const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { res, data: res.isError ? null : res.structuredContent, text: res.content[0]?.text ?? '' };
};

test('tools: an agent writes a 下調べ with prep; get lists them and start shows the newest', async (t) => {
  const { ledger, connect, ids, places } = await serve(t);
  const laptop = await connect('laptop');
  const { data: first } = await call(laptop, 'prep', { task_id: ids.hobby, summary: '水性と油性を比べた' });
  assert.equal(first.device, 'laptop');
  const { data: second } = await call(laptop, 'prep', { task_id: ids.hobby, ...FULL });
  assert.deepEqual(second.artifacts, [{ label: '比べた表', url: 'https://example.com/compare' }, { label: null, url: 'notes/compare.md' }]);
  assert.equal(ledger.get(ids.hobby).state, 'ready');

  const { data: got } = await call(laptop, 'get', { id: ids.hobby });
  assert.deepEqual(got.preps.map((p) => p.summary), [FULL.summary, '水性と油性を比べた']);

  const { data: started } = await call(laptop, 'start', { task_id: ids.hobby, place: places.hobby });
  assert.equal(started.state, 'running');
  assert.match(started.prep.notice, /下調べがあります\(2件\)/);
  assert.equal(started.prep.count, 2);
  assert.deepEqual(started.prep.latest, { id: second.id, by: 'laptop', at: second.created_at, summary: FULL.summary, artifacts: second.artifacts, unknowns: FULL.unknowns, next: FULL.next, rating: null });
  assert.match(started.prep.notice, /rate_prep で使えたかどうかを返してください/);
  // A task with no 下調べ starts as before.
  await call(laptop, 'release', { task_id: ids.hobby, next: '続き' });
  const { data: plain } = await call(laptop, 'start', { task_id: ids.work, place: places.office });
  assert.equal('prep' in plain, false);

  // Refused: a closed task, a bad shape.
  ledger.setState(ids.loose, 'done', { result: 'ok' }, ACTOR);
  assert.match((await call(laptop, 'prep', { task_id: ids.loose, summary: 'x' })).text, /閉じています/);
  assert.match((await call(laptop, 'prep', { task_id: ids.research, summary: '' })).text, /要約/);

  // 仕事 is held, the loose one closed; 塗料 was just prepped, so it comes last, marked.
  const { data: list } = await call(laptop, 'prep_candidates', {});
  // 会場を調べる reads like research (a few points more); 塗料 was just prepped and worked on.
  assert.deepEqual(list.candidates.map((c) => [c.title, c.recent_prep, c.recently_touched]), [['会場を調べる', false, false], ['論文を探す', false, false], ['塗料を比べる', true, true]]);
  const { data: byPlace } = await call(laptop, 'prep_candidates', { place: '/home/alex/office' });
  assert.deepEqual(byPlace.candidates, []);
});

test('tools: a guest writes 下調べ only where it sees the details, and is offered only those tasks', async (t) => {
  const { ledger, connect, ids } = await serve(t);
  const muse = await connect('muse');
  const names = (await muse.listTools()).tools.map((x) => x.name);
  assert.ok(names.includes('prep') && names.includes('prep_candidates'));

  // 仕事 hides its details: refused, and nothing is written.
  assert.match((await call(muse, 'prep', { task_id: ids.work, summary: '調べた' })).text, /仕事 のタスクには、この鍵からは下調べを書けません/);
  assert.deepEqual(ledger.preps(ids.work), []);
  // サークル is not shown: as if the task were not there.
  assert.match((await call(muse, 'prep', { task_id: ids.club, summary: '調べた' })).text, /というタスクはありません/);
  assert.match((await call(muse, 'prep', { task_id: 't_20261116000000_nonexi', summary: '調べた' })).text, /というタスクはありません/);
  assert.deepEqual(ledger.preps(ids.club), []);
  // 趣味, 研究 (only its people hidden) and a task with no profile take one.
  for (const id of [ids.hobby, ids.research, ids.loose]) {
    const out = await call(muse, 'prep', { task_id: id, ...FULL });
    assert.equal(out.data.device, 'muse', id);
  }

  // prep_candidates leaves out 仕事 (details hidden) and サークル (not shown).
  ledger.writePrep(ids.hobby, { summary: 'x' }, ACTOR);
  const { data } = await call(muse, 'prep_candidates', {});
  const titles = data.candidates.map((c) => c.title);
  assert.ok(!titles.includes('見積もりを調べる') && !titles.includes('会場を調べる'));
  assert.deepEqual(titles.sort(), ['塗料を比べる', '論文を探す', 'どこにも入らない調べもの'].sort());
  assert.ok(!JSON.stringify(data).includes('見積もりを調べるの説明'));
  assert.match((await call(muse, 'prep_candidates', { place: '/home/alex/office' })).text, /place を使えません/);
  assert.match((await call(muse, 'prep_candidates', { profile: 'サークル' })).text, /見せていません/);
  assert.deepEqual((await call(muse, 'prep_candidates', { profile: '仕事' })).data.candidates, []);

  // get shows its 下調べ where it sees the details; a hidden task's get has none.
  assert.equal((await call(muse, 'get', { id: ids.hobby })).data.preps.length, 2);
  ledger.writePrep(ids.work, { summary: 'secret-prep' }, ACTOR);
  const hidden = await call(muse, 'get', { id: ids.work });
  assert.equal('preps' in hidden.data, false);
  assert.ok(!hidden.text.includes('secret-prep'));
});

test('tools: a guest whose write leaves out prep has neither prep nor its writes', async (t) => {
  const { connect, ids } = await serve(t, { scope: { write: ['note'] } });
  const muse = await connect('muse');
  const names = (await muse.listTools()).tools.map((x) => x.name);
  assert.ok(!names.includes('prep'));
  assert.ok(names.includes('prep_candidates'));
  assert.equal((await muse.callTool({ name: 'prep', arguments: { task_id: ids.hobby, summary: 'x' } })).isError, true);
});

test('web: the tasks endpoint carries each task\'s 下調べ, newest first', async (t) => {
  const { ledger, base, ids } = await serve(t);
  ledger.writePrep(ids.hobby, { summary: '古い' }, { actor: 'device-key', device: 'muse' });
  ledger.writePrep(ids.hobby, FULL, { actor: 'device-key', device: 'muse' });
  const tasks = await (await fetch(`${base}/web/api/tasks`)).json();
  const hobby = tasks.goals.flatMap((g) => g.tasks).find((x) => x.id === ids.hobby);
  assert.deepEqual(hobby.preps.map((p) => [p.by, p.summary]), [['muse', FULL.summary], ['muse', '古い']]);
  assert.deepEqual(hobby.preps[0].artifacts, [{ label: '比べた表', url: 'https://example.com/compare' }, { label: null, url: 'notes/compare.md' }]);
  assert.deepEqual(hobby.preps[0].unknowns, FULL.unknowns);
  const research = tasks.goals.flatMap((g) => g.tasks).find((x) => x.id === ids.research);
  assert.deepEqual(research.preps, []);
});

test('tools: an agent asks for a 下調べ with update, rates one with rate_prep, and close asks for a rating', async (t) => {
  const { ledger, connect, ids, places } = await serve(t);
  const laptop = await connect('laptop');
  const { data: marked } = await call(laptop, 'update', { id: ids.research, prep_wanted: true });
  assert.equal(marked.prep_wanted, true);
  const { data: list } = await call(laptop, 'prep_candidates', {});
  assert.equal(list.candidates[0].id, ids.research);
  assert.equal(list.candidates[0].why[0], '下調べを頼まれている');
  assert.deepEqual([list.suggest, list.today], [list.candidates.length, { daily: 8, written: 0, left: 8 }]);
  assert.ok('known' in list.candidates[0] && 'feedback' in list);

  // prep says how many are left today.
  const { data: written } = await call(laptop, 'prep', { task_id: ids.research, summary: '論文を2本見つけた' });
  assert.deepEqual(written.today, { daily: 8, written: 1, left: 7 });

  // rate_prep by the task (its newest 下調べ) or by the 下調べ's id.
  const { data: rated } = await call(laptop, 'rate_prep', { task_id: ids.research, rating: 'off', note: '探していた分野と違った' });
  assert.deepEqual([rated.id, rated.rating, rated.rated_by, rated.rating_note], [written.id, 'off', 'laptop', '探していた分野と違った']);
  assert.equal((await call(laptop, 'rate_prep', { prep_id: written.id, rating: null })).data.rating, null);
  assert.match((await call(laptop, 'rate_prep', { rating: 'useful' })).text, /どちらか1つ/);
  assert.match((await call(laptop, 'rate_prep', { task_id: ids.hobby, rating: 'useful' })).text, /下調べがありません/);
  assert.match((await call(laptop, 'rate_prep', { prep_id: 9999, rating: 'useful' })).text, /ありません/);

  // Closing a task whose 下調べ has no rating: closed, with a word to rate it.
  await call(laptop, 'start', { task_id: ids.research, place: places.hobby });
  const { data: closed } = await call(laptop, 'close', { id: ids.research, state: 'done', result: 'ok' });
  assert.equal(closed.state, 'done');
  assert.deepEqual(closed.prep_unrated.ids, [written.id]);
  assert.match(closed.prep_unrated.notice, /rate_prep/);
  ledger.writePrep(ids.loose, { summary: 'x' }, ACTOR);
  ledger.ratePrep(ledger.preps(ids.loose)[0].id, 'useful', {}, ACTOR);
  const { data: plain } = await call(laptop, 'close', { id: ids.loose, state: 'done', result: 'ok' });
  assert.equal('prep_unrated' in plain, false);
});

test('tools: a guest can neither ask for nor rate a 下調べ, and its feedback leaves out what it may not see', async (t) => {
  const { ledger, connect, ids } = await serve(t);
  const muse = await connect('muse');
  const names = (await muse.listTools()).tools.map((x) => x.name);
  assert.ok(!names.includes('update') && !names.includes('rate_prep'));
  assert.equal((await muse.callTool({ name: 'rate_prep', arguments: { task_id: ids.hobby, rating: 'useful' } })).isError, true);
  assert.equal((await muse.callTool({ name: 'update', arguments: { id: ids.hobby, prep_wanted: true } })).isError, true);
  assert.equal(ledger.get(ids.hobby).prep_wanted, false);

  // Rated 下調べ on 仕事 (details hidden), サークル (not shown) and 趣味.
  for (const [id, rating] of [[ids.work, 'off'], [ids.club, 'duplicate'], [ids.hobby, 'off']]) {
    const p = ledger.writePrep(id, { summary: `${id}-secret` }, { actor: 'device-key', device: 'muse' });
    ledger.ratePrep(p.id, rating, { note: 'why' }, AGENT);
  }
  const { data, text } = await call(muse, 'prep_candidates', {});
  assert.deepEqual(data.feedback.bad.map((b) => b.task_id), [ids.hobby]);
  assert.deepEqual([data.feedback.off, data.feedback.duplicate], [1, 0]);
  assert.ok(!text.includes(`${ids.work}-secret`) && !text.includes(`${ids.club}-secret`));
  assert.ok(data.candidates.every((c) => c.profile !== '仕事' && c.profile !== 'サークル'));
  // The guest's 下調べ today are counted against its own aim.
  assert.equal(data.today.written, 3);
});

test('web: a task\'s 下調べを頼む and a 下調べ\'s rating are written from the screen', async (t) => {
  const { ledger, base, ids } = await serve(t);
  const post = (p, body, headers = {}) => fetch(`${base}/web/api${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body) });
  assert.equal((await post(`/tasks/${ids.hobby}/prep-wanted`, { wanted: true }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(`/tasks/${ids.hobby}/prep-wanted`, { wanted: 'yes' })).status, 400);
  assert.equal((await post('/tasks/t_20261116000000_nonexi/prep-wanted', { wanted: true })).status, 404);
  assert.deepEqual(await (await post(`/tasks/${ids.hobby}/prep-wanted`, { wanted: true })).json(), { id: ids.hobby, prep_wanted: true });
  assert.equal(ledger.records(ids.hobby).at(-1).actor, 'web');

  const p = ledger.writePrep(ids.hobby, FULL, { actor: 'device-key', device: 'muse' });
  assert.equal((await post(`/preps/${p.id}/rating`, { rating: 'great' })).status, 400);
  assert.equal((await post('/preps/9999/rating', { rating: 'useful' })).status, 400);
  assert.deepEqual(await (await post(`/preps/${p.id}/rating`, { rating: 'duplicate' })).json(), { id: p.id, rating: 'duplicate', rated_by: 'web' });
  const tasks = await (await fetch(`${base}/web/api/tasks`)).json();
  const hobby = tasks.goals.flatMap((g) => g.tasks).find((x) => x.id === ids.hobby);
  assert.equal(hobby.prep_wanted, true);
  assert.deepEqual([hobby.preps[0].id, hobby.preps[0].rating, hobby.preps[0].rated_by], [p.id, 'duplicate', 'web']);
  assert.equal((await (await post(`/preps/${p.id}/rating`, { rating: null })).json()).rating, null);
  assert.equal((await (await post(`/tasks/${ids.hobby}/prep-wanted`, { wanted: false })).json()).prep_wanted, false);
});
