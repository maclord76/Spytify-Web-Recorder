import assert from "node:assert/strict";
import {
  readTrackPlayButton,
  rewindTrackPlayback,
  startTrackPlayback
} from "../player-control.js";

let label = "Lecture";
let playbackPosition = "0:00";
let pageTitle = "Titre test";
let pageLabel = "Lecture";
let playerTitle = "Titre test";
const media = { paused: true, ended: false };
const playerButton = {
  disabled: false,
  click() {
    throw new Error("La lecture du player ne doit jamais cliquer par script.");
  },
  getAttribute(name) {
    if (name === "aria-label") return label;
    if (name === "aria-disabled") return "false";
    return null;
  },
  getClientRects() {
    return [{}];
  },
  getBoundingClientRect() {
    return { left: 100, top: 700, width: 32, height: 32 };
  }
};
const pageButton = {
  ...playerButton,
  getAttribute(name) {
    return name === "aria-label" ? pageLabel : null;
  },
  getBoundingClientRect() {
    return { left: 200, top: 100, width: 56, height: 56 };
  }
};

const main = {
  querySelectorAll(selector) {
    return selector === 'button[data-testid="play-button"]' ? [pageButton] : [];
  },
  querySelector(selector) {
    if (selector === '[data-testid="entityTitle"]' || selector === "h1") {
      return { textContent: pageTitle };
    }
    return null;
  }
};

globalThis.window = { innerHeight: 900 };
globalThis.location = { origin: "https://open.spotify.com" };
globalThis.document = {
  elementFromPoint(x) {
    return x === 228 ? pageButton : playerButton;
  },
  querySelector(selector) {
    if (selector === "main") return main;
    if (selector === '[data-testid="context-item-info-title"] a') {
      return { textContent: playerTitle };
    }
    if (selector === 'button[data-testid="control-button-playpause"]') {
      return playerButton;
    }
    if (selector === '[data-testid="playback-position"]') {
      return { textContent: playbackPosition };
    }
    return null;
  },
  querySelectorAll(selector) {
    return selector === "audio" ? [media] : [];
  }
};

const arret = readTrackPlayButton("Titre test");
assert.deepEqual(arret, {
  ready: true,
  label: "Lecture",
  alreadyPlaying: false,
  positionSeconds: 0,
  x: 116,
  y: 716,
  innerHeight: 900,
  cibleAtteinte: true,
  hasBeenActive: null
});

const pageFallback = readTrackPlayButton("Titre test", 0, "page");
assert.equal(pageFallback.ready, true);
assert.equal(pageFallback.x, 228);
assert.equal(pageFallback.y, 128);
assert.equal(pageFallback.cibleAtteinte, true);
pageLabel = "Pause";
assert.equal(readTrackPlayButton("Titre test", 0).alreadyPlaying, true,
  "Le gros bouton signale aussi une lecture en cours : ne pas la couper si le bouton inférieur est en retard.");
pageLabel = "Lecture";
pageButton.disabled = true;
assert.deepEqual(readTrackPlayButton("Titre test", 0, "page"), { ready: false, reason: "button" });
pageButton.disabled = false;

label = "Mettre en pause";
assert.equal(
  readTrackPlayButton("Titre test").alreadyPlaying,
  true,
  "un libellé de pause signale une lecture en cours"
);

label = "Lecture";
pageTitle = "Autre titre";
assert.deepEqual(readTrackPlayButton("Titre test"), { ready: false, reason: "title" });
pageTitle = "Titre test";

media.paused = false;
assert.equal(
  readTrackPlayButton("Titre test", 0).alreadyPlaying,
  true,
  "un libellé Lecture en retard ne doit pas faire croire à un arrêt"
);

media.paused = true;
playbackPosition = "0:02";
assert.equal(
  readTrackPlayButton("Titre test", 0).alreadyPlaying,
  true,
  "une position qui avance prouve que la lecture a démarré"
);
playbackPosition = "0:00";

// Le lecteur inférieur affiche encore un autre titre : seul le gros bouton de la
// page peut lancer le morceau, et seul son libellé dit s'il est déjà lancé.
playerTitle = "Titre précédent";
label = "Mettre en pause";
media.paused = false;
assert.deepEqual(readTrackPlayButton("Titre test"), { ready: false, reason: "title" });
assert.equal(readTrackPlayButton("Titre test", 0, "page").ready, true);
assert.equal(readTrackPlayButton("Titre test", 0, "page").alreadyPlaying, false,
  "La lecture d'un autre titre ne fait pas croire que le morceau demandé joue.");
