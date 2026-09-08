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

export function sanitizeFilename(value) {
  const cleaned = String(value ?? "")
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/[. ]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return (cleaned || "Enregistrement Spotify").slice(0, 160);
}

export function recordingFilename(metadata) {
  const artist = sanitizeFilename(metadata?.artist || "Artiste inconnu");
  const title = sanitizeFilename(metadata?.title || "Morceau Spotify");
  return `Spytify Web/${artist} - ${title}.mp3`;
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
