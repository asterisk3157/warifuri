// The session brief: a SessionStart hook for Claude Code (and Codex's SessionStart, which
// takes the same shape). When a conversation starts in a place, the agent is handed, as
// additional context, where it is, the task this device holds there, what the profile's
// knowledge has (names only) and who its people are; the text is made by the server
// (src/knowledge/brief.mjs). The agent reads the rest with context and people.
//
// The hook gets the harness's JSON on stdin ({ session_id, cwd, source, ... }) and asks the
// server, with this machine's device key, GET <url>/api/brief?dir=<cwd>  ->  { place, text }.
//
// It never holds a conversation up: no settings, no key, a payload it cannot read, a
// directory outside every place, the server unreachable, slow (2 seconds) or answering
// anything but 200, all print nothing. The key is sent in a header and never printed.

import path from 'node:path';

export const BRIEF_TIMEOUT_MS = 2000;
// A longer text than the server ever sends is cut, so a wrong answer cannot fill the context.
const MAX_CHARS = 4000;

export const briefOutput = (text) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } });

// The output for one payload: the SessionStart JSON text, or null to say nothing.
// settings: { url, key, brief ('off' never says anything) }.
export async function decideBrief(payload, { url, key, brief = 'on' }, { fetchImpl = fetch, timeoutMs = BRIEF_TIMEOUT_MS } = {}) {
  if (brief === 'off' || !url || !key) return null;
  if (!payload || typeof payload !== 'object') return null;
  const cwd = typeof payload.cwd === 'string' && path.isAbsolute(payload.cwd) ? payload.cwd : null;
  if (!cwd) return null;
  try {
    const res = await fetchImpl(`${url.replace(/\/+$/, '')}/api/brief?dir=${encodeURIComponent(cwd)}`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 200) return null;
    const body = await res.json();
    const text = body && typeof body === 'object' && body.place && typeof body.text === 'string' ? body.text.trim() : '';
    if (text === '') return null;
    return briefOutput([...text].slice(0, MAX_CHARS).join(''));
  } catch {
    return null;
  }
}
