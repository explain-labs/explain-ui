// Bot-issued command pipeline: parse -> validate -> execute.
//
// The Explain AI bot runs on a separate machine and can only talk back through
// its HTTP reply, so any command it wants to run rides INSIDE that reply as a
// fenced ```explain-command``` JSON block. This module turns those blocks into
// validated, executable actions against the live model.
//
//   parseCommands(answer)         -> strip blocks out of the prose, parse JSON
//   validateCommand(cmd, state)   -> allowlist + registry-schema check, unit conv
//   executeCommand(norm, explain) -> route to the matching useExplain() method
//
// Validation reuses the SAME schema the UI editor uses (MODEL_INTERFACES via
// getInterfaceForType) for bounds (ll/ul), list choices, function args, and the
// display->raw unit factor — so a bot command behaves exactly like a human edit.

import { getInterfaceForType } from "@/model-interface/registry";
import type { InterfaceField } from "@/model-interface/types";
import { findInstance } from "./commonTasks";
import { isAllowed, isDiagramAction, isScaleGroup, SCALE_GROUPS, type CommandOp, type DiagramAction } from "./botCommandAllowlist";
import { LIVE_TARGETS } from "@explain/helpers/Calibrator";
import { PICTOS, PATH_TYPES, LAYOUT_PATCH_WHITELIST } from "@/render/diagramConstants";
// type-only import keeps this module Vue/Pinia-free (the value lives in the store)
import type { EventChange } from "@/stores/events";

// ---- wire shape the bot emits (one JSON object per fenced block) ----
export interface BotCommand {
  op: CommandOp;
  model?: string; // call / setProp: the model instance name (e.g. "Ventilator")
  target?: string; // call: method name; setProp: property name
  args?: unknown[]; // call: positional args (clinical/display units)
  value?: unknown; // setProp: new value (clinical/display units)
  it?: number; // setProp: tween time in seconds (optional)
  at?: number; // delay before applying, seconds (optional)
  seconds?: number; // calculate
  name?: string; // load (scenario) / diagram (component name) / event (event name) / loadDefinition (patient name)
  group?: string; // scale
  factor?: number; // scale
  reason?: string; // optional human label for the action card
  // --- loadDefinition (op: "loadDefinition"): replace the whole model ---
  summary?: string; // loadDefinition: short human description of the built patient
  definition?: unknown; // loadDefinition: inline definition (small/dev fallback; normally arrives in response.artifact)
  // --- event (op: "event"): a named bundle of scheduled prop changes ---
  changes?: EventChangeInput[]; // event: the property changes
  fire_at?: number; // event: optional absolute sim-time to auto-fire (panel feature)
  // --- diagram (op: "diagram") ---
  action?: DiagramAction; // which diagram edit
  models?: string[]; // addComponent / connect / setModels: engine instance names
  picto?: string; // addComponent / setPicto: sprite image
  label?: string; // addComponent: caption (defaults to name)
  pos?: any; // addComponent: {type:'arc',dgs} | {type:'rel',x,y}
  from?: string; // connect: source component name
  to?: string; // connect: destination component name
  path?: { type?: string; width?: number }; // connect: path shape
  text?: string; // setLabel: caption text
  patch?: any; // setLayout: cosmetic layout patch
}

// one change as the bot emits it (values in display/clinical units, like setProp)
export interface EventChangeInput {
  model?: string;
  target?: string;
  value?: unknown;
  it?: number; // ramp seconds (numeric only)
  at?: number; // delay seconds before the change starts
}

// ---- normalized, engine-ready action (units already converted to raw) ----
export type NormalizedCommand =
  | { kind: "call"; fn: string; args: unknown[]; at: number }
  | { kind: "setProp"; prop: string; value: number | boolean | string; it: number; at: number }
  | { kind: "event"; name: string; fire_at: number | null; changes: EventChange[] }
  | { kind: "loadDefinition"; name: string; summary: string; definition?: unknown }
  | { kind: "scale"; group: string; factor: number }
  | { kind: "tune"; targets: Record<string, number> }
  | { kind: "revert" }
  | { kind: "start" }
  | { kind: "stop" }
  | DiagramNormalized;

