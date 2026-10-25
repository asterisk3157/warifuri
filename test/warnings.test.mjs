// The CLI drops Node's experimental warning for node:sqlite, and only that one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { CLI, cliEnv } from './cli.mjs';
import { isSqliteWarning, quietSqliteWarning } from '../src/warnings.mjs';

test('the CLI prints no SQLite warning, without --no-warnings', () => {
  const r = spawnSync(process.execPath, [CLI, 'key', 'list'], { encoding: 'utf8', env: cliEnv(), timeout: 10_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'no devices\n');
  assert.doesNotMatch(r.stderr, /SQLite|ExperimentalWarning/);
});

test('only the SQLite experimental warning is dropped', () => {
  assert.equal(isSqliteWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning'), true);
  assert.equal(isSqliteWarning('SQLite is an experimental feature', { type: 'ExperimentalWarning' }), true);
  const named = Object.assign(new Error('SQLite is an experimental feature'), { name: 'ExperimentalWarning' });
  assert.equal(isSqliteWarning(named), true);
  assert.equal(isSqliteWarning('SQLite is an experimental feature'), false);
  assert.equal(isSqliteWarning('SQLite something', 'DeprecationWarning'), false);
  assert.equal(isSqliteWarning('The Fetch API is an experimental feature', 'ExperimentalWarning'), false);
  assert.equal(isSqliteWarning(undefined), false);

  const seen = [];
  const proc = { emitWarning: (...args) => seen.push(args) };
  quietSqliteWarning(proc);
  proc.emitWarning('SQLite is an experimental feature', 'ExperimentalWarning');
  proc.emitWarning('VM Modules is an experimental feature', 'ExperimentalWarning');
  proc.emitWarning('old', 'DeprecationWarning', 'DEP0001');
  assert.deepEqual(seen, [
    ['VM Modules is an experimental feature', 'ExperimentalWarning'],
    ['old', 'DeprecationWarning', 'DEP0001'],
  ]);
});
