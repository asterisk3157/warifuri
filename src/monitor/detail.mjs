// The numbers of the performance view of the home lab, as a task manager shows them: for each
// machine its CPU (per thread, over the last hour), memory, disks, and GPU; the power of the whole lab; and the list of guests. Out of the monitoring
// (Prometheus with node_exporter, the Proxmox collector, and, where there are, the NVIDIA and
// smart plug exporters). No machine or disk is named in the code: they are what the
// monitoring reports. detailData is pure; fetchDetail asks the monitoring.

import { LIMITS, QUERIES } from './homelab.mjs';

const GUEST = 'id=~"(qemu|lxc)/.*"';
const DISKS = 'device!~"dm-.*|loop.*|zd.*|sr.*|nbd.*|md.*"';

export const DETAIL_QUERIES = Object.freeze({
  instant: {
    memTotal: 'node_memory_MemTotal_bytes',
    memAvailable: 'node_memory_MemAvailable_bytes',
    read: `rate(node_disk_read_bytes_total{${DISKS}}[2m])`,
    write: `rate(node_disk_written_bytes_total{${DISKS}}[2m])`,
    diskInfo: `node_disk_info{${DISKS}}`,
    cpuInfo: 'count by (host, model_name) (node_cpu_info)',
    temp: 'max by (host) (node_hwmon_temp_celsius{chip=~"platform_coretemp.*"})',
    boot: 'node_boot_time_seconds',
    gpuInfo: 'nvidia_gpu_temperature_celsius',
    gpuUtil: 'nvidia_gpu_utilization_percent',
    gpuPower: 'nvidia_gpu_power_watts',
    gpuPowerLimit: 'nvidia_gpu_power_limit_watts',
    gpuMemUsed: 'nvidia_gpu_memory_used_bytes',
    gpuMemTotal: 'nvidia_gpu_memory_total_bytes',
    energyToday: 'tapo_energy_today_watt_hours',
    energyMonth: 'tapo_energy_month_watt_hours',
    guests: QUERIES.guests,
    up: QUERIES.up,
    onboot: QUERIES.onboot,
    guestCpu: `pve_cpu_usage_ratio{${GUEST}}`,
    guestCpuLimit: `pve_cpu_usage_limit{${GUEST}}`,
    guestMemUsed: `pve_memory_usage_bytes{${GUEST}}`,
    guestMemSize: `pve_memory_size_bytes{${GUEST}}`,
    guestDiskUsed: `pve_disk_usage_bytes{${GUEST}}`,
    guestDiskSize: `pve_disk_size_bytes{${GUEST}}`,
    rootFull: '100 - 100 * node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}',
  },
  range: {
    cores: '100 * (1 - rate(node_cpu_seconds_total{mode="idle"}[2m]))',
    memory: '100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)',
    busy: `100 * rate(node_disk_io_time_seconds_total{${DISKS}}[2m])`,
    gpuUtil: 'nvidia_gpu_utilization_percent',
    gpuTemp: 'nvidia_gpu_temperature_celsius',
    gpuMemory: '100 * nvidia_gpu_memory_used_bytes / nvidia_gpu_memory_total_bytes',
    gpuPower: 'nvidia_gpu_power_watts',
    power: 'tapo_power_watts',
  },
});

function num(value) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}
const list = (v) => (Array.isArray(v) ? v : []);
const round = (v) => Math.round(v) + 0;
const round1 = (v) => Math.round(v * 10) / 10 + 0;
const whole = (v) => (v === null ? null : round(v));
const percentOf = (part, all) => (part === null || all === null || all <= 0 ? null : round((100 * part) / all));
const within100 = (v) => Math.min(100, Math.max(0, v));
const lastOf = (series) => (series.length ? round(series.at(-1)) : null);
const any = () => true;

function firstValue(rows, match = any) {
  for (const row of list(rows)) {
    const v = num(row?.value);
    if (v !== null && match(row?.labels || {})) return v;
  }
  return null;
}

// The samples of one series on the times of the window (start, start + step, …, end): a time
// without a sample takes the one before it. Empty when there is no sample at all.
export function onWindow(values, { start, end, step }) {
  const samples = list(values)
    .map((p) => [num(p?.[0]), num(p?.[1])])
    .filter(([at, v]) => at !== null && v !== null)
    .sort((a, b) => a[0] - b[0]);
  const length = Math.floor((end - start) / step) + 1;
  if (!samples.length || !Number.isInteger(length) || length < 1) return [];
  const out = [];
  let next = 0;
  let value = samples[0][1];
  for (let i = 0; i < length; i += 1) {
    while (next < samples.length && samples[next][0] <= start + i * step) {
      value = samples[next][1];
      next += 1;
    }
    out.push(value);
  }
  return out;
}

