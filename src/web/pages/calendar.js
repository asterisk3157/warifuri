// カレンダー: the bookings of a day or a week, with today's list beside them.

import { h, skel, soonBadge, hhmm, mdw, dayStart, addDays, isoLocal, profileColor, tint, WEEKDAYS } from '../ui.js';

const ROW = 52;
const H0 = 8;
const H1 = 22;
const view = { mode: 'week', anchor: dayStart(new Date()) };

const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7));
const range = () => (view.mode === 'day' ? { from: view.anchor, days: 1 } : { from: mondayOf(view.anchor), days: 7 });

async function load(api) {
  const { from, days } = range();
  const to = addDays(from, days);
  const today = dayStart(new Date());
  const q = (a, b) => `/calendar?from=${encodeURIComponent(isoLocal(a))}&to=${encodeURIComponent(isoLocal(b))}`;
  const inView = today >= from && today < to;
  const [shown, todays] = await Promise.all([api(q(from, to)), inView ? null : api(q(today, addDays(today, 1)))]);
  return { from, days, shown, today: todays ?? shown };
}

const KIND_LABEL = { fixed: '決まった予定', habit: '習慣' };
const FIXED = '#a7b4c2';
const HABIT = '#e8a19c';

// What a booking is, in words, and its colour.
function category(b, colors) {
  if (b.kind === 'fixed') return { label: KIND_LABEL.fixed, color: FIXED };
  if (b.kind === 'habit') return { label: KIND_LABEL.habit, color: HABIT };
  if (b.profile) return { label: b.profile, color: profileColor(b.profile, colors) };
  return { label: 'タスク', color: profileColor(null, colors) };
}

const fmt = (d) => hhmm(d);

// Bookings of one day, cut to the day, laid side by side where they overlap.
function dayEvents(bookings, day) {
  const start = day.getTime();
  const end = addDays(day, 1).getTime();
  const evs = bookings
    .map((b) => ({ b, s: Math.max(start, Date.parse(b.starts_at)), e: Math.min(end, Date.parse(b.ends_at)) }))
    .filter((x) => x.e > x.s)
    .sort((x, y) => x.s - y.s || y.e - x.e);
  let cluster = [];
  let clusterEnd = -Infinity;
  const finish = () => {
    const n = Math.max(1, ...cluster.map((x) => x.col + 1));
    for (const x of cluster) x.n = n;
  };
  for (const x of evs) {
    if (x.s >= clusterEnd && cluster.length) {
      finish();
      cluster = [];
    }
    const used = new Set(cluster.filter((y) => y.e > x.s).map((y) => y.col));
    let col = 0;
    while (used.has(col)) col += 1;
    x.col = col;
    cluster.push(x);
    clusterEnd = Math.max(clusterEnd, x.e);
  }
  if (cluster.length) finish();
  return evs;
}

const hourOf = (ms, day) => (ms - day.getTime()) / 3600000;

function rangeLabel(from, days) {
  if (days === 1) return `${from.getFullYear()}年${from.getMonth() + 1}月${from.getDate()}日（${WEEKDAYS[from.getDay()]}）`;
  const last = addDays(from, days - 1);
  const tail = last.getMonth() === from.getMonth() ? `${last.getDate()}日` : `${last.getMonth() + 1}月${last.getDate()}日`;
  return `${from.getFullYear()}年${from.getMonth() + 1}月${from.getDate()}日 – ${tail}`;
}

