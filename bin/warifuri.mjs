#!/usr/bin/env node
// The warifuri command. Thin: it reads arguments and files, calls the ledger, prints.
//
//   warifuri init
//   warifuri config
//   warifuri import <snapshot.json> [--actor <name>]
//   warifuri key add <device>
//   warifuri key list
//   warifuri key revoke <device>     (also ends the device's GitHub logins)
//   warifuri backup --dir <dir> [--keep 7]
//   warifuri oauth clients
//   warifuri oauth revoke <client_id>
//   warifuri serve [--host 127.0.0.1] [--port 8787]
//                  [--public-url <url>] [--github-user <login>] [--trust-proxy <value>]
//   warifuri connect [--url <server url>] [--device <name>] [--harness claude|codex|all]
//                    [--no-hook] [--no-skills] [--force] [--dry-run]
//   warifuri hook gate               (the start gate; a PreToolUse hook, JSON on stdin)
//
// Every command takes --home <dir> (the data directory) and --db <ledger.sqlite>. The flags
// override the settings of src/config.mjs, which come from the environment, then from
// warifuri.env and secrets.env in the data directory. serve turns on the GitHub login when
// the public URL, the GitHub user, WARIFURI_GITHUB_CLIENT_ID and WARIFURI_GITHUB_CLIENT_SECRET
// are all set. Otherwise only device keys work.
//
// Exit codes: 0 done (even when rows were flagged or skipped), 1 the snapshot or the ledger
// could not be read, the snapshot's envelope is wrong, the ledger refused or the backup
// failed, 2 the command line or the settings are wrong.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { openLedger, LedgerError } from '../src/ledger/ledger.mjs';
import { createServer } from '../src/server/mcp.mjs';
import { oauthConfig, cleanClientName } from '../src/server/oauth.mjs';
import { backupLedger } from '../src/ledger/backup.mjs';
import { loadConfig, flagOptions, describeConfig, initHome } from '../src/config.mjs';
import { PROFILES_DIR } from '../src/knowledge/profiles.mjs';
import { connect, redact } from '../src/client/connect.mjs';
import { decide, readKey } from '../src/client/gate.mjs';

const USAGE = [
  'usage: warifuri init',
  '       warifuri config',
  '       warifuri import <snapshot.json> [--actor <name>]',
  '       warifuri key add <device>',
  '       warifuri key list',
  '       warifuri key revoke <device>',
  '       warifuri backup --dir <dir> [--keep 7]',
  '       warifuri oauth clients',
  '       warifuri oauth revoke <client_id>',
  '       warifuri serve [--host 127.0.0.1] [--port 8787]',
  '                      [--public-url <url>] [--github-user <login>] [--trust-proxy <value>]',
  '       warifuri connect [--url <server url>] [--device <name>] [--harness claude|codex|all]',
  '                        [--no-hook] [--no-skills] [--force] [--dry-run]',
  '       warifuri hook gate',
  '',
  'Every command also takes --home <dir> (the data directory, or WARIFURI_HOME; ~/.warifuri',
  'when neither is given) and --db <ledger.sqlite> (or WARIFURI_DB; ledger.sqlite in the',
  'data directory). init writes warifuri.env and secrets.env there and makes an empty',
  'profiles/, and config shows every setting and where it came from. Flags win over the',
  'environment, which wins over the files.',
  '',
  'key revoke also ends every GitHub login of that device.',
  '',
  'serve listens on 127.0.0.1 unless --host says otherwise. Listening beyond this machine',
  'is your choice; the GitHub login and the device keys are then the only guard, so put',
  'HTTPS in front. The GitHub login needs the public URL (WARIFURI_PUBLIC_URL), the GitHub',
  'user (WARIFURI_GITHUB_USER), WARIFURI_GITHUB_CLIENT_ID and WARIFURI_GITHUB_CLIENT_SECRET.',
  'WARIFURI_GITHUB_ID fixes the GitHub user by number; without it, the number is pinned at',
  'the first login. Apps are sent back only to localhost, or over https to claude.ai,',
  'claude.com and the hosts in WARIFURI_REDIRECT_HOSTS (comma-separated).',
  'Behind a tunnel or reverse proxy on this machine, give --trust-proxy loopback (or',
  'WARIFURI_TRUST_PROXY), so the rate limits count each caller and not the tunnel.',
  '',
  'connect sets up this machine to use a server (--url, or WARIFURI_SERVER_URL; a server on',
  'this machine when neither is given): it registers the MCP server in Claude Code and Codex,',
  'puts the device key in WARIFURI_DEVICE_KEY_FILE (issued here when the ledger is on this',
  'machine), wires the start gate hook and copies the skills. --dry-run only shows the plan.',
  'hook gate is that hook: it reads the harness JSON on stdin and stops an edit in a place',
  'where this device holds no task. It lets the edit through whenever it cannot ask.',
].join('\n');

