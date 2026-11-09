// The secretary's tidying of a profile's knowledge (原則22): sorting the inbox into the
// knowledge, splitting a long knowledge.md by topic into knowledge/, and marking what has gone
// stale with the date it was valid until.
//
// A file is read as entries: a list item ("- " or "* " at the start of a line, with the
// indented lines under it), a heading ("#"), or a paragraph (lines up to a blank one). Each
// entry has an id made from its text, so a caller names what it read, not a line number that
// a note appended in between could shift. Entries with the same text share an id; naming it
// twice takes the next one.
//
// These change files the person and agents write to, so every change is all or nothing:
// any problem refuses the whole call and nothing is written. Files are replaced whole
// (written beside and renamed), never opened by a path a caller gave.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LedgerError } from '../ledger/ledger.mjs';
import { profileDir, checkNoteText, MARK_UNCONFIRMED } from './profiles.mjs';

// The line count past which knowledge.md is split (the docs' "about 200 lines").
export const SPLIT_LINES = 200;
// The largest file these tools rewrite; a bigger one is left to the person.
export const MAX_TIDY_BYTES = 1024 * 1024;
// The mark of an entry no longer true, followed by the date it was valid until.
export const MARK_STALE = '古い';

const TOPIC = /^knowledge\/([^/]+)\.md$/u;
// Characters a topic's file name may not have: the ones a disk refuses, and %.
const UNSAFE = /[<>:"/\\|?*%\u0000-\u001f\u007f]/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const localDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const entryId = (text) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);

// The entries of a text: [{ id, kind (item, heading, text), start, end (line indexes, end
// exclusive), text }].
export function parseEntries(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const entries = [];
  const isItem = (l) => /^[-*] /.test(l);
  const isHeading = (l) => l.startsWith('#');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    const start = i;
    let kind;
    if (isItem(line)) {
      kind = 'item';
      i += 1;
      while (i < lines.length && /^\s+\S/.test(lines[i])) i += 1;
    } else if (isHeading(line)) {
      kind = 'heading';
      i += 1;
    } else {
      kind = 'text';
      i += 1;
      while (i < lines.length && lines[i].trim() !== '' && !isItem(lines[i]) && !isHeading(lines[i])) i += 1;
    }
    const body = lines.slice(start, i).join('\n');
    entries.push({ id: entryId(body), kind, start, end: i, text: body });
  }
  return { lines, entries };
}

// The lines left when some entries are taken out: runs of blank lines become one, and blank
// lines at the start and the end go.
function withoutEntries(lines, taken) {
  const drop = new Set();
  for (const e of taken) for (let i = e.start; i < e.end; i += 1) drop.add(i);
  const out = [];
  for (const [i, line] of lines.entries()) {
    if (drop.has(i)) continue;
    if (line.trim() === '' && (out.length === 0 || out.at(-1).trim() === '')) continue;
    out.push(line);
  }
  while (out.length && out.at(-1).trim() === '') out.pop();
  return out;
}

const joinLines = (lines) => (lines.length ? `${lines.join('\n')}\n` : '');

