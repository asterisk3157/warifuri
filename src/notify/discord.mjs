// Discord: posts to the person's one channel with a bot, with buttons when there are; answers a
// button pressed; shows that a reply is being written. What the person writes comes in over
// the gateway (src/notify/gateway.mjs). The token is a secret setting; its file may hold the
// token alone or a DISCORD_BOT_TOKEN= line. Nobody but the person can be pinged, whatever the
// text.

const API = 'https://discord.com/api/v10';
export const DISCORD_MAX = 2000;

// The token from the setting's value: a DISCORD_BOT_TOKEN= line, or the value itself.
export function botToken(value) {
  const text = typeof value === 'string' ? value : '';
  const line = /^DISCORD_BOT_TOKEN=(.+)$/m.exec(text);
  return (line ? line[1] : text).trim() || null;
}

export const clip = (text, max) => {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
};

// Text longer than Discord takes, cut into messages at line ends where it can.
export function chunks(text, max = DISCORD_MAX) {
  const out = [];
  let rest = [...text];
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).join(''));
    rest = rest.slice(rest[cut] === '\n' ? cut + 1 : cut);
  }
  out.push(rest.join(''));
  return out;
}

// { post(content, { mention, files, components }), respond(interaction, body), typing() },
// or null when the token or the channel is not set.
export function createDiscord({ token, channel, user = null, fetch = globalThis.fetch }) {
  const key = botToken(token);
  if (!key || !channel) return null;
  // files: [{ name, data (Buffer), type }], attached to the message.
  const call = async (url, init) => {
    const res = await fetch(url, init);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`Discord: ${res.status} ${body.message ?? ''}`.trim());
    }
    return res.status === 204 ? {} : res.json().catch(() => ({}));
  };
  const json = (body) => ({ method: 'POST', headers: { Authorization: `Bot ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  async function post(content, { mention = false, files = [], components = [] } = {}) {
    const ping = mention && user;
    const text = clip((ping ? `<@${user}> ` : '') + content, DISCORD_MAX);
    const payload = { content: text, allowed_mentions: { parse: [], users: ping ? [String(user)] : [] }, ...(components.length ? { components } : {}) };
    let init;
    if (files.length) {
      const form = new FormData();
      form.append('payload_json', JSON.stringify({ ...payload, attachments: files.map((f, i) => ({ id: i, filename: f.name })) }));
      files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.data], { type: f.type }), f.name));
      init = { method: 'POST', headers: { Authorization: `Bot ${key}` }, body: form };
    } else {
      init = json(payload);
    }
    return call(`${API}/channels/${encodeURIComponent(channel)}/messages`, init);
  }
  // The answer to a button pressed or a choice made (an interaction): body is Discord's
  // interaction response ({ type, data }). It needs no bot token: the interaction's own
  // token says who may answer it.
  async function respond(interaction, body) {
    const url = `${API}/interactions/${encodeURIComponent(interaction.id)}/${encodeURIComponent(interaction.token)}/callback`;
    return call(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  // "Writing…" in the channel, for about ten seconds.
  async function typing() {
    return call(`${API}/channels/${encodeURIComponent(channel)}/typing`, { method: 'POST', headers: { Authorization: `Bot ${key}` } });
  }
  return { post, respond, typing, channel: String(channel), user: user ? String(user) : null };
}
