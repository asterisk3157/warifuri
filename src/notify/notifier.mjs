// 呼び出し(原則17): what in the secretary's conversation needs the person, sent to Discord.
// Four things go: the secretary's questions (with their choices as buttons), the morning
// report, what the secretary changed when it planned again on its own (replan), and the runs
// that failed. A calendar under the message (show_calendar) goes with it
// as a picture.
// The secretary's replies go too while the person talks from Discord: when what the person
// last wrote came from Discord (src/notify/discord-chat.mjs), within TALK_MS. Replies to what
// was written on the screen stay on the screen.
// With mirror (talking in Discord is on), Discord holds the whole conversation, as the screen
// does: what the person writes on the screen is copied there, marked WEB_MARK, and the replies
// to it go there too.
// An agent's request (ask_secretary) and the secretary's reply to it are kept in a thread of
// their own (kind 'agent') that the notifier does not read; the secretary's questions (ask)
// still come from the conversation as always.
// warifuri's own notes go too: the tasks due soon and not done (data.deadline, from
// src/secretary/deadlines.mjs) and the tasks the secretary closed without asking
// (data.auto_closed), as does the secretary's reply when the calendar changed under the plan
// (data.alert).
// Nothing goes in the night, but while the person is talking, and the notes marked urgent (a
// deadline within the night); what came then goes once the night is over, oldest first.
// A question the secretary withdrew (state withdrawn) is rewritten in Discord: marked
// 取り下げ済み, its buttons removed. The Discord messages of each question are kept for that.
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
import { askMessages, replyComponents, withdrawnMessages } from './discord-chat.mjs';

const BODY_MAX = 1500;
// How many questions' Discord messages are kept, to rewrite them when withdrawn.
const ASKS_KEPT = 20;
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
  // A replan that came with a change of the calendar under the plan (alert) calls the person.
  if (m.role === 'secretary' && m.data?.scheduled === 'replan' && m.body.trim()) {
    return { text: `計画を組み直しました。\n${clip(m.body, BODY_MAX)}${tail}`, mention: Boolean(m.data?.alert), components: replyComponents(m) };
  }
  if (m.role === 'system' && m.data?.failure) return { text: `${m.body}${tail}`, mention: true };
  if (m.role === 'system' && m.data?.deadline) return { text: `${m.body}${tail}`, mention: true };
  if (m.role === 'system' && m.data?.auto_closed) return { text: `${m.body}${tail}`, mention: false };
  if (m.role === 'secretary' && m.data?.alert && m.body.trim()) {
    return { text: `${clip(m.body, BODY_MAX)}${talking ? '' : tail}`, mention: true, components: replyComponents(m) };
  }
  if (talking && m.role === 'secretary' && m.kind === 'text' && m.body.trim()) {
    return { text: m.body, mention: false, whole: true, components: replyComponents(m) };
  }
  return null;
}

// Who last wrote to the secretary: the person from Discord or the screen. (An agent's request
// and the reply to it are in the agents' thread, which does not go to Discord, nor does the
// line that says a request changed the calendar.)
const viaOf = (m) => {
  if (m.role === 'user') return m.actor === 'discord' ? 'discord' : 'screen';
  return null;
};

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
  // the id of the last Discord message, where the buttons are; ids (when given) takes the id
  // of each.
  async function post(notice, png, channel, ids = null) {
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
      if (ids) ids.push({ id: last?.id ?? null, channel: channel ?? null });
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

  // The questions withdrawn since they were sent, rewritten in Discord. asks: { ask id: [{ id,
  // channel }] }. A question answered is let go; one that cannot be rewritten now is tried
  // again at the next call.
  async function syncAsks(state) {
    for (const [id, posted] of Object.entries(state.asks ?? {})) {
      const ask = ledger.getMessage(id);
      if (!ask || ask.state === 'answered') {
        delete state.asks[id];
        continue;
      }
      if (ask.state !== 'withdrawn') continue;
      try {
        const words = withdrawnMessages(ask);
        for (const [i, p] of posted.entries()) {
          if (!p.id || !discord.edit) continue;
          const w = words[Math.min(i, words.length - 1)];
          await discord.edit(p.id, { content: w.text, components: [], ...(p.channel ? { channel: p.channel } : {}) });
        }
        delete state.asks[id];
      } catch (err) {
        log(`discord: a withdrawn question not rewritten, tried again later: ${err.message}`);
        return;
      }
    }
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
      state.asks ??= {};
      state.urgent ??= [];
      const save = () => write({
        started: true, last: state.last, failure: state.failure ?? null, via: state.via ?? null, viaAt: state.viaAt ?? null,
        asks: state.asks, urgent: state.urgent,
      });
      if (Object.keys(state.asks).length) {
        await syncAsks(state);
        save();
      }
      // In the night, nothing goes unless the person is talking from Discord now (by what the
      // person wrote last); then all of it goes, in order.
      const newest = [...list].reverse().find((m) => viaOf(m));
      const now_ = newest ? { via: viaOf(newest), viaAt: newest.created_at } : state;
      if (night && !night.error && inNight(night, now()) && !talkingAt(now_)) {
        // The urgent notes go now; the rest waits for the morning.
        for (const m of list) {
          if (!m.data?.urgent || state.urgent.includes(m.id)) continue;
          const notice = noticeOf(m, link);
          if (!notice) continue;
          try {
            await post(notice, null);
            sent += 1;
            state.urgent.push(m.id);
            save();
          } catch (err) {
            log(`discord: not sent, tried again later: ${err.message}`);
            break;
          }
        }
        return sent;
      }
      for (const m of list) {
        const via = viaOf(m);
        if (via) {
          state.via = via;
          state.viaAt = m.created_at;
        }
        // The same failure again, with no reply in between, is not sent twice.
        if (m.role === 'secretary') state.failure = null;
        const failure = m.role === 'system' ? m.data?.failure ?? null : null;
        const talking = Boolean(talkingAt(state));
        // An urgent note sent in the night is not sent again.
        const early = state.urgent.includes(m.id);
        if (early) state.urgent = state.urgent.filter((x) => x !== m.id);
        const notice = early || (failure && failure === state.failure) ? null : noticeOf(m, talking ? null : link, { talking, mirror });
        if (notice) {
          try {
            const png = m.data?.calendar ? await picture(m).catch(() => null) : null;
            const ids = m.kind === 'ask' ? [] : null;
            const posted = await post(notice, png, undefined, ids);
            if (ids) {
              state.asks[m.id] = ids;
              const keys = Object.keys(state.asks);
              for (const k of keys.slice(0, Math.max(0, keys.length - ASKS_KEPT))) delete state.asks[k];
            }
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
