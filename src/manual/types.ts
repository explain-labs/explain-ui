import type { Op } from "@/lessons/types";
import type { LaneId } from "@/render/monitorLanes";
import type { LayoutColumn } from "@/stores/layout";
import type { TourTarget } from "@/manual/targets";

// Engine ops a tour step may apply on entry — the lesson ops minus the
// lesson-only ones (interventions, lesson restart).
export type TourOp = Exclude<Op, { kind: "control" } | { kind: "restart" }>;

// UI changes made before a step is shown, so its target is on screen.
export type UiOp =
  | { tab: LayoutColumn; value: string } // switch a MainPage column's tab
  | { click: TourTarget }; // click an element (e.g. open a popover)

// Optional "do it yourself" gate: Next stays disabled and the tour moves on by
// itself once the learner has done this.
export type AdvanceOn =
  | { tab: LayoutColumn; value: string } // learner switched to this tab
  | { running: boolean } // learner started / stopped the simulation
  | { click: true } // learner clicked the spotlit target
  | { appear: TourTarget }; // an element showed up (e.g. selecting opens an inspector)

export interface TourStep {
  id: string; // also the markdown stem: steps/<id>.md
  title: string;
  target?: TourTarget; // spotlit element; omitted = centred card, no spotlight
  placement?: "top" | "bottom" | "left" | "right";
  ui?: UiOp[];
  onEnter?: TourOp[];
  // existing canvas/card highlights (same as lesson steps)
  diagramHighlight?: string[];
  diagramLabels?: Record<string, string>; // overrides DIAGRAM_LABELS captions ("" = none)
  monitorHighlight?: LaneId[];
  numericHighlight?: string[]; // numeric card paths (props[0])
  advanceOn?: AdvanceOn;
}

export interface Tour {
  id: string; // must match the folder name under src/manual/tours/
  title: string;
  summary: string;
  chapter: string; // menu group, e.g. "Basics"
  order: number; // sort order in the menu
  needsModel?: boolean; // only offered once a model is loaded (default true)
  steps: TourStep[];
}

// identity helper so tour files get type checking and completion
export const defineTour = (t: Tour): Tour => t;
