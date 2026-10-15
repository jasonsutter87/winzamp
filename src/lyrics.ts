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
    .replace(/\s*[([]?\s*\bprod(?:\.|uced)?\s+by\b.*$/i, "") // "Prod. By Tony Fadd"
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
  // Leading \b so "Daft Punk" / "Left Hand Free" keep their "ft".
  return s.replace(/\s*[([]?\s*\b(?:feat\.?|ft\.?|featuring)(?=\s|$).*$/i, "").trim();
}

/** First-billed artist of a collaboration: "A & B", "A, B", "A x B", "A and B". */
function mainArtist(s: string): string {
  return s.split(/\s*(?:&|,|\sx\s|\sand\s)\s*/i)[0].trim();
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
  // Fingerprint services bill guests in the artist too ("A featuring B",
  // "A & B"), which LRCLIB usually files under the main artist alone.
  const soloArtist = stripFeat(cleanArtist);
  const artists = [cleanArtist, soloArtist, mainArtist(soloArtist)];
  // Last resort: drop every bracketed tag. Fingerprints often match an
  // alternate release — "(Acappella)", "(Radio Edit)", "(Clean)" — whose
  // words are the original's, filed under the plain title.
  const bareTitle = stripFeat(cleanTitle.replace(/\s*[([][^)\]]*[)\]]/g, ""));
  for (const t of [stripFeat(cleanTitle), cleanTitle, bareTitle]) for (const a of artists) add(a, t);

  return cands;
}

/** LRCLIB is throttling or overloaded; retrying right away only makes it worse. */
export class LyricsBusy extends Error {
  constructor() {
    super("The lyrics service is busy — try again in a minute.");
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET an LRCLIB endpoint. Returns the JSON, or null on 404. LRCLIB's 429/503
 * responses carry no CORS header, so the webview only sees a network error
 * (and can't read Retry-After); either way we back off and retry a few times,
 * then give up with LyricsBusy.
 */
const BACKOFF_MS = [2000, 5000, 10000];

async function lrclib<T>(path: string): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}${path}`, { headers: { Accept: "application/json" } }).catch(
      () => null,
    );
    if (res?.ok) return res.json();
    if (res?.status === 404) return null;
    if (attempt >= BACKOFF_MS.length) throw new LyricsBusy();
    await sleep(BACKOFF_MS[attempt]);
  }
}

const query = (o: Record<string, string | number>) =>
  Object.entries(o)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");

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
 * Exact signature lookup, cheap on LRCLIB's side. Album is left out on
 * purpose: fingerprint and YouTube albums rarely match LRCLIB's exactly, and a
 * mismatched album turns a hit into a 404.
 */
async function getExact(artist: string, title: string, duration: number): Promise<Lyrics | null> {
  const params: Record<string, string | number> = { artist_name: artist, track_name: title };
  if (duration > 0) params.duration = Math.round(duration);
  return toLyrics(await lrclib<LrcLibRecord>(`/get?${query(params)}`));
}

/** Fuzzy search; prefers the first synced result. Tightly rate-limited by LRCLIB. */
async function search(artist: string, title: string): Promise<Lyrics | null> {
  const results =
    (await lrclib<LrcLibRecord[]>(`/search?${query({ track_name: title, artist_name: artist })}`)) ?? [];
  return toLyrics(results.find((r) => r.syncedLyrics) ?? results[0] ?? null);
}

/** Searches are the scarce resource; don't spend more than this per track. */
const MAX_SEARCHES = 3;

/** Hits persist across launches, so replaying a song never touches LRCLIB. */
const cache = {
  get(key: string): Lyrics | null {
    try {
      const raw = localStorage.getItem(`lyrics:${key}`);
      return raw ? (JSON.parse(raw) as Lyrics) : null;
    } catch {
      return null;
    }
  },
  set(key: string, value: Lyrics) {
    try {
      localStorage.setItem(`lyrics:${key}`, JSON.stringify(value));
    } catch {
      // Storage full or unavailable; the cache is only an optimisation.
    }
  },
};

/**
 * Lyrics lookup that tolerates YouTube-style and fingerprint metadata: it
 * cleans the names, builds candidate (artist, title) pairs, tries a cheap
 * exact lookup for each, then a few fuzzy searches. Throws LyricsBusy if
 * LRCLIB is throttling, so the UI doesn't claim there are no lyrics.
 */
export async function fetchLyricsSmart(
  artist: string,
  title: string,
  duration: number,
): Promise<Lyrics | null> {
  const key = `${artist}\u0000${title}`.toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;

  const cands = trackCandidates(artist, title);
  let found: Lyrics | null = null;
  for (const c of cands) {
    if (!(found = await getExact(c.artist, c.title, duration))) continue;
    // The exact lookup returns LRCLIB's canonical entry, which may be plain
    // text even when another copy of the song is synced. One search to check;
    // if LRCLIB is busy, plain lyrics still beat none.
    if (!found.synced && found.lines.length) {
      const alt = await search(c.artist, c.title).catch(() => null);
      if (alt?.synced) found = alt;
    }
    break;
  }
  if (!found) {
    for (const c of cands.slice(0, MAX_SEARCHES)) {
      if ((found = await search(c.artist, c.title))) break;
    }
  }
  if (found) cache.set(key, found);
  return found;
}
