// Karaoke window: listens for Now Playing changes, fetches synced lyrics from
// LRCLIB, and scrolls them in time with the song. Song position comes from the
// MediaRemote bridge's elapsed/rate, extrapolated between updates.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { NowPlaying } from "./frame";
import { fetchLyricsSmart, type Lyrics } from "./lyrics";

const $ = (id: string) => document.getElementById(id)!;
const linesEl = $("lines");
const msgEl = $("msg");

let np: NowPlaying | null = null;
let npAt = 0;
let lyrics: Lyrics | null = null;
let trackKey = "";
let lineEls: HTMLElement[] = [];
let activeIdx = -1;

function liveElapsed(): number {
  if (!np) return 0;
  const drift = np.playing ? ((performance.now() - npAt) / 1000) * (np.rate || 1) : 0;
  return np.elapsed + drift;
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

async function onTrack(info: NowPlaying) {
  const key = `${info.artist}\u0000${info.title}`;
  $("track").textContent = info.title ?? "—";
  $("artist").textContent = info.artist ?? "";
  if (key === trackKey) return; // same song, just a position/state update
  trackKey = key;
  lyrics = null;
  $("src").textContent = "";

  if (!info.artist || !info.title) {
    showMessage("Waiting for a track with artist + title…");
    return;
  }
  showMessage(`Looking up lyrics for “${info.title}”…`);
  try {
    const found = await fetchLyricsSmart(info.artist, info.title, info.album, info.duration);
    if (trackKey !== key) return; // track changed while fetching
    if (!found) {
      showMessage(`No lyrics found for “${info.artist} — ${info.title}”.`);
      return;
    }
    lyrics = found;
    $("src").textContent = found.synced ? found.source : `${found.source} • no scroll`;
    renderLyrics(found);
  } catch (e) {
    showMessage(`Lyrics lookup failed: ${e}`);
  }
}

function tick() {
  requestAnimationFrame(tick);
  if (np && np.duration > 0) {
    $("prog").style.width = `${Math.min(100, (liveElapsed() / np.duration) * 100)}%`;
  }
  if (!lyrics || !lyrics.synced || !lineEls.length) return;

  const t = liveElapsed();
  // Find the last line whose timestamp has passed.
  let idx = -1;
  for (let i = 0; i < lyrics.lines.length; i++) {
    if (lyrics.lines[i].t <= t) idx = i;
    else break;
  }
  if (idx === activeIdx) return;

  if (activeIdx >= 0) lineEls[activeIdx]?.classList.remove("active");
  lineEls.forEach((el, i) =>
    el.classList.toggle("upcoming", i > idx && i <= idx + 3),
  );
  if (idx >= 0) {
    const el = lineEls[idx];
    el.classList.add("active");
    // Center the active line in the scroll viewport.
    linesEl.style.transform = `translateY(${-el.offsetTop - el.offsetHeight / 2}px)`;
  }
  activeIdx = idx;
}

listen<NowPlaying>("nowplaying", (e) => {
  np = e.payload;
  npAt = performance.now();
  onTrack(np);
});
// Pull the current track immediately, in case we opened mid-song.
invoke<NowPlaying | null>("now_playing").then((info) => {
  if (info) {
    np = info;
    npAt = performance.now();
    onTrack(info);
  }
});
tick();
