// Snapshots: a whole outside task list as JSON, written by an outside converter
// (docs/snapshot.md). In stage A the ledger mirrors it: replaceFromSnapshot() in ledger.mjs
// swaps its goals, tasks, blocks and places for the rows this module prepares.
// Pure functions: no I/O, no clock.
//
// Two kinds of problems are told apart:
// - structural: the row cannot be stored or referenced (bad id, no title, a value outside
//   the enumerations, a date that does not parse). The row is skipped.
// - rule problems: what rules.mjs reports. The row is stored, with `review` listing them.

import {
  STATES,
  CLOSED_STATES,
  MODES,
  HUMAN_TIME_MODES,
  LOADS,
  STATE_FIELDS,
  ALL_STATE_FIELDS,
  isValidDue,
  isValidId,
  checkGoal,
  checkTask,
  checkBlock,
  checkStateExtra,
} from './rules.mjs';

export const SNAPSHOT_FORMAT = 'warifuri-snapshot';
export const SNAPSHOT_VERSION = 1;
const LISTS = ['places', 'goals', 'tasks', 'blocks'];

const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const orNull = (v) => (isBlank(v) ? null : v);

// Problems with the envelope. Any problem here stops the whole import.
export function checkEnvelope(doc) {
  if (!isObject(doc)) return ['スナップショットは JSON のオブジェクトです'];
  const p = [];
  if (doc.format !== SNAPSHOT_FORMAT) p.push(`format は "${SNAPSHOT_FORMAT}" です`);
  if (doc.version !== SNAPSHOT_VERSION) {
    p.push(`version は ${SNAPSHOT_VERSION} です(この warifuri が読めるのは version ${SNAPSHOT_VERSION} だけです)`);
  }
  for (const k of LISTS) if (!Array.isArray(doc[k])) p.push(`${k} は並び(配列)です`);
  if (doc.source !== undefined && doc.source !== null && typeof doc.source !== 'string') p.push('source は文字列です');
  if (!isBlank(doc.taken_at) && !isValidDue(doc.taken_at)) {
    p.push('taken_at は時差つきの ISO 日時(例 2026-10-24T09:00:00+09:00)で書きます');
  }
  return p;
}

function textProblems(raw, fields) {
  return fields
    .filter((f) => raw[f] !== undefined && raw[f] !== null && typeof raw[f] !== 'string')
    .map((f) => `${f} は文字列です`);
}

function dateProblems(raw, fields) {
  return fields
    .filter((f) => !isBlank(raw[f]) && !isValidDue(raw[f]))
    .map((f) => `${f} ${raw[f]} は日付として読めません(YYYY-MM-DD か、時差つきの ISO 日時で書きます)`);
}

// The state, and only the fields that belong to it. Fields of other states are left out,
// with a note for the review list.
function stateOf(raw, at, notes) {
  const given = {};
  for (const f of ALL_STATE_FIELDS) if (!isBlank(raw[f])) given[f] = raw[f];
  notes.push(...checkStateExtra(raw.state, given).map((s) => `${s}。入れずにおきました`));
  const keep = STATE_FIELDS[raw.state] ?? [];
  const out = { state: raw.state };
  for (const f of ALL_STATE_FIELDS) out[f] = keep.includes(f) ? (given[f] ?? null) : null;
  // A closed row keeps when it was closed, if the snapshot says so; otherwise the import time.
  const closed = CLOSED_STATES.includes(raw.state);
  if (!isBlank(raw.closed_at) && !closed) notes.push(`${raw.state} の行の closed_at。入れずにおきました`);
  else if (!isBlank(raw.closed_at) && !isValidDue(raw.closed_at)) notes.push(`closed_at ${raw.closed_at} は日時として読めません。取り込んだ時刻にしました`);
  out.closed_at = closed ? (!isBlank(raw.closed_at) && isValidDue(raw.closed_at) ? raw.closed_at : at) : null;
  return out;
}

