import { defineLesson, type LessonNumeric } from "@/lessons/types";
import { introSteps } from "@/lessons/_shared/intro";

// Beat-averaged flow read-outs from the Monitor (L/min → ml/kg/min), matching
// the scenario's own configuration.monitors definitions.
const flow = (label: LessonNumeric["label"], path: string): LessonNumeric => ({
  label,
  props: [path],
  unit: "ml/kg/min",
  factor: 1000,
  rounding: 0,
  weight_based: true,
});

export default defineLesson({
  id: "tof",
  title: { nl: "Tetralogie van Fallot", en: "Tetralogy of Fallot" },
  subtitle: {
    nl: "Ernstige vorm: ductusafhankelijke longdoorbloeding",
    en: "Severe form: duct-dependent pulmonary blood flow",
  },
  scenario: "tof_severe",
  controls: ["ductus", "foramen_ovale", "rvot"],
  monitorLanes: ["ecg", "spo2_pre", "spo2_post", "abp"],
  numerics: [
    // HR, SpO₂ and ABP are on the bedside monitor above, so only flows here
    {
      key: "flows",
      title: { nl: "Stroming", en: "Flows" },
      parameters: [
        flow({ nl: "RVOT", en: "RVOT" }, "Monitor.flows.rvo"),
        flow({ nl: "Ductus", en: "Duct" }, "Monitor.flows.da_flow"),
        flow({ nl: "Foramen ovale", en: "Foramen ovale" }, "Monitor.fo_flow"),
        flow({ nl: "LV-output", en: "LV output" }, "Monitor.flows.lvo"),
      ],
    },
  ],
  steps: [
    ...introSteps(),
    {
      id: "baseline",
      title: { nl: "Anatomie en uitgangssituatie", en: "Anatomy and baseline" },
      highlight: ["Monitor.flows.rvo", "Monitor.flows.da_flow"],
      // the four ToF features as they appear in the diagram
      diagramHighlight: ["VSD", "RV_AA", "RV_PA", "DA"],
      diagramLabels: {
        RV_AA: { nl: "Overrijdende aorta", en: "Overriding aorta" },
        RV_PA: { nl: "RVOT-obstructie", en: "RVOT obstruction" },
      },
    },
    {
      id: "duct-dependent",
      title: { nl: "Ductusafhankelijke longdoorbloeding", en: "Duct-dependent pulmonary flow" },
      highlight: ["Monitor.flows.da_flow", "Monitor.flows.rvo"],
      diagramHighlight: ["DA"],
      monitorHighlight: ["spo2_pre", "spo2_post"],
      controls: ["ductus"],
      actions: [
        {
          id: "close-duct",
          label: { nl: "Sluit de ductus", en: "Close the duct" },
          icon: "pi pi-times-circle",
          severity: "danger",
          ops: [{ kind: "control", id: "ductus", state: "off" }],
        },
      ],
    },
    {
      id: "reopen",
      title: { nl: "De ductus heropenen", en: "Reopening the duct" },
      highlight: ["Monitor.flows.da_flow"],
      diagramHighlight: ["DA"],
      monitorHighlight: ["spo2_pre", "spo2_post"],
      controls: ["ductus"],
      actions: [
        {
          id: "open-duct",
          label: { nl: "Open de ductus", en: "Open the duct" },
          icon: "pi pi-check-circle",
          severity: "success",
          ops: [{ kind: "control", id: "ductus", state: "on" }],
        },
      ],
    },
    {
      id: "foramen-ovale",
      title: { nl: "De rol van het foramen ovale", en: "The role of the foramen ovale" },
      highlight: ["Monitor.fo_flow"],
      diagramHighlight: ["FO"],
      controls: ["foramen_ovale"],
      // the duct back open first (the learner may have left it closed)
      onEnter: [{ kind: "control", id: "ductus", state: "on" }],
      actions: [
        {
          id: "close-fo",
          label: { nl: "Sluit het foramen ovale", en: "Close the foramen ovale" },
          icon: "pi pi-times-circle",
          severity: "secondary",
          ops: [{ kind: "control", id: "foramen_ovale", state: "off" }],
        },
        {
          id: "open-fo",
          label: { nl: "Open het foramen ovale", en: "Open the foramen ovale" },
          icon: "pi pi-check-circle",
          severity: "secondary",
          ops: [{ kind: "control", id: "foramen_ovale", state: "on" }],
        },
        {
          // 6 mm of the 10 mm maximum: a large atrial communication, as after a septostomy
          id: "widen-fo",
          label: { nl: "Maak het foramen ovale groot (6 mm)", en: "Make the foramen ovale large (6 mm)" },
          icon: "pi pi-arrows-h",
          severity: "secondary",
          ops: [{ kind: "control", id: "foramen_ovale", state: 6 }],
        },
      ],
    },
    {
      id: "rvot-dilatation",
      title: { nl: "Ballondilatatie van de RVOT", en: "Balloon dilatation of the RVOT" },
      highlight: ["Monitor.flows.rvo", "Monitor.flows.da_flow"],
      diagramHighlight: ["RV_PA", "DA"],
      diagramLabels: { RV_PA: { nl: "RVOT", en: "RVOT" } },
      monitorHighlight: ["spo2_pre"],
      controls: ["rvot", "ductus"],
      // start from the PGE1 state: the duct open, the foramen ovale and the RVOT as in the scenario
      onEnter: [
        { kind: "control", id: "ductus", state: "on" },
        { kind: "control", id: "foramen_ovale", state: "on" },
      ],
      actions: [
        {
          id: "dilate-rvot",
          label: { nl: "Dilateer de RVOT", en: "Dilate the RVOT" },
          icon: "pi pi-expand",
          severity: "success",
          ops: [{ kind: "control", id: "rvot", state: "on" }],
        },
        {
          id: "close-duct-after",
          label: { nl: "Sluit nu de ductus", en: "Now close the duct" },
          icon: "pi pi-times-circle",
          severity: "danger",
          ops: [{ kind: "control", id: "ductus", state: "off" }],
        },
      ],
    },
    {
      // needs the tet-spell / knee-chest / FiO₂ interventions first
      id: "tet-spell",
      title: { nl: "Cyanotische aanval (tet spell)", en: "Cyanotic spell (tet spell)" },
      draft: true,
      highlight: ["Monitor.flows.rvo"],
    },
    {
      id: "summary",
      title: { nl: "Samenvatting", en: "Summary" },
      actions: [
        {
          id: "restart",
          label: { nl: "Opnieuw beginnen", en: "Start again" },
          icon: "pi pi-refresh",
          severity: "secondary",
          ops: [{ kind: "restart" }],
        },
      ],
    },
  ],
});
