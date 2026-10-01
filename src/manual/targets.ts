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
  "diagram.canvas",
  "monitoring.toolbar",
  "monitoring.manage",
  "monitor.canvas",
] as const;

export type TourTarget = (typeof TOUR_TARGETS)[number];

export function findTarget(key: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-tour="${CSS.escape(key)}"]`);
}
