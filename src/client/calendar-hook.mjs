// The calendar hook: a PreToolUse hook for Claude Code and Codex. While the secretary runs,
// only it books, moves and removes time (原則23); an agent writing to the person's calendar
// through its own calendar MCP would go around that. So before such a tool runs, this asks
// the server, with this machine's device key,
//   GET <url>/api/secretary  ->  { secretary: 'on' | 'off' }
// and on 'on' denies, telling the agent to ask the secretary (ask_secretary). Reading the
// calendar is never stopped.
//
// A harness set to the gcp route (WARIFURI_CALENDAR_CLAUDE or WARIFURI_CALENDAR_CODEX) does not
// touch calendars through its own connectors or MCP at all, reads included: its account may
// not be the person's calendar account (a work login, say). Then every calendar tool is
// denied without asking the server; the calendar is reached through warifuri instead.
//
// Fail-open as the start gate: no settings, no key, a payload it cannot read, the server
// unreachable, slow (3 seconds) or answering anything but 200, all allow. WARIFURI_GATE=off
// turns this off too. The key is sent in a header and never printed.

import { denyOutput, TIMEOUT_MS } from './gate.mjs';

// What a tool that writes does, in its own name (the tool part, after the server's name).
const WRITE_VERB = /(create|update|delete|remove|move|patch|insert|import|quick_?add|respond|cancel)/i;
// Tools of a calendar: the server's or the tool's name says calendar, or the tool acts on events.
const CALENDAR_WORD = /calendar|event/i;

// Whether a tool is a calendar's (read or write): an MCP tool, not warifuri's, whose name
// speaks of a calendar or events.
export function isCalendarTool(toolName) {
  if (typeof toolName !== 'string') return false;
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return Boolean(m) && m[1] !== 'warifuri' && CALENDAR_WORD.test(toolName);
}

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

export function routeDenyReason(toolName, setting) {
  return (
    `warifuri: このハーネスはカレンダーのコネクタを使わない設定です(${setting}=gcp)。${toolName} は使わず、` +
    '予定は MCP の warifuri の schedule で読みます。予定を入れるときは、秘書が有効なら ask_secretary、無効なら free_time を見て book で入れます。'
  );
}

// The decision for one payload: the deny JSON text, or null to allow.
// settings: { url, key, gate, route, setting } (gate 'off' allows everything; route 'gcp'
// denies every calendar tool; setting names the variable, for the reason).
export async function decideCalendar(payload, { url, key, gate = 'on', route = 'connector', setting = 'WARIFURI_CALENDAR_*' }, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (gate === 'off') return null;
  if (route === 'gcp' && payload && typeof payload === 'object' && isCalendarTool(payload.tool_name)) {
    return denyOutput(routeDenyReason(payload.tool_name, setting));
  }
  if (!url || !key) return null;
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
