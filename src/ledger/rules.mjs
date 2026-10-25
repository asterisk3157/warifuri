// The ledger's rules, as pure functions: no I/O, no clock.
// Each check returns a list of problems (short Japanese sentences saying what is
// missing and why). An empty list means the row may be written. The ledger runs these
// on the merged row, so the same rules hold on create and on update.

export const STATES = ['ready', 'running', 'waiting', 'deferred', 'done', 'discarded'];
export const CLOSED_STATES = ['done', 'discarded'];
export const MODES = ['ai_worker', 'human_with_ai', 'human'];
export const HUMAN_TIME_MODES = ['human_with_ai', 'human'];
export const LOADS = ['heavy', 'normal', 'light'];
export const BODY_MAX = 2000;
export const AUTONOMY_LEVELS = ['ask', 'act_then_tell'];
// The kinds of the secretary's actions whose autonomy is kept (原則13), with the stage of
// each (2: its own place, 3: the database and knowledge). Stage 4 (going outside, or what
// cannot be undone) is never allowed, so no kind of it is here. A new kind is added here.
export const AUTONOMY_KINDS = [
  { kind: 'reschedule_block', label: 'ずれた予定の組み直し', stage: 2 },
  { kind: 'tidy_inbox', label: '受信箱の整理', stage: 2 },
  // Writing warifuri's own task and habit bookings to the person's main calendar, and moving
  // the events warifuri wrote there (told apart by source and external_id). The person's own
  // events, which have no pair in warifuri, are never edited or deleted: that is stage 4.
  { kind: 'write_calendar', label: '予定をカレンダーに書き出す', stage: 2 },
  { kind: 'close_forgotten', label: '閉じ忘れたタスクを閉じる', stage: 3 },
  { kind: 'move_task', label: 'タスクをほかのゴールへ移す', stage: 3 },
  { kind: 'bundle_loose_tasks', label: 'ゴールにつながっていないタスクを束ねる', stage: 3 },
  { kind: 'add_knowledge', label: 'ナレッジに入れる', stage: 3 },
  { kind: 'split_knowledge', label: 'ナレッジを分ける', stage: 3 },
  { kind: 'mark_stale_knowledge', label: 'ナレッジに古い印を付ける', stage: 3 },
];
// The outcome of one proposal: approved as proposed, approved with changes, refused, or
// cancelled by the person after it was done.
export const AUTONOMY_OUTCOMES = ['approved', 'changed', 'refused', 'revoked'];
// Approvals in a row that raise a kind to act_then_tell: the default the person agreed to
// when installing warifuri (原則13). It changes only on the person's word.
export const AUTONOMY_STREAK = 3;
export const BOOKING_KINDS = ['task', 'habit', 'fixed'];
export const BOOKING_MAX_MS = 24 * 60 * 60 * 1000;
// 報告: the secretary's nightly check, morning summary and inbox tidy-up.
export const REPORT_KINDS = ['nightly', 'morning', 'inbox'];
export const REPORT_TITLE_MAX = 200;
export const REPORT_BODY_MAX = 20000;
// 会話: a thread's runner, who wrote a message, and the states of a proposal. The person's
// message is kept short enough to read back; the secretary's reply may be as long as a report.
export const THREAD_KINDS = ['secretary'];
export const THREAD_RUNNERS = ['resume', 'resident'];
export const MESSAGE_ROLES = ['user', 'secretary', 'system'];
export const MESSAGE_MAX = 4000;
export const PROPOSAL_STATES = ['open', 'approved', 'changed', 'refused'];
// The answers the person gives to a proposal, as autonomy outcomes (revoked comes later, after
// the fact, through autonomy_outcome).
export const PROPOSAL_ANSWERS = ['approved', 'changed', 'refused'];
export const ANSWER_MAX = 1000;

