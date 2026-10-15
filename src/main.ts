import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ClassicVis, type VisMode } from "./classicVis";
import type { CaptureInfo, Frame, NowPlaying } from "./frame";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const vis = new ClassicVis($<HTMLCanvasElement>("vis"));
const MODES: VisMode[] = ["bars", "scope", "off"];
const MODE_LABEL: Record<VisMode, string> = { bars: "BARS", scope: "SCOPE", off: "OFF" };

function cycleVis() {
  vis.mode = MODES[(MODES.indexOf(vis.mode) + 1) % MODES.length];
  $("vis-mode").textContent = `VIS: ${MODE_LABEL[vis.mode]}`;
}
$("vis").addEventListener("click", cycleVis);
$("vis-mode").addEventListener("click", cycleVis);
$("milkdrop").addEventListener("click", () => invoke("open_milkdrop"));
$("close").addEventListener("click", () => getCurrentWindow().close());
$("minimize").addEventListener("click", () => getCurrentWindow().minimize());

function setMarquee(text: string) {
  $("marquee-text").textContent = `${text}  ***  `;
}
setMarquee("WinzAMP — waiting for system audio…");

let captureHint = "";
function showInfo(info: CaptureInfo) {
  $("khz").textContent = String(Math.round(info.sample_rate / 1000));
  $("mono").classList.toggle("on", info.channels === 1);
  $("stereo").classList.toggle("on", info.channels > 1);
  captureHint = `WinzAMP — passing through ${info.device}. Play anything.`;
  if (!np) setMarquee(captureHint);
}

const fmt = (secs: number) =>
  `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(Math.floor(secs % 60)).padStart(2, "0")}`;

// --- Now Playing (macOS MediaRemote bridge) -------------------------------
// When we know the track, the marquee and clock follow it; elapsed is
// extrapolated between updates using the reported playback rate.
let np: NowPlaying | null = null;
let npAt = 0; // performance.now() when `np` arrived

function onNowPlaying(info: NowPlaying) {
  np = info;
  npAt = performance.now();
  const name = [info.artist, info.title].filter(Boolean).join(" — ");
  setMarquee(name || captureHint || "WinzAMP");
}

function liveElapsed(): number {
  if (!np) return 0;
  const drift = np.playing ? ((performance.now() - npAt) / 1000) * (np.rate || 1) : 0;
  const e = np.elapsed + drift;
  return np.duration > 0 ? Math.min(e, np.duration) : e;
}

// --- audio frames: visualizer + level meter, and the clock when no track --
const SILENCE_RMS = 0.002;
let playedMs = 0;
let lastFrameAt = performance.now();

function onFrame(frame: Frame) {
  const now = performance.now();
  let sum = 0;
  for (let i = 0; i < frame.l.length; i++) {
    const s = ((frame.l[i] + frame.r[i]) / 2 - 128) / 128;
    sum += s * s;
  }
  const rms = Math.sqrt(sum / frame.l.length);
  const sound = rms > SILENCE_RMS;
  if (sound) playedMs += now - lastFrameAt;
  lastFrameAt = now;

  if (np) {
    $("time").textContent = fmt(liveElapsed());
    $("play-state").textContent = np.playing ? "▶" : "❚❚";
  } else {
    $("time").textContent = fmt(playedMs / 1000);
    $("play-state").textContent = sound ? "▶" : "❚❚";
  }
  $("level").style.width = `${Math.min(100, rms * 300)}%`;
  vis.draw(frame);
}

listen<Frame>("frame", (e) => onFrame(e.payload));
listen<CaptureInfo>("capture-started", (e) => showInfo(e.payload));
listen<string>("capture-error", (e) => setMarquee(`Capture error: ${e.payload}`));
listen<NowPlaying>("nowplaying", (e) => onNowPlaying(e.payload));
// Capture may have started before this page loaded.
invoke<CaptureInfo | null>("capture_info").then((info) => info && showInfo(info));
