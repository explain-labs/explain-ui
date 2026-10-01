import { describe, expect, it } from "vitest";
import { FORM_MARKER, buildRequest, checkSpec, parseProvenance, type PatientBuildRequest } from "./patientBuilder";
import type { PatientForm } from "./patientSchema";

const FORM: PatientForm = {
  numbers: {
    weight: { value: 1080, unit: "g" },
    gestational_age: { value: 28, unit: "weeks" },
    postnatal_age: { value: 3, unit: "days" },
    hr: { value: 158, unit: "/min" },
    sys: { value: 48, unit: "mmHg" },
    dia: { value: 27, unit: "mmHg" },
    spo2: { value: 91, unit: "%" },
    pco2: { value: 6.8, unit: "kPa" },
    be: { value: -4.5, unit: "mmol/L" },
    ph: { value: 7.28, unit: "" },
  },
  choices: { gas_site: "capillary", resp_support: "cpap" },
};
const request = (): PatientBuildRequest => buildRequest(FORM, "pb_test")!;
const block = (obj: unknown) => "```explain-provenance\n" + (typeof obj === "string" ? obj : JSON.stringify(obj)) + "\n```";

describe("buildRequest", () => {
  it("returns null for a form with blocking issues", () => {
    expect(buildRequest({ numbers: { hr: { value: 150, unit: "/min" } }, choices: {} })).toBeNull();
  });

  it("puts the marker first and the payload in one fenced block", () => {
    const r = request();
    expect(r.prompt.startsWith(FORM_MARKER)).toBe(true);
    const m = /```explain-patient-form\n([\s\S]*?)\n```/.exec(r.prompt);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1])).toEqual(r.payload);
  });

  it("sends targets in SPEC units, measured non-targets as checks, and choices as context", () => {
    const { payload } = request();
    expect(payload.targets).toEqual({ weight: 1.08, gestational_age: 28, hr: 158, map: 34, spo2: 91, pco2: 51, be: -4.5 });
    expect(payload.checks).toEqual({ sys: 48, dia: 27, ph: 7.28 });
    expect(payload.context).toEqual({ gas_site: "capillary", resp_support: "cpap", postnatal_age: 3 });
    expect(payload.unknown).toEqual(expect.arrayContaining(["height", "hb", "temp", "cvp", "co"]));
    expect(payload.units.pco2).toBe("mmHg");
  });

  it("generates a random request id that carries no user text", () => {
    const a = buildRequest(FORM)!;
    const b = buildRequest(FORM)!;
    expect(a.requestId).toMatch(/^pb_[0-9a-f]{8}$/);
    expect(a.requestId).not.toBe(b.requestId);
  });

  it("contains nothing but schema keys, numbers and listed choices", () => {
    // the whole payload is machine-generated from validated fields: no free text can ride along
    const hostile: PatientForm = { numbers: { ...FORM.numbers, "Jane Doe": { value: 1, unit: "" } }, choices: { ...FORM.choices, note: "born 2026-09-28" } };
    const r = buildRequest(hostile, "pb_x")!;
    expect(r.prompt).not.toMatch(/Jane|born/);
  });
});

