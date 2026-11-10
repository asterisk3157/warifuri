// Tests for where the person is (src/ledger/whereabouts.mjs) and what reads it: the week type,
// a booking's location over it, travel before and after, time with nothing written taken as
// home; free time cut and kept at home (only_at); a task's only_at and priority, and the
// schema version 13 migration that adds them; book refusing a home-only task away from home;
// and the timetable's order by priority, home-only tasks and misses_due.
// The server's local time is pinned to Asia/Tokyo.

process.env.TZ = 'Asia/Tokyo';

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { whereabouts } from '../src/ledger/whereabouts.mjs';
import { freeTime } from '../src/ledger/freetime.mjs';
import { timetableFor } from '../src/ledger/timetable.mjs';
import { LIMIT_DEFAULTS, writeSettings, weekBands } from '../src/ledger/settings.mjs';
import { openLedger, LedgerError } from '../src/ledger/ledger.mjs';
import { MIGRATIONS, SCHEMA_VERSION } from '../src/ledger/schema.mjs';
import { createServer } from '../src/server/mcp.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warifuri-whereabouts-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const ACTOR = { actor: 'human' };
const at = (hm, date = '2026-11-02') => `${date}T${hm}:00+09:00`;
const utc = (hm, date = '2026-11-02') => new Date(at(hm, date)).toISOString();
const t = (hm, date) => Date.parse(at(hm, date));
const PLACES = [{ name: '家', home: true }, { name: '研究室' }, { name: '外出' }];
const TRAVEL = [{ from: '家', to: '研究室', minutes: 30 }];
// Monday 2026-11-02: at the lab 13:00-18:00 by the week type.
const LAB = [{ days: ['月'], start: '13:00', end: '18:00', place: '研究室' }];
const span = (x) => [new Date(x.s).toISOString(), new Date(x.e).toISOString(), x.place, x.home, x.by];

test('whereabouts: nothing written is home; the week type, then a booking with a location, win', () => {
  const fromMs = t('00:00');
  const toMs = t('00:00', '2026-11-03');
  assert.deepEqual(whereabouts({ fromMs, toMs }).map(span), [[utc('00:00'), utc('00:00', '2026-11-03'), null, true, 'assumed']]);

  const bands = weekBands(LAB, fromMs, toMs);
  const bookings = [
    { starts_at: at('09:00'), ends_at: at('10:00'), location: '研究室' }, // 30 minutes of travel each way
    { starts_at: at('14:00'), ends_at: at('15:00'), location: '家' }, // at home inside the lab band
    { starts_at: at('19:00'), ends_at: at('20:00'), location: 'https://meet.example/abc' }, // online: says nothing
    { starts_at: at('20:00'), ends_at: at('21:00'), location: 'どこかの住所' }, // names no place: not home
  ];
  assert.deepEqual(whereabouts({ fromMs, toMs, bands, bookings, places: PLACES, travel: TRAVEL }).map(span), [
    [utc('00:00'), utc('08:30'), null, true, 'assumed'],
    [utc('08:30'), utc('10:30'), '研究室', false, 'booking'],
    [utc('10:30'), utc('13:00'), null, true, 'assumed'],
    [utc('13:00'), utc('14:00'), '研究室', false, 'week'],
    [utc('14:00'), utc('15:00'), '家', true, 'booking'],
    [utc('15:00'), utc('18:00'), '研究室', false, 'week'],
    [utc('18:00'), utc('20:00'), null, true, 'assumed'],
    [utc('20:00'), utc('21:00'), 'どこかの住所', false, 'booking'],
    [utc('21:00'), utc('00:00', '2026-11-03'), null, true, 'assumed'],
  ]);
});

test('freeTime: slots are cut where the place changes, and only_at home keeps the hours left at home', () => {
  const fromMs = t('00:00');
  const toMs = t('00:00', '2026-11-03');
  const where = whereabouts({ fromMs, toMs, bands: weekBands(LAB, fromMs, toMs), places: PLACES });
  const limits = { ...LIMIT_DEFAULTS, day_max_hours: 6 };
  const all = freeTime({ from: fromMs, to: toMs, limits, where }).days[0].free;
  assert.deepEqual(all.map((f) => [f.starts_at, f.ends_at, f.place, f.home]), [
    [utc('09:00'), utc('13:00'), null, true],
    [utc('13:00'), utc('15:00'), '研究室', false],
  ]);
  const home = freeTime({ from: fromMs, to: toMs, limits, where, onlyAt: 'home' }).days[0].free;
  assert.deepEqual(home.map((f) => [f.starts_at, f.ends_at, f.minutes, f.home]), [
    [utc('09:00'), utc('13:00'), 240, true],
    [utc('18:00'), utc('20:00'), 120, true],
  ]);
  // Without whereabouts every slot is at home, as before.
  assert.deepEqual(freeTime({ from: fromMs, to: toMs, limits }).days[0].free.map((f) => [f.place, f.home]), [[null, true]]);
});

