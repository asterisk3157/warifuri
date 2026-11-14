// Tests for 下調べ (prep): what an AI found out ahead of the person, written back to a task
// (src/ledger/ledger.mjs writePrep, preps, prepCandidates), the tools prep and prep_candidates,
// a guest's limits on them (src/server/scope.mjs), and where it shows: get, start, the Web
// screen's tasks and activity.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openLedger, LedgerError } from '../src/ledger/ledger.mjs';
import { MIGRATIONS, SCHEMA_VERSION } from '../src/ledger/schema.mjs';
import { createServer } from '../src/server/mcp.mjs';

const ACTOR = { actor: 'human' };
const W = { actor: 'cli' };
const AGENT = { actor: 'agent', device: 'laptop' };
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warifuri-prep-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

// A clock at noon of a fixed day that moves 1 ms on every read; later() moves it on by days.
function clock() {
  let at = new Date(2026, 10, 16, 12).getTime();
  const now = () => new Date((at += 1));
  now.later = (days) => {
    at += days * 24 * 60 * 60 * 1000;
  };
  return now;
}

const FULL = {
  summary: 'ライブラリを3つ比べた。A が速い',
  artifacts: [{ label: '比べた表', url: 'https://example.com/compare' }, { url: 'notes/compare.md' }],
  unknowns: ['ライセンスの条件'],
  next: 'A で試作する',
};

test('ledger: writePrep adds a 下調べ to an open task, keeps the task as it was, and records it', () => {
  const now = clock();
  const L = openLedger(':memory:', { now });
  L.issueKey('laptop', W);
  const task = L.createTask({ title: 'ライブラリを選ぶ', mode: 'ai_worker' }, ACTOR);
  const before = L.get(task.id);
  const prep = L.writePrep(task.id, { ...FULL, summary: `  ${FULL.summary}\r\n` }, AGENT);
  assert.deepEqual(
    { ...prep, id: undefined, created_at: undefined },
    {
      id: undefined, task_id: task.id, device: 'laptop', actor: 'agent', summary: FULL.summary,
      artifacts: [{ label: '比べた表', url: 'https://example.com/compare' }, { label: null, url: 'notes/compare.md' }],
      unknowns: ['ライセンスの条件'], next: 'A で試作する', created_at: undefined,
    },
  );
  const got = L.get(task.id);
  assert.equal(got.state, 'ready');
  assert.equal(got.updated_at, before.updated_at);
  assert.deepEqual(got.preps.map((p) => p.id), [prep.id]);
  const rec = got.records.at(-1);
  assert.deepEqual([rec.action, rec.device, rec.changes.prep.summary, rec.changes.prep.unknowns], ['prep', 'laptop', FULL.summary, ['ライセンスの条件']]);

  // Newest first; summary alone is enough.
  const second = L.writePrep(task.id, { summary: '続きを調べた' }, AGENT);
  assert.deepEqual(L.preps(task.id).map((p) => p.id), [second.id, prep.id]);
  assert.deepEqual([second.artifacts, second.unknowns, second.next], [[], [], null]);

  // activity counts it, with its summary.
  const moved = L.activity();
  assert.equal(moved.counts.prepped, 2);
  assert.equal(moved.items.find((i) => i.kind === 'prepped').summary, '続きを調べた');
  L.close();
});

