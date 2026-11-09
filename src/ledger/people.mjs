// 人: one row per person (原則20, 21), kept as a table. What can be a column is a column: the
// fixed ones every profile the person is in sees (name, the names they go by, email, phone,
// affiliation, role, birthday), and per profile, free columns (好きなもの, 得意なこと, ...). A free
// column's name is matched against the ones the profile already has (好きな物 is written as
// 好きなもの), so one thing is one column. Everything else is a memo (メモ: what happened, how to
// deal with them, or other), with where it came from; a memo can later become a column
// (promote_memos). A memo whose person is not known yet is kept with person_id NULL, for the
// secretary to put on the right person.
//
// Who sees what: a caller names one profile and sees only the people in it, and only that
// profile's items and memos. The scope { all: true } (the secretary, with no profile named)
// sees everything, each item and memo with its profile.
// { profile, secretary: true } (the secretary naming a profile) sees that profile like anyone,
// and may also put people in other profiles.
//
// People can be forgotten for good: forget deletes the rows (the database runs with
// secure_delete, and the write-ahead log is emptied afterwards). So the ledger's records of
// people say which fields changed, never their values or the text of a memo.
//
// `ctx` is what openLedger shares with this module: the database, its helpers and the clock.

import { randomInt } from 'node:crypto';

export const FIELDS = ['name', 'aliases', 'email', 'phone', 'affiliation', 'role', 'birthday'];
export const LINK_KINDS = ['goal', 'task', 'booking'];
export const MARKS = ['本人の言葉', '未確認'];
// やりとり: something that happened (a meeting, a request), 接し方: how to deal with them (how they
// like to be asked, what to watch for), その他: the rest.
export const MEMO_KINDS = ['やりとり', '接し方', 'その他'];
export const MAX_ALIASES = 10;
export const MAX_MEMO_CHARS = 4000;
export const BIRTHDAYS_MAX_DAYS = 366;
export const PEOPLE_MAX = 200;
export const COLUMN_VALUES = 10;

const NAME_CHARS = 100;
const FIELD_CHARS = 200;
const LABEL_CHARS = 40;
const VALUE_CHARS = 500;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9()\- ]{3,24}$/;
const BIRTHDAY = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/;
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const DAY_MS = 24 * 60 * 60 * 1000;

// What warifuri does not keep about anyone: numbers that open accounts or prove who someone
// is, secrets, and health and beliefs. A label naming one is refused, and so is a value or memo holding 12 or more
// digits in a row (a card, account or My Number; a phone number has fewer and has its field).
const FORBIDDEN_LABEL = /マイナンバー|個人番号|口座|暗証|パスワード|password|クレジット|カード番号|card\s*number|保険証|パスポート|passport|免許証|健康|持病|病歴|宗教|信仰|支持政党/i;
const LONG_DIGITS = /(?:\d[\s-]?){12,}/;

