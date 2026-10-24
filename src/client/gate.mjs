// The start gate: a PreToolUse hook for Claude Code and Codex. Before a file is edited inside
// a registered place, this device must hold a task there (`start` through the MCP tools).
//
// The hook gets the harness's JSON on stdin ({ tool_name, tool_input, cwd, ... }; both
// harnesses use this shape) and asks the server, with this machine's device key,
//   GET <url>/api/held?dir=<directory of the file>  ->  { task, place }
// A held task: allow. No place for the directory: allow (not a managed place). A place and no
// held task: deny, telling the agent to search, create_task and start. Allowing prints
// nothing; denying prints the PreToolUse deny JSON.
//
// Fail-open by design: no settings, no key, a payload it cannot read, the server unreachable,
// slow (3 seconds) or answering anything but 200, all allow. A network problem or a bug here
// must never stop editing. The key is sent in a header and never printed.

import fs from 'node:fs';
import path from 'node:path';

// The tools that edit files: Claude Code's, and Codex's apply_patch.
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']);
export const TIMEOUT_MS = 3000;
const MAX_DIRS = 8;

// The files a patch of Codex's apply_patch touches, as written in it (often relative).
export function patchFiles(patch) {
  if (typeof patch !== 'string') return [];
  const out = [];
  for (const line of patch.split(/\r?\n/)) {
    const m = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}

// The nearest directory that exists: dir itself, or the closest parent that does. A new file
// in a new directory is asked about where it will be, not where the session started.
function existingDir(dir, exists) {
  let d = dir;
  for (;;) {
    if (exists(d)) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

// The directories to ask about for one tool call: each edited file's directory (or its
// nearest existing parent), only absolute ones, relative paths read from the session's cwd.
export function dirsToAsk(payload, { exists = (d) => fs.existsSync(d) } = {}) {
  if (!payload || typeof payload !== 'object' || !EDIT_TOOLS.has(payload.tool_name)) return [];
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const cwd = typeof payload.cwd === 'string' && path.isAbsolute(payload.cwd) ? payload.cwd : null;
  let files;
  if (payload.tool_name === 'apply_patch') files = patchFiles(input.command ?? input.patch ?? input.input);
  else files = [input.file_path ?? input.notebook_path ?? input.path].filter((f) => typeof f === 'string' && f !== '');
  const dirs = [];
  for (const f of files) {
    const abs = path.isAbsolute(f) ? f : cwd ? path.resolve(cwd, f) : null;
    if (!abs) continue;
    const dir = existingDir(path.dirname(abs), exists) ?? cwd;
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  }
  return dirs.slice(0, MAX_DIRS);
}

// The reason shown to the agent when it is stopped.
export function denyReason(place, dir) {
  const name = place?.name ?? '';
  const profile = place?.profile ? `(プロフィール ${place.profile})` : '';
  return (
    `warifuri の着手ゲート: 作業フォルダ「${name}」${profile}で、このデバイスで作業中のタスクがありません。` +
    `編集の前に、MCP の warifuri で (1) search で同じタスクがないかを探し、(2) なければ create_task で作り、` +
    `(3) start に task_id と place="${dir}" を渡して着手してください。着手したら、編集をやり直してください。`
  );
}

export function denyOutput(reason) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  });
}

// Asks the server about one directory: { place, task } or null when anything goes wrong.
async function askHeld({ url, key, dir, fetchImpl, signal }) {
  try {
    const res = await fetchImpl(`${url.replace(/\/+$/, '')}/api/held?dir=${encodeURIComponent(dir)}`, {
      headers: { authorization: `Bearer ${key}` },
      signal,
    });
    if (res.status !== 200) return null;
    const body = await res.json();
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

// The decision for one payload: the deny JSON text, or null to allow.
// settings: { url, key, gate } (gate 'off' allows everything).
export async function decide(payload, { url, key, gate = 'on' }, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS, exists } = {}) {
  if (gate === 'off' || !url || !key) return null;
  const dirs = dirsToAsk(payload, exists ? { exists } : {});
  if (dirs.length === 0) return null;
  const signal = AbortSignal.timeout(timeoutMs);
  const answers = await Promise.all(dirs.map((dir) => askHeld({ url, key, dir, fetchImpl, signal })));
  for (let i = 0; i < dirs.length; i++) {
    const a = answers[i];
    if (a && a.place && !a.task) return denyOutput(denyReason(a.place, dirs[i]));
  }
  return null;
}

// The device key in a key file: its first line, trimmed, or null.
export function readKey(file) {
  try {
    const key = fs.readFileSync(file, 'utf8').split(/\r?\n/)[0].trim();
    return key === '' ? null : key;
  } catch {
    return null;
  }
}
