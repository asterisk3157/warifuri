// The MCP tools as a device with a scope (src/ledger/scope.mjs) sees them: a guest, such as an
// AI that runs in someone else's cloud. Only the read tools of GUEST_READ_TOOLS and the write
// tools its scope allows are registered; the others are not in its list of tools at all.
// Each registered tool is wrapped: before, the arguments are checked (a guest names a profile,
// never a place, since it has no directories); after, what it may not see is taken out of the
// answer. A goal, task, habit or place of a profile it may not see answers as if it were not
// there. 下調べ (prep) is written, and offered by prep_candidates, only for tasks of a profile it
// sees in full (details not hidden).

import { seesProfile, hides } from '../ledger/scope.mjs';

export const GUEST_READ_TOOLS = ['board', 'get', 'search', 'flow', 'schedule', 'free_time', 'timetable', 'people', 'context', 'prep_candidates'];

// Whether the scope may write 下調べ to (and be offered) a task of this profile: a profile it
// sees, with the details not hidden. A task with no profile always may.
export const prepAllowed = (scope, profile) => seesProfile(scope, profile) && !hides(scope, profile ?? null, 'details');

// What is kept of a goal or task whose profile hides its details.
const TASK_KEEP = ['id', 'kind', 'title', 'state', 'due', 'due_provisional', 'goal_id', 'profile', 'mode', 'created_at', 'updated_at', 'closed_at', 'open_before', 'actionable'];
const GOAL_KEEP = ['id', 'kind', 'title', 'state', 'due', 'due_provisional', 'profile', 'mode', 'created_at', 'updated_at', 'closed_at'];
const HABIT_KEEP = ['id', 'kind', 'title', 'rule', 'duration_min', 'active', 'goal_id', 'created_at', 'updated_at'];
// What is kept of a booking: its title and time. location only when the details are shown.
const BOOKING_KEEP = ['id', 'kind', 'title', 'starts_at', 'ends_at', 'task_id', 'habit_id', 'task', 'habit', 'goal', 'profile'];

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));

const errorResult = (message) => ({ content: [{ type: 'text', text: message }], isError: true });
const asResult = (value, text = value) => ({ content: [{ type: 'text', text: JSON.stringify(text, null, 2) }], structuredContent: value });

const notThere = (id) => errorResult(`${id} というゴール・タスク・習慣・作業フォルダはありません`);

// The profile a goal, task, habit or place belongs to, or null (also when there is no such item).
function profileOf(ledger, id) {
  const item = id ? ledger.get(id) : null;
  if (!item) return null;
  if (item.kind === 'habit') return item.goal_id ? (ledger.get(item.goal_id)?.profile ?? null) : null;
  return item.profile ?? null;
}

const slimTask = (t) => ({ ...pick(t, TASK_KEEP), details_hidden: true });
const slimGoal = (g) => ({
  ...pick(g, GOAL_KEEP),
  ...(Array.isArray(g.tasks) ? { tasks: g.tasks.map(slimTask) } : {}),
  details_hidden: true,
});

// A task as the scope shows it: null when its profile is not seen.
const showTask = (scope, t) => {
  if (!seesProfile(scope, t.profile)) return null;
  return hides(scope, t.profile, 'details') ? slimTask(t) : t;
};

// The guest names a profile it may see; a place is refused, since it has no directories.
function needProfile(scope, { place, profile }, tool, what) {
  if (place !== undefined) return errorResult(`この鍵では place を使えません。${tool} には profile を渡します`);
  if (profile === undefined) return what ? errorResult(`${tool} には profile を渡します`) : null;
  if (!seesProfile(scope, profile)) return errorResult(`プロフィール ${profile} は、この鍵には見せていません`);
  if (what && hides(scope, profile, what)) {
    const words = { people: '人', knowledge: 'ナレッジ' }[what];
    return errorResult(`プロフィール ${profile} の${words}は、この鍵には見せていません`);
  }
  return null;
}

