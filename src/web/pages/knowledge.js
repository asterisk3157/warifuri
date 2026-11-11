// ナレッジ: on the left, the list of what to look at: 人, 生活リズム, よく行く場所, 曜日ごとの居場所
// and GitHub (the secretary's settings, changed on the spot in knowledge-secretary.js), then each
// profile, opened in place, with its 決まったこと (knowledge.md and knowledge/), 手順
// (procedures/) and 未整理のメモ (inbox.md). On the right, the one chosen.
//
// 人 is one table of the people of every profile. A person opens in place with everything
// about them, a guess (未確認) marked 推測; each value is changed on the spot with its pencil
// (POST /people/:id/edit, written as the person's words). With a person open, the round button
// opens a panel on the right to tell the secretary about them (POST /people/tell: the secretary
// is woken once, outside the conversation). The profile's files only show; changes go through
// the agents.

import { h, s, skel, profileColor } from '../ui.js';
import { renderMarkdown } from '../md.js';
import { settingsCard, settingsBusy, SETTINGS } from './knowledge-secretary.js';

// sel: 'people', one of SETTINGS, or 'profile' (with profile and part: knowledge | procedures |
// inbox). open: the profiles opened in the list. file: the file of knowledge/ or procedures/
// opened. person: the person opened in the table.
const view = { sel: 'people', profile: null, part: null, open: new Set(), file: null, person: null };

async function load(api) {
  const [list, rules] = await Promise.all([api('/knowledge'), api('/rules')]);
  if (view.sel === 'profile' && !list.profiles.some((p) => p.name === view.profile)) Object.assign(view, { sel: 'people', profile: null, part: null });
  let one = null;
  let file = null;
  if (view.sel === 'profile') {
    const base = `/knowledge/${encodeURIComponent(view.profile)}`;
    one = await api(base).catch(() => null);
    file = one && view.file ? await api(`${base}?name=${encodeURIComponent(view.file)}`).catch(() => null) : null;
  }
  return { list, rules, one, file };
}

// A note line as warifuri writes it: "- 2026-10-24 「本人の言葉」 text (device task)". Shown
// as the text with its date and who said it; the device stays out.
const NOTE = /^- (\d{4})-(\d{2})-(\d{2}) (?:「(本人の言葉|未確認)」 )?(.*?)(?: \([^()]*\))?$/;
const WHO = { 本人の言葉: 'ユーザーの言葉', 未確認: '推測' };

function notes(text) {
  const lines = text.split('\n').filter((l) => l.trim());
  const parsed = lines.map((l) => NOTE.exec(l.trim()));
  if (!parsed.every(Boolean)) return h('div', { class: 'wf-md wf-know-body' }, renderMarkdown(h, text));
  return h('ul', { class: 'wf-know-notes' }, ...parsed.reverse().map((m) => h('li', {},
    h('span', { class: 'wf-know-text', text: m[5] }),
    h('span', { class: 'wf-know-meta', text: [`${Number(m[2])}/${Number(m[3])}`, m[4] ? WHO[m[4]] : null].filter(Boolean).join(' · ') }))));
}

const memoMeta = (f) => {
  const [, mo, d] = /^\d{4}-(\d{2})-(\d{2})$/.exec(f.learned_on) ?? [];
  return [mo ? `${Number(mo)}/${Number(d)}` : null, f.profile].filter(Boolean).join(' · ');
};
const memoList = (memos) => h('ul', { class: 'wf-know-notes' }, ...memos.map((f) => h('li', {},
  h('span', { class: 'wf-know-text' }, f.kind ? h('span', { class: 'wf-know-kind', text: f.kind }) : null, f.text),
  h('span', { class: 'wf-know-meta', text: memoMeta(f) }))));

// ---- 左の一覧 ----

