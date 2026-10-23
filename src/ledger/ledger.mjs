// The ledger: goals, tasks, their order, habits, places and the secretary's autonomy levels,
// kept in one SQLite file through node:sqlite. Every write is checked against rules.mjs,
// runs in one transaction and appends one row to `records` (who changed what, before/after).
// A refused write changes nothing and throws a LedgerError carrying every problem found.
// replaceFromSnapshot() is the one write that takes rows breaking the rules: it stores them
// with `review` set, and the next write to such a row must pass the rules (which clears it).

import { DatabaseSync } from 'node:sqlite';
import { randomInt } from 'node:crypto';
import { migrate } from './schema.mjs';
import { checkEnvelope, prepareSnapshot } from './snapshot.mjs';
import {
  STATES,
  CLOSED_STATES,
  ALL_STATE_FIELDS,
  isValidId,
  checkActor,
  checkGoal,
  checkTask,
  checkBlock,
  checkHabit,
  checkPlace,
  checkAutonomy,
  checkStateExtra,
  applyState,
} from './rules.mjs';

export class LedgerError extends Error {
  constructor(problems) {
    super(problems.join(' / '));
    this.name = 'LedgerError';
    this.problems = problems;
  }
}

const GOAL_COLUMNS = [
  'id', 'title', 'outcome', 'due', 'due_provisional', 'state', 'mode', 'human_led', 'area', 'secrecy',
  'waiting_on', 'waiting_for', 'result', 'reason', 'defer_until', 'review', 'created_at', 'updated_at', 'closed_at',
];
const TASK_COLUMNS = [
  'id', 'title', 'done_when', 'goal_id', 'state', 'mode', 'estimate_min', 'due', 'due_provisional', 'place_id',
  'waiting_on', 'waiting_for', 'result', 'reason', 'defer_until', 'secrecy', 'review', 'created_at', 'updated_at', 'closed_at',
];
const HABIT_COLUMNS = ['id', 'title', 'rule', 'duration_min', 'goal_id', 'active', 'created_at', 'updated_at'];
const PLACE_COLUMNS = ['id', 'name', 'area', 'secrecy', 'created_at', 'updated_at'];

// Fields a caller may change with update(); state and its fields go through setState().
const GOAL_EDITABLE = ['title', 'outcome', 'due', 'due_provisional', 'mode', 'human_led', 'area', 'secrecy'];
const TASK_EDITABLE = ['title', 'done_when', 'due', 'due_provisional', 'mode', 'goal_id', 'estimate_min', 'place_id', 'secrecy'];
const HABIT_EDITABLE = ['title', 'rule', 'duration_min', 'goal_id', 'active'];
const FLAG_FIELDS = ['due_provisional', 'human_led', 'active'];
const ID_PREFIX = { goal: 'g', task: 't', habit: 'h', place: 'p' };
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

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

