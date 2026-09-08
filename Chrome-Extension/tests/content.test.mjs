import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

let messageListener;
let intervalCallback;
let endedCallback;
const sentMessages = [];
const clickOrder = [];
let playOnLoad = false;

const media = {
  currentTime: 0,
  duration: 180,
  ended: false,
  paused: true,
  addEventListener(type, callback) {
    if (type === "ended") endedCallback = callback;
  },
  async play() {
    this.paused = false;
  }
};

const bottomButton = {
  label: "Lecture",
  clicked: 0,
  click() {
    this.clicked += 1;
    clickOrder.push("bottom");
    const starting = media.paused;
    this.label = starting ? "Mettre en pause" : "Lecture";
    pageButton.label = starting ? "Mettre en pause" : "Lecture";
    media.paused = !starting;
  },
  getAttribute(name) {
    return name === "aria-label" ? this.label : null;
  },
  getClientRects() {
    return [{}];
  }
};

const bottomTitleElement = { textContent: "Ancien titre" };

const pageButton = {
  label: "Lecture",
  clicked: 0,
  click() {
    this.clicked += 1;
    clickOrder.push("page");
    if (bottomTitleElement.textContent === "Titre") {
      const starting = media.paused;
      this.label = starting ? "Mettre en pause" : "Lecture";
      bottomButton.label = starting ? "Mettre en pause" : "Lecture";
      media.paused = !starting;
    } else {
      bottomButton.label = "Lecture";
      media.paused = true;
      setTimeout(() => {
        bottomTitleElement.textContent = "Titre";
        if (playOnLoad) {
          this.label = "Mettre en pause";
          bottomButton.label = "Mettre en pause";
          media.paused = false;
        }
      }, 30);
    }
  },
  getAttribute(name) {
    return name === "aria-label" ? this.label : null;
  },
  getClientRects() {
    return [{}];
  }
};

const albumLink = { textContent: "Album", getAttribute: () => null };
const creatorLink = { textContent: "Artiste", getAttribute: () => null };
const titleElement = {
  textContent: "Titre",
  parentElement: null,
  querySelector(selector) {
    if (selector === 'a[href*="/album/"]') return albumLink;
    if (selector === '[data-testid="creator-link"]') return creatorLink;
    return null;
  }
};
const cover = {
  currentSrc: "https://i.scdn.co/image/cover",
  src: "https://i.scdn.co/image/cover",
  getBoundingClientRect() {
    return { width: 232, height: 232 };
  }
};
const main = {
  querySelector(selector) {
    if (selector === '[data-testid="entityTitle"]' || selector === "h1") return titleElement;
    if (selector === '[data-testid="creator-link"]') return creatorLink;
    return null;
  },
  querySelectorAll(selector) {
    if (selector === 'button[data-testid="play-button"]') return [pageButton];
    if (selector === "img") return [cover];
    return [];
  }
};

const document = {
  title: "Titre - titre et paroles par Artiste | Spotify",
  querySelector(selector) {
    if (selector === "main") return main;
    if (selector === '[data-testid="control-button-playpause"]') return bottomButton;
    if (selector === '[data-testid="context-item-info-title"] a') return bottomTitleElement;
    return null;
  },
  querySelectorAll(selector) {
    if (selector === "audio") return [media];
    return [];
  }
};

const chrome = {
  runtime: {
    onMessage: {
      addListener(listener) {
        messageListener = listener;
      }
    },
    sendMessage(message) {
      sentMessages.push(message);
      return Promise.resolve({ ok: true });
    }
  }
};

const source = await readFile(new URL("../content.js", import.meta.url), "utf8");
vm.runInNewContext(source, {
  chrome,
  document,
  location: {
    href: "https://open.spotify.com/track/5AfQGPbNnm165WVCrfPnHT",
    pathname: "/track/5AfQGPbNnm165WVCrfPnHT"
  },
  Promise,
  setInterval(callback) {
    intervalCallback = callback;
  },
  setTimeout
});

const prepareResponse = await new Promise((resolve) => {
  const asynchronous = messageListener({ type: "PREPARE_TRACK" }, {}, resolve);
  assert.equal(asynchronous, true);
});
assert.equal(prepareResponse.prepared, true);
assert.equal(pageButton.clicked, 1);
assert.equal(bottomButton.clicked, 0);
assert.deepEqual(clickOrder, ["page"]);

