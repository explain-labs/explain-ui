import type { ChartFrame, AnimFrame, ChannelsPayload, RendererAdapter } from "./types";
import { LoopBuffer, bounds, snapRange, type LoopPoints } from "./sleLoopBuffer";
import type { SlePalette } from "./Sle6000Renderer";

// One SLE6000 loop (IFU §21.1.8.2, pp 145-146; the look of the vendor "Loops" screenshot): one
// signal against another per breath on black, a dark header strip with the loop's name, grey axes
// with ticks, the axis titles in small italics. The current breath grows in the active colour and
// the last few completed breaths fade behind it; a saved loop is drawn in white over them. The
// axes snap to round ranges around what is shown. Breath edges come from Ventilator.ncc_insp
// (sleLoopBuffer.ts). Never Vue-reactive: registered with the RealtimeBus.

export interface SleLoopAxis {
  signal: string; // chart slot path, e.g. "Ventilator.pres"
  label: string; // axis title, e.g. "Pressure (mbar)"
  scale?: number; // display = raw * scale
  ranges: [number, number][]; // candidate ranges; the narrowest that fits wins
}
export interface SleLoopConfig {
  title: string; // header strip, e.g. "Volume - Pressure"
  x: SleLoopAxis;
  y: SleLoopAxis;
}
export interface SleLoopColors {
  active: string;
  saved: string;
}

const EDGE_SIGNAL = "Ventilator.ncc_insp";
const PHASE_SIGNAL = "Ventilator._hfo_phase"; // the HFO cycle edges (the volume restarts there)
const HEADER_H = 14;
const PAD_L = 40; // y ticks and title
const PAD_B = 26; // x ticks and title
const FADE = [0.25, 0.45, 0.7]; // opacity of the completed breaths, oldest first

export class SleLoopRenderer implements RendererAdapter {
  private el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;
  private cfg: SleLoopConfig;
  private pal: SlePalette;
  private colors: SleLoopColors;
  private buf = new LoopBuffer(3);
  private saved: LoopPoints | null = null;
  private paused = false;
  private cssScale = 1;
  private slots: string[] = [];
  private xi = -1;
  private yi = -1;
  private ei = -1;
  private pi = -1;

  constructor(el: HTMLElement, cfg: SleLoopConfig, palette: SlePalette, colors: SleLoopColors) {
    this.el = el;
    this.cfg = cfg;
    this.pal = palette;
    this.colors = colors;
    this.canvas = document.createElement("canvas");
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.display = "block";
    el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(el);
    this.resize();
  }

  onRegistry(payload: ChannelsPayload) {
    this.slots = payload?.chart?.slots ?? [];
    this.resolve();
  }

  private resolve() {
    this.xi = this.slots.indexOf(this.cfg.x.signal);
    this.yi = this.slots.indexOf(this.cfg.y.signal);
    this.ei = this.slots.indexOf(EDGE_SIGNAL);
    this.pi = this.slots.indexOf(PHASE_SIGNAL);
  }

  /** Another loop type (V/P, F/V, F/P): starts afresh, the saved loop goes. */
  setConfig(cfg: SleLoopConfig) {
    this.cfg = cfg;
    this.resolve();
    this.buf.clear();
    this.saved = null;
    this.draw();
  }

  setPaused(paused: boolean) {
    this.paused = paused;
  }

  setCssScale(k: number) {
    if (k > 0 && Math.abs(k - this.cssScale) > 1e-3) {
      this.cssScale = k;
      this.resize();
    }
  }

  /** The loop Save stores (the last completed breath), or null when there is none yet. */
  snapshot(): LoopPoints | null {
    return this.buf.snapshot();
  }

  /** A saved loop drawn in white, or null to hide it. */
  setSaved(points: LoopPoints | null) {
    this.saved = points;
    this.draw();
  }

  clear() {
    this.buf.clear();
    this.draw();
  }

  onFrame(chart: ChartFrame | null, _anim: AnimFrame | null) {
    if (!chart || this.paused || this.xi < 0 || this.yi < 0) return;
    const { rows, stride, count } = chart;
    const sx = this.cfg.x.scale ?? 1;
    const sy = this.cfg.y.scale ?? 1;
    for (let r = 0; r < count; r++) {
      const b = r * stride;
      const ncc = this.ei >= 0 ? rows[b + this.ei] : 0;
      const phase = this.pi >= 0 ? rows[b + this.pi] : null;
      this.buf.push(rows[b], rows[b + this.xi] * sx, rows[b + this.yi] * sy, ncc, phase);
    }
    if (count) this.draw();
  }

  private shown(): { lists: LoopPoints[]; alphas: number[] } {
    if (this.buf.trailMode) return { lists: [this.buf.trailPoints()], alphas: [1] };
    const done = this.buf.breaths;
    const alphas = done.map((_, i) => FADE[FADE.length - done.length + i] ?? 1);
    return { lists: [...done, this.buf.current], alphas: [...alphas, 1] };
  }

