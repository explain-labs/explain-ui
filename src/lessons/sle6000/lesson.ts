import { defineLesson, type LessonNumeric, type Op } from "@/lessons/types";

// Learn the SLE6000, then play with it: a ventilated term neonate, the device
// replica in the centre, and the lung-mechanics / tube / airway-event Common
// tasks on the left to give the ventilator problems to react to. The blood gas
// and etCO2 are live on the right.

const kpa = (label: LessonNumeric["label"], path: string): LessonNumeric => ({
  label,
  props: [path],
  unit: "kPa",
  factor: 0.1333,
  rounding: 1,
});

// the ventilator settings every step starts from
const CMV = { mode: "CMV", pip: 15, peep: 5, rr: 40, ti: 0.35, o2: 21, vtv: 0 };
const LUNGS = ["left_lung_elastances", "right_lung_elastances"];

// A clean patient on CMV. Going back a step doesn't undo, so each practical step
// starts here: tube in the trachea, circuit and probe connected, airways open, no
// atelectasis, no leak, normal tube and lungs, no own breathing.
const reset = (settings: Record<string, unknown> = CMV): Op[] => [
  { kind: "call", fn: "Breathing.switch_breathing", args: [false] },
  { kind: "call", fn: "Ventilator.set_tube_position", args: ["trachea"] },
  { kind: "call", fn: "Ventilator.set_circuit_connected", args: [true] },
  { kind: "call", fn: "Ventilator.set_spo2_probe", args: [true] },
  { kind: "call", fn: "Ventilator.set_ettube_diameter", args: [3.5] },
  { kind: "set", path: "Ventilator.leak_size", value: 0, it: 1 },
  { kind: "set", path: "VENT_ETTUBE.r_factor_ps", value: 1, it: 1 },
  { kind: "call", fn: "Respiration.set_airway_obstructed_left", args: [false] },
  { kind: "call", fn: "Respiration.set_airway_obstructed_right", args: [false] },
  { kind: "call", fn: "Respiration.set_atelectasis_left", args: [0] },
  { kind: "call", fn: "Respiration.set_atelectasis_right", args: [0] },
  { kind: "scale", group: LUNGS, factor: 1 },
  { kind: "call", fn: "Ventilator.sle_oxygenie", args: [false] },
  { kind: "call", fn: "Ventilator.sle_apply", args: [settings] },
];

// the alveolar gas of both lungs in the diagram
const ALVEOLI = { LUNG: { nl: "Longen (alveoli)", en: "Lungs (alveoli)" } };

const call = (fn: string, ...args: unknown[]): Op => ({ kind: "call", fn, args });

