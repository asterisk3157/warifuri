// What a machine may read, as pure functions: no I/O.
// A row's effective secrecy is the strictest of its own, its goal's and its place's
// ('withhold' beats 'open'; null inherits). A goal's is its own. A machine without
// read_withheld sees a withheld row only as its title, state and due date (docs/構成.md).
// Place paths are never returned by the MCP tools, whoever asks.

// The strictest of the given secrecy values; null and undefined say nothing.
export function effectiveSecrecy(...values) {
  return values.includes('withhold') ? 'withhold' : 'open';
}

// index: { goals: Map(id → secrecy), places: Map(id → secrecy),
//          tasks: Map(id → { secrecy, goal_id, place_id }) }, as ledger.secrecyIndex() returns.
export function taskSecrecy(task, index) {
  return effectiveSecrecy(
    task.secrecy,
    task.goal_id ? index.goals.get(task.goal_id) : null,
    task.place_id ? index.places.get(task.place_id) : null,
  );
}

export function goalSecrecy(goal) {
  return effectiveSecrecy(goal.secrecy);
}

const reducedTask = (t) => ({ kind: 'task', id: t.id, title: t.title, state: t.state, due: t.due, goal_id: t.goal_id ?? null, withheld: true });

function canRead(machine) {
  return machine?.read_withheld === true;
}

// A task as a machine may see it (board rows, a goal's tasks).
function taskFor(task, index, machine) {
  if (canRead(machine) || taskSecrecy(task, index) === 'open') return task;
  return reducedTask(task);
}

// A goal as a machine may see it, with its tasks seen the same way.
function goalFor(goal, index, machine) {
  if (canRead(machine) || goalSecrecy(goal) === 'open') {
    if (!Array.isArray(goal.tasks)) return goal;
    return { ...goal, tasks: goal.tasks.map((t) => taskFor(t, index, machine)) };
  }
  const out = { kind: 'goal', id: goal.id, title: goal.title, state: goal.state, due: goal.due, withheld: true };
  if (Array.isArray(goal.tasks)) out.tasks = goal.tasks.map(reducedTask);
  return out;
}

// A place without its paths, and its records without the paths they once held.
function placeFor(place, machine) {
  if (!canRead(machine) && place.secrecy === 'withhold') {
    return { kind: 'place', id: place.id, name: place.name, withheld: true };
  }
  const { paths, ...rest } = place;
  if (Array.isArray(rest.records)) {
    rest.records = rest.records.map((r) => {
      if (!r.changes || !('paths' in r.changes)) return r;
      const { paths: _drop, ...changes } = r.changes;
      return { ...r, changes };
    });
  }
  return rest;
}

// ledger.board() as a machine may see it.
export function redactBoard(board, index, machine) {
  return {
    goals: board.goals.map((g) => goalFor(g, index, machine)),
    unassigned: board.unassigned.map((t) => taskFor(t, index, machine)),
  };
}

// ledger.get() as a machine may see it. null stays null.
export function redactItem(item, index, machine) {
  if (!item) return item;
  if (item.kind === 'goal') return goalFor(item, index, machine);
  if (item.kind === 'task') return taskFor(item, index, machine);
  if (item.kind === 'place') return placeFor(item, machine);
  return item; // habits are returned as they are
}

// ledger.search() as a machine may see it.
export function redactSearch(results, index, machine) {
  return results.map((r) => {
    if (canRead(machine)) return r;
    const secrecy = r.kind === 'goal' ? effectiveSecrecy(index.goals.get(r.id)) : taskSecrecyById(r.id, index);
    if (secrecy === 'open') return r;
    return { kind: r.kind, id: r.id, title: r.title, state: r.state, due: r.due, withheld: true };
  });
}

// A task's effective secrecy from the index alone. An id the index does not know is withheld.
function taskSecrecyById(id, index) {
  const t = index.tasks.get(id);
  return t ? taskSecrecy(t, index) : 'withhold';
}