pageLabel = "Pause";
assert.equal(readTrackPlayButton("Titre test", 0, "page").alreadyPlaying, true);
pageLabel = "Lecture";
label = "Lecture";
media.paused = true;
playerTitle = "Titre test";

// Une page qui n'est plus Spotify ne fournit jamais de cible de clic.
globalThis.location = { origin: "https://example.com" };
assert.deepEqual(readTrackPlayButton("Titre test"), { ready: false, reason: "origin" });

delete globalThis.document;
delete globalThis.window;
delete globalThis.location;

const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback) => {
  callback();
  return 0;
};

function installDebugger(readStates, tabUrl = "https://open.spotify.com/track/test") {
  const calls = [];
  let reads = 0;
  globalThis.chrome = {
    tabs: {
      async get(tabId) {
        calls.push(["tabs.get", tabId]);
        return { id: tabId, url: tabUrl };
      }
    },
    debugger: {
      async attach(target, version) {
        calls.push(["attach", target, version]);
      },
      async sendCommand(target, method, parameters) {
        calls.push(["sendCommand", method, parameters]);
        if (method !== "Runtime.evaluate") return {};
        if (parameters.expression.includes(".click()")) return { result: { value: undefined } };
        if (parameters.expression.includes("slider.focus()")) return { result: { value: true } };
        reads += 1;
        const state = readStates[Math.min(reads - 1, readStates.length - 1)];
        return { result: { value: state } };
      },
      async detach(target) {
        calls.push(["detach", target]);
      }
    }
  };
  return calls;
}

const enArret = {
  ready: true,
  label: "Lecture",
  alreadyPlaying: false,
  positionSeconds: 0,
  x: 116,
  y: 716,
  innerHeight: 844,
  cibleAtteinte: true
};
const enLecture = { ready: true, label: "Pause", alreadyPlaying: true, positionSeconds: 1, x: 116, y: 716 };

// Régression du bug réel : Spotify ignore un element.click() injecté car
// l'activation utilisateur de Runtime.evaluate expire avant son play() asynchrone.
// La lecture doit donc partir d'un véritable événement d'entrée.
{
  const calls = installDebugger([enArret, enLecture]);
  const resultat = await startTrackPlayback(42, "Titre test");

  assert.deepEqual(resultat, {
    attempted: true,
    alreadyPlaying: true,
    positionSeconds: 1,
    clicks: [{ cible: "player", x: 116, y: 716, cibleAtteinte: true }]
  });
  assert.deepEqual(calls[0], ["tabs.get", 42]);
  assert.deepEqual(calls[1], ["attach", { tabId: 42 }, "1.3"]);
  assert.deepEqual(calls.at(-1), ["detach", { tabId: 42 }]);

  const entrees = calls.filter((call) => call[1] === "Input.dispatchMouseEvent");
  assert.deepEqual(
    entrees.map((call) => call[2].type),
    ["mouseMoved", "mousePressed", "mouseReleased"],
    "un seul vrai clic doit être envoyé quand la lecture démarre"
  );
  for (const entree of entrees) {
    assert.equal(entree[2].x, 116);
    assert.equal(entree[2].y, 716);
    assert.equal(entree[2].button, "left");
  }
}

// Spotify a lancé le morceau de lui-même : aucun clic ne doit le mettre en pause.
{
  const calls = installDebugger([enLecture]);
  const resultat = await startTrackPlayback(42, "Titre test");
  assert.deepEqual(resultat, { attempted: true, alreadyPlaying: true, positionSeconds: 1, clicks: [] });
  assert.equal(calls.filter((call) => call[1] === "Input.dispatchMouseEvent").length, 0);
}

// Régression du log 1.15.3 : le clic atteint le lecteur inférieur, qui reste à
// 0:00. Le repli doit utiliser un vrai clic sur le bouton du morceau.
{
  const enArretPage = { ...enArret, x: 228, y: 128 };
  const calls = installDebugger([...Array(7).fill(enArret), enArretPage, enLecture]);
  const resultat = await startTrackPlayback(42, "Titre test");

  assert.equal(resultat.alreadyPlaying, true);
  assert.deepEqual(resultat.clicks, [
    { cible: "player", x: 116, y: 716, cibleAtteinte: true },
    { cible: "page", x: 228, y: 128, cibleAtteinte: true }
  ]);

  const pressions = calls.filter(
    (call) => call[1] === "Input.dispatchMouseEvent" && call[2].type === "mousePressed"
  );
  assert.equal(pressions.length, 2);
  assert.equal(pressions[1][2].y, 128, "Le second clic vise le bouton du morceau.");

  const clicsScriptes = calls.filter(
    (call) => call[1] === "Runtime.evaluate" && call[2].expression.includes(".click()")
  );
  assert.equal(clicsScriptes.length, 0, "Le repli envoie aussi un vrai événement d'entrée.");
  const probes = calls.filter((call) => call[1] === "Runtime.evaluate");
  assert.match(probes[7][2].expression,
    /, "page", \{"labels":\{"pause":\[.*"pausa".*\],"play":\[.*"reproducir".*\]\},"titleSelectors":\[.*context-item-info-title.*\]\}\)$/);
}

