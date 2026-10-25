// A habit's occurrences, as a pure function: no I/O, no clock. The scheduler places each
// occurrence's duration_min inside its window. Days and times are on the server's clock
// (local time), as in schedule(); the window bounds are returned in UTC.

import { HABIT_DAY_SETS, HABIT_WEEKDAYS, readHabitRule } from './rules.mjs';

// Date#getDay() is 0 on Sunday; HABIT_WEEKDAYS starts on Monday.
const weekdayOf = (d) => HABIT_WEEKDAYS[(d.getDay() + 6) % 7];
const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// The occurrences of `habit` (a habits row, or one as the ledger returns it) whose window
// shares time with [from, to) (Dates or ms). Each is { habit_id, title, date, window_start,
// window_end, duration_min }: date is the local day it belongs to (YYYY-MM-DD), and the
// window is the rule's window that day, or the whole day without one. A stopped habit has
// none. A rule that cannot be read throws, since the ledger refuses to store one.
export function habitOccurrences(habit, { from, to }) {
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) throw new TypeError('from と to は日時です');
  if (!(habit.active === true || habit.active === 1) || toMs <= fromMs) return [];
  const { rule, problems } = readHabitRule(habit.rule);
  if (!rule) throw new TypeError(`習慣 ${habit.id} の rule が読めません: ${problems.join('。')}`);
  const days = typeof rule.days === 'string' ? HABIT_DAY_SETS[rule.days] : rule.days;
  const w = rule.window ? rule.window.split('-').map((t) => t.split(':').map(Number)) : null;

  const out = [];
  // Start a day early: a window past midnight from the day before may reach into the range.
  const start = new Date(fromMs);
  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1);
  while (day.getTime() < toMs) {
    if (days.includes(weekdayOf(day))) {
      const y = day.getFullYear();
      const m = day.getMonth();
      const d = day.getDate();
      let ws;
      let we;
      if (w) {
        ws = new Date(y, m, d, w[0][0], w[0][1]);
        const endsNextDay = w[1][0] * 60 + w[1][1] <= w[0][0] * 60 + w[0][1];
        we = new Date(y, m, d + (endsNextDay ? 1 : 0), w[1][0], w[1][1]);
      } else {
        ws = new Date(y, m, d);
        we = new Date(y, m, d + 1);
      }
      if (ws.getTime() < toMs && we.getTime() > fromMs) {
        out.push({
          habit_id: habit.id,
          title: habit.title,
          date: localDate(day),
          window_start: ws.toISOString(),
          window_end: we.toISOString(),
          duration_min: habit.duration_min,
        });
      }
    }
    day.setDate(day.getDate() + 1);
  }
  return out;
}
