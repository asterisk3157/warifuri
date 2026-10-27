// Tests for the secretary's reports: the version 7 schema (the reports table, records naming
// 'report'), writing and reading them in the ledger with paging and refusals, and the report
// and reports tools of the MCP endpoint. The 秘書 screen's endpoint is in web.test.mjs.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openLedger, LedgerError } from '../src/ledger/ledger.mjs';
import { MIGRATIONS, SCHEMA_VERSION } from '../src/ledger/schema.mjs';
import { REPORT_BODY_MAX } from '../src/ledger/rules.mjs';
import { createServer } from '../src/server/mcp.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warifuri-reports-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const SECRETARY = { actor: 'device-key', device: 'secretary' };

// A clock moved by hand, a second at a time on each read unless frozen.
function handClock(start = '2026-10-25T13:00:00Z') {
  let t = Date.parse(start);
  let step = 1000;
  return {
    now: () => {
      const d = new Date(t);
      t += step;
      return d;
    },
    freeze: () => {
      step = 0;
    },
  };
}

const problemsOf = (fn) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof LedgerError) return err.problems;
    throw err;
  }
  assert.fail('expected a LedgerError');
};

test('schema: a version 6 file gains reports and keeps its records; reports are recorded', () => {
  const file = path.join(tmpRoot, `v6-${Date.now()}.sqlite`);
  const raw = new DatabaseSync(file);
  raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const m of MIGRATIONS.slice(0, 6)) raw.exec(m);
  raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '6')").run();
  const ins = raw.prepare('INSERT INTO records (at, actor, device, entity, entity_id, action, changes) VALUES (?, ?, ?, ?, ?, ?, ?)');
  ins.run('2026-10-01T00:00:00.000Z', 'web', null, 'settings', 'profile', 'update', '{}');
  assert.throws(() => ins.run('2026-10-02T00:00:00.000Z', 'human', null, 'report', 'r1', 'create', '{}'), /CHECK/);
  raw.close();

  assert.equal(SCHEMA_VERSION, 10);
  const L = openLedger(file, { now: handClock().now });
  assert.deepEqual(L.records('profile').map((r) => [r.id, r.entity]), [[1, 'settings']]);
  const r = L.writeReport({ kind: 'nightly', title: 'Tonight', body: 'All on track.' }, SECRETARY);
  assert.match(r.id, /^r_\d{14}_[a-z0-9]{6}$/);
  assert.deepEqual(L.records(r.id).map((x) => [x.id, x.entity, x.action, x.device]), [[2, 'report', 'create', 'secretary']]);
  L.close();

  const check = new DatabaseSync(file);
  assert.equal(check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, String(SCHEMA_VERSION));
  assert.equal(check.prepare("SELECT 1 FROM sqlite_master WHERE name = 'records_v6'").get(), undefined);
  assert.ok(check.prepare("SELECT 1 FROM sqlite_master WHERE name = 'reports_created'").get());
  assert.throws(() => check.exec('DELETE FROM records WHERE id = 1'), /append-only/);
  assert.throws(
    () => check.prepare("INSERT INTO reports (id, kind, title, body, created_at) VALUES ('r_x', 'weekly', 't', 'b', 'x')").run(),
    /CHECK/,
  );
  check.close();
});

test('writeReport stores the writer\'s device, tidies line ends, and refuses in Japanese', () => {
  const L = openLedger(':memory:', { now: handClock().now });
  const r = L.writeReport({ kind: 'morning', title: '  Today  ', body: 'line 1\r\nline 2\r\n' }, SECRETARY);
  assert.deepEqual(Object.keys(r).sort(), ['body', 'created_at', 'device', 'id', 'kind', 'title']);
  assert.equal(r.title, 'Today');
  assert.equal(r.body, 'line 1\nline 2');
  assert.equal(r.device, 'secretary');
  assert.match(r.created_at, /^2026-10-25T13:00:\d{2}\.000Z$/);
  assert.equal(L.writeReport({ kind: 'inbox', title: 'Inbox', body: 'x' }, { actor: 'human' }).device, null);

  assert.deepEqual(problemsOf(() => L.writeReport({ kind: 'weekly', title: '', body: ' ' }, SECRETARY)), [
    '報告の種類(kind)は nightly, morning, inbox のどれかです',
    '報告には題名(title)が要ります',
    '報告には本文(body)が要ります',
  ]);
  assert.match(problemsOf(() => L.writeReport({ kind: 'nightly', title: 'a\nb', body: 'x' }, SECRETARY))[0], /1行/);
  assert.match(problemsOf(() => L.writeReport({ kind: 'nightly', title: 'x'.repeat(201), body: 'x' }, SECRETARY))[0], /200 文字まで/);
  assert.match(problemsOf(() => L.writeReport({ kind: 'nightly', title: 't', body: 'あ'.repeat(REPORT_BODY_MAX + 1) }, SECRETARY))[0], /20000 文字まで/);
  assert.equal(L.writeReport({ kind: 'nightly', title: 't', body: 'あ'.repeat(REPORT_BODY_MAX) }, SECRETARY).body.length, REPORT_BODY_MAX);
  assert.match(problemsOf(() => L.writeReport({ kind: 'nightly', title: 't', body: 'a\u0007b' }, SECRETARY))[0], /制御文字/);
  assert.match(problemsOf(() => L.writeReport({ kind: 'nightly', title: 't', body: 'b', id: 'r_1' }, SECRETARY))[0], /id はここでは書けません/);
  assert.match(problemsOf(() => L.writeReport({ kind: 'nightly', title: 't', body: 'b' }, {}))[0], /actor/);
  L.close();
});

