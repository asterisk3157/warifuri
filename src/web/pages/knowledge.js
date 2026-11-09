// ナレッジ: each profile's people (one entry per person, from the ledger), knowledge and inbox,
// and the files split out of them. It only shows: changes go through the agents (note,
// person), as everything else on these screens.

import { h, skel, profileChip } from '../ui.js';
import { renderMarkdown } from '../md.js';

const view = { profile: null, open: null, file: null, person: null };

async function load(api) {
  const list = await api('/knowledge');
  if (view.profile === null || !list.profiles.some((p) => p.name === view.profile)) {
    view.profile = (list.profiles.find((p) => p.people + p.knowledge + p.inbox + p.files > 0) ?? list.profiles[0])?.name ?? null;
  }
  const one = view.profile === null ? null : await api(`/knowledge/${encodeURIComponent(view.profile)}`);
  const file = one && view.open ? await api(`/knowledge/${encodeURIComponent(view.profile)}?name=${encodeURIComponent(view.open)}`).catch(() => null) : null;
  return { list, one, file };
}

const count = (p) => p.people + p.knowledge + p.inbox + p.files;

// A note line as warifuri writes it: "- 2026-10-24 「本人の言葉」 text (device task)". Shown
// as the text with its date and who said it; the device stays out.
const NOTE = /^- (\d{4})-(\d{2})-(\d{2}) (?:「(本人の言葉|未確認)」 )?(.*?)(?: \([^()]*\))?$/;
const WHO = { 本人の言葉: 'ユーザーの言葉', 未確認: '未確認' };

function notes(text) {
  const lines = text.split('\n').filter((l) => l.trim());
  const parsed = lines.map((l) => NOTE.exec(l.trim()));
  if (!parsed.every(Boolean)) return h('div', { class: 'wf-md wf-know-body' }, renderMarkdown(h, text));
  return h('ul', { class: 'wf-know-notes' }, ...parsed.reverse().map((m) => h('li', {},
    h('span', { class: 'wf-know-text', text: m[5] }),
    h('span', { class: 'wf-know-meta', text: [`${Number(m[2])}/${Number(m[3])}`, m[4] ? WHO[m[4]] : null].filter(Boolean).join(' · ') }))));
}

function profileButton(p, colors, ctx) {
  return h('button', {
    type: 'button', class: 'wf-goal-btn', 'aria-pressed': String(view.profile === p.name), data: { key: `profile-${p.name}` },
    onclick: () => { view.profile = p.name; view.open = null; view.person = null; people.query = ''; people.affiliation = ''; ctx.refresh(); },
  },
  h('span', { class: 'wf-goal-top' }, profileChip(p.name, colors, 15)),
  h('span', { class: 'wf-goal-meta', text: count(p) ? [p.people && `人 ${p.people}`, p.knowledge && `ナレッジ ${p.knowledge}`, p.inbox && `受信箱 ${p.inbox}`, p.files && `手順 ${p.files}`].filter(Boolean).join(' · ') : 'まだありません' }));
}

// One file of the profile; always shown, with まだありません when it is empty.
function section(title, file) {
  const has = Boolean(file?.text?.trim());
  return h('section', { class: 'wf-know-sec' },
    h('div', { class: 'wf-group-head' }, h('h2', { text: title })),
    has ? notes(file.text) : h('div', { class: 'wf-know-empty', text: 'まだありません' }),
    has && file.truncated ? h('p', { class: 'wf-muted', text: '長いため、途中までを表示しています' }) : null);
}

