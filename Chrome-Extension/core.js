const SPOTIFY_TRACK_ID = /^[A-Za-z0-9]{22}$/;

export function parseSpotifyTrackUrl(value) {
  const input = String(value ?? "").trim();
  if (!input) {
    throw new Error("Collez d'abord l'URL d'un morceau Spotify.");
  }

  if (input.startsWith("spotify:track:")) {
    const trackId = input.slice("spotify:track:".length);
    if (!SPOTIFY_TRACK_ID.test(trackId)) {
      throw new Error("L'identifiant du morceau Spotify est invalide.");
    }
    return {
      trackId,
      url: `https://open.spotify.com/track/${trackId}?autoplay_ok=1`
    };
  }

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("L'URL Spotify n'est pas valide.");
  }

  if (parsed.protocol !== "https:" || parsed.hostname !== "open.spotify.com") {
    throw new Error("Utilisez une URL https://open.spotify.com/track/…");
  }

  const match = parsed.pathname.match(/^\/(?:intl-[^/]+\/)?track\/([A-Za-z0-9]{22})\/?$/);
  if (!match) {
    throw new Error("Cette URL ne correspond pas à un morceau Spotify.");
  }

  return {
    trackId: match[1],
    url: `https://open.spotify.com/track/${match[1]}?autoplay_ok=1`
  };
}

// Nom sans dossier ni extension, en unités UTF-16 comme les chemins Windows :
// avec le dossier Téléchargements, « Spytify Web\ », « .mp3 » et un éventuel
// « (12) » ajouté par Chrome, le chemin reste loin des 260 caractères.
export const MAX_FILENAME_LENGTH = 120;
const MAX_ARTIST_LENGTH = 60;

function graphemes(value) {
  if (typeof Intl?.Segmenter === "function") {
    return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value), (part) => part.segment);
  }
  return Array.from(value);
}

// Couper entre deux caractères visibles, jamais au milieu d'un emoji, d'une
// lettre accentuée décomposée ou d'une paire de substitution UTF-16.
function truncateText(value, maxLength) {
  if (value.length <= maxLength) return value;
  let result = "";
  for (const grapheme of graphemes(value)) {
    if (result.length + grapheme.length > maxLength - 1) break;
    result += grapheme;
  }
  return `${result.replace(/[. ]+$/g, "")}…`;
}

export function sanitizeFilename(value, maxLength = MAX_FILENAME_LENGTH) {
  const cleaned = String(value ?? "")
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001F\u007F]/g, "_")
    // Les marques de direction peuvent maquiller l'extension affichée.
    .replace(/[‎‏‪-‮⁦-⁩]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");

  return truncateText(cleaned || "Enregistrement Spotify", maxLength);
}

export function recordingFilename(metadata) {
  const suffix = metadata?.partial ? " (extrait)" : "";
  const artist = sanitizeFilename(metadata?.artist || "Artiste inconnu", MAX_ARTIST_LENGTH);
  // Le titre reçoit toute la place laissée par l'artiste, au moins 47 unités.
  const title = sanitizeFilename(
    metadata?.title || "Morceau Spotify",
    MAX_FILENAME_LENGTH - artist.length - " - ".length - suffix.length
  );
  return `Spytify Web/${artist} - ${title}${suffix}.mp3`;
}

// Durée « mm:ss » du compteur et des MP3 téléchargés.
export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// Nom d'un MP3 téléchargé, sans son dossier, suivi de sa durée enregistrée.
export function describeRecording(filename, durationSeconds) {
  const name = String(filename || "").replace(/^Spytify Web\//, "");
  return Number.isFinite(durationSeconds) ? `${name} (${formatDuration(durationSeconds)})` : name;
}

export function metadataSignature(metadata) {
  const title = String(metadata?.title || "").trim().toLocaleLowerCase("fr");
  const artist = String(metadata?.artist || "").trim().toLocaleLowerCase("fr");
  return title && artist ? `${artist}\u0000${title}` : "";
}

function synchsafe(value) {
  return new Uint8Array([
    (value >>> 21) & 0x7f,
    (value >>> 14) & 0x7f,
    (value >>> 7) & 0x7f,
    value & 0x7f
  ]);
}

function ascii(value) {
  return new Uint8Array([...value].map((character) => character.charCodeAt(0)));
}

function concatBytes(parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function id3Frame(id, payload) {
  return concatBytes([
    ascii(id),
    synchsafe(payload.length),
    new Uint8Array([0, 0]),
    payload
  ]);
}

function textFrame(id, value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }
  const encoded = new TextEncoder().encode(text);
  return id3Frame(id, concatBytes([new Uint8Array([3]), encoded]));
}

function coverFrame(cover) {
  if (!cover?.bytes?.length || !cover?.mimeType?.startsWith("image/")) {
    return null;
  }
  const mime = new TextEncoder().encode(cover.mimeType);
  const payload = concatBytes([
    new Uint8Array([3]),
    mime,
    new Uint8Array([0, 3, 0]),
    cover.bytes
  ]);
  return id3Frame("APIC", payload);
}

export function createId3v24Tag(metadata, cover = null) {
  const frames = [
    textFrame("TIT2", metadata?.title),
    textFrame("TPE1", metadata?.artist),
    textFrame("TALB", metadata?.album),
    textFrame("TSSE", "Spytify Web Recorder / lamejs"),
    coverFrame(cover)
  ].filter(Boolean);

  const body = concatBytes(frames);
  const header = concatBytes([
    ascii("ID3"),
    new Uint8Array([4, 0, 0]),
    synchsafe(body.length)
  ]);
  return concatBytes([header, body]);
}
