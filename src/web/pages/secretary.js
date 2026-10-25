// 秘書: the conversation with the secretary. One timeline, the newest at the bottom: the
// person's and the secretary's messages, warifuri's notes, the secretary's reports, and its
// proposals with 了承 / 直して了承 / 断る while they are open. The box at the bottom sends a
// message; while a reply is being made the screen reads again every few seconds. Every text
// goes in as text only; line breaks are kept by the stylesheet.
//
// The box and the 直して了承 fields are kept across redraws (the same elements), so what is
// being typed, and where the cursor is, survive the reading every 30 seconds.

import { h, skel, mdw, hhmm2 } from '../ui.js';

const POLL_MS = 2500;
const KIND = { nightly: '毎晩', morning: '朝', inbox: '受信箱' };
const ANSWERED = { approved: '了承', changed: '直して了承', refused: '断った' };

const view = { sending: false, problems: [], answering: null, fixes: new Map(), lastId: null, atBottom: true, pinBottom: false };
let ctxRef = null;
let pollTimer = null;

const load = (api) => api('/secretary');

// The local date and time; the year only when it is not this year's.
function when(iso, now) {
  const d = new Date(iso);
  const year = d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()}/`;
  return `${year}${mdw(d)} ${hhmm2(d)}`;
}
const time = (iso, now) => h('time', { class: 'wf-report-time', datetime: iso, text: when(iso, now) });

// Enter sends; Shift+Enter is a new line. Not while the IME is converting.
const enter = (fn) => (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    fn();
  }
};

// The box at the bottom, made once.
const input = h('textarea', {
  rows: 1, maxlength: 4000, placeholder: '秘書に話しかける', 'aria-label': '秘書へのメッセージ', data: { key: 'chat-input' },
  oninput: () => grow(),
  onkeydown: enter(() => send()),
});
const sendBtn = h('button', { type: 'button', class: 'wf-btn-primary', data: { key: 'chat-send' }, onclick: () => send() });
function grow() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight + 2, 160)}px`;
}

async function send() {
  const text = input.value.trim();
  if (!text || view.sending || !ctxRef) return;
  view.sending = true;
  view.problems = [];
  view.pinBottom = true;
  ctxRef.rerender();
  try {
    await ctxRef.api('/secretary/messages', { method: 'POST', body: { text } });
    input.value = '';
    grow();
  } catch (err) {
    view.problems = err.body?.problems ?? ['送れませんでした。サーバーにつながっているか確かめてください'];
  }
  view.sending = false;
  await ctxRef.refresh();
  input.focus();
}

// The field of 直して了承 for a proposal, made on the first press.
function fixField(id) {
  if (!view.fixes.has(id)) {
    view.fixes.set(id, h('input', {
      class: 'wf-fix', maxlength: 1000, placeholder: 'どう直すか', 'aria-label': 'どう直すか', data: { key: `fixtext-${id}` },
      onkeydown: enter(() => answer(id, 'changed')),
    }));
  }
  return view.fixes.get(id);
}

async function answer(id, kind) {
  if (!ctxRef || view.answering) return;
  if (kind === 'changed' && !view.fixes.has(id)) {
    fixField(id);
    ctxRef.rerender();
    view.fixes.get(id).focus();
    return;
  }
  const text = kind === 'changed' ? view.fixes.get(id).value.trim() : '';
  if (kind === 'changed' && !text) {
    view.fixes.get(id).focus();
    return;
  }
  view.answering = id;
  view.problems = [];
  ctxRef.rerender();
  try {
    await ctxRef.api(`/secretary/proposals/${encodeURIComponent(id)}`, { method: 'POST', body: text ? { answer: kind, text } : { answer: kind } });
    view.fixes.delete(id);
  } catch (err) {
    view.problems = err.body?.problems ?? ['答えを送れませんでした。サーバーにつながっているか確かめてください'];
  }
  view.answering = null;
  await ctxRef.refresh();
}

function message(m, ctx) {
  if (m.role === 'system') return h('p', { class: 'wf-msg-system', text: m.body });
  return h('div', { class: ['wf-msg-row', m.role === 'user' && 'wf-mine'] },
    h('p', { class: ['wf-msg', m.role === 'user' ? 'wf-msg-user' : 'wf-msg-secretary'], text: m.body }),
    time(m.created_at, ctx.now));
}

function report(r, ctx) {
  return h('article', { class: 'wf-tl-card' },
    h('div', { class: 'wf-report-top' },
      h('span', { class: ['wf-kind', `wf-kind-${r.kind}`], text: KIND[r.kind] ?? r.kind }),
      h('h2', { class: 'wf-report-title', text: r.title }),
      time(r.created_at, ctx.now)),
    h('p', { class: 'wf-report-body', text: r.body }));
}

