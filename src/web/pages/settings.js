// 設定: the sidebar becomes the list of settings, with 戻る. The profile is the one thing the
// Web screens write.

import { h, icon, skel, soonBadge, githubIcon, profileChip, ago, ymd } from '../ui.js';

const SECTIONS = {
  profile: 'プロフィール',
  display: '表示',
  life: '自身について',
  places: '作業フォルダ',
  devices: 'デバイスとシークレット',
  apps: '接続済みのAIエージェント',
};
const CATS = [['display', 'display', '#8cc4ea'], ['life', 'life', '#f1c47e', true], ['places', 'folder', '#8fd3b2'], ['devices', 'laptop', '#a9a3ec'], ['apps', 'apps', '#e7a9d8']];
const COLORS = [['水色', '#8cc4ea'], ['ミント', '#8fd3b2'], ['ラベンダー', '#a9a3ec'], ['桃', '#e7a9d8'], ['山吹', '#f1c47e'], ['灰', '#c9ced6']];

const sectionOf = () => {
  const k = location.hash.slice(1);
  return k in SECTIONS ? k : 'profile';
};
const view = { sec: sectionOf(), editing: false, draft: null, problems: [], saving: false };
let last = null;
let ctxRef = null;

window.addEventListener('hashchange', () => {
  view.sec = sectionOf();
  view.editing = false;
  ctxRef?.rerender();
});

async function load(api) {
  const [settings, profile] = await Promise.all([api('/settings'), api('/profile')]);
  last = { settings, profile };
  return last;
}

const nameOf = (p) => p?.name || 'あなた';
const initial = (p) => [...nameOf(p)][0] ?? 'あ';
const ghText = (p) => (p?.github ? `@${p.github}` : 'GitHub のログインは使っていません');

function go(sec) {
  view.editing = false;
  if (location.hash.slice(1) === sec) {
    view.sec = sec;
    ctxRef?.rerender();
  } else location.hash = sec;
}

function back() {
  let to = '/calendar';
  try {
    const v = sessionStorage.getItem('wf.back');
    if (v && /^\/(calendar|tasks|server)$/.test(v)) to = v;
  } catch {
    // Storage may be off.
  }
  return to;
}

function nav(ctx) {
  ctxRef = ctx;
  const p = last?.profile;
  const color = (view.editing && view.draft?.color) || p?.color || '#8cc4ea';
  const cur = (k) => (view.sec === k ? 'page' : undefined);
  return [
    h('div', { class: 'wf-nav-gap' }),
    h('a', { class: 'wf-nav-item', href: back() }, icon('back'), h('span', { text: '戻る' })),
    h('span', { class: 'wf-set-title', text: '設定' }),
    h('button', { type: 'button', class: 'wf-me', aria: { current: cur('profile') }, onclick: () => go('profile') },
      h('span', { class: 'wf-me-avatar', style: { background: color }, 'aria-hidden': 'true', text: initial(p) }),
      h('span', { class: 'wf-me-text' }, h('span', { text: nameOf(p) }), h('span', { text: ghText(p) }))),
    h('div', { class: 'wf-nav-sep', 'aria-hidden': 'true' }),
    ...CATS.map(([k, ic, c, soon]) => h('button', { type: 'button', class: ['wf-catbtn', soon && 'wf-disabled'], aria: { current: cur(k) }, onclick: () => go(k) },
      h('span', { class: 'wf-caticon', style: { background: c }, 'aria-hidden': 'true' }, icon(ic, 16)),
      h('span', { class: 'wf-catlabel', text: SECTIONS[k] }), soon ? soonBadge() : null)),
    h('div', { class: 'wf-nav-bottom' }),
  ];
}

