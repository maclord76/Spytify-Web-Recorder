import {
  metadataSignature,
  parseSpotifyTrackUrl
} from "./core.js";
import { startPreparedPlayerPlayback } from "./player-control.js";
import { waitForConfirmedPlayback } from "./playback-verification.js";

const OFFSCREEN_URL = "offscreen.html";

// Le panneau global reste accessible lors des changements d'onglet.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error);

chrome.action.onClicked.addListener((tab) => {
  // Le clic sur l'icône autorise tabCapture pour cet onglet. Un clic dans
  // le panneau seul ne donne pas cette autorisation après l'étape 1.
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
  recording: false,
  elapsedSeconds: 0,
  metadata: null,
  tabId: null,
  message: "Prêt"
};

let recorderState = { ...DEFAULT_STATE };
let consecutiveTrackChanges = 0;
let restoreComplete = false;

const restorePromise = restoreState().then(() => chrome.action.setPopup({
  popup: recorderState.phase === "capture_permission" ? "authorize.html" : ""
})).finally(() => {
  restoreComplete = true;
});

async function restoreState() {
  const saved = await chrome.storage.local.get(["recorderState"]);
  if (saved.recorderState?.recording) {
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

    recorderState = audioStatus?.active
      ? {
          ...DEFAULT_STATE,
          ...saved.recorderState,
          phase: "recording",
          recording: true,
          elapsedSeconds: audioStatus.elapsedSeconds,
          message: saved.recorderState.message || "Enregistrement en cours"
        }
      : {
          ...saved.recorderState,
          phase: "idle",
          recording: false,
          elapsedSeconds: 0,
          tabId: null,
          message: "L'enregistrement précédent a été interrompu"
        };
    await persistState();
  } else if (saved.recorderState) {
    recorderState = { ...DEFAULT_STATE, ...saved.recorderState };
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
          message: "La session Chrome a changé. Affichez Spotify et cliquez sur « 2. Préparer le morceau »."
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
  await chrome.storage.local.set({ recorderState });
  await chrome.action.setBadgeText({ text: recorderState.recording ? "REC" : "" });
  if (recorderState.recording) {
    await chrome.action.setBadgeBackgroundColor({ color: "#E91429" });
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

async function getPageMediaMetadata(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "WAIT_PAGE_TRACK_READY",
      timeoutMilliseconds: 8000
    });
    if (response?.ready && response.metadata?.title) {
      return response.metadata;
    }
    if (response?.ok) return null;
  } catch {
    // Le lecteur peut encore être en cours de chargement.
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const value = navigator.mediaSession?.metadata;
        if (!value) return null;
        return {
          title: value.title || "",
          artist: value.artist || "",
          album: value.album || "",
          artworkUrl: value.artwork?.at(-1)?.src || ""
        };
      }
    });
    if (results[0]?.result?.title) {
      return results[0].result;
    }
  } catch {
    // Le lecteur peut être en cours de chargement; le script de contenu prend le relais.
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "GET_PLAYER_SNAPSHOT" });
    return response?.snapshot?.metadata || null;
  } catch {
    return null;
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  }
}

async function reloadSpotifyTab(tabId, timeoutMilliseconds = 20000) {
  await chrome.tabs.reload(tabId);
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Spotify n'a pas terminé son actualisation. Réessayez dans un instant.");
}

function normalizeTrackTitle(value) {
  return String(value || "").normalize("NFC").trim().toLocaleLowerCase("fr");
}

function parsePlayerTime(value) {
  const parts = String(value || "").trim().split(":").map(Number);
  if (!parts.length || parts.some(Number.isNaN)) return 0;
  return parts.reduce((seconds, part) => seconds * 60 + part, 0);
}

