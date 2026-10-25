// Tests for devices and their machine keys in the ledger: issuing (which creates the device),
// listing, revoking, looking up by key, and records that never hold the key or its hash.

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

test('key add creates the device; the key is issued once, found by its value and stored only as a hash', (t) => {
  const L = fresh(t);
  assert.deepEqual(L.listDevices(), []);
  const { name, key } = L.issueKey('laptop', ACTOR);
  assert.equal(name, 'laptop');
  assert.match(key, /^wf_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(L.deviceForKey(key), { name: 'laptop' });
  assert.equal(L.deviceForKey(`${key}x`), null);
  assert.equal(L.deviceForKey(''), null);
  assert.equal(L.deviceForKey(undefined), null);

  const other = L.issueKey('desk', ACTOR);
  assert.notEqual(other.key, key);
  assert.deepEqual(L.deviceForKey(other.key), { name: 'desk' });

  const list = L.listDevices();
  assert.deepEqual(list.map((d) => [d.name, d.has_key, d.revoked_at]), [
    ['desk', true, null],
    ['laptop', true, null],
  ]);
  for (const d of list) assert.ok(!('key_hash' in d));
});

test('a device registered without a key gets one with key add', (t) => {
  const L = fresh(t);
  const d = L.addDevice('secretary', ACTOR);
  assert.equal(d.has_key, false);
  assert.deepEqual(L.addDevice('secretary', ACTOR), d); // already there: unchanged
  const { key } = L.issueKey('secretary', ACTOR);
  assert.deepEqual(L.deviceForKey(key), { name: 'secretary' });
  assert.deepEqual(L.records('secretary').map((r) => r.action), ['create', 'key']);
});

test('records say a key was issued and revoked, without key material', (t) => {
  const L = fresh(t);
  const { key } = L.issueKey('laptop', ACTOR);
  L.revokeKey('laptop', ACTOR);
  const recs = L.records('laptop');
  assert.deepEqual(recs.map((r) => [r.entity, r.action, r.actor]), [
    ['device', 'create', 'human'],
    ['device', 'revoke', 'human'],
  ]);
  const text = JSON.stringify(recs);
  assert.ok(!text.includes(key));
  assert.ok(!text.includes(sha256(key)));
});

test('a revoked key stops working, and the device can get a new one', (t) => {
  const L = fresh(t);
  const first = L.issueKey('laptop', ACTOR);
  assert.throws(() => L.issueKey('laptop', ACTOR), /使えるシークレットがもうあります/);
  L.revokeKey('laptop', ACTOR);
  assert.equal(L.deviceForKey(first.key), null);
  const [listed] = L.listDevices();
  assert.equal(listed.has_key, false);
  assert.ok(listed.revoked_at);
  assert.throws(() => L.revokeKey('laptop', ACTOR), LedgerError);

  const second = L.issueKey('laptop', ACTOR);
  assert.equal(L.deviceForKey(first.key), null);
  assert.deepEqual(L.deviceForKey(second.key), { name: 'laptop' });
  assert.equal(L.listDevices()[0].revoked_at, null);
  assert.equal(L.listDevices().length, 1);
});

test('bad names, unknown or revoked devices and a missing actor are refused', (t) => {
  const L = fresh(t);
  for (const bad of ['', 'a b', 'name/with/slash', 'x'.repeat(65), 'ラップトップ', 42]) {
    assert.throws(() => L.issueKey(bad, ACTOR), LedgerError, String(bad));
    assert.throws(() => L.addDevice(bad, ACTOR), LedgerError, String(bad));
  }
  assert.doesNotThrow(() => L.issueKey('x'.repeat(64), ACTOR));
  assert.doesNotThrow(() => L.issueKey('pc-2.home_A', ACTOR));
  assert.throws(() => L.revokeKey('nobody', ACTOR), LedgerError);
  // A device without a key (one made on the consent page) can be revoked, once.
  L.addDevice('nokey', ACTOR);
  assert.equal(L.revokeKey('nokey', ACTOR).oauth_tokens, 0);
  assert.throws(() => L.revokeKey('nokey', ACTOR), /もう取り消されています/);
  assert.throws(() => L.issueKey('noactor', {}), LedgerError);
  assert.equal(L.listDevices().length, 3);
});
