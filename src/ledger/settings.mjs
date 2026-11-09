// The person's settings that scheduling reads: life (生活: sleep, meals, fixed commitments,
// written as plain rules), places (場所と移動時間), limits (上限: hours a day, the size of a
// block, the hours when blocks may be placed), calendar (カレンダー: the events not to take
// in from the person's calendars) and week (週の型: where the person is at set times of the
// week, and which profile's work goes there), plus onboarding (最初の会話: whether the secretary
// is making these settings with the person, has done it, or was told not to). Each is a section of the settings table, one
// key per field (life.rules, places.places, places.travel, limits.day_max_hours, ...), the
// value as JSON text, and each change is recorded as entity 'settings' with the section as
// its id. Unset fields read as their defaults.
//
// Limits are the person's to change (原則14): a write to them must say it is the person's
// decision (byPerson), and is recorded with action 'decide'. The secretary proposes instead.

import { LedgerError } from './ledger.mjs';

export const SECTIONS = ['life', 'places', 'limits', 'calendar', 'week', 'onboarding'];

export const RULES_MAX = 50;
export const RULE_MAX = 200;
export const PLACES_MAX = 50;
export const PLACE_NAME_MAX = 40;
export const PLACE_NOTE_MAX = 200;
export const SKIP_MAX = 50;
export const SKIP_TITLE_MAX = 100;
export const SKIP_CALENDAR_MAX = 200;
export const WEEK_SLOTS_MAX = 50;
export const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
// The states of the first conversation: asking (the secretary is making the settings with
// the person), done (made), skipped (the person said not now; asked again only on their word).
export const ONBOARDING_STATES = ['asking', 'done', 'skipped'];

// The defaults of the limits: a working day of 8 hours placed between 09:00 and 21:00, in
// blocks of 30 to 120 minutes. A scheduler stays inside them until the person changes them.
export const LIMIT_DEFAULTS = Object.freeze({
  day_max_hours: 8,
  block_min_minutes: 30,
  block_max_minutes: 120,
  earliest: '09:00',
  latest: '21:00',
});

