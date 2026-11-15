// The birthday watch inside `warifuri serve`: tells the person, without waking the AI, that a
// friend's birthday is near, with what they like, what they do not, and the presents given
// before. Made as the deadline watch is (src/secretary/deadlines.mjs): the secretary's clock
// looks at most every checkMs, and one note goes to the secretary's conversation, which the
// notifier sends to Discord as well (src/notify/notifier.mjs), with no mention.
//
// - Who: the people (src/ledger/people.mjs) of the profiles given (by default 友人) with a
//   birthday (YYYY-MM-DD or MM-DD). profiles 'all' takes everyone.
// - When: `days` before the birthday (14 by default; 0 stops the watch). A person found later
//   (written in less than `days` before) is told then, up to the day before. Each person's
//   birthday of each year is told once; what was told is kept in a file in the data directory.
// - In the night (the secretary's night) nothing is told; it waits for the morning.
// - What: from the person's items (of those profiles), the columns whose name is like 好きなもの,
//   苦手なもの and 誕プレ. A column that is not there is not written. The age, when the birthday
//   has the year. Everyone told at one look goes in one note.
//
// now and the file are given by the caller, so tests stand in for the clock.

import fs from 'node:fs';
import path from 'node:path';
import { inNight } from './schedule.mjs';
import { labelKey } from '../ledger/people.mjs';

export const CHECK_MS = 5 * 60 * 1000;
export const DEFAULT_DAYS = 14;
export const DEFAULT_PROFILES = ['友人'];
const KEEP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const BIRTHDAY = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/;
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

// The kinds of columns told, in this order, matched on labelKey (katakana as hiragana, 物 as もの).
export const KINDS = [
  { name: '好きなもの', match: /^(好き|すき|好もの|好み)/u },
  { name: '苦手なもの', match: /^(苦手|にがて|嫌い|きらい)/u },
  { name: '前にあげた誕プレ', match: /(誕ぷれ|たんぷれ|ぷれぜんと|贈りもの|おくりもの|あげたもの)/u },
];

const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const p2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

// The next birthday on or after today: { on (Date), in_days, turns (null without the year) }.
export function nextBirthday(birthday, now) {
  const m = typeof birthday === 'string' ? BIRTHDAY.exec(birthday) : null;
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  const today = midnight(now);
  const at = (y) => {
    const d = new Date(y, month - 1, day);
    return d.getMonth() === month - 1 ? d : new Date(y, 1, 28); // 02-29 in a common year
  };
  let on = at(today.getFullYear());
  if (on < today) on = at(today.getFullYear() + 1);
  return { on, in_days: Math.round((on - today) / DAY_MS), turns: m[1] ? on.getFullYear() - Number(m[1]) : null };
}

// The columns told, from items { label: value } ("profile/label" for the scope { all }).
export function pickItems(items) {
  const out = [];
  for (const kind of KINDS) {
    const values = Object.entries(items ?? {})
      .filter(([label, v]) => typeof v === 'string' && v.trim() && kind.match.test(labelKey(label.split('/').pop())))
      .map(([, v]) => v.trim());
    if (values.length) out.push({ name: kind.name, value: [...new Set(values)].join('、') });
  }
  return out;
}

// The note for the people told now ([{ person, on, in_days, turns }]): one line each.
export function birthdayNote(items) {
  return items.map(({ person, on, in_days: inDays, turns }) => {
    const date = `${on.getMonth() + 1}/${on.getDate()}(${WEEK[on.getDay()]})`;
    const parts = [`${person.name}さんの誕生日が ${date}で、あと${inDays}日です。`];
    if (turns !== null && turns > 0) parts.push(`${turns}歳になります。`);
    const picked = pickItems(person.items);
    parts.push(picked.map((p) => `${p.name}: ${p.value}`).join('。'));
    return parts.join('').replace(/。$/u, '');
  }).join('\n');
}

// The setting of the profiles: a comma list, or 'all'.
export function parseProfiles(v) {
  if (v === undefined || v === null || String(v).trim() === '') return DEFAULT_PROFILES;
  if (String(v).trim() === 'all') return 'all';
  return [...new Set(String(v).split(',').map((s) => s.trim()).filter(Boolean))];
}

// The people with a birthday, each once, with the items of the profiles given.
function peopleOf(ledger, profiles) {
  if (profiles === 'all') return ledger.people.list({ all: true }).people;
  const byId = new Map();
  for (const profile of profiles) {
    for (const p of ledger.people.list({ profile }).people) {
      const had = byId.get(p.id);
      byId.set(p.id, had ? { ...had, items: { ...had.items, ...Object.fromEntries(Object.entries(p.items).map(([l, v]) => [`${profile}/${l}`, v])) } } : { ...p, items: Object.fromEntries(Object.entries(p.items).map(([l, v]) => [`${profile}/${l}`, v])) });
    }
  }
  return [...byId.values()];
}

// ledger: the open ledger. tell(body, data): writes the note (chat.notice). days: how many days
// before (0: never). profiles: the profiles whose people are told, or 'all'. night: the
// secretary's night ({ start, end }), or null. file: where what was told is kept.
export function createBirthdayWatch({ ledger, tell, file, days = DEFAULT_DAYS, profiles = DEFAULT_PROFILES, night = null, now = () => new Date(), checkMs = CHECK_MS, log = () => {} }) {
  let lastAt = 0;
  const read = () => {
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      return v && typeof v === 'object' && v.told && typeof v.told === 'object' ? v : { told: {} };
    } catch {
      return { told: {} };
    }
  };
  const write = (state) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  };

  // One look, now. Returns the note written, or null.
  function check() {
    const t = now();
    lastAt = t.getTime();
    if (!days) return null;
    if (night && !night.error && inNight(night, t)) return null;
    const state = read();
    const items = [];
    for (const person of peopleOf(ledger, profiles)) {
      const next = nextBirthday(person.birthday, t);
      if (!next || next.in_days < 1 || next.in_days > days) continue;
      const key = `${person.id}:${ymd(next.on)}`;
      if (state.told[key]) continue;
      items.push({ person, ...next, key });
    }
    for (const [key, v] of Object.entries(state.told)) {
      if (t - new Date(v.on) > KEEP_DAYS * DAY_MS) delete state.told[key];
    }
    if (!items.length) {
      write(state);
      return null;
    }
    items.sort((a, b) => a.in_days - b.in_days || a.person.name.localeCompare(b.person.name, 'ja'));
    const m = tell(birthdayNote(items), { birthday: items.map((x) => ({ person: x.person.id, on: ymd(x.on) })) });
    for (const x of items) state.told[x.key] = { at: t.toISOString(), on: x.on.toISOString() };
    write(state);
    log(`birthdays: told ${items.length} birthday${items.length === 1 ? '' : 's'}`);
    return m;
  }

  return {
    check,
    tick() {
      if (now().getTime() - lastAt < checkMs) return null;
      return check();
    },
  };
}
