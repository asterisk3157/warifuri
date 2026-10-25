// End-to-end tests for the write tools of the MCP endpoint (src/server/mcp.mjs) and for the
// HTTP API under /api: each tool's usual path, the refusals the ledger's rules give (as tool
// errors in Japanese), the device always taken from the key, and /api's keys and answers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openLedger } from '../src/ledger/ledger.mjs';
import { createServer } from '../src/server/mcp.mjs';

const ACTOR = { actor: 'human' };

// A ledger with a place inside another on the laptop, and keys for the laptop, the desk and
// a revoked device. apiLimit goes to the server.
async function start(t, { apiLimit } = {}) {
  let tick = 0;
  const ledger = openLedger(':memory:', { now: () => new Date(Date.now() + (tick += 1)) });
  const repo = ledger.createPlace({ name: 'repo', profile: 'hobby', paths: [{ device: 'laptop', path: '/home/alex/repo' }] }, ACTOR);
  const docs = ledger.createPlace({ name: 'repo docs', profile: 'hobby', paths: [{ device: 'laptop', path: '/home/alex/repo/docs' }] }, ACTOR);
  const keys = {
    laptop: ledger.issueKey('laptop', ACTOR).key,
    desk: ledger.issueKey('desk', ACTOR).key,
    revoked: ledger.issueKey('lost', ACTOR).key,
  };
  ledger.revokeKey('lost', ACTOR);

  const server = createServer({ ledger, ...(apiLimit ? { apiLimit } : {}) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const clients = [];
  t.after(async () => {
    for (const c of clients) await c.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    ledger.close();
  });

  async function connect(key) {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
    clients.push(client);
    return client;
  }
  return { base, ledger, keys, connect, places: { repo, docs } };
}

const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { res, data: res.isError ? null : JSON.parse(res.content[0].text), text: res.content[0].text };
};

// A call the ledger refuses: a tool error whose text lists the problems.
async function refused(client, name, args, pattern) {
  const { res, text } = await call(client, name, args);
  assert.equal(res.isError, true, `${name} should be refused`);
  assert.match(text, /^書けませんでした。/);
  if (pattern) assert.match(text, pattern);
  return text;
}

const task = async (client, title, extra = {}) => (await call(client, 'create_task', { title, mode: 'ai_worker', ...extra })).data;

test('create_goal, create_task, update, link and unlink write as the calling device', async (t) => {
  const { ledger, keys, connect } = await start(t);
  const laptop = await connect(keys.laptop);
  const { data: goal } = await call(laptop, 'create_goal', {
    title: 'Ship v1', mode: 'human_with_ai', outcome: 'v1 is public', due: '2026-12-01', human_led: true, profile: 'hobby',
  });
  assert.equal(goal.state, 'ready');
  assert.equal(goal.human_led, true);
  const a = await task(laptop, 'Write docs', { goal_id: goal.id, load: 'light', body: 'background' });
  const b = await task(laptop, 'Release', { goal_id: goal.id });
  assert.equal(a.goal_id, goal.id);
  const rec = ledger.records(a.id)[0];
  assert.deepEqual([rec.action, rec.actor, rec.device], ['create', 'device-key', 'laptop']);

  const { data: changed } = await call(laptop, 'update', { id: a.id, title: 'Write the docs', body: null, estimate_min: 30 });
  assert.equal(changed.title, 'Write the docs');
  assert.equal(changed.body, null);
  assert.equal(changed.estimate_min, 30);
  assert.equal(ledger.records(a.id).at(-1).action, 'update');

  const { data: edge } = await call(laptop, 'link', { before_id: a.id, after_id: b.id });
  assert.deepEqual(edge, { before_id: a.id, after_id: b.id });
  await refused(laptop, 'link', { before_id: b.id, after_id: a.id }, /輪になります/);
  await call(laptop, 'unlink', { before_id: a.id, after_id: b.id });
  assert.deepEqual(ledger.get(b.id).blocked_by, []);
  await refused(laptop, 'unlink', { before_id: a.id, after_id: b.id }, /順序はありません/);
});

test('the rules come back as tool errors listing every problem in Japanese', async (t) => {
  const { ledger, keys, connect } = await start(t);
  const laptop = await connect(keys.laptop);
  const text = await refused(laptop, 'create_goal', { title: 'Learn piano', mode: 'human' });
  assert.match(text, /- 人の時間を使うゴールには期日が要ります/);
  assert.match(text, /- 人の時間を使うゴールには、あるべき姿/);
  await refused(laptop, 'create_goal', { title: 'Learn piano', mode: 'human', outcome: 'a song', due: '2026-12-01', due_provisional: true }, /仮の期日/);
  await refused(laptop, 'create_task', { title: 'Practise', mode: 'human' }, /完了の条件\(done_when\)/);
  await refused(laptop, 'create_task', { title: 'No mode' }, /mode/);
  const a = await task(laptop, 'A');
  await refused(laptop, 'update', { id: a.id, outcome: 'goals only' }, /outcome はここでは書けません/);
  await refused(laptop, 'update', { id: 'g_00000000000000_nobody', title: 'x' }, /ありません/);
  assert.equal(ledger.search('Learn piano').length, 0);
});

test('start takes the device from the key, never from the arguments, and the place from a directory or an id', async (t) => {
  const { ledger, keys, connect, places } = await start(t);
  const laptop = await connect(keys.laptop);
  const a = await task(laptop, 'A');
  // The deepest place containing the directory wins; a device argument is ignored.
  const { data: held } = await call(laptop, 'start', { task_id: a.id, place: '/home/alex/repo/docs/guide', device: 'desk' });
  assert.equal(held.state, 'running');
  assert.equal(held.hold.device, 'laptop');
  assert.equal(held.hold.place_id, places.docs.id);
  const rec = ledger.records(a.id).at(-1);
  assert.deepEqual([rec.action, rec.actor, rec.device], ['start', 'device-key', 'laptop']);

  // By id, in the outer place.
  const b = await task(laptop, 'B');
  const { data: byId } = await call(laptop, 'start', { task_id: b.id, place: places.repo.id });
  assert.equal(byId.hold.place_id, places.repo.id);
  assert.equal(byId.moved_from, undefined);
});

test('start refuses a second task in the same place and returns the one held there', async (t) => {
  const { keys, connect } = await start(t);
  const laptop = await connect(keys.laptop);
  const a = await task(laptop, 'A');
  const b = await task(laptop, 'B');
  await call(laptop, 'start', { task_id: a.id, place: '/home/alex/repo' });
  const text = await refused(laptop, 'start', { task_id: b.id, place: '/home/alex/repo/src' }, /もうタスク .* に着手しています/);
  const held = JSON.parse(text.slice(text.indexOf('{'))).held;
  assert.equal(held.id, a.id);
  assert.equal(held.hold.device, 'laptop');
});

test('start moves a task held elsewhere, and says so in the answer and the record', async (t) => {
  const { ledger, keys, connect, places } = await start(t);
  const laptop = await connect(keys.laptop);
  const desk = await connect(keys.desk);
  const a = await task(laptop, 'A');
  await call(laptop, 'start', { task_id: a.id, place: '/home/alex/repo' });
  // The desk has no path for the repo, so it names the place by id.
  const { data: moved } = await call(desk, 'start', { task_id: a.id, place: places.repo.id });
  assert.equal(moved.hold.device, 'desk');
  assert.equal(moved.moved_from.device, 'laptop');
  const rec = ledger.records(a.id).at(-1);
  assert.deepEqual([rec.action, rec.device], ['move', 'desk']);
  assert.deepEqual(rec.changes.from, { device: 'laptop', place_id: places.repo.id });
});

test('start with a directory in no place, or a place that does not exist, says what to do', async (t) => {
  const { keys, connect } = await start(t);
  const laptop = await connect(keys.laptop);
  const desk = await connect(keys.desk);
  const a = await task(laptop, 'A');
  await refused(laptop, 'start', { task_id: a.id, place: '/home/alex/elsewhere' }, /どの作業フォルダにも入っていません。place で作業フォルダを登録/);
  // The laptop's path means nothing on the desk.
  await refused(desk, 'start', { task_id: a.id, place: '/home/alex/repo' }, /デバイス desk のどの作業フォルダにも/);
  await refused(laptop, 'start', { task_id: a.id, place: 'p_00000000000000_nobody' }, /作業フォルダ p_00000000000000_nobody がありません/);
  await refused(laptop, 'start', { task_id: a.id, place: 'repo' }, /id か、絶対パス/);
});

test('release needs a one-line next; the task goes back to ready', async (t) => {
  const { ledger, keys, connect } = await start(t);
  const laptop = await connect(keys.laptop);
  const a = await task(laptop, 'A');
  await call(laptop, 'start', { task_id: a.id, place: '/home/alex/repo' });
  await refused(laptop, 'release', { task_id: a.id, next: '  ' }, /next を1行/);
  await refused(laptop, 'release', { task_id: a.id, next: 'one\ntwo' }, /1行で/);
  const { data: released } = await call(laptop, 'release', { task_id: a.id, next: 'Rerun the failing test first' });
  assert.equal(released.state, 'ready');
  assert.equal(released.next, 'Rerun the failing test first');
  assert.equal(released.hold, null);
  assert.equal(ledger.records(a.id).at(-1).action, 'release');
  await refused(laptop, 'release', { task_id: a.id, next: 'again' }, /作業中ではありません/);
});

test('close needs a result or a reason, keeps what was learned in the record, and reopen brings it back', async (t) => {
  const { ledger, keys, connect } = await start(t);
  const laptop = await connect(keys.laptop);
  const a = await task(laptop, 'A');
  await call(laptop, 'start', { task_id: a.id, place: '/home/alex/repo' });
  await refused(laptop, 'close', { id: a.id, state: 'done' }, /完了には1行の成果\(result\)/);
  await refused(laptop, 'close', { id: a.id, state: 'discarded' }, /破棄には理由\(reason\)/);
  await refused(laptop, 'close', { id: a.id, state: 'done', reason: 'wrong field' }, /reason は状態 done では使いません/);
  await refused(laptop, 'close', { id: a.id, state: 'done', result: 'ok', learned: ' ' }, /learned/);

  const { data: done } = await call(laptop, 'close', { id: a.id, state: 'done', result: 'Docs merged', learned: 'The linter wants ASCII quotes' });
  assert.equal(done.state, 'done');
  assert.equal(done.result, 'Docs merged');
  assert.equal(done.hold, null);
  const rec = ledger.records(a.id).at(-1);
  assert.equal(rec.device, 'laptop');
  assert.deepEqual(rec.changes.learned, { before: null, after: 'The linter wants ASCII quotes' });
  assert.deepEqual(rec.changes.state, { before: 'running', after: 'done' });

  const { data: back } = await call(laptop, 'reopen', { id: a.id });
  assert.equal(back.state, 'ready');
  assert.equal(back.result, null);
  await refused(laptop, 'reopen', { id: a.id }, /閉じていません/);
  const { data: dropped } = await call(laptop, 'close', { id: a.id, state: 'discarded', reason: 'Not needed after all' });
  assert.equal(dropped.reason, 'Not needed after all');
});

test('defer needs defer_until; wait needs who and what', async (t) => {
  const { keys, connect } = await start(t);
  const laptop = await connect(keys.laptop);
  const a = await task(laptop, 'A');
  const b = await task(laptop, 'B');
  await call(laptop, 'start', { task_id: a.id, place: '/home/alex/repo' });
  await refused(laptop, 'defer', { id: a.id }, /いつまでか\(defer_until\)/);
  await refused(laptop, 'defer', { id: a.id, defer_until: 'next week' }, /defer_until は YYYY-MM-DD/);
  const { data: deferred } = await call(laptop, 'defer', { id: a.id, defer_until: '2026-11-15', next: 'Pick it up after the trip' });
  assert.equal(deferred.state, 'deferred');
  assert.equal(deferred.hold, null);
  assert.equal(deferred.next, 'Pick it up after the trip');

  await refused(laptop, 'wait', { id: b.id, waiting_for: 'a review' }, /だれを待つか\(waiting_on\)/);
  await refused(laptop, 'wait', { id: b.id, waiting_on: 'supervisor' }, /何を待つか\(waiting_for\)/);
  const { data: waiting } = await call(laptop, 'wait', { id: b.id, waiting_on: 'supervisor', waiting_for: 'a review of chapter 2' });
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.waiting_on, 'supervisor');
});

