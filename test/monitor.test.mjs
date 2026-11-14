import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localMachine, secretaryJobs } from '../src/monitor/local.mjs';
import { detailData, fetchDetail, parseAliases, scrapeSeconds, DETAIL_QUERIES } from '../src/monitor/detail.mjs';

const row = (labels, value) => ({ labels, value: String(value) });

test('fetchDetail: every query asked, and an error said in words when the monitoring cannot be read', async () => {
  const asked = [];
  const fetchFn = async (url) => {
    asked.push(new URL(url).pathname.split('/').at(-1));
    return { status: 200, json: async () => ({ status: 'success', data: { result: [] } }) };
  };
  const out = await fetchDetail('http://mon-a.example:9090/', { fetchFn, now: () => Date.parse('2026-11-09T00:00:00Z') });
  assert.equal(asked.filter((p) => p === 'query').length, Object.keys(DETAIL_QUERIES.instant).length);
  assert.equal(asked.filter((p) => p === 'query_range').length, Object.keys(DETAIL_QUERIES.range).length);
  assert.equal(out.at, '2026-11-09T00:00:00.000Z');
  assert.equal(out.seconds, 60);
  assert.deepEqual([out.machines, out.guests, out.power], [[], [], null]);
  const down = await fetchDetail('http://mon-b.example:9090', { fetchFn: async () => { throw new Error('connect refused'); } });
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

test('secretaryJobs: a run that failed for the login is past once a later run logged in; still red until then', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-mon-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const logs = path.join(home, 'secretary', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const write = (name, text, when) => {
    const file = path.join(logs, name);
    fs.writeFileSync(file, text);
    fs.utimesSync(file, when, when);
  };
  // The weekly inbox failed on a Sunday night; the login was made again on Monday.
  write('inbox.log', 'Failed to authenticate: OAuth session expired and could not be refreshed\n', new Date(2026, 10, 8, 23));
  write('sync.log', '同期しました。取り込み 0 件\n', new Date(2026, 10, 8, 22));
  let jobs = secretaryJobs(home);
  let inbox = jobs.find((j) => j.job === 'inbox');
  assert.deepEqual([inbox.ok, inbox.resolved], [false, false]);
  assert.match(inbox.problem, /ログインが切れています/);

  write('nightly.log', '見張りを終えました\n', new Date(2026, 10, 9, 23));
  jobs = secretaryJobs(home);
  inbox = jobs.find((j) => j.job === 'inbox');
  assert.deepEqual([inbox.ok, inbox.resolved, inbox.problem], [false, true, null]);
  assert.match(inbox.note, /ログインし直せている/);
  assert.equal(jobs.find((j) => j.job === 'nightly').ok, true);

  // A later run that also failed for the login does not clear it.
  write('nightly.log', 'Not logged in\n', new Date(2026, 10, 9, 23));
  write('sync.log', 'Not logged in\n', new Date(2026, 10, 10, 12));
  assert.ok(secretaryJobs(home).every((j) => !j.ok && !j.resolved && j.problem));
  // A thread's turn counts as a run that logged in.
  write('thread-c_1.log', '{"type":"result","result":"了解"}\n', new Date(2026, 10, 11, 12));
  assert.ok(secretaryJobs(home).every((j) => j.resolved));
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

test('scrapeSeconds: the shortest scrape interval of the configuration, in whole seconds', () => {
  assert.equal(scrapeSeconds('global:\n  scrape_interval: 15s\nscrape_configs:\n- job_name: n\n  scrape_interval: 5s\n'), 5);
  assert.equal(scrapeSeconds('global:\n  scrape_interval: 1m'), 60);
  assert.equal(scrapeSeconds('global:\n  scrape_interval: 500ms'), 1);
  assert.equal(scrapeSeconds('global: {}'), null);
  assert.equal(scrapeSeconds(undefined), null);
});

test('fetchDetail: the last minute, one point per scrape, ending on a multiple of the step', async () => {
  const ranges = [];
  const queries = [];
  const fetchFn = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/status/config')) return { status: 200, json: async () => ({ status: 'success', data: { yaml: 'global:\n  scrape_interval: 10s\n' } }) };
    (u.pathname.endsWith('/query_range') ? ranges : queries).push(Object.fromEntries(u.searchParams));
    return { status: 200, json: async () => ({ status: 'success', data: { result: [] } }) };
  };
  const at = new Date(2026, 10, 9, 12, 0, 7);
  const out = await fetchDetail('http://mon-c.example:9090', { fetchFn, step: 5, now: () => +at });
  const end = Math.floor(+at / 1000 / 10) * 10;
  assert.equal(out.step, 10);
  assert.equal(out.end, end);
  assert.ok(ranges.length > 0);
  for (const r of ranges) assert.deepEqual([Number(r.start), Number(r.end), r.step], [end - 60, end, '10']);
  // A rate looks back four scrapes, so a point is never empty for want of samples.
  assert.ok(ranges.some((r) => r.query.includes('[40s]')));
  assert.ok(queries.some((q) => q.query.includes('[40s]')));
  assert.ok(![...ranges, ...queries].some((q) => q.query.includes('[2m]')));
});

test('fetchDetail: without an answer about the scrape interval, the setting is the step (5 seconds when none)', async () => {
  const steps = [];
  const fetchFn = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/status/config')) return { status: 403, json: async () => ({ status: 'error', error: 'forbidden' }) };
    if (u.pathname.endsWith('/query_range')) steps.push(u.searchParams.get('step'));
    return { status: 200, json: async () => ({ status: 'success', data: { result: [] } }) };
  };
  const now = () => +new Date(2026, 10, 9, 12);
  await fetchDetail('http://mon-d.example:9090', { fetchFn, step: 3, now });
  assert.ok(steps.length && steps.every((x) => x === '3'));
  steps.length = 0;
  await fetchDetail('http://mon-e.example:9090', { fetchFn, now });
  assert.ok(steps.length && steps.every((x) => x === '5'));
});
