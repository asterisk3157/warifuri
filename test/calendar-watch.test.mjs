// Tests for the calendar watch (src/calendar/): the Google client against a fake fetch, the
// rules of taking events in (takein.mjs), the watch itself (sync tokens, push channels and
// Google's call), and the line it leaves in the secretary's conversation. Google is never
// called: every test stands in for it.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openLedger } from '../src/ledger/ledger.mjs';
import { loadConfig } from '../src/config.mjs';
import { writeSettings } from '../src/ledger/settings.mjs';
import { createGoogle, googleConfig, GoogleError, TOKEN_URL, API } from '../src/calendar/google.mjs';
import { takeIn, piecesOf, leftOut, readable, sourceOf, windowOf, WRITER } from '../src/calendar/takein.mjs';
import { createCalendarWatch, stateFile, NOTIFY_PATH, POKE_MS } from '../src/calendar/watch.mjs';
import { loginRequest, readRedirect, exchange, saveRefreshToken } from '../src/calendar/login.mjs';
import { createApp } from '../src/server/mcp.mjs';
import { calendarLine, buildChatPrompt, TRIGGERS } from '../src/secretary/chat.mjs';
import { scheduleFrom, factLines } from '../src/secretary/secretary.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warifuri-calwatch-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const NOW = new Date(2026, 10, 10, 12, 0, 0);
const AGENT = { actor: 'device-key', device: 'laptop' };
const PRIMARY = { id: 'me@example.com', primary: true, accessRole: 'owner' };
const WORK = { id: 'work@example.com', accessRole: 'reader' };
const at = (day, hour, min = 0) => new Date(2026, 10, day, hour, min).toISOString();
// A timed event made long ago.
const ev = (id, day, hour, extra = {}) => ({
  id, summary: `予定 ${id}`, created: '2026-10-01T00:00:00Z', start: { dateTime: at(day, hour) }, end: { dateTime: at(day, hour + 1) }, ...extra,
});
const fixedOf = (ledger) => ledger.schedule({ from: at(1, 0), to: at(30, 0) }).bookings.filter((b) => b.kind === 'fixed');
const run = (ledger, reads, extra = {}) => takeIn(ledger, { reads, window: windowOf(NOW), now: NOW, ...extra });

// ---------- the Google client

const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('googleConfig needs the client id, the client secret and the refresh token', () => {
  assert.equal(googleConfig({}), null);
  assert.equal(googleConfig({ WARIFURI_GOOGLE_CLIENT_ID: 'id', WARIFURI_GOOGLE_CLIENT_SECRET: 'secret' }), null);
  assert.deepEqual(googleConfig({ WARIFURI_GOOGLE_CLIENT_ID: 'id', WARIFURI_GOOGLE_CLIENT_SECRET: 'secret', WARIFURI_GOOGLE_REFRESH_TOKEN: 'refresh' }), {
    clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh',
  });
});

test('the client refreshes its access token, pages through a list and renews once on 401', async () => {
  const calls = [];
  let tokens = 0;
  let refused = false;
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url === TOKEN_URL) {
      tokens += 1;
      return answer(200, { access_token: `access-${tokens}`, expires_in: 3600 });
    }
    if (!refused) {
      refused = true;
      return answer(401, { error: { status: 'UNAUTHENTICATED' } });
    }
    const u = new URL(url);
    return u.searchParams.get('pageToken') ? answer(200, { items: [{ id: 'b' }] }) : answer(200, { items: [{ id: 'a' }], nextPageToken: 'p2' });
  };
  const google = createGoogle({ clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh', fetch });
  const events = await google.events('me@example.com', windowOf(NOW));
  assert.deepEqual(events.map((e) => e.id), ['a', 'b']);
  assert.equal(tokens, 2);
  const form = new URLSearchParams(calls[0].init.body);
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('refresh_token'), 'refresh');
  const list = calls.filter((c) => c.url.startsWith(API));
  assert.equal(list.at(-1).init.headers.Authorization, 'Bearer access-2');
  const q = new URL(list[0].url).searchParams;
  assert.equal(q.get('singleEvents'), 'true');
  assert.equal(q.get('timeMin'), windowOf(NOW).from.toISOString());
  assert.ok(list[0].url.includes('/calendars/me%40example.com/events'));
});

