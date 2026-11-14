// カメラ: the fixed cameras of WARIFURI_CAMERAS, shown live on the Web screen. Each is
// "name=URL#stream", comma-separated: the URL is where the camera's streaming server answers
// (its origin, with a path when it sits under one), and the stream is its name there. The
// browser reads the pictures straight from that server; warifuri neither relays nor keeps them.

const NAME_MAX = 40;

// One camera: { name, origin, stream, frame }, or { error }.
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
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: `${name}: must start with http:// or https://` };
  if (u.search || u.username || u.password) return { error: `${name}: must be a plain URL, with no query or login` };
  let src;
  try {
    src = decodeURIComponent(u.hash.slice(1)).trim();
  } catch {
    src = '';
  }
  if (!src) return { error: `${name}: must end with #stream, the name of the stream` };
  const base = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  const q = `src=${encodeURIComponent(src)}`;
  return { name, origin: u.origin, stream: `${base}/stream.html?${q}`, frame: `${base}/api/frame.jpeg?${q}` };
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

// The origins the camera page may load frames and pictures from.
export const cameraOrigins = (cameras) => [...new Set((cameras ?? []).map((c) => c.origin))];
