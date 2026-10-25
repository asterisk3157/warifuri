// 秘書: the conversation with the secretary, in one window. The person's messages on the
// right and the secretary's on the left, each in a bordered bubble, the name and the steps of
// the work over it and the time under it; a line with the date where the day changes. The
// secretary's replies are Markdown (md.js builds the DOM; nothing is parsed as HTML). Under a
// reply that asks, its reply buttons; under the conversation, the secretary's open questions
// (ask) one question at a time. Any message can start a thread, which opens on the right.
//
// A reply being written comes from /web/api/secretary/stream (Server-Sent Events): the three
// dots until the first words, then the words with a caret. When the stream is not there, the
// screen reads again every few seconds while a reply is being made.
//
// The boxes, the files waiting to go and the その他 fields are kept across redraws (the same
// elements), so what is being typed survives the reading every 30 seconds.

import { h, s, skel } from '../ui.js';
import { renderMarkdown } from '../md.js';

const POLL_MS = 2500;
const FILES_MAX = 4;
const FILE_MAX = 5 * 1024 * 1024;
const IMAGE = /^image\/(png|jpeg|gif|webp)$/;
const THREAD_OPTION = 'スレッドで話す';
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const STEP_COLORS = { read: '#2f6fed', search: '#0e9aa7', write: '#1f9d6b', ask: '#2f6fa5', say: '#8e8e93', tool: '#5b6b8c' };

const view = {
  live: new Map(), // thread id → { phase, text, steps, scheduled }
  stream: null,
  streamOk: false,
  thread: null, // the id of the open thread
  askAt: new Map(), // ask id → the question moved to with 戻る
  picks: new Map(), // `${ask}:${index}` → Set of labels
  others: new Map(), // `${ask}:${index}` → <input>
  reopened: new Map(), // ask id → index, for an answer being changed
  busy: false,
  problems: [],
  atBottom: { main: true, thread: true },
  lastId: { main: null, thread: null },
  pin: { main: false, thread: false },
  // What has been drawn once: only what is new rises in (or slides in), once.
  seen: new Set(),
  slid: null,
};
// The class that moves something in the first time it is drawn.
const once = (id, cls = 'wf-rise') => {
  if (view.seen.has(id)) return null;
  view.seen.add(id);
  return ctxRef?.first ? null : cls;
};
let ctxRef = null;
let pollTimer = null;

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (iso) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const dayKey = (iso) => new Date(iso).toDateString();
const dayLabel = (iso) => {
  const d = new Date(iso);
  const year = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}年`;
  return `${year}${d.getMonth() + 1}月${d.getDate()}日（${WEEK[d.getDay()]}）`;
};
const sizeText = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// Icons, from constant shapes only.
const svg = (size, width, ...paths) =>
  s('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, ...paths);
const ICON = {
  clip: () => svg(18, 1.8, s('path', { d: 'M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9' })),
  send: () => svg(16, 2, s('path', { d: 'M12 19V5M5 12l7-7 7 7' })),
  close: (n = 16) => svg(n, 2, s('path', { d: 'M6 6l12 12M18 6L6 18' })),
  image: () => svg(14, 1.8, s('rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }), s('path', { d: 'M3 16l5-5 4 4 3-3 6 6' })),
  file: () => svg(14, 1.8, s('path', { d: 'M6 3h8l4 4v14H6z' }), s('path', { d: 'M14 3v4h4' })),
  clock: () => svg(12, 2.2, s('circle', { cx: 12, cy: 12, r: 9 }), s('path', { d: 'M12 7v5l3 2' })),
  back: () => svg(16, 2, s('path', { d: 'M15 18l-6-6 6-6' })),
  threads: () => svg(15, 1.9,
    s('path', { d: 'M4 4.5h10a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H8.5L5 16.5v-3H4A1.5 1.5 0 0 1 2.5 12V6A1.5 1.5 0 0 1 4 4.5z' }),
    s('path', { d: 'M18 9h2a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 20 18h-1v3l-3.5-3H11a1.5 1.5 0 0 1-1.5-1.5' })),
};

// Enter sends; Shift+Enter is a new line. Not while the IME is converting.
const enter = (fn) => (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    fn();
  }
};

function grow(el) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(Math.max(el.scrollHeight, 36), 22 * 5 + 14)}px`;
}

