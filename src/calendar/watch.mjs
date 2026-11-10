// The calendar watch inside `warifuri serve`: keeps warifuri's copy of the person's Google
// Calendar up to date without an AI. It runs only when the person gave warifuri their own
// OAuth client and logged in (WARIFURI_GOOGLE_…, `warifuri google login`); without them the
// secretary's sync job reads the calendar as before.
//
// - Every pollMs it asks each calendar whether anything changed since last time (the sync
//   token of events.list). Only a calendar that changed is read again: its events from
//   yesterday to 14 days on, taken in by takein.mjs. Once an hour, and when the day turns,
//   every calendar is read, since the window moves and calendars come and go.
// - With push on, it also opens a channel on each calendar (events.watch), and Google calls
//   POST /api/google/calendar/notify when the calendar changes; the calendar is then asked
//   at once. A call is taken only when it names a channel of ours and carries that channel's
//   token. Channels end after a week, so each is opened again a day before, and the old one
//   closed. Polling goes on beside it, so a call that never came is caught up.
// - What changed (added, moved, gone) is handed to onChanges, which says it in the
//   secretary's conversation. The first read of all says nothing.
//
//   <home>/google/calendar.json   the sync tokens and the channels with their tokens.
//                                 Owner-only (600), never printed
//
// google, now and the timers are given by the caller, so tests stand in for Google and the clock.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { readSettings } from '../ledger/settings.mjs';
import { takeIn, readable, sourceOf, windowOf, GRACE_MS } from './takein.mjs';

export const NOTIFY_PATH = '/api/google/calendar/notify';
export const FULL_MS = 60 * 60 * 1000;
export const CHANNEL_TTL_S = 7 * 24 * 60 * 60;
export const RENEW_MS = 24 * 60 * 60 * 1000;
// How long after Google's call the calendar is read, so a burst of calls is one read.
export const POKE_MS = 2000;

export const stateFile = (home) => path.join(home, 'google', 'calendar.json');

function readState(file) {
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return json && typeof json === 'object' && json.calendars && typeof json.calendars === 'object' ? json : { calendars: {} };
  } catch {
    return { calendars: {} };
  }
}

function writeState(file, state, platform) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform !== 'win32') fs.chmodSync(dir, 0o700);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  if (platform !== 'win32') fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

const dayOf = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const same = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

