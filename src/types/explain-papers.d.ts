// The engine's paper-companion evaluator (explain-engine/papers/<id>/evaluate.js)
// is plain JavaScript shared with the headless probe; declare its surface here.
declare module "@explain/papers/evaluate.js" {
  import type { Experiment, ExperimentMeasure } from "@/lessons/types";
  export function samplePaths(experiment: Experiment): string[];
  export function resolvePath(model: unknown, path: string): number | undefined;
  export function evaluate(
    experiment: Experiment,
    averages: Record<string, number>,
    weight: number,
  ): Record<string, number | undefined>;
  export function fmt(v: unknown, round?: number): string;
  export function withinTolerance(m: ExperimentMeasure, engine: unknown): boolean | null;
}
