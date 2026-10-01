import { defineTour } from "@/manual/types";

// Chapter 7: the ventilator console (switch, modes, settings, ET tube,
// synchronisation, measured values) and the ventilator graphs.
const onVent = [{ tab: "control", value: "ventilator" }] as const;

export default defineTour({
  id: "ventilator",
  title: "The ventilator",
  summary: "Ventilate the patient: modes, settings, the ET tube, triggering and the graphs.",
  chapter: "Devices",
  order: 50,
  steps: [
    { id: "intro", title: "The ventilator", target: "vent.panel", placement: "right", ui: [...onVent] },
    {
      id: "switch",
      title: "Switch it on",
      target: "vent.switch",
      placement: "right",
      ui: [...onVent],
      advanceOn: { appear: "vent.on" },
    },
    { id: "mode", title: "Ventilation modes", target: "vent.mode", placement: "right", ui: [...onVent] },
    { id: "settings", title: "Settings", target: "vent.settings", placement: "right", ui: [...onVent] },
    { id: "tube", title: "The endotracheal tube", target: "vent.tube", placement: "right", ui: [...onVent] },
    { id: "trigger", title: "Synchronisation and manual breaths", target: "vent.trigger", placement: "right", ui: [...onVent] },
    { id: "measured", title: "Measured values", target: "vent.measured", placement: "right", ui: [...onVent] },
    {
      id: "scope",
      title: "Ventilator graphs",
      target: "vent.scope",
      placement: "left",
      ui: [...onVent, { tab: "monitor", value: "ventilator" }],
    },
    { id: "off", title: "Switching off", target: "vent.switch", placement: "right", ui: [...onVent] },
  ],
});
