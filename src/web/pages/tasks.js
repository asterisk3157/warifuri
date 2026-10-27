// タスク: the open goals, each with its flowchart and tasks, and the tasks with no goal.

import { h, s, icon, skel, profileChip, dueDay, daysFrom, md } from '../ui.js';
import { layoutFlow, arrowHead, SIZES } from '../flow.js';

const view = { filter: 0, goal: null, hl: null };

const load = (api) => api('/tasks');

const STATE = { done: '完了', running: '作業中', ready: '着手可能', waiting: '待ち', blocked: '順番待ち', deferred: '先送り', discarded: '破棄' };
const WHO = { human: ['あなた', 'あ', false], ai_worker: ['AIエージェント', 'AI', true], human_with_ai: ['あなた + AI', 'あ', false] };
const FILTERS = ['すべて', '期限切れ', '3日以内', '着手可能'];

// A task's state as shown: ready with an open task before it is 順番待ち.
const shown = (t) => (t.blocked ? 'blocked' : t.state);
const left = (t, today) => {
  const d = dueDay(t.due);
  return d ? daysFrom(today, d) : null;
};
const KEEP = [
  () => true,
  (t, today) => t.state !== 'done' && left(t, today) !== null && left(t, today) < 0,
  (t, today) => t.state !== 'done' && left(t, today) !== null && left(t, today) >= 0 && left(t, today) <= 3,
  (t) => shown(t) === 'ready',
];

const dueColor = (d) => (d === null ? '#8e8e93' : d < 0 ? '#c4282e' : d <= 3 ? '#9a5a00' : '#6e6e73');
const leftText = (d) => (d === null ? '' : d < 0 ? `${-d}日過ぎ` : d === 0 ? '今日まで' : `残り${d}日`);
const prov = (x) => (x.due_provisional ? '（仮）' : '');
const chip = (st, extra) => h('span', { class: `wf-state wf-st-${st}`, text: STATE[st] ?? st, ...extra });

function goalButton(g, today, colors, ctx) {
  const done = g.tasks.filter((t) => t.state === 'done').length;
  const total = g.tasks.length;
  const nexts = g.tasks.filter((t) => shown(t) === 'ready').map((t) => t.title);
  const d = dueDay(g.due) ? daysFrom(today, dueDay(g.due)) : null;
  const pct = total ? Math.round((done / total) * 100) : 0;
  return h('button', { type: 'button', class: 'wf-goal-btn', 'aria-pressed': String(view.goal === g.id), data: { key: `goal-${g.id}` }, onclick: () => { view.goal = g.id; view.hl = null; ctx.rerender(); } },
    h('span', { class: 'wf-goal-top' }, h('span', { class: 'wf-goal-title', text: g.title }), d === null ? null : h('span', { class: 'wf-left', style: { color: dueColor(d) }, text: `${leftText(d)}${prov(g)}` })),
    h('span', { class: 'wf-goal-meta' }, profileChip(g.profile, colors), `${done}/${total} 完了`),
    h('span', { class: 'wf-bar', 'aria-hidden': 'true' }, h('span', { class: ctx.first ? 'wf-bar-grow' : '', style: { width: `${pct}%` } })),
    nexts.length ? h('span', { class: 'wf-goal-next' }, h('b', { text: '着手可能' }), ...nexts.slice(0, 3).map((n) => h('span', { class: 'wf-n', text: `· ${n}` })), nexts.length > 3 ? h('span', { text: `ほか${nexts.length - 3}件` }) : null) : null);
}

