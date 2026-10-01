import { defineTour } from "@/manual/types";

// Chapter 6: Common tasks — the curated directional nudges (also used by the
// AI bot): categories, −/+ with a step size, reset, and watching the effect.
const onTasks = [{ tab: "control", value: "tasks" }] as const;

export default defineTour({
  id: "common-tasks",
  title: "Common tasks",
  summary: "One-click nudges: raise PVR, lower contractility, open a shunt, and more.",
  chapter: "Changing the patient",
  order: 41,
  steps: [
    { id: "intro", title: "Quick physiological changes", target: "commontasks.panel", placement: "right", ui: [...onTasks] },
    {
      id: "category",
      title: "Open a category",
      target: "commontasks.category",
      placement: "right",
      ui: [...onTasks],
      advanceOn: { appear: "commontasks.task" },
    },
    { id: "task", title: "A task", target: "commontasks.task", placement: "right", ui: [...onTasks] },
    { id: "step", title: "The step size", target: "commontasks.step", placement: "right", ui: [...onTasks] },
    { id: "reset", title: "Back to baseline", target: "commontasks.reset", placement: "right", ui: [...onTasks] },
    {
      id: "watch",
      title: "Watch the effect",
      target: "layout.monitors",
      placement: "left",
      ui: [{ tab: "monitor", value: "monitoring" }],
    },
    { id: "bot", title: "Keeping changes, and the AI bot", placement: "bottom" },
  ],
});
