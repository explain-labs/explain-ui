import { defineLesson, type LessonAction, type LessonNumeric, type Op } from "@/lessons/types";
import type { Intervention } from "@/lessons/interventions";
import { introSteps } from "@/lessons/_shared/intro";

// Neonatal shock by treatment target: four building blocks (hypovolaemic, distributive with
// capillary leak, cardiogenic systolic/diastolic, PPHN with the duct) on the term neonate, for a
// one-hour plenary session with fellows following on their own laptops. English only.
//
// Doses and factors were checked headlessly on the shipped scenarios before use (term_neonate_72h:
// 3.545 kg, blood volume 85 ml/kg = 301 ml; term_neonate_12h for the bleed, term_neonate_1h for
// the PPHN step). Two settings are
// deliberately compressed in time so a case fits a 10-minute slot, and the step text says so:
// the capillary leak (Kf ×10, a bolus leaks out within ~4 min) and the bleed (35 % over 2 min).

const W = 3.545; // kg, both term scenarios
const ML = (mlPerKg: number) => Math.round(mlPerKg * W);

// a clean patient for every case: rebuild the scenario, then let it settle so the lactate
// baseline (Lactate captures it over the first 90 s) and the interstitium are seeded
const fresh = (scenario: string): Op[] => [
  { kind: "loadScenario", scenario, fresh: true },
  { kind: "calculate", seconds: 100 },
];
const TERM = fresh("term_neonate_72h");
// the bleed case: a subgaleal haemorrhage presents in the first hours to day of life,
// so a 12 h baby with the duct still half open (left-to-right)
const NEWBORN = fresh("term_neonate_12h");
const TRANSITION = fresh("term_neonate_1h");

const call = (fn: string, ...args: unknown[]): Op => ({ kind: "call", fn, args });
const bolus = (mlPerKg: number, seconds = 60): Op =>
  call("Fluids.add_volume", ML(mlPerKg), seconds, "normal_saline", "VLB");
const infusion = (drug: string, rate: number): Op => call("Drugs.set_infusion", drug, rate);

// shared buttons
const wait = (minutes: number): LessonAction => ({
  id: `wait-${minutes}`,
  label: `Fast-forward ${minutes} min`,
  icon: "pi pi-forward",
  severity: "secondary",
  ops: [{ kind: "calculate", seconds: minutes * 60 }],
});
const again = (ops: Op[]): LessonAction => ({
  id: "again",
  label: "Start this case again",
  icon: "pi pi-refresh",
  severity: "secondary",
  ops,
});

const num = (
  label: string,
  path: string | string[],
  unit: string,
  rounding = 0,
  factor = 1,
  weight_based = false,
): LessonNumeric => ({
  label,
  props: Array.isArray(path) ? path : [path],
  unit,
  rounding,
  factor,
  weight_based,
});
const perKg = (label: string, path: string, unit: string, rounding = 0) => num(label, path, unit, rounding, 1000, true);

