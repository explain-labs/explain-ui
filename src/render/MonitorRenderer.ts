import type { ChartFrame, AnimFrame, ChannelsPayload, RendererAdapter } from "./types";

// Bedside-monitor renderer: stacked waveform lanes drawn with an authentic
// "sweep" (a refresh head moves left→right, overwriting the previous pass in
// place, with a small blanked gap just ahead of the head). One canvas draws all
// lanes so the sweep head is shared. Waveforms come from the fast chart stream
// (onFrame); the big numerics come from the 1 Hz slow stream pushed in via
// setNumerics(). Never Vue-reactive — registered with the RealtimeBus.

export interface MonitorLane {
  signal: string; // chart slot path, e.g. "Monitor.ecg_signal"
  label: string; // lane caption
  color: string; // trace + numeric colour
  unit: string; // numeric unit caption
  fill?: boolean; // fill under the trace (pleth / capnograph)
  fixedRange?: [number, number]; // y-range; omit to autoscale per window
  // numeric formatters, given the latest slow-stream sample (dot-path keyed)
  readNumeric: (n: Record<string, number>) => string;
  readSub?: (n: Record<string, number>) => string; // small secondary (e.g. mean)
}

const GUTTER = 132; // right-hand numerics column width (CSS px)
const DEFAULT_WINDOW_S = 6;

export class MonitorRenderer implements RendererAdapter {
  private el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;
  private lanes: MonitorLane[];
  private windowS = DEFAULT_WINDOW_S;

  private slots: string[] = [];
  private idx: number[] = []; // slot index per lane (-1 until resolved)

  private plotW = 0; // plot-area width in CSS px == column-store length
  private cols: Float64Array[] = []; // per lane: value at each sweep column
  private filled: Uint8Array[] = []; // per lane: 1 if that column has data
  private headCol = -1; // current sweep column (shared across lanes)
  private nums: Record<string, number> = {};
  private highlight = new Set<number>(); // lane indices framed for a lesson step

  constructor(el: HTMLElement, lanes: MonitorLane[], windowS = DEFAULT_WINDOW_S) {
    this.el = el;
    this.lanes = lanes;
    this.windowS = windowS > 0 ? windowS : DEFAULT_WINDOW_S;
    this.idx = lanes.map(() => -1);
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
    this.idx = this.lanes.map((l) => this.slots.indexOf(l.signal));
  }

  /** Set the sweep window length (seconds) — the full left→right travel time. */
  setWindow(seconds: number) {
    if (seconds > 0 && seconds !== this.windowS) {
      this.windowS = seconds;
      this.clearBuffers();
      this.draw();
    }
  }

  /** Frame lanes (by index) in amber to point at them from a lesson; [] clears.
   *  Pulses while frames arrive; static when the sim is paused. */
  setHighlight(indices: number[]) {
    this.highlight = new Set(indices);
    this.draw();
  }

  /** Push the latest slow-stream numeric snapshot (dot-path keyed). */
  setNumerics(n: Record<string, number> | null) {
    this.nums = n ?? {};
    this.draw(); // refresh the gutter even when the sim is paused
  }

  onFrame(chart: ChartFrame | null, _anim: AnimFrame | null) {
    if (!chart || this.plotW < 2) return;
    const { rows, stride, count } = chart;
    const w = this.windowS;
    for (let r = 0; r < count; r++) {
      const base = r * stride;
      const t = rows[base];
      const phase = ((t % w) + w) % w; // 0..windowS, robust to negatives
      const c = Math.min(this.plotW - 1, Math.floor((phase / w) * this.plotW));
      for (let li = 0; li < this.lanes.length; li++) {
        const si = this.idx[li];
        if (si < 0) continue;
        this.cols[li][c] = rows[base + si];
        this.filled[li][c] = 1;
      }
      this.headCol = c;
    }
    // blank a small band just ahead of the head → the moving erase gap
    const gap = Math.max(2, Math.floor(this.plotW * 0.02));
    for (let li = 0; li < this.lanes.length; li++) {
      for (let k = 1; k <= gap; k++) {
        this.filled[li][(this.headCol + k) % this.plotW] = 0;
      }
    }
    this.draw();
  }

