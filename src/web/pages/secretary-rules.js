// 秘書の「決めたこと」の欄: 秘書と話して決めたこと(生活の決まり、場所、週の居場所、人のこと)を
// 一覧にして、その場で足す・直す・消す。会話のタブと並ぶ2つめのタブで、secretary.js は
// withTabs で包むだけ。設定は POST /web/api/rules/settings、人は /web/api/people で書く。
//
// 書いている途中の欄は、画面を読み直しても同じ要素を使い回す(fields)ので、打った文字が消えない。
// 「1日の流れを決める」は、決まった一文を本人の発言として秘書に送る。聞き方の手順は
// harness/secretary/chat.md にある。

import { h } from '../ui.js';

export const DAY_FLOW_TEXT = '1日の流れを決めたいです。順に聞いてください';
const REREAD_MS = 20_000;
const DAYS = ['日', '月', '火', '水', '木', '金', '土'];

const state = {
  tab: 'chat',
  data: null,
  at: 0,
  fetching: false,
  editing: new Set(), // 直している行の鍵
  confirm: null, // 消す前の確かめ中の人の id
  problems: [],
  busy: false,
};
// 書いている途中の欄。鍵 → 要素。
const fields = new Map();

function field(key, value, attrs = {}) {
  let el = fields.get(key);
  if (!el) {
    el = h('input', { type: 'text', data: { key }, ...attrs });
    el.value = value ?? '';
    fields.set(key, el);
  }
  return el;
}

// 選ぶ欄。選択肢は読み直すたびに作り直し、選んだものは残す。
function select(key, options, value, attrs = {}) {
  let el = fields.get(key);
  const fresh = !el;
  if (fresh) {
    el = h('select', { data: { key }, ...attrs });
    fields.set(key, el);
  }
  const keep = fresh ? value : el.value;
  el.replaceChildren(...options.map(([v, label]) => h('option', { value: v, text: label })));
  el.value = options.some(([v]) => v === keep) ? keep : (options[0]?.[0] ?? '');
  return el;
}

function check(key, on, label) {
  let el = fields.get(key);
  if (!el) {
    el = h('input', { type: 'checkbox', data: { key } });
    el.checked = on;
    fields.set(key, el);
  }
  return h('label', { class: 'wf-rl-day' }, el, h('span', { text: label }));
}

const drop = (prefix) => {
  for (const k of [...fields.keys()]) if (k.startsWith(prefix)) fields.delete(k);
  for (const k of [...state.editing]) if (k.startsWith(prefix)) state.editing.delete(k);
};

const enter = (fn) => (e) => {
  if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    fn();
  }
};

async function load(ctx) {
  if (state.fetching) return;
  state.fetching = true;
  try {
    state.data = await ctx.api('/rules');
  } catch {
    // 前の表示を残す。
  }
  state.at = Date.now();
  state.fetching = false;
  ctx.rerender();
}

// 書く。成功したら返ってきた一覧に置き換え、終わった行の鍵を片づける。
async function write(ctx, path, body, { method = 'POST', done } = {}) {
  if (state.busy) return false;
  state.busy = true;
  state.problems = [];
  ctx.rerender();
  let ok = false;
  try {
    state.data = await ctx.api(path, { method, body });
    state.at = Date.now();
    done?.();
    ok = true;
  } catch (err) {
    state.problems = err.body?.problems ?? ['書けませんでした。サーバーにつながっているか確かめてください'];
  }
  state.busy = false;
  ctx.rerender();
  return ok;
}

const saveSettings = (ctx, body, done) => write(ctx, '/rules/settings', body, { done });

// ---- 部品 ----

const btn = (text, onclick, cls = '', extra = {}) =>
  h('button', { type: 'button', class: ['wf-rl-btn', cls], disabled: state.busy, onclick, text, ...extra });

function row(view, actions) {
  return h('li', { class: 'wf-rl-row' }, h('div', { class: 'wf-rl-view' }, view), h('div', { class: 'wf-rl-acts' }, ...actions));
}
function editRow(inputs, actions) {
  return h('li', { class: 'wf-rl-row wf-rl-editing' }, h('div', { class: 'wf-rl-form' }, ...inputs), h('div', { class: 'wf-rl-acts' }, ...actions));
}
const labeled = (text, el) => h('label', { class: 'wf-rl-field' }, h('span', { text }), el);

