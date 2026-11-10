// 秘書の入力欄の音声入力: 話した言葉を入力欄に入れる。聞き取りの途中の言葉も、その場で入力欄に
// 出す。送るのは本人が送るボタンを押したときで、自動では送らない。押すと聞き始め、もう一度押すと
// 止まる。聞いているあいだは、マイクの横に声の大きさに合わせて動くバーを出す。
//
// 方式は2つ。Chrome と Safari では、ブラウザの音声認識(Web Speech API)を使い、ブラウザが黙った
// あとに認識を止めても、本人が止めるまでは聞き直す。Web Speech API がないブラウザと、あっても
// 使えないブラウザ(Arc は Google の音声サービスに届かず、毎回 'network' になる)では、ブラウザの
// 中で Whisper を動かす(voice-whisper-worker.js)。一度使えないと分かったブラウザは覚えておき、
// 次からは Whisper にする。Whisper では、マイクの音を 16 kHz で溜め、1.2 秒ごとに今の区切りを
// まるごと文字にして途中の言葉として出し、0.8 秒静かになるか 25 秒を超えたら区切りを確定する。
// どちらも使えないブラウザでは、ボタンを出さない(micButton が null を返す)。

import { h, s } from '../ui.js';

const Recognition = typeof window === 'undefined' ? null : window.SpeechRecognition || window.webkitSpeechRecognition || null;

const canWhisper = typeof window !== 'undefined' && typeof Worker !== 'undefined' && typeof AudioWorkletNode !== 'undefined'
  && Boolean(navigator.mediaDevices?.getUserMedia);

// The browser where the Web Speech API failed with 'network' once: Whisper from then on.
const BROKEN_KEY = 'wf-voice-whisper';
const speechBroken = () => {
  try {
    return localStorage.getItem(BROKEN_KEY) === '1';
  } catch {
    return false;
  }
};
const markBroken = () => {
  try {
    localStorage.setItem(BROKEN_KEY, '1');
  } catch {
    // remembered for this page only
  }
};

export const voiceSupported = Boolean(Recognition) || canWhisper;

const BARS = 5;

// The state of each box, kept by the box's input, since the screen draws the button again and
// again: { kind, base, heard, stopping, meter, bars, stream, audio, frame, ... }. base: the box's
// text before listening; heard: the words settled so far. The Web Speech API adds { rec, now,
// interim }: now, the final words of this recognition (Chrome ends one after a silence, and a new
// one starts). Whisper adds the stretch being heard and the stretches being settled (see below).
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

const tickBars = (session, levels) => {
  session.bars.forEach((b, i) => { b.style.transform = `scaleY(${Math.max(0.15, Math.min(1, levels[i]))})`; });
};

// The bars move with the loudness of the microphone.
function runMeter(session, audio, source) {
  const analyser = audio.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  const loop = () => {
    analyser.getByteFrequencyData(data);
    // Voices sit in the lower bins: one band of them per bar.
    const band = Math.floor(data.length / 2 / BARS);
    const levels = Array.from({ length: BARS }, (_, i) => {
      let sum = 0;
      for (let k = i * band; k < (i + 1) * band; k += 1) sum += data[k];
      return (sum / band / 255) * 1.8;
    });
    tickBars(session, levels);
    session.frame = requestAnimationFrame(loop);
  };
  loop();
}

// For the Web Speech API. Without microphone access for the meter (the recognition may still
// hear), the bars move gently, so it is clear the box is listening.
async function startMeter(session) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (session.stopping) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const audio = new (window.AudioContext || window.webkitAudioContext)();
    session.stream = stream;
    session.audio = audio;
    runMeter(session, audio, audio.createMediaStreamSource(stream));
  } catch {
    const loop = (t) => {
      tickBars(session, Array.from({ length: BARS }, (_, i) => 0.35 + 0.25 * Math.sin(t / 180 + i)));
      session.frame = requestAnimationFrame(loop);
    };
    session.frame = requestAnimationFrame(loop);
  }
}

function stopMeter(session) {
  cancelAnimationFrame(session.frame);
  clearInterval(session.timer);
  session.stream?.getTracks().forEach((t) => t.stop());
  session.audio?.close().catch(() => {});
  session.stream = null;
  session.audio = null;
}

// ---- Whisper in the browser ----

const RATE = 16000;
const EVERY_MS = 1200;
const QUIET = 0.8 * RATE;
const LONGEST = 25 * RATE;
const LOUD = 0.01;

// One worker for the page: the model loads once, and the browser keeps it in its cache.
let whisper = null;

