import type { ChartFrame, AnimFrame, ChannelsPayload, RendererAdapter } from "./types";

// SLE6000 waveform panel: pressure / flow / volume drawn as the ventilator's screen shows them
// (IFU p146, p150): thin traces on white, a grey header strip per channel with its title, a y-axis
// with ticks on the left, a zero line, and a sweep that overwrites the previous pass. Same column
// store as MonitorRenderer (min/max envelope per column). The axes snap to round ranges that only
// grow within a sweep and shrink back a sweep later, so they don't jump breath to breath. Never
// Vue-reactive: registered with the RealtimeBus.

export interface SleChannel {
  signal: string; // chart slot path, e.g. "Ventilator.pres"
  title: string; // header strip text, e.g. "Pressure (mbar)"
  scale?: number; // display = raw * scale (cmH2O -> mbar)
  ranges: [number, number][]; // candidate y-ranges, smallest first; the first that fits wins
}

const AXIS_W = 34; // y-axis label column (CSS px)
const HEADER_H = 14; // channel header strip
const TRACE = "#1e88c8";
const DEFAULT_WINDOW_S = 6;

export class Sle6000Renderer implements RendererAdapter {
  private el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;
  private channels: SleChannel[];
  private windowS: number;
  private paused = false;

  private slots: string[] = [];
  private idx: number[] = [];
  private plotW = 0;
  private cols: Float64Array[] = [];
  private colMin: Float64Array[] = [];
  private colMax: Float64Array[] = [];
  private filled: Uint8Array[] = [];
  private headCol = -1;
  private range: [number, number][] = []; // current y-range per channel
  private hidden = new Set<number>();
  private cssScale = 1; // the screen frame is CSS-scaled; draw at the real pixel size

  constructor(el: HTMLElement, channels: SleChannel[], windowS = DEFAULT_WINDOW_S) {
    this.el = el;
    this.channels = channels;
    this.windowS = windowS;
    this.idx = channels.map(() => -1);
    this.range = channels.map((c) => c.ranges[0]);
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
    this.idx = this.channels.map((c) => this.slots.indexOf(c.signal));
  }

  /** Freeze the traces (the device's pause button); frames are dropped while paused. */
  setPaused(paused: boolean) {
    this.paused = paused;
  }

  setWindow(seconds: number) {
    if (seconds > 0 && seconds !== this.windowS) {
      this.windowS = seconds;
      this.clear();
    }
  }

  /** Leave channels (by index) out; the rest share the height. */
  setHidden(indices: number[]) {
    this.hidden = new Set(indices);
    this.draw();
  }

  clear() {
    for (const f of this.filled) f.fill(0);
    this.headCol = -1;
    this.draw();
  }

  /** The frame's CSS scale, so the canvas backs the real pixel size. */
  setCssScale(k: number) {
    if (k > 0 && Math.abs(k - this.cssScale) > 1e-3) {
      this.cssScale = k;
      this.resize();
    }
  }

  onFrame(chart: ChartFrame | null, _anim: AnimFrame | null) {
    if (!chart || this.paused || this.plotW < 2) return;
    const { rows, stride, count } = chart;
    const w = this.windowS;
    for (let r = 0; r < count; r++) {
      const base = r * stride;
      const t = rows[base];
      const phase = ((t % w) + w) % w;
      const c = Math.min(this.plotW - 1, Math.floor((phase / w) * this.plotW));
      const prev = this.headCol;
      const fresh = c !== prev;
      if (prev >= 0 && c < prev) this.endSweep(); // wrapped round
      const skipped = prev >= 0 && fresh ? (c - prev + this.plotW) % this.plotW - 1 : 0;
      const gap = skipped > 0 && skipped < this.plotW / 2 ? skipped : 0;
      for (let ci = 0; ci < this.channels.length; ci++) {
        const si = this.idx[ci];
        if (si < 0) continue;
        const v = rows[base + si] * (this.channels[ci].scale ?? 1);
        const last = this.cols[ci], mn = this.colMin[ci], mx = this.colMax[ci], fl = this.filled[ci];
        if (gap && fl[prev]) {
          const v0 = last[prev];
          for (let k = 1; k <= gap; k++) {
            const cc = (prev + k) % this.plotW;
            last[cc] = mn[cc] = mx[cc] = v0 + ((v - v0) * k) / (gap + 1);
            fl[cc] = 1;
          }
        }
        if (fresh || !fl[c]) mn[c] = mx[c] = v;
        else {
          if (v < mn[c]) mn[c] = v;
          if (v > mx[c]) mx[c] = v;
        }
        last[c] = v;
        fl[c] = 1;
        this.grow(ci, v);
      }
      this.headCol = c;
    }
    const gapCols = Math.max(2, Math.floor(this.plotW * 0.015));
    for (const fl of this.filled) for (let k = 1; k <= gapCols; k++) fl[(this.headCol + k) % this.plotW] = 0;
    this.draw();
  }

