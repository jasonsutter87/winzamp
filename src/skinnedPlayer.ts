// The classic 275x116 Winamp main window, drawn from a skin's sprite sheets
// onto a canvas (shown at 2x, which is exactly our 550x232 window).
//
// Sprite rectangles and element positions follow the classic skin format's
// well-known layout (as documented by the skinning community and Webamp).
import type { SheetName, Skin } from "./skin";

export const W = 275;
export const H = 116;

export type Action =
  | "options"
  | "minimize"
  | "shade"
  | "close"
  | "prev"
  | "play"
  | "pause"
  | "stop"
  | "next"
  | "eject"
  | "shuffle"
  | "repeat"
  | "eq"
  | "pl"
  | "identify"
  | "vis";

export interface PlayerState {
  marquee: string;
  seconds: number;
  playState: "playing" | "paused" | "stopped";
  kbps: string;
  khz: string;
  channels: number; // 0 = unknown
  progress: number | null; // 0..1 when the track length is known
  volume: number; // 0..1 system volume
  balance: number; // -1 (left) .. 1 (right)
  vis: HTMLCanvasElement; // the 76x16 ClassicVis canvas
}

/** A clickable sprite: where it sits, and its up/down source rects. */
interface Button {
  action: Action;
  sheet: SheetName;
  x: number;
  y: number;
  w: number;
  h: number;
  up: [number, number];
  down: [number, number];
}

const BUTTONS: Button[] = [
  { action: "options", sheet: "titlebar", x: 6, y: 3, w: 9, h: 9, up: [0, 0], down: [0, 9] },
  { action: "minimize", sheet: "titlebar", x: 244, y: 3, w: 9, h: 9, up: [9, 0], down: [9, 9] },
  { action: "shade", sheet: "titlebar", x: 254, y: 3, w: 9, h: 9, up: [0, 18], down: [9, 18] },
  { action: "close", sheet: "titlebar", x: 264, y: 3, w: 9, h: 9, up: [18, 0], down: [18, 9] },
  { action: "prev", sheet: "cbuttons", x: 16, y: 88, w: 23, h: 18, up: [0, 0], down: [0, 18] },
  { action: "play", sheet: "cbuttons", x: 39, y: 88, w: 23, h: 18, up: [23, 0], down: [23, 18] },
  { action: "pause", sheet: "cbuttons", x: 62, y: 88, w: 23, h: 18, up: [46, 0], down: [46, 18] },
  { action: "stop", sheet: "cbuttons", x: 85, y: 88, w: 23, h: 18, up: [69, 0], down: [69, 18] },
  { action: "next", sheet: "cbuttons", x: 108, y: 88, w: 22, h: 18, up: [92, 0], down: [92, 18] },
  { action: "eject", sheet: "cbuttons", x: 136, y: 89, w: 22, h: 16, up: [114, 0], down: [114, 16] },
  { action: "shuffle", sheet: "shufrep", x: 164, y: 89, w: 47, h: 15, up: [28, 0], down: [28, 15] },
  { action: "repeat", sheet: "shufrep", x: 210, y: 89, w: 28, h: 15, up: [0, 0], down: [0, 15] },
  { action: "eq", sheet: "shufrep", x: 219, y: 58, w: 23, h: 12, up: [0, 61], down: [46, 61] },
  { action: "pl", sheet: "shufrep", x: 242, y: 58, w: 23, h: 12, up: [23, 61], down: [69, 61] },
  // Clutter bar "I" (file info) — here: identify the song by sound.
  { action: "identify", sheet: "titlebar", x: 10, y: 40, w: 8, h: 7, up: [-1, -1], down: [320, 62] },
];

/** Non-sprite hot zones. */
const ZONES: { action: Action; x: number; y: number; w: number; h: number }[] = [
  { action: "vis", x: 24, y: 43, w: 76, h: 16 },
];

const TIME_DIGITS_X = [48, 60, 78, 90];
// Volume and balance sliders: a track with a 14px thumb. volume.bmp and
// balance.bmp each hold 28 fill frames, 15px apart.
export type Slider = "volume" | "balance";
const SLIDERS: Record<Slider, { x: number; y: number; w: number; h: number; sx: number }> = {
  volume: { x: 107, y: 57, w: 68, h: 13, sx: 0 },
  balance: { x: 177, y: 57, w: 38, h: 13, sx: 9 },
};
const THUMB = 14;
/** Balance snaps to centre within this much, as Winamp's does. */
const BALANCE_SNAP = 0.12;

/** Slider value for a thumb-centre x: volume 0..1, balance -1..1. */
function sliderValue(kind: Slider, x: number): number {
  const s = SLIDERS[kind];
  const t = Math.max(0, Math.min(1, (x - s.x - THUMB / 2) / (s.w - THUMB)));
  if (kind === "volume") return t;
  const b = t * 2 - 1;
  return Math.abs(b) < BALANCE_SNAP ? 0 : b;
}
const MARQUEE = { x: 111, y: 27, w: 154 };

