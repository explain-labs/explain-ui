import { defineTour } from "@/manual/types";

// Chapter 12: saving and loading — what a state holds, cloud saves, the saved
// states dialog, the default state, scenarios vs. states, and the model
// developer's file snapshots.
export default defineTour({
  id: "states",
  title: "Saving and loading states",
  summary: "Save your patient to the cloud, load it again, and choose what opens at login.",
  chapter: "Basics",
  order: 1,
  steps: [
    { id: "what", title: "What is a state?", target: "save.panel", placement: "top" },
    { id: "cloud", title: "Save to cloud", target: "save.cloud", placement: "top" },
    {
      id: "open-list",
      title: "Open your saved states",
      target: "save.list",
      placement: "top",
      advanceOn: { appear: "save.states" },
    },
    { id: "list", title: "My saved states", target: "save.states", placement: "right" },
    { id: "default", title: "Your default state", target: "save.default", placement: "top" },
    { id: "active", title: "What is loaded now", target: "header.state", placement: "bottom" },
    { id: "scenarios", title: "Scenarios and states", target: "scenario.picker", placement: "top" },
    { id: "developers", title: "For model developers", placement: "bottom" },
  ],
});
