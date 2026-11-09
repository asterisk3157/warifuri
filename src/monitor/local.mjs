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
const JOBS = [['nightly', JOB_TITLES.nightly], ['sync', JOB_TITLES.sync], ['inbox', JOB_TITLES.inbox], ['chat', '会話']];
export function secretaryJobs(home) {
  const dir = paths(home).logs;
  const out = [];
  for (const [job, title] of JOBS) {
    const file = path.join(dir, `${job}.log`);
    let at;
    try {
      at = fs.statSync(file).mtime.toISOString();
    } catch {
      continue;
    }
    const f = failureOf({ code: 0 }, logTail(file));
    out.push({ job, title, at, ok: !f, problem: f ? f.text : null });
  }
  return out;
}