// text.bmp: 5x6 glyphs, rows of 31.
const GLYPH_W = 5;
const GLYPH_H = 6;
const FONT: Record<string, [number, number]> = (() => {
  const map: Record<string, [number, number]> = {};
  "abcdefghijklmnopqrstuvwxyz".split("").forEach((c, i) => (map[c] = [0, i]));
  map['"'] = [0, 26];
  map["@"] = [0, 27];
  map[" "] = [0, 30];
  "0123456789".split("").forEach((c, i) => (map[c] = [1, i]));
  "….:()-'!_+\\/[]^&%,=$#".split("").forEach((c, i) => (map[c] = [1, 10 + i]));
  "åöä?*".split("").forEach((c, i) => (map[c] = [2, i]));
  // Close-enough stand-ins for characters the font lacks.
  Object.assign(map, { "<": map["("], ">": map[")"], "{": map["("], "}": map[")"], "|": map["!"], "~": map["-"], ";": map[":"], "`": map["'"], "—": map["-"], "–": map["-"], "*": map["*"] });
  return map;
})();

function glyphFor(ch: string): [number, number] {
  const lower = ch.toLowerCase();
  return FONT[lower] ?? FONT[lower.normalize("NFD").replace(/[̀-ͯ]/g, "")] ?? FONT[" "];
}

export class SkinnedPlayer {
  private ctx: CanvasRenderingContext2D;
  private skin: Skin | null = null;
  private pressed: Button | null = null;
  private dragging: Slider | null = null;
  private hover = false;
  private raf = 0;
  private strip: HTMLCanvasElement | null = null; // pre-rendered marquee text
  private stripText = "";
  private scrollStart = performance.now();

  constructor(
    private canvas: HTMLCanvasElement,
    private state: () => PlayerState,
    private onAction: (a: Action) => void,
    private onDrag: () => void,
    private onSlider: (kind: Slider, value: number, done: boolean) => void,
  ) {
    canvas.width = W;
    canvas.height = H;
    this.ctx = canvas.getContext("2d")!;
    this.ctx.imageSmoothingEnabled = false;
    canvas.addEventListener("mousedown", (e) => this.down(e));
    window.addEventListener("mouseup", (e) => this.up(e));
    canvas.addEventListener("mousemove", (e) => {
      this.hover = !!this.pressed && this.hit(e) === this.pressed;
    });
    window.addEventListener("mousemove", (e) => {
      if (this.dragging) this.onSlider(this.dragging, sliderValue(this.dragging, this.point(e)[0]), false);
    });
  }

  setSkin(skin: Skin | null) {
    this.skin = skin;
    this.strip = null; // text.bmp may differ
    cancelAnimationFrame(this.raf);
    if (skin) this.loop();
  }

  // --- input ----------------------------------------------------------------

  private point(e: MouseEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [((e.clientX - r.left) * W) / r.width, ((e.clientY - r.top) * H) / r.height];
  }

