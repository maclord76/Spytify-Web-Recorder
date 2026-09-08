import { createId3v24Tag, recordingFilename } from "./core.js";

let capture = null;
let stopPromise = null;

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
    const response = await fetch(url);
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

    const encoder = new lamejs.Mp3Encoder(2, audioContext.sampleRate, message.bitrate);
    const chunks = [];
    let lastProgressSecond = -1;

    let flushResolve = null;
    const current = {
    audioStarted: false,
    audioContext,
    chunks,
    encoder,
    encoding: !message.armed,
    metadata: message.metadata,
    get flushResolve() { return flushResolve; },
    set flushResolve(value) { flushResolve = value; },
    silentOutput,
    source,
    startedAt: message.armed ? null : performance.now(),
    stream,
    targetDurationSeconds: Math.max(0, Number(message.durationSeconds) || 0),
    worklet
    };
    worklet.port.onmessage = (event) => {
    if (event.data?.type === "flushed") {
      flushResolve?.();
      flushResolve = null;
      return;
    }
    if (event.data?.type !== "pcm") return;
    if (!current.encoding) return;

    if (!current.audioStarted) {
      const containsAudio = event.data.left.some((sample) => Math.abs(sample) > 0.000001)
        || event.data.right.some((sample) => Math.abs(sample) > 0.000001);
      if (!containsAudio) return;
      current.audioStarted = true;
      current.startedAt = performance.now();
    }

    const left = floatToInt16(event.data.left);
    const right = floatToInt16(event.data.right);
    const encoded = encoder.encodeBuffer(left, right);
    if (encoded.length > 0) {
      chunks.push(new Uint8Array(encoded));
    }

    const elapsedSeconds = Math.floor((performance.now() - current.startedAt) / 1000);
    if (elapsedSeconds !== lastProgressSecond) {
      lastProgressSecond = elapsedSeconds;
      chrome.runtime.sendMessage({ type: "AUDIO_PROGRESS", elapsedSeconds }).catch(() => {});
    }
    if (
      current.targetDurationSeconds > 0 &&
      elapsedSeconds >= Math.ceil(current.targetDurationSeconds + 1)
    ) {
      void stopCapture("duration_reached");
    }
    };

    stream.getAudioTracks()[0]?.addEventListener("ended", () => {
    if (capture !== current) return;
    if (current.encoding) void stopCapture("stream_ended");
    else void cancelCapture();
    });

    capture = current;
  } catch (error) {
    // Une erreur avant l'affectation de capture ne doit pas laisser un flux orphelin.
    stream.getTracks().forEach((track) => track.stop());
    if (audioContext) await audioContext.close().catch(() => {});
    throw error;
  }
}

async function beginCapture() {
  if (!capture) throw new Error("Aucune capture audio n'est armée.");
  if (capture.encoding) return;
  capture.startedAt = performance.now();
  capture.audioStarted = false;
  capture.encoding = true;
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

async function stopCapture(reason) {
  if (stopPromise) {
    return stopPromise;
  }
  if (!capture) {
    return;
  }
  if (!capture.encoding) {
    await cancelCapture();
    return;
  }

  stopPromise = (async () => {
    const current = capture;
    capture = null;
    current.source.disconnect();
    await flushWorklet(current);
    current.worklet.port.onmessage = null;
    current.worklet.disconnect();
    current.silentOutput.disconnect();
    current.stream.getTracks().forEach((track) => track.stop());

    const finalBytes = current.encoder.flush();
    if (finalBytes.length > 0) {
      current.chunks.push(new Uint8Array(finalBytes));
    }
    await current.audioContext.close();

    const cover = await loadCover(current.metadata?.artworkUrl);
    const id3 = createId3v24Tag(current.metadata, cover);
    const blob = new Blob([id3, ...current.chunks], { type: "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    const durationSeconds = Math.max(0, Math.round((performance.now() - current.startedAt) / 1000));

    const response = await chrome.runtime.sendMessage({
      type: "AUDIO_READY",
      url,
      filename: recordingFilename(current.metadata),
      durationSeconds,
      reason
    });
    if (!response?.ok) {
      URL.revokeObjectURL(url);
      throw new Error(response?.error || "Le téléchargement du MP3 a échoué.");
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  })();

  try {
    await stopPromise;
  } finally {
    stopPromise = null;
  }
}

async function cancelCapture() {
  if (!capture) return;
  const current = capture;
  capture = null;
  current.source.disconnect();
  current.worklet.port.onmessage = null;
  current.worklet.disconnect();
  current.silentOutput.disconnect();
  current.stream.getTracks().forEach((track) => track.stop());
  await current.audioContext.close();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") {
    return false;
  }

  if (message.type === "OFFSCREEN_GET_STATUS") {
    sendResponse({
      ok: true,
      active: Boolean(capture),
      encoding: Boolean(capture?.encoding),
      elapsedSeconds: capture?.encoding
        ? Math.max(0, Math.floor((performance.now() - capture.startedAt) / 1000))
        : 0
    });
    return false;
  }

  const run = message.type === "OFFSCREEN_START_CAPTURE"
    ? startCapture(message)
    : message.type === "OFFSCREEN_BEGIN_CAPTURE"
      ? beginCapture()
      : message.type === "OFFSCREEN_CANCEL_CAPTURE"
        ? cancelCapture()
    : message.type === "OFFSCREEN_STOP_CAPTURE"
      ? stopCapture(message.reason || "manual")
      : Promise.reject(new Error("Commande audio inconnue."));

  run
    .then(() => sendResponse({ ok: true }))
    .catch((error) => {
      chrome.runtime.sendMessage({ type: "AUDIO_ERROR", error: error.message }).catch(() => {});
      sendResponse({ ok: false, error: error.message });
    });
  return true;
});