test('ledger: writePrep refuses a closed task, a missing one and a bad shape', () => {
  const L = openLedger(':memory:', { now: clock() });
  const task = L.createTask({ title: 'x', mode: 'ai_worker' }, ACTOR);
  const closed = L.createTask({ title: 'y', mode: 'ai_worker' }, ACTOR);
  L.setState(closed.id, 'done', { result: 'ok' }, ACTOR);
  assert.throws(() => L.writePrep(closed.id, { summary: 'a' }, ACTOR), /閉じています/);
  const dropped = L.createTask({ title: 'z', mode: 'ai_worker' }, ACTOR);
  L.setState(dropped.id, 'discarded', { reason: 'no' }, ACTOR);
  assert.throws(() => L.writePrep(dropped.id, { summary: 'a' }, ACTOR), /閉じています/);
  assert.throws(() => L.writePrep('t_20261116000000_nonexi', { summary: 'a' }, ACTOR), /ありません/);
  const bad = (fields) => {
    try {
      L.writePrep(task.id, fields, ACTOR);
    } catch (err) {
      assert.ok(err instanceof LedgerError);
      return err.problems.join('\n');
    }
    return assert.fail('not refused');
  };
  assert.match(bad({ summary: ' ' }), /要約\(summary\)が要ります/);
  assert.match(bad({ summary: 'a', artifacts: [{ label: 'no url' }] }), /url は/);
  assert.match(bad({ summary: 'a', artifacts: [{ url: 'x', size: 1 }] }), /知らない項目/);
  assert.match(bad({ summary: 'a', artifacts: 'x' }), /\{ label, url \} の一覧/);
  assert.match(bad({ summary: 'a', unknowns: ['two\nlines'] }), /1件を1行/);
  assert.match(bad({ summary: 'a', next: 'a\nb' }), /続きの提案/);
  assert.match(bad({ summary: 'a', state: 'done' }), /state はここでは書けません/);
  assert.deepEqual(L.preps(task.id), []);
  assert.equal(L.get(task.id).state, 'ready');
  L.close();
});

test('ledger: prepCandidates lists open, unstarted tasks to look into, holding-up first, then due; recent ones last', () => {
  const now = clock();
  const L = openLedger(':memory:', { now });
  L.issueKey('laptop', W);
  const goal = L.createGoal({ title: '作品', mode: 'human_with_ai', outcome: '飾れる', due: '2026-12-31', profile: '趣味' }, ACTOR);
  const late = L.createTask({ title: '期限の遠い AI の仕事', mode: 'ai_worker', due: '2026-12-20' }, ACTOR);
  const soon = L.createTask({ title: '期限の近い AI の仕事', mode: 'human_with_ai', due: '2026-11-20', done_when: 'x' }, ACTOR);
  const words = L.createTask({ title: '部品を比較する', mode: 'human', done_when: 'x', goal_id: goal.id }, ACTOR);
  const after1 = L.createTask({ title: '組み立てる', mode: 'human', done_when: 'x', goal_id: goal.id, after: [words.id] }, ACTOR);
  L.createTask({ title: '塗る', mode: 'human', done_when: 'x', goal_id: goal.id, after: [after1.id] }, ACTOR);
  L.link(words.id, late.id, ACTOR);
  const plain = L.createTask({ title: '電話する', mode: 'human', done_when: 'x' }, ACTOR);
  const held = L.createTask({ title: '着手済みの AI の仕事', mode: 'ai_worker' }, ACTOR);
  L.start(held.id, { device: 'laptop' }, AGENT);
  const waiting = L.createTask({ title: '待っている AI の仕事', mode: 'ai_worker' }, ACTOR);
  L.setState(waiting.id, 'waiting', { waiting_on: 'だれか', waiting_for: '返事' }, ACTOR);
  const done = L.createTask({ title: '終わった AI の仕事', mode: 'ai_worker' }, ACTOR);
  L.setState(done.id, 'done', { result: 'ok' }, ACTOR);

  const ids = (out) => out.candidates.map((c) => c.id);
  const out = L.prepCandidates();
  // words holds up two open tasks (組み立てる, 期限の遠い), the rest none: by due, no due last.
  assert.deepEqual(ids(out), [words.id, soon.id, late.id, waiting.id]);
  assert.ok(!ids(out).includes(plain.id) && !ids(out).includes(held.id) && !ids(out).includes(done.id));
  const first = out.candidates[0];
  assert.deepEqual(
    [first.blocks, first.why, first.goal, first.profile, first.preps, first.last_prep_at, first.recent_prep],
    [2, 'words', { id: goal.id, title: '作品' }, '趣味', 0, null, false],
  );
  assert.equal(out.candidates[1].why, 'mode');

  // A 下調べ in the last 3 days sends it to the end, marked; after that it comes back.
  const p = L.writePrep(words.id, { summary: '調べた' }, AGENT);
  const marked = L.prepCandidates();
  assert.deepEqual(ids(marked), [soon.id, late.id, waiting.id, words.id]);
  assert.deepEqual([marked.candidates[3].recent_prep, marked.candidates[3].preps, marked.candidates[3].last_prep_at], [true, 1, p.created_at]);
  now.later(4);
  assert.deepEqual(ids(L.prepCandidates()), [words.id, soon.id, late.id, waiting.id]);
  assert.equal(L.prepCandidates({ recentDays: 7 }).candidates.at(-1).id, words.id);

  assert.deepEqual(ids(L.prepCandidates({ profile: '趣味' })), [words.id]);
  const cut = L.prepCandidates({ limit: 2 });
  assert.deepEqual([cut.candidates.length, cut.more], [2, 2]);
  assert.deepEqual(ids(L.prepCandidates({ keep: (t) => t.id !== soon.id })), [words.id, late.id, waiting.id]);
  assert.throws(() => L.prepCandidates({ limit: 0 }), /limit/);
  L.close();
});

