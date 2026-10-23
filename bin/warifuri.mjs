#!/usr/bin/env node
// The warifuri command. Thin: it reads arguments and files, calls the ledger, prints.
//
//   warifuri import <snapshot.json> --db <ledger.sqlite> [--actor <name>]
//   warifuri key add <name> --db <ledger.sqlite> [--read-withheld]
//   warifuri key list --db <ledger.sqlite>
//   warifuri key revoke <name> --db <ledger.sqlite>
//   warifuri serve --db <ledger.sqlite> [--host 127.0.0.1] [--port 8787]
//
// Exit codes: 0 done (even when rows were flagged or skipped), 1 the snapshot or the ledger
// could not be read, the snapshot's envelope is wrong or the ledger refused, 2 the command
// line is wrong.

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { openLedger, LedgerError } from '../src/ledger/ledger.mjs';
import { createServer } from '../src/server/mcp.mjs';

const USAGE = [
  'usage: warifuri import <snapshot.json> --db <ledger.sqlite> [--actor <name>]',
  '       warifuri key add <name> --db <ledger.sqlite> [--read-withheld]',
  '       warifuri key list --db <ledger.sqlite>',
  '       warifuri key revoke <name> --db <ledger.sqlite>',
  '       warifuri serve --db <ledger.sqlite> [--host 127.0.0.1] [--port 8787]',
  '',
  'serve listens on 127.0.0.1 unless --host says otherwise. Listening beyond this machine',
  'is your choice; the machine keys are then the only guard, so put HTTPS in front.',
].join('\n');

function usage(message) {
  if (message) process.stderr.write(`warifuri: ${message}\n`);
  process.stderr.write(`${USAGE}\n`);
  return 2;
}

function runImport(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: { db: { type: 'string' }, actor: { type: 'string', default: 'import' } },
    });
  } catch (err) {
    return usage(err.message);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) return usage('give exactly one snapshot file');
  if (!values.db) return usage('--db is required');
  if (values.actor.trim() === '') return usage('--actor must not be empty');

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(positionals[0], 'utf8'));
  } catch (err) {
    process.stderr.write(`warifuri: cannot read ${positionals[0]}: ${err.message}\n`);
    return 1;
  }

  let ledger;
  try {
    ledger = openLedger(values.db);
    const res = ledger.replaceFromSnapshot(doc, { actor: values.actor });
    const c = res.counts;
    const out = [
      `imported: ${c.places} places, ${c.goals} goals, ${c.tasks} tasks, ${c.blocks} blocks`,
      `flagged for review: ${res.flagged.length}`,
      `skipped: ${res.skipped.length}`,
      ...res.skipped.map((s) => `  ${s.kind} ${s.id}: ${s.problems.join(' / ')}`),
    ];
    if (res.detached_habits.length) out.push(`habits whose goal is gone (link removed): ${res.detached_habits.join(', ')}`);
    process.stdout.write(`${out.join('\n')}\n`);
    return 0;
  } catch (err) {
    const detail = err instanceof LedgerError ? err.problems.join('\n  ') : err.message;
    process.stderr.write(`warifuri: nothing was imported:\n  ${detail}\n`);
    return 1;
  } finally {
    ledger?.close();
  }
}

function fail(err, what) {
  const detail = err instanceof LedgerError ? err.problems.join('\n  ') : err.message;
  process.stderr.write(`warifuri: ${what}:\n  ${detail}\n`);
  return 1;
}

// warifuri key add|list|revoke. The actor in the records is the person at this command line.
function runKey(args) {
  const [sub, ...rest] = args;
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { db: { type: 'string' }, 'read-withheld': { type: 'boolean', default: false } },
    });
  } catch (err) {
    return usage(err.message);
  }
  const { values, positionals } = parsed;
  if (!['add', 'list', 'revoke'].includes(sub)) return usage('key takes add, list or revoke');
  if (!values.db) return usage('--db is required');
  if (sub === 'list' && positionals.length !== 0) return usage('key list takes no name');
  if (sub !== 'list' && positionals.length !== 1) return usage(`key ${sub} takes one machine name`);
  if (sub !== 'add' && values['read-withheld']) return usage('--read-withheld goes with key add');

  let ledger;
  try {
    ledger = openLedger(values.db);
    if (sub === 'add') {
      const { name, key } = ledger.addMachine(positionals[0], { readWithheld: values['read-withheld'] }, { actor: 'cli' });
      process.stdout.write(`key for ${name}:\n${key}\nThis key will not be shown again. Keep it in that machine's settings.\n`);
    } else if (sub === 'revoke') {
      ledger.revokeMachine(positionals[0], { actor: 'cli' });
      process.stdout.write(`revoked: ${positionals[0]}\n`);
    } else {
      const rows = ledger.listMachines();
      if (rows.length === 0) process.stdout.write('no machines\n');
      for (const m of rows) {
        const flags = [m.read_withheld ? 'reads withheld' : null, m.revoked_at ? `revoked ${m.revoked_at}` : null].filter(Boolean);
        process.stdout.write(`${m.name}  added ${m.created_at}${flags.length ? `  (${flags.join(', ')})` : ''}\n`);
      }
    }
    return 0;
  } catch (err) {
    return fail(err, `key ${sub} failed`);
  } finally {
    ledger?.close();
  }
}

// warifuri serve: keeps running until SIGINT or SIGTERM, so it returns no exit code itself.
function runServe(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { db: { type: 'string' }, host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '8787' } },
    });
  } catch (err) {
    return usage(err.message);
  }
  const { values } = parsed;
  if (!values.db) return usage('--db is required');
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return usage('--port must be a number from 0 to 65535');

  let ledger;
  try {
    ledger = openLedger(values.db);
  } catch (err) {
    return fail(err, `cannot open ${values.db}`);
  }
  const server = createServer({ ledger });
  server.on('error', (err) => {
    process.stderr.write(`warifuri: cannot listen: ${err.message}\n`);
    ledger.close();
    process.exitCode = 1;
  });
  server.listen(port, values.host, () => {
    const addr = server.address();
    const host = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
    process.stdout.write(`warifuri: serving http://${host}:${addr.port}/mcp\n`);
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => {
      ledger.close();
      process.stdout.write('warifuri: stopped\n');
    });
    server.closeAllConnections();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return undefined;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'import') return runImport(rest);
  if (command === 'key') return runKey(rest);
  if (command === 'serve') return runServe(rest);
  if (command === undefined || command === '--help' || command === '-h') return usage();
  return usage(`unknown command: ${command}`);
}

const code = main(process.argv.slice(2));
if (code !== undefined) process.exitCode = code;
