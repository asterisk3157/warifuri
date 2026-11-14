// Tests for the copies of GitHub's pull requests and issues: the webhook's door
// (src/server/github.mjs: the signature, the events, the size), which owners are taken in
// (the github section of the settings), the rows and their tie to tasks
// (src/ledger/github.mjs), the github tool and stale's merged over MCP, and the migration.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openLedger, LedgerError } from '../src/ledger/ledger.mjs';
import { MIGRATIONS, SCHEMA_VERSION } from '../src/ledger/schema.mjs';
import { readSettings, writeSettings, githubReads } from '../src/ledger/settings.mjs';
import { refsIn, itemFromPayload, takeGithubEvent, githubItems, githubMergedOpen } from '../src/ledger/github.mjs';
import { signedBy, GITHUB_BODY_MAX } from '../src/server/github.mjs';
import { createServer } from '../src/server/mcp.mjs';

const ACTOR = { actor: 'human' };
const SECRET = 'hook-secret';

const pr = (over = {}, repo = {}) => ({
  action: 'opened',
  pull_request: {
    number: 7, title: 'Add the thing', state: 'open', draft: false, merged: false, merged_at: null, closed_at: null,
    html_url: 'https://github.com/example-org/widgets/pull/7', updated_at: '2026-11-01T01:00:00Z',
    head: { ref: 'feat/thing' }, user: { login: 'alex' }, assignees: [], requested_reviewers: [{ login: 'sam' }], ...over,
  },
  repository: { name: 'widgets', owner: { login: 'example-org' }, ...repo },
});
const issue = (over = {}, action = 'opened') => ({
  action,
  issue: {
    number: 3, title: 'It breaks', state: 'open', closed_at: null, html_url: 'https://github.com/example-org/widgets/issues/3',
    updated_at: '2026-11-01T02:00:00Z', user: { login: 'sam' }, assignees: [{ login: 'alex' }], ...over,
  },
  repository: { name: 'widgets', owner: { login: 'example-org' } },
});
const merged = { state: 'closed', merged: true, merged_at: '2026-11-03T04:00:00Z', closed_at: '2026-11-03T04:00:00Z', updated_at: '2026-11-03T04:00:00Z' };

function fresh(t) {
  const L = openLedger(':memory:');
  t.after(() => L.close());
  return L;
}
const readOwner = (L, name = 'example-org', read = true) => writeSettings(L, { github: { owners: [{ name, read }] } }, {}, ACTOR);

