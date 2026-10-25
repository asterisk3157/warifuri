// Tests for bookings (予定): the schema version 4 and 6 migrations, book / unbook / schedule in
// the ledger (their rules, overlaps, the range and order of schedule, the profile it derives),
// the outside event a booking names (source, external_id) and importing it twice,
// bookings dropped on import, devices' last_seen_at and its throttle, and the MCP tools.
// The server's local time is pinned to Asia/Tokyo, so "today" and YYYY-MM-DD have one meaning.

process.env.TZ = 'Asia/Tokyo';

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openLedger, LedgerError } from '../src/ledger/ledger.mjs';
import { MIGRATIONS, SCHEMA_VERSION } from '../src/ledger/schema.mjs';
import { createServer } from '../src/server/mcp.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warifuri-bookings-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const ACTOR = { actor: 'human' };
const AGENT = { actor: 'device-key', device: 'laptop' };
let fileCounter = 0;

// A clock the test moves by hand. It starts at 12:00 in Tokyo on 2026-10-25.
function handClock(start = '2026-10-25T03:00:00Z') {
  const c = { t: Date.parse(start) };
  c.now = () => new Date(c.t);
  c.advance = (ms) => {
    c.t += ms;
  };
  return c;
}

function fresh(t) {
  fileCounter += 1;
  const file = path.join(tmpRoot, `ledger-${fileCounter}.db`);
  const clock = handClock();
  const L = openLedger(file, { now: clock.now });
  const raw = new DatabaseSync(file);
  t.after(() => {
    raw.close();
    L.close();
  });
  const count = (table, where = '1 = 1') => raw.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get().n;
  return { L, raw, count, clock, file };
}

function seed(L) {
  const research = L.createGoal({ title: 'Thesis', mode: 'ai_worker', profile: 'research' }, ACTOR);
  const bare = L.createGoal({ title: 'No profile goal', mode: 'ai_worker' }, ACTOR);
  const hobbyPlace = L.createPlace({ name: 'garden', profile: 'hobby' }, ACTOR);
  const clubPlace = L.createPlace({ name: 'club room', profile: 'club' }, ACTOR);
  const read = L.createTask({ title: 'Read papers', mode: 'ai_worker', goal_id: research.id, place_id: clubPlace.id }, ACTOR);
  const weed = L.createTask({ title: 'Weed the garden', mode: 'ai_worker', goal_id: bare.id, place_id: hobbyPlace.id }, ACTOR);
  const loose = L.createTask({ title: 'Loose task', mode: 'ai_worker', place_id: clubPlace.id }, ACTOR);
  const nowhere = L.createTask({ title: 'Nowhere task', mode: 'ai_worker' }, ACTOR);
  const run = L.createHabit({ title: 'Run', rule: 'Mon Wed Fri 7:00', duration_min: 30, goal_id: research.id }, ACTOR);
  return { research, bare, read, weed, loose, nowhere, run };
}

test('schema: a version 3 file gains bookings and devices.last_seen_at, keeps its rows, and records bookings', () => {
  const file = path.join(tmpRoot, `v3-${Date.now()}.sqlite`);
  const raw = new DatabaseSync(file);
  raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const m of MIGRATIONS.slice(0, 3)) raw.exec(m);
  raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '3')").run();
  raw.prepare("INSERT INTO devices (name, created_at) VALUES ('laptop', '2026-10-01T00:00:00.000Z')").run();
  raw
    .prepare("INSERT INTO tasks (id, title, state, mode, created_at, updated_at) VALUES ('t_20261001000000_aaaaaa', 'Old task', 'ready', 'ai_worker', 'x', 'x')")
    .run();
  const ins = raw.prepare('INSERT INTO records (at, actor, device, entity, entity_id, action, changes) VALUES (?, ?, ?, ?, ?, ?, ?)');
  ins.run('2026-10-01T00:00:00.000Z', 'human', null, 'task', 't_20261001000000_aaaaaa', 'create', '{}');
  ins.run('2026-10-02T00:00:00.000Z', 'human', null, 'knowledge', 'hobby', 'note', '{}');
  assert.throws(() => ins.run('2026-10-03T00:00:00.000Z', 'human', null, 'booking', 'b1', 'create', '{}'), /CHECK/);
  raw.close();

  assert.equal(SCHEMA_VERSION, 6);
  const L = openLedger(file, { now: handClock().now });
  assert.deepEqual(L.listDevices().map((d) => [d.name, d.last_seen_at]), [['laptop', null]]);
  assert.deepEqual(L.records('hobby').map((r) => [r.id, r.entity]), [[2, 'knowledge']]);
  const { booking } = L.book({ kind: 'task', task_id: 't_20261001000000_aaaaaa', starts_at: '2026-10-25T10:00:00+09:00', ends_at: '2026-10-25T11:00:00+09:00' }, ACTOR);
  assert.match(booking.id, /^b_\d{14}_[a-z0-9]{6}$/);
  assert.deepEqual(L.records(booking.id).map((r) => [r.id, r.entity, r.action]), [[3, 'booking', 'create']]);
  L.close();

  const check = new DatabaseSync(file);
  assert.equal(check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '6');
  assert.ok(check.prepare("SELECT 1 FROM sqlite_master WHERE name = 'bookings_starts'").get());
  assert.equal(check.prepare("SELECT 1 FROM sqlite_master WHERE name = 'records_v3'").get(), undefined);
  assert.throws(() => check.exec('DELETE FROM records WHERE id = 1'), /append-only/);
  check.prepare("UPDATE meta SET value = '7' WHERE key = 'schema_version'").run();
  check.close();
  assert.throws(() => openLedger(file), /newer than this warifuri/);
});