const GUARDS = {
  board: {
    before: (ledger, scope, args) => needProfile(scope, args, 'board'),
    after: (ledger, scope, out) => ({
      ...out,
      goals: out.goals
        .filter((g) => seesProfile(scope, g.profile))
        .map((g) => (hides(scope, g.profile, 'details') ? slimGoal(g) : g)),
      unassigned: out.unassigned.map((t) => showTask(scope, t)).filter(Boolean),
    }),
  },
  get: {
    after: (ledger, scope, item, args) => {
      const profile = item.kind === 'habit' ? profileOf(ledger, item.id) : (item.profile ?? null);
      if (!seesProfile(scope, profile)) return notThere(args.id);
      if (!hides(scope, profile, 'details')) return item;
      if (item.kind === 'goal') return slimGoal(item);
      if (item.kind === 'task') return slimTask(item);
      if (item.kind === 'habit') return { ...pick(item, HABIT_KEEP), details_hidden: true };
      return notThere(args.id);
    },
  },
  search: {
    after: (ledger, scope, out) => {
      const results = out.results.filter((r) => seesProfile(scope, profileOf(ledger, r.id)));
      return { value: { results }, text: results };
    },
  },
  flow: {
    before: (ledger, scope, args) => {
      const goal = ledger.get(args.goal_id);
      return goal?.kind === 'goal' && !seesProfile(scope, goal.profile) ? errorResult(`${args.goal_id} というゴールはありません`) : null;
    },
  },
  schedule: {
    after: (ledger, scope, out) => ({
      ...out,
      bookings: out.bookings
        .filter((b) => seesProfile(scope, b.profile))
        .map((b) => ({
          ...pick(b, BOOKING_KEEP),
          ...(hides(scope, b.profile, 'details') ? {} : { location: b.location ?? null }),
        })),
    }),
  },
  timetable: {
    after: (ledger, scope, out) => {
      const seen = (taskId) => !taskId || seesProfile(scope, profileOf(ledger, taskId));
      return {
        ...out,
        blocks: out.blocks.filter((b) => seesProfile(scope, b.profile ?? null) && seen(b.task_id)),
        changes: (out.changes ?? []).filter((c) => seen(c.task_id)),
        left: (out.left ?? []).filter((l) => seen(l.task_id)),
      };
    },
  },
  people: {
    before: (ledger, scope, args) => needProfile(scope, args, 'people', 'people'),
  },
  context: {
    before: (ledger, scope, args) => needProfile(scope, args, 'context', 'knowledge'),
    after: (ledger, scope, out, args) => {
      if (!hides(scope, args.profile, 'people') || !('people' in out)) return out;
      const { people: _people, ...rest } = out;
      return { ...rest, people: null, people_hidden: true };
    },
  },
  prep: {
    before: (ledger, scope, args) => {
      const task = typeof args.task_id === 'string' ? ledger.get(args.task_id) : null;
      if (task?.kind !== 'task' || !seesProfile(scope, task.profile)) return errorResult(`${args.task_id} というタスクはありません`);
      if (!prepAllowed(scope, task.profile)) return errorResult(`プロフィール ${task.profile} のタスクには、この鍵からは下調べを書けません`);
      return null;
    },
  },
  prep_candidates: {
    before: (ledger, scope, args) => needProfile(scope, args, 'prep_candidates'),
    after: (ledger, scope, out) => ({
      ...out,
      candidates: out.candidates.filter((c) => prepAllowed(scope, c.profile)),
      feedback: { ...out.feedback, bad: out.feedback.bad.filter((b) => prepAllowed(scope, b.profile)) },
    }),
  },
  note: {
    before: (ledger, scope, args) => {
      if (args.place !== undefined) return errorResult('この鍵では place を使えません。note には profile を渡します');
      if (args.profile === undefined) return errorResult('note には profile を渡します');
      if (!seesProfile(scope, args.profile) || (scope.hide[args.profile] ?? []).length > 0) {
        return errorResult(`プロフィール ${args.profile} には、この鍵からは書けません`);
      }
      return null;
    },
  },
};

// Stands in for the McpServer while the tools are registered: what registerTool is given for
// a tool out of the scope is dropped, and the rest is registered wrapped.
export function scopedRegistrar(server, ledger, scope) {
  const allowed = new Set([...GUEST_READ_TOOLS, ...scope.write]);
  return {
    registerTool(name, config, handler) {
      if (!allowed.has(name)) return null;
      const guard = GUARDS[name] ?? {};
      return server.registerTool(name, config, async (args, extra) => {
        const refused = guard.before?.(ledger, scope, args ?? {});
        if (refused) return refused;
        const out = await handler(args, extra);
        if (out?.isError || !guard.after || !out?.structuredContent) return out;
        const shaped = guard.after(ledger, scope, out.structuredContent, args ?? {});
        if (shaped?.isError) return shaped;
        if (shaped && 'value' in shaped && 'text' in shaped) return asResult(shaped.value, shaped.text);
        return asResult(shaped);
      });
    },
  };
}