const playbackResponse = await new Promise((resolve) => {
  messageListener({ type: "START_PLAYBACK" }, {}, resolve);
});
assert.equal(playbackResponse.playing, true);
assert.equal(pageButton.clicked, 1);
assert.equal(bottomButton.clicked, 1);
assert.deepEqual(clickOrder, ["page", "bottom"]);

let pageStateResponse;
messageListener({ type: "GET_PAGE_TRACK_STATE" }, {}, (value) => {
  pageStateResponse = value;
});
assert.equal(pageStateResponse.metadata.title, "Titre");
assert.equal(pageStateResponse.metadata.artist, "Artiste");
assert.equal(pageStateResponse.metadata.album, "Album");
assert.equal(pageStateResponse.metadata.artworkUrl, "https://i.scdn.co/image/cover");

pageButton.label = "Lecture";
pageButton.disabled = true;
bottomButton.label = "Lecture";
bottomTitleElement.textContent = "Ancien titre";
media.paused = true;
setTimeout(() => {
  pageButton.disabled = false;
}, 50);
const delayedPrepareResponse = await new Promise((resolve) => {
  messageListener({ type: "PREPARE_TRACK" }, {}, resolve);
});
assert.equal(delayedPrepareResponse.prepared, true);
assert.equal(pageButton.clicked, 2);
assert.equal(bottomButton.clicked, 1);
assert.deepEqual(clickOrder, ["page", "bottom", "page"]);

pageButton.label = "Lecture";
bottomButton.label = "Lecture";
bottomTitleElement.textContent = "Titre";
media.paused = true;
const stablePlaybackResponse = await new Promise((resolve) => {
  messageListener({ type: "START_PLAYBACK" }, {}, resolve);
});
assert.equal(stablePlaybackResponse.playing, true);
assert.equal(pageButton.clicked, 2);
assert.equal(bottomButton.clicked, 2);
assert.deepEqual(clickOrder, ["page", "bottom", "page", "bottom"]);

pageButton.label = "Lecture";
bottomButton.label = "Lecture";
bottomTitleElement.textContent = "Ancien titre";
media.paused = true;
playOnLoad = true;
const autoStartedPrepareResponse = await new Promise((resolve) => {
  messageListener({ type: "PREPARE_TRACK" }, {}, resolve);
});
assert.equal(autoStartedPrepareResponse.prepared, true);
assert.equal(pageButton.clicked, 4);
assert.equal(bottomButton.clicked, 2);
assert.equal(bottomButton.label, "Lecture");
assert.equal(media.paused, true);
assert.deepEqual(clickOrder, ["page", "bottom", "page", "bottom", "page", "page"]);
playOnLoad = false;

pageButton.label = "Lecture";
bottomButton.label = "Lecture";
media.paused = true;
const wrongTrackPlaybackResponse = await new Promise((resolve) => {
  messageListener({ type: "START_PLAYBACK", expectedTitle: "Autre titre" }, {}, resolve);
});
assert.equal(wrongTrackPlaybackResponse.playing, false);
assert.equal(pageButton.clicked, 4);
assert.equal(bottomButton.clicked, 2);

media.paused = true;
media.ended = true;
media.currentTime = 180;
let snapshotResponse;
messageListener({ type: "GET_PLAYER_SNAPSHOT" }, {}, (value) => {
  snapshotResponse = value;
});
assert.equal(snapshotResponse.snapshot.ended, true);
assert.equal(snapshotResponse.snapshot.durationSeconds, 180);

intervalCallback();
assert.equal(typeof endedCallback, "function");
endedCallback();
assert.ok(sentMessages.some((message) => message.type === "PLAYER_ENDED"));

chrome.runtime.sendMessage = () => {
  throw new Error("Extension context invalidated.");
};
media.ended = false;
media.paused = false;
media.currentTime = 1;
assert.doesNotThrow(() => intervalCallback());
assert.doesNotThrow(() => endedCallback());

console.log("Tests lecture et fin du lecteur réussis");
