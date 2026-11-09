// The calendar as a picture: SVG from weekview.mjs, and a PNG of it for places that do not
// show SVG (Discord). The PNG needs rsvg-convert (librsvg) on this machine; without it there
// is no PNG, and the caller goes without the picture.

import { spawn } from 'node:child_process';
import { renderWeek, weekData } from './weekview.mjs';

const pad2 = (n) => String(n).padStart(2, '0');

// The SVG of { from, to, marks } with the bookings of ledger.schedule as they are now.
// colorsOf: the profile names → { name: '#rrggbb' }.
export function calendarSvg(ledger, { from, to, marks = [] }, { colorsOf = () => ({}), now = new Date() } = {}) {
  const { bookings } = ledger.schedule({ from, to });
  const data = weekData({ from, to, bookings, colors: colorsOf(bookings.map((b) => b.profile)), marks });
  const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  return renderWeek({ ...data, today });
}

// The PNG of an SVG (1600 pixels wide), or null when rsvg-convert is missing or fails.
export function svgToPng(svg, { command = 'rsvg-convert', spawnFn = spawn, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(command, ['--width', '1600', '--background-color', 'white', '--format', 'png'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    const chunks = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && chunks.length ? Buffer.concat(chunks) : null);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(svg);
  });
}
