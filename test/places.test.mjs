// Tests for places: comparing directory paths (src/ledger/paths.mjs, POSIX and Windows
// style alike), placeFor() choosing the deepest place, upsertPlace(), and board by place.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openLedger, LedgerError } from '../src/ledger/ledger.mjs';
import { pathStyle, comparablePath, isSameOrInside, deepestContaining } from '../src/ledger/paths.mjs';

const ACTOR = { actor: 'human' };

function fresh(t) {
  const L = openLedger(':memory:');
  t.after(() => L.close());
  return L;
}

test('paths: the style comes from the path, not from the OS running the tests', () => {
  assert.equal(pathStyle('C:\\Users\\alex'), path.win32);
  assert.equal(pathStyle('d:/work'), path.win32);
  assert.equal(pathStyle('\\\\server\\share\\x'), path.win32);
  assert.equal(pathStyle('/home/alex'), path.posix);
  assert.equal(comparablePath('relative/dir'), null);
  assert.equal(comparablePath('C:relative'), null);
  assert.equal(comparablePath('/home/alex/'), '/home/alex');
  assert.equal(comparablePath('/'), '/');
  assert.equal(comparablePath('C:\\Work\\Repo\\'), 'c:\\work\\repo');
});

test('paths: POSIX compares exactly, by whole segments', () => {
  assert.equal(isSameOrInside('/home/alex/repo', '/home/alex/repo'), true);
  assert.equal(isSameOrInside('/home/alex/repo', '/home/alex/repo/src/lib'), true);
  assert.equal(isSameOrInside('/home/alex/repo/', '/home/alex/repo/./src/../src'), true);
  assert.equal(isSameOrInside('/home/alex/repo', '/home/alex/repo2'), false);
  assert.equal(isSameOrInside('/home/alex/repo', '/home/alex'), false);
  assert.equal(isSameOrInside('/home/alex/repo', '/home/alex/repo/..'), false);
  assert.equal(isSameOrInside('/home/alex/repo', '/home/alex/repo/..data'), true); // a child named ..data
  assert.equal(isSameOrInside('/home/Alex/repo', '/home/alex/repo'), false);
  assert.equal(isSameOrInside('/', '/anything'), true);
});

test('paths: Windows compares without regard to case and accepts either slash', () => {
  assert.equal(isSameOrInside('C:\\Users\\Alex\\Repo', 'c:\\users\\alex\\repo\\src'), true);
  assert.equal(isSameOrInside('C:\\Users\\Alex\\Repo', 'C:/Users/Alex/Repo/src'), true);
  assert.equal(isSameOrInside('C:\\Users\\Alex\\Repo', 'C:\\Users\\Alex\\Repository'), false);
  assert.equal(isSameOrInside('C:\\Users\\Alex\\Repo', 'D:\\Users\\Alex\\Repo'), false);
  assert.equal(isSameOrInside('C:\\', 'c:\\anything'), true);
  assert.equal(isSameOrInside('\\\\server\\share\\team', '\\\\SERVER\\Share\\team\\x'), true);
  assert.equal(isSameOrInside('C:\\Repo', '/c/Repo'), false); // two styles never match
  const candidates = [{ path: 'C:\\Work' }, { path: 'C:\\Work\\Thesis' }, { path: 'C:\\Work\\Thesis\\Data' }];
  assert.equal(deepestContaining(candidates, 'c:\\work\\thesis\\chapter1').path, 'C:\\Work\\Thesis');
  assert.equal(deepestContaining(candidates, 'C:\\Other'), null);
});

test('placeFor: the deepest registered place on that device', (t) => {
  const L = fresh(t);
  const home = L.createPlace({ name: 'home', profile: 'private', paths: [{ device: 'laptop', path: '/home/alex' }] }, ACTOR);
  const repo = L.createPlace(
    {
      name: 'thesis',
      profile: 'research',
      paths: [
        { device: 'laptop', path: '/home/alex/thesis' },
        { device: 'desktop', path: 'D:\\Work\\Thesis' },
      ],
    },
    ACTOR,
  );
  const data = L.createPlace({ name: 'data', profile: 'research', paths: [{ device: 'laptop', path: '/home/alex/thesis/data' }] }, ACTOR);

  assert.equal(L.placeFor('laptop', '/home/alex/thesis').id, repo.id);
  assert.equal(L.placeFor('laptop', '/home/alex/thesis/chapter1').id, repo.id);
  assert.equal(L.placeFor('laptop', '/home/alex/thesis/data/raw').id, data.id);
  assert.equal(L.placeFor('laptop', '/home/alex/music').id, home.id);
  assert.equal(L.placeFor('laptop', '/tmp'), null);
  assert.equal(L.placeFor('laptop', 'thesis'), null); // relative paths name nothing
  // Each device has its own paths.
  assert.equal(L.placeFor('desktop', 'd:\\work\\thesis\\figures').id, repo.id);
  assert.equal(L.placeFor('desktop', '/home/alex/thesis'), null);
  assert.equal(L.placeFor('phone', '/home/alex/thesis'), null);
  assert.deepEqual(L.placeFor('laptop', '/home/alex/thesis').paths.map((p) => p.device), ['desktop', 'laptop']);
});

