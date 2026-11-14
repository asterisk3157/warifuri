// タスク: what to do now, and how far each goal has come. At the top, how many tasks are open
// (and overdue, due within 3 days, waiting); each count is a filter. Below, 今やる (the
// person's tasks that can start, soonest due first) and ゴールの進み (one line per goal). A task
// or a goal opens its detail in the panel at the right (over the page on a narrow screen).
//
// The screen is drawn again every 30 seconds: what is open (the panel, folded parts, the goal's
// list or chart) lives in view, and every scroll box and control has a data key, so a redraw
// keeps them.

import { h, s, icon, skel, profileChip, profileColor, dueDay, daysFrom, md, mdw, hhmm2 } from '../ui.js';
import { layoutFlow, arrowHead } from '../flow.js';

const view = {
  filter: null, // a key of FILTERS, or null for 今やる
  sel: null, // { kind: 'task' | 'goal', id } shown in the panel
  from: null, // the goal a task was opened from, for 戻る
  opener: null, // the data key to give focus back to when the panel closes
  fresh: false, // the panel was just opened (it slides in once, not on every redraw)
  goalView: 'list', // 'list' | 'flow'
  open: new Set(), // folded parts that are open
  moreNow: false,
  showAi: false,
  busy: null, // the data key of the button whose write is on its way
  problem: null, // { key, text } when a write was refused
};

const load = (api) => api('/tasks');

const STATE = { done: '完了', running: '作業中', ready: '着手可能', waiting: '待ち', blocked: '順番待ち', deferred: '先送り', discarded: '破棄' };
const WHO = { human: ['あなた', 'あ', false], ai_worker: ['AIエージェント', 'AI', true], human_with_ai: ['あなた + AI', 'あ', false] };
const HUMAN = new Set(['human', 'human_with_ai']);
const CLOSED = new Set(['done', 'discarded']);
const NOW_MAX = 8;
const FRESH_MS = 24 * 60 * 60 * 1000;
// Who wrote a 下調べ or a record, by device name.
const NAMES = { muse: 'Muse', secretary: '秘書', human: 'あなた', web: 'あなた' };
const LOG = { created: '作成', started: '着手', released: '手放した', waiting: '待ちにした', deferred: '先送り', resumed: '再開', done: '完了', discarded: 'やめた', reopened: '開き直した', prepped: '下調べ' };
// The chart's boxes, wider and taller than the default, so titles can be read.
const FLOW = { NW: 200, NH: 96, SH: 40, DH: 18, GX: 36, GY: 14 };

// A task's state as shown: ready with an open task before it is 順番待ち.
const shown = (t) => (t.blocked ? 'blocked' : t.state);
const isOpen = (t) => !CLOSED.has(t.state);
const canStart = (t) => (t.state === 'ready' && !t.blocked) || t.state === 'running';
const left = (t, today) => {
  const d = dueDay(t.due);
  return d ? daysFrom(today, d) : null;
};

const FILTERS = [
  { key: 'all', label: 'タスク', head: '閉じていないタスク', keep: () => true },
  { key: 'over', label: '期限切れ', head: '期限切れ', keep: (t, today) => left(t, today) !== null && left(t, today) < 0 },
  { key: 'soon', label: '3日以内', head: '今日から3日以内', keep: (t, today) => left(t, today) !== null && left(t, today) >= 0 && left(t, today) <= 3 },
  { key: 'wait', label: '待ち', head: '待ち', keep: (t) => t.state === 'waiting' },
];

