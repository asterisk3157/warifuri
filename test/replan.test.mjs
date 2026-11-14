// Tests for planning again (組み直し): the watch that calls the secretary once when tasks with
// a due date come or change (src/secretary/replan.mjs), the timetable's replan (the oldest
// bookings stay, the newest move, the person's own never move), the travel it puts between
// places (移動), and the schema version 17 migration that adds the travel kind. The server's
// local time is pinned to Asia/Tokyo.

process.env.TZ = 'Asia/Tokyo';

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openLedger } from '../src/ledger/ledger.mjs';
import { MIGRATIONS } from '../src/ledger/schema.mjs';
import { writeSettings } from '../src/ledger/settings.mjs';
import { planTravel, timetableFor } from '../src/ledger/timetable.mjs';
import { travelMinutes, whereabouts } from '../src/ledger/whereabouts.mjs';
import { createReplanWatch, replanChanges, replanLine } from '../src/secretary/replan.mjs';
import { buildChatPrompt, writeTrigger, TRIGGERS } from '../src/secretary/chat.mjs';
import { noticeOf } from '../src/notify/notifier.mjs';
import { parseNight } from '../src/secretary/schedule.mjs';
import { scheduleFrom } from '../src/secretary/secretary.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warifuri-replan-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const AGENT = { actor: 'agent', device: 'laptop' };
const SECRETARY = { actor: 'secretary', device: 'secretary' };
const MIN = 60_000;
// 2026-11-02 is a Monday.
const at = (h, m = 0, d = 2) => new Date(2026, 10, d, h, m);
const iso = (h, m = 0, d = 2) => at(h, m, d).toISOString();

const PLACES = {
  places: [{ name: '家', home: true }, { name: '大学' }, { name: '研究室' }, { name: 'サークル' }, { name: '会社' }],
  travel: [
    { from: '家', to: '大学', minutes: 15 },
    { from: '研究室', to: '大学', minutes: 0 },
    { from: 'サークル', to: '大学', minutes: 0 },
    { from: '家', to: '会社', minutes: 90 },
  ],
};

function clockLedger(start = at(12)) {
  const clock = { now: start };
  const L = openLedger(':memory:', { now: () => clock.now });
  return { L, clock };
}

// --- the watch ---------------------------------------------------------------------------

test('changes: a task made with a due date, its goal\'s due date, and changes of due or estimate', () => {
  const rows = [
    { entity: 'task', entity_id: 't1', action: 'create', device: 'laptop', changes: { due: { before: null, after: '2026-11-20' } } },
    { entity: 'task', entity_id: 't2', action: 'create', device: 'laptop', changes: { title: { before: null, after: 'x' } } },
    { entity: 'task', entity_id: 't3', action: 'create', device: 'laptop', changes: { goal_id: { before: null, after: 'g1' } } },
    { entity: 'task', entity_id: 't4', action: 'update', device: 'laptop', changes: { due: { before: '2026-11-20', after: '2026-11-18' } } },
    { entity: 'task', entity_id: 't5', action: 'update', device: 'laptop', changes: { estimate_min: { before: 60, after: 120 } } },
    { entity: 'task', entity_id: 't6', action: 'update', device: 'laptop', changes: { title: { before: 'a', after: 'b' } } },
    { entity: 'task', entity_id: 't7', action: 'update', device: 'secretary', changes: { due: { before: null, after: '2026-11-19' } } },
  ];
  const out = replanChanges(rows, { ignoreDevice: 'secretary', goalDue: (id) => (id === 'g1' ? '2026-11-30' : null) });
  assert.deepEqual(out, [
    { task_id: 't1', change: 'created', due: '2026-11-20' },
    { task_id: 't3', change: 'created', due: '2026-11-30' },
    { task_id: 't4', change: 'due', due: '2026-11-18' },
    { task_id: 't5', change: 'estimate', estimate_min: 120 },
  ]);
  assert.equal(replanLine({ ...out[0], title: '発表の準備' }), '発表の準備: 締切つきで増えた(締切 2026-11-20)');
  assert.equal(replanLine({ ...out[3], title: '発表の準備' }), '発表の準備: 見積もりが変わった(120分)');
});

