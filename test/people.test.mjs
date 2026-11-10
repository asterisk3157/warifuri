// Tests for 人 (src/ledger/people.mjs) and its tools: one entry per person, fields every profile
// they are in sees, items and memos only in the profile they were written in, matching a note
// to the person it begins with, birthdays, merging two entries, and forgetting for good.
// Everyone here is made up.

import test from 'node:test';
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

const W = { actor: 'human', device: 'laptop' };
const LAB = { profile: '研究' };
const CLUB = { profile: 'サークル' };
const ALL = { all: true };

const fixed = (iso) => () => new Date(iso);

test('schema 12: a version 11 file gains the people tables and keeps its records', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warifuri-people-'));
  const file = path.join(dir, 'ledger.sqlite');
  const raw = new DatabaseSync(file);
  raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const sql of MIGRATIONS.slice(0, 11)) raw.exec(sql);
  raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '11')").run();
  raw.prepare("INSERT INTO records (at, actor, entity, entity_id, action, changes) VALUES ('2026-11-01T00:00:00Z', 'human', 'goal', 'g_1', 'create', '{}')").run();
  raw.close();
  assert.equal(SCHEMA_VERSION, 16);
  const ledger = openLedger(file);
  const p = ledger.people.create({ name: '田中先生' }, LAB, W);
  assert.deepEqual(ledger.records('g_1').map((r) => r.action), ['create']);
  assert.deepEqual(ledger.records(p.id).map((r) => [r.entity, r.action]), [['person', 'create']]);
  ledger.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('person: made with its fields, refused in Japanese, and not made twice by name, alias or email', () => {
  const ledger = openLedger(':memory:');
  const p = ledger.people.create({
    name: ' 田中先生 ', aliases: ['田中', '田中', ' '], email: 'Tanaka@Example.com', phone: '+81 3-0000-0000',
    affiliation: '理学部', role: '指導教員', birthday: '1970-04-01',
  }, LAB, W);
  assert.deepEqual([p.name, p.aliases, p.email, p.birthday], ['田中先生', ['田中'], 'tanaka@example.com', '1970-04-01']);
  assert.equal('profiles' in p, false); // only the secretary sees which profiles

  for (const [input, re] of [
    [{}, /name\(名前\)が要ります/],
    [{ name: 'x', email: 'not-an-email' }, /メールアドレスの形ではありません/],
    [{ name: 'x', phone: 'call me' }, /phone は数字/],
    [{ name: 'x', birthday: '02-30' }, /birthday は MM-DD/],
    [{ name: 'x', birthday: '2001-02-29' }, /birthday は MM-DD/],
    [{ name: 'x', aliases: 'one' }, /文字列の並び/],
    [{ name: 'x', profiles: ['サークル'] }, /いまのプロフィール\(研究\)だけ/],
  ]) {
    assert.throws(() => ledger.people.create(input, LAB, W), (err) => err instanceof LedgerError && re.test(err.problems.join('\n')), JSON.stringify(input));
  }
  assert.equal(ledger.people.create({ name: 'うるう', birthday: '02-29' }, LAB, W).birthday, '02-29');

  // The same name, a name they go by, or the email: refused unless they really are two people.
  for (const input of [{ name: '田中' }, { name: 'たなか', aliases: ['田中先生'] }, { name: '別名', email: 'tanaka@example.com' }]) {
    assert.throws(() => ledger.people.create(input, LAB, W), /同じ名前かメールの人がもういます/);
  }
  assert.ok(ledger.people.create({ name: '田中', allow_similar: true }, LAB, W).id);
  // In another profile, nobody is there yet, so nothing is similar.
  assert.ok(ledger.people.create({ name: '田中先生' }, CLUB, W).id);
  assert.throws(() => ledger.people.create({ name: 'x' }, {}, W), /プロフィールを決めます/);
  ledger.close();
});

