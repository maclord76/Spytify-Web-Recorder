import assert from "node:assert/strict";

const epoch = 1_000_000;
let clock = epoch;
const originalNow = Date.now;
Date.now = () => clock;
let listener, worklet, trackEnded;
let mediaRequests = 0, stopped = 0, closed = 0, rejectDownload = false;
const messages = [], encoders = [], revoked = [];
const originalUrl = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
URL.createObjectURL = () => `blob:test/${encoders.length}`;
URL.revokeObjectURL = url => revoked.push(url);
const nativeTimeout = globalThis.setTimeout;
// Les URL blob restent valides plusieurs minutes : ne pas garder le test en vie.
globalThis.setTimeout = (fn, ms) => ms >= 60_000 ? 0 : nativeTimeout(fn, ms);
// L'horloge de chaque capture avance seulement à la demande du test.
const nativeInterval = { set: globalThis.setInterval, clear: globalThis.clearInterval };
const timers = new Map();
let timerIds = 0;
globalThis.setInterval = fn => { timers.set(++timerIds, fn); return timerIds; };
globalThis.clearInterval = id => timers.delete(id);

class Encoder {
  constructor() { this.samples = []; encoders.push(this); }
  encodeBuffer(left) { this.samples.push(...left); return new Uint8Array([1, 2]); }
  flush() { this.flushed = true; return new Uint8Array([3]); }
}
const track = { addEventListener(type, fn) { trackEnded = fn; }, stop() { stopped++; } };
const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
const node = () => ({ connect() {}, disconnect() {} });
class Context {
  constructor() { this.sampleRate = 10; this.currentTime = 0; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
  async resume() {}
  createMediaStreamSource() { return node(); }
  createGain() { return { ...node(), gain: { value: 1 } }; }
  async close() { closed++; }
}
class Worklet {
  constructor() {
    this.port = { onmessage: null, postMessage: () => this.port.onmessage({ data: { type: "flushed" } }) };
    worklet = this;
  }
  connect() {}
  disconnect() {}
}
Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
  mediaDevices: { getUserMedia: async () => { mediaRequests++; return stream; } }
} });
Object.assign(globalThis, { AudioContext: Context, AudioWorkletNode: Worklet, lamejs: { Mp3Encoder: Encoder }, chrome: {
  runtime: { getURL: p => p, onMessage: { addListener: fn => { listener = fn; } },
    async sendMessage(message) {
      messages.push(message);
      return message.type === "MONITOR_TRACK_READY" && rejectDownload ? { ok: false, error: "Disque indisponible" } : { ok: true };
    }
  }
} });
await import("../offscreen.js");
const request = message => new Promise(resolve => listener({ ...message, target: "offscreen" }, {}, resolve));
const snapshot = (title, at, position, isPlaying = true, tabId = 7, durationSeconds = 1.5) => {
  clock = epoch + at;
  listener({ type: "PLAYER_SNAPSHOT", snapshot: { observedAtMs: clock, positionSeconds: position,
    durationSeconds, isPlaying, metadata: { title, artist: "Artiste" } } }, { tab: { id: tabId }, url: "https://open.spotify.com/playlist/test" }, () => {});
};
const pcm = (seconds, values) => worklet.port.onmessage({ data: { type: "pcm", contextStartSeconds: seconds,
  left: Float32Array.from(values), right: Float32Array.from(values) } });
const tick = () => new Promise(resolve => setImmediate(resolve));
const start = sessionId => request({ type: "OFFSCREEN_START_CAPTURE", streamId: "stream", tabId: 7,
  sessionId, bitrate: 128, monitoring: true, armed: true });

assert.equal((await start("one")).ok, true);
snapshot("Intrus", 0, 0, true, 8);
assert.equal((await request({ type: "OFFSCREEN_GET_STATUS" })).monitorState.recording, false);
// Un script de contenu ne commande jamais la capture, même dans l'onglet surveillé.
const refused = await new Promise(resolve => listener({ type: "OFFSCREEN_STOP_MONITORING", target: "offscreen" },
  { tab: { id: 7 }, url: "https://open.spotify.com/playlist/test" }, resolve));