  // the smallest candidate range that holds v; grows at once, shrinks only at the end of a sweep
  private fit(ci: number, lo: number, hi: number): [number, number] {
    const rs = this.channels[ci].ranges;
    for (const r of rs) if (lo >= r[0] && hi <= r[1]) return r;
    // nothing holds both ends (a deep negative excursion): keep the top in view, clip the bottom
    for (const r of rs) if (hi <= r[1]) return r;
    return rs.at(-1)!;
  }
  private grow(ci: number, v: number) {
    const [lo, hi] = this.range[ci];
    if (v < lo || v > hi) this.range[ci] = this.fit(ci, Math.min(lo, v), Math.max(hi, v));
  }
  private endSweep() {
    for (let ci = 0; ci < this.channels.length; ci++) {
      const fl = this.filled[ci], mn = this.colMin[ci], mx = this.colMax[ci];
      let lo = Infinity, hi = -Infinity;
      for (let c = 0; c < this.plotW; c++) {
        if (!fl[c]) continue;
        if (mn[c] < lo) lo = mn[c];
        if (mx[c] > hi) hi = mx[c];
      }
      if (lo !== Infinity) this.range[ci] = this.fit(ci, lo, hi);
    }
  }

  private draw() {
    const ctx = this.ctx;
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    if (!w || !h) return; // hidden tab
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    const visible = this.channels.map((_, i) => i).filter((i) => !this.hidden.has(i));
    const chH = h / Math.max(1, visible.length);
    const plotL = AXIS_W;
    const plotR = w - 4;
    for (let k = 0; k < visible.length; k++) {
      const ci = visible[k];
      const top = k * chH;
      // header strip
      ctx.fillStyle = "#5f6266";
      ctx.fillRect(plotL, top + 2, plotR - plotL, HEADER_H);
      ctx.fillStyle = "#ffffff";
      ctx.font = "10px Arial, Helvetica, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(this.channels[ci].title, plotL + 6, top + 2 + HEADER_H / 2);
      const pTop = top + HEADER_H + 8;
      const pBot = top + chH - 6;
      this.drawAxis(ci, pTop, pBot, plotL, plotR);
      this.drawTrace(ci, pTop, pBot, plotL, plotR);
    }
    if (this.headCol >= 0) {
      const x = plotL + (this.headCol / this.plotW) * (plotR - plotL);
      ctx.strokeStyle = "rgba(30,136,200,0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
      ctx.stroke();
    }
  }

  private y(ci: number, v: number, pTop: number, pBot: number) {
    const [lo, hi] = this.range[ci];
    return pBot - ((v - lo) / (hi - lo || 1)) * (pBot - pTop);
  }

  private drawAxis(ci: number, pTop: number, pBot: number, plotL: number, plotR: number) {
    const ctx = this.ctx;
    const [lo, hi] = this.range[ci];
    const span = hi - lo;
    const step = [1, 2, 5, 10, 20, 50, 100, 200, 500].find((s) => span / s <= 4) ?? 1000;
    ctx.strokeStyle = "#9a9da2";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotL + 0.5, pTop);
    ctx.lineTo(plotL + 0.5, pBot);
    ctx.stroke();
    ctx.fillStyle = "#4a4d52";
    ctx.font = "9px Arial, Helvetica, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
      const yy = Math.round(this.y(ci, v, pTop, pBot)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(plotL - 3, yy);
      ctx.lineTo(plotL, yy);
      ctx.stroke();
      ctx.fillText(String(v), plotL - 5, yy);
    }
    if (lo < 0 && hi > 0) {
      const y0 = Math.round(this.y(ci, 0, pTop, pBot)) + 0.5;
      ctx.strokeStyle = "#c4c6c9";
      ctx.beginPath();
      ctx.moveTo(plotL, y0);
      ctx.lineTo(plotR, y0);
      ctx.stroke();
    }
  }

  private drawTrace(ci: number, pTop: number, pBot: number, plotL: number, plotR: number) {
    const col = this.cols[ci], mn = this.colMin[ci], mx = this.colMax[ci], fl = this.filled[ci];
    if (!col) return;
    const ctx = this.ctx;
    const sx = (c: number) => plotL + (c / this.plotW) * (plotR - plotL);
    const sy = (v: number) => Math.max(pTop - 4, Math.min(pBot + 4, this.y(ci, v, pTop, pBot)));
    ctx.strokeStyle = TRACE;
    ctx.lineWidth = 1.4;
    let c = 0;
    while (c < this.plotW) {
      if (!fl[c]) {
        c++;
        continue;
      }
      let end = c;
      while (end + 1 < this.plotW && fl[end + 1]) end++;
      if (end > c) {
        ctx.beginPath();
        ctx.moveTo(sx(c), sy(col[c]));
        for (let k = c; k <= end; k++) {
          const x = sx(k);
          ctx.lineTo(x, sy(mn[k]));
          ctx.lineTo(x, sy(mx[k]));
          ctx.lineTo(x, sy(col[k]));
        }
        ctx.stroke();
      }
      c = end + 1;
    }
  }

  private resize() {
    const dpr = (globalThis.devicePixelRatio || 1) * this.cssScale;
    const cssW = this.el.clientWidth || 600;
    const cssH = this.el.clientHeight || 400;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const plotW = Math.max(2, Math.floor(cssW - AXIS_W - 4));
    if (plotW !== this.plotW) {
      this.plotW = plotW;
      this.cols = this.channels.map(() => new Float64Array(plotW));
      this.colMin = this.channels.map(() => new Float64Array(plotW));
      this.colMax = this.channels.map(() => new Float64Array(plotW));
      this.filled = this.channels.map(() => new Uint8Array(plotW));
      this.headCol = -1;
    }
    this.draw();
  }

  dispose() {
    this.ro.disconnect();
    this.canvas.remove();
  }
}
