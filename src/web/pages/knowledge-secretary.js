// ナレッジの「秘書」: 秘書と話して決めた生活の決まり、場所、週の居場所を、その場で足す・直す・消す。
// 設定は POST /web/api/rules/settings で書く。人は knowledge.js の表で見る。
//
// 書いている途中の欄は、画面を読み直しても同じ要素を使い回す(fields)ので、打った文字が消えない。

import { h } from '../ui.js';

const DAYS = ['日', '月', '火', '水', '木', '金', '土'];

const state = {
  data: null,
  seen: null, // 最後に受け取った読み込みの結果。新しいものが来たら data を置き換える
  editing: new Set(), // 直している行の鍵
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

// 書く。成功したら返ってきた一覧に置き換え、終わった行の鍵を片づける。
async function write(ctx, path, body, { method = 'POST', done } = {}) {
  if (state.busy) return false;
  state.busy = true;
  state.problems = [];
  ctx.rerender();
  let ok = false;
  try {
    state.data = await ctx.api(path, { method, body });
    done?.();
    ok = true;
  } catch (err) {
    state.problems = err.body?.problems ?? ['保存できませんでした'];
  }
  state.busy = false;
  ctx.rerender();
  return ok;
}

const saveSettings = (ctx, body, done) => write(ctx, '/rules/settings', body, { done });

// ---- 部品 ----

const btn = (text, onclick, cls = '', extra = {}) =>
  h('button', { type: 'button', class: ['wf-rl-btn', cls], disabled: state.busy, onclick, text, ...extra });

// 行は1つのボタン。押すと編集になる。
function row(view, open) {
  return h('li', { class: 'wf-rl-row' }, h('button', { type: 'button', class: 'wf-rl-view', disabled: state.busy, onclick: open }, ...view.filter(Boolean)));
}
function editRow(inputs, actions) {
  return h('li', { class: 'wf-rl-row wf-rl-editing' }, h('div', { class: 'wf-rl-form' }, ...inputs), h('div', { class: 'wf-rl-acts' }, ...actions));
}
const labeled = (text, el) => h('label', { class: 'wf-rl-field' }, h('span', { text }), el);
const openEdit = (ctx, key) => () => { state.editing.add(key); ctx.rerender(); };
const closeEdit = (ctx, key) => () => { drop(key); ctx.rerender(); };

function card(title, ...children) {
  return h('section', { class: 'wf-rl-card', 'aria-label': title }, h('h2', { text: title }), ...children);
}

const list = (items) => (items.length ? h('ul', { class: 'wf-rl-list' }, ...items) : null);

// 追加は1つのボタンから開く。開いている間は入力欄と、追加・キャンセルを出す。
function addArea(ctx, key, inputs, save) {
  if (!state.editing.has(key)) return h('div', { class: 'wf-rl-add' }, btn('追加', openEdit(ctx, key), 'wf-rl-quiet'));
  return h('div', { class: 'wf-rl-add wf-rl-open' }, h('div', { class: 'wf-rl-form' }, ...inputs),
    h('div', { class: 'wf-rl-acts' }, btn('追加', save, 'wf-rl-main'), btn('キャンセル', closeEdit(ctx, key))));
}

const homeCheck = (key, on) => check(key, on, '家');

// ---- 生活の決まり ----

function lifeCard(ctx) {
  const rules = state.data.life.rules;
  const put = (next, prefix) => saveSettings(ctx, { life: { rules: next } }, () => drop(prefix));
  const items = rules.map((text, i) => {
    const key = `life-edit-${i}`;
    if (state.editing.has(key)) {
      const save = () => put(rules.map((r, n) => (n === i ? input.value.trim() : r)), 'life-edit-');
      const input = field(key, text, { maxlength: 200, 'aria-label': '生活の決まり', onkeydown: enter(save) });
      return editRow([input], [
        btn('保存', save, 'wf-rl-main'),
        btn('キャンセル', closeEdit(ctx, key)),
        btn('削除', () => put(rules.filter((_, n) => n !== i), 'life-edit-'), 'wf-rl-danger'),
      ]);
    }
    return row([h('span', { text })], openEdit(ctx, key));
  });
  const add = field('life-new', '', { maxlength: 200, placeholder: '例: 平日は 0:00 から 7:00 まで寝る', 'aria-label': '生活の決まり', onkeydown: enter(addRule) });
  function addRule() {
    const v = add.value.trim();
    if (v) put([...rules, v], 'life-new');
  }
  return card('生活の決まり', list(items), addArea(ctx, 'life-new', [add], addRule));
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
      const name = field(`${key}-name`, p.name, { maxlength: 40, 'aria-label': '名前', onkeydown: enter(save) });
      const note = field(`${key}-note`, p.note ?? '', { maxlength: 200, 'aria-label': 'メモ', onkeydown: enter(save) });
      const home = homeCheck(`${key}-home`, p.home === true);
      function save() {
        const n = name.value.trim();
        const text = note.value.trim();
        const { note: _old, home: _home, ...rest } = p;
        const next = places.map((x, k) => (k === i ? { ...rest, name: n, ...(text ? { note: text } : {}), ...(fields.get(`${key}-home`)?.checked ? { home: true } : {}) } : x));
        const rename = (v) => (v === p.name ? n : v);
        put(next, travel.map((t) => ({ ...t, from: rename(t.from), to: rename(t.to) })), slots.map((s) => ({ ...s, place: rename(s.place) })), 'place-edit-');
      }
      return editRow([labeled('名前', name), labeled('メモ', note), home], [
        btn('保存', save, 'wf-rl-main'),
        btn('キャンセル', closeEdit(ctx, key)),
        btn('削除', () => put(places.filter((_, n) => n !== i), travel.filter((t) => t.from !== p.name && t.to !== p.name), null, 'place-edit-'), 'wf-rl-danger'),
      ]);
    }
    return row([
      h('b', { text: p.name }),
      p.home === true ? h('span', { class: 'wf-rl-badge', text: '家' }) : null,
      p.note ? h('small', { class: 'wf-rl-note', text: p.note }) : null,
    ], openEdit(ctx, key));
  });
  const name = field('place-new-name', '', { maxlength: 40, placeholder: '例: 研究室', 'aria-label': '名前', onkeydown: enter(addPlace) });
  const note = field('place-new-note', '', { maxlength: 200, placeholder: 'メモ', 'aria-label': 'メモ', onkeydown: enter(addPlace) });
  const home = homeCheck('place-new-home', false);
  function addPlace() {
    const n = name.value.trim();
    const text = note.value.trim();
    if (n) put([...places, { name: n, ...(text ? { note: text } : {}), ...(fields.get('place-new-home')?.checked ? { home: true } : {}) }], travel, null, 'place-new');
  }
  return card('場所', list(items), addArea(ctx, 'place-new', [name, note, home], addPlace));
}

