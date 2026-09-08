import assert from "node:assert/strict";
import {
  clickPreparedPlayerButton,
  startPreparedPlayerPlayback
} from "../player-control.js";

let clicked = 0;
let focused = 0;
let label = "Lecture";
let playbackPosition = "0:00";
const media = { paused: true, ended: false };
const playerButton = {
  disabled: false,
  click() {
    clicked += 1;
    label = "Mettre en pause";
  },
  focus() {
    focused += 1;
  },
  getAttribute(name) {
    if (name === "aria-label") return label;
    if (name === "aria-disabled") return "false";
    return null;
  },
  getClientRects() {
    return [{}];
  }
};

const main = {
  querySelector(selector) {
    if (selector === '[data-testid="entityTitle"]' || selector === "h1") {
      return { textContent: "Titre test" };
    }
    return null;
  }
};

globalThis.document = {
  querySelector(selector) {
    if (selector === "main") return main;
    if (selector === '[data-testid="context-item-info-title"] a') {
      return { textContent: "Titre test" };
    }
    if (selector === 'button[data-testid="control-button-playpause"]') {
      return playerButton;
    }
    if (selector === '[data-testid="playback-position"]') {
      return { textContent: playbackPosition };
    }
    if (selector === 'button[data-testid="play-button"]') {
      throw new Error("Le gros bouton de page ne doit jamais être ciblé à l'étape 3.");
    }
    return null;
  },
  querySelectorAll(selector) {
    return selector === "audio" ? [media] : [];
  }
};

const started = clickPreparedPlayerButton("Titre test");
assert.deepEqual(started, { attempted: true, alreadyPlaying: false, positionSeconds: 0 });
assert.equal(clicked, 1);
assert.equal(focused, 1);

const alreadyPlaying = clickPreparedPlayerButton("Titre test");
assert.deepEqual(alreadyPlaying, { attempted: true, alreadyPlaying: true, positionSeconds: 0 });
assert.equal(clicked, 1);

const wrongTitle = clickPreparedPlayerButton("Autre titre");
assert.deepEqual(wrongTitle, { attempted: false, reason: "title" });
assert.equal(clicked, 1);

label = "Lecture";
media.paused = false;
const staleLabel = clickPreparedPlayerButton("Titre test", 0);
assert.deepEqual(staleLabel, { attempted: true, alreadyPlaying: true, positionSeconds: 0 });
assert.equal(clicked, 1, "un libellé Lecture en retard ne doit pas remettre Spotify en pause");

media.paused = true;
playbackPosition = "0:02";
const advancing = clickPreparedPlayerButton("Titre test", 0);
assert.deepEqual(advancing, { attempted: true, alreadyPlaying: true, positionSeconds: 2 });
assert.equal(clicked, 1, "une position qui avance prouve que le premier clic a fonctionné");

delete globalThis.document;

const debuggerCalls = [];
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback) => {
  callback();
  return 0;
};
globalThis.chrome = {
  debugger: {
    async attach(target, version) {
      debuggerCalls.push(["attach", target, version]);
    },
    async sendCommand(target, method, parameters) {
      debuggerCalls.push(["sendCommand", target, method, parameters]);
      return { result: { value: { attempted: true, alreadyPlaying: false } } };
    },
    async detach(target) {
      debuggerCalls.push(["detach", target]);
    }
  }
};

const debuggerResult = await startPreparedPlayerPlayback(42, "Titre test");
assert.deepEqual(debuggerResult, { attempted: true, alreadyPlaying: false, attempts: 2 });
assert.deepEqual(debuggerCalls[0], ["attach", { tabId: 42 }, "1.3"]);
assert.equal(debuggerCalls[1][0], "sendCommand");
assert.equal(debuggerCalls[1][2], "Runtime.evaluate");
assert.equal(debuggerCalls[1][3].userGesture, true);
assert.equal(debuggerCalls[1][3].returnByValue, true);
assert.match(debuggerCalls[1][3].expression, /control-button-playpause/);
assert.equal(debuggerCalls[2][0], "sendCommand");
assert.equal(debuggerCalls[2][2], "Runtime.evaluate");
assert.equal(debuggerCalls[2][3].userGesture, true);
assert.deepEqual(debuggerCalls[3], ["detach", { tabId: 42 }]);

let commandNumber = 0;
globalThis.chrome.debugger.sendCommand = async () => {
  commandNumber += 1;
  return commandNumber === 1
    ? { result: { value: { attempted: true, alreadyPlaying: false, positionSeconds: 0 } } }
    : { result: { value: { attempted: false, reason: "title" } } };
};
const transientDomResult = await startPreparedPlayerPlayback(42, "Titre test");
assert.deepEqual(
  transientDomResult,
  { attempted: true, alreadyPlaying: false, positionSeconds: 0, attempts: 2 },
  "une seconde sonde DOM transitoirement vide ne doit pas annuler le premier clic"
);

delete globalThis.chrome;
globalThis.setTimeout = originalSetTimeout;
console.log("Tests bouton du player réussis");
