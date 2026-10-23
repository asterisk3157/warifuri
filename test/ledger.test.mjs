// Tests for the ledger (src/ledger/ledger.mjs): its rules on create and update, records,
// order between tasks, the board, search, places, autonomy and persistence in a file.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openLedger, LedgerError } from '../src/ledger/ledger.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warifuri-test-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const ACTOR = { actor: 'human' };
const AGENT = { actor: 'agent:laptop' };
let fileCounter = 0;

// A clock that starts at a fixed instant and moves one second per call.
function clock(start = '2026-10-24T00:00:00Z') {
  let t = Date.parse(start);
  return () => {
    const d = new Date(t);
    t += 1000;
    return d;
  };
}

// A ledger in its own file, plus a second connection to count rows directly.
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
  return { L, count, file };
}

// Asserts that fn throws a LedgerError whose problems include each of `fragments`.
function refuses(fn, ...fragments) {
  let err;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof LedgerError, `expected a LedgerError, got ${err}`);
  for (const f of fragments) {
    assert.ok(err.problems.some((p) => p.includes(f)), `no problem mentions "${f}": ${err.problems.join(' | ')}`);
  }
  return err;
}

const humanGoal = (extra = {}) => ({ title: 'Write the thesis draft', outcome: 'A full draft is with the advisor', mode: 'human_with_ai', due: '2026-12-01', ...extra });
const aiTask = (extra = {}) => ({ title: 'Collect references', mode: 'ai_worker', ...extra });

test('rule 1: a human-time goal needs a due date; an ai_worker goal does not', (t) => {
  const { L, count } = fresh(t);
  refuses(() => L.createGoal({ title: 'No date', mode: 'human' }, ACTOR), '期日が要ります(原則2)');
  refuses(() => L.createGoal({ title: 'No date', mode: 'human_with_ai' }, ACTOR), '原則2');
  assert.equal(count('goals'), 0);
  assert.equal(count('records'), 0);

  const g = L.createGoal(humanGoal(), ACTOR);
  assert.equal(g.state, 'ready');
  const ai = L.createGoal({ title: 'Tidy notes', mode: 'ai_worker' }, ACTOR);
  assert.equal(ai.due, null);

  // On update: the merged row is checked.
  refuses(() => L.update(g.id, { due: null }, ACTOR), '原則2');
  refuses(() => L.update(ai.id, { mode: 'human' }, ACTOR), '原則2');
  const moved = L.update(ai.id, { mode: 'human', due: '2026-11-15', outcome: 'Notes are in one place' }, ACTOR);
  assert.equal(moved.mode, 'human');
  assert.equal(count('goals'), 2);
  assert.equal(count('records'), 3);
});

test('rule 1: a human-time goal needs an outcome, and a provisional date does not count as its due date', (t) => {
  const { L, count } = fresh(t);
  refuses(() => L.createGoal(humanGoal({ outcome: '' }), ACTOR), 'あるべき姿(outcome)が要ります(原則1)');
  refuses(() => L.createGoal(humanGoal({ due_provisional: true }), ACTOR), '仮の期日では足りません');
  assert.equal(count('goals'), 0);

  const g = L.createGoal(humanGoal(), ACTOR);
  refuses(() => L.update(g.id, { due_provisional: true }, ACTOR), '仮の期日');
  // An ai_worker goal may carry a provisional date, flagged as such.
  const ai = L.createGoal({ title: 'Tidy notes', mode: 'ai_worker', due: '2026-11-01', due_provisional: true }, ACTOR);
  assert.equal(ai.due_provisional, true);
  assert.equal(L.update(ai.id, { due_provisional: false }, ACTOR).due_provisional, false);
});

test('rule 2: a human-time task needs done_when; an ai_worker task does not', (t) => {
  const { L, count } = fresh(t);
  refuses(() => L.createTask({ title: 'Meet advisor', mode: 'human' }, ACTOR), '完了の条件(done_when)が要ります(原則5)');
  refuses(() => L.createTask({ title: 'Pair on draft', mode: 'human_with_ai', done_when: '  ' }, ACTOR), 'done_when');
  assert.equal(count('tasks'), 0);
  assert.equal(count('records'), 0);

  const task = L.createTask(aiTask(), ACTOR);
  refuses(() => L.update(task.id, { mode: 'human_with_ai' }, ACTOR), 'done_when');
  const ok = L.update(task.id, { mode: 'human_with_ai', done_when: 'The list has 20 papers' }, ACTOR);
  assert.equal(ok.done_when, 'The list has 20 papers');
});

