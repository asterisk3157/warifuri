// The Web screens: カレンダー, タスク, サーバー and 設定, for the person to read the ledger in a
// browser. The pages are static files in src/web/ (no build step), fed by read-only JSON under
// /web/api/. The one write is the person's profile (name, bio, colour), kept in the settings
// table and recorded.
//
// Who may look:
// - Open: when the server listens only on this machine (a loopback host), no public URL is
//   set and no proxy is trusted, a request from this machine needs no login. "From this
//   machine" means a loopback socket, no forwarding headers, and a Host header naming
//   localhost, 127.0.0.1 or [::1] (so a page elsewhere cannot rebind its name to us).
// - Login: otherwise, a browser needs a session cookie. `warifuri serve` prints a one-time
//   login URL at startup (a random token, single use, 15 minutes); opening it sets an
//   HttpOnly, SameSite=Strict cookie (Secure over https). Sessions live in memory, so a
//   restart ends them and prints a new URL.
// Device keys and OAuth tokens are never taken here, as cookies or otherwise. No response
// carries a key, a token or a hash of one.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { CLOSED_STATES } from '../ledger/rules.mjs';
import { LedgerError } from '../ledger/ledger.mjs';
import { listBackups } from '../ledger/backup.mjs';
import { profileDir } from '../knowledge/profiles.mjs';
import { rateLimit } from './limit.mjs';
import { cleanClientName } from './oauth.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ASSETS_DIR = path.join(HERE, '..', 'web');
const PACKAGE = path.join(HERE, '..', '..', 'package.json');

export const PAGES = ['calendar', 'tasks', 'server', 'settings'];
export const LOGIN_MS = 15 * 60 * 1000;
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_LOGINS = 10;
const MAX_SESSIONS = 100;
const RECENT_DONE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RANGE_MS = 42 * 24 * 60 * 60 * 1000;

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

// Sessions and one-time login tokens, in memory. Only hashes are kept.
function sessionStore(now) {
  const logins = new Map();
  const sessions = new Map();
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
  const a = link ? `<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.text)}</a></p>` : '';
  const refresh = link?.refresh ? `<meta http-equiv="refresh" content="0;url=${escapeHtml(link.href)}">` : '';
  res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${refresh}` +
        `<title>warifuri · ${escapeHtml(title)}</title><link rel="stylesheet" href="/web/app.css"></head>` +
        `<body class="wf-notice"><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>${a}</main></body></html>`,
    );
}

// The router of the Web screens. ledger: the open ledger. home: the data directory (profile
// colours, backups), or null. host: the address the server listens on. publicUrl: the
// public URL, or null. trustProxy: express's trust proxy value, when one is set. githubUser:
// the GitHub login of the person, when the GitHub login is on. limit: the rate limit per
// address. now: the clock (ms). Returns { router, mode, issueLogin }.
export function createWeb({
  ledger,
  home = null,
  host = '127.0.0.1',
  publicUrl = null,
  trustProxy,
  githubUser = null,
  limit = { max: 600, windowMs: 60_000 },
  now = Date.now,
  startedAt = now(),
  assetsDir = ASSETS_DIR,
}) {
  const mode = isLoopbackHost(host) && !publicUrl && trustProxy === undefined ? 'open' : 'login';
  const secure = typeof publicUrl === 'string' && publicUrl.startsWith('https://');
  const cookieName = secure ? '__Host-warifuri_web' : 'warifuri_web';
  const store = sessionStore(now);
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

  // The one-time login: uses the token up, starts a session, and moves on to the calendar
  // with a page of its own, so that the next request is same-site and the Strict cookie goes.
  router.get('/web/login', (req, res) => {
    if (!store.takeLogin(typeof req.query.token === 'string' ? req.query.token : '')) {
      notice(res, 403, 'ログインできません', 'この URL は使えません。1回だけ、15分まで使えます。warifuri serve を動かし直すと、新しい URL を表示します。');
      return;
    }
    const id = store.newSession();
    res.cookie(cookieName, id, { httpOnly: true, sameSite: 'strict', secure, path: '/', maxAge: SESSION_MS });
    notice(res, 200, 'ログインしました', 'カレンダーを開きます。', { href: '/calendar', text: 'カレンダーを開く', refresh: true });
  });

  router.get('/', limited, (req, res) => res.redirect(302, '/calendar'));

  // Pages: the same shell for each; the script reads the path.
  for (const p of PAGES) {
    router.get(`/${p}`, limited, (req, res) => {
      if (!allowed(req)) {
        notice(res, 401, 'ログインが要ります', 'warifuri serve が起動したときに表示した、ログインの URL を開いてください。');
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
  const serverLabel = publicUrl ? 'サーバー' : 'ローカル';
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
    return ledger
      .listDevices()
      .filter((d) => d.revoked_at === null)
      .map((d) => ({
        name: d.name,
        created_at: d.created_at,
        last_seen_at: d.last_seen_at,
        has_key: d.has_key,
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

  // The one write. A browser sends the JSON from this origin only: a form from elsewhere
  // cannot send application/json, and a script elsewhere is stopped by the Origin check.
  api.post('/profile', (req, res, next) => {
    const site = req.headers['sec-fetch-site'];
    const from = req.headers.origin;
    const own = new Set([origin(req), `${req.protocol}://${req.get('host')}`]);
    if ((site !== undefined && site !== 'same-origin') || typeof from !== 'string' || !own.has(from)) {
      res.status(403).json({ error: 'cross-origin request refused' });
      return;
    }
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'send application/json' });
      return;
    }
    next();
  }, express.json({ limit: '8kb', strict: true }), (req, res) => {
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

  return { router, mode, issueLogin: () => store.issueLogin() };
}