// diagram edits drive the live DiagramRenderer, not the engine
export type DiagramNormalized =
  | { kind: "diagram"; action: "addComponent"; name: string; models: string[]; picto: string; label: string; pos?: any }
  | { kind: "diagram"; action: "connect"; from: string; to: string; models?: string[]; path?: { type?: string; width?: number } }
  | { kind: "diagram"; action: "setLayout"; name: string; patch: any }
  | { kind: "diagram"; action: "setLabel"; name: string; text: string }
  | { kind: "diagram"; action: "setModels"; name: string; models: string[] }
  | { kind: "diagram"; action: "setPicto"; name: string; picto: string }
  | { kind: "diagram"; action: "delete"; name: string };

// Context the diagram validator needs: the set of component names currently in
// the live diagram (real components + adds queued earlier in the same reply,
// minus deletes). `null` means no diagram renderer is mounted, so diagram edits
// can't be applied.
export interface DiagramContext {
  names: Set<string> | null;
}

export interface ValidationResult {
  ok: boolean;
  normalized?: NormalizedCommand;
  description: string; // human-readable summary for the card
  error?: string; // why it was rejected (when ok === false)
}

export interface ParseResult {
  clean: string; // prose with the command blocks removed
  commands: BotCommand[]; // successfully parsed command objects
  parseErrors: string[]; // blocks that failed JSON.parse (surfaced, not silent)
}

const BLOCK_RE = /```explain-command\s*([\s\S]*?)```/g;

