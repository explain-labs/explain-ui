// Single source of truth for which bot-issued commands the webapp will execute.
//
// The chat pipeline (`botCommands.ts`) validates every command the bot proposes
// against this list, and the bot-facing catalog generator
// (`scripts/build_command_catalog.mjs`) reads the SAME list so the bot is never
// told it can do something the webapp would then refuse. To widen the bot's
// reach, add an entry here and regenerate the catalog — nothing else.
//
// v1 is a deliberate vertical slice: ventilator on/off + a few vent params +
// start/stop the sim. Broaden one model-type at a time.

import { commonTaskAllowEntries } from "./commonTasks";

export type CommandOp =
  | "call" // invoke a model method        -> useExplain().call
  | "setProp" // write a model property        -> useExplain().setProp
  | "scale" // scale a parameter group       -> useExplain().scale
  | "start" // start the realtime loop       -> useExplain().start
  | "stop" // stop the realtime loop         -> useExplain().stop
  | "calculate" // run N seconds offline          -> useExplain().calculate
  | "load" // load a scenario by name        -> useExplain().load
  | "loadDefinition" // load a bot-built patient definition -> useExplain().loadFromObject
  | "tune" // closed-loop tune the live model to target values -> useExplain().tune
  | "revert" // undo live changes: reload the patient as loaded -> useExplain().revert
  | "event" // build a named scheduled event  -> useEventsStore() (see chat store)
  | "diagram"; // edit the diagram             -> DiagramRenderer (see diagram actions below)

export interface AllowEntry {
  op: CommandOp;
  model?: string; // for call / setProp (the model instance name)
  target?: string; // function name (call) or prop name (setProp)
  note?: string; // short human description, surfaced in the bot catalog
}

