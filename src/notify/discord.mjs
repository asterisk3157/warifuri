// Discord: posts to the person's one channel with a bot. Only posting: what the person writes
// in Discord is not read (yet). The token is a secret setting; its file may hold the token
// alone or a DISCORD_BOT_TOKEN= line. Nobody but the person can be pinged, whatever the text.

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

// { post(content, { mention }) }, or null when the token or the channel is not set.
export function createDiscord({ token, channel, user = null, fetch = globalThis.fetch }) {
  const key = botToken(token);
  if (!key || !channel) return null;
  async function post(content, { mention = false } = {}) {
    const ping = mention && user;
    const text = clip((ping ? `<@${user}> ` : '') + content, DISCORD_MAX);
    const res = await fetch(`${API}/channels/${encodeURIComponent(channel)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, allowed_mentions: { parse: [], users: ping ? [String(user)] : [] } }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`Discord: ${res.status} ${body.message ?? ''}`.trim());
    }
    return res.json().catch(() => ({}));
  }
  return { post };
}
