// カメラ (src/server/cameras.mjs, src/server/camera-relay.mjs and the Web screens): reading
// WARIFURI_CAMERAS and WARIFURI_CAMERA_AUTH, the page and its read only when cameras are set,
// and the relay of the live view against a fake camera server: the login it needs (a device
// key, a guest's or not, is not one), the camera's login it adds, the stream it fixes, the
// paths it refuses, the WebSocket passed through both ways, and the policy of its answers.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { openLedger } from '../src/ledger/ledger.mjs';
import { createServer } from '../src/server/mcp.mjs';
import { pageCsp } from '../src/server/web.mjs';
import { parseCameras, checkCameraAuth } from '../src/server/cameras.mjs';
import { relayCsp, relayPage } from '../src/server/camera-relay.mjs';
import { SETTINGS } from '../src/config.mjs';

const W = { actor: 'cli', device: 'cli' };
const AUTH = 'viewer:pa:ss';
const BASIC = `Basic ${Buffer.from(AUTH).toString('base64')}`;
const INLINE = "\n    const params = new URLSearchParams(location.search);\n    document.title = params.get('src');\n";
const STREAM_HTML =
  '<!DOCTYPE html><html><head><link rel="icon" href="https://camera.example.org/favicon.ico"><style>body { margin: 0; }</style></head>' +
  `<body><script type="module" src="./video-stream.js"></script><script type="module">${INLINE}</script></body></html>`;

test('parseCameras reads name=URL#stream, comma-separated, http included', () => {
  const { cameras, error } = parseCameras(' 部屋=http://192.0.2.10:1984#room , 玄関=https://camera.example.org/go2rtc/#door%201,');
  assert.equal(error, null);
  assert.deepEqual(cameras, [
    { name: '部屋', url: 'http://192.0.2.10:1984', src: 'room' },
    { name: '玄関', url: 'https://camera.example.org/go2rtc', src: 'door 1' },
  ]);
  assert.deepEqual(parseCameras(''), { cameras: [], error: null });
  assert.deepEqual(parseCameras(undefined), { cameras: [], error: null });
});

test('parseCameras and the camera login refuse what they cannot use', () => {
  for (const bad of [
    'http://192.0.2.10:1984#room',
    '=http://192.0.2.10:1984#room',
    'a=not a url#room',
    'a=ftp://192.0.2.10#room',
    'a=http://192.0.2.10:1984',
    'a=http://192.0.2.10:1984/?x=1#room',
    'a=http://user:pw@192.0.2.10:1984#room',
    'a=http://192.0.2.10:1984#room,a=http://192.0.2.11:1984#hall',
    `${'x'.repeat(41)}=http://192.0.2.10:1984#room`,
  ]) {
    const r = parseCameras(bad);
    assert.ok(r.error, bad);
    assert.deepEqual(r.cameras, [], bad);
  }
  const setting = SETTINGS.find((s) => s.name === 'WARIFURI_CAMERAS');
  assert.ok(setting.commands.includes('serve'));
  assert.equal(setting.check('部屋=http://192.0.2.10:1984#room'), null);
  assert.ok(setting.check('部屋=http://192.0.2.10:1984'));
  const auth = SETTINGS.find((s) => s.name === 'WARIFURI_CAMERA_AUTH');
  assert.equal(auth.secret, true);
  assert.ok(auth.commands.includes('serve'));
  assert.equal(checkCameraAuth('viewer:pa:ss'), null);
  for (const bad of ['viewer', ':pw', 'a:b\nc']) assert.ok(checkCameraAuth(bad), bad);
});

test('pageCsp frames only this origin, and only with cameras', () => {
  const plain = pageCsp();
  assert.doesNotMatch(plain, /frame-src/);
  assert.match(plain, /default-src 'none'/);
  assert.match(plain, /img-src 'self' data:;/);
  assert.match(plain, /connect-src 'self';/);
  const cam = pageCsp(true);
  assert.match(cam, /frame-src 'self';/);
  assert.match(cam, /script-src 'self';/);
  assert.match(cam, /img-src 'self' data:;/);
  assert.match(cam, /frame-ancestors 'none'/);
});