// Pull every ```explain-command``` block out of the bot reply, parse each as
// JSON, and return the leftover prose plus the parsed commands.
export function parseCommands(answer: string): ParseResult {
  const commands: BotCommand[] = [];
  const parseErrors: string[] = [];
  if (typeof answer !== "string") {
    return { clean: "", commands, parseErrors };
  }

  let m: RegExpExecArray | null;
  BLOCK_RE.lastIndex = 0;
  while ((m = BLOCK_RE.exec(answer)) !== null) {
    const raw = m[1].trim();
    try {
      const parsed = JSON.parse(raw);
      // a single block may hold one object or an array of them
      for (const c of Array.isArray(parsed) ? parsed : [parsed]) {
        if (c && typeof c === "object") commands.push(c as BotCommand);
      }
    } catch {
      parseErrors.push(raw.slice(0, 120));
    }
  }

  const clean = answer.replace(BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").trim();
  return { clean, commands, parseErrors };
}

// ---- validation helpers ----

function fieldsFor(modelName: string, modelState: any): InterfaceField[] | null {
  // a sub-model of a composite (e.g. the ventilator's VENT_ETTUBE) sits in its parent's components
  const type = findInstance(modelState?.models ?? {}, modelName)?.model_type;
  if (!type) return null;
  return getInterfaceForType(type);
}

// display(UI) value -> raw(engine) value, mirroring ModelEditor.toRaw
function toRaw(f: InterfaceField, ui: number): number {
  return ui / (f.factor ?? 1);
}

// Resolve the allowed list values for a `list` field/arg. The registry mixes
// `options` (model-type names) and `choices` (literal strings) and doesn't
// always set `custom_options`; a plain `?? ` chain wrongly stops at an empty
// `options: []`. Pick the first non-empty of the relevant arrays.
function resolveChoices(f: InterfaceField): string[] {
  const candidates = [f.custom_options ? f.choices : f.options, f.choices, f.options];
  return candidates.find((c) => Array.isArray(c) && c.length > 0) ?? [];
}

// check a numeric display value against the field's ll/ul (which are in display
// units, e.g. tidal volume 1–500 mL); returns an error string or null
function checkNumberBounds(f: InterfaceField, label: string, v: number): string | null {
  if (typeof v !== "number" || Number.isNaN(v)) return `${label} must be a number`;
  if (typeof f.ll === "number" && v < f.ll) return `${label} ${v} below minimum ${f.ll}`;
  if (typeof f.ul === "number" && v > f.ul) return `${label} ${v} above maximum ${f.ul}`;
  return null;
}

function reject(description: string, error: string): ValidationResult {
  return { ok: false, description, error };
}

// How wide the command surface is. "guided" = the curated allowlist (safe demos);
// "full" = any non-readonly, runtime-settable registry field on any live model.
export type CommandScope = "guided" | "full";

// Runtime-settable property field types. Excludes the structural wiring types
// (multiple-list / prop-list / reference / dict — all rebuild-only) and string
// (~all readonly descriptions). `factor` is the persistent `*_factor_ps` knobs.
const SETTABLE_PROP_TYPES = new Set(["number", "factor", "boolean", "list"]);

// Is this field something the bot may set/call at runtime? The registry only
// lists editable fields, but it also carries readonly measured-outputs and
// structural wiring — exclude those.
export function isSettableField(f: InterfaceField, op: "setProp" | "call"): boolean {
  if (op === "call") return f.type === "function";
  return !f.readonly && SETTABLE_PROP_TYPES.has(f.type);
}

// One validated property change: a raw, engine-ready EventChange plus a
// human-readable description fragment (display units). Shared by the `setProp`
// op and each change inside an `event` op, so a bot-scheduled change behaves
// exactly like a one-off setProp or a human edit (same gate, bounds, units).
interface ValidatedChange {
  change: EventChange; // value already converted to raw
  desc: string; // "Model: target → value unit"
}

function validatePropChange(
  model: string | undefined,
  target: string | undefined,
  value: unknown,
  it: number,
  at: number,
  modelState: any,
  scope: CommandScope,
): { ok: true; result: ValidatedChange } | { ok: false; error: string } {
  if (!model || !target) return { ok: false, error: "requires model + target" };
  if (scope === "guided" && !isAllowed("setProp", model, target))
    return { ok: false, error: `not enabled in Guided scope: setProp ${model}.${target} — switch to Full scope to allow` };
  const fields = fieldsFor(model, modelState);
  if (!fields) return { ok: false, error: `model "${model}" not found in current scenario` };
  const f = fields.find((x) => x.target === target);
  if (!f) return { ok: false, error: `"${target}" is not an editable property of ${model}` };
  if (f.readonly) return { ok: false, error: `"${target}" is read-only on ${model}` };
  if (!isSettableField(f, "setProp"))
    return { ok: false, error: `${model}.${target} (type "${f.type}") is not settable at runtime` };

  if (f.type === "number" || f.type === "factor") {
    const v = value as number;
    const err = checkNumberBounds(f, target, v);
    if (err) return { ok: false, error: err };
    const unit = f.caption?.match(/\(([^)]+)\)/)?.[1] ?? "";
    return {
      ok: true,
      result: {
        change: { model, target, type: "number", value: toRaw(f, v), it, at },
        desc: `${model}: ${target} → ${v}${unit ? " " + unit : ""}`,
      },
    };
  }
  if (f.type === "boolean") {
    if (typeof value !== "boolean") return { ok: false, error: `${target} expects true/false` };
    return {
      ok: true,
      result: { change: { model, target, type: "boolean", value, it: 0, at }, desc: `${model}: ${target} → ${value}` },
    };
  }
  if (f.type === "list") {
    const choices = resolveChoices(f);
    if (typeof value !== "string" || !choices.includes(value))
      return { ok: false, error: `${target} must be one of: ${choices.join(", ")}` };
    return {
      ok: true,
      result: { change: { model, target, type: "list", value, it: 0, at }, desc: `${model}: ${target} → ${value}` },
    };
  }
  return { ok: false, error: `property type "${f.type}" not supported for bot commands` };
}

// Validate an `op:"event"` command: a named bundle of scheduled prop changes.
// Each change is validated exactly like a setProp; the whole event is rejected
// if any change is bad. fire_at/armed are panel features the bot leaves unset
// (armed defaults off in the store) — per-change `at` is its timing mechanism.
function validateEventCommand(cmd: BotCommand, modelState: any, scope: CommandScope): ValidationResult {
  const label = cmd.reason || `event ${cmd.name ?? ""}`.trim();
  const name = (cmd.name ?? "").trim();
  if (!name) return reject(label, "event requires a 'name'");
  if (!Array.isArray(cmd.changes) || cmd.changes.length === 0)
    return reject(label, "event requires a non-empty 'changes' array");

  const changes: EventChange[] = [];
  const parts: string[] = [];
  for (const ch of cmd.changes) {
    const it = typeof ch.it === "number" ? ch.it : 0;
    const at = typeof ch.at === "number" ? ch.at : 0;
    const r = validatePropChange(ch.model, ch.target, ch.value, it, at, modelState, scope);
    if (!r.ok) return reject(label, `change ${ch.model ?? "?"}.${ch.target ?? "?"}: ${r.error}`);
    const c = r.result.change;
    changes.push(c);
    let d = r.result.desc;
    if (c.type === "number" && c.it) d += ` over ${c.it}s`;
    if (c.at) d += ` after ${c.at}s`;
    parts.push(d);
  }

  const fire_at = typeof cmd.fire_at === "number" ? cmd.fire_at : null;
  return {
    ok: true,
    normalized: { kind: "event", name, fire_at, changes },
    description: cmd.reason || `${name}: ${parts.join("; ")}`,
  };
}

