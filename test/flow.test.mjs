// Tests for flow() (a goal as Mermaid text, src/ledger/flow.mjs) and stale() (candidates for
// tidying, with an injected now).

import test from 'node:test';
import assert from 'node:assert/strict';
import { openLedger, LedgerError } from '../src/ledger/ledger.mjs';
import { truncate, escapeLabel, standing, renderFlow } from '../src/ledger/flow.mjs';

const ACTOR = { actor: 'agent', device: 'laptop' };

function clock(start = '2026-10-01T00:00:00Z') {
  let t = Date.parse(start);
  return () => {
    const d = new Date(t);
    t += 1000;
    return d;
  };
}

function fresh(t, start) {
  const L = openLedger(':memory:', { now: clock(start) });
  t.after(() => L.close());
  return L;
}

const nodeLine = (text, title) => text.split('\n').find((l) => l.includes(`["${title}`));
const classOf = (text, node) => {
  const line = text.split('\n').find((l) => l.startsWith('  class ') && l.split(' ')[3].split(',').includes(node));
  return line?.split(' ')[4];
};

test('flow helpers: truncate, escape and standing', () => {
  assert.equal(truncate('short'), 'short');
  assert.equal([...truncate('あ'.repeat(41))].length, 40);
  assert.ok(truncate('x'.repeat(50)).endsWith('…'));
  assert.equal(truncate('x'.repeat(40)), 'x'.repeat(40));
  assert.equal(escapeLabel('a "b" <c> #1\nnext'), 'a #quot;b#quot; #lt;c#gt; #35;1 next');
  assert.equal(standing({ state: 'done' }), 'done');
  assert.equal(standing({ state: 'ready' }, { held: true }), 'running');
  assert.equal(standing({ state: 'running' }), 'running');
  assert.equal(standing({ state: 'ready' }, { openBefore: 0 }), 'next');
  assert.equal(standing({ state: 'ready' }, { openBefore: 1 }), 'other');
  assert.equal(standing({ state: 'waiting' }), 'waiting');
  assert.equal(standing({ state: 'deferred' }), 'other');
  const text = renderFlow({ title: 'Say "hi"' }, [], []);
  assert.ok(text.startsWith('---\ntitle: "Say \\"hi\\""\n---\nflowchart TD\n'));
});

