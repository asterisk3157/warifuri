// warifuri's settings: one list, and the reading of them.
//
// Every setting has a WARIFURI_ name. Its value comes from the first of: the command-line
// flag, the real environment, the settings files in the data directory (secrets.env over
// warifuri.env), the default. The data directory itself (WARIFURI_HOME) comes only from the
// flag, the environment or the default, since the files live in it. A secret may instead be
// given as <NAME>_FILE=<path>; the file is read and one trailing newline is dropped.
//
// SETTINGS is the only list. Startup validation, `warifuri init` (the template),
// `warifuri config` (the report) and docs/configuration.md (the table) all come from it.
// Reading never changes process.env.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';

export const SETTINGS_FILE = 'warifuri.env';
export const SECRETS_FILE = 'secrets.env';

const LEDGER = ['import', 'key', 'backup', 'oauth', 'serve', 'connect'];
const CLIENT = ['connect', 'hook'];

const httpUrl = (v) => {
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'must start with http:// or https://';
    return u.search || u.hash || u.username || u.password ? 'must be a plain URL, with no query or login' : null;
  } catch {
    return 'is not a URL';
  }
};

// name: the variable. flag: the command-line override, if any. about: Japanese, for the
// template and the documentation. def: the default (a function of the data directory, or a
// string), and defText how the documentation shows it. secret: kept in secrets.env and masked.
// path: a file path; a relative one in a settings file is read from the data directory.
// commands: the commands that read it. check: returns what is wrong with a value, or null.
// section: 'client' for the settings of a machine that uses a server (connect and the hook).
export const SETTINGS = [
  {
    name: 'WARIFURI_HOME',
    flag: 'home',
    about: 'データのフォルダ。設定ファイルと台帳を置く。設定ファイルの中では書けない',
    def: () => path.join(os.homedir(), '.warifuri'),
    defText: '~/.warifuri',
    path: true,
    commands: ['すべて'],
  },
  {
    name: 'WARIFURI_DB',
    flag: 'db',
    about: '台帳の SQLite のファイル',
    def: (home) => path.join(home, 'ledger.sqlite'),
    defText: 'WARIFURI_HOME/ledger.sqlite',
    path: true,
    commands: LEDGER,
  },
  {
    name: 'WARIFURI_HOST',
    flag: 'host',
    about: '待ち受けるアドレス。この機械の外から受けるときだけ変える',
    def: '127.0.0.1',
    commands: ['serve'],
  },
  {
    name: 'WARIFURI_PORT',
    flag: 'port',
    about: '待ち受けるポート',
    def: '8787',
    commands: ['serve', 'connect'],
    check: (v) => (/^\d+$/.test(v) && Number(v) <= 65535 ? null : 'must be a number from 0 to 65535'),
  },
  {
    name: 'WARIFURI_PUBLIC_URL',
    flag: 'public-url',
    about: 'ハーネスから見えるサーバーの URL。https で始まり、道を含まない。GitHub のログインに要る',
    commands: ['serve'],
  },
  {
    name: 'WARIFURI_GITHUB_USER',
    flag: 'github-user',
    about: 'ログインしてよい人の GitHub のユーザー名。GitHub のログインに要る',
    commands: ['serve'],
  },
  {
    name: 'WARIFURI_GITHUB_ID',
    about: 'ログインしてよい人の GitHub の数値の ID。空なら最初のログインで覚える',
    commands: ['serve'],
  },
  {
    name: 'WARIFURI_GITHUB_CLIENT_ID',
    about: 'GitHub の OAuth App の Client ID。GitHub のログインに要る',
    commands: ['serve'],
  },
  {
    name: 'WARIFURI_GITHUB_CLIENT_SECRET',
    about: 'GitHub の OAuth App の Client Secret。GitHub のログインに要る',
    secret: true,
    commands: ['serve'],
  },
  {
    name: 'WARIFURI_TRUST_PROXY',
    flag: 'trust-proxy',
    about: '同じ機械のトンネルや逆プロキシを信じる範囲(loopback や段数)。回数の制限を呼び出し元ごとに数えるために使う',
    commands: ['serve'],
  },
  {
    name: 'WARIFURI_REDIRECT_HOSTS',
    about: 'ログインのあとに戻してよい https の先。claude.ai と claude.com に足す。カンマ区切り',
    commands: ['serve'],
  },
  {
    name: 'WARIFURI_SERVER_URL',
    flag: 'url',
    section: 'client',
    about: '使う機械から見たサーバーの URL。/mcp は付けない。connect が書き、着手の確かめのフックが読む',
    commands: CLIENT,
    check: httpUrl,
  },
  {
    name: 'WARIFURI_DEVICE_KEY_FILE',
    section: 'client',
    about: 'この機械の鍵を1行で置くファイル。本人だけが読めるようにする。connect が書き、着手の確かめのフックが読む',
    def: (home) => path.join(home, 'device.key'),
    defText: 'WARIFURI_HOME/device.key',
    path: true,
    commands: CLIENT,
  },
  {
    name: 'WARIFURI_GATE',
    section: 'client',
    about: '着手の確かめ。off にすると、持っているタスクがなくても編集を止めない',
    def: 'on',
    commands: ['hook'],
    check: (v) => (v === 'on' || v === 'off' ? null : 'must be on or off'),
  },
];

