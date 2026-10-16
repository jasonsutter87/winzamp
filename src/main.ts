import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ClassicVis, type VisMode } from "./classicVis";
import type { CaptureInfo, Frame, IdentifyStatus, NowPlaying } from "./frame";
import { cachePut, customBytes, loadMuseumSkin, loadSkinBytes, MUSEUM_SKINS, type Skin } from "./skin";
import { SkinnedPlayer, type Action, type PlayerState, type Slider } from "./skinnedPlayer";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const vis = new ClassicVis($<HTMLCanvasElement>("vis"));
const MODES: VisMode[] = ["bars", "scope", "off"];
const MODE_LABEL: Record<VisMode, string> = { bars: "BARS", scope: "SCOPE", off: "OFF" };

function cycleVis() {
  vis.mode = MODES[(MODES.indexOf(vis.mode) + 1) % MODES.length];
  $("vis-mode").textContent = `VIS: ${MODE_LABEL[vis.mode]}`;
}
// Android can't do multiple windows, so on mobile the secondary screens are
// just other pages in this one webview (Tauri events keep flowing across a
// navigation). On desktop they stay real windows.
const isMobile = /Android/i.test(navigator.userAgent);
const openMilkdrop = () => (isMobile ? window.location.assign("milkdrop.html") : void invoke("open_milkdrop"));
const openKaraoke = () => (isMobile ? window.location.assign("karaoke.html") : void invoke("open_karaoke"));
const openEq = () => (isMobile ? window.location.assign("eq.html") : void invoke("open_eq"));
const identify = () => invoke("identify_song").catch(() => {});

$("vis").addEventListener("click", cycleVis);
$("vis-mode").addEventListener("click", cycleVis);
$("milkdrop").addEventListener("click", openMilkdrop);
$("karaoke").addEventListener("click", openKaraoke);
$("eq").addEventListener("click", openEq);
$("identify").addEventListener("click", identify);
$("close").addEventListener("click", () => getCurrentWindow().close());
$("minimize").addEventListener("click", () => getCurrentWindow().minimize());

let marquee = "";
function setMarquee(text: string) {
  marquee = text;
  if (performance.now() >= flashUntil) $("marquee-text").textContent = `${text}  ***  `;
}

// A short-lived marquee message (e.g. "Volume: 45%"), then back to the title.
let flashText = "";
let flashUntil = 0;
let flashTimer = 0;
function flash(text: string, ms = 1200) {
  flashText = text;
  flashUntil = performance.now() + ms;
  $("marquee-text").textContent = text;
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => setMarquee(marquee), ms);
}
const shownMarquee = () => (performance.now() < flashUntil ? flashText : marquee);
setMarquee("WinzAMP — waiting for system audio…");

