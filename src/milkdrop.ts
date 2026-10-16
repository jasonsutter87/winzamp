// Milkdrop window: Butterchurn fed directly with the pass-through waveform.
// Keys: → / space next preset, ← previous, H toggles auto-cycling.
import butterchurnModule from "butterchurn";
import butterchurnPresetsModule from "butterchurn-presets";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
// Butterchurn's final pass draws width x height *device* pixels, so hand it
// the backing-store size and pixelRatio 1, or Retina renders a quarter-size image.
const devicePx = () => {
  const dpr = window.devicePixelRatio || 1;
  return { width: Math.round(innerWidth * dpr), height: Math.round(innerHeight * dpr) };
};
const viz = butterchurn.createVisualizer(new AudioContext(), canvas, {
  ...devicePx(),
  pixelRatio: 1,
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

// Touch controls (phone): swipe left/right for next/previous preset, a plain
// tap for next, a two-finger tap toggles auto-cycle. Keyboard has no meaning on
// a dash-mounted phone, so this is the only way to drive it there.
const back = document.getElementById("back")!;
back.addEventListener("click", () => {
  // On Android these screens are pages in one webview (multi-window doesn't
  // work there), so Back navigates home; on desktop, close this window.
  if (/Android/i.test(navigator.userAgent)) {
    window.location.assign("index.html");
    return;
  }
  invoke("close_window", { label: getCurrentWindow().label }).catch(() =>
    getCurrentWindow()
      .close()
      .catch(() => history.back()),
  );
});

let touchX = 0;
let touchY = 0;
let touchMoved = false;
const canvasEl = canvas;
canvasEl.addEventListener(
  "touchstart",
  (e) => {
    if (e.touches.length >= 2) {
      autoCycle = !autoCycle;
      label.textContent = autoCycle ? "auto-cycle on" : "auto-cycle off";
      label.classList.add("show");
      clearTimeout(labelTimer);
      labelTimer = window.setTimeout(() => label.classList.remove("show"), 1500);
      return;
    }
    touchX = e.touches[0].clientX;
    touchY = e.touches[0].clientY;
    touchMoved = false;
  },
  { passive: true },
);
canvasEl.addEventListener(
  "touchend",
  (e) => {
    const t = e.changedTouches[0];
    const dx = t.clientX - touchX;
    const dy = t.clientY - touchY;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      loadPreset(dx < 0 ? index + 1 : index - 1); // swipe left = next
    } else if (!touchMoved) {
      loadPreset(index + 1); // tap = next
    }
  },
  { passive: true },
);
canvasEl.addEventListener(
  "touchmove",
  (e) => {
    const t = e.touches[0];
    if (Math.abs(t.clientX - touchX) > 10 || Math.abs(t.clientY - touchY) > 10) {
      touchMoved = true;
    }
  },
  { passive: true },
);

window.addEventListener("resize", () => {
  const { width, height } = devicePx();
  canvas.width = width;
  canvas.height = height;
  viz.setRendererSize(width, height);
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
