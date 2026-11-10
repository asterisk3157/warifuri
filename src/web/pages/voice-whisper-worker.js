// The Whisper of the voice input, for a browser whose own speech recognition does not work (Arc
// has the Web Speech API but cannot reach Google's speech service). It runs in the browser with
// transformers.js: on the GPU through WebGPU, or on the CPU through WebAssembly without one. The
// voice never leaves the machine; only the model comes from Hugging Face, once, and the browser
// keeps it in its cache. The scripts and the WebAssembly come from warifuri's own server.
//
// Messages in: { type: 'load' }, then { type: 'transcribe', id, audio } (16 kHz mono Float32Array).
// Messages out: { type: 'progress', progress } (0 to 100), { type: 'ready', device, model },
// { type: 'error', message }, { type: 'text', id, text } or { type: 'text', id, error }.

import { pipeline, env } from '/web/vendor/transformers.min.js';

env.allowLocalModels = false;
// The ONNX runtime's WebAssembly from this server, not from a CDN; loaded as a plain module (the
// cache of the runtime turns it into a blob: script, which the page's policy does not allow).
env.useWasmCache = false;
env.backends.onnx.wasm.wasmPaths = {
  mjs: '/web/vendor/ort-wasm-simd-threaded.asyncify.mjs',
  wasm: '/web/vendor/ort-wasm-simd-threaded.asyncify.wasm',
};

// large-v3-turbo on a GPU with 16-bit floats (an M-series Mac has them): its encoder in fp16 and
// its decoder in 4 bits, about 1.6 GB. Without them, whisper-small: lighter, less exact.
async function choose() {
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (adapter?.features.has('shader-f16')) {
      return { device: 'webgpu', model: 'onnx-community/whisper-large-v3-turbo', dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' } };
    }
    if (adapter) return { device: 'webgpu', model: 'onnx-community/whisper-small', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } };
  } catch {
    // the CPU below
  }
  return { device: 'wasm', model: 'onnx-community/whisper-small', dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' } };
}

let asr = null;
let loading = null;

async function load() {
  const pick = await choose();
  let shown = 0;
  const progress_callback = (p) => {
    if (p.status !== 'progress_total') return;
    // The total grows as each file starts: keep the number from going back.
    const n = Math.floor(p.progress);
    if (n > shown) {
      shown = Math.min(n, 99);
      self.postMessage({ type: 'progress', progress: shown });
    }
  };
  asr = await pipeline('automatic-speech-recognition', pick.model, { device: pick.device, dtype: pick.dtype, progress_callback });
  // The first run builds the GPU's programs and is slow: done here, on a second of silence.
  await asr(new Float32Array(16000), { language: 'japanese', task: 'transcribe' });
  return pick;
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'load') {
    loading ??= load();
    try {
      const pick = await loading;
      self.postMessage({ type: 'ready', device: pick.device, model: pick.model });
    } catch (err) {
      loading = null;
      self.postMessage({ type: 'error', message: String(err?.message ?? err) });
    }
  } else if (m.type === 'transcribe') {
    try {
      // Words heard while the model loads wait for it.
      await loading;
      const out = await asr(m.audio, { language: 'japanese', task: 'transcribe' });
      self.postMessage({ type: 'text', id: m.id, text: String(out?.text ?? '').trim() });
    } catch (err) {
      self.postMessage({ type: 'text', id: m.id, error: String(err?.message ?? err) });
    }
  }
};