test('place registers a place with the calling device\'s path, and changes it by id', async (t) => {
  const { ledger, keys, connect } = await start(t);
  const laptop = await connect(keys.laptop);
  const desk = await connect(keys.desk);
  const { data: made } = await call(laptop, 'place', { name: 'notes', profile: 'research', path: '/home/alex/notes', device: 'desk' });
  assert.deepEqual(made.paths, [{ device: 'laptop', path: '/home/alex/notes' }]);
  assert.equal(ledger.records(made.id)[0].device, 'laptop');

  // The desk adds its own path; the laptop's stays.
  const { data: both } = await call(desk, 'place', { id: made.id, path: 'C:\\Users\\alex\\notes' });
  assert.deepEqual(both.paths, [{ device: 'desk', path: 'C:\\Users\\alex\\notes' }, { device: 'laptop', path: '/home/alex/notes' }]);
  const { data: renamed } = await call(laptop, 'place', { id: made.id, name: 'research notes', path: null });
  assert.equal(renamed.name, 'research notes');
  assert.deepEqual(renamed.paths, [{ device: 'desk', path: 'C:\\Users\\alex\\notes' }]);

  await refused(laptop, 'place', { name: 'x', path: 'relative/dir' }, /絶対パス/);
  await refused(laptop, 'place', { name: 'clash', path: '/home/alex/repo' }, /もう作業フォルダ .* が使っています/);
  await refused(laptop, 'place', { id: 'p_00000000000000_nobody', name: 'x' }, /作業フォルダはありません/);
  await refused(laptop, 'place', { path: '/home/alex/unnamed' }, /名前が要ります/);
});

