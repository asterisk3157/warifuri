// The Whisper of the voice input, for a browser whose own speech recognition does not work (Arc
// has the Web Speech API but cannot reach Google's speech service). It runs in the browser with
// transformers.js: on the GPU through WebGPU, or on the CPU through WebAssembly without one. The
// voice never leaves the machine; only the model comes from Hugging Face, once, and the browser
// keeps it in the origin's private files. The scripts and the WebAssembly come from warifuri's
// own server.
//
// Messages in: { type: 'load' }, then { type: 'transcribe', id, audio } (16 kHz mono Float32Array).
// Messages out: { type: 'progress', progress } (0 to 100), { type: 'ready', device, model },
// { type: 'error', message }, { type: 'text', id, text } or { type: 'text', id, error }.

import { pipeline, env } from '/web/vendor/transformers.min.js';

env.allowLocalModels = false;

// The model's files are kept in the origin's private files, not the browser's Cache API:
// Chromium's Cache API refuses one response of a few hundred MB ('Unexpected internal error'),
// and the encoder of large-v3-turbo is 1.3 GB, so it would be fetched again every time. A file
// appears only when its writing closes, so a download cut halfway leaves nothing behind.
async function fileCache() {
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('whisper-models', { create: true });
  const nameOf = async (key) => {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(key)));
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  };
  return {
    async match(key) {
      try {
        const file = await (await dir.getFileHandle(await nameOf(key))).getFile();
        // Empty: made for a writing that never closed.
        if (!file.size) return undefined;
        return new Response(file, { headers: { 'content-length': String(file.size) } });
      } catch {
        return undefined;
      }
    },
    async put(key, response) {
      const handle = await dir.getFileHandle(await nameOf(key), { create: true });
      const out = await handle.createWritable();
      try {
        await response.body.pipeTo(out);
      } catch (err) {
        await dir.removeEntry(handle.name).catch(() => {});
        throw err;
      }
    },
  };
}

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
  // Here, not at the top of the module: a message sent while the module still awaits something
  // finds no onmessage and is lost, so the page's 'load' would get no answer.
  try {
    env.customCache = await fileCache();
    env.useCustomCache = true;
  } catch {
    // the browser's Cache API, as transformers.js does by itself
  }
  const pick = await choose();
  let shown = 0;
  // Counted from the files read, not from the 'progress_total' of transformers.js: for an fp16
  // encoder it adds the fp32 one (2.5 GB, never read) to the total, so it stops near 38%. Only the
  // model's files count (the small settings would show 100% before them), and they start together.
  const files = new Map();
  const progress_callback = (p) => {
    if (p.status !== 'progress' || !(p.total >= 1e7)) return;
    files.set(p.file, p);
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    // Keep the number from going back.
    const n = Math.min(99, Math.floor((loaded / total) * 100));
    if (n > shown) {
      shown = n;
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
      // A stretch cut in the middle of a word can send Whisper round in a loop ("研究室の研究室の
      // ..."): no more tokens than a fast speaker says in its length, and a run said three times
      // or more is kept once.
      const seconds = m.audio.length / 16000;
      const max_new_tokens = Math.min(440, Math.ceil(seconds * 12) + 8);
      const out = await asr(m.audio, { language: 'japanese', task: 'transcribe', max_new_tokens });
      const text = String(out?.text ?? '').trim().replace(/(.{2,}?)\1{2,}/gu, '$1');
      self.postMessage({ type: 'text', id: m.id, text });
    } catch (err) {
      self.postMessage({ type: 'text', id: m.id, error: String(err?.message ?? err) });
    }
  }
};