// Un démarrage différé constaté avant le repli ne doit jamais être remis en pause.
{
  const calls = installDebugger([...Array(7).fill(enArret), enLecture]);
  const resultat = await startTrackPlayback(42, "Titre test");
  assert.equal(resultat.clicks.length, 1);
  assert.equal(resultat.alreadyPlaying, true);
  assert.equal(calls.filter((call) => call[1] === "Input.dispatchMouseEvent" && call[2].type === "mousePressed").length, 1);
}

// Refuser le repli si le titre change, si le bouton disparaît ou s'il est masqué.
for (const blocked of [{ ready: false, reason: "title" }, { ready: false, reason: "button" }, { ...enArret, cibleAtteinte: false }]) {
  const calls = installDebugger([...Array(7).fill(enArret), blocked]);
  const resultat = await startTrackPlayback(42, "Titre test");
  assert.equal(resultat.clicks.length, 1);
  assert.equal(resultat.alreadyPlaying, false);
  assert.equal(calls.filter((call) => call[1] === "Input.dispatchMouseEvent" && call[2].type === "mousePressed").length, 1);
  assert.deepEqual(calls.at(-1), ["detach", { tabId: 42 }]);
}

// Après le chargement de la page, le lecteur inférieur affiche souvent le titre
// écouté précédemment : le gros bouton de la page lance le morceau demandé.
{
  const calls = installDebugger([{ ready: false, reason: "title" }, { ...enArret, x: 228, y: 128 }, enLecture]);
  const resultat = await startTrackPlayback(42, "Titre test");
  assert.equal(resultat.alreadyPlaying, true);
  assert.deepEqual(resultat.clicks, [{ cible: "page", x: 228, y: 128, cibleAtteinte: true }]);
  const probes = calls.filter((call) => call[1] === "Runtime.evaluate");
  assert.match(probes[1][2].expression, /, "page", /);
}

// Une page qui n'affiche pas le morceau attendu ne doit jamais être cliquée.
for (const states of [[{ ready: false, reason: "title" }], [{ ready: false, reason: "origin" }]]) {
  const calls = installDebugger(states);
  const resultat = await startTrackPlayback(42, "Titre test");
  assert.equal(resultat.attempted, false);
  assert.equal(resultat.alreadyPlaying, false);
  assert.equal(
    calls.filter((call) => call[1] === "Input.dispatchMouseEvent").length,
    0,
    "aucun clic ne doit partir sur une page qui affiche un autre morceau"
  );
}
// Une pause à quelques secondes du début doit être ramenée à zéro avant capture.
{
  const enArretAvance = { ...enArret, positionSeconds: 4 };
  const calls = installDebugger([enArretAvance, enArretAvance, enArret]);
  assert.deepEqual(await rewindTrackPlayback(42, "Titre test"), { reset: true });
  const keys = calls.filter((call) => call[1] === "Input.dispatchKeyEvent");
  assert.deepEqual(keys.map((call) => call[2].type), ["keyDown", "keyUp"]);
  assert.ok(keys.every((call) => call[2].key === "Home"));
  assert.deepEqual(calls.at(-1), ["detach", { tabId: 42 }]);
}
for (const state of [enLecture, { ready: false, reason: "title" }, enArret]) {
  const calls = installDebugger([state]);
  const result = await rewindTrackPlayback(42, "Titre test");
  assert.equal(result.reset, state === enArret);
  assert.equal(calls.filter((call) => call[1] === "Input.dispatchKeyEvent").length, 0);
}

// Le débogueur n'est jamais attaché à un onglet qui a quitté Spotify Web.
for (const action of [startTrackPlayback, rewindTrackPlayback]) {
  for (const tabUrl of ["https://example.com/", "https://open.spotify.com.example.com/", null]) {
    const calls = installDebugger([enArret], tabUrl);
    await assert.rejects(action(42, "Titre test"), /n'affiche plus Spotify/);
    assert.equal(calls.some((call) => call[0] === "attach"), false);
    assert.equal(calls.some((call) => call[0] === "sendCommand"), false);
  }
}

delete globalThis.chrome;
globalThis.setTimeout = originalSetTimeout;
console.log("Tests bouton du player réussis");
