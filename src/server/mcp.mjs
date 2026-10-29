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
import { readFileSync } from 'node:fs';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  STATES, MODES, LOADS, BOOKING_KINDS, AUTONOMY_KINDS, AUTONOMY_LEVELS, AUTONOMY_OUTCOMES, REPORT_KINDS, REPORT_BODY_MAX, isValidId,
  ASK_QUESTIONS_MAX, ASK_HEADER_MAX, ASK_OPTIONS_MIN, ASK_OPTIONS_MAX, REPLY_OPTIONS_MAX, REPLY_OPTION_MAX, THREAD_OPTION,
} from '../ledger/rules.mjs';
import { LedgerError, REPORTS_DEFAULT, REPORTS_MAX, MESSAGES_DEFAULT, MESSAGES_MAX, ACTIVITY_MAX_DAYS, ACTIVITY_ITEMS_MAX } from '../ledger/ledger.mjs';
import { comparablePath } from '../ledger/paths.mjs';
import { createOAuth } from './oauth.mjs';
import { rateLimit } from './limit.mjs';
import { createWeb } from './web.mjs';
import { readSettings, writeSettings, LIMIT_DEFAULTS } from '../ledger/settings.mjs';
import { freeTimeFor, FREE_TIME_MAX_DAYS } from '../ledger/freetime.mjs';
import { readContext, writeNote, noteRecordChanges, secretaryConfigured } from '../knowledge/profiles.mjs';

// The version the MCP server reports: the package's.
const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

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

// The tools only the secretary may call: its reports, proposals and questions to the person,
// and the autonomy that says how far it may act alone. Other agents read them but do not write.
// What reply_options says back: the buttons are attached, the question is not written yet.
const REPLY_OPTIONS_NEXT = 'ボタンを付けました。返事の本文に、ボタンで答える問いをそのまま書いてください。ボタンのことは書きません。';
const SECRETARY_TOOLS = new Set(['report', 'propose', 'proposal_done', 'ask', 'reply_options', 'autonomy_outcome', 'autonomy_set']);
// The tools that put, move or remove bookings. While the secretary runs, only it decides the
// time (原則23): other devices ask it with ask_secretary. With the secretary off, anyone may.
const BOOKING_TOOLS = new Set(['book', 'unbook']);
// The longest an agent may wait for the secretary's reply to ask_secretary, in seconds: under
// the 100 seconds after which a tunnel in front of the server (such as Cloudflare's) cuts a
// request that has not answered.
const ASK_SECRETARY_WAIT_MAX = 90;

// Only the arguments that were given, so the ledger sees what the caller meant to change.
const given = (args) => Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));

// Text a caller may clear with null.
const clearable = z.string().nullable().optional();