test('schema: a version 5 file gains source and external_id on its bookings, one booking per pair', () => {
  const file = path.join(tmpRoot, `v5-${Date.now()}.sqlite`);
  const raw = new DatabaseSync(file);
  raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const m of MIGRATIONS.slice(0, 5)) raw.exec(m);
  raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '5')").run();
  raw
    .prepare(
      "INSERT INTO bookings (id, title, kind, starts_at, ends_at, created_at, updated_at) " +
        "VALUES ('b_20261001000000_aaaaaa', 'Dentist', 'fixed', '2026-10-25T01:00:00.000Z', '2026-10-25T02:00:00.000Z', 'x', 'x')",
    )
    .run();
  raw.close();

  const L = openLedger(file, { now: handClock().now });
  const [old] = L.schedule({ from: '2026-10-25' }).bookings;
  assert.equal(old.title, 'Dentist');
  assert.equal(old.source, null);
  assert.equal(old.external_id, null);
  L.close();

  const check = new DatabaseSync(file);
  assert.equal(check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '6');
  const ins = check.prepare(
    "INSERT INTO bookings (id, title, kind, starts_at, ends_at, source, external_id, created_at, updated_at) " +
      "VALUES (?, 'x', 'fixed', '2026-10-25T01:00:00.000Z', '2026-10-25T02:00:00.000Z', ?, ?, 'x', 'x')",
  );
  ins.run('b_20261001000000_bbbbbb', 'google-calendar', 'ev1');
  assert.throws(() => ins.run('b_20261001000000_cccccc', 'google-calendar', 'ev1'), /UNIQUE/);
  // Without external_id, the index does not apply.
  ins.run('b_20261001000000_dddddd', 'google-calendar', null);
  ins.run('b_20261001000000_eeeeee', 'google-calendar', null);
  check.close();
});

