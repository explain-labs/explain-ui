// Breath segmentation and axis snapping for the SLE6000 loops (SleLoopRenderer). Pure, so it can be
// unit-tested without a canvas.
//
// A breath starts when the ventilator's inspiration counter (Ventilator.ncc_insp, reset to -1 at
// every inspiration start and counted up after) drops. The buffer keeps the growing current breath
// and the last few completed ones. Without breath edges (HFOV, CPAP without breaths) it falls back
// to a rolling trail of the last `trailS` seconds, so the oscillation loops still show. The volume
// restarts at every HFO cycle, so a drop of the oscillator phase breaks the trail there (a NaN
// point: the renderer starts a new stroke).

export type LoopPoints = number[]; // flat x, y, x, y, ...

export class LoopBuffer {
  readonly keep: number; // completed breaths kept
  readonly trailS: number; // trail length without breath edges (s)
  readonly noEdgeS: number; // after this long without an edge, show the trail (s)
  current: LoopPoints = [];
  breaths: LoopPoints[] = []; // oldest first
  private trail: number[] = []; // flat t, x, y, ...
  private prevNcc: number | null = null;
  private prevPhase: number | null = null;
  private lastEdge: number | null = null;
  private firstT: number | null = null;
  private lastT = 0;

  constructor(keep = 3, trailS = 1.0, noEdgeS = 2.0) {
    this.keep = keep;
    this.trailS = trailS;
    this.noEdgeS = noEdgeS;
  }

  push(t: number, x: number, y: number, ncc: number, phase: number | null = null) {
    if (this.firstT === null) this.firstT = t;
    if (t < this.lastT) this.clear(); // the model was rebuilt or reset
    this.lastT = t;
    if (this.prevNcc !== null && ncc < this.prevNcc) {
      if (this.current.length >= 4) {
        this.breaths.push(this.current);
        if (this.breaths.length > this.keep) this.breaths.shift();
      }
      this.current = [];
      this.lastEdge = t;
    }
    this.prevNcc = ncc;
    if (phase !== null && this.prevPhase !== null && phase < this.prevPhase) this.trail.push(t, NaN, NaN);
    this.prevPhase = phase;
    this.current.push(x, y);
    this.trail.push(t, x, y);
    let drop = 0;
    while (drop < this.trail.length && this.trail[drop] < t - this.trailS) drop += 3;
    if (drop) this.trail.splice(0, drop);
  }

  /** No breath edge for noEdgeS: show the rolling trail instead of breaths. */
  get trailMode(): boolean {
    const since = this.lastEdge ?? this.firstT;
    return since !== null && this.lastT - since > this.noEdgeS;
  }

  /** The trail as flat x, y points. */
  trailPoints(): LoopPoints {
    const out: LoopPoints = [];
    for (let i = 0; i < this.trail.length; i += 3) out.push(this.trail[i + 1], this.trail[i + 2]);
    return out;
  }

  /** What Save stores: the last completed breath, or the trail without breaths. */
  snapshot(): LoopPoints | null {
    if (this.trailMode) return this.trail.length ? this.trailPoints() : null;
    const last = this.breaths.at(-1);
    return last ? last.slice() : null;
  }

  clear() {
    this.current = [];
    this.breaths = [];
    this.trail = [];
    this.prevNcc = null;
    this.prevPhase = null;
    this.lastEdge = null;
    this.firstT = null;
    this.lastT = 0;
  }
}

// the narrowest candidate range holding [lo, hi]; the widest when none does
export function snapRange(lo: number, hi: number, candidates: [number, number][]): [number, number] {
  let best: [number, number] | null = null;
  for (const r of candidates) {
    if (lo >= r[0] && hi <= r[1] && (!best || r[1] - r[0] < best[1] - best[0])) best = r;
  }
  if (best) return best;
  return candidates.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
}

// min / max over flat x, y point lists
export function bounds(lists: LoopPoints[]): { x: [number, number]; y: [number, number] } | null {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of lists) {
    for (let i = 0; i < p.length; i += 2) {
      if (p[i] < x0) x0 = p[i];
      if (p[i] > x1) x1 = p[i];
      if (p[i + 1] < y0) y0 = p[i + 1];
      if (p[i + 1] > y1) y1 = p[i + 1];
    }
  }
  return x0 === Infinity ? null : { x: [x0, x1], y: [y0, y1] };
}
