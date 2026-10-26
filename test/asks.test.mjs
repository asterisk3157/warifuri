// Tests for the data of the secretary's window (schema version 9): threads started from a
// message with their unread counts, the secretary's questions (ask) with answers, あとで and a
// changed answer (a revoke in autonomy, and one line in the conversation), reply buttons,
// files sent with a message, and the ask and reply_options tools. The runner is in
// window-chat.test.mjs, the endpoints in window-web.test.mjs.

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warifuri-asks-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const WEB = { actor: 'web', device: null };
const SECRETARY = { actor: 'device-key', device: 'secretary' };
const SHA = 'a'.repeat(64);

const ticking = () => {
  let tick = 0;
  return () => new Date(Date.parse('2026-10-25T03:00:00Z') + (tick += 1));
};

const problemsOf = (fn) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof LedgerError) return err.problems;
    throw err;
  }
  assert.fail('expected a LedgerError');
};

const Q = (extra = {}) => ({
  header: 'タスク整理',
  question: '「調べもの」はどうしますか？',
  options: [
    { label: 'やってみたいことに残す', description: '先送りにします' },
    { label: '閉じる', description: 'done で閉じます' },
    { label: 'このまま続ける', description: '作業中のままです' },
  ],
  ...extra,
});

test('schema: a version 8 file keeps its thread, messages and proposals, and gains threads of a message, asks and files', () => {
  const file = path.join(tmp, 'v8.sqlite');
  const raw = new DatabaseSync(file);
  raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (const m of MIGRATIONS.slice(0, 8)) raw.exec(m);
  raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '8')").run();
  raw.prepare("INSERT INTO threads (id, kind, title, runner, session_id, created_at, updated_at) VALUES ('c_20261001000000_aaaaaa', 'secretary', '秘書', 'resume', 's-1', 'x', 'x')").run();
  raw.prepare("INSERT INTO messages (id, thread_id, role, body, actor, created_at) VALUES ('m_20261001000000_aaaaaa', 'c_20261001000000_aaaaaa', 'user', 'おはよう', 'web', '2026-10-01T00:00:00.000Z')").run();
  raw.prepare("INSERT INTO messages (id, thread_id, role, kind, body, title, autonomy_kind, state, actor, created_at) VALUES ('m_20261001000001_bbbbbb', 'c_20261001000000_aaaaaa', 'secretary', 'proposal', 'b', '案', 'close_forgotten', 'open', 'device-key', '2026-10-01T00:00:01.000Z')").run();
  raw.prepare("INSERT INTO records (at, actor, entity, entity_id, action, changes) VALUES ('x', 'web', 'message', 'm_20261001000000_aaaaaa', 'create', '{}')").run();
  assert.throws(() => raw.prepare("INSERT INTO records (at, actor, entity, entity_id, action, changes) VALUES ('x', 'web', 'attachment', 'a1', 'create', '{}')").run(), /CHECK/);
  raw.close();

  assert.equal(SCHEMA_VERSION, 9);
  const L = openLedger(file, { now: ticking() });
  const thread = L.getThread();
  assert.equal(thread.session_id, 's-1');
  assert.equal(thread.parent_id, null);
  const [m, p] = L.listMessages(thread.id);
  assert.deepEqual([m.body, m.data, p.kind, p.state], ['おはよう', null, 'proposal', 'open']);
  assert.deepEqual(L.records(m.id).map((r) => r.entity), ['message']);
  // The old rows work with the new tables: a thread from the message, a file.
  const sub = L.openThread(m.id, WEB);
  assert.equal(sub.kind, 'sub');
  const a = L.addAttachment({ name: 'メモ.txt', type: 'text/plain', size: 3, sha256: SHA }, WEB);
  assert.match(a.id, /^a_\d{14}_[a-z0-9]{6}$/);
  assert.deepEqual(L.records(a.id).map((r) => r.entity), ['attachment']);
  L.close();

  const check = new DatabaseSync(file);
  assert.equal(check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '9');
  for (const t of ['messages_v8', 'threads_v8', 'records_v8']) assert.equal(check.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(t), undefined);
  for (const i of ['messages_thread', 'messages_state', 'threads_kind', 'records_entity']) assert.ok(check.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(i), i);
  assert.throws(() => check.exec('DELETE FROM records WHERE id = 1'), /append-only/);
  // Still one secretary thread; a thread of a message has its parent, once.
  assert.throws(() => check.prepare("INSERT INTO threads (id, kind, title, created_at, updated_at) VALUES ('c_x', 'secretary', 't', 'x', 'x')").run(), /UNIQUE/);
  assert.throws(() => check.prepare("INSERT INTO threads (id, kind, title, created_at, updated_at) VALUES ('c_y', 'sub', 't', 'x', 'x')").run(), /CHECK/);
  assert.throws(() => check.prepare("INSERT INTO threads (id, kind, title, parent_id, created_at, updated_at) VALUES ('c_z', 'sub', 't', 'm_20261001000000_aaaaaa', 'x', 'x')").run(), /UNIQUE/);
  // An ask has a state; a text none.
  assert.throws(() => check.prepare("INSERT INTO messages (id, thread_id, role, kind, body, actor, created_at) VALUES ('m_q', 'c_20261001000000_aaaaaa', 'secretary', 'ask', 'q', 'x', 'x')").run(), /CHECK/);
  check.close();
});

