// Défini par spotify-player.js, chargé juste avant ce script. isPlayingLabel
// renvoie true si le bouton propose la pause (lecture en cours), false s'il
// propose la lecture, null pour un libellé inconnu.
const { isPlayingLabel, parseTime, TITLE_SELECTORS } = globalThis.SpytifyPlayer;

function firstText(selectors, root = document) {
  for (const selector of selectors) {
    const value = root.querySelector(selector)?.textContent?.trim();
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

function allTexts(selectors, root = document) {
  for (const selector of selectors) {
    const values = [...root.querySelectorAll(selector)]
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

// Métadonnées que Spotify publie pour les commandes multimédias de Chrome :
// elles décrivent l'élément du lecteur en lecture comme en pause, quelle que
// soit sa mise en page. Le 23 octobre 2026, aucun sélecteur de titre ne
// trouvait le lecteur inférieur (« Emerald Rush », morceau avec clip) : seul
// l'onglet nommait le morceau, et seulement pendant la lecture.
function sessionMetadata() {
  try {
    const metadata = navigator.mediaSession?.metadata;
    if (!metadata) return null;
    const artwork = [...(metadata.artwork || [])]
      .sort((first, second) => (parseInt(second.sizes) || 0) - (parseInt(first.sizes) || 0))[0];
    return {
      title: String(metadata.title || "").trim(),
      artist: String(metadata.artist || "").trim(),
      album: String(metadata.album || "").trim(),
      artworkUrl: artwork?.src || ""
    };
  } catch {
    return null;
  }
}

function pageTrackPlayButton() {
  const main = document.querySelector("main");
  // Le gros bouton du morceau est dans sa barre d'actions, quelle que soit la
  // langue. Les libellés connus servent de repli si cette structure change ;
  // ils écartent les boutons « Lire : … » des recommandations.
  const actionBarButton = main?.querySelector('[data-testid="action-bar-row"] button[data-testid="play-button"]');
  if (actionBarButton?.getClientRects?.().length > 0) return actionBarButton;
  const buttons = [...(main?.querySelectorAll('button[data-testid="play-button"]') || [])];
  const pageButtons = buttons.filter((button) => isPlayingLabel(button.getAttribute("aria-label")) !== null);
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


function playbackMediaElement() {
  // Spotify utilise aussi des vidéos décoratives (Canvas) qui peuvent jouer
  // alors que le morceau est en pause. Elles ne doivent jamais servir d'état
  // au lecteur audio.
  const elements = [...document.querySelectorAll("audio")];
  return elements.find((element) => !element.paused && !element.ended)
    || elements.find((element) => Number.isFinite(element.duration) && element.duration > 0)
    || null;
}


const AD_LABEL = /^(?:publicité|advertisement|advertising|annonce publicitaire|publicidad|anuncio|werbung|pubblicità|publicidade|anúncio|advertentie)(\s*[•·:\-–]\s*\d+\s*(?:sur|of|de|von|di|van)\s*\d+)?$/iu;

function playerAdvertisement(root, hasTrackMetadata) {
  // Observer le lecteur uniquement : les bannières Premium et les résultats
  // de recherche ne signifient pas qu'une publicité est en cours de lecture.
  const marker = root.querySelector('[data-testid="ad-title"], [data-testid="ad-subtitle"], [data-testid="ad-player"], [data-testid="advertisement"]');
  if (marker?.getClientRects?.().length) return true;
  const labels = (root.innerText || root.textContent || "").split(/\n/).map(text => text.trim());
  return labels.some(text => {
    const match = text.match(AD_LABEL);
    // Un vrai morceau intitulé « Publicité » reste un morceau lorsque son
    // titre et ses artistes sont identifiés dans le lecteur.
    return Boolean(match && (match[1] || !hasTrackMetadata));
  });
}

function playerSnapshot() {
  const fallback = metadataFromDocumentTitle();
  const player = document.querySelector('[data-testid="now-playing-bar"]') ||
    document.querySelector('[data-testid="now-playing-widget"]');
  const metadataRoot = player || document;
  const session = sessionMetadata();
  const playerTitle = firstText(TITLE_SELECTORS, metadataRoot) || session?.title || "";
  const title = playerTitle || fallback.title;
  const playerArtist = allTexts([
    '[data-testid="now-playing-widget"] a[data-testid="context-item-info-artist"]',
    'a[data-testid="context-item-info-artist"]',
    '[data-testid="context-item-info-artist"] a',
    '[data-testid="now-playing-widget"] [data-testid="context-item-info-artist"] a'
  ], metadataRoot) || session?.artist || "";
  const artist = playerArtist || fallback.artist;
  const hasTrackMetadata = Boolean(playerTitle && playerArtist);
  // Pour une annonce, Spotify publie son libellé traduit sans artiste.
  const sessionAdvertisement = Boolean(session && !session.artist && AD_LABEL.test(session.title));
  const isAdvertisement = sessionAdvertisement || Boolean(player && playerAdvertisement(player, hasTrackMetadata));
  const album = firstText([
    '[data-testid="context-item-info-album"] a',
    'a[href*="/album/"][data-testid]'
  ]) || session?.album || "";
  const artwork = document.querySelector(
    '[data-testid="cover-art-image"], [data-testid="now-playing-widget"] img'
  );
  const playPause = document.querySelector('[data-testid="control-button-playpause"]');
  const controlLabel = playPause?.getAttribute("aria-label") || "";
  const media = playbackMediaElement();
  const domPosition = parseTime(firstText(['[data-testid="playback-position"]']));
  const domDuration = parseTime(firstText(['[data-testid="playback-duration"]']));
  const progress = document.querySelector('[data-testid="playback-progressbar"] input[type="range"]');
  const maximum = Number(progress?.max);
  // Spotify expose actuellement des millisecondes dans son contrôle natif.
  // Confirmer l'unité avec la durée affichée avant de l'utiliser.
  const progressScale = domDuration > 0 && Math.abs(maximum / 1000 - domDuration) < 2 ? 1000
    : domDuration > 0 && Math.abs(maximum - domDuration) < 2 ? 1 : null;
  const progressPosition = progressScale && Number.isFinite(Number(progress?.value))
    ? Math.max(0, Math.min(maximum, Number(progress.value))) / progressScale : null;
  // La barre peut n'avancer que par pas de 5 s (« 5 » affiché dès 2,7 s
  // réelles, relevé du 10 octobre 2026) alors que le texte suit la seconde.
  // Elle ne sert qu'à affiner un texte présent, jamais à le contredire.
  const hasDomPosition = Boolean(firstText(['[data-testid="playback-position"]']));
  const refinesText = progressPosition !== null && progressPosition >= domPosition && progressPosition < domPosition + 1;
  const precisePosition = progressPosition !== null && (refinesText || !hasDomPosition) ? progressPosition : domPosition;
  // L'élément audio peut encore porter l'horloge/ended de la publicité après
  // le retour du titre. Le lecteur visible reste la référence lorsqu'il existe.
  const usePlayerTiming = Boolean(player && domDuration > 0 && document.querySelector('[data-testid="playback-position"]'));
  const useMediaPosition = !usePlayerTiming && !isAdvertisement && Number.isFinite(media?.currentTime) && media.currentTime > 0;
  const positionSeconds = useMediaPosition ? media.currentTime : precisePosition;
  const durationSeconds = !usePlayerTiming && !isAdvertisement && Number.isFinite(media?.duration) && media.duration > 0
    ? media.duration
    : progressScale ? maximum / progressScale : domDuration;
  const controlState = isPlayingLabel(controlLabel);
  const isPlaying = usePlayerTiming && playPause && controlState !== null ? controlState : media
    ? !media.paused && !media.ended
    : controlState === true;

  return {
    observedAtMs: Date.now(),
    isAdvertisement,
    hasTrackMetadata,
    metadata: {
      title,
      artist,
      album,
      artworkUrl: artwork?.currentSrc || artwork?.src || session?.artworkUrl || ""
    },
    positionSeconds,
    // Origine de la position, pour expliquer un saut dans le diagnostic.
    positionSource: useMediaPosition ? "media" : precisePosition === progressPosition ? "progress" : "text",
    durationSeconds,
    isPlaying,
    ended: (!usePlayerTiming && Boolean(media?.ended)) || (
      durationSeconds > 0 &&
      positionSeconds >= durationSeconds - 0.25 &&
      !isPlaying
    ),
    pageUrl: location.href
  };
}

const observedMedia = new WeakSet();
function observeMediaEnd() {
  for (const media of document.querySelectorAll("audio")) {
    if (observedMedia.has(media)) continue;
    observedMedia.add(media);
    media.addEventListener("ended", () => {
      if (!observing) return;
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
      isPlaying: isPlayingLabel(button?.getAttribute("aria-label")) === true
    });
    return;
  }
  if (message?.type === "WAIT_PAGE_TRACK_READY") {
    waitForPageTrackReady(Number(message.timeoutMilliseconds) || 8000)
      .then((state) => sendResponse({
        ok: true,
        ready: state.ready,
        metadata: state.metadata,
        isPlaying: isPlayingLabel(state.button?.getAttribute("aria-label")) === true
      }))
      .catch((error) => sendResponse({ ok: false, ready: false, error: error.message }));
    return true;
  }
});

let lastSent = "";
function publishPlayerSnapshot() {
  if (!observing) return;
  observeMediaEnd();
  const snapshot = playerSnapshot();
  const signature = JSON.stringify([
    snapshot.metadata.title,
    snapshot.metadata.artist,
    snapshot.positionSeconds,
    snapshot.isPlaying,
    snapshot.ended,
    snapshot.isAdvertisement,
    snapshot.hasTrackMetadata
  ]);
  if (signature !== lastSent) {
    lastSent = signature;
    sendRuntimeMessage({ type: "PLAYER_SNAPSHOT", snapshot });
  }
}

let observedPlayer = null;
let playerObserver = null;
let observing = false;
let snapshotTimer = null;
function watchPlayerAdvertisements() {
  if (!observing || typeof MutationObserver !== "function") return;
  const player = document.querySelector('[data-testid="now-playing-bar"]') ||
    document.querySelector('[data-testid="now-playing-widget"]');
  if (player === observedPlayer) return;
  playerObserver?.disconnect();
  observedPlayer = player;
  if (!player) return;
  // Recevoir le changement publicitaire dès le rendu du player, également
  // lorsque Chrome ralentit les minuteries d'un onglet en arrière-plan.
  playerObserver = new MutationObserver(publishPlayerSnapshot);
  playerObserver.observe(player, { childList: true, subtree: true, characterData: true });
}
// Hors enregistrement ou surveillance, le script reste en veille : aucune
// minuterie, aucun observateur et aucun message ne réveille le service de fond.
// Le service de fond publie playerObservation dans le stockage local.
function setObservation(active) {
  if (active === observing) return;
  observing = active;
  if (active) {
    lastSent = "";
    watchPlayerAdvertisements();
    publishPlayerSnapshot();
    snapshotTimer = setInterval(() => {
      watchPlayerAdvertisements();
      publishPlayerSnapshot();
    }, 250);
    return;
  }
  clearInterval(snapshotTimer);
  snapshotTimer = null;
  playerObserver?.disconnect();
  playerObserver = null;
  observedPlayer = null;
}

try {
  chrome.storage?.local.get("playerObservation")
    .then((saved) => setObservation(Boolean(saved.playerObservation)))
    .catch(() => {});
  chrome.storage?.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.playerObservation) {
      setObservation(Boolean(changes.playerObservation.newValue));
    }
  });
} catch {
  // Contexte invalidé après un rechargement de l'extension : rester en veille.
}
