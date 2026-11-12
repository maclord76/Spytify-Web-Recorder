import assert from "node:assert/strict";

let listener, removed, saved, restored = null;
let offscreenAlive = true;
let status = { ok: true, active: false };
let stopBehavior = "ready";
let downloadPlan = [];
const calls = [], downloads = [], downloadItems = new Map(), changeListeners = new Set(), unhandled = [];
const observationWrites = [];
let closes = 0, lastReady = null;
const metadata = { title: "Titre", artist: "Artiste" };
const panel = { url: "chrome-extension://test/popup.html" };
const offscreen = { url: "chrome-extension://test/offscreen.html" };
const request = (message, sender = panel) => new Promise(resolve => listener(message, sender, resolve));
const tick = () => new Promise(resolve => setImmediate(resolve));
process.on("unhandledRejection", error => unhandled.push(error));

// Simule le document hors écran : l'arrêt exporte le morceau en cours avant de
// répondre ; « reject » simule un document disparu, « keep » un refus.
async function offscreenStop() {
  if (stopBehavior === "reject") {
    offscreenAlive = false;
    throw new Error("Could not establish connection. Receiving end does not exist.");
  }
  if (stopBehavior === "keep") return { ok: false, error: "Flux occupé" };
  status = { ok: true, active: false };
  if (stopBehavior === "silent") return { ok: true };
  lastReady = await request({ type: "MONITOR_TRACK_READY", sessionId: saved.monitorSessionId,
    url: "blob:chrome-extension://test/mp3", metadata }, offscreen);
  return { ok: true };
}
globalThis.chrome = {
  sidePanel: { async setPanelBehavior() {}, async open() {} },
  action: { onClicked: { addListener() {} }, async setPopup() {}, async setBadgeText() {}, async setBadgeBackgroundColor() {} },
  storage: {
    local: { async remove() {}, async get() { return restored ? { recorderState: restored } : {}; }, async set(value) {
      if (value.recorderState) saved = structuredClone(value.recorderState);
      if ("playerObservation" in value) observationWrites.push(value.playerObservation);
    } },
    session: { async get() { return {}; }, async set() {} }
  },
  runtime: {
    getURL: path => `chrome-extension://test/${path}`, getManifest: () => ({ version: "test" }),
    onMessage: { addListener: fn => { listener = fn; } },
    async getContexts() { return offscreenAlive ? [{}] : []; },
    async sendMessage(message) {
      calls.push(message);
      if (message.type === "OFFSCREEN_GET_STATUS") {
        if (!offscreenAlive) throw new Error("Receiving end does not exist.");
        return status;
      }
      if (message.type === "OFFSCREEN_STOP_MONITORING") {
        if (message.reason === "orphaned") { status = { ...status, active: false }; return { ok: true }; }
        return offscreenStop();
      }
      if (message.type === "OFFSCREEN_CANCEL_CAPTURE") status = { ...status, active: false };
      if (message.type === "OFFSCREEN_START_CAPTURE") status = { ...status, active: true, mode: "monitor", sessionId: message.sessionId };
      return { ok: true };
    }
  },
  tabs: {
    onRemoved: { addListener: fn => { removed = fn; } },
    async get(id) { return { id, url: "https://open.spotify.com/track/test" }; },
    async query() { return [{ id: 7, windowId: 1, active: true, url: "https://open.spotify.com/playlist/test" }]; },
    async sendMessage() { return { ok: true }; }
  },
  offscreen: { async closeDocument() { closes++; } },
  tabCapture: { async getCapturedTabs() { return []; }, async getMediaStreamId() { return "stream"; } },
  scripting: { async executeScript() { return []; } },
  downloads: {
    async download(options) {
      downloads.push(options);
      const step = downloadPlan.shift() ?? "complete";
      if (step.startsWith("throw:")) throw new Error(step.slice("throw:".length));
      downloadItems.set(downloads.length, step);
      return downloads.length;
    },
    async search({ id }) {
      const step = downloadItems.get(id);
      if (step === "complete") return [{ id, state: "complete" }];
      if (step.startsWith("interrupted:")) return [{ id, state: "interrupted", error: step.slice("interrupted:".length) }];
      // Interruption signalée plus tard par downloads.onChanged.
      if (step.startsWith("later:")) setImmediate(() => changeListeners.forEach(fn => fn({
        id, state: { current: "interrupted" }, error: { current: step.slice("later:".length) }
      })));
      return [{ id, state: "in_progress" }];
    },
    onChanged: { addListener: fn => changeListeners.add(fn), removeListener: fn => changeListeners.delete(fn) }
  }
};