function card(title, hint, ...children) {
  return h('section', { class: 'wf-rl-card', 'aria-label': title },
    h('h2', { text: title }),
    hint ? h('p', { class: 'wf-rl-hint', text: hint }) : null,
    ...children);
}

const empty = (text) => h('li', { class: 'wf-rl-none', text });

// ---- 生活の決まり ----

function lifeCard(ctx) {
  const rules = state.data.life.rules;
  const put = (next, prefix) => saveSettings(ctx, { life: { rules: next } }, () => drop(prefix));
  const items = rules.map((text, i) => {
    const key = `life-edit-${i}`;
    if (state.editing.has(key)) {
      const input = field(key, text, { maxlength: 200, 'aria-label': '生活の決まり', onkeydown: enter(() => put(rules.map((r, n) => (n === i ? input.value.trim() : r)), 'life-edit-')) });
      return editRow([input], [
        btn('保存', () => put(rules.map((r, n) => (n === i ? input.value.trim() : r)), 'life-edit-'), 'wf-rl-main'),
        btn('やめる', () => { drop(key); ctx.rerender(); }),
      ]);
    }
    return row(h('span', { text }), [
      btn('直す', () => { state.editing.add(key); ctx.rerender(); document.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus(); }),
      btn('消す', () => put(rules.filter((_, n) => n !== i), 'life-edit-'), 'wf-rl-danger'),
    ]);
  });
  const add = field('life-new', '', { maxlength: 200, placeholder: '例: 平日は 0:00 から 7:00 まで寝る', 'aria-label': '生活の決まりを足す', onkeydown: enter(addRule) });
  function addRule() {
    const v = add.value.trim();
    if (v) put([...rules, v], 'life-new');
  }
  return card('生活の決まり', '寝る時間、食事、毎週の決まった用事など。予定を置くときに秘書が読みます。',
    h('ul', { class: 'wf-rl-list' }, items.length ? items : empty('まだありません')),
    h('div', { class: 'wf-rl-add' }, add, btn('足す', addRule, 'wf-rl-main')));
}

// ---- 場所 ----

function placesCard(ctx) {
  const { places, travel } = state.data.places;
  const slots = state.data.week.slots;
  const put = (next, nextTravel, nextSlots, prefix) => saveSettings(ctx, {
    places: { places: next, travel: nextTravel },
    ...(nextSlots ? { week: { slots: nextSlots } } : {}),
  }, () => drop(prefix));
  const items = places.map((p, i) => {
    const key = `place-edit-${i}`;
    if (state.editing.has(key)) {
      const name = field(`${key}-name`, p.name, { maxlength: 40, 'aria-label': '場所の名前', onkeydown: enter(save) });
      const note = field(`${key}-note`, p.note ?? '', { maxlength: 200, 'aria-label': 'ひとこと', onkeydown: enter(save) });
      function save() {
        const n = name.value.trim();
        const text = note.value.trim();
        const { note: _old, ...rest } = p;
        const next = places.map((x, k) => (k === i ? { ...rest, name: n, ...(text ? { note: text } : {}) } : x));
        const rename = (v) => (v === p.name ? n : v);
        put(next, travel.map((t) => ({ ...t, from: rename(t.from), to: rename(t.to) })), slots.map((s) => ({ ...s, place: rename(s.place) })), 'place-edit-');
      }
      return editRow([labeled('名前', name), labeled('ひとこと', note)], [btn('保存', save, 'wf-rl-main'), btn('やめる', () => { drop(key); ctx.rerender(); })]);
    }
    return row([
      h('b', { text: p.name }),
      p.home === true ? h('span', { class: 'wf-rl-badge', text: '家' }) : null,
      p.note ? h('small', { class: 'wf-rl-note', text: p.note }) : null,
    ], [
      btn('直す', () => { state.editing.add(key); ctx.rerender(); }),
      btn('消す', () => put(places.filter((_, n) => n !== i), travel.filter((t) => t.from !== p.name && t.to !== p.name), null, 'place-edit-'), 'wf-rl-danger'),
    ]);
  });
  const name = field('place-new-name', '', { maxlength: 40, placeholder: '場所の名前(例: 研究室)', 'aria-label': '場所の名前', onkeydown: enter(addPlace) });
  const note = field('place-new-note', '', { maxlength: 200, placeholder: 'ひとこと(なくても可)', 'aria-label': 'ひとこと', onkeydown: enter(addPlace) });
  function addPlace() {
    const n = name.value.trim();
    const text = note.value.trim();
    if (n) put([...places, { name: n, ...(text ? { note: text } : {}) }], travel, null, 'place-new');
  }
  return card('場所', 'よく行く場所。下の「週の居場所」で、この名前から選びます。',
    h('ul', { class: 'wf-rl-list' }, items.length ? items : empty('まだありません')),
    h('div', { class: 'wf-rl-add' }, name, note, btn('足す', addPlace, 'wf-rl-main')));
}