// A file of the profile as text ('' when absent), refused past MAX_TIDY_BYTES.
function readWhole(file, name) {
  let size;
  try {
    ({ size } = fs.statSync(file));
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
  if (size > MAX_TIDY_BYTES) {
    throw new LedgerError([`${name} は ${MAX_TIDY_BYTES / 1024 / 1024} MiB を超えているので、ツールでは書き換えません。人が直します`]);
  }
  return fs.readFileSync(file, 'utf8');
}

// Replaces a file whole: written beside it, then renamed over it.
function replaceFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Text with an entry added at the end, after a blank line when the last entry or the new one
// is not a list item (so a paragraph does not run into it).
function appended(text, entry) {
  const { lines, entries } = parseEntries(text);
  const kept = [...lines];
  while (kept.length && kept.at(-1).trim() === '') kept.pop();
  if (kept.length === 0) return `${entry.text}\n`;
  const gap = entries.at(-1)?.kind !== 'item' || entry.kind !== 'item';
  return `${kept.join('\n')}\n${gap ? '\n' : ''}${entry.text}\n`;
}

// The entries named by ids, each taken once in the order of the file; problems for ids not
// found (or named more times than the file has them).
function take(entries, ids, used, problems, name) {
  const out = [];
  for (const id of ids) {
    const e = entries.find((x) => x.id === id && !used.has(x));
    if (!e) {
      problems.push(`${name} に id ${id} の項目がありません(もう動かしたか、書き換わっています)。もう一度読み直して、返った id を渡します`);
      continue;
    }
    used.add(e);
    out.push(e);
  }
  return out;
}

// The checked name of a topic file in knowledge/ (such as knowledge/提出.md), or a problem.
export function topicName(value) {
  const m = typeof value === 'string' ? TOPIC.exec(value.normalize('NFC')) : null;
  const base = m?.[1];
  if (!base || UNSAFE.test(base) || base.startsWith('.') || base.trim() !== base || base === '') {
    return { problem: `${value} は話題のファイルの名前にできません。knowledge/<話題>.md の形で、話題には / \\ : * ? " < > | % と先頭の . を使いません` };
  }
  return { name: `knowledge/${base}.md` };
}

// The entries of one of the profile's files, for a caller to name by id: inbox.md,
// knowledge.md, people.md or a knowledge/<topic>.md.
export function listEntries(home, profile, name) {
  const dir = profileDir(home, profile);
  const file = fileOf(dir, name);
  const text = readWhole(file, name);
  const { lines, entries } = parseEntries(text);
  return {
    profile,
    file: name,
    lines: lines.length,
    entries: entries.map(({ id, kind, text: t }) => ({ id, kind, text: t })),
  };
}

function fileOf(dir, name) {
  if (['inbox.md', 'knowledge.md', 'people.md'].includes(name)) return path.join(dir, name);
  const t = topicName(name);
  if (t.problem) throw new LedgerError([t.problem]);
  return path.join(dir, t.name);
}

// The body of an inbox entry without its list mark and date: "- 2026-11-01 text (laptop)" →
// "text (laptop)", later lines unindented.
function inboxBody(entry) {
  return entry.text
    .replace(/^[-*] /, '')
    .replace(/^\d{4}-\d{2}-\d{2} /, '')
    .split('\n')
    .map((l, i) => (i === 0 ? l : l.replace(/^ {1,2}/, '')))
    .join('\n');
}

// Sorts the inbox. moves: [{ entries: [id], to, text?, checked?, reason?, person? }]. to is
// 'knowledge' (knowledge.md), 'people' (a fact about a person, handed to toPeople, which puts it
// in the ledger's people; person names who), a 'knowledge/<topic>.md', or 'drop' (left
// out, with a reason). The entry written is "- <date> 「未確認」 <text> (<device> / 受信箱から)";
// text is the wording to keep (needed when several entries are merged into one; one entry
// alone keeps its own words and source), and checked: true leaves out 未確認 for what was
// confirmed. The entries named leave the inbox; the rest stay. Returns what went where.
export function sortInbox(home, profile, { moves, device, toPeople = null, now = new Date() }) {
  const dir = profileDir(home, profile);
  const inboxFile = path.join(dir, 'inbox.md');
  const { lines, entries } = parseEntries(readWhole(inboxFile, 'inbox.md'));
  const problems = [];
  if (!Array.isArray(moves) || moves.length === 0) problems.push('moves に、動かす項目を1つ以上渡します');
  const used = new Set();
  const plan = [];
  for (const [i, move] of (Array.isArray(moves) ? moves : []).entries()) {
    const at = `moves[${i}]`;
    const ids = Array.isArray(move?.entries) ? move.entries : [];
    if (ids.length === 0) problems.push(`${at}: entries に受信箱の項目の id を1つ以上渡します`);
    const taken = take(entries, ids, used, problems, 'inbox.md');
    let target = null;
    if (move?.to === 'knowledge') target = 'knowledge.md';
    else if (move?.to === 'people') {
      if (!toPeople) problems.push(`${at}: 人に移す先がありません`);
      target = 'people';
    }
    else if (move?.to === 'drop') {
      if (typeof move.reason !== 'string' || move.reason.trim() === '') problems.push(`${at}: 外す(drop)ときは、理由(reason)を書きます`);
    } else {
      const t = topicName(move?.to);
      if (t.problem) problems.push(`${at}: to は knowledge、people、knowledge/<話題>.md、drop のどれかです(${t.problem})`);
      else target = t.name;
    }
    let text = null;
    if (target) {
      if (move.text !== undefined) {
        const p = checkNoteText(move.text);
        if (p.length) problems.push(...p.map((x) => `${at}: ${x}`));
        else text = move.text.trim().replace(/\r\n?/g, '\n');
      } else if (taken.length > 1) {
        problems.push(`${at}: 2件以上をまとめるときは、まとめた文(text)を渡します`);
      }
    }
    plan.push({ taken, target, text, checked: move?.checked === true, reason: move?.reason?.trim?.() ?? null, person: move?.person });
  }
  if (problems.length) throw new LedgerError(problems);

  const date = localDate(now);
  const writes = new Map(); // target → text
  const done = [];
  // People first: a refusal there (an unknown person, a number not kept) leaves every file as it was.
  for (const step of plan.filter((x) => x.target === 'people')) {
    const body = step.text !== null ? step.text : inboxBody(step.taken[0]);
    const m = /\s\(([^()]*)\)$/.exec(body);
    const text = step.text !== null || !m ? body : body.slice(0, m.index);
    const source = step.text !== null ? `${device} / 受信箱から` : (m ? `${m[1]} / 受信箱から` : `${device} / 受信箱から`);
    const out = toPeople({ text, mark: step.checked ? null : MARK_UNCONFIRMED, source, person: step.person });
    step.done = { to: 'people', entries: step.taken.map((e) => e.id), fact: out.fact, person: out.person, from: step.taken.map((e) => e.text) };
  }
  for (const step of plan) {
    if (step.target === 'people') done.push(step.done);
    else if (step.target) {
      const mark = step.checked ? '' : ` 「${MARK_UNCONFIRMED}」`;
      const body = step.text !== null ? `${step.text} (${device} / 受信箱から)` : inboxBody(step.taken[0]);
      const entryText = `- ${date}${mark} ${body.split('\n').join('\n  ')}`;
      const file = path.join(dir, step.target);
      const before = writes.has(step.target) ? writes.get(step.target) : readWhole(file, step.target);
      writes.set(step.target, appended(before, { kind: 'item', text: entryText }));
      done.push({ to: step.target, entries: step.taken.map((e) => e.id), entry: entryText, from: step.taken.map((e) => e.text) });
    } else {
      done.push({ to: 'drop', entries: step.taken.map((e) => e.id), reason: step.reason, from: step.taken.map((e) => e.text) });
    }
  }
  for (const [target, text] of writes) replaceFile(path.join(dir, target), text);
  const left = withoutEntries(lines, [...used]);
  replaceFile(inboxFile, joinLines(left));
  return { profile, moved: done, inbox_left: parseEntries(joinLines(left)).entries.length };
}

// Splits knowledge.md: moves: [{ entries: [id], to: 'knowledge/<topic>.md' }]. The entries go
// as they are, in the order of the file, to the end of the topic's file, and leave
// knowledge.md. Returns what went where and the lines left.
export function splitKnowledge(home, profile, { moves }) {
  const dir = profileDir(home, profile);
  const file = path.join(dir, 'knowledge.md');
  const { lines, entries } = parseEntries(readWhole(file, 'knowledge.md'));
  const problems = [];
  if (!Array.isArray(moves) || moves.length === 0) problems.push('moves に、分ける項目と行き先を1つ以上渡します');
  const used = new Set();
  const plan = [];
  for (const [i, move] of (Array.isArray(moves) ? moves : []).entries()) {
    const at = `moves[${i}]`;
    const ids = Array.isArray(move?.entries) ? move.entries : [];
    if (ids.length === 0) problems.push(`${at}: entries に knowledge.md の項目の id を1つ以上渡します`);
    const taken = take(entries, ids, used, problems, 'knowledge.md');
    const t = topicName(move?.to);
    if (t.problem) problems.push(`${at}: ${t.problem}`);
    plan.push({ taken: taken.sort((a, b) => a.start - b.start), to: t.name });
  }
  if (problems.length) throw new LedgerError(problems);

  const writes = new Map();
  for (const step of plan) {
    let text = writes.has(step.to) ? writes.get(step.to) : readWhole(path.join(dir, step.to), step.to);
    for (const e of step.taken) text = appended(text, e);
    writes.set(step.to, text);
  }
  for (const [to, text] of writes) replaceFile(path.join(dir, to), text);
  const left = withoutEntries(lines, [...used]);
  replaceFile(file, joinLines(left));
  return {
    profile,
    moved: plan.map((s) => ({ to: s.to, entries: s.taken.map((e) => e.id), from: s.taken.map((e) => e.text) })),
    knowledge_lines: left.length,
  };
}

// Marks entries no longer true: marks: [{ id, until (YYYY-MM-DD), why? }]. Each list item named
// gets a line under it, "  「古い」 <until> まで有効。<why>"; the entry itself stays, so what was
// true before can still be read. file: knowledge.md, people.md or a knowledge/<topic>.md.
export function markStale(home, profile, { file: name = 'knowledge.md', marks }) {
  const dir = profileDir(home, profile);
  if (!['knowledge.md', 'people.md'].includes(name) && topicName(name).problem) {
    throw new LedgerError([`file は knowledge.md、people.md、knowledge/<話題>.md のどれかです(${name})`]);
  }
  const file = fileOf(dir, name);
  const { lines, entries } = parseEntries(readWhole(file, name));
  const problems = [];
  if (!Array.isArray(marks) || marks.length === 0) problems.push('marks に、古い印を付ける項目を1つ以上渡します');
  const used = new Set();
  const plan = [];
  for (const [i, m] of (Array.isArray(marks) ? marks : []).entries()) {
    const at = `marks[${i}]`;
    const [e] = take(entries, [m?.id], used, problems, name);
    if (typeof m?.until !== 'string' || !DATE.test(m.until) || Number.isNaN(Date.parse(`${m.until}T00:00:00Z`))) {
      problems.push(`${at}: until に、いつまで有効だったかを YYYY-MM-DD で渡します`);
    }
    if (m?.why !== undefined && (typeof m.why !== 'string' || m.why.includes('\n') || [...m.why].length > 200)) {
      problems.push(`${at}: why は200文字までの1行です`);
    }
    if (e && e.kind !== 'item') problems.push(`${at}: 古い印は箇条(- で始まる項目)にだけ付けます`);
    else if (e && e.text.includes(`「${MARK_STALE}」`)) problems.push(`${at}: この項目には、もう古い印が付いています`);
    if (e) plan.push({ e, line: `  「${MARK_STALE}」 ${m.until} まで有効。${m.why?.trim() ? m.why.trim() : ''}`.trimEnd() });
  }
  if (problems.length) throw new LedgerError(problems);

  const after = new Map(plan.map((p) => [p.e.end - 1, p.line]));
  const out = [];
  for (const [i, line] of lines.entries()) {
    out.push(line);
    if (after.has(i)) out.push(after.get(i));
  }
  replaceFile(file, joinLines(out));
  return { profile, file: name, marked: plan.map((p) => ({ id: p.e.id, text: p.e.text, line: p.line })) };
}