let instance = 0;
async function load(state, captureStatus) {
  restored = state;
  status = captureStatus;
  offscreenAlive = true;
  stopBehavior = "ready";
  downloadPlan = [];
  downloads.length = 0;
  calls.length = 0;
  await import(`../background.js?recovery-${instance++}`);
  return (await request({ type: "GET_STATE" })).state;
}
// Enregistrement d'un morceau en cours, lecture confirmée.
const loadSingle = () => load(
  { phase: "monitoring", mode: "single", monitoring: true, monitorSessionId: "u1", tabId: 7, bitrate: 192,
    track: { trackId: "4cOdK2wGLETKBW3PvgPWqT", url: "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT" },
    target: metadata, playbackStarted: true, capturedTracks: 0 },
  { ok: true, active: true, mode: "monitor", sessionId: "u1", monitorState: { recording: true, metadata, elapsedSeconds: 5 } }
);
const loadMonitoring = () => load(
  { phase: "monitoring", mode: "monitor", monitoring: true, monitorSessionId: "s1", tabId: 7, capturedTracks: 2 },
  { ok: true, active: true, mode: "monitor", sessionId: "s1", monitorState: { recording: true, metadata, elapsedSeconds: 3 } }
);
const trackReady = () => request({ type: "MONITOR_TRACK_READY", sessionId: saved.monitorSessionId,
  url: "blob:chrome-extension://test/mp3", metadata }, offscreen);

