import { defineLesson, type ExperimentSpec, type LessonNumeric, type LessonStep } from "@/lessons/types";
import { introSteps } from "@/lessons/_shared/intro";
import experimentsJson from "@explain/papers/p1/experiments.json";

// Paper companion for P1, the cardiovascular paper: what the paper describes,
// and its four validation experiments, runnable here. The experiments come
// from the engine (explain-engine/papers/p1/experiments.json), the same file
// `node scripts/probe_p1.mjs` runs, so the numbers shown are the probe's.

const perKg = (label: LessonNumeric["label"], path: string): LessonNumeric => ({
  label,
  props: [path],
  unit: "ml/kg/min",
  factor: 1000,
  rounding: 0,
  weight_based: true,
});
const mmHg = (label: LessonNumeric["label"], props: string[]): LessonNumeric => ({
  label,
  props,
  unit: "mmHg",
  rounding: 0,
});

// the JSON's `kind` fields type as plain strings; the file is the engine's and
// the ops are validated by the probe, so cast once here
const experiments = experimentsJson as unknown as ExperimentSpec;

// the Doppler lane: the paper's Eq. 12 velocity (continuity, pulmonary end)
// beside the Bernoulli jet a CW Doppler reads; + = left-to-right
const DOPPLER = {
  paths: ["Pda.velocity_pa", "Pda.velocity_doppler"],
  title: { en: "Ductal velocity (m/s): Eq. 12 · Doppler jet", nl: "Ductussnelheid (m/s): vgl. 12 · Doppler-jet" },
  yMin: -1.5,
  yMax: 1.5,
  fill: true,
  windowS: 3,
};

// one step per experiment: the step's markdown explains the paper's case, the
// table under it runs and compares it
const experiment = (id: string, title: LessonStep["title"], extra: Partial<LessonStep> = {}): LessonStep => ({
  id,
  title,
  experiment: id,
  ...extra,
});

