// Patient-builder wire format: what the app sends to the bot for a filled-in
// form, and how the bot's answer is read back.
//
//   buildRequest(form)        -> validated form + resolved targets + the prompt
//   parseProvenance(answer)   -> the bot's ```explain-provenance``` block, validated
//   checkSpec(spec, request)  -> did the bot build what the user measured?
//
// The bot never sees or echoes measured values as its own: measured rows in the
// result come from the form, and checkSpec() compares the SPEC the server
// actually built (echoed in the /api/chat response `build.spec`) against it.
// Protocol reference for the bot: knowledge-pack/command-protocol.md.

import { PATIENT_FIELDS, numberField, resolveTargets, validateForm, type PatientForm, type ResolvedTargets, type ValidatedForm } from "./patientSchema";

export const FORM_SCHEMA_VERSION = 1;
// First line of the prompt; the bot's protocol doc keys its form workflow on it.
export const FORM_MARKER = "[explain-patient-form]";

export interface PatientBuildRequest {
  requestId: string; // random; also the built patient's name, so no user text reaches the bot
  validated: ValidatedForm;
  resolved: ResolvedTargets;
  payload: FormPayload;
  prompt: string;
}

// The JSON inside the ```explain-patient-form``` block.
export interface FormPayload {
  schema: number;
  request_id: string;
  targets: Record<string, number>; // must reach the builder SPEC unchanged
  checks: Record<string, number>; // measured, not targeted
  context: Record<string, string | number>;
  unknown: string[]; // structural / iterated values the user did not measure
  units: Record<string, string>;
}