test('ledger: a snapshot that drops a task drops its 下調べ; the records keep them', () => {
  const L = openLedger(':memory:', { now: clock() });
  const T1 = 't_20261002090000_keep01';
  const T2 = 't_20261002090000_gone01';
  const doc = (tasks) => ({ format: 'warifuri-snapshot', version: 1, source: 'tracker', places: [], goals: [], blocks: [], tasks });
  const both = [{ id: T1, title: 'Keep', mode: 'ai_worker', state: 'ready' }, { id: T2, title: 'Gone', mode: 'ai_worker', state: 'ready' }];
  L.replaceFromSnapshot(doc(both), ACTOR);
  L.writePrep(T1, { summary: 'keep' }, ACTOR);
  L.writePrep(T2, { summary: 'gone' }, ACTOR);
  assert.equal(L.replaceFromSnapshot(doc(both), ACTOR).counts.tasks, 2);
  assert.equal(L.preps(T2).length, 1);
  L.replaceFromSnapshot(doc([both[0]]), ACTOR);
  assert.deepEqual(L.preps(T1).map((p) => p.summary), ['keep']);
  assert.deepEqual(L.preps(T2), []);
  assert.equal(L.records(T2).find((r) => r.action === 'prep').changes.prep.summary, 'gone');
  assert.equal(L.records('tracker').at(-1).changes.dropped_preps, 1);
  L.close();
});

test('schema: a version 19 file gains preps, empty, and its tasks take one', () => {
  const file = path.join(tmpRoot, 'v19.sqlite');
  const raw = new DatabaseSync(file);
  raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const m of MIGRATIONS.slice(0, 19)) raw.exec(m);
  raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '19')").run();
  raw.prepare("INSERT INTO tasks (id, title, state, mode, created_at, updated_at) VALUES ('t_20261001000000_aaaaaa', 'Old task', 'ready', 'ai_worker', 'x', 'x')").run();
  raw.close();

  assert.equal(SCHEMA_VERSION, 20);
  const L = openLedger(file);
  assert.deepEqual(L.get('t_20261001000000_aaaaaa').preps, []);
  assert.equal(L.writePrep('t_20261001000000_aaaaaa', { summary: 'a' }, ACTOR).summary, 'a');
  L.close();
  const check = new DatabaseSync(file);
  assert.equal(check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '20');
  assert.throws(() => check.exec("INSERT INTO preps (task_id, actor, summary, created_at) VALUES ('t_none', 'x', 'a', 'x')"), /FOREIGN KEY/);
  check.close();
});