export const COMMAND_ALLOWLIST: AllowEntry[] = [
  // --- Ventilator (mechanical ventilation device) ---
  {
    op: "call",
    model: "Ventilator",
    target: "switch_ventilator",
    note: "turn mechanical ventilation on/off (arg: boolean)",
  },
  { op: "call", model: "Ventilator", target: "set_fio2", note: "set inspired O2 fraction (0.21–1.0)" },
  {
    op: "call",
    model: "Ventilator",
    target: "set_ettube_diameter",
    note: "set endotracheal tube diameter (mm)",
  },
  {
    op: "call",
    model: "Ventilator",
    target: "set_ettube_length",
    note: "set endotracheal tube length (mm)",
  },
  { op: "setProp", model: "Ventilator", target: "vent_mode", note: "ventilation mode (PC/PRVC/PS/CPAP)" },
  { op: "setProp", model: "Ventilator", target: "vent_rate", note: "ventilator rate (/min)" },
  { op: "setProp", model: "Ventilator", target: "insp_time", note: "inspiration time (s)" },
  { op: "setProp", model: "Ventilator", target: "tidal_volume", note: "target tidal volume (mL)" },
  { op: "setProp", model: "Ventilator", target: "pip_cmh2o", note: "peak inspiratory pressure (cmH2O)" },
  {
    op: "setProp",
    model: "Ventilator",
    target: "pip_cmh2o_max",
    note: "max peak inspiratory pressure, PRVC (cmH2O)",
  },
  {
    op: "setProp",
    model: "Ventilator",
    target: "peep_cmh2o",
    note: "positive end-expiratory pressure (cmH2O); doubles as the CPAP level in CPAP mode",
  },
  { op: "setProp", model: "Ventilator", target: "insp_flow", note: "inspiratory/bias flow (L/min)" },
  {
    op: "setProp",
    model: "Ventilator",
    target: "synchronized",
    note: "synchronized (patient-triggered) ventilation on/off",
  },
  {
    op: "setProp",
    model: "Ventilator",
    target: "trigger_volume_perc",
    note: "breath trigger volume (% of tidal volume)",
  },
  { op: "call", model: "Ventilator", target: "trigger_breath", note: "trigger a single manual breath (no args)" },

  // --- Hemodynamics + autonomic nervous system ---
  { op: "setProp", model: "Heart", target: "heart_rate_ref", note: "reference heart rate (bpm)" },
  { op: "setProp", model: "Heart", target: "ans_sens", note: "autonomic sensitivity of the heart (0–1)" },
  { op: "setProp", model: "Ans", target: "ans_active", note: "autonomic nervous system on/off" },

  // --- Spontaneous breathing + metabolism ---
  {
    op: "setProp",
    model: "Breathing",
    target: "breathing_enabled",
    note: "spontaneous breathing on/off",
  },
  {
    op: "setProp",
    model: "Breathing",
    target: "minute_volume_ref",
    note: "reference minute volume (L/kg/min)",
  },
  { op: "setProp", model: "Metabolism", target: "met_active", note: "metabolism on/off" },
  { op: "setProp", model: "Metabolism", target: "vo2", note: "oxygen consumption VO2 (mL/kg/min)" },

  // --- Drugs ---
  {
    op: "call",
    model: "Drugs",
    target: "administer_bolus",
    note: "IV bolus (args: drug name, dose in mcg 0–1000)",
  },
  {
    op: "call",
    model: "Drugs",
    target: "set_infusion",
    note: "continuous infusion (args: drug name, rate mcg/kg/min)",
  },
  { op: "setProp", model: "Drugs", target: "drugs_running", note: "drug engine on/off" },

  // --- Resuscitation (CPR) ---
  { op: "call", model: "Resuscitation", target: "switch_cpr", note: "start/stop CPR (arg: boolean)" },
  {
    op: "call",
    model: "Resuscitation",
    target: "set_fio2",
    note: "set CPR ventilation FiO2 (0–1)",
  },
  {
    op: "setProp",
    model: "Resuscitation",
    target: "chest_comp_freq",
    note: "chest compression frequency (/min)",
  },
  {
    op: "setProp",
    model: "Resuscitation",
    target: "chest_comp_max_pres",
    note: "peak chest compression pressure (mmHg)",
  },
  {
    op: "setProp",
    model: "Resuscitation",
    target: "chest_comp_no",
    note: "chest compressions per cycle (e.g. 3 for 3:1, 15 for 15:2)",
  },
  {
    op: "setProp",
    model: "Resuscitation",
    target: "chest_comp_cont",
    note: "continuous compressions without ventilation pauses (boolean)",
  },
  { op: "setProp", model: "Resuscitation", target: "vent_freq", note: "CPR ventilation rate (/min)" },
  { op: "setProp", model: "Resuscitation", target: "vent_no", note: "ventilations per pause (e.g. 2 for 15:2)" },
  {
    op: "setProp",
    model: "Resuscitation",
    target: "vent_pres_pip",
    note: "CPR ventilation peak pressure (cmH2O); pushed to the ventilator when CPR is switched on",
  },
  {
    op: "setProp",
    model: "Resuscitation",
    target: "vent_pres_peep",
    note: "CPR ventilation PEEP (cmH2O); pushed to the ventilator when CPR is switched on",
  },
  {
    op: "setProp",
    model: "Resuscitation",
    target: "vent_insp_time",
    note: "CPR ventilation inspiration time (s); pushed to the ventilator when CPR is switched on",
  },

  // --- ECLS (extracorporeal life support / ECMO) ---
  // The Ecls model has no setter functions — everything is a direct setProp;
  // calc_model() picks the values up each tick (see EclsPanel.vue).
  { op: "setProp", model: "Ecls", target: "ecls_running", note: "ECLS circuit on/off (boolean)" },
  { op: "setProp", model: "Ecls", target: "ecls_clamped", note: "clamp/unclamp the ECLS blood path (boolean)" },
  {
    op: "setProp",
    model: "Ecls",
    target: "pump_type",
    note: "pump device (list: Abbott PediMag, Abbott CentriMag, Getinge Rotaflow RF-32, Medtronic Bio-Pump BP-50, Generic roller pump); sets centrifugal/roller mode and the pump's H-Q curve. Keep pump_rpm within the pump's max (roller ~250)",
  },
  {
    op: "setProp",
    model: "Ecls",
    target: "oxygenator_type",
    note: "oxygenator device (list: Getinge Quadrox-i Neonatal, Getinge Quadrox-i Pediatric, Getinge Quadrox-i Small Adult, Medtronic Nautilus (Adult)); sets the membrane's O2/CO2 transfer ceilings. Pick one rated for the circuit flow",
  },
  { op: "setProp", model: "Ecls", target: "pump_rpm", note: "pump speed (rpm; max depends on the pump: 3000-5500 centrifugal, 250 roller)" },
  { op: "setProp", model: "Ecls", target: "gas_flow", note: "sweep gas flow (L/min, 0-10)" },
  { op: "setProp", model: "Ecls", target: "gas_fio2", note: "sweep gas O2 fraction (0.21-1.0)" },
  { op: "setProp", model: "Ecls", target: "gas_fico2", note: "sweep gas CO2 fraction (0-0.1)" },
  {
    op: "setProp",
    model: "Ecls",
    target: "drainage_res_factor",
    note: "drainage cannula resistance multiplier (1.0 = baseline)",
  },
  {
    op: "setProp",
    model: "Ecls",
    target: "return_res_factor",
    note: "return cannula resistance multiplier (1.0 = baseline)",
  },
  {
    op: "setProp",
    model: "Ecls",
    target: "tubing_res_factor",
    note: "circuit tubing resistance multiplier (1.0 = baseline)",
  },
  {
    op: "setProp",
    model: "Ecls",
    target: "pump_res_factor",
    note: "pump resistance multiplier (1.0 = baseline)",
  },
  {
    op: "setProp",
    model: "Ecls",
    target: "oxy_res_factor",
    note: "oxygenator resistance multiplier (1.0 = baseline)",
  },
  {
    op: "setProp",
    model: "Ecls",
    target: "drainage_cannula_type",
    note: "drainage cannula key from the scenario's cannula library (string)",
  },
  {
    op: "setProp",
    model: "Ecls",
    target: "return_cannula_type",
    note: "return cannula key from the scenario's cannula library (string)",
  },

  // --- Simulation control ---
  { op: "start", note: "start the realtime simulation loop" },
  { op: "stop", note: "stop the realtime simulation loop" },
  { op: "revert", note: "undo all live changes — reload the patient as it was loaded" },

  // --- Live closed-loop tuning (Full scope only) ---
  // Drive a measured quantity of the RUNNING model to an exact value by iterating
  // (apply lever → run → measure → nudge). targets: map, co, hr, po2, spo2, pco2,
  // be, ph, blood_volume. Done in place (no reload). See validateTuneCommand.
  { op: "tune", note: "tune the live model to target value(s): map/co/hr/po2/spo2/pco2/be/ph/blood_volume (Full scope)" },

  // --- Whole-patient replacement (Full scope only) ---
  // Loads a complete, bot-built calibrated patient definition and runs it
  // immediately (replaces the current model). The definition is NOT carried in
  // the command block — it arrives out-of-band in the chat response `artifact`
  // field (the bot host builds it with scripts/build_patient.mjs). Gated to Full
  // scope in validateCommand (too powerful for Guided demos) + confirm-before-apply.
  { op: "loadDefinition", note: "load+run a bot-built calibrated patient (Full scope; definition rides in response.artifact)" },
];