function toolbar(ctx, from, days) {
  const move = (n) => {
    view.anchor = addDays(view.anchor, n * (view.mode === 'day' ? 1 : 7));
    ctx.refresh();
  };
  const pick = (mode) => {
    view.mode = mode;
    ctx.refresh();
  };
  const isWeek = view.mode === 'week';
  return h('div', { class: 'wf-week-bar' },
    h('button', { type: 'button', class: 'wf-btn wf-btn-sq', 'aria-label': isWeek ? '前の週' : '前の日', data: { key: 'prev' }, onclick: () => move(-1), text: '‹' }),
    h('button', { type: 'button', class: 'wf-btn wf-btn-sq', 'aria-label': isWeek ? '次の週' : '次の日', data: { key: 'next' }, onclick: () => move(1), text: '›' }),
    h('button', { type: 'button', class: 'wf-btn', data: { key: 'today' }, onclick: () => { view.anchor = dayStart(new Date()); ctx.refresh(); }, text: '今日' }),
    h('span', { class: 'wf-range', text: rangeLabel(from, days) }),
    h('div', { class: 'wf-seg', role: 'group', 'aria-label': '表示の幅' },
      h('button', { type: 'button', 'aria-pressed': String(!isWeek), data: { key: 'mode-day' }, onclick: () => pick('day'), text: '日' }),
      h('button', { type: 'button', 'aria-pressed': String(isWeek), data: { key: 'mode-week' }, onclick: () => pick('week'), text: '週' }),
      h('span', { class: 'wf-seg-soon', 'aria-disabled': 'true', title: '準備中' }, '月', soonBadge())));
}

function grid(data, ctx) {
  const { from, days, shown } = data;
  const now = ctx.now;
  const today = dayStart(now);
  const colors = shown.profiles;
  const list = Array.from({ length: days }, (_, i) => addDays(from, i));
  const perDay = list.map((d) => dayEvents(shown.bookings, d));
  // Bookings outside 8:00–22:00 widen the hours shown.
  let h0 = H0;
  let h1 = H1;
  perDay.forEach((evs, i) => {
    for (const x of evs) {
      h0 = Math.min(h0, Math.floor(hourOf(x.s, list[i])));
      h1 = Math.max(h1, Math.ceil(hourOf(x.e, list[i])));
    }
  });
  const columns = `56px repeat(${days}, minmax(0, 1fr))`;
  const hours = [];
  for (let k = h0; k < h1; k += 1) hours.push(h('span', { class: 'wf-hour', text: `${k}:00` }));
  const height = (h1 - h0) * ROW;
  const head = days > 1
    ? h('div', { class: 'wf-grid wf-grid-head', style: { gridTemplateColumns: columns } }, h('span'),
      ...list.map((d) => h('span', { class: ['wf-dayhead', +d === +today && 'wf-today'] }, h('span', { class: 'wf-wd', text: WEEKDAYS[d.getDay()] }), h('span', { class: 'wf-daynum', text: d.getDate() }))))
    : null;
  const cols = list.map((d, i) => {
    const lines = [];
    for (let k = 0; k < h1 - h0; k += 1) lines.push(h('div', { class: 'wf-hline', style: { top: `${k * ROW}px` }, 'aria-hidden': 'true' }));
    const evs = perDay[i].map((x) => {
      const c = category(x.b, colors);
      const top = (hourOf(x.s, d) - h0) * ROW + 2;
      const ht = Math.max(18, ((x.e - x.s) / 3600000) * ROW - 4);
      const past = x.e <= now.getTime();
      const time = `${c.label} · ${fmt(new Date(Date.parse(x.b.starts_at)))}–${fmt(new Date(Date.parse(x.b.ends_at)))}`;
      return h('div', {
        class: ['wf-ev', past && 'wf-past'],
        title: `${x.b.title}\n${time}`,
        style: { top: `${top}px`, height: `${ht}px`, left: `calc(${(x.col / x.n) * 100}% + 4px)`, width: `calc(${100 / x.n}% - 8px)`, background: tint(c.color) },
      }, h('span', { class: 'wf-ev-title', text: x.b.title }), h('span', { class: 'wf-ev-time' }, h('span', { class: 'wf-dot', style: { background: c.color }, 'aria-hidden': 'true' }), time));
    });
    const nowH = hourOf(now.getTime(), d);
    const line = +d === +today && nowH >= h0 && nowH <= h1
      ? h('div', { class: 'wf-nowline', style: { top: `${(nowH - h0) * ROW}px` }, 'aria-label': `現在の時刻 ${fmt(now)}` }, h('span'))
      : null;
    return h('div', { class: ['wf-daycol', (d.getDay() === 0 || d.getDay() === 6) && 'wf-weekend'], style: { height: `${height}px` } }, ...lines, ...evs, line);
  });
  return h('section', { class: 'wf-week wf-surface', 'aria-label': days > 1 ? '週の予定' : '日の予定' },
    toolbar(ctx, from, days),
    head,
    h('div', { class: 'wf-grid-scroll', data: { scroll: 'cal' } },
      h('div', { class: 'wf-grid wf-grid-body', style: { gridTemplateColumns: columns } }, h('div', { class: 'wf-hours' }, ...hours), ...cols)));
}

