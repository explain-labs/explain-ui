import { defineTour } from "@/manual/types";

// Chapter 8: the ECLS (ECMO) console — running/clamping, pump type, sweep gas,
// cannulas and sites (VA vs VV), resistance factors, measurements, and the
// circuit in the diagram.
const onEcls = [{ tab: "control", value: "ecls" }] as const;

export default defineTour({
  id: "ecls",
  title: "ECLS (ECMO)",
  summary: "Put the patient on extracorporeal life support: pump, sweep gas, cannulas and sites.",
  chapter: "Devices",
  order: 51,
  steps: [
    { id: "intro", title: "Extracorporeal life support", target: "ecls.panel", placement: "right", ui: [...onEcls] },
    {
      id: "switch",
      title: "Start the circuit",
      target: "ecls.switch",
      placement: "right",
      ui: [...onEcls],
      advanceOn: { appear: "ecls.on" },
    },
    { id: "clamp", title: "Clamped", target: "ecls.clamp", placement: "right", ui: [...onEcls] },
    { id: "pump", title: "Pump type", target: "ecls.pump", placement: "right", ui: [...onEcls] },
    { id: "settings", title: "Pump speed and sweep gas", target: "ecls.settings", placement: "right", ui: [...onEcls] },
    { id: "cannulas", title: "Cannulas and sites", target: "ecls.cannulas", placement: "right", ui: [...onEcls] },
    { id: "resistances", title: "Resistance factors", target: "ecls.resistances", placement: "right", ui: [...onEcls] },
    { id: "measured", title: "Measured values", target: "ecls.measured", placement: "right", ui: [...onEcls] },
    {
      id: "diagram",
      title: "The circuit in the diagram",
      target: "diagram.stage",
      placement: "right",
      ui: [{ tab: "viz", value: "diagram" }],
    },
    { id: "off", title: "Stopping ECLS", target: "ecls.switch", placement: "right", ui: [...onEcls] },
  ],
});
