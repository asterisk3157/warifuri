// Google Calendar, read with the person's own OAuth client: only what the calendar watch
// (watch.mjs) needs. Reading only (the scope is calendar.readonly); warifuri never writes to
// Google from here.
//
// The client id, the client secret and the refresh token come from the settings
// (WARIFURI_GOOGLE_…; the last two are secrets). The access token is kept in memory only. No
// token is ever put in an error message or a log line: errors carry the HTTP status and
// Google's short reason.
//
// fetch is given by the caller, so tests stand in for Google.

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const API = 'https://www.googleapis.com/calendar/v3';
export const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const TIMEOUT_MS = 30_000;
// A page of events; Google's largest.
const PAGE = 2500;

export class GoogleError extends Error {
  constructor(message, { status = null, reason = null } = {}) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

// { clientId, clientSecret, refreshToken } when all three are set, or null.
export function googleConfig(values) {
  const clientId = values?.WARIFURI_GOOGLE_CLIENT_ID;
  const clientSecret = values?.WARIFURI_GOOGLE_CLIENT_SECRET;
  const refreshToken = values?.WARIFURI_GOOGLE_REFRESH_TOKEN;
  return clientId && clientSecret && refreshToken ? { clientId, clientSecret, refreshToken } : null;
}

const json = async (res) => {
  try {
    return await res.json();
  } catch {
    return {};
  }
};

// Asks Google's token endpoint: the fields of the form are given, the JSON comes back.
export async function tokenRequest(fields, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await json(res);
  if (!res.ok) {
    const reason = typeof body.error === 'string' ? body.error : null;
    throw new GoogleError(`Google refused the login (${res.status}${reason ? ` ${reason}` : ''})`, { status: res.status, reason });
  }
  return body;
}

export function createGoogle({ clientId, clientSecret, refreshToken, fetch: fetchImpl = globalThis.fetch, now = Date.now }) {
  let access = null;

  async function token(fresh) {
    if (!fresh && access && access.until > now()) return access.token;
    const body = await tokenRequest({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }, fetchImpl);
    if (typeof body.access_token !== 'string') throw new GoogleError('Google gave no access token');
    access = { token: body.access_token, until: now() + Math.max(60, Number(body.expires_in) || 3600) * 1000 - 60_000 };
    return access.token;
  }

  // One call of the API. An access token Google no longer takes is renewed once.
  async function call(method, path, { query, body } = {}) {
    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url.toString(), {
        method,
        headers: { Authorization: `Bearer ${await token(attempt > 0)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 401 && attempt === 0) continue;
      if (res.status === 204) return {};
      const out = await json(res);
      if (!res.ok) {
        const reason = out.error?.errors?.[0]?.reason ?? out.error?.status ?? null;
        throw new GoogleError(`Google Calendar answered ${res.status}${reason ? ` (${reason})` : ''}`, { status: res.status, reason });
      }
      return out;
    }
  }

  // Every page of a list: the items, and the sync token of the last page.
  async function pages(path, query) {
    const items = [];
    let pageToken;
    for (;;) {
      const out = await call('GET', path, { query: { ...query, pageToken } });
      items.push(...(out.items ?? []));
      pageToken = out.nextPageToken;
      if (!pageToken) return { items, syncToken: out.nextSyncToken ?? null };
    }
  }

  const eventsPath = (calendarId) => `/calendars/${encodeURIComponent(calendarId)}/events`;

  return {
    // The calendars of the person's list: [{ id, primary, accessRole, deleted, summary }].
    async calendars() {
      const { items } = await pages('/users/me/calendarList', { maxResults: 250, fields: 'nextPageToken,items(id,primary,accessRole,deleted,summary)' });
      return items;
    },
    // The events of a calendar in [from, to), each occurrence of a repeating one by itself.
    async events(calendarId, { from, to }) {
      const { items } = await pages(eventsPath(calendarId), {
        singleEvents: true,
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        maxResults: PAGE,
        fields:
          'nextPageToken,items(id,status,summary,description,location,start,end,transparency,eventType,created,' +
          'organizer(email),creator(email),attendees(self,responseStatus))',
      });
      return items;
    },
    // Whether anything in the calendar changed since syncToken: { changed, syncToken }.
    // Without a token, nothing is compared; only the token to ask with next time is read. A
    // token Google no longer takes throws a GoogleError with status 410.
    async changed(calendarId, syncToken) {
      const out = await pages(eventsPath(calendarId), { maxResults: PAGE, fields: 'nextPageToken,nextSyncToken,items(id)', ...(syncToken ? { syncToken } : {}) });
      return { changed: Boolean(syncToken) && out.items.length > 0, syncToken: out.syncToken };
    },
    // Opens a channel: Google then calls address when the calendar changes. token comes back
    // in each call, so the receiver knows the call is Google's. { resourceId, expiration }.
    async watch(calendarId, { id, token: secret, address, ttlSeconds }) {
      const out = await call('POST', `${eventsPath(calendarId)}/watch`, {
        body: { id, type: 'web_hook', address, token: secret, ...(ttlSeconds ? { params: { ttl: String(ttlSeconds) } } : {}) },
      });
      return { resourceId: out.resourceId ?? null, expiration: Number(out.expiration) || null };
    },
    // Closes a channel.
    async stop({ id, resourceId }) {
      await call('POST', '/channels/stop', { body: { id, resourceId } });
    },
  };
}
