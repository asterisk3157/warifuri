// Tests for importing a snapshot (src/ledger/snapshot.mjs, replaceFromSnapshot in
// src/ledger/ledger.mjs), the review flag it leaves, and the `warifuri import` command.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openLedger, LedgerError } from '../src/ledger/ledger.mjs';
import { cli } from './cli.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warifuri-snapshot-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const ACTOR = { actor: 'import' };
let fileCounter = 0;

function clock(start = '2026-10-24T00:00:00Z') {
  let t = Date.parse(start);
  return () => {
    const d = new Date(t);
    t += 1000;
    return d;
  };
}

function fresh(t) {
  fileCounter += 1;
  const file = path.join(tmpRoot, `ledger-${fileCounter}.db`);
  const L = openLedger(file, { now: clock() });
  const raw = new DatabaseSync(file);
  t.after(() => {
    raw.close();
    L.close();
  });
  const count = (table) => raw.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  const importRecords = () => raw.prepare("SELECT * FROM records WHERE entity = 'import' ORDER BY id").all();
  return { L, count, importRecords, file };
}

const G1 = 'g_20261001090000_thesis';
const G2 = 'g_20261001090000_campaa';
const T1 = 't_20261002090000_refs01';
const T2 = 't_20261002090000_draft1';
const T3 = 't_20261002090000_print1';
const P1 = 'p_20261001080000_notes1';

function snapshot(extra = {}) {
  return {
    format: 'warifuri-snapshot',
    version: 1,
    source: 'example-tracker',
    taken_at: '2026-10-24T08:00:00+09:00',
    places: [
      { id: P1, name: 'thesis notes', profile: 'research', paths: [{ device: 'laptop', path: path.posix.join('/', 'home', 'alex', 'notes') }] },
    ],
    goals: [
      { id: G1, title: 'Thesis draft', outcome: 'A full draft is with the advisor', due: '2026-12-01', mode: 'human_with_ai', profile: 'research', state: 'ready' },
      { id: G2, title: 'Tidy the archive', mode: 'ai_worker', state: 'done', result: 'Archived' },
    ],
    tasks: [
      { id: T1, title: 'Collect references', goal_id: G1, mode: 'ai_worker', place_id: P1, estimate_min: 30, state: 'running' },
      { id: T2, title: 'Write chapter 1', goal_id: G1, mode: 'human', done_when: 'Chapter 1 is in the draft', state: 'ready' },
      { id: T3, title: 'Print the draft', mode: 'ai_worker', state: 'waiting', waiting_on: 'printer', waiting_for: 'toner' },
    ],
    blocks: [{ before_id: T1, after_id: T2 }],
    ...extra,
  };
}

test('a clean snapshot imports with counts and no review', (t) => {
  const { L, count } = fresh(t);
  const res = L.replaceFromSnapshot(snapshot(), ACTOR);
  assert.deepEqual(res.counts, { places: 1, goals: 2, tasks: 3, blocks: 1 });
  assert.deepEqual(res.flagged, []);
  assert.deepEqual(res.skipped, []);
  assert.equal(count('place_paths'), 1);

  const g = L.get(G1);
  assert.equal(g.review, null);
  assert.equal(g.created_at, '2026-10-24T00:00:00.000Z');
  assert.equal(g.tasks.length, 2);
  assert.equal(L.get(G2).closed_at, '2026-10-24T00:00:00.000Z');
  assert.equal(L.get(G2).result, 'Archived');
  assert.deepEqual(L.get(T2).blocked_by, [T1]);
  assert.equal(L.get(T3).waiting_on, 'printer');
  assert.equal(L.placePath(P1, 'laptop'), '/home/alex/notes');
  assert.equal(L.get(T1).records.length, 0); // the import keeps one record, not one per row
});

