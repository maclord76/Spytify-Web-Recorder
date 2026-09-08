export function clickPreparedPlayerButton(requestedTitle, previousPosition = null) {
  const normalizeTitle = (value) => String(value || "")
    .normalize("NFC")
    .trim()
    .toLocaleLowerCase("fr");
  const parseTime = (value) => {
    const parts = String(value || "").trim().split(":").map(Number);
    if (!parts.length || parts.some(Number.isNaN)) return 0;
    return parts.reduce((seconds, part) => seconds * 60 + part, 0);
  };
  const main = document.querySelector("main");
  const pageTitle = (
    main?.querySelector('[data-testid="entityTitle"]')?.textContent
    || main?.querySelector("h1")?.textContent
    || ""
  ).trim();
  const playerTitleSelectors = [
    '[data-testid="context-item-info-title"] a',
    '[data-testid="now-playing-widget"] [data-testid="context-item-link"]',
    '[data-testid="context-item-link"]'
  ];
  let playerTitle = "";
  for (const selector of playerTitleSelectors) {
    playerTitle = document.querySelector(selector)?.textContent?.trim() || "";
    if (playerTitle) break;
  }
  if (
    normalizeTitle(pageTitle) !== normalizeTitle(requestedTitle) ||
    normalizeTitle(playerTitle) !== normalizeTitle(requestedTitle)
  ) {
    return { attempted: false, reason: "title" };
  }
  const button = document.querySelector(
    'button[data-testid="control-button-playpause"]'
  );
  if (
    !button ||
    button.disabled ||
    button.getAttribute("aria-disabled") === "true" ||
    button.getClientRects().length === 0
  ) {
    return { attempted: false, reason: "button" };
  }
  const label = button.getAttribute("aria-label") || "";
  const positionSeconds = parseTime(
    document.querySelector('[data-testid="playback-position"]')?.textContent
  );
  const mediaIsPlaying = [...(document.querySelectorAll?.("audio") || [])]
    .some((media) => !media.paused && !media.ended);
  const positionAdvanced = previousPosition !== null &&
    positionSeconds > Number(previousPosition);
  if (/pause|mettre en pause/i.test(label) || mediaIsPlaying || positionAdvanced) {
    return { attempted: true, alreadyPlaying: true, positionSeconds };
  }
  button.focus({ preventScroll: true });
  button.click();
  return { attempted: true, alreadyPlaying: false, positionSeconds };
}

export async function startPreparedPlayerPlayback(tabId, expectedTitle) {
  const target = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    const executePlayerCommand = async (previousPosition = null) => {
      const parameters = {
        expression: `(${clickPreparedPlayerButton.toString()})(${JSON.stringify(expectedTitle)}, ${JSON.stringify(previousPosition)})`,
        userGesture: true,
        awaitPromise: true,
        returnByValue: true
      };
      const response = await chrome.debugger.sendCommand(
        target,
        "Runtime.evaluate",
        parameters
      );
      if (response?.exceptionDetails) {
        throw new Error("La commande de lecture Spotify a échoué dans Chrome.");
      }
      return response?.result?.value || { attempted: false, reason: "result" };
    };

    const first = await executePlayerCommand();
    if (!first.attempted || first.alreadyPlaying) return { ...first, attempts: 1 };

    // Certains lecteurs Spotify ne font qu'initialiser le périphérique au
    // premier ordre. Le second ordre n'est envoyé que si le player affiche
    // toujours Lecture; la fonction injectée refuse alors de mettre en pause
    // un morceau qui aurait démarré entre-temps.
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const second = await executePlayerCommand(first.positionSeconds ?? null);
    // Le premier clic a bien été envoyé. Si Spotify reconstruit son DOM au
    // moment de la seconde sonde, laisser la vérification temporisée trancher
    // au lieu de transformer cet état transitoire en échec de clic.
    if (!second.attempted) return { ...first, attempts: 2 };
    return { ...second, attempts: 2 };
  } finally {
    if (attached) {
      await chrome.debugger.detach(target).catch(() => {});
    }
  }
}
