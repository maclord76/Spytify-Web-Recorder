import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { MonitoringSession } from "../monitoring.js";

// Reproduire les libellés de la capture utilisateur sans lire tout le document
// (une bannière ou un résultat de recherche n'est pas une publicité audio).
let playerText = "Spotify Premium\nPublicité • 2 sur 2\n0:19\n0:30";
let title = "", artist = "", semanticMarker = null, mutation;
const sent = [];
const player = {
  get innerText() { return playerText; },
  querySelector(selector) {
    if (selector.startsWith('[data-testid="ad-title"]')) return semanticMarker;
    if (selector === '[data-testid="context-item-info-title"] a') return title ? { textContent: title } : null;
    return null;
  },
  querySelectorAll(selector) { return selector.includes('context-item-info-artist') && artist ? [{ textContent: artist }] : []; }
};
let progress = { max: "30000", value: "19000" };
let audio = null;
let domPosition = "0:19", domDuration = "0:30";
const document = {
  title: "Ancien morceau - titre et paroles par Ancien artiste | Spotify",
  querySelector(selector) {
    if (selector === '[data-testid="now-playing-bar"]') return player;
    if (selector === '[data-testid="control-button-playpause"]') return { getAttribute: () => "Pause" };
    if (selector === '[data-testid="playback-progressbar"] input[type="range"]') return progress;
    if (selector === '[data-testid="playback-position"]') return { textContent: domPosition };
    if (selector === '[data-testid="playback-duration"]') return { textContent: domDuration };
    return null;
  },
  querySelectorAll(selector) { return selector === "audio" && audio ? [audio] : []; }
};
let listener;
vm.runInNewContext((await readFile(new URL("../spotify-player.js", import.meta.url), "utf8")) + "\n" +
  await readFile(new URL("../content.js", import.meta.url), "utf8"), {
  document, location: { href: "https://open.spotify.com/search/playlist" },
  chrome: { runtime: { onMessage: { addListener: fn => { listener = fn; } },
    sendMessage: message => { sent.push(message); return Promise.resolve({ ok: true }); } },
    storage: { local: { get: async () => ({ playerObservation: true }) }, onChanged: { addListener() {} } } },
  setTimeout, setInterval() {},
  MutationObserver: class {
    constructor(fn) { mutation = fn; }
    observe(root) { assert.equal(root, player); }
    disconnect() {}
  }
});
await new Promise(resolve => setImmediate(resolve));
const snapshot = () => { let result; listener({ type: "GET_PLAYER_SNAPSHOT" }, {}, value => { result = value.snapshot; }); return result; };
assert.equal(snapshot().isAdvertisement, true);

assert.equal(snapshot().hasTrackMetadata, false);
assert.equal(snapshot().positionSeconds, 19);
mutation();
assert.equal(sent.at(-1).snapshot.isAdvertisement, true, "Notifier la publicité dès la mutation du lecteur.");
title = "Ancien morceau"; artist = "Ancien artiste";
assert.equal(snapshot().isAdvertisement, true, "Une ancienne identité musicale ne masque pas le libellé publicitaire.");
playerText = "Spotify\nAdvertisement · 1 of 2";
assert.equal(snapshot().isAdvertisement, true);
playerText = "Publicité\nArtiste"; title = "Publicité"; artist = "Artiste";
assert.equal(snapshot().isAdvertisement, false, "Un morceau nommé Publicité ne doit pas être exclu.");
mutation();
assert.equal(sent.at(-1).snapshot.isAdvertisement, false);
playerText = "Chanson\nArtiste"; title = "Chanson";
assert.equal(snapshot().isAdvertisement, false, "Les bannières hors lecteur ne participent pas à la détection.");
semanticMarker = { getClientRects: () => [] };
assert.equal(snapshot().isAdvertisement, false, "Un marqueur publicitaire invisible est ignoré.");
semanticMarker = { getClientRects: () => [{}] };
assert.equal(snapshot().isAdvertisement, true);

