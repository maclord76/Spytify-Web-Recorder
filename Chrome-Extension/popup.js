import { describeRecording, formatDuration, parseSpotifyTrackUrl, recordingFilename } from "./core.js";

const elements = {
  mode: document.querySelector("#recorder-mode"),
  singleControls: document.querySelector("#single-track-controls"),
  monitorCount: document.querySelector("#monitor-count"),
  monitorFilename: document.querySelector("#monitor-filename"),
  hint: document.querySelector("#mode-hint"),
  bitrate: document.querySelector("#bitrate"),
  diagnostics: document.querySelector("#copy-diagnostics"),
  elapsed: document.querySelector("#elapsed"),
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

function setBusy(value) {
  busy = value;
  renderState(currentState);
}

function statusTitle(state, phase) {
  if (phase === "monitor_stopping") return "Finalisation";
  if (state?.monitoring && state.mode === "single") {
    return state.advertisement ? "Publicité en cours"
      : state.recording ? "Enregistrement en cours"
      : state.playbackStarted ? "En pause" : "Lancement du morceau";
  }
  if (state?.monitoring) {
    return state.advertisement ? "Publicité ignorée" : state.recording ? "Surveillance · Enregistrement" : "Surveillance active";
  }
  return { done: "Terminé", error: "Attention", capture_permission: "Autorisation requise" }[phase] ?? "Prêt";
}

export function renderState(state) {
  currentState = state || null;
  const phase = state?.phase || "idle";
  if (state?.monitoring || phase === "capture_permission") elements.mode.value = state.mode || "single";
  const monitorMode = elements.mode.value === "monitor";
  const active = Boolean(state?.monitoring);
  const stopping = phase === "monitor_stopping";
  elements.singleControls.hidden = monitorMode;
  elements.mode.disabled = busy || active;
  elements.url.disabled = busy || active;
  elements.status.className = `status ${phase}`;
  elements.statusTitle.textContent = statusTitle(state, phase);
  elements.statusMessage.textContent = state?.message || "Prêt";
  elements.elapsed.textContent = formatDuration(state?.elapsedSeconds);
  elements.start.hidden = active;
  elements.start.textContent = monitorMode ? "Activer la surveillance" : "Enregistrer le morceau";
  elements.start.disabled = busy;
  elements.stop.hidden = !active;
  elements.stop.textContent = state?.mode === "monitor" ? "Arrêter la surveillance et enregistrer" : "Arrêter et enregistrer le MP3";
  elements.stop.disabled = busy || stopping;
  elements.bitrate.disabled = busy || active;
  elements.monitorCount.hidden = !monitorMode;
  elements.monitorCount.textContent = `${state?.capturedTracks || 0} MP3 téléchargé(s)`;
  const automaticFilename = state?.lastMonitoredFilename || (state?.metadata?.title ? recordingFilename(state.metadata) : "");
  elements.monitorFilename.hidden = !monitorMode || !automaticFilename;
  // Le dernier MP3 téléchargé est suivi de sa durée enregistrée.
  elements.monitorFilename.textContent = !automaticFilename ? ""
    : state?.lastMonitoredFilename
      ? `Dernier MP3 : ${describeRecording(state.lastMonitoredFilename, state.lastMonitoredDurationSeconds)}`
      : `Nom automatique : ${describeRecording(automaticFilename)}`;
  elements.hint.textContent = monitorMode
    ? "Lancez un morceau ou une playlist dans Spotify. Un MP3 est téléchargé par morceau. Les publicités sont ignorées et les pauses conservent la surveillance. Un morceau incomplet porte la mention « extrait »."
    : "Collez l'URL d'un morceau, ou affichez sa page dans Spotify. Spytify recharge la page en écoutant déjà l'onglet, puis lance la lecture si Spotify ne l'a pas fait. La fin du morceau télécharge le MP3.";
  elements.trackName.hidden = !state?.metadata?.title;
  elements.trackName.textContent = state?.metadata?.title
    ? `${state.metadata.artist || "Artiste inconnu"} — ${state.metadata.title}`
    : "";
  // L'URL mémorisée est effacée dès que la lecture du morceau est confirmée.
  if (state?.mode === "single" && state.playbackStarted) elements.url.value = "";
}

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error || "L'opération a échoué.");
  }
  return response;
}

async function showError(error) {
  renderState({ ...currentState, phase: "error", message: error.message, elapsedSeconds: 0 });
}

elements.mode.addEventListener("change", () => renderState(currentState));

elements.start.addEventListener("click", async () => {
  if (busy) return;
  try {
    const url = elements.url.value.trim();
    const monitorMode = elements.mode.value === "monitor";
    // Sans URL, le morceau affiché dans l'onglet Spotify est enregistré.
    if (!monitorMode && url) parseSpotifyTrackUrl(url);
    setBusy(true);
    const bitrate = Number(elements.bitrate.value);
    await chrome.storage.local.set({ bitrate });
    const response = monitorMode
      ? await request({ type: "START_MONITORING", options: { bitrate } })
      : await request({ type: "START_SINGLE_TRACK", options: { url, bitrate } });
    renderState(response.state);
  } catch (error) {
    await showError(error);
  } finally {
    setBusy(false);
  }
});

elements.stop.addEventListener("click", async () => {
  if (busy) return;
  try {
    setBusy(true);
    const response = await request({ type: "STOP_MONITORING" });
    renderState(response.state);
  } catch (error) {
    await showError(error);
  } finally {
    setBusy(false);
  }
});
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Chrome refuse parfois le presse-papiers depuis un panneau latéral qui vient
    // de perdre le focus : la sélection d'un champ temporaire reste acceptée.
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  }
}

// Le diagnostic est destiné à être collé dans un signalement : un premier clic
// en décrit le contenu, un second dans les dix secondes le copie.
const DIAGNOSTIC_CONFIRMATION_MILLISECONDS = 10_000;
let diagnosticConfirmationUntil = 0;

elements.diagnostics.addEventListener("click", async () => {
  if (Date.now() > diagnosticConfirmationUntil) {
    diagnosticConfirmationUntil = Date.now() + DIAGNOSTIC_CONFIRMATION_MILLISECONDS;
    elements.statusMessage.textContent = "Le diagnostic contient l'état de l'enregistrement, le titre et le chemin du morceau Spotify affiché, le journal des coupes de la dernière surveillance (titres et positions), la version de Chrome et l'état technique du lecteur. Aucune donnée de compte ni aucun audio. Cliquez de nouveau dans les dix secondes pour le copier.";
    return;
  }
  diagnosticConfirmationUntil = 0;
  elements.diagnostics.disabled = true;
  try {
    const response = await request({ type: "COLLECT_DIAGNOSTICS" });
    const rapport = JSON.stringify(response.diagnostics, null, 2);
    elements.statusMessage.textContent = await copyToClipboard(rapport)
      ? `Diagnostic copié (${rapport.length} caractères). Relisez-le avant de le coller dans votre signalement.`
      : "Chrome a refusé l'accès au presse-papiers.";
  } catch (error) {
    elements.statusMessage.textContent = `Diagnostic impossible : ${error.message}`;
  } finally {
    elements.diagnostics.disabled = false;
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
  elements.mode.value = response.state?.mode === "monitor" ? "monitor" : "single";
  renderState(response.state);
}

initialize().catch(showError);