const chevron = (open) => s('svg', { 'aria-hidden': 'true', width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', class: 'wf-kn-chev', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
  s('path', { d: open ? 'M2.5 4.5 6 8l3.5-3.5' : 'M4.5 2.5 8 6 4.5 9.5' }));

function choose(ctx, sel, extra = {}) {
  Object.assign(view, { sel, profile: null, part: null, file: null, ...extra });
  ctx.refresh();
}

function navButton({ key, label, count, current, onclick, sub = false }) {
  return h('button', { type: 'button', class: ['wf-kn-item', sub && 'wf-kn-sub'], 'aria-current': current ? 'true' : null, data: { key }, onclick },
    h('span', { class: 'wf-kn-label', text: label }), count ? h('span', { class: 'wf-kn-count', text: count }) : null);
}

const TOP = [['people', '人'], ['life', '生活リズム'], ['places', 'よく行く場所'], ['week', '曜日ごとの居場所'], ['github', 'GitHub']];
const PARTS = [['knowledge', '決まったこと'], ['procedures', '手順'], ['inbox', '未整理のメモ']];

function topCount(key, rules) {
  const n = { people: rules.people.count, life: rules.life.rules.length, places: rules.places.places.length, week: rules.week.slots.length, github: rules.github.owners.length }[key];
  return n ? String(n) : '';
}

function partCount(part, p) {
  if (part === 'knowledge') return p.knowledge ? `${p.knowledge}行` : p.topics ? `${p.topics}件` : '';
  const n = part === 'procedures' ? p.procedures : p.inbox;
  return n ? String(n) : '';
}

function sideList(list, rules, ctx) {
  const top = TOP.map(([key, label]) => navButton({ key: `kn-${key}`, label, count: topCount(key, rules), current: view.sel === key, onclick: () => choose(ctx, key) }));
  const profiles = list.profiles.flatMap((p) => {
    const open = view.open.has(p.name);
    const head = h('button', {
      type: 'button', class: 'wf-kn-item wf-kn-profile', 'aria-expanded': String(open), data: { key: `kn-profile-${p.name}` },
      onclick: () => { if (open) view.open.delete(p.name); else view.open.add(p.name); ctx.rerender(); },
    }, chevron(open), h('span', { class: 'wf-dot', style: { background: profileColor(p.name, list.colors) }, 'aria-hidden': 'true' }), h('span', { class: 'wf-kn-label', text: p.name }));
    if (!open) return [head];
    return [head, h('div', { class: 'wf-kn-parts' }, ...PARTS.map(([part, label]) => navButton({
      key: `kn-${p.name}-${part}`, label, count: partCount(part, p), sub: true,
      current: view.sel === 'profile' && view.profile === p.name && view.part === part,
      onclick: () => choose(ctx, 'profile', { profile: p.name, part }),
    })))];
  });
  return h('nav', { class: 'wf-kn-side', 'aria-label': 'ナレッジの種類', data: { scroll: 'kn-side' } },
    ...top, h('div', { class: 'wf-kn-divider', text: 'プロフィール' }), ...profiles);
}

// ---- 人 ----

// Search, filter and order are kept per screen, not on the server.
const people = { query: '', affiliation: '', sort: 'name', desc: false };
const FIXED = ['name', 'aliases', 'affiliation', 'role', 'email', 'phone', 'birthday'];
const LABELS = { name: '名前', aliases: '呼び名', affiliation: '所属', role: '役職・担当', email: 'メール', phone: '電話', birthday: '誕生日', profiles: 'プロフィール' };
const MD = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/;
const birthdayText = (b) => {
  const m = MD.exec(b ?? '');
  return m ? `${m[1] ? `${m[1]}年` : ''}${Number(m[2])}月${Number(m[3])}日` : (b ?? '');
};
const fieldText = (p, f) => (f === 'aliases' ? p.aliases.join('、') : f === 'profiles' ? (p.profiles ?? []).join('、') : f === 'birthday' ? birthdayText(p.birthday) : p[f] ?? '');
const affiliationRole = (p) => [p.affiliation, p.role].filter(Boolean).join('・');
// The day of the latest memo, as 11月9日 (the year too when it is not this year).
const lastMemo = (p) => p.memos.reduce((a, m) => (m.learned_on > a ? m.learned_on : a), '');
function dayText(ymd, now) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return '';
  return `${Number(m[1]) === now.getFullYear() ? '' : `${m[1]}年`}${Number(m[2])}月${Number(m[3])}日`;
}

