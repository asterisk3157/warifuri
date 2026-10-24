#!/usr/bin/env node
// The warifuri command. Thin: it reads arguments and files, calls the ledger, prints.
//
//   warifuri import <snapshot.json> --db <ledger.sqlite> [--actor <name>]
//   warifuri key add <device> --db <ledger.sqlite>
//   warifuri key list --db <ledger.sqlite>
//   warifuri key revoke <device> --db <ledger.sqlite>
//   warifuri backup --db <ledger.sqlite> --dir <dir> [--keep 7]
//   warifuri oauth clients --db <ledger.sqlite>
//   warifuri oauth revoke <client_id> --db <ledger.sqlite>
//   warifuri serve --db <ledger.sqlite> [--host 127.0.0.1] [--port 8787]
//                  [--public-url <url>] [--github-user <login>]
//
// serve turns on the GitHub login when the public URL, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
// and the GitHub user are all set (flags win over WARIFURI_PUBLIC_URL and WARIFURI_GITHUB_USER;
// the GitHub values come from the environment only). Otherwise only device keys work.
//
// Exit codes: 0 done (even when rows were flagged or skipped), 1 the snapshot or the ledger
// could not be read, the snapshot's envelope is wrong, the ledger refused or the backup
// failed, 2 the command line is wrong.

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { openLedger, LedgerError } from '../src/ledger/ledger.mjs';
import { createServer } from '../src/server/mcp.mjs';
import { oauthConfig } from '../src/server/oauth.mjs';
import { backupLedger } from '../src/ledger/backup.mjs';

const USAGE = [
  'usage: warifuri import <snapshot.json> --db <ledger.sqlite> [--actor <name>]',
  '       warifuri key add <device> --db <ledger.sqlite>',
  '       warifuri key list --db <ledger.sqlite>',
  '       warifuri key revoke <device> --db <ledger.sqlite>',
  '       warifuri backup --db <ledger.sqlite> --dir <dir> [--keep 7]',
  '       warifuri oauth clients --db <ledger.sqlite>',
  '       warifuri oauth revoke <client_id> --db <ledger.sqlite>',
  '       warifuri serve --db <ledger.sqlite> [--host 127.0.0.1] [--port 8787]',
  '                      [--public-url <url>] [--github-user <login>]',
  '',
  'serve listens on 127.0.0.1 unless --host says otherwise. Listening beyond this machine',
  'is your choice; the GitHub login and the device keys are then the only guard, so put',
  'HTTPS in front. The GitHub login needs the public URL (or WARIFURI_PUBLIC_URL), the',
  'GitHub user (or WARIFURI_GITHUB_USER), GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.',
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

// warifuri key add|list|revoke. add creates the device when it is new. The actor in the
// records is the person at this command line.
function runKey(args) {
  const [sub, ...rest] = args;
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { db: { type: 'string' } },
    });
  } catch (err) {
    return usage(err.message);
  }
  const { values, positionals } = parsed;
  if (!['add', 'list', 'revoke'].includes(sub)) return usage('key takes add, list or revoke');
  if (!values.db) return usage('--db is required');
  if (sub === 'list' && positionals.length !== 0) return usage('key list takes no name');
  if (sub !== 'list' && positionals.length !== 1) return usage(`key ${sub} takes one device name`);

  let ledger;
  try {
    ledger = openLedger(values.db);
    if (sub === 'add') {
      const { name, key } = ledger.issueKey(positionals[0], { actor: 'cli' });
      process.stdout.write(`key for ${name}:\n${key}\nThis key will not be shown again. Keep it in that device's settings.\n`);
    } else if (sub === 'revoke') {
      ledger.revokeKey(positionals[0], { actor: 'cli' });
      process.stdout.write(`revoked: ${positionals[0]}\n`);
    } else {
      const rows = ledger.listDevices();
      if (rows.length === 0) process.stdout.write('no devices\n');
      for (const d of rows) {
        const state = d.has_key ? 'key in use' : d.revoked_at ? `key revoked ${d.revoked_at}` : 'no key';
        process.stdout.write(`${d.name}  added ${d.created_at}  (${state})\n`);
      }
    }
    return 0;
  } catch (err) {
    return fail(err, `key ${sub} failed`);
  } finally {
    ledger?.close();
  }
}

