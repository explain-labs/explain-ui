import { defineTour } from "@/manual/types";

// Chapter 4: the monitoring dashboard — reading the numeric cards, the
// toolbar, and managing dashboards, groups and parameters.
const onMonitoring = [{ tab: "monitor", value: "monitoring" }] as const;

export default defineTour({
  id: "monitoring",
  title: "Monitoring dashboards",
  summary: "Read the numeric cards, and build your own dashboards and groups.",
  chapter: "Monitoring",
  order: 30,
  steps: [
    { id: "overview", title: "The monitoring dashboard", target: "layout.monitors", placement: "left", ui: [...onMonitoring] },
    { id: "card", title: "Reading a card", target: "numerics.card", placement: "left", ui: [...onMonitoring] },
    { id: "group", title: "Groups", target: "numerics.group", placement: "left", ui: [...onMonitoring] },
    { id: "toolbar", title: "Export, trend window and compact view", target: "monitoring.toolbar", placement: "bottom", ui: [...onMonitoring] },
    {
      id: "manage",
      title: "Manage the dashboard",
      target: "monitoring.manage",
      placement: "bottom",
      ui: [...onMonitoring],
      advanceOn: { appear: "monitoring.dashboards" },
    },
    { id: "dashboards", title: "Several dashboards", target: "monitoring.dashboards", placement: "left" },
    { id: "add-group", title: "Add a group", target: "monitoring.addgroup", placement: "bottom" },
    {
      id: "edit-group",
      title: "Edit a group",
      target: "numerics.group-edit",
      placement: "left",
      advanceOn: { appear: "numerics.editor" },
    },
    { id: "editor", title: "The group editor", target: "numerics.editor", placement: "left" },
    { id: "done", title: "Finish managing", target: "monitoring.manage", placement: "bottom" },
  ],
});
