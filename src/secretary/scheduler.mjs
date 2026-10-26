// The secretary's small clock inside `warifuri serve`. It looks at the time every tickMs and
// starts the jobs whose time has come, one at a time.
//
// - Jobs due at the same check run one after another, in the order of JOBS (nightly, then
//   morning, then inbox), so the Sunday inbox tidy starts after the nightly run.
// - A job that comes due while an earlier run is still going is skipped, with one log line.
// - No backlog is caught up. Only times after the scheduler started count. When checks were
//   late (the machine slept), each job runs at most once, for its latest missed time, and
//   only when that time is within graceMs; older times are dropped with one log line.
//
// now, the timers and run(job, slot) are given by the caller, so tests stand in for the clock
// and for claude. run resolves to { code, signal, timedOut, busy, error }, or for a call into
// the conversation (the morning) to { sent } or { skipped: reason }; it never logs output.
// onTick runs at every check (serve looks there for calls into the conversation written by
// another process).

import { JOBS, latestSlot, countSlots, localIso } from './schedule.mjs';

export const TICK_MS = 30_000;
export const GRACE_MS = 60 * 60 * 1000;

// jobs: { nightly: when, morning: when, inbox: when, sync: when } from parseWhen.
export function createScheduler({ jobs, run, onTick = () => {}, now = () => new Date(), log = () => {}, tickMs = TICK_MS, graceMs = GRACE_MS, timers = globalThis }) {
  let last = now();
  let busy = false;
  let timer = null;

  async function runQueue(queue) {
    busy = true;
    try {
      for (const { job, slot } of queue) {
        const started = now();
        log(`secretary: ${job} started (for ${localIso(slot)})`);
        let out;
        try {
          out = await run(job, slot);
        } catch (err) {
          out = { error: err.message };
        }
        const secs = Math.round((now() - started) / 1000);
        if (out.sent) log(`secretary: ${job} sent into the conversation`);
        else if (out.skipped) log(`secretary: ${job} ${job === 'morning' ? 'not sent' : 'skipped'}: ${out.skipped}`);
        else if (out.busy) log(`secretary: ${job} skipped: another secretary run is still going`);
        else if (out.error) log(`secretary: ${job} did not start: ${out.error}`);
        else if (out.timedOut) log(`secretary: ${job} stopped after ${secs}s: it ran past the time limit`);
        else log(`secretary: ${job} finished in ${secs}s (exit ${out.code ?? out.signal})`);
      }
    } finally {
      busy = false;
    }
  }

  // One check. Returns the promise of the runs it started, or null.
  function tick() {
    try {
      onTick();
    } catch (err) {
      log(`secretary: check failed: ${err.message}`);
    }
    const t = now();
    const due = [];
    for (const job of JOBS) {
      const when = jobs[job];
      const slot = latestSlot(when, last, t);
      if (!slot) continue;
      const missed = countSlots(when, last, t);
      if (t - slot > graceMs) {
        log(`secretary: ${job} of ${localIso(slot)} was missed${missed > 1 ? ` (and ${missed - 1} earlier)` : ''}; not run now, since it is over ${Math.round(graceMs / 60000)} minutes late`);
        continue;
      }
      if (missed > 1) log(`secretary: ${job}: ${missed - 1} earlier time${missed === 2 ? ' was' : 's were'} missed; only the latest runs`);
      due.push({ job, slot });
    }
    last = t;
    if (due.length === 0) return null;
    if (busy) {
      for (const { job } of due) log(`secretary: ${job} skipped: the previous run is still going`);
      return null;
    }
    return runQueue(due);
  }

  return {
    tick,
    get busy() {
      return busy;
    },
    start() {
      if (timer) return;
      last = now();
      timer = timers.setInterval(tick, tickMs);
      timer.unref?.();
    },
    stop() {
      if (timer) timers.clearInterval(timer);
      timer = null;
    },
  };
}
