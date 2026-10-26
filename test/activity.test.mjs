// Tests for activity(): what moved in a period, read from the records of goals and tasks.
// Each kind appears with its detail, other records stay out, the period's bounds and defaults,
// the 31-day refusal, the cut with `more`, and one call through the MCP tool.
// The server's local time is pinned to Asia/Tokyo, so "yesterday" and YYYY-MM-DD have one meaning.

process.env.TZ = 'Asia/Tokyo';

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openLedger, LedgerError, ACTIVITY_KINDS, ACTIVITY_ITEMS_MAX } from '../src/ledger/ledger.mjs';
import { createServer } from '../src/server/mcp.mjs';

const ACTOR = { actor: 'human' };
const AGENT = { actor: 'agent', device: 'laptop' };
const MIN = 60_000;
const HOUR = 60 * MIN;

// A clock the test moves by hand. It starts at 10:00 in Tokyo on 2026-10-25.
function fresh(t, start = '2026-10-25T01:00:00Z') {
  const clock = { t: Date.parse(start) };
  const L = openLedger(':memory:', { now: () => new Date(clock.t) });
  t.after(() => L.close());
  L.issueKey('laptop', ACTOR);
  return { L, advance: (ms) => (clock.t += ms) };
}

const problemsOf = (fn) => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof LedgerError);
    return err.problems;
  }
  assert.fail('expected a LedgerError');
};

test('every kind of activity appears, newest first, with its device, goal, profile and detail', (t) => {
  const { L, advance } = fresh(t);
  const goal = L.createGoal({ title: 'Thesis', mode: 'ai_worker', profile: 'research' }, ACTOR);
  advance(MIN);
  const a = L.createTask({ title: 'Read papers', mode: 'ai_worker', goal_id: goal.id }, AGENT);
  advance(1);
  const b = L.createTask({ title: 'Write draft', mode: 'ai_worker', goal_id: goal.id }, AGENT);
  advance(1);
  const c = L.createTask({ title: 'Loose task', mode: 'ai_worker' }, AGENT);
  advance(MIN);
  L.start(a.id, { device: 'laptop' }, AGENT);
  advance(MIN);
  L.release(a.id, { next: 'read chapter 3' }, AGENT);
  advance(MIN);
  L.update(a.id, { title: 'Read the papers' }, AGENT); // an edit: not activity
  L.setState(b.id, 'waiting', { waiting_on: 'Sam', waiting_for: 'comments' }, AGENT);
  advance(MIN);
  L.resume(b.id, AGENT);
  advance(MIN);
  L.setState(c.id, 'deferred', { defer_until: '2026-11-01' }, AGENT);
  advance(MIN);
  L.setState(a.id, 'done', { result: 'notes written' }, AGENT);
  advance(MIN);
  L.setState(c.id, 'discarded', { reason: 'not needed' }, ACTOR);
  advance(MIN);
  L.reopen(a.id, ACTOR);

  const out = L.activity();
  assert.deepEqual(out.counts, { created: 4, started: 1, released: 1, waiting: 1, deferred: 1, resumed: 1, done: 1, discarded: 1, reopened: 1 });
  assert.deepEqual(Object.keys(out.counts), ACTIVITY_KINDS);
  assert.equal(out.more, 0);
  assert.deepEqual(
    out.items.map((i) => [i.kind, i.title]),
    [
      ['reopened', 'Read the papers'],
      ['discarded', 'Loose task'],
      ['done', 'Read the papers'],
      ['deferred', 'Loose task'],
      ['resumed', 'Write draft'],
      ['waiting', 'Write draft'],
      ['released', 'Read the papers'],
      ['started', 'Read the papers'],
      ['created', 'Loose task'],
      ['created', 'Write draft'],
      ['created', 'Read the papers'],
      ['created', 'Thesis'],
    ],
  );
  const byKind = Object.fromEntries(out.items.map((i) => [i.kind, i]));
  assert.equal(byKind.released.next, 'read chapter 3');
  assert.equal(byKind.released.device, 'laptop');
  assert.deepEqual(byKind.released.goal, { id: goal.id, title: 'Thesis' });
  assert.equal(byKind.released.profile, 'research');
  assert.equal(byKind.done.result, 'notes written');
  assert.equal(byKind.discarded.reason, 'not needed');
  assert.equal(byKind.discarded.goal, null);
  assert.equal(byKind.discarded.profile, null);
  assert.equal(byKind.discarded.device, null);
  assert.deepEqual([byKind.waiting.waiting_on, byKind.waiting.waiting_for], ['Sam', 'comments']);
  assert.equal(byKind.deferred.defer_until, '2026-11-01');
  const goalItem = out.items.at(-1);
  assert.equal(goalItem.entity, 'goal');
  assert.equal(goalItem.profile, 'research');
  assert.equal('goal' in goalItem, false);
  // The goal itself and the eight task items under it.
  assert.deepEqual(out.goals, [{ id: goal.id, title: 'Thesis', items: 9 }]);
});

