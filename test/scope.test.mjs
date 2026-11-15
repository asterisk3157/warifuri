// Tests for keys with a scope (src/ledger/scope.mjs, src/server/scope.mjs): a guest, such as an
// AI outside, sees the board, schedule and search of every profile, but of a hidden profile
// only the titles, due dates and states, and none of its people or knowledge; it writes only
// what its scope allows. Agents' and the secretary's keys work as before.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openLedger, LedgerError } from '../src/ledger/ledger.mjs';
import { createServer } from '../src/server/mcp.mjs';
import { profileDir } from '../src/knowledge/profiles.mjs';
import { normalizeScope } from '../src/ledger/scope.mjs';
import { requestBody } from '../src/secretary/chat.mjs';

const ACTOR = { actor: 'human' };
const W = { actor: 'cli' };
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warifuri-scope-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let n = 0;

// A clock at noon of a fixed day that moves 1 ms on every read, so rows keep their order.
const ticking = () => {
  let tick = 0;
  const base = new Date(2026, 10, 16, 12).getTime();
  return () => new Date(base + (tick += 1));
};

const GUEST = { hide: { 仕事: ['people', 'knowledge', 'details'] } };

async function start(t, { scope = GUEST, chat = null, secretaryDevice } = {}) {
  const home = path.join(tmpRoot, `home-${(n += 1)}`);
  for (const p of ['仕事', '趣味']) {
    const dir = profileDir(home, p);
    fs.mkdirSync(path.join(dir, 'procedures'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'knowledge.md'), `- ${p} のナレッジ ${p === '仕事' ? 'secret-know' : 'open-know'}\n`);
    fs.writeFileSync(path.join(dir, 'procedures', 'release.md'), `${p} の手順\n`);
  }
  const ledger = openLedger(':memory:', { now: ticking() });
  const keys = {
    laptop: ledger.issueKey('laptop', W).key,
    secretary: ledger.issueKey('secretary', W).key,
  };
  const work = ledger.createGoal({ title: '仕事のゴール', mode: 'ai_worker', outcome: 'secret-outcome', profile: '仕事', due: '2026-11-30' }, ACTOR);
  const workTask = ledger.createTask({ title: '見積もりを出す', mode: 'ai_worker', goal_id: work.id, body: 'secret-body', done_when: 'secret-done' }, ACTOR);
  ledger.update(workTask.id, { next: 'secret-next' }, ACTOR);
  const office = ledger.createPlace({ name: 'office', profile: '仕事', paths: [{ device: 'laptop', path: '/home/alex/office' }] }, ACTOR);
  const looseWork = ledger.createTask({ title: '経費の精算', mode: 'ai_worker', place_id: office.id, body: 'secret-loose' }, ACTOR);
  const hobby = ledger.createGoal({ title: '趣味のゴール', mode: 'ai_worker', outcome: 'open-outcome', profile: '趣味' }, ACTOR);
  const hobbyTask = ledger.createTask({ title: '模型を作る', mode: 'ai_worker', goal_id: hobby.id, body: 'open-body' }, ACTOR);
  const club = ledger.createGoal({ title: 'サークルのゴール', mode: 'ai_worker', profile: 'サークル' }, ACTOR);
  ledger.start(workTask.id, { device: 'laptop', placeId: office.id }, { actor: 'agent', device: 'laptop' });
  ledger.book({ kind: 'task', task_id: workTask.id, starts_at: '2026-11-16T01:00:00Z', ends_at: '2026-11-16T02:00:00Z', note: 'secret-note', location: 'secret-office' }, ACTOR);
  ledger.book({ kind: 'task', task_id: hobbyTask.id, starts_at: '2026-11-16T03:00:00Z', ends_at: '2026-11-16T04:00:00Z', location: '自宅' }, ACTOR);
  ledger.book({ kind: 'fixed', title: '歯医者', starts_at: '2026-11-16T05:00:00Z', ends_at: '2026-11-16T06:00:00Z', note: 'secret-fixed-note', organizer: 'someone@example.com' }, ACTOR);
  const boss = ledger.people.create({ name: '架空課長', role: 'secret-role' }, { profile: '仕事' }, ACTOR);
  ledger.people.learn({ profile: '仕事', text: '架空課長 は secret-memo', person: boss.id }, ACTOR);
  const friend = ledger.people.create({ name: '架空友人', role: '模型仲間' }, { profile: '趣味' }, ACTOR);
  ledger.people.learn({ profile: '趣味', text: '架空友人 は open-memo', person: friend.id }, ACTOR);
  ledger.addDevice('muse', W);
  if (scope) ledger.setDeviceScope('muse', scope, W);
  keys.muse = ledger.issueKey('muse', W).key;

  const server = createServer({ ledger, home, secretary: false, chat, ...(secretaryDevice === undefined ? {} : { secretaryDevice }) });
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
  const ids = { work: work.id, workTask: workTask.id, looseWork: looseWork.id, hobby: hobby.id, hobbyTask: hobbyTask.id, club: club.id, office: office.id, boss: boss.id, friend: friend.id };
  return { ledger, home, base, keys, connect, ids };
}

