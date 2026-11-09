// 呼び出し(原則17): what in the secretary's conversation needs the person, sent to Discord.
// Three things go: the secretary's questions (with their choices as buttons), the morning
// report, and the runs that failed. A calendar under the message (show_calendar) goes with it
// as a picture.
// The secretary's replies go too while the person talks from Discord: when what the person
// last wrote came from Discord (src/notify/discord-chat.mjs), within TALK_MS. Replies to what
// was written on the screen stay on the screen.
// With mirror (talking in Discord is on), Discord holds the whole conversation, as the screen
// does: what the person writes on the screen is copied there, marked WEB_MARK, and the replies
// to it go there too.
// Nothing goes in the night, but while the person is talking; what came then goes once the
// night is over, oldest first.
// A thread of the conversation opened in Discord (threads, src/notify/discord-threads.mjs)
// is a talk of its own: everything said in it goes to its Discord thread, as with mirror,
// at night too: the person started it. A thread opened on the screen gets a Discord thread
// once something is said in it: from the Discord message its first message went as, or on its
// own (with the first message quoted) when that message did not go to Discord.
//
// The notifier reads the conversation after the last message it handled (kept in a file in
// the data directory), so a restart neither loses nor repeats anything. The first time it
// runs it starts from the newest message: what was said before is not sent.

import fs from 'node:fs';
import path from 'node:path';
import { inNight } from '../secretary/schedule.mjs';
import { chunks, clip } from './discord.mjs';
import { askMessages, replyComponents } from './discord-chat.mjs';

const BODY_MAX = 1500;
// The first line of a copy of what the person wrote on the screen.
export const WEB_MARK = '(Web から)';
// How long after the person last wrote from Discord the secretary's replies go there too.
export const TALK_MS = 30 * 60 * 1000;

// The text to send for one message ({ text, mention, components }, or { messages: [{ text,
// components }], mention } when it goes as more than one), or null when it is not sent. talking: the person is talking now (from Discord, or anywhere with mirror).
export function noticeOf(m, link, { talking = false, mirror = false } = {}) {
  const tail = link ? `\n${link}` : '';
  if (mirror && m.role === 'user' && m.actor !== 'discord') {
    const words = m.body.trim() || (m.data?.attachments?.length ? 'ファイルを送りました' : '');
    return words ? { text: `${WEB_MARK}\n${words}`, mention: false, whole: true } : null;
  }
  if (m.kind === 'ask' && m.state === 'open') {
    const messages = askMessages(m);
    messages.at(-1).text += tail;
    return { messages, mention: true };
  }
  if (m.role === 'secretary' && m.data?.scheduled === 'morning') {
    return { text: `朝の報告です。\n${clip(m.body, BODY_MAX)}${tail}`, mention: false, components: replyComponents(m) };
  }
  if (m.role === 'system' && m.data?.failure) return { text: `${m.body}${tail}`, mention: true };
  if (talking && m.role === 'secretary' && m.kind === 'text' && m.body.trim()) {
    return { text: m.body, mention: false, whole: true, components: replyComponents(m) };
  }
  return null;
}

// What the person wrote: from Discord or not. Answers count; agents' requests do not.
const personVia = (m) => (m.role === 'user' ? (m.actor === 'discord' ? 'discord' : 'screen') : null);

