import { createId3v24Tag, recordingFilename } from "./core.js";
import { MonitoringSession } from "./monitoring.js";

// Les deux modes utilisent la même capture continue : le mode « Un morceau »
// est une surveillance dont le service de fond ne garde que le titre demandé.
let capture = null;
let stopPromise = null;

// Un MP3 reste lisible après son téléchargement accepté : Chrome peut encore
// demander où l'enregistrer lorsque le téléchargement automatique a échoué.
const BLOB_LIFETIME_MILLISECONDS = 10 * 60_000;

// MP3 dont Chrome n'a pas encore confirmé l'enregistrement : le service de
// fond ne ferme pas ce document tant qu'il en reste.
const pendingDownloads = new Set();

function createDownloadUrl(blob) {
  const url = URL.createObjectURL(blob);
  pendingDownloads.add(url);
  return url;
}

function releaseDownloadUrl(url) {
  pendingDownloads.delete(url);
  URL.revokeObjectURL(url);
}

// Un MP3 déjà écrit est libéré aussitôt ; sinon il reste lisible le temps que
// Chrome termine ou que l'utilisateur choisisse où l'enregistrer.
function settleDownloadUrl(url, response) {
  if (response?.completed) releaseDownloadUrl(url);
  else setTimeout(() => releaseDownloadUrl(url), BLOB_LIFETIME_MILLISECONDS);
}

// Les commandes de capture viennent du service de fond ou du panneau, jamais
// d'un onglet : un script de contenu porte toujours sender.tab.
function isExtensionSender(sender) {
  return !sender?.tab && (!sender?.url || sender.url.startsWith(chrome.runtime.getURL("")));
}

function isCapturedSpotifyTab(sender) {
  return Boolean(capture) && sender?.tab?.id === capture.tabId &&
    String(sender?.url || "").startsWith("https://open.spotify.com/");
}

function floatToInt16(channel) {
  const result = new Int16Array(channel.length);
  for (let index = 0; index < channel.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, channel[index]));
    result[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return result;
}

async function loadCover(url) {
  if (!url || !url.startsWith("https://")) {
    return null;
  }
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const mimeType = response.headers.get("content-type")?.split(";")[0] || "";
    if (!mimeType.startsWith("image/")) return null;
    return {
      mimeType,
      bytes: new Uint8Array(await response.arrayBuffer())
    };
  } catch {
    return null;
  }
}

async function startCapture(message) {
  if (capture) {
    throw new Error("Une capture audio est déjà active.");
  }
  if (!globalThis.lamejs?.Mp3Encoder) {
    throw new Error("L'encodeur MP3 intégré n'a pas pu être chargé.");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: message.streamId
      }
    },
    video: false
  });

  let audioContext;
  try {
    audioContext = new AudioContext();
    await audioContext.audioWorklet.addModule(chrome.runtime.getURL("audio-worklet.js"));
    await audioContext.resume();
    const source = audioContext.createMediaStreamSource(stream);

    // La capture d'un onglet coupe normalement sa sortie. Cette branche la renvoie
    // vers les haut-parleurs pendant que la seconde branche alimente l'encodeur.
    source.connect(audioContext.destination);

    const worklet = new AudioWorkletNode(audioContext, "pcm-capture-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: "explicit"
    });
    const silentOutput = audioContext.createGain();
    silentOutput.gain.value = 0;
    source.connect(worklet);
    worklet.connect(silentOutput);
    silentOutput.connect(audioContext.destination);

    const current = {
      mode: "monitor",
      audioContext,
      flushResolve: null,
      silentOutput,
      source,
      stream,
      worklet,
      tabId: message.tabId,
      sessionId: message.sessionId,
      contextEpochMs: Date.now() - audioContext.currentTime * 1000,
      exports: Promise.resolve(),
      exportError: null,
      lastMonitorStatus: ""
    };
    current.monitor = new MonitoringSession({
      sampleRate: audioContext.sampleRate, startedAtMs: Date.now(),
      create: () => ({ encoder: new lamejs.Mp3Encoder(2, audioContext.sampleRate, message.bitrate), chunks: [] }),
      write(segment, left, right) {
        const encoded = segment.encoder.encodeBuffer(floatToInt16(left), floatToInt16(right));
        if (encoded.length) segment.chunks.push(new Uint8Array(encoded));
      },
      finish(segment) {
        const bytes = segment.data.encoder.flush();
        if (bytes.length) segment.data.chunks.push(new Uint8Array(bytes));
        // L'export du fichier précédent n'interrompt pas les nouveaux PCM.
        current.exports = current.exports.then(() => exportMonitoredTrack(current, segment))
          .catch((error) => {
            current.exportError = error.message;
            chrome.runtime.sendMessage({ type: "MONITOR_EXPORT_ERROR", sessionId: current.sessionId, error: error.message }).catch(() => {});
          });
      }
    });
    worklet.port.onmessage = (event) => {
      if (event.data?.type === "flushed") {
        current.flushResolve?.();
        current.flushResolve = null;
        return;
      }
      if (event.data?.type !== "pcm") return;
      const start = Number.isFinite(event.data.contextStartSeconds)
        ? current.contextEpochMs + event.data.contextStartSeconds * 1000
        : Date.now() - event.data.left.length * 1000 / audioContext.sampleRate;
      current.monitor.pcm(event.data.left, event.data.right, start, Date.now());
      publishMonitorStatus(current);
    };

    stream.getAudioTracks()[0]?.addEventListener("ended", () => {
      if (capture === current) void stopMonitoring("stream_ended").catch(console.error);
    });

    capture = current;
    // Spotify en pause n'envoie plus de relevé, ni l'onglet de PCM : cette
    // horloge exporte le dernier morceau terminé sans attendre le son suivant.
    current.settleTimer = setInterval(() => {
      current.monitor.settle(Date.now());
      publishMonitorStatus(current);
    }, 1000);
  } catch (error) {
    // Une erreur avant l'affectation de capture ne doit pas laisser un flux orphelin.
    stream.getTracks().forEach((track) => track.stop());
    if (audioContext) await audioContext.close().catch(() => {});
    throw error;
  }
}

