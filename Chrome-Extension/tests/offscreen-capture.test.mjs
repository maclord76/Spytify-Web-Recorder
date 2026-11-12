import assert from "node:assert/strict";

// Cycle de vie de la capture hors écran, commun aux deux modes : libération du
// flux après un échec, annulation, commandes retirées et MP3 en attente.
let messageListener;
let workletNode;
let trackStops = 0;
let contextCloses = 0;
let failInitialization = false;
let downloadResponse = { ok: true };
const runtimeMessages = [];
const revoked = [];

class FakeEncoder {
  encodeBuffer() { return new Uint8Array([1, 2, 3]); }
  flush() { return new Uint8Array(); }
}
const track = { addEventListener() {}, stop() { trackStops += 1; } };
const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
class FakeAudioContext {
  constructor() {
    this.destination = {};
    this.sampleRate = 10;
    this.currentTime = 0;
    this.audioWorklet = { addModule: async () => {
      if (failInitialization) throw new Error("Échec worklet simulé");
    } };
  }
  async resume() {}
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
  async close() { contextCloses += 1; }
}
class FakeAudioWorkletNode {
  constructor() {
    this.port = { onmessage: null, postMessage: () => this.port.onmessage({ data: { type: "flushed" } }) };
    workletNode = this;
  }
  connect() {}
  disconnect() {}
}

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { mediaDevices: { getUserMedia: async () => stream } }
});
const nativeTimeout = globalThis.setTimeout;
// Les URL blob restent valides plusieurs minutes : ne pas garder le test en vie.
globalThis.setTimeout = (callback, delay) => delay >= 60_000 ? 0 : nativeTimeout(callback, delay);
const nativeUrl = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
let blobs = 0;
URL.createObjectURL = () => `blob:test/${blobs++}`;
URL.revokeObjectURL = (url) => revoked.push(url);
globalThis.AudioContext = FakeAudioContext;
globalThis.AudioWorkletNode = FakeAudioWorkletNode;
globalThis.lamejs = { Mp3Encoder: FakeEncoder };
globalThis.chrome = {
  runtime: {
    getURL: (value) => value,
    onMessage: { addListener: (listener) => { messageListener = listener; } },
    async sendMessage(message) {
      runtimeMessages.push(message);
      return message.type === "MONITOR_TRACK_READY" ? downloadResponse : { ok: true };
    }
  }
};

await import(new URL(`../offscreen.js?test=${Date.now()}`, import.meta.url));

const request = (message) => new Promise((resolve) => {
  const asynchronous = messageListener({ ...message, target: "offscreen" }, {}, resolve);
  if (asynchronous !== true) assert.ok(["OFFSCREEN_GET_STATUS", "OFFSCREEN_UPDATE_MONITOR"].includes(message.type));
});
const status = () => request({ type: "OFFSCREEN_GET_STATUS" });
const start = (streamId) => request({ type: "OFFSCREEN_START_CAPTURE", streamId, tabId: 7, sessionId: streamId, bitrate: 128 });
const spotifyTab = { tab: { id: 7 }, url: "https://open.spotify.com/track/test" };
// Un morceau d'une seconde joué en entier, puis l'arrêt de la session.
async function recordOneTrack(streamId) {
  assert.equal((await start(streamId)).ok, true);
  const now = Date.now();
  messageListener({ type: "PLAYER_SNAPSHOT", snapshot: { observedAtMs: now, positionSeconds: 0, durationSeconds: 1,
    isPlaying: true, metadata: { title: "Titre", artist: "Artiste" } } }, spotifyTab, () => {});
  workletNode.port.onmessage({ data: { type: "pcm", contextStartSeconds: 1,
    left: new Float32Array(10).fill(0.2), right: new Float32Array(10).fill(0.2) } });
  return request({ type: "OFFSCREEN_STOP_MONITORING" });
}

assert.equal((await start("premier")).ok, true);
assert.equal((await status()).mode, "monitor");
assert.equal((await start("doublon")).ok, false, "Une seule capture à la fois.");
const canceled = await request({ type: "OFFSCREEN_CANCEL_CAPTURE" });
assert.equal(canceled.ok, true);
assert.equal(trackStops, 1);
assert.equal(contextCloses, 1);
assert.equal((await status()).active, false);

// L'encodage individuel « armé » n'existe plus : ses commandes sont refusées.
for (const type of ["OFFSCREEN_BEGIN_CAPTURE", "OFFSCREEN_STOP_CAPTURE"]) {
  assert.equal((await request({ type })).ok, false, `${type} refusé`);
}

failInitialization = true;
const failed = await start("echec");
assert.equal(failed.ok, false);
assert.equal(trackStops, 2, "Un échec d'initialisation doit libérer le flux.");
assert.equal(contextCloses, 2);
failInitialization = false;

// Un script de contenu ne peut pas commander la capture.
assert.equal((await start("onglet")).ok, true);
let refused;
assert.equal(messageListener({ type: "OFFSCREEN_CANCEL_CAPTURE", target: "offscreen" }, spotifyTab,
  (value) => { refused = value; }), false);
assert.equal(refused.ok, false);
assert.equal((await status()).active, true);
await request({ type: "OFFSCREEN_CANCEL_CAPTURE" });

// Un MP3 dont Chrome n'a pas confirmé l'enregistrement reste disponible et
// empêche la fermeture du document ; un MP3 enregistré est libéré aussitôt.
assert.equal((await recordOneTrack("attente")).ok, true);
assert.equal(runtimeMessages.filter((message) => message.type === "MONITOR_TRACK_READY").length, 1);
assert.equal((await status()).pendingDownloads, 1);
assert.deepEqual(revoked, []);
downloadResponse = { ok: true, completed: true };
assert.equal((await recordOneTrack("enregistre")).ok, true);
const saved = runtimeMessages.filter((message) => message.type === "MONITOR_TRACK_READY").at(-1);
assert.deepEqual(revoked, [saved.url]);
assert.equal((await status()).pendingDownloads, 1, "Seuls les MP3 non confirmés restent en attente.");

globalThis.setTimeout = nativeTimeout;
URL.createObjectURL = nativeUrl.create;
URL.revokeObjectURL = nativeUrl.revoke;
console.log("Capture hors écran : flux libéré après échec, annulation, commandes retirées et MP3 en attente vérifiés");
