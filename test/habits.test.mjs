// Tests for habits' repeat rules (readHabitRule, checkHabit in src/ledger/rules.mjs) and
// their occurrences (src/ledger/habits.mjs), on a fixed time zone.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readHabitRule, habitRuleText, checkHabit } from '../src/ledger/rules.mjs';
import { habitOccurrences } from '../src/ledger/habits.mjs';

process.env.TZ = 'Asia/Tokyo';

const habit = (rule, extra = {}) => ({ id: 'h_20261025000000_abcdef', title: 'Run', rule: JSON.stringify(rule), duration_min: 30, active: 1, ...extra });
const problemsOf = (value) => readHabitRule(value).problems;

test('rule: days are daily, weekdays or a list of 月〜日; window is HH:MM-HH:MM', () => {
  assert.deepEqual(readHabitRule({ days: 'daily' }), { rule: { days: 'daily' }, window_min: null, problems: [] });
  assert.deepEqual(readHabitRule('{"days":"weekdays","window":"09:00-10:30"}').rule, { days: 'weekdays', window: '09:00-10:30' });
  assert.equal(readHabitRule({ days: 'weekdays', window: '09:00-10:30' }).window_min, 90);
  assert.equal(readHabitRule({ days: ['日'], window: '23:00-07:00' }).window_min, 480);
  assert.deepEqual(readHabitRule({ days: ['日', '水', '月', '水'] }).rule.days, ['月', '水', '日']);
  assert.equal(habitRuleText({ window: '07:00-07:30', days: ['金', '月'] }), '{"days":["月","金"],"window":"07:00-07:30"}');
  assert.equal(habitRuleText('毎週金 9:00'), '毎週金 9:00'); // left as is, for checkHabit to refuse

  for (const bad of ['毎週金 9:00', '[]', 'null', 42, ['月']]) assert.match(problemsOf(bad)[0], /の形で書きます/, String(bad));
  assert.match(problemsOf({})[0], /days は/);
  assert.match(problemsOf({ days: [] })[0], /days は/);
  assert.match(problemsOf({ days: 'weekly' })[0], /days は/);
  assert.match(problemsOf({ days: ['Mon', '月'] })[0], /Mon は読めません/);
  assert.match(problemsOf({ days: 'daily', window: '7:00-7:30' })[0], /HH:MM/);
  assert.match(problemsOf({ days: 'daily', window: '24:00-01:00' })[0], /HH:MM/);
  assert.match(problemsOf({ days: 'daily', window: '07:00-07:00' })[0], /同じ/);
  assert.match(problemsOf({ days: 'daily', every: 2 })[0], /every は書けません/);
});

test('checkHabit: the length fits in the window and in a day', () => {
  const row = { title: 'Run', rule: '{"days":"daily","window":"07:00-07:30"}', duration_min: 30, goal_id: null, active: 1 };
  assert.deepEqual(checkHabit(row), []);
  assert.match(checkHabit({ ...row, duration_min: 31 }).join(), /収まりません/);
  assert.deepEqual(checkHabit({ ...row, rule: '{"days":"daily"}', duration_min: 1440 }), []);
  assert.match(checkHabit({ ...row, rule: '{"days":"daily"}', duration_min: 1441 }).join(), /1440/);
  assert.match(checkHabit({ ...row, rule: '{"days":"x"}' }).join(), /days は/);
});

test('occurrences: the listed days in [from, to), with the window on the local clock', () => {
  // 2026-11-02 is a Monday.
  const occ = habitOccurrences(habit({ days: ['月', '水', '金'], window: '07:00-07:30' }), {
    from: new Date('2026-11-02T00:00:00+09:00'),
    to: new Date('2026-11-09T00:00:00+09:00'),
  });
  assert.deepEqual(occ.map((o) => o.date), ['2026-11-02', '2026-11-04', '2026-11-06']);
  assert.deepEqual(occ[0], {
    habit_id: 'h_20261025000000_abcdef',
    title: 'Run',
    date: '2026-11-02',
    window_start: '2026-11-01T22:00:00.000Z',
    window_end: '2026-11-01T22:30:00.000Z',
    duration_min: 30,
  });
});

test('occurrences: daily, weekdays, and a day with no window is the whole day', () => {
  const week = { from: Date.parse('2026-11-02T00:00:00+09:00'), to: Date.parse('2026-11-09T00:00:00+09:00') };
  assert.equal(habitOccurrences(habit({ days: 'daily' }), week).length, 7);
  const wd = habitOccurrences(habit({ days: 'weekdays' }), week);
  assert.deepEqual(wd.map((o) => o.date), ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']);
  assert.equal(wd[0].window_start, '2026-11-01T15:00:00.000Z');
  assert.equal(wd[0].window_end, '2026-11-02T15:00:00.000Z');
});

test('occurrences: a window that shares time with the range counts, also one past midnight', () => {
  const sleep = habit({ days: ['日'], window: '23:00-07:00' }, { duration_min: 420 });
  // Sunday 2026-11-01 23:00 to Monday 07:00; asking from Monday midnight still finds it.
  const occ = habitOccurrences(sleep, { from: Date.parse('2026-11-02T00:00:00+09:00'), to: Date.parse('2026-11-03T00:00:00+09:00') });
  assert.equal(occ.length, 1);
  assert.equal(occ[0].date, '2026-11-01');
  assert.equal(occ[0].window_start, '2026-11-01T14:00:00.000Z');
  assert.equal(occ[0].window_end, '2026-11-01T22:00:00.000Z');
  // A range that ends when the window starts, or starts when it ends, shares no time.
  const run = habit({ days: 'daily', window: '07:00-07:30' });
  assert.equal(habitOccurrences(run, { from: Date.parse('2026-11-02T00:00:00+09:00'), to: Date.parse('2026-11-02T07:00:00+09:00') }).length, 0);
  assert.equal(habitOccurrences(run, { from: Date.parse('2026-11-02T07:30:00+09:00'), to: Date.parse('2026-11-02T12:00:00+09:00') }).length, 0);
  assert.equal(habitOccurrences(run, { from: Date.parse('2026-11-02T07:29:00+09:00'), to: Date.parse('2026-11-02T12:00:00+09:00') }).length, 1);
});

test('occurrences: none for a stopped habit or an empty range; an unreadable rule throws', () => {
  const range = { from: Date.parse('2026-11-02T00:00:00+09:00'), to: Date.parse('2026-11-09T00:00:00+09:00') };
  assert.deepEqual(habitOccurrences(habit({ days: 'daily' }, { active: 0 }), range), []);
  assert.deepEqual(habitOccurrences(habit({ days: 'daily' }, { active: false }), range), []);
  assert.deepEqual(habitOccurrences(habit({ days: 'daily' }), { from: range.to, to: range.from }), []);
  // The ledger returns the rule as an object; that is read too.
  assert.equal(habitOccurrences({ ...habit({}), rule: { days: 'daily' }, active: true }, range).length, 7);
  assert.throws(() => habitOccurrences({ ...habit({}), rule: '毎週金' }, range), /rule が読めません/);
  assert.throws(() => habitOccurrences(habit({ days: 'daily' }), { from: 'soon', to: range.to }), /from と to/);
});