const dueColor = (d) => (d === null ? 'var(--off)' : d < 0 ? 'var(--red)' : d <= 3 ? 'var(--due-soon)' : 'var(--sub)');
const leftText = (d) => (d === null ? '' : d < 0 ? `${-d}日過ぎ` : d === 0 ? '今日まで' : `残り${d}日`);
const prov = (x) => (x.due_provisional ? ' 仮' : '');
const chip = (st) => h('span', { class: `wf-state wf-st-${st}`, text: STATE[st] ?? st });
const avatar = (w) => h('span', { class: ['wf-avatar', w[2] && 'wf-ai'], 'aria-hidden': 'true', text: w[1] });
const name = (by) => NAMES[by] ?? by ?? '—';
const stamp = (iso) => {
  const d = new Date(iso);
  return `${md(d)} ${hhmm2(d)}`;
};
// Earliest due first, then the order the person gave, then as listed.
const byDue = (today) => (a, b) => (left(a.t, today) ?? Infinity) - (left(b.t, today) ?? Infinity) || (a.t.priority ?? Infinity) - (b.t.priority ?? Infinity);
const keyClick = (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    e.currentTarget.click();
  }
};

// The first sentence of a long text (up to the first 。 or line break, at most 80 characters),
// and the rest.
export function lead(text) {
  const t = String(text ?? '').trim();
  let end = t.indexOf('。');
  end = end === -1 ? t.length : end + 1;
  const nl = t.indexOf('\n');
  if (nl !== -1 && nl < end) end = nl;
  if (end > 80) return { head: `${t.slice(0, 80)}…`, rest: t.slice(80).trim() };
  return { head: t.slice(0, end).trim(), rest: t.slice(end).trim() };
}

// A part that folds, whose open state outlives the redraw.
function fold(key, summary, ...body) {
  return h('details', {
    class: 'wf-tk-fold', open: view.open.has(key),
    ontoggle: (e) => (e.currentTarget.open ? view.open.add(key) : view.open.delete(key)),
  }, h('summary', { data: { key: `fold-${key}` }, text: summary }), ...body);
}

// Moving the panel. key: what was pressed, to give focus back to on close; a move inside the
// panel (key null, or from a goal's list) keeps the first one.
let ctxNow = null;
function openItem(kind, id, key, from = null) {
  if (key && !from) view.opener = key;
  view.fresh = !view.sel;
  view.sel = { kind, id };
  view.from = from;
  ctxNow.rerender();
  requestAnimationFrame(() => document.querySelector('[data-key="panel-close"]')?.focus({ preventScroll: true }));
}
function closePanel() {
  const back = view.opener;
  view.sel = null;
  view.from = null;
  view.opener = null;
  ctxNow.rerender();
  if (back) document.querySelector(`[data-key="${CSS.escape(back)}"]`)?.focus({ preventScroll: true });
}
let escBound = false;
function bindEsc() {
  if (escBound) return;
  escBound = true;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !view.sel || !document.querySelector('.wf-page-tasks')) return;
    // The about dialog closes first.
    if (document.getElementById('wf-layer')?.childElementCount) return;
    e.preventDefault();
    closePanel();
  });
}

function prepTag(t, now) {
  const p = t.preps?.[0];
  if (!p) return null;
  const fresh = now - Date.parse(p.created_at) < FRESH_MS;
  return h('span', { class: ['wf-prep-tag', fresh && 'wf-prep-new'], text: fresh ? '新しい下調べ' : '下調べあり' });
}

function goalLabel(g, t, colors) {
  const profile = g?.profile ?? t.profile ?? null;
  return h('span', { class: 'wf-tk-goalname' },
    h('span', { class: 'wf-dot', style: { background: profileColor(profile, colors) }, 'aria-hidden': 'true' }),
    g ? g.title : 'ゴールなし');
}

// One task as a line: who, title, its goal, state when not plain 着手可能, 下調べ, and the days left.
function row({ t, g }, today, ctx, colors, prefix, { goal = true, from = null } = {}) {
  const w = WHO[t.mode] ?? WHO.ai_worker;
  const closed = t.state === 'done';
  const d = left(t, today);
  const key = `${prefix}-${t.id}`;
  const on = view.sel?.kind === 'task' && view.sel.id === t.id;
  const st = shown(t);
  return h('div', {
    class: ['wf-tk-row', closed && 'wf-closed', on && 'wf-tk-on'], role: 'button', tabindex: '0', 'aria-pressed': String(on), data: { key },
    onclick: () => openItem('task', t.id, key, from), onkeydown: keyClick,
  },
  avatar(w),
  h('span', { class: 'wf-tk-row-main' },
    h('span', { class: 'wf-tk-row-title', text: t.title }),
    h('span', { class: 'wf-tk-row-sub' },
      goal ? goalLabel(g, t, colors) : null,
      st !== 'ready' && !closed ? chip(st) : null,
      closed ? null : prepTag(t, ctx.now))),
  h('span', { class: 'wf-tk-row-due' },
    h('span', { class: 'wf-left', style: { color: closed || d === null ? 'var(--off)' : dueColor(d) }, text: closed ? '完了' : leftText(d) || '期限なし' }),
    t.due && !closed ? h('small', { text: `${md(dueDay(t.due))}${prov(t)}` }) : null));
}

