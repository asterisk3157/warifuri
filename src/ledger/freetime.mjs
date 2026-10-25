// The person's free time in a period, where a task can be placed, inside their limits
// (原則14). freeTime() is a pure function: no I/O, no clock. freeTimeFor() reads the ledger
// and calls it; the free_time tool is that call.
//
// For each local day (the server's clock, as in schedule()) that shares time with [from, to):
// - The placeable window is [earliest, latest) of that day, cut to [from, to).
// - Every booking, of any kind, is busy.
// - Habit occurrences of that day with no booking of the habit in their window are placed
//   first, each at the earliest spot inside its window where its duration fits without
//   touching busy time (a habit with no window goes inside [earliest, latest)). They become
//   busy, and are returned so the caller can book them; one that fits nowhere has starts_at null.
// - The daily cap counts the time of task and habit bookings, and of the habits just placed,
//   that falls inside [earliest, latest) of the day, whole day, not cut to [from, to). Fixed
//   bookings are busy but not counted, and neither is time outside the window (sleep, an early run).
// - The rest of the window is cut into free slots, and slots shorter than block_min_minutes
//   are dropped. Slots longer than block_max_minutes are kept whole; the scheduler cuts them.
// - The slots are offered from the earliest until they add up to the hours left under
//   day_max_hours: the slot that crosses the limit is shortened, and dropped when that leaves
//   it shorter than block_min_minutes. So a day never offers more than it has left.

import { LedgerError } from './ledger.mjs';
import { habitOccurrences } from './habits.mjs';
import { readSettings } from './settings.mjs';

// The longest period asked at once, in days.
export const FREE_TIME_MAX_DAYS = 31;

const MIN = 60_000;
const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (s) => s.split(':').map(Number);
const hours = (minutes) => Math.round((minutes / 60) * 100) / 100;
const iso = (ms) => new Date(ms).toISOString();
const ms = (v) => new Date(v).getTime();

// The local midnights of the days sharing time with [fromMs, toMs): [{ date, start, end }].
function localDays(fromMs, toMs) {
  const out = [];
  const f = new Date(fromMs);
  const day = new Date(f.getFullYear(), f.getMonth(), f.getDate());
  while (day.getTime() < toMs) {
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    out.push({ date: localDate(day), y: day.getFullYear(), m: day.getMonth(), d: day.getDate(), start: day.getTime(), end: next.getTime() });
    day.setDate(day.getDate() + 1);
  }
  return out;
}

// 1 for an occurrence of a habit with no window (its window is the whole local day), else 0.
// A rule's window cannot be a whole day, as its start and end differ.
function wholeDay(o) {
  const s = new Date(o.window_start);
  const next = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1);
  return s.getHours() === 0 && s.getMinutes() === 0 && ms(o.window_end) === next.getTime() ? 1 : 0;
}

// The minutes of [s, e) that fall inside [ws, we).
const overlapMin = (s, e, ws, we) => Math.max(0, Math.min(e, we) - Math.max(s, ws)) / MIN;

// The gaps of [s, e) not covered by busy ([[start, end]], any order).
function gaps(s, e, busy) {
  const out = [];
  let at = s;
  for (const [bs, be] of [...busy].sort((a, b) => a[0] - b[0])) {
    if (be <= at || bs >= e) continue;
    if (bs > at) out.push([at, bs]);
    at = Math.max(at, be);
    if (at >= e) break;
  }
  if (at < e) out.push([at, e]);
  return out;
}

