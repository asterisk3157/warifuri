// カメラ: the live view of each camera of WARIFURI_CAMERAS. The browser opens the camera itself;
// warifuri only gives the addresses. Before showing the view, a still picture is loaded: when it
// does not come (this browser is outside the network the camera is on), a short line says where
// it shows instead, and the picture is tried again at each reading.
//
// Chrome asks before a page on the internet reads from a machine on a local network (the
// cameras sit on Tailscale's 100.x addresses): until the person allows it, the picture does not
// come. So when the permission is still to be asked, a button asks for it; when it was refused,
// a line says where to allow it.
//
// A live view starts again whenever its frame is put back in the page, so the page is drawn
// again only when the cameras change: each tile is made once and kept.

import { h, skel } from '../ui.js';

const PROBE_MS = 8_000;
const tiles = new Map();
let latest = null;
let drawn = null;

const sig = (data) => JSON.stringify(data?.cameras ?? []);

// Loads the still picture; ok(true) when it came, ok(false) when it failed or took too long.
function probe(frame, ok) {
  const img = new Image();
  let done = false;
  const end = (v) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    img.onload = img.onerror = null;
    img.src = '';
    ok(v);
  };
  const timer = setTimeout(() => end(false), PROBE_MS);
  img.onload = () => end(true);
  img.onerror = () => end(false);
  img.src = `${frame}${frame.includes('?') ? '&' : '?'}t=${Date.now()}`;
}

// The state of Chrome's permission to reach local networks: 'granted', 'prompt', 'denied', or
// 'granted' where the browser has no such permission (it then lets the picture through).
async function localAccess() {
  try {
    return (await navigator.permissions.query({ name: 'local-network-access' })).state;
  } catch {
    return 'granted';
  }
}

// Asks Chrome for the permission: a request to the camera, made from the person's click.
async function askAccess(frame) {
  try {
    await fetch(frame, { mode: 'no-cors', cache: 'no-store', targetAddressSpace: 'local' });
  } catch {
    // refused or out of reach: the check after this says which
  }
}

function makeTile(cam) {
  const box = h('div', { class: 'wf-cam-view', 'aria-busy': 'true' }, skel('100%', '100%', { borderRadius: '0' }));
  const tile = { cam, box, state: 'checking' };
  // Opening the live view in its own tab needs no permission (a page of its own is not a page on
  // the internet reading a local machine), so it is there whenever the view cannot be shown here.
  const open = () => h('a', { class: 'wf-btn-line', href: cam.stream, target: '_blank', rel: 'noopener noreferrer', text: '新しいタブで開く' });
  const show = (...kids) => {
    box.removeAttribute('aria-busy');
    box.replaceChildren(h('div', { class: 'wf-cam-away' }, ...kids));
  };
  tile.check = async () => {
    tile.state = 'checking';
    const access = await localAccess();
    if (access === 'prompt') {
      tile.state = 'away';
      show(
        h('p', { text: 'このブラウザで映像を見るには、許可が要ります' }),
        h('div', { class: 'wf-cam-actions' },
          h('button', { type: 'button', class: 'wf-btn-line', text: '許可する', onclick: async () => {
            await askAccess(cam.frame);
            tile.check();
          } }),
          open()),
      );
      return;
    }
    if (access === 'denied') {
      tile.state = 'away';
      show(h('p', { text: 'ローカル ネットワークへのアクセスが、このサイトで拒否されています。アドレスバーの左のボタンから許可してください' }), open());
      return;
    }
    probe(cam.frame, (ok) => {
      if (ok) {
        tile.state = 'live';
        box.removeAttribute('aria-busy');
        box.replaceChildren(h('iframe', {
          src: cam.stream, title: cam.name, loading: 'lazy', allow: 'autoplay; fullscreen; local-network-access; local-network', allowfullscreen: true,
          referrerpolicy: 'no-referrer', sandbox: 'allow-scripts allow-same-origin',
        }));
      } else {
        tile.state = 'away';
        show(h('p', { text: 'Tailscale につないだ端末で開くと映ります' }), open());
      }
    });
  };
  tile.el = h('section', { class: 'wf-surface wf-cam' }, h('div', { class: 'wf-table-head' }, h('h2', { text: cam.name })), box);
  tile.check();
  return tile;
}

async function load(api) {
  latest = await api('/cameras');
  // A camera that was out of reach is tried again.
  for (const t of tiles.values()) if (t.state === 'away') t.check();
  return latest;
}

function render(data, ctx) {
  const key = (c) => `${c.name}\n${c.stream}`;
  const keep = new Set(data.cameras.map(key));
  for (const k of [...tiles.keys()]) if (!keep.has(k)) tiles.delete(k);
  const shown = data.cameras.map((c) => {
    if (!tiles.has(key(c))) tiles.set(key(c), makeTile(c));
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
