// The microphone's samples for the browser's Whisper: the first channel, sent to the page in
// pieces of a tenth of a second (the worklet hears 128 samples at a time).

class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate / 10);
    this.buf = new Float32Array(this.size);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) {
      for (let i = 0; i < ch.length; i += 1) {
        this.buf[this.n] = ch[i];
        this.n += 1;
        if (this.n === this.size) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(this.size);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('wf-capture', Capture);