test('book: each kind needs what it names, and a refused booking writes nothing', (t) => {
  const { L, count } = fresh(t);
  const s = seed(L);
  const span = { starts_at: '2026-10-25T10:00:00+09:00', ends_at: '2026-10-25T11:00:00+09:00' };
  const refused = (fields, ...patterns) => {
    try {
      L.book(fields, ACTOR);
    } catch (e) {
      assert.ok(e instanceof LedgerError);
      for (const p of patterns) assert.ok(e.problems.some((x) => p.test(x)), `${p} in ${e.problems.join(' / ')}`);
      return e.problems;
    }
    return assert.fail(`should be refused: ${JSON.stringify(fields)}`);
  };
  refused({ ...span }, /予定の種類\(kind\)/);
  refused({ kind: 'task', ...span }, /タスク\(task_id\)が要ります/);
  refused({ kind: 'task', task_id: 't_20261001000000_nosuch', ...span }, /タスク t_20261001000000_nosuch がありません/);
  refused({ kind: 'habit', ...span }, /習慣\(habit_id\)が要ります/);
  refused({ kind: 'habit', habit_id: 'h_20261001000000_nosuch', ...span }, /習慣 h_20261001000000_nosuch がありません/);
  refused({ kind: 'fixed', ...span }, /固定の予定には題名/);
  refused({ kind: 'fixed', title: 'Dentist', task_id: s.read.id, ...span }, /task_id は、種類が task の予定にだけ/);
  refused({ kind: 'task', task_id: s.read.id, habit_id: s.run.id, ...span }, /habit_id は、種類が habit の予定にだけ/);
  refused({ kind: 'fixed', title: 'Dentist' }, /始まり\(starts_at\)が要ります/, /終わり\(ends_at\)が要ります/);
  refused({ kind: 'fixed', title: 'Dentist', starts_at: '2026-10-25', ends_at: '2026-10-25T11:00:00' }, /始まり\(starts_at\)は時差つき/, /終わり\(ends_at\)は時差つき/);
  refused({ kind: 'fixed', title: 'Dentist', starts_at: '2026-10-25T11:00:00+09:00', ends_at: '2026-10-25T11:00:00+09:00' }, /より後に/);
  refused({ kind: 'fixed', title: 'Dentist', starts_at: '2026-10-25T00:00:00Z', ends_at: '2026-10-26T00:00:01Z' }, /24時間まで/);
  refused({ kind: 'fixed', title: 'Dentist', color: 'red', ...span }, /color はここでは書けません/);
  // Several problems come back together.
  assert.ok(refused({ kind: 'task' }).length >= 3);
  assert.throws(() => L.book({ id: 'b_20261001000000_nosuch', title: 'x' }, ACTOR), /b_20261001000000_nosuch という予定はありません/);
  assert.throws(() => L.unbook('b_20261001000000_nosuch', ACTOR), /という予定はありません/);
  assert.throws(() => L.book({ kind: 'fixed', title: 'x', ...span }, {}), /actor/);
  assert.equal(count('bookings'), 0);
  assert.equal(count('records', "entity = 'booking'"), 0);

  // Exactly 24 hours is fine.
  assert.equal(L.book({ kind: 'fixed', title: 'Trip', starts_at: '2026-10-25T00:00:00Z', ends_at: '2026-10-26T00:00:00Z' }, ACTOR).booking.title, 'Trip');
});

test('book: titles default to the task or habit, times are stored in UTC, and an update changes only what is given', (t) => {
  const { L, clock } = fresh(t);
  const s = seed(L);
  const { booking: a } = L.book({ kind: 'task', task_id: s.read.id, starts_at: '2026-10-25T10:00:00+09:00', ends_at: '2026-10-25T11:30:00+09:00' }, AGENT);
  assert.equal(a.title, 'Read papers');
  assert.equal(a.starts_at, '2026-10-25T01:00:00.000Z');
  assert.equal(a.ends_at, '2026-10-25T02:30:00.000Z');
  assert.equal(a.habit_id, null);
  assert.equal(a.note, null);
  const { booking: h } = L.book({ kind: 'habit', habit_id: s.run.id, title: 'Long run', starts_at: '2026-10-26T07:00:00+09:00', ends_at: '2026-10-26T08:00:00+09:00' }, ACTOR);
  assert.equal(h.title, 'Long run'); // a given title wins
  assert.equal(L.book({ kind: 'habit', habit_id: s.run.id, starts_at: '2026-10-27T07:00:00+09:00', ends_at: '2026-10-27T07:30:00+09:00' }, ACTOR).booking.title, 'Run');

  clock.advance(60_000);
  const { booking: moved } = L.book({ id: a.id, starts_at: '2026-10-25T13:00:00+09:00', ends_at: '2026-10-25T14:00:00+09:00', note: 'after lunch' }, AGENT);
  assert.equal(moved.id, a.id);
  assert.equal(moved.title, 'Read papers');
  assert.equal(moved.task_id, s.read.id);
  assert.equal(moved.starts_at, '2026-10-25T04:00:00.000Z');
  assert.equal(moved.note, 'after lunch');
  assert.equal(moved.created_at, a.created_at);
  assert.notEqual(moved.updated_at, a.updated_at);
  // Pointing it at another task takes that task's title.
  assert.equal(L.book({ id: a.id, task_id: s.weed.id }, AGENT).booking.title, 'Weed the garden');
  // Turning it into a fixed booking drops the task link and keeps the title.
  const fixed = L.book({ id: a.id, kind: 'fixed', title: 'Dentist' }, AGENT).booking;
  assert.equal(fixed.task_id, null);
  assert.equal(fixed.title, 'Dentist');
  // Nothing changed: no record.
  const before = L.records(a.id).length;
  L.book({ id: a.id, title: 'Dentist' }, AGENT);
  assert.equal(L.records(a.id).length, before);
  // Back to fixed without a title is refused.
  assert.throws(() => L.book({ id: a.id, title: '' }, AGENT), /固定の予定には題名/);

  const recs = L.records(a.id);
  assert.deepEqual(recs.map((r) => [r.action, r.actor, r.device]), [
    ['create', 'device-key', 'laptop'],
    ['update', 'device-key', 'laptop'],
    ['update', 'device-key', 'laptop'],
    ['update', 'device-key', 'laptop'],
  ]);
  assert.deepEqual(recs[1].changes.note, { before: null, after: 'after lunch' });

  // unbook deletes the booking, keeps the task, and records the row as it was.
  const gone = L.unbook(a.id, ACTOR);
  assert.equal(gone.title, 'Dentist');
  const del = L.records(a.id).at(-1);
  assert.equal(del.action, 'delete');
  assert.deepEqual(del.changes.title, { before: 'Dentist', after: null });
  assert.deepEqual(del.changes.starts_at, { before: '2026-10-25T04:00:00.000Z', after: null });
  assert.equal(L.get(s.read.id).title, 'Read papers');
  assert.equal(L.schedule({ from: '2026-10-25' }).bookings.some((b) => b.id === a.id), false);
});