// The treatment targets as standing controls (Interventions tab), usable on every
// step. The scale sliders show % of normal: the ModelScaler group factor
// (1 = the scenario as loaded) read back from the first model of its group, the
// same lever as Common tasks. Diastolic function is the inverse of the stiffness
// factor (50 % = twice as stiff).
const scaleSlider = (
  id: string,
  label: string,
  group: string,
  read: string,
  min: number,
  max: number,
  help: string,
  invert = false,
): Intervention => ({
  id,
  kind: "slider",
  label,
  help,
  read,
  min,
  max,
  step: 5,
  unit: "%",
  factor: 100,
  invert,
  toOps: (raw) => [{ kind: "scale", group, factor: raw }],
});
const INTERVENTIONS: Record<string, Intervention> = {
  saline: {
    id: "saline",
    kind: "button",
    label: "Fluid bolus: NaCl 0.9 % 20 ml/kg",
    icon: "pi pi-plus",
    help: `${ML(20)} ml over 1 min of model time.`,
    requires: ["Fluids"],
    ops: [bolus(20)],
  },
  transfusion: {
    id: "transfusion",
    kind: "button",
    label: "Transfusion: packed red cells 20 ml/kg",
    icon: "pi pi-plus",
    help: `${ML(20)} ml over 1 min of model time (a fresh unit, Hb 12 mmol/l, SO₂ 60 %).`,
    requires: ["Fluids"],
    ops: [call("Fluids.add_volume", ML(20), 60, "packed_cells", "VLB")],
  },
  ventilate: {
    id: "ventilate",
    kind: "button",
    label: "Intubate and ventilate (SLE6000)",
    icon: "pi pi-play",
    help: "CMV, PIP 15, PEEP 5, rate 40, Ti 0.35 s, O₂ 21 %. Spontaneous breathing stops (sedated). Change the settings on the SLE6000 tab.",
    requires: ["Ventilator", "Breathing"],
    ops: [
      call("Breathing.switch_breathing", false),
      call("Ventilator.set_tube_position", "trachea"),
      call("Ventilator.set_circuit_connected", true),
      call("Ventilator.sle_apply", { mode: "CMV", pip: 15, peep: 5, rr: 40, ti: 0.35, o2: 21 }),
    ],
  },
  extubate: {
    id: "extubate",
    kind: "button",
    label: "Extubate",
    icon: "pi pi-stop",
    help: "Ventilator to standby; the baby breathes again.",
    requires: ["Ventilator", "Breathing"],
    ops: [call("Ventilator.sle_standby"), call("Breathing.switch_breathing", true)],
  },
  // VA-ECMO with the scenario's own circuit (PediMag pump, Quadrox-i Neonatal, drainage RA,
  // return aortic arch). Checked headlessly in the weak heart (contractility x0.3): 2500 rpm
  // ~137 ml/kg/min, MAP 43 -> 57, SvO2 62 -> 83 %; from ~3000 rpm the LV stops ejecting
  // (pulse pressure 2, LV EDP 9 -> 15): LV distension
  ecmo_start: {
    id: "ecmo_start",
    kind: "button",
    label: "Start VA-ECMO",
    icon: "pi pi-play",
    help: "Drainage right atrium, return aortic arch; 2500 rpm (~135 ml/kg/min), sweep gas 0.5 l/min with 60 % O₂. Supports the circulation and oxygenation.",
    requires: ["Ecls"],
    ops: [
      { kind: "set", path: "Ecls.cannulation", value: "VA" },
      { kind: "set", path: "Ecls.gas_fio2", value: 0.6, it: 1 },
      { kind: "set", path: "Ecls.gas_flow", value: 0.5, it: 1 },
      { kind: "set", path: "Ecls.pump_rpm", value: 2500, it: 1 },
      { kind: "set", path: "Ecls.ecls_clamped", value: false },
      { kind: "set", path: "Ecls.ecls_running", value: true },
    ],
  },
  // VV-ECMO through the double-lumen cannula in the right atrium. Headless in severe PPHN
  // (1 h baby, PVR x5): 3000 rpm ~137 ml/kg/min, SaO2 pre/post 60/37 -> 91/85 %, SvO2 31 -> 84 %,
  // MAP, LV output and PAP unchanged: VV supports oxygenation, not the circulation
  ecmo_vv_start: {
    id: "ecmo_vv_start",
    kind: "button",
    label: "Start VV-ECMO",
    icon: "pi pi-play",
    help: "Double-lumen cannula in the right atrium; 3000 rpm (~135 ml/kg/min), sweep gas 0.5 l/min with 100 % O₂. Oxygenates; does not support the circulation.",
    requires: ["Ecls"],
    ops: [
      { kind: "set", path: "Ecls.cannulation", value: "VV-DL" },
      { kind: "set", path: "Ecls.gas_fio2", value: 1.0, it: 1 },
      { kind: "set", path: "Ecls.gas_flow", value: 0.5, it: 1 },
      { kind: "set", path: "Ecls.pump_rpm", value: 3000, it: 1 },
      { kind: "set", path: "Ecls.ecls_clamped", value: false },
      { kind: "set", path: "Ecls.ecls_running", value: true },
    ],
  },
  ecmo_rpm: {
    id: "ecmo_rpm",
    kind: "slider",
    label: "ECMO pump speed",
    help: "Higher speed = more ECMO flow and more afterload for the left ventricle.",
    requires: ["Ecls"],
    read: "Ecls.pump_rpm",
    min: 0,
    max: 4000,
    step: 100,
    unit: " rpm",
    it: 4,
  },
  ecmo_stop: {
    id: "ecmo_stop",
    kind: "button",
    label: "Stop ECMO",
    icon: "pi pi-stop",
    requires: ["Ecls"],
    ops: [
      { kind: "set", path: "Ecls.ecls_running", value: false },
      { kind: "set", path: "Ecls.ecls_clamped", value: true },
    ],
  },
  contractility: scaleSlider("contractility", "Contractility", "heart_el_max", "LV.el_max_factor_scaling_ps", 20, 300,
    "Both ventricles and atria. 100 % = normal."),
  diastolic_function: scaleSlider("diastolic_function", "Diastolic function", "heart_el_min", "LV.el_min_factor_scaling_ps", 20, 200,
    "Inverse of the passive diastolic stiffness. 100 % = normal, 50 % = twice as stiff.", true),
  svr: scaleSlider("svr", "Systemic vascular resistance", "systemic_resistances", "AA.r_factor_scaling_ps", 20, 500,
    "All systemic vessels. 100 % = normal."),
  pvr: scaleSlider("pvr", "Pulmonary vascular resistance", "pulmonary_resistances", "PA.r_factor_scaling_ps", 20, 1000,
    "All pulmonary vessels. 100 % = normal."),
};

