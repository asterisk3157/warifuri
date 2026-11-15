// Draws some days of the calendar as an SVG picture: the fixed appointments in grey and the
// time taken for tasks and habits in the colour of their profile, side by side where they
// overlap, the way a calendar app shows a week. The week type (where the person is at set
// times) is a light band behind them. Bookings to point at (the ones just changed) get a thick
// outline. Pure: data in, SVG text out (svgToPng in image.mjs makes a PNG).

import { GOOGLE_G } from '../web/google-mark.js';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const FONT = "'Noto Sans CJK JP', 'Hiragino Sans', 'Yu Gothic', sans-serif";
const FIXED = { fill: '#E5E7EB', text: '#111827' };
const HABIT = '#e8a19c';
const MARK = '#E91E63';

const W = 1200;
const GUTTER = 54;
const PAD = 10;
const HEAD_H = 52;
const ALLDAY_ROW = 20;
const HOUR_H = 46;
const LEGEND_H = 38;

export const toMin = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const hour = (time) => time.replace(/^0/, '');
// The Google "G", size pixels wide, its top left at x, y.
const gMark = (x, y, size) =>
  `<g transform="translate(${x} ${y}) scale(${size / 48})">${GOOGLE_G.map(([fill, d]) => `<path fill="${fill}" d="${d}"/>`).join('')}</g>`;
export const esc = (text) =>
  String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// Rough text width: full-width characters take one em, the rest a bit more than half.
export const textWidth = (text, size) =>
  [...text].reduce((sum, ch) => sum + (ch.codePointAt(0) < 0x2000 ? 0.58 : 1) * size, 0);

export function clip(text, maxWidth, size) {
  if (textWidth(text, size) <= maxWidth) return text;
  let out = '';
  for (const ch of text) {
    if (textWidth(`${out}${ch}…`, size) > maxWidth) break;
    out += ch;
  }
  return `${out}…`;
}

// Entries that overlap share the column: each gets a lane and the number of lanes of its group.
export function assignLanes(entries) {
  const sorted = [...entries].sort((a, b) => a.s - b.s || b.e - a.e);
  let group = [];
  let ends = [];
  let groupEnd = -1;
  const close = () => {
    for (const entry of group) entry.lanes = ends.length;
    group = [];
    ends = [];
    groupEnd = -1;
  };
  for (const entry of sorted) {
    if (group.length && entry.s >= groupEnd) close();
    let lane = ends.findIndex((end) => end <= entry.s);
    if (lane < 0) {
      lane = ends.length;
      ends.push(entry.e);
    } else {
      ends[lane] = entry.e;
    }
    entry.lane = lane;
    group.push(entry);
    groupEnd = Math.max(groupEnd, entry.e);
  }
  close();
  return sorted;
}

// The hours shown: from 7 to 22 at least, widened to whole hours when something lies outside.
export function hourRange(entries) {
  const starts = entries.map((e) => toMin(e.start));
  const ends = entries.map((e) => toMin(e.end));
  const first = Math.max(0, Math.min(7, Math.floor(Math.min(...starts, 7 * 60) / 60)));
  const last = Math.min(24, Math.max(22, Math.ceil(Math.max(...ends, 22 * 60) / 60)));
  return { first, last };
}

const pad2 = (n) => String(n).padStart(2, '0');
const dateOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const timeOf = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