// The counts at the top; each one filters the list in place of 今やる.
function band(open, today, ctx) {
  return h('div', { class: 'wf-tk-counts', role: 'group', 'aria-label': '件数' },
    ...FILTERS.map((f) => {
      const n = open.filter((x) => f.keep(x.t, today)).length;
      const on = view.filter === f.key;
      const tone = f.key === 'over' && n ? 'wf-tk-n-red' : f.key === 'soon' && n ? 'wf-tk-n-soon' : null;
      return h('button', {
        type: 'button', class: 'wf-tk-count', 'aria-pressed': String(on), data: { key: `count-${f.key}` },
        onclick: () => { view.filter = on ? null : f.key; ctx.rerender(); },
      }, h('span', { class: 'wf-tk-count-label', text: f.label }), h('span', { class: ['wf-tk-count-n', tone], text: `${n}件` }));
    }));
}

function head(title, n, ...right) {
  return h('div', { class: 'wf-tk-head' }, h('h2', { text: title }), h('span', { class: 'wf-group-count', text: `${n}件` }), ...right);
}

// 今やる: the person's tasks that can start, soonest due first; the AI's are only counted.
function nowCard(items, today, ctx, colors) {
  const ready = items.filter((x) => canStart(x.t));
  const mine = ready.filter((x) => HUMAN.has(x.t.mode)).sort(byDue(today));
  const ai = ready.filter((x) => !HUMAN.has(x.t.mode)).sort(byDue(today));
  const aiRunning = ai.filter((x) => x.t.state === 'running').length;
  const list = view.moreNow ? mine : mine.slice(0, NOW_MAX);
  return h('section', { class: 'wf-tk-card', 'aria-label': '今やる' },
    head('今やる', mine.length),
    ...list.map((x) => row(x, today, ctx, colors, 'now')),
    mine.length ? null : h('p', { class: 'wf-tk-empty', text: 'いま始められるタスクはありません' }),
    mine.length > NOW_MAX ? h('button', {
      type: 'button', class: 'wf-tk-more', data: { key: 'now-more' },
      onclick: () => { view.moreNow = !view.moreNow; ctx.rerender(); }, text: view.moreNow ? '少なく表示' : `ほか${mine.length - NOW_MAX}件を表示`,
    }) : null,
    ai.length ? h('div', { class: 'wf-tk-ai' },
      h('button', {
        type: 'button', class: 'wf-tk-ai-btn', 'aria-expanded': String(view.showAi), data: { key: 'ai-toggle' },
        onclick: () => { view.showAi = !view.showAi; ctx.rerender(); },
      }, h('span', { class: 'wf-avatar wf-ai wf-tk-mini', 'aria-hidden': 'true', text: 'AI' }), `AI に任せているもの ${ai.length}件`, aiRunning ? h('span', { class: 'wf-muted', text: `作業中 ${aiRunning}件` }) : null),
      view.showAi ? ai.map((x) => row(x, today, ctx, colors, 'ai')) : null) : null);
}

