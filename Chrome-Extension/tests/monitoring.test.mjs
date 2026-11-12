import assert from "node:assert/strict";
import { MonitoringSession } from "../monitoring.js";
import { recordingFilename } from "../core.js";

function fixture() {
  const files = [];
  // Tampon court : ces cas vérifient les instants de finalisation, pas sa taille.
  const session = new MonitoringSession({ sampleRate: 10, startedAtMs: 0, bufferMilliseconds: 3000,
    create: () => [], write: (data, left) => data.push(...left), finish: (segment) => files.push(segment) });
  const snapshot = (title, at, position, playing = true, ended = false, duration = 0) => session.snapshot({
    metadata: { title, artist: "Artiste" }, observedAtMs: at, positionSeconds: position,
    isPlaying: playing, ended, durationSeconds: duration
  });
  const pcm = (at, values) => session.pcm(Float32Array.from(values), Float32Array.from(values), at);
  return { files, session, snapshot, pcm };
}

// Le titre B est découvert 500 ms après son début audio. Aucun sample de B ne
// doit finir dans A et les premiers échantillons de B doivent être récupérés.
{
  const { files, session, snapshot, pcm } = fixture();
  snapshot("A", 0, 0);
  pcm(0, Array(10).fill(1));
  pcm(1000, [...Array(5).fill(1), ...Array(5).fill(2)]);
  snapshot("B", 2000, 0.5);
  snapshot("B", 2300, 0.8);
  pcm(2000, Array(30).fill(2));
  session.stop();
  assert.deepEqual(files.map((file) => file.metadata.title), ["A", "B"]);
  assert.deepEqual(files[0].data, Array(15).fill(1));
  assert.deepEqual(files[1].data, Array(35).fill(2));
  assert.equal(session.pending.length, 0);
}

// Une pause de plusieurs secondes n'est pas encodée ; la reprise garde le MP3.
{
  const { files, session, snapshot, pcm } = fixture();
  snapshot("A", 0, 0);
  pcm(0, Array(10).fill(1));
  assert.equal(session.status().elapsedSeconds, 1);
  snapshot("A", 1000, 1, false);
  pcm(1000, Array(30).fill(0));
  assert.equal(session.status().elapsedSeconds, 1, "La pause n'avance pas le compteur.");
  snapshot("A", 4000, 1, true);
  pcm(4000, Array(10).fill(2));
  assert.equal(session.status().elapsedSeconds, 2);
  session.stop();
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].data, [...Array(10).fill(1), ...Array(10).fill(2)]);
  assert.equal(files[0].durationSeconds, 2);
}

// Un saut manuel au même titre découpe l'extrait précédent sans reprendre des
// PCM déjà attribués à celui-ci.
{
  const { files, session, snapshot, pcm } = fixture();
  snapshot("A", 0, 0, true, false, 10);
  pcm(0, Array(20).fill(1));
  snapshot("A", 2000, 8, true, false, 10);
  snapshot("A", 2300, 8.3, true, false, 10);
  pcm(2000, Array(10).fill(2));
  session.stop();
  assert.equal(files.length, 2);
  assert.deepEqual(files[0].data, Array(20).fill(1));
  assert.deepEqual(files[1].data, Array(10).fill(2));
  assert.ok(files.every((file) => file.metadata.partial));
  assert.match(recordingFilename(files[0].metadata), /\(extrait\)\.mp3$/);
}

// Une position aberrante isolée, aussitôt démentie, ne coupe pas le morceau.
// Avant correction : trois MP3 dont un de 0,34 s (« GLBTM », 10 octobre 2026).
{
  const { files, session, snapshot, pcm } = fixture();
  snapshot("A", 0, 0, true, false, 100);
  pcm(0, Array(50).fill(1));
  snapshot("A", 5000, 5, true, false, 100);
  snapshot("A", 5250, 47, true, false, 100);
  snapshot("A", 5500, 5.5, true, false, 100);
  snapshot("A", 5750, 5.75, true, false, 100);
  pcm(5000, Array(50).fill(1));
  session.stop();
  assert.equal(files.length, 1, "Le relevé aberrant ne crée aucun extrait.");
  assert.equal(files[0].data.length, 100);
  assert.deepEqual(session.journal.filter((entry) => entry.event.startsWith("seek")).map((entry) => entry.event),
    ["seek_pending", "seek_ignored"]);
}