// Free time in [from, to) (Dates, ms or ISO). limits: as readSettings gives them. bookings:
// [{ kind, habit_id, starts_at, ends_at }] covering at least the whole local days of the
// period (for the daily cap). habits: habit rows or views; stopped ones are skipped.
export function freeTime({ from, to, limits, bookings = [], habits = [] }) {
  const fromMs = ms(from);
  const toMs = ms(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) throw new TypeError('from と to は日時です');
  const span = bookings.map((b) => ({ ...b, s: ms(b.starts_at), e: ms(b.ends_at) }));
  const [eh, em] = hhmm(limits.earliest);
  const [lh, lm] = hhmm(limits.latest);
  const occurrences = habits.flatMap((h) => habitOccurrences(h, { from: fromMs, to: toMs }));
  // Habits with a window go first, as they have less room; then by window and id.
  occurrences.sort(
    (a, b) => wholeDay(a) - wholeDay(b) || a.window_start.localeCompare(b.window_start) || String(a.habit_id).localeCompare(String(b.habit_id)),
  );

  const placed = []; // habits placed on earlier days, which may run past midnight
  const days = localDays(fromMs, toMs).map((day) => {
    const ws = new Date(day.y, day.m, day.d, eh, em).getTime();
    const we = new Date(day.y, day.m, day.d, lh, lm).getTime();
    const busy = [...span.map((b) => [b.s, b.e]), ...placed];
    let counted = span
      .filter((b) => b.kind === 'task' || b.kind === 'habit')
      .reduce((sum, b) => sum + overlapMin(b.s, b.e, ws, we), 0);
    const bookedMin = counted;

    const habitsToPlace = [];
    for (const o of occurrences.filter((x) => x.date === day.date)) {
      const os = ms(o.window_start);
      const oe = ms(o.window_end);
      const booked = span.some((b) => b.kind === 'habit' && b.habit_id === o.habit_id && b.s < oe && b.e > os);
      if (booked) continue;
      const whole = wholeDay(o);
      const rs = Math.max(whole ? ws : os, fromMs);
      const re = Math.min(whole ? we : oe, toMs);
      const need = o.duration_min * MIN;
      const spot = re > rs ? gaps(rs, re, busy).find(([s, e]) => e - s >= need) : undefined;
      const place = { habit_id: o.habit_id, title: o.title, duration_min: o.duration_min, window_start: o.window_start, window_end: o.window_end };
      if (!spot) {
        habitsToPlace.push({ ...place, starts_at: null, ends_at: null });
        continue;
      }
      const [s] = spot;
      busy.push([s, s + need]);
      placed.push([s, s + need]);
      counted += overlapMin(s, s + need, ws, we);
      habitsToPlace.push({ ...place, starts_at: iso(s), ends_at: iso(s + need) });
    }

    const remainingMin = Math.max(0, limits.day_max_hours * 60 - counted);
    const free = [];
    let left = remainingMin;
    const s0 = Math.max(ws, fromMs);
    const e0 = Math.min(we, toMs);
    if (e0 > s0) {
      for (const [s, e] of gaps(s0, e0, busy)) {
        if (left < limits.block_min_minutes) break;
        if ((e - s) / MIN < limits.block_min_minutes) continue;
        const minutes = Math.min((e - s) / MIN, left);
        free.push({ starts_at: iso(s), ends_at: iso(s + minutes * MIN), minutes });
        left -= minutes;
      }
    }
    return {
      date: day.date,
      booked_hours: hours(bookedMin),
      remaining_hours: hours(remainingMin),
      habits_to_place: habitsToPlace,
      free,
    };
  });
  return { from: iso(fromMs), to: iso(toMs), limits: { ...limits }, days };
}

// free_time on the ledger: from and to as schedule() reads them (YYYY-MM-DD is local
// midnight; from defaults to today, to to one day after from), at most FREE_TIME_MAX_DAYS.
export function freeTimeFor(ledger, { from, to } = {}) {
  const period = ledger.schedule({ from, to });
  const fromMs = ms(period.from);
  const toMs = ms(period.to);
  const limit = new Date(fromMs);
  limit.setDate(limit.getDate() + FREE_TIME_MAX_DAYS);
  if (toMs > limit.getTime()) {
    throw new LedgerError([`空き時間を一度に探せるのは ${FREE_TIME_MAX_DAYS} 日までです。期間を分けて聞いてください`]);
  }
  const placed = []; // habits placed on earlier days, which may run past midnight
  const days = localDays(fromMs, toMs);
  const whole = ledger.schedule({ from: iso(days[0].start), to: iso(days.at(-1).end) });
  // A rule that cannot be read (a row imported for review) is skipped and named.
  const habits = ledger.listHabits();
  const readable = habits.filter((h) => typeof h.rule === 'object');
  const out = freeTime({ from: fromMs, to: toMs, limits: readSettings(ledger).limits, bookings: whole.bookings, habits: readable });
  const skipped = habits.filter((h) => !readable.includes(h)).map((h) => h.id);
  return skipped.length ? { ...out, skipped_habits: skipped } : out;
}
