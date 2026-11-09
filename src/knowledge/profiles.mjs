// A profile's knowledge, as files in the data directory (原則20, 21, 22):
//
//   <home>/profiles/<folder>/people.md        the people of this area
//                            knowledge.md     rules and facts
//                            knowledge/*.md   knowledge split by topic
//                            procedures/*.md  one procedure per file
//                            inbox.md         agents' notes, until the secretary sorts them
//
// The folder is the profile's name made safe for a file name on Windows, macOS and Linux
// (profileFolder below). context reads the files; note appends to them and never rewrites
// what is there. Nothing here opens a path given by a caller: a file asked for by name is
// looked up among the files that are listed.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LedgerError } from '../ledger/ledger.mjs';

export const PROFILES_DIR = 'profiles';
export const FOLDERS = ['knowledge', 'procedures'];

// Caps. A file is returned up to MAX_FILE_BYTES (the rest is cut, and truncated is set); a
// folder lists up to MAX_LIST names; a note is at most MAX_NOTE_CHARS; the ledger's record
// of a note keeps the whole text up to RECORD_TEXT_CHARS, and past that the start, the
// length and a hash.
export const MAX_FILE_BYTES = 64 * 1024;
export const MAX_LIST = 200;
export const MAX_NOTE_CHARS = 4000;
export const RECORD_TEXT_CHARS = 1000;
const MAX_FOLDER_BYTES = 255;

// The marks a note carries in knowledge.md (原則22).
export const MARK_HUMAN = '本人の言葉';
export const MARK_UNCONFIRMED = '未確認';

// Windows reserves these names, with or without an extension, in any case.
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;
// Characters Windows does not allow in a name, the path separators, and % (the escape itself).
const UNSAFE = /[<>:"/\\|?*%\u0000-\u001f\u007f]/u;

const escapeChar = (ch) =>
  [...Buffer.from(ch, 'utf8')].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');

// The folder name of a profile. The name is put in NFC; then each character that is unsafe
// in a file name (< > : " / \ | ? * %, and control characters) is written as %XX of its
// UTF-8 bytes, as are a leading dot or space, a trailing dot or space, and the first letter
// of a name Windows reserves (CON, NUL, COM1, …). Everything else stays as it is, so
// Japanese names stay readable. Since % is always escaped, two names never share a folder,
// except names that differ only in letter case on a disk that ignores case.
export function profileFolder(name) {
  if (typeof name !== 'string' || name.trim() === '') throw new LedgerError(['プロフィールの名前がありません']);
  const chars = [...name.normalize('NFC')];
  const out = chars.map((ch, i) => {
    if (UNSAFE.test(ch)) return escapeChar(ch);
    if ((i === 0 || i === chars.length - 1) && (ch === '.' || ch === ' ')) return escapeChar(ch);
    return ch;
  });
  if (RESERVED.test(chars.join(''))) out[0] = escapeChar(chars[0]);
  const folder = out.join('');
  if (Buffer.byteLength(folder, 'utf8') > MAX_FOLDER_BYTES) {
    throw new LedgerError([`プロフィールの名前が長すぎます(フォルダの名前にすると ${MAX_FOLDER_BYTES} バイトまで)`]);
  }
  return folder;
}

// The profile's name back from its folder name.
export function profileName(folder) {
  return decodeURIComponent(folder);
}

// The profile's directory, checked to be directly inside <home>/profiles.
export function profileDir(home, name) {
  const base = path.resolve(home, PROFILES_DIR);
  const dir = path.join(base, profileFolder(name));
  if (path.dirname(dir) !== base) throw new LedgerError([`プロフィールの名前 ${name} はフォルダにできません`]);
  return dir;
}

// Up to MAX_FILE_BYTES of a file as text: { text, bytes, truncated }, or null when it is absent.
function readCapped(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
  try {
    const { size } = fs.fstatSync(fd);
    const buf = Buffer.alloc(Math.min(size, MAX_FILE_BYTES));
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    let text = buf.subarray(0, read).toString('utf8');
    const truncated = size > read;
    if (truncated) text = text.replace(/�+$/u, ''); // a character cut in the middle
    return { text, bytes: size, truncated };
  } finally {
    fs.closeSync(fd);
  }
}

// The regular files of a folder of the profile (hidden ones and links left out), in NFC and
// sorted: { names, onDisk (NFC name → name on disk), more (names past MAX_LIST) }.
function listFolder(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { names: [], onDisk: new Map(), more: 0 };
    throw err;
  }
  const onDisk = new Map(
    entries.filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => [e.name.normalize('NFC'), e.name]),
  );
  const names = [...onDisk.keys()].sort();
  return { names: names.slice(0, MAX_LIST), onDisk, more: Math.max(0, names.length - MAX_LIST) };
}