test('ask: stored with its questions in the shape of AskUserQuestion, refused in Japanese when it is not', () => {
  const L = openLedger(':memory:', { now: ticking() });
  const a = L.ask({ questions: [Q({ kind: 'close_forgotten' }), { header: '期日', question: '延ばしますか？', options: [{ label: '今日のまま' }, { label: '延ばす', description: '日付は次に聞きます' }] }] }, SECRETARY);
  assert.equal(a.kind, 'ask');
  assert.equal(a.state, 'open');
  assert.equal(a.role, 'secretary');
  assert.equal(a.thread_id, L.getThread().id);
  assert.equal(a.data.questions.length, 2);
  assert.deepEqual(a.data.answers, [null, null]);
  assert.equal(a.data.questions[1].options[0].description, '');
  assert.equal(a.data.questions[1].multiSelect, false);
  assert.match(a.body, /【タスク整理】「調べもの」はどうしますか？\n【期日】延ばしますか？/);

  assert.deepEqual(problemsOf(() => L.ask({ questions: [] }, SECRETARY)), ['questions は1〜4問の配列です']);
  assert.deepEqual(problemsOf(() => L.ask({ questions: [Q(), Q(), Q(), Q(), Q()] }, SECRETARY)), ['questions は1〜4問の配列です']);
  const p = problemsOf(() => L.ask({ questions: [{ header: 'とても長いラベルの名前です', question: '', options: [{ label: 'その他' }], color: 'x' }] }, SECRETARY));
  assert.ok(p.includes('1問目の color は渡せません'));
  assert.ok(p.includes('1問目のラベル(header)は12文字までです'));
  assert.ok(p.includes('1問目の問い(question)が要ります'));
  assert.ok(p.includes('1問目の選択肢(options)は2〜4個です'));
  assert.ok(problemsOf(() => L.ask({ questions: [Q({ options: [{ label: 'a' }, { label: 'a' }] })] }, SECRETARY)).some((x) => /同じ名前の選択肢/.test(x)));
  assert.ok(problemsOf(() => L.ask({ questions: [Q({ options: [{ label: 'a' }, { label: 'その他' }] })] }, SECRETARY)).some((x) => /warifuri が出す/.test(x)));
  assert.ok(problemsOf(() => L.ask({ questions: [Q({ kind: 'fly' })] }, SECRETARY)).some((x) => /kind は/.test(x)));
  assert.ok(problemsOf(() => L.ask({ questions: [Q({ about: 't_20261001000000_zzzzzz' })] }, SECRETARY)).some((x) => /ゴールやタスクはありません/.test(x)));
  assert.ok(problemsOf(() => L.ask({ questions: [Q()], thread: 'c_20261001000000_zzzzzz' }, SECRETARY)).some((x) => /会話はありません/.test(x)));
  L.close();
});