// A count pressed: the tasks it counts, soonest due first.
function filterCard(open, today, ctx, colors) {
  const f = FILTERS.find((x) => x.key === view.filter);
  const list = open.filter((x) => f.keep(x.t, today)).sort(byDue(today));
  return h('section', { class: 'wf-tk-card', 'aria-label': f.head },
    head(f.head, list.length, h('button', { type: 'button', class: 'wf-btn-line wf-btn-small wf-tk-head-btn', data: { key: 'filter-off' }, onclick: () => { view.filter = null; ctx.rerender(); }, text: '今やるに戻る' })),
    ...list.map((x) => row(x, today, ctx, colors, 'f')),
    list.length ? null : h('p', { class: 'wf-tk-empty', text: `${f.head}のタスクはありません` }));
}

const progress = (g) => {
  const done = g.tasks.filter((t) => t.state === 'done').length;
  return { done, total: g.tasks.length, pct: g.tasks.length ? Math.round((done / g.tasks.length) * 100) : 0 };
};

// ゴールの進み: one line per goal (title, days left, bar, x/y, profile), and the tasks with no goal.
function goalsCard(goals, loose, today, ctx, colors) {
  const sorted = [...goals].sort((a, b) => (dueDay(a.due) ?? Infinity) - (dueDay(b.due) ?? Infinity));
  const line = (g) => {
    const { done, total, pct } = progress(g);
    const d = dueDay(g.due) ? daysFrom(today, dueDay(g.due)) : null;
    const key = `goal-${g.id}`;
    const on = view.sel?.kind === 'goal' && view.sel.id === g.id;
    return h('button', { type: 'button', class: ['wf-tk-gline', on && 'wf-tk-on'], 'aria-pressed': String(on), data: { key }, onclick: () => openItem('goal', g.id, key) },
      h('span', { class: 'wf-tk-gline-top' }, h('span', { class: 'wf-tk-gline-title', text: g.title }),
        d === null ? null : h('span', { class: 'wf-left', style: { color: dueColor(d) }, text: `${leftText(d)}${prov(g)}` })),
      h('span', { class: 'wf-tk-gline-meta' },
        h('span', { class: 'wf-bar wf-tk-gbar', 'aria-hidden': 'true' }, h('span', { class: ctx.first ? 'wf-bar-grow' : '', style: { width: `${pct}%` } })),
        h('span', { class: 'wf-tk-frac', text: `${done}/${total} 完了` }),
        profileChip(g.profile, colors)));
  };
  const looseOpen = loose.tasks.filter(isOpen).length;
  const on = view.sel?.kind === 'goal' && view.sel.id === 'none';
  return h('section', { class: 'wf-tk-card', 'aria-label': 'ゴールの進み' },
    head('ゴールの進み', goals.length),
    ...sorted.map(line),
    goals.length ? null : h('p', { class: 'wf-tk-empty', text: 'エージェントに「これをゴールに」と頼むと、ここに出ます' }),
    looseOpen ? h('button', { type: 'button', class: ['wf-tk-gline', 'wf-tk-gnone', on && 'wf-tk-on'], 'aria-pressed': String(on), data: { key: 'goal-none' }, onclick: () => openItem('goal', 'none', 'goal-none') },
      h('span', { class: 'wf-tk-gline-top' }, h('span', { class: 'wf-tk-gline-title', text: 'ゴールのないタスク' }), h('span', { class: 'wf-muted', text: `${looseOpen}件` }))) : null);
}

// A write from the panel (下調べを頼む, a rating): the button is off while it goes, and what
// went wrong is shown under it.
async function send(key, path, body) {
  if (view.busy) return;
  view.busy = key;
  view.problem = null;
  ctxNow.rerender();
  try {
    await ctxNow.api(path, { method: 'POST', body });
    view.busy = null;
    await ctxNow.refresh();
  } catch (err) {
    view.busy = null;
    view.problem = { key, text: err.body?.problems?.join(' ') ?? '保存できませんでした' };
    ctxNow.rerender();
  }
  document.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}
const problemFor = (keys) => (view.problem && keys.includes(view.problem.key) ? h('p', { class: 'wf-tk-problem', role: 'alert', text: view.problem.text }) : null);

