import { describe, expect, it } from "vitest";
import { evaluate, samplePaths, withinTolerance } from "@explain/papers/evaluate.js";
import experiments from "@explain/papers/p1/experiments.json";
import type { Experiment } from "@/lessons/types";

// The page shows the engine's own evaluator; these pin its contract (sampled
// paths, derived rows, per-kg) against the real P1 experiments file.
describe("paper experiments", () => {
  const spec = experiments as unknown as { experiments: Experiment[] };
  const baseline = spec.experiments.find((e) => e.id === "baseline")!;

  it("lists every sampled path once", () => {
    const paths = samplePaths(baseline);
    expect(paths).toContain("Monitor.flows.lvo");
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("derives per-kg and difference rows", () => {
    const averages = Object.fromEntries(samplePaths(baseline).map((p) => [p, 0]));
    averages["Monitor.flows.lvo"] = 0.6; // L/min
    averages["Monitor.minmax.lv_vol_max"] = 9.0; // mL
    averages["Monitor.minmax.lv_vol_min"] = 3.3;
    const v = evaluate(baseline, averages, 3.3);
    expect(v.lvo).toBeCloseTo(181.8, 1); // 0.6 L/min × 1000 / 3.3 kg
    expect(v.lvedv).toBeCloseTo(2.727, 3);
    expect(v.lvsv).toBeCloseTo(1.727, 3); // edv − esv, both per kg
  });

  it("judges tolerance from the measure", () => {
    const lvo = baseline.measures.find((m) => m.key === "lvo")!;
    expect(withinTolerance(lvo, 181)).toBe(true);
    expect(withinTolerance(lvo, 181 + (lvo.tol ?? 0) + 1)).toBe(false);
    expect(withinTolerance({ key: "x", label: "x", paper: "pattern" }, 1)).toBeNull();
  });

  it("every experiment names an existing scenario and only engine ops", () => {
    for (const e of spec.experiments) {
      expect(e.scenario).toMatch(/^[a-z0-9_]+$/);
      for (const op of e.ops) expect(["set", "scale", "call"]).toContain(op.kind);
      for (const m of e.measures) expect(!!m.path !== !!m.derive).toBe(true);
    }
  });
});
