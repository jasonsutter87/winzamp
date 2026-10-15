// Karaoke window. Three ways in, one pipeline:
//   1. Now Playing (macOS MediaRemote)  → accurate position + a track name.
//   2. Identify (ACRCloud fingerprint)  → the real name when #1 is junk
//      (YouTube video titles) or absent (FM radio, Android).
//   3. Whichever name we trust → LRCLIB synced lyrics, scrolled by position.
//
// Position prefers Now Playing's elapsed when we have it; otherwise it
// extrapolates from the fingerprint's play-offset.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { IdentifyStatus, NowPlaying } from "./frame";
import { fetchLyricsSmart, type Lyrics } from "./lyrics";

const $ = (id: string) => document.getElementById(id)!;
const linesEl = $("lines");
const msgEl = $("msg");

// Position source (Now Playing when present, else a synthesized track).
let pos: NowPlaying | null = null;
let posAt = 0;
// Name we last resolved lyrics for, and the raw key we last tried.
let resolvedKey = "";
let rawKey = "";
let triedIdentifyFor = "";
let lyrics: Lyrics | null = null;
let lineEls: HTMLElement[] = [];
let activeIdx = -1;

const keyOf = (artist: string | null, title: string | null) =>
  `${(artist ?? "").toLowerCase().trim()}\u0000${(title ?? "").toLowerCase().trim()}`;

function liveElapsed(): number {
  if (!pos) return 0;
  const drift = pos.playing ? ((performance.now() - posAt) / 1000) * (pos.rate || 1) : 0;
  return pos.elapsed + drift;
}

function showMessage(text: string) {
  msgEl.textContent = text;
  msgEl.style.display = "flex";
  linesEl.innerHTML = "";
  lineEls = [];
  activeIdx = -1;
}

function renderLyrics(l: Lyrics) {
  linesEl.innerHTML = "";
  lineEls = l.lines.map((ln) => {
    const el = document.createElement("div");
    el.className = "line";
    el.textContent = ln.text || "♪";
    linesEl.appendChild(el);
    return el;
  });
  activeIdx = -1;
  msgEl.style.display = l.lines.length ? "none" : "flex";
  if (!l.lines.length) msgEl.textContent = "🎵 (instrumental — no lyrics)";
}

/** Fetch + render lyrics for a resolved name. Returns true on a hit. */
async function loadLyricsFor(
  artist: string,
  title: string,
  album: string | null,
  duration: number,
): Promise<boolean> {
  const key = keyOf(artist, title);
  showMessage(`Looking up lyrics for “${title}”…`);
  try {
    const found = await fetchLyricsSmart(artist, title, album, duration);
    if (!found) return false;
    resolvedKey = key;
    lyrics = found;
    $("src").textContent = found.synced ? found.source : `${found.source} • no scroll`;
    renderLyrics(found);
    return true;
  } catch (e) {
    showMessage(`Lyrics lookup failed: ${e}`);
    return false;
  }
}

// --- Now Playing (position + first-guess name) ----------------------------
async function onNowPlaying(info: NowPlaying) {
  pos = info;
  posAt = performance.now();
  $("track").textContent = info.title ?? "—";
  $("artist").textContent = info.artist ?? "";

  const raw = keyOf(info.artist, info.title);
  if (raw === rawKey) return; // same track; just a position/state tick
  rawKey = raw;
  if (raw === resolvedKey) return; // already showing lyrics for this

  if (info.artist && info.title && (await loadLyricsFor(info.artist, info.title, info.album, info.duration))) {
    return;
  }
  // Metadata was junk or had no lyrics → fingerprint it (once per raw track).
  if (triedIdentifyFor !== raw) {
    triedIdentifyFor = raw;
    showMessage("🎧 Couldn't match the title — identifying by sound…");
    invoke("identify_song").catch(() => {});
  } else {
    showMessage(`No lyrics found for “${info.artist ?? "?"} — ${info.title ?? "?"}”.`);
  }
}

// --- Identification result (authoritative name) ---------------------------
async function onIdentified(info: NowPlaying) {
  $("track").textContent = info.title ?? "—";
  $("artist").textContent = info.artist ?? "";
  // No Now Playing position stream (radio/Android)? Use the fingerprint offset.
  if (!pos) {
    pos = info;
    posAt = performance.now();
  }
  if (info.artist && info.title) {
    const ok = await loadLyricsFor(info.artist, info.title, info.album, info.duration);
    if (!ok) showMessage(`Identified “${info.artist} — ${info.title}”, but no lyrics found.`);
  }
}

// --- scroll loop ----------------------------------------------------------
function tick() {
  requestAnimationFrame(tick);
  if (pos && pos.duration > 0) {
    $("prog").style.width = `${Math.min(100, (liveElapsed() / pos.duration) * 100)}%`;
  }
  if (!lyrics || !lyrics.synced || !lineEls.length) return;

  const t = liveElapsed();
  let idx = -1;
  for (let i = 0; i < lyrics.lines.length; i++) {
    if (lyrics.lines[i].t <= t) idx = i;
    else break;
  }
  if (idx === activeIdx) return;

  if (activeIdx >= 0) lineEls[activeIdx]?.classList.remove("active");
  lineEls.forEach((el, i) => el.classList.toggle("upcoming", i > idx && i <= idx + 3));
  if (idx >= 0) {
    const el = lineEls[idx];
    el.classList.add("active");
    linesEl.style.transform = `translateY(${-el.offsetTop - el.offsetHeight / 2}px)`;
  }
  activeIdx = idx;
}

// --- wiring ---------------------------------------------------------------
$("identify").addEventListener("click", () => {
  triedIdentifyFor = ""; // allow a manual retry even on the same raw track
  showMessage("🎧 Listening…");
  invoke("identify_song").catch(() => {});
});

listen<NowPlaying>("nowplaying", (e) => onNowPlaying(e.payload));
listen<NowPlaying>("identified", (e) => onIdentified(e.payload));
listen<IdentifyStatus>("identify-status", (e) => {
  const s = e.payload;
  if (s.stage === "unconfigured" || s.stage === "error" || s.stage === "nomatch") {
    showMessage(s.message);
  }
  $("src").textContent = s.stage.toUpperCase();
});

// Pull the current track immediately, in case we opened mid-song.
invoke<NowPlaying | null>("now_playing").then((info) => {
  if (info) onNowPlaying(info);
});
tick();
