// 呼び出し(原則17): what in the secretary's conversation needs the person, sent to Discord.
// Three things go: the secretary's questions, the morning report, and the runs that failed.
// Replies to what the person wrote are not sent: they are on the screen the person is using.
// Nothing goes in the night; what came then goes once the night is over, oldest first.
//
// The notifier reads the conversation after the last message it handled (kept in a file in
// the data directory), so a restart neither loses nor repeats anything. The first time it
// runs it starts from the newest message: what was said before is not sent.

import fs from 'node:fs';
import path from 'node:path';
import { inNight } from '../secretary/schedule.mjs';
import { clip } from './discord.mjs';

const BODY_MAX = 1500;

// The text to send for one message, or null when it is not sent.
export function noticeOf(m, link) {
  const tail = link ? `\n${link}` : '';
  if (m.kind === 'ask' && m.state === 'open') {
    const lines = (m.data?.questions ?? []).map((q) => `【${q.header}】${q.question}`);
    return { text: `秘書から質問があります。\n${lines.join('\n')}${tail}`, mention: true };
  }
  if (m.role === 'secretary' && m.data?.scheduled === 'morning') {
    return { text: `朝の報告です。\n${clip(m.body, BODY_MAX)}${tail}`, mention: false };
  }
  if (m.role === 'system' && m.data?.failure) return { text: `${m.body}${tail}`, mention: true };
  return null;
}

// discord: { post } (src/notify/discord.mjs). night: the secretary's night ({ start, end }).
export function createNotifier({ ledger, discord, file, publicUrl = null, night = null, now = () => new Date(), log = () => {} }) {
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

  // Sends what came since the last call. Resolves to the number sent.
  async function tick() {
    if (!discord || running) return 0;
    if (night && !night.error && inNight(night, now())) return 0;
    const thread = ledger.getThread();
    if (!thread) return 0;
    running = true;
    let sent = 0;
    try {
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
        return 0;
      }
      for (const m of list) {
        // The same failure again, with no reply in between, is not sent twice.
        if (m.role === 'secretary') state.failure = null;
        const failure = m.role === 'system' ? m.data?.failure ?? null : null;
        const notice = failure && failure === state.failure ? null : noticeOf(m, link);
        if (notice) {
          try {
            await discord.post(notice.text, { mention: notice.mention });
            sent += 1;
            if (failure) state.failure = failure;
          } catch (err) {
            log(`discord: not sent, tried again later: ${err.message}`);
            break;
          }
        }
        state.last = m.id;
        write({ started: true, last: m.id, failure: state.failure ?? null });
      }
      return sent;
    } finally {
      running = false;
    }
  }
  return { tick };
}
