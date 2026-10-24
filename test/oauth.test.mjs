// End-to-end tests for the GitHub login (src/server/oauth.mjs, src/ledger/oauth.mjs): client
// registration, /authorize sending the browser to GitHub, the callback, the consent page,
// codes with PKCE, tokens on /mcp, refresh rotation and reuse, expiry, revocation, device keys
// alongside, the GitHub id, redirect hosts, rate limits behind a proxy, OAuth turned off, and the
// metadata. GitHub is a local stub; nothing leaves the machine.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openLedger } from '../src/ledger/ledger.mjs';
import { createApp } from '../src/server/mcp.mjs';
import { oauthConfig } from '../src/server/oauth.mjs';

const GITHUB_SECRET = 'github-secret-for-tests';
const REDIRECT = 'http://127.0.0.1:9999/callback';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CLI = new URL('../bin/warifuri.mjs', import.meta.url).pathname;
const OWNER_ID = 1001;

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

// A stand-in for GitHub: GitHub's code "code-<login>" gives a token that reads as <login>,
// with the owner's id for alex-example and another id for anyone else; "code-<login>@<id>"
// gives that id.
async function githubStub(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const url = new URL(req.url, 'http://stub');
      seen.push({ method: req.method, path: url.pathname, body, headers: req.headers });
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
        const form = new URLSearchParams(body);
        if (form.get('client_secret') !== GITHUB_SECRET || !form.get('code')?.startsWith('code-')) {
          res.end(JSON.stringify({ error: 'bad_verification_code' }));
          return;
        }
        res.end(JSON.stringify({ access_token: `gho_${form.get('code').slice(5)}`, token_type: 'bearer', scope: '' }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/user') {
        const m = /^Bearer gho_([^@]+)(?:@(\d+))?$/.exec(req.headers.authorization ?? '');
        if (!m) {
          res.statusCode = 401;
          res.end('{}');
          return;
        }
        const id = m[2] ? Number(m[2]) : m[1].toLowerCase() === 'alex-example' ? OWNER_ID : 2002;
        res.end(JSON.stringify({ login: m[1], id }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  const base = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base, seen };
}

// A ledger with a clock the test can move, a warifuri server with OAuth on, and helpers.
// env adds to the OAuth settings; trustProxy goes to createApp.
async function start(t, { env = {}, trustProxy } = {}) {
  let offset = 0;
  let tick = 0;
  const ledger = openLedger(':memory:', { now: () => new Date(Date.now() + offset + (tick += 1)) });
  const github = await githubStub(t);
  const server = http.createServer();
  const base = await listen(server);
  const { config } = oauthConfig({
    env: { WARIFURI_PUBLIC_URL: base, GITHUB_CLIENT_ID: 'gh-client', GITHUB_CLIENT_SECRET: GITHUB_SECRET, WARIFURI_GITHUB_USER: 'Alex-Example', ...env },
  });
  assert.ok(config);
  const logs = [];
  server.on('request', createApp({ ledger, oauth: config, github: { webUrl: github.base, apiUrl: github.base }, trustProxy, log: (l) => logs.push(l) }));
  const clients = [];
  t.after(async () => {
    for (const c of clients) await c.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    ledger.close();
  });

  const go = (path, init = {}) => fetch(new URL(path, base), { redirect: 'manual', ...init });
  const form = (path, fields, headers = {}) =>
    go(path, { method: 'POST', body: new URLSearchParams(fields), headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers } });

  async function register(meta = {}, headers = {}) {
    const res = await go('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'Test <client>', token_endpoint_auth_method: 'none', ...meta }),
    });
    return { res, body: await res.json() };
  }

  function pkce() {
    const verifier = randomBytes(32).toString('base64url');
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
  }

  // GET /authorize: returns the response, the cookie warifuri set and the state sent to GitHub.
  async function authorize(clientId, challenge, extra = {}) {
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'client-state',
      ...extra,
    });
    const res = await go(`/authorize?${q}`);
    const setCookie = res.headers.getSetCookie();
    const cookie = setCookie.length ? setCookie[0].split(';')[0] : '';
    const location = res.headers.get('location');
    const githubState = location?.startsWith(github.base) ? new URL(location).searchParams.get('state') : null;
    return { res, cookie, setCookie, location, githubState };
  }

  const callback = (cookie, state, code) =>
    go(`/oauth/github/callback?${new URLSearchParams({ state, code })}`, { headers: cookie ? { Cookie: cookie } : {} });

  const csrfOf = (html) => /name="csrf" value="([^"]+)"/.exec(html)?.[1];

  // The browser up to the consent page: authorize and GitHub. Returns the cookie, the page's
  // HTML and the PKCE verifier.
  async function consentPage(clientId, { as = 'alex-example' } = {}) {
    const { verifier, challenge } = pkce();
    const a = await authorize(clientId, challenge);
    const cb = await callback(a.cookie, a.githubState, `code-${as}`);
    assert.equal(cb.status, 303);
    const page = await go('/oauth/consent', { headers: { Cookie: a.cookie } });
    return { cookie: a.cookie, html: await page.text(), verifier };
  }

  // The whole browser part, up to the code: authorize, GitHub, consent with `device`.
  async function login(clientId, { device = 'laptop', as = 'alex-example' } = {}) {
    const { cookie, html, verifier } = await consentPage(clientId, { as });
    const a = { cookie };
    const csrf = csrfOf(html);
    const approved = await form('/oauth/consent', { csrf, action: 'approve', new_device: device }, { Cookie: a.cookie });
    assert.equal(approved.status, 302);
    const back = new URL(approved.headers.get('location'));
    return { code: back.searchParams.get('code'), verifier, back };
  }

  const exchange = (clientId, code, verifier, extra = {}) =>
    form('/token', { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT, ...extra });
  const refresh = (clientId, token) => form('/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: token });

  // A raw tools/list call to /mcp with a bearer; returns the status and headers.
  const mcpStatus = async (bearer) => {
    const res = await go('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    await res.text();
    return res;
  };

  async function connect(bearer) {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
    clients.push(client);
    return client;
  }

  const advance = (ms) => {
    offset += ms;
  };
  return { base, ledger, github, logs, go, form, register, pkce, authorize, callback, csrfOf, consentPage, login, exchange, refresh, mcpStatus, connect, advance };
}

test('the full flow: registration, GitHub, consent, code with PKCE, tokens on /mcp', async (t) => {
  const s = await start(t);
  const place = s.ledger.createPlace({ name: 'thesis', profile: 'research', paths: [{ device: 'laptop', path: '/home/alex/thesis' }] }, { actor: 'human' });
  s.ledger.createGoal({ title: 'Research goal', mode: 'ai_worker', profile: 'research' }, { actor: 'human' });

  // Registration: every client is public, even one that asks for a secret.
  const { res: reg, body: client } = await s.register({ token_endpoint_auth_method: 'client_secret_post' });
  assert.equal(reg.status, 201);
  assert.equal(client.token_endpoint_auth_method, 'none');
  assert.equal(client.client_secret, undefined);
  const id = client.client_id;

  // /authorize sends the browser to GitHub with its own state, and sets the cookie.
  const { verifier, challenge } = s.pkce();
  const a = await s.authorize(id, challenge);
  assert.equal(a.res.status, 302);
  const toGithub = new URL(a.location);
  assert.equal(`${toGithub.origin}${toGithub.pathname}`, `${s.github.base}/login/oauth/authorize`);
  assert.equal(toGithub.searchParams.get('client_id'), 'gh-client');
  assert.equal(toGithub.searchParams.get('redirect_uri'), `${s.base}/oauth/github/callback`);
  assert.equal(toGithub.searchParams.get('scope'), null);
  assert.notEqual(a.githubState, 'client-state');
  assert.match(a.setCookie[0], /^warifuri_oauth=[A-Za-z0-9_-]{43};/);
  assert.match(a.setCookie[0], /HttpOnly/);
  assert.match(a.setCookie[0], /SameSite=Lax/);
  assert.doesNotMatch(a.setCookie[0], /Secure/);

  // The callback refuses a wrong state, and the right state without the cookie.
  assert.equal((await s.callback(a.cookie, 'wrong-state', 'code-alex-example')).status, 400);
  assert.equal((await s.callback('', a.githubState, 'code-alex-example')).status, 400);
  assert.equal((await s.callback('warifuri_oauth=other', a.githubState, 'code-alex-example')).status, 400);
  // The consent page needs the GitHub login first.
  assert.equal((await s.go('/oauth/consent', { headers: { Cookie: a.cookie } })).status, 400);

  // The right state and cookie; the login is compared without regard to case.
  const cb = await s.callback(a.cookie, a.githubState, 'code-alex-example');
  assert.equal(cb.status, 303);
  assert.equal(cb.headers.get('location'), '/oauth/consent');
  const exchangeAtGithub = s.github.seen.find((x) => x.path === '/login/oauth/access_token');
  assert.equal(exchangeAtGithub.headers.accept, 'application/json');
  assert.equal(new URLSearchParams(exchangeAtGithub.body).get('client_secret'), GITHUB_SECRET);
  // The same callback cannot be used twice.
  assert.equal((await s.callback(a.cookie, a.githubState, 'code-alex-example')).status, 400);

  // The consent page: escaped, Japanese, with a CSRF token.
  const page = await s.go('/oauth/consent', { headers: { Cookie: a.cookie } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  const html = await page.text();
  assert.match(html, /Test &lt;client&gt;/);
  assert.doesNotMatch(html, /<client>/);
  assert.match(html, /許可する/);
  const csrf = s.csrfOf(html);
  assert.ok(csrf);

  // Without the token, with a wrong one, or without the cookie, the form is refused.
  assert.equal((await s.form('/oauth/consent', { action: 'approve', new_device: 'laptop' }, { Cookie: a.cookie })).status, 403);
  assert.equal((await s.form('/oauth/consent', { csrf: 'nope', action: 'approve', new_device: 'laptop' }, { Cookie: a.cookie })).status, 403);
  assert.equal((await s.form('/oauth/consent', { csrf, action: 'approve', new_device: 'laptop' })).status, 403);
  // A bad device name shows the page again, with a fresh token.
  const bad = await s.form('/oauth/consent', { csrf, action: 'approve', new_device: 'bad name!' }, { Cookie: a.cookie });
  assert.equal(bad.status, 400);
  const badHtml = await bad.text();
  assert.match(badHtml, /class="error"/);
  const csrf2 = s.csrfOf(badHtml);
  assert.equal((await s.form('/oauth/consent', { csrf, action: 'approve', new_device: 'laptop' }, { Cookie: a.cookie })).status, 403);

  // Approve: the device is created, the browser goes back with a code and the client's state.
  const ok = await s.form('/oauth/consent', { csrf: csrf2, action: 'approve', new_device: 'laptop' }, { Cookie: a.cookie });
  assert.equal(ok.status, 302);
  const back = new URL(ok.headers.get('location'));
  assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
  assert.equal(back.searchParams.get('state'), 'client-state');
  const code = back.searchParams.get('code');
  assert.match(code, /^wfc_/);
  assert.deepEqual(s.ledger.listDevices().map((d) => d.name), ['laptop']);

  // The token endpoint: a wrong verifier and a different redirect_uri are refused.
  const wrong = await s.exchange(id, code, s.pkce().verifier);
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json()).error, 'invalid_grant');
  const otherUri = await s.exchange(id, code, verifier, { redirect_uri: 'http://127.0.0.1:9999/other' });
  assert.equal(otherUri.status, 400);
  assert.equal((await otherUri.json()).error, 'invalid_grant');
  const res = await s.exchange(id, code, verifier);
  assert.equal(res.status, 200);
  const tokens = await res.json();
  assert.match(tokens.access_token, /^wfa_[A-Za-z0-9_-]{43}$/);
  assert.match(tokens.refresh_token, /^wfr_[A-Za-z0-9_-]{43}$/);
  assert.equal(tokens.token_type, 'Bearer');
  assert.equal(tokens.expires_in, 3600);

  // The access token works with the SDK client, as the device chosen on the consent page.
  const mcp = await s.connect(tokens.access_token);
  const out = await mcp.callTool({ name: 'board', arguments: { place: '/home/alex/thesis' } });
  const board = JSON.parse(out.content[0].text);
  assert.equal(board.scope.place.id, place.id);
  assert.equal(board.goals.length, 1);
  // Writes through the token are recorded as that client, from the chosen device.
  const made = JSON.parse((await mcp.callTool({ name: 'create_task', arguments: { title: 'Read papers', mode: 'ai_worker' } })).content[0].text);
  const created = s.ledger.records(made.id)[0];
  assert.deepEqual([created.actor, created.device], [`oauth:${id}`, 'laptop']);
  // /api takes machine keys only.
  const api = await s.go('/api/held?dir=/home/alex/thesis', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  assert.equal(api.status, 401);

  // Records say what happened and to which device, and hold no secret.
  const records = s.ledger.records(id);
  assert.deepEqual(records.map((r) => r.action), ['register', 'consent', 'issue']);
  assert.equal(records[1].actor, 'github:alex-example');
  assert.equal(records[1].device, 'laptop');
  assert.equal(records[2].device, 'laptop');
  const everything = JSON.stringify([records, s.ledger.records('laptop'), s.logs]);
  for (const secret of [code, tokens.access_token, tokens.refresh_token, GITHUB_SECRET, 'gho_', verifier]) {
    assert.ok(!everything.includes(secret), secret);
  }

  // Using the code again is refused, and revokes what it issued.
  const again = await s.exchange(id, code, verifier);
  assert.equal(again.status, 400);
  assert.equal((await s.mcpStatus(tokens.access_token)).status, 401);
  assert.equal((await s.refresh(id, tokens.refresh_token)).status, 400);
});

test('a login other than the allowed one is refused; deny goes back with access_denied', async (t) => {
  const s = await start(t);
  const { body: client } = await s.register();
  const a = await s.authorize(client.client_id, s.pkce().challenge);
  const res = await s.callback(a.cookie, a.githubState, 'code-mallory');
  assert.equal(res.status, 403);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /1人の GitHub ユーザー/);
  // The request is gone: the consent page does not open.
  assert.equal((await s.go('/oauth/consent', { headers: { Cookie: a.cookie } })).status, 400);
  assert.equal(s.ledger.listDevices().length, 0);

  // GitHub refusing the code is not a login either.
  const b = await s.authorize(client.client_id, s.pkce().challenge);
  assert.equal((await s.callback(b.cookie, b.githubState, 'bogus')).status, 502);
  assert.ok(s.logs.some((l) => /GitHub login failed/.test(l)));
  assert.ok(!s.logs.join('\n').includes(GITHUB_SECRET));

  // Deny on the consent page.
  const c = await s.authorize(client.client_id, s.pkce().challenge);
  await s.callback(c.cookie, c.githubState, 'code-Alex-Example');
  const csrf = s.csrfOf(await (await s.go('/oauth/consent', { headers: { Cookie: c.cookie } })).text());
  const denied = await s.form('/oauth/consent', { csrf, action: 'deny' }, { Cookie: c.cookie });
  assert.equal(denied.status, 302);
  const back = new URL(denied.headers.get('location'));
  assert.equal(back.searchParams.get('error'), 'access_denied');
  assert.equal(back.searchParams.get('state'), 'client-state');
  assert.equal(back.searchParams.get('code'), null);
});

test('/authorize requires a registered client, the exact redirect URI and PKCE S256', async (t) => {
  const s = await start(t);
  const { body: client } = await s.register();
  const { challenge } = s.pkce();
  // Unknown client: no redirect at all.
  assert.equal((await s.authorize('nobody', challenge)).res.status, 400);
  // A loopback URI on another port passes the SDK's loose check but not warifuri's exact one.
  const port = await s.authorize(client.client_id, challenge, { redirect_uri: 'http://127.0.0.1:1234/callback' });
  assert.equal(port.res.status, 400);
  assert.equal(port.location, null);
  // No PKCE, or plain PKCE: back to the client with an error, and no request is kept.
  for (const extra of [{ code_challenge_method: 'plain' }, { code_challenge: 'short' }]) {
    const r = await s.authorize(client.client_id, challenge, extra);
    assert.equal(r.res.status, 302);
    assert.equal(new URL(r.location).searchParams.get('error'), 'invalid_request');
    assert.equal(r.cookie, '');
  }
  // A resource other than this server's /mcp.
  const target = await s.authorize(client.client_id, challenge, { resource: 'https://elsewhere.example/mcp' });
  assert.equal(new URL(target.location).searchParams.get('error'), 'invalid_target');
  // Registration refuses plain http away from loopback.
  const { res } = await s.register({ redirect_uris: ['http://example.org/callback'] });
  assert.equal(res.status, 400);
});

test('refresh rotates; reusing the old refresh token revokes the family; access tokens expire', async (t) => {
  const s = await start(t);
  const { body: client } = await s.register();
  const id = client.client_id;
  const { code, verifier } = await s.login(id);
  const first = await (await s.exchange(id, code, verifier)).json();

  const rotated = await s.refresh(id, first.refresh_token);
  assert.equal(rotated.status, 200);
  const second = await rotated.json();
  assert.notEqual(second.refresh_token, first.refresh_token);
  assert.notEqual(second.access_token, first.access_token);
  assert.equal((await s.mcpStatus(second.access_token)).status, 200);

  // Another client cannot use this refresh token.
  const { body: other } = await s.register();
  assert.equal((await s.refresh(other.client_id, second.refresh_token)).status, 400);

  // The old refresh token again: refused, and the whole family goes.
  const reuse = await s.refresh(id, first.refresh_token);
  assert.equal(reuse.status, 400);
  assert.equal((await reuse.json()).error, 'invalid_grant');
  assert.equal((await s.refresh(id, second.refresh_token)).status, 400);
  assert.equal((await s.mcpStatus(second.access_token)).status, 401);
  assert.equal((await s.mcpStatus(first.access_token)).status, 401);
  assert.ok(s.ledger.records(id).some((r) => r.action === 'reuse'));

  // A new grant: after an hour the access token is refused, the refresh token still works,
  // and after 30 days that is refused too.
  const next = await s.login(id);
  const fresh = await (await s.exchange(id, next.code, next.verifier)).json();
  assert.equal((await s.mcpStatus(fresh.access_token)).status, 200);
  s.advance(HOUR + 1000);
  const expired = await s.mcpStatus(fresh.access_token);
  assert.equal(expired.status, 401);
  assert.match(expired.headers.get('www-authenticate'), /^Bearer error="invalid_token"/);
  const renewed = await s.refresh(id, fresh.refresh_token);
  assert.equal(renewed.status, 200);
  const later = await renewed.json();
  s.advance(31 * DAY);
  assert.equal((await s.refresh(id, later.refresh_token)).status, 400);
});

test('a code expires after 10 minutes; revocation and the command line end tokens', async (t) => {
  const s = await start(t);
  const { body: client } = await s.register();
  const id = client.client_id;
  const late = await s.login(id);
  s.advance(11 * 60 * 1000);
  assert.equal((await s.exchange(id, late.code, late.verifier)).status, 400);

  // RFC 7009: revoking the refresh token ends its family.
  const one = await s.login(id);
  const a = await (await s.exchange(id, one.code, one.verifier)).json();
  const revoked = await s.form('/revoke', { client_id: id, token: a.refresh_token });
  assert.equal(revoked.status, 200);
  assert.equal((await s.mcpStatus(a.access_token)).status, 401);
  // An unknown token is ignored.
  assert.equal((await s.form('/revoke', { client_id: id, token: 'wfa_unknown' })).status, 200);

  // `warifuri oauth revoke` (ledger.oauth.revokeClient) ends every token of the client.
  const two = await s.login(id, { device: 'desk' });
  const b = await (await s.exchange(id, two.code, two.verifier)).json();
  assert.deepEqual(s.ledger.oauth.listClients().map((c) => [c.client_id, c.client_name, c.devices]), [[id, 'Test <client>', ['desk']]]);
  const out = s.ledger.oauth.revokeClient(id, { actor: 'cli' });
  assert.equal(out.revoked, 2);
  assert.equal((await s.mcpStatus(b.access_token)).status, 401);
  assert.equal((await s.refresh(id, b.refresh_token)).status, 400);
  assert.deepEqual(s.ledger.oauth.listClients()[0].devices, []);
  assert.equal(s.ledger.oauth.revokeClient('nobody', { actor: 'cli' }), null);
  // The consent page offered the existing device too.
  assert.deepEqual(s.ledger.listDevices().map((d) => d.name), ['desk', 'laptop']);
});

test('device keys still work beside OAuth; 401s point at the resource metadata', async (t) => {
  const s = await start(t);
  const { key } = s.ledger.issueKey('desk', { actor: 'human' });
  const client = await s.connect(key);
  const { tools } = await client.listTools();
  assert.ok(tools.some((x) => x.name === 'board'));

  for (const bearer of [undefined, 'wf_wrong', 'wfa_wrong', 'something']) {
    const res = await s.mcpStatus(bearer);
    assert.equal(res.status, 401, String(bearer));
    const header = res.headers.get('www-authenticate');
    assert.match(header, /^Bearer error="invalid_token"/);
    assert.ok(header.includes(`resource_metadata="${s.base}/.well-known/oauth-protected-resource/mcp"`), header);
  }
  s.ledger.revokeKey('desk', { actor: 'human' });
  assert.equal((await s.mcpStatus(key)).status, 401);
});

test('metadata: the authorization server and the protected resource /mcp', async (t) => {
  const s = await start(t);
  const as = await (await s.go('/.well-known/oauth-authorization-server')).json();
  assert.equal(as.issuer, `${s.base}/`);
  assert.equal(as.authorization_endpoint, `${s.base}/authorize`);
  assert.equal(as.token_endpoint, `${s.base}/token`);
  assert.equal(as.registration_endpoint, `${s.base}/register`);
  assert.equal(as.revocation_endpoint, `${s.base}/revoke`);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(as.response_types_supported, ['code']);
  assert.deepEqual(as.grant_types_supported, ['authorization_code', 'refresh_token']);
  const pr = await (await s.go('/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(pr.resource, `${s.base}/mcp`);
  assert.deepEqual(pr.authorization_servers, [`${s.base}/`]);
  assert.equal(pr.resource_name, 'warifuri');
  assert.equal((await s.go('/health')).status, 200);
});

test('OAuth is off when a setting is missing, and refuses wrong settings', async (t) => {
  const full = { WARIFURI_PUBLIC_URL: 'https://ledger.example', GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 's', WARIFURI_GITHUB_USER: 'alex' };
  assert.ok(oauthConfig({ env: full }).config);
  // Flags win over the environment.
  assert.equal(oauthConfig({ env: full, flags: { githubUser: 'sam' } }).config.githubUser, 'sam');
  for (const key of Object.keys(full)) {
    const env = { ...full, [key]: '' };
    const { config, missing } = oauthConfig({ env });
    assert.equal(config, null);
    assert.equal(missing.length, 1, key);
  }
  for (const url of ['http://ledger.example', 'https://ledger.example/warifuri', 'not a url']) {
    assert.ok(oauthConfig({ env: { ...full, WARIFURI_PUBLIC_URL: url } }).problems, url);
  }
  assert.ok(oauthConfig({ env: { ...full, WARIFURI_GITHUB_USER: 'two users' } }).problems);
  assert.equal(oauthConfig({ env: { ...full, WARIFURI_PUBLIC_URL: 'http://localhost:8787' } }).config.publicUrl, 'http://localhost:8787');

  // serve refuses a --trust-proxy that express cannot read, before it listens.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warifuri-serve-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const serve = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', CLI, 'serve', '--db', path.join(dir, 'l.sqlite'), '--trust-proxy', 'true'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
    timeout: 10_000,
  });
  assert.equal(serve.status, 2);
  assert.match(serve.stderr, /--trust-proxy/);

  // With OAuth off there are no OAuth endpoints, and device keys work as before.
  const ledger = openLedger(':memory:');
  const server = http.createServer(createApp({ ledger }));
  const base = await listen(server);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    ledger.close();
  });
  for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp', '/authorize', '/oauth/consent']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('www-authenticate'), 'Bearer');
});

