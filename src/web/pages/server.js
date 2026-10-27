// サーバー: the warifuri server, the devices that use it with the tasks they hold, and a
// place kept for the home server (準備中).

import { h, skel, soonBadge, ago, profileChip, dayStart, hhmm, md } from '../ui.js';

const load = (api) => api('/server');

function uptime(sec) {
  if (sec < 3600) return `${Math.max(1, Math.floor(sec / 60))}分`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}時間`;
  return `${Math.floor(sec / 86400)}日`;
}

function backup(iso, now) {
  if (!iso) return 'なし';
  const d = new Date(iso);
  const today = +dayStart(d) === +dayStart(now);
  return `${today ? '今日' : md(d)} ${hhmm(d)}`;
}

const fresh = (iso, now) => iso && now - new Date(iso) < 60 * 60 * 1000;

function how(d) {
  if (d.has_key && d.github_login) return 'シークレット · GitHub ログイン';
  if (d.has_key) return 'シークレット';
  if (d.github_login) return 'GitHub ログイン';
  return 'つなぎ方なし';
}

function serverCard(data, ctx) {
  const facts = [['MCP サーバー', data.mcp_url], ['バージョン', data.version ? `v${data.version}` : '—'], ['稼働時間', uptime(data.uptime_s)], ['最終バックアップ', backup(data.last_backup_at, ctx.now)]];
  return h('section', { class: 'wf-surface wf-srv-card' },
    h('div', { class: 'wf-srv-title' }, h('h2', { text: 'warifuri サーバー' }),
      h('span', { class: 'wf-online' }, h('span', { class: 'wf-led-dot', 'aria-hidden': 'true' }), ctx.offline ? 'つながっていません' : 'オンライン')),
    h('div', { class: 'wf-facts' }, ...facts.map(([label, value]) => h('div', { class: 'wf-fact' }, h('span', { text: label }), h('span', { text: value })))));
}

function devices(data, ctx) {
  const rows = data.devices.map((d) => {
    const ok = fresh(d.last_seen_at, ctx.now);
    return h('button', { type: 'button', class: 'wf-row wf-row-dev', title: 'このデバイスについて', data: { key: `dev-${d.name}` }, onclick: (e) => ctx.openAbout({ type: 'device', device: d }, e.currentTarget) },
      h('span', { class: 'wf-devname' }, h('span', { class: ['wf-devdot', ok && 'wf-fresh'], 'aria-hidden': 'true' }),
        h('span', { class: 'wf-cell' }, h('b', { text: d.name }), h('span', { class: 'wf-muted', text: how(d) }))),
      h('span', { style: { color: ok ? '#1d1d1f' : '#8e8e93' }, text: ago(d.last_seen_at, ctx.now) }),
      h('span', { class: 'wf-cell' },
        d.holds.length ? d.holds.map((x) => h('span', { class: 'wf-hold' }, h('b', { text: x.title }),
          h('span', { class: 'wf-hold-sub' }, profileChip(x.profile, data.profiles), h('span', { class: 'wf-ellipsis', text: `· ${x.path ?? x.place_name ?? '作業フォルダの外'}` }))))
          : h('span', { class: 'wf-muted', text: 'なし' })));
  });
  return h('section', { class: 'wf-surface wf-table' },
    h('div', { class: 'wf-table-head' }, h('h2', { text: 'デバイス' }), h('span', { class: 'wf-muted', text: `${data.devices.length}台` })),
    h('div', { class: 'wf-cols wf-cols-dev' }, h('span', { text: 'デバイス' }), h('span', { text: '最終接続' }), h('span', { text: '作業中のタスク' })),
    ...rows,
    rows.length ? null : h('div', { class: 'wf-empty', text: 'まだデバイスがありません。使う機械で warifuri connect を実行すると、ここに出ます' }));
}

function render(data, ctx) {
  return h('div', { class: 'wf-page-scroll', data: { scroll: 'server' } }, ctx.head('サーバー'), ctx.banner(), serverCard(data, ctx), devices(data, ctx));
}

function skeleton(ctx) {
  return h('div', { class: 'wf-page-scroll' }, ctx.head('サーバー'), ctx.banner(),
    h('section', { class: 'wf-surface wf-srv-card', 'aria-busy': 'true' }, skel('180px', '17px'),
      h('div', { class: 'wf-facts' }, ...[0, 1, 2, 3].map(() => h('div', { class: 'wf-fact' }, skel('60%', '13px'), skel('80%', '15px'))))),
    h('section', { class: 'wf-surface wf-table', 'aria-busy': 'true' }, h('div', { class: 'wf-table-head' }, skel('100px', '17px')),
      ...[0, 1, 2].map(() => h('div', { class: 'wf-row wf-row-dev' }, skel('70%', '15px'), skel('50%', '15px'), skel('80%', '15px')))));
}

export default { load, render, skeleton };
