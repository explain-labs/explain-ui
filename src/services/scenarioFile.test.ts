import { describe, expect, it } from "vitest";
import { scenarioFile } from "./scenarioFile";

describe("scenarioFile", () => {
  const base = {
    name: "term_neonate_72h",
    user: "timothy",
    description: "normal neonate",
    provenance: "hand-authored",
    provenance_note: "set by hand",
    diagram_definition: { d: 1 },
    animation_definition: { a: 1 },
    configuration: { c: 1 },
    model_definition: { old: true },
  };

  it("keeps every top-level key of the loaded file, in order", () => {
    const f = scenarioFile(base, "my_snapshot", { new: true });
    expect(Object.keys(f)).toEqual(Object.keys(base));
    expect(f.provenance).toBe("hand-authored");
    expect(f.provenance_note).toBe("set by hand");
    expect(f.configuration).toEqual({ c: 1 });
  });

  it("uses the new name and the new state", () => {
    const f = scenarioFile(base, "my_snapshot", { new: true });
    expect(f.name).toBe("my_snapshot");
    expect(f.model_definition).toEqual({ new: true });
  });

  it("works without a loaded file", () => {
    expect(scenarioFile(undefined, "x", 1)).toEqual({ name: "x", model_definition: 1 });
  });
});
