// Tests for the calendar hook: which tool calls are calendar writes, and the decision against
// a server that says whether the secretary runs. GET /api/secretary itself is in asks.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isCalendarWrite, decideCalendar } from '../src/client/calendar-hook.mjs';

const KEY = 'wf_calendar-hook-test-key';
const settings = { url: 'http://127.0.0.1:1', key: KEY };
// A fetch that answers /api/secretary with the given state and remembers what it was asked.
const server = (secretary, status = 200) => {
  const asked = [];
  const fetchImpl = async (url, init) => {
    asked.push({ url, auth: init.headers.authorization });
    return { status, json: async () => ({ secretary }) };
  };
  return { asked, fetchImpl };
};

test('calendar writes are told from reads, by any server name', () => {
  for (const name of [
    'mcp__claude_ai_Google_Calendar__create_event',
    'mcp__claude_ai_Google_Calendar__update_event',
    'mcp__claude_ai_Google_Calendar__delete_event',
    'mcp__claude_ai_Google_Calendar__respond_to_event',
    'mcp__a6062a43-f37b-44db-90de-ba0d63b570c4__create_event',
    'mcp__notion__notion-calendar-create-events',
    'mcp__notion__notion-calendar-cancel-events',
    'mcp__calendar__move_event',
  ]) assert.equal(isCalendarWrite(name), true, name);
  for (const name of [
    'mcp__claude_ai_Google_Calendar__list_events',
    'mcp__claude_ai_Google_Calendar__get_event',
    'mcp__claude_ai_Google_Calendar__search_events',
    'mcp__claude_ai_Google_Calendar__suggest_time',
    'mcp__claude_ai_Google_Calendar__list_calendars',
    'mcp__warifuri__book',
    'mcp__notion__notion-create-pages',
    'Edit',
    undefined,
  ]) assert.equal(isCalendarWrite(name), false, String(name));
});

test('while the secretary runs, a calendar write is refused with the way to ask it; the key goes in the header', async () => {
  const s = server('on');
  const out = await decideCalendar({ tool_name: 'mcp__claude_ai_Google_Calendar__create_event', tool_input: {} }, settings, { fetchImpl: s.fetchImpl });
  const json = JSON.parse(out);
  assert.equal(json.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(json.hookSpecificOutput.permissionDecisionReason, /秘書が有効なので.*ask_secretary/);
  assert.deepEqual(s.asked, [{ url: 'http://127.0.0.1:1/api/secretary', auth: `Bearer ${KEY}` }]);
  assert.ok(!out.includes(KEY));
});

test('the write goes through with the secretary off, for reads without asking, and whenever the hook cannot ask', async () => {
  const write = { tool_name: 'mcp__claude_ai_Google_Calendar__create_event' };
  assert.equal(await decideCalendar(write, settings, { fetchImpl: server('off').fetchImpl }), null);
  const read = server('on');
  assert.equal(await decideCalendar({ tool_name: 'mcp__claude_ai_Google_Calendar__list_events' }, settings, { fetchImpl: read.fetchImpl }), null);
  assert.equal(read.asked.length, 0);
  assert.equal(await decideCalendar(write, { ...settings, gate: 'off' }, { fetchImpl: server('on').fetchImpl }), null);
  assert.equal(await decideCalendar(write, { ...settings, key: null }, { fetchImpl: server('on').fetchImpl }), null);
  assert.equal(await decideCalendar(write, settings, { fetchImpl: server('on', 500).fetchImpl }), null);
  assert.equal(await decideCalendar(write, settings, { fetchImpl: async () => { throw new Error('down'); } }), null);
  assert.equal(await decideCalendar(null, settings, { fetchImpl: server('on').fetchImpl }), null);
});
