import { describeRecording, parseSpotifyTrackUrl, recordingFilename } from "./core.js";
import { rewindTrackPlayback, startTrackPlayback } from "./player-control.js";
import { waitForConfirmedPlayback } from "./playback-verification.js";
import "./spotify-player.js";

const { isPlayingLabel, normalizeTitle, parseTime, TITLE_SELECTORS } = globalThis.SpytifyPlayer;

const OFFSCREEN_URL = "offscreen.html";

// Le panneau global reste accessible lors des changements d'onglet.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error);

chrome.action.onClicked.addListener((tab) => {
  // Le clic sur l'icône autorise tabCapture pour cet onglet. Un clic dans
  // le panneau seul ne la donne pas toujours, notamment pour un nouvel onglet.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);
  void restorePromise.then(async () => {
    if (recorderState.phase !== "capture_permission" || recorderState.tabId !== tab.id) return;
    try {
      await resumeCapturePermission(tab);
    } catch (error) {
      await setState({ phase: "error", message: error.message });
    }
  }).catch(console.error);
});
const DEFAULT_STATE = {
  phase: "idle",
  mode: "single",
  monitoring: false,
  advertisement: false,
  capturedTracks: 0,
  lastMonitoredFilename: null,
  recording: false,
  elapsedSeconds: 0,
  metadata: null,
  tabId: null,
  // Mode « Un morceau » : morceau demandé (URL), titre affiché par sa page et
  // démarrage confirmé de sa lecture.
  track: null,
  target: null,
  playbackStarted: false,
  message: "Prêt"
};

let recorderState = { ...DEFAULT_STATE };
let consecutiveTrackChanges = 0;
// Position la plus avancée et durée observées pendant l'enregistrement individuel.
let singleTrackProgress = null;
const TRACK_END_TOLERANCE_SECONDS = 3;
// Mode « Un morceau » : délai laissé à Spotify pour lancer seul le morceau
// après le chargement de sa page, puis pour confirmer chaque lancement.
const SPONTANEOUS_START_MILLISECONDS = 4000;
const LAUNCH_CONFIRMATION_MILLISECONDS = 8000;
const LAUNCH_ATTEMPTS = 2;
const TRACK_PAGE_LOAD_MILLISECONDS = 20000;
let publishedPlayerObservation = null;
// Un lancement interrompu par la mise en veille du worker reprend après la
// restauration, sans recharger la page.
let launchToResume = false;

const restorePromise = restoreState().then(() => chrome.action.setPopup({
  popup: recorderState.phase === "capture_permission" ? "authorize.html" : ""
})).then(() => {
  if (!launchToResume) return;
  launchToResume = false;
  void superviseSingleTrack(recorderState.tabId, recorderState.track, recorderState.monitorSessionId, { reload: false })
    .catch(console.error);
});

async function restoreState() {
  const saved = await chrome.storage.local.get(["recorderState"]);
  const previous = saved.recorderState;
  if (previous?.monitoring) {
    let audioStatus = null;
    try {
      await ensureOffscreenDocument(false);
      audioStatus = await chrome.runtime.sendMessage({
        type: "OFFSCREEN_GET_STATUS",
        target: "offscreen"
      });
    } catch {
      audioStatus = null;
    }

    const single = previous.mode === "single";
    recorderState = audioStatus?.active && audioStatus.mode === "monitor" && audioStatus.sessionId === previous.monitorSessionId
      ? { ...DEFAULT_STATE, ...previous, phase: "monitoring", monitoring: true,
          recording: Boolean(audioStatus.monitorState?.recording),
          metadata: single ? previous.target ?? null : audioStatus.monitorState?.metadata ?? null,
          advertisement: Boolean(audioStatus.monitorState?.advertisement),
          elapsedSeconds: audioStatus.monitorState?.elapsedSeconds ?? 0 }
      : { ...DEFAULT_STATE, mode: single ? "single" : "monitor", capturedTracks: previous.capturedTracks ?? 0,
          message: single
            ? "L'enregistrement du morceau a été interrompu. Relancez-le depuis le panneau."
            : "La surveillance a été interrompue. Affichez Spotify puis réactivez-la." };
    launchToResume = recorderState.monitoring && single && !recorderState.playbackStarted && Boolean(previous.track);
    await persistState();
  } else if (previous?.recording) {
    // Enregistrement d'une version précédente : aucune session à retrouver.
    recorderState = { ...DEFAULT_STATE, message: "L'enregistrement précédent a été interrompu" };
    await persistState();
  } else if (previous) {
    // Les phases de l'ancien parcours en trois étapes n'existent plus.
    const phase = ["idle", "done", "error", "capture_permission"].includes(previous.phase) ? previous.phase : "idle";
    recorderState = { ...DEFAULT_STATE, ...previous, phase };
    if (recorderState.phase === "capture_permission") {
      // Les identifiants d'onglet et leur autorisation ne survivent pas à une
      // nouvelle session Chrome. storage.session survit, lui, à la veille du worker.
      const session = await chrome.storage.session.get(["capturePermissionTabId"]);
      const tab = await chrome.tabs.get(recorderState.tabId).catch(() => null);
      if (
        session.capturePermissionTabId !== recorderState.tabId ||
        !tab?.url?.startsWith("https://open.spotify.com/")
      ) {
        recorderState = {
          ...DEFAULT_STATE,
          mode: recorderState.mode,
          message: "La session Chrome a changé. Affichez Spotify puis relancez l'enregistrement."
        };
        await persistState();
      }
    }
  }
}

async function persistState() {
  // Pendant l'attente, le clic Chrome ouvre une page d'action dédiée. Cette
  // page transmet la demande explicitement, sans dépendre de onClicked.
  await chrome.action.setPopup({
    popup: recorderState.phase === "capture_permission" ? "authorize.html" : ""
  });
  // Le script de contenu ne surveille le lecteur que pendant une session.
  const playerObservation = Boolean(recorderState.monitoring);
  if (playerObservation !== publishedPlayerObservation) {
    await chrome.storage.local.set({ recorderState, playerObservation });
    publishedPlayerObservation = playerObservation;
  } else {
    await chrome.storage.local.set({ recorderState });
  }
  const recordingBadge = recorderState.monitoring && (recorderState.mode === "single" || recorderState.recording);
  await chrome.action.setBadgeText({ text: recordingBadge ? "REC" : recorderState.monitoring ? "AUTO" : "" });
  if (recordingBadge) {
    await chrome.action.setBadgeBackgroundColor({ color: "#E91429" });
  } else if (recorderState.monitoring) {
    await chrome.action.setBadgeBackgroundColor({ color: "#1ED760" });
  }
  chrome.runtime.sendMessage({ type: "STATE_CHANGED", state: recorderState }).catch(() => {});
}