// Sanity-check that an inline `definition` object looks like a runnable scenario
// (a `models` map with ≥1 entry, each carrying a string `model_type`). Accepts
// either a full scenario file ({model_definition:{models}}) or a bare definition
// ({models}). Returns an error string or null. Belt-and-braces only — the engine
// build is the real validator; this just rejects obvious garbage before it runs.
function definitionError(def: unknown): string | null {
  if (!def || typeof def !== "object") return "definition must be an object";
  const inner = (def as any).model_definition ?? def;
  const models = inner?.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) return "definition has no models map";
  const entries = Object.values(models as Record<string, any>);
  if (!entries.length) return "definition models map is empty";
  if (!entries.every((m) => m && typeof m.model_type === "string"))
    return "every model entry must have a string model_type";
  return null;
}

// Max inline-definition size (full scenarios are ~300 KB and must use the
// out-of-band response `artifact` instead; inline is a dev/small fallback only).
const MAX_INLINE_DEFINITION_BYTES = 64 * 1024;

// Validate an `op:"loadDefinition"` command: load+run a complete bot-built patient.
// Replaces the whole model, so it is Full-scope only (rejected in Guided). The
// definition normally arrives out-of-band in the chat response `artifact` (the
// chat store passes it to loadFromObject); an inline `definition` is a small/dev
// fallback and is sanity-checked + size-capped here.
function validateLoadDefinition(cmd: BotCommand, scope: CommandScope): ValidationResult {
  const name = (cmd.name ?? "").trim() || "patient";
  const summary = cmd.summary || cmd.reason || "";
  const label = cmd.reason || `load patient "${name}"`;
  if (scope === "guided")
    return reject(label, "loadDefinition is disabled in Guided scope — switch to Full scope to build/run new patients");
  if (cmd.definition !== undefined) {
    const err = definitionError(cmd.definition);
    if (err) return reject(label, `inline definition invalid: ${err}`);
    if (JSON.stringify(cmd.definition).length > MAX_INLINE_DEFINITION_BYTES)
      return reject(label, "inline definition too large — the bot must deliver it via the response artifact, not the command block");
  }
  return {
    ok: true,
    normalized: { kind: "loadDefinition", name, summary, definition: cmd.definition },
    description: cmd.reason || (summary ? `load patient: ${summary}` : `load patient "${name}"`),
  };
}

// Validate an `op:"tune"` command: closed-loop drive measured quantities of the
// running model to exact target values. Full scope only. `changes` is a list of
// { target, value } where target ∈ LIVE_TARGETS (map/sys/dia/co/hr/pap_m/pap_s/po2/
// spo2/pco2/be/ph/blood_volume) and value is a finite number. sys and dia only
// together: the engine tunes them as a pair (pulse pressure, and MAP unless given)
// and would silently ignore one alone. Builds the {target:value} map the engine's
// tune() consumes.
function validateTuneCommand(cmd: BotCommand, scope: CommandScope): ValidationResult {
  const label = cmd.reason || "tune";
  if (scope === "guided")
    return reject(label, "tune is disabled in Guided scope — switch to Full scope");
  const changes = Array.isArray(cmd.changes) ? cmd.changes : [];
  if (!changes.length) return reject(label, "tune requires a non-empty 'changes' array of {target, value}");
  const targets: Record<string, number> = {};
  const parts: string[] = [];
  for (const ch of changes) {
    const t = (ch.target ?? "").trim();
    const v = ch.value;
    if (!t || !(LIVE_TARGETS as readonly string[]).includes(t))
      return reject(label, `unknown tune target "${t}" — allowed: ${LIVE_TARGETS.join(", ")}`);
    if (typeof v !== "number" || !Number.isFinite(v))
      return reject(label, `tune target "${t}" needs a numeric value`);
    targets[t] = v;
    parts.push(`${t}→${v}`);
  }
  if ((targets.sys == null) !== (targets.dia == null))
    return reject(label, "tune needs sys and dia together (they are tuned as a pair)");
  return {
    ok: true,
    normalized: { kind: "tune", targets },
    description: cmd.reason || `tune ${parts.join(", ")}`,
  };
}