// What the person made of a 下調べ. Pressing the one already on takes it back.
const RATINGS = [['useful', '役に立った'], ['duplicate', '二度手間'], ['off', '的外れ']];
function rating(p) {
  const keys = RATINGS.map(([k]) => `rate-${p.id}-${k}`);
  return h('div', { class: 'wf-tk-rate-wrap' },
    h('div', { class: 'wf-tk-rate', role: 'group', 'aria-label': 'この下調べの評価' },
      ...RATINGS.map(([k, label], i) => h('button', {
        type: 'button', class: 'wf-tk-rate-btn', 'aria-pressed': String(p.rating === k), disabled: Boolean(view.busy), data: { key: keys[i] },
        onclick: () => send(keys[i], `/preps/${p.id}/rating`, { rating: p.rating === k ? null : k }), text: label,
      })),
      p.rating && p.rated_by && p.rated_by !== 'web' ? h('span', { class: 'wf-muted', text: `${name(p.rated_by)} が評価` }) : null),
    problemFor(keys));
}

// 下調べを頼む: a 印 that sends the task to the front of the 下調べの候補.
function askPrep(t) {
  const key = 'prep-wanted';
  return h('div', { class: 'wf-tk-ask' },
    t.prep_wanted ? h('span', { class: 'wf-prep-tag', text: '下調べを頼んでいます' }) : null,
    h('button', {
      type: 'button', class: 'wf-btn-line wf-btn-small', disabled: Boolean(view.busy), data: { key },
      onclick: () => send(key, `/tasks/${encodeURIComponent(t.id)}/prep-wanted`, { wanted: !t.prep_wanted }),
      text: t.prep_wanted ? '頼むのをやめる' : '下調べを頼む',
    }),
    problemFor([key]));
}

