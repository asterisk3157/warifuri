import test from 'node:test';
import assert from 'node:assert/strict';
import { weekData, renderWeek, assignLanes } from '../src/calendar/weekview.mjs';
import { svgToPng } from '../src/calendar/image.mjs';

const b = (id, title, s, e, more = {}) => ({ id, title, kind: 'fixed', starts_at: new Date(s).toISOString(), ends_at: new Date(e).toISOString(), ...more });

test('weekData: the days, bookings cut to each day, all-day ones apart, colours and marks', () => {
  const from = new Date(2026, 10, 12);
  const to = new Date(2026, 10, 15);
  const out = weekData({
    from: from.toISOString(), to: to.toISOString(), colors: { 研究: '#a9a3ec' }, marks: ['b2'],
    bookings: [
      b('b1', 'ゼミ', new Date(2026, 10, 12, 10), new Date(2026, 10, 12, 12)),
      b('b2', '作業', new Date(2026, 10, 13, 23), new Date(2026, 10, 14, 1), { kind: 'task', profile: '研究' }),
      b('b3', '旅行', new Date(2026, 10, 14), new Date(2026, 10, 15)),
    ],
  });
  assert.deepEqual(out.dates, ['2026-11-12', '2026-11-13', '2026-11-14']);
  assert.deepEqual(out.allDay, [{ date: '2026-11-14', title: '旅行' }]);
  assert.deepEqual(out.entries.map((e) => [e.date, e.start, e.end, e.title, e.color, e.mark]), [
    ['2026-11-12', '10:00', '12:00', 'ゼミ', null, false],
    ['2026-11-13', '23:00', '24:00', '作業', '#a9a3ec', true],
    ['2026-11-14', '00:00', '01:00', '作業', '#a9a3ec', true],
  ]);
});

test('renderWeek: today tinted, titles escaped, the legend has only what is drawn', () => {
  const svg = renderWeek({
    dates: ['2026-11-12', '2026-11-13'], today: '2026-11-13',
    entries: [{ date: '2026-11-13', start: '18:00', end: '21:00', title: '<定例>', color: null, mark: true }],
  });
  assert.match(svg, /^<svg /);
  assert.match(svg, /11\/13\(金\) 今日/);
  assert.match(svg, /&lt;定例&gt;/);
  assert.ok(!svg.includes('<定例>'));
  assert.match(svg, /固定の予定/);
  assert.match(svg, /今回の変更/);
  assert.ok(!svg.includes('習慣'));
});

test('assignLanes: overlapping entries share the column', () => {
  const lanes = assignLanes([{ s: 600, e: 720 }, { s: 660, e: 780 }, { s: 800, e: 860 }]);
  assert.deepEqual(lanes.map((e) => [e.lane, e.lanes]), [[0, 2], [1, 2], [0, 1]]);
});

test('svgToPng: null when the converter is missing', async () => {
  assert.equal(await svgToPng('<svg/>', { command: 'no-such-rsvg-convert-here' }), null);
});
