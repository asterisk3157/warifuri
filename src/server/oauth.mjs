// warifuri as its own OAuth 2.1 authorization server for MCP clients. GitHub only answers
// "who is this person": the browser is sent to GitHub, warifuri reads the user once, compares
// its numeric id with the one allowed person's, and throws GitHub's token away. The id comes
// from WARIFURI_GITHUB_ID, or is pinned at the first login whose name matched the allowed
// login (a name can change hands; the id cannot). Codes and tokens are warifuri's own
// (src/ledger/oauth.mjs) and resolve to a device, as device keys do.
//
// The SDK's mcpAuthRouter serves the metadata, client registration, /authorize, /token and
// /revoke; this module gives it the provider, and adds the GitHub callback and the consent
// page. Nothing here logs a token, code, client secret, the GitHub secret or GitHub's token.

import express from 'express';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import {
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
  OAuthError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { LedgerError } from '../ledger/ledger.mjs';
import { PENDING_MS } from '../ledger/oauth.mjs';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
// https hosts a client may be sent back to, besides loopback; WARIFURI_REDIRECT_HOSTS adds more.
const REDIRECT_HOSTS = ['claude.ai', 'claude.com'];
const CLIENT_NAME_MAX = 64;
const CALLBACK_PATH = '/oauth/github/callback';
const CONSENT_PATH = '/oauth/consent';
const GITHUB_TIMEOUT_MS = 10_000;
// What makes OAuth possible; with any of these missing, only device keys work.
const NEEDED = [
  ['publicUrl', 'WARIFURI_PUBLIC_URL (--public-url)'],
  ['githubClientId', 'WARIFURI_GITHUB_CLIENT_ID'],
  ['githubClientSecret', 'WARIFURI_GITHUB_CLIENT_SECRET'],
  ['githubUser', 'WARIFURI_GITHUB_USER (--github-user)'],
];

// RFC 7591's error for a refused redirect URI; the SDK has no class for it.
class InvalidRedirectUriError extends OAuthError {
  static errorCode = 'invalid_redirect_uri';
}

// Reads the OAuth settings from env, the settings as src/config.mjs resolved them, and the
// serve flags (flags win). Returns
// { config } when OAuth is on, { config: null, missing } when something is left out, and
// { problems } when a value is wrong.
export function oauthConfig({ env = process.env, flags = {} } = {}) {
  const pick = (flag, name) => {
    const v = flag ?? env[name];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  };
  const values = {
    publicUrl: pick(flags.publicUrl, 'WARIFURI_PUBLIC_URL'),
    githubClientId: pick(undefined, 'WARIFURI_GITHUB_CLIENT_ID'),
    githubClientSecret: pick(undefined, 'WARIFURI_GITHUB_CLIENT_SECRET'),
    githubUser: pick(flags.githubUser, 'WARIFURI_GITHUB_USER'),
  };
  const missing = NEEDED.filter(([k]) => values[k] === undefined).map(([, label]) => label);
  if (missing.length) return { config: null, missing };
  const problems = [];
  const githubId = pick(undefined, 'WARIFURI_GITHUB_ID');
  if (githubId !== undefined && !/^[1-9][0-9]{0,19}$/.test(githubId)) problems.push('the GitHub id must be a number');
  const extraHosts = (pick(undefined, 'WARIFURI_REDIRECT_HOSTS') ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  for (const h of extraHosts) {
    if (!/^[a-z0-9.-]+$/.test(h) || h.startsWith('.') || h.endsWith('.')) problems.push(`the redirect host ${h} must be a host name only`);
  }
  let url;
  try {
    url = new URL(values.publicUrl);
  } catch {
    problems.push('the public URL is not a URL');
  }
  if (url) {
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
      problems.push('the public URL must be https (plain http only on localhost)');
    }
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
      problems.push('the public URL must be an origin only, such as https://example.org, with no path');
    }
  }
  if (!/^[A-Za-z0-9-]{1,39}$/.test(values.githubUser)) problems.push('the GitHub user must be one GitHub login');
  if (problems.length) return { config: null, problems };
  return { config: { ...values, publicUrl: url.origin, githubId, redirectHosts: [...new Set([...REDIRECT_HOSTS, ...extraHosts])] } };
}

