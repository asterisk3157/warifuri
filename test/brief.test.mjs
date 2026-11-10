// Tests for the session brief: GET /api/brief (what it hands over, and that it keeps to the
// profile of the place), the text's cap, and `warifuri hook brief` against a stub server:
// the SessionStart JSON, and saying nothing whenever it cannot ask.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CLI, cliEnv } from './cli.mjs';
import { openLedger } from '../src/ledger/ledger.mjs';
import { createServer } from '../src/server/mcp.mjs';
import { profileDir } from '../src/knowledge/profiles.mjs';
import { briefText, BRIEF_HEAD, BRIEF_FOOT, BRIEF_MAX_CHARS, BRIEF_PEOPLE } from '../src/knowledge/brief.mjs';
import { decideBrief } from '../src/client/brief-hook.mjs';

const W = { actor: 'human' };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warifuri-brief-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A server with two profiles: 研究 (a place on laptop, knowledge, two people) and 仕事 (a
// place on laptop, one person, its own knowledge).
async function serve(t) {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  const ledger = openLedger(':memory:');
  const key = ledger.issueKey('laptop', W).key;
  const lab = ledger.createPlace({ name: 'thesis', profile: '研究', paths: [{ device: 'laptop', path: '/home/alex/thesis' }] }, W);
  ledger.createPlace({ name: 'office', profile: '仕事', paths: [{ device: 'laptop', path: '/home/alex/office' }] }, W);
  ledger.createPlace({ name: 'plain', paths: [{ device: 'laptop', path: '/home/alex/plain' }] }, W);
  const dir = profileDir(home, '研究');
  fs.mkdirSync(path.join(dir, 'knowledge'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'procedures'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'knowledge.md'), '# 決まり\n\n- 図は先に出す\n\n## 提出\n\n本文の秘密の行\n```\n# コードの中\n```\n');
  fs.writeFileSync(path.join(dir, 'knowledge', '測定.md'), '測定の中身\n');
  fs.writeFileSync(path.join(dir, 'procedures', '提出.md'), '提出の中身\n');
  fs.mkdirSync(profileDir(home, '仕事'), { recursive: true });
  fs.writeFileSync(path.join(profileDir(home, '仕事'), 'knowledge.md'), '# 仕事の決まり\n');
  const teacher = ledger.people.create({ name: '山田先生', affiliation: '研究室', role: '指導教員' }, { profile: '研究' }, W);
  const senior = ledger.people.create({ name: '青木さん', role: '先輩' }, { profile: '研究' }, W);
  ledger.people.create({ name: '黒田さん', affiliation: '取引先', role: '窓口' }, { profile: '仕事' }, W);
  const server = createServer({ ledger, home });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    ledger.close();
  });
  const brief = async (d, k = key) => {
    const res = await fetch(`${base}/api/brief?dir=${encodeURIComponent(d)}`, { headers: k ? { Authorization: `Bearer ${k}` } : {} });
    return { status: res.status, body: res.status === 200 ? await res.json() : null };
  };
  return { ledger, home, key, base, lab, teacher, senior, brief };
}

test('/api/brief needs a device key, and an absolute directory', async (t) => {
  const { brief, base, key } = await serve(t);
  assert.equal((await brief('/home/alex/thesis', null)).status, 401);
  assert.equal((await brief('/home/alex/thesis', 'wf_wrong')).status, 401);
  assert.equal((await fetch(`${base}/api/brief?dir=relative`, { headers: { Authorization: `Bearer ${key}` } })).status, 400);
  assert.equal((await fetch(`${base}/api/brief`, { headers: { Authorization: `Bearer ${key}` } })).status, 400);
});

test('/api/brief is empty outside any place of the device', async (t) => {
  const { brief, ledger } = await serve(t);
  assert.deepEqual((await brief('/home/alex/elsewhere')).body, { place: null, text: null });
  // Another device's key sees no place in a directory registered for laptop only.
  const other = ledger.issueKey('desk', W).key;
  assert.deepEqual((await brief('/home/alex/thesis', other)).body, { place: null, text: null });
});