test('a second import replaces the mirror; habits, autonomy and records stay', (t) => {
  const { L, count, importRecords } = fresh(t);
  L.replaceFromSnapshot(snapshot(), ACTOR);
  const kept = L.createHabit({ title: 'Read papers', rule: '毎週金 09:00-10:30', duration_min: 90, goal_id: G1 }, ACTOR);
  const lost = L.createHabit({ title: 'Sort files', rule: '毎月1日 10:00', duration_min: 30, goal_id: G2 }, ACTOR);
  L.setAutonomy('reschedule_block', { approvals_in_row: 2 }, { actor: 'secretary' });
  const recordsBefore = count('records');

  const second = snapshot();
  second.goals = second.goals.filter((g) => g.id === G1);
  second.tasks = [second.tasks[1]];
  second.blocks = [];
  second.places = [];
  const res = L.replaceFromSnapshot(second, ACTOR);
  assert.deepEqual(res.counts, { places: 0, goals: 1, tasks: 1, blocks: 0 });
  assert.equal(L.get(G2), null);
  assert.equal(L.get(T1), null);
  assert.equal(L.get(P1), null);
  assert.equal(count('blocks'), 0);
  assert.equal(count('place_paths'), 0);

  assert.equal(L.get(kept.id).goal_id, G1); // its goal came back with the same id
  assert.equal(L.get(lost.id).goal_id, null); // its goal is gone, so the link is
  assert.deepEqual(res.detached_habits, [lost.id]);
  assert.equal(L.getAutonomy('reschedule_block').approvals_in_row, 2);
  assert.equal(count('records'), recordsBefore + 1);
  assert.equal(importRecords().length, 2);
  assert.deepEqual(JSON.parse(importRecords()[1].changes).detached_habits, [lost.id]);
});

test('rule problems are stored with review, and listed as flagged', (t) => {
  const { L } = fresh(t);
  const doc = snapshot();
  doc.goals.push({ id: 'g_20261003090000_nodue1', title: 'Learn to sail', mode: 'human', state: 'ready' });
  doc.tasks.push({ id: 't_20261003090000_done01', title: 'Finished without a result', mode: 'ai_worker', state: 'done' });
  doc.tasks.push({ id: 't_20261003090000_stray1', title: 'Ready with a leftover reason', mode: 'ai_worker', state: 'ready', reason: 'old' });
  doc.tasks.push({ id: 't_20261003090000_human1', title: 'Call the venue', mode: 'human', state: 'ready', estimate_min: -5 });
  const res = L.replaceFromSnapshot(doc, ACTOR);
  assert.equal(res.counts.goals, 3);
  assert.equal(res.counts.tasks, 6);
  assert.deepEqual(res.flagged.map((f) => f.id).sort(), [
    'g_20261003090000_nodue1', 't_20261003090000_done01', 't_20261003090000_human1', 't_20261003090000_stray1',
  ]);

  const goal = L.get('g_20261003090000_nodue1');
  assert.ok(goal.review.some((p) => p.includes('原則2')));
  assert.ok(goal.review.some((p) => p.includes('outcome')));
  assert.ok(L.get('t_20261003090000_done01').review.some((p) => p.includes('result')));
  const stray = L.get('t_20261003090000_stray1');
  assert.equal(stray.reason, null); // a field of another state is left out
  assert.ok(stray.review.some((p) => p.includes('reason')));
  const human = L.get('t_20261003090000_human1');
  assert.equal(human.estimate_min, null);
  assert.ok(human.review.some((p) => p.includes('estimate_min')));
  assert.ok(human.review.some((p) => p.includes('done_when')));
  assert.equal(L.search('sail')[0].review.length, goal.review.length);
});

