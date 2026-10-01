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