function flowchart(g, ctx) {
  const tasks = g.tasks;
  const lay = layoutFlow(tasks.map((t) => ({ id: t.id, after: t.after, small: t.state === 'done' })));
  const hl = tasks.some((t) => t.id === view.hl) ? view.hl : null;
  const near = new Set();
  if (hl) {
    near.add(hl);
    for (const t of tasks) {
      if (t.id === hl) t.after.forEach((a) => near.add(a));
      if (t.after.includes(hl)) near.add(t.id);
    }
  }
  const seg = { lines: '', heads: '', hlLines: '', hlHeads: '' };
  for (const e of lay.edges) {
    const on = hl && (e.from === hl || e.to === hl);
    seg[on ? 'hlLines' : 'lines'] += e.d;
    seg[on ? 'hlHeads' : 'heads'] += arrowHead(e.tipX, e.tipY);
  }
  const svg = s('svg', { width: lay.width, height: lay.height, viewBox: `0 0 ${lay.width} ${lay.height}`, 'aria-hidden': 'true' },
    s('path', { d: seg.lines || 'M0 0', fill: 'none', stroke: '#d2d2d7', 'stroke-width': 2 }),
    s('path', { d: seg.heads || 'M0 0', fill: '#d2d2d7' }),
    s('path', { d: seg.hlLines || 'M0 0', fill: 'none', stroke: '#8cc4ea', 'stroke-width': 2.5 }),
    s('path', { d: seg.hlHeads || 'M0 0', fill: '#8cc4ea' }));
  const nodes = tasks.map((t) => {
    const { x, y, h: nh } = lay.nodes[t.id];
    const me = t.id === hl;
    const small = t.state === 'done';
    const dim = hl ? !near.has(t.id) : t.state === 'done';
    return h('button', {
      type: 'button', class: ['wf-node', dim && 'wf-dim', small && 'wf-node-small'], 'aria-pressed': String(me), data: { key: `node-${t.id}` },
      'aria-label': `${t.title}(${STATE[shown(t)]})`,
      style: { left: `${x}px`, top: `${y}px`, width: `${SIZES.NW}px`, height: `${nh}px` },
      onclick: () => { view.hl = me ? null : t.id; ctx.rerender(); },
    }, small ? h('span', { class: 'wf-node-title' }, h('span', { class: 'wf-node-check', 'aria-hidden': 'true', text: '✓ ' }), t.title) : [chip(shown(t)), h('span', { class: 'wf-node-title', text: t.title })]);
  });
  return h('div', { class: 'wf-flowbox', data: { scroll: `flow-${g.id}` } }, h('div', { class: 'wf-flow', style: { width: `${lay.width}px`, height: `${lay.height}px` } }, svg, ...nodes));
}

function taskRow(t, today) {
  const w = WHO[t.mode] ?? WHO.ai_worker;
  const closed = t.state === 'done';
  const d = left(t, today);
  let note = null;
  if (t.state === 'waiting' && (t.waiting_on || t.waiting_for)) note = t.waiting_on && t.waiting_for ? `${t.waiting_on}の「${t.waiting_for}」を待っています` : `${t.waiting_on ?? t.waiting_for}を待っています`;
  else if (t.state === 'deferred' && t.defer_until) note = `${dueDay(t.defer_until) ? md(dueDay(t.defer_until)) : t.defer_until} に見直す`;
  else if (t.next && !closed) note = `次の一手: ${t.next}`;
  const before = t.open_before.length ? `${t.open_before.map((x) => `「${x.title}」`).join('')}の後` : null;
  return h('div', { class: ['wf-task', closed && 'wf-closed', view.hl === t.id && 'wf-hl'] },
    h('span', { class: ['wf-avatar', w[2] && 'wf-ai'], 'aria-hidden': 'true', text: w[1] }),
    h('span', { class: 'wf-task-main' },
      h('span', { class: 'wf-task-meta' }, h('b', { text: w[0] }), chip(shown(t)), t.hold ? h('span', { text: `@${t.hold.device}` }) : null),
      h('span', { class: 'wf-task-title', text: t.title }),
      before ? h('span', { class: 'wf-task-note' }, icon('after', 14, 2), before) : null,
      note ? h('span', { class: 'wf-task-note', text: note }) : null),
    h('span', { class: 'wf-task-due' },
      h('span', { class: 'wf-left', style: { color: closed || d === null ? '#8e8e93' : dueColor(d) }, text: closed ? '完了' : leftText(d) }),
      h('small', { text: t.due ? `期限 ${md(dueDay(t.due))}${prov(t)}` : '期限なし' })));
}

// The task picked in the flowchart, in full: who, state, title, before it, note, due, what it
// is (body), when it is done (done_when), and the result once closed.
function detail(t, today) {
  if (!t) return h('div', { class: 'wf-detail wf-detail-empty', text: '図のタスクを押すと、ここにくわしく出ます' });
  return h('div', { class: 'wf-detail' },
    taskRow(t, today),
    t.done_when ? h('p', { class: 'wf-detail-line' }, h('b', { text: '完了の条件' }), t.done_when) : null,
    t.result ? h('p', { class: 'wf-detail-line' }, h('b', { text: '成果' }), t.result) : null,
    t.body ? h('p', { class: 'wf-detail-body', text: t.body }) : null);
}

function group(title, profile, tasks, today, colors, { showMeta }) {
  const kept = tasks.filter((t) => KEEP[view.filter](t, today));
  return h('div', {},
    h('div', { class: 'wf-group-head' }, h('h2', { text: title }), showMeta && profile ? profileChip(profile, colors, 15) : null, h('span', { class: 'wf-group-count', text: `${kept.length}件` })),
    ...kept.map((t) => taskRow(t, today)),
    kept.length ? null : h('div', { class: 'wf-empty', text: `「${FILTERS[view.filter]}」に当てはまるタスクはありません` }));
}

