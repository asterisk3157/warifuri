// Tests for a profile's knowledge (src/knowledge/profiles.mjs) and the context and note tools,
// and close with learned, through the MCP endpoint: folder names that are safe on every disk,
// names that cannot reach outside the profile, the caps, and where each kind of note goes.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openLedger, LedgerError } from '../src/ledger/ledger.mjs';
import { createServer } from '../src/server/mcp.mjs';
import {
  profileFolder, profileName, profileDir, readContext, writeNote, secretaryConfigured,
  MAX_FILE_BYTES, MAX_LIST, MAX_NOTE_CHARS, RECORD_TEXT_CHARS,
} from '../src/knowledge/profiles.mjs';

const ACTOR = { actor: 'human' };
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warifuri-knowledge-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let n = 0;
const freshHome = () => {
  const home = path.join(tmpRoot, `home-${(n += 1)}`);
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true });
  return home;
};

test('profileFolder keeps plain and Japanese names, and escapes what a disk would not take', () => {
  const cases = [
    ['hobby', 'hobby'],
    ['研究', '研究'],
    ['サークル 2026', 'サークル 2026'],
    ['a/b', 'a%2Fb'],
    ['a\\b', 'a%5Cb'],
    ['..', '%2E%2E'],
    ['.', '%2E'],
    ['.hidden', '%2Ehidden'],
    ['name.', 'name%2E'],
    [' pad ', '%20pad%20'],
    ['50%', '50%25'],
    ['a:b*c?d"e<f>g|h', 'a%3Ab%2Ac%3Fd%22e%3Cf%3Eg%7Ch'],
    ['tab\there', 'tab%09here'],
    ['CON', '%43ON'],
    ['nul.txt', '%6Eul.txt'],
    ['Com1', '%43om1'],
    ['LPT¹', '%4CPT¹'],
    ['console', 'console'],
  ];
  for (const [name, folder] of cases) {
    assert.equal(profileFolder(name), folder, name);
    assert.equal(profileName(folder), name.normalize('NFC'), folder);
  }
  // A name typed in NFD (as a Mac may give it) gets the same folder as the NFC one.
  assert.equal(profileFolder('ガ'.normalize('NFD')), profileFolder('ガ'));
});

test('profileFolder refuses an empty name and one too long for a folder', () => {
  for (const bad of ['', '   ', undefined, 3]) assert.throws(() => profileFolder(bad), LedgerError);
  assert.equal(profileFolder('あ'.repeat(85)), 'あ'.repeat(85)); // 255 bytes
  assert.throws(() => profileFolder('あ'.repeat(86)), /長すぎます/);
  assert.throws(() => profileFolder('/'.repeat(86)), /長すぎます/);
});

test('profileDir stays directly inside profiles/ whatever the name', () => {
  const home = freshHome();
  const base = path.resolve(home, 'profiles');
  for (const name of ['..', '../..', '../../etc', 'a/../../b', '/abs', 'C:\\x', '..\\..', '%2E%2E']) {
    assert.equal(path.dirname(profileDir(home, name)), base, name);
  }
});

test('readContext reads only files listed in knowledge/ and procedures/', (t) => {
  const home = freshHome();
  const dir = profileDir(home, '研究');
  fs.mkdirSync(path.join(dir, 'knowledge'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'procedures'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'people.md'), '- 指導教員: 山田さん\n');
  fs.writeFileSync(path.join(dir, 'knowledge', '装置.md'.normalize('NFD')), '装置の決まり\n');
  fs.writeFileSync(path.join(dir, 'knowledge', '.hidden.md'), 'no\n');
  fs.mkdirSync(path.join(dir, 'knowledge', 'sub'));
  fs.writeFileSync(path.join(dir, 'procedures', '提出.md'), '1. 出す\n');
  fs.writeFileSync(path.join(home, 'secret.txt'), 'outside\n');
  if (process.platform !== 'win32') fs.symlinkSync(path.join(home, 'secret.txt'), path.join(dir, 'knowledge', 'link.md'));

  const ctx = readContext(home, '研究');
  assert.equal(ctx.exists, true);
  assert.equal(ctx.people.text, '- 指導教員: 山田さん\n');
  assert.equal(ctx.knowledge, null);
  assert.deepEqual(ctx.files, { knowledge: ['knowledge/装置.md'], procedures: ['procedures/提出.md'] });

  assert.equal(readContext(home, '研究', { name: 'knowledge/装置.md' }).text, '装置の決まり\n');
  assert.equal(readContext(home, '研究', { name: 'procedures/提出.md' }).text, '1. 出す\n');
  for (const bad of [
    'people.md', '../people.md', 'knowledge/../people.md', 'knowledge/../../secret.txt', '../../secret.txt',
    '/etc/passwd', 'knowledge', 'knowledge/', 'knowledge/sub', 'knowledge/.hidden.md', 'knowledge/link.md',
    'procedures/提出.md/x', 'other/提出.md', 'knowledge\\..\\people.md',
  ]) {
    assert.throws(() => readContext(home, '研究', { name: bad }), /ありません/, bad);
  }
  // A profile with no folder yet reads as empty.
  const none = readContext(home, 'まだない');
  assert.deepEqual([none.exists, none.people, none.knowledge, none.files.knowledge], [false, null, null, []]);
  t.diagnostic('ok');
});

