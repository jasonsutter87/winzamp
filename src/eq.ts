// Equalizer window. Ten band sliders + a preamp drive the native EQ engine
// (src-tauri/src/eqengine.rs) over two commands:
//   eq_enable(on, preamp, bands)  — turn the engine on/off (and set gains)
//   eq_set(preamp, bands)         — update gains while it's running
// Gains are in dB; bands are the classic Winamp centers.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

const BAND_LABELS = ["60", "170", "310", "600", "1K", "3K", "6K", "12K", "14K", "16K"];
const RANGE = 12; // ±dB

// preamp + 10 bands, in dB.
type Preset = { preamp: number; bands: number[] };
const PRESETS: Record<string, Preset> = {
  flat: { preamp: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  rock: { preamp: 0, bands: [4, 3, 1, -1, -1, 1, 3, 4, 4, 4] },
  pop: { preamp: 0, bands: [-1, 0, 2, 3, 3, 2, 0, -1, -1, -1] },
  bass: { preamp: 0, bands: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  treble: { preamp: 0, bands: [0, 0, 0, 0, 0, 2, 4, 5, 6, 6] },
  vocal: { preamp: 0, bands: [-2, -1, 0, 2, 3, 3, 2, 1, 0, -1] },
  loudness: { preamp: 2, bands: [5, 3, 0, 0, -1, 0, 1, 3, 5, 5] },
};

const $ = (id: string) => document.getElementById(id)!;

// On a phone these screens are pages in one webview (multi-window doesn't work
// on Android), so Back navigates home; on desktop they're real windows, so
// Back closes this one.
const isAndroid = /Android/i.test(navigator.userAgent);
function goBack() {
  if (isAndroid) {
    window.location.assign("index.html");
    return;
  }
  invoke("close_window", { label: getCurrentWindow().label }).catch(() =>
    getCurrentWindow()
      .close()
      .catch(() => history.back()),
  );
}
$("back").addEventListener("click", goBack);

const bandsEl = $("bands");
const powerBtn = $("power") as HTMLButtonElement;
const presetSel = $("preset") as HTMLSelectElement;
const statusEl = $("status");

let on = false;
const sliders: HTMLInputElement[] = []; // [preamp, band0..band9]

function makeSlot(label: string, preamp = false): HTMLInputElement {
  const slot = document.createElement("div");
  slot.className = preamp ? "slot preamp" : "slot";
  const val = document.createElement("div");
  val.className = "val";
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(-RANGE);
  input.max = String(RANGE);
  input.step = "1";
  input.value = "0";
  const lbl = document.createElement("div");
  lbl.className = "lbl";
  lbl.textContent = label;
  const show = () => (val.textContent = `${+input.value > 0 ? "+" : ""}${input.value}`);
  show();
  input.addEventListener("input", () => {
    show();
    apply();
  });
  slot.append(val, input, lbl);
  bandsEl.appendChild(slot);
  return input;
}

function readState(): Preset {
  return {
    preamp: +sliders[0].value,
    bands: sliders.slice(1).map((s) => +s.value),
  };
}

let pending = false;
function apply() {
  if (!on || pending) return;
  // Coalesce rapid slider moves into one call per frame.
  pending = true;
  requestAnimationFrame(async () => {
    pending = false;
    const { preamp, bands } = readState();
    try {
      await invoke("eq_set", { preamp, bands });
      status("");
    } catch (e) {
      status(`${e}`);
    }
  });
}

function setPreset(p: Preset) {
  sliders[0].value = String(p.preamp);
  sliders.slice(1).forEach((s, i) => (s.value = String(p.bands[i] ?? 0)));
  sliders.forEach((s) => s.dispatchEvent(new Event("input"))); // refresh labels
  apply();
}

async function setPower(next: boolean) {
  const { preamp, bands } = readState();
  try {
    await invoke("eq_enable", { on: next, preamp, bands });
    on = next;
    powerBtn.textContent = on ? "ON" : "OFF";
    powerBtn.classList.toggle("on", on);
    status(on ? "EQ is live — shaping your system audio." : "EQ off (audio untouched).");
  } catch (e) {
    status(`${e}`);
  }
}

function status(msg: string) {
  statusEl.textContent = msg;
}

// --- build UI -------------------------------------------------------------
sliders.push(makeSlot("PRE", true));
BAND_LABELS.forEach((l) => sliders.push(makeSlot(l)));

// A phone has no system-audio EQ hook (no Core Audio process tap like macOS,
// no Equalizer APO like Windows), so the engine genuinely can't run here. Say
// so plainly rather than present a toggle that errors when tapped.
if (isAndroid) {
  powerBtn.disabled = true;
  presetSel.disabled = true;
  sliders.forEach((s) => (s.disabled = true));
  status("EQ runs in the desktop app (macOS/Windows). A phone has no system-audio EQ hook.");
} else {
  powerBtn.addEventListener("click", () => setPower(!on));
  presetSel.addEventListener("change", () => setPreset(PRESETS[presetSel.value] ?? PRESETS.flat));

  // Sync with the engine in case it was already running (e.g. window reopened).
  invoke<boolean>("eq_running")
    .then((running) => {
      on = running;
      powerBtn.textContent = on ? "ON" : "OFF";
      powerBtn.classList.toggle("on", on);
    })
    .catch(() => {});
}
