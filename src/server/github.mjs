// The door for GitHub's webhook: POST /api/github/webhook. GitHub tells warifuri when a pull
// request or an issue changes; warifuri keeps a copy (src/ledger/github.mjs) and never writes
// back to GitHub.
//
// Who may send: whoever signs the body with the webhook's secret (WARIFURI_GITHUB_WEBHOOK_SECRET).
// The X-Hub-Signature-256 header is the HMAC-SHA256 of the raw bytes of the body; it is
// compared in constant time before the body is read as JSON. No device key is taken here.
// With no secret set the door is closed: every request gets 404.
//
// What it answers: ping → 200; a pull_request or issues event of an owner the settings say to
// read → 200 after the copy is written; everything else (another event, an owner not read,
// a payload it cannot keep) → 204 with nothing stored. Nothing of the body is echoed or logged.

import { createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { rateLimit } from './limit.mjs';
import { takeGithubEvent } from '../ledger/github.mjs';

// A pull request's payload is some tens of kilobytes; GitHub itself stops at 25 MB.
export const GITHUB_BODY_MAX = 1024 * 1024;

// Whether header is the signature of body under secret.
export function signedBy(secret, body, header) {
  if (typeof header !== 'string' || !Buffer.isBuffer(body)) return false;
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`, 'utf8');
  const got = Buffer.from(header.trim(), 'utf8');
  return got.length === want.length && timingSafeEqual(got, want);
}

// The router to mount at /api/github/webhook. secret: the webhook's secret, or nothing to
// keep the door closed. limit: the rate limit per address.
export function githubWebhook({ ledger, secret, limit = { max: 300, windowMs: 60_000 } }) {
  const router = express.Router();
  router.use(rateLimit(limit));
  if (typeof secret === 'string' && secret !== '') {
    router.post('/', express.raw({ type: () => true, limit: GITHUB_BODY_MAX }), (req, res) => {
      if (!signedBy(secret, req.body, req.headers['x-hub-signature-256'])) {
        res.status(401).json({ error: 'bad signature' });
        return;
      }
      const event = req.headers['x-github-event'];
      if (event === 'ping') {
        res.json({ ok: true });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(req.body.toString('utf8'));
      } catch {
        res.status(400).json({ error: 'bad json' });
        return;
      }
      const did = takeGithubEvent(ledger, event, payload);
      if (did === 'stored' || did === 'removed') {
        res.json({ ok: true });
        return;
      }
      res.status(204).end();
    });
  }
  router.use((req, res) => res.status(404).json({ error: 'not found' }));
  // A body over the limit is the sender's mistake; nothing else is said.
  router.use((err, req, res, next) => {
    if (err.type !== 'entity.too.large') return next(err);
    return res.status(413).json({ error: 'too large' });
  });
  return router;
}