const MD = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/;
const birthdayText = (b) => {
  const m = MD.exec(b ?? '');
  return m ? `${m[1] ? `${m[1]}年` : ''}${Number(m[2])}月${Number(m[3])}日` : (b ?? '');
};
// Days from today to the next birthday (for sorting), or Infinity without one.
function daysToBirthday(b, now) {
  const m = MD.exec(b ?? '');
  if (!m) return Infinity;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let d = new Date(today.getFullYear(), Number(m[2]) - 1, Number(m[3]));
  if (d < today) d = new Date(today.getFullYear() + 1, Number(m[2]) - 1, Number(m[3]));
  return Math.round((d - today) / 86400000);
}
const memoMeta = (f) => {
  const [, mo, d] = /^\d{4}-(\d{2})-(\d{2})$/.exec(f.learned_on) ?? [];
  return [mo ? `${Number(mo)}/${Number(d)}` : null, f.mark ? WHO[f.mark] : null].filter(Boolean).join(' · ');
};
const memoList = (memos) => h('ul', { class: 'wf-know-notes' }, ...memos.map((f) => h('li', {},
  h('span', { class: 'wf-know-text' }, f.kind ? h('span', { class: 'wf-know-kind', text: f.kind }) : null, f.text),
  h('span', { class: 'wf-know-meta', text: memoMeta(f) }))));

// The table of people, always drawn by the same rules, whatever is filled in:
// - the columns are the fixed ones, all of them, in one order (名前, 所属, 役職・担当, メール,
//   電話, 誕生日), then the profile's free columns (the most filled first), then メモ;
// - an empty cell is a faint —, never a missing column;
// - a birthday is month/day, with the age when the year is known;
// - a long value is cut with … (the whole of it on hover and in the opened row);
// - the name stays put while the table scrolls sideways;
// - the search, the 所属 filter and the count are always there.
// Search, filter and order are kept per screen, not on the server.
const people = { query: '', affiliation: '', sort: 'name', desc: false };
const FIXED = [['name', '名前'], ['affiliation', '所属'], ['role', '役職・担当'], ['email', 'メール'], ['phone', '電話'], ['birthday', '誕生日']];
const KINDS = ['やりとり', '接し方', 'その他'];
// Month/day, and the age today when the year is known: 11/20 or 3/2(22歳).
function birthdayCell(b, now) {
  const m = MD.exec(b ?? '');
  if (!m) return '';
  const md = `${Number(m[2])}/${Number(m[3])}`;
  if (!m[1]) return md;
  const had = now.getMonth() + 1 > Number(m[2]) || (now.getMonth() + 1 === Number(m[2]) && now.getDate() >= Number(m[3]));
  return `${md}(${now.getFullYear() - Number(m[1]) - (had ? 0 : 1)}歳)`;
}

function cell(p, key, now = new Date()) {
  if (key === 'birthday') return birthdayCell(p.birthday, now);
  if (key.startsWith('item:')) return p.items.find((i) => i.label === key.slice(5))?.value ?? '';
  return p[key] ?? '';
}