function usage(message) {
  if (message) process.stderr.write(`warifuri: ${message}\n`);
  process.stderr.write(`${USAGE}\n`);
  return 2;
}

// The settings for a command, or the exit code when they are wrong.
function settingsFor(command, values) {
  const cfg = loadConfig({ flags: values, command });
  if (cfg.problems.length === 0) return cfg;
  for (const p of cfg.problems) process.stderr.write(`warifuri: ${p}\n`);
  return 2;
}

// Opens the ledger of the settings. The data directory is made when the ledger is in it by default.
function openConfiguredLedger(cfg) {
  if (cfg.entries.find((e) => e.setting.name === 'WARIFURI_DB').source === 'default') {
    fs.mkdirSync(cfg.home, { recursive: true, mode: 0o700 });
  }
  return openLedger(cfg.values.WARIFURI_DB);
}

function warn(cfg) {
  for (const w of cfg.warnings) process.stderr.write(`warifuri: warning: ${w}\n`);
}

// warifuri init: the data directory with a commented warifuri.env, an empty secrets.env and
// an empty profiles/. A file that is already there is left as it is.
function runInit(args) {
  let parsed;
  try {
    parsed = parseArgs({ args, options: flagOptions('init') });
  } catch (err) {
    return usage(err.message);
  }
  const { home } = loadConfig({ flags: parsed.values, command: 'init' });
  try {
    for (const { file, created } of initHome(home)) {
      process.stdout.write(created ? `wrote ${file}\n` : `kept ${file} (already there)\n`);
    }
    // The profiles' folder, empty: a profile's folder is made by its first note, or by hand.
    const profiles = path.join(home, PROFILES_DIR);
    const made = !fs.existsSync(profiles);
    fs.mkdirSync(profiles, { recursive: true, mode: 0o700 });
    process.stdout.write(made ? `made ${profiles}\n` : `kept ${profiles} (already there)\n`);
    return 0;
  } catch (err) {
    return fail(err, 'init failed');
  }
}

// warifuri config: every setting's value and where it came from, secrets masked.
function runConfig(args) {
  let parsed;
  try {
    parsed = parseArgs({ args, options: flagOptions('config') });
  } catch (err) {
    return usage(err.message);
  }
  const cfg = loadConfig({ flags: parsed.values, command: 'config' });
  const out = [describeConfig(cfg), ''];
  const oauth = oauthConfig({ env: cfg.values });
  if (oauth.config) out.push('GitHub login: on');
  else if (oauth.missing) out.push(`GitHub login: off (missing ${oauth.missing.join(', ')})`);
  else out.push(`GitHub login: off (${oauth.problems.join('; ')})`);
  for (const w of cfg.warnings) out.push(`warning: ${w}`);
  for (const p of cfg.problems) out.push(`problem: ${p}`);
  process.stdout.write(`${out.join('\n')}\n`);
  return cfg.problems.length || oauth.problems ? 2 : 0;
}

