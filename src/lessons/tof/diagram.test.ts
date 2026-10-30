import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import tofLesson from "./lesson";

// The ToF lesson points at diagram components by name; the scenario's diagram (built by the engine's
// _make_tof.mjs teaching simplification) must still have every one of them.
describe("the ToF lesson diagram", () => {
  const file = path.resolve(__dirname, "../../../explain-engine/model_definitions", `${tofLesson.scenario}.json`);
  const components = JSON.parse(fs.readFileSync(file, "utf8")).diagram_definition.components;

  it("has every name the lesson highlights", () => {
    for (const step of tofLesson.steps)
      for (const name of step.diagramHighlight ?? []) expect(components[name], `${step.id}: ${name}`).toBeDefined();
  });
  it("connects only components that exist", () => {
    for (const [name, c] of Object.entries<any>(components)) {
      if (c.type !== "Connector") continue;
      expect(components[c.dbcFrom], `${name} from ${c.dbcFrom}`).toBeDefined();
      expect(components[c.dbcTo], `${name} to ${c.dbcTo}`).toBeDefined();
    }
  });
});