  private hit(e: MouseEvent): Button | null {
    const [x, y] = this.point(e);
    return BUTTONS.find((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) ?? null;
  }

  private down(e: MouseEvent) {
    if (e.button !== 0) return;
    const b = this.hit(e);
    if (b) {
      this.pressed = b;
      this.hover = true;
      return;
    }
    const [x, y] = this.point(e);
    const slider = (Object.keys(SLIDERS) as Slider[]).find((k) => {
      const r = SLIDERS[k];
      return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
    });
    if (slider) {
      this.dragging = slider;
      this.onSlider(slider, sliderValue(slider, x), false);
      return;
    }
    const zone = ZONES.find((z) => x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h);
    if (zone) this.onAction(zone.action);
    else this.onDrag(); // like Winamp: drag the window from any dead space
  }

  private up(e: MouseEvent) {
    if (this.dragging) {
      const kind = this.dragging;
      this.dragging = null;
      this.onSlider(kind, sliderValue(kind, this.point(e)[0]), true);
    }
    const b = this.pressed;
    this.pressed = null;
    if (b && e.button === 0 && this.hit(e) === b) this.onAction(b.action);
  }

  // --- drawing --------------------------------------------------------------

  private loop = () => {
    this.draw();
    this.raf = requestAnimationFrame(this.loop);
  };

  /** drawImage from a sheet, skipping rects the sheet is too small for. */
  private blit(sheet: SheetName, sx: number, sy: number, w: number, h: number, dx: number, dy: number) {
    const img = this.skin?.sheets[sheet];
    if (!img || sx < 0 || sx + w > img.width || sy + h > img.height) return;
    this.ctx.drawImage(img, sx, sy, w, h, dx, dy, w, h);
  }

  private draw() {
    const s = this.state();
    const ctx = this.ctx;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    this.blit("main", 0, 0, W, H, 0, 0);
    this.blit("titlebar", 27, document.hasFocus() ? 0 : 15, W, 14, 0, 0);
    this.blit("titlebar", 304, 0, 8, 43, 10, 22); // clutter bar

    // Play state indicator.
    const ps = { playing: 0, paused: 9, stopped: 18 }[s.playState];
    this.blit("playpaus", ps, 0, 9, 9, 26, 28);
    if (s.playState === "playing") this.blit("playpaus", 39, 0, 3, 9, 24, 28);

    // Clock (mm:ss); nums_ex.bmp wins over numbers.bmp when present.
    const digits = this.skin?.sheets.nums_ex ? "nums_ex" : "numbers";
    const secs = Math.min(Math.floor(s.seconds), 99 * 60 + 59);
    const t = [Math.floor(secs / 600), Math.floor(secs / 60) % 10, Math.floor((secs % 60) / 10), secs % 10];
    t.forEach((d, i) => this.blit(digits, d * 9, 0, 9, 13, TIME_DIGITS_X[i], 26));

    ctx.drawImage(s.vis, 24, 43);

    this.drawMarquee(s.marquee);
    this.drawText(s.kbps.padStart(3).slice(-3), 111, 43);
    this.drawText(s.khz.padStart(2).slice(-2), 156, 43);

    const stereo = s.channels > 1;
    const mono = s.channels === 1;
    this.blit("monoster", 29, mono ? 0 : 12, 27, 12, 212, 41);
    this.blit("monoster", 0, stereo ? 0 : 12, 29, 12, 239, 41);

    // Both follow the system: fill frame by amount, thumb by position.
    const vol = Math.max(0, Math.min(1, s.volume));
    const bal = Math.max(-1, Math.min(1, s.balance));
    this.drawSlider("volume", Math.round(vol * 27), vol);
    this.drawSlider("balance", Math.round(Math.abs(bal) * 27), (bal + 1) / 2);

    this.blit("posbar", 0, 0, 248, 10, 16, 72);
    if (s.progress !== null) {
      const x = 16 + Math.round(Math.max(0, Math.min(1, s.progress)) * (248 - 29));
      this.blit("posbar", 248, 0, 29, 10, x, 72);
    }

    // Buttons: up sprites live in main.bmp for most skins only as art, so
    // draw each from its sheet; pressed ones from their down rects.
    for (const b of BUTTONS) {
      const isDown = this.pressed === b && this.hover;
      const [sx, sy] = isDown ? b.down : b.up;
      if (b.sheet === "titlebar" && !isDown) continue; // titlebar art already has them
      this.blit(b.sheet, sx, sy, b.w, b.h, b.x, b.y);
    }
  }

  /** Fill frame `frame` (0..27), thumb at fraction `t` (0..1) of the track. */
  private drawSlider(kind: Slider, frame: number, t: number) {
    const r = SLIDERS[kind];
    this.blit(kind, r.sx, frame * 15, r.w, r.h, r.x, r.y);
    const thumbX = r.x + Math.round(t * (r.w - THUMB));
    this.blit(kind, this.dragging === kind ? 0 : 15, 422, THUMB, 11, thumbX, r.y + 1);
  }

  private drawText(text: string, x: number, y: number) {
    for (let i = 0; i < text.length; i++) {
      const [row, col] = glyphFor(text[i]);
      this.blit("text", col * GLYPH_W, row * GLYPH_H, GLYPH_W, GLYPH_H, x + i * GLYPH_W, y);
    }
  }

  /** Scrolls like Winamp when the title is wider than the display. */
  private drawMarquee(text: string) {
    const fits = text.length * GLYPH_W <= MARQUEE.w;
    const full = fits ? text : `${text}  ***  `;
    if (!this.strip || this.stripText !== full) {
      this.stripText = full;
      this.scrollStart = performance.now();
      const strip = document.createElement("canvas");
      strip.width = Math.max(1, full.length * GLYPH_W);
      strip.height = GLYPH_H;
      const sctx = strip.getContext("2d")!;
      const img = this.skin?.sheets.text;
      if (img) {
        for (let i = 0; i < full.length; i++) {
          const [row, col] = glyphFor(full[i]);
          sctx.drawImage(img, col * GLYPH_W, row * GLYPH_H, GLYPH_W, GLYPH_H, i * GLYPH_W, 0, GLYPH_W, GLYPH_H);
        }
      }
      this.strip = strip;
    }
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(MARQUEE.x, MARQUEE.y, MARQUEE.w, GLYPH_H);
    ctx.clip();
    if (fits) {
      ctx.drawImage(this.strip, MARQUEE.x, MARQUEE.y);
    } else {
      const off = Math.floor((performance.now() - this.scrollStart) / 40) % this.strip.width;
      ctx.drawImage(this.strip, MARQUEE.x - off, MARQUEE.y);
      ctx.drawImage(this.strip, MARQUEE.x - off + this.strip.width, MARQUEE.y);
    }
    ctx.restore();
  }
}