// Fields that belong to a state. Leaving the state clears them.
export const STATE_FIELDS = {
  waiting: ['waiting_on', 'waiting_for'],
  done: ['result'],
  discarded: ['reason'],
  deferred: ['defer_until'],
};
export const ALL_STATE_FIELDS = ['waiting_on', 'waiting_for', 'result', 'reason', 'defer_until'];
// Moving a task to one of these lets go of its hold, and may leave a `next` for whoever picks it up.
export const RELEASING_STATES = ['done', 'discarded', 'waiting', 'deferred'];

// A caller-supplied id: one lowercase letter, 14 digits (YYYYMMDDHHMMSS), 6 lowercase alnum.
export const ID_PATTERN = /^[a-z]_[0-9]{14}_[a-z0-9]{6}$/;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d+)?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function isRealDate(y, m, d) {
  const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return (
    dt.getUTCFullYear() === Number(y) && dt.getUTCMonth() === Number(m) - 1 && dt.getUTCDate() === Number(d)
  );
}

// A date (YYYY-MM-DD) or an ISO datetime with an offset (Z or +09:00).
export function isValidDue(value) {
  if (typeof value !== 'string') return false;
  let m = DATE_RE.exec(value);
  if (m) return isRealDate(m[1], m[2], m[3]);
  m = DATETIME_RE.exec(value);
  if (m) return isRealDate(m[1], m[2], m[3]);
  return false;
}

// An ISO datetime with an offset (Z or +09:00); a date alone is not enough.
export function isValidDateTime(value) {
  if (typeof value !== 'string') return false;
  const m = DATETIME_RE.exec(value);
  return !!m && isRealDate(m[1], m[2], m[3]);
}

export function isValidId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const isFlag = (v) => v === 0 || v === 1;
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;
const isText = (v) => v === undefined || v === null || typeof v === 'string';
// Length in characters as a person counts them (code points, not UTF-16 units).
export const charLength = (s) => [...s].length;

export function checkActor(actor) {
  return typeof actor === 'string' && actor.trim() !== ''
    ? []
    : ['だれが書いたか(actor)が要ります。記録に残すためです(原則18)'];
}

// The device a write came from is optional, but when given it is a non-empty string.
export function checkWriterDevice(device) {
  if (device === undefined || device === null) return [];
  return typeof device === 'string' && device.trim() !== '' ? [] : ['device は空でない文字列です'];
}

function checkCommon(row, kind) {
  const p = [];
  if (isBlank(row.title)) p.push(`${kind}には題名が要ります`);
  if (!STATES.includes(row.state)) p.push(`状態は ${STATES.join(', ')} のどれかです`);
  if (!MODES.includes(row.mode)) p.push(`mode(だれの時間を使うか)は ${MODES.join(', ')} のどれかです(原則4)`);
  if (!isBlank(row.due) && !isValidDue(row.due)) {
    p.push('期日は YYYY-MM-DD か、時差つきの ISO 日時(例 2026-11-01T09:00:00+09:00)で書きます');
  }
  if (!isFlag(row.due_provisional)) p.push('due_provisional は 0 か 1 です');
  p.push(...checkStateFields(row));
  return p;
}

// The fields a state requires (原則5, 6). Shared by goals and tasks.
export function checkStateFields(row) {
  const p = [];
  if (row.state === 'waiting') {
    if (isBlank(row.waiting_on)) p.push('待ちには、だれを待つか(waiting_on)が要ります(原則6)');
    if (isBlank(row.waiting_for)) p.push('待ちには、何を待つか(waiting_for)が要ります(原則6)');
  }
  if (row.state === 'done' && isBlank(row.result)) p.push('完了には1行の成果(result)が要ります(原則5)');
  if (row.state === 'discarded' && isBlank(row.reason)) p.push('破棄には理由(reason)が要ります(原則5)');
  if (row.state === 'deferred') {
    if (isBlank(row.defer_until)) p.push('先送りには、いつまでか(defer_until)が要ります(原則5)');
    else if (!isValidDue(row.defer_until)) p.push('defer_until は YYYY-MM-DD か、時差つきの ISO 日時で書きます');
  }
  return p;
}