test('rule 3: waiting needs waiting_on and waiting_for', (t) => {
  const { L } = fresh(t);
  const task = L.createTask(aiTask(), ACTOR);
  const g = L.createGoal(humanGoal(), ACTOR);
  refuses(() => L.setState(task.id, 'waiting', {}, AGENT), 'waiting_on', 'waiting_for');
  refuses(() => L.setState(task.id, 'waiting', { waiting_on: 'human' }, AGENT), 'waiting_for');
  refuses(() => L.setState(g.id, 'waiting', { waiting_for: 'a decision' }, AGENT), 'waiting_on');
  assert.equal(L.get(task.id).state, 'ready');
  assert.equal(L.records(task.id).length, 1);

  const w = L.setState(task.id, 'waiting', { waiting_on: 'human', waiting_for: 'Pick a journal' }, AGENT);
  assert.equal(w.state, 'waiting');
  assert.equal(w.waiting_for, 'Pick a journal');
  const back = L.setState(task.id, 'running', {}, AGENT);
  assert.equal(back.waiting_on, null);
  assert.equal(back.waiting_for, null);
});

test('rule 4: done needs result, discarded needs reason, deferred needs defer_until', (t) => {
  const { L } = fresh(t);
  const task = L.createTask(aiTask(), ACTOR);
  refuses(() => L.setState(task.id, 'done', {}, AGENT), '成果(result)');
  refuses(() => L.setState(task.id, 'discarded', {}, AGENT), '理由(reason)');
  refuses(() => L.setState(task.id, 'deferred', {}, AGENT), 'defer_until');
  refuses(() => L.setState(task.id, 'deferred', { defer_until: 'next week' }, AGENT), 'defer_until');
  refuses(() => L.setState(task.id, 'ready', { result: 'x' }, AGENT), 'result は状態 ready では使いません');
  refuses(() => L.setState(task.id, 'finished', {}, AGENT), '状態は');
  assert.equal(L.records(task.id).length, 1);

  const d = L.setState(task.id, 'deferred', { defer_until: '2026-11-10' }, AGENT);
  assert.equal(d.defer_until, '2026-11-10');
  const done = L.setState(task.id, 'done', { result: '23 papers listed' }, AGENT);
  assert.equal(done.result, '23 papers listed');
  assert.equal(done.defer_until, null);
  assert.ok(done.closed_at);
  const other = L.createTask(aiTask({ title: 'Other' }), ACTOR);
  assert.equal(L.setState(other.id, 'discarded', { reason: 'Covered elsewhere' }, AGENT).reason, 'Covered elsewhere');
});

test('rule 5: reopening clears the fields of the closed state', (t) => {
  const { L } = fresh(t);
  const task = L.createTask(aiTask(), ACTOR);
  L.setState(task.id, 'discarded', { reason: 'Not needed' }, AGENT);
  const reopened = L.setState(task.id, 'ready', {}, ACTOR);
  assert.equal(reopened.state, 'ready');
  assert.equal(reopened.reason, null);
  assert.equal(reopened.closed_at, null);

  L.setState(task.id, 'done', { result: 'Done once' }, AGENT);
  const again = L.setState(task.id, 'ready', {}, ACTOR);
  assert.equal(again.result, null);
  assert.equal(again.closed_at, null);

  const last = L.records(task.id).at(-1);
  assert.equal(last.action, 'state');
  assert.deepEqual(last.changes.result, { before: 'Done once', after: null });
  assert.deepEqual(last.changes.state, { before: 'done', after: 'ready' });
});

test('rules apply on create too: a task may be created closed only with its field', (t) => {
  const { L, count } = fresh(t);
  refuses(() => L.createTask(aiTask({ state: 'done' }), ACTOR), 'result');
  refuses(() => L.createTask(aiTask({ reason: 'stray' }), ACTOR), 'reason は状態 ready では使いません');
  assert.equal(count('tasks'), 0);
  const done = L.createTask(aiTask({ state: 'done', result: 'Imported as done' }), ACTOR);
  assert.equal(done.state, 'done');
  assert.ok(done.closed_at);
});