test('flow: tasks as nodes, blocks as arrows, a class for each standing', (t) => {
  const L = fresh(t);
  L.issueKey('laptop', ACTOR);
  const g = L.createGoal({ title: 'Thesis draft', mode: 'ai_worker' }, ACTOR);
  const other = L.createGoal({ title: 'Other', mode: 'ai_worker' }, ACTOR);
  const task = (title, extra = {}) => L.createTask({ title, mode: 'ai_worker', goal_id: g.id, ...extra }, ACTOR);
  const done = task('Collect references');
  L.setState(done.id, 'done', { result: '20 papers' }, ACTOR);
  const nextUp = task('Outline "chapter 1" <draft>');
  const blocked = task('Write chapter 1');
  const held = task('Make the figures');
  L.start(held.id, { device: 'laptop' }, ACTOR);
  const waiting = task('Ask the advisor', { state: 'waiting', waiting_on: 'advisor', waiting_for: 'a slot' });
  const outside = L.createTask({ title: 'Outside first', mode: 'ai_worker', goal_id: other.id }, ACTOR);
  const afterOutside = task('Needs the outside task');
  const dropped = task('Dropped idea');
  L.setState(dropped.id, 'discarded', { reason: 'no' }, ACTOR);
  const long = task('A'.repeat(60));
  L.link(done.id, nextUp.id, ACTOR);
  L.link(nextUp.id, blocked.id, ACTOR);
  L.link(outside.id, afterOutside.id, ACTOR);

  const text = L.flow(g.id);
  const lines = text.split('\n');
  assert.deepEqual(lines.slice(0, 4), ['---', 'title: "Thesis draft"', '---', 'flowchart TD']);
  assert.ok(text.endsWith('\n'));
  // Nodes in creation order, discarded tasks left out.
  const nodes = lines.filter((l) => /^ {2}n\d+\["/.test(l));
  assert.equal(nodes.length, 7);
  assert.ok(!text.includes('Dropped idea'));
  assert.ok(nodeLine(text, 'Outline').includes('#quot;chapter 1#quot; #lt;draft#gt;'));
  assert.ok(nodeLine(text, 'Make the figures').includes('<br/>laptop で作業中'));
  assert.ok(nodeLine(text, 'AAAA').includes(`${'A'.repeat(39)}…"]`));
  // Arrows only between this goal's tasks.
  assert.deepEqual(lines.filter((l) => l.includes('-->')), ['  n0 --> n1', '  n1 --> n2']);
  for (const name of ['done', 'running', 'next', 'waiting', 'other']) assert.ok(text.includes(`  classDef ${name} `), name);
  assert.equal(classOf(text, 'n0'), 'done');
  assert.equal(classOf(text, 'n1'), 'next');
  assert.equal(classOf(text, 'n2'), 'other'); // its predecessor is still open
  assert.equal(classOf(text, 'n3'), 'running');
  assert.equal(classOf(text, 'n4'), 'waiting');
  assert.equal(classOf(text, 'n5'), 'other'); // blocked by a task of another goal
  assert.equal(classOf(text, 'n6'), 'next');
  assert.equal(L.flow('g_20261001000000_nogoal'), null);

  L.setState(outside.id, 'done', { result: 'ok' }, ACTOR);
  assert.equal(classOf(L.flow(g.id), 'n5'), 'next');
});

test('stale: held without change, ready untouched, waiting without change', (t) => {
  const L = fresh(t, '2026-10-01T00:00:00Z');
  L.issueKey('laptop', ACTOR);
  const held = L.createTask({ title: 'Held', mode: 'ai_worker' }, ACTOR);
  L.start(held.id, { device: 'laptop' }, ACTOR);
  const ready = L.createTask({ title: 'Ready', mode: 'ai_worker' }, ACTOR);
  const waiting = L.createTask({ title: 'Waiting', mode: 'ai_worker', state: 'waiting', waiting_on: 'advisor', waiting_for: 'comments' }, ACTOR);
  const done = L.createTask({ title: 'Done', mode: 'ai_worker', state: 'done', result: 'ok' }, ACTOR);

  const soon = L.stale({ now: '2026-10-02T00:00:00Z' });
  assert.deepEqual([soon.held, soon.ready, soon.waiting], [[], [], []]);
  assert.equal(soon.now, '2026-10-02T00:00:00.000Z');

  const at = new Date('2026-11-05T00:00:00Z');
  const late = L.stale({ now: at });
  assert.deepEqual(late.held.map((x) => x.id), [held.id]);
  assert.equal(late.held[0].device, 'laptop');
  assert.equal(late.held[0].days, 34);
  assert.match(late.held[0].reason, /laptop で作業中のまま、34日/);
  assert.deepEqual(late.ready.map((x) => x.id), [ready.id]);
  assert.match(late.ready[0].reason, /34日触られていません/);
  assert.deepEqual(late.waiting.map((x) => x.id), [waiting.id]);
  assert.match(late.waiting[0].reason, /advisor の「comments」/);
  const all = JSON.stringify(late);
  assert.ok(!all.includes(done.id));

  // Thresholds are the caller's.
  const tight = L.stale({ now: '2026-10-03T00:00:00Z', heldDays: 1, readyDays: 1, waitingDays: 100 });
  assert.equal(tight.held.length, 1);
  assert.equal(tight.ready.length, 1);
  assert.equal(tight.waiting.length, 0);
  // It only reads.
  assert.equal(L.get(held.id).state, 'running');
  assert.equal(L.records(held.id).length, 2);
  assert.throws(() => L.stale({ heldDays: -1 }), LedgerError);
  assert.throws(() => L.stale({ now: 'not a date' }), LedgerError);
});