assert.equal(refused.ok, false);
assert.equal((await request({ type: "OFFSCREEN_GET_STATUS" })).active, true);
// Seul l'onglet surveillé, sur Spotify, peut décrire le lecteur.
listener({ type: "PLAYER_SNAPSHOT", snapshot: { observedAtMs: clock, positionSeconds: 0, durationSeconds: 1.5, isPlaying: true,
  metadata: { title: "Intrus", artist: "Artiste" } } }, { tab: { id: 7 }, url: "https://example.com/" }, () => {});
assert.equal((await request({ type: "OFFSCREEN_GET_STATUS" })).monitorState.recording, false);
snapshot("A", 0, 0);
pcm(0, Array(15).fill(0.25));
snapshot("B", 2000, 0.5);
snapshot("B", 2300, 0.8);
pcm(1.5, Array(45).fill(0.5));
await tick();
assert.equal(mediaRequests, 1, "Le passage au titre suivant conserve la même capture.");
assert.equal(stopped, 0);
assert.equal(closed, 0);
snapshot("B", 6000, 5, false);
pcm(6, Array(40).fill(0));
// Le MP3 de A part dès que sa fin sort du tampon de huit secondes.
await tick();
assert.equal(messages.filter(m => m.type === "MONITOR_TRACK_READY").length, 1);
assert.equal(encoders[0].samples.length, 15);
assert.ok(encoders[0].samples.every(n => n === 8191));
assert.ok(Array.isArray(messages.find(m => m.type === "MONITOR_TRACK_READY").journal), "Le journal accompagne chaque MP3.");
assert.equal((await request({ type: "OFFSCREEN_GET_STATUS" })).active, true);
assert.equal((await request({ type: "OFFSCREEN_GET_STATUS" })).monitorState.recording, false);
const results = await Promise.all([request({ type: "OFFSCREEN_STOP_MONITORING" }), request({ type: "OFFSCREEN_STOP_MONITORING" })]);
assert.ok(results.every(r => r.ok));
assert.equal(stopped, 1);
assert.equal(closed, 1);
assert.equal(encoders[1].samples.length, 45, "Les quatre secondes en pause sont exclues du MP3.");
assert.equal(messages.filter(m => m.type === "MONITOR_TRACK_READY").length, 2);
assert.equal(messages.filter(m => m.type === "MONITOR_STOPPED").length, 1);
assert.equal((await request({ type: "OFFSCREEN_GET_STATUS" })).active, false);

// Un téléchargement refusé est signalé ; l'arrêt naturel libère tout le flux.
clock = epoch + 20_000;
assert.equal((await start("two")).ok, true);
snapshot("C", 20_000, 0);
pcm(0, Array(10).fill(0.1));
rejectDownload = true;
trackEnded();
await tick(); await tick();
assert.equal(stopped, 2);
assert.equal(closed, 2);
assert.equal(messages.at(-1).type, "MONITOR_STOPPED");
assert.match(messages.at(-1).error, /Disque indisponible/);
assert.ok(messages.some(m => m.type === "MONITOR_EXPORT_ERROR" && m.sessionId === "two"));
assert.equal(revoked.length, 1);

// Une publicité conserve la capture mais son audio ne rejoint aucun encodeur.
rejectDownload = false;
clock = epoch + 40_000;
assert.equal((await start("three")).ok, true);
snapshot("D", 40_000, 0);
pcm(0, [...Array(15).fill(0.25), ...Array(5).fill(0.9)]);
clock = epoch + 42_000;
listener({ type: "PLAYER_SNAPSHOT", snapshot: { observedAtMs: clock,
  positionSeconds: 0.5, isPlaying: true, isAdvertisement: true, metadata: null } }, { tab: { id: 7 }, url: "https://open.spotify.com/playlist/test" }, () => {});
