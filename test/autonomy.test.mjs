// Tests for the secretary's autonomy (原則13): the fixed list of kinds, outcomes that raise a
// kind after three approvals in a row and bring it back on a revoke, approvals in a goal the
// person leads, the person's own word, the records, and the MCP tools.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openLedger } from '../src/ledger/ledger.mjs';
import { AUTONOMY_KINDS, AUTONOMY_STREAK } from '../src/ledger/rules.mjs';
import { createServer } from '../src/server/mcp.mjs';

const ACTOR = { actor: 'human' };
const SECRETARY = { actor: 'secretary' };

function fresh(t) {
  let tick = 0;
  const L = openLedger(':memory:', { now: () => new Date(Date.parse('2026-10-25T00:00:00Z') + (tick += 1000)) });
  t.after(() => L.close());
  return L;
}

function refuses(fn, pattern) {
  assert.throws(fn, (err) => err.name === 'LedgerError' && err.problems.some((p) => pattern.test(p)));
}

const view = (L, kind) => L.listAutonomy().kinds.find((k) => k.kind === kind);

test('the list shows every kind at ask before anything is written', (t) => {
  const L = fresh(t);
  const list = L.listAutonomy();
  assert.equal(list.streak, 3);
  assert.equal(AUTONOMY_STREAK, 3);
  assert.deepEqual(list.kinds.map((k) => k.kind), AUTONOMY_KINDS.map((k) => k.kind));
  for (const k of list.kinds) {
    assert.equal(k.level, 'ask');
    assert.equal(k.approvals_in_row, 0);
    assert.equal(k.by_person, false);
    assert.ok(k.label.length > 0);
    assert.ok([2, 3].includes(k.stage), k.kind);
  }
  refuses(() => L.setAutonomy('send_mail', { level: 'ask' }, SECRETARY), /send_mail という動きの種類はありません/);
});

test('three approvals in a row raise a kind once; changed or refused starts the run again', (t) => {
  const L = fresh(t);
  const kind = 'close_forgotten';
  assert.equal(L.recordAutonomyOutcome(kind, 'approved', {}, SECRETARY).approvals_in_row, 1);
  const changed = L.recordAutonomyOutcome(kind, 'changed', {}, SECRETARY);
  assert.equal(changed.approvals_in_row, 0);
  assert.equal(changed.level_changed, null);
  L.recordAutonomyOutcome(kind, 'approved', {}, SECRETARY);
  L.recordAutonomyOutcome(kind, 'refused', {}, SECRETARY);
  L.recordAutonomyOutcome(kind, 'approved', {}, SECRETARY);
  const second = L.recordAutonomyOutcome(kind, 'approved', {}, SECRETARY);
  assert.equal(second.level, 'ask');
  assert.equal(second.announce, null);
  const third = L.recordAutonomyOutcome(kind, 'approved', {}, SECRETARY);
  assert.equal(third.level, 'act_then_tell');
  assert.equal(third.level_changed, 'raised');
  assert.match(third.announce, /「閉じ忘れたタスクを閉じる」は3回続けて.*やってから知らせます/);
  // Said once: a further approval keeps the level and announces nothing.
  const fourth = L.recordAutonomyOutcome(kind, 'approved', {}, SECRETARY);
  assert.equal(fourth.level, 'act_then_tell');
  assert.equal(fourth.level_changed, null);
  assert.equal(fourth.announce, null);
  // Other kinds are untouched.
  assert.equal(view(L, 'reschedule_block').level, 'ask');
  refuses(() => L.recordAutonomyOutcome(kind, 'maybe', {}, SECRETARY), /outcome/);
  refuses(() => L.recordAutonomyOutcome('publish', 'approved', {}, SECRETARY), /publish という動きの種類はありません/);
});

test('one revoke after the raise brings the kind back to ask', (t) => {
  const L = fresh(t);
  for (let i = 0; i < 3; i += 1) L.recordAutonomyOutcome('add_knowledge', 'approved', {}, SECRETARY);
  const back = L.recordAutonomyOutcome('add_knowledge', 'revoked', {}, SECRETARY);
  assert.equal(back.level, 'ask');
  assert.equal(back.level_changed, 'lowered');
  assert.equal(back.approvals_in_row, 0);
  assert.equal(back.revokes, 1);
  assert.match(back.announce, /取り消されたので、これからは聞いてから/);
  // Three more approvals raise it again.
  L.recordAutonomyOutcome('add_knowledge', 'approved', {}, SECRETARY);
  L.recordAutonomyOutcome('add_knowledge', 'approved', {}, SECRETARY);
  assert.equal(L.recordAutonomyOutcome('add_knowledge', 'approved', {}, SECRETARY).level_changed, 'raised');
});

test('writing bookings to the calendar is a stage 2 kind that rises after three approvals', (t) => {
  const L = fresh(t);
  const entry = AUTONOMY_KINDS.find((k) => k.kind === 'write_calendar');
  assert.equal(entry.stage, 2);
  assert.equal(entry.label, '予定をカレンダーに書き出す');
  assert.equal(view(L, 'write_calendar').level, 'ask');
  L.recordAutonomyOutcome('write_calendar', 'approved', {}, SECRETARY);
  L.recordAutonomyOutcome('write_calendar', 'approved', {}, SECRETARY);
  const third = L.recordAutonomyOutcome('write_calendar', 'approved', {}, SECRETARY);
  assert.equal(third.level, 'act_then_tell');
  assert.match(third.announce, /「予定をカレンダーに書き出す」は3回続けて/);
  const back = L.recordAutonomyOutcome('write_calendar', 'revoked', {}, SECRETARY);
  assert.equal(back.level, 'ask');
});

