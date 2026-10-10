// Build the "command catalog" the Explain bot uses to know which model actions
// it may propose. Generated from the SAME sources the webapp validates against,
// so the bot is never told it can do something the app would reject:
//
//   src/services/botCommandAllowlist.ts   — the curated "Guided" allowlist
//   src/model-interface/registry.ts       — MODEL_INTERFACES: every editable
//                                            field, its bounds / choices / args / units
//
// Output: knowledge-pack/command-catalog.md — two parts:
//   1. Guided mode — the small curated set (active when the user picks "Guided").
//   2. Full mode   — every runtime-settable field on every model_type (the default).
//
// "Settable at runtime" = a non-readonly number/factor/boolean/list parameter, or
// a function. The structural wiring types (multiple-list/prop-list/reference/dict)
// are rebuild-only and excluded; readonly measured-outputs/descriptions too. This
// mirrors isSettableField() in src/services/botCommands.ts.
//
// SNAPSHOT — re-run after the registry or allowlist changes and redeploy to the
// bot. We bundle the .ts sources to a temp ESM module with esbuild (a vite dep)
// since Node can't import TS directly.
//
//   Usage:  node scripts/build_command_catalog.mjs

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const OUT = path.resolve(ROOT, "knowledge-pack/command-catalog.md");

// ---------------------------------------------------------------------------
// 1. Bundle the allowlist + registry to an importable module
// ---------------------------------------------------------------------------
const ENTRY = `
export { COMMAND_ALLOWLIST, DIAGRAM_ACTIONS } from "@/services/botCommandAllowlist";
export { MODEL_INTERFACES, getInterfaceForType } from "@/model-interface/registry";
export { PICTOS, PATH_TYPES, LAYOUT_PATCH_WHITELIST } from "@/render/diagramConstants";
export { COMMON_TASKS, TASK_CATEGORY_LABELS } from "@/services/commonTasks";
`;

const tmp = path.join(os.tmpdir(), `explain-cmd-catalog-${process.pid}.mjs`);
await esbuild.build({
  stdin: { contents: ENTRY, resolveDir: ROOT, loader: "ts" },
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: tmp,
  alias: {
    "@": path.resolve(ROOT, "src"),
    // src/services/botCommands.ts imports @explain/helpers/Calibrator; mirror the
    // vite.config alias so this bundle resolves it through the `explain` submodule.
    "@explain": path.resolve(ROOT, "explain"),
  },
  logLevel: "warning",
});
const {
  COMMAND_ALLOWLIST,
  DIAGRAM_ACTIONS,
  MODEL_INTERFACES,
  getInterfaceForType,
  PICTOS,
  PATH_TYPES,
  LAYOUT_PATCH_WHITELIST,
  COMMON_TASKS,
  TASK_CATEGORY_LABELS,
} = await import(`file://${tmp}`);
fs.rmSync(tmp, { force: true });

// ---------------------------------------------------------------------------
// 2. Field helpers (kept in sync with src/services/botCommands.ts)
// ---------------------------------------------------------------------------
const unit = (caption) => caption?.match(/\(([^)]+)\)/)?.[1] ?? "";
const bounds = (f) => {
  const b = [];
  if (typeof f.ll === "number") b.push(`${f.ll}`);
  if (typeof f.ul === "number") b.push(`${f.ul}`);
  return b.length === 2 ? `${b[0]}–${b[1]}` : b.length ? (typeof f.ll === "number" ? `≥${f.ll}` : `≤${f.ul}`) : "";
};
// mirror resolveChoices() — registry mixes options/choices and doesn't always set
// custom_options, so an empty options[] must fall through to choices.
const choicesOf = (f) =>
  [f.custom_options ? f.choices : f.options, f.choices, f.options].find(
    (c) => Array.isArray(c) && c.length > 0,
  ) ?? [];

const SETTABLE_PROP_TYPES = new Set(["number", "factor", "boolean", "list"]);
const isSettableProp = (f) => !f.readonly && SETTABLE_PROP_TYPES.has(f.type);
const isFunction = (f) => f.type === "function";

