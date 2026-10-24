#!/usr/bin/env node
// Checks that the table in docs/configuration.md is the one made from SETTINGS in
// src/config.mjs, or with --write, puts that table there.
//
//   node scripts/settings-table.mjs           exit 1 when the doc and the code disagree
//   node scripts/settings-table.mjs --write   rewrite the table in the doc

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { settingsTable } from '../src/config.mjs';

const DOC = fileURLToPath(new URL('../docs/configuration.md', import.meta.url));
const START = '<!-- settings:start -->';
const END = '<!-- settings:end -->';

// The doc with the table from the code between the markers.
export function withTable(text) {
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  if (a < 0 || b < a) throw new Error(`${DOC} has no ${START} ... ${END}`);
  return `${text.slice(0, a + START.length)}\n${settingsTable()}\n${text.slice(b)}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = fs.readFileSync(DOC, 'utf8');
  const want = withTable(text);
  if (process.argv[2] === '--write') {
    if (want !== text) fs.writeFileSync(DOC, want);
  } else if (want !== text) {
    process.stderr.write('docs/configuration.md does not match the settings in src/config.mjs; run node scripts/settings-table.mjs --write\n');
    process.exitCode = 1;
  }
}
