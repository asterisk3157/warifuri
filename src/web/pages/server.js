// サーバー: the home lab as a task manager shows it (パフォーマンス: each machine's CPU per
// thread, memory, disks, GPU and the power of the lab over the last hour; 一覧: the VMs and
// containers), when a monitoring URL is set; and warifuri itself (the server, its machine,
// how the secretary's runs last went, and the devices that use it with the tasks they hold).

import { h, s, skel, ago, profileChip, dayStart, hhmm, md } from '../ui.js';

const view = { tab: null, sel: null };

async function load(api) {
  const [server, monitor] = await Promise.all([api('/server'), api('/server/monitor').catch(() => null)]);
  return { server, monitor };
}

// ---- small pieces ----

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
const or = (v, unit = '') => (v === null || v === undefined ? '—' : `${v}${unit}`);
const gib = (bytes) => (bytes === null || bytes === undefined ? null : Math.round(bytes / 2 ** 30));
const mbs = (bps) => (bps === null || bps === undefined ? '—' : `${(bps / 1e6).toFixed(1)} MB/s`);
// How long a machine has run, as Windows' task manager writes it: days:hours:minutes.
const dhm = (sec) => {
  if (sec === null || sec === undefined) return '—';
  const p2 = (n) => String(n).padStart(2, '0');
  return `${Math.floor(sec / 86400)}:${p2(Math.floor((sec % 86400) / 3600))}:${p2(Math.floor((sec % 3600) / 60))}`;
};
const kwh = (wh) => (wh === null || wh === undefined ? '—' : `${(wh / 1000).toFixed(1)} kWh`);

// The colours of the graphs of Windows' task manager, so the view reads as one.
const COLOR = { cpu: '#117dbb', memory: '#8b12ae', disk: '#4da60c', gpu: '#117dbb', power: '#a74f01' };

