// The classic 76x16 main-window visualizer: spectrum analyzer and
// oscilloscope, colored from a viscolor.txt-style 24-entry palette.
//
// Falloff and bin mapping are approximations for now; matching the original's
// exact behavior is the REA phase.
import type { Frame } from "./frame";

export type VisMode = "bars" | "scope" | "off";

const W = 76;
const H = 16;
const BARS = 19; // "thick bands": 3px bar + 1px gap
const BAR_FALL = 1.1; // px per frame
const PEAK_GRAVITY = 0.04; // px per frame^2

// Default skin viscolor.txt: 0 bg, 1 dots, 2-17 spectrum (top→bottom),
// 18-22 oscilloscope (center→edge), 23 peaks.
const VISCOLOR: [number, number, number][] = [
  [0, 0, 0], [24, 33, 41],
  [239, 49, 16], [206, 41, 16], [214, 90, 0], [214, 102, 0],
  [214, 115, 0], [198, 123, 8], [222, 165, 24], [214, 181, 33],
  [189, 222, 41], [148, 222, 33], [41, 206, 16], [50, 190, 16],
  [57, 181, 16], [49, 156, 8], [41, 148, 0], [24, 132, 8],
  [255, 255, 255], [214, 214, 222], [181, 189, 189], [160, 170, 175], [148, 156, 165],
  [150, 150, 150],
];

/** Log-spaced FFT bin edges for each bar, skipping DC. */
function barEdges(bins: number): number[] {
  const top = Math.floor(bins * 0.78); // ~18.7 kHz at 48 kHz
  const edges = [1];
  for (let i = 1; i <= BARS; i++) {
    const e = Math.round(Math.pow(top, i / BARS));
    edges.push(Math.max(e, edges[i - 1] + 1));
  }
  return edges;
}

export class ClassicVis {
  mode: VisMode = "bars";
  private ctx: CanvasRenderingContext2D;
  private img: ImageData;
  private bars = new Float32Array(BARS);
  private peaks = new Float32Array(BARS);
  private peakVel = new Float32Array(BARS);
  private edges: number[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    this.img = this.ctx.createImageData(W, H);
  }

  draw(frame: Frame) {
    this.clear();
    if (this.mode === "bars") this.drawBars(frame.spec);
    else if (this.mode === "scope") this.drawScope(frame.l, frame.r);
    this.ctx.putImageData(this.img, 0, 0);
  }

  private px(x: number, y: number, color: number) {
    const [r, g, b] = VISCOLOR[color];
    const i = (y * W + x) * 4;
    const d = this.img.data;
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = 255;
  }

  private clear() {
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) this.px(x, y, x % 2 === 1 && y % 2 === 1 ? 1 : 0);
  }

  private drawBars(spec: number[]) {
    if (this.edges.length === 0) this.edges = barEdges(spec.length);
    for (let b = 0; b < BARS; b++) {
      let v = 0;
      for (let i = this.edges[b]; i < this.edges[b + 1]; i++) v = Math.max(v, spec[i]);
      const target = (v / 255) * H;

      this.bars[b] = Math.max(target, this.bars[b] - BAR_FALL);
      if (this.bars[b] >= this.peaks[b]) {
        this.peaks[b] = this.bars[b];
        this.peakVel[b] = 0;
      } else {
        this.peakVel[b] += PEAK_GRAVITY;
        this.peaks[b] = Math.max(0, this.peaks[b] - this.peakVel[b]);
      }

      const h = Math.round(this.bars[b]);
      const x0 = b * 4;
      for (let y = H - h; y < H; y++)
        for (let x = x0; x < x0 + 3; x++) this.px(x, y, 2 + y);

      const p = Math.round(this.peaks[b]);
      if (p > 0) for (let x = x0; x < x0 + 3; x++) this.px(x, H - p, 23);
    }
  }

  private drawScope(l: number[], r: number[]) {
    const step = l.length / W;
    let prev = -1;
    for (let x = 0; x < W; x++) {
      const i = Math.floor(x * step);
      const s = (l[i] + r[i]) / 2 - 128;
      const y = Math.max(0, Math.min(H - 1, Math.round(H / 2 + s / 8)));
      // Draw a vertical run back to the previous point so the trace is unbroken.
      const from = prev < 0 ? y : prev;
      for (let yy = Math.min(from, y); yy <= Math.max(from, y); yy++) {
        const dist = Math.min(4, Math.floor(Math.abs(yy - H / 2) / 2));
        this.px(x, yy, 18 + dist);
      }
      prev = y;
    }
  }
}
