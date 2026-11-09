// Which Discord thread is which thread of the secretary's conversation (threads, kind 'sub'),
// kept in a file in the data directory:
// { since, threads: { [Discord thread id]: { thread, last } }, posted: { [message]: Discord message } }.
// last: the message of the warifuri thread sent to Discord last, so the notifier sends what
// came after it, once, across restarts. posted: the Discord message each message of the
// conversation went as (the newest POSTED_MAX), so a thread opened on the screen can start
// from it. since: when the file was made; threads opened on the screen go to Discord only when
// something was said in them after it.

import fs from 'node:fs';
import path from 'node:path';

const POSTED_MAX = 300;

export function createThreadMap(file, { now = () => new Date() } = {}) {
  const read = () => {
    let out = {};
    try {
      out = JSON.parse(fs.readFileSync(file, 'utf8')) ?? {};
    } catch {
      // No file yet: an empty map.
    }
    return { since: out.since ?? null, threads: out.threads ?? {}, posted: out.posted ?? {} };
  };
  const write = (all) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify(all)}\n`, { mode: 0o600 });
  };
  const change = (fn) => {
    const all = read();
    fn(all);
    write(all);
  };
  if (!read().since) change((all) => { all.since = now().toISOString(); });
  return {
    since: () => read().since,
    // The warifuri thread of a Discord thread, or null.
    thread: (channel) => read().threads[channel]?.thread ?? null,
    // The Discord thread of a warifuri thread, or null.
    channelOf: (thread) => Object.entries(read().threads).find(([, v]) => v.thread === thread)?.[0] ?? null,
    add(channel, thread, last) {
      change((all) => { all.threads[channel] = { thread, last: last ?? null }; });
    },
    setLast(channel, last) {
      change((all) => {
        if (all.threads[channel]) all.threads[channel].last = last;
      });
    },
    // [{ channel, thread, last }]
    list: () => Object.entries(read().threads).map(([channel, v]) => ({ channel, thread: v.thread, last: v.last ?? null })),
    // The Discord message a message of the conversation went as, or null.
    posted: (message) => read().posted[message] ?? null,
    setPosted(message, discordMessage) {
      change((all) => {
        all.posted[message] = discordMessage;
        const keys = Object.keys(all.posted);
        for (const k of keys.slice(0, Math.max(0, keys.length - POSTED_MAX))) delete all.posted[k];
      });
    },
  };
}