test('revoking a device ends its OAuth tokens and codes; the consent page no longer offers it', async (t) => {
  const s = await start(t);
  const { body: client } = await s.register();
  const id = client.client_id;
  const first = await s.login(id, { device: 'laptop' });
  const a = await (await s.exchange(id, first.code, first.verifier)).json();
  const other = await s.login(id, { device: 'desk' });
  const d = await (await s.exchange(id, other.code, other.verifier)).json();
  // A code approved for laptop but not yet exchanged.
  const open = await s.login(id, { device: 'laptop' });

  // `warifuri key revoke laptop`: laptop has no key, only logins, and is revoked all the same.
  const out = s.ledger.revokeKey('laptop', { actor: 'cli' });
  assert.equal(out.oauth_tokens, 2);
  assert.equal((await s.mcpStatus(a.access_token)).status, 401);
  const refused = await s.refresh(id, a.refresh_token);
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error, 'invalid_grant');
  assert.equal((await s.exchange(id, open.code, open.verifier)).status, 400);
  // The other device is untouched.
  assert.equal((await s.mcpStatus(d.access_token)).status, 200);
  assert.deepEqual(s.ledger.oauth.listClients()[0].devices, ['desk']);
  const rec = s.ledger.records('laptop').at(-1);
  assert.equal(rec.action, 'revoke');
  assert.equal(rec.changes.oauth_tokens, 2);

  // The consent page offers desk only; laptop, typed or chosen, is refused and not reused.
  const page = await s.consentPage(id);
  assert.match(page.html, /<option value="desk">/);
  assert.doesNotMatch(page.html, /<option value="laptop">/);
  const typed = await s.form('/oauth/consent', { csrf: s.csrfOf(page.html), action: 'approve', new_device: 'laptop' }, { Cookie: page.cookie });
  assert.equal(typed.status, 400);
  const typedHtml = await typed.text();
  assert.match(typedHtml, /laptop は取り消されています/);
  const chosen = await s.form('/oauth/consent', { csrf: s.csrfOf(typedHtml), action: 'approve', device: 'laptop' }, { Cookie: page.cookie });
  assert.equal(chosen.status, 400);
  assert.equal(s.ledger.listDevices().find((x) => x.name === 'laptop').revoked_at, out.revoked_at);

  // A new key makes the device usable again; the old tokens stay revoked.
  s.ledger.issueKey('laptop', { actor: 'cli' });
  assert.equal((await s.mcpStatus(a.access_token)).status, 401);
  assert.equal((await s.refresh(id, a.refresh_token)).status, 400);
});