test('ask: an answer is stored and shown as the person\'s message; the first option is approved, its own words changed, another refused', () => {
  const L = openLedger(':memory:', { now: ticking() });
  const a = L.ask({ questions: [Q({ kind: 'close_forgotten' }), Q({ header: '期日', kind: 'reschedule_block' }), Q({ header: '進め方', multiSelect: true })] }, SECRETARY);
  const one = L.answerAsk(a.id, { index: 0, picked: ['やってみたいことに残す'] }, WEB);
  assert.equal(one.ask.state, 'open', 'two questions are left');
  assert.equal(one.outcome.outcome, 'approved');
  assert.deepEqual([one.message.role, one.message.kind, one.message.body], ['user', 'answer', 'やってみたいことに残す']);
  assert.deepEqual(one.message.data, { ask: a.id, index: 0, header: 'タスク整理', question: '「調べもの」はどうしますか？', changed: false });
  const two = L.answerAsk(a.id, { index: 1, other: '来週の月曜にして' }, WEB);
  assert.equal(two.outcome.outcome, 'changed');
  assert.equal(two.message.body, '来週の月曜にして');
  const three = L.answerAsk(a.id, { index: 2, picked: ['閉じる', 'このまま続ける'], other: 'どちらも' }, WEB);
  assert.equal(three.outcome, null, 'a question with no kind records nothing in autonomy');
  assert.equal(three.message.body, '閉じる、このまま続ける / どちらも');
  assert.equal(three.ask.state, 'answered');
  assert.equal(L.listAutonomy().kinds.find((k) => k.kind === 'close_forgotten').approvals_in_row, 1);

  const b = L.ask({ questions: [Q({ kind: 'move_task' })] }, SECRETARY);
  assert.equal(L.answerAsk(b.id, { index: 0, picked: ['閉じる'] }, WEB).outcome.outcome, 'refused');
  assert.deepEqual(problemsOf(() => L.answerAsk(b.id, { index: 0, picked: ['閉じる'] }, WEB)), ['前と同じ答えです']);
  assert.deepEqual(problemsOf(() => L.answerAsk(b.id, { index: 0, picked: ['閉じる', 'このまま続ける'] }, WEB)), ['この問いで選べるのは1つだけです']);
  assert.deepEqual(problemsOf(() => L.answerAsk(b.id, { index: 0, picked: ['飛ぶ'] }, WEB)), ['「飛ぶ」という選択肢はありません']);
  assert.deepEqual(problemsOf(() => L.answerAsk(b.id, { index: 0 }, WEB)), ['選択肢を選ぶか、その他に書きます']);
  assert.throws(() => L.answerAsk(b.id, { index: 3, picked: ['閉じる'] }, WEB), /index は0〜0/);
  assert.throws(() => L.answerAsk('m_20261001000000_zzzzzz', { index: 0 }, WEB), /質問はありません/);
  assert.deepEqual(problemsOf(() => L.answerAsk(b.id, { later: true }, WEB)), ['この質問には、もう全部答えています']);
  L.close();
});

test('ask: あとで leaves the questions for later; answering one again changes it, revokes what the old answer did, and says so in one line', () => {
  const L = openLedger(':memory:', { now: ticking() });
  const later = L.ask({ questions: [Q()] }, SECRETARY);
  const out = L.answerAsk(later.id, { later: true }, WEB);
  assert.equal(out.ask.state, 'later');
  assert.deepEqual([out.message.kind, out.message.body, out.message.data.later], ['answer', 'あとで', true]);
  // Answered later after all.
  assert.equal(L.answerAsk(later.id, { index: 0, picked: ['閉じる'] }, WEB).ask.state, 'answered');

  const a = L.ask({ questions: [Q({ kind: 'close_forgotten' })] }, SECRETARY);
  L.answerAsk(a.id, { index: 0, picked: ['やってみたいことに残す'] }, WEB);
  const changed = L.answerAsk(a.id, { index: 0, picked: ['閉じる'] }, WEB);
  assert.equal(changed.changed, true);
  assert.equal(changed.message.data.changed, true);
  assert.deepEqual(changed.ask.data.answers[0].previous.map((x) => [x.picked[0], x.outcome]), [['やってみたいことに残す', 'approved']]);
  const kind = L.listAutonomy().kinds.find((k) => k.kind === 'close_forgotten');
  assert.deepEqual([kind.revokes, kind.approvals_in_row], [1, 0]);
  const outcomes = L.records('close_forgotten').map((r) => r.changes.outcome);
  assert.deepEqual(outcomes, ['approved', 'revoked', 'refused']);
  const last = L.listMessages(L.getThread().id).at(-1);
  assert.equal(last.role, 'system');
  assert.equal(last.body, '「タスク整理」の答えを「やってみたいことに残す」から「閉じる」に変えました。前の答えで行ったことを取り消してから、新しい答えのとおりに行います。');
  // A refused answer did nothing, so changing it revokes nothing.
  L.answerAsk(a.id, { index: 0, other: '来月にもう一度' }, WEB);
  assert.equal(L.listAutonomy().kinds.find((k) => k.kind === 'close_forgotten').revokes, 1);
  L.close();
});

