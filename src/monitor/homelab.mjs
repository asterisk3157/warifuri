// 自宅サーバー: how the machines of a home lab are doing, out of the numbers its monitoring
// (Prometheus, with node_exporter and the Proxmox collector) already collects. Three
// questions, as a person asks them:
//   1. Is everything that should be running, running?
//   2. Is there room left (disk, memory, heat)?
//   3. Are the safeguards working (backups, the alerts themselves)?
// summarize is pure; fetchHomelab asks the monitoring. No machine is named here: the hosts
// and the guests are what the monitoring reports.

export const LIMITS = Object.freeze({ diskWarn: 85, diskBad: 93, memoryWarn: 90, gpuWarn: 78, backupWarnHours: 36 });

// PromQL of every number used. Each gives rows of { labels, value }.
export const QUERIES = Object.freeze({
  guests: 'pve_guest_info',
  up: 'pve_up{id=~"(qemu|lxc)/.*"}',
  onboot: 'pve_onboot_status',
  cpu: 'round(100 * (1 - avg by (host) (rate(node_cpu_seconds_total{mode="idle"}[1m]))))',
  threads: 'count by (host) (node_cpu_seconds_total{mode="idle"})',
  memory: 'round(100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes))',
  memTotal: 'node_memory_MemTotal_bytes',
  disk: 'round(max by (host, mountpoint) (100 - node_filesystem_avail_bytes{fstype!~"tmpfs|fuse.lxcfs|squashfs|vfat|fuse|nfs4"} / node_filesystem_size_bytes * 100))',
  temp: 'max by (host) (node_hwmon_temp_celsius{chip=~"platform_coretemp.*"})',
  boot: 'node_boot_time_seconds',
  storage: 'round(100 * pve_disk_usage_bytes{id=~"storage/.*"} / pve_disk_size_bytes)',
  gpu: 'max(nvidia_gpu_temperature_celsius)',
  power: 'tapo_power_watts',
  backupHours: 'round((time() - max(vzdump_newest_timestamp_seconds)) / 3600)',
  alerts: 'ALERTS{alertstate="firing"}',
  guestCpu: 'pve_cpu_usage_ratio{id=~"(qemu|lxc)/.*"}',
  guestMemUsed: 'pve_memory_usage_bytes{id=~"(qemu|lxc)/.*"}',
  guestMemSize: 'pve_memory_size_bytes{id=~"(qemu|lxc)/.*"}',
});

// A sample as a number; null when there is none or it is not finite.
function num(value) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}
const list = (v) => (Array.isArray(v) ? v : []);
const round = (v) => (v === null ? null : Math.round(v) + 0);
const percentOf = (part, all) => (part === null || all === null || all <= 0 ? null : round((100 * part) / all));