function getWhisper() {
  if (whisper) return whisper;
  const worker = new Worker('/web/pages/voice-whisper-worker.js', { type: 'module' });
  const w = { worker, progress: 0, ready: false, onprogress: null, jobs: new Map(), next: 1 };
  const fail = (err) => {
    for (const job of w.jobs.values()) job.reject(err);
    w.jobs.clear();
    worker.terminate();
    if (whisper === w) whisper = null;
  };
  w.loaded = new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        w.progress = m.progress;
        w.onprogress?.(m.progress);
      } else if (m.type === 'ready') {
        w.ready = true;
        resolve(m);
      } else if (m.type === 'error') {
        reject(new Error(m.message));
        fail(new Error(m.message));
      } else if (m.type === 'text') {
        const job = w.jobs.get(m.id);
        w.jobs.delete(m.id);
        if (m.error) job?.reject(new Error(m.error));
        else job?.resolve(m.text);
      }
    };
    worker.onerror = (e) => {
      e.preventDefault?.();
      const err = new Error(e.message || 'worker');
      reject(err);
      fail(err);
    };
  });
  w.loaded.catch(() => {});
  worker.postMessage({ type: 'load' });
  whisper = w;
  return w;
}

const transcribe = (w, audio) => new Promise((resolve, reject) => {
  const id = w.next;
  w.next += 1;
  w.jobs.set(id, { resolve, reject });
  w.worker.postMessage({ type: 'transcribe', id, audio }, [audio.buffer]);
});

const loadLabel = (p) => `音声認識を準備中 ${p}%`;

// When the browser does not give 16 kHz: the average of each stretch of samples.
function to16k(data, rate) {
  if (rate === RATE) return data;
  const step = rate / RATE;
  const out = new Float32Array(Math.floor(data.length / step));
  for (let i = 0; i < out.length; i += 1) {
    const from = Math.floor(i * step);
    const to = Math.min(data.length, Math.floor((i + 1) * step));
    let sum = 0;
    for (let k = from; k < to; k += 1) sum += data[k];
    out[i] = sum / Math.max(1, to - from);
  }
  return out;
}

