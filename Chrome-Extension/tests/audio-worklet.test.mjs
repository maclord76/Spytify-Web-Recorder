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
vm.runInNewContext(source, {
  AudioWorkletProcessor: MockAudioWorkletProcessor,
  Float32Array,
  Math,
  registerProcessor(name, implementation) {
    assert.equal(name, "pcm-capture-processor");
    Processor = implementation;
  }
});

const processor = new Processor();
const left = new Float32Array(128).fill(0.25);
const right = new Float32Array(128).fill(-0.25);
for (let index = 0; index < 32; index += 1) {
  assert.equal(processor.process([[left, right]]), true);
}

assert.equal(posted.length, 1);
assert.equal(posted[0].type, "pcm");
assert.equal(posted[0].left.length, 4096);
assert.equal(posted[0].right.length, 4096);

processor.process([[left, right]]);
processor.port.onmessage({ data: { type: "flush" } });
assert.equal(posted.at(-2).type, "pcm");
assert.equal(posted.at(-2).left.length, 128);
assert.equal(posted.at(-1).type, "flushed");

console.log("Tests AudioWorklet réussis");