// What an agent reads before working in a profile: people.md, knowledge.md and inbox.md
// (null when absent; the inbox is for the secretary to sort), and the names in knowledge/ and procedures/ as "knowledge/<file>". With name (one
// of those names), that one file instead.
export function readContext(home, profile, { name } = {}) {
  const dir = profileDir(home, profile);
  if (name !== undefined) {
    const [folder, file, ...rest] = String(name).normalize('NFC').split('/');
    const listing = FOLDERS.includes(folder) && rest.length === 0 ? listFolder(path.join(dir, folder)) : null;
    if (!listing?.onDisk.has(file)) {
      throw new LedgerError([
        `${name} というファイルは、プロフィール ${profile} にありません。context で返る knowledge/ か procedures/ の名前を、そのまま渡します`,
      ]);
    }
    return { profile, name: `${folder}/${file}`, ...readCapped(path.join(dir, folder, listing.onDisk.get(file))) };
  }
  const listings = Object.fromEntries(FOLDERS.map((f) => [f, listFolder(path.join(dir, f))]));
  return {
    profile,
    folder: path.basename(dir),
    exists: fs.existsSync(dir),
    people: readCapped(path.join(dir, 'people.md')),
    knowledge: readCapped(path.join(dir, 'knowledge.md')),
    inbox: readCapped(path.join(dir, 'inbox.md')),
    files: Object.fromEntries(FOLDERS.map((f) => [f, listings[f].names.map((n) => `${f}/${n}`)])),
    more: Object.fromEntries(FOLDERS.map((f) => [f, listings[f].more])),
  };
}

