import type { L10n } from "@/lessons/i18n";
import type { Op } from "@/lessons/types";

// Registry of lesson interventions. A lesson lists the ids it offers in
// `controls`; LessonControls renders them and useLesson applies them. Adding a
// new intervention (PGE1, FiO₂, knee-chest, tet spell, …) means adding one
// entry here, then naming its id in a lesson. Check every engine path against
// the lesson's scenario first (Model editor, or modelState in the console).

// "baseline" = the value in the loaded scenario file, so "open" returns a duct
// to however open that scenario had it.
export type ControlValue = number | "baseline";

export interface ToggleSide {
  label: L10n; // state name shown on the switch, e.g. "Open"
  value: ControlValue;
  it?: number; // tween duration in seconds of model time (default 1)
}

interface InterventionBase {
  id: string;
  label: L10n;
  help?: L10n; // one-line explanation under the control
  requires?: string[]; // model names that must exist, else the control is hidden
}

// Two-state control that tweens `read` between an on and an off value.
export interface ToggleIntervention extends InterventionBase {
  kind: "toggle";
  read: string; // "Model.prop" — both the state source and the tween target
  on: ToggleSide;
  off: ToggleSide;
}

// Continuous control. The slider works in display units (raw × factor).
export interface SliderIntervention extends InterventionBase {
  kind: "slider";
  read: string;
  min: number; // display units
  max: number;
  step: number;
  unit?: string;
  factor?: number; // display = raw × factor (default 1)
  // display = raw / (value at this path) × 100 — a percentage of a model max,
  // e.g. "Shunts.diameter_fo_max". Overrides `factor`.
  percentOf?: string;
  rounding?: number;
  // seconds of model time for a FULL-range change; a partial change tweens
  // proportionally faster (minimum 1 s). Default 1.
  it?: number;
  toOps?: (raw: number) => Op[]; // default: tween `read` to the raw value
}
// Sliders also accept control ops "off" (= min) and "on" (= the scenario's
// baseline value), so step actions like "Close the duct" work for either kind.

// One-shot action, e.g. "Start a tet spell".
export interface ButtonIntervention extends InterventionBase {
  kind: "button";
  icon?: string;
  ops: Op[];
}

export type Intervention = ToggleIntervention | SliderIntervention | ButtonIntervention;

export const INTERVENTIONS: Record<string, Intervention> = {
  // 100% = the duct's maximum diameter (Pda.diameter_*_max); diameter_relative
  // is already that fraction.
  ductus: {
    id: "ductus",
    kind: "slider",
    label: { nl: "Ductus arteriosus", en: "Ductus arteriosus" },
    help: {
      nl: "100% = maximale diameter. Volledig sluiten duurt 50 s modeltijd (in werkelijkheid uren tot dagen).",
      en: "100% = maximum diameter. Fully closing takes 50 s of model time (hours to days in real life).",
    },
    requires: ["Pda"],
    read: "Pda.diameter_relative",
    min: 0,
    max: 100,
    step: 5,
    unit: "%",
    factor: 100,
    it: 50,
  },
  // 100% = Shunts.diameter_fo_max (10 mm in the neonatal scenarios)
  foramen_ovale: {
    id: "foramen_ovale",
    kind: "slider",
    label: { nl: "Foramen ovale", en: "Foramen ovale" },
    help: { nl: "100% = maximale diameter.", en: "100% = maximum diameter." },
    requires: ["Shunts"],
    read: "Shunts.diameter_fo",
    percentOf: "Shunts.diameter_fo_max",
    min: 0,
    max: 100,
    step: 5,
    unit: "%",
    it: 30,
  },
};

export function getIntervention(id: string): Intervention | undefined {
  return INTERVENTIONS[id];
}