test('readContext caps the text and the listings', () => {
  const home = freshHome();
  const dir = profileDir(home, 'big');
  fs.mkdirSync(path.join(dir, 'procedures'), { recursive: true });
  // Three-byte characters, so the cap falls in the middle of one.
  fs.writeFileSync(path.join(dir, 'knowledge.md'), 'あ'.repeat(MAX_FILE_BYTES));
  fs.writeFileSync(path.join(dir, 'people.md'), 'short\n');
  for (let i = 0; i < MAX_LIST + 5; i += 1) fs.writeFileSync(path.join(dir, 'procedures', `p${String(i).padStart(3, '0')}.md`), '');
  const ctx = readContext(home, 'big');
  assert.equal(ctx.knowledge.truncated, true);
  assert.equal(ctx.knowledge.bytes, MAX_FILE_BYTES * 3);
  assert.ok(Buffer.byteLength(ctx.knowledge.text) <= MAX_FILE_BYTES);
  assert.doesNotMatch(ctx.knowledge.text, /\uFFFD/);
  assert.equal(ctx.people.truncated, false);
  assert.equal(ctx.files.procedures.length, MAX_LIST);
  assert.equal(ctx.more.procedures, 5);
});

test('writeNote appends, keeps what is there, and marks each kind', () => {
  const home = freshHome();
  const now = new Date(2026, 9, 24, 12);
  fs.mkdirSync(profileDir(home, 'hobby'));
  fs.writeFileSync(path.join(profileDir(home, 'hobby'), 'knowledge.md'), '# hobby\nno newline');
  writeNote(home, 'hobby', { text: '朝に走る', kind: 'human', now });
  writeNote(home, 'hobby', { text: 'line one\r\nline two', kind: 'agent', from: { device: 'laptop', task: 't1' }, now });
  writeNote(home, 'hobby', { text: 'to sort', kind: 'agent', secretary: true, now });
  const dir = profileDir(home, 'hobby');
  assert.equal(
    fs.readFileSync(path.join(dir, 'knowledge.md'), 'utf8'),
    '# hobby\nno newline\n- 2026-10-24 「本人の言葉」 朝に走る\n- 2026-10-24 「未確認」 line one\n  line two (laptop / t1)\n',
  );
  assert.equal(fs.readFileSync(path.join(dir, 'inbox.md'), 'utf8'), '- 2026-10-24 to sort\n');
  assert.throws(() => writeNote(home, 'hobby', { text: ' ', kind: 'human' }), /空です/);
  assert.throws(() => writeNote(home, 'hobby', { text: 'x'.repeat(MAX_NOTE_CHARS + 1), kind: 'human' }), /4000 文字まで/);
  assert.throws(() => writeNote(home, 'hobby', { text: 'x', kind: 'guess' }), /kind は/);
});

test('secretaryConfigured reads plugins.yaml', () => {
  const home = freshHome();
  assert.equal(secretaryConfigured(home), false);
  for (const [text, on] of [
    ['plugins:\n  - secretary\n', true],
    ['secretary:\n  harness: x\n', true],
    ['- name: secretary # nightly\n', true],
    ['plugins:\n  - schedule\n', false],
    ['# - secretary\n', false],
    ['- secretary-notes\n', false],
  ]) {
    fs.writeFileSync(path.join(home, 'plugins.yaml'), text);
    assert.equal(secretaryConfigured(home), on, text);
  }
});

