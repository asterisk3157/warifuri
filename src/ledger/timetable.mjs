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
// - Weekdays are filled first. Saturday and Sunday take only what did not fit on the weekdays
//   of the period, under the same daily cap.
// - 移動 (planTravel): when bookings at different places follow one another in a day, the way
//   between them (places.travel, the shortest way through the times written) is put before
//   the booking it leads to, from home before the first and back home after the last. A way of
//   0 minutes (研究室 and 大学) puts nothing. The travel is busy time for the draft, and comes
//   back in travel to be booked (kind travel); a travel booking no longer needed is in unbook.
// - 組み直し (replan): the bookings warifuri made for tasks (kind task, from now on, inside the
//   period, not moved by the person in the calendar) may move. The person's own bookings
//   (fixed) never move. The older a booking, the more likely the person agreed to it, so the
//   oldest are kept first: each is kept while it still fits (its task open, no clash with
//   what stays, inside the hours of the day, at home for a task that needs home) and its task
//   still needs the minutes; the rest are let go and their tasks drafted again. When a task
//   would then miss its due date, the newest kept bookings are let go too, one at a time, as
//   long as that leaves fewer tasks missing it. A block that takes the place of a booking let
//   go of the same task carries its booking_id (move it); the bookings let go and not taken
//   are in unbook. changes lists each booking put, moved or taken away, before and after.

