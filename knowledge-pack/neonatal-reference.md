# Neonatal reference values for the patient builder

> **DRAFT — awaiting clinical review.** Tables 1 and 3 are copied from the Explain engine
> (they are the values the builder itself uses). Table 2 is a first draft of textbook
> values that a clinician has not yet signed off. When you fill a value from this file,
> cite it as `neonatal-reference.md (draft)` and name the table.

This file is the **first** place to look when a patient-builder form leaves a value
empty (see "Patient-builder form requests" in `command-protocol.md`). Use web search only
for something this file does not cover, and then cite the page you used.

All values are in the builder's units: weight kg, length m, haemoglobin mmol/L,
pressures mmHg, gases mmHg, base excess and bicarbonate mmol/L.

## 1. Size by gestational age

The builder's own seed table (`explain-engine/scripts/build_patient.mjs`, `PRETERM_SEED`;
term row from the `term_neonate` scenario). Use it to fill a missing **weight** or
**length** from the gestational age, and to estimate a missing **gestational age** from a
weight. It describes an appropriately grown baby at birth; it is not a growth chart.

| Gestational age (wk) | Weight (kg) | Length (m) |
|---|---|---|
| 24 | 0.64 | 0.310 |
| 26 | 0.85 | 0.330 |
| 28 | 1.00 | 0.355 |
| 30 | 1.35 | 0.385 |
| 32 | 1.70 | 0.420 |
| 34 | 2.20 | 0.450 |
| 36 | 2.70 | 0.480 |
| 40 | 3.545 | 0.519 |

Interpolate linearly between rows. A measured weight always wins: never replace it with
the table value because the baby looks small or large for gestational age.

When only a weight is known, a gestational age read off this table is an **assumption**
(status `assumed`), not a reference value: a growth-restricted baby is older than its
weight suggests.

## 2. Haemoglobin (draft)

Fill a missing haemoglobin from the gestational age and postnatal age. Values in mmol/L
(g/dL in brackets; 1 g/dL = 0.6206 mmol/L).

| Gestational age at birth | First week | 2–4 weeks | 6–10 weeks |
|---|---|---|---|
| under 29 wk | 9.0 (14.5) | 7.4 (12) | 5.6 (9) |
| 29–32 wk | 9.3 (15) | 7.8 (12.5) | 5.9 (9.5) |
| 33–36 wk | 9.9 (16) | 8.4 (13.5) | 6.2 (10) |
| term | 10.5 (17) | 9.6 (15.5) | 7.1 (11.5) |

After the first week the real value depends on blood sampling losses and transfusions,
which this table cannot know. Beyond the first week, or when the form says a transfusion
was given, mark the fill `assumed`, not `reference`.

## 3. Vital signs and blood gas by gestational age

The engine's own normal-range table (`explain-engine/scripts/_probe.mjs`, `RANGES`), which
the builder uses to flag its results. These are **calibration guard-rails, deliberately
wide, not diagnostic criteria**. Use them only to describe an unmeasured vital as
`emergent` ("left to the model; expected 26 to 42"). **Never turn a value from this table
into a calibration target.**

| | 24 wk | 26 wk | 28 wk | 30 wk | 32 wk | 34 wk | 36 wk | term |
|---|---|---|---|---|---|---|---|---|
| Heart rate (/min) | 135 to 200 | 135 to 198 | 130 to 190 | 128 to 185 | 125 to 180 | 120 to 175 | 115 to 170 | 100 to 160 |
| Respiratory rate (/min) | 40 to 85 | 40 to 80 | 40 to 75 | 40 to 72 | 40 to 70 | 40 to 65 | 38 to 62 | 30 to 60 |
| Systolic pressure | 24 to 58 | 28 to 60 | 30 to 65 | 35 to 68 | 40 to 70 | 45 to 75 | 48 to 80 | 55 to 90 |
| Diastolic pressure | 16 to 40 | 18 to 42 | 18 to 45 | 20 to 46 | 22 to 48 | 25 to 50 | 27 to 52 | 30 to 55 |
| Mean arterial pressure | 20 to 35 | 22 to 38 | 26 to 42 | 28 to 44 | 30 to 45 | 35 to 50 | 38 to 54 | 40 to 60 |
| Central venous pressure | 0 to 6 | 0 to 7 | 0 to 7 | 0 to 8 | 1 to 8 | 1 to 8 | 1 to 8 | 2 to 8 |
| Mean pulmonary artery pressure | 14 to 38 | 15 to 38 | 16 to 38 | 15 to 36 | 15 to 35 | 14 to 32 | 13 to 31 | 12 to 30 |
| SpO2, pre-ductal (%) | 80 to 93 | 83 to 94 | 85 to 95 | 86 to 95 | 86 to 96 | 88 to 97 | 90 to 98 | 93 to 100 |
| pH | 7.15 to 7.32 | 7.18 to 7.34 | 7.20 to 7.36 | 7.21 to 7.37 | 7.22 to 7.38 | 7.25 to 7.40 | 7.27 to 7.41 | 7.30 to 7.42 |
| pCO2 | 48 to 70 | 46 to 66 | 45 to 62 | 44 to 60 | 42 to 58 | 40 to 55 | 38 to 52 | 35 to 45 |
| pO2 | 35 to 60 | 38 to 62 | 40 to 65 | 41 to 68 | 42 to 70 | 45 to 75 | 48 to 80 | 50 to 85 |
| Bicarbonate | 15 to 24 | 16 to 24 | 16 to 24 | 16 to 24 | 17 to 24 | 18 to 24 | 18 to 24 | 18 to 24 |
| Base excess | −11 to 2 | −10 to 2 | −9 to 2 | −8 to 2 | −8 to 2 | −7 to 2 | −6 to 2 | −6 to 2 |

Use the column nearest to the gestational age at birth. The preterm columns describe an
untreated preterm baby breathing room air on the model's lungs, which is why their pCO2
runs high and their pO2 low.

## 4. What the builder cannot set yet

Do not put these in a build SPEC; the builder ignores them (it lists them as ignored).
If the form supplies one, it arrives under `checks`, and you leave it there.

- post-ductal SpO2, end-tidal CO2 and the PDA flow direction (compared with the model by
  the app, never targets)
- oxygen consumption, blood volume, P50 / fetal haemoglobin fraction, lung compliance,
  dead space: these stay at the baseline scenario's values