// One box to write in, with the files waiting to go: the secretary's conversation, or the
// open thread. Made once each.
function composer(where, placeholder) {
  const c = { where, files: [], note: '' };
  c.input = h('textarea', {
    rows: 1, maxlength: 4000, placeholder, data: { key: `${where}-input` },
    oninput: () => grow(c.input),
    onkeydown: enter(() => send(c)),
    onpaste: (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) {
        e.preventDefault();
        addFiles(c, files);
      }
    },
  });
  c.picker = h('input', {
    type: 'file', multiple: true, hidden: true, tabindex: '-1', 'aria-hidden': 'true',
    onchange: (e) => {
      addFiles(c, [...e.currentTarget.files]);
      e.currentTarget.value = '';
    },
  });
  return c;
}
const boxes = { main: composer('main', '秘書に話しかける'), thread: composer('thread', 'スレッドに返信する') };

function addFiles(c, files) {
  c.note = '';
  for (const f of files) {
    if (c.files.length >= FILES_MAX) {
      c.note = `ファイルは${FILES_MAX}個までです`;
      break;
    }
    if (f.size > FILE_MAX) {
      c.note = `${f.name} は大きすぎます(5 MB まで)`;
      continue;
    }
    if (f.size === 0) continue;
    const item = { file: f, name: f.name || 'ファイル', size: f.size, type: f.type || 'application/octet-stream', thumb: null };
    c.files.push(item);
    if (IMAGE.test(item.type)) {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string' && reader.result.startsWith('data:image/')) item.thumb = reader.result;
        ctxRef?.rerender();
      };
      reader.readAsDataURL(f);
    }
  }
  ctxRef?.rerender();
  c.input.focus();
}

async function upload(item) {
  const res = await fetch('/web/api/secretary/uploads', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': item.type, 'X-File-Name': encodeURIComponent(item.name), Accept: 'application/json' },
    body: item.file,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error('upload'), { body: json, status: res.status });
  return json.id;
}

// Sends what is in a box (with its files), or the words of a reply button.
async function send(c, words) {
  const text = (words ?? c.input.value).trim();
  const files = words === undefined ? c.files : [];
  if ((!text && !files.length) || view.busy || !ctxRef) return;
  view.busy = true;
  view.problems = [];
  view.pin[c.where] = true;
  ctxRef.rerender();
  try {
    const ids = [];
    for (const f of files) ids.push(await upload(f));
    const body = { text, ...(ids.length ? { attachments: ids } : {}), ...(c.where === 'thread' ? { thread: view.thread } : {}) };
    await ctxRef.api('/secretary/messages', { method: 'POST', body });
    if (words === undefined) {
      c.input.value = '';
      c.files = [];
      c.note = '';
      grow(c.input);
    }
  } catch (err) {
    view.problems = err.body?.problems ?? [err.status === 413 ? 'ファイルが大きすぎます' : '送れませんでした。サーバーにつながっているか確かめてください'];
  }
  view.busy = false;
  await ctxRef.refresh();
  c.input.focus();
}

// The thread of a message: opened (made the first time) on the right.
async function openThread(messageId) {
  if (!ctxRef) return;
  try {
    const out = await ctxRef.api('/secretary/threads', { method: 'POST', body: { parent: messageId } });
    view.thread = out.thread.id;
    view.pin.thread = true;
    await ctxRef.refresh();
    boxes.thread.input.focus();
  } catch (err) {
    view.problems = err.body?.problems ?? ['スレッドを開けませんでした'];
    ctxRef.rerender();
  }
}
function closeThread() {
  view.thread = null;
  view.slid = null;
  ctxRef?.rerender();
  boxes.main.input.focus();
}
async function markRead(id) {
  try {
    await ctxRef.api(`/secretary/threads/${encodeURIComponent(id)}/read`, { method: 'POST', body: {} });
  } catch {
    // Read again on the next refresh.
  }
}