test('settings: a place may be marked home: true, kept only when true, and must be a boolean', () => {
  const L = openLedger(':memory:');
  const out = writeSettings(L, { places: { places: [{ name: '家', home: true }, { name: '研究室', home: false }], travel: TRAVEL } }, {}, ACTOR);
  assert.deepEqual(out.places.places, [{ name: '家', home: true }, { name: '研究室' }]);
  assert.throws(() => writeSettings(L, { places: { places: [{ name: '家', home: 'yes' }] } }, {}, ACTOR), /home は true か false/);
  L.close();
});

test('tasks: only_at and priority are written, changed, cleared and checked', () => {
  const L = openLedger(':memory:');
  const task = L.createTask({ title: 'VPN work', mode: 'human', done_when: 'done', only_at: 'home', priority: 1 }, ACTOR);
  assert.equal(task.only_at, 'home');
  assert.equal(task.priority, 1);
  assert.equal(L.get(task.id).only_at, 'home');
  assert.equal(L.board().unassigned[0].priority, 1);
  const cleared = L.update(task.id, { only_at: null, priority: 2 }, ACTOR);
  assert.equal(cleared.only_at, null);
  assert.equal(cleared.priority, 2);
  assert.throws(() => L.update(task.id, { only_at: 'lab' }, ACTOR), (err) => err instanceof LedgerError && /できる場所\(only_at\)/.test(err.message));
  assert.throws(() => L.update(task.id, { priority: 0 }, ACTOR), /優先順\(priority\)は1以上/);
  assert.equal(L.createTask({ title: 'Anywhere', mode: 'ai_worker' }, ACTOR).only_at, null);
  L.close();
});

test('schema: a version 12 file gains only_at and priority on its tasks, empty for the old rows', () => {
  const file = path.join(tmpRoot, 'v12.sqlite');
  const raw = new DatabaseSync(file);
  raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const m of MIGRATIONS.slice(0, 12)) raw.exec(m);
  raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '12')").run();
  raw
    .prepare("INSERT INTO tasks (id, title, state, mode, created_at, updated_at) VALUES ('t_20261001000000_aaaaaa', 'Old task', 'ready', 'ai_worker', 'x', 'x')")
    .run();
  raw.close();

  assert.equal(SCHEMA_VERSION, 16);
  const L = openLedger(file);
  const old = L.get('t_20261001000000_aaaaaa');
  assert.equal(old.only_at, null);
  assert.equal(old.priority, null);
  assert.equal(L.update(old.id, { only_at: 'home' }, ACTOR).only_at, 'home');
  L.close();
  const check = new DatabaseSync(file);
  assert.equal(check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '16');
  assert.throws(() => check.exec("UPDATE tasks SET only_at = 'lab'"), /CHECK/);
  check.close();
});

async function serve(t, now = '2026-11-01T13:00:00Z') {
  const ledger = openLedger(':memory:', { now: () => new Date(now) });
  const key = ledger.issueKey('laptop', { actor: 'human' }).key;
  const server = createServer({ ledger });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'test', version: '0.0.0' });
  t.after(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    ledger.close();
  });
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    return { res, data: res.isError ? null : JSON.parse(res.content[0].text), text: res.content[0].text };
  };
  return { ledger, call };
}