async function setState(patch) {
  recorderState = { ...recorderState, ...patch };
  if (patch.phase === "capture_permission") {
    await chrome.storage.session.set({ capturePermissionTabId: recorderState.tabId });
  }
  await persistState();
}

async function ensureOffscreenDocument(createIfMissing = true) {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_URL);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });
  if (contexts.length > 0) {
    return true;
  }
  if (!createIfMissing) {
    return false;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA"],
    justification: "Capturer et encoder localement le son de l'onglet choisi par l'utilisateur"
  });
  return true;
}

async function getSpotifyTab() {
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeSpotify = activeTabs.find((tab) => tab.url?.startsWith("https://open.spotify.com/"));
  if (activeSpotify) {
    return activeSpotify;
  }

  const spotifyTabs = await chrome.tabs.query({ url: "https://open.spotify.com/*" });
  if (!spotifyTabs.length) {
    throw new Error("Ouvrez d'abord le morceau dans Spotify Web.");
  }
  throw new Error("Affichez l'onglet Spotify Web avant de démarrer l'enregistrement.");
}

// Métadonnées lues dans la page du morceau elle-même : le lecteur inférieur
// peut encore afficher le titre écouté précédemment.
async function waitForTrackPage(tabId) {
  await ensureContentScript(tabId);
  const response = await chrome.tabs.sendMessage(tabId, {
    type: "WAIT_PAGE_TRACK_READY",
    timeoutMilliseconds: 10000
  });
  return response?.ready && response.metadata?.title ? response.metadata : null;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["spotify-player.js", "content.js"]
    });
  }
}

// Attendre la fin du chargement demandé, et non l'état « complete » de la page
// précédente : l'onglet doit d'abord repasser par « loading ».
async function loadTrackPage(tabId, url, timeoutMilliseconds = TRACK_PAGE_LOAD_MILLISECONDS) {
  let listener;
  let timer;
  const loaded = new Promise((resolve, reject) => {
    let loading = false;
    listener = (updatedTabId, change) => {
      if (updatedTabId !== tabId) return;
      if (change.status === "loading") loading = true;
      else if (change.status === "complete" && loading) resolve();
    };
    timer = setTimeout(() => reject(new Error(
      "Spotify n'a pas terminé le chargement du morceau. Relancez l'enregistrement."
    )), timeoutMilliseconds);
    chrome.tabs.onUpdated.addListener(listener);
  });
  try {
    await chrome.tabs.update(tabId, { url });
    await loaded;
  } finally {
    clearTimeout(timer);
    chrome.tabs.onUpdated.removeListener(listener);
  }
}

async function getSpotifyPlaybackState(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    args: [[...TITLE_SELECTORS]],
    func: (titleSelectors) => {
      let title = "";
      for (const selector of titleSelectors) {
        title = document.querySelector(selector)?.textContent?.trim() || "";
        if (title) break;
      }
      // Titre publié pour les commandes multimédias, à défaut du lecteur.
      title ||= String(navigator.mediaSession?.metadata?.title || "").trim();
      const bottomButton = document.querySelector('[data-testid="control-button-playpause"]');
      const devicePicker = document.querySelector('[data-testid="control-button-connect-picker"]');
      return {
        title,
        label: bottomButton?.getAttribute("aria-label") || "",
        position: document.querySelector('[data-testid="playback-position"]')?.textContent?.trim() || "",
        duration: document.querySelector('[data-testid="playback-duration"]')?.textContent?.trim() || "",
        device: devicePicker?.getAttribute("aria-label") || "",
        hasBeenActive: navigator.userActivation?.hasBeenActive ?? null
      };
    }
  });
  const state = results[0]?.result;
  return state
    ? {
        ...state,
        isPlaying: isPlayingLabel(state.label) === true,
        positionSeconds: parseTime(state.position),
        durationSeconds: parseTime(state.duration)
      }
    : null;
}

async function probeSpotifyPage(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const texte = (selector) => document.querySelector(selector)?.textContent?.trim() || null;
      const origine = (value) => {
        try { return value ? new URL(value, location.href).origin : null; } catch { return null; }
      };
      const button = document.querySelector('button[data-testid="control-button-playpause"]');
      const rect = button?.getBoundingClientRect();
      const centre = rect
        ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        : null;
      // Dit si les coordonnées visées par le clic atteignent vraiment le bouton
      // ou si un autre élément s'est glissé dessus.
      const survole = centre ? document.elementFromPoint(centre.x, centre.y) : null;
      return {
        chemin: location.pathname,
        titreOnglet: document.title,
        langue: document.documentElement.lang,
        fenetre: {
          innerWidth,
          innerHeight,
          devicePixelRatio,
          scrollY,
          visualViewport: visualViewport
            ? { width: visualViewport.width, height: visualViewport.height, offsetTop: visualViewport.offsetTop }
            : null
        },
        activation: navigator.userActivation
          ? { isActive: navigator.userActivation.isActive, hasBeenActive: navigator.userActivation.hasBeenActive }
          : null,
        bouton: button
          ? {
              ariaLabel: button.getAttribute("aria-label"),
              disabled: button.disabled,
              ariaDisabled: button.getAttribute("aria-disabled"),
              nombreDeRectangles: button.getClientRects().length,
              rectangle: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
              centre
            }
          : null,
        elementAuPointDuClic: survole
          ? {
              tag: survole.tagName,
              testId: survole.getAttribute("data-testid"),
              ariaLabel: survole.getAttribute("aria-label"),
              classe: String(survole.className || "").slice(0, 80),
              estLeBouton: survole === button || Boolean(button?.contains(survole))
            }
          : null,
        titrePage: texte('main [data-testid="entityTitle"]') || texte("main h1"),
        titresLecteur: {
          contextItemInfoTitle: texte('[data-testid="context-item-info-title"] a'),
          nowPlayingWidget: texte('[data-testid="now-playing-widget"] [data-testid="context-item-link"]'),
          contextItemLink: texte('[data-testid="context-item-link"]')
        },
        // Repli des métadonnées lorsque le lecteur n'expose plus ses data-testid.
        sessionMultimedia: navigator.mediaSession?.metadata
          ? {
              titre: navigator.mediaSession.metadata.title || null,
              artiste: navigator.mediaSession.metadata.artist || null,
              album: navigator.mediaSession.metadata.album || null
            }
          : null,
        position: texte('[data-testid="playback-position"]'),
        duree: texte('[data-testid="playback-duration"]'),
        appareil: document.querySelector('[data-testid="control-button-connect-picker"]')?.getAttribute("aria-label") || null,
        medias: [...document.querySelectorAll("audio,video")].map((media) => ({
          tag: media.tagName,
          paused: media.paused,
          ended: media.ended,
          currentTime: media.currentTime,
          muted: media.muted,
          volume: media.volume,
          readyState: media.readyState,
          source: origine(media.currentSrc)
        })),
        iframes: [...document.querySelectorAll("iframe")].map((frame) => origine(frame.getAttribute("src")))
      };
    }
  });
  return results[0]?.result ?? null;
}

