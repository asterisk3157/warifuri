// The MCP endpoint: an HTTP server whose /mcp speaks MCP over Streamable HTTP (stateless:
// a new McpServer and transport for each request), whose /api answers scripts such as hooks,
// and whose /health says "ok".
// Every /mcp request carries a bearer that tells which device is calling: a device's machine
// key (wf_…), or, when OAuth is configured (oauth.mjs), an access token issued after the
// person logged in with GitHub and chose the device. The read tools return the ledger as it
// is: whoever holds a valid bearer sees everything. The write tools write as that device: the
// device always comes from the bearer, never from a tool's arguments, and the actor names the
// kind of bearer (device-key, or oauth:<client_id>). /api takes machine keys only.
// Bearers are never logged.
//
// The ledger is opened once by the caller and kept open. An import from another process
// may replace its rows while this server runs; SQLite in WAL mode lets that writer commit
// while this connection keeps reading, and each read sees the latest committed rows.

import http from 'node:http';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { STATES, MODES, LOADS, isValidId } from '../ledger/rules.mjs';
import { LedgerError } from '../ledger/ledger.mjs';
import { comparablePath } from '../ledger/paths.mjs';
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

// A write the ledger refused, as a tool error listing every problem. extra is appended as JSON.
function refusal(problems, extra) {
  const lines = ['書けませんでした。', ...problems.map((p) => `- ${p}`)];
  if (extra) lines.push('', JSON.stringify(extra, null, 2));
  return toolError(lines.join('\n'));
}

// Runs a write tool's handler; a LedgerError becomes a tool error instead of a failed request.
const guarded = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (err) {
    if (err instanceof LedgerError) return refusal(err.problems);
    throw err;
  }
};

// Only the arguments that were given, so the ledger sees what the caller meant to change.
const given = (args) => Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));

// Text a caller may clear with null.
const clearable = z.string().nullable().optional();

// One McpServer for one request from `device` ({ name, actor }).
function buildServer(ledger, device) {
  const server = new McpServer({ name: 'warifuri', version: VERSION });
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const writer = { actor: device.actor, device: device.name };

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
    'places',
    {
      description:
        'List the places with their profile and their directory on each device. Use it to pick a place for a new ' +
        'task, including places with no task yet. profile: only that profile.',
      inputSchema: { profile: z.string().optional() },
      annotations: readOnly,
    },
    async ({ profile }) => result({ places: ledger.listPlaces({ profile }) }),
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

  registerWriteTools(server, ledger, device, { write, writer });
  return server;
}

// A place given as its id, or as a directory on the caller's device (the deepest place
// containing it). Throws a LedgerError naming what to do when neither finds one.
function resolvePlace(ledger, device, value) {
  const item = ledger.get(value);
  if (item?.kind === 'place') return item;
  if (comparablePath(value) !== null) {
    const place = ledger.placeFor(device, value);
    if (place) return place;
    throw new LedgerError([
      `${value} は、デバイス ${device} のどの置き場にも入っていません。place で置き場を登録するか、いまの置き場にこのデバイスの道を足してから、もう一度 start します`,
    ]);
  }
  if (isValidId(value)) throw new LedgerError([`置き場 ${value} がありません`]);
  throw new LedgerError([`place には置き場の id か、絶対パスのディレクトリを渡します(${value} はどちらでもありません)`]);
}

