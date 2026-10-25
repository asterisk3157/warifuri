// Rate limits for the HTTP routes (/api, the Web screens).

// A fixed window per caller's address: at most `max` requests in each `windowMs`. Windows
// that have ended are swept when many addresses are kept.
export function rateLimit({ max, windowMs, now = Date.now }) {
  const hits = new Map();
  return (req, res, next) => {
    const t = now();
    if (hits.size > 10_000) for (const [k, h] of hits) if (h.reset <= t) hits.delete(k);
    let h = hits.get(req.ip);
    if (!h || h.reset <= t) {
      h = { count: 0, reset: t + windowMs };
      hits.set(req.ip, h);
    }
    h.count += 1;
    if (h.count > max) {
      res.status(429).set('Retry-After', String(Math.ceil((h.reset - t) / 1000))).json({ error: 'too many requests' });
      return;
    }
    next();
  };
}
