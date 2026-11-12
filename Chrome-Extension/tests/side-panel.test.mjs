import assert from "node:assert/strict";

// Parcours « Un morceau » en un clic : la capture surveille l'onglet pendant le
// chargement de la page ; la lecture n'est lancée que si Spotify ne l'a pas fait.
// Horloge virtuelle : les attentes courtes passent aussitôt, les délais de
// garde (chargement de 20 s, MP3 conservés) ne se déclenchent pas.
let clock = 1_000_000;
Date.now = () => clock;
globalThis.setTimeout = (callback, delay = 0) => {
  if (delay >= 10_000) return 0;
  clock += delay;
  setImmediate(callback);
  return 0;
};
globalThis.clearTimeout = () => {};

const version = "9.8.7";
const permissionError = "Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.";
const trackId = "4cOdK2wGLETKBW3PvgPWqT";
const trackUrl = `https://open.spotify.com/track/${trackId}`;
const metadata = { title: "Titre", artist: "Artiste" };
const tab = { id: 7, windowId: 1, url: "https://open.spotify.com/playlist/test", status: "complete" };
const otherTab = { id: 8, windowId: 1, url: "https://open.spotify.com/track/other", status: "complete" };

let listener, actionClick, actionPopup, savedState, restoredState = null;
let sessionData = {};
let authorized = false;
let queriedTab = tab;
let missingTabId = null;
let restoredTabOverride = null;
let streamRequests = 0;
let streamGate = null;
let offscreenStatus = { ok: true, active: false };
let onStop = null;
let pageMetadata = metadata;
const streamTabIds = [], navigations = [], createdTabs = [], stops = [], downloads = [], clicks = [], keys = [];
const updatedListeners = new Set();

// Lecteur Spotify simulé. « autoplay » : Spotify lance seul le morceau après le
// chargement ; « restored » : il affiche ce morceau en pause à 1:23 ;
// « effective » : les clics ont un effet.
const player = { title: "Ancien titre", playing: false, position: 0, since: 0 };
let afterLoad = "previous";
let clicksEffective = true;
const position = () => player.playing ? player.position + (clock - player.since) / 1000 : player.position;
const play = () => { player.position = position(); player.playing = true; player.since = clock; };
const pause = () => { player.position = position(); player.playing = false; };
function loadPage() {
  if (afterLoad === "autoplay") Object.assign(player, { title: "Titre", playing: true, position: 0, since: clock });
  else if (afterLoad === "restored") Object.assign(player, { title: "Titre", playing: false, position: 83 });
  else Object.assign(player, { title: "Ancien titre", playing: false, position: 0 });
}
const time = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

