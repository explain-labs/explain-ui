import type { LessonStep } from "@/lessons/types";

// Reusable "how to read Explain" orientation: the diagram, its shunts, and the
// monitor. Lessons prepend these (`steps: [...introSteps(), …]`). Markdown lives
// in _shared/steps/. Highlighted names that a scenario lacks (e.g. no VSD) are
// simply skipped by the renderer, so the steps work across lesions.
export function introSteps(): LessonStep[] {
  return [
    {
      id: "read-diagram",
      source: "_shared",
      title: { nl: "Het diagram lezen", en: "Reading the diagram" },
      diagramHighlight: ["LA", "RA", "LV", "RV"],
    },
    {
      id: "read-shunts",
      source: "_shared",
      title: { nl: "Verbindingen en shunts", en: "Connections and shunts" },
      diagramHighlight: ["DA", "FO", "VSD"],
    },
    {
      id: "read-monitor",
      source: "_shared",
      title: { nl: "De monitor", en: "The monitor" },
      monitorHighlight: ["spo2_pre", "spo2_post"],
      highlight: ["Monitor.flows.da_flow", "Monitor.fo_flow"],
    },
  ];
}