// One McpServer for one request from `device` ({ name, actor }). knowledge: { home,
// secretary } for the profiles' files (see createApp), or null. thread: the thread the
// request said it runs in (the secretary's thread header), or null for the secretary's
// conversation. secretaryDevice: the device the secretary calls from, null when the secretary
// is off, or undefined to let any device call the secretary's tools. chat: the conversation
// with the secretary (for ask_secretary), or null.
function buildServer(ledger, device, knowledge, thread = null, secretaryDevice = undefined, chat = null) {
  const server = new McpServer({ name: 'warifuri', version: VERSION });
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const writer = { actor: device.actor, device: device.name };

  server.registerTool(
    'board',
    {
      description:
        'List open goals with their tasks, and the tasks with no goal; each task shows who holds it. ' +
        'Under a goal, the tasks you can start now (actionable: ready, every task before it closed) come first; open_before names the earlier tasks still open. ' +
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
      result({
        ...ledger.board({
          dir: place,
          device: device.name,
          profile,
          state,
          mode,
          review: review ?? false,
          includeClosed: include_closed ?? false,
        }),
        ...(secretaryDevice === undefined ? {} : { secretary: secretaryDevice && (chat ? chat.on : true) ? 'on' : 'off' }),
      }),
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
      if (!item) return toolError(`${id} というゴール・タスク・習慣・作業フォルダはありません`);
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
        'untouched for ready_days (30), waiting with no change for waiting_days (14), review: deferred tasks whose ' +
        'defer_until has come (to resume, put off again or drop), and overdue: open tasks past a due date the person ' +
        'set (to follow up). It changes nothing.',
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

  server.registerTool(
    'context',
    {
      description:
        "Read a profile's knowledge before working: people.md and knowledge.md as text, and the file names in " +
        'knowledge/ and procedures/. place: the place id or the directory you work in (its place gives the profile); ' +
        'profile: that profile (wins over place). name: one of the returned file names (such as procedures/release.md), ' +
        'to read that file instead. Text past 64 KiB is cut (truncated: true). Notes marked 未確認 are guesses, not facts. ' +
        "inbox is the profile's inbox.md: agents' notes waiting for the secretary to sort, not yet knowledge.",
      inputSchema: {
        place: z.string().min(1).optional(),
        profile: z.string().min(1).optional(),
        name: z.string().min(1).optional(),
      },
      annotations: readOnly,
    },
    guarded(async ({ place, profile, name }) => {
      const home = knowledgeHome(knowledge);
      const p = profileFor(ledger, device.name, { place, profile }, 'context');
      return result(readContext(home, p, { name }));
    }),
  );

  server.registerTool(
    'schedule',
    {
      description:
        'List the bookings (time given to a task, a habit or a fixed appointment) that share time with [from, to), by ' +
        'start. from and to: YYYY-MM-DD (midnight on the server\'s clock) or an ISO datetime with offset; to is ' +
        'exclusive, so from 2026-11-01 to 2026-11-03 is two days. from defaults to today, to to one day after from. ' +
        'Each booking comes with its task (title, state), habit, goal and profile, and its source and external_id ' +
        '(the outside event it is, or null).',
      inputSchema: { from: z.string().min(1).optional(), to: z.string().min(1).optional() },
      annotations: readOnly,
    },
    guarded(async ({ from, to }) => result(ledger.schedule({ from, to }))),
  );

  server.registerTool(
    'activity',
    {
      description:
        "What moved in [from, to), from the ledger's own records of goals and tasks: created, started, released " +
        '(let go, with its next line), waiting, deferred, resumed, done (with result), discarded (with reason), ' +
        'reopened. from and to as in schedule; from defaults to yesterday 00:00, to to now; at most ' +
        `${ACTIVITY_MAX_DAYS} days. Returns { from, to, counts: { <kind>: n }, goals: [{ id, title, items }] (the goals ` +
        `that moved, most first), items: [{ at, kind, entity, id, title, device, actor, goal, profile, and result, ` +
        `reason, next, waiting_on, waiting_for or defer_until where they apply }] (newest first, at most ` +
        `${ACTIVITY_ITEMS_MAX}), more (items cut) }. Commits and merges are not in the ledger and do not appear.`,
      inputSchema: { from: z.string().min(1).optional(), to: z.string().min(1).optional() },
      annotations: readOnly,
    },
    guarded(async ({ from, to }) => result(ledger.activity({ from, to }))),
  );

  server.registerTool(
    'free_time',
    {
      description:
        "The person's free time in [from, to) where a task can be placed, inside their limits (settings). from and to " +
        `as in schedule (from defaults to today, to to one day after from); at most ${FREE_TIME_MAX_DAYS} days. Returns ` +
        '{ from, to, limits, days: [{ date, booked_hours, remaining_hours, habits_to_place, free: [{ starts_at, ends_at, ' +
        'minutes }] }] }, one entry per local day. Free time is only between limits.earliest and latest, avoids every ' +
        'booking, and leaves out slots shorter than block_min_minutes. habits_to_place: habits of that day not booked ' +
        'yet, each placed at the earliest spot in its window (starts_at null when it fits nowhere); their time is kept ' +
        'out of free, so book them first. booked_hours counts task and habit bookings inside earliest-latest (not ' +
        'fixed ones); remaining_hours is day_max_hours minus that and the habits to place, and free never adds up to ' +
        'more: slots are offered from the earliest and the last one is cut. A slot may be longer than ' +
        'limits.block_max_minutes; cut it into blocks of at most that length when booking.',
      inputSchema: { from: z.string().min(1).optional(), to: z.string().min(1).optional() },
      annotations: readOnly,
    },
    guarded(async ({ from, to }) => result(freeTimeFor(ledger, { from, to }))),
  );

  server.registerTool(
    'autonomy',
    {
      description:
        "List the secretary's autonomy (原則13) for each kind of action: level ask (ask before acting) or " +
        'act_then_tell (act, then tell the person), approvals_in_row, revokes, and by_person (the level was set by ' +
        "the person's word). streak is the approvals in a row that raise a kind. Kinds that go outside or cannot be undone are never allowed.",
      inputSchema: {},
      annotations: readOnly,
    },
    async () => result(ledger.listAutonomy()),
  );

  // Loose types here, so the ledger says in Japanese what is wrong.
  server.registerTool(
    'reports',
    {
      description:
        `Read the secretary's reports, newest first: { reports: [{ id, kind, title, body, device, created_at }], next_before }. ` +
        `kind: only ${REPORT_KINDS.join(', ')}. limit: how many (default ${REPORTS_DEFAULT}, at most ${REPORTS_MAX}). before: a ` +
        "report's id or an ISO datetime with offset, for only older ones; pass next_before to read the next page (null: no more).",
      inputSchema: { kind: z.string().optional(), limit: z.number().optional(), before: z.string().optional() },
      annotations: readOnly,
    },
    guarded(async ({ kind, limit, before }) => result(ledger.listReports({ kind, limit, before }))),
  );

  server.registerTool(
    'proposals',
    {
      description:
        "Read the secretary's proposals (made with propose) in the order to act on them: { proposals: [{ id, autonomy_kind, " +
        'title, body, about, state, answer, answered_at, done_at, done_note, created_at }] }. which: to_do (the default: ' +
        "approved or changed by the person and not carried out yet; answer holds the person's words for changed), open " +
        `(not answered yet), or recent (any state, newest first). limit: how many (default ${MESSAGES_DEFAULT}, at most ${MESSAGES_MAX}).`,
      inputSchema: { which: z.enum(['to_do', 'open', 'recent']).optional(), limit: z.number().optional() },
      annotations: readOnly,
    },
    guarded(async ({ which, limit }) =>
      result({
        proposals: ledger.listProposals({ which, limit }).map((m) => ({
          id: m.id, autonomy_kind: m.autonomy_kind, title: m.title, body: m.body, about: m.about, state: m.state, answer: m.answer,
          answered_at: m.answered_at, done_at: m.done_at, done_note: m.done_note, created_at: m.created_at,
        })),
      })),
  );

  registerWriteTools(server, ledger, device, { write, writer, knowledge, thread, secretaryDevice, chat });
  return server;
}

// The data directory of the profiles, or a refusal when the server has none.
function knowledgeHome(knowledge) {
  if (!knowledge?.home) throw new LedgerError(['このサーバーには、プロフィールのフォルダが設定されていません']);
  return knowledge.home;
}

// Whether agents' notes go to the inbox: the secretary setting given to createApp, or else
// whether plugins.yaml lists the secretary (read on each note, so no restart is needed).
const secretaryOn = (knowledge) => knowledge.secretary ?? secretaryConfigured(knowledge.home);

// The profile named by profile, or else by the place (id or directory) it falls in.
function profileFor(ledger, device, { place, profile }, tool) {
  if (profile !== undefined) return profile;
  if (place === undefined) throw new LedgerError([`${tool} には place か profile を渡します`]);
  const p = resolvePlace(ledger, device, place, tool);
  if (!p.profile) throw new LedgerError([`作業フォルダ ${p.name}(${p.id})には、プロフィールが付いていません。place で付けます`]);
  return p.profile;
}

// Appends a note to a profile's files and records it in the ledger as entity 'knowledge'.
function addNote(ledger, knowledge, profile, { text, kind, task }, device, writer) {
  const from = { device: device.name, task };
  const note = writeNote(knowledge.home, profile, { text, kind, secretary: kind === 'agent' && secretaryOn(knowledge), from });
  ledger.recordNote(profile, noteRecordChanges({ kind, file: note.file, mark: note.mark, text, from }), writer);
  return note;
}

// A place given as its id, or as a directory on the caller's device (the deepest place
// containing it). Throws a LedgerError naming what to do when neither finds one; tool is
// the tool to call again.
function resolvePlace(ledger, device, value, tool = 'start') {
  const item = ledger.get(value);
  if (item?.kind === 'place') return item;
  if (comparablePath(value) !== null) {
    const place = ledger.placeFor(device, value);
    if (place) return place;
    throw new LedgerError([
      `${value} は、デバイス ${device} のどの作業フォルダにも入っていません。place で作業フォルダを登録するか、いまの作業フォルダにこのデバイスのパスを足してから、もう一度 ${tool} します`,
    ]);
  }
  if (isValidId(value)) throw new LedgerError([`作業フォルダ ${value} がありません`]);
  throw new LedgerError([`place には作業フォルダの id か、絶対パスのディレクトリを渡します(${value} はどちらでもありません)`]);
}

function registerWriteTools(server, ledger, device, { write, writer, knowledge, thread, secretaryDevice, chat }) {
  const tool = (name, description, inputSchema, fn, annotations = write) =>
    server.registerTool(name, { description, inputSchema, annotations }, guarded(onlyFor(name, fn)));
  // Whether the secretary runs: a secretary device is set and, when the conversation is
  // given, it can answer. Bookings go through it only then, so nobody is left without a way.
  const secretaryRuns = typeof secretaryDevice === 'string' && (chat ? chat.on : true);
  // The secretary's tools refuse other devices (and everyone while the secretary is off).
  const onlyFor = (name, fn) => {
    if (BOOKING_TOOLS.has(name)) {
      if (!secretaryRuns || device.name === secretaryDevice) return fn;
      return async () => refusal([
        `秘書が有効なので、予定は秘書が決めます(原則23)。${name} の代わりに ask_secretary で、何に、どれくらいの長さ、いつまでに、希望の時間帯(本人が日時を決めているならその日時)を渡して頼んでください`,
      ]);
    }
    if (!SECRETARY_TOOLS.has(name) || secretaryDevice === undefined || device.name === secretaryDevice) return fn;
    const why = secretaryDevice === null
      ? `秘書が有効になっていないので、${name} は使えません`
      : `${name} は秘書だけが使えるツールです。ユーザーには、秘書の画面で頼むよう伝えてください`;
    return async () => refusal([why]);
  };

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
      'A task that takes a person\'s time needs done_when. place_id: the place it belongs to (board shows the one you are in). ' +
      'after: the ids of the tasks that come before it. Under a goal that already has open tasks, after is required: ' +
      'decide the order when you create the task (after: [] says it runs alongside them on purpose). When you make a goal ' +
      'and its tasks, create them in the order they will be done, each with after set to the one before.',
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
      after: z.array(z.string().min(1)).optional(),
    },
    async (args) => {
      // 原則3: under a goal that already has open tasks, the order is decided when the task is
      // made. after: [] says on purpose that it runs alongside them.
      if (args.goal_id && args.after === undefined) {
        const open = (ledger.get(args.goal_id)?.tasks ?? []).filter((t) => !['done', 'discarded'].includes(t.state));
        if (open.length) {
          return refusal([
            `ゴールには開いているタスクが ${open.length} 件あります(${open.slice(0, 5).map((t) => `${t.id}「${t.title}」`).join('、')})。順序を決めて、前に終わらせるタスクの id を after に渡します。並べて進めてよいときは after: [] を渡します(原則3)`,
          ]);
        }
      }
      return result(ledger.createTask(given(args), writer));
    },
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
      'A task held elsewhere moves here. A task whose earlier tasks are still open can be started; the answer names them in open_before.',
    { task_id: z.string().min(1), place: z.string().min(1) },
    async ({ task_id: taskId, place: value }) => {
      const place = resolvePlace(ledger, device.name, value);
      const before = ledger.get(taskId)?.hold ?? null;
      try {
        const task = ledger.start(taskId, { device: device.name, placeId: place.id }, writer);
        const moved = before && (before.device !== device.name || before.place_id !== place.id);
        // The order is a plan, not a lock (原則3): starting early is allowed, and said.
        const open = ledger.openBefore(taskId);
        const notice = open.length ? { open_before: open, notice: `前のタスク ${open.join(', ')} がまだ閉じていません。順序どおりでなくてよいか確かめてください` } : {};
        return result({ ...task, ...(moved ? { moved_from: before } : {}), ...notice });
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
      if (next.trim() === '') return refusal(['手放すときは、次に着手する人のために next を1行書きます(原則7)']);
      if (/[\r\n]/.test(next)) return refusal(['next は1行で書きます。長い説明は update で body に書きます']);
      return result(ledger.release(taskId, { next }, writer));
    },
  );

  tool(
    'close',
    'Close a goal or task once you have checked the real thing: state done with a one-line result, or discarded ' +
      'with a reason. A held task is let go; next may leave a line for whoever reopens it. learned: what the work ' +
      'taught that is worth keeping, in 1–3 lines; it is kept in the record of this close and also written as an ' +
      "agent's note to the profile of the goal or task (as note with kind agent does). noted says where it went.",
    {
      id: z.string().min(1),
      state: z.enum(['done', 'discarded']),
      result: z.string().optional(),
      reason: z.string().optional(),
      learned: z.string().optional(),
      next: z.string().optional(),
    },
    async ({ id, state, ...extra }) => {
      const closed = ledger.setState(id, state, given(extra), writer);
      if (extra.learned === undefined) return result(closed);
      return result({ ...closed, noted: noteLearned(id, extra.learned) });
    },
  );

  // The close is already written, so a note that cannot be written is reported, not thrown.
  function noteLearned(id, text) {
    const profile = ledger.get(id)?.profile ?? null;
    if (!knowledge?.home) return { skipped: 'このサーバーには、プロフィールのフォルダが設定されていません。閉じたときの記録にだけ残しました' };
    if (!profile) return { skipped: 'プロフィールが分からないので、閉じたときの記録にだけ残しました' };
    try {
      const n = addNote(ledger, knowledge, profile, { text, kind: 'agent', task: id }, device, writer);
      return { profile, file: n.file, mark: n.mark };
    } catch (err) {
      const why = err instanceof LedgerError ? err.problems.join('。') : err.message;
      return { skipped: `ナレッジに書けなかったので、閉じたときの記録にだけ残しました(${why})` };
    }
  }

  tool(
    'note',
    "Write to a profile's knowledge; it only appends. kind human: the person's own words, said in this " +
      'conversation; they go straight into knowledge.md marked 本人の言葉. kind agent: your own insight; it goes ' +
      "to the profile's inbox.md for the secretary to sort, or, with no secretary, into knowledge.md marked 未確認. " +
      'Write facts and rules of the area in 1–3 lines, not progress. profile, or place (the place id or the directory ' +
      'you work in) to use its profile. At most 4000 characters.',
    {
      profile: z.string().min(1).optional(),
      place: z.string().min(1).optional(),
      text: z.string(),
      kind: z.enum(['human', 'agent']),
    },
    async ({ profile, place, text, kind }) => {
      knowledgeHome(knowledge);
      const p = profileFor(ledger, device.name, { place, profile }, 'note');
      const n = addNote(ledger, knowledge, p, { text, kind }, device, writer);
      return result({ profile: p, file: n.file, mark: n.mark, entry: n.entry });
    },
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
    'book',
    'Book time: kind task (task_id) or habit (habit_id) gives time to it, and its title defaults to theirs; kind ' +
      'fixed is an appointment and needs a title. starts_at and ends_at: ISO datetimes with offset (Z or +09:00), ' +
      'stored in UTC; at most 24 hours. With id, changes that booking (only the fields given change). Bookings may ' +
      'overlap: overlaps lists the ones sharing time with this one, so you can move one if that was not meant. ' +
      'source (such as google-calendar) and external_id (the event id there) name the outside event the booking is: ' +
      'without id, a pair already in the ledger changes that booking instead of making a second one, so importing ' +
      'an event again is safe; with id, attaches the pair (for an event you just wrote there), unless another ' +
      'booking has it. external_id needs source. note: a note, such as an outside event\'s description; location: where it is; organizer: who made it (such as an email address).',
    {
      id: z.string().min(1).optional(),
      kind: z.enum(BOOKING_KINDS).optional(),
      task_id: clearable,
      habit_id: clearable,
      title: z.string().optional(),
      starts_at: z.string().optional(),
      ends_at: z.string().optional(),
      note: clearable,
      location: clearable,
      organizer: clearable,
      source: clearable,
      external_id: clearable,
    },
    async (args) => result(ledger.book(given(args), writer)),
  );

  tool(
    'unbook',
    'Delete a booking. The task or habit it gave time to stays; the record keeps the booking as it was.',
    { id: z.string().min(1) },
    async ({ id }) => result(ledger.unbook(id, writer)),
    { ...write, destructiveHint: true },
  );

  tool(
    'ask_secretary',
    'Ask the secretary for something, while the secretary runs (board shows secretary: on). Above all for time: ' +
      'the secretary alone books, moves and removes bookings then (book and unbook refuse other devices). Do not ' +
      'pick the time yourself: give what it is for (task_id), how long (minutes), by when (by), and what is ' +
      'preferred (prefer, such as mornings); when the person already set the time, give starts_at and ends_at. ' +
      'text says the rest in plain words the person can read too: no tool names (book, unbook, note), ids or field ' +
      'names, since it is shown to the person as it is. The request goes into the secretary\'s conversation, which the person ' +
      `sees, and this waits up to wait_seconds (at most ${ASK_SECRETARY_WAIT_MAX}, the default) for the reply: ` +
      'status answered gives the secretary\'s reply to pass on to the person; status waiting means the request ' +
      'stays there and the secretary takes it when it can: tell the person it was asked and the answer will be ' +
      'in the secretary\'s window. With the secretary off this refuses: use free_time and book instead.',
    {
      text: z.string(),
      task_id: z.string().optional(),
      minutes: z.number().int().positive().max(24 * 60).optional(),
      by: z.string().optional(),
      prefer: z.string().optional(),
      starts_at: z.string().optional(),
      ends_at: z.string().optional(),
      wait_seconds: z.number().int().min(0).max(ASK_SECRETARY_WAIT_MAX).optional(),
    },
    async ({ wait_seconds, ...fields }) => {
      if (!secretaryRuns || !chat) {
        return refusal(['秘書が有効になっていないので、頼めません。free_time で空き時間を見て、本人の了承を得てから book で入れます']);
      }
      if (device.name === secretaryDevice) return refusal(['秘書は自分に頼めません']);
      const out = await chat.request({ from: device.name, ...fields }, writer, { waitMs: (wait_seconds ?? ASK_SECRETARY_WAIT_MAX) * 1000 });
      if (out.timedOut) {
        return result({ status: 'waiting', request_id: out.request.id, say: '秘書に頼みました。決まったら秘書の画面に出ます' });
      }
      if (!out.reply) {
        return result({ status: 'not_answered', request_id: out.request.id, say: '秘書が返事を作れませんでした。秘書の画面を見て、もう一度頼んでください' });
      }
      return result({ status: 'answered', request_id: out.request.id, reply: out.reply.body });
    },
  );

  tool(
    'report',
    `Write a report for the person to read in the Web screens: kind nightly (the nightly check), morning (the morning ` +
      `summary) or inbox (the inbox tidy-up), a one-line title, and the body as plain text or light Markdown (at most ` +
      `${REPORT_BODY_MAX} characters). Reports are only added, never changed. Returns the stored report.`,
    { kind: z.string(), title: z.string(), body: z.string() },
    async (args) => result(ledger.writeReport(args, writer)),
  );

  const autonomyKind = z.enum(AUTONOMY_KINDS.map((k) => k.kind));

  tool(
    'propose',
    'Leave a proposal in the ledger, for an action whose kind is at ask (原則13), from a run the person is not in (the ' +
      'nightly run). kind: the autonomy kind it falls under; title: one line; body: what happened, why now, and the one ' +
      'thing you recommend, in plain text. about: the goal or task it concerns. The secretary of the conversation asks ' +
      'the person about open proposals with ask (naming the proposal), and warifuri records the answer on it and with ' +
      'autonomy_outcome itself; read answered ones with proposals and mark each with proposal_done once carried out. ' +
      'Returns the stored proposal.',
    { kind: autonomyKind, title: z.string(), body: z.string(), about: z.string().min(1).optional() },
    async (args) => result(ledger.propose(given(args), writer)),
  );

  // The questions as AskUserQuestion takes them; loose here, so the ledger says in Japanese
  // what is wrong.
  const question = z
    .object({
      header: z.string().optional(),
      question: z.string().optional(),
      options: z.array(z.object({ label: z.string().optional(), description: z.string().optional() }).passthrough()).optional(),
      multiSelect: z.boolean().optional(),
      kind: autonomyKind.optional(),
      about: z.string().optional(),
      proposal: z.string().optional(),
    })
    .passthrough();
  // The conversation a question or a button goes to: the one named, else the one this run of
  // the secretary is in, else the secretary's conversation.
  const threadArg = (given) => given ?? thread ?? undefined;

  tool(
    'ask',
    "Ask the person questions in the secretary's window, the same way as Claude Code's AskUserQuestion: 1 to " +
      `${ASK_QUESTIONS_MAX} questions, each with header (a short label shown over it, at most ${ASK_HEADER_MAX} characters, ` +
      'such as タスク整理 or 期日), question (one sentence ending in ?), options (' +
      `${ASK_OPTIONS_MIN} to ${ASK_OPTIONS_MAX}, each { label, description }; put the one you recommend first: the window ` +
      'marks it おすすめ) and multiSelect. The window always adds その他 for the person\'s own words, so never add one. ' +
      'Put everything you want to ask into one call: while a question in the conversation is still waiting for its ' +
      'answers, a new ask is refused. The questions are shown one at a time on one card; the answers come to you ' +
      'together in your next turn, once all of them are answered (or the person picks あとで). Do not act on what you ' +
      'asked until then. Optional per question: kind, the autonomy kind the action falls under (原則13): warifuri then records the ' +
      'answer itself (the first option alone is approved, its own words changed, any other option refused), so do not ' +
      'call autonomy_outcome for it; about, the goal or task; proposal, the id of an open proposal (from the nightly ' +
      'run) the question asks about: the answer is recorded on it too. When the person changes an earlier answer, ' +
      'you are told: undo what the old answer had you do, then do the new one. thread: the conversation to ask in ' +
      '(left out: the one you are talking in). Returns the stored question.',
    { questions: z.array(question), thread: z.string().min(1).optional() },
    async ({ questions, thread: t }) => result(ledger.ask(given({ questions, thread: threadArg(t) }), writer)),
  );

  tool(
    'reply_options',
    `Put 1 to ${REPLY_OPTIONS_MAX} reply buttons under the reply you are writing now, when it ends in a question such as ` +
      `「〜しますか？」: each a short reply in the person's words (at most ${REPLY_OPTION_MAX} characters), the one you ` +
      'recommend first (it is shown as the main button). Pressing one sends its words as the person\'s message; the ' +
      'person may also just type. To offer a thread, give exactly ' +
      `「${THREAD_OPTION}」 and 「ここで続ける」: pressing ${THREAD_OPTION} opens a thread from your reply instead of ` +
      'sending. The buttons only answer: your reply itself must still ask the question in full, in Japanese, and ' +
      'never mention the buttons. Call it once per reply, before you finish; a later call replaces the buttons.',
    { options: z.array(z.string()), thread: z.string().min(1).optional() },
    async ({ options, thread: t }) => {
      const id = threadArg(t) ?? ledger.ensureThread('secretary', writer).id;
      const out = ledger.setReplyOptions(id, options, writer);
      return result({ thread: out.id, options: JSON.parse(out.pending_options), next: REPLY_OPTIONS_NEXT });
    },
  );

  tool(
    'proposal_done',
    'Mark an approved (or changed) proposal as carried out, with note: one line of what was done. Call it after doing ' +
      'what the person approved, so it is not done twice.',
    { id: z.string().min(1), note: z.string().optional() },
    async ({ id, note }) => result(ledger.markProposalDone(id, { note }, writer)),
  );

  tool(
    'autonomy_outcome',
    "Record how the person answered one of the secretary's proposals of a kind (原則13). outcome: approved (as " +
      'proposed), changed (approved with changes), refused, or revoked (the person cancelled it after it was done). ' +
      'Approvals in a row raise the kind to act_then_tell; a revoke brings it back to ask. about: the goal or task it ' +
      'concerned; approvals in a goal the person leads are not counted. When level_changed is set, tell the person ' +
      'announce, once.',
    { kind: autonomyKind, outcome: z.enum(AUTONOMY_OUTCOMES), about: z.string().min(1).optional() },
    async ({ kind, outcome, about }) => result(ledger.recordAutonomyOutcome(kind, outcome, { about }, writer)),
  );

  tool(
    'autonomy_set',
    "Set a kind's level directly, only on the person's explicit word: act_then_tell for 「これは聞かなくていい」, " +
      'ask for 「これは毎回聞いて」. by_person must be true, or it is refused; said: their words. The run of approvals ' +
      'starts again, and a kind the person set to ask is not raised by approvals.',
    { kind: autonomyKind, level: z.enum(AUTONOMY_LEVELS), by_person: z.boolean().optional(), said: z.string().optional() },
    async ({ kind, level, by_person: byPerson, said }) =>
      result(ledger.setAutonomyByPerson(kind, level, { by_person: byPerson, said }, writer)),
  );

  // One tool reads and writes, so it is not marked read-only; without a section it only reads.
  const d = LIMIT_DEFAULTS;
  tool(
    'settings',
    "Read or write the person's own settings that scheduling uses. With no section given it only reads, returning " +
      'life, places and limits with defaults filled in (defaults lists the fields still unset). life: { rules: [one-line ' +
      'text] } for sleep, meals and fixed commitments, as plain rules. places: { places: [{ name, note }], travel: ' +
      '[{ from, to, minutes }] } for the physical places the person goes to and the travel time between two of them ' +
      '(both ways; not the working folders of the places tool). life and places are replaced as given. limits: ' +
      `{ day_max_hours (default ${d.day_max_hours}), block_min_minutes (${d.block_min_minutes}), block_max_minutes ` +
      `(${d.block_max_minutes}), earliest ('${d.earliest}'), latest ('${d.latest}') }, times as HH:MM; only the fields ` +
      'given change, null puts one back to its default. Limits are the person\'s to change: write them only when the ' +
      'person decided it in this conversation, with by_person: true; otherwise propose the change to them instead. ' +
      'A section given as null goes back to its defaults.',
    {
      life: z.record(z.string(), z.unknown()).nullable().optional(),
      places: z.record(z.string(), z.unknown()).nullable().optional(),
      limits: z.record(z.string(), z.unknown()).nullable().optional(),
      by_person: z.boolean().optional(),
    },
    async ({ by_person: byPerson, ...sections }) => {
      const input = given(sections);
      if (Object.keys(input).length === 0) return result(readSettings(ledger));
      return result(writeSettings(ledger, input, { byPerson }, writer));
    },
  );

  tool(
    'habit',
    'Make, change or stop a habit (something that repeats and never ends: a weekly meeting, exercise, sleep). ' +
      'Without id, makes one: title, rule and duration_min (minutes) are needed. rule: { days, window? }; days is ' +
      '"daily", "weekdays" (月〜金) or a list such as ["月","水","金"]; window such as "07:00-07:30" is the part of the ' +
      'day it goes in (an end not after the start runs past midnight), and duration_min must fit in it. goal_id links ' +
      'it to a goal. With id, changes only the fields given; stop: true stops it (it is kept with its records, not ' +
      'deleted), and active: true starts a stopped one again.',
    {
      id: z.string().min(1).optional(),
      title: z.string().optional(),
      // Loose here, so the ledger's checks say in Japanese what is wrong with a rule.
      rule: z
        .object({ days: z.union([z.enum(['daily', 'weekdays']), z.array(z.string())]).optional(), window: z.string().optional() })
        .passthrough()
        .optional(),
      duration_min: z.number().int().optional(),
      goal_id: clearable,
      active: z.boolean().optional(),
      stop: z.boolean().optional(),
    },
    async ({ id, stop, ...fields }) => {
      const change = given(fields);
      if (id === undefined) {
        if (stop) return refusal(['止める習慣の id を渡します']);
        return result(ledger.createHabit(change, writer));
      }
      if (ledger.get(id)?.kind !== 'habit') return refusal([`${id} という習慣はありません`]);
      if (!stop) return result(ledger.updateHabit(id, change, writer));
      if (Object.keys(change).length) return refusal(['stop と一緒には、ほかの項目を渡せません。直すときは別に呼びます']);
      return result(ledger.stopHabit(id, writer));
    },
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
        if (path === null) return refusal(['新しい作業フォルダでは、path を null にはできません']);
        return result(ledger.createPlace(given({ ...fields, paths }), writer));
      }
      if (ledger.get(id)?.kind !== 'place') return refusal([`${id} という作業フォルダはありません`]);
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
    ledger.markSeen(device.name);
    req.auth = { token: m[1], clientId: 'device-key', scopes: [], extra: { device: device.name } };
    next();
  };
}

