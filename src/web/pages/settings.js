// 設定: the sidebar becomes the list of settings, with 戻る. The profile is the one thing the
// Web screens write.

import { h, icon, skel, soonBadge, githubIcon, profileChip, ago, ymd } from '../ui.js';

const SECTIONS = {
  profile: 'プロフィール',
  display: '表示',
  secretary: '秘書に任せること',
  life: '自身について',
  places: '作業フォルダ',
  devices: 'デバイスとシークレット',
  apps: '接続済みのAIエージェント',
};
const CATS = [['display', 'display', '#8cc4ea'], ['secretary', 'secretary', '#f4b9a8'], ['life', 'life', '#f1c47e'], ['places', 'folder', '#8fd3b2'], ['devices', 'laptop', '#a9a3ec'], ['apps', 'apps', '#e7a9d8']];
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
      h('div', { class: 'wf-field' }, 'アイコン画像',
        h('span', { class: 'wf-field-row' }, h('button', { type: 'button', class: 'wf-btn-line', disabled: true, text: '画像を選ぶ' }), soonBadge(), h('span', { text: '選ばないときは名前の頭文字' }))),
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

// The theme is kept in this browser: 自動 follows the system (theme.js reads it at load).
const THEMES = [['light', 'ライト'], ['dark', 'ダーク'], ['auto', '自動']];

function themeNow() {
  try {
    const t = localStorage.getItem('wf.theme');
    return t === 'light' || t === 'dark' ? t : 'auto';
  } catch {
    return 'auto';
  }
}

function setTheme(t, ctx) {
  try {
    if (t === 'auto') localStorage.removeItem('wf.theme');
    else localStorage.setItem('wf.theme', t);
  } catch {
    // Storage may be off: the choice lasts until the page is opened again.
  }
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  ctx.rerender();
}

function displaySection(ctx) {
  const now = themeNow();
  const theme = h('div', { class: 'wf-seg', role: 'group', 'aria-label': 'テーマ' },
    ...THEMES.map(([k, label]) => h('button', { type: 'button', 'aria-pressed': String(now === k), data: { key: `theme-${k}` }, onclick: () => setTheme(k, ctx), text: label })));
  return h('section', { class: 'wf-surface wf-theme' }, h('span', { class: 'wf-muted', text: 'テーマ' }), theme);
}

// The secretary's autonomy, to look at only. It changes when the person tells the secretary.
const STAGES = [[2, '予定と受信箱'], [3, 'タスクとナレッジ']];

function secretarySection(a) {
  const row = (k) => h('div', { class: 'wf-row wf-row-autonomy' },
    h('span', { class: 'wf-cell' }, h('b', { text: k.label })),
    h('span', { class: 'wf-cell' },
      h('span', { class: ['wf-level', k.level === 'act_then_tell' && 'wf-level-on'], text: k.level === 'act_then_tell' ? 'やってから知らせる' : '聞いてから' }),
      k.by_person ? h('span', { class: 'wf-muted wf-small', text: 'ユーザーが決めました' }) : null),
    h('span', { class: 'wf-tm-num', text: k.level === 'act_then_tell' || k.by_person ? '—' : `${k.approvals_in_row} / ${a.streak}` }),
    h('span', { class: 'wf-tm-num', text: `${k.revokes}回` }));
  const intro = h('section', { class: 'wf-surface wf-autonomy-intro' },
    h('p', { text: a.secretary
      ? `秘書は、そのまま了承が${a.streak}回続いた動きを、聞かずに行ってから知らせるようになります。取り消すと、聞いてからに戻ります。外に出ることと元に戻せないことは、任せません。`
      : '秘書が止まっているため、どの動きも毎回聞いてから行います。' }),
    h('p', { class: 'wf-muted', text: '任せ方を変えるときは、秘書に話しかけてください。' }),
    h('a', { class: 'wf-btn-line wf-autonomy-go', href: '/secretary', text: '秘書と話す' }));
  return [
    intro,
    ...STAGES.map(([stage, title]) => {
      const list = a.kinds.filter((k) => k.stage === stage);
      return table(title, `${list.length}件`, 'autonomy', ['動き', '任せ方', '続けて了承', '取り消し'], list.map(row), 'まだありません');
    }),
  ];
}

// The person's settings that scheduling reads, to look at only. They are made and changed in
// the conversation with the secretary (最初の会話 makes them on a new install).
const DAY_WORDS = { daily: '毎日', weekdays: '平日' };
const daysText = (d) => DAY_WORDS[d] ?? (Array.isArray(d) ? d.join('・') : '');