async function probeAllFrames(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      const origine = (value) => {
        try { return value ? new URL(value, location.href).origin : null; } catch { return null; }
      };
      return {
        origine: origine(location.href),
        estPrincipal: window.top === window,
        // Spotify joue depuis une iframe : c'est le seul endroit où l'on peut voir
        // l'élément média, son état de chargement et son éventuelle erreur.
        medias: [...document.querySelectorAll("audio,video")].map((media) => ({
          tag: media.tagName,
          paused: media.paused,
          ended: media.ended,
          currentTime: media.currentTime,
          muted: media.muted,
          volume: media.volume,
          readyState: media.readyState,
          networkState: media.networkState,
          erreur: media.error ? { code: media.error.code, message: media.error.message } : null,
          source: origine(media.currentSrc)
        }))
      };
    }
  });
  return results.map((result) => ({ frameId: result.frameId, ...(result.result || {}) }));
}

// Le diagnostic est copié par l'utilisateur pour un signalement : il se limite
// à ce qui sert au dépannage. Aucune donnée de compte ni aucun audio ; les
// adresses des cadres et médias sont réduites à leur origine.
// Dernière session de capture, pour le diagnostic : les coupes décidées par le
// document hors écran et les MP3 qui en résultent. Jamais bloquant.
const MONITOR_JOURNAL_FILES = 30;
async function recordMonitorJournal(message, file = null) {
  if (!Array.isArray(message.journal)) return;
  try {
    const { monitorJournal } = await chrome.storage.local.get("monitorJournal");
    const previousFiles = monitorJournal?.sessionId === message.sessionId ? monitorJournal.files ?? [] : [];
    await chrome.storage.local.set({ monitorJournal: {
      sessionId: message.sessionId, events: message.journal,
      files: [...previousFiles, ...(file ? [file] : [])].slice(-MONITOR_JOURNAL_FILES)
    } });
  } catch (error) {
    console.warn("Journal de surveillance non enregistré", error);
  }
}

function formatMonitorJournal(journal) {
  if (!journal) return null;
  const time = (atMs) => new Date(atMs).toLocaleTimeString("fr-FR", { hour12: false }) +
    `.${String(Math.floor(atMs % 1000)).padStart(3, "0")}`;
  return {
    fichiers: journal.files,
    evenements: (journal.events ?? []).map(({ atMs, ...event }) => ({ heure: time(atMs), ...event }))
  };
}

async function collectDiagnostics() {
  const manifest = chrome.runtime.getManifest();
  const diagnostics = {
    horodatage: new Date().toISOString(),
    extension: {
      nom: manifest.name,
      version: manifest.version,
      minimumChrome: manifest.minimum_chrome_version
    },
    navigateur: {
      chrome: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? "inconnu",
      plateforme: navigator.userAgentData?.platform ?? null
    },
    etat: recorderState,
    erreurs: []
  };
  const collecte = async (cle, action) => {
    try {
      diagnostics[cle] = await action();
    } catch (error) {
      diagnostics[cle] = null;
      diagnostics.erreurs.push(`${cle} : ${error.message}`);
    }
  };

  await collecte("stockage", async () => {
    const saved = await chrome.storage.local.get(["bitrate", "playerObservation", "lastTrackUrl"]);
    return {
      bitrate: saved.bitrate ?? null,
      playerObservation: saved.playerObservation ?? null,
      urlDeMorceauMemorisee: Boolean(saved.lastTrackUrl)
    };
  });
  await collecte("journalSurveillance", async () =>
    formatMonitorJournal((await chrome.storage.local.get("monitorJournal")).monitorJournal));
  await collecte("session", async () => ({
    capturePermissionTabId: (await chrome.storage.session.get("capturePermissionTabId")).capturePermissionTabId ?? null
  }));
  await collecte("capturesActives", () => chrome.tabCapture.getCapturedTabs());
  await collecte("horsEcran", async () => {
    if (!await ensureOffscreenDocument(false)) return "(aucun document hors écran)";
    return chrome.runtime.sendMessage({ type: "OFFSCREEN_GET_STATUS", target: "offscreen" });
  });
  await collecte("onglet", async () => {
    const tab = recorderState.tabId
      ? await chrome.tabs.get(recorderState.tabId)
      : await getSpotifyTab();
    return {
      id: tab.id,
      chemin: tab.url ? new URL(tab.url).pathname : null,
      titre: tab.title,
      statut: tab.status,
      actif: tab.active,
      audible: tab.audible,
      muet: tab.mutedInfo,
      fenetre: tab.windowId
    };
  });
  await collecte("page", async () => (
    diagnostics.onglet?.id ? probeSpotifyPage(diagnostics.onglet.id) : "(aucun onglet Spotify)"
  ));
  await collecte("lancement", async () => (
    dernierLancement
      ?? (await chrome.storage.session.get("dernierLancement")).dernierLancement
      ?? "(aucun lancement de morceau enregistré)"
  ));
  diagnostics.workerRedemarreDepuisLancement = !dernierLancement;
  await collecte("cadres", async () => (
    diagnostics.onglet?.id ? probeAllFrames(diagnostics.onglet.id) : "(aucun onglet Spotify)"
  ));

  return diagnostics;
}

function validBitrate(value) {
  return [128, 192, 256, 320].includes(Number(value)) ? Number(value) : 192;
}