function runImport(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: { ...flagOptions('import'), actor: { type: 'string', default: 'import' } },
    });
  } catch (err) {
    return usage(err.message);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) return usage('give exactly one snapshot file');
  if (values.actor.trim() === '') return usage('--actor must not be empty');
  const cfg = settingsFor('import', values);
  if (cfg === 2) return 2;

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(positionals[0], 'utf8'));
  } catch (err) {
    process.stderr.write(`warifuri: cannot read ${positionals[0]}: ${err.message}\n`);
    return 1;
  }

  let ledger;
  try {
    ledger = openConfiguredLedger(cfg);
    const res = ledger.replaceFromSnapshot(doc, { actor: values.actor });
    const c = res.counts;
    const out = [
      `imported: ${c.places} places, ${c.goals} goals, ${c.tasks} tasks, ${c.blocks} blocks`,
      `flagged for review: ${res.flagged.length}`,
      `skipped: ${res.skipped.length}`,
      ...res.skipped.map((s) => `  ${s.kind} ${s.id}: ${s.problems.join(' / ')}`),
    ];
    if (res.detached_habits.length) out.push(`habits whose goal is gone (link removed): ${res.detached_habits.join(', ')}`);
    if (res.dropped_bookings) out.push(`bookings whose task is gone (deleted): ${res.dropped_bookings}`);
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
      options: flagOptions('key'),
    });
  } catch (err) {
    return usage(err.message);
  }
  const { values, positionals } = parsed;
  if (!['add', 'list', 'revoke'].includes(sub)) return usage('key takes add, list or revoke');
  if (sub === 'list' && positionals.length !== 0) return usage('key list takes no name');
  if (sub !== 'list' && positionals.length !== 1) return usage(`key ${sub} takes one device name`);
  const cfg = settingsFor('key', values);
  if (cfg === 2) return 2;

  let ledger;
  try {
    ledger = openConfiguredLedger(cfg);
    if (sub === 'add') {
      const { name, key } = ledger.issueKey(positionals[0], { actor: 'cli' });
      process.stdout.write(`key for ${name}:\n${key}\nThis key will not be shown again. Keep it in that device's settings.\n`);
    } else if (sub === 'revoke') {
      const out = ledger.revokeKey(positionals[0], { actor: 'cli' });
      const logins = out.oauth_tokens ? ` (and ${out.oauth_tokens} GitHub login token${out.oauth_tokens === 1 ? '' : 's'})` : '';
      process.stdout.write(`revoked: ${positionals[0]}${logins}\n`);
    } else {
      const rows = ledger.listDevices();
      if (rows.length === 0) process.stdout.write('no devices\n');
      for (const d of rows) {
        const state = d.has_key ? 'key in use' : d.revoked_at ? `revoked ${d.revoked_at}` : 'no key';
        const seen = d.last_seen_at ? `  seen ${d.last_seen_at}` : '';
        process.stdout.write(`${d.name}  added ${d.created_at}${seen}  (${state})\n`);
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
    parsed = parseArgs({ args: rest, allowPositionals: true, options: flagOptions('oauth') });
  } catch (err) {
    return usage(err.message);
  }
  const { values, positionals } = parsed;
  if (!['clients', 'revoke'].includes(sub)) return usage('oauth takes clients or revoke');
  if (sub === 'clients' && positionals.length !== 0) return usage('oauth clients takes no argument');
  if (sub === 'revoke' && positionals.length !== 1) return usage('oauth revoke takes one client id');
  const cfg = settingsFor('oauth', values);
  if (cfg === 2) return 2;

  let ledger;
  try {
    ledger = openConfiguredLedger(cfg);
    if (sub === 'revoke') {
      const out = ledger.oauth.revokeClient(positionals[0], { actor: 'cli' });
      if (!out) {
        process.stderr.write(`warifuri: no OAuth client ${positionals[0]}\n`);
        return 1;
      }
      process.stdout.write(`revoked ${out.revoked} token${out.revoked === 1 ? '' : 's'} of ${out.client_id}\n`);
    } else {
      const pinned = ledger.oauth.githubId();
      process.stdout.write(pinned ? `GitHub user id ${pinned.id} (pinned ${pinned.updated_at})\n` : 'GitHub user id not pinned yet (WARIFURI_GITHUB_ID, or the first login)\n');
      const rows = ledger.oauth.listClients();
      if (rows.length === 0) process.stdout.write('no OAuth clients\n');
      for (const c of rows) {
        const devices = c.devices.length ? `in use by ${c.devices.join(', ')}` : 'no live tokens';
        // The name is the client's own words; nothing in it may move the terminal.
        const name = c.client_name ? cleanClientName(c.client_name) ?? '(no name)' : '(no name)';
        process.stdout.write(`${c.client_id}  ${name}  registered ${c.created_at}  (${devices})\n`);
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
      options: { ...flagOptions('backup'), dir: { type: 'string' }, keep: { type: 'string', default: '7' } },
    });
  } catch (err) {
    return usage(err.message);
  }
  const { values } = parsed;
  if (!values.dir) return usage('--dir is required');
  const keep = Number(values.keep);
  if (!Number.isInteger(keep) || keep < 1) return usage('--keep must be a whole number of 1 or more');
  const cfg = settingsFor('backup', values);
  if (cfg === 2) return 2;
  try {
    const { file, removed } = backupLedger(cfg.values.WARIFURI_DB, values.dir, { keep });
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
    parsed = parseArgs({ args, options: flagOptions('serve') });
  } catch (err) {
    return usage(err.message);
  }
  const cfg = settingsFor('serve', parsed.values);
  if (cfg === 2) return 2;
  warn(cfg);
  const { values } = cfg;
  const oauth = oauthConfig({ env: values });
  if (oauth.problems) return usage(oauth.problems.join('; '));

  let ledger;
  try {
    ledger = openConfiguredLedger(cfg);
  } catch (err) {
    return fail(err, `cannot open ${values.WARIFURI_DB}`);
  }
  let server;
  try {
    server = createServer({ ledger, home: cfg.home, oauth: oauth.config, trustProxy: values.WARIFURI_TRUST_PROXY });
  } catch (err) {
    ledger.close();
    return usage(`WARIFURI_TRUST_PROXY (--trust-proxy): ${err.message}`);
  }
  server.on('error', (err) => {
    process.stderr.write(`warifuri: cannot listen: ${err.message}\n`);
    ledger.close();
    process.exitCode = 1;
  });
  server.listen(Number(values.WARIFURI_PORT), values.WARIFURI_HOST, () => {
    const addr = server.address();
    const host = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
    process.stdout.write(`warifuri: serving http://${host}:${addr.port}/mcp\n`);
    if (oauth.config) {
      process.stdout.write(`warifuri: GitHub login on for ${oauth.config.githubUser}${oauth.config.githubId ? ` (id ${oauth.config.githubId})` : ''}, at ${oauth.config.publicUrl}/mcp\n`);
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

// warifuri connect: see src/client/connect.mjs.
function runConnect(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        ...flagOptions('connect'),
        device: { type: 'string' },
        harness: { type: 'string', default: 'all' },
        'no-hook': { type: 'boolean', default: false },
        'no-skills': { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
      },
    });
  } catch (err) {
    return usage(err.message);
  }
  const { values } = parsed;
  if (!['claude', 'codex', 'all'].includes(values.harness)) return usage('--harness takes claude, codex or all');
  if (values.device !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(values.device)) {
    return usage('--device takes letters, digits and . _ - (1 to 64)');
  }
  const cfg = settingsFor('connect', values);
  if (cfg === 2) return 2;
  warn(cfg);
  const homeIsDefault = cfg.entries.find((e) => e.setting.name === 'WARIFURI_HOME').source === 'default';
  let out;
  try {
    out = connect(
      cfg,
      { device: values.device, harness: values.harness, hook: !values['no-hook'], skills: !values['no-skills'], force: values.force, dryRun: values['dry-run'] },
      { homeIsDefault },
    );
  } catch (err) {
    process.stderr.write(`warifuri: connect failed: ${redact(err.message)}\n`);
    return 1;
  }
  if (out.lines.length) process.stdout.write(`${out.lines.map(redact).join('\n')}\n`);
  for (const p of out.problems) process.stderr.write(`warifuri: ${redact(p)}\n`);
  return out.problems.length ? 1 : 0;
}

// warifuri hook gate: the start gate. It always exits 0; a refusal is the JSON it prints.
// Anything it cannot read or reach lets the edit through.
async function runHook(args) {
  const rest = args.slice(1);
  let output = null;
  try {
    const { values } = parseArgs({ args: rest, options: flagOptions('hook') });
    const cfg = loadConfig({ flags: values, command: 'hook' });
    let payload = null;
    try {
      payload = JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch {
      payload = null;
    }
    if (payload && cfg.problems.length === 0) {
      const v = cfg.values;
      output = await decide(payload, { url: v.WARIFURI_SERVER_URL, key: readKey(v.WARIFURI_DEVICE_KEY_FILE), gate: v.WARIFURI_GATE });
    }
  } catch {
    output = null;
  }
  // Exit at once: an open connection to the server must not keep the hook waiting.
  await new Promise((resolve) => (output ? process.stdout.write(`${output}\n`, resolve) : resolve()));
  process.exit(0);
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'init') return runInit(rest);
  if (command === 'config') return runConfig(rest);
  if (command === 'import') return runImport(rest);
  if (command === 'key') return runKey(rest);
  if (command === 'oauth') return runOAuth(rest);
  if (command === 'backup') return runBackup(rest);
  if (command === 'serve') return runServe(rest);
  if (command === 'connect') return runConnect(rest);
  if (command === 'hook') {
    if (rest[0] !== 'gate') return usage('hook takes gate');
    runHook(rest);
    return undefined;
  }
  if (command === undefined || command === '--help' || command === '-h') return usage();
  return usage(`unknown command: ${command}`);
}

const code = main(process.argv.slice(2));
if (code !== undefined) process.exitCode = code;
