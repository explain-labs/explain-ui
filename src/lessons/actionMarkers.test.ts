import { describe, expect, it } from "vitest";
import { splitActionMarkers } from "@/lessons/actionMarkers";

describe("splitActionMarkers", () => {
  it("cuts the text at marker lines", () => {
    const md = "Intro.\n\nPress **Bleed**.\n\n[[action:bleed]]\n\n> Question?\n\n[[action: bolus , transfuse ]]\nEnd.";
    expect(splitActionMarkers(md)).toEqual([
      { kind: "md", md: "Intro.\n\nPress **Bleed**.\n" },
      { kind: "actions", ids: ["bleed"] },
      { kind: "md", md: "\n> Question?\n" },
      { kind: "actions", ids: ["bolus", "transfuse"] },
      { kind: "md", md: "End." },
    ]);
  });
  it("leaves text without markers whole", () => {
    expect(splitActionMarkers("Just text.\n")).toEqual([{ kind: "md", md: "Just text.\n" }]);
  });
  it("ignores a marker inside a line", () => {
    const md = "See [[action:bleed]] here.";
    expect(splitActionMarkers(md)).toEqual([{ kind: "md", md }]);
  });
});