// 下調べ, as what someone said: who (with their mark), when, the summary, the artifacts, what
// is still unknown, the next step and its rating. Newest first; one written in the last day is
// marked.
function artifact(a) {
  if (/^https?:\/\//i.test(a.url)) return h('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer', text: a.label ?? a.url });
  return [a.label ? `${a.label}: ` : null, h('code', { text: a.url })];
}
function preps(list, now) {
  if (!list?.length) return null;
  return h('section', { class: 'wf-tk-sec', 'aria-label': '下調べ' },
    h('h3', { text: '下調べ' }),
    ...list.map((p) => {
      const who = name(p.by);
      const fresh = now - Date.parse(p.created_at) < FRESH_MS;
      return h('div', { class: 'wf-tk-say' },
        h('span', { class: 'wf-avatar wf-tk-say-mark', 'aria-hidden': 'true', text: who.slice(0, 1).toUpperCase() }),
        h('div', { class: 'wf-tk-say-main' },
          h('div', { class: 'wf-tk-say-head' }, h('b', { text: `${who} の下調べ` }), h('span', { class: 'wf-muted', text: stamp(p.created_at) }), fresh ? h('span', { class: 'wf-prep-tag wf-prep-new', text: '新しい' }) : null),
          h('div', { class: 'wf-tk-bubble' },
            h('p', { class: 'wf-tk-say-text', text: p.summary }),
            p.artifacts.length ? h('div', { class: 'wf-tk-part' }, h('b', { text: '成果物' }), h('ul', {}, ...p.artifacts.map((a) => h('li', {}, artifact(a))))) : null,
            p.unknowns.length ? h('div', { class: 'wf-tk-part' }, h('b', { text: 'まだ分からないこと' }), h('ul', {}, ...p.unknowns.map((u) => h('li', { text: u })))) : null,
            p.next ? h('div', { class: 'wf-tk-part' }, h('b', { text: '次の一手' }), h('span', { text: p.next })) : null),
          p.id === undefined ? null : rating(p)));
    }));
}

function facts(...pairs) {
  return h('dl', { class: 'wf-tk-facts' }, ...pairs.filter(Boolean).flatMap(([k, v]) => [h('dt', { text: k }), h('dd', {}, v)]));
}

// A task in full: who, state, title, due, goal, what comes first, what it waits for or the
// next step, when it is done, the result, what it is, 下調べ and the records.
function taskDetail({ t, g }, today, ctx, colors) {
  const w = WHO[t.mode] ?? WHO.ai_worker;
  const d = left(t, today);
  let note = null;
  if (t.state === 'waiting' && (t.waiting_on || t.waiting_for)) note = ['待っているもの', t.waiting_on && t.waiting_for ? `${t.waiting_on}の「${t.waiting_for}」` : (t.waiting_on ?? t.waiting_for)];
  else if (t.state === 'deferred' && t.defer_until) {
    const r = dueDay(t.defer_until);
    note = ['見直す日', r ? mdw(r) : t.defer_until];
  } else if (t.next && isOpen(t)) note = ['次の一手', t.next];
  const goalBtn = g
    ? h('button', { type: 'button', class: 'wf-tk-link', data: { key: 'dt-goal' }, onclick: () => openItem('goal', g.id, null) }, goalLabel(g, t, colors))
    : goalLabel(null, t, colors);
  return h('div', { class: 'wf-tk-dt' },
    h('div', { class: 'wf-tk-dt-who' }, avatar(w), h('b', { text: w[0] }), chip(shown(t)), t.hold ? h('span', { class: 'wf-muted', text: `${t.hold.device} で作業中` }) : null),
    h('h2', { class: 'wf-tk-dt-title', text: t.title }),
    facts(
      ['期限', t.due ? h('span', {}, `${mdw(dueDay(t.due))}${prov(t)}`, isOpen(t) && d !== null ? h('span', { class: 'wf-tk-dt-left', style: { color: dueColor(d) }, text: leftText(d) }) : null) : '期限なし'],
      ['ゴール', goalBtn],
      t.open_before?.length ? ['先にやる', t.open_before.map((x) => `「${x.title}」`).join('')] : null,
      note,
      t.done_when ? ['完了の条件', t.done_when] : null,
      t.result ? ['成果', t.result] : null),
    isOpen(t) ? askPrep(t) : null,
    t.body ? h('section', { class: 'wf-tk-sec', 'aria-label': '説明' }, h('h3', { text: '説明' }), h('p', { class: 'wf-tk-text', text: t.body })) : null,
    preps(t.preps, ctx.now),
    t.log?.length ? h('section', { class: 'wf-tk-sec', 'aria-label': '記録' }, h('h3', { text: '記録' }),
      h('ul', { class: 'wf-tk-log' }, ...t.log.map((l) => h('li', {},
        h('span', { class: 'wf-tk-log-when', text: stamp(l.at) }),
        h('span', { class: 'wf-tk-log-what' }, h('b', { text: LOG[l.kind] ?? l.kind }), h('span', { class: 'wf-muted', text: name(l.by) }),
          l.note ? h('span', { class: 'wf-tk-log-note', text: l.note }) : null))))) : null);
}

function flowchart(g, from) {
  const tasks = g.tasks;
  const lay = layoutFlow(tasks.map((t) => ({ id: t.id, after: t.after, small: t.state === 'done' })), FLOW);
  const svg = s('svg', { width: lay.width, height: lay.height, viewBox: `0 0 ${lay.width} ${lay.height}`, 'aria-hidden': 'true' },
    s('path', { d: lay.edges.map((e) => e.d).join('') || 'M0 0', fill: 'none', 'stroke-width': 2, style: { stroke: 'var(--line)' } }),
    s('path', { d: lay.edges.map((e) => arrowHead(e.tipX, e.tipY)).join('') || 'M0 0', style: { fill: 'var(--line)' } }));
  const nodes = tasks.map((t) => {
    const { x, y, h: nh } = lay.nodes[t.id];
    const small = t.state === 'done';
    const key = `node-${t.id}`;
    return h('button', {
      type: 'button', class: ['wf-node', small && 'wf-node-small', small && 'wf-dim'], data: { key }, title: t.title,
      'aria-label': `${t.title}(${STATE[shown(t)]})`,
      style: { left: `${x}px`, top: `${y}px`, width: `${FLOW.NW}px`, height: `${nh}px` },
      onclick: () => openItem('task', t.id, key, from),
    }, small ? h('span', { class: 'wf-node-title' }, h('span', { class: 'wf-node-check', 'aria-hidden': 'true', text: '✓ ' }), t.title) : [chip(shown(t)), h('span', { class: 'wf-node-title', text: t.title })]);
  });
  return h('div', { class: 'wf-flowbox', data: { scroll: `flow-${g.id}` } }, h('div', { class: 'wf-flow', style: { width: `${lay.width}px`, height: `${lay.height}px` } }, svg, ...nodes));
}

// A goal in full: あるべき姿 (its first sentence, the rest folded), due, progress, and its tasks
// as a list (やる, 待ち, then 完了 folded) or as the chart.
function goalDetail(g, today, ctx, colors) {
  const { done, total, pct } = progress(g);
  const d = dueDay(g.due) ? daysFrom(today, dueDay(g.due)) : null;
  const real = g.id !== 'none';
  const items = g.tasks.map((t) => ({ t, g: real ? g : null }));
  const doing = items.filter((x) => isOpen(x.t) && !['waiting', 'deferred'].includes(x.t.state)).sort(byDue(today));
  const waiting = items.filter((x) => ['waiting', 'deferred'].includes(x.t.state)).sort(byDue(today));
  const closed = items.filter((x) => x.t.state === 'done');
  const r = (x) => row(x, today, ctx, colors, 'g', { goal: false, from: g.id });
  const o = g.outcome ? lead(g.outcome) : null;
  const list = [
    h('h3', { text: `やる ${doing.length}件` }), ...doing.map(r),
    doing.length ? null : h('p', { class: 'wf-tk-empty', text: 'いまやるタスクはありません' }),
    waiting.length ? [h('h3', { text: `待ち ${waiting.length}件` }), ...waiting.map(r)] : null,
    closed.length ? fold(`done-${g.id}`, `完了 ${closed.length}件`, ...closed.map(r)) : null,
  ];
  return h('div', { class: 'wf-tk-dt' },
    h('div', { class: 'wf-tk-dt-who' }, real ? profileChip(g.profile, colors, 15) : null, h('span', { class: 'wf-muted', text: real ? 'ゴール' : 'ゴールなし' })),
    h('h2', { class: 'wf-tk-dt-title', text: g.title }),
    o ? h('section', { class: 'wf-tk-sec', 'aria-label': 'あるべき姿' }, h('h3', { text: 'あるべき姿' }), h('p', { class: 'wf-tk-text', text: o.head }),
      o.rest ? fold(`outcome-${g.id}`, '続きを読む', h('p', { class: 'wf-tk-text', text: o.rest })) : null) : null,
    real ? facts(
      ['期日', g.due ? h('span', {}, `${mdw(dueDay(g.due))}${prov(g)}`, h('span', { class: 'wf-tk-dt-left', style: { color: dueColor(d) }, text: leftText(d) })) : '期日なし'],
      ['進み', h('span', { class: 'wf-tk-dt-prog' }, h('span', { class: 'wf-bar wf-tk-gbar', 'aria-hidden': 'true' }, h('span', { style: { width: `${pct}%` } })), `${done}/${total} 完了`)]) : null,
    h('section', { class: 'wf-tk-sec wf-tk-gtasks', 'aria-label': 'タスク' },
      real && total ? h('div', { class: 'wf-seg wf-tk-seg', role: 'group', 'aria-label': '見せ方' },
        ...[['list', '一覧'], ['flow', '図']].map(([k, label]) => h('button', {
          type: 'button', 'aria-pressed': String(view.goalView === k), data: { key: `gv-${k}` },
          onclick: () => { view.goalView = k; ctxNow.rerender(); }, text: label,
        }))) : null,
      real && view.goalView === 'flow' && total ? flowchart(g, g.id) : list));
}

function panel(goals, loose, items, today, ctx, colors) {
  if (!view.sel) return null;
  let body = null;
  let back = null;
  if (view.sel.kind === 'task') {
    const it = items.find((x) => x.t.id === view.sel.id);
    if (it) body = taskDetail(it, today, ctx, colors);
    back = (view.from === 'none' ? loose : goals.find((g) => g.id === view.from)) ?? null;
  } else {
    const g = view.sel.id === 'none' ? loose : goals.find((x) => x.id === view.sel.id);
    if (g) body = goalDetail(g, today, ctx, colors);
  }
  // What was open is gone (closed or removed since).
  if (!body) {
    view.sel = null;
    return null;
  }
  const fresh = view.fresh;
  view.fresh = false;
  return h('aside', {
    class: ['wf-tk-panel', fresh && 'wf-tk-panel-in', view.sel.kind === 'goal' && view.goalView === 'flow' && 'wf-tk-panel-wide'],
    'aria-label': '詳細', data: { scroll: `panel-${view.sel.kind}-${view.sel.id}` },
  },
  h('div', { class: 'wf-tk-panel-bar' },
    back ? h('button', {
      type: 'button', class: 'wf-btn-line wf-btn-small wf-tk-back', data: { key: 'panel-back' },
      onclick: () => { view.sel = { kind: 'goal', id: back.id }; view.from = null; ctx.rerender(); },
    }, icon('back', 15, 2), h('span', { text: back.title })) : null,
    h('span', { class: 'wf-head-gap' }),
    h('button', { type: 'button', class: 'wf-btn-line wf-btn-small', data: { key: 'panel-close' }, onclick: closePanel, text: '閉じる' })),
  body);
}

function render(data, ctx) {
  ctxNow = ctx;
  bindEsc();
  const today = ctx.now;
  const colors = data.profiles;
  const goals = data.goals;
  const loose = { id: 'none', title: 'ゴールのないタスク', profile: null, outcome: null, due: null, tasks: data.unassigned };
  const header = ctx.head('タスク');
  if (!goals.length && !data.unassigned.length) {
    return h('div', { class: 'wf-page-tasks' }, header, ctx.banner(),
      h('div', { class: 'wf-surface wf-big-empty', text: 'エージェントに「これをゴールに」と頼むと、ここに出ます' }));
  }
  const items = [...goals.flatMap((g) => g.tasks.map((t) => ({ t, g }))), ...data.unassigned.map((t) => ({ t, g: null }))];
  const open = items.filter((x) => isOpen(x.t));
  const side = panel(goals, loose, items, today, ctx, colors);
  return h('div', { class: 'wf-page-tasks' }, header, ctx.banner(),
    band(open, today, ctx),
    h('div', { class: ['wf-tk-body', side && 'wf-tk-with-panel'] },
      h('div', { class: 'wf-tk-main', data: { scroll: 'tasks-main' } },
        view.filter ? filterCard(open, today, ctx, colors) : nowCard(items, today, ctx, colors),
        goalsCard(goals, loose, today, ctx, colors)),
      side));
}

function skeleton(ctx) {
  const r = () => h('div', { class: 'wf-tk-row' }, skel('34px', '34px', { borderRadius: '999px' }), h('span', { class: 'wf-tk-row-main' }, skel('70%', '15px'), skel('40%', '13px')));
  const count = () => h('div', { class: 'wf-tk-count' }, skel('50px', '13px'), skel('40px', '24px'));
  return h('div', { class: 'wf-page-tasks' }, ctx.head('タスク'), ctx.banner(),
    h('div', { class: 'wf-tk-counts', 'aria-busy': 'true' }, count(), count(), count(), count()),
    h('div', { class: 'wf-tk-body', 'aria-busy': 'true' },
      h('div', { class: 'wf-tk-main' },
        h('section', { class: 'wf-tk-card' }, h('div', { class: 'wf-tk-head' }, h('h2', { text: '今やる' })), r(), r(), r()),
        h('section', { class: 'wf-tk-card' }, h('div', { class: 'wf-tk-head' }, h('h2', { text: 'ゴールの進み' })), skel('100%', '44px'), skel('100%', '44px')))));
}

export default { load, render, skeleton };