// ---- 週の居場所 ----

const daysText = (d) => (d === 'daily' ? '毎日' : d === 'weekdays' ? '平日(月〜金)' : d.join('・'));

function slotForm(ctx, key, slot, onSave) {
  const names = state.data.places.places.map((p) => p.name);
  if (slot.place && !names.includes(slot.place)) names.push(slot.place);
  const profiles = [...state.data.profiles];
  if (slot.profile && !profiles.includes(slot.profile)) profiles.push(slot.profile);
  const kind = Array.isArray(slot.days) ? 'pick' : slot.days;
  const kindEl = select(`${key}-kind`, [['daily', '毎日'], ['weekdays', '平日(月〜金)'], ['pick', '曜日を選ぶ']], kind, { 'aria-label': '曜日', onchange: () => ctx.rerender() });
  const start = field(`${key}-start`, slot.start ?? '09:00', { type: 'time', 'aria-label': 'はじまり' });
  const end = field(`${key}-end`, slot.end ?? '17:00', { type: 'time', 'aria-label': 'おわり' });
  const place = select(`${key}-place`, [['', '場所を選ぶ'], ...names.map((n) => [n, n])], slot.place ?? '', { 'aria-label': '場所' });
  const profile = select(`${key}-profile`, [['', 'なし'], ...profiles.map((n) => [n, n])], slot.profile ?? '', { 'aria-label': 'プロフィール' });
  const picks = kindEl.value === 'pick'
    ? h('div', { class: 'wf-rl-days', role: 'group', 'aria-label': '曜日' }, ...DAYS.map((d) => check(`${key}-d-${d}`, Array.isArray(slot.days) && slot.days.includes(d), d)))
    : null;
  const read = () => {
    const days = kindEl.value === 'pick' ? DAYS.filter((d) => fields.get(`${key}-d-${d}`)?.checked) : kindEl.value;
    return { days, start: start.value, end: end.value, place: place.value, ...(profile.value ? { profile: profile.value } : {}) };
  };
  return { read, inputs: [labeled('曜日', kindEl), picks, h('div', { class: 'wf-rl-times' }, labeled('はじまり', start), labeled('おわり', end)), labeled('場所', place), labeled('プロフィール', profile)], save: () => onSave(read()) };
}

