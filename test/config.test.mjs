// Tests for the settings (src/config.mjs) and the `warifuri init` and `warifuri config`
// commands.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, describeConfig, initHome, SETTINGS } from '../src/config.mjs';
import { withTable } from '../scripts/settings-table.mjs';
import { cli } from './cli.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warifuri-config-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

// A data directory with the given warifuri.env and secrets.env (null leaves one out).
function home({ settings = null, secrets = null, secretsMode = 0o600 } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'home-'));
  if (settings !== null) fs.writeFileSync(path.join(dir, 'warifuri.env'), settings);
  if (secrets !== null) {
    fs.writeFileSync(path.join(dir, 'secrets.env'), secrets);
    fs.chmodSync(path.join(dir, 'secrets.env'), secretsMode);
  }
  return dir;
}

const entry = (cfg, name) => cfg.entries.find((e) => e.setting.name === name);

test('flags win over the environment, which wins over secrets.env, then warifuri.env, then defaults', () => {
  const dir = home({
    settings: 'WARIFURI_PORT=1001\nWARIFURI_HOST=10.0.0.1\nWARIFURI_PUBLIC_URL=https://file.example\nWARIFURI_GITHUB_USER=from-file\n',
    secrets: 'WARIFURI_PUBLIC_URL=https://secrets.example\n',
  });
  const env = { WARIFURI_HOME: dir, WARIFURI_PORT: '2002', WARIFURI_HOST: '10.0.0.2' };
  const cfg = loadConfig({ env, flags: { port: '3003' } });
  assert.deepEqual(cfg.problems, []);
  assert.equal(cfg.values.WARIFURI_PORT, '3003');
  assert.equal(entry(cfg, 'WARIFURI_PORT').source, 'flag');
  assert.equal(cfg.values.WARIFURI_HOST, '10.0.0.2');
  assert.equal(entry(cfg, 'WARIFURI_HOST').source, 'env');
  assert.equal(cfg.values.WARIFURI_PUBLIC_URL, 'https://secrets.example');
  assert.equal(entry(cfg, 'WARIFURI_PUBLIC_URL').source, 'secrets.env');
  assert.equal(cfg.values.WARIFURI_GITHUB_USER, 'from-file');
  assert.equal(entry(cfg, 'WARIFURI_GITHUB_USER').source, 'warifuri.env');
  assert.equal(entry(cfg, 'WARIFURI_TRUST_PROXY').value, undefined);
  assert.equal(cfg.values.WARIFURI_DB, path.join(dir, 'ledger.sqlite'));
  assert.equal(entry(cfg, 'WARIFURI_DB').source, 'default');

  // An empty value counts as not given.
  assert.equal(loadConfig({ env: { ...env, WARIFURI_PORT: ' ' } }).values.WARIFURI_PORT, '1001');
});

test('the data directory: --home, then WARIFURI_HOME, then ~/.warifuri; never from its own files', () => {
  const a = home({ settings: `WARIFURI_HOME=${path.join(tmpRoot, 'elsewhere')}\nWARIFURI_DB=sub/l.sqlite\n` });
  const b = home();
  const cfg = loadConfig({ env: { WARIFURI_HOME: b }, flags: { home: a } });
  assert.equal(cfg.home, a);
  assert.equal(entry(cfg, 'WARIFURI_HOME').source, 'flag');
  // A relative path in a settings file is read from the data directory.
  assert.equal(cfg.values.WARIFURI_DB, path.join(a, 'sub', 'l.sqlite'));
  assert.ok(cfg.warnings.some((w) => /WARIFURI_HOME is ignored/.test(w)));
  assert.equal(loadConfig({ env: { WARIFURI_HOME: b } }).home, b);
  assert.equal(loadConfig({ env: {} }).home, path.join(os.homedir(), '.warifuri'));
});

