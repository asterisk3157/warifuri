// Takes the events of Google Calendar into warifuri's copy (fixed bookings), by the rules of
// harness/secretary/sync.md, in code:
//
// - source is google-calendar for the person's own calendar (primary) and
//   google-calendar:<calendar id> for any other; external_id is the event's id.
// - A pair that is on a task's or habit's booking is an event warifuri wrote: no fixed
//   booking is made of it. When its time was changed in the calendar, the booking follows.
// - Any other event becomes a fixed booking (title, time, place, description, organizer),
//   changed when the event changed. That holds for an event whose description ends in
//   warifuri で作成 (the line the secretary writes) too: only the pair says warifuri wrote it.
// - Not taken in, and their copies deleted: cancelled events, events the person declined,
//   events shown as free (transparent), and the events of calendar.skip.
// - An all-day event runs from that day's midnight to the next (the server's local time). A
//   booking is at most 24 hours, so a longer event becomes one booking per day (or per 24
//   hours); the later ones have <event id>#2, #3, … as their external_id.
// - A fixed booking of a Google source in the window whose event is not there is deleted.
//   Bookings outside the window, fixed bookings with no source, and the bookings of tasks and
//   habits are never deleted.
//
// A new event made a moment ago waits (graceMs): when the secretary writes a task's time to
// the calendar it puts the pair on its booking right after, and a copy made in between would
// hold that pair.

export const SOURCE = 'google-calendar';
export const WINDOW_DAYS = 14;
export const GRACE_MS = 120_000;
export const NOTE_MAX = 2000;
export const WRITER = { actor: 'calendar-watch', device: 'calendar-watch' };
const DAY_MS = 24 * 60 * 60 * 1000;
// Calendars everybody has (holidays, birthdays, week numbers).
const VIRTUAL = /@group\.v\.calendar\.google\.com$/;

export const sourceOf = (calendar) => (calendar.primary ? SOURCE : `${SOURCE}:${calendar.id}`);
const isGoogleSource = (source) => source === SOURCE || (typeof source === 'string' && source.startsWith(`${SOURCE}:`));

// The calendars read: the person's own and the ones shared with them in full.
export const readable = (calendar) => !calendar.deleted && !VIRTUAL.test(calendar.id ?? '') && calendar.accessRole !== 'freeBusyReader';

// Yesterday's midnight to the end of the 14th day from today, on the server's clock.
export function windowOf(now) {
  return {
    from: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1),
    to: new Date(now.getFullYear(), now.getMonth(), now.getDate() + WINDOW_DAYS + 1),
  };
}

const localDay = (text) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text ?? '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};

// The bookings an event becomes: [{ external_id, starts_at, ends_at }] (Dates), each at most
// 24 hours. Empty when the event has no readable time.
export function piecesOf(event) {
  const allDay = Boolean(event.start?.date);
  const start = allDay ? localDay(event.start.date) : new Date(event.start?.dateTime ?? NaN);
  const end = allDay ? localDay(event.end?.date) : new Date(event.end?.dateTime ?? NaN);
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return [];
  const out = [];
  for (let s = start, n = 1; s < end; n++) {
    // The next local midnight for an all-day event (never more than 24 hours on), else 24 hours on.
    const next = allDay ? new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1) : new Date(s.getTime() + DAY_MS);
    const e = new Date(Math.min(next.getTime(), end.getTime(), s.getTime() + DAY_MS));
    out.push({ external_id: n === 1 ? event.id : `${event.id}#${n}`, starts_at: s, ends_at: e });
    s = next < end ? next : end;
  }
  return out;
}

// Why an event is not taken in, or null.
export function leftOut(event, calendar, skip = []) {
  if (event.status === 'cancelled') return 'cancelled';
  if ((event.attendees ?? []).some((a) => a.self && a.responseStatus === 'declined')) return 'declined';
  if (event.transparency === 'transparent' || event.eventType === 'workingLocation' || event.eventType === 'birthday') return 'free';
  const title = titleOf(event);
  const hit = skip.some((s) => s.title === title && (!s.calendar || s.calendar === calendar.id || (calendar.primary && s.calendar === 'primary')));
  return hit ? 'skip' : null;
}

const titleOf = (event) => (typeof event.summary === 'string' && event.summary.trim() ? event.summary.trim() : '予定あり');

// The description as plain text: Google keeps it as HTML.
function plain(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const out = text
    .replace(/<br\s*\/?>(\n)?/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!out) return null;
  const chars = [...out];
  return chars.length > NOTE_MAX ? `${chars.slice(0, NOTE_MAX).join('')}…` : out;
}

const sameTime = (booking, piece) => booking.starts_at === piece.starts_at.toISOString() && booking.ends_at === piece.ends_at.toISOString();

// reads: [{ calendar, events }], the calendars read this time (events: every event of the
// calendar in the window). all: reads is every calendar the person has, so a copy of a
// calendar that is no longer among them is deleted too; failed: the sources of calendars
// that could not be read this time (their copies stay). Returns { changes, waiting, problems }:
// changes as ledger.bookingChangesSince gives them (created, moved, deleted; a change of the
// title alone is not listed), waiting: [{ calendar, until }] for events left for later
// (graceMs), problems: how many events the ledger refused.
export function takeIn(ledger, { reads, window, skip = [], all = false, failed = new Set(), now = new Date(), graceMs = GRACE_MS, writer = WRITER }) {
  const mark = ledger.recordMark();
  const kept = new Map();
  const waiting = [];
  let problems = 0;
  for (const { calendar, events } of reads) {
    const source = sourceOf(calendar);
    const ids = new Set();
    kept.set(source, ids);
    for (const event of events) {
      if (typeof event.id !== 'string' || !event.id || leftOut(event, calendar, skip)) continue;
      const pieces = piecesOf(event);
      if (!pieces.length) continue;
      try {
        // An event warifuri wrote: its booking follows the time the person gave it in the calendar.
        const own = ledger.bookingFor(source, event.id);
        if (own && own.kind !== 'fixed') {
          ids.add(event.id);
          if (!sameTime(own, pieces[0])) ledger.book({ id: own.id, starts_at: pieces[0].starts_at.toISOString(), ends_at: pieces[0].ends_at.toISOString() }, writer);
          continue;
        }
        const made = Date.parse(event.created ?? '');
        const fresh = !own && !Number.isNaN(made) && now - made < graceMs;
        for (const piece of pieces) {
          if (piece.ends_at <= window.from || piece.starts_at >= window.to) continue;
          if (fresh) {
            waiting.push({ calendar: calendar.id, until: new Date(made + graceMs) });
            break;
          }
          ids.add(piece.external_id);
          ledger.book(
            {
              kind: 'fixed', title: titleOf(event), starts_at: piece.starts_at.toISOString(), ends_at: piece.ends_at.toISOString(), source,
              external_id: piece.external_id, location: event.location?.trim() || null, note: plain(event.description),
              organizer: event.organizer?.email ?? event.creator?.email ?? null,
            },
            writer,
          );
        }
      } catch (err) {
        // One event the ledger refuses does not stop the rest.
        if (!err.problems) throw err;
        problems += 1;
      }
    }
  }
  const { bookings } = ledger.schedule({ from: window.from.toISOString(), to: window.to.toISOString() });
  for (const b of bookings) {
    if (b.kind !== 'fixed' || !isGoogleSource(b.source) || !b.external_id) continue;
    const ids = kept.get(b.source);
    if (ids ? !ids.has(b.external_id) : all && !failed.has(b.source)) ledger.unbook(b.id, writer);
  }
  return { changes: ledger.bookingChangesSince(mark, writer.device), waiting, problems };
}
