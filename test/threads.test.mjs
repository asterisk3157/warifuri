// Tests for the conversation's data: the version 8 schema (threads, messages, records naming
// them), the ledger's threads, messages and proposals, the answer of a proposal going to
// autonomy_outcome, and the propose / proposals / proposal_done tools. The chat runner is in
// chat.test.mjs, the 秘書 screen's endpoints in web.test.mjs.

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
import { MESSAGE_MAX } from '../src/ledger/rules.mjs';
import { createServer } from '../src/server/mcp.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warifuri-threads-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const WEB = { actor: 'web', device: null };
const SECRETARY = { actor: 'device-key', device: 'secretary' };

// A clock that moves 1 ms on every read, so rows keep the order they were made in.
const ticking = () => {
  let tick = 0;
  return () => new Date(Date.parse('2026-10-25T03:00:00Z') + (tick += 1));
};

const problemsOf = (fn) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof LedgerError) return err.problems;
    throw err;
  }
  assert.fail('expected a LedgerError');
};

test('schema: a version 7 file gains threads and messages and keeps its records', () => {
  const file = path.join(tmp, 'v7.sqlite');
  const raw = new DatabaseSync(file);
  raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const m of MIGRATIONS.slice(0, 7)) raw.exec(m);
  raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '7')").run();
  const ins = raw.prepare('INSERT INTO records (at, actor, device, entity, entity_id, action, changes) VALUES (?, ?, ?, ?, ?, ?, ?)');
  ins.run('2026-10-01T00:00:00.000Z', 'device-key', 'secretary', 'report', 'r1', 'create', '{}');
  assert.throws(() => ins.run('2026-10-02T00:00:00.000Z', 'web', null, 'message', 'm1', 'create', '{}'), /CHECK/);
  raw.close();

  assert.equal(SCHEMA_VERSION, 10);
  const L = openLedger(file, { now: ticking() });
  assert.deepEqual(L.records('r1').map((r) => [r.id, r.entity]), [[1, 'report']]);
  const thread = L.ensureThread('secretary', WEB);
  assert.match(thread.id, /^c_\d{14}_[a-z0-9]{6}$/);
  assert.equal(thread.runner, 'resume');
  const m = L.addMessage(thread.id, { role: 'user', body: 'おはよう' }, WEB);
  assert.match(m.id, /^m_\d{14}_[a-z0-9]{6}$/);
  assert.deepEqual(L.records(thread.id).map((r) => r.entity), ['thread']);
  assert.deepEqual(L.records(m.id).map((r) => [r.entity, r.action, r.actor]), [['message', 'create', 'web']]);
  L.close();

  const check = new DatabaseSync(file);
  assert.equal(check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, String(SCHEMA_VERSION));
  assert.equal(check.prepare("SELECT 1 FROM sqlite_master WHERE name = 'records_v7'").get(), undefined);
  assert.throws(() => check.exec('DELETE FROM records WHERE id = 1'), /append-only/);
  // One thread of a kind, and a proposal always has a state (and a message none).
  assert.throws(() => check.prepare("INSERT INTO threads (id, kind, title, created_at, updated_at) VALUES ('c_x', 'secretary', 't', 'x', 'x')").run(), /UNIQUE/);
  assert.throws(
    () => check.prepare(`INSERT INTO messages (id, thread_id, role, kind, body, actor, created_at) VALUES ('m_x', '${thread.id}', 'secretary', 'proposal', 'b', 'a', 'x')`).run(),
    /CHECK/,
  );
  check.close();
});

