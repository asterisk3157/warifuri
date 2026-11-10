// 秘書の入力欄の音声入力: ブラウザの音声認識(Web Speech API)で、話した言葉を入力欄に入れる。
// 聞き取りの途中の言葉も、その場で入力欄に出す。送るのは本人が送るボタンを押したときで、
// 自動では送らない。押すと聞き始め、もう一度押すと止まる。ブラウザが黙ったあとに認識を
// 止めても、本人が止めるまでは聞き直す。聞いているあいだは、マイクの横に声の大きさに合わせて
// 動くバーを出す。音声認識のないブラウザでは、ボタンを出さない(micButton が null を返す)。

import { h, s } from '../ui.js';

const Recognition = typeof window === 'undefined' ? null : window.SpeechRecognition || window.webkitSpeechRecognition || null;

export const voiceSupported = Boolean(Recognition);

const BARS = 5;

// The state of each box, kept by the box's input, since the screen draws the button again and
// again: { rec, base, heard, now, interim, stopping, meter, bars, stream, audio, frame }.
// base: the box's text before listening; heard: the final words of the recognitions that ended
// (Chrome ends one after a silence, and a new one starts); now: the final words of this one.
const sessions = new WeakMap();

const micIcon = () => s('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
  s('rect', { x: 9, y: 3, width: 6, height: 11, rx: 3 }), s('path', { d: 'M5 11a7 7 0 0 0 14 0M12 18v3' }));

// What the box holds before the words: its text, with a space between when it ends in a letter.
const joined = (base, words) => (base && words && !/\s$/.test(base) ? `${base} ` : base) + words;

const show = (input, text) => {
  if (input.value === text) return;
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

// The bars move with the loudness of the microphone. Without microphone access for the meter
// (the recognition may still hear), they move gently, so it is clear the box is listening.
async function startMeter(session) {
  const tick = (levels) => {
    session.bars.forEach((b, i) => { b.style.transform = `scaleY(${Math.max(0.15, Math.min(1, levels[i]))})`; });
  };
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (session.stopping) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const audio = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = audio.createAnalyser();
    analyser.fftSize = 256;
    audio.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    session.stream = stream;
    session.audio = audio;
    const loop = () => {
      analyser.getByteFrequencyData(data);
      // Voices sit in the lower bins: one band of them per bar.
      const band = Math.floor(data.length / 2 / BARS);
      const levels = Array.from({ length: BARS }, (_, i) => {
        let sum = 0;
        for (let k = i * band; k < (i + 1) * band; k += 1) sum += data[k];
        return (sum / band / 255) * 1.8;
      });
      tick(levels);
      session.frame = requestAnimationFrame(loop);
    };
    loop();
  } catch {
    const loop = (t) => {
      tick(Array.from({ length: BARS }, (_, i) => 0.35 + 0.25 * Math.sin(t / 180 + i)));
      session.frame = requestAnimationFrame(loop);
    };
    session.frame = requestAnimationFrame(loop);
  }
}

function stopMeter(session) {
  cancelAnimationFrame(session.frame);
  session.stream?.getTracks().forEach((t) => t.stop());
  session.audio?.close().catch(() => {});
}

export function stopVoice(input) {
  const session = sessions.get(input);
  if (!session) return;
  session.stopping = true;
  session.rec.stop();
}

// The button for a box (input: its textarea). redraw(): the screen draws again; note(text):
// a short sentence under the box (an error), or '' to clear it.
export function micButton(input, { redraw, note, disabled = false }) {
  if (!Recognition) return null;
  const session = sessions.get(input);
  const on = Boolean(session);

  function listen(state) {
    const rec = new Recognition();
    rec.lang = 'ja-JP';
    rec.interimResults = true;
    rec.continuous = true;
    state.rec = rec;
    state.now = '';
    state.interim = '';
    rec.onresult = (e) => {
      // Built again from every result each time: some browsers send a result again, so adding
      // up only the new ones doubles or drops words.
      let final = '';
      let interim = '';
      for (let i = 0; i < e.results.length; i += 1) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      state.now = final;
      state.interim = interim;
      show(input, joined(state.base, state.heard + final + interim));
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        state.stopping = true;
        note('マイクが許可されていません');
      } else if (e.error === 'network') {
        state.stopping = true;
        note('音声認識につながりませんでした');
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        note('聞き取れませんでした');
      }
    };
    rec.onend = () => {
      if (sessions.get(input) !== state) return;
      // A half-heard end is kept when the person stopped (they meant to say it); after a
      // silence the browser has settled it already.
      state.heard += state.now + (state.stopping ? state.interim : '');
      state.now = '';
      state.interim = '';
      if (!state.stopping) {
        // Ended by the browser after a silence: listen again until the person stops it.
        try {
          listen(state);
          return;
        } catch {
          // stop below
        }
      }
      // What was heard stays in the box.
      show(input, joined(state.base, state.heard));
      stopMeter(state);
      sessions.delete(input);
      redraw();
    };
    rec.start();
  }

  const toggle = () => {
    if (sessions.has(input)) {
      stopVoice(input);
      return;
    }
    const bars = Array.from({ length: BARS }, () => h('span', { class: 'wf-voice-bar' }));
    const state = {
      rec: null, base: input.value, heard: '', now: '', interim: '', stopping: false,
      bars, meter: h('span', { class: 'wf-voice-meter', role: 'status', 'aria-label': '音声入力中' }, ...bars),
    };
    sessions.set(input, state);
    note('');
    try {
      listen(state);
    } catch {
      sessions.delete(input);
      note('音声入力を開始できませんでした');
      return;
    }
    startMeter(state);
    redraw();
  };
  const button = h('button', {
    type: 'button', class: ['wf-mic', 'wf-press', on && 'wf-listening'], disabled, aria: { pressed: String(on), label: on ? '音声入力を停止' : '音声入力' },
    title: on ? '音声入力を停止' : '音声入力', onclick: toggle,
  }, micIcon());
  // The meter is the same element on every draw, so its bars keep moving.
  return on ? h('span', { class: 'wf-voice' }, session.meter, button) : button;
}
