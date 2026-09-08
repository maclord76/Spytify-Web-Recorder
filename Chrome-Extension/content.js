function firstText(selectors) {
  for (const selector of selectors) {
    const value = document.querySelector(selector)?.textContent?.trim();
    if (value) return value;
  }
  return "";
}

function sendRuntimeMessage(message) {
  try {
    const response = chrome.runtime?.sendMessage(message);
    response?.catch?.(() => {});
  } catch {
    // L'ancien script peut survivre dans l'onglet après le rechargement de
    // l'extension. Son contexte n'est alors plus valide et doit rester silencieux.
  }
}

function allTexts(selectors) {
  for (const selector of selectors) {
    const values = [...document.querySelectorAll(selector)]
      .map((element) => element.textContent?.trim())
      .filter(Boolean);
    if (values.length) return [...new Set(values)].join(", ");
  }
  return "";
}

function metadataFromDocumentTitle() {
  const title = document.title.replace(/\s*\|\s*Spotify\s*$/i, "");
  const patterns = [
    /^(.+?)\s+-\s+(?:song and lyrics by|titre et paroles par)\s+(.+)$/i,
    /^(.+?)\s+•\s+(.+)$/
  ];
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) return { title: match[1].trim(), artist: match[2].trim() };
  }
  return { title: "", artist: "" };
}

function pageTrackPlayButton() {
  const main = document.querySelector("main");
  const buttons = [...(main?.querySelectorAll('button[data-testid="play-button"]') || [])];
  const pageButtons = buttons.filter((button) =>
    /^(lecture|play|pause|mettre en pause)$/i.test(button.getAttribute("aria-label")?.trim() || "")
  );
  return pageButtons.find((button) => button.getClientRects?.().length > 0) || null;
}

function isButtonClickable(button) {
  return Boolean(
    button &&
    button.getClientRects?.().length > 0 &&
    !button.disabled &&
    button.getAttribute("aria-disabled") !== "true"
  );
}