const randomId = () => {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return "pb_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

// Returns null when the form has blocking issues (read them from validateForm).
export function buildRequest(form: PatientForm, requestId: string = randomId()): PatientBuildRequest | null {
  const validated = validateForm(form);
  if (validated.issues.length) return null;
  const resolved = resolveTargets(validated);

  const checks: Record<string, number> = {};
  for (const key of Object.keys(resolved.checks)) checks[key] = validated.values[key];

  const context: Record<string, string | number> = { ...validated.choices };
  for (const f of PATIENT_FIELDS) {
    if (f.kind === "number" && f.role === "context" && validated.values[f.key] != null) {
      context[f.key] = validated.values[f.key];
    }
  }

  const units: Record<string, string> = {};
  for (const key of [...Object.keys(resolved.targets), ...Object.keys(checks), ...Object.keys(context), ...resolved.unknown]) {
    const f = numberField(key);
    if (f) units[key] = f.specUnit;
  }

  const payload: FormPayload = {
    schema: FORM_SCHEMA_VERSION,
    request_id: requestId,
    targets: resolved.targets,
    checks,
    context,
    unknown: resolved.unknown,
    units,
  };
  const prompt = `${FORM_MARKER}\n\n\`\`\`explain-patient-form\n${JSON.stringify(payload)}\n\`\`\``;
  return { requestId, validated, resolved, payload, prompt };
}

// ---- provenance: how the bot accounts for every value it filled in ----

// measured values never appear here (they come from the form)
export type ProvenanceStatus = "reference" | "assumed" | "emergent";
const STATUSES: ProvenanceStatus[] = ["reference", "assumed", "emergent"];

export interface ProvenanceSource {
  title: string;
  url: string | null;
}

export interface ProvenanceField {
  key: string;
  value: number | null; // SPEC units; null allowed for `emergent` with no reference value
  status: ProvenanceStatus;
  basis: string;
  source: ProvenanceSource | null;
}

export interface Provenance {
  baseline: string;
  baselineReason: string;
  fields: ProvenanceField[];
  warnings: string[];
}

export interface ProvenanceResult {
  clean: string; // the answer with the block removed
  provenance: Provenance | null;
  errors: string[]; // why the block (or individual rows) was rejected
}

const PROVENANCE_RE = /```explain-provenance\s*([\s\S]*?)```/g;
const MAX_TEXT = 400;
const MAX_FIELDS = 40;
const MAX_WARNINGS = 10;

const text = (v: unknown, max = MAX_TEXT): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

function safeUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

// Reads the bot's provenance block. Everything in it is untrusted model output
// that ends up on screen, so: unknown keys and statuses are dropped, numbers are
// range-checked against the form schema, text is length-capped, and a source URL
// is kept only when it is http(s). Callers render it as text, never as HTML.
export function parseProvenance(answer: string): ProvenanceResult {
  const errors: string[] = [];
  if (typeof answer !== "string") return { clean: "", provenance: null, errors };

  const blocks: string[] = [];
  PROVENANCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PROVENANCE_RE.exec(answer)) !== null) blocks.push(m[1].trim());
  const clean = answer.replace(PROVENANCE_RE, "").replace(/\n{3,}/g, "\n\n").trim();

  if (!blocks.length) return { clean, provenance: null, errors };
  if (blocks.length > 1) errors.push("more than one provenance block; only the first was read");

  let raw: any;
  try {
    raw = JSON.parse(blocks[0]);
  } catch {
    return { clean, provenance: null, errors: [...errors, "provenance block is not valid JSON"] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { clean, provenance: null, errors: [...errors, "provenance block is not a JSON object"] };
  }

  const fields: ProvenanceField[] = [];
  const seen = new Set<string>();
  const rows: unknown[] = Array.isArray(raw.fields) ? raw.fields.slice(0, MAX_FIELDS) : [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const key = typeof r.key === "string" ? r.key : "";
    const field = numberField(key);
    if (!field) {
      errors.push(`unknown field "${text(key, 40)}" dropped`);
      continue;
    }
    if (seen.has(key)) {
      errors.push(`duplicate row for "${key}" dropped`);
      continue;
    }
    const status = STATUSES.find((s) => s === r.status);
    if (!status) {
      errors.push(`${key}: unknown status dropped`);
      continue;
    }
    let value: number | null = null;
    if (typeof r.value === "number" && Number.isFinite(r.value)) {
      const [lo, hi] = field.range;
      if (r.value < lo || r.value > hi) {
        errors.push(`${key}: value ${r.value} is outside the accepted range and was dropped`);
        continue;
      }
      value = r.value;
    } else if (status !== "emergent") {
      errors.push(`${key}: no numeric value`);
      continue;
    }
    const src = r.source && typeof r.source === "object" ? (r.source as Record<string, unknown>) : null;
    const title = src ? text(src.title, 200) : "";
    seen.add(key);
    fields.push({
      key,
      value,
      status,
      basis: text(r.basis),
      source: title ? { title, url: safeUrl(src!.url) } : null,
    });
  }

  const warnings = (Array.isArray(raw.warnings) ? raw.warnings : [])
    .map((w: unknown) => text(w))
    .filter(Boolean)
    .slice(0, MAX_WARNINGS);

  return {
    clean,
    provenance: {
      baseline: text(raw.baseline, 64),
      baselineReason: text(raw.baseline_reason),
      fields,
      warnings,
    },
    errors,
  };
}

// ---- did the server build what the user measured? ----

export interface SpecProblem {
  key: string;
  message: string;
}

// keys the bot may add to SPEC targets on its own: structural fills for unknowns
const FILLABLE = new Set(
  PATIENT_FIELDS.filter((f) => f.kind === "number" && f.role === "structural" && f.since === "A").map((f) => (f.kind === "number" ? f.specTarget : null)),
);

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

// Compares the SPEC the server built (response `build.spec`) with the request.
//   - every submitted target must be present and unchanged
//   - a calibration target the user did not measure must not appear (unknown
//     vitals are left to emerge from the model, not invented)
//   - a structural value may only be added when the provenance block accounts for it
export function checkSpec(spec: unknown, request: PatientBuildRequest, provenance: Provenance | null): SpecProblem[] {
  const problems: SpecProblem[] = [];
  const targets = spec && typeof spec === "object" ? (spec as { targets?: unknown }).targets : null;
  if (!targets || typeof targets !== "object") {
    return [{ key: "", message: "The built patient carries no target list, so it cannot be checked against the form." }];
  }
  const built = targets as Record<string, unknown>;
  const submitted = request.resolved.targets;
  const accounted = new Set((provenance?.fields ?? []).filter((f) => f.status !== "emergent").map((f) => numberField(f.key)?.specTarget ?? f.key));

  for (const [key, want] of Object.entries(submitted)) {
    const got = built[key];
    if (typeof got !== "number") {
      problems.push({ key, message: `${key}: measured ${want}, but it was not passed to the builder` });
    } else if (!close(got, want)) {
      problems.push({ key, message: `${key}: measured ${want}, but the builder was given ${got}` });
    }
  }
  for (const [key, got] of Object.entries(built)) {
    if (key in submitted || got == null) continue;
    if (!FILLABLE.has(key)) {
      problems.push({ key, message: `${key}: ${String(got)} was added as a target although it was not measured` });
    } else if (!accounted.has(key)) {
      problems.push({ key, message: `${key}: ${String(got)} was filled in without an explanation` });
    }
  }
  return problems;
}

