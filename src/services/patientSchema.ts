// Patient-builder form schema: the single source of truth for what a user can
// enter about a real neonate, in which units, within which limits, and what each
// value means to the builder (explain-engine/scripts/build_patient.mjs).
//
//   PATIENT_FIELDS        -> drives the form, the bot prompt and the result table
//   validateForm(form)    -> unit conversion + hard-range check, values in SPEC units
//   resolveTargets(...)   -> the deterministic rules that decide which measured
//                            values the builder calibrates to and which it only
//                            reports against
//
// Pure TS (no Vue/Pinia) so it is unit-testable and importable anywhere.
//
// PRIVACY: every field is a number or a fixed choice. There is deliberately no
// free-text field and no date: the form is sent to the AI bot, so it must not be
// able to carry a name, a birth date or a record number.

export type FieldCategory = "size" | "haemodynamics" | "respiratory" | "bloodgas" | "labs";

// What the builder does with a value:
//   structural - written into the model before calibration (weight, Hb, ...)
//   iterated   - a calibration target the builder tunes a lever to reach
//   check      - not targeted; reported next to what the model produces
//   context    - never reaches the builder; informs the bot and the rules below
export type FieldRole = "structural" | "iterated" | "check" | "context";

// "A": usable with the current builder. "B": the builder cannot use it yet
// (planned engine work); the value is still collected and shown as a check.
export type FieldPhase = "A" | "B";

export interface UnitDef {
  label: string;
  toSpec: (v: number) => number; // displayed unit -> SPEC unit
  fromSpec: (v: number) => number; // SPEC unit -> displayed unit
  step: number; // input step in the displayed unit
  digits: number; // decimals shown in the displayed unit
}

interface FieldBase {
  key: string;
  caption: string;
  category: FieldCategory;
  hint?: string;
}

export interface NumberField extends FieldBase {
  kind: "number";
  units: UnitDef[]; // first is the default
  specUnit: string; // label of the SPEC unit (for the prompt and result table)
  range: [number, number]; // hard limits in SPEC units; outside = rejected as a typo
  role: FieldRole;
  specTarget: string | null; // key in the builder SPEC `targets`, if any
  since: FieldPhase;
}

export interface ChoiceField extends FieldBase {
  kind: "choice";
  options: { value: string; label: string }[];
  role: "context";
}

export type PatientField = NumberField | ChoiceField;

const same = (label: string, step: number, digits: number): UnitDef => ({
  label,
  toSpec: (v) => v,
  fromSpec: (v) => v,
  step,
  digits,
});
const scaled = (label: string, perSpec: number, step: number, digits: number): UnitDef => ({
  label,
  toSpec: (v) => v / perSpec,
  fromSpec: (v) => v * perSpec,
  step,
  digits,
});

const KPA_PER_MMHG = 0.133322;
const GDL_PER_MMOL_HB = 1 / 0.6206; // the builder's own factor: 1 g/dL = 0.6206 mmol/L
const MGDL_PER_MMOL_GLUCOSE = 18.016;

export const CATEGORY_LABELS: Record<FieldCategory, string> = {
  size: "Size and age",
  haemodynamics: "Circulation",
  respiratory: "Breathing and oxygen",
  bloodgas: "Blood gas",
  labs: "Laboratory",
};

