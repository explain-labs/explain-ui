import { describe, expect, it } from "vitest";
import { PATIENT_FIELDS, fromSpecValue, numberField, resolveTargets, toSpecValue, validateForm, type PatientForm } from "./patientSchema";

// builds a form from { key: [value, unit] } and { key: choice }
const form = (numbers: Record<string, [number, string]>, choices: Record<string, string> = {}): PatientForm => ({
  numbers: Object.fromEntries(Object.entries(numbers).map(([k, [value, unit]]) => [k, { value, unit }])),
  choices,
});
const resolve = (numbers: Record<string, [number, string]>, choices: Record<string, string> = {}) => {
  const v = validateForm(form(numbers, choices));
  expect(v.issues).toEqual([]);
  return resolveTargets(v);
};

describe("schema", () => {
  it("has unique keys", () => {
    const keys = PATIENT_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("has no free-text or date field (the form must not carry identifiers)", () => {
    for (const f of PATIENT_FIELDS) expect(["number", "choice"]).toContain(f.kind);
    expect(PATIENT_FIELDS.some((f) => /name|birth_date|dob|mrn|record/i.test(f.key))).toBe(false);
  });

  it("round-trips every unit of every number field", () => {
    for (const f of PATIENT_FIELDS) {
      if (f.kind !== "number") continue;
      const mid = (f.range[0] + f.range[1]) / 2;
      for (const u of f.units) {
        expect(u.toSpec(u.fromSpec(mid))).toBeCloseTo(mid, 6);
      }
    }
  });
});

describe("unit conversion", () => {
  it("converts grams to kilograms", () => {
    expect(toSpecValue(numberField("weight")!, 1080, "g")).toBe(1.08);
  });
  it("converts kPa to mmHg", () => {
    expect(toSpecValue(numberField("pco2")!, 6.8, "kPa")).toBe(51);
  });
  it("converts haemoglobin g/dL to mmol/L with the builder's factor", () => {
    expect(toSpecValue(numberField("hb")!, 15.3, "g/dL")).toBe(9.495);
  });
  it("converts FiO2 percent to a fraction", () => {
    expect(toSpecValue(numberField("fio2")!, 35, "%")).toBe(0.35);
  });
  it("converts length in cm to metres", () => {
    expect(toSpecValue(numberField("height")!, 36.5, "cm")).toBe(0.365);
  });
  it("rounds a displayed value to the unit's digits", () => {
    expect(fromSpecValue(numberField("pco2")!, 51, "kPa")).toBe(6.8);
  });
});

describe("validateForm", () => {
  it("returns filled-in values in SPEC units and skips empty ones", () => {
    const v = validateForm({ numbers: { weight: { value: 1080, unit: "g" }, hr: { value: null, unit: "/min" } }, choices: {} });
    expect(v.issues).toEqual([]);
    expect(v.values).toEqual({ weight: 1.08 });
  });

  it("rejects a value outside the hard range, checked in SPEC units", () => {
    const v = validateForm(form({ weight: [1.08, "g"] })); // grams field given a kg number
    expect(v.issues.map((i) => i.key)).toContain("weight");
    expect(v.values.weight).toBeUndefined();
  });

  it("rejects an unknown unit and an unknown choice", () => {
    const v = validateForm(form({ weight: [1080, "lb"], gestational_age: [28, "weeks"] }, { gas_site: "cord" }));
    expect(v.issues.map((i) => i.key).sort()).toEqual(["gas_site", "weight"]);
  });

  it("rejects NaN", () => {
    const v = validateForm(form({ weight: [1080, "g"], hr: [NaN, "/min"] }));
    expect(v.issues.map((i) => i.key)).toEqual(["hr"]);
  });

  it("requires a weight or a gestational age", () => {
    expect(validateForm(form({ hr: [150, "/min"] })).issues.map((i) => i.key)).toEqual(["weight"]);
    expect(validateForm(form({ hr: [150, "/min"], gestational_age: [28, "weeks"] })).issues).toEqual([]);
  });

  it("checks that systolic > mean > diastolic", () => {
    const w: [number, string] = [1080, "g"];
    expect(validateForm(form({ weight: w, sys: [30, "mmHg"], dia: [40, "mmHg"] })).issues).toHaveLength(1);
    expect(validateForm(form({ weight: w, sys: [50, "mmHg"], dia: [30, "mmHg"], map: [55, "mmHg"] })).issues).toHaveLength(1);
    expect(validateForm(form({ weight: w, sys: [50, "mmHg"], dia: [30, "mmHg"], map: [25, "mmHg"] })).issues).toHaveLength(1);
    expect(validateForm(form({ weight: w, sys: [50, "mmHg"], dia: [30, "mmHg"], map: [37, "mmHg"] })).issues).toEqual([]);
  });
});

describe("resolveTargets", () => {
  const W: Record<string, [number, string]> = { weight: [1080, "g"], gestational_age: [28, "weeks"] };

  it("passes structural values and measured vitals through as targets", () => {
    const r = resolve({ ...W, hr: [158, "/min"], map: [33, "mmHg"], hb: [9.6, "mmol/L"] });
    expect(r.targets).toEqual({ weight: 1.08, gestational_age: 28, hr: 158, map: 33, hb: 9.6 });
  });

  it("never sends context fields to the builder", () => {
    const r = resolve({ ...W, postnatal_age: [3, "days"], birth_weight: [1100, "g"] });
    expect(r.targets).toEqual({ weight: 1.08, gestational_age: 28 });
  });

  it("derives MAP from systolic and diastolic when it was not measured", () => {
    const r = resolve({ ...W, sys: [48, "mmHg"], dia: [27, "mmHg"] });
    expect(r.targets).toMatchObject({ sys: 48, dia: 27, map: 34 });
    expect(r.derived).toEqual([{ key: "map", value: 34, basis: "diastolic + (systolic − diastolic) / 3" }]);
    expect(r.unknown).not.toContain("map");
  });

  it("calibrates systolic and diastolic only as a pair", () => {
    for (const [k, other] of [["sys", "dia"], ["dia", "sys"]] as const) {
      const r = resolve({ ...W, [k]: [k === "sys" ? 48 : 27, "mmHg"] });
      expect(r.targets[k]).toBeUndefined();
      expect(r.targets.map).toBeUndefined();
      expect(r.checks[k]).toMatch(other === "dia" ? /diastolic/ : /systolic/);
    }
  });

  it("targets the respiratory rate of a spontaneously breathing patient only", () => {
    expect(resolve({ ...W, rr: [62, "/min"] }, { resp_support: "cpap" }).targets.rr).toBe(62);
    expect(resolve({ ...W, rr: [62, "/min"] }).targets.rr).toBe(62);
    for (const mode of ["invasive", "hfo", "niv"]) {
      const r = resolve({ ...W, rr: [40, "/min"] }, { resp_support: mode });
      expect(r.targets.rr).toBeUndefined();
      expect(r.checks.rr).toMatch(/ventilator/);
    }
  });

  it("keeps a measured MAP over the derived one", () => {
    const r = resolve({ ...W, sys: [48, "mmHg"], dia: [27, "mmHg"], map: [36, "mmHg"] });
    expect(r.targets.map).toBe(36);
    expect(r.derived).toEqual([]);
  });

  it("uses an arterial pO2 as the oxygenation target and demotes SpO2 to a check", () => {
    const r = resolve({ ...W, po2: [55, "mmHg"], spo2: [91, "%"] }, { gas_site: "arterial" });
    expect(r.targets.po2).toBe(55);
    expect(r.targets.spo2).toBeUndefined();
    expect(r.checks.spo2).toMatch(/arterial pO2/);
  });

  it("never targets a capillary or venous pO2", () => {
    for (const site of ["capillary", "venous"]) {
      const r = resolve({ ...W, po2: [40, "mmHg"], spo2: [91, "%"] }, { gas_site: site });
      expect(r.targets.po2).toBeUndefined();
      expect(r.targets.spo2).toBe(91);
      expect(r.checks.po2).toMatch(site);
    }
  });

  it("treats a gas without a sample site as capillary and says so", () => {
    const r = resolve({ ...W, po2: [60, "mmHg"], pco2: [45, "mmHg"] });
    expect(r.targets.po2).toBeUndefined();
    expect(r.targets.pco2).toBe(45);
    expect(r.warnings.join(" ")).toMatch(/sample site/);
  });

  it("does not target a post-ductal SpO2", () => {
    const r = resolve({ ...W, spo2: [88, "%"] }, { spo2_site: "postductal" });
    expect(r.targets.spo2).toBeUndefined();
    expect(r.checks.spo2).toMatch(/post-ductal/);
  });

  it("targets base excess and pCO2, and reports pH as a check when all three are given", () => {
    const r = resolve({ ...W, ph: [7.28, ""], pco2: [51, "mmHg"], be: [-4.5, "mmol/L"] }, { gas_site: "capillary" });
    expect(r.targets).toMatchObject({ pco2: 51, be: -4.5 });
    expect(r.targets.ph).toBeUndefined();
    expect(r.checks.ph).toBeDefined();
  });

  it("targets pH when there is no base excess", () => {
    const r = resolve({ ...W, ph: [7.28, ""], pco2: [51, "mmHg"] }, { gas_site: "arterial" });
    expect(r.targets).toMatchObject({ pco2: 51, ph: 7.28 });
  });

  it("keeps only the base excess of a venous gas", () => {
    const r = resolve({ ...W, ph: [7.25, ""], pco2: [58, "mmHg"], be: [-4, "mmol/L"] }, { gas_site: "venous" });
    expect(r.targets.be).toBe(-4);
    expect(r.targets.pco2).toBeUndefined();
    expect(r.targets.ph).toBeUndefined();
    expect(Object.keys(r.checks).sort()).toEqual(["pco2", "ph"]);
  });

  it("reports values the builder cannot use yet instead of sending them", () => {
    const r = resolve({ ...W, lactate: [3.1, "mmol/L"], na: [138, "mmol/L"] });
    expect(r.unsupported.sort()).toEqual(["lactate", "na"]);
    expect(r.targets).toEqual({ weight: 1.08, gestational_age: 28 });
  });

  it("sends FiO2 to the builder as a structural value", () => {
    const r = resolve({ ...W, spo2: [91, "%"], fio2: [35, "%"] });
    expect(r.targets).toMatchObject({ fio2: 0.35, spo2: 91 });
    expect(r.unsupported).not.toContain("fio2");
    expect(r.checks.fio2).toBeUndefined();
  });

  it("warns about ventilated patients, missing FiO2 and missing cardiac output", () => {
    const vent = resolve({ ...W, pco2: [51, "mmHg"] }, { gas_site: "arterial", resp_support: "invasive" });
    expect(vent.warnings.join(" ")).toMatch(/ventilated/);
    const spont = resolve({ ...W, pco2: [51, "mmHg"] }, { gas_site: "arterial", resp_support: "cpap" });
    expect(spont.warnings.join(" ")).not.toMatch(/ventilated/);

    expect(resolve({ ...W, spo2: [91, "%"] }).warnings.join(" ")).toMatch(/No FiO2/);
    expect(resolve({ ...W, spo2: [91, "%"], fio2: [40, "%"] }).warnings.join(" ")).not.toMatch(/FiO2/);
    expect(resolve({ ...W, spo2: [97, "%"], fio2: [21, "%"] }).warnings.join(" ")).not.toMatch(/FiO2/);

    expect(resolve({ ...W, map: [33, "mmHg"] }).warnings.join(" ")).toMatch(/cardiac output/);
    expect(resolve({ ...W, map: [33, "mmHg"], co: [250, "mL/min"] }).warnings.join(" ")).not.toMatch(/cardiac output/);
  });

  it("lists the unmeasured structural and vital fields as unknowns", () => {
    const r = resolve({ ...W, hr: [158, "/min"] });
    expect(r.unknown).toContain("hb");
    expect(r.unknown).toContain("map");
    expect(r.unknown).not.toContain("hr");
    expect(r.unknown).not.toContain("weight");
    // context, check-only and not-yet-supported fields are never "unknowns"
    for (const k of ["postnatal_age", "hco3", "fio2", "lactate"]) expect(r.unknown).not.toContain(k);
    // unmeasured vitals the builder can calibrate are unknowns (the bot marks them "emergent")
    for (const k of ["sys", "dia", "rr"]) expect(r.unknown).toContain(k);
  });
});
