// The Web screens (src/server/web.mjs): who may look (open on this machine, else a one-time
// login and a session cookie), the shapes of the read endpoints, the writes (the profile, and
// on 秘書 a message and the answer of a proposal), and that no key, token or hash ever leaves.
// The layout of the flowchart (src/web/flow.js) is checked here too.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openLedger } from '../src/ledger/ledger.mjs';
import { createServer } from '../src/server/mcp.mjs';
import { checkProfile, isLoopbackHost } from '../src/server/web.mjs';
import { layoutFlow } from '../src/web/flow.js';

const ACTOR = { actor: 'human' };

// A ledger with a goal and ordered tasks, a goal-less task, places, devices (one revoked),
// held tasks, a booking, a report from the secretary, an OAuth app with live tokens, and a
// backup in home/backups.
async function start(t, options = {}) {
  let tick = 0;
  const ledger = openLedger(':memory:', { now: () => new Date(Date.now() + (tick += 1)) });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-web-'));
  fs.mkdirSync(path.join(home, 'backups'));
  fs.writeFileSync(path.join(home, 'backups', 'ledger-20261024-010203.sqlite'), '');
  fs.mkdirSync(path.join(home, 'profiles', 'hobby'), { recursive: true });
  fs.writeFileSync(path.join(home, 'profiles', 'hobby', 'profile.yaml'), 'color: "#123abc"\n');
  const goal = ledger.createGoal({ title: 'Thesis', mode: 'ai_worker', outcome: 'a draft', profile: 'research', due: '2026-12-01', due_provisional: true }, ACTOR);
  const a = ledger.createTask({ title: 'Read', mode: 'ai_worker', goal_id: goal.id }, ACTOR);
  const b = ledger.createTask({ title: 'Write', mode: 'ai_worker', goal_id: goal.id }, ACTOR);
  const c = ledger.createTask({ title: 'Gone', mode: 'ai_worker', goal_id: goal.id }, ACTOR);
  ledger.setState(c.id, 'discarded', { reason: 'no' }, ACTOR);
  ledger.link(a.id, b.id, ACTOR);
  const loose = ledger.createTask({ title: '<img src=x onerror=alert(1)>', mode: 'ai_worker' }, ACTOR);
  const hobby = ledger.createGoal({ title: 'Garden', mode: 'ai_worker', profile: 'hobby' }, ACTOR);
  ledger.createTask({ title: 'Weed', mode: 'ai_worker', goal_id: hobby.id }, ACTOR);
  const p1 = ledger.createPlace({ name: 'thesis', profile: 'research', paths: [{ device: 'laptop', path: '/home/alex/thesis' }] }, ACTOR);
  const p2 = ledger.createPlace({ name: 'misc', paths: [{ device: 'laptop', path: '/home/alex/misc' }] }, ACTOR);
  const laptop = ledger.issueKey('laptop', ACTOR);
  const desk = ledger.issueKey('desk', ACTOR);
  ledger.issueKey('lost', ACTOR);
  ledger.revokeKey('lost', ACTOR);
  ledger.start(a.id, { device: 'laptop', placeId: p1.id }, { actor: 'agent', device: 'laptop' });
  ledger.start(loose.id, { device: 'laptop', placeId: p2.id }, { actor: 'agent', device: 'laptop' });
  ledger.book({ kind: 'task', task_id: a.id, starts_at: '2026-10-25T09:00:00+09:00', ends_at: '2026-10-25T10:00:00+09:00' }, ACTOR);
  ledger.writeReport({ kind: 'nightly', title: '<b>Night</b>', body: '- on track\n- <script>x</script>' }, { actor: 'device-key', device: 'desk' });
  // An app that logged in with GitHub and chose the desk.
  const client = ledger.oauth.registerClient({ client_name: 'Test Agent', redirect_uris: ['http://localhost:9/cb'] });
  const pending = ledger.oauth.createPending({ clientId: client.client_id, redirectUri: 'http://localhost:9/cb', codeChallenge: 'c', scopes: [] });
  ledger.oauth.setPendingLogin(pending.id, 'alex');
  const { code } = ledger.oauth.approve(pending.id, 'desk', ACTOR);
  const { tokens } = ledger.oauth.exchangeCode(client.client_id, code, 'http://localhost:9/cb');

  const server = createServer({ ledger, home, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    ledger.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const secrets = [laptop.key, desk.key, ...Object.values(tokens).filter((v) => typeof v === 'string' && v.startsWith('wf'))];
  return { base, server, ledger, home, secrets, ids: { goal: goal.id, a: a.id, b: b.id, c: c.id, loose: loose.id } };
}

const get = (base, p, headers = {}) => fetch(`${base}${p}`, { headers, redirect: 'manual' });
// The login page posts the token it read after the #.
const login = (base, token, headers = {}) =>
  fetch(`${base}/web/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify({ token }) });

// fetch sets Host itself; node:http sends the Host we give. Resolves to the status.
const rawStatus = (base, p, headers) =>
  new Promise((resolve, reject) => {
    http.get(`${base}${p}`, { headers }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });

test('isLoopbackHost and checkProfile', () => {
  for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.1.2.3']) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ['0.0.0.0', '192.168.1.2', 'example.org', '', undefined]) assert.equal(isLoopbackHost(h), false, String(h));
  assert.deepEqual(checkProfile({ name: ' Alex ', bio: 'a\r\nb', color: '#8FD3B2' }).values, { name: 'Alex', bio: 'a\nb', color: '#8fd3b2' });
  assert.ok(checkProfile({ name: 'x'.repeat(41), color: '#8cc4ea' }).problems);
  assert.equal(checkProfile({ name: '字'.repeat(40), color: '#8cc4ea' }).values.name.length, 40);
  assert.ok(checkProfile({ name: 'a', bio: 'b'.repeat(401), color: '#8cc4ea' }).problems);
  assert.ok(checkProfile({ name: 'a\nb', color: '#8cc4ea' }).problems);
  assert.ok(checkProfile({ name: '', color: '#8cc4ea' }).problems);
  assert.ok(checkProfile({ name: 'a', color: '#ff0000' }).problems);
  assert.ok(checkProfile({ name: 'a', color: '#8cc4ea', admin: true }).problems);
  assert.ok(checkProfile([]).problems);
});

test('open on this machine: pages and endpoints answer without a login', async (t) => {
  const { base, server } = await start(t);
  assert.equal(server.web.mode, 'open');
  const root = await get(base, '/');
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/calendar');
  for (const p of ['/calendar', '/tasks', '/server', '/secretary', '/settings']) {
    const res = await get(base, p);
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(await res.text(), /\/web\/app\.js/);
  }
  for (const p of ['/web/app.js', '/web/app.css', '/web/ui.js', '/web/flow.js', '/web/pages/tasks.js', '/web/pages/secretary.js']) {
    assert.equal((await get(base, p)).status, 200, p);
  }
  assert.equal((await get(base, '/web/api/nothing')).status, 404);
  assert.equal((await get(base, '/health')).status, 200);
});

test('open mode still refuses a forwarded request or a foreign Host (DNS rebinding)', async (t) => {
  const { base } = await start(t);
  assert.equal(await rawStatus(base, '/web/api/about', { Host: 'evil.example' }), 401);
  assert.equal(await rawStatus(base, '/web/api/about', { 'X-Forwarded-For': '203.0.113.9' }), 401);
  assert.equal(await rawStatus(base, '/calendar', { Host: 'evil.example:80' }), 401);
  assert.equal(await rawStatus(base, '/web/api/about', { Host: 'localhost:1234' }), 200);
});

test('endpoint shapes', async (t) => {
  const { base, ids } = await start(t);
  const about = await (await get(base, '/web/api/about')).json();
  assert.equal(about.mode, 'open');
  assert.equal(about.label, 'ローカルホスト');
  assert.match(about.mcp_url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  for (const k of ['name', 'kind', 'chip', 'memory_gb', 'os']) assert.ok(k in about.machine, k);

  const tasks = await (await get(base, '/web/api/tasks')).json();
  const thesis = tasks.goals.find((g) => g.id === ids.goal);
  assert.equal(thesis.outcome, 'a draft');
  assert.equal(thesis.due_provisional, true);
  assert.deepEqual(thesis.tasks.map((x) => x.title), ['Read', 'Write']);
  const write = thesis.tasks.find((x) => x.id === ids.b);
  assert.deepEqual(write.after, [ids.a]);
  assert.deepEqual(write.open_before, [{ id: ids.a, title: 'Read' }]);
  assert.equal(write.blocked, true);
  const read = thesis.tasks.find((x) => x.id === ids.a);
  assert.equal(read.hold.device, 'laptop');
  assert.equal(read.hold.place_name, 'thesis');
  assert.equal(tasks.unassigned[0].id, ids.loose);
  assert.equal(tasks.profiles.research, '#c9ced6');
  assert.equal(tasks.profiles.hobby, '#123abc');

  const cal = await (await get(base, `/web/api/calendar?from=${encodeURIComponent('2026-10-25T00:00:00+09:00')}&to=${encodeURIComponent('2026-10-26T00:00:00+09:00')}`)).json();
  assert.equal(cal.bookings.length, 1);
  assert.equal(cal.bookings[0].task.title, 'Read');
  assert.equal(cal.bookings[0].profile, 'research');
  assert.equal((await get(base, '/web/api/calendar?from=nope')).status, 400);
  assert.equal((await get(base, '/web/api/calendar?from=2026-01-01&to=2026-06-01')).status, 400);

  const srv = await (await get(base, '/web/api/server')).json();
  assert.equal(srv.version, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version);
  assert.equal(typeof srv.uptime_s, 'number');
  assert.match(srv.last_backup_at, /^\d{4}-/);
  assert.deepEqual(srv.devices.map((d) => d.name), ['desk', 'laptop']);
  const laptop = srv.devices.find((d) => d.name === 'laptop');
  assert.deepEqual(laptop.holds.map((h) => [h.title, h.place_name, h.path]).sort(), [
    ['<img src=x onerror=alert(1)>', 'misc', '/home/alex/misc'],
    ['Read', 'thesis', '/home/alex/thesis'],
  ]);
  assert.equal(srv.devices.find((d) => d.name === 'desk').github_login, true);

  const st = await (await get(base, '/web/api/settings')).json();
  assert.deepEqual(st.devices.map((d) => [d.name, d.secret, d.github_login]), [['desk', 'on', true], ['laptop', 'on', false], ['lost', 'revoked', false]]);
  assert.deepEqual(st.apps.map((a) => [a.client_name, a.device]), [['Test Agent', 'desk']]);
  assert.match(st.apps[0].last_token_at, /^\d{4}-/);
  assert.deepEqual(st.places.map((p) => p.name).sort(), ['misc', 'thesis']);

  const profile = await (await get(base, '/web/api/profile')).json();
  assert.deepEqual(profile, { name: null, bio: '', color: '#8cc4ea', github: null });

  // The window is the conversation only: the report stays in the ledger.
  const sec = await (await get(base, '/web/api/secretary')).json();
  assert.match(sec.now, /^\d{4}-/);
  assert.deepEqual([sec.items, sec.threads, sec.thread], [[], {}, null]);
});

test('秘書: the conversation only, oldest first, with questions; reports, proposals and warifuri\'s calls stay out', async (t) => {
  const { base, ledger } = await start(t);
  const S = { actor: 'device-key', device: 'secretary' };
  ledger.writeReport({ kind: 'morning', title: 'R', body: 'b' }, S);
  const thread = ledger.ensureThread('secretary', { actor: 'web' });
  ledger.addMessage(thread.id, { role: 'system', kind: 'trigger', body: '朝の時間です', data: { job: 'morning' } }, S);
  const m = ledger.addMessage(thread.id, { role: 'secretary', body: '<b>おはようございます</b>', data: { steps: [{ kind: 'read', label: '予定を読みました' }], options: ['置いて'], scheduled: 'morning', secret: 'x' } }, S);
  ledger.addMessage(thread.id, { role: 'system', kind: 'digest', body: 'スレッドで…' }, S);
  ledger.propose({ kind: 'close_forgotten', title: '閉じる', body: '記録から' }, S);
  const a = ledger.ask({ questions: [{ header: 'タスク整理', question: 'どうしますか？', options: [{ label: '残す', description: 'd' }, { label: '閉じる' }], kind: 'close_forgotten' }] }, S);
  ledger.openThread(m.id, { actor: 'web' });
  const out = await (await get(base, '/web/api/secretary')).json();
  assert.deepEqual(out.secretary, { on: false, replying: false });
  assert.deepEqual(out.items.map((x) => [x.type, x.role ?? x.state]), [['message', 'secretary'], ['ask', 'open']]);
  const [msg, ask] = out.items;
  assert.deepEqual(Object.keys(msg).sort(), ['answer', 'body', 'created_at', 'files', 'files_only', 'id', 'kind', 'options', 'request', 'role', 'scheduled', 'steps', 'type']);
  assert.equal(msg.body, '<b>おはようございます</b>', 'returned as the text it is; the page builds the DOM');
  assert.deepEqual([msg.steps, msg.options, msg.scheduled], [[{ kind: 'read', label: '予定を読みました' }], ['置いて'], 'morning']);
  assert.deepEqual(ask, {
    type: 'ask', id: a.id, state: 'open', created_at: a.created_at, answers: [null],
    questions: [{ header: 'タスク整理', question: 'どうしますか？', multiSelect: false, options: [{ label: '残す', description: 'd' }, { label: '閉じる', description: '' }] }],
  });
  assert.equal(out.thread, thread.id);
  assert.equal(out.threads[m.id].count, 0);
  assert.ok(!JSON.stringify(out).includes('close_forgotten'), 'the autonomy kind of a question is the secretary\'s business');

  const bare = openLedger(':memory:');
  const server = createServer({ ledger: bare });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    bare.close();
  });
  const empty = await (await get(`http://127.0.0.1:${server.address().port}`, '/web/api/secretary')).json();
  assert.deepEqual(empty.items, []);
});

// A chat that stores the message as the real one does, and counts the sends.
function stubChat(ledger, on = true) {
  const sent = [];
  return {
    sent,
    on,
    send(text, writer) {
      sent.push({ text, writer });
      return ledger.addMessage(ledger.ensureThread('secretary', writer).id, { role: 'user', body: text }, writer);
    },
    status: () => ({ on, replying: on && sent.length > 0, waiting: 0 }),
  };
}

test('秘書: a message goes to the chat, JSON from this origin only, and not while the secretary is off', async (t) => {
  let chat;
  const { base, ledger } = await start(t, { chat: { on: true, send: (...a) => chat.send(...a), status: () => chat.status() } });
  chat = stubChat(ledger);
  const post = (body, headers = {}) =>
    fetch(`${base}/web/api/secretary/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  assert.equal((await post({ text: 'hi' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ text: 'hi' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post('text=hi', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await post({ text: 1 })).status, 400);
  assert.equal((await post({ text: 'hi', to: 'x' })).status, 400);
  assert.equal(chat.sent.length, 0);
  // The ledger's rules answer for the text itself, in Japanese.
  const blank = await post({ text: '  ' });
  assert.equal(blank.status, 400);
  assert.match((await blank.json()).problems.join(' '), /本文/);
  // 4000 characters of Japanese is more than the 8 KB a profile may send.
  const long = await post({ text: 'あ'.repeat(4000) });
  assert.equal(long.status, 202);
  const ok = await post({ text: 'おはよう' }, { 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(ok.status, 202);
  const out = await ok.json();
  assert.match(out.id, /^m_/);
  assert.equal(out.items.at(-1).body, 'おはよう');
  assert.deepEqual(out.secretary, { on: true, replying: true });
  assert.deepEqual(chat.sent.at(-1).writer, { actor: 'web', device: null });
  assert.equal(ledger.records(out.id)[0].entity, 'message');
});

test('秘書: sending is refused while the secretary is off', async (t) => {
  const { base, ledger } = await start(t);
  const res = await fetch(`${base}/web/api/secretary/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ text: 'hi' }) });
  assert.equal(res.status, 409);
  assert.match((await res.json()).problems[0], /止まっている/);
  assert.equal(ledger.getThread(), null);
});