test('person: fixed fields are seen from each profile the person is in; items and memos only from their own', () => {
  const ledger = openLedger(':memory:');
  const p = ledger.people.create({ name: '佐藤さん', items: { 好きなもの: '紅茶' }, add_memos: [{ text: '朝が早い', mark: '未確認' }], source: 'laptop' }, LAB, W);
  assert.throws(() => ledger.people.get(p.id, CLUB), /いません/);
  assert.throws(() => ledger.people.update(p.id, { add_profiles: ['サークル'] }, LAB, W), /いまのプロフィール\(研究\)だけ/);
  ledger.people.update(p.id, { add_profiles: ['サークル'] }, { ...LAB, secretary: true }, W);
  ledger.people.update(p.id, { role: '部長', items: { 好きなもの: 'ケーキ' }, add_memos: [{ text: '甘い物が好き' }] }, CLUB, W);

  const inLab = ledger.people.get(p.id, LAB);
  const inClub = ledger.people.get(p.id, CLUB);
  assert.equal(inLab.role, '部長');
  assert.deepEqual(inLab.items, [{ label: '好きなもの', value: '紅茶' }]);
  assert.deepEqual(inClub.items, [{ label: '好きなもの', value: 'ケーキ' }]);
  assert.deepEqual(inLab.memos.map((f) => [f.text, f.mark, f.source]), [['朝が早い', '未確認', 'laptop']]);
  assert.deepEqual(inClub.memos.map((f) => f.text), ['甘い物が好き']);
  // The secretary with no profile sees all, each item and memo with its profile.
  const all = ledger.people.get(p.id, ALL);
  assert.deepEqual(all.profiles, ['サークル', '研究']);
  assert.deepEqual(all.items.map((i) => i.profile).sort(), ['サークル', '研究']);
  assert.equal(all.memos.length, 2);

  // Field by field: null clears, items null removes, a memo is rewritten; the last profile stays.
  ledger.people.update(p.id, { role: null, items: { 好きなもの: null } }, CLUB, W);
  const memoId = inLab.memos[0].id;
  ledger.people.update(p.id, { edit_memos: [{ id: memoId, text: '朝7時には来る', mark: null }] }, LAB, W);
  assert.throws(() => ledger.people.update(p.id, { edit_memos: [{ id: memoId, text: 'x' }] }, CLUB, W), /ありません/);
  assert.deepEqual([ledger.people.get(p.id, CLUB).role, ledger.people.get(p.id, CLUB).items], [null, []]);
  assert.deepEqual(ledger.people.get(p.id, LAB).memos.map((f) => [f.text, f.mark]), [['朝7時には来る', null]]);
  ledger.people.update(p.id, { remove_profiles: ['サークル'] }, CLUB, W);
  assert.throws(() => ledger.people.update(p.id, { remove_profiles: ['研究'] }, LAB, W), /forget を使います/);
  assert.throws(() => ledger.people.update(p.id, {}, LAB, W), /直す項目を1つ以上/);
  ledger.close();
});

test('person: numbers that prove who someone is, secrets, health and beliefs are not kept', () => {
  const ledger = openLedger(':memory:');
  const p = ledger.people.create({ name: '山本さん' }, LAB, W);
  for (const input of [
    { items: { マイナンバー: 'x' } },
    { items: { 口座: 'x' } },
    { items: { 持病: 'x' } },
    { items: { メモ: '4111 1111 1111 1111' } },
    { add_memos: [{ text: '番号は 1234-5678-9012 だった' }] },
  ]) {
    assert.throws(() => ledger.people.update(p.id, input, LAB, W), LedgerError, JSON.stringify(input));
  }
  assert.ok(ledger.people.update(p.id, { phone: '090-0000-0000', items: { 苦手なもの: '辛い物' } }, LAB, W));
  ledger.close();
});