function readButton(expression) {
  if (expression.includes("slider.focus()")) return true;
  const source = /, "(player|page)", \{/.exec(expression)[1];
  const shows = player.title === "Titre";
  if (source === "player" && !shows) return { ready: false, reason: "title" };
  return {
    ready: true, label: player.playing ? "Pause" : "Lecture", alreadyPlaying: shows && player.playing,
    positionSeconds: Math.floor(position()), x: source === "page" ? 200 : 100, y: source === "page" ? 100 : 700,
    cibleAtteinte: true
  };
}

globalThis.chrome = {
  debugger: {
    async attach(target) { assert.equal(target.tabId, tab.id); },
    async detach() {},
    async sendCommand(target, method, parameters) {
      assert.equal(target.tabId, tab.id, "Le lecteur piloté est celui de l'onglet enregistré.");
      if (method === "Runtime.evaluate") return { result: { value: readButton(parameters.expression) } };
      if (method === "Input.dispatchMouseEvent" && parameters.type === "mouseReleased") {
        clicks.push(parameters.y === 100 ? "page" : "player");
        if (!clicksEffective) return {};
        if (parameters.y === 100) {
          if (player.title !== "Titre") Object.assign(player, { title: "Titre", position: 0 });
          play();
        } else if (player.playing) pause();
        else play();
      }
      if (method === "Input.dispatchKeyEvent" && parameters.type === "keyUp") {
        keys.push(parameters.key);
        player.position = 0;
      }
      return {};
    }
  },
  offscreen: { async closeDocument() {} },
  sidePanel: { async setPanelBehavior() {}, async open() {} },
  action: {
    onClicked: { addListener(fn) { actionClick = fn; } },
    async setPopup(options) { actionPopup = options.popup; },
    async setBadgeText() {},
    async setBadgeBackgroundColor() {}
  },
  storage: {
    local: {
      async get() { return restoredState ? { recorderState: restoredState } : {}; },
      async set(value) { if (value.recorderState) savedState = structuredClone(value.recorderState); },
      async remove() {}
    },
    session: {
      async get(key) { return typeof key === "string" ? { [key]: sessionData[key] } : { ...sessionData }; },
      async set(value) { Object.assign(sessionData, structuredClone(value)); },
      async remove(key) { delete sessionData[key]; }
    }
  },
  runtime: {
    onMessage: { addListener(fn) { listener = fn; } },
    getURL(path) { return `chrome-extension://test/${path}`; },
    getManifest() { return { version, name: "Spytify", minimum_chrome_version: "116" }; },
    async getContexts() { return [{}]; },
    async sendMessage(message) {
      if (message.type === "OFFSCREEN_GET_STATUS") return offscreenStatus;
      if (message.type === "OFFSCREEN_CANCEL_CAPTURE") offscreenStatus = { ok: true, active: false };
      if (message.type === "OFFSCREEN_START_CAPTURE") {
        assert.equal(message.tabId, tab.id);
        offscreenStatus = { ok: true, active: true, mode: "monitor", sessionId: message.sessionId };
      }
      if (message.type === "OFFSCREEN_STOP_MONITORING") {
        stops.push(message.reason);
        // Le document hors écran exporte les derniers segments avant de répondre.
        if (onStop) await onStop(message);
        offscreenStatus = { ok: true, active: false };
      }
      return { ok: true };
    }
  },
  tabs: {
    async query() { return [queriedTab]; },
    async get(id) {
      if (id === missingTabId) throw new Error(`No tab with id: ${id}`);
      if (restoredTabOverride?.id === id) return restoredTabOverride;
      return id === tab.id ? tab : otherTab;
    },
    async create(options) {
      createdTabs.push(options.url);
      return { ...otherTab, id: 9, url: options.url };
    },
    async update(id, options) {
      assert.equal(id, tab.id);
      navigations.push(options.url);
      setImmediate(() => {
        updatedListeners.forEach((fn) => fn(id, { status: "loading" }));
        loadPage();
        setImmediate(() => updatedListeners.forEach((fn) => fn(id, { status: "complete" })));
      });
      return tab;
    },
    async sendMessage(id, message) {
      assert.equal(id, tab.id, "Les contrôles du morceau restent liés à l'onglet autorisé.");
      if (message.type === "WAIT_PAGE_TRACK_READY") return { ok: true, ready: Boolean(pageMetadata), metadata: pageMetadata };
      if (message.type === "GET_PLAYER_SNAPSHOT") {
        return { ok: true, snapshot: { metadata: { title: player.title, artist: "Artiste" }, isPlaying: player.playing,
          positionSeconds: position(), durationSeconds: 180, isAdvertisement: false } };
      }
      return { ok: true };
    },
    onUpdated: { addListener: (fn) => updatedListeners.add(fn), removeListener: (fn) => updatedListeners.delete(fn) },
    onRemoved: { addListener() {} }
  },
  scripting: {
    async executeScript(options) {
      assert.equal(options.target.tabId, tab.id);
      return [{ result: { title: player.title, label: player.playing ? "Pause" : "Lecture",
        position: time(position()), duration: "3:00", device: "", hasBeenActive: true } }];
    }
  },
  tabCapture: {
    async getCapturedTabs() { return []; },
    async getMediaStreamId(options) {
      streamRequests++;
      streamTabIds.push(options.targetTabId);
      if (!authorized) throw new Error(permissionError);
      if (streamGate) await streamGate;
      return "stream";
    }
  },
  downloads: {
    async download(options) { downloads.push(options); return downloads.length; },
    async search({ id }) { return [{ id, state: "complete" }]; },
    onChanged: { addListener() {}, removeListener() {} }
  }
};

await import("../background.js");
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate, label) {
  for (let attempt = 0; attempt < 20_000; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  assert.fail(`Délai dépassé : ${label}`);
}
const panel = { url: chrome.runtime.getURL("popup.html") };
const offscreen = { url: chrome.runtime.getURL("offscreen.html") };
const request = (message, sender = panel) => new Promise((resolve) => listener(message, sender, resolve));
const record = (url = trackUrl) => request({ type: "START_SINGLE_TRACK", options: { url, bitrate: 256 } });
const settled = () => until(() => savedState.playbackStarted || savedState.phase === "error", "fin du lancement");
const ready = (meta, sessionId = savedState.monitorSessionId) => request({ type: "MONITOR_TRACK_READY", sessionId,
  url: "blob:chrome-extension://test/mp3", metadata: meta, durationSeconds: 225.7 }, offscreen);

// Un script de contenu Spotify ne peut ni lancer, ni télécharger, ni lire le diagnostic.
for (const type of ["START_SINGLE_TRACK", "MONITOR_TRACK_READY", "COLLECT_DIAGNOSTICS", "STOP_MONITORING"]) {
  const refused = await request({ type, url: "blob:chrome-extension://test/x", metadata },
    { tab: { id: tab.id }, url: tab.url });
  assert.equal(refused.ok, false, `${type} refusé depuis un onglet`);
}
assert.equal(streamRequests, 0);

// Une URL invalide ne touche ni à Spotify ni à la capture.
assert.equal((await record("https://example.com/track/x")).ok, false);
assert.equal(streamRequests, 0);
assert.equal(navigations.length, 0);

// Sans autorisation, rien n'est chargé : la capture doit précéder le chargement.
const response = await record();
assert.equal(response.ok, true);
assert.equal(response.state.phase, "capture_permission");
assert.equal(response.state.mode, "single");
assert.equal(response.state.track.trackId, trackId);
assert.match(response.state.message, /icône Spytify/);
assert.equal(response.state.permissionError, permissionError);
assert.equal(response.state.permissionActionReceived, false);
assert.equal(actionPopup, "authorize.html");
assert.equal(navigations.length, 0);

// Un clic sur un autre onglet ne lance rien.
actionClick(otherTab);
await flush();
assert.equal(savedState.phase, "capture_permission");
assert.equal(streamRequests, 1);

// Un nouveau refus conserve la cause Chrome et prouve que le clic a été reçu.
actionClick(tab);
await flush(); await flush();
assert.equal(savedState.phase, "capture_permission");
assert.equal(savedState.permissionActionReceived, true);
assert.ok(savedState.message.includes(version), "Le refus après clic indique la version réellement chargée.");
assert.equal(navigations.length, 0);

// Autorisé : capture armée, puis chargement de la page. Spotify ne lance pas le
// morceau (le lecteur affiche encore le titre précédent) : le gros bouton de la
// page le lance après le délai laissé à Spotify.
authorized = true;
queriedTab = otherTab;
const clockBeforeLaunch = clock;
actionClick(tab);
await until(() => savedState.phase === "monitoring", "armement");
assert.equal(savedState.monitoring, true);
assert.equal(savedState.tabId, tab.id, "Le clic reste lié à l'onglet autorisé même après un changement d'onglet.");
assert.equal(savedState.bitrate, 256);
assert.equal(streamTabIds.at(-1), tab.id);
assert.equal(actionPopup, "");
await settled();
assert.deepEqual(navigations, [`${trackUrl}?autoplay_ok=1`]);
assert.equal(savedState.playbackStarted, true);
assert.deepEqual(savedState.target, metadata);
assert.deepEqual(clicks, ["page"]);
assert.ok(clock - clockBeforeLaunch >= 4000, "Spotify dispose de quatre secondes pour lancer seul le morceau.");
assert.match(savedState.message, /lancée automatiquement/);
assert.equal(updatedListeners.size, 0, "L'écoute du chargement est retirée.");
queriedTab = tab;

// Pendant la session, seul le morceau demandé est téléchargé.
assert.deepEqual(await ready({ title: "Ancien titre", artist: "Artiste" }), { ok: true, completed: true, discarded: true });
assert.equal((await ready({ ...metadata, partial: true })).discarded, true,
  "Un extrait en cours de session est un reste du chargement ou d'un saut.");
assert.equal(downloads.length, 0);
const kept = await ready(metadata);
assert.equal(kept.ok, true);
assert.equal(downloads.length, 1);
assert.equal(downloads[0].filename, "Spytify Web/Artiste - Titre.mp3");
await until(() => savedState.phase === "done", "arrêt après le MP3");
assert.deepEqual(stops, ["track_ended"]);
assert.equal(savedState.monitoring, false);
assert.equal(savedState.capturedTracks, 1);
assert.equal(savedState.message, "MP3 téléchargé : Artiste - Titre.mp3 (03:45)", "Le message de fin donne la durée enregistrée.");
assert.deepEqual(savedState.metadata, metadata);
assert.equal((await ready(metadata)).ok, false, "Une session terminée ne télécharge plus rien.");

// Spotify lance le morceau de lui-même : aucun clic, pour ne pas le mettre en pause.
clicks.length = 0;
afterLoad = "autoplay";
const before = clock;
await record();
await settled();
assert.equal(savedState.playbackStarted, true);
assert.deepEqual(clicks, [], "Un morceau lancé par Spotify n'est jamais cliqué.");
assert.ok(clock - before < 4000, "Le démarrage spontané est confirmé sans attendre le délai complet.");
assert.match(savedState.message, /Spotify a lancé le morceau/);
// Un second démarrage pendant la session est refusé.
assert.equal((await record()).ok, false);
assert.equal(savedState.monitoring, true);
// L'arrêt manuel garde le morceau en cours sous forme d'extrait.
onStop = () => ready({ ...metadata, partial: true });
const stopped = await request({ type: "STOP_MONITORING" });
onStop = null;
assert.equal(stopped.state.phase, "done");
assert.equal(downloads.at(-1).filename, "Spytify Web/Artiste - Titre (extrait).mp3");

// Spotify restaure ce morceau en pause au milieu : retour au début, puis lecture.
clicks.length = 0;
afterLoad = "restored";
await record();
await settled();
assert.deepEqual(keys, ["Home"]);
assert.deepEqual(clicks, ["player"]);
assert.ok(savedState.playbackStarted);
assert.ok(player.position < 2 && player.playing, "Le morceau repart de 0:00.");
await request({ type: "STOP_MONITORING" });

// Sans URL, le morceau affiché dans l'onglet Spotify est enregistré.
afterLoad = "autoplay";
tab.url = `${trackUrl}?si=partage`;
await request({ type: "START_SINGLE_TRACK", options: { url: "", bitrate: 192 } });
await settled();
assert.equal(navigations.at(-1), `${trackUrl}?autoplay_ok=1`);
await request({ type: "STOP_MONITORING" });
tab.url = "https://open.spotify.com/playlist/test";
const noTrack = await request({ type: "START_SINGLE_TRACK", options: { url: "" } });
assert.equal(noTrack.ok, false);
assert.match(noTrack.error, /URL d'un morceau/);

// Lancement impossible : deux essais, puis abandon sans aucun MP3.
clicks.length = 0;
afterLoad = "previous";
clicksEffective = false;
const downloadsBeforeFailure = downloads.length;
onStop = () => ready({ ...metadata, partial: true });
await record();
await until(() => savedState.phase === "error", "abandon");
onStop = null;
clicksEffective = true;
assert.equal(clicks.filter((target) => target === "page").length, 2);
assert.equal(stops.at(-1), "aborted");
assert.equal(downloads.length, downloadsBeforeFailure, "Un lancement abandonné ne télécharge aucun extrait.");
assert.equal(savedState.monitoring, false);
assert.match(savedState.message, /La lecture n'a pas pu être lancée.*Ancien titre/);
const diagnostics = await request({ type: "COLLECT_DIAGNOSTICS" });
assert.ok(diagnostics.diagnostics.lancement.etapes.some((step) => step.nom === "lancement"));
assert.equal(diagnostics.diagnostics.lancement.termine, true);

// Une page qui n'affiche pas le morceau abandonne la session.
pageMetadata = null;
await record();
await until(() => savedState.phase === "error", "page absente");
assert.match(savedState.message, /n'a pas affiché ce morceau/);
pageMetadata = metadata;

// Sans onglet Spotify affiché, le morceau s'ouvre dans un nouvel onglet, dont la
// capture demande le clic sur l'icône.
authorized = false;
queriedTab = { id: 3, url: "https://example.com/" };
const opened = await record();
assert.deepEqual(createdTabs, [`${trackUrl}?autoplay_ok=1`]);
assert.equal(opened.state.phase, "capture_permission");
assert.equal(opened.state.tabId, 9);
queriedTab = tab;

// Deux clics rapprochés partagent la capture, y compris si elle attend Chrome.
assert.equal((await record()).state.phase, "capture_permission");
const beforeDoubleClick = streamRequests;
let releaseStream;
streamGate = new Promise((resolve) => { releaseStream = resolve; });
authorized = true;
afterLoad = "autoplay";
actionClick(tab);
await flush();
actionClick(tab);
await flush();
assert.equal(streamRequests - beforeDoubleClick, 1, "Les clics simultanés partagent une seule capture.");
releaseStream();
streamGate = null;
await until(() => savedState.phase === "monitoring", "armement partagé");
await settled();
await request({ type: "STOP_MONITORING" });

// La fenêtre d'autorisation est le parcours réel de l'icône pendant l'attente.
authorized = false;
await record();
assert.equal(actionPopup, "authorize.html");
const authorize = (url = chrome.runtime.getURL("authorize.html")) => request({ type: "AUTHORIZE_CAPTURE" }, { url });
const beforePopup = streamRequests;
assert.equal((await authorize(chrome.runtime.getURL("popup.html"))).ok, false);
assert.equal(streamRequests, beforePopup, "Le panneau ne peut pas se faire passer pour le clic Chrome.");
const refusedPopup = await authorize();
assert.equal(refusedPopup.state.phase, "capture_permission");
assert.equal(refusedPopup.state.permissionActionReceived, true);
authorized = true;
const authorizedPopup = await authorize();
assert.equal(authorizedPopup.ok, true);
assert.equal(authorizedPopup.state.monitoring, true);
assert.equal(actionPopup, "", "Après succès, l'icône retrouve l'ouverture du panneau.");
await settled();
await request({ type: "STOP_MONITORING" });
authorized = false;
await record();
queriedTab = otherTab;
const wrongPopup = await authorize();
assert.equal(wrongPopup.ok, false);
assert.match(wrongPopup.error, /onglet du morceau/);
assert.equal(savedState.phase, "error");
queriedTab = tab;

// Un lancement interrompu par la veille du worker reprend sans recharger la page.
const navigationsBeforeRestore = navigations.length;
afterLoad = "autoplay";
loadPage();
restoredState = { phase: "monitoring", mode: "single", monitoring: true, monitorSessionId: "reprise", tabId: tab.id,
  bitrate: 192, track: { trackId, url: `${trackUrl}?autoplay_ok=1` }, target: metadata, playbackStarted: false };
offscreenStatus = { ok: true, active: true, mode: "monitor", sessionId: "reprise",
  monitorState: { recording: true, metadata, elapsedSeconds: 1 } };
await import("../background.js?restore-launch");
await until(() => savedState.playbackStarted, "reprise du lancement");
assert.equal(navigations.length, navigationsBeforeRestore);
assert.equal(savedState.monitorSessionId, "reprise");
await request({ type: "STOP_MONITORING" });

// La restauration d'un worker conserve l'onglet tant que la session Chrome existe.
const pendingPermission = {
  phase: "capture_permission", mode: "single", recording: false, elapsedSeconds: 0, metadata: null,
  tabId: tab.id, bitrate: 256, track: { trackId, url: `${trackUrl}?autoplay_ok=1` },
  message: "Autorisation en attente", permissionError, permissionActionReceived: false
};
restoredState = { ...pendingPermission };
sessionData = { capturePermissionTabId: tab.id };
const streamsBeforeRestoration = streamRequests;
await import("../background.js?restore-valid-session");
const validRestoration = (await request({ type: "GET_STATE" })).state;
assert.equal(validRestoration.phase, "capture_permission");
assert.equal(validRestoration.tabId, tab.id);
assert.equal(validRestoration.track.trackId, trackId);
assert.equal(streamRequests, streamsBeforeRestoration, "Restaurer l'état ne commence aucune capture.");

// Un ancien identifiant d'onglet disparu ne doit pas attendre un clic impossible.
restoredState = { ...pendingPermission, tabId: 77 };
sessionData = { capturePermissionTabId: 77 };
missingTabId = 77;
await import("../background.js?restore-missing-tab");
const missingRestoration = (await request({ type: "GET_STATE" })).state;
assert.equal(missingRestoration.phase, "idle");
assert.equal(missingRestoration.tabId, null);
assert.match(missingRestoration.message, /session Chrome.*changé/i);
missingTabId = null;

// Un identifiant associé à une autre page ne restaure pas la permission Spotify.
restoredState = { ...pendingPermission };
sessionData = { capturePermissionTabId: tab.id };
restoredTabOverride = { ...tab, url: "https://example.com/" };
await import("../background.js?restore-non-spotify-tab");
assert.equal((await request({ type: "GET_STATE" })).state.phase, "idle");
restoredTabOverride = null;

// Les identifiants peuvent être réutilisés après un redémarrage de Chrome.
restoredState = { ...pendingPermission };
sessionData = {};
await import("../background.js?restore-new-browser-session");
const newSessionRestoration = (await request({ type: "GET_STATE" })).state;
assert.equal(newSessionRestoration.phase, "idle");
assert.match(newSessionRestoration.message, /session Chrome.*changé/i);

// Un état de l'ancien parcours en trois étapes revient au repos.
restoredState = { phase: "prepared", mode: "single", tabId: tab.id, metadata };
await import("../background.js?restore-old-phase");
assert.equal((await request({ type: "GET_STATE" })).state.phase, "idle");
assert.equal(streamRequests, streamsBeforeRestoration);
console.log("Un morceau en un clic : capture avant chargement, démarrage spontané respecté, lancement automatique, retour au début, tri des MP3, autorisation et restauration vérifiés");