// Is a secretary plug-in configured? Plug-ins are listed in <home>/plugins.yaml; the
// secretary is there when one line names it ("- secretary", "secretary:" or "name: secretary").
export function secretaryConfigured(home) {
  let text;
  try {
    text = fs.readFileSync(path.join(home, 'plugins.yaml'), 'utf8');
  } catch {
    return false;
  }
  return /^\s*(-\s*)?(name:\s*)?["']?secretary["']?\s*:?\s*(#.*)?$/m.test(text);
}

const localDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Problems with a note's text, in Japanese.
export function checkNoteText(text) {
  if (typeof text !== 'string' || text.trim() === '') return ['書く中身(text)が空です'];
  if ([...text].length > MAX_NOTE_CHARS) {
    return [`1回に書けるのは ${MAX_NOTE_CHARS} 文字までです。長いナレッジは、人が knowledge/ にファイルとして置きます`];
  }
  return [];
}

// Appends a note to the profile and says where it went. kind 'human': the person's own
// words, straight into knowledge.md marked 本人の言葉. kind 'agent': an agent's insight, into
// inbox.md when a secretary is configured, else into knowledge.md marked 未確認. people: it is
// about a person, so it goes straight to people.md (an agent's marked 未確認), never through the
// inbox: who someone is matters more seen at once than sorted later. sorted: the secretary
// writing what it has sorted, which goes where it belongs rather than back to the inbox. from ({ device, task }) is written after the
// text, so the secretary knows where it came from.
// The entry is one list item: "- <date> 「<mark>」 <text> (<from>)", later lines indented.
export function writeNote(home, profile, { text, kind, people = false, sorted = false, secretary = false, from = {}, now = new Date() }) {
  const problems = checkNoteText(text);
  if (!['human', 'agent'].includes(kind)) problems.push('kind は human(本人の言葉)か agent(エージェントの気づき)です');
  if (problems.length) throw new LedgerError(problems);
  const dir = profileDir(home, profile);
  const toInbox = kind === 'agent' && secretary && !sorted && !people;
  const file = toInbox ? 'inbox.md' : people ? 'people.md' : 'knowledge.md';
  const mark = kind === 'human' ? MARK_HUMAN : toInbox ? null : MARK_UNCONFIRMED;
  const body = text.trim().replace(/\r\n?/g, '\n').split('\n').join('\n  ');
  const source = [from.device, from.task].filter(Boolean).join(' / ');
  const entry = `- ${localDate(now)}${mark ? ` 「${mark}」` : ''} ${body}${source ? ` (${source})` : ''}\n`;

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, file);
  let lead = '';
  try {
    const { size } = fs.statSync(target);
    if (size > 0) {
      const fd = fs.openSync(target, 'r');
      try {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) lead = '\n';
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.appendFileSync(target, lead + entry, { encoding: 'utf8', mode: 0o600 });
  return { profile, file, mark, entry };
}

// The changes kept in the ledger's record of a note: the whole text when it is short, else
// its start, its length and a hash (the file has the rest).
export function noteRecordChanges({ kind, file, mark, text, from = {} }) {
  const t = text.trim();
  const chars = [...t];
  const kept = chars.length <= RECORD_TEXT_CHARS
    ? { text: t }
    : { excerpt: chars.slice(0, 200).join(''), chars: chars.length, sha256: createHash('sha256').update(t, 'utf8').digest('hex') };
  return { kind, file, mark, ...kept, ...(from.task ? { task: from.task } : {}) };
}

// A profile's defaults (原則8, 20), in profile.yaml: human_led (whether its goals are led by
// the person, the first value of a new goal's mark) and color (the dot of its schedule, read
// by the Web screens too). Only these two lines are read and written; other lines of the
// file stay as they are.
export const PROFILE_FIELDS = ['human_led', 'color'];
const COLOR = /^#[0-9a-fA-F]{6}$/;
const lineOf = (field) => new RegExp(`^${field}:\\s*("[^"]*"|'[^']*'|[^#\\s]*)\\s*(#.*)?$`);

// { human_led: true | false | null, color: '#rrggbb' | null } as profile.yaml says (null: not
// written there), and whether the file exists.
export function readProfileDefaults(home, profile) {
  const file = path.join(profileDir(home, profile), 'profile.yaml');
  let text = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
  }
  const lines = (text ?? '').split(/\r?\n/);
  const value = (field) => {
    for (const l of lines) {
      const m = lineOf(field).exec(l);
      if (m) return m[1].replace(/^["']|["']$/g, '');
    }
    return null;
  };
  const led = value('human_led');
  const color = value('color');
  return {
    exists: text !== null,
    human_led: led === 'true' ? true : led === 'false' ? false : null,
    color: color && COLOR.test(color) ? color.toLowerCase() : null,
  };
}

// Writes the fields given ({ human_led?: boolean | null, color?: '#rrggbb' | null }; null
// removes the line, so the default applies again) and returns the fields as written.
export function writeProfileDefaults(home, profile, fields) {
  const problems = [];
  const given = Object.keys(fields).filter((k) => fields[k] !== undefined);
  for (const k of Object.keys(fields)) if (!PROFILE_FIELDS.includes(k)) problems.push(`${k} はプロフィールの既定値にありません(human_led、color)`);
  if (given.length === 0) problems.push('直す既定値(human_led か color)を1つ以上渡します');
  if (fields.human_led != null && typeof fields.human_led !== 'boolean') problems.push('human_led は true か false です(null で既定に戻す)');
  if (fields.color != null && (typeof fields.color !== 'string' || !COLOR.test(fields.color))) problems.push('color は #rrggbb の形です(null で既定に戻す)');
  if (problems.length) throw new LedgerError(problems);
  const dir = profileDir(home, profile);
  const file = path.join(dir, 'profile.yaml');
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').split('\n');
    if (lines.at(-1) === '') lines.pop();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const field of given) {
    const v = fields[field];
    const line = v === null ? null : field === 'color' ? `color: "${v.toLowerCase()}"` : `human_led: ${v}`;
    const at = lines.findIndex((l) => lineOf(field).test(l));
    if (at >= 0) {
      if (line === null) lines.splice(at, 1);
      else lines[at] = line;
      lines = lines.filter((l, i) => i <= at || !lineOf(field).test(l));
    } else if (line !== null) {
      lines.push(line);
    }
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, lines.length ? `${lines.join('\n')}\n` : '', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  return readProfileDefaults(home, profile);
}

// The names of the profiles that have a folder in <home>/profiles, sorted.
export function profileFolders(home) {
  let entries;
  try {
    entries = fs.readdirSync(path.resolve(home, PROFILES_DIR), { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw err;
  }
  const names = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    try {
      names.push(profileName(e.name).normalize('NFC'));
    } catch {
      // A folder whose name is not one warifuri made: not a profile.
    }
  }
  return names.sort();
}
