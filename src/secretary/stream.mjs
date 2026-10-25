// Reads claude's output while it runs. With --output-format stream-json --verbose
// --include-partial-messages, claude writes one JSON object per line: the session (system
// init), pieces of text as they come (stream_event, content_block_delta, text_delta), each
// whole message of the assistant (with its tool calls), and at the end the result. Without
// the partial messages, the text comes a message at a time; with --output-format json, there
// is only the result. The reader takes any of these, so an older claude still works: the reply
// then appears whole.
//
// What it tells the caller (onEvent):
//   { type: 'text', text }   the words of the reply so far (since the last tool call)
//   { type: 'step', step }   one step of the work: { kind, label } (read, search, write, ask,
//                            say: words written between two tool calls, tool: anything else)
// Tool arguments and results are never passed on: a step says only what kind of thing was
// done, so nothing from the ledger or the MCP config leaves through it.

// The steps of warifuri's tools, as the window shows them.
const TOOL_STEPS = {
  board: ['read', 'タスクを読みました'],
  get: ['read', 'タスクを読みました'],
  flow: ['read', 'ゴールの流れを読みました'],
  places: ['read', '作業フォルダを読みました'],
  context: ['read', 'ナレッジを読みました'],
  stale: ['read', '止まっているものを探しました'],
  schedule: ['read', '予定を読みました'],
  free_time: ['search', '空き時間を探しました'],
  search: ['search', '探しました'],
  autonomy: ['read', '自律度を読みました'],
  reports: ['read', '報告を読みました'],
  proposals: ['read', '案を読みました'],
  settings: ['read', '設定を読みました'],
  book: ['write', '予定を入れました'],
  unbook: ['write', '予定を外しました'],
  create_goal: ['write', 'ゴールを作りました'],
  create_task: ['write', 'タスクを作りました'],
  update: ['write', 'タスクを直しました'],
  close: ['write', 'タスクを閉じました'],
  reopen: ['write', 'タスクを開き直しました'],
  resume: ['write', 'タスクを戻しました'],
  defer: ['write', '先送りにしました'],
  wait: ['write', '待ちにしました'],
  link: ['write', '順序をつなぎました'],
  unlink: ['write', '順序を外しました'],
  habit: ['write', '習慣を直しました'],
  note: ['write', 'ナレッジに書きました'],
  report: ['write', '報告を書きました'],
  propose: ['write', '案を残しました'],
  proposal_done: ['write', '案に済みの印を付けました'],
  autonomy_outcome: ['write', '自律度に記録しました'],
  autonomy_set: ['write', '自律度を変えました'],
  ask: ['ask', '質問を出しました'],
};
// Tools whose step is not shown: the reply buttons belong to the reply itself.
const QUIET = new Set(['reply_options']);
const SAID_MAX = 120;

// The step of one tool call, or null for one that is not shown.
export function stepFor(name) {
  const full = String(name ?? '');
  const bare = full.startsWith('mcp__') ? full.split('__').at(-1) : full;
  if (QUIET.has(bare)) return null;
  const known = TOOL_STEPS[bare];
  if (known) return { kind: known[0], label: known[1] };
  return { kind: 'tool', label: 'ツールを使いました' };
}

const clip = (text, n) => {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  return chars.length > n ? `${chars.slice(0, n).join('')}…` : chars.join('');
};

// A reader of claude's stdout. push(chunk) as it comes, end() at the close; end returns
// { result, sessionId, streamed, steps, text }: result as readResult gives it ({ text,
// sessionId, isError }) or null, whether any piece of text came as it was written, the steps,
// and the last words seen.
export function createStreamReader({ onEvent = () => {} } = {}) {
  let buffer = '';
  let text = '';
  let partial = false;
  let streamed = false;
  let sessionId = null;
  let result = null;
  const steps = [];

  const step = (s) => {
    steps.push(s);
    onEvent({ type: 'step', step: s });
  };
  // A tool call ends the words before it: they become a step of their own.
  const toolCall = (name) => {
    if (text.trim()) step({ kind: 'say', label: clip(text, SAID_MAX) });
    text = '';
    onEvent({ type: 'text', text });
    const s = stepFor(name);
    if (s) step(s);
  };

  function line(raw) {
    const t = raw.trim();
    if (!t) return;
    let json;
    try {
      json = JSON.parse(t);
    } catch {
      return;
    }
    if (!json || typeof json !== 'object') return;
    if (typeof json.session_id === 'string' && !sessionId) sessionId = json.session_id;
    if (json.type === 'stream_event') {
      const e = json.event ?? {};
      if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && typeof e.delta.text === 'string') {
        partial = true;
        streamed = true;
        text += e.delta.text;
        onEvent({ type: 'text', text });
      }
      return;
    }
    if (json.type === 'assistant' && Array.isArray(json.message?.content)) {
      // A whole message: its tool calls are steps; its words count only when they did not
      // come in pieces already.
      for (const block of json.message.content) {
        if (block?.type === 'text' && typeof block.text === 'string' && !partial) {
          text += block.text;
          onEvent({ type: 'text', text });
        } else if (block?.type === 'tool_use') toolCall(block.name);
      }
      partial = false;
      return;
    }
    if (json.type === 'result') {
      result = {
        text: typeof json.result === 'string' ? json.result.trim() : '',
        sessionId: typeof json.session_id === 'string' ? json.session_id : sessionId,
        isError: json.is_error === true || (json.subtype !== undefined && json.subtype !== 'success'),
      };
    }
  }

  return {
    push(chunk) {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
      }
    },
    end() {
      if (buffer.trim()) {
        // --output-format json writes one object, maybe pretty-printed over several lines.
        const rest = buffer;
        buffer = '';
        line(rest.replace(/\n/g, ' '));
      }
      return { result, sessionId: result?.sessionId ?? sessionId, streamed, steps, text };
    },
  };
}

// Whether a failed run failed because this claude does not know a flag of streaming.
export const UNSUPPORTED = /unknown option|unrecognized option|unexpected argument|invalid (?:value|choice)|--include-partial-messages|--input-format|stream-json requires/i;