test('learn: a memo goes to the person it begins with, or waits for one; assign_memos places it', () => {
  const ledger = openLedger(':memory:');
  const a = ledger.people.create({ name: '田中先生', aliases: ['田中'] }, LAB, W);
  const b = ledger.people.create({ name: '田中 太郎', aliases: ['太郎さん'] }, LAB, W);
  assert.equal(ledger.people.learn({ profile: '研究', text: '田中先生: 図を先に見る' }, W).person.id, a.id);
  assert.equal(ledger.people.learn({ profile: '研究', text: '田中太郎は装置の係' }, W).person.id, b.id); // spaces aside, the longest name wins
  assert.equal(ledger.people.learn({ profile: '研究', text: '太郎さんは夜型' }, W).person.id, b.id);
  assert.equal(ledger.people.learn({ profile: 'サークル', text: '田中先生: 来ない' }, W).person, null); // not in that profile
  const waiting = ledger.people.learn({ profile: '研究', text: '鈴木さん: 新しく来た' }, W);
  assert.equal(waiting.person, null);
  assert.equal(ledger.people.learn({ profile: '研究', text: '何でも', person: b.id }, W).person.id, b.id);
  assert.throws(() => ledger.people.learn({ profile: 'サークル', text: 'x', person: b.id }, W), /いません/);

  const list = ledger.people.list(LAB);
  assert.deepEqual(list.people.map((p) => [p.name, p.memos]), [['田中 太郎', 3], ['田中先生', 1]]);
  assert.deepEqual(list.unassigned.map((f) => f.text), ['鈴木さん: 新しく来た']);
  assert.deepEqual(ledger.people.list(LAB, { query: '太郎' }).people.map((p) => p.id), [b.id]);

  const c = ledger.people.create({ name: '鈴木さん', assign_memos: [waiting.memo] }, LAB, W);
  assert.deepEqual(ledger.people.get(c.id, LAB).memos.map((f) => f.text), ['鈴木さん: 新しく来た']);
  assert.equal(ledger.people.list(LAB).unassigned.length, 0);
  assert.throws(() => ledger.people.update(a.id, { assign_memos: [waiting.memo] }, LAB, W), /もう人に付いています/);
  ledger.close();
});

test('birthdays: the ones coming within the days asked, soonest first, across the new year and on 02-29', () => {
  const ledger = openLedger(':memory:', { now: fixed('2027-12-20T03:00:00Z') });
  ledger.people.create({ name: '冬生まれ', birthday: '2000-12-25' }, CLUB, W);
  ledger.people.create({ name: '年明け', birthday: '01-05' }, CLUB, W);
  ledger.people.create({ name: 'うるう', birthday: '02-29' }, CLUB, W);
  ledger.people.create({ name: '過ぎた', birthday: '12-01' }, CLUB, W);
  ledger.people.create({ name: '別の領域', birthday: '12-21' }, LAB, W);
  const soon = ledger.people.birthdays(CLUB, { within: 30 });
  assert.deepEqual(soon.map((b) => [b.name, b.on, b.in_days, b.turns]), [['冬生まれ', '2027-12-25', 5, 27], ['年明け', '2028-01-05', 16, null]]);
  assert.deepEqual(ledger.people.birthdays(CLUB, { within: 80 }).map((b) => [b.name, b.on]).at(-1), ['うるう', '2028-02-29']);
  assert.equal(ledger.people.birthdays(ALL, { within: 1 }).map((b) => b.name)[0], '別の領域');
  assert.throws(() => ledger.people.birthdays(CLUB, { within: 400 }), /0〜366 日/);
  ledger.close();

  const common = openLedger(':memory:', { now: fixed('2027-02-20T03:00:00Z') });
  common.people.create({ name: 'うるう', birthday: '02-29' }, CLUB, W);
  assert.deepEqual(common.people.birthdays(CLUB).map((b) => b.on), ['2027-02-28']);
  common.close();
});

