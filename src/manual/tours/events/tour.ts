import { defineTour } from "@/manual/types";

// Chapter 10: the event scheduler — building a named bundle of changes, ramps
// and delays, firing manually or at a set simulation time.
const onEvents = [{ tab: "control", value: "events" }] as const;

export default defineTour({
  id: "events",
  title: "The event scheduler",
  summary: "Bundle changes into named events, with ramps and delays, and fire them on cue.",
  chapter: "Changing the patient",
  order: 42,
  steps: [
    { id: "intro", title: "Events", target: "events.panel", placement: "right", ui: [...onEvents] },
    { id: "name", title: "Name the event", target: "events.name", placement: "right", ui: [...onEvents] },
    {
      id: "add",
      title: "Add a change",
      target: "events.add",
      placement: "right",
      ui: [...onEvents],
      advanceOn: { appear: "events.change" },
    },
    { id: "change", title: "Setting up a change", target: "events.change", placement: "right", ui: [...onEvents] },
    { id: "timing", title: "When it fires", target: "events.timing", placement: "right", ui: [...onEvents] },
    { id: "save", title: "Save the event", target: "events.save", placement: "right", ui: [...onEvents] },
    { id: "saved", title: "Saved events", target: "events.saved", placement: "right", ui: [...onEvents] },
    { id: "keep", title: "Events and the state", placement: "bottom" },
  ],
});