function isPermissionError(error) {
  return /Extension has not been invoked/i.test(error?.message || "");
}

async function cancelArmedCapture() {
  if (!await ensureOffscreenDocument(false)) return;
  const response = await chrome.runtime.sendMessage({
    type: "OFFSCREEN_CANCEL_CAPTURE",
    target: "offscreen"
  });
  if (!response?.ok) throw new Error(response?.error || "Impossible de libérer la capture précédente.");
}

async function armCapture(tabId, bitrate, sessionId) {
  await cancelArmedCapture();
  // Fermer aussi les flux issus d'une initialisation ancienne restée incomplète,
  // sauf si le document garde un MP3 que Chrome n'a pas fini d'enregistrer :
  // sa fermeture le rendrait illisible.
  if (await ensureOffscreenDocument(false)) {
    const status = await getOffscreenStatus();
    if (!status?.pendingDownloads) await chrome.offscreen.closeDocument();
  }
  const deadline = Date.now() + 3000;
  while ((await chrome.tabCapture.getCapturedTabs()).some(
    (tab) => tab.tabId === tabId && ["pending", "active"].includes(tab.status)
  )) {
    if (Date.now() >= deadline) {
      throw new Error("La capture précédente reste active. Fermez cet onglet Spotify, puis relancez l'enregistrement.");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await ensureOffscreenDocument();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const response = await chrome.runtime.sendMessage({
    type: "OFFSCREEN_START_CAPTURE",
    target: "offscreen",
    streamId,
    tabId,
    bitrate,
    sessionId
  });
  if (!response?.ok) {
    throw new Error(response?.error || "Chrome n'a pas pu armer la capture audio.");
  }
}

// Une seule ouverture de session à la fois : deux clics rapprochés, ou un clic
// sur l'icône pendant un démarrage, partagent la même capture.
let sessionStartPromise = null;
function startSession(start) {
  if (!sessionStartPromise) {
    sessionStartPromise = start().finally(() => {
      sessionStartPromise = null;
    });
  }
  return sessionStartPromise;
}

function resumeCapturePermission(tab) {
  return startSession(() => resumeCapturePermissionOnce(tab));
}

async function resumeCapturePermissionOnce(clickedTab) {
  if (recorderState.phase !== "capture_permission" || recorderState.tabId !== clickedTab.id) return recorderState;
  // Utiliser exclusivement l'onglet qui vient de recevoir l'autorisation.
  const tab = await chrome.tabs.get(clickedTab.id);
  if (!tab.url?.startsWith("https://open.spotify.com/")) {
    throw new Error("L'onglet autorisé n'affiche plus Spotify. Relancez l'enregistrement depuis le panneau.");
  }
  if (recorderState.mode === "monitor") return startMonitoringOnce({ bitrate: recorderState.bitrate }, tab);
  // Une autorisation en attente d'une version précédente ne connaît pas le morceau.
  if (!recorderState.track?.url) throw new Error("Relancez l'enregistrement du morceau depuis le panneau Spytify.");
  return beginSingleTrack(tab, recorderState.track, recorderState.bitrate, true);
}

// Mode « Un morceau » : la page du morceau est chargée pendant que la capture
// surveille déjà l'onglet. Si Spotify lance le morceau de lui-même, rien n'est
// cliqué ; sinon l'extension le lance. Seul ce morceau est téléchargé.
function startSingleTrack(options = {}) {
  return startSession(() => startSingleTrackOnce(options));
}

async function startSingleTrackOnce(options = {}) {
  if (recorderState.monitoring || recorderState.phase === "monitor_stopping") {
    throw new Error(recorderState.mode === "monitor"
      ? "Arrêtez la surveillance avant d'enregistrer un morceau."
      : "Un enregistrement est déjà en cours.");
  }
  const rawUrl = String(options.url ?? "").trim();
  const bitrate = validBitrate(options.bitrate);
  let tab;
  let track;
  if (rawUrl) {
    track = parseSpotifyTrackUrl(rawUrl);
    await chrome.storage.local.set({ lastTrackUrl: rawUrl });
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    // Sans onglet Spotify affiché, le morceau s'ouvre dans un nouvel onglet :
    // Chrome demandera un clic sur l'icône Spytify pour autoriser sa capture.
    tab = active?.url?.startsWith("https://open.spotify.com/")
      ? active
      : await chrome.tabs.create({ url: track.url, active: true });
  } else {
    tab = await getSpotifyTab();
    try {
      track = parseSpotifyTrackUrl(tab.url);
    } catch {
      throw new Error("Collez l'URL d'un morceau Spotify, ou affichez la page du morceau dans Spotify.");
    }
  }
  return beginSingleTrack(tab, track, bitrate, false);
}

async function beginSingleTrack(tab, track, bitrate, permissionActionReceived) {
  const monitorSessionId = crypto.randomUUID();
  try {
    // La capture est armée avant le chargement : un morceau que Spotify lance
    // de lui-même dès l'ouverture de sa page est enregistré depuis son début.
    await armCapture(tab.id, bitrate, monitorSessionId);
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    await setState({
      mode: "single", phase: "capture_permission", monitoring: false, recording: false, advertisement: false,
      elapsedSeconds: 0, metadata: null, target: null, playbackStarted: false, tabId: tab.id, bitrate, track,
      capturedTracks: 0, lastMonitoredFilename: null, permissionError: error.message, permissionActionReceived,
      message: permissionActionReceived
        ? `Le clic sur l'icône a bien été reçu, mais Chrome refuse encore la capture (Spytify ${chrome.runtime.getManifest().version}). Fermez cette petite fenêtre et relancez l'enregistrement depuis le panneau. Détail Chrome : ${error.message}`
        : "Cliquez sur l'icône Spytify dans la barre d'outils Chrome : une fenêtre « Autorisation Spytify » doit apparaître et lancer l'enregistrement. Gardez l'onglet Spotify affiché."
    });
    return recorderState;
  }
  singleTrackProgress = null;
  consecutiveTrackChanges = 0;
  await setState({
    mode: "single", phase: "monitoring", monitoring: true, recording: false, advertisement: false,
    elapsedSeconds: 0, metadata: null, target: null, playbackStarted: false, singleAborted: null, singleSaveAs: false,
    tabId: tab.id, bitrate, track, capturedTracks: 0, lastMonitoredFilename: null, monitorSessionId,
    permissionError: null, permissionActionReceived, monitorExportError: null,
    message: "Chargement du morceau dans Spotify…"
  });
  void superviseSingleTrack(tab.id, track, monitorSessionId).catch(console.error);
  return recorderState;
}

// Étapes du dernier lancement, pour le diagnostic. Le worker MV3 peut être
// arrêté : la trace est conservée en session à chaque étape.
let dernierLancement = null;
async function startLaunchTrace() {
  const debut = Date.now();
  const lancement = { horodatage: new Date().toISOString(), etapes: [], termine: false };
  dernierLancement = lancement;
  const save = () => chrome.storage.session.set({ dernierLancement: lancement }).catch(() => {});
  await save();
  const trace = async (nom, detail = null) => {
    lancement.etapes.push({ nom, ms: Date.now() - debut, detail });
    await save();
  };
  trace.end = async () => {
    lancement.termine = true;
    lancement.dureeMs = Date.now() - debut;
    await save();
  };
  return trace;
}

async function superviseSingleTrack(tabId, track, sessionId, { reload = true } = {}) {
  const active = () => recorderState.monitoring && recorderState.monitorSessionId === sessionId &&
    recorderState.phase === "monitoring";
  const trace = await startLaunchTrace();
  try {
    if (reload) {
      await loadTrackPage(tabId, track.url);
      await trace("pageChargee");
    }
    if (!active()) return;
    const metadata = recorderState.target ?? await waitForTrackPage(tabId);
    await trace("morceauAffiche", metadata?.title ?? null);
    if (!metadata?.title) {
      throw new Error("Spotify n'a pas affiché ce morceau. Vérifiez l'URL puis relancez l'enregistrement.");
    }
    if (!active()) return;
    if (!recorderState.target) {
      await setState({ target: metadata, metadata, message: "Morceau chargé : attente du démarrage de la lecture…" });
    }

    // Spotify lance parfois le morceau de lui-même après le chargement : le
    // laisser faire, un clic à ce moment le mettrait en pause.
    let playing = await watchPlayback(tabId, metadata.title, SPONTANEOUS_START_MILLISECONDS);
    await trace("demarrageSpontane", playing);
    let launches = 0;
    while (!playing && launches < LAUNCH_ATTEMPTS && active()) {
      launches += 1;
      await setState({ message: "Spotify n'a pas lancé le morceau : lancement automatique…" });
      await trace("lancement", await launchTrack(tabId, metadata.title));
      playing = await watchPlayback(tabId, metadata.title, LAUNCH_CONFIRMATION_MILLISECONDS);
      await trace("lectureConfirmee", playing);
    }
    if (!active()) return;
    if (!playing) {
      const observed = await getSpotifyPlaybackState(tabId).catch(() => null);
      throw new Error(`La lecture n'a pas pu être lancée. Attendu : « ${metadata.title} » — lecteur : « ${observed?.title || "(titre vide)"} » — en lecture : ${observed?.isPlaying ? "oui" : "non"} — appareil : « ${observed?.device || "(aucun)"} ».`);
    }
    singleTrackProgress = null;
    consecutiveTrackChanges = 0;
    await chrome.storage.local.remove("lastTrackUrl");
    await setState({
      playbackStarted: true,
      message: launches
        ? "Lecture lancée automatiquement : enregistrement du morceau en cours."
        : "Spotify a lancé le morceau : enregistrement en cours."
    });
  } catch (error) {
    await trace("echec", error.message);
    if (active()) await abortSingleTrack(error.message);
  } finally {
    await trace.end();
  }
}

async function readPlayerState(tabId) {
  const response = await chrome.tabs.sendMessage(tabId, { type: "GET_PLAYER_SNAPSHOT" });
  const snapshot = response?.snapshot;
  return snapshot
    ? {
        title: snapshot.metadata?.title || "",
        isPlaying: Boolean(snapshot.isPlaying),
        positionSeconds: snapshot.positionSeconds,
        advertisement: Boolean(snapshot.isAdvertisement)
      }
    : null;
}

// La lecture ne compte comme démarrée que si le morceau attendu progresse, ou
// si une publicité le précède.
function watchPlayback(tabId, title, timeoutMilliseconds) {
  return waitForConfirmedPlayback(() => readPlayerState(tabId), title, { timeoutMilliseconds });
}

async function launchTrack(tabId, title) {
  // Spotify peut restaurer ce morceau en pause au milieu : le ramener au début
  // pour enregistrer le morceau entier.
  const player = await getSpotifyPlaybackState(tabId).catch(() => null);
  const rewind = player && !player.isPlaying && player.positionSeconds > 0 &&
    normalizeTitle(player.title) === normalizeTitle(title)
    ? await rewindTrackPlayback(tabId, title)
    : null;
  return { rewind, ...(await startTrackPlayback(tabId, title)) };
}

// Un lancement impossible abandonne la session sans télécharger d'extrait.
async function abortSingleTrack(message) {
  await setState({ singleAborted: message });
  try {
    await stopMonitoring("aborted");
  } catch (error) {
    await setState({ phase: "monitoring", message: `${message} L'arrêt de la capture a échoué : ${error.message}` });
  }
}

// Mode « Un morceau » : seul le premier enregistrement du titre demandé est
// gardé. Un extrait n'est accepté qu'à l'arrêt de la session ; en cours de
// route, c'est un reste du titre affiché avant le chargement ou d'un saut.
function acceptSingleTrackSegment(metadata) {
  const target = recorderState.target;
  return !recorderState.singleAborted && !recorderState.capturedTracks && Boolean(target?.title) &&
    normalizeTitle(metadata?.title) === normalizeTitle(target.title) &&
    (!metadata?.partial || recorderState.phase === "monitor_stopping");
}

async function getOffscreenStatus() {
  try {
    if (!await ensureOffscreenDocument(false)) return null;
    const status = await chrome.runtime.sendMessage({ type: "OFFSCREEN_GET_STATUS", target: "offscreen" });
    return status?.ok ? status : null;
  } catch {
    return null;
  }
}

// Une commande audio refusée ne prouve pas que la capture s'est arrêtée :
// l'état affiché suit le document hors écran. Une capture que plus rien ne
// suit est finalisée au lieu de rester active en arrière-plan.
async function handleAudioError(error) {
  const status = await getOffscreenStatus();
  if (status?.active) {
    if (recorderState.monitoring && status.sessionId === recorderState.monitorSessionId) {
      await setState({ message: `Erreur audio : ${error}` });
      return;
    }
    await chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP_MONITORING", target: "offscreen", reason: "orphaned" })
      .catch(() => {});
  }
  await setState({
    phase: "error",
    monitoring: false,
    recording: false,
    advertisement: false,
    playbackStarted: false,
    tabId: null,
    message: error
  });
}

const DOWNLOAD_WAIT_MILLISECONDS = 20_000;

function fallbackRecordingFilename() {
  return `Spytify Web/Enregistrement Spotify ${new Date().toISOString().replace(/[:.]/g, "-")}.mp3`;
}

// Attend la fin réelle d'un téléchargement : download() se résout dès sa
// création, avant qu'une erreur d'écriture (disque plein, nom trop long…)
// puisse survenir. Un téléchargement encore en cours après le délai est
// considéré comme accepté, pour ne jamais créer de doublon.
function waitForDownload(downloadId) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(outcome);
    };
    const settle = (state, error) => {
      if (state === "complete") finish({ state });
      else if (state === "interrupted") finish({ state, error: error || "INTERRUPTED" });
    };
    const onChanged = (delta) => {
      if (delta.id === downloadId) settle(delta.state?.current, delta.error?.current);
    };
    const timer = setTimeout(() => finish({ state: "in_progress" }), DOWNLOAD_WAIT_MILLISECONDS);
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id: downloadId })
      .then(([item]) => settle(item?.state, item?.error))
      .catch(() => {});
  });
}