test('secrets.env is read, and a secret can be given as <NAME>_FILE', () => {
  const fromSecrets = loadConfig({ env: { WARIFURI_HOME: home({ secrets: 'WARIFURI_GITHUB_CLIENT_SECRET=s3cret\n' }) } });
  assert.equal(fromSecrets.values.WARIFURI_GITHUB_CLIENT_SECRET, 's3cret');
  assert.equal(entry(fromSecrets, 'WARIFURI_GITHUB_CLIENT_SECRET').source, 'secrets.env');
  assert.deepEqual(fromSecrets.warnings, []);

  // One trailing newline is dropped; the file may be named in the environment or in a file.
  const file = path.join(tmpRoot, 'github-secret');
  fs.writeFileSync(file, 'from-a-file\n');
  const viaEnv = loadConfig({ env: { WARIFURI_HOME: home(), WARIFURI_GITHUB_CLIENT_SECRET_FILE: file } });
  assert.equal(viaEnv.values.WARIFURI_GITHUB_CLIENT_SECRET, 'from-a-file');
  assert.equal(entry(viaEnv, 'WARIFURI_GITHUB_CLIENT_SECRET').source, '_FILE');
  const dir = home({ secrets: 'WARIFURI_GITHUB_CLIENT_SECRET_FILE=secret.txt\n' });
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'relative\n');
  assert.equal(loadConfig({ env: { WARIFURI_HOME: dir } }).values.WARIFURI_GITHUB_CLIENT_SECRET, 'relative');

  // The real environment still wins over a _FILE in secrets.env.
  assert.equal(loadConfig({ env: { WARIFURI_HOME: dir, WARIFURI_GITHUB_CLIENT_SECRET: 'env' } }).values.WARIFURI_GITHUB_CLIENT_SECRET, 'env');

  // Both forms in one place, or a file that cannot be read, stop the command.
  const both = loadConfig({ env: { WARIFURI_HOME: home(), WARIFURI_GITHUB_CLIENT_SECRET: 'x', WARIFURI_GITHUB_CLIENT_SECRET_FILE: file } });
  assert.ok(both.problems.some((p) => /both set in env/.test(p)));
  const missing = loadConfig({ env: { WARIFURI_HOME: home(), WARIFURI_GITHUB_CLIENT_SECRET_FILE: path.join(tmpRoot, 'none') } });
  assert.ok(missing.problems.some((p) => /WARIFURI_GITHUB_CLIENT_SECRET_FILE: cannot read/.test(p)));
  // Only secrets take _FILE.
  const notSecret = loadConfig({ env: { WARIFURI_HOME: home({ settings: `WARIFURI_PORT_FILE=${file}\n` }) } });
  assert.ok(notSecret.warnings.some((w) => /WARIFURI_PORT_FILE is not a warifuri setting/.test(w)));
});

test('the report masks secrets and says where each value came from', () => {
  const dir = home({ secrets: 'WARIFURI_GITHUB_CLIENT_SECRET=do-not-show-me\n' });
  const text = describeConfig(loadConfig({ env: { WARIFURI_HOME: dir, WARIFURI_GITHUB_CLIENT_ID: 'gh-id' } }));
  assert.ok(!text.includes('do-not-show-me'));
  assert.match(text, /WARIFURI_GITHUB_CLIENT_SECRET +\*{8} \(hidden\) +\[secrets\.env\]/);
  assert.match(text, /WARIFURI_GITHUB_CLIENT_ID +gh-id +\[env\]/);
  assert.match(text, /WARIFURI_PORT +8787 +\[default\]/);
  assert.match(text, /WARIFURI_PUBLIC_URL +\(not set\)/);
  for (const s of SETTINGS) assert.match(text, new RegExp(`^${s.name} `, 'm'));
});

test('warnings: a secret in warifuri.env, secrets.env readable by others, unknown names', () => {
  const dir = home({
    settings: 'WARIFURI_GITHUB_CLIENT_SECRET=oops\nGITHUB_CLIENT_ID=old-name\n',
    secrets: '',
    secretsMode: 0o644,
  });
  const cfg = loadConfig({ env: { WARIFURI_HOME: dir } });
  assert.deepEqual(cfg.problems, []);
  assert.ok(cfg.warnings.some((w) => /WARIFURI_GITHUB_CLIENT_SECRET is written in warifuri\.env; move it to secrets\.env/.test(w)));
  assert.ok(cfg.warnings.some((w) => /warifuri\.env: GITHUB_CLIENT_ID is not a warifuri setting/.test(w)));
  if (process.platform !== 'win32') assert.ok(cfg.warnings.some((w) => /can be read by others \(mode 644\)/.test(w)));
  assert.deepEqual(loadConfig({ env: { WARIFURI_HOME: home({ secrets: '' }) } }).warnings, []);
});