export const PATIENT_FIELDS: PatientField[] = [
  // ---- size and age ----
  { kind: "number", key: "gestational_age", caption: "Gestational age at birth", category: "size", units: [same("weeks", 0.1, 1)], specUnit: "weeks", range: [22, 43], role: "structural", specTarget: "gestational_age", since: "A", hint: "Completed weeks; 28+3 is 28.4" },
  { kind: "number", key: "postnatal_age", caption: "Postnatal age", category: "size", units: [same("days", 1, 0), scaled("hours", 24, 1, 0)], specUnit: "days", range: [0, 180], role: "context", specTarget: null, since: "A" },
  { kind: "number", key: "weight", caption: "Current weight", category: "size", units: [scaled("g", 1000, 10, 0), same("kg", 0.01, 3)], specUnit: "kg", range: [0.3, 7], role: "structural", specTarget: "weight", since: "A" },
  { kind: "number", key: "birth_weight", caption: "Birth weight", category: "size", units: [scaled("g", 1000, 10, 0), same("kg", 0.01, 3)], specUnit: "kg", range: [0.3, 7], role: "context", specTarget: null, since: "A" },
  { kind: "number", key: "height", caption: "Length", category: "size", units: [scaled("cm", 100, 0.5, 1)], specUnit: "m", range: [0.25, 0.7], role: "structural", specTarget: "height", since: "A" },

  // ---- circulation ----
  { kind: "number", key: "hr", caption: "Heart rate", category: "haemodynamics", units: [same("/min", 1, 0)], specUnit: "/min", range: [40, 260], role: "iterated", specTarget: "hr", since: "A" },
  { kind: "number", key: "sys", caption: "Systolic pressure", category: "haemodynamics", units: [same("mmHg", 1, 0)], specUnit: "mmHg", range: [15, 150], role: "iterated", specTarget: "sys", since: "A", hint: "Calibrated together with diastolic, as mean and pulse pressure" },
  { kind: "number", key: "dia", caption: "Diastolic pressure", category: "haemodynamics", units: [same("mmHg", 1, 0)], specUnit: "mmHg", range: [5, 110], role: "iterated", specTarget: "dia", since: "A" },
  { kind: "number", key: "map", caption: "Mean arterial pressure", category: "haemodynamics", units: [same("mmHg", 1, 0)], specUnit: "mmHg", range: [10, 120], role: "iterated", specTarget: "map", since: "A", hint: "Left empty, it is derived from systolic and diastolic" },
  { kind: "choice", key: "bp_method", caption: "Pressure measured by", category: "haemodynamics", role: "context", options: [{ value: "arterial_line", label: "Arterial line" }, { value: "cuff", label: "Cuff" }] },
  { kind: "number", key: "cvp", caption: "Central venous pressure", category: "haemodynamics", units: [same("mmHg", 0.5, 1)], specUnit: "mmHg", range: [-3, 25], role: "iterated", specTarget: "cvp", since: "A" },
  { kind: "number", key: "co", caption: "Cardiac output (echo)", category: "haemodynamics", units: [scaled("mL/min", 1000, 10, 0), same("L/min", 0.01, 2)], specUnit: "L/min", range: [0.03, 2.5], role: "iterated", specTarget: "co", since: "A", hint: "Left ventricular output. The most informative optional value: without a flow, output and resistance cannot be told apart" },

  // ---- breathing and oxygen ----
  { kind: "choice", key: "resp_support", caption: "Respiratory support", category: "respiratory", role: "context", options: [{ value: "none", label: "None" }, { value: "low_flow", label: "Low-flow oxygen" }, { value: "high_flow", label: "High-flow cannula" }, { value: "cpap", label: "CPAP" }, { value: "niv", label: "Non-invasive ventilation" }, { value: "invasive", label: "Invasive ventilation" }, { value: "hfo", label: "High-frequency oscillation" }] },
  { kind: "number", key: "fio2", caption: "FiO2", category: "respiratory", units: [scaled("%", 100, 1, 0)], specUnit: "fraction", range: [0.21, 1], role: "structural", specTarget: "fio2", since: "A", hint: "Left empty, room air (21%) is assumed" },
  { kind: "number", key: "rr", caption: "Respiratory rate", category: "respiratory", units: [same("/min", 1, 0)], specUnit: "/min", range: [0, 150], role: "iterated", specTarget: "rr", since: "A", hint: "Spontaneous breathing rate" },
  { kind: "number", key: "spo2", caption: "SpO2", category: "respiratory", units: [same("%", 1, 0)], specUnit: "%", range: [30, 100], role: "iterated", specTarget: "spo2", since: "A" },
  { kind: "choice", key: "spo2_site", caption: "SpO2 probe", category: "respiratory", role: "context", options: [{ value: "preductal", label: "Right hand (pre-ductal)" }, { value: "postductal", label: "Foot or left hand (post-ductal)" }] },
  { kind: "number", key: "spo2_post", caption: "SpO2 post-ductal (second probe)", category: "respiratory", units: [same("%", 1, 0)], specUnit: "%", range: [30, 100], role: "check", specTarget: null, since: "A" },

  // ---- blood gas ----
  { kind: "choice", key: "gas_site", caption: "Sample", category: "bloodgas", role: "context", options: [{ value: "arterial", label: "Arterial" }, { value: "capillary", label: "Capillary" }, { value: "venous", label: "Venous" }] },
  { kind: "number", key: "ph", caption: "pH", category: "bloodgas", units: [same("", 0.01, 2)], specUnit: "", range: [6.5, 7.8], role: "iterated", specTarget: "ph", since: "A" },
  { kind: "number", key: "pco2", caption: "pCO2", category: "bloodgas", units: [scaled("kPa", KPA_PER_MMHG, 0.1, 1), same("mmHg", 1, 0)], specUnit: "mmHg", range: [10, 150], role: "iterated", specTarget: "pco2", since: "A" },
  { kind: "number", key: "po2", caption: "pO2", category: "bloodgas", units: [scaled("kPa", KPA_PER_MMHG, 0.1, 1), same("mmHg", 1, 0)], specUnit: "mmHg", range: [10, 500], role: "iterated", specTarget: "po2", since: "A" },
  { kind: "number", key: "be", caption: "Base excess", category: "bloodgas", units: [same("mmol/L", 0.1, 1)], specUnit: "mmol/L", range: [-30, 20], role: "iterated", specTarget: "be", since: "A" },
  { kind: "number", key: "hco3", caption: "Bicarbonate", category: "bloodgas", units: [same("mmol/L", 0.1, 1)], specUnit: "mmol/L", range: [3, 50], role: "check", specTarget: null, since: "A" },
  { kind: "number", key: "lactate", caption: "Lactate", category: "bloodgas", units: [same("mmol/L", 0.1, 1)], specUnit: "mmol/L", range: [0.2, 30], role: "structural", specTarget: "lactate", since: "A" },

  // ---- laboratory ----
  { kind: "number", key: "hb", caption: "Haemoglobin", category: "labs", units: [same("mmol/L", 0.1, 1), scaled("g/dL", GDL_PER_MMOL_HB, 0.1, 1)], specUnit: "mmol/L", range: [2.5, 16], role: "structural", specTarget: "hb", since: "A" },
  { kind: "choice", key: "transfused", caption: "Red-cell transfusion given", category: "labs", role: "context", options: [{ value: "no", label: "No" }, { value: "yes", label: "Yes" }] },
  { kind: "number", key: "temp", caption: "Temperature", category: "labs", units: [same("°C", 0.1, 1)], specUnit: "°C", range: [30, 42], role: "structural", specTarget: "temp", since: "A" },
  { kind: "number", key: "na", caption: "Sodium", category: "labs", units: [same("mmol/L", 1, 0)], specUnit: "mmol/L", range: [105, 175], role: "structural", specTarget: "na", since: "A" },
  { kind: "number", key: "k", caption: "Potassium", category: "labs", units: [same("mmol/L", 0.1, 1)], specUnit: "mmol/L", range: [1.5, 10], role: "structural", specTarget: "k", since: "A" },
  { kind: "number", key: "cl", caption: "Chloride", category: "labs", units: [same("mmol/L", 1, 0)], specUnit: "mmol/L", range: [70, 135], role: "structural", specTarget: "cl", since: "A" },
  { kind: "number", key: "glucose", caption: "Glucose", category: "labs", units: [same("mmol/L", 0.1, 1), scaled("mg/dL", MGDL_PER_MMOL_GLUCOSE, 1, 0)], specUnit: "mmol/L", range: [0.3, 45], role: "structural", specTarget: "glucose", since: "A" },
  { kind: "number", key: "albumin", caption: "Albumin", category: "labs", units: [same("g/L", 1, 0)], specUnit: "g/L", range: [8, 55], role: "structural", specTarget: "albumin", since: "A" },
];