test('the GitHub user is matched by id: pinned at the first login, or set with WARIFURI_GITHUB_ID', async (t) => {
  const s = await start(t);
  const { body: client } = await s.register();
  assert.equal(s.ledger.oauth.githubId(), null);
  // Someone else with another name pins nothing.
  const m = await s.authorize(client.client_id, s.pkce().challenge);
  assert.equal((await s.callback(m.cookie, m.githubState, 'code-mallory')).status, 403);
  assert.equal(s.ledger.oauth.githubId(), null);

  // The first login with the allowed name pins its id, with a record.
  await s.login(client.client_id);
  assert.equal(s.ledger.oauth.githubId().id, String(OWNER_ID));
  const pin = s.ledger.records('github');
  assert.deepEqual(pin.map((r) => [r.entity, r.action, r.actor]), [['oauth', 'pin', 'github:alex-example']]);
  assert.equal(pin[0].changes.github_id, String(OWNER_ID));

  // From then on only the id counts: a new account that took the name is refused, and the
  // owner under a new name is let in.
  const taken = await s.authorize(client.client_id, s.pkce().challenge);
  assert.equal((await s.callback(taken.cookie, taken.githubState, 'code-alex-example@3003')).status, 403);
  const renamed = await s.login(client.client_id, { as: `alex-renamed@${OWNER_ID}` });
  assert.ok(renamed.code);
  assert.equal(s.ledger.records('github').length, 1);

  // With WARIFURI_GITHUB_ID only that id counts, whatever the name, and nothing is pinned.
  const e = await start(t, { env: { WARIFURI_GITHUB_ID: '4004' } });
  const { body: c2 } = await e.register();
  const wrong = await e.authorize(c2.client_id, e.pkce().challenge);
  assert.equal((await e.callback(wrong.cookie, wrong.githubState, 'code-alex-example')).status, 403);
  assert.ok((await e.login(c2.client_id, { as: 'someone-else@4004' })).code);
  assert.equal(e.ledger.oauth.githubId(), null);
  const env = { WARIFURI_PUBLIC_URL: 'https://ledger.example', GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 's', WARIFURI_GITHUB_USER: 'alex' };
  assert.equal(oauthConfig({ env: { ...env, WARIFURI_GITHUB_ID: '42' } }).config.githubId, '42');
  for (const bad of ['alex', '-1', '0', '1.5']) assert.ok(oauthConfig({ env: { ...env, WARIFURI_GITHUB_ID: bad } }).problems, bad);
});

