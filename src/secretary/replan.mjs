// 組み直しのきっかけ: when the ledger says a plan may no longer hold, the secretary is called
// once into its conversation to plan again (harness/secretary/replan.md).
//
// - What calls for it: a task made with a due date (its own, or its goal's), and a task whose
//   due date or estimate changed. Writes by the secretary itself (its device) do not count, so
//   its own planning does not call it again.
// - Changes close together are taken as one: the call goes when no new change came for quietMs
//   (10 minutes), so the secretary is not woken for every write of an agent at work.
// - Not in the night: a change of the night waits, and the call goes at the first check after
//   the night is over.
// - Nothing from before the watch started counts (as with the clock: no backlog). A change
//   still waiting when serve stops is not called for after the restart; the nightly run plans
//   again anyway.
//
// tick() runs at every check of the secretary's clock (serve's onTick). The clock, the night and
// the call (trigger) are given by the caller, so tests stand in for them.

import { inNight } from './schedule.mjs';

export const REPLAN_QUIET_MS = 10 * 60 * 1000;
// How many tasks the call names, at most.
export const REPLAN_TASKS_MAX = 10;

// The changes in task records that call for planning again: [{ task_id, change, due?, estimate_min? }].
// change: 'created' (made with a due date), 'due' (its due date changed), 'estimate' (its
// estimate changed). goalDue(goalId): the goal's due date, or null.
export function replanChanges(rows, { ignoreDevice = null, goalDue = () => null } = {}) {
  const out = [];
  for (const r of rows) {
    if (r.entity !== 'task' || (ignoreDevice && r.device === ignoreDevice)) continue;
    const c = r.changes ?? {};
    if (r.action === 'create') {
      const due = c.due?.after ?? (c.goal_id?.after ? goalDue(c.goal_id.after) : null);
      if (due) out.push({ task_id: r.entity_id, change: 'created', due });
      continue;
    }
    if (r.action !== 'update') continue;
    if (c.due) out.push({ task_id: r.entity_id, change: 'due', due: c.due.after ?? null });
    if (c.estimate_min) out.push({ task_id: r.entity_id, change: 'estimate', estimate_min: c.estimate_min.after ?? null });
  }
  return out;
}

// What the call says about one task, in the person's words.
const WORDS = { created: '締切つきで増えた', due: '締切が変わった', estimate: '見積もりが変わった' };
export function replanLine(c) {
  const what = WORDS[c.change];
  const due = c.change !== 'estimate' && c.due ? `(締切 ${String(c.due).slice(0, 10)})` : '';
  const est = c.change === 'estimate' && c.estimate_min ? `(${c.estimate_min}分)` : '';
  return `${c.title ?? c.task_id}: ${what}${due}${est}`;
}

// ledger: the open ledger. trigger(tasks): writes the call (chat.trigger('replan', ...)) and
// returns { sent } or { skipped }. night: parseNight's result, or null. ignoreDevice: the
// secretary's device.
export function createReplanWatch({ ledger, trigger, now = () => new Date(), night = null, ignoreDevice = null, quietMs = REPLAN_QUIET_MS, log = () => {} }) {
  let mark = ledger.recordMark();
  let pending = [];
  let lastAt = null;
  const goalDue = (id) => {
    const g = ledger.get(id);
    return g?.kind === 'goal' ? g.due ?? null : null;
  };
  return {
    // The changes waiting for the call.
    get pending() {
      return pending.map((c) => ({ ...c }));
    },
    tick() {
      const rows = ledger.recordsSince(mark, 'task');
      if (rows.length) mark = rows.at(-1).id;
      const found = replanChanges(rows, { ignoreDevice, goalDue });
      const t = now();
      if (found.length) {
        // One line a task and change: the latest says it.
        for (const c of found) pending = [...pending.filter((p) => !(p.task_id === c.task_id && p.change === c.change)), c];
        lastAt = t;
      }
      if (!pending.length || t - lastAt < quietMs) return null;
      if (night && !night.error && inNight(night, t)) return null;
      const tasks = pending.slice(-REPLAN_TASKS_MAX).map((c) => {
        const task = ledger.get(c.task_id);
        return { ...c, title: task?.title ?? null };
      });
      pending = [];
      lastAt = null;
      const out = trigger(tasks);
      if (out?.sent) log(`secretary: replan sent into the conversation (${tasks.length} task${tasks.length === 1 ? '' : 's'})`);
      else if (out?.skipped) log(`secretary: replan not sent: ${out.skipped}`);
      return out ?? null;
    },
  };
}
