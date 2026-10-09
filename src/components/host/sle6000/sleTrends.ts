// SLE6000 trends (IFU §21.1.9.2-21.1.9.4, pp 146-149; the look of the brochure's Trends capture).
// The device stores 14 days of 1 Hz trend data; the replica keeps the 1 Hz slow-stream samples of
// the session, up to 24 h of model time (the widest zoom). The time axis is model time.
//
// TrendStore is pure (unit-tested); the module-level singleton below feeds it from the engine:
// `rts` while the realtime loop runs and `data_slow` after a fast-forward (calculate), so the history
// has no gap either way. Buffers are plain typed arrays, never Vue-reactive; the renderer polls
// `version`.

export interface TrendDef {
  label: string; // as on the device
  unit: string;
  path: string | null; // slow-stream path; null = not modelled
  scale?: number; // display = raw * scale
  decimals: number;
}

// the device's trend list (p146) in its order
export const TREND_DEFS: Record<string, TrendDef> = {
  o2: { label: "O2", unit: "%", path: "Ventilator.mon_o2", decimals: 0 },
  set_o2: { label: "Set O2", unit: "%", path: "Ventilator.sle_o2", decimals: 0 },
  pip: { label: "PIP", unit: "mbar", path: "Ventilator.mon_pip", decimals: 1 },
  peep: { label: "PEEP", unit: "mbar", path: "Ventilator.mon_peep", decimals: 1 },
  map: { label: "MAP", unit: "mbar", path: "Ventilator.mon_map", decimals: 1 },
  cpap: { label: "CPAP", unit: "mbar", path: "Ventilator.mon_peep", decimals: 1 },
  dp: { label: "ΔP", unit: "mbar", path: "Ventilator.mon_dp", decimals: 0 },
  vte: { label: "Vte", unit: "ml", path: "Ventilator.mon_vte", decimals: 1 },
  vmin: { label: "Vmin", unit: "l", path: "Ventilator.mon_vmin", decimals: 2 },
  rr: { label: "RR", unit: "BPM", path: "Ventilator.mon_rr", decimals: 0 },
  trig: { label: "Triggers", unit: "/min", path: "Ventilator.mon_trig", decimals: 0 },
  r: { label: "Resistance", unit: "mbar/L/s", path: "Ventilator.mon_r", decimals: 0 },
  c: { label: "Compliance", unit: "mL/mbar", path: "Ventilator.mon_c", decimals: 1 },
  dco2: { label: "DCO2", unit: "", path: "Ventilator.mon_dco2", decimals: 0 },
  spo2: { label: "SpO2", unit: "%", path: "Monitor.sao2_pre", decimals: 0 },
  siq: { label: "SIQ", unit: "", path: null, decimals: 0 }, // pleth signal quality: not modelled
};
export const TREND_IDS = Object.keys(TREND_DEFS);
export const TREND_PATHS = [...new Set(TREND_IDS.map((id) => TREND_DEFS[id].path).filter((p): p is string => !!p))];

