// The MCP endpoint: an HTTP server whose /mcp speaks MCP over Streamable HTTP (stateless:
// a new McpServer and transport for each request) and whose /health says "ok".
// Every /mcp request carries one machine's key (Authorization: Bearer <key>). The tools
// only read; what they return is reduced by secrecy.mjs for machines that may not read
// withheld rows. Keys are never logged.
//
// The ledger is opened once by the caller and kept open. An import from another process
// may replace its rows while this server runs; SQLite in WAL mode lets that writer commit
// while this connection keeps reading, and each read sees the latest committed rows.

import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { STATES, MODES } from '../ledger/rules.mjs';
import { redactBoard, redactItem, redactSearch } from '../ledger/secrecy.mjs';

const VERSION = '0.0.0';

// Results as pretty JSON text, and the same object as structuredContent.
function result(value) {
  const structured = Array.isArray(value) ? { results: value } : value;
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: structured };
}

function toolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// One McpServer for one request, seeing the ledger as `machine` may.
function buildServer(ledger, machine) {
  const server = new McpServer({ name: 'warifuri', version: VERSION });
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    'board',
    {
      description:
        'List open goals with their tasks, and the tasks with no goal. Filter by area, state or mode; ' +
        'review: true shows only rows flagged on import; include_closed: true adds done and discarded rows.',
      inputSchema: {
        area: z.string().optional(),
        state: z.enum(STATES).optional(),
        mode: z.enum(MODES).optional(),
        review: z.boolean().optional(),
        include_closed: z.boolean().optional(),
      },
      annotations: readOnly,
    },
    async ({ area, state, mode, review, include_closed }) => {
      const board = ledger.board({ area, state, mode, review: review ?? false, includeClosed: include_closed ?? false });
      return result(redactBoard(board, ledger.secrecyIndex(), machine));
    },
  );

  server.registerTool(
    'get',
    {
      description: 'Read one goal, task, habit or place by id, with its order and records.',
      inputSchema: { id: z.string().min(1) },
      annotations: readOnly,
    },
    async ({ id }) => {
      const item = ledger.get(id);
      if (!item) return toolError(`${id} というゴール・タスク・習慣・置き場はありません`);
      return result(redactItem(item, ledger.secrecyIndex(), machine));
    },
  );

  server.registerTool(
    'search',
    {
      description: 'Find goals and tasks whose title contains the text. Use it before creating one, to avoid duplicates.',
      inputSchema: { text: z.string(), limit: z.number().int().min(1).max(100).optional() },
      annotations: readOnly,
    },
    async ({ text, limit }) => {
      const found = ledger.search(text, { limit: limit ?? 20 });
      return result(redactSearch(found, ledger.secrecyIndex(), machine));
    },
  );

  return server;
}

function sendText(res, status, text, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(text);
}

function unauthorized(res) {
  res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: a valid machine key is required' }, id: null }));
}

// The key from "Authorization: Bearer <key>", or null.
function bearerKey(req) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
  return m ? m[1] : null;
}

async function handleMcp(ledger, req, res) {
  const machine = ledger.machineForKey(bearerKey(req));
  if (!machine) return unauthorized(res);
  const server = buildServer(ledger, machine);
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
