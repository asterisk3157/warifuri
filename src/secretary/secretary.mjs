// The secretary plug-in: Claude Code headless (`claude -p`, unmodified, logged in by the
// person on the server machine) woken by `warifuri serve` at set times. warifuri never reads
// or carries that login.
//
//   <home>/secretary/mcp.json        the MCP config claude is given: this server, with the
//                                    device key of `secretary`. Owner-only (600), never printed
//   <home>/secretary/run.lock        the pid of the run going on, so serve and
//                                    `warifuri secretary run` never run two at once
//   <home>/secretary/logs/<job>.log  claude's output of the last run (<job>.prev.log before it)
//   <home>/secretary/chat/           the working directory of the conversation (chat.mjs), so
//                                    that claude finds its sessions there again after a restart
//
// claude may use only warifuri's tools: --allowedTools names the server, the built-in tools
// (shell, files, web) are disallowed, and --strict-mcp-config leaves out the person's other
// MCP servers unless WARIFURI_SECRETARY_CALENDAR_TOOLS names a calendar to allow. The
// account's claude.ai connectors are turned off (ENABLE_CLAUDEAI_MCP_SERVERS=false) unless
// WARIFURI_SECRETARY_CONNECTORS is on. The key is only in mcp.json: never on the command line,
// in the environment or in a log.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { openLedger } from '../ledger/ledger.mjs';
import { initHome, decodeText } from '../config.mjs';
import { findOnPath, setEnvLine, PACKAGE_ROOT, SERVER_NAME } from '../client/connect.mjs';
import { JOBS, parseWhen, parseNight, localIso, showWhen } from './schedule.mjs';

export const DEVICE = 'secretary';
export const DIR = 'secretary';
export const INSTRUCTIONS_DIR = path.join(PACKAGE_ROOT, 'harness', 'secretary');
// Claude Code names an MCP server's tools mcp__<server>__<tool>; the bare mcp__<server> rule
// allows all of them (the same as mcp__warifuri__*, and understood by older versions too).
export const ALLOWED = `mcp__${SERVER_NAME}`;
// Built-in tools of Claude Code that are refused outright, so the secretary cannot run
// commands, read or write files, or go to the web. Names unknown to a version are ignored.
export const DISALLOWED = [
  'Bash', 'BashOutput', 'KillShell', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'NotebookRead', 'Read', 'Glob',
  'Grep', 'LS', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'TodoWrite', 'Skill', 'SlashCommand',
];
export const JOB_TITLES = { nightly: '毎晩の見張りと組み直し', morning: '朝の報告', inbox: '受信箱の整理' };

export const paths = (home) => {
  const dir = path.join(home, DIR);
  return { dir, mcp: path.join(dir, 'mcp.json'), lock: path.join(dir, 'run.lock'), logs: path.join(dir, 'logs'), chat: path.join(dir, 'chat') };
};

export const ownerOnlyDir = (dir, platform) => {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform !== 'win32') fs.chmodSync(dir, 0o700);
};

// The URL claude reaches this server at: on this machine, so the loopback address unless
// serve listens on one address only.
export function serverUrl(values) {
  const host = values.WARIFURI_HOST ?? '127.0.0.1';
  const local = ['0.0.0.0', '::', ''].includes(host) ? '127.0.0.1' : host;
  return `http://${local.includes(':') ? `[${local}]` : local}:${values.WARIFURI_PORT ?? '8787'}/mcp`;
}

// The schedule from the settings: { jobs, night, timeoutMs, calendarTools, connectors }.
export function scheduleFrom(values) {
  const jobs = {
    nightly: parseWhen(values.WARIFURI_SECRETARY_NIGHTLY ?? '23:00'),
    morning: parseWhen(values.WARIFURI_SECRETARY_MORNING ?? '07:00'),
    inbox: parseWhen(values.WARIFURI_SECRETARY_INBOX ?? 'sun 23:00'),
  };
  const night = parseNight(values.WARIFURI_SECRETARY_NIGHT ?? '23:00-07:00');
  const calendarTools = (values.WARIFURI_SECRETARY_CALENDAR_TOOLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    jobs,
    night,
    timeoutMs: Number(values.WARIFURI_SECRETARY_TIMEOUT ?? '20') * 60_000,
    calendarTools,
    connectors: values.WARIFURI_SECRETARY_CONNECTORS === 'on',
  };
}

export const describeSchedule = (s) =>
  `${JOBS.map((j) => `${j} ${showWhen(s.jobs[j])}`).join(', ')} (night ${fmtNight(s.night)})`;
export const fmtNight = (n) => {
  const t = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return `${t(n.start)}-${t(n.end)}`;
};

