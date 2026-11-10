// GitHub の写し: the pull requests and issues of the owners the person chose to take in, one row
// each, as GitHub's webhook last told them (src/server/github.mjs). GitHub is the original:
// warifuri keeps a copy to read, never writes to GitHub, and does not record these rows as the
// person's writes.
//
// Which owners are taken in is the github section of the settings (settings.mjs). An event of
// an owner that is not read is dropped before it is stored, and rows kept from a time an
// owner was read are not shown once it no longer is.
//
// A task is tied to an item only when its text names it: owner/repo#number, or the item's
// URL (github.com/owner/repo/pull/N or /issues/N), in the title, body, result or next.
// Nothing is guessed from a branch name or a similar title.
//
// `ctx` is what openLedger shares with this module: the database's helpers and the clock.

import { readSettings, githubReads, GITHUB_OWNER } from './settings.mjs';
import { CLOSED_STATES } from './rules.mjs';

export const GITHUB_KINDS = ['pr', 'issue'];
export const GITHUB_STATES = ['open', 'closed', 'merged'];
export const GITHUB_LIST_DEFAULT = 30;
export const GITHUB_LIST_MAX = 100;
export const GITHUB_TITLE_MAX = 300;
const NAMES_MAX = 20;

const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
const COLUMNS = [
  'key', 'owner', 'repo', 'number', 'kind', 'title', 'state', 'draft', 'url', 'branch', 'author',
  'assignees', 'reviewers', 'updated_at', 'closed_at', 'received_at',
];

export const itemKey = (owner, repo, number) => `${owner}/${repo}#${number}`.toLowerCase();

