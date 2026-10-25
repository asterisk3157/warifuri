// The usage text of the warifuri command.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cli } from './cli.mjs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('--version and -v print the package version on stdout and exit 0', () => {
  for (const flag of ['--version', '-v']) {
    const r = cli([flag]);
    assert.equal(r.status, 0, flag);
    assert.equal(r.stdout, `${pkg.version}\n`, flag);
    assert.equal(r.stderr, '', flag);
  }
});

test('--help and -h print the usage on stdout and exit 0; no command is an error', () => {
  for (const flag of ['--help', '-h']) {
    const r = cli([flag]);
    assert.equal(r.status, 0, flag);
    assert.match(r.stdout, /^usage: warifuri init/, flag);
    assert.equal(r.stderr, '', flag);
  }
  const none = cli([]);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /^usage: warifuri init/);
  const unknown = cli(['nope']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown command: nope/);
});