function weekCard(ctx) {
  const slots = state.data.week.slots;
  const put = (next, prefix) => saveSettings(ctx, { week: { slots: next } }, () => drop(prefix));
  const items = slots.map((s, i) => {
    const key = `slot-edit-${i}`;
    if (state.editing.has(key)) {
      const f = slotForm(ctx, key, s, (v) => put(slots.map((x, n) => (n === i ? v : x)), 'slot-edit-'));
      return editRow(f.inputs, [btn('保存', f.save, 'wf-rl-main'), btn('やめる', () => { drop(key); ctx.rerender(); })]);
    }
    return row([
      h('b', { text: `${daysText(s.days)} ${s.start}〜${s.end}` }),
      h('span', { text: s.place }),
      s.profile ? h('small', { class: 'wf-rl-note', text: s.profile }) : null,
    ], [
      btn('直す', () => { state.editing.add(key); ctx.rerender(); }),
      btn('消す', () => put(slots.filter((_, n) => n !== i), 'slot-edit-'), 'wf-rl-danger'),
    ]);
  });
  const adding = state.editing.has('slot-new');
  const form = adding ? slotForm(ctx, 'slot-new', { days: 'weekdays' }, (v) => put([...slots, v], 'slot-new')) : null;
  return card('週の居場所', '毎週決まった曜日と時間に、どこにいるか。',
    h('ul', { class: 'wf-rl-list' }, items.length ? items : empty('まだありません')),
    form
      ? h('div', { class: 'wf-rl-newform' }, h('div', { class: 'wf-rl-form' }, ...form.inputs), h('div', { class: 'wf-rl-acts' }, btn('足す', form.save, 'wf-rl-main'), btn('やめる', () => { drop('slot-new'); ctx.rerender(); })))
      : h('div', { class: 'wf-rl-add' }, btn('居場所を足す', () => { state.editing.add('slot-new'); ctx.rerender(); }, 'wf-rl-main')));
}

// ---- 人のこと ----

const itemsText = (items) => Object.entries(items ?? {}).map(([k, v]) => `${k.split('/').pop()}: ${v}`);
const aliasesOf = (text) => text.split(/[、,，]/u).map((a) => a.trim()).filter(Boolean);

function peopleCard(ctx) {
  const { people, count, more } = state.data.people;
  const items = people.map((p) => {
    const key = `person-edit-${p.id}`;
    if (state.editing.has(key)) {
      const name = field(`${key}-name`, p.name, { maxlength: 100, 'aria-label': '名前', onkeydown: enter(save) });
      const aff = field(`${key}-aff`, p.affiliation ?? '', { maxlength: 200, 'aria-label': '所属', onkeydown: enter(save) });
      const role = field(`${key}-role`, p.role ?? '', { maxlength: 200, 'aria-label': '役割', onkeydown: enter(save) });
      const ali = field(`${key}-ali`, (p.aliases ?? []).join('、'), { maxlength: 300, 'aria-label': '呼び名', placeholder: '「、」で区切る', onkeydown: enter(save) });
      function save() {
        write(ctx, `/people/${encodeURIComponent(p.id)}`, { name: name.value.trim(), affiliation: aff.value.trim() || null, role: role.value.trim() || null, aliases: aliasesOf(ali.value) }, { done: () => drop('person-edit-') });
      }
      return editRow([labeled('名前', name), labeled('所属', aff), labeled('役割', role), labeled('呼び名', ali)], [btn('保存', save, 'wf-rl-main'), btn('やめる', () => { drop(key); ctx.rerender(); })]);
    }
    const sub = [p.affiliation, p.role].filter(Boolean).join(' / ');
    const lines = itemsText(p.items);
    const view = [
      h('b', { text: p.name }),
      sub ? h('span', { text: sub }) : null,
      (p.aliases ?? []).length ? h('small', { class: 'wf-rl-note', text: `呼び名: ${p.aliases.join('、')}` }) : null,
      lines.length ? h('small', { class: 'wf-rl-note', text: lines.join(' ・ ') }) : null,
      h('small', { class: 'wf-rl-note', text: [(p.profiles ?? []).join('、'), p.memos ? `メモ ${p.memos}件` : ''].filter(Boolean).join(' ・ ') }),
    ];
    if (state.confirm === p.id) {
      return row([h('span', { text: `「${p.name}」のことを、メモも含めてすべて消します。戻せません。` })], [
        btn('消す', () => write(ctx, `/people/${encodeURIComponent(p.id)}`, {}, { method: 'DELETE', done: () => { state.confirm = null; } }), 'wf-rl-danger'),
        btn('やめる', () => { state.confirm = null; ctx.rerender(); }),
      ]);
    }
    return row(view, [btn('直す', () => { state.editing.add(key); ctx.rerender(); }), btn('消す', () => { state.confirm = p.id; ctx.rerender(); }, 'wf-rl-danger')]);
  });
  const profiles = state.data.profiles;
  const name = field('person-new-name', '', { maxlength: 100, placeholder: '名前', 'aria-label': '名前', onkeydown: enter(addPerson) });
  const aff = field('person-new-aff', '', { maxlength: 200, placeholder: '所属(なくても可)', 'aria-label': '所属', onkeydown: enter(addPerson) });
  const role = field('person-new-role', '', { maxlength: 200, placeholder: '役割(なくても可)', 'aria-label': '役割', onkeydown: enter(addPerson) });
  const profile = profiles.length
    ? select('person-new-profile', profiles.map((n) => [n, n]), profiles[0], { 'aria-label': 'プロフィール' })
    : field('person-new-profile', '', { maxlength: 40, placeholder: 'プロフィール', 'aria-label': 'プロフィール', onkeydown: enter(addPerson) });
  function addPerson() {
    const n = name.value.trim();
    if (!n) return;
    write(ctx, '/people', { name: n, profile: profile.value.trim(), ...(aff.value.trim() ? { affiliation: aff.value.trim() } : {}), ...(role.value.trim() ? { role: role.value.trim() } : {}) }, { done: () => drop('person-new') });
  }
  return card('人のこと', '秘書が話の中で覚えた人。名前、所属、役割を直せます。メモや項目は秘書に頼んで足してもらいます。',
    h('ul', { class: 'wf-rl-list' }, items.length ? items : empty('まだありません')),
    more ? h('p', { class: 'wf-rl-hint', text: `ほかに ${more}人います(${count}人中)` }) : null,
    h('div', { class: 'wf-rl-add' }, name, aff, role, profile, btn('足す', addPerson, 'wf-rl-main')));
}