test('秘書: answering a proposal marks it, records autonomy_outcome and tells the session, once', async (t) => {
  const { base, ledger } = await start(t);
  const S = { actor: 'device-key', device: 'secretary' };
  const p = ledger.propose({ kind: 'reschedule_block', title: '予定を明日へ', body: 'b' }, S);
  const answer = (id, body, headers = {}) =>
    fetch(`${base}/web/api/secretary/proposals/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body) });
  assert.equal((await answer(p.id, { answer: 'approved' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await answer(p.id, { answer: 'revoked' })).status, 400);
  assert.equal((await answer(p.id, { answer: 'approved', by: 'x' })).status, 400);
  assert.equal((await answer('m_20261025000000_nothin', { answer: 'approved' })).status, 404);
  const empty = await answer(p.id, { answer: 'changed', text: ' ' });
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).problems[0], /どう直すか/);
  assert.equal(ledger.getMessage(p.id).state, 'open');

  const res = await answer(p.id, { answer: 'changed', text: '明後日にして' });
  assert.equal(res.status, 200);
  const out = await res.json();
  const item = ledger.getMessage(p.id);
  assert.deepEqual([item.state, item.answer], ['changed', '明後日にして']);
  assert.match(out.items.at(-1).body, /直して了承されました。\n本人の言葉: 明後日にして/);
  assert.equal(out.items.at(-1).role, 'system');
  const rec = ledger.records('reschedule_block').at(-1);
  assert.deepEqual([rec.entity, rec.actor, rec.changes.outcome], ['autonomy', 'web', 'changed']);
  assert.equal((await answer(p.id, { answer: 'approved' })).status, 400);
  assert.deepEqual(ledger.listProposals().map((x) => x.id), [p.id]);
});

test('the profile: JSON from this origin only, checked, kept in settings and recorded', async (t) => {
  const { base, ledger } = await start(t);
  const post = (body, headers = {}) =>
    fetch(`${base}/web/api/profile`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  assert.equal((await post({ name: 'Alex', color: '#8cc4ea' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(`${base}/web/api/profile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await post({ name: 'Alex', color: '#8cc4ea' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post('name=Alex', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await post('{not json')).status, 400);
  const bad = await post({ name: '', color: 'red' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).problems.length, 2);
  assert.equal(ledger.records('profile').length, 0);

  const ok = await post({ name: 'Alex', bio: 'Mornings are best.', color: '#a9a3ec' }, { 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { name: 'Alex', bio: 'Mornings are best.', color: '#a9a3ec', github: null });
  assert.deepEqual(ledger.getSettings('profile'), { bio: 'Mornings are best.', color: '#a9a3ec', name: 'Alex' });
  const recs = ledger.records('profile');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].entity, 'settings');
  assert.equal(recs[0].actor, 'web');
  assert.deepEqual(recs[0].changes.name, { before: null, after: 'Alex' });
  // The same values again change nothing and record nothing.
  assert.equal((await post({ name: 'Alex', bio: 'Mornings are best.', color: '#a9a3ec' })).status, 200);
  assert.equal(ledger.records('profile').length, 1);
  assert.equal((await (await get(base, '/web/api/profile')).json()).name, 'Alex');
});

test('beyond this machine: a one-time login URL gives an HttpOnly, SameSite=Strict session', async (t) => {
  const { base, server, secrets } = await start(t, { host: '0.0.0.0' });
  assert.equal(server.web.mode, 'login');
  assert.equal((await get(base, '/calendar')).status, 401);
  assert.equal((await get(base, '/web/api/tasks')).status, 401);
  assert.equal((await get(base, '/secretary')).status, 401);
  assert.equal((await get(base, '/web/api/secretary')).status, 401);
  // Static code is not data; it is served to anyone.
  assert.equal((await get(base, '/web/app.js')).status, 200);
  // Keys and tokens are not taken, as a cookie or a bearer.
  for (const s of secrets) {
    assert.equal((await get(base, '/web/api/tasks', { Cookie: `warifuri_web=${s}` })).status, 401);
    assert.equal((await get(base, '/web/api/tasks', { Authorization: `Bearer ${s}` })).status, 401);
  }
  // The page itself takes no token; it reads the one after the # and posts it.
  const page = await get(base, '/web/login');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await page.text(), /src="\/web\/login\.js"/);
  assert.equal((await get(base, '/web/login.js')).status, 200);
  assert.equal((await login(base, 'wrong')).status, 403);

  const token = server.web.issueLogin();
  assert.equal((await get(base, `/web/login?token=${token}`)).headers.get('set-cookie'), null);
  assert.equal((await login(base, token, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await login(base, token, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const ok = await login(base, token, { 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /^warifuri_web=[A-Za-z0-9_-]{43};/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  assert.doesNotMatch(cookie, /Secure/);
  assert.deepEqual(await ok.json(), { next: '/calendar' });
  // Single use.
  assert.equal((await login(base, token)).status, 403);

  const session = cookie.split(';')[0];
  assert.equal((await get(base, '/calendar', { Cookie: session })).status, 200);
  assert.equal((await get(base, '/web/api/tasks', { Cookie: session })).status, 200);
  assert.equal((await get(base, '/web/api/secretary', { Cookie: session })).status, 200);
  assert.equal((await get(base, '/web/api/tasks', { Cookie: 'warifuri_web=forged' })).status, 401);
  assert.equal((await get(base, '/web/api/secretary', { Cookie: 'warifuri_web=forged' })).status, 401);
});

test('with an https public URL the cookie is __Host- and Secure, and the label is サーバー', async (t) => {
  const { base, server } = await start(t, { publicUrl: 'https://wf.example.org' });
  assert.equal(server.web.mode, 'login');
  const res = await login(base, server.web.issueLogin());
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /^__Host-warifuri_web=/);
  assert.match(cookie, /Secure/);
  const about = await (await get(base, '/web/api/about', { Cookie: cookie.split(';')[0] })).json();
  assert.equal(about.label, 'サーバー');
  assert.equal(about.mcp_url, 'https://wf.example.org/mcp');
});

test('login tokens expire after 15 minutes', async (t) => {
  const { createWeb } = await import('../src/server/web.mjs');
  let clock = 1_000_000;
  const ledger = openLedger(':memory:');
  t.after(() => ledger.close());
  const web = createWeb({ ledger, host: '0.0.0.0', now: () => clock });
  const express = (await import('express')).default;
  const app = express();
  app.use(web.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = web.issueLogin();
  clock += 15 * 60 * 1000 + 1;
  assert.equal((await login(base, token)).status, 403);
  const fresh = web.issueLogin();
  clock += 60 * 1000;
  assert.equal((await login(base, fresh)).status, 200);
});

test('no key, token or hash leaves any endpoint', async (t) => {
  const { base, server, secrets } = await start(t, { host: '0.0.0.0' });
  const cookie = (await login(base, server.web.issueLogin())).headers.get('set-cookie').split(';')[0];
  const sid = cookie.split('=')[1];
  assert.ok(secrets.length >= 4, 'two keys and the access and refresh tokens');
  const forbidden = [...secrets, ...secrets.map((s) => createHash('sha256').update(s).digest('hex')), sid];
  for (const p of ['about', 'tasks', 'server', 'secretary', 'settings', 'profile', 'calendar']) {
    const text = await (await get(base, `/web/api/${p}`, { Cookie: cookie })).text();
    for (const s of forbidden) assert.equal(text.includes(s), false, `${p} leaks ${s.slice(0, 6)}`);
    assert.doesNotMatch(text, /key_hash|wf[arc]?_[A-Za-z0-9_-]{20}/, p);
  }
});

test('flow layout: columns by order depth, relays through gaps, and loops do not hang', () => {
  const lay = layoutFlow([
    { id: 'a', after: [] },
    { id: 'b', after: ['a'] },
    { id: 'c', after: ['b'] },
    { id: 'd', after: ['a', 'c'] },
  ]);
  assert.equal(lay.nodes.a.x, 0);
  assert.equal(lay.nodes.b.x, 182);
  assert.equal(lay.nodes.d.x, 3 * 182);
  assert.equal(lay.edges.length, 4);
  // a → d spans two columns: it gets relay points, so its path has straight runs (L).
  assert.match(lay.edges.find((e) => e.from === 'a' && e.to === 'd').d, /L/);
  assert.equal(lay.width, 4 * 182 - 32);

  const loop = layoutFlow([{ id: 'x', after: ['y'] }, { id: 'y', after: ['x'] }, { id: 'z', after: ['z', 'missing'] }]);
  assert.equal(Object.keys(loop.nodes).length, 3);
  assert.ok(Number.isFinite(loop.width) && Number.isFinite(loop.height));
  assert.deepEqual(layoutFlow([]), { nodes: {}, edges: [], width: 0, height: 0 });
});

test('schema 5: settings changes are records; the server keys stay out of getSettings', () => {
  const ledger = openLedger(':memory:');
  ledger.oauth.pinGithubId(42, 'alex');
  assert.deepEqual(ledger.getSettings('profile'), {});
  ledger.setSettings('profile', { name: 'A' }, ACTOR);
  ledger.setSettings('profile', { name: null }, ACTOR);
  assert.deepEqual(ledger.getSettings('profile'), {});
  assert.deepEqual(ledger.records('profile').map((r) => r.changes.name.after), ['A', null]);
  assert.throws(() => ledger.setSettings('Profile', { name: 'x' }, ACTOR), /英小文字/);
  assert.throws(() => ledger.setSettings('profile', { name: 1 }, ACTOR), /文字列/);
  assert.equal(ledger.oauth.githubId().id, '42');
  ledger.close();
});

test('a session outlives a restart of the server: it is kept, as a hash, in the data directory', async (t) => {
  const { createWeb, SESSIONS_FILE } = await import('../src/server/web.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-web-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const ledger = openLedger(':memory:');
  t.after(() => ledger.close());
  const express = (await import('express')).default;
  const serve = async () => {
    const web = createWeb({ ledger, home, host: '0.0.0.0' });
    const app = express();
    app.use(web.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    return { web, server, base: `http://127.0.0.1:${server.address().port}` };
  };
  const first = await serve();
  const cookie = (await login(first.base, first.web.issueLogin())).headers.get('set-cookie').split(';')[0];
  await new Promise((r) => first.server.close(r));
  const kept = fs.readFileSync(path.join(home, SESSIONS_FILE), 'utf8');
  assert.equal(kept.includes(cookie.split('=')[1]), false, 'only the hash is kept');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(home, SESSIONS_FILE)).mode & 0o777, 0o600);

  const second = await serve();
  t.after(() => new Promise((r) => second.server.close(r)));
  assert.equal((await get(second.base, '/calendar', { Cookie: cookie })).status, 200);
  assert.equal((await get(second.base, '/calendar', { Cookie: 'warifuri_web=forged' })).status, 401);
});

test('devices: the secretary and the server machine\'s programs are kept apart; places carry when they last saw work', async (t) => {
  const { base, ledger } = await start(t, { secretaryDevice: 'laptop', serverDevices: ['lost'] });
  const srv = await (await get(base, '/web/api/server')).json();
  assert.deepEqual(srv.devices.map((d) => d.name), ['desk']);
  const st = await (await get(base, '/web/api/settings')).json();
  assert.deepEqual(st.devices.map((d) => [d.name, d.role]), [['desk', 'device'], ['laptop', 'secretary'], ['lost', 'server']]);
  assert.ok(st.places.every((p) => /^\d{4}-/.test(p.last_active_at)));
  const thesis = st.places.find((p) => p.name === 'thesis');
  assert.ok(thesis.last_active_at >= ledger.listPlaces().find((p) => p.name === 'thesis').updated_at);
});

test('logging in again from the same app on the same device ends the older login', () => {
  const ledger = openLedger(':memory:');
  ledger.issueKey('desk', ACTOR);
  ledger.issueKey('laptop', ACTOR);
  const login = (name, device) => {
    const client = ledger.oauth.registerClient({ client_name: name, redirect_uris: ['http://localhost:9/cb'] });
    const pending = ledger.oauth.createPending({ clientId: client.client_id, redirectUri: 'http://localhost:9/cb', codeChallenge: 'c', scopes: [] });
    ledger.oauth.setPendingLogin(pending.id, 'alex');
    const { code } = ledger.oauth.approve(pending.id, device, ACTOR);
    return { id: client.client_id, ...ledger.oauth.exchangeCode(client.client_id, code, 'http://localhost:9/cb').tokens };
  };
  const first = login('Codex', 'desk');
  const other = login('Codex', 'laptop');
  const elsewhere = login('Claude Code', 'desk');
  const again = login('Codex', 'desk');
  const live = ledger.oauth.tokenActivity().filter((a) => a.live).map((a) => a.client_id).sort();
  assert.deepEqual(live, [other.id, elsewhere.id, again.id].sort());
  assert.ok(!live.includes(first.id));
  assert.ok(ledger.records(first.id).some((r) => r.action === 'replaced'));
  ledger.close();
});

test('the badge on 秘書: what the secretary said since the person last saw the conversation', async (t) => {
  const { base, ledger } = await start(t);
  const about = async () => (await (await get(base, '/web/api/about')).json()).secretary_unread;
  assert.equal(await about(), 0);
  const main = ledger.ensureThread('secretary', { actor: 'web', device: null });
  ledger.addMessage(main.id, { role: 'user', body: 'おはよう' }, { actor: 'web', device: null });
  ledger.addMessage(main.id, { role: 'secretary', body: 'おはようございます' }, { actor: 'secretary-chat', device: 'desk' });
  ledger.ask({ questions: [{ header: '期日', question: '延ばしますか？', options: [{ label: '延ばす' }, { label: 'そのまま' }] }] }, { actor: 'device-key', device: 'desk' });
  assert.equal(await about(), 2);
  const res = await fetch(`${base}/web/api/secretary/read`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{}' });
  assert.deepEqual(await res.json(), { unread: 0 });
  assert.equal(await about(), 0);
});

test('ナレッジ: the profiles with their counts, one profile\'s files, and a file split out of them, read only', async (t) => {
  const { base, home } = await start(t);
  fs.writeFileSync(path.join(home, 'profiles', 'hobby', 'knowledge.md'), '- 2026-10-27 「本人の言葉」 苗は朝に水をやる (laptop)\n');
  fs.mkdirSync(path.join(home, 'profiles', 'hobby', 'procedures'));
  fs.writeFileSync(path.join(home, 'profiles', 'hobby', 'procedures', '植え替え.md'), '# 植え替え\n\n1. 鉢を用意する\n');
  const list = await (await get(base, '/web/api/knowledge')).json();
  assert.ok(list.profiles.some((p) => p.name === 'research'));
  const hobby = list.profiles.find((p) => p.name === 'hobby');
  assert.deepEqual([hobby.people, hobby.knowledge, hobby.inbox, hobby.files], [0, 1, 0, 1]);
  assert.equal(list.colors.hobby, '#123abc');
  const one = await (await get(base, '/web/api/knowledge/hobby')).json();
  assert.equal(one.profile, 'hobby');
  assert.match(one.knowledge.text, /苗は朝に水をやる/);
  assert.deepEqual(one.files.procedures, ['procedures/植え替え.md']);
  const file = await (await get(base, `/web/api/knowledge/hobby?name=${encodeURIComponent('procedures/植え替え.md')}`)).json();
  assert.match(file.text, /鉢を用意する/);
  assert.equal((await get(base, '/web/api/knowledge/nobody')).status, 404);
  assert.equal((await get(base, `/web/api/knowledge/hobby?name=${encodeURIComponent('../profile.yaml')}`)).status, 404);
});