// compact "[type, unit, range, choices]" tail for a param or arg
const metaTail = (f) =>
  [
    f.type,
    unit(f.caption),
    bounds(f) && `range ${bounds(f)}`,
    f.type === "list" && choicesOf(f).length && `one of ${choicesOf(f).join("/")}`,
  ]
    .filter(Boolean)
    .join(", ");

const MODE_ORDER = { basic: 0, extra: 1, factors: 2, advanced: 3 };
const modeRank = (f) => MODE_ORDER[f.edit_mode] ?? 4;
const modeTag = (f) => (f.edit_mode && f.edit_mode !== "basic" ? ` _(${f.edit_mode})_` : "");

const paramLine = (f) =>
  `- \`${f.target}\`${f.caption ? ` — ${f.caption}` : ""} (${metaTail(f)})${modeTag(f)}`;

const funcLine = (f) => {
  // args joined by ";" so an arg's own comma-separated meta stays unambiguous
  const args = (f.args ?? [])
    .map((a) => `${a.target} (${metaTail(a)})`)
    .join("; ");
  return `- \`${f.target}(${args})\`${f.caption ? ` — ${f.caption}` : ""}`;
};

// ---------------------------------------------------------------------------
// 3. Guided section (the curated allowlist)
// ---------------------------------------------------------------------------
const guided = ["## Guided mode — curated safe set", ""];
guided.push(
  "Active when the user selects **Guided** scope in the chat panel. Only these commands apply;",
  "anything else is rejected (the app suggests switching to Full). Full mode (below) is the default.",
  "",
);
for (const e of COMMAND_ALLOWLIST) {
  const where = e.model ? `\`${e.model}.${e.target}\`` : "";
  guided.push(`- \`${e.op}\` ${where}${e.note ? ` — ${e.note}` : ""}`);
}
guided.push("");

// ---------------------------------------------------------------------------
// 4. Full section (every settable field, by model_type)
// ---------------------------------------------------------------------------
const full = ["## Full mode — all settable fields by model_type", ""];
let typeCount = 0;
let propCount = 0;
let fnCount = 0;

for (const type of Object.keys(MODEL_INTERFACES).sort()) {
  const fields = getInterfaceForType(type);
  const props = fields.filter(isSettableProp).sort((a, b) => modeRank(a) - modeRank(b));
  const fns = fields.filter(isFunction);
  if (!props.length && !fns.length) continue;

  typeCount++;
  propCount += props.length;
  fnCount += fns.length;

  full.push(`### ${type}`);
  if (props.length) {
    full.push("", "_setProp_:");
    for (const f of props) full.push(paramLine(f));
  }
  if (fns.length) {
    full.push("", "_call_:");
    for (const f of fns) full.push(funcLine(f));
  }
  full.push("");
}

// ---------------------------------------------------------------------------
// 4a2. Common tasks — directional nudges (map onto existing setProp / scale)
// ---------------------------------------------------------------------------
const pct = (s) => `${Math.round(s * 100)}%`;
// Registry field behind a setProp lever (singleton instance name === model_type for
// these levers; resolveByType levers pass the model_type directly). Used to convert
// the catalog's raw steps/bounds into the DISPLAY units the bot must emit (setProp
// values are divided by field.factor by the webapp).
const fieldOf = (t) =>
  t.lever.kind === "setProp"
    ? (getInterfaceForType(t.lever.model) || []).find((f) => f.target === t.lever.target)
    : null;