  private draw() {
    const ctx = this.ctx;
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    if (!w || !h) return; // hidden
    ctx.fillStyle = this.pal.background;
    ctx.fillRect(0, 0, w, h);
    // header strip
    ctx.fillStyle = this.pal.header;
    ctx.fillRect(PAD_L, 2, w - PAD_L - 4, HEADER_H);
    ctx.fillStyle = this.pal.title;
    ctx.font = "italic 10px Arial, Helvetica, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(this.cfg.title, PAD_L + 6, 2 + HEADER_H / 2);

    const { lists, alphas } = this.shown();
    const all = this.saved ? [...lists, this.saved] : lists;
    const bb = bounds(all);
    const xr = snapRange(bb?.x[0] ?? 0, bb?.x[1] ?? 0, this.cfg.x.ranges);
    const yr = snapRange(bb?.y[0] ?? 0, bb?.y[1] ?? 0, this.cfg.y.ranges);
    const L = PAD_L, R = w - 10, T = HEADER_H + 12, B = h - PAD_B;
    const px = (v: number) => L + ((v - xr[0]) / (xr[1] - xr[0] || 1)) * (R - L);
    const py = (v: number) => B - ((v - yr[0]) / (yr[1] - yr[0] || 1)) * (B - T);
    this.drawAxes(xr, yr, px, py, L, R, T, B);

    ctx.save();
    ctx.beginPath();
    ctx.rect(L, T - 4, R - L + 4, B - T + 8);
    ctx.clip();
    const line = (p: LoopPoints, color: string, alpha: number, width: number) => {
      if (p.length < 4) return;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      let pen = false; // a NaN point (an HFO cycle edge) lifts the pen
      for (let i = 0; i < p.length; i += 2) {
        if (Number.isNaN(p[i])) {
          pen = false;
          continue;
        }
        if (pen) ctx.lineTo(px(p[i]), py(p[i + 1]));
        else ctx.moveTo(px(p[i]), py(p[i + 1]));
        pen = true;
      }
      ctx.stroke();
    };
    lists.forEach((p, i) => line(p, this.colors.active, alphas[i], 1.4));
    if (this.saved) line(this.saved, this.colors.saved, 1, 1.4);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  private drawAxes(
    xr: [number, number],
    yr: [number, number],
    px: (v: number) => number,
    py: (v: number) => number,
    L: number,
    R: number,
    T: number,
    B: number,
  ) {
    const ctx = this.ctx;
    const step = (span: number) => [1, 2, 5, 10, 20, 50, 100, 200].find((s) => span / s <= 5) ?? 500;
    ctx.strokeStyle = this.pal.axis;
    ctx.fillStyle = this.pal.tick;
    ctx.lineWidth = 1;
    ctx.font = "9px Arial, Helvetica, sans-serif";
    // axes through zero when it is in range, else along the edges
    const x0 = xr[0] < 0 && xr[1] > 0 ? px(0) : L;
    const y0 = yr[0] < 0 && yr[1] > 0 ? py(0) : B;
    ctx.beginPath();
    ctx.moveTo(Math.round(x0) + 0.5, T);
    ctx.lineTo(Math.round(x0) + 0.5, B);
    ctx.moveTo(L, Math.round(y0) + 0.5);
    ctx.lineTo(R, Math.round(y0) + 0.5);
    ctx.stroke();
    const sxs = step(xr[1] - xr[0]);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let v = Math.ceil(xr[0] / sxs) * sxs; v <= xr[1] + 1e-9; v += sxs) {
      const x = Math.round(px(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y0 + 3);
      ctx.stroke();
      ctx.fillText(String(v), x, Math.min(B + 4, y0 + 5));
    }
    const sys = step(yr[1] - yr[0]);
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let v = Math.ceil(yr[0] / sys) * sys; v <= yr[1] + 1e-9; v += sys) {
      const y = Math.round(py(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x0 - 3, y);
      ctx.lineTo(x0, y);
      ctx.stroke();
      ctx.fillText(String(v), Math.max(L - 5, x0 - 5), y);
    }
    // axis titles: x at the bottom right, y rotated along the left
    ctx.fillStyle = this.pal.title;
    ctx.font = "italic 10px Arial, Helvetica, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText(this.cfg.x.label, R, this.el.clientHeight - 2);
    ctx.save();
    ctx.translate(10, T);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(this.cfg.y.label, 0, 0);
    ctx.restore();
  }

  private resize() {
    const dpr = (globalThis.devicePixelRatio || 1) * this.cssScale;
    const cssW = this.el.clientWidth || 300;
    const cssH = this.el.clientHeight || 200;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  dispose() {
    this.ro.disconnect();
    this.canvas.remove();
  }
}
