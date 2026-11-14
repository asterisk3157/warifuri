// The タスク screen's helper that cuts a long あるべき姿 to its first sentence.

import test from 'node:test';
import assert from 'node:assert/strict';
import { lead, progress, orderGoals, splitChart } from '../src/web/pages/tasks.js';

test('lead: the first sentence, up to a line break, at most 80 characters, and the rest', () => {
  assert.deepEqual(lead('予稿を出している。経緯: 打ち合わせで決めた。'), { head: '予稿を出している。', rest: '経緯: 打ち合わせで決めた。' });
  assert.deepEqual(lead('一行目\n\n二行目。'), { head: '一行目', rest: '二行目。' });
  assert.deepEqual(lead('短い'), { head: '短い', rest: '' });
  const long = 'あ'.repeat(100);
  assert.deepEqual(lead(long), { head: `${'あ'.repeat(80)}…`, rest: 'あ'.repeat(20) });
  assert.deepEqual(lead(null), { head: '', rest: '' });
});

test('progress: done out of all, and finished only when every task is done', () => {
  assert.deepEqual(progress([{ state: 'done' }, { state: 'ready' }]), { done: 1, total: 2, pct: 50, finished: false });
  assert.equal(progress([{ state: 'done' }]).finished, true);
  assert.equal(progress([]).finished, false);
});

test('orderGoals: soonest due first, no due after, finished last, and goals the filter misses after the rest', () => {
  const g = (id, due, states = ['ready']) => ({ id, due, tasks: states.map((state) => ({ state })) });
  const goals = [g('none', null), g('late', '2026-12-20'), g('done', '2026-11-16', ['done']), g('soon', '2026-11-20')];
  assert.deepEqual(orderGoals(goals).map((x) => x.id), ['soon', 'late', 'none', 'done']);
  const hits = (x) => (x.id === 'late' ? 1 : 0);
  assert.deepEqual(orderGoals(goals, hits).map((x) => x.id), ['late', 'soon', 'none', 'done']);
});

test('splitChart: tasks joined by an order go to the chart, the rest side by side, open ones first', () => {
  const tasks = [
    { id: 'a', state: 'done', after: [] },
    { id: 'b', state: 'ready', after: ['a'] },
    { id: 'c', state: 'done', after: [] },
    { id: 'd', state: 'ready', after: ['elsewhere'] },
    { id: 'e', state: 'waiting', after: [] },
  ];
  const { linked, alone } = splitChart(tasks);
  assert.deepEqual(linked.map((t) => t.id), ['b', 'a']);
  assert.deepEqual(alone.map((t) => t.id), ['d', 'e', 'c']);
});
