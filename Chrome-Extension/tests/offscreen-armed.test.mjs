import assert from "node:assert/strict";

let messageListener;
let workletNode;
let encodeCalls = 0;
let trackStopped = false;
let contextClosed = false;
let failInitialization = false;
const runtimeMessages = [];

class FakeEncoder {
  encodeBuffer() {
    encodeCalls += 1;
    return new Uint8Array([1, 2, 3]);
  }

  flush() {
    return new Uint8Array();
  }
}

const track = {
  addEventListener() {},
  stop() {
    trackStopped = true;
  }
};
const stream = {
  getAudioTracks() {
    return [track];
  },
  getTracks() {
    return [track];
  }
};

class FakeAudioContext {
  constructor() {
    this.destination = {};
    this.sampleRate = 44100;
    this.audioWorklet = { addModule: async () => {
      if (failInitialization) throw new Error("Échec worklet simulé");
    } };
  }

  async resume() {}

  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }

  createGain() {
    return { gain: { value: 1 }, connect() {}, disconnect() {} };
  }

  async close() {
    contextClosed = true;
  }
}

class FakeAudioWorkletNode {
  constructor() {
    this.port = { onmessage: null, postMessage() {} };
    workletNode = this;
  }

  connect() {}
  disconnect() {}
}

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { mediaDevices: { getUserMedia: async () => stream } }
});
globalThis.AudioContext = FakeAudioContext;
globalThis.AudioWorkletNode = FakeAudioWorkletNode;
globalThis.lamejs = { Mp3Encoder: FakeEncoder };
globalThis.chrome = {
  runtime: {
    getURL(value) {
      return value;
    },
    onMessage: {
      addListener(listener) {
        messageListener = listener;
      }
    },
    sendMessage(message) {
      runtimeMessages.push(message);
      return Promise.resolve({ ok: true });
    }
  }
};

await import(new URL(`../offscreen.js?test=${Date.now()}`, import.meta.url));

function request(message) {
  return new Promise((resolve) => {
    const asynchronous = messageListener({ ...message, target: "offscreen" }, {}, resolve);
    assert.equal(asynchronous, true);
  });
}

const started = await request({
  type: "OFFSCREEN_START_CAPTURE",
  streamId: "test-stream",
  bitrate: 128,
  metadata: { title: "Titre", artist: "Artiste" },
  armed: true
});
assert.equal(started.ok, true);

const pcm = {
  type: "pcm",
  left: new Float32Array([0.1, 0.2]),
  right: new Float32Array([0.1, 0.2])
};
workletNode.port.onmessage({ data: pcm });
assert.equal(encodeCalls, 0, "Le mode armé ne doit pas encoder de silence.");

const begun = await request({ type: "OFFSCREEN_BEGIN_CAPTURE" });
assert.equal(begun.ok, true);
workletNode.port.onmessage({ data: pcm });
assert.equal(encodeCalls, 1, "L'encodage doit commencer après l'étape 3.");

const canceled = await request({ type: "OFFSCREEN_CANCEL_CAPTURE" });
assert.equal(canceled.ok, true);
assert.equal(trackStopped, true);
assert.equal(contextClosed, true);
assert.equal(runtimeMessages.some((message) => message.type === "AUDIO_READY"), false);

trackStopped = false;
contextClosed = false;
failInitialization = true;
const failed = await request({ type: "OFFSCREEN_START_CAPTURE", streamId: "failed", armed: true });
assert.equal(failed.ok, false);
assert.equal(trackStopped, true, "Un échec d'initialisation doit libérer le flux.");
assert.equal(contextClosed, true);
failInitialization = false;
assert.equal((await request({ type: "OFFSCREEN_START_CAPTURE", streamId: "retry", armed: true })).ok, true);
await request({ type: "OFFSCREEN_CANCEL_CAPTURE" });
console.log("Tests capture armée et nettoyage après échec réussis");
