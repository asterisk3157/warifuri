// The timetable: a draft of the blocks of work for the person's tasks in a period, for the
// secretary to check and book (原則12, 14). The code drafts and the secretary decides, so the
// same ledger always gives the same draft. planTimetable() is a pure function: no I/O, no
// clock. timetableFor() reads the ledger and calls it; the timetable tool is that call. It
// books nothing.
//
// - The tasks drafted are the open tasks that take the person's time (human, human_with_ai),
//   ready or running, not handed over (delegated), with every task before them closed, and with
//   minutes left: the estimate minus the minutes of the task's bookings that end after now.
//   Tasks with no estimate are not drafted; they come back in left.
// - They go in the order the person gave (priority: 1 first; tasks with none after those with
//   one), then the nearer due date (the task's or its goal's), then as board lists them.
// - Where the person is (whereabouts.mjs): a task with only_at 'home' goes only in free time at
//   home. The rest goes anywhere.
// - The free time is free_time's, before the daily cap; the cap is kept here, with the hours
//   free_time leaves for the day. Habits to place come first, as free_time places them.
// - The free time is cut at the bands of the week type. A band with a profile takes only that
//   profile's tasks (the lab in the afternoon: research), and is filled first; the rest of the
//   day takes any task.
// - A block is at least block_min_minutes and at most block_max_minutes long, and as long as
//   the minutes left when that falls in between. A task gets one block a day, and none on a day
//   that already has a booking of it, so the work is spread and the day is not filled for the
//   sake of it (原則12).

import { freeTime, whereaboutsFor } from './freetime.mjs';
import { HUMAN_TIME_MODES } from './rules.mjs';
import { readSettings, weekBands } from './settings.mjs';
import { LedgerError } from './ledger.mjs';

// The longest period drafted at once, in days.
export const TIMETABLE_MAX_DAYS = 7;
// How far ahead the bookings of a task are counted against its estimate, in days.
const AHEAD_DAYS = 366;

const MIN = 60_000;
const ms = (v) => new Date(v).getTime();
const iso = (n) => new Date(n).toISOString();

// The pieces of [s, e) cut at the bands: [{ s, e, profile }] by start. profile: the band's
// profile, or null outside every band with a profile.
function cutAtBands(s, e, bands, home = true) {
  const edges = new Set([s, e]);
  for (const b of bands) {
    if (b.e > s && b.s < e) {
      edges.add(Math.max(b.s, s));
      edges.add(Math.min(b.e, e));
    }
  }
  const points = [...edges].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const ps = points[i];
    const pe = points[i + 1];
    const band = bands.find((b) => b.s <= ps && b.e >= pe);
    out.push({ s: ps, e: pe, profile: band?.profile ?? null, home });
  }
  return out;
}

// days: [{ date, budget_min, free: [{ starts_at, ends_at, home? }], habits_to_place, booked_task_ids }],
// one per local day; free is the free time before the daily cap (home false: not at home),
// budget_min the minutes the cap leaves. bands: [{ starts_at, ends_at, profile }]. tasks:
// [{ task_id, title, goal, profile, due, human_led, remaining_min, only_at? }] in the order to place them. limits: block_min_minutes and
// block_max_minutes. Returns { blocks, left }: blocks by start (habits too), and left, the tasks
// that got no block, with left_min.
export function planTimetable({ days, bands = [], tasks, limits }) {
  const minLen = limits.block_min_minutes;
  const maxLen = limits.block_max_minutes;
  const withProfile = bands.filter((b) => b.profile).map((b) => ({ s: ms(b.starts_at), e: ms(b.ends_at), profile: b.profile }));
  const left = new Map(tasks.map((t) => [t.task_id, t.remaining_min]));
  const placed = new Set();
  const blocks = [];
  for (const day of days) {
    for (const h of day.habits_to_place ?? []) {
      if (!h.starts_at) continue;
      blocks.push({
        kind: 'habit', habit_id: h.habit_id, title: h.title, starts_at: h.starts_at, ends_at: h.ends_at, minutes: h.duration_min,
      });
    }
    const used = new Set(day.booked_task_ids ?? []);
    let budget = day.budget_min;
    const pieces = day.free.flatMap((f) => cutAtBands(ms(f.starts_at), ms(f.ends_at), withProfile, f.home !== false));
    // The bands with a profile first: they are where that work goes.
    pieces.sort((a, b) => Number(b.profile !== null) - Number(a.profile !== null) || a.s - b.s);
    for (const piece of pieces) {
      let at = piece.s;
      while ((piece.e - at) / MIN >= minLen && budget >= minLen) {
        const t = tasks.find((x) => left.get(x.task_id) > 0 && !used.has(x.task_id) && (piece.profile === null || x.profile === piece.profile)
          && (x.only_at !== 'home' || piece.home));
        if (!t) break;
        const minutes = Math.min(Math.max(left.get(t.task_id), minLen), maxLen, (piece.e - at) / MIN, budget);
        if (minutes < minLen) break;
        blocks.push({
          kind: 'task', task_id: t.task_id, title: t.title, goal: t.goal, profile: t.profile, due: t.due, human_led: t.human_led,
          starts_at: iso(at), ends_at: iso(at + minutes * MIN), minutes,
        });
        left.set(t.task_id, Math.max(0, left.get(t.task_id) - minutes));
        used.add(t.task_id);
        placed.add(t.task_id);
        at += minutes * MIN;
        budget -= minutes;
      }
    }
  }
  blocks.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  return {
    blocks,
    left: tasks.filter((t) => !placed.has(t.task_id)).map((t) => ({
      task_id: t.task_id, title: t.title, left_min: t.remaining_min, reason: t.only_at === 'home' ? '家にいる空きに入らなかった' : '空きに入らなかった',
    })),
  };
}