function requireActor(opts) {
  const p = checkActor(opts?.actor);
  if (p.length) throw new LedgerError(p);
  return opts.actor;
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

  function record(actor, entity, entityId, action, changes) {
    db.prepare(
      'INSERT INTO records (at, actor, entity, entity_id, action, changes) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(nowIso(), actor, entity, entityId, action, JSON.stringify(changes));
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
  const getTaskRow = (id) => one('SELECT * FROM tasks WHERE id = ?', id);
  const getHabitRow = (id) => one('SELECT * FROM habits WHERE id = ?', id);
  const getPlaceRow = (id) => one('SELECT * FROM places WHERE id = ?', id);

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

  function taskContext(row) {
    return {
      goalExists: row.goal_id ? !!getGoalRow(row.goal_id) : true,
      placeExists: row.place_id ? !!getPlaceRow(row.place_id) : true,
    };
  }

  function createGoal(fields, opts) {
    const actor = requireActor(opts);
    const input = normalizeFlags(fields ?? {});
    const problems = unknownFields(input, ['id', 'state', ...GOAL_EDITABLE, ...ALL_STATE_FIELDS]);
    const id = chooseId('goal', input.id, problems);
    const { state, extra } = initialState(input, problems);
    const t = nowIso();
    let row = {
      id, title: input.title, outcome: input.outcome ?? null, due: input.due ?? null,
      due_provisional: input.due_provisional ?? 0, state: 'ready', mode: input.mode,
      human_led: input.human_led ?? 0, area: input.area ?? null, secrecy: input.secrecy ?? 'open',
      created_at: t, updated_at: t,
    };
    row = applyState(row, state, extra, t);
    problems.push(...checkGoal(row));
    if (problems.length) throw new LedgerError(problems);
    return transaction(() => {
      insert('goals', GOAL_COLUMNS, row);
      record(actor, 'goal', id, 'create', diff(null, row, GOAL_COLUMNS));
      return present(getGoalRow(id));
    });
  }

  function createTask(fields, opts) {
    const actor = requireActor(opts);
    const input = normalizeFlags(fields ?? {});
    const problems = unknownFields(input, ['id', 'state', ...TASK_EDITABLE, ...ALL_STATE_FIELDS]);
    const id = chooseId('task', input.id, problems);
    const { state, extra } = initialState(input, problems);
    const t = nowIso();
    let row = {
      id, title: input.title, done_when: input.done_when ?? null, goal_id: input.goal_id ?? null,
      state: 'ready', mode: input.mode, estimate_min: input.estimate_min ?? null, due: input.due ?? null,
      due_provisional: input.due_provisional ?? 0, place_id: input.place_id ?? null,
      secrecy: input.secrecy ?? null, created_at: t, updated_at: t,
    };
    row = applyState(row, state, extra, t);
    problems.push(...checkTask(row, taskContext(row)));
    if (problems.length) throw new LedgerError(problems);
    return transaction(() => {
      insert('tasks', TASK_COLUMNS, row);
      record(actor, 'task', id, 'create', diff(null, row, TASK_COLUMNS));
      return present(getTaskRow(id));
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

  function validate(kind, row) {
    return kind === 'goal' ? checkGoal(row) : checkTask(row, taskContext(row));
  }

  // Writes a changed goal or task with one record; returns the row unchanged when nothing differs.
  function writeItem(item, next, actor, action) {
    const changes = diff(item.row, next, item.columns);
    if (Object.keys(changes).length === 0) return present(item.row);
    next.updated_at = nowIso();
    return transaction(() => {
      updateRow(item.table, item.columns, next);
      record(actor, item.kind, next.id, action, changes);
      return present(one(`SELECT * FROM ${item.table} WHERE id = ?`, next.id));
    });
  }

  function update(id, fields, opts) {
    const actor = requireActor(opts);
    const item = findItem(id);
    if (!item) throw new LedgerError([`${id} というゴールもタスクもありません`]);
    const input = normalizeFlags(fields ?? {});
    const problems = unknownFields(input, item.kind === 'goal' ? GOAL_EDITABLE : TASK_EDITABLE);
    const next = { ...item.row };
    for (const [k, v] of Object.entries(input)) next[k] = v === undefined ? next[k] : v;
    problems.push(...validate(item.kind, next));
    if (problems.length) throw new LedgerError(problems);
    next.review = null; // the row now passes the rules
    return writeItem(item, next, actor, 'update');
  }

  function setState(id, state, extra = {}, opts) {
    const actor = requireActor(opts);
    const item = findItem(id);
    if (!item) throw new LedgerError([`${id} というゴールもタスクもありません`]);
    const problems = [];
    if (!STATES.includes(state)) problems.push(`状態は ${STATES.join(', ')} のどれかです`);
    else problems.push(...checkStateExtra(state, extra ?? {}));
    if (problems.length) throw new LedgerError(problems);
    const next = applyState(item.row, state, extra ?? {}, nowIso());
    problems.push(...validate(item.kind, next));
    if (problems.length) throw new LedgerError(problems);
    next.review = null; // the row now passes the rules
    return writeItem(item, next, actor, 'state');
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
    const actor = requireActor(opts);
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
      record(actor, 'block', `${beforeId}>${afterId}`, 'link', { before_id: beforeId, after_id: afterId });
      return { before_id: beforeId, after_id: afterId };
    });
  }

  function unlink(beforeId, afterId, opts) {
    const actor = requireActor(opts);
    if (!one('SELECT 1 FROM blocks WHERE before_id = ? AND after_id = ?', beforeId, afterId)) {
      throw new LedgerError([`${beforeId} → ${afterId} の順序はありません`]);
    }
    return transaction(() => {
      db.prepare('DELETE FROM blocks WHERE before_id = ? AND after_id = ?').run(beforeId, afterId);
      record(actor, 'block', `${beforeId}>${afterId}`, 'unlink', { before_id: beforeId, after_id: afterId });
      return { before_id: beforeId, after_id: afterId };
    });
  }

  function createHabit(fields, opts) {
    const actor = requireActor(opts);
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
      record(actor, 'habit', id, 'create', diff(null, row, HABIT_COLUMNS));
      return present(getHabitRow(id));
    });
  }

  function updateHabit(id, fields, opts) {
    const actor = requireActor(opts);
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
      record(actor, 'habit', id, 'update', changes);
      return present(getHabitRow(id));
    });
  }

  function placeWithPaths(id) {
    const row = getPlaceRow(id);
    if (!row) return null;
    return { ...row, paths: all('SELECT machine, path FROM place_paths WHERE place_id = ? ORDER BY machine', id) };
  }

  function createPlace(fields, opts) {
    const actor = requireActor(opts);
    const input = fields ?? {};
    const problems = unknownFields(input, ['id', 'name', 'area', 'secrecy', 'paths']);
    const id = chooseId('place', input.id, problems);
    const t = nowIso();
    const row = {
      id, name: input.name, area: input.area ?? null, secrecy: input.secrecy ?? 'open',
      created_at: t, updated_at: t,
    };
    const paths = input.paths ?? [];
    if (!Array.isArray(paths)) problems.push('paths は [{machine, path}] の並びです');
    else problems.push(...checkPlace({ ...row, paths }));
    if (problems.length) throw new LedgerError(problems);
    return transaction(() => {
      insert('places', PLACE_COLUMNS, row);
      const ins = db.prepare('INSERT INTO place_paths (place_id, machine, path) VALUES (?, ?, ?)');
      for (const p of paths) ins.run(id, p.machine, p.path);
      const changes = diff(null, row, PLACE_COLUMNS);
      changes.paths = { before: null, after: paths.map((p) => ({ machine: p.machine, path: p.path })) };
      record(actor, 'place', id, 'create', changes);
      return placeWithPaths(id);
    });
  }

  // The path of a place on one machine, or null when that machine has none.
  function placePath(placeId, machine) {
    return one('SELECT path FROM place_paths WHERE place_id = ? AND machine = ?', placeId, machine)?.path ?? null;
  }

  function getAutonomy(kind) {
    return one('SELECT * FROM autonomy WHERE kind = ?', kind) ?? null;
  }

  // Stores a kind's level and counters. A new kind starts at 'ask' with zero counts (原則13).
  function setAutonomy(kind, fields, opts) {
    const actor = requireActor(opts);
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
      record(actor, 'autonomy', kind, before ? 'update' : 'create', changes);
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
      return {
        kind: 'goal',
        ...present(goal),
        tasks: all('SELECT * FROM tasks WHERE goal_id = ? ORDER BY created_at, id', id).map(present),
        records: records(id),
      };
    }
    const task = getTaskRow(id);
    if (task) {
      return {
        kind: 'task',
        ...present(task),
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

  // Open goals, each with its tasks, and the tasks with no goal.
  // area filters goals (and goal-less tasks by their place's area); state, mode and review
  // (true: only rows flagged on import) filter goals and tasks alike, and a goal also appears
  // when any of its tasks match.
  function board({ area, state, mode, review = false, includeClosed = false } = {}) {
    const closed = CLOSED_STATES.map(() => '?').join(', ');
    const openOnly = (alias) => (includeClosed ? '' : ` AND ${alias}.state NOT IN (${closed})`);
    const openArgs = includeClosed ? [] : CLOSED_STATES;
    const matches = (row) =>
      (state === undefined || row.state === state) &&
      (mode === undefined || row.mode === mode) &&
      (!review || row.review !== null);

    const goalRows = all(
      `SELECT g.* FROM goals g WHERE 1 = 1${openOnly('g')}${area !== undefined ? ' AND g.area = ?' : ''} ` +
        'ORDER BY g.due IS NULL, g.due, g.created_at, g.id',
      ...openArgs,
      ...(area !== undefined ? [area] : []),
    );
    const taskStmt = db.prepare(
      `SELECT t.* FROM tasks t WHERE t.goal_id = ?${openOnly('t')} ORDER BY t.created_at, t.id`,
    );
    const goals = [];
    for (const g of goalRows) {
      const tasks = taskStmt.all(g.id, ...openArgs).filter(matches);
      if (matches(g) || tasks.length > 0) goals.push({ ...present(g), tasks: tasks.map(present) });
    }
    const loose = all(
      `SELECT t.* FROM tasks t LEFT JOIN places p ON p.id = t.place_id WHERE t.goal_id IS NULL${openOnly('t')}` +
        `${area !== undefined ? ' AND p.area = ?' : ''} ORDER BY t.created_at, t.id`,
      ...openArgs,
      ...(area !== undefined ? [area] : []),
    ).filter(matches);
    return { goals, unassigned: loose.map(present) };
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

  // Replaces goals, tasks, blocks and places with a snapshot (docs/snapshot.md), in one
  // transaction with one record. Habits, autonomy and records stay. Rows that cannot be stored
  // are skipped; rows that break the rules are stored with `review`. A habit whose goal is not
  // in the snapshot loses that link. A bad envelope throws and changes nothing.
  function replaceFromSnapshot(doc, opts) {
    const actor = requireActor(opts);
    const envelope = checkEnvelope(doc);
    if (envelope.length) throw new LedgerError(envelope);
    const t = nowIso();
    return transaction(() => {
      // Habits may point at goals that are deleted and inserted again; check at commit.
      db.exec('PRAGMA defer_foreign_keys = ON');
      const reservedIds = new Set(all('SELECT id FROM habits').map((r) => r.id));
      const snap = prepareSnapshot(doc, { at: t, reservedIds });
      for (const table of ['blocks', 'tasks', 'goals', 'place_paths', 'places']) db.exec(`DELETE FROM ${table}`);
      for (const row of snap.places) insert('places', PLACE_COLUMNS, row);
      const insPath = db.prepare('INSERT INTO place_paths (place_id, machine, path) VALUES (?, ?, ?)');
      for (const p of snap.paths) insPath.run(p.place_id, p.machine, p.path);
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

      const counts = { places: snap.places.length, goals: snap.goals.length, tasks: snap.tasks.length, blocks: snap.blocks.length };
      const changes = {
        taken_at: doc.taken_at ?? null,
        counts,
        flagged: snap.flagged.length,
        skipped: snap.skipped.length,
      };
      if (detached.length) changes.detached_habits = detached;
      const source = typeof doc.source === 'string' && doc.source.trim() !== '' ? doc.source : 'snapshot';
      record(actor, 'import', source, 'replace', changes);
      return { counts, flagged: snap.flagged, skipped: snap.skipped, detached_habits: detached };
    });
  }

  return {
    replaceFromSnapshot,
    createGoal,
    createTask,
    update,
    setState,
    link,
    unlink,
    createHabit,
    updateHabit,
    createPlace,
    placePath,
    setAutonomy,
    getAutonomy,
    get,
    board,
    search,
    records,
    close: () => {
      if (db.isOpen) db.close();
    },
  };
}