test('MCP: free_time says where each slot is and keeps home with only_at; book refuses a home-only task away', async (t) => {
  const { call } = await serve(t);
  await call('settings', { places: { places: PLACES, travel: TRAVEL }, week: { slots: LAB } });
  const vpn = (await call('create_task', { title: 'VPN work', mode: 'human', done_when: 'done', only_at: 'home' })).data;
  const any = (await call('create_task', { title: 'Reading', mode: 'human', done_when: 'done' })).data;
  assert.equal((await call('get', { id: vpn.id })).data.only_at, 'home');

  const day = (await call('free_time', { from: '2026-11-02' })).data.days[0];
  assert.deepEqual(day.free.map((f) => [f.starts_at, f.place, f.home]), [[utc('09:00'), null, true], [utc('13:00'), '研究室', false]]);
  const home = (await call('free_time', { from: '2026-11-02', only_at: 'home' })).data;
  assert.equal(home.only_at, 'home');
  assert.equal(home.days[0].free.every((f) => f.home), true);
  assert.match((await call('free_time', { only_at: 'lab' })).text, /home/);

  // At the lab by the week type: refused, and nothing is booked.
  const lab = await call('book', { kind: 'task', task_id: vpn.id, starts_at: at('14:00'), ends_at: at('15:00') });
  assert.equal(lab.res.isError, true);
  assert.match(lab.text, /家でしかできない.*研究室/);
  // On the way to a booking out: refused too.
  await call('book', { kind: 'fixed', title: 'Meeting', starts_at: at('10:00'), ends_at: at('11:00'), location: '研究室' });
  assert.equal((await call('book', { kind: 'task', task_id: vpn.id, starts_at: at('09:00'), ends_at: at('10:00') })).res.isError, true);
  // A location that is not home, given on the booking itself.
  assert.match((await call('book', { kind: 'task', task_id: vpn.id, starts_at: at('19:00'), ends_at: at('20:00'), location: '外出' })).text, /外出 は家ではない/);
  // At home: booked. Moving it into the lab band is refused.
  const ok = await call('book', { kind: 'task', task_id: vpn.id, starts_at: at('19:00'), ends_at: at('20:00') });
  assert.equal(ok.res.isError, undefined);
  const moved = await call('book', { id: ok.data.booking.id, starts_at: at('16:00'), ends_at: at('17:00') });
  assert.equal(moved.res.isError, true);
  // A task that can be done anywhere goes at the lab.
  assert.equal((await call('book', { kind: 'task', task_id: any.id, starts_at: at('14:00'), ends_at: at('15:00') })).res.isError, undefined);
  const day2 = (await call('schedule', { from: '2026-11-02' })).data.bookings.map((b) => b.title);
  assert.deepEqual(day2.sort(), ['Meeting', 'Reading', 'VPN work']);
});

test('timetable: the person\'s priority first, home-only tasks only at home, and misses_due for a due date in the period', () => {
  // Now: Sunday 2026-11-01 22:00 in Tokyo; tomorrow is Monday 2026-11-02, at the lab 09:00-13:00.
  const L = openLedger(':memory:', { now: () => new Date(at('22:00', '2026-11-01')) });
  writeSettings(L, { places: { places: PLACES }, week: { slots: [{ days: ['月'], start: '09:00', end: '13:00', place: '研究室' }] } }, {}, ACTOR);
  writeSettings(L, { limits: { day_max_hours: 6 } }, { byPerson: true }, ACTOR);
  const human = { mode: 'human', done_when: 'done' };
  L.createTask({ title: 'Due tomorrow 3', ...human, estimate_min: 60, due: '2026-11-02T22:00:00+09:00' }, ACTOR);
  L.createTask({ title: 'Person said first', ...human, estimate_min: 120, priority: 1 }, ACTOR);
  L.createTask({ title: 'VPN work', ...human, estimate_min: 120, only_at: 'home', priority: 2 }, ACTOR);
  L.createTask({ title: 'Due tomorrow 1', ...human, estimate_min: 60, due: '2026-11-02' }, ACTOR);
  L.createTask({ title: 'Due tomorrow 2', ...human, estimate_min: 60, due: '2026-11-02T20:00:00+09:00' }, ACTOR);
  L.createTask({ title: 'Due later', ...human, estimate_min: 60, due: '2026-12-01' }, ACTOR);
  const out = timetableFor(L);
  // At the lab: priority 1, then the nearer due dates; VPN work (priority 2) waits for home.
  assert.deepEqual(out.blocks.map((b) => [b.title, b.starts_at, b.ends_at]), [
    ['Person said first', utc('09:00'), utc('11:00')],
    ['Due tomorrow 1', utc('11:00'), utc('12:00')],
    ['Due tomorrow 2', utc('12:00'), utc('13:00')],
    ['VPN work', utc('13:00'), utc('15:00')],
  ]);
  assert.deepEqual(out.left.map((l) => [l.title, l.misses_due ?? false]), [['Due tomorrow 3', true], ['Due later', false]]);
  assert.equal(out.left[0].due, '2026-11-02T22:00:00+09:00');
  L.close();
});

test('timetable: a home-only task with no time at home is left with its reason', () => {
  const L = openLedger(':memory:', { now: () => new Date(at('22:00', '2026-11-01')) });
  writeSettings(L, { places: { places: PLACES }, week: { slots: [{ days: ['月'], start: '00:00', end: '24:00', place: '外出' }] } }, {}, ACTOR);
  L.createTask({ title: 'VPN work', mode: 'human', done_when: 'done', estimate_min: 60, only_at: 'home' }, ACTOR);
  const out = timetableFor(L);
  assert.deepEqual(out.blocks, []);
  assert.deepEqual(out.left.map((l) => [l.title, l.reason]), [['VPN work', '家にいる空きに入らなかった']]);
  L.close();
});