const pad = (n, w = 2) => String(n).padStart(w, '0');
const chars = (s) => [...s].length;
const blank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
// The form two names are compared in: NFKC, no spaces, lower case.
export const nameKey = (s) => String(s).normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
// The form two column names are compared in: as nameKey, katakana as hiragana, and the kanji
// often written in kana (物, 事, 時) as kana, and ・ and colons dropped. 好きな物 and 好きなモノ meet.
export const labelKey = (s) => nameKey(s)
  .replace(/[\u30a1-\u30f6]/gu, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
  .replace(/物/gu, 'もの').replace(/事/gu, 'こと').replace(/時/gu, 'とき')
  .replace(/[・:：]/gu, '');

function checkBirthday(value) {
  const m = BIRTHDAY.exec(value);
  if (!m) return false;
  const month = Number(m[2]);
  const day = Number(m[3]);
  const year = m[1] ? Number(m[1]) : 2000; // a leap year, so 02-29 passes without a year
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

// Problems with a text that is kept about someone (an item's value or a memo).
function sensitive(text, what) {
  return LONG_DIGITS.test(text)
    ? [`${what}に、12桁以上続く数字があります。カードや口座、マイナンバーのような番号は持ちません`]
    : [];
}

// The fixed fields given, checked and cleaned: '' and null clear a field (except name).
// Returns { values, problems }.
function cleanFields(input, { creating }) {
  const values = {};
  const problems = [];
  for (const f of FIELDS) {
    if (input[f] === undefined) continue;
    const v = input[f];
    if (f === 'name') {
      if (typeof v !== 'string' || v.trim() === '') problems.push('name(名前)が空です');
      else if (chars(v.trim()) > NAME_CHARS) problems.push(`name は ${NAME_CHARS} 文字までです`);
      else values.name = v.trim();
    } else if (f === 'aliases') {
      if (v === null) values.aliases = [];
      else if (!Array.isArray(v) || v.some((a) => typeof a !== 'string')) problems.push('aliases(呼び名)は文字列の並びです');
      else {
        const list = [...new Set(v.map((a) => a.trim()).filter(Boolean))];
        if (list.length > MAX_ALIASES) problems.push(`aliases は ${MAX_ALIASES} 個までです`);
        if (list.some((a) => chars(a) > NAME_CHARS)) problems.push(`呼び名は1つ ${NAME_CHARS} 文字までです`);
        values.aliases = list;
      }
    } else if (blank(v)) {
      values[f] = null;
    } else if (typeof v !== 'string') {
      problems.push(`${f} は文字列です(null で消す)`);
    } else {
      const t = v.trim();
      if (chars(t) > FIELD_CHARS) problems.push(`${f} は ${FIELD_CHARS} 文字までです`);
      else if (f === 'email' && !EMAIL.test(t)) problems.push(`email ${t} はメールアドレスの形ではありません`);
      else if (f === 'phone' && !PHONE.test(t)) problems.push('phone は数字と + - ( ) と空白で書きます');
      else if (f === 'birthday' && !checkBirthday(t)) problems.push('birthday は MM-DD か YYYY-MM-DD(年が分かるとき)で書きます');
      else values[f] = f === 'email' ? t.toLowerCase() : t;
    }
  }
  if (creating && values.name === undefined && !problems.some((p) => p.startsWith('name'))) problems.push('name(名前)が要ります');
  return { values, problems };
}

function cleanItems(items) {
  const out = [];
  const problems = [];
  if (items === undefined) return { out, problems };
  if (items === null || typeof items !== 'object' || Array.isArray(items)) return { out, problems: ['items は { 項目の名前: 値 } の形です(値を null にすると消す)'] };
  for (const [rawLabel, v] of Object.entries(items)) {
    const label = rawLabel.trim();
    if (label === '' || chars(label) > LABEL_CHARS) { problems.push(`項目の名前は 1〜${LABEL_CHARS} 文字です(${rawLabel})`); continue; }
    if (FORBIDDEN_LABEL.test(label)) { problems.push(`「${label}」は持たない項目です。番号や暗証、健康や信じていることは、人のデータベースに書きません`); continue; }
    if (v === null) { out.push({ label, value: null }); continue; }
    if (typeof v !== 'string' || v.trim() === '') { problems.push(`項目「${label}」の値は文字列です(null で消す)`); continue; }
    if (chars(v.trim()) > VALUE_CHARS) { problems.push(`項目「${label}」の値は ${VALUE_CHARS} 文字までです`); continue; }
    const p = sensitive(v, `項目「${label}」`);
    if (p.length) { problems.push(...p); continue; }
    out.push({ label, value: v.trim() });
  }
  return { out, problems };
}

function checkMemoText(text) {
  if (typeof text !== 'string' || text.trim() === '') return ['メモ(text)が空です'];
  if (chars(text.trim()) > MAX_MEMO_CHARS) return [`メモは1件 ${MAX_MEMO_CHARS} 文字までです`];
  return sensitive(text, 'メモ');
}

export function peopleStore({ db, one, all, transaction, record, now, LedgerError, requireWriter }) {
  const nowIso = () => now().toISOString();
  const localDate = (d = now()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fail = (problems) => {
    throw new LedgerError(problems);
  };

  function newId() {
    const d = now();
    const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
      `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
    for (;;) {
      let rand = '';
      for (let i = 0; i < 6; i += 1) rand += ID_CHARS[randomInt(ID_CHARS.length)];
      const id = `n_${stamp}_${rand}`;
      if (!one('SELECT 1 FROM people WHERE id = ?', id)) return id;
    }
  }

  // scope: { profile } or { all: true }. Refuses a scope that names neither.
  function checkScope(scope) {
    if (scope?.all === true) return;
    if (typeof scope?.profile !== 'string' || scope.profile.trim() === '') fail(['人を読み書きするには、プロフィールを決めます(profile か place)']);
  }
  const profilesOf = (id) => all('SELECT profile FROM person_profiles WHERE person_id = ? ORDER BY profile', id).map((r) => r.profile);
  const inProfile = (id, profile) => !!one('SELECT 1 FROM person_profiles WHERE person_id = ? AND profile = ?', id, profile);
  const visible = (id, scope) => scope.all === true || inProfile(id, scope.profile);

  // The person's row, or a refusal that does not say whether the person exists elsewhere.
  function personRow(id, scope) {
    checkScope(scope);
    const row = typeof id === 'string' ? one('SELECT * FROM people WHERE id = ?', id) : null;
    if (!row || !visible(row.id, scope)) fail([`${id} という人は、${scope.all ? '' : `プロフィール ${scope.profile} に`}いません`]);
    return row;
  }

  // The profile an item or memo is written in: the scope's, or for { all } the one given.
  function writeProfile(scope, profile, what) {
    if (scope.all !== true) return scope.profile;
    if (typeof profile !== 'string' || profile.trim() === '') fail([`${what}を書くプロフィール(profile)を決めます`]);
    return profile;
  }

  const memoCond = (scope) => (scope.all ? ['', []] : [' AND profile = ?', [scope.profile]]);

  function linksOf(id) {
    const out = [];
    for (const l of all('SELECT kind, target_id FROM person_links WHERE person_id = ? ORDER BY created_at, target_id', id)) {
      const t = l.kind === 'booking'
        ? one('SELECT title, starts_at FROM bookings WHERE id = ?', l.target_id)
        : one(`SELECT title FROM ${l.kind === 'goal' ? 'goals' : 'tasks'} WHERE id = ?`, l.target_id);
      if (t) out.push({ kind: l.kind, id: l.target_id, title: t.title, ...(t.starts_at ? { starts_at: t.starts_at } : {}) });
    }
    return out;
  }

  function memoView(f, scope) {
    return { id: f.id, kind: f.kind, text: f.text, mark: f.mark, source: f.source, learned_on: f.learned_on, ...(scope.all ? { profile: f.profile } : {}) };
  }

  // The whole person, as the scope sees them.
  function view(row, scope) {
    const [cond, args] = memoCond(scope);
    return {
      id: row.id,
      name: row.name,
      aliases: JSON.parse(row.aliases),
      email: row.email,
      phone: row.phone,
      affiliation: row.affiliation,
      role: row.role,
      birthday: row.birthday,
      ...(scope.all ? { profiles: profilesOf(row.id) } : {}),
      items: all(`SELECT profile, label, value FROM person_items WHERE person_id = ?${cond} ORDER BY profile, label`, row.id, ...args)
        .map((i) => ({ label: i.label, value: i.value, ...(scope.all ? { profile: i.profile } : {}) })),
      memos: all(`SELECT * FROM person_memos WHERE person_id = ?${cond} ORDER BY learned_on, id`, row.id, ...args).map((f) => memoView(f, scope)),
      links: linksOf(row.id),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  const itemsOf = (id, scope) => {
    const [cond, args] = memoCond(scope);
    return all(`SELECT profile, label, value FROM person_items WHERE person_id = ?${cond} ORDER BY profile, label`, id, ...args);
  };

  // One row of the table: the columns, and how many memos (their text is read with get).
  // items: { 列: 値 } of the scope's profile (for { all }, "プロフィール/列").
  function summary(row, scope) {
    const [cond, args] = memoCond(scope);
    return {
      id: row.id,
      name: row.name,
      aliases: JSON.parse(row.aliases),
      email: row.email,
      phone: row.phone,
      affiliation: row.affiliation,
      role: row.role,
      birthday: row.birthday,
      items: Object.fromEntries(itemsOf(row.id, scope).map((i) => [scope.all ? `${i.profile}/${i.label}` : i.label, i.value])),
      memos: one(`SELECT count(*) AS n FROM person_memos WHERE person_id = ?${cond}`, row.id, ...args).n,
      ...(scope.all ? { profiles: profilesOf(row.id) } : {}),
    };
  }

  function rowsIn(scope) {
    return scope.all
      ? all('SELECT * FROM people ORDER BY name, id')
      : all('SELECT p.* FROM people p JOIN person_profiles pp ON pp.person_id = p.id WHERE pp.profile = ? ORDER BY p.name, p.id', scope.profile);
  }

  // People in the scope who share a name, a name they go by, or the email with the fields.
  function similar(fields, scope, exceptId = null) {
    const keys = new Set([fields.name, ...(fields.aliases ?? [])].filter(Boolean).map(nameKey));
    return rowsIn(scope).filter((r) => r.id !== exceptId && (
      [r.name, ...JSON.parse(r.aliases)].some((n) => keys.has(nameKey(n))) || (fields.email && r.email === fields.email)
    )).map((r) => ({ id: r.id, name: r.name }));
  }

  // A person as written, with the free columns whose name was matched to one already there.
  const withNotes = (v, changes) => (changes.renamed_labels ? { ...v, renamed_labels: changes.renamed_labels } : v);

  const recordPerson = (w, id, action, changes) => record(w, 'person', id, action, changes);

  function insertMemo(w, { person_id: personId, profile, text, kind, mark, source, learned_on: learnedOn }) {
    const info = db.prepare(
      'INSERT INTO person_memos (person_id, profile, text, kind, mark, source, learned_on, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(personId ?? null, profile, text.trim().replace(/\r\n?/g, '\n'), kind ?? 'その他', mark ?? null, source ?? null, learnedOn ?? localDate(), nowIso());
    return Number(info.lastInsertRowid);
  }

  function checkMemos(list, at) {
    const problems = [];
    if (list === undefined) return problems;
    if (!Array.isArray(list)) return [`${at} は並びです`];
    for (const [i, f] of list.entries()) {
      problems.push(...checkMemoText(f?.text).map((p) => `${at}[${i}]: ${p}`));
      if (f?.learned_on !== undefined && !(typeof f.learned_on === 'string' && checkBirthday(f.learned_on) && f.learned_on.length === 10)) {
        problems.push(`${at}[${i}]: learned_on は YYYY-MM-DD で書きます`);
      }
      if (f?.kind !== undefined && !MEMO_KINDS.includes(f.kind)) problems.push(`${at}[${i}]: kind は やりとり、接し方、その他 のどれかです`);
      if (f?.mark !== undefined && f.mark !== null && !MARKS.includes(f.mark)) problems.push(`${at}[${i}]: mark は 本人の言葉 か 未確認 です(確かめたことは null)`);
    }
    return problems;
  }

  function checkLinks(list, at) {
    const problems = [];
    if (list === undefined) return problems;
    if (!Array.isArray(list)) return [`${at} は並びです`];
    for (const [i, l] of list.entries()) {
      if (!LINK_KINDS.includes(l?.kind)) { problems.push(`${at}[${i}]: kind は goal、task、booking のどれかです`); continue; }
      const table = { goal: 'goals', task: 'tasks', booking: 'bookings' }[l.kind];
      if (!one(`SELECT 1 FROM ${table} WHERE id = ?`, l.id)) problems.push(`${at}[${i}]: ${l.id} という${{ goal: 'ゴール', task: 'タスク', booking: '予定' }[l.kind]}はありません`);
    }
    return problems;
  }

  // The memos named by id that the scope may change: { rows, problems }.
  function memosNamed(ids, scope, at, { unassignedOnly = false, personId = null } = {}) {
    const rows = [];
    const problems = [];
    if (!Array.isArray(ids)) return { rows, problems: [`${at} はメモの id の並びです`] };
    for (const id of ids) {
      const f = one('SELECT * FROM person_memos WHERE id = ?', id);
      const seen = f && (scope.all || f.profile === scope.profile) && (f.person_id === null || visible(f.person_id, scope));
      if (!seen) problems.push(`${at}: ${id} というメモはありません`);
      else if (unassignedOnly && f.person_id !== null) problems.push(`${at}: ${id} はもう人に付いています`);
      else if (personId && f.person_id !== personId) problems.push(`${at}: ${id} はこの人のメモではありません`);
      else rows.push(f);
    }
    return { rows, problems };
  }

  // Applies items, memos and links to a person inside a write. Returns the changes to record
  // (names and counts only).
  function applyParts(w, id, input, scope) {
    const changes = {};
    if (input.items?.length) {
      const p = writeProfile(scope, input.profile, '項目');
      const known = new Map(all('SELECT DISTINCT label FROM person_items WHERE profile = ? ORDER BY label', p).map((r) => [labelKey(r.label), r.label]));
      for (const item of input.items) {
        const same = known.get(labelKey(item.label));
        if (same && same !== item.label) { (changes.renamed_labels ??= []).push({ given: item.label, as: same }); item.label = same; }
        known.set(labelKey(item.label), item.label);
      }
      for (const { label, value } of input.items) {
        if (value === null) db.prepare('DELETE FROM person_items WHERE person_id = ? AND profile = ? AND label = ?').run(id, p, label);
        else {
          db.prepare(
            'INSERT INTO person_items (person_id, profile, label, value, updated_at) VALUES (?, ?, ?, ?, ?) ' +
              'ON CONFLICT(person_id, profile, label) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
          ).run(id, p, label, value, nowIso());
        }
      }
      changes.items = input.items.map((i) => i.label);
    }
    if (input.add_memos?.length) {
      const p = writeProfile(scope, input.profile, 'メモ');
      changes.added_memos = input.add_memos.map((f) => insertMemo(w, { person_id: id, profile: p, text: f.text, kind: f.kind, mark: f.mark, source: f.source ?? input.source, learned_on: f.learned_on }));
    }
    for (const f of input.editRows ?? []) {
      db.prepare('UPDATE person_memos SET text = ?, kind = ?, mark = ? WHERE id = ?')
        .run(f.text === undefined ? f.row.text : f.text.trim(), f.kind ?? f.row.kind, f.mark === undefined ? f.row.mark : f.mark, f.row.id);
    }
    // A memo that became a column: the column is written above (items), the memo goes.
    for (const f of input.promoteRows ?? []) db.prepare('DELETE FROM person_memos WHERE id = ?').run(f.id);
    if (input.promoteRows?.length) changes.promoted_memos = input.promoteRows.map((f) => f.id);
    if (input.editRows?.length) changes.edited_memos = input.editRows.map((f) => f.row.id);
    for (const f of input.assignRows ?? []) db.prepare('UPDATE person_memos SET person_id = ? WHERE id = ?').run(id, f.id);
    if (input.assignRows?.length) changes.assigned_memos = input.assignRows.map((f) => f.id);
    for (const l of input.link ?? []) {
      db.prepare('INSERT OR IGNORE INTO person_links (person_id, kind, target_id, created_at) VALUES (?, ?, ?, ?)').run(id, l.kind, l.id, nowIso());
    }
    if (input.link?.length) changes.linked = input.link.map((l) => l.id);
    for (const l of input.unlink ?? []) {
      db.prepare('DELETE FROM person_links WHERE person_id = ? AND kind = ? AND target_id = ?').run(id, l.kind, l.id);
    }
    if (input.unlink?.length) changes.unlinked = input.unlink.map((l) => l.id);
    return changes;
  }

  // Checks everything but the fixed fields that create and update share. Pushes problems and
  // returns the cleaned parts.
  function prepareParts(input, scope, problems, personId) {
    // promote_memos: [{ id, label, value? }]: the memo becomes the column label (its text as the
    // value, unless value is given) and leaves the memos.
    let promoteRows = [];
    const promoted = {};
    if (input.promote_memos !== undefined) {
      if (!Array.isArray(input.promote_memos)) problems.push('promote_memos は [{ id, label, value? }] の並びです');
      else {
        const named = memosNamed(input.promote_memos.map((f) => f?.id), scope, 'promote_memos', { personId });
        problems.push(...named.problems);
        promoteRows = named.rows;
        for (const row of named.rows) {
          const f = input.promote_memos.find((e) => e?.id === row.id);
          if (typeof f.label !== 'string' || f.label.trim() === '') problems.push(`promote_memos: ${row.id} の移す先の列(label)がありません`);
          else promoted[f.label] = f.value ?? row.text;
        }
      }
    }
    const items = cleanItems(Object.keys(promoted).length ? { ...(input.items ?? {}), ...promoted } : input.items);
    problems.push(...items.problems);
    problems.push(...checkMemos(input.add_memos, 'add_memos'));
    problems.push(...checkLinks(input.link, 'link'));
    problems.push(...checkLinks(input.unlink, 'unlink'));
    let editRows = [];
    if (input.edit_memos !== undefined) {
      if (!Array.isArray(input.edit_memos)) problems.push('edit_memos は [{ id, text, mark? }] の並びです');
      else {
        problems.push(...checkMemos(input.edit_memos.map((f) => (f?.text === undefined ? { ...f, text: '-' } : f)), 'edit_memos'));
        const named = memosNamed(input.edit_memos.map((f) => f?.id), scope, 'edit_memos', { personId });
        problems.push(...named.problems);
        editRows = named.rows.map((row) => {
          const f = input.edit_memos.find((e) => e?.id === row.id);
          return { row, text: f.text, kind: f.kind, mark: f.mark };
        });
      }
    }
    let assignRows = [];
    if (input.assign_memos !== undefined) {
      const named = memosNamed(input.assign_memos, scope, 'assign_memos', { unassignedOnly: true });
      problems.push(...named.problems);
      assignRows = named.rows;
    }
    if (scope.all && (items.out.length || input.add_memos?.length) && blank(input.profile)) {
      problems.push('項目やメモを書くプロフィール(profile)を決めます');
    }
    return { ...input, items: items.out, editRows, assignRows, promoteRows };
  }

  function checkProfiles(list, at, scope) {
    if (list === undefined) return [];
    if (!Array.isArray(list) || list.some((p) => typeof p !== 'string' || p.trim() === '')) return [`${at} はプロフィールの名前の並びです`];
    if (!scope.all && !scope.secretary && list.some((p) => p !== scope.profile)) return [`${at} に書けるのは、いまのプロフィール(${scope.profile})だけです。ほかのプロフィールにも入れるのは秘書です`];
    return [];
  }

  // Makes a person. input: the fixed fields (name needed), profiles (default: the scope's),
  // items, add_memos, link, profile (for { all }: where items and memos go), source (of the
  // memos), allow_similar (make it even when someone in the scope has the same name or email).
  function create(input, scope, opts) {
    const w = requireWriter(opts);
    checkScope(scope);
    const { values, problems } = cleanFields(input, { creating: true });
    problems.push(...checkProfiles(input.profiles, 'profiles', scope));
    const profiles = [...new Set(input.profiles ?? (scope.all ? [input.profile].filter(Boolean) : [scope.profile]))];
    if (profiles.length === 0) problems.push('profiles(この人が入るプロフィール)を1つ以上渡します');
    if (input.edit_memos !== undefined || input.unlink !== undefined) problems.push('新しい人には edit_memos と unlink は使えません');
    const parts = prepareParts({ ...input, edit_memos: undefined, unlink: undefined }, scope, problems, null);
    if (problems.length) fail(problems);
    if (input.allow_similar !== true) {
      const same = similar(values, scope);
      if (same.length) {
        throw new LedgerError([
          `同じ名前かメールの人がもういます(${same.map((s) => `${s.id} ${s.name}`).join('、')})。同じ人なら person の id で直します。別の人なら allow_similar: true を付けます`,
        ], { similar: same });
      }
    }
    return transaction(() => {
      const id = newId();
      const t = nowIso();
      db.prepare(
        'INSERT INTO people (id, name, aliases, email, phone, affiliation, role, birthday, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(id, values.name, JSON.stringify(values.aliases ?? []), values.email ?? null, values.phone ?? null,
        values.affiliation ?? null, values.role ?? null, values.birthday ?? null, t, t);
      for (const p of profiles) db.prepare('INSERT INTO person_profiles (person_id, profile) VALUES (?, ?)').run(id, p);
      const changes = applyParts(w, id, parts, scope);
      recordPerson(w, id, 'create', { fields: Object.keys(values), profiles, ...changes });
      return withNotes(view(one('SELECT * FROM people WHERE id = ?', id), scope), changes);
    });
  }

  // Changes a person: the fixed fields given (null clears one), add_profiles, remove_profiles,
  // items ({ label: value }, null removes), add_memos, edit_memos ([{ id, text, mark? }]),
  // assign_memos (ids of memos with no person yet), link and unlink ([{ kind, id }]).
  function update(id, input, scope, opts) {
    const w = requireWriter(opts);
    const row = personRow(id, scope);
    const { values, problems } = cleanFields(input, { creating: false });
    problems.push(...checkProfiles(input.add_profiles, 'add_profiles', scope));
    problems.push(...checkProfiles(input.remove_profiles, 'remove_profiles', scope));
    const parts = prepareParts(input, scope, problems, row.id);
    const after = new Set(profilesOf(row.id));
    for (const p of input.add_profiles ?? []) after.add(p);
    for (const p of input.remove_profiles ?? []) after.delete(p);
    if (after.size === 0) problems.push('どのプロフィールにも入らない人は持てません。消すなら forget を使います');
    let touched = Object.keys(values).length + (input.add_profiles?.length ?? 0) + (input.remove_profiles?.length ?? 0) +
      parts.items.length + (parts.add_memos?.length ?? 0) + parts.editRows.length + parts.assignRows.length +
      (parts.link?.length ?? 0) + (parts.unlink?.length ?? 0);
    if (input.promote_memos?.length) touched += 1;
    if (touched === 0 && problems.length === 0) problems.push('直す項目を1つ以上渡します');
    if (problems.length) fail(problems);
    return transaction(() => {
      const fields = Object.keys(values);
      if (fields.length) {
        db.prepare(`UPDATE people SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`)
          .run(...fields.map((f) => (f === 'aliases' ? JSON.stringify(values[f]) : values[f])), row.id);
      }
      for (const p of input.add_profiles ?? []) db.prepare('INSERT OR IGNORE INTO person_profiles (person_id, profile) VALUES (?, ?)').run(row.id, p);
      for (const p of input.remove_profiles ?? []) db.prepare('DELETE FROM person_profiles WHERE person_id = ? AND profile = ?').run(row.id, p);
      const changes = applyParts(w, row.id, parts, scope);
      db.prepare('UPDATE people SET updated_at = ? WHERE id = ?').run(nowIso(), row.id);
      recordPerson(w, row.id, 'update', {
        ...(fields.length ? { fields } : {}),
        ...(input.add_profiles?.length ? { add_profiles: input.add_profiles } : {}),
        ...(input.remove_profiles?.length ? { remove_profiles: input.remove_profiles } : {}),
        ...changes,
      });
      return withNotes(view(one('SELECT * FROM people WHERE id = ?', row.id), scope), changes);
    });
  }

  // The person in the profile the text starts with: the longest name or name they go by that
  // begins it. null when none does, or when two people tie.
  function match(profile, text) {
    const t = nameKey(text);
    let best = null;
    let bestLen = 0;
    let tie = false;
    for (const r of rowsIn({ profile })) {
      for (const n of [r.name, ...JSON.parse(r.aliases)]) {
        const k = nameKey(n);
        if (k === '' || !t.startsWith(k)) continue;
        if (k.length > bestLen) { best = r; bestLen = k.length; tie = false; } else if (k.length === bestLen && best?.id !== r.id) tie = true;
      }
    }
    return best && !tie ? { id: best.id, name: best.name } : null;
  }

  // Adds a memo learned in a profile (note with people: true, close with learned_people, the
  // inbox sorted into people). person: an id in the profile, or else the person the text starts
  // with; with neither, the memo waits with no person. Returns { memo, person }.
  function learn({ profile, text, kind = 'その他', mark = null, source = null, person }, opts) {
    const w = requireWriter(opts);
    const problems = checkMemoText(text);
    if (!MEMO_KINDS.includes(kind)) problems.push('kind は やりとり、接し方、その他 のどれかです');
    if (mark !== null && !MARKS.includes(mark)) problems.push('mark は 本人の言葉 か 未確認 です');
    if (typeof profile !== 'string' || profile.trim() === '') problems.push('プロフィールの名前がありません');
    if (problems.length) fail(problems);
    let who = null;
    if (person !== undefined && person !== null) {
      const row = personRow(person, { profile });
      who = { id: row.id, name: row.name };
    } else {
      who = match(profile, text);
    }
    return transaction(() => {
      const memo = insertMemo(w, { person_id: who?.id ?? null, profile, text, kind, mark, source });
      if (who) db.prepare('UPDATE people SET updated_at = ? WHERE id = ?').run(nowIso(), who.id);
      recordPerson(w, who?.id ?? `profile:${profile}`, 'learn', { memo, profile });
      return { memo, person: who };
    });
  }

  // The columns of the scope: the fixed ones, then the free ones its people have, each with
  // how many people fill it and the values written there (up to COLUMN_VALUES, the most used
  // first), so a new value is written the way the others are (東京 rather than 東京都).
  function columns(scope) {
    const [cond, args] = memoCond(scope);
    const ids = new Set(rowsIn(scope).map((r) => r.id));
    const free = new Map();
    for (const i of all(`SELECT person_id, profile, label, value FROM person_items WHERE 1 = 1${cond}`, ...args)) {
      if (!ids.has(i.person_id)) continue;
      const key = scope.all ? `${i.profile}/${i.label}` : i.label;
      const col = free.get(key) ?? { count: 0, values: new Map() };
      col.count += 1;
      col.values.set(i.value, (col.values.get(i.value) ?? 0) + 1);
      free.set(key, col);
    }
    return {
      fixed: FIELDS,
      free: [...free].map(([label, c]) => ({
        label, count: c.count,
        values: [...c.values].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja', { numeric: true })).slice(0, COLUMN_VALUES).map(([v]) => v),
      })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    };
  }

  // The table of the scope (one row per person) and the memos there that wait for a person.
  // query: only those whose name, a name they go by, email, affiliation, role or a free column
  // contains it. where: { 列: text }: only those whose column contains the text (a fixed field by
  // its name, such as affiliation, or a free column, matched as labelKey); '' means "filled".
  function list(scope, { query, where } = {}) {
    checkScope(scope);
    let rows = rowsIn(scope).map((r) => summary(r, scope));
    if (!blank(query)) {
      const q = nameKey(query);
      rows = rows.filter((r) => [r.name, ...r.aliases, r.email, r.affiliation, r.role, ...Object.values(r.items)].some((v) => v && nameKey(v).includes(q)));
    }
    if (where !== undefined && where !== null) {
      if (typeof where !== 'object' || Array.isArray(where)) fail(['where は { 列: 含む文字 } の形です']);
      for (const [col, want] of Object.entries(where)) {
        if (typeof want !== 'string') fail([`where の ${col} は文字列です('' で、埋まっている人)`]);
        const value = (r) => {
          if (FIELDS.includes(col)) return col === 'aliases' ? r.aliases.join(' ') : r[col];
          const k = labelKey(col);
          const hit = Object.keys(r.items).find((l) => labelKey(scope.all ? l.split('/').pop() : l) === k);
          return hit ? r.items[hit] : null;
        };
        rows = rows.filter((r) => { const v = value(r); return v != null && v !== '' && nameKey(v).includes(nameKey(want)); });
      }
    }
    const [cond, args] = memoCond(scope);
    const waiting = all(`SELECT * FROM person_memos WHERE person_id IS NULL${cond} ORDER BY learned_on, id LIMIT ?`, ...args, PEOPLE_MAX);
    return {
      ...(scope.all ? {} : { profile: scope.profile }),
      columns: columns(scope),
      count: rows.length,
      people: rows.slice(0, PEOPLE_MAX),
      more: Math.max(0, rows.length - PEOPLE_MAX),
      unassigned: waiting.map((f) => memoView(f, scope)),
    };
  }

  function getPerson(id, scope) {
    return view(personRow(id, scope), scope);
  }

  // The people of the scope whose birthday comes within `within` days from today (the server's
  // date), soonest first: { id, name, birthday, on, in_days, turns (null without the year) }.
  function birthdays(scope, { within = 30 } = {}) {
    checkScope(scope);
    if (!Number.isInteger(within) || within < 0 || within > BIRTHDAYS_MAX_DAYS) fail([`birthdays_within は 0〜${BIRTHDAYS_MAX_DAYS} 日です`]);
    const n = now();
    const today = new Date(n.getFullYear(), n.getMonth(), n.getDate());
    const out = [];
    for (const r of rowsIn(scope)) {
      const m = r.birthday ? BIRTHDAY.exec(r.birthday) : null;
      if (!m) continue;
      const month = Number(m[2]);
      const day = Number(m[3]);
      const on = (y) => {
        const d = new Date(y, month - 1, day);
        return d.getMonth() === month - 1 ? d : new Date(y, 1, 28); // 02-29 in a common year
      };
      let date = on(today.getFullYear());
      if (date < today) date = on(today.getFullYear() + 1);
      const inDays = Math.round((date - today) / DAY_MS);
      if (inDays > within) continue;
      out.push({
        id: r.id, name: r.name, birthday: r.birthday, on: localDate(date), in_days: inDays,
        turns: m[1] ? date.getFullYear() - Number(m[1]) : null,
      });
    }
    return out.sort((a, b) => a.in_days - b.in_days || a.name.localeCompare(b.name));
  }

  // Puts `from` into `into` and forgets `from`: its name and the names it went by become names
  // `into` goes by, a field `into` lacks is taken from it, and its profiles, items (where `into`
  // has none of that label), memos and links move over. Returns the merged person and the
  // fields both had with different values (into's kept).
  function merge(intoId, fromId, scope, opts) {
    const w = requireWriter(opts);
    const into = personRow(intoId, scope);
    const from = personRow(fromId, scope);
    if (into.id === from.id) fail(['同じ人どうしはまとめられません']);
    return transaction(() => {
      const aliases = [...new Set([...JSON.parse(into.aliases), from.name, ...JSON.parse(from.aliases)])]
        .filter((a) => nameKey(a) !== nameKey(into.name)).slice(0, MAX_ALIASES);
      const kept = [];
      const filled = [];
      for (const f of ['email', 'phone', 'affiliation', 'role', 'birthday']) {
        if (from[f] === null) continue;
        if (into[f] === null) { db.prepare(`UPDATE people SET ${f} = ? WHERE id = ?`).run(from[f], into.id); filled.push(f); } else if (into[f] !== from[f]) kept.push(f);
      }
      db.prepare('UPDATE people SET aliases = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(aliases), nowIso(), into.id);
      db.prepare('INSERT OR IGNORE INTO person_profiles (person_id, profile) SELECT ?, profile FROM person_profiles WHERE person_id = ?').run(into.id, from.id);
      db.prepare('INSERT OR IGNORE INTO person_items (person_id, profile, label, value, updated_at) SELECT ?, profile, label, value, updated_at FROM person_items WHERE person_id = ?').run(into.id, from.id);
      db.prepare('UPDATE person_memos SET person_id = ? WHERE person_id = ?').run(into.id, from.id);
      db.prepare('INSERT OR IGNORE INTO person_links (person_id, kind, target_id, created_at) SELECT ?, kind, target_id, created_at FROM person_links WHERE person_id = ?').run(into.id, from.id);
      db.prepare('DELETE FROM people WHERE id = ?').run(from.id);
      recordPerson(w, into.id, 'merge', { from: from.id, filled, kept });
      recordPerson(w, from.id, 'merged', { into: into.id });
      return { person: view(one('SELECT * FROM people WHERE id = ?', into.id), scope), filled, kept_both: kept };
    });
  }

  // Forgets for good: the person (with all their items, memos and links, in every profile),
  // or the memos named. The rows are deleted and the write-ahead log emptied, so the values
  // stay only in backups taken before (until they are rotated out).
  function forget({ person, memos }, scope, opts) {
    const w = requireWriter(opts);
    checkScope(scope);
    const problems = [];
    const row = person === undefined ? null : personRow(person, scope);
    let rows = [];
    if (memos !== undefined) {
      const named = memosNamed(memos, scope, 'memos');
      problems.push(...named.problems);
      rows = named.rows;
    }
    if (!row && rows.length === 0 && problems.length === 0) problems.push('消す人(person)か、メモ(memos)を渡します');
    if (problems.length) fail(problems);
    const out = transaction(() => {
      let forgotMemos = 0;
      if (row) {
        forgotMemos = one('SELECT count(*) AS n FROM person_memos WHERE person_id = ?', row.id).n;
        db.prepare('DELETE FROM people WHERE id = ?').run(row.id);
        recordPerson(w, row.id, 'forget', { memos: forgotMemos });
      }
      const extra = rows.filter((f) => f.person_id !== row?.id);
      for (const f of extra) db.prepare('DELETE FROM person_memos WHERE id = ?').run(f.id);
      if (extra.length) recordPerson(w, row?.id ?? `profile:${scope.profile ?? '*'}`, 'forget_memos', { memos: extra.map((f) => f.id) });
      return { person: row ? row.id : null, memos: forgotMemos + extra.length };
    });
    // Outside the write: copy the log into the file and empty it, so deleted pages leave it.
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // An in-memory database has no log.
    }
    return out;
  }

  // How many people each profile has (for the screens' counts).
  function counts() {
    return Object.fromEntries(all('SELECT profile, count(*) AS n FROM person_profiles GROUP BY profile').map((r) => [r.profile, r.n]));
  }

  return { create, update, learn, match, list, columns, get: getPerson, birthdays, merge, forget, counts };
}
