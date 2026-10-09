import { describe, expect, it } from "vitest";
import { parseCommands, validateCommand } from "./botCommands";

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

describe("validateCommand tune", () => {
  const tune = (changes: { target: string; value: number }[]) =>
    validateCommand({ op: "tune", changes, reason: "t" } as any, {}, "full");

  it("accepts the builder-aligned targets", () => {
    const r = tune([{ target: "pap_s", value: 36 }, { target: "spo2", value: 85 }]);
    expect(r.ok).toBe(true);
    expect(r.normalized).toEqual({ kind: "tune", targets: { pap_s: 36, spo2: 85 } });
  });

  it("accepts systolic and diastolic as a pair", () => {
    const r = tune([{ target: "sys", value: 40 }, { target: "dia", value: 24 }]);
    expect(r.ok).toBe(true);
  });

  it("rejects systolic or diastolic alone", () => {
    expect(tune([{ target: "sys", value: 40 }]).ok).toBe(false);
    expect(tune([{ target: "dia", value: 24 }, { target: "map", value: 30 }]).error).toMatch(/together/);
  });

  it("rejects an unknown target", () => {
    expect(tune([{ target: "pp", value: 20 }]).ok).toBe(false);
  });
});

describe("validateCommand ventilator (Guided scope)", () => {
  const state = { models: { Ventilator: { name: "Ventilator", model_type: "Sle6000" } } };
  const guided = (cmd: object) => validateCommand({ reason: "t", ...cmd } as any, state, "guided");

  it("accepts the SLE6000 commands", () => {
    expect(guided({ op: "call", model: "Ventilator", target: "sle_start", args: ["CMV"] }).ok).toBe(true);
    expect(guided({ op: "call", model: "Ventilator", target: "sle_set", args: ["rr", 40] }).ok).toBe(true);
  });

  it("rejects the generic ventilator commands", () => {
    expect(guided({ op: "setProp", model: "Ventilator", target: "vent_rate", value: 40 }).ok).toBe(false);
    expect(guided({ op: "call", model: "Ventilator", target: "switch_ventilator", args: [true] }).ok).toBe(false);
  });
});

describe("validateCommand SLE6000 HFO (Guided scope)", () => {
  const state = { models: { Ventilator: { name: "Ventilator", model_type: "Sle6000" } } };
  const guided = (cmd: object) => validateCommand({ reason: "t", ...cmd } as any, state, "guided");

  it("accepts HFOV, its settings, Sigh and Oscillation Pause", () => {
    expect(guided({ op: "call", model: "Ventilator", target: "sle_start", args: ["HFOV"] }).ok).toBe(true);
    expect(guided({ op: "call", model: "Ventilator", target: "sle_set", args: ["dp", 20] }).ok).toBe(true);
    expect(guided({ op: "call", model: "Ventilator", target: "sle_sigh", args: [] }).ok).toBe(true);
    expect(guided({ op: "call", model: "Ventilator", target: "sle_osc_pause", args: [] }).ok).toBe(true);
  });
});
