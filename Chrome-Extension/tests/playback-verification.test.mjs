import assert from "node:assert/strict";
import { waitForConfirmedPlayback } from "../playback-verification.js";

function virtualClock() {
  let milliseconds = 0;
  return {
    now: () => milliseconds,
    wait: async (delay) => {
      milliseconds += delay;
    }
  };
}

{
  const clock = virtualClock();
  const states = [
    { title: "", isPlaying: false, positionSeconds: 0 },
    { title: "Ancien titre", isPlaying: false, positionSeconds: 18 },
    { title: "Titre test", isPlaying: true, positionSeconds: 0 },
    { title: "Titre test", isPlaying: true, positionSeconds: 1 }
  ];
  let reads = 0;
  const confirmed = await waitForConfirmedPlayback(
    async () => {
      reads += 1;
      return states.shift() || { title: "Titre test", isPlaying: true, positionSeconds: 1 };
    },
    "Titre test",
    { ...clock, timeoutMilliseconds: 3000, pollIntervalMilliseconds: 200 }
  );

  assert.equal(confirmed, true);
  assert.equal(reads, 4, "les titres transitoires doivent être ignorés, pas provoquer un échec immédiat");
}

{
  const clock = virtualClock();
  let reads = 0;
  const confirmed = await waitForConfirmedPlayback(
    async () => {
      reads += 1;
      if (reads === 1) throw new Error("DOM en reconstruction");
      return { title: "Titre test", isPlaying: true, positionSeconds: 0 };
    },
    "Titre test",
    {
      ...clock,
      timeoutMilliseconds: 3000,
      pollIntervalMilliseconds: 250,
      stablePlayingMilliseconds: 750
    }
  );

  assert.equal(confirmed, true);
  assert.ok(reads >= 5, "la lecture stable doit être observée après l'erreur DOM transitoire");
}

{
  const clock = virtualClock();
  const confirmed = await waitForConfirmedPlayback(
    async () => ({ title: "Mauvais titre", isPlaying: true, positionSeconds: 12 }),
    "Titre test",
    { ...clock, timeoutMilliseconds: 1000, pollIntervalMilliseconds: 200 }
  );

  assert.equal(confirmed, false, "un autre morceau ne doit jamais être accepté");
}

// Une publicité précède le morceau : Spotify l'enchaînera, aucun clic n'est utile.
assert.equal(await waitForConfirmedPlayback(async () => ({ title: "Publicité", isPlaying: true, advertisement: true }),
  "Titre", { now: () => 0, wait: async () => {} }), true);

console.log("Tests de confirmation de lecture réussis");