const COLS = [['name', '名前'], ['profiles', 'プロフィール'], ['affiliation', '所属・役職'], ['last', '最後に話したこと']];
const sortKey = (p) => (people.sort === 'last' ? lastMemo(p) : people.sort === 'profiles' ? (p.profiles ?? []).join('、') : people.sort === 'affiliation' ? affiliationRole(p) : p.name);

const chips = (names) => h('span', { class: 'wf-kn-chips' }, ...(names ?? []).map((n) => h('span', { class: 'wf-kn-chip', text: n })));
const callName = (name) => (/(さん|先生|様|さま|くん|君|ちゃん|氏)$/.test(name) ? name : `${name}さん`);
const line = (d) => s('path', { d });
const svg = (size, width, ...paths) => s('svg', { 'aria-hidden': 'true', width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, ...paths);
const pencilIcon = () => svg(15, 1.5, line('M10.5 2.5l3 3L6 13H3v-3z'));
const crossIcon = (size = 15) => svg(size, 1.6, line('M4 4l8 8M12 4l-8 8'));
const checkIcon = () => svg(15, 1.8, line('M3.5 8.5l3 3 6-7'));

// What each value of every person is, by key, to tell after the secretary wrote which ones
// changed: f:id:field, i:id:profile:label, m:id:memo.
function snapshot(list) {
  const out = new Map();
  for (const p of list) {
    const guessed = new Set(p.unverified ?? []);
    for (const f of [...FIXED, 'profiles']) out.set(`f:${p.id}:${f}`, `${fieldText(p, f)}|${guessed.has(f)}`);
    for (const i of p.items) out.set(`i:${p.id}:${i.profile}:${i.label}`, `${i.value}|${Boolean(i.unverified)}`);
    for (const m of p.memos) out.set(`m:${p.id}:${m.id}`, `${m.kind}|${m.text}|${m.mark}`);
  }
  return out;
}
// The values the secretary just changed (keys, and the ids of their people), shown for a while.
const fresh = { keys: new Set(), people: new Set(), timer: null };
const FRESH_MS = 6000;
function markFresh(before, after, ctx) {
  fresh.keys.clear();
  fresh.people.clear();
  for (const [k, v] of after) {
    if (before.get(k) === v || (!before.has(k) && v.startsWith('|'))) continue; // an empty field is not news
    fresh.keys.add(k);
    fresh.people.add(k.split(':')[1]);
  }
  clearTimeout(fresh.timer);
  fresh.timer = setTimeout(() => { fresh.keys.clear(); fresh.people.clear(); ctx.rerender(); }, FRESH_MS);
}
const freshNote = (key) => (fresh.keys.has(key) ? h('span', { class: 'wf-kn-fresh-note', text: '今 更新' }) : null);

// ---- 人の詳細と、その場で直す ----

// The one value being changed: { key, target, input, busy, problem }. The input is kept across
// redraws, so what is typed stays.
let editing = null;

function startEdit(ctx, p, key, target, value) {
  if (editing?.busy) return;
  const input = h('input', {
    type: 'text', class: 'wf-kn-edit-input', maxlength: '4000', data: { key: `edit-${key}` }, 'aria-label': `${target.what}を直す`,
    onkeydown: (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); saveEdit(ctx); } else if (e.key === 'Escape') { e.preventDefault(); stopEdit(ctx); }
    },
  });
  input.value = value;
  editing = { key, person: p.id, target, input, before: value, guess: target.guess, busy: false, problem: null };
  ctx.rerender();
  input.focus();
  input.select();
}

function stopEdit(ctx) {
  const key = editing?.key;
  editing = null;
  ctx.rerender();
  if (key) document.querySelector(`[data-key="${CSS.escape(`pen-${key}`)}"]`)?.focus();
}