const byName = new Map(SETTINGS.map((s) => [s.name, s]));
const fileName = (s) => `${s.name}_FILE`;

// The settings a command reads, as { [flag]: { type: 'string' } } for parseArgs.
export function flagOptions(command) {
  const out = {};
  for (const s of SETTINGS) {
    if (s.flag && (s.name === 'WARIFURI_HOME' || command === 'config' || s.commands.includes(command))) out[s.flag] = { type: 'string' };
  }
  return out;
}

// ~ is the home directory; on Windows ~\ works as well as ~/.
const expandTilde = (p) =>
  p === '~' || p.startsWith('~/') || (path.sep === '\\' && p.startsWith('~\\')) ? path.join(os.homedir(), p.slice(1)) : p;
const clean = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

// Reads one settings file of the data directory: { values, mode } or null when it is absent.
function readFile(file, problems) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') problems.push(`cannot read ${file}: ${err.message}`);
    return null;
  }
  let values;
  try {
    values = parseEnv(text);
  } catch (err) {
    problems.push(`cannot read ${file}: ${err.message}`);
    return null;
  }
  return { values, mode: fs.statSync(file).mode & 0o777 };
}

// Reads <NAME>_FILE: the file's text without one trailing newline.
function readSecretFile(file, problems, label) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  } catch (err) {
    problems.push(`${label}: cannot read ${file}: ${err.message}`);
    return undefined;
  }
}

// Loads every setting. flags: parseArgs values (keyed by flag name). env: the real
// environment. command: which command is starting; only the settings it reads are checked
// (`config` checks all). Returns { home, values, entries, warnings, problems }:
// values is { NAME: value } with unset settings left out; entries is one { setting, value,
// source, detail } per setting, for the report; problems stop the command, warnings do not.
export function loadConfig({ flags = {}, env = process.env, command = 'config' } = {}) {
  const problems = [];
  const warnings = [];
  const entries = [];

  const homeFlag = clean(flags.home);
  const homeEnv = clean(env.WARIFURI_HOME);
  const homeSource = homeFlag !== undefined ? 'flag' : homeEnv !== undefined ? 'env' : 'default';
  const home = path.resolve(expandTilde(homeFlag ?? homeEnv ?? byName.get('WARIFURI_HOME').def()));
  entries.push({ setting: byName.get('WARIFURI_HOME'), value: home, source: homeSource });

  const settingsPath = path.join(home, SETTINGS_FILE);
  const secretsPath = path.join(home, SECRETS_FILE);
  const settingsFile = readFile(settingsPath, problems);
  const secretsFile = readFile(secretsPath, problems);
  // Later layers lose: secrets.env is read before warifuri.env.
  const layers = [
    { source: 'env', values: env },
    { source: SECRETS_FILE, values: secretsFile?.values ?? {} },
    { source: SETTINGS_FILE, values: settingsFile?.values ?? {} },
  ];

  const known = new Set(SETTINGS.flatMap((s) => (s.secret ? [s.name, fileName(s)] : [s.name])));
  for (const [file, f] of [[SETTINGS_FILE, settingsFile], [SECRETS_FILE, secretsFile]]) {
    if (!f) continue;
    for (const key of Object.keys(f.values)) {
      if (key === 'WARIFURI_HOME') warnings.push(`${file}: WARIFURI_HOME is ignored there; give it as --home or in the environment`);
      else if (!known.has(key)) warnings.push(`${file}: ${key} is not a warifuri setting and is ignored`);
    }
  }
  for (const s of SETTINGS) {
    if (s.secret && clean(settingsFile?.values[s.name]) !== undefined) {
      warnings.push(`${s.name} is written in ${SETTINGS_FILE}; move it to ${SECRETS_FILE}`);
    }
  }
  if (secretsFile && process.platform !== 'win32' && secretsFile.mode & 0o077) {
    warnings.push(`${secretsPath} can be read by others (mode ${secretsFile.mode.toString(8).padStart(3, '0')}); run chmod 600 on it`);
  }

  const values = { WARIFURI_HOME: home };
  for (const s of SETTINGS) {
    if (s.name === 'WARIFURI_HOME') continue;
    let value;
    let source = 'default';
    let detail;
    const flag = s.flag ? clean(flags[s.flag]) : undefined;
    if (flag !== undefined) {
      value = flag;
      source = 'flag';
    } else {
      for (const layer of layers) {
        const direct = clean(layer.values[s.name]);
        const viaFile = s.secret ? clean(layer.values[fileName(s)]) : undefined;
        if (direct !== undefined && viaFile !== undefined) {
          problems.push(`${s.name} and ${fileName(s)} are both set in ${layer.source}; keep one`);
        }
        if (direct !== undefined) {
          value = direct;
          source = layer.source;
        } else if (viaFile !== undefined) {
          const file = path.resolve(layer.source === 'env' ? '.' : home, expandTilde(viaFile));
          value = clean(readSecretFile(file, problems, fileName(s)));
          source = '_FILE';
          detail = `${fileName(s)} in ${layer.source}: ${file}`;
        } else {
          continue;
        }
        // A relative path in a settings file is read from the data directory.
        if (s.path && value !== undefined && layer.source !== 'env') value = path.resolve(home, expandTilde(value));
        break;
      }
    }
    if (value === undefined && s.def !== undefined) value = typeof s.def === 'function' ? s.def(home) : s.def;
    // From the command line or the environment, from the current directory.
    if (value !== undefined && s.path && (source === 'flag' || source === 'env')) value = path.resolve(expandTilde(value));
    if (value !== undefined) values[s.name] = value;
    entries.push({ setting: s, value, source, detail });
    const checked = command === 'config' || s.commands.includes(command);
    const wrong = checked && value !== undefined && s.check ? s.check(value) : null;
    if (wrong) problems.push(`${label(s)} ${wrong}`);
  }
  return { home, values, entries, warnings, problems, files: { settings: settingsPath, secrets: secretsPath } };
}