// A server with a data directory, a place of the profile 研究 on the laptop, one with no
// profile, and the laptop's key.
async function start(t, { secretary, home = freshHome(), withHome = true } = {}) {
  const ledger = openLedger(':memory:');
  const lab = ledger.createPlace({ name: 'lab', profile: '研究', paths: [{ device: 'laptop', path: '/home/alex/lab' }] }, ACTOR);
  const loose = ledger.createPlace({ name: 'loose', paths: [{ device: 'laptop', path: '/home/alex/loose' }] }, ACTOR);
  const key = ledger.issueKey('laptop', ACTOR).key;
  const server = createServer({ ledger, ...(withHome ? { home } : {}), ...(secretary === undefined ? {} : { secretary }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  }));
  t.after(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    ledger.close();
  });
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    return { res, text: res.content[0].text, data: res.isError ? null : JSON.parse(res.content[0].text) };
  };
  return { ledger, home, call, places: { lab, loose }, dir: profileDir(home, '研究') };
}

test('context by place directory, place id or profile, and one file by name', async (t) => {
  const { call, places, dir } = await start(t);
  fs.mkdirSync(path.join(dir, 'procedures'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'knowledge.md'), '- 締切は金曜\n');
  fs.writeFileSync(path.join(dir, 'procedures', 'release.md'), 'step\n');

  const byDir = (await call('context', { place: '/home/alex/lab/src' })).data;
  assert.equal(byDir.profile, '研究');
  assert.equal(byDir.knowledge.text, '- 締切は金曜\n');
  assert.deepEqual(byDir.files.procedures, ['procedures/release.md']);
  assert.equal((await call('context', { place: places.lab.id })).data.profile, '研究');
  assert.equal((await call('context', { profile: '研究', place: places.loose.id })).data.knowledge.text, '- 締切は金曜\n');
  assert.equal((await call('context', { profile: '研究', name: 'procedures/release.md' })).data.text, 'step\n');

  const refusals = [
    [{ profile: '研究', name: '../knowledge.md' }, /ありません/],
    [{ place: '/elsewhere' }, /どの置き場にも入っていません.*もう一度 context/],
    [{ place: places.loose.id }, /プロフィールが付いていません/],
    [{}, /place か profile/],
  ];
  for (const [args, pattern] of refusals) {
    const { res, text } = await call('context', args);
    assert.equal(res.isError, true, JSON.stringify(args));
    assert.match(text, pattern);
  }
});

test('note: human words go to knowledge.md at once; an agent note is 未確認 without a secretary', async (t) => {
  const { ledger, call, dir } = await start(t);
  const human = (await call('note', { place: '/home/alex/lab', text: '共有フォルダは触らない', kind: 'human' })).data;
  assert.deepEqual([human.profile, human.file, human.mark], ['研究', 'knowledge.md', '本人の言葉']);
  const agent = (await call('note', { profile: '研究', text: 'ビルドは 3 分かかる', kind: 'agent' })).data;
  assert.deepEqual([agent.file, agent.mark], ['knowledge.md', '未確認']);
  const text = fs.readFileSync(path.join(dir, 'knowledge.md'), 'utf8');
  assert.match(text, /^- \d{4}-\d{2}-\d{2} 「本人の言葉」 共有フォルダは触らない \(laptop\)\n- \d{4}-\d{2}-\d{2} 「未確認」 ビルドは 3 分かかる \(laptop\)\n$/);
  assert.equal(fs.existsSync(path.join(dir, 'inbox.md')), false);

  const recs = ledger.records('研究');
  assert.deepEqual(recs.map((r) => [r.entity, r.action, r.actor, r.device, r.changes.kind, r.changes.file]), [
    ['knowledge', 'note', 'device-key', 'laptop', 'human', 'knowledge.md'],
    ['knowledge', 'note', 'device-key', 'laptop', 'agent', 'knowledge.md'],
  ]);
  assert.equal(recs[0].changes.text, '共有フォルダは触らない');
});