test('structural problems are skipped with reasons', (t) => {
  const { L } = fresh(t);
  const doc = snapshot();
  doc.goals.push({ title: 'No id', mode: 'ai_worker', state: 'ready' });
  doc.goals.push({ id: 'goal-7', title: 'Bad id', mode: 'ai_worker', state: 'ready' });
  doc.goals.push({ id: 'g_20261003090000_notitl', mode: 'ai_worker', state: 'ready' });
  doc.tasks.push({ id: 't_20261003090000_state1', title: 'Odd state', mode: 'ai_worker', state: 'paused' });
  doc.tasks.push({ id: 't_20261003090000_mode01', title: 'Odd mode', mode: 'robot', state: 'ready' });
  doc.tasks.push({ id: 't_20261003090000_date01', title: 'Odd date', mode: 'ai_worker', state: 'ready', due: 'next friday' });
  doc.tasks.push({ id: 't_20261003090000_deleg1', title: 'Odd delegated', mode: 'ai_worker', state: 'ready', delegated: 'yes' });
  doc.tasks.push({ id: 't_20261003090000_body01', title: 'Body not text', mode: 'ai_worker', state: 'ready', body: 42 });
  doc.tasks.push({ id: 't_20261003090000_twice1', title: 'Twice A', mode: 'ai_worker', state: 'ready' });
  doc.tasks.push({ id: 't_20261003090000_twice1', title: 'Twice B', mode: 'ai_worker', state: 'ready' });
  doc.places.push({ id: 'p_20261003090000_noname' });
  doc.places[0].paths.push({ device: 'laptop', path: 'elsewhere' });
  doc.blocks.push({ before_id: T1, after_id: 't_20261009090000_absent' });
  doc.blocks.push({ before_id: T3, after_id: T3 });
  doc.blocks.push({ before_id: T1, after_id: T2 });
  const res = L.replaceFromSnapshot(doc, ACTOR);
  assert.deepEqual(res.counts, { places: 1, goals: 2, tasks: 3, blocks: 1 });

  const reason = (id) => res.skipped.find((s) => s.id === id)?.problems.join(' ');
  assert.match(reason('goals[2]'), /id がありません/);
  assert.match(reason('goal-7'), /形ではありません/);
  assert.match(reason('g_20261003090000_notitl'), /題名/);
  assert.match(reason('t_20261003090000_state1'), /paused/);
  assert.match(reason('t_20261003090000_mode01'), /robot/);
  assert.match(reason('t_20261003090000_date01'), /日付として読めません/);
  assert.match(reason('t_20261003090000_deleg1'), /delegated/);
  assert.match(reason('t_20261003090000_body01'), /body は文字列/);
  assert.equal(res.skipped.filter((s) => s.id === 't_20261003090000_twice1').length, 2);
  assert.match(reason('p_20261003090000_noname'), /名前/);
  assert.match(reason(`${P1}:laptop`), /道が2つ/);
  assert.match(reason(`${T1}>t_20261009090000_absent`), /がありません/);
  assert.match(reason(`${T3}>${T3}`), /自分自身/);
  assert.match(reason(`${T1}>${T2}`), /2回/);
  assert.equal(L.get('t_20261003090000_twice1'), null);
  assert.equal(L.get('t_20261003090000_state1'), null);
});

test('a dangling goal_id or place_id keeps the task, with the link cut and a note', (t) => {
  const { L } = fresh(t);
  const doc = snapshot();
  doc.tasks.push({ id: 't_20261003090000_orphan', title: 'Orphan', mode: 'ai_worker', state: 'ready', goal_id: 'g_20260101000000_gone01', place_id: 'p_20260101000000_gone01' });
  doc.goals.push({ id: 'g_20261003090000_brokn1', title: 'Broken goal', mode: 'ai_worker', state: 'nope' });
  doc.tasks.push({ id: 't_20261003090000_child1', title: 'Child of a skipped goal', mode: 'ai_worker', state: 'ready', goal_id: 'g_20261003090000_brokn1' });
  const res = L.replaceFromSnapshot(doc, ACTOR);
  const orphan = L.get('t_20261003090000_orphan');
  assert.equal(orphan.goal_id, null);
  assert.equal(orphan.place_id, null);
  assert.ok(orphan.review.some((p) => p.includes('g_20260101000000_gone01') && p.includes('ゴールなし')));
  assert.ok(orphan.review.some((p) => p.includes('p_20260101000000_gone01') && p.includes('置き場なし')));
  assert.equal(L.get('t_20261003090000_child1').goal_id, null);
  assert.ok(res.flagged.some((f) => f.id === 't_20261003090000_child1'));
});

test('a block that would close a cycle is skipped; the earlier ones stay', (t) => {
  const { L } = fresh(t);
  const doc = snapshot();
  doc.blocks = [
    { before_id: T1, after_id: T2 },
    { before_id: T2, after_id: T3 },
    { before_id: T3, after_id: T1 },
  ];
  const res = L.replaceFromSnapshot(doc, ACTOR);
  assert.equal(res.counts.blocks, 2);
  assert.deepEqual(res.skipped.map((s) => [s.kind, s.id]), [['block', `${T3}>${T1}`]]);
  assert.match(res.skipped[0].problems[0], /輪/);
  assert.deepEqual(L.get(T1).blocked_by, []);
});

