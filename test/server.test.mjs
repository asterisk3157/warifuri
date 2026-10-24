// End-to-end tests for the MCP endpoint (src/server/mcp.mjs): device keys, the read tools
// (board, get, search, flow, stale) and the absence of any redaction, through the SDK's own
// client over HTTP. The write tools and /api are in write.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openLedger } from '../src/ledger/ledger.mjs';
import { createServer } from '../src/server/mcp.mjs';

const ACTOR = { actor: 'human' };

// A ledger with two profiles, a place on the laptop, a held task, and three device keys.
async function start(t) {
  // A clock that moves 1 ms on every read, so rows made one after another keep their order
  // (the ledger orders by created_at, then by the random part of the id).
  let tick = 0;
  const ledger = openLedger(':memory:', { now: () => new Date(Date.now() + (tick += 1)) });
  const research = ledger.createGoal({ title: 'Research goal', mode: 'ai_worker', outcome: 'visible outcome', profile: 'research' }, ACTOR);
  const researchTask = ledger.createTask({ title: 'Research task', mode: 'ai_worker', goal_id: research.id, body: 'the whole body' }, ACTOR);
  const club = ledger.createGoal({ title: 'Club goal', mode: 'ai_worker', profile: 'club' }, ACTOR);
  const clubTask = ledger.createTask({ title: 'Club task', mode: 'ai_worker', goal_id: club.id }, ACTOR);
  const place = ledger.createPlace({ name: 'thesis', profile: 'research', paths: [{ device: 'laptop', path: '/home/alex/thesis' }] }, ACTOR);
  const laptop = ledger.issueKey('laptop', ACTOR);
  const desk = ledger.issueKey('desk', ACTOR);
  const revoked = ledger.issueKey('lost', ACTOR);
  ledger.revokeKey('lost', ACTOR);
  ledger.start(researchTask.id, { device: 'laptop', placeId: place.id }, { actor: 'agent', device: 'laptop' });
  ledger.link(researchTask.id, ledger.createTask({ title: 'After research', mode: 'ai_worker', goal_id: research.id }, ACTOR).id, ACTOR);

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

  const ids = { research: research.id, researchTask: researchTask.id, club: club.id, clubTask: clubTask.id, place: place.id };
  return { base, connect, keys: { laptop: laptop.key, desk: desk.key, revoked: revoked.key }, ids };
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
  for (const auth of [undefined, 'Bearer wf_wrong', `Bearer ${keys.revoked}`, `Basic ${keys.laptop}`]) {
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

test('tools/list shows the read tools, marked read-only, and the write tools', async (t) => {
  const { connect, keys } = await start(t);
  const client = await connect(keys.laptop);
  const { tools } = await client.listTools();
  const reads = ['board', 'context', 'flow', 'get', 'places', 'search', 'stale'];
  const writes = ['close', 'create_goal', 'create_task', 'defer', 'link', 'note', 'place', 'release', 'reopen', 'resume', 'start', 'unlink', 'update', 'wait'];
  assert.deepEqual(tools.map((x) => x.name).sort(), [...reads, ...writes].sort());
  for (const tool of tools) {
    assert.ok(tool.description.length > 0);
    assert.equal(tool.annotations.readOnlyHint, reads.includes(tool.name), tool.name);
    assert.equal('device' in tool.inputSchema.properties, false, tool.name);
  }
});

test('nothing is redacted: every device sees every row, field and path', async (t) => {
  const { connect, keys, ids } = await start(t);
  for (const key of [keys.laptop, keys.desk]) {
    const client = await connect(key);
    const { res, data: board } = await call(client, 'board');
    assert.deepEqual(res.structuredContent, board);
    assert.deepEqual(board.goals.map((g) => g.id).sort(), [ids.research, ids.club].sort());
    const research = board.goals.find((g) => g.id === ids.research);
    assert.equal(research.outcome, 'visible outcome');
    assert.equal(research.tasks[0].body, 'the whole body');
    assert.equal(research.tasks[0].hold.device, 'laptop');
    assert.ok(!JSON.stringify(board).includes('withheld'));

    const { data: place } = await call(client, 'get', { id: ids.place });
    assert.deepEqual(place.paths, [{ device: 'laptop', path: '/home/alex/thesis' }]);
    assert.ok(place.records[0].changes.paths);
    const { data: task } = await call(client, 'get', { id: ids.researchTask });
    assert.equal(task.profile, 'research');
    assert.ok(task.records.some((r) => r.action === 'start' && r.device === 'laptop'));

    const { res: found, data: results } = await call(client, 'search', { text: 'goal' });
    assert.deepEqual(found.structuredContent, { results });
    assert.equal(results.length, 2);
  }
});

test('board by place uses the calling device: its path for the directory gives the profile', async (t) => {
  const { connect, keys, ids } = await start(t);
  const laptop = await connect(keys.laptop);
  const { data: here } = await call(laptop, 'board', { place: '/home/alex/thesis/chapter1' });
  assert.deepEqual(here.goals.map((g) => g.id), [ids.research]);
  assert.equal(here.scope.profile, 'research');
  assert.equal(here.scope.place.id, ids.place);
  // The desk has no path there, so the same directory names no place.
  const desk = await connect(keys.desk);
  const { data: there } = await call(desk, 'board', { place: '/home/alex/thesis/chapter1' });
  assert.equal(there.goals.length, 2);
  assert.equal(there.scope.place, null);
  const { data: club } = await call(desk, 'board', { profile: 'club' });
  assert.deepEqual(club.goals.map((g) => g.id), [ids.club]);
});

test('flow returns Mermaid text; stale returns candidates', async (t) => {
  const { connect, keys, ids } = await start(t);
  const client = await connect(keys.desk);
  const res = await client.callTool({ name: 'flow', arguments: { goal_id: ids.research } });
  assert.ok(!res.isError);
  assert.match(res.content[0].text, /^---\ntitle: "Research goal"\n---\nflowchart TD\n/);
  assert.match(res.content[0].text, /n0 --> n1/);
  assert.equal(res.structuredContent.mermaid, res.content[0].text);
  const missing = await client.callTool({ name: 'flow', arguments: { goal_id: 'g_00000000000000_nobody' } });
  assert.equal(missing.isError, true);

  const { data: none } = await call(client, 'stale');
  assert.deepEqual([none.held, none.ready, none.waiting], [[], [], []]);
  const { data: all } = await call(client, 'stale', { held_days: 0, ready_days: 0, waiting_days: 0 });
  assert.deepEqual(all.held.map((x) => x.id), [ids.researchTask]);
  assert.equal(all.ready.length, 2);
  const bad = await client.callTool({ name: 'stale', arguments: { held_days: -1 } });
  assert.equal(bad.isError, true);
});

test('get with an unknown id is a tool error; bad input is refused', async (t) => {
  const { connect, keys } = await start(t);
  const client = await connect(keys.laptop);
  const { res } = await call(client, 'get', { id: 'g_00000000000000_nobody' });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /ありません/);
  const bad = await client.callTool({ name: 'search', arguments: { text: 'x', limit: 101 } });
  assert.equal(bad.isError, true);
  const { data } = await call(client, 'board', { state: 'ready', mode: 'ai_worker', review: false, include_closed: true });
  assert.ok(Array.isArray(data.goals));
  // An unknown tool fails either as a tool error or a protocol error.
  const unknown = await client.callTool({ name: 'delete_everything', arguments: {} }).catch((err) => ({ thrown: err }));
  assert.ok(unknown.thrown || unknown.isError === true);
});