async function start(t, options = {}) {
  const ledger = openLedger(':memory:');
  const server = createServer({ ledger, githubWebhookSecret: SECRET, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const clients = [];
  t.after(async () => {
    for (const c of clients) await c.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    ledger.close();
  });
  const sign = (body, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  // Sends an event as GitHub does; headers given replace the ones made here.
  const send = (event, payload, headers) => {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return fetch(`${base}/api/github/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': event, 'X-Hub-Signature-256': sign(body), ...headers },
      body,
    });
  };
  async function connect(key) {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
    clients.push(client);
    return client;
  }
  return { base, ledger, send, sign, connect };
}

const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { res, data: res.isError ? null : JSON.parse(res.content[0].text) };
};

test('signature: the HMAC of the raw body, compared whole', () => {
  const body = Buffer.from('{"a":1}');
  const good = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
  assert.equal(signedBy(SECRET, body, good), true);
  assert.equal(signedBy(SECRET, Buffer.from('{"a":2}'), good), false);
  assert.equal(signedBy('other', body, good), false);
  assert.equal(signedBy(SECRET, body, good.slice(0, -1)), false);
  assert.equal(signedBy(SECRET, body, undefined), false);
  assert.equal(signedBy(SECRET, body, ''), false);
});

test('webhook: a right signature is taken, a wrong or missing one is refused, and nothing is stored then', async (t) => {
  const { ledger, send, sign } = await start(t);
  readOwner(ledger);

  assert.equal((await send('ping', { zen: 'x' })).status, 200);
  assert.equal((await send('pull_request', pr(), { 'X-Hub-Signature-256': sign(JSON.stringify(pr()), 'wrong') })).status, 401);
  assert.equal((await send('pull_request', pr(), { 'X-Hub-Signature-256': '' })).status, 401);
  assert.equal((await send('pull_request', pr(), { 'X-Hub-Signature-256': 'sha256=00' })).status, 401);
  // Signed for another body.
  assert.equal((await send('pull_request', pr(), { 'X-Hub-Signature-256': sign('{}') })).status, 401);
  assert.equal((await send('ping', {}, { 'X-Hub-Signature-256': '' })).status, 401);
  assert.deepEqual(githubItems(ledger).items, []);

  const ok = await send('pull_request', pr());
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  assert.equal(githubItems(ledger).items.length, 1);

  // Other events, and a body that is not JSON, store nothing.
  assert.equal((await send('push', { ref: 'refs/heads/main' })).status, 204);
  assert.equal((await send('pull_request', { action: 'opened' })).status, 204);
  assert.equal((await send('pull_request', 'not json')).status, 400);
  assert.equal((await send('pull_request', 'x'.repeat(GITHUB_BODY_MAX + 1))).status, 413);
  assert.equal(githubItems(ledger).items.length, 1);

  // No device key is taken here, and only POST.
  assert.equal((await fetch(ok.url)).status, 404);
  assert.equal((await fetch(ok.url, { method: 'POST', headers: { Authorization: 'Bearer wf_x' }, body: '{}' })).status, 401);
});

test('webhook: closed while no secret is set, and limited per address', async (t) => {
  const off = await start(t, { githubWebhookSecret: null });
  assert.equal((await off.send('ping', {})).status, 404);
  assert.equal((await off.send('pull_request', pr())).status, 404);

  const few = await start(t, { githubLimit: { max: 2, windowMs: 60_000 } });
  assert.equal((await few.send('ping', {})).status, 200);
  assert.equal((await few.send('ping', {})).status, 200);
  assert.equal((await few.send('ping', {})).status, 429);
});

test('owners: an owner that is not read is not stored, and a change of the setting holds from the next event', async (t) => {
  const { ledger, send } = await start(t);

  // Nothing is set: no owner is read.
  assert.deepEqual(readSettings(ledger).github, { owners: [], others: 'skip' });
  assert.equal((await send('pull_request', pr())).status, 204);
  assert.equal(ledger.github.get('example-org/widgets#7'), null);

  // The organization is read; the name is matched without case.
  readOwner(ledger, 'Example-Org', true);
  assert.equal((await send('pull_request', pr())).status, 200);
  assert.equal(ledger.github.get('example-org/widgets#7').state, 'open');
  // Another owner is still dropped.
  assert.equal((await send('pull_request', pr({}, { owner: { login: 'other-org' } }))).status, 204);
  assert.equal(ledger.github.get('other-org/widgets#7'), null);

  // Turned off: later events are dropped, and what was kept is no longer shown.
  readOwner(ledger, 'example-org', false);
  assert.equal((await send('pull_request', pr(merged))).status, 204);
  assert.equal(ledger.github.get('example-org/widgets#7').state, 'open');
  assert.deepEqual(githubItems(ledger).items, []);

  // Owners not listed are read when others says so; a listed false still wins.
  writeSettings(ledger, { github: { others: 'read' } }, {}, ACTOR);
  assert.equal((await send('pull_request', pr({}, { owner: { login: 'other-org' } }))).status, 200);
  assert.equal((await send('pull_request', pr(merged))).status, 204);
  assert.deepEqual(githubItems(ledger).items.map((i) => i.owner), ['other-org']);
});

test('settings: github is checked, recorded and read back', (t) => {
  const L = fresh(t);
  const out = writeSettings(L, { github: { owners: [{ name: ' alex ', read: true }, { name: 'example-org', read: false }], others: 'read' } }, {}, ACTOR);
  assert.deepEqual(out.github, { owners: [{ name: 'alex', read: true }, { name: 'example-org', read: false }], others: 'read' });
  assert.deepEqual(L.records('github').map((r) => [r.entity, r.action]), [['settings', 'update']]);
  assert.equal(githubReads(out.github, 'ALEX'), true);
  assert.equal(githubReads(out.github, 'example-org'), false);
  assert.equal(githubReads(out.github, 'someone'), true);
  assert.equal(githubReads({ owners: [], others: 'skip' }, 'someone'), false);
  assert.equal(githubReads(out.github, undefined), false);

  const bad = (github, re) => assert.throws(() => writeSettings(L, { github }, {}, ACTOR), (err) => err instanceof LedgerError && re.test(err.problems.join('\n')));
  bad({ owners: [{ name: 'a b', read: true }] }, /GitHub のユーザーか組織の名前/);
  bad({ owners: [{ name: 'alex' }] }, /read は true か false/);
  bad({ owners: [{ name: 'alex', read: true }, { name: 'Alex', read: false }] }, /オーナー Alex が2回/);
  bad({ others: 'maybe' }, /others は read か skip/);
  bad({ repos: [] }, /repos は書けません/);
  // A refused write changes nothing; null puts the section back.
  assert.equal(readSettings(L).github.owners.length, 2);
  assert.deepEqual(writeSettings(L, { github: null }, {}, ACTOR).github, { owners: [], others: 'skip' });
});

test('items: a pull request is kept as GitHub last told it, and a merge changes its state', (t) => {
  const L = fresh(t);
  readOwner(L);
  assert.equal(takeGithubEvent(L, 'pull_request', pr()), 'stored');
  assert.deepEqual(L.github.get('example-org/widgets#7'), {
    owner: 'example-org', repo: 'widgets', number: 7, kind: 'pr', title: 'Add the thing', state: 'open', draft: false,
    url: 'https://github.com/example-org/widgets/pull/7', branch: 'feat/thing', author: 'alex', assignees: [], reviewers: ['sam'],
    updated_at: '2026-11-01T01:00:00.000Z', closed_at: null,
  });
  assert.equal(takeGithubEvent(L, 'pull_request', { ...pr(merged), action: 'closed' }), 'stored');
  const after = L.github.get('example-org/widgets#7');
  assert.equal(after.state, 'merged');
  assert.equal(after.closed_at, '2026-11-03T04:00:00.000Z');
  // A delivery older than what is kept changes nothing.
  assert.equal(takeGithubEvent(L, 'pull_request', pr()), 'ignored');
  assert.equal(L.github.get('example-org/widgets#7').state, 'merged');
  // Closed without a merge, and opened again.
  takeGithubEvent(L, 'pull_request', pr({ number: 8, state: 'closed', closed_at: '2026-11-02T00:00:00Z', updated_at: '2026-11-02T00:00:00Z' }));
  assert.equal(L.github.get('example-org/widgets#8').state, 'closed');
  takeGithubEvent(L, 'pull_request', pr({ number: 8, updated_at: '2026-11-02T01:00:00Z' }));
  assert.equal(L.github.get('example-org/widgets#8').state, 'open');
  assert.equal(L.github.get('example-org/widgets#8').closed_at, null);

  // Issues: assigned, closed, and gone when GitHub deletes them.
  assert.equal(takeGithubEvent(L, 'issues', issue()), 'stored');
  assert.deepEqual(L.github.get('example-org/widgets#3').assignees, ['alex']);
  takeGithubEvent(L, 'issues', issue({ state: 'closed', closed_at: '2026-11-04T00:00:00Z', updated_at: '2026-11-04T00:00:00Z' }, 'closed'));
  assert.equal(L.github.get('example-org/widgets#3').state, 'closed');
  assert.equal(takeGithubEvent(L, 'issues', issue({}, 'deleted')), 'removed');
  assert.equal(L.github.get('example-org/widgets#3'), null);

  // The list: newest change first, filtered; nothing of these writes is in the records.
  const list = githubItems(L);
  assert.deepEqual(list.items.map((i) => i.number), [7, 8]);
  assert.deepEqual(githubItems(L, { state: 'merged' }).items.map((i) => i.number), [7]);
  assert.deepEqual(githubItems(L, { kind: 'issue' }).items, []);
  assert.deepEqual(githubItems(L, { involves: 'SAM' }).items.map((i) => i.number), [7, 8]);
  assert.deepEqual(githubItems(L, { owner: 'nobody' }).items, []);
  assert.equal(githubItems(L, { limit: 1 }).more, 1);
  assert.throws(() => githubItems(L, { state: 'done' }), LedgerError);
  assert.throws(() => githubItems(L, { limit: 1000 }), LedgerError);

  // Payloads that cannot be kept.
  assert.equal(itemFromPayload('pull_request', pr({ number: 0 })), null);
  assert.equal(itemFromPayload('pull_request', pr({ updated_at: 'soon' })), null);
  assert.equal(itemFromPayload('pull_request', pr({}, { owner: { login: 'a/b' } })), null);
  assert.equal(itemFromPayload('issue_comment', issue()), null);
  assert.equal(itemFromPayload('pull_request', pr({ title: `a\nb${'x'.repeat(400)}` })).title.length, 300);
});

test('tasks: a task is tied to an item only when its text names it', (t) => {
  assert.deepEqual(refsIn('see example-org/widgets#7 and https://github.com/Example-Org/widgets/pull/7.'), ['example-org/widgets#7']);
  assert.deepEqual(refsIn('https://github.com/example-org/widgets/issues/3#issuecomment-1'), ['example-org/widgets#3']);
  assert.deepEqual(refsIn('widgets#7, #7, PR 7, a/example-org/widgets#7'), []);
  assert.deepEqual(refsIn('example-org/widgets#71'), ['example-org/widgets#71']);
  assert.deepEqual(refsIn(null), []);

  const L = fresh(t);
  readOwner(L);
  const named = L.createTask({ title: 'Ship the thing', mode: 'ai_worker', body: 'PR: https://github.com/example-org/widgets/pull/7' }, ACTOR);
  const next = L.createTask({ title: 'Follow up', mode: 'ai_worker' }, ACTOR);
  L.update(next.id, { next: 'example-org/widgets#7 のレビュー待ち' }, ACTOR);
  const done = L.createTask({ title: 'Earlier example-org/widgets#7', mode: 'ai_worker' }, ACTOR);
  L.setState(done.id, 'done', { result: 'merged' }, ACTOR);
  // Named alike, or only the branch: not tied.
  L.createTask({ title: 'Add the thing', mode: 'ai_worker', body: 'on feat/thing, see example-org/widgets#70' }, ACTOR);

  takeGithubEvent(L, 'pull_request', pr());
  // Made in the same second, so their order by id is not fixed: compared as a set.
  assert.deepEqual(githubItems(L).items[0].tasks.map((x) => x.id).sort(), [named.id, next.id, done.id].sort());
  // Open, so nothing to say yet.
  assert.deepEqual(githubMergedOpen(L), []);

  takeGithubEvent(L, 'pull_request', pr(merged));
  const out = githubMergedOpen(L);
  assert.deepEqual(out.map((x) => x.id).sort(), [named.id, next.id].sort());
  assert.equal(out[0].pr, 'example-org/widgets#7');
  assert.equal(out[0].merged_at, '2026-11-03T04:00:00.000Z');
  assert.match(out[0].reason, /example-org\/widgets#7 が、2026-11-03 にマージされています/);

  // Closed tasks drop out; an owner no longer read says nothing.
  L.setState(named.id, 'done', { result: 'shipped' }, ACTOR);
  assert.deepEqual(githubMergedOpen(L).map((x) => x.id), [next.id]);
  readOwner(L, 'example-org', false);
  assert.deepEqual(githubMergedOpen(L), []);
});

test('MCP: stale lists the open tasks of merged pull requests, and github is the secretary\'s to read', async (t) => {
  const { ledger, send, connect } = await start(t, { secretaryDevice: 'secretary' });
  const secretary = await connect(ledger.issueKey('secretary', ACTOR).key);
  const laptop = await connect(ledger.issueKey('laptop', ACTOR).key);
  const task = ledger.createTask({ title: 'Ship', mode: 'ai_worker', body: 'example-org/widgets#7' }, ACTOR);

  // The secretary turns the owner on with the settings tool; it holds from the next event.
  assert.equal((await send('pull_request', pr())).status, 204);
  const set = await call(secretary, 'settings', { github: { owners: [{ name: 'example-org', read: true }] } });
  assert.deepEqual(set.data.github, { owners: [{ name: 'example-org', read: true }], others: 'skip' });
  assert.equal((await send('pull_request', pr(merged))).status, 200);
  assert.equal((await send('issues', issue())).status, 200);

  const stale = await call(laptop, 'stale');
  assert.deepEqual(stale.data.merged.map((x) => [x.id, x.pr]), [[task.id, 'example-org/widgets#7']]);

  const all = await call(secretary, 'github');
  assert.deepEqual(all.data.items.map((i) => [i.kind, i.number, i.state]), [['pr', 7, 'merged'], ['issue', 3, 'open']]);
  assert.deepEqual(all.data.items[0].tasks.map((x) => x.id), [task.id]);
  assert.deepEqual(all.data.owners, [{ name: 'example-org', read: true }]);
  assert.equal(all.data.others, 'skip');
  assert.deepEqual((await call(secretary, 'github', { kind: 'issue', involves: 'alex' })).data.items.map((i) => i.number), [3]);
  assert.equal((await call(secretary, 'github', { state: 'nope' })).res.isError, true);

  const other = await call(laptop, 'github');
  assert.equal(other.res.isError, true);
  assert.match(other.res.content[0].text, /秘書だけが使えるツール/);
});

test('schema 15: a version 14 file gains github_items and keeps its rows', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-github-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ledger.sqlite');
  const raw = new DatabaseSync(file);
  raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const sql of MIGRATIONS.slice(0, 14)) raw.exec(sql);
  raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '14')").run();
  raw.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('life.rules', '[\"a\"]', '2026-11-01T00:00:00.000Z')").run();
  raw.close();

  assert.equal(SCHEMA_VERSION, 17);
  const L = openLedger(file);
  assert.deepEqual(readSettings(L).life.rules, ['a']);
  readOwner(L);
  assert.equal(takeGithubEvent(L, 'pull_request', pr()), 'stored');
  L.close();
  const check = new DatabaseSync(file);
  assert.equal(check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '17');
  assert.equal(check.prepare('SELECT count(*) AS n FROM github_items').get().n, 1);
  // A row that is neither a pull request nor an issue is refused by the table itself.
  assert.throws(() => check.prepare("INSERT INTO github_items (key, owner, repo, number, kind, title, state, url, updated_at, received_at) VALUES ('a/b#1', 'a', 'b', 1, 'commit', 't', 'open', 'u', 'x', 'x')").run());
  check.close();
});
