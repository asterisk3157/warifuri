// Tests for free time (src/ledger/freetime.mjs) and the free_time tool: the placeable window,
// bookings as busy time, habits placed first, the daily cap, short slots, a day boundary on
// the local clock, and the period's limit. The server's local time is pinned to Asia/Tokyo.

process.env.TZ = 'Asia/Tokyo';

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { freeTime } from '../src/ledger/freetime.mjs';
import { LIMIT_DEFAULTS } from '../src/ledger/settings.mjs';
import { openLedger } from '../src/ledger/ledger.mjs';
import { createServer } from '../src/server/mcp.mjs';

const at = (hm, date = '2026-11-02') => `${date}T${hm}:00+09:00`;
const utc = (hm, date = '2026-11-02') => new Date(at(hm, date)).toISOString();
const booking = (kind, s, e, extra = {}) => ({ kind, starts_at: at(s), ends_at: at(e), habit_id: null, ...extra });
const habit = (id, rule, duration, extra = {}) => ({ id, title: id, rule, duration_min: duration, active: true, ...extra });
// One day, 2026-11-02 (a Monday), with the default limits unless given.
const day = ({ bookings = [], habits = [], limits = {} } = {}) =>
  freeTime({ from: at('00:00'), to: at('00:00', '2026-11-03'), limits: { ...LIMIT_DEFAULTS, ...limits }, bookings, habits }).days;
const slots = (d) => d.free.map((f) => [f.starts_at, f.ends_at, f.minutes]);

test('an empty day: earliest to latest, cut at day_max_hours from the earliest', () => {
  const out = freeTime({ from: at('00:00'), to: at('00:00', '2026-11-03'), limits: LIMIT_DEFAULTS });
  assert.equal(out.from, utc('00:00'));
  assert.deepEqual(out.limits, { ...LIMIT_DEFAULTS });
  assert.equal(out.days.length, 1);
  const [d] = out.days;
  assert.equal(d.date, '2026-11-02');
  assert.equal(d.booked_hours, 0);
  assert.equal(d.remaining_hours, 8);
  assert.deepEqual(d.habits_to_place, []);
  assert.deepEqual(slots(d), [[utc('09:00'), utc('17:00'), 480]]);
});

test('a fixed booking is busy but not counted; a slot longer than block_max_minutes is kept whole', () => {
  const [d] = day({ bookings: [booking('fixed', '12:00', '13:00')] });
  assert.equal(d.booked_hours, 0);
  assert.equal(d.remaining_hours, 8);
  assert.deepEqual(slots(d), [[utc('09:00'), utc('12:00'), 180], [utc('13:00'), utc('18:00'), 300]]);
});

test('task bookings count toward the cap, and gaps shorter than block_min_minutes are dropped', () => {
  const [d] = day({ bookings: [booking('task', '09:00', '15:00'), booking('fixed', '15:20', '16:00')] });
  assert.equal(d.booked_hours, 6);
  assert.equal(d.remaining_hours, 2);
  assert.deepEqual(slots(d), [[utc('16:00'), utc('18:00'), 120]]);
});

test('the cap: nothing is offered once less than block_min_minutes is left', () => {
  const [d] = day({ bookings: [booking('task', '09:00', '16:45')] });
  assert.equal(d.remaining_hours, 0.25);
  assert.deepEqual(d.free, []);
  const [over] = day({ bookings: [booking('task', '09:00', '19:00')] });
  assert.equal(over.booked_hours, 10);
  assert.equal(over.remaining_hours, 0);
  assert.deepEqual(over.free, []);
  // Time outside earliest-latest is not counted.
  const [late] = day({ bookings: [booking('task', '06:00', '09:00'), booking('task', '21:00', '23:00')] });
  assert.equal(late.booked_hours, 0);
});