test('a bad envelope changes nothing and writes no record', (t) => {
  const { L, count } = fresh(t);
  L.replaceFromSnapshot(snapshot(), ACTOR);
  const recordsBefore = count('records');
  const bad = [
    null,
    [],
    snapshot({ format: 'other' }),
    snapshot({ version: 2 }),
    snapshot({ tasks: undefined }),
    snapshot({ blocks: {} }),
    snapshot({ taken_at: 'yesterday' }),
  ];
  for (const doc of bad) {
    assert.throws(() => L.replaceFromSnapshot(doc, ACTOR), LedgerError);
  }
  assert.throws(() => L.replaceFromSnapshot(snapshot(), { actor: '' }), LedgerError);
  assert.equal(count('goals'), 2);
  assert.equal(count('tasks'), 3);
  assert.equal(count('records'), recordsBefore);
});

test('each import appends exactly one record, named after the source', (t) => {
  const { L, count, importRecords } = fresh(t);
  const doc = snapshot();
  doc.tasks.push({ id: 'bad', title: 'x', mode: 'ai_worker', state: 'ready' });
  doc.tasks.push({ id: 't_20261003090000_done01', title: 'Done, no result', mode: 'ai_worker', state: 'done' });
  L.replaceFromSnapshot(doc, ACTOR);
  assert.equal(count('records'), 1);
  const [rec] = importRecords();
  assert.equal(rec.entity_id, 'example-tracker');
  assert.equal(rec.action, 'replace');
  assert.equal(rec.actor, 'import');
  assert.deepEqual(JSON.parse(rec.changes), {
    taken_at: '2026-10-24T08:00:00+09:00',
    counts: { places: 1, goals: 2, tasks: 4, blocks: 1 },
    flagged: 1,
    skipped: 1,
  });
  L.replaceFromSnapshot(snapshot({ source: undefined }), ACTOR);
  assert.equal(importRecords()[1].entity_id, 'snapshot');
  assert.equal(count('records'), 2);
});

test('a write that fixes a flagged row clears review; one that does not is refused', (t) => {
  const { L } = fresh(t);
  const doc = snapshot();
  doc.goals.push({ id: 'g_20261003090000_nodue1', title: 'Learn to sail', mode: 'human', state: 'ready' });
  doc.tasks.push({ id: 't_20261003090000_done01', title: 'Done, no result', mode: 'ai_worker', state: 'done' });
  L.replaceFromSnapshot(doc, ACTOR);

  // Rules apply to flagged rows as to any other: a write that leaves a problem is refused.
  assert.throws(() => L.update('g_20261003090000_nodue1', { title: 'Learn to sail well' }, ACTOR), LedgerError);
  assert.throws(() => L.update('g_20261003090000_nodue1', { due: '2027-06-01' }, ACTOR), /outcome/);
  assert.notEqual(L.get('g_20261003090000_nodue1').review, null);

  const fixed = L.update('g_20261003090000_nodue1', { due: '2027-06-01', outcome: 'I can sail alone' }, ACTOR);
  assert.equal(fixed.review, null);
  const rec = L.records('g_20261003090000_nodue1').at(-1);
  assert.equal(rec.changes.review.after, null);

  const done = L.setState('t_20261003090000_done01', 'done', { result: 'Shipped' }, ACTOR);
  assert.equal(done.review, null);
  assert.equal(L.get('t_20261003090000_done01').result, 'Shipped');
});

test('board({ review: true }) shows only flagged rows', (t) => {
  const { L } = fresh(t);
  const doc = snapshot();
  doc.tasks.push({ id: 't_20261003090000_human1', title: 'Call the venue', mode: 'human', state: 'ready', goal_id: G1 });
  doc.goals.push({ id: 'g_20261003090000_nodue1', title: 'Learn to sail', mode: 'human', state: 'ready' });
  doc.tasks.push({ id: 't_20261003090000_loose1', title: 'Loose and flagged', mode: 'human', state: 'ready' });
  L.replaceFromSnapshot(doc, ACTOR);

  const all = L.board();
  assert.equal(all.goals.length, 2);
  const flagged = L.board({ review: true });
  assert.deepEqual(flagged.goals.map((g) => g.id).sort(), [G1, 'g_20261003090000_nodue1'].sort());
  const thesis = flagged.goals.find((g) => g.id === G1);
  assert.equal(thesis.review, null); // shown for its flagged task
  assert.deepEqual(thesis.tasks.map((x) => x.id), ['t_20261003090000_human1']);
  assert.ok(Array.isArray(thesis.tasks[0].review));
  assert.deepEqual(flagged.unassigned.map((x) => x.id), ['t_20261003090000_loose1']);
});


