import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ClassicVis, type VisMode } from "./classicVis";
import type { CaptureInfo, Frame } from "./frame";

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

function showInfo(info: CaptureInfo) {
  $("khz").textContent = String(Math.round(info.sample_rate / 1000));
  $("mono").classList.toggle("on", info.channels === 1);
  $("stereo").classList.toggle("on", info.channels > 1);
  setMarquee(`WinzAMP — passing through ${info.device}. Play anything.`);
}

// "Time played": counts only while sound is actually coming through.
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
  const playing = rms > SILENCE_RMS;

  if (playing) playedMs += now - lastFrameAt;
  lastFrameAt = now;

  const secs = Math.floor(playedMs / 1000);
  $("time").textContent = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
  $("play-state").textContent = playing ? "▶" : "❚❚";
  $("level").style.width = `${Math.min(100, rms * 300)}%`;

  vis.draw(frame);
}

listen<Frame>("frame", (e) => onFrame(e.payload));
listen<CaptureInfo>("capture-started", (e) => showInfo(e.payload));
listen<string>("capture-error", (e) => setMarquee(`Capture error: ${e.payload}`));
// Capture may have started before this page loaded.
invoke<CaptureInfo | null>("capture_info").then((info) => info && showInfo(info));
