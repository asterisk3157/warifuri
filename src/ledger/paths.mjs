// Directory paths of places, compared the way the device that owns them would.
// A place's path belongs to one device, which may run another OS than the server, so the
// style is read from the path itself: a drive letter (C:\ or C:/) or a UNC prefix (\\) is
// Windows, anything else is POSIX. Windows paths compare without regard to case.
// Pure functions: no I/O, and nothing depends on the OS the server runs on.

import path from 'node:path';

const WIN_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/;

// path.win32 or path.posix, chosen from the path's shape.
export function pathStyle(p) {
  return WIN_ABSOLUTE.test(p) ? path.win32 : path.posix;
}

// The path normalized for comparison, or null when it is not absolute in its own style.
export function comparablePath(p) {
  if (typeof p !== 'string' || p === '') return null;
  const style = pathStyle(p);
  if (!style.isAbsolute(p)) return null;
  let out = style.normalize(p);
  if (out.length > style.parse(out).root.length) out = out.replace(/[\\/]+$/, '');
  return style === path.win32 ? out.toLowerCase() : out;
}

// Is dir the same directory as base, or inside it? Both must be absolute and of one style.
export function isSameOrInside(base, dir) {
  const b = comparablePath(base);
  const d = comparablePath(dir);
  if (b === null || d === null) return false;
  const style = pathStyle(base);
  if (style !== pathStyle(dir)) return false;
  const rel = style.relative(b, d);
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith(`..${style.sep}`) && !style.isAbsolute(rel);
}

// Of `candidates` ([{ path, ... }]), the one with the deepest path that is dir or an ancestor
// of it, or null.
export function deepestContaining(candidates, dir) {
  let best = null;
  let bestLength = -1;
  for (const c of candidates) {
    if (!isSameOrInside(c.path, dir)) continue;
    const length = comparablePath(c.path).length;
    if (length > bestLength) {
      best = c;
      bestLength = length;
    }
  }
  return best;
}
