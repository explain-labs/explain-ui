import { defineTour } from "@/manual/types";

// The first chapter of the manual: the screen layout, running the model and
// reading its output. Offered automatically on a user's first visit.
export default defineTour({
  id: "getting-started",
  title: "Getting started",
  summary: "The layout, running the model, and reading the diagram and monitors.",
  chapter: "Basics",
  order: 0,
  steps: [
    { id: "welcome", title: "Welcome to Explain" },
    { id: "controls", title: "Controls: change the patient", target: "layout.controls", placement: "right" },
    {
      id: "viz",
      title: "The centre: see what happens",
      target: "layout.viz",
      placement: "left",
      ui: [{ tab: "viz", value: "diagram" }],
    },
    {
      id: "monitors",
      title: "Monitors: the numbers",
      target: "layout.monitors",
      placement: "left",
      ui: [{ tab: "monitor", value: "monitoring" }],
    },
    { id: "scenario", title: "Choosing a patient", target: "scenario.picker", placement: "top" },
    { id: "run", title: "Start the simulation", target: "run.start", placement: "top", advanceOn: { running: true } },
    {
      id: "diagram",
      title: "Reading the diagram",
      target: "diagram.canvas",
      placement: "right",
      ui: [{ tab: "viz", value: "diagram" }],
      diagramHighlight: ["LA", "RA", "LV", "RV"],
    },
    {
      id: "shunts",
      title: "Connections and shunts",
      target: "diagram.canvas",
      placement: "right",
      diagramHighlight: ["DA", "FO", "VSD"],
    },
    {
      id: "numerics",
      title: "Monitoring dashboard",
      target: "layout.monitors",
      placement: "left",
      ui: [{ tab: "monitor", value: "monitoring" }],
    },
    {
      id: "monitor-tab",
      title: "Open the patient monitor",
      target: "tab.monitor.monitor",
      placement: "bottom",
      advanceOn: { tab: "monitor", value: "monitor" },
    },
    {
      id: "monitor",
      title: "The patient monitor",
      target: "monitor.canvas",
      placement: "left",
      ui: [{ tab: "monitor", value: "monitor" }],
      monitorHighlight: ["ecg", "spo2_pre", "spo2_post", "abp"],
    },
    { id: "fastforward", title: "Fast forward", target: "run.fastforward", placement: "top" },
    { id: "control-tabs", title: "The control panels", target: "tabs.control", placement: "bottom" },
    { id: "viz-tabs", title: "Charts, loops, the AI bot and docs", target: "tabs.viz", placement: "bottom" },
    { id: "save", title: "Saving your work", target: "save.panel", placement: "top" },
    { id: "help", title: "Where to find more", target: "header.help", placement: "bottom" },
  ],
});
