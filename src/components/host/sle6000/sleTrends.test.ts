import { describe, expect, it } from "vitest";
import { TrendStore, decimate, stepZoom, stepCursor, zoomLabel, clockText, ZOOM_STEPS } from "./sleTrends";

const P = "Ventilator.mon_pip";
const samples = (t0: number, n: number, f = (t: number) => t) =>
  Array.from({ length: n }, (_, i) => ({ time: t0 + i, [P]: f(t0 + i) }));

describe("TrendStore", () => {
  it("appends 1 Hz samples and slices a window", () => {
    const s = new TrendStore([P], 100);
    expect(s.append(samples(0, 10))).toBe(10);
    const sl = s.slice(P, 3, 6);
    expect(sl.t).toEqual([3, 4, 5, 6]);
    expect(sl.v).toEqual([3, 4, 5, 6]);
  });

  it("skips samples already stored (realtime and fast-forward overlap)", () => {
    const s = new TrendStore([P], 100);
    s.append(samples(0, 10));
    expect(s.append(samples(5, 10))).toBe(5); // 5..9 already there
    expect(s.size).toBe(15);
  });

  it("clears when model time goes back (reset / rebuild)", () => {
    const s = new TrendStore([P], 100);
    s.append(samples(100, 10));
    s.append(samples(0, 3));
    expect(s.firstTime()).toBe(0);
    expect(s.size).toBe(3);
  });

  it("keeps only the capacity, dropping the oldest", () => {
    const s = new TrendStore([P], 50);
    s.append(samples(0, 120));
    expect(s.size).toBe(50);
    expect(s.firstTime()).toBe(70);
    expect(s.lastTime()).toBe(119);
    expect(s.slice(P, 0, 1000).t[0]).toBe(70);
  });

  it("returns the value nearest a time, and null without data", () => {
    const s = new TrendStore([P], 100);
    s.append(samples(0, 5, (t) => t * 10));
    expect(s.valueAt(P, 2.4)).toBe(20);
    expect(s.valueAt(P, 50)).toBeNull();
  });

  it("bumps version only when something was added", () => {
    const s = new TrendStore([P], 100);
    const v0 = s.version;
    s.append(samples(0, 3));
    const v1 = s.version;
    s.append(samples(0, 3));
    expect(v1).toBeGreaterThan(v0);
    expect(s.version).toBe(v1);
  });
});

describe("helpers", () => {
  it("decimates to per-column min / max", () => {
    const { mn, mx } = decimate([0, 1, 2, 3], [5, 1, 7, 3], 0, 4, 2);
    expect([mn[0], mx[0], mn[1], mx[1]]).toEqual([1, 5, 3, 7]);
  });
  it("steps the zoom through the manual's list", () => {
    expect(stepZoom(3600, 1)).toBe(7200);
    expect(stepZoom(3600, -1)).toBe(1800);
    expect(stepZoom(ZOOM_STEPS[0], -1)).toBe(900);
    expect(stepZoom(86400, 1)).toBe(86400);
    expect(zoomLabel(3600)).toBe("1 hour");
    expect(zoomLabel(900)).toBe("15 min");
    expect(zoomLabel(43200)).toBe("12 hours");
  });
  it("moves the cursor 1/60 of the window and into the next window past the end", () => {
    expect(stepCursor(30, [0, 60], 1)).toEqual({ cursorT: 31, shift: 0 });
    expect(stepCursor(59.5, [0, 60], 1).shift).toBe(60);
    expect(stepCursor(0.5, [0, 60], -1).shift).toBe(-60);
  });
  it("writes model time as hh:mm:ss", () => {
    expect(clockText(3725)).toBe("01:02:05");
  });
});
