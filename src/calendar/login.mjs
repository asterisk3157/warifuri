// `warifuri google login`: the person lets warifuri read their Google Calendar, once, with
// their own OAuth client (a "Desktop app" client of their Google Cloud project).
//
// The command prints a Google URL and listens on this machine (127.0.0.1). The person opens
// the URL in a browser and allows reading; Google sends the browser back to 127.0.0.1 with a
// code, which is traded for a refresh token. When the browser is on another machine (the
// server has no screen), the page it is sent back to does not open there: the person copies
// that page's URL from the address bar and pastes it into the command instead.
//
// The OAuth client is the operator's own, for the operator's own calendar only. When
// WARIFURI_GOOGLE_ACCOUNT is set, a login with another Google account (the id of its primary
// calendar, which is the account's address) is refused and nothing is saved.
//
// The refresh token is written to secrets.env (WARIFURI_GOOGLE_REFRESH_TOKEN, owner-only) and
// is never printed.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { createHash, randomBytes } from 'node:crypto';
import { setEnvLine } from '../client/connect.mjs';
import { decodeText, SECRETS_FILE } from '../config.mjs';
import { AUTH_URL, SCOPE, tokenRequest, createGoogle } from './google.mjs';

const b64 = (buf) => buf.toString('base64url');

// What one login needs: the URL to open, and the state and verifier to check the answer with.
export function loginRequest({ clientId, redirectUri, state = b64(randomBytes(16)), verifier = b64(randomBytes(32)) }) {
  const url = new URL(AUTH_URL);
  const params = {
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent', state,
    code_challenge: b64(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return { url: url.toString(), state, verifier };
}

// The code in the URL Google sent the browser back to: { code } or { problem }.
export function readRedirect(text, state) {
  let url;
  try {
    url = new URL(String(text).trim(), 'http://127.0.0.1');
  } catch {
    return { problem: 'that is not a URL' };
  }
  if (url.searchParams.get('error')) return { problem: `Google answered ${url.searchParams.get('error')}` };
  if (url.searchParams.get('state') !== state) return { problem: 'the URL is not from this login (state differs)' };
  const code = url.searchParams.get('code');
  return code ? { code } : { problem: 'the URL has no code' };
}

// Trades the code for the refresh token.
export async function exchange({ clientId, clientSecret, code, verifier, redirectUri, fetch: fetchImpl }) {
  const body = await tokenRequest(
    { client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code' },
    fetchImpl,
  );
  if (typeof body.refresh_token !== 'string' || !body.refresh_token) throw new Error('Google gave no refresh token');
  return body.refresh_token;
}

// Whether the login is of the account allowed: { ok: true } when none is set or the primary
// calendar's id (the account's address) is that account, else { problem }.
export async function checkAccount({ clientId, clientSecret, refreshToken, account, fetch: fetchImpl }) {
  const want = typeof account === 'string' ? account.trim().toLowerCase() : '';
  if (!want) return { ok: true };
  const calendars = await createGoogle({ clientId, clientSecret, refreshToken, fetch: fetchImpl }).calendars();
  const primary = calendars.find((c) => c.primary)?.id ?? '';
  if (primary.toLowerCase() === want) return { ok: true };
  return { problem: 'this is not the Google account in WARIFURI_GOOGLE_ACCOUNT; nothing was saved. Log in again with that account' };
}

// Writes the refresh token into secrets.env of the data directory (owner-only). Returns the file.
export function saveRefreshToken(home, token, platform = process.platform) {
  const file = path.join(home, SECRETS_FILE);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  let text = '';
  try {
    text = decodeText(fs.readFileSync(file)).text;
  } catch {
    text = '';
  }
  fs.writeFileSync(file, setEnvLine(text, 'WARIFURI_GOOGLE_REFRESH_TOKEN', token), { mode: 0o600 });
  if (platform !== 'win32') fs.chmodSync(file, 0o600);
  return file;
}

// The whole login. io: { out(line), input (a readable stream, for the pasted URL) }.
// Resolves to { file } or { problem }.
export async function login(cfg, io, { fetch: fetchImpl = globalThis.fetch, timeoutMs = 10 * 60_000 } = {}) {
  const clientId = cfg.values.WARIFURI_GOOGLE_CLIENT_ID;
  const clientSecret = cfg.values.WARIFURI_GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return { problem: 'set WARIFURI_GOOGLE_CLIENT_ID (warifuri.env) and WARIFURI_GOOGLE_CLIENT_SECRET (secrets.env) first' };
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const redirectUri = `http://127.0.0.1:${server.address().port}`;
  const request = loginRequest({ clientId, redirectUri });
  const rl = readline.createInterface({ input: io.input });
  let timer;
  try {
    io.out('Open this URL in a browser and allow warifuri to read your calendar:');
    io.out('');
    io.out(`  ${request.url}`);
    io.out('');
    io.out('When the browser is on another machine, the page it ends on does not open. Copy the URL of that page');
    io.out('from the address bar, paste it here and press Enter.');
    const answer = await new Promise((resolve) => {
      server.on('request', (req, res) => {
        const got = readRedirect(req.url, request.state);
        res.writeHead(got.code ? 200 : 400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(got.code ? 'warifuri: done. You can close this page.\n' : 'warifuri: this is not the page of the login.\n');
        if (got.code) resolve(got);
      });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        const got = readRedirect(line, request.state);
        if (got.code) resolve(got);
        else io.out(`warifuri: ${got.problem}; paste the whole URL`);
      });
      timer = setTimeout(() => resolve({ problem: 'no answer came in time' }), timeoutMs);
    });
    if (answer.problem) return answer;
    const token = await exchange({ clientId, clientSecret, code: answer.code, verifier: request.verifier, redirectUri, fetch: fetchImpl });
    const checked = await checkAccount({ clientId, clientSecret, refreshToken: token, account: cfg.values.WARIFURI_GOOGLE_ACCOUNT, fetch: fetchImpl });
    if (checked.problem) return checked;
    return { file: saveRefreshToken(cfg.home, token) };
  } catch (err) {
    return { problem: err.message };
  } finally {
    clearTimeout(timer);
    rl.close();
    server.close();
    server.closeAllConnections?.();
  }
}