function lifeSection(life, colors) {
  const unset = (section, k) => (life.defaults?.[section] ?? []).includes(k);
  const fresh = ['life', 'places', 'week'].every((s) => Object.keys(life[s]).every((k) => unset(s, k))) && Object.keys(life.limits).every((k) => unset('limits', k));
  const state = life.onboarding?.state ?? null;
  const intro = h('section', { class: 'wf-surface wf-autonomy-intro' },
    h('p', { text: fresh && state !== 'skipped'
      ? 'まだ設定がありません。秘書と話すと、最初の会話で生活の決まりと場所を一緒に作ります。'
      : '秘書が予定を組むときに使う設定です。変えるときは、秘書に話しかけてください。' }),
    h('a', { class: 'wf-btn-line wf-autonomy-go', href: '/secretary', text: '秘書と話す' }));
  const L = life.limits;
  const limitRow = (label, value, keys) => h('div', { class: 'wf-row wf-row-life2' },
    h('span', { class: 'wf-muted', text: label }),
    h('span', { class: 'wf-cell' }, h('b', { text: value }), keys.every((k) => unset('limits', k)) ? h('span', { class: 'wf-muted wf-small', text: '既定値' }) : null));
  const limits = [
    limitRow('予定を置く時間', `${L.earliest}〜${L.latest}`, ['earliest', 'latest']),
    limitRow('1日の上限', `${L.day_max_hours}時間`, ['day_max_hours']),
    limitRow('1つの予定の長さ', `${L.block_min_minutes}〜${L.block_max_minutes}分`, ['block_min_minutes', 'block_max_minutes']),
  ];
  const rules = life.life.rules.map((r) => h('div', { class: 'wf-row wf-row-life1' }, h('span', { text: r })));
  const slots = life.week.slots.map((x) => h('div', { class: 'wf-row wf-row-week' },
    h('span', { text: daysText(x.days) }),
    h('span', { text: `${x.start}〜${x.end}` }),
    h('span', { class: 'wf-ellipsis', text: x.place }),
    h('span', {}, x.profile ? profileChip(x.profile, colors, 15) : h('span', { class: 'wf-muted', text: 'なし' }))));
  const places = life.places.places.map((x) => h('div', { class: 'wf-row wf-row-life2' },
    h('span', { class: 'wf-ellipsis', style: { fontWeight: '600' }, text: x.name }),
    h('span', { class: 'wf-muted', text: x.note ?? '' })));
  const travel = life.places.travel.map((x) => h('div', { class: 'wf-row wf-row-life2' },
    h('span', { class: 'wf-ellipsis', text: `${x.from} → ${x.to}` }),
    h('span', { text: `${x.minutes}分` })));
  const kinds = (life.profiles ?? []).map((x) => h('div', { class: 'wf-row wf-row-life2' },
    h('span', {}, profileChip(x.name, colors, 15)),
    h('span', { text: x.human_led ? 'ユーザー' : 'エージェント' })));
  // Before anything is set, the intro says so once, instead of a まだありません under each table.
  const shown = (rows) => !fresh || rows.length > 0;
  return [
    intro,
    shown(rules) ? table('生活の決まり', `${rules.length}件`, 'life1', [], rules, 'まだありません') : null,
    table('上限', '', 'life2', [], limits, ''),
    shown(slots) ? table('週の型', `${slots.length}件`, 'week', ['曜日', '時間', '場所', 'プロフィール'], slots, 'まだありません') : null,
    shown(places) ? table('場所', `${places.length}件`, 'life2', ['名前', 'メモ'], places, 'まだありません') : null,
    places.length > 1 || travel.length ? table('移動時間', `${travel.length}件`, 'life2', ['場所', '片道'], travel, 'まだありません') : null,
    shown(kinds) ? table('プロフィール', `${kinds.length}件`, 'life2', ['プロフィール', 'ゴールを主導する人'], kinds, 'まだありません') : null,
  ];
}

function table(title, count, kind, heads, rows, empty) {
  return h('section', { class: 'wf-surface wf-table' },
    h('div', { class: 'wf-table-head' }, h('h2', { text: title }), h('span', { class: 'wf-muted', text: count })),
    heads.length ? h('div', { class: `wf-cols wf-cols-${kind}` }, ...heads.map((x) => h('span', { text: x }))) : null,
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
    h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', color: d.secret === 'on' ? 'var(--ink)' : 'var(--sub)' } },
      h('span', { class: 'wf-dot', style: { background: d.secret === 'on' ? 'var(--green)' : 'var(--line)' }, 'aria-hidden': 'true' }), words[d.secret]),
    h('span', { style: { color: d.github_login ? 'var(--ink)' : 'var(--sub)' }, text: d.github_login ? 'あり' : 'なし' }),
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
  else if (view.sec === 'display') content = displaySection(ctx);
  else if (view.sec === 'secretary') content = secretarySection(st.autonomy);
  else if (view.sec === 'life') content = lifeSection(st.life, st.profiles);
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