test('the period: yesterday 00:00 to now by default, [from, to) when given, and nothing outside', (t) => {
  // 2026-10-24 23:30 in Tokyo.
  const { L, advance } = fresh(t, '2026-10-24T14:30:00Z');
  const old = L.createTask({ title: 'Day before', mode: 'ai_worker' }, ACTOR);
  advance(HOUR); // 2026-10-25 00:30
  L.createTask({ title: 'Yesterday', mode: 'ai_worker' }, ACTOR);
  advance(24 * HOUR); // 2026-10-26 00:30
  L.createTask({ title: 'Today', mode: 'ai_worker' }, ACTOR);
  advance(HOUR); // 2026-10-26 01:30

  const def = L.activity();
  assert.equal(def.from, '2026-10-24T15:00:00.000Z'); // 2026-10-25 00:00 in Tokyo
  assert.equal(def.to, '2026-10-25T16:30:00.000Z'); // now
  assert.deepEqual(def.items.map((i) => i.title), ['Today', 'Yesterday']);

  const yesterday = L.activity({ from: '2026-10-25', to: '2026-10-26' });
  assert.deepEqual(yesterday.items.map((i) => i.title), ['Yesterday']);
  const before = L.activity({ from: '2026-10-24', to: '2026-10-25' });
  assert.deepEqual(before.items.map((i) => i.title), ['Day before']);
  assert.equal(before.items[0].id, old.id);
  // to is exclusive: a record at exactly `to` is left out.
  const edge = L.activity({ from: '2026-10-24', to: '2026-10-24T23:30:00+09:00' });
  assert.deepEqual(edge.items, []);
  assert.equal(edge.counts.created, 0);
});

test('a period over 31 days, a bad date or to before from is refused', (t) => {
  const { L } = fresh(t);
  assert.match(problemsOf(() => L.activity({ from: '2026-09-01', to: '2026-10-03' }))[0], /31 日まで/);
  assert.equal(L.activity({ from: '2026-09-01', to: '2026-10-02' }).items.length, 0); // exactly 31 days
  assert.match(problemsOf(() => L.activity({ from: '2026-13-01' }))[0], /YYYY-MM-DD/);
  assert.match(problemsOf(() => L.activity({ from: '2026-10-25', to: '2026-10-24' }))[0], /from より後/);
});

test('items are cut at the limit, newest first, with how many were left out; counts and goals keep all', (t) => {
  const { L, advance } = fresh(t);
  const goal = L.createGoal({ title: 'Big goal', mode: 'ai_worker' }, ACTOR);
  for (let i = 0; i < ACTIVITY_ITEMS_MAX + 4; i += 1) {
    advance(MIN);
    L.createTask({ title: `Task ${i}`, mode: 'ai_worker', goal_id: goal.id }, ACTOR);
  }
  const out = L.activity();
  assert.equal(out.items.length, ACTIVITY_ITEMS_MAX);
  assert.equal(out.more, 5); // four tasks and the goal
  assert.equal(out.items[0].title, `Task ${ACTIVITY_ITEMS_MAX + 3}`);
  assert.equal(out.counts.created, ACTIVITY_ITEMS_MAX + 5);
  assert.deepEqual(out.goals, [{ id: goal.id, title: 'Big goal', items: ACTIVITY_ITEMS_MAX + 5 }]);
});

test('the activity tool answers through MCP, and refuses a long period', async (t) => {
  const { L } = fresh(t);
  const goal = L.createGoal({ title: 'Thesis', mode: 'ai_worker', profile: 'research' }, ACTOR);
  const task = L.createTask({ title: 'Read papers', mode: 'ai_worker', goal_id: goal.id }, AGENT);
  L.setState(task.id, 'done', { result: 'read' }, AGENT);
  const desk = L.issueKey('desk', ACTOR);

  const server = createServer({ ledger: L });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'test', version: '0.0.0' });
  t.after(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${desk.key}` } },
  });
  await client.connect(transport);

  const res = await client.callTool({ name: 'activity', arguments: { from: '2026-10-25' } });
  assert.ok(!res.isError);
  const data = JSON.parse(res.content[0].text);
  assert.equal(data.counts.done, 1);
  assert.equal(data.counts.created, 2);
  assert.deepEqual(data.items[0], {
    at: data.items[0].at,
    kind: 'done',
    entity: 'task',
    id: task.id,
    title: 'Read papers',
    device: 'laptop',
    actor: 'agent',
    goal: { id: goal.id, title: 'Thesis' },
    profile: 'research',
    result: 'read',
  });

  const bad = await client.callTool({ name: 'activity', arguments: { from: '2026-01-01', to: '2026-03-01' } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /31 日まで/);
});