// Le média de l'annonce peut rester à 30 s/ended après le retour du morceau.
semanticMarker = null;
playerText = "Chanson\nArtiste"; title = "Chanson"; artist = "Artiste";
domPosition = "0:00"; domDuration = "3:45";
progress = { max: "225905", value: "250" };
audio = { currentTime: 30, duration: 30, paused: true, ended: true };
assert.equal(snapshot().positionSeconds, 0.25);
assert.equal(snapshot().durationSeconds, 225.905);
assert.equal(snapshot().isPlaying, true);
assert.equal(snapshot().ended, false, "La fin de l'annonce ne termine pas le nouveau morceau.");

function fixture() {
  const files = [];
  const session = new MonitoringSession({ sampleRate: 10, startedAtMs: 0,
    create: () => [], write: (data, left) => data.push(...left), finish: file => files.push(file) });
  const pcm = (at, values) => session.pcm(Float32Array.from(values), Float32Array.from(values), at);
  const music = (name, at, position, duration = 0) => session.snapshot({ observedAtMs: at,
    metadata: { title: name, artist: "Artiste" }, positionSeconds: position, durationSeconds: duration,
    isPlaying: true, isAdvertisement: false, hasTrackMetadata: true });
  const ad = (at, position, metadata = null) => session.snapshot({ observedAtMs: at, positionSeconds: position,
    metadata, isPlaying: true, isAdvertisement: true, hasTrackMetadata: false });
  return { files, session, pcm, music, ad };
}
{
  const { files, session, pcm, music, ad } = fixture();
  music("A", 0, 0, 1.5);
  pcm(0, [...Array(15).fill(1), ...Array(5).fill(9)]);
  // Publicité détectée 500 ms après son début : retirer ses PCM du tampon.
  ad(2000, 0.5);
  assert.equal(session.status().advertisement, true);
  assert.equal(session.status().recording, false);
  assert.equal(session.status().metadata, null);
  pcm(2000, Array(20).fill(9));
  // Deuxième publicité : même ancien titre, nouvel audio, aucune séparation MP3.
  ad(3000, 0, { title: "A", artist: "Artiste" });
  session.snapshot({ observedAtMs: 3500, positionSeconds: 0, isPlaying: true,
    metadata: { title: "A", artist: "Artiste" }, hasTrackMetadata: false });
  assert.equal(session.status().advertisement, true, "Attendre de vraies métadonnées musicales après les annonces.");
  pcm(4000, Array(20).fill(2));
  music("B", 4500, 0.5, 2);
  assert.equal(session.status().recording, false, "Confirmer la sortie publicitaire avant de créer un encodeur.");
  music("B", 4750, 0.75, 2);
  assert.equal(session.status().advertisement, false);
  assert.equal(session.status().recording, true);
  session.stop();
  assert.deepEqual(files.map(file => file.metadata.title), ["A", "B"]);
  assert.deepEqual(files[0].data, Array(15).fill(1), "Aucune publicité à la fin du morceau A.");
  assert.deepEqual(files[1].data, Array(20).fill(2), "Aucune publicité au début du morceau B.");
  assert.ok(files.every(file => !file.data.includes(9)));
  assert.equal(files[0].metadata.partial, false);
}