const FIELD_BY_KEY = new Map(PATIENT_FIELDS.map((f) => [f.key, f]));
export const getField = (key: string): PatientField | undefined => FIELD_BY_KEY.get(key);
export const numberField = (key: string): NumberField | undefined => {
  const f = FIELD_BY_KEY.get(key);
  return f && f.kind === "number" ? f : undefined;
};

// ---- form state -> validated values in SPEC units ----

// What the form holds per number field: the typed value and the chosen unit.
// A null/absent value means "not measured" (an unknown for the bot).
export interface NumberEntry {
  value: number | null;
  unit: string; // a UnitDef.label of that field
}
export interface PatientForm {
  numbers: Record<string, NumberEntry | undefined>;
  choices: Record<string, string | undefined>;
}

export interface FormIssue {
  key: string;
  message: string;
}

export interface ValidatedForm {
  values: Record<string, number>; // number fields that were filled in, SPEC units
  choices: Record<string, string>; // choice fields that were answered
  issues: FormIssue[]; // anything here blocks submission
}

// Converted values are kept to 4 significant digits: enough for any bedside
// measurement (3545 g, pH 7.283) and it stops conversion noise from reaching the
// builder as a target (6.8 kPa is 51 mmHg, not 51.0043).
const tidy = (v: number) => Number(v.toPrecision(4));