async function getSpotifyPlaybackState(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const titleSelectors = [
        '[data-testid="context-item-info-title"] a',
        '[data-testid="now-playing-widget"] [data-testid="context-item-link"]',
        '[data-testid="context-item-link"]'
      ];
      let title = "";
      for (const selector of titleSelectors) {
        title = document.querySelector(selector)?.textContent?.trim() || "";
        if (title) break;
      }
      const bottomButton = document.querySelector('[data-testid="control-button-playpause"]');
      return {
        title,
        label: bottomButton?.getAttribute("aria-label") || "",
        position: document.querySelector('[data-testid="playback-position"]')?.textContent?.trim() || "",
        duration: document.querySelector('[data-testid="playback-duration"]')?.textContent?.trim() || ""
      };
    }
  });
  const state = results[0]?.result;
  return state
    ? {
        ...state,
        isPlaying: /pause|mettre en pause/i.test(state.label),
        positionSeconds: parsePlayerTime(state.position),
        durationSeconds: parsePlayerTime(state.duration)
      }
    : null;
}

async function verifyPagePlayback(tabId, expectedTitle) {
  return waitForConfirmedPlayback(
    () => getSpotifyPlaybackState(tabId),
    expectedTitle,
    { timeoutMilliseconds: 8000 }
  );
}

async function cancelArmedCapture() {
  if (!await ensureOffscreenDocument(false)) return;
  const response = await chrome.runtime.sendMessage({
    type: "OFFSCREEN_CANCEL_CAPTURE",
    target: "offscreen"
  });
  if (!response?.ok) throw new Error(response?.error || "Impossible de libérer la capture précédente.");
}

async function armCapture(tabId, metadata, bitrate, durationSeconds = 0) {
  await cancelArmedCapture();
  // Fermer aussi les flux issus d'une initialisation ancienne restée incomplète.
  if (await ensureOffscreenDocument(false)) await chrome.offscreen.closeDocument();
  const deadline = Date.now() + 3000;
  while ((await chrome.tabCapture.getCapturedTabs()).some(
    (tab) => tab.tabId === tabId && ["pending", "active"].includes(tab.status)
  )) {
    if (Date.now() >= deadline) {
      throw new Error("La capture précédente reste active. Fermez cet onglet Spotify, puis rouvrez le morceau avec l'étape 1.");
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
    durationSeconds,
    metadata,
    armed: true
  });
  if (!response?.ok) {
    throw new Error(response?.error || "Chrome n'a pas pu armer la capture audio.");
  }
}

let preparationPromise = null;
function prepareCurrentTrack(options = {}) {
  if (!preparationPromise) {
    preparationPromise = prepareCurrentTrackOnce(options).finally(() => {
      preparationPromise = null;
    });
  }
  return preparationPromise;
}

async function prepareCurrentTrackOnce(options = {}) {
  if (recorderState.recording) {
    throw new Error("Un enregistrement est déjà en cours.");
  }
  const tab = await getSpotifyTab();
  await cancelArmedCapture();
  await reloadSpotifyTab(tab.id);
  await ensureContentScript(tab.id);
  const pageMetadata = await getPageMediaMetadata(tab.id);
  if (!metadataSignature(pageMetadata)) {
    throw new Error("Le morceau n'est pas encore prêt dans Spotify. Réessayez dans un instant.");
  }
  const response = await chrome.tabs.sendMessage(tab.id, { type: "PREPARE_TRACK" });
  const playerState = await getSpotifyPlaybackState(tab.id);
  const prepared = Boolean(response?.prepared) &&
    normalizeTrackTitle(playerState?.title) === normalizeTrackTitle(pageMetadata.title) &&
    !playerState?.isPlaying;
  if (!prepared) {
    throw new Error("Spotify n'a pas chargé ce morceau dans le lecteur. Réessayez de le préparer.");
  }
  const bitrate = [128, 192, 256, 320].includes(Number(options.bitrate))
    ? Number(options.bitrate)
    : 192;
  return finishPreparation(tab.id, pageMetadata, bitrate, playerState?.durationSeconds || 0);
}

function resumeCapturePermission(tab) {
  if (preparationPromise) return preparationPromise;
  preparationPromise = resumeCapturePermissionOnce(tab).finally(() => {
    preparationPromise = null;
  });
  return preparationPromise;
}