// Turns a snapshot (whose envelope passed checkEnvelope) into rows ready to insert.
// at: the timestamp for created_at/updated_at (and closed_at of closed rows that do not give one).
// reservedIds: ids the ledger keeps through the import (habits), which the snapshot may not use.
export function prepareSnapshot(doc, { at, reservedIds = new Set() }) {
  const skipped = [];
  const skip = (kind, id, problems) => skipped.push({ kind, id, problems });
  const label = (list, i, raw) => (isObject(raw) && typeof raw.id === 'string' && raw.id !== '' ? raw.id : `${list}[${i}]`);

  // An id given more than once cannot be told apart, so no copy of it is imported.
  const uses = new Map();
  for (const list of ['places', 'goals', 'tasks']) {
    for (const raw of doc[list]) if (isObject(raw) && typeof raw.id === 'string') uses.set(raw.id, (uses.get(raw.id) ?? 0) + 1);
  }
  function idProblems(raw) {
    if (!isObject(raw)) return ['行が JSON のオブジェクトではありません'];
    if (isBlank(raw.id)) return ['id がありません'];
    if (!isValidId(raw.id)) return [`id ${raw.id} は x_YYYYMMDDHHMMSS_xxxxxx の形ではありません`];
    if (uses.get(raw.id) > 1) return [`id ${raw.id} がスナップショットに${uses.get(raw.id)}回あります。どれを取るか決められないので、どれも入れません`];
    if (reservedIds.has(raw.id)) return [`id ${raw.id} は台帳の習慣が使っています`];
    return [];
  }

  // Places, and their paths (one per device). A bad path is skipped on its own.
  const places = [];
  const paths = [];
  doc.places.forEach((raw, i) => {
    const id = label('places', i, raw);
    const p = idProblems(raw);
    if (p.length === 0) {
      p.push(...textProblems(raw, ['name', 'profile']));
      if (isBlank(raw.name)) p.push('置き場には名前が要ります');
    }
    if (p.length) return skip('place', id, p);
    places.push({ id, name: raw.name, profile: orNull(raw.profile), created_at: at, updated_at: at });
    const list = raw.paths ?? [];
    if (!Array.isArray(list)) return skip('place_path', id, ['paths は [{device, path}] の並びです']);
    const devices = new Set();
    list.forEach((item, j) => {
      const pathId = `${id}:${isObject(item) && typeof item.device === 'string' ? item.device : j}`;
      if (!isObject(item) || isBlank(item.device) || isBlank(item.path) || typeof item.device !== 'string' || typeof item.path !== 'string') {
        return skip('place_path', pathId, ['置き場の道には、デバイス(device)と道(path)の両方が文字列で要ります']);
      }
      if (devices.has(item.device)) return skip('place_path', pathId, [`デバイス ${item.device} の道が2つあります。1つのデバイスに道は1つです`]);
      devices.add(item.device);
      paths.push({ place_id: id, device: item.device, path: item.path });
    });
  });
  const placeIds = new Set(places.map((x) => x.id));

  // What goals and tasks share: the checks that make a row unstorable.
  function itemProblems(raw, textFields) {
    const p = idProblems(raw);
    if (p.length) return p;
    p.push(...textProblems(raw, textFields));
    if (isBlank(raw.title)) p.push('題名(title)がありません');
    if (!STATES.includes(raw.state)) p.push(`状態 ${raw.state} は ${STATES.join(', ')} のどれでもありません`);
    if (!MODES.includes(raw.mode)) p.push(`mode ${raw.mode} は ${MODES.join(', ')} のどれでもありません`);
    p.push(...dateProblems(raw, ['due', 'defer_until']));
    return p;
  }
  const isFlagValue = (v) => [undefined, null, true, false, 0, 1].includes(v);
  const asFlag = (v) => (v === true || v === 1 ? 1 : 0);

  // Goals are prepared first and checked last, once their tasks are known (原則1: a goal with
  // a human-time task is a human-time goal).
  const goals = [];
  const goalNotes = new Map();
  doc.goals.forEach((raw, i) => {
    const id = label('goals', i, raw);
    const p = itemProblems(raw, ['title', 'outcome', 'profile', 'due', 'defer_until', ...ALL_STATE_FIELDS]);
    if (p.length === 0 && !isFlagValue(raw.human_led)) p.push('human_led は true か false です');
    if (p.length) return skip('goal', id, p);
    const notes = [];
    goals.push({
      id, title: raw.title, outcome: orNull(raw.outcome), due: orNull(raw.due), due_provisional: 0,
      mode: raw.mode, human_led: asFlag(raw.human_led), profile: orNull(raw.profile),
      ...stateOf(raw, at, notes), created_at: at, updated_at: at,
    });
    goalNotes.set(id, notes);
  });
  const goalIds = new Set(goals.map((x) => x.id));

  const tasks = [];
  const taskNotes = new Map();
  doc.tasks.forEach((raw, i) => {
    const id = label('tasks', i, raw);
    const p = itemProblems(raw, ['title', 'body', 'done_when', 'due', 'defer_until', 'next', ...ALL_STATE_FIELDS]);
    if (p.length === 0 && !isFlagValue(raw.delegated)) p.push('delegated は true か false です');
    if (p.length) return skip('task', id, p);
    const notes = [];
    // A reference to a row that is not imported is cut, not fatal: the task stays visible.
    let goalId = orNull(raw.goal_id);
    if (goalId !== null && !goalIds.has(goalId)) {
      notes.push(`ゴール ${goalId} がスナップショットから入らなかったので、ゴールなしで入れました`);
      goalId = null;
    }
    let placeId = orNull(raw.place_id);
    if (placeId !== null && !placeIds.has(placeId)) {
      notes.push(`置き場 ${placeId} がスナップショットから入らなかったので、置き場なしで入れました`);
      placeId = null;
    }
    let estimate = raw.estimate_min ?? null;
    if (estimate !== null && !(Number.isInteger(estimate) && estimate >= 0)) {
      notes.push(`見積り(estimate_min) ${JSON.stringify(estimate)} は0以上の整数(分)ではないので、入れずにおきました`);
      estimate = null;
    }
    let load = orNull(raw.load);
    if (load !== null && !LOADS.includes(load)) {
      notes.push(`重さ(load) ${JSON.stringify(load)} は ${LOADS.join(', ')} のどれでもないので、入れずにおきました`);
      load = null;
    }
    tasks.push({
      id, title: raw.title, body: orNull(raw.body), done_when: orNull(raw.done_when), goal_id: goalId, mode: raw.mode,
      load, estimate_min: estimate, due: orNull(raw.due), due_provisional: 0, place_id: placeId,
      next: orNull(raw.next), delegated: asFlag(raw.delegated), ...stateOf(raw, at, notes), created_at: at, updated_at: at,
    });
    taskNotes.set(id, notes);
  });
  const taskIds = new Set(tasks.map((x) => x.id));

  // Rule problems, in document order: goals, then tasks.
  const flagged = [];
  const review = (id, problems) => {
    const unique = [...new Set(problems)];
    if (unique.length === 0) return null;
    flagged.push({ id, problems: unique });
    return unique;
  };
  const humanGoals = new Set(tasks.filter((x) => x.goal_id !== null && HUMAN_TIME_MODES.includes(x.mode)).map((x) => x.goal_id));
  for (const row of goals) {
    row.review = review(row.id, [...goalNotes.get(row.id), ...checkGoal(row, { hasHumanTimeTask: humanGoals.has(row.id) })]);
  }
  for (const row of tasks) {
    row.review = review(row.id, [...taskNotes.get(row.id), ...checkTask(row, { goalExists: true, placeExists: true })]);
  }

  // Blocks in the order given. The edge that would close a cycle is the one skipped.
  const next = new Map();
  const reaches = (from, to) => {
    const stack = [from];
    const seen = new Set();
    while (stack.length) {
      const n = stack.pop();
      if (n === to) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(next.get(n) ?? []));
    }
    return false;
  };
  const blocks = [];
  doc.blocks.forEach((raw, i) => {
    if (!isObject(raw) || typeof raw.before_id !== 'string' || typeof raw.after_id !== 'string') {
      return skip('block', `blocks[${i}]`, ['順序には before_id と after_id が文字列で要ります']);
    }
    const { before_id: b, after_id: a } = raw;
    const id = `${b}>${a}`;
    const ctx = { beforeIsTask: taskIds.has(b), afterIsTask: taskIds.has(a) };
    ctx.createsCycle = ctx.beforeIsTask && ctx.afterIsTask && b !== a && reaches(a, b);
    const p = checkBlock(b, a, ctx);
    if (p.length === 0 && next.get(b)?.has(a)) p.push('同じ順序が2回あります');
    if (p.length) return skip('block', id, p);
    if (!next.has(b)) next.set(b, new Set());
    next.get(b).add(a);
    blocks.push({ before_id: b, after_id: a });
  });

  return { places, paths, goals, tasks, blocks, flagged, skipped };
}