const facOf = (t) => fieldOf(t)?.factor ?? 1;
const dispUnit = (t) => (fieldOf(t) ? unit(fieldOf(t).caption) : t.unit) || "";
const num = (x) => Number(x.toFixed(6)).toString(); // trim float noise
const leverDesc = (t) => {
  if (t.lever.kind === "scale") {
    const groups = Array.isArray(t.lever.group) ? t.lever.group : [t.lever.group];
    return `scale ${groups.map((g) => `\`${g}\``).join(" + ")}`;
  }
  if (t.lever.kind === "call") return `call \`${t.lever.model}.${t.lever.fn}\` (current value \`${t.lever.read}\`)`;
  return t.lever.resolveByType
    ? `setProp \`${t.lever.target}\` on each \`${t.lever.model}\` instance`
    : `setProp \`${t.lever.model}.${t.lever.target}\``;
};
const taskExample = (t) => {
  if (t.lever.kind === "scale") {
    const g = (Array.isArray(t.lever.group) ? t.lever.group : [t.lever.group])[0];
    return `{"op":"scale","group":"${g}","factor":<absolute, 1.0=baseline>,"reason":"${t.short} nudge"}`;
  }
  if (t.lever.kind === "call" && t.choices) {
    return `{"op":"call","model":"${t.lever.model}","target":"${t.lever.fn}","args":[<${t.choices.map((c) => JSON.stringify(c.value)).join(" | ")}>],"reason":"${t.short}"}`;
  }
  if (t.lever.kind === "call") {
    const u = t.unit ? ` ${t.unit}` : "";
    return `{"op":"call","model":"${t.lever.model}","target":"${t.lever.fn}","args":[<${num(t.min ?? 0)}–${num(t.max ?? 0)}${u}>],"reason":"set ${t.short}"}`;
  }
  const m = t.lever.resolveByType ? "<instance>" : t.lever.model;
  const u = dispUnit(t) ? ` ${dispUnit(t)}` : "";
  if (t.mode === "absolute") {
    // bot emits an ABSOLUTE value in DISPLAY units (it can't read most current props
    // from context, and setProp divides by the field factor). Range is display units.
    const lo = num((t.min ?? 0) * facOf(t));
    const hi = num((t.max ?? 0) * facOf(t));
    return `{"op":"setProp","model":"${m}","target":"${t.lever.target}","value":<${lo}–${hi}${u}; 0=closed/none>,"reason":"set ${t.short}"}`;
  }
  return `{"op":"setProp","model":"${m}","target":"${t.lever.target}","value":<target in display units, or current×(1±${pct(t.step)}) if shown>,"reason":"adjust ${t.short}"}`;
};
const stepDesc = (t) => {
  if (t.choices) return `choices ${t.choices.map((c) => `\`${JSON.stringify(c.value)}\` (${c.label})`).join(", ")}`;
  if (t.mode !== "absolute") return `default ±${pct(t.step)}`;
  const dispStep = num(t.step * facOf(t));
  const lo = num((t.min ?? 0) * facOf(t));
  const hi = num((t.max ?? 0) * facOf(t));
  return `step ±${dispStep}${dispUnit(t) ? ` ${dispUnit(t)}` : ""}, range ${lo}–${hi}`;
};

const tasks = ["## Common tasks — directional nudges", ""];
tasks.push(
  'Curated relative adjustments ("raise PVR 30%", "halve contractility"). Each maps onto an EXISTING',
  "`setProp`, `scale` or `call` op — there is no special nudge op. Resolution rules:",
  "",
  "- **setProp levers** (a `*_factor_ps` factor or a plain number): if the field's value is shown in the",
  "  live monitor context, multiply by (1+step) to raise / 1/(1+step) to lower; otherwise set an ABSOLUTE",
  "  target in DISPLAY units within the field's range. Values are display units (divided by the field",
  "  factor on apply), like any setProp.",
  "- **scale levers** (a ModelScaler group): `factor` is ABSOLUTE from baseline 1.0 (the current factor",
  "  is NOT visible in state) — reason about prior nudges this conversation. Apply the SAME factor to",
  "  every listed group; >1 raises, <1 lowers.",
  "- **absolute setProp levers** (shunt sizes — PDA/foramen ovale/VSD): set an ABSOLUTE value in DISPLAY",
  "  units within the stated range; 0 = closed/none. The engine treats diameter 0 as a hard-closed fast",
  "  path, so open a closed shunt by setting a positive diameter (e.g. PDA 50 = ~half-open).",
  "- **call levers** (ventilator tube size/length, humidifier temperature): call the setter with the",
  "  ABSOLUTE new value within the stated range; the setter recomputes what depends on it.",
  "",
  "For inverse quantities (lung compliance ↔ elastance; preload ↔ unstressed volume) raising the",
  "physiological quantity LOWERS the lever — noted per task.",
  "",
);
const byCat = {};
for (const t of COMMON_TASKS) (byCat[t.category] ??= []).push(t);
for (const cat of Object.keys(TASK_CATEGORY_LABELS).filter((c) => byCat[c])) {
  tasks.push(`### ${TASK_CATEGORY_LABELS[cat] ?? cat}`, "");
  for (const t of byCat[cat]) {
    const inv = t.invert ? " _(inverse: raising the quantity lowers the lever)_" : "";
    tasks.push(`- **${t.label}** — ${leverDesc(t)}, ${stepDesc(t)}.${inv}${t.help ? ` ${t.help}` : ""}`);
    tasks.push(`  - e.g. \`${taskExample(t)}\``);
  }
  tasks.push("");
}

