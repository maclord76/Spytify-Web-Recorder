import "./spotify-player.js";

const { labels: PLAYER_LABELS, TITLE_SELECTORS } = globalThis.SpytifyPlayer;
const PLAYER_DESCRIPTION = { labels: PLAYER_LABELS, titleSelectors: TITLE_SELECTORS };

// Exécutée dans la page par le débogueur : elle ne peut rien importer. Les
// libellés et sélecteurs de spotify-player.js lui sont passés en argument ;
// ses deux petites aides reproduisent normalizeTitle et parseTime, faute de
// pouvoir transmettre une fonction.
export function readTrackPlayButton(requestedTitle, previousPosition = null, buttonSource = "player",
  player = PLAYER_DESCRIPTION) {
  const { labels, titleSelectors } = player;
  const normalizeTitle = (value) => String(value || "")
    .normalize("NFC")
    .trim()
    .toLocaleLowerCase("fr");
  const parseTime = (value) => {
    const parts = String(value || "").trim().split(":").map(Number);
    if (!parts.length || parts.some(Number.isNaN)) return 0;
    return parts.reduce((seconds, part) => seconds * 60 + part, 0);
  };
  // L'onglet a pu changer de site depuis la vérification précédant
  // l'attachement : ne jamais viser de bouton hors de Spotify Web.
  if (location.origin !== "https://open.spotify.com") return { ready: false, reason: "origin" };
  const normalizeLabel = (value) => String(value ?? "").normalize("NFC").trim().toLowerCase();
  const pauseLabels = new Set(labels?.pause || []);
  const playLabels = new Set(labels?.play || []);
  const proposesPause = (element) => pauseLabels.has(normalizeLabel(element?.getAttribute("aria-label")));
  const hasKnownLabel = (element) => {
    const label = normalizeLabel(element?.getAttribute("aria-label"));
    return pauseLabels.has(label) || playLabels.has(label);
  };
  const main = document.querySelector("main");
  const pageTitle = (
    main?.querySelector('[data-testid="entityTitle"]')?.textContent
    || main?.querySelector("h1")?.textContent
    || ""
  ).trim();
  let playerTitle = "";
  for (const selector of titleSelectors) {
    playerTitle = document.querySelector(selector)?.textContent?.trim() || "";
    if (playerTitle) break;
  }
  // Le lecteur inférieur peut ne plus exposer son titre : Spotify publie aussi
  // celui de l'élément en cours pour les commandes multimédias de Chrome.
  playerTitle ||= String(navigator.mediaSession?.metadata?.title || "").trim();
  const playerShowsTrack = normalizeTitle(playerTitle) === normalizeTitle(requestedTitle);
  // Le gros bouton de la page lance le morceau de la page, même lorsque le
  // lecteur inférieur affiche encore le titre écouté précédemment. Le bouton
  // du lecteur inférieur, lui, ne commande que le titre qu'il affiche.
  if (
    normalizeTitle(pageTitle) !== normalizeTitle(requestedTitle) ||
    (!playerShowsTrack && buttonSource !== "page")
  ) {
    return { ready: false, reason: "title" };
  }
  const playerButton = document.querySelector('button[data-testid="control-button-playpause"]');
  // Le gros bouton du morceau est dans sa barre d'actions, quelle que soit la
  // langue ; les libellés connus servent de repli.
  const actionBarButton = main?.querySelector('[data-testid="action-bar-row"] button[data-testid="play-button"]');
  const pageButton = actionBarButton?.getClientRects().length > 0
    ? actionBarButton
    : [...(main?.querySelectorAll('button[data-testid="play-button"]') || [])]
      .find((candidate) => candidate.getClientRects().length > 0 && hasKnownLabel(candidate));
  const button = buttonSource === "page" ? pageButton : playerButton;
  if (
    !button ||
    button.disabled ||
    button.getAttribute("aria-disabled") === "true" ||
    button.getClientRects().length === 0
  ) {
    return { ready: false, reason: "button" };
  }
  const label = button.getAttribute("aria-label") || "";
  const positionSeconds = parseTime(
    document.querySelector('[data-testid="playback-position"]')?.textContent
  );
  const mediaIsPlaying = [...(document.querySelectorAll?.("audio") || [])]
    .some((media) => !media.paused && !media.ended);
  const positionAdvanced = previousPosition !== null &&
    positionSeconds > Number(previousPosition);
  const rect = button.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const survole = document.elementFromPoint(x, y);
  return {
    ready: true,
    label,
    // Le lecteur inférieur, l'élément audio et la progression ne décrivent ce
    // morceau que lorsque le lecteur l'affiche ; sinon seul le gros bouton compte.
    alreadyPlaying: playerShowsTrack
      ? proposesPause(button) || proposesPause(playerButton) || proposesPause(pageButton) ||
        mediaIsPlaying || positionAdvanced
      : proposesPause(pageButton),
    positionSeconds,
    x,
    y,
    // Mesurés pendant que le débogueur est attaché : disent si les coordonnées
    // visées touchent réellement le bouton à cet instant précis.
    innerHeight: window.innerHeight,
    cibleAtteinte: survole ? survole === button || button.contains(survole) : null,
    // Passe à true dès qu'un vrai événement d'entrée atteint la page : dit si le
    // clic envoyé par le débogueur est bien arrivé, ou s'il rate sa cible.
    hasBeenActive: navigator.userActivation?.hasBeenActive ?? null
  };
}


const CONFIRMATION_PROBES = 6;
const PROBE_INTERVAL_MILLISECONDS = 400;

