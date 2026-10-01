import { describe, expect, it } from "vitest";
import { parseCommands } from "./botCommands";

const block = (json: string) => "```explain-command\n" + json + "\n```";

describe("parseCommands", () => {
  it("returns the prose untouched when there are no command blocks", () => {
    const r = parseCommands("Just an explanation.");
    expect(r).toEqual({ clean: "Just an explanation.", commands: [], parseErrors: [] });
  });

  it("extracts a command and strips its block from the prose", () => {
    const r = parseCommands(`Starting the model.\n\n${block('{"op":"start"}')}`);
    expect(r.clean).toBe("Starting the model.");
    expect(r.commands).toEqual([{ op: "start" }]);
    expect(r.parseErrors).toEqual([]);
  });

  it("keeps the order of several blocks", () => {
    const r = parseCommands(`${block('{"op":"stop"}')}\ntext\n${block('{"op":"start"}')}`);
    expect(r.commands.map((c) => c.op)).toEqual(["stop", "start"]);
    expect(r.clean).toBe("text");
  });

  it("accepts an array of commands in one block", () => {
    const r = parseCommands(block('[{"op":"stop"},{"op":"start"}]'));
    expect(r.commands).toHaveLength(2);
  });

  it("reports a block that is not valid JSON instead of dropping it silently", () => {
    const r = parseCommands(`ok\n${block('{"op":"start"')}`);
    expect(r.commands).toEqual([]);
    expect(r.parseErrors).toEqual(['{"op":"start"']);
    expect(r.clean).toBe("ok");
  });

  it("ignores non-object JSON values", () => {
    const r = parseCommands(block("[1, null, \"x\"]"));
    expect(r.commands).toEqual([]);
    expect(r.parseErrors).toEqual([]);
  });

  it("collapses the blank lines a removed block leaves behind", () => {
    const r = parseCommands(`before\n\n${block('{"op":"start"}')}\n\nafter`);
    expect(r.clean).toBe("before\n\nafter");
  });

  it("returns an empty result for a non-string answer", () => {
    const r = parseCommands(undefined as unknown as string);
    expect(r).toEqual({ clean: "", commands: [], parseErrors: [] });
  });
});
