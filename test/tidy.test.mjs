// Tests for tidying a profile's knowledge (src/knowledge/tidy.mjs) and a profile's defaults
// (profile.yaml), through the MCP tools sort_inbox, split_knowledge, mark_stale and profile:
// entries named by id, all-or-nothing changes, the secretary-only tools, and the person's
// decision for the defaults.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openLedger } from '../src/ledger/ledger.mjs';
import { createServer } from '../src/server/mcp.mjs';
import { profileDir, readProfileDefaults, writeProfileDefaults } from '../src/knowledge/profiles.mjs';
import { parseEntries, topicName } from '../src/knowledge/tidy.mjs';
import { profileColors } from '../src/server/web.mjs';

const ACTOR = { actor: 'human' };
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warifuri-tidy-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let n = 0;
const freshHome = () => {
  const home = path.join(tmpRoot, `home-${(n += 1)}`);
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true });
  return home;
};

const INBOX = [
  '- 2026-11-01 発表の練習は前日にする (laptop / t_1)',
  '- 2026-11-02 田中先生は図を先に見る (laptop)',
  '- 2026-11-03 締切は金曜の17時 (laptop)',
  '- 2026-11-04 締切は金曜 (desk)',
  '  夕方まで',
  '- 2026-11-05 今日はビルドが遅かった (laptop)',
  '',
].join('\n');