test('changed asks with the sync token; errors name the status and never a token', async () => {
  const asked = [];
  const fetch = async (url) => {
    if (url === TOKEN_URL) return answer(200, { access_token: 'access', expires_in: 3600 });
    const token = new URL(url).searchParams.get('syncToken');
    asked.push(token);
    if (token === 'old') return answer(410, { error: { errors: [{ reason: 'fullSyncRequired' }] } });
    if (token === 't1') return answer(200, { items: [{ id: 'x' }], nextSyncToken: 't2' });
    if (token === 't2') return answer(200, { items: [], nextSyncToken: 't2' });
    return answer(200, { items: [{ id: 'a' }, { id: 'b' }], nextSyncToken: 't1' });
  };
  const google = createGoogle({ clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh', fetch });
  assert.deepEqual(await google.changed('c', null), { changed: false, syncToken: 't1' });
  assert.deepEqual(await google.changed('c', 't1'), { changed: true, syncToken: 't2' });
  assert.deepEqual(await google.changed('c', 't2'), { changed: false, syncToken: 't2' });
  await assert.rejects(google.changed('c', 'old'), (err) => err instanceof GoogleError && err.status === 410 && !/access|refresh|secret/.test(err.message));
  assert.deepEqual(asked, [null, 't1', 't2', 'old']);
});

test('a login Google refuses says so without the secrets', async () => {
  const fetch = async () => answer(400, { error: 'invalid_grant', error_description: 'gone' });
  const google = createGoogle({ clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh', fetch });
  await assert.rejects(google.calendars(), (err) => err.reason === 'invalid_grant' && !/secret|refresh"/.test(err.message));
});

// ---------- taking in

test('which calendars are read, and their sources', () => {
  assert.equal(readable(PRIMARY), true);
  assert.equal(readable(WORK), true);
  assert.equal(readable({ id: 'ja.japanese#holiday@group.v.calendar.google.com', accessRole: 'reader' }), false);
  assert.equal(readable({ id: 'busy@example.com', accessRole: 'freeBusyReader' }), false);
  assert.equal(readable({ id: 'gone@example.com', accessRole: 'reader', deleted: true }), false);
  assert.equal(sourceOf(PRIMARY), 'google-calendar');
  assert.equal(sourceOf(WORK), 'google-calendar:work@example.com');
});

test('the window is yesterday to the end of the 14th day', () => {
  const w = windowOf(NOW);
  assert.equal(w.from.getTime(), new Date(2026, 10, 9).getTime());
  assert.equal(w.to.getTime(), new Date(2026, 10, 25).getTime());
});

test('an all-day event is one booking per day, from midnight to midnight', () => {
  const one = piecesOf({ id: 'd', start: { date: '2026-11-12' }, end: { date: '2026-11-13' } });
  assert.deepEqual(one.map((p) => [p.external_id, p.starts_at.getTime(), p.ends_at.getTime()]), [
    ['d', new Date(2026, 10, 12).getTime(), new Date(2026, 10, 13).getTime()],
  ]);
  const trip = piecesOf({ id: 't', start: { date: '2026-11-12' }, end: { date: '2026-11-15' } });
  assert.deepEqual(trip.map((p) => p.external_id), ['t', 't#2', 't#3']);
  assert.equal(trip[2].ends_at.getTime(), new Date(2026, 10, 15).getTime());
  assert.deepEqual(piecesOf({ id: 'x', start: {}, end: {} }), []);
});

test('events are taken in as fixed bookings, changed when they change, and not doubled', () => {
  const ledger = openLedger(':memory:');
  const first = run(ledger, [
    { calendar: PRIMARY, events: [ev('a', 11, 10, { location: ' 会議室 ', description: '<p>資料を<b>持参</b></p>', organizer: { email: 'host@example.com' } })] },
    { calendar: WORK, events: [ev('a', 12, 9)] },
  ]);
  assert.deepEqual(first.changes.map((c) => c.change), ['created', 'created']);
  const [mine, work] = fixedOf(ledger);
  assert.deepEqual(
    [mine.title, mine.source, mine.external_id, mine.location, mine.note, mine.organizer, mine.starts_at],
    ['予定 a', 'google-calendar', 'a', '会議室', '資料を持参', 'host@example.com', at(11, 10)],
  );
  assert.equal(work.source, 'google-calendar:work@example.com');
  // The same read again changes nothing; a moved event moves its copy.
  assert.deepEqual(run(ledger, [{ calendar: PRIMARY, events: [ev('a', 11, 10, { location: ' 会議室 ', description: '<p>資料を<b>持参</b></p>', organizer: { email: 'host@example.com' } })] }]).changes, []);
  const moved = run(ledger, [{ calendar: PRIMARY, events: [ev('a', 11, 15)] }]);
  assert.deepEqual(moved.changes.map((c) => [c.change, c.starts_at]), [['moved', at(11, 15)]]);
  assert.equal(fixedOf(ledger).length, 2);
  ledger.close();
});

test('declined, cancelled, free and skipped events are not taken in, and their copies go', () => {
  const ledger = openLedger(':memory:');
  writeSettings(ledger, { calendar: { skip: [{ title: '昼休み' }, { title: '定例', calendar: 'work@example.com' }] } }, { byPerson: true }, AGENT);
  const skip = [{ title: '昼休み' }, { title: '定例', calendar: 'work@example.com' }];
  const events = [
    ev('ok', 11, 9),
    ev('declined', 11, 10, { attendees: [{ self: true, responseStatus: 'declined' }, { responseStatus: 'accepted' }] }),
    ev('cancelled', 11, 11, { status: 'cancelled' }),
    ev('free', 11, 12, { transparency: 'transparent' }),
    ev('lunch', 11, 13, { summary: '昼休み' }),
    ev('teiki', 11, 14, { summary: '定例' }),
  ];
  assert.equal(leftOut(events[1], PRIMARY, skip), 'declined');
  assert.equal(leftOut(events[5], PRIMARY, skip), null);
  assert.equal(leftOut(events[5], WORK, skip), 'skip');
  // Copies made before (by the secretary's sync, say) of events that are now left out.
  for (const id of ['declined', 'free', 'lunch']) {
    ledger.book({ kind: 'fixed', title: id, starts_at: at(11, 20), ends_at: at(11, 21), source: 'google-calendar', external_id: id }, AGENT);
  }
  const out = run(ledger, [{ calendar: PRIMARY, events }], { skip });
  assert.deepEqual(fixedOf(ledger).map((b) => b.external_id).sort(), ['ok', 'teiki']);
  assert.deepEqual(out.changes.map((c) => c.change).sort(), ['created', 'created', 'deleted', 'deleted', 'deleted']);
  ledger.close();
});

test('an event warifuri wrote is not made fixed; its booking follows the calendar', () => {
  const ledger = openLedger(':memory:');
  const task = ledger.createTask({ title: '資料を作る', mode: 'human', done_when: '資料ができている' }, AGENT);
  const { booking } = ledger.book({ kind: 'task', task_id: task.id, starts_at: at(11, 9), ends_at: at(11, 10), source: 'google-calendar', external_id: 'w1' }, AGENT);
  const same = run(ledger, [{ calendar: PRIMARY, events: [ev('w1', 11, 9, { summary: '資料を作る' })] }]);
  assert.deepEqual(same.changes, []);
  const moved = run(ledger, [{ calendar: PRIMARY, events: [ev('w1', 11, 14, { summary: '資料を作る' })] }]);
  assert.deepEqual(moved.changes.map((c) => [c.id, c.change]), [[booking.id, 'moved']]);
  const now = ledger.getBooking(booking.id);
  assert.deepEqual([now.kind, now.task_id, now.starts_at, now.ends_at], ['task', task.id, at(11, 14), at(11, 15)]);
  assert.equal(fixedOf(ledger).length, 0);
  // The event is gone from the calendar: the task's booking stays.
  run(ledger, [{ calendar: PRIMARY, events: [] }]);
  assert.ok(ledger.getBooking(booking.id));
  ledger.close();
});

test('the line warifuri で作成 alone does not make an event warifuri\'s, and a moved pair follows the calendar it moved to', () => {
  const ledger = openLedger(':memory:');
  // An event that says it was made by the secretary, with no pair: it is the person's.
  const marked = ev('m1', 11, 9, { description: 'メモ\nwarifuri で作成' });
  run(ledger, [{ calendar: PRIMARY, events: [marked] }]);
  assert.deepEqual(fixedOf(ledger).map((b) => [b.source, b.external_id]), [['google-calendar', 'm1']]);
  // A task's time written to another calendar before, then moved to the main one: made there,
  // the pair put on again, and the old event deleted.
  const task = ledger.createTask({ title: '資料を作る', mode: 'human', done_when: '資料ができている' }, AGENT);
  const { booking } = ledger.book({ kind: 'task', task_id: task.id, starts_at: at(12, 9), ends_at: at(12, 10), source: 'google-calendar:work@example.com', external_id: 'old' }, AGENT);
  ledger.book({ id: booking.id, source: 'google-calendar', external_id: 'new' }, AGENT);
  const main = { calendar: PRIMARY, events: [marked, ev('new', 12, 9, { summary: '資料を作る', description: 'warifuri で作成' })] };
  // While the old event is still there, it is taken in as fixed; once it is deleted, so is its copy.
  run(ledger, [main, { calendar: WORK, events: [ev('old', 12, 9, { summary: '資料を作る' })] }]);
  assert.ok(fixedOf(ledger).some((b) => b.external_id === 'old'));
  run(ledger, [main, { calendar: WORK, events: [] }]);
  assert.deepEqual(fixedOf(ledger).map((b) => b.external_id), ['m1']);
  const now = ledger.getBooking(booking.id);
  assert.deepEqual([now.kind, now.source, now.external_id], ['task', 'google-calendar', 'new']);
  ledger.close();
});

test('a copy whose event is gone is deleted; other bookings are left alone', () => {
  const ledger = openLedger(':memory:');
  run(ledger, [{ calendar: PRIMARY, events: [ev('a', 11, 9), ev('b', 12, 9)] }, { calendar: WORK, events: [ev('c', 12, 9)] }]);
  const own = ledger.book({ kind: 'fixed', title: '歯医者', starts_at: at(13, 9), ends_at: at(13, 10) }, AGENT).booking;
  const far = ledger.book({ kind: 'fixed', title: '先の予定', starts_at: new Date(2026, 11, 20, 9).toISOString(), ends_at: new Date(2026, 11, 20, 10).toISOString(), source: 'google-calendar', external_id: 'far' }, AGENT).booking;
  // Only the primary calendar is read: the copy of the other calendar stays.
  const out = run(ledger, [{ calendar: PRIMARY, events: [ev('a', 11, 9)] }]);
  assert.deepEqual(out.changes.map((c) => [c.change, c.title]), [['deleted', '予定 b']]);
  assert.deepEqual(fixedOf(ledger).map((b) => b.external_id).filter(Boolean).sort(), ['a', 'c']);
  assert.ok(ledger.getBooking(own.id));
  assert.ok(ledger.getBooking(far.id));
  // A read of every calendar: the calendar that is no longer there loses its copies, unless it failed.
  assert.deepEqual(run(ledger, [{ calendar: PRIMARY, events: [ev('a', 11, 9)] }], { all: true, failed: new Set(['google-calendar:work@example.com']) }).changes, []);
  const gone = run(ledger, [{ calendar: PRIMARY, events: [ev('a', 11, 9)] }], { all: true });
  assert.deepEqual(gone.changes.map((c) => c.title), ['予定 c']);
  ledger.close();
});

test('an event made a moment ago waits, so the secretary can put its pair on a booking first', () => {
  const ledger = openLedger(':memory:');
  const fresh = ev('new', 11, 9, { created: new Date(NOW.getTime() - 30_000).toISOString() });
  const out = run(ledger, [{ calendar: PRIMARY, events: [fresh] }]);
  assert.deepEqual(out.changes, []);
  assert.deepEqual(out.waiting.map((w) => [w.calendar, w.until.getTime()]), [['me@example.com', NOW.getTime() + 90_000]]);
  const later = takeIn(ledger, { reads: [{ calendar: PRIMARY, events: [fresh] }], window: windowOf(NOW), now: new Date(NOW.getTime() + 120_000) });
  assert.deepEqual(later.changes.map((c) => c.change), ['created']);
  ledger.close();
});

// ---------- the watch

// A Google that keeps calendars and their events, and counts what it is asked.
function fakeGoogle(calendars) {
  const g = {
    list: calendars.map((c) => c.calendar),
    events_: new Map(calendars.map((c) => [c.calendar.id, c.events])),
    version: new Map(calendars.map((c) => [c.calendar.id, 1])),
    asked: { calendars: 0, events: [], changed: [], watch: [], stop: [] },
    fail: null,
    set(id, events) {
      g.events_.set(id, events);
      g.version.set(id, g.version.get(id) + 1);
    },
    async calendars() {
      if (g.fail) throw g.fail;
      g.asked.calendars += 1;
      return g.list;
    },
    async events(id) {
      g.asked.events.push(id);
      return g.events_.get(id);
    },
    async changed(id, token) {
      g.asked.changed.push([id, token]);
      if (token === 'expired') throw new GoogleError('Google Calendar answered 410', { status: 410 });
      const v = `v${g.version.get(id)}`;
      return { changed: Boolean(token) && token !== v, syncToken: v };
    },
    async watch(id, channel) {
      g.asked.watch.push({ calendar: id, ...channel });
      return { resourceId: `res-${g.asked.watch.length}`, expiration: g.expiration ?? null };
    },
    async stop(channel) {
      g.asked.stop.push(channel);
    },
  };
  return g;
}

function watchWorld(t, { calendars = [{ calendar: PRIMARY, events: [ev('a', 11, 9)] }], ...options } = {}) {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  const ledger = openLedger(':memory:');
  t.after(() => ledger.close());
  const google = fakeGoogle(calendars);
  const clock = { now: new Date(NOW) };
  const said = [];
  const lines = [];
  const timeouts = [];
  const timers = { setTimeout: (fn, ms) => (timeouts.push({ fn, ms }), { unref() {} }), clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {} };
  const make = () => createCalendarWatch({
    ledger, google, home, now: () => new Date(clock.now), timers, log: (l) => lines.push(l), onChanges: (c) => said.push(c), ...options,
  });
  return { home, ledger, google, clock, said, lines, timeouts, make, watch: make(), state: () => JSON.parse(fs.readFileSync(stateFile(home), 'utf8')) };
}
const forward = (w, ms) => {
  w.clock.now = new Date(w.clock.now.getTime() + ms);
};

test('the first read takes everything in and says nothing; later only what changed is read', async (t) => {
  const w = watchWorld(t, { calendars: [{ calendar: PRIMARY, events: [ev('a', 11, 9)] }, { calendar: WORK, events: [ev('b', 11, 10)] }] });
  await w.watch.tick();
  assert.equal(fixedOf(w.ledger).length, 2);
  assert.deepEqual(w.said, []);
  assert.deepEqual(w.google.asked.events, ['me@example.com', 'work@example.com']);
  assert.equal(w.state().calendars['me@example.com'].syncToken, 'v1');
  if (process.platform !== 'win32') assert.equal(fs.statSync(stateFile(w.home)).mode & 0o777, 0o600);

  // Nothing changed: each calendar is asked with its token, and none is read.
  forward(w, 60_000);
  await w.watch.tick();
  assert.deepEqual(w.google.asked.changed.slice(-2), [['me@example.com', 'v1'], ['work@example.com', 'v1']]);
  assert.equal(w.google.asked.events.length, 2);
  assert.equal(w.google.asked.calendars, 1);

  // One calendar changed: only it is read, and the change is said.
  w.google.set('work@example.com', [ev('b', 11, 15), ev('c', 12, 9)]);
  forward(w, 60_000);
  await w.watch.tick();
  assert.deepEqual(w.google.asked.events.slice(2), ['work@example.com']);
  assert.deepEqual(w.said.map((cs) => cs.map((c) => c.change).sort()), [['created', 'moved']]);
  assert.equal(w.state().calendars['work@example.com'].syncToken, 'v2');

  // An event deleted in the calendar: its copy goes.
  w.google.set('work@example.com', [ev('c', 12, 9)]);
  forward(w, 60_000);
  await w.watch.tick();
  assert.deepEqual(w.said[1].map((c) => [c.change, c.title]), [['deleted', '予定 b']]);
  assert.deepEqual(fixedOf(w.ledger).map((b) => b.external_id).sort(), ['a', 'c']);
});

test('every calendar is read again after an hour, and after a restart', async (t) => {
  const w = watchWorld(t);
  await w.watch.tick();
  forward(w, 61 * 60_000);
  await w.watch.tick();
  assert.equal(w.google.asked.calendars, 2);
  assert.equal(w.google.asked.events.length, 2);
  // A new process keeps the token, reads once, and says what changed meanwhile.
  w.google.set('me@example.com', []);
  const again = w.make();
  forward(w, 60_000);
  await again.tick();
  assert.deepEqual(w.google.asked.changed.at(-1), ['me@example.com', 'v1']);
  assert.deepEqual(w.said.map((cs) => cs.map((c) => c.change)), [['deleted']]);
});

test('a sync token Google no longer takes starts over and reads the calendar', async (t) => {
  const w = watchWorld(t);
  await w.watch.tick();
  const state = w.state();
  state.calendars['me@example.com'].syncToken = 'expired';
  fs.writeFileSync(stateFile(w.home), JSON.stringify(state));
  const again = w.make();
  w.google.set('me@example.com', [ev('a', 11, 9), ev('z', 12, 9)]);
  forward(w, 60_000);
  await again.tick();
  assert.deepEqual(w.google.asked.changed.slice(-2), [['me@example.com', 'expired'], ['me@example.com', null]]);
  assert.equal(fixedOf(w.ledger).length, 2);
  assert.equal(w.state().calendars['me@example.com'].syncToken, 'v2');
});

test('when Google cannot be reached nothing is written, and the trouble is told once', async (t) => {
  const problems = [];
  let ok = 0;
  const w = watchWorld(t, { onProblem: (err) => problems.push(err.reason), onOk: () => (ok += 1) });
  await w.watch.tick();
  w.google.fail = new GoogleError('Google refused the login (400 invalid_grant)', { status: 400, reason: 'invalid_grant' });
  forward(w, 61 * 60_000);
  await w.watch.tick();
  await w.watch.tick();
  assert.deepEqual(problems, ['invalid_grant', 'invalid_grant']);
  assert.equal(w.lines.filter((l) => /could not reach Google/.test(l)).length, 1);
  assert.equal(fixedOf(w.ledger).length, 1);
  assert.equal(ok, 1);
});

test('a new event waits out its grace, then is read without a change in the calendar', async (t) => {
  const fresh = ev('new', 11, 9, { created: new Date(NOW.getTime() - 10_000).toISOString() });
  const w = watchWorld(t, { calendars: [{ calendar: PRIMARY, events: [fresh] }] });
  await w.watch.tick();
  assert.equal(fixedOf(w.ledger).length, 0);
  forward(w, 60_000);
  await w.watch.tick();
  assert.equal(fixedOf(w.ledger).length, 0);
  forward(w, 60_000);
  await w.watch.tick();
  assert.equal(fixedOf(w.ledger).length, 1);
  assert.equal(w.google.asked.events.length, 2);
});

test('push: a channel per calendar, Google\'s call checked by its token, renewed before it ends', async (t) => {
  const address = `https://warifuri.example.com${NOTIFY_PATH}`;
  const w = watchWorld(t, { pushAddress: address });
  w.google.expiration = NOW.getTime() + 7 * 24 * 60 * 60 * 1000;
  await w.watch.tick();
  assert.equal(w.google.asked.watch.length, 1);
  const channel = w.state().calendars['me@example.com'].channel;
  assert.equal(w.google.asked.watch[0].address, address);
  assert.equal(w.google.asked.watch[0].token, channel.token);
  const headers = (extra) => ({ 'x-goog-channel-id': channel.id, 'x-goog-channel-token': channel.token, 'x-goog-resource-state': 'exists', ...extra });

  // Calls that are not ours.
  assert.equal(w.watch.notify(headers({ 'x-goog-channel-token': 'wrong' })), false);
  assert.equal(w.watch.notify(headers({ 'x-goog-channel-id': 'other' })), false);
  assert.equal(w.watch.notify({}), false);
  assert.equal(w.timeouts.length, 0);
  // The first call of a channel only says it is open.
  assert.equal(w.watch.notify(headers({ 'x-goog-resource-state': 'sync' })), true);
  assert.equal(w.timeouts.length, 0);

  // A change: the calendar is read shortly after, once for a burst of calls.
  w.google.set('me@example.com', [ev('a', 11, 16)]);
  assert.equal(w.watch.notify(headers()), true);
  assert.equal(w.watch.notify(headers()), true);
  assert.deepEqual(w.timeouts.map((x) => x.ms), [POKE_MS]);
  forward(w, POKE_MS);
  w.timeouts[0].fn();
  await w.watch.tick();
  assert.deepEqual(w.said.map((cs) => cs.map((c) => c.change)), [['moved']]);

  // A day before the channel ends, a new one is opened and the old one closed.
  forward(w, 6 * 24 * 60 * 60 * 1000 + 60_000);
  w.google.expiration = w.clock.now.getTime() + 7 * 24 * 60 * 60 * 1000;
  await w.watch.tick();
  assert.equal(w.google.asked.watch.length, 2);
  assert.deepEqual(w.google.asked.stop, [{ id: channel.id, resourceId: channel.resourceId }]);
  assert.equal(w.watch.notify(headers()), false);

  // Push turned off: the channel is closed.
  const off = createCalendarWatch({ ledger: w.ledger, google: w.google, home: w.home, now: () => new Date(w.clock.now) });
  await off.tick();
  assert.equal(w.google.asked.stop.length, 2);
  assert.equal(w.state().calendars['me@example.com'].channel, undefined);
});

test('POST /api/google/calendar/notify answers 204 to a call of ours and 404 to any other', async (t) => {
  const ledger = openLedger(':memory:');
  const seen = [];
  const app = createApp({ ledger, calendarWatch: { notify: (h) => (seen.push(h['x-goog-channel-id']), h['x-goog-channel-token'] === 'right') } });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.close();
    ledger.close();
  });
  const url = `http://127.0.0.1:${server.address().port}${NOTIFY_PATH}`;
  const ok = await fetch(url, { method: 'POST', headers: { 'X-Goog-Channel-ID': 'ch', 'X-Goog-Channel-Token': 'right' } });
  assert.equal(ok.status, 204);
  const bad = await fetch(url, { method: 'POST', headers: { 'X-Goog-Channel-ID': 'ch', 'X-Goog-Channel-Token': 'wrong' } });
  assert.equal(bad.status, 404);
  assert.equal(await bad.text(), '');
  assert.deepEqual(seen, ['ch', 'ch']);
  // Without a watch, the path is not there (it falls to /api, which wants a key).
  const plain = http.createServer(createApp({ ledger }));
  await new Promise((resolve) => plain.listen(0, '127.0.0.1', resolve));
  t.after(() => plain.close());
  assert.equal((await fetch(`http://127.0.0.1:${plain.address().port}${NOTIFY_PATH}`, { method: 'POST' })).status, 401);
});

// ---------- settings

test('without the Google settings nothing changes: no watch, and the sync job as before', () => {
  const home = fs.mkdtempSync(path.join(tmp, 'cfg-'));
  const base = { WARIFURI_HOME: home, WARIFURI_SECRETARY_TOOLS: 'mcp__claude_ai_Google_Calendar=own' };
  const off = loadConfig({ env: base, command: 'serve' });
  assert.deepEqual(off.problems, []);
  assert.equal(googleConfig(off.values), null);
  assert.equal(scheduleFrom(off.values).watch, false);
  assert.deepEqual(scheduleFrom(off.values).jobs.sync, { every: 60 });
  assert.equal(factLines('t', 'sync', { now: NOW, schedule: scheduleFrom(off.values) }).some((l) => l.includes('自分で取り込んで')), false);

  const on = loadConfig({
    env: { ...base, WARIFURI_GOOGLE_CLIENT_ID: 'id', WARIFURI_GOOGLE_CLIENT_SECRET: 'secret', WARIFURI_GOOGLE_REFRESH_TOKEN: 'refresh' },
    command: 'serve',
  });
  assert.deepEqual(on.problems, []);
  assert.equal(scheduleFrom(on.values).watch, true);
  assert.deepEqual([on.values.WARIFURI_GOOGLE_CALENDAR_POLL, on.values.WARIFURI_GOOGLE_CALENDAR_PUSH, on.values.WARIFURI_GOOGLE_CALENDAR_WAKE], ['1', 'off', 'off']);
  assert.equal(factLines('t', 'sync', { now: NOW, schedule: scheduleFrom(on.values) }).some((l) => l.includes('自分で取り込んで')), true);

  const bad = loadConfig({ env: { ...base, WARIFURI_GOOGLE_CALENDAR_POLL: '0', WARIFURI_GOOGLE_CALENDAR_WAKE: 'yes' }, command: 'serve' });
  assert.equal(bad.problems.length, 2);
});

// ---------- the login

test('the login: the URL asks to read only, the answer is checked by its state, the token goes to secrets.env', async () => {
  const req = loginRequest({ clientId: 'id', redirectUri: 'http://127.0.0.1:5000', state: 'st', verifier: 'ver' });
  const q = new URL(req.url).searchParams;
  assert.equal(q.get('scope'), 'https://www.googleapis.com/auth/calendar.readonly');
  assert.equal(q.get('access_type'), 'offline');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.ok(!req.url.includes('ver'));
  assert.deepEqual(readRedirect('http://127.0.0.1:5000/?state=st&code=the-code', 'st'), { code: 'the-code' });
  assert.deepEqual(readRedirect('/?state=st&code=the-code', 'st'), { code: 'the-code' });
  assert.ok(readRedirect('http://127.0.0.1:5000/?state=other&code=x', 'st').problem);
  assert.ok(readRedirect('http://127.0.0.1:5000/?state=st&error=access_denied', 'st').problem);

  let form;
  const fetch = async (url, init) => {
    form = new URLSearchParams(init.body);
    return answer(200, { access_token: 'access', refresh_token: 'refresh-1' });
  };
  const token = await exchange({ clientId: 'id', clientSecret: 'secret', code: 'the-code', verifier: 'ver', redirectUri: 'http://127.0.0.1:5000', fetch });
  assert.equal(token, 'refresh-1');
  assert.deepEqual([form.get('grant_type'), form.get('code'), form.get('code_verifier')], ['authorization_code', 'the-code', 'ver']);
  await assert.rejects(exchange({ clientId: 'id', clientSecret: 'secret', code: 'c', verifier: 'v', redirectUri: 'r', fetch: async () => answer(200, { access_token: 'access' }) }), /no refresh token/);

  const home = fs.mkdtempSync(path.join(tmp, 'login-'));
  fs.writeFileSync(path.join(home, 'secrets.env'), '# WARIFURI_GOOGLE_REFRESH_TOKEN=\nWARIFURI_GOOGLE_CLIENT_SECRET=secret\n');
  const file = saveRefreshToken(home, token);
  assert.equal(fs.readFileSync(file, 'utf8'), 'WARIFURI_GOOGLE_REFRESH_TOKEN=refresh-1\nWARIFURI_GOOGLE_CLIENT_SECRET=secret\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const cfg = loadConfig({ env: { WARIFURI_HOME: home, WARIFURI_GOOGLE_CLIENT_ID: 'id' }, command: 'serve' });
  assert.ok(googleConfig(cfg.values));
});

// ---------- the secretary's conversation

test('a change of the calendar is one line, and the call for it brings its instructions', () => {
  assert.equal(calendarLine({ change: 'created', title: '打ち合わせ', starts_at: at(12, 10), ends_at: at(12, 11) }), 'カレンダーに予定が増えました: 11/12 10:00〜11:00 打ち合わせ');
  assert.match(calendarLine({ change: 'deleted', title: '打ち合わせ', starts_at: at(12, 10), ends_at: at(12, 11) }), /^カレンダーから予定が消えました/);
  assert.equal(TRIGGERS.calendar, 'カレンダーの予定が変わりました');
  const schedule = scheduleFrom({});
  const feed = [
    { id: 'm1', role: 'system', kind: 'text', body: 'カレンダーで予定が動きました: 11/12 10:00〜11:00 打ち合わせ', created_at: at(10, 12), data: { calendar_change: {} } },
    { id: 'm2', role: 'system', kind: 'trigger', body: TRIGGERS.calendar, created_at: at(10, 12), data: { job: 'calendar' } },
  ];
  const prompt = buildChatPrompt({ now: NOW, schedule, feed });
  assert.match(prompt, /# 前の返事のあとに起きたこと[\s\S]*カレンダーで予定が動きました: 11\/12/);
  assert.match(prompt, /# カレンダーの変更\(calendar\)/);
  // The line alone starts no reply of its own.
  assert.match(buildChatPrompt({ now: NOW, schedule, feed: feed.slice(0, 1) }), /この回は、上の要点を受け取るだけです/);
});

test('WRITER names the watch in the record', () => {
  assert.deepEqual(WRITER, { actor: 'calendar-watch', device: 'calendar-watch' });
});
