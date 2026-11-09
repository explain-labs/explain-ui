import { defineLesson, type LessonAction, type LessonNumeric, type Op } from "@/lessons/types";
import { introSteps } from "@/lessons/_shared/intro";

// Neonatal shock by treatment target: four building blocks (hypovolaemic, distributive with
// capillary leak, cardiogenic systolic/diastolic, PPHN with the duct) on the term neonate, for a
// one-hour plenary session with fellows following on their own laptops. English only.
//
// Doses and factors were checked headlessly on the shipped scenarios before use (term_neonate_72h:
// 3.545 kg, blood volume 85 ml/kg = 301 ml; term_neonate_1h for the PPHN step). Two settings are
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

export default defineLesson({
  id: "neonatal-shock",
  title: "Neonatal shock",
  subtitle: "Treat the target, not the label",
  lang: "en",
  scenario: "term_neonate_72h",
  controls: ["ductus"],
  layout: {
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
        num("Hb", "AA.solutes.hemoglobin", "mmol/l", 1),
        num("Lactate", "Lactate.arterial_lactate", "mmol/l", 1),
        num("pH", "AA.ph", "", 2),
        num("BE", "AA.be", "mmol/l", 1),
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
      onEnter: TERM,
      highlight: ["Monitor.minmax.abp_pres_mean", "Monitor.minmax.cvp_pres_mean", "Monitor.svo2", "Monitor.do2_br", "Monitor.do2_lb"],
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
          id: "transfuse",
          label: "Transfuse packed red cells 20 ml/kg",
          icon: "pi pi-plus",
          ops: [call("Fluids.add_volume", ML(20), 60, "packed_cells", "VLB")],
          duration: 60,
        },
        again(TERM),
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