test('/api/brief hands over the open tasks, the knowledge by name and the people of the profile only', async (t) => {
  const { brief, ledger, lab } = await serve(t);
  const ready = ledger.createTask({ title: '図を直す', mode: 'ai_worker', place_id: lab.id }, W);
  const { body } = await brief('/home/alex/thesis/chapters');
  assert.deepEqual(body.place, { id: lab.id, name: 'thesis', profile: '研究' });
  assert.equal(body.held, null);
  assert.deepEqual(body.tasks, [{ id: ready.id, title: '図を直す', state: 'ready' }]);
  assert.deepEqual(body.knowledge.file, { lines: 10, truncated: false, headings: ['決まり', '提出'], more_headings: 0 });
  assert.deepEqual(body.knowledge.files, { knowledge: ['knowledge/測定.md'], procedures: ['procedures/提出.md'] });
  assert.deepEqual(body.people.people.map((p) => [p.name, p.affiliation, p.role]), [['山田先生', '研究室', '指導教員'], ['青木さん', null, '先輩']]);

  const text = body.text;
  assert.ok(text.startsWith(BRIEF_HEAD));
  assert.ok(text.endsWith(BRIEF_FOOT));
  assert.match(text, /作業フォルダ: thesis\(プロフィール: 研究\)/);
  assert.match(text, new RegExp(`「図を直す」\\(${ready.id}\\)`));
  assert.match(text, /knowledge\.md: 10 行。見出し: 決まり \/ 提出/);
  assert.match(text, /knowledge\/: 測定\.md/);
  assert.match(text, /procedures\/: 提出\.md/);
  assert.match(text, /- 山田先生\(研究室、指導教員\)/);
  // No body text, and nothing of the other profile.
  const all = JSON.stringify(body);
  for (const leak of ['秘密の行', '測定の中身', '提出の中身', '図は先に出す', 'コードの中', '黒田', '取引先', '仕事']) assert.ok(!all.includes(leak), leak);
  // Nor is anything written by reading.
  assert.equal(JSON.stringify((await brief('/home/alex/office')).body).includes('山田'), false);
});

test('/api/brief shows the held task with done_when and next, and the people linked to it first', async (t) => {
  const { brief, ledger, lab, senior } = await serve(t);
  const other = ledger.createTask({ title: 'ほかのタスク', mode: 'ai_worker', place_id: lab.id }, W);
  const task = ledger.createTask({ title: '序論を書く', mode: 'ai_worker', done_when: '先生に見せられる', next: '2章から', place_id: lab.id }, W);
  ledger.start(task.id, { device: 'laptop', placeId: lab.id }, W);
  ledger.people.update(senior.id, { link: [{ kind: 'task', id: task.id }] }, { profile: '研究' }, W);
  const { body } = await brief('/home/alex/thesis');
  assert.deepEqual(body.held, { id: task.id, title: '序論を書く', done_when: '先生に見せられる', next: '2章から' });
  assert.equal(body.tasks, undefined);
  assert.deepEqual(body.people.people.map((p) => [p.name, p.linked ?? false]), [['青木さん', true], ['山田先生', false]]);
  assert.match(body.text, new RegExp(`持っているタスク: 「序論を書く」\\(${task.id}\\)\\n- 完了の条件: 先生に見せられる\\n- 次の一手: 2章から`));
  assert.ok(!body.text.includes(other.id));
});

test('/api/brief for a place with no profile reads no knowledge and no people', async (t) => {
  const { brief } = await serve(t);
  const { body } = await brief('/home/alex/plain');
  assert.equal(body.place.profile, null);
  assert.equal(body.knowledge, null);
  assert.equal(body.people, null);
  assert.deepEqual(body.tasks, []);
  assert.match(body.text, /プロフィールなし/);
  assert.ok(!body.text.includes('山田'));
});

