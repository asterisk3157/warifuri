// Tests for the timetable draft (src/ledger/timetable.mjs) and the timetable tool: which tasks
// are drafted, the order by due date, the bands of the week type, block lengths, one block a
// task a day, the daily cap, and the period's limit. The server's local time is Asia/Tokyo.

process.env.TZ = 'Asia/Tokyo';

import test from 'node:test';
import assert from 'node:assert/strict';
import { planTimetable, timetableFor } from '../src/ledger/timetable.mjs';
import { LIMIT_DEFAULTS, writeSettings } from '../src/ledger/settings.mjs';
import { openLedger } from '../src/ledger/ledger.mjs';
import { AUTONOMY_KINDS } from '../src/ledger/rules.mjs';

const ACTOR = { actor: 'human' };
const at = (hm, date = '2026-11-02') => `${date}T${hm}:00+09:00`;
const utc = (hm, date = '2026-11-02') => new Date(at(hm, date)).toISOString();
const task = (id, minutes, extra = {}) => ({ task_id: id, title: id, goal: null, profile: null, due: null, human_led: false, remaining_min: minutes, ...extra });
const oneDay = (free, extra = {}) => [{ date: '2026-11-02', budget_min: 480, free: free.map(([s, e]) => ({ starts_at: at(s), ends_at: at(e) })), habits_to_place: [], booked_task_ids: [], ...extra }];
const spans = (blocks) => blocks.map((b) => [b.task_id ?? b.habit_id, b.starts_at, b.ends_at]);

test('blocks follow the order given, one per task a day, from block_min to block_max minutes', () => {
  const { blocks, left } = planTimetable({
    days: oneDay([['09:00', '17:00']]),
    tasks: [task('a', 300), task('b', 20), task('c', 90)],
    limits: LIMIT_DEFAULTS,
  });
  assert.deepEqual(spans(blocks), [
    ['a', utc('09:00'), utc('11:00')], // cut at block_max_minutes
    ['b', utc('11:00'), utc('11:30')], // raised to block_min_minutes
    ['c', utc('11:30'), utc('13:00')],
  ]);
  assert.deepEqual(left, []);
});

test('a band with a profile takes only that profile and is filled first; the rest takes any', () => {
  const { blocks } = planTimetable({
    days: oneDay([['09:00', '18:00']]),
    bands: [{ starts_at: at('13:00'), ends_at: at('18:00'), profile: 'research' }],
    tasks: [task('club', 60, { profile: 'club' }), task('paper', 120, { profile: 'research' })],
    limits: LIMIT_DEFAULTS,
  });
  assert.deepEqual(spans(blocks), [['club', utc('09:00'), utc('10:00')], ['paper', utc('13:00'), utc('15:00')]]);
});

test('the daily cap, the tasks already booked that day, and short pieces leave tasks out', () => {
  const { blocks, left } = planTimetable({
    days: oneDay([['09:00', '09:20'], ['10:00', '17:00']], { budget_min: 90, booked_task_ids: ['b'] }),
    tasks: [task('a', 60), task('b', 60), task('c', 60)],
    limits: LIMIT_DEFAULTS,
  });
  // 09:00-09:20 is shorter than block_min_minutes; the last 30 minutes of the cap go to c.
  assert.deepEqual(spans(blocks), [['a', utc('10:00'), utc('11:00')], ['c', utc('11:00'), utc('11:30')]]);
  assert.deepEqual(left.map((l) => [l.task_id, l.left_min, l.reason]), [['b', 60, '空きに入らなかった']]);
});

test('habits to place come as habit blocks', () => {
  const { blocks } = planTimetable({
    days: oneDay([], { habits_to_place: [{ habit_id: 'h1', title: 'Walk', duration_min: 30, starts_at: utc('09:00'), ends_at: utc('09:30') }, { habit_id: 'h2', title: 'Run', duration_min: 30, starts_at: null, ends_at: null }] }),
    tasks: [],
    limits: LIMIT_DEFAULTS,
  });
  assert.deepEqual(blocks, [{ kind: 'habit', habit_id: 'h1', title: 'Walk', starts_at: utc('09:00'), ends_at: utc('09:30'), minutes: 30 }]);
});

