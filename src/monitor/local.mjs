// この機械: how the machine warifuri runs on is doing (CPU, memory, the disk of the data
// folder), and how the secretary's runs on it last went. Reads only.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JOB_TITLES, failureOf, logTail, paths } from '../secretary/secretary.mjs';

const round = (v) => Math.round(v) + 0;

// CPU as the load of the last minute over the cores (0 to 100; not on Windows), memory in
// use (on Linux, of what is available; elsewhere the cache counts as used), and how full the
// disk of the data folder is.
export function localMachine(home, { platform = process.platform } = {}) {
  const cores = os.cpus().length || 1;
  const cpu = platform === 'win32' ? null : Math.min(100, round((100 * os.loadavg()[0]) / cores));
  const total = os.totalmem();
  // os.freemem counts the cache as used. On Linux, MemAvailable is what can still be used.
  let available = os.freemem();
  if (platform === 'linux') {
    try {
      const kb = /^MemAvailable:\s+(\d+) kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'))?.[1];
      if (kb) available = Number(kb) * 1024;
    } catch {
      // Keep os.freemem.
    }
  }
  let disk = null;
  try {
    const s = fs.statfsSync(home ?? os.homedir());
    disk = { percent: round(100 * (1 - s.bavail / s.blocks)), freeGb: round((s.bavail * s.bsize) / 1024 ** 3) };
  } catch {
    disk = null;
  }
  return {
    cpu, cores,
    memory: round(100 * (1 - available / total)), memoryGb: round(total / 1024 ** 3),
    disk, uptimeSeconds: Math.floor(os.uptime()),
  };
}

// The runs of the secretary as their logs tell: for each job that has run, when it last
// ended and whether it failed (failureOf on the end of its log). The conversation's turns
// (the morning among them) are under 会話.
// The login is one for every run, so a run that failed for the login is over once a later
// run (of any job, the conversation too) got past it: the weekly inbox would otherwise stay
// red for a week after the person logged in again. Such a run is not ok, but resolved, and
// the screen shows it quietly.
const JOBS = [['nightly', JOB_TITLES.nightly], ['sync', JOB_TITLES.sync], ['inbox', JOB_TITLES.inbox], ['chat', '会話']];
export function secretaryJobs(home) {
  const dir = paths(home).logs;
  const runs = [];
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.log'));
  } catch {
    return [];
  }
  // Every last log (the jobs', the conversation's, the threads', the tells'), for when the
  // login last worked.
  for (const n of names) {
    const file = path.join(dir, n);
    let at;
    try {
      at = fs.statSync(file).mtime.toISOString();
    } catch {
      continue;
    }
    runs.push({ name: n.slice(0, -'.log'.length), at, failure: failureOf({ code: 0 }, logTail(file)) });
  }
  const loggedIn = runs.filter((r) => !r.failure).map((r) => r.at).sort().at(-1) ?? null;
  const out = [];
  for (const [job, title] of JOBS) {
    const run = runs.find((r) => r.name === job);
    if (!run) continue;
    const f = run.failure;
    const resolved = Boolean(f && f.reason === 'login' && loggedIn && loggedIn > run.at);
    out.push({
      job, title, at: run.at, ok: !f, resolved,
      problem: f && !resolved ? f.text : null,
      note: resolved ? 'ログインが切れて止まりました。そのあとログインし直せているので、次の回は動きます' : null,
    });
  }
  return out;
}