// zoom steps (p148): 15 and 30 minutes, 1 hour (default), then 2, 4, 6, 9, 12 and 24 hours
export const ZOOM_STEPS = [900, 1800, 3600, 7200, 14400, 21600, 32400, 43200, 86400];
export const DEFAULT_ZOOM = 3600;
export function stepZoom(zoomS: number, dir: number): number {
  const i = Math.max(0, ZOOM_STEPS.indexOf(zoomS));
  return ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, i + (dir > 0 ? 1 : -1)))];
}
export function zoomLabel(zoomS: number): string {
  return zoomS < 3600 ? `${zoomS / 60} min` : `${zoomS / 3600} hour${zoomS === 3600 ? "" : "s"}`;
}
// the cursor moves 1/60 of the window per press; past the end it moves to the next window (p149)
export function stepCursor(cursorT: number, window: [number, number], dir: number): { cursorT: number; shift: number } {
  const w = window[1] - window[0];
  let c = cursorT + (dir * w) / 60;
  let shift = 0;
  if (c > window[1]) {
    shift = w;
    c = window[1] + (c - window[1]);
  } else if (c < window[0]) {
    shift = -w;
  }
  return { cursorT: c, shift };
}
// model seconds as the device's clock text, hh:mm:ss from the start of the run
export function clockText(t: number): string {
  const s = Math.max(0, Math.floor(t));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export const TREND_CAPACITY = 86400; // 24 h at 1 Hz

/** Ring buffers of 1 Hz samples: one time column and one column per slow-stream path. */
export class TrendStore {
  readonly capacity: number;
  readonly paths: string[];
  private t: Float64Array;
  private cols: Map<string, Float32Array>;
  private head = 0; // index of the oldest sample
  private n = 0;
  version = 0;

  constructor(paths: string[], capacity = TREND_CAPACITY) {
    this.capacity = capacity;
    this.paths = paths;
    this.t = new Float64Array(capacity);
    this.cols = new Map(paths.map((p) => [p, new Float32Array(capacity)]));
  }

  get size() {
    return this.n;
  }

  clear() {
    this.head = 0;
    this.n = 0;
    this.version++;
  }

  private idx(k: number) {
    return (this.head + k) % this.capacity;
  }

  lastTime(): number | null {
    return this.n ? this.t[this.idx(this.n - 1)] : null;
  }

  firstTime(): number | null {
    return this.n ? this.t[this.head] : null;
  }

  /** Append slow-stream samples ({time, "Model.prop": value}); skips times already stored. */
  append(samples: Record<string, unknown>[]) {
    let added = 0;
    for (const s of samples) {
      const time = Number(s?.time);
      if (!Number.isFinite(time)) continue;
      const first = this.firstTime();
      if (first !== null && time < first - 1e-6) this.clear(); // before all history: time restarted
      const last = this.lastTime();
      if (last !== null && time <= last + 1e-6) continue; // already stored
      const k = this.n < this.capacity ? this.idx(this.n) : this.head;
      if (this.n < this.capacity) this.n++;
      else this.head = (this.head + 1) % this.capacity;
      this.t[k] = time;
      for (const [p, col] of this.cols) {
        const v = Number(s[p]);
        col[k] = Number.isFinite(v) ? v : NaN;
      }
      added++;
    }
    if (added) this.version++;
    return added;
  }

  /** Samples of `path` with t0 <= time <= t1, oldest first. */
  slice(path: string, t0: number, t1: number): { t: number[]; v: number[] } {
    const col = this.cols.get(path);
    const out = { t: [] as number[], v: [] as number[] };
    if (!col || !this.n) return out;
    // binary search the first sample >= t0 (times are increasing)
    let lo = 0, hi = this.n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.t[this.idx(mid)] < t0) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < this.n; k++) {
      const i = this.idx(k);
      const tt = this.t[i];
      if (tt > t1) break;
      out.t.push(tt);
      out.v.push(col[i]);
    }
    return out;
  }

  /** The value of `path` at the sample nearest to `time`, or null. */
  valueAt(path: string, time: number): number | null {
    const s = this.slice(path, time - 1.0, time + 1.0);
    if (!s.t.length) return null;
    let best = 0;
    for (let i = 1; i < s.t.length; i++) if (Math.abs(s.t[i] - time) < Math.abs(s.t[best] - time)) best = i;
    const v = s.v[best];
    return Number.isFinite(v) ? v : null;
  }
}

/** Per-pixel-column min / max of (t, v) over [t0, t1] in `cols` columns (NaN where empty). */
export function decimate(t: number[], v: number[], t0: number, t1: number, cols: number) {
  const mn = new Float64Array(cols).fill(NaN);
  const mx = new Float64Array(cols).fill(NaN);
  const span = t1 - t0 || 1;
  for (let i = 0; i < t.length; i++) {
    if (!Number.isFinite(v[i])) continue;
    const c = Math.min(cols - 1, Math.max(0, Math.floor(((t[i] - t0) / span) * cols)));
    if (Number.isNaN(mn[c]) || v[i] < mn[c]) mn[c] = v[i];
    if (Number.isNaN(mx[c]) || v[i] > mx[c]) mx[c] = v[i];
  }
  return { mn, mx };
}

// ---- the session store, fed from the engine ----------------------------------------------------
let store: TrendStore | null = null;
let wired = false;
const listeners = new Set<() => void>();

/** Called after each batch of samples (realtime or fast-forward); returns the unsubscribe. */
export function onTrendAppend(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The session's trend store; the first call subscribes it to the engine's slow data. */
export function sleTrendStore(model?: { on: (ev: string, fn: () => void) => void; modelDataSlow: unknown }): TrendStore {
  if (!store) store = new TrendStore(TREND_PATHS);
  if (model && !wired) {
    wired = true;
    const feed = () => {
      const data = model.modelDataSlow;
      if (Array.isArray(data) && store!.append(data as Record<string, unknown>[])) for (const fn of listeners) fn();
    };
    model.on("rts", feed);
    model.on("data_slow", feed);
    model.on("model_ready", () => store!.clear());
  }
  return store;
}