let captureHint = "";
let khz = "";
let channels = 0;
function showInfo(info: CaptureInfo) {
  khz = String(Math.round(info.sample_rate / 1000));
  channels = info.channels;
  $("khz").textContent = khz;
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
let hearing = false; // sound in the latest frame

function onFrame(frame: Frame) {
  const now = performance.now();
  let sum = 0;
  for (let i = 0; i < frame.l.length; i++) {
    const s = ((frame.l[i] + frame.r[i]) / 2 - 128) / 128;
    sum += s * s;
  }
  const rms = Math.sqrt(sum / frame.l.length);
  hearing = rms > SILENCE_RMS;
  if (hearing) playedMs += now - lastFrameAt;
  lastFrameAt = now;

  $("time").textContent = fmt(clockSeconds());
  $("play-state").textContent = isPlaying() ? "▶" : "❚❚";
  $("level").style.width = `${Math.min(100, rms * 300)}%`;
  vis.draw(frame);
}

const isPlaying = () => (np ? np.playing : hearing);
const clockSeconds = () => (np ? liveElapsed() : playedMs / 1000);

listen<Frame>("frame", (e) => onFrame(e.payload));
listen<CaptureInfo>("capture-started", (e) => showInfo(e.payload));
listen<string>("capture-error", (e) => setMarquee(`Capture error: ${e.payload}`));
listen<NowPlaying>("nowplaying", (e) => onNowPlaying(e.payload));
listen<NowPlaying>("identified", (e) => onNowPlaying(e.payload));
listen<IdentifyStatus>("identify-status", (e) => setMarquee(`🎧 ${e.payload.message}`));
// Capture may have started before this page loaded.
invoke<CaptureInfo | null>("capture_info").then((info) => info && showInfo(info));

// --- classic .wsz skins ------------------------------------------------------
// "default" is the built-in WinzAMP look above; anything else draws the
// classic main window from a skin onto #skin.

const skinState = (): PlayerState => ({
  // The bitmap font has no emoji; drop them rather than show blanks.
  marquee: shownMarquee().replace(/\p{Extended_Pictographic}️?/gu, "").trim(),
  seconds: clockSeconds(),
  playState: isPlaying() ? "playing" : np || playedMs > 0 ? "paused" : "stopped",
  kbps: "pcm",
  khz,
  channels,
  progress: np && np.duration > 0 ? liveElapsed() / np.duration : null,
  volume: volume.muted ? 0 : volume.level,
  balance: volume.balance,
  vis: $<HTMLCanvasElement>("vis"),
});

const mediaKey = (key: string) =>
  invoke("media_key", { key }).catch((e) => setMarquee(`Media key failed: ${e}`));

function onSkinAction(a: Action) {
  switch (a) {
    case "prev":
      return mediaKey("prev");
    case "next":
      return mediaKey("next");
    case "stop":
      return mediaKey("stop");
    // There's only a play/pause toggle key, so only press it when it would
    // actually change the state the button asks for.
    case "play":
      return isPlaying() ? undefined : mediaKey("playpause");
    case "pause":
      return isPlaying() ? mediaKey("playpause") : undefined;
    case "eject":
    case "options":
      return openSkinMenu();
    case "eq":
      return openEq();
    case "pl":
      return openKaraoke();
    case "identify":
      return identify();
    case "vis":
      return cycleVis();
    case "minimize":
      return getCurrentWindow().minimize();
    case "close":
      return getCurrentWindow().close();
    // shade/shuffle/repeat have nothing to drive in a pass-through player.
  }
}

// --- system volume -----------------------------------------------------------
// The skin's sliders and the mouse wheel set the real Windows volume and L/R
// balance; polling picks up changes made elsewhere (keyboard keys, the
// volume flyout, Sound settings).
const volume = { level: 1, muted: false, balance: 0 };
let volumeTouchedAt = 0;

/** Send only the newest value while a call is in flight, so drags don't queue up. */
function coalesced(command: string, arg: string) {
  let busy = false;
  let pending: number | null = null;
  const send = (value: number) => {
    pending = value;
    if (busy) return;
    busy = true;
    void (async () => {
      while (pending !== null) {
        const next = pending;
        pending = null;
        await invoke(command, { [arg]: next }).catch((e) => flash(`${e}`, 3000));
      }
      busy = false;
    })();
  };
  return Object.assign(send, { busy: () => busy });
}
const sendVolume = coalesced("set_volume", "level");
const sendBalance = coalesced("set_balance", "balance");

function setVolume(level: number) {
  volume.level = Math.max(0, Math.min(1, level));
  volume.muted = false;
  volumeTouchedAt = performance.now();
  flash(`Volume: ${Math.round(volume.level * 100)}%`);
  sendVolume(volume.level);
}

function setBalance(balance: number) {
  volume.balance = Math.max(-1, Math.min(1, balance));
  volumeTouchedAt = performance.now();
  const pct = Math.round(Math.abs(volume.balance) * 100);
  flash(pct === 0 ? "Balance: Center" : `Balance: ${pct}% ${volume.balance < 0 ? "Left" : "Right"}`);
  sendBalance(volume.balance);
}

async function pollVolume() {
  // Don't fight the user mid-drag.
  if (sendVolume.busy() || sendBalance.busy() || performance.now() - volumeTouchedAt < 1500) return;
  const v = await invoke<typeof volume>("get_volume").catch(() => null);
  if (v) Object.assign(volume, v);
}
void pollVolume();
setInterval(pollVolume, 1000);

window.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    setVolume((volume.muted ? 0 : volume.level) + (e.deltaY < 0 ? 0.05 : -0.05));
  },
  { passive: false },
);