async function resumeCapturePermissionOnce(clickedTab) {
  if (recorderState.phase !== "capture_permission" || recorderState.tabId !== clickedTab.id) return;
  const expectedMetadata = recorderState.metadata;
  const bitrate = recorderState.bitrate;
  // Utiliser exclusivement l'onglet qui vient de recevoir l'autorisation.
  // Une reprise ne doit ni actualiser Spotify, ni sélectionner un autre onglet.
  const tab = await chrome.tabs.get(clickedTab.id);
  if (!tab.url?.startsWith("https://open.spotify.com/")) {
    throw new Error("L'onglet autorisé n'affiche plus Spotify. Rouvrez le morceau avec l'étape 1.");
  }
  await ensureContentScript(tab.id);
  const pageMetadata = await getPageMediaMetadata(tab.id);
  const playerState = await getSpotifyPlaybackState(tab.id);
  if (
    !metadataSignature(expectedMetadata) ||
    metadataSignature(pageMetadata) !== metadataSignature(expectedMetadata) ||
    normalizeTrackTitle(playerState?.title) !== normalizeTrackTitle(expectedMetadata.title) ||
    playerState?.isPlaying
  ) {
    throw new Error("Le lecteur Spotify a changé. Cliquez de nouveau sur « 2. Préparer le morceau ».");
  }
  // Un autre morceau a pu être ouvert depuis le panneau pendant la vérification.
  if (recorderState.phase !== "capture_permission" || recorderState.tabId !== tab.id) return;
  return finishPreparation(tab.id, pageMetadata, bitrate, playerState.durationSeconds, true);
}

async function finishPreparation(tabId, pageMetadata, bitrate, durationSeconds, permissionActionReceived = false) {
  try {
    await armCapture(tabId, pageMetadata, bitrate, durationSeconds);
  } catch (error) {
    if (!/Extension has not been invoked/i.test(error.message || "")) throw error;
    await setState({
      phase: "capture_permission",
      recording: false,
      elapsedSeconds: 0,
      metadata: pageMetadata,
      tabId,
      bitrate,
      permissionError: error.message,
      permissionActionReceived,
      message: permissionActionReceived
        ? `Le clic sur l'icône a bien été reçu, mais Chrome refuse encore la capture (Spytify ${chrome.runtime.getManifest().version}). Fermez cette petite fenêtre et recommencez l'étape 2 dans le panneau. Détail Chrome : ${error.message}`
        : "Cliquez sur l'icône Spytify dans la barre d'outils Chrome : une fenêtre « Autorisation Spytify » doit apparaître et reprendre la préparation. Gardez le morceau Spotify affiché."
    });
    return recorderState;
  }
  await setState({
    phase: "prepared",
    recording: false,
    elapsedSeconds: 0,
    metadata: pageMetadata,
    tabId,
    bitrate,
    permissionError: null,
    permissionActionReceived,
    message: "Morceau préparé. Vous pouvez démarrer l'enregistrement."
  });
  return recorderState;
}

async function openTrack(rawUrl) {
  if (recorderState.recording) {
    throw new Error("Arrêtez l'enregistrement en cours avant d'ouvrir un autre morceau.");
  }
  await cancelArmedCapture();
  const track = parseSpotifyTrackUrl(rawUrl);
  await chrome.storage.local.set({ lastTrackUrl: rawUrl });

  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const active = activeTabs[0];
  let tab;
  if (active?.url?.startsWith("https://open.spotify.com/")) {
    tab = await chrome.tabs.update(active.id, { url: track.url, active: true });
  } else {
    tab = await chrome.tabs.create({ url: track.url, active: true });
  }

  await setState({
    phase: "opened",
    recording: false,
    elapsedSeconds: 0,
    metadata: null,
    tabId: tab.id,
    message: "Morceau ouvert. Cliquez sur « 2. Préparer le morceau »."
  });
  return { track, tabId: tab.id };
}

