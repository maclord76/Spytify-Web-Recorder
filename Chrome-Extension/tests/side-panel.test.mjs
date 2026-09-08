import assert from "node:assert/strict";

let listener;
let actionClick;
let actionPopup;
let authorized = false;
let savedState;
let restoredState;
let sessionData = {};
let missingTabId = null;
let restoredTabOverride = null;
let panelOpens = 0;
let streamRequests = 0;
let releaseChecks = 0;
let remainingActiveChecks = 0;
let reloads = 0;
let prepareTrackRequests = 0;
let streamGate = null;
const streamTabIds = [];
const inspectedTabIds = [];
const version = "9.8.7";
const permissionError = "Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.";
const tab = { id: 7, windowId: 1, url: "https://open.spotify.com/track/test", status: "complete" };
const otherTab = { id: 8, windowId: 1, url: "https://open.spotify.com/track/other", status: "complete" };
const metadata = { title: "Titre", artist: "Artiste" };
let pageMetadata = metadata;
let playerTitle = metadata.title;
let queriedTab = tab;

globalThis.chrome = {
  offscreen: { async closeDocument() {} },
  sidePanel: {
    async setPanelBehavior(options) { assert.equal(options.openPanelOnActionClick, false); },
    async open() { panelOpens++; }
  },
  action: {
    onClicked: { addListener(fn) { actionClick = fn; } },
    async setPopup(options) { actionPopup = options.popup; },
    async setBadgeText() {}
  },
  storage: { local: {
    async get() { return restoredState ? { recorderState: restoredState } : {}; },
    async set(value) { if (value.recorderState) savedState = { ...value.recorderState }; }
  }, session: {
    async get() { return { ...sessionData }; },
    async set(value) { Object.assign(sessionData, value); },
    async remove(key) { delete sessionData[key]; }
  } },
  runtime: {
    onMessage: { addListener(fn) { listener = fn; } },
    getURL(path) { return `chrome-extension://test/${path}`; },
    getManifest() { return { version }; },
    async getContexts() { return [{}]; },
    async sendMessage() { return { ok: true }; }
  },
  tabs: {
    async query() { return [queriedTab]; },
    async reload(id) { assert.equal(id, tab.id); reloads++; },
    async get(id) {
      inspectedTabIds.push(id);
      if (id === missingTabId) throw new Error('No tab with id: ' + id);
      if (restoredTabOverride?.id === id) return restoredTabOverride;
      return id === tab.id ? tab : otherTab;
    },
    async sendMessage(id, message) {
      assert.equal(id, tab.id, "Les contrôles du morceau restent liés à l'onglet autorisé.");
      if (message.type === "WAIT_PAGE_TRACK_READY") return { ready: true, metadata: pageMetadata };
      if (message.type === "PREPARE_TRACK") prepareTrackRequests++;
      return { prepared: true };
    },
    onRemoved: { addListener() {} }
  },
  scripting: { async executeScript(options) {
    assert.equal(options.target.tabId, tab.id);
    return [{ result: { title: playerTitle, label: "Lecture", position: "0:00", duration: "3:00" } }];
  } },
  tabCapture: {
    async getCapturedTabs() {
      releaseChecks++;
      return remainingActiveChecks-- > 0 ? [{ tabId: tab.id, status: "active" }] : [];
    },
    async getMediaStreamId(options) {
      streamRequests++;
      streamTabIds.push(options.targetTabId);
      if (!authorized) throw new Error(permissionError);
      if (streamGate) await streamGate;
      return "stream";
    }
  }
};

await import("../background.js");
const flush = () => new Promise(resolve => setImmediate(resolve));
const prepare = (options = {}) => new Promise(resolve => {
  listener({ type: "PREPARE_CURRENT_TRACK", options }, {}, resolve);
});

const response = await prepare({ bitrate: 256 });
assert.equal(response.ok, true);
assert.equal(response.state.phase, "capture_permission");
assert.match(response.state.message, /icône Spytify/);
assert.equal(response.state.permissionError, permissionError);
assert.equal(response.state.permissionActionReceived, false);
assert.equal(reloads, 1);
assert.equal(prepareTrackRequests, 1);

