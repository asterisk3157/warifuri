// The Web screens: カレンダー, タスク, サーバー, 秘書 and 設定, for the person to read the ledger in a
// browser. The pages are static files in src/web/ (no build step), fed by read-only JSON under
// /web/api/. The writes are the person's profile (name, bio, colour), kept in the settings
// table, and the conversation with the secretary on 秘書: a message (with files), an answer to
// a question, a thread started from a message and read. Each is recorded. The secretary's
// reply being written comes as Server-Sent Events from /web/api/secretary/stream: only its
// words and the kinds of its steps, never what the tools were given or returned.
//
// Who may look:
// - Open: when the server listens only on this machine (a loopback host), no public URL is
//   set and no proxy is trusted, a request from this machine needs no login. "From this
//   machine" means a loopback socket, no forwarding headers, and a Host header naming
//   localhost, 127.0.0.1 or [::1] (so a page elsewhere cannot rebind its name to us).
// - Login: otherwise, a browser needs a session cookie. `warifuri serve` prints a one-time
//   login URL at startup (a random token, single use, 15 minutes). The token rides after the
//   # so that it never reaches a proxy or a server log: the page posts it back, and that sets an
//   HttpOnly, SameSite=Strict cookie (Secure over https). When the GitHub login is on, the
//   login page offers it too, for the one person allowed (oauth.mjs). A session lasts 30 days
//   and is kept (as a hash) in the data directory, so a restart of the server does not end it.
// Device keys and OAuth tokens are never taken here, as cookies or otherwise. No response
// carries a key, a token or a hash of one.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { CLOSED_STATES } from '../ledger/rules.mjs';
import { LedgerError, SECRETARY_THREAD, ATTACHMENTS_MAX } from '../ledger/ledger.mjs';
import { PROPOSAL_ANSWERS, MESSAGE_MAX, ANSWER_MAX, AUTONOMY_KINDS } from '../ledger/rules.mjs';
import { paths as secretaryPaths } from '../secretary/secretary.mjs';
import { listBackups } from '../ledger/backup.mjs';
import { profileDir } from '../knowledge/profiles.mjs';
import { rateLimit } from './limit.mjs';
import { cleanClientName } from './oauth.mjs';

// Pictures a sent message shows in its bubble; other files show only their name.
const PREVIEW_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ASSETS_DIR = path.join(HERE, '..', 'web');
const PACKAGE = path.join(HERE, '..', '..', 'package.json');

export const PAGES = ['calendar', 'tasks', 'server', 'secretary', 'settings'];
export const LOGIN_MS = 15 * 60 * 1000;
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
// The file in the data directory that keeps the Web screens' sessions across restarts.
export const SESSIONS_FILE = 'web-sessions.json';
const MAX_LOGINS = 10;
const MAX_SESSIONS = 100;
const RECENT_DONE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RANGE_MS = 42 * 24 * 60 * 60 * 1000;
// How many messages of the conversation (and of a thread) the 秘書 screen shows.
const SECRETARY_MESSAGES = 150;
// A file sent with a message, at most; and how often the event stream says it is alive.
export const UPLOAD_MAX = 5 * 1024 * 1024;
const PING_MS = 25_000;

// The profile's colours to choose from, and its limits.
export const PROFILE_COLORS = ['#8cc4ea', '#8fd3b2', '#a9a3ec', '#e7a9d8', '#f1c47e', '#c9ced6'];
export const NAME_MAX = 40;
export const BIO_MAX = 400;

// Colours of the profiles' dots when profile.yaml gives none: a few common names, and a
// neutral one for the rest. A profile picks its own with `color: "#rrggbb"` in profile.yaml.
const DEFAULT_PROFILE_COLORS = { 研究: '#a9a3ec', サークル: '#8fd3b2', 就活: '#f1c47e', 個人開発: '#e7a9d8' };
export const NEUTRAL_COLOR = '#c9ced6';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const FORWARD_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip'];

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const random = () => randomBytes(32).toString('base64url');