const DEFAULTS = {
  life: { rules: [] },
  places: { places: [], travel: [] },
  limits: LIMIT_DEFAULTS,
  calendar: { skip: [] },
  week: { slots: [] },
  onboarding: { state: null },
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;
// Adds a problem and gives back nothing to write, for a section that cannot be read further.
function refuse(problems, problem) {
  problems.push(problem);
  return {};
}
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A one-line text up to max characters, trimmed; or a problem pushed and null.
function line(value, label, max, problems) {
  if (typeof value !== 'string') {
    problems.push(`${label}は文字列です`);
    return null;
  }
  const s = value.trim();
  if (s === '') problems.push(`${label}が空です`);
  else if ([...s].length > max) problems.push(`${label}は ${max} 文字までです`);
  else if (CONTROL.test(s)) problems.push(`${label}には改行や制御文字を入れられません`);
  else return s;
  return null;
}

function unknownKeys(value, allowed, label, problems) {
  const unknown = Object.keys(value).filter((k) => !allowed.includes(k));
  if (unknown.length) problems.push(`${label}に ${unknown.join('、')} は書けません(書けるのは ${allowed.join('、')})`);
}

// life: { rules: [text] }, each rule one line such as 「平日は 0:00 から 7:00 まで寝る」.
function checkLife(value, problems) {
  if (!isObject(value)) return refuse(problems, 'life は { rules: [...] } の形です');
  unknownKeys(value, ['rules'], 'life ', problems);
  if (value.rules === undefined) return {};
  if (!Array.isArray(value.rules)) return refuse(problems, 'life.rules は文字列の配列です');
  if (value.rules.length > RULES_MAX) problems.push(`life.rules は ${RULES_MAX} 件までです`);
  return { rules: value.rules.map((r, i) => line(r, `life.rules の ${i + 1} 件目`, RULE_MAX, problems)) };
}

// places: { places: [{ name, note? }], travel: [{ from, to, minutes }] }. A travel time names
// two of the places and holds both ways, so a pair is given once.
function checkPlaces(value, current, problems) {
  if (!isObject(value)) return refuse(problems, 'places は { places: [...], travel: [...] } の形です');
  unknownKeys(value, ['places', 'travel'], 'places ', problems);
  const out = {};
  if (value.places !== undefined) {
    if (!Array.isArray(value.places)) return refuse(problems, 'places.places は配列です');
    if (value.places.length > PLACES_MAX) problems.push(`places.places は ${PLACES_MAX} 件までです`);
    const seen = new Set();
    out.places = value.places.map((p, i) => {
      const label = `places.places の ${i + 1} 件目`;
      if (!isObject(p)) {
        problems.push(`${label}は { name, note } の形です`);
        return null;
      }
      unknownKeys(p, ['name', 'note'], `${label}`, problems);
      const name = line(p.name, `${label}の name `, PLACE_NAME_MAX, problems);
      if (name !== null && seen.has(name)) problems.push(`場所 ${name} が2回あります`);
      seen.add(name);
      const note = p.note === undefined || p.note === null ? undefined : line(p.note, `${label}の note `, PLACE_NOTE_MAX, problems);
      return note === undefined ? { name } : { name, note };
    });
  }
  if (value.travel !== undefined) {
    if (!Array.isArray(value.travel)) return refuse(problems, 'places.travel は配列です');
    const names = new Set((out.places ?? current.places).map((p) => p?.name));
    const pairs = new Set();
    out.travel = value.travel.map((t, i) => {
      const label = `places.travel の ${i + 1} 件目`;
      if (!isObject(t)) {
        problems.push(`${label}は { from, to, minutes } の形です`);
        return null;
      }
      unknownKeys(t, ['from', 'to', 'minutes'], `${label}`, problems);
      const from = line(t.from, `${label}の from `, PLACE_NAME_MAX, problems);
      const to = line(t.to, `${label}の to `, PLACE_NAME_MAX, problems);
      for (const n of [from, to]) if (n !== null && !names.has(n)) problems.push(`${label}の ${n} は、places.places にない場所です`);
      if (from !== null && from === to) problems.push(`${label}は、同じ場所どうしです`);
      const pair = [from, to].sort().join('\u0000');
      if (pairs.has(pair)) problems.push(`${from} と ${to} のあいだの移動時間が2回あります(片道を1回書けば、帰りも同じとみなします)`);
      pairs.add(pair);
      if (!Number.isInteger(t.minutes) || t.minutes < 0 || t.minutes > 24 * 60) problems.push(`${label}の minutes は 0 から 1440 までの整数(分)です`);
      return { from, to, minutes: t.minutes };
    });
  } else if (out.places) {
    // New places without the travel times: the times that still name two of them are kept.
    const names = new Set(out.places.map((p) => p?.name));
    out.travel = current.travel.filter((t) => names.has(t.from) && names.has(t.to));
  }
  return out;
}

// calendar: { skip: [{ title, calendar? }] }: the events not taken in, by their title as it is
// (the whole title); calendar, the id of the calendar they are in, or left out for any.
function checkCalendar(value, problems) {
  if (!isObject(value)) return refuse(problems, 'calendar は { skip: [...] } の形です');
  unknownKeys(value, ['skip'], 'calendar ', problems);
  if (value.skip === undefined) return {};
  if (!Array.isArray(value.skip)) return refuse(problems, 'calendar.skip は配列です');
  if (value.skip.length > SKIP_MAX) problems.push(`calendar.skip は ${SKIP_MAX} 件までです`);
  const seen = new Set();
  return {
    skip: value.skip.map((x, i) => {
      const label = `calendar.skip の ${i + 1} 件目`;
      if (!isObject(x)) {
        problems.push(`${label}は { title, calendar? } の形です`);
        return null;
      }
      unknownKeys(x, ['title', 'calendar'], `${label}`, problems);
      const title = line(x.title, `${label}の title `, SKIP_TITLE_MAX, problems);
      const calendar = x.calendar === undefined || x.calendar === null ? null : line(x.calendar, `${label}の calendar `, SKIP_CALENDAR_MAX, problems);
      const key = `${calendar ?? ''}\u0000${title}`;
      if (seen.has(key)) problems.push(`${label}は、前と同じ組です`);
      seen.add(key);
      return calendar ? { title, calendar } : { title };
    }),
  };
}

// week: { slots: [{ days, start, end, place, profile? }] }: where the person is at set times
// of every week. days is "daily", "weekdays" (月〜金) or a list such as ["月","木"]; start and
// end are HH:MM on the same day; place a name (best one of places.places); profile the work
// that goes there. Not busy time: a condition for placing work.
function checkWeek(value, problems) {
  if (!isObject(value)) return refuse(problems, 'week は { slots: [...] } の形です');
  unknownKeys(value, ['slots'], 'week ', problems);
  if (value.slots === undefined) return {};
  if (!Array.isArray(value.slots)) return refuse(problems, 'week.slots は配列です');
  if (value.slots.length > WEEK_SLOTS_MAX) problems.push(`week.slots は ${WEEK_SLOTS_MAX} 件までです`);
  return {
    slots: value.slots.map((x, i) => {
      const label = `week.slots の ${i + 1} 件目`;
      if (!isObject(x)) {
        problems.push(`${label}は { days, start, end, place, profile? } の形です`);
        return null;
      }
      unknownKeys(x, ['days', 'start', 'end', 'place', 'profile'], label, problems);
      let days = x.days;
      if (days !== 'daily' && days !== 'weekdays') {
        if (!Array.isArray(days) || days.length === 0 || days.some((d) => !WEEKDAYS.includes(d)) || new Set(days).size !== days.length) {
          problems.push(`${label}の days は "daily"、"weekdays" か、["月","木"] のような曜日の配列です`);
          days = null;
        } else days = WEEKDAYS.filter((d) => days.includes(d));
      }
      const times = [['start', x.start], ['end', x.end]];
      for (const [k, v] of times) if (typeof v !== 'string' || !HHMM.test(v)) problems.push(`${label}の ${k} は HH:MM(00:00 から 24:00)で書きます`);
      if (HHMM.test(x.start ?? '') && HHMM.test(x.end ?? '') && minutesOf(x.start) >= minutesOf(x.end)) problems.push(`${label}の start は end より前にします`);
      const place = line(x.place, `${label}の place `, PLACE_NAME_MAX, problems);
      const profile = x.profile === undefined || x.profile === null ? null : line(x.profile, `${label}の profile `, PLACE_NAME_MAX, problems);
      return { days, start: x.start, end: x.end, place, ...(profile ? { profile } : {}) };
    }),
  };
}

// onboarding: { state }, one of ONBOARDING_STATES; null puts it back to unset.
function checkOnboarding(value, problems) {
  if (!isObject(value)) return refuse(problems, 'onboarding は { state } の形です');
  unknownKeys(value, ['state'], 'onboarding ', problems);
  if (value.state === undefined) return {};
  if (value.state !== null && !ONBOARDING_STATES.includes(value.state)) {
    return refuse(problems, `onboarding.state は ${ONBOARDING_STATES.join('、')} か null です`);
  }
  return { state: value.state };
}

// Whether the secretary should make the settings with the person now (最初の会話): it said it
// is (asking), or nobody has said anything yet and the settings the schedule reads are all
// unset (a new install). Settings made by hand, done and skipped all say no.
export function onboardingDue(settings) {
  const state = settings.onboarding?.state ?? null;
  if (state === 'asking') return true;
  if (state !== null) return false;
  const d = settings.defaults ?? {};
  return ['life', 'places', 'limits', 'week'].every((section) => {
    const all = Object.keys(DEFAULTS[section]);
    return all.every((k) => (d[section] ?? []).includes(k));
  });
}

// The slots of the week type laid on the local days of [fromMs, toMs): [{ starts_at, ends_at,
// place, profile }] by start, as ISO times. slots: week.slots of readSettings.
export function weekBands(slots, fromMs, toMs) {
  const out = [];
  const first = new Date(fromMs);
  for (let d = new Date(first.getFullYear(), first.getMonth(), first.getDate()); d.getTime() < toMs; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const dow = WEEKDAYS[d.getDay()];
    for (const slot of slots ?? []) {
      const on = slot.days === 'daily' || (slot.days === 'weekdays' ? d.getDay() >= 1 && d.getDay() <= 5 : slot.days?.includes(dow));
      if (!on) continue;
      const at = (hhmm) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, minutesOf(hhmm)).getTime();
      const s = at(slot.start);
      const e = at(slot.end);
      if (e <= fromMs || s >= toMs) continue;
      out.push({ starts_at: new Date(s).toISOString(), ends_at: new Date(e).toISOString(), place: slot.place, profile: slot.profile ?? null });
    }
  }
  return out.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}