// aliases: { 'name the Proxmox collector uses': 'host name of node_exporter' }, for a machine
// the two call differently.
export function summarize(data, { limits = LIMITS, aliases = {}, nowSeconds = Date.now() / 1000 } = {}) {
  const alias = (host) => aliases[host] ?? host;
  const rows = (name) => list(data[name]);
  const byHost = (name) => Object.fromEntries(rows(name).map((r) => [r.labels?.host, num(r.value)]));
  const pick = (name, match) => {
    for (const r of rows(name)) if (match(r.labels ?? {})) return num(r.value);
    return null;
  };
  const notes = [];

  const guests = rows('guests')
    .map((r) => {
      const l = r.labels ?? {};
      const own = (x) => x.host === l.host && x.id === l.id;
      const up = pick('up', own) === 1;
      const share = pick('guestCpu', own);
      return {
        name: String(l.name ?? ''), host: alias(String(l.host ?? '')), id: String(l.id ?? ''),
        up, always: pick('onboot', own) === 1,
        cpu: up && share !== null ? round(100 * share) : null,
        memory: up ? percentOf(pick('guestMemUsed', own), pick('guestMemSize', own)) : null,
      };
    })
    .sort((a, b) => a.host.localeCompare(b.host) || a.name.localeCompare(b.name));
  // A guest switched off on purpose (not set to start at boot) is not a fault.
  for (const g of guests.filter((x) => !x.up && x.always)) {
    notes.push({ key: `down:${g.host}:${g.id}`, level: 'bad', text: `${g.name} が止まっています(常に動かす設定)` });
  }

  const cpu = byHost('cpu');
  const memory = byHost('memory');
  const threads = byHost('threads');
  const memTotal = byHost('memTotal');
  const temp = byHost('temp');
  const boot = byHost('boot');
  const disks = {};
  for (const r of rows('disk')) {
    const p = num(r.value);
    const host = r.labels?.host;
    if (p === null) continue;
    if (!disks[host] || p > disks[host].percent) disks[host] = { percent: round(p), mount: r.labels?.mountpoint ?? null };
    if (p > limits.diskWarn) {
      notes.push({ key: `disk:${host}:${r.labels?.mountpoint}`, level: p > limits.diskBad ? 'bad' : 'warn', text: `${host} のディスク(${r.labels?.mountpoint})が ${round(p)}% まで埋まっています` });
    }
  }
  const names = [...new Set([...Object.keys(cpu), ...Object.keys(memory), ...Object.keys(disks)])].filter((x) => x && x !== 'undefined').sort();
  const hosts = names.map((host) => {
    const hosted = guests.filter((g) => g.host === host);
    return {
      host,
      cpu: round(cpu[host] ?? null),
      threads: threads[host] ?? null,
      memory: round(memory[host] ?? null),
      memoryGb: memTotal[host] ? Math.round(memTotal[host] / 1024 ** 3) : null,
      disk: disks[host]?.percent ?? null,
      mount: disks[host]?.mount ?? null,
      tempC: round(temp[host] ?? null),
      uptimeDays: boot[host] ? Math.max(0, Math.floor((nowSeconds - boot[host]) / 86400)) : null,
      guests: { up: hosted.filter((g) => g.up).length, total: hosted.length },
    };
  });
  for (const h of hosts) {
    if (h.memory !== null && h.memory >= limits.memoryWarn) notes.push({ key: `memory:${h.host}`, level: 'warn', text: `${h.host} のメモリが ${h.memory}% まで使われています` });
  }

  const storage = rows('storage')
    .map((r) => ({ host: alias(String(r.labels?.host ?? '')), name: String(r.labels?.id ?? '').split('/').pop(), percent: round(num(r.value)) }))
    .filter((s) => s.percent !== null)
    .sort((a, b) => b.percent - a.percent);
  for (const s of storage) {
    if (s.percent > limits.diskWarn) notes.push({ key: `storage:${s.host}:${s.name}`, level: s.percent > limits.diskBad ? 'bad' : 'warn', text: `${s.host} の保存領域 ${s.name} が ${s.percent}% まで埋まっています` });
  }

  const gpu = rows('gpu').length ? round(num(rows('gpu')[0].value)) : null;
  if (gpu !== null && gpu > limits.gpuWarn) notes.push({ key: 'gpu', level: 'warn', text: `GPU が ${gpu}℃ まで上がっています` });
  const backupHours = rows('backupHours').length ? round(num(rows('backupHours')[0].value)) : null;
  if (backupHours !== null && backupHours > limits.backupWarnHours) notes.push({ key: 'backup', level: 'warn', text: `いちばん新しいバックアップが ${backupHours} 時間前です` });
  const alerts = rows('alerts').map((r) => ({ name: String(r.labels?.alertname ?? ''), severity: String(r.labels?.severity ?? '') }));
  for (const a of alerts) notes.push({ key: `alert:${a.name}`, level: a.severity === 'critical' ? 'bad' : 'warn', text: `監視の警報 ${a.name} が鳴っています` });

  notes.sort((a, b) => (a.level === b.level ? 0 : a.level === 'bad' ? -1 : 1));
  const level = notes.some((n) => n.level === 'bad') ? 'bad' : notes.length ? 'warn' : 'ok';
  const power = rows('power').length ? round(num(rows('power')[0].value)) : null;
  return { level, notes, hosts, guests, storage, gpu, power, backupHours, alerts };
}

// Asks the monitoring at url for every query and summarizes. Resolves to the summary with
// `at`, or { error } when the monitoring cannot be read.
export async function fetchHomelab(url, { fetchFn = globalThis.fetch, aliases = {}, now = () => Date.now(), timeoutMs = 8000 } = {}) {
  const base = String(url).replace(/\/$/, '');
  const ask = async (expr) => {
    const res = await fetchFn(`${base}/api/v1/query?query=${encodeURIComponent(expr)}`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json().catch(() => ({}));
    if (body.status !== 'success') throw new Error(body.error || `HTTP ${res.status}`);
    return list(body.data?.result).map((r) => ({ labels: r.metric ?? {}, value: r.value?.[1] }));
  };
  try {
    const names = Object.keys(QUERIES);
    const results = await Promise.all(names.map((n) => ask(QUERIES[n])));
    const data = Object.fromEntries(names.map((n, i) => [n, results[i]]));
    return { at: new Date(now()).toISOString(), ...summarize(data, { aliases, nowSeconds: now() / 1000 }) };
  } catch (err) {
    return { at: new Date(now()).toISOString(), error: '監視サーバーに接続できません', reason: err.message };
  }
}

// The aliases setting, "nas=nas-01,other=name", as an object.
export function parseAliases(text) {
  const out = {};
  for (const part of String(text ?? '').split(',')) {
    const [from, to] = part.split('=').map((s) => s?.trim());
    if (from && to) out[from] = to;
  }
  return out;
}