test('GET /api/held needs a machine key, and answers the task held in the place of dir', async (t) => {
  const { base, keys, connect, places } = await start(t);
  const held = (dir, key) => fetch(`${base}/api/held?${new URLSearchParams(dir === undefined ? {} : { dir })}`, key ? { headers: { Authorization: `Bearer ${key}` } } : {});

  for (const key of [undefined, 'wf_wrong', keys.revoked]) {
    const res = await held('/home/alex/repo', key);
    assert.equal(res.status, 401, String(key));
    assert.equal(res.headers.get('www-authenticate'), 'Bearer');
    assert.equal(typeof (await res.json()).error, 'string');
  }

  const none = await held('/home/alex/repo/src', keys.laptop);
  assert.equal(none.status, 200);
  assert.deepEqual(await none.json(), { task: null, place: { id: places.repo.id, name: 'repo', profile: 'hobby' } });

  const laptop = await connect(keys.laptop);
  const a = await task(laptop, 'A');
  await call(laptop, 'start', { task_id: a.id, place: '/home/alex/repo' });
  const some = await (await held('/home/alex/repo/src', keys.laptop)).json();
  assert.equal(some.task.id, a.id);
  assert.equal(some.task.hold.device, 'laptop');
  assert.equal(some.place.id, places.repo.id);
  // The inner place, another device, and a directory in no place hold nothing.
  assert.equal((await (await held('/home/alex/repo/docs', keys.laptop)).json()).task, null);
  assert.deepEqual(await (await held('/home/alex/repo/src', keys.desk)).json(), { task: null, place: null });
  assert.deepEqual(await (await held('/tmp', keys.laptop)).json(), { task: null, place: null });

  for (const dir of [undefined, '', 'relative/dir']) assert.equal((await held(dir, keys.laptop)).status, 400, String(dir));
  assert.equal((await fetch(`${base}/api/nothing`, { headers: { Authorization: `Bearer ${keys.laptop}` } })).status, 404);
});