test('book: a source and external_id already in the ledger change that booking instead of making a second one', (t) => {
  const { L, count } = fresh(t);
  const event = {
    kind: 'fixed', title: 'Dentist', source: 'google-calendar', external_id: 'ev1',
    starts_at: '2026-10-25T10:00:00+09:00', ends_at: '2026-10-25T11:00:00+09:00',
  };
  const first = L.book(event, AGENT).booking;
  assert.equal(first.source, 'google-calendar');
  assert.equal(first.external_id, 'ev1');
  // The same event again, unchanged: the same booking, and no new record.
  assert.equal(L.book(event, AGENT).booking.id, first.id);
  assert.equal(count('bookings'), 1);
  assert.deepEqual(L.records(first.id).map((r) => r.action), ['create']);
  // The event moved over there: the booking follows, as a change.
  const moved = L.book({ ...event, starts_at: '2026-10-25T13:00:00+09:00', ends_at: '2026-10-25T14:00:00+09:00' }, AGENT).booking;
  assert.equal(moved.id, first.id);
  assert.equal(moved.starts_at, '2026-10-25T04:00:00.000Z');
  assert.equal(count('bookings'), 1);
  const update = L.records(first.id).at(-1);
  assert.equal(update.action, 'update');
  assert.deepEqual(Object.keys(update.changes).sort(), ['ends_at', 'starts_at']);
  // The same id in another source, or no pair at all, is another booking.
  assert.notEqual(L.book({ ...event, source: 'other-calendar' }, AGENT).booking.id, first.id);
  assert.notEqual(L.book({ ...event, source: undefined, external_id: undefined }, AGENT).booking.id, first.id);
  assert.equal(count('bookings'), 3);

  // schedule returns both fields.
  const day = L.schedule({ from: '2026-10-25' }).bookings;
  assert.deepEqual(
    day.map((b) => [b.source, b.external_id]).sort(),
    [[null, null], ['google-calendar', 'ev1'], ['other-calendar', 'ev1']].sort(),
  );

  // external_id needs source, also when source would be cleared from a booking that has one.
  assert.throws(() => L.book({ ...event, source: undefined, external_id: 'ev2' }, AGENT), /external_id\)には、出どころ\(source\)も要ります/);
  assert.throws(() => L.book({ id: first.id, source: null }, AGENT), /出どころ\(source\)も要ります/);
  assert.throws(() => L.book({ ...event, external_id: 5 }, AGENT), /external_id\)は文字列です/);
  assert.equal(count('bookings'), 3);
  // Clearing both lets the booking go its own way: the event, imported again, is a new booking.
  assert.equal(L.book({ id: first.id, source: null, external_id: null }, AGENT).booking.external_id, null);
  assert.notEqual(L.book(event, AGENT).booking.id, first.id);
  assert.equal(count('bookings'), 4);
});