test('ask: one card at a time: a new ask waits until every question of the open one is answered or put off', () => {
  const L = openLedger(':memory:', { now: ticking() });
  const a = L.ask({ questions: [Q(), Q({ header: '期日' })] }, SECRETARY);
  assert.deepEqual(problemsOf(() => L.ask({ questions: [Q({ header: '別の件' })] }, SECRETARY)), [
    `まだ答えを待っている質問があります(${a.id})。聞きたいことは1回の ask に4問までまとめ、答えが届いてから次を聞きます`,
  ]);
  L.answerAsk(a.id, { index: 0, picked: ['閉じる'] }, WEB);
  assert.ok(problemsOf(() => L.ask({ questions: [Q({ header: '別の件' })] }, SECRETARY))[0].startsWith('まだ答えを待っている'), 'one answer is not enough');
  // Another conversation has its own card.
  const thread = L.openThread(a.id, WEB);
  assert.equal(L.ask({ questions: [Q()], thread: thread.id }, SECRETARY).state, 'open');
  L.answerAsk(a.id, { index: 1, picked: ['閉じる'] }, WEB);
  const b = L.ask({ questions: [Q({ header: '別の件' })] }, SECRETARY);
  L.answerAsk(b.id, { later: true }, WEB);
  assert.equal(L.ask({ questions: [Q({ header: 'その次' })] }, SECRETARY).state, 'open', 'あとで lets the next one come');
  L.close();
});

test('ask: a question about an open proposal answers the proposal too; changing it clears the done mark', () => {
  const L = openLedger(':memory:', { now: ticking() });
  const p = L.propose({ kind: 'reschedule_block', title: '予定を明日へ', body: 'b' }, SECRETARY);
  const a = L.ask({ questions: [Q({ header: '予定', proposal: p.id, options: [{ label: '明日へ動かす' }, { label: '動かさない' }] })] }, SECRETARY);
  L.answerAsk(a.id, { index: 0, picked: ['明日へ動かす'] }, WEB);
  let prop = L.getMessage(p.id);
  assert.deepEqual([prop.state, prop.answer], ['approved', '明日へ動かす']);
  assert.deepEqual(L.listProposals().map((x) => x.id), [p.id]);
  L.markProposalDone(p.id, { note: '動かした' }, SECRETARY);
  L.answerAsk(a.id, { index: 0, picked: ['動かさない'] }, WEB);
  prop = L.getMessage(p.id);
  assert.deepEqual([prop.state, prop.done_at], ['refused', null]);
  assert.equal(L.listAutonomy().kinds.find((k) => k.kind === 'reschedule_block').revokes, 1);
  assert.ok(problemsOf(() => L.ask({ questions: [Q({ proposal: p.id })] }, SECRETARY)).some((x) => /もう答えがあります/.test(x)));
  L.close();
});

