import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Hors session, le script de contenu ne doit ni sonder le lecteur, ni observer
// le DOM, ni réveiller le service de fond.
const source = (await readFile(new URL("../spotify-player.js", import.meta.url), "utf8")) + "\n" +
  await readFile(new URL("../content.js", import.meta.url), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));

function load(initialFlag) {
  const environment = { sent: [], timers: new Map(), observers: [], storageListeners: [], nextTimer: 1 };
  const player = { querySelector: () => null, querySelectorAll: () => [], innerText: "Titre\nArtiste" };
  let position = 10;
  environment.advance = () => { position += 1; };
  const document = {
    title: "Titre - song and lyrics by Artiste | Spotify",
    querySelector(selector) {
      if (selector === '[data-testid="now-playing-bar"]') return player;
      if (selector === '[data-testid="control-button-playpause"]') return { getAttribute: () => "Pause" };
      if (selector === '[data-testid="playback-position"]') return { textContent: `0:${position}` };
      if (selector === '[data-testid="playback-duration"]') return { textContent: "3:00" };
      return null;
    },
    querySelectorAll: () => []
  };
  vm.runInNewContext(source, {
    document,
    location: { href: "https://open.spotify.com/playlist/x", pathname: "/playlist/x" },
    chrome: {
      runtime: { onMessage: { addListener() {} }, sendMessage: async (message) => { environment.sent.push(message); return { ok: true }; } },
      storage: {
        local: { get: async (key) => { assert.equal(key, "playerObservation"); return initialFlag === undefined ? {} : { playerObservation: initialFlag }; } },
        onChanged: { addListener: (fn) => environment.storageListeners.push(fn) }
      }
    },
    setTimeout,
    setInterval(callback, delay) {
      assert.equal(delay, 250);
      const id = environment.nextTimer++;
      environment.timers.set(id, callback);
      return id;
    },
    clearInterval: (id) => environment.timers.delete(id),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.active = false; environment.observers.push(this); }
      observe(root) { assert.equal(root, player); this.active = true; }
      disconnect() { this.active = false; }
    }
  });
  environment.setFlag = (value, area = "local") => environment.storageListeners.forEach((fn) =>
    fn({ playerObservation: { newValue: value } }, area));
  environment.runTimers = () => [...environment.timers.values()].forEach((callback) => callback());
  return environment;
}

// Aucune session : le script reste en veille, même si la musique joue.
for (const flag of [undefined, false]) {
  const page = load(flag);
  await tick();
  assert.equal(page.timers.size, 0, "Aucune minuterie hors session.");
  assert.equal(page.observers.length, 0, "Aucun observateur hors session.");
  page.advance();
  assert.equal(page.sent.length, 0, "Aucun message ne réveille le service de fond.");
  page.setFlag(true, "session");
  assert.equal(page.timers.size, 0, "Seul le stockage local commande l'observation.");
}

// Une session démarre : observation immédiate, puis arrêt complet à la fin.
{
  const page = load(false);
  await tick();
  page.setFlag(true);
  assert.equal(page.timers.size, 1);
  assert.equal(page.observers.filter((observer) => observer.active).length, 1);
  assert.equal(page.sent.at(-1)?.type, "PLAYER_SNAPSHOT", "Un état est publié dès l'activation.");
  const sentAtStart = page.sent.length;
  page.advance();
  page.runTimers();
  assert.equal(page.sent.length, sentAtStart + 1);
  page.setFlag(true);
  assert.equal(page.timers.size, 1, "Une activation répétée ne double pas la minuterie.");

  page.setFlag(false);
  assert.equal(page.timers.size, 0);
  assert.equal(page.observers.filter((observer) => observer.active).length, 0);
  const sentAtStop = page.sent.length;
  page.advance();
  page.observers.forEach((observer) => observer.callback());
  assert.equal(page.sent.length, sentAtStop, "Plus aucun message après la fin de session.");

  // Une nouvelle session republie l'état même s'il n'a pas changé.
  page.setFlag(true);
  assert.equal(page.sent.length, sentAtStop + 1);
}

// Script injecté pendant une session déjà active (rechargement de Spotify).
{
  const page = load(true);
  await tick();
  assert.equal(page.timers.size, 1);
  assert.equal(page.sent.at(-1)?.type, "PLAYER_SNAPSHOT");
}
console.log("Veille du script de contenu : aucune minuterie, observation ni message hors session ; activation et arrêt vérifiés");
