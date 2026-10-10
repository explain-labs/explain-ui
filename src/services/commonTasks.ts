// Common physiological tasks — the curated set of DIRECTIONAL NUDGES
// ("raise PVR 30%", "halve contractility") that both the UI quick-action panel
// (src/components/controls/CommonTasksPanel.vue) and the chat bot offer.
//
// Single source of truth, mirroring botCommandAllowlist.ts: the panel imports
// COMMON_TASKS directly, and scripts/build_command_catalog.mjs bundles the SAME
// list into the bot's catalog so the bot never advertises a nudge the webapp
// can't perform. Vue/Pinia-free (pure data + pure helpers) so esbuild can bundle
// it for the catalog generator.
//
// HOW A NUDGE RESOLVES (the key design decision):
//   - setProp lever — a single readable prop (a `*_factor_ps` `factor` field or a
//     plain `number`) drives the quantity. Read the current value from the live
//     state, multiply by (1±step), clamp, write it back. Exact accumulation,
//     reversible via `revert`, composes with drugs/hormones/ANS. PREFERRED.
//   - scale lever — the quantity is a bundle of many components with no single
//     prop (contractility, lung elastances, …) handled by ModelScaler. Scale
//     groups are ABSOLUTE (1.0 = baseline). ModelScaler itself is stripped from
//     the state snapshot, but most groups land as `*_factor_scaling_ps` on their
//     components, so the UI reads the current factor back from there
//     (currentScaleFactor) and only tracks volume groups client-side. The bot
//     treats `factor` as absolute.
//   - call lever — the quantity has a setter that recomputes derived state (the ET
//     tube's Rohrer coefficients follow its diameter), so writing the prop alone
//     would not take effect. Read the current value from `read`, step it, and call
//     the setter with the new value. Absolute stepping only.

export type TaskCategory =
  | "vascular_tone"
  | "cardiac_performance"
  | "rate_rhythm"
  | "lung_mechanics"
  | "gas_exchange"
  | "shunts"
  | "ventilation_drive"
  | "blood_acidbase"
  | "metabolic_thermal"
  | "ventilator";

export type NudgeDirection = "up" | "down";

// setProp lever: one readable prop on a model (a sub-model of a composite, e.g.
//   the ventilator's VENT_ETTUBE, is found inside its parent's components).
//   `model` is a singleton INSTANCE name (Circulation/Heart/…) unless
//   `resolveByType` is set, in which case it's a model_type resolved to the
//   actual instance(s) at runtime (and not Guided-allowlisted, since the
//   instance name isn't fixed).
// scale lever: one or more ModelScaler group(s); current factor read from the
//   state snapshot where possible (UI) / absolute-from-1.0 (bot).
// call lever: a singleton instance's setter `fn`, called with the new value;
//   `read` is the prop holding the current value.
export type Lever =
  | {
      kind: "setProp";
      model: string;
      target: string;
      field: "factor" | "number";
      resolveByType?: boolean;
    }
  | { kind: "scale"; group: string | string[] }
  | { kind: "call"; model: string; fn: string; read: string };

export interface CommonTask {
  id: string; // stable id, e.g. "svr"
  label: string; // full label, e.g. "Systemic vascular resistance (afterload)"
  short: string; // button-group title, e.g. "SVR"
  category: TaskCategory;
  lever: Lever;
  mode?: "factor" | "absolute"; // "factor" (default) = multiplicative ±%; "absolute"
  //                   = additive ± step in the prop's own units. Use absolute for
  //                   quantities that sit at 0 (closed shunts) where ×anything stays 0.
  invert?: boolean; // the physiological quantity is the INVERSE of the lever
  //                   (compliance↔elastance; "more preload"↔lower systemic_u_vol)
  step: number; // default step — a fraction for "factor" (0.3 = ±30%) or an absolute
  //                   increment for "absolute" (e.g. 0.1 of diameter_relative)
  steps?: number[]; // selectable steps offered in the UI
  min?: number; // clamp on the resulting factor/value
  max?: number;
  unit?: string; // for number levers (display only)
  help?: string; // tooltip + bot note
}

// The categories in the order the panel (and the bot catalog) lists them: the
// respiratory ones first, then the rest.
export const TASK_CATEGORY_LABELS: Record<TaskCategory, string> = {
  lung_mechanics: "Lung mechanics",
  ventilation_drive: "Ventilation drive",
  ventilator: "Ventilator",
  vascular_tone: "Vascular tone",
  cardiac_performance: "Cardiac performance",
  rate_rhythm: "Rate & rhythm",
  gas_exchange: "Gas exchange",
  shunts: "Shunts & fetal channels",
  blood_acidbase: "Blood & acid-base",
  metabolic_thermal: "Metabolic & thermal",
};
export const TASK_CATEGORY_ORDER = Object.keys(TASK_CATEGORY_LABELS) as TaskCategory[];