// The key in mcp.json, or null.
export function readSecretaryKey(home) {
  try {
    const json = JSON.parse(decodeText(fs.readFileSync(paths(home).mcp)).text);
    const auth = json?.mcpServers?.[SERVER_NAME]?.headers?.Authorization ?? '';
    const m = /^Bearer (wf_[A-Za-z0-9_-]+)$/.exec(auth);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Writes mcp.json (owner-only) for this server and key.
export function writeMcpConfig(home, { url, key, platform = process.platform }) {
  const p = paths(home);
  ownerOnlyDir(p.dir, platform);
  const json = { mcpServers: { [SERVER_NAME]: { type: 'http', url, headers: { Authorization: `Bearer ${key}` } } } };
  const text = `${JSON.stringify(json, null, 2)}\n`;
  const tmp = `${p.mcp}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  if (platform !== 'win32') fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, p.mcp);
  return p.mcp;
}

function setSetting(cfg, name, value) {
  const file = cfg.files.settings;
  if (!fs.existsSync(file)) initHome(cfg.home);
  const text = decodeText(fs.readFileSync(file)).text;
  const next = setEnvLine(text, name, value);
  if (next !== text) fs.writeFileSync(file, next);
  return file;
}

// `warifuri secretary enable`: { lines, problems }. Nothing is written when claude is missing.
export function enable(cfg, ctx = {}) {
  const env = ctx.env ?? process.env;
  const platform = ctx.platform ?? process.platform;
  const lines = [];
  const claude = findOnPath('claude', env, platform);
  if (!claude) {
    return {
      lines,
      problems: [
        'claude (Claude Code) is not on PATH on this machine, so the secretary cannot run here. Install Claude Code on the server machine, log in once, and run warifuri secretary enable again. Nothing was scheduled.',
      ],
    };
  }
  const values = cfg.values;
  const url = serverUrl(values);
  let key = readSecretaryKey(cfg.home);
  let ledger;
  try {
    fs.mkdirSync(cfg.home, { recursive: true, mode: 0o700 });
    ledger = openLedger(values.WARIFURI_DB);
    if (key && ledger.deviceForKey(key)?.name === DEVICE) {
      lines.push(`kept the key of device ${DEVICE}`);
    } else {
      const device = ledger.listDevices().find((d) => d.name === DEVICE);
      if (device?.has_key) {
        // Its key lived only in mcp.json, which is gone or holds another key: replace it.
        ledger.revokeKey(DEVICE, { actor: 'cli' });
        lines.push(`revoked the old key of device ${DEVICE}, whose config was lost`);
      }
      key = ledger.issueKey(DEVICE, { actor: 'cli' }).key;
      lines.push(`issued a key for device ${DEVICE}`);
    }
  } catch (err) {
    return { lines, problems: [`cannot issue the secretary's key: ${err.problems ? err.problems.join('; ') : err.message}`] };
  } finally {
    ledger?.close();
  }
  const file = writeMcpConfig(cfg.home, { url, key, platform });
  lines.push(`wrote the secretary's MCP config to ${file} (readable only by you; it holds the key)`);
  lines.push(`wrote WARIFURI_SECRETARY=on in ${setSetting(cfg, 'WARIFURI_SECRETARY', 'on')}`);
  if (env.WARIFURI_SECRETARY && env.WARIFURI_SECRETARY !== 'on') lines.push(`note: WARIFURI_SECRETARY=${env.WARIFURI_SECRETARY} in the environment wins over the file`);
  lines.push(`schedule: ${describeSchedule(scheduleFrom(values))}`);
  lines.push(
    '',
    'Do these yourself on this machine:',
    `  1. Log in to Claude Code once: run ${claude} and log in. The secretary runs as you; warifuri never reads that login.`,
    '  2. Restart warifuri serve, so that it starts the schedule.',
    '  3. To try a job now, with warifuri serve running: warifuri secretary run morning',
  );
  return { lines, problems: [] };
}

// `warifuri secretary disable`: the schedule off, and the secretary's key revoked.
export function disable(cfg) {
  const lines = [`wrote WARIFURI_SECRETARY=off in ${setSetting(cfg, 'WARIFURI_SECRETARY', 'off')}`];
  if (fs.existsSync(cfg.values.WARIFURI_DB)) {
    let ledger;
    try {
      ledger = openLedger(cfg.values.WARIFURI_DB);
      const device = ledger.listDevices().find((d) => d.name === DEVICE);
      if (device?.has_key) {
        ledger.revokeKey(DEVICE, { actor: 'cli' });
        lines.push(`revoked the key of device ${DEVICE}; warifuri secretary enable issues a new one`);
      }
    } finally {
      ledger?.close();
    }
  }
  lines.push('Restart warifuri serve, so that it stops the schedule.');
  return { lines, problems: [] };
}

// The lines that open every prompt: the work, the time, the night and the calendar.
export function factLines(title, name, { now, schedule }) {
  const calendar = schedule.calendarTools.length
    ? `カレンダーの MCP として ${schedule.calendarTools.map((t) => `\`${t}\``).join('、')} を使えます。`
    : schedule.connectors
      ? 'claude.ai のコネクタが有効です。カレンダーのコネクタがあれば、カレンダーとして使えます。'
      : 'カレンダーの MCP はつながっていません。カレンダーの手順は飛ばします。';
  return [
    '# この実行について',
    '',
    `- 仕事: ${title}(\`${name}\`)`,
    `- いまの日時: ${localIso(now)}(サーバーの機械の時刻)`,
    `- 夜の時間帯: ${fmtNight(schedule.night).replace('-', '〜')}`,
    `- ${calendar}`,
  ];
}

