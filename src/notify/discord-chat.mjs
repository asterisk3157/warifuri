// Talking with the secretary in Discord: what the person writes in the channel goes into the
// secretary's conversation, as if written on the screen; a question of the secretary comes
// with its choices as buttons (a menu when more than one may be picked), and its reply with
// the reply buttons. Pressing one answers there and then. Only the person (the user set) is
// heard: anyone else in the channel, and other bots, are not.
//
// The custom ids of the buttons: wf:a:<ask>:<question>:<option> (a choice), wf:a:<ask>:<question>
// (a menu), wf:l:<ask> (あとで), wf:r:<message>:<n> (a reply button).

import { LedgerError } from '../ledger/ledger.mjs';
import { THREAD_OPTION } from '../ledger/rules.mjs';
import { clip } from './discord.mjs';

const BUTTON = 2;
const MENU = 3;
const ROW = 1;
const STYLE = { primary: 1, secondary: 2, success: 3 };
const LABEL_MAX = 80;
const DESCRIPTION_MAX = 100;
// Interaction responses.
const UPDATE = 7;
const REPLY = 4;
const EPHEMERAL = 64;

const row = (...components) => ({ type: ROW, components });

// The rows under a question of the secretary: one per question (buttons, or a menu when more
// than one may be picked), then あとで. Once answered, a question's row shows what was picked
// and can still be pressed to change it; when all are answered, あとで goes.
// only: the questions to give rows to (by index; all by default); later: whether あとで goes
// under them (while the question is open).
export function askComponents(ask, { only = null, later = true } = {}) {
  const { questions = [], answers = [] } = ask.data ?? {};
  const rows = questions.slice(0, 4).map((q, qi) => {
    if (only && !only.includes(qi)) return null;
    const picked = new Set(answers[qi]?.picked ?? []);
    if (q.multiSelect) {
      return row({
        type: MENU, custom_id: `wf:a:${ask.id}:${qi}`, placeholder: clip(q.header ?? '選ぶ', 150),
        min_values: 1, max_values: q.options.length,
        options: q.options.map((o, oi) => ({
          label: clip(o.label, LABEL_MAX), value: String(oi),
          ...(o.description ? { description: clip(o.description, DESCRIPTION_MAX) } : {}), default: picked.has(o.label),
        })),
      });
    }
    return row(...q.options.slice(0, 5).map((o, oi) => ({
      type: BUTTON, custom_id: `wf:a:${ask.id}:${qi}:${oi}`, label: clip(o.label, LABEL_MAX),
      style: picked.has(o.label) ? STYLE.success : oi === 0 && !picked.size ? STYLE.primary : STYLE.secondary,
    })));
  }).filter(Boolean);
  const label = questions.length > 1 ? 'まとめてあとで' : 'あとで';
  if (later && ask.state === 'open') rows.push(row({ type: BUTTON, custom_id: `wf:l:${ask.id}`, label, style: STYLE.secondary }));
  return rows;
}

// The messages a question of the secretary goes as ({ text, components } each). One question:
// one message, its buttons and あとで under it. More: a message per question, each with its own
// buttons and numbered, so it is clear which buttons answer which; まとめてあとで goes under the
// last one.
export function askMessages(ask) {
  const questions = (ask.data?.questions ?? []).slice(0, 4);
  if (questions.length < 2) return [{ text: askText(ask), components: askComponents(ask) }];
  return questions.map((q, qi) => ({
    text: `${qi === 0 ? `秘書から質問が${questions.length}つあります。\n\n` : ''}質問${qi + 1}【${q.header}】${q.question}`,
    components: askComponents(ask, { only: [qi], later: qi === questions.length - 1 }),
  }));
}

// The rows of a question for the message a button was pressed on: the questions and あとで that
// message had (a message sent before questions went one per message holds them all).
function rowsFor(ask, components = []) {
  const ids = components.flatMap((r) => r.components ?? []).map((c) => String(c.custom_id ?? '').split(':'));
  const only = [...new Set(ids.filter((x) => x[1] === 'a').map((x) => Number(x[3])))];
  return askComponents(ask, { only: only.length ? only : null, later: ids.some((x) => x[1] === 'l') || !only.length });
}