async function startRecording(options = {}) {
  if (recorderState.recording) {
    throw new Error("Un enregistrement est déjà en cours.");
  }
  if (
    recorderState.phase !== "prepared" ||
    !recorderState.tabId ||
    !metadataSignature(recorderState.metadata)
  ) {
    throw new Error("Préparez d'abord ce morceau avec « 2. Préparer le morceau ».");
  }
  const tabId = recorderState.tabId;
  const metadata = recorderState.metadata;
  const bitrate = [128, 192, 256, 320].includes(Number(recorderState.bitrate))
    ? Number(recorderState.bitrate)
    : 192;

  // Le clic de lecture est lancé directement depuis le popup pour conserver le
  // geste utilisateur. La capture peut également avoir déjà été démarrée là-bas.
  const playbackTriggeredByPopup = options.playbackTriggeredByPopup === true;
  const captureAlreadyBegun = options.captureAlreadyBegun === true;
  const playbackPromise = playbackTriggeredByPopup
    ? Promise.resolve(null)
    : startPreparedPlayerPlayback(tabId, metadata.title);
  const beginPromise = chrome.runtime.sendMessage({
    type: captureAlreadyBegun ? "OFFSCREEN_GET_STATUS" : "OFFSCREEN_BEGIN_CAPTURE",
    target: "offscreen"
  });
  let beginResponse;
  let playbackResponse;
  const [beginResult, playbackResult] = await Promise.allSettled([
    beginPromise,
    playbackPromise
  ]);
  if (beginResult.status === "rejected" || playbackResult.status === "rejected") {
    await cancelArmedCapture();
    throw beginResult.status === "rejected" ? beginResult.reason : playbackResult.reason;
  }
  beginResponse = beginResult.value;
  playbackResponse = playbackResult.value;
  const captureReady = captureAlreadyBegun
    ? Boolean(beginResponse?.ok && beginResponse.active && beginResponse.encoding)
    : Boolean(beginResponse?.ok);
  if (!captureReady) {
    await cancelArmedCapture();
    throw new Error(beginResponse?.error || "La capture audio armée n'est plus disponible.");
  }
  if (!playbackTriggeredByPopup && !playbackResponse?.attempted) {
    await cancelArmedCapture();
    throw new Error("Spotify n'a pas démarré la lecture. Préparez de nouveau le morceau.");
  }
  const playing = await verifyPagePlayback(tabId, metadata.title);
  if (!playing) {
    await cancelArmedCapture();
    throw new Error("Le démarrage de la lecture n'a pas pu être confirmé.");
  }

  consecutiveTrackChanges = 0;
  await setState({
    phase: "recording",
    recording: true,
    elapsedSeconds: 0,
    metadata,
    tabId,
    message: `Lecture lancée — enregistrement MP3 à ${bitrate} kbit/s`
  });
  return recorderState;
}

async function stopRecording(reason = "manual") {
  if (!recorderState.recording || recorderState.phase === "encoding") {
    return recorderState;
  }
  await setState({ phase: "encoding", message: "Finalisation du fichier MP3…" });
  const response = await chrome.runtime.sendMessage({
    type: "OFFSCREEN_STOP_CAPTURE",
    target: "offscreen",
    reason
  });
  if (!response?.ok) {
    throw new Error(response?.error || "Impossible de finaliser l'enregistrement.");
  }
  return recorderState;
}

async function downloadAudio(message) {
  const downloadId = await chrome.downloads.download({
    url: message.url,
    filename: message.filename,
    conflictAction: "uniquify",
    saveAs: false
  });
  return downloadId;
}

