import assert from "node:assert/strict";

let listener, actionClick, removed, saved, restored, status = { ok: true, active: false };
let authorized = false, activeTab = 7, starts = 0, stops = 0, streamRequests = 0, stopFails = false;
const calls = [], downloads = [], sessions = {};
const tab = { id: 7, windowId: 1, url: "https://open.spotify.com/playlist/test", status: "complete" };
const other = { ...tab, id: 8 };
const permissionError = "Extension has not been invoked for the current page (see activeTab permission).";
globalThis.chrome = {
  sidePanel: { async setPanelBehavior() {}, async open() {} },
  action: { onClicked: { addListener: fn => { actionClick = fn; } }, async setPopup() {}, async setBadgeText() {}, async setBadgeBackgroundColor() {} },
  storage: {
    local: { async get() { return { recorderState: restored }; }, async set(value) { if (value.recorderState) saved = structuredClone(value.recorderState); } },
    session: { async get() { return sessions; }, async set(value) { Object.assign(sessions, value); }, async remove(key) { delete sessions[key]; } }
  },
  runtime: {
    getURL: path => `chrome-extension://test/${path}`, getManifest: () => ({ version: "1.16.0" }),
    onMessage: { addListener: fn => { listener = fn; } }, async getContexts() { return [{}]; },
    async sendMessage(message) {
      calls.push(message);
      if (message.type === "OFFSCREEN_GET_STATUS") return status;
      if (message.type === "OFFSCREEN_START_CAPTURE") {
        starts++; status = { ok: true, active: true, mode: "monitor", sessionId: message.sessionId,
          monitorState: { recording: false, metadata: null, elapsedSeconds: 0 } };
        assert.ok(message.sessionId, "Chaque capture porte son identifiant de session.");
      }
      if (message.type === "OFFSCREEN_STOP_MONITORING") {
        stops++;
        if (stopFails) return { ok: false, error: "Arrêt indisponible" };
        status = { ok: true, active: false };
      }
      return { ok: true };
    }
  },
  tabs: { async query() { return [activeTab === 7 ? tab : other]; }, async get(id) { return id === 7 ? tab : other; },
    async sendMessage(id, message) {
      calls.push(message);
      assert.equal(id, 7);
      assert.ok(["PING", "GET_PLAYER_SNAPSHOT"].includes(message.type), "La surveillance ne pilote pas Spotify.");
      return { ok: true, snapshot: { metadata: { title: "A", artist: "Artiste" }, observedAtMs: Date.now(), isPlaying: false, positionSeconds: 0 } };
    }, async reload() { throw new Error("La surveillance ne doit pas actualiser Spotify."); },
    onRemoved: { addListener: fn => { removed = fn; } }
  },
  offscreen: { async closeDocument() {} },
  tabCapture: { async getCapturedTabs() { return []; }, async getMediaStreamId({ targetTabId }) {
    streamRequests++; assert.equal(targetTabId, 7); if (!authorized) throw new Error(permissionError); return "stream";
  } },
  scripting: { async executeScript() { throw new Error("Aucun contrôle du lecteur nécessaire."); } },
  downloads: { async download(value) { downloads.push(value); return downloads.length; },
    async search({ id }) { return [{ id, state: "complete" }]; }, onChanged: { addListener() {}, removeListener() {} } }
};
await import("../background.js");
const panel = { url: "chrome-extension://test/popup.html" };
const offscreen = { url: "chrome-extension://test/offscreen.html" };
const spotify = { tab: { id: 7 }, url: tab.url };
const request = (message, sender = panel) => new Promise(resolve => listener(message, sender, resolve));
const fromOffscreen = message => request(message, offscreen);
const state = async () => (await request({ type: "GET_STATE" })).state;
const start = () => request({ type: "START_MONITORING", options: { bitrate: 256 } });
const stop = () => request({ type: "STOP_MONITORING" });
const tick = () => new Promise(resolve => setImmediate(resolve));
assert.equal((await start()).state.phase, "capture_permission");
assert.equal(saved.mode, "monitor");
assert.equal(saved.metadata, null);
activeTab = 8;
actionClick(other); await tick();
assert.equal(streamRequests, 1);
authorized = true;
actionClick(tab); await tick(); await tick();
assert.equal(saved.monitoring, true);
assert.equal(saved.tabId, 7, "Le clic reste lié à l'onglet autorisé même après un changement d'onglet.");
assert.equal(saved.bitrate, 256);
assert.equal(starts, 1);
await Promise.all([start(), start()]);
assert.equal(starts, 1, "Une session active n'est pas doublée.");
const sessionId = saved.monitorSessionId;
await fromOffscreen({ type: "MONITOR_STATE", sessionId, state: { recording: true, elapsedSeconds: 12, metadata: { title: "A", artist: "Artiste" } } });
assert.equal(saved.recording, true);
// Même une commande reçue hors du panneau ne doit pas écraser la session active.
assert.equal((await request({ type: "START_SINGLE_TRACK", options: { url: "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT" } })).ok, false);
assert.equal(saved.monitoring, true); assert.equal(saved.tabId, 7); assert.equal(saved.recording, true);
await fromOffscreen({ type: "MONITOR_STATE", sessionId: "old", state: { recording: false } });
assert.equal(saved.recording, true);
assert.equal((await fromOffscreen({ type: "MONITOR_TRACK_READY", sessionId: "old" })).ok, false);
assert.equal(downloads.length, 0);
await fromOffscreen({ type: "MONITOR_STATE", sessionId, state: { recording: true, metadata: { title: "B", artist: "Artiste" }, elapsedSeconds: 1 } });
// Les MP3 ne viennent que du document hors écran, et seulement depuis ses URL blob.
assert.equal((await request({ type: "MONITOR_TRACK_READY", sessionId, url: "blob:chrome-extension://test/x",
  metadata: { title: "X", artist: "Artiste" } }, spotify)).ok, false);