// What a human-time goal needs: an outcome and a due date the person set (原則1, 2).
// byTask: the goal counts as human-time only because it has a human-time task.
function humanTimeGoalProblems(row, byTask) {
  const p = [];
  const why = byTask ? '人の時間を使うタスクを持つゴールは、人の時間を使うゴールとして扱います(原則1)。そのため、' : '';
  if (isBlank(row.due)) p.push(`${why}人の時間を使うゴールには期日が要ります(原則2)`);
  else if (row.due_provisional === 1) p.push(`${why}人の時間を使うゴールの期日は、人が決めたものにします。仮の期日では足りません(原則2)`);
  if (isBlank(row.outcome)) p.push(`${why}人の時間を使うゴールには、あるべき姿(outcome)が要ります(原則1)`);
  return p;
}

// ctx.hasHumanTimeTask: whether any task of this goal uses a person's time (原則1).
export function checkGoal(row, ctx = {}) {
  const p = checkCommon(row, 'ゴール');
  if (HUMAN_TIME_MODES.includes(row.mode)) p.push(...humanTimeGoalProblems(row, false));
  else if (ctx.hasHumanTimeTask) p.push(...humanTimeGoalProblems(row, true));
  if (!isFlag(row.human_led)) p.push('human_led は 0 か 1 です');
  if (!isText(row.profile)) p.push('profile は文字列です');
  return p;
}

// Problems with putting a human-time task under `goal` (原則1): the goal would become a
// human-time goal, so it needs what one needs. Empty when the task is not human-time.
export function checkGoalTakesHumanTask(task, goal) {
  if (!goal || !HUMAN_TIME_MODES.includes(task.mode) || HUMAN_TIME_MODES.includes(goal.mode)) return [];
  return humanTimeGoalProblems(goal, true).map((s) => `ゴール ${goal.id}: ${s}`);
}

// ctx.goalExists / ctx.placeExists: whether goal_id / place_id name existing rows.
export function checkTask(row, ctx = {}) {
  const p = checkCommon(row, 'タスク');
  if (HUMAN_TIME_MODES.includes(row.mode) && isBlank(row.done_when)) {
    p.push('人の時間を使うタスクには完了の条件(done_when)が要ります(原則5)');
  }
  if (!isBlank(row.goal_id) && !ctx.goalExists) p.push(`ゴール ${row.goal_id} がありません`);
  if (!isBlank(row.place_id) && !ctx.placeExists) p.push(`作業フォルダ ${row.place_id} がありません`);
  if (row.estimate_min !== null && row.estimate_min !== undefined && !isNonNegInt(row.estimate_min)) {
    p.push('見積り(estimate_min)は0以上の整数(分)です');
  }
  if (!isText(row.body)) p.push('説明(body)は文字列です');
  else if (typeof row.body === 'string' && charLength(row.body) > BODY_MAX) {
    p.push(`説明(body)は${BODY_MAX}字までです(いまは${charLength(row.body)}字)。長い仕様や手順はリポジトリの文書に置き、その場所を書きます`);
  }
  if (row.load !== null && row.load !== undefined && !LOADS.includes(row.load)) {
    p.push(`重さ(load)は ${LOADS.join(', ')} のどれか、または空です`);
  }
  if (!isText(row.next)) p.push('次の一手(next)は文字列です');
  if (!isFlag(row.delegated)) p.push('delegated(任せるの印)は 0 か 1 です');
  return p;
}

// ctx.beforeIsTask / ctx.afterIsTask / ctx.createsCycle are looked up by the ledger.
export function checkBlock(beforeId, afterId, ctx = {}) {
  const p = [];
  if (!ctx.beforeIsTask) p.push(`先にやるタスク ${beforeId} がありません`);
  if (!ctx.afterIsTask) p.push(`あとにやるタスク ${afterId} がありません`);
  if (beforeId === afterId) p.push('タスクは自分自身の前には置けません');
  else if (ctx.createsCycle) p.push('この順序を足すと輪になります。順序は一方向にしか流れません(原則3)');
  return p;
}