export default defineLesson({
  id: "p1",
  kind: "paper",
  title: {
    en: "An integrated model for simulation of neonatal physiology — the cardiovascular system",
    nl: "Een geïntegreerd model voor de simulatie van neonatale fysiologie — het cardiovasculaire systeem",
  },
  subtitle: { en: "Antonius, van Meurs, Westerhof, de Boode · Pediatric Research", nl: "Antonius, van Meurs, Westerhof, de Boode · Pediatric Research" },
  scenario: "term_neonate",
  experiments,
  references: Object.entries(experiments.references).map(([id, text]) => ({ id, text })),
  controls: ["ductus", "foramen_ovale"],
  monitorLanes: ["ecg", "abp", "spo2_pre", "spo2_post"],
  layout: { reading: true },
  numerics: [
    {
      key: "haemodynamics",
      title: { en: "Haemodynamics", nl: "Hemodynamiek" },
      parameters: [
        { label: { en: "Heart rate", nl: "Hartfrequentie" }, props: ["Heart.heart_rate"], unit: "/min", rounding: 0 },
        mmHg({ en: "ABP (AA)", nl: "ABP (AA)" }, ["Monitor.minmax.abp_pre_pres_max", "Monitor.minmax.abp_pre_pres_min"]),
        mmHg({ en: "PAP", nl: "PAP" }, ["Monitor.minmax.pap_pres_max", "Monitor.minmax.pap_pres_min"]),
        mmHg({ en: "PAP mean", nl: "PAP gemiddeld" }, ["Monitor.minmax.pap_pres_mean"]),
        mmHg({ en: "LA pressure", nl: "LA-druk" }, ["Monitor.minmax.la_pres_mean"]),
      ],
    },
    {
      key: "flows",
      title: { en: "Flows", nl: "Stroming" },
      parameters: [
        perKg({ en: "LV output", nl: "LV-output" }, "Monitor.flows.lvo"),
        perKg({ en: "RV output", nl: "RV-output" }, "Monitor.flows.rvo"),
        perKg({ en: "SVC flow", nl: "SVC-flow" }, "Monitor.flows.svc_flow"),
        perKg({ en: "Duct (+ = L→R)", nl: "Ductus (+ = L→R)" }, "Monitor.flows.da_flow"),
        perKg({ en: "Foramen ovale (+ = L→R)", nl: "Foramen ovale (+ = L→R)" }, "Monitor.fo_flow"),
      ],
    },
  ],
  steps: [
    { id: "about", title: { en: "About this page", nl: "Over deze pagina" } },
    {
      id: "conceptual-model",
      title: { en: "The conceptual model (§2.1)", nl: "Het conceptuele model (§2.1)" },
      image: { file: "fig1_blockdiagram.svg", caption: { en: "Fig. 1 of the paper: the integrated cardiorespiratory model.", nl: "Fig. 1 van het artikel: het geïntegreerde cardiorespiratoire model." } },
    },
    {
      id: "hydraulic-circuit",
      title: { en: "The hydraulic circuit (§2.1, Fig. 2)", nl: "Het hydraulische circuit (§2.1, fig. 2)" },
      image: { file: "fig2_circuit.svg", caption: { en: "Fig. 2 of the paper. The live diagram beside it is the same circuit.", nl: "Fig. 2 van het artikel. Het diagram ernaast is hetzelfde circuit." } },
      diagramHighlight: ["DA", "FO", "LV", "RV"],
    },
    { id: "mathematical-model", title: { en: "The mathematical model (§2.2)", nl: "Het wiskundige model (§2.2)" } },
    ...introSteps(),
    experiment("baseline", { en: "Baseline haemodynamics (§3.1.1, Table 2)", nl: "Hemodynamiek in rust (§3.1.1, tabel 2)" }, {
      highlight: ["Monitor.flows.lvo", "Monitor.minmax.abp_pre_pres_max"],
    }),
    { id: "pda-setup", title: { en: "The PDA experiments (§3.1.2)", nl: "De PDA-experimenten (§3.1.2)" } },
    experiment("pda_none", { en: "Table 3: no ductal shunt", nl: "Tabel 3: geen ductusshunt" }, { highlight: ["Monitor.flows.lvo", "Monitor.flows.rvo"], diagramHighlight: ["DA"] }),
    experiment("pda_bidirectional", { en: "Table 3: bidirectional shunt", nl: "Tabel 3: bidirectionele shunt" }, { highlight: ["Monitor.flows.da_flow"], diagramHighlight: ["DA"], chart: DOPPLER }),
    experiment("pda_ltr", { en: "Table 3: left-to-right shunt", nl: "Tabel 3: links-rechtsshunt" }, { highlight: ["Monitor.flows.da_flow", "Monitor.flows.lvo"], diagramHighlight: ["DA"], chart: DOPPLER }),
    { id: "doppler-setup", title: { en: "Ductal Doppler patterns (§3.1.2, Fig. 5)", nl: "Doppler-patronen van de ductus (§3.1.2, fig. 5)" } },
    experiment("doppler_nonrestrictive", { en: "Fig. 5: non-restrictive left-to-right", nl: "Fig. 5: niet-restrictief links-rechts" }, { chart: DOPPLER, diagramHighlight: ["DA"] }),
    experiment("doppler_restrictive", { en: "Fig. 5: restrictive left-to-right", nl: "Fig. 5: restrictief links-rechts" }, { chart: DOPPLER, diagramHighlight: ["DA"] }),
    experiment("doppler_bidirectional", { en: "Fig. 5: bidirectional", nl: "Fig. 5: bidirectioneel" }, { chart: DOPPLER, diagramHighlight: ["DA"] }),
    { id: "ph-setup", title: { en: "The pulmonary-hypertension experiments (§3.1.3)", nl: "De pulmonale-hypertensie-experimenten (§3.1.3)" } },
    experiment("ph_early", { en: "Table 4: early pulmonary hypertension", nl: "Tabel 4: vroege pulmonale hypertensie" }, { highlight: ["Monitor.minmax.pap_pres_max"] }),
    experiment("ph_severe", { en: "Table 4: severe, no duct", nl: "Tabel 4: ernstig, zonder ductus" }, { highlight: ["Monitor.minmax.pap_pres_max", "Monitor.flows.lvo"] }),
    experiment("ph_severe_pda", { en: "Table 4: severe, with a patent duct", nl: "Tabel 4: ernstig, met open ductus" }, { highlight: ["Monitor.flows.da_flow", "Monitor.minmax.pap_pres_max"], diagramHighlight: ["DA"], chart: DOPPLER }),
    {
      id: "limitations",
      title: { en: "Where this engine differs from the paper", nl: "Waar deze engine afwijkt van het artikel" },
      actions: [
        { id: "restart", label: { en: "Restart from the term baseline", nl: "Opnieuw vanaf de à terme uitgangssituatie" }, icon: "pi pi-refresh", severity: "secondary", ops: [{ kind: "restart" }] },
      ],
    },
  ],
});