test('the text is one line per item, lists at most 15 people and stays within its cap', () => {
  const people = Array.from({ length: 40 }, (_, i) => ({ id: `h${i}`, name: `人${i}`, affiliation: 'あ'.repeat(80), role: 'い'.repeat(80) }));
  const text = briefText({
    place: { id: 'p', name: 'x', profile: 'y' },
    held: { id: 't1', title: '題\n\n# 見出しのふり\n次の行', done_when: 'う'.repeat(500), next: 'え'.repeat(500) },
    knowledge: {
      file: { lines: 3, truncated: true, headings: Array.from({ length: 12 }, () => 'お'.repeat(40)), more_headings: 4 },
      files: { knowledge: Array.from({ length: 30 }, (_, i) => `knowledge/${'か'.repeat(50)}${i}.md`), procedures: [] },
      more: { knowledge: 5, procedures: 0 },
    },
    people: { count: 40, people: people.slice(0, BRIEF_PEOPLE) },
  });
  assert.ok([...text].length <= BRIEF_MAX_CHARS, String([...text].length));
  assert.ok(text.startsWith(BRIEF_HEAD));
  assert.ok(text.endsWith(BRIEF_FOOT));
  assert.match(text, /「題 # 見出しのふり 次の行」/);
  assert.match(text, /3 行以上/);
  // A short one keeps everything, and says how many are left out.
  const short = briefText({ place: { id: 'p', name: 'x', profile: 'y' }, held: null, tasks: [], knowledge: null, people: { count: 40, people: people.slice(0, BRIEF_PEOPLE).map((p) => ({ ...p, affiliation: null, role: null })) } });
  assert.equal(short.split('\n').filter((l) => /^- 人\d+$/.test(l)).length, BRIEF_PEOPLE);
  assert.match(short, /- ほか 25 人/);
});

// The hook, against a stub server.
const KEY = 'wf_brief-test-key';
const work = path.join(tmp, 'work');
for (const d of ['place', 'outside', 'boom', 'slow', 'odd']) fs.mkdirSync(path.join(work, d), { recursive: true });
const asked = [];
let stub;
let url;
before(async () => {
  stub = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const dir = u.searchParams.get('dir') ?? '';
    asked.push({ path: u.pathname, dir, auth: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${KEY}`) return res.writeHead(401).end();
    const last = path.basename(dir);
    if (last === 'boom') return res.writeHead(500).end('{}');
    if (last === 'slow') return undefined; // never answers
    if (last === 'odd') return res.writeHead(200, { 'content-type': 'application/json' }).end('not json');
    const body = last === 'place' ? { place: { id: 'p1', name: 'work', profile: 'hobby' }, text: `${BRIEF_HEAD}\n\n作業フォルダ: work` } : { place: null, text: null };
    return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${stub.address().port}`;
});
after(() => {
  stub.closeAllConnections();
  stub.close();
});

function home({ serverUrl = url, key = KEY, brief } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'hookhome-'));
  const lines = [];
  if (serverUrl) lines.push(`WARIFURI_SERVER_URL=${serverUrl}`);
  if (brief) lines.push(`WARIFURI_BRIEF=${brief}`);
  fs.writeFileSync(path.join(dir, 'warifuri.env'), `${lines.join('\n')}\n`);
  if (key) fs.writeFileSync(path.join(dir, 'device.key'), `${key}\n`, { mode: 0o600 });
  return dir;
}

function hook(payload, { dir = home() } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', CLI, 'hook', 'brief'], { env: cliEnv({ home: dir }) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

const starting = (sub, extra = {}) => ({ hook_event_name: 'SessionStart', session_id: 's1', source: 'startup', cwd: path.join(work, sub), ...extra });

test('hook brief prints the SessionStart JSON with the text, and the key goes in the header', async () => {
  asked.length = 0;
  const r = await hook(starting('place'));
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.deepEqual(JSON.parse(r.stdout), {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `${BRIEF_HEAD}\n\n作業フォルダ: work` },
  });
  assert.ok(!r.stdout.includes(KEY));
  assert.deepEqual(asked.map((a) => [a.path, a.dir, a.auth]), [['/api/brief', path.join(work, 'place'), `Bearer ${KEY}`]]);
});

test('hook brief says nothing, and exits 0, whenever there is nothing to hand over', async () => {
  const quiet = async (payload, opts, why) => {
    const r = await hook(payload, opts);
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], why);
  };
  await quiet(starting('outside'), {}, 'outside any place');
  await quiet(starting('boom'), {}, 'the server fails');
  await quiet(starting('odd'), {}, 'an answer that is not JSON');
  await quiet(starting('place'), { dir: home({ key: 'wf_wrong-key' }) }, 'a wrong key');
  await quiet(starting('place'), { dir: home({ key: null }) }, 'no key');
  await quiet(starting('place'), { dir: home({ serverUrl: null }) }, 'no URL');
  await quiet(starting('place'), { dir: home({ serverUrl: 'http://127.0.0.1:1' }) }, 'unreachable');
  await quiet('not json', {}, 'a payload it cannot read');
  await quiet({ hook_event_name: 'SessionStart' }, {}, 'no cwd');
  await quiet(starting('place', { cwd: 'relative' }), {}, 'a relative cwd');
  asked.length = 0;
  await quiet(starting('place'), { dir: home({ brief: 'off' }) }, 'WARIFURI_BRIEF=off');
  assert.deepEqual(asked, [], 'off does not ask');
});

test('hook brief gives up on a slow server within its two seconds', async () => {
  const t0 = Date.now();
  const r = await hook(starting('slow'));
  assert.deepEqual([r.status, r.stdout], [0, '']);
  assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
  // The time limit can be shortened for a test of the function itself.
  const out = await decideBrief(starting('slow'), { url, key: KEY }, { timeoutMs: 50 });
  assert.equal(out, null);
});