// A server with an agent's key, a guest's key (仕事 fully hidden, 研究 with only its people
// hidden, サークル not shown), and tasks of each profile.
async function serve(t, { scope = { profiles: ['仕事', '趣味', '研究'], hide: { 仕事: ['people', 'knowledge', 'details'], 研究: ['people'] } } } = {}) {
  const now = clock();
  const ledger = openLedger(':memory:', { now });
  const home = path.join(tmpRoot, `home-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(home, { recursive: true });
  const keys = { laptop: ledger.issueKey('laptop', W).key };
  ledger.addDevice('muse', W);
  ledger.setDeviceScope('muse', scope, W);
  keys.muse = ledger.issueKey('muse', W).key;
  const goal = (profile) => ledger.createGoal({ title: `${profile}のゴール`, mode: 'ai_worker', profile }, ACTOR).id;
  const task = (title, goalId, extra = {}) => ledger.createTask({ title, mode: 'ai_worker', goal_id: goalId, body: `${title}の説明`, ...extra }, ACTOR).id;
  const ids = {
    work: task('見積もりを調べる', goal('仕事')),
    hobby: task('塗料を比べる', goal('趣味')),
    research: task('論文を探す', goal('研究')),
    club: task('会場を調べる', goal('サークル')),
    loose: task('どこにも入らない調べもの'),
  };
  const office = ledger.createPlace({ name: 'office', profile: '仕事', paths: [{ device: 'laptop', path: '/home/alex/office' }] }, ACTOR);
  const hobbyPlace = ledger.createPlace({ name: 'hobby', profile: '趣味', paths: [{ device: 'laptop', path: '/home/alex/hobby' }] }, ACTOR);
  const server = createServer({ ledger, home, secretary: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const clients = [];
  t.after(async () => {
    for (const c of clients) await c.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    ledger.close();
  });
  async function connect(name) {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${keys[name]}` } } }));
    clients.push(client);
    return client;
  }
  return { ledger, base, connect, ids, places: { office: office.id, hobby: hobbyPlace.id } };
}

const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { res, data: res.isError ? null : res.structuredContent, text: res.content[0]?.text ?? '' };
};

test('tools: an agent writes a 下調べ with prep; get lists them and start shows the newest', async (t) => {
  const { ledger, connect, ids, places } = await serve(t);
  const laptop = await connect('laptop');
  const { data: first } = await call(laptop, 'prep', { task_id: ids.hobby, summary: '水性と油性を比べた' });
  assert.equal(first.device, 'laptop');
  const { data: second } = await call(laptop, 'prep', { task_id: ids.hobby, ...FULL });
  assert.deepEqual(second.artifacts, [{ label: '比べた表', url: 'https://example.com/compare' }, { label: null, url: 'notes/compare.md' }]);
  assert.equal(ledger.get(ids.hobby).state, 'ready');

  const { data: got } = await call(laptop, 'get', { id: ids.hobby });
  assert.deepEqual(got.preps.map((p) => p.summary), [FULL.summary, '水性と油性を比べた']);

  const { data: started } = await call(laptop, 'start', { task_id: ids.hobby, place: places.hobby });
  assert.equal(started.state, 'running');
  assert.match(started.prep.notice, /下調べがあります\(2件\)/);
  assert.equal(started.prep.count, 2);
  assert.deepEqual(started.prep.latest, { by: 'laptop', at: second.created_at, summary: FULL.summary, artifacts: second.artifacts, unknowns: FULL.unknowns, next: FULL.next });
  // A task with no 下調べ starts as before.
  await call(laptop, 'release', { task_id: ids.hobby, next: '続き' });
  const { data: plain } = await call(laptop, 'start', { task_id: ids.work, place: places.office });
  assert.equal('prep' in plain, false);

  // Refused: a closed task, a bad shape.
  ledger.setState(ids.loose, 'done', { result: 'ok' }, ACTOR);
  assert.match((await call(laptop, 'prep', { task_id: ids.loose, summary: 'x' })).text, /閉じています/);
  assert.match((await call(laptop, 'prep', { task_id: ids.research, summary: '' })).text, /要約/);

  // 仕事 is held, the loose one closed; 塗料 was just prepped, so it comes last, marked.
  const { data: list } = await call(laptop, 'prep_candidates', {});
  assert.deepEqual(list.candidates.map((c) => [c.title, c.recent_prep]), [['論文を探す', false], ['会場を調べる', false], ['塗料を比べる', true]]);
  const { data: byPlace } = await call(laptop, 'prep_candidates', { place: '/home/alex/office' });
  assert.deepEqual(byPlace.candidates, []);
});

