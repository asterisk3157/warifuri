// タスク: every goal with its flowchart, soonest due first. At the top, how many tasks are open
// (and overdue, due within 3 days, waiting); pressing a count lifts the boxes it counts in the
// charts and dims the rest, and the goals with none of them fold and go to the end. A box opens
// the task's detail in a panel that slides in from the right over the page.
//
// The screen is drawn again every 30 seconds: what is open (folded goals, the panel) lives in
// view, and every scroll box and control has a data key, so a redraw keeps them. While the
// panel is open the page is not drawn again (busy), so the panel stays as it is.

import { h, s, skel, profileColor, dueDay, daysFrom, md, mdw, hhmm2 } from '../ui.js';
import { layoutFlow, arrowHead } from '../flow.js';

const view = {
  filter: null, // a key of FILTERS, or null
  sel: null, // the id of the task shown in the panel
  opener: null, // the data key to give focus back to when the panel closes
  fresh: false, // the panel was just opened (it slides in once, not on every redraw)
  closing: false, // the panel is sliding out
  fold: new Map(), // goal id → true (folded) or false (open), when the person pressed it
  peek: new Set(), // goals with nothing the filter counts, opened while the filter is on
  open: new Set(), // folded parts of the panel that are open
  busy: null, // the data key of the button whose write is on its way
  problem: null, // { key, text } when a write was refused
};

const load = (api) => api('/tasks');

const STATE = { done: '完了', running: '作業中', ready: '着手可能', waiting: '待ち', blocked: '順番待ち', deferred: '先送り', discarded: '破棄' };
const WHO = { human: ['あなた', 'あ', false], ai_worker: ['AIエージェント', 'AI', true], human_with_ai: ['あなた + AI', 'あ', false] };
const CLOSED = new Set(['done', 'discarded']);
// States a box does not name: ready is the usual one, so only the others are worth saying.
const QUIET = new Set(['ready']);
const FRESH_MS = 24 * 60 * 60 * 1000;
// Who wrote a 下調べ or a record, by device name.
const NAMES = { muse: 'Muse', secretary: '秘書', human: 'あなた', web: 'あなた' };
const LOG = { created: '作成', started: '着手', released: '手放した', waiting: '待ちにした', deferred: '先送り', resumed: '再開', done: '完了', discarded: 'やめた', reopened: '開き直した', prepped: '下調べ' };
// The chart's boxes: wide enough for a title in two or three lines, a done one a thin strip.
const FLOW = { NW: 232, NH: 92, SH: 34, DH: 16, GX: 34, GY: 12 };

// A task's state as shown: ready with an open task before it is 順番待ち.
const shown = (t) => (t.blocked ? 'blocked' : t.state);
const isOpen = (t) => !CLOSED.has(t.state);
const left = (t, today) => {
  const d = dueDay(t.due);
  return d ? daysFrom(today, d) : null;
};

const FILTERS = [
  { key: 'all', label: 'すべて', keep: () => true },
  { key: 'over', label: '期限切れ', keep: (t, today) => left(t, today) !== null && left(t, today) < 0 },
  { key: 'soon', label: '3日以内', keep: (t, today) => left(t, today) !== null && left(t, today) >= 0 && left(t, today) <= 3 },
  { key: 'wait', label: '待ち', keep: (t) => t.state === 'waiting' },
];
const hit = (t, today) => {
  const f = FILTERS.find((x) => x.key === view.filter);
  return Boolean(f) && isOpen(t) && f.keep(t, today);
};

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

// How far a goal has come, and whether every task in it is done.
export function progress(tasks) {
  const done = tasks.filter((t) => t.state === 'done').length;
  return { done, total: tasks.length, pct: tasks.length ? Math.round((done / tasks.length) * 100) : 0, finished: tasks.length > 0 && done === tasks.length };
}

// The goals in the order they are shown: soonest due first (no due last), the finished ones at
// the end; with a filter on, the goals with no task it counts go after the rest. hits(g): how
// many of g's tasks the filter counts.
export function orderGoals(goals, hits = null) {
  const due = (g) => (g.due ? Date.parse(g.due.length === 10 ? `${g.due}T00:00:00Z` : g.due) : Infinity);
  return goals
    .map((g, i) => ({ g, i, finished: progress(g.tasks).finished, none: hits ? hits(g) === 0 : false }))
    .sort((a, b) => Number(a.finished) - Number(b.finished) || Number(a.none) - Number(b.none) || due(a.g) - due(b.g) || a.i - b.i)
    .map((x) => x.g);
}

