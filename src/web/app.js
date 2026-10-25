// The frame of the Web screens: the sidebar, the card at its foot, the about dialog, and the
// reading every 30 seconds. Each screen (pages/*.js) gives { load(api), skeleton(ctx),
// render(data, ctx), nav?(ctx), busy?() }.

import { h, icon, machinePicture, soonBadge, hhmm2, ago } from './ui.js';
import calendar from './pages/calendar.js';
import tasks from './pages/tasks.js';
import server from './pages/server.js';
import secretary from './pages/secretary.js';
import settings from './pages/settings.js';

const PAGES = { calendar, tasks, server, secretary, settings };
const NAME = location.pathname.split('/')[1] || 'calendar';
const page = PAGES[NAME] ?? calendar;
const TITLES = { calendar: 'カレンダー', tasks: 'タスク', server: 'サーバー', secretary: '秘書', settings: '設定' };
const REFRESH_MS = 30_000;

const nav = document.getElementById('wf-nav');
const main = document.getElementById('wf-main');
const layer = document.getElementById('wf-layer');

const state = { about: null, data: null, lastOk: null, offline: false, login: false, first: true };

try {
  if (NAME !== 'settings') sessionStorage.setItem('wf.back', `/${NAME}`);
} catch {
  // Storage may be off; 戻る then goes to the calendar.
}
document.title = `warifuri · ${TITLES[NAME] ?? 'カレンダー'}`;

class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

// Reads (or, with a body, writes) /web/api/<path>.
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/web/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status, json);
  return json;
}

// The header of a screen: its title, when it was read, and the banner when the server is away.
function head(title, ...right) {
  const updated = h('span', { class: 'wf-updated', text: state.lastOk ? `${hhmm2(state.lastOk)} に更新` : '' });
  return h('header', { class: 'wf-head' }, h('h1', { text: title }), updated, ...right);
}

function banner() {
  if (state.login) {
    return h('div', { class: 'wf-banner', role: 'status' }, h('span', { class: 'wf-led-dot', 'aria-hidden': 'true' }),
      'ログインが切れました。warifuri serve が表示したログインの URL を開き直してください。');
  }
  if (!state.offline) return null;
  const when = state.lastOk ? `最後に読んだのは ${hhmm2(state.lastOk)}` : 'まだ読めていません';
  return h('div', { class: 'wf-banner', role: 'status' }, h('span', { class: 'wf-led-dot', 'aria-hidden': 'true' }), `サーバーにつながりません。${when}`);
}

// The card at the foot of the sidebar: where warifuri runs (ローカルホスト or サーバー). It
// opens the dialog of the host machine.
function card() {
  const a = state.about;
  const label = state.offline ? 'つながっていません' : (a?.label ?? 'ローカルホスト');
  return h('button', { type: 'button', class: ['wf-card', state.offline && 'wf-offline'], title: 'このサーバーについて', onclick: (e) => openAbout({ type: 'server' }, e.currentTarget) },
    h('span', { class: 'wf-card-row wf-card-label' }, h('span', { class: 'wf-led-dot', 'aria-hidden': 'true' }), label));
}

function navItem(key, label, iconName) {
  return h('a', { class: 'wf-nav-item', href: `/${key}`, aria: { current: NAME === key ? 'page' : undefined } }, icon(iconName), h('span', { text: label }));
}

function soonItem(label, iconName) {
  return h('span', { class: 'wf-nav-item wf-disabled', 'aria-disabled': 'true' }, icon(iconName), h('span', { text: label }), soonBadge());
}

function renderNav() {
  if (page.nav) {
    nav.className = 'wf-nav-settings';
    nav.replaceChildren(...page.nav(ctx()), card());
    return;
  }
  nav.className = '';
  nav.replaceChildren(
    h('div', { class: 'wf-nav-gap' }),
    navItem('calendar', 'カレンダー', 'calendar'),
    navItem('tasks', 'タスク', 'tasks'),
    navItem('server', 'サーバー', 'server'),
    navItem('secretary', '秘書', 'secretary'),
    soonItem('ナレッジ', 'knowledge'),
    soonItem('デスク', 'desk'),
    h('a', { class: 'wf-nav-item wf-nav-bottom', href: '/settings' }, icon('gear'), h('span', { text: '設定' })),
    card(),
  );
}