// The actor recorded for writes through a bearer: the kind of bearer, since the ledger cannot
// tell a person from an AI on the same device. The device is recorded beside it.
const actorFor = (auth) => (auth.clientId === 'device-key' ? 'device-key' : `oauth:${auth.clientId}`);

// req.auth is set by the bearer check before this runs; its device is the caller.
// The thread a run of the secretary says it is in (secretary.mjs's THREAD_HEADER), when there is
// such a thread; it only chooses where ask and reply_options land, never who may write.
function threadOf(ledger, req) {
  const id = req.headers['x-warifuri-thread'];
  if (typeof id !== 'string' || !isValidId(id)) return null;
  return ledger.getThread(id) ? id : null;
}

async function handleMcp(ledger, knowledge, req, res, secretaryDevice, chat) {
  const server = buildServer(ledger, { name: req.auth.extra.device, actor: actorFor(req.auth) }, knowledge, threadOf(ledger, req), secretaryDevice, chat);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

// The HTTP API for scripts such as hooks. Machine keys only: OAuth tokens are issued for /mcp
// alone (their resource), and a script on a machine has its key, not a login.
function apiRouter(ledger, limit, secretaryRuns = () => false) {
  const router = express.Router();
  router.use(rateLimit(limit));
  router.use((req, res, next) => {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
    const device = ledger.deviceForKey(m ? m[1] : null);
    if (!device) {
      res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'a valid device key is required' });
      return;
    }
    ledger.markSeen(device.name);
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
  // Whether the secretary runs (the same on as board's): the calendar hook stops an agent's
  // own calendar writes while it does (原則23).
  router.get('/secretary', (req, res) => {
    res.json({ secretary: secretaryRuns() ? 'on' : 'off' });
  });
  return router;
}

// The express app. oauth: the config from oauthConfig(), or null for device keys only.
// github: { webUrl, apiUrl, fetch } stands in for GitHub in tests. log: where errors go.
// trustProxy: express's `trust proxy` (such as 'loopback', or a number of hops), for a server
// behind a tunnel or reverse proxy; then the caller's address, which the rate limits count
// by, is read from X-Forwarded-For. Off when left out. A value express cannot read throws.
// apiLimit: the rate limit of /api per address; a hook may ask on every tool call, so it is generous.
// home: the data directory, whose profiles/ the context and note tools use; without it they
// refuse. secretary: true or false says whether agents' notes go to the inbox; left out, it
// is read from plugins.yaml in home on each note.
// host: the address the server listens on, and publicUrl the public URL (WARIFURI_PUBLIC_URL,
// also when the GitHub login is off): together with trustProxy they decide whether the Web
// screens (web.mjs) open without a login. chat: the conversation with the secretary
// (src/secretary/chat.mjs) for the 秘書 screen, or null. app.locals.web is { mode, issueLogin }.
// secretaryDevice: the device the secretary calls from (only it may use the secretary's tools),
// serverDevices: other devices of the server machine (such as a program running beside it),
// left out of the Web screens' devices as the secretary's is.
// null when the secretary is off (nobody may), or left out to let any device. While it is set
// (and chat, when given, can answer), only that device may book and unbook; the others ask it
// with ask_secretary.
export function createApp({
  ledger,
  home = null,
  secretary,
  oauth = null,
  github,
  trustProxy,
  apiLimit = { max: 600, windowMs: 60_000 },
  host = '127.0.0.1',
  publicUrl = oauth?.publicUrl ?? null,
  webLimit = apiLimit,
  chat = null,
  secretaryDevice,
  serverDevices = [],
  log = (line) => process.stderr.write(`${line}\n`),
}) {
  const app = express();
  app.disable('x-powered-by');
  if (trustProxy !== undefined) app.set('trust proxy', /^\d+$/.test(String(trustProxy)) ? Number(trustProxy) : trustProxy);
  app.get('/health', (req, res) => sendText(res, 200, 'ok'));

  let auth = deviceKeyAuth(ledger);
  let web;
  if (oauth) {
    const { router, bearer } = createOAuth({ ledger, config: oauth, github, log, webLogin: (res) => web.finishLogin(res) });
    app.use(router);
    auth = bearer;
  }
  const knowledge = home ? { home, secretary } : null;
  const mcp = (req, res) =>
    handleMcp(ledger, knowledge, req, res, secretaryDevice, chat).catch((err) => {
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
  app.use('/api', apiRouter(ledger, apiLimit, () => typeof secretaryDevice === 'string' && (chat ? chat.on : true)));
  web = createWeb({
    ledger, home, host, publicUrl, trustProxy, githubUser: oauth?.githubUser ?? null, githubLogin: Boolean(oauth), chat, limit: webLimit,
    secretaryDevice: typeof secretaryDevice === 'string' ? secretaryDevice : null, serverDevices,
  });
  app.use(web.router);
  app.locals.web = { mode: web.mode, issueLogin: web.issueLogin };

  app.use((req, res) => sendText(res, 404, 'not found'));
  // Errors from the routes above; the message may come from a library, so it is not echoed.
  app.use((err, req, res, _next) => {
    log(`warifuri: ${req.method} ${req.path} failed: ${err.message}`);
    if (res.headersSent) return res.end();
    return sendText(res, err.status && err.status < 500 ? err.status : 500, err.status && err.status < 500 ? 'bad request' : 'internal error');
  });
  return app;
}

// The HTTP server; server.web is the app's { mode, issueLogin } for the Web screens.
export function createServer(options) {
  const app = createApp(options);
  const server = http.createServer(app);
  server.web = app.locals.web;
  return server;
}