// ---------------------------------------------------------------------------
// 4b. Diagram section (op: "diagram" — edits the live diagram)
// ---------------------------------------------------------------------------
const diagram = ["## Diagram editing — `op:\"diagram\"`", ""];
diagram.push(
  "Edit the diagram the user sees (compartments = sprites bound to engine models,",
  "connectors = paths between them). Requires the **Diagram tab** to be open; each",
  "turn's context lists the **Current diagram** (component ids + their model bindings),",
  "and the **`Models in scenario:`** map gives the engine instance names you bind to.",
  "Use existing component ids verbatim; give every new component a unique `name`.",
  "",
  "Envelope: `{\"op\":\"diagram\",\"action\":\"<action>\", ...fields, \"reason\":\"<label>\"}`",
  "",
  "Actions:",
);
for (const d of DIAGRAM_ACTIONS) {
  diagram.push(`- \`${d.action}\` — fields: ${d.fields}. ${d.note}`);
}
diagram.push(
  "",
  `- **picto** must be one of: ${PICTOS.join(", ")}`,
  `- **path.type** must be one of: ${PATH_TYPES.join(", ")}`,
  `- **setLayout patch** keys (cosmetic only): ${LAYOUT_PATCH_WHITELIST.join(", ")}`,
  "- **pos**: `{\"type\":\"arc\",\"dgs\":<0-360>}` to sit on the layout ring, or",
  "  `{\"type\":\"rel\",\"x\":<-1..1>,\"y\":<-1..1>}` relative to centre.",
  "",
  "Example — add a kidney compartment and connect it to the aorta:",
  "```json",
  '{"op":"diagram","action":"addComponent","name":"Kidney","models":["Kidneys"],"picto":"general.png","label":"Kidney","pos":{"type":"arc","dgs":210},"reason":"add kidney"}',
  '{"op":"diagram","action":"connect","from":"AA","to":"Kidney","models":["AA_Kidney"],"path":{"type":"arc"},"reason":"renal artery"}',
  "```",
  "",
);