test('threads: one per message of the secretary\'s conversation, with what was said and the unread; reading clears it', () => {
  const L = openLedger(':memory:', { now: ticking() });
  const main = L.ensureThread('secretary', WEB);
  const m = L.addMessage(main.id, { role: 'secretary', body: 'おはようございます。今日決めてほしいことが2件あります。' }, SECRETARY);
  const sub = L.openThread(m.id, WEB);
  assert.deepEqual([sub.kind, sub.parent_id, sub.title], ['sub', m.id, 'おはようございます。今日決めてほしいことが2件あります。']);
  assert.equal(L.openThread(m.id, WEB).id, sub.id, 'the same message opens the same thread');
  assert.equal(L.getThread(sub.id).id, sub.id);
  assert.equal(L.getThread().id, main.id);
  assert.deepEqual(L.threadCounts(), { [m.id]: { id: sub.id, count: 0, unread: 0 } });
  L.addMessage(sub.id, { role: 'user', body: '先に残りを教えて' }, WEB);
  L.addMessage(sub.id, { role: 'secretary', body: '残りは3件です' }, SECRETARY);
  L.addMessage(sub.id, { role: 'system', body: 'お知らせ' }, SECRETARY);
  assert.deepEqual(L.threadCounts()[m.id], { id: sub.id, count: 2, unread: 1 });
  L.markThreadRead(sub.id, WEB);
  assert.deepEqual(L.threadCounts()[m.id], { id: sub.id, count: 2, unread: 0 });
  L.ask({ questions: [Q()], thread: sub.id }, SECRETARY);
  assert.deepEqual(L.threadCounts()[m.id], { id: sub.id, count: 3, unread: 1 });

  // Not from a message of a thread, nor from warifuri's own rows.
  const inSub = L.listMessages(sub.id)[0];
  assert.throws(() => L.openThread(inSub.id, WEB), /スレッドを始められる/);
  const trig = L.addMessage(main.id, { role: 'system', kind: 'trigger', body: '朝の時間です', data: { job: 'morning' } }, SECRETARY);
  assert.throws(() => L.openThread(trig.id, WEB), /スレッドを始められる/);
  assert.throws(() => L.ensureThread('sub', WEB), /openThread/);
  assert.deepEqual(problemsOf(() => L.addMessage(main.id, { role: 'user', kind: 'digest', body: 'x' }, WEB)), ['digest は warifuri のお知らせ(system)だけが書けます']);
  L.close();
});

test('reply buttons: 1–2 short ones, kept on the thread until the reply takes them', () => {
  const L = openLedger(':memory:', { now: ticking() });
  const main = L.ensureThread('secretary', WEB);
  const t = L.setReplyOptions(main.id, ['置いて', ' 今日は置かない '], SECRETARY);
  assert.equal(t.pending_options, JSON.stringify(['置いて', '今日は置かない']));
  assert.deepEqual(problemsOf(() => L.setReplyOptions(main.id, [], SECRETARY)), ['options は1〜2個の配列です']);
  assert.deepEqual(problemsOf(() => L.setReplyOptions(main.id, ['a', 'b', 'c'], SECRETARY)), ['options は1〜2個の配列です']);
  assert.deepEqual(problemsOf(() => L.setReplyOptions(main.id, ['a', 'a'], SECRETARY)), ['同じ返事の候補が2つあります']);
  assert.ok(problemsOf(() => L.setReplyOptions(main.id, ['あ'.repeat(31)], SECRETARY))[0].includes('30文字まで'));
  L.close();
});

test('files: uploaded first, then sent with one message of the person\'s, once; a message of files alone takes their names', () => {
  const L = openLedger(':memory:', { now: ticking() });
  const main = L.ensureThread('secretary', WEB);
  const a = L.addAttachment({ name: '時間割.png', type: 'image/png', size: 240 * 1024, sha256: SHA }, WEB);
  const b = L.addAttachment({ name: 'メモ.txt', type: 'text/plain', size: 10, sha256: SHA }, WEB);
  const m = L.addMessage(main.id, { role: 'user', body: 'この予定を入れて', attachments: [a.id, b.id] }, WEB);
  assert.deepEqual(m.data.attachments, [
    { id: a.id, name: '時間割.png', type: 'image/png', size: 240 * 1024 },
    { id: b.id, name: 'メモ.txt', type: 'text/plain', size: 10 },
  ]);
  assert.equal(L.getAttachment(a.id).message_id, m.id);
  assert.deepEqual(L.records(a.id).map((r) => r.action), ['create', 'send']);
  assert.deepEqual(problemsOf(() => L.addMessage(main.id, { role: 'user', body: 'もう一度', attachments: [a.id] }, WEB)), ['時間割.png はもう送ってあります']);
  const c = L.addAttachment({ name: 'only.pdf', type: 'application/pdf', size: 5, sha256: SHA }, WEB);
  const files = L.addMessage(main.id, { role: 'user', body: '', attachments: [c.id] }, WEB);
  assert.deepEqual([files.body, files.data.files_only], ['only.pdf', true]);
  assert.ok(problemsOf(() => L.addMessage(main.id, { role: 'secretary', body: 'x', attachments: [] }, SECRETARY)).includes('ファイルを添えられるのは本人のメッセージだけです'));
  assert.ok(problemsOf(() => L.addAttachment({ name: '../x', type: 'text/plain', size: 1, sha256: SHA }, WEB))[0].includes('/ や制御文字'));
  assert.ok(problemsOf(() => L.addAttachment({ name: 'x', type: 'bad', size: -1, sha256: 'z' }, WEB)).length === 3);
  L.close();
});