test('rule 6: goal_id must name an existing goal', (t) => {
  const { L, count } = fresh(t);
  refuses(() => L.createTask(aiTask({ goal_id: 'g_20261024000000_nogoal' }), ACTOR), 'ゴール g_20261024000000_nogoal がありません');
  assert.equal(count('tasks'), 0);
  const g = L.createGoal(humanGoal(), ACTOR);
  const task = L.createTask(aiTask({ goal_id: g.id }), ACTOR);
  assert.equal(task.goal_id, g.id);
  refuses(() => L.update(task.id, { goal_id: 'g_20261024000000_zzzzzz' }, ACTOR), 'がありません');
  assert.equal(L.update(task.id, { goal_id: null }, ACTOR).goal_id, null);
  refuses(() => L.createTask(aiTask({ place_id: 'p_20261024000000_nplace' }), ACTOR), '置き場');
});

test('rule 7: blocks need two existing tasks, no self edge, no cycle', (t) => {
  const { L, count } = fresh(t);
  const a = L.createTask(aiTask({ title: 'A' }), ACTOR);
  const b = L.createTask(aiTask({ title: 'B' }), ACTOR);
  const c = L.createTask(aiTask({ title: 'C' }), ACTOR);
  const g = L.createGoal(humanGoal(), ACTOR);
  const before = count('records');

  refuses(() => L.link(a.id, a.id, ACTOR), '自分自身');
  refuses(() => L.link(a.id, 't_20261024000000_nosuch', ACTOR), 'あとにやるタスク');
  refuses(() => L.link(g.id, a.id, ACTOR), '先にやるタスク');
  assert.equal(count('blocks'), 0);
  assert.equal(count('records'), before);

  L.link(a.id, b.id, ACTOR);
  L.link(b.id, c.id, ACTOR);
  refuses(() => L.link(c.id, a.id, ACTOR), '輪になります');
  refuses(() => L.link(b.id, a.id, ACTOR), '輪になります');
  assert.equal(count('blocks'), 2);

  const bView = L.get(b.id);
  assert.deepEqual(bView.blocked_by, [a.id]);
  assert.deepEqual(bView.blocks, [c.id]);

  L.unlink(b.id, c.id, ACTOR);
  refuses(() => L.unlink(b.id, c.id, ACTOR), '順序はありません');
  L.link(c.id, a.id, ACTOR); // no longer a cycle
  assert.equal(count('blocks'), 2);
  const linkRecords = L.records(`${a.id}>${b.id}`);
  assert.equal(linkRecords[0].action, 'link');
  assert.equal(linkRecords[0].entity, 'block');
});

test('rule 8: due must be a date or an ISO datetime with an offset', (t) => {
  const { L, count } = fresh(t);
  refuses(() => L.createGoal(humanGoal({ due: '2026-02-30' }), ACTOR), '期日は YYYY-MM-DD');
  refuses(() => L.createGoal(humanGoal({ due: '2026-12-01T09:00:00' }), ACTOR), '期日は');
  refuses(() => L.createTask(aiTask({ due: 'Friday' }), ACTOR), '期日は');
  assert.equal(count('goals') + count('tasks'), 0);
  assert.equal(L.createGoal(humanGoal({ due: '2026-12-01T09:00:00+09:00' }), ACTOR).due, '2026-12-01T09:00:00+09:00');
  assert.equal(L.createTask(aiTask({ due: '2026-11-03' }), ACTOR).due, '2026-11-03');
});

test('every problem is reported at once, and nothing is written', (t) => {
  const { L, count } = fresh(t);
  const err = refuses(
    () => L.createTask({ title: '', mode: 'human', due: 'soon', goal_id: 'g_20261024000000_nogoal' }, ACTOR),
    '題名',
    'done_when',
    '期日は',
    'がありません',
  );
  assert.ok(err.problems.length >= 4);
  assert.equal(count('tasks'), 0);
  assert.equal(count('records'), 0);
});

test('actor is required on every write', (t) => {
  const { L, count } = fresh(t);
  refuses(() => L.createGoal(humanGoal(), { actor: '' }), 'actor');
  refuses(() => L.createTask(aiTask(), {}), 'actor');
  refuses(() => L.createTask(aiTask()), 'actor');
  const task = L.createTask(aiTask(), ACTOR);
  refuses(() => L.setState(task.id, 'running', {}, { actor: ' ' }), 'actor');
  refuses(() => L.update(task.id, { title: 'x' }, {}), 'actor');
  refuses(() => L.setAutonomy('reschedule_block', { level: 'act_then_tell' }, {}), 'actor');
  assert.equal(count('records'), 1);
});

