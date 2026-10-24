// Backups of the ledger file: VACUUM INTO a dated copy, then keep only the newest few.
// The copy is taken through a read-only connection, so a server holding the ledger open
// keeps running. Names are ledger-YYYYMMDD-HHMMSS.sqlite in UTC, so they sort by time and
// mean the same on every machine. Only files with exactly that shape are ever removed.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const BACKUP_NAME = /^ledger-\d{8}-\d{6}\.sqlite$/;

const pad = (n) => String(n).padStart(2, '0');

export function backupName(date) {
  return (
    `ledger-${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}.sqlite`
  );
}

// Backup file names in dir, newest first.
export function listBackups(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => BACKUP_NAME.test(name))
    .sort()
    .reverse();
}

// Copies the ledger at dbPath into dir and removes all but the newest `keep` backups there.
// Returns { file, removed }. Throws when the ledger is missing or the dated file exists.
export function backupLedger(dbPath, dir, { keep = 7, now = new Date() } = {}) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('keep must be a whole number of 1 or more');
  if (!fs.existsSync(dbPath)) throw new Error(`no ledger at ${dbPath}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, backupName(now));
  if (fs.existsSync(file)) throw new Error(`${file} already exists`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.prepare('VACUUM INTO ?').run(file);
  } finally {
    db.close();
  }
  const removed = listBackups(dir).slice(keep).map((name) => path.join(dir, name));
  for (const old of removed) fs.rmSync(old);
  return { file, removed };
}