function profileSection(p, ctx) {
  const d = view.editing ? view.draft : p;
  const color = d.color || '#8cc4ea';
  const top = h('div', { class: 'wf-profile-top' },
    h('span', { class: 'wf-big-avatar', style: { background: color }, 'aria-hidden': 'true', text: [...(d.name || 'あなた')][0] ?? 'あ' }),
    view.editing ? null : h('button', { type: 'button', class: 'wf-btn-line', data: { key: 'edit' }, onclick: () => {
      view.editing = true;
      view.problems = [];
      view.draft = { name: p.name ?? '', bio: p.bio ?? '', color: p.color };
      ctx.rerender();
      document.getElementById('wf-name')?.focus();
    }, text: 'プロフィールを編集' }));
  let body;
  if (!view.editing) {
    body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
      h('span', { class: 'wf-profile-name', text: nameOf(p) }),
      h('span', { class: 'wf-gh' }, githubIcon(), p.github ? `GitHub: @${p.github}` : 'GitHub のログインは使っていません'),
      p.bio ? h('p', { class: 'wf-bio', text: p.bio }) : null);
  } else {
    const swatches = COLORS.map(([label, c]) => h('button', {
      type: 'button', class: 'wf-swatch', 'aria-label': label, 'aria-pressed': String(view.draft.color === c), style: { background: c }, data: { key: `sw-${c}` },
      onclick: () => { view.draft.color = c; ctx.rerender(); },
    }));
    const save = async () => {
      view.saving = true;
      ctx.rerender();
      try {
        const out = await ctx.api('/profile', { method: 'POST', body: view.draft });
        last.profile = out;
        view.editing = false;
        view.draft = null;
        view.problems = [];
      } catch (err) {
        view.problems = err.body?.problems ?? ['保存できませんでした。サーバーにつながっているか確かめてください'];
      }
      view.saving = false;
      ctx.rerender();
    };
    const cancel = () => {
      view.editing = false;
      view.draft = null;
      view.problems = [];
      ctx.rerender();
    };
    body = h('form', { class: 'wf-form', onsubmit: (e) => { e.preventDefault(); save(); } },
      h('label', { class: 'wf-field' }, '名前',
        h('input', { id: 'wf-name', value: view.draft.name, maxlength: 40, required: true, autocomplete: 'off', oninput: (e) => { view.draft.name = e.target.value; } })),
      h('div', { class: 'wf-field', role: 'group', 'aria-label': 'テーマカラー' }, 'テーマカラー', h('span', { class: 'wf-swatches' }, ...swatches)),
      h('label', { class: 'wf-field' }, 'GitHub アカウント',
        h('input', { value: p.github ? `@${p.github}` : 'GitHub のログインは使っていません', disabled: true }), h('span', { text: 'ログインしたアカウントが入ります' })),
      h('label', { class: 'wf-field' }, '自己紹介',
        (() => {
          const ta = h('textarea', { rows: 3, maxlength: 400, oninput: (e) => { view.draft.bio = e.target.value; } });
          ta.value = view.draft.bio;
          return ta;
        })(),
        h('span', { text: '秘書やエージェントが、あなたのことを知る手がかりにします' })),
      view.problems.length ? h('ul', { class: 'wf-errors', role: 'alert' }, ...view.problems.map((x) => h('li', { text: x }))) : null,
      h('span', { class: 'wf-actions' },
        h('button', { type: 'submit', class: 'wf-btn-primary', disabled: view.saving, text: view.saving ? '保存しています' : '保存' }),
        h('button', { type: 'button', class: 'wf-btn-line', onclick: cancel, text: 'やめる' })));
  }
  return h('section', { class: 'wf-surface', 'aria-label': 'プロフィール', style: { overflow: 'hidden' } },
    h('div', { class: 'wf-banner-band', style: { background: color }, 'aria-hidden': 'true' }),
    h('div', { class: 'wf-profile-body' }, top, body));
}

function displaySection() {
  const theme = h('div', { class: 'wf-seg', role: 'group', 'aria-label': 'テーマ' },
    h('button', { type: 'button', 'aria-pressed': 'true', text: 'ライト' }),
    h('button', { type: 'button', disabled: true, 'aria-pressed': 'false' }, 'ダーク', soonBadge()));
  return [
    h('section', { class: 'wf-surface wf-theme' }, h('span', { class: 'wf-muted', text: 'テーマ' }), theme),
  ];
}

function lifeSection() {
  const pair = () => h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, skel('40%', '12px'), skel('100%', '32px'));
  return h('section', { class: 'wf-placeholder', 'aria-disabled': 'true' },
    h('div', { class: 'wf-placeholder-head' }, h('h2', { text: '自身について' }), soonBadge()),
    h('p', { text: '秘書が予定を組むときに使う、生活の決まりと場所です。' }),
    h('div', { 'aria-hidden': 'true', style: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '14px', borderRadius: '10px', background: '#f9f9fb' } },
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' } }, pair(), pair(), pair(), pair()), pair()));
}

function table(title, count, kind, heads, rows, empty) {
  return h('section', { class: 'wf-surface wf-table' },
    h('div', { class: 'wf-table-head' }, h('h2', { text: title }), h('span', { class: 'wf-muted', text: count })),
    h('div', { class: `wf-cols wf-cols-${kind}` }, ...heads.map((x) => h('span', { text: x }))),
    ...rows,
    rows.length ? null : h('div', { class: 'wf-empty', text: empty }));
}

// A place with no work for this many days is put away under 使っていない.
const IDLE_DAYS = 30;

