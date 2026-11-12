import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { readTrackPlayButton, startTrackPlayback } from "../player-control.js";

const { isPlayingLabel, labels: { pause, play } } = globalThis.SpytifyPlayer;

// Libellés relevés dans les traductions officielles du lecteur Spotify Web.
const samples = {
  fr: ["Pause", "Lecture"], en: ["Pause", "Play"], es: ["Pausa", "Reproducir"],
  "es-419": ["Pausar", "Reproducir"], it: ["Pausa", "Play"], "pt-PT": ["Pausar", "Reproduzir"],
  de: ["Pause", "Play"], nl: ["Pauzeren", "Afspelen"], pl: ["Pauza", "Odtwórz"],
  sv: ["Pausa", "Spela upp"], tr: ["Duraklat", "Çal"], ru: ["Пауза", "Слушать"],
  ja: ["一時停止", "再生"], ko: ["일시 정지하기", "재생하기"], "zh-TW": ["暫停", "播放"],
  ar: ["إيقاف مؤقّت", "استمع"], he: ["השהיה", "נגן"], hi: ["रोकें", "चलाएँ"],
  fil: ["I-pause", "I-play"]
};
for (const [language, [pauseLabel, playLabel]] of Object.entries(samples)) {
  assert.equal(isPlayingLabel(pauseLabel), true, `${language} : ${pauseLabel}`);
  assert.equal(isPlayingLabel(playLabel), false, `${language} : ${playLabel}`);
}
assert.equal(isPlayingLabel("  PAUSA "), true, "Casse et espaces ignorés.");
assert.equal(isPlayingLabel("Mettre en pause"), true, "Ancien libellé français conservé.");
assert.equal(isPlayingLabel("Lire : Never Gonna Give You Up"), null, "Un bouton de recommandation n'est pas le lecteur.");
assert.equal(isPlayingLabel(""), null);
assert.equal(pause.filter((label) => play.includes(label)).length, 0, "Aucun libellé n'a deux sens.");

// Lecteur inférieur et gros bouton du morceau en espagnol.
let playerLabel = "Reproducir";
let pageLabel = "Reproducir";
let mediaPaused = true;
const visible = { getClientRects: () => [{}] };
const button = (label, rectangle) => ({
  ...visible,
  disabled: false,
  click() { throw new Error("Aucun clic scripté attendu."); },
  getAttribute: (name) => name === "aria-label" ? label() : null,
  getBoundingClientRect: () => rectangle,
  contains: () => false
});
const playerButton = button(() => playerLabel, { left: 100, top: 700, width: 32, height: 32 });
const actionBarButton = button(() => pageLabel, { left: 200, top: 100, width: 56, height: 56 });
const rowButton = button(() => "Reproducir Never Gonna Give You Up", { left: 300, top: 400, width: 48, height: 48 });
const main = {
  querySelector(selector) {
    if (selector === '[data-testid="entityTitle"]' || selector === "h1") return { textContent: "Canción" };
    if (selector === '[data-testid="action-bar-row"] button[data-testid="play-button"]') return actionBarButton;
    return null;
  },
  querySelectorAll: (selector) => selector === 'button[data-testid="play-button"]' ? [rowButton, actionBarButton] : []
};
globalThis.location = { origin: "https://open.spotify.com" };
globalThis.window = { innerHeight: 900 };
globalThis.document = {
  elementFromPoint: (x) => x === 228 ? actionBarButton : playerButton,
  querySelector(selector) {
    if (selector === "main") return main;
    if (selector === '[data-testid="context-item-info-title"] a') return { textContent: "Canción" };
    if (selector === 'button[data-testid="control-button-playpause"]') return playerButton;
    if (selector === '[data-testid="playback-position"]') return { textContent: "0:00" };
    return null;
  },
  querySelectorAll: (selector) => selector === "audio" ? [{ paused: mediaPaused, ended: false }] : []
};

assert.equal(readTrackPlayButton("Canción").alreadyPlaying, false, "« Reproducir » signale un lecteur arrêté.");
const pageTarget = readTrackPlayButton("Canción", 0, "page");
assert.equal(pageTarget.x, 228, "Le gros bouton est trouvé dans la barre d'actions, pas parmi les recommandations.");
playerLabel = "Pausa";
assert.equal(readTrackPlayButton("Canción").alreadyPlaying, true, "« Pausa » signale une lecture en cours.");
playerLabel = "Reproducir";
pageLabel = "Pausa";
assert.equal(readTrackPlayButton("Canción", 0).alreadyPlaying, true);
pageLabel = "Reproducir";