test('update refuses fields it does not own', (t) => {
  const { L } = fresh(t);
  const task = L.createTask(aiTask(), ACTOR);
  const g = L.createGoal(humanGoal(), ACTOR);
  refuses(() => L.update(task.id, { state: 'done' }, ACTOR), 'state はここでは書けません');
  refuses(() => L.update(task.id, { outcome: 'x' }, ACTOR), 'outcome');
  refuses(() => L.update(g.id, { done_when: 'x' }, ACTOR), 'done_when');
  refuses(() => L.update('t_20261024000000_nosuch', { title: 'x' }, ACTOR), 'ありません');
});

test('records keep actor, action and before/after for each write', (t) => {
  const { L } = fresh(t);
  const g = L.createGoal(humanGoal({ area: 'research', outcome: 'A full draft is with the advisor' }), ACTOR);
  L.update(g.id, { title: 'Write the full draft' }, AGENT);
  L.update(g.id, { title: 'Write the full draft' }, AGENT); // no change, no record
  const recs = L.records(g.id);
  assert.equal(recs.length, 2);
  assert.equal(recs[0].actor, 'human');
  assert.equal(recs[0].entity, 'goal');
  assert.equal(recs[0].action, 'create');
  assert.deepEqual(recs[0].changes.title, { before: null, after: 'Write the thesis draft' });
  assert.equal(recs[0].at, '2026-10-24T00:00:02.000Z');
  assert.equal(recs[1].actor, 'agent:laptop');
  assert.equal(recs[1].action, 'update');
  assert.deepEqual(recs[1].changes, { title: { before: 'Write the thesis draft', after: 'Write the full draft' } });
  assert.deepEqual(L.get(g.id).records, recs);
});

test('records are append-only', (t) => {
  const { L, file } = fresh(t);
  L.createGoal(humanGoal(), ACTOR);
  const raw = new DatabaseSync(file);
  t.after(() => raw.close());
  assert.throws(() => raw.exec("UPDATE records SET actor = 'someone'"), /append-only/);
  assert.throws(() => raw.exec('DELETE FROM records'), /append-only/);
});

test('ids: generated from the clock, or supplied by the caller', (t) => {
  const { L } = fresh(t);
  const g = L.createGoal(humanGoal(), ACTOR);
  assert.match(g.id, /^g_20261024000000_[a-z0-9]{6}$/);
  assert.match(L.createTask(aiTask(), ACTOR).id, /^t_\d{14}_[a-z0-9]{6}$/);

  const imported = L.createTask(aiTask({ id: 'q_20261023170500_ab23so' }), ACTOR);
  assert.equal(imported.id, 'q_20261023170500_ab23so');
  assert.equal(L.get('q_20261023170500_ab23so').kind, 'task');
  assert.equal(L.update('q_20261023170500_ab23so', { title: 'Renamed' }, ACTOR).title, 'Renamed');
  const importedGoal = L.createGoal(humanGoal({ id: 'q_20261023170501_goal01' }), ACTOR);
  assert.equal(L.get(importedGoal.id).kind, 'goal');

  refuses(() => L.createTask(aiTask({ id: 'q_20261023170500_ab23so' }), ACTOR), 'もう使われています');
  refuses(() => L.createTask(aiTask({ id: 'task-1' }), ACTOR), '形ではありません');
});

