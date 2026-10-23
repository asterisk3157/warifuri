// Tests for secrecy.mjs: effective secrecy from a task, its goal and its place, and what a
// machine without read_withheld is shown.

import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveSecrecy, taskSecrecy, goalSecrecy, redactBoard, redactItem, redactSearch } from '../src/ledger/secrecy.mjs';

const OUTSIDER = { name: 'laptop', read_withheld: false };
const READER = { name: 'desk', read_withheld: true };

// Goal gw is withheld, go open; place pw withheld, po open.
const index = {
  goals: new Map([['gw', 'withhold'], ['go', 'open']]),
  places: new Map([['pw', 'withhold'], ['po', 'open']]),
  tasks: new Map([
    ['t_open', { secrecy: null, goal_id: 'go', place_id: 'po' }],
    ['t_own', { secrecy: 'withhold', goal_id: 'go', place_id: null }],
    ['t_goal', { secrecy: 'open', goal_id: 'gw', place_id: null }],
    ['t_place', { secrecy: null, goal_id: null, place_id: 'pw' }],
  ]),
};

const task = (id, extra = {}) => ({
  id, title: `title ${id}`, done_when: 'done when', state: 'waiting', mode: 'human', due: '2026-12-01',
  waiting_on: 'someone', waiting_for: 'an answer', result: null, reason: null, review: ['flag'],
  ...index.tasks.get(id), ...extra,
});

test('effective secrecy: withhold beats open, null inherits', () => {
  assert.equal(effectiveSecrecy(), 'open');
  assert.equal(effectiveSecrecy(null, null, null), 'open');
  assert.equal(effectiveSecrecy('open', 'open', 'open'), 'open');
  assert.equal(effectiveSecrecy('open', 'withhold', null), 'withhold');
  assert.equal(effectiveSecrecy(null, null, 'withhold'), 'withhold');
  assert.equal(effectiveSecrecy('withhold', 'open', 'open'), 'withhold');

  // A task's own 'open' does not open what its goal or place withholds.
  assert.equal(taskSecrecy({ secrecy: 'open', goal_id: 'gw', place_id: null }, index), 'withhold');
  assert.equal(taskSecrecy({ secrecy: 'open', goal_id: 'go', place_id: 'pw' }, index), 'withhold');
  assert.equal(taskSecrecy({ secrecy: 'withhold', goal_id: 'go', place_id: 'po' }, index), 'withhold');
  assert.equal(taskSecrecy({ secrecy: null, goal_id: 'go', place_id: 'po' }, index), 'open');
  assert.equal(taskSecrecy({ secrecy: null, goal_id: null, place_id: null }, index), 'open');
  // A goal is only its own.
  assert.equal(goalSecrecy({ secrecy: 'withhold' }), 'withhold');
  assert.equal(goalSecrecy({ secrecy: 'open' }), 'open');
});

test('a withheld task is reduced to title, state and due', () => {
  for (const id of ['t_own', 't_goal', 't_place']) {
    const t = task(id);
    assert.deepEqual(redactItem({ kind: 'task', ...t, blocks: [], blocked_by: [], records: [{ id: 1 }] }, index, OUTSIDER), {
      kind: 'task', id, title: `title ${id}`, state: 'waiting', due: '2026-12-01', goal_id: t.goal_id, withheld: true,
    });
  }
  const open = { kind: 'task', ...task('t_open'), records: [] };
  assert.deepEqual(redactItem(open, index, OUTSIDER), open);
  const own = { kind: 'task', ...task('t_own'), records: [] };
  assert.deepEqual(redactItem(own, index, READER), own);
});