const URL_REF = /github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(?:pull|issues)\/(\d+)(?!\d)/gi;
const SHORT_REF = /(?<![A-Za-z0-9_.\/-])([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)#(\d+)(?!\d)/g;

// The keys of the items a text names, each once.
export function refsIn(text) {
  const out = new Set();
  if (typeof text !== 'string' || text === '') return [];
  for (const re of [URL_REF, SHORT_REF]) {
    for (const m of text.matchAll(re)) out.add(itemKey(m[1], m[2], m[3]));
  }
  return [...out];
}

const isoOrNull = (v) => {
  const ms = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};
const login = (u) => (typeof u?.login === 'string' && LOGIN.test(u.login) ? u.login : null);
const logins = (list) => (Array.isArray(list) ? [...new Set(list.map(login).filter(Boolean))].slice(0, NAMES_MAX) : []);
// eslint-disable-next-line no-control-regex
const oneLine = (s) => [...String(s).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim()].slice(0, GITHUB_TITLE_MAX).join('');

// The item a webhook's payload carries, or null when it is not one warifuri can keep.
// event: 'pull_request' or 'issues'.
export function itemFromPayload(event, payload) {
  const kind = event === 'pull_request' ? 'pr' : event === 'issues' ? 'issue' : null;
  const x = kind === 'pr' ? payload?.pull_request : kind === 'issue' ? payload?.issue : null;
  const owner = payload?.repository?.owner?.login;
  const repo = payload?.repository?.name;
  if (!x || typeof owner !== 'string' || !GITHUB_OWNER.test(owner) || typeof repo !== 'string' || !REPO.test(repo)) return null;
  if (!Number.isInteger(x.number) || x.number <= 0 || typeof x.title !== 'string') return null;
  const merged = kind === 'pr' && (x.merged === true || typeof x.merged_at === 'string');
  const state = merged ? 'merged' : x.state === 'closed' ? 'closed' : x.state === 'open' ? 'open' : null;
  const updatedAt = isoOrNull(x.updated_at);
  if (state === null || updatedAt === null) return null;
  const page = `https://github.com/${owner}/${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${x.number}`;
  const url = typeof x.html_url === 'string' && /^https:\/\/[^\s]{1,400}$/.test(x.html_url) ? x.html_url : page;
  const branch = kind === 'pr' && typeof x.head?.ref === 'string' && x.head.ref.length <= 255 ? oneLine(x.head.ref) : null;
  return {
    key: itemKey(owner, repo, x.number), owner, repo, number: x.number, kind, title: oneLine(x.title) || '(no title)', state,
    draft: x.draft === true ? 1 : 0, url, branch, author: login(x.user),
    assignees: logins(x.assignees), reviewers: kind === 'pr' ? logins(x.requested_reviewers) : [],
    updated_at: updatedAt, closed_at: state === 'open' ? null : isoOrNull(merged ? x.merged_at : x.closed_at),
  };
}

export function githubStore({ db, one, all, transaction, now, LedgerError }) {
  const view = (r) => ({
    owner: r.owner, repo: r.repo, number: r.number, kind: r.kind, title: r.title, state: r.state, draft: r.draft === 1,
    url: r.url, branch: r.branch, author: r.author, assignees: JSON.parse(r.assignees), reviewers: JSON.parse(r.reviewers),
    updated_at: r.updated_at, closed_at: r.closed_at,
  });

  // Keeps an item (itemFromPayload) as GitHub last told it. An event older than the row kept
  // changes nothing (deliveries can come out of order). Returns whether it was written.
  function put(item) {
    return transaction(() => {
      const before = one('SELECT updated_at FROM github_items WHERE key = ?', item.key);
      if (before && before.updated_at > item.updated_at) return false;
      const row = { ...item, assignees: JSON.stringify(item.assignees), reviewers: JSON.stringify(item.reviewers), received_at: now().toISOString() };
      db.prepare(
        `INSERT INTO github_items (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')}) ` +
          `ON CONFLICT(key) DO UPDATE SET ${COLUMNS.filter((c) => c !== 'key').map((c) => `${c} = excluded.${c}`).join(', ')}`,
      ).run(...COLUMNS.map((c) => row[c]));
      return true;
    });
  }

  // Drops the copy of an item GitHub says is gone (deleted, or moved to another repository).
  function remove(key) {
    return db.prepare('DELETE FROM github_items WHERE key = ?').run(key).changes > 0;
  }

  const get = (key) => {
    const r = one('SELECT * FROM github_items WHERE key = ?', key);
    return r ? view(r) : null;
  };

  // The tasks whose text names an item, by the item's key: Map(key → [task]). openOnly: only
  // the tasks that are not closed.
  function namedBy({ openOnly = false } = {}) {
    const rows = all(
      'SELECT t.id, t.title, t.body, t.result, t.next, t.state, t.goal_id, ' +
        'CASE WHEN t.goal_id IS NOT NULL THEN g.profile ELSE p.profile END AS profile ' +
        'FROM tasks t LEFT JOIN goals g ON g.id = t.goal_id LEFT JOIN places p ON p.id = t.place_id ' +
        "WHERE (instr(coalesce(t.title, '') || coalesce(t.body, '') || coalesce(t.result, '') || coalesce(t.next, ''), '#') > 0 " +
        "OR instr(lower(coalesce(t.title, '') || coalesce(t.body, '') || coalesce(t.result, '') || coalesce(t.next, '')), 'github.com/') > 0)" +
        (openOnly ? ` AND t.state NOT IN (${CLOSED_STATES.map((s) => `'${s}'`).join(', ')})` : '') +
        ' ORDER BY t.created_at, t.id',
    );
    const out = new Map();
    for (const t of rows) {
      const task = { id: t.id, title: t.title, state: t.state, goal_id: t.goal_id, profile: t.profile };
      for (const key of refsIn([t.title, t.body, t.result, t.next].filter(Boolean).join('\n'))) {
        if (!out.has(key)) out.set(key, []);
        out.get(key).push(task);
      }
    }
    return out;
  }

  // The items kept, newest change first, each with the tasks that name it. reads: (owner) →
  // whether that owner is shown. owner, repo, kind and state filter; involves: a GitHub login
  // that is the author, an assignee or asked to review. Returns { items, more }.
  function list({ owner, repo, kind, state, involves, limit = GITHUB_LIST_DEFAULT } = {}, reads = () => true) {
    const problems = [];
    const text = (v, name) => {
      if (v !== undefined && (typeof v !== 'string' || v.trim() === '')) problems.push(`${name} は文字列です`);
    };
    text(owner, 'owner');
    text(repo, 'repo');
    text(involves, 'involves');
    if (kind !== undefined && !GITHUB_KINDS.includes(kind)) problems.push(`kind は ${GITHUB_KINDS.join('、')} のどれかです`);
    if (state !== undefined && !GITHUB_STATES.includes(state)) problems.push(`state は ${GITHUB_STATES.join('、')} のどれかです`);
    if (!Number.isInteger(limit) || limit < 1 || limit > GITHUB_LIST_MAX) problems.push(`limit は 1 から ${GITHUB_LIST_MAX} までの整数です`);
    if (problems.length) throw new LedgerError(problems);
    const where = [];
    const args = [];
    for (const [col, v] of [['lower(owner)', owner?.trim().toLowerCase()], ['lower(repo)', repo?.trim().toLowerCase()], ['kind', kind], ['state', state]]) {
      if (v === undefined) continue;
      where.push(`${col} = ?`);
      args.push(v);
    }
    const who = involves?.trim().toLowerCase();
    const rows = all(`SELECT * FROM github_items${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC, key`, ...args)
      .filter((r) => reads(r.owner))
      .map(view)
      .filter((i) => who === undefined || [i.author, ...i.assignees, ...i.reviewers].some((n) => n?.toLowerCase() === who));
    const tasks = namedBy();
    return {
      items: rows.slice(0, limit).map((i) => ({ ...i, tasks: tasks.get(itemKey(i.owner, i.repo, i.number)) ?? [] })),
      more: Math.max(0, rows.length - limit),
    };
  }

  // The open tasks that name a pull request that has been merged: likely done and not closed.
  // One row per task and pull request, with the reason in words.
  function mergedOpen(reads = () => true) {
    const out = [];
    for (const [key, tasks] of namedBy({ openOnly: true })) {
      const item = get(key);
      if (!item || item.kind !== 'pr' || item.state !== 'merged' || !reads(item.owner)) continue;
      const pr = `${item.owner}/${item.repo}#${item.number}`;
      const day = item.closed_at ? `${item.closed_at.slice(0, 10)} に` : '';
      for (const t of tasks) out.push({ ...t, pr, url: item.url, merged_at: item.closed_at, reason: `タスクに書かれた PR ${pr} が、${day}マージされています` });
    }
    return out.sort((a, b) => ((a.merged_at ?? '') < (b.merged_at ?? '') ? 1 : (a.merged_at ?? '') > (b.merged_at ?? '') ? -1 : a.id < b.id ? -1 : 1));
  }

  return { put, remove, get, list, mergedOpen };
}

// What is taken in right now: (owner) → whether its events are stored and its items shown.
export function githubPolicy(ledger) {
  const { github } = readSettings(ledger);
  return { settings: github, reads: (owner) => githubReads(github, owner) };
}

// One webhook event, after its signature was checked. Returns 'stored', 'removed', 'skipped'
// (the owner is not read), or 'ignored' (not an event or a payload warifuri keeps).
export function takeGithubEvent(ledger, event, payload) {
  if (event !== 'pull_request' && event !== 'issues') return 'ignored';
  const item = itemFromPayload(event, payload);
  if (!item) return 'ignored';
  if (!githubPolicy(ledger).reads(item.owner)) return 'skipped';
  if (event === 'issues' && (payload.action === 'deleted' || payload.action === 'transferred')) {
    ledger.github.remove(item.key);
    return 'removed';
  }
  return ledger.github.put(item) ? 'stored' : 'ignored';
}

// The items the caller may read, and the open tasks whose pull request was merged.
export const githubItems = (ledger, filter) => ledger.github.list(filter, githubPolicy(ledger).reads);
export const githubMergedOpen = (ledger) => ledger.github.mergedOpen(githubPolicy(ledger).reads);
