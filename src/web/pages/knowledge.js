// ナレッジ: on the left, the list of what to look at: 人, 生活リズム, よく行く場所, 曜日ごとの居場所
// and GitHub (the secretary's settings, changed on the spot in knowledge-secretary.js), then each
// profile, opened in place, with its 決まったこと (knowledge.md and knowledge/), 手順
// (procedures/) and 未整理のメモ (inbox.md). On the right, the one chosen.
//
// 人 is one table of the people of every profile. A person opens in place with everything
// about them: what is known (the checked values) and what is not checked yet (未確認, each
// answered with 合っている or 違う). Under the table, one box to tell the secretary about anyone,
// one or many at once (POST /people/tell: the secretary is woken once, outside the
// conversation). The profile's files only show; changes go through the agents.

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
const WHO = { 本人の言葉: 'ユーザーの言葉', 未確認: '未確認' };

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
const LABELS = { aliases: '呼び名', affiliation: '所属', role: '役職・担当', email: 'メール', phone: '電話', birthday: '誕生日' };
const MD = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/;
const birthdayText = (b) => {
  const m = MD.exec(b ?? '');
  return m ? `${m[1] ? `${m[1]}年` : ''}${Number(m[2])}月${Number(m[3])}日` : (b ?? '');
};
const fieldText = (p, f) => (f === 'aliases' ? p.aliases.join('、') : f === 'birthday' ? birthdayText(p.birthday) : p[f] ?? '');
const affiliationRole = (p) => [p.affiliation, p.role].filter(Boolean).join('・');
// The day of the latest memo, as 11月9日 (the year too when it is not this year).
const lastMemo = (p) => p.memos.reduce((a, m) => (m.learned_on > a ? m.learned_on : a), '');
function dayText(ymd, now) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return '';
  return `${Number(m[1]) === now.getFullYear() ? '' : `${m[1]}年`}${Number(m[2])}月${Number(m[3])}日`;
}

const COLS = [['name', '名前'], ['profiles', 'プロフィール'], ['affiliation', '所属・役割'], ['last', '最後に話したこと']];
const sortKey = (p) => (people.sort === 'last' ? lastMemo(p) : people.sort === 'profiles' ? (p.profiles ?? []).join('、') : people.sort === 'affiliation' ? affiliationRole(p) : p.name);

const chips = (names) => h('span', { class: 'wf-kn-chips' }, ...(names ?? []).map((n) => h('span', { class: 'wf-kn-chip', text: n })));

// The box under the people to tell the secretary about anyone, kept across redraws, and how
// its last send went: { busy, said, problem }.
let tellInput = null;
const telling = { busy: false, said: null, problem: null };
const confirming = { busy: false, problem: null };

async function tell(ctx) {
  const text = tellInput?.value.trim() ?? '';
  if (!text || telling.busy) return;
  Object.assign(telling, { busy: true, said: null, problem: null });
  ctx.rerender();
  try {
    const out = await ctx.api('/people/tell', { method: 'POST', body: { text, person: view.person } });
    Object.assign(telling, { busy: false, said: out.said });
    tellInput.value = '';
    ctx.refresh();
    return;
  } catch (err) {
    Object.assign(telling, { busy: false, problem: err.body?.problems?.join(' ') ?? '登録できませんでした' });
  }
  ctx.rerender();
}

function tellBar(ctx, rules) {
  if (!tellInput) {
    tellInput = h('input', {
      type: 'text', id: 'kn-tell', class: 'wf-kn-tell-text', maxlength: '2000', data: { key: 'people-tell' },
      onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); tell(ctx); } },
    });
  }
  const open = rules.people.people.find((p) => p.id === view.person);
  tellInput.placeholder = open ? `${callName(open.name)}のことを書く` : '';
  tellInput.disabled = telling.busy;
  return h('div', { class: 'wf-kn-chat' },
    telling.busy ? h('div', { class: 'wf-kn-said', role: 'status', text: '登録しています' }) : null,
    telling.said ? h('div', { class: 'wf-kn-said', role: 'status' }, h('span', { class: 'wf-kn-said-head', text: '秘書がこう登録しました' }), h('span', { class: 'wf-kn-said-text', text: telling.said })) : null,
    telling.problem ? h('div', { class: 'wf-kn-said', role: 'alert' }, h('span', { class: 'wf-kn-problem', text: telling.problem })) : null,
    h('label', { for: 'kn-tell', class: 'wf-kn-hidden', text: open ? `${callName(open.name)}について教える` : '人について教える' }),
    h('div', { class: 'wf-kn-tell-row' }, tellInput,
      h('button', { type: 'button', class: 'wf-kn-tell-btn', disabled: telling.busy, data: { key: 'people-tell-send' }, onclick: () => tell(ctx), text: '登録' })));
}

