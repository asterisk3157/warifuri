// The Discord gateway: the bot's live connection, over which Discord says what happens in the
// channel (a message written, a button pressed). Only what warifuri reads is asked for:
// messages in servers and their text, and direct messages. The connection says hello, beats
// at the pace Discord gives, and comes back after a drop, resuming where it was when it can.
//
// createGateway({ token, onEvent(type, data), log }) → { start(), stop() }. onEvent is called
// for every dispatch (MESSAGE_CREATE, INTERACTION_CREATE, …); an error in it is logged, not
// thrown. A token Discord refuses, or intents it does not allow, stop the connection for good.

import { botToken } from './discord.mjs';

const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
// GUILD_MESSAGES, DIRECT_MESSAGES, MESSAGE_CONTENT.
export const INTENTS = (1 << 9) | (1 << 12) | (1 << 15);
// Close codes after which connecting again cannot help.
const FATAL = new Map([
  [4004, 'Discord がボットのトークンを受けつけませんでした'],
  [4013, 'Discord に頼んだ受け取りの種類が正しくありません'],
  [4014, 'Discord の Developer Portal で、ボットの Message Content Intent を有効にしてください'],
]);

export function createGateway({ token, onEvent, log = () => {}, WebSocketImpl = globalThis.WebSocket, retryMs = 5000 }) {
  const key = botToken(token);
  if (!key || !WebSocketImpl) return null;
  let ws = null;
  let beat = null;
  let first = null;
  let acked = true;
  let seq = null;
  let session = null;
  let resumeUrl = null;
  let stopped = false;
  let retry = null;
  let tries = 0;

  const send = (op, d) => {
    if (ws?.readyState === 1) ws.send(JSON.stringify({ op, d }));
  };
  const clearBeat = () => {
    clearTimeout(first);
    clearInterval(beat);
    first = null;
    beat = null;
  };

  function connect(resume) {
    if (stopped) return;
    const url = resume && resumeUrl ? `${resumeUrl.replace(/\/$/, '')}/?v=10&encoding=json` : GATEWAY;
    const me = new WebSocketImpl(url);
    ws = me;
    me.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.s !== null && msg.s !== undefined) seq = msg.s;
      switch (msg.op) {
        case 10: {
          // Hello: beat at the given pace (the first one after a random part of it), then
          // say who we are, or pick up the session that dropped.
          clearBeat();
          acked = true;
          const every = msg.d.heartbeat_interval;
          first = setTimeout(() => send(1, seq), Math.floor(Math.random() * every));
          beat = setInterval(() => {
            if (!acked) {
              me.close(4000, 'no heartbeat ack');
              return;
            }
            acked = false;
            send(1, seq);
          }, every);
          if (resume && session) send(6, { token: key, session_id: session, seq });
          else send(2, { token: key, intents: INTENTS, properties: { os: process.platform, browser: 'warifuri', device: 'warifuri' } });
          break;
        }
        case 11:
          acked = true;
          break;
        case 1:
          send(1, seq);
          break;
        case 7:
          me.close(4000, 'reconnect asked');
          break;
        case 9:
          // The session cannot be resumed (d false): start a new one.
          if (!msg.d) {
            session = null;
            seq = null;
          }
          me.close(4000, 'invalid session');
          break;
        case 0:
          if (msg.t === 'READY') {
            session = msg.d.session_id;
            resumeUrl = msg.d.resume_gateway_url ?? null;
            tries = 0;
            log('discord: connected; what the person writes in the channel goes to the secretary');
          } else if (msg.t === 'RESUMED') {
            tries = 0;
          }
          Promise.resolve()
            .then(() => onEvent(msg.t, msg.d))
            .catch((err) => log(`discord: ${msg.t}: ${err.message}`));
          break;
        default:
      }
    };
    me.onclose = (ev) => {
      if (ws === me) ws = null;
      clearBeat();
      if (stopped) return;
      const fatal = FATAL.get(ev.code);
      if (fatal) {
        log(`discord: stopped listening: ${fatal}`);
        stopped = true;
        return;
      }
      tries += 1;
      const wait = Math.min(retryMs * 2 ** Math.min(tries - 1, 5), 5 * 60_000);
      retry = setTimeout(() => connect(Boolean(session)), wait);
    };
    me.onerror = () => {};
  }

  return {
    start() {
      stopped = false;
      connect(false);
    },
    stop() {
      stopped = true;
      clearTimeout(retry);
      clearBeat();
      ws?.close(1000, 'stop');
      ws = null;
    },
  };
}