// Un saut en arrière confirmé découpe au premier relevé du saut.
{
  const { files, session, snapshot, pcm } = fixture();
  snapshot("A", 0, 30, true, false, 100);
  pcm(0, Array(20).fill(1));
  snapshot("A", 2000, 32, true, false, 100);
  snapshot("A", 2000, 32, true, false, 100);
  snapshot("A", 2500, 10, true, false, 100);
  snapshot("A", 2750, 10.25, true, false, 100);
  pcm(2000, Array(10).fill(2));
  session.stop();
  assert.equal(files.length, 2);
  assert.deepEqual(files[0].data, [...Array(20).fill(1), ...Array(5).fill(2)]);
  assert.deepEqual(files[1].data, Array(5).fill(2));
  assert.equal(files[0].reason, "seek");
}

// Le libellé publicitaire peut s'afficher avant la remise à zéro du compteur :
// la fin du morceau ne doit pas être retirée (« Infinity Repeating »).
{
  const { files, session, snapshot, pcm } = fixture();
  snapshot("A", 0, 0, true, false, 10);
  for (let at = 0; at < 10_000; at += 1000) {
    pcm(at, Array(10).fill(1));
    if (at) snapshot("A", at, at / 1000, true, false, 10);
  }
  session.snapshot({ observedAtMs: 10_000, positionSeconds: 10, durationSeconds: 10,
    isPlaying: true, isAdvertisement: true, metadata: { title: "A", artist: "Artiste" } });
  pcm(10_000, Array(30).fill(9));
  session.stop();
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].data, Array(100).fill(1), "Toute la fin du morceau reste dans son MP3.");
  assert.equal(files[0].metadata.partial, false);
}

// Le nouveau titre s'affiche avec le compteur de l'ancien, remis à zéro deux
// secondes et demie plus tard (journal du 10 octobre 2026, GLBTM après Doin'
// It Right) : la coupe se place d'après le compteur remis à zéro.
{
  const files = [];
  const session = new MonitoringSession({ sampleRate: 10, startedAtMs: 0,
    create: () => [], write: (data, left) => data.push(...left), finish: (segment) => files.push(segment) });
  const snapshot = (title, at, position, duration) => session.snapshot({ metadata: { title, artist: "Artiste" },
    observedAtMs: at, positionSeconds: position, isPlaying: true, durationSeconds: duration });
  for (let second = 0; second < 10; second++) {
    session.pcm(Float32Array.from(Array(10).fill(1)), Float32Array.from(Array(10).fill(1)), second * 1000);
    snapshot("A", second * 1000, second, 10);
  }
  const b = (second) => session.pcm(Float32Array.from(Array(10).fill(2)), Float32Array.from(Array(10).fill(2)), second * 1000);
  b(10);
  snapshot("B", 10_900, 9, 30);
  b(11);
  snapshot("B", 11_200, 9, 30);
  b(12);
  b(13);
  snapshot("B", 13_400, 3, 30);
  b(14);
  snapshot("B", 14_400, 4, 30);
  for (let second = 15; second < 20; second++) b(second);
  session.stop();
  assert.deepEqual(files.map((file) => file.metadata.title), ["A", "B"], "La remise à zéro n'est pas un saut.");
  assert.ok(files[0].data.length >= 98 && files[0].data.every((value) => value === 1),
    `Toute la fin de A, rien de B (${files[0].data.length} échantillons).`);
  assert.ok(files[1].data.filter((value) => value === 1).length <= 2, "B commence à son vrai début.");
  assert.equal(files[0].metadata.partial, false);
}

// La fin réelle exporte le titre même si aucun morceau ne suit immédiatement.
{
  const { files, session, snapshot, pcm } = fixture();
  snapshot("A", 0, 0, true, false, 1);
  pcm(0, Array(10).fill(1));
  snapshot("A", 1000, 1, false, true, 1);
  pcm(1000, Array(40).fill(0));
  assert.equal(files.length, 1);
  assert.equal(files[0].metadata.partial, false);
  session.stop();
  assert.equal(files.length, 1);
}

