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
  "tab.control.ecls",
  "tab.control.resuscitation",
  "tab.control.pregnancy",
  "tab.control.scaler",
  "tab.control.events",
  "tab.viz.diagram",
  "tab.viz.chart",
  "tab.viz.loop",
  "tab.viz.chat",
  "tab.viz.sle6000",
  "tab.viz.docs",
  "tab.monitor.monitoring",
  "tab.monitor.monitor",
  // bottom bar
  "run.status",
  "run.start",
  "run.fastforward",
  "scenario.picker",
  "save.panel",
  "save.snapshot", // model developers only
  "save.cloud", // needs the database
  "save.default",
  "save.list",
  "save.states", // inside the "My saved states" dialog
  // header
  "header.lessons",
  "header.help",
  "header.state",
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
  // common tasks (row keys repeat; findTarget picks the first visible one)
  "commontasks.panel",
  "commontasks.category",
  "commontasks.task",
  "commontasks.step",
  "commontasks.reset",
  // ECLS panel
  "ecls.panel",
  "ecls.switch",
  "ecls.on", // only present while ECLS is running
  "ecls.clamp",
  "ecls.pump",
  "ecls.settings",
  "ecls.cannulas",
  "ecls.resistances",
  "ecls.measured",
  // event scheduler
  "events.panel",
  "events.name",
  "events.timing",
  "events.add",
  "events.change", // one per change row (none until "Add change")
  "events.save",
  "events.saved",
  // AI bot
  "chat.panel",
  "chat.scope",
  "chat.autoapply",
  "chat.revert",
  "chat.conversation",
  "chat.attach",
  "chat.composer",
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

// Several elements may share a key (one per list row); prefer the first one
// that is actually visible (v-show / collapsed sections leave hidden copies).
export function findTarget(key: string): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>(`[data-tour="${CSS.escape(key)}"]`);
  for (const el of all) if (isVisible(el)) return el;
  return all[0] ?? null;
}

export function isVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 || r.height > 0;
}

// Like findTarget, but only a visible element counts.
export function findVisibleTarget(key: string): HTMLElement | null {
  const el = findTarget(key);
  return el && isVisible(el) ? el : null;
}