test('merge_people: one entry is left, with both names, every memo, profile and link; differing fields are kept from into', () => {
  const ledger = openLedger(':memory:');
  const goal = ledger.createGoal({ title: '発表', mode: 'ai_worker' }, W);
  const into = ledger.people.create({ name: '田中先生', email: 'a@example.com', add_memos: [{ text: '図を先に見る' }] }, LAB, W);
  const from = ledger.people.create({ name: 'タナカ', aliases: ['T先生'], email: 'b@example.com', role: '教授', add_memos: [{ text: '朝が早い' }], link: [{ kind: 'goal', id: goal.id }], items: { 好きなもの: '紅茶' } }, CLUB, W);
  ledger.people.update(from.id, { add_profiles: ['研究'] }, { ...CLUB, secretary: true }, W);
  const out = ledger.people.merge(into.id, from.id, LAB, W);
  assert.deepEqual(out.filled, ['role']);
  assert.deepEqual(out.kept_both, ['email']);
  const all = ledger.people.get(into.id, ALL);
  assert.deepEqual([all.aliases, all.email, all.role, all.profiles], [['タナカ', 'T先生'], 'a@example.com', '教授', ['サークル', '研究']]);
  assert.equal(all.memos.length, 2);
  assert.deepEqual(all.links, [{ kind: 'goal', id: goal.id, title: '発表' }]);
  assert.deepEqual(all.items.map((i) => [i.profile, i.label]), [['サークル', '好きなもの']]);
  assert.throws(() => ledger.people.get(from.id, ALL), /いません/);
  assert.throws(() => ledger.people.merge(into.id, into.id, LAB, W), /同じ人どうし/);
  ledger.close();
});

test('forget: the person and everything about them are deleted for good; records keep names of fields, never values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warifuri-people-'));
  const file = path.join(dir, 'ledger.sqlite');
  const ledger = openLedger(file);
  const task = ledger.createTask({ title: '打ち合わせ', mode: 'ai_worker' }, W);
  const p = ledger.people.create({
    name: '消える人', email: 'gone@example.com', items: { 好きなもの: 'ひみつの果物' },
    add_memos: [{ text: 'ひみつの話' }], link: [{ kind: 'task', id: task.id }],
  }, LAB, W);
  const other = ledger.people.create({ name: '残る人', add_memos: [{ text: '残す話' }, { text: '消す話' }] }, LAB, W);
  const out = ledger.people.forget({ person: p.id }, LAB, W);
  assert.deepEqual(out, { person: p.id, memos: 1 });
  const wrongMemo = ledger.people.get(other.id, LAB).memos.find((f) => f.text === '消す話');
  assert.deepEqual(ledger.people.forget({ memos: [wrongMemo.id] }, LAB, W), { person: null, memos: 1 });
  assert.deepEqual(ledger.people.get(other.id, LAB).memos.map((f) => f.text), ['残す話']);
  assert.throws(() => ledger.people.forget({}, LAB, W), /消す人\(person\)か/);
  assert.throws(() => ledger.people.forget({ memos: [wrongMemo.id] }, LAB, W), /ありません/);

  const recs = [...ledger.records(p.id), ...ledger.records(other.id)];
  assert.deepEqual(ledger.records(p.id).map((r) => r.action), ['create', 'forget']);
  assert.doesNotMatch(JSON.stringify(recs), /消える人|gone@|ひみつ|消す話/);
  ledger.close();

  // Nothing of them is left in the file, not even in free pages or the log.
  const bytes = Buffer.concat([file, `${file}-wal`].filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f)));
  for (const s of ['消える人', 'gone@example.com', 'ひみつの果物', 'ひみつの話', '消す話']) {
    assert.equal(bytes.includes(Buffer.from(s, 'utf8')), false, s);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

async function start(t, { secretaryDevice } = {}) {
  const ledger = openLedger(':memory:');
  ledger.createPlace({ name: 'lab', profile: '研究', paths: [{ device: 'laptop', path: '/home/alex/lab' }] }, W);
  const keys = { laptop: ledger.issueKey('laptop', W).key, secretary: ledger.issueKey('secretary', W).key };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'warifuri-people-home-'));
  const server = createServer({ ledger, home, ...(secretaryDevice === undefined ? {} : { secretaryDevice }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const clients = {};
  for (const [name, key] of Object.entries(keys)) {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    }));
    clients[name] = client;
  }
  t.after(async () => {
    for (const c of Object.values(clients)) await c.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    ledger.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const caller = (client) => async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    return { res, text: res.content[0].text, data: res.isError ? null : JSON.parse(res.content[0].text) };
  };
  return { ledger, home, call: caller(clients.laptop), secretary: caller(clients.secretary) };
}

