// Milkdrop window: Butterchurn fed directly with the pass-through waveform.
// Keys: → / space next preset, ← previous, H toggles auto-cycling.
import butterchurnModule from "butterchurn";
import butterchurnPresetsModule from "butterchurn-presets";
import { listen } from "@tauri-apps/api/event";
import type { Frame } from "./frame";

// Both packages are webpack UMD builds of ES modules, so depending on the
// bundler's interop the real export may sit one level down under `default`.
const unwrap = <T>(m: T): T => (m as { default?: T }).default ?? m;
const butterchurn = unwrap(butterchurnModule);
const butterchurnPresets = unwrap(butterchurnPresetsModule);

const CYCLE_MS = 20_000;
const BLEND_SECS = 2.7;

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const label = document.getElementById("preset")!;

// Butterchurn requires an AudioContext even though we never route audio
// through it; it only reads the sample rate.
const viz = butterchurn.createVisualizer(new AudioContext(), canvas, {
  width: window.innerWidth,
  height: window.innerHeight,
  pixelRatio: window.devicePixelRatio || 1,
});

const presets = butterchurnPresets.getPresets();
const names = Object.keys(presets).sort(() => Math.random() - 0.5);
let index = 0;
let autoCycle = true;
let labelTimer = 0;

function loadPreset(i: number, blend = BLEND_SECS) {
  index = (i + names.length) % names.length;
  viz.loadPreset(presets[names[index]], blend);
  label.textContent = names[index];
  label.classList.add("show");
  clearTimeout(labelTimer);
  labelTimer = window.setTimeout(() => label.classList.remove("show"), 3000);
}
loadPreset(0, 0);
setInterval(() => autoCycle && loadPreset(index + 1), CYCLE_MS);

window.addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight" || e.key === " ") loadPreset(index + 1);
  else if (e.key === "ArrowLeft") loadPreset(index - 1);
  else if (e.key.toLowerCase() === "h") autoCycle = !autoCycle;
});

window.addEventListener("resize", () => {
  canvas.width = window.innerWidth * devicePixelRatio;
  canvas.height = window.innerHeight * devicePixelRatio;
  viz.setRendererSize(window.innerWidth, window.innerHeight);
});
window.dispatchEvent(new Event("resize"));

// Keep the latest frame and render on the display's own clock.
const latest = {
  timeByteArray: new Uint8Array(1024).fill(128),
  timeByteArrayL: new Uint8Array(1024).fill(128),
  timeByteArrayR: new Uint8Array(1024).fill(128),
};
listen<Frame>("frame", ({ payload }) => {
  latest.timeByteArrayL.set(payload.l);
  latest.timeByteArrayR.set(payload.r);
  for (let i = 0; i < 1024; i++)
    latest.timeByteArray[i] = (payload.l[i] + payload.r[i]) >> 1;
});

function tick() {
  viz.render({ audioLevels: latest });
  requestAnimationFrame(tick);
}
tick();