function todayCard(data, ctx) {
  const now = ctx.now;
  const today = dayStart(now);
  const colors = data.today.profiles;
  const evs = dayEvents(data.today.bookings, today);
  const rows = [];
  let marked = false;
  const marker = () => h('div', { class: 'wf-today-now', role: 'separator', 'aria-label': '現在の時刻' }, h('b', { text: fmt(now) }), h('i'), h('u'));
  for (const x of evs) {
    const s = Date.parse(x.b.starts_at);
    const e = Date.parse(x.b.ends_at);
    const past = e <= now.getTime();
    const cur = s <= now.getTime() && now.getTime() < e;
    if (!marked && !cur && s > now.getTime()) {
      rows.push(marker());
      marked = true;
    }
    const c = category(x.b, colors);
    rows.push(h('div', { class: ['wf-today-row', past && 'wf-past', cur && 'wf-current'] },
      h('span', { class: 'wf-today-start', text: fmt(new Date(s)) }),
      h('span', { class: 'wf-today-text' }, h('span', { class: 'wf-today-title', text: x.b.title }), h('span', { class: 'wf-today-sub', text: `${c.label} · ${fmt(new Date(s))}〜${fmt(new Date(e))}` }))));
    if (cur && !marked) {
      rows.push(marker());
      marked = true;
    }
  }
  return h('section', { class: 'wf-today-card wf-surface' },
    h('div', { class: 'wf-today-head' }, h('h2', { text: '今日の予定' }), h('span', { class: 'wf-muted', text: mdw(today) })),
    evs.length ? rows : h('div', { class: 'wf-empty', text: '今日の予定はありません' }));
}

function legend(data) {
  const colors = { ...data.today.profiles, ...data.shown.profiles };
  const items = Object.keys(colors).sort().map((name) => [name, profileColor(name, colors)]);
  items.push([KIND_LABEL.fixed, FIXED], [KIND_LABEL.habit, HABIT]);
  return h('section', { class: 'wf-legend wf-surface' }, h('h2', { text: '色の見方' }),
    ...items.map(([label, color]) => h('span', { class: 'wf-legend-item' }, h('span', { class: 'wf-legend-dot', style: { background: tint(color), border: `1px solid ${color}` }, 'aria-hidden': 'true' }), label)));
}

function render(data, ctx) {
  return h('div', { class: 'wf-page-cal' }, ctx.head('カレンダー'), ctx.banner(),
    h('div', { class: 'wf-cal-body' }, grid(data, ctx), h('aside', { class: 'wf-aside' }, todayCard(data, ctx), legend(data))));
}

function skeleton(ctx) {
  const block = () => h('div', { class: 'wf-today-row' }, skel('44px', '14px'), h('span', { class: 'wf-today-text' }, skel('70%', '14px'), skel('45%', '12px')));
  return h('div', { class: 'wf-page-cal' }, ctx.head('カレンダー'), ctx.banner(),
    h('div', { class: 'wf-cal-body' },
      h('section', { class: 'wf-week wf-surface', 'aria-busy': 'true' }, h('div', { class: 'wf-week-bar' }, skel('34px', '34px'), skel('34px', '34px'), skel('60px', '34px'), skel('200px', '18px')),
        h('div', { style: { padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' } }, ...[90, 60, 75, 50, 85].map((w) => skel(`${w}%`, '40px')))),
      h('aside', { class: 'wf-aside' }, h('section', { class: 'wf-today-card wf-surface', 'aria-busy': 'true' }, h('div', { class: 'wf-today-head' }, skel('120px', '18px')), block(), block(), block()))));
}

export default { load, render, skeleton };