// ---------------------------------------------------------------------------
// 4c. Events & scheduling (op: "event" — a named, saved bundle of timed changes)
// ---------------------------------------------------------------------------
const events = ["## Events & scheduling — `op:\"event\"`", ""];
events.push(
  "Bundle several property changes into one **named event** the user can replay. Each entry",
  "in `changes[]` is a `setProp`-style `{model, target, value}` with two optional timing",
  "fields (simulated seconds, only advancing while the sim runs):",
  "",
  "- `it` — ramp the numeric value to the target over N seconds (numbers only; booleans/lists swap instantly).",
  "- `at` — delay the change N seconds before it starts.",
  "",
  "Each change is validated against the same fields/bounds/units as a `setProp` (Full vs Guided",
  "scope applies per change). Applying the card **saves the event into the Event Scheduler",
  "panel** — it does not fire it; the user applies or arms it there. Optional `fire_at` (absolute",
  "sim-clock auto-fire) is a panel feature; omit unless asked.",
  "",
  "Envelope: `{\"op\":\"event\",\"name\":\"<name>\",\"changes\":[{\"model\",\"target\",\"value\",\"it\"?,\"at\"?}, …],\"fire_at\":<s?>,\"reason\":\"<label>\"}`",
  "",
  "Example — drive a tachycardia then drop spontaneous breathing 30 s later:",
  "```json",
  '{"op":"event","name":"induce tachy","changes":[{"model":"Heart","target":"heart_rate_ref","value":200,"it":15},{"model":"Breathing","target":"breathing_enabled","value":false,"at":30}],"reason":"ramp HR to 200 over 15s, apnea at +30s"}',
  "```",
  "",
);

// ---------------------------------------------------------------------------
// 5. Header + assemble + write
// ---------------------------------------------------------------------------
const header = [
  "# Explain — command catalog (bot-facing)",
  "",
  "What you may propose as `explain-command` actions. See `command-protocol.md` for HOW to",
  "emit them and the rules. Resolve a target like this: read the **`Models in scenario:`**",
  "map in the live context to pick the right *instance name*, find that instance's",
  "*model_type* in the map, then use the fields listed under that model_type here.",
  "",
  "**Envelope** (one JSON object per fenced block):",
  "",
  "```json",
  '{"op":"setProp","model":"<instance name>","target":"<field>","value":<value>,"it":<ramp s?>,"at":<delay s?>,"reason":"<short label>"}',
  '{"op":"call","model":"<instance name>","target":"<function>","args":[...],"reason":"<short label>"}',
  '{"op":"event","name":"<event name>","changes":[{"model":"..","target":"..","value":..,"it":<s?>,"at":<s?>}],"reason":"<short label>"}',
  '{"op":"start"}   {"op":"stop"}',
  "```",
  "",
  "Rules of thumb:",
  "- **Values are in the displayed unit** shown per field; stay within the stated range.",
  "- **Timing (optional):** `it` ramps a numeric value to the target over N simulated seconds;",
  "  `at` delays the change N seconds. `op:\"event\"` bundles several timed `changes[]` into a",
  "  named event saved to the Event Scheduler panel — see `command-protocol.md` (Scheduling).",
  "- **To tune a physiological property, prefer its `*_factor_ps` knob** (a `factor` field,",
  "  1.0 = baseline, >1 increases, <1 decreases) over editing the raw base value — factors",
  "  compose with interventions and weight-scaling. E.g. stiffer LV → `LV.el_max_factor_ps` 1.3.",
  "- Only fields listed here are accepted; readonly measured-outputs and structural wiring are omitted.",
  "",
  `Snapshot: **${typeCount} model_types**, **${propCount} settable params**, **${fnCount} functions**`,
  `(+ ${COMMAND_ALLOWLIST.length} Guided commands, ${DIAGRAM_ACTIONS.length} diagram actions). Regenerate with \`node scripts/build_command_catalog.mjs\`.`,
  "",
  "---",
  "",
].join("\n");

fs.writeFileSync(
  OUT,
  header +
    guided.join("\n") +
    "\n---\n\n" +
    full.join("\n") +
    "\n---\n\n" +
    tasks.join("\n") +
    "\n---\n\n" +
    events.join("\n") +
    "\n---\n\n" +
    diagram.join("\n"),
  "utf8",
);

console.log(`command catalog written: ${path.relative(ROOT, OUT)}`);
console.log(`  Guided commands : ${COMMAND_ALLOWLIST.length}`);
console.log(`  Full mode       : ${typeCount} model_types, ${propCount} params, ${fnCount} functions`);
console.log(`  Common tasks    : ${COMMON_TASKS.length}`);
console.log(`  Diagram actions : ${DIAGRAM_ACTIONS.length}`);