export function toSpecValue(field: NumberField, value: number, unitLabel: string): number {
  const unit = field.units.find((u) => u.label === unitLabel) ?? field.units[0];
  return tidy(unit.toSpec(value));
}

export function fromSpecValue(field: NumberField, specValue: number, unitLabel: string): number {
  const unit = field.units.find((u) => u.label === unitLabel) ?? field.units[0];
  return Number(unit.fromSpec(specValue).toFixed(unit.digits));
}

export function validateForm(form: PatientForm): ValidatedForm {
  const values: Record<string, number> = {};
  const choices: Record<string, string> = {};
  const issues: FormIssue[] = [];

  for (const field of PATIENT_FIELDS) {
    if (field.kind === "choice") {
      const c = form.choices[field.key];
      if (c == null || c === "") continue;
      if (field.options.some((o) => o.value === c)) choices[field.key] = c;
      else issues.push({ key: field.key, message: `${field.caption}: not one of the listed options` });
      continue;
    }
    const entry = form.numbers[field.key];
    if (!entry || entry.value == null) continue;
    if (typeof entry.value !== "number" || !Number.isFinite(entry.value)) {
      issues.push({ key: field.key, message: `${field.caption}: not a number` });
      continue;
    }
    const unit = field.units.find((u) => u.label === entry.unit);
    if (!unit) {
      issues.push({ key: field.key, message: `${field.caption}: unknown unit "${entry.unit}"` });
      continue;
    }
    const spec = tidy(unit.toSpec(entry.value));
    const [lo, hi] = field.range;
    if (spec < lo || spec > hi) {
      const shown = `${fromSpecValue(field, lo, unit.label)}–${fromSpecValue(field, hi, unit.label)} ${unit.label}`.trim();
      issues.push({ key: field.key, message: `${field.caption}: outside the accepted range (${shown})` });
      continue;
    }
    values[field.key] = spec;
  }

  // cross-field checks
  if (values.sys != null && values.dia != null && values.dia >= values.sys) {
    issues.push({ key: "dia", message: "Diastolic pressure must be below systolic" });
  }
  if (values.map != null && values.sys != null && values.map >= values.sys) {
    issues.push({ key: "map", message: "Mean pressure must be below systolic" });
  }
  if (values.map != null && values.dia != null && values.map <= values.dia) {
    issues.push({ key: "map", message: "Mean pressure must be above diastolic" });
  }
  if (values.weight == null && values.gestational_age == null) {
    issues.push({ key: "weight", message: "Give at least a weight or a gestational age" });
  }

  return { values, choices, issues };
}

// ---- deterministic target rules ----

export interface DerivedValue {
  key: string;
  value: number; // SPEC units
  basis: string;
}

export interface ResolvedTargets {
  // goes into the builder SPEC `targets`: measured structural values plus the
  // measured vitals the builder should calibrate to (SPEC keys, SPEC units)
  targets: Record<string, number>;
  // measured, but only compared against the model's result: key -> reason
  checks: Record<string, string>;
  // computed here from measured values (never by the bot)
  derived: DerivedValue[];
  // values the current builder cannot use yet
  unsupported: string[];
  // structural / iterated fields that were left empty: the bot's unknowns
  unknown: string[];
  warnings: string[];
}

const VENTILATED = new Set(["niv", "invasive", "hfo"]);
const NOT_LOOKED_UP = new Set(["fio2", "lactate", "na", "k", "cl", "glucose", "albumin"]);