// limits: the fields given are merged over the current ones (null puts a field back to its
// default, and is returned as null so that it is unset), and the result must hold together.
function checkLimits(value, current, problems) {
  if (!isObject(value)) return refuse(problems, 'limits はオブジェクトです');
  const fields = Object.keys(LIMIT_DEFAULTS);
  unknownKeys(value, fields, 'limits ', problems);
  const out = {};
  for (const k of fields) if (k in value) out[k] = value[k];
  const next = { ...current };
  for (const [k, v] of Object.entries(out)) next[k] = v === null ? LIMIT_DEFAULTS[k] : v;
  const { day_max_hours: day, block_min_minutes: bmin, block_max_minutes: bmax, earliest, latest } = next;
  if (typeof day !== 'number' || !Number.isFinite(day) || day <= 0 || day > 24 || Math.round(day * 4) !== day * 4) {
    problems.push('limits.day_max_hours は 0 より大きく 24 までの時間で、15分(0.25)きざみです');
  }
  for (const [k, v] of [['block_min_minutes', bmin], ['block_max_minutes', bmax]]) {
    if (!Number.isInteger(v) || v < 5 || v > 24 * 60) problems.push(`limits.${k} は 5 から 1440 までの整数(分)です`);
  }
  if (Number.isInteger(bmin) && Number.isInteger(bmax) && bmin > bmax) problems.push('limits.block_min_minutes は block_max_minutes 以下にします');
  for (const [k, v] of [['earliest', earliest], ['latest', latest]]) {
    if (typeof v !== 'string' || !HHMM.test(v)) problems.push(`limits.${k} は HH:MM(00:00 から 24:00)で書きます`);
  }
  if (HHMM.test(earliest) && HHMM.test(latest)) {
    if (minutesOf(earliest) >= minutesOf(latest)) problems.push('limits.earliest は latest より前にします');
    else if (Number.isInteger(bmin) && minutesOf(latest) - minutesOf(earliest) < bmin) problems.push('earliest から latest までが、block_min_minutes より短くなっています');
  }
  return out;
}