test('redirect URIs: loopback http, or https on the allowed hosts only; the consent page shows the host', async (t) => {
  const s = await start(t, { env: { WARIFURI_REDIRECT_HOSTS: ' Chat.Example.org , ' } });
  for (const uri of [
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
    'https://chat.example.org/cb',
    'http://localhost:3000/callback',
    'http://[::1]:3000/callback',
  ]) {
    assert.equal((await s.register({ redirect_uris: [uri] })).res.status, 201, uri);
  }
  for (const uri of [
    'https://evil.example/cb',
    'https://claude.ai.evil.example/cb',
    'https://sub.claude.ai/cb',
    'https://user@claude.ai/cb',
    'https://claude.ai/cb#frag',
    'http://claude.ai/cb',
    'http://example.org/callback',
    'myapp://callback',
  ]) {
    const { res, body } = await s.register({ redirect_uris: [REDIRECT, uri] });
    assert.equal(res.status, 400, uri);
    assert.equal(body.error, 'invalid_redirect_uri', uri);
  }
  // Nothing refused was stored: the five above are the only clients.
  assert.equal(s.ledger.oauth.listClients().length, 5);

  const { body: client } = await s.register();
  const { html } = await s.consentPage(client.client_id);
  assert.match(html, /<strong>Test &lt;client&gt;<\/strong>\(アプリが自分で名乗った名前\)/);
  assert.match(html, /戻り先は <strong>127\.0\.0\.1:9999<\/strong>/);

  const env = { WARIFURI_PUBLIC_URL: 'https://ledger.example', GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 's', WARIFURI_GITHUB_USER: 'alex' };
  assert.deepEqual(oauthConfig({ env }).config.redirectHosts, ['claude.ai', 'claude.com']);
  assert.ok(oauthConfig({ env: { ...env, WARIFURI_REDIRECT_HOSTS: 'https://x.example/' } }).problems);
});