// Is this host one that only this machine can reach?
export function isLoopbackHost(host) {
  if (typeof host !== 'string') return false;
  const h = host.trim().toLowerCase();
  return LOOPBACK_HOSTS.has(h) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

const loopbackAddress = (a) => typeof a === 'string' && (a === '::1' || /^(::ffff:)?127\./.test(a));

// The host name of a Host header, without the port.
function hostName(header) {
  if (typeof header !== 'string' || header === '') return '';
  if (header.startsWith('[')) return header.slice(0, header.indexOf(']') + 1);
  return header.replace(/:\d+$/, '');
}

const readVersion = () => {
  try {
    return JSON.parse(fs.readFileSync(PACKAGE, 'utf8')).version ?? null;
  } catch {
    return null;
  }
};

// The OS of the server's machine, as people call it: macOS 26 rather than Darwin 25.
function osName() {
  const release = os.release();
  if (process.platform === 'darwin') {
    const major = Number(release.split('.')[0]);
    return major >= 25 ? `macOS ${major + 1}` : major >= 20 ? `macOS ${major - 9}` : `macOS (Darwin ${release})`;
  }
  if (process.platform === 'linux') {
    try {
      const m = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(fs.readFileSync('/etc/os-release', 'utf8'));
      if (m) return m[1];
    } catch {
      // Not every Linux has /etc/os-release.
    }
    return `Linux ${release}`;
  }
  if (typeof os.version === 'function' && os.version()) return os.version();
  return `${os.type()} ${release}`;
}

// The server's machine, for the dialog the bottom-left card opens.
export function machineInfo() {
  const cpus = os.cpus();
  const kind = { darwin: 'mac', win32: 'windows', linux: 'linux' }[process.platform] ?? 'other';
  return {
    name: os.hostname(),
    kind,
    chip: cpus[0]?.model?.trim() || os.arch(),
    cores: cpus.length,
    memory_gb: Math.round(os.totalmem() / 1024 ** 3),
    os: osName(),
  };
}

// The colour of each profile named: profile.yaml's `color`, a default, or the neutral one.
function profileColors(home, names) {
  const out = {};
  for (const name of names) {
    if (typeof name !== 'string' || name === '' || name in out) continue;
    let color;
    if (home) {
      try {
        const text = fs.readFileSync(path.join(profileDir(home, name), 'profile.yaml'), 'utf8');
        color = /^color:\s*["']?(#[0-9a-fA-F]{6})["']?\s*(#.*)?$/m.exec(text)?.[1]?.toLowerCase();
      } catch {
        // No profile.yaml, or a name that cannot be a folder: use the default.
      }
    }
    out[name] = color ?? DEFAULT_PROFILE_COLORS[name] ?? NEUTRAL_COLOR;
  }
  return out;
}

// The newest backup in <home>/backups (warifuri backup --dir), as an ISO time, or null.
function lastBackup(home) {
  if (!home) return null;
  const dir = path.join(home, 'backups');
  try {
    const [newest] = listBackups(dir);
    return newest ? fs.statSync(path.join(dir, newest)).mtime.toISOString() : null;
  } catch {
    return null;
  }
}

// Checks a profile write: { values } or { problems }.
export function checkProfile(body) {
  const problems = [];
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { problems: ['送る形は JSON のオブジェクトです'] };
  const unknown = Object.keys(body).filter((k) => !['name', 'bio', 'color'].includes(k));
  if (unknown.length) problems.push(`${unknown.join('、')} は書けません`);
  const name = typeof body.name === 'string' ? body.name.trim() : null;
  if (name === null || name === '') problems.push('名前を書きます');
  else if ([...name].length > NAME_MAX) problems.push(`名前は ${NAME_MAX} 文字までです`);
  // eslint-disable-next-line no-control-regex
  else if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(name)) problems.push('名前には改行や制御文字を入れられません');
  const bio = body.bio === undefined || body.bio === null ? '' : typeof body.bio === 'string' ? body.bio.replace(/\r\n?/g, '\n').trim() : null;
  if (bio === null) problems.push('自己紹介は文字列です');
  else if ([...bio].length > BIO_MAX) problems.push(`自己紹介は ${BIO_MAX} 文字までです`);
  // eslint-disable-next-line no-control-regex
  else if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(bio)) problems.push('自己紹介には制御文字を入れられません');
  const color = typeof body.color === 'string' ? body.color.toLowerCase() : null;
  if (!PROFILE_COLORS.includes(color)) problems.push(`色は ${PROFILE_COLORS.join('、')} のどれかです`);
  if (problems.length) return { problems };
  return { values: { name, bio, color } };
}

