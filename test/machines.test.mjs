// Tests for machine keys in the ledger: issuing, listing, revoking, looking up by key,
// and records that never hold the key or its hash.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openLedger, LedgerError } from '../src/ledger/ledger.mjs';

const ACTOR = { actor: 'human' };
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function fresh(t) {
  const L = openLedger(':memory:');
  t.after(() => L.close());
  return L;
}

test('a key is issued once, found by its value and stored only as a hash', (t) => {
  const L = fresh(t);
  const { name, key } = L.addMachine('laptop', {}, ACTOR);
  assert.equal(name, 'laptop');
  assert.match(key, /^wf_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(L.machineForKey(key), { name: 'laptop', read_withheld: false });
  assert.equal(L.machineForKey(`${key}x`), null);
  assert.equal(L.machineForKey(''), null);
  assert.equal(L.machineForKey(undefined), null);

  const reader = L.addMachine('desk', { readWithheld: true }, ACTOR);
  assert.notEqual(reader.key, key);
  assert.deepEqual(L.machineForKey(reader.key), { name: 'desk', read_withheld: true });

  const list = L.listMachines();
  assert.deepEqual(list.map((m) => [m.name, m.read_withheld, m.revoked_at]), [
    ['desk', true, null],
    ['laptop', false, null],
  ]);
  for (const m of list) assert.ok(!('key_hash' in m));
});

test('records say a machine was added and revoked, without key material', (t) => {
  const L = fresh(t);
  const { key } = L.addMachine('laptop', { readWithheld: true }, ACTOR);
  L.revokeMachine('laptop', ACTOR);
  const recs = L.records('laptop');
  assert.deepEqual(recs.map((r) => [r.entity, r.action, r.actor]), [
    ['machine', 'create', 'human'],
    ['machine', 'revoke', 'human'],
  ]);
  const text = JSON.stringify(recs);
  assert.ok(!text.includes(key));
  assert.ok(!text.includes(sha256(key)));
});

test('a revoked key stops working, and the name can be issued again', (t) => {
  const L = fresh(t);
  const first = L.addMachine('laptop', {}, ACTOR);
  L.revokeMachine('laptop', ACTOR);
  assert.equal(L.machineForKey(first.key), null);
  assert.ok(L.listMachines()[0].revoked_at);
  assert.throws(() => L.revokeMachine('laptop', ACTOR), LedgerError);

  const second = L.addMachine('laptop', {}, ACTOR);
  assert.equal(L.machineForKey(first.key), null);
  assert.deepEqual(L.machineForKey(second.key), { name: 'laptop', read_withheld: false });
  assert.equal(L.listMachines()[0].revoked_at, null);
});

test('duplicate names, bad names, unknown machines and a missing actor are refused', (t) => {
  const L = fresh(t);
  L.addMachine('laptop', {}, ACTOR);
  assert.throws(() => L.addMachine('laptop', {}, ACTOR), /もうあります/);
  for (const bad of ['', 'a b', 'name/with/slash', 'x'.repeat(65), 'ラップトップ', 42]) {
    assert.throws(() => L.addMachine(bad, {}, ACTOR), LedgerError, String(bad));
  }
  assert.doesNotThrow(() => L.addMachine('x'.repeat(64), {}, ACTOR));
  assert.doesNotThrow(() => L.addMachine('pc-2.home_A', {}, ACTOR));
  assert.throws(() => L.addMachine('other', { readWithheld: 'yes' }, ACTOR), LedgerError);
  assert.throws(() => L.revokeMachine('nobody', ACTOR), LedgerError);
  assert.throws(() => L.addMachine('noactor', {}, {}), LedgerError);
  assert.equal(L.listMachines().length, 3);
});