test('listReports: newest first, by kind, paged with before (an id or a time), refusals', () => {
  const clock = handClock();
  const L = openLedger(':memory:', { now: clock.now });
  const ids = [];
  for (let i = 0; i < 5; i += 1) ids.push(L.writeReport({ kind: i % 2 ? 'morning' : 'nightly', title: `R${i}`, body: 'b' }, SECRETARY).id);
  // Two written in the same millisecond keep the order they were added in.
  clock.freeze();
  ids.push(L.writeReport({ kind: 'inbox', title: 'R5', body: 'b' }, SECRETARY).id);
  ids.push(L.writeReport({ kind: 'inbox', title: 'R6', body: 'b' }, SECRETARY).id);
  const titles = (out) => out.reports.map((r) => r.title);

  const first = L.listReports();
  assert.deepEqual(titles(first), ['R6', 'R5', 'R4', 'R3', 'R2', 'R1', 'R0']);
  assert.equal(first.next_before, null);

  const page1 = L.listReports({ limit: 3 });
  assert.deepEqual(titles(page1), ['R6', 'R5', 'R4']);
  assert.equal(page1.next_before, ids[4]);
  const page2 = L.listReports({ limit: 3, before: page1.next_before });
  assert.deepEqual(titles(page2), ['R3', 'R2', 'R1']);
  const page3 = L.listReports({ limit: 3, before: page2.next_before });
  assert.deepEqual(titles(page3), ['R0']);
  assert.equal(page3.next_before, null);
  assert.deepEqual(titles(L.listReports({ before: ids[6] })), ['R5', 'R4', 'R3', 'R2', 'R1', 'R0']);

  assert.deepEqual(titles(L.listReports({ kind: 'morning' })), ['R3', 'R1']);
  // Before a time (here R2's, written with an offset) returns only the older ones.
  const r2 = Date.parse(first.reports.find((r) => r.title === 'R2').created_at);
  const jst = new Date(r2 + 9 * 3600_000).toISOString().replace('Z', '+09:00');
  assert.deepEqual(titles(L.listReports({ before: jst })), ['R1', 'R0']);
  assert.equal(L.listReports({ limit: 50 }).reports.length, 7);

  assert.match(problemsOf(() => L.listReports({ kind: 'weekly' }))[0], /nightly, morning, inbox/);
  for (const limit of [0, 51, 2.5, '3']) assert.match(problemsOf(() => L.listReports({ limit }))[0], /1〜50 の整数/, String(limit));
  assert.match(problemsOf(() => L.listReports({ before: 'r_20261025130000_zzzzzz' }))[0], /という報告はありません/);
  assert.match(problemsOf(() => L.listReports({ before: 'yesterday' }))[0], /報告の id か、時差つきの ISO 日時/);
  L.close();
});

test('the report and reports tools write as the calling device, read newest first, and refuse in Japanese', async (t) => {
  const ledger = openLedger(':memory:', { now: handClock().now });
  const key = ledger.issueKey('secretary', { actor: 'human' }).key;
  const server = createServer({ ledger });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }),
  );
  t.after(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    ledger.close();
  });
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    return { res, text: res.content[0].text, data: res.isError ? null : JSON.parse(res.content[0].text) };
  };

  const { data: one } = await call('report', { kind: 'nightly', title: '今夜の見張り', body: '- 遅れなし\n- 閉じ忘れ 1件' });
  assert.equal(one.device, 'secretary');
  assert.equal(one.kind, 'nightly');
  assert.deepEqual(ledger.records(one.id).map((r) => [r.actor, r.device, r.entity]), [['device-key', 'secretary', 'report']]);
  const { data: two } = await call('report', { kind: 'morning', title: '今日', body: '予定は3つ' });

  const { res, data: list } = await call('reports');
  assert.deepEqual(res.structuredContent, list);
  assert.deepEqual(list.reports.map((r) => r.id), [two.id, one.id]);
  assert.equal(list.next_before, null);
  const { data: paged } = await call('reports', { limit: 1 });
  assert.deepEqual(paged.reports.map((r) => r.id), [two.id]);
  assert.equal(paged.next_before, two.id);
  assert.deepEqual((await call('reports', { before: paged.next_before })).data.reports.map((r) => r.id), [one.id]);
  assert.deepEqual((await call('reports', { kind: 'nightly' })).data.reports.map((r) => r.id), [one.id]);

  for (const [name, args, pattern] of [
    ['report', { kind: 'weekly', title: 't', body: 'b' }, /報告の種類/],
    ['report', { kind: 'nightly', title: ' ', body: 'b' }, /題名/],
    ['reports', { limit: 100 }, /1〜50 の整数/],
    ['reports', { before: 'nope' }, /報告の id か/],
  ]) {
    const out = await call(name, args);
    assert.equal(out.res.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(out.text, /^書けませんでした。/);
    assert.match(out.text, pattern);
  }
  assert.equal(ledger.listReports().reports.length, 2);
});