assert.equal((await request({ type: "MONITOR_TRACK_READY", sessionId, url: "blob:chrome-extension://test/x",
  metadata: { title: "X", artist: "Artiste" } })).ok, false, "Le panneau ne peut pas non plus forcer un téléchargement.");
for (const url of ["https://example.com/malware.exe", "blob:https://open.spotify.com/x", "blob:chrome-extension://autre/x", undefined]) {
  assert.equal((await fromOffscreen({ type: "MONITOR_TRACK_READY", sessionId, url,
    metadata: { title: "X", artist: "Artiste" } })).ok, false, `URL refusée : ${url}`);
}
assert.equal((await request({ type: "STOP_MONITORING" }, spotify)).ok, false);
assert.equal(saved.monitoring, true);
assert.equal(downloads.length, 0);
await fromOffscreen({ type: "MONITOR_TRACK_READY", sessionId, url: "blob:chrome-extension://test/one", filename: "audio.mp3",
  metadata: { title: "A", artist: "Artiste" }, durationSeconds: 212.5 });
assert.equal(saved.lastMonitoredDurationSeconds, 212.5, "La durée du MP3 téléchargé est conservée pour le panneau.");
assert.equal(saved.capturedTracks, 1);
assert.equal(saved.monitoring, true);
assert.equal(saved.tabId, 7);
assert.equal(downloads[0].saveAs, false);
assert.equal(downloads[0].conflictAction, "uniquify");
assert.equal(downloads[0].filename, "Spytify Web/Artiste - A.mp3", "Nommer le MP3 finalisé, même si le titre suivant est déjà lu.");
assert.equal(saved.lastMonitoredFilename, downloads[0].filename);
assert.equal(saved.metadata.title, "B");
await fromOffscreen({ type: "MONITOR_TRACK_READY", sessionId, url: "blob:chrome-extension://test/two", filename: "audio.mp3", metadata: { title: "B", artist: "Artiste", partial: true } });
assert.equal(downloads[1].filename, "Spytify Web/Artiste - B (extrait).mp3");
assert.equal(downloads[1].saveAs, false);
assert.equal(saved.lastMonitoredFilename, downloads[1].filename);
await fromOffscreen({ type: "MONITOR_STATE", sessionId, state: { recording: false, metadata: { title: "A" }, elapsedSeconds: 12 } });
assert.equal(saved.monitoring, true, "Une pause conserve la surveillance.");
stopFails = true;
assert.equal((await stop()).ok, false);
assert.equal(saved.monitoring, true); assert.equal(saved.tabId, 7); assert.equal(saved.phase, "monitoring");
stopFails = false;

await fromOffscreen({ type: "MONITOR_STATE", sessionId, state: { advertisement: true, recording: false, metadata: null, elapsedSeconds: 0 } });
assert.equal(saved.advertisement, true);
assert.equal(saved.monitoring, true);
assert.equal(saved.recording, false);
assert.equal(saved.capturedTracks, 2);
assert.match(saved.message, /Publicité ignorée/);
restored = { ...saved };
status.monitorState = { advertisement: true, recording: false, metadata: null, elapsedSeconds: 0 };
await import("../background.js?restore-advertisement");
assert.equal((await state()).advertisement, true);
assert.equal(saved.monitoring, true); assert.equal(starts, 1);

// Reprise du service worker sans rouvrir un flux ; perte du document hors écran
// signalée sans réactivation silencieuse.
restored = { ...saved };
status.monitorState = { recording: true, metadata: { title: "B", artist: "Artiste" }, elapsedSeconds: 9 };
await import("../background.js?restore-monitor");
assert.equal((await state()).recording, true);
assert.equal(saved.advertisement, false);
assert.equal(saved.metadata.title, "B"); assert.equal(starts, 1);
const previousStops = stops;
assert.ok((await Promise.all([stop(), stop()])).every(r => r.ok));
assert.equal(stops, previousStops + 1);
assert.equal(saved.monitoring, false); assert.equal(saved.phase, "done"); assert.equal(saved.capturedTracks, 2);
assert.equal(saved.tabId, null);
status = { ok: true, active: false };
await import("../background.js?restore-lost-monitor");
assert.equal((await state()).monitoring, false);
assert.match(saved.message, /interrompue/); assert.equal(starts, 1);

restored = null; activeTab = 7;
await import("../background.js?close-monitor-tab");
await start();
removed(8); await tick(); assert.equal(stops, previousStops + 1);
removed(7); await tick(); await tick();
assert.equal(saved.monitoring, false); assert.equal(stops, previousStops + 2);
assert.equal(calls.some(m => ["PREPARE_TRACK", "START_PLAYBACK", "OFFSCREEN_BEGIN_CAPTURE"].includes(m.type)), false);
console.log("Service de surveillance : autorisation, onglet stable, absence de commandes Spotify, pause, reprise worker et fermeture vérifiés");