// Le débogueur Chrome n'est pas limité aux hôtes du manifeste : l'onglet doit
// afficher Spotify Web avant chaque attachement.
async function attachToSpotifyTab(target) {
  const tab = await chrome.tabs.get(target.tabId);
  if (!String(tab?.url || "").startsWith("https://open.spotify.com/")) {
    throw new Error("L'onglet ciblé n'affiche plus Spotify Web : le lecteur n'a pas été piloté.");
  }
  await chrome.debugger.attach(target, "1.3");
}

async function readPlayerThroughDebugger(target, expectedTitle, previousPosition = null, buttonSource = "player") {
  const response = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression: `(${readTrackPlayButton.toString()})(${JSON.stringify(expectedTitle)}, ${JSON.stringify(previousPosition)}, ${JSON.stringify(buttonSource)}, ${JSON.stringify(PLAYER_DESCRIPTION)})`,
    awaitPromise: true,
    returnByValue: true
  });
  if (response?.exceptionDetails) {
    throw new Error("La commande du lecteur Spotify a échoué dans Chrome.");
  }
  return response?.result?.value || { ready: false, reason: "result" };
}

async function dispatchPlayerClick(target, x, y) {
  const event = { x, y, button: "left", clickCount: 1 };
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { ...event, type });
  }
}

// Spotify peut restaurer le morceau en pause au milieu : le ramener à 0:00
// avant de le lancer pour enregistrer son début.
export async function rewindTrackPlayback(tabId, expectedTitle) {
  const target = { tabId };
  let attached = false;
  try {
    await attachToSpotifyTab(target);
    attached = true;
    const state = await readPlayerThroughDebugger(target, expectedTitle);
    if (!state.ready || state.alreadyPlaying) return { reset: false, reason: state.reason || "playing" };
    if (state.positionSeconds === 0) return { reset: true };
    const focus = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: `(() => {
        const slider = document.querySelector('[data-testid="playback-progressbar"] input[type="range"]');
        if (!slider || slider.disabled) return false;
        slider.focus();
        return document.activeElement === slider;
      })()`,
      returnByValue: true
    });
    if (focus.exceptionDetails || !focus.result?.value) return { reset: false, reason: "progress-control" };
    const beforeKey = await readPlayerThroughDebugger(target, expectedTitle);
    if (!beforeKey.ready || beforeKey.alreadyPlaying) return { reset: false, reason: beforeKey.reason || "playing" };
    for (const type of ["keyDown", "keyUp"]) {
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type, key: "Home", code: "Home", windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36
      });
    }
    for (let probe = 0; probe < 20; probe += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const observed = await readPlayerThroughDebugger(target, expectedTitle);
      if (!observed.ready || observed.alreadyPlaying) return { reset: false, reason: observed.reason || "playing" };
      if (observed.positionSeconds === 0) return { reset: true };
    }
    return { reset: false, reason: "position-unconfirmed" };
  } finally {
    if (attached) await chrome.debugger.detach(target).catch(() => {});
  }
}

// Lance le morceau de la page par un vrai clic : le bouton du lecteur inférieur
// s'il affiche ce morceau, sinon (ou s'il reste sans effet) le gros bouton de la
// page. Chaque clic est précédé d'une lecture de l'état : un morceau déjà lancé
// par Spotify n'est jamais remis en pause.
export async function startTrackPlayback(tabId, expectedTitle) {
  const target = { tabId };
  const clicks = [];
  let attached = false;
  try {
    await attachToSpotifyTab(target);
    attached = true;

    const readPlayer = (previousPosition = null, buttonSource = "player") =>
      readPlayerThroughDebugger(target, expectedTitle, previousPosition, buttonSource);

    // Spotify démarre la lecture depuis un gestionnaire asynchrone : l'activation
    // utilisateur accordée à Runtime.evaluate expire avant son appel à play(), et
    // un element.click() injecté reste alors sans effet. Seul un vrai événement
    // d'entrée accorde une activation qui survit à cette attente.
    const clickAndConfirm = async (state, source) => {
      await dispatchPlayerClick(target, state.x, state.y);
      clicks.push({ cible: source, x: state.x, y: state.y, cibleAtteinte: state.cibleAtteinte });
      // Spotify peut mettre plusieurs secondes à refléter la lecture : sonder sans
      // cliquer évite qu'un second ordre ne remette le morceau en pause.
      for (let probe = 0; probe < CONFIRMATION_PROBES; probe += 1) {
        await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MILLISECONDS));
        const observed = await readPlayer(state.positionSeconds ?? null, source);
        if (observed.ready && observed.alreadyPlaying) return observed;
      }
      return null;
    };
    const result = (alreadyPlaying, state, extra = {}) => ({
      attempted: clicks.length > 0 || alreadyPlaying,
      alreadyPlaying,
      positionSeconds: state?.positionSeconds,
      clicks,
      ...extra
    });

    const player = await readPlayer();
    if (player.ready && player.alreadyPlaying) return result(true, player);
    if (!player.ready && player.reason === "origin") return result(false, player, { reason: "origin" });
    if (player.ready) {
      const playing = await clickAndConfirm(player, "player");
      if (playing) return result(true, playing);
    }

    // Le lecteur inférieur affiche un autre titre, ou ignore la reprise même
    // lorsque le clic atteint son bouton : utiliser le bouton du morceau, qui
    // charge son contexte de lecture.
    const page = await readPlayer(player.positionSeconds ?? null, "page");
    if (!page.ready) return result(false, player, { reason: page.reason });
    if (page.alreadyPlaying) return result(true, page);
    if (page.cibleAtteinte === false) return result(false, page, { reason: "page-button-obstructed" });
    const playing = await clickAndConfirm(page, "page");
    return result(Boolean(playing), playing ?? page);
  } finally {
    if (attached) {
      await chrome.debugger.detach(target).catch(() => {});
    }
  }
}