const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { res, data: res.isError ? null : res.structuredContent, text: res.content[0]?.text ?? '' };
};
const SECRETS = ['secret-outcome', 'secret-body', 'secret-done', 'secret-next', 'secret-loose', 'secret-note', 'secret-office', 'secret-fixed-note', 'someone@example.com', 'secret-know', 'secret-memo', 'secret-role', '/home/alex/office'];
const noSecret = (value, what) => {
  const text = JSON.stringify(value);
  for (const s of SECRETS) assert.ok(!text.includes(s), `${what} shows ${s}`);
};

test('scope: normalizeScope fills the guest defaults and refuses what it cannot be', () => {
  assert.deepEqual(normalizeScope({}).scope, { profiles: null, hide: {}, write: ['note', 'ask_secretary', 'prep'] });
  assert.deepEqual(normalizeScope({ profiles: ['趣味'], hide: { 仕事: ['details', 'people'] }, write: [] }).scope, {
    profiles: ['趣味'], hide: { 仕事: ['people', 'details'] }, write: [],
  });
  assert.match(normalizeScope({ write: ['create_task'] }).problems.join('\n'), /note, ask_secretary, prep だけ/);
  assert.match(normalizeScope({ hide: { 仕事: ['memos'] } }).problems.join('\n'), /知らないもの/);
  assert.match(normalizeScope({ hide: { 仕事: [] } }).problems.join('\n'), /1つ以上/);
  assert.match(normalizeScope({ other: 1 }).problems.join('\n'), /知らない項目/);
  const ledger = openLedger(':memory:', { now: ticking() });
  assert.throws(() => ledger.setDeviceScope('none', {}, W), LedgerError);
  ledger.addDevice('muse', W);
  assert.throws(() => ledger.setDeviceScope('muse', { write: ['book'] }, W), LedgerError);
  assert.equal(ledger.deviceScope('muse'), null);
  ledger.setDeviceScope('muse', GUEST, W);
  assert.deepEqual(ledger.listDevices().find((d) => d.name === 'muse').scope.hide, GUEST.hide);
  assert.deepEqual(ledger.records('muse').map((r) => r.action), ['create', 'scope']);
  ledger.setDeviceScope('muse', null, W);
  assert.equal(ledger.deviceScope('muse'), null);
  ledger.close();
});

test('scope: a guest lists only the read tools and the writes it may make', async (t) => {
  const { connect } = await start(t);
  const muse = await connect('muse');
  const names = (await muse.listTools()).tools.map((x) => x.name).sort();
  assert.deepEqual(names, ['ask_secretary', 'board', 'context', 'flow', 'free_time', 'get', 'note', 'people', 'prep', 'prep_candidates', 'schedule', 'search', 'timetable']);
});

test('scope: write [] leaves a read-only guest; profiles keeps out the others', async (t) => {
  const { connect, ids } = await start(t, { scope: { profiles: ['趣味'], write: [] } });
  const muse = await connect('muse');
  const names = (await muse.listTools()).tools.map((x) => x.name);
  assert.ok(!names.includes('note') && !names.includes('ask_secretary') && !names.includes('prep'));
  const { data: board } = await call(muse, 'board');
  assert.deepEqual(board.goals.map((g) => g.id), [ids.hobby]);
  assert.deepEqual(board.unassigned, []);
  assert.equal((await call(muse, 'get', { id: ids.work })).res.isError, true);
  assert.equal((await call(muse, 'get', { id: ids.club })).res.isError, true);
  assert.equal((await call(muse, 'flow', { goal_id: ids.work })).res.isError, true);
  assert.match((await call(muse, 'board', { profile: '仕事' })).text, /見せていません/);
  const { data: found } = await call(muse, 'search', { text: 'ゴール' });
  assert.deepEqual(found.results.map((r) => r.id), [ids.hobby]);
  const { data: day } = await call(muse, 'schedule', { from: '2026-11-16T00:00:00Z', to: '2026-11-17T00:00:00Z' });
  // The booking of a profile it does not see is gone; one with no profile stays.
  assert.deepEqual(day.bookings.map((b) => b.title).sort(), ['模型を作る', '歯医者'].sort());
});

