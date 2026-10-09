import { describe, expect, it } from "vitest";
import { LoopBuffer, bounds, snapRange } from "./sleLoopBuffer";

// feed `n` samples of one breath: ncc_insp counts up from 0 (the reset to -1 happens between frames)
function breath(b: LoopBuffer, t0: number, n = 10, dt = 0.05) {
  for (let i = 0; i < n; i++) b.push(t0 + i * dt, i, i * 2, i);
  return t0 + n * dt;
}

describe("LoopBuffer", () => {
  it("starts a new breath when the inspiration counter drops", () => {
    const b = new LoopBuffer();
    let t = breath(b, 0);
    expect(b.breaths).toHaveLength(0);
    t = breath(b, t);
    expect(b.breaths).toHaveLength(1);
    expect(b.breaths[0]).toHaveLength(20); // 10 points of x, y
    expect(b.current).toHaveLength(20);
  });

  it("keeps only the last `keep` completed breaths", () => {
    const b = new LoopBuffer(3);
    let t = 0;
    for (let k = 0; k < 6; k++) t = breath(b, t);
    expect(b.breaths).toHaveLength(3);
  });

  it("falls back to a rolling trail without breath edges (HFOV)", () => {
    const b = new LoopBuffer(3, 1.0, 2.0);
    for (let i = 0; i < 400; i++) b.push(i * 0.01, Math.sin(i), Math.cos(i), 5); // no edge for 4 s
    expect(b.trailMode).toBe(true);
    const trail = b.trailPoints();
    expect(trail.length / 2).toBeLessThanOrEqual(102); // ~1 s at 10 ms
    expect(b.snapshot()).toEqual(trail);
  });

  it("breaks the trail at an HFO cycle edge (phase drop)", () => {
    const b = new LoopBuffer(3, 1.0, 0.5);
    for (let i = 0; i < 100; i++) b.push(i * 0.01, i % 10, i % 10, 5, (i % 10) / 10);
    const trail = b.trailPoints();
    expect(trail.filter((v) => Number.isNaN(v)).length).toBeGreaterThan(0);
    expect(bounds([trail])).toEqual({ x: [0, 9], y: [0, 9] }); // NaN breaks don't spoil the bounds
  });

  it("stays in breath mode while breaths keep coming", () => {
    const b = new LoopBuffer();
    let t = 0;
    for (let k = 0; k < 5; k++) t = breath(b, t, 20, 0.05); // a breath per second
    expect(b.trailMode).toBe(false);
    expect(b.snapshot()).toEqual(b.breaths.at(-1));
  });

  it("clears when model time goes backwards (rebuild)", () => {
    const b = new LoopBuffer();
    let t = breath(b, 10);
    breath(b, t);
    b.push(0, 1, 1, 0);
    expect(b.breaths).toHaveLength(0);
  });
});

describe("snapRange / bounds", () => {
  const C: [number, number][] = [[0, 10], [0, 20], [-10, 20], [0, 40]];
  it("picks the narrowest range that holds the data", () => {
    expect(snapRange(1, 9, C)).toEqual([0, 10]);
    expect(snapRange(1, 15, C)).toEqual([0, 20]);
    expect(snapRange(-5, 15, C)).toEqual([-10, 20]);
  });
  it("falls back to the widest range", () => {
    expect(snapRange(-50, 100, C)).toEqual([0, 40]);
  });
  it("finds the bounds of point lists", () => {
    expect(bounds([[1, 2, 3, -4], [0, 5]])).toEqual({ x: [0, 3], y: [-4, 5] });
    expect(bounds([[]])).toBeNull();
  });
});