test('messages: one secretary thread, tidy text, refusals in Japanese, read newest or after one', () => {
  const L = openLedger(':memory:', { now: ticking() });
  const t = L.ensureThread('secretary', WEB);
  assert.equal(L.ensureThread('secretary', WEB).id, t.id);
  assert.equal(L.getThread().id, t.id);
  const a = L.addMessage(t.id, { role: 'user', body: '  一行目\r\n二行目  ' }, WEB);
  assert.equal(a.body, '一行目\n二行目');
  assert.equal(a.kind, 'text');
  assert.equal(a.state, null);
  assert.ok(problemsOf(() => L.addMessage(t.id, { role: 'user', body: ' ' }, WEB)).some((p) => /本文/.test(p)));
  assert.ok(problemsOf(() => L.addMessage(t.id, { role: 'user', body: 'あ'.repeat(MESSAGE_MAX + 1) }, WEB)).some((p) => /4000 文字まで/.test(p)));
  assert.ok(problemsOf(() => L.addMessage(t.id, { role: 'user', body: 'a\u0007b' }, WEB)).some((p) => /制御文字/.test(p)));
  assert.ok(problemsOf(() => L.addMessage(t.id, { role: 'boss', body: 'x' }, WEB)).some((p) => /role/.test(p)));
  assert.ok(problemsOf(() => L.addMessage('c_20261025000000_nothin', { role: 'user', body: 'x' }, WEB)).some((p) => /会話はありません/.test(p)));
  // The secretary's reply may be longer than the person's message.
  L.addMessage(t.id, { role: 'secretary', body: 'い'.repeat(MESSAGE_MAX + 1) }, SECRETARY);
  const c = L.addMessage(t.id, { role: 'system', body: 'お知らせ' }, SECRETARY);
  assert.deepEqual(L.listMessages(t.id, { limit: 2 }).map((m) => m.role), ['secretary', 'system']);
  assert.deepEqual(L.listMessages(t.id, { after: a.id }).map((m) => m.role), ['secretary', 'system']);
  assert.deepEqual(L.listMessages(t.id, { after: c.id }), []);
  assert.ok(problemsOf(() => L.listMessages(t.id, { limit: 0 })).length);

  // Switching the runner keeps the messages and the session id.
  L.updateThread(t.id, { session_id: '6f1c2b7e-0000-4000-8000-000000000001', seen_until: c.id }, SECRETARY);
  const moved = L.updateThread(t.id, { runner: 'resident' }, SECRETARY);
  assert.equal(moved.session_id, '6f1c2b7e-0000-4000-8000-000000000001');
  assert.equal(moved.seen_until, c.id);
  assert.equal(L.listMessages(t.id).length, 3);
  assert.ok(problemsOf(() => L.updateThread(t.id, { runner: 'daemon' }, SECRETARY)).some((p) => /runner/.test(p)));
  assert.ok(problemsOf(() => L.updateThread(t.id, { session_id: 'a b' }, SECRETARY)).length);
  assert.deepEqual(L.records(t.id).map((r) => r.action), ['create', 'update', 'update']);
  L.close();
});

