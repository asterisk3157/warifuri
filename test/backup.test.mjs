// Tests for backups (src/ledger/backup.mjs) and the `warifuri backup` and `warifuri key`
// commands.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLedger } from '../src/ledger/ledger.mjs';
import { backupLedger, backupName, listBackups } from '../src/ledger/backup.mjs';
import { cli } from './cli.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warifuri-backup-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function ledgerFile() {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'case-'));
  const db = path.join(dir, 'ledger.sqlite');
  const L = openLedger(db);
  L.createGoal({ title: 'Kept in the backup', mode: 'ai_worker' }, { actor: 'human' });
  L.close();
  return { dir, db };
}

test('backup names are UTC and sort by time', () => {
  assert.equal(backupName(new Date('2026-10-24T01:02:03Z')), 'ledger-20261024-010203.sqlite');
});

test('a backup is a readable copy; only the newest N stay', () => {
  const { dir, db } = ledgerFile();
  const out = path.join(dir, 'backups');
  const first = backupLedger(db, out, { keep: 2, now: new Date('2026-10-20T00:00:00Z') });
  assert.equal(path.basename(first.file), 'ledger-20261020-000000.sqlite');
  const copy = openLedger(first.file);
  assert.equal(copy.search('Kept')[0].title, 'Kept in the backup');
  copy.close();

  fs.writeFileSync(path.join(out, 'notes.txt'), 'not a backup');
  fs.writeFileSync(path.join(out, 'ledger-old.sqlite'), 'not a dated name');
  backupLedger(db, out, { keep: 2, now: new Date('2026-10-21T00:00:00Z') });
  const third = backupLedger(db, out, { keep: 2, now: new Date('2026-10-22T00:00:00Z') });
  assert.deepEqual(third.removed.map((f) => path.basename(f)), ['ledger-20261020-000000.sqlite']);
  assert.deepEqual(listBackups(out), ['ledger-20261022-000000.sqlite', 'ledger-20261021-000000.sqlite']);
  assert.ok(fs.existsSync(path.join(out, 'notes.txt')));
  assert.ok(fs.existsSync(path.join(out, 'ledger-old.sqlite')));

  assert.throws(() => backupLedger(db, out, { keep: 2, now: new Date('2026-10-22T00:00:00Z') }), /already exists/);
  assert.throws(() => backupLedger(path.join(dir, 'missing.sqlite'), out), /no ledger/);
  assert.throws(() => backupLedger(db, out, { keep: 0 }), /keep/);
});

test('cli: warifuri backup', () => {
  const { dir, db } = ledgerFile();
  const out = path.join(dir, 'b');
  const ok = cli(['backup', '--db', db, '--dir', out, '--keep', '1']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /backup: .*ledger-\d{8}-\d{6}\.sqlite/);
  assert.equal(listBackups(out).length, 1);
  assert.equal(cli(['backup', '--db', db]).status, 2);
  // Without --db the ledger is the one in the data directory; here there is none.
  const home = path.join(dir, 'home');
  const none = cli(['backup', '--dir', out], { home });
  assert.equal(none.status, 1);
  assert.ok(none.stderr.includes(path.join(home, 'ledger.sqlite')), none.stderr);
  assert.equal(cli(['backup', '--db', db, '--dir', out, '--keep', '0']).status, 2);
  assert.equal(cli(['backup', '--db', path.join(dir, 'none.sqlite'), '--dir', out]).status, 1);
});

test('cli: warifuri key add, list and revoke', () => {
  const { db } = ledgerFile();
  const added = cli(['key', 'add', 'laptop', '--db', db]);
  assert.equal(added.status, 0, added.stderr);
  const key = added.stdout.split('\n')[1];
  assert.match(key, /^wf_/);
  const L = openLedger(db);
  try {
    assert.deepEqual(L.deviceForKey(key), { name: 'laptop' });
  } finally {
    L.close();
  }
  assert.match(cli(['key', 'list', '--db', db]).stdout, /laptop {2}added .* \(key in use\)/);
  assert.equal(cli(['key', 'add', 'laptop', '--db', db]).status, 1);
  assert.equal(cli(['key', 'revoke', 'laptop', '--db', db]).status, 0);
  assert.match(cli(['key', 'list', '--db', db]).stdout, /laptop {2}added .* \(revoked /);
  assert.equal(cli(['key', 'add', 'laptop', '--db', db, '--read-withheld']).status, 2);
  assert.equal(cli(['key', 'add', '--db', db]).status, 2);
});