test('the people tools: by place or profile, the secretary sees all, note finds the person, forget needs the person\'s word', async (t) => {
  const { ledger, home, call, secretary } = await start(t, { secretaryDevice: 'secretary' });
  const made = await call('person', { place: '/home/alex/lab', name: '田中先生', aliases: ['田中'], birthday: '12-24', items: { 好きなもの: '紅茶' }, add_memos: [{ text: '図を先に見る' }] });
  assert.equal(made.res.isError, undefined, made.text);
  const id = made.data.id;
  assert.deepEqual(made.data.memos.map((f) => [f.mark, f.source]), [['未確認', 'laptop']]);
  assert.match((await call('person', { profile: '研究', name: '田中' })).text, /同じ名前かメールの人がもういます/);

  // note and close's learned_people land on the person the line begins with.
  assert.equal((await call('note', { profile: '研究', text: '田中: 朝が早い', kind: 'human', people: true })).data.person.id, id);
  const task = ledger.createTask({ title: '相談', mode: 'ai_worker', place_id: ledger.listPlaces()[0].id }, W);
  const closed = (await call('close', { id: task.id, state: 'done', result: 'ok', learned_people: '- 田中先生: メールは前日まで\n- 鈴木さん: 新しく来た' })).data;
  assert.deepEqual(closed.noted_people.map((n) => n.person?.id ?? null), [id, null]);

  const one = (await call('people', { profile: '研究', id })).data;
  assert.deepEqual(one.memos.map((f) => f.mark), ['未確認', '本人の言葉', '未確認']);
  const list = (await call('people', { place: '/home/alex/lab', birthdays_within: 366 })).data;
  assert.deepEqual([list.people.length, list.unassigned.length, list.birthdays[0].name], [1, 1, '田中先生']);
  assert.match((await call('people', {})).text, /place か profile を渡します/);
  assert.equal((await call('people', { profile: 'サークル', id })).res.isError, true);
  assert.deepEqual((await secretary('people', {})).data.people[0].profiles, ['研究']);
  // context gives the short lines, not the memos.
  assert.equal((await call('context', { profile: '研究' })).data.people.people[0].name, '田中先生');

  const twin = (await call('person', { profile: '研究', name: '田中先生(別アドレス)', email: 't@example.com' })).data;
  const merged = (await call('merge_people', { profile: '研究', into: id, from: twin.id })).data;
  assert.equal(merged.person.email, 't@example.com');

  // Importing people.md: dates and marks carried over, then the file renamed by the secretary only.
  const old = (await call('person', { profile: '研究', name: '森先生', add_memos: [{ text: '相談はゼミの後', mark: '本人の言葉', learned_on: '2026-10-24' }], source: 'people.md' })).data;
  assert.deepEqual(old.memos.map((f) => [f.learned_on, f.mark, f.source]), [['2026-10-24', '本人の言葉', 'people.md']]);
  assert.match((await call('person', { profile: '研究', id: old.id, add_memos: [{ text: 'x', learned_on: '10/24' }] })).text, /learned_on は YYYY-MM-DD/);
  const dir = path.join(home, 'profiles', '研究');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'people.md'), '- 2026-10-24 「本人の言葉」 森先生: 相談はゼミの後\n');
  assert.match((await call('context', { profile: '研究' })).data.people_md.text, /森先生/);
  assert.match((await call('finish_people_import', { profile: '研究' })).text, /秘書だけ/);
  assert.deepEqual((await secretary('finish_people_import', { profile: '研究' })).data, { profile: '研究', renamed: 'people.md', to: 'people.imported.md' });
  assert.equal((await call('context', { profile: '研究' })).data.people_md, null);
  assert.ok(fs.existsSync(path.join(dir, 'people.imported.md')));
  assert.match((await secretary('finish_people_import', { profile: '研究' })).text, /people\.md がありません/);

  assert.match((await call('forget_person', { profile: '研究', person: id })).text, /本人が消してと言ったときだけ/);
  assert.deepEqual((await call('forget_person', { profile: '研究', person: id, by_person: true })).data, { person: id, memos: 3 });
  assert.deepEqual((await call('people', { profile: '研究' })).data.people.map((p) => p.name), ['森先生']);
});