async function saveEdit(ctx) {
  if (!editing || editing.busy) return;
  const value = editing.input.value.trim();
  if (value === editing.before && !editing.guess) { stopEdit(ctx); return; }
  editing.busy = true;
  editing.problem = null;
  ctx.rerender();
  try {
    await ctx.api(`/people/${encodeURIComponent(editing.person)}/edit`, { method: 'POST', body: { ...editing.target.body, value } });
    const key = editing.key;
    editing = null;
    await ctx.refresh();
    document.querySelector(`[data-key="${CSS.escape(`pen-${key}`)}"]`)?.focus();
  } catch (err) {
    editing.busy = false;
    editing.problem = err.body?.problems?.join(' ') ?? '保存できませんでした';
    ctx.rerender();
    editing.input.focus();
  }
}

const guessMark = () => h('span', { class: 'wf-kn-guess', text: '推測' });

// One line of the detail: the label (none for a memo), the value, and the pencil; or, while it
// is being changed, the input with ✕ and ✓.
function detailLine(ctx, p, { key, label, value, empty = false, guess = false, meta = null, edit = null, what }) {
  const labelCell = label === null ? null : h('span', { class: 'wf-kn-line-label' }, ...[label].flat());
  const cls = ['wf-kn-line', label === null && 'wf-kn-line-wide', fresh.keys.has(key) && 'wf-kn-fresh'];
  if (editing?.key === key) {
    editing.input.disabled = editing.busy;
    return h('div', { class: [...cls, 'wf-kn-line-editing'] }, labelCell,
      h('span', { class: 'wf-kn-edit' }, editing.input,
        h('button', { type: 'button', class: 'wf-kn-icon', 'aria-label': 'やめる', title: 'やめる', disabled: editing.busy, onclick: () => stopEdit(ctx) }, crossIcon()),
        h('button', { type: 'button', class: 'wf-kn-icon wf-kn-icon-main', 'aria-label': '保存', title: '保存', disabled: editing.busy, onclick: () => saveEdit(ctx) }, checkIcon())),
      editing.problem ? h('p', { class: 'wf-kn-problem wf-kn-line-problem', role: 'alert', text: editing.problem }) : null);
  }
  return h('div', { class: cls }, labelCell,
    h('span', { class: ['wf-kn-line-value', empty && 'wf-ptable-blank'] },
      h('span', { class: 'wf-kn-line-text' }, ...[value].flat()), guess ? guessMark() : null, freshNote(key),
      meta ? h('span', { class: 'wf-kn-line-meta', text: meta }) : null),
    edit ? h('button', {
      type: 'button', class: 'wf-kn-icon', 'aria-label': `${what}を直す`, title: `${what}を直す`, disabled: Boolean(editing?.busy), data: { key: `pen-${key}` },
      onclick: () => startEdit(ctx, p, key, { body: edit.body, what, guess }, edit.value),
    }, pencilIcon()) : h('span'));
}

const KINDS = ['やりとり', '接し方', 'その他'];
const LINK_WORDS = { goal: 'ゴール', task: 'タスク', booking: '予定' };
const memoLine = (m, many) => [(() => {
  const [, mo, d] = /^\d{4}-(\d{2})-(\d{2})$/.exec(m.learned_on) ?? [];
  return mo ? `${Number(mo)}/${Number(d)}` : null;
})(), many ? m.profile : null, m.source, m.mark === '本人の言葉' ? 'ユーザーの言葉' : null].filter(Boolean).join(' · ');