// A habit's repeat rule (原則21): which days, and optionally the window of the day it goes in.
// { days: 'daily' | 'weekdays' | ['月', '水', '金'], window?: 'HH:MM-HH:MM' }. A window whose
// end is not after its start runs past midnight (23:00-07:00 belongs to the day it starts).
// The length (duration_min) is the habit's own column. Stored as JSON text in habits.rule.
export const HABIT_WEEKDAYS = ['月', '火', '水', '木', '金', '土', '日'];
export const HABIT_DAY_SETS = { daily: HABIT_WEEKDAYS, weekdays: HABIT_WEEKDAYS.slice(0, 5) };
const WINDOW_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;
const RULE_FORM =
  '繰り返しの決まり(rule)は {"days": "daily" か "weekdays" か ["月","水","金"] のような曜日の並び, "window": "07:00-07:30"(任意)} の形で書きます';

// Reads a rule given as an object or as its JSON text. Returns { rule, window_min, problems }:
// rule is the rule in its stored shape (a list of days in 月〜日 order, without repeats), or
// null; window_min is the window's length in minutes, or null without a window.
export function readHabitRule(value) {
  const fail = (problems) => ({ rule: null, window_min: null, problems });
  let v = value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return fail([RULE_FORM]);
    }
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return fail([RULE_FORM]);
  const p = Object.keys(v)
    .filter((k) => k !== 'days' && k !== 'window')
    .map((k) => `rule に ${k} は書けません(書けるのは days と window です)`);
  let days = null;
  if (typeof v.days === 'string' && Object.hasOwn(HABIT_DAY_SETS, v.days)) days = v.days;
  else if (Array.isArray(v.days) && v.days.length > 0) {
    const bad = v.days.filter((d) => !HABIT_WEEKDAYS.includes(d));
    if (bad.length) p.push(`rule の days の曜日は ${HABIT_WEEKDAYS.join('、')} のどれかです(${bad.map(String).join('、')} は読めません)`);
    else days = HABIT_WEEKDAYS.filter((d) => v.days.includes(d));
  } else p.push('rule の days は "daily"(毎日)、"weekdays"(月〜金)、または ["月","水","金"] のような曜日の並びです');
  let windowMin = null;
  if (v.window !== undefined) {
    const m = typeof v.window === 'string' ? WINDOW_RE.exec(v.window) : null;
    if (!m) p.push('rule の window は "07:00-07:30" のように、始まりと終わりの時刻(HH:MM)を - でつなぎます');
    else {
      const start = Number(m[1]) * 60 + Number(m[2]);
      const end = Number(m[3]) * 60 + Number(m[4]);
      if (start === end) p.push('rule の window の始まりと終わりが同じです');
      else windowMin = end > start ? end - start : end + 1440 - start;
    }
  }
  if (p.length) return fail(p);
  return { rule: v.window === undefined ? { days } : { days, window: v.window }, window_min: windowMin, problems: [] };
}

// The rule as it is stored: its JSON text in the stored shape, or the value unchanged when it
// cannot be read (checkHabit then says why).
export function habitRuleText(value) {
  if (isBlank(value)) return value;
  const { rule } = readHabitRule(value);
  return rule ? JSON.stringify(rule) : value;
}

export function checkHabit(row, ctx = {}) {
  const p = [];
  if (isBlank(row.title)) p.push('習慣には題名が要ります');
  const durationOk = Number.isInteger(row.duration_min) && row.duration_min > 0 && row.duration_min <= 1440;
  if (isBlank(row.rule)) p.push('習慣には繰り返しの決まり(rule)が要ります(原則21)');
  else {
    const r = readHabitRule(row.rule);
    p.push(...r.problems);
    if (durationOk && r.window_min !== null && row.duration_min > r.window_min) {
      p.push(`習慣の長さ(${row.duration_min}分)が、rule の window(${r.window_min}分)に収まりません`);
    }
  }
  if (!durationOk) p.push('習慣の長さ(duration_min)は1から1440までの整数(分)です');
  if (!isBlank(row.goal_id) && !ctx.goalExists) p.push(`ゴール ${row.goal_id} がありません`);
  if (!isFlag(row.active)) p.push('active は 0 か 1 です');
  return p;
}

