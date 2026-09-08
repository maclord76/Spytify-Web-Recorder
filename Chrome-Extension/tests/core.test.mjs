import assert from "node:assert/strict";
import {
  createId3v24Tag,
  metadataSignature,
  parseSpotifyTrackUrl,
  recordingFilename,
  sanitizeFilename
} from "../core.js";

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

const tag = createId3v24Tag({ title: "Été", artist: "Artiste", album: "Album" });
assert.equal(new TextDecoder().decode(tag.slice(0, 3)), "ID3");
assert.equal(tag[3], 4);
assert.ok(new TextDecoder().decode(tag).includes("Été"));

console.log("Tests core.js réussis");
