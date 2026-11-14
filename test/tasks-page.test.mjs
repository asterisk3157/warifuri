// The タスク screen's helper that cuts a long あるべき姿 to its first sentence.

import test from 'node:test';
import assert from 'node:assert/strict';
import { lead } from '../src/web/pages/tasks.js';

test('lead: the first sentence, up to a line break, at most 80 characters, and the rest', () => {
  assert.deepEqual(lead('予稿を出している。経緯: 打ち合わせで決めた。'), { head: '予稿を出している。', rest: '経緯: 打ち合わせで決めた。' });
  assert.deepEqual(lead('一行目\n\n二行目。'), { head: '一行目', rest: '二行目。' });
  assert.deepEqual(lead('短い'), { head: '短い', rest: '' });
  const long = 'あ'.repeat(100);
  assert.deepEqual(lead(long), { head: `${'あ'.repeat(80)}…`, rest: 'あ'.repeat(20) });
  assert.deepEqual(lead(null), { head: '', rest: '' });
});
