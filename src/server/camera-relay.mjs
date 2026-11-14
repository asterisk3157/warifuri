// カメラの中継: the live view of each camera of WARIFURI_CAMERAS, relayed by this server, so that a
// person logged in to the Web screens sees the cameras from anywhere, while the cameras' server
// (go2rtc, on the home network) is reached only by this server.
//
// Under /web/camera/<n>/ (n: the camera's place in WARIFURI_CAMERAS, from 0), and only there:
// - GET stream.html, video-stream.js, video-rtc.js and api/frame.jpeg: the same paths of the
//   camera's server. stream.html opens api/ws relative to itself, so it works from here. Its
//   inline scripts are served as files of their own (inline-<i>.js), so the page needs no
//   inline script: a proxy in front may change inline code, and hashes would then not match.
// - api/ws: the WebSocket of the live view, joined to the camera's server's and passed through
//   both ways, untouched.
// Every other path is 404: the server's config, editor and other streams are not reachable.
//
// Every request needs the Web screens' login (allowed), and a WebSocket also needs to come from
// a page of this server (its Origin), so that a page elsewhere cannot open it in the open mode.
// The query sent on is always src=<the camera's stream>: the browser cannot pick another stream.
// Only the camera's login (WARIFURI_CAMERA_AUTH, as Basic) and what a WebSocket needs are sent
// on; never the person's cookie. Of the answer, only the body is kept: the type is fixed by
// the path, and the headers are this server's own. The live view is framed by カメラ on the same
// origin, so these answers let this origin frame them (and nothing else does).

import http from 'node:http';
import https from 'node:https';

export const CAMERA_FILES = {
  'stream.html': 'text/html; charset=utf-8',
  'video-stream.js': 'text/javascript; charset=utf-8',
  'video-rtc.js': 'text/javascript; charset=utf-8',
  'api/frame.jpeg': 'image/jpeg',
};
const PATH = /^\/web\/camera\/(0|[1-9]\d{0,2})\/(.*)$/;
const INLINE = /^inline-([0-9])\.js$/;
const PAGE_MAX = 256 * 1024;
const TIMEOUT_MS = 10_000;
// The live view of a camera, as カメラ frames it. The stream page reads src and mode from its
// own address (the relay sends the camera's own src on whatever it says). mode: the picture
// comes over the relayed WebSocket (MSE, or JPEG frames where MSE is missing), never WebRTC,
// whose media would go straight to the camera's server and not reach it from outside.
export const cameraView = (n, cam) => `/web/camera/${n}/stream.html?src=${encodeURIComponent(cam.src)}&mode=${encodeURIComponent('mse,mjpeg')}`;

// The policy of a relayed answer. Scripts come only from this server (the page's inline ones
// are files here). Its styles are inline (and the player writes a <style> of its own), so
// styles may be inline. The player plays from a blob: (MSE) and shows JPEG frames as data:.
export function relayCsp() {
  return `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; ` +
    "connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
}

function relayGuard(res, csp = relayCsp()) {
  res.set({
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN',
    // no-transform: a proxy in front (Cloudflare) must not change the page, for example by adding
    // its own script or minifying the inline ones, which would no longer match their hashes.
    'Cache-Control': 'no-store, no-transform',
  });
}

