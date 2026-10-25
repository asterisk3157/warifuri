// Small helpers shared by the Web screens. Every piece of data goes into the DOM as text
// (text nodes, textContent, attribute values); markup is only ever built from constants here.

const SVG_NS = 'http://www.w3.org/2000/svg';

// h('div', { class: 'x', text: 'y', onclick: fn, aria: { label: 'z' }, style: { width: '4px' } }, ...children)
// Children are nodes or strings (made text nodes); null, undefined and false are skipped.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  setAttrs(el, attrs);
  append(el, children);
  return el;
}

function setAttrs(el, attrs) {
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'style') Object.assign(el.style, v);
    else if (k === 'aria') {
      for (const [a, av] of Object.entries(v)) if (av !== undefined && av !== null) el.setAttribute(`aria-${a}`, String(av));
    } else if (k === 'data') for (const [a, av] of Object.entries(v)) el.dataset[a] = String(av);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

// An SVG element; s('path', { d: '…' }).
export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  for (const c of children) if (c) el.append(c);
  return el;
}

// Icons, from constant shapes only.
const ICONS = {
  calendar: [['g', { class: 'wf-cal' }, [['rect', { x: 4, y: 5, width: 16, height: 15, rx: 2 }], ['path', { d: 'M4 10h16M8 3v4M16 3v4' }]]]],
  tasks: [['circle', { cx: 12, cy: 12, r: 8 }], ['path', { class: 'wf-check', d: 'M8.5 12l2.5 2.5 4.5-5' }]],
  server: [['g', {}, [
    ['rect', { class: 'wf-srv1', x: 3, y: 4, width: 18, height: 7, rx: 2 }],
    ['rect', { class: 'wf-srv2', x: 3, y: 13, width: 18, height: 7, rx: 2 }],
    ['path', { class: 'wf-led wf-led1', d: 'M7 7.5h.01' }],
    ['path', { class: 'wf-led wf-led2', d: 'M7 16.5h.01' }],
  ]]],
  serverSmall: [['rect', { x: 3, y: 4, width: 18, height: 7, rx: 2 }], ['rect', { x: 3, y: 13, width: 18, height: 7, rx: 2 }], ['path', { d: 'M7 7.5h.01M7 16.5h.01' }]],
  secretary: [['path', { d: 'M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4 4v-4H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z' }]],
  knowledge: [['path', { d: 'M5 4h9a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z' }], ['path', { d: 'M17 7h2v13H8' }]],
  desk: [['rect', { x: 3, y: 4, width: 18, height: 12, rx: 2 }], ['path', { d: 'M8 20h8M12 16v4' }]],
  gear: [['g', { class: 'wf-gear' }, [
    ['path', { d: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z' }],
    ['circle', { cx: 12, cy: 12, r: 3 }],
  ]]],
  laptop: [['rect', { x: 4, y: 5, width: 16, height: 10, rx: 1.5 }], ['path', { d: 'M2 19h20' }]],
  back: [['path', { d: 'M19 12H5M11 6l-6 6 6 6' }]],
  display: [['circle', { cx: 12, cy: 12, r: 8 }], ['path', { d: 'M12 4a8 8 0 0 1 0 16z', fill: 'currentColor' }]],
  life: [['circle', { cx: 12, cy: 12, r: 4 }], ['path', { d: 'M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4' }]],
  folder: [['path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }]],
  apps: [['rect', { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }], ['rect', { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }], ['rect', { x: 3, y: 14, width: 7, height: 7, rx: 1.5 }], ['rect', { x: 14, y: 14, width: 7, height: 7, rx: 1.5 }]],
  after: [['path', { d: 'M7 4v8a4 4 0 0 0 4 4h8' }], ['path', { d: 'M15 12l4 4-4 4' }]],
};

const build = ([tag, attrs, kids]) => s(tag, attrs, ...(kids ?? []).map(build));

export function icon(name, size = 20, width = 1.75) {
  return s(
    'svg',
    { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    ...ICONS[name].map(build),
  );
}

// The GitHub mark.
export function githubIcon() {
  return s('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true' },
    s('path', { d: 'M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49v-1.7c-2.78.62-3.37-1.37-3.37-1.37-.46-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.36 1.12 2.94.85.09-.67.35-1.12.63-1.38-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.04 1.03-2.76-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.4 9.4 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.64 1.03 2.76 0 3.94-2.34 4.8-4.57 5.06.36.32.68.94.68 1.9v2.82c0 .27.18.6.69.49A10.1 10.1 0 0 0 22 12.25C22 6.58 17.52 2 12 2z' }));
}

// Pictures of machines for the about dialog.
const MACHINES = {
  mac: [['rect', { x: 26, y: 6, width: 138, height: 92, rx: 9, fill: '#f2f2f4' }], ['rect', { x: 31, y: 11, width: 128, height: 82, rx: 5, fill: '#bfe3fb' }], ['rect', { x: 85, y: 11, width: 20, height: 4, rx: 2, fill: '#e5e5ea' }], ['path', { d: 'M8 100 h174 l-6 10 a6 6 0 0 1 -5 3 h-152 a6 6 0 0 1 -5 -3 z', fill: '#e5e5ea' }], ['rect', { x: 80, y: 100, width: 30, height: 3, rx: 1.5, fill: '#d2d2d7' }]],
  windows: [['rect', { x: 20, y: 4, width: 150, height: 88, rx: 8, fill: '#f2f2f4' }], ['rect', { x: 26, y: 10, width: 138, height: 76, rx: 4, fill: '#bfe3fb' }], ['rect', { x: 86, y: 92, width: 18, height: 14, fill: '#e5e5ea' }], ['rect', { x: 62, y: 106, width: 66, height: 7, rx: 3.5, fill: '#e5e5ea' }]],
  linux: [0, 36, 72].flatMap((y) => [['rect', { x: 40, y: 6 + y, width: 110, height: 30, rx: 6, fill: '#f2f2f4' }], ['rect', { x: 50, y: 16 + y, width: 44, height: 4, rx: 2, fill: '#e5e5ea' }], ['rect', { x: 50, y: 23 + y, width: 30, height: 4, rx: 2, fill: '#e5e5ea' }], ['circle', { cx: 134, cy: 21 + y, r: 5, fill: '#bfe3fb' }]]),
  device: [['rect', { x: 28, y: 4, width: 134, height: 94, rx: 6, fill: '#f2f2f4' }], ['rect', { x: 36, y: 12, width: 118, height: 76, rx: 2, fill: '#bfe3fb' }], ['circle', { cx: 95, cy: 8, r: 1.8, fill: '#e5e5ea' }], ['rect', { x: 14, y: 98, width: 162, height: 12, rx: 3, fill: '#e5e5ea' }], ['rect', { x: 40, y: 101, width: 110, height: 2, rx: 1, fill: '#d2d2d7' }], ['rect', { x: 40, y: 105, width: 110, height: 2, rx: 1, fill: '#d2d2d7' }]],
};

export function machinePicture(kind) {
  return s('svg', { width: 190, height: 118, viewBox: '0 0 190 118', 'aria-hidden': 'true' }, ...(MACHINES[kind] ?? MACHINES.linux).map(build));
}

// Gray blocks standing in for what is not there yet (loading, 準備中). Never animated.
export function skel(width, height, extra = {}) {
  return h('span', { class: 'wf-skel', 'aria-hidden': 'true', style: { width, height, ...extra } });
}

export const soonBadge = () => h('span', { class: 'wf-soon', text: '準備中' });

// Times, in the browser's own clock.
const pad = (n) => String(n).padStart(2, '0');
export const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
export const hhmm = (d) => `${d.getHours()}:${pad(d.getMinutes())}`;
export const hhmm2 = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const md = (d) => `${d.getMonth() + 1}/${pad(d.getDate())}`;
export const mdw = (d) => `${md(d)}（${WEEKDAYS[d.getDay()]}）`;
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

// An ISO time with this browser's offset, such as 2026-10-25T00:00:00+09:00.
export function isoLocal(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

// A due date (YYYY-MM-DD or an ISO time) as a local day.
export function dueDay(due) {
  if (!due) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(due);
  return Number.isNaN(d.getTime()) ? null : dayStart(d);
}

// Whole days from today to a day (negative: past).
export const daysFrom = (today, day) => Math.round((dayStart(day) - dayStart(today)) / 86400000);

// How long ago, in words.
export function ago(iso, now = new Date()) {
  if (!iso) return 'まだ';
  const ms = now - new Date(iso);
  if (ms < 2 * 60 * 1000) return '現在';
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}分前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}時間前`;
  return `${Math.floor(hr / 24)}日前`;
}

export const NEUTRAL = '#c9ced6';
export const profileColor = (name, colors) => (name && /^#[0-9a-f]{6}$/i.test(colors?.[name] ?? '') ? colors[name] : NEUTRAL);

// A profile's dot and name.
export function profileChip(name, colors, size = 13) {
  return h('span', { class: 'wf-pchip', style: { fontSize: `${size}px` } },
    h('span', { class: 'wf-dot', style: { background: profileColor(name, colors) }, 'aria-hidden': 'true' }),
    name ?? 'プロフィールなし');
}

// A pale tint of a colour, for backgrounds (share: how much of the colour).
export function tint(hex, share = 0.28) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c) => Math.round(c * share + 255 * (1 - share));
  return `rgb(${mix((n >> 16) & 255)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}