function flatten(pieces, length) {
  const out = new Float32Array(length);
  let at = 0;
  for (const p of pieces) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// The Whisper part of a session: pieces and length (the samples of the stretch being heard),
// voiced (someone spoke in it), quiet (samples since the last loud one), sent (length at the last
// interim), gen (the stretch's number), interim (its words so far), settling (gen → the words
// shown for a stretch being settled), inflight (stretches being settled), busy (an interim runs).
function listenWhisper(input, state, { redraw, note }) {
  const w = getWhisper();
  Object.assign(state, {
    kind: 'whisper', pieces: [], length: 0, voiced: false, quiet: 0, sent: 0, gen: 0,
    interim: '', settling: new Map(), inflight: 0, busy: false, loading: !w.ready,
    load: h('span', { class: 'wf-voice-load', role: 'status', text: loadLabel(w.progress) }),
  });
  const alive = () => sessions.get(input) === state;
  const render = () => {
    if (alive()) show(input, joined(state.base, state.heard + [...state.settling.values()].join('') + state.interim));
  };
  const finish = () => {
    if (!alive()) return;
    show(input, joined(state.base, state.heard));
    stopMeter(state);
    w.onprogress = null;
    sessions.delete(input);
    redraw();
  };
  state.finish = finish;
  w.onprogress = (p) => { state.load.textContent = loadLabel(p); };
  w.loaded.then(() => {
    if (!alive()) return;
    state.loading = false;
    redraw();
  }, () => {
    if (!alive()) return;
    note('音声認識を準備できませんでした');
    finish();
  });

  // The stretch so far is settled: its words join the heard ones when Whisper returns them.
  const cut = () => {
    if (state.voiced) {
      const gen = state.gen;
      state.settling.set(gen, state.interim);
      state.inflight += 1;
      transcribe(w, flatten(state.pieces, state.length)).then((text) => {
        state.heard += text;
      }, () => {}).finally(() => {
        state.settling.delete(gen);
        state.inflight -= 1;
        render();
        if (state.stopping && state.inflight === 0) finish();
      });
    }
    Object.assign(state, { pieces: [], length: 0, voiced: false, quiet: 0, sent: 0, interim: '', gen: state.gen + 1 });
  };
  state.cut = cut;

  const take = (piece) => {
    if (state.stopping) return;
    let sum = 0;
    for (let i = 0; i < piece.length; i += 1) sum += piece[i] * piece[i];
    const loud = Math.sqrt(sum / Math.max(1, piece.length)) > LOUD;
    state.pieces.push(piece);
    state.length += piece.length;
    if (loud) {
      state.voiced = true;
      state.quiet = 0;
    } else {
      state.quiet += piece.length;
    }
    // Silence before the first word: only its last half second is kept.
    while (!state.voiced && state.pieces.length > 1 && state.length - state.pieces[0].length >= RATE / 2) {
      state.length -= state.pieces.shift().length;
    }
    if ((state.voiced && state.quiet >= QUIET) || state.length >= LONGEST) cut();
  };

  // The words of the stretch so far, when Whisper is free and something new was heard.
  const interim = () => {
    if (state.loading || state.busy || state.stopping || !state.voiced || state.length === state.sent) return;
    const gen = state.gen;
    state.sent = state.length;
    state.busy = true;
    transcribe(w, flatten(state.pieces, state.length)).then((text) => {
      if (gen !== state.gen) return;
      state.interim = text;
      render();
    }, () => {}).finally(() => { state.busy = false; });
  };

  (async () => {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch {
      note('マイクが許可されていません');
      finish();
      return;
    }
    if (!alive() || state.stopping) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    let audio;
    try {
      audio = new AudioContext({ sampleRate: RATE });
    } catch {
      audio = new AudioContext();
    }
    state.stream = stream;
    state.audio = audio;
    try {
      await audio.audioWorklet.addModule('/web/pages/voice-capture-worklet.js');
      const source = audio.createMediaStreamSource(stream);
      const capture = new AudioWorkletNode(audio, 'wf-capture', { numberOfOutputs: 0 });
      capture.port.onmessage = (e) => take(to16k(e.data, audio.sampleRate));
      source.connect(capture);
      runMeter(state, audio, source);
      state.timer = setInterval(interim, EVERY_MS);
    } catch {
      note('音声入力を開始できませんでした');
      finish();
    }
  })();
}

// ---- The Web Speech API ----

function listenSpeech(input, state, { redraw, note }) {
  const rec = new Recognition();
  rec.lang = 'ja-JP';
  rec.interimResults = true;
  rec.continuous = true;
  Object.assign(state, { kind: 'speech', rec, now: '', interim: '' });
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
    if (e.error === 'network' || e.error === 'service-not-allowed') {
      // The browser has the API but no speech service to reach (Arc): Whisper from now on.
      state.stopping = true;
      if (canWhisper) {
        markBroken();
        state.toWhisper = true;
      } else {
        note('このブラウザでは音声認識を使えません');
      }
    } else if (e.error === 'not-allowed') {
      state.stopping = true;
      note('マイクが許可されていません');
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
    if (state.toWhisper) {
      stopMeter(state);
      state.stopping = false;
      state.toWhisper = false;
      listenWhisper(input, state, { redraw, note });
      redraw();
      return;
    }
    if (!state.stopping) {
      // Ended by the browser after a silence: listen again until the person stops it.
      try {
        listenSpeech(input, state, { redraw, note });
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

export function stopVoice(input) {
  const session = sessions.get(input);
  if (!session) return;
  if (session.kind === 'whisper') {
    // Pressed again while the last words are being settled: stop without them.
    if (session.stopping) {
      session.finish();
      return;
    }
    session.cut();
    session.stopping = true;
    stopMeter(session);
    if (session.inflight === 0) session.finish();
    return;
  }
  session.stopping = true;
  session.rec.stop();
}

// The button for a box (input: its textarea). redraw(): the screen draws again; note(text):
// a short sentence under the box (an error), or '' to clear it.
export function micButton(input, { redraw, note, disabled = false }) {
  if (!voiceSupported) return null;
  const session = sessions.get(input);
  const on = Boolean(session);

  const toggle = () => {
    if (sessions.has(input)) {
      stopVoice(input);
      return;
    }
    const bars = Array.from({ length: BARS }, () => h('span', { class: 'wf-voice-bar' }));
    const state = {
      base: input.value, heard: '', stopping: false,
      bars, meter: h('span', { class: 'wf-voice-meter', role: 'status', 'aria-label': '音声入力中' }, ...bars),
    };
    sessions.set(input, state);
    note('');
    const whisperNow = !Recognition || (canWhisper && speechBroken());
    try {
      if (whisperNow) listenWhisper(input, state, { redraw, note });
      else listenSpeech(input, state, { redraw, note });
    } catch {
      sessions.delete(input);
      note('音声入力を開始できませんでした');
      return;
    }
    if (!whisperNow) startMeter(state);
    redraw();
  };
  const button = h('button', {
    type: 'button', class: ['wf-mic', 'wf-press', on && 'wf-listening'], disabled, aria: { pressed: String(on), label: on ? '音声入力を停止' : '音声入力' },
    title: on ? '音声入力を停止' : '音声入力', onclick: toggle,
  }, micIcon());
  // The meter is the same element on every draw, so its bars keep moving. While the model of
  // Whisper loads, how far it has come shows in its place.
  return on ? h('span', { class: 'wf-voice' }, session.loading ? session.load : session.meter, button) : button;
}