// Decides, from the validated form alone, what the builder calibrates to.
// These rules are deliberately NOT left to the bot:
//   - MAP is derived from systolic/diastolic when it was not measured.
//   - Systolic and diastolic are calibrated as a pair (mean + pulse pressure);
//     one without the other is only compared.
//   - A respiratory rate is a target only for a spontaneously breathing patient;
//     a ventilated patient's rate is set by the ventilator, which is not modelled.
//   - The builder silently prefers po2 over spo2 and be over ph, so exactly one
//     of each pair is sent as a target; the other is reported as a check.
//   - A pO2 is only a target when the sample is arterial. Capillary and venous
//     pO2 do not reflect arterial oxygenation.
//   - A venous pCO2/pH is not a target (it differs from arterial by a variable
//     amount); a venous base excess still is.
//   - The engine reads oxygen saturation pre-ductally, so a post-ductal SpO2 is
//     a check, not a target.
export function resolveTargets(v: ValidatedForm): ResolvedTargets {
  const { values, choices } = v;
  const targets: Record<string, number> = {};
  const checks: Record<string, string> = {};
  const derived: DerivedValue[] = [];
  const unsupported: string[] = [];
  const warnings: string[] = [];
  const has = (k: string) => values[k] != null;

  const gasSite = choices.gas_site ?? null;
  const anyGas = ["ph", "pco2", "po2", "be", "hco3"].some(has);
  if (anyGas && !gasSite) {
    warnings.push("No blood-gas sample site given: treated as capillary (pO2 is not used as a target).");
  }
  const site = gasSite ?? "capillary";

  for (const field of PATIENT_FIELDS) {
    if (field.kind !== "number" || !has(field.key)) continue;
    const value = values[field.key];
    if (field.role === "context") continue;
    if (field.since === "B") {
      unsupported.push(field.key);
      checks[field.key] = "the builder cannot use this value yet";
      continue;
    }
    if (field.role === "check") {
      checks[field.key] = "reported for comparison";
      continue;
    }
    if (field.specTarget) targets[field.specTarget] = value;
  }

  // systolic/diastolic only as a pair: the builder calibrates their mean and
  // their difference, and ignores one on its own
  if (has("sys") !== has("dia")) {
    const k = has("sys") ? "sys" : "dia";
    delete targets[k];
    checks[k] = `calibrated only together with ${k === "sys" ? "diastolic" : "systolic"} pressure`;
  }

  // MAP from systolic/diastolic
  if (!has("map") && has("sys") && has("dia")) {
    const map = tidy(values.dia + (values.sys - values.dia) / 3);
    targets.map = Number(map.toFixed(1));
    derived.push({ key: "map", value: targets.map, basis: "diastolic + (systolic − diastolic) / 3" });
  }

  // oxygenation: exactly one of po2 / spo2
  if (has("spo2") && choices.spo2_site === "postductal") {
    delete targets.spo2;
    checks.spo2 = "post-ductal probe: the model reads saturation pre-ductally";
  }
  if (has("po2") && site !== "arterial") {
    delete targets.po2;
    checks.po2 = `${site} sample: pO2 does not reflect arterial oxygenation`;
  }
  if (targets.po2 != null && targets.spo2 != null) {
    delete targets.spo2;
    checks.spo2 = "arterial pO2 is the oxygenation target; SpO2 follows from the model's dissociation curve";
  }

  // acid-base: venous pCO2/pH are not targets; then exactly one of be / ph
  if (site === "venous") {
    for (const k of ["pco2", "ph"]) {
      if (targets[k] != null) {
        delete targets[k];
        checks[k] = "venous sample: differs from arterial by a variable amount";
      }
    }
  }
  if (targets.be != null && targets.ph != null) {
    delete targets.ph;
    checks.ph = "base excess and pCO2 are the targets; pH follows from them";
  }

  if (targets.rr != null && VENTILATED.has(choices.resp_support ?? "")) {
    delete targets.rr;
    checks.rr = "ventilated: the rate is set by the ventilator, which the built patient does not have";
  }

  if (targets.pco2 != null && VENTILATED.has(choices.resp_support ?? "")) {
    warnings.push(
      "This patient is ventilated. The builder reaches the pCO2 by adjusting spontaneous breathing drive, so the built patient breathes on its own and no ventilator is set up.",
    );
  }
  if ((has("spo2") || has("po2")) && !has("fio2")) {
    warnings.push("No FiO2 given: oxygenation is fitted as if the patient were breathing room air.");
  }
  if (targets.map != null && targets.co == null) {
    warnings.push("No cardiac output given: the split between cardiac output and vascular resistance comes from the baseline, not from this patient.");
  }

  const unknown = PATIENT_FIELDS.filter(
    (f): f is NumberField => f.kind === "number" && f.since === "A" && (f.role === "structural" || f.role === "iterated"),
  )
    .filter((f) => !has(f.key) && !(f.key === "map" && targets.map != null))
    // an unmeasured FiO2 means room air, and an unmeasured solute keeps the baseline's
    // normal value: neither is something for the bot to look up
    .filter((f) => !NOT_LOOKED_UP.has(f.key))
    .map((f) => f.key);

  return { targets, checks, derived, unsupported, unknown, warnings };
}