// discord: { post } (src/notify/discord.mjs). night: the secretary's night ({ start, end }).
// picture(m): the PNG of the calendar under a message (show_calendar), or null; it goes with
// the notice as a file.
// mirror: Discord holds the whole conversation (see above). threads: the Discord threads tied
// to threads of the conversation.
export function createNotifier({ ledger, discord, file, publicUrl = null, night = null, mirror = false, threads = null, now = () => new Date(), log = () => {}, picture = async () => null }) {
  const link = publicUrl ? `${publicUrl.replace(/\/$/, '')}/secretary` : null;
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  };
  const write = (state) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  };
  let running = false;
  // Posts a notice: its messages, or its text (cut when whole), the buttons and the picture
  // under the last part. channel: a thread of the channel, or the channel itself. Resolves to
  // the id of the last Discord message, where the buttons are.
  async function post(notice, png, channel) {
    let last = null;
    const parts = notice.messages
      ?? (notice.whole ? chunks(notice.text) : [notice.text]).map((text, i, all) => ({ text, components: i === all.length - 1 ? notice.components ?? [] : [] }));
    for (const [i, part] of parts.entries()) {
      const lastPart = i === parts.length - 1;
      last = await discord.post(part.text, {
        mention: notice.mention && i === 0,
        files: lastPart && png ? [{ name: 'calendar.png', data: png, type: 'image/png' }] : [],
        components: part.components ?? [],
        ...(channel ? { channel } : {}),
      });
    }
    return last?.id ?? null;
  }

  // A Discord thread for each thread opened on the screen in which something was said since
  // threads were first tied, from the first message's Discord message when it went to Discord.
  async function tieThreads() {
    const since = threads.since();
    for (const [parentId, t] of Object.entries(ledger.threadCounts())) {
      if (threads.channelOf(t.id)) continue;
      const list = ledger.listMessages(t.id);
      const fresh = list.filter((m) => ['user', 'secretary'].includes(m.role) && m.created_at > since);
      if (!fresh.length) continue;
      const thread = ledger.getThread(t.id);
      const parent = ledger.getMessage(parentId);
      const from = threads.posted(parentId);
      let channel = null;
      if (from) channel = await discord.startThread(from, thread.title).catch(() => null);
      if (!channel) {
        channel = await discord.startThread(null, thread.title);
        await discord.post(`秘書のこの発言から始まったスレッドです。\n> ${clip(parent?.body ?? '', 300).replace(/\n/g, '\n> ')}`, { channel: channel.id });
      }
      // What was said before since stays on the screen; the rest goes.
      const before = list.filter((m) => m.created_at <= since).at(-1);
      threads.add(channel.id, t.id, before?.id ?? null);
    }
  }

  // What came in each thread tied to a Discord thread, sent there. Resolves to the number sent.
  async function tickThreads() {
    let sent = 0;
    if (discord.startThread) {
      try {
        await tieThreads();
      } catch (err) {
        log(`discord: a thread not opened, tried again later: ${err.message}`);
      }
    }
    for (const { channel, thread, last } of threads?.list() ?? []) {
      let list;
      try {
        list = last ? ledger.listMessages(thread, { after: last }) : ledger.listMessages(thread, { limit: 200 });
      } catch {
        // The thread or the message it stopped at is gone: start again from now.
        try {
          threads.setLast(channel, ledger.listMessages(thread).at(-1)?.id ?? null);
        } catch {
          // The thread itself is gone: nothing to send.
        }
        continue;
      }
      for (const m of list) {
        const notice = noticeOf(m, null, { talking: true, mirror: true });
        if (notice) {
          try {
            const png = m.data?.calendar ? await picture(m).catch(() => null) : null;
            await post(notice, png, channel);
            sent += 1;
          } catch (err) {
            log(`discord: not sent to the thread, tried again later: ${err.message}`);
            break;
          }
        }
        threads.setLast(channel, m.id);
      }
    }
    return sent;
  }

  // Sends what came since the last call. Resolves to the number sent.
  async function tick() {
    if (!discord || running) return 0;
    const talkingAt = (state) => (mirror || state.via === 'discord') && state.via && state.viaAt && now() - new Date(state.viaAt) < TALK_MS;
    const thread = ledger.getThread();
    if (!thread) return 0;
    running = true;
    let sent = 0;
    try {
      if (threads) sent += await tickThreads();
      const state = read();
      let list;
      try {
        list = ledger.listMessages(thread.id, state.last ? { after: state.last } : {});
      } catch {
        // The message it stopped at is gone: start again from now rather than send it all.
        list = ledger.listMessages(thread.id);
        state.started = false;
      }
      if (!state.started) {
        // The first run: start from now.
        write({ started: true, last: list.at(-1)?.id ?? null });
        return sent;
      }
      // In the night, nothing goes unless the person is talking from Discord now (by what the
      // person wrote last); then all of it goes, in order.
      const newest = [...list].reverse().find((m) => personVia(m));
      const now_ = newest ? { via: personVia(newest), viaAt: newest.created_at } : state;
      if (night && !night.error && inNight(night, now()) && !talkingAt(now_)) return sent;
      const save = () => write({ started: true, last: state.last, failure: state.failure ?? null, via: state.via ?? null, viaAt: state.viaAt ?? null });
      for (const m of list) {
        const via = personVia(m);
        if (via) {
          state.via = via;
          state.viaAt = m.created_at;
        }
        // The same failure again, with no reply in between, is not sent twice.
        if (m.role === 'secretary') state.failure = null;
        const failure = m.role === 'system' ? m.data?.failure ?? null : null;
        const talking = Boolean(talkingAt(state));
        const notice = failure && failure === state.failure ? null : noticeOf(m, talking ? null : link, { talking, mirror });
        if (notice) {
          try {
            const png = m.data?.calendar ? await picture(m).catch(() => null) : null;
            const posted = await post(notice, png);
            if (posted && threads) threads.setPosted(m.id, posted);
            sent += 1;
            if (failure) state.failure = failure;
          } catch (err) {
            log(`discord: not sent, tried again later: ${err.message}`);
            break;
          }
        }
        state.last = m.id;
        save();
      }
      return sent;
    } finally {
      running = false;
    }
  }
  return { tick };
}