function registerWriteTools(server, ledger, device, { write, writer }) {
  const tool = (name, description, inputSchema, fn) =>
    server.registerTool(name, { description, inputSchema, annotations: write }, guarded(fn));

  tool(
    'create_goal',
    'Create a goal. Search first, so the same goal is not made twice. A goal that takes a person\'s time ' +
      '(mode human or human_with_ai) needs an outcome and a due date the person set; due_provisional marks a date nobody set.',
    {
      title: z.string(),
      outcome: z.string().optional(),
      due: z.string().optional(),
      due_provisional: z.boolean().optional(),
      mode: z.enum(MODES).optional(),
      human_led: z.boolean().optional(),
      profile: z.string().optional(),
    },
    async (args) => result(ledger.createGoal(given(args), writer)),
  );

  tool(
    'create_task',
    'Create a task, under a goal or with no goal. Search first, so the same task is not made twice. ' +
      'A task that takes a person\'s time needs done_when. place_id: the place it belongs to (board shows the one you are in).',
    {
      title: z.string(),
      body: z.string().optional(),
      done_when: z.string().optional(),
      goal_id: z.string().optional(),
      mode: z.enum(MODES).optional(),
      load: z.enum(LOADS).optional(),
      estimate_min: z.number().int().optional(),
      due: z.string().optional(),
      due_provisional: z.boolean().optional(),
      place_id: z.string().optional(),
      delegated: z.boolean().optional(),
    },
    async (args) => result(ledger.createTask(given(args), writer)),
  );

  tool(
    'update',
    'Change fields of a goal or task. Only the fields given change; null clears one. Goals take title, outcome, due, ' +
      'due_provisional, mode, human_led, profile; tasks take title, body, done_when, due, due_provisional, mode, load, ' +
      'goal_id, estimate_min, place_id, next, delegated. State changes go through close, defer, wait, start and release.',
    {
      id: z.string().min(1),
      title: z.string().optional(),
      outcome: clearable,
      body: clearable,
      done_when: clearable,
      due: clearable,
      due_provisional: z.boolean().optional(),
      mode: z.enum(MODES).optional(),
      load: z.enum(LOADS).nullable().optional(),
      goal_id: clearable,
      estimate_min: z.number().int().nullable().optional(),
      place_id: clearable,
      next: clearable,
      human_led: z.boolean().optional(),
      delegated: z.boolean().optional(),
      profile: clearable,
    },
    async ({ id, ...fields }) => result(ledger.update(id, given(fields), writer)),
  );

  tool(
    'link',
    'Add an order between two tasks: before_id comes before after_id. A cycle is refused.',
    { before_id: z.string().min(1), after_id: z.string().min(1) },
    async ({ before_id: beforeId, after_id: afterId }) => result(ledger.link(beforeId, afterId, writer)),
  );

  tool(
    'unlink',
    'Remove an order between two tasks.',
    { before_id: z.string().min(1), after_id: z.string().min(1) },
    async ({ before_id: beforeId, after_id: afterId }) => result(ledger.unlink(beforeId, afterId, writer)),
  );

  tool(
    'start',
    'Hold a task before working on it: this device holds it in a place, and a ready task becomes running. ' +
      'place: the place id, or the directory you work in (the deepest place containing it on this device). ' +
      'This device holds one task per place: release the one you hold there (with next) before starting another. ' +
      'A task held elsewhere moves here.',
    { task_id: z.string().min(1), place: z.string().min(1) },
    async ({ task_id: taskId, place: value }) => {
      const place = resolvePlace(ledger, device.name, value);
      const before = ledger.get(taskId)?.hold ?? null;
      try {
        const task = ledger.start(taskId, { device: device.name, placeId: place.id }, writer);
        const moved = before && (before.device !== device.name || before.place_id !== place.id);
        return result(moved ? { ...task, moved_from: before } : task);
      } catch (err) {
        if (!(err instanceof LedgerError) || !err.heldTaskId) throw err;
        return refusal(err.problems, { held: ledger.held({ device: device.name, placeId: place.id }) });
      }
    },
  );

  tool(
    'release',
    'Let go of a held task without closing it (pause), before switching to another. next: one line for whoever ' +
      'picks it up, such as where you stopped. A running task goes back to ready.',
    { task_id: z.string().min(1), next: z.string() },
    async ({ task_id: taskId, next }) => {
      if (next.trim() === '') return refusal(['手放すときは、次に持つ人のために next を1行書きます(原則7)']);
      if (/[\r\n]/.test(next)) return refusal(['next は1行で書きます。長い説明は update で body に書きます']);
      return result(ledger.release(taskId, { next }, writer));
    },
  );

  tool(
    'close',
    'Close a goal or task once you have checked the real thing: state done with a one-line result, or discarded ' +
      'with a reason. A held task is let go; next may leave a line for whoever reopens it. learned: what the work ' +
      'taught that is worth keeping; for now it is kept only in the record of this close (the note tool comes later).',
    {
      id: z.string().min(1),
      state: z.enum(['done', 'discarded']),
      result: z.string().optional(),
      reason: z.string().optional(),
      learned: z.string().optional(),
      next: z.string().optional(),
    },
    async ({ id, state, ...extra }) => result(ledger.setState(id, state, given(extra), writer)),
  );

  tool(
    'reopen',
    'Bring a done or discarded goal or task back to ready; its result or reason is cleared.',
    { id: z.string().min(1) },
    async ({ id }) => result(ledger.reopen(id, writer)),
  );

  tool(
    'resume',
    'Bring a deferred or waiting goal or task back to ready; its defer date or what it waited for is cleared.',
    { id: z.string().min(1) },
    async ({ id }) => result(ledger.resume(id, writer)),
  );

  tool(
    'defer',
    'Put a goal or task off until defer_until (YYYY-MM-DD or an ISO datetime with offset), when it is looked at ' +
      'again. A held task is let go; next may leave a line for whoever picks it up.',
    { id: z.string().min(1), defer_until: z.string().optional(), next: z.string().optional() },
    async ({ id, ...extra }) => result(ledger.setState(id, 'deferred', given(extra), writer)),
  );

  tool(
    'wait',
    'Mark a goal or task as waiting: waiting_on is who (the person, a supervisor, a client), waiting_for is what. ' +
      'Something with no one to wait on is not waiting: defer it instead. A held task is let go; next may leave a line.',
    { id: z.string().min(1), waiting_on: z.string().optional(), waiting_for: z.string().optional(), next: z.string().optional() },
    async ({ id, ...extra }) => result(ledger.setState(id, 'waiting', given(extra), writer)),
  );

  tool(
    'place',
    'Register a place (a working directory that belongs to a profile), or change one by id. path: its directory on ' +
      'this device, absolute; null removes this device\'s path. Paths of other devices are set from those devices.',
    { id: z.string().min(1).optional(), name: z.string().optional(), profile: clearable, path: clearable },
    async ({ id, path, ...fields }) => {
      if (typeof path === 'string' && comparablePath(path) === null) {
        return refusal([`path は絶対パスで書きます(${path})`]);
      }
      const paths = path === undefined ? undefined : [{ device: device.name, path }];
      if (id === undefined) {
        if (path === null) return refusal(['新しい置き場では、path を null にはできません']);
        return result(ledger.createPlace(given({ ...fields, paths }), writer));
      }
      if (ledger.get(id)?.kind !== 'place') return refusal([`${id} という置き場はありません`]);
      return result(ledger.updatePlace(id, given({ ...fields, paths }), writer));
    },
  );
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

// The actor recorded for writes through a bearer: the kind of bearer, since the ledger cannot
// tell a person from an AI on the same device. The device is recorded beside it.
const actorFor = (auth) => (auth.clientId === 'device-key' ? 'device-key' : `oauth:${auth.clientId}`);

// req.auth is set by the bearer check before this runs; its device is the caller.
async function handleMcp(ledger, req, res) {
  const server = buildServer(ledger, { name: req.auth.extra.device, actor: actorFor(req.auth) });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

// A fixed window per caller's address: at most `max` requests in each `windowMs`. Windows
// that have ended are swept when many addresses are kept.
function rateLimit({ max, windowMs, now = Date.now }) {
  const hits = new Map();
  return (req, res, next) => {
    const t = now();
    if (hits.size > 10_000) for (const [k, h] of hits) if (h.reset <= t) hits.delete(k);
    let h = hits.get(req.ip);
    if (!h || h.reset <= t) {
      h = { count: 0, reset: t + windowMs };
      hits.set(req.ip, h);
    }
    h.count += 1;
    if (h.count > max) {
      res.status(429).set('Retry-After', String(Math.ceil((h.reset - t) / 1000))).json({ error: 'too many requests' });
      return;
    }
    next();
  };
}

// The HTTP API for scripts such as hooks. Machine keys only: OAuth tokens are issued for /mcp
// alone (their resource), and a script on a machine has its key, not a login.
function apiRouter(ledger, limit) {
  const router = express.Router();
  router.use(rateLimit(limit));
  router.use((req, res, next) => {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
    const device = ledger.deviceForKey(m ? m[1] : null);
    if (!device) {
      res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'a valid device key is required' });
      return;
    }
    req.device = device.name;
    next();
  });
  // The task this device holds in the place dir falls in (outside any place: the one it holds
  // with no place), and that place, each or null.
  router.get('/held', (req, res) => {
    const dir = typeof req.query.dir === 'string' ? req.query.dir : '';
    if (comparablePath(dir) === null) {
      res.status(400).json({ error: 'dir must be an absolute directory path' });
      return;
    }
    const place = ledger.placeFor(req.device, dir);
    const task = ledger.held({ device: req.device, placeId: place?.id ?? null });
    res.json({ task, place: place ? { id: place.id, name: place.name, profile: place.profile } : null });
  });
  return router;
}

// The express app. oauth: the config from oauthConfig(), or null for device keys only.
// github: { webUrl, apiUrl, fetch } stands in for GitHub in tests. log: where errors go.
// trustProxy: express's `trust proxy` (such as 'loopback', or a number of hops), for a server
// behind a tunnel or reverse proxy; then the caller's address, which the rate limits count
// by, is read from X-Forwarded-For. Off when left out. A value express cannot read throws.
// apiLimit: the rate limit of /api per address; a hook may ask on every tool call, so it is generous.
export function createApp({
  ledger,
  oauth = null,
  github,
  trustProxy,
  apiLimit = { max: 600, windowMs: 60_000 },
  log = (line) => process.stderr.write(`${line}\n`),
}) {
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
  app.use('/api', apiRouter(ledger, apiLimit));

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