const callName = (name) => (/(さん|先生|様|さま|くん|君|ちゃん|氏)$/.test(name) ? name : `${name}さん`);

async function confirm(ctx, p, target, ok) {
  if (confirming.busy) return;
  confirming.busy = true;
  confirming.problem = null;
  ctx.rerender();
  try {
    await ctx.api(`/people/${encodeURIComponent(p.id)}/confirm`, { method: 'POST', body: { ...target, ok } });
  } catch (err) {
    confirming.problem = err.body?.problems?.join(' ') ?? '保存できませんでした';
  }
  confirming.busy = false;
  ctx.refresh();
}

const KINDS = ['やりとり', '接し方', 'その他'];
const LINK_WORDS = { goal: 'ゴール', task: 'タスク', booking: '予定' };
const memoLine = (m, many) => [(() => {
  const [, mo, d] = /^\d{4}-(\d{2})-(\d{2})$/.exec(m.learned_on) ?? [];
  return mo ? `${Number(mo)}/${Number(d)}` : null;
})(), many ? m.profile : null, m.source].filter(Boolean).join(' · ');

// Everything about the person, split by how sure it is: the checked values (the columns, the
// items of each profile, the memos by kind, the links, the profiles) and the guesses (未確認,
// each answered with 合っている or 違う). Nothing empty is shown.
function personDetail(p, ctx) {
  const guessed = new Set(p.unverified ?? []);
  const many = (p.profiles ?? []).length > 1;
  const known = [['名前', p.name]];
  const guesses = [];
  for (const f of ['aliases', 'email', 'phone', 'affiliation', 'role', 'birthday']) {
    const v = fieldText(p, f);
    if (!v) continue;
    if (guessed.has(f)) guesses.push({ label: LABELS[f], text: v, target: { field: f } });
    else known.push([LABELS[f], v]);
  }
  if (p.profiles?.length) known.push(['プロフィール', chips(p.profiles)]);
  for (const i of p.items) {
    if (i.unverified) guesses.push({ label: i.label, text: i.value, meta: many ? i.profile : null, target: { item: { label: i.label, profile: i.profile } } });
    else known.push([i.label, many ? [i.value, ' ', h('span', { class: 'wf-kn-chip', text: i.profile })] : i.value]);
  }
  for (const m of p.memos) if (m.mark === '未確認') guesses.push({ label: m.kind, text: m.text, meta: memoLine(m, many), target: { memo: m.id } });
  const memoGroups = KINDS.map((k) => [k, p.memos.filter((m) => m.mark !== '未確認' && (m.kind ?? 'その他') === k)]).filter(([, l]) => l.length);
  const knownBox = h('section', { class: 'wf-kn-facts', 'aria-label': '分かっていること' }, h('h3', { text: '分かっていること' }),
    h('dl', { class: 'wf-kn-dl' }, ...known.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', {}, v)])),
    ...memoGroups.map(([k, list]) => h('div', { class: 'wf-kn-memos' }, h('h4', { text: k }),
      h('ul', { class: 'wf-know-notes' }, ...list.map((m) => h('li', {},
        h('span', { class: 'wf-know-text', text: m.text }),
        h('span', { class: 'wf-know-meta', text: [memoLine(m, many), m.mark === '本人の言葉' ? 'ユーザーの言葉' : null].filter(Boolean).join(' · ') })))))),
    p.links?.length ? h('div', { class: 'wf-kn-memos' }, h('h4', { text: 'つながり' }),
      h('ul', { class: 'wf-know-links' }, ...p.links.map((l) => h('li', { text: `${LINK_WORDS[l.kind]}: ${l.title}` })))) : null);
  const guessBox = h('section', { class: 'wf-kn-facts', 'aria-label': 'まだ確かめていないこと' }, h('h3', { text: 'まだ確かめていないこと' }),
    guesses.length
      ? h('div', { class: 'wf-kn-guesses' }, ...guesses.map((g) => h('div', { class: 'wf-kn-guess' },
        h('span', { class: 'wf-kn-guess-text' }, h('span', { class: 'wf-kn-guess-label', text: g.label }), h('span', { text: g.text }), g.meta ? h('span', { class: 'wf-know-meta', text: g.meta }) : null),
        h('button', { type: 'button', class: 'wf-kn-small', disabled: confirming.busy, onclick: () => confirm(ctx, p, g.target, true), text: '合っている' }),
        h('button', { type: 'button', class: 'wf-kn-small', disabled: confirming.busy, onclick: () => confirm(ctx, p, g.target, false), text: '違う' }))))
      : h('div', { class: 'wf-know-empty', text: 'ありません' }),
    confirming.problem ? h('p', { class: 'wf-kn-problem', role: 'alert', text: confirming.problem }) : null);
  return [h('div', { class: 'wf-kn-detail' }, knownBox, guessBox)];
}

function personRow(p, ctx, open) {
  const last = lastMemo(p);
  return h('div', { role: 'row', class: 'wf-kn-row' },
    h('span', { role: 'cell', class: 'wf-kn-name' }, h('button', {
      type: 'button', class: 'wf-kn-name-btn', 'aria-expanded': String(open), data: { key: `person-${p.id}` },
      onclick: () => { view.person = open ? null : p.id; ctx.rerender(); }, text: p.name,
    })),
    h('span', { role: 'cell' }, chips(p.profiles)),
    h('span', { role: 'cell', class: ['wf-kn-sub-text', !affiliationRole(p) && 'wf-ptable-blank'], text: affiliationRole(p) || '—' }),
    h('span', { role: 'cell', class: ['wf-kn-day', !last && 'wf-ptable-blank'], text: last ? dayText(last, ctx.now) : '—' }));
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
  const head = h('div', { role: 'row', class: 'wf-kn-row wf-kn-headrow' }, ...COLS.map(([k, label]) => h('span', { role: 'columnheader', 'aria-sort': people.sort === k ? (people.desc ? 'descending' : 'ascending') : 'none' },
    h('button', { type: 'button', class: 'wf-ptable-sort', data: { key: `sort-${k}` }, onclick: sortBy(k) },
      label, h('span', { class: 'wf-ptable-arrow', 'aria-hidden': 'true', text: people.sort === k ? (people.desc ? '▼' : '▲') : '' })))));
  const body = rows.map((p) => {
    const open = view.person === p.id;
    if (!open) return personRow(p, ctx, false);
    return h('div', { class: 'wf-kn-open' }, personRow(p, ctx, true), ...personDetail(p, ctx), tellBar(ctx, rules));
  });
  const waiting = rules.people.unassigned ?? [];
  return [
    h('div', { class: 'wf-kn-head' }, h('h2', { text: '人' }),
      h('input', {
        type: 'search', class: 'wf-ptable-search wf-kn-search', placeholder: '名前、所属で探す', value: people.query, 'aria-label': '人を探す', data: { key: 'people-search' },
        oninput: (e) => { people.query = e.target.value; ctx.rerender(); },
      })),
    h('div', { class: 'wf-ptable-tools' },
      h('select', {
        class: 'wf-ptable-select', 'aria-label': '所属で絞る', data: { key: 'people-affiliation' }, disabled: affiliations.length === 0,
        onchange: (e) => { people.affiliation = e.target.value; ctx.rerender(); },
      }, h('option', { value: '', text: '所属: すべて', selected: people.affiliation === '' }),
      ...affiliations.map((a) => h('option', { value: a, text: a, selected: people.affiliation === a }))),
      h('span', { class: 'wf-ptable-count', text: `${rows.length} / ${list.length}人` })),
    list.length
      ? h('div', { role: 'table', 'aria-label': '人の一覧', class: 'wf-kn-table' }, head, ...body)
      : h('div', { class: 'wf-know-empty', text: 'まだいません' }),
    list.length && !rows.length ? h('div', { class: 'wf-know-empty', text: '当てはまる人はいません' }) : null,
    waiting.length ? h('div', { class: 'wf-know-sub' }, h('h3', { text: 'だれのことか、まだ決まっていないメモ' }), memoList(waiting)) : null,
  ];
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
      waiting.length ? h('div', { class: 'wf-know-sub' }, h('h3', { text: 'だれのことか、まだ決まっていないメモ' }), memoList(waiting.map((m) => ({ ...m, profile: null })))) : null,
      old ? h('div', { class: 'wf-know-sub' }, h('h3', { text: '取り込む前の people.md' }), notes(old.text)) : null];
  }
  const filled = body.flat(Infinity).filter(Boolean);
  return [head, ...(filled.length ? filled : [h('div', { class: 'wf-know-empty', text: 'まだありません' })])];
}

// ---- 全体 ----

function render(data, ctx) {
  const { list, rules, one, file } = data;
  const key = view.sel === 'profile' ? `${view.profile}-${view.part}` : view.sel;
  let main;
  if (view.sel === 'people') {
    // The people scroll; the box to tell the secretary stays at the foot.
    main = h('section', { class: 'wf-tasklist wf-kn-main wf-kn-split', 'aria-label': 'ナレッジ' },
      h('div', { class: 'wf-kn-scroll', data: { scroll: `know-${key}` } }, ...peoplePane(rules, ctx)));
  } else {
    const right = SETTINGS.includes(view.sel) ? [settingsCard(ctx, rules, view.sel)] : profilePane(one, file, list, ctx);
    main = h('section', { class: 'wf-tasklist wf-kn-main', 'aria-label': 'ナレッジ', data: { scroll: `know-${key}` } }, ...right);
  }
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
const busy = () => settingsBusy() || confirming.busy || telling.busy;

export default { load, render, skeleton, busy };