// ---- 全体 ----

async function startDayFlow(ctx) {
  if (state.busy) return;
  state.busy = true;
  state.problems = [];
  ctx.rerender();
  try {
    await ctx.api('/secretary/messages', { method: 'POST', body: { text: DAY_FLOW_TEXT } });
    state.tab = 'chat';
    state.busy = false;
    await ctx.refresh();
    return;
  } catch (err) {
    state.problems = err.body?.problems ?? ['送れませんでした。サーバーにつながっているか確かめてください'];
  }
  state.busy = false;
  ctx.rerender();
}

function panel(ctx) {
  if (!state.data || (Date.now() - state.at > REREAD_MS && !state.fetching && state.editing.size === 0 && !state.busy)) load(ctx);
  const problems = state.problems.length ? h('ul', { class: 'wf-errors', role: 'alert' }, ...state.problems.map((x) => h('li', { text: x }))) : null;
  const flow = h('section', { class: 'wf-rl-flow', 'aria-label': '1日の流れ' },
    h('div', {}, h('b', { text: '1日の流れを決める' }), h('p', { class: 'wf-rl-hint', text: '秘書が、起きる時間、外へ行く日、家にいる時間などを順に聞いて、ここに書きます。' })),
    h('button', { type: 'button', class: 'wf-rl-start', disabled: state.busy, onclick: () => startDayFlow(ctx), text: '1日の流れを決める' }));
  const body = state.data
    ? [lifeCard(ctx), placesCard(ctx), weekCard(ctx), peopleCard(ctx)]
    : [h('p', { class: 'wf-rl-hint', role: 'status', text: '読んでいます' })];
  return h('div', { class: 'wf-rules', data: { scroll: 'rules' } }, h('div', { class: 'wf-rules-in' }, ctx.banner(), flow, problems, ...body));
}

function tabs(ctx) {
  const tab = (key, label) => h('button', {
    type: 'button', role: 'tab', class: 'wf-sec-tab', aria: { selected: String(state.tab === key) },
    onclick: () => {
      if (state.tab === key) return;
      state.tab = key;
      state.problems = [];
      if (key === 'rules') state.at = 0;
      ctx.rerender();
    },
    text: label,
  });
  return h('div', { class: 'wf-sec-tabs', role: 'tablist', 'aria-label': '秘書の画面' }, tab('chat', '会話'), tab('rules', '決めたこと'));
}

// 会話の画面(chat を呼んで作る)を、タブで包む。決めたこと のタブでは chat を呼ばない。
export function withTabs(ctx, chat) {
  const body = state.tab === 'rules' ? panel(ctx) : chat();
  return h('div', { class: 'wf-sec-wrap' }, tabs(ctx), body);
}
