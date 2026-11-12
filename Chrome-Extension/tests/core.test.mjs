import assert from "node:assert/strict";
import {
  createId3v24Tag,
  describeRecording,
  formatDuration,
  MAX_FILENAME_LENGTH,
  metadataSignature,
  parseSpotifyTrackUrl,
  recordingFilename,
  sanitizeFilename
} from "../core.js";

// Durées du compteur et des MP3 téléchargés.
assert.equal(formatDuration(0), "00:00");
assert.equal(formatDuration(192.9), "03:12");
assert.equal(formatDuration(4210), "70:10");
assert.equal(formatDuration(undefined), "00:00");
assert.equal(describeRecording("Spytify Web/Daft Punk - Ouverture.mp3", 192.4), "Daft Punk - Ouverture.mp3 (03:12)");
assert.equal(describeRecording("Spytify Web/Daft Punk - Ouverture.mp3", null), "Daft Punk - Ouverture.mp3",
  "Sans durée connue, seul le nom est affiché.");

const exampleId = "5AfQGPbNnm165WVCrfPnHT";

assert.deepEqual(
  parseSpotifyTrackUrl(`https://open.spotify.com/intl-fr/track/${exampleId}?autoplay_ok=1`),
  { trackId: exampleId, url: `https://open.spotify.com/track/${exampleId}?autoplay_ok=1` }
);
assert.deepEqual(
  parseSpotifyTrackUrl(`spotify:track:${exampleId}`),
  { trackId: exampleId, url: `https://open.spotify.com/track/${exampleId}?autoplay_ok=1` }
);
assert.throws(() => parseSpotifyTrackUrl("https://open.spotify.com/album/123"), /morceau Spotify/);
assert.throws(() => parseSpotifyTrackUrl("https://example.com/track/5AfQGPbNnm165WVCrfPnHT"), /open\.spotify\.com/);

assert.equal(sanitizeFilename('A/B:C*D?"E'), "A_B_C_D__E");
assert.equal(
  recordingFilename({ artist: "Artiste", title: "Titre" }),
  "Spytify Web/Artiste - Titre.mp3"
);
assert.equal(metadataSignature({ artist: " ARTISTE ", title: "Titre" }), "artiste\u0000titre");

// Les noms longs restent sous la limite des chemins Windows, sans couper un
// caractère et en gardant la mention « (extrait) » et l'extension.
{
  const baseName = (filename) => filename.slice("Spytify Web/".length, -".mp3".length);
  const longTitle = "Symphonie n° 9 en ré mineur, op. 125 « Chorale » : IV. Presto – Allegro assai ".repeat(4);
  const longArtist = "Orchestre philharmonique de Berlin, Herbert von Karajan, Gundula Janowitz ".repeat(3);
  for (const partial of [false, true]) {
    const filename = recordingFilename({ artist: longArtist, title: longTitle, partial });
    assert.ok(baseName(filename).length <= MAX_FILENAME_LENGTH, `${baseName(filename).length} unités`);
    assert.ok(filename.startsWith("Spytify Web/Orchestre philharmonique de Berlin"));
    assert.ok(filename.endsWith(partial ? "… (extrait).mp3" : "….mp3"));
    assert.ok(baseName(filename).split(" - ")[1].length >= 47, "Le titre garde une place suffisante.");
  }
  // Un nom court n'est pas modifié.
  assert.equal(recordingFilename({ artist: "A", title: "B", partial: true }), "Spytify Web/A - B (extrait).mp3");

  // Emoji, drapeaux et lettres décomposées ne sont jamais coupés en deux.
  const emojiTitle = "🎵".repeat(80);
  const emojiName = sanitizeFilename(emojiTitle, 50);
  assert.ok(emojiName.length <= 50);
  assert.equal(emojiName, `${"🎵".repeat(24)}…`);
  assert.doesNotThrow(() => encodeURIComponent(emojiName), "Aucune paire de substitution orpheline.");
  const flags = sanitizeFilename("🇫🇷".repeat(30), 21);
  assert.equal(flags, `${"🇫🇷".repeat(5)}…`, "Un drapeau (deux caractères régionaux) reste entier.");
  const decomposed = sanitizeFilename("é".repeat(30), 11);
  assert.equal(decomposed, `${"é".repeat(10)}…`, "La normalisation NFC précède la coupe.");
  assert.equal(sanitizeFilename("Titre.", 20), "Titre");
  assert.equal(sanitizeFilename(`${"a".repeat(18)}. bcd`, 20), `${"a".repeat(18)}…`, "Pas de point final avant les points de suspension.");

  // Les caractères de contrôle et de direction ne peuvent pas maquiller l'extension.
  assert.equal(sanitizeFilename("Titre‮gpj.exe\u007F"), "Titregpj.exe_");
  assert.equal(sanitizeFilename("..."), "Enregistrement Spotify");
}

const tag = createId3v24Tag({ title: "Été", artist: "Artiste", album: "Album" });
assert.equal(new TextDecoder().decode(tag.slice(0, 3)), "ID3");
assert.equal(tag[3], 4);
assert.ok(new TextDecoder().decode(tag).includes("Été"));

console.log("Tests core.js réussis");