// The days from..to (local midnights) and the bookings cut to them, in the local time of this
// machine. bookings: as schedule returns them. colors: profile name → '#rrggbb'.
// bands: the week type on those days (weekBands in src/ledger/settings.mjs).
// Returns { dates, entries, allDay } for renderWeek.
export function weekData({ from, to, bookings, colors = {}, marks = [], bands = [] }) {
  const start = new Date(Date.parse(from));
  const first = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const dates = [];
  for (let d = first; d.getTime() < Date.parse(to); d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) dates.push(d);
  const entries = [];
  const allDay = [];
  for (const b of bookings) {
    const s = Date.parse(b.starts_at);
    const e = Date.parse(b.ends_at);
    const color = ['fixed', 'travel'].includes(b.kind) ? null : b.kind === 'habit' ? HABIT : colors[b.profile] ?? '#8cc4ea';
    const label = ['fixed', 'travel'].includes(b.kind) ? null : b.kind === 'habit' ? '習慣' : b.profile ?? 'タスク';
    for (const day of dates) {
      const dayStart = day.getTime();
      const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
      if (e <= dayStart || s >= dayEnd) continue;
      if (s <= dayStart && e >= dayEnd) {
        allDay.push({ date: dateOf(day), title: b.title, google: typeof b.source === 'string' && b.source.startsWith('google-calendar') });
        continue;
      }
      const from2 = new Date(Math.max(s, dayStart));
      const to2 = e >= dayEnd ? '24:00' : timeOf(new Date(e));
      entries.push({ date: dateOf(day), start: timeOf(from2), end: to2, title: b.title, color, label, mark: marks.includes(b.id), google: typeof b.source === 'string' && b.source.startsWith('google-calendar') });
    }
  }
  for (const band of bands) {
    const s = new Date(Date.parse(band.starts_at));
    const e = new Date(Date.parse(band.ends_at));
    const end = dateOf(e) === dateOf(s) ? timeOf(e) : '24:00';
    entries.push({ date: dateOf(s), start: timeOf(s), end, title: band.profile ? `${band.place} · ${band.profile}` : band.place, container: true });
  }
  return { dates: dates.map(dateOf), entries, allDay };
}