assert.equal((await request({ type: "OFFSCREEN_GET_STATUS" })).monitorState.advertisement, true);
assert.equal((await request({ type: "OFFSCREEN_GET_STATUS" })).monitorState.recording, false);
pcm(2, Array(30).fill(0.9));
snapshot("E", 45_000, 0);
assert.equal((await request({ type: "OFFSCREEN_GET_STATUS" })).monitorState.recording, false);
snapshot("E", 45_300, 0.3);
pcm(5, Array(15).fill(0.5));
assert.equal((await request({ type: "OFFSCREEN_GET_STATUS" })).monitorState.elapsedSeconds, 1);
assert.equal((await request({ type: "OFFSCREEN_GET_STATUS" })).monitorState.advertisement, false);
await request({ type: "OFFSCREEN_STOP_MONITORING" });
assert.equal(encoders[3].samples.length, 15);
assert.ok(encoders[3].samples.every(n => n === 8191));
assert.equal(encoders[4].samples.length, 15);
assert.ok(encoders[4].samples.every(n => n === 16383));
assert.equal(mediaRequests, 3, "La publicité n'a pas recréé le flux.");
assert.equal(messages.filter(m => m.type === "MONITOR_TRACK_READY" && m.sessionId === "three").length, 2);

// La capture complète corrige une estimation initiale erronée jusque dans le
// nom transmis au service de téléchargement, sans toucher au titre ID3.
clock = epoch + 60_000;
assert.equal((await start("four")).ok, true);
snapshot("Complet", 60_000, 2.5, true, 7, 10);
pcm(0, Array(30).fill(0.25));
snapshot("Complet", 63_000, 3, true, 7, 10);
pcm(3, Array(70).fill(0.25));
snapshot("Suivant", 70_500, 0.5, true, 7, 20);
snapshot("Suivant", 70_750, 0.75, true, 7, 20);
pcm(10, Array(40).fill(0.5));
pcm(14, Array(40).fill(0.5));
await tick();
const complete = messages.find(m => m.type === "MONITOR_TRACK_READY" && m.sessionId === "four");
assert.equal(complete.filename, "Spytify Web/Artiste - Complet.mp3");
assert.equal(complete.metadata.title, "Complet");
assert.equal(complete.durationSeconds, 10);
await request({ type: "OFFSCREEN_STOP_MONITORING" });
const incomplete = messages.filter(m => m.type === "MONITOR_TRACK_READY" && m.sessionId === "four").at(-1);
assert.equal(incomplete.filename, "Spytify Web/Artiste - Suivant (extrait).mp3");

// Fin de lecture sans morceau suivant : Spotify revient à 0:00 en pause et
// l'onglet se tait. L'horloge exporte le MP3 sans arrêt de la surveillance.
clock = epoch + 80_000;
assert.equal((await start("five")).ok, true);
assert.equal(timers.size, 1);
const settle = at => { clock = epoch + at; for (const fn of timers.values()) fn(); };
snapshot("Fin", 80_000, 0, true, 7, 10);
pcm(0, Array(90).fill(0.25));
snapshot("Fin", 89_000, 9, true, 7, 10);
pcm(9, Array(10).fill(0.25));
snapshot("Fin", 90_300, 0, false, 7, 10);
settle(90_500);
await tick();
const ended = () => messages.filter(m => m.type === "MONITOR_TRACK_READY" && m.sessionId === "five");
assert.equal(ended().length, 0, "Les derniers PCM peuvent encore arriver.");
settle(92_500);
await tick(); await tick();
assert.equal(ended().length, 1);
assert.equal(ended()[0].reason, "track_ended");
assert.equal(ended()[0].durationSeconds, 10);
assert.equal(ended()[0].filename, "Spytify Web/Artiste - Fin.mp3");
assert.equal((await request({ type: "OFFSCREEN_GET_STATUS" })).monitorState.metadata, null);
await request({ type: "OFFSCREEN_STOP_MONITORING" });
assert.equal(ended().length, 1);
assert.equal(timers.size, 0, "Chaque arrêt libère l'horloge de sa capture.");
Date.now = originalNow;
URL.createObjectURL = originalUrl.create;
URL.revokeObjectURL = originalUrl.revoke;
globalThis.setTimeout = nativeTimeout;
globalThis.setInterval = nativeInterval.set;
globalThis.clearInterval = nativeInterval.clear;
console.log("Capture surveillance : flux continu, filtrage de l'onglet, pause, fin sans morceau suivant, arrêt concurrent et erreur de téléchargement vérifiés");