// Un clic sur un autre onglet ne doit pas préparer ni capturer le morceau.
const beforeWrongTab = streamRequests;
actionClick(otherTab);
await flush();
assert.equal(savedState.phase, "capture_permission");
assert.equal(streamRequests, beforeWrongTab);
assert.equal(reloads, 1);
assert.equal(prepareTrackRequests, 1);

// Un nouveau refus conserve la cause Chrome et prouve que le clic a été reçu.
actionClick(tab);
await flush();
assert.equal(savedState.phase, "capture_permission");
assert.equal(savedState.permissionError, permissionError);
assert.equal(savedState.permissionActionReceived, true);
assert.ok(savedState.message.includes(version), "Le refus après clic indique la version réellement chargée.");
assert.equal(reloads, 1, "La reprise ne recharge pas Spotify.");
assert.equal(prepareTrackRequests, 1, "La reprise ne prépare pas une seconde fois le lecteur.");

// Le tab.id reçu au clic reste la cible, même si l'onglet actif change ensuite.
authorized = true;
queriedTab = otherTab;
const inspectedBeforeResume = inspectedTabIds.length;
actionClick(tab);
await flush();
assert.equal(savedState.phase, "prepared");
assert.equal(savedState.bitrate, 256);
assert.equal(savedState.tabId, tab.id);
assert.equal(streamTabIds.at(-1), tab.id);
assert.ok(inspectedTabIds.slice(inspectedBeforeResume).includes(tab.id));
assert.equal(reloads, 1);
assert.equal(prepareTrackRequests, 1);
assert.equal(panelOpens, 3);
queriedTab = tab;

// Deux clics rapprochés partagent la capture, y compris si elle attend Chrome.
authorized = false;
assert.equal((await prepare()).state.phase, "capture_permission");
const beforeDoubleClick = streamRequests;
const reloadsBeforeDoubleClick = reloads;
const preparationsBeforeDoubleClick = prepareTrackRequests;
let releaseStream;
streamGate = new Promise(resolve => { releaseStream = resolve; });
authorized = true;
actionClick(tab);
await flush();
actionClick(tab);
await flush();
assert.equal(streamRequests - beforeDoubleClick, 1, "Les clics simultanés partagent une seule capture.");
releaseStream();
await flush();
streamGate = null;
assert.equal(savedState.phase, "prepared");
assert.equal(reloads, reloadsBeforeDoubleClick);
assert.equal(prepareTrackRequests, preparationsBeforeDoubleClick);

// Un autre morceau chargé pendant l'attente ne doit pas être enregistré.
authorized = false;
assert.equal((await prepare()).state.phase, "capture_permission");
const beforeChangedTrack = streamRequests;
const reloadsBeforeChangedTrack = reloads;
pageMetadata = { title: "Autre morceau", artist: "Autre artiste" };
playerTitle = pageMetadata.title;
authorized = true;
actionClick(tab);
await flush();
assert.equal(savedState.phase, "error");
assert.equal(streamRequests, beforeChangedTrack, "Un morceau différent est refusé avant toute capture.");
assert.equal(reloads, reloadsBeforeChangedTrack);
pageMetadata = metadata;
playerTitle = metadata.title;