// Validate an `op:"scale"` command: multiply a whole ModelScaler group by a
// factor (1.0 = baseline). Full scope only — it touches many parameters at once.
// The group must be in the curated SCALE_GROUPS allowlist and the factor a
// positive number.
function validateScaleCommand(cmd: BotCommand, scope: CommandScope): ValidationResult {
  const group = (cmd.group ?? "").trim();
  const factor = cmd.factor;
  const label = cmd.reason || `scale ${group || "?"}`;
  if (scope === "guided")
    return reject(label, "scale is disabled in Guided scope — switch to Full scope");
  if (!group) return reject(label, "scale requires a 'group'");
  if (!isScaleGroup(group))
    return reject(label, `unknown scale group "${group}" — allowed: ${SCALE_GROUPS.join(", ")}`);
  if (typeof factor !== "number" || !Number.isFinite(factor) || factor <= 0)
    return reject(label, "scale 'factor' must be a positive number (1.0 = baseline)");
  return {
    ok: true,
    normalized: { kind: "scale", group, factor },
    description: cmd.reason || `scale ${group} ×${factor}`,
  };
}

// Validate a single parsed command against the scope gate + the model-interface
// schema, converting display units to raw. Pure (no engine access) so it can be
// unit-tested with a plain modelState object. `scope` selects the gate: "guided"
// restricts to the allowlist, "full" allows any settable registry field.
export function validateCommand(
  cmd: BotCommand,
  modelState: any,
  scope: CommandScope = "full",
  diagram?: DiagramContext,
): ValidationResult {
  const op = cmd.op;
  const label = cmd.reason || `${op} ${cmd.model ?? ""}${cmd.target ? "." + cmd.target : ""}`;

  // diagram edits are a separate surface (renderer, not engine); gated on a
  // mounted renderer rather than the guided/full allowlist.
  if (op === "diagram") return validateDiagramCommand(cmd, modelState, diagram?.names ?? null);

  // sim-control ops carry no model/target and are allowed in both scopes
  if (op === "start")
    return { ok: true, normalized: { kind: "start" }, description: cmd.reason || "start simulation" };
  if (op === "stop")
    return { ok: true, normalized: { kind: "stop" }, description: cmd.reason || "stop simulation" };
  if (op === "revert")
    return { ok: true, normalized: { kind: "revert" }, description: cmd.reason || "revert to the loaded patient" };
  // event: a named bundle of scheduled changes; gated per-change (no early gate)
  if (op === "event") return validateEventCommand(cmd, modelState, scope);
  // loadDefinition: replace the whole model with a bot-built patient (Full scope only)
  if (op === "loadDefinition") return validateLoadDefinition(cmd, scope);
  // scale: multiply a whole parameter group (blood volume, SVR, contractility…) live
  if (op === "scale") return validateScaleCommand(cmd, scope);
  // tune: closed-loop drive measured quantities to exact target values, in place
  if (op === "tune") return validateTuneCommand(cmd, scope);
  if (op !== "setProp" && op !== "call")
    return reject(label, `unsupported op "${op}"`);

  // Guided scope: only the curated allowlist. Full scope: rely on the
  // settable-field + bounds checks inside each case below.
  if (scope === "guided" && !isAllowed(op, cmd.model, cmd.target)) {
    return reject(
      label,
      `not enabled in Guided scope: ${op} ${cmd.model ?? ""}${cmd.target ? "." + cmd.target : ""} — switch to Full scope to allow`,
    );
  }

  switch (op) {
    case "setProp": {
      const at = typeof cmd.at === "number" ? cmd.at : 0;
      const it = typeof cmd.it === "number" ? cmd.it : 0;
      const r = validatePropChange(cmd.model, cmd.target, cmd.value, it, at, modelState, scope);
      if (!r.ok) return reject(label, r.error);
      const c = r.result.change;
      return {
        ok: true,
        normalized: { kind: "setProp", prop: `${c.model}.${c.target}`, value: c.value, it: c.it, at: c.at },
        description: cmd.reason || r.result.desc,
      };
    }

    case "call": {
      if (!cmd.model || !cmd.target) return reject(label, "call requires model + target");
      const fields = fieldsFor(cmd.model, modelState);
      if (!fields) return reject(label, `model "${cmd.model}" not found in current scenario`);
      const f = fields.find((x) => x.target === cmd.target && x.type === "function");
      if (!f) return reject(label, `"${cmd.target}" is not a callable function of ${cmd.model}`);

      const argDefs = f.args ?? [];
      const inArgs = Array.isArray(cmd.args) ? cmd.args : [];
      if (inArgs.length !== argDefs.length)
        return reject(label, `${cmd.target} expects ${argDefs.length} arg(s), got ${inArgs.length}`);

      const rawArgs: unknown[] = [];
      for (let i = 0; i < argDefs.length; i++) {
        const a = argDefs[i];
        const v = inArgs[i];
        if (a.type === "number") {
          const err = checkNumberBounds(a, a.target, v as number);
          if (err) return reject(label, err);
          rawArgs.push(toRaw(a, v as number));
        } else if (a.type === "boolean") {
          if (typeof v !== "boolean") return reject(label, `${a.target} expects true/false`);
          rawArgs.push(v);
        } else if (a.type === "list") {
          const choices = resolveChoices(a);
          if (typeof v !== "string" || !choices.includes(v))
            return reject(label, `${a.target} must be one of: ${choices.join(", ")}`);
          rawArgs.push(v);
        } else {
          rawArgs.push(v);
        }
      }

      const at = typeof cmd.at === "number" ? cmd.at : 0;
      const argStr = inArgs.map((a) => JSON.stringify(a)).join(", ");
      return {
        ok: true,
        normalized: { kind: "call", fn: `${cmd.model}.${cmd.target}`, args: rawArgs, at },
        description: cmd.reason || `${cmd.model}.${cmd.target}(${argStr})`,
      };
    }
  }
}