// How a setting is named to the person: the variable, and the flag when there is one.
export function label(s) {
  return s.flag ? `${s.name} (--${s.flag})` : s.name;
}

// The report of `warifuri config`: one line per setting, secrets masked.
export function describeConfig(cfg) {
  const width = Math.max(...SETTINGS.map((s) => s.name.length));
  const lines = [`settings: ${cfg.files.settings}`, `secrets:  ${cfg.files.secrets}`, ''];
  for (const { setting, value, source, detail } of cfg.entries) {
    const shown = value === undefined ? '(not set)' : setting.secret ? '******** (hidden)' : value;
    const from = value === undefined ? '' : `  [${detail ? `${source}: ${detail}` : source}]`;
    lines.push(`${setting.name.padEnd(width)}  ${shown}${from}`);
  }
  return lines.join('\n');
}

// The text of a new warifuri.env: every setting but the data directory and the secrets,
// commented out, with its default.
export function settingsTemplate() {
  const out = [
    '# warifuri の設定。1行に1つ、NAME=値 で書きます。# で始まる行は読みません。',
    '# 環境変数とコマンドの引数は、このファイルより優先します。',
    `# 秘密(${SETTINGS.filter((s) => s.secret).map((s) => s.name).join('、')})は、このファイルではなく ${SECRETS_FILE} に書きます。`,
    '# 項目の説明は docs/configuration.md にあります。',
  ];
  let section;
  for (const s of SETTINGS) {
    if (s.name === 'WARIFURI_HOME' || s.secret) continue;
    if (s.section === 'client' && section !== 'client') {
      out.push('', '# ---- 使う機械の設定。warifuri connect と着手の確かめのフックが読む ----');
    }
    section = s.section;
    out.push('', `# ${s.about}${s.defText ? `。既定は ${s.defText}` : ''}`);
    out.push(`# ${s.name}=${typeof s.def === 'string' ? s.def : ''}`);
  }
  return `${out.join('\n')}\n`;
}

// The text of a new secrets.env: no values, only the names to fill.
export function secretsTemplate() {
  const out = [
    '# warifuri の秘密。本人だけが読めるようにしておきます(chmod 600)。',
    '# 値をファイルで渡すときは、NAME_FILE=<ファイルの場所> と書きます。',
  ];
  for (const s of SETTINGS) if (s.secret) out.push('', `# ${s.about}`, `# ${s.name}=`);
  return `${out.join('\n')}\n`;
}

// Writes the two templates into the data directory, leaving any file that is already there.
// Returns [{ file, created }].
export function initHome(home) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const out = [];
  for (const [name, text, mode] of [[SETTINGS_FILE, settingsTemplate(), 0o644], [SECRETS_FILE, secretsTemplate(), 0o600]]) {
    const file = path.join(home, name);
    try {
      fs.writeFileSync(file, text, { flag: 'wx', mode });
      fs.chmodSync(file, mode);
      out.push({ file, created: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      out.push({ file, created: false });
    }
  }
  return out;
}

// The table in docs/configuration.md.
export function settingsTable() {
  const cell = (v) => String(v).replace(/\|/g, '\\|');
  const rows = [
    '| 名前 | 内容 | 既定 | 引数 | 秘密 | 使うコマンド |',
    '|---|---|---|---|---|---|',
  ];
  for (const s of SETTINGS) {
    const def = s.defText ?? (typeof s.def === 'string' ? s.def : '');
    rows.push(
      `| \`${s.name}\` | ${cell(s.about)} | ${def ? `\`${def}\`` : 'なし'} | ${s.flag ? `\`--${s.flag}\`` : ''} | ${s.secret ? '秘密' : ''} | ${s.commands.join('、')} |`,
    );
  }
  return rows.join('\n');
}