function proposal(p, ctx) {
  let foot;
  if (p.state === 'open') {
    const busy = view.answering !== null;
    const field = view.fixes.get(p.id);
    foot = [
      field ? h('span', { class: 'wf-fix-row' }, field) : null,
      h('span', { class: 'wf-proposal-actions' },
        h('button', { type: 'button', class: 'wf-btn-primary', disabled: busy, data: { key: `ok-${p.id}` }, text: '了承', onclick: () => answer(p.id, 'approved') }),
        h('button', { type: 'button', class: 'wf-btn-line', disabled: busy, data: { key: `fix-${p.id}` }, text: '直して了承', onclick: () => answer(p.id, 'changed') }),
        h('button', { type: 'button', class: 'wf-btn-line', disabled: busy, data: { key: `no-${p.id}` }, text: '断る', onclick: () => answer(p.id, 'refused') })),
    ];
  } else {
    const done = p.done_at ? `済み${p.done_note ? `: ${p.done_note}` : ''}` : null;
    foot = h('p', { class: 'wf-proposal-answer' },
      h('b', { text: ANSWERED[p.state] }), p.answer ? `: ${p.answer}` : '', done ? h('span', { class: 'wf-done', text: done }) : null);
  }
  return h('article', { class: ['wf-tl-card', p.state === 'open' && 'wf-open'] },
    h('div', { class: 'wf-report-top' },
      h('span', { class: 'wf-kind wf-kind-proposal', text: '案' }),
      h('h2', { class: 'wf-report-title', text: p.title }),
      time(p.created_at, ctx.now)),
    p.label ? h('span', { class: 'wf-proposal-kind', text: p.label }) : null,
    h('p', { class: 'wf-report-body', text: p.body }),
    foot);
}

const ITEM = { message, report, proposal };

function render(data, ctx) {
  ctxRef = ctx;
  const on = data.secretary?.on === true;
  const replying = on && data.secretary.replying;
  const items = data.items.map((x) => ITEM[x.type]?.(x, ctx)).filter(Boolean);
  const scroll = h('div', {
    class: 'wf-chat-scroll', data: { scroll: 'chat' },
    onscroll: (e) => {
      const el = e.currentTarget;
      view.atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    },
  },
  items.length ? items : h('div', { class: 'wf-big-empty', text: on ? 'まだ何もありません。話しかけてみてください' : 'まだ何もありません' }),
  replying ? h('p', { class: 'wf-waiting', role: 'status', text: '返事を書いています' }) : null);

  input.disabled = !on;
  sendBtn.disabled = !on || view.sending;
  sendBtn.textContent = view.sending ? '送っています' : '送る';
  const composer = h('div', { class: 'wf-composer-wrap' },
    on ? null : h('p', { class: 'wf-chat-off', text: '秘書は止まっています' }),
    view.problems.length ? h('ul', { class: 'wf-errors', role: 'alert' }, ...view.problems.map((x) => h('li', { text: x }))) : null,
    h('div', { class: 'wf-composer' }, input, sendBtn));

  // Go to the bottom when something new came and the reader was there, or after sending.
  const last = data.items.at(-1)?.id ?? null;
  const moved = last !== view.lastId;
  view.lastId = last;
  if (view.pinBottom || (moved && view.atBottom) || ctx.first) {
    requestAnimationFrame(() => {
      scroll.scrollTop = scroll.scrollHeight;
      view.atBottom = true;
    });
    if (!view.sending) view.pinBottom = false;
  }
  clearTimeout(pollTimer);
  if (replying) pollTimer = setTimeout(() => ctxRef?.refresh(), POLL_MS);

  return h('div', { class: 'wf-page-chat' }, ctx.head('秘書'), ctx.banner(),
    h('section', { class: 'wf-surface wf-chat' }, scroll, composer));
}

function skeleton(ctx) {
  ctxRef = ctx;
  const row = () => h('div', { class: 'wf-tl-card' },
    h('div', { class: 'wf-report-top' }, skel('48px', '20px'), skel('40%', '17px')), skel('90%', '15px'), skel('70%', '15px'));
  input.disabled = true;
  sendBtn.disabled = true;
  sendBtn.textContent = '送る';
  return h('div', { class: 'wf-page-chat' }, ctx.head('秘書'), ctx.banner(),
    h('section', { class: 'wf-surface wf-chat', 'aria-busy': 'true' },
      h('div', { class: 'wf-chat-scroll' }, row(), row()),
      h('div', { class: 'wf-composer-wrap' }, h('div', { class: 'wf-composer' }, input, sendBtn))));
}

export default { load, render, skeleton };