// What a screen gets to draw with.
function ctx() {
  return { about: state.about, offline: state.offline, first: state.first, now: new Date(), head, banner, api, rerender: draw, refresh, openAbout };
}

// Draws the screen again, keeping where each scroll box was and which control had focus.
function draw() {
  const scrolls = [...main.querySelectorAll('[data-scroll]')].map((el) => [el.dataset.scroll, el.scrollTop, el.scrollLeft]);
  const focused = document.activeElement?.dataset?.key;
  const c = ctx();
  main.replaceChildren(state.data ? page.render(state.data, c) : page.skeleton(c));
  for (const [key, top, left] of scrolls) {
    const el = main.querySelector(`[data-scroll="${CSS.escape(key)}"]`);
    if (el) {
      el.scrollTop = top;
      el.scrollLeft = left;
    }
  }
  if (focused) main.querySelector(`[data-key="${CSS.escape(focused)}"]`)?.focus();
  if (state.data) state.first = false;
  renderNav();
}

let timer;
async function refresh() {
  clearTimeout(timer);
  try {
    const [about, data] = await Promise.all([api('/about'), page.load(api)]);
    Object.assign(state, { about, data, lastOk: new Date(), offline: false, login: false });
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) state.login = true;
    else if (err instanceof HttpError && state.about) {
      // The server answered but refused this read: keep the last screen.
    } else state.offline = true;
  }
  if (page.busy?.()) renderNav();
  else draw();
  timer = setTimeout(refresh, REFRESH_MS);
}

// The about dialog: of the host machine (chip, memory, OS, 接続先), or of one device
// (its name, 接続先, 最終接続).
function openAbout(what, opener) {
  const a = state.about;
  const where = a ? `${a.label} · ${a.url.replace(/^https?:\/\//, '')}` : '—';
  const close = () => {
    layer.replaceChildren();
    document.removeEventListener('keydown', onKey, true);
    opener?.focus?.();
  };
  const closeBtn = h('button', { type: 'button', class: 'wf-btn-line wf-btn-small', text: '閉じる', onclick: close });
  let body;
  if (what.type === 'device') {
    const d = what.device;
    body = [
      machinePicture('device'),
      h('span', { class: 'wf-dialog-name', id: 'wf-dialog-title', text: d.name }),
      h('dl', { class: 'wf-spec' }, h('dt', { text: '接続先' }), h('dd', { text: where }), h('dt', { text: '最終接続' }), h('dd', { text: ago(d.last_seen_at) })),
      h('span', { class: 'wf-dialog-actions' }, closeBtn),
    ];
  } else {
    const m = a?.machine;
    body = [
      machinePicture(m?.kind),
      h('span', { class: 'wf-dialog-name', id: 'wf-dialog-title', text: 'ホストマシン' }),
      h('dl', { class: 'wf-spec' },
        h('dt', { text: 'チップ' }), h('dd', { text: m ? `${m.chip}${m.cores ? `（${m.cores}コア）` : ''}` : '—' }),
        h('dt', { text: 'メモリ' }), h('dd', { text: m ? `${m.memory_gb} GB` : '—' }),
        h('dt', { text: 'OS' }), h('dd', { text: m?.os ?? '—' }),
        h('dt', { text: '接続先' }), h('dd', { text: where })),
      h('span', { class: 'wf-dialog-actions' }, NAME === 'server' ? null : h('a', { class: 'wf-btn-line', href: '/server', text: 'サーバー画面で見る' }), closeBtn),
    ];
  }
  const dialog = h('div', { class: 'wf-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'wf-dialog-title', onclick: (e) => e.stopPropagation() }, ...body);
  const backdrop = h('div', { class: 'wf-backdrop', onclick: close }, dialog);
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      const items = [...dialog.querySelectorAll('a[href], button:not([disabled])')];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (!dialog.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      }
    }
  }
  layer.replaceChildren(backdrop);
  document.addEventListener('keydown', onKey, true);
  closeBtn.focus();
}

draw();
refresh();