export default defineLesson({
  id: "sle6000",
  title: { nl: "De SLE6000-beademingsmachine", en: "The SLE6000 ventilator" },
  subtitle: {
    nl: "Leer het apparaat kennen en zie hoe het reageert op problemen",
    en: "Get to know the device and see how it reacts to problems",
  },
  scenario: "term_neonate",
  controls: [],
  layout: {
    centre: ["sle6000", "diagram"],
    tasks: { categories: ["lung_mechanics", "ventilator", "airway_events"] },
  },
  monitorLanes: ["ecg", "spo2_pre", "co2", "abp"],
  numerics: [
    {
      key: "bloodgas",
      title: { nl: "Bloedgas (arterieel)", en: "Blood gas (arterial)" },
      parameters: [
        { label: "pH", props: ["AA.ph"], rounding: 2 },
        kpa("pCO₂", "AA.pco2"),
        kpa("pO₂", "AA.po2"),
        { label: "HCO₃⁻", props: ["AA.hco3"], unit: "mmol/l", rounding: 0 },
        { label: "BE", props: ["AA.be"], unit: "mmol/l", rounding: 1 },
        { label: { nl: "Lactaat", en: "Lactate" }, props: ["Lactate.arterial_lactate"], unit: "mmol/l", rounding: 1 },
        { label: "SaO₂", props: ["AA.so2"], unit: "%", rounding: 0 },
      ],
    },
    {
      key: "ventilation",
      title: { nl: "Ventilatie", en: "Ventilation" },
      parameters: [kpa("etCO₂", "Monitor.etco2")],
    },
  ],
  steps: [
    {
      id: "screen-tour",
      title: { nl: "Het scherm", en: "The screen" },
      centreTab: "sle6000",
    },
    {
      id: "start-cmv",
      title: { nl: "Beademing starten", en: "Starting ventilation" },
      centreTab: "sle6000",
      monitorHighlight: ["co2"],
      actions: [
        {
          id: "start",
          label: { nl: "Intubeer en start CMV", en: "Intubate and start CMV" },
          icon: "pi pi-play",
          severity: "success",
          ops: reset(),
        },
      ],
    },
    {
      id: "pip-and-rate",
      title: { nl: "PIP, frequentie en CO₂", en: "PIP, rate and CO₂" },
      centreTab: "sle6000",
      onEnter: reset(),
      highlight: ["AA.pco2", "Monitor.etco2"],
      monitorHighlight: ["co2"],
    },
    {
      id: "peep-and-oxygen",
      title: { nl: "PEEP en zuurstof", en: "PEEP and oxygen" },
      centreTab: "sle6000",
      onEnter: reset(),
      highlight: ["AA.po2", "AA.so2"],
      monitorHighlight: ["spo2_pre"],
    },
    {
      id: "triggered-modes",
      title: { nl: "Getriggerde modi", en: "Triggered modes" },
      centreTab: "sle6000",
      onEnter: [...reset({ ...CMV, mode: "PTV" }), call("Breathing.switch_breathing", true)],
    },
    {
      id: "hfo",
      title: { nl: "Hoogfrequente oscillatie", en: "High-frequency oscillation" },
      centreTab: "sle6000",
      onEnter: reset(),
      highlight: ["AA.pco2"],
      actions: [
        {
          id: "to-hfo",
          label: { nl: "Schakel naar HFO", en: "Switch to HFO" },
          icon: "pi pi-wave-pulse",
          ops: [call("Ventilator.sle_apply", { mode: "HFOV", map: 8, dp: 25, freq: 10, ie: 1 })],
        },
        {
          id: "back-cmv",
          label: { nl: "Terug naar CMV", en: "Back to CMV" },
          icon: "pi pi-undo",
          severity: "secondary",
          ops: [call("Ventilator.sle_apply", CMV)],
        },
      ],
    },
    {
      id: "stiff-lungs",
      title: { nl: "Stijve longen", en: "Stiff lungs" },
      centreTab: "sle6000",
      onEnter: reset(),
      highlight: ["AA.pco2", "Monitor.etco2"],
      actions: [
        {
          id: "stiff",
          label: { nl: "Halveer de compliantie", en: "Halve the compliance" },
          icon: "pi pi-exclamation-triangle",
          severity: "danger",
          ops: [{ kind: "scale", group: LUNGS, factor: 2 }],
        },
        {
          id: "vtv",
          label: { nl: "Zet volumegarantie aan (VTV 18 ml)", en: "Turn on volume targeting (VTV 15 ml)" },
          icon: "pi pi-sliders-h",
          ops: [call("Ventilator.sle_apply", { vtv: 30, pip: 30 })],
        },
        {
          id: "normal",
          label: { nl: "Normale longen", en: "Normal lungs" },
          icon: "pi pi-undo",
          severity: "secondary",
          ops: reset(),
        },
      ],
    },
    {
      id: "atelectasis",
      title: { nl: "Atelectase", en: "Atelectasis" },
      centreTab: "diagram",
      onEnter: reset(),
      highlight: ["AA.po2", "AA.so2"],
      diagramHighlight: ["LUNG"],
      diagramLabels: ALVEOLI,
      actions: [
        {
          id: "collapse",
          label: { nl: "Laat de linkerlong collaberen", en: "Collapse the left lung" },
          icon: "pi pi-exclamation-triangle",
          severity: "danger",
          ops: [call("Respiration.set_atelectasis_left", 0.6)],
        },
        {
          id: "recruit",
          label: { nl: "PEEP 10 en PIP 23", en: "PEEP 10 and PIP 23" },
          icon: "pi pi-arrow-up",
          ops: [call("Ventilator.sle_apply", { peep: 10, pip: 23 })],
        },
      ],
    },
    {
      id: "right-main",
      title: { nl: "Tube in de rechter hoofdbronchus", en: "Tube in the right main bronchus" },
      centreTab: "diagram",
      onEnter: reset(),
      highlight: ["AA.po2", "AA.so2"],
      diagramHighlight: ["LUNG"],
      diagramLabels: ALVEOLI,
      actions: [
        {
          id: "advance",
          label: { nl: "Schuif de tube te diep", en: "Push the tube in too far" },
          icon: "pi pi-exclamation-triangle",
          severity: "danger",
          ops: [call("Ventilator.set_tube_position", "right_main")],
        },
        {
          id: "pull-back",
          label: { nl: "Trek de tube terug", en: "Pull the tube back" },
          icon: "pi pi-undo",
          ops: [call("Ventilator.set_tube_position", "trachea")],
        },
      ],
    },
    {
      id: "plug",
      title: { nl: "Een slijmprop", en: "A mucus plug" },
      centreTab: "sle6000",
      onEnter: reset(),
      actions: [
        {
          id: "plug",
          label: { nl: "Prop in de linker bronchus", en: "Plug in the left bronchus" },
          icon: "pi pi-exclamation-triangle",
          severity: "danger",
          ops: [call("Respiration.set_airway_obstructed_left", true)],
        },
        {
          id: "suction",
          label: { nl: "Uitzuigen", en: "Suction" },
          icon: "pi pi-undo",
          ops: [call("Respiration.set_airway_obstructed_left", false)],
        },
      ],
    },
    {
      id: "disconnection",
      title: { nl: "Losgeraakt circuit", en: "Disconnected circuit" },
      centreTab: "sle6000",
      onEnter: reset(),
      monitorHighlight: ["co2", "spo2_pre"],
      actions: [
        {
          id: "disconnect",
          label: { nl: "Koppel het circuit los", en: "Disconnect the circuit" },
          icon: "pi pi-exclamation-triangle",
          severity: "danger",
          ops: [call("Ventilator.set_circuit_connected", false)],
        },
        {
          id: "reconnect",
          label: { nl: "Sluit weer aan", en: "Reconnect" },
          icon: "pi pi-undo",
          ops: [call("Ventilator.set_circuit_connected", true)],
        },
      ],
    },
    {
      id: "leak-and-tube",
      title: { nl: "Lekkage en tubemaat", en: "Leak and tube size" },
      centreTab: "sle6000",
      onEnter: reset(),
      actions: [
        {
          id: "leak",
          label: { nl: "Maak een lek langs de tube", en: "Leak around the tube" },
          icon: "pi pi-exclamation-triangle",
          severity: "danger",
          ops: [{ kind: "set", path: "Ventilator.leak_size", value: 0.5, it: 1 }],
        },
        {
          id: "small-tube",
          label: { nl: "Te kleine tube (2,5 mm)", en: "Tube too small (2.5 mm)" },
          icon: "pi pi-exclamation-triangle",
          severity: "danger",
          ops: [
            { kind: "set", path: "Ventilator.leak_size", value: 0, it: 1 },
            call("Ventilator.set_ettube_diameter", 2.5),
          ],
        },
        {
          id: "fix",
          label: { nl: "Herstel", en: "Fix" },
          icon: "pi pi-undo",
          severity: "secondary",
          ops: reset(),
        },
      ],
    },
    {
      id: "free-play",
      title: { nl: "Vrij spelen", en: "Free play" },
      centreTab: "sle6000",
      actions: [
        {
          id: "clean",
          label: { nl: "Schone patiënt op CMV", en: "Clean patient on CMV" },
          icon: "pi pi-refresh",
          severity: "secondary",
          ops: reset(),
        },
        {
          id: "restart",
          label: { nl: "Begin de les opnieuw", en: "Restart the lesson" },
          icon: "pi pi-replay",
          severity: "secondary",
          ops: [{ kind: "restart" }],
        },
      ],
    },
  ],
});
