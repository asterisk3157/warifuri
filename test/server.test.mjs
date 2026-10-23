// End-to-end tests for the MCP endpoint (src/server/mcp.mjs): keys, the three read tools
// and secrecy, through the SDK's own client over HTTP.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openLedger } from '../src/ledger/ledger.mjs';
import { createServer } from '../src/server/mcp.mjs';

const ACTOR = { actor: 'human' };

// A ledger with an open goal and task, a withheld goal with a task, and a task withheld by its place.
async function start(t) {
  const ledger = openLedger(':memory:');
  const open = ledger.createGoal({ title: 'Open goal', mode: 'ai_worker', outcome: 'visible outcome' }, ACTOR);
  const openTask = ledger.createTask({ title: 'Open task', mode: 'ai_worker', goal_id: open.id, done_when: 'visible' }, ACTOR);
  const secret = ledger.createGoal({ title: 'Secret goal', mode: 'ai_worker', outcome: 'hidden outcome', secrecy: 'withhold' }, ACTOR);
  const secretTask = ledger.createTask({ title: 'Secret task', mode: 'ai_worker', goal_id: secret.id, done_when: 'hidden done_when' }, ACTOR);
  const place = ledger.createPlace({ name: 'Private repo', secrecy: 'withhold', paths: [{ machine: 'laptop', path: '/hidden/path' }] }, ACTOR);
  const placeTask = ledger.createTask({ title: 'Placed task', mode: 'ai_worker', place_id: place.id, done_when: 'hidden too' }, ACTOR);
  const openPlace = ledger.createPlace({ name: 'Public repo', paths: [{ machine: 'laptop', path: '/public/path' }] }, ACTOR);
  const outsider = ledger.addMachine('laptop', {}, ACTOR);
  const reader = ledger.addMachine('desk', { readWithheld: true }, ACTOR);
  const revoked = ledger.addMachine('lost', {}, ACTOR);
  ledger.revokeMachine('lost', ACTOR);

  const server = createServer({ ledger });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const clients = [];
  t.after(async () => {
    for (const c of clients) await c.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    ledger.close();
  });

  async function connect(key) {
    const client = new Client({ name: 'test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    });
    await client.connect(transport);
    clients.push(client);
    return client;
  }

  const ids = { open: open.id, openTask: openTask.id, secret: secret.id, secretTask: secretTask.id, place: place.id, placeTask: placeTask.id, openPlace: openPlace.id };
  return { base, connect, keys: { outsider: outsider.key, reader: reader.key, revoked: revoked.key }, ids };
}

const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { res, data: res.isError ? null : JSON.parse(res.content[0].text) };
};

test('/health answers without a key; other paths are 404', async (t) => {
  const { base } = await start(t);
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
  assert.equal((await fetch(`${base}/nothing`)).status, 404);
});

test('/mcp refuses a missing, wrong or revoked key with 401', async (t) => {
  const { base, keys } = await start(t);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  for (const auth of [undefined, 'Bearer wf_wrong', `Bearer ${keys.revoked}`, `Basic ${keys.outsider}`]) {
    const res = await fetch(`${base}/mcp`, { method: 'POST', body, headers: auth ? { ...headers, Authorization: auth } : headers });
    assert.equal(res.status, 401, String(auth));
    assert.equal(res.headers.get('www-authenticate'), 'Bearer');
    const json = await res.json();
    assert.equal(json.jsonrpc, '2.0');
    assert.equal(typeof json.error.message, 'string');
  }
  // The SDK client fails to connect as well.
  const client = new Client({ name: 'test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: 'Bearer wf_wrong' } } });
  await assert.rejects(client.connect(transport));
});

test('tools/list shows the three read tools', async (t) => {
  const { connect, keys } = await start(t);
  const client = await connect(keys.outsider);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name).sort(), ['board', 'get', 'search']);
  for (const tool of tools) assert.ok(tool.description.length > 0);
});

test('a machine without read_withheld sees withheld rows reduced', async (t) => {
  const { connect, keys, ids } = await start(t);
  const client = await connect(keys.outsider);

  const { res, data: board } = await call(client, 'board');
  assert.deepEqual(res.structuredContent, board);
  const secret = board.goals.find((g) => g.id === ids.secret);
  assert.deepEqual(Object.keys(secret).sort(), ['due', 'id', 'kind', 'state', 'tasks', 'title', 'withheld']);
  assert.equal(secret.tasks[0].withheld, true);
  assert.equal(board.goals.find((g) => g.id === ids.open).outcome, 'visible outcome');
  assert.deepEqual(board.unassigned[0], { kind: 'task', id: ids.placeTask, title: 'Placed task', state: 'ready', due: null, goal_id: null, withheld: true });
  const text = JSON.stringify(board);
  for (const hidden of ['hidden outcome', 'hidden done_when', 'hidden too']) assert.ok(!text.includes(hidden), hidden);

  const { data: goal } = await call(client, 'get', { id: ids.secret });
  assert.deepEqual(goal, {
    kind: 'goal', id: ids.secret, title: 'Secret goal', state: 'ready', due: null, withheld: true,
    tasks: [{ kind: 'task', id: ids.secretTask, title: 'Secret task', state: 'ready', due: null, goal_id: ids.secret, withheld: true }],
  });
  const { data: task } = await call(client, 'get', { id: ids.secretTask });
  assert.deepEqual(task, { kind: 'task', id: ids.secretTask, title: 'Secret task', state: 'ready', due: null, goal_id: ids.secret, withheld: true });
  const { data: openTask } = await call(client, 'get', { id: ids.openTask });
  assert.equal(openTask.done_when, 'visible');
  assert.ok(openTask.records.length > 0);

  const { data: place } = await call(client, 'get', { id: ids.place });
  assert.deepEqual(place, { kind: 'place', id: ids.place, name: 'Private repo', withheld: true });
  const { data: openPlace } = await call(client, 'get', { id: ids.openPlace });
  assert.equal(openPlace.name, 'Public repo');
  assert.ok(!JSON.stringify(openPlace).includes('/public/path'));

  const { res: found, data: results } = await call(client, 'search', { text: 'secret' });
  assert.deepEqual(found.structuredContent, { results });
  assert.deepEqual(results.map((r) => r.withheld).sort(), [true, true]);
  for (const r of results) assert.deepEqual(Object.keys(r).sort(), ['due', 'id', 'kind', 'state', 'title', 'withheld']);
});

test('a machine with read_withheld sees everything but place paths', async (t) => {
  const { connect, keys, ids } = await start(t);
  const client = await connect(keys.reader);
  const { data: board } = await call(client, 'board');
  const secret = board.goals.find((g) => g.id === ids.secret);
  assert.equal(secret.outcome, 'hidden outcome');
  assert.equal(secret.tasks[0].done_when, 'hidden done_when');
  assert.equal(board.unassigned[0].done_when, 'hidden too');
  const { data: goal } = await call(client, 'get', { id: ids.secret });
  assert.ok(goal.records.length > 0);
  const { data: place } = await call(client, 'get', { id: ids.place });
  assert.equal(place.secrecy, 'withhold');
  assert.ok(!JSON.stringify(place).includes('/hidden/path'));
  const { data: results } = await call(client, 'search', { text: 'secret', limit: 1 });
  assert.equal(results.length, 1);
  assert.ok(!('withheld' in results[0]));
});

test('get with an unknown id is a tool error; bad input is refused', async (t) => {
  const { connect, keys } = await start(t);
  const client = await connect(keys.outsider);
  const { res } = await call(client, 'get', { id: 'g_00000000000000_nobody' });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /ありません/);
  const bad = await client.callTool({ name: 'search', arguments: { text: 'x', limit: 101 } });
  assert.equal(bad.isError, true);
  const { data } = await call(client, 'board', { state: 'ready', mode: 'ai_worker', review: false, include_closed: true });
  assert.ok(Array.isArray(data.goals));
});