const seriesOf = (matrix, window, match, shape = (v) => v) => {
  const row = list(matrix).find((r) => match(r?.metric || {}));
  return onWindow(row?.values, window).map((v) => round1(shape(v)));
};

// One series per thread of a host, their average, and the busiest thread at the end.
function cpuOf(host, matrix, window) {
  const cores = list(matrix)
    .filter((r) => r?.metric?.host === host)
    .map((r) => ({ n: num(r.metric.cpu), series: onWindow(r.values, window).map((v) => round1(within100(v))) }))
    .sort((a, b) => a.n - b.n);
  const filled = cores.filter((c) => c.series.length);
  const series = Array.from({ length: filled[0]?.series.length ?? 0 }, (_, i) => round1(filled.reduce((sum, c) => sum + c.series[i], 0) / filled.length));
  const top = filled.reduce((best, c) => (best && best.series.at(-1) >= c.series.at(-1) ? best : c), null);
  return { threads: cores.length, percent: lastOf(series), top: top ? { n: top.n, percent: lastOf(top.series) } : null, series, cores: cores.map((c) => c.series) };
}

// instant, range: the answers of DETAIL_QUERIES (range as data.result of query_range).
// window: { start, end, step } in seconds. aliases: Proxmox name → node_exporter name.
export function detailData({ instant = {}, range = {}, window = {}, aliases = {}, now = null } = {}) {
  const alias = (host) => aliases[host] ?? host;
  const pick = (name, match) => firstValue(instant[name], match);
  const nowSeconds = new Date(now ?? NaN).getTime() / 1000;

  const guests = list(instant.guests)
    .map((row) => {
      const l = row?.labels || {};
      const own = (x) => x.host === l.host && x.id === l.id;
      const id = String(l.id ?? '');
      const [prefix, number] = id.split('/');
      const up = pick('up', own) === 1;
      const share = pick('guestCpu', own);
      const cores = pick('guestCpuLimit', own);
      const memUsed = pick('guestMemUsed', own);
      const memSize = pick('guestMemSize', own);
      const diskSize = pick('guestDiskSize', own);
      // What the guest itself reports of its root file system comes first. Without it, Proxmox
      // knows how full a container is, but not a virtual machine.
      const root = pick('rootFull', (x) => x.host === l.name);
      const diskPercent = root !== null ? round(root) : prefix === 'lxc' ? percentOf(pick('guestDiskUsed', own), diskSize) : null;
      return {
        host: alias(String(l.host ?? '')), name: String(l.name ?? ''), id, type: prefix === 'lxc' ? 'lxc' : 'qemu', vmid: num(number),
        up, always: pick('onboot', own) === 1,
        // What it was given (cores, bytes) and how much of it is in use now; null when stopped
        // or when the monitoring does not tell.
        cpu: up && share !== null ? round(100 * share) : null,
        cpuCores: cores,
        cpuUsedCores: up && share !== null && cores !== null ? Math.round(share * cores * 10) / 10 + 0 : null,
        memory: up ? percentOf(memUsed, memSize) : null,
        memoryTotalBytes: whole(memSize),
        memoryUsedBytes: up ? whole(memUsed) : null,
        disk: diskPercent,
        diskTotalBytes: whole(diskSize),
        diskUsedBytes: diskPercent !== null && diskSize !== null ? round((diskPercent / 100) * diskSize) : null,
      };
    })
    .sort((a, b) => a.host.localeCompare(b.host) || (a.vmid ?? 0) - (b.vmid ?? 0));

  const hosts = [...new Set(list(instant.memTotal).map((r) => r?.labels?.host).filter(Boolean))].sort();
  const machines = hosts.map((host) => {
    const node = (l) => l.host === host;
    const totalBytes = whole(pick('memTotal', node));
    const availableBytes = whole(pick('memAvailable', node));
    const usedBytes = totalBytes === null || availableBytes === null ? null : totalBytes - availableBytes;
    const boot = pick('boot', node);
    const cpu = cpuOf(host, range.cores, window);
    const model = list(instant.cpuInfo).find((r) => r?.labels?.host === host)?.labels?.model_name ?? null;
    const devices = [...new Set(list(range.busy).filter((r) => r?.metric?.host === host).map((r) => r.metric.device))].sort();
    const hosted = guests.filter((g) => g.host === host);
    const gpuRow = list(instant.gpuInfo).find((r) => r?.labels?.host === host);
    const gpuMatch = (l) => l.host === host;
    // The GPU as the task manager shows it: how busy, how hot, how much of its memory is used,
    // and what it draws, each over the last hour.
    const gpuOf = (row, match) => {
      const series = (key, keep) => seriesOf(range[key], window, match, keep);
      const util = series('gpuUtil', within100);
      const temp = series('gpuTemp');
      return {
        name: row.labels.name ?? row.labels.modelName ?? null,
        utilization: lastOf(util) ?? whole(pick('gpuUtil', match)),
        tempC: lastOf(temp) ?? whole(num(row.value)), warnC: LIMITS.gpuWarn,
        memoryUsedBytes: whole(pick('gpuMemUsed', match)), memoryTotalBytes: whole(pick('gpuMemTotal', match)),
        powerWatts: whole(pick('gpuPower', match)), powerLimitWatts: whole(pick('gpuPowerLimit', match)),
        series: { utilization: util, temp, memory: series('gpuMemory', within100), power: series('gpuPower') },
      };
    };
    return {
      host,
      cpu: {
        model, threads: cpu.threads, percent: cpu.percent, top: cpu.top, tempC: whole(pick('temp', node)),
        uptimeSeconds: boot === null || !Number.isFinite(nowSeconds) ? null : Math.max(0, Math.floor(nowSeconds - boot)),
        series: cpu.series, cores: cpu.cores,
      },
      memory: {
        totalBytes, usedBytes, availableBytes, percent: percentOf(usedBytes, totalBytes),
        series: seriesOf(range.memory, window, node),
      },
      disks: devices.map((device, i) => {
        const dev = (l) => l.host === host && l.device === device;
        const info = list(instant.diskInfo).find((r) => dev(r?.labels || {}))?.labels ?? {};
        return {
          n: i + 1, device, model: info.model || null,
          readBps: whole(pick('read', dev)), writeBps: whole(pick('write', dev)),
          series: seriesOf(range.busy, window, dev, within100),
        };
      }),
      gpu: gpuRow ? gpuOf(gpuRow, gpuMatch) : null,
      guests: { up: hosted.filter((g) => g.up).length, total: hosted.length },
    };
  });

  const watts = seriesOf(range.power, window, any);
  return {
    at: now, minutes: (window.end - window.start) / 60, step: window.step, machines,
    power: list(range.power).length ? { watts: lastOf(watts), todayWh: whole(pick('energyToday')), monthWh: whole(pick('energyMonth')), series: watts } : null,
    guests,
  };
}

