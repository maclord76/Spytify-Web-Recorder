function normalizeTrackTitle(value) {
  return String(value || "").normalize("NFC").trim().toLocaleLowerCase("fr");
}

function numericPosition(value) {
  const position = Number(value);
  return Number.isFinite(position) && position >= 0 ? position : 0;
}

export async function waitForConfirmedPlayback(
  readPlaybackState,
  expectedTitle,
  options = {}
) {
  const timeoutMilliseconds = Number(options.timeoutMilliseconds) || 8000;
  const pollIntervalMilliseconds = Number(options.pollIntervalMilliseconds) || 200;
  const stablePlayingMilliseconds = Number(options.stablePlayingMilliseconds) || 1500;
  const now = options.now || Date.now;
  const wait = options.wait || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  const normalizedExpectedTitle = normalizeTrackTitle(expectedTitle);
  if (!normalizedExpectedTitle) return false;

  const deadline = now() + timeoutMilliseconds;
  let initialPosition = null;
  let playingSince = null;

  while (now() < deadline) {
    let state = null;
    try {
      state = await readPlaybackState();
    } catch {
      // Spotify reconstruit parfois brièvement le lecteur pendant le clic.
      // Une lecture DOM manquée ne doit pas invalider toute la tentative.
    }

    if (normalizeTrackTitle(state?.title) === normalizedExpectedTitle) {
      const position = numericPosition(state?.positionSeconds);
      if (initialPosition === null) initialPosition = position;

      if (state?.isPlaying) {
        if (position > initialPosition) return true;
        if (playingSince === null) playingSince = now();
        if (now() - playingSince >= stablePlayingMilliseconds) return true;
      } else {
        playingSince = null;
      }
    } else {
      // Un titre vide ou ancien est transitoire pendant le rendu du player.
      playingSince = null;
    }

    await wait(pollIntervalMilliseconds);
  }

  return false;
}