// First-wave tasks. Steps default to a sensible ±% per quantity.
export const COMMON_TASKS: CommonTask[] = [
  // --- Vascular tone ---
  {
    id: "svr",
    label: "Systemic vascular resistance (afterload)",
    short: "SVR",
    category: "vascular_tone",
    // Use the ModelScaler systemic-resistance group, NOT Circulation.svr_factor_art:
    // that factor is rewritten every step by the Hormones (RAAS) model, so a
    // one-shot setProp is clobbered. The *_scaling_ps layer this group writes is
    // independent of ANS/Hormones/drugs, so the nudge sticks.
    lever: { kind: "scale", group: "systemic_resistances" },
    step: 0.3,
    steps: [0.1, 0.2, 0.3, 0.5],
    min: 0.2,
    max: 10,
    help: "LV afterload. Up = vasoconstriction/pressor; down = vasodilation. (MAP is partly defended by the baroreflex — CO/HR shift too.)",
  },
  {
    id: "pvr",
    label: "Pulmonary vascular resistance (RV afterload)",
    short: "PVR",
    category: "vascular_tone",
    lever: { kind: "scale", group: "pulmonary_resistances" },
    step: 0.3,
    steps: [0.1, 0.2, 0.3, 0.5],
    min: 0.2,
    max: 10,
    help: "Pulmonary hypertension (up) vs vasodilator / iNO (down).",
  },
  {
    id: "venous_tone",
    label: "Venous tone / preload",
    short: "Preload",
    category: "vascular_tone",
    lever: { kind: "scale", group: "systemic_u_vol" },
    invert: true, // more preload = LOWER unstressed volume
    step: 0.2,
    steps: [0.1, 0.2, 0.3],
    min: 0.3,
    max: 3,
    help: "Up = more venous return/preload (lowers unstressed volume).",
  },
  // --- Cardiac performance ---
  {
    id: "contractility",
    label: "Contractility (both ventricles)",
    short: "Contractility",
    category: "cardiac_performance",
    lever: { kind: "scale", group: "heart_el_max" },
    step: 0.3,
    steps: [0.1, 0.2, 0.3, 0.5],
    min: 0.1,
    max: 5,
    help: "Inotropy. Down 0.5 = halve contractility.",
  },
  {
    id: "lusitropy",
    label: "Diastolic stiffness",
    short: "Diastolic stiffness",
    category: "cardiac_performance",
    lever: { kind: "scale", group: "heart_el_min" },
    step: 0.3,
    steps: [0.1, 0.2, 0.3],
    min: 0.2,
    max: 5,
    help: "Up = stiffer ventricle / diastolic dysfunction.",
  },
  // --- Rate & rhythm ---
  {
    id: "heart_rate",
    label: "Heart rate (reference)",
    short: "Heart rate",
    category: "rate_rhythm",
    lever: { kind: "setProp", model: "Heart", target: "heart_rate_ref", field: "number" },
    step: 0.2,
    steps: [0.1, 0.2, 0.3],
    min: 20,
    max: 300,
    unit: "bpm",
    help: "Tachycardia (up) / bradycardia (down).",
  },
  // --- Lung mechanics ---
  {
    id: "lung_compliance",
    label: "Lung compliance",
    short: "Lung compliance",
    category: "lung_mechanics",
    lever: { kind: "scale", group: ["left_lung_elastances", "right_lung_elastances"] },
    invert: true, // compliance = 1 / elastance
    step: 0.2,
    steps: [0.1, 0.2, 0.3],
    min: 0.2,
    max: 5,
    help: "Down = stiffer lungs (RDS / hypoplasia); up = more compliant.",
  },
  {
    id: "airway_resistance",
    label: "Airway resistance",
    short: "Airway resistance",
    category: "lung_mechanics",
    lever: { kind: "scale", group: "airway_lower_resistances" },
    step: 0.3,
    steps: [0.2, 0.3, 0.5],
    min: 0.2,
    max: 10,
    help: "Up = bronchospasm / obstruction.",
  },
  // Atelectasis: the collapsed fraction of one lung. Respiration couples the lost
  // aerated volume, compliance and gas-exchange surface with the shunting of the
  // collapsed units' blood; PEEP does not reopen it (static).
  ...(["left", "right"] as const).map(
    (side): CommonTask => ({
      id: `atelectasis_${side}`,
      label: `Atelectasis ${side} lung (collapsed fraction)`,
      short: `Atelectasis ${side === "left" ? "L" : "R"}`,
      category: "lung_mechanics",
      lever: { kind: "call", model: "Respiration", fn: `set_atelectasis_${side}`, read: `atelectasis_${side}` },
      mode: "absolute",
      step: 0.1,
      steps: [0.05, 0.1, 0.2],
      min: 0,
      max: 0.9,
      help: `Fraction of the ${side} lung collapsed (0 = aerated, 0.9 = near-total). Lowers that lung's FRC, compliance and diffusion and shunts its collapsed units' blood: SpO2 and Vte fall, pCO2 rises. PEEP does not reopen it.`,
    }),
  ),
  // --- Gas exchange ---
  {
    id: "o2_diffusion",
    label: "O2 diffusion capacity",
    short: "O2 diffusion",
    category: "gas_exchange",
    // GasExchanger instances are scenario-specific (e.g. GASEX_LL/RL) — resolved
    // by model_type and HIDDEN when absent (reduced topologies).
    lever: {
      kind: "setProp",
      model: "GasExchanger",
      target: "dif_o2_factor_ps",
      field: "factor",
      resolveByType: true,
    },
    step: 0.3,
    steps: [0.2, 0.3, 0.5],
    min: 0.05,
    max: 10,
    help: "Down = impaired alveolar O2 transfer.",
  },
  // --- Shunts & fetal channels (absolute stepping: these sit at 0 when closed,
  //     and the engine treats diameter === 0 as a hard-closed fast path, so a
  //     multiplicative nudge could never open them) ---
  {
    id: "pda",
    label: "Ductus arteriosus (PDA) size",
    short: "PDA",
    category: "shunts",
    lever: { kind: "setProp", model: "Pda", target: "diameter_relative", field: "number" },
    mode: "absolute",
    step: 0.1,
    steps: [0.05, 0.1, 0.2],
    min: 0,
    max: 1,
    help: "Relative patency 0 (closed) → 1 (fully open).",
  },
  {
    id: "foramen_ovale",
    label: "Foramen ovale size",
    short: "Foramen ovale",
    category: "shunts",
    lever: { kind: "setProp", model: "Shunts", target: "diameter_fo", field: "number" },
    mode: "absolute",
    step: 1,
    steps: [0.5, 1, 2],
    min: 0,
    max: 10,
    unit: "mm",
    help: "Atrial-level shunt. 0 = closed.",
  },
  {
    id: "vsd",
    label: "Ventricular septal defect (VSD) size",
    short: "VSD",
    category: "shunts",
    lever: { kind: "setProp", model: "Shunts", target: "diameter_vsd", field: "number" },
    mode: "absolute",
    step: 1,
    steps: [0.5, 1, 2],
    min: 0,
    max: 10,
    unit: "mm",
    help: "Ventricular-level shunt. 0 = none.",
  },
  // --- Ventilation drive ---
  {
    id: "minute_volume",
    label: "Ventilation drive (reference minute volume)",
    short: "Ventilation drive",
    category: "ventilation_drive",
    lever: { kind: "setProp", model: "Breathing", target: "minute_volume_ref", field: "number" },
    step: 0.2,
    steps: [0.1, 0.2, 0.3],
    min: 0.01,
    max: 5,
    unit: "L/kg/min",
    help: "Up = hyperventilation (↓pCO2); down = hypoventilation (↑pCO2).",
  },
  // --- Metabolic & thermal ---
  {
    id: "vo2",
    label: "Metabolic demand (VO2)",
    short: "VO2",
    category: "metabolic_thermal",
    lever: { kind: "setProp", model: "Metabolism", target: "vo2", field: "number" },
    step: 0.2,
    steps: [0.1, 0.2, 0.3],
    min: 0.1,
    max: 50,
    unit: "mL/kg/min",
    help: "Up = sepsis/hypermetabolism; down = hypothermia/sedation.",
  },
  // --- Blood & acid-base ---
  {
    id: "blood_volume",
    label: "Blood volume",
    short: "Blood volume",
    category: "blood_acidbase",
    lever: { kind: "scale", group: "blood_volume" },
    step: 0.1,
    steps: [0.05, 0.1, 0.2],
    min: 0.3,
    max: 2,
    help: "Down = hemorrhage; up = fluid overload.",
  },
  // --- Ventilator: the airway and circuit side, nothing that is set on the ventilator's
  //     own screen. Hidden when the scenario has no ventilator ---
  {
    id: "ett_diameter",
    label: "Endotracheal tube internal diameter",
    short: "ETT size",
    category: "ventilator",
    // the setter recomputes the tube's Rohrer coefficients; writing ettube_diameter alone would not
    lever: { kind: "call", model: "Ventilator", fn: "set_ettube_diameter", read: "ettube_diameter" },
    mode: "absolute",
    step: 0.5,
    steps: [0.5, 1],
    min: 2,
    max: 9,
    unit: "mm",
    help: "Tube resistance rises steeply as the tube narrows (about d⁻⁴); the tube lumen is dead space too.",
  },
  {
    id: "ett_length",
    label: "Endotracheal tube length",
    short: "ETT length",
    category: "ventilator",
    lever: { kind: "call", model: "Ventilator", fn: "set_ettube_length", read: "ettube_length" },
    mode: "absolute",
    step: 10,
    steps: [10, 20],
    min: 50,
    max: 300,
    unit: "mm",
    help: "Resistance and tube dead space grow with length (e.g. an uncut tube).",
  },
  {
    id: "tube_leak",
    label: "Leak around the endotracheal tube",
    short: "Tube leak",
    category: "ventilator",
    lever: { kind: "setProp", model: "Ventilator", target: "leak_size", field: "number" },
    mode: "absolute",
    step: 0.1,
    steps: [0.05, 0.1, 0.2],
    min: 0,
    max: 3,
    unit: "mm",
    help: "Gap around an uncuffed tube. 0 = no leak. The SLE6000 compensates leaks up to 35 %; above that it autotriggers.",
  },
  {
    id: "ett_obstruction",
    label: "Endotracheal tube obstruction (secretions, kink)",
    short: "Tube obstruction",
    category: "ventilator",
    // composes on the r_for the ventilator writes every step (Resistor.calc_resistance)
    lever: { kind: "setProp", model: "VENT_ETTUBE", target: "r_factor_ps", field: "factor" },
    step: 0.5,
    steps: [0.3, 0.5, 1],
    min: 1,
    max: 20,
    help: "Multiplies the tube resistance. Up = secretions / kinked tube: same pressures, less volume.",
  },
  {
    id: "humid_temp",
    label: "Humidifier temperature",
    short: "Humidifier temp",
    category: "ventilator",
    lever: { kind: "call", model: "Ventilator", fn: "set_temp", read: "temp" },
    mode: "absolute",
    step: 1,
    steps: [0.5, 1, 2],
    min: 20,
    max: 42,
    unit: "°C",
    help: "Temperature of the inspired gas from the heated humidifier.",
  },
];

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

