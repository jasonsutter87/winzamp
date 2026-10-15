// Synced-lyrics lookup via LRCLIB (free, no key). We fetch straight from the
// webview; the app's CSP is open, and LRCLIB sends permissive CORS headers.
//
// LRCLIB etiquette asks for a descriptive User-Agent, but browsers forbid
// setting that header from fetch(), so we identify via the query instead and
// keep request volume low (one lookup per track change).

export interface LyricLine {
  /** Seconds from the start of the track. */
  t: number;
  text: string;
}

export interface Lyrics {
  lines: LyricLine[];
  synced: boolean; // false => plain lyrics only (no timing)
  source: string; // human-readable note for the UI
}

const BASE = "https://lrclib.net/api";

interface LrcLibRecord {
  syncedLyrics: string | null;
  plainLyrics: string | null;
  instrumental: boolean;
  trackName: string;
  artistName: string;
}

/** Parse one `.lrc` body into time-sorted lines. Supports multiple tags per line. */
export function parseLrc(lrc: string): LyricLine[] {
  const out: LyricLine[] = [];
  const tag = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
  for (const raw of lrc.split(/\r?\n/)) {
    const text = raw.replace(tag, "").trim();
    tag.lastIndex = 0;
    let m: RegExpExecArray | null;
    const stamps: number[] = [];
    while ((m = tag.exec(raw))) stamps.push(+m[1] * 60 + parseFloat(m[2]));
    for (const t of stamps) out.push({ t, text }); // keep blank lines as breaths
  }
  return out.sort((a, b) => a.t - b.t);
}

// --- YouTube-style metadata cleanup --------------------------------------
// YouTube reports the video title as the track and the channel as the artist,
// e.g. title "Queen - Bohemian Rhapsody (Official Video) [HD]", artist
// "Queen - Topic" or "QueenVEVO". We strip the junk and try a few candidate
// (artist, title) pairs so LRCLIB can match.

const JUNK =
  /[([][^)\]]*(?:official|video|audio|lyric|lyrics|visualizer|explicit|remaster|remastered|\bhd\b|\b4k\b|\bmv\b|m\/v|clip|version|hq)[^)\]]*[)\]]/gi;

function stripJunk(s: string): string {
  return s
    .replace(JUNK, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s*[-–—]\s*$/, "")
    .trim();
}

/** Turn a YouTube channel name into a plausible artist. */
function channelToArtist(a: string): string {
  return a
    .replace(/\s*-\s*Topic$/i, "")
    .replace(/VEVO$/i, "")
    .replace(/\s*Official(?:\s*(?:Channel|Music))?$/i, "")
    .trim();
}

const SEP = /\s[-–—]\s/;

/** Drop a trailing "feat./ft./featuring …" (and any bracket around it). */
function stripFeat(s: string): string {
  return s.replace(/\s*[([]?\s*(?:feat\.?|ft\.?|featuring)\b.*$/i, "").trim();
}

/** Ordered, de-duplicated (artist, title) guesses, best first. */
export function trackCandidates(
  artist: string,
  title: string,
): { artist: string; title: string }[] {
  const cands: { artist: string; title: string }[] = [];
  const add = (a: string, t: string) => {
    a = a.trim();
    t = t.trim();
    if (
      a &&
      t &&
      !cands.some(
        (c) =>
          c.artist.toLowerCase() === a.toLowerCase() &&
          c.title.toLowerCase() === t.toLowerCase(),
      )
    )
      cands.push({ artist: a, title: t });
  };

  const cleanArtist = channelToArtist(artist);
  const cleanTitle = stripJunk(title);

  // YouTube videos usually carry "Artist - Song" in the title itself. Try the
  // feat.-stripped form first (best LRCLIB hit rate), then the full form.
  if (SEP.test(cleanTitle)) {
    const [left, ...rest] = cleanTitle.split(SEP);
    const right = stripJunk(rest.join(" - "));
    add(left, stripFeat(right)); // Tyga / Molly
    add(cleanArtist, stripFeat(right)); // channel artist / Molly
    add(left, right); // Tyga / Molly ft. ...
    add(cleanArtist, right);
  }
  add(cleanArtist, stripFeat(cleanTitle));
  add(cleanArtist, cleanTitle);

  return cands;
}

async function getRecord(url: string): Promise<LrcLibRecord | null> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`LRCLIB ${res.status}`);
  return res.json();
}

function toLyrics(rec: LrcLibRecord | null): Lyrics | null {
  if (!rec) return null;
  if (rec.instrumental) return { lines: [], synced: false, source: "instrumental" };
  if (rec.syncedLyrics) {
    return { lines: parseLrc(rec.syncedLyrics), synced: true, source: "LRCLIB (synced)" };
  }
  if (rec.plainLyrics) {
    const lines = rec.plainLyrics
      .split(/\r?\n/)
      .map((text) => ({ t: 0, text }));
    return { lines, synced: false, source: "LRCLIB (plain, no timing)" };
  }
  return null;
}

/**
 * Look up lyrics for a track. Tries the exact signature first (best for synced
 * lyrics), then falls back to a fuzzy search.
 */
export async function fetchLyrics(
  artist: string,
  title: string,
  album: string | null,
  duration: number,
): Promise<Lyrics | null> {
  const q = (o: Record<string, string | number>) =>
    Object.entries(o)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");

  // 1. Exact get (requires a close duration match on LRCLIB's side).
  if (duration > 0) {
    const exact = await getRecord(
      `${BASE}/get?${q({
        artist_name: artist,
        track_name: title,
        album_name: album ?? "",
        duration: Math.round(duration),
      })}`,
    ).catch(() => null);
    const lyr = toLyrics(exact);
    if (lyr) return lyr;
  }

  // 2. Fuzzy search; prefer the first synced result, else the first result.
  const results: LrcLibRecord[] = await fetch(
    `${BASE}/search?${q({ track_name: title, artist_name: artist })}`,
  )
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => []);
  const best = results.find((r) => r.syncedLyrics) ?? results[0];
  return toLyrics(best ?? null);
}

/**
 * Lyrics lookup that tolerates YouTube-style metadata: it cleans the title,
 * splits "Artist - Song", and tries each candidate until one matches.
 */
export async function fetchLyricsSmart(
  artist: string,
  title: string,
  album: string | null,
  duration: number,
): Promise<Lyrics | null> {
  for (const c of trackCandidates(artist, title)) {
    const lyr = await fetchLyrics(c.artist, c.title, album, duration).catch(() => null);
    if (lyr) return lyr;
  }
  return null;
}