test('board: open goals with their tasks, then tasks with no goal, with filters', (t) => {
  const { L } = fresh(t);
  const research = L.createGoal(humanGoal({ area: 'research', due: '2026-12-01' }), ACTOR);
  const club = L.createGoal({ title: 'Plan the club camp', outcome: 'The camp is booked', mode: 'human', due: '2026-11-20', area: 'club' }, ACTOR);
  const closed = L.createGoal({ title: 'Old goal', mode: 'ai_worker', area: 'research' }, ACTOR);
  L.setState(closed.id, 'done', { result: 'Finished' }, ACTOR);

  const r1 = L.createTask(aiTask({ goal_id: research.id }), ACTOR);
  const r2 = L.createTask({ title: 'Read with AI', mode: 'human_with_ai', done_when: 'Notes written', goal_id: research.id }, ACTOR);
  const r3 = L.createTask(aiTask({ title: 'Finished task', goal_id: research.id }), ACTOR);
  L.setState(r3.id, 'done', { result: 'ok' }, ACTOR);
  const c1 = L.createTask({ title: 'Book the bus', mode: 'human', done_when: 'Bus booked', goal_id: club.id }, ACTOR);
  const home = L.createPlace({ name: 'notes', area: 'research' }, ACTOR);
  const loose1 = L.createTask(aiTask({ title: 'Loose in research', place_id: home.id }), ACTOR);
  const loose2 = L.createTask(aiTask({ title: 'Loose anywhere' }), ACTOR);

  const all = L.board();
  assert.deepEqual(all.goals.map((g) => g.id), [club.id, research.id]); // earlier due first
  assert.deepEqual(all.goals[1].tasks.map((x) => x.id), [r1.id, r2.id]);
  assert.deepEqual(all.goals[0].tasks.map((x) => x.id), [c1.id]);
  assert.deepEqual(all.unassigned.map((x) => x.id), [loose1.id, loose2.id]);

  const withClosed = L.board({ includeClosed: true });
  assert.equal(withClosed.goals.length, 3);
  assert.equal(withClosed.goals.find((g) => g.id === research.id).tasks.length, 3);

  const byArea = L.board({ area: 'research' });
  assert.deepEqual(byArea.goals.map((g) => g.id), [research.id]);
  assert.deepEqual(byArea.unassigned.map((x) => x.id), [loose1.id]);

  const humanOnly = L.board({ mode: 'human' });
  assert.deepEqual(humanOnly.goals.map((g) => g.id), [club.id]);
  assert.deepEqual(humanOnly.goals[0].tasks.map((x) => x.id), [c1.id]);
  assert.deepEqual(humanOnly.unassigned, []);

  const pairing = L.board({ mode: 'human_with_ai' });
  assert.deepEqual(pairing.goals.map((g) => g.id), [research.id]); // the goal matches itself
  assert.deepEqual(pairing.goals[0].tasks.map((x) => x.id), [r2.id]);

  L.setState(r1.id, 'running', {}, AGENT);
  const running = L.board({ state: 'running' });
  assert.deepEqual(running.goals.map((g) => g.id), [research.id]); // via its running task
  assert.deepEqual(running.goals[0].tasks.map((x) => x.id), [r1.id]);
});

test('search: title contains the text, case ignored, goals and tasks, limited', (t) => {
  const { L } = fresh(t);
  L.createGoal(humanGoal({ title: 'Thesis draft' }), ACTOR);
  L.createTask(aiTask({ title: 'Outline the THESIS' }), ACTOR);
  L.createTask(aiTask({ title: 'Buy coffee' }), ACTOR);
  L.createTask(aiTask({ title: '論文の図を作る' }), ACTOR);
  const hits = L.search('thesis');
  assert.deepEqual(hits.map((h) => h.kind).sort(), ['goal', 'task']);
  assert.equal(L.search('thesis', { limit: 1 }).length, 1);
  assert.equal(L.search('論文')[0].title, '論文の図を作る');
  assert.equal(L.search('100%').length, 0); // % is literal
  assert.equal(L.search('nothing like this').length, 0);
});

test('places: one path per machine', (t) => {
  const { L, count } = fresh(t);
  const p = L.createPlace(
    {
      name: 'thesis',
      area: 'research',
      secrecy: 'withhold',
      paths: [
        { machine: 'laptop', path: path.posix.join('/', 'home', 'alex', 'thesis') },
        { machine: 'desktop', path: path.win32.join('D:\\', 'work', 'thesis') },
      ],
    },
    ACTOR,
  );
  assert.match(p.id, /^p_/);
  assert.equal(L.placePath(p.id, 'laptop'), '/home/alex/thesis');
  assert.equal(L.placePath(p.id, 'desktop'), 'D:\\work\\thesis');
  assert.equal(L.placePath(p.id, 'phone'), null);
  assert.deepEqual(L.get(p.id).paths.map((x) => x.machine), ['desktop', 'laptop']);
  assert.equal(L.records(p.id)[0].changes.paths.after.length, 2);

  refuses(
    () => L.createPlace({ name: 'dup', paths: [{ machine: 'laptop', path: 'a' }, { machine: 'laptop', path: 'b' }] }, ACTOR),
    '道が2つあります',
  );
  refuses(() => L.createPlace({ name: 'half', paths: [{ machine: 'laptop' }] }, ACTOR), '両方');
  refuses(() => L.createPlace({ name: 'x', secrecy: 'secret' }, ACTOR), '秘密度');
  assert.equal(count('places'), 1);
  assert.equal(count('place_paths'), 2);

  const task = L.createTask(aiTask({ place_id: p.id }), ACTOR);
  assert.equal(task.place_id, p.id);
  assert.equal(task.secrecy, null); // inherits later
});

