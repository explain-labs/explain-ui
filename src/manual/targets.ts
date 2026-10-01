// Every element the manual can spotlight carries `data-tour="<key>"`. Keys are
// listed here so tour files get type-checked targets; useTour warns in dev when
// a step's key isn't in the DOM. Keep the attribute on a stable, visible root
// (PrimeVue components forward it to their root element).
export const TOUR_TARGETS = [
  // page regions
  "layout.header",
  "layout.controls",
  "layout.viz",
  "layout.monitors",
  "layout.bottombar",
  // tab strips + individual tabs
  "tabs.control",
  "tabs.viz",
  "tabs.monitor",
  "tab.control.editor",
  "tab.control.tasks",
  "tab.control.ventilator",
  "tab.control.ecls",
  "tab.control.resuscitation",
  "tab.control.pregnancy",
  "tab.control.scaler",
  "tab.control.events",
  "tab.viz.diagram",
  "tab.viz.chart",
  "tab.viz.loop",
  "tab.viz.chat",
  "tab.viz.docs",
  "tab.monitor.monitoring",
  "tab.monitor.monitor",
  "tab.monitor.ventilator",
  // bottom bar
  "run.status",
  "run.start",
  "run.fastforward",
  "scenario.picker",
  "save.panel",
  // header
  "header.lessons",
  "header.help",
  // centre / right column content
  "diagram.canvas", // the whole Diagram component (toolbars + canvas)
  "diagram.stage", // just the Pixi canvas
  "diagram.edit",
  "diagram.add",
  "diagram.inspector",
  "diagram.connect",
  "diagram.view",
  "diagram.file",
  // model editor
  "modeleditor.panel",
  "modeleditor.select",
  "modeleditor.refresh",
  "modeleditor.sections", // only once a model with an interface is selected
  "modeleditor.factors", // the Factors accordion section
  // realtime chart + PV loop
  "chart.presets",
  "chart.series",
  "chart.plot",
  "chart.view",
  "chart.download",
  "loop.presets",
  "loop.axes",
  "loop.plot",
  "loop.controls",
  "monitoring.toolbar",
  "monitoring.manage",
  "monitoring.addgroup",
  "monitoring.dashboards", // dashboard management box (manage mode only)
  "numerics.group", // first numeric group (read-only view)
  "numerics.card", // first numeric card
  "numerics.group-edit", // first group's edit pencil (manage mode only)
  "numerics.editor", // a group in edit mode
  "monitor.canvas",
] as const;

export type TourTarget = (typeof TOUR_TARGETS)[number];

export function findTarget(key: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-tour="${CSS.escape(key)}"]`);
}