// Spotify n'affiche pas la fin : il revient à 0:00 en pause, puis plus aucun
// relevé ni PCM n'arrive. Avant correction, ce retour restait un saut en
// attente et le MP3 n'était exporté qu'à l'arrêt (« As Grace Descends »,
// journal du 20 octobre 2026). L'horloge ne touche pas au tampon en lecture.
{
  const { files, session, snapshot, pcm } = fixture();
  snapshot("A", 0, 0, true, false, 10.4);
  for (let at = 0; at < 10_000; at += 1000) {
    pcm(at, Array(10).fill(1));
    if (at) snapshot("A", at, at / 1000, true, false, 10.4);
    session.settle(at + 900);
  }
  pcm(10_000, Array(4).fill(1));
  snapshot("A", 10_600, 0, false, false, 10.4);
  assert.equal(session.status().metadata, null, "La fin est reconnue sans second relevé.");
  assert.equal(session.journal.at(-1).reason, "track_ended");
  session.settle(11_000);
  assert.equal(files.length, 0, "Le tampon attend deux secondes sans PCM.");
  session.settle(12_700);
  assert.equal(files.length, 1, "MP3 exporté sans arrêt de la surveillance.");
  assert.equal(files[0].reason, "track_ended");
  assert.deepEqual(files[0].data, Array(104).fill(1));
  assert.equal(files[0].metadata.partial, false);
  // Relancer le morceau en forme un nouveau MP3.
  snapshot("A", 30_000, 0, true, false, 10.4);
  pcm(30_000, Array(10).fill(2));
  snapshot("A", 31_000, 1, true, false, 10.4);
  session.stop();
  assert.equal(files.length, 2);
  assert.deepEqual(files[1].data, Array(10).fill(2));
}

// En pause à 0:00, Spotify ne nommait plus le morceau (seul l'onglet le faisait,
// pendant la lecture) et l'onglet livrait encore du silence : le morceau restait
// ouvert jusqu'à l'arrêt (« Emerald Rush », 23 octobre 2026 : 431,6 s
// enregistrées pour 336,7 s). Un relevé sans identité décrit le morceau en cours.
{
  const { files, session, snapshot, pcm } = fixture();
  const untitled = (at, position, playing) => session.snapshot({ metadata: { title: "", artist: "" },
    observedAtMs: at, positionSeconds: position, isPlaying: playing, ended: false, durationSeconds: 10.4 });
  snapshot("A", 0, 0, true, false, 10.4);
  for (let at = 0; at < 10_000; at += 1000) {
    pcm(at, Array(10).fill(1));
    if (at) snapshot("A", at, at / 1000, true, false, 10.4);
    if (at === 5000) untitled(5500, 5.5, true);
  }
  assert.equal(session.status().recording, true, "Un relevé sans titre en cours de lecture ne coupe rien.");
  pcm(10_000, [...Array(4).fill(1), ...Array(6).fill(0)]);
  untitled(10_600, 0, false);
  assert.equal(session.status().metadata, null, "La fin est reconnue sans identité.");
  assert.equal(session.journal.at(-1).reason, "track_ended");
  assert.ok(session.journal.some((entry) => entry.event === "identity_inherited"));
  for (let at = 11_000; at < 20_000; at += 1000) pcm(at, Array(10).fill(0));
  assert.equal(files.length, 1, "MP3 exporté malgré le silence continu de l'onglet.");
  assert.equal(files[0].reason, "track_ended");
  assert.deepEqual(files[0].data, [...Array(104).fill(1), 0, 0], "Le silence d'après la fin est exclu.");
  assert.equal(files[0].metadata.title, "A");
  assert.equal(files[0].metadata.partial, false);
  session.stop();
  assert.equal(files.length, 1);
}

// Variante : le bouton passe en pause sur l'avant-dernière seconde, avant le
// retour à 0:00 (« Akróasis », même journal).
{
  const { files, session, snapshot, pcm } = fixture();
  snapshot("A", 0, 0, true, false, 5.6);
  pcm(0, Array(50).fill(1));
  snapshot("A", 5000, 5, false, false, 5.6);
  snapshot("A", 5300, 0, false, false, 5.6);
  session.settle(7400);
  assert.equal(files.length, 1);
  assert.equal(files[0].reason, "track_ended");
  assert.deepEqual(files[0].data, Array(50).fill(1));
  assert.equal(files[0].metadata.partial, false);
}

// Un autre titre affiché à l'arrêt ne serait jamais confirmé par un second
// relevé : l'horloge le confirme et exporte le morceau précédent.
{
  const { files, session, snapshot, pcm } = fixture();
  snapshot("A", 0, 0, true, false, 20);
  pcm(0, Array(50).fill(1));
  snapshot("A", 5000, 5, true, false, 20);
  snapshot("B", 5200, 0, false, false, 30);
  session.settle(6000);
  assert.equal(session.status().metadata.title, "A", "Un titre transitoire n'est pas confirmé aussitôt.");
  session.settle(7500);
  assert.equal(session.status().metadata, null);
  session.settle(9600);
  assert.equal(files.length, 1);
  assert.equal(files[0].reason, "track_changed");
  assert.deepEqual(files[0].data, Array(50).fill(1));
  session.stop();
  assert.equal(files.length, 1, "Le titre en pause n'a produit aucun MP3.");
}