const skinned = new SkinnedPlayer(
  $<HTMLCanvasElement>("skin"),
  skinState,
  onSkinAction,
  () => getCurrentWindow().startDragging(),
  (kind: Slider, value: number) => (kind === "volume" ? setVolume(value) : setBalance(value)),
);

// --- auto-identify -----------------------------------------------------------
// Rust watches the audio for song changes (silence gaps, plus a periodic check
// for crossfades) and re-identifies on its own; this just remembers the toggle.
const AUTO_ID_KEY = "autoIdentify";
let autoIdentify = true;
try {
  autoIdentify = localStorage.getItem(AUTO_ID_KEY) !== "off";
} catch {
  // Default on.
}
void invoke("set_auto_identify", { enabled: autoIdentify });

function toggleAutoIdentify() {
  autoIdentify = !autoIdentify;
  void invoke("set_auto_identify", { enabled: autoIdentify });
  try {
    localStorage.setItem(AUTO_ID_KEY, autoIdentify ? "on" : "off");
  } catch {
    // Not remembered across launches; fine.
  }
  flash(`Auto-identify ${autoIdentify ? "on" : "off"}`);
}

const SKIN_KEY = "skin";
let currentSkin = "default";

function readSkinPref(): string {
  try {
    return localStorage.getItem(SKIN_KEY) ?? "default";
  } catch {
    return "default";
  }
}

async function applySkin(id: string) {
  let skin: Skin | null = null;
  if (id !== "default") {
    const name = MUSEUM_SKINS.find((s) => s.md5 === id)?.name ?? "your skin";
    setMarquee(`Loading ${name}…`);
    try {
      if (id === "custom") {
        const bytes = await customBytes();
        if (!bytes) throw new Error("no custom skin saved");
        skin = await loadSkinBytes(bytes);
      } else {
        skin = await loadMuseumSkin(id);
      }
    } catch (e) {
      setMarquee(`Couldn't load ${name}: ${e}`);
      return;
    }
    setMarquee(np ? [np.artist, np.title].filter(Boolean).join(" — ") : captureHint || "WinzAMP");
  }
  currentSkin = id;
  try {
    localStorage.setItem(SKIN_KEY, id);
  } catch {
    // Not remembered across launches; fine.
  }
  vis.setPalette(skin?.viscolor ?? null);
  skinned.setSkin(skin);
  document.body.classList.toggle("skinned", !!skin);
}

async function loadSkinFile(file: File) {
  try {
    const bytes = await file.arrayBuffer();
    await loadSkinBytes(bytes); // validate before replacing the saved one
    await cachePut("custom", bytes);
    await applySkin("custom");
  } catch (e) {
    setMarquee(`Not a usable skin (${file.name}): ${e}`);
  }
}

