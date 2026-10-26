// The hook that keeps the secretary's outside tools given to read (WARIFURI_SECRETARY_TOOLS
// =read) to their reads: `warifuri hook tools <tool> ...`, a PreToolUse hook in the settings
// file the secretary's claude is started with (writeClaudeSettings). The tools given to read
// are named on its command line; it needs no server and no key.
//
// A tool is a read when a word of its name (split at _ and -) is a reading one (list, get,
// search, ...) and none is a writing one (create, send, delete, ...). Anything else of a tool
// given to read is stopped, so a tool that cannot be told is stopped too.

import { denyOutput } from '../client/gate.mjs';

const READ_WORDS = new Set(['list', 'get', 'search', 'read', 'query', 'fetch', 'find', 'view', 'suggest', 'describe', 'lookup', 'self']);
const WRITE_WORDS = new Set([
  'create', 'update', 'delete', 'remove', 'move', 'patch', 'insert', 'import', 'add', 'set', 'send', 'reply', 'forward',
  'draft', 'trash', 'untrash', 'label', 'unlabel', 'mark', 'unmark', 'archive', 'spam', 'post', 'comment', 'upload',
  'respond', 'cancel', 'restore', 'duplicate', 'spawn', 'stop', 'convert', 'apply', 'write', 'edit', 'resolve', 'react',
]);

// Whether the tool part of a name (after mcp__<server>__) only reads.
export function isReadTool(toolPart) {
  const words = String(toolPart).toLowerCase().split(/[-_]+/);
  return words.some((w) => READ_WORDS.has(w)) && !words.some((w) => WRITE_WORDS.has(w));
}

// The decision for one payload: the deny JSON text, or null to allow. reads: the names given
// to read (mcp__<server>, or mcp__<server>__<tool>).
export function decideTools(payload, reads) {
  const name = payload && typeof payload === 'object' ? payload.tool_name : null;
  if (typeof name !== 'string') return null;
  const given = reads.find((r) => name === r || name.startsWith(`${r}__`));
  if (!given) return null;
  const m = /^mcp__.+?__(.+)$/.exec(name);
  if (m && isReadTool(m[1])) return null;
  return denyOutput(`warifuri: ${given} は読むだけの範囲で渡されています(WARIFURI_SECRETARY_TOOLS)。${name} は使えません。書く必要があれば、本人に頼むか、範囲を変えるよう伝えます。`);
}
