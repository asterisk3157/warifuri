// The ledger: goals, tasks, their order, holds, habits, places, devices and the secretary's
// autonomy levels, kept in one SQLite file through node:sqlite. Every write is checked against
// rules.mjs, runs in one transaction and appends one row to `records` (who changed what, from
// which device, before/after). A refused write changes nothing and throws a LedgerError
// carrying every problem found.
// replaceFromSnapshot() is the one write that takes rows breaking the rules: it stores them
// with `review` set, and the next write to such a row must pass the rules (which clears it).
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
  HUMAN_TIME_MODES,
  ALL_STATE_FIELDS,
  RELEASING_STATES,
  isValidId,
  checkActor,
  checkWriterDevice,
  checkGoal,
  checkGoalTakesHumanTask,
  checkTask,
  checkBlock,
  checkHabit,
  checkPlace,
  checkAutonomy,
  checkStateExtra,
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

// Fields a caller may change with update(); state and its fields go through setState().
const GOAL_EDITABLE = ['title', 'outcome', 'due', 'due_provisional', 'mode', 'human_led', 'profile'];
const TASK_EDITABLE = [
  'title', 'body', 'done_when', 'due', 'due_provisional', 'mode', 'load', 'goal_id', 'estimate_min', 'place_id',
  'next', 'delegated',
];
const HABIT_EDITABLE = ['title', 'rule', 'duration_min', 'goal_id', 'active'];
const FLAG_FIELDS = ['due_provisional', 'human_led', 'active', 'delegated'];
const ID_PREFIX = { goal: 'g', task: 't', habit: 'h', place: 'p' };
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const DAY_MS = 24 * 60 * 60 * 1000;

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
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  migrate(db);

  const nowIso = () => now().toISOString();

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
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

  function idTaken(id) {
    return !!one(
      'SELECT 1 FROM goals WHERE id = ? UNION ALL SELECT 1 FROM tasks WHERE id = ? ' +
        'UNION ALL SELECT 1 FROM habits WHERE id = ? UNION ALL SELECT 1 FROM places WHERE id = ?',
      id, id, id, id,
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

  function createTask(fields, opts) {
    const w = requireWriter(opts);
    const input = normalizeFlags(fields ?? {});
    const problems = unknownFields(input, ['id', 'state', ...TASK_EDITABLE, ...ALL_STATE_FIELDS]);
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
  // go of its hold, and extra.next may leave a line for whoever picks it up next.
  function setState(id, state, extra = {}, opts) {
    const w = requireWriter(opts);
    const item = findItem(id);
    if (!item) throw new LedgerError([`${id} というゴールもタスクもありません`]);
    const { next: nextStep, ...fields } = extra ?? {};
    const problems = [];
    if (!STATES.includes(state)) problems.push(`状態は ${STATES.join(', ')} のどれかです`);
    else problems.push(...checkStateExtra(state, fields));
    if (nextStep !== undefined) {
      if (item.kind !== 'task') problems.push('next はタスクにだけ書けます');
      else if (!RELEASING_STATES.includes(state)) problems.push(`next は、手放すとき(${RELEASING_STATES.join(', ')})だけ書けます`);
    }
    if (problems.length) throw new LedgerError(problems);
    const next = applyState(item.row, state, fields, nowIso());
    if (nextStep !== undefined) next.next = nextStep;
    problems.push(...validate(item.kind, next));
    if (problems.length) throw new LedgerError(problems);
    next.review = null; // the row now passes the rules
    const hold = item.kind === 'task' && RELEASING_STATES.includes(state) ? getHoldRow(id) : null;
    if (!hold) return writeItem(item, next, w, 'state');
    return writeItem(item, next, w, 'state', {
      changes: { hold: { before: holdChange(hold), after: null } },
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

  // 持つ. The device starts working on the task in a place (placeId may be null: no
  // registered place). A device holds one task per place: holding another there is refused,
  // and the error's heldTaskId names the one it holds. A task held elsewhere moves here, with a
  // 'move' record. A ready task becomes running.
  function start(taskId, { device, placeId = null } = {}, opts) {
    const w = requireWriter(opts);
    const task = getTaskRow(taskId);
    if (!task) throw new LedgerError([`${taskId} というタスクはありません`]);
    const place = placeId ?? null;
    const problems = [];
    if (CLOSED_STATES.includes(task.state)) problems.push(`タスク ${taskId} は閉じています(${task.state})。持つ前に reopen で戻します`);
    const dev = typeof device === 'string' ? getDeviceRow(device) : null;
    if (!dev) problems.push(`デバイス ${device} がありません。warifuri key add で登録します`);
    else if (dev.revoked_at !== null) problems.push(`デバイス ${device} の鍵は取り消されています`);
    if (place !== null && !getPlaceRow(place)) problems.push(`置き場 ${place} がありません`);
    if (problems.length) throw new LedgerError(problems);

    const here = one("SELECT task_id FROM holds WHERE device = ? AND ifnull(place_id, '') = ?", device, place ?? '');
    if (here && here.task_id !== taskId) {
      throw new LedgerError(
        [`デバイス ${device} のこの置き場では、もうタスク ${here.task_id} を持っています。先にそれを手放します(release か、閉じる・待ち・先送り)`],
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
    if (!hold) throw new LedgerError([`タスク ${taskId} は、どのデバイスも持っていません`]);
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
      id, title: input.title, rule: input.rule, duration_min: input.duration_min,
      goal_id: input.goal_id ?? null, active: input.active ?? 1, created_at: t, updated_at: t,
    };
    problems.push(...checkHabit(row, { goalExists: row.goal_id ? !!getGoalRow(row.goal_id) : true }));
    if (problems.length) throw new LedgerError(problems);
    return transaction(() => {
      insert('habits', HABIT_COLUMNS, row);
      record(w, 'habit', id, 'create', diff(null, row, HABIT_COLUMNS));
      return present(getHabitRow(id));
    });
  }

  function writeHabit(id, fields, opts, action) {
    const w = requireWriter(opts);
    const before = getHabitRow(id);
    if (!before) throw new LedgerError([`${id} という習慣はありません`]);
    const input = normalizeFlags(fields ?? {});
    const problems = unknownFields(input, HABIT_EDITABLE);
    const next = { ...before, ...input };
    problems.push(...checkHabit(next, { goalExists: next.goal_id ? !!getGoalRow(next.goal_id) : true }));
    if (problems.length) throw new LedgerError(problems);
    const changes = diff(before, next, HABIT_COLUMNS);
    if (Object.keys(changes).length === 0) return present(before);
    next.updated_at = nowIso();
    return transaction(() => {
      updateRow('habits', HABIT_COLUMNS, next);
      record(w, 'habit', id, action, changes);
      return present(getHabitRow(id));
    });
  }

  const updateHabit = (id, fields, opts) => writeHabit(id, fields, opts, 'update');
  // A habit is stopped, not deleted, so its history stays.
  const stopHabit = (id, opts) => writeHabit(id, { active: 0 }, opts, 'stop');

  const pathsOf = (placeId) =>
    all('SELECT device, path FROM place_paths WHERE place_id = ? ORDER BY device', placeId).map(({ device, path }) => ({ device, path }));

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
          p.push(`デバイス ${device} の道 ${dir} は、もう置き場 ${other.place_id} が使っています`);
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
    if (!before) throw new LedgerError([`${id} という置き場はありません`]);
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
        if (named.filter((x) => x === d).length > 1) problems.push(`デバイス ${d} の道が2つあります。1つのデバイスに道は1つです`);
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

  function getAutonomy(kind) {
    return one('SELECT * FROM autonomy WHERE kind = ?', kind) ?? null;
  }

  // Stores a kind's level and counters. A new kind starts at 'ask' with zero counts (原則13).
  function setAutonomy(kind, fields, opts) {
    const w = requireWriter(opts);
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
    const changes = diff(before, next, columns);
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
    if (habit) return { kind: 'habit', ...present(habit), records: records(id) };
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
      const tasks = taskStmt.all(g.id, ...openArgs).filter(matches);
      if (matches(g) || tasks.length > 0) goals.push({ ...present(g), tasks: tasks.map((r) => taskView(r, holds)) });
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
        reason: `${t.device} が持ったまま、${days}日動きがありません`,
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
  });

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
      throw new LedgerError([`デバイス ${name} には使える鍵がもうあります。新しくするときは、先に取り消します(key revoke)`]);
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
  // transaction with one record. Habits, devices, autonomy and records stay. A hold stays when
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
      const source = typeof doc.source === 'string' && doc.source.trim() !== '' ? doc.source : 'snapshot';
      record(w, 'import', source, 'replace', changes);
      return { counts, flagged: snap.flagged, skipped: snap.skipped, detached_habits: detached, dropped_holds: droppedHolds };
    });
  }

  return {
    replaceFromSnapshot,
    createGoal,
    createTask,
    update,
    setState,
    reopen,
    link,
    unlink,
    start,
    release,
    held,
    createHabit,
    updateHabit,
    stopHabit,
    createPlace,
    updatePlace,
    upsertPlace,
    placePath,
    placeFor,
    setAutonomy,
    getAutonomy,
    get,
    board,
    search,
    flow,
    stale,
    records,
    addDevice,
    issueKey,
    revokeKey,
    listDevices,
    deviceForKey,
    oauth,
    close: () => {
      if (db.isOpen) db.close();
    },
  };
}
