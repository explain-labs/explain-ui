import type { SlePalette } from "./Sle6000Renderer";
import { TREND_DEFS, decimate, clockText, type TrendStore } from "@/components/host/sle6000/sleTrends";

// SLE6000 trends (IFU §21.1.9.2-21.1.9.4, pp 146-149; the look of the brochure's Trends capture):
// four stacked display lines, each with up to two trends. The first is light blue, the second is
// overlaid in pale yellow on its own scale (ticks on the left and right inside edges). A dark header
// strip carries the two names, a value box at the right edge carries the cursor values in their
// colours, a cursor line, time labels (model time since the first stored sample), an optional
// background grid, and a locator
// bar for where the window sits in the stored history. It reads the session TrendStore and redraws
// when the store's version or the view changes, polled on a 250 ms timer (requestAnimationFrame
// stops in background tabs, and the trends move at 1 Hz anyway). Never Vue-reactive.

export type TrendLine = [string | null, string | null]; // trend ids (null = Off)
export interface TrendView {
  t0: number; // window start (model s)
  t1: number; // window end
  cursorT: number | null;
  lines: TrendLine[];
  grid: boolean;
}
export interface TrendColors {
  first: string;
  second: string;
}

const HEADER_H = 14;
const AXIS_W = 32;
const BOX_W = 54;
const LOCATOR_H = 10;
const POLL_MS = 250;

// a round range around [lo, hi] with about four ticks. The span is at least 40 % of the value
// (and 1), so a near-constant trend (PEEP wobbling by 0.1 mbar) draws as a line, not a band.
function niceRange(lo: number, hi: number): { lo: number; hi: number; step: number } {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 1, step: 0.5 };
  const minSpan = Math.max(0.4 * Math.max(Math.abs(lo), Math.abs(hi)), 1);
  if (hi - lo < minSpan) {
    const pad = (minSpan - (hi - lo)) / 2;
    lo -= pad;
    hi += pad;
  }
  const raw = (hi - lo) / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step };
}
const fmt = (v: number, d: number) => (Number.isFinite(v) ? v.toFixed(d) : "---");
const tickText = (v: number, step: number) => (step >= 1 ? String(Math.round(v)) : v.toFixed(step >= 0.1 ? 1 : 2));

export class SleTrendRenderer {
  private el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;
  private store: TrendStore;
  private pal: SlePalette;
  private colors: TrendColors;
  private view: TrendView = { t0: 0, t1: 3600, cursorT: null, lines: [], grid: false };
  private cssScale = 1;
  private paused = false;
  private drawnVersion = -1;
  private dirty = true;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(el: HTMLElement, store: TrendStore, palette: SlePalette, colors: TrendColors) {
    this.el = el;
    this.store = store;
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
    this.timer = setInterval(() => {
      if (this.dirty || (!this.paused && this.store.version !== this.drawnVersion)) this.draw();
    }, POLL_MS);
  }