function peopleTable(list, ctx) {
  const filled = new Map();
  for (const p of list) for (const i of p.items) filled.set(i.label, (filled.get(i.label) ?? 0) + 1);
  const labels = [...filled].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0], 'ja')).map(([l]) => l);
  const cols = [...FIXED, ...labels.map((l) => [`item:${l}`, l]), ['memos', 'メモ']];
  const q = people.query.trim().toLowerCase();
  let rows = list.filter((p) => (!people.affiliation || p.affiliation === people.affiliation) &&
    (!q || [p.name, ...p.aliases, p.email, p.phone, p.affiliation, p.role, ...p.items.map((i) => i.value), ...p.memos.map((m) => m.text)]
      .some((v) => v && v.toLowerCase().includes(q))));
  const key = (p) => (people.sort === 'memos' ? p.memos.length : people.sort === 'birthday' ? daysToBirthday(p.birthday, ctx.now) : cell(p, people.sort));
  rows = rows.slice().sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const empty = (v) => v === '' || v === Infinity;
    if (empty(x) !== empty(y)) return empty(x) ? 1 : -1; // blanks last, either way
    const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'ja', { numeric: true });
    return (people.desc ? -c : c) || a.name.localeCompare(b.name, 'ja');
  });
  const affiliations = [...new Set(list.map((p) => p.affiliation).filter(Boolean))].sort((x, y) => x.localeCompare(y, 'ja'));
  const sortBy = (k) => () => { if (people.sort === k) people.desc = !people.desc; else { people.sort = k; people.desc = false; } ctx.rerender(); };
  const head = h('tr', {}, ...cols.map(([k, label]) => h('th', { scope: 'col', class: `wf-pcol-${k === 'name' || k === 'memos' ? k : k.startsWith('item:') ? 'item' : 'fixed'}`, 'aria-sort': people.sort === k ? (people.desc ? 'descending' : 'ascending') : 'none' },
    h('button', { type: 'button', class: 'wf-ptable-sort', title: k === 'birthday' ? '次の誕生日が近い順' : null, data: { key: `sort-${k}` }, onclick: sortBy(k) },
      label, h('span', { class: 'wf-ptable-arrow', 'aria-hidden': 'true', text: people.sort === k ? (people.desc ? '▼' : '▲') : '' })))));
  const body = rows.flatMap((p) => {
    const open = view.person === p.id;
    const toggle = () => { view.person = open ? null : p.id; ctx.rerender(); };
    const tr = h('tr', { class: open ? 'wf-ptable-open' : '' }, ...cols.map(([k]) => {
      if (k === 'name') {
        return h('th', { scope: 'row', class: 'wf-pcol-name' }, h('button', { type: 'button', class: 'wf-ptable-name', 'aria-expanded': String(open), data: { key: `person-${p.id}` }, onclick: toggle, text: p.name }));
      }
      if (k === 'memos') return h('td', { class: 'wf-pcol-memos', text: p.memos.length ? String(p.memos.length) : '—' });
      const v = cell(p, k, ctx.now);
      return h('td', { class: v ? '' : 'wf-ptable-blank', title: v && v.length > 12 ? v : null, text: v || '—' });
    }));
    if (!open) return [tr];
    return [tr, h('tr', { class: 'wf-ptable-detail' }, h('td', { colspan: String(cols.length) }, personDetail(p)))];
  });
  return h('div', { class: 'wf-ptable-wrap' },
    h('div', { class: 'wf-ptable-tools' },
      h('input', {
        type: 'search', class: 'wf-ptable-search', placeholder: '名前、所属、メモで探す', value: people.query, 'aria-label': '人を探す', data: { key: 'people-search' },
        oninput: (e) => { people.query = e.target.value; ctx.rerender(); },
      }),
      h('select', {
        class: 'wf-ptable-select', 'aria-label': '所属で絞る', data: { key: 'people-affiliation' }, disabled: affiliations.length === 0,
        onchange: (e) => { people.affiliation = e.target.value; ctx.rerender(); },
      }, h('option', { value: '', text: '所属: すべて', selected: people.affiliation === '' }),
      ...affiliations.map((a) => h('option', { value: a, text: a, selected: people.affiliation === a }))),
      h('span', { class: 'wf-ptable-count', text: `${rows.length} / ${list.length}人` })),
    h('div', { class: 'wf-ptable-scroll', data: { scroll: `people-${view.profile}` } },
      h('table', { class: 'wf-ptable' }, h('thead', {}, head), h('tbody', {}, ...body))),
    rows.length ? null : h('div', { class: 'wf-know-empty', text: '当てはまる人はいません' }));
}

// Under an opened row: every column in full (the table cuts long ones), and the memos by kind.
function personDetail(p) {
  const fields = [
    ['呼び名', p.aliases.join('、')], ['所属', p.affiliation], ['役職・担当', p.role], ['メール', p.email], ['電話', p.phone],
    ['誕生日', p.birthday && birthdayText(p.birthday)], ...p.items.map((i) => [i.label, i.value]),
  ].filter(([, v]) => v);
  const byKind = KINDS.map((k) => [k, p.memos.filter((m) => (m.kind ?? 'その他') === k)]).filter(([, m]) => m.length);
  return h('div', { class: 'wf-know-detail' },
    fields.length ? h('dl', { class: 'wf-know-fields' }, ...fields.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])) : null,
    ...byKind.map(([k, memos]) => h('div', { class: 'wf-know-sub' }, h('h3', { text: `メモ: ${k}` }), memoList(memos.map((m) => ({ ...m, kind: null }))))),
    p.links?.length ? h('div', { class: 'wf-know-sub' }, h('h3', { text: 'つながり' }),
      h('ul', { class: 'wf-know-links' }, ...p.links.map((l) => h('li', { text: `${{ goal: 'ゴール', task: 'タスク', booking: '予定' }[l.kind]}: ${l.title}` })))) : null,
    !byKind.length && !p.links?.length ? h('div', { class: 'wf-know-empty', text: 'メモはまだありません' }) : null);
}