test('tools: a guest writes 下調べ only where it sees the details, and is offered only those tasks', async (t) => {
  const { ledger, connect, ids } = await serve(t);
  const muse = await connect('muse');
  const names = (await muse.listTools()).tools.map((x) => x.name);
  assert.ok(names.includes('prep') && names.includes('prep_candidates'));

  // 仕事 hides its details: refused, and nothing is written.
  assert.match((await call(muse, 'prep', { task_id: ids.work, summary: '調べた' })).text, /仕事 のタスクには、この鍵からは下調べを書けません/);
  assert.deepEqual(ledger.preps(ids.work), []);
  // サークル is not shown: as if the task were not there.
  assert.match((await call(muse, 'prep', { task_id: ids.club, summary: '調べた' })).text, /というタスクはありません/);
  assert.match((await call(muse, 'prep', { task_id: 't_20261116000000_nonexi', summary: '調べた' })).text, /というタスクはありません/);
  assert.deepEqual(ledger.preps(ids.club), []);
  // 趣味, 研究 (only its people hidden) and a task with no profile take one.
  for (const id of [ids.hobby, ids.research, ids.loose]) {
    const out = await call(muse, 'prep', { task_id: id, ...FULL });
    assert.equal(out.data.device, 'muse', id);
  }

  // prep_candidates leaves out 仕事 (details hidden) and サークル (not shown).
  ledger.writePrep(ids.hobby, { summary: 'x' }, ACTOR);
  const { data } = await call(muse, 'prep_candidates', {});
  const titles = data.candidates.map((c) => c.title);
  assert.ok(!titles.includes('見積もりを調べる') && !titles.includes('会場を調べる'));
  assert.deepEqual(titles.sort(), ['塗料を比べる', '論文を探す', 'どこにも入らない調べもの'].sort());
  assert.ok(!JSON.stringify(data).includes('見積もりを調べるの説明'));
  assert.match((await call(muse, 'prep_candidates', { place: '/home/alex/office' })).text, /place を使えません/);
  assert.match((await call(muse, 'prep_candidates', { profile: 'サークル' })).text, /見せていません/);
  assert.deepEqual((await call(muse, 'prep_candidates', { profile: '仕事' })).data.candidates, []);

  // get shows its 下調べ where it sees the details; a hidden task's get has none.
  assert.equal((await call(muse, 'get', { id: ids.hobby })).data.preps.length, 2);
  ledger.writePrep(ids.work, { summary: 'secret-prep' }, ACTOR);
  const hidden = await call(muse, 'get', { id: ids.work });
  assert.equal('preps' in hidden.data, false);
  assert.ok(!hidden.text.includes('secret-prep'));
});

test('tools: a guest whose write leaves out prep has neither prep nor its writes', async (t) => {
  const { connect, ids } = await serve(t, { scope: { write: ['note'] } });
  const muse = await connect('muse');
  const names = (await muse.listTools()).tools.map((x) => x.name);
  assert.ok(!names.includes('prep'));
  assert.ok(names.includes('prep_candidates'));
  assert.equal((await muse.callTool({ name: 'prep', arguments: { task_id: ids.hobby, summary: 'x' } })).isError, true);
});

test('web: the tasks endpoint carries each task\'s 下調べ, newest first', async (t) => {
  const { ledger, base, ids } = await serve(t);
  ledger.writePrep(ids.hobby, { summary: '古い' }, { actor: 'device-key', device: 'muse' });
  ledger.writePrep(ids.hobby, FULL, { actor: 'device-key', device: 'muse' });
  const tasks = await (await fetch(`${base}/web/api/tasks`)).json();
  const hobby = tasks.goals.flatMap((g) => g.tasks).find((x) => x.id === ids.hobby);
  assert.deepEqual(hobby.preps.map((p) => [p.by, p.summary]), [['muse', FULL.summary], ['muse', '古い']]);
  assert.deepEqual(hobby.preps[0].artifacts, [{ label: '比べた表', url: 'https://example.com/compare' }, { label: null, url: 'notes/compare.md' }]);
  assert.deepEqual(hobby.preps[0].unknowns, FULL.unknowns);
  const research = tasks.goals.flatMap((g) => g.tasks).find((x) => x.id === ids.research);
  assert.deepEqual(research.preps, []);
});