test('upsertPlace: creates, then changes name, profile and paths per device', (t) => {
  const L = fresh(t);
  const created = L.upsertPlace({ name: 'repo', profile: 'hobby', paths: [{ device: 'laptop', path: '/home/alex/repo' }] }, ACTOR);
  const id = created.id;
  const withDesk = L.upsertPlace({ id, paths: [{ device: 'desk', path: 'C:\\src\\repo' }] }, ACTOR);
  assert.deepEqual(withDesk.paths, [
    { device: 'desk', path: 'C:\\src\\repo' },
    { device: 'laptop', path: '/home/alex/repo' },
  ]);
  const renamed = L.upsertPlace({ id, name: 'side project', profile: 'private', paths: [{ device: 'laptop', path: null }] }, ACTOR);
  assert.equal(renamed.name, 'side project');
  assert.equal(renamed.profile, 'private');
  assert.deepEqual(renamed.paths.map((p) => p.device), ['desk']);
  const recs = L.records(id);
  assert.deepEqual(recs.map((r) => r.action), ['create', 'update', 'update']);
  assert.deepEqual(recs[2].changes.paths.after, [{ device: 'desk', path: 'C:\\src\\repo' }]);
  // Nothing changed: no record.
  L.upsertPlace({ id, name: 'side project' }, ACTOR);
  assert.equal(L.records(id).length, 3);

  assert.throws(() => L.upsertPlace({ id, name: '' }, ACTOR), LedgerError);
  assert.throws(() => L.upsertPlace({ id, paths: [{ device: 'desk', path: 'C:\\a' }, { device: 'desk', path: null }] }, ACTOR), /2つ/);
  assert.throws(() => L.upsertPlace({ id, paths: [{ device: 'desk' }] }, ACTOR), /両方/);
  assert.throws(() => L.updatePlace('p_20261024000000_nplace', { name: 'x' }, ACTOR), /ありません/);
  // Another place may not take the same directory on the same device (case folded on Windows).
  assert.throws(() => L.upsertPlace({ name: 'clash', paths: [{ device: 'desk', path: 'c:\\SRC\\repo\\' }] }, ACTOR), /もう作業フォルダ/);
  // A new id that is free creates the place with it.
  assert.equal(L.upsertPlace({ id: 'p_20261024000000_given1', name: 'given' }, ACTOR).id, 'p_20261024000000_given1');
});

test('board by place: the directory and the device give the profile', (t) => {
  const L = fresh(t);
  const research = L.createPlace({ name: 'thesis', profile: 'research', paths: [{ device: 'laptop', path: '/home/alex/thesis' }] }, ACTOR);
  const club = L.createPlace({ name: 'club', profile: 'club', paths: [{ device: 'laptop', path: '/home/alex/club' }] }, ACTOR);
  const g = L.createGoal({ title: 'Thesis', mode: 'ai_worker', profile: 'research' }, ACTOR);
  const c = L.createGoal({ title: 'Camp', mode: 'ai_worker', profile: 'club' }, ACTOR);
  L.createTask({ title: 'Refs', mode: 'ai_worker', goal_id: g.id }, ACTOR);
  const looseR = L.createTask({ title: 'Loose research', mode: 'ai_worker', place_id: research.id }, ACTOR);
  L.createTask({ title: 'Loose club', mode: 'ai_worker', place_id: club.id }, ACTOR);

  const here = L.board({ dir: '/home/alex/thesis/src', device: 'laptop' });
  assert.deepEqual(here.goals.map((x) => x.id), [g.id]);
  assert.deepEqual(here.unassigned.map((x) => x.id), [looseR.id]);
  assert.deepEqual(here.scope, { profile: 'research', place: { id: research.id, name: 'thesis', profile: 'research' } });

  // An explicit profile wins over the place's.
  assert.deepEqual(L.board({ dir: '/home/alex/thesis', device: 'laptop', profile: 'club' }).goals.map((x) => x.id), [c.id]);
  // An unregistered directory, or none at all, shows everything.
  const nowhere = L.board({ dir: '/tmp', device: 'laptop' });
  assert.equal(nowhere.goals.length, 2);
  assert.deepEqual(nowhere.scope, { profile: null, place: null });
  assert.equal(L.board().unassigned.length, 2);
});