test('relayPage drops links to the internet and serves the inline scripts as files', () => {
  const { page, scripts } = relayPage(STREAM_HTML);
  assert.doesNotMatch(page, /camera\.example\.org/);
  assert.match(page, /video-stream\.js/);
  assert.deepEqual(scripts, [INLINE]);
  assert.match(page, /<script type="module" src="\.\/inline-0\.js"><\/script>/);
  assert.ok(!page.includes(INLINE));
  const csp = relayCsp();
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.doesNotMatch(csp, /unsafe-eval|sha256/);
});

// A fake camera server: Basic auth, the files, and a WebSocket at api/ws that greets and echoes.
// seen: the requests it took ({ path, headers }).
async function fakeCamera(t) {
  const seen = [];
  const upgraded = new Set();
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url, headers: req.headers });
    if (req.headers.authorization !== BASIC) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="go2rtc"' }).end();
      return;
    }
    const p = new URL(req.url, 'http://x').pathname;
    const set = { 'Set-Cookie': 'camera=1', 'Access-Control-Allow-Origin': '*', 'X-Camera': 'yes' };
    if (p === '/stream.html') res.writeHead(200, { ...set, 'Content-Type': 'text/html' }).end(STREAM_HTML);
    else if (p === '/video-stream.js') res.writeHead(200, { ...set, 'Content-Type': 'application/javascript' }).end('export const a = 1;');
    else if (p === '/video-rtc.js') res.writeHead(200, { ...set, 'Content-Type': 'application/javascript' }).end('export const b = 2;');
    else if (p === '/api/frame.jpeg') res.writeHead(200, { ...set, 'Content-Type': 'image/jpeg' }).end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    else if (p === '/api/config') res.writeHead(200, { 'Content-Type': 'text/plain' }).end('secret-config');
    else res.writeHead(404).end();
  });
  server.on('upgrade', (req, socket) => {
    upgraded.add(socket);
    seen.push({ path: req.url, headers: req.headers, ws: true });
    if (req.headers.authorization !== BASIC) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nX-Camera: yes\r\n\r\n`);
    const frame = (text) => {
      const b = Buffer.from(text);
      return Buffer.concat([Buffer.from([0x81, b.length]), b]);
    };
    socket.write(frame(`hello ${new URL(req.url, 'http://x').searchParams.get('src')}`));
    socket.on('data', (d) => {
      // One small masked text frame from the client.
      if ((d[0] & 0x0f) !== 1) return;
      const len = d[1] & 0x7f;
      const mask = d.subarray(2, 6);
      const body = Buffer.from(d.subarray(6, 6 + len).map((x, i) => x ^ mask[i % 4]));
      socket.write(frame(`echo ${body}`));
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    // A WebSocket is no longer the server's connection: it is ended here.
    for (const s of upgraded) s.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

// warifuri in the login mode, with the cameras given, and a guest's device key.
async function start(t, cameras, { cameraAuth = AUTH } = {}) {
  const ledger = openLedger(':memory:');
  ledger.addDevice('muse', W);
  ledger.setDeviceScope('muse', {}, W);
  const guestKey = ledger.issueKey('muse', W).key;
  const agentKey = ledger.issueKey('laptop', W).key;
  const server = createServer({ ledger, cameras, cameraAuth, publicUrl: 'https://warifuri.example.org' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    ledger.close();
  });
  const res = await fetch(`${base}/web/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ token: server.web.issueLogin() }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return { base, cookie, guestKey, agentKey };
}