// Symmetric multiplier so an up-then-down (same step) returns to baseline:
// down = 1/(1+step) is the true inverse of up = (1+step). `invert` flips which
// direction raises the underlying lever (for inverse quantities like compliance).
export function nudgeMultiplier(step: number, dir: NudgeDirection, invert = false): number {
  const raiseLever = invert ? dir === "down" : dir === "up";
  return raiseLever ? 1 + step : 1 / (1 + step);
}

// Next value for a multiplicative ("factor") setProp lever, given the current value.
export function nextSetPropValue(cur: number, t: CommonTask, dir: NudgeDirection): number {
  const v = cur * nudgeMultiplier(t.step, dir, t.invert);
  return clamp(v, t.min ?? -Infinity, t.max ?? Infinity);
}

// Next value for an "absolute" setProp lever: add/subtract the step (in the prop's
// own units) instead of multiplying — so a quantity at 0 (a closed shunt) can be
// opened. `invert` flips which direction increases the underlying prop.
export function nextAbsoluteValue(cur: number, t: CommonTask, dir: NudgeDirection): number {
  const raise = t.invert ? dir === "down" : dir === "up";
  const v = cur + (raise ? t.step : -t.step);
  return clamp(v, t.min ?? -Infinity, t.max ?? Infinity);
}