export default defineLesson({
  id: "neonatal-shock",
  title: "Neonatal shock",
  subtitle: "Treat the target, not the label",
  lang: "en",
  scenario: "term_neonate_72h",
  controls: [
    "saline", "transfusion", "contractility", "diastolic_function", "svr", "pvr", "ductus", "foramen_ovale",
    "ventilate", "extubate", "ecmo_start", "ecmo_vv_start", "ecmo_rpm", "ecmo_stop",
  ],
  ventilatorStopsBreathing: true,
  interventions: INTERVENTIONS,
  layout: {
    centre: ["diagram", "sle6000"],
    tasks: { categories: ["vascular_tone", "cardiac_performance", "rate_rhythm", "shunts", "blood_acidbase"] },
  },
  monitorLanes: ["ecg", "spo2_pre", "spo2_post", "abp"],
  numerics: [
    {
      key: "pressure",
      title: "Pressures",
      parameters: [
        num("MAP", "Monitor.minmax.abp_pres_mean", "mmHg"),
        num("CVP", "Monitor.minmax.cvp_pres_mean", "mmHg"),
        num("PAP", ["Monitor.minmax.pap_pres_max", "Monitor.minmax.pap_pres_min"], "mmHg"),
        num("LV EDP", "Heart.lv_edp", "mmHg", 1),
        num("RV EDP", "Heart.rv_edp", "mmHg", 1),
      ],
    },
    {
      key: "flow",
      title: "Flow",
      parameters: [
        perKg("LV stroke volume", "Heart.lv_sv", "ml/kg", 2),
        perKg("LV output", "Monitor.flows.lvo", "ml/kg/min"),
        perKg("RV output", "Monitor.flows.rvo", "ml/kg/min"),
        perKg("Duct (+ = L→R)", "Monitor.flows.da_flow", "ml/kg/min"),
        perKg("Foramen ovale (+ = L→R)", "Monitor.fo_flow", "ml/kg/min"),
        perKg("ECMO flow", "Ecls.flow_avg", "ml/kg/min"),
      ],
    },
    {
      key: "oxygen",
      title: "Oxygen balance",
      parameters: [
        num("SvO₂ (mixed venous)", "Monitor.svo2", "%"),
        // regional delivery = regional flow × arterial O2 content (Monitor). The lower body is an
        // estimate: renal flow × 4 with the descending-aorta content (post-ductal), not a measured flow
        num("DO₂ brain", "Monitor.do2_br", "ml O₂/min"),
        num("DO₂ lower body (est.)", "Monitor.do2_lb", "ml O₂/min"),
      ],
    },
    {
      // arterial blood gas with electrolytes, from the ascending aorta (pre-ductal)
      key: "labs",
      title: "Labs (arterial)",
      parameters: [
        num("pH", "AA.ph", "", 2),
        num("pCO₂", "AA.pco2", "kPa", 1, 0.1333),
        num("pO₂", "AA.po2", "kPa", 1, 0.1333),
        num("HCO₃⁻", "AA.hco3", "mmol/l", 1),
        num("BE", "AA.be", "mmol/l", 1),
        num("SaO₂", "AA.so2", "%"),
        num("Hb", "AA.solutes.hemoglobin", "mmol/l", 1),
        num("Lactate", "Lactate.arterial_lactate", "mmol/l", 1),
        num("Glucose", "AA.solutes.glucose", "mmol/l", 1),
        num("Na⁺", "AA.solutes.na", "mmol/l"),
        num("K⁺", "AA.solutes.k", "mmol/l", 1),
        num("Cl⁻", "AA.solutes.cl", "mmol/l"),
        num("Ca²⁺ (ionised)", "AA.solutes.ca", "mmol/l", 2),
      ],
    },
    {
      key: "fluid",
      title: "Fluid",
      parameters: [
        perKg("Blood volume", "Circulation.total_blood_volume", "ml/kg"),
        num("Interstitial fluid", "Interstitium.isf_volume_ml_kg", "ml/kg"),
      ],
    },
  ],
  steps: [
    {
      id: "intro",
      title: "Shock is an oxygen-delivery problem",
      highlight: ["Monitor.svo2", "Monitor.flows.lvo", "Heart.lv_sv"],
    },
    ...introSteps(),
    {
      id: "hypovolaemic",
      title: "Hypovolaemic shock",
      onEnter: NEWBORN,
      highlight: ["Monitor.minmax.abp_pres_mean", "Monitor.minmax.cvp_pres_mean", "Monitor.svo2", "Monitor.do2_br", "Monitor.do2_lb", "Monitor.flows.da_flow"],
      actions: [
        {
          id: "bleed",
          label: "Subgaleal bleed: 35 % of blood volume over 2 min",
          icon: "pi pi-exclamation-triangle",
          severity: "danger",
          ops: [call("Fluids.remove_volume", ML(85 * 0.35), 120, "AD")],
          duration: 120,
        },
        wait(2),
        {
          id: "bolus",
          label: "Bolus NaCl 0.9 % 20 ml/kg",
          icon: "pi pi-plus",
          ops: [bolus(20)],
          duration: 60,
        },
        {
          // back to the moment the saline was given (bleed done + 2 min), computed at once
          id: "replay",
          label: "Repeat the bleed (reset, bleed 35 %, wait 2 min)",
          icon: "pi pi-replay",
          severity: "secondary",
          ops: [...NEWBORN, call("Fluids.remove_volume", ML(85 * 0.35), 120, "AD"), { kind: "calculate", seconds: 240 }],
        },
        {
          id: "transfuse",
          label: "Transfuse packed red cells 20 ml/kg",
          icon: "pi pi-plus",
          ops: [call("Fluids.add_volume", ML(20), 60, "packed_cells", "VLB")],
          duration: 60,
        },
        again(NEWBORN),
      ],
    },
    {
      id: "distributive",
      title: "Distributive shock and capillary leak",
      onEnter: TERM,
      highlight: ["Monitor.minmax.abp_pres_mean", "Monitor.flows.lvo", "Circulation.total_blood_volume", "Interstitium.isf_volume_ml_kg"],
      actions: [
        {
          id: "sepsis",
          label: "Sepsis: vasodilation + capillary leak",
          icon: "pi pi-exclamation-triangle",
          severity: "danger",
          ops: [
            { kind: "scale", group: "systemic_resistances", factor: 0.5 },
            { kind: "set", path: "Interstitium.kf_factor_ps", value: 10, it: 5 },
            { kind: "set", path: "Interstitium.sigma", value: 0.5, it: 5 },
          ],
        },
        {
          id: "bolus",
          label: "Bolus NaCl 0.9 % 20 ml/kg",
          icon: "pi pi-plus",
          ops: [bolus(20)],
          duration: 60,
        },
        wait(2),
        {
          id: "noradrenaline",
          label: "Noradrenaline 0.3 mcg/kg/min",
          icon: "pi pi-plus",
          ops: [infusion("noradrenaline", 0.3)],
        },
        again(TERM),
      ],
    },
    {
      id: "cardiogenic-systolic",
      title: "Cardiogenic shock: the weak heart",
      onEnter: TERM,
      highlight: ["Heart.lv_sv", "Heart.lv_edp", "Monitor.minmax.cvp_pres_mean", "Monitor.svo2"],
      actions: [
        {
          id: "depress",
          label: "Myocardial depression: contractility ×0.4",
          icon: "pi pi-exclamation-triangle",
          severity: "danger",
          ops: [{ kind: "scale", group: "heart_el_max", factor: 0.4 }],
        },
        {
          id: "bolus",
          label: "Bolus NaCl 0.9 % 10 ml/kg",
          icon: "pi pi-plus",
          ops: [bolus(10)],
          duration: 60,
        },
        {
          id: "adrenaline",
          label: "Adrenaline 0.1 mcg/kg/min",
          icon: "pi pi-plus",
          ops: [infusion("adrenaline", 0.1)],
        },
        again(TERM),
      ],
    },
    {
      id: "cardiogenic-diastolic",
      title: "Cardiogenic shock: the stiff heart",
      onEnter: TERM,
      highlight: ["Heart.lv_edp", "Heart.lv_sv", "Monitor.flows.lvo", "Monitor.minmax.cvp_pres_mean"],
      actions: [
        {
          id: "stiffen",
          label: "Stiff ventricles: diastolic stiffness ×3",
          icon: "pi pi-exclamation-triangle",
          severity: "danger",
          ops: [{ kind: "scale", group: "heart_el_min", factor: 3 }],
        },
        {
          id: "bolus",
          label: "Bolus NaCl 0.9 % 10 ml/kg",
          icon: "pi pi-plus",
          ops: [bolus(10)],
          duration: 60,
        },
        {
          id: "hr-160",
          label: "Heart rate 160",
          icon: "pi pi-arrow-up",
          ops: [{ kind: "set", path: "Heart.heart_rate_ref", value: 160, it: 5 }],
        },
        {
          id: "hr-100",
          label: "Heart rate 100",
          icon: "pi pi-arrow-down",
          ops: [{ kind: "set", path: "Heart.heart_rate_ref", value: 100, it: 5 }],
        },
        again(TERM),
      ],
    },
    {
      id: "pphn",
      title: "PPHN, the right ventricle and the duct",
      onEnter: TRANSITION,
      highlight: ["Monitor.flows.da_flow", "Monitor.fo_flow", "Heart.rv_edp", "Monitor.do2_lb"],
      monitorHighlight: ["spo2_pre", "spo2_post"],
      diagramHighlight: ["DA", "FO"],
      controls: ["ductus"],
      actions: [
        {
          id: "pphn",
          label: "PPHN: PVR ×3",
          icon: "pi pi-exclamation-triangle",
          severity: "danger",
          ops: [{ kind: "scale", group: "pulmonary_resistances", factor: 3 }],
        },
        {
          id: "noradrenaline",
          label: "Noradrenaline 0.3 mcg/kg/min",
          icon: "pi pi-plus",
          ops: [infusion("noradrenaline", 0.3)],
        },
        {
          id: "lower-pvr",
          label: "Lower PVR (oxygen / iNO): PVR ×1.5",
          icon: "pi pi-arrow-down",
          ops: [{ kind: "scale", group: "pulmonary_resistances", factor: 1.5 }],
        },
        {
          id: "severe",
          label: "Severe PPHN: PVR ×5",
          icon: "pi pi-exclamation-triangle",
          severity: "danger",
          ops: [{ kind: "scale", group: "pulmonary_resistances", factor: 5 }],
        },
        {
          id: "close-duct",
          label: "Close the duct",
          icon: "pi pi-times",
          severity: "danger",
          ops: [{ kind: "control", id: "ductus", state: "off" }],
        },
        wait(2),
        again(TRANSITION),
      ],
    },
    {
      id: "summary",
      title: "Summary: treat the target",
    },
  ],
});