// ---- diagram validation helpers ----

// every model name in `models` must be a live engine instance; returns an error
// string listing the unknown ones, or null
function modelsExist(models: string[], modelState: any): string | null {
  const live = modelState?.models ?? {};
  const missing = models.filter((m) => !(m in live));
  return missing.length ? `unknown model instance(s): ${missing.join(", ")}` : null;
}

function pictoError(picto: string): string | null {
  return (PICTOS as readonly string[]).includes(picto)
    ? null
    : `picto must be one of: ${PICTOS.join(", ")}`;
}

// validate a sprite position; null when ok or omitted
function posError(pos: any): string | null {
  if (pos == null) return null;
  if (typeof pos !== "object") return "pos must be an object";
  if (pos.type === "arc") return typeof pos.dgs === "number" ? null : "arc pos needs a numeric dgs";
  if (pos.type === "rel")
    return typeof pos.x === "number" && typeof pos.y === "number" ? null : "rel pos needs numeric x,y";
  return "pos.type must be 'arc' or 'rel'";
}

// flatten a nested patch object into dotted leaf paths
function flattenPaths(obj: any, prefix = ""): string[] {
  const out: string[] = [];
  for (const k of Object.keys(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    const v = obj[k];
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...flattenPaths(v, p));
    else out.push(p);
  }
  return out;
}

// a leaf path is allowed if it equals a whitelist entry or sits under one
// (e.g. "sprite.pos.dgs" is covered by the "sprite.pos" entry)
function isAllowedPatchPath(p: string): boolean {
  return (LAYOUT_PATCH_WHITELIST as readonly string[]).some((w) => p === w || p.startsWith(w + "."));
}

function needName(cmd: BotCommand): string {
  return (cmd.name ?? "").trim();
}