test('the ask and reply_options tools write as the calling device, in the thread the run names', async (t) => {
  const ledger = openLedger(':memory:', { now: ticking() });
  const key = ledger.issueKey('secretary', { actor: 'cli' }).key;
  const server = createServer({ ledger });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const clients = [];
  t.after(async () => {
    for (const c of clients) await c.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    ledger.close();
  });
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const main = ledger.ensureThread('secretary', WEB);
  const m = ledger.addMessage(main.id, { role: 'secretary', body: '元の発言' }, SECRETARY);
  const sub = ledger.openThread(m.id, WEB);
  const connect = async (headers) => {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${key}`, ...headers } } }));
    clients.push(client);
    return client;
  };
  const plain = await connect({});
  const out = await plain.callTool({ name: 'ask', arguments: { questions: [Q({ kind: 'close_forgotten' })] } });
  assert.equal(out.isError, undefined);
  assert.equal(out.structuredContent.thread_id, main.id);
  assert.equal(out.structuredContent.device, 'secretary');
  const bad = await plain.callTool({ name: 'ask', arguments: { questions: [{ header: 'x', question: 'y', options: [] }] } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /選択肢\(options\)は2〜4個です/);

  const inThread = await connect({ 'X-Warifuri-Thread': sub.id });
  const asked = await inThread.callTool({ name: 'ask', arguments: { questions: [Q()] } });
  assert.equal(asked.structuredContent.thread_id, sub.id);
  const buttons = await inThread.callTool({ name: 'reply_options', arguments: { options: ['スレッドで話す', 'ここで続ける'] } });
  assert.deepEqual(buttons.structuredContent, { thread: sub.id, options: ['スレッドで話す', 'ここで続ける'] });
  assert.equal(ledger.getThread(main.id).pending_options, null);
  // A header naming no thread falls back to the secretary's conversation.
  const stray = await connect({ 'X-Warifuri-Thread': 'c_20261001000000_zzzzzz' });
  await stray.callTool({ name: 'reply_options', arguments: { options: ['はい'] } });
  assert.equal(ledger.getThread(main.id).pending_options, '["はい"]');
});

test('the secretary\'s tools answer only the secretary\'s device, and nobody while the secretary is off; board says which', async (t) => {
  const ledger = openLedger(':memory:', { now: ticking() });
  const keys = { secretary: ledger.issueKey('secretary', { actor: 'cli' }).key, laptop: ledger.issueKey('laptop', { actor: 'cli' }).key };
  const clients = [];
  const servers = [];
  t.after(async () => {
    for (const c of clients) await c.close();
    for (const s of servers) {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
    ledger.close();
  });
  const start = async (secretaryDevice) => {
    const server = createServer({ ledger, secretaryDevice });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    servers.push(server);
    return async (device) => {
      const client = new Client({ name: 'test', version: '0' });
      const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${keys[device]}` } } }));
      clients.push(client);
      return client;
    };
  };
  const on = await start('secretary');
  const laptop = await on('laptop');
  const refused = await laptop.callTool({ name: 'ask', arguments: { questions: [Q()] } });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /ask は秘書だけが使えるツールです/);
  for (const name of ['report', 'propose', 'proposal_done', 'reply_options', 'autonomy_outcome', 'autonomy_set']) {
    const out = await laptop.callTool({ name, arguments: {} });
    assert.equal(out.isError, true, name);
  }
  assert.equal((await laptop.callTool({ name: 'board', arguments: {} })).structuredContent.secretary, 'on');
  // Reading what the secretary wrote stays open to every device.
  assert.equal((await laptop.callTool({ name: 'reports', arguments: {} })).isError, undefined);
  const secretary = await on('secretary');
  assert.equal((await secretary.callTool({ name: 'ask', arguments: { questions: [Q()] } })).isError, undefined);

  const off = await start(null);
  const anyone = await off('secretary');
  assert.match((await anyone.callTool({ name: 'reply_options', arguments: { options: ['はい'] } })).content[0].text, /秘書が有効になっていないので/);
  assert.equal((await anyone.callTool({ name: 'board', arguments: {} })).structuredContent.secretary, 'off');
});

