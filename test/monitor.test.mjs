import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarize, fetchHomelab, parseAliases, QUERIES } from '../src/monitor/homelab.mjs';
import { localMachine, secretaryJobs } from '../src/monitor/local.mjs';

const row = (labels, value) => ({ labels, value: String(value) });
const empty = () => Object.fromEntries(Object.keys(QUERIES).map((k) => [k, []]));

test('summarize: hosts, guests and what is worth telling, worst first', () => {
  const data = {
    ...empty(),
    guests: [row({ host: 'box', id: 'qemu/100', name: 'web' }, 1), row({ host: 'box', id: 'qemu/101', name: 'game' }, 1), row({ host: 'box', id: 'lxc/102', name: 'db' }, 1)],
    up: [row({ host: 'box', id: 'qemu/100' }, 1), row({ host: 'box', id: 'qemu/101' }, 0), row({ host: 'box', id: 'lxc/102' }, 0)],
    onboot: [row({ host: 'box', id: 'qemu/100' }, 1), row({ host: 'box', id: 'qemu/101' }, 0), row({ host: 'box', id: 'lxc/102' }, 1)],
    guestCpu: [row({ host: 'box', id: 'qemu/100' }, 0.25)],
    guestMemUsed: [row({ host: 'box', id: 'qemu/100' }, 2)],
    guestMemSize: [row({ host: 'box', id: 'qemu/100' }, 8)],
    cpu: [row({ host: 'node1' }, 12)],
    threads: [row({ host: 'node1' }, 8)],
    memory: [row({ host: 'node1' }, 91)],
    memTotal: [row({ host: 'node1' }, 32 * 1024 ** 3)],
    disk: [row({ host: 'node1', mountpoint: '/' }, 40), row({ host: 'node1', mountpoint: '/data' }, 95)],
    temp: [row({ host: 'node1' }, 55)],
    backupHours: [row({}, 40)],
    alerts: [row({ alertname: 'DiskFull', severity: 'critical' }, 1)],
  };
  const s = summarize(data, { aliases: { box: 'node1' } });
  assert.equal(s.level, 'bad');
  assert.deepEqual(s.guests.map((g) => [g.name, g.host, g.up, g.always, g.cpu, g.memory]), [
    ['db', 'node1', false, true, null, null],
    ['game', 'node1', false, false, null, null],
    ['web', 'node1', true, true, 25, 25],
  ]);
  assert.deepEqual(s.hosts, [{ host: 'node1', cpu: 12, threads: 8, memory: 91, memoryGb: 32, disk: 95, mount: '/data', tempC: 55, uptimeDays: null, guests: { up: 1, total: 3 } }]);
  assert.deepEqual(s.notes.map((n) => n.level), ['bad', 'bad', 'bad', 'warn', 'warn']);
  assert.match(s.notes.map((n) => n.text).join('\n'), /db が止まっています/);
  assert.ok(!s.notes.some((n) => /game/.test(n.text)), 'a guest stopped on purpose is not a fault');
  assert.equal(summarize(empty()).level, 'ok');
});

test('fetchHomelab: every query asked, and an error said in words when the monitoring cannot be read', async () => {
  const asked = [];
  const fetchFn = async (url) => {
    asked.push(decodeURIComponent(new URL(url).searchParams.get('query')));
    return { status: 200, json: async () => ({ status: 'success', data: { result: [] } }) };
  };
  const out = await fetchHomelab('http://mon.example:9090/', { fetchFn, now: () => Date.parse('2026-11-09T00:00:00Z') });
  assert.equal(asked.length, Object.keys(QUERIES).length);
  assert.equal(out.level, 'ok');
  assert.equal(out.at, '2026-11-09T00:00:00.000Z');
  const down = await fetchHomelab('http://mon.example:9090', { fetchFn: async () => { throw new Error('connect refused'); } });
  assert.match(down.error, /監視から数字を読めませんでした\(connect refused\)/);
  assert.deepEqual(parseAliases('nas=nas-01, a = b,bad'), { nas: 'nas-01', a: 'b' });
});

test('localMachine and secretaryJobs: this machine, and the last run of each job from its log', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-mon-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const here = localMachine(home);
  assert.ok(here.cores >= 1 && here.memoryGb >= 0);
  assert.ok(here.disk.percent >= 0 && here.disk.percent <= 100);
  const logs = path.join(home, 'secretary', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'sync.log'), '同期しました。取り込み 0 件\n');
  fs.writeFileSync(path.join(logs, 'nightly.log'), 'Failed to authenticate: OAuth session expired and could not be refreshed\n');
  const jobs = secretaryJobs(home);
  assert.deepEqual(jobs.map((j) => [j.job, j.ok]), [['nightly', false], ['sync', true]]);
  assert.match(jobs[0].problem, /ログインが切れています/);
});