// A WebSocket to warifuri: resolves to { messages, ws } once it opens, or rejects when refused.
function openWs(url, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const messages = [];
    ws.onmessage = (ev) => messages.push(String(ev.data));
    ws.onopen = () => resolve({ ws, messages });
    ws.onerror = () => reject(new Error('refused'));
  });
}
const until = async (fn) => {
  for (let i = 0; i < 100 && !fn(); i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.ok(fn());
};

test('with no cameras, there is no カメラ and no relay', async (t) => {
  const { base, cookie } = await start(t, []);
  assert.equal((await fetch(`${base}/camera`, { headers: { cookie } })).status, 404);
  assert.equal((await fetch(`${base}/web/api/cameras`, { headers: { cookie } })).status, 404);
  assert.equal((await (await fetch(`${base}/web/api/about`, { headers: { cookie } })).json()).cameras, false);
  assert.equal((await fetch(`${base}/web/camera/0/stream.html`, { headers: { cookie } })).status, 404);
  const page = await fetch(`${base}/calendar`, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-security-policy'), pageCsp());
});

test('with cameras, カメラ lists the relayed views and the pages may frame this origin', async (t) => {
  const { cameras } = parseCameras('部屋=http://192.0.2.10:1984#room,玄関=http://192.0.2.11:1984#door 1');
  const { base, cookie } = await start(t, cameras);
  assert.equal((await (await fetch(`${base}/web/api/about`, { headers: { cookie } })).json()).cameras, true);
  const list = await (await fetch(`${base}/web/api/cameras`, { headers: { cookie } })).json();
  assert.deepEqual(list, {
    cameras: [
      { name: '部屋', stream: '/web/camera/0/stream.html?src=room&mode=mse%2Cmjpeg' },
      { name: '玄関', stream: '/web/camera/1/stream.html?src=door%201&mode=mse%2Cmjpeg' },
    ],
  });
  assert.doesNotMatch(JSON.stringify(list), /192\.0\.2/);
  const page = await fetch(`${base}/camera`, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-security-policy'), pageCsp(true));
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal((await fetch(`${base}/tasks`, { headers: { cookie } })).headers.get('content-security-policy'), pageCsp(true));
  assert.equal((await fetch(`${base}/camera`)).status, 401);
  assert.equal((await fetch(`${base}/web/api/cameras`)).status, 401);
});

test('the relay needs the login, adds the camera login, fixes the stream and keeps only the body', async (t) => {
  const cam = await fakeCamera(t);
  const { cameras } = parseCameras(`部屋=${cam.url}#room`);
  const { base, cookie, guestKey, agentKey } = await start(t, cameras);

  // No login, or a device key (a guest's or an agent's), is refused before the camera is asked.
  assert.equal((await fetch(`${base}/web/camera/0/stream.html?src=room`)).status, 401);
  assert.equal((await fetch(`${base}/web/camera/0/api/frame.jpeg`, { headers: { authorization: `Bearer ${guestKey}` } })).status, 401);
  assert.equal((await fetch(`${base}/web/camera/0/video-rtc.js`, { headers: { authorization: `Bearer ${agentKey}` } })).status, 401);
  assert.equal(cam.seen.length, 0);

  const page = await fetch(`${base}/web/camera/0/stream.html?src=other&mode=webrtc`, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  const html = await page.text();
  assert.match(html, /video-stream\.js/);
  assert.doesNotMatch(html, /camera\.example\.org/);
  const csp = page.headers.get('content-security-policy');
  assert.equal(csp, relayCsp());
  const inl = await fetch(`${base}/web/camera/0/inline-0.js`, { headers: { cookie } });
  assert.equal(inl.status, 200);
  assert.equal(inl.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(await inl.text(), INLINE);
  assert.equal((await fetch(`${base}/web/camera/0/inline-5.js`, { headers: { cookie } })).status, 404);
  assert.equal((await fetch(`${base}/web/camera/0/inline-0.js`)).status, 401);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  // The camera's own headers stay behind.
  for (const h of ['set-cookie', 'access-control-allow-origin', 'x-camera']) assert.equal(page.headers.get(h), null, h);

  const asked = cam.seen.at(-1);
  assert.equal(asked.path, '/stream.html?src=room');
  assert.equal(asked.headers.authorization, BASIC);
  assert.equal(asked.headers.cookie, undefined);

  const js = await fetch(`${base}/web/camera/0/video-rtc.js`, { headers: { cookie } });
  assert.equal(js.status, 200);
  assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(await js.text(), 'export const b = 2;');
  assert.equal((await fetch(`${base}/web/camera/0/video-stream.js`, { headers: { cookie } })).status, 200);
  const jpeg = await fetch(`${base}/web/camera/0/api/frame.jpeg?src=../api/config`, { headers: { cookie } });
  assert.equal(jpeg.status, 200);
  assert.equal(jpeg.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await jpeg.arrayBuffer())], [0xff, 0xd8, 0xff, 0xd9]);
  assert.equal(cam.seen.at(-1).path, '/api/frame.jpeg?src=room');

  // Nothing else of the camera's server, nor another camera, is reachable.
  const before = cam.seen.length;
  for (const p of ['api/config', 'editor.html', 'api/streams', 'api/ws', '../api/config', '%2e%2e/api/config', 'stream.html/x', 'index.html']) {
    assert.equal((await fetch(`${base}/web/camera/0/${p}`, { headers: { cookie } })).status, 404, p);
  }
  assert.equal((await fetch(`${base}/web/camera/1/stream.html`, { headers: { cookie } })).status, 404);
  assert.equal((await fetch(`${base}/web/camera/00/stream.html`, { headers: { cookie } })).status, 404);
  assert.equal((await fetch(`${base}/web/camera/0/stream.html`, { method: 'POST', headers: { cookie } })).status, 404);
  assert.equal(cam.seen.length, before);
});

test('the relay says when the camera cannot be reached, or refuses its login', async (t) => {
  const cam = await fakeCamera(t);
  const { cameras } = parseCameras(`部屋=${cam.url}#room,外=http://127.0.0.1:9#gone`);
  const { base, cookie } = await start(t, cameras, { cameraAuth: 'viewer:wrong' });
  for (const n of [0, 1]) {
    const page = await fetch(`${base}/web/camera/${n}/stream.html?src=room`, { headers: { cookie } });
    assert.equal(page.status, 502);
    assert.match(await page.text(), /カメラにつながりません/);
    assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal((await fetch(`${base}/web/camera/${n}/api/frame.jpeg`, { headers: { cookie } })).status, 502);
  }
});

test('the WebSocket is relayed both ways, with the camera login and the fixed stream', async (t) => {
  const cam = await fakeCamera(t);
  const { cameras } = parseCameras(`部屋=${cam.url}#room`);
  const { base, cookie, guestKey } = await start(t, cameras);
  const ws = `${base.replace('http', 'ws')}/web/camera/0/api/ws?src=other`;

  // Refused: no login, a guest's key, another site's page, another path.
  await assert.rejects(openWs(ws, { origin: base }));
  await assert.rejects(openWs(ws, { origin: base, authorization: `Bearer ${guestKey}` }));
  await assert.rejects(openWs(ws, { origin: 'https://elsewhere.example.org', cookie }));
  await assert.rejects(openWs(`${base.replace('http', 'ws')}/web/camera/0/stream.html`, { origin: base, cookie }));
  await assert.rejects(openWs(`${base.replace('http', 'ws')}/web/camera/1/api/ws`, { origin: base, cookie }));
  await assert.rejects(openWs(`${base.replace('http', 'ws')}/mcp`, { origin: base, cookie }));
  assert.equal(cam.seen.filter((s) => s.ws).length, 0);

  const { ws: sock, messages } = await openWs(ws, { origin: base, cookie });
  await until(() => messages.length === 1);
  assert.equal(messages[0], 'hello room');
  sock.send('{"type":"mse"}');
  await until(() => messages.length === 2);
  assert.equal(messages[1], 'echo {"type":"mse"}');
  const asked = cam.seen.find((s) => s.ws);
  assert.equal(asked.path, '/api/ws?src=room');
  assert.equal(asked.headers.authorization, BASIC);
  assert.equal(asked.headers.cookie, undefined);
  assert.equal(asked.headers.origin, undefined);
  sock.close();

  // The public URL's origin is this server's too.
  const again = await openWs(ws, { origin: 'https://warifuri.example.org', cookie });
  await until(() => again.messages.length === 1);
  again.ws.close();
});
