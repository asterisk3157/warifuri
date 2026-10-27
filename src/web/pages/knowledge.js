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

const count = (p) => p.people + p.knowledge + p.inbox + p.files;

// A note line as warifuri writes it: "- 2026-10-24 「本人の言葉」 text (device task)". Shown
// as the text with its date and who said it; the device stays out.
const NOTE = /^- (\d{4})-(\d{2})-(\d{2}) (?:「(本人の言葉|未確認)」 )?(.*?)(?: \([^()]*\))?$/;
const WHO = { 本人の言葉: 'ユーザーの言葉', 未確認: '未確認' };

function notes(text) {
  const lines = text.split('\n').filter((l) => l.trim());
  const parsed = lines.map((l) => NOTE.exec(l.trim()));
  if (!parsed.every(Boolean)) return h('div', { class: 'wf-md wf-know-body' }, renderMarkdown(h, text));
  return h('ul', { class: 'wf-know-notes' }, ...parsed.reverse().map((m) => h('li', {},
    h('span', { class: 'wf-know-text', text: m[5] }),
    h('span', { class: 'wf-know-meta', text: [`${Number(m[2])}/${Number(m[3])}`, m[4] ? WHO[m[4]] : null].filter(Boolean).join(' · ') }))));
}

function profileButton(p, colors, ctx) {
  return h('button', {
    type: 'button', class: 'wf-goal-btn', 'aria-pressed': String(view.profile === p.name), data: { key: `profile-${p.name}` },
    onclick: () => { view.profile = p.name; view.open = null; ctx.refresh(); },
  },
  h('span', { class: 'wf-goal-top' }, profileChip(p.name, colors, 15)),
  h('span', { class: 'wf-goal-meta', text: count(p) ? [p.people && `人 ${p.people}`, p.knowledge && `ナレッジ ${p.knowledge}`, p.inbox && `受信箱 ${p.inbox}`, p.files && `手順 ${p.files}`].filter(Boolean).join(' · ') : 'まだありません' }));
}

// One file of the profile, left out when it is empty.
function section(title, file) {
  if (!file?.text?.trim()) return null;
  return h('section', { class: 'wf-know-sec' },
    h('div', { class: 'wf-group-head' }, h('h2', { text: title })),
    notes(file.text),
    file.truncated ? h('p', { class: 'wf-muted', text: '長いため、途中までを表示しています' }) : null);
}

function filesSection(one, file, ctx) {
  const names = [...(one.files.knowledge ?? []), ...(one.files.procedures ?? [])];
  if (!names.length) return null;
  return h('section', { class: 'wf-know-sec' },
    h('div', { class: 'wf-group-head' }, h('h2', { text: '手順' }), h('span', { class: 'wf-group-count', text: `${names.length}件` })),
    ...names.map((n) => h('div', { class: 'wf-know-file' },
      h('button', { type: 'button', class: 'wf-know-name', 'aria-expanded': String(view.open === n), data: { key: `file-${n}` }, onclick: () => { view.open = view.open === n ? null : n; ctx.refresh(); }, text: n.replace(/^(knowledge|procedures)\//, '').replace(/\.md$/, '') }),
      view.open === n && file?.text ? h('div', { class: 'wf-md wf-know-body' }, renderMarkdown(h, file.text)) : null)));
}

function render(data, ctx) {
  const { list, one, file } = data;
  const header = ctx.head('ナレッジ');
  if (!list.profiles.length) {
    return h('div', { class: 'wf-page-tasks' }, header, ctx.banner(),
      h('div', { class: 'wf-surface wf-big-empty', text: 'まだナレッジがありません。エージェントに覚えておいてほしいことを伝えると、ここに表示されます' }));
  }
  const left = h('section', { class: 'wf-goals', 'aria-label': 'プロフィール', data: { scroll: 'profiles' } },
    h('h2', { text: 'プロフィール' }), ...list.profiles.map((p) => profileButton(p, list.colors, ctx)));
  const parts = one ? [section('人', one.people), section('ナレッジ', one.knowledge), section('受信箱', one.inbox), filesSection(one, file, ctx)].filter(Boolean) : [];
  const right = parts.length ? parts : [h('div', { class: 'wf-empty', text: 'まだありません' })];
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