test('the watch: changes close together make one call, 10 minutes after the last; the secretary\'s own writes do not count', () => {
  const { L, clock } = clockLedger();
  const calls = [];
  // Made before the watch started: no backlog.
  const human = { mode: 'human', done_when: 'd' };
  const a = L.createTask({ title: 'A', ...human, due: '2026-11-20' }, AGENT);
  const watch = createReplanWatch({ ledger: L, now: () => clock.now, ignoreDevice: 'secretary', trigger: (tasks) => (calls.push(tasks), { sent: {} }) });
  watch.tick();
  const b = L.createTask({ title: 'B', ...human, due: '2026-11-21' }, AGENT);
  watch.tick();
  clock.now = at(12, 6);
  L.update(a.id, { estimate_min: 90 }, AGENT);
  L.update(b.id, { due: '2026-11-25' }, SECRETARY);
  watch.tick();
  clock.now = at(12, 15);
  assert.equal(watch.tick(), null, 'only 9 minutes after the last change');
  assert.equal(calls.length, 0);
  clock.now = at(12, 16);
  assert.deepEqual(watch.tick(), { sent: {} });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].map((c) => [c.title, c.change]), [['B', 'created'], ['A', 'estimate']]);
  clock.now = at(13);
  assert.equal(watch.tick(), null, 'nothing new: no second call');
  assert.equal(calls.length, 1);
  L.close();
});

test('the watch: a change in the night waits for the morning', () => {
  const { L, clock } = clockLedger(at(23, 30));
  const calls = [];
  const watch = createReplanWatch({ ledger: L, now: () => clock.now, night: parseNight('23:00-07:00'), trigger: (tasks) => (calls.push(tasks), { sent: {} }) });
  L.createTask({ title: 'Night task', mode: 'human', done_when: 'd', due: '2026-11-04' }, AGENT);
  watch.tick();
  clock.now = at(3, 0, 3);
  watch.tick();
  assert.equal(calls.length, 0);
  assert.equal(watch.pending.length, 1);
  clock.now = at(7, 0, 3);
  watch.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].title, 'Night task');
  L.close();
});