// ---- result tables ----

// One row of "what the patient was built from": every value the form or the bot
// supplied, in schema order.
export type ValueStatus = "measured" | "derived" | ProvenanceStatus;
export interface ValueRow {
  key: string;
  caption: string;
  value: number | null; // SPEC units
  unit: string;
  status: ValueStatus;
  use: "target" | "check" | "context" | "none"; // what the builder did with it
  note: string; // why it is only a check, the derivation, or the bot's basis
  source: ProvenanceSource | null;
}

export function buildValueRows(request: PatientBuildRequest, provenance: Provenance | null): ValueRow[] {
  const { validated, resolved } = request;
  const derived = new Map(resolved.derived.map((d) => [d.key, d]));
  const filled = new Map((provenance?.fields ?? []).map((f) => [f.key, f]));
  const rows: ValueRow[] = [];

  for (const field of PATIENT_FIELDS) {
    if (field.kind !== "number") continue;
    const base = { key: field.key, caption: field.caption, unit: field.specUnit };
    const measured = validated.values[field.key];
    if (measured != null) {
      const isTarget = field.specTarget != null && resolved.targets[field.specTarget] === measured;
      const check = resolved.checks[field.key];
      rows.push({
        ...base,
        value: measured,
        status: "measured",
        use: isTarget ? "target" : check ? "check" : "context",
        note: check ?? "",
        source: null,
      });
      continue;
    }
    const d = derived.get(field.key);
    if (d) {
      rows.push({ ...base, value: d.value, status: "derived", use: "target", note: d.basis, source: null });
      continue;
    }
    const f = filled.get(field.key);
    if (f) {
      rows.push({
        ...base,
        value: f.value,
        status: f.status,
        use: f.status === "emergent" ? "none" : "target",
        note: f.basis,
        source: f.source,
      });
    }
  }
  return rows;
}

// The structured calibration report the bot host returns as `build`
// (bot-host/api.py parse_build_report).
export interface BuildResidual {
  key: string;
  value: number;
  target: number | null;
  delta: number | null;
  flag: string;
}
// a calibration target whose lever ended on one of its bounds: the builder could
// not push further, so the value is out of (or at the edge of) what that lever can do
export interface LeverLimit {
  key: string; // the SPEC target key (spo2, pco2, map, ...)
  lever: string;
  value: number | null;
}
export interface BuildReport {
  converged: boolean | null;
  iters: number | null;
  unmet: string[];
  residuals: BuildResidual[];
  log: string;
  spec: unknown;
  // only from an engine that emits build_report (explain-engine #7 and later)
  leverLimits: LeverLimit[];
  ignoredTargets: string[];
  notes: string[];
}

