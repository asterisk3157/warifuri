// Tests for the Markdown reader of the secretary's replies (src/web/md.js): what it reads, and
// that nothing in a reply becomes markup or a link to anything but http, https or mailto.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, parseInline } from '../src/web/md.js';

test('markdown: headings, paragraphs, lists, bold, code, code blocks and links', () => {
  const blocks = parseMarkdown('## 今日\n今日は **v0.2 の残り** を`2時間`置けます。\n続きの行\n\n- 一つ目\n  続き\n- 二つ目\n3. 三\n4. 四\n\n```\nconst a = 1;\n```');
  assert.deepEqual(blocks.map((b) => b.t), ['h', 'p', 'ul', 'ol', 'pre']);
  assert.equal(blocks[0].level, 2);
  assert.deepEqual(blocks[1].lines[0], [
    { t: 'text', v: '今日は ' }, { t: 'b', c: [{ t: 'text', v: 'v0.2 の残り' }] }, { t: 'text', v: ' を' }, { t: 'code', v: '2時間' }, { t: 'text', v: '置けます。' },
  ]);
  assert.equal(blocks[1].lines.length, 2, 'a line break inside a paragraph is kept');
  assert.deepEqual(blocks[2].items[0], [{ t: 'text', v: '一つ目' }, { t: 'text', v: ' ' }, { t: 'text', v: '続き' }]);
  assert.equal(blocks[3].start, 3);
  assert.equal(blocks[4].v, 'const a = 1;');
});

test('markdown: markup stays text, and only safe links are links', () => {
  const [p] = parseMarkdown('<img src=x onerror=alert(1)> <script>x</script>');
  assert.deepEqual(p.lines[0], [{ t: 'text', v: '<img src=x onerror=alert(1)> <script>x</script>' }]);
  assert.deepEqual(parseInline('[押して](javascript:alert(1))').filter((x) => x.t === 'a'), []);
  assert.deepEqual(parseInline('[押して](data:text/html,x)'), [{ t: 'text', v: '押して' }]);
  assert.deepEqual(parseInline('[資料](https://example.com/a?b=1)'), [{ t: 'a', href: 'https://example.com/a?b=1', c: [{ t: 'text', v: '資料' }] }]);
  assert.deepEqual(parseInline('見て https://example.com/x。'), [{ t: 'text', v: '見て ' }, { t: 'a', href: 'https://example.com/x', c: [{ t: 'text', v: 'https://example.com/x' }] }, { t: 'text', v: '。' }]);
  assert.deepEqual(parseInline('[a](mailto:x@example.com)')[0].href, 'mailto:x@example.com');
});
