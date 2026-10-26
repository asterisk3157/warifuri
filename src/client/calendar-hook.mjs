// The calendar hook: a PreToolUse hook for Claude Code and Codex. While the secretary runs,
// only it books, moves and removes time (原則23); an agent writing to the person's calendar
// through its own calendar MCP would go around that. So before such a tool runs, this asks
// the server, with this machine's device key,
//   GET <url>/api/secretary  ->  { secretary: 'on' | 'off' }
// and on 'on' denies, telling the agent to ask the secretary (ask_secretary). Reading the
// calendar is never stopped.
//
// Fail-open as the start gate: no settings, no key, a payload it cannot read, the server
// unreachable, slow (3 seconds) or answering anything but 200, all allow. WARIFURI_GATE=off
// turns this off too. The key is sent in a header and never printed.

import { denyOutput, TIMEOUT_MS } from './gate.mjs';

// What a tool that writes does, in its own name (the tool part, after the server's name).
const WRITE_VERB = /(create|update|delete|remove|move|patch|insert|import|quick_?add|respond|cancel)/i;
// Tools of a calendar: the server's or the tool's name says calendar, or the tool acts on events.
const CALENDAR_WORD = /calendar|event/i;

// Whether a tool call writes to a calendar: an MCP tool (mcp__<server>__<tool>) whose name
// speaks of a calendar or events and whose tool part is a write. warifuri's own tools are not.
export function isCalendarWrite(toolName) {
  if (typeof toolName !== 'string') return false;
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (!m || m[1] === 'warifuri') return false;
  return CALENDAR_WORD.test(toolName) && WRITE_VERB.test(m[2]);
}

export function calendarDenyReason(toolName) {
  return (
    `warifuri: 秘書が有効なので、予定は秘書が決めます(原則23)。${toolName} でカレンダーに直接書かず、` +
    'MCP の warifuri の ask_secretary に、何に(task_id)、どれくらい(minutes)、いつまでに(by)、希望(prefer)を渡して頼んでください。' +
    '本人が日時を決めているときは starts_at と ends_at で渡します。カレンダーを読むのはかまいません。'
  );
}

// The decision for one payload: the deny JSON text, or null to allow.
// settings: { url, key, gate } (gate 'off' allows everything).
export async function decideCalendar(payload, { url, key, gate = 'on' }, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (gate === 'off' || !url || !key) return null;
  if (!payload || typeof payload !== 'object' || !isCalendarWrite(payload.tool_name)) return null;
  try {
    const res = await fetchImpl(`${url.replace(/\/+$/, '')}/api/secretary`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 200) return null;
    const body = await res.json();
    return body?.secretary === 'on' ? denyOutput(calendarDenyReason(payload.tool_name)) : null;
  } catch {
    return null;
  }
}
