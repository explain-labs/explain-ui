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
  // Several samples land in each column (e.g. ~6 at 200 Hz over a 6 s sweep on a
  // narrow canvas), so each column keeps the min/max envelope, not just the last
  // sample — otherwise short spikes such as the ECG R wave come and go.
  private cols: Float64Array[] = []; // per lane: last sample in each sweep column
  private colMin: Float64Array[] = []; // per lane: lowest sample in each column
  private colMax: Float64Array[] = []; // per lane: highest sample in each column
  private filled: Uint8Array[] = []; // per lane: 1 if that column has data
  private headCol = -1; // current sweep column (shared across lanes)
  private nums: Record<string, number> = {};
  private highlight = new Set<number>(); // lane indices framed for a lesson step
  private hidden = new Set<number>(); // lane indices left out of the layout

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

  /** Leave lanes (by index) out of the layout; the rest share the height. [] shows all.
   * A lane that comes back starts from an empty sweep rather than stale data. */
  setHidden(indices: number[]) {
    const next = new Set(indices);
    for (const li of next) if (!this.hidden.has(li)) this.filled[li]?.fill(0);
    this.hidden = next;
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
      const prev = this.headCol;
      const fresh = c !== prev;
      // columns the head jumped over (samples sparser than columns on a wide
      // canvas); a jump of half the sweep or more is a restart, not a gap
      const skipped = prev >= 0 && fresh ? (c - prev + this.plotW) % this.plotW - 1 : 0;
      const gap = skipped > 0 && skipped < this.plotW / 2 ? skipped : 0;
      for (let li = 0; li < this.lanes.length; li++) {
        const si = this.idx[li];
        if (si < 0) continue;
        const v = rows[base + si];
        const last = this.cols[li];
        const mn = this.colMin[li];
        const mx = this.colMax[li];
        const fl = this.filled[li];
        // interpolate across skipped columns so they don't keep the previous sweep
        if (gap && fl[prev]) {
          const v0 = last[prev];
          for (let k = 1; k <= gap; k++) {
            const cc = (prev + k) % this.plotW;
            const iv = v0 + ((v - v0) * k) / (gap + 1);
            last[cc] = mn[cc] = mx[cc] = iv;
            fl[cc] = 1;
          }
        }
        if (fresh || !fl[c]) {
          mn[c] = mx[c] = v;
        } else {
          if (v < mn[c]) mn[c] = v;
          if (v > mx[c]) mx[c] = v;
        }
        last[c] = v;
        fl[c] = 1;
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
    const visible = this.lanes.map((_, li) => li).filter((li) => !this.hidden.has(li));
    const laneH = h / Math.max(1, visible.length);

    for (let k = 0; k < visible.length; k++) {
      const li = visible[k];
      const lane = this.lanes[li];
      const top = k * laneH;
      const bot = top + laneH;

      // lane divider
      if (k > 0) {
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
    const mn = this.colMin[li];
    const mx = this.colMax[li];
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
        if (mn[c] < lo) lo = mn[c];
        if (mx[c] > hi) hi = mx[c];
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
          for (let k = c; k <= end; k++) ctx.lineTo(sx(k), sy(mx[k]));
          ctx.lineTo(sx(end), baseline);
          ctx.closePath();
          ctx.fillStyle = lane.color + "22"; // ~13% alpha
          ctx.fill();
        }
        ctx.beginPath();
        // per column: full min→max extent, ending on the last sample so the
        // next column joins on
        ctx.moveTo(sx(c), sy(col[c]));
        for (let k = c; k <= end; k++) {
          const x = sx(k);
          ctx.lineTo(x, sy(mn[k]));
          ctx.lineTo(x, sy(mx[k]));
          ctx.lineTo(x, sy(col[k]));
        }
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

    // unit on the top line, level with the lane label
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillText(lane.unit, cx, top + 14);

    // The value (and sub-value) fill the space below the unit line. Short lanes
    // shrink the font and move the sub-value beside the value instead of under it.
    const CAP = 0.72; // cap height as a fraction of the font size
    const MAX = 26; // value font size in a roomy lane
    const SUB = 12; // sub-value font size
    const areaTop = top + 18;
    const avail = Math.max(8, bot - 4 - areaTop);
    const stacked = !!sub && avail >= MAX * CAP + 4 + SUB * CAP;
    const below = stacked ? 4 + SUB * CAP : 0;
    const size = Math.max(10, Math.min(MAX, (avail - below) / CAP));
    const baseline = areaTop + (avail - size * CAP - below) / 2 + size * CAP;

    ctx.fillStyle = lane.color;
    ctx.font = `600 ${size.toFixed(1)}px system-ui, sans-serif`;
    ctx.fillText(value, cx, baseline);
    if (sub) {
      const valueW = ctx.measureText(value).width;
      ctx.font = `${SUB}px system-ui, sans-serif`;
      ctx.fillStyle = lane.color + "cc";
      if (stacked) ctx.fillText(sub, cx, baseline + below);
      else ctx.fillText(sub, cx - valueW - 4, baseline);
    }
  }

  private clearBuffers() {
    for (let li = 0; li < this.lanes.length; li++) {
      this.filled[li]?.fill(0);
    }
    this.headCol = -1;
  }

  private alloc() {
    this.cols = this.lanes.map(() => new Float64Array(this.plotW));
    this.colMin = this.lanes.map(() => new Float64Array(this.plotW));
    this.colMax = this.lanes.map(() => new Float64Array(this.plotW));
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
