# Patient builder

Builds a simulated patient from measurements taken on a real neonate. The user fills in a
structured form; the AI bot fills in the structural values that were not measured; the bot
host calibrates a baseline scenario to the measured targets; the app shows what the patient
was built from and how close it came, and the user loads it.

> **Status: unfinished.** The tab is listed in `UNFINISHED_PANELS` (`src/pages/MainPage.vue`),
> so it shows under `npm run dev` only. It is waiting for the engine's builder to apply an
> FiO2 — until then a patient on oxygen is fitted as if breathing room air.

It extends the existing build-a-patient path (see [ChatAndBot](./ChatAndBot.md) and
`knowledge-pack/command-protocol.md`): the same `explain-build` SPEC, the same builder
(`explain-engine/scripts/build_patient.mjs`), the same `artifact` in the `/api/chat`
response. What it adds is a form in place of typed text, rules in place of the bot's
judgement about which values to calibrate to, and a record of where every value came from.

## Files

| File | Role |
|---|---|
| `src/services/patientSchema.ts` | `PATIENT_FIELDS` (the form), `validateForm`, `resolveTargets` (the target rules). Pure TS. |
| `src/services/patientBuilder.ts` | `buildRequest` (the prompt), `parseProvenance`, `parseBuildReport`, `checkSpec`, `buildValueRows`, `buildResultRows`. Pure TS. |
| `src/stores/patientBuilder.ts` | Form state, the `/api/chat` call, the result, Apply and Save. |
| `src/components/controls/PatientBuilderPanel.vue` | The form and the result view. Centre column, tab `builder`. |
| `knowledge-pack/command-protocol.md` | "Patient-builder form requests": the bot's side of the protocol. |
| `knowledge-pack/neonatal-reference.md` | The reference values the bot fills unknowns from. |
| `bot-host/api.py` | Runs the builder; returns `artifact` and the structured report `build`. |

## The form schema

`PATIENT_FIELDS` is the single source of truth for the form, the prompt and the result
tables. A number field has:

- `units` — one or more display units with conversion to the **SPEC unit** (the builder's
  unit: kg, m, mmHg, mmol/L, fraction). Converted values are kept to 4 significant digits.
- `range` — hard limits in SPEC units; a value outside is rejected as a typing error.
- `role` — what the builder does with it:
  - `structural`: written into the model before calibration (weight, haemoglobin, …);
  - `iterated`: a calibration target the builder tunes a lever to reach;
  - `check`: not targeted, reported next to the model's value;
  - `context`: never reaches the builder (postnatal age, birth weight).
- `since` — `"A"` if the current builder can use it, `"B"` if it cannot yet (FiO2,
  respiratory rate, systolic/diastolic as targets, lactate, electrolytes, glucose, albumin,
  post-ductal SpO2). A `"B"` value is still collected and shown as "not used yet". When the
  engine gains a target, flip its `since` to `"A"` and, if needed, its `role`.

Choice fields (sample site, respiratory support, probe site, …) are always `context`.

**There is no free-text field and no date field, on purpose.** The form is sent to the AI
bot, which runs through the Claude API. Postnatal age is a number of days; the built
patient's name in the request is a random `pb_xxxxxxxx`. The only text the user types is
the name to save under, which stays in the app (it goes into the saved scenario, not into
the request).

## Target rules (`resolveTargets`)

Which measured values the builder calibrates to is decided here, deterministically, not by
the bot:

| Rule | Reason |
|---|---|
| MAP = diastolic + (systolic − diastolic)/3 when MAP is empty | deterministic; shown as "Derived" |
| An arterial pO2 is the oxygenation target and SpO2 becomes a check | the builder silently prefers `po2` over `spo2` when given both |
| A capillary or venous pO2 is never a target | it does not reflect arterial oxygenation |
| A venous pCO2 and pH are not targets; a venous base excess is | variable arteriovenous difference |
| Base excess + pCO2 are the targets and pH becomes a check | the builder silently prefers `be` over `ph` |
| A post-ductal SpO2 is a check | the engine reads saturation pre-ductally |
| A gas with no sample site is treated as capillary | conservative default, with a warning |