// dates:   the columns, 'YYYY-MM-DD'
// entries: { date, start, end, title, color?, label?, mark?, google?, container? }; color absent
//          for a fixed one; google: it is in Google Calendar (the G at its top right);
//          container: a band of the week type, behind the rest
// allDay:  { date, title, google? }
// today:   'YYYY-MM-DD'
export function renderWeek({ dates, entries, allDay = [], today }) {
  const { first, last } = hourRange(entries);
  const colW = (W - GUTTER - PAD) / dates.length;
  const allDayRows = Math.min(2, Math.max(0, ...dates.map((d) => allDay.filter((a) => a.date === d).length)));
  const stripH = allDayRows ? allDayRows * ALLDAY_ROW + 10 : 0;
  const top = HEAD_H + stripH;
  const gridH = (last - first) * HOUR_H;
  const H = top + gridH + LEGEND_H;
  const x = (i) => GUTTER + i * colW;
  const y = (min) => top + ((min - first * 60) / 60) * HOUR_H;
  const out = [];

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`,
    `<rect width="${W}" height="${H}" fill="#FFFFFF"/>`,
  );

  // Columns: today is tinted, the header names the day.
  dates.forEach((date, i) => {
    const [, month, day] = date.split('-').map(Number);
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const colour = dow === 0 ? '#DC2626' : dow === 6 ? '#2563EB' : '#111827';
    if (date === today) out.push(`<rect x="${x(i)}" y="0" width="${colW}" height="${top + gridH}" fill="#F5F3FF"/>`);
    out.push(
      `<text x="${x(i) + colW / 2}" y="33" text-anchor="middle" font-size="19" font-weight="700" fill="${colour}">${month}/${day}(${WEEKDAYS[dow]})${date === today ? ' 今日' : ''}</text>`,
    );
  });

  // All-day entries, at most two per day.
  dates.forEach((date, i) => {
    const items = allDay.filter((a) => a.date === date);
    items.slice(0, allDayRows).forEach((item, row) => {
      const more = row === allDayRows - 1 && items.length > allDayRows ? ` ほか${items.length - allDayRows}件` : '';
      const text = clip(item.title, colW - 14 - (item.google ? 16 : 0) - textWidth(more, 12), 12) + more;
      const ty = HEAD_H + row * ALLDAY_ROW;
      out.push(
        `<rect x="${x(i) + 3}" y="${ty}" width="${colW - 6}" height="${ALLDAY_ROW - 3}" rx="3" fill="#F3F4F6"/>`,
        `<text x="${x(i) + 8}" y="${ty + 13}" font-size="12" fill="#374151">${esc(text)}</text>`,
      );
      if (item.google) out.push(gMark(x(i) + colW - 17, ty + 2, 12));
    });
  });

  // Hour lines and labels.
  for (let h = first; h <= last; h += 1) {
    const ly = y(h * 60);
    out.push(`<line x1="${GUTTER}" y1="${ly}" x2="${W - PAD}" y2="${ly}" stroke="#E5E7EB" stroke-width="1"/>`);
    if (h < last) out.push(`<text x="${GUTTER - 8}" y="${ly + 5}" text-anchor="end" font-size="13" fill="#6B7280">${h}:00</text>`);
  }
  for (let i = 0; i <= dates.length; i += 1) {
    out.push(`<line x1="${x(i)}" y1="${HEAD_H - 8}" x2="${x(i)}" y2="${top + gridH}" stroke="#E5E7EB" stroke-width="1"/>`);
  }

  dates.forEach((date, i) => {
    const day = entries
      .filter((e) => e.date === date)
      .map((e) => ({ ...e, s: toMin(e.start), e: toMin(e.end) }))
      .filter((e) => e.e > e.s);
    // A band of the week type (time at the lab) is drawn light, behind whatever is inside it.
    for (const c of day.filter((e) => e.container)) {
      const cy = y(c.s);
      out.push(
        `<rect x="${x(i) + 2}" y="${cy + 1}" width="${colW - 4}" height="${y(c.e) - cy - 2}" rx="5" fill="#F3F4F6" stroke="#9CA3AF" stroke-width="1" stroke-dasharray="4 3"/>`,
        `<text x="${x(i) + colW - 8}" y="${y(c.e) - 8}" text-anchor="end" font-size="12" fill="#6B7280">${esc(clip(c.title, colW - 16, 12))}</text>`,
      );
    }

    for (const entry of assignLanes(day.filter((e) => !e.container))) {
      const inset = entry.color ? 8 : 3;
      const laneW = (colW - inset - 3) / entry.lanes;
      const bx = x(i) + inset + entry.lane * laneW;
      const by = y(entry.s) + 1;
      const bw = laneW - 2;
      const bh = Math.max(18, y(entry.e) - y(entry.s) - 2);
      const fill = entry.color ?? FIXED.fill;
      const stroke = entry.mark ? ` stroke="${MARK}" stroke-width="4"` : '';
      out.push(`<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="5" fill="${fill}"${stroke}/>`);
      if (entry.google) out.push(gMark(bx + bw - 16, by + 4, 12));
      const tx = bx + 7;
      const room = bw - (entry.color ? 12 : 15) - (entry.google ? 14 : 0);
      if (bh < 34) {
        out.push(`<text x="${tx}" y="${by + 14}" font-size="12" font-weight="700" fill="${FIXED.text}">${esc(clip(`${hour(entry.start)} ${entry.title}`, room, 12))}</text>`);
        continue;
      }
      out.push(
        `<text x="${tx}" y="${by + 18}" font-size="15" font-weight="700" fill="${FIXED.text}">${esc(clip(entry.title, room, 15))}</text>`,
        `<text x="${tx}" y="${by + 34}" font-size="12" fill="${FIXED.text}" fill-opacity="0.85">${esc(clip(`${hour(entry.start)}〜${hour(entry.end)}`, room, 12))}</text>`,
      );
    }
  });

  // Legend: only what appears in the picture.
  const kinds = new Map();
  for (const e of entries) if (e.color && e.label && !kinds.has(e.label)) kinds.set(e.label, e.color);
  const legend = [
    ...(entries.some((e) => !e.color && !e.container) || !entries.length ? [{ label: '固定の予定', fill: FIXED.fill }] : []),
    ...[...kinds].map(([label, fill]) => ({ label, fill })),
    ...(entries.some((e) => e.container) ? [{ label: '週の型', fill: '#F3F4F6', stroke: '#9CA3AF', dash: true }] : []),
    ...(entries.some((e) => e.mark) ? [{ label: '今回の変更', fill: '#FFFFFF', stroke: MARK }] : []),
    ...(entries.some((e) => e.google) || allDay.some((a) => a.google) ? [{ label: 'Google カレンダーにある', google: true }] : []),
  ];
  let lx = GUTTER;
  const ly = top + gridH + 14;
  for (const item of legend) {
    out.push(
      item.google
        ? gMark(lx + 1, ly + 1, 12)
        : `<rect x="${lx}" y="${ly}" width="14" height="14" rx="3" fill="${item.fill}"${item.stroke ? ` stroke="${item.stroke}" stroke-width="${item.dash ? 1 : 3}"${item.dash ? ' stroke-dasharray="3 2"' : ''}` : ''}/>`,
      `<text x="${lx + 20}" y="${ly + 12}" font-size="13" fill="#374151">${esc(item.label)}</text>`,
    );
    lx += 20 + textWidth(item.label, 13) + 22;
  }

  out.push('</svg>');
  return out.join('\n');
}
