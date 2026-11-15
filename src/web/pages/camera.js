// カメラ: the live view of each camera of WARIFURI_CAMERAS, relayed by this server
// (src/server/camera-relay.mjs), so it comes from this origin wherever the browser is. When the
// camera cannot be reached, the view itself says so and tries again.
//
// A live view starts again whenever its frame is put back in the page, so the page is drawn
// again only when the cameras change: each tile is made once and kept.

import { h, skel } from '../ui.js';

const tiles = new Map();
let latest = null;
let drawn = null;

const sig = (data) => JSON.stringify(data?.cameras ?? []);

// A click on a view makes it large (the whole width, as tall as the screen allows), and
// another click puts it back; the change glides where the browser can (view transitions).
// The click is taken by a clear layer over the frame, since a frame keeps its own clicks.
function makeTile(cam, i) {
  const el = h('section', { class: 'wf-surface wf-cam', style: { viewTransitionName: `wf-cam-${i}` } });
  const hit = h('button', { type: 'button', class: 'wf-cam-hit', 'aria-label': '大きく表示', 'aria-pressed': 'false' });
  hit.onclick = () => {
    const big = !el.classList.contains('wf-cam-big');
    const flip = () => {
      el.classList.toggle('wf-cam-big', big);
      hit.setAttribute('aria-pressed', String(big));
      hit.setAttribute('aria-label', big ? '元の大きさに戻す' : '大きく表示');
    };
    if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(flip);
    else flip();
    if (big) requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  };
  const box = h('div', { class: 'wf-cam-view' }, h('iframe', {
    src: cam.stream, title: cam.name, loading: 'lazy', allow: 'autoplay',
    referrerpolicy: 'no-referrer', sandbox: 'allow-scripts allow-same-origin',
  }), hit);
  el.append(h('div', { class: 'wf-table-head' }, h('h2', { text: cam.name })), box);
  return { cam, el };
}

async function load(api) {
  latest = await api('/cameras');
  return latest;
}

function render(data, ctx) {
  const key = (c) => `${c.name}\n${c.stream}`;
  const keep = new Set(data.cameras.map(key));
  for (const k of [...tiles.keys()]) if (!keep.has(k)) tiles.delete(k);
  const shown = data.cameras.map((c, i) => {
    if (!tiles.has(key(c))) tiles.set(key(c), makeTile(c, i));
    return tiles.get(key(c)).el;
  });
  drawn = sig(data);
  return h('div', { class: 'wf-page-scroll', data: { scroll: 'camera' } }, ctx.head('カメラ'), ctx.banner(), h('div', { class: 'wf-cam-grid' }, ...shown));
}

function skeleton(ctx) {
  return h('div', { class: 'wf-page-scroll' }, ctx.head('カメラ'), ctx.banner(),
    h('div', { class: 'wf-cam-grid' }, h('section', { class: 'wf-surface wf-cam', 'aria-busy': 'true' },
      h('div', { class: 'wf-table-head' }, skel('80px', '18px')), h('div', { class: 'wf-cam-view' }, skel('100%', '100%', { borderRadius: '0' })))));
}

// Kept as it is while the cameras are the same, so that the live views go on.
const busy = () => drawn !== null && latest !== null && sig(latest) === drawn;

export default { load, render, skeleton, busy };