test('habits are placed first, at the earliest spot in their window, and kept out of free time', () => {
  const run = habit('h_run', { days: 'daily', window: '07:00-08:00' }, 30);
  const read = habit('h_read', { days: 'weekdays' }, 60); // no window: inside earliest-latest, after the others
  const lunch = habit('h_lunch', { days: 'daily', window: '12:00-13:00' }, 30);
  const [d] = day({ habits: [run, read, lunch], bookings: [booking('fixed', '12:00', '12:45')] });
  assert.deepEqual(
    d.habits_to_place.map((h) => [h.habit_id, h.starts_at, h.ends_at]),
    [['h_run', utc('07:00'), utc('07:30')], ['h_lunch', null, null], ['h_read', utc('09:00'), utc('10:00')]],
  );
  assert.equal(d.habits_to_place[2].window_start, utc('00:00'));
  // The run is outside earliest-latest, so only the reading counts.
  assert.equal(d.booked_hours, 0);
  assert.equal(d.remaining_hours, 7);
  assert.deepEqual(slots(d), [[utc('10:00'), utc('12:00'), 120], [utc('12:45'), utc('17:45'), 300]]);
});

test('a habit already booked in its window is not placed again, and is counted as booked', () => {
  const read = habit('h_read', { days: 'daily', window: '09:00-12:00' }, 60);
  const [d] = day({ habits: [read], bookings: [booking('habit', '10:00', '11:00', { habit_id: 'h_read' })] });
  assert.deepEqual(d.habits_to_place, []);
  assert.equal(d.booked_hours, 1);
  assert.deepEqual(slots(d), [[utc('09:00'), utc('10:00'), 60], [utc('11:00'), utc('17:00'), 360]]);
  // A stopped habit has nothing to place.
  assert.deepEqual(day({ habits: [{ ...read, active: false }] })[0].habits_to_place, []);
});

test('a day boundary on the local clock: days are local dates, cut to [from, to), counted whole', () => {
  // 20:00 on the 2nd to 10:00 on the 3rd in Tokyo is 11:00Z to 01:00Z: two local days.
  const out = freeTime({
    from: at('20:00'),
    to: at('10:00', '2026-11-03'),
    limits: LIMIT_DEFAULTS,
    bookings: [booking('task', '09:00', '16:30')], // before from, but on the same day
  });
  assert.deepEqual(out.days.map((d) => d.date), ['2026-11-02', '2026-11-03']);
  const [first, second] = out.days;
  assert.equal(first.booked_hours, 7.5);
  assert.deepEqual(slots(first), [[utc('20:00'), utc('20:30'), 30]]);
  assert.equal(second.booked_hours, 0);
  assert.deepEqual(slots(second), [[utc('09:00', '2026-11-03'), utc('10:00', '2026-11-03'), 60]]);
});

test('limits from settings: a later earliest and a smaller block_min_minutes', () => {
  const [d] = day({ limits: { earliest: '13:00', latest: '24:00', block_min_minutes: 15 }, bookings: [booking('fixed', '13:20', '23:40')] });
  assert.deepEqual(slots(d), [[utc('13:00'), utc('13:20'), 20], [utc('23:40'), utc('00:00', '2026-11-03'), 20]]);
});

async function serve(t) {
  const ledger = openLedger(':memory:', { now: () => new Date('2026-11-02T03:00:00Z') });
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

test('MCP: free_time reads the bookings, habits and limits, and refuses more than 31 days in Japanese', async (t) => {
  const { call } = await serve(t);
  const made = await call('habit', { title: 'Walk', rule: { days: 'daily', window: '09:00-10:00' }, duration_min: 30 });
  await call('book', { kind: 'fixed', title: 'Call', starts_at: at('09:00'), ends_at: at('09:30') });
  await call('settings', { limits: { day_max_hours: 2 }, by_person: true });

  const today = await call('free_time');
  assert.equal(today.data.from, utc('00:00'));
  assert.equal(today.data.limits.day_max_hours, 2);
  const [d] = today.data.days;
  assert.deepEqual(d.habits_to_place.map((h) => [h.habit_id, h.starts_at]), [[made.data.id, utc('09:30')]]);
  assert.equal(d.remaining_hours, 1.5);
  assert.deepEqual(slots(d), [[utc('10:00'), utc('11:30'), 90]]);

  assert.equal((await call('free_time', { from: '2026-11-01', to: '2026-12-02' })).data.days.length, 31);
  const long = await call('free_time', { from: '2026-11-01', to: '2026-12-03' });
  assert.equal(long.res.isError, true);
  assert.match(long.text, /31 日まで/);
  assert.match((await call('free_time', { from: 'soon' })).text, /from は YYYY-MM-DD/);
});