async function handleSnapshot(message, sender) {
  if (
    !recorderState.recording ||
    recorderState.phase !== "recording" ||
    sender.tab?.id !== recorderState.tabId
  ) {
    return;
  }

  const initial = metadataSignature(recorderState.metadata);
  const current = metadataSignature(message.snapshot?.metadata);
  const position = Number(message.snapshot?.positionSeconds || 0);
  const duration = Number(message.snapshot?.durationSeconds || 0);
  const reachedEnd = Boolean(message.snapshot?.ended) || (
    recorderState.elapsedSeconds >= 2 &&
    duration > 0 &&
    position >= duration - 0.5 &&
    message.snapshot?.isPlaying === false
  );

  if (reachedEnd) {
    await stopRecording("track_ended");
    return;
  }

  if (initial && current && current !== initial && recorderState.elapsedSeconds >= 5) {
    consecutiveTrackChanges += 1;
    if (consecutiveTrackChanges >= 2) {
      await stopRecording("track_changed");
    }
  } else {
    consecutiveTrackChanges = 0;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "offscreen") {
    return false;
  }

  const run = async () => {
    if (message?.type === "START_RECORDING" && restoreComplete) {
      return { ok: true, state: await startRecording(message.options) };
    }
    await restorePromise;
    switch (message?.type) {
      case "GET_STATE":
        return { ok: true, state: recorderState };
      case "OPEN_TRACK":
        return { ok: true, ...(await openTrack(message.url)) };
      case "AUTHORIZE_CAPTURE": {
        if (sender.url !== chrome.runtime.getURL("authorize.html")) {
          return { ok: false, error: "Ouvrez l'autorisation depuis l'icône Spytify de Chrome." };
        }
        if (recorderState.phase !== "capture_permission") return { ok: true, state: recorderState };
        const tab = await getSpotifyTab();
        if (tab.id !== recorderState.tabId) {
          throw new Error("Ce n'est pas l'onglet préparé. Affichez le morceau voulu, puis cliquez sur « 2. Préparer le morceau » dans le panneau.");
        }
        return { ok: true, state: await resumeCapturePermission(tab) };
      }
      case "PREPARE_CURRENT_TRACK":
        return { ok: true, state: await prepareCurrentTrack(message.options) };
      case "START_RECORDING":
        return { ok: true, state: await startRecording(message.options) };
      case "STOP_RECORDING":
        return { ok: true, state: await stopRecording("manual") };
      case "AUDIO_PROGRESS":
        if (recorderState.recording) {
          await setState({ elapsedSeconds: message.elapsedSeconds });
        }
        return { ok: true };
      case "AUDIO_READY": {
        const downloadId = await downloadAudio(message);
        await setState({
          phase: "done",
          recording: false,
          elapsedSeconds: message.durationSeconds,
          tabId: null,
          message: "MP3 téléchargé dans le dossier Téléchargements"
        });
        return { ok: true, downloadId };
      }
      case "AUDIO_ERROR":
        await setState({
          phase: "error",
          recording: false,
          tabId: null,
          message: message.error || "Erreur pendant l'enregistrement"
        });
        return { ok: true };
      case "PLAYER_SNAPSHOT":
        await handleSnapshot(message, sender);
        return { ok: true };
      case "PLAYER_ENDED":
        if (
          recorderState.recording &&
          recorderState.phase === "recording" &&
          recorderState.elapsedSeconds >= 2 &&
          sender.tab?.id === recorderState.tabId
        ) {
          await stopRecording("media_ended");
        }
        return { ok: true };
      default:
        return { ok: false, error: "Message inconnu" };
    }
  };

  run()
    .then(sendResponse)
    .catch(async (error) => {
      if (["START_RECORDING", "STOP_RECORDING"].includes(message?.type) ||
          (message?.type === "AUTHORIZE_CAPTURE" && sender.url === chrome.runtime.getURL("authorize.html"))) {
        await setState({
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
  if (recorderState.recording && recorderState.tabId === tabId) {
    void stopRecording("tab_closed");
  } else if (recorderState.phase === "prepared" && recorderState.tabId === tabId) {
    void cancelArmedCapture().then(() => setState({
      phase: "idle",
      recording: false,
      elapsedSeconds: 0,
      metadata: null,
      tabId: null,
      message: "Le morceau préparé a été fermé"
    }));
  }
});
