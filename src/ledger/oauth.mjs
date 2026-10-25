// The ledger's side of OAuth: registered clients, authorization requests waiting for the
// GitHub login and the consent page, single-use codes, access and refresh tokens, and the
// GitHub id pinned for the person allowed to log in.
// It knows nothing of HTTP; src/server/oauth.mjs speaks the protocol and calls these.
//
// Every value that works as a credential is random (32 bytes, base64url) and is returned
// to the caller once; only its sha256 hash is stored. Records (entity 'oauth', entity_id the
// client id) say what happened and to which device, never a token, code or hash.

import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';

export const PENDING_MS = 10 * 60 * 1000;
export const CODE_MS = 10 * 60 * 1000;
export const ACCESS_MS = 60 * 60 * 1000;
export const REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
// A grant (a family of tokens) ends this long after its code was exchanged, however often
// it is refreshed; then the person logs in again.
export const FAMILY_MS = 90 * 24 * 60 * 60 * 1000;

const PREFIX = { access: 'wfa_', refresh: 'wfr_', code: 'wfc_' };
const MACHINE = { actor: 'oauth' };

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const random = (prefix = '') => `${prefix}${randomBytes(32).toString('base64url')}`;

// Compares a value with a stored hash without leaking where they differ.
function matchesHash(value, hash) {
  if (typeof value !== 'string' || value === '' || typeof hash !== 'string') return false;
  const a = Buffer.from(sha256(value), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// `ctx` is what openLedger shares with this module: the database, its helpers and the clock.
export function oauthStore({ db, one, all, transaction, record, now }) {
  const nowMs = () => now().getTime();
  const iso = (ms) => new Date(ms).toISOString();
  const expired = (row) => Date.parse(row.expires_at) <= nowMs();

  function sweep() {
    const t = iso(nowMs());
    db.prepare('DELETE FROM oauth_pending WHERE expires_at <= ?').run(t);
    db.prepare('DELETE FROM oauth_codes WHERE expires_at <= ?').run(t);
  }

  // Clients. `info` is the registration as the SDK checked it, with client_id; any secret is
  // dropped, so every client is public and proves itself with PKCE.
  function registerClient(info) {
    const { client_secret: _s, client_secret_expires_at: _e, ...rest } = info;
    const client = { ...rest, client_id: rest.client_id ?? randomUUID(), token_endpoint_auth_method: 'none' };
    return transaction(() => {
      db.prepare('INSERT INTO oauth_clients (client_id, metadata, created_at) VALUES (?, ?, ?)').run(
        client.client_id,
        JSON.stringify(client),
        iso(nowMs()),
      );
      record({ ...MACHINE, device: null }, 'oauth', client.client_id, 'register', {
        client_name: client.client_name ?? null,
        redirect_uris: client.redirect_uris,
      });
      return client;
    });
  }

  function getClient(clientId) {
    if (typeof clientId !== 'string') return undefined;
    const row = one('SELECT metadata FROM oauth_clients WHERE client_id = ?', clientId);
    return row ? JSON.parse(row.metadata) : undefined;
  }

  // Each client with the devices its live tokens are bound to.
  function listClients() {
    const t = iso(nowMs());
    return all('SELECT client_id, metadata, created_at FROM oauth_clients ORDER BY created_at, client_id').map((r) => {
      const meta = JSON.parse(r.metadata);
      const live = all(
        'SELECT DISTINCT device FROM oauth_tokens WHERE client_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY device',
        r.client_id,
        t,
      ).map((x) => x.device);
      return { client_id: r.client_id, client_name: meta.client_name ?? null, redirect_uris: meta.redirect_uris, created_at: r.created_at, devices: live };
    });
  }

  // For each app and device that ever got a token: when the newest token was issued
  // (last_at) and whether one is still live. Never a token or its hash.
  function tokenActivity() {
    return all(
      'SELECT client_id, device, max(created_at) AS last_at, ' +
        'max(CASE WHEN revoked_at IS NULL AND expires_at > ? THEN 1 ELSE 0 END) AS live ' +
        'FROM oauth_tokens GROUP BY client_id, device ORDER BY client_id, device',
      iso(nowMs()),
    ).map((r) => ({ client_id: r.client_id, device: r.device, last_at: r.last_at, live: r.live === 1 }));
  }

  // Authorization requests. createPending returns the pending id (for the browser's cookie)
  // and the state to send to GitHub; both are shown here only.
  function createPending({ clientId, redirectUri, codeChallenge, scopes, state }) {
    const id = random();
    const githubState = random();
    const t = nowMs();
    transaction(() => {
      sweep();
      db.prepare(
        'INSERT INTO oauth_pending (id_hash, client_id, redirect_uri, code_challenge, scopes, state, github_state_hash, created_at, expires_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(sha256(id), clientId, redirectUri, codeChallenge, JSON.stringify(scopes ?? []), state ?? null, sha256(githubState), iso(t), iso(t + PENDING_MS));
    });
    return { id, githubState };
  }

  const pendingView = (row) => ({
    client_id: row.client_id,
    redirect_uri: row.redirect_uri,
    scopes: JSON.parse(row.scopes),
    state: row.state,
    github_login: row.github_login,
  });

  function pendingRow(id) {
    if (typeof id !== 'string' || id === '') return null;
    const row = one('SELECT * FROM oauth_pending WHERE id_hash = ?', sha256(id));
    if (!row) return null;
    if (expired(row)) {
      db.prepare('DELETE FROM oauth_pending WHERE id_hash = ?').run(row.id_hash);
      return null;
    }
    return row;
  }

  // The pending request, or null when it is unknown or has expired.
  function getPending(id) {
    const row = pendingRow(id);
    return row ? pendingView(row) : null;
  }

  // Checks GitHub's returned state against the pending request and uses it up, so the same
  // callback cannot be replayed. Returns the pending request, or null.
  function takeGithubState(id, githubState) {
    const row = pendingRow(id);
    if (!row || !matchesHash(githubState, row.github_state_hash)) return null;
    db.prepare('UPDATE oauth_pending SET github_state_hash = NULL WHERE id_hash = ?').run(row.id_hash);
    return pendingView(row);
  }

  function setPendingLogin(id, login) {
    const row = pendingRow(id);
    if (!row) return false;
    db.prepare('UPDATE oauth_pending SET github_login = ? WHERE id_hash = ?').run(login, row.id_hash);
    return true;
  }

  // A fresh CSRF token for the consent form; the newest one replaces any earlier one.
  function newCsrf(id) {
    const row = pendingRow(id);
    if (!row) return null;
    const token = random();
    db.prepare('UPDATE oauth_pending SET csrf_hash = ? WHERE id_hash = ?').run(sha256(token), row.id_hash);
    return token;
  }

  function checkCsrf(id, token) {
    const row = pendingRow(id);
    return Boolean(row && row.github_login && matchesHash(token, row.csrf_hash));
  }

  function deletePending(id) {
    if (typeof id === 'string' && id !== '') db.prepare('DELETE FROM oauth_pending WHERE id_hash = ?').run(sha256(id));
  }

  // The person approved: turns the pending request into a single-use code for `device`.
  // The device must exist (addDevice first). The record names the device and who approved.
  function approve(id, device, { actor }) {
    const row = pendingRow(id);
    if (!row || !row.github_login) return null;
    const code = random(PREFIX.code);
    const t = nowMs();
    transaction(() => {
      db.prepare('DELETE FROM oauth_pending WHERE id_hash = ?').run(row.id_hash);
      db.prepare(
        'INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, device, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(sha256(code), row.client_id, row.redirect_uri, row.code_challenge, device, row.scopes, iso(t), iso(t + CODE_MS));
      record({ actor, device }, 'oauth', row.client_id, 'consent', { device, scopes: JSON.parse(row.scopes) });
    });
    return { code, redirect_uri: row.redirect_uri, state: row.state };
  }

  // A second use of a code: what the first use issued is revoked (RFC 6749 4.1.2).
  function codeReused(row) {
    transaction(() => {
      if (row.family) revokeFamily(row.family, iso(nowMs()));
      record({ ...MACHINE, device: row.device }, 'oauth', row.client_id, 'reuse', { what: 'code', device: row.device, family: row.family });
    });
  }

  // The code challenge of a live, unused code of this client, or null. The SDK asks for it
  // before anything else, so this is where a reused code is caught.
  function codeChallenge(clientId, code) {
    if (typeof code !== 'string') return null;
    const row = one('SELECT * FROM oauth_codes WHERE code_hash = ?', sha256(code));
    if (!row || row.client_id !== clientId || expired(row)) return null;
    if (row.used_at !== null) {
      codeReused(row);
      return null;
    }
    return row.code_challenge;
  }

  // No token outlives its family's end (familyEnd, in ms).
  function insertToken(kind, { clientId, device, family, scopes, familyEnd }, t) {
    const token = random(PREFIX[kind]);
    const life = kind === 'access' ? ACCESS_MS : REFRESH_MS;
    db.prepare(
      'INSERT INTO oauth_tokens (hash, kind, client_id, device, family, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(sha256(token), kind, clientId, device, family, JSON.stringify(scopes), iso(t), iso(Math.min(t + life, familyEnd)));
    return token;
  }

  function issuePair(grant) {
    const t = nowMs();
    return {
      access_token: insertToken('access', grant, t),
      token_type: 'Bearer',
      expires_in: Math.round((Math.min(t + ACCESS_MS, grant.familyEnd) - t) / 1000),
      refresh_token: insertToken('refresh', grant, t),
      scope: grant.scopes.join(' '),
    };
  }

  // When a family ends: FAMILY_MS after its first token.
  function familyEnd(family) {
    const row = one('SELECT MIN(created_at) AS first FROM oauth_tokens WHERE family = ?', family);
    return Date.parse(row.first) + FAMILY_MS;
  }

  // Tokens and codes of a revoked device are dead even before revokeDevice reaches them.
  const deviceRevoked = (name) => Boolean(one('SELECT 1 FROM devices WHERE name = ? AND revoked_at IS NOT NULL', name));

  function revokeFamily(family, t) {
    return db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL').run(t, family).changes;
  }

  // Exchanges a code (its PKCE verifier already checked by the caller). A second use of a
  // code revokes what the first use issued. Returns { tokens } or { error, message }.
  function exchangeCode(clientId, code, redirectUri) {
    return transaction(() => {
      const row = typeof code === 'string' ? one('SELECT * FROM oauth_codes WHERE code_hash = ?', sha256(code)) : null;
      if (!row || row.client_id !== clientId) return { error: 'invalid_grant', message: 'unknown authorization code' };
      const t = iso(nowMs());
      if (row.used_at !== null) {
        if (row.family) revokeFamily(row.family, t);
        record({ ...MACHINE, device: row.device }, 'oauth', clientId, 'reuse', { what: 'code', device: row.device, family: row.family });
        return { error: 'invalid_grant', message: 'authorization code already used' };
      }
      if (expired(row)) return { error: 'invalid_grant', message: 'authorization code expired' };
      if (deviceRevoked(row.device)) return { error: 'invalid_grant', message: 'the device was revoked' };
      if (redirectUri !== undefined && redirectUri !== row.redirect_uri) {
        return { error: 'invalid_grant', message: 'redirect_uri does not match the authorization request' };
      }
      const family = randomUUID();
      db.prepare('UPDATE oauth_codes SET used_at = ?, family = ? WHERE code_hash = ?').run(t, family, row.code_hash);
      const scopes = JSON.parse(row.scopes);
      const tokens = issuePair({ clientId, device: row.device, family, scopes, familyEnd: nowMs() + FAMILY_MS });
      record({ ...MACHINE, device: row.device }, 'oauth', clientId, 'issue', { device: row.device, family, grant: 'authorization_code' });
      return { tokens };
    });
  }

  // Rotates a refresh token: the old one is revoked and a new pair is issued in the same
  // family. Presenting a revoked refresh token revokes the whole family.
  function exchangeRefresh(clientId, token, scopes) {
    return transaction(() => {
      const row = typeof token === 'string' ? one("SELECT * FROM oauth_tokens WHERE hash = ? AND kind = 'refresh'", sha256(token)) : null;
      if (!row || row.client_id !== clientId) return { error: 'invalid_grant', message: 'unknown refresh token' };
      const t = iso(nowMs());
      if (row.revoked_at !== null) {
        const n = revokeFamily(row.family, t);
        record({ ...MACHINE, device: row.device }, 'oauth', clientId, 'reuse', { what: 'refresh_token', device: row.device, family: row.family, revoked: n });
        return { error: 'invalid_grant', message: 'refresh token was revoked' };
      }
      if (expired(row)) return { error: 'invalid_grant', message: 'refresh token expired' };
      if (deviceRevoked(row.device)) return { error: 'invalid_grant', message: 'the device was revoked' };
      const granted = JSON.parse(row.scopes);
      const asked = scopes ?? granted;
      if (asked.some((s) => !granted.includes(s))) return { error: 'invalid_scope', message: 'scope wider than the grant' };
      db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE hash = ?').run(t, row.hash);
      const tokens = issuePair({ clientId, device: row.device, family: row.family, scopes: asked, familyEnd: familyEnd(row.family) });
      record({ ...MACHINE, device: row.device }, 'oauth', clientId, 'refresh', { device: row.device, family: row.family });
      return { tokens };
    });
  }

  // A live access token of a device that is not revoked: { client_id, device, scopes,
  // expires_at } or null.
  function verifyAccess(token) {
    if (typeof token !== 'string' || !token.startsWith(PREFIX.access)) return null;
    const row = one("SELECT * FROM oauth_tokens WHERE hash = ? AND kind = 'access'", sha256(token));
    if (!row || row.revoked_at !== null || expired(row) || deviceRevoked(row.device)) return null;
    return { client_id: row.client_id, device: row.device, scopes: JSON.parse(row.scopes), expires_at: row.expires_at };
  }

  // RFC 7009: revokes one token of this client; a refresh token takes its family with it.
  // Unknown tokens are ignored.
  function revokeToken(clientId, token) {
    if (typeof token !== 'string') return;
    const row = one('SELECT * FROM oauth_tokens WHERE hash = ?', sha256(token));
    if (!row || row.client_id !== clientId || row.revoked_at !== null) return;
    transaction(() => {
      const t = iso(nowMs());
      if (row.kind === 'refresh') revokeFamily(row.family, t);
      else db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE hash = ?').run(t, row.hash);
      record({ ...MACHINE, device: row.device }, 'oauth', clientId, 'revoke', { kind: row.kind, device: row.device, family: row.family });
    });
  }

  // Revokes every token of a client and uses up its open codes and requests. The client stays
  // registered; it has to ask the person again.
  function revokeClient(clientId, opts) {
    if (!getClient(clientId)) return null;
    return transaction(() => {
      const t = iso(nowMs());
      const n = db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL').run(t, clientId).changes;
      db.prepare('UPDATE oauth_codes SET used_at = ? WHERE client_id = ? AND used_at IS NULL').run(t, clientId);
      db.prepare('DELETE FROM oauth_pending WHERE client_id = ?').run(clientId);
      record(opts, 'oauth', clientId, 'revoke', { kind: 'all', revoked: n });
      return { client_id: clientId, revoked: n };
    });
  }

  // Ends every token and open code of a device, as part of revoking the device (revokeKey,
  // which opens the transaction and writes the record). Returns how many tokens it revoked.
  function revokeDevice(device, t) {
    db.prepare('UPDATE oauth_codes SET expires_at = ? WHERE device = ? AND used_at IS NULL AND expires_at > ?').run(t, device, t);
    return db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE device = ? AND revoked_at IS NULL').run(t, device).changes;
  }

  // The GitHub id pinned for the allowed person: { id, updated_at } or null.
  function githubId() {
    const row = one("SELECT value, updated_at FROM settings WHERE key = 'github_id'");
    return row ? { id: row.value, updated_at: row.updated_at } : null;
  }

  // Pins the GitHub id at the first login whose name matched, with a record. An id pinned
  // already is kept. Returns the id pinned now.
  function pinGithubId(id, login) {
    return transaction(() => {
      const t = iso(nowMs());
      const done = db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('github_id', ?, ?) ON CONFLICT(key) DO NOTHING").run(String(id), t);
      if (done.changes) record({ actor: `github:${login}`, device: null }, 'oauth', 'github', 'pin', { github_id: String(id), login });
      return githubId().id;
    });
  }

  return {
    registerClient,
    getClient,
    listClients,
    tokenActivity,
    createPending,
    getPending,
    takeGithubState,
    setPendingLogin,
    newCsrf,
    checkCsrf,
    deletePending,
    approve,
    codeChallenge,
    exchangeCode,
    exchangeRefresh,
    verifyAccess,
    revokeToken,
    revokeClient,
    revokeDevice,
    githubId,
    pinGithubId,
  };
}
