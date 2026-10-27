// ナレッジ: each profile's people, knowledge and inbox, and the files split out of them. It
// only shows: changes go through the agents (note), as everything else on these screens.

import { h, skel, profileChip } from '../ui.js';
import { renderMarkdown } from '../md.js';

const view = { profile: null, open: null, file: null };

async function load(api) {
  const list = await api('/knowledge');
  if (view.profile === null || !list.profiles.some((p) => p.name === view.profile)) {
    view.profile = (list.profiles.find((p) => p.people + p.knowledge + p.inbox + p.files > 0) ?? list.profiles[0])?.name ?? null;
  }
  const one = view.profile === null ? null : await api(`/knowledge/${encodeURIComponent(view.profile)}`);
  const file = one && view.open ? await api(`/knowledge/${encodeURIComponent(view.profile)}?name=${encodeURIComponent(view.open)}`).catch(() => null) : null;
  return { list, one, file };
}

const count = (p) => p.people + p.knowledge + p.inbox;

function profileButton(p, colors, ctx) {
  return h('button', {
    type: 'button', class: 'wf-goal-btn', 'aria-pressed': String(view.profile === p.name), data: { key: `profile-${p.name}` },
    onclick: () => { view.profile = p.name; view.open = null; ctx.refresh(); },
  },
  h('span', { class: 'wf-goal-top' }, profileChip(p.name, colors, 15)),
  h('span', { class: 'wf-goal-meta', text: count(p) || p.files ? `人 ${p.people} · ナレッジ ${p.knowledge} · 受信箱 ${p.inbox}${p.files ? ` · ファイル ${p.files}` : ''}` : 'まだありません' }));
}

// One file of the profile: its Markdown, or a line saying it is empty.
function section(title, about, file, empty) {
  return h('section', { class: 'wf-know-sec' },
    h('div', { class: 'wf-group-head' }, h('h2', { text: title }), h('span', { class: 'wf-muted', text: about })),
    file?.text?.trim()
      ? h('div', { class: 'wf-md wf-know-body' }, renderMarkdown(h, file.text), file.truncated ? h('p', { class: 'wf-muted', text: '長いので、ここで切りました' }) : null)
      : h('div', { class: 'wf-empty', text: empty }));
}

function filesSection(one, file, ctx) {
  const names = [...(one.files.knowledge ?? []), ...(one.files.procedures ?? [])];
  if (!names.length) return null;
  return h('section', { class: 'wf-know-sec' },
    h('div', { class: 'wf-group-head' }, h('h2', { text: '分けたナレッジと手順' }), h('span', { class: 'wf-group-count', text: `${names.length}件` })),
    ...names.map((n) => h('div', { class: 'wf-know-file' },
      h('button', { type: 'button', class: 'wf-know-name', 'aria-expanded': String(view.open === n), data: { key: `file-${n}` }, onclick: () => { view.open = view.open === n ? null : n; ctx.refresh(); }, text: n.replace(/^knowledge\//, 'ナレッジ / ').replace(/^procedures\//, '手順 / ') }),
      view.open === n && file?.text ? h('div', { class: 'wf-md wf-know-body' }, renderMarkdown(h, file.text)) : null)));
}

function render(data, ctx) {
  const { list, one, file } = data;
  const header = ctx.head('ナレッジ');
  if (!list.profiles.length) {
    return h('div', { class: 'wf-page-tasks' }, header, ctx.banner(),
      h('div', { class: 'wf-surface wf-big-empty', text: 'まだプロフィールがありません。エージェントに「〇〇と覚えておいて」と頼むと、ここに出ます' }));
  }
  const left = h('section', { class: 'wf-goals', 'aria-label': 'プロフィール', data: { scroll: 'profiles' } },
    h('h2', { text: 'プロフィール' }), ...list.profiles.map((p) => profileButton(p, list.colors, ctx)));
  const right = one
    ? [
      h('p', { class: 'wf-muted wf-know-note', text: 'エージェントと秘書が読む、この領域の人と決まりです。直したいときは、エージェントに「〇〇と覚えておいて」「〇〇は違うので直して」と頼みます。' }),
      section('人', 'この領域で関わる人', one.people, 'まだ書かれていません'),
      section('ナレッジ', '決まりと事実。「本人の言葉」はユーザーが言ったこと、「未確認」はエージェントの気づき', one.knowledge, 'まだ書かれていません'),
      section('受信箱', 'エージェントの気づき。秘書が週に1回整理するまでここに置かれます', one.inbox, '受信箱は空です'),
      filesSection(one, file, ctx),
    ]
    : [];
  return h('div', { class: 'wf-page-tasks' }, header, ctx.banner(),
    h('div', { class: 'wf-tasks-body' }, left, h('section', { class: 'wf-tasklist', 'aria-label': 'ナレッジ', data: { scroll: `know-${view.profile}` } }, ...right)));
}

function skeleton(ctx) {
  const row = () => h('div', { class: 'wf-goal-btn' }, skel('50%', '15px'), skel('80%', '13px'));
  return h('div', { class: 'wf-page-tasks' }, ctx.head('ナレッジ'), ctx.banner(),
    h('div', { class: 'wf-tasks-body', 'aria-busy': 'true' },
      h('section', { class: 'wf-goals' }, h('h2', { text: 'プロフィール' }), row(), row(), row()),
      h('section', { class: 'wf-tasklist' }, skel('30%', '22px'), skel('100%', '120px', { borderRadius: '10px' }), skel('30%', '22px'), skel('100%', '120px', { borderRadius: '10px' }))));
}

export default { load, render, skeleton };