test('/api is rate-limited per address', async (t) => {
  const { base, keys } = await start(t, { apiLimit: { max: 2, windowMs: 60_000 } });
  const get = () => fetch(`${base}/api/held?dir=/home/alex/repo`, { headers: { Authorization: `Bearer ${keys.laptop}` } });
  assert.equal((await get()).status, 200);
  assert.equal((await get()).status, 200);
  const limited = await get();
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('resume brings a deferred or waiting task back to ready, and refuses anything else', async (t) => {
  const { connect, keys } = await start(t);
  const laptop = await connect(keys.laptop);
  const { data: task } = await call(laptop, 'create_task', { title: 'Wait for the review', mode: 'ai_worker' });
  await call(laptop, 'wait', { id: task.id, waiting_on: 'reviewer', waiting_for: 'comments' });
  const { data: back } = await call(laptop, 'resume', { id: task.id });
  assert.deepEqual([back.state, back.waiting_on, back.waiting_for], ['ready', null, null]);
  await call(laptop, 'defer', { id: task.id, defer_until: '2026-12-01' });
  assert.equal((await call(laptop, 'resume', { id: task.id })).data.defer_until, null);
  await refused(laptop, 'resume', { id: task.id }, /先送りでも待ちでもありません/);
});

test('places lists every place with its paths, including places with no task, and filters by profile', async (t) => {
  const { connect, ledger, keys } = await start(t);
  ledger.createPlace({ name: 'lab', profile: 'research', paths: [{ device: 'desk', path: '/srv/lab' }] }, ACTOR);
  const laptop = await connect(keys.laptop);
  const { data } = await call(laptop, 'places');
  assert.deepEqual(data.places.map((p) => p.name), ['repo', 'repo docs', 'lab']);
  assert.deepEqual(data.places[2].paths, [{ device: 'desk', path: '/srv/lab' }]);
  const { data: only } = await call(laptop, 'places', { profile: 'research' });
  assert.deepEqual(only.places.map((p) => p.name), ['lab']);
});

test('habit makes, changes and stops a habit; a stopped habit stays with its records', async (t) => {
  const { ledger, keys, connect } = await start(t);
  const laptop = await connect(keys.laptop);
  const { data: goal } = await call(laptop, 'create_goal', { title: 'Keep fit', mode: 'ai_worker' });
  const { data: run } = await call(laptop, 'habit', {
    title: 'Run', rule: { days: ['金', '月', '水'], window: '07:00-07:30' }, duration_min: 30, goal_id: goal.id,
  });
  assert.deepEqual(run.rule, { days: ['月', '水', '金'], window: '07:00-07:30' });
  assert.equal(run.active, true);
  const rec = ledger.records(run.id)[0];
  assert.deepEqual([rec.action, rec.actor, rec.device], ['create', 'device-key', 'laptop']);

  await refused(laptop, 'habit', { title: 'Run' }, /rule/);
  await refused(laptop, 'habit', { title: 'Run', rule: { days: ['Mon'] }, duration_min: 30 }, /Mon は読めません/);
  await refused(laptop, 'habit', { title: 'Run', rule: { days: 'daily', every: 2 }, duration_min: 30 }, /every は書けません/);
  await refused(laptop, 'habit', { id: run.id, duration_min: 60 }, /収まりません/);
  await refused(laptop, 'habit', { id: 'h_20261025000000_nohabt', title: 'x' }, /習慣はありません/);
  await refused(laptop, 'habit', { id: goal.id, stop: true }, /習慣はありません/);
  await refused(laptop, 'habit', { stop: true }, /id を渡します/);
  await refused(laptop, 'habit', { id: run.id, stop: true, title: 'x' }, /stop と一緒には/);

  const { data: changed } = await call(laptop, 'habit', { id: run.id, rule: { days: 'weekdays' }, duration_min: 45, goal_id: null });
  assert.deepEqual(changed.rule, { days: 'weekdays' });
  assert.equal(changed.goal_id, null);
  assert.equal(changed.title, 'Run');

  const { data: stopped } = await call(laptop, 'habit', { id: run.id, stop: true });
  assert.equal(stopped.active, false);
  assert.equal(ledger.records(run.id).at(-1).action, 'stop');
  assert.equal(ledger.get(run.id).kind, 'habit');
  const { data: again } = await call(laptop, 'habit', { id: run.id, active: true });
  assert.equal(again.active, true);
});
