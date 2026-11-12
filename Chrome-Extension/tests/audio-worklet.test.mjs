import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

let Processor;
const posted = [];

class MockAudioWorkletProcessor {
  constructor() {
    this.port = {
      onmessage: null,
      postMessage(message) {
        posted.push(message);
      }
    };
  }
}

const source = await readFile(new URL("../audio-worklet.js", import.meta.url), "utf8");
const context = {
  AudioWorkletProcessor: MockAudioWorkletProcessor,
  Float32Array,
  Math,
  currentFrame: 480,
  sampleRate: 48000,
  registerProcessor(name, implementation) {
    assert.equal(name, "pcm-capture-processor");
    Processor = implementation;
  }
};
vm.runInNewContext(source, context);

const processor = new Processor();
const left = new Float32Array(128).fill(0.25);
const right = new Float32Array(128).fill(-0.25);
for (let index = 0; index < 32; index += 1) {
  assert.equal(processor.process([[left, right]]), true);
  context.currentFrame += 128;
}

assert.equal(posted.length, 1);
assert.equal(posted[0].type, "pcm");
assert.equal(posted[0].left.length, 4096);
assert.equal(posted[0].right.length, 4096);
assert.equal(posted[0].contextStartSeconds, 480 / 48000);

processor.process([[left, right]]);
processor.port.onmessage({ data: { type: "flush" } });
assert.equal(posted.at(-2).type, "pcm");
assert.equal(posted.at(-2).left.length, 128);
assert.equal(posted.at(-2).contextStartSeconds, (480 + 4096) / 48000);
assert.equal(posted.at(-1).type, "flushed");

// Onglet muet : le bloc entamé part aussitôt, daté de son premier échantillon.
const silentFrom = context.currentFrame;
processor.process([[left, right]]);
processor.process([]);
assert.equal(posted.at(-1).type, "pcm");
assert.equal(posted.at(-1).left.length, 128);
assert.equal(posted.at(-1).contextStartSeconds, silentFrom / 48000);
const count = posted.length;
processor.process([[]]);
assert.equal(posted.length, count, "Un silence prolongé n'envoie aucun bloc vide.");

console.log("Tests AudioWorklet réussis");