test('book: with id, a source and external_id can be attached, unless another booking has the pair', (t) => {
  const { L } = fresh(t);
  const s = seed(L);
  const span = { starts_at: '2026-10-25T10:00:00+09:00', ends_at: '2026-10-25T11:00:00+09:00' };
  // A task's booking, written out to the calendar, gets the event's id back.
  const mine = L.book({ kind: 'task', task_id: s.read.id, ...span }, AGENT).booking;
  const attached = L.book({ id: mine.id, source: 'google-calendar', external_id: 'ev9' }, AGENT).booking;
  assert.equal(attached.id, mine.id);
  assert.equal(attached.title, 'Read papers');
  assert.deepEqual(L.records(mine.id).at(-1).changes, {
    source: { before: null, after: 'google-calendar' },
    external_id: { before: null, after: 'ev9' },
  });
  // Importing that event later finds the same booking.
  assert.equal(L.book({ kind: 'task', task_id: s.read.id, source: 'google-calendar', external_id: 'ev9', ...span }, AGENT).booking.id, mine.id);
  // Giving the same pair again with its own id is fine.
  assert.equal(L.book({ id: mine.id, source: 'google-calendar', external_id: 'ev9' }, AGENT).booking.id, mine.id);

  const other = L.book({ kind: 'fixed', title: 'Call', ...span }, AGENT).booking;
  assert.throws(
    () => L.book({ id: other.id, source: 'google-calendar', external_id: 'ev9' }, AGENT),
    new RegExp(`出どころ google-calendar の ev9 は、もう予定 ${mine.id} に付いています`),
  );
  assert.equal(L.schedule({ from: '2026-10-25' }).bookings.find((b) => b.id === other.id).external_id, null);
});

test('book: overlaps are allowed and listed, without the booking itself or ones that only touch', (t) => {
  const { L } = fresh(t);
  const s = seed(L);
  const at = (h, m = 0) => `2026-10-25T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+09:00`;
  const a = L.book({ kind: 'fixed', title: 'A', starts_at: at(9), ends_at: at(10) }, ACTOR);
  assert.deepEqual(a.overlaps, []);
  const b = L.book({ kind: 'task', task_id: s.read.id, starts_at: at(9, 30), ends_at: at(10, 30) }, ACTOR);
  assert.deepEqual(b.overlaps.map((x) => x.id), [a.booking.id]);
  const c = L.book({ kind: 'fixed', title: 'C', starts_at: at(10), ends_at: at(11) }, ACTOR);
  assert.deepEqual(c.overlaps.map((x) => x.id), [b.booking.id]); // A ends at 10:00: it only touches
  const wide = L.book({ kind: 'fixed', title: 'Wide', starts_at: at(8), ends_at: at(12) }, ACTOR);
  assert.deepEqual(wide.overlaps.map((x) => x.title), ['A', 'Read papers', 'C']);
  // Moving A away leaves it with no overlap but Wide.
  assert.deepEqual(L.book({ id: a.booking.id, starts_at: at(12), ends_at: at(13) }, ACTOR).overlaps, []);
  assert.deepEqual(L.book({ id: a.booking.id, starts_at: at(11, 30), ends_at: at(13) }, ACTOR).overlaps.map((x) => x.title), ['Wide']);
});