// ---- 週の居場所 ----

const daysText = (d) => (d === 'daily' ? '毎日' : d === 'weekdays' ? '平日' : d.join('・'));

function slotForm(ctx, key, slot, onSave) {
  const names = state.data.places.places.map((p) => p.name);
  if (slot.place && !names.includes(slot.place)) names.push(slot.place);
  const profiles = [...state.data.profiles];
  if (slot.profile && !profiles.includes(slot.profile)) profiles.push(slot.profile);
  const kind = Array.isArray(slot.days) ? 'pick' : slot.days;
  const kindEl = select(`${key}-kind`, [['daily', '毎日'], ['weekdays', '平日'], ['pick', '曜日を選ぶ']], kind, { 'aria-label': '曜日', onchange: () => ctx.rerender() });
  const start = field(`${key}-start`, slot.start ?? '09:00', { type: 'time', 'aria-label': '開始' });
  const end = field(`${key}-end`, slot.end ?? '17:00', { type: 'time', 'aria-label': '終了' });
  const place = select(`${key}-place`, [['', '(選択なし)'], ...names.map((n) => [n, n])], slot.place ?? '', { 'aria-label': '場所' });
  const profile = select(`${key}-profile`, [['', '(選択なし)'], ...profiles.map((n) => [n, n])], slot.profile ?? '', { 'aria-label': 'プロフィール' });
  const picks = kindEl.value === 'pick'
    ? h('div', { class: 'wf-rl-days', role: 'group', 'aria-label': '曜日' }, ...DAYS.map((d) => check(`${key}-d-${d}`, Array.isArray(slot.days) && slot.days.includes(d), d)))
    : null;
  const read = () => {
    const days = kindEl.value === 'pick' ? DAYS.filter((d) => fields.get(`${key}-d-${d}`)?.checked) : kindEl.value;
    return { days, start: start.value, end: end.value, place: place.value, ...(profile.value ? { profile: profile.value } : {}) };
  };
  return { read, inputs: [labeled('曜日', kindEl), picks, h('div', { class: 'wf-rl-times' }, labeled('開始', start), labeled('終了', end)), labeled('場所', place), labeled('プロフィール', profile)], save: () => onSave(read()) };
}

function weekCard(ctx) {
  const slots = state.data.week.slots;
  const put = (next, prefix) => saveSettings(ctx, { week: { slots: next } }, () => drop(prefix));
  const items = slots.map((s, i) => {
    const key = `slot-edit-${i}`;
    if (state.editing.has(key)) {
      const f = slotForm(ctx, key, s, (v) => put(slots.map((x, n) => (n === i ? v : x)), 'slot-edit-'));
      return editRow(f.inputs, [
        btn('保存', f.save, 'wf-rl-main'),
        btn('キャンセル', closeEdit(ctx, key)),
        btn('削除', () => put(slots.filter((_, n) => n !== i), 'slot-edit-'), 'wf-rl-danger'),
      ]);
    }
    return row([
      h('b', { text: `${daysText(s.days)} ${s.start}〜${s.end}` }),
      h('span', { text: s.place }),
      s.profile ? h('small', { class: 'wf-rl-note', text: s.profile }) : null,
    ], openEdit(ctx, key));
  });
  const form = slotForm(ctx, 'slot-new', { days: 'weekdays' }, (v) => put([...slots, v], 'slot-new'));
  return card('週の居場所', list(items), addArea(ctx, 'slot-new', form.inputs, form.save));
}

// ---- 全体 ----

// 読み込んだ結果(GET /rules)から、3つのカードを作る。書いている最中は、読み直しで置き換えない。
export function secretaryCards(ctx, data) {
  if (data !== state.seen) {
    state.seen = data;
    if (!state.busy && state.editing.size === 0) state.data = data;
  }
  state.data ??= data;
  const problems = state.problems.length ? h('ul', { class: 'wf-errors', role: 'alert' }, ...state.problems.map((x) => h('li', { text: x }))) : null;
  return h('div', { class: 'wf-rl-wrap' }, problems, lifeCard(ctx), placesCard(ctx), weekCard(ctx));
}
