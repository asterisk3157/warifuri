// The secretary's clock, as pure functions: when each job runs, in the server machine's local
// time. No I/O and no timers; scheduler.mjs runs the clock.
//
// A time is written "HH:MM" (every day), "<days> HH:MM" with days as a comma list of
// sun mon tue wed thu fri sat (such as "sun 23:00" or "mon,thu 07:30"), "every <n>m" or
// "every <n>h" (from local midnight on, such as "every 60m": 00:00, 01:00, …), or "off". The
// night is "HH:MM-HH:MM" and may cross midnight.

export const JOBS = ['nightly', 'morning', 'inbox', 'sync'];
// The shortest and longest interval of an "every" time, in minutes.
export const EVERY_MIN = 15;
export const EVERY_MAX = 24 * 60;
export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

// { off: true }, or { days: [0..6] | null, hour, minute }, or { every: minutes }, or { error }.
export function parseWhen(text) {
  const v = String(text ?? '').trim().toLowerCase();
  if (v === 'off') return { off: true };
  const e = /^every\s+(\d+)\s*(m|h)$/.exec(v);
  if (e) {
    const every = Number(e[1]) * (e[2] === 'h' ? 60 : 1);
    if (every < EVERY_MIN || every > EVERY_MAX) return { error: `every must be from ${EVERY_MIN}m to 24h` };
    return { every };
  }
  const parts = v.split(/\s+/);
  const time = parts.pop();
  const m = TIME.exec(time ?? '');
  if (!m || parts.length > 1) return { error: 'must be HH:MM, <days> HH:MM (days: sun,mon,…,sat), every <n>m or off' };
  let days = null;
  if (parts.length === 1) {
    days = [];
    for (const d of parts[0].split(',')) {
      const i = DAYS.indexOf(d);
      if (i < 0) return { error: `has an unknown day ${d} (use sun, mon, tue, wed, thu, fri, sat)` };
      if (!days.includes(i)) days.push(i);
    }
    days.sort();
  }
  return { days, hour: Number(m[1]), minute: Number(m[2]) };
}

// { start, end } as minutes from midnight, or { error }.
export function parseNight(text) {
  const m = /^\s*([01]\d|2[0-3]):([0-5]\d)\s*-\s*([01]\d|2[0-3]):([0-5]\d)\s*$/.exec(String(text ?? ''));
  if (!m) return { error: 'must be HH:MM-HH:MM' };
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  if (start === end) return { error: 'must not start and end at the same time' };
  return { start, end };
}

// Is the local time of date inside the night?
export function inNight(night, date) {
  const t = date.getHours() * 60 + date.getMinutes();
  return night.start < night.end ? t >= night.start && t < night.end : t >= night.start || t < night.end;
}

// The run of `when` on the local day of `day`, or null when it does not run that day.
// new Date(y, m, d, h, mi) is local time; a time skipped by a clock change moves forward.
function slotOn(when, day) {
  if (when.days && !when.days.includes(day.getDay())) return null;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), when.hour, when.minute);
}

const dayBefore = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - n);

// The runs of an "every" time on the local day of `day`, earliest first.
function everySlots(when, day) {
  const out = [];
  for (let m = 0; m < 24 * 60; m += when.every) out.push(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, m));
  return out;
}

// The latest run of `when` after `after` and at or before `upTo`, or null. A weekly time has
// a run in every 8 days, so only the last 8 days before upTo are looked at.
export function latestSlot(when, after, upTo) {
  if (!when || when.off || when.error) return null;
  if (when.every) {
    for (let n = 0; n <= 1; n++) {
      const s = everySlots(when, dayBefore(upTo, n)).filter((x) => x <= upTo).pop();
      if (s) return s > after ? s : null;
    }
    return null;
  }
  for (let n = 0; n <= 8; n++) {
    const s = slotOn(when, dayBefore(upTo, n));
    if (!s || s > upTo) continue;
    return s > after ? s : null;
  }
  return null;
}

// How many runs of `when` fall after `after` and at or before `upTo` (for the log line).
export function countSlots(when, after, upTo, cap = 1000) {
  if (!when || when.off || when.error) return 0;
  if (when.every) {
    let count = 0;
    for (let n = 0; count < cap; n++) {
      const day = dayBefore(upTo, n);
      if (dayBefore(day, -1) <= after) break;
      count += everySlots(when, day).filter((s) => s <= upTo && s > after).length;
    }
    return Math.min(count, cap);
  }
  let count = 0;
  for (let n = 0; count < cap; n++) {
    const day = dayBefore(upTo, n);
    if (dayBefore(day, -1) <= after) break;
    const s = slotOn(when, day);
    if (s && s <= upTo && s > after) count++;
  }
  return count;
}

// The next run of `when` after `after`, or null.
export function nextSlot(when, after) {
  if (!when || when.off || when.error) return null;
  if (when.every) {
    for (let n = 0; n <= 1; n++) {
      const s = everySlots(when, dayBefore(after, -n)).find((x) => x > after);
      if (s) return s;
    }
    return null;
  }
  for (let n = 0; n <= 8; n++) {
    const s = slotOn(when, dayBefore(after, -n));
    if (s && s > after) return s;
  }
  return null;
}

// The local time with its offset, such as 2026-10-25T23:00:00+09:00.
export function localIso(d) {
  const p = (n) => String(Math.abs(n)).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${off < 0 ? '-' : '+'}${p(Math.trunc(off / 60))}:${p(off % 60)}`
  );
}

// How a time is shown to the person: "23:00", "sun 23:00", "off".
export function showWhen(when) {
  if (when.off) return 'off';
  if (when.every) return when.every % 60 === 0 ? `every ${when.every / 60}h` : `every ${when.every}m`;
  const t = `${String(when.hour).padStart(2, '0')}:${String(when.minute).padStart(2, '0')}`;
  return when.days ? `${when.days.map((i) => DAYS[i]).join(',')} ${t}` : t;
}
