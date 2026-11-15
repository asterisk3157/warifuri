// Tests for the birthday watch (src/secretary/birthdays.mjs): friends' birthdays told some days
// before, once, with what they like, what they do not and the presents before.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLedger } from '../src/ledger/ledger.mjs';
import { noticeOf } from '../src/notify/notifier.mjs';
import { createBirthdayWatch, pickItems, birthdayNote, parseProfiles, nextBirthday } from '../src/secretary/birthdays.mjs';

const W = { actor: 'web' };
const NIGHT = { start: 23 * 60, end: 7 * 60 };
const FRIEND = { profile: '友人' };

function dir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-birthdays-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function world(t, more = {}) {
  const ledger = openLedger(':memory:');
  t.after(() => ledger.close());
  let clock = new Date(2026, 8, 1, 12);
  const told = [];
  const file = path.join(dir(t), 'birthdays.json');
  const make = (opts = {}) => createBirthdayWatch({ ledger, file, night: NIGHT, now: () => clock, tell: (body, data) => (told.push({ body, data }), { body, data }), ...more, ...opts });
  return { ledger, told, file, make, set: (d) => { clock = d; } };
}

test('told 14 days before, once; a restart does not tell it again', (t) => {
  const w = world(t);
  w.ledger.people.create({ name: '山田花子', birthday: '09-19', items: { 好きなもの: '紅茶' } }, FRIEND, W);
  const watch = w.make();
  w.set(new Date(2026, 8, 4, 12));
  assert.equal(watch.check(), null, '15 days before: nothing');
  w.set(new Date(2026, 8, 5, 12));
  assert.ok(watch.check());
  assert.equal(w.told.length, 1);
  assert.equal(w.told[0].body, '山田花子さんの誕生日が 9/19(土)で、あと14日です。好きなもの: 紅茶');
  assert.deepEqual(w.told[0].data.birthday.map((x) => x.on), ['2026-09-19']);
  w.set(new Date(2026, 8, 6, 12));
  assert.equal(watch.check(), null, 'not again the next day');
  assert.equal(w.make().check(), null, 'not again after a restart');
  assert.equal(w.told.length, 1);
});

test('only friends by default; other profiles when set, or all', (t) => {
  const w = world(t);
  w.ledger.people.create({ name: '佐藤一郎', birthday: '09-15' }, FRIEND, W);
  w.ledger.people.create({ name: '鈴木先生', birthday: '09-15' }, { profile: '研究' }, W);
  w.set(new Date(2026, 8, 1, 12));
  w.make().check();
  assert.equal(w.told.length, 1);
  assert.match(w.told[0].body, /佐藤一郎/);
  assert.doesNotMatch(w.told[0].body, /鈴木先生/);

  const all = world(t, { profiles: 'all' });
  all.ledger.people.create({ name: '佐藤一郎', birthday: '09-15' }, FRIEND, W);
  all.ledger.people.create({ name: '鈴木先生', birthday: '09-15', items: { 好きなもの: '珈琲' } }, { profile: '研究' }, W);
  all.make().check();
  assert.match(all.told[0].body, /鈴木先生さんの誕生日.*好きなもの: 珈琲/);
  assert.deepEqual([parseProfiles(undefined), parseProfiles('all'), parseProfiles('友人, 研究')], [['友人'], 'all', ['友人', '研究']]);
});

test('the columns picked by name, and the ones not there are not written', () => {
  assert.deepEqual(pickItems({ 好きな食べ物: 'フライドポテト', 好きなもの: '映画', 苦手な食べ物: '野菜全般', 誕プレ: '2025: マグカップ', 得意なこと: '料理' }), [
    { name: '好きなもの', value: 'フライドポテト、映画' },
    { name: '苦手なもの', value: '野菜全般' },
    { name: '前にあげた誕プレ', value: '2025: マグカップ' },
  ]);
  assert.deepEqual(pickItems({ 好物: '寿司', キライなもの: 'ピーマン', 誕生日プレゼント: '2024: 本' }).map((x) => x.name), ['好きなもの', '苦手なもの', '前にあげた誕プレ']);
  assert.deepEqual(pickItems({ 得意なこと: '料理' }), []);
  const on = new Date(2026, 8, 19);
  assert.equal(birthdayNote([{ person: { name: '山田花子', items: { 苦手なもの: '辛いもの' } }, on, in_days: 14, turns: null }]), '山田花子さんの誕生日が 9/19(土)で、あと14日です。苦手なもの: 辛いもの');
  assert.equal(birthdayNote([{ person: { name: '山田花子', items: {} }, on, in_days: 14, turns: null }]), '山田花子さんの誕生日が 9/19(土)で、あと14日です');
});

test('the age only with the year of birth', (t) => {
  const w = world(t);
  w.ledger.people.create({ name: '田村次郎', birthday: '2001-09-15', items: { 誕プレ: '2025: 手袋' } }, FRIEND, W);
  w.ledger.people.create({ name: '中野三郎', birthday: '09-15' }, FRIEND, W);
  w.make().check();
  assert.equal(w.told[0].body, [
    '中野三郎さんの誕生日が 9/15(火)で、あと14日です',
    '田村次郎さんの誕生日が 9/15(火)で、あと14日です。25歳になります。前にあげた誕プレ: 2025: 手袋',
  ].join('\n'));
  assert.equal(nextBirthday('2001-09-15', new Date(2026, 8, 1, 12)).turns, 25);
});

test('people on the same day go in one note', (t) => {
  const w = world(t);
  w.ledger.people.create({ name: '山田花子', birthday: '09-15' }, FRIEND, W);
  w.ledger.people.create({ name: '佐藤一郎', birthday: '09-15' }, FRIEND, W);
  w.make().check();
  assert.equal(w.told.length, 1);
  assert.equal(w.told[0].data.birthday.length, 2);
  assert.equal(w.told[0].body.split('\n').length, 2);
});

test('in the night it waits for the morning', (t) => {
  const w = world(t);
  w.ledger.people.create({ name: '山田花子', birthday: '09-16' }, FRIEND, W);
  const watch = w.make();
  w.set(new Date(2026, 8, 2, 23, 30));
  assert.equal(watch.check(), null);
  w.set(new Date(2026, 8, 3, 6, 50));
  assert.equal(watch.check(), null);
  w.set(new Date(2026, 8, 3, 7, 5));
  assert.ok(watch.check());
  assert.match(w.told[0].body, /あと13日です/);
});

test('0 days stops it', (t) => {
  const w = world(t, { days: 0 });
  w.ledger.people.create({ name: '山田花子', birthday: '09-15' }, FRIEND, W);
  for (const d of [new Date(2026, 8, 1, 12), new Date(2026, 8, 14, 12)]) {
    w.set(d);
    assert.equal(w.make().check(), null);
  }
  assert.equal(w.told.length, 0);
});

test('the note goes to Discord with no mention', () => {
  const n = noticeOf({ role: 'system', kind: 'text', body: '山田花子さんの誕生日が 9/15(火)で、あと14日です', data: { birthday: [{ person: 'p', on: '2026-09-15' }] } }, null);
  assert.deepEqual([n.text, n.mention], ['山田花子さんの誕生日が 9/15(火)で、あと14日です', false]);
});
