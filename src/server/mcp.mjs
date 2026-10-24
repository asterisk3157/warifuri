// The MCP endpoint: an HTTP server whose /mcp speaks MCP over Streamable HTTP (stateless:
// a new McpServer and transport for each request) and whose /health says "ok".
// Every /mcp request carries a bearer that tells which device is calling: a device's machine
// key (wf_…), or, when OAuth is configured (oauth.mjs), an access token issued after the
// person logged in with GitHub and chose the device. The tools only read, and return the
// ledger as it is: whoever holds a valid bearer sees everything. Bearers are never logged.
//
// The ledger is opened once by the caller and kept open. An import from another process
// may replace its rows while this server runs; SQLite in WAL mode lets that writer commit
// while this connection keeps reading, and each read sees the latest committed rows.

import http from 'node:http';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { STATES, MODES } from '../ledger/rules.mjs';
import { createOAuth } from './oauth.mjs';

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

function sendText(res, status, text) {
  res.status(status).type('text/plain; charset=utf-8').send(text);
}

// Without OAuth, /mcp takes device keys only, and answers a bad one with a JSON-RPC error.
function deviceKeyAuth(ledger) {
  return (req, res, next) => {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
    const device = ledger.deviceForKey(m ? m[1] : null);
    if (!device) {
      res.status(401).set('WWW-Authenticate', 'Bearer');
      res.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: a valid device key is required' }, id: null });
      return;
    }
    req.auth = { token: m[1], clientId: 'device-key', scopes: [], extra: { device: device.name } };
    next();
  };
}

// req.auth is set by the bearer check before this runs; its device is the caller.
async function handleMcp(ledger, req, res) {
  const server = buildServer(ledger, { name: req.auth.extra.device });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

// The express app. oauth: the config from oauthConfig(), or null for device keys only.
// github: { webUrl, apiUrl, fetch } stands in for GitHub in tests. log: where errors go.
// trustProxy: express's `trust proxy` (such as 'loopback', or a number of hops), for a server
// behind a tunnel or reverse proxy; then the caller's address, which the rate limits count
// by, is read from X-Forwarded-For. Off when left out. A value express cannot read throws.
export function createApp({ ledger, oauth = null, github, trustProxy, log = (line) => process.stderr.write(`${line}\n`) }) {
  const app = express();
  app.disable('x-powered-by');
  if (trustProxy !== undefined) app.set('trust proxy', /^\d+$/.test(String(trustProxy)) ? Number(trustProxy) : trustProxy);
  app.get('/health', (req, res) => sendText(res, 200, 'ok'));

  let auth = deviceKeyAuth(ledger);
  if (oauth) {
    const { router, bearer } = createOAuth({ ledger, config: oauth, github, log });
    app.use(router);
    auth = bearer;
  }
  const mcp = (req, res) =>
    handleMcp(ledger, req, res).catch((err) => {
      log(`warifuri: /mcp failed: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      } else {
        res.end();
      }
    });
  app.post('/mcp', auth, mcp);
  app.get('/mcp', auth, mcp);
  app.delete('/mcp', auth, mcp);

  app.use((req, res) => sendText(res, 404, 'not found'));
  // Errors from the routes above; the message may come from a library, so it is not echoed.
  app.use((err, req, res, _next) => {
    log(`warifuri: ${req.method} ${req.path} failed: ${err.message}`);
    if (res.headersSent) return res.end();
    return sendText(res, err.status && err.status < 500 ? err.status : 500, err.status && err.status < 500 ? 'bad request' : 'internal error');
  });
  return app;
}

export function createServer(options) {
  return http.createServer(createApp(options));
}
