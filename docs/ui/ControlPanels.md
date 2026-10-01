# Control Panels

The control panels are the Vue layer's **write side**: the components in `src/components/controls/` that mutate the running simulation. Every one of them sits on the CONTROL plane — they read engine state from `useExplain()` (`modelState`, the ~1 Hz `slowValues` stream) and push edits back through a small, fixed set of write methods. They never touch the ~60 Hz DATA plane (`useRealtimeBus`). All panels live inside `src/pages/MainPage.vue`, in the three-column PrimeVue `Tabs` layout.

There is **no `ParameterPanel.vue`** — the generic, registry-driven editor is `ModelEditor.vue`. The bespoke panels (`VentilatorPanel`, `EclsPanel`, …) are hand-built consoles for one device each; the generic editor covers everything else.

## What lives here

| File | Responsibility |
|---|---|
| `ModelEditor.vue` | Generic, `model_interface`-driven editor — pick any model, render one control per declared field |
| `VentilatorPanel.vue` | Mode-aware ventilator console (PC / PRVC / PS / CPAP) + measured read-outs |
| `EclsPanel.vue` | ECMO/ECLS console — pump, sweep gas, cannulas, resistance factors |
| `ResuscitationPanel.vue` | CPR console — chest compressions + ventilations, takes over the ventilator |
| `PregnancyPanel.vue` | Uterus + MaternalPlacenta console — gestation, coupling, contractions |
| `ScalerPanel.vue` | Allometric/group scaling via `ModelScaler` |
| `EventSchedulerPanel.vue` | Build/save/arm named bundles of timed prop changes (`configuration.events`) |
| `SaveStatePanel.vue` | Snapshot engine state → scenario file or per-user cloud state |
| `AdminUsersButton.vue` | Admin-only: list users, toggle the model-developer flag |

## The write methods (`useExplain.ts`)

Every panel writes through these and nothing else:

| Method | Engine call | Use |
|---|---|---|
| `setProp(prop, value, it=1, at=0)` | `Model.setPropValue` | Direct prop write; numeric `value` **tweens** over `it` s after an `at` s delay (type 0), booleans/strings swap instantly |
| `call(fn, args=[], at=0)` | `Model.callModelFunction` | Invoke a model method (setter with side-effects) |
| `scale(group, factor=1.0)` | `Model.scaleModel` | Allometric scaling via `ModelScaler` |
| `refreshState()` | `Model.getModelState` | Pull a fresh whole-model state snapshot |
| `watchSlow(paths)` | `Model.watchModelPropsSlow` | Register dot-paths on the ~1 Hz watchlist |

`prop`/`fn` are dot-paths like `"Ventilator.peep_cmh2o"`. Panels pass `it = 0` for control writes (no tween — apply now). The setter-vs-prop choice is the key contract below.

---

## ModelEditor.vue

The fully generic editor. Props/emits: none — it is self-contained.

- A `Select` lists every model name from `modelState.models`. On selection, `getInterface(name)` (from `useModelInterface()`) resolves the model's `model_type` and returns its `InterfaceField[]` from the UI registry. See [ModelInterface](./ModelInterface.md) for the schema.
- `groupByEditMode()` buckets fields into accordion sections (`basic` open by default; `extra` / `factors` / `advanced`).
- **One control per field type:** `number`/`factor` → `Slider` or `InputNumber`; `boolean` → `ToggleSwitch`; `list` → `Select`; `multiple-list` → `MultiSelect` (model instances of allowed types — structural, applies on rebuild); `function` → per-arg inputs + a play button; `prop-list` → two dependent `Select`s; `dict` → one `InputNumber` per key; `string`/`reference` → read-only `InputText`.
- **Display ↔ raw via `factor`:** `toDisplay(f, raw) = raw * (f.factor ?? 1)`, `toRaw(f, ui) = ui / factor`. Numeric writes go out as raw; the field's `delta`, `rounding`, `ll`/`ul` drive the input.
- **Value-snapshot-on-selection:** `syncLocal()` copies the model's current values into a local editable buffer when the selection changes **or** a new `modelState` snapshot arrives (rebuild / `Refresh values` button → `refreshState()`). Mid-edit values are never overwritten unless one of those events fires — there is no per-prop async read path.

