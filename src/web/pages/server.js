// サーバー: the warifuri server and how its machine is doing, how the secretary's runs last
// went, the devices that use it with the tasks they hold, and the home lab's machines and
// guests as its monitoring tells them (when a monitoring URL is set).

import { h, skel, ago, profileChip, dayStart, hhmm, md } from '../ui.js';

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

// A bar with its number, coloured when it comes near the limit.
// label: what it measures, shown beside it only on a narrow screen (where the column heads go).
function meter(percent, { warn = 85, bad = 93, label = null } = {}) {
  const head = label ? h('span', { class: 'wf-meter-label', text: label }) : null;
  if (percent === null || percent === undefined) return h('span', { class: 'wf-meter' }, head, h('span', { class: 'wf-meter-n wf-muted', text: '—' }));
  const level = percent > bad ? 'bad' : percent > warn ? 'warn' : 'ok';
  return h('span', { class: ['wf-meter', `wf-meter-${level}`] }, head,
    h('span', { class: 'wf-meter-track', 'aria-hidden': 'true' }, h('i', { style: { width: `${Math.max(2, Math.min(100, percent))}%` } })),
    h('span', { class: 'wf-meter-n', text: `${percent}%` }));
}

function hereCard(here) {
  if (!here) return null;
  const facts = [
    ['CPU', meter(here.cpu, { warn: 80, bad: 95 }), `${here.cores} コア`],
    ['メモリ', meter(here.memory, { warn: 90, bad: 97 }), `${here.memoryGb} GB`],
    ['ディスク', meter(here.disk?.percent ?? null), here.disk ? `空き ${here.disk.freeGb} GB` : ''],
  ];
  return h('section', { class: 'wf-surface wf-table' },
    h('div', { class: 'wf-table-head' }, h('h2', { text: 'この機械' }), h('span', { class: 'wf-muted', text: `稼働 ${here.uptimeDays}日` })),
    ...facts.map(([label, bar, sub]) => h('div', { class: 'wf-row wf-row-meter' }, h('b', { text: label }), bar, h('span', { class: 'wf-muted', text: sub }))));
}

function jobsCard(jobs, ctx) {
  if (!jobs?.length) return null;
  return h('section', { class: 'wf-surface wf-table' },
    h('div', { class: 'wf-table-head' }, h('h2', { text: '秘書の仕事' }), h('span', { class: 'wf-muted', text: '最後の結果' })),
    ...jobs.map((j) => h('div', { class: 'wf-row wf-row-job' },
      h('span', { class: 'wf-devname' }, h('span', { class: ['wf-devdot', j.ok && 'wf-fresh', !j.ok && 'wf-devdot-bad'], 'aria-hidden': 'true' }), h('b', { text: j.title })),
      h('span', { text: ago(j.at, ctx.now) }),
      h('span', { class: ['wf-cell', !j.ok && 'wf-bad'], text: j.ok ? 'うまくいきました' : j.problem }))));
}

const VERDICT = { ok: '問題ありません', warn: '気にしておくことがあります', bad: '対処が要ることがあります' };