test('the table: one column per thing, close names meet, filters by column, and a memo becomes a column', () => {
  const ledger = openLedger(':memory:');
  const a = ledger.people.create({ name: '佐藤さん', affiliation: '2年', items: { 好きなもの: '紅茶' } }, CLUB, W);
  const b = ledger.people.create({ name: '鈴木さん', affiliation: '1年', items: { 好きな物: 'ケーキ', ' 好きなモノ ': 'x' } }, CLUB, W);
  // 好きな物 and 好きなモノ are written as the column the profile already has.
  assert.deepEqual(b.renamed_labels, [{ given: '好きな物', as: '好きなもの' }, { given: '好きなモノ', as: '好きなもの' }]);
  assert.deepEqual(ledger.people.get(b.id, CLUB).items, [{ label: '好きなもの', value: 'x' }]);
  ledger.people.create({ name: '山本さん' }, CLUB, W);

  const table = ledger.people.list(CLUB);
  assert.deepEqual(table.columns.free, [{ label: '好きなもの', count: 2, values: ['x', '紅茶'] }]);
  assert.equal(table.columns.fixed.includes('birthday'), true);
  assert.deepEqual(table.people.map((p) => [p.name, p.items]), [['佐藤さん', { 好きなもの: '紅茶' }], ['山本さん', {}], ['鈴木さん', { 好きなもの: 'x' }]]);
  const names = (where, query) => ledger.people.list(CLUB, { where, query }).people.map((p) => p.name);
  assert.deepEqual(names({ affiliation: '2' }), ['佐藤さん']);
  assert.deepEqual(names({ 好きな物: '' }), ['佐藤さん', '鈴木さん']); // filled, by a close name
  assert.deepEqual(names({ 好きなもの: '紅茶', affiliation: '2年' }), ['佐藤さん']);
  assert.deepEqual(names(undefined, '紅茶'), ['佐藤さん']);
  assert.throws(() => ledger.people.list(CLUB, { where: { affiliation: 1 } }), /文字列です/);

  // Memos have a kind; one that is really a column moves there.
  const withMemos = ledger.people.update(a.id, { add_memos: [{ text: '定例のあとに相談した', kind: 'やりとり' }, { text: 'ギター', kind: 'その他' }, { text: '朝は返事が遅い', kind: '接し方' }] }, CLUB, W);
  assert.deepEqual(withMemos.memos.map((m) => m.kind), ['やりとり', 'その他', '接し方']);
  assert.throws(() => ledger.people.update(a.id, { add_memos: [{ text: 'x', kind: '気分' }] }, CLUB, W), /kind は やりとり/);
  const grade = withMemos.memos.find((m) => m.text === 'ギター');
  const promoted = ledger.people.update(a.id, { promote_memos: [{ id: grade.id, label: '得意なこと' }] }, CLUB, W);
  assert.deepEqual(promoted.items.find((i) => i.label === '得意なこと'), { label: '得意なこと', value: 'ギター' });
  assert.deepEqual(promoted.memos.map((m) => m.text), ['定例のあとに相談した', '朝は返事が遅い']);
  const tip = promoted.memos.find((m) => m.kind === '接し方');
  assert.equal(ledger.people.update(a.id, { edit_memos: [{ id: tip.id, kind: 'その他' }] }, CLUB, W).memos.find((m) => m.id === tip.id).kind, 'その他');
  assert.throws(() => ledger.people.update(a.id, { promote_memos: [{ id: tip.id }] }, CLUB, W), /移す先の列/);
  assert.equal(ledger.people.learn({ profile: 'サークル', text: '佐藤さん: 来週は休み', kind: 'やりとり' }, W).person.id, a.id);
  ledger.close();
});

