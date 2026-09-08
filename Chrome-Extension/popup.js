import { parseSpotifyTrackUrl } from "./core.js";
import { startPreparedPlayerPlayback } from "./player-control.js";

const elements = {
  bitrate: document.querySelector("#bitrate"),
  elapsed: document.querySelector("#elapsed"),
  openTrack: document.querySelector("#open-track"),
  start: document.querySelector("#start-recording"),
  status: document.querySelector("#status"),
  statusMessage: document.querySelector("#status-message"),
  statusTitle: document.querySelector("#status-title"),
  stop: document.querySelector("#stop-recording"),
  trackName: document.querySelector("#track-name"),
  url: document.querySelector("#track-url")
};

let busy = false;
let currentState = null;

function formatElapsed(seconds) {
  const minutes = Math.floor(Number(seconds || 0) / 60);
  const remaining = Math.floor(Number(seconds || 0) % 60);
  return `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

function setBusy(value) {
  busy = value;
  elements.openTrack.disabled = value;
  elements.start.disabled = value;
  elements.stop.disabled = value;
}

export function renderState(state) {
  currentState = state || null;
  const phase = state?.phase || "idle";
  elements.status.className = `status ${phase}`;
  elements.statusTitle.textContent = state?.recording
    ? "Enregistrement en cours"
    : phase === "encoding"
      ? "Finalisation"
      : phase === "done"
        ? "Terminé"
        : phase === "error"
          ? "Attention"
          : phase === "capture_permission"
            ? "Autorisation requise"
            : "Prêt";
  elements.statusMessage.textContent = state?.message || "Prêt";
  elements.elapsed.textContent = formatElapsed(state?.elapsedSeconds);
  elements.start.hidden = Boolean(state?.recording) || phase === "encoding";
  elements.start.textContent = phase === "prepared"
    ? "3. Démarrer l'enregistrement"
    : "2. Préparer le morceau";
  elements.start.disabled = busy;
  elements.stop.hidden = !state?.recording || phase === "encoding";
  elements.bitrate.disabled = Boolean(state?.recording) || phase === "prepared" || phase === "encoding";
  elements.trackName.hidden = !state?.metadata?.title;
  elements.trackName.textContent = state?.metadata?.title
    ? `${state.metadata.artist || "Artiste inconnu"} — ${state.metadata.title}`
    : "";
}

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error || "L'opération a échoué.");
  }
  return response;
}

async function showError(error) {
  renderState({ phase: "error", message: error.message, elapsedSeconds: 0 });
}

elements.openTrack.addEventListener("click", async () => {
  if (busy) return;
  try {
    parseSpotifyTrackUrl(elements.url.value);
    setBusy(true);
    await request({ type: "OPEN_TRACK", url: elements.url.value });
  } catch (error) {
    await showError(error);
  } finally {
    setBusy(false);
  }
});

elements.start.addEventListener("click", async () => {
  if (busy) return;
  let cancelPendingCapture = false;
  try {
    setBusy(true);
    const preparing = currentState?.phase !== "prepared";
    let response;
    if (preparing) {
      const bitrate = Number(elements.bitrate.value);
      await chrome.storage.local.set({ bitrate });
      response = await request({ type: "PREPARE_CURRENT_TRACK", options: { bitrate } });
    } else {
      const tabId = currentState.tabId;
      const expectedTitle = currentState.metadata?.title || "";
      cancelPendingCapture = true;
      // La capture et le clic Spotify partent directement du geste utilisateur.
      // Le service de fond ne vérifie la progression qu'après la fin de cette
      // commande afin d'éviter un faux échec pendant le rendu du player.
      const beginPromise = chrome.runtime.sendMessage({
        type: "OFFSCREEN_BEGIN_CAPTURE",
        target: "offscreen"
      });
      const playbackPromise = startPreparedPlayerPlayback(tabId, expectedTitle);
      const [beginResult, playbackResult] = await Promise.allSettled([
        beginPromise,
        playbackPromise
      ]);
      if (beginResult.status === "rejected") throw beginResult.reason;
      if (playbackResult.status === "rejected") throw playbackResult.reason;
      const beginResponse = beginResult.value;
      const playbackResponse = playbackResult.value;
      if (!beginResponse?.ok) {
        throw new Error(beginResponse?.error || "La capture audio armée n'est plus disponible.");
      }
      if (!playbackResponse?.attempted) {
        throw new Error("Le bouton lecture du player Spotify n'a pas pu être actionné.");
      }
      response = await request({
        type: "START_RECORDING",
        options: {
          playbackTriggeredByPopup: true,
          captureAlreadyBegun: true
        }
      });
      cancelPendingCapture = false;
      elements.url.value = "";
      await chrome.storage.local.remove("lastTrackUrl");
    }
    renderState(response.state);
  } catch (error) {
    if (cancelPendingCapture) {
      await chrome.runtime.sendMessage({
        type: "OFFSCREEN_CANCEL_CAPTURE",
        target: "offscreen"
      }).catch(() => {});
    }
    await showError(error);
  } finally {
    setBusy(false);
  }
});

elements.stop.addEventListener("click", async () => {
  if (busy) return;
  try {
    setBusy(true);
    const response = await request({ type: "STOP_RECORDING" });
    renderState(response.state);
  } catch (error) {
    await showError(error);
  } finally {
    setBusy(false);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "STATE_CHANGED") {
    renderState(message.state);
  }
});

async function initialize() {
  document.querySelector("#extension-version").textContent = `Version ${chrome.runtime.getManifest().version}`;
  const saved = await chrome.storage.local.get(["lastTrackUrl", "bitrate"]);
  if (saved.lastTrackUrl) elements.url.value = saved.lastTrackUrl;
  if ([128, 192, 256, 320].includes(Number(saved.bitrate))) {
    elements.bitrate.value = String(saved.bitrate);
  }
  const response = await request({ type: "GET_STATE" });
  renderState(response.state);
}

initialize().catch(showError);