// The stream page made safe to serve here: its links to the internet (icons, a manifest) are
// dropped, and each inline script becomes a script file of this relay (inline-<i>.js), kept
// in scripts (at most 10).
export function relayPage(html) {
  const scripts = [];
  const page = html
    .replace(/<link\b[^>]*\bhref\s*=\s*["']?(?:https?:)?\/\/[^>]*>\s*/gi, '')
    .replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (all, attrs, body) => {
      if (/\bsrc\s*=/i.test(attrs)) return all;
      if (scripts.length >= 10) return '';
      scripts.push(body);
      const mod = /\btype\s*=\s*["']?module/i.test(attrs) ? ' type="module"' : '';
      return `<script${mod} src="./inline-${scripts.length - 1}.js"></script>`;
    });
  // The player writes its way of playing (MSE, RTC) over the picture; that word is not for the
  // person, so it is hidden. Its error line stays.
  const hide = '<style>video-stream .mode { display: none !important; }</style>';
  return { page: /<\/head>/i.test(page) ? page.replace(/<\/head>/i, `${hide}</head>`) : hide + page, scripts };
}

// What カメラ shows when the camera's server cannot be reached. It tries again by itself.
const OFF_PAGE =
  '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<meta http-equiv="refresh" content="30"><title>カメラ</title><link rel="stylesheet" href="/web/app.css"><script src="/web/theme.js"></script></head>' +
  '<body class="wf-cam-off"><p>カメラにつながりません</p></body></html>';

// cameras: from parseCameras. auth: WARIFURI_CAMERA_AUTH (user:password), or null. allowed(req):
// whether the request has the Web screens' login. publicOrigin: the public URL's origin, or null.
// Returns { handle (express middleware for /web/camera), upgrade (the server's 'upgrade'
// listener), close (ends the open WebSockets) }.
export function createCameraRelay({ cameras, auth = null, allowed, publicOrigin = null, timeoutMs = TIMEOUT_MS }) {
  const authorization = auth ? `Basic ${Buffer.from(auth, 'utf8').toString('base64')}` : null;
  const sockets = new Set();

  // The camera and the file of a path, or null.
  const route = (pathname) => {
    const m = PATH.exec(pathname);
    if (!m) return null;
    const cam = cameras[Number(m[1])];
    return cam ? { cam, file: m[2] } : null;
  };
  const target = (cam, file) => {
    const u = new URL(`${cam.url}/${file}`);
    u.search = `src=${encodeURIComponent(cam.src)}`;
    return u;
  };
  const send = (u, headers) =>
    (u.protocol === 'https:' ? https : http).request(u, {
      method: 'GET',
      headers: { ...headers, ...(authorization ? { authorization } : {}) },
      timeout: timeoutMs,
    });

  // GET of a file: the body of the camera's server's answer, or 502.
  const handle = (req, res) => {
    if (!allowed(req)) {
      relayGuard(res);
      res.status(401).type('text').send('login required');
      return;
    }
    const r = route(`/web/camera${req.path}`);
    const inline = r ? INLINE.exec(r.file) : null;
    const type = r && (Object.hasOwn(CAMERA_FILES, r.file) ? CAMERA_FILES[r.file] : inline ? CAMERA_FILES['video-stream.js'] : null);
    if (!type || (req.method !== 'GET' && req.method !== 'HEAD')) {
      relayGuard(res);
      res.status(404).type('text').send('not found');
      return;
    }
    // An inline script of the page is taken from the page.
    const isPage = r.file === 'stream.html' || Boolean(inline);
    const failed = () => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      relayGuard(res);
      if (isPage && !inline) res.status(502).type('html').send(OFF_PAGE);
      else res.status(502).type('text').send('camera unreachable');
    };
    const up = send(target(r.cam, inline ? 'stream.html' : r.file), { accept: req.headers.accept ?? '*/*', 'accept-encoding': 'identity' });
    res.on('close', () => up.destroy());
    up.on('timeout', () => up.destroy(new Error('timed out')));
    up.on('error', failed);
    up.on('response', (ans) => {
      if (ans.statusCode !== 200) {
        ans.resume();
        failed();
        return;
      }
      if (isPage) {
        const parts = [];
        let size = 0;
        ans.on('data', (b) => {
          size += b.length;
          if (size > PAGE_MAX) ans.destroy(new Error('too large'));
          else parts.push(b);
        });
        ans.on('error', failed);
        ans.on('end', () => {
          const { page, scripts } = relayPage(Buffer.concat(parts).toString('utf8'));
          relayGuard(res, relayCsp());
          if (!inline) return void res.status(200).type(type).send(page);
          const body = scripts[Number(inline[1])];
          if (body === undefined) return void res.status(404).type('text').send('not found');
          res.status(200).set('Content-Type', type).send(body);
        });
        return;
      }
      relayGuard(res);
      res.status(200).set('Content-Type', type);
      if (ans.headers['content-length'] && /^\d+$/.test(ans.headers['content-length'])) res.set('Content-Length', ans.headers['content-length']);
      ans.on('error', failed);
      if (req.method === 'HEAD') {
        ans.resume();
        res.end();
      } else ans.pipe(res);
    });
    up.end();
  };

  // An answer on a socket that did not become a WebSocket.
  const refuse = (socket, status, text) => {
    if (!socket.writable) return socket.destroy();
    socket.end(`HTTP/1.1 ${status} ${text}\r\nContent-Type: text/plain\r\nContent-Length: ${text.length}\r\nConnection: close\r\n\r\n${text}`);
    return undefined;
  };
  // The Origin of a page of this server: the public URL's, or this Host's.
  const ownOrigin = (req) => {
    const o = req.headers.origin;
    if (typeof o !== 'string') return false;
    const host = req.headers.host;
    return o === publicOrigin || (typeof host === 'string' && (o === `http://${host}` || o === `https://${host}`));
  };
  const WS_HEADERS = ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol'];
  const BACK_HEADERS = ['sec-websocket-accept', 'sec-websocket-extensions', 'sec-websocket-protocol'];

  // The server's 'upgrade': only api/ws of a camera, with the login, from this server's page.
  const upgrade = (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    let pathname;
    try {
      pathname = new URL(req.url, 'http://x').pathname;
    } catch {
      return refuse(socket, 400, 'Bad Request');
    }
    const r = route(pathname);
    if (!allowed(req)) return refuse(socket, 401, 'Unauthorized');
    if (!r || r.file !== 'api/ws' || String(req.headers.upgrade).toLowerCase() !== 'websocket') return refuse(socket, 404, 'Not Found');
    if (!ownOrigin(req)) return refuse(socket, 403, 'Forbidden');
    const headers = { connection: 'Upgrade', upgrade: 'websocket' };
    for (const h of WS_HEADERS) if (typeof req.headers[h] === 'string') headers[h] = req.headers[h];
    const up = send(target(r.cam, 'api/ws'), headers);
    let joined = false;
    up.on('timeout', () => up.destroy(new Error('timed out')));
    up.on('error', () => {
      if (!joined) refuse(socket, 502, 'Bad Gateway');
    });
    up.on('response', (ans) => {
      ans.resume();
      refuse(socket, 502, 'Bad Gateway');
    });
    up.on('upgrade', (ans, upSocket, upHead) => {
      joined = true;
      upSocket.setTimeout(0);
      if (socket.destroyed) return upSocket.destroy();
      const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade'];
      for (const h of BACK_HEADERS) if (typeof ans.headers[h] === 'string') lines.push(`${h}: ${ans.headers[h]}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upHead?.length) socket.write(upHead);
      if (head?.length) upSocket.write(head);
      sockets.add(socket);
      sockets.add(upSocket);
      const end = () => {
        socket.destroy();
        upSocket.destroy();
        sockets.delete(socket);
        sockets.delete(upSocket);
      };
      for (const s of [socket, upSocket]) {
        s.on('error', end);
        s.on('close', end);
      }
      upSocket.pipe(socket);
      socket.pipe(upSocket);
      return undefined;
    });
    socket.on('close', () => {
      if (!joined) up.destroy();
    });
    up.end();
    return undefined;
  };

  const close = () => {
    for (const s of sockets) s.destroy();
    sockets.clear();
  };

  return { handle, upgrade, close };
}