// Une longue pause en cours de morceau vide le tampon sans le terminer : la
// reprise complète le même MP3.
{
  const { files, session, snapshot, pcm } = fixture();
  snapshot("A", 0, 0, true, false, 20);
  pcm(0, Array(30).fill(1));
  snapshot("A", 3000, 3, false, false, 20);
  session.settle(10_000);
  assert.equal(files.length, 0);
  assert.equal(session.pending.length, 0);
  snapshot("A", 60_000, 3, true, false, 20);
  pcm(60_000, Array(20).fill(2));
  snapshot("A", 62_000, 5, true, false, 20);
  session.stop();
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].data, [...Array(30).fill(1), ...Array(20).fill(2)]);
}

// Une progression transitoire au démarrage ne doit pas imposer « extrait »
// lorsque les PCM confirment ensuite que le morceau entier a été capturé.
{
  const { files, session, snapshot, pcm } = fixture();
  snapshot("Complet", 0, 2.5, true, false, 10);
  pcm(0, Array(30).fill(1));
  snapshot("Complet", 3000, 3, true, false, 10);
  pcm(3000, Array(70).fill(1));
  snapshot("Complet", 10_000, 10, false, true, 10);
  pcm(10_000, Array(40).fill(0));
  assert.equal(files.length, 1);
  assert.equal(files[0].durationSeconds, 10);
  assert.equal(files[0].metadata.partial, false);
  assert.equal(recordingFilename(files[0].metadata), "Spytify Web/Artiste - Complet.mp3");
  session.stop();
}

// Même contrôle lors du passage automatique au titre suivant, y compris si
// Spotify ne fournit la durée du morceau qu'après le premier relevé.
{
  const { files, session, snapshot, pcm } = fixture();
  snapshot("Complet", 0, 2.5);
  pcm(0, Array(30).fill(1));
  snapshot("Complet", 3000, 3, true, false, 10);
  pcm(3000, Array(70).fill(1));
  snapshot("Suivant", 10_500, 0.5, true, false, 20);
  snapshot("Suivant", 10_750, 0.75, true, false, 20);
  pcm(10_000, Array(40).fill(2));
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].data, Array(100).fill(1));
  assert.equal(recordingFilename(files[0].metadata), "Spytify Web/Artiste - Complet.mp3");
  session.stop();
  assert.equal(files[1].metadata.partial, true, "Le titre suivant arrêté trop tôt reste un extrait.");
}

// Atteindre la fin après une activation tardive ne signifie pas avoir tout
// enregistré. Sans durée connue, conserver l'estimation du début manquant.
for (const duration of [0, 10]) {
  const { files, session, snapshot, pcm } = fixture();
  snapshot("Incomplet", 0, 5, true, false, duration);
  pcm(0, Array(50).fill(1));
  snapshot("Incomplet", 5000, 10, false, true, duration);
  pcm(5000, Array(40).fill(0));
  assert.equal(files.length, 1);
  assert.equal(files[0].metadata.partial, true);
  assert.equal(recordingFilename(files[0].metadata), "Spytify Web/Artiste - Incomplet (extrait).mp3");
  session.stop();
}

// Le tampon reste borné ; les états incomplets/transitoires ne divisent pas A.
{
  const { files, session, snapshot, pcm } = fixture();
  snapshot("A", 0, 0);
  for (let at = 0; at < 20_000; at += 1000) pcm(at, Array(10).fill(1));
  assert.ok(session.pending.reduce((n, block) => n + block.left.length - block.offset, 0) <= 30);
  session.snapshot({ observedAtMs: 20_000, metadata: { title: "" }, isPlaying: false });
  snapshot("Transitoire", 20_000, 0);
  snapshot("A", 20_100, 20.1);
  session.stop();
  session.stop();
  assert.equal(files.length, 1);
  assert.equal(files[0].data.length, 200);
}

// Activer la surveillance sans lecture ne produit aucun fichier vide.
{
  const { files, session, snapshot, pcm } = fixture();
  snapshot("A", 0, 0, false);
  pcm(0, Array(40).fill(0));
  session.stop();
  assert.equal(files.length, 0);
}
console.log("Surveillance : séparation PCM, début différé, pause/reprise, sauts, fin sans morceau suivant et tampon borné vérifiés");