test('scope: a hidden profile shows only titles, due dates and states, on the board, get, search and schedule', async (t) => {
  const { connect, ids } = await start(t);
  const muse = await connect('muse');

  const { data: board, text } = await call(muse, 'board');
  noSecret(board, 'board');
  noSecret(text, 'board text');
  const work = board.goals.find((g) => g.id === ids.work);
  assert.deepEqual([work.title, work.due, work.state, work.details_hidden], ['仕事のゴール', '2026-11-30', 'ready', true]);
  assert.equal('outcome' in work, false);
  assert.deepEqual(work.tasks.map((x) => [x.title, x.state, 'body' in x, 'hold' in x]), [['見積もりを出す', 'running', false, false]]);
  assert.deepEqual(board.unassigned.map((x) => [x.title, x.details_hidden]), [['経費の精算', true]]);
  // Other profiles are shown in full.
  const hobby = board.goals.find((g) => g.id === ids.hobby);
  assert.equal(hobby.outcome, 'open-outcome');
  assert.equal(hobby.tasks[0].body, 'open-body');
  assert.ok(board.goals.some((g) => g.id === ids.club));

  for (const id of [ids.work, ids.workTask, ids.looseWork]) {
    const { data } = await call(muse, 'get', { id });
    noSecret(data, `get ${id}`);
    assert.equal(data.details_hidden, true);
    assert.equal('records' in data, false);
  }
  assert.equal((await call(muse, 'get', { id: ids.hobbyTask })).data.body, 'open-body');
  // A place of a hidden profile answers as if it were not there.
  assert.match((await call(muse, 'get', { id: ids.office })).text, /ありません/);

  const { data: found } = await call(muse, 'search', { text: '見積もり' });
  assert.deepEqual(found.results.map((r) => r.title), ['見積もりを出す']);
  noSecret(found, 'search');

  const { data: flow } = await call(muse, 'flow', { goal_id: ids.work });
  assert.match(flow.mermaid, /見積もりを出す/);

  const { data: day } = await call(muse, 'schedule', { from: '2026-11-16T00:00:00Z', to: '2026-11-17T00:00:00Z' });
  noSecret(day, 'schedule');
  assert.deepEqual(day.bookings.map((b) => b.title), ['見積もりを出す', '模型を作る', '歯医者']);
  assert.equal(day.bookings[1].location, '自宅');
  assert.equal('location' in day.bookings[0], false);

  const { data: free } = await call(muse, 'free_time', { from: '2026-11-17', to: '2026-11-18' });
  assert.ok(Array.isArray(free.days));
  const { data: plan } = await call(muse, 'timetable', { from: '2026-11-17', to: '2026-11-18' });
  noSecret(plan, 'timetable');
});

test('scope: a hidden profile\'s people and knowledge are refused, by profile, by id and by query', async (t) => {
  const { connect, ids } = await start(t);
  const muse = await connect('muse');
  for (const args of [{ profile: '仕事' }, { profile: '仕事', id: ids.boss }, { profile: '仕事', query: '架空' }, { profile: '仕事', birthdays_within: 30 }]) {
    const out = await call(muse, 'people', args);
    assert.equal(out.res.isError, true, JSON.stringify(args));
    assert.match(out.text, /仕事 の人は、この鍵には見せていません/);
  }
  // Without a profile it does not see everyone, as the secretary would.
  assert.match((await call(muse, 'people')).text, /profile を渡します/);
  assert.match((await call(muse, 'people', { place: ids.office })).text, /place を使えません/);
  // A hidden person is not found through a profile it may see.
  assert.equal((await call(muse, 'people', { profile: '趣味', id: ids.boss })).res.isError, true);
  const { data: friends } = await call(muse, 'people', { profile: '趣味', query: '架空' });
  assert.deepEqual(friends.people.map((p) => p.name), ['架空友人']);
  noSecret(friends, 'people of 趣味');
  const { data: friend } = await call(muse, 'people', { profile: '趣味', id: ids.friend });
  assert.match(JSON.stringify(friend), /open-memo/);

  for (const args of [{ profile: '仕事' }, { profile: '仕事', name: 'procedures/release.md' }]) {
    assert.match((await call(muse, 'context', args)).text, /仕事 のナレッジは、この鍵には見せていません/);
  }
  const { data: hobby } = await call(muse, 'context', { profile: '趣味' });
  assert.match(hobby.knowledge.text, /open-know/);
  assert.deepEqual(hobby.people.people.map((p) => p.name), ['架空友人']);
  assert.equal((await call(muse, 'context', { profile: '趣味', name: 'procedures/release.md' })).data.text, '趣味 の手順\n');
});