  private draw() {
    const ctx = this.ctx;
    const w = this.el.clientWidth || 600;
    const h = this.el.clientHeight || 480;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0a0e14"; // monitor-black background
    ctx.fillRect(0, 0, w, h);

    const plotR = w - GUTTER; // right edge of the waveform area
    const n = this.lanes.length;
    const laneH = h / n;

    for (let li = 0; li < n; li++) {
      const lane = this.lanes[li];
      const top = li * laneH;
      const bot = top + laneH;

      // lane divider
      if (li > 0) {
        ctx.strokeStyle = "rgba(255,255,255,0.07)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, top + 0.5);
        ctx.lineTo(w, top + 0.5);
        ctx.stroke();
      }
      // gutter separator
      ctx.strokeStyle = "rgba(255,255,255,0.07)";
      ctx.beginPath();
      ctx.moveTo(plotR + 0.5, top);
      ctx.lineTo(plotR + 0.5, bot);
      ctx.stroke();

      // lesson highlight: amber frame round the whole lane
      const hl = this.highlight.has(li);
      if (hl) {
        const pulse = 0.6 + 0.3 * Math.sin(performance.now() / 280);
        ctx.strokeStyle = `rgba(251,191,36,${pulse.toFixed(3)})`;
        ctx.lineWidth = 2;
        ctx.strokeRect(1.5, top + 1.5, w - 3, laneH - 3);
      }

      // lane label
      ctx.fillStyle = hl ? "#fbbf24" : lane.color;
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(lane.label, 6, top + 14);

      this.drawTrace(lane, li, top, bot, plotR);
      this.drawNumeric(lane, top, bot, w);
    }

    // shared sweep-head marker
    if (this.headCol >= 0) {
      const x = (this.headCol / this.plotW) * plotR;
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
      ctx.stroke();
    }
  }

  private drawTrace(
    lane: MonitorLane,
    li: number,
    top: number,
    bot: number,
    plotR: number,
  ) {
    const col = this.cols[li];
    const fl = this.filled[li];
    if (!col) return;

    // y-range: fixed or autoscale over filled samples
    let lo = Infinity;
    let hi = -Infinity;
    if (lane.fixedRange) {
      [lo, hi] = lane.fixedRange;
    } else {
      for (let c = 0; c < this.plotW; c++) {
        if (!fl[c]) continue;
        const v = col[c];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (lo === Infinity) return; // nothing to draw yet
      if (hi - lo < 1e-9) {
        lo -= 1;
        hi += 1;
      }
    }
    const padT = 18; // room for the lane label
    const padB = 6;
    const plotTop = top + padT;
    const plotBot = bot - padB;
    const baseline = plotBot;
    const range = hi - lo || 1;
    const sx = (c: number) => (c / this.plotW) * plotR;
    const sy = (v: number) => plotBot - ((v - lo) / range) * (plotBot - plotTop);

    const ctx = this.ctx;
    // walk contiguous runs of filled columns (sweep leaves a blank gap)
    let c = 0;
    while (c < this.plotW) {
      if (!fl[c]) {
        c++;
        continue;
      }
      let end = c;
      while (end + 1 < this.plotW && fl[end + 1]) end++;
      if (end > c) {
        if (lane.fill) {
          ctx.beginPath();
          ctx.moveTo(sx(c), baseline);
          for (let k = c; k <= end; k++) ctx.lineTo(sx(k), sy(col[k]));
          ctx.lineTo(sx(end), baseline);
          ctx.closePath();
          ctx.fillStyle = lane.color + "22"; // ~13% alpha
          ctx.fill();
        }
        ctx.beginPath();
        ctx.moveTo(sx(c), sy(col[c]));
        for (let k = c + 1; k <= end; k++) ctx.lineTo(sx(k), sy(col[k]));
        ctx.strokeStyle = lane.color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      c = end + 1;
    }
  }

  private drawNumeric(lane: MonitorLane, top: number, bot: number, w: number) {
    const ctx = this.ctx;
    const value = lane.readNumeric(this.nums);
    const sub = lane.readSub?.(this.nums);
    const cx = w - 10;
    const midY = (top + bot) / 2;

    ctx.fillStyle = lane.color;
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    ctx.font = "600 26px system-ui, sans-serif";
    ctx.fillText(value, cx, midY + (sub ? 0 : 6));
    if (sub) {
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillStyle = lane.color + "cc";
      ctx.fillText(sub, cx, midY + 16);
    }
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillText(lane.unit, cx, top + 14);
  }

  private clearBuffers() {
    for (let li = 0; li < this.lanes.length; li++) {
      this.filled[li]?.fill(0);
    }
    this.headCol = -1;
  }

  private alloc() {
    this.cols = this.lanes.map(() => new Float64Array(this.plotW));
    this.filled = this.lanes.map(() => new Uint8Array(this.plotW));
    this.headCol = -1;
  }

  private resize() {
    const dpr = globalThis.devicePixelRatio || 1;
    const cssW = this.el.clientWidth || 600;
    const cssH = this.el.clientHeight || 480;
    this.canvas.width = cssW * dpr;
    this.canvas.height = cssH * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.plotW = Math.max(2, Math.floor(cssW - GUTTER));
    this.alloc(); // column store is width-dependent; reset on resize
    this.draw();
  }

  dispose() {
    this.ro.disconnect();
    this.canvas.remove();
  }
}
