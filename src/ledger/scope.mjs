// What a device with a scope (a guest, such as an AI that runs in someone else's cloud) may see
// and write, kept as JSON on its row in devices (devices.scope). A device without a scope is an
// agent or the secretary and works as before.
//
// { profiles, hide, write }:
// - profiles: the profiles it may see, or null for all. Goals, tasks and bookings with no
//   profile are always seen.
// - hide: { <profile>: [what] }, what of that profile it may not see:
//   people (the people and their memos), knowledge (knowledge.md, knowledge/, procedures/, the
//   inbox) and details (of goals and tasks only the title, due date, state and goal are shown;
//   body, next, result, done_when, outcome, records, holds and links are not).
//   It also may not write notes to a profile with anything hidden.
// - write: the write tools it may call, out of WRITE_TOOLS. Every other write tool is left out.

export const HIDE_ITEMS = ['people', 'knowledge', 'details'];
export const WRITE_TOOLS = ['note', 'ask_secretary'];
export const GUEST_WRITE = ['note', 'ask_secretary'];

const isList = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim() !== '');

// The scope in its stored form, or { problems } when it cannot be one.
export function normalizeScope(input) {
  const problems = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { problems: ['範囲は { profiles, hide, write } の形です'] };
  const unknown = Object.keys(input).filter((k) => !['profiles', 'hide', 'write'].includes(k));
  if (unknown.length) problems.push(`範囲に知らない項目があります: ${unknown.join(', ')}`);
  let profiles = null;
  if (input.profiles !== undefined && input.profiles !== null) {
    if (!isList(input.profiles)) problems.push('profiles はプロフィールの名前の一覧です');
    else profiles = [...new Set(input.profiles.map((s) => s.trim()))];
  }
  const hide = {};
  if (input.hide !== undefined && input.hide !== null) {
    if (typeof input.hide !== 'object' || Array.isArray(input.hide)) problems.push('hide は { プロフィール: [people, knowledge, details] } の形です');
    else {
      for (const [p, items] of Object.entries(input.hide)) {
        if (!isList(items) || items.length === 0) {
          problems.push(`hide の ${p} には、伏せるもの(${HIDE_ITEMS.join(', ')})を1つ以上書きます`);
          continue;
        }
        const bad = items.filter((i) => !HIDE_ITEMS.includes(i));
        if (bad.length) problems.push(`hide の ${p} に知らないものがあります: ${bad.join(', ')}(使えるのは ${HIDE_ITEMS.join(', ')})`);
        hide[p.trim()] = HIDE_ITEMS.filter((i) => items.includes(i));
      }
    }
  }
  let write = [...GUEST_WRITE];
  if (input.write !== undefined && input.write !== null) {
    if (!Array.isArray(input.write) || !input.write.every((s) => typeof s === 'string')) problems.push('write は書き込みのツールの名前の一覧です');
    else {
      const bad = input.write.filter((w) => !WRITE_TOOLS.includes(w));
      if (bad.length) problems.push(`範囲つきの鍵に許せる書き込みは ${WRITE_TOOLS.join(', ')} だけです(${bad.join(', ')} は許せません)`);
      write = WRITE_TOOLS.filter((w) => input.write.includes(w));
    }
  }
  if (problems.length) return { problems };
  return { scope: { profiles, hide, write } };
}

// The stored text read back, or null for a device with no scope.
export function parseScope(text) {
  if (text === null || text === undefined) return null;
  try {
    const out = normalizeScope(JSON.parse(text));
    // A stored scope that no longer reads hides everything, rather than nothing.
    return out.scope ?? { profiles: [], hide: {}, write: [] };
  } catch {
    return { profiles: [], hide: {}, write: [] };
  }
}

// Whether the scope lets the profile be seen at all (a null profile always is).
export const seesProfile = (scope, profile) => !scope.profiles || profile === null || profile === undefined || scope.profiles.includes(profile);

// Whether `what` of the profile is hidden (also true when the profile is not seen at all).
export const hides = (scope, profile, what) =>
  !seesProfile(scope, profile) || Boolean(profile && (scope.hide[profile] ?? []).includes(what));
