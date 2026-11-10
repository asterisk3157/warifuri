// 秘書の画面の「エージェント」の欄: 別の機械や会話で本人と作業している AI(エージェント)が
// 秘書に頼んだことと、その返事。本人との会話とは別のスレッドなので、ここにだけ出る。
// 依頼の結果で予定が変わったときは、本人との会話に1行のお知らせが出て、押すとここに来る。
// secretary.js から呼ぶ部品だけを置く(タブ、欄、お知らせの1行)。

import { h } from '../ui.js';
import { renderMarkdown } from '../md.js';

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (iso) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const mdhm = (iso) => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${hhmm(iso)}`;
};

const TABS = [['main', '会話'], ['agent', 'エージェント'], ['rules', '決めたこと']];

// The tabs over the secretary's screen. tab: 'main', 'agent' or 'rules'; select(tab).
export function agentTabs(tab, select) {
  return h('div', { class: 'wf-sec-tabs', role: 'tablist', 'aria-label': '秘書の画面' },
    ...TABS.map(([key, label]) => h('button', {
      type: 'button', role: 'tab', class: ['wf-sec-tab', tab === key && 'wf-on'], aria: { selected: String(tab === key) },
      onclick: () => key !== tab && select(key), text: label,
    })));
}

// The one line in the conversation that says an agent's request changed the calendar.
export function agentNotice(m, open) {
  return h('button', { type: 'button', class: 'wf-agent-notice', onclick: open, 'aria-label': `${m.body}。エージェントのタブを開く` },
    h('span', { text: m.body }), h('small', { text: `${hhmm(m.created_at)} · エージェントを開く` }));
}

// What the agent asked for: who, what and the conditions, folded to a few lines.
function requestCard(m, expanded, toggle) {
  const r = m.request;
  const conds = [
    r.minutes ? `${r.minutes}分` : null,
    r.by ? `${r.by.slice(5, 10).replace('-', '/')}まで` : null,
    r.prefer ? `希望: ${r.prefer}` : null,
    r.starts_at ? `${mdhm(r.starts_at)}〜${r.ends_at ? hhmm(r.ends_at) : ''}` : null,
  ].filter(Boolean);
  const open = expanded.has(m.id);
  return h('div', { class: 'wf-req' },
    h('div', { class: 'wf-req-head' }, h('b', { text: r.from ? `${r.from} のエージェントからの依頼` : 'エージェントからの依頼' }), h('small', { class: 'wf-time', text: mdhm(m.created_at) })),
    h('p', { class: ['wf-req-text', !open && 'wf-clamp'], text: r.text }),
    conds.length ? h('div', { class: 'wf-req-conds', text: conds.join(' · ') }) : null,
    r.text.length > 120 ? h('button', { type: 'button', class: 'wf-req-more', onclick: () => toggle(m.id), text: open ? '閉じる' : '全文を表示' }) : null);
}

// The secretary's reply to a request.
function replyBubble(m) {
  return h('div', { class: 'wf-m' },
    h('small', { class: 'wf-who', text: '秘書' }),
    h('div', { class: 'wf-bubble' }, h('div', { class: 'wf-md' }, ...renderMarkdown(h, m.body))),
    h('span', { class: 'wf-foot' }, h('small', { class: 'wf-time', text: hhmm(m.created_at) })));
}

// The pane: requests and replies, oldest first; data is /secretary/agent (or null while it loads).
export function agentPane(data, { expanded, toggle }) {
  const items = data?.items ?? [];
  const rows = items.map((m) => {
    if (m.role === 'system' && m.request) return requestCard(m, expanded, toggle);
    if (m.role === 'system') return h('p', { class: 'wf-note', text: m.body });
    if (m.role === 'secretary') return replyBubble(m);
    return null;
  });
  if (data?.secretary?.replying) {
    rows.push(h('div', { class: 'wf-m', role: 'status', 'aria-label': '秘書が考えています' },
      h('div', { class: 'wf-bubble' }, h('span', { class: 'wf-wait', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')))));
  }
  const list = h('div', { class: 'wf-list' }, rows.some(Boolean) || data?.secretary?.replying
    ? rows
    : h('p', { class: 'wf-empty-talk', text: data ? 'まだありません' : '読み込み中' }));
  return { el: h('div', { class: 'wf-scroll', data: { scroll: 'agent' } }, list), newest: items.at(-1)?.id ?? '' };
}
