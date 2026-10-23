// Tests for the pure rule functions in src/ledger/rules.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidDue, isValidId, checkActor, applyState, checkStateExtra } from '../src/ledger/rules.mjs';

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
