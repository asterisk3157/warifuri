// Tests for the pure rule functions in src/ledger/rules.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidDue,
  isValidId,
  checkActor,
  applyState,
  checkStateExtra,
  checkGoal,
  checkGoalTakesHumanTask,
  checkTask,
  charLength,
} from '../src/ledger/rules.mjs';

test('due accepts a date or an ISO datetime with an offset', () => {
  for (const ok of ['2026-11-01', '2024-02-29', '2026-11-01T09:00:00+09:00', '2026-11-01T00:00Z', '2026-11-01T09:00:00.123-05:30']) {
    assert.equal(isValidDue(ok), true, ok);
  }
  for (const bad of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-11-01T09:00:00', 'tomorrow', '2026/11/01', '', 20261101, null]) {
    assert.equal(isValidDue(bad), false, String(bad));
  }
});

test('ids: any one-letter prefix, 14 digits, 6 lowercase alnum', () => {
  assert.equal(isValidId('q_20261023170500_ab23so'), true);
  assert.equal(isValidId('g_20261023170500_000000'), true);
  assert.equal(isValidId('Q_20261023170500_ab23so'), false);
  assert.equal(isValidId('gg_20261023170500_ab23so'), false);
  assert.equal(isValidId('q_2026102317050_ab23so'), false);
  assert.equal(isValidId('q_20261023170500_AB23SO'), false);
});

test('actor must be a non-empty string', () => {
  assert.deepEqual(checkActor('human'), []);
  assert.equal(checkActor('').length, 1);
  assert.equal(checkActor('  ').length, 1);
  assert.equal(checkActor(undefined).length, 1);
});

test('applyState clears the fields of the state being left', () => {
  const row = { state: 'discarded', reason: 'no longer needed', closed_at: 'x', result: null };
  const next = applyState(row, 'ready', {}, 'now');
  assert.equal(next.state, 'ready');
  assert.equal(next.reason, null);
  assert.equal(next.closed_at, null);
  const done = applyState(next, 'done', { result: 'shipped' }, 'now');
  assert.equal(done.closed_at, 'now');
  assert.equal(done.result, 'shipped');
});

test('setState extras must belong to the target state', () => {
  assert.deepEqual(checkStateExtra('done', { result: 'x' }), []);
  assert.equal(checkStateExtra('ready', { result: 'x' }).length, 1);
});

const goal = (extra = {}) => ({ id: 'g1', title: 'G', state: 'ready', mode: 'ai_worker', due_provisional: 0, human_led: 0, ...extra });
const task = (extra = {}) => ({ title: 'T', state: 'ready', mode: 'ai_worker', due_provisional: 0, delegated: 0, ...extra });

test('原則1: a goal with a human-time task needs outcome and a set due date', () => {
  assert.deepEqual(checkGoal(goal()), []);
  const p = checkGoal(goal(), { hasHumanTimeTask: true });
  assert.equal(p.length, 2);
  assert.ok(p.every((s) => s.includes('原則1')));
  assert.equal(checkGoal(goal({ outcome: 'x', due: '2026-12-01', due_provisional: 1 }), { hasHumanTimeTask: true }).length, 1);
  assert.deepEqual(checkGoal(goal({ outcome: 'x', due: '2026-12-01' }), { hasHumanTimeTask: true }), []);

  assert.deepEqual(checkGoalTakesHumanTask(task(), goal()), []);
  assert.deepEqual(checkGoalTakesHumanTask(task({ mode: 'human' }), null), []);
  assert.deepEqual(checkGoalTakesHumanTask(task({ mode: 'human' }), goal({ outcome: 'x', due: '2026-12-01' })), []);
  const refused = checkGoalTakesHumanTask(task({ mode: 'human_with_ai' }), goal());
  assert.equal(refused.length, 2);
  assert.ok(refused.every((s) => s.startsWith('ゴール g1: ') && s.includes('原則1')));
  // A goal that is itself human-time is checked by checkGoal, not here.
  assert.deepEqual(checkGoalTakesHumanTask(task({ mode: 'human' }), goal({ mode: 'human' })), []);
});

test('task fields: body length in characters, load enum, delegated flag', () => {
  assert.equal(charLength('😀あa'), 3);
  assert.deepEqual(checkTask(task({ body: '😀'.repeat(2000) })), []);
  assert.equal(checkTask(task({ body: 'a'.repeat(2001) })).length, 1);
  for (const load of ['heavy', 'normal', 'light', null, undefined]) assert.deepEqual(checkTask(task({ load })), [], String(load));
  assert.equal(checkTask(task({ load: 'medium' })).length, 1);
  assert.equal(checkTask(task({ delegated: 2 })).length, 1);
  assert.equal(checkTask(task({ next: 5 })).length, 1);
});