describe("parseProvenance", () => {
  const good = {
    baseline: "term_neonate",
    baseline_reason: "Preterm built from the term baseline plus gestational age.",
    fields: [
      { key: "hb", value: 9.6, status: "reference", basis: "Typical for 28 wk, day 3", source: { title: "neonatal-reference.md", url: "https://example.org/hb" } },
      { key: "temp", value: 36.8, status: "assumed", basis: "Normothermia assumed", source: null },
      { key: "co", value: null, status: "emergent", basis: "Left to the model" },
    ],
    warnings: ["No echo: output and resistance are not separable."],
  };

  it("returns no provenance and the untouched prose when there is no block", () => {
    expect(parseProvenance("plain answer")).toEqual({ clean: "plain answer", provenance: null, errors: [] });
  });

  it("parses a valid block and strips it from the prose", () => {
    const r = parseProvenance(`Built.\n\n${block(good)}\n\nDone.`);
    expect(r.errors).toEqual([]);
    expect(r.clean).toBe("Built.\n\nDone.");
    expect(r.provenance!.baseline).toBe("term_neonate");
    expect(r.provenance!.fields.map((f) => [f.key, f.status, f.value])).toEqual([
      ["hb", "reference", 9.6],
      ["temp", "assumed", 36.8],
      ["co", "emergent", null],
    ]);
    expect(r.provenance!.fields[0].source).toEqual({ title: "neonatal-reference.md", url: "https://example.org/hb" });
    expect(r.provenance!.warnings).toHaveLength(1);
  });

  it("reports malformed JSON and a non-object block", () => {
    expect(parseProvenance(block("{not json")).errors).toEqual(["provenance block is not valid JSON"]);
    expect(parseProvenance(block("[1,2]")).errors).toEqual(["provenance block is not a JSON object"]);
    expect(parseProvenance(block("{not json")).provenance).toBeNull();
  });

  it("drops unknown keys, unknown statuses, duplicates and out-of-range values", () => {
    const r = parseProvenance(
      block({
        fields: [
          { key: "patient_name", value: 1, status: "reference" },
          { key: "hb", value: 9.6, status: "measured" },
          { key: "temp", value: 99, status: "assumed" },
          { key: "height", value: 0.36, status: "reference" },
          { key: "height", value: 0.4, status: "reference" },
          { key: "cvp", status: "reference" },
        ],
      }),
    );
    expect(r.provenance!.fields.map((f) => f.key)).toEqual(["height"]);
    expect(r.errors).toHaveLength(5);
  });

  it("keeps only http(s) source links", () => {
    const row = (url: string) => ({ key: "hb", value: 9.6, status: "reference", source: { title: "t", url } });
    const urlOf = (url: string) => parseProvenance(block({ fields: [row(url)] })).provenance!.fields[0].source!.url;
    expect(urlOf("https://example.org/a")).toBe("https://example.org/a");
    expect(urlOf("javascript:alert(1)")).toBeNull();
    expect(urlOf("data:text/html,x")).toBeNull();
    expect(urlOf("not a url")).toBeNull();
  });

  it("caps long text", () => {
    const r = parseProvenance(block({ baseline_reason: "x".repeat(5000), fields: [], warnings: ["y".repeat(5000)] }));
    expect(r.provenance!.baselineReason).toHaveLength(400);
    expect(r.provenance!.warnings[0]).toHaveLength(400);
  });

  it("reads only the first of several blocks", () => {
    const r = parseProvenance(`${block({ baseline: "term_neonate" })}\n${block({ baseline: "pphn" })}`);
    expect(r.provenance!.baseline).toBe("term_neonate");
    expect(r.errors).toEqual(["more than one provenance block; only the first was read"]);
    expect(r.clean).toBe("");
  });
});

describe("checkSpec", () => {
  const prov = parseProvenance(block({ fields: [{ key: "hb", value: 9.6, status: "reference", basis: "ref" }] })).provenance;
  const spec = (extra: Record<string, unknown> = {}, drop: string[] = []) => {
    const targets: Record<string, unknown> = { ...request().payload.targets, ...extra };
    for (const k of drop) delete targets[k];
    return { baseline: "term_neonate", targets };
  };

  it("accepts a spec that carries the submitted targets unchanged", () => {
    expect(checkSpec(spec(), request(), null)).toEqual([]);
  });

  it("flags a measured value the bot changed", () => {
    const p = checkSpec(spec({ hr: 150 }), request(), null);
    expect(p).toHaveLength(1);
    expect(p[0].message).toMatch(/measured 158.*given 150/);
  });

  it("flags a measured value the bot left out", () => {
    expect(checkSpec(spec({}, ["pco2"]), request(), null)[0].message).toMatch(/not passed/);
  });

  it("flags a vital the bot added as a target although it was not measured", () => {
    expect(checkSpec(spec({ cvp: 4 }), request(), null)[0].message).toMatch(/not measured/);
  });

  it("allows a structural fill only when the provenance accounts for it", () => {
    expect(checkSpec(spec({ hb: 9.6 }), request(), prov)).toEqual([]);
    expect(checkSpec(spec({ hb: 9.6 }), request(), null)[0].message).toMatch(/without an explanation/);
  });

  it("reports a spec with no target list", () => {
    expect(checkSpec({ baseline: "term_neonate" }, request(), null)).toHaveLength(1);
    expect(checkSpec(null, request(), null)).toHaveLength(1);
  });
});
