// Which Discord thread is which thread of the secretary's conversation (threads, kind 'sub'),
// kept in a file in the data directory: { [Discord thread id]: { thread, last } }. last: the
// message of the warifuri thread sent to Discord last (or written there), so the notifier
// sends what came after it, once, across restarts.

import fs from 'node:fs';
import path from 'node:path';

export function createThreadMap(file) {
  const read = () => {
    try {
      const out = JSON.parse(fs.readFileSync(file, 'utf8'));
      return out && typeof out === 'object' ? out : {};
    } catch {
      return {};
    }
  };
  const write = (all) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify(all)}\n`, { mode: 0o600 });
  };
  return {
    // The warifuri thread of a Discord thread, or null.
    thread: (channel) => read()[channel]?.thread ?? null,
    // The Discord thread of a warifuri thread, or null.
    channelOf: (thread) => Object.entries(read()).find(([, v]) => v.thread === thread)?.[0] ?? null,
    add(channel, thread, last) {
      const all = read();
      all[channel] = { thread, last: last ?? null };
      write(all);
    },
    setLast(channel, last) {
      const all = read();
      if (!all[channel]) return;
      all[channel].last = last;
      write(all);
    },
    // [{ channel, thread, last }]
    list: () => Object.entries(read()).map(([channel, v]) => ({ channel, thread: v.thread, last: v.last ?? null })),
  };
}