test('schedule: today by default, [from, to) by start, with task, goal and the profile it derives', (t) => {
  const { L } = fresh(t);
  const s = seed(L);
  const mk = (fields, from, to) => L.book({ ...fields, starts_at: from, ends_at: to }, ACTOR).booking;
  const read = mk({ kind: 'task', task_id: s.read.id }, '2026-10-25T15:00:00+09:00', '2026-10-25T16:00:00+09:00');
  const weed = mk({ kind: 'task', task_id: s.weed.id }, '2026-10-25T09:00:00+09:00', '2026-10-25T10:00:00+09:00');
  const loose = mk({ kind: 'task', task_id: s.loose.id }, '2026-10-25T11:00:00+09:00', '2026-10-25T12:00:00+09:00');
  const nowhere = mk({ kind: 'task', task_id: s.nowhere.id }, '2026-10-25T12:00:00+09:00', '2026-10-25T12:30:00+09:00');
  const run = mk({ kind: 'habit', habit_id: s.run.id }, '2026-10-25T07:00:00+09:00', '2026-10-25T07:30:00+09:00');
  const dentist = mk({ kind: 'fixed', title: 'Dentist' }, '2026-10-25T18:00:00+09:00', '2026-10-25T19:00:00+09:00');
  // Crosses midnight into the 25th: it shares time with the day.
  const night = mk({ kind: 'fixed', title: 'Night shift' }, '2026-10-24T22:00:00+09:00', '2026-10-25T02:00:00+09:00');
  // Starts exactly at the end of the 25th: not in it.
  const tomorrow = mk({ kind: 'fixed', title: 'Tomorrow' }, '2026-10-26T00:00:00+09:00', '2026-10-26T01:00:00+09:00');
  const yesterday = mk({ kind: 'fixed', title: 'Yesterday' }, '2026-10-24T09:00:00+09:00', '2026-10-24T10:00:00+09:00');

  // The clock reads 12:00 in Tokyo on the 25th; today is the Tokyo day.
  const today = L.schedule();
  assert.equal(today.from, '2026-10-24T15:00:00.000Z');
  assert.equal(today.to, '2026-10-25T15:00:00.000Z');
  assert.deepEqual(today.bookings.map((b) => b.id), [night.id, run.id, weed.id, loose.id, nowhere.id, read.id, dentist.id]);
  assert.deepEqual(L.schedule({ from: '2026-10-25' }), today);
  assert.deepEqual(L.schedule({ from: '2026-10-25', to: '2026-10-26' }), today);

  const byId = new Map(today.bookings.map((b) => [b.id, b]));
  // A task's goal's profile.
  assert.deepEqual(byId.get(read.id).task, { id: s.read.id, title: 'Read papers', state: 'ready' });
  assert.deepEqual(byId.get(read.id).goal, { id: s.research.id, title: 'Thesis' });
  assert.equal(byId.get(read.id).profile, 'research');
  // The goal has no profile: the task's place's.
  assert.equal(byId.get(weed.id).profile, 'hobby');
  assert.deepEqual(byId.get(weed.id).goal, { id: s.bare.id, title: 'No profile goal' });
  // No goal: the place's.
  assert.equal(byId.get(loose.id).goal, null);
  assert.equal(byId.get(loose.id).profile, 'club');
  // Neither: null.
  assert.equal(byId.get(nowhere.id).profile, null);
  // A habit: its goal's.
  assert.deepEqual(byId.get(run.id).habit, { id: s.run.id, title: 'Run' });
  assert.equal(byId.get(run.id).task, null);
  assert.equal(byId.get(run.id).profile, 'research');
  // Fixed: nothing around it.
  assert.deepEqual([byId.get(dentist.id).task, byId.get(dentist.id).goal, byId.get(dentist.id).profile], [null, null, null]);

  // A task's state shows as it is now.
  L.setState(s.read.id, 'done', { result: 'Read' }, ACTOR);
  assert.equal(L.schedule().bookings.find((b) => b.id === read.id).task.state, 'done');

  // Wider and narrower ranges, by date or by datetime.
  assert.deepEqual(L.schedule({ from: '2026-10-24', to: '2026-10-27' }).bookings.map((b) => b.id), [
    yesterday.id, night.id, run.id, weed.id, loose.id, nowhere.id, read.id, dentist.id, tomorrow.id,
  ]);
  assert.deepEqual(L.schedule({ from: '2026-10-25T11:30:00+09:00', to: '2026-10-25T03:30:00Z' }).bookings.map((b) => b.id), [loose.id, nowhere.id]);
  // A datetime from with no to covers one day from it.
  const fromNoon = L.schedule({ from: '2026-10-25T12:00:00+09:00' });
  assert.equal(fromNoon.to, '2026-10-26T03:00:00.000Z');
  assert.deepEqual(fromNoon.bookings.map((b) => b.id), [nowhere.id, read.id, dentist.id, tomorrow.id]);

  assert.throws(() => L.schedule({ from: '2026-10-26', to: '2026-10-25' }), /to は from より後に/);
  assert.throws(() => L.schedule({ from: '2026-10-25', to: '2026-10-25' }), /to は from より後に/);
  assert.throws(() => L.schedule({ from: 'tomorrow', to: '2026-02-30' }), (e) => e.problems.length === 2 && /from は YYYY-MM-DD/.test(e.problems[0]));
});

