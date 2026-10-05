import { describe, expect, it } from "vitest";
import { FORM_MARKER, atrialFlowNote, buildRequest, buildResultRows, buildValueRows, checkSpec, ductalFlowNote, parseBuildReport, parseProvenance, type PatientBuildRequest } from "./patientBuilder";
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
    expect(payload.targets).toEqual({ weight: 1.08, gestational_age: 28, hr: 158, sys: 48, dia: 27, map: 34, spo2: 91, pco2: 51, be: -4.5 });
    expect(payload.checks).toEqual({ ph: 7.28 });
    expect(payload.context).toEqual({ gas_site: "capillary", resp_support: "cpap", postnatal_age: 3 });
    expect(payload.unknown).toEqual(expect.arrayContaining(["height", "hb", "temp", "cvp", "co"]));
    expect(payload.unknown).not.toContain("fio2"); // empty FiO2 = room air, not a lookup
    expect(payload.units.pco2).toBe("mmHg");
  });

  it("passes a measured FiO2 to the builder as a fraction", () => {
    const f: PatientForm = { ...FORM, numbers: { ...FORM.numbers, fio2: { value: 30, unit: "%" } } };
    const r = buildRequest(f, "pb_f")!;
    expect(r.payload.targets.fio2).toBe(0.3);
    expect(r.payload.units.fio2).toBe("fraction");
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
    return { baseline: "term_neonate", postnatal_age_days: 3, targets };
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

  it("flags a postnatal age that did not reach the builder", () => {
    const { postnatal_age_days: _, ...noAge } = spec();
    expect(checkSpec(noAge, request(), null)[0].message).toMatch(/postnatal_age: 3 days, but it was not passed/);
    expect(checkSpec({ ...spec(), postnatal_age_days: 30 }, request(), null)[0].message).toMatch(/given 30/);
  });

  it("does not ask for a postnatal age the form did not have", () => {
    const f = { ...FORM, numbers: { ...FORM.numbers, postnatal_age: { value: null, unit: "days" } } };
    const r = buildRequest(f, "pb_noage")!;
    const { postnatal_age_days: _, ...noAge } = { baseline: "term_neonate", postnatal_age_days: 0, targets: { ...r.payload.targets } };
    expect(checkSpec(noAge, r, null)).toEqual([]);
  });

  it("reports a spec with no target list", () => {
    expect(checkSpec({ baseline: "term_neonate" }, request(), null)).toHaveLength(1);
    expect(checkSpec(null, request(), null)).toHaveLength(1);
  });
});