// Validate a single diagram-edit command against the live diagram (component
// names) + model instances. `names` is null when no renderer is mounted.
export function validateDiagramCommand(
  cmd: BotCommand,
  modelState: any,
  names: Set<string> | null,
): ValidationResult {
  const label = cmd.reason || `diagram ${cmd.action ?? "?"}`;
  if (!isDiagramAction(cmd.action)) return reject(label, `unknown diagram action "${cmd.action}"`);
  if (!names) return reject(label, "open the Diagram tab to apply diagram edits");
  const action = cmd.action;

  switch (action) {
    case "addComponent": {
      const name = needName(cmd);
      if (!name) return reject(label, "addComponent requires a unique 'name'");
      if (names.has(name)) return reject(label, `a component named "${name}" already exists`);
      const models = Array.isArray(cmd.models) ? cmd.models.map(String) : [];
      if (!models.length) return reject(label, "addComponent requires models[] (engine instance name)");
      const me = modelsExist(models, modelState);
      if (me) return reject(label, me);
      const picto = cmd.picto ?? "container.png";
      const pe = pictoError(picto);
      if (pe) return reject(label, pe);
      const poserr = posError(cmd.pos);
      if (poserr) return reject(label, poserr);
      return {
        ok: true,
        normalized: { kind: "diagram", action, name, models, picto, label: cmd.label ?? name, pos: cmd.pos },
        description: cmd.reason || `add ${name} → [${models.join(", ")}] (${picto})`,
      };
    }
    case "connect": {
      const from = (cmd.from ?? "").trim();
      const to = (cmd.to ?? "").trim();
      if (!from || !to) return reject(label, "connect requires 'from' and 'to'");
      if (!names.has(from)) return reject(label, `from "${from}" is not a component in the diagram`);
      if (!names.has(to)) return reject(label, `to "${to}" is not a component in the diagram`);
      const models = Array.isArray(cmd.models) ? cmd.models.map(String) : [];
      if (models.length) {
        const me = modelsExist(models, modelState);
        if (me) return reject(label, me);
      }
      let path: { type?: string; width?: number } | undefined;
      if (cmd.path) {
        const t = cmd.path.type;
        if (t !== undefined && !(PATH_TYPES as readonly string[]).includes(t))
          return reject(label, `path.type must be one of: ${PATH_TYPES.join(", ")}`);
        path = {
          ...(t !== undefined ? { type: t } : {}),
          ...(typeof cmd.path.width === "number" ? { width: cmd.path.width } : {}),
        };
      }
      return {
        ok: true,
        normalized: { kind: "diagram", action, from, to, models: models.length ? models : undefined, path },
        description: cmd.reason || `connect ${from} → ${to}${models.length ? ` [${models.join(", ")}]` : ""}`,
      };
    }
    case "setLayout": {
      const name = needName(cmd);
      if (!name) return reject(label, "setLayout requires 'name'");
      if (!names.has(name)) return reject(label, `"${name}" is not in the diagram`);
      const patch = cmd.patch;
      if (!patch || typeof patch !== "object" || Array.isArray(patch))
        return reject(label, "setLayout requires a 'patch' object");
      const bad = flattenPaths(patch).filter((p) => !isAllowedPatchPath(p));
      if (bad.length) return reject(label, `patch keys not allowed: ${bad.join(", ")}`);
      const alpha = patch?.general?.alpha;
      if (typeof alpha === "number" && (alpha < 0 || alpha > 1))
        return reject(label, "alpha must be between 0 and 1");
      return {
        ok: true,
        normalized: { kind: "diagram", action, name, patch },
        description: cmd.reason || `restyle ${name}`,
      };
    }
    case "setLabel": {
      const name = needName(cmd);
      if (!name) return reject(label, "setLabel requires 'name'");
      if (!names.has(name)) return reject(label, `"${name}" is not in the diagram`);
      if (typeof cmd.text !== "string") return reject(label, "setLabel requires string 'text'");
      return {
        ok: true,
        normalized: { kind: "diagram", action, name, text: cmd.text },
        description: cmd.reason || `label ${name} → "${cmd.text}"`,
      };
    }
    case "setModels": {
      const name = needName(cmd);
      if (!name) return reject(label, "setModels requires 'name'");
      if (!names.has(name)) return reject(label, `"${name}" is not in the diagram`);
      const models = Array.isArray(cmd.models) ? cmd.models.map(String) : null;
      if (!models) return reject(label, "setModels requires models[]");
      const me = modelsExist(models, modelState);
      if (me) return reject(label, me);
      return {
        ok: true,
        normalized: { kind: "diagram", action, name, models },
        description: cmd.reason || `bind ${name} → [${models.join(", ")}]`,
      };
    }
    case "setPicto": {
      const name = needName(cmd);
      if (!name) return reject(label, "setPicto requires 'name'");
      if (!names.has(name)) return reject(label, `"${name}" is not in the diagram`);
      const picto = cmd.picto ?? "";
      const pe = pictoError(picto);
      if (pe) return reject(label, pe);
      return {
        ok: true,
        normalized: { kind: "diagram", action, name, picto },
        description: cmd.reason || `picto ${name} → ${picto}`,
      };
    }
    case "delete": {
      const name = needName(cmd);
      if (!name) return reject(label, "delete requires 'name'");
      if (!names.has(name)) return reject(label, `"${name}" is not in the diagram`);
      return {
        ok: true,
        normalized: { kind: "diagram", action, name },
        description: cmd.reason || `delete ${name}`,
      };
    }
  }
}