// Asks the monitoring for the last `minutes` (one point a minute) and shapes the answer.
export async function fetchDetail(url, { fetchFn = globalThis.fetch, aliases = {}, now = () => Date.now(), minutes = 60, timeoutMs = 10000 } = {}) {
  const base = String(url).replace(/\/$/, '');
  const end = Math.floor(now() / 1000);
  const window = { start: end - minutes * 60, end, step: 60 };
  const call = async (path, params) => {
    const res = await fetchFn(`${base}/api/v1/${path}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json().catch(() => ({}));
    if (body.status !== 'success') throw new Error(body.error || `HTTP ${res.status}`);
    return list(body.data?.result);
  };
  try {
    const [inames, rnames] = [Object.keys(DETAIL_QUERIES.instant), Object.keys(DETAIL_QUERIES.range)];
    const [ianswers, ranswers] = await Promise.all([
      Promise.all(inames.map((n) => call('query', { query: DETAIL_QUERIES.instant[n] }))),
      Promise.all(rnames.map((n) => call('query_range', { query: DETAIL_QUERIES.range[n], start: window.start, end: window.end, step: window.step }))),
    ]);
    const instant = Object.fromEntries(inames.map((n, i) => [n, ianswers[i].map((r) => ({ labels: r.metric ?? {}, value: r.value?.[1] }))]));
    const range = Object.fromEntries(rnames.map((n, i) => [n, ranswers[i]]));
    return detailData({ instant, range, window, aliases, now: new Date(now()).toISOString() });
  } catch (err) {
    return { at: new Date(now()).toISOString(), error: `監視から数字を読めませんでした(${err.message})` };
  }
}
