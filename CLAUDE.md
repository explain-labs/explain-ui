# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Note: the `CLAUDE.md` checked in at `/Users/timantonius/Projects/CLAUDE.md` describes an unrelated NICU CSV-dataset project. It does **not** apply here — this directory is the Explain physiological simulation engine. Ignore that file when working in this tree.

## What this is

This directory is a **standalone Vue 3 + Vite + TypeScript web app** built around the `explain-engine/` physiological simulation engine (plain ES modules that run inside a **Web Worker**) plus a set of scenario definitions (`model_definitions/`). The app was migrated off Quasar; it now uses Vue 3 + Vite + TypeScript + PrimeVue + Tailwind, while the engine in `explain-engine/` is kept framework-agnostic. The repo has its own `package.json`, `vite.config.ts`, and `node_modules`.

Run it from this directory: `npm run dev` (Vite dev server), `npm run build` (`vue-tsc --noEmit && vite build`), `npm run typecheck`, `npm run preview`. The Vue layer bootstraps the engine through `src/composables/useExplain.ts` — a singleton that does `new Model()` (imported as `@explain/Model`, an alias to `./explain-engine/` set in `vite.config.ts`/`tsconfig.json`). `Model.js` spawns the worker via `new Worker(new URL("./ModelEngine.js", import.meta.url), { type: "module" })`. Scenario definitions are served from `public/model_definitions/`.

## Architecture

Two threads, one wire protocol:

- **`explain-engine/Model.js`** — main-thread wrapper (extends `ModelEmitter`). Spawns the worker, exposes the public API (`build`/`load`/`start`/`stop`/`calculate`/`setPropValue`/`callModelFunction`/`watchModelProps`/`scaleModel`/…), and re-emits worker responses as events you subscribe to with `explain.on(event, handler)`.
- **`explain-engine/ModelEngine.js`** — the Web Worker. Owns the live `model` object (`{ models: {…}, modeling_stepsize, model_time_total, ncc_* counters, … }`), the build/step loop, and the GET/POST/PUT/DELETE message router (`self.onmessage`).

**Message envelope** (both directions): `{ type: "GET"|"PUT"|"POST"|"DELETE", message: string, payload: any }`. `Model.send()` posts to the worker; the worker `_send()`/`postMessage()` back. `Model.receive()` maps inbound types (`state`, `data`, `rtf`/`rts` realtime fast/slow, `model_ready`, `status`, `error`, …) to emitter events. Payloads crossing the boundary are JSON-stringified for `build`/`property_value`/`call` and re-parsed by `_normalize_payload` in the worker.

**Build flow** (`ModelEngine.build`): clears state → for each entry in `model_definition.models`, looks up the class by `model_type` in `available_model_map` and instantiates it → calls `init_model(args)` on every instance (args = `[{key, value}, …]` derived from the definition) → attaches `DataCollector`, `TaskScheduler`, `ModelScaler` helpers and freezes `model._baseline_weight`. Any instantiation/init error aborts the build and emits a `status` ERROR. On success it emits `model_ready`.

**Step loop:** `_model_step()` calls `step_model()` on every model in insertion order, then `DataCollector.collect_data()`, then `TaskScheduler.run_tasks()`, then advances `model.model_time_total` by `modeling_stepsize`. `calculate(seconds)` runs `seconds / modeling_stepsize` steps synchronously; `start()` runs `_model_step_rt` on a `setInterval` (`rtInterval` 0.015 s wall-clock, batching `rtInterval / modeling_stepsize` model steps per tick). Step errors are caught per-model when `ENABLE_STEP_ERROR_GUARD` is true so one bad model doesn't kill the loop.

## Model class contract

Every model lives in `explain-engine/base_models/`, `explain-engine/component_models/`, or `explain-engine/device_models/` and extends `BaseModelClass` (directly or via an intermediate like `Capacitance`/`Resistor`/`TimeVaryingElastance`). Contract:

- static `model_type` (string key used at build time and in definition JSON). Model classes carry **no UI metadata** — the parameter-edit schema lives in the UI layer at `src/model-interface/` (see below), not on the class.
- constructor `(model_ref, name = "")` — `model_ref` is the whole engine `model` object; store it as `this._model_engine` (done by the base). Initialize independent props (config), dependent props (computed outputs), and `_`-prefixed local refs. (`build()` passes a 3rd `model_type` arg that the base constructor ignores.)
- `init_model(args)` — applies config (base impl maps `args` `{key,value}` onto `this[key]`, then instantiates/inits anything declared in `this.components`). Override to resolve cross-model references (e.g. `this._lv = this._model_engine.models["LV"]`) and set `_is_initialized = true`.
- `step_model()` — base impl runs `calc_model()` only when `is_enabled && _is_initialized`. Don't override unless you need custom gating.
- `calc_model()` — where the physics happens. Override this.

