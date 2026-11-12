import assert from "node:assert/strict";

const nodes = new Map();
const element = selector => {
  if (!nodes.has(selector)) nodes.set(selector, { value: selector === "#recorder-mode" ? "single" : "192",
    hidden: false, disabled: false, textContent: "", events: {},
    addEventListener(type, fn) { this.events[type] = fn; } });
  return nodes.get(selector);
};
globalThis.document = { querySelector: element };
let current = { phase: "idle", mode: "single", recording: false, monitoring: false };
const messages = [];
globalThis.chrome = {
  storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } },
  runtime: { getManifest: () => ({ version: "1.16.0" }), onMessage: { addListener() {} },
    async sendMessage(message) {
      messages.push(message);
      if (message.type === "START_MONITORING") current = { phase: "monitoring", mode: "monitor", monitoring: true, recording: false };
      if (message.type === "START_SINGLE_TRACK") current = { phase: "monitoring", mode: "single", monitoring: true, recording: false,
        playbackStarted: false, message: "Chargement du morceau dans Spotify…" };
      if (message.type === "STOP_MONITORING") current = { ...current, phase: "done", monitoring: false, recording: false, capturedTracks: current.mode === "single" ? 1 : 2 };
      return { ok: true, state: current };
    }
  }
};
const { renderState } = await import("../popup.js");
await new Promise(resolve => setImmediate(resolve));
assert.equal(element("#start-recording").textContent, "Enregistrer le morceau");
assert.equal(element("#single-track-controls").hidden, false);
element("#recorder-mode").value = "monitor";
element("#recorder-mode").events.change();
assert.equal(element("#single-track-controls").hidden, true);
assert.equal(element("#start-recording").textContent, "Activer la surveillance");
await element("#start-recording").events.click();
assert.equal(messages.at(-1).type, "START_MONITORING");
assert.equal(element("#start-recording").hidden, true);
assert.equal(element("#stop-recording").hidden, false);
assert.equal(element("#stop-recording").disabled, false, "L'arrêt reste disponible en attente de lecture.");
assert.equal(element("#recorder-mode").disabled, true);
assert.equal(element("#bitrate").disabled, true);
renderState({ ...current, recording: true, metadata: { title: "A", artist: "Artiste" }, elapsedSeconds: 62, capturedTracks: 1 });
assert.equal(element("#elapsed").textContent, "01:02");
assert.equal(element("#monitor-count").textContent, "1 MP3 téléchargé(s)");
assert.match(element("#track-name").textContent, /Artiste — A/);
assert.equal(element("#monitor-filename").hidden, false);
assert.equal(element("#monitor-filename").textContent, "Nom automatique : Artiste - A.mp3");
renderState({ ...current, recording: true, metadata: { title: "B", artist: "Artiste" }, lastMonitoredFilename: "Spytify Web/Artiste - A (extrait).mp3" });
assert.equal(element("#monitor-filename").textContent, "Dernier MP3 : Artiste - A (extrait).mp3");
renderState({ ...current, recording: true, metadata: { title: "B", artist: "Artiste" },
  lastMonitoredFilename: "Spytify Web/Daft Punk - Ouverture.mp3", lastMonitoredDurationSeconds: 192.4 });
assert.equal(element("#monitor-filename").textContent, "Dernier MP3 : Daft Punk - Ouverture.mp3 (03:12)",
  "Le dernier MP3 affiche sa durée enregistrée.");
renderState({ ...current, recording: false });
assert.equal(element("#stop-recording").hidden, false, "L'arrêt reste visible pendant une pause.");
renderState({ ...current, advertisement: true, recording: false, metadata: null,
  message: "Publicité ignorée. Reprise automatique au prochain morceau." });
assert.equal(element("#status-title").textContent, "Publicité ignorée");
assert.equal(element("#stop-recording").hidden, false);
assert.equal(element("#stop-recording").disabled, false);
assert.equal(element("#start-recording").hidden, true);
renderState({ ...current, advertisement: false, recording: true });
assert.equal(element("#status-title").textContent, "Surveillance · Enregistrement");
renderState({ ...current, phase: "monitor_stopping" });
assert.equal(element("#stop-recording").disabled, true);
renderState(current);
await element("#stop-recording").events.click();
assert.equal(messages.at(-1).type, "STOP_MONITORING");
assert.equal(element("#stop-recording").hidden, true);
assert.equal(element("#start-recording").hidden, false);
assert.equal(element("#monitor-count").textContent, "2 MP3 téléchargé(s)");
element("#recorder-mode").value = "single";
element("#recorder-mode").events.change();
renderState({ phase: "idle", mode: "single" });
assert.equal(element("#start-recording").textContent, "Enregistrer le morceau");
assert.equal(element("#single-track-controls").hidden, false);
assert.equal(element("#monitor-count").hidden, true);
assert.equal(element("#monitor-filename").hidden, true);

// Un seul clic : le service de fond charge le morceau et le lance si besoin.
element("#track-url").value = "adresse incorrecte";
await element("#start-recording").events.click();
assert.equal(messages.at(-1).type, "STOP_MONITORING", "Une URL invalide n'envoie aucune demande.");
assert.match(element("#status-message").textContent, /valide/);
element("#track-url").value = "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT";
await element("#start-recording").events.click();
assert.deepEqual(messages.at(-1), { type: "START_SINGLE_TRACK",
  options: { url: "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT", bitrate: 192 } });
assert.equal(element("#status-title").textContent, "Lancement du morceau");
assert.equal(element("#start-recording").hidden, true);
assert.equal(element("#stop-recording").hidden, false);
assert.equal(element("#stop-recording").textContent, "Arrêter et enregistrer le MP3");
assert.equal(element("#track-url").disabled, true);
assert.equal(element("#recorder-mode").disabled, true);
assert.equal(element("#track-url").value, "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
  "L'URL reste disponible tant que la lecture n'est pas confirmée.");
renderState({ ...current, playbackStarted: true, recording: true, metadata: { title: "A", artist: "Artiste" } });
assert.equal(element("#status-title").textContent, "Enregistrement en cours");
assert.equal(element("#track-url").value, "");
renderState({ ...current, playbackStarted: true, recording: false, advertisement: true });
assert.equal(element("#status-title").textContent, "Publicité en cours");
renderState({ ...current, playbackStarted: true, recording: false });
assert.equal(element("#status-title").textContent, "En pause");
await element("#stop-recording").events.click();
assert.equal(messages.at(-1).type, "STOP_MONITORING");
assert.equal(element("#start-recording").hidden, false);

// Sans URL, le morceau affiché dans Spotify est enregistré.
element("#track-url").value = "";
await element("#start-recording").events.click();
assert.deepEqual(messages.at(-1).options, { url: "", bitrate: 192 });console.log("Panneau : sélection du mode, activation, pause, compteur, arrêt et enregistrement d'un morceau en un clic vérifiés");
