import { defineTour } from "@/manual/types";

// Chapter 5: the generic model editor — pick any model, edit its fields by
// section, factors vs. base values, functions, refreshing, keeping changes.
const onEditor = [{ tab: "control", value: "editor" }] as const;

export default defineTour({
  id: "model-editor",
  title: "The model editor",
  summary: "Change any parameter of any part of the model, and run model functions.",
  chapter: "Changing the patient",
  order: 40,
  steps: [
    { id: "intro", title: "The model editor", target: "modeleditor.panel", placement: "right", ui: [...onEditor] },
    {
      id: "select",
      title: "Pick a model",
      target: "modeleditor.select",
      placement: "right",
      ui: [...onEditor],
      advanceOn: { appear: "modeleditor.sections" },
    },
    { id: "sections", title: "Sections", target: "modeleditor.sections", placement: "right", ui: [...onEditor] },
    { id: "fields", title: "Changing a value", target: "modeleditor.sections", placement: "right", ui: [...onEditor] },
    { id: "factors", title: "Factors", target: "modeleditor.factors", placement: "right", ui: [...onEditor] },
    { id: "functions", title: "Functions", target: "modeleditor.sections", placement: "right", ui: [...onEditor] },
    { id: "refresh", title: "Refreshing the values", target: "modeleditor.refresh", placement: "right", ui: [...onEditor] },
    { id: "keep", title: "Keeping or undoing changes", target: "save.panel", placement: "top" },
  ],
});
