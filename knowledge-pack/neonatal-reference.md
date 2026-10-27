# Neonatal reference values for the patient builder

> **DRAFT — awaiting clinical review.** Tables 1 and 3 are copied from the Explain engine
> (they are the values the builder itself uses). Table 2 is a first draft of textbook
> values that a clinician has not yet signed off. When you fill a value from this file,
> cite it as `neonatal-reference.md (draft)` and name the table.

The patient builder currently builds **term** patients only (variations of `term_neonate_72h`);
other patients will follow when they have been rebuilt and validated.

This file is the **first** place to look when a patient-builder form leaves a value
empty (see "Patient-builder form requests" in `command-protocol.md`). Use web search only
for something this file does not cover, and then cite the page you used.

All values are in the builder's units: weight kg, length m, haemoglobin mmol/L,
pressures mmHg, gases mmHg, base excess and bicarbonate mmol/L.

## 1. Size

The term baseline `term_neonate_72h`: weight **3.545 kg**, length **0.519 m**. A measured weight
or length always wins; use these only when the form leaves them empty.

## 2. Haemoglobin (draft)

Fill a missing haemoglobin from the postnatal age. Values in mmol/L (g/dL in brackets;
1 g/dL = 0.6206 mmol/L).

| | First week | 2–4 weeks | 6–10 weeks |
|---|---|---|---|
| term | 10.5 (17) | 9.6 (15.5) | 7.1 (11.5) |

After the first week the real value depends on blood sampling losses and transfusions,
which this table cannot know. Beyond the first week, or when the form says a transfusion
was given, mark the fill `assumed`, not `reference`.

## 3. Vital signs and blood gas

The engine's own normal-range table for the term neonate (`explain-engine/scripts/_probe.mjs`,
`RANGES.neonate`), which the builder uses to flag its results. These are **calibration
guard-rails, not diagnostic criteria**. Use them only to describe an unmeasured vital as
`emergent` ("left to the model; expected 45 to 72"). **Never turn a value from this table
into a calibration target.**

| | term (72 h) |
|---|---|
| Heart rate (/min) | 91 to 145 |
| Respiratory rate (/min) | 32 to 57 |
| Systolic pressure | 60 to 89 |
| Diastolic pressure | 31 to 61 |
| Mean arterial pressure | 45 to 72 |
| Central venous pressure | 2 to 8 |
| Mean pulmonary artery pressure | 12 to 30 (higher in the first 2 days) |
| SpO2, pre-ductal (%) | 94.5 to 100 |
| Mixed venous saturation (%) | 70 to 80 |
| pH | 7.31 to 7.47 |
| pCO2 | 28.5 to 48.7 |
| pO2 | 60 to 90 |
| Bicarbonate | 18 to 24 |
| Base excess | −4 to 2 |

## 4. What the builder cannot set yet

Do not put these in a build SPEC; the builder ignores them (it lists them as ignored).
If the form supplies one, it arrives under `checks`, and you leave it there.

- post-ductal SpO2, end-tidal CO2 and the PDA and atrial shunt flow directions (compared
  with the model by the app, never targets)
- oxygen consumption, blood volume, P50, lung compliance,
  dead space: these stay at the baseline scenario's values