test('the call: the trigger names the tasks, the prompt lists them with replan.md, and the reply goes to Discord', () => {
  const { L } = clockLedger();
  const m = writeTrigger(L, 'replan', SECRETARY, { tasks: [{ task_id: 't1', title: '発表の準備', change: 'due', due: '2026-11-18' }] });
  assert.equal(m.body, TRIGGERS.replan);
  const prompt = buildChatPrompt({ now: at(12), schedule: scheduleFrom({}), feed: [m] });
  assert.match(prompt, /t1 発表の準備: 締切が変わった\(締切 2026-11-18\)/);
  assert.match(prompt, /# 計画の組み直し/);
  const notice = noticeOf({ role: 'secretary', kind: 'text', body: '直近の状況を見て、こう組み直しました。どうですか', data: { scheduled: 'replan' } }, null);
  assert.match(notice.text, /^計画を組み直しました。\n直近の状況を見て/);
  L.close();
});

// --- replan --------------------------------------------------------------------------------

// Two tasks of one hour a day, a Monday to plan; tomorrow (Tuesday) is the period.
function planLedger() {
  const { L, clock } = clockLedger(at(12, 0, 2));
  writeSettings(L, { limits: { earliest: '09:00', latest: '18:00', day_max_hours: 8 } }, { byPerson: true }, AGENT);
  const human = { mode: 'human', done_when: 'd' };
  const old = L.createTask({ title: 'Old', ...human, estimate_min: 60 }, AGENT);
  const fresh = L.createTask({ title: 'Fresh', ...human, estimate_min: 60 }, AGENT);
  return { L, clock, old, fresh, human };
}

test('replan: the oldest booking stays where a newer one clashes; the newer moves and is listed before and after', () => {
  const { L, clock, old, fresh } = planLedger();
  const first = L.book({ kind: 'task', task_id: old.id, starts_at: iso(10, 0, 3), ends_at: iso(11, 0, 3) }, SECRETARY).booking;
  clock.now = at(13, 0, 2);
  const second = L.book({ kind: 'task', task_id: fresh.id, starts_at: iso(10, 30, 3), ends_at: iso(11, 30, 3) }, SECRETARY).booking;
  const out = timetableFor(L, { from: iso(0, 0, 3), to: iso(0, 0, 4), replan: true });
  assert.equal(out.blocks.length, 1);
  const moved = out.blocks[0];
  assert.equal(moved.task_id, fresh.id);
  assert.equal(moved.booking_id, second.id);
  assert.ok(Date.parse(moved.starts_at) >= Date.parse(first.ends_at) || Date.parse(moved.ends_at) <= Date.parse(first.starts_at));
  assert.equal(out.changes.length, 1);
  assert.deepEqual(out.changes[0].before, { starts_at: second.starts_at, ends_at: second.ends_at });
  assert.match(out.changes[0].line, /^Fresh: 11\/3\(火\) 10:30〜11:30 → 11\/3\(火\) \d\d:\d\d〜\d\d:\d\d$/);
  assert.deepEqual(out.unbook, []);
  L.close();
});

test('replan: the person\'s fixed booking never moves; a warifuri booking that clashes with it moves', () => {
  const { L, old } = planLedger();
  const mine = L.book({ kind: 'task', task_id: old.id, starts_at: iso(9, 0, 3), ends_at: iso(10, 0, 3) }, SECRETARY).booking;
  const meeting = L.book({ kind: 'fixed', title: '打ち合わせ', starts_at: iso(9, 0, 3), ends_at: iso(12, 0, 3) }, AGENT).booking;
  const out = timetableFor(L, { from: iso(0, 0, 3), to: iso(0, 0, 4), replan: true });
  const ids = [...out.blocks.map((b) => b.booking_id), ...out.unbook.map((u) => u.booking_id)];
  assert.equal(ids.includes(meeting.id), false);
  const block = out.blocks.find((b) => b.task_id === old.id);
  assert.equal(block.booking_id, mine.id);
  assert.ok(Date.parse(block.starts_at) >= at(12, 0, 3).getTime());
  // Without replan, the same booking stays where it is.
  assert.equal(timetableFor(L, { from: iso(0, 0, 3), to: iso(0, 0, 4) }).blocks.some((b) => b.booking_id), false);
  L.close();
});

test('replan: when a task would miss its due date, the newest bookings go first and the oldest stay', () => {
  const { L, clock, human } = planLedger();
  writeSettings(L, { limits: { earliest: '09:00', latest: '12:00', day_max_hours: 3 } }, { byPerson: true }, AGENT);
  const a = L.createTask({ title: 'A', ...human, estimate_min: 60 }, AGENT);
  const b = L.createTask({ title: 'B', ...human, estimate_min: 60 }, AGENT);
  const c = L.createTask({ title: 'C', ...human, estimate_min: 60 }, AGENT);
  const ba = L.book({ kind: 'task', task_id: a.id, starts_at: iso(9, 0, 3), ends_at: iso(10, 0, 3) }, SECRETARY).booking;
  clock.now = at(12, 10, 2);
  L.book({ kind: 'task', task_id: b.id, starts_at: iso(10, 0, 3), ends_at: iso(11, 0, 3) }, SECRETARY);
  clock.now = at(12, 20, 2);
  const bc = L.book({ kind: 'task', task_id: c.id, starts_at: iso(11, 0, 3), ends_at: iso(12, 0, 3) }, SECRETARY).booking;
  // Old and Fresh need an hour each too; Urgent is due tomorrow and the day is full.
  const urgent = L.createTask({ title: 'Urgent', ...human, estimate_min: 60, due: '2026-11-03T12:00:00+09:00', priority: 1 }, AGENT);
  const out = timetableFor(L, { from: iso(0, 0, 3), to: iso(0, 0, 4), replan: true });
  assert.equal(out.left.some((l) => l.misses_due), false);
  const urgentBlock = out.blocks.find((x) => x.task_id === urgent.id);
  assert.equal(urgentBlock.booking_id, undefined);
  // C, the newest, made room; A, the oldest, stayed.
  assert.deepEqual(out.unbook.map((u) => u.booking_id), [bc.id]);
  assert.equal(out.changes.some((x) => x.booking_id === ba.id), false);
  assert.ok(out.changes.some((x) => x.booking_id === bc.id && x.after === null && /を外す$/.test(x.line)));
  L.close();
});

test('replan: a booking the person moved in the calendar stays, and one of a task closed since goes', () => {
  const { L, old, fresh } = planLedger();
  const moved = L.book({ kind: 'task', task_id: old.id, starts_at: iso(9, 0, 3), ends_at: iso(10, 0, 3) }, SECRETARY).booking;
  L.book({ id: moved.id, starts_at: iso(17, 0, 3), ends_at: iso(18, 0, 3) }, { actor: 'calendar-watch', device: 'calendar-watch' });
  L.book({ kind: 'fixed', title: '授業', starts_at: iso(17, 0, 3), ends_at: iso(18, 0, 3) }, AGENT);
  const gone = L.book({ kind: 'task', task_id: fresh.id, starts_at: iso(9, 0, 3), ends_at: iso(10, 0, 3) }, SECRETARY).booking;
  L.setState(fresh.id, 'done', { result: 'r' }, AGENT);
  const out = timetableFor(L, { from: iso(0, 0, 3), to: iso(0, 0, 4), replan: true });
  assert.equal(out.blocks.some((b) => b.booking_id === moved.id), false);
  assert.deepEqual(out.unbook.map((u) => u.booking_id), [gone.id]);
  L.close();
});

test('weekdays first: Saturday and Sunday take only what the weekdays could not', () => {
  // Now: Thursday 2026-11-05 12:00; the period runs Friday to Sunday.
  const { L } = clockLedger(at(12, 0, 5));
  writeSettings(L, { limits: { earliest: '09:00', latest: '11:00', day_max_hours: 2 } }, { byPerson: true }, AGENT);
  const human = { mode: 'human', done_when: 'd' };
  const tasks = ['P', 'Q', 'R'].map((t) => L.createTask({ title: t, ...human, estimate_min: 60 }, AGENT));
  const out = timetableFor(L, { from: iso(0, 0, 7), to: iso(0, 0, 9) });
  // Saturday and Sunday only: the first day of the weekend fills first.
  assert.deepEqual(out.blocks.map((b) => new Date(b.starts_at).getDate()), [7, 7, 8]);
  const week = timetableFor(L, { from: iso(0, 0, 6), to: iso(0, 0, 9) });
  // Friday takes two; Saturday the one that did not fit.
  assert.deepEqual(week.blocks.map((b) => new Date(b.starts_at).getDate()), [6, 6, 7]);
  assert.equal(tasks.length, 3);
  L.close();
});

// --- travel --------------------------------------------------------------------------------

test('travel minutes: the shortest way through the times written, both ways, null when none', () => {
  assert.equal(travelMinutes('家', '研究室', PLACES.travel), 15);
  assert.equal(travelMinutes('研究室', 'サークル', PLACES.travel), 0);
  assert.equal(travelMinutes('会社', '研究室', PLACES.travel), 105);
  assert.equal(travelMinutes('家', '家', PLACES.travel), 0);
  assert.equal(travelMinutes('家', '駅', PLACES.travel), null);
  // The lab is away from home for 15 minutes on each side.
  const spans = whereabouts({ fromMs: at(0).getTime(), toMs: at(0, 0, 3).getTime(), bookings: [{ starts_at: iso(13), ends_at: iso(15), location: '研究室' }], places: PLACES.places, travel: PLACES.travel });
  const away = spans.find((x) => x.place === '研究室');
  assert.deepEqual([away.s, away.e], [at(12, 45).getTime(), at(15, 15).getTime()]);
});

test('travel: only between different places, none for a way of 0 minutes, from home and back', () => {
  const bookings = [
    { id: 'b1', kind: 'fixed', starts_at: iso(10), ends_at: iso(12), location: '研究室' },
    { id: 'b2', kind: 'fixed', starts_at: iso(13), ends_at: iso(15), location: 'サークル' },
    { id: 'b3', kind: 'fixed', starts_at: iso(16), ends_at: iso(17), location: 'サークル' },
    { id: 'b4', kind: 'fixed', starts_at: iso(18), ends_at: iso(19), location: 'https://meet.example/x' },
    { id: 'b5', kind: 'task', starts_at: iso(20), ends_at: iso(21) },
  ];
  const out = planTravel({ bookings, places: PLACES.places, travel: PLACES.travel, fromMs: at(0).getTime(), toMs: at(0, 0, 3).getTime() });
  assert.deepEqual(out.map((t) => [t.from, t.to, t.starts_at, t.ends_at, t.minutes]), [
    ['家', '研究室', iso(9, 45), iso(10), 15],
    ['サークル', '家', iso(17), iso(17, 15), 15],
  ]);
  // A day at home and online only: no travel.
  assert.deepEqual(planTravel({ bookings: [bookings[3], bookings[4], { kind: 'fixed', starts_at: iso(9), ends_at: iso(10), location: '家' }], places: PLACES.places, travel: PLACES.travel, fromMs: at(0).getTime(), toMs: at(0, 0, 3).getTime() }), []);
  // A way that does not fit after the booking before it starts when that ends.
  const tight = planTravel({
    bookings: [{ id: 'x', kind: 'fixed', starts_at: iso(9), ends_at: iso(10), location: '会社' }, { id: 'y', kind: 'fixed', starts_at: iso(10, 30), ends_at: iso(11), location: '研究室' }],
    places: PLACES.places, travel: PLACES.travel, fromMs: at(0).getTime(), toMs: at(0, 0, 3).getTime(),
  });
  assert.deepEqual(tight.map((t) => [t.from, t.to, t.starts_at, t.minutes, t.short ?? false]), [
    ['家', '会社', iso(7, 30), 90, false],
    ['会社', '研究室', iso(10), 30, true],
    ['研究室', '家', iso(11), 15, false],
  ]);
});

test('travel on the ledger: put once as travel bookings, kept when booked, moved when the booking moves, and kept out of the blocks', () => {
  const { L } = clockLedger(at(12, 0, 2));
  writeSettings(L, { places: PLACES, limits: { earliest: '09:00', latest: '18:00' } }, { byPerson: true }, AGENT);
  const seminar = L.book({ kind: 'fixed', title: 'ゼミ', starts_at: iso(13, 0, 3), ends_at: iso(14, 0, 3), location: '研究室' }, AGENT).booking;
  L.createTask({ title: 'Work', mode: 'human', done_when: 'd', estimate_min: 240 }, AGENT);
  const period = { from: iso(0, 0, 3), to: iso(0, 0, 4) };
  const out = timetableFor(L, period);
  assert.deepEqual(out.travel.map((t) => [t.from, t.to, t.starts_at, t.ends_at]), [
    ['家', '研究室', iso(12, 45, 3), iso(13, 0, 3)],
    ['研究室', '家', iso(14, 0, 3), iso(14, 15, 3)],
  ]);
  for (const b of out.blocks) {
    for (const t of out.travel) assert.ok(b.ends_at <= t.starts_at || b.starts_at >= t.ends_at, 'a block in the way');
  }
  for (const t of out.travel) L.book({ kind: 'travel', starts_at: t.starts_at, ends_at: t.ends_at }, SECRETARY);
  assert.equal(L.schedule(period).bookings.filter((b) => b.kind === 'travel')[0].title, '移動');
  assert.deepEqual(timetableFor(L, period).travel, []);
  // The seminar moves an hour later: both ways move with it.
  L.book({ id: seminar.id, starts_at: iso(14, 0, 3), ends_at: iso(15, 0, 3) }, AGENT);
  const again = timetableFor(L, period);
  assert.equal(again.travel.length, 2);
  assert.ok(again.travel.every((t) => t.booking_id));
  assert.deepEqual(again.travel.map((t) => t.starts_at), [iso(13, 45, 3), iso(15, 0, 3)]);
  assert.equal(again.changes.filter((c) => c.kind === 'travel').length, 2);
  // The seminar goes: so do the ways.
  L.unbook(seminar.id, AGENT);
  assert.equal(timetableFor(L, period).unbook.filter((u) => u.kind === 'travel').length, 2);
  L.close();
});

// --- schema --------------------------------------------------------------------------------

test('schema: a version 16 file keeps its bookings and takes travel ones', () => {
  const file = path.join(tmpRoot, 'v16.sqlite');
  const raw = new DatabaseSync(file);
  raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const m of MIGRATIONS.slice(0, 16)) raw.exec(m);
  raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '16')").run();
  raw
    .prepare(
      'INSERT INTO bookings (id, title, kind, starts_at, ends_at, created_at, updated_at, source, external_id, location) ' +
        "VALUES ('b_20261001000000_aaaaaa', 'ゼミ', 'fixed', '2026-11-03T04:00:00.000Z', '2026-11-03T05:00:00.000Z', 'x', 'x', 'google-calendar', 'ev1', '研究室')",
    )
    .run();
  assert.throws(() => raw.exec("INSERT INTO bookings (id, title, kind, starts_at, ends_at, created_at, updated_at) VALUES ('b2', '移動', 'travel', 'a', 'b', 'x', 'x')"), /CHECK/);
  raw.close();
  const L = openLedger(file);
  const old = L.getBooking('b_20261001000000_aaaaaa');
  assert.deepEqual([old.title, old.source, old.external_id, old.location], ['ゼミ', 'google-calendar', 'ev1', '研究室']);
  assert.equal(L.bookingFor('google-calendar', 'ev1').id, old.id);
  const travel = L.book({ kind: 'travel', starts_at: '2026-11-03T03:45:00Z', ends_at: '2026-11-03T04:00:00Z' }, AGENT).booking;
  assert.equal(travel.kind, 'travel');
  assert.throws(() => L.book({ id: travel.id, source: 'google-calendar', external_id: 'ev1' }, AGENT), /もう予定/);
  L.close();
});