async function showSkinMenu() {
  const pick = (id: string) => () => void applySkin(id);
  const items = [
    await CheckMenuItem.new({ text: "WinzAMP (built-in)", checked: currentSkin === "default", action: pick("default") }),
    await PredefinedMenuItem.new({ item: "Separator" }),
    ...(await Promise.all(
      MUSEUM_SKINS.map((s) => CheckMenuItem.new({ text: s.name, checked: currentSkin === s.md5, action: pick(s.md5) })),
    )),
    await PredefinedMenuItem.new({ item: "Separator" }),
    ...(currentSkin === "custom" ? [await CheckMenuItem.new({ text: "Your skin", checked: true, action: pick("custom") })] : []),
    await MenuItem.new({ text: "Load .wsz skin…", action: () => $("skin-file").click() }),
    await MenuItem.new({ text: "Browse more at skins.webamp.org", action: () => void openUrl("https://skins.webamp.org/") }),
    await PredefinedMenuItem.new({ item: "Separator" }),
    await MenuItem.new({ text: "Equalizer", action: () => void openEq() }),
    await MenuItem.new({ text: "Milkdrop", action: () => void openMilkdrop() }),
    await MenuItem.new({ text: "Karaoke", action: () => void openKaraoke() }),
    await MenuItem.new({ text: "Identify song", action: () => void identify() }),
    await CheckMenuItem.new({ text: "Auto-identify songs", checked: autoIdentify, action: toggleAutoIdentify }),
  ];
  await (await Menu.new({ items })).popup();
}

// Touch devices (Android) have no right-click and native menus don't render,
// so the menu becomes an in-page sheet — which also doubles as the main nav on
// a phone (skins + open Milkdrop/Karaoke/EQ/Identify).
const openSkinMenu = () => (isMobile ? showSkinSheet() : showSkinMenu());

function showSkinSheet() {
  document.getElementById("skin-sheet")?.remove();
  const sheet = document.createElement("div");
  sheet.id = "skin-sheet";
  const close = () => sheet.remove();

  const row = (label: string, onTap: () => void, checked = false) => {
    const b = document.createElement("button");
    b.className = "sheet-row";
    b.textContent = checked ? `✓ ${label}` : label;
    b.addEventListener("click", () => {
      close();
      onTap();
    });
    return b;
  };
  const sep = (text: string) => {
    const d = document.createElement("div");
    d.className = "sheet-sep";
    d.textContent = text;
    return d;
  };

  const panel = document.createElement("div");
  panel.className = "sheet-panel";
  const head = document.createElement("div");
  head.className = "sheet-head";
  head.innerHTML = "<span>WinzAMP</span>";
  const x = document.createElement("button");
  x.className = "sheet-x";
  x.textContent = "✕";
  x.addEventListener("click", close);
  head.appendChild(x);
  panel.appendChild(head);

  panel.appendChild(sep("Skins"));
  panel.appendChild(row("WinzAMP (built-in)", () => void applySkin("default"), currentSkin === "default"));
  for (const s of MUSEUM_SKINS) {
    panel.appendChild(row(s.name, () => void applySkin(s.md5), currentSkin === s.md5));
  }
  panel.appendChild(row("Load .wsz skin…", () => $("skin-file").click()));

  panel.appendChild(sep("Open"));
  panel.appendChild(row("Karaoke 🎤", openKaraoke));
  panel.appendChild(row("Milkdrop 🌀", openMilkdrop));
  panel.appendChild(row("Equalizer 🎛️", openEq));
  panel.appendChild(row("Identify song 🎧", identify));
  panel.appendChild(row("Auto-identify songs", toggleAutoIdentify, autoIdentify));

  sheet.appendChild(panel);
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet) close(); // tap the backdrop to dismiss
  });
  document.body.appendChild(sheet);
}

$("skin-menu").addEventListener("click", openSkinMenu);
window.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  void openSkinMenu();
});
$<HTMLInputElement>("skin-file").addEventListener("change", (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) void loadSkinFile(file);
});

// Drag a .wsz onto the window to wear it.
window.addEventListener("dragover", (e) => {
  e.preventDefault();
  document.body.classList.add("dropping");
});
window.addEventListener("dragleave", () => document.body.classList.remove("dropping"));
window.addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("dropping");
  const file = e.dataTransfer?.files[0];
  if (file) void loadSkinFile(file);
});

void applySkin(readSkinPref());