test('cli: warifuri import end to end', () => {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'cli-'));
  const db = path.join(dir, 'ledger.sqlite');
  const snap = path.join(dir, 'snapshot.json');
  const doc = snapshot();
  doc.tasks.push({ id: 'oops', title: 'Bad id', mode: 'ai_worker', state: 'ready' });
  doc.tasks.push({ id: 't_20261003090000_done01', title: 'Done, no result', mode: 'ai_worker', state: 'done' });
  fs.writeFileSync(snap, JSON.stringify(doc));

  const ok = cli(['import', snap, '--db', db]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /1 places, 2 goals, 4 tasks, 1 blocks/);
  assert.match(ok.stdout, /flagged for review: 1/);
  assert.match(ok.stdout, /skipped: 1/);
  assert.match(ok.stdout, /task oops: .*形ではありません/);

  const L = openLedger(db);
  try {
    assert.equal(L.records('example-tracker')[0].actor, 'import');
  } finally {
    L.close();
  }
  const named = cli(['import', snap, '--db', db, '--actor', 'converter']);
  assert.equal(named.status, 0, named.stderr);
  const L2 = openLedger(db);
  try {
    assert.equal(L2.records('example-tracker')[1].actor, 'converter');
  } finally {
    L2.close();
  }

  const badEnvelope = path.join(dir, 'bad.json');
  fs.writeFileSync(badEnvelope, JSON.stringify({ format: 'warifuri-snapshot', version: 9 }));
  const bad = cli(['import', badEnvelope, '--db', db]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /version/);

  const notJson = path.join(dir, 'not.json');
  fs.writeFileSync(notJson, '{ not json');
  assert.equal(cli(['import', notJson, '--db', db]).status, 1);
  assert.equal(cli(['import', path.join(dir, 'missing.json'), '--db', db]).status, 1);

  assert.equal(cli([]).status, 2);
  assert.equal(cli(['export']).status, 2);
  // Without --db, the ledger is made in the data directory.
  const home = path.join(dir, 'home');
  assert.equal(cli(['import', snap], { home }).status, 0);
  assert.ok(fs.existsSync(path.join(home, 'ledger.sqlite')));
  // Windows has no POSIX modes: there the directory reports 0o666 whatever was asked.
  if (process.platform !== 'win32') assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  assert.equal(cli(['import', '--db', db]).status, 2);
  assert.equal(cli(['import', snap, '--db', db, '--colour']).status, 2);
});

test('profiles, device paths and the new task fields are imported', (t) => {
  const { L } = fresh(t);
  const doc = snapshot();
  Object.assign(doc.tasks[0], { body: 'Background and scope', load: 'light', next: 'Start with the 2024 review', delegated: true });
  doc.places[0].paths.push({ device: 'desk', path: 'D:\\notes' });
  doc.goals[0].secrecy = 'withhold'; // an old field is not read
  doc.goals[0].area = 'elsewhere';
  const res = L.replaceFromSnapshot(doc, ACTOR);
  assert.deepEqual(res.flagged, []);
  const task = L.get(T1);
  assert.equal(task.body, 'Background and scope');
  assert.equal(task.load, 'light');
  assert.equal(task.next, 'Start with the 2024 review');
  assert.equal(task.delegated, true);
  assert.equal(task.profile, 'research');
  assert.equal(L.get(T2).delegated, false);
  const goal = L.get(G1);
  assert.equal(goal.profile, 'research');
  assert.ok(!('secrecy' in goal) && !('area' in goal));
  assert.equal(L.get(P1).profile, 'research');
  assert.equal(L.placePath(P1, 'desk'), 'D:\\notes');
  assert.equal(L.placeFor('desk', 'd:\\notes\\2026').id, P1);
});