// Everything about the person, each value with its pencil: the fixed columns, the profiles,
// the items of each profile, the memos by kind and the links. A guess is marked 推測.
function personDetail(p, ctx) {
  const guessed = new Set(p.unverified ?? []);
  const many = (p.profiles ?? []).length > 1;
  const lines = [];
  for (const f of FIXED) {
    const v = fieldText(p, f);
    lines.push(detailLine(ctx, p, {
      key: `f:${p.id}:${f}`, label: LABELS[f], value: v || '—', empty: !v, guess: guessed.has(f), what: LABELS[f],
      edit: { value: v, body: { field: f } },
    }));
  }
  lines.push(detailLine(ctx, p, {
    key: `f:${p.id}:profiles`, label: LABELS.profiles, value: chips(p.profiles), what: LABELS.profiles,
    edit: { value: fieldText(p, 'profiles'), body: { field: 'profiles' } },
  }));
  for (const i of p.items) {
    lines.push(detailLine(ctx, p, {
      key: `i:${p.id}:${i.profile}:${i.label}`, label: i.label, value: i.value, guess: Boolean(i.unverified), meta: many ? i.profile : null, what: i.label,
      edit: { value: i.value, body: { item: { label: i.label, profile: i.profile } } },
    }));
  }
  const groups = KINDS.map((k) => [k, p.memos.filter((m) => (m.kind ?? 'その他') === k)]).filter(([, l]) => l.length);
  for (const [k, list] of groups) {
    lines.push(h('h3', { class: 'wf-kn-line-head', text: k }));
    for (const m of list) {
      lines.push(detailLine(ctx, p, {
        key: `m:${p.id}:${m.id}`, label: null, value: m.text, guess: m.mark === '未確認', meta: memoLine(m, many), what: k,
        edit: { value: m.text, body: { memo: m.id } },
      }));
    }
  }
  if (p.links?.length) {
    lines.push(h('h3', { class: 'wf-kn-line-head', text: 'つながり' }));
    for (const l of p.links) lines.push(detailLine(ctx, p, { key: `l:${p.id}:${l.kind}:${l.id}`, label: null, value: `${LINK_WORDS[l.kind]}: ${l.title}` }));
  }
  return h('div', { class: 'wf-kn-detail' }, ...lines);
}

function choosePerson(ctx, id) {
  if (editing && !editing.busy) editing = null;
  view.person = id;
  ctx.rerender();
}

function personRow(p, ctx, stripe) {
  const last = lastMemo(p);
  return h('button', {
    type: 'button', class: ['wf-kn-row', 'wf-kn-rowbtn', stripe && 'wf-kn-stripe', fresh.people.has(p.id) && 'wf-kn-fresh'], 'aria-expanded': 'false', data: { key: `person-${p.id}` },
    onclick: () => choosePerson(ctx, p.id),
  },
  h('span', { class: 'wf-kn-name' }, p.name, fresh.people.has(p.id) ? h('span', { class: 'wf-kn-fresh-note', text: '今 更新' }) : null),
  chips(p.profiles),
  h('span', { class: ['wf-kn-sub-text', !affiliationRole(p) && 'wf-ptable-blank'], text: affiliationRole(p) || '—' }),
  h('span', { class: ['wf-kn-day', !last && 'wf-ptable-blank'], text: last ? dayText(last, ctx.now) : '—' }),
  chevron(false));
}

function openPerson(p, ctx) {
  return h('div', { class: 'wf-kn-open' },
    h('button', { type: 'button', class: 'wf-kn-open-head', 'aria-expanded': 'true', data: { key: `person-${p.id}` }, onclick: () => choosePerson(ctx, null) },
      h('span', { class: 'wf-kn-open-name', text: p.name }), chips(p.profiles), h('span', { class: 'wf-kn-open-fill' }), chevron(true)),
    personDetail(p, ctx));
}