// The sections as they are now, defaults filled in. `defaults` lists, per section, the
// fields that are not set and read as their defaults.
export function readSettings(ledger) {
  const out = { defaults: {} };
  for (const section of SECTIONS) {
    const stored = ledger.getSettings(section);
    const value = {};
    const unset = [];
    for (const [k, d] of Object.entries(DEFAULTS[section])) {
      if (stored[k] === undefined) {
        value[k] = structuredClone(d);
        unset.push(k);
      } else {
        value[k] = JSON.parse(stored[k]);
      }
    }
    out[section] = value;
    out.defaults[section] = unset;
  }
  return out;
}

// Writes the sections given ({ life, places, limits, calendar, week, onboarding }; a section given as null is put back to
// its defaults). Every problem of every section is listed before anything is written. Limits
// need byPerson. Returns readSettings afterwards.
export function writeSettings(ledger, input, { byPerson = false } = {}, writer) {
  const problems = [];
  const now = readSettings(ledger);
  const plan = {};
  for (const section of SECTIONS) {
    if (input[section] === undefined) continue;
    if (section === 'limits' && byPerson !== true) {
      problems.push(
        '上限(limits)を変えられるのは本人だけです(原則14)。本人がこの会話で決めたのなら by_person: true を付けます。秘書やエージェントの考えなら、書かずに本人に提案して了承を得てください',
      );
      continue;
    }
    if (input[section] === null) {
      plan[section] = Object.fromEntries(Object.keys(DEFAULTS[section]).map((k) => [k, null]));
      continue;
    }
    const before = problems.length;
    const checked =
      section === 'life' ? checkLife(input.life, problems)
        : section === 'places' ? checkPlaces(input.places, now.places, problems)
          : section === 'calendar' ? checkCalendar(input.calendar, problems)
            : section === 'week' ? checkWeek(input.week, problems)
              : section === 'onboarding' ? checkOnboarding(input.onboarding, problems)
                : checkLimits(input.limits, now.limits, problems);
    if (problems.length > before) continue;
    plan[section] = Object.fromEntries(Object.entries(checked).map(([k, v]) => [k, v === null ? null : JSON.stringify(v)]));
  }
  if (problems.length) throw new LedgerError(problems);
  for (const [section, values] of Object.entries(plan)) {
    ledger.setSettings(section, values, { ...writer, action: section === 'limits' ? 'decide' : 'update' });
  }
  return readSettings(ledger);
}