**Registering a new model:** create the class, give it a static `model_type`, then **add an `export` line in `explain-engine/ModelIndex.js`** (the engine builds its `available_model_map` from everything ModelIndex exports). Forgetting the export is the usual cause of "model type not found" at build. To make its parameters editable in the app, add a `model_type` entry to `src/model-interface/registry.ts`.

**Student/experimental models use a parallel seam instead** — `explain-engine/custom_models/` + an export line in `explain-engine/CustomModelIndex.js`, with UI fields in `src/model-interface/custom-registry.ts`. Both stubs are empty on `main` by design (that emptiness is what keeps student branches rebase-clean), custom entries take precedence over the built-in ones on `model_type` collision, and `helpers/ModelRegistry.js` is what lets `BaseModelClass` instantiate a custom model as a composite sub-component without an import cycle. See [`STUDENT_WORKFLOW.md`](STUDENT_WORKFLOW.md).

## The factor/effective-value pattern (important)

Core physics params (`el_base`, `u_vol`, `el_k` on capacitances; `r_for`, `r_back`, `r_k` on resistors; analogous on elastances) are never used raw in calculations. Each has three multiplier layers, combined additively against the base into an `*_eff` value:

- `<p>_factor` — **non-persistent**; reset to `1.0` every step (transient interventions).
- `<p>_factor_ps` — **persistent**; survives steps (user/scenario adjustments).
- `<p>_factor_scaling_ps` — **persistent scaling**; written by `ModelScaler` for allometric/weight scaling.

Formula (see `Capacitance.calc_elastances`, `Resistor.calc_resistance`): `p_eff = p + (factor-1)*p + (factor_ps-1)*p + (factor_scaling_ps-1)*p`. When adding a tunable parameter, follow this convention so it composes with interventions and scaling. `ModelScaler` (`explain-engine/helpers/ModelScaler.js`) only ever touches the `*_scaling_ps` layer; `scaleModel(group, factor)` in the API routes to its many `scale_*` methods via the big `switch` in `ModelEngine.scale_model`. `reset` restores `model.weight = model._baseline_weight`.

## Flow / pressure mechanics

`Resistor` reads `comp_from.pres` and `comp_to.pres`, computes `flow`, then moves volume by calling `comp_from.volume_out(flow*dt)` / `comp_to.volume_in(...)`. `volume_out` returns any volume it couldn't supply so the resistor doesn't create volume from an empty compartment. `Capacitance.calc_pressure` derives `pres` from `(vol - u_vol_eff)` with linear + non-linear (`el_k`) terms plus `pres_ext`. `BloodCapacitance.volume_in` additionally mixes `to2`/`tco2`/`solutes`/`drugs`/`temp`/`viscosity` by the incoming volume fraction — this is how blood gases/solutes propagate through the circuit.

## Cardiac/breathing cycle counters

`Heart` (and ventilator/breathing) drive timing off counters that live on the **engine `model` object**, not the component: `model.ncc_ventricular`, `model.ncc_atrial`, `ncc_breathing_insp/exp`, `ncc_ventilator_insp/exp` (initialized in `build()`). `DataCollector` always watches `Heart.ncc_ventricular`/`Heart.ncc_atrial` for ECG regardless of the user watchlist.

## DataCollector & TaskScheduler

- **`DataCollector`** keeps two watchlists — fast (`watch_list`, `sample_interval` 0.005 s) and slow (`watch_list_slow`, 1.0 s). Watched props are dot-paths `"Model.prop"` or `"Model.prop.subprop"` resolved against `model.models`. `get_model_data()` drains and clears the buffer. `clean_up()` drops watch entries whose model became disabled.
- **`TaskScheduler`** runs deferred mutations every `_task_interval` (0.015 s). `setPropValue(prop, value, it, at)` → numeric targets **tween** over `it` seconds after an `at`-second delay (type 0), booleans/strings swap instantly (type 1); `callModelFunction` schedules a method call (type 2). It writes directly to model props, typically a `*_factor_ps` or a base param.

## Model definition JSON

Files in `model_definitions/*.json` are full scenarios. Top level: `name`, `user`, `description`, `diagram_definition`, `animation_definition`, `configuration`, and **`model_definition`** (the part the engine consumes). `Model.load()` fetches `/model_definitions/<name>.json` and unwraps `jsonData.model_definition || jsonData` before `build()`.