test('while the secretary runs, only it books; the others ask it with ask_secretary, and get its reply', async (t) => {
  const ledger = openLedger(':memory:', { now: ticking() });
  const keys = { secretary: ledger.issueKey('secretary', { actor: 'cli' }).key, laptop: ledger.issueKey('laptop', { actor: 'cli' }).key };
  const clients = [];
  const servers = [];
  t.after(async () => {
    for (const c of clients) await c.close();
    for (const s of servers) {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
    ledger.close();
  });
  const asked = [];
  const chat = (on, reply) => ({
    on,
    request: async (fields, writer, opts) => {
      asked.push({ fields, writer, opts });
      return reply === 'late' ? { request: { id: 'm_1' }, timedOut: true } : { request: { id: 'm_1' }, reply: { body: reply } };
    },
  });
  const start = async (options) => {
    const server = createServer({ ledger, ...options });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    servers.push(server);
    return async (device) => {
      const client = new Client({ name: 'test', version: '0' });
      const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${keys[device]}` } } }));
      clients.push(client);
      return client;
    };
  };
  const slot = { kind: 'fixed', title: '打ち合わせ', starts_at: '2026-10-30T10:00:00+09:00', ends_at: '2026-10-30T11:00:00+09:00' };

  const on = await start({ secretaryDevice: 'secretary', chat: chat(true, '金曜の10時に入れました') });
  const laptop = await on('laptop');
  for (const [name, args] of [['book', slot], ['unbook', { id: 'b_x' }]]) {
    const out = await laptop.callTool({ name, arguments: args });
    assert.equal(out.isError, true, name);
    assert.match(out.content[0].text, /予定は秘書が決めます.*ask_secretary/);
  }
  const secretary = await on('secretary');
  assert.equal((await secretary.callTool({ name: 'book', arguments: slot })).isError, undefined);
  assert.match((await secretary.callTool({ name: 'ask_secretary', arguments: { text: 'x' } })).content[0].text, /秘書は自分に頼めません/);

  const answered = await laptop.callTool({ name: 'ask_secretary', arguments: { text: '資料作り', task_id: 't_1', minutes: 120, prefer: '午前', wait_seconds: 30 } });
  assert.deepEqual(answered.structuredContent, { status: 'answered', request_id: 'm_1', reply: '金曜の10時に入れました' });
  assert.deepEqual(asked[0].fields, { from: 'laptop', text: '資料作り', task_id: 't_1', minutes: 120, prefer: '午前' });
  assert.equal(asked[0].writer.device, 'laptop');
  assert.equal(asked[0].opts.waitMs, 30_000);

  const late = await (await (await start({ secretaryDevice: 'secretary', chat: chat(true, 'late') }))('laptop')).callTool({ name: 'ask_secretary', arguments: { text: '2時間' } });
  assert.equal(late.structuredContent.status, 'waiting');
  assert.equal(asked[1].opts.waitMs, 120_000);

  // A secretary that cannot answer (claude missing, turned off): anyone books, nobody asks.
  for (const options of [{ secretaryDevice: 'secretary', chat: chat(false) }, { secretaryDevice: null }]) {
    const c = await (await start(options))('laptop');
    assert.equal((await c.callTool({ name: 'book', arguments: slot })).isError, undefined);
    assert.match((await c.callTool({ name: 'ask_secretary', arguments: { text: '2時間' } })).content[0].text, /秘書が有効になっていないので、頼めません/);
    assert.equal((await c.callTool({ name: 'board', arguments: {} })).structuredContent.secretary, 'off');
  }

  // GET /api/secretary says the same, to the calendar hook, with a device key only.
  const api = async (options, key = keys.laptop) => {
    const server = createServer({ ledger, ...options });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    servers.push(server);
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/secretary`, { headers: { Authorization: `Bearer ${key}` } });
    return { status: res.status, body: res.status === 200 ? await res.json() : null };
  };
  assert.deepEqual(await api({ secretaryDevice: 'secretary', chat: chat(true) }), { status: 200, body: { secretary: 'on' } });
  assert.deepEqual(await api({ secretaryDevice: 'secretary', chat: chat(false) }), { status: 200, body: { secretary: 'off' } });
  assert.deepEqual(await api({ secretaryDevice: null }), { status: 200, body: { secretary: 'off' } });
  assert.equal((await api({ secretaryDevice: 'secretary' }, 'wf_wrong')).status, 401);
});