test('approvals in a goal the person leads are not counted', (t) => {
  const L = fresh(t);
  const led = L.createGoal({ title: 'Talk', mode: 'ai_worker', human_led: true }, ACTOR);
  const plain = L.createGoal({ title: 'Chores', mode: 'ai_worker' }, ACTOR);
  const task = L.createTask({ title: 'Slides', mode: 'ai_worker', goal_id: led.id }, ACTOR);
  const loose = L.createTask({ title: 'Loose', mode: 'ai_worker' }, ACTOR);
  for (const about of [led.id, task.id, led.id]) {
    const r = L.recordAutonomyOutcome('move_task', 'approved', { about }, SECRETARY);
    assert.equal(r.counted, false);
    assert.match(r.reason, /原則8/);
  }
  assert.equal(view(L, 'move_task').approvals_in_row, 0);
  assert.equal(view(L, 'move_task').level, 'ask');
  assert.equal(L.recordAutonomyOutcome('move_task', 'approved', { about: plain.id }, SECRETARY).approvals_in_row, 1);
  assert.equal(L.recordAutonomyOutcome('move_task', 'approved', { about: loose.id }, SECRETARY).approvals_in_row, 2);
  refuses(() => L.recordAutonomyOutcome('move_task', 'approved', { about: 't_20261025000000_nothin' }, SECRETARY), /というゴールやタスクはありません/);
  // Every outcome is in the record, the uncounted ones too.
  const outcomes = L.records('move_task').map((r) => [r.changes.outcome, r.changes.counted]);
  assert.deepEqual(outcomes, [['approved', false], ['approved', false], ['approved', false], ['approved', true], ['approved', true]]);
});

test("the person's word sets a level whatever the count, and ask holds against approvals", (t) => {
  const L = fresh(t);
  refuses(() => L.setAutonomyByPerson('tidy_inbox', 'act_then_tell', {}, SECRETARY), /人が明示したときだけ/);
  refuses(() => L.setAutonomyByPerson('tidy_inbox', 'act_then_tell', { by_person: false }, SECRETARY), /by_person/);
  assert.equal(view(L, 'tidy_inbox').level, 'ask');
  assert.equal(L.records('tidy_inbox').length, 0);

  const up = L.setAutonomyByPerson('tidy_inbox', 'act_then_tell', { by_person: true, said: 'これは聞かなくていい' }, SECRETARY);
  assert.equal(up.level, 'act_then_tell');
  assert.equal(up.by_person, true);
  refuses(() => L.setAutonomyByPerson('tidy_inbox', 'always', { by_person: true }, SECRETARY), /自律度は ask, act_then_tell/);

  L.recordAutonomyOutcome('reschedule_block', 'approved', {}, SECRETARY);
  L.recordAutonomyOutcome('reschedule_block', 'approved', {}, SECRETARY);
  const held = L.setAutonomyByPerson('reschedule_block', 'ask', { by_person: true, said: 'これは毎回聞いて' }, SECRETARY);
  assert.equal(held.approvals_in_row, 0);
  // Already at ask: the word is still recorded, and the kind now stays at ask.
  const recs = L.records('reschedule_block');
  assert.equal(recs.at(-1).changes.by, 'person');
  assert.equal(recs.at(-1).changes.said, 'これは毎回聞いて');
  for (let i = 0; i < 3; i += 1) L.recordAutonomyOutcome('reschedule_block', 'approved', {}, SECRETARY);
  const after = L.recordAutonomyOutcome('reschedule_block', 'approved', {}, SECRETARY);
  assert.equal(after.level, 'ask');
  assert.equal(after.level_changed, null);
  assert.match(after.reason, /毎回聞いて/);
  // Set back to act_then_tell by the person, then cancelled: the revoke brings it back to ask.
  L.setAutonomyByPerson('reschedule_block', 'act_then_tell', { by_person: true }, SECRETARY);
  const revoked = L.recordAutonomyOutcome('reschedule_block', 'revoked', {}, SECRETARY);
  assert.equal(revoked.level_changed, 'lowered');
  assert.equal(revoked.by_person, false);
  assert.deepEqual(L.records('reschedule_block').map((r) => r.entity), Array(L.records('reschedule_block').length).fill('autonomy'));
});

test('MCP: autonomy lists the kinds, autonomy_outcome and autonomy_set write as the device', async (t) => {
  const ledger = openLedger(':memory:');
  const key = ledger.issueKey('laptop', ACTOR).key;
  const server = createServer({ ledger });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'test', version: '0.0.0' });
  t.after(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    ledger.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    return { res, data: res.isError ? null : JSON.parse(res.content[0].text), text: res.content[0].text };
  };

  const list = await call('autonomy');
  assert.equal(list.data.kinds.length, AUTONOMY_KINDS.length);
  assert.equal(list.data.kinds[0].label, 'ずれた予定の組み直し');

  let last;
  for (let i = 0; i < 3; i += 1) last = await call('autonomy_outcome', { kind: 'bundle_loose_tasks', outcome: 'approved' });
  assert.equal(last.data.level_changed, 'raised');
  assert.deepEqual(ledger.records('bundle_loose_tasks').at(-1).device, 'laptop');

  const refused = await call('autonomy_set', { kind: 'split_knowledge', level: 'act_then_tell' });
  assert.equal(refused.res.isError, true);
  assert.match(refused.text, /^書けませんでした。/);
  assert.match(refused.text, /人が明示したときだけ/);
  const set = await call('autonomy_set', { kind: 'split_knowledge', level: 'act_then_tell', by_person: true, said: 'これは聞かなくていい' });
  assert.equal(set.data.level, 'act_then_tell');
  const unknown = await call('autonomy_outcome', { kind: 'send_mail', outcome: 'approved' });
  assert.equal(unknown.res.isError, true);
});