test('note: with a secretary, an agent note goes to inbox.md and human words still to knowledge.md', async (t) => {
  const home = freshHome();
  fs.writeFileSync(path.join(home, 'plugins.yaml'), 'plugins:\n  - secretary\n');
  const { call, dir } = await start(t, { home });
  assert.equal((await call('note', { profile: '研究', text: 'a guess', kind: 'agent' })).data.file, 'inbox.md');
  assert.equal((await call('note', { profile: '研究', text: 'said so', kind: 'human' })).data.file, 'knowledge.md');
  assert.match(fs.readFileSync(path.join(dir, 'inbox.md'), 'utf8'), /^- \d{4}-\d{2}-\d{2} a guess \(laptop\)\n$/);

  // The secretary option of createApp wins over plugins.yaml.
  const off = await start(t, { home, secretary: false });
  assert.equal((await off.call('note', { profile: '研究', text: 'another', kind: 'agent' })).data.file, 'knowledge.md');
});

test('note: a long note is recorded by its start, length and hash; past the cap it is refused', async (t) => {
  const { ledger, call } = await start(t);
  const long = 'あ'.repeat(RECORD_TEXT_CHARS + 1);
  assert.equal((await call('note', { profile: 'hobby', text: long, kind: 'human' })).res.isError, undefined);
  const rec = ledger.records('hobby')[0].changes;
  assert.equal(rec.text, undefined);
  assert.equal(rec.chars, RECORD_TEXT_CHARS + 1);
  assert.equal(rec.excerpt.length, 200);
  assert.match(rec.sha256, /^[0-9a-f]{64}$/);

  const { res, text } = await call('note', { profile: 'hobby', text: 'x'.repeat(MAX_NOTE_CHARS + 1), kind: 'human' });
  assert.equal(res.isError, true);
  assert.match(text, /^書けませんでした。\n- 1回に書けるのは 4000 文字まで/);
  assert.equal(ledger.records('hobby').length, 1);
});

test('context and note refuse when the server has no data directory', async (t) => {
  const { call } = await start(t, { withHome: false });
  for (const [name, args] of [['context', { profile: '研究' }], ['note', { profile: '研究', text: 'x', kind: 'human' }]]) {
    const { res, text } = await call(name, args);
    assert.equal(res.isError, true);
    assert.match(text, /プロフィールのフォルダが設定されていません/);
  }
});

test('close with learned writes an agent note to the profile of the task, and keeps the record', async (t) => {
  const { ledger, call, places, dir } = await start(t);
  const task = (await call('create_task', { title: 'Measure', mode: 'ai_worker', place_id: places.lab.id })).data;
  const closed = (await call('close', { id: task.id, state: 'done', result: 'measured', learned: '測定は朝のほうが安定する' })).data;
  assert.equal(closed.state, 'done');
  assert.deepEqual(closed.noted, { profile: '研究', file: 'knowledge.md', mark: '未確認' });
  assert.match(fs.readFileSync(path.join(dir, 'knowledge.md'), 'utf8'), new RegExp(`「未確認」 測定は朝のほうが安定する \\(laptop / ${task.id}\\)\\n$`));
  const closeRec = ledger.records(task.id).at(-1);
  assert.deepEqual(closeRec.changes.learned, { before: null, after: '測定は朝のほうが安定する' });
  assert.equal(ledger.records('研究')[0].changes.task, task.id);

  // A goal's tasks take the goal's profile.
  const goal = (await call('create_goal', { title: 'Paper', mode: 'ai_worker', profile: 'hobby' })).data;
  const inGoal = (await call('create_task', { title: 'Draft', mode: 'ai_worker', goal_id: goal.id, place_id: places.lab.id })).data;
  assert.equal((await call('close', { id: inGoal.id, state: 'done', result: 'ok', learned: 'x' })).data.noted.profile, 'hobby');

  // With no profile, the close still happens and the learned stays in its record only.
  const loose = (await call('create_task', { title: 'Loose', mode: 'ai_worker', place_id: places.loose.id })).data;
  const looseClosed = (await call('close', { id: loose.id, state: 'discarded', reason: 'no need', learned: 'y' })).data;
  assert.equal(looseClosed.state, 'discarded');
  assert.match(looseClosed.noted.skipped, /プロフィールが分からない/);
  assert.equal(ledger.records(loose.id).at(-1).changes.learned.after, 'y');

  // Without learned, close answers as before.
  const plain = (await call('create_task', { title: 'Plain', mode: 'ai_worker', place_id: places.lab.id })).data;
  assert.equal('noted' in (await call('close', { id: plain.id, state: 'done', result: 'ok' })).data, false);
});
