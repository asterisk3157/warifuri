// The write-it-down check, part of the Stop hook (`warifuri hook stop`). When the person's last
// message in the conversation talks about a date or a deadline ("金曜まで", "締切", "11/20",
// "来週") and the agent has not written to warifuri since (create_task, update, note, close
// and the other writing tools), the agent is asked once to put what was decided in the ledger.
//
// It reads the conversation from the transcript the harness names (Claude Code's Stop gives
// transcript_path, a JSONL file). Only Claude Code's lines are read: { type: "user" | "assistant",
// message: { content } }. A transcript in any other shape (Codex's rollout files), one it cannot
// read, or one too long to find the last message in, says nothing, and the stop goes through.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Only the end of the transcript is read, so a long conversation does not slow the hook.
export const TAIL_BYTES = 4 * 1024 * 1024;

// warifuri's tools that write to the ledger. The tool's name in Claude Code is
// mcp__<server>__<tool>; the server is named warifuri, or something that contains it.
export const WRITE_TOOLS = new Set([
  'create_goal', 'create_task', 'update', 'close', 'note', 'person', 'reopen', 'resume',
  'defer', 'wait', 'book', 'ask_secretary', 'habit',
]);

export function isLedgerWrite(name) {
  if (typeof name !== 'string') return false;
  const m = /^mcp__(.+)__([a-z_]+)$/.exec(name);
  return Boolean(m && /warifuri/i.test(m[1]) && WRITE_TOOLS.has(m[2]));
}

// Words that say a date or a deadline. The text is NFKC-normalised first, so full-width digits
// and slashes count. Bare "まで" ("ここまで", "今まで") does not count; "までに" and
// "<日・曜・時・週・月・末>まで" do.
const DATE_WORDS = [
  /締め?切|〆切|期限|期日|納期|までに/,
  /(?:日|曜|時|週|月|末|年|内|中)まで/,
  /明日|明後日|あさって|今日中|今週|来週|再来週|今月|来月|再来月|週明け|週末|月末|年内|年度内/,
  /[月火水木金土日]曜/,
  /\d{1,2}\s*\/\s*\d{1,2}(?!\d)/,
  /\d{4}-\d{1,2}-\d{1,2}/,
  /\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}\s*日(?:まで|に|中|締|〆|の)/,
  /\b(?:deadline|due|tomorrow|tonight|next\s+(?:week|month)|by\s+(?:mon|tue|wed|thu|fri|sat|sun)\w*|(?:mon|tues|wednes|thurs|fri|satur|sun)day)\b/i,
];

export function hasDateWords(text) {
  if (typeof text !== 'string' || text === '') return false;
  const t = text.normalize('NFKC');
  return DATE_WORDS.some((re) => re.test(t));
}

// What the harness added to a message (reminders, command output) is not the person's words.
const ADDED = /<(system-reminder|local-command-stdout|local-command-stderr|command-name|command-message|command-args)>[\s\S]*?<\/\1>/g;

function sayingText(line) {
  if (line?.type !== 'user' || line.isMeta === true || line.isSidechain === true) return null;
  const content = line.message?.content;
  let text = null;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    // A line of tool results is the harness answering a tool, not the person.
    const texts = content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text);
    if (texts.length === 0) return null;
    text = texts.join('\n');
  }
  if (text === null) return null;
  text = text.replace(ADDED, '').trim();
  // A Stop hook's reason, given back to the agent, is not the person either.
  if (text === '' || text.startsWith('Stop hook feedback')) return null;
  return text;
}

function toolNames(line) {
  if (line?.type !== 'assistant' || !Array.isArray(line.message?.content)) return [];
  return line.message.content.filter((b) => b?.type === 'tool_use').map((b) => b.name);
}

// From the transcript's lines (parsed), the person's last message and whether warifuri was
// written to after it: { id, text, wrote } or null when there is no message to look at.
export function lastSaying(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const text = sayingText(lines[i]);
    if (text === null) continue;
    const wrote = lines.slice(i + 1).some((l) => toolNames(l).some(isLedgerWrite));
    const id = typeof lines[i].uuid === 'string' && lines[i].uuid !== ''
      ? lines[i].uuid
      : crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
    return { id, text, wrote };
  }
  return null;
}

// The parsed lines at the end of the transcript file, or null when it cannot be read.
export function readTail(file, bytes = TAIL_BYTES) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    // Reading from the middle: the first line is cut, so it is dropped.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    const lines = [];
    for (const l of text.split('\n')) {
      if (l.trim() === '') continue;
      try {
        lines.push(JSON.parse(l));
      } catch {
        // a line it cannot read is skipped
      }
    }
    return lines;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The person's last message, when it talks about a date and nothing was written since:
// { id, text }. Anything else, null.
export function unrecorded(transcriptPath) {
  const lines = readTail(transcriptPath);
  if (!lines) return null;
  const say = lastSaying(lines);
  if (!say || say.wrote || !hasDateWords(say.text)) return null;
  return { id: say.id, text: say.text };
}

export const CAPTURE_REASON =
  'warifuri の台帳の確認: この会話で出た締切や決定で、まだ台帳にないものがあれば書いてください' +
  '(締切は create_task か update の due、方針や決まりは note、終わったことは close)。' +
  'なければそのまま終えてください。';