// The reply buttons under a reply of the secretary (reply_options), less the thread pair: a
// thread is opened on the screen.
export function replyComponents(m) {
  const options = m.data?.options ?? [];
  if (!options.length || options.includes(THREAD_OPTION)) return [];
  return [row(...options.map((o, i) => ({ type: BUTTON, custom_id: `wf:r:${m.id}:${i}`, label: clip(o, LABEL_MAX), style: i === 0 ? STYLE.primary : STYLE.secondary })))];
}

// The question as words, for the message the buttons hang under.
export function askText(ask) {
  const lines = (ask.data?.questions ?? []).map((q) => `【${q.header}】${q.question}`);
  return `秘書から質問があります。\n${lines.join('\n')}`;
}

// { onEvent(type, data) } for the gateway. chat: the secretary's conversation
// (src/secretary/chat.mjs); discord: the REST client (src/notify/discord.mjs).
export function createDiscordChat({ chat, ledger, discord, log = () => {} }) {
  const WRITER = { actor: 'discord', device: null };
  const person = (d) => d.member?.user?.id ?? d.user?.id ?? d.author?.id ?? null;
  const say = (d, text) => discord.respond(d, { type: REPLY, data: { content: text, flags: EPHEMERAL } });
  const problemText = (err) => (err instanceof LedgerError ? err.problems.join('\n') : '送れませんでした。もう一度押してください');

  // Shows "writing…" while the secretary replies in the main conversation.
  let typingAt = 0;
  chat.subscribe?.((e) => {
    if (e.type !== 'live' || e.thread !== ledger.getThread()?.id) return;
    if (Date.now() - typingAt < 8000) return;
    typingAt = Date.now();
    discord.typing().catch(() => {});
  });

  async function message(d) {
    if (d.channel_id !== discord.channel || d.author?.bot || person(d) !== discord.user) return;
    const text = String(d.content ?? '').trim();
    if (!text) {
      if (d.attachments?.length) await discord.post('Discord からはファイルを送れません。ファイルは画面から送ってください').catch(() => {});
      return;
    }
    try {
      chat.send(text, WRITER);
      typingAt = Date.now();
      discord.typing().catch(() => {});
      if (d.attachments?.length) await discord.post('文字だけを秘書に渡しました。ファイルは画面から送ってください').catch(() => {});
    } catch (err) {
      await discord.post(problemText(err)).catch(() => {});
    }
  }

  async function interaction(d) {
    if (d.type !== 3) return;
    if (person(d) !== discord.user) {
      await say(d, 'このボタンは使えません');
      return;
    }
    const [tag, kind, id, a, b] = String(d.data?.custom_id ?? '').split(':');
    if (tag !== 'wf') return;
    try {
      if (kind === 'r') {
        const m = ledger.getMessage(id);
        const option = m?.data?.options?.[Number(a)];
        if (!option) throw new LedgerError(['この返事の候補は、もうありません']);
        chat.send(option, WRITER);
        await discord.respond(d, { type: UPDATE, data: { content: clip(`${d.message?.content ?? ''}\n→ ${option}`, 2000), components: [] } });
        return;
      }
      if (kind === 'l') {
        chat.answer(id, { later: true }, WRITER);
      } else if (kind === 'a') {
        const ask = ledger.getMessage(id);
        const q = ask?.data?.questions?.[Number(a)];
        if (!q) throw new LedgerError(['この質問は、もうありません']);
        const picked = b !== undefined ? [q.options[Number(b)]?.label] : (d.data.values ?? []).map((v) => q.options[Number(v)]?.label);
        chat.answer(id, { index: Number(a), picked: picked.filter(Boolean) }, WRITER);
      } else {
        return;
      }
      const ask = ledger.getMessage(id);
      await discord.respond(d, { type: UPDATE, data: { content: d.message?.content ?? askText(ask), components: rowsFor(ask, d.message?.components) } });
    } catch (err) {
      await say(d, problemText(err));
    }
  }

  return {
    async onEvent(type, d) {
      if (type === 'MESSAGE_CREATE') await message(d);
      else if (type === 'INTERACTION_CREATE') await interaction(d);
    },
  };
}