test('client names lose control characters and are cut at 64; the command line prints none', async (t) => {
  const s = await start(t);
  const { body } = await s.register({ client_name: `\u001b[31mBad\u0007 ‮app\n${'x'.repeat(100)}` });
  assert.equal(body.client_name, `[31mBad app${'x'.repeat(53)}`);
  assert.equal(Array.from(body.client_name).length, 64);
  assert.equal(s.ledger.oauth.getClient(body.client_id).client_name, body.client_name);
  const { body: blank } = await s.register({ client_name: '\u0000\u001f' });
  assert.equal(blank.client_name, undefined);

  // A row stored before this rule: `warifuri oauth clients` still prints it clean, and says
  // whether the GitHub id is pinned.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warifuri-oauth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = path.join(dir, 'ledger.sqlite');
  const L = openLedger(db);
  L.oauth.registerClient({ client_id: 'old', redirect_uris: [REDIRECT], client_name: '\u001b]0;pwned\u0007Old app' });
  L.close();
  const cli = (args) => spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', CLI, ...args], { encoding: 'utf8' });
  const before = cli(['oauth', 'clients', '--db', db]);
  assert.equal(before.status, 0, before.stderr);
  assert.doesNotMatch(before.stdout, /[\u0000-\u0009\u000b-\u001f\u007f]/);
  assert.match(before.stdout, /^GitHub user id not pinned yet/);
  assert.match(before.stdout, /old {2}\]0;pwnedOld app {2}registered/);
  const P = openLedger(db);
  P.oauth.pinGithubId(OWNER_ID, 'alex-example');
  P.close();
  assert.match(cli(['oauth', 'clients', '--db', db]).stdout, new RegExp(`^GitHub user id ${OWNER_ID} \\(pinned `));
});