// Seuls les MP3 produits par le document hors écran de l'extension sont
// téléchargés, sous un nom recalculé ici à partir des métadonnées. Un échec ne
// perd pas le fichier : un nom de secours est essayé, puis Chrome demande où
// l'enregistrer. Le document hors écran conserve le MP3 pendant ces essais.
async function downloadAudio(url, metadata) {
  if (typeof url !== "string" || !url.startsWith(`blob:${chrome.runtime.getURL("")}`)) {
    throw new Error("Téléchargement refusé : le MP3 ne provient pas de Spytify.");
  }
  const filename = recordingFilename(metadata);
  const attempts = [
    { filename, saveAs: false },
    { filename: fallbackRecordingFilename(), saveAs: false },
    { filename, saveAs: true }
  ];
  const failures = [];
  for (const attempt of attempts) {
    try {
      const downloadId = await chrome.downloads.download({ url, conflictAction: "uniquify", ...attempt });
      // La fenêtre d'enregistrement peut rester ouverte longtemps : ne pas
      // l'attendre, le MP3 reste disponible hors écran pendant ce choix.
      if (attempt.saveAs) return { downloadId, filename: attempt.filename, saveAs: true, completed: false };
      const outcome = await waitForDownload(downloadId);
      if (outcome.state !== "interrupted") {
        return { downloadId, filename: attempt.filename, saveAs: false, completed: outcome.state === "complete" };
      }
      failures.push(outcome.error);
      if (outcome.error === "USER_CANCELED") break;
    } catch (error) {
      failures.push(error.message);
    }
  }
  throw new Error(`Le MP3 n'a pas pu être enregistré (${failures.join(" ; ")}).`);
}