function placesSection(st, ctx) {
  const idleBefore = ctx.now.getTime() - IDLE_DAYS * 86_400_000;
  const sorted = [...st.places].sort((a, b) => ((a.last_active_at ?? '') < (b.last_active_at ?? '') ? 1 : -1));
  const idle = sorted.filter((p) => !p.last_active_at || Date.parse(p.last_active_at) < idleBefore);
  const shown = view.idle ? sorted : sorted.filter((p) => !idle.includes(p));
  const rows = shown.map((p) => h('div', { class: ['wf-row wf-row-places', idle.includes(p) && 'wf-idle'] },
    h('span', { class: 'wf-ellipsis', style: { fontWeight: '600' }, text: p.name }),
    h('span', {}, p.profile ? profileChip(p.profile, st.profiles, 15) : h('span', { class: 'wf-muted', text: 'なし' })),
    h('span', { class: 'wf-muted', text: p.last_active_at ? ago(p.last_active_at, ctx.now) : '—' }),
    h('span', { class: 'wf-cell', style: { gap: '2px' } }, ...p.paths.map((x) => h('span', { style: { display: 'flex', gap: '8px', minWidth: '0' } },
      h('span', { class: 'wf-muted wf-ellipsis', style: { flex: 'none', width: '64px' }, text: x.device }), h('span', { class: 'wf-mono wf-ellipsis', text: x.path }))))));
  const toggle = idle.length
    ? h('button', {
      type: 'button', class: 'wf-btn wf-idle-toggle', data: { key: 'idle' },
      onclick: () => { view.idle = !view.idle; ctx.refresh(); },
      text: view.idle ? '最近使っていない作業フォルダを隠す' : `最近使っていない作業フォルダを表示 · ${idle.length}件`,
    })
    : null;
  return [
    table('作業フォルダ', `${shown.length}件`, 'places', ['名前', 'プロフィール', '最終アクティブ', 'パス'], rows, 'まだ作業フォルダがありません。エージェントが place で登録すると、ここに出ます'),
    toggle,
  ];
}

function devicesSection(st) {
  const words = { on: '使用中', none: 'なし', revoked: '取り消し済み' };
  const row = (d) => h('div', { class: 'wf-row wf-row-secrets' },
    h('span', { class: 'wf-ellipsis', style: { fontWeight: '600' }, text: d.name }),
    h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', color: d.secret === 'on' ? '#1d1d1f' : '#6e6e73' } },
      h('span', { class: 'wf-dot', style: { background: d.secret === 'on' ? '#5fb98f' : '#d2d2d7' }, 'aria-hidden': 'true' }), words[d.secret]),
    h('span', { style: { color: d.github_login ? '#1d1d1f' : '#6e6e73' }, text: d.github_login ? 'あり' : 'なし' }),
    h('span', { class: 'wf-muted', text: d.created_at ? ymd(new Date(d.created_at)) : '—' }));
  // The machines that use the server, the secretary, and other programs on the server machine.
  const groups = [['device', 'デバイス', 'まだデバイスがありません'], ['secretary', '秘書'], ['server', 'サーバー']];
  return groups.map(([role, title, empty]) => {
    const list = st.devices.filter((d) => (d.role ?? 'device') === role);
    if (!list.length && !empty) return null;
    return table(title, `${list.length}台`, 'secrets', [role === 'device' ? 'デバイス' : '名前', 'シークレット', 'GitHub ログイン', '登録日'], list.map(row), empty);
  });
}

function appsSection(st, ctx) {
  const rows = st.apps.map((a) => h('div', { class: 'wf-row wf-row-apps' },
    h('span', { class: 'wf-ellipsis', style: { fontWeight: '600' }, text: a.client_name ?? '名前のないアプリ' }),
    h('span', { class: 'wf-ellipsis', text: a.device }),
    h('span', { class: 'wf-muted', text: ago(a.last_token_at, ctx.now) })));
  return table('接続済みのAIエージェント', `${st.apps.length}件`, 'apps', ['AIエージェント', 'デバイス', '最終接続'], rows, 'GitHub のログインでつないだ AI エージェントは、まだありません');
}

function render(data, ctx) {
  ctxRef = ctx;
  last = data;
  const st = data.settings;
  let content;
  if (view.sec === 'profile') content = profileSection(data.profile, ctx);
  else if (view.sec === 'display') content = displaySection();
  else if (view.sec === 'life') content = lifeSection();
  else if (view.sec === 'places') content = placesSection(st, ctx);
  else if (view.sec === 'devices') content = devicesSection(st);
  else content = appsSection(st, ctx);
  return h('div', { class: 'wf-set-main', data: { scroll: `set-${view.sec}` } },
    h('div', { class: 'wf-set-col' }, ctx.head(SECTIONS[view.sec]), ctx.banner(), content));
}

function skeleton(ctx) {
  ctxRef = ctx;
  return h('div', { class: 'wf-set-main' }, h('div', { class: 'wf-set-col' }, ctx.head(SECTIONS[view.sec]), ctx.banner(),
    h('section', { class: 'wf-surface', 'aria-busy': 'true', style: { padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px' } }, skel('40%', '17px'), skel('100%', '15px'), skel('80%', '15px'))));
}

// While the profile is being edited, the 30-second reading does not redraw the form.
const busy = () => view.editing;

export default { load, render, skeleton, nav, busy };