// Conserver le contrôle de libération du flux et la sérialisation de l'étape 2.
remainingActiveChecks = 2;
const before = streamRequests;
const results = await Promise.all([prepare(), prepare()]);
assert.ok(results.every(result => result.ok));
assert.equal(streamRequests - before, 1, "Les préparations simultanées partagent une seule capture.");
assert.ok(releaseChecks >= 5, "Attendre la libération effective du flux précédent.");
// Le vrai parcours de la page d'action ne dépend plus de onClicked.
authorized = false;
await prepare();
assert.equal(actionPopup, "authorize.html");
const authorize = (url = chrome.runtime.getURL("authorize.html")) => new Promise(resolve => {
  listener({ type: "AUTHORIZE_CAPTURE" }, { url }, resolve);
});
const beforePopup = streamRequests;
assert.equal((await authorize(chrome.runtime.getURL("popup.html"))).ok, false);
assert.equal(streamRequests, beforePopup, "Le panneau ne peut pas se faire passer pour le clic Chrome.");
const refusedPopup = await authorize();
assert.equal(refusedPopup.state.phase, "capture_permission");
assert.equal(refusedPopup.state.permissionActionReceived, true);
assert.equal(actionPopup, "authorize.html");
authorized = true;
const reloadsBeforePopup = reloads;
const authorizedPopup = await authorize();
assert.equal(authorizedPopup.ok, true);
assert.equal(authorizedPopup.state.phase, "prepared");
assert.equal(reloads, reloadsBeforePopup, "La fenêtre d'autorisation ne recharge pas Spotify.");
assert.equal(actionPopup, "", "Après succès, l'icône retrouve l'ouverture du panneau.");
authorized = false;
await prepare();
queriedTab = otherTab;
const wrongPopup = await authorize();
assert.equal(wrongPopup.ok, false);
assert.match(wrongPopup.error, /onglet préparé/);
assert.equal(savedState.phase, "error");
assert.equal(actionPopup, "");
queriedTab = tab;

// La restauration d'un worker conserve l'onglet tant que la session Chrome existe.
const readState = () => new Promise(resolve => {
  listener({ type: "GET_STATE" }, {}, resolve);
});
const pendingPermission = {
  phase: "capture_permission",
  recording: false,
  elapsedSeconds: 0,
  metadata,
  tabId: tab.id,
  bitrate: 256,
  message: "Autorisation en attente",
  permissionError,
  permissionActionReceived: false
};
restoredState = { ...pendingPermission };
sessionData = { capturePermissionTabId: tab.id };
const streamsBeforeRestoration = streamRequests;
await import("../background.js?restore-valid-session");
const validRestoration = await readState();
assert.equal(validRestoration.ok, true);
assert.equal(validRestoration.state.phase, "capture_permission");
assert.equal(validRestoration.state.tabId, tab.id);
assert.equal(validRestoration.state.bitrate, 256);
assert.equal(streamRequests, streamsBeforeRestoration, "Restaurer l'état ne commence aucune capture.");

// Un ancien identifiant d'onglet disparu ne doit pas attendre un clic impossible.
restoredState = { ...pendingPermission, tabId: 77 };
sessionData = { capturePermissionTabId: 77 };
missingTabId = 77;
await import("../background.js?restore-missing-tab");
const missingRestoration = await readState();
assert.equal(missingRestoration.ok, true);
assert.equal(missingRestoration.state.phase, "idle");
assert.equal(missingRestoration.state.tabId, null);
assert.match(missingRestoration.state.message, /session Chrome.*changé/i);
assert.match(missingRestoration.state.message, /2/);
assert.equal(savedState.phase, "idle", "Le nettoyage de l'ancien état est enregistré.");
missingTabId = null;

// Un identifiant associé à une autre page ne restaure pas la permission Spotify.
restoredState = { ...pendingPermission };
sessionData = { capturePermissionTabId: tab.id };
restoredTabOverride = { ...tab, url: "https://example.com/" };
await import("../background.js?restore-non-spotify-tab");
const nonSpotifyRestoration = await readState();
assert.equal(nonSpotifyRestoration.ok, true);
assert.equal(nonSpotifyRestoration.state.phase, "idle");
assert.equal(nonSpotifyRestoration.state.tabId, null);
restoredTabOverride = null;

// Les identifiants peuvent être réutilisés après un redémarrage de Chrome.
// La sentinelle de session vide doit invalider même un onglet Spotify de même ID.
restoredState = { ...pendingPermission };
sessionData = {};
await import("../background.js?restore-new-browser-session");
const newSessionRestoration = await readState();
assert.equal(newSessionRestoration.ok, true);
assert.equal(newSessionRestoration.state.phase, "idle");
assert.equal(newSessionRestoration.state.tabId, null);
assert.match(newSessionRestoration.state.message, /session Chrome.*changé/i);
assert.equal(streamRequests, streamsBeforeRestoration);
console.log("Autorisation du panneau : reprise sans rechargement, cible stable, diagnostic, concurrence et restauration de session vérifiés");