function peoplePane(rules, ctx) {
  const list = rules.people.people;
  const q = people.query.trim().toLowerCase();
  let rows = list.filter((p) => (!people.affiliation || p.affiliation === people.affiliation) &&
    (!q || [p.name, ...p.aliases, ...(p.profiles ?? []), p.email, p.phone, p.affiliation, p.role, ...p.items.map((i) => i.value), ...p.memos.map((m) => m.text)]
      .some((v) => v && v.toLowerCase().includes(q))));
  rows = rows.slice().sort((a, b) => {
    const x = sortKey(a);
    const y = sortKey(b);
    if ((x === '') !== (y === '')) return x === '' ? 1 : -1; // blanks last, either way
    const c = String(x).localeCompare(String(y), 'ja', { numeric: true });
    return (people.desc ? -c : c) || a.name.localeCompare(b.name, 'ja');
  });
  const affiliations = [...new Set(list.map((p) => p.affiliation).filter(Boolean))].sort((x, y) => x.localeCompare(y, 'ja'));
  const sortBy = (k) => () => { if (people.sort === k) people.desc = !people.desc; else { people.sort = k; people.desc = k === 'last'; } ctx.rerender(); };
  const head = h('div', { class: 'wf-kn-row wf-kn-headrow' }, ...COLS.map(([k, label]) => h('span', { 'aria-sort': people.sort === k ? (people.desc ? 'descending' : 'ascending') : 'none' },
    h('button', { type: 'button', class: 'wf-ptable-sort', data: { key: `sort-${k}` }, onclick: sortBy(k) },
      label, h('span', { class: 'wf-ptable-arrow', 'aria-hidden': 'true', text: people.sort === k ? (people.desc ? '▼' : '▲') : '' }))), h('span')));
  const body = rows.map((p, i) => (view.person === p.id ? openPerson(p, ctx) : personRow(p, ctx, i % 2 === 1)));
  const waiting = rules.people.unassigned ?? [];
  return [
    h('div', { class: 'wf-kn-head' }, h('h2', { text: '人' }),
      h('input', {
        type: 'search', class: 'wf-ptable-search wf-kn-search', placeholder: '名前、所属で探す', value: people.query, 'aria-label': '人を探す', data: { key: 'people-search' },
        oninput: (e) => { people.query = e.target.value; ctx.rerender(); },
      })),
    h('div', { class: 'wf-ptable-tools' },
      h('select', {
        class: 'wf-ptable-select', 'aria-label': '所属で絞り込む', data: { key: 'people-affiliation' }, disabled: affiliations.length === 0,
        onchange: (e) => { people.affiliation = e.target.value; ctx.rerender(); },
      }, h('option', { value: '', text: 'すべての所属', selected: people.affiliation === '' }),
      ...affiliations.map((a) => h('option', { value: a, text: a, selected: people.affiliation === a }))),
      h('span', { class: 'wf-ptable-count', text: `${rows.length} / ${list.length}人` })),
    list.length
      ? h('div', { class: 'wf-kn-table', role: 'group', 'aria-label': '人の一覧' }, head, ...body)
      : h('div', { class: 'wf-know-empty', text: 'まだいません' }),
    list.length && !rows.length ? h('div', { class: 'wf-know-empty', text: '当てはまる人はいません' }) : null,
    waiting.length ? h('div', { class: 'wf-know-sub' }, h('h3', { text: 'だれのことか決まっていないメモ' }), memoList(waiting)) : null,
  ];
}

// ---- 秘書と話す欄 ----

// The panel on the right where the person talks to the secretary about the person opened. The
// round button at the bottom right opens it, and the page narrows by its width. What is said is
// kept per person while the screen is open, not in the ledger. Each send is POST /people/tell
// with the opened person's id (names in the text reach other people too). The panel and the
// button sit outside the page, so they are not drawn again with it.
const talk = { open: false, logs: new Map(), busy: null };
let panel = null;
let current = [];