// Sessions and one-time login tokens. Only hashes are kept. With file, the sessions are also
// kept there (hash and expiry, readable by the owner only), so that a restart of the server
// does not log the browser out; login tokens stay in memory.
function sessionStore(now, file = null) {
  const logins = new Map();
  const sessions = new Map();
  if (file) {
    try {
      for (const [k, exp] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) {
        if (/^[0-9a-f]{64}$/.test(k) && Number.isFinite(exp)) sessions.set(k, exp);
      }
    } catch {
      // No file yet, or one that cannot be read: start with no sessions.
    }
  }
  const save = () => {
    if (!file) return;
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      // The data directory cannot be written: the sessions last until the server stops.
    }
  };
  const sweep = (map) => {
    const t = now();
    for (const [k, exp] of map) if (exp <= t) map.delete(k);
  };
  const cap = (map, max) => {
    while (map.size > max) map.delete(map.keys().next().value);
  };
  return {
    issueLogin() {
      sweep(logins);
      const token = random();
      logins.set(sha256(token), now() + LOGIN_MS);
      cap(logins, MAX_LOGINS);
      return token;
    },
    // Uses a login token up: true once, while it has not expired.
    takeLogin(token) {
      if (typeof token !== 'string' || token === '' || token.length > 200) return false;
      const key = sha256(token);
      const exp = logins.get(key);
      logins.delete(key);
      return exp !== undefined && exp > now();
    },
    newSession() {
      sweep(sessions);
      const id = random();
      sessions.set(sha256(id), now() + SESSION_MS);
      cap(sessions, MAX_SESSIONS);
      save();
      return id;
    },
    validSession(id) {
      if (typeof id !== 'string' || id === '' || id.length > 200) return false;
      const exp = sessions.get(sha256(id));
      return exp !== undefined && exp > now();
    },
  };
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function guard(res) {
  res.set({
    'Content-Security-Policy': PAGE_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
  });
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// A small page of its own (login done, login needed), with the app's stylesheet.
function notice(res, status, title, text, link) {
  guard(res);
  const cls = link?.button ? ' class="wf-button"' : '';
  const a = link ? `<p><a href="${escapeHtml(link.href)}"${cls}>${escapeHtml(link.text)}</a></p>` : '';
  const refresh = link?.refresh ? `<meta http-equiv="refresh" content="0;url=${escapeHtml(link.href)}">` : '';
  res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${refresh}` +
        `<title>warifuri · ${escapeHtml(title)}</title><link rel="stylesheet" href="/web/app.css"></head>` +
        `<body class="wf-notice"><main><h1>${escapeHtml(title)}</h1>${text ? `<p>${escapeHtml(text)}</p>` : ''}${a}</main></body></html>`,
    );
}

// The router of the Web screens. ledger: the open ledger. home: the data directory (profile
// colours, backups), or null. host: the address the server listens on. publicUrl: the
// public URL, or null. trustProxy: express's trust proxy value, when one is set. githubUser:
// the GitHub login of the person, when the GitHub login is on. limit: the rate limit per
// address. githubLogin: whether the login page offers GitHub (the router of oauth.mjs then
// calls finishLogin). chat: the conversation runner (src/secretary/chat.mjs), or null when the
// secretary is off. now: the clock (ms). Returns { router, mode, issueLogin, finishLogin }.
export function createWeb({
  ledger,
  home = null,
  host = '127.0.0.1',
  publicUrl = null,
  trustProxy,
  githubUser = null,
  githubLogin = false,
  chat = null,
  limit = { max: 600, windowMs: 60_000 },
  now = Date.now,
  startedAt = now(),
  assetsDir = ASSETS_DIR,
}) {
  const mode = isLoopbackHost(host) && !publicUrl && trustProxy === undefined ? 'open' : 'login';
  const secure = typeof publicUrl === 'string' && publicUrl.startsWith('https://');
  const cookieName = secure ? '__Host-warifuri_web' : 'warifuri_web';
  const store = sessionStore(now, home ? path.join(home, SESSIONS_FILE) : null);
  const version = readVersion();
  const publicOrigin = publicUrl ? new URL(publicUrl).origin : null;

  // A request from this machine, in the open mode: loopback socket, nothing forwarded, and a
  // Host that names this machine.
  const fromThisMachine = (req) =>
    loopbackAddress(req.socket.remoteAddress) &&
    FORWARD_HEADERS.every((h) => req.headers[h] === undefined) &&
    isLoopbackHost(hostName(req.headers.host));

  const allowed = (req) => (mode === 'open' && fromThisMachine(req)) || store.validSession(readCookie(req, cookieName));

  const origin = (req) => publicOrigin ?? `${req.protocol}://${req.get('host')}`;

  const router = express.Router();
  const limited = rateLimit(limit);
  router.use('/web', limited);

  // A write from a browser: JSON from this origin only. A form from elsewhere cannot send
  // application/json, and a script elsewhere is stopped by the Origin check.
  const fromOwnPage = (req) => {
    const site = req.headers['sec-fetch-site'];
    const from = req.headers.origin;
    const own = new Set([origin(req), `${req.protocol}://${req.get('host')}`]);
    return !((site !== undefined && site !== 'same-origin') || typeof from !== 'string' || !own.has(from));
  };
  // A file from a browser: from this origin only, as raw bytes.
  const sameOriginUpload = (req, res, next) => {
    if (!fromOwnPage(req)) {
      res.status(403).json({ error: 'cross-origin request refused' });
      return;
    }
    next();
  };
  const sameOrigin = (req, res, next) => {
    if (!fromOwnPage(req)) {
      res.status(403).json({ error: 'cross-origin request refused' });
      return;
    }
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'send application/json' });
      return;
    }
    next();
  };
  const smallJson = express.json({ limit: '8kb', strict: true });
  // A message may be MESSAGE_MAX characters of three bytes each.
  const messageJson = express.json({ limit: '32kb', strict: true });

  // The one-time login. The page reads the token after the #, posts it here and goes on to the
  // calendar, so that the next request is same-site and the Strict cookie goes.
  router.get('/web/login', (req, res) => {
    guard(res);
    res
      .type('html')
      .send(
        '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
          '<title>warifuri · ログイン</title><link rel="stylesheet" href="/web/app.css"><script src="/web/login.js" defer></script></head>' +
          '<body class="wf-notice"><main><h1 id="title">ログインしています</h1><p id="text">少し待ってください。</p>' +
          '<noscript><p>ログインには JavaScript が要ります。</p></noscript></main></body></html>',
      );
  });
  router.post('/web/login', sameOrigin, smallJson, (req, res) => {
    if (!store.takeLogin(typeof req.body?.token === 'string' ? req.body.token : '')) {
      guard(res);
      res.status(403).json({ error: 'login refused' });
      return;
    }
    const id = store.newSession();
    guard(res);
    res.cookie(cookieName, id, { httpOnly: true, sameSite: 'strict', secure, path: '/', maxAge: SESSION_MS });
    res.json({ next: '/calendar' });
  });

  router.get('/', limited, (req, res) => res.redirect(302, '/calendar'));

  // Pages: the same shell for each; the script reads the path.
  for (const p of PAGES) {
    router.get(`/${p}`, limited, (req, res) => {
      if (!allowed(req)) {
        if (githubLogin) notice(res, 401, 'warifuri へようこそ', '', { href: '/web/login/github', text: 'GitHub でログイン', button: true });
        else notice(res, 401, 'warifuri へようこそ', 'warifuri serve が起動したときに表示した、ログインの URL を開いてください。');
        return;
      }
      guard(res);
      res.sendFile(path.join(assetsDir, 'app.html'));
    });
  }

  // The scripts and stylesheet: public code, served to anyone.
  router.use(
    '/web',
    (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
      return next();
    },
    express.static(assetsDir, { index: false, dotfiles: 'ignore', redirect: false }),
  );

  const api = express.Router();
  api.use((req, res, next) => {
    guard(res);
    if (!allowed(req)) {
      res.status(401).json({ error: 'login required' });
      return;
    }
    next();
  });

  const nowIso = () => new Date(now()).toISOString();
  const serverLabel = publicUrl ? 'サーバー' : 'ローカルホスト';
  const mcpUrl = (req) => `${origin(req)}/mcp`;

  api.get('/about', (req, res) => {
    res.json({ now: nowIso(), mode, place: publicUrl ? 'server' : 'local', label: serverLabel, url: origin(req), mcp_url: mcpUrl(req), machine: machineInfo() });
  });

  api.get('/calendar', (req, res) => {
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    let out;
    try {
      out = ledger.schedule({ from, to });
    } catch (err) {
      if (err instanceof LedgerError) return res.status(400).json({ error: 'bad range', problems: err.problems });
      throw err;
    }
    if (Date.parse(out.to) - Date.parse(out.from) > MAX_RANGE_MS) return res.status(400).json({ error: 'bad range', problems: ['期間は42日までです'] });
    const bookings = out.bookings.map((b) => ({
      id: b.id, title: b.title, kind: b.kind, starts_at: b.starts_at, ends_at: b.ends_at, note: b.note,
      task: b.task, habit: b.habit, goal: b.goal, profile: b.profile,
    }));
    return res.json({ now: nowIso(), from: out.from, to: out.to, bookings, profiles: profileColors(home, bookings.map((b) => b.profile)) });
  });

  // The open tasks with their holds, and for each task the ones before it.
  function openWork() {
    const board = ledger.board({ includeClosed: true });
    const closed = (s) => CLOSED_STATES.includes(s);
    const all = new Map();
    for (const g of board.goals) for (const t of g.tasks) all.set(t.id, t);
    for (const t of board.unassigned) all.set(t.id, t);
    const before = new Map();
    for (const e of ledger.blocks()) {
      if (!before.has(e.after_id)) before.set(e.after_id, []);
      before.get(e.after_id).push(e.before_id);
    }
    return { board, all, before, closed };
  }

  const taskOut = (t, { all, before, closed }, inList) => {
    const prev = before.get(t.id) ?? [];
    // Tasks before this one that are still open, in this goal or another (順番待ち).
    const open = prev.map((id) => all.get(id) ?? ledger.get(id)).filter((x) => x && !closed(x.state));
    return {
      id: t.id, title: t.title, state: t.state, mode: t.mode, due: t.due, due_provisional: t.due_provisional,
      next: t.next, waiting_on: t.waiting_on, waiting_for: t.waiting_for, defer_until: t.defer_until,
      closed_at: t.closed_at, goal_id: t.goal_id,
      hold: t.hold ? { device: t.hold.device, place_id: t.hold.place_id, place_name: t.hold.place_name, since: t.hold.since } : null,
      after: prev.filter((id) => inList.has(id)),
      open_before: open.map((x) => ({ id: x.id, title: x.title })),
      blocked: t.state === 'ready' && open.length > 0,
    };
  };

  api.get('/tasks', (req, res) => {
    const work = openWork();
    const t0 = now();
    const goals = work.board.goals
      .filter((g) => !work.closed(g.state))
      .map((g) => {
        const tasks = g.tasks.filter((t) => t.state !== 'discarded');
        const ids = new Set(tasks.map((t) => t.id));
        return {
          id: g.id, title: g.title, outcome: g.outcome, due: g.due, due_provisional: g.due_provisional, state: g.state,
          mode: g.mode, profile: g.profile, tasks: tasks.map((t) => taskOut(t, work, ids)),
        };
      });
    const loose = work.board.unassigned.filter(
      (t) => !work.closed(t.state) || (t.state === 'done' && t.closed_at && t0 - Date.parse(t.closed_at) <= RECENT_DONE_MS),
    );
    const looseIds = new Set(loose.map((t) => t.id));
    const unassigned = loose.map((t) => ({ ...taskOut(t, work, looseIds), profile: t.profile ?? null }));
    const names = [...goals.map((g) => g.profile), ...unassigned.map((t) => t.profile)];
    res.json({ now: nowIso(), goals, unassigned, profiles: profileColors(home, names) });
  });

  // Each device that is not revoked, with the tasks it holds (one per place) and the
  // directory of that place on the device.
  function devicesWithHolds() {
    const { all } = openWork();
    const paths = new Map(ledger.listPlaces().map((p) => [p.id, p]));
    const loggedIn = new Set(ledger.oauth.tokenActivity().filter((a) => a.live).map((a) => a.device));
    return ledger
      .listDevices()
      .filter((d) => d.revoked_at === null)
      .map((d) => ({
        name: d.name,
        created_at: d.created_at,
        last_seen_at: d.last_seen_at,
        has_key: d.has_key,
        github_login: loggedIn.has(d.name),
        holds: [...all.values()]
          .filter((t) => t.hold?.device === d.name)
          .map((t) => {
            const place = t.hold.place_id ? paths.get(t.hold.place_id) : null;
            return {
              task_id: t.id, title: t.title, profile: t.profile ?? place?.profile ?? null,
              place_name: place?.name ?? null, path: place?.paths.find((p) => p.device === d.name)?.path ?? null, since: t.hold.since,
            };
          }),
      }));
  }

  api.get('/server', (req, res) => {
    const devices = devicesWithHolds();
    const names = devices.flatMap((d) => d.holds.map((h) => h.profile));
    res.json({
      now: nowIso(), version, started_at: new Date(startedAt).toISOString(), uptime_s: Math.max(0, Math.floor((now() - startedAt) / 1000)),
      mcp_url: mcpUrl(req), label: serverLabel, last_backup_at: lastBackup(home), devices, profiles: profileColors(home, names),
    });
  });

  // 秘書: the conversation, oldest first (the newest at the bottom). The person's and the
  // secretary's messages with what goes with them (the steps of the work, the reply buttons,
  // the scheduled mark, the names of the files), warifuri's notes, and the secretary's
  // questions. Reports and proposals stay in the ledger: the secretary talks about them.
  const messageOut = (m) => {
    if (m.kind === 'ask') {
      return {
        type: 'ask', id: m.id, state: m.state, created_at: m.created_at,
        questions: (m.data?.questions ?? []).map((q) => ({ header: q.header, question: q.question, multiSelect: q.multiSelect, options: q.options.map((o) => ({ label: o.label, description: o.description })) })),
        answers: (m.data?.answers ?? []).map((a) => (a ? { picked: a.picked, other: a.other, at: a.at } : null)),
      };
    }
    const d = m.data ?? {};
    return {
      type: 'message', id: m.id, role: m.role, kind: m.kind, body: m.body, created_at: m.created_at,
      steps: (d.steps ?? []).map((x) => ({ kind: x.kind, label: x.label })),
      options: d.options ?? [],
      scheduled: d.scheduled ?? null,
      files: (d.attachments ?? []).map((a) => ({
        name: a.name, type: a.type, size: a.size,
        preview: PREVIEW_TYPES.includes(a.type) ? `/web/api/secretary/files/${encodeURIComponent(a.id)}` : null,
      })),
      files_only: d.files_only === true,
      answer: m.kind === 'answer' ? { ask: d.ask ?? null, index: d.index ?? null, header: d.header ?? null, later: d.later === true, changed: d.changed === true } : null,
    };
  };
  // What the window shows of a thread: not warifuri's calls, the digests or the old proposals.
  const shown = (m) => !['trigger', 'digest', 'proposal'].includes(m.kind);
  const secretaryOut = () => {
    const thread = ledger.getThread(SECRETARY_THREAD.kind);
    const messages = thread ? ledger.listMessages(thread.id, { limit: SECRETARY_MESSAGES }) : [];
    const status = chat ? chat.status() : { on: false, replying: false, waiting: 0 };
    return {
      now: nowIso(), secretary: { on: status.on, replying: status.replying }, thread: thread?.id ?? null,
      items: messages.filter(shown).map(messageOut), threads: ledger.threadCounts(),
    };
  };
  const threadOut = (t) => {
    const parent = ledger.getMessage(t.parent_id);
    return {
      now: nowIso(), secretary: { on: Boolean(chat?.on), replying: Boolean(chat?.replying(t.id)) },
      thread: { id: t.id, title: t.title, parent_id: t.parent_id }, parent: parent ? messageOut(parent) : null,
      items: ledger.listMessages(t.id, { limit: SECRETARY_MESSAGES }).filter(shown).map(messageOut),
    };
  };
  const subThread = (id) => {
    const t = typeof id === 'string' ? ledger.getThread(id) : null;
    return t?.kind === 'sub' ? t : null;
  };
  const refused = (res, err) => {
    if (err instanceof LedgerError) return res.status(400).json({ error: 'refused', problems: err.problems });
    throw err;
  };
  const exact = (body, keys) => body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every((k) => keys.includes(k));

  api.get('/secretary', (req, res) => res.json(secretaryOut()));

  // A message to the secretary: { text, attachments?, thread? }. The reply comes later: the
  // event stream shows it being written, and the screen reads it again.
  api.post('/secretary/messages', sameOrigin, messageJson, (req, res) => {
    const body = req.body;
    const files = body?.attachments;
    if (!exact(body, ['text', 'attachments', 'thread']) || typeof body.text !== 'string'
      || (files !== undefined && (!Array.isArray(files) || files.length > ATTACHMENTS_MAX || files.some((f) => typeof f !== 'string')))
      || (body.thread !== undefined && typeof body.thread !== 'string')) {
      res.status(400).json({ error: 'refused', problems: [`送る形は { "text": "…", "attachments": ["a_…"], "thread": "c_…" } です(${MESSAGE_MAX} 文字まで、ファイルは${ATTACHMENTS_MAX}個まで)`] });
      return;
    }
    if (!chat?.on) {
      res.status(409).json({ error: 'secretary off', problems: ['秘書が止まっているので、送れません'] });
      return;
    }
    if (body.thread !== undefined && !subThread(body.thread)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    try {
      const m = chat.send(body.text, { actor: 'web', device: null }, { thread: body.thread, attachments: files });
      res.status(202).json({ id: m.id, ...(body.thread ? threadOut(subThread(body.thread)) : secretaryOut()) });
    } catch (err) {
      refused(res, err);
    }
  });

  // The person's answer to a question of the secretary: { index, picked: [labels], other } or
  // { later: true }. Answering a question again changes the answer. It works with the
  // secretary off too; the secretary takes it on its next turn.
  api.post('/secretary/asks/:id', sameOrigin, smallJson, (req, res) => {
    const body = req.body;
    const ok = exact(body, ['index', 'picked', 'other', 'later'])
      && (body.later === undefined || body.later === true)
      && (body.index === undefined || Number.isInteger(body.index))
      && (body.picked === undefined || (Array.isArray(body.picked) && body.picked.every((x) => typeof x === 'string')))
      && (body.other === undefined || typeof body.other === 'string');
    if (!ok) {
      res.status(400).json({ error: 'refused', problems: [`送る形は { "index": 0, "picked": ["…"], "other": "…" } か { "later": true } です(その他は ${ANSWER_MAX} 文字まで)`] });
      return;
    }
    const target = ledger.getMessage(req.params.id);
    if (!target || target.kind !== 'ask') {
      res.status(404).json({ error: 'not found' });
      return;
    }
    try {
      const writer = { actor: 'web', device: null };
      const out = chat ? chat.answer(target.id, body, writer) : ledger.answerAsk(target.id, body, writer);
      const t = ledger.getThread(target.thread_id);
      res.json({ id: out.message.id, ...(t.kind === 'sub' ? threadOut(t) : secretaryOut()) });
    } catch (err) {
      refused(res, err);
    }
  });

  // A thread from a message: { parent }. The one there is, or a new one.
  api.post('/secretary/threads', sameOrigin, smallJson, (req, res) => {
    if (!exact(req.body, ['parent']) || typeof req.body.parent !== 'string') {
      res.status(400).json({ error: 'refused', problems: ['送る形は { "parent": "m_…" } です'] });
      return;
    }
    try {
      const t = ledger.openThread(req.body.parent, { actor: 'web', device: null });
      res.json(threadOut(t));
    } catch (err) {
      refused(res, err);
    }
  });

  api.get('/secretary/threads/:id', (req, res) => {
    const t = subThread(req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    return res.json(threadOut(t));
  });

  // The person has read the thread (it was open on the screen).
  api.post('/secretary/threads/:id/read', sameOrigin, smallJson, (req, res) => {
    const t = subThread(req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    ledger.markThreadRead(t.id, { actor: 'web', device: null });
    return res.json({ threads: ledger.threadCounts() });
  });

  // A file for a message: the bytes as the body, its type as Content-Type and its name in
  // X-File-Name (URI-encoded), from this origin only, at most UPLOAD_MAX. It is kept owner-only
  // under the data directory and goes with the next message that names it.
  const rawBody = express.raw({ type: () => true, limit: UPLOAD_MAX });
  api.post('/secretary/uploads', sameOriginUpload, rawBody, (req, res) => {
    if (!home) {
      res.status(409).json({ error: 'no data directory', problems: ['このサーバーには、ファイルを置くデータのフォルダがありません'] });
      return;
    }
    let name = '';
    try {
      name = decodeURIComponent(String(req.headers['x-file-name'] ?? '')).normalize('NFC');
    } catch {
      name = '';
    }
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (bytes.length === 0) {
      res.status(400).json({ error: 'refused', problems: ['空のファイルは送れません'] });
      return;
    }
    let a;
    try {
      a = ledger.addAttachment({ name, type, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, { actor: 'web', device: null });
    } catch (err) {
      refused(res, err);
      return;
    }
    const dir = secretaryPaths(home).uploads;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
    const tmp = path.join(dir, `${a.id}.part`);
    fs.writeFileSync(tmp, bytes, { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, path.join(dir, a.id));
    res.status(201).json({ id: a.id, name: a.name, type: a.type, size: a.size });
  });

  // The secretary's replies as they are written, as Server-Sent Events: 'hello' with the
  // replies being written now, then 'live' ({ thread, phase, text, steps, scheduled }) and
  // 'done' ({ thread, message }). A comment every PING_MS keeps the connection open.
  // A picture sent with a message, for its bubble: only pictures, only ones that went with a
  // message, read from the owner-only folder, never as anything the browser could run.
  api.get('/secretary/files/:id', (req, res) => {
    const a = home ? ledger.getAttachment(req.params.id) : null;
    const file = a ? path.join(secretaryPaths(home).uploads, a.id) : null;
    if (!a || !a.message_id || !PREVIEW_TYPES.includes(a.type) || !/^[A-Za-z0-9_-]+$/.test(a.id) || !fs.existsSync(file)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.set({
      'Content-Type': a.type,
      'Content-Disposition': 'inline',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=86400',
    });
    res.send(fs.readFileSync(file));
  });

  api.get('/secretary/stream', (req, res) => {
    res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.flushHeaders();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const liveOut = (e) => ({ thread: e.thread, phase: e.phase, text: e.text, steps: (e.steps ?? []).map((x) => ({ kind: x.kind, label: x.label })), scheduled: e.scheduled ?? null });
    send('hello', { on: Boolean(chat?.on), live: chat ? chat.live().map(liveOut) : [] });
    const off = chat?.subscribe((e) => {
      if (e.type === 'live') send('live', liveOut(e));
      else if (e.type === 'done') send('done', { thread: e.thread, message: e.message ?? null });
    });
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
    ping.unref?.();
    req.on('close', () => {
      off?.();
      clearInterval(ping);
    });
  });

  // The person's answer to an open proposal: { answer: approved | changed | refused, text }.
  // It works with the secretary off too; the secretary carries it out on its next run.
  api.post('/secretary/proposals/:id', sameOrigin, smallJson, (req, res) => {
    const body = req.body;
    const ok = body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every((k) => ['answer', 'text'].includes(k));
    if (!ok || !PROPOSAL_ANSWERS.includes(body.answer) || (body.text !== undefined && typeof body.text !== 'string')) {
      res.status(400).json({ error: 'refused', problems: [`送る形は { "answer": "${PROPOSAL_ANSWERS.join('|')}", "text": "…" } です(${ANSWER_MAX} 文字まで)`] });
      return;
    }
    const target = ledger.getMessage(req.params.id);
    if (!target || target.kind !== 'proposal') {
      res.status(404).json({ error: 'not found' });
      return;
    }
    try {
      const out = ledger.answerProposal(target.id, { answer: body.answer, said: body.text }, { actor: 'web', device: null });
      res.json({ announce: out.outcome.announce, ...secretaryOut() });
    } catch (err) {
      if (err instanceof LedgerError) return res.status(400).json({ error: 'refused', problems: err.problems });
      throw err;
    }
    return undefined;
  });

  api.get('/settings', (req, res) => {
    const activity = ledger.oauth.tokenActivity();
    const loggedIn = new Set(activity.filter((a) => a.live).map((a) => a.device));
    const names = new Map(ledger.oauth.listClients().map((c) => [c.client_id, cleanClientName(c.client_name) ?? null]));
    const places = ledger.listPlaces().map((p) => ({ id: p.id, name: p.name, profile: p.profile, paths: p.paths }));
    const devices = ledger.listDevices().map((d) => ({
      name: d.name,
      secret: d.has_key ? 'on' : d.revoked_at ? 'revoked' : 'none',
      github_login: loggedIn.has(d.name),
      created_at: d.created_at,
      revoked_at: d.revoked_at,
    }));
    const apps = activity
      .filter((a) => a.live)
      .map((a) => ({ client_id: a.client_id, client_name: names.get(a.client_id) ?? null, device: a.device, last_token_at: a.last_at }))
      .sort((a, b) => (a.last_token_at < b.last_token_at ? 1 : -1));
    res.json({ now: nowIso(), places, devices, apps, profiles: profileColors(home, places.map((p) => p.profile)) });
  });

  const profileOut = () => {
    const s = ledger.getSettings('profile');
    return { name: s.name ?? null, bio: s.bio ?? '', color: PROFILE_COLORS.includes(s.color) ? s.color : PROFILE_COLORS[0], github: githubUser };
  };

  api.get('/profile', (req, res) => res.json(profileOut()));

  // The person's profile.
  api.post('/profile', sameOrigin, smallJson, (req, res) => {
    const checked = checkProfile(req.body);
    if (checked.problems) {
      res.status(400).json({ error: 'refused', problems: checked.problems });
      return;
    }
    ledger.setSettings('profile', checked.values, { actor: 'web', device: null });
    res.json(profileOut());
  });

  api.use((req, res) => res.status(404).json({ error: 'not found' }));
  // A body that is not JSON, or too long, is the caller's mistake; nothing else is echoed.
  api.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      res.status(err.status).json({ error: err.type === 'entity.too.large' ? 'too large' : 'bad json' });
      return;
    }
    next(err);
  });
  router.use('/web/api', api);

  // Starts a session after the GitHub login, and moves on to the calendar with a page of its
  // own, so that the next request is same-site and the Strict cookie goes.
  const finishLogin = (res) => {
    res.cookie(cookieName, store.newSession(), { httpOnly: true, sameSite: 'strict', secure, path: '/', maxAge: SESSION_MS });
    notice(res, 200, 'ログインしました', '', { href: '/calendar', text: 'カレンダーを開く', refresh: true });
  };

  return { router, mode, issueLogin: () => store.issueLogin(), finishLogin };
}
