// The MCP endpoint: an HTTP server whose /mcp speaks MCP over Streamable HTTP (stateless:
// a new McpServer and transport for each request) and whose /health says "ok".
// Every /mcp request carries one device's machine key (Authorization: Bearer <key>); the key
// tells which device is calling. The tools only read, and return the ledger as it is: whoever
// holds a valid key sees everything. Keys are never logged.
//
// The ledger is opened once by the caller and kept open. An import from another process
// may replace its rows while this server runs; SQLite in WAL mode lets that writer commit
// while this connection keeps reading, and each read sees the latest committed rows.

import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { STATES, MODES } from '../ledger/rules.mjs';

const VERSION = '0.0.0';

// Results as pretty JSON text, and the same object as structuredContent.
function result(value) {
  const structured = Array.isArray(value) ? { results: value } : value;
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: structured };
}

function toolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// One McpServer for one request from `device` ({ name }).
function buildServer(ledger, device) {
  const server = new McpServer({ name: 'warifuri', version: VERSION });
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    'board',
    {
      description:
        'List open goals with their tasks, and the tasks with no goal; each task shows who holds it. ' +
        'place: the directory you work in; the place it falls in on your device gives the profile to show. ' +
        'profile: show that profile (wins over place). Without place or profile, everything is shown. ' +
        'state and mode filter; review: true shows only rows flagged on import; include_closed: true adds done and discarded rows.',
      inputSchema: {
        place: z.string().min(1).optional(),
        profile: z.string().optional(),
        state: z.enum(STATES).optional(),
        mode: z.enum(MODES).optional(),
        review: z.boolean().optional(),
        include_closed: z.boolean().optional(),
      },
      annotations: readOnly,
    },
    async ({ place, profile, state, mode, review, include_closed }) =>
      result(
        ledger.board({
          dir: place,
          device: device.name,
          profile,
          state,
          mode,
          review: review ?? false,
          includeClosed: include_closed ?? false,
        }),
      ),
  );

  server.registerTool(
    'get',
    {
      description: 'Read one goal, task, habit or place by id, with its order, hold and records.',
      inputSchema: { id: z.string().min(1) },
      annotations: readOnly,
    },
    async ({ id }) => {
      const item = ledger.get(id);
      if (!item) return toolError(`${id} というゴール・タスク・習慣・置き場はありません`);
      return result(item);
    },
  );

  server.registerTool(
    'search',
    {
      description: 'Find goals and tasks whose title contains the text, closed ones too. Use it before creating one, to avoid duplicates.',
      inputSchema: { text: z.string(), limit: z.number().int().min(1).max(100).optional() },
      annotations: readOnly,
    },
    async ({ text, limit }) => result(ledger.search(text, { limit: limit ?? 20 })),
  );

  server.registerTool(
    'flow',
    {
      description:
        "A goal's flow as a Mermaid flowchart: its tasks, the order between them as arrows, and colours for " +
        'done, running (held), next (ready with nothing open before it) and waiting.',
      inputSchema: { goal_id: z.string().min(1) },
      annotations: readOnly,
    },
    async ({ goal_id: goalId }) => {
      const mermaid = ledger.flow(goalId);
      if (mermaid === null) return toolError(`${goalId} というゴールはありません`);
      return { content: [{ type: 'text', text: mermaid }], structuredContent: { goal_id: goalId, mermaid } };
    },
  );

  server.registerTool(
    'stale',
    {
      description:
        'Candidates for tidying, with reasons: tasks held with no change for held_days (default 3), ready and ' +
        'untouched for ready_days (30), waiting with no change for waiting_days (14). It changes nothing.',
      inputSchema: {
        held_days: z.number().min(0).optional(),
        ready_days: z.number().min(0).optional(),
        waiting_days: z.number().min(0).optional(),
      },
      annotations: readOnly,
    },
    async ({ held_days: heldDays, ready_days: readyDays, waiting_days: waitingDays }) =>
      result(ledger.stale({ heldDays, readyDays, waitingDays })),
  );

  return server;
}

function sendText(res, status, text, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(text);
}

function unauthorized(res) {
  res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: a valid device key is required' }, id: null }));
}

// The key from "Authorization: Bearer <key>", or null.
function bearerKey(req) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
  return m ? m[1] : null;
}

async function handleMcp(ledger, req, res) {
  const device = ledger.deviceForKey(bearerKey(req));
  if (!device) return unauthorized(res);
  const server = buildServer(ledger, device);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

export function createServer({ ledger }) {
  return http.createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname === '/health' && req.method === 'GET') return sendText(res, 200, 'ok');
    if (pathname === '/mcp' && ['POST', 'GET', 'DELETE'].includes(req.method)) {
      handleMcp(ledger, req, res).catch((err) => {
        process.stderr.write(`warifuri: /mcp failed: ${err.message}\n`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
        } else {
          res.end();
        }
      });
      return undefined;
    }
    return sendText(res, 404, 'not found');
  });
}