test('import: bookings whose task did not come back are deleted and counted; others stay', (t) => {
  const { L, count, raw } = fresh(t);
  const T1 = 't_20261002090000_keep01';
  const T2 = 't_20261002090000_gone01';
  const doc = (tasks) => ({ format: 'warifuri-snapshot', version: 1, source: 'tracker', places: [], goals: [], blocks: [], tasks });
  const both = [
    { id: T1, title: 'Keep', mode: 'ai_worker', state: 'ready' },
    { id: T2, title: 'Gone', mode: 'ai_worker', state: 'ready' },
  ];
  assert.equal(L.replaceFromSnapshot(doc(both), ACTOR).dropped_bookings, 0);
  const habit = L.createHabit({ title: 'Stretch', rule: 'daily', duration_min: 10 }, ACTOR);
  const span = { starts_at: '2026-10-25T10:00:00+09:00', ends_at: '2026-10-25T11:00:00+09:00' };
  const keep = L.book({ kind: 'task', task_id: T1, ...span }, ACTOR).booking;
  const gone = L.book({ kind: 'task', task_id: T2, ...span }, ACTOR).booking;
  const gone2 = L.book({ kind: 'task', task_id: T2, ...span, note: 'second' }, ACTOR).booking;
  const h = L.book({ kind: 'habit', habit_id: habit.id, ...span }, ACTOR).booking;
  const f = L.book({ kind: 'fixed', title: 'Dentist', ...span }, ACTOR).booking;

  const res = L.replaceFromSnapshot(doc([both[0]]), ACTOR);
  assert.equal(res.dropped_bookings, 2);
  assert.deepEqual(
    raw.prepare('SELECT id FROM bookings ORDER BY id').all().map((r) => r.id),
    [keep.id, h.id, f.id].sort(),
  );
  const rec = raw.prepare("SELECT changes FROM records WHERE entity = 'import' ORDER BY id DESC LIMIT 1").get();
  const dropped = JSON.parse(rec.changes).dropped_bookings;
  assert.deepEqual(dropped.map((b) => b.id).sort(), [gone.id, gone2.id].sort());
  assert.equal(dropped.find((b) => b.id === gone2.id).note, 'second');
  assert.equal(count('bookings'), 3);
  // Importing again with the task back changes nothing.
  assert.equal(L.replaceFromSnapshot(doc([both[0]]), ACTOR).dropped_bookings, 0);
  assert.equal(JSON.parse(raw.prepare("SELECT changes FROM records WHERE entity = 'import' ORDER BY id DESC LIMIT 1").get().changes).dropped_bookings, undefined);
});

test('markSeen writes last_seen_at at most once a minute per device, with no record', (t) => {
  const { L, clock, raw } = fresh(t);
  L.issueKey('laptop', ACTOR);
  L.issueKey('desk', ACTOR);
  const seen = (name) => L.listDevices().find((d) => d.name === name).last_seen_at;
  const records = () => raw.prepare("SELECT count(*) AS n FROM records WHERE entity = 'device'").get().n;
  const r0 = records();
  assert.equal(seen('laptop'), null);
  assert.equal(L.markSeen('laptop'), true);
  const first = seen('laptop');
  assert.equal(first, '2026-10-25T03:00:00.000Z');
  clock.advance(59_000);
  assert.equal(L.markSeen('laptop'), false);
  assert.equal(seen('laptop'), first);
  assert.equal(L.markSeen('desk'), true); // per device
  clock.advance(1_000);
  assert.equal(L.markSeen('laptop'), true);
  assert.equal(seen('laptop'), '2026-10-25T03:01:00.000Z');
  assert.equal(L.markSeen('nobody'), false);
  assert.equal(records(), r0);
});

test('a second connection to the same file also keeps to once a minute', (t) => {
  const { L, clock, file } = fresh(t);
  L.issueKey('laptop', ACTOR);
  L.markSeen('laptop');
  const other = openLedger(file, { now: clock.now });
  t.after(() => other.close());
  clock.advance(30_000);
  assert.equal(other.markSeen('laptop'), false); // the stored time is less than a minute old
  clock.advance(30_000);
  assert.equal(other.markSeen('laptop'), true);
});

async function serve(t) {
  const clock = handClock();
  const ledger = openLedger(':memory:', { now: clock.now });
  const s = seed(ledger);
  const key = ledger.issueKey('laptop', ACTOR).key;
  const server = createServer({ ledger });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const clients = [];
  t.after(async () => {
    for (const c of clients) await c.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    ledger.close();
  });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  clients.push(client);
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    return { res, data: res.isError ? null : JSON.parse(res.content[0].text), text: res.content[0].text };
  };
  return { ledger, clock, s, key, base, call };
}