import { freeTime, whereaboutsFor } from './freetime.mjs';
import { homeNames, travelMinutes, awayParts } from './whereabouts.mjs';
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
  // Weekdays first; Saturday and Sunday take what the weekdays could not (the cap is the same).
  const weekend = (day) => {
    const [y, m, d] = day.date.split('-').map(Number);
    return [0, 6].includes(new Date(y, m - 1, d).getDay());
  };
  for (const day of [...days.filter((d) => !weekend(d)), ...days.filter(weekend)]) {
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
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;
const placeOf = (b) => {
  const p = typeof b.location === 'string' ? b.location.trim() : '';
  return p === '' || URL_LIKE.test(p) ? null : p;
};
const localDayOf = (n) => {
  const d = new Date(n);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

// 移動: the ways between places in [fromMs, toMs), by local day. bookings: [{ id, kind,
// starts_at, ends_at, location }] (travel bookings are skipped); places: places.places;
// travel: places.travel. A day starts and ends at home (the first place with home: true;
// with none, there is no way from or to home). Each booking with a place that differs from
// where the person was before it gets the way there right before it; after the last booking
// away from home, the way back. A way that would start before the booking before it ends is
// cut to start then (short: true). Returns [{ title, from, to, starts_at, ends_at, minutes,
// short? , before: booking id | null, after: booking id | null }] by start.
export function planTravel({ bookings, places = [], travel = [], fromMs, toMs }) {
  const home = [...homeNames(places)][0] ?? null;
  const items = bookings
    .filter((b) => b.kind !== 'travel' && placeOf(b) !== null)
    .map((b) => ({ id: b.id ?? null, s: ms(b.starts_at), e: ms(b.ends_at), place: placeOf(b) }))
    .filter((b) => b.s >= fromMs && b.s < toMs)
    .sort((a, b) => a.s - b.s || a.e - b.e);
  const out = [];
  const push = (from, to, s, e, minutes, extra) => {
    if (e > s) out.push({ title: '移動', from, to, starts_at: iso(s), ends_at: iso(e), minutes: Math.round((e - s) / MIN), ...(minutes * MIN > e - s ? { short: true } : {}), ...extra });
  };
  const days = [...new Set(items.map((x) => localDayOf(x.s)))];
  for (const day of days) {
    let prev = home;
    let prevEnd = day;
    let prevId = null;
    for (const x of items.filter((y) => localDayOf(y.s) === day)) {
      if (prev !== null && x.place !== prev) {
        const m = travelMinutes(prev, x.place, travel);
        if (m) push(prev, x.place, Math.max(x.s - m * MIN, prevEnd), x.s, m, { before: prevId, after: x.id });
      }
      prev = x.place;
      prevEnd = Math.max(prevEnd, x.e);
      prevId = x.id;
    }
    if (home !== null && prev !== null && prev !== home) {
      const m = travelMinutes(prev, home, travel);
      if (m) push(prev, home, prevEnd, prevEnd + m * MIN, m, { before: prevId, after: null });
    }
  }
  return out.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}

// A span as the person reads it: 11/16(月) 10:00〜11:00.
const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土'];
export function spanText(startsAt, endsAt) {
  const a = new Date(startsAt);
  const b = new Date(endsAt);
  const p = (n) => String(n).padStart(2, '0');
  const hm = (d) => `${p(d.getHours())}:${p(d.getMinutes())}`;
  const day = (d) => `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAY[d.getDay()]})`;
  return `${day(a)} ${hm(a)}〜${localDayOf(a.getTime()) === localDayOf(b.getTime()) ? hm(b) : `${day(b)} ${hm(b)}`}`;
}

// One line of changes: 題名: 前 → 後, or new, or taken away.
export function changeLine(c) {
  if (c.before && c.after) return `${c.title}: ${spanText(c.before.starts_at, c.before.ends_at)} → ${spanText(c.after.starts_at, c.after.ends_at)}`;
  if (c.after) return `${c.title}: ${spanText(c.after.starts_at, c.after.ends_at)} に入れる`;
  return `${c.title}: ${spanText(c.before.starts_at, c.before.ends_at)} を外す`;
}

// Pairs what goes away with what comes, in order of time: [[old | null, new | null]].
function pairUp(olds, news) {
  const a = [...olds].sort((x, y) => x.starts_at.localeCompare(y.starts_at));
  const b = [...news].sort((x, y) => x.starts_at.localeCompare(y.starts_at));
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) out.push([a[i] ?? null, b[i] ?? null]);
  return out;
}

// Whether the person moved a booking in their calendar: its time was last changed by the
// calendar watch (the person dragged the event warifuri wrote).
function movedByPerson(ledger, id) {
  const timed = ledger.records(id).filter((r) => r.action === 'update' && (r.changes.starts_at || r.changes.ends_at));
  return timed.at(-1)?.device === 'calendar-watch';
}

// The draft on the ledger for [from, to): from defaults to tomorrow (local midnight), to to one
// day after from, read as schedule() reads them; at most TIMETABLE_MAX_DAYS days. replan: let
// the task bookings warifuri made in the period move (see the top of this file). Returns
// { from, to, limits, blocks, travel, unbook, changes, left, habits_left }: blocks as
// planTimetable gives them (booking_id on one that moves a booking); travel the ways to book
// (booking_id on one that moves a travel booking); unbook the bookings to delete; changes
// [{ kind, booking_id, task_id?, title, before, after, line }]; left the drafted tasks that got
// no block, then the tasks with no estimate; habits_left the habits of those days that fit
// nowhere.
export function timetableFor(ledger, { from, to, replan = false } = {}) {
  const now = ledger.now();
  const nowMs = now.getTime();
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
  const ahead = new Date(now);
  ahead.setDate(ahead.getDate() + AHEAD_DAYS);
  const aheadBookings = ledger.schedule({ from: iso(nowMs), to: iso(Math.max(ahead.getTime(), toMs)) }).bookings;

  // The tasks to draft, in board's order, then by the nearer due date.
  const board = ledger.board();
  const rows = [
    ...board.goals.flatMap((g) => g.tasks.map((t) => ({ t, g }))),
    ...board.unassigned.map((t) => ({ t, g: null })),
  ];
  const draftable = [];
  const noEstimate = [];
  rows.forEach(({ t, g }, i) => {
    if (!HUMAN_TIME_MODES.includes(t.mode) || !['ready', 'running'].includes(t.state) || t.delegated) return;
    if (ledger.openBefore(t.id).length > 0) return;
    if (!t.estimate_min) {
      noEstimate.push({ task_id: t.id, title: t.title, left_min: null, reason: '見積りがない' });
      return;
    }
    const due = [t.due, g?.due].filter(Boolean).sort((a, b) => dueMs(a) - dueMs(b))[0] ?? null;
    draftable.push({
      task_id: t.id, title: t.title, goal: g ? { id: g.id, title: g.title } : null, profile: t.profile ?? null,
      due, human_led: Boolean(g?.human_led), estimate_min: t.estimate_min, order: i,
      only_at: t.only_at ?? null, priority: t.priority ?? null,
    });
  });
  draftable.sort((a, b) => rank(a.priority) - rank(b.priority) || dueMs(a.due) - dueMs(b.due) || a.order - b.order);

  // The bookings of the whole local days, as free_time counts the cap on whole days.
  const first = new Date(fromMs);
  const last = new Date(toMs - 1);
  const wholeFrom = new Date(first.getFullYear(), first.getMonth(), first.getDate()).getTime();
  const wholeTo = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1).getTime();
  const whole = ledger.schedule({ from: iso(wholeFrom), to: iso(wholeTo) }).bookings;
  const habits = ledger.listHabits().filter((h) => typeof h.rule === 'object');
  const ours = (b) => ms(b.starts_at) >= Math.max(nowMs, fromMs) && ms(b.ends_at) <= toMs;
  // A way is the period's when it starts in it (the way back may end after the period).
  const oursByStart = (b) => ms(b.starts_at) >= Math.max(nowMs, fromMs) && ms(b.starts_at) < toMs;

  // 移動: the ways the bookings with a place call for, and the travel bookings already there.
  const wantTravel = planTravel({ bookings: whole, places: settings.places.places, travel: settings.places.travel, fromMs, toMs })
    .filter(oursByStart);
  const oldTravel = whole.filter((b) => b.kind === 'travel' && oursByStart(b));
  const sameSpan = (a, b) => ms(a.starts_at) === ms(b.starts_at) && ms(a.ends_at) === ms(b.ends_at);
  const travelKept = oldTravel.filter((b) => wantTravel.some((t) => sameSpan(t, b)));
  const travelNew = wantTravel.filter((t) => !travelKept.some((b) => sameSpan(t, b)));
  const travelGone = oldTravel.filter((b) => !travelKept.includes(b));
  const travelBusy = wantTravel.map((t) => ({ kind: 'travel', starts_at: t.starts_at, ends_at: t.ends_at }));
  const stays = whole.filter((b) => b.kind !== 'travel' || !oursByStart(b));

  // 組み直し: the task bookings that may move, the oldest first: of the tasks drafted, and of
  // tasks closed since (they go). A booking of a task not drafted for another reason (no
  // estimate, an earlier task still open) stays as it is.
  const byTask = new Map(draftable.map((t) => [t.task_id, t]));
  const closed = (b) => ['done', 'discarded'].includes(b.task?.state);
  const movable = replan
    ? stays.filter((b) => b.kind === 'task' && b.task_id && (byTask.has(b.task_id) || closed(b)) && ours(b) && !movedByPerson(ledger, b.id))
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    : [];
  const where = whereaboutsFor(ledger, wholeFrom, wholeTo, { settings, bookings: [...stays, ...travelBusy] });
  const [eh, em] = limits.earliest.split(':').map(Number);
  const [lh, lm] = limits.latest.split(':').map(Number);
  const inHours = (b) => {
    const d = new Date(ms(b.starts_at));
    const ws = new Date(d.getFullYear(), d.getMonth(), d.getDate(), eh, em).getTime();
    const we = new Date(d.getFullYear(), d.getMonth(), d.getDate(), lh, lm).getTime();
    return ms(b.starts_at) >= ws && ms(b.ends_at) <= we;
  };
  // The minutes of each task booked from now on, by the bookings that stay put.
  const minutesOf = (list) => {
    const out = new Map();
    for (const b of list) {
      if (b.kind !== 'task' || !b.task_id) continue;
      out.set(b.task_id, (out.get(b.task_id) ?? 0) + (ms(b.ends_at) - Math.max(ms(b.starts_at), nowMs)) / MIN);
    }
    return out;
  };
  const fixedAhead = aheadBookings.filter((b) => !movable.some((m) => m.id === b.id));
  const kept = [];
  if (replan) {
    const fixedMin = minutesOf(fixedAhead);
    const keptMin = new Map();
    const hard = stays.filter((b) => !movable.includes(b)).map((b) => [ms(b.starts_at), ms(b.ends_at)]);
    for (const [s, e] of travelBusy.map((t) => [ms(t.starts_at), ms(t.ends_at)])) hard.push([s, e]);
    for (const b of movable) {
      const t = byTask.get(b.task_id);
      const s = ms(b.starts_at);
      const e = ms(b.ends_at);
      const clash = [...hard, ...kept.map((k) => [ms(k.starts_at), ms(k.ends_at)])].some(([hs, he]) => hs < e && he > s);
      const needs = t ? t.estimate_min - (fixedMin.get(t.task_id) ?? 0) - (keptMin.get(t.task_id) ?? 0) : 0;
      const away = t?.only_at === 'home' && awayParts(s, e, where).length > 0;
      if (!t || clash || needs <= 0 || away || !inHours(b)) continue;
      kept.push(b);
      keptMin.set(t.task_id, (keptMin.get(t.task_id) ?? 0) + (e - s) / MIN);
    }
  }

  // One draft, with the bookings in `keep` staying and the other movable ones let go.
  const draft = (keep) => {
    const gone = movable.filter((b) => !keep.includes(b));
    const bookedMin = minutesOf(aheadBookings.filter((b) => !gone.some((g) => g.id === b.id)));
    const tasks = draftable
      .map(({ order, estimate_min, ...t }) => ({ ...t, remaining_min: Math.round(estimate_min - (bookedMin.get(t.task_id) ?? 0)) }))
      .filter((t) => t.remaining_min > 0);
    const bookings = [...stays.filter((b) => !gone.includes(b)), ...travelBusy];
    const capped = freeTime({ from: fromMs, to: toMs, limits, bookings, habits });
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
    // A task left with a due date before the end of the period cannot make it in this plan:
    // the one case to ask the person about (what to move, or whether the date can change).
    const byId = new Map(tasks.map((t) => [t.task_id, t]));
    const left = plan.left.map((l) => {
      const due = byId.get(l.task_id)?.due ?? null;
      return due && dueMs(due) <= toMs ? { ...l, due, misses_due: true } : l;
    });
    return { plan, left, gone, capped, misses: left.filter((l) => l.misses_due).length };
  };
  // When a task misses its due date, the newest kept bookings go first, one at a time.
  let best = draft(kept);
  for (let n = kept.length - 1; best.misses > 0 && n >= 0; n -= 1) {
    const next = draft(kept.slice(0, n));
    if (next.misses < best.misses) best = next;
  }
  const { plan, left, gone, capped } = best;

  // What changes: blocks that take the place of a booking let go, the bookings let go and not
  // taken, and the ways.
  const changes = [];
  const unbook = [];
  const blocks = [];
  const taskBlocks = plan.blocks.filter((b) => b.kind === 'task');
  const used = new Set();
  for (const id of [...new Set([...gone.map((g) => g.task_id), ...taskBlocks.map((b) => b.task_id)])]) {
    for (const [old, block] of pairUp(gone.filter((g) => g.task_id === id), taskBlocks.filter((b) => b.task_id === id))) {
      const title = block?.title ?? old.title;
      if (old && block && sameSpan(old, block)) {
        used.add(block);
        continue;
      }
      const c = {
        kind: 'task', booking_id: old?.id ?? null, task_id: id, title,
        before: old ? { starts_at: old.starts_at, ends_at: old.ends_at } : null,
        after: block ? { starts_at: block.starts_at, ends_at: block.ends_at } : null,
      };
      changes.push({ ...c, line: changeLine(c) });
      if (block && old) block.booking_id = old.id;
      if (!block) unbook.push({ booking_id: old.id, kind: 'task', title: old.title, starts_at: old.starts_at, ends_at: old.ends_at });
    }
  }
  for (const b of plan.blocks) if (!used.has(b)) blocks.push(b);
  const travel = [];
  for (const [old, t] of pairUp(travelGone, travelNew)) {
    const c = {
      kind: 'travel', booking_id: old?.id ?? null, title: t ? `移動(${t.from}→${t.to})` : old.title,
      before: old ? { starts_at: old.starts_at, ends_at: old.ends_at } : null,
      after: t ? { starts_at: t.starts_at, ends_at: t.ends_at } : null,
    };
    changes.push({ ...c, line: changeLine(c) });
    if (t) travel.push({ ...t, ...(old ? { booking_id: old.id } : {}) });
    else unbook.push({ booking_id: old.id, kind: 'travel', title: old.title, starts_at: old.starts_at, ends_at: old.ends_at });
  }
  changes.sort((a, b) => (a.after ?? a.before).starts_at.localeCompare((b.after ?? b.before).starts_at));
  const habitsLeft = capped.days.flatMap((d) => d.habits_to_place.filter((h) => !h.starts_at).map((h) => ({ habit_id: h.habit_id, title: h.title, date: d.date })));
  return {
    from: period.from, to: period.to, limits: { ...limits }, ...(replan ? { replan: true } : {}),
    blocks, travel, unbook, changes, left: [...left, ...noEstimate], habits_left: habitsLeft,
  };
}