// Point 4 — un téléchargement refusé n'entraîne plus la perte du MP3.
{
  assert.equal((await loadSingle()).monitoring, true);
  downloadPlan = ["throw:Invalid filename"];
  const response = await request({ type: "STOP_MONITORING" });
  assert.equal(response.state.phase, "done");
  assert.equal(downloads.length, 2);
  assert.equal(downloads[0].filename, "Spytify Web/Artiste - Titre.mp3");
  assert.match(downloads[1].filename, /^Spytify Web\/Enregistrement Spotify [\dT-]+Z\.mp3$/, "Un nom de secours sans caractère risqué est essayé.");
  assert.equal(downloads[1].saveAs, false);
  assert.equal(lastReady.completed, true, "Le document hors écran peut libérer le MP3 enregistré.");
}
{
  await loadSingle();
  // Une interruption après le démarrage (disque plein) est détectée, puis Chrome
  // demande où enregistrer le fichier.
  downloadPlan = ["later:FILE_NO_SPACE", "interrupted:FILE_NO_SPACE"];
  const response = await request({ type: "STOP_MONITORING" });
  assert.equal(downloads.length, 3);
  assert.equal(downloads[2].saveAs, true);
  assert.equal(downloads[2].filename, "Spytify Web/Artiste - Titre.mp3");
  assert.equal(response.state.phase, "done");
  assert.match(response.state.message, /choisissez/);
  assert.equal(lastReady.completed, false, "Le MP3 reste disponible pendant le choix de l'emplacement.");
  assert.equal(changeListeners.size, 0, "Les écouteurs de téléchargement sont retirés.");
}
{
  await loadMonitoring();
  downloadPlan = ["throw:a", "throw:b", "throw:c"];
  const response = await trackReady();
  assert.equal(downloads.length, 3);
  assert.equal(response.ok, false);
  assert.match(response.error, /n'a pas pu être enregistré \(a ; b ; c\)/);
  assert.equal(saved.monitoring, true, "Un MP3 perdu n'arrête pas la surveillance.");
}
{
  await loadMonitoring();
  downloadPlan = ["interrupted:USER_CANCELED"];
  await trackReady();
  assert.equal(downloads.length, 1, "Une annulation par l'utilisateur n'est pas relancée.");
}

// Point 5 — l'arrêt ne laisse jamais le panneau bloqué en finalisation.
{
  await loadSingle();
  stopBehavior = "reject";
  const response = await request({ type: "STOP_MONITORING" });
  assert.equal(response.ok, true);
  assert.equal(response.state.phase, "error", "Une capture disparue clôt la session au lieu de la bloquer.");
  assert.equal(response.state.monitoring, false);
  assert.match(response.state.message, /Enregistrement arrêté : Could not establish connection/);
}
{
  await loadSingle();
  stopBehavior = "silent";
  const response = await request({ type: "STOP_MONITORING" });
  assert.equal(response.state.phase, "done", "Un arrêt sans MP3 produit ne reste pas en finalisation.");
  assert.equal(response.state.tabId, null);
  assert.match(response.state.message, /Aucun MP3/);
}
{
  await loadSingle();
  stopBehavior = "keep";
  assert.equal((await request({ type: "STOP_MONITORING" })).ok, false);
  assert.equal(saved.phase, "monitoring", "Une capture toujours active peut être arrêtée de nouveau.");
  assert.equal(saved.monitoring, true);
  stopBehavior = "ready";
  assert.equal((await request({ type: "STOP_MONITORING" })).state.phase, "done");
}
{
  await loadSingle();
  stopBehavior = "reject";
  removed(7);
  for (let index = 0; index < 10; index += 1) await tick();
  assert.equal(saved.phase, "error", "La fermeture de l'onglet ne bloque pas l'état.");
  assert.equal(saved.monitoring, false);
}
// Point 6 — une erreur audio suit l'état réel de la capture.
{
  assert.equal((await loadMonitoring()).monitoring, true);
  await request({ type: "AUDIO_ERROR", error: "Commande audio inconnue." }, offscreen);
  assert.equal(saved.monitoring, true, "Une commande refusée n'abandonne pas une surveillance toujours active.");
  assert.equal(saved.phase, "monitoring");
  assert.equal(saved.tabId, 7);
  assert.match(saved.message, /Commande audio inconnue/);
  assert.equal(calls.some(message => message.type === "OFFSCREEN_STOP_MONITORING"), false);

  status = { ok: true, active: false };
  await request({ type: "AUDIO_ERROR", error: "Flux terminé" }, offscreen);
  assert.equal(saved.monitoring, false, "Une capture disparue termine la surveillance affichée.");
  assert.equal(saved.phase, "error");
}
{
  assert.equal((await loadSingle()).monitoring, true);
  await request({ type: "AUDIO_ERROR", error: "Commande audio inconnue." }, offscreen);
  assert.equal(saved.monitoring, true);
  assert.equal(saved.phase, "monitoring");
}
{
  // Une capture que l'état ne suit plus est finalisée, pas laissée active.
  assert.equal((await load(null, { ok: true, active: true, mode: "monitor", sessionId: "ancienne" })).phase, "idle");
  stopBehavior = "silent";
  await request({ type: "AUDIO_ERROR", error: "Erreur ancienne" }, offscreen);
  const stop = calls.find(message => message.type === "OFFSCREEN_STOP_MONITORING");
  assert.equal(stop?.reason, "orphaned");
  assert.equal(saved.phase, "error");
  assert.equal(saved.monitoring, false);
}

// Point 8 — l'observation du lecteur n'est publiée que pendant une session.
// Point 9 — le document hors écran garde ses MP3 en attente d'enregistrement.
{
  assert.equal((await load(null, { ok: true, active: false, pendingDownloads: 1 })).monitoring, false);
  observationWrites.length = 0;
  closes = 0;
  const started = await request({ type: "START_MONITORING", options: { bitrate: 192 } });
  assert.equal(started.state.monitoring, true);
  assert.equal(closes, 0, "Un MP3 en attente empêche la fermeture du document hors écran.");
  assert.deepEqual(observationWrites, [true], "L'observation démarre avec la surveillance.");
  await request({ type: "MONITOR_STATE", sessionId: saved.monitorSessionId,
    state: { recording: true, metadata, elapsedSeconds: 1 } }, offscreen);
  assert.deepEqual(observationWrites, [true], "L'indicateur n'est réécrit qu'à son changement.");
  assert.equal((await request({ type: "STOP_MONITORING" })).state.monitoring, false);
  assert.deepEqual(observationWrites, [true, false], "L'observation s'arrête avec la surveillance.");

  status = { ...status, pendingDownloads: 0 };
  await request({ type: "START_MONITORING", options: { bitrate: 192 } });
  assert.equal(closes, 1, "Sans MP3 en attente, l'ancien document est fermé pour libérer ses flux.");
  await request({ type: "STOP_MONITORING" });
}

// Fin d'un morceau individuel lue dans le minutage : Spotify revient à 0:00 en
// pause sans jamais afficher la dernière seconde (régression signalée).
{
  const spotifyTab = { tab: { id: 7 }, url: "https://open.spotify.com/track/test" };
  const player = (positionSeconds, isPlaying, title = "Titre", extra = {}) => request({ type: "PLAYER_SNAPSHOT", snapshot: {
    metadata: { title, artist: "Artiste" }, positionSeconds, durationSeconds: 337, isPlaying, ended: false, ...extra
  } }, spotifyTab);
  const stopReasons = () => calls.filter(message => message.type === "OFFSCREEN_STOP_MONITORING").map(message => message.reason);

  await loadSingle();
  for (const position of [120, 200, 300, 334, 335]) await player(position, true);
  assert.deepEqual(stopReasons(), []);
  await player(0, false);
  assert.deepEqual(stopReasons(), ["track_ended"]);
  assert.equal(saved.phase, "done", "Le MP3 est enregistré automatiquement.");
  assert.equal(downloads.at(-1).filename, "Spytify Web/Artiste - Titre.mp3");

  // Mode répétition : le morceau repart à 0:00 en lecture.
  await loadSingle();
  await player(334.5, true);
  await player(0.5, true);
  assert.deepEqual(stopReasons(), ["track_ended"]);

  // Un retour en arrière en cours de morceau n'est pas une fin.
  await loadSingle();
  await player(120, true);
  await player(10, true);
  await player(0, false);
  assert.deepEqual(stopReasons(), []);
  assert.equal(saved.phase, "monitoring");

  // Le morceau suivant commence juste après la fin : arrêt immédiat, sans
  // attendre une seconde confirmation qui ajouterait son début au MP3.
  await loadSingle();
  await player(335, true);
  await player(0.25, true, "Morceau suivant");
  assert.deepEqual(stopReasons(), ["track_ended"]);

  // En cours de morceau, un titre transitoire reste ignoré ; un vrai passage à
  // un autre morceau arrête l'enregistrement.
  await loadSingle();
  await player(100, true);
  await player(101, true, "Titre transitoire");
  await player(102, true);
  assert.deepEqual(stopReasons(), []);
  await player(103, true, "Autre morceau");
  await player(103.25, true, "Autre morceau");
  assert.deepEqual(stopReasons(), ["track_changed"]);

  // Une publicité ne termine pas le morceau ; l'élément audio terminé, si.
  await loadSingle();
  await player(100, true);
  await player(0, true, "Publicité", { isAdvertisement: true });
  assert.deepEqual(stopReasons(), []);
  await request({ type: "PLAYER_ENDED", snapshot: { metadata, positionSeconds: 101, durationSeconds: 337, isPlaying: false } }, spotifyTab);
  assert.deepEqual(stopReasons(), ["track_ended"]);
}
assert.deepEqual(unhandled, [], "Aucune promesse rejetée sans traitement.");
console.log("Reprise après échec : téléchargement de secours, arrêt jamais bloqué et capture orpheline libérée vérifiés");