export function parseBuildReport(raw: unknown): BuildReport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const residuals: BuildResidual[] = [];
  for (const row of Array.isArray(r.residuals) ? r.residuals.slice(0, 60) : []) {
    if (!row || typeof row !== "object") continue;
    const x = row as Record<string, unknown>;
    const value = num(x.value);
    if (typeof x.key !== "string" || value == null) continue;
    residuals.push({ key: text(x.key, 40), value, target: num(x.target), delta: num(x.delta), flag: text(x.flag, 20) });
  }
  const strings = (v: unknown, max: number, limit = 20) =>
    (Array.isArray(v) ? v : [])
      .slice(0, limit)
      .map((k: unknown) => text(k, max))
      .filter(Boolean);
  const leverLimits: LeverLimit[] = [];
  for (const row of Array.isArray(r.lever_limits) ? r.lever_limits.slice(0, 20) : []) {
    if (!row || typeof row !== "object") continue;
    const x = row as Record<string, unknown>;
    if (typeof x.key !== "string") continue;
    leverLimits.push({ key: text(x.key, 40), lever: text(x.lever, 80), value: num(x.value) });
  }
  return {
    converged: typeof r.converged === "boolean" ? r.converged : null,
    iters: num(r.iters),
    unmet: strings(r.unmet, 40, 60),
    residuals,
    log: typeof r.log === "string" ? r.log.slice(-8000) : "",
    spec: r.spec ?? null,
    leverLimits,
    ignoredTargets: strings(r.ignored_targets, 40),
    notes: strings(r.notes, 300, 10),
  };
}

// One row of "how close the built patient is": the model's steady-state value
// next to what was measured, for calibrated targets and for checks alike.
export interface ResultRow {
  key: string; // form key
  caption: string;
  unit: string;
  model: number;
  measured: number | null;
  delta: number | null; // model − measured
  calibrated: boolean; // true: the builder tuned to it; false: comparison only
  met: boolean | null; // calibrated targets only: within tolerance
  flag: string; // the builder's normal-range flag ("ok", "LOW", "HIGH", "")
}

// report vital -> form field. The form's SpO2 is whatever probe the user named, so
// it maps to the pre-ductal model value unless the probe was post-ductal.
function reportToForm(key: string, request: PatientBuildRequest): string {
  const postductal = request.validated.choices.spo2_site === "postductal";
  if (key === "lvo") return "co";
  if (key === "spo2_pre") return postductal ? "spo2_pre" : "spo2";
  if (key === "spo2_post") return postductal ? "spo2" : "spo2_post";
  return key;
}
const REPORT_CAPTIONS: Record<string, { caption: string; unit: string }> = {
  pap_m: { caption: "Mean pulmonary artery pressure", unit: "mmHg" },
  spo2_pre: { caption: "SpO2 pre-ductal", unit: "%" },
  pp: { caption: "Pulse pressure", unit: "mmHg" },
};

// The builder calibrates systolic/diastolic as mean (map) + pulse pressure (pp), so
// whether a systolic or diastolic target was met follows from those two.
const MET_VIA: Record<string, string[]> = { sys: ["map", "pp"], dia: ["map", "pp"] };

// caption for a SPEC target key, for messages about the calibration
export function targetCaption(key: string): string {
  const field = PATIENT_FIELDS.find((f) => f.kind === "number" && f.specTarget === key);
  return field?.caption ?? REPORT_CAPTIONS[key]?.caption ?? key;
}

export function buildResultRows(request: PatientBuildRequest, report: BuildReport): ResultRow[] {
  const { validated, resolved } = request;
  // unmet holds SPEC target keys, which are also the form keys
  const unmet = new Set(report.unmet);
  return report.residuals.map((r) => {
    const key = reportToForm(r.key, request);
    const field = numberField(key);
    const label = field ? { caption: field.caption, unit: field.specUnit } : (REPORT_CAPTIONS[key] ?? { caption: key, unit: "" });
    // pulse pressure is not a form field: it is calibrated when both pressures are
    const bothPressures = resolved.targets.sys != null && resolved.targets.dia != null;
    const target =
      key === "pp"
        ? bothPressures ? resolved.targets.sys - resolved.targets.dia : undefined
        : field?.specTarget != null ? resolved.targets[field.specTarget] : undefined;
    const calibrated = target != null;
    const measured = calibrated ? target : (validated.values[key] ?? null);
    const delta = measured != null ? Number((r.value - measured).toPrecision(4)) : null;
    return {
      key,
      caption: label.caption,
      unit: label.unit,
      model: r.value,
      measured,
      delta,
      calibrated,
      met: calibrated ? !(MET_VIA[key] ?? [key]).some((k) => unmet.has(k)) : null,
      flag: r.flag,
    };
  });
}