// A part of the panel that folds, whose open state outlives the redraw.
function fold(key, summary, ...body) {
  return h('details', {
    class: 'wf-tk-fold', open: view.open.has(key),
    ontoggle: (e) => (e.currentTarget.open ? view.open.add(key) : view.open.delete(key)),
  }, h('summary', { data: { key: `fold-${key}` }, text: summary }), ...body);
}

// The panel. key: the box pressed, to give focus back to on close; a move inside the panel
// (key null) keeps the first one.
let ctxNow = null;
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
function openTask(id, key) {
  if (key) view.opener = key;
  view.fresh = !view.sel;
  view.closing = false;
  view.sel = id;
  ctxNow.rerender();
  requestAnimationFrame(() => document.querySelector('[data-key="panel-close"]')?.focus({ preventScroll: true }));
}
function closePanel() {
  if (!view.sel || view.closing) return;
  const done = () => {
    const back = view.opener;
    view.sel = null;
    view.opener = null;
    view.closing = false;
    ctxNow.rerender();
    if (back) {
      const el = document.querySelector(`[data-key="${CSS.escape(back)}"]`);
      el?.focus({ preventScroll: true });
      el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
  };
  view.closing = true;
  document.querySelector('.wf-tk-panel')?.classList.add('wf-tk-panel-out');
  document.querySelector('.wf-tk-veil')?.classList.add('wf-tk-veil-out');
  setTimeout(done, reduced() ? 0 : 170);
}
let keysBound = false;
function bindKeys() {
  if (keysBound) return;
  keysBound = true;
  document.addEventListener('keydown', (e) => {
    if (!view.sel || !document.querySelector('.wf-page-tasks')) return;
    // The about dialog comes first.
    if (document.getElementById('wf-layer')?.childElementCount) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closePanel();
    } else if (e.key === 'Tab') {
      // Focus stays in the panel while it is open.
      const panelEl = document.querySelector('.wf-tk-panel');
      if (!panelEl) return;
      const items = [...panelEl.querySelectorAll('a[href], button:not([disabled]), summary')];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!panelEl.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
}

function prepTag(t, now) {
  const p = t.preps?.[0];
  if (!p) return null;
  const fresh = now - Date.parse(p.created_at) < FRESH_MS;
  return h('span', { class: ['wf-node-prep', fresh && 'wf-node-prep-new'], text: '下調べ' });
}

const dot = (profile, colors) => h('span', {
  class: 'wf-dot', style: { background: profileColor(profile, colors) }, role: 'img', 'aria-label': profile ?? 'プロフィールなし', title: profile ?? 'プロフィールなし',
});

// The box's outline: blue when a 下調べ is waiting for it, else green when it can be started.
const edge = (t, st) => (!isOpen(t) ? [] : t.preps?.length ? ['wf-node-prepped'] : st === 'ready' ? ['wf-node-ready'] : []);

// One task as a box: its state (left out when it is simply ready), the AI's mark, 下調べ, the
// days left (red only when past) and the title, in plain grey text. A done one is a thin strip with a check. A filter lifts or dims it.
function box(t, today, ctx, key, style = null) {
  const closed = t.state === 'done';
  const d = left(t, today);
  const st = shown(t);
  const on = view.sel === t.id;
  const w = WHO[t.mode] ?? WHO.ai_worker;
  const lit = view.filter ? (hit(t, today) ? 'wf-node-hit' : 'wf-node-fade') : null;
  const near = d !== null && d <= 3;
  return h('button', {
    type: 'button', class: ['wf-node', closed && 'wf-node-small', closed && 'wf-dim', lit, !style?.left && 'wf-node-loose', ...edge(t, st)],
    data: { key }, 'aria-pressed': String(on), title: t.title,
    'aria-label': `${t.title}、${STATE[st] ?? st}${closed || d === null ? '' : `、${leftText(d)}`}`,
    style, onclick: () => openTask(t.id, key),
  }, closed
    ? h('span', { class: 'wf-node-title' }, h('span', { class: 'wf-node-check', 'aria-hidden': 'true', text: '✓ ' }), t.title)
    : [
      h('span', { class: 'wf-node-meta', 'aria-hidden': 'true' },
        QUIET.has(st) ? null : h('span', { class: ['wf-node-st', st === 'running' && 'wf-node-st-on'], text: STATE[st] ?? st }),
        w[2] ? h('span', { class: 'wf-node-st', text: 'AI' }) : null,
        prepTag(t, ctx.now),
        d === null ? null : h('span', { class: ['wf-node-left', d < 0 && 'wf-node-over', near && 'wf-node-near'], text: leftText(d) })),
      h('span', { class: 'wf-node-title', text: t.title }),
    ]);
}

// A goal's tasks split for the chart: the ones joined by an order (drawn as the flowchart) and
// the ones on their own (laid side by side, so a goal of many loose tasks is not one tall
// column). Open tasks first in each, so done ones sink to the foot of a column.
export function splitChart(tasks) {
  const ids = new Set(tasks.map((t) => t.id));
  const joined = new Set();
  for (const t of tasks) {
    for (const a of t.after ?? []) {
      if (!ids.has(a) || a === t.id) continue;
      joined.add(a);
      joined.add(t.id);
    }
  }
  const openFirst = (list) => [...list.filter(isOpen), ...list.filter((t) => !isOpen(t))];
  return { linked: openFirst(tasks.filter((t) => joined.has(t.id))), alone: openFirst(tasks.filter((t) => !joined.has(t.id))) };
}

function flowchart(g, today, ctx) {
  const { linked, alone } = splitChart(g.tasks);
  let chart = null;
  if (linked.length) {
    const lay = layoutFlow(linked.map((t) => ({ id: t.id, after: t.after, small: t.state === 'done' })), FLOW);
    const svg = s('svg', { width: lay.width, height: lay.height, viewBox: `0 0 ${lay.width} ${lay.height}`, 'aria-hidden': 'true' },
      s('path', { d: lay.edges.map((e) => e.d).join('') || 'M0 0', fill: 'none', 'stroke-width': 2, style: { stroke: 'var(--line)' } }),
      s('path', { d: lay.edges.map((e) => arrowHead(e.tipX, e.tipY)).join('') || 'M0 0', style: { fill: 'var(--line)' } }));
    const nodes = linked.map((t) => {
      const { x, y, h: nh } = lay.nodes[t.id];
      return box(t, today, ctx, `node-${t.id}`, { left: `${x}px`, top: `${y}px`, width: `${FLOW.NW}px`, height: `${nh}px` });
    });
    chart = h('div', { class: 'wf-flow', style: { width: `${lay.width}px`, height: `${lay.height}px` } }, svg, ...nodes);
  }
  const openAlone = alone.filter(isOpen);
  const doneAlone = alone.filter((t) => !isOpen(t));
  const free = alone.length ? h('div', { class: 'wf-tk-free' },
    openAlone.length ? h('div', { class: 'wf-tk-free-row' }, ...openAlone.map((t) => box(t, today, ctx, `node-${t.id}`, { width: `${FLOW.NW}px`, height: `${FLOW.NH}px` }))) : null,
    doneAlone.length ? h('div', { class: 'wf-tk-free-row' }, ...doneAlone.map((t) => box(t, today, ctx, `node-${t.id}`, { width: `${FLOW.NW}px`, height: `${FLOW.SH}px` }))) : null) : null;
  return h('div', { class: 'wf-flowbox', data: { scroll: `flow-${g.id}` }, role: 'group', 'aria-label': `${g.title}のタスク` },
    h('div', { class: 'wf-tk-chart' }, chart, free));
}

// The counts at the top, as one quiet row of words; each one lifts what it counts in the charts.
// A count of none is left out (unless it is the one on), so the row says only what is there.
function band(open, today, ctx) {
  return h('div', { class: 'wf-tk-counts', role: 'group', 'aria-label': '絞り込み' },
    ...FILTERS.map((f) => {
      const n = open.filter((t) => f.keep(t, today)).length;
      const on = view.filter === f.key || (f.key === 'all' && !view.filter);
      if (!n && !on) return null;
      return h('button', {
        type: 'button', class: 'wf-tk-count', 'aria-pressed': String(on), data: { key: `count-${f.key}` },
        onclick: () => { view.filter = f.key === 'all' || view.filter === f.key ? null : f.key; view.peek.clear(); ctx.rerender(); },
      }, h('span', { class: 'wf-tk-count-label', text: f.label }), h('span', { class: ['wf-tk-count-n', f.key === 'over' && 'wf-tk-n-red'], text: String(n) }));
    }).filter(Boolean));
}

const folded = (g, auto) => (view.fold.has(g.id) ? view.fold.get(g.id) : auto);

// One goal: the head (title, profile, days left and due, progress) that folds it, the first
// sentence of あるべき姿, and its chart.
function goalSection(g, today, ctx, colors) {
  const real = g.id !== 'none';
  const { done, total, pct, finished } = progress(g.tasks);
  const hits = view.filter ? g.tasks.filter((t) => hit(t, today)).length : null;
  // A finished goal, and with a filter on a goal with nothing it counts, start folded.
  const away = Boolean(view.filter) && !hits;
  const shut = away ? !view.peek.has(g.id) : folded(g, finished);
  const d = real && dueDay(g.due) ? daysFrom(today, dueDay(g.due)) : null;
  const key = `ghead-${g.id}`;
  const body = `gbody-${g.id}`;
  const o = g.outcome ? lead(g.outcome).head : '';
  const openTasks = g.tasks.filter(isOpen);
  const doneTasks = g.tasks.filter((t) => !isOpen(t));
  return h('section', { class: ['wf-tk-goal', shut && 'wf-tk-goal-shut', away && 'wf-tk-goal-none'], 'aria-label': g.title },
    h('button', {
      type: 'button', class: 'wf-tk-ghead', 'aria-expanded': String(!shut), 'aria-controls': body, data: { key },
      onclick: () => {
        if (away) (shut ? view.peek.add(g.id) : view.peek.delete(g.id));
        else view.fold.set(g.id, !shut);
        ctx.rerender();
      },
    },
    h('span', { class: 'wf-tk-chev', 'aria-hidden': 'true' }),
    real ? dot(g.profile, colors) : null,
    h('span', { class: 'wf-tk-gtitle', text: g.title }),
    h('span', { class: 'wf-tk-gmeta' },
      real ? (g.due
        ? h('span', { class: 'wf-tk-gdue' }, h('span', { class: ['wf-tk-gleft', !finished && d !== null && d < 0 && 'wf-tk-n-red'], text: finished ? '完了' : leftText(d) }), h('small', { text: `${mdw(dueDay(g.due))}${prov(g)}` }))
        : h('small', { class: 'wf-tk-gdue', text: '期日なし' })) : h('small', { class: 'wf-tk-gdue', text: `${openTasks.length}件` }),
      real ? h('span', { class: 'wf-tk-gprog' },
        h('span', { class: 'wf-tk-frac', text: `${done}/${total}` }),
        h('span', { class: 'wf-bar wf-tk-gbar', 'aria-hidden': 'true' }, h('span', { class: ctx.first ? 'wf-bar-grow' : '', style: { width: `${pct}%` } }))) : null)),
    shut ? null : h('div', { class: 'wf-tk-gbody', id: body },
      o ? h('p', { class: 'wf-tk-gout', title: g.outcome, text: o }) : null,
      !total ? h('p', { class: 'wf-tk-empty', text: 'タスクはまだありません' })
        : real ? flowchart(g, today, ctx)
          : h('div', { class: 'wf-tk-loose' }, ...openTasks.map((t) => box(t, today, ctx, `box-${t.id}`)), ...doneTasks.map((t) => box(t, today, ctx, `box-${t.id}`)))));
}

// A write from the panel (下調べを頼む, a rating): the button is off while it goes, and what
// went wrong is shown under it. The page is busy while the panel is open, so it is drawn here.
async function send(key, path, body) {
  if (view.busy) return;
  view.busy = key;
  view.problem = null;
  ctxNow.rerender();
  try {
    await ctxNow.api(path, { method: 'POST', body });
    view.busy = null;
    await ctxNow.refresh();
    ctxNow.rerender();
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

// Pressing the goal in the panel closes it and goes to that goal on the page.
function toGoal(g) {
  view.fold.set(g.id, false);
  view.opener = `ghead-${g.id}`;
  closePanel();
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
  const goalName = h('span', { class: 'wf-tk-goalname' }, dot(g?.profile ?? t.profile ?? null, colors), g ? g.title : 'ゴールなし');
  const before = (t.open_before ?? []).map((x) => (ctx.known.has(x.id)
    ? h('button', { type: 'button', class: 'wf-tk-link', data: { key: `dt-before-${x.id}` }, onclick: () => openTask(x.id, null), text: x.title })
    : h('span', { text: x.title })));
  return h('div', { class: 'wf-tk-dt' },
    h('div', { class: 'wf-tk-dt-who' }, avatar(w), h('b', { text: w[0] }), chip(shown(t)), t.hold ? h('span', { class: 'wf-muted', text: `${t.hold.device} で作業中` }) : null),
    h('h2', { class: 'wf-tk-dt-title', id: 'wf-tk-panel-title', text: t.title }),
    facts(
      ['期限', t.due ? h('span', {}, `${mdw(dueDay(t.due))}${prov(t)}`, isOpen(t) && d !== null ? h('span', { class: 'wf-tk-dt-left', style: { color: dueColor(d) }, text: leftText(d) }) : null) : '期限なし'],
      ['ゴール', g ? h('button', { type: 'button', class: 'wf-tk-link', data: { key: 'dt-goal' }, onclick: () => toGoal(g) }, goalName) : goalName],
      before.length ? ['先にやる', h('span', { class: 'wf-tk-before' }, ...before)] : null,
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

// The panel over the page, from the left, with the veil behind it.
function panel(items, today, ctx, colors) {
  if (!view.sel) return null;
  const it = items.find((x) => x.t.id === view.sel);
  // What was open is gone (removed since).
  if (!it) {
    view.sel = null;
    return null;
  }
  const fresh = view.fresh;
  view.fresh = false;
  return [
    h('div', { class: ['wf-tk-veil', fresh && 'wf-tk-veil-in'], 'aria-hidden': 'true', onclick: closePanel }),
    h('aside', {
      class: ['wf-tk-panel', fresh && 'wf-tk-panel-in'], role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'wf-tk-panel-title',
      data: { scroll: `panel-${view.sel}` },
    },
    h('div', { class: 'wf-tk-panel-bar' },
      h('span', { class: 'wf-tk-panel-kind', text: 'タスク' }),
      h('span', { class: 'wf-head-gap' }),
      h('button', { type: 'button', class: 'wf-btn-line wf-btn-small', data: { key: 'panel-close' }, onclick: closePanel, text: '閉じる' })),
    taskDetail(it, today, ctx, colors)),
  ];
}

function render(data, ctx) {
  ctxNow = ctx;
  bindKeys();
  const today = ctx.now;
  const colors = data.profiles;
  const header = ctx.head('タスク');
  if (!data.goals.length && !data.unassigned.length) {
    return h('div', { class: 'wf-page-tasks' }, header, ctx.banner(),
      h('div', { class: 'wf-surface wf-big-empty', text: 'エージェントに「これをゴールに」と頼むと、ここに出ます' }));
  }
  const items = [...data.goals.flatMap((g) => g.tasks.map((t) => ({ t, g }))), ...data.unassigned.map((t) => ({ t, g: null }))];
  const open = items.filter((x) => isOpen(x.t)).map((x) => x.t);
  const c = { ...ctx, known: new Set(items.map((x) => x.t.id)) };
  const goals = orderGoals(data.goals, view.filter ? (g) => g.tasks.filter((t) => hit(t, today)).length : null);
  const loose = { id: 'none', title: 'ゴールのないタスク', profile: null, outcome: null, due: null, tasks: data.unassigned };
  return h('div', { class: 'wf-page-tasks' }, header, ctx.banner(),
    band(open, today, ctx),
    h('div', { class: 'wf-tk-main', data: { scroll: 'tasks-main' } },
      ...goals.map((g) => goalSection(g, today, c, colors)),
      data.unassigned.length ? goalSection(loose, today, c, colors) : null),
    panel(items, today, c, colors));
}

function skeleton(ctx) {
  const count = () => h('div', { class: 'wf-tk-count' }, skel('64px', '14px'));
  const goal = () => h('section', { class: 'wf-tk-goal' },
    h('div', { class: 'wf-tk-ghead' }, skel('40%', '18px')),
    h('div', { class: 'wf-tk-gbody' }, skel('60%', '14px'), skel('100%', '120px', { borderRadius: '10px' })));
  return h('div', { class: 'wf-page-tasks' }, ctx.head('タスク'), ctx.banner(),
    h('div', { class: 'wf-tk-counts', 'aria-busy': 'true' }, count(), count(), count(), count()),
    h('div', { class: 'wf-tk-main', 'aria-busy': 'true' }, goal(), goal()));
}

// While the panel is open, the 30-second reading does not draw the page again.
const busy = () => Boolean(view.sel);

export default { load, render, skeleton, busy };
