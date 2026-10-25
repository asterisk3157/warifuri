// Tests for holds (着手) in the ledger: start, the one-task-per-place refusal, moving a hold,
// release with next, automatic release on closing or waiting, held(), and holds in board/get.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openLedger, LedgerError } from '../src/ledger/ledger.mjs';

const ACTOR = { actor: 'agent', device: 'laptop' };

function clock(start = '2026-10-24T00:00:00Z') {
  let t = Date.parse(start);
  return () => {
    const d = new Date(t);
    t += 1000;
    return d;
  };
}

// A ledger with two devices and two places.
function fresh(t) {
  const L = openLedger(':memory:', { now: clock() });
  t.after(() => L.close());
  L.issueKey('laptop', ACTOR);
  L.issueKey('desk', ACTOR);
  const repo = L.createPlace({ name: 'repo', paths: [{ device: 'laptop', path: '/home/alex/repo' }] }, ACTOR);
  const notes = L.createPlace({ name: 'notes', paths: [{ device: 'laptop', path: '/home/alex/notes' }] }, ACTOR);
  const task = (title) => L.createTask({ title, mode: 'ai_worker' }, ACTOR);
  return { L, repo, notes, task };
}

function refusal(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof LedgerError, String(err));
    return err;
  }
  assert.fail('expected a LedgerError');
}

test('start holds a task and makes a ready task running', (t) => {
  const { L, repo, task } = fresh(t);
  const a = task('A');
  const held = L.start(a.id, { device: 'laptop', placeId: repo.id }, ACTOR);
  assert.equal(held.state, 'running');
  assert.deepEqual(held.hold, { device: 'laptop', place_id: repo.id, place_name: 'repo', since: held.hold.since });
  assert.equal(L.held({ device: 'laptop', placeId: repo.id }).id, a.id);
  assert.equal(L.held({ device: 'desk', placeId: repo.id }), null);
  const rec = L.records(a.id).at(-1);
  assert.equal(rec.action, 'start');
  assert.equal(rec.device, 'laptop');
  assert.deepEqual(rec.changes.hold, { before: null, after: { device: 'laptop', place_id: repo.id } });
  assert.deepEqual(rec.changes.state, { before: 'ready', after: 'running' });

  // Starting it again in the same place changes nothing.
  const count = L.records(a.id).length;
  L.start(a.id, { device: 'laptop', placeId: repo.id }, ACTOR);
  assert.equal(L.records(a.id).length, count);
});

test('a device holds one task per place; another one there is refused with the held id', (t) => {
  const { L, repo, notes, task } = fresh(t);
  const a = task('A');
  const b = task('B');
  L.start(a.id, { device: 'laptop', placeId: repo.id }, ACTOR);
  const err = refusal(() => L.start(b.id, { device: 'laptop', placeId: repo.id }, ACTOR));
  assert.equal(err.heldTaskId, a.id);
  assert.ok(err.problems[0].includes(a.id));
  assert.equal(L.get(b.id).state, 'ready');
  assert.equal(L.get(b.id).hold, null);

  // Another place on the same device, or the same place on another device, is fine.
  assert.equal(L.start(b.id, { device: 'laptop', placeId: notes.id }, ACTOR).hold.place_id, notes.id);
  const c = task('C');
  assert.equal(L.start(c.id, { device: 'desk', placeId: repo.id }, ACTOR).hold.device, 'desk');
  // Outside any place counts as one place of its own.
  const d = task('D');
  const e = task('E');
  L.start(d.id, { device: 'laptop' }, ACTOR);
  assert.equal(refusal(() => L.start(e.id, { device: 'laptop', placeId: null }, ACTOR)).heldTaskId, d.id);
  assert.equal(L.held({ device: 'laptop' }).id, d.id);
});

test('a task held elsewhere moves, with a move record', (t) => {
  const { L, repo, task } = fresh(t);
  const a = task('A');
  L.start(a.id, { device: 'laptop', placeId: repo.id }, ACTOR);
  const moved = L.start(a.id, { device: 'desk', placeId: repo.id }, { actor: 'agent', device: 'desk' });
  assert.equal(moved.hold.device, 'desk');
  assert.equal(L.held({ device: 'laptop', placeId: repo.id }), null);
  const rec = L.records(a.id).at(-1);
  assert.equal(rec.action, 'move');
  assert.deepEqual(rec.changes.from, { device: 'laptop', place_id: repo.id });
  assert.deepEqual(rec.changes.to, { device: 'desk', place_id: repo.id });
  assert.equal(rec.changes.state, undefined); // already running
});