// A line over the last hour, filled below it, scaled to max (100 for percentages).
function graph(series, color, { max = 100, cls = 'wf-tm-graph' } = {}) {
  const data = series && series.length > 1 ? series : [0, 0];
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * 100},${30 - (Math.min(max, Math.max(0, v)) / max) * 30}`);
  return s('svg', { class: cls, viewBox: '0 0 100 30', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
    s('polygon', { points: `0,30 ${pts.join(' ')} 100,30`, fill: color, 'fill-opacity': '0.1' }),
    s('polyline', { points: pts.join(' '), fill: 'none', stroke: color, 'stroke-width': '1.2', 'vector-effect': 'non-scaling-stroke' }));
}

// A bar with its number, coloured when it comes near the limit.
function meter(percent, { warn = 85, bad = 93, label = null } = {}) {
  const head = label ? h('span', { class: 'wf-meter-label', text: label }) : null;
  if (percent === null || percent === undefined) return h('span', { class: 'wf-meter' }, head, h('span', { class: 'wf-meter-n wf-muted', text: '—' }));
  const level = percent > bad ? 'bad' : percent > warn ? 'warn' : 'ok';
  return h('span', { class: ['wf-meter', `wf-meter-${level}`] }, head,
    h('span', { class: 'wf-meter-track', 'aria-hidden': 'true' }, h('i', { style: { width: `${Math.max(2, Math.min(100, percent))}%` } })),
    h('span', { class: 'wf-meter-n', text: `${percent}%` }));
}

// ---- 自宅サーバー: what the monitoring tells ----

// The items of the left list, one per thing measured, grouped by machine.
function itemsOf(detail) {
  const groups = detail.machines.map((m) => {
    const items = [];
    const hostStats = [['温度', or(m.cpu.tempC, '℃')], ['稼働中の VM', `${m.guests.up}台`], ['稼働時間', dhm(m.cpu.uptimeSeconds)]];
    items.push({
      id: `${m.host}:cpu`, kind: 'cpu', title: 'CPU', line: or(m.cpu.percent, '%'), color: COLOR.cpu, series: m.cpu.series,
      head: m.cpu.model ? `${m.cpu.model} · ${m.cpu.threads} スレッド` : `${m.cpu.threads} スレッド`, cores: m.cpu.cores,
      stats: [['使用率', or(m.cpu.percent, '%')], ...hostStats],
    });
    const mem = m.memory;
    items.push({
      id: `${m.host}:mem`, kind: 'memory', title: 'メモリ', line: mem.totalBytes === null ? '—' : `${gib(mem.usedBytes)} / ${gib(mem.totalBytes)} GB`, color: COLOR.memory,
      series: mem.series, head: mem.totalBytes === null ? '' : `${gib(mem.totalBytes)} GB`,
      stats: [['使用中', or(gib(mem.usedBytes), ' GB')], ['利用可能', or(gib(mem.availableBytes), ' GB')], ['使用率', or(mem.percent, '%')]],
    });
    for (const d of m.disks) {
      items.push({
        id: `${m.host}:disk:${d.device}`, kind: 'disk', title: `ディスク ${d.n}`, line: d.model ?? d.device, color: COLOR.disk, series: d.series,
        head: d.model ? `${d.model}(${d.device})` : d.device, unit: '使用率',
        stats: [['使用率', or(d.series.length ? Math.round(d.series.at(-1)) : null, '%')], ['読み込み', mbs(d.readBps)], ['書き込み', mbs(d.writeBps)]],
      });
    }
    if (m.gpu) {
      items.push({
        id: `${m.host}:gpu`, kind: 'gpu', title: 'GPU', line: `${m.gpu.name ? `${m.gpu.name} ` : ''}${or(m.gpu.tempC, '℃')}`, color: COLOR.gpu, series: m.gpu.series, max: 100,
        head: m.gpu.name ?? '', unit: '温度',
        stats: [['温度', or(m.gpu.tempC, '℃')], ['使用率', or(m.gpu.utilization, '%')], ['電力', or(m.gpu.powerWatts, ' W')]],
      });
    }
    return { name: m.host, items };
  });
  if (detail.power) {
    const p = detail.power;
    groups.push({
      name: '全体',
      items: [{
        id: 'power', kind: 'power', title: '消費電力', line: or(p.watts, ' W'), color: COLOR.power, series: p.series, max: 400,
        head: 'コンセントで測定した、サーバー全体の消費電力', unit: '消費電力',
        stats: [['今', or(p.watts, ' W')], ['今日', kwh(p.todayWh)], ['今月', kwh(p.monthWh)]],
      }],
    });
  }
  return groups;
}

function sideList(groups, ctx) {
  return h('nav', { class: 'wf-tm-side', 'aria-label': '測っているもの' },
    ...groups.map((g) => h('div', { class: 'wf-tm-group' },
      h('div', { class: 'wf-tm-host', text: g.name }),
      ...g.items.map((it) => h('button', {
        type: 'button', class: ['wf-tm-item', view.sel === it.id && 'wf-tm-picked'], 'aria-pressed': String(view.sel === it.id), data: { key: `tm-${it.id}` },
        onclick: () => { view.sel = it.id; ctx.rerender(); },
      }, h('span', { class: 'wf-tm-spark', style: { borderColor: it.color } }, graph(it.series, it.color, { max: it.max ?? 100 })),
        h('span', { class: 'wf-tm-item-text' }, h('b', { text: it.title }), h('span', { class: 'wf-muted', text: it.line })))))));
}

// The grid of threads takes the room left above the numbers, with as many columns as keep each
// cell near the shape of Windows' (a little wider than tall) and every row full. It is worked out again whenever
// the panel changes size.
let coreFit = null;
function fitCores(grid, n) {
  coreFit?.disconnect();
  coreFit = new ResizeObserver(() => {
    if (!grid.isConnected) return;
    const { width, height } = grid.getBoundingClientRect();
    if (!width || !height) return;
    let best = 1, score = Infinity;
    // Only counts that fill every row, so no cell is left alone at the end.
    for (let cols = 1; cols <= n; cols++) {
      if (n % cols) continue;
      const ratio = (width / cols) / (height / Math.ceil(n / cols));
      const off = Math.abs(Math.log(ratio / 1.6));
      if (off < score) { score = off; best = cols; }
    }
    grid.style.gridTemplateColumns = `repeat(${best}, minmax(0, 1fr))`;
  });
  coreFit.observe(grid);
  return grid;
}

function mainPanel(it, minutes) {
  if (!it) return h('section', { class: 'wf-tm-main' }, h('p', { class: 'wf-empty', text: '監視から機械が見つかりませんでした' }));
  const axis = h('div', { class: 'wf-tm-axis' }, h('span', { text: `${minutes}分前` }), h('span', { text: '今' }));
  let body;
  if (it.kind === 'cpu' && it.cores.length) {
    const cols = it.cores.length > 16 ? 8 : 4;
    body = h('div', { class: 'wf-tm-body' },
      h('div', { class: 'wf-tm-scale' }, h('span', { text: 'スレッドごとの使用率' }), h('span', { text: '100%' })),
      fitCores(h('div', { class: 'wf-tm-cores', style: { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } },
        ...it.cores.map((series, n) => h('div', { class: 'wf-tm-core', style: { borderColor: it.color } },
          h('span', { class: 'wf-tm-core-n', text: String(n) }), h('span', { class: 'wf-tm-core-p', text: or(series.length ? Math.round(series.at(-1)) : null, '%') }),
          graph(series, COLOR.cpu, { cls: 'wf-tm-core-graph' })))), it.cores.length),
      axis);
  } else {
    body = h('div', { class: 'wf-tm-body' },
      h('div', { class: 'wf-tm-scale' }, h('span', { text: it.unit ?? '使用率' }), h('span', { text: it.max === 400 ? '400 W' : it.kind === 'gpu' ? '100℃' : '100%' })),
      h('div', { class: 'wf-tm-big', style: { borderColor: it.color } }, graph(it.series, it.color, { max: it.max ?? 100 })),
      axis);
  }
  return h('section', { class: 'wf-tm-main' },
    h('div', { class: 'wf-tm-title' }, h('h2', { text: it.title }), h('span', { class: 'wf-muted', text: it.head })),
    body,
    h('div', { class: 'wf-tm-stats' }, ...it.stats.map(([label, value]) => h('div', { class: 'wf-tm-stat' }, h('span', { text: label }), h('b', { text: value })))));
}

function performance(detail, ctx) {
  const groups = itemsOf(detail);
  const items = groups.flatMap((g) => g.items);
  if (!items.some((it) => it.id === view.sel)) view.sel = items[0]?.id ?? null;
  return h('div', { class: 'wf-surface wf-tm' }, sideList(groups, ctx), mainPanel(items.find((it) => it.id === view.sel), detail.minutes));
}

// Bytes as GB, with one decimal while small.
const gb = (bytes) => {
  if (bytes === null || bytes === undefined) return null;
  const v = bytes / 2 ** 30;
  return v < 10 ? v.toFixed(1) : String(Math.round(v));
};
const coresText = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

// What a guest was given and how much of it is in use, with the share of it.
function given(percent, used, total, unit, warn) {
  const amount = total === null || total === undefined ? null : used === null || used === undefined ? `${total} ${unit}` : `${used} / ${total} ${unit}`;
  return h('span', { class: 'wf-tm-num wf-tm-given' },
    h('b', { class: percent !== null && percent > warn ? 'wf-tm-hot' : '', text: or(percent, '%') }),
    h('span', { class: 'wf-muted', text: amount ?? '' }));
}

function guestList(detail) {
  const avg = (key) => {
    const known = detail.guests.map((g) => g[key]).filter((v) => v !== null);
    return known.length ? `${Math.round(known.reduce((a, b) => a + b, 0) / known.length)}%` : '—';
  };
  const hosts = [...new Set(detail.guests.map((g) => g.host))];
  const cpu = (g) => given(g.cpu, g.cpuUsedCores === null ? null : g.cpuUsedCores.toFixed(1), g.cpuCores === null ? null : coresText(g.cpuCores), 'コア', 80);
  const mem = (g) => given(g.memory, gb(g.memoryUsedBytes), gb(g.memoryTotalBytes), 'GB', 90);
  const disk = (g) => given(g.disk, gb(g.diskUsedBytes), gb(g.diskTotalBytes), 'GB', 85);
  return h('section', { class: 'wf-surface wf-table' },
    h('div', { class: 'wf-cols wf-cols-vm' }, h('span', { text: '名前' }), h('span', { text: '種類' }), h('span', { text: '状態' }),
      h('span', { class: 'wf-tm-num' }, h('b', { text: avg('cpu') }), h('br'), 'CPU'),
      h('span', { class: 'wf-tm-num' }, h('b', { text: avg('memory') }), h('br'), 'メモリ'),
      h('span', { class: 'wf-tm-num' }, h('b', { text: avg('disk') }), h('br'), 'ディスク')),
    ...hosts.flatMap((host) => [
      h('div', { class: 'wf-tm-hostrow', text: host }),
      ...detail.guests.filter((g) => g.host === host).map((g) => h('div', { class: ['wf-row', 'wf-row-vm', !g.up && 'wf-row-off'] },
        h('span', { class: 'wf-devname' }, h('span', { class: ['wf-devdot', g.up && 'wf-fresh', !g.up && g.always && 'wf-devdot-bad'], 'aria-hidden': 'true' }), h('b', { class: 'wf-ellipsis', text: g.name })),
        h('span', { class: 'wf-muted', text: `${g.type === 'lxc' ? 'LXC' : 'VM'} ${g.vmid ?? ''}` }),
        h('span', { class: !g.up && g.always ? 'wf-bad' : '', text: g.up ? '稼働中' : g.always ? '止まっています' : '停止' }),
        cpu(g), mem(g), disk(g))),
    ]),
    detail.guests.length ? null : h('div', { class: 'wf-empty', text: 'VM とコンテナは見つかりませんでした' }));
}

// ---- warifuri ----

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

function hereCard(here) {
  if (!here) return null;
  const rows = [
    ['CPU', meter(here.cpu, { warn: 80, bad: 95 }), `${here.cores} コア`],
    ['メモリ', meter(here.memory, { warn: 90, bad: 97 }), `${here.memoryGb} GB`],
    ['ディスク', meter(here.disk?.percent ?? null), here.disk ? `空き ${here.disk.freeGb} GB` : ''],
  ];
  return h('section', { class: 'wf-surface wf-table' },
    h('div', { class: 'wf-table-head' }, h('h2', { text: 'この機械' }), h('span', { class: 'wf-muted', text: `稼働時間 ${dhm(here.uptimeSeconds)}` })),
    ...rows.map(([label, bar, sub]) => h('div', { class: 'wf-row wf-row-meter' }, h('b', { text: label }), bar, h('span', { class: 'wf-muted', text: sub }))));
}

function jobsCard(jobs, ctx) {
  if (!jobs?.length) return null;
  return h('section', { class: 'wf-surface wf-table' },
    h('div', { class: 'wf-table-head' }, h('h2', { text: '秘書の仕事' }), h('span', { class: 'wf-muted', text: '最後の結果' })),
    ...jobs.map((j) => h('div', { class: 'wf-row wf-row-job' },
      h('span', { class: 'wf-devname' }, h('span', { class: ['wf-devdot', j.ok && 'wf-fresh', !j.ok && 'wf-devdot-bad'], 'aria-hidden': 'true' }), h('b', { text: j.title })),
      h('span', { text: ago(j.at, ctx.now) }),
      h('span', { class: ['wf-cell', !j.ok && 'wf-bad'], text: j.ok ? '成功' : j.problem }))));
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

// ---- the page ----

const TABS = [['perf', 'パフォーマンス'], ['list', '一覧'], ['warifuri', 'warifuri']];

function render(data, ctx) {
  const { server, monitor } = data;
  const lab = monitor?.configured ? monitor : null;
  if (!view.tab || (!lab && view.tab !== 'warifuri')) view.tab = lab ? 'perf' : 'warifuri';
  const tabs = lab
    ? h('div', { class: 'wf-seg', role: 'group', 'aria-label': '表示' }, ...TABS.map(([key, label]) => h('button', {
      type: 'button', 'aria-pressed': String(view.tab === key), data: { key: `tab-${key}` }, onclick: () => { view.tab = key; ctx.rerender(); }, text: label,
    })))
    : null;
  let body;
  if (view.tab === 'warifuri') {
    body = [serverCard(server, ctx), hereCard(server.here), jobsCard(server.jobs, ctx), devices(server, ctx),
      lab ? null : h('p', { class: 'wf-muted wf-tm-hint', text: '自宅サーバーの監視(Prometheus)の URL を設定すると、自宅サーバーの機械と VM も出ます' })];
  } else if (lab.detail?.error) {
    body = [h('section', { class: 'wf-surface wf-table' }, h('div', { class: 'wf-empty wf-bad', text: lab.detail.error }))];
  } else {
    body = [view.tab === 'perf' ? performance(lab.detail, ctx) : guestList(lab.detail)];
  }
  return h('div', { class: 'wf-page-scroll', data: { scroll: 'server' } },
    ctx.head('サーバー', h('span', { class: 'wf-head-gap' }), tabs), ctx.banner(), ...body);
}

function skeleton(ctx) {
  return h('div', { class: 'wf-page-scroll' }, ctx.head('サーバー'), ctx.banner(),
    h('section', { class: 'wf-surface wf-tm', 'aria-busy': 'true' },
      h('div', { class: 'wf-tm-side' }, ...[0, 1, 2, 3, 4].map(() => h('div', { class: 'wf-tm-item' }, skel('56px', '28px'), h('span', { class: 'wf-tm-item-text' }, skel('60%', '12px'), skel('40%', '10px'))))),
      h('div', { class: 'wf-tm-main' }, skel('120px', '22px'), skel('100%', '200px', { borderRadius: '8px' }))));
}

export default { load, render, skeleton };