  setView(view: TrendView) {
    this.view = view;
    this.dirty = true;
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

  private draw() {
    const ctx = this.ctx;
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    if (!w || !h) return; // hidden: stays dirty, drawn once shown
    this.dirty = false;
    this.drawnVersion = this.store.version;
    ctx.fillStyle = this.pal.background;
    ctx.fillRect(0, 0, w, h);
    const lines = this.view.lines;
    const n = Math.max(1, lines.length);
    const panelH = (h - LOCATOR_H - 6) / n;
    for (let k = 0; k < lines.length; k++) this.drawLine(lines[k], k * panelH, panelH, w);
    this.drawLocator(w, h);
  }

  private drawLine(line: TrendLine, top: number, ph: number, w: number) {
    const ctx = this.ctx;
    const { t0, t1, cursorT, grid } = this.view;
    const L = AXIS_W, R = w - BOX_W - 6;
    const T = top + HEADER_H + 8, B = top + ph - 14;
    // header strip: left name blue, right name yellow
    ctx.fillStyle = this.pal.header;
    ctx.fillRect(L, top + 2, w - L - 4, HEADER_H);
    ctx.font = "italic 10px Arial, Helvetica, sans-serif";
    ctx.textBaseline = "middle";
    const name = (id: string | null) => (id ? `${TREND_DEFS[id].label}${TREND_DEFS[id].unit ? ` (${TREND_DEFS[id].unit})` : ""}` : "");
    ctx.fillStyle = this.colors.first;
    ctx.textAlign = "left";
    ctx.fillText(name(line[0]), L + 6, top + 2 + HEADER_H / 2);
    ctx.fillStyle = this.colors.second;
    ctx.textAlign = "right";
    ctx.fillText(name(line[1]), R, top + 2 + HEADER_H / 2);

    // plot frame, grid and time labels
    ctx.strokeStyle = this.pal.axis;
    ctx.lineWidth = 1;
    ctx.strokeRect(L + 0.5, T + 0.5, R - L, B - T);
    const span = t1 - t0 || 1;
    const tStep = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600].find((s) => span / s <= 6) ?? 21600;
    ctx.font = "8px Arial, Helvetica, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    // ticks on round times since the first stored sample (the clock's origin)
    const origin = this.store.firstTime() ?? 0;
    for (let t = origin + Math.ceil((t0 - origin) / tStep) * tStep; t <= t1; t += tStep) {
      const x = Math.round(L + ((t - t0) / span) * (R - L)) + 0.5;
      if (grid) {
        ctx.strokeStyle = this.pal.zero;
        ctx.beginPath();
        ctx.moveTo(x, T);
        ctx.lineTo(x, B);
        ctx.stroke();
      }
      ctx.fillStyle = this.pal.tick;
      ctx.fillText(clockText(t - origin).slice(0, 5), x, B + 2);
    }

    // the two trends, each on its own round range
    const cols = Math.max(2, Math.floor(R - L));
    line.forEach((id, j) => {
      if (!id) return;
      const def = TREND_DEFS[id];
      const color = j === 0 ? this.colors.first : this.colors.second;
      if (!def.path) {
        ctx.fillStyle = color;
        ctx.font = "italic 10px Arial, Helvetica, sans-serif";
        ctx.textAlign = j === 0 ? "left" : "right";
        ctx.textBaseline = "middle";
        ctx.fillText(`${def.label}: not available`, j === 0 ? L + 8 : R - 8, (T + B) / 2);
        return;
      }
      const s = this.store.slice(def.path, t0, t1);
      const vals = s.v.map((v) => v * (def.scale ?? 1));
      const fin = vals.filter(Number.isFinite);
      const rg = niceRange(fin.length ? Math.min(...fin) : 0, fin.length ? Math.max(...fin) : 1);
      const y = (v: number) => B - ((v - rg.lo) / (rg.hi - rg.lo || 1)) * (B - T);
      // scale ticks: first trend on the left axis, second along the right inside edge
      ctx.font = "8px Arial, Helvetica, sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillStyle = color;
      ctx.textAlign = j === 0 ? "right" : "right";
      for (let v = rg.lo; v <= rg.hi + 1e-9; v += rg.step * 2) {
        ctx.fillText(tickText(v, rg.step), j === 0 ? L - 3 : R - 3, y(v));
      }
      // min / max per pixel column, joined
      const { mn, mx } = decimate(s.t, vals, t0, t1, cols);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      let pen = false;
      for (let c = 0; c < cols; c++) {
        if (Number.isNaN(mn[c])) {
          pen = false;
          continue;
        }
        const x = L + c + 0.5;
        if (!pen) ctx.moveTo(x, y(mn[c]));
        ctx.lineTo(x, y(mn[c]));
        ctx.lineTo(x, y(mx[c]));
        pen = true;
      }
      ctx.stroke();
    });

    // cursor line and the value box with the cursor values
    const ct = cursorT ?? this.store.lastTime();
    if (cursorT !== null && cursorT >= t0 && cursorT <= t1) {
      const x = Math.round(L + ((cursorT - t0) / span) * (R - L)) + 0.5;
      ctx.strokeStyle = this.pal.title;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, T);
      ctx.lineTo(x, B);
      ctx.stroke();
    }
    const bx = w - BOX_W - 2, by = T + (B - T) / 2 - 20;
    ctx.strokeStyle = this.pal.title;
    ctx.strokeRect(bx + 0.5, by + 0.5, BOX_W - 4, 40);
    ctx.font = "12px Arial, Helvetica, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    line.forEach((id, j) => {
      if (!id || !TREND_DEFS[id].path || ct === null) return;
      const def = TREND_DEFS[id];
      const v = this.store.valueAt(def.path!, ct);
      ctx.fillStyle = j === 0 ? this.colors.first : this.colors.second;
      ctx.fillText(v === null ? "---" : fmt(v * (def.scale ?? 1), def.decimals), bx + (BOX_W - 4) / 2, by + 12 + j * 16);
    });
  }

  private drawLocator(w: number, h: number) {
    const ctx = this.ctx;
    const first = this.store.firstTime();
    const last = this.store.lastTime();
    const y = h - LOCATOR_H - 2;
    const L = AXIS_W, R = w - BOX_W - 6;
    ctx.strokeStyle = this.pal.axis;
    ctx.strokeRect(L + 0.5, y + 0.5, R - L, LOCATOR_H);
    if (first === null || last === null) return;
    const span = Math.max(last - first, this.view.t1 - this.view.t0);
    const a = L + ((Math.max(this.view.t0, first) - first) / span) * (R - L);
    const b = L + ((Math.min(this.view.t1, last) - first) / span) * (R - L);
    ctx.fillStyle = this.pal.tick;
    ctx.fillRect(a, y + 2, Math.max(2, b - a), LOCATOR_H - 3);
  }

  private resize() {
    const dpr = (globalThis.devicePixelRatio || 1) * this.cssScale;
    const cssW = this.el.clientWidth || 600;
    const cssH = this.el.clientHeight || 400;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dirty = true;
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.ro.disconnect();
    this.canvas.remove();
  }
}