// ledger: the open ledger. google: createGoogle()'s result. home: the data directory.
// pollMs: how often the calendars are asked. pushAddress: the https URL Google calls
// (<public URL>/api/google/calendar/notify), or null for no push. onChanges(changes): what
// changed in the copy. onProblem(err) / onOk(): a run that could not reach Google, and the
// first that could again.
export function createCalendarWatch({
  ledger, google, home, pollMs = 60_000, pushAddress = null, onChanges = () => {}, onProblem = () => {}, onOk = () => {}, log = () => {},
  now = () => new Date(), timers = globalThis, graceMs = GRACE_MS, platform = process.platform,
}) {
  const file = stateFile(home);
  const state = readState(file);
  // The calendars of the last full read; null until there was one in this process.
  let list = null;
  let running = null;
  let again = false;
  let timer = null;
  let pokeTimer = null;
  const poked = new Set();
  // Calendars whose channel could not be opened in this process.
  const noPush = new Set();
  const said = new Set();
  // One log line per kind of trouble, until a run goes well.
  const once = (line) => {
    if (said.has(line)) return;
    said.add(line);
    log(line);
  };

  async function closeChannel(channel) {
    if (!channel?.id || !channel.resourceId) return;
    try {
      await google.stop({ id: channel.id, resourceId: channel.resourceId });
    } catch (err) {
      // A channel Google has already forgotten ends by itself.
      if (err.status !== 404) once(`calendar: could not close a channel: ${err.message}`);
    }
  }

  // Opens, renews or closes the channel of one calendar.
  async function keepChannel(calendar, entry, t) {
    if (!pushAddress) {
      if (entry.channel) {
        await closeChannel(entry.channel);
        delete entry.channel;
      }
      return;
    }
    if (noPush.has(calendar.id) || (entry.channel && entry.channel.address === pushAddress && entry.channel.expiration - t > RENEW_MS)) return;
    const next = { id: randomUUID(), token: randomBytes(24).toString('hex'), address: pushAddress };
    try {
      const out = await google.watch(calendar.id, { id: next.id, token: next.token, address: pushAddress, ttlSeconds: CHANNEL_TTL_S });
      const old = entry.channel;
      entry.channel = { ...next, resourceId: out.resourceId, expiration: out.expiration ?? t.getTime() + CHANNEL_TTL_S * 1000 };
      await closeChannel(old);
    } catch (err) {
      // Some calendars cannot be watched, and an address Google does not take fails for all:
      // polling goes on either way. Tried again after a restart.
      noPush.add(calendar.id);
      once(`calendar: no push for one calendar (${err.message}); it is polled instead`);
    }
  }

  async function run() {
    const t = now();
    const full = !list || !state.fullAt || t - new Date(state.fullAt) >= FULL_MS || state.fullDay !== dayOf(t);
    if (full) {
      list = (await google.calendars()).filter(readable);
      // Calendars that are gone: their channel is closed and their token dropped.
      for (const id of Object.keys(state.calendars)) {
        if (list.some((c) => c.id === id)) continue;
        await closeChannel(state.calendars[id].channel);
        delete state.calendars[id];
      }
    }
    const window = windowOf(t);
    const reads = [];
    const failed = new Set();
    const asked = new Set(poked);
    poked.clear();
    for (const calendar of list) {
      const entry = (state.calendars[calendar.id] ??= {});
      try {
        let need = full || asked.has(calendar.id) || (entry.recheckAt && t >= new Date(entry.recheckAt));
        let out;
        try {
          out = await google.changed(calendar.id, entry.syncToken ?? null);
        } catch (err) {
          if (err.status !== 410) throw err;
          // The token is too old: start over, and read the calendar.
          out = await google.changed(calendar.id, null);
          need = true;
        }
        // A calendar that gives no token is read every time.
        if (out.changed || !out.syncToken) need = true;
        if (need) reads.push({ calendar, events: await google.events(calendar.id, window) });
        entry.syncToken = out.syncToken;
        if (need) delete entry.recheckAt;
      } catch (err) {
        failed.add(sourceOf(calendar));
        // Read again at the next check.
        entry.recheckAt = t.toISOString();
        once(`calendar: could not read one calendar: ${err.message}`);
      }
      await keepChannel(calendar, entry, t);
    }
    const out = takeIn(ledger, { reads, window, skip: readSettings(ledger).calendar?.skip ?? [], all: full, failed, now: t, graceMs });
    for (const w of out.waiting) {
      const entry = state.calendars[w.calendar];
      if (entry && (!entry.recheckAt || new Date(entry.recheckAt) > w.until)) entry.recheckAt = w.until.toISOString();
    }
    if (full) {
      state.fullAt = t.toISOString();
      state.fullDay = dayOf(t);
    }
    const first = !state.started;
    state.started = true;
    writeState(file, state, platform);
    if (failed.size === 0) said.clear();
    const n = { created: 0, moved: 0, deleted: 0 };
    for (const c of out.changes) n[c.change] += 1;
    if (out.changes.length) log(`calendar: ${n.created} added, ${n.moved} moved, ${n.deleted} removed${first ? ' (the first read)' : ''}`);
    if (out.problems) once(`calendar: ${out.problems} event${out.problems === 1 ? '' : 's'} could not be taken in`);
    if (out.changes.length && !first) onChanges(out.changes);
  }

  // One check; a call that comes while one is going runs once more after it.
  function tick() {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          try {
            await run();
            onOk();
          } catch (err) {
            once(`calendar: could not reach Google: ${err.message}`);
            onProblem(err);
          }
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return {
    tick,
    // Google's call (the headers of the request): true when it is from a channel of ours.
    // The calendar is then read shortly after.
    notify(headers) {
      const id = headers['x-goog-channel-id'];
      const found = Object.entries(state.calendars).find(([, e]) => e.channel && e.channel.id === id);
      if (!found || !same(headers['x-goog-channel-token'], found[1].channel.token)) return false;
      // The first call of a channel only says it is open.
      if (headers['x-goog-resource-state'] === 'sync') return true;
      poked.add(found[0]);
      if (!pokeTimer) {
        pokeTimer = timers.setTimeout(() => {
          pokeTimer = null;
          tick();
        }, POKE_MS);
        pokeTimer.unref?.();
      }
      return true;
    },
    start() {
      if (timer) return;
      tick();
      timer = timers.setInterval(tick, pollMs);
      timer.unref?.();
    },
    stop() {
      if (timer) timers.clearInterval(timer);
      if (pokeTimer) timers.clearTimeout(pokeTimer);
      timer = null;
      pokeTimer = null;
    },
  };
}