// The event stream of replies being written.
function connect() {
  if (view.stream || typeof EventSource === 'undefined') return;
  const es = new EventSource('/web/api/secretary/stream');
  view.stream = es;
  es.addEventListener('hello', (e) => {
    view.streamOk = true;
    view.live.clear();
    for (const l of JSON.parse(e.data).live ?? []) view.live.set(l.thread, l);
    ctxRef?.rerender();
  });
  es.addEventListener('live', (e) => {
    const l = JSON.parse(e.data);
    const had = view.live.has(l.thread);
    view.live.set(l.thread, l);
    if (!had || !updateLive(l)) ctxRef?.rerender();
  });
  es.addEventListener('done', (e) => {
    const d = JSON.parse(e.data);
    view.live.delete(d.thread);
    // The reply takes the place of the bubble that was being written, without moving in again;
    // the next reply's bubble moves in.
    if (d.message) view.seen.add(d.message);
    view.seen.delete(`live:${d.thread}`);
    ctxRef?.refresh();
  });
  es.onerror = () => {
    view.streamOk = false;
  };
}

// The words of a reply being written, put in place without drawing the screen again.
function updateLive(l) {
  const el = document.querySelector(`[data-live="${CSS.escape(l.thread)}"]`);
  if (!el) return false;
  el.replaceWith(liveMessage(l));
  const where = l.thread === view.thread ? 'thread' : 'main';
  if (view.atBottom[where]) {
    const box = document.querySelector(`[data-scroll="${where === 'main' ? 'chat' : 'thread'}"]`);
    if (box) box.scrollTop = box.scrollHeight;
  }
  return true;
}

// The steps of the work, over a reply. While it is written, what it said between two tools
// shows too, and the newest step glows.
function steps(list, live) {
  const shown = live ? list.slice(-6) : list.filter((x) => x.kind !== 'say');
  if (!shown.length) return null;
  return h('div', { class: ['wf-steps', live && 'wf-steps-live'] },
    ...shown.map((x, i) => h('span', { class: ['wf-step', x.kind === 'say' && 'wf-step-say', live && i < shown.length - 1 && 'wf-step-old'] },
      h('i', { style: { background: STEP_COLORS[x.kind] ?? STEP_COLORS.tool }, 'aria-hidden': 'true' }),
      h('span', { text: x.label }))));
}

// Who wrote it: 秘書, with the round 定期実行 mark on a scheduled message.
const who = (scheduled) => h('small', { class: 'wf-who' },
  scheduled ? h('span', { class: 'wf-badge-sched' }, ICON.clock(), '定期実行') : null, '秘書');

// The words of a reply, with the caret at their end while they are written.
function words(text, caret) {
  const nodes = renderMarkdown(h, text);
  if (caret) {
    const c = h('span', { class: 'wf-caret', 'aria-hidden': 'true' });
    const last = nodes.at(-1);
    if (last && ['P', 'LI'].includes(last.tagName)) last.append(c);
    else if (last && ['UL', 'OL'].includes(last.tagName)) last.lastElementChild?.append(c);
    else nodes.push(h('p', {}, c));
  }
  return h('div', { class: 'wf-md' }, ...nodes);
}