function homeServer(lab, ctx) {
  if (!lab) {
    return h('section', { class: 'wf-surface wf-table' },
      h('div', { class: 'wf-table-head' }, h('h2', { class: 'wf-muted', text: '自宅サーバー' })),
      h('div', { class: 'wf-empty', text: '自宅サーバーの監視(Prometheus)の URL を設定すると、機械と VM の様子がここに出ます' }));
  }
  if (lab.error) {
    return h('section', { class: 'wf-surface wf-table' },
      h('div', { class: 'wf-table-head' }, h('h2', { text: '自宅サーバー' })),
      h('div', { class: 'wf-empty wf-bad', text: lab.error }));
  }
  const facts = [
    lab.backupHours !== null ? `バックアップ ${lab.backupHours}時間前` : null,
    lab.gpu !== null ? `GPU ${lab.gpu}℃` : null,
    lab.power !== null ? `電力 ${lab.power}W` : null,
    `警報 ${lab.alerts.length}件`,
  ].filter(Boolean);
  const summary = h('section', { class: 'wf-surface wf-srv-card' },
    h('div', { class: 'wf-srv-title' }, h('h2', { text: '自宅サーバー' }),
      h('span', { class: ['wf-verdict', `wf-verdict-${lab.level}`], text: VERDICT[lab.level] })),
    lab.notes.length ? h('ul', { class: 'wf-notes' }, ...lab.notes.map((n) => h('li', { class: n.level === 'bad' ? 'wf-bad' : 'wf-warn', text: n.text }))) : null,
    h('p', { class: 'wf-muted', text: `${facts.join(' · ')} · ${hhmm(new Date(lab.at))} に更新` }));
  const hosts = h('section', { class: 'wf-surface wf-table' },
    h('div', { class: 'wf-table-head' }, h('h2', { text: '機械' }), h('span', { class: 'wf-muted', text: `${lab.hosts.length}台` })),
    h('div', { class: 'wf-cols wf-cols-host' }, h('span', { text: '機械' }), h('span', { text: 'CPU' }), h('span', { text: 'メモリ' }), h('span', { text: 'ディスク' }), h('span', { text: '温度' })),
    ...lab.hosts.map((m) => h('div', { class: 'wf-row wf-row-host' },
      h('span', { class: 'wf-cell' }, h('b', { text: m.host }),
        h('span', { class: 'wf-muted', text: [m.threads ? `${m.threads} スレッド` : null, m.memoryGb ? `${m.memoryGb} GB` : null, m.guests.total ? `VM ${m.guests.up}/${m.guests.total}` : null, m.uptimeDays !== null ? `稼働 ${m.uptimeDays}日` : null].filter(Boolean).join(' · ') })),
      meter(m.cpu, { warn: 80, bad: 95, label: 'CPU' }), meter(m.memory, { warn: 90, bad: 97, label: 'メモリ' }), meter(m.disk, { label: 'ディスク' }),
      h('span', { class: 'wf-meter' }, h('span', { class: 'wf-meter-label', text: '温度' }), h('span', { class: 'wf-meter-n', text: m.tempC !== null ? `${m.tempC}℃` : '—' })))));
  const guests = lab.guests.length
    ? h('section', { class: 'wf-surface wf-table' },
      h('div', { class: 'wf-table-head' }, h('h2', { text: 'VM とコンテナ' }), h('span', { class: 'wf-muted', text: `${lab.guests.filter((g) => g.up).length}/${lab.guests.length} 台が稼働中` })),
      h('div', { class: 'wf-cols wf-cols-guest' }, h('span', { text: '名前' }), h('span', { text: '状態' }), h('span', { text: 'CPU' }), h('span', { text: 'メモリ' })),
      ...lab.guests.map((g) => h('div', { class: ['wf-row', 'wf-row-guest', !g.up && 'wf-row-off'] },
        h('span', { class: 'wf-cell' }, h('b', { text: g.name }), h('span', { class: 'wf-muted', text: `${g.host} · ${g.id}` })),
        h('span', { class: !g.up && g.always ? 'wf-bad' : g.up ? '' : 'wf-muted', text: g.up ? '稼働中' : g.always ? '止まっています' : '止めてある' }),
        g.up ? meter(g.cpu, { warn: 80, bad: 95, label: 'CPU' }) : null,
        g.up ? meter(g.memory, { warn: 90, bad: 97, label: 'メモリ' }) : null)))
    : null;
  return [summary, hosts, guests];
}

function render(data, ctx) {
  return h('div', { class: 'wf-page-scroll', data: { scroll: 'server' } }, ctx.head('サーバー'), ctx.banner(),
    serverCard(data, ctx), hereCard(data.here), jobsCard(data.jobs, ctx), devices(data, ctx), ...[homeServer(data.homelab, ctx)].flat());
}

function skeleton(ctx) {
  return h('div', { class: 'wf-page-scroll' }, ctx.head('サーバー'), ctx.banner(),
    h('section', { class: 'wf-surface wf-srv-card', 'aria-busy': 'true' }, skel('180px', '17px'),
      h('div', { class: 'wf-facts' }, ...[0, 1, 2, 3].map(() => h('div', { class: 'wf-fact' }, skel('60%', '13px'), skel('80%', '15px'))))),
    h('section', { class: 'wf-surface wf-table', 'aria-busy': 'true' }, h('div', { class: 'wf-table-head' }, skel('100px', '17px')),
      ...[0, 1, 2].map(() => h('div', { class: 'wf-row wf-row-dev' }, skel('70%', '15px'), skel('50%', '15px'), skel('80%', '15px')))));
}

export default { load, render, skeleton };