How it writes:

| Field type | Write |
|---|---|
| number / factor | `setProp(`Model.target`, toRaw(f, v), 0)` |
| boolean | `setProp(path, v, 0)` |
| list / multiple-list | `setProp(path, v, 0)` |
| dict value | `setProp(`Model.target.key`, toRaw(f, v), 0)` (3-part nested path) |
| prop-list | two `setProp` writes (`target_model`, `target_prop`) |
| function | `call(`Model.target`, args, 0)` (args run through `toRaw` for numbers) |

`listOptions()` picks the first non-empty of `choices`/`options` (a field may carry an empty `options: []` plus a populated `choices` without `custom_options`).

---

## VentilatorPanel.vue

Bespoke ventilator console. Targets the `Ventilator` model. A `SelectButton` picks the mode (`PC`/`PRVC`/`PS`/`CPAP`); only the fields in `MODE_FIELDS[mode]` plus `COMMON` (PEEP, FiO₂) are shown. `synchronized` adds the trigger-% field in PC/PRVC.

**Write contract — most props go through `setProp()`, but two paths MUST use `call()`:**

| Control | Write | Why |
|---|---|---|
| FiO₂ | `call("Ventilator.set_fio2", [v/100], 0)` | re-derives inspired-gas composition; setter takes a **fraction** |
| ET ⌀ / length | `call("Ventilator.set_ettube_diameter\|set_ettube_length", [v], 0)` | re-derives tube-resistance coefficients |
| Enable | `call("Ventilator.switch_ventilator", [enabled], 0)` | toggles gas-circuit sub-models + blocks the spontaneous `MOUTH_DS` path — `is_enabled` alone would not |
| Manual breath | `call("Ventilator.trigger_breath", [], 0)` | |
| All other settings | `setProp("Ventilator.<p>", v/(factor??1), 0)` | plain props |