// Chaque message n'est accepté que de son émetteur légitime. Un script de
// contenu tourne dans le processus de Spotify : il ne peut que signaler l'état
// du lecteur, jamais commander une capture ni un téléchargement.
const MESSAGE_SOURCES = {
  GET_STATE: "panel",
  COLLECT_DIAGNOSTICS: "panel",
  START_SINGLE_TRACK: "panel",
  START_MONITORING: "panel",
  STOP_MONITORING: "panel",
  AUTHORIZE_CAPTURE: "authorize",
  MONITOR_STATE: "offscreen",
  MONITOR_TRACK_READY: "offscreen",
  MONITOR_EXPORT_ERROR: "offscreen",
  MONITOR_STOPPED: "offscreen",
  AUDIO_ERROR: "offscreen",
  PLAYER_SNAPSHOT: "spotify",
  PLAYER_ENDED: "spotify"
};
const EXTENSION_PAGES = {
  "popup.html": "panel",
  "authorize.html": "authorize",
  "offscreen.html": "offscreen"
};

function messageSource(sender) {
  const url = String(sender?.url || "");
  const extensionOrigin = chrome.runtime.getURL("");
  if (url.startsWith(extensionOrigin)) {
    return EXTENSION_PAGES[url.slice(extensionOrigin.length).split(/[?#]/)[0]] ?? null;
  }
  return Number.isInteger(sender?.tab?.id) && url.startsWith("https://open.spotify.com/") ? "spotify" : null;
}

// Un arrêt automatique refusé laisse le bouton d'arrêt disponible.
async function endSingleTrack(reason) {
  try {
    await stopMonitoring(reason);
  } catch (error) {
    if (recorderState.monitoring) {
      await setState({ phase: "monitoring", message: `L'arrêt automatique a échoué : ${error.message}` });
    }
  }
}

// Fin du morceau demandé, lue dans le lecteur pendant l'enregistrement
// individuel. L'arrêt finalise le MP3 du morceau ; tout autre titre est écarté.
async function handleSnapshot(message, sender) {
  if (
    !recorderState.monitoring ||
    recorderState.mode !== "single" ||
    recorderState.phase !== "monitoring" ||
    !recorderState.playbackStarted ||
    sender.tab?.id !== recorderState.tabId
  ) {
    return;
  }
  const snapshot = message.snapshot;
  // Une publicité suspend l'enregistrement sans terminer le morceau.
  if (!snapshot || snapshot.isAdvertisement) return;

  const title = snapshot.metadata?.title || "";
  const sameTrack = !title || normalizeTitle(title) === normalizeTitle(recorderState.target?.title);
  const position = Number(snapshot.positionSeconds || 0);
  const duration = Number(snapshot.durationSeconds || 0);
  // Spotify ne s'arrête pas sur la dernière seconde : à la fin d'un morceau, il
  // revient aussitôt à 0:00 en pause (ou le relance en mode répétition). La
  // fin se lit donc aussi dans le minutage : une position revenue en arrière
  // après avoir atteint les dernières secondes du morceau.
  singleTrackProgress ??= { maxPositionSeconds: 0, durationSeconds: 0 };
  if (sameTrack && duration > 0) singleTrackProgress.durationSeconds = duration;
  const knownDuration = singleTrackProgress.durationSeconds;
  const reachedLastSeconds = knownDuration > 0 &&
    singleTrackProgress.maxPositionSeconds >= knownDuration - TRACK_END_TOLERANCE_SECONDS;
  const wrappedAfterEnd = reachedLastSeconds && sameTrack &&
    position < singleTrackProgress.maxPositionSeconds - TRACK_END_TOLERANCE_SECONDS;
  if (sameTrack) {
    singleTrackProgress.maxPositionSeconds = Math.max(singleTrackProgress.maxPositionSeconds, position);
  }
  const played = singleTrackProgress.maxPositionSeconds >= 2;
  const reachedEnd = wrappedAfterEnd ||
    (sameTrack && played && (message.type === "PLAYER_ENDED" || Boolean(snapshot.ended)));

  // Le morceau suivant démarre juste après la fin : arrêter aussitôt.
  if (reachedEnd || (reachedLastSeconds && !sameTrack)) {
    await endSingleTrack("track_ended");
    return;
  }
  // En cours de morceau, un titre transitoire reste ignoré : le passage à un
  // autre morceau doit être confirmé par une seconde observation.
  if (!sameTrack && played) {
    consecutiveTrackChanges += 1;
    if (consecutiveTrackChanges >= 2) await endSingleTrack("track_changed");
  } else {
    consecutiveTrackChanges = 0;
  }
}

function startMonitoring(options = {}) {
  return startSession(() => startMonitoringOnce(options));
}

async function startMonitoringOnce(options = {}, authorizedTab = null) {
  if (recorderState.monitoring) {
    if (recorderState.mode === "monitor") return recorderState;
    throw new Error("Arrêtez l'enregistrement du morceau avant d'activer la surveillance.");
  }
  if (recorderState.phase === "monitor_stopping") throw new Error("Attendez la fin de l'enregistrement en cours.");
  const tab = authorizedTab ? await chrome.tabs.get(authorizedTab.id) : await getSpotifyTab();
  if (!tab.url?.startsWith("https://open.spotify.com/")) throw new Error("Affichez Spotify Web pour activer la surveillance.");
  await ensureContentScript(tab.id);
  const bitrate = validBitrate(options.bitrate);
  const monitorSessionId = crypto.randomUUID();
  try {
    await armCapture(tab.id, bitrate, monitorSessionId);
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    await setState({ mode: "monitor", phase: "capture_permission", monitoring: false, recording: false,
      elapsedSeconds: 0, metadata: null, track: null, target: null, playbackStarted: false,
      tabId: tab.id, bitrate, capturedTracks: 0, lastMonitoredFilename: null,
      permissionError: error.message, permissionActionReceived: Boolean(authorizedTab),
      message: "Gardez Spotify affiché et cliquez sur l'icône Spytify dans la barre d'outils Chrome pour autoriser la surveillance." });
    return recorderState;
  }
  await setState({ mode: "monitor", phase: "monitoring", monitoring: true, recording: false,
    advertisement: false, track: null, target: null, playbackStarted: false, singleAborted: null,
    elapsedSeconds: 0, metadata: null, tabId: tab.id, bitrate, capturedTracks: 0, lastMonitoredFilename: null, monitorSessionId,
    permissionError: null, permissionActionReceived: Boolean(authorizedTab), monitorExportError: null,
    message: "Surveillance active. Lancez un morceau ou une playlist dans Spotify." });
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "GET_PLAYER_SNAPSHOT" });
    if (response?.snapshot) await chrome.runtime.sendMessage({
      type: "OFFSCREEN_UPDATE_MONITOR", target: "offscreen", sessionId: monitorSessionId, snapshot: response.snapshot
    });
  } catch {
    // Le prochain état du content script reprend l'observation après navigation.
  }
  return recorderState;
}