const dueMs = (due) => (due ? ms(due) : Infinity);
const rank = (priority) => priority ?? Infinity;

// The draft on the ledger for [from, to): from defaults to tomorrow (local midnight), to to one
// day after from, read as schedule() reads them; at most TIMETABLE_MAX_DAYS days. Returns
// { from, to, limits, blocks, left, habits_left }: blocks as planTimetable gives them; left the
// drafted tasks that got no block, then the tasks with no estimate; habits_left the habits of
// those days that fit nowhere.
export function timetableFor(ledger, { from, to } = {}) {
  const now = ledger.now();
  if (from === undefined) {
    const d = new Date(now);
    from = iso(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime());
  }
  const period = ledger.schedule({ from, to });
  const fromMs = ms(period.from);
  const toMs = ms(period.to);
  const limit = new Date(fromMs);
  limit.setDate(limit.getDate() + TIMETABLE_MAX_DAYS);
  if (toMs > limit.getTime()) {
    throw new LedgerError([`時間割の案を一度に作れるのは ${TIMETABLE_MAX_DAYS} 日までです。期間を分けて聞いてください`]);
  }
  const settings = readSettings(ledger);
  const { limits } = settings;

  // The minutes already booked for each task, from now on.
  const ahead = new Date(now);
  ahead.setDate(ahead.getDate() + AHEAD_DAYS);
  const bookedMin = new Map();
  for (const b of ledger.schedule({ from: iso(now.getTime()), to: iso(Math.max(ahead.getTime(), toMs)) }).bookings) {
    if (b.kind !== 'task' || !b.task_id) continue;
    bookedMin.set(b.task_id, (bookedMin.get(b.task_id) ?? 0) + (ms(b.ends_at) - Math.max(ms(b.starts_at), now.getTime())) / MIN);
  }

  // The tasks to draft, in board's order, then by the nearer due date.
  const board = ledger.board();
  const rows = [
    ...board.goals.flatMap((g) => g.tasks.map((t) => ({ t, g }))),
    ...board.unassigned.map((t) => ({ t, g: null })),
  ];
  const drafted = [];
  const noEstimate = [];
  rows.forEach(({ t, g }, i) => {
    if (!HUMAN_TIME_MODES.includes(t.mode) || !['ready', 'running'].includes(t.state) || t.delegated) return;
    if (ledger.openBefore(t.id).length > 0) return;
    if (!t.estimate_min) {
      noEstimate.push({ task_id: t.id, title: t.title, left_min: null, reason: '見積りがない' });
      return;
    }
    const remaining = Math.round(t.estimate_min - (bookedMin.get(t.id) ?? 0));
    if (remaining <= 0) return;
    const due = [t.due, g?.due].filter(Boolean).sort((a, b) => dueMs(a) - dueMs(b))[0] ?? null;
    drafted.push({
      task_id: t.id, title: t.title, goal: g ? { id: g.id, title: g.title } : null, profile: t.profile ?? null,
      due, human_led: Boolean(g?.human_led), remaining_min: remaining, order: i,
      only_at: t.only_at ?? null, priority: t.priority ?? null,
    });
  });
  drafted.sort((a, b) => rank(a.priority) - rank(b.priority) || dueMs(a.due) - dueMs(b.due) || a.order - b.order);
  const tasks = drafted.map(({ order, ...t }) => t);

  // Free time before the cap, and the cap's minutes from free_time itself. The bookings of the
  // whole local days count, as free_time counts the cap on whole days.
  const first = new Date(fromMs);
  const last = new Date(toMs - 1);
  const wholeFrom = new Date(first.getFullYear(), first.getMonth(), first.getDate()).getTime();
  const wholeTo = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1).getTime();
  const bookings = ledger.schedule({ from: iso(wholeFrom), to: iso(wholeTo) }).bookings;
  const habits = ledger.listHabits().filter((h) => typeof h.rule === 'object');
  const capped = freeTime({ from: fromMs, to: toMs, limits, bookings, habits });
  const where = whereaboutsFor(ledger, wholeFrom, wholeTo, { settings, bookings });
  const open = freeTime({ from: fromMs, to: toMs, limits: { ...limits, day_max_hours: 24 }, bookings, habits, where });
  const perDay = capped.days.map((d, i) => {
    const [y, m, dd] = d.date.split('-').map(Number);
    const dayStart = new Date(y, m - 1, dd).getTime();
    const dayEnd = new Date(y, m - 1, dd + 1).getTime();
    return {
      date: d.date,
      budget_min: Math.round(d.remaining_hours * 60),
      free: open.days[i].free,
      habits_to_place: d.habits_to_place,
      booked_task_ids: bookings.filter((b) => b.task_id && ms(b.starts_at) < dayEnd && ms(b.ends_at) > dayStart).map((b) => b.task_id),
    };
  });
  const plan = planTimetable({ days: perDay, bands: weekBands(settings.week.slots, fromMs, toMs), tasks, limits });
  const habitsLeft = capped.days.flatMap((d) => d.habits_to_place.filter((h) => !h.starts_at).map((h) => ({ habit_id: h.habit_id, title: h.title, date: d.date })));
  // A task left with a due date before the end of the period cannot make it in this plan:
  // the one case to ask the person about (what to move, or whether the date can change).
  const byId = new Map(tasks.map((t) => [t.task_id, t]));
  const left = plan.left.map((l) => {
    const due = byId.get(l.task_id)?.due ?? null;
    return due && dueMs(due) <= toMs ? { ...l, due, misses_due: true } : l;
  });
  return { from: period.from, to: period.to, limits: { ...limits }, blocks: plan.blocks, left: [...left, ...noEstimate], habits_left: habitsLeft };
}
