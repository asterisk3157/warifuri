// 秘書: the secretary's reports (the nightly check, the morning summary, the inbox tidy-up),
// newest first. A report's text goes in as text only; its line breaks are kept by the stylesheet.

import { h, skel, mdw, hhmm2 } from '../ui.js';

const load = (api) => api('/secretary');

const KIND = { nightly: '毎晩', morning: '朝', inbox: '受信箱' };

// The local date and time; the year only when it is not this year's.
function when(iso, now) {
  const d = new Date(iso);
  const year = d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()}/`;
  return `${year}${mdw(d)} ${hhmm2(d)}`;
}

function report(r, ctx) {
  return h('article', { class: 'wf-report' },
    h('div', { class: 'wf-report-top' },
      h('span', { class: ['wf-kind', `wf-kind-${r.kind}`], text: KIND[r.kind] ?? r.kind }),
      h('h2', { class: 'wf-report-title', text: r.title }),
      h('time', { class: 'wf-report-time', datetime: r.created_at, text: when(r.created_at, ctx.now) })),
    h('p', { class: 'wf-report-body', text: r.body }));
}

function render(data, ctx) {
  const list = data.reports.length
    ? data.reports.map((r) => report(r, ctx))
    : h('div', { class: 'wf-big-empty', text: 'まだ報告はありません' });
  return h('div', { class: 'wf-page-scroll', data: { scroll: 'secretary' } }, ctx.head('秘書'), ctx.banner(),
    h('section', { class: 'wf-surface wf-reports' }, list));
}

function skeleton(ctx) {
  const row = () => h('div', { class: 'wf-report' },
    h('div', { class: 'wf-report-top' }, skel('48px', '20px'), skel('40%', '17px')), skel('90%', '15px'), skel('70%', '15px'));
  return h('div', { class: 'wf-page-scroll' }, ctx.head('秘書'), ctx.banner(),
    h('section', { class: 'wf-surface wf-reports', 'aria-busy': 'true' }, row(), row(), row()));
}

export default { load, render, skeleton };