async function flushWorklet(current) {
  await new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve();
    };
    current.flushResolve = finish;
    current.worklet.port.postMessage({ type: "flush" });
    setTimeout(finish, 500);
  });
}

function publishMonitorStatus(current) {
  const state = current.monitor.status();
  const signature = JSON.stringify(state);
  if (signature === current.lastMonitorStatus) return;
  current.lastMonitorStatus = signature;
  chrome.runtime.sendMessage({ type: "MONITOR_STATE", sessionId: current.sessionId, state }).catch(() => {});
}

async function exportMonitoredTrack(current, segment) {
  const cover = await loadCover(segment.metadata?.artworkUrl);
  const blob = new Blob([createId3v24Tag(segment.metadata, cover), ...segment.data.chunks], { type: "audio/mpeg" });
  const url = createDownloadUrl(blob);
  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: "MONITOR_TRACK_READY", sessionId: current.sessionId, url,
      filename: recordingFilename(segment.metadata), metadata: segment.metadata,
      durationSeconds: segment.durationSeconds, reason: segment.reason,
      expectedDurationSeconds: segment.expectedDurationSeconds, journal: current.monitor.journal.slice()
    });
    if (!response?.ok) throw new Error(response?.error || "Le téléchargement du morceau a échoué.");
  } catch (error) {
    releaseDownloadUrl(url);
    throw error;
  }
  settleDownloadUrl(url, response);
}

async function stopMonitoring(reason = "manual") {
  if (stopPromise) return stopPromise;
  const current = capture;
  if (!current?.monitor) return;
  stopPromise = (async () => {
    clearInterval(current.settleTimer);
    current.source.disconnect();
    await flushWorklet(current);
    current.worklet.port.onmessage = null;
    current.worklet.disconnect();
    current.silentOutput.disconnect();
    capture = null;
    current.stream.getTracks().forEach((track) => track.stop());
    current.monitor.stop(reason);
    await current.audioContext.close();
    await current.exports;
    await chrome.runtime.sendMessage({ type: "MONITOR_STOPPED", sessionId: current.sessionId, error: current.exportError,
      journal: current.monitor.journal.slice() });
  })();
  try { await stopPromise; } finally { stopPromise = null; }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (["PLAYER_SNAPSHOT", "PLAYER_ENDED"].includes(message?.type) && isCapturedSpotifyTab(sender)) {
    capture.monitor.snapshot(message.snapshot);
    publishMonitorStatus(capture);
    return false;
  }
  if (message?.target !== "offscreen") {
    return false;
  }
  if (!isExtensionSender(sender)) {
    sendResponse({ ok: false, error: "Commande audio refusée : émetteur non autorisé." });
    return false;
  }

  if (message.type === "OFFSCREEN_GET_STATUS") {
    sendResponse({
      ok: true,
      active: Boolean(capture),
      pendingDownloads: pendingDownloads.size,
      mode: capture?.mode ?? null,
      sessionId: capture?.sessionId ?? null,
      monitorState: capture?.monitor?.status() ?? null
    });
    return false;
  }

  if (message.type === "OFFSCREEN_UPDATE_MONITOR") {
    if (!capture?.monitor || message.sessionId !== capture.sessionId) {
      sendResponse({ ok: false, error: "La surveillance n'est plus active." });
    } else {
      capture.monitor.snapshot(message.snapshot);
      publishMonitorStatus(capture);
      sendResponse({ ok: true });
    }
    return false;
  }

  // L'annulation et l'arrêt finalisent tous deux la capture : le service de
  // fond écarte lui-même les MP3 d'une session abandonnée ou expirée.
  const run = message.type === "OFFSCREEN_START_CAPTURE"
    ? startCapture(message)
    : ["OFFSCREEN_CANCEL_CAPTURE", "OFFSCREEN_STOP_MONITORING"].includes(message.type)
      ? stopMonitoring(message.reason || "manual")
      : Promise.reject(new Error("Commande audio inconnue."));

  run
    .then(() => sendResponse({ ok: true }))
    .catch((error) => {
      chrome.runtime.sendMessage({ type: "AUDIO_ERROR", error: error.message }).catch(() => {});
      sendResponse({ ok: false, error: error.message });
    });
  return true;
});
