// カメラ: the fixed cameras of WARIFURI_CAMERAS, shown live on the Web screen. Each is
// "name=URL#stream", comma-separated: the URL is where the camera's streaming server (go2rtc)
// answers, as this server reaches it (its origin, with a path when it sits under one; often a
// plain http address on the home network), and the stream is its name there. The browser never
// opens that server: warifuri relays the few files of the live view (camera-relay.mjs).

const NAME_MAX = 40;

// One camera: { name, url, src } (url: the server's base, with no trailing slash), or { error }.
function parseOne(part) {
  const i = part.indexOf('=');
  if (i < 0) return { error: 'must be name=URL#stream' };
  const name = part.slice(0, i).trim();
  const rest = part.slice(i + 1).trim();
  if (!name || name.length > NAME_MAX || /[\u0000-\u001f]/.test(name)) return { error: `must have a name of 1 to ${NAME_MAX} characters` };
  let u;
  try {
    u = new URL(rest);
  } catch {
    return { error: `${name}: is not a URL` };
  }
  // http is fine: the browser does not read it, this server does.
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: `${name}: must start with http:// or https://` };
  if (u.search || u.username || u.password) return { error: `${name}: must be a plain URL, with no query or login (the login is WARIFURI_CAMERA_AUTH)` };
  let src;
  try {
    src = decodeURIComponent(u.hash.slice(1)).trim();
  } catch {
    src = '';
  }
  if (!src) return { error: `${name}: must end with #stream, the name of the stream` };
  return { name, url: `${u.origin}${u.pathname.replace(/\/+$/, '')}`, src };
}

// The cameras of a WARIFURI_CAMERAS value: { cameras, error }. An empty value is no cameras.
export function parseCameras(text) {
  const cameras = [];
  for (const part of String(text ?? '').split(',')) {
    if (!part.trim()) continue;
    const c = parseOne(part.trim());
    if (c.error) return { cameras: [], error: c.error };
    if (cameras.some((x) => x.name === c.name)) return { cameras: [], error: `${c.name}: the same name is given twice` };
    cameras.push(c);
  }
  return { cameras, error: null };
}

// What is wrong with a WARIFURI_CAMERA_AUTH value (user:password), or null.
export function checkCameraAuth(v) {
  if (v.indexOf(':') <= 0) return 'must be user:password';
  return /[\u0000-\u001f\u007f]/.test(v) ? 'must have no control characters' : null;
}