// Le titre revient avant la progression : ignorer la fin d'horloge de la pub,
// y compris un instant où la durée musicale est déjà affichée, puis récupérer
// tout le début du morceau dans un seul MP3 sans suffixe extrait artificiel.
{
  const { files, session, pcm, music } = fixture();
  session.snapshot({ observedAtMs: 0, positionSeconds: 0, durationSeconds: 30,
    isAdvertisement: true, isPlaying: true, metadata: null });
  for (let at = 0; at < 30_000; at += 1000) pcm(at, Array(10).fill(9));
  session.snapshot({ observedAtMs: 29_500, positionSeconds: 29.5, durationSeconds: 30,
    isAdvertisement: true, isPlaying: true, metadata: null });
  music("Patient Zero", 29_750, 29.75, 30);
  music("Patient Zero", 30_000, 30, 225);
  assert.equal(session.status().recording, false);
  music("Patient Zero", 30_250, 0.25, 225);
  music("Patient Zero", 30_500, 0.5, 225);
  pcm(30_000, Array(30).fill(2));
  music("Patient Zero", 33_000, 3, 225);
  assert.equal(session.status().elapsedSeconds, 3, "Compter également les PCM encore dans le tampon.");
  assert.equal(files.length, 0, "La remise à zéro ne crée pas d'extrait intermédiaire.");
  assert.equal(session.current.partial, false);
  for (let elapsed = 3; elapsed < 225; elapsed++) {
    pcm(30_000 + elapsed * 1000, Array(10).fill(2));
    music("Patient Zero", 30_000 + (elapsed + 1) * 1000, elapsed + 1, 225);
    assert.equal(session.status().elapsedSeconds, elapsed + 1);
  }
  session.stop();
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].data, Array(2250).fill(2));
  assert.equal(files[0].metadata.partial, false);
}

// Un premier relevé tardif reste complet si le début a été récupéré dans le
// tampon.
{
  const { files, session, pcm, ad, music } = fixture();
  ad(0, 0);
  pcm(0, Array(10).fill(9));
  pcm(1000, Array(30).fill(2));
  music("B", 3500, 2, 3);
  music("B", 3750, 2, 3);
  session.stop();
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].data, Array(30).fill(2));
  assert.equal(files[0].metadata.partial, false);
}

// Pub affichée d'emblée à « 30 s sur 30 » après la fin du morceau : ce
// compteur ne doit pas retirer la fin du morceau (GLBTM, 5 s perdues).
{
  const { files, session, pcm, music } = fixture();
  for (let second = 0; second < 20; second++) {
    pcm(second * 1000, Array(10).fill(1));
    music("A", second * 1000 + 400, second, 20);
  }
  pcm(20_000, Array(30).fill(9));
  session.snapshot({ observedAtMs: 22_000, positionSeconds: 30, durationSeconds: 30, isPlaying: true,
    isAdvertisement: true, hasTrackMetadata: false, metadata: { title: "Spotify Premium", artist: "" } });
  session.stop();
  assert.equal(files.length, 1);
  assert.ok(files[0].data.length >= 195 && files[0].data.every(value => value === 1),
    `Fin du morceau conservée, sans pub (${files[0].data.length} échantillons).`);
  assert.equal(files[0].metadata.partial, false);
}

// Morceau fini sans nouveau relevé : la pub est repérée 1,2 s après sa fin avec
// le compteur figé sur sa dernière seconde. Ce compteur ne prolonge pas le
// morceau (« Awake », 23 octobre 2026 : 284,8 s enregistrées pour 283,6 s).
{
  const { files, session, pcm, music, ad } = fixture();
  for (let second = 0; second < 10; second++) {
    pcm(second * 1000, Array(10).fill(1));
    music("A", second * 1000, second, 10.6);
  }
  music("A", 10_000, 10, 10.6);
  pcm(10_000, [...Array(6).fill(1), ...Array(4).fill(9)]);
  pcm(11_000, Array(10).fill(9));
  ad(11_800, 10);
  pcm(12_000, Array(30).fill(9));
  session.stop();
  assert.equal(files.length, 1);
  assert.ok(!files[0].data.includes(9), "Aucune publicité à la fin du morceau.");
  assert.ok(files[0].data.length >= 103 && files[0].data.every((value) => value === 1),
    `Fin du morceau conservée à 0,3 s près (${files[0].data.length} échantillons).`);
  assert.equal(files[0].metadata.partial, false);
  assert.equal(session.journal.find((entry) => entry.event === "cut").boundaryOffsetMs, 1500);
}