// warifuri oauth clients|revoke. revoke ends every token of a client; the client stays
// registered and has to ask the person again.
function runOAuth(args) {
  const [sub, ...rest] = args;
  let parsed;
  try {
    parsed = parseArgs({ args: rest, allowPositionals: true, options: { db: { type: 'string' } } });
  } catch (err) {
    return usage(err.message);
  }
  const { values, positionals } = parsed;
  if (!['clients', 'revoke'].includes(sub)) return usage('oauth takes clients or revoke');
  if (!values.db) return usage('--db is required');
  if (sub === 'clients' && positionals.length !== 0) return usage('oauth clients takes no argument');
  if (sub === 'revoke' && positionals.length !== 1) return usage('oauth revoke takes one client id');

  let ledger;
  try {
    ledger = openLedger(values.db);
    if (sub === 'revoke') {
      const out = ledger.oauth.revokeClient(positionals[0], { actor: 'cli' });
      if (!out) {
        process.stderr.write(`warifuri: no OAuth client ${positionals[0]}\n`);
        return 1;
      }
      process.stdout.write(`revoked ${out.revoked} token${out.revoked === 1 ? '' : 's'} of ${out.client_id}\n`);
    } else {
      const rows = ledger.oauth.listClients();
      if (rows.length === 0) process.stdout.write('no OAuth clients\n');
      for (const c of rows) {
        const devices = c.devices.length ? `in use by ${c.devices.join(', ')}` : 'no live tokens';
        process.stdout.write(`${c.client_id}  ${c.client_name ?? '(no name)'}  registered ${c.created_at}  (${devices})\n`);
      }
    }
    return 0;
  } catch (err) {
    return fail(err, `oauth ${sub} failed`);
  } finally {
    ledger?.close();
  }
}

// warifuri backup: a dated copy of the ledger in dir; only the newest --keep copies stay.
function runBackup(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { db: { type: 'string' }, dir: { type: 'string' }, keep: { type: 'string', default: '7' } },
    });
  } catch (err) {
    return usage(err.message);
  }
  const { values } = parsed;
  if (!values.db) return usage('--db is required');
  if (!values.dir) return usage('--dir is required');
  const keep = Number(values.keep);
  if (!Number.isInteger(keep) || keep < 1) return usage('--keep must be a whole number of 1 or more');
  try {
    const { file, removed } = backupLedger(values.db, values.dir, { keep });
    const out = [`backup: ${file}`];
    if (removed.length) out.push(`removed ${removed.length} older backup${removed.length === 1 ? '' : 's'}`);
    process.stdout.write(`${out.join('\n')}\n`);
    return 0;
  } catch (err) {
    return fail(err, 'backup failed');
  }
}

// warifuri serve: keeps running until SIGINT or SIGTERM, so it returns no exit code itself.
function runServe(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        db: { type: 'string' },
        host: { type: 'string', default: '127.0.0.1' },
        port: { type: 'string', default: '8787' },
        'public-url': { type: 'string' },
        'github-user': { type: 'string' },
      },
    });
  } catch (err) {
    return usage(err.message);
  }
  const { values } = parsed;
  if (!values.db) return usage('--db is required');
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return usage('--port must be a number from 0 to 65535');
  const oauth = oauthConfig({ flags: { publicUrl: values['public-url'], githubUser: values['github-user'] } });
  if (oauth.problems) return usage(oauth.problems.join('; '));

  let ledger;
  try {
    ledger = openLedger(values.db);
  } catch (err) {
    return fail(err, `cannot open ${values.db}`);
  }
  const server = createServer({ ledger, oauth: oauth.config });
  server.on('error', (err) => {
    process.stderr.write(`warifuri: cannot listen: ${err.message}\n`);
    ledger.close();
    process.exitCode = 1;
  });
  server.listen(port, values.host, () => {
    const addr = server.address();
    const host = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
    process.stdout.write(`warifuri: serving http://${host}:${addr.port}/mcp\n`);
    if (oauth.config) {
      process.stdout.write(`warifuri: GitHub login on for ${oauth.config.githubUser}, at ${oauth.config.publicUrl}/mcp\n`);
    } else {
      process.stdout.write(`warifuri: GitHub login off (missing ${oauth.missing.join(', ')}); only device keys work\n`);
    }
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
  if (command === 'oauth') return runOAuth(rest);
  if (command === 'backup') return runBackup(rest);
  if (command === 'serve') return runServe(rest);
  if (command === undefined || command === '--help' || command === '-h') return usage();
  return usage(`unknown command: ${command}`);
}

const code = main(process.argv.slice(2));
if (code !== undefined) process.exitCode = code;
