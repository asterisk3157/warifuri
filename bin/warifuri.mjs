#!/usr/bin/env node
// The warifuri command. The commands are in src/cli.mjs; this file only quiets Node's
// warning that node:sqlite is experimental, which would otherwise come on every run. The
// command is loaded afterwards, since node:sqlite warns as soon as it is loaded.
import { quietSqliteWarning } from '../src/warnings.mjs';

quietSqliteWarning();
await import('../src/cli.mjs');