// The slice of useExplain() the executor needs (keeps this module Vue-free).
export interface ExplainHandle {
  call: (fn: string, args?: unknown[], at?: number) => void;
  setProp: (prop: string, value: any, it?: number, at?: number) => void;
  start: () => void;
  stop: () => void;
  loadFromObject: (obj: any) => void;
  scale: (group: string, factor: number) => void;
  tune: (targets: Record<string, number>, opts?: Record<string, unknown>) => void;
  revert: () => void;
}

// Thin, renderer-backed handle for diagram edits (keeps this module Pixi-free).
// Implemented in the chat store over the live DiagramRenderer + Model.updateDiagram.
export interface DiagramHandle {
  add: (name: string, picto: string) => Promise<string>; // -> actual (unique) name
  setLayout: (name: string, patch: any) => void;
  setLabel: (name: string, text: string) => void;
  setModels: (name: string, models: string[]) => void;
  setPicto: (name: string, picto: string) => Promise<void> | void;
  connect: (from: string, to: string, opts?: { models?: string[]; path?: { type?: string; width?: number } }) => string | null;
  remove: (name: string) => void;
  push: () => void; // re-bind the live animation (Model.updateDiagram)
}

// Apply a validated, normalized engine command to the live engine. Diagram
// commands (kind "diagram") go through executeDiagramCommand instead.
export function executeCommand(norm: NormalizedCommand, explain: ExplainHandle): void {
  switch (norm.kind) {
    case "call":
      explain.call(norm.fn, norm.args, norm.at);
      break;
    case "setProp":
      explain.setProp(norm.prop, norm.value, norm.it, norm.at);
      break;
    case "start":
      explain.start();
      break;
    case "stop":
      explain.stop();
      break;
    case "scale":
      explain.scale(norm.group, norm.factor);
      break;
    case "tune":
      explain.tune(norm.targets);
      break;
    case "revert":
      explain.revert();
      break;
    case "loadDefinition":
      // inline-definition fallback only; the normal artifact path is handled in
      // the chat store (applyCommand), which has the response artifact in hand.
      if (norm.definition) explain.loadFromObject(norm.definition);
      else throw new Error("no patient definition available (expected response artifact)");
      break;
  }
}

// Apply a validated diagram edit to the live renderer, then push the diagram to
// the engine once so the animation re-binds (no model rebuild). Async because
// adding a compartment / swapping a picto loads sprite assets; the caller must
// await so a follow-up `connect` sees the new component.
export async function executeDiagramCommand(
  norm: DiagramNormalized,
  h: DiagramHandle,
): Promise<void> {
  switch (norm.action) {
    case "addComponent": {
      const actual = await h.add(norm.name, norm.picto);
      h.setModels(actual, norm.models);
      h.setLabel(actual, norm.label);
      if (norm.pos) h.setLayout(actual, { sprite: { pos: norm.pos } });
      break;
    }
    case "connect":
      h.connect(norm.from, norm.to, { models: norm.models, path: norm.path });
      break;
    case "setLayout":
      h.setLayout(norm.name, norm.patch);
      break;
    case "setLabel":
      h.setLabel(norm.name, norm.text);
      break;
    case "setModels":
      h.setModels(norm.name, norm.models);
      break;
    case "setPicto":
      await h.setPicto(norm.name, norm.picto);
      break;
    case "delete":
      h.remove(norm.name);
      break;
  }
  h.push();
}