test('a grant ends 90 days after its code, however often it is refreshed', async (t) => {
  const s = await start(t);
  const { body: client } = await s.register();
  const id = client.client_id;
  const { code, verifier } = await s.login(id);
  let tokens = await (await s.exchange(id, code, verifier)).json();
  for (let i = 0; i < 3; i += 1) {
    s.advance(29 * DAY);
    const res = await s.refresh(id, tokens.refresh_token);
    assert.equal(res.status, 200, `refresh ${i}`);
    tokens = await res.json();
  }
  // Day 87: the new refresh token would last 30 days, but the grant ends on day 90.
  assert.equal((await s.mcpStatus(tokens.access_token)).status, 200);
  s.advance(3 * DAY + 1000);
  const late = await s.refresh(id, tokens.refresh_token);
  assert.equal(late.status, 400);
  assert.equal((await late.json()).error, 'invalid_grant');
  // A new login starts a new 90 days.
  const again = await s.login(id);
  assert.equal((await s.exchange(id, again.code, again.verifier)).status, 200);
});

test('rate limits: /token counts per client, and --trust-proxy counts callers behind a proxy apart', async (t) => {
  const s = await start(t);
  const { body: client } = await s.register();
  const id = client.client_id;
  const { code, verifier } = await s.login(id);
  const tokens = await (await s.exchange(id, code, verifier)).json();
  // A stranger floods /token, with an unknown client and with one of its own.
  const { body: theirs } = await s.register();
  for (const cid of ['nobody', theirs.client_id]) {
    let last;
    for (let i = 0; i < 51; i += 1) last = await s.refresh(cid, 'wfr_guess');
    assert.equal(last.status, 429, cid);
  }
  // The owner's refresh still goes through.
  assert.equal((await s.refresh(id, tokens.refresh_token)).status, 200);

  // /register keeps a budget per caller. Behind a proxy on loopback, with trust proxy, each
  // forwarded address has its own; without it, every caller is the proxy.
  const flood = async (srv, from) => {
    let last;
    for (let i = 0; i < 21; i += 1) last = await srv.register({}, { 'X-Forwarded-For': from });
    return last.res.status;
  };
  const p = await start(t, { trustProxy: 'loopback' });
  assert.equal(await flood(p, '203.0.113.9'), 429);
  assert.equal((await p.register({}, { 'X-Forwarded-For': '203.0.113.10' })).res.status, 201);
  // Without it the rate limiter warns about the header on the console; kept quiet here.
  const warned = t.mock.method(console, 'error', () => {});
  const q = await start(t);
  assert.equal(await flood(q, '203.0.113.9'), 429);
  assert.equal((await q.register({}, { 'X-Forwarded-For': '203.0.113.10' })).res.status, 429);
  warned.mock.restore();
});