It also produces the warnings shown under the form: ventilated patient (the builder reaches
a pCO2 through spontaneous breathing drive), no FiO2, an FiO2 above 21% that cannot be
applied yet, and no cardiac output (output and resistance then come from the baseline).

## Request and response

`buildRequest` produces the whole prompt — a marker line and one fenced JSON block:

````
[explain-patient-form]

```explain-patient-form
{"schema":1,"request_id":"pb_3fa94c1e","targets":{…},"checks":{…},"context":{…},"unknown":[…],"units":{…}}
```
````

The store posts `{ prompt }` to `/api/chat` with **no `context` and no `conversation_id`**.
Without `context` both proxies forward the prompt unchanged, so the marker stays on the
first line; without a conversation id every build is a fresh bot conversation and no
earlier patient's numbers can carry over. This is why the store does not go through the
chat store, which also posts a chat bubble and refuses `loadDefinition` in Guided scope.

The bot replies with prose, one `explain-provenance` block and one `explain-build` block.
The bot host replaces the build block with the verdict line and a `loadDefinition` card,
and adds `artifact` (the built scenario) and `build` (the calibration report and the SPEC
it ran). The store then:

1. `parseProvenance(answer)` — the bot's account of each value it filled in:
   `reference` (from a named source), `assumed` (no source) or `emergent` (not set; the
   model produces it). This is untrusted model output shown on screen: unknown keys and
   statuses are dropped, values are range-checked against the schema, text is capped, a
   source URL is kept only when it is http(s), and the panel renders it as text.
2. `parseBuildReport(body.build)` — convergence, and for every reported vital its value,
   target, difference and normal-range flag.
3. `checkSpec(build.spec, request, provenance)` — compares the SPEC that was actually built
   with the form. A measured value that was changed or dropped, a vital added as a target
   although it was not measured, and a structural value filled in without a provenance row
   are each reported in a red box above the results.

Measured rows in the result always come from the form state, never from the bot's answer.

The request is aborted after 280 s: the bot host caps the build at 300 s and both proxies
give up at 300 s.

## Result, Apply, Save

- **Built patient at steady state** — model value, measured value and difference for every
  vital the builder reports; "target" rows were calibrated to, "compared only" rows were
  measured but not targeted (the app computes that difference itself).
- **What the patient was built from** — every value with its status (Measured, Derived,
  Reference, Assumed, Left to the model), what the builder did with it, and the source.
- **Load this patient** — `useExplain().loadFromObject()` with the built scenario, after
  adding a record under `configuration.patient_builder`: `{ schema, built_at, form,
  provenance, spec, report }`. `configuration` is the part of a scenario file that survives
  a cloud save untouched, so the record travels with the saved patient.
- **Save** — with a database and a normal account, `useStatesStore().saveCurrent()` (shown
  under "My saved states"); otherwise a JSON download, loadable with the Load JSON button.
  It never calls `/api/save-snapshot`, which writes into the engine submodule.

## Tests

`src/services/patientSchema.test.ts` and `src/services/patientBuilder.test.ts` cover the
schema invariants, unit conversion, validation, every target rule, the prompt, provenance
and report parsing (including malformed and hostile input), the SPEC check and the result
rows. Run with `npm test`.

To try the panel without the live bot, point the dev server at any HTTP server that
answers `POST /v1/ask` with `{ answer, conversation_id, artifact, build }`:
`EXPLAIN_BOT_URL=http://127.0.0.1:<port> EXPLAIN_BOT_API_KEY=x npm run dev`. A real
`artifact` comes from running the builder by hand:

```sh
echo '{"baseline":"term_neonate","name":"pb_test","targets":{"weight":1.08,"gestational_age":28,"hr":158,"map":34,"spo2":91,"pco2":51,"be":-4.5}}' \
  | node explain-engine/scripts/build_patient.mjs > pb_test.json
```