function ledgerWithTasks() {
  // Now: Sunday 2026-11-01 22:00 in Tokyo; tomorrow is Monday 2026-11-02.
  const L = openLedger(':memory:', { now: () => new Date(at('22:00', '2026-11-01')) });
  const human = { mode: 'human', done_when: 'done' };
  const late = L.createGoal({ title: 'Late goal', mode: 'human', outcome: 'o', due: '2026-12-20' }, ACTOR);
  const soon = L.createGoal({ title: 'Soon goal', mode: 'human', outcome: 'o', due: '2026-11-10', profile: 'research', human_led: true }, ACTOR);
  const lateTask = L.createTask({ title: 'Late work', ...human, estimate_min: 60, goal_id: late.id }, ACTOR);
  const first = L.createTask({ title: 'First step', ...human, estimate_min: 240, goal_id: soon.id, after: [] }, ACTOR);
  const second = L.createTask({ title: 'Second step', ...human, estimate_min: 60, goal_id: soon.id, after: [first.id] }, ACTOR);
  const ai = L.createTask({ title: 'AI work', mode: 'ai_worker', estimate_min: 60 }, ACTOR);
  const guess = L.createTask({ title: 'No estimate', ...human }, ACTOR);
  const booked = L.createTask({ title: 'Booked already', ...human, estimate_min: 60 }, ACTOR);
  L.book({ kind: 'task', task_id: booked.id, starts_at: at('10:00', '2026-11-05'), ends_at: at('11:00', '2026-11-05') }, ACTOR);
  // An hour of First step is booked on Wednesday: three hours are left.
  L.book({ kind: 'task', task_id: first.id, starts_at: at('10:00', '2026-11-04'), ends_at: at('11:00', '2026-11-04') }, ACTOR);
  return { L, ids: { lateTask: lateTask.id, first: first.id, second: second.id, ai: ai.id, guess: guess.id, booked: booked.id } };
}

test('on the ledger: tomorrow by default, drafted tasks by due date, a lab band, and what is left', () => {
  const { L, ids } = ledgerWithTasks();
  writeSettings(L, { week: { slots: [{ days: ['月'], start: '13:00', end: '18:00', place: '研究室', profile: 'research' }] } }, {}, ACTOR);
  L.book({ kind: 'fixed', title: 'Class', starts_at: at('09:00'), ends_at: at('10:30') }, ACTOR);
  const out = timetableFor(L);
  assert.equal(out.from, utc('00:00'));
  assert.equal(out.to, utc('00:00', '2026-11-03'));
  assert.deepEqual(spans(out.blocks), [
    [ids.lateTask, utc('10:30'), utc('11:30')],
    [ids.first, utc('13:00'), utc('15:00')],
  ]);
  const first = out.blocks.find((b) => b.task_id === ids.first);
  assert.equal(first.due, '2026-11-10');
  assert.equal(first.human_led, true);
  assert.equal(first.profile, 'research');
  assert.equal(first.goal.title, 'Soon goal');
  // Second step waits for First step; AI work takes no person's time; Booked already is booked.
  const named = [...out.blocks.map((b) => b.task_id), ...out.left.map((l) => l.task_id)];
  for (const id of [ids.second, ids.ai, ids.booked]) assert.equal(named.includes(id), false);
  assert.deepEqual(out.left, [{ task_id: ids.guess, title: 'No estimate', left_min: null, reason: '見積りがない' }]);
  L.close();
});

test('on the ledger: the cap counts the bookings of the day, and more than 7 days is refused in Japanese', () => {
  const { L, ids } = ledgerWithTasks();
  writeSettings(L, { limits: { day_max_hours: 1.5 } }, { byPerson: true }, ACTOR);
  const out = timetableFor(L, { from: '2026-11-02' });
  assert.deepEqual(spans(out.blocks), [[ids.first, utc('09:00'), utc('10:30')]]);
  assert.deepEqual(out.left.map((l) => l.task_id), [ids.lateTask, ids.guess]);
  assert.throws(() => timetableFor(L, { from: '2026-11-02', to: '2026-11-10' }), /7 日まで/);
  L.close();
});

test('plan_timetable is a kind of the secretary at stage 2', () => {
  assert.deepEqual(AUTONOMY_KINDS.find((k) => k.kind === 'plan_timetable'), { kind: 'plan_timetable', label: '時間割を組む', stage: 2 });
});