describe("result tables", () => {
  const prov = parseProvenance(
    block({
      fields: [
        { key: "hb", value: 9, status: "reference", basis: "first week, under 29 wk", source: { title: "neonatal-reference.md (draft), table 2", url: null } },
        { key: "cvp", value: null, status: "emergent", basis: "left to the model" },
      ],
    }),
  ).provenance;

  it("lists measured, derived and filled values in schema order with what the builder did with each", () => {
    const rows = buildValueRows(request(), prov);
    const row = (k: string) => rows.find((r) => r.key === k)!;
    expect(row("weight")).toMatchObject({ value: 1.08, status: "measured", use: "target" });
    expect(row("postnatal_age")).toMatchObject({ value: 3, status: "measured", use: "context" });
    expect(row("sys")).toMatchObject({ status: "measured", use: "target" });
    expect(row("ph")).toMatchObject({ status: "measured", use: "check" });
    expect(row("map")).toMatchObject({ value: 34, status: "derived", use: "target" });
    expect(row("hb")).toMatchObject({ value: 9, status: "reference", use: "target" });
    expect(row("cvp")).toMatchObject({ value: null, status: "emergent", use: "none" });
    expect(rows.find((r) => r.key === "co")).toBeUndefined(); // neither measured nor accounted for
    expect(rows.map((r) => r.key).indexOf("weight")).toBeLessThan(rows.map((r) => r.key).indexOf("hr"));
  });

  it("never lets the bot's provenance override a measured value", () => {
    const hostile = parseProvenance(block({ fields: [{ key: "hr", value: 120, status: "reference", basis: "x" }] })).provenance;
    expect(buildValueRows(request(), hostile).find((r) => r.key === "hr")).toMatchObject({ value: 158, status: "measured" });
  });

  const raw = {
    converged: false,
    iters: 10,
    unmet: ["pco2"],
    residuals: [
      { key: "hr", value: 156.2, target: 158, delta: -1.8, flag: "ok" },
      { key: "map", value: 34.4, target: 34, delta: 0.4, flag: "ok" },
      { key: "cvp", value: 2.1, target: null, delta: null, flag: "ok" },
      { key: "pap_m", value: 30, target: null, delta: null, flag: "ok" },
      { key: "spo2_pre", value: 91.5, target: 91, delta: 0.5, flag: "ok" },
      { key: "pco2", value: 57, target: 51, delta: 6, flag: "ok" },
      { key: "ph", value: 7.24, target: null, delta: null, flag: "ok" },
      { key: "bogus" },
    ],
    log: "…",
    spec: { targets: {} },
  };

  it("parses the server's build report and drops malformed rows", () => {
    const report = parseBuildReport(raw)!;
    expect(report.converged).toBe(false);
    expect(report.residuals).toHaveLength(7);
    expect(parseBuildReport(null)).toBeNull();
    expect(parseBuildReport({})!.residuals).toEqual([]);
  });

  it("reads lever limits, ignored targets and notes from an engine build report", () => {
    const report = parseBuildReport({
      ...raw,
      lever_limits: [{ key: "spo2", lever: "alveolar O2 diffusion x", value: 0.1, bounds: [0.1, 8] }, { lever: "no key" }],
      ignored_targets: ["bogus"],
      notes: ["pco2 was targeted but spontaneous breathing is off"],
    })!;
    expect(report.leverLimits).toEqual([{ key: "spo2", lever: "alveolar O2 diffusion x", value: 0.1 }]);
    expect(report.ignoredTargets).toEqual(["bogus"]);
    expect(report.notes).toHaveLength(1);
    // an older bot host sends none of these
    expect(parseBuildReport(raw)!.leverLimits).toEqual([]);
  });

  it("maps cardiac output and the extra vitals to their form fields", () => {
    const report = parseBuildReport({
      ...raw,
      residuals: [
        { key: "lvo", value: 0.286, target: null, delta: null, flag: "" },
        { key: "sys", value: 42.8, target: 48, delta: -5.2, flag: "ok" },
        { key: "dia", value: 23.9, target: 27, delta: -3.1, flag: "ok" },
        { key: "pp", value: 18.9, target: 21, delta: -2.1, flag: "" },
        { key: "spo2_post", value: 90.2, target: null, delta: null, flag: "" },
      ],
    })!;
    const rows = buildResultRows(request(), report);
    expect(rows.map((r) => r.key)).toEqual(["co", "sys", "dia", "pp", "spo2_post"]);
    expect(rows[0]).toMatchObject({ caption: "Cardiac output (echo)", unit: "L/min", measured: null });
    expect(rows[1]).toMatchObject({ measured: 48, calibrated: true, delta: -5.2, met: true });
    expect(rows[3]).toMatchObject({ caption: "Pulse pressure", unit: "mmHg", measured: 21, calibrated: true, met: true });
  });

  it("lists the solutes set in the model with their read-back after the vitals", () => {
    const report = parseBuildReport({
      ...raw,
      residuals: [{ key: "hr", value: 156, target: 158, delta: -2, flag: "ok" }],
      solutes: { lactate: { set: 4.5, value: 4.503 }, na: { set: 134, value: 134.19 }, bogus: { set: 1, value: 1 }, k: { set: "x", value: 4 } },
    })!;
    expect(report.solutes.map((x) => x.key)).toEqual(["lactate", "na"]);
    const rows = buildResultRows(request(), report);
    expect(rows.map((r) => r.key)).toEqual(["hr", "lactate", "na"]);
    expect(rows[2]).toMatchObject({ caption: "Sodium", unit: "mmol/L", model: 134.19, measured: 134, delta: 0.19, set: true, calibrated: false, met: null });
    expect(parseBuildReport(raw)!.solutes).toEqual([]); // an older bot host sends none
  });

  it("shows the ductal shunt in mL/min", () => {
    const report = parseBuildReport({ ...raw, residuals: [{ key: "q_da", value: 0.00275, target: null, delta: null, flag: "" }] })!;
    expect(buildResultRows(request(), report)[0]).toMatchObject({ key: "q_da", caption: "Ductal shunt (+ = left-to-right)", unit: "mL/min", model: 165, measured: null });
  });

  it("compares the echo's ductal flow direction with the model's net flow", () => {
    const withFlow = (pda_flow: string) => buildRequest({ ...FORM, choices: { ...FORM.choices, pda_flow } }, "pb_d")!;
    const reportWith = (q: number) => parseBuildReport({ ...raw, residuals: [{ key: "q_da", value: q / 60000, target: null, delta: null, flag: "" }] })!;
    expect(ductalFlowNote(withFlow("ltr"), reportWith(120))).toBeNull();
    expect(ductalFlowNote(withFlow("rtl"), reportWith(-40))).toBeNull();
    expect(ductalFlowNote(withFlow("rtl"), reportWith(120))).toMatch(/echo shows right-to-left.*left-to-right \(\+120 mL\/min\)/);
    expect(ductalFlowNote(withFlow("ltr"), reportWith(2))).toMatch(/close to zero/);
    expect(ductalFlowNote(withFlow("bidirectional"), reportWith(120))).toBeNull(); // not checkable from a net flow
    expect(ductalFlowNote(request(), reportWith(120))).toBeNull(); // no echo direction given
  });

  it("compares the echo's atrial shunt direction with the model's foramen ovale flow", () => {
    const withFlow = (fo_flow: string) => buildRequest({ ...FORM, choices: { ...FORM.choices, fo_flow } }, "pb_f")!;
    const reportWith = (q: number) => parseBuildReport({ ...raw, residuals: [{ key: "q_fo", value: q / 60000, target: null, delta: null, flag: "" }] })!;
    expect(atrialFlowNote(withFlow("ltr"), reportWith(50))).toBeNull();
    expect(atrialFlowNote(withFlow("ltr"), reportWith(-14))).toMatch(/echo shows left-to-right atrial flow.*right-to-left \(-14 mL\/min\).*flap valve/);
    expect(atrialFlowNote(withFlow("bidirectional"), reportWith(-14))).toBeNull();
    expect(buildResultRows(request(), reportWith(50))[0]).toMatchObject({ key: "q_fo", caption: "Atrial shunt (+ = left-to-right)", unit: "mL/min", model: 50, calibrated: false });
  });

  it("marks systolic and diastolic as missed when the pulse pressure was missed", () => {
    const report = parseBuildReport({
      ...raw,
      unmet: ["pp"],
      residuals: [
        { key: "sys", value: 42.8, target: 48, delta: -5.2, flag: "ok" },
        { key: "dia", value: 23.9, target: 27, delta: -3.1, flag: "ok" },
        { key: "pp", value: 18.9, target: 21, delta: -2.1, flag: "" },
        { key: "map", value: 32.9, target: 34, delta: -1.1, flag: "ok" },
      ],
    })!;
    const met = Object.fromEntries(buildResultRows(request(), report).map((r) => [r.key, r.met]));
    expect(met).toEqual({ sys: false, dia: false, pp: false, map: true });
  });

  it("compares a post-ductal SpO2 with the model's post-ductal value", () => {
    const f: PatientForm = { ...FORM, choices: { ...FORM.choices, spo2_site: "postductal" } };
    const req = buildRequest(f, "pb_post")!;
    const report = parseBuildReport({
      ...raw,
      residuals: [
        { key: "spo2_pre", value: 93, target: null, delta: null, flag: "ok" },
        { key: "spo2_post", value: 90.5, target: null, delta: null, flag: "" },
      ],
    })!;
    const [pre, post] = buildResultRows(req, report);
    expect(pre).toMatchObject({ key: "spo2_pre", caption: "SpO2 pre-ductal", measured: null });
    expect(post).toMatchObject({ key: "spo2", model: 90.5, measured: 91, calibrated: false, delta: -0.5 });
  });

  it("compares the model with calibrated targets and with check-only measurements", () => {
    const rows = buildResultRows(request(), parseBuildReport(raw)!);
    const row = (k: string) => rows.find((r) => r.key === k)!;
    expect(row("hr")).toMatchObject({ model: 156.2, measured: 158, delta: -1.8, calibrated: true, met: true });
    expect(row("pco2")).toMatchObject({ calibrated: true, met: false, delta: 6 });
    expect(row("spo2")).toMatchObject({ caption: "SpO2", measured: 91, calibrated: true });
    // pH was measured but not targeted: compared by the app, not by the builder
    expect(row("ph")).toMatchObject({ model: 7.24, measured: 7.28, delta: -0.04, calibrated: false, met: null });
    // not measured at all: model value only
    expect(row("cvp")).toMatchObject({ measured: null, delta: null, calibrated: false });
    expect(row("pap_m").caption).toBe("Mean pulmonary artery pressure");
  });
});