// Next absolute factor for a scale lever, given its current factor (baseline
// 1.0; see currentScaleFactor).
export function nextScaleFactor(curFactor: number, t: CommonTask, dir: NudgeDirection): number {
  const v = curFactor * nudgeMultiplier(t.step, dir, t.invert);
  return clamp(v, t.min ?? 0.05, t.max ?? 20);
}

// Where ModelScaler writes each factor-style scale group: the scaler_config list
// of components and the `*_factor_scaling_ps` prop it sets ABSOLUTELY on each
// (explain-engine/helpers/ModelScaler.js). Those props ride in the state
// snapshot, so the current factor survives a save/load even though ModelScaler
// itself is stripped. Volume groups (blood_volume, …) are absent on purpose:
// they scale `vol` by a delta and the engine re-baselines them to 1.0 on every
// build, so the client-tracked 1.0 is already right for them.
const SCALE_GROUP_FIELDS: Record<string, { config: [string, string]; prop: string }> = {
  systemic_resistances: { config: ["blood_systemic", "resistance"], prop: "r_factor_scaling_ps" },
  systemic_elastances: { config: ["blood_systemic", "el_base"], prop: "el_base_factor_scaling_ps" },
  systemic_u_vol: { config: ["blood_systemic", "el_base"], prop: "u_vol_factor_scaling_ps" },
  pulmonary_resistances: { config: ["blood_pulmonary", "resistance"], prop: "r_factor_scaling_ps" },
  pulmonary_elastances: { config: ["blood_pulmonary", "el_base"], prop: "el_base_factor_scaling_ps" },
  pulmonary_u_vol: { config: ["blood_pulmonary", "el_base"], prop: "u_vol_factor_scaling_ps" },
  heart_el_min: { config: ["heart", "el_min"], prop: "el_min_factor_scaling_ps" },
  heart_el_max: { config: ["heart", "el_max"], prop: "el_max_factor_scaling_ps" },
  left_lung_elastances: { config: ["left_lung", "el_base"], prop: "el_base_factor_scaling_ps" },
  right_lung_elastances: { config: ["right_lung", "el_base"], prop: "el_base_factor_scaling_ps" },
  airway_upper_resistances: { config: ["airway", "resistance_upper"], prop: "r_factor_scaling_ps" },
  airway_lower_resistances: { config: ["airway", "resistance_lower"], prop: "r_factor_scaling_ps" },
};

