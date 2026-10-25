// The ledger: goals, tasks, their order, holds, habits, places, devices and the secretary's
// autonomy levels, reports and the conversation with the secretary (threads and messages), kept in one SQLite file through node:sqlite. Every write is
// checked against rules.mjs, runs in one transaction and appends one row to `records` (who
// changed what, from which device, before/after). A refused write changes nothing and throws
// a LedgerError carrying every problem found.
// replaceFromSnapshot() is the one write that takes rows breaking the rules: it stores them
// with `review` set, and the next write to such a row must pass the rules (which clears it).
// Bookings (予定) give time to a task, a habit or a fixed appointment; they may overlap, and
// unlike tasks they may be deleted (unbook), with the deleted row kept in the record.
// Devices hold the keys for the MCP endpoint; only a hash of each key is stored. OAuth
// clients, codes and tokens (oauth.mjs) also resolve to a device, and are stored as hashes too.
// Nothing is hidden from a reader: whoever may open the ledger sees all of it.

import { DatabaseSync } from 'node:sqlite';
import { randomInt, randomBytes, createHash } from 'node:crypto';
import { migrate } from './schema.mjs';
import { checkEnvelope, prepareSnapshot } from './snapshot.mjs';
import { comparablePath, deepestContaining } from './paths.mjs';
import { renderFlow } from './flow.mjs';
import { oauthStore } from './oauth.mjs';
import {
  STATES,
  CLOSED_STATES,
  REPORT_KINDS,
  THREAD_KINDS,
  THREAD_RUNNERS,
  PROPOSAL_ANSWERS,
  ANSWER_MAX,
  charLength,
  HUMAN_TIME_MODES,
  ALL_STATE_FIELDS,
  RELEASING_STATES,
  isValidId,
  isValidDateTime,
  checkActor,
  checkWriterDevice,
  checkGoal,
  checkGoalTakesHumanTask,
  checkTask,
  checkBlock,
  checkHabit,
  habitRuleText,
  readHabitRule,
  checkPlace,
  checkBooking,
  checkReport,
  checkMessage,
  checkProposal,
  checkAutonomy,
  checkStateExtra,
  AUTONOMY_KINDS,
  AUTONOMY_OUTCOMES,
  AUTONOMY_STREAK,
  applyState,
} from './rules.mjs';

export class LedgerError extends Error {
  // details: extra fields for the caller, such as heldTaskId when start() is refused.
  constructor(problems, details = {}) {
    super(problems.join(' / '));
    this.name = 'LedgerError';
    this.problems = problems;
    Object.assign(this, details);
  }
}

const GOAL_COLUMNS = [
  'id', 'title', 'outcome', 'due', 'due_provisional', 'state', 'mode', 'human_led', 'profile',
  'waiting_on', 'waiting_for', 'result', 'reason', 'defer_until', 'review', 'created_at', 'updated_at', 'closed_at',
];
const TASK_COLUMNS = [
  'id', 'title', 'body', 'done_when', 'goal_id', 'state', 'mode', 'load', 'estimate_min', 'due', 'due_provisional',
  'place_id', 'waiting_on', 'waiting_for', 'result', 'reason', 'defer_until', 'next', 'delegated', 'review',
  'created_at', 'updated_at', 'closed_at',
];
const HABIT_COLUMNS = ['id', 'title', 'rule', 'duration_min', 'goal_id', 'active', 'created_at', 'updated_at'];
const PLACE_COLUMNS = ['id', 'name', 'profile', 'created_at', 'updated_at'];
const BOOKING_COLUMNS = [
  'id', 'title', 'kind', 'task_id', 'habit_id', 'starts_at', 'ends_at', 'note', 'source', 'external_id', 'created_at', 'updated_at',
];
// Fields book() takes; id names the booking to change.
const BOOKING_FIELDS = ['id', 'title', 'kind', 'task_id', 'habit_id', 'starts_at', 'ends_at', 'note', 'source', 'external_id'];

// Fields a caller may change with update(); state and its fields go through setState().
const GOAL_EDITABLE = ['title', 'outcome', 'due', 'due_provisional', 'mode', 'human_led', 'profile'];
const TASK_EDITABLE = [
  'title', 'body', 'done_when', 'due', 'due_provisional', 'mode', 'load', 'goal_id', 'estimate_min', 'place_id',
  'next', 'delegated',
];
const HABIT_EDITABLE = ['title', 'rule', 'duration_min', 'goal_id', 'active'];
const FLAG_FIELDS = ['due_provisional', 'human_led', 'active', 'delegated'];
const REPORT_COLUMNS = ['id', 'kind', 'title', 'body', 'device', 'created_at'];
// How many reports one read returns: by default, and at most.
export const REPORTS_DEFAULT = 10;
export const REPORTS_MAX = 50;
const THREAD_COLUMNS = ['id', 'kind', 'title', 'runner', 'session_id', 'seen_until', 'created_at', 'updated_at'];
const MESSAGE_COLUMNS = [
  'id', 'thread_id', 'role', 'kind', 'body', 'title', 'autonomy_kind', 'about', 'state', 'answer', 'answered_at',
  'done_at', 'done_note', 'actor', 'device', 'created_at',
];
// The secretary's thread and its title.
export const SECRETARY_THREAD = { kind: 'secretary', title: '秘書' };
// How many messages one read returns: by default, and at most.
export const MESSAGES_DEFAULT = 50;
export const MESSAGES_MAX = 200;
const ID_PREFIX = { goal: 'g', task: 't', habit: 'h', place: 'p', booking: 'b', report: 'r', thread: 'c', message: 'm' };
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const DAY_MS = 24 * 60 * 60 * 1000;
// A device's last_seen_at is written at most once in this long.
const SEEN_MS = 60 * 1000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const blank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

// A task with the profile it belongs to: its goal's if it has a goal, else its place's (原則20).
const TASK_SELECT =
  'SELECT t.*, CASE WHEN t.goal_id IS NOT NULL THEN g.profile ELSE p.profile END AS profile ' +
  'FROM tasks t LEFT JOIN goals g ON g.id = t.goal_id LEFT JOIN places p ON p.id = t.place_id';

// A device's name: 1–64 letters, digits, dots, underscores or hyphens.
const DEVICE_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const hashKey = (key) => createHash('sha256').update(key, 'utf8').digest('hex');

const pad = (n, w = 2) => String(n).padStart(w, '0');

// true/false become 1/0 so SQLite can store them; anything else is left for the rules to refuse.
function normalizeFlags(fields) {
  const out = { ...fields };
  for (const f of FLAG_FIELDS) {
    if (out[f] === true) out[f] = 1;
    else if (out[f] === false) out[f] = 0;
  }
  return out;
}

// Rows as returned to callers: 0/1 flags become booleans, review becomes an array (or null).
function present(row) {
  if (!row) return row;
  const out = { ...row };
  for (const f of FLAG_FIELDS) if (f in out) out[f] = out[f] === 1;
  if ('review' in out) out.review = out.review === null ? null : JSON.parse(out.review);
  return out;
}

// A habit as returned to callers: its rule as an object (as stored text when it cannot be read).
function habitView(row) {
  if (!row) return row;
  const out = present(row);
  out.rule = readHabitRule(row.rule).rule ?? row.rule;
  return out;
}

function diff(before, after, columns) {
  const changes = {};
  for (const c of columns) {
    if (c === 'updated_at' || c === 'created_at') continue;
    const b = before ? (before[c] ?? null) : null;
    const a = after ? (after[c] ?? null) : null;
    if (b !== a) changes[c] = { before: b, after: a };
  }
  return changes;
}

function unknownFields(fields, allowed) {
  return Object.keys(fields)
    .filter((k) => !allowed.includes(k))
    .map((k) => `${k} はここでは書けません`);
}

// Who is writing: { actor, device } from a write's options. device may be left out.
function requireWriter(opts) {
  const p = [...checkActor(opts?.actor), ...checkWriterDevice(opts?.device)];
  if (p.length) throw new LedgerError(p);
  return { actor: opts.actor, device: opts.device ?? null };
}

function checkDeviceName(name) {
  if (typeof name !== 'string' || !DEVICE_NAME.test(name)) {
    throw new LedgerError(['デバイスの名前は、英数字と . _ - の 1〜64 文字です']);
  }
}