const str = (v) => (typeof v === 'string' ? v : '');
// Control and invisible formatting characters (bidi overrides among them) are dropped.
const printable = (s) => String(s).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '');

// A client's self-declared name, as stored: printable, at most 64 characters, or none.
export function cleanClientName(name) {
  if (typeof name !== 'string') return undefined;
  const clean = Array.from(printable(name).trim()).slice(0, CLIENT_NAME_MAX).join('').trim();
  return clean === '' ? undefined : clean;
}

const withoutSlash = (u) => String(u).replace(/#.*$/, '').replace(/\/$/, '');

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STYLE =
  'body{font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.7;color:#222;background:#fff}' +
  'h1{font-size:1.3rem}code{background:#f2f2f2;padding:0 .3em;border-radius:3px;word-break:break-all}' +
  'label{display:block;margin-top:1rem}select,input{font:inherit;padding:.3rem;width:100%;box-sizing:border-box}' +
  '.buttons{margin-top:1.5rem;display:flex;gap:.8rem}button{font:inherit;padding:.4rem 1.2rem}.error{color:#a00}';

// Sends a small HTML page. body is HTML already escaped by the caller.
function sendPage(res, status, title, body) {
  res.status(status);
  res.set({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    // No form-action here: browsers apply it to the redirect after the form, and that
    // redirect goes to the client's own address.
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  res.send(
    `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`,
  );
}

function plainPage(res, status, title, text) {
  sendPage(res, status, title, `<p>${escapeHtml(text)}</p>`);
}

// The value of one cookie from the request, or ''.
function readCookie(req, name) {
  for (const part of str(req.headers.cookie).split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

// Builds the provider for the SDK (OAuthServerProvider), the GitHub callback and the consent
// page, and the bearer check for /mcp. github: { webUrl, apiUrl, fetch } lets tests stand in
// for GitHub. Returns { router, bearer }.
export function createOAuth({ ledger, config, github = {}, log }) {
  const issuer = new URL(config.publicUrl);
  const resourceUrl = new URL('/mcp', issuer);
  const callbackUrl = new URL(CALLBACK_PATH, issuer).href;
  const webUrl = withoutSlash(github.webUrl ?? 'https://github.com');
  const apiUrl = withoutSlash(github.apiUrl ?? 'https://api.github.com');
  const fetchFn = github.fetch ?? globalThis.fetch;
  const secure = issuer.protocol === 'https:';
  // __Host- keeps the cookie to this exact host over HTTPS; browsers refuse it over http.
  const cookieName = secure ? '__Host-warifuri_oauth' : 'warifuri_oauth';
  const allowedLogin = config.githubUser.toLowerCase();
  const redirectHosts = new Set(config.redirectHosts ?? REDIRECT_HOSTS);
  const store = ledger.oauth;

  function setCookie(res, value) {
    res.cookie(cookieName, value, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: PENDING_MS });
  }
  function clearCookie(res) {
    res.clearCookie(cookieName, { httpOnly: true, sameSite: 'lax', secure, path: '/' });
  }

  function checkResource(resource) {
    if (resource !== undefined && withoutSlash(resource) !== withoutSlash(resourceUrl)) {
      throw new InvalidTargetError(`this server only issues tokens for ${resourceUrl.href}`);
    }
  }

  const clientsStore = {
    getClient: (clientId) => store.getClient(clientId),
    // Redirect URIs: http on a loopback host, or https on one of the allowed hosts; no
    // fragment and no user. Every error redirect from /authorize goes to one of these, so
    // they cannot send the browser anywhere else.
    registerClient(info) {
      for (const uri of info.redirect_uris) {
        const u = new URL(uri);
        const ok =
          !u.hash && !u.username && !u.password &&
          ((u.protocol === 'http:' && LOOPBACK.has(u.hostname)) || (u.protocol === 'https:' && redirectHosts.has(u.hostname)));
        if (!ok) {
          throw new InvalidRedirectUriError(`redirect_uris must be http on localhost or https on ${[...redirectHosts].join(', ')}, without a fragment`);
        }
      }
      const { client_name: _n, ...rest } = info;
      const name = cleanClientName(info.client_name);
      return store.registerClient(name === undefined ? rest : { ...rest, client_name: name });
    },
  };

  const provider = {
    clientsStore,

    // Called by the SDK after it has found the client, matched the redirect URI (loosely, for
    // loopback ports) and required PKCE S256. warifuri asks for the exact registered URI.
    async authorize(client, params, res) {
      if (!client.redirect_uris.includes(params.redirectUri)) {
        plainPage(res, 400, 'つなげません', '戻り先の URL が、登録されたものと一致しません。');
        return;
      }
      if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidRequestError('code_challenge must be an S256 challenge');
      checkResource(params.resource?.href);
      const { id, githubState } = store.createPending({
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        scopes: params.scopes ?? [],
        state: params.state,
      });
      setCookie(res, id);
      // No scope: the login is public, and an empty scope grants nothing more.
      const to = new URL(`${webUrl}/login/oauth/authorize`);
      to.search = new URLSearchParams({ client_id: config.githubClientId, redirect_uri: callbackUrl, state: githubState, allow_signup: 'false' }).toString();
      res.redirect(302, to.href);
    },

    async challengeForAuthorizationCode(client, code) {
      const challenge = store.codeChallenge(client.client_id, code);
      if (!challenge) throw new InvalidGrantError('invalid authorization code');
      return challenge;
    },

    async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
      checkResource(resource?.href);
      const out = store.exchangeCode(client.client_id, code, redirectUri);
      if (out.error) throw new InvalidGrantError(out.message);
      return out.tokens;
    },

    async exchangeRefreshToken(client, refreshToken, scopes, resource) {
      checkResource(resource?.href);
      const out = store.exchangeRefresh(client.client_id, refreshToken, scopes);
      if (out.error === 'invalid_scope') throw new InvalidScopeError(out.message);
      if (out.error) throw new InvalidGrantError(out.message);
      return out.tokens;
    },

    // Both kinds of bearer resolve to a device: a device key (wf_…) or an access token.
    async verifyAccessToken(token) {
      if (token.startsWith('wf_')) {
        const device = ledger.deviceForKey(token);
        if (!device) throw new InvalidTokenError('invalid token');
        // Device keys do not expire; the SDK asks for an expiry, so this one is nominal.
        return { token, clientId: 'device-key', scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 60, resource: resourceUrl, extra: { device: device.name } };
      }
      const access = store.verifyAccess(token);
      if (!access) throw new InvalidTokenError('invalid or expired token');
      return {
        token,
        clientId: access.client_id,
        scopes: access.scopes,
        expiresAt: Math.floor(Date.parse(access.expires_at) / 1000),
        resource: resourceUrl,
        extra: { device: access.device },
      };
    },

    async revokeToken(client, request) {
      store.revokeToken(client.client_id, request.token);
    },
  };

  // Sends the browser back to the client with the given parameters and its original state.
  function backToClient(res, pending, params) {
    const to = new URL(pending.redirect_uri);
    for (const [k, v] of Object.entries(params)) to.searchParams.set(k, v);
    if (pending.state) to.searchParams.set('state', pending.state);
    res.redirect(302, to.href);
  }

  // Exchanges GitHub's code and reads the user ({ login, id }). GitHub's token lives only
  // inside this call.
  async function githubLogin(code) {
    const signal = AbortSignal.timeout(GITHUB_TIMEOUT_MS);
    const tokenRes = await fetchFn(`${webUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'warifuri' },
      body: new URLSearchParams({ client_id: config.githubClientId, client_secret: config.githubClientSecret, code, redirect_uri: callbackUrl }).toString(),
      signal,
    });
    if (!tokenRes.ok) throw new Error(`GitHub's token endpoint answered ${tokenRes.status}`);
    const grant = await tokenRes.json();
    if (typeof grant.access_token !== 'string') throw new Error(`GitHub refused the code (${str(grant.error) || 'no token'})`);
    const userRes = await fetchFn(`${apiUrl}/user`, {
      headers: {
        Authorization: `Bearer ${grant.access_token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'warifuri',
      },
      signal,
    });
    if (!userRes.ok) throw new Error(`GitHub's user endpoint answered ${userRes.status}`);
    const user = await userRes.json();
    if (typeof user.login !== 'string' || user.login === '') throw new Error('GitHub gave no login');
    if (!Number.isSafeInteger(user.id) || user.id <= 0) throw new Error('GitHub gave no user id');
    return { login: user.login, id: String(user.id) };
  }

  // Whether the GitHub user is the allowed person. With WARIFURI_GITHUB_ID only the id counts.
  // Without it, the first login whose name matches pins its id, and from then on only the id
  // counts: someone who later takes over the same name is refused.
  function isAllowed(user) {
    if (config.githubId) return user.id === config.githubId;
    const pinned = store.githubId();
    if (pinned) return user.id === pinned.id;
    if (user.login.toLowerCase() !== allowedLogin) return false;
    return store.pinGithubId(user.id, user.login) === user.id;
  }

  function renderConsent(res, status, id, pending, { error = '', typed = '', selected = '' } = {}) {
    const csrf = store.newCsrf(id);
    const client = store.getClient(pending.client_id);
    const name = client?.client_name || pending.client_id;
    const host = new URL(pending.redirect_uri).host;
    const options = ledger
      .listDevices()
      .filter((d) => d.revoked_at === null)
      .map((d) => `<option value="${escapeHtml(d.name)}"${d.name === selected ? ' selected' : ''}>${escapeHtml(d.name)}</option>`)
      .join('');
    sendPage(
      res,
      status,
      'warifuri への接続の許可',
      `<p><strong>${escapeHtml(name)}</strong>(アプリが自分で名乗った名前)が、${escapeHtml(pending.github_login)} として warifuri のデータベースを使おうとしています。` +
        `戻り先は <strong>${escapeHtml(host)}</strong> です。</p>` +
        `<p>許可すると、このアプリはデータベースの全部を読めます。名前はアプリが自由に名乗れるので、戻り先の <code>${escapeHtml(pending.redirect_uri)}</code> に心当たりがあるかで確かめてください。心当たりがなければ断ってください。</p>` +
        (error ? `<p class="error">${escapeHtml(error)}</p>` : '') +
        `<form method="post" action="${CONSENT_PATH}">` +
        `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` +
        `<label>この機械のデバイス<select name="device"><option value="">(選ばない)</option>${options}</select></label>` +
        `<label>新しいデバイスの名前(書いたときはこちらを使います。英数字と . _ - の 1〜64 文字)` +
        `<input type="text" name="new_device" maxlength="64" value="${escapeHtml(typed)}" autocomplete="off"></label>` +
        `<div class="buttons"><button type="submit" name="action" value="approve">許可する</button>` +
        `<button type="submit" name="action" value="deny">断る</button></div></form>`,
    );
  }

  // The rate-limit key for a request naming clientId: the client when it is registered, or one
  // shared key for everything else (unknown clients are refused anyway).
  function clientKey(clientId) {
    return typeof clientId === 'string' && store.getClient(clientId) ? `client:${clientId}` : 'unknown-client';
  }

  const router = express.Router();
  // The SDK limits each endpoint by the caller's address. Behind a tunnel every caller has the
  // tunnel's address unless `trust proxy` is set (createApp), so the endpoints a registered
  // client calls are limited per client instead: a stranger's flood of /token, /authorize or
  // /revoke requests spends the budget of unknown clients, not the owner's. /register has no
  // client yet and keeps its own budget per address.
  const byClient = { rateLimit: { keyGenerator: (req) => clientKey(req.body?.client_id ?? req.query?.client_id) } };
  router.use(
    mcpAuthRouter({
      provider,
      issuerUrl: issuer,
      resourceServerUrl: resourceUrl,
      resourceName: 'warifuri',
      authorizationOptions: byClient,
      tokenOptions: byClient,
      revocationOptions: byClient,
    }),
  );

  router.get(CALLBACK_PATH, async (req, res) => {
    const id = readCookie(req, cookieName);
    const pending = store.takeGithubState(id, str(req.query.state));
    if (!pending) {
      plainPage(res, 400, 'ログインを続けられません', 'warifuri から始めたログインの続きではないか、時間が切れています。ハーネスからつなぎ直してください。');
      return;
    }
    const code = str(req.query.code);
    if (!code || req.query.error !== undefined) {
      store.deletePending(id);
      clearCookie(res);
      backToClient(res, pending, { error: 'access_denied' });
      return;
    }
    let user;
    try {
      user = await githubLogin(code);
    } catch (err) {
      log(`warifuri: GitHub login failed: ${err.message}`);
      store.deletePending(id);
      clearCookie(res);
      plainPage(res, 502, 'ログインを続けられません', 'GitHub に本人の確認を頼めませんでした。少し待ってから、つなぎ直してください。');
      return;
    }
    if (!isAllowed(user)) {
      store.deletePending(id);
      clearCookie(res);
      plainPage(res, 403, 'このサーバーは使えません', 'このサーバーを使えるのは、設定された1人の GitHub ユーザーだけです。');
      return;
    }
    store.setPendingLogin(id, user.login);
    res.redirect(303, CONSENT_PATH);
  });

  router.get(CONSENT_PATH, (req, res) => {
    const id = readCookie(req, cookieName);
    const pending = store.getPending(id);
    if (!pending || !pending.github_login) {
      plainPage(res, 400, '許可の画面を開けません', '時間が切れたか、GitHub でのログインがまだです。ハーネスからつなぎ直してください。');
      return;
    }
    renderConsent(res, 200, id, pending);
  });

  router.post(CONSENT_PATH, express.urlencoded({ extended: false, limit: '8kb' }), (req, res) => {
    const id = readCookie(req, cookieName);
    const body = req.body ?? {};
    if (!store.checkCsrf(id, str(body.csrf))) {
      plainPage(res, 403, '許可を受けつけられません', '確認の印が合わないか、時間が切れています。ハーネスからつなぎ直してください。');
      return;
    }
    const pending = store.getPending(id);
    if (body.action !== 'approve') {
      store.deletePending(id);
      clearCookie(res);
      backToClient(res, pending, { error: 'access_denied' });
      return;
    }
    const typed = str(body.new_device).trim();
    const device = typed || str(body.device);
    const actor = `github:${pending.github_login}`;
    if (!device) {
      renderConsent(res, 400, id, pending, { error: 'デバイスを選ぶか、新しい名前を書いてください。' });
      return;
    }
    if (ledger.listDevices().some((d) => d.name === device && d.revoked_at !== null)) {
      renderConsent(res, 400, id, pending, { error: `デバイス ${device} は取り消されています。別の名前を書いてください。`, typed });
      return;
    }
    try {
      ledger.addDevice(device, { actor });
    } catch (err) {
      if (!(err instanceof LedgerError)) throw err;
      renderConsent(res, 400, id, pending, { error: err.problems.join(' / '), typed, selected: str(body.device) });
      return;
    }
    const out = store.approve(id, device, { actor });
    clearCookie(res);
    if (!out) {
      plainPage(res, 400, '許可を受けつけられません', '時間が切れています。ハーネスからつなぎ直してください。');
      return;
    }
    backToClient(res, out, { code: out.code });
  });

  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
    expectedResource: resourceUrl,
  });
  return { router, bearer, resourceUrl };
}