test('a withheld goal is reduced, and its tasks with it', () => {
  const goal = {
    kind: 'goal', id: 'gw', title: 'secret goal', outcome: 'o', due: '2026-11-01', state: 'running', secrecy: 'withhold',
    area: 'a', result: null, review: null, tasks: [task('t_goal')], records: [{ id: 1 }],
  };
  assert.deepEqual(redactItem(goal, index, OUTSIDER), {
    kind: 'goal', id: 'gw', title: 'secret goal', state: 'running', due: '2026-11-01', withheld: true,
    tasks: [{ kind: 'task', id: 't_goal', title: 'title t_goal', state: 'waiting', due: '2026-12-01', goal_id: 'gw', withheld: true }],
  });
  assert.deepEqual(redactItem(goal, index, READER), goal);

  // An open goal keeps its fields; only its withheld tasks are reduced.
  const openGoal = { kind: 'goal', id: 'go', title: 'g', outcome: 'o', due: null, state: 'ready', secrecy: 'open', tasks: [task('t_open'), task('t_own')], records: [] };
  const seen = redactItem(openGoal, index, OUTSIDER);
  assert.equal(seen.outcome, 'o');
  assert.deepEqual(seen.tasks[0], task('t_open'));
  assert.deepEqual(seen.tasks[1], { kind: 'task', id: 't_own', title: 'title t_own', state: 'waiting', due: '2026-12-01', goal_id: 'go', withheld: true });
});

test('board rows are reduced the same way', () => {
  const board = {
    goals: [
      { id: 'gw', title: 'secret goal', outcome: 'o', due: null, state: 'ready', secrecy: 'withhold', tasks: [task('t_goal')] },
      { id: 'go', title: 'open goal', outcome: 'o', due: null, state: 'ready', secrecy: 'open', tasks: [task('t_open')] },
    ],
    unassigned: [task('t_place')],
  };
  assert.deepEqual(redactBoard(board, index, OUTSIDER), {
    goals: [
      {
        kind: 'goal', id: 'gw', title: 'secret goal', state: 'ready', due: null, withheld: true,
        tasks: [{ kind: 'task', id: 't_goal', title: 'title t_goal', state: 'waiting', due: '2026-12-01', goal_id: 'gw', withheld: true }],
      },
      board.goals[1],
    ],
    unassigned: [{ kind: 'task', id: 't_place', title: 'title t_place', state: 'waiting', due: '2026-12-01', goal_id: null, withheld: true }],
  });
  assert.deepEqual(redactBoard(board, index, READER), board);
});

test('search results for withheld rows keep only kind, id, title, state and due', () => {
  const row = (kind, id) => ({ kind, id, title: `title ${id}`, state: 'ready', due: null, review: null, updated_at: 'x' });
  const results = [row('goal', 'gw'), row('goal', 'go'), row('task', 't_open'), row('task', 't_own'), row('task', 't_goal'), row('task', 't_place'), row('task', 't_unknown')];
  const seen = redactSearch(results, index, OUTSIDER);
  const reduced = (r) => ({ kind: r.kind, id: r.id, title: r.title, state: r.state, due: r.due, withheld: true });
  assert.deepEqual(seen, [reduced(results[0]), results[1], results[2], reduced(results[3]), reduced(results[4]), reduced(results[5]), reduced(results[6])]);
  assert.deepEqual(redactSearch(results, index, READER), results);
});

test('places lose their paths for every machine; habits are returned as they are', () => {
  const place = {
    kind: 'place', id: 'po', name: 'repo', area: 'a', secrecy: 'open', paths: [{ machine: 'm', path: '/x' }],
    records: [{ id: 1, changes: { name: { before: null, after: 'repo' }, paths: { before: null, after: [{ machine: 'm', path: '/x' }] } } }],
  };
  for (const machine of [OUTSIDER, READER]) {
    const seen = redactItem(place, index, machine);
    assert.ok(!('paths' in seen));
    assert.ok(!JSON.stringify(seen).includes('/x'));
    assert.deepEqual(seen.records[0].changes, { name: { before: null, after: 'repo' } });
  }
  const secret = { ...place, id: 'pw', secrecy: 'withhold' };
  assert.deepEqual(redactItem(secret, index, OUTSIDER), { kind: 'place', id: 'pw', name: 'repo', withheld: true });

  const habit = { kind: 'habit', id: 'h', title: 'walk', rule: 'daily', goal_id: 'gw', records: [] };
  assert.equal(redactItem(habit, index, OUTSIDER), habit);
  assert.equal(redactItem(null, index, OUTSIDER), null);
});