// Le débogueur reçoit les libellés : la page Spotify ne les connaît pas.
const calls = [];
let reads = [{ ready: true, label: "Pausa", alreadyPlaying: true, positionSeconds: 3, x: 116, y: 716 },
  { ready: true, label: "Reproducir", alreadyPlaying: false, positionSeconds: 3, x: 116, y: 716 }];
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback) => { callback(); return 0; };
globalThis.chrome = {
  tabs: { get: async (tabId) => ({ id: tabId, url: "https://open.spotify.com/intl-es/track/x" }) },
  debugger: {
    attach: async () => {},
    detach: async () => {},
    async sendCommand(target, method, parameters) {
      calls.push([method, parameters]);
      if (method !== "Runtime.evaluate") return {};
      assert.match(parameters.expression, /"pausa"/, "Les libellés sont passés à la fonction évaluée.");
      return { result: { value: reads.shift() ?? { ready: true, label: "Reproducir", alreadyPlaying: false } } };
    }
  }
};
// Un bouton espagnol qui propose « Pausa » signale un morceau déjà lancé :
// aucun clic ne le remet en pause.
const started = await startTrackPlayback(42, "Canción");
assert.equal(started.alreadyPlaying, true);
assert.equal(calls.filter(([method]) => method === "Input.dispatchMouseEvent").length, 0);

// « Reproducir » : le lecteur est arrêté, un vrai clic lance le morceau.
calls.length = 0;
reads = [{ ready: true, label: "Reproducir", alreadyPlaying: false, positionSeconds: 0, x: 116, y: 716 },
  { ready: true, label: "Pausa", alreadyPlaying: true, positionSeconds: 1, x: 116, y: 716 }];
assert.equal((await startTrackPlayback(42, "Canción")).alreadyPlaying, true);
assert.equal(calls.filter(([method, parameters]) => method === "Input.dispatchMouseEvent" && parameters.type === "mousePressed").length, 1);globalThis.setTimeout = originalSetTimeout;
delete globalThis.chrome;
delete globalThis.document;
delete globalThis.window;
delete globalThis.location;

// Script de contenu : état du lecteur en espagnol, et repli sur l'élément audio
// pour un libellé inconnu.
let controlLabel = "Pausa";
const media = { paused: false, ended: false, currentTime: 30, duration: 200 };
const playerBar = { querySelector: () => null, querySelectorAll: () => [], innerText: "Canción\nArtista" };
const contentDocument = {
  title: "Canción - canción y letra de Artista | Spotify",
  querySelector(selector) {
    if (selector === '[data-testid="now-playing-bar"]') return playerBar;
    if (selector === '[data-testid="control-button-playpause"]') return { getAttribute: () => controlLabel };
    if (selector === '[data-testid="playback-position"]') return { textContent: "0:30" };
    if (selector === '[data-testid="playback-duration"]') return { textContent: "3:20" };
    if (selector === "main") return main;
    return null;
  },
  querySelectorAll: (selector) => selector === "audio" ? [media] : []
};
let listener;
vm.runInNewContext((await readFile(new URL("../spotify-player.js", import.meta.url), "utf8")) + "\n" +
  await readFile(new URL("../content.js", import.meta.url), "utf8"), {
  document: contentDocument,
  location: { href: "https://open.spotify.com/intl-es/track/x", pathname: "/intl-es/track/4cOdK2wGLETKBW3PvgPWqT" },
  chrome: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } }, sendMessage: async () => ({ ok: true }) } },
  setTimeout, setInterval() {}, clearInterval() {}
});
const snapshot = () => { let result; listener({ type: "GET_PLAYER_SNAPSHOT" }, {}, (value) => { result = value.snapshot; }); return result; };
assert.equal(snapshot().isPlaying, true, "« Pausa » : lecture en cours.");
controlLabel = "Reproducir";
assert.equal(snapshot().isPlaying, false, "« Reproducir » : lecteur arrêté, même si l'audio n'est pas encore figé.");
controlLabel = "Libellé inconnu";
assert.equal(snapshot().isPlaying, true, "Un libellé inconnu laisse l'élément audio décider.");
media.paused = true;
assert.equal(snapshot().isPlaying, false);

let pageState;
pageLabel = "Pausa";
listener({ type: "GET_PAGE_TRACK_STATE" }, {}, (value) => { pageState = value; });
assert.equal(pageState.canPlay, true);
assert.equal(pageState.isPlaying, true);
console.log("Langues : libellés lecture/pause de 69 langues Spotify, gros bouton par sa barre d'actions et repli audio vérifiés");