Inside `model_definition`: engine-level settings (`weight`, `height`, `gestational_age`, `age`, `modeling_stepsize`, `model_time_total`, `scaler_config`, `_baseline_weight`) plus **`models`** — a map of `name → { name, model_type, …params }`. A typical neonate scenario has ~60 components (one each of the high-level systems: `Heart`, `Breathing`, `Ans`, `Circulation`, `Respiration`, `Blood`, `Gas`, `Metabolism`, `Pda`, `Shunts`, devices `Ventilator`/`Ecls`/`Monitor`/`Resuscitation`, …) wired together by ~40 `Resistor` entries via their `comp_from`/`comp_to` names. Available scenarios are listed in `index.json` alongside them. **The canonical set is `explain-engine/model_definitions/`** (in the engine submodule) — edit scenarios there. `scripts/sync-scenarios.mjs` copies them into `public/model_definitions/` on every `predev`/`prebuild`, so that directory is generated, gitignored, and **overwritten**: editing a canonical scenario there loses the change on the next `npm run dev`. The sync is additive, so new files written alongside (user/developer snapshots) persist, and `index.json` is rebuilt as the union of both.

## `model_interface` schema (UI layer — `src/model-interface/`)

The parameter-edit schema is **owned by the UI, not the engine**. It lives in `src/model-interface/`: `registry.ts` holds `MODEL_INTERFACES` (a `Record<model_type, InterfaceField[]>`) plus `getInterfaceForType()`, and `types.ts` defines `InterfaceField` and the `groupByEditMode()` helper. The Vue layer reads it via `useModelInterface()` (`src/composables/useModelInterface.ts`), which maps a model instance → its `model_type` → the registry entry; the generic `ModelEditor.vue` renders the controls (there is no `ParameterPanel.vue` — subsystem-specific editing lives in the bespoke `controls/*Panel.vue` files).

`registry.ts` is generated; `custom-registry.ts` beside it is the hand-edited student seam, merged in `getInterfaceForType()` with custom taking precedence. A regeneration of `registry.ts` must preserve that import and merge.

Each `InterfaceField` describes one editable field: `target` (prop name, or method name for `function`), `type` (`number`/`boolean`/`string`/`list`/`multiple-list`/`factor`/`function`/`prop-list`/`reference`), `caption`, `edit_mode` (`basic`/`extra`/`factors`/`advanced`), `build_prop`, `readonly`; numbers add `factor` (display = raw×factor), `delta`, `rounding`, `ll`/`ul`, `slider`; lists add `options`/`choices`/`custom_options`; functions add `args`. When you add a configurable parameter, add a matching field to the model_type's array in `registry.ts` or it won't be editable in the app. The registry was generated by dumping each class's effective (inheritance-resolved) interface from `explain-engine/ModelIndex.js`.

## Composite models

Some component models build sub-models inside `init_model` via the `this.components` mechanism (base `init_model` instantiates any declared component into `model.models` and inits it). This lets a high-level model own a local sub-network while its children still participate in the global step loop. Always register internally created models on `model.models` (by going through `components` or the engine map) so the scheduler/collector can reach them.

## Docs

Prose documentation is split into two sets in **two repositories**: [`docs/ui/`](docs/ui/README.md) (the Vue app) lives here, and [`explain-engine/docs/`](explain-engine/docs/README.md) (the physics engine) lives in the engine repo beside the code it documents — it reaches this tree through the submodule. [`docs/README.md`](docs/README.md) is the index for both.

[`explain-engine/docs/*.md`](explain-engine/docs/README.md) contains the physiological derivations for several models (`BloodCapacitance`, `BloodVessel`, `HeartChamber`, `Pda`, …). Consult these before changing the math in those classes. `explain-engine/README.md` has a student-onboarding walkthrough and a usage cheat sheet (drive the engine via the `model` returned by `useExplain()`).

Note: a checkout without `git submodule update --init` has no engine docs at all.

## UI documentation

The **Vue UI layer** (everything under `src/`) is documented in [`docs/ui/`](docs/ui/README.md) — start at [`docs/ui/README.md`](docs/ui/README.md), or [`docs/ui/UI_ARCHITECTURE.md`](docs/ui/UI_ARCHITECTURE.md) for the whole-UI overview. That set is the long form of the two `model_interface` sections above and covers the parts `CLAUDE.md` doesn't: the two-plane (reactive control / non-reactive ~60 Hz data) architecture, the Pinia stores, the `src/render/` adapters (uPlot/Pixi), the host + control + numeric components, the chat/bot command pipeline (`src/services/`), and routing/auth. This file stays the quick reference; `docs/ui/` is canonical for the UI.