test('a wrong value stops only the commands that read it', () => {
  const dir = home({ settings: 'WARIFURI_PORT=eighty\n' });
  assert.ok(loadConfig({ env: { WARIFURI_HOME: dir }, command: 'serve' }).problems.some((p) => /WARIFURI_PORT \(--port\) must be a number/.test(p)));
  assert.deepEqual(loadConfig({ env: { WARIFURI_HOME: dir }, command: 'key' }).problems, []);
  assert.equal(cli(['serve'], { home: dir }).status, 2);
  assert.equal(cli(['key', 'list'], { home: dir }).status, 0);
});

test('init writes the two files once, secrets.env with mode 600, and never overwrites', () => {
  const dir = path.join(tmpRoot, 'fresh', 'data');
  const first = initHome(dir);
  assert.deepEqual(first.map((f) => f.created), [true, true]);
  const settings = path.join(dir, 'warifuri.env');
  const secrets = path.join(dir, 'secrets.env');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(secrets).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  }
  // The template sets nothing until a line is uncommented, and holds no secret.
  const fresh = loadConfig({ env: { WARIFURI_HOME: dir } });
  assert.deepEqual(fresh.warnings, []);
  assert.ok(fresh.entries.filter((e) => e.setting.name !== 'WARIFURI_HOME').every((e) => e.source === 'default' || e.value === undefined));
  for (const s of SETTINGS) {
    if (s.name !== 'WARIFURI_HOME') assert.match(fs.readFileSync(s.secret ? secrets : settings, 'utf8'), new RegExp(`^# ${s.name}=`, 'm'));
  }

  fs.writeFileSync(settings, 'WARIFURI_PORT=9999\n');
  fs.writeFileSync(secrets, 'WARIFURI_GITHUB_CLIENT_SECRET=keep\n');
  const again = cli(['init', '--home', dir]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /kept .*warifuri\.env/);
  assert.match(again.stdout, /made .*profiles/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'profiles')), []);
  assert.equal(fs.readFileSync(settings, 'utf8'), 'WARIFURI_PORT=9999\n');
  assert.equal(fs.readFileSync(secrets, 'utf8'), 'WARIFURI_GITHUB_CLIENT_SECRET=keep\n');

  const made = path.join(tmpRoot, 'by-env');
  const out = cli(['init'], { home: made });
  assert.equal(out.status, 0, out.stderr);
  assert.ok(fs.existsSync(path.join(made, 'warifuri.env')));
});

test('cli: warifuri config shows the values, the GitHub login and the warnings', () => {
  const dir = home({
    settings: 'WARIFURI_PUBLIC_URL=https://ledger.example\nWARIFURI_GITHUB_USER=alex\nWARIFURI_GITHUB_CLIENT_ID=gh-id\n',
    secrets: 'WARIFURI_GITHUB_CLIENT_SECRET=hidden-value\n',
    secretsMode: 0o640,
  });
  const out = cli(['config', '--port', '9000'], { home: dir });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /WARIFURI_PORT +9000 +\[flag\]/);
  assert.match(out.stdout, /GitHub login: on/);
  assert.ok(!out.stdout.includes('hidden-value'));
  if (process.platform !== 'win32') assert.match(out.stdout, /warning: .*secrets\.env can be read by others/);

  const off = cli(['config'], { home: home() });
  assert.equal(off.status, 0);
  assert.match(off.stdout, /GitHub login: off \(missing .*WARIFURI_GITHUB_CLIENT_SECRET/);
  const wrong = cli(['config'], { home: home({ settings: 'WARIFURI_PORT=70000\n' }) });
  assert.equal(wrong.status, 2);
  assert.match(wrong.stdout, /problem: WARIFURI_PORT/);
});

test('the table in docs/configuration.md is the one made from the settings', () => {
  const doc = fs.readFileSync(new URL('../docs/configuration.md', import.meta.url), 'utf8');
  assert.equal(doc, withTable(doc), 'run node scripts/settings-table.mjs --write');
});