// Pub repérée 90 ms après son premier son : ce son ne reste pas à la fin du
// morceau, qui garde son silence final. Sans silence avant la coupe, ou trop
// loin d'elle, la musique n'est jamais rognée.
for (const [ending, expectedLength, message] of [
  ["silence", 1050, "Morceau terminé par un silence : coupe au premier son de la pub."],
  ["music", 1059, "Morceau sans silence final : coupe inchangée."],
  ["pause", 1059, "Pause musicale à plus de 300 ms de la coupe : coupe inchangée."]
]) {
  const files = [];
  const session = new MonitoringSession({ sampleRate: 100, startedAtMs: 0,
    create: () => [], write: (data, left) => data.push(...left), finish: file => files.push(file) });
  const send = (at, values) => session.pcm(Float32Array.from(values), Float32Array.from(values), at);
  for (let second = 0; second < 10; second++) {
    send(second * 1000, Array(100).fill(1));
    session.snapshot({ observedAtMs: second * 1000, positionSeconds: second, durationSeconds: 20, isPlaying: true,
      isAdvertisement: false, hasTrackMetadata: true, metadata: { title: "A", artist: "Artiste" } });
  }
  // 10,0 à 10,5 s : fin du morceau ; la pub commence à 10,5 s.
  const end = ending === "silence" ? Array(50).fill(0) : ending === "pause"
    ? [...Array(15).fill(0), ...Array(35).fill(1)] : Array(50).fill(1);
  send(10_000, [...end, ...Array(9).fill(ending === "pause" ? 1 : 9)]);
  session.snapshot({ observedAtMs: 10_590, positionSeconds: 10, durationSeconds: 30, isPlaying: true,
    isAdvertisement: true, hasTrackMetadata: false, metadata: null });
  send(10_590, Array(50).fill(9));
  session.stop();
  assert.equal(files[0].data.length, expectedLength, message);
  if (ending === "silence") assert.ok(!files[0].data.includes(9));
}

// Premier relevé à « 0:00 » alors que 0,6 s sont déjà jouées : le relevé
// « 0:01 » de confirmation situe mieux le début (Episode 6, ~1 s perdue).
{
  const { files, session, pcm, ad, music } = fixture();
  ad(0, 0);
  pcm(0, Array(20).fill(9));
  pcm(2000, Array(10).fill(2));
  music("B", 2600, 0, 60);
  music("B", 3500, 1, 60);
  pcm(3000, Array(20).fill(2));
  session.stop();
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].data, Array(30).fill(2), "Tout le début, sans la pub.");
}

// Titre confirmé quatre secondes après son départ, à la sortie d'une pub :
// le début reste récupérable (« GL (Early Take) », 3,8 s perdues avec 3 s).
{
  const { files, session, pcm, ad, music } = fixture();
  ad(0, 0);
  pcm(0, Array(20).fill(9));
  pcm(2000, Array(60).fill(2));
  // Le texte affiche « 4 » de 4 à 5 s : relevé à mi-seconde, 4,5 s après le début.
  music("B", 6500, 4, 8);
  music("B", 6750, 4, 8);
  pcm(8000, Array(20).fill(2));
  session.stop();
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].data, Array(80).fill(2));
  assert.equal(files[0].metadata.partial, false);
}

// Une progression déjà loin du début ne permet pas de récupérer le début
// hors tampon : conserver extrait sans réattribuer la publicité précédente.
{
  const { files, session, pcm, ad, music } = fixture();
  ad(0, 0);
  pcm(0, Array(50).fill(9));
  music("B", 5000, 10, 20);
  music("B", 5250, 10.25, 20);
  pcm(5000, Array(10).fill(2));
  session.stop();
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].data, Array(10).fill(2));
  assert.equal(files[0].metadata.partial, true);
}
{
  const { files, session, pcm, ad } = fixture();
  ad(0, 0);
  for (let at = 0; at < 60_000; at += 1000) pcm(at, Array(10).fill(9));
  assert.ok(session.pending.reduce((count, block) => count + block.left.length - block.offset, 0) <= 80,
    "Le tampon reste borné à huit secondes.");
  session.stop();
  assert.equal(files.length, 0, "Activation et arrêt pendant les annonces : aucun fichier publicitaire.");
}
console.log("Publicités : lecteur FR/EN, métadonnées périmées, notification immédiate, exclusion PCM, reprise et absence de MP3 publicitaires vérifiés");