test('habits: create and update with checks', (t) => {
  const { L } = fresh(t);
  const g = L.createGoal({ title: 'Keep training', outcome: 'Training is logged every week', mode: 'human', due: '2027-03-31' }, ACTOR);
  refuses(() => L.createHabit({ title: 'Run', rule: '', duration_min: 0 }, ACTOR), 'rule', 'duration_min');
  refuses(() => L.createHabit({ title: 'Run', rule: 'Mon 07:00', duration_min: 30, goal_id: 'g_20261024000000_nogoal' }, ACTOR), 'がありません');
  const h = L.createHabit({ title: 'Run', rule: '毎週月水金 07:00-07:30', duration_min: 30, goal_id: g.id }, ACTOR);
  assert.match(h.id, /^h_/);
  assert.equal(h.active, true);
  const off = L.updateHabit(h.id, { active: false }, ACTOR);
  assert.equal(off.active, false);
  refuses(() => L.updateHabit(h.id, { duration_min: -5 }, ACTOR), 'duration_min');
  assert.equal(L.records(h.id).length, 2);
  assert.deepEqual(L.records(h.id)[1].changes.active, { before: 1, after: 0 });
});

test('autonomy: stored per kind, starting at ask', (t) => {
  const { L } = fresh(t);
  assert.equal(L.getAutonomy('reschedule_block'), null);
  const a = L.setAutonomy('reschedule_block', { approvals_in_row: 1 }, { actor: 'secretary' });
  assert.equal(a.level, 'ask');
  assert.equal(a.approvals_in_row, 1);
  const up = L.setAutonomy('reschedule_block', { level: 'act_then_tell', approvals_in_row: 3 }, { actor: 'secretary' });
  assert.equal(up.level, 'act_then_tell');
  refuses(() => L.setAutonomy('reschedule_block', { level: 'always' }, ACTOR), '自律の段');
  refuses(() => L.setAutonomy('reschedule_block', { revokes: -1 }, ACTOR), 'revokes');
  const recs = L.records('reschedule_block');
  assert.deepEqual(recs.map((r) => r.action), ['create', 'update']);
  assert.deepEqual(recs[1].changes.level, { before: 'ask', after: 'act_then_tell' });
});

test('persistence: a file ledger keeps everything across reopen', (t) => {
  const file = path.join(tmpRoot, 'persist.db');
  const first = openLedger(file, { now: clock() });
  const g = first.createGoal(humanGoal(), ACTOR);
  const task = first.createTask(aiTask({ goal_id: g.id }), ACTOR);
  first.setState(task.id, 'done', { result: 'Saved' }, AGENT);
  first.close();

  const second = openLedger(file, { now: clock('2026-10-25T00:00:00Z') });
  t.after(() => second.close());
  const again = second.get(task.id);
  assert.equal(again.state, 'done');
  assert.equal(again.result, 'Saved');
  assert.equal(again.records.length, 2);
  assert.equal(second.get(g.id).tasks.length, 1);
  assert.equal(second.createTask(aiTask(), ACTOR).id.slice(0, 10), 't_20261025');
});

test('memory ledger works', (t) => {
  const L = openLedger(':memory:');
  t.after(() => L.close());
  const g = L.createGoal({ title: 'In memory', mode: 'ai_worker' }, ACTOR);
  assert.equal(L.get(g.id).title, 'In memory');
});

test('schema: version 1 is recorded, and a newer file is refused', (t) => {
  const { file, L } = fresh(t);
  const raw = new DatabaseSync(file);
  t.after(() => raw.close());
  assert.equal(raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '1');
  L.close();
  const reopened = openLedger(file); // same version: fine
  reopened.close();
  raw.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
  assert.throws(() => openLedger(file), /newer than this warifuri/);
});
