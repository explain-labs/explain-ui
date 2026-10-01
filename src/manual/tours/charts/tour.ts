import { defineTour } from "@/manual/types";

// Chapter 3: the realtime chart (two series, view options, presets, CSV) and
// the X-Y loop chart (pressure–volume loops).
export default defineTour({
  id: "charts",
  title: "Charts and PV loops",
  summary: "Plot any model value in real time, and draw pressure–volume loops.",
  chapter: "Charts",
  order: 20,
  steps: [
    {
      id: "open-chart",
      title: "Open the chart",
      target: "tab.viz.chart",
      placement: "bottom",
      advanceOn: { tab: "viz", value: "chart" },
    },
    {
      id: "series",
      title: "Choose what to plot",
      target: "chart.series",
      placement: "bottom",
      ui: [{ tab: "viz", value: "chart" }],
    },
    { id: "plot", title: "The live trace", target: "chart.plot", placement: "right", ui: [{ tab: "viz", value: "chart" }] },
    { id: "view", title: "View options", target: "chart.view", placement: "top", ui: [{ tab: "viz", value: "chart" }] },
    { id: "presets", title: "Presets", target: "chart.presets", placement: "bottom", ui: [{ tab: "viz", value: "chart" }] },
    { id: "download", title: "Download the data", target: "chart.download", placement: "top", ui: [{ tab: "viz", value: "chart" }] },
    {
      id: "open-loop",
      title: "Open the PV loop",
      target: "tab.viz.loop",
      placement: "bottom",
      advanceOn: { tab: "viz", value: "loop" },
    },
    { id: "axes", title: "X and Y", target: "loop.axes", placement: "bottom", ui: [{ tab: "viz", value: "loop" }] },
    { id: "loop", title: "Reading a pressure–volume loop", target: "loop.plot", placement: "right", ui: [{ tab: "viz", value: "loop" }] },
    { id: "loop-controls", title: "Trail, presets and export", target: "loop.controls", placement: "top", ui: [{ tab: "viz", value: "loop" }] },
  ],
});