// A model instance from a state snapshot. The snapshot moves composite
// sub-models out of `models` into their parent's `components` map (e.g.
// Circulation.components.AA), possibly several levels deep, so search those too.
export function findInstance(models: Record<string, any>, name: string): any {
  if (models[name] && typeof models[name] === "object") return models[name];
  for (const m of Object.values(models)) {
    const comps = m?.components;
    if (comps && typeof comps === "object") {
      const hit = findInstance(comps, name);
      if (hit) return hit;
    }
  }
  return null;
}

// Current absolute factor of a scale lever, read from a state snapshot (the
// first group of a multi-group lever, from the first component that carries
// the prop). null when it can't be read — a volume group, or a scenario without
// that group — so the caller falls back to its own tracking.
export function currentScaleFactor(lever: Lever, modelState: any): number | null {
  if (lever.kind !== "scale") return null;
  const group = Array.isArray(lever.group) ? lever.group[0] : lever.group;
  const field = SCALE_GROUP_FIELDS[group];
  const names: unknown = modelState?.scaler_config?.[field?.config[0] ?? ""]?.[field?.config[1] ?? ""];
  const models = modelState?.models;
  if (!field || !Array.isArray(names) || !models) return null;
  for (const name of names) {
    const v = findInstance(models, String(name))?.[field.prop];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

// Derive bot allowlist entries (op:"setProp" / op:"call") for the singleton setProp
// and call levers so nudges work in GUIDED scope too. model_type-resolved levers
// (resolveByType) are skipped — their instance name isn't fixed, so they stay
// Full-scope only. Imported by botCommandAllowlist.ts to stay DRY.
export function commonTaskAllowEntries(): Array<{
  op: "setProp" | "call";
  model: string;
  target: string;
  note: string;
}> {
  const out: Array<{ op: "setProp" | "call"; model: string; target: string; note: string }> = [];
  for (const t of COMMON_TASKS) {
    if (t.lever.kind === "call") {
      out.push({
        op: "call",
        model: t.lever.model,
        target: t.lever.fn,
        note: `${t.label} — directional nudge lever (arg: new value${t.unit ? `, ${t.unit}` : ""})`,
      });
      continue;
    }
    if (t.lever.kind !== "setProp" || t.lever.resolveByType) continue;
    out.push({
      op: "setProp",
      model: t.lever.model,
      target: t.lever.target,
      note: `${t.label} — directional nudge lever`,
    });
  }
  return out;
}
