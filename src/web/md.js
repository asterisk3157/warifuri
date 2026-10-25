// A small Markdown reader for the secretary's replies: headings, paragraphs, lists (one level),
// bold, inline code, code blocks and links. parseMarkdown gives plain data; renderMarkdown
// builds DOM nodes from it with h() (ui.js), so every piece of the text goes in as a text node
// and no markup from the reply is ever parsed by the browser. Links go only to http, https
// and mailto addresses, open in a new tab and carry no referrer.

const SAFE_URL = /^(https?:\/\/|mailto:)[^\s<>"']+$/i;

// Inline pieces: { t: 'text', v } | { t: 'b', c: [...] } | { t: 'code', v } | { t: 'a', href, c: [...] }.
export function parseInline(text) {
  const out = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let m;
    if (rest[0] === '`' && (m = /^`([^`\n]+)`/.exec(rest))) {
      flush();
      out.push({ t: 'code', v: m[1] });
      i += m[0].length;
    } else if (rest.startsWith('**') && (m = /^\*\*([^*\n](?:[^\n]*?[^*\n])?)\*\*/.exec(rest))) {
      flush();
      out.push({ t: 'b', c: parseInline(m[1]) });
      i += m[0].length;
    } else if (rest[0] === '[' && (m = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest))) {
      flush();
      if (SAFE_URL.test(m[2])) out.push({ t: 'a', href: m[2], c: parseInline(m[1]) });
      else out.push({ t: 'text', v: m[1] });
      i += m[0].length;
    } else if (/^https?:\/\//i.test(rest) && (m = /^https?:\/\/[^\s<>"'`）」』、。]+/i.exec(rest)) && (i === 0 || !/[\w/]/.test(text[i - 1]))) {
      flush();
      const url = m[0].replace(/[.,;:!?)]+$/, '');
      out.push({ t: 'a', href: url, c: [{ t: 'text', v: url }] });
      i += url.length;
    } else {
      buf += text[i];
      i += 1;
    }
  }
  flush();
  return out;
}

// Blocks: { t: 'h', level, c } | { t: 'p', lines: [[inline]] } | { t: 'ul' | 'ol', items: [[inline]], start }
// | { t: 'pre', v }.
export function parseMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = null;
  let list = null;
  const end = () => {
    para = null;
    list = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    let m;
    if ((m = /^\s*(```|~~~)/.exec(line))) {
      end();
      const fence = m[1];
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ t: 'pre', v: body.join('\n') });
      continue;
    }
    if (line.trim() === '') {
      end();
      continue;
    }
    if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
      end();
      blocks.push({ t: 'h', level: Math.min(m[1].length, 4), c: parseInline(m[2]) });
      continue;
    }
    if ((m = /^\s*[-*+・]\s+(.*)$/.exec(line))) {
      if (!list || list.t !== 'ul') {
        para = null;
        list = { t: 'ul', items: [] };
        blocks.push(list);
      }
      list.items.push(parseInline(m[1]));
      continue;
    }
    if ((m = /^\s*(\d{1,3})[.)]\s+(.*)$/.exec(line))) {
      if (!list || list.t !== 'ol') {
        para = null;
        list = { t: 'ol', items: [], start: Number(m[1]) };
        blocks.push(list);
      }
      list.items.push(parseInline(m[2]));
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      // A line that hangs under a list item goes on with it.
      list.items[list.items.length - 1].push({ t: 'text', v: ' ' }, ...parseInline(line.trim()));
      continue;
    }
    list = null;
    const inline = parseInline(line.replace(/^>\s?/, ''));
    if (!para) {
      para = { t: 'p', lines: [] };
      blocks.push(para);
    }
    para.lines.push(inline);
  }
  return blocks;
}

function inlineNodes(h, pieces) {
  return pieces.map((p) => {
    if (p.t === 'text') return p.v;
    if (p.t === 'code') return h('code', { text: p.v });
    if (p.t === 'b') return h('b', {}, ...inlineNodes(h, p.c));
    return h('a', { href: p.href, target: '_blank', rel: 'noopener noreferrer' }, ...inlineNodes(h, p.c));
  });
}

// DOM nodes of a reply, built with h(tag, attrs, ...children).
export function renderMarkdown(h, text) {
  return parseMarkdown(text).map((b) => {
    if (b.t === 'h') return h(`h${b.level + 2 > 6 ? 6 : b.level + 2}`, { class: 'wf-md-h' }, ...inlineNodes(h, b.c));
    if (b.t === 'pre') return h('pre', {}, h('code', { text: b.v }));
    if (b.t === 'ul' || b.t === 'ol') {
      return h(b.t, { start: b.t === 'ol' && b.start !== 1 ? b.start : undefined }, ...b.items.map((it) => h('li', {}, ...inlineNodes(h, it))));
    }
    const kids = [];
    b.lines.forEach((l, i) => {
      if (i) kids.push(h('br'));
      kids.push(...inlineNodes(h, l));
    });
    return h('p', {}, ...kids);
  });
}
