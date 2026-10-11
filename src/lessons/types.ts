import type { L10n } from "@/lessons/i18n";
import type { LaneId } from "@/render/monitorLanes";
import type { TaskCategory } from "@/services/commonTasks";

// what the lesson page's centre column can show
export type CentreTab = "diagram" | "sle6000";

// One thing a lesson does to the engine. Lesson actions, step `onEnter` hooks
// and interventions are all lists of ops, applied in order by useLesson.
export type Op =
  // tween a numeric prop to `value` over `it` s after `at` s (booleans/strings
  // swap instantly) — useExplain().setProp. `path` is "Model.prop".
  | { kind: "set"; path: string; value: number | boolean | string; it?: number; at?: number }
  // call a model method — useExplain().call, e.g. fn "Drugs.set_infusion"
  | { kind: "call"; fn: string; args?: unknown[]; at?: number }
  // set a ModelScaler group to an absolute factor (1 = baseline) — useExplain().scale,
  // the lever of Common tasks' scale tasks, e.g. "lung_compliance"'s elastance groups
  | { kind: "scale"; group: string | string[]; factor: number }
  // drive a registered intervention (see interventions.ts) to on/off, or a
  // slider to a raw value
  | { kind: "control"; id: string; state: "on" | "off" | number }
  // run `seconds` of model time synchronously (fast-forward)
  | { kind: "calculate"; seconds: number }
  | { kind: "run" }
  | { kind: "pause" }
  // rebuild the lesson's starting state and return to the first step
  | { kind: "restart" };

// A button in a step's text panel.
export interface LessonAction {
  id: string;
  label: L10n;
  icon?: string; // PrimeIcons class, e.g. "pi pi-times"
  severity?: "primary" | "secondary" | "success" | "info" | "warn" | "danger" | "contrast";
  ops: Op[];
}

// One numeric card in the lesson's readout. Same display rules as a scenario
// monitor parameter (factor, rounding, per-kg).
export interface LessonNumeric {
  label: L10n;
  props: string[]; // one path, or two rendered as "a/b"
  unit?: string;
  factor?: number;
  rounding?: number;
  weight_based?: boolean;
}

export interface LessonNumericGroup {
  key: string;
  title: L10n;
  collapsed?: boolean;
  parameters: LessonNumeric[];
}

export interface LessonStep {
  id: string; // also the markdown file stem: steps/<id>.<lang>.md
  // folder under src/lessons/ holding this step's markdown + images; default is
  // the lesson's own folder ("_shared" for the reusable intro steps)
  source?: string;
  title: L10n;
  image?: { file: string; caption?: L10n }; // file in the lesson's img/ folder
  actions?: LessonAction[];
  highlight?: string[]; // numeric paths (props[0]) to ring while on this step
  diagramHighlight?: string[]; // diagram component/connector names to point at
  // captions for highlighted diagram names; merged over the shared names in
  // diagramLabels.ts. Set a name to "" to highlight it without a caption.
  diagramLabels?: Record<string, L10n>;
  monitorHighlight?: LaneId[]; // bedside-monitor lanes to frame
  controls?: string[]; // intervention ids to spotlight (all stay usable)
  onEnter?: Op[]; // applied when the learner arrives on this step
  centreTab?: CentreTab; // switch the centre column to this tab on arrival
  draft?: boolean; // only shown in development builds
}

export interface Lesson {
  id: string; // must match the folder name and the nicupicu lesson account id
  title: L10n;
  subtitle?: L10n;
  scenario: string; // bundled scenario stem in model_definitions/
  autoRun?: boolean; // start the realtime loop once the model is built (default true)
  runOnAction?: boolean; // start the loop when an op is applied while paused (default true)
  controls: string[]; // intervention ids from interventions.ts, in display order
  numerics: LessonNumericGroup[];
  monitorLanes?: LaneId[]; // default: ecg, spo2_pre, spo2_post, abp
  layout?: LessonLayout;
  steps: LessonStep[];
}

// Optional page layout beyond the default (diagram in the centre, no tasks).
export interface LessonLayout {
  // centre column tabs in order; the first is shown on load. Default ["diagram"]
  centre?: CentreTab[];
  // adds a "Patient" tab on the left with the Common tasks panel, narrowed to
  // these categories and/or task ids (commonTasks.ts), sections opened
  tasks?: { categories?: TaskCategory[]; ids?: string[] };
}

// identity helper so lesson files get type checking and completion
export const defineLesson = (l: Lesson): Lesson => l;
