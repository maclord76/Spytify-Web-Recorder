import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

let messageListener;
let intervalCallback;
let endedCallback;
const sentMessages = [];
const clickOrder = [];
let playOnLoad = false;
let playerArtists = [];
let progressSlider = null;

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
    if (selector === '[data-testid="playback-progressbar"] input[type="range"]') return progressSlider;
    if (selector === '[data-testid="playback-position"]') return { textContent: "0:14" };
    if (selector === '[data-testid="playback-duration"]') return { textContent: "3:00" };
    return null;
  },
  querySelectorAll(selector) {
    if (selector === "audio") return [media];
    if (selector === '[data-testid="now-playing-widget"] a[data-testid="context-item-info-artist"]') return playerArtists;
    return [];
  }
};

// Métadonnées publiées par Spotify pour les commandes multimédias de Chrome.
const navigator = { mediaSession: { metadata: null } };

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
  },
  // Une session est active : le script observe le lecteur.
  storage: {
    local: { get: async () => ({ playerObservation: true }) },
    onChanged: { addListener() {} }
  }
};

// spotify-player.js est chargé avant content.js, comme dans le manifeste.
const source = (await readFile(new URL("../spotify-player.js", import.meta.url), "utf8")) + "\n" +
  await readFile(new URL("../content.js", import.meta.url), "utf8");
vm.runInNewContext(source, {
  chrome,
  document,
  navigator,
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

// La page du morceau fournit ses métadonnées dès que son bouton est utilisable,
// sans jamais cliquer : le lancement est décidé par le service de fond.
const readyResponse = await new Promise((resolve) => {
  const asynchronous = messageListener({ type: "WAIT_PAGE_TRACK_READY", timeoutMilliseconds: 500 }, {}, resolve);
  assert.equal(asynchronous, true);
});
assert.equal(readyResponse.ready, true);
assert.equal(readyResponse.metadata.title, "Titre");
assert.equal(readyResponse.isPlaying, false);
assert.deepEqual(clickOrder, [], "Le script de contenu ne pilote plus le lecteur.");

// L'ancien parcours en trois étapes n'a plus de commande dans la page.
for (const type of ["PREPARE_TRACK", "START_PLAYBACK", "CONFIRM_TRACK_PAUSED"]) {
  let answered = false;
  assert.notEqual(messageListener({ type }, {}, () => { answered = true; }), true);
  assert.equal(answered, false, `${type} n'est plus traité`);
}
let pageStateResponse;
messageListener({ type: "GET_PAGE_TRACK_STATE" }, {}, (value) => {
  pageStateResponse = value;
});
assert.equal(pageStateResponse.metadata.title, "Titre");
assert.equal(pageStateResponse.metadata.artist, "Artiste");
assert.equal(pageStateResponse.metadata.album, "Album");
assert.equal(pageStateResponse.metadata.artworkUrl, "https://i.scdn.co/image/cover");

// Les pages playlist ne fournissent pas l'artiste dans document.title. Le
// testid se trouve sur le lien lui-même dans le player Spotify actuel.
document.title = "Ma playlist | Spotify";
playerArtists = [{ textContent: "Artiste A" }, { textContent: "Artiste B" }, { textContent: "Artiste A" }];
progressSlider = { max: "180000", value: "14250" };
media.currentTime = 0;
media.duration = NaN;
let playlistSnapshot;
messageListener({ type: "GET_PLAYER_SNAPSHOT" }, {}, value => { playlistSnapshot = value.snapshot; });
assert.equal(playlistSnapshot.metadata.artist, "Artiste A, Artiste B");
assert.equal(playlistSnapshot.positionSeconds, 14.25);
assert.equal(playlistSnapshot.positionSource, "progress");
assert.equal(playlistSnapshot.durationSeconds, 180);
assert.ok(Number.isFinite(playlistSnapshot.observedAtMs));
// Barre arrondie par pas de 5 s (« 15 » pour 14 s affichées) : le texte prime.
progressSlider = { max: "180000", value: "15000" };
messageListener({ type: "GET_PLAYER_SNAPSHOT" }, {}, value => { playlistSnapshot = value.snapshot; });
assert.equal(playlistSnapshot.positionSeconds, 14, "Une barre plus grossière que le texte ne le contredit pas.");
assert.equal(playlistSnapshot.positionSource, "text");
progressSlider = { max: "1", value: "0.5" };
messageListener({ type: "GET_PLAYER_SNAPSHOT" }, {}, value => { playlistSnapshot = value.snapshot; });
assert.equal(playlistSnapshot.positionSeconds, 14, "Une unité inconnue conserve la progression affichée.");
document.title = "Titre - titre et paroles par Artiste | Spotify";
playerArtists = [];
progressSlider = null;
media.duration = 180;

// Lecteur inférieur sans data-testid de titre ni d'artiste, morceau en pause :
// l'onglet ne nomme plus que la page (« Emerald Rush », 23 octobre 2026). Les
// métadonnées multimédias publiées par Spotify identifient encore le morceau.
document.title = "Recherchez des Jon Hopkins Emerald Rush | Spotify";
bottomTitleElement.textContent = "";
navigator.mediaSession.metadata = {
  title: "Emerald Rush", artist: "Jon Hopkins", album: "Singularity",
  artwork: [
    { src: "https://i.scdn.co/image/64", sizes: "64x64" },
    { src: "https://i.scdn.co/image/640", sizes: "640x640" },
    { src: "https://i.scdn.co/image/300", sizes: "300x300" }
  ]
};
let sessionSnapshot;
messageListener({ type: "GET_PLAYER_SNAPSHOT" }, {}, (value) => { sessionSnapshot = value.snapshot; });
assert.deepEqual({ ...sessionSnapshot.metadata }, {
  title: "Emerald Rush", artist: "Jon Hopkins", album: "Singularity", artworkUrl: "https://i.scdn.co/image/640"
});
assert.equal(sessionSnapshot.hasTrackMetadata, true);
assert.equal(sessionSnapshot.isAdvertisement, false);
// Pour une annonce, Spotify publie son libellé traduit, sans artiste.
navigator.mediaSession.metadata = { title: "Publicité", artist: "", album: "", artwork: [] };
messageListener({ type: "GET_PLAYER_SNAPSHOT" }, {}, (value) => { sessionSnapshot = value.snapshot; });
assert.equal(sessionSnapshot.isAdvertisement, true);
assert.equal(sessionSnapshot.hasTrackMetadata, false);
navigator.mediaSession.metadata = null;
bottomTitleElement.textContent = "Ancien titre";
document.title = "Titre - titre et paroles par Artiste | Spotify";

// Un bouton de page encore désactivé retarde la disponibilité du morceau.
pageButton.disabled = true;
setTimeout(() => {
  pageButton.disabled = false;
}, 50);
const delayedReadyResponse = await new Promise((resolve) => {
  messageListener({ type: "WAIT_PAGE_TRACK_READY", timeoutMilliseconds: 2000 }, {}, resolve);
});
assert.equal(delayedReadyResponse.ready, true);
assert.deepEqual(clickOrder, []);
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