let monitoringStopPromise = null;
function stopMonitoring(reason = "manual") {
  if (!monitoringStopPromise) {
    monitoringStopPromise = stopMonitoringOnce(reason).finally(() => { monitoringStopPromise = null; });
  }
  return monitoringStopPromise;
}

async function stopMonitoringOnce(reason) {
  if (!recorderState.monitoring) return recorderState;
  await setState({ phase: "monitor_stopping",
    message: recorderState.mode === "single" ? "Finalisation du MP3…" : "Finalisation du dernier morceau…" });
  try {
    const response = await chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP_MONITORING", target: "offscreen", reason });
    if (!response?.ok) throw new Error(response?.error || "Impossible d'arrêter l'enregistrement.");
  } catch (error) {
    if (!recorderState.monitoring) return recorderState;
    // L'état suit la capture réelle : disparue, la session est close ; encore
    // active, le bouton d'arrêt redevient disponible, jamais bloqué en finalisation.
    const status = await getOffscreenStatus();
    if (!status?.active || status.sessionId !== recorderState.monitorSessionId) {
      await finishMonitoringState(error.message);
      return recorderState;
    }
    await setState({ phase: "monitoring" });
    throw error;
  }
  // MONITOR_STOPPED peut déjà avoir enregistré la fin pendant cette demande.
  if (recorderState.monitoring) await finishMonitoringState();
  return recorderState;
}

function singleTrackOutcome(error) {
  if (recorderState.singleAborted) return recorderState.singleAborted;
  if (error) return `Enregistrement arrêté : ${error}`;
  if (!recorderState.capturedTracks) return "Aucun MP3 : le morceau n'a pas été capturé.";
  if (recorderState.singleSaveAs) return "Le téléchargement automatique a échoué : choisissez dans Chrome où enregistrer le MP3.";
  return `MP3 téléchargé : ${describeRecording(recorderState.lastMonitoredFilename, recorderState.lastMonitoredDurationSeconds)}`;
}

async function finishMonitoringState(error = null) {
  if (recorderState.mode === "single") {
    await setState({ phase: recorderState.singleAborted || error ? "error" : "done", monitoring: false,
      recording: false, advertisement: false, playbackStarted: false, tabId: null,
      metadata: recorderState.target, message: singleTrackOutcome(error) });
    return;
  }
  await setState({ phase: error ? "error" : "done", monitoring: false, recording: false, tabId: null,
    advertisement: false,
    elapsedSeconds: 0, metadata: null, message: error
      ? `Surveillance arrêtée : ${error}`
      : `Surveillance arrêtée. ${recorderState.capturedTracks || 0} MP3 téléchargé(s).` });
}

