// 秘書の入力欄の音声入力: ブラウザの音声認識(Web Speech API)で、話した言葉を入力欄に入れる。
// 送るのは本人が送るボタンを押したときで、自動では送らない。押すと聞き始め、もう一度押すと
// 止まる。音声認識のないブラウザでは、ボタンを出さない(micButton が null を返す)。

import { h, s } from '../ui.js';

const Recognition = typeof window === 'undefined' ? null : window.SpeechRecognition || window.webkitSpeechRecognition || null;

export const voiceSupported = Boolean(Recognition);

// The state of each box: { rec, base, final }. Kept by the box's input, since the screen draws
// the button again and again.
const sessions = new WeakMap();

const micIcon = () => s('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
  s('rect', { x: 9, y: 3, width: 6, height: 11, rx: 3 }), s('path', { d: 'M5 11a7 7 0 0 0 14 0M12 18v3' }));

// What the box holds before the words: its text, with a space between when it ends in a letter.
const joined = (base, words) => (base && words && !/\s$/.test(base) ? `${base} ` : base) + words;

export function stopVoice(input) {
  sessions.get(input)?.rec.stop();
}

// The button for a box (input: its textarea). redraw(): the screen draws again; note(text):
// a short sentence under the box (an error), or '' to clear it.
export function micButton(input, { redraw, note, disabled = false }) {
  if (!Recognition) return null;
  const on = sessions.has(input);
  const toggle = () => {
    if (sessions.has(input)) {
      stopVoice(input);
      return;
    }
    const rec = new Recognition();
    rec.lang = 'ja-JP';
    rec.interimResults = true;
    rec.continuous = true;
    const session = { rec, base: input.value, final: '' };
    sessions.set(input, session);
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const r = e.results[i];
        if (r.isFinal) session.final += r[0].transcript;
        else interim += r[0].transcript;
      }
      input.value = joined(session.base, session.final + interim);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') note('マイクが許可されていません');
      else if (e.error !== 'no-speech' && e.error !== 'aborted') note('聞き取れませんでした');
    };
    rec.onend = () => {
      // What was heard stays in the box (the final words, without a half-heard end).
      if (sessions.get(input) === session) {
        input.value = joined(session.base, session.final);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        sessions.delete(input);
      }
      redraw();
    };
    note('');
    try {
      rec.start();
    } catch {
      sessions.delete(input);
      note('音声入力を開始できませんでした');
    }
    redraw();
  };
  return h('button', {
    type: 'button', class: ['wf-mic', 'wf-press', on && 'wf-listening'], disabled, aria: { pressed: String(on), label: on ? '音声入力を停止' : '音声入力' },
    title: on ? '音声入力中' : '音声入力', onclick: toggle,
  }, micIcon());
}
