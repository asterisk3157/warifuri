// Tests for the voice input of the secretary's box (src/web/pages/secretary-voice.js), with the
// browser's speech recognition faked: it does not stop on a silence, and sending ends it with the
// words heard so far, the half-heard ones too.

import test from 'node:test';
import assert from 'node:assert/strict';

// Just enough of a page for the button and the box.
class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.attrs = {};
    this.children = [];
    this.listeners = {};
    this.style = {};
    this.dataset = {};
    this.textContent = '';
    this.value = '';
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  dispatchEvent(e) { for (const fn of this.listeners[e.type] ?? []) fn(e); }
  append(...nodes) { this.children.push(...nodes); }
  click() { this.dispatchEvent({ type: 'click' }); }
}
globalThis.Node = FakeNode;
globalThis.Event = class { constructor(type) { this.type = type; } };
globalThis.document = {
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (_ns, tag) => new FakeNode(tag),
  createTextNode: (text) => Object.assign(new FakeNode('#text'), { textContent: text }),
};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

// The recognition: the test says what it heard, and when it ends (endsOnStop: as soon as it is
// stopped, as a browser does; false: never, as a browser that hangs).
const made = [];
let endsOnStop = true;
class FakeRecognition {
  constructor() { made.push(this); this.stopped = false; this.aborted = false; }
  start() {}
  stop() {
    this.stopped = true;
    if (endsOnStop) setTimeout(() => this.onend(), 10);
  }
  abort() { this.aborted = true; }
  hear(final, interim = '') {
    const results = [];
    if (final) results.push(Object.assign([{ transcript: final }], { isFinal: true }));
    if (interim) results.push(Object.assign([{ transcript: interim }], { isFinal: false }));
    this.onresult({ results });
  }
}
globalThis.window = { webkitSpeechRecognition: FakeRecognition };

const { micButton, endVoice } = await import('../src/web/pages/secretary-voice.js');

const box = () => {
  const input = new FakeNode('textarea');
  let draws = 0;
  const notes = [];
  const opts = { redraw: () => { draws += 1; }, note: (t) => notes.push(t) };
  return { input, opts, notes, start: () => micButton(input, opts).click(), button: () => micButton(input, opts), draws: () => draws };
};

test('voice: a silence does not end it; the browser ending a recognition starts another', () => {
  made.length = 0;
  const b = box();
  b.input.value = '予定:';
  b.start();
  made[0].hear('明日の午後');
  assert.equal(b.input.value, '予定: 明日の午後');
  // Ended by the browser after a silence: listened to again, the words kept.
  made[0].onend();
  assert.equal(made.length, 2);
  made[1].hear('研究', 'の予定');
  assert.equal(b.input.value, '予定: 明日の午後研究の予定');
  assert.equal(b.button().attrs['aria-pressed'], undefined, 'the button is wrapped with the meter while listening');
});

test('voice: sending stops it and waits for the last words, half-heard ones too', async () => {
  made.length = 0;
  endsOnStop = true;
  const b = box();
  b.start();
  made[0].hear('研究の', '予定を入れて');
  await endVoice(b.input, 1000);
  assert.ok(made[0].stopped);
  assert.equal(b.input.value, '研究の予定を入れて');
  assert.equal(b.button().attrs['aria-pressed'], 'false', 'the voice input is off');
  await endVoice(b.input, 1000); // nothing to end: returns at once
});

test('voice: when the last words do not come in time, the box keeps what it shows', async () => {
  made.length = 0;
  endsOnStop = false;
  const b = box();
  b.start();
  made[0].hear('明日', 'の午後');
  const t0 = Date.now();
  await endVoice(b.input, 50);
  assert.ok(Date.now() - t0 < 1000);
  assert.ok(made[0].aborted);
  assert.equal(b.input.value, '明日の午後');
  assert.equal(b.button().attrs['aria-pressed'], 'false');
  // The box is sent and emptied; a late end of the recognition does not write into it again.
  b.input.value = '';
  made[0].onend();
  assert.equal(b.input.value, '');
  assert.equal(made.length, 1, 'not listened to again');
  endsOnStop = true;
});