test('a bad load is left out with a note; a long body is kept with review', (t) => {
  const { L } = fresh(t);
  const doc = snapshot();
  doc.tasks.push({ id: 't_20261003090000_load01', title: 'Odd load', mode: 'ai_worker', state: 'ready', load: 'huge' });
  doc.tasks.push({ id: 't_20261003090000_long01', title: 'Long body', mode: 'ai_worker', state: 'ready', body: 'x'.repeat(2001) });
  const res = L.replaceFromSnapshot(doc, ACTOR);
  assert.deepEqual(res.flagged.map((f) => f.id).sort(), ['t_20261003090000_load01', 't_20261003090000_long01']);
  const odd = L.get('t_20261003090000_load01');
  assert.equal(odd.load, null);
  assert.ok(odd.review.some((p) => p.includes('huge')));
  const long = L.get('t_20261003090000_long01');
  assert.equal(long.body.length, 2001);
  assert.ok(long.review.some((p) => p.includes('2000字')));
  // The next write must fix it.
  assert.throws(() => L.update(long.id, { title: 'Still long' }, ACTOR), /2000字/);
  assert.equal(L.update(long.id, { body: 'See docs/plan.md' }, ACTOR).review, null);
});

test('原則1 on import: a goal with a human-time task is flagged when it lacks outcome or due', (t) => {
  const { L } = fresh(t);
  const doc = snapshot();
  doc.goals.push({ id: 'g_20261003090000_aigoal', title: 'AI goal', mode: 'ai_worker', state: 'ready' });
  doc.tasks.push({ id: 't_20261003090000_byhand', title: 'By hand', mode: 'human', done_when: 'Done', goal_id: 'g_20261003090000_aigoal', state: 'ready' });
  const res = L.replaceFromSnapshot(doc, ACTOR);
  assert.deepEqual(res.flagged.map((f) => f.id), ['g_20261003090000_aigoal']);
  const goal = L.get('g_20261003090000_aigoal');
  assert.ok(goal.review.some((p) => p.includes('原則1') && p.includes('人の時間を使うタスクを持つゴール')));
  // G2 is ai_worker with only an ai_worker task (none here): not flagged.
  assert.equal(L.get(G2).review, null);
  // The task cannot be written until its goal is fixed.
  assert.throws(() => L.update('t_20261003090000_byhand', { title: 'By hand, carefully' }, ACTOR), /原則1/);
  L.update(goal.id, { outcome: 'It is done', due: '2026-12-24' }, ACTOR);
  assert.equal(L.update('t_20261003090000_byhand', { title: 'By hand, carefully' }, ACTOR).title, 'By hand, carefully');
});

test('holds survive an import when their task comes back open', (t) => {
  const { L, importRecords } = fresh(t);
  L.replaceFromSnapshot(snapshot(), ACTOR);
  L.issueKey('laptop', ACTOR);
  L.start(T1, { device: 'laptop', placeId: P1 }, ACTOR);
  L.start(T2, { device: 'laptop' }, ACTOR);
  const res = L.replaceFromSnapshot(snapshot(), ACTOR);
  assert.deepEqual(res.dropped_holds, []);
  assert.equal(L.get(T1).hold.place_id, P1);

  const second = snapshot();
  second.tasks[1].state = 'done';
  second.tasks[1].result = 'Written';
  const again = L.replaceFromSnapshot(second, ACTOR);
  assert.deepEqual(again.dropped_holds, [T2]);
  assert.equal(L.get(T2).hold, null);
  assert.deepEqual(JSON.parse(importRecords().at(-1).changes).dropped_holds, [T2]);
  assert.equal(L.listDevices().length, 1); // devices stay
});

test('a closed row keeps its closed_at; a missing or unreadable one becomes the import time', (t) => {
  const { L } = fresh(t);
  const s = snapshot();
  s.goals[1].closed_at = '2026-08-01T12:00:00+09:00';
  s.tasks.push(
    { id: 't_20261002090000_old001', title: 'Old one', mode: 'ai_worker', state: 'done', result: 'Done', closed_at: 'last summer' },
  );
  s.tasks[2].closed_at = '2026-08-02T00:00:00Z';
  const res = L.replaceFromSnapshot(s, ACTOR);
  assert.equal(L.get(G2).closed_at, '2026-08-01T12:00:00+09:00');
  assert.equal(L.get('t_20261002090000_old001').closed_at, '2026-10-24T00:00:00.000Z');
  assert.equal(L.get(T3).closed_at, null);
  const notes = res.flagged.flatMap((f) => f.notes ?? f.problems ?? []).join('\n');
  assert.match(notes, /last summer/);
  assert.match(notes, /waiting の行の closed_at/);
});