test('scope: knowledge hidden alone keeps the people, and people hidden alone keeps them out of context', async (t) => {
  const { connect } = await start(t, { scope: { hide: { 仕事: ['people'] } } });
  const muse = await connect('muse');
  const { data } = await call(muse, 'context', { profile: '仕事' });
  assert.match(data.knowledge.text, /secret-know/);
  assert.equal(data.people, null);
  assert.equal(data.people_hidden, true);
  assert.equal((await call(muse, 'people', { profile: '仕事' })).res.isError, true);
});

test('scope: a guest writes notes only to a profile with nothing hidden, and nothing else', async (t) => {
  const { ledger, home, connect, ids } = await start(t);
  const muse = await connect('muse');
  for (const args of [
    { profile: '仕事', text: '仕事のこと', kind: 'agent' },
    { profile: '仕事', text: '架空課長 のこと', kind: 'agent', people: true },
  ]) {
    assert.match((await call(muse, 'note', args)).text, /仕事 には、この鍵からは書けません/);
  }
  assert.match((await call(muse, 'note', { place: ids.office, text: 'x', kind: 'agent' })).text, /place を使えません/);
  const { data } = await call(muse, 'note', { profile: '趣味', text: '模型の塗料は水性がよい', kind: 'agent' });
  assert.equal(data.profile, '趣味');
  assert.match(fs.readFileSync(path.join(profileDir(home, '趣味'), 'knowledge.md'), 'utf8'), /水性がよい/);
  assert.doesNotMatch(fs.readFileSync(path.join(profileDir(home, '仕事'), 'knowledge.md'), 'utf8'), /仕事のこと/);
  const memo = await call(muse, 'note', { profile: '趣味', text: '架空友人 は週末に会える', kind: 'agent', people: true });
  assert.equal(memo.data.person.id, ids.friend);

  // The writes it may not make are not there; calling one fails.
  for (const [name, args] of [['create_task', { title: 'x' }], ['close', { id: ids.workTask, state: 'done', result: 'x' }], ['book', { kind: 'fixed', title: 'x', starts_at: '2026-11-17T01:00:00Z', ends_at: '2026-11-17T02:00:00Z' }], ['update', { id: ids.hobbyTask, title: 'x' }], ['person', { profile: '趣味', name: 'x' }], ['settings', {}], ['reports', {}], ['activity', {}], ['places', {}]]) {
    const out = await muse.callTool({ name, arguments: args });
    assert.equal(out.isError, true, name);
  }
  assert.equal(ledger.get(ids.workTask).state, 'running');
  assert.equal(ledger.schedule({ from: '2026-11-17T00:00:00Z', to: '2026-11-18T00:00:00Z' }).bookings.length, 0);

});