function singleTrackMonitorState(state) {
  // Seul le morceau demandé compte : le titre affiché avant le chargement de sa
  // page n'est pas enregistré.
  const onTarget = normalizeTitle(state.metadata?.title) === normalizeTitle(recorderState.target?.title) &&
    Boolean(recorderState.target?.title);
  const recording = Boolean(state.recording && onTarget);
  return {
    recording,
    advertisement: Boolean(state.advertisement),
    elapsedSeconds: onTarget ? state.elapsedSeconds : recorderState.elapsedSeconds,
    ...(recorderState.playbackStarted ? {
      message: state.advertisement ? "Publicité en cours : l'enregistrement reprendra avec le morceau."
        : recording ? "Enregistrement du morceau en cours."
        : "Morceau en pause : l'enregistrement reprendra avec la lecture."
    } : {})
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "offscreen") {
    return false;
  }
  if (!MESSAGE_SOURCES[message?.type] || MESSAGE_SOURCES[message.type] !== messageSource(sender)) {
    sendResponse({ ok: false, error: "Message refusé : émetteur non autorisé." });
    return false;
  }

  const run = async () => {
    await restorePromise;
    switch (message?.type) {
      case "GET_STATE":
        return { ok: true, state: recorderState };
      case "AUTHORIZE_CAPTURE": {
        if (recorderState.phase !== "capture_permission") return { ok: true, state: recorderState };
        const tab = await getSpotifyTab();
        if (tab.id !== recorderState.tabId) {
          throw new Error(recorderState.mode === "monitor"
            ? "Ce n'est pas l'onglet à surveiller. Affichez cet onglet Spotify puis cliquez sur l'icône Spytify."
            : "Ce n'est pas l'onglet du morceau. Affichez cet onglet Spotify puis cliquez sur l'icône Spytify.");
        }
        return { ok: true, state: await resumeCapturePermission(tab) };
      }
      case "COLLECT_DIAGNOSTICS":
        return { ok: true, diagnostics: await collectDiagnostics() };
      case "START_SINGLE_TRACK":
        return { ok: true, state: await startSingleTrack(message.options) };
      case "START_MONITORING":
        return { ok: true, state: await startMonitoring(message.options) };
      case "STOP_MONITORING":
        return { ok: true, state: await stopMonitoring() };
      case "MONITOR_STATE":
        if (recorderState.monitoring && recorderState.phase !== "monitor_stopping" && message.sessionId === recorderState.monitorSessionId) {
          await setState(recorderState.mode === "single" ? singleTrackMonitorState(message.state) : {
            phase: "monitoring", recording: Boolean(message.state.recording),
            advertisement: Boolean(message.state.advertisement),
            elapsedSeconds: message.state.elapsedSeconds, metadata: message.state.metadata,
            message: message.state.advertisement ? "Publicité ignorée. Reprise automatique au prochain morceau."
              : message.state.recording ? "Surveillance : enregistrement du morceau en cours."
              : "Surveillance active. En attente de lecture ou en pause." });
        }
        return { ok: true };
      case "MONITOR_TRACK_READY": {
        if (!recorderState.monitoring || message.sessionId !== recorderState.monitorSessionId) return { ok: false, error: "Session de surveillance expirée." };
        const single = recorderState.mode === "single";
        const accepted = !single || acceptSingleTrackSegment(message.metadata);
        await recordMonitorJournal(message, { filename: message.filename ?? null, reason: message.reason ?? null,
          capturedSeconds: message.durationSeconds ?? null, expectedSeconds: message.expectedDurationSeconds ?? null,
          partial: Boolean(message.metadata?.partial), discarded: !accepted });
        if (!accepted) {
          // Autre titre, extrait intermédiaire ou session abandonnée : le
          // document hors écran libère ce MP3 sans téléchargement.
          return { ok: true, completed: true, discarded: true };
        }
        // Utiliser les métadonnées du MP3 finalisé : Spotify peut déjà lire
        // le titre suivant lorsque le téléchargement du précédent commence.
        const { downloadId, filename, saveAs, completed } = await downloadAudio(message.url, message.metadata);
        await setState({ capturedTracks: (recorderState.capturedTracks || 0) + 1,
          lastMonitoredTrack: message.metadata, lastMonitoredFilename: filename,
          lastMonitoredDurationSeconds: Number.isFinite(message.durationSeconds) ? message.durationSeconds : null,
          ...(single ? { singleSaveAs: saveAs } : {}),
          ...(saveAs ? { message: "Un téléchargement automatique a échoué : choisissez dans Chrome où enregistrer ce MP3." } : {}) });
        // Le morceau demandé est enregistré : la session s'arrête. Ne pas attendre
        // cet arrêt ici, le document hors écran attend d'abord cette réponse.
        if (single && recorderState.phase === "monitoring") void endSingleTrack("track_ended");
        return { ok: true, downloadId, completed };
      }
      case "MONITOR_EXPORT_ERROR":
        if (recorderState.monitoring && message.sessionId === recorderState.monitorSessionId) {
          await setState({ monitorExportError: message.error, message: `Un MP3 n'a pas pu être téléchargé : ${message.error}` });
        }
        return { ok: true };
      case "MONITOR_STOPPED":
        await recordMonitorJournal(message);
        if (recorderState.monitoring && message.sessionId === recorderState.monitorSessionId) await finishMonitoringState(message.error);
        return { ok: true };
      case "AUDIO_ERROR":
        await handleAudioError(message.error || "Erreur pendant l'enregistrement");
        return { ok: true };
      case "PLAYER_SNAPSHOT":
      case "PLAYER_ENDED":
        await handleSnapshot(message, sender);
        return { ok: true };
      default:
        return { ok: false, error: "Message inconnu" };
    }
  };

  run()
    .then(sendResponse)
    .catch(async (error) => {
      if (["START_SINGLE_TRACK", "START_MONITORING", "STOP_MONITORING"].includes(message?.type) ||
          (message?.type === "AUTHORIZE_CAPTURE" && sender.url === chrome.runtime.getURL("authorize.html"))) {
        await setState(recorderState.monitoring ? {
          phase: "monitoring",
          message: error.message
        } : {
          phase: "error",
          recording: false,
          tabId: null,
          message: error.message
        });
      }
      sendResponse({ ok: false, error: error.message });
    });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (recorderState.monitoring && recorderState.tabId === tabId) {
    void stopMonitoring().catch(console.error);
  }
});
