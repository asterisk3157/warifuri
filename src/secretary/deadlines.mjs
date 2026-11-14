// The deadline watch inside `warifuri serve`: tells the person, without waking the AI, about
// open tasks whose due date is near. It reads the ledger (each task's due and state) at most
// every checkMs, and writes one note in the secretary's conversation for what is new, which
// the notifier sends to Discord as well (src/notify/notifier.mjs).
//
// - Two stages in the day: two days before the due date (d2) and the day before (d1). The
//   person wants a task done a day before it is due, so both say やりましょう. A task done or
//   discarded is not told.
// - In the night (the secretary's night, such as 23:00-07:00) only what is due before the
//   night ends is told (today: the date-only due of the day, at 23:00, or a due time within
//   the night); the notifier lets that one through the night (data.urgent). Stages of the day
//   wait for the morning.
// - Each task's stage is told once, for that due: a due moved later is told again. What was
//   told is kept in a file in the data directory, so a restart does not tell it again.
// - A booking that started with the task not touched is not told (the person decided).
//
// now and the file are given by the caller, so tests stand in for the clock.

import fs from 'node:fs';
import path from 'node:path';
import { inNight } from './schedule.mjs';

export const CHECK_MS = 5 * 60 * 1000;
export const STAGES = ['d2', 'd1', 'today'];
// How long what was told is kept, after the due date.
const KEEP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

// The moment a due ends: a date alone is the end of that local day.
export function dueEnd(due) {
  const m = DATE_ONLY.exec(due);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1);
  return new Date(due);
}

// The local day of a due, as a Date at its midnight.
function dueDay(due) {
  const m = DATE_ONLY.exec(due);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(due);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

// When the night that holds now ends.
function nightEnds(night, now) {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(night.end / 60), night.end % 60);
  return end > now ? end : new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1, Math.floor(night.end / 60), night.end % 60);
}

// The stage of a due at now: 'd2', 'd1', 'today' (in the night only) or null.
export function stageOf(due, now, night = null) {
  if (typeof due !== 'string' || !due) return null;
  const end = dueEnd(due);
  if (Number.isNaN(end.getTime()) || end <= now) return null;
  if (night && !night.error && inNight(night, now)) return end <= nightEnds(night, now) ? 'today' : null;
  const days = Math.round((dueDay(due) - midnight(now)) / DAY_MS);
  if (days === 2) return 'd2';
  if (days === 1) return 'd1';
  return null;
}

const p2 = (n) => String(n).padStart(2, '0');
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
function dueWords(due, stage) {
  const day = dueDay(due);
  const date = `${day.getMonth() + 1}/${day.getDate()}(${WEEK[day.getDay()]})`;
  const time = DATE_ONLY.test(due) ? '' : (() => {
    const d = new Date(due);
    return ` ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  })();
  if (stage === 'd2') return `あさって ${date}${time}`;
  if (stage === 'd1') return `あした ${date}${time}`;
  return `今夜${time || ' 24:00'}`;
}

// The note for the tasks told now ([{ task, stage }]).
export function deadlineNote(items) {
  const lines = items.map(({ task, stage }) => `- ${dueWords(task.due, stage)}が締切${task.due_provisional ? '(仮)' : ''}: ${task.title}`);
  return ['締切が近いのに、まだ終わっていないタスクがあります。やりましょう。', ...lines].join('\n');
}

// Every open task with a due: from the goals and the tasks with no goal.
function openTasks(ledger) {
  const b = ledger.board();
  return [...b.goals.flatMap((g) => g.tasks), ...(b.unassigned ?? [])].filter((t) => t.due && !['done', 'discarded'].includes(t.state));
}

// ledger: the open ledger. tell(body, data): writes the note (chat.notice). night: the
// secretary's night ({ start, end }), or null. file: where what was told is kept.
export function createDeadlineWatch({ ledger, tell, file, night = null, now = () => new Date(), checkMs = CHECK_MS, log = () => {} }) {
  let lastAt = 0;
  const read = () => {
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      return v && typeof v === 'object' && v.told && typeof v.told === 'object' ? v : { told: {} };
    } catch {
      return { told: {} };
    }
  };
  const write = (state) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  };

  // One look, now. Returns the note written, or null.
  function check() {
    const t = now();
    lastAt = t.getTime();
    const state = read();
    const items = [];
    for (const task of openTasks(ledger)) {
      const stage = stageOf(task.due, t, night);
      if (!stage) continue;
      const key = `${task.id}:${stage}:${task.due}`;
      if (state.told[key]) continue;
      items.push({ task, stage, key });
    }
    // What is long past its due is forgotten.
    for (const [key, v] of Object.entries(state.told)) {
      if (t - new Date(v.end) > KEEP_DAYS * DAY_MS) delete state.told[key];
    }
    if (!items.length) {
      write(state);
      return null;
    }
    const urgent = items.some((x) => x.stage === 'today');
    const m = tell(deadlineNote(items), { deadline: items.map(({ task, stage }) => ({ task: task.id, stage, due: task.due })), ...(urgent ? { urgent: true } : {}) });
    for (const x of items) state.told[x.key] = { at: t.toISOString(), end: dueEnd(x.task.due).toISOString() };
    write(state);
    log(`deadlines: told ${items.length} task${items.length === 1 ? '' : 's'} due soon`);
    return m;
  }

  return {
    check,
    // At every tick of the clock: looks when checkMs has passed since the last look.
    tick() {
      if (now().getTime() - lastAt < checkMs) return null;
      return check();
    },
  };
}