test('MCP: book, schedule and unbook write as the calling device, and refusals come back in Japanese', async (t) => {
  const { ledger, s, call } = await serve(t);
  const span = { starts_at: '2026-10-25T10:00:00+09:00', ends_at: '2026-10-25T11:00:00+09:00' };
  const made = await call('book', { kind: 'task', task_id: s.read.id, ...span });
  assert.equal(made.data.booking.title, 'Read papers');
  assert.deepEqual(made.data.overlaps, []);
  const second = await call('book', { kind: 'fixed', title: 'Call', starts_at: '2026-10-25T10:30:00+09:00', ends_at: '2026-10-25T11:30:00+09:00' });
  assert.deepEqual(second.data.overlaps.map((b) => b.id), [made.data.booking.id]);
  assert.deepEqual(ledger.records(made.data.booking.id).map((r) => [r.action, r.actor, r.device]), [['create', 'device-key', 'laptop']]);

  const bad = await call('book', { kind: 'fixed', starts_at: '2026-10-25' });
  assert.equal(bad.res.isError, true);
  assert.match(bad.text, /^書けませんでした。/);
  assert.match(bad.text, /固定の予定には題名/);
  assert.match(bad.text, /終わり\(ends_at\)が要ります/);

  const day = await call('schedule', { from: '2026-10-25' });
  assert.deepEqual(day.data.bookings.map((b) => b.title), ['Read papers', 'Call']);
  assert.equal(day.data.bookings[0].profile, 'research');
  assert.deepEqual((await call('schedule')).data, day.data);
  const wrong = await call('schedule', { from: 'soon' });
  assert.equal(wrong.res.isError, true);
  assert.match(wrong.text, /from は YYYY-MM-DD/);

  const removed = await call('unbook', { id: second.data.booking.id });
  assert.equal(removed.data.title, 'Call');
  assert.deepEqual(ledger.records(second.data.booking.id).map((r) => [r.action, r.device]), [['create', 'laptop'], ['delete', 'laptop']]);
  assert.match((await call('unbook', { id: second.data.booking.id })).text, /という予定はありません/);

  // An imported event twice is one booking; external_id alone is refused in Japanese.
  const event = { kind: 'fixed', title: 'Dentist', source: 'google-calendar', external_id: 'ev1', ...span };
  const imported = await call('book', event);
  assert.equal((await call('book', { ...event, title: 'Dentist (moved)' })).data.booking.id, imported.data.booking.id);
  const listed = (await call('schedule', { from: '2026-10-25' })).data.bookings.find((b) => b.id === imported.data.booking.id);
  assert.deepEqual([listed.title, listed.source, listed.external_id], ['Dentist (moved)', 'google-calendar', 'ev1']);
  const lone = await call('book', { kind: 'fixed', title: 'x', external_id: 'ev2', ...span });
  assert.equal(lone.res.isError, true);
  assert.match(lone.text, /出どころ\(source\)も要ります/);
  // With id, the pair is attached to the booking it names, unless another has it.
  const attached = await call('book', { id: made.data.booking.id, source: 'google-calendar', external_id: 'ev3' });
  assert.equal(attached.data.booking.external_id, 'ev3');
  const taken = await call('book', { id: made.data.booking.id, source: 'google-calendar', external_id: 'ev1' });
  assert.equal(taken.res.isError, true);
  assert.match(taken.text, /もう予定 .* に付いています/);
});

test('a device key on /mcp and /api marks the device as seen, once a minute', async (t) => {
  const { ledger, clock, key, base, call } = await serve(t);
  const seen = () => ledger.listDevices().find((d) => d.name === 'laptop').last_seen_at;
  // Connecting already called /mcp.
  assert.equal(seen(), '2026-10-25T03:00:00.000Z');
  clock.advance(30_000);
  await call('schedule');
  assert.equal(seen(), '2026-10-25T03:00:00.000Z');
  clock.advance(30_000);
  const res = await fetch(`${base}/api/held?dir=/tmp`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(res.status, 200);
  assert.equal(seen(), '2026-10-25T03:01:00.000Z');
  // A bad key marks nothing.
  clock.advance(120_000);
  assert.equal((await fetch(`${base}/api/held?dir=/tmp`, { headers: { Authorization: 'Bearer wf_wrong' } })).status, 401);
  assert.equal(seen(), '2026-10-25T03:01:00.000Z');
});
