// Where the person is at each time (居場所), for work that can be done only in some places:
// a task with only_at 'home' needs the person at home (家: the network of work, such as a
// company VPN, reaches only there). whereabouts() is a pure function: no I/O, no clock.
//
// How a time's place is decided, the first that applies:
// 1. A booking with a location: the person is at that location for the booking's time. When
//    places.travel gives the minutes between that place and a home place, the person is also
//    away for that long before and after it (on the way). A location that is a URL (an online
//    meeting) says nothing of where the person is, and is skipped.
// 2. A band of the week type (week.slots): the person is at its place.
// 3. Neither: the person is taken to be at home (assumed). Only what is written moves the
//    person out, so a day with nothing written is a day at home.
// A place is home when places.places names it with home: true. Any other place, and a location
// that names no place at all (an address), is not home.

const MIN = 60_000;
const ms = (v) => new Date(v).getTime();
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

// The names of the home places: places.places with home: true.
export const homeNames = (places) => new Set((places ?? []).filter((p) => p?.home === true).map((p) => p.name));

// The minutes to come from the nearest home place to `place`, or 0 when none is written.
function travelFromHome(place, homes, travel) {
  let best = null;
  for (const t of travel ?? []) {
    const other = t.from === place ? t.to : t.to === place ? t.from : null;
    if (other !== null && homes.has(other) && (best === null || t.minutes < best)) best = t.minutes;
  }
  return best ?? 0;
}

// The person's place over [fromMs, toMs): [{ s, e, place, home, by }] by start, covering the
// whole period without gaps; neighbours with the same place and source are merged. place: the
// name, or null when assumed; home: whether it is home; by: 'booking', 'week' or 'assumed'.
// bands: weekBands() of the week type; bookings: [{ starts_at, ends_at, location }];
// places: places.places; travel: places.travel.
export function whereabouts({ fromMs, toMs, bands = [], bookings = [], places = [], travel = [] }) {
  const homes = homeNames(places);
  const isHome = (place) => homes.has(place);
  const spans = [];
  for (const b of bookings) {
    const place = typeof b.location === 'string' ? b.location.trim() : '';
    if (place === '' || URL_LIKE.test(place)) continue;
    const home = isHome(place);
    const pad = home ? 0 : travelFromHome(place, homes, travel) * MIN;
    spans.push({ s: ms(b.starts_at) - pad, e: ms(b.ends_at) + pad, place, home, by: 'booking' });
  }
  const week = bands.map((b) => ({ s: ms(b.starts_at), e: ms(b.ends_at), place: b.place, home: isHome(b.place), by: 'week' }));
  const edges = new Set([fromMs, toMs]);
  for (const x of [...spans, ...week]) {
    if (x.e <= fromMs || x.s >= toMs) continue;
    edges.add(Math.max(x.s, fromMs));
    edges.add(Math.min(x.e, toMs));
  }
  const points = [...edges].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const s = points[i];
    const e = points[i + 1];
    const covers = (x) => x.s <= s && x.e >= e;
    const hit = spans.find(covers) ?? week.find(covers);
    const piece = hit ? { s, e, place: hit.place, home: hit.home, by: hit.by } : { s, e, place: null, home: true, by: 'assumed' };
    const last = out.at(-1);
    if (last && last.e === s && last.place === piece.place && last.by === piece.by) last.e = e;
    else out.push(piece);
  }
  return out;
}

// The parts of [s, e) not at home, as whereabouts gives them.
export function awayParts(s, e, spans) {
  return spans.filter((x) => !x.home && x.e > s && x.s < e).map((x) => ({ ...x, s: Math.max(x.s, s), e: Math.min(x.e, e) }));
}
