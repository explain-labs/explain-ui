import { defineTour } from "@/manual/types";

// Chapter 2: changing the diagram's layout — edit mode, adding, moving and
// styling compartments, connecting them, view settings, and export/import.
export default defineTour({
  id: "diagram-editing",
  title: "Editing the diagram",
  summary: "Move, add, connect and restyle compartments, and export the layout.",
  chapter: "Diagram",
  order: 10,
  steps: [
    {
      id: "intro",
      title: "The diagram is editable",
      target: "diagram.canvas",
      placement: "right",
      ui: [{ tab: "viz", value: "diagram" }],
    },
    {
      id: "edit",
      title: "Switch on edit mode",
      target: "diagram.edit",
      placement: "bottom",
      ui: [{ tab: "viz", value: "diagram" }],
      advanceOn: { appear: "diagram.connect" }, // the edit-only bottom row
    },
    { id: "add", title: "Add a compartment", target: "diagram.add", placement: "bottom" },
    {
      id: "select",
      title: "Select and move",
      target: "diagram.stage",
      placement: "right",
      advanceOn: { appear: "diagram.inspector" },
    },
    { id: "inspector", title: "The inspector", target: "diagram.inspector", placement: "bottom" },
    { id: "connect", title: "Connecting compartments", target: "diagram.connect", placement: "top" },
    { id: "view", title: "Grid, scale and colour", target: "diagram.view", placement: "top" },
    { id: "file", title: "Export and import", target: "diagram.file", placement: "top" },
    { id: "done", title: "Leaving edit mode", target: "diagram.edit", placement: "bottom" },
  ],
});