function liveMessage(l) {
  const thinking = !l.text;
  return h('div', {
    class: ['wf-m', once(`live:${l.thread}`)], data: { live: l.thread }, role: thinking ? 'status' : undefined,
    'aria-label': thinking ? '秘書が考えています' : undefined, 'aria-busy': 'true',
  },
  who(l.scheduled),
  steps(l.steps ?? [], true),
  h('div', { class: 'wf-bubble' },
    thinking ? h('span', { class: 'wf-wait', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')) : words(l.text, true)));
}

// The link under a message that has a thread: 未読 N件 in blue, else スレッド N件.
function threadLink(t, parent) {
  if (!t || (t.count === 0 && t.unread === 0)) return null;
  const unread = t.unread > 0;
  return h('button', { type: 'button', class: ['wf-thread-link', unread && 'wf-unread'], onclick: () => openThread(parent) },
    ICON.threads(), unread ? `未読 ${t.unread}件` : `スレッド ${t.count}件`);
}

function message(m, { where, last, threads }) {
  if (m.role === 'system') return h('p', { class: 'wf-note', text: m.body });
  const t = threads?.[m.id] ?? null;
  const startThread = where === 'main' && !(t && (t.count || t.unread))
    ? h('button', { type: 'button', class: 'wf-hover-act', onclick: () => openThread(m.id) }, ICON.threads(), 'スレッドで話す')
    : null;
  const time = h('small', { class: 'wf-time', text: hhmm(m.created_at) });
  if (m.role === 'user') {
    const a = m.answer;
    const change = a && !a.later && a.ask && Number.isInteger(a.index)
      ? h('button', { type: 'button', class: 'wf-hover-act', onclick: () => reopen(a.ask, a.index) }, '答えを変える')
      : null;
    return h('div', { class: ['wf-m', 'wf-mine', once(m.id)] },
      h('div', { class: 'wf-bubble wf-bubble-me' },
        a && !a.later ? h('small', { class: 'wf-about', text: `「${a.header ?? ''}」${a.changed ? 'の答えを変えました' : 'への答え'}` }) : null,
        m.files_only ? null : h('p', { class: 'wf-plain', text: m.body }),
        ...m.files.filter((f) => f.preview).map((f) => h('figure', { class: 'wf-attach' },
          h('img', { src: f.preview, alt: f.name, loading: 'lazy' }),
          h('figcaption', { text: f.name }))),
        m.files.some((f) => !f.preview) ? h('span', { class: 'wf-sentfiles' }, ...m.files.filter((f) => !f.preview).map((f) => h('span', { text: f.name }))) : null),
      h('span', { class: 'wf-foot' }, change, startThread, threadLink(t, m.id), time));
  }
  const options = last && m.options.length
    ? h('div', { class: 'wf-replies', role: 'group', 'aria-label': '返事の候補' },
      ...m.options.map((o, i) => h('button', {
        type: 'button', class: ['wf-chip', 'wf-press', i === 0 ? 'wf-chip-main' : 'wf-chip-sub'], disabled: view.busy,
        onclick: () => (o === THREAD_OPTION && where === 'main' ? openThread(m.id) : send(boxes[where], o)),
        text: o,
      })))
    : null;
  return h('div', { class: ['wf-m', once(m.id)] },
    who(m.scheduled),
    steps(m.steps, false),
    h('div', { class: 'wf-bubble' }, words(m.body, false), options),
    h('span', { class: 'wf-foot' }, time, threadLink(t, m.id), startThread));
}

// The question being shown of an ask: the one reopened to change it, the one moved to with
// 戻る, or the first one not answered.
function shownIndex(a) {
  if (view.reopened.has(a.id)) return view.reopened.get(a.id);
  if (view.askAt.has(a.id)) return view.askAt.get(a.id);
  const i = a.answers.findIndex((x) => !x);
  return i < 0 ? a.answers.length - 1 : i;
}
function reopen(askId, index) {
  view.reopened.set(askId, index);
  view.pin.main = true;
  ctxRef?.rerender();
}

function picksFor(a, i) {
  const key = `${a.id}:${i}`;
  if (!view.picks.has(key)) view.picks.set(key, new Set(a.answers[i]?.picked ?? []));
  return view.picks.get(key);
}
function otherFor(a, i) {
  const key = `${a.id}:${i}`;
  if (!view.others.has(key)) {
    const el = h('input', {
      type: 'text', maxlength: 1000, placeholder: '自由に書く', 'aria-label': 'その他', data: { key: `other-${key}` },
      onkeydown: enter(() => answer(a, i)),
    });
    el.value = a.answers[i]?.other ?? '';
    view.others.set(key, el);
  }
  return view.others.get(key);
}

async function answer(a, i, later = false) {
  if (!ctxRef || view.busy) return;
  const picked = [...picksFor(a, i)];
  const other = otherFor(a, i).value.trim();
  if (!later && !picked.length && !other) {
    otherFor(a, i).focus();
    return;
  }
  view.busy = true;
  view.problems = [];
  ctxRef.rerender();
  try {
    await ctxRef.api(`/secretary/asks/${encodeURIComponent(a.id)}`, { method: 'POST', body: later ? { later: true } : { index: i, picked, ...(other ? { other } : {}) } });
    view.reopened.delete(a.id);
    view.askAt.delete(a.id);
    view.pin[a.where] = true;
  } catch (err) {
    view.problems = err.body?.problems ?? ['答えを送れませんでした。サーバーにつながっているか確かめてください'];
  }
  view.busy = false;
  await ctxRef.refresh();
}

// The card of a question, one question at a time, as Claude's AskUserQuestion: the label,
// i / N, the question, the options (the first is おすすめ), その他, and 戻る / あとで / 答える.
function askCard(a, where) {
  const small = where === 'thread';
  const i = shownIndex(a);
  const q = a.questions[i];
  const chosen = picksFor(a, i);
  const pick = (label) => {
    if (q.multiSelect) {
      if (chosen.has(label)) chosen.delete(label);
      else chosen.add(label);
    } else {
      chosen.clear();
      chosen.add(label);
    }
    ctxRef?.rerender();
  };
  const options = q.options.map((o, n) => {
    const on = chosen.has(o.label);
    return h('button', {
      type: 'button', class: ['wf-opt', on && 'wf-on'], role: q.multiSelect ? 'checkbox' : 'radio', aria: { checked: String(on), label: o.label },
      data: { key: `opt-${a.id}-${i}-${n}` }, onclick: () => pick(o.label),
    },
    h('span', { class: ['wf-mark', q.multiSelect && 'wf-mark-box'] }, h('span')),
    h('span', { class: 'wf-opt-text' },
      h('span', { class: 'wf-opt-label' }, o.label, n === 0 ? h('span', { class: 'wf-rec', text: 'おすすめ' }) : null),
      o.description ? h('span', { class: 'wf-opt-desc', text: o.description }) : null));
  });
  const back = i > 0
    ? h('button', {
      type: 'button', class: 'wf-ask-back', onclick: () => {
        view.reopened.delete(a.id);
        view.askAt.set(a.id, i - 1);
        ctxRef?.rerender();
      },
    }, ICON.back(), '戻る')
    : null;
  const changing = view.reopened.has(a.id);
  const total = a.questions.length;
  return h('section', { class: ['wf-ask', small && 'wf-ask-small', once(`ask:${a.id}:${i}`, 'wf-come')], 'aria-label': '秘書からの質問' },
    h('div', { class: 'wf-ask-head' }, h('span', { class: 'wf-ask-label', text: q.header }), total > 1 ? h('span', { text: `${i + 1} / ${total}` }) : null),
    h('p', { class: 'wf-ask-q', text: q.question }),
    h('div', { role: q.multiSelect ? 'group' : 'radiogroup', 'aria-label': '選択肢', class: 'wf-opts' },
      ...options,
      h('label', { class: 'wf-other' }, h('span', { text: 'その他' }), otherFor(a, i))),
    h('div', { class: ['wf-ask-actions', back && 'wf-with-back'] },
      back,
      changing
        ? h('button', {
          type: 'button', class: 'wf-btn-later', onclick: () => {
            view.reopened.delete(a.id);
            ctxRef?.rerender();
          }, text: 'やめる',
        })
        : h('button', { type: 'button', class: 'wf-btn-later', disabled: view.busy, onclick: () => answer(a, i, true), text: 'あとで' }),
      h('button', { type: 'button', class: 'wf-btn-answer', disabled: view.busy, onclick: () => answer(a, i), text: '答える' })));
}

// The items of a conversation with the lines of the days, then the reply being written and
// the open questions at the end.
function timeline(items, where, { threads, liveId, replying }) {
  const out = [];
  let day = null;
  // Reply buttons stay under the secretary's replies until the person says something.
  const lastPerson = items.findLastIndex((x) => x.type === 'message' && x.role === 'user');
  items.forEach((it, n) => {
    if (it.type === 'ask') return;
    if (dayKey(it.created_at) !== day) {
      day = dayKey(it.created_at);
      out.push(h('div', { class: 'wf-day', role: 'separator', 'aria-label': dayLabel(it.created_at) }, h('span'), dayLabel(it.created_at), h('span')));
    }
    out.push(message(it, { where, last: lastPerson < n && !view.live.has(liveId), threads }));
  });
  const l = view.live.get(liveId);
  if (l) out.push(liveMessage(l));
  else if (replying) out.push(liveMessage({ thread: liveId, phase: 'thinking', text: '', steps: [] }));
  for (const a of items.filter((x) => x.type === 'ask' && (x.state === 'open' || view.reopened.has(x.id)))) {
    a.where = where;
    out.push(askCard(a, where));
  }
  return out;
}

function composerEl(c, on) {
  const tray = c.files.length || c.note
    ? h('div', { class: 'wf-tray' },
      ...c.files.map((f, i) => h('span', { class: 'wf-afile' },
        h('span', { class: 'wf-pic' }, f.thumb ? h('img', { src: f.thumb, alt: '' }) : IMAGE.test(f.type) ? ICON.image() : ICON.file()),
        h('span', { class: 'wf-nm', text: f.name }),
        h('span', { class: 'wf-st', text: sizeText(f.size) }),
        h('button', {
          type: 'button', 'aria-label': `${f.name} を外す`, onclick: () => {
            c.files.splice(i, 1);
            ctxRef?.rerender();
          },
        }, ICON.close(12)))),
      c.note ? h('span', { class: 'wf-traynote', text: c.note }) : null)
    : null;
  c.input.disabled = !on;
  return h('div', {
    class: ['wf-composer2', view.busy && 'wf-busy'],
    ondragover: (e) => {
      if ([...(e.dataTransfer?.types ?? [])].includes('Files')) {
        e.preventDefault();
        e.currentTarget.classList.add('wf-drop');
      }
    },
    ondragleave: (e) => e.currentTarget.classList.remove('wf-drop'),
    ondrop: (e) => {
      e.preventDefault();
      e.currentTarget.classList.remove('wf-drop');
      if (on) addFiles(c, [...(e.dataTransfer?.files ?? [])]);
    },
  },
  tray,
  h('button', { type: 'button', class: ['wf-clip', 'wf-press'], 'aria-label': 'ファイルや画像を添える', disabled: !on, onclick: () => c.picker.click() }, ICON.clip()),
  h('label', { class: 'wf-sec-field' }, h('span', { class: 'wf-sr', text: c.where === 'main' ? '秘書に送る' : 'スレッドに返信する' }), c.input),
  h('button', { type: 'button', class: ['wf-send', 'wf-press'], 'aria-label': '送る', disabled: !on || view.busy, onclick: () => send(c) }, ICON.send()),
  c.picker);
}

// A scroll box that stays at the bottom when something new came and the reader was there.
function scroller(where, key, children, newest) {
  const el = h('div', {
    class: where === 'main' ? 'wf-scroll' : 'wf-thread-scroll', data: { scroll: key },
    onscroll: (e) => {
      const x = e.currentTarget;
      view.atBottom[where] = x.scrollHeight - x.scrollTop - x.clientHeight < 60;
    },
  }, ...children);
  const moved = newest !== view.lastId[where];
  view.lastId[where] = newest;
  if (view.pin[where] || (moved && view.atBottom[where]) || ctxRef?.first) {
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
      view.atBottom[where] = true;
    });
    if (!view.busy) view.pin[where] = false;
  }
  return el;
}

// The conversation, and the open thread with it. Opening a thread with unread messages marks
// it read.
const load = async (api) => {
  const [main, thread] = await Promise.all([
    api('/secretary'),
    view.thread ? api(`/secretary/threads/${encodeURIComponent(view.thread)}`).catch(() => null) : null,
  ]);
  if (view.thread && !thread) view.thread = null;
  if (thread) {
    const t = main.threads?.[thread.thread.parent_id];
    if (t?.unread) {
      markRead(thread.thread.id);
      main.threads[thread.thread.parent_id] = { ...t, unread: 0 };
    }
  }
  return { main, thread };
};

function render(data, ctx) {
  ctxRef = ctx;
  connect();
  const { main } = data;
  const thread = view.thread ? data.thread : null;
  const on = main.secretary?.on === true;
  const replying = on && main.secretary.replying;
  const items = timeline(main.items, 'main', { threads: main.threads, liveId: main.thread, replying });
  const list = h('div', { class: 'wf-list' },
    items.length ? items : h('p', { class: 'wf-empty-talk', text: on ? 'まだ何もありません。話しかけてみてください' : 'まだ何もありません' }));
  const scroll = scroller('main', 'chat', [list], `${main.items.at(-1)?.id ?? ''}${view.live.has(main.thread) ? '+' : ''}`);
  const problems = view.problems.length ? h('ul', { class: 'wf-errors', role: 'alert' }, ...view.problems.map((x) => h('li', { text: x }))) : null;
  const bar = h('div', { class: 'wf-sec-bar' },
    on ? null : h('p', { class: 'wf-chat-off', text: '秘書は止まっています' }),
    thread ? null : problems,
    composerEl(boxes.main, on));

  let aside = null;
  if (thread) {
    const id = thread.thread.id;
    const tItems = timeline(thread.items, 'thread', { liveId: id, replying: on && thread.secretary.replying });
    const parent = thread.parent
      ? h('div', { class: 'wf-thread-parent' }, h('small', { text: thread.parent.role === 'user' ? '自分の発言' : '秘書の発言' }), h('p', { text: thread.parent.body.replace(/\*\*|`/g, '') }))
      : null;
    const slide = view.slid !== id ? 'wf-slide' : null;
    view.slid = id;
    aside = h('aside', { class: ['wf-thread', slide], 'aria-label': 'スレッド' },
      h('div', { class: 'wf-thread-head' }, h('span', { text: 'スレッド' }),
        h('button', { type: 'button', class: 'wf-thread-close', 'aria-label': '閉じる', onclick: closeThread }, ICON.close())),
      scroller('thread', 'thread', [parent, ...tItems], `${thread.items.at(-1)?.id ?? ''}${view.live.has(id) ? '+' : ''}`),
      h('div', { class: 'wf-thread-bar' }, problems, composerEl(boxes.thread, on)));
  }

  clearTimeout(pollTimer);
  if (!view.streamOk && (replying || thread?.secretary?.replying)) pollTimer = setTimeout(() => ctxRef?.refresh(), POLL_MS);

  return h('div', { class: ['wf-sec', aside && 'wf-with-thread'] },
    h('div', { class: 'wf-sec-main' }, ctx.banner(), scroll, bar),
    aside);
}

function skeleton(ctx) {
  ctxRef = ctx;
  const row = (mine) => h('div', { class: ['wf-m', mine && 'wf-mine'] }, skel(mine ? '180px' : '320px', '40px'));
  return h('div', { class: 'wf-sec' },
    h('div', { class: 'wf-sec-main', 'aria-busy': 'true' }, ctx.banner(),
      h('div', { class: 'wf-scroll' }, h('div', { class: 'wf-list' }, row(true), row(false))),
      h('div', { class: 'wf-sec-bar' }, composerEl(boxes.main, false))));
}

export default { load, render, skeleton };