export function openLedger(path, options = {}) {
  const now = options.now ?? (() => new Date());
  const db = new DatabaseSync(path);
  let open = true;
  try {
    db.exec('PRAGMA foreign_keys = ON');
    if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    migrate(db);
  } catch (err) {
    // A refused file stays closed; on Windows an open handle would keep it locked.
    db.close();
    throw err;
  }

  const nowIso = () => now().toISOString();

  // A write inside another write joins the outer transaction, so both commit or neither does.
  let depth = 0;
  function transaction(fn) {
    if (depth > 0) return fn();
    db.exec('BEGIN IMMEDIATE');
    depth += 1;
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      depth -= 1;
    }
  }

  function record(writer, entity, entityId, action, changes) {
    db.prepare(
      'INSERT INTO records (at, actor, device, entity, entity_id, action, changes) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(nowIso(), writer.actor, writer.device, entity, entityId, action, JSON.stringify(changes));
  }

  function insert(table, columns, row) {
    const cols = columns.filter((c) => row[c] !== undefined);
    db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
      ...cols.map((c) => row[c]),
    );
  }

  function updateRow(table, columns, row) {
    const cols = columns.filter((c) => c !== 'id');
    db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(
      ...cols.map((c) => row[c] ?? null),
      row.id,
    );
  }

  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const getGoalRow = (id) => one('SELECT * FROM goals WHERE id = ?', id);
  const getTaskRow = (id) => one(`${TASK_SELECT} WHERE t.id = ?`, id);
  const getHabitRow = (id) => one('SELECT * FROM habits WHERE id = ?', id);
  const getPlaceRow = (id) => one('SELECT * FROM places WHERE id = ?', id);
  const getDeviceRow = (name) => one('SELECT * FROM devices WHERE name = ?', name);
  const getHoldRow = (taskId) => one('SELECT * FROM holds WHERE task_id = ?', taskId);
  const getBookingRow = (id) => one('SELECT * FROM bookings WHERE id = ?', id);

  function idTaken(id) {
    return !!one(
      'SELECT 1 FROM goals WHERE id = ? UNION ALL SELECT 1 FROM tasks WHERE id = ? ' +
        'UNION ALL SELECT 1 FROM habits WHERE id = ? UNION ALL SELECT 1 FROM places WHERE id = ? ' +
        'UNION ALL SELECT 1 FROM bookings WHERE id = ? UNION ALL SELECT 1 FROM reports WHERE id = ? ' +
        'UNION ALL SELECT 1 FROM threads WHERE id = ? UNION ALL SELECT 1 FROM messages WHERE id = ?',
      id, id, id, id, id, id, id, id,
    );
  }

  // g_YYYYMMDDHHMMSS_xxxxxx in UTC from the clock, or the caller's id if it fits the pattern.
  function chooseId(kind, supplied, problems) {
    if (supplied !== undefined && supplied !== null) {
      if (!isValidId(supplied)) {
        problems.push(`id ${supplied} は x_YYYYMMDDHHMMSS_xxxxxx の形ではありません`);
        return supplied;
      }
      if (idTaken(supplied)) problems.push(`id ${supplied} はもう使われています`);
      return supplied;
    }
    const d = now();
    const stamp =
      `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
      `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
    for (;;) {
      let rand = '';
      for (let i = 0; i < 6; i += 1) rand += ID_CHARS[randomInt(ID_CHARS.length)];
      const id = `${ID_PREFIX[kind]}_${stamp}_${rand}`;
      if (!idTaken(id)) return id;
    }
  }

  // Splits create() input into the row's own fields and an optional initial state.
  function initialState(fields, problems) {
    const state = fields.state ?? 'ready';
    if (!STATES.includes(state)) return { state, extra: {} };
    const extra = {};
    for (const f of ALL_STATE_FIELDS) if (fields[f] !== undefined) extra[f] = fields[f];
    problems.push(...checkStateExtra(state, extra));
    return { state, extra };
  }

  // A discarded task is work that will not be done, so it does not make its goal take a
  // person's time.
  const goalHasHumanTimeTask = (goalId) =>
    !!one(
      `SELECT 1 FROM tasks WHERE goal_id = ? AND state <> 'discarded' AND mode IN (${HUMAN_TIME_MODES.map(() => '?').join(', ')})`,
      goalId,
      ...HUMAN_TIME_MODES,
    );

  // The rules for a goal or task row about to be written. content: the write sets the
  // task's own fields (create, update), so a human-time task must also find its goal ready
  // to be a human-time goal (原則1). State changes alone do not re-check the goal.
  function validate(kind, row, { content = false } = {}) {
    if (kind === 'goal') return checkGoal(row, { hasHumanTimeTask: goalHasHumanTimeTask(row.id) });
    const goal = row.goal_id ? getGoalRow(row.goal_id) : null;
    const p = checkTask(row, {
      goalExists: row.goal_id ? !!goal : true,
      placeExists: row.place_id ? !!getPlaceRow(row.place_id) : true,
    });
    if (content) p.push(...checkGoalTakesHumanTask(row, goal));
    return p;
  }

  // A task's hold as callers see it, or null.
  function holdView(taskId) {
    const h = one(
      'SELECT h.device, h.place_id, p.name AS place_name, h.since FROM holds h LEFT JOIN places p ON p.id = h.place_id WHERE h.task_id = ?',
      taskId,
    );
    return h ? { ...h } : null;
  }

  function allHolds() {
    return new Map(
      all('SELECT h.task_id, h.device, h.place_id, p.name AS place_name, h.since FROM holds h LEFT JOIN places p ON p.id = h.place_id').map(
        ({ task_id, ...h }) => [task_id, h],
      ),
    );
  }

  const taskView = (row, holds) => ({ ...present(row), hold: holds ? (holds.get(row.id) ?? null) : holdView(row.id) });

  function createGoal(fields, opts) {
    const w = requireWriter(opts);
    const input = normalizeFlags(fields ?? {});
    const problems = unknownFields(input, ['id', 'state', ...GOAL_EDITABLE, ...ALL_STATE_FIELDS]);
    const id = chooseId('goal', input.id, problems);
    const { state, extra } = initialState(input, problems);
    const t = nowIso();
    let row = {
      id, title: input.title, outcome: input.outcome ?? null, due: input.due ?? null,
      due_provisional: input.due_provisional ?? 0, state: 'ready', mode: input.mode,
      human_led: input.human_led ?? 0, profile: input.profile ?? null, created_at: t, updated_at: t,
    };
    row = applyState(row, state, extra, t);
    problems.push(...checkGoal(row));
    if (problems.length) throw new LedgerError(problems);
    return transaction(() => {
      insert('goals', GOAL_COLUMNS, row);
      record(w, 'goal', id, 'create', diff(null, row, GOAL_COLUMNS));
      return present(getGoalRow(id));
    });
  }

  // after: the tasks that come before this one (原則3), linked in the same transaction.
  function createTask(fields, opts) {
    const w = requireWriter(opts);
    const { after: afterIds, ...rest } = fields ?? {};
    const input = normalizeFlags(rest);
    const problems = unknownFields(input, ['id', 'state', ...TASK_EDITABLE, ...ALL_STATE_FIELDS]);
    const before = afterIds === undefined || afterIds === null ? [] : Array.isArray(afterIds) ? afterIds : [afterIds];
    for (const b of before) {
      if (typeof b !== 'string' || !getTaskRow(b)) problems.push(`先にやるタスク ${b} がありません`);
    }
    const id = chooseId('task', input.id, problems);
    const { state, extra } = initialState(input, problems);
    const t = nowIso();
    let row = {
      id, title: input.title, body: input.body ?? null, done_when: input.done_when ?? null,
      goal_id: input.goal_id ?? null, state: 'ready', mode: input.mode, load: input.load ?? null,
      estimate_min: input.estimate_min ?? null, due: input.due ?? null, due_provisional: input.due_provisional ?? 0,
      place_id: input.place_id ?? null, next: input.next ?? null, delegated: input.delegated ?? 0,
      created_at: t, updated_at: t,
    };
    row = applyState(row, state, extra, t);
    problems.push(...validate('task', row, { content: true }));
    if (problems.length) throw new LedgerError(problems);
    return transaction(() => {
      insert('tasks', TASK_COLUMNS, row);
      record(w, 'task', id, 'create', diff(null, row, TASK_COLUMNS));
      for (const b of new Set(before)) {
        db.prepare('INSERT INTO blocks (before_id, after_id, created_at) VALUES (?, ?, ?)').run(b, id, t);
        record(w, 'block', `${b}>${id}`, 'link', { before_id: b, after_id: id });
      }
      return taskView(getTaskRow(id));
    });
  }

  // Finds a goal or a task by id. Ids may carry any one-letter prefix, so both tables are searched.
  function findItem(id) {
    const goal = getGoalRow(id);
    if (goal) return { kind: 'goal', row: goal, table: 'goals', columns: GOAL_COLUMNS };
    const task = getTaskRow(id);
    if (task) return { kind: 'task', row: task, table: 'tasks', columns: TASK_COLUMNS };
    return null;
  }

  const itemView = (kind, id) => (kind === 'goal' ? present(getGoalRow(id)) : taskView(getTaskRow(id)));

  // Writes a changed goal or task with one record; returns the row unchanged when nothing
  // differs. extra.changes are added to the record; extra.also runs inside the transaction.
  function writeItem(item, next, w, action, extra = {}) {
    const changes = { ...diff(item.row, next, item.columns), ...(extra.changes ?? {}) };
    if (Object.keys(changes).length === 0) return itemView(item.kind, item.row.id);
    next.updated_at = nowIso();
    return transaction(() => {
      updateRow(item.table, item.columns, next);
      extra.also?.();
      record(w, item.kind, next.id, action, changes);
      return itemView(item.kind, next.id);
    });
  }

  function update(id, fields, opts) {
    const w = requireWriter(opts);
    const item = findItem(id);
    if (!item) throw new LedgerError([`${id} というゴールもタスクもありません`]);
    const input = normalizeFlags(fields ?? {});
    const problems = unknownFields(input, item.kind === 'goal' ? GOAL_EDITABLE : TASK_EDITABLE);
    const next = { ...item.row };
    for (const [k, v] of Object.entries(input)) next[k] = v === undefined ? next[k] : v;
    problems.push(...validate(item.kind, next, { content: true }));
    if (problems.length) throw new LedgerError(problems);
    next.review = null; // the row now passes the rules
    return writeItem(item, next, w, 'update');
  }

  const holdChange = (h) => (h ? { device: h.device, place_id: h.place_id } : null);

  // Moves a goal or task to `state`. A task moved to done, discarded, waiting or deferred lets
  // go of its hold, and extra.next may leave a line for whoever picks it up next. On closing,
  // extra.learned (what the work taught) is kept in the record of the close; the MCP close
  // also writes it to the profile's knowledge (as a note from an agent).
  function setState(id, state, extra = {}, opts) {
    const w = requireWriter(opts);
    const item = findItem(id);
    if (!item) throw new LedgerError([`${id} というゴールもタスクもありません`]);
    const { next: nextStep, learned, ...fields } = extra ?? {};
    const problems = [];
    if (!STATES.includes(state)) problems.push(`状態は ${STATES.join(', ')} のどれかです`);
    else problems.push(...checkStateExtra(state, fields));
    if (nextStep !== undefined) {
      if (item.kind !== 'task') problems.push('next はタスクにだけ書けます');
      else if (!RELEASING_STATES.includes(state)) problems.push(`next は、手放すとき(${RELEASING_STATES.join(', ')})だけ書けます`);
    }
    if (learned !== undefined) {
      if (!CLOSED_STATES.includes(state)) problems.push(`分かったこと(learned)は、閉じるとき(${CLOSED_STATES.join(', ')})だけ渡せます`);
      else if (typeof learned !== 'string' || learned.trim() === '') problems.push('分かったこと(learned)は空でない文字列です');
    }
    if (problems.length) throw new LedgerError(problems);
    const next = applyState(item.row, state, fields, nowIso());
    if (nextStep !== undefined) next.next = nextStep;
    problems.push(...validate(item.kind, next));
    if (problems.length) throw new LedgerError(problems);
    next.review = null; // the row now passes the rules
    const noted = learned !== undefined ? { learned: { before: null, after: learned } } : {};
    const hold = item.kind === 'task' && RELEASING_STATES.includes(state) ? getHoldRow(id) : null;
    if (!hold) return writeItem(item, next, w, 'state', { changes: noted });
    return writeItem(item, next, w, 'state', {
      changes: { ...noted, hold: { before: holdChange(hold), after: null } },
      also: () => db.prepare('DELETE FROM holds WHERE task_id = ?').run(id),
    });
  }

  // done or discarded back to ready; the result or reason is cleared (原則5: 破棄は元に戻せる).
  function reopen(id, opts) {
    const w = requireWriter(opts);
    const item = findItem(id);
    if (!item) throw new LedgerError([`${id} というゴールもタスクもありません`]);
    if (!CLOSED_STATES.includes(item.row.state)) {
      throw new LedgerError([`${id} は閉じていません(いまは ${item.row.state})。戻せるのは done か discarded だけです`]);
    }
    const next = applyState(item.row, 'ready', {}, nowIso());
    const problems = validate(item.kind, next);
    if (problems.length) throw new LedgerError(problems);
    next.review = null;
    return writeItem(item, next, w, 'reopen');
  }

  // Back to ready from deferred or waiting (reopen is for closed rows).
  function resume(id, opts) {
    const item = findItem(id);
    if (!item) throw new LedgerError([`${id} というゴールもタスクもありません`]);
    if (!['deferred', 'waiting'].includes(item.row.state)) {
      throw new LedgerError([`${id} は先送りでも待ちでもありません(いまは ${item.row.state})。閉じたものを戻すときは reopen です`]);
    }
    return setState(id, 'ready', {}, opts);
  }

  // The tasks before taskId (順序) that are not closed yet.
  function openBefore(taskId) {
    const closed = CLOSED_STATES.map(() => '?').join(', ');
    return all(
      `SELECT p.id FROM blocks b JOIN tasks p ON p.id = b.before_id WHERE b.after_id = ? AND p.state NOT IN (${closed}) ORDER BY p.id`,
      taskId,
      ...CLOSED_STATES,
    ).map((r) => r.id);
  }

  // Is `target` reachable from `start` along before→after edges?
  function reachable(start, target) {
    return !!one(
      'WITH RECURSIVE r(id) AS (SELECT after_id FROM blocks WHERE before_id = ? ' +
        'UNION SELECT b.after_id FROM blocks b JOIN r ON b.before_id = r.id) ' +
        'SELECT 1 FROM r WHERE id = ?',
      start,
      target,
    );
  }

  function link(beforeId, afterId, opts) {
    const w = requireWriter(opts);
    const ctx = {
      beforeIsTask: !!getTaskRow(beforeId),
      afterIsTask: !!getTaskRow(afterId),
    };
    ctx.createsCycle = ctx.beforeIsTask && ctx.afterIsTask && reachable(afterId, beforeId);
    const problems = checkBlock(beforeId, afterId, ctx);
    if (problems.length) throw new LedgerError(problems);
    if (one('SELECT 1 FROM blocks WHERE before_id = ? AND after_id = ?', beforeId, afterId)) {
      return { before_id: beforeId, after_id: afterId };
    }
    return transaction(() => {
      db.prepare('INSERT INTO blocks (before_id, after_id, created_at) VALUES (?, ?, ?)').run(beforeId, afterId, nowIso());
      record(w, 'block', `${beforeId}>${afterId}`, 'link', { before_id: beforeId, after_id: afterId });
      return { before_id: beforeId, after_id: afterId };
    });
  }

  function unlink(beforeId, afterId, opts) {
    const w = requireWriter(opts);
    if (!one('SELECT 1 FROM blocks WHERE before_id = ? AND after_id = ?', beforeId, afterId)) {
      throw new LedgerError([`${beforeId} → ${afterId} の順序はありません`]);
    }
    return transaction(() => {
      db.prepare('DELETE FROM blocks WHERE before_id = ? AND after_id = ?').run(beforeId, afterId);
      record(w, 'block', `${beforeId}>${afterId}`, 'unlink', { before_id: beforeId, after_id: afterId });
      return { before_id: beforeId, after_id: afterId };
    });
  }

  // 着手. The device starts working on the task in a place (placeId may be null: no
  // registered place). A device holds one task per place: holding another there is refused,
  // and the error's heldTaskId names the one it holds. A task held elsewhere moves here, with a
  // 'move' record. A ready task becomes running.
  function start(taskId, { device, placeId = null } = {}, opts) {
    const w = requireWriter(opts);
    const task = getTaskRow(taskId);
    if (!task) throw new LedgerError([`${taskId} というタスクはありません`]);
    const place = placeId ?? null;
    const problems = [];
    if (CLOSED_STATES.includes(task.state)) problems.push(`タスク ${taskId} は閉じています(${task.state})。着手する前に reopen で戻します`);
    const dev = typeof device === 'string' ? getDeviceRow(device) : null;
    if (!dev) problems.push(`デバイス ${device} がありません。warifuri key add で登録します`);
    else if (dev.revoked_at !== null) problems.push(`デバイス ${device} のシークレットは取り消されています`);
    if (place !== null && !getPlaceRow(place)) problems.push(`作業フォルダ ${place} がありません`);
    if (problems.length) throw new LedgerError(problems);

    const here = one("SELECT task_id FROM holds WHERE device = ? AND ifnull(place_id, '') = ?", device, place ?? '');
    if (here && here.task_id !== taskId) {
      throw new LedgerError(
        [`デバイス ${device} のこの作業フォルダでは、もうタスク ${here.task_id} に着手しています。先にそれを手放します(release か、閉じる・待ち・先送り)`],
        { heldTaskId: here.task_id },
      );
    }
    const before = getHoldRow(taskId);
    if (before && before.device === device && before.place_id === place) return taskView(task);

    const t = nowIso();
    const next = task.state === 'ready' ? applyState(task, 'running', {}, t) : null;
    if (next) {
      problems.push(...validate('task', next));
      if (problems.length) throw new LedgerError(problems);
      next.review = null;
      next.updated_at = t;
    }
    return transaction(() => {
      const changes = next ? diff(task, next, TASK_COLUMNS) : {};
      if (before) {
        db.prepare('UPDATE holds SET device = ?, place_id = ?, since = ? WHERE task_id = ?').run(device, place, t, taskId);
        changes.from = holdChange(before);
        changes.to = { device, place_id: place };
      } else {
        db.prepare('INSERT INTO holds (task_id, device, place_id, since) VALUES (?, ?, ?, ?)').run(taskId, device, place, t);
        changes.hold = { before: null, after: { device, place_id: place } };
      }
      if (next) updateRow('tasks', TASK_COLUMNS, next);
      record(w, 'task', taskId, before ? 'move' : 'start', changes);
      return taskView(getTaskRow(taskId));
    });
  }

  // Lets go of a held task without closing it (中断). A running task goes back to ready, and
  // `next` (if given) is left for whoever picks it up.
  function release(taskId, { next: nextStep } = {}, opts) {
    const w = requireWriter(opts);
    const task = getTaskRow(taskId);
    if (!task) throw new LedgerError([`${taskId} というタスクはありません`]);
    const hold = getHoldRow(taskId);
    if (!hold) throw new LedgerError([`タスク ${taskId} は、どのデバイスでも作業中ではありません`]);
    let next = { ...task };
    if (task.state === 'running') next = applyState(task, 'ready', {}, nowIso());
    if (nextStep !== undefined) next.next = nextStep;
    const problems = validate('task', next);
    if (problems.length) throw new LedgerError(problems);
    next.review = null;
    const item = { kind: 'task', row: task, table: 'tasks', columns: TASK_COLUMNS };
    return writeItem(item, next, w, 'release', {
      changes: { hold: { before: holdChange(hold), after: null } },
      also: () => db.prepare('DELETE FROM holds WHERE task_id = ?').run(taskId),
    });
  }

  // The task a device holds in a place (placeId null: outside any place), or null.
  function held({ device, placeId = null } = {}) {
    const h = one("SELECT task_id FROM holds WHERE device = ? AND ifnull(place_id, '') = ?", device ?? '', placeId ?? '');
    return h ? taskView(getTaskRow(h.task_id)) : null;
  }

  function createHabit(fields, opts) {
    const w = requireWriter(opts);
    const input = normalizeFlags(fields ?? {});
    const problems = unknownFields(input, ['id', ...HABIT_EDITABLE]);
    const id = chooseId('habit', input.id, problems);
    const t = nowIso();
    const row = {
      id, title: input.title, rule: habitRuleText(input.rule), duration_min: input.duration_min,
      goal_id: input.goal_id ?? null, active: input.active ?? 1, created_at: t, updated_at: t,
    };
    problems.push(...checkHabit(row, { goalExists: row.goal_id ? !!getGoalRow(row.goal_id) : true }));
    if (problems.length) throw new LedgerError(problems);
    return transaction(() => {
      insert('habits', HABIT_COLUMNS, row);
      record(w, 'habit', id, 'create', diff(null, row, HABIT_COLUMNS));
      return habitView(getHabitRow(id));
    });
  }

  function writeHabit(id, fields, opts, action) {
    const w = requireWriter(opts);
    const before = getHabitRow(id);
    if (!before) throw new LedgerError([`${id} という習慣はありません`]);
    const input = normalizeFlags(fields ?? {});
    const problems = unknownFields(input, HABIT_EDITABLE);
    const next = { ...before, ...input };
    if ('rule' in input) next.rule = habitRuleText(input.rule);
    problems.push(...checkHabit(next, { goalExists: next.goal_id ? !!getGoalRow(next.goal_id) : true }));
    if (problems.length) throw new LedgerError(problems);
    const changes = diff(before, next, HABIT_COLUMNS);
    if (Object.keys(changes).length === 0) return habitView(before);
    next.updated_at = nowIso();
    return transaction(() => {
      updateRow('habits', HABIT_COLUMNS, next);
      record(w, 'habit', id, action, changes);
      return habitView(getHabitRow(id));
    });
  }

  const updateHabit = (id, fields, opts) => writeHabit(id, fields, opts, 'update');
  // A habit is stopped, not deleted, so its history stays.
  const stopHabit = (id, opts) => writeHabit(id, { active: 0 }, opts, 'stop');

  // The habits that are not stopped, by id.
  const listHabits = () => all('SELECT * FROM habits WHERE active = 1 ORDER BY id').map(habitView);

  const pathsOf = (placeId) =>
    all('SELECT device, path FROM place_paths WHERE place_id = ? ORDER BY device', placeId).map(({ device, path }) => ({ device, path }));

  // Every place with its paths, by profile then name.
  function listPlaces({ profile } = {}) {
    const rows = profile === undefined
      ? all('SELECT id FROM places ORDER BY profile, name')
      : all('SELECT id FROM places WHERE profile = ? ORDER BY name', profile);
    return rows.map((r) => placeWithPaths(r.id));
  }

  function placeWithPaths(id) {
    const row = getPlaceRow(id);
    if (!row) return null;
    return { ...row, paths: pathsOf(id) };
  }

  // Problems with paths another place already uses on the same device: two places in one
  // directory would make placeFor() ambiguous.
  function pathConflicts(placeId, paths) {
    const p = [];
    for (const { device, path: dir } of paths) {
      const key = comparablePath(dir) ?? dir;
      for (const other of all('SELECT place_id, path FROM place_paths WHERE device = ? AND place_id <> ?', device, placeId ?? '')) {
        if ((comparablePath(other.path) ?? other.path) === key) {
          p.push(`デバイス ${device} のパス ${dir} は、もう作業フォルダ ${other.place_id} が使っています`);
        }
      }
    }
    return p;
  }

  function createPlace(fields, opts) {
    const w = requireWriter(opts);
    const input = fields ?? {};
    const problems = unknownFields(input, ['id', 'name', 'profile', 'paths']);
    const id = chooseId('place', input.id, problems);
    const t = nowIso();
    const row = { id, name: input.name, profile: input.profile ?? null, created_at: t, updated_at: t };
    const paths = input.paths ?? [];
    if (!Array.isArray(paths)) problems.push('paths は [{device, path}] の並びです');
    else {
      problems.push(...checkPlace({ ...row, paths }));
      if (problems.length === 0) problems.push(...pathConflicts(id, paths));
    }
    if (problems.length) throw new LedgerError(problems);
    return transaction(() => {
      insert('places', PLACE_COLUMNS, row);
      const ins = db.prepare('INSERT INTO place_paths (place_id, device, path) VALUES (?, ?, ?)');
      for (const p of paths) ins.run(id, p.device, p.path);
      const changes = diff(null, row, PLACE_COLUMNS);
      changes.paths = { before: null, after: paths.map((p) => ({ device: p.device, path: p.path })) };
      record(w, 'place', id, 'create', changes);
      return placeWithPaths(id);
    });
  }

  // Changes a place's name or profile, and sets paths per device: { device, path } sets that
  // device's path, { device, path: null } removes it; devices not listed keep theirs.
  function updatePlace(id, fields, opts) {
    const w = requireWriter(opts);
    const before = placeWithPaths(id);
    if (!before) throw new LedgerError([`${id} という作業フォルダはありません`]);
    const input = fields ?? {};
    const problems = unknownFields(input, ['name', 'profile', 'paths']);
    const given = input.paths ?? [];
    const row = { ...getPlaceRow(id) };
    if (input.name !== undefined) row.name = input.name;
    if (input.profile !== undefined) row.profile = input.profile;
    const paths = new Map(before.paths.map((p) => [p.device, p.path]));
    if (!Array.isArray(given)) problems.push('paths は [{device, path}] の並びです');
    else {
      const isRemoval = (i) => i !== null && typeof i === 'object' && typeof i.device === 'string' && i.path === null;
      const removals = given.filter(isRemoval).map((i) => i.device);
      const set = given.filter((i) => !isRemoval(i));
      problems.push(...checkPlace({ ...row, paths: set }));
      const named = [...removals, ...set.map((i) => i?.device)];
      for (const d of new Set(removals)) {
        if (named.filter((x) => x === d).length > 1) problems.push(`デバイス ${d} のパスが2つあります。1つのデバイスにパスは1つです`);
      }
      if (problems.length === 0) {
        problems.push(...pathConflicts(id, set));
        for (const d of removals) paths.delete(d);
        for (const item of set) paths.set(item.device, item.path);
      }
    }
    if (problems.length) throw new LedgerError(problems);
    const after = [...paths].map(([device, path]) => ({ device, path })).sort((a, b) => (a.device < b.device ? -1 : 1));
    const changes = diff(before, row, PLACE_COLUMNS);
    if (JSON.stringify(after) !== JSON.stringify(before.paths)) changes.paths = { before: before.paths, after };
    if (Object.keys(changes).length === 0) return before;
    row.updated_at = nowIso();
    return transaction(() => {
      updateRow('places', PLACE_COLUMNS, row);
      db.prepare('DELETE FROM place_paths WHERE place_id = ?').run(id);
      const ins = db.prepare('INSERT INTO place_paths (place_id, device, path) VALUES (?, ?, ?)');
      for (const p of after) ins.run(id, p.device, p.path);
      record(w, 'place', id, 'update', changes);
      return placeWithPaths(id);
    });
  }

  // Creates a place, or changes the one whose id is given (see updatePlace for paths).
  function upsertPlace(fields, opts) {
    const { id, ...rest } = fields ?? {};
    if (id !== undefined && id !== null && getPlaceRow(id)) return updatePlace(id, rest, opts);
    return createPlace(fields, opts);
  }

  // The path of a place on one device, or null when that device has none.
  function placePath(placeId, device) {
    return one('SELECT path FROM place_paths WHERE place_id = ? AND device = ?', placeId, device)?.path ?? null;
  }

  // The deepest place whose path on `device` is dir or an ancestor of it (原則20), or null.
  function placeFor(device, dir) {
    const best = deepestContaining(all('SELECT place_id, path FROM place_paths WHERE device = ?', device ?? ''), dir);
    return best ? placeWithPaths(best.place_id) : null;
  }

  // Bookings that share some time with [startsAt, endsAt), other than exceptId.
  const overlapping = (startsAt, endsAt, exceptId) =>
    all('SELECT * FROM bookings WHERE starts_at < ? AND ends_at > ? AND id <> ? ORDER BY starts_at, id', endsAt, startsAt, exceptId ?? '').map(
      (r) => ({ ...r }),
    );

  // Creates a booking, or changes the one whose id is given (only the fields given change).
  // kind task needs an existing task_id, habit an existing habit_id, and their title defaults
  // to the task's or habit's; fixed needs a title. Times take an offset and are stored in UTC.
  // Overlaps are allowed: the result lists the bookings sharing time with this one.
  // source and external_id say which outside event the booking is (imported from it, or
  // copied to it). Without id, a pair already in the ledger changes that booking instead of
  // making a second one; with id, the pair may be set only if no other booking has it.
  function book(fields, opts) {
    const w = requireWriter(opts);
    const input = fields ?? {};
    const problems = unknownFields(input, BOOKING_FIELDS);
    const { id, ...given } = input;
    const paired = (src, ext) =>
      typeof src === 'string' && typeof ext === 'string' && !blank(ext)
        ? one('SELECT * FROM bookings WHERE source = ? AND external_id = ?', src, ext)
        : undefined;
    let before = blank(id) ? null : getBookingRow(id);
    if (!blank(id) && !before) throw new LedgerError([`${id} という予定はありません`]);
    if (blank(id)) before = paired(given.source, given.external_id) ?? null;
    const next = before
      ? { ...before }
      : {
          id: null, title: null, kind: undefined, task_id: null, habit_id: null, starts_at: undefined, ends_at: undefined,
          note: null, source: null, external_id: null,
        };
    for (const [k, v] of Object.entries(given)) if (v !== undefined && BOOKING_FIELDS.includes(k)) next[k] = v;
    // A link that does not belong to the kind is dropped, unless the caller gave it.
    if (next.kind !== 'task' && given.task_id === undefined) next.task_id = null;
    if (next.kind !== 'habit' && given.habit_id === undefined) next.habit_id = null;
    const task = next.kind === 'task' && !blank(next.task_id) ? getTaskRow(next.task_id) : null;
    const habit = next.kind === 'habit' && !blank(next.habit_id) ? getHabitRow(next.habit_id) : null;
    const linked = task ?? habit;
    const relinked = !before || next.kind !== before.kind || next.task_id !== before.task_id || next.habit_id !== before.habit_id;
    if (linked && blank(given.title) && (given.title !== undefined || relinked)) next.title = linked.title;
    const holder = paired(next.source, next.external_id);
    const pairTakenBy = holder && holder.id !== next.id ? holder.id : null;
    problems.push(...checkBooking(next, { taskExists: !!task, habitExists: !!habit, pairTakenBy }));
    if (problems.length) throw new LedgerError(problems);
    next.starts_at = new Date(next.starts_at).toISOString();
    next.ends_at = new Date(next.ends_at).toISOString();
    for (const k of ['task_id', 'habit_id', 'note']) next[k] = next[k] ?? null;
    // An empty pair is no pair, so it never meets the unique index.
    for (const k of ['source', 'external_id']) next[k] = blank(next[k]) ? null : next[k];
    const t = nowIso();
    const view = (row) => ({ booking: { ...row }, overlaps: overlapping(row.starts_at, row.ends_at, row.id) });
    if (before) {
      const changes = diff(before, next, BOOKING_COLUMNS);
      if (Object.keys(changes).length === 0) return view(before);
      next.updated_at = t;
      return transaction(() => {
        updateRow('bookings', BOOKING_COLUMNS, next);
        record(w, 'booking', next.id, 'update', changes);
        return view(getBookingRow(next.id));
      });
    }
    next.id = chooseId('booking', undefined, problems);
    next.created_at = t;
    next.updated_at = t;
    return transaction(() => {
      insert('bookings', BOOKING_COLUMNS, next);
      record(w, 'booking', next.id, 'create', diff(null, next, BOOKING_COLUMNS));
      return view(getBookingRow(next.id));
    });
  }

  // Deletes a booking (the task or habit stays: 原則3). The record keeps the row as it was.
  function unbook(id, opts) {
    const w = requireWriter(opts);
    const before = blank(id) ? null : getBookingRow(id);
    if (!before) throw new LedgerError([`${id} という予定はありません`]);
    return transaction(() => {
      db.prepare('DELETE FROM bookings WHERE id = ?').run(id);
      record(w, 'booking', id, 'delete', diff(before, null, BOOKING_COLUMNS));
      return { ...before };
    });
  }

  // A bound of schedule(): YYYY-MM-DD is that day's midnight on the server's clock (local
  // time), or an ISO datetime with an offset. Returns ms, or null with a problem pushed.
  function parseBound(value, name, problems) {
    const m = typeof value === 'string' ? DATE_ONLY.exec(value) : null;
    if (m) {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3])) return d.getTime();
    } else if (isValidDateTime(value)) {
      return Date.parse(value);
    }
    problems.push(`${name} は YYYY-MM-DD か、時差つきの ISO 日時で書きます`);
    return null;
  }

  // Bookings sharing time with [from, to), by start. from defaults to today's midnight (the
  // server's local day), to to one day after from. Each comes with its task (title, state),
  // habit, goal (the task's or the habit's) and profile: the goal's, else the task's place's.
  function schedule({ from, to } = {}) {
    const problems = [];
    let fromMs;
    if (from === undefined) {
      const d = now();
      fromMs = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    } else fromMs = parseBound(from, 'from', problems);
    let toMs;
    if (to !== undefined) toMs = parseBound(to, 'to', problems);
    else if (fromMs !== null) {
      const d = new Date(fromMs);
      d.setDate(d.getDate() + 1);
      toMs = d.getTime();
    }
    if (!problems.length && toMs <= fromMs) problems.push('to は from より後にします');
    if (problems.length) throw new LedgerError(problems);
    const fromIso = new Date(fromMs).toISOString();
    const toIso = new Date(toMs).toISOString();
    const rows = all(
      'SELECT b.*, t.title AS t_title, t.state AS t_state, h.title AS h_title, g.id AS g_id, g.title AS g_title, ' +
        'COALESCE(g.profile, p.profile) AS profile FROM bookings b ' +
        'LEFT JOIN tasks t ON t.id = b.task_id LEFT JOIN habits h ON h.id = b.habit_id ' +
        'LEFT JOIN goals g ON g.id = COALESCE(t.goal_id, h.goal_id) LEFT JOIN places p ON p.id = t.place_id ' +
        'WHERE b.starts_at < ? AND b.ends_at > ? ORDER BY b.starts_at, b.ends_at, b.id',
      toIso,
      fromIso,
    );
    const bookings = rows.map(({ t_title, t_state, h_title, g_id, g_title, profile, ...b }) => ({
      ...b,
      task: b.task_id ? { id: b.task_id, title: t_title, state: t_state } : null,
      habit: b.habit_id ? { id: b.habit_id, title: h_title } : null,
      goal: g_id ? { id: g_id, title: g_title } : null,
      profile: profile ?? null,
    }));
    return { from: fromIso, to: toIso, bookings };
  }

  function getAutonomy(kind) {
    return one('SELECT * FROM autonomy WHERE kind = ?', kind) ?? null;
  }

  // Stores a kind's level and counters. A new kind starts at 'ask' with zero counts (原則13).
  function setAutonomy(kind, fields, opts) {
    return writeAutonomy(kind, fields, requireWriter(opts));
  }

  // note: values kept in the record beside the changes (who decided, the outcome); with a
  // note, the record is written even when no column changed, so every decision is kept.
  function writeAutonomy(kind, fields, w, note = null) {
    const before = getAutonomy(kind);
    const input = fields ?? {};
    const problems = unknownFields(input, ['level', 'approvals_in_row', 'revokes']);
    const next = {
      kind,
      level: 'ask',
      approvals_in_row: 0,
      revokes: 0,
      ...(before ?? {}),
      ...input,
    };
    problems.push(...checkAutonomy(next));
    if (problems.length) throw new LedgerError(problems);
    const columns = ['kind', 'level', 'approvals_in_row', 'revokes'];
    const changes = { ...diff(before, next, columns), ...(note ?? {}) };
    if (before && Object.keys(changes).length === 0) return before;
    next.updated_at = nowIso();
    return transaction(() => {
      db.prepare(
        'INSERT INTO autonomy (kind, level, approvals_in_row, revokes, updated_at) VALUES (?, ?, ?, ?, ?) ' +
          'ON CONFLICT(kind) DO UPDATE SET level = excluded.level, approvals_in_row = excluded.approvals_in_row, ' +
          'revokes = excluded.revokes, updated_at = excluded.updated_at',
      ).run(kind, next.level, next.approvals_in_row, next.revokes, next.updated_at);
      record(w, 'autonomy', kind, before ? 'update' : 'create', changes);
      return getAutonomy(kind);
    });
  }

  function autonomyKind(kind) {
    const def = AUTONOMY_KINDS.find((k) => k.kind === kind);
    if (!def) throw new LedgerError([`${kind} という動きの種類はありません。種類は ${AUTONOMY_KINDS.map((k) => k.kind).join(', ')} です(原則13)`]);
    return def;
  }

  // One kind as the secretary and the Web screen show it. A kind never written is at ask.
  // by_person: its level was last set by the person's word; at ask, the count does not
  // raise it again (原則13: the person's word wins).
  function autonomyView({ kind, label, stage }) {
    const row = getAutonomy(kind);
    const lastSet = records(kind)
      .filter((r) => r.entity === 'autonomy' && (r.changes.by === 'person' || r.changes.level))
      .at(-1);
    return {
      kind,
      label,
      stage,
      level: row?.level ?? 'ask',
      approvals_in_row: row?.approvals_in_row ?? 0,
      revokes: row?.revokes ?? 0,
      by_person: lastSet?.changes.by === 'person',
      updated_at: row?.updated_at ?? null,
    };
  }

  // Every kind in the fixed list, with the approvals in a row that raise one.
  function listAutonomy() {
    return { streak: AUTONOMY_STREAK, kinds: AUTONOMY_KINDS.map(autonomyView) };
  }

  // The outcome of one proposal of a kind (原則13). approved (as proposed) adds to the run of
  // approvals, and the AUTONOMY_STREAK-th in a row raises ask to act_then_tell; changed and
  // refused end the run; revoked (the person cancelled it after the fact) ends the run and
  // brings act_then_tell back to ask. about: the goal or task it concerned; an approval in a
  // goal the person leads (原則8) is not counted. A kind the person held at ask stays there.
  // level_changed is 'raised', 'lowered' or null, with announce: the one line to tell the person.
  function recordAutonomyOutcome(kind, outcome, { about } = {}, opts) {
    const w = requireWriter(opts);
    const def = autonomyKind(kind);
    if (!AUTONOMY_OUTCOMES.includes(outcome)) {
      throw new LedgerError([`結果(outcome)は ${AUTONOMY_OUTCOMES.join(', ')} のどれかです`]);
    }
    let goal = null;
    if (about !== undefined && about !== null) {
      const task = getTaskRow(about);
      goal = task ? (task.goal_id ? getGoalRow(task.goal_id) : null) : getGoalRow(about);
      if (!task && !goal) throw new LedgerError([`${about} というゴールやタスクはありません`]);
    }
    const cur = autonomyView(def);
    let { level, approvals_in_row: streak, revokes } = cur;
    let counted = true;
    let changed = null;
    let reason = null;
    if (outcome === 'approved') {
      if (goal?.human_led) {
        counted = false;
        reason = '人が主導するゴールでの了承なので、回数に数えませんでした(原則8)';
      } else {
        streak += 1;
        if (level === 'ask' && streak >= AUTONOMY_STREAK) {
          if (cur.by_person) reason = '本人の言葉で「毎回聞いて」にしてある種類なので、了承が続いても上げません';
          else {
            level = 'act_then_tell';
            changed = 'raised';
          }
        }
      }
    } else {
      streak = 0;
      if (outcome === 'revoked') {
        revokes += 1;
        if (level === 'act_then_tell') {
          level = 'ask';
          changed = 'lowered';
        }
      }
    }
    const note = { outcome, counted, ...(about ? { about } : {}) };
    writeAutonomy(kind, { level, approvals_in_row: streak, revokes }, w, note);
    const announce =
      changed === 'raised'
        ? `「${def.label}」は${AUTONOMY_STREAK}回続けてそのまま了承されたので、これからはやってから知らせます`
        : changed === 'lowered'
          ? `「${def.label}」は取り消されたので、これからは聞いてからにします`
          : null;
    return { ...autonomyView(def), outcome, counted, level_changed: changed, announce, reason };
  }

  // Sets a kind's level on the person's explicit word (「これは聞かなくていい」「これは毎回聞いて」),
  // whatever the count; the run of approvals starts again. by_person must be true: the
  // secretary never sets a level on its own. said: the person's words, kept in the record.
  function setAutonomyByPerson(kind, level, { by_person: byPerson, said } = {}, opts) {
    const w = requireWriter(opts);
    const def = autonomyKind(kind);
    if (byPerson !== true) {
      throw new LedgerError([
        '自律度を直接変えるのは、人が明示したときだけです。本人に「これは聞かなくていい」「これは毎回聞いて」と言われたときに、by_person を true にして渡します(原則13)',
      ]);
    }
    if (said !== undefined && typeof said !== 'string') throw new LedgerError(['said は本人の言葉を文字で渡します']);
    const note = { by: 'person', ...(said ? { said } : {}) };
    writeAutonomy(kind, { level, approvals_in_row: 0 }, w, note);
    return autonomyView(def);
  }

  // A note written to a profile's knowledge or inbox (src/knowledge/profiles.mjs writes the
  // file): entity 'knowledge', the profile as its id, and what was written as the changes.
  function recordNote(profile, changes, opts) {
    const w = requireWriter(opts);
    if (typeof profile !== 'string' || profile === '') throw new LedgerError(['プロフィールの名前がありません']);
    transaction(() => record(w, 'knowledge', profile, 'note', changes));
  }

  // Stores a report ({ kind, title, body }) from the writer's device. Line ends become \n and
  // the ends of the title and body are trimmed. Reports are only added; the record keeps it too.
  function writeReport(fields, opts) {
    const w = requireWriter(opts);
    const input = fields ?? {};
    const problems = unknownFields(input, ['kind', 'title', 'body']);
    const tidy = (v) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim() : v);
    const row = { kind: input.kind, title: tidy(input.title), body: tidy(input.body), device: w.device };
    problems.push(...checkReport(row));
    if (problems.length) throw new LedgerError(problems);
    row.id = chooseId('report', undefined, problems);
    row.created_at = nowIso();
    return transaction(() => {
      insert('reports', REPORT_COLUMNS, row);
      record(w, 'report', row.id, 'create', diff(null, row, REPORT_COLUMNS));
      return { ...one('SELECT * FROM reports WHERE id = ?', row.id) };
    });
  }

  // Reports, newest first. kind: only that kind. limit: how many (REPORTS_DEFAULT, at most
  // REPORTS_MAX). before: a report's id, or an ISO datetime with offset; only older ones are
  // returned. next_before is the id to pass as before for the next page, or null at the end.
  function listReports({ kind, limit, before } = {}) {
    const problems = [];
    if (kind !== undefined && kind !== null && !REPORT_KINDS.includes(kind)) {
      problems.push(`報告の種類(kind)は ${REPORT_KINDS.join(', ')} のどれかです`);
    }
    const n = limit ?? REPORTS_DEFAULT;
    if (!Number.isInteger(n) || n < 1 || n > REPORTS_MAX) problems.push(`limit は 1〜${REPORTS_MAX} の整数です`);
    // Ties in created_at fall back to the order the rows were added (rowid).
    let after = null;
    if (before !== undefined && before !== null) {
      const ref = typeof before === 'string' ? one('SELECT created_at, rowid AS n FROM reports WHERE id = ?', before) : null;
      if (ref) after = ref;
      else if (isValidDateTime(before)) after = { created_at: new Date(before).toISOString(), n: 0 };
      else if (isValidId(before)) problems.push(`${before} という報告はありません`);
      else problems.push('before には報告の id か、時差つきの ISO 日時を渡します');
    }
    if (problems.length) throw new LedgerError(problems);
    const where = [];
    const args = [];
    if (kind) {
      where.push('kind = ?');
      args.push(kind);
    }
    if (after) {
      where.push('(created_at < ? OR (created_at = ? AND rowid < ?))');
      args.push(after.created_at, after.created_at, after.n);
    }
    const rows = all(
      `SELECT ${REPORT_COLUMNS.join(', ')} FROM reports ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      ...args,
      n + 1,
    ).map((r) => ({ ...r }));
    const more = rows.length > n;
    const reports = rows.slice(0, n);
    return { reports, next_before: more ? reports[reports.length - 1].id : null };
  }

  // 会話. A thread by its kind ('secretary'), or null.
  const threadRow = (kind) => {
    const row = one('SELECT * FROM threads WHERE kind = ?', kind);
    return row ? { ...row } : null;
  };
  const threadById = (id) => {
    const row = one('SELECT * FROM threads WHERE id = ?', id);
    return row ? { ...row } : null;
  };
  const messageRow = (id) => {
    const row = one('SELECT * FROM messages WHERE id = ?', id);
    return row ? { ...row } : null;
  };

  const getMessage = (id) => messageRow(id);

  function getThread(kind = SECRETARY_THREAD.kind) {
    return threadRow(kind);
  }

  // The thread of a kind, made (and recorded) the first time it is needed.
  function ensureThread(kind = SECRETARY_THREAD.kind, opts) {
    const w = requireWriter(opts);
    if (!THREAD_KINDS.includes(kind)) throw new LedgerError([`会話の種類は ${THREAD_KINDS.join(', ')} のどれかです`]);
    return transaction(() => {
      const found = threadRow(kind);
      if (found) return found;
      const t = nowIso();
      const row = { kind, title: SECRETARY_THREAD.title, runner: 'resume', created_at: t, updated_at: t };
      row.id = chooseId('thread', undefined, []);
      insert('threads', THREAD_COLUMNS, row);
      record(w, 'thread', row.id, 'create', diff(null, row, THREAD_COLUMNS));
      return threadById(row.id);
    });
  }

  // Changes a thread's session_id, seen_until or runner. Switching the runner keeps the
  // messages and the session id, so a later runner picks the conversation up where it was.
  function updateThread(id, fields, opts) {
    const w = requireWriter(opts);
    const before = threadById(id);
    if (!before) throw new LedgerError([`${id} という会話はありません`]);
    const input = fields ?? {};
    const problems = unknownFields(input, ['session_id', 'seen_until', 'runner']);
    const next = { ...before, ...input };
    if (!THREAD_RUNNERS.includes(next.runner)) problems.push(`runner は ${THREAD_RUNNERS.join(', ')} のどれかです`);
    if (next.session_id !== null && (typeof next.session_id !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(next.session_id))) {
      problems.push('session_id は英数字と - で書きます');
    }
    if (next.seen_until !== null && messageRow(next.seen_until)?.thread_id !== id) problems.push(`${next.seen_until} はこの会話のメッセージではありません`);
    if (problems.length) throw new LedgerError(problems);
    const changes = diff(before, next, THREAD_COLUMNS);
    if (Object.keys(changes).length === 0) return before;
    next.updated_at = nowIso();
    return transaction(() => {
      updateRow('threads', THREAD_COLUMNS, next);
      record(w, 'thread', id, 'update', changes);
      return threadById(id);
    });
  }

  const tidyText = (v) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim() : v);

  function insertMessage(row, w) {
    row.id = chooseId('message', undefined, []);
    row.actor = w.actor;
    row.device = w.device;
    row.created_at = nowIso();
    insert('messages', MESSAGE_COLUMNS, row);
    record(w, 'message', row.id, 'create', diff(null, row, MESSAGE_COLUMNS));
    return messageRow(row.id);
  }

  // Adds a message ({ role, body }) to a thread. Line ends become \n and the ends are trimmed.
  function addMessage(threadId, fields, opts) {
    const w = requireWriter(opts);
    const input = fields ?? {};
    const problems = unknownFields(input, ['role', 'body']);
    if (!threadById(threadId)) problems.push(`${threadId} という会話はありません`);
    const row = { thread_id: threadId, role: input.role, kind: 'text', body: tidyText(input.body) };
    problems.push(...checkMessage(row));
    if (problems.length) throw new LedgerError(problems);
    return transaction(() => insertMessage(row, w));
  }

  // Messages of a thread, oldest first: the newest limit (MESSAGES_DEFAULT, at most
  // MESSAGES_MAX), or with after (a message id) every one after it, in the order they came.
  function listMessages(threadId, { limit, after } = {}) {
    if (after !== undefined && after !== null) {
      const ref = one('SELECT rowid AS n FROM messages WHERE id = ? AND thread_id = ?', after, threadId);
      if (!ref) throw new LedgerError([`${after} はこの会話のメッセージではありません`]);
      return all(`SELECT ${MESSAGE_COLUMNS.join(', ')} FROM messages WHERE thread_id = ? AND rowid > ? ORDER BY rowid`, threadId, ref.n).map((r) => ({ ...r }));
    }
    const n = limit ?? MESSAGES_DEFAULT;
    if (!Number.isInteger(n) || n < 1 || n > MESSAGES_MAX) throw new LedgerError([`limit は 1〜${MESSAGES_MAX} の整数です`]);
    return all(`SELECT ${MESSAGE_COLUMNS.join(', ')} FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT ?`, threadId, n)
      .map((r) => ({ ...r }))
      .reverse();
  }

  // A proposal of the secretary ({ kind, title, body, about? }) in the secretary's thread, open
  // until the person answers it. kind is an autonomy kind; about a goal or task id.
  function propose(fields, opts) {
    const w = requireWriter(opts);
    const input = fields ?? {};
    const problems = unknownFields(input, ['kind', 'title', 'body', 'about']);
    const row = {
      role: 'secretary', kind: 'proposal', autonomy_kind: input.kind, title: tidyText(input.title), body: tidyText(input.body),
      about: input.about ?? null, state: 'open',
    };
    problems.push(...checkProposal(row));
    if (row.about !== null && !getTaskRow(row.about) && !getGoalRow(row.about)) problems.push(`${row.about} というゴールやタスクはありません`);
    if (problems.length) throw new LedgerError(problems);
    return transaction(() => {
      row.thread_id = ensureThread(SECRETARY_THREAD.kind, w).id;
      return insertMessage(row, w);
    });
  }

  const ANSWER_WORDS = { approved: '了承されました', changed: '直して了承されました', refused: '断られました' };

  // The person's answer to an open proposal: approved, changed (with their words) or refused
  // (words optional). In one transaction: the proposal is marked, the outcome is recorded for
  // its autonomy kind (原則13), and a system message tells the session what was answered.
  // Returns { proposal, outcome, message }.
  function answerProposal(id, { answer, said } = {}, opts) {
    const w = requireWriter(opts);
    const before = messageRow(id);
    const problems = [];
    if (!before || before.kind !== 'proposal') problems.push(`${id} という案はありません`);
    else if (before.state !== 'open') problems.push('この案には、もう答えています');
    if (!PROPOSAL_ANSWERS.includes(answer)) problems.push(`答えは ${PROPOSAL_ANSWERS.join(', ')} のどれかです`);
    const words = tidyText(said) || null;
    if (said !== undefined && said !== null && typeof said !== 'string') problems.push('本人の言葉は文字で渡します');
    else if (answer === 'changed' && !words) problems.push('直して了承するときは、どう直すかを書きます');
    else if (words && charLength(words) > ANSWER_MAX) problems.push(`本人の言葉は ${ANSWER_MAX} 文字までです`);
    if (problems.length) throw new LedgerError(problems);
    return transaction(() => {
      const next = { ...before, state: answer, answer: words, answered_at: nowIso() };
      updateRow('messages', MESSAGE_COLUMNS, next);
      record(w, 'message', id, 'answer', diff(before, next, MESSAGE_COLUMNS));
      const outcome = recordAutonomyOutcome(before.autonomy_kind, answer, { about: before.about ?? undefined }, w);
      const lines = [`案「${before.title}」は${ANSWER_WORDS[answer]}。`];
      if (words) lines.push(`本人の言葉: ${words}`);
      if (outcome.announce) lines.push(outcome.announce);
      const message = insertMessage({ thread_id: before.thread_id, role: 'system', kind: 'text', body: lines.join('\n') }, w);
      return { proposal: messageRow(id), outcome, message };
    });
  }

  // Proposals of the secretary's thread. which: 'to_do' (approved or changed, not carried out
  // yet; the default), 'open' (waiting for the person), or 'recent' (any state). Oldest first
  // for to_do and open, so the earliest is done first; newest first for recent.
  function listProposals({ which = 'to_do', limit } = {}) {
    const n = limit ?? MESSAGES_DEFAULT;
    const problems = [];
    if (!['to_do', 'open', 'recent'].includes(which)) problems.push('which は to_do, open, recent のどれかです');
    if (!Number.isInteger(n) || n < 1 || n > MESSAGES_MAX) problems.push(`limit は 1〜${MESSAGES_MAX} の整数です`);
    if (problems.length) throw new LedgerError(problems);
    const where = {
      to_do: "state IN ('approved','changed') AND done_at IS NULL",
      open: "state = 'open'",
      recent: 'state IS NOT NULL',
    }[which];
    const order = which === 'recent' ? 'DESC' : 'ASC';
    return all(`SELECT ${MESSAGE_COLUMNS.join(', ')} FROM messages WHERE kind = 'proposal' AND ${where} ORDER BY rowid ${order} LIMIT ?`, n).map((r) => ({ ...r }));
  }

  // Marks an approved (or changed) proposal as carried out, with a one-line note of what was done.
  function markProposalDone(id, { note } = {}, opts) {
    const w = requireWriter(opts);
    const before = messageRow(id);
    const problems = [];
    if (!before || before.kind !== 'proposal') problems.push(`${id} という案はありません`);
    else if (!['approved', 'changed'].includes(before.state)) problems.push('行ったと印を付けられるのは、了承された案だけです');
    else if (before.done_at) problems.push('この案には、もう行った印が付いています');
    const text = tidyText(note) || null;
    if (note !== undefined && note !== null && typeof note !== 'string') problems.push('note は文字で渡します');
    else if (text && (/[\r\n]/.test(text) || charLength(text) > ANSWER_MAX)) problems.push(`note は1行、${ANSWER_MAX} 文字までです`);
    if (problems.length) throw new LedgerError(problems);
    return transaction(() => {
      const next = { ...before, done_at: nowIso(), done_note: text };
      updateRow('messages', MESSAGE_COLUMNS, next);
      record(w, 'message', id, 'done', diff(before, next, MESSAGE_COLUMNS));
      return messageRow(id);
    });
  }

  // Every order between tasks, as { before_id, after_id }.
  function blocks() {
    return all('SELECT before_id, after_id FROM blocks ORDER BY before_id, after_id').map((r) => ({ ...r }));
  }

  // The person's settings kept in the settings table under one prefix (profile.name and so
  // on), as { name: value }. Keys of the server's own (github_id) have no prefix and are
  // never returned here.
  const SETTINGS_PREFIX = /^[a-z][a-z_]{0,31}$/;
  const SETTINGS_NAME = /^[a-z][a-z_]{0,31}$/;
  function checkPrefix(prefix) {
    if (typeof prefix !== 'string' || !SETTINGS_PREFIX.test(prefix)) throw new LedgerError(['設定の区分の名前は、英小文字と _ です']);
  }
  function getSettings(prefix) {
    checkPrefix(prefix);
    const out = {};
    for (const r of all('SELECT key, value FROM settings WHERE substr(key, 1, ?) = ? ORDER BY key', prefix.length + 1, `${prefix}.`)) out[r.key.slice(prefix.length + 1)] = r.value;
    return out;
  }

  // Writes settings under a prefix: { name: string } sets one, { name: null } removes it.
  // One record (entity 'settings', the prefix as its id, action opts.action or 'update') lists
  // what changed; nothing is written or recorded when nothing changes. The caller checks the values.
  function setSettings(prefix, values, opts) {
    const w = requireWriter(opts);
    checkPrefix(prefix);
    const problems = [];
    for (const [k, v] of Object.entries(values ?? {})) {
      if (!SETTINGS_NAME.test(k)) problems.push(`設定の名前 ${k} は、英小文字と _ で書きます`);
      if (v !== null && typeof v !== 'string') problems.push(`設定 ${k} の値は文字列です`);
    }
    if (problems.length) throw new LedgerError(problems);
    const before = getSettings(prefix);
    const changes = {};
    for (const [k, v] of Object.entries(values)) if ((before[k] ?? null) !== v) changes[k] = { before: before[k] ?? null, after: v };
    if (Object.keys(changes).length === 0) return before;
    const t = nowIso();
    return transaction(() => {
      for (const [k, { after }] of Object.entries(changes)) {
        if (after === null) db.prepare('DELETE FROM settings WHERE key = ?').run(`${prefix}.${k}`);
        else {
          db.prepare(
            'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
          ).run(`${prefix}.${k}`, after, t);
        }
      }
      record(w, 'settings', prefix, opts?.action ?? 'update', changes);
      return getSettings(prefix);
    });
  }

  function records(entityId) {
    return all('SELECT * FROM records WHERE entity_id = ? ORDER BY id', entityId).map((r) => ({
      ...r,
      changes: JSON.parse(r.changes),
    }));
  }

  // One goal or task (or habit, place) with what surrounds it and its records.
  function get(id) {
    const goal = getGoalRow(id);
    if (goal) {
      const holds = allHolds();
      return {
        kind: 'goal',
        ...present(goal),
        tasks: all(`${TASK_SELECT} WHERE t.goal_id = ? ORDER BY t.created_at, t.id`, id).map((r) => taskView(r, holds)),
        records: records(id),
      };
    }
    const task = getTaskRow(id);
    if (task) {
      return {
        kind: 'task',
        ...taskView(task),
        blocked_by: all('SELECT before_id FROM blocks WHERE after_id = ? ORDER BY before_id', id).map((r) => r.before_id),
        blocks: all('SELECT after_id FROM blocks WHERE before_id = ? ORDER BY after_id', id).map((r) => r.after_id),
        records: records(id),
      };
    }
    const habit = getHabitRow(id);
    if (habit) return { kind: 'habit', ...habitView(habit), records: records(id) };
    const place = placeWithPaths(id);
    if (place) return { kind: 'place', ...place, records: records(id) };
    return null;
  }

  // Open goals, each with its tasks, and the tasks with no goal; every task with its hold.
  // profile filters goals, and goal-less tasks by their place's profile. dir (with the
  // caller's device) names a working directory: the place it falls in gives the profile,
  // unless profile is given too. Without either, everything is returned. state, mode and
  // review (true: only rows flagged on import) filter goals and tasks alike, and a goal also
  // appears when any of its tasks match. scope says which place and profile were applied.
  function board({ profile, dir, device, state, mode, review = false, includeClosed = false } = {}) {
    const place = dir !== undefined ? placeFor(device, dir) : null;
    const scopeProfile = profile ?? place?.profile ?? undefined;
    const closed = CLOSED_STATES.map(() => '?').join(', ');
    const openOnly = (alias) => (includeClosed ? '' : ` AND ${alias}.state NOT IN (${closed})`);
    const openArgs = includeClosed ? [] : CLOSED_STATES;
    const byProfile = scopeProfile !== undefined ? [scopeProfile] : [];
    const matches = (row) =>
      (state === undefined || row.state === state) &&
      (mode === undefined || row.mode === mode) &&
      (!review || row.review !== null);
    const holds = allHolds();

    const goalRows = all(
      `SELECT g.* FROM goals g WHERE 1 = 1${openOnly('g')}${byProfile.length ? ' AND g.profile = ?' : ''} ` +
        'ORDER BY g.due IS NULL, g.due, g.created_at, g.id',
      ...openArgs,
      ...byProfile,
    );
    const taskStmt = db.prepare(`${TASK_SELECT} WHERE t.goal_id = ?${openOnly('t')} ORDER BY t.created_at, t.id`);
    const goals = [];
    for (const g of goalRows) {
      // 着手可能 first (ready, every task before it closed), keeping the order within each part.
      const tasks = taskStmt
        .all(g.id, ...openArgs)
        .filter(matches)
        .map((r) => {
          const open = openBefore(r.id);
          return { ...taskView(r, holds), open_before: open, actionable: r.state === 'ready' && open.length === 0 };
        })
        .sort((a, b) => Number(b.actionable) - Number(a.actionable));
      if (matches(g) || tasks.length > 0) goals.push({ ...present(g), tasks });
    }
    const loose = all(
      `${TASK_SELECT} WHERE t.goal_id IS NULL${openOnly('t')}${byProfile.length ? ' AND p.profile = ?' : ''} ORDER BY t.created_at, t.id`,
      ...openArgs,
      ...byProfile,
    ).filter(matches);
    return {
      goals,
      unassigned: loose.map((r) => taskView(r, holds)),
      scope: {
        profile: scopeProfile ?? null,
        place: place ? { id: place.id, name: place.name, profile: place.profile } : null,
      },
    };
  }

  // Goals and tasks whose title contains `text` (LIKE; case is ignored for ASCII letters).
  function search(text, { limit = 20 } = {}) {
    const pattern = `%${String(text ?? '').replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return all(
      "SELECT 'goal' AS kind, id, title, state, due, review, updated_at FROM goals WHERE title LIKE ? ESCAPE '\\' " +
        "UNION ALL SELECT 'task' AS kind, id, title, state, due, review, updated_at FROM tasks WHERE title LIKE ? ESCAPE '\\' " +
        'ORDER BY updated_at DESC, id LIMIT ?',
      pattern,
      pattern,
      limit,
    ).map(present);
  }

  // A goal's flow as Mermaid text (flow.mjs), or null when there is no such goal. Discarded
  // tasks are left out; a task counts as next only when every task before it, in this goal or
  // another, is closed.
  function flow(goalId) {
    const goal = getGoalRow(goalId);
    if (!goal) return null;
    const tasks = all("SELECT * FROM tasks WHERE goal_id = ? AND state <> 'discarded' ORDER BY created_at, id", goalId);
    const ids = new Set(tasks.map((t) => t.id));
    const edges = all(
      'SELECT b.before_id, b.after_id FROM blocks b JOIN tasks t ON t.id = b.after_id WHERE t.goal_id = ? ORDER BY b.before_id, b.after_id',
      goalId,
    ).filter((e) => ids.has(e.before_id) && ids.has(e.after_id));
    const openBefore = new Map(
      all(
        `SELECT b.after_id AS id, count(*) AS n FROM blocks b JOIN tasks a ON a.id = b.after_id JOIN tasks p ON p.id = b.before_id ` +
          `WHERE a.goal_id = ? AND p.state NOT IN (${CLOSED_STATES.map(() => '?').join(', ')}) GROUP BY b.after_id`,
        goalId,
        ...CLOSED_STATES,
      ).map((r) => [r.id, r.n]),
    );
    const holds = new Map([...allHolds()].map(([id, h]) => [id, h.device]));
    return renderFlow(goal, tasks, edges, { holds, openBefore });
  }

  // Candidates for tidying, with reasons; nothing is changed (原則7: closing is someone's
  // call). held: held with no change for heldDays; ready: untouched for readyDays; waiting:
  // no change for waitingDays. now (Date or ISO string) defaults to the ledger's clock.
  function stale({ heldDays = 3, readyDays = 30, waitingDays = 14, now: at } = {}) {
    const problems = [];
    for (const [name, v] of Object.entries({ heldDays, readyDays, waitingDays })) {
      if (!(typeof v === 'number' && Number.isFinite(v) && v >= 0)) problems.push(`${name} は0以上の数です`);
    }
    const nowMs = at === undefined ? now().getTime() : new Date(at).getTime();
    if (Number.isNaN(nowMs)) problems.push('now は日時です');
    if (problems.length) throw new LedgerError(problems);
    const daysSince = (iso) => Math.floor((nowMs - Date.parse(iso)) / DAY_MS);
    const brief = (t) => ({ id: t.id, title: t.title, state: t.state, goal_id: t.goal_id, profile: t.profile });
    const byDays = (a, b) => b.days - a.days || (a.id < b.id ? -1 : 1);

    const heldRows = all(
      `SELECT x.*, h.device, h.place_id AS hold_place_id, h.since FROM (${TASK_SELECT}) x JOIN holds h ON h.task_id = x.id`,
    );
    const heldList = [];
    for (const t of heldRows) {
      const last = t.since > t.updated_at ? t.since : t.updated_at;
      const days = daysSince(last);
      if (days < heldDays) continue;
      heldList.push({
        ...brief(t), device: t.device, place_id: t.hold_place_id, since: t.since, days,
        reason: `${t.device} で作業中のまま、${days}日動きがありません`,
      });
    }
    const untouched = (state, limit, reason) =>
      all(`${TASK_SELECT} WHERE t.state = ?`, state)
        .map((t) => ({ t, days: daysSince(t.updated_at) }))
        .filter(({ days }) => days >= limit)
        .map(({ t, days }) => ({ ...brief(t), updated_at: t.updated_at, days, reason: reason(t, days) }));
    return {
      now: new Date(nowMs).toISOString(),
      held: heldList.sort(byDays),
      ready: untouched('ready', readyDays, (_t, d) => `ready のまま${d}日触られていません`).sort(byDays),
      waiting: untouched('waiting', waitingDays, (t, d) => `${t.waiting_on} の「${t.waiting_for}」を待ったまま、${d}日動きがありません`).sort(byDays),
    };
  }

  const deviceView = (r) => ({
    name: r.name,
    has_key: r.key_hash !== null && r.revoked_at === null,
    created_at: r.created_at,
    revoked_at: r.revoked_at,
    last_seen_at: r.last_seen_at,
  });

  // Notes that a device called the server with its key or a login token. Written at most
  // once a minute per device, and not recorded: it is a sign of life, not a change. A busy
  // database is not worth failing a request over, so a failed write is ignored.
  const lastSeen = new Map();
  function markSeen(name) {
    const t = now();
    const ms = t.getTime();
    if (typeof name !== 'string' || ms - (lastSeen.get(name) ?? -Infinity) < SEEN_MS) return false;
    try {
      const out = db
        .prepare('UPDATE devices SET last_seen_at = ? WHERE name = ? AND (last_seen_at IS NULL OR last_seen_at <= ?)')
        .run(t.toISOString(), name, new Date(ms - SEEN_MS).toISOString());
      if (out.changes > 0) {
        lastSeen.set(name, ms);
        return true;
      }
      // Another connection may have written it lately: wait a minute from that time.
      const stored = one('SELECT last_seen_at FROM devices WHERE name = ?', name)?.last_seen_at;
      lastSeen.set(name, stored ? Date.parse(stored) : ms);
      return false;
    } catch {
      return false;
    }
  }

  // Registers a device without a key, or returns the one already there.
  function addDevice(name, opts) {
    const w = requireWriter(opts);
    checkDeviceName(name);
    const before = getDeviceRow(name);
    if (before) return deviceView(before);
    return transaction(() => {
      db.prepare('INSERT INTO devices (name, key_hash, created_at, revoked_at) VALUES (?, NULL, ?, NULL)').run(name, nowIso());
      record(w, 'device', name, 'create', { key: { before: null, after: 'none' } });
      return deviceView(getDeviceRow(name));
    });
  }

  // Issues a device's machine key, creating the device if needed. The key is returned here
  // once and never stored. A device that still has a usable key is refused: revoke it first.
  // Records say a key was issued, never the key or its hash.
  function issueKey(name, opts) {
    const w = requireWriter(opts);
    checkDeviceName(name);
    const before = getDeviceRow(name);
    if (before && before.key_hash !== null && before.revoked_at === null) {
      throw new LedgerError([`デバイス ${name} には使えるシークレットがもうあります。新しくするときは、先に取り消します(key revoke)`]);
    }
    const key = `wf_${randomBytes(32).toString('base64url')}`;
    const t = nowIso();
    return transaction(() => {
      if (before) {
        db.prepare('UPDATE devices SET key_hash = ?, revoked_at = NULL WHERE name = ?').run(hashKey(key), name);
        record(w, 'device', name, 'key', { key: { before: before.revoked_at ? 'revoked' : 'none', after: 'issued' } });
      } else {
        db.prepare('INSERT INTO devices (name, key_hash, created_at, revoked_at) VALUES (?, ?, ?, NULL)').run(name, hashKey(key), t);
        record(w, 'device', name, 'create', { key: { before: null, after: 'issued' } });
      }
      return { name, key };
    });
  }

  // Revokes a device: its key, and every OAuth token and open code bound to it, so its
  // logins end too. A device with only OAuth logins (no key) can be revoked as well. The
  // device stays (its records and places refer to it); a new key may be issued later, which
  // makes it usable again, but the revoked tokens stay revoked.
  function revokeKey(name, opts) {
    const w = requireWriter(opts);
    const before = getDeviceRow(name);
    if (!before) throw new LedgerError([`デバイス ${name} がありません`]);
    if (before.revoked_at !== null) throw new LedgerError([`デバイス ${name} はもう取り消されています`]);
    const t = nowIso();
    return transaction(() => {
      db.prepare('UPDATE devices SET key_hash = NULL, revoked_at = ? WHERE name = ?').run(t, name);
      const tokens = store.revokeDevice(name, t);
      record(w, 'device', name, 'revoke', { key: { before: before.key_hash === null ? 'none' : 'issued', after: 'revoked' }, oauth_tokens: tokens });
      return { name, revoked_at: t, oauth_tokens: tokens };
    });
  }

  function listDevices() {
    return all('SELECT * FROM devices ORDER BY name').map(deviceView);
  }

  // The device a key belongs to ({ name }), or null when the key is unknown or revoked.
  function deviceForKey(key) {
    if (typeof key !== 'string' || key === '') return null;
    const row = one('SELECT name FROM devices WHERE key_hash = ? AND revoked_at IS NULL', hashKey(key));
    return row ? { name: row.name } : null;
  }

  // OAuth storage (oauth.mjs). Writes from the command line or the consent page name who
  // wrote them, like every other write.
  const store = oauthStore({ db, one, all, transaction, record, now });
  // revokeDevice runs only inside revokeKey.
  const { revokeDevice: _revokeDevice, ...storeApi } = store;
  const oauth = {
    ...storeApi,
    approve: (id, device, opts) => store.approve(id, device, requireWriter({ ...opts, device })),
    revokeClient: (clientId, opts) => store.revokeClient(clientId, requireWriter(opts)),
  };

  // Replaces goals, tasks, blocks and places with a snapshot (docs/snapshot.md), in one
  // transaction with one record. Habits, devices, autonomy and records stay; bookings stay
  // unless their task is gone (dropped_bookings counts those deleted). A hold stays when
  // its task comes back open (and its place, if any, comes back); others are dropped. Rows that
  // cannot be stored are skipped; rows that break the rules are stored with `review`. A habit
  // whose goal is not in the snapshot loses that link. A bad envelope throws and changes nothing.
  function replaceFromSnapshot(doc, opts) {
    const w = requireWriter(opts);
    const envelope = checkEnvelope(doc);
    if (envelope.length) throw new LedgerError(envelope);
    const t = nowIso();
    return transaction(() => {
      // Habits may point at goals that are deleted and inserted again; check at commit.
      db.exec('PRAGMA defer_foreign_keys = ON');
      const reservedIds = new Set(all('SELECT id FROM habits').map((r) => r.id));
      const snap = prepareSnapshot(doc, { at: t, reservedIds });
      const oldHolds = all('SELECT * FROM holds ORDER BY task_id');
      for (const table of ['holds', 'blocks', 'tasks', 'goals', 'place_paths', 'places']) db.exec(`DELETE FROM ${table}`);
      for (const row of snap.places) insert('places', PLACE_COLUMNS, row);
      const insPath = db.prepare('INSERT INTO place_paths (place_id, device, path) VALUES (?, ?, ?)');
      for (const p of snap.paths) insPath.run(p.place_id, p.device, p.path);
      const stored = (row) => ({ ...row, review: row.review ? JSON.stringify(row.review) : null });
      for (const row of snap.goals) insert('goals', GOAL_COLUMNS, stored(row));
      for (const row of snap.tasks) insert('tasks', TASK_COLUMNS, stored(row));
      const insBlock = db.prepare('INSERT INTO blocks (before_id, after_id, created_at) VALUES (?, ?, ?)');
      for (const b of snap.blocks) insBlock.run(b.before_id, b.after_id, t);
      const detached = all(
        'SELECT id FROM habits WHERE goal_id IS NOT NULL AND goal_id NOT IN (SELECT id FROM goals) ORDER BY id',
      ).map((r) => r.id);
      const detach = db.prepare('UPDATE habits SET goal_id = NULL, updated_at = ? WHERE id = ?');
      for (const id of detached) detach.run(t, id);
      // Bookings of tasks that did not come back go; the record keeps them.
      const droppedBookings = all(
        'SELECT * FROM bookings WHERE task_id IS NOT NULL AND task_id NOT IN (SELECT id FROM tasks) ORDER BY starts_at, id',
      ).map((r) => ({ ...r }));
      const unbookStmt = db.prepare('DELETE FROM bookings WHERE id = ?');
      for (const b of droppedBookings) unbookStmt.run(b.id);

      const openTasks = new Set(snap.tasks.filter((x) => !CLOSED_STATES.includes(x.state)).map((x) => x.id));
      const placeIds = new Set(snap.places.map((x) => x.id));
      const insHold = db.prepare('INSERT INTO holds (task_id, device, place_id, since) VALUES (?, ?, ?, ?)');
      const droppedHolds = [];
      for (const h of oldHolds) {
        if (openTasks.has(h.task_id) && (h.place_id === null || placeIds.has(h.place_id))) {
          insHold.run(h.task_id, h.device, h.place_id, h.since);
        } else {
          droppedHolds.push(h.task_id);
        }
      }

      const counts = { places: snap.places.length, goals: snap.goals.length, tasks: snap.tasks.length, blocks: snap.blocks.length };
      const changes = {
        taken_at: doc.taken_at ?? null,
        counts,
        flagged: snap.flagged.length,
        skipped: snap.skipped.length,
      };
      if (detached.length) changes.detached_habits = detached;
      if (droppedHolds.length) changes.dropped_holds = droppedHolds;
      if (droppedBookings.length) changes.dropped_bookings = droppedBookings;
      const source = typeof doc.source === 'string' && doc.source.trim() !== '' ? doc.source : 'snapshot';
      record(w, 'import', source, 'replace', changes);
      return {
        counts, flagged: snap.flagged, skipped: snap.skipped, detached_habits: detached, dropped_holds: droppedHolds,
        dropped_bookings: droppedBookings.length,
      };
    });
  }

  return {
    replaceFromSnapshot,
    createGoal,
    createTask,
    openBefore,
    update,
    setState,
    reopen,
    resume,
    link,
    unlink,
    start,
    release,
    held,
    createHabit,
    updateHabit,
    stopHabit,
    listHabits,
    createPlace,
    updatePlace,
    upsertPlace,
    placePath,
    placeFor,
    listPlaces,
    setAutonomy,
    getAutonomy,
    listAutonomy,
    recordAutonomyOutcome,
    setAutonomyByPerson,
    get,
    board,
    search,
    flow,
    stale,
    records,
    recordNote,
    writeReport,
    listReports,
    getThread,
    ensureThread,
    updateThread,
    addMessage,
    getMessage,
    listMessages,
    propose,
    answerProposal,
    listProposals,
    markProposalDone,
    blocks,
    getSettings,
    setSettings,
    addDevice,
    issueKey,
    revokeKey,
    listDevices,
    deviceForKey,
    markSeen,
    book,
    unbook,
    schedule,
    oauth,
    // A flag of its own: DatabaseSync#isOpen is newer than the Node versions warifuri runs on.
    close: () => {
      if (!open) return;
      open = false;
      db.close();
    },
  };
}