// Common physiological tasks (directional nudges) contribute their singleton
// setProp levers — e.g. Circulation.svr_factor_art / pvr_factor_art — so the bot
// can nudge them in Guided scope too. Appended here (deduped) to keep the catalog
// single-sourced. model_type-resolved levers are skipped (see commonTasks.ts).
for (const e of commonTaskAllowEntries()) {
  if (!isAllowed(e.op, e.model, e.target)) COMMAND_ALLOWLIST.push(e);
}

// True when (op, model?, target?) matches an allowlist entry. Ops without a
// model/target (start/stop/...) match on op alone.
export function isAllowed(op: string, model?: string, target?: string): boolean {
  return COMMAND_ALLOWLIST.some(
    (e) =>
      e.op === op &&
      (e.model === undefined || e.model === model) &&
      (e.target === undefined || e.target === target),
  );
}

// --- Whole-model scaling (op: "scale") -------------------------------------
//
// `scale` multiplies a whole GROUP of related parameters in one command (e.g.
// total blood volume, all systemic resistances) — what you'd otherwise need many
// setProps for. It routes to ModelScaler (explain-engine/helpers/ModelScaler.js) via
// useExplain().scale(group, factor); factor 1.0 = baseline, <1 lowers, >1 raises.
// Reversible and stackable. Curated to the physiologically-useful, safe groups
// (weight_scale / incorporate / reset / add_volume are excluded — special
// semantics; add_volume is a Fluids function, reset/undo is the `revert` op).
// Full scope only (see validateCommand).
export const SCALE_GROUPS: readonly string[] = [
  "blood_volume", // total circulating volume (hemorrhage / fluid overload)
  "systemic_resistances", // SVR (afterload)
  "pulmonary_resistances", // PVR (RV afterload)
  "systemic_u_vol", // systemic venous unstressed volume (preload / venous tone)
  "pulmonary_u_vol", // pulmonary unstressed volume
  "heart_el_max", // contractility, both ventricles
  "left_heart_el_max", // LV contractility
  "right_heart_el_max", // RV contractility
  "heart_el_min", // diastolic stiffness, both ventricles
  "left_heart_el_min",
  "right_heart_el_min",
  "heart_volume", // heart chamber volumes
  "systemic_elastances", // systemic vessel stiffness
  "pulmonary_elastances", // pulmonary vessel stiffness
  "left_lung_elastances", // left-lung compliance (1/elastance)
  "right_lung_elastances", // right-lung compliance
  "airway_lower_resistances", // lower-airway resistance (bronchospasm)
];