// A server with a data directory and a place of the profile 研究, and a client per device.
async function start(t, { secretaryDevice } = {}) {
  const home = freshHome();
  const ledger = openLedger(':memory:');
  ledger.createPlace({ name: 'lab', profile: '研究', paths: [{ device: 'laptop', path: '/home/alex/lab' }] }, ACTOR);
  const keys = { laptop: ledger.issueKey('laptop', ACTOR).key, secretary: ledger.issueKey('secretary', ACTOR).key };
  const server = createServer({ ledger, home, secretary: true, ...(secretaryDevice === undefined ? {} : { secretaryDevice }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const clients = [];
  const as = async (device) => {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${keys[device]}` } },
    }));
    clients.push(client);
    return async (name, args = {}) => {
      const res = await client.callTool({ name, arguments: args });
      return { res, text: res.content[0].text, data: res.isError ? null : JSON.parse(res.content[0].text) };
    };
  };
  t.after(async () => {
    for (const c of clients) await c.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    ledger.close();
  });
  const dir = profileDir(home, '研究');
  fs.mkdirSync(dir, { recursive: true });
  return { ledger, home, dir, as, call: await as('secretary') };
}

const read = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8');

test('parseEntries: list items with their indented lines, headings and paragraphs, ids from the text', () => {
  const { entries } = parseEntries('# 決まり\n\n- a\n  more\n- b\n\nfree text\nnext line\n- a\n  more\n');
  assert.deepEqual(entries.map((e) => [e.kind, e.text]), [
    ['heading', '# 決まり'],
    ['item', '- a\n  more'],
    ['item', '- b'],
    ['text', 'free text\nnext line'],
    ['item', '- a\n  more'],
  ]);
  assert.equal(entries[1].id, entries[4].id);
  assert.match(entries[0].id, /^[0-9a-f]{8}$/);
  assert.deepEqual(parseEntries('').entries, []);
});

test('topicName takes knowledge/<topic>.md and refuses what could leave the folder', () => {
  assert.equal(topicName('knowledge/提出.md').name, 'knowledge/提出.md');
  for (const bad of ['knowledge/../x.md', 'knowledge/a/b.md', 'knowledge/.x.md', 'procedures/x.md', 'knowledge/x.txt', 'knowledge/a%2F.md', 'knowledge/ x.md', 3]) {
    assert.ok(topicName(bad).problem, String(bad));
  }
});

test('sort_inbox lists the inbox, moves, merges and drops entries, and keeps the rest', async (t) => {
  const { ledger, dir, call } = await start(t);
  fs.writeFileSync(path.join(dir, 'inbox.md'), INBOX);
  fs.writeFileSync(path.join(dir, 'knowledge.md'), '# 決まり\n\n- 2026-10-01 「本人の言葉」 共有フォルダは触らない (laptop)\n');

  const list = (await call('sort_inbox', { profile: '研究' })).data;
  assert.equal(list.file, 'inbox.md');
  const [practice, sensei, due1, due2, slow] = list.entries.map((e) => e.id);
  assert.equal(list.entries[3].text, '- 2026-11-04 締切は金曜 (desk)\n  夕方まで');

  const out = await call('sort_inbox', {
    profile: '研究',
    moves: [
      { entries: [practice], to: 'knowledge' },
      { entries: [sensei], to: 'people', checked: true },
      { entries: [due1, due2], to: 'knowledge/提出.md', text: '締切は金曜の17時' },
      { entries: [slow], to: 'drop', reason: 'その日かぎり' },
    ],
  });
  assert.equal(out.res.isError, undefined, out.text);
  assert.equal(out.data.inbox_left, 0);
  assert.deepEqual(out.data.moved.map((m) => m.to), ['knowledge.md', 'people', 'knowledge/提出.md', 'drop']);

  assert.equal(read(dir, 'inbox.md'), '');
  assert.match(read(dir, 'knowledge.md'), /^# 決まり\n\n- 2026-10-01 「本人の言葉」 共有フォルダは触らない \(laptop\)\n- \d{4}-\d{2}-\d{2} 「未確認」 発表の練習は前日にする \(laptop \/ t_1\)\n$/);
  // A person's fact goes to the ledger's people, its source kept apart; checked leaves no mark.
  assert.equal(fs.existsSync(path.join(dir, 'people.md')), false);
  assert.deepEqual(ledger.people.list({ profile: '研究' }).unassigned.map((f) => [f.text, f.mark, f.source]), [['田中先生は図を先に見る', null, 'laptop / 受信箱から']]);
  assert.match(read(dir, 'knowledge/提出.md'), /^- \d{4}-\d{2}-\d{2} 「未確認」 締切は金曜の17時 \(secretary \/ 受信箱から\)\n$/);

  // The record keeps what left the inbox, so it can be put back.
  const rec = ledger.records('研究').at(-1);
  assert.deepEqual([rec.entity, rec.action, rec.device], ['knowledge', 'sort', 'secretary']);
  assert.equal(rec.changes.moved[3].reason, 'その日かぎり');
  assert.equal(rec.changes.moved[3].from[0], '- 2026-11-05 今日はビルドが遅かった (laptop)');
  // What went to people keeps no text there: people can be forgotten, records cannot.
  assert.deepEqual(Object.keys(rec.changes.moved[1]).sort(), ['entries', 'fact', 'person', 'to']);
  assert.doesNotMatch(JSON.stringify(rec.changes), /田中先生/);

  // context lists the new topic file.
  assert.deepEqual((await call('context', { profile: '研究' })).data.files.knowledge, ['knowledge/提出.md']);
});

test('sort_inbox refuses the whole call on any problem and writes nothing', async (t) => {
  const { ledger, dir, call } = await start(t);
  fs.writeFileSync(path.join(dir, 'inbox.md'), INBOX);
  const [a, b] = (await call('sort_inbox', { profile: '研究' })).data.entries.map((e) => e.id);
  const cases = [
    [[{ entries: [a], to: 'knowledge' }, { entries: ['deadbeef'], to: 'knowledge' }], /id deadbeef の項目がありません/],
    [[{ entries: [a, b], to: 'knowledge' }], /まとめた文\(text\)を渡します/],
    [[{ entries: [a], to: 'drop' }], /理由\(reason\)/],
    [[{ entries: [a], to: 'procedures/x.md' }], /to は knowledge、people/],
    [[{ entries: [a], to: 'knowledge' }, { entries: [a], to: 'people' }], /id .* の項目がありません/],
    [[], /1つ以上/],
  ];
  for (const [moves, pattern] of cases) {
    const { res, text } = await call('sort_inbox', { profile: '研究', moves });
    assert.equal(res.isError, true, JSON.stringify(moves));
    assert.match(text, pattern);
  }
  assert.equal(read(dir, 'inbox.md'), INBOX);
  assert.equal(fs.existsSync(path.join(dir, 'knowledge.md')), false);
  assert.equal(ledger.records('研究').length, 0);
});

test('an entry added to the inbox after it was read stays, and ids still name the same entries', async (t) => {
  const { dir, call } = await start(t);
  fs.writeFileSync(path.join(dir, 'inbox.md'), INBOX);
  const first = (await call('sort_inbox', { profile: '研究' })).data.entries[0].id;
  fs.appendFileSync(path.join(dir, 'inbox.md'), '- 2026-11-06 新しい気づき (laptop)\n');
  fs.writeFileSync(path.join(dir, 'inbox.md'), `- 2026-10-31 前に入った気づき (desk)\n${read(dir, 'inbox.md')}`);
  const out = (await call('sort_inbox', { profile: '研究', moves: [{ entries: [first], to: 'knowledge' }] })).data;
  assert.match(out.moved[0].entry, /発表の練習は前日にする/);
  assert.equal(out.inbox_left, 6);
  assert.match(read(dir, 'inbox.md'), /前に入った気づき[\s\S]*新しい気づき \(laptop\)\n$/);
});

test('split_knowledge lists knowledge.md with its size, and moves entries as they are to a topic file', async (t) => {
  const { ledger, dir, call } = await start(t);
  const knowledge = '# 提出\n\n- 締切は金曜\n  17時まで\n- 様式は A4\n\n# ビルド\n\n- ビルドは3分\n';
  fs.writeFileSync(path.join(dir, 'knowledge.md'), knowledge);
  fs.mkdirSync(path.join(dir, 'knowledge'));
  fs.writeFileSync(path.join(dir, 'knowledge', '提出.md'), '- 前からある\n');

  const list = (await call('split_knowledge', { profile: '研究' })).data;
  assert.deepEqual([list.lines, list.split_lines, list.over], [9, 200, false]);
  const [heading, due, form, , build] = list.entries.map((e) => e.id);

  const out = await call('split_knowledge', {
    profile: '研究',
    moves: [{ entries: [form, heading, due], to: 'knowledge/提出.md' }, { entries: [build], to: 'knowledge/ビルド.md' }],
  });
  assert.equal(out.res.isError, undefined, out.text);
  assert.equal(read(dir, 'knowledge/提出.md'), '- 前からある\n\n# 提出\n\n- 締切は金曜\n  17時まで\n- 様式は A4\n');
  assert.equal(read(dir, 'knowledge/ビルド.md'), '- ビルドは3分\n');
  assert.equal(read(dir, 'knowledge.md'), '# ビルド\n');
  assert.equal(out.data.knowledge_lines, 1);
  assert.equal(ledger.records('研究').at(-1).action, 'split');

  const bad = await call('split_knowledge', { profile: '研究', moves: [{ entries: ['deadbeef'], to: 'knowledge/../x.md' }] });
  assert.equal(bad.res.isError, true);
  assert.match(bad.text, /項目がありません[\s\S]*話題のファイルの名前にできません/);
  assert.equal(read(dir, 'knowledge.md'), '# ビルド\n');
});

test('mark_stale adds the date it was valid until under a list item, once, and keeps the entry', async (t) => {
  const { ledger, dir, call } = await start(t);
  fs.writeFileSync(path.join(dir, 'knowledge.md'), '# 部屋\n- 会議は301号室\n  水曜だけ\n- 鍵は事務室\n');
  const [heading, room] = (await call('mark_stale', { profile: '研究' })).data.entries.map((e) => e.id);

  const out = await call('mark_stale', { profile: '研究', marks: [{ id: room, until: '2026-10-31', why: '11月から402号室' }] });
  assert.equal(out.res.isError, undefined, out.text);
  assert.equal(read(dir, 'knowledge.md'), '# 部屋\n- 会議は301号室\n  水曜だけ\n  「古い」 2026-10-31 まで有効。11月から402号室\n- 鍵は事務室\n');
  assert.equal(ledger.records('研究').at(-1).action, 'stale');

  const newId = (await call('mark_stale', { profile: '研究' })).data.entries[1].id;
  for (const [marks, pattern] of [
    [[{ id: newId, until: '2026-10-31' }], /もう古い印が付いています/],
    [[{ id: heading, until: '2026-10-31' }], /箇条/],
    [[{ id: newId, until: '10/31' }], /YYYY-MM-DD/],
  ]) {
    const { res, text } = await call('mark_stale', { profile: '研究', marks });
    assert.equal(res.isError, true);
    assert.match(text, pattern);
  }

  // people.md too; never the inbox.
  fs.writeFileSync(path.join(dir, 'people.md'), '- 田中先生は研究室長\n');
  const person = (await call('mark_stale', { profile: '研究', file: 'people.md' })).data.entries[0].id;
  await call('mark_stale', { profile: '研究', file: 'people.md', marks: [{ id: person, until: '2026-03-31' }] });
  assert.equal(read(dir, 'people.md'), '- 田中先生は研究室長\n  「古い」 2026-03-31 まで有効。\n');
  assert.equal((await call('mark_stale', { profile: '研究', file: 'inbox.md' })).res.isError, true);
});

test('the tidying tools are the secretary\'s: other devices are refused', async (t) => {
  const { dir, as } = await start(t, { secretaryDevice: 'secretary' });
  fs.writeFileSync(path.join(dir, 'inbox.md'), INBOX);
  const laptop = await as('laptop');
  for (const name of ['sort_inbox', 'split_knowledge', 'mark_stale']) {
    const { res, text } = await laptop(name, { profile: '研究' });
    assert.equal(res.isError, true, name);
    assert.match(text, /秘書だけが使えるツール/);
  }
  const secretary = await as('secretary');
  assert.equal((await secretary('sort_inbox', { profile: '研究' })).data.entries.length, 5);
});

test('profile reads the defaults, lists the profiles, and writes only on the person\'s decision', async (t) => {
  const { ledger, home, as } = await start(t, { secretaryDevice: 'secretary' });
  const call = await as('laptop');
  fs.mkdirSync(profileDir(home, 'サークル'));

  const one = (await call('profile', { place: '/home/alex/lab' })).data;
  assert.deepEqual(one, { profile: '研究', human_led: false, color: profileColors(home, ['研究']).研究, defaults: ['human_led', 'color'] });
  assert.deepEqual((await call('profile')).data.profiles.map((p) => p.profile), ['サークル', '研究']);

  const refused = await call('profile', { profile: '研究', human_led: true });
  assert.equal(refused.res.isError, true);
  assert.match(refused.text, /本人が決めます/);
  assert.equal(fs.existsSync(path.join(profileDir(home, '研究'), 'profile.yaml')), false);

  const wrote = (await call('profile', { profile: '研究', human_led: true, color: '#8FD3B2', by_person: true })).data;
  assert.deepEqual(wrote, { profile: '研究', human_led: true, color: '#8fd3b2', defaults: [] });
  // The Web screens read the same colour.
  assert.equal(profileColors(home, ['研究']).研究, '#8fd3b2');
  const rec = ledger.records('研究').at(-1);
  assert.deepEqual([rec.action, rec.device, rec.changes.human_led], ['defaults', 'laptop', { before: null, after: true }]);

  // A new goal of the profile starts with its default; one given wins; null puts it back.
  assert.equal((await call('create_goal', { title: '論文を読む', mode: 'ai_worker', profile: '研究' })).data.human_led, true);
  assert.equal((await call('create_goal', { title: '整理', mode: 'ai_worker', profile: '研究', human_led: false })).data.human_led, false);
  assert.equal((await call('create_goal', { title: '合宿', mode: 'ai_worker', profile: 'サークル' })).data.human_led, false);
  assert.deepEqual((await call('profile', { profile: '研究', color: null, by_person: true })).data.defaults, ['color']);

  for (const [args, pattern] of [
    [{ profile: '研究', color: 'green', by_person: true }, /#rrggbb/],
    [{ human_led: true, by_person: true }, /profile か place/],
  ]) {
    const { res, text } = await call('profile', args);
    assert.equal(res.isError, true);
    assert.match(text, pattern);
  }
});

test('profile.yaml keeps its other lines when the defaults are written', () => {
  const home = freshHome();
  const dir = profileDir(home, '研究');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'profile.yaml'), '# 研究の既定\ncolor: "#a9a3ec"\nnote: keep\n');
  writeProfileDefaults(home, '研究', { human_led: true, color: '#C9CED6' });
  assert.equal(fs.readFileSync(path.join(dir, 'profile.yaml'), 'utf8'), '# 研究の既定\ncolor: "#c9ced6"\nnote: keep\nhuman_led: true\n');
  assert.deepEqual(readProfileDefaults(home, '研究'), { exists: true, human_led: true, color: '#c9ced6' });
  writeProfileDefaults(home, '研究', { human_led: null });
  assert.equal(readProfileDefaults(home, '研究').human_led, null);
});