function panelParts(ctx) {
  if (panel) return panel;
  const input = h('textarea', {
    id: 'kn-talk', class: 'wf-kn-talk-input', rows: '2', maxlength: '2000',
    onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(ctx); } },
  });
  const label = h('label', { for: 'kn-talk', class: 'wf-kn-hidden' });
  const sendBtn = h('button', { type: 'button', class: 'wf-kn-send', 'aria-label': '送る', title: '送る', onclick: () => send(ctx) },
    s('svg', { 'aria-hidden': 'true', width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, s('path', { d: 'M12 19V5M5 12l7-7 7 7' })));
  const title = h('h2', { class: 'wf-kn-drawer-title', id: 'kn-talk-title' });
  const log = h('div', { class: 'wf-kn-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'やりとり' });
  const fab = h('button', { type: 'button', class: 'wf-kn-fab', hidden: true, onclick: () => { talk.open = true; ctx.rerender(); input.focus(); } },
    s('svg', { 'aria-hidden': 'true', width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
      s('path', { d: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z' })));
  const close = h('button', { type: 'button', class: 'wf-kn-icon wf-kn-drawer-close', 'aria-label': '閉じる', title: '閉じる', onclick: () => { talk.open = false; ctx.rerender(); fab.focus(); } }, crossIcon(16));
  const drawer = h('aside', { class: 'wf-kn-drawer', 'aria-labelledby': 'kn-talk-title', inert: true },
    h('div', { class: 'wf-kn-drawer-in' },
      h('div', { class: 'wf-kn-drawer-head' }, title, close),
      log,
      h('div', { class: 'wf-kn-composer' }, label, input, sendBtn)));
  (document.querySelector('.wf-root') ?? document.body).append(drawer);
  document.body.append(fab);
  panel = { drawer, fab, input, label, sendBtn, title, log };
  return panel;
}

async function send(ctx) {
  const id = view.person;
  const text = panel.input.value.trim();
  if (!id || !text || talk.busy) return;
  const log = talk.logs.get(id) ?? [];
  talk.logs.set(id, log);
  log.push({ who: 'me', text });
  panel.input.value = '';
  talk.busy = id;
  const before = snapshot(current);
  ctx.rerender();
  try {
    const out = await ctx.api('/people/tell', { method: 'POST', body: { text, person: id } });
    log.push({ who: 'secretary', text: out.said });
    markFresh(before, snapshot(out.people.people), ctx);
  } catch (err) {
    log.push({ who: 'problem', text: err.body?.problems?.join(' ') ?? '登録できませんでした' });
  }
  talk.busy = null;
  ctx.rerender();
  ctx.refresh();
}

function drawPanel(ctx, rules) {
  const p = panelParts(ctx);
  const person = view.sel === 'people' ? rules.people.people.find((x) => x.id === view.person) : null;
  const open = Boolean(person) && talk.open;
  p.drawer.classList.toggle('wf-kn-drawer-open', open);
  p.drawer.inert = !open;
  p.drawer.parentElement?.classList.toggle('wf-kn-talking', open);
  p.fab.hidden = !person || open;
  if (!person) return;
  const who = callName(person.name);
  p.fab.setAttribute('aria-label', `${who}について秘書と話す`);
  p.fab.title = `${who}について秘書と話す`;
  p.title.textContent = `${who}について話す`;
  p.label.textContent = `${who}のことを書く`;
  p.input.placeholder = `${who}のことを書く`;
  const log = talk.logs.get(person.id) ?? [];
  const atEnd = p.log.scrollHeight - p.log.scrollTop - p.log.clientHeight < 8;
  p.log.replaceChildren(...log.map((m) => (m.who === 'me'
    ? h('div', { class: 'wf-kn-me', text: m.text })
    : m.who === 'secretary'
      ? h('div', { class: 'wf-kn-sec' }, h('span', { class: 'wf-kn-said-head', text: '秘書がこう登録しました' }), h('span', { class: 'wf-kn-said-text', text: m.text }))
      : h('div', { class: 'wf-kn-sec' }, h('span', { class: 'wf-kn-problem', text: m.text })))),
  ...(talk.busy === person.id ? [h('div', { class: 'wf-kn-sec wf-kn-typing', role: 'status' }, h('span', { class: 'wf-kn-hidden', text: '登録しています' }), h('span', { class: 'wf-kn-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')))] : []));
  if (atEnd || talk.busy) p.log.scrollTop = p.log.scrollHeight;
  p.sendBtn.disabled = Boolean(talk.busy);
}

// ---- プロフィールのファイル ----

function filesList(names, file, ctx) {
  return names.map((n) => h('div', { class: 'wf-know-file' },
    h('button', { type: 'button', class: 'wf-know-name', 'aria-expanded': String(view.file === n), data: { key: `file-${n}` }, onclick: () => { view.file = view.file === n ? null : n; ctx.refresh(); }, text: n.replace(/^(knowledge|procedures)\//, '').replace(/\.md$/, '') }),
    view.file === n && file?.text ? h('div', { class: 'wf-md wf-know-body' }, renderMarkdown(h, file.text)) : null));
}

function fileText(f) {
  if (!f?.text?.trim()) return null;
  return [notes(f.text), f.truncated ? h('p', { class: 'wf-muted', text: '長いため、途中までを表示しています' }) : null];
}

function profilePane(one, file, list, ctx) {
  const label = PARTS.find(([k]) => k === view.part)?.[1] ?? '';
  const head = h('div', { class: 'wf-kn-head' }, h('h2', { text: label }),
    h('span', { class: 'wf-pchip' }, h('span', { class: 'wf-dot', style: { background: profileColor(view.profile, list.colors) }, 'aria-hidden': 'true' }), view.profile));
  if (!one) return [head, h('div', { class: 'wf-know-empty', text: 'まだありません' })];
  let body = [];
  if (view.part === 'knowledge') {
    const topics = one.files.knowledge ?? [];
    body = [fileText(one.knowledge), topics.length ? h('div', { class: 'wf-know-sub' }, h('h3', { text: '話題ごと' }), ...filesList(topics, file, ctx)) : null];
  } else if (view.part === 'procedures') {
    body = filesList(one.files.procedures ?? [], file, ctx);
  } else {
    const waiting = one.people?.unassigned ?? [];
    const old = one.people_md?.text?.trim() ? one.people_md : null;
    body = [fileText(one.inbox),
      waiting.length ? h('div', { class: 'wf-know-sub' }, h('h3', { text: 'だれのことか決まっていないメモ' }), memoList(waiting.map((m) => ({ ...m, profile: null })))) : null,
      old ? h('div', { class: 'wf-know-sub' }, h('h3', { text: '取り込む前の人のメモ' }), notes(old.text)) : null];
  }
  const filled = body.flat(Infinity).filter(Boolean);
  return [head, ...(filled.length ? filled : [h('div', { class: 'wf-know-empty', text: 'まだありません' })])];
}

// ---- 全体 ----

function render(data, ctx) {
  const { list, rules, one, file } = data;
  const key = view.sel === 'profile' ? `${view.profile}-${view.part}` : view.sel;
  const right = view.sel === 'people' ? peoplePane(rules, ctx) : SETTINGS.includes(view.sel) ? [settingsCard(ctx, rules, view.sel)] : profilePane(one, file, list, ctx);
  const main = h('section', { class: 'wf-tasklist wf-kn-main', 'aria-label': 'ナレッジ', data: { scroll: `know-${key}` } }, ...right);
  current = rules.people.people;
  drawPanel(ctx, rules);
  return h('div', { class: 'wf-page-tasks' }, ctx.head('ナレッジ'), ctx.banner(),
    h('div', { class: 'wf-tasks-body' }, sideList(list, rules, ctx), main));
}

function skeleton(ctx) {
  const row = () => h('div', { class: 'wf-kn-item' }, skel('60%', '15px'));
  return h('div', { class: 'wf-page-tasks' }, ctx.head('ナレッジ'), ctx.banner(),
    h('div', { class: 'wf-tasks-body', 'aria-busy': 'true' },
      h('nav', { class: 'wf-kn-side' }, row(), row(), row(), row(), row()),
      h('section', { class: 'wf-tasklist' }, skel('30%', '22px'), skel('100%', '240px', { borderRadius: '10px' }))));
}

// While a write is going, the screen is not read again under it.
const busy = () => settingsBusy() || Boolean(editing) || Boolean(talk.busy);

export default { load, render, skeleton, busy };