function render(data, ctx) {
  const today = ctx.now;
  const colors = data.profiles;
  const goals = data.goals;
  // Until a goal is picked, the one due soonest is open.
  if (view.goal === null) {
    const dated = goals.filter((g) => dueDay(g.due)).sort((a, b) => dueDay(a.due) - dueDay(b.due));
    view.goal = dated[0]?.id ?? goals[0]?.id ?? (data.unassigned.length ? 'none' : 'all');
  }
  if (view.goal !== 'all' && view.goal !== 'none' && !goals.some((g) => g.id === view.goal)) view.goal = 'all';
  const filters = h('div', { class: 'wf-filters', role: 'group', 'aria-label': '絞り込み' },
    ...FILTERS.map((label, i) => h('button', { type: 'button', class: 'wf-filter', 'aria-pressed': String(view.filter === i), data: { key: `filter-${i}` }, onclick: () => { view.filter = i; ctx.rerender(); }, text: label })));
  const header = ctx.head('タスク', filters);
  if (!goals.length && !data.unassigned.length) {
    return h('div', { class: 'wf-page-tasks' }, header, ctx.banner(),
      h('div', { class: 'wf-surface wf-big-empty', text: 'エージェントに「これをゴールに」と頼むと、ここに出ます' }));
  }
  const openLoose = data.unassigned.filter((t) => t.state !== 'done').length;
  const pick = (id) => () => { view.goal = id; view.hl = null; ctx.rerender(); };
  const list = h('section', { class: 'wf-goals', 'aria-label': 'ゴール', data: { scroll: 'goals' } },
    h('h2', { text: 'ゴール' }),
    h('button', { type: 'button', class: 'wf-goal-btn wf-goal-all', 'aria-pressed': String(view.goal === 'all'), data: { key: 'goal-all' }, onclick: pick('all'), text: 'すべてのゴール' }),
    ...goals.map((g) => goalButton(g, today, colors, ctx)),
    h('button', { type: 'button', class: 'wf-goal-btn wf-goal-none', 'aria-pressed': String(view.goal === 'none'), data: { key: 'goal-none' }, onclick: pick('none'), text: `ゴールなし · ${openLoose}件` }));

  const found = goals.find((g) => g.id === view.goal);
  const right = [];
  if (found) {
    const done = found.tasks.filter((t) => t.state === 'done').length;
    const d = dueDay(found.due) ? daysFrom(today, dueDay(found.due)) : null;
    right.push(h('div', { class: 'wf-sel' },
      h('div', { class: 'wf-sel-top' }, h('h2', { text: found.title }), profileChip(found.profile, colors), h('span', { class: 'wf-muted', text: `${done}/${found.tasks.length} 完了` }),
        found.due ? h('span', { class: 'wf-sel-due', style: { color: dueColor(d) }, text: `${md(dueDay(found.due))}${prov(found)} · ${leftText(d)}` }) : null),
      found.outcome ? h('span', { class: 'wf-outcome', text: `あるべき姿: ${found.outcome}` }) : null,
      found.tasks.length ? flowchart(found, ctx) : h('span', { class: 'wf-muted', text: 'まだタスクがありません' })));
    right.push(detail(found.tasks.find((t) => t.id === view.hl), today));
  } else if (view.goal === 'none') {
    right.push(group('ゴールなし', null, data.unassigned, today, colors, { showMeta: false }));
  } else {
    for (const g of goals) right.push(group(g.title, g.profile, g.tasks, today, colors, { showMeta: true }));
    right.push(group('ゴールなし', null, data.unassigned, today, colors, { showMeta: false }));
  }
  return h('div', { class: 'wf-page-tasks' }, header, ctx.banner(),
    h('div', { class: 'wf-tasks-body' }, list, h('section', { class: 'wf-tasklist', 'aria-label': 'タスク', data: { scroll: `tasks-${view.goal}` } }, ...right)));
}

function skeleton(ctx) {
  const goal = () => h('div', { class: 'wf-goal-btn' }, skel('80%', '15px'), skel('50%', '13px'), skel('100%', '6px'));
  const row = () => h('div', { class: 'wf-task' }, skel('34px', '34px', { borderRadius: '999px' }), h('span', { class: 'wf-task-main' }, skel('30%', '13px'), skel('70%', '15px')));
  return h('div', { class: 'wf-page-tasks' }, ctx.head('タスク'), ctx.banner(),
    h('div', { class: 'wf-tasks-body', 'aria-busy': 'true' },
      h('section', { class: 'wf-goals' }, h('h2', { text: 'ゴール' }), goal(), goal(), goal()),
      h('section', { class: 'wf-tasklist' }, skel('40%', '24px'), skel('100%', '180px', { borderRadius: '10px' }), row(), row(), row())));
}

export default { load, render, skeleton };