export const readInstructions = (name, instructionsDir = INSTRUCTIONS_DIR) => fs.readFileSync(path.join(instructionsDir, name), 'utf8').trim();

// The prompt: the facts of this run, the common rules, the job's instructions.
export function buildPrompt(job, { now = new Date(), schedule, instructionsDir = INSTRUCTIONS_DIR } = {}) {
  const head = factLines(JOB_TITLES[job], job, { now, schedule }).join('\n');
  return `${head}\n\n${readInstructions('common.md', instructionsDir)}\n\n${readInstructions(`${job}.md`, instructionsDir)}\n`;
}

// The command line of one run. The key is not in it: claude reads it from mcp.json.
export function claudeArgs({ mcpFile, schedule }) {
  const allowed = [ALLOWED, ...schedule.calendarTools];
  return [
    '-p',
    '--mcp-config', mcpFile,
    ...(schedule.calendarTools.length ? [] : ['--strict-mcp-config']),
    '--allowedTools', allowed.join(','),
    '--disallowedTools', DISALLOWED.join(','),
  ];
}

// The environment of claude: the server's, without warifuri's own settings and secrets, and
// with the claude.ai connectors off unless the person turned them on.
export function claudeEnv(env, schedule) {
  const out = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('WARIFURI_')));
  if (!schedule.connectors) out.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  return out;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Takes the run lock; false when a live process holds it.
function lock(file) {
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const pid = Number(fs.readFileSync(file, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) return false;
      fs.unlinkSync(file);
    }
  }
  return false;
}

// The log file of this run; the one before is kept as <job>.prev.log.
export function openLog(dir, job, platform) {
  ownerOnlyDir(dir, platform);
  const file = path.join(dir, `${job}.log`);
  if (fs.existsSync(file)) fs.renameSync(file, path.join(dir, `${job}.prev.log`));
  const fd = fs.openSync(file, 'w', 0o600);
  if (platform !== 'win32') fs.chmodSync(file, 0o600);
  return { file, fd };
}

// Starts claude. A .cmd or .bat on Windows (npm's shim) needs the shell, with quoted arguments.
export function defaultSpawn(file, args, options) {
  if (options.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const q = (a) => `"${String(a).replace(/"/g, '""')}"`;
    return spawn(q(file), args.map(q), { ...options, shell: true });
  }
  return spawn(file, args, options);
}

export function kill(child, platform) {
  if (platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else child.kill('SIGTERM');
}

// Runs one job: resolves to { code, signal, timedOut, logFile } or { busy } or { error }.
// ctx: { env, platform, now, spawn, signal, timeoutMs, instructionsDir } (tests stand in here).
export async function runJob(job, cfg, ctx = {}) {
  if (!JOBS.includes(job)) return { error: `no job ${job} (${JOBS.join(', ')})` };
  const env = ctx.env ?? process.env;
  const platform = ctx.platform ?? process.platform;
  const schedule = scheduleFrom(cfg.values);
  const claude = findOnPath('claude', env, platform);
  if (!claude) return { error: 'claude (Claude Code) is not on PATH' };
  const key = readSecretaryKey(cfg.home);
  if (!key) return { error: 'no secretary config; run warifuri secretary enable' };
  const p = paths(cfg.home);
  // The port or host may have changed since enable.
  writeMcpConfig(cfg.home, { url: serverUrl(cfg.values), key, platform });
  if (!lock(p.lock)) return { busy: true };
  let log;
  try {
    const prompt = buildPrompt(job, { now: (ctx.now ?? (() => new Date()))(), schedule, instructionsDir: ctx.instructionsDir });
    log = openLog(p.logs, job, platform);
    const child = (ctx.spawn ?? defaultSpawn)(claude, claudeArgs({ mcpFile: p.mcp, schedule }), {
      env: claudeEnv(env, schedule),
      stdio: ['pipe', log.fd, log.fd],
      platform,
      windowsHide: true,
    });
    return await new Promise((resolve) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        kill(child, platform);
      }, ctx.timeoutMs ?? schedule.timeoutMs);
      const onAbort = () => kill(child, platform);
      ctx.signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ error: `cannot start claude: ${err.message}`, logFile: log.file });
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
        resolve({ code, signal, timedOut, logFile: log.file });
      });
      child.stdin?.on('error', () => {});
      child.stdin?.end(prompt);
    });
  } finally {
    if (log) fs.closeSync(log.fd);
    try {
      fs.unlinkSync(p.lock);
    } catch {
      // already gone
    }
  }
}

// Whether serve can start the schedule: { schedule } or { problem }.
export function readyToSchedule(cfg, ctx = {}) {
  const env = ctx.env ?? process.env;
  const platform = ctx.platform ?? process.platform;
  if (!findOnPath('claude', env, platform)) return { problem: 'claude (Claude Code) is not on PATH, so nothing is scheduled' };
  if (!readSecretaryKey(cfg.home)) return { problem: 'no secretary config; run warifuri secretary enable' };
  return { schedule: scheduleFrom(cfg.values) };
}
