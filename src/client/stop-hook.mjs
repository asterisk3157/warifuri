// The end-of-work reminder: a Stop hook for Claude Code (and Codex's Stop, which takes the same
// shape). When an agent is about to end its turn and this device still holds a task in the
// place the session works in, it is told once to close the task (done with a result) or
// release it (with next), before it ends.
//
// The hook gets the harness's JSON on stdin ({ session_id, cwd, stop_hook_active, ... }) and
// asks the server, as the start gate does, GET <url>/api/held?dir=<cwd>. A held task: block
// the stop once, with the reason telling what to do. Anything else: let the stop through.
//
// It asks only once per conversation and task: the session ids it has reminded are kept in a
// small file in the data directory. A stop that a Stop hook already sent back
// (stop_hook_active) is never sent back again, so the agent can always end its turn. An agent
// still working with the person may leave the task held; it is not asked again.
//
// Fail-open, like the start gate: no settings, no key, a payload it cannot read, the server
// unreachable, slow or answering anything but 200, all let the stop through.

import fs from 'node:fs';
import path from 'node:path';
import { askHeld, TIMEOUT_MS } from './gate.mjs';

export const STATE_FILE = 'stop-reminded.json';
// Reminders older than this are forgotten, and at most this many are kept.
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const KEEP_MAX = 500;

// The reason shown to the agent.
export function stopReason(task, place) {
  const name = place?.name ? `作業フォルダ「${place.name}」で、` : '';
  return (
    `warifuri のタスク確認: ${name}このデバイスはタスク「${task.title}」(${task.id})を持ったままです。` +
    `作業を終えるなら、終える前に、済んでいれば close に state: "done" と1行の result を、` +
    `途中なら release に次の一手を1行の next で渡してください。` +
    `本人と話しながらまだ続ける作業なら、そのままでかまいません。この会話では、もう聞きません。`
  );
}

export const stopOutput = (reason) => JSON.stringify({ decision: 'block', reason });

function readState(file) {
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return json && typeof json === 'object' && !Array.isArray(json) ? json : {};
  } catch {
    return {};
  }
}

// Has this conversation been reminded of this task? If not, remember that it now is.
// Without a file or a session id it cannot remember, and reminds (stop_hook_active still
// keeps it from asking twice in a row).
export function remindOnce(file, session, taskId, now = new Date()) {
  if (!file || !session) return true;
  const state = readState(file);
  const k = `${session} ${taskId}`;
  if (state[k]) return false;
  const cut = now.getTime() - KEEP_MS;
  const kept = Object.entries(state)
    .filter(([, at]) => Date.parse(at) >= cut)
    .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
    .slice(0, KEEP_MAX - 1);
  const out = Object.fromEntries([[k, now.toISOString()], ...kept]);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(out)}\n`, { mode: 0o600 });
  } catch {
    // cannot remember: remind anyway
  }
  return true;
}

// The decision for one payload: the block JSON text, or null to let the stop through.
// settings: { url, key, stop ('off' never reminds), stateFile }.
export async function decideStop(payload, { url, key, stop = 'on', stateFile = null }, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS, now } = {}) {
  if (stop === 'off' || !url || !key) return null;
  if (!payload || typeof payload !== 'object' || payload.stop_hook_active === true) return null;
  const cwd = typeof payload.cwd === 'string' && path.isAbsolute(payload.cwd) ? payload.cwd : null;
  if (!cwd) return null;
  const a = await askHeld({ url, key, dir: cwd, fetchImpl, signal: AbortSignal.timeout(timeoutMs) });
  const task = a?.task;
  if (!task || typeof task.id !== 'string') return null;
  const session = typeof payload.session_id === 'string' && payload.session_id !== '' ? payload.session_id : null;
  if (!remindOnce(stateFile, session, task.id, now)) return null;
  return stopOutput(stopReason(task, a.place));
}