// A booking (予定) about to be written. starts_at and ends_at are as the caller gave them.
// ctx.taskExists / ctx.habitExists: whether task_id / habit_id name existing rows.
export function checkBooking(row, ctx = {}) {
  const p = [];
  if (!BOOKING_KINDS.includes(row.kind)) p.push(`予定の種類(kind)は ${BOOKING_KINDS.join(', ')} のどれかです`);
  if (row.kind === 'task') {
    if (isBlank(row.task_id)) p.push('タスクの予定には、タスク(task_id)が要ります');
    else if (!ctx.taskExists) p.push(`タスク ${row.task_id} がありません`);
  } else if (!isBlank(row.task_id)) p.push('task_id は、種類が task の予定にだけ書けます');
  if (row.kind === 'habit') {
    if (isBlank(row.habit_id)) p.push('習慣の予定には、習慣(habit_id)が要ります');
    else if (!ctx.habitExists) p.push(`習慣 ${row.habit_id} がありません`);
  } else if (!isBlank(row.habit_id)) p.push('habit_id は、種類が habit の予定にだけ書けます');
  if (row.kind === 'fixed' && isBlank(row.title)) p.push('固定の予定には題名(title)が要ります');
  if (!isText(row.title)) p.push('題名(title)は文字列です');
  if (!isText(row.note)) p.push('メモ(note)は文字列です');
  if (!isText(row.source)) p.push('出どころ(source)は文字列です');
  if (!isText(row.external_id)) p.push('外の予定の id(external_id)は文字列です');
  else if (!isBlank(row.external_id) && isBlank(row.source)) {
    p.push('外の予定の id(external_id)には、出どころ(source)も要ります');
  }
  if (ctx.pairTakenBy) p.push(`出どころ ${row.source} の ${row.external_id} は、もう予定 ${ctx.pairTakenBy} に付いています`);
  const startOk = isValidDateTime(row.starts_at);
  const endOk = isValidDateTime(row.ends_at);
  const form = 'は時差つきの ISO 日時(例 2026-11-01T09:00:00+09:00)で書きます';
  if (!startOk) p.push(isBlank(row.starts_at) ? '予定には始まり(starts_at)が要ります' : `始まり(starts_at)${form}`);
  if (!endOk) p.push(isBlank(row.ends_at) ? '予定には終わり(ends_at)が要ります' : `終わり(ends_at)${form}`);
  if (startOk && endOk) {
    const ms = Date.parse(row.ends_at) - Date.parse(row.starts_at);
    if (ms <= 0) p.push('終わり(ends_at)は始まり(starts_at)より後にします');
    else if (ms > BOOKING_MAX_MS) p.push('1つの予定の長さは24時間までです。長いものは日ごとに分けます');
  }
  return p;
}

// A report as it is about to be stored: body has its line ends as \n already.
export function checkReport(row) {
  const p = [];
  if (!REPORT_KINDS.includes(row.kind)) p.push(`報告の種類(kind)は ${REPORT_KINDS.join(', ')} のどれかです`);
  if (typeof row.title !== 'string' || row.title.trim() === '') p.push('報告には題名(title)が要ります');
  else if (/[\r\n]/.test(row.title)) p.push('題名(title)は1行で書きます');
  else if (charLength(row.title) > REPORT_TITLE_MAX) p.push(`題名(title)は ${REPORT_TITLE_MAX} 文字までです`);
  if (typeof row.body !== 'string' || row.body.trim() === '') p.push('報告には本文(body)が要ります');
  else if (charLength(row.body) > REPORT_BODY_MAX) p.push(`本文(body)は ${REPORT_BODY_MAX} 文字までです。長いものは分けます`);
  // eslint-disable-next-line no-control-regex
  else if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(row.body)) p.push('本文(body)には、改行とタブのほかの制御文字を入れられません');
  return p;
}

