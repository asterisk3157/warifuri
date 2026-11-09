import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localMachine, secretaryJobs } from '../src/monitor/local.mjs';
import { detailData, fetchDetail, parseAliases, DETAIL_QUERIES } from '../src/monitor/detail.mjs';

const row = (labels, value) => ({ labels, value: String(value) });

test('fetchDetail: every query asked, and an error said in words when the monitoring cannot be read', async () => {
  const asked = [];
  const fetchFn = async (url) => {
    asked.push(new URL(url).pathname.split('/').at(-1));
    return { status: 200, json: async () => ({ status: 'success', data: { result: [] } }) };
  };
  const out = await fetchDetail('http://mon.example:9090/', { fetchFn, now: () => Date.parse('2026-11-09T00:00:00Z') });
  assert.equal(asked.filter((p) => p === 'query').length, Object.keys(DETAIL_QUERIES.instant).length);
  assert.equal(asked.filter((p) => p === 'query_range').length, Object.keys(DETAIL_QUERIES.range).length);
  assert.equal(out.at, '2026-11-09T00:00:00.000Z');
  assert.deepEqual([out.machines, out.guests, out.power], [[], [], null]);
  const down = await fetchDetail('http://mon.example:9090', { fetchFn: async () => { throw new Error('connect refused'); } });
  assert.equal(down.error, '監視サーバーに接続できません');
  assert.equal(down.reason, 'connect refused');
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

test('a guest has the GPU use only when it reports the GPU itself', () => {
  const guest = (id, name) => row({ host: 'node-a', id, name }, 1);
  const data = detailData({
    instant: {
      guests: [guest('qemu/100', 'web'), guest('lxc/102', 'db')],
      up: [row({ host: 'node-a', id: 'qemu/100' }, 1), row({ host: 'node-a', id: 'lxc/102' }, 1)],
      gpuUtil: [row({ host: 'web' }, 37), row({ host: 'node-a' }, 12)],
    },
    window: { start: 0, end: 60, step: 60 },
  });
  const gpu = Object.fromEntries(data.guests.map((g) => [g.name, g.gpu]));
  assert.deepEqual(gpu, { web: 37, db: null });
});

test('a guest that reports its own numbers is a guest, not a machine', () => {
  const data = detailData({
    instant: {
      guests: [row({ host: 'node-a', id: 'qemu/100', name: 'web' }, 1)],
      memTotal: [row({ host: 'node-a' }, 64), row({ host: 'web' }, 8)],
    },
    window: { start: 0, end: 60, step: 60 },
  });
  assert.deepEqual(data.machines.map((m) => m.host), ['node-a']);
});