test('proposals: made, answered once, recorded as autonomy_outcome with a note in the thread, then done', () => {
  const L = openLedger(':memory:', { now: ticking() });
  const goal = L.createGoal({ title: 'Thesis', mode: 'ai_worker' }, WEB);
  const led = L.createGoal({ title: 'Mine', mode: 'ai_worker', human_led: true }, WEB);
  const task = L.createTask({ title: 'Old one', mode: 'ai_worker', goal_id: goal.id }, WEB);
  assert.ok(problemsOf(() => L.propose({ kind: 'fly', title: 'x', body: 'y' }, SECRETARY)).some((p) => /案の種類/.test(p)));
  assert.ok(problemsOf(() => L.propose({ kind: 'close_forgotten', title: 'a\nb', body: 'y' }, SECRETARY)).some((p) => /1行/.test(p)));
  assert.ok(problemsOf(() => L.propose({ kind: 'close_forgotten', title: 'x', body: 'y', about: 't_20261025000000_nothin' }, SECRETARY)).some((p) => /ありません/.test(p)));
  assert.equal(L.getThread(), null, 'a refused proposal makes no thread');

  const make = (about) => L.propose({ kind: 'close_forgotten', title: '閉じ忘れを閉じる', body: '記録から閉じます。', about }, SECRETARY);
  const p1 = make(task.id);
  assert.equal(p1.state, 'open');
  assert.equal(p1.role, 'secretary');
  assert.equal(p1.device, 'secretary');
  assert.deepEqual(L.listProposals({ which: 'open' }).map((p) => p.id), [p1.id]);
  assert.deepEqual(L.listProposals(), []);

  assert.ok(problemsOf(() => L.answerProposal(p1.id, { answer: 'changed' }, WEB)).some((p) => /どう直すか/.test(p)));
  assert.ok(problemsOf(() => L.answerProposal(p1.id, { answer: 'maybe' }, WEB)).length);
  const r1 = L.answerProposal(p1.id, { answer: 'changed', said: '来週にして' }, WEB);
  assert.equal(r1.proposal.state, 'changed');
  assert.equal(r1.proposal.answer, '来週にして');
  assert.equal(r1.outcome.outcome, 'changed');
  assert.equal(r1.message.role, 'system');
  assert.match(r1.message.body, /直して了承されました。\n本人の言葉: 来週にして/);
  assert.ok(problemsOf(() => L.answerProposal(p1.id, { answer: 'approved' }, WEB)).some((p) => /もう答えています/.test(p)));
  const outcome = L.records('close_forgotten').at(-1);
  assert.equal(outcome.entity, 'autonomy');
  assert.equal(outcome.actor, 'web');
  assert.deepEqual([outcome.changes.outcome, outcome.changes.about], ['changed', task.id]);

  // Three plain approvals in a row raise the kind, and the note in the thread says so.
  const answers = [make(task.id), make(goal.id), make()].map((p) => L.answerProposal(p.id, { answer: 'approved' }, WEB));
  assert.equal(answers[2].outcome.level_changed, 'raised');
  assert.match(answers[2].message.body, /これからはやってから知らせます/);
  // An approval in a goal the person leads is not counted (原則8).
  const inLed = L.answerProposal(L.propose({ kind: 'move_task', title: '移す', body: 'b', about: led.id }, SECRETARY).id, { answer: 'approved' }, WEB);
  assert.equal(inLed.outcome.counted, false);
  // A refusal may carry words or not.
  const no = L.answerProposal(make().id, { answer: 'refused' }, WEB);
  assert.equal(no.proposal.answer, null);

  // To do: the approved and changed ones not carried out yet, oldest first.
  const toDo = L.listProposals();
  assert.deepEqual(toDo.map((p) => p.id), [p1.id, ...answers.map((a) => a.proposal.id), inLed.proposal.id]);
  const done = L.markProposalDone(p1.id, { note: '来週の月曜に動かした' }, SECRETARY);
  assert.ok(done.done_at);
  assert.equal(done.done_note, '来週の月曜に動かした');
  assert.equal(L.listProposals().length, 4);
  assert.ok(problemsOf(() => L.markProposalDone(p1.id, {}, SECRETARY)).some((p) => /もう行った印/.test(p)));
  assert.ok(problemsOf(() => L.markProposalDone(no.proposal.id, {}, SECRETARY)).some((p) => /了承された案だけ/.test(p)));
  assert.equal(L.listProposals({ which: 'recent', limit: 1 })[0].id, no.proposal.id);
  assert.deepEqual(L.records(p1.id).map((r) => r.action), ['create', 'answer', 'done']);
  L.close();
});

test('the propose, proposals and proposal_done tools write as the calling device', async (t) => {
  const ledger = openLedger(':memory:', { now: ticking() });
  const { key } = ledger.issueKey('secretary', WEB);
  const server = createServer({ ledger });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  }));
  t.after(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    ledger.close();
  });
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    return res.isError ? { error: res.content[0].text } : JSON.parse(res.content[0].text);
  };
  const made = await call('propose', { kind: 'reschedule_block', title: '予定を明日へ', body: '今日の 15:00 は埋まりました。明日の 10:00 をすすめます。' });
  assert.equal(made.device, 'secretary');
  assert.equal(made.actor, 'device-key');
  assert.match((await call('propose', { kind: 'reschedule_block', title: '', body: 'b' })).error, /題名/);
  assert.deepEqual((await call('proposals')).proposals, []);
  assert.equal((await call('proposals', { which: 'open' })).proposals[0].id, made.id);
  ledger.answerProposal(made.id, { answer: 'approved' }, WEB);
  const [toDo] = (await call('proposals')).proposals;
  assert.deepEqual([toDo.id, toDo.state, toDo.done_at], [made.id, 'approved', null]);
  assert.equal((await call('proposal_done', { id: made.id, note: '明日の 10:00 に動かした' })).done_note, '明日の 10:00 に動かした');
  assert.deepEqual((await call('proposals')).proposals, []);
  assert.match((await call('proposal_done', { id: made.id })).error, /もう行った印/);
});