test('scope: /api refuses a guest\'s key with 403', async (t) => {
  const { base, keys } = await start(t);
  const get = (key) => fetch(`${base}/api/held?dir=/home/alex/office`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal((await get(keys.muse)).status, 403);
  assert.equal((await get(keys.laptop)).status, 200);
});

test('scope: ask_secretary from a guest says so, and names the hidden profiles to the secretary', async (t) => {
  const asked = [];
  const chat = { on: true, request: async (fields, writer) => { asked.push({ fields, writer }); return { request: { id: 'm_1' }, reply: { body: '頼まれました' } }; } };
  const { connect } = await start(t, { chat, secretaryDevice: 'secretary' });
  const muse = await connect('muse');
  const out = await call(muse, 'ask_secretary', { text: '来週の空きを見て、模型の時間を考えて' });
  assert.equal(out.data.status, 'answered');
  assert.deepEqual(asked[0].fields, { from: 'muse', text: '来週の空きを見て、模型の時間を考えて', guest: ['仕事'] });
  assert.equal(asked[0].writer.device, 'muse');
  const body = requestBody(asked[0].fields);
  assert.match(body, /^muse\(外の AI\)からの依頼: 来週の空き/);
  assert.match(body, /プロフィール 仕事 の人・ナレッジ・タスクの中身は、返事に書きません/);
  // An agent's request reads as before.
  const laptop = await connect('laptop');
  await call(laptop, 'ask_secretary', { text: '2時間', minutes: 120 });
  assert.deepEqual(asked[1].fields, { from: 'laptop', text: '2時間', minutes: 120 });
  assert.equal(requestBody(asked[1].fields), 'laptop のエージェントからの依頼: 2時間\n長さ: 120分');
  // A guest is never the secretary, even when the server names none.
  const plain = await start(t);
  const guest = await plain.connect('muse');
  assert.match((await call(guest, 'people')).text, /profile を渡します/);
});

test('scope: agents\' and the secretary\'s keys see and write as before', async (t) => {
  const { connect, ids } = await start(t, { secretaryDevice: 'secretary' });
  for (const name of ['laptop', 'secretary']) {
    const client = await connect(name);
    const tools = (await client.listTools()).tools.map((x) => x.name);
    assert.ok(tools.includes('create_task') && tools.includes('settings') && tools.includes('places'), name);
    const { data: board } = await call(client, 'board');
    const work = board.goals.find((g) => g.id === ids.work);
    assert.equal(work.outcome, 'secret-outcome', name);
    assert.equal(work.tasks[0].body, 'secret-body', name);
    assert.equal((await call(client, 'get', { id: ids.workTask })).data.next, 'secret-next', name);
    const { data: day } = await call(client, 'schedule', { from: '2026-11-16T00:00:00Z', to: '2026-11-17T00:00:00Z' });
    assert.equal(day.bookings[0].note, 'secret-note', name);
    assert.match(JSON.stringify((await call(client, 'people', { profile: '仕事' })).data), /架空課長/, name);
    assert.match((await call(client, 'context', { profile: '仕事' })).data.knowledge.text, /secret-know/, name);
    const made = await call(client, 'create_task', { title: `${name} のタスク`, mode: 'ai_worker' });
    assert.equal(made.res.isError, undefined, name);
  }
  // The secretary still sees every person without naming a profile.
  const secretary = await connect('secretary');
  const everyone = (await call(secretary, 'people')).data;
  assert.deepEqual(everyone.people.map((p) => p.name).sort(), ['架空友人', '架空課長'].sort());
});

test('scope: key add --guest --hide makes a scoped key, key scope shows and clears it', () => {
  const home = path.join(tmpRoot, `cli-${(n += 1)}`);
  fs.mkdirSync(home, { recursive: true });
  const db = path.join(home, 'ledger.sqlite');
  const bin = path.join(import.meta.dirname, '..', 'bin', 'warifuri.mjs');
  const run = (...args) => execFileSync(process.execPath, [bin, ...args, '--home', home, '--db', db], { encoding: 'utf8', env: { ...process.env, WARIFURI_HOME: '', WARIFURI_DB: '' } });
  const added = run('key', 'add', 'muse', '--guest', '--hide', '仕事');
  assert.match(added, /^key for muse:\nwf_/);
  assert.match(added, /scope: profiles: all {2}hide: 仕事=people,knowledge,details {2}write: note,ask_secretary,prep/);
  assert.match(run('key', 'list'), /muse .*\[guest: /);
  assert.match(run('key', 'scope', 'muse', '--hide', '仕事=people', '--write', ''), /hide: 仕事=people {2}write: nothing/);
  assert.match(run('key', 'scope', 'muse', '--clear'), /no scope/);
  assert.throws(() => run('key', 'add', 'other', '--write', 'book'), /note, ask_secretary, prep だけ/);
  assert.doesNotMatch(run('key', 'list'), /other/);
  // An agent's key is made as before, with no scope.
  assert.match(run('key', 'add', 'laptop'), /^key for laptop:\nwf_[^\n]+\nThis key will not be shown again\. Keep it in that device's settings\.\n$/);
});
