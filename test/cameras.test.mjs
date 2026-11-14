// カメラ (src/server/cameras.mjs and the Web screens): reading WARIFURI_CAMERAS, the setting's
// check, the page and its read only when cameras are set, and the page's policy letting in the
// cameras' origins and nothing more.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openLedger } from '../src/ledger/ledger.mjs';
import { createServer } from '../src/server/mcp.mjs';
import { pageCsp } from '../src/server/web.mjs';
import { parseCameras, cameraOrigins } from '../src/server/cameras.mjs';
import { SETTINGS } from '../src/config.mjs';

test('parseCameras reads name=URL#stream, comma-separated', () => {
  const { cameras, error } = parseCameras(' 部屋=https://camera.example.ts.net#room , 玄関=http://100.64.0.2:1984/go2rtc/#door%201,');
  assert.equal(error, null);
  assert.deepEqual(cameras, [
    { name: '部屋', origin: 'https://camera.example.ts.net', stream: 'https://camera.example.ts.net/stream.html?src=room', frame: 'https://camera.example.ts.net/api/frame.jpeg?src=room' },
    { name: '玄関', origin: 'http://100.64.0.2:1984', stream: 'http://100.64.0.2:1984/go2rtc/stream.html?src=door%201', frame: 'http://100.64.0.2:1984/go2rtc/api/frame.jpeg?src=door%201' },
  ]);
  assert.deepEqual(cameraOrigins(cameras), ['https://camera.example.ts.net', 'http://100.64.0.2:1984']);
  assert.deepEqual(parseCameras(''), { cameras: [], error: null });
  assert.deepEqual(parseCameras(undefined), { cameras: [], error: null });
});

test('parseCameras refuses what it cannot use', () => {
  for (const bad of [
    'https://camera.example.ts.net#room',
    '=https://camera.example.ts.net#room',
    'a=not a url#room',
    'a=ftp://camera.example.ts.net#room',
    'a=https://camera.example.ts.net',
    'a=https://camera.example.ts.net/?x=1#room',
    'a=https://user:pw@camera.example.ts.net#room',
    'a=https://camera.example.ts.net#room,a=https://camera.example.ts.net#hall',
    `${'x'.repeat(41)}=https://camera.example.ts.net#room`,
  ]) {
    const r = parseCameras(bad);
    assert.ok(r.error, bad);
    assert.deepEqual(r.cameras, [], bad);
  }
  const setting = SETTINGS.find((s) => s.name === 'WARIFURI_CAMERAS');
  assert.ok(setting.commands.includes('serve'));
  assert.equal(setting.check('部屋=https://camera.example.ts.net#room'), null);
  assert.ok(setting.check('部屋=https://camera.example.ts.net'));
});

test('pageCsp lets in only the given origins, for pictures and frames', () => {
  const plain = pageCsp();
  assert.match(plain, /img-src 'self' data:;/);
  assert.doesNotMatch(plain, /frame-src/);
  assert.match(plain, /default-src 'none'/);
  const cam = pageCsp(['https://camera.example.ts.net']);
  assert.match(cam, /img-src 'self' data: https:\/\/camera\.example\.ts\.net;/);
  assert.match(cam, /frame-src https:\/\/camera\.example\.ts\.net;/);
  assert.match(cam, /connect-src 'self';/);
  assert.match(cam, /script-src 'self';/);
  assert.match(cam, /frame-ancestors 'none'/);
});

async function start(t, cameras) {
  const ledger = openLedger(':memory:');
  const server = createServer({ ledger, ...(cameras ? { cameras } : {}) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    ledger.close();
  });
  return base;
}

test('with no cameras, there is no カメラ', async (t) => {
  const base = await start(t);
  assert.equal((await fetch(`${base}/camera`)).status, 404);
  assert.equal((await fetch(`${base}/web/api/cameras`)).status, 404);
  assert.equal((await (await fetch(`${base}/web/api/about`)).json()).cameras, false);
  // The other pages keep the plain policy.
  const page = await fetch(`${base}/calendar`);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.headers.get('content-security-policy'), /frame-src|ts\.net/);
});

test('with cameras, カメラ is shown with its origins let in', async (t) => {
  const { cameras } = parseCameras('部屋=https://camera.example.ts.net#room,玄関=https://door.example.ts.net#door');
  const base = await start(t, cameras);
  assert.equal((await (await fetch(`${base}/web/api/about`)).json()).cameras, true);
  const list = await (await fetch(`${base}/web/api/cameras`)).json();
  assert.deepEqual(list, {
    cameras: [
      { name: '部屋', stream: 'https://camera.example.ts.net/stream.html?src=room', frame: 'https://camera.example.ts.net/api/frame.jpeg?src=room' },
      { name: '玄関', stream: 'https://door.example.ts.net/stream.html?src=door', frame: 'https://door.example.ts.net/api/frame.jpeg?src=door' },
    ],
  });
  const page = await fetch(`${base}/camera`);
  assert.equal(page.status, 200);
  const csp = page.headers.get('content-security-policy');
  assert.equal(csp, pageCsp(['https://camera.example.ts.net', 'https://door.example.ts.net']));
  assert.match(csp, /frame-src https:\/\/camera\.example\.ts\.net https:\/\/door\.example\.ts\.net;/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  // Every page lets them in: moving to カメラ from another tab keeps that page's policy.
  assert.equal((await fetch(`${base}/tasks`)).headers.get('content-security-policy'), csp);
  // The API does not.
  assert.doesNotMatch((await fetch(`${base}/web/api/cameras`)).headers.get('content-security-policy'), /ts\.net/);
});

test('カメラ needs the login like the other pages', async (t) => {
  const { cameras } = parseCameras('部屋=https://camera.example.ts.net#room');
  const ledger = openLedger(':memory:');
  const server = createServer({ ledger, cameras, publicUrl: 'https://warifuri.example.org' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    ledger.close();
  });
  assert.equal((await fetch(`${base}/camera`)).status, 401);
  assert.equal((await fetch(`${base}/web/api/cameras`)).status, 401);
});