// A message as it is about to be stored: body has its line ends as \n already. The person's
// messages are at most MESSAGE_MAX characters; the others at most REPORT_BODY_MAX.
export function checkMessage(row) {
  const p = [];
  if (!MESSAGE_ROLES.includes(row.role)) p.push(`だれのメッセージか(role)は ${MESSAGE_ROLES.join(', ')} のどれかです`);
  const max = row.role === 'user' ? MESSAGE_MAX : REPORT_BODY_MAX;
  if (typeof row.body !== 'string' || row.body.trim() === '') p.push('本文(body)が要ります');
  else if (charLength(row.body) > max) p.push(`本文(body)は ${max} 文字までです`);
  // eslint-disable-next-line no-control-regex
  else if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(row.body)) p.push('本文(body)には、改行とタブのほかの制御文字を入れられません');
  return p;
}

// A proposal: a message of the secretary with an autonomy kind and a one-line title.
export function checkProposal(row) {
  const p = checkMessage(row);
  if (!AUTONOMY_KINDS.some((k) => k.kind === row.autonomy_kind)) {
    p.push(`案の種類(kind)は ${AUTONOMY_KINDS.map((k) => k.kind).join(', ')} のどれかです(原則13)`);
  }
  if (typeof row.title !== 'string' || row.title.trim() === '') p.push('案には題名(title)が要ります');
  else if (/[\r\n]/.test(row.title)) p.push('題名(title)は1行で書きます');
  else if (charLength(row.title) > REPORT_TITLE_MAX) p.push(`題名(title)は ${REPORT_TITLE_MAX} 文字までです`);
  return p;
}

export function checkPlace(row) {
  const p = [];
  if (isBlank(row.name)) p.push('作業フォルダには名前が要ります');
  if (!isText(row.profile)) p.push('profile は文字列です');
  const devices = new Set();
  for (const item of row.paths ?? []) {
    if (isBlank(item?.device) || isBlank(item?.path) || typeof item.device !== 'string' || typeof item.path !== 'string') {
      p.push('作業フォルダのパスには、デバイス(device)とパス(path)の両方が文字列で要ります');
    } else if (devices.has(item.device)) {
      p.push(`デバイス ${item.device} のパスが2つあります。1つのデバイスにパスは1つです`);
    } else {
      devices.add(item.device);
    }
  }
  return p;
}

export function checkAutonomy(row) {
  const p = [];
  if (isBlank(row.kind)) p.push('自律度には、動きの種類(kind)が要ります');
  else if (!AUTONOMY_KINDS.some((k) => k.kind === row.kind)) {
    p.push(`${row.kind} という動きの種類はありません。種類は ${AUTONOMY_KINDS.map((k) => k.kind).join(', ')} です(原則13)`);
  }
  if (!AUTONOMY_LEVELS.includes(row.level)) p.push(`自律度は ${AUTONOMY_LEVELS.join(', ')} のどちらかです(原則13)`);
  if (!isNonNegInt(row.approvals_in_row)) p.push('approvals_in_row は0以上の整数です');
  if (!isNonNegInt(row.revokes)) p.push('revokes は0以上の整数です');
  return p;
}

// Problems with the extra fields passed to setState: only the target state's fields are allowed.
export function checkStateExtra(state, extra = {}) {
  const allowed = STATE_FIELDS[state] ?? [];
  return Object.keys(extra)
    .filter((k) => !allowed.includes(k))
    .map((k) => `${k} は状態 ${state} では使いません`);
}

// The row after moving to `state`. Fields of other states are cleared (原則5: 破棄は元に戻せる,
// and a reopened task carries no stale reason). closed_at is set on done/discarded, else cleared.
export function applyState(row, state, extra, nowIso) {
  const next = { ...row, state };
  const keep = STATE_FIELDS[state] ?? [];
  for (const f of ALL_STATE_FIELDS) {
    if (!keep.includes(f)) next[f] = null;
    else if (extra[f] !== undefined) next[f] = extra[f];
    else if (row.state !== state) next[f] = null;
  }
  if (CLOSED_STATES.includes(state)) {
    next.closed_at = row.state === state && row.closed_at ? row.closed_at : nowIso;
  } else {
    next.closed_at = null;
  }
  return next;
}