async function waitForPageTrackReady(timeoutMilliseconds = 8000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let metadata = null;
  while (Date.now() < deadline) {
    const button = pageTrackPlayButton();
    metadata = pageTrackMetadata();
    if (metadata?.title && isButtonClickable(button)) {
      return { ready: true, button, metadata };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { ready: false, button: null, metadata };
}

function pageTrackMetadata() {
  if (!/^\/(?:intl-[^/]+\/)?track\/[A-Za-z0-9]{22}\/?$/.test(location.pathname)) {
    return null;
  }

  const main = document.querySelector("main");
  const titleElement = main?.querySelector('[data-testid="entityTitle"]') || main?.querySelector("h1");
  const title = titleElement?.textContent?.trim() || "";
  if (!title) return null;

  const documentMetadata = metadataFromDocumentTitle();
  let header = titleElement;
  for (let depth = 0; depth < 5 && header?.parentElement; depth += 1) {
    if (header.querySelector?.('a[href*="/album/"]')) break;
    header = header.parentElement;
  }
  const creator = header?.querySelector?.('[data-testid="creator-link"]')
    || main?.querySelector('[data-testid="creator-link"]');
  const albumLink = header?.querySelector?.('a[href*="/album/"]');
  const cover = [...(main?.querySelectorAll("img") || [])].find((image) => {
    const rectangle = image.getBoundingClientRect?.();
    return rectangle && rectangle.width >= 160 && rectangle.height >= 160;
  });

  return {
    title,
    artist: documentMetadata.artist || creator?.textContent?.trim() || "",
    album: albumLink?.textContent?.trim() || "",
    artworkUrl: cover?.currentSrc || cover?.src || ""
  };
}

function parseTime(value) {
  const parts = String(value || "").trim().split(":").map(Number);
  if (!parts.length || parts.some(Number.isNaN)) return 0;
  return parts.reduce((seconds, part) => seconds * 60 + part, 0);
}

function playbackMediaElement() {
  // Spotify utilise aussi des vidéos décoratives (Canvas) qui peuvent jouer
  // alors que le morceau est en pause. Elles ne doivent jamais servir d'état
  // au lecteur audio.
  const elements = [...document.querySelectorAll("audio")];
  return elements.find((element) => !element.paused && !element.ended)
    || elements.find((element) => Number.isFinite(element.duration) && element.duration > 0)
    || null;
}

function normalizeTrackTitle(value) {
  return String(value || "").normalize("NFC").trim().toLocaleLowerCase("fr");
}

function bottomPlayerState() {
  const button = document.querySelector('[data-testid="control-button-playpause"]');
  const title = firstText([
    '[data-testid="context-item-info-title"] a',
    '[data-testid="now-playing-widget"] [data-testid="context-item-link"]',
    '[data-testid="context-item-link"]'
  ]);
  const label = button?.getAttribute("aria-label") || "";
  const media = playbackMediaElement();
  return {
    button,
    title,
    isPlaying: button
      ? /pause|mettre en pause/i.test(label)
      : Boolean(media && !media.paused && !media.ended)
  };
}

async function waitForBottomTrack(expectedTitle, timeoutMilliseconds = 8000) {
  const normalizedExpectedTitle = normalizeTrackTitle(expectedTitle);
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const state = bottomPlayerState();
    if (
      normalizedExpectedTitle &&
      normalizeTrackTitle(state.title) === normalizedExpectedTitle &&
      isButtonClickable(state.button)
    ) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function waitForBottomPlayback(expectedTitle, timeoutMilliseconds = 5000) {
  const normalizedExpectedTitle = normalizeTrackTitle(expectedTitle);
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const state = bottomPlayerState();
    if (
      normalizeTrackTitle(state.title) === normalizedExpectedTitle &&
      state.isPlaying
    ) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function ensurePreparedTrackPaused(expectedTitle, timeoutMilliseconds = 3000) {
  let state = bottomPlayerState();
  if (normalizeTrackTitle(state.title) !== normalizeTrackTitle(expectedTitle)) return false;
  if (!state.isPlaying) return true;

  const pageButton = pageTrackPlayButton();
  const pageLabel = pageButton?.getAttribute("aria-label") || "";
  if (!isButtonClickable(pageButton) || !/pause|mettre en pause/i.test(pageLabel)) {
    return false;
  }
  pageButton.click();

  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    state = bottomPlayerState();
    if (
      normalizeTrackTitle(state.title) === normalizeTrackTitle(expectedTitle) &&
      !state.isPlaying
    ) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function playerSnapshot() {
  const fallback = metadataFromDocumentTitle();
  const title = firstText([
    '[data-testid="context-item-info-title"] a',
    '[data-testid="now-playing-widget"] [data-testid="context-item-link"]',
    '[data-testid="context-item-link"]'
  ]) || fallback.title;
  const artist = allTexts([
    '[data-testid="context-item-info-artist"] a',
    '[data-testid="now-playing-widget"] [data-testid="context-item-info-artist"] a'
  ]) || fallback.artist;
  const album = firstText([
    '[data-testid="context-item-info-album"] a',
    'a[href*="/album/"][data-testid]'
  ]);
  const artwork = document.querySelector(
    '[data-testid="cover-art-image"], [data-testid="now-playing-widget"] img'
  );
  const playPause = document.querySelector('[data-testid="control-button-playpause"]');
  const controlLabel = playPause?.getAttribute("aria-label") || "";
  const media = playbackMediaElement();
  const domPosition = parseTime(firstText(['[data-testid="playback-position"]']));
  const domDuration = parseTime(firstText(['[data-testid="playback-duration"]']));
  const positionSeconds = Number.isFinite(media?.currentTime) && media.currentTime > 0
    ? media.currentTime
    : domPosition;
  const durationSeconds = Number.isFinite(media?.duration) && media.duration > 0
    ? media.duration
    : domDuration;
  const isPlaying = media
    ? !media.paused && !media.ended
    : /pause|mettre en pause/i.test(controlLabel);

  return {
    metadata: {
      title,
      artist,
      album,
      artworkUrl: artwork?.currentSrc || artwork?.src || ""
    },
    positionSeconds,
    durationSeconds,
    isPlaying,
    ended: Boolean(media?.ended) || (
      durationSeconds > 0 &&
      positionSeconds >= durationSeconds - 0.25 &&
      !isPlaying
    ),
    pageUrl: location.href
  };
}

async function startPlayback(requestedTitle = "") {
  const ready = await waitForPageTrackReady();
  if (!ready.ready) return false;
  if (
    requestedTitle &&
    normalizeTrackTitle(ready.metadata.title) !== normalizeTrackTitle(requestedTitle)
  ) {
    return false;
  }

  const expectedTitle = ready.metadata.title;
  let currentBottomState = bottomPlayerState();
  if (
    normalizeTrackTitle(currentBottomState.title) === normalizeTrackTitle(expectedTitle) &&
    currentBottomState.isPlaying
  ) {
    return true;
  }

  currentBottomState = await waitForBottomTrack(expectedTitle);
  if (!currentBottomState || !isButtonClickable(currentBottomState.button)) return false;
  const playerLabel = currentBottomState.button.getAttribute("aria-label") || "";
  if (/pause|mettre en pause/i.test(playerLabel)) return true;
  currentBottomState.button.click();
  return waitForBottomPlayback(expectedTitle);
}

async function preparePlayback() {
  const ready = await waitForPageTrackReady();
  if (!ready.ready) return { prepared: false, metadata: ready.metadata };

  const expectedTitle = ready.metadata.title;
  const currentBottomState = bottomPlayerState();
  if (normalizeTrackTitle(currentBottomState.title) === normalizeTrackTitle(expectedTitle)) {
    const paused = await ensurePreparedTrackPaused(expectedTitle);
    return { prepared: paused, metadata: ready.metadata };
  }

  const pageLabel = ready.button.getAttribute("aria-label") || "";
  if (!/pause|mettre en pause/i.test(pageLabel)) {
    ready.button.click();
  }
  const loadedBottomState = await waitForBottomTrack(expectedTitle);
  const paused = loadedBottomState
    ? await ensurePreparedTrackPaused(expectedTitle)
    : false;
  return {
    prepared: paused,
    metadata: ready.metadata
  };
}

const observedMedia = new WeakSet();
function observeMediaEnd() {
  for (const media of document.querySelectorAll("audio")) {
    if (observedMedia.has(media)) continue;
    observedMedia.add(media);
    media.addEventListener("ended", () => {
      const current = playbackMediaElement();
      if (current && current !== media && !current.paused && !current.ended) {
        return;
      }
      sendRuntimeMessage({
        type: "PLAYER_ENDED",
        snapshot: playerSnapshot()
      });
    });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "PING") {
    sendResponse({ ok: true });
    return;
  }
  if (message?.type === "GET_PLAYER_SNAPSHOT") {
    sendResponse({ ok: true, snapshot: playerSnapshot() });
    return;
  }
  if (message?.type === "GET_PAGE_TRACK_STATE") {
    const button = pageTrackPlayButton();
    sendResponse({
      ok: true,
      metadata: pageTrackMetadata(),
      canPlay: Boolean(button),
      isPlaying: /pause|mettre en pause/i.test(button?.getAttribute("aria-label") || "")
    });
    return;
  }
  if (message?.type === "WAIT_PAGE_TRACK_READY") {
    waitForPageTrackReady(Number(message.timeoutMilliseconds) || 8000)
      .then((state) => sendResponse({
        ok: true,
        ready: state.ready,
        metadata: state.metadata,
        isPlaying: /pause|mettre en pause/i.test(
          state.button?.getAttribute("aria-label") || ""
        )
      }))
      .catch((error) => sendResponse({ ok: false, ready: false, error: error.message }));
    return true;
  }
  if (message?.type === "START_PLAYBACK") {
    startPlayback(message.expectedTitle)
      .then((playing) => sendResponse({ ok: true, playing }))
      .catch((error) => sendResponse({ ok: false, playing: false, error: error.message }));
    return true;
  }
  if (message?.type === "PREPARE_TRACK") {
    preparePlayback()
      .then((state) => sendResponse({ ok: true, ...state }))
      .catch((error) => sendResponse({ ok: false, prepared: false, error: error.message }));
    return true;
  }
});

let lastSent = "";
setInterval(() => {
  observeMediaEnd();
  const snapshot = playerSnapshot();
  const signature = JSON.stringify([
    snapshot.metadata.title,
    snapshot.metadata.artist,
    snapshot.positionSeconds,
    snapshot.isPlaying
  ]);
  if (signature !== lastSent) {
    lastSent = signature;
    sendRuntimeMessage({ type: "PLAYER_SNAPSHOT", snapshot });
  }
}, 1000);