function peopleSection(one, ctx) {
  const list = one.people?.people ?? [];
  const waiting = one.people?.unassigned ?? [];
  const old = one.people_md?.text?.trim() ? one.people_md : null;
  return h('section', { class: 'wf-know-sec' },
    h('div', { class: 'wf-group-head' }, h('h2', { text: '人' })),
    list.length ? peopleTable(list, ctx) : h('div', { class: 'wf-know-empty', text: 'まだいません' }),
    waiting.length ? h('div', { class: 'wf-know-sub' },
      h('h3', { text: 'だれのことか、まだ決まっていないメモ' }), memoList(waiting)) : null,
    old ? h('div', { class: 'wf-know-sub' },
      h('h3', { text: '取り込む前の people.md' }),
      h('p', { class: 'wf-muted', text: '秘書が人に取り込むまで、前の形のまま表示しています' }),
      notes(old.text)) : null);
}

function filesSection(one, file, ctx) {
  const names = [...(one.files.knowledge ?? []), ...(one.files.procedures ?? [])];
  return h('section', { class: 'wf-know-sec' },
    h('div', { class: 'wf-group-head' }, h('h2', { text: '手順' }), names.length ? h('span', { class: 'wf-group-count', text: `${names.length}件` }) : null),
    names.length ? null : h('div', { class: 'wf-know-empty', text: 'まだありません' }),
    ...names.map((n) => h('div', { class: 'wf-know-file' },
      h('button', { type: 'button', class: 'wf-know-name', 'aria-expanded': String(view.open === n), data: { key: `file-${n}` }, onclick: () => { view.open = view.open === n ? null : n; ctx.refresh(); }, text: n.replace(/^(knowledge|procedures)\//, '').replace(/\.md$/, '') }),
      view.open === n && file?.text ? h('div', { class: 'wf-md wf-know-body' }, renderMarkdown(h, file.text)) : null)));
}

function render(data, ctx) {
  const { list, one, file } = data;
  const header = ctx.head('ナレッジ');
  if (!list.profiles.length) {
    return h('div', { class: 'wf-page-tasks' }, header, ctx.banner(),
      h('div', { class: 'wf-surface wf-big-empty', text: 'まだナレッジがありません。エージェントに覚えておいてほしいことを伝えると、ここに表示されます' }));
  }
  const left = h('section', { class: 'wf-goals', 'aria-label': 'プロフィール', data: { scroll: 'profiles' } },
    h('h2', { text: 'プロフィール' }), ...list.profiles.map((p) => profileButton(p, list.colors, ctx)));
  const right = one ? [peopleSection(one, ctx), section('ナレッジ', one.knowledge), section('受信箱', one.inbox), filesSection(one, file, ctx)] : [];
  return h('div', { class: 'wf-page-tasks' }, header, ctx.banner(),
    h('div', { class: 'wf-tasks-body' }, left, h('section', { class: 'wf-tasklist', 'aria-label': 'ナレッジ', data: { scroll: `know-${view.profile}` } }, ...right)));
}

function skeleton(ctx) {
  const row = () => h('div', { class: 'wf-goal-btn' }, skel('50%', '15px'), skel('80%', '13px'));
  return h('div', { class: 'wf-page-tasks' }, ctx.head('ナレッジ'), ctx.banner(),
    h('div', { class: 'wf-tasks-body', 'aria-busy': 'true' },
      h('section', { class: 'wf-goals' }, h('h2', { text: 'プロフィール' }), row(), row(), row()),
      h('section', { class: 'wf-tasklist' }, skel('30%', '22px'), skel('100%', '120px', { borderRadius: '10px' }), skel('30%', '22px'), skel('100%', '120px', { borderRadius: '10px' }))));
}

export default { load, render, skeleton };