test('start refuses closed tasks, unknown or revoked devices and unknown places', (t) => {
  const { L, repo, task } = fresh(t);
  const a = task('A');
  L.setState(a.id, 'done', { result: 'ok' }, ACTOR);
  assert.match(refusal(() => L.start(a.id, { device: 'laptop', placeId: repo.id }, ACTOR)).message, /reopen/);
  const b = task('B');
  assert.match(refusal(() => L.start(b.id, { device: 'phone' }, ACTOR)).message, /phone がありません/);
  L.revokeKey('desk', ACTOR);
  assert.match(refusal(() => L.start(b.id, { device: 'desk' }, ACTOR)).message, /取り消されています/);
  assert.match(refusal(() => L.start(b.id, { device: 'laptop', placeId: 'p_20261024000000_nplace' }, ACTOR)).message, /作業フォルダ/);
  assert.match(refusal(() => L.start('t_20261024000000_nosuch', { device: 'laptop' }, ACTOR)).message, /ありません/);
  // A waiting task can be held; its state stays.
  const w = L.createTask({ title: 'W', mode: 'ai_worker', state: 'waiting', waiting_on: 'human', waiting_for: 'a choice' }, ACTOR);
  assert.equal(L.start(w.id, { device: 'laptop' }, ACTOR).state, 'waiting');
});

test('release drops the hold, writes next and puts a running task back to ready', (t) => {
  const { L, repo, task } = fresh(t);
  const a = task('A');
  L.start(a.id, { device: 'laptop', placeId: repo.id }, ACTOR);
  const released = L.release(a.id, { next: 'Rerun the failing test first' }, ACTOR);
  assert.equal(released.hold, null);
  assert.equal(released.state, 'ready');
  assert.equal(released.next, 'Rerun the failing test first');
  assert.equal(L.held({ device: 'laptop', placeId: repo.id }), null);
  const rec = L.records(a.id).at(-1);
  assert.equal(rec.action, 'release');
  assert.deepEqual(rec.changes.hold, { before: { device: 'laptop', place_id: repo.id }, after: null });
  assert.match(refusal(() => L.release(a.id, {}, ACTOR)).message, /作業中ではありません/);
  // The place is free for another task.
  const b = task('B');
  assert.equal(L.start(b.id, { device: 'laptop', placeId: repo.id }, ACTOR).hold.device, 'laptop');
});

test('done, discarded, waiting and deferred drop the hold and accept next', (t) => {
  const { L, repo, task } = fresh(t);
  const moves = [
    ['done', { result: 'Shipped' }],
    ['discarded', { reason: 'Not needed' }],
    ['waiting', { waiting_on: 'advisor', waiting_for: 'comments' }],
    ['deferred', { defer_until: '2026-11-10' }],
  ];
  for (const [state, extra] of moves) {
    const x = task(`to ${state}`);
    L.start(x.id, { device: 'laptop', placeId: repo.id }, ACTOR);
    const after = L.setState(x.id, state, { ...extra, next: `after ${state}` }, ACTOR);
    assert.equal(after.state, state);
    assert.equal(after.hold, null, state);
    assert.equal(after.next, `after ${state}`);
    assert.deepEqual(L.records(x.id).at(-1).changes.hold, { before: { device: 'laptop', place_id: repo.id }, after: null });
    assert.equal(L.held({ device: 'laptop', placeId: repo.id }), null);
  }
  // running keeps the hold, and next is only for letting go.
  const y = task('Y');
  L.start(y.id, { device: 'laptop', placeId: repo.id }, ACTOR);
  assert.match(refusal(() => L.setState(y.id, 'running', { next: 'x' }, ACTOR)).message, /next/);
  const g = L.createGoal({ title: 'G', mode: 'ai_worker' }, ACTOR);
  assert.match(refusal(() => L.setState(g.id, 'done', { result: 'ok', next: 'x' }, ACTOR)).message, /タスクにだけ/);
  assert.equal(L.get(y.id).hold.device, 'laptop');
});

test('board and get show the hold', (t) => {
  const { L, repo } = fresh(t);
  const g = L.createGoal({ title: 'G', mode: 'ai_worker' }, ACTOR);
  const a = L.createTask({ title: 'A', mode: 'ai_worker', goal_id: g.id }, ACTOR);
  const loose = L.createTask({ title: 'Loose', mode: 'ai_worker' }, ACTOR);
  L.start(a.id, { device: 'laptop', placeId: repo.id }, ACTOR);
  const board = L.board();
  assert.equal(board.goals[0].tasks[0].hold.device, 'laptop');
  assert.equal(board.goals[0].tasks[0].hold.place_name, 'repo');
  assert.equal(board.unassigned.find((x) => x.id === loose.id).hold, null);
  assert.equal(L.get(a.id).hold.place_id, repo.id);
  assert.equal(L.get(g.id).tasks[0].hold.device, 'laptop');
});