export function isScaleGroup(g: string | undefined): boolean {
  return typeof g === "string" && SCALE_GROUPS.includes(g);
}

// --- Diagram editing (op: "diagram") ---------------------------------------
//
// Diagram edits are a separate capability surface from model commands: they
// don't target a registry field (no ll/ul/choices), they mutate the live
// DiagramRenderer instead of the engine. They're gated on the renderer being
// mounted (the Diagram tab) rather than on the guided/full allowlist. The
// per-action field rules are validated in botCommands.validateDiagramCommand and
// described to the bot via this descriptor list (build_command_catalog.mjs).
//
// FUTURE: risk-tiering / rate-limiting of structural diagram edits, mirroring
// the model-command allowlist note above.
export type DiagramAction =
  | "addComponent"
  | "connect"
  | "setLayout"
  | "setLabel"
  | "setModels"
  | "setPicto"
  | "delete";

export interface DiagramActionDef {
  action: DiagramAction;
  fields: string; // required/optional fields the bot must emit
  note: string; // short human description for the bot catalog
}

export const DIAGRAM_ACTIONS: DiagramActionDef[] = [
  {
    action: "addComponent",
    fields: "name (unique), models[] (engine instance names), picto, label?, pos?",
    note: "add a compartment bound to engine model(s); pos is {type:'arc',dgs} or {type:'rel',x,y}",
  },
  {
    action: "connect",
    fields: "from, to (existing component names), models?[], path?{type,width}",
    note: "draw a connector between two existing components, optionally bound to a Resistor model",
  },
  {
    action: "setLayout",
    fields: "name, patch (cosmetic layout keys only)",
    note: "restyle a component/connector: alpha, z_index, tinting, sprite color/scale/rotation/pos, label, path",
  },
  { action: "setLabel", fields: "name, text", note: "set a component's caption text" },
  { action: "setModels", fields: "name, models[]", note: "rebind which engine model(s) a component/connector represents" },
  { action: "setPicto", fields: "name, picto", note: "swap a compartment's sprite image" },
  { action: "delete", fields: "name", note: "remove a component (and its attached connectors) or a connector" },
];

export function isDiagramAction(a: unknown): a is DiagramAction {
  return typeof a === "string" && DIAGRAM_ACTIONS.some((d) => d.action === a);
}