test('columns: each free column says how many fill it and the values written there, most used first', () => {
  const ledger = openLedger(':memory:');
  for (const [name, grade] of [['一', '東京'], ['二', '大阪'], ['三', '東京'], ['四', '福岡']]) ledger.people.create({ name: `${name}さん`, items: { 出身: grade } }, LAB, W);
  ledger.people.create({ name: '五さん' }, LAB, W);
  assert.deepEqual(ledger.people.columns(LAB).free, [{ label: '出身', count: 4, values: ['東京', '大阪', '福岡'] }]);
  ledger.close();
});

test('schema 16: a version 15 file keeps its people as checked values and can mark columns 未確認', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warifuri-people-'));
  const file = path.join(dir, 'ledger.sqlite');
  const raw = new DatabaseSync(file);
  raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const sql of MIGRATIONS.slice(0, 15)) raw.exec(sql);
  raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '15')").run();
  raw.prepare("INSERT INTO people (id, name, role, created_at, updated_at) VALUES ('n_1', '春野さん', '先輩', 'x', 'x')").run();
  raw.prepare("INSERT INTO person_profiles (person_id, profile) VALUES ('n_1', '研究')").run();
  raw.prepare("INSERT INTO person_items (person_id, profile, label, value, updated_at) VALUES ('n_1', '研究', '好きなもの', '紅茶', 'x')").run();
  raw.close();
  const ledger = openLedger(file);
  const p = ledger.people.get('n_1', LAB);
  assert.deepEqual([p.role, p.unverified, p.items], ['先輩', [], [{ label: '好きなもの', value: '紅茶' }]]);
  const after = ledger.people.update('n_1', { affiliation: '研究室', items: { 苦手なもの: '朝' }, unverified: true }, LAB, W);
  assert.deepEqual(after.unverified, ['affiliation']);
  assert.deepEqual(after.items.map((i) => [i.label, i.unverified ?? false]), [['好きなもの', false], ['苦手なもの', true]]);
  ledger.close();
  const check = new DatabaseSync(file);
  assert.equal(check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '16');
  assert.throws(() => check.prepare("UPDATE person_items SET unverified = 2 WHERE person_id = 'n_1'").run(), /CHECK/);
  check.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('未確認: a guess is marked, the person\'s words replace it, and confirm keeps or removes it', () => {
  const ledger = openLedger(':memory:');
  const guess = ledger.people.create({ name: '冬木さん', role: '会計', email: 'f@example.com', items: { 好きなもの: '紅茶' }, unverified: true }, CLUB, W);
  assert.deepEqual(guess.unverified, ['email', 'role']);
  assert.equal(guess.items[0].unverified, true);
  assert.throws(() => ledger.people.update(guess.id, { role: 'x', unverified: 'yes' }, CLUB, W), /unverified は true/);

  // Written again without the mark: the value and its mark are replaced. A cleared field leaves.
  let p = ledger.people.update(guess.id, { role: '部長', items: { 好きなもの: 'コーヒー' } }, CLUB, W);
  assert.deepEqual([p.role, p.unverified, p.items[0].unverified], ['部長', ['email'], undefined]);
  p = ledger.people.update(guess.id, { phone: '03-0000-0000', unverified: true }, CLUB, W);
  assert.deepEqual(p.unverified, ['email', 'phone']);
  p = ledger.people.update(guess.id, { phone: null, unverified: true }, CLUB, W);
  assert.deepEqual(p.unverified, ['email']);

  // 合っている: the mark goes. 違う: the value goes.
  p = ledger.people.confirm(guess.id, { field: 'email', ok: true }, CLUB, W);
  assert.deepEqual([p.email, p.unverified], ['f@example.com', []]);
  assert.throws(() => ledger.people.confirm(guess.id, { field: 'email', ok: true }, CLUB, W), /未確認ではありません/);
  ledger.people.update(guess.id, { affiliation: '経済学部', items: { 得意なこと: '計算' }, add_memos: [{ text: '火曜はいないらしい', mark: '未確認' }, { text: '本人から聞いた', mark: '本人の言葉' }], unverified: true }, CLUB, W);
  p = ledger.people.confirm(guess.id, { field: 'affiliation', ok: false }, CLUB, W);
  assert.deepEqual([p.affiliation, p.unverified], [null, []]);
  p = ledger.people.confirm(guess.id, { item: { label: '得意なこと' }, ok: true }, CLUB, W);
  assert.equal(p.items.find((i) => i.label === '得意なこと').unverified, undefined);
  ledger.people.update(guess.id, { items: { 苦手なもの: '朝' }, unverified: true }, CLUB, W);
  p = ledger.people.confirm(guess.id, { item: { label: '苦手なもの' }, ok: false }, CLUB, W);
  assert.equal(p.items.some((i) => i.label === '苦手なもの'), false);
  const [maybe, said] = p.memos;
  assert.throws(() => ledger.people.confirm(guess.id, { memo: said.id, ok: true }, CLUB, W), /未確認ではありません/);
  p = ledger.people.confirm(guess.id, { memo: maybe.id, ok: false }, CLUB, W);
  assert.deepEqual(p.memos.map((m) => m.text), ['本人から聞いた']);
  const kept = ledger.people.update(guess.id, { add_memos: [{ text: 'PDF が好き', mark: '未確認' }] }, CLUB, W).memos.at(-1);
  p = ledger.people.confirm(guess.id, { memo: kept.id, ok: true }, CLUB, W);
  assert.equal(p.memos.at(-1).mark, null);

  // One thing at a time, a real answer, and only in the scope.
  assert.throws(() => ledger.people.confirm(guess.id, { ok: true }, CLUB, W), /1つ/);
  assert.throws(() => ledger.people.confirm(guess.id, { field: 'role', memo: 1, ok: true }, CLUB, W), /1つ/);
  assert.throws(() => ledger.people.confirm(guess.id, { field: 'name', ok: true }, CLUB, W), /確かめる列ではありません/);
  assert.throws(() => ledger.people.confirm(guess.id, { field: 'role' }, CLUB, W), /ok は true/);
  assert.throws(() => ledger.people.confirm(guess.id, { field: 'role', ok: true }, LAB, W), /いません/);
  assert.throws(() => ledger.people.confirm(guess.id, { item: { label: '好きなもの' }, ok: true }, ALL, W), /profile/);
  // The records say what was answered, never the value.
  const recs = ledger.records(guess.id).filter((r) => r.action === 'confirm');
  assert.equal(recs.length, 6);
  assert.equal(JSON.stringify(recs).includes('経済学部'), false);
  ledger.close();
});

test('merge carries the marks: a guessed field taken from the other entry stays 未確認', () => {
  const ledger = openLedger(':memory:');
  const a = ledger.people.create({ name: '秋山さん', role: '窓口' }, LAB, W);
  const b = ledger.people.create({ name: '秋山', email: 'a@example.com', items: { 好きなもの: '紅茶' }, unverified: true, allow_similar: true }, LAB, W);
  const out = ledger.people.merge(a.id, b.id, LAB, W);
  assert.deepEqual(out.person.unverified, ['email']);
  assert.equal(out.person.items[0].unverified, true);
  ledger.close();
});

test('person tool: unverified marks the columns written as a guess; without it they are checked values', async (t) => {
  const { call } = await start(t);
  const made = (await call('person', { profile: '研究', name: '夏目先生', role: '指導教員', items: { 好きなもの: '紅茶' }, unverified: true })).data;
  assert.deepEqual([made.unverified, made.items[0].unverified], [['role'], true]);
  const fixed = (await call('person', { profile: '研究', id: made.id, role: '指導教員' })).data;
  assert.deepEqual(fixed.unverified, []);
  const plain = (await call('person', { profile: '研究', name: '秋山さん', role: '窓口' })).data;
  assert.deepEqual(plain.unverified, []);
});