Mode (`vent_mode`) and `synchronized` are plain `setProp`. In `PS` the Synchronized switch shows on and is disabled: the engine always runs patient triggering in PS (explain-engine #6), so `synchronized` only matters for PC/PRVC. Display scaling: `tidal_volume` carries `factor: 1000` (L → mL); FiO₂ is shown ×100.

Measured read-outs (`exp_tidal_volume`, `minute_volume`, `compliance`, `pip_cmh2o`, `etco2`) come off the slow stream via `watchSlow(SLOW_PATHS)`, **re-registered on every `modelReady`** because `build()` resets the DataCollector watchlist.

---

## EclsPanel.vue

Bespoke ECLS/ECMO console. Targets the `Ecls` model. **Every write goes through `setProp()`** — the Ecls model has no setter functions; `calc_model()` picks up prop changes each tick (re-deriving gas composition from `gas_fio2`/`gas_fico2`, toggling its sub-circuit from `ecls_running`/`ecls_clamped`).

| Control | Write |
|---|---|
| Running / Clamped | `setProp("Ecls.ecls_running\|ecls_clamped", v, 0)` |
| Pump | `setProp("Ecls.pump_type", name, 0)` — a device from the model's `pumps` library. The engine copies its H-Q / roller coefficients and sets `pump_mode` (0 centrifugal / 1 roller) from its type, so `pump_mode` is never written directly (it is read-only in the model editor too). If `pump_rpm` is above the new pump's `max_rpm`, the panel lowers it to that max (the engine doesn't clamp, and a roller at a centrifugal speed would run far too fast). |
| Oxygenator | `setProp("Ecls.oxygenator_type", name, 0)` — a device from the model's `oxygenators` library; the engine copies its O₂/CO₂ transfer ceilings (`oxy_o2_cap`/`oxy_co2_cap`) into the gas exchanger. Rated flow, surface area and prime are shown; an amber hint appears while `flow_avg` exceeds the rated flow. |
| Pump RPM, sweep gas/FiO₂/FiCO₂, humidity, gas temp | `setProp("Ecls.<p>", v/factor, 0)`; the RPM field's max follows the selected pump's `max_rpm` |
| Resistance factors (all five: pump/oxy/drainage/return/tubing) | `setProp("Ecls.<p>_res_factor", v, 0)` |
| Drainage / return cannula | `setProp("Ecls.drainage_cannula_type\|return_cannula_type", v, 0)` |
| Drainage / return site | `setProp("Ecls.drainage_site\|return_site", v, 0)` — re-routes `ECLS_DRAINAGE.comp_from` / `ECLS_RETURN.comp_to` |

Pump, oxygenator and cannula `Select` options come from the model's own `pumps` / `oxygenators` / `drainage_cannulas` / `return_cannulas` libraries (keys of the snapshot object); site options are the blood-compartment instances in the snapshot (`model_type` ∈ BloodCapacitance / BloodTimeVaryingElastance / BloodVessel / HeartChamber). Sweep FiO₂/FiCO₂ display ×100. Slow read-outs: `flow_avg`, `flow`, `pump_pressure`, `p_ven`/`p_int`/`p_art`, `sat_ven_o2`, `sat_postoxy_o2`, `pco2_postoxy`.

The generic `ModelEditor` now also exposes the full Ecls surface (registry entry in `src/model-interface/registry.ts`): config editable across basic/extra/factors/advanced, with the computed values (`drainage_res`/`return_res`, `pump_pressure`, pressures, sats, flows) as readonly snapshots. Cannula pickers stay bespoke to this panel because their options come from the runtime cannula dicts, which the static registry cannot express.

---

## ResuscitationPanel.vue

Bespoke CPR console. Targets `Resuscitation` (and mirror-writes to `Ventilator`).

| Control | Write | Why |
|---|---|---|
| Enable | `call("Resuscitation.switch_cpr", [v], 0)` | also takes over the ventilator (`switch_ventilator` + `set_pc` from `vent_pres_*`/`vent_insp_time`) and suspends spontaneous breathing |
| FiO₂ | `call("Resuscitation.set_fio2", [raw], 0)` | re-derives ventilator inspired gas; takes a fraction (`factor: 100`) |
| Compression / other settings | `setProp("Resuscitation.<p>", raw, 0)` | plain props read each tick |
| Continuous | `setProp("Resuscitation.chest_comp_cont", v, 0)` | |

**Live mirror-write:** PIP/PEEP/Tinsp are only pushed to the ventilator inside `switch_cpr()` (via `set_pc`). Each such field carries a `live: [...]` list; while CPR runs, `onField` also `setProp`s the named `Ventilator.*` props so edits take effect immediately (`vent_pres_pip` → `Ventilator.pip_cmh2o` + `pip_cmh2o_max`, etc.). The single slow read-out `chest_comp_pres` oscillates at compression frequency — the 1 Hz sample is an instantaneous peek only.

---

## PregnancyPanel.vue

Bespoke pregnancy/labor console for `Uterus` + `MaternalPlacenta`. **All plain config props → `setProp()`** (no setter side-effects). Self-disables when no `Uterus` model is present.

| Control | Write |
|---|---|
| Pregnant / Couple placenta / Contractions | `setProp("Uterus.pregnant\|couple_placenta\|contractions_running", v, 0)` |
| Gestational age (slider 0–42 wk) | `setProp("Uterus.preg_ga", v, 0)` |
| Labor fields (period, duration, amplitude, resting tone) | `setProp("<m>.<p>", v, 0)` |

Slow read-outs span both models: `Uterus.ut_blood_flow`/`iup`/`montevideo_units`/`ut_o2er`, `MaternalPlacenta.mp_blood_flow`/`mp_flow_fraction`/`mp_o2er`.

---

## ScalerPanel.vue

Allometric/group scaling. A `Select` of groups (`weight_scale`, `blood_volume`, `heart_volume`, `lung_volume`, systemic/pulmonary resistances & elastances, `heart_el_min`/`heart_el_max`) + a factor `InputNumber`.

- Apply → `scale(group, factor)` then `refreshState()`.
- Reset → `scale("reset")` then `refreshState()`.

`scale()` routes to `Model.scaleModel`, which dispatches to `ModelScaler`'s `scale_*` methods (touching only the `*_factor_scaling_ps` layer). `reset` restores `model.weight` to `_baseline_weight`. There is no slow watchlist here — values reflect after `refreshState()`.

---

## EventSchedulerPanel.vue

Builds named bundles of timed prop changes saved into `configuration.events` (via the `events` Pinia store + `useModelInterface`). A *change* = model + property (current value shown) → target value, ramp `it`, delay `at`.

- Only `number`/`factor`/`boolean`/`list` fields are settable (read-only / function / prop-list / dict excluded).
- Selecting a property seeds the target with the live value (display-scaled by `factor`).
- **Apply** → for each change, `setProp(`model.target`, value, it, at)` (the engine `TaskScheduler` tweens numerics over `it`, swaps booleans/lists instantly). Missing models are skipped.
- **Auto-fire:** watches the slow stream's `time`; an armed event with a `fire_at` fires once when sim time crosses it. A backwards time jump (reload/restart) clears the fired set. A running indicator + `ProgressBar` track the sim-time window `[at, at+it]`.
- Persistence is via the `events` store; events reload on every `modelReady`.

---

## SaveStatePanel.vue

Snapshots engine state. `saveState()` → `Model.saveModelState`; the result arrives via the `state_saved` event → `savedState`, watched here. The watcher wraps the raw state as a full scenario file (state under `model_definition`, plus diagram/animation/configuration from `loadedFileData`).

Two destinations share the capture flow:
- **file** — POST `/api/save-snapshot` (dev), local JSON download fallback in production.
- **cloud** — per-user `states` collection (`/api/states/*`); overwrite-guarded by name. Supports listing, loading (`loadFromObject`), deleting, and flagging a default state.

The file-save button is gated on `auth.user.modelDeveloper`. Load-from-object also serves local-JSON import (`onLoad`).

---

## AdminUsersButton.vue

Admin-only. Lists users (`auth.listUsers()`) in a dialog and toggles each user's `modelDeveloper` flag (`auth.setModelDeveloper(email, value)`), with a per-email in-flight guard and switch-revert on failure. Rendered only when the logged-in user is an admin (parent-guarded). No engine interaction.

---

## Wiring

```
panel control  ──setProp / call / scale──▶  useExplain()  ──▶  Model.js  ──postMessage──▶  ModelEngine (worker)
panel read-out  ◀──slowValues (rts, ~1 Hz)──  useExplain()  ◀──  Model.js  ◀──────────────  DataCollector slow watchlist
```

Every bespoke panel: `onMounted` + `watch(modelReady)` → `watchSlow(SLOW_PATHS)`; `watch(modelState)` → `syncLocal()` to re-snapshot editable values. `setProp(..., it=0)` for live control writes.

## Gotchas

- **Re-register the watchlist on every build.** `build()` resets the DataCollector watchlist, so read-out panels call `watchSlow()` on each `modelReady` — not just `onMounted`. Forgetting this leaves read-outs blank after a scenario reload.
- **Setter vs. prop is load-bearing.** Ventilator FiO₂/ET-tube and Resuscitation FiO₂ go through `call()` because they re-derive coefficients; enable/disable goes through `switch_ventilator()`/`switch_cpr()` because they retarget gas circuits and spontaneous breathing. Writing the raw prop bypasses those side-effects. Ecls and Pregnancy have **no** setters — everything is `setProp`.
- **Setters take fractions, the UI shows percent.** FiO₂ inputs are in %, but `set_fio2` expects a fraction (`v/100`).
- **`syncLocal` only re-reads on snapshot events.** Values won't update mid-edit; use the `Refresh values` button (`refreshState()`) to force a pull.
- **`modelState` is a static snapshot,** not live — after an applied change settles in the engine, call `refreshState()` to see the new value (EventScheduler does this when a run window clears).
