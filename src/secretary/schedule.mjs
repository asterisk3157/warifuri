// The secretary's clock, as pure functions: when each job runs, in the server machine's local
// time. No I/O and no timers; scheduler.mjs runs the clock.
//
// A time is written "HH:MM" (every day), "<days> HH:MM" with days as a comma list of
// sun mon tue wed thu fri sat (such as "sun 23:00" or "mon,thu 07:30"), or "off". The night
// is "HH:MM-HH:MM" and may cross midnight.

export const JOBS = ['nightly', 'morning', 'inbox'];
export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

// { off: true }, or { days: [0..6] | null, hour, minute }, or { error }.
export function parseWhen(text) {
  const v = String(text ?? '').trim().toLowerCase();
  if (v === 'off') return { off: true };
  const parts = v.split(/\s+/);
  const time = parts.pop();
  const m = TIME.exec(time ?? '');
  if (!m || parts.length > 1) return { error: 'must be HH:MM, <days> HH:MM (days: sun,mon,…,sat) or off' };
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

// The latest run of `when` after `after` and at or before `upTo`, or null. A weekly time has
// a run in every 8 days, so only the last 8 days before upTo are looked at.
export function latestSlot(when, after, upTo) {
  if (!when || when.off || when.error) return null;
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
  const t = `${String(when.hour).padStart(2, '0')}:${String(when.minute).padStart(2, '0')}`;
  return when.days ? `${when.days.map((i) => DAYS[i]).join(',')} ${t}` : t;
}
