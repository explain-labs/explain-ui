# Explain Knowledge Pack

This document is a self-contained snapshot of the **Explain** physiological simulation
engine and its surrounding web app, assembled so an assistant can answer questions about
the model with the same grounding Claude Code has when working in the repo.

**Tier:** LITE tier: architecture notes, all physiology docs, the core engine source, and the scenario format.

Every embedded file is introduced by a `### FILE: <path>` header so you can cite exact
source locations (e.g. `explain-engine/base_models/Capacitance.js`) in answers. Treat the source
and docs below as the ground truth; prefer quoting them over recalling general knowledge.

## How this pack is organized

1. **Architecture** — the repo's CLAUDE.md (build flow, message envelope, model contract, the factor/effective-value pattern).
2. **Engine onboarding** — explain-engine/README.md.
3. **Physiology docs** — explain-engine/docs/*.md, the per-model derivations and math.
4. **Engine source** — the live ES-module classes that run in the Web Worker.
5. **Scenario format** — the model-definition JSON the engine consumes.

---

## 1. Architecture

### FILE: CLAUDE.md

```markdown
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

This directory is a **standalone Vue 3 + Vite + TypeScript web app** built around the `explain-engine/` physiological simulation engine (plain ES modules that run inside a **Web Worker**) plus a set of scenario definitions (`model_definitions/`). The app was migrated off Quasar; it now uses Vue 3 + Vite + TypeScript + PrimeVue + Tailwind, while the engine in `explain-engine/` is kept framework-agnostic. The repo has its own `package.json`, `vite.config.ts`, and `node_modules`.

Both repositories live in the **`explain-labs`** GitHub organization: this app is [`explain-labs/explain-ui`](https://github.com/explain-labs/explain-ui) and the engine submodule is [`explain-labs/explain-engine`](https://github.com/explain-labs/explain-engine) (recorded in `.gitmodules` over **HTTPS**, as `https://github.com/explain-labs/explain-engine.git`, so anyone can clone and run the app without a GitHub account — students who push an engine branch re-point their own clone at the SSH URL). Note the submodule's *name* is `explain` while its *path* is `explain-engine`, so the config key is `submodule.explain.url`, not `submodule.explain-engine.url`. Both moved there from the personal `Dobutamine` account; GitHub still redirects the old URLs, so a pre-move clone keeps working, but anything you write should use the org URLs. Shared cross-repo usage instructions live on the [org profile](https://github.com/explain-labs), sourced from `explain-labs/.github`. A checkout made before the move needs `git submodule sync` to pick up the new submodule URL.

The Vue layer bootstraps the engine through `src/composables/useExplain.ts` — a singleton that does `new Model()` (imported as `@explain/Model`, an alias to `./explain-engine/` set in `vite.config.ts`/`tsconfig.json`). `Model.js` spawns the worker via `new Worker(new URL("./ModelEngine.js", import.meta.url), { type: "module" })`. Scenario definitions are served from `public/model_definitions/`.

## Architecture

Two threads, one wire protocol:

- **`explain-engine/Model.js`** — main-thread wrapper (extends `ModelEmitter`). Spawns the worker, exposes the public API (`build`/`load`/`start`/`stop`/`calculate`/`setPropValue`/`callModelFunction`/`watchModelProps`/`scaleModel`/…), and re-emits worker responses as events you subscribe to with `explain.on(event, handler)`.
- **`explain-engine/ModelEngine.js`** — the Web Worker. Owns the live `model` object (`{ models: {…}, modeling_stepsize, model_time_total, … }`), the build/step loop, and the GET/POST/PUT/DELETE message router (`self.onmessage`).

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
- `<p>_factor_scaling_ps` — **persistent scaling**; written by `ModelScaler` (absolute group factors). It is the same name in every family, diffusors included. It is 1.0 in every shipped scenario: their size calibration is baked into the base values.

Formula (see `Capacitance.calc_elastances`, `Resistor.calc_resistance`): `p_eff = p + (factor-1)*p + (factor_ps-1)*p + (factor_scaling_ps-1)*p`. Exception: `BloodVessel` (most of the circulation) composes its layers **multiplicatively** (and multiplies in the ANS, viscosity/viscosity_ref and the α R→E coupling). `HeartChamber` stays additive but adds drug/Mob/load/remodel/ANS terms — see the engine's `docs/ARCHITECTURE.md` §7a. When adding a tunable parameter, follow this convention so it composes with interventions and scaling. `ModelScaler` (`explain-engine/helpers/ModelScaler.js`) writes the `*_scaling_ps` layer for elastance/resistance/unstressed-volume scaling, but its volume and weight scaling change raw `vol`/`u_vol`, and the Calibrator also writes `r_factor_scaling_ps` (IPSL/IPSR); `scaleModel(group, factor)` in the API (`POST "scale"`) routes to its many `scale_*` methods via the big `switch` in `ModelEngine.scale_model`. The factor groups set the layer **absolutely** (1.0 = the scenario as loaded), so a calibration stored there would be wiped by the first `scale`; hence every shipped scenario is baked (`incorporate`), and the generators and `build_patient.mjs` bake before saving. `reset` returns every group to 1.0 and restores `model.weight = model._baseline_weight`.

## Flow / pressure mechanics

`Resistor` reads `comp_from.pres` and `comp_to.pres`, computes `flow`, then moves volume by calling `comp_from.volume_out(flow*dt)` / `comp_to.volume_in(...)`. `volume_out` returns any volume it couldn't supply so the resistor doesn't create volume from an empty compartment. `Capacitance.calc_pressure` derives `pres` from `(vol - u_vol_eff)` with linear + non-linear (`el_k`) terms plus `pres_ext`. `BloodCapacitance.volume_in` additionally mixes `to2`/`tco2`/`solutes`/`drugs`/`temp`/`viscosity` by the incoming volume fraction — this is how blood gases/solutes propagate through the circuit.

## Cardiac/breathing cycle counters

The cycle counters are fields of the components that drive them: `Heart.ncc_atrial`/`Heart.ncc_ventricular`, and `ncc_insp`/`ncc_exp` on `Breathing` and `Ventilator` (a value of `1` marks the first step of a phase). The engine `model` object holds none. `DataCollector` always watches `Heart.ncc_ventricular`/`Heart.ncc_atrial` for ECG regardless of the user watchlist.

## DataCollector & TaskScheduler

- **`DataCollector`** keeps two watchlists — fast (`watch_list`, `sample_interval` 0.005 s) and slow (`watch_list_slow`, 1.0 s). Watched props are dot-paths `"Model.prop"` or `"Model.prop.subprop"` resolved against `model.models`. `get_model_data()` drains and clears the buffer. `clean_up()` drops only watch entries whose model no longer exists; a disabled model keeps its watch (the typed path writes 0 for it).
- **`TaskScheduler`** runs deferred mutations every `_task_interval` (0.015 s). `setPropValue(prop, value, it, at)` → numeric targets **tween** over `it` seconds after an `at`-second delay (type 0, starting from the property's value when the tween starts), booleans/strings swap instantly (type 1); `callModelFunction` schedules a method call (type 2). An unknown model/property/method is rejected with an `error` message instead of being queued. It writes directly to model props, typically a `*_factor_ps` or a base param.

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

The **Vue UI layer** (everything under `src/`) is documented in [`docs/ui/`](docs/ui/README.md) — start at [`docs/ui/README.md`](docs/ui/README.md), or [`docs/ui/UI_ARCHITECTURE.md`](docs/ui/UI_ARCHITECTURE.md) for the whole-UI overview. That set is the long form of the two `model_interface` sections above and covers the parts `CLAUDE.md` doesn't: the two-plane (reactive control / non-reactive ~60 Hz data) architecture, the Pinia stores, the `src/render/` adapters (uPlot/Pixi), the host + control + numeric components, the chat/bot command pipeline (`src/services/`), and routing/auth. The interactive manual (guided tours on MainPage, `src/manual/` + `data-tour` attributes) is documented in [`docs/ui/MANUAL.md`](docs/ui/MANUAL.md). This file stays the quick reference; `docs/ui/` is canonical for the UI.

```


## 2. Engine onboarding

### FILE: explain-engine/README.md

````markdown
# Explain Engine

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.21389096.svg)](https://doi.org/10.5281/zenodo.21389096)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A framework-agnostic, dependency-free physiological simulation engine (whole-body neonatal
and fetal cardiorespiratory model; the adult scenarios are archived). It runs in a dedicated Web Worker (`ModelEngine.js`) and
is controlled from the main thread through the `Model` wrapper (`Model.js`).

This repository is self-contained: it has no runtime or build dependencies, and the tooling
under `scripts/` (headless harness, probes, sensitivity-analysis campaign) runs on plain Node
with no install step. Consumers mount it as a git submodule — see
[`explain-ui`](https://github.com/explain-labs/explain-ui) for the web app built on it.

Both repositories are part of the [**Explain Labs**](https://github.com/explain-labs)
organization — [`explain-labs/explain-engine`](https://github.com/explain-labs/explain-engine)
(this repo) and [`explain-labs/explain-ui`](https://github.com/explain-labs/explain-ui). The org
page carries the shared overview of how the two fit together. To work on the engine alone:

```sh
git clone https://github.com/explain-labs/explain-engine.git
```

> **Where to read next**
> - [`./docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — the full engine architecture (two-thread design, build/step loop, wire protocol, scaling/tuning, realtime data plane). Start there for deep detail.
> - [`./docs/`](./docs/) — per-class physiological reference (one Markdown file per model, e.g. `Heart.md`, `BloodCapacitance.md`, `Pda.md`), plus helper docs (`DataCollector.md`, `TaskScheduler.md`, `ModelScaler.md`, …).
> - [`./docs/README.md`](./docs/README.md) — index of the per-class docs.
>
> This README is the **start-here / onboarding** guide. It keeps the lifecycle, a minimal usage example, and the student manual; the deep architecture lives in `ARCHITECTURE.md`.

## High-level architecture

Two threads, one wire protocol. `Model.js` runs on the main thread: it spawns the worker, exposes the public API, and re-emits worker responses as events you subscribe to with `explain.on(event, handler)`. `ModelEngine.js` is the Web Worker: it owns the live `model` object, the build/step loop, and the GET/PUT/POST/DELETE message router. See [`./docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the complete picture.


## Runtime lifecycle

1. UI constructs `new Model()` (see `src/composables/useExplain.ts`).
2. `Model` creates a worker from `ModelEngine.js`.
3. UI calls `build()` or `load(<definition_name>)`.
4. Worker `build()`:
   - copies top-level model settings,
   - instantiates each model component by `model_type` via `ModelIndex`,
   - calls `init_model(args)` on each component,
   - creates `DataCollector` and `TaskScheduler`.
5. UI can run:
   - **batch simulation** via `calculate(seconds)`, or
   - **real-time simulation** via `start()` / `stop()`.
6. Worker sends state/data/status events back to main thread.

## Worker message protocol

`Model` and `ModelEngine` communicate with message objects:

```js
{
  type: "GET" | "PUT" | "POST" | "DELETE",
  message: string,
  payload: any
}
```

### Inbound commands to worker (`ModelEngine`)

Commands are routed by the worker's `self.onmessage` switch on `type` then `message` — e.g. `POST build`/`start`/`stop`/`calc`/`call`/`scale`/`calibrate`/`watch`, `PUT property_value`/`diagram_definition`/`sample_interval`, `GET state`/`data`/`model_props`/`model_types`, `DELETE watchlist`. See the full command table in [`./docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

### Outbound events from worker

The worker posts back messages whose `type` is mapped to emitter events in `Model.receive()` — including `state`, `status`, `model_ready`, `rt_start`/`rt_stop`, `data`/`data_slow`, `rtf`/`rts` (realtime fast/slow), `prop_value`, `model_props`, `model_types`, `state_saved`, `tuned`, and `error`. Subscribe with `explain.on(event, handler)` (the `Model` is a `ModelEmitter`; these are **not** DOM `CustomEvent`s). The realtime data-plane messages (`RT_MSG.*`) bypass this and are consumed by `RealtimeBus`. See [`./docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full event reference.

## Public API (`Model.js`)

The main-thread methods UI code calls — `load`/`build`/`restart`, `calculate(seconds)`, `start`/`stop`/`dispose`, `watchModelProps`/`watchModelPropsSlow` and their `clear*` counterparts, `getModelData`/`getModelDataSlow`/`getModelState`/`saveModelState`/`getModelTypes`/`getPropValue`, `setPropValue`/`callModelFunction`, `scaleModel(group, factor)`, `tune(targets, opts)`, and `updateDiagram`. Each is documented inline in `Model.js`; see [`./docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the annotated public-API reference.

## Data collection and scheduling

### `DataCollector`

Keeps two watchlists — `watch_list` (fast stream, ~0.005 s) and `watch_list_slow` (slow stream, 1.0 s) — of dot-path props resolved against `model.models`, drained each collect cycle. Full behavior in [`./docs/DataCollector.md`](./docs/DataCollector.md).

### `TaskScheduler`

Runs deferred mutations on a fixed interval: `setPropValue(prop, value, it, at)` tweens numeric targets over `it` seconds after an `at`-second delay (booleans/strings swap instantly), and `callModelFunction` schedules a method call. See [`./docs/TaskScheduler.md`](./docs/TaskScheduler.md).

## Model class contract

Most classes extend `BaseModelClass` and follow this pattern:

  - `model_type` (string identifier used at build time)
  - constructor defines independent/dependent/local fields
  - `init_model(args)` applies config and sets `_is_initialized`
  - `step_model()` checks `is_enabled && _is_initialized`
  - `calc_model()` performs actual calculations

The engine is pure physics: model classes carry **no UI metadata**. The
parameter-editing schema (formerly a `static model_interface` array on each
class) now lives in the UI layer at `src/model-interface/`, keyed by
`model_type`. The engine neither stores nor transports it.

## Composite model behavior

Some component models create additional internal models in `init_model`.

Example: `Circulation` creates and configures its `BloodVessel` and `Resistor` components (declared under `components` in the definition) and registers them in the engine model map. This allows a higher-level model to encapsulate a local network while still participating in global stepping.

## Adding a new model type

> Writing a model for a course project or an experiment? Use the extension point instead —
> `custom_models/README.md` and `STUDENT_WORKFLOW.md` in the explain-ui repo. It is the same
> class contract, but your model registers from `CustomModelIndex.js` rather than the shared
> `ModelIndex.js`, so your branch never conflicts with anyone else's. The steps below are for
> models that become part of the core engine.

1. Create a class in `base_models/`, `component_models/`, or `device_models/`.
2. Extend `BaseModelClass` (or match required engine contract).
3. Define static `model_type`.
4. Implement `init_model` and/or `calc_model` as needed.
5. Export it from `ModelIndex.js`.
6. Reference the new `model_type` in model definition JSON.
7. If the parameters should be editable in the app, add a `model_type` entry to
   the UI schema at `src/model-interface/registry.ts`.

## Minimal usage example

```js
// In Vue components, get the engine wrapper from the composable:
import { useExplain } from "src/composables/useExplain";
const explain = useExplain().model; // the singleton Model instance

// Build from object (or call explain.load("definition_name"))
explain.build(modelDefinition);

// Observe selected variables
explain.watchModelProps([
  "Heart.heart_rate",
  "Heart.lv_sv",
  "Ventilator.vent_rate"
]);

// Run realtime
explain.start();

// Later...
explain.stop();
```

## Notes and caveats

A few things that bite newcomers: payloads crossing the worker boundary are JSON-stringified for `build`/`property_value`/`call`; UI metadata is **not** on the model classes (it lives in `src/model-interface/registry.ts`); cardiac/breathing timing counters (`ncc_*`) are fields of `Heart`, `Breathing` and `Ventilator`; and the factor / `*_factor_ps` / `*_factor_scaling_ps` effective-value pattern means core physics params are never used raw. These and other gotchas are covered in [`./docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Student onboarding manual

> Set up first: `STUDENT_WORKFLOW.md` in the explain-ui repo covers cloning both
> repositories, working on your own branch, and handing work in. This section is the
> engine-side reference for what to do once you are set up.

### 1. Running the model

1. Start the Vite dev server with `npm run dev` from the **`explain-ui` repository root** — the directory this engine is mounted inside as a submodule. (The engine itself has no dependencies, no build step and no `dev` script; production build via `npm run build`, also from the app root.)
2. The explain engine bootstraps via `src/composables/useExplain.ts`, a singleton that instantiates `Model` (imported as `@explain/Model`) and loads the default definition.
3. Use UI buttons or call the engine wrapper returned by `useExplain()` (`model`) to `build`, `load`, `start`, `stop`, or `calculate(seconds)`.
4. Place custom definitions under `model_definitions` and run `explain.load("definition_name")` (omit `.json`).

### 2. Observing & tweaking data

- Fast telemetry: `explain.watchModelProps(["Heart.heart_rate", "Ventilator.peep_cmh2o"])`.
- Change parameters with easing: `explain.setPropValue("Ventilator.peep_cmh2o", 10, 5 /* seconds */, 0 /* delay */)`.
- Trigger functions: `explain.callModelFunction("Heart.resetBaro", [], 0.25)`.

### 3. Adding models

**Your own models** (`custom_models`) — the student path
- Copy `custom_models/_ExampleModel.js`, rename the class and its `static model_type`, and export it from `CustomModelIndex.js`. Add UI fields in `src/model-interface/custom-registry.ts` in the explain-ui repo.
- Both of those files are empty on `main` and yours to fill in, so your work never collides with the shared registries. Conventions and the full class contract: `custom_models/README.md`.

**Base models** (`base_models`) — core engine only
- Extend `BaseModelClass` and define a static `model_type`. (UI/parameter metadata is **not** on the class — add a `model_type` entry to the UI schema at `src/model-interface/registry.ts` to make parameters editable.)
- Implement `init_model(config)` and `calc_model()`/`step_model()`.
- Import/export the class in `ModelIndex.js`.

**Component models** (`component_models`)
- Compose multiple base models or encapsulate subsystems.
- Register internally created models on the engine `models` map so schedulers and collectors can target them.

**Device models** (`device_models`)
- Represent external hardware; validate dependencies (e.g., lungs) in `init_model` and emit clear errors if missing.

**Helpers** (`helpers`)
- Instantiate new helpers inside `ModelEngine` and keep their state serializable (strip private fields in `_processModelState`).

### 4. Editing definitions

1. Definitions live in `model_definitions/*.json`; the model list is `model_definition.models`.
2. Each entry is flat: `name`, `model_type`, `is_enabled`, then the model's config props by name (another model is referenced by its name as a string). `init_model` copies every key onto the instance.
3. Example block:

```json
{
  "name": "MyDevice",
  "model_type": "MyDevice",
  "is_enabled": true,
  "pressure": 18,
  "lung_name": "LL"
}
```

See [`./docs/MODEL_DEFINITIONS.md`](./docs/MODEL_DEFINITIONS.md) for the full format.

4. Reload via `explain.load("my_definition")` or rebuild in place with `explain.restart()`.

### 5. Debugging checklist

- Watch worker traffic in DevTools (console logs prefixed with `Model:`).
- Hook events: `explain.on("status", () => console.log(explain.statusMessage))`; `state` likewise fills `explain.modelState`, while `model_ready` and `error` pass a payload.
- Snapshot: `explain.getModelState()`; inspect the payload emitted by the worker.
- Missing models usually mean `model_type` typos or missing exports in `ModelIndex` (or, for your own models, in `CustomModelIndex`).

### 6. Cleanup

- When done (component unmount, hot reload), call `explain.dispose()` to terminate the worker and drop listeners.

## Citation

If you use this software, please cite it via its archived release. The DOI below is the
**concept (all-versions) DOI** and always resolves to the latest release:

> Antonius, T. *Explain: a whole-body physiological simulation engine*. Zenodo. https://doi.org/10.5281/zenodo.21389096

Machine-readable metadata lives in [`CITATION.cff`](./CITATION.cff); GitHub's "Cite this repository" button reads it directly. To cite a specific version, use that release's version-specific DOI from the [Zenodo record](https://doi.org/10.5281/zenodo.21389096) instead of the concept DOI.


````


## 3. Physiology docs

### FILE: explain-engine/docs/ARCHITECTURE.md

````markdown
# Explain Engine — Architecture

This is the **architecture entry point** for the Explain physiological simulation engine. Read it first if you are extending the engine; the 50+ per-class docs in this directory (e.g. [`BloodCapacitance.md`](./BloodCapacitance.md), [`Heart.md`](./Heart.md), [`Resistor.md`](./Resistor.md)) describe individual models and assume the cross-cutting patterns documented here.

The engine is a set of **framework-agnostic ES modules** that run inside a **Web Worker**. It has no dependency on Vue, the DOM, or the `window` object — the only thing crossing into it is the message protocol described below. The Vue app is just one possible host; the engine also runs headless in Node (see [`TESTING.md`](./TESTING.md)). Per-model parameter-edit metadata is **not** in the engine — it lives in the UI layer (`src/model-interface/`).

The scenario files the engine loads are documented separately in [`MODEL_DEFINITIONS.md`](./MODEL_DEFINITIONS.md); this doc covers how they are *consumed*.

---

## 1. Two-thread design

Two files, two threads, one wire protocol:

| File | Thread | Owns |
|---|---|---|
| [`Model.js`](../Model.js) | main thread | Public API surface, message send/receive, event re-emit. Extends `ModelEmitter` (pub/sub). |
| [`ModelEngine.js`](../ModelEngine.js) | Web Worker | The live `model` object, the build flow, the step loop, the message router. |

`Model.js`'s constructor spawns the worker with

```js
this.modelEngine = new Worker(new URL("./ModelEngine.js", import.meta.url), { type: "module" });
```

and immediately calls `this.receive()` so no early worker messages are missed. A separate `onerror` handler catches worker-level failures (syntax/import errors) and re-emits them as an `error` event.

**The live model lives only in the worker.** `ModelEngine.js` holds a module-scope `let model = { models: {}, … }`. The main thread never has a reference to it — it only receives serialized snapshots (`state` messages) and sampled data. `Model.js` keeps shadow copies (`modelState`, `modelData`, `modelDataSlow`, `savedState`) for UI consumption, but those are read-only echoes.

---

## 2. Message protocol

Every message in both directions is the same envelope:

```js
{ type: "GET" | "PUT" | "POST" | "DELETE", message: string, payload: any }
```

`Model.send(msg)` does `modelEngine.postMessage(msg)`; the worker replies via `postMessage` (wrapped as `_send`/`_send_error`). The worker router is the single `self.onmessage` switch in `ModelEngine.js`, dispatching first on `type`, then on `message`. The whole handler is wrapped in a try/catch that emits an `error` on any unhandled throw.

### Inbound commands (handled in the worker router)

| type | message | Handler |
|---|---|---|
| GET | `state` | `get_model_state()` |
| GET | `data` | `get_model_data()` |
| GET | `data_slow` | `get_model_data_slow()` |
| GET | `property_value` | `get_property(payload)` |
| GET | `model_props` | `get_model_props(payload)` |
| GET | `model_types` | `get_model_types()` |
| GET | `blood_composition` | `get_blood_composition(payload)` |
| PUT | `sample_interval` | `DataCollector.set_sample_interval(payload)` |
| PUT | `sample_interval_slow` | `DataCollector.set_sample_interval_slow(payload)` |
| PUT | `property_value` | `set_property(_normalize_payload(payload))` → TaskScheduler |
| PUT | `diagram_definition` | `update_diagram(...)` (live anim rebind, no rebuild) |
| POST | `build` | `build(_normalize_payload(payload))` |
| POST | `start` | `start()` |
| POST | `stop` | `stop()` |
| POST | `calc` | `calculate(payload)` |
| POST | `call` | `call_function(_normalize_payload(payload))` → TaskScheduler |
| POST | `add` | `add_model_to_engine(payload)` |
| POST | `save` | `save_state()` |
| POST | `scale` | `scale_model(payload)` |
| POST | `calibrate` | `tune_model(_normalize_payload(payload))` |
| POST | `watch` | `watch_props(payload)` |
| POST | `watch_slow` | `watch_props_slow(payload)` |
| DELETE | `remove` | `remove_model_from_engine(payload)` |
| DELETE | `watchlist` | `clear_watchlist()` |
| DELETE | `watchlist_slow` | `clear_watchlist_slow()` |

### Outbound events (mapped by `Model.receive()`)

The worker's outbound `type` strings are translated to `ModelEmitter` events you subscribe to with `explain.on(event, handler)`:

| Inbound `type` | Emitted event | Side effect on `Model.js` |
|---|---|---|
| `state` | `state` | stores `modelState` |
| `status` | `status` | stores `statusMessage` |
| `model_ready` | `model_ready` | (build succeeded) |
| `rt_start` | `rt_start` | — |
| `rt_stop` | `rt_stop` | — |
| `data` | `data` | stores `modelData` |
| `data_slow` | `data_slow` | stores `modelDataSlow` |
| `rtf` | `rtf` | stores `modelData` (realtime fast) |
| `rts` | `rts` | stores `modelDataSlow` (realtime slow) |
| `rt_perf` | `rt_perf` | stores `realtime_factor`: simulated / wall-clock time over ~1 s of the realtime loop (< 1 = falling behind) |
| `prop_value` | `prop_value` | — |
| `model_props` | `model_props` | — |
| `model_types` | `model_types` | — |
| `state_saved` | `state_saved` | stores sanitized `savedState` |
| `tuned` | `tuned` | stores `tuneResult` (`{converged, residuals, iters}`) |
| `error` | `error` | stores `error_message` |
| `RT_MSG.CHANNELS` / `CHART` / `ANIM` | — | consumed by the realtime data plane ([RealtimeBus](./RealtimeBus.md)), ignored by `receive()` |

**JSON boundary.** Payloads that are structured objects are JSON-stringified at the send site and re-parsed in the worker by `_normalize_payload` (a `JSON.parse` only when the payload is a string). This applies to `build`, `property_value` (PUT), `call`, `calibrate`, and `diagram_definition`. Simpler payloads (`scale`'s `{group, factor}`, `watch`'s string array, `calc`'s integer) are passed as plain structured-clone objects. State snapshots and sampled data flow back as plain objects via `postMessage` (structured clone), not stringified.

### Event emitter (`ModelEmitter`)

`Model` extends [`ModelEmitter`](../ModelEmitter.js) — a deliberately minimal pub/sub base class (no dependencies, **no `once`, no wildcards, no per-callback error guarding**):

| Method | Behaviour |
|---|---|
| `on(event, callback)` | Lazily creates the listener `Set` for `event` and adds `callback`. No unsubscribe handle is returned. |
| `off(event, callback)` | Removes `callback`; drops the map entry when its set empties. |
| `emit(event, ...args)` | Calls every callback registered for `event` with the spread args. |

Listeners are stored in an instance field `_listeners: Map<string, Set<Function>>`. `Model`'s worker `onmessage` handler maps each inbound worker `type` to an `emit(...)` (the table above), so host code subscribes purely with `explain.on(event, handler)`. The three `RT_MSG.*` data-plane types are **not** emitted here — they are consumed by [RealtimeBus](./RealtimeBus.md) on a second worker listener (see §10).

---

## 3. Public API (`Model.js`)

| Method | What it does |
|---|---|
| `load(definition_name)` | Maps a renamed scenario's old name to its current one (`SCENARIO_ALIASES` in `helpers/ScenarioAliases.js`: `term_neonate` → `term_neonate_72h`), fetches `/model_definitions/<name>.json`, unwraps `jsonData.model_definition \|\| jsonData`, forwards `diagram_definition`/`animation_definition`, then calls `build`. |
| `build(explain_definition)` | POST `build` with the stringified definition. |
| `restart()` | Re-POST `build` with the last `modelDefinition` snapshot. |
| `updateDiagram(diagram_definition)` | PUT `diagram_definition` — live sprite-anim rebind, no model rebuild. |
| `calculate(seconds)` | POST `calc` — synchronous offline run for `seconds` of sim time. |
| `start()` / `stop()` | POST `start` / `stop` — toggle the realtime `setInterval` loop. |
| `dispose()` | Detach `onmessage` and `terminate()` the worker (call on unmount/HMR). |
| `watchModelProps(args)` / `watchModelPropsSlow(args)` | POST `watch` / `watch_slow` with dot-path string(s) `"Model.prop[.subprop]"`. |
| `clearWatchList()` / `clearWatchListSlow()` | DELETE the fast / slow watchlist. |
| `getModelData()` / `getModelDataSlow()` | GET a one-shot data snapshot. |
| `setSampleInterval(s)` / `setSampleIntervalSlow(s)` | PUT new sampler intervals. |
| `getModelState()` | GET the full serialized engine `model`. |
| `saveModelState()` | POST `save` → `state_saved` event (sanitized snapshot). |
| `getModelProps(model_name)` | GET metadata for one instance. |
| `getModelTypes()` | GET the catalog of registered `model_type`s. |
| `getBloodComposition(model_name)` | GET — run `calc_blood_composition` on one instance. |
| `addNewModel(model_args)` / `deleteModel(model_name)` | POST `add` / DELETE `remove` an instance at runtime. |
| `getPropValue(property)` | GET the current value at a dot path. |
| `setPropValue(prop, value, it=1, at=0)` | PUT a scheduled property change. Splits `prop` into `model.prop1[.prop2]`; numeric targets **tween** over `it` s after an `at` s delay, others swap. |
| `callModelFunction(fn, args, at=0)` | POST `call` — schedule a method call after `at` s. |
| `scaleModel(group, factor=1.0)` | POST `scale` — weight/manual scaling via ModelScaler. |
| `tune(targets, opts={})` | POST `calibrate` — live closed-loop tuning to target vitals; emits `tuned`. |

---

## 4. Build flow (`ModelEngine.build()`)

`build(model_definition)` runs synchronously and returns a boolean (`model_initialized`). Ordered steps:

1. **Reset.** `errors = 0`; `model_initialized = false`; clear `model_data`/`model_data_slow`; `clearInterval(rtClock)`.
2. **Fresh `model` object** with empty `models: {}`, and empty `scaler_config`.
3. **Copy engine-level settings.** Every top-level key of the definition except `models` is copied onto `model` (`weight`, `modeling_stepsize`, `model_time_total`, `scaler_config`, …).
4. **Instantiate the top-level models.** For each entry in `model_definition.models`, look up the class by `sub_model_def.model_type` in `available_model_map`. If found, `new model_class(model, name, model_type)` and store on `model.models[name]`. A missing type or a constructor throw increments `errors` and emits a `status` `ERROR:` message. (The constructor's 3rd `model_type` arg is ignored by the base class.)
5. **Instantiate the sub-models.** Every model declared in a `components` map is instantiated into `model.models` too, recursively, in the same order `BaseModelClass.init_model` would use (all of a model's components, then each component's own), with the same error handling.
6. **Initialize (only if `errors < 1`).** For each **top-level** instance, build `args` as a `[{key, value}, …]` list from the definition entry and call `init_model(args)`. Each owner initializes its own sub-models from its `init_model`. An init throw increments `errors` and emits a `status` `ERROR:`.
7. **Attach helpers.** `model.DataCollector = new DataCollector(model)`, `model.TaskScheduler = new TaskScheduler(model)`, `model.ModelScaler = new ModelScaler(model, model.scaler_config)`.
8. **Freeze baseline weight.** `model._baseline_weight = model.weight` (the weight-scaling anchor `reset()`/`scale_to_weight()` use).
9. **Wire the realtime data plane.** Construct `ChannelWriter` and `AnimationPacker`, acquire the anim snapshot, and `DataCollector.set_channels(...)`. Failures here are caught and degrade to the legacy object path (they do **not** fail the build).
10. **Emit.** If `errors > 0`: `status` `ERROR: model build failed` and return `false`. Otherwise emit `model_ready` and return `true`.

Note the two-pass structure: **all** instances, sub-models included, are constructed before **any** are initialized. This is what lets `init_model` resolve cross-model references (`this._lv = this._model_engine.models["LV"]`, `Heart` finding Mob's `COR`, `Blood` and `Gas` collecting every compartment) regardless of where the owner sits in the definition. A model found that way may not be initialized yet: its definition values arrive when its owner's `init_model` runs.

---

## 5. Step loop

`_model_step()` is the single time step:

1. For each model in `model.models` **in insertion order**, call `step_model()`. When `ENABLE_STEP_ERROR_GUARD` (currently `true`) each call is wrapped in try/catch and a throw emits an `error` event but does not abort the loop — one bad model can't kill the simulation. Only the **first** throw per model is reported (`step_errors`, reset on every `build`): a broken model usually throws on every step, which would otherwise post ~2000 errors per simulated second. Later throws are counted, not sent, and the model keeps being called each step.
2. `DataCollector.collect_data(model.model_time_total)`.
3. `TaskScheduler.run_tasks()`.
4. `model.model_time_total += model.modeling_stepsize`.

**What "insertion order" means in practice.** The top-level entries of `model_definition.models` are inserted first, in JSON order. Sub-models declared in a composite's `components` are inserted after them (build step 5, in owner order), so every one of them steps **after all top-level entries**. For `term_neonate_72h` (172 models):
1. the 25 systems (`Heart` at position 1, which sets the chambers' `act_factor`);
2. the 43 top-level resistors;
3. the `Heart` components (chambers, valves, `PERICARDIUM`);
4. the `Ans`, `Circulation` and `Respiration` sub-models, with `THORAX` at position 160.

Consequences:
- **Pressures within a step:** a resistor that steps before its compartments reads their pressure from the previous step, and one that steps after them reads this step's. The scheme is explicit either way.
- **Container lag:** a `Container`'s `pres_ext` reaches its contents on their next `calc_pressure`. A nested container (`THORAX` → `PERICARDIUM` → chambers) therefore passes the thorax pressure on with a 2-step lag (1 ms at 0.5 ms).
- **Size of the effect:** both are far below anything measurable at the 0.5 ms step, and volume is conserved exactly. Don't rely on a particular order between sibling models, though.

Two ways to drive it:

- **`calculate(seconds)`** — synchronous offline run of `seconds / model.modeling_stepsize` steps in a tight `for` loop, then emits one `data`/`data_slow`/`state` snapshot and reports timing via `status`. The chart ring is bypassed (object data path).
- **`start()` → `_model_step_rt`** — `setInterval(_model_step_rt, rtInterval * 1000)` with `rtInterval = 0.015` s wall clock. Each tick runs `rtInterval / modeling_stepsize` model steps, then either writes typed chart rows + packs the animation frame through `ChannelWriter`/`AnimationPacker` (fast path) or falls back to the `rtf` object message. Slow data (`rts`) is emitted once per `rtSlowInterval = 1.0` s. A throw inside the realtime loop clears the interval and emits `rt_stop` so it fails safe. `stop()` clears the interval and flips `DataCollector.rt_active = false`.

---

## 6. The model-class contract

Every model lives in `base_models/`, `component_models/`, or `device_models/` and extends [`BaseModelClass`](./BaseModelClass.md) (directly or through an intermediate like `Capacitance`/`Resistor`/`TimeVaryingElastance`).

- **`static model_type`** — the string key used in `available_model_map` and in definition JSON. Model classes carry **no UI metadata**; the edit schema is a consumer concern (in explain-ui it lives at `src/model-interface/registry.ts`).
- **`constructor(model_ref, name = "")`** — `model_ref` is the whole engine `model` object; the base stores it as `this._model_engine` and caches `this._t = model_ref.modeling_stepsize`. Initialize independent props (config), dependent props (computed outputs), and `_`-prefixed local refs here. (`build()` passes a 3rd `model_type` arg the base ignores.)
- **`init_model(args)`** — base impl maps each `{key, value}` in `args` onto `this[key]`, then inits everything declared in `this.components` (instantiating any that don't exist yet, which in a normal build `build()` has already done), and finally sets `this._is_initialized = true`. Override to resolve cross-model references, then call/replicate the base behaviour.
- **`step_model()`** — base impl runs `calc_model()` only when `is_enabled && _is_initialized`. Don't override unless you need custom gating.
- **`calc_model()`** — where the physics happens. Override this.

---

## 7. Cross-cutting patterns

These are documented once here; per-class docs should link back rather than restate them.

### 7a. The factor / effective-value pattern

Core physics params are never used raw. Each tunable has a base value plus three multiplier layers combined **additively** against the base into an `*_eff` (or `*_step`) value:

| Layer | Persistence | Set by |
|---|---|---|
| `<p>_factor` | **non-persistent** — reset to `1.0` at the end of each step | per-step effects that a model re-asserts every step (a one-off write is gone after one step, so a TaskScheduler tween belongs on `_factor_ps`) |
| `<p>_factor_ps` | **persistent** | user/scenario adjustments |
| scaling layer | **persistent** | `ModelScaler` (and the Calibrator's PAP lever, on `IPSL`/`IPSR` `r_factor_scaling_ps`) |

The formula (see `Capacitance.calc_elastances` / `Resistor.calc_resistance`):

```
p_eff = p + (factor-1)*p + (factor_ps-1)*p + (factor_scaling_ps-1)*p
```

When adding a tunable param, follow this convention so it composes with interventions and scaling.

**⚠️ Two classes compose differently.** Verify before you copy:

- **[`BloodVessel`](./BloodVessel.md)** — most of the circulation — overrides `calc_resistances`/`calc_elastances` and composes **multiplicatively**. The three R layers are multiplied by the ANS multiplier, `r_eff = r · factor · factor_ps · factor_scaling_ps · (1 + (ans_activity − 1)·ans_sens)`. Elastance follows R through the α-coupling: `el_eff = el_base · (el layers) · (R multiplier)^α`. Its `u_vol` uses the inherited additive layers, then is multiplied by the ANS unstressed-volume multiplier.
- **[`HeartChamber`](./HeartChamber.md)** stays additive but adds extra terms: drug, Mob, load and remodelling factors, plus an ANS term that is *subtracted* for `el_min` (lusitropy).

**The scaling layer is always named `*_factor_scaling_ps`**, in every family: `el_base_factor_scaling_ps`, `u_vol_factor_scaling_ps`, `r_factor_scaling_ps` ([`Capacitance.js`](../base_models/Capacitance.js), [`Resistor.js`](../base_models/Resistor.js)), and `dif_o2_factor_scaling_ps`, `dif_co2_factor_scaling_ps` ([`GasExchanger.js`](../base_models/GasExchanger.js), [`BloodDiffusor.js`](../base_models/BloodDiffusor.js)). The diffusors used `*_factor_scaling` (no `_ps`) until the v1.0 documentation pass.

### 7b. `ncc_*` cycle counters live on the components

The cycle counters are fields of the models that drive them, advanced once per step: `Heart.ncc_atrial` and `Heart.ncc_ventricular` (reset to `-1` at SA firing / ventricular activation; `Pda` and `Monitor` read `Heart.ncc_ventricular`), and `ncc_insp`/`ncc_exp` on `Breathing` and `Ventilator`. A value of `1` marks the first full step of a phase. The engine `model` object holds no counters. The `DataCollector` **always** watches `Heart.ncc_ventricular` and `Heart.ncc_atrial` (pushed onto the watchlist in its constructor and on reset) so the ECG is available regardless of the user watchlist.

### 7c. Blood/gas composition propagation

There is no global solver moving solutes around — composition rides the flow. `Resistor.calc_flow` moves volume by calling `comp_from.volume_out(flow*dt)` then `comp_to.volume_in(...)`. The blood compartments' `volume_in(dvol, comp_from)` (`BloodCapacitance`, `BloodTimeVaryingElastance`, `HeartChamber`, all through [`helpers/BloodMixing.js`](../helpers/BloodMixing.js) `mix_blood_in`) mixes the incoming blood by the incoming volume fraction, with `vol` the volume after the inflow (exact mass balance):

```
concentration += (concentration_from - concentration) * dvol / vol
```

applied to `to2`, `tco2`, every entry in `solutes` and `drugs`, and `temp`. **Viscosity is not mixed**: `Blood` derives it from each compartment's haemoglobin every step. This dilution is how blood gases, solutes, drugs and temperature propagate through the circuit; a `fixed_composition` compartment keeps its composition.

Gas compartments do the same for their gas composition in `GasCapacitance.volume_in`. Exchange **between** blood and gas, or across a membrane, is done by the diffusors and exchangers (`GasExchanger` alveolus↔capillary, `BloodDiffusor` placenta). Mixing without net flow between two compartments of one continuous pool is `Resistor.mix_flow` (see [Resistor](./Resistor.md#mixing-without-net-flow-mix_flow)). See [`BloodCapacitance.md`](./BloodCapacitance.md).

### 7d. Who writes the scaling layer

[`ModelScaler`](./ModelScaler.md) writes the `*_factor_scaling_ps` layer for elastances, resistances and unstressed volumes, never the `_ps` user layer, so its scaling composes with user and scenario adjustments. Its **volume** scaling is the exception: it multiplies the raw `vol` and `u_vol` of the compartments in the scaler config. The factor groups set the layer **absolutely** (1.0 = no scaling), so anything left in it is replaced by the next `scale` command. `incorporate()` bakes the scaling layers of every component named in the scaler config into the base values (`u_vol`, `el_base`, `el_min`, `el_max`, `r_for`/`r_back`) and resets those factors to `1.0`, keeping the model's behaviour (BloodVessel's R→E coupling, HeartChamber's `el_k` and the additive models' `_ps` layers are carried along; only the heart chambers' additive ANS term changes, see [ModelScaler](./ModelScaler.md#incorporate-baking-the-layer)). **Since v1.0 every shipped scenario is baked**, and the generators and `build_patient.mjs` end with `incorporate`, so a scenario as loaded has all scaling layers at 1.0.

ModelScaler is not the layer's only writer: the [Calibrator](./Calibrator.md)'s PAP lever writes `r_factor_scaling_ps` on `IPSL`/`IPSR`, and `Uterus` and `MaternalPlacenta` write the scaling layer of their own vessels (pregnancy adaptation). A `ModelScaler.reset()` or `incorporate()` on those components would interact with them. Weight scaling (`scale_to_weight`) is linear and volume-only — the inverse elastance/resistance scaling is commented out, and nothing scales heart rate or VO₂. `scaleModel(group, factor)` routes through the big `switch` in `ModelEngine.scale_model` to the many `scale_*` methods (`scale_blood_volume`, `scale_systemic_resistances`, `scale_to_weight`, …). `reset` calls `ModelScaler.reset()` and restores `model.weight = model._baseline_weight`.

---

## 8. How to add a new model

1. **Create the class** in `base_models/`, `component_models/`, or `device_models/`, extending `BaseModelClass` (or a suitable intermediate).
2. **Give it a `static model_type`** string — the key used at build and in definition JSON.
3. **Implement `init_model(args)`** (resolve cross-model refs, set `_is_initialized`) and **`calc_model()`** (the physics).
4. **Follow the factor convention** (§7a) for any tunable param so it composes with interventions and scaling — and use the **correct scaling suffix** for the family you're modelling.
5. **Export it from [`ModelIndex.js`](../ModelIndex.js).** The engine builds `available_model_map` from everything `ModelIndex` exports. **Forgetting this export is the usual cause of "model type not found" at build.**
6. **Reference the `model_type`** in your `model_definitions/*.json` `models` map.
7. **Add a `model_type` entry to the consumer's edit schema** (in explain-ui: `src/model-interface/registry.ts`) so the parameters become editable in the app (the engine ships no UI metadata).
8. **Write a doc** in `docs/` following the template in §9.

---

## 9. The house doc template (v1.0)

Every per-class doc in `docs/` follows this structure. The exemplar is [`BloodCapacitance.md`](./BloodCapacitance.md). A page has two layers: sections 1–2 are written for students and clinicians (plain language, no code), and sections 3–11 are the developer reference. Leave out a section only when it would be empty, and say so in one line when a reader would expect it (e.g. "No factors of its own").

1. **Title + summary.** One or two sentences: what the model is.
2. **Physiology.** What it represents in the patient or device, in plain language, and what a clinician would see change when it changes. No code identifiers beyond the model's name.
3. **Inheritance.** An ASCII tree up to `BaseModelClass`, plus the classes that extend this one.
4. **Properties.** Tables with `Property | Unit | Default | Description`, split into *config* (set in the definition JSON), *outputs* (computed each step), and *set by other models* (props another model writes onto this one). The default is the constructor value; a scenario usually overrides it. Mark sentinel values (e.g. `-1 = not calculated`). For inherited props, link to the parent's table instead of repeating it.
5. **Calculation.** The equations in the order `calc_model()` runs them, under the actual method names, plus any overridden hooks (`volume_in`, …).
6. **Factor system.** Which tunables carry the three layers and whether they compose additively or multiplicatively. Link to §7a, don't re-derive it.
7. **Inputs and outputs.** Which models this one reads and writes, and which models read or write it.
8. **Assumptions and limitations.** Simplifications, calibrated constants and their rationale, and known gaps.
9. **Example definition (JSON).** A real entry copied from a canonical scenario (`term_neonate_72h` where possible), trimmed to the config props, with the scenario and path named.
10. **Usage in the scenarios.** Where it is instantiated and what it is wired to.
11. **References.** Literature for the equations and default values. If the class introduces no literature-derived values, say so.

**Short form** for helpers and very small classes: title + summary, API (functions/methods with arguments and return values), where it is used, notes.

---

## 10. Helpers

One line each; follow the link for detail.

- **[DataCollector](./DataCollector.md)** — fast (`watch_list`, default `sample_interval` 0.005 s) and slow (`watch_list_slow`, 1.0 s) watchlists of dot-path props; `collect_data()` buffers, `get_model_data()` drains, `clean_up()` drops entries whose model no longer exists (a disabled model keeps its watch). Always watches `Heart.ncc_*`.
- **[TaskScheduler](./TaskScheduler.md)** — deferred mutations every `_task_interval` (0.015 s): numeric tweens (type 0), instant boolean/string swaps (type 1), scheduled method calls (type 2). Writes directly to model props (usually a `*_factor_ps` or base param).
- **[ModelScaler](./ModelScaler.md)** — group scaling (absolute, on the `*_factor_scaling_ps` layer), linear volume-only weight scaling, and `incorporate` (bake); routed via `POST "scale"` → `ModelEngine.scale_model`.
- **[BloodMixing](./BloodMixing.md)**, **[GasMixing](./GasMixing.md)** — composition mixing on inflow and exchange without net flow (§7c).
- **[Orifice](./Orifice.md)** — Bernoulli orifice term and jet velocity (Shunts, Pda).
- **[Units](./Units.md)** — shared physical constants (STPD O2 conversion, gas constant, water vapour).
- **[Calibrator](./Calibrator.md)** — shared closed-loop secant calibration (`buildLiveControllers`/`runCalibration`/`measureWindow`); backs both offline patient-building and the live `tune_model` path.
- **[ChannelWriter](./ChannelWriter.md)** — typed realtime data-plane writer (chart ring + anim snapshot); flushed each realtime tick.
- **[RealtimeChannels](./RealtimeChannels.md)** — the `RT_MSG` message constants and channel/transport descriptors for the typed data plane.
- **[AnimationPacker](./AnimationPacker.md)** — builds the component→slot registry and packs per-frame sprite animation data from the live model.
- **[RealTimeMovingAverage](./RealTimeMovingAverage.md)** — moving-average helper used for smoothing realtime-derived signals.
- **[ModelRegistry](./ModelRegistry.md)** — `model_type` → class lookup that lets `BaseModelClass` instantiate sub-models (built-in or custom) without an import cycle; filled by `ModelEngine` at startup.

### Realtime read side (`realtime/`, main thread)

The mirror of the `ChannelWriter`/`AnimationPacker` write side, running on the **main thread** — separate from the control-plane `ModelEmitter` events:

- **[RealtimeBus](./RealtimeBus.md)** — single `requestAnimationFrame` loop that drains a `ChannelReader` and pushes frames to renderer adapters (`onRegistry`/`onFrame`). Listens on a **second** worker `message` listener for the `RT_MSG.*` types that `Model.receive()` ignores.
- **[ChannelReader](./ChannelReader.md)** — decodes the shared-memory (`Atomics`/seqlock) or transferable transport; `drainChart()` returns every new row in order, `readAnim()` returns the latest frame only.

## 11. Other references

- **[MODEL_DEFINITIONS](./MODEL_DEFINITIONS.md)** — the scenario / model-definition JSON format (the file `load()` consumes).
- **[TESTING](./TESTING.md)** — running the engine headlessly in Node (the harness + `probe_*` scripts).
- **[README](./README.md)** — the full per-class documentation index.

````

### FILE: explain-engine/docs/AnimationPacker.md

````markdown
# AnimationPacker

`AnimationPacker.js` turns the **diagram definition + live model state** into the per-frame scalar stream that drives the PixiJS sprite diagram. It is worker-side infrastructure, not a physiological model. Built once at model build from `model.diagram_definition.components` (and rebuilt by `ModelEngine.update_diagram()` when the diagram is edited live), it packs each animated component's **magnitude** (volume or flow) and **tint source** (`to2`) into a fixed-stride `Float32` frame and hands it to [ChannelWriter](./ChannelWriter.md) every realtime tick. See [RealtimeChannels](./RealtimeChannels.md) for the anim frame layout and [ARCHITECTURE](./ARCHITECTURE.md) for the full pipeline.

## Role in the engine

Aggregation deliberately lives **in the worker**. A single diagram component may map to several engine models (e.g. a lung = `["LL_CAP","LL_ART","LL_VEN"]`); summing happens here against **direct model references** so the main thread receives ready-to-render floats and never needs the model topology — only the *AnimRegistry* (component → slot) this class emits in the handshake.

Flow per realtime tick (in `ModelEngine._model_step_rt`): after the model steps, `animation_packer.pack_and_write(channel_writer, model.model_time_total)` packs the latest frame; `channel_writer.flush()` then ships it (no-op in shared mode). The registry is sent once via `ModelEngine._post_rt_channels()` → `AnimationPacker.registry()`.

## Key state

Constructor: `new AnimationPacker(model, version = 1)`

- `model` — the engine model object (has `.models` and `.diagram_definition`).
- `version` — registry version, typically the build counter.

| Field | Description |
|---|---|
| `_model` | Reference to the engine model object |
| `version` | Registry version sent in the handshake |
| `enabled` | `true` only if ≥1 animated component was found |
| `_descriptors` | Precomputed per-component packing descriptors `{ index, magRefs, magProp, tintRef }` |
| `_components` | Registry entries for the main thread `{ name, index, kind, models, tinting }` |
| `max_to2` | Tint normalization hint for the renderer (default `7.1`, overridable from `diagram.settings.max_to2`) |
| `stride` | Floats per frame = `animStride(componentCount)` |
| `_frame` | Reusable `Float32Array` scratch (no per-tick allocation) |

If the model has no `diagram_definition` or no `.components`, the constructor returns early and `enabled` stays `false`.

## Key methods

### `_build(components)` (constructor-time)

Iterates `Object.entries(components)` assigning a dense `index` to each **animated** component. For each:

- Reads `comp.layout.general.animatedBy` (`"vol"` | `"flow"` | `"none"`). **Skips** anything not `"vol"`/`"flow"` (static titles/devices) and anything with no `models`.
- Picks `magProp = "vol"` or `"flow"`; resolves `magRefs` = the live model objects named in `comp.models` (filtering out missing ones). Skips the component if none resolve.
- If `general.tinting === true`, resolves a `tintRef` via `_resolveTintRef`.
- Pushes a descriptor and a registry entry, then increments `index`.

Finally sets `stride = animStride(count)`, allocates `_frame`, and sets `enabled = count > 0`.

### `_resolveTintRef(comp, magRefs)`

Picks the model whose `to2` colours this component:

1. **Connector:** if any `magRef` is a resistor whose `comp_from` names an upstream blood model that carries `to2`, use that upstream compartment. (The diagram's `dbcFrom` is a diagram *component* name, which for grouped multi-model compartments is not itself an engine model.)
2. **Fallback:** if `comp.dbcFrom`/`comp.dbcTo` maps straight to a model with `to2`, use it.
3. **Compartment / last resort:** the first of the component's own `magRefs` carrying `to2`.
4. Returns `null` if none found.

### `pack_and_write(writer, time)`

The per-tick hot path. No-op if `!enabled`. Cheap: one pass over precomputed descriptors, no allocation.

- Writes `time` into `frame[ANIM_TIME_SLOT]`.
- For each descriptor: sums `magProp` across all `magRefs` (skipping non-numbers) into `frame[animMagOffset(index)]`; reads `tintRef.to2` (or `0`) into `frame[animTintOffset(index)]`.
- Calls `writer.writeAnimFrame(frame)`.

### `registry()`

Returns the AnimRegistry for the one-time `RT_MSG.CHANNELS` handshake:

```js
{
  version,
  components: [{ name, index, kind, models, tinting }, …],
  layout: { count, stride, max_to2 },
}
```

The main thread uses `components[i].index` to know which `(mag, tint)` slot pair belongs to which sprite.

## Protocol / layout

Frames follow the anim layout from [RealtimeChannels](./RealtimeChannels.md): `[time, mag_0, tint_0, mag_1, tint_1, …]`. Slot 0 is model time (`ANIM_TIME_SLOT`); thereafter `ANIM_FLOATS_PER_COMPONENT` (= 2) floats per component, addressed by `animMagOffset(index)` / `animTintOffset(index)`. Stride = `animStride(count) = 1 + 2*count`. The renderer maps a component's raw `to2` against `max_to2` for its tint.

## Notes / caveats

- **Magnitude is a raw sum, not a normalized value.** `pack_and_write` sums `vol`/`flow` across mapped models; any normalization/scaling for sprite sizing happens in the renderer, not here.
- **Tint is `to2` only.** Components without `tinting: true`, or with no resolvable `to2` source, emit `0` in their tint slot.
- **Live diagram edits rebuild the packer.** `update_diagram()` constructs a fresh `AnimationPacker` (bumping `build_counter` → new `version`), re-acquires the anim snapshot at the new stride via [ChannelWriter](./ChannelWriter.md), and re-posts the handshake — without rebuilding the running model. The version bump is what lets the reader discard frames packed against the old layout.
- **Descriptors hold direct model references.** They are captured at build; if a model object is replaced (rather than mutated), the packer must be rebuilt or it will keep summing the stale reference.

````

### FILE: explain-engine/docs/Ans.md

````markdown
# Ans

`Ans` is the autonomic nervous system: the reflex network that keeps blood pressure and blood gases near their set-points. It is a small manager. It owns the reflex arcs as sub-models, switches them all on or off together, and solves the blood gases the chemoreceptors read. The reflexes themselves are [AnsAfferent](./AnsAfferent.md) receptors feeding [AnsEfferent](./AnsEfferent.md) effector pathways.

## Physiology

The autonomic nervous system adjusts the body continuously, without conscious control:
- **Baroreflex.** Stretch receptors in the aortic arch and carotid sinus sense blood pressure. A fall in pressure raises heart rate, contractility and vascular tone (sympathetic) within seconds; a rise does the opposite (vagal).
- **Chemoreflex.**
  - Central chemoreceptors (mainly pCO2/pH) and peripheral ones in the carotid body (mainly pO2) raise ventilation when CO2 rises or O2 falls.
  - In the newborn, hypoxaemia also slows the heart: the diving-reflex-like bradycardia that follows an apnoea.

Each reflex is an arc: a receptor that fires faster or slower as its input moves from its set-point, a central integration, and efferent nerves that change an organ's behaviour.

## Inheritance

```
BaseModelClass
  └── Ans
```

## Properties

### Config (set in the definition JSON)

| Property | Unit | Default | Description |
|---|---|---|---|
| `ans_active` | boolean | `true` | Master switch, copied onto every sub-model; an inactive efferent outputs 1 (no effect). |
| `blood_composition_models` | list | `[]` | Compartments whose blood gases are solved for the chemoreceptors (`["AA"]` in every scenario). |
| `components` | object | `{}` | The afferents and efferents (built by the base class). |

## Calculation

Every 50 ms:
1. `ans_active` is written onto every component.
2. While active, [`calc_blood_composition`](./BloodComposition.md) runs on each `blood_composition_models` entry, so the chemoreceptors read current pO2, pCO2 and pH.

The reflexes run in the components: each afferent turns its input into a firing rate (0–1, 0.5 at the set-point) and passes it to its efferents. Each efferent adds the deviations of its afferents, maps the result to an effect factor (1 at rest) and writes it onto its target.

## The reflex network in the scenarios

Every scenario (term_neonate_72h values; the set-points are re-anchored per scenario to its calibrated rest):

| Afferent | Input | min / set / max | → Efferent(s) |
|---|---|---|---|
| `BR_MAP` (baroreceptor, tc 0.5 s) | `AAR.pres` | 25 / 60.6 / 100 mmHg | `EF_HR`, `EF_SVR`, `EF_HEART` |
| `CR_PCO2` (central chemoreceptor) | `AA.pco2` | 15 / 39.7 / 75 mmHg | `EF_MV` |
| `CR_PO2` (peripheral chemoreceptor, weight −0.4) | `AA.po2` | 30 / 75.5 / 150 mmHg | `EF_MV` |
| `CR_PH` | `AA.ph` | 6.9 / 7.36 / 7.7 | none |

| Efferent | Target | Effect at firing 0 / 1 | Time constant |
|---|---|---|---|
| `EF_HR` | `Heart.ans_activity_hr` | 1.5 / 0.43 | 0.5 s |
| `EF_SVR` | `Circulation.ans_activity` (vascular tone) | 2.0 / 0.5 | 10 s |
| `EF_HEART` | `Heart.ans_activity` (contractility) | 1.15 / 0.85 | 10 s |
| `EF_MV` | `Breathing.mv_ans_factor` | 0.1 / 10 | 5 s |

So a fall in pressure (low baroreceptor firing) raises heart rate, vascular tone and contractility, and a rise in pCO2 raises minute ventilation. A fall in pO2 raises it too, through the negative weight on `CR_PO2`.

**Hypoxic bradycardia** (added by `scripts/_add_apnea.mjs`; it was in the preterm scenarios, removed on 2026-10-25 to be rebuilt): `CR_PO2_HR` (`AA.po2`, set-point a few mmHg below the resting pO2) → `EF_HR_CHEMO` → `Heart.hr_chemo_factor`, with effect 0.5 at firing 0 and 1 at 1, so it only slows the heart. See [Apnea](./Apnea.md).

## Factor system

None of its own; the efferents write the targets' ANS inputs (`ans_activity`, `ans_activity_hr`, `mv_ans_factor`, `hr_chemo_factor`), which the targets apply in their own way (e.g. [BloodVessel](./BloodVessel.md) through `ans_sens`).

## Inputs and outputs

- **Reads:** the `blood_composition_models` compartments (solved).
- **Writes:** `ans_active` of its components; the solved blood gases of `AA`.
- **Written by:** the user (`ans_active`); the scenario generators (set-points, wiring).
- **Read by:** its components.

## Assumptions and limitations

- **Reflex responses of term_neonate_72h** (re-validation (l), `BR_MAP` and `EF_HR` time constants 4 and 2 s → 0.5 s, `CR_PO2` weight −0.15 → −0.4, baroreflex set-point re-anchored to the resting arch pressure so it is neutral at rest):
  - **Baroreflex sensitivity** (transfer gain from systolic pressure to RR interval at 0.1 Hz, systemic resistance modulated ±5 %): 6.0 ms/mmHg (was 1.5; 0 with the ANS off). Term infants: ~15 ms/mmHg in the first days (Andriessen 2005, LF transfer gain), 6.4 at 2–4 weeks (Yiallourou 2010). The static strength was already ~7 ms/mmHg; the slow receptor smoothing (4 s) and HR efferent (2 s) passed only ~23 % of it at 0.1 Hz, where the real vagal arm acts within about a second.
  - **Hypoxic ventilatory response** (FiO₂ 0.21 → 0.15): minute ventilation +16 % at 30 s, +19 % at 1 min, then +11 % by 5 min as PaCO₂ falls (39.6 → 34.9 mmHg); SaO₂ 97 → 93.4 %. Term newborns: an early rise (~+17 %, Rigatto 1982) then a late fall of ~14 % from the peak (De Boeck 1984). With the central **hypoxic ventilatory depression** ([Breathing](./Breathing.md#hypoxic-ventilatory-depression)) the late fall is 12 % from the peak (+18 % at 1 min, +4 % at 5 min); before it, the hypocapnic brake alone gave ~8 % and severe hypoxia stayed alkalotic.
  - **Hypercapnic response:** gain 0.25 (fractional rise in ventilation per mmHg PaCO₂; neonatal 0.10–0.40, `validate_respiratory.mjs`).
- **One receptor per reflex, set-points fixed.** No baroreceptor resetting over hours, no adaptation of the chemoreceptors to chronic hypercapnia.
- **Afferent deviations add in the efferent**, so two afferents on one efferent can drive its firing rate outside 0–1 (see [AnsEfferent](./AnsEfferent.md)).
- **`CR_PH` is computed but drives nothing** in every scenario.
- **Switching off is abrupt:** an inactive efferent jumps to 1 without its time constant.
- **A component name that does not resolve throws** in the `ans_active` copy (the components are built from the definition, so this only happens with hand-edited state).
- **Lag of up to one interval:** the afferents and efferents update every 15 ms and Ans every 50 ms, so the loop carries up to one interval of delay. This is intended and stable.

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Ans` (trimmed; `components` holds the eight sub-models above):

```json
{
  "name": "Ans",
  "model_type": "Ans",
  "is_enabled": true,
  "ans_active": true,
  "blood_composition_models": ["AA"]
}
```

## Usage in the scenarios

One instance in every scenario, with the network above. No shipped scenario has the hypoxic-bradycardia arc at present (the preterm scenarios that had it were removed on 2026-10-25 to be rebuilt).

## References

- Andriessen P, et al. Baroreceptor reflex sensitivity in human neonates: the effect of postmenstrual age. *J Physiol* 2005;568:333–41. doi:10.1113/jphysiol.2005.093641
- Yiallourou SR, Sands SA, Walker AM, Horne RSC. Postnatal development of baroreflex sensitivity in infancy. *J Physiol* 2010;588:2193–203. doi:10.1113/jphysiol.2010.187070
- Rigatto H, et al. Ventilatory response to 100% and 15% O2 during wakefulness and sleep in preterm infants. *Early Hum Dev* 1982;7:1–10. doi:10.1016/0378-3782(82)90002-0
- De Boeck C, Van Reempts P, Rigatto H, Chernick V. Naloxone reduces decrease in ventilation induced by hypoxia in newborn infants. *J Appl Physiol* 1984;56:1507–11. doi:10.1152/jappl.1984.56.6.1507

The baroreflex HR dynamics and the peripheral chemoreceptor weight are set from the references above; the set-points are each scenario's calibrated rest, and the other ranges and gains are model choices.

````

### FILE: explain-engine/docs/AnsAfferent.md

````markdown
# AnsAfferent

An `AnsAfferent` is an autonomic **receptor**. It reads one quantity (arterial pressure, a blood gas), turns it into a normalised firing rate between 0 and 1 (0.5 at the set-point), smooths it with a time constant, and sends it to the efferents it is wired to. It is one of the parts of the reflex network managed by [Ans](./Ans.md); [AnsEfferent](./AnsEfferent.md) turns the firing into an effect.

## Physiology

A baroreceptor fires faster as the arterial wall stretches; a chemoreceptor fires faster as pCO2 rises or pO2 falls. Around the normal value the response is roughly linear and saturates at the extremes: below some pressure the receptor is silent, above another it can't fire faster. The receptor also has a little inertia, so it follows changes with a lag of a second or more.

## Inheritance

```
BaseModelClass
  └── AnsAfferent
```

## Properties

### Config (set in the definition JSON)

| Property | Unit | Default | Description |
|---|---|---|---|
| `input_model`, `input_prop` | – | `""` | The quantity sensed, e.g. `AAR` / `pres`, `AA` / `pco2`. |
| `min_value` | input unit | 0 | Input at which the firing rate is 0. |
| `set_value` | input unit | 0 | Set-point: firing rate 0.5. Re-anchored per scenario to its calibrated rest. |
| `max_value` | input unit | 0 | Input at which the firing rate is 1. |
| `tc` | s | 1.0 | Time constant of the firing rate (0 = instantaneous). |
| `efferents` | list | `[]` | Efferents that receive the firing rate. |
| `effect_weight` | – | 1.0 | Weight (and sign) of this afferent in its efferents. Negative for a receptor whose effect opposes its firing, e.g. `CR_PO2` (−0.4): falling pO2 must raise ventilation. |
| `ans_active` | boolean | `true` | Copied from Ans. The afferent keeps firing; the efferents apply the gate. |

### Outputs

| Property | Unit | Description |
|---|---|---|
| `input_value` | input unit | Last value read. |
| `firing_rate` | 0–1 | Smoothed firing rate. |

## Calculation

Every 15 ms (skipped if `input_model` is missing or the input is not a finite number):

1. **Clamp** the input to `min_value … max_value` and take its deviation from the set-point.
2. **Piecewise-linear receptor curve**, with separate gains above and below the set-point:
   ```
   input ≥ set:  rate = 0.5 + 0.5 · (input − set) / (max − set)
   input < set:  rate = 0.5 − 0.5 · (set − input) / (set − min)
   ```
   (a zero-width side gives gain 0).
3. **Time constant:** `firing_rate += 0.015/tc · (rate − firing_rate)`.
4. **Report** to every efferent: `update_effector(firing_rate, effect_weight, name)`.

**Example**, `BR_MAP` in term_neonate_72h (25 / 60.6 / 100 mmHg, tc 0.5 s): a MAP of 45 mmHg gives `0.5 − 0.5·15.6/35.6 = 0.28`, so the heart-rate and tone efferents see a firing deficit of 0.22.

## Factor system

None.

## Inputs and outputs

- **Reads:** `input_model.input_prop`.
- **Writes:** nothing directly; it calls `update_effector` on its efferents.
- **Written by:** Ans (`ans_active`); the scenario generators (set-points, ranges, wiring).
- **Read by:** its efferents; `DataCollector` watchers (`firing_rate`).

## Assumptions and limitations

- **Static, piecewise-linear curve.** No rate sensitivity (a real baroreceptor responds to the rate of pressure rise as well as its level) and no resetting of the set-point.
- **Saturation by clamping** the input, not a sigmoid: the firing rate stops exactly at 0 and 1.
- **The asymmetric gains are set by the window:** a set-point closer to `max_value` makes the receptor more sensitive above it than below.

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Ans.components.BR_MAP` (trimmed to the config props):

```json
{
  "name": "BR_MAP",
  "model_type": "AnsAfferent",
  "is_enabled": true,
  "input_model": "AAR",
  "input_prop": "pres",
  "min_value": 25,
  "set_value": 60.56,
  "max_value": 100,
  "tc": 0.5,
  "efferents": ["EF_HR", "EF_SVR", "EF_HEART"],
  "effect_weight": 1
}
```

## Usage in the scenarios

`BR_MAP`, `CR_PCO2`, `CR_PO2` and `CR_PH` in every scenario; `CR_PO2_HR` (hypoxic bradycardia) in none at present (the preterm scenarios that had it were removed on 2026-10-25 to be rebuilt). Their settings are tabled in [Ans → The reflex network](./Ans.md#the-reflex-network-in-the-scenarios).

## References

No literature values; set-points are each scenario's calibrated rest.

````

### FILE: explain-engine/docs/AnsEfferent.md

````markdown
# AnsEfferent

An `AnsEfferent` is an autonomic **effector pathway**. It collects the firing rates its [AnsAfferent](./AnsAfferent.md) receptors send it, combines them into one firing rate, maps that to an effect factor (1 at rest), smooths it with a time constant, and writes it onto one property of a target model: heart rate, contractility, vascular tone or ventilation. It is part of the reflex network managed by [Ans](./Ans.md).

## Physiology

The brainstem integrates the receptors and sends the result out over sympathetic and vagal nerves. More sympathetic and less vagal activity raises heart rate, contractility and vascular tone; the reverse lowers them. Each organ responds at its own speed:
- the heart rate within one or two beats (vagal, fast);
- the vessels and contractility over 5–15 s (sympathetic, slower);
- ventilation over several breaths.

## Inheritance

```
BaseModelClass
  └── AnsEfferent
```

## Properties

### Config (set in the definition JSON)

| Property | Unit | Default | Description |
|---|---|---|---|
| `target_model`, `target_prop` | – | `""` | The property written, e.g. `Heart` / `ans_activity_hr`. |
| `effect_at_min_firing_rate` | – | 0 | Effect factor at firing rate 0. |
| `effect_at_max_firing_rate` | – | 0 | Effect factor at firing rate 1. |
| `tc` | s | 1.0 | Time constant of the effect (0 = instantaneous). |
| `ans_active` | boolean | `true` | Copied from Ans; when false the effect is 1. |

### Outputs

| Property | Unit | Description |
|---|---|---|
| `firing_rate` | 0–1 | Combined firing rate of the last update. |
| `effector` | – | Current effect factor (the value written to the target). |

## Calculation

**`update_effector(rate, weight, source)`**, called by each afferent on its own update, accumulates `(rate − 0.5) · weight` per source.

**Every 15 ms:**
1. **Combine.** `firing_rate = 0.5 + Σ over afferents of (their average weighted deviation in this window)`, clamped to 0–1. Afferents **add**: a second receptor adds its drive instead of diluting the first.
2. **Map to an effect**, piecewise linear with 1 at 0.5:
   ```
   firing ≥ 0.5:  effect = 1 + (effect_at_max − 1) · (firing − 0.5) / 0.5
   firing < 0.5:  effect = effect_at_min + (1 − effect_at_min) · firing / 0.5
   ```
   With the clamp, the effect always stays between `effect_at_min_firing_rate` and `effect_at_max_firing_rate`.
3. **Gate:** with `ans_active` false the effect is 1 at once (no time constant).
4. **Time constant:** `effector += 0.015/tc · (effect − effector)`.
5. **Write** `target_model.target_prop = effector` (skipped if the target is missing), and clear the accumulators.

**Example**, `EF_HR` in term_neonate_72h (effect 1.5 at firing 0, 0.43 at firing 1, tc 0.5 s): the baroreceptor firing 0.28 at a MAP of 45 mmHg gives an effect of `1.5 + (1 − 1.5) · 0.28/0.5 = 1.22`, so within about a second Heart adds `0.22 · heart_rate_ref · ans_sens` to its rate.

## Factor system

None of its own. What the target does with the value is the target's business: Heart adds `(ans_activity_hr − 1) · heart_rate_ref · ans_sens` to its rate and scales contractility and relaxation with `ans_activity` (see [Heart](./Heart.md)), Circulation passes `ans_activity` to each vessel's `ans_sens`, and Breathing multiplies the minute volume by `mv_ans_factor`.

## Inputs and outputs

- **Reads:** the afferents' reports (through `update_effector`).
- **Writes:** `target_model.target_prop`.
- **Written by:** its afferents; Ans (`ans_active`); the scenario generators (ranges, time constants).
- **Read by:** its target; `DataCollector` watchers (`effector`, `firing_rate`).

## Assumptions and limitations

- **Additive integration, then a clamp.** Two afferents on one efferent add their deviations; the clamp caps the combined drive at the configured range. In the shipped wiring only `EF_MV` has two (pCO2 and pO2); the clamp keeps `mv_ans_factor` within 0.1–10 (it reached −0.035 and 11.35 at the extremes before v1.0).
- **One target per efferent;** a nerve with several effects is several efferents fed by the same afferent (as `BR_MAP` → `EF_HR`, `EF_SVR`, `EF_HEART`).
- **No separate sympathetic and vagal limbs** with their own dynamics; one time constant per efferent.

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Ans.components.EF_HR` (trimmed to the config props):

```json
{
  "name": "EF_HR",
  "model_type": "AnsEfferent",
  "is_enabled": true,
  "target_model": "Heart",
  "target_prop": "ans_activity_hr",
  "effect_at_max_firing_rate": 0.428,
  "effect_at_min_firing_rate": 1.5,
  "tc": 0.5
}
```

## Usage in the scenarios

`EF_HR`, `EF_SVR`, `EF_HEART` and `EF_MV` in every scenario; `EF_HR_CHEMO` (hypoxic bradycardia) in none at present (the preterm scenarios that had it were removed on 2026-10-25 to be rebuilt). Their targets, ranges and time constants are tabled in [Ans → The reflex network](./Ans.md#the-reflex-network-in-the-scenarios).

## References

No literature values; ranges and time constants are model choices.

````

### FILE: explain-engine/docs/Apnea.md

````markdown
# Apnea

`Apnea` generates the recurring breathing pauses of apnoea of prematurity. It runs a breathing ↔ apnoea cycle with irregular but reproducible timing. During a pause it uses existing levers: it switches spontaneous breathing off (central), closes the upper airway (obstructive), or both (mixed). It computes no physiology itself: the desaturation and, through the chemoreflex, the bradycardia follow from the gas exchange and the ANS.

## Physiology

Preterm infants have an immature respiratory control: breathing stops for 10–20 s or longer, several times an hour, more often the more preterm the infant.
- **Central** apnoea (no respiratory effort) is the most common type.
- **Obstructive** apnoea is effort against a closed upper airway, no flow.
- **Mixed** apnoea starts obstructive and continues central.

During the pause alveolar O2 falls and the blood desaturates. The low pO2 triggers a reflex bradycardia within seconds. Longer pauses desaturate deeper and are more often followed by bradycardia. Heart rate usually recovers before saturation, because the vagal reflex is faster than reoxygenation.

## Inheritance

```
BaseModelClass
  └── Apnea
```

## Properties

### Config (set in the definition JSON)

| Property | Unit | Default | Description |
|---|---|---|---|
| `apnea_enabled` | boolean | `false` | Switch (`switch_apnea`). Off in every scenario. |
| `apnea_frequency` | /min | 0.5 | Mean number of episodes per minute. |
| `apnea_duration` | s | 12 | Mean episode duration. Scenarios 14–20. |
| `apnea_variability` | 0–1 | 0.3 | Uniform jitter of interval and duration (± fraction of the mean). |
| `apnea_type` | – | `"central"` | `"central"`, `"obstructive"` or `"mixed"`. |
| `mixed_obstructive_fraction` | 0–1 | 0.5 | In a mixed episode, the leading obstructive share of the pause. |
| `seed` | – | 42 | Seed of the deterministic random generator. |
| `breathing_model` | – | `"Breathing"` | Model whose breathing is switched off. |
| `airway_model` | – | `"MOUTH_DS"` | Upper-airway resistor that is closed. |

### Episode state (saved with the state)

| Property | Unit | Description |
|---|---|---|
| `baseline_breathing` | boolean or null | Breathing state at the first build. A non-breathing patient (fetus) is never started; null until captured. |
| `drive_off` | boolean | Apnea has switched breathing off. |
| `airway_obstructed` | boolean | Apnea has closed the airway. |
| `episode_timer` | s | Time in the current phase. |
| `episode_duration` | s | Drawn duration of the running episode. |
| `next_interval` | s | Drawn gap until the next onset. |

### Outputs

| Property | Unit | Description |
|---|---|---|
| `in_apnea` | boolean | An episode is running. |
| `active_type` | – | Type of the running episode (`""` when breathing). |
| `apnea_count` | – | Completed episodes. |
| `last_apnea_duration`, `longest_apnea_duration` | s | Duration of the last and the longest episode. |
| `time_since_last_apnea` | s | Time since the last episode ended. |

## Calculation

Each step:
- **Not active** (`apnea_enabled` false, or a non-breathing patient): ventilation is restored if Apnea had suppressed it; nothing else.
- **Breathing:** count toward `next_interval`, then start an episode. Its duration is drawn, and
  - **central:** `Breathing.switch_breathing(false)`;
  - **obstructive / mixed:** `MOUTH_DS.no_flow = true`, unless the patient is intubated (Ventilator on, tube not out).
- **In an episode:**
  - a mixed episode also switches breathing off after `mixed_obstructive_fraction` of its duration;
  - at the end, ventilation is restored, the counters are updated and the next interval is drawn.

**Timing.** The gap is drawn so the *episode rate* matches `apnea_frequency`: mean gap = 60/frequency − mean duration (at least 1 s). Gap and duration each get a uniform jitter of ± `apnea_variability`. A linear congruential generator seeded by `seed` keeps headless runs reproducible.

**After a pause.** In an obstructive pause Breathing keeps its effort against the closed airway. Its load compensation raises the effort over the missed breaths (up to about ×2 at the default `load_compensation`), so the first breath after release is a large one.

**Desaturation and bradycardia** are emergent:
- the lungs stop refreshing alveolar gas, so [GasExchanger](./GasExchanger.md) loads less O2 and the arterial saturation falls;
- in the scenarios patched by `scripts/_add_apnea.mjs`, a pO2 heart-rate chemoreceptor (`CR_PO2_HR`, reading `AA.po2`) drives `EF_HR_CHEMO` onto `Heart.hr_chemo_factor` (see [Ans](./Ans.md));
- its set-point is a few mmHg below the baseline pO2, so the reflex is neutral at rest.

**Current behaviour** (`node scripts/probe_apnea.mjs preterm_28wk`, 2026-10-24, FiO2 0.25, no device in the model definition): 3 central episodes of 11.5–13.3 s in 5 min. SpO2 falls only from 93.3 to ~91.6 % and the heart rate from 153 to ~152 /min: no bradycardia. That is milder than clinical apnoeas of that length, which often desaturate below 85 %. It is listed for the scenario re-validation.

## Factor system

None. It switches `Breathing.breathing_enabled` and the airway resistor's `no_flow`.

## Inputs and outputs

- **Reads:** `Breathing.breathing_enabled` (baseline, once).
- **Writes:** `Breathing.breathing_enabled` (via `switch_breathing`), `MOUTH_DS.no_flow`.
- **Written by:** the user and bot (`apnea_enabled`, the settings); `scripts/_add_apnea.mjs`.
- **Read by:** `scripts/probe_apnea.mjs`; `DataCollector` watchers.

## Assumptions and limitations

- **Episodes are scheduled, not caused.** They don't follow sleep state, hypoxia, temperature, feeds or caffeine, and they don't end early on hypoxaemia: a pause runs its drawn duration.
- **No obstructive apnoea through a tube.** With an endotracheal tube in place the upper airway is bypassed and the Ventilator keeps `MOUTH_DS` closed, so an obstructive episode (or the obstructive part of a mixed one) does nothing, and Apnea never reopens `MOUTH_DS` while the tube is in. (Until the re-validation it closed and then reopened it, which left the natural airway open beside the tube after every episode: 56 of 120 s in a test with 8-s episodes.) The episode clock keeps running, so `apnea_count` still counts those episodes.
- **Shared levers.** [Resuscitation](./Resuscitation.md) also switches breathing; Apnea only reopens what it closed itself (`drive_off`, `airway_obstructed`).
- **Saved states keep the episode.** A state saved mid-pause finishes that pause after reload and restores ventilation.

## Example definition (JSON)

From the removed `preterm_28wk.json` (no shipped scenario has an Apnea model), `models.Apnea` (trimmed to the config props):

```json
{
  "name": "Apnea",
  "model_type": "Apnea",
  "is_enabled": true,
  "apnea_enabled": false,
  "apnea_frequency": 0.7,
  "apnea_duration": 16,
  "apnea_variability": 0.3,
  "apnea_type": "central",
  "mixed_obstructive_fraction": 0.5,
  "seed": 42,
  "breathing_model": "Breathing",
  "airway_model": "MOUTH_DS"
}
```

## Usage in the scenarios

In no shipped scenario at present: the three preterm scenarios that had it (dormant, `apnea_enabled` false) were removed on 2026-10-25 to be rebuilt. `scripts/_add_apnea.mjs` adds it to a scenario. Verification: `node scripts/probe_apnea.mjs <scenario>` reports per-episode duration, SpO2 and HR nadirs and the desaturation → bradycardia lag; `--no-chemoreflex` disables `EF_HR_CHEMO` for comparison. See [TESTING](./TESTING.md).

## References

No literature values; frequencies and durations are set per scenario for teaching.

````

### FILE: explain-engine/docs/BaseModelClass.md

````markdown
# BaseModelClass

`BaseModelClass` is the root class every model in the engine extends. It defines the lifecycle (construct → `init_model` → `step_model` → `calc_model`), the shared fields the engine relies on, and the `components` mechanism through which a model owns sub-models. It has no `model_type` of its own and is never instantiated directly.

## Physiology

None. This class is the contract that makes something a "model" the engine can build, step, record and scale. All physiology lives in the subclasses.

## Inheritance

```
BaseModelClass
  ├── Capacitance
  │     ├── BloodCapacitance
  │     │     └── BloodVessel
  │     └── GasCapacitance
  ├── TimeVaryingElastance
  │     ├── BloodTimeVaryingElastance
  │     └── HeartChamber
  ├── Resistor
  │     └── HeartValve
  ├── Container
  ├── BloodDiffusor, GasExchanger
  ├── Ventilator
  │     └── Sle6000
  └── every other component and device model (Heart, Circulation, Blood, Gas, Ans, Kidneys, Ecls, Monitor, …)
```

The base classes live in `base_models/`, the component models in `component_models/` and the devices in `device_models/`.

## Properties

### Config (set in the definition JSON)

| Property | Unit | Default | Description |
|---|---|---|---|
| `name` | – | constructor argument | Unique model name, and its key in `model.models`. |
| `description` | – | `""` | Free text, for documentation and the UI only. |
| `is_enabled` | boolean | `false` | When `false`, `step_model` skips the model. Every definition sets it explicitly. |
| `model_type` | – | `""` | Class key, used at build time to pick the class. Set from the definition (the class's static `model_type` holds the same string). |
| `components` | object | `{}` | Sub-models this model owns: `{ name: definition }`. See [Composite models](#composite-models-components). |

### Internal

| Property | Unit | Default | Description |
|---|---|---|---|
| `_model_engine` | – | constructor argument | Reference to the whole engine `model` object (other models, `weight`, `modeling_stepsize`, …). |
| `_t` | s | `modeling_stepsize` | Step size, copied once at construction. |
| `_is_initialized` | boolean | `false` | Set `true` at the end of `init_model`. Gates stepping. |

## Calculation (lifecycle)

1. **`constructor(model_ref, name = "")`**: stores the engine reference, copies the step size into `_t`, and sets the defaults above. `build()` passes a third `model_type` argument, which the base ignores. A subclass calls `super(model_ref, name)` first, then declares its own config props, outputs and `_`-prefixed locals.
2. **`init_model(args)`**: `args` is the definition as a list of `{key, value}` pairs.
   1. Each pair is copied onto the instance (`this[key] = value`), including `components`.
   2. For each entry in `this.components`, a sub-model is instantiated into `model.models`, **unless a model with that name already exists**. `build()` has already created all declared sub-models (see below), so in a normal build this step only matters for models added at runtime.
   3. Each sub-model is initialized with its own definition as args, so its sub-models are handled the same way, recursively.
   4. `_is_initialized` is set `true`.
3. **`step_model()`**: called every step by the engine. Runs `calc_model()` only when `is_enabled && _is_initialized`. Override it only to change that gate.
4. **`calc_model()`**: empty here. Subclasses put their per-step calculation in it.

A subclass that overrides `init_model` to resolve references to other models (e.g. `this._lv = this._model_engine.models["LV"]`) calls `super.init_model(args)`, or applies the args and sets `_is_initialized = true` itself.

### Composite models (`components`)

A model can own a local sub-network by listing sub-models in `components`. The sub-models are full members of `model.models`: they are stepped, recorded by the `DataCollector` and scaled like any other model. In the shipped scenarios 11 models own sub-models: Heart, Circulation (most vessels), Mob (the coronaries), Ans, Respiration, Ventilator, Ecls, Placenta, Pda, Shunts and Kidneys. Some sub-models own sub-models of their own.

**Build order.** `ModelEngine.build()`:
1. instantiates every model in the definition, in definition order;
2. instantiates every declared sub-model, recursively, before any `init_model` runs;
3. calls `init_model` on the top-level models, in definition order. Each owner initializes its own sub-models from its `init_model`.

So when any `init_model` runs, every model of the scenario already exists, and a lookup by name finds it regardless of where its owner sits in the file. A model found that way may not be initialized yet; its definition values are applied when its owner's `init_model` runs.

**Step order.** The step loop runs models in insertion order: the top-level models in definition order, then the sub-models, each owner's direct sub-models first, then theirs.

## Factor system

None. The factor/effective-value layers start at [`Capacitance`](./Capacitance.md), [`Resistor`](./Resistor.md) and [`TimeVaryingElastance`](./TimeVaryingElastance.md). See [ARCHITECTURE §7a](./ARCHITECTURE.md#7a-the-factor--effective-value-pattern).

## Inputs and outputs

- **Reads:** `model_ref.modeling_stepsize` at construction.
- **Written by:** `ModelEngine.build()` (construction, `init_model`); `TaskScheduler` and the UI (`setPropValue`), which can write any prop including `is_enabled`.
- **Read by:** `ModelEngine` (`step_model` every step), `DataCollector` (watched props), `ModelScaler`, and every model that resolves a reference to another model by name.

## Assumptions and limitations

- **Unknown args are kept, not rejected.** `init_model` copies every key onto the instance, so a typo or a key left over from an older class becomes a stray property instead of a build error. `scripts/doc_audit.mjs` lists such keys per class ("scenario keys unknown to the class").
- **`_t` is a snapshot.** It is copied at construction. No runtime setter changes `modeling_stepsize`, so this is safe today. A future runtime step-size change would have to refresh `_t` on every model (and on `TaskScheduler`).
- **A sub-model whose name is already a top-level model is not replaced.** The owner initializes the existing model again with the sub-model's definition, so the later values win.
- **Models added at runtime** (`add_model_to_engine`) create their sub-models in their own `init_model`. Models that collect compartments at build time (`Blood`, `Gas`) don't see them.

## Example definition (JSON)

`BaseModelClass` has no definition of its own. Every definition carries its shared fields next to the class's own parameters. From `term_neonate_72h.json`, `models.PA_PAAL` (trimmed):

```json
{
  "name": "PA_PAAL",
  "description": "input connector for PAAL",
  "model_type": "Resistor",
  "is_enabled": true,
  "components": {}
}
```

## Usage in the scenarios

Every model extends it, directly or through `Capacitance`, `Resistor`, `TimeVaryingElastance` or another intermediate class. To add a model, see [ARCHITECTURE §8](./ARCHITECTURE.md#8-how-to-add-a-new-model).

## References

None: this is software structure, not physiology.

````

### FILE: explain-engine/docs/Blood.md

````markdown
# Blood

`Blood` manages the circulating blood as a whole; it is not a compartment. It holds the reference composition (haemoglobin and the other solutes, O2 and CO2 content, temperature), seeds it into every blood compartment at build, sets the blood-wide properties (O2–Hb affinity, Haldane effect, viscosity), and once per second solves the blood gases at the sites a clinician samples. The chemistry itself is in [BloodComposition](./BloodComposition.md).

## Physiology

Blood carries oxygen bound to haemoglobin, CO2 mostly as bicarbonate, and the electrolytes and buffers that set its pH. A few properties belong to the blood as a whole:
- **O2–Hb affinity (P50).** Fetal haemoglobin binds oxygen more tightly (P50 ~18–19 mmHg) than adult haemoglobin (~27 mmHg), so a fetus or newborn is more saturated at the same pO2.
- **Haldane effect.** Deoxygenated blood carries more CO2, which helps unload CO2 in the tissues and the lungs.
- **Viscosity** rises steeply with the haematocrit. Polycythaemia raises vascular resistance; anaemia or haemodilution lowers it.
- **Temperature.** Blood is warmed or cooled by the tissues it passes through.

The clinician samples blood gases at fixed sites: **pre-ductal** (right arm, ascending aorta), **post-ductal** (umbilical artery, descending aorta) and **mixed venous** (pulmonary artery). A pre/post-ductal difference signals right-to-left shunting across the duct.

## Inheritance

```
BaseModelClass
  └── Blood
```

## Properties

### Config (set in the definition JSON)

| Property | Unit | Default | Description |
|---|---|---|---|
| `to2`, `tco2` | mmol/L | 0, 0 | Total O2 and CO2 content seeded into fresh compartments. |
| `solutes` | object | `{}` | Solute set seeded into fresh compartments (mmol/L; `albumin` g/L): `na`, `k`, `ca`, `cl`, `mg`, `lact`, `phosphates`, `uma` (unmeasured anions), `albumin`, `hemoglobin`, `glucose`. |
| `temp` | °C | 37.0 | Temperature seeded into fresh compartments (not the live temperature, see `set_temperature`). |
| `blood_temp_tc` | s | 10 | Time constant with which each compartment relaxes toward its perfusion target `body_temp`. |
| `P50_0` | mmHg | 20.0 | O2–Hb affinity at standard conditions, given to every compartment that has none: fetal ~18.8, neonatal 20, adult 26.7. Scenarios 18.5–20. |
| `haldane_coeff` | – | 1.0 | Haldane-effect strength in the CO2 solver (0 = off), given to every compartment. **2.2 in every scenario.** |
| `viscosity_plasma` | cP | 1.3 | Plasma viscosity. |
| `viscosity_hct_k` | per unit Hct | 3.13 | Exponential haematocrit coefficient (low-shear, in vivo). |
| `blood_containing_modeltypes` | list | 4 types | Model types treated as blood compartments: `BloodVessel`, `HeartChamber`, `BloodCapacitance`, `BloodTimeVaryingElastance`. |

### Outputs

| Property | Unit | Description |
|---|---|---|
| `viscosity` | cP | Viscosity at the build-time haemoglobin (a definition value is overwritten at build); changed by `set_viscosity`. |
| `viscosity_ref` | cP | Viscosity the vessel resistances are calibrated at: from the volume-weighted Hb of the circulating blood at build, copied onto every compartment. |
| `preductal_art_bloodgas` | object | `{ph, pco2, po2, hco3, be, so2}` of `AA`, every 1 s. |
| `art_bloodgas` | object | Same for `AD` (post-ductal). |
| `art_solutes` | object | Copy of `AD.solutes`. |

## Calculation

**Build (`init_model`).** For every model of one of the four types (except those with `blood_pool: false`):
- `haldane_coeff` is set, and `P50_0` if the compartment has none (so `PL_MAT` keeps its adult 26.7);
- a fresh compartment (empty `solutes`) gets `to2`, `tco2`, `solutes`, `temp` and `viscosity`. A loaded state keeps its own composition;
- the thermal fields are added if missing: `body_temp` (= its temperature), `blood_temp_tc`, `temp_ext_override` (false).

Then `viscosity_ref` is computed from the volume-weighted Hb of the enabled compartments and copied to all (`calibrate_viscosity_ref`).

**Every step**, for every compartment except `fixed_composition` ones:
```
temp      += (body_temp − temp) · min(1, dt / blood_temp_tc)
viscosity  = viscosity_plasma · exp(viscosity_hct_k · Hct),   Hct = Hb[mmol/L] / 0.6206 / 33,  clamped 0–0.9
```
A neonatal Hb of 10 mmol/L gives Hct 0.49 and ~6 cP. [BloodVessel](./BloodVessel.md) scales its resistance with `viscosity / viscosity_ref`, so a change in Hb moves the resistances.

**Every 1 s:** `calc_blood_composition` on `AA` and `AD` (stored in the two blood gas objects), and on `IVCI`, `SVC`, both right-atrial halves (`RAIVCI`, `RASVC`) and `PA`. The Monitor reads SvO2 from `PA`, the true mixed-venous blood.

## Methods

| Method | Effect |
|---|---|
| `set_solute(solute, value, site = "")` | One compartment, or every compartment plus the reference `solutes`. |
| `set_to2(value, site = "")`, `set_tco2(value, site = "")` | One compartment or all; the reference `to2`/`tco2` is not updated. A perturbation: gas exchange and metabolism take over from there. |
| `set_P50(p50)` | Every compartment and `P50_0`. |
| `set_haldane_coeff(k)` | Every compartment and `haldane_coeff`. |
| `set_viscosity(cP)` | Scales `viscosity_plasma` so the viscosity at the current reference becomes `cP` (plasma proteins, cold agglutinins); resistances follow. |
| `set_temperature(t, site = "")` | A **cold or warm blood bolus**: stamps `temp` on all compartments (or one), which then relax back to `body_temp`. 37 → 34 °C in term_neonate_72h is back to 36.6 °C within 30 s and cools the core 0.3 °C. Lasting changes go through Thermoregulation. |
| `set_perfusion_target(core)` | Called by Thermoregulation: `body_temp` of every compartment not under device control (`temp_ext_override`). |
| `get_thermal_state(density, cp)` | Heat capacity and mean temperature of the enabled, non-fixed blood, for Thermoregulation's heat balance. |
| `calc_viscosity(hb)` | The viscosity law above. |
| `calibrate_viscosity_ref()` | Re-takes `viscosity_ref` from the volume-weighted Hb of the circulating blood and copies it to every compartment (what `init_model` does at build). For tools that change the Hb of a scenario they then save (`build_patient.mjs`, `_make_term_transition.mjs`): otherwise they calibrate at viscosity / viscosity_ref ≠ 1 and the saved scenario loads with different resistances. A live Hb change (bleeding, transfusion) must not call it, since that is when the resistances should follow the viscosity. |

## Factor system

None. Viscosity reaches the resistances through `BloodVessel`'s viscosity term.

## Inputs and outputs

- **Reads:** `AA`, `AD`, `IVCI`, `SVC`, `RAIVCI`, `RASVC`, `PA` (composition); every blood compartment's Hb, volume and temperature.
- **Writes:**
  - every blood compartment: `temp`, `viscosity`; at build also `haldane_coeff`, `P50_0`, `viscosity_ref`, the seed composition and the thermal fields;
  - the solved composition of the six sampling sites.
- **Written by:** `Thermoregulation` (`set_perfusion_target`); the user (the setters); scenario generators (`set_solute`, `set_P50`).
- **Read by:** `Monitor`, scripts and `DataCollector` watchers (`art_bloodgas`, `preductal_art_bloodgas`).

## Assumptions and limitations

- **Setters reach every blood compartment, the maternal pool included.** `set_solute`, `set_P50`, `set_to2` and `set_tco2` without a site also change `PL_MAT` and the ECLS circuit. See [Placenta](./Placenta.md#assumptions-and-limitations) for why the generators restore `PL_MAT`.
- **Membership is by `model_type` string.** A custom subclass of a blood compartment with its own `model_type` must be added to `blood_containing_modeltypes`, or it is never seeded, warmed or given a viscosity.
- **Fixed sampling sites.** The scenario must have `AA` and `AD`; `IVCI`, `SVC`, `RAIVCI`, `RASVC` and `PA` are used when present (until 2026-10-27 `RASVC` was not, so its gas read-outs kept a stale value). Other compartments' gases are solved only by whoever needs them.
- **Blood gases are refreshed once per second.**
- **Viscosity is low-shear** and depends on haematocrit only: no shear-thinning, no Fåhræus effect in small vessels. Hct is derived from Hb with a fixed MCHC of 33 g/dL.
- **`haldane_coeff` 2.2** is a calibration value of the model's own CO2 formulation (see [BloodComposition](./BloodComposition.md)), not a measured quantity.

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Blood` (trimmed to the config props):

```json
{
  "name": "Blood",
  "model_type": "Blood",
  "is_enabled": true,
  "viscosity_plasma": 1.3,
  "viscosity_hct_k": 3.13,
  "temp": 37,
  "blood_temp_tc": 10,
  "to2": 7,
  "tco2": 25.5,
  "P50_0": 20,
  "haldane_coeff": 2.2,
  "solutes": {
    "na": 138, "k": 3.5, "ca": 1, "cl": 106, "lact": 1.5, "mg": 0.75,
    "albumin": 25, "phosphates": 1.64, "uma": 5.5933, "hemoglobin": 10, "glucose": 4
  }
}
```

## Usage in the scenarios

One instance in every scenario.

| Scenario | `P50_0` (mmHg) | Hb (mmol/L) |
|---|---|---|
| term_neonate_72h | 20 | 10 |

## References

No literature is cited in the code for the viscosity constants; they are calibration choices (k = 3.13 gives ~6 cP at a neonatal haematocrit of 0.49). Per-scenario P50 and Hb come from the scenario validations (see the `*Reference.md` pages).

````

### FILE: explain-engine/docs/BloodCapacitance.md

````markdown
# BloodCapacitance

A BloodCapacitance is an elastic compartment that holds blood and tracks what is in it: oxygen and carbon dioxide content, solutes, drugs and temperature. It is a [`Capacitance`](./Capacitance.md) plus composition mixing. It is the parent class of every blood vessel in the model.

## Physiology

Think of a BloodCapacitance as a balloon filled with blood. The more blood is in it, the higher the pressure inside. How quickly the pressure rises with volume depends on how stiff the wall is, the *elastance*. Below a certain volume, the *unstressed volume*, the wall is slack and the pressure is zero.

When blood flows in from a neighbouring compartment, it mixes completely with the blood already there. If oxygen-rich blood enters a compartment that holds venous blood, the oxygen content inside rises in proportion to how much new blood came in. Solutes, drugs and temperature mix the same way. This is how oxygen, CO2, drugs and warmth travel around the simulated circulation: they ride along with the flow, one compartment at a time.

A BloodCapacitance has no resistance of its own. Blood enters and leaves through separate connectors (`Resistor` models), or the compartment is a [`BloodVessel`](./BloodVessel.md), which adds its own resistance.

In the shipped scenarios a plain BloodCapacitance is used only for compartments outside the main circulation: the urine in the bladder, the maternal blood pool of the placenta, and the inlet tubing of the ECLS circuit (see [Usage](#usage-in-the-scenarios)). Every vessel of the circulation is a `BloodVessel`, which inherits everything on this page.

## Inheritance

```
BaseModelClass
  └── Capacitance              (volume, elastance, pressure)
        └── BloodCapacitance   (blood composition mixing)
              └── BloodVessel  (adds resistance, flow, ANS coupling)
```

`BloodTimeVaryingElastance` and `HeartChamber` carry the same blood properties but descend from `TimeVaryingElastance`. All three classes (and `BloodVessel` through this one) share the mixing code in [`BloodMixing`](./BloodMixing.md).

## Properties

Volume, elastance and pressure props (`vol`, `u_vol`, `el_base`, `el_k`, `pres`, `pres_in`, `pres_ext`, `fixed_composition` and the factor layers) are inherited. See [Capacitance → Properties](./Capacitance.md#properties).

### Config (set in the definition JSON)

| Property | Unit | Default | Description |
|---|---|---|---|
| `temp` | °C | 37.0 | Blood temperature. Mixed on inflow, and relaxed toward `body_temp` by `Blood` every step. |
| `viscosity` | cP | 6.0 | Blood viscosity. Not mixed: `Blood` derives it from this compartment's haemoglobin every step, so a definition value is overwritten. |
| `solutes` | object | `{}` | Solute concentrations keyed by name (e.g. `hemoglobin`, `na`, `glucose`, `lact`), in each solute's own unit. Seeded from `Blood.solutes` at build when empty. |
| `drugs` | object | `{}` | Drug concentrations keyed by drug name. Filled by `Drugs`. |
| `blood_pool` | boolean | `true` | `false` marks a non-circulating sink (URINE). `Blood`, `Lactate`, `Glucose` and `Drugs` then skip the compartment. |

### Outputs

| Property | Unit | Default | Description |
|---|---|---|---|
| `to2` | mmol/L | 0.0 | Total oxygen content (bound + dissolved). Mixed on inflow; seeded from `Blood.to2` at build. |
| `tco2` | mmol/L | 0.0 | Total CO2 content. Mixed on inflow; seeded from `Blood.tco2` at build. |
| `ph` | – | -1 | pH. `-1` = not calculated. |
| `pco2` | mmHg | -1 | CO2 partial pressure. `-1` = not calculated. |
| `po2` | mmHg | -1 | O2 partial pressure. `-1` = not calculated. |
| `so2` | fraction | -1 | O2 saturation (0–1). `-1` = not calculated. |
| `hco3` | mmol/L | -1 | Bicarbonate. `-1` = not calculated. |
| `be` | mmol/L | -1 | Base excess. `-1` = not calculated. |

The blood-gas outputs (`ph` … `be`) are **not** computed by this class. They are solved from `to2`, `tco2` and the solutes by [`BloodComposition.calc_blood_composition`](./BloodComposition.md), and only for the compartments that some model asks for:

- `Blood`, once per second: `AA`, `AD`, `IVCI`, `SVC`, `RAIVCI`, `PA`;
- `Ans`, at its update interval: its chemoreceptor sites;
- `Ecls`: `ECLS_TUBING_IN` and the oxygenator.

Everywhere else these fields stay at `-1`, or hold the last solved value.

### Set by other models

These props are not declared in the constructor. Other models write them onto the blood compartments at build or when solving:

| Property | Unit | Written by | Description |
|---|---|---|---|
| `haldane_coeff` | – | `Blood.init_model` | Haldane-effect strength, used by `BloodComposition`. |
| `P50_0` | mmHg | `Blood.init_model` (only if absent) | O2–Hb affinity baseline. A per-compartment value is kept, e.g. adult 26.7 on `PL_MAT`. |
| `viscosity_ref` | cP | `Blood.init_model` | Viscosity at which the vessel resistances were calibrated. |
| `body_temp` | °C | `Blood.init_model`, then `Thermoregulation` via `Blood.set_perfusion_target` | Perfusion target that `temp` relaxes toward. |
| `blood_temp_tc` | s | `Blood.init_model` | Time constant of that relaxation. |
| `temp_ext_override` | boolean | `Blood.init_model`, devices | `true` when a device (e.g. the ECLS heater) owns `body_temp`. |
| `prev_ph`, `prev_po2` | –, mmHg | `BloodComposition` (on each solve) | Solver warm start: the last solved pH and pO2, which bound the next solve. Only on compartments that have been solved; saved with the state. |

## Calculation

BloodCapacitance does not override `calc_model()`. Each step runs the inherited [Capacitance cycle](./Capacitance.md#calculation): `calc_elastances()` → `calc_volumes()` → `calc_pressure()`.

The class adds one thing, an override of **`volume_in(dvol, comp_from)`**. A `Resistor` (or the compartment's own outflow) calls it when blood arrives:

1. `Capacitance.volume_in` adds `dvol` to `vol` (skipped when `fixed_composition`).
2. `mix_blood_in(this, dvol, comp_from)` mixes the composition. With `V` the volume *after* the inflow:

   ```
   c += (c_from − c) · dvol / V
   ```

   This is exact mass balance: `c_new·V = c_old·(V − dvol) + c_from·dvol`. It is applied to `to2`, `tco2`, every key in `solutes` and `drugs` that the receiving compartment carries (a key missing on the source counts as 0), and `temp`.

The mixing is skipped when:
- `fixed_composition` is `true`, so the compartment acts as an infinite reservoir whose composition never changes;
- `vol ≤ 0`, which guards against NaN on an empty compartment.

Outflow (`volume_out`) changes only the volume; concentrations don't change when blood leaves.

## Factor system

Inherited unchanged from `Capacitance`: `u_vol`, `el_base` and `el_k` each carry the three layers (`_factor`, `_factor_ps`, `_factor_scaling_ps`), composed **additively**. See [ARCHITECTURE §7a](./ARCHITECTURE.md#7a-the-factor--effective-value-pattern). (`BloodVessel` overrides this and composes multiplicatively.)

## Inputs and outputs

- **Reads:** the upstream compartment (`comp_from`) on inflow: its `to2`, `tco2`, `solutes`, `drugs`, `temp`.
- **Written by:**
  - `Resistor`: volume moves;
  - `Blood`: seed composition, temperature relaxation, viscosity, the props in [Set by other models](#set-by-other-models);
  - `BloodComposition`: the blood-gas outputs;
  - `Drugs`, `Lactate`, `Glucose`: their `drugs`/`solutes` entries;
  - owner models of specific instances (`Kidneys` on URINE, `Placenta`/`Uterus` on PL_MAT, `Ecls` on ECLS_TUBING_IN).
- **Read by:** `Resistor` (`pres`), `Monitor` and `DataCollector` watchers, `Blood` (Hb-weighted viscosity reference, thermal state).

## Assumptions and limitations

- **Instant, complete mixing.** Every compartment is well stirred. Streaming inside a compartment isn't modelled. Where it matters (the two halves of the right atrium), it is approximated by splitting the compartment and joining the halves with a `Resistor` with `mix_flow` (see [`Resistor`](./Resistor.md)).
- **No concentration change on outflow.** Concentration changes only on inflow, and through the models that add or remove substances.
- **Composition is carried, not computed.** Blood gases are solved on demand for a handful of sites only, so `po2`/`so2` on an arbitrary compartment can be stale or `-1`.
- **Fixed-composition reservoirs** freeze both volume and composition: `volume_in`/`volume_out` leave `vol` unchanged and nothing is mixed. Blood flowing in or out is created or destroyed at the boundary, which is the intent for an infinite reservoir. `Blood` also skips them for temperature relaxation, viscosity and the thermal balance.

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Kidneys.components.URINE` (trimmed to the config props). The `Kidneys` model builds it through the `components` mechanism:

```json
{
  "name": "URINE",
  "description": "bladder / urine sink",
  "model_type": "BloodCapacitance",
  "is_enabled": true,
  "u_vol": 0,
  "el_base": 1000,
  "el_k": 0,
  "fixed_composition": false,
  "blood_pool": false,
  "vol": 0.0046
}
```

## Usage in the scenarios

All shipped scenarios have the same three instances, each owned by a composite model:

| Instance | Owner | Role |
|---|---|---|
| `URINE` | `Kidneys` | Bladder / urine sink, `blood_pool: false`. `Kidneys._transfer` moves water and each solute into it by its own mass balance, **not** through `volume_in` (which would carry albumin and Hb into the urine). |
| `PL_MAT` | `Placenta` | Maternal blood pool of the placenta: `fixed_composition: true`, adult `P50_0` 26.7. Its gases are written by `Placenta`, or by `Uterus` when coupled. Disabled after birth. |
| `ECLS_TUBING_IN` | `Ecls` | Inlet tubing of the ECLS circuit. `Ecls` sets its volume and solves its blood gas. Disabled unless ECLS runs. |

Through inheritance, the class also carries every `BloodVessel` instance (all of the circulation).

## References

This class introduces no literature-derived values: the mixing rule is exact mass balance. For the pressure–volume relation see [Capacitance](./Capacitance.md). For viscosity, temperature and the blood-gas chemistry see [Blood](./Blood.md) and [BloodComposition](./BloodComposition.md).

````

### FILE: explain-engine/docs/BloodComposition.md

````markdown
# BloodComposition

`BloodComposition` is the blood-gas solver: the function `calc_blood_composition(bc)`. Given a blood compartment's **contents** (total O2, total CO2, strong ions, buffers, haemoglobin, temperature), it computes what a blood-gas analyser reports: **pH, pCO2, HCO3, base excess, pO2 and SO2**. The compartments carry only contents. The partial pressures and pH exist only where someone calls this solver.

It is a module of functions, not a model class: no `model_type`, no instance.

## Physiology

The body transports amounts (mmol of O2 and CO2, mmol of ions), but gases diffuse and receptors sense along partial pressures and pH. Converting one to the other is what this solver does.

- **Acid-base (physicochemical, Stewart / Figge).** A sample's pH is set by three independent things:
  - the **strong ion difference** (Na + K + 2Ca + 2Mg − Cl − lactate);
  - the **total CO2**;
  - the **weak acids**: albumin, phosphate, haemoglobin.

  pH is whatever makes the solution electrically neutral. So a high chloride (saline) or a high lactate lowers the SID and causes a metabolic acidosis; CO2 retention a respiratory one.
- **Oxygen.** O2 is carried bound to haemoglobin (1.36 mL per g, Hüfner) and a little dissolved (0.0031 mL/dL per mmHg). Saturation follows the sigmoid dissociation curve. Its position (P50) shifts right with acidosis (Bohr effect), higher pCO2, higher temperature and more 2,3-DPG, and left in fetal haemoglobin.
- **Haldane effect.** Deoxygenated blood binds more CO2 (carbamino), so at the same total CO2 desaturated blood has a lower pCO2.

## API

```js
import { calc_blood_composition } from "./component_models/BloodComposition.js";
calc_blood_composition(bc);   // solves in place on bc
```

### Read from `bc`

| Field | Unit | Description |
|---|---|---|
| `to2`, `tco2` | mmol/L | Total O2 and CO2 content. |
| `solutes.na`, `k`, `ca`, `mg`, `cl`, `lact` | mmol/L | Strong ions (SID). |
| `solutes.albumin` | g/L | Weak acid. |
| `solutes.phosphates` | mmol/L | Weak acid. |
| `solutes.uma` | mmol/L | Unmeasured anions, a fixed negative charge (the anion-gap calibration). |
| `solutes.hemoglobin` | mmol/L | O2 capacity and non-bicarbonate buffer (1 g/dL = 0.6206 mmol/L). |
| `temp` | °C | Shifts P50 only. |
| `P50_0` | mmHg | Dissociation-curve position at standard conditions (default 20). |
| `haldane_coeff` | – | Haldane strength (default 1; 2.2 in the scenarios). |
| `hb_buffer_fraction` | – | Optional; share of Hb that buffers (default 1/3). No scenario sets it. |
| `so2`, `prev_ph`, `prev_po2` | %, –, mmHg | Last solution: the Haldane input and the warm start of both root searches. |

### Written to `bc`

| Field | Unit | Description |
|---|---|---|
| `ph`, `pco2`, `hco3`, `be` | –, mmHg, mmol/L, mmol/L | Acid-base result; `be` is the **standard** base excess. |
| `po2`, `so2` | mmHg, % | Oxygen result. |
| `prev_ph`, `prev_po2` | | Warm start for the next call (persisted state, saved with the scenario). |
| `_bc_prev_*`, `_bc_cache_initialized` | | Result cache (see below). |

## Calculation

**1. Cache.** If the step time (`model_time_total`) and every input above equal the last call's, it returns at once. In practice it skips only repeated calls within one step (several models solving the same compartment).

**2. Acid-base: charge balance.** Brent's method finds [H⁺] (mmol/L) that zeroes the net charge:
```
cCO2  = tco2 / (1 + Kc/H + Kc·Kd/H² + haldane_coeff·(1 − SO2_prev))     dissolved CO2
HCO3  = Kc·cCO2 / H,   CO3 = Kd·HCO3 / H,   OH = Kw / H,   pCO2 = cCO2 / 0.03067
A_alb+P = albumin·(0.123·pH − 0.631) + phosphates·(0.309·pH − 0.469)        (Figge)
A_Hb    = 2.3 · Hb · hb_buffer_fraction · (pH − 7.4)                       (Van Slyke)
0 = H + SID − HCO3 − 2·CO3 − OH − A_alb+P − A_Hb − uma
```
Constants: pK′ 6.1 (`Kc`), pK 10.22 (`Kd`), pKw 13.6, CO2 solubility 0.03067 mmol/L/mmHg; all at 37 °C. The search is bracketed at the last pH ± 0.1; if that fails, at pH 6.0–8.5.
```
BE = 0.93 · (HCO3 − 24.4 + 14.83·(pH − 7.4))       standard base excess (Siggaard-Andersen)
```

**3. P50.**
```
log10 P50 = log10 P50_0 − 0.48·(pH − 7.4) + 0.0015·(pCO2 − 40) + 0.024·(T − 37) + 0.051·(DPG − 5)
```
DPG is fixed at 5, so its term is always 0.

**4. Oxygen.** Brent's method finds the pO2 for which
```
SO2 = pO2ⁿ / (pO2ⁿ + P50ⁿ),   n = 2.7                         (Hill)
to2 = (0.0031·pO2 + 1.36·Hb[g/dL]·SO2) · 10 / 22.414          (mL/L at STPD → mmol/L)
```
equals the compartment's `to2`. It is bracketed at the last pO2 ± 10 mmHg; if that fails, at 0–1000 mmHg.

**Order and lag.** The acid-base solve runs first with the previous SO2 (Haldane); then the O2 solve uses the new pH and pCO2 (Bohr). The O2↔CO2 coupling therefore lags by one call and converges at steady state.

## Behaviour (bench test, term_neonate_72h composition, Hb 10 mmol/L)

| Change | Result |
|---|---|
| tCO2 24 → 28 mmol/L | pCO2 38 → 69 mmHg, pH 7.38 → 7.17, HCO3 22.1 → 24.5: **~0.8 mmol/L HCO3 per 10 mmHg** (in vivo acute ~1). SBE drifts −2.4 → −3.1. |
| to2 7 mmol/L | SO2 71 %, pO2 32 mmHg at pH 7.30 |
| temp 37 → 33.5 °C | pO2 32 → 27 mmHg at the same SO2; **pH and pCO2 unchanged** |

## Assumptions and limitations

- **No temperature correction of acid-base.** The dissociation constants and CO2 solubility are 37 °C values; temperature moves only P50. So pH and pCO2 are what an analyser reports at 37 °C (alpha-stat values), also during therapeutic hypothermia. pO2 does follow the patient's temperature (via P50).
- **Plasma model with an ECF-equivalent Hb buffer.** The charge balance is a plasma model; Hb buffers at a third of its concentration to stand in for the extracellular fluid the blood equilibrates with. No red-cell compartment, no chloride shift.
- **Fixed Hill curve** (n 2.7): less accurate at very low and very high saturations than the full Kelman / Severinghaus curves. 2,3-DPG is fixed; methaemoglobin and carboxyhaemoglobin are absent.
- **Carbamino CO2** appears only in the Haldane term; it isn't reported separately, and `hco3` excludes it.
- **Failed solves keep the last values.** Outside pH 6.0–8.5, or above the content reachable at 1000 mmHg, the solve fails, logs once per call, and the compartment keeps its previous pH, pCO2, pO2 and SO2. A compartment that has never solved keeps the `-1` sentinel; [GasExchanger](./GasExchanger.md) handles that case.
- **Not re-entrant.** The solver keeps its working values in module-level variables; it must not run for two compartments at once (it never does in the single-threaded worker).
- **Contents are whole blood, chemistry is plasma.** `to2`/`tco2` are per litre of blood, the acid-base constants are plasma ones; the calibration (`uma`, `haldane_coeff`) absorbs the difference.

## Callers

| Caller | Compartments | When |
|---|---|---|
| [Blood](./Blood.md) | `AA`, `AD`, `IVCI`, `SVC`, `RAIVCI`, `PA` | every 1 s |
| [GasExchanger](./GasExchanger.md) | the lung capillaries | its own update interval |
| [BloodDiffusor](./BloodDiffusor.md) | both sides (e.g. placenta) | every step it runs |
| [Ans](./Ans.md) | its `blood_composition_models` (chemoreceptor sites) | its update interval, while `ans_active` |
| [Ecls](./Ecls.md) | tubing and oxygenator | its update interval |
| `ModelEngine` | any named compartment | on request (`GET "blood_composition"`) |

## References

- Figge J, Mydosh T, Fencl V. Serum proteins and acid-base equilibria: a follow-up. *J Lab Clin Med* 1992 (albumin and phosphate charge).
- Stewart PA. Modern quantitative acid-base chemistry. *Can J Physiol Pharmacol* 1983.
- Siggaard-Andersen O. The Van Slyke equation. *Scand J Clin Lab Invest Suppl* 1977 (standard base excess).

````

### FILE: explain-engine/docs/BloodDiffusor.md

````markdown
# BloodDiffusor

`BloodDiffusor` exchanges gases (and optionally solutes) by diffusion between **two blood compartments** that don't share flow: O2 and CO2 move down their partial-pressure gradient, solutes down their concentration gradient. In the scenarios it is `PL_GASEX`, the placental barrier between the fetal villous capillaries and the mother's blood.

For blood ↔ alveolar gas exchange (the lungs, the ECLS oxygenator) see [GasExchanger](./GasExchanger.md); for gas ↔ gas exchange without flow, [GasMixing](./GasMixing.md).

## Physiology

In the placenta, fetal and maternal blood never mix: they are separated by the villous membrane. Gases cross it passively, driven by the difference in partial pressure (Fick's law: flux = diffusing capacity × gradient). Maternal intervillous pO2 is higher than fetal, so O2 moves to the fetus; fetal pCO2 is higher, so CO2 moves to the mother. Fetal haemoglobin's higher affinity lets the fetus load a lot of oxygen at a low pO2. Small solutes (glucose, urea, ions) cross by their concentration gradients.

## Inheritance

```
BaseModelClass
  └── BloodDiffusor
```

## Properties

### Config (set in the definition JSON)

| Property | Unit | Default | Description |
|---|---|---|---|
| `comp_blood1`, `comp_blood2` | – | `"PLF"`, `"PLM"` | Names of the two blood compartments (legacy defaults; every scenario sets `PL_FETAL_CAP` and `PL_MAT`). Positive flux runs 1 → 2. |
| `dif_o2` | mmol/(mmHg·s) | 0.01 | O2 diffusing capacity. |
| `dif_co2` | mmol/(mmHg·s) | 0.01 | CO2 diffusing capacity. |
| `dif_solutes` | L/s per solute | `{}` | Solute diffusing capacities, e.g. `{"glucose": 0.0001}` (mmol/s per mmol/L of gradient). Empty in every scenario. |

In the placenta, `dif_o2` and `dif_co2` are **overwritten every 15 ms by [Placenta](./Placenta.md)** from its own `dif_o2`/`dif_co2`: set them there, or use the factors below.

### Factors

| Property | Default | Layer |
|---|---|---|
| `dif_o2_factor`, `dif_co2_factor`, `dif_solutes_factor` | 1.0 | Non-persistent (reset to 1 after each step). |
| `dif_o2_factor_ps`, `dif_co2_factor_ps`, `dif_solutes_factor_ps` | 1.0 | Persistent. |
| `dif_o2_factor_scaling_ps`, `dif_co2_factor_scaling_ps`, `dif_solutes_factor_scaling_ps` | 1.0 | Scaling layer (`_ps` since v1.0, was `*_factor_scaling`); nothing writes it (`ModelScaler` doesn't scale diffusors). |

### Outputs

| Property | Unit | Description |
|---|---|---|
| `dif_o2_step`, `dif_co2_step` | mmol/(mmHg·s) | Effective O2 and CO2 diffusing capacity with the factors. |

## Calculation

Each step (skipped if either compartment is missing):

1. **Partial pressures.** [`calc_blood_composition`](./BloodComposition.md) on both compartments (a full solve on each, every step).
2. **Factors**, additive:
   ```
   dif_o2_step = dif_o2 · (1 + (factor − 1) + (factor_ps − 1) + (factor_scaling − 1))      likewise CO2 and solutes
   ```
3. **Gases** (Fick), in mmol per step:
   ```
   ΔO2  = (pO2₁ − pO2₂)   · dif_o2_step  · dt      moved from to2 of 1 to to2 of 2
   ΔCO2 = (pCO2₁ − pCO2₂) · dif_co2_step · dt      moved between the tco2s
   ```
   A gas is skipped this step if either side has the `-1` sentinel (failed solve).
4. **Solutes:** `Δ = (c₁ − c₂) · dif_solutes[s] · solutes_factor · dt`, for every solute present on both sides.
5. **Transfer** (`_transfer`). Amounts become concentrations through each compartment's volume. The flux is capped at what the donor holds. A `fixed_composition` compartment (an infinite reservoir such as `PL_MAT`) or an empty one keeps its concentration, while the other side still changes.

## Factor system

Additive layers (as Capacitance and Resistor), on `dif_o2`, `dif_co2` and one shared multiplier for all solutes. See [ARCHITECTURE §7a](./ARCHITECTURE.md#7a-the-factor--effective-value-pattern).

## Inputs and outputs

- **Reads:** both compartments' `po2`, `pco2`, `to2`, `tco2`, `solutes`, `vol`, `fixed_composition`.
- **Writes:** `to2`, `tco2`, `solutes` of the non-fixed compartment(s); their solved `ph`, `pco2`, `po2`, `so2`, … through `calc_blood_composition`.
- **Written by:** [Placenta](./Placenta.md) (`dif_o2`, `dif_co2`, `is_enabled` every 15 ms); the fetal generators set the Placenta values.
- **Read by:** `DataCollector` watchers.

## Assumptions and limitations

- **Fick diffusion on partial pressures, no geometry.** A diffusing capacity lumps membrane area, thickness and permeability. No counter-current or concurrent flow pattern; each compartment is well mixed.
- **Full equilibration at the shipped settings.** Fetal capillary blood leaves the exchanger at the maternal pCO2, so the diffusing capacities have little authority over fetal gases; the maternal contents set them (see [Placenta](./Placenta.md#assumptions-and-limitations)).
- **Explicit, one step.** A very large capacity with a small compartment could overshoot the equilibrium in one step; the cap only stops a negative concentration.
- **Two blood solves every step** while it runs (a fetus with the placenta running), including on the fixed `PL_MAT`.

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Placenta.components.PL_GASEX` (trimmed to the config props):

```json
{
  "name": "PL_GASEX",
  "model_type": "BloodDiffusor",
  "is_enabled": false,
  "comp_blood1": "PL_FETAL_CAP",
  "comp_blood2": "PL_MAT",
  "dif_o2": 0.01,
  "dif_co2": 0.01,
  "dif_solutes": {}
}
```

## Usage in the scenarios

One instance, `PL_GASEX`, owned by `Placenta`, disabled in term_neonate_72h (it runs only in a fetus with the placenta running; the fetal scenarios were removed on 2026-10-25 to be rebuilt).

| Scenario | `dif_o2` | `dif_co2` |
|---|---|---|
| term_neonate_72h (disabled) | 0.01 | 0.01 |

## References

No literature values; the diffusing capacities are calibrated per fetal scenario (see [fetal_circulation](./fetal_circulation.md)).

````

### FILE: explain-engine/docs/BloodMixing.md

````markdown
# BloodMixing

`helpers/BloodMixing.js` holds the two functions that move blood composition between compartments: `mix_blood_in` (mixing on inflow, the advection of everything blood carries) and `exchange_blood` (exchange without net flow between two compartments of one continuous pool). Every blood compartment and `Resistor.mix_flow` use them, so the mixing rule exists in one place.

## API

| Function | Arguments | Returns | Description |
|---|---|---|---|
| `mix_blood_in(target, dvol, comp_from)` | receiving compartment, volume that just arrived (L), source compartment | – | Mixes the source composition into `target`. Call it **after** the volume has been added to `target.vol`. |
| `exchange_blood(a, b, dv)` | two compartments, volume swapped each way (L) | – | Swaps `dv` of blood both ways, with no net volume change. |

### `mix_blood_in`

With `V` the target volume after the inflow and `f = dvol / V`:

```
c += (c_from − c) · f
```

This is exact mass balance: `c_new·V = c_old·(V − dvol) + c_from·dvol`. It is applied to:
- `to2` and `tco2`;
- every key of `target.solutes` and `target.drugs` (a key missing, zero or NaN on the source counts as 0);
- `temp` (blood treated as one fluid, so temperature mixes like a concentration).

It does nothing when:
- `target.fixed_composition` is set (an infinite reservoir keeps its composition);
- `target.vol ≤ 0` (avoids NaN on an empty compartment).

**Viscosity is not mixed**: `Blood` derives each compartment's viscosity from its own haemoglobin every step.

### `exchange_blood`

```
dv  = min(dv, ½ · min(V_a, V_b))                 (stability clamp)
c_a += (c_b − c_a) · dv / V_a
c_b −= (c_b − c_a) · dv / V_b                    (using the pre-exchange concentrations)
```

Applied to `to2`, `tco2`, `temp`, every solute and every drug. A key present on only one side is created on the other (counted as 0 there). `c_a·V_a + c_b·V_b` is conserved, so nothing is created or lost. A `fixed_composition` side keeps its composition (its fraction is 0), and then the other side simply relaxes toward it. It does nothing when `dv ≤ 0` or either volume is 0.

## Where it is used

| Caller | Function | When |
|---|---|---|
| [`BloodCapacitance`](./BloodCapacitance.md) (and so `BloodVessel`), [`BloodTimeVaryingElastance`](./BloodTimeVaryingElastance.md), [`HeartChamber`](./HeartChamber.md) | `mix_blood_in` | in `volume_in`, every time a resistor moves blood into the compartment |
| [`Resistor`](./Resistor.md#mixing-without-net-flow-mix_flow) with `mix_flow > 0` | `exchange_blood` | every step, with `dv = mix_flow · dt`, when both ends carry blood and the connection is open |

In the shipped scenarios the only blood `mix_flow` is `RAIVCI_RASVC` (0.01 L/s), between the two halves of the right atrium.

## Notes

- **Keys must exist on the receiving side.** `mix_blood_in` only mixes the solutes and drugs the target already has; a key that only the source carries is not transported. The seeding models keep the key sets identical across the circulation:
  - `Blood` seeds the solutes at build (including `lact`);
  - `Drugs` adds its drug keys and `Glucose` its `glucose` key to every circulating compartment.

  In term_neonate_72h all 47 circulating blood compartments carry the same 11 solutes and 3 drugs. A new solute or drug must be seeded the same way.
- **Hot path.** `mix_blood_in` runs about 45 times per step, so it uses plain `for…in` loops and allocates nothing.
- **Well-mixed compartments.** Both functions assume each compartment is instantly and completely mixed. Streaming inside a compartment is represented by splitting it and choosing `mix_flow`.
- The gas counterpart for `mix_flow` is [`helpers/GasMixing.js`](../helpers/GasMixing.js) `exchange_gas`. Gas mixing on inflow lives in `GasCapacitance.volume_in`.

````

### FILE: explain-engine/docs/BloodTimeVaryingElastance.md

````markdown
# BloodTimeVaryingElastance

A `BloodTimeVaryingElastance` is a [`TimeVaryingElastance`](./TimeVaryingElastance.md) that holds blood: a compartment whose stiffness follows the heartbeat and whose blood composition is tracked and mixed like a [`BloodCapacitance`](./BloodCapacitance.md). In the shipped scenarios it is the coronary bed.

## Physiology

The coronary vessels run through the heart muscle. When the ventricles contract, the muscle squeezes the vessels inside it (*intramyocardial compression*). Coronary inflow to the left ventricle is therefore impeded in systole and occurs mostly in diastole, and blood is pushed out of the coronary veins during systole. A tachycardia that shortens diastole, or a high diastolic ventricular pressure, reduces the time and the pressure available for coronary filling.

Explain models this with one compartment whose stiffness rises with ventricular activation. Contraction raises the pressure in the coronary bed, which slows inflow from the aorta and speeds outflow to the right atrium. The same compartment is where the heart muscle takes up its oxygen: `Mob` removes the myocardial O2 consumption from the coronary blood and adds the CO2 it produces, so coronary venous blood is the most desaturated blood in the body.

## Inheritance

```
BaseModelClass
  └── TimeVaryingElastance          (el_min/el_max, act_factor, pressure)
        └── BloodTimeVaryingElastance   (blood composition mixing)
```

All of the calculation (elastances, unstressed volume, pressure) is inherited unchanged from `TimeVaryingElastance`, with the additive factor layers. Unlike its sibling [`HeartChamber`](./HeartChamber.md), it has no ANS, drug or load terms.

## Properties

Volume, elastance, activation and factor props are inherited: see [TimeVaryingElastance → Properties](./TimeVaryingElastance.md#properties).

### Config (set in the definition JSON)

| Property | Unit | Default | Description |
|---|---|---|---|
| `temp` | °C | 37.0 | Blood temperature; mixed on inflow, relaxed toward `body_temp` by `Blood`. |
| `viscosity` | cP | 6.0 | Overwritten by `Blood` from the compartment's haemoglobin every step; not mixed. |
| `solutes` | object | `{}` | Solute concentrations, seeded from `Blood` when empty. |
| `drugs` | object | `{}` | Drug concentrations (`Drugs`). |

### Outputs

| Property | Unit | Default | Description |
|---|---|---|---|
| `to2`, `tco2` | mmol/L | 0.0 | Total O2 and CO2 content; mixed on inflow. |
| `ph`, `pco2`, `po2`, `so2`, `hco3`, `be` | as in [BloodCapacitance](./BloodCapacitance.md#outputs) | -1 | Blood gases, `-1` = not calculated. No model solves them for `COR`, so they stay `-1`. |

### Set by other models

The same props `Blood` and `BloodComposition` write onto every blood compartment (`haldane_coeff`, `P50_0`, `viscosity_ref`, `body_temp`, `blood_temp_tc`, `temp_ext_override`, `prev_ph`, `prev_po2`): see [BloodCapacitance → Set by other models](./BloodCapacitance.md#set-by-other-models).

The class has no `blood_pool` or `fixed_composition` prop. Both read as "not set", so the compartment counts as circulating blood and its composition is never frozen.

## Calculation

`calc_model()` is inherited: `calc_elastances()` → `calc_volumes()` → `calc_pressure()`, with

```
pres_in = p_ed + (p_es − p_ed) · act_factor
```

(see [TimeVaryingElastance → Calculation](./TimeVaryingElastance.md#calculation)).

The class adds one override, **`volume_in(dvol, comp_from)`**. It adds the volume, then mixes the incoming blood with `mix_blood_in` ([`helpers/BloodMixing.js`](../helpers/BloodMixing.js)), exactly as in [BloodCapacitance](./BloodCapacitance.md#calculation): `to2`, `tco2`, every solute and drug, and `temp`, by the inflow's share of the new volume.

## Factor system

Inherited unchanged: `u_vol`, `el_min`, `el_max` and `el_k` carry the three layers, composed **additively** (see [TimeVaryingElastance → Factor system](./TimeVaryingElastance.md#factor-system)). No model writes them for `COR` in the shipped scenarios.

## Inputs and outputs

- **Reads:** the upstream compartment on inflow (composition).
- **Written by:** `Heart` (`act_factor` = the ventricular activation `vaf`, every step); `Mob` (subtracts the myocardial O2 consumption from `to2` and adds CO2 to `tco2` by the respiratory quotient, every step); `Blood` (temperature, viscosity, seed composition); `Drugs`, `Lactate`, `Glucose` (their solutes and drugs); `PERICARDIUM` (`pres_ext`); the connected resistors (volume).
- **Read by:** `AA_COR` (whose resistance `Heart` raises in systole), `COR_RAIVCI` and `COR_RASVC` (its pressure); `Mob` (its `to2`, `tco2` and volume, plus the `AA_COR` flow and aortic `to2` for O2 delivery); `DataCollector` watchers.

## Assumptions and limitations

- **One compartment for the whole coronary circulation.** Left and right coronary beds, and epicardial versus intramyocardial vessels, aren't separated.
- **Compression follows the LV activation for the whole bed.** The right-ventricular activation (`rvaf`) doesn't act on it.
- **Two compression effects.** The bed's own elastance swing (`el_max/el_min` = 3) squeezes blood *out* in systole. Holding inflow back is done by `Heart.cor_r_systolic_factor`, which raises the inflow resistance `AA_COR` by `(1 + 5·vaf)` in systole. With both, 73 % of the coronary inflow arrives in diastole at term (60–62 % in the preterm and fetal scenarios, which have shorter diastoles). This compares with ~75–85 % for an adult left coronary, which a lumped left+right bed should sit below. An intramyocardial-*pressure* variant was tried and dropped: with this bed's compliance it squeezed the bed empty in systole.
- **Active only since the two-phase build** (`302ed76`). Before that, `Heart` never found `COR` (owned by `Mob`), and `act_factor` stayed 0.

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Mob.components.COR` (trimmed to the config props):

```json
{
  "name": "COR",
  "model_type": "BloodTimeVaryingElastance",
  "is_enabled": true,
  "u_vol": 0.00028,
  "el_min": 30000,
  "el_max": 90000,
  "el_k": 0,
  "vol": 0.00067
}
```

## Usage in the scenarios

One instance in term_neonate_72h: `COR`, owned by `Mob`, inside the `PERICARDIUM`. It is fed from the ascending aorta by `AA_COR` (implicit flow) and drains into both halves of the right atrium through `COR_RAIVCI` and `COR_RASVC`.

## References

This class introduces no literature-derived values. For the time-varying elastance concept see [TimeVaryingElastance](./TimeVaryingElastance.md#references). The coronary elastances are scenario calibrations.

````

### FILE: explain-engine/docs/BloodVessel.md

````markdown
# BloodVessel

A `BloodVessel` is a segment of the circulation: an elastic blood compartment ([`BloodCapacitance`](./BloodCapacitance.md)) with its own inflow resistance and autonomic (ANS) control. When the ANS constricts a vessel, its resistance **and** its stiffness change together. That coupling is a defining feature of Explain. Almost the whole circulation is built from BloodVessels.

## Physiology

Each vessel segment does two things at once:

- **It holds blood** at a pressure set by its wall stiffness, like any elastic compartment.
- **It resists flow** into it. Most of the circulation's resistance sits in the small arteries and arterioles, so those segments set systemic and pulmonary vascular resistance.

The autonomic nervous system adjusts vessel tone through three effects:

- **Resistance.** Sympathetic activity constricts arterioles and raises resistance (and blood pressure); withdrawal dilates them.
- **Stiffness follows resistance.** A constricted vessel has a narrower, thicker-walled lumen, so it is also stiffer. Explain couples the two with one exponent per vessel type (*α*), so vasoconstriction raises resistance and elastance together.
- **Venous reservoir.** Sympathetic venoconstriction mainly shrinks the *unstressed volume* of the large capacitance veins, not their stiffness. That shifts blood from the venous reservoir into the circulating (stressed) volume and raises venous return. It is the body's quick "autotransfusion".

Blood viscosity also sets resistance (Poiseuille). Polycythaemia raises resistance in every vessel, and haemodilution lowers it.

## Inheritance

```
BaseModelClass
  └── Capacitance
        └── BloodCapacitance      (blood composition mixing)
              └── BloodVessel     (inflow resistors, ANS, α-coupling, viscosity)
```

`BloodVessel` overrides `calc_resistances` and `calc_elastances`, and composes its factor layers **multiplicatively** (unlike the additive base classes). It extends `calc_volumes` with the ANS unstressed-volume effect. Pressure and composition mixing are inherited.

## Properties

Inherited props: [Capacitance](./Capacitance.md#properties) (`vol`, `u_vol`, `el_base`, `el_k`, their factor layers, `pres`, …) and [BloodCapacitance](./BloodCapacitance.md#properties) (`temp`, `viscosity`, `solutes`, `drugs`, blood gases, `blood_pool`, and the props `Blood` writes, including `viscosity_ref`).

### Config (set in the definition JSON)

| Property | Unit | Default | Description |
|---|---|---|---|
| `inputs` | – | `[]` | Upstream compartments. One inflow `Resistor` is created per input, named `<input>_<vessel>`. |
| `r_for` | mmHg·s/L | 1.0 | Forward resistance of each inflow connector. |
| `r_back` | mmHg·s/L | 1.0 | Backward resistance. |
| `r_k` | mmHg·s²/L² | 0.0 | Turbulent coefficient (0 in every shipped vessel). |
| `no_flow` | boolean | `false` | Closes all inflow connectors. |
| `no_back_flow` | boolean | `false` | Makes the inflow connectors one-way. |
| `alpha` | – | 0.0 | Resistance→elastance coupling exponent: `el ∝ (R multiplier)^α`. 0 = no coupling. |
| `ans_sens` | – | 0.0 | Sensitivity of the resistance to `ans_activity`, 0 (none) to 1 (full). |
| `u_vol_ans_sens` | – | 0.0 | Sensitivity of the unstressed volume to `ans_activity` (venoconstriction). |
| `r_factor`, `r_k_factor` | – | 1.0 | Non-persistent factors, reset to 1 every step. |
| `r_factor_ps`, `r_k_factor_ps` | – | 1.0 | Persistent factors. |
| `r_factor_scaling_ps`, `r_k_factor_scaling_ps` | – | 1.0 | Persistent scaling factors. |

### Outputs

| Property | Unit | Default | Description |
|---|---|---|---|
| `flow` | L/s | 0.0 | Net **inflow** through the input connectors (forward − backward). Not the outflow. |
| `flow_forward` | L/s | 0.0 | Sum of the forward flows of the enabled input connectors. |
| `flow_backward` | L/s | 0.0 | Sum of the backward flows (positive number). |
| `r_for_eff`, `r_back_eff` | mmHg·s/L | 1000 | Effective resistances, written into the input connectors. |
| `r_k_eff` | mmHg·s²/L² | 0 | Effective turbulent coefficient. |

### Set by other models

| Property | Unit | Default | Description |
|---|---|---|---|
| `ans_activity` | – | 1.0 | Autonomic tone, > 1 constriction, < 1 dilation. `Circulation` writes its own `ans_activity` (from the `EF_SVR` efferent) into **every** circulation vessel. Placenta and ECLS vessels keep 1. |
| `viscosity_ref` | cP | 0.0 | Viscosity at which `r_for`/`r_back` are calibrated, written by `Blood` at build; 0 switches the viscosity effect off. |
| `p1_ext`, `p2_ext` | mmHg | 0.0 | Extra pressure on the inlet/outlet of the input connectors. Copied to them every step and **not** reset on the vessel, so a value written here acts until the writer sets it back to 0 (e.g. `Ecls` on `ECLS_PUMP`/`ECLS_OXY`). |

## Calculation

Each step `step_model()` first copies the vessel's `is_enabled` onto its input connectors, so a disabled vessel's connectors stop conducting. Then, when enabled and initialized, `calc_model()` runs:

1. **`calc_resistances()`**
   ```
   ans_mult       = 1 + (ans_activity − 1) · ans_sens
   r_total_factor = r_factor · r_factor_ps · r_factor_scaling_ps · ans_mult
   visc_mult      = viscosity / viscosity_ref          (1 if viscosity_ref = 0)
   r_for_eff  = r_for  · r_total_factor · visc_mult
   r_back_eff = r_back · r_total_factor · visc_mult
   r_k_eff    = r_k · r_k_factor · r_k_factor_ps · r_k_factor_scaling_ps · ans_mult
   ```
   `r_total_factor` is cached for the elastance step; viscosity is deliberately left out of it (thicker blood isn't vasoconstriction, so it doesn't stiffen the wall). The non-persistent factors are reset.
2. **`calc_elastances()`**
   ```
   el_eff   = el_base · el_base_factor · el_base_factor_ps · el_base_factor_scaling_ps · r_total_factor^α
   el_k_eff = el_k · el_k_factor · el_k_factor_ps · el_k_factor_scaling_ps        (not α-coupled)
   ```
   The power is recomputed only when `r_total_factor` or `α` change.
3. **Update the input connectors**: `r_for`/`r_back`/`r_k` ← the effective values; `no_flow`, `no_back_flow`, `p1_ext`, `p2_ext`, `is_enabled` ← the vessel's.
4. **`calc_volumes()`**: the inherited additive `u_vol` layers (floored at 0), then the ANS venoconstriction:
   ```
   u_vol_eff = u_vol_eff · max(0, 1 − (ans_activity − 1) · u_vol_ans_sens)
   ```
5. **`calc_pressure()`** (inherited from [Capacitance](./Capacitance.md#calculation)): with `S = vol − u_vol_eff`, `pres = (S > 0 ? el_k_eff·S² : 0) + el_eff·S + pres_ext`.
6. **`get_flows()`**: sums the flows of the enabled input connectors into `flow_forward`, `flow_backward` and `flow`.

**Inflow connectors.** `init_model` creates one `Resistor` per name in `inputs`, unless a model with that name already exists (a saved state lists them as top-level entries, so they are reused). The flow itself, the volume transfer and the composition mixing all happen in those connectors; see [Resistor](./Resistor.md#inheritance) for which props the vessel overwrites and which stay the connector's own.

**Step lag.** In a loaded scenario the connectors are top-level entries and step **before** their vessel (the vessels are sub-models of `Circulation`, `Placenta` or `Ecls`). So a connector uses the resistance the vessel wrote one step earlier (0.5 ms).

### Where α comes from

For a thin-walled tube, Poiseuille gives `R ∝ r⁻⁴`, and the volume elastance of the tube scales as `E ∝ r⁻³`. A pure change of radius therefore moves them as `E ∝ R^(3/4)`, so α = 0.75. That is the value used for veins and venules. The scenarios use 0.63 for arterioles and 0.5 for large arteries and central veins, where the thicker or more structural wall stiffens less than the pure-geometry estimate. The lumped "rest of upper/lower body" beds (`RUB`, `RLB`) use 1.

## Factor system

The resistance and elastance layers compose **multiplicatively**:

```
value_eff = base · factor · factor_ps · factor_scaling_ps        (r_for, r_back, r_k, el_base, el_k)
```

So `r_factor = 2` with `r_factor_ps = 2` gives a true ×4, not the ×3 of the additive rule. `u_vol` keeps the inherited **additive** layers (then the ANS multiplier). See [ARCHITECTURE §7a](./ARCHITECTURE.md#7a-the-factor--effective-value-pattern).

**α applies to every resistance layer, not only the ANS.** `r_total_factor` includes `r_factor_ps` and `r_factor_scaling_ps`, so these also stiffen the vessel by `factor^α`:
- the user's or a drug's SVR change (`Circulation.set_svr_factor_*` on the systemic arterioles);
- renal autoregulation (`Kidneys` on `KID_ART`);
- the Calibrator;
- ModelScaler resistance scaling.

Writers in the current code:

| Layer | Writers |
|---|---|
| `r_factor_ps` | `Circulation` (`set_svr_factor_art`/`_drug`/`_ven`, `set_pvr_factor_art`/`_ven`: deltas added to the shared accumulator), `Kidneys` (`KID_ART`, afferent autoregulation), the `Calibrator`, the user |
| `r_factor_scaling_ps`, `el_base_factor_scaling_ps`, `u_vol_factor_scaling_ps` | `ModelScaler`; `Uterus`, `MaternalPlacenta` (their own vessels) |
| `u_vol_factor_ps`, `el_base_factor_ps` | the user and scenarios |

Models that need to change **one** inflow without touching the vessel write the input connector's own factors instead, which multiply on top of the vessel's value:
- `Hormones`: `KID_CAP_KID_VEN.r_factor_ps`, the efferent arteriole;
- `Brain`: `AA_BR_ART.r_factor_ps` (cerebral autoregulation) and `BR_VEN_VUB.r_factor_ps` (ICP on the outflow).

The vessel's `r_for_eff` doesn't show these.

## Inputs and outputs

- **Reads:** its own props; `viscosity` and `viscosity_ref` (written by `Blood`); `ans_activity` (written by `Circulation`); the flows of its input connectors.
- **Writes:** the resistance and gates of its input connectors, every step.
- **Written by:** `Circulation` (`ans_activity`, SVR/PVR factors), `Blood` (viscosity, temperature, seed composition), `Kidneys`, the `Calibrator`, `ModelScaler`, `Uterus`/`MaternalPlacenta`, `Ecls` (`p1_ext`/`p2_ext`, volumes), `Placenta` (`no_flow` at cord clamping), `THORAX` (`pres_ext` on the intrathoracic vessels), the connected resistors (volume).
- **Read by:** `Monitor` (pressures, flows), `Brain` and `Kidneys` (their bed's pressures and flows), `Blood` (blood-gas sites `AA`, `AD`, `IVCI`, `SVC`, `PA`), `DataCollector` watchers.

## Assumptions and limitations

- **Inflow resistance only.** A vessel's resistance sits on its inflow connectors; its outflow is the next vessel's inflow. A bed with several outlets has no resistance of its own on each outlet.
- **One ANS signal for the whole circulation.** Every circulation vessel gets the same `ans_activity`. Regional differences come only from `ans_sens` (e.g. 1 on the systemic and pulmonary arterioles, 0.5 on the aorta and central veins, 0.05 on the pulmonary trunk and veins, 0 on capillaries). There is no separate cerebral, renal or splanchnic sympathetic output.
- **α-coupling is geometric and instantaneous.** Any resistance change stiffens the vessel by `factor^α`. That fits vasoconstriction, but it also applies to scaling and calibration changes of resistance.
- **`ans_mult` must stay positive.** `r_total_factor^α` is `NaN` for a negative base. Today's efferent ranges keep `ans_activity` in 0.5–2, but `AnsEfferent` doesn't clamp its firing rate (to be checked with the control loops).
- **No vessel collapse, inertance or wave propagation** (see [Capacitance](./Capacitance.md#assumptions-and-limitations) and [Resistor](./Resistor.md#assumptions-and-limitations)).

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Circulation.components.KID_ART` (trimmed to the config props):

```json
{
  "name": "KID_ART",
  "model_type": "BloodVessel",
  "is_enabled": true,
  "inputs": ["AD"],
  "vol": 0.00056,
  "u_vol": 0.00011,
  "el_base": 94524.9,
  "el_k": 0,
  "r_for": 10777.7,
  "r_back": 10539.3,
  "r_k": 0,
  "alpha": 0.63,
  "ans_sens": 1,
  "u_vol_ans_sens": 0
}
```

## Usage in the scenarios

term_neonate_72h has 39 vessels:

| Bed | Vessels | α | `ans_sens` | `u_vol_ans_sens` |
|---|---|---|---|---|
| Pulmonary trunk, branches, veins | `PA`, `PAAL`, `PAAR`, `PV` | 0.5 | 0.05 | 0 |
| Lung arterioles / capillaries / venules | `LL_ART`, `RL_ART` / `LL_CAP`, `RL_CAP` / `LL_VEN`, `RL_VEN` | 0.63 / 0 / 0.75 | 1 / 0 / 0.75 | 0 |
| Aorta | `AA`, `AAR`, `AD` | 0.5 | 0.5 | 0 |
| Systemic beds: liver/spleen, kidney, intestine, brain (arteriole / capillary / venule) | `LS_*`, `KID_*`, `INT_*`, `BR_*` | 0.63 / 0 / 0.75 | 1 / 0 / 0.75 | 0.2 on `LS_VEN`, `KID_VEN`, `INT_VEN` |
| Rest of lower / upper body | `RLB`, `RUB` | 1 | 1 | 0 |
| Capacitance veins | `VLB`, `VUB`, `IVCI`, `SVC` | 0.5 | 0.5 | 0.2 |
| Placenta (fetal side) | `PL_UMB_ART`, `PL_FETAL_ART`/`_CAP`/`_VEN`, `PL_UMB_VEN` | 1, 0.63, 0, 0.75, 1 | 0, 1, 0, 0.75, 0 | 0 |
| ECLS circuit | `ECLS_PUMP`, `ECLS_OXY`, `ECLS_TUBING_OUT` | 0 | 0 | 0 |

The circulation vessels are owned by `Circulation`, the placental ones by `Placenta` (disabled after birth), and the ECLS ones by `Ecls` (disabled unless ECLS runs).

## References

- Shoukas AA, Sagawa K. Control of total systemic vascular capacity by the carotid sinus baroreceptor reflex. *Circ Res* 1973;33(1):22–33. [doi:10.1161/01.res.33.1.22](https://doi.org/10.1161/01.res.33.1.22) (sympathetic control acts mainly on unstressed volume, with little change in compliance).

The resistance, elastance and α values are scenario calibrations (see the `*Reference.md` pages). The α = 0.75 value follows from tube geometry (above).

````

### FILE: explain-engine/docs/Brain.md

````markdown
# Brain

`Brain` models neonatal cerebral haemodynamics: **autoregulation** of cerebral blood flow (CBF) and **intracranial pressure** (ICP), linked through the cerebral perfusion pressure CPP = MAP − ICP. Like [Kidneys](./Kidneys.md)' renal autoregulation, it is a controller: it holds no blood, acts on the cerebral bed's resistors, and is neutral at the scenario's baseline. It diverges only when blood pressure changes, autoregulation is impaired, or intracranial volume rises.

## Physiology

The brain keeps its blood flow nearly constant over a range of perfusion pressures by constricting or dilating its arterioles (myogenic autoregulation). In the sick or very preterm newborn that range is narrow and easily lost. The circulation then becomes **pressure-passive**: CBF follows blood pressure, so a surge can cause intraventricular haemorrhage and a fall can cause ischaemia.

The skull holds brain, blood and CSF (Monro–Kellie). Added volume (oedema, haemorrhage, a mass) raises ICP along an exponential pressure–volume curve. It is gentler in the newborn, whose fontanelle and sutures are open. Rising ICP squeezes cerebral blood out and lowers CPP: the cerebral veins cannot drain below ICP, so the driving pressure is MAP − ICP; autoregulation dilates to compensate until its reserve is gone, then CBF falls.

## Inheritance

```
BaseModelClass
  └── Brain
```

## Properties

### Config: gating and wiring

| Property | Default | Description |
|---|---|---|
| `brain_running` | `true` | Master switch. Off releases the owned channels to 1 once, then idles. |
| `autoregulation_enabled` | `true` | Autoregulation on/off (off relaxes the factor to 1: pressure-passive). |
| `icp_enabled` | `true` | ICP coupling on/off. |
| `map_model` | `"AA"` | Arterial pressure source. |
| `arteriole_resistor`, `cbf_resistor` | `"AA_BR_ART"` | Autoregulation effector, and the resistor whose flow is CBF. |
| `cerebral_compartments` | `["BR_ART", "BR_CAP", "BR_VEN"]` | Summed for the cerebral blood volume. |
| `outflow_resistor` | `"BR_VEN_VUB"` | Cerebral venous outflow; the ICP excess is added to its outlet pressure (vascular waterfall). |
| `oxy_model` | `"BR_CAP"` | Brain oxygenation read-out. |

### Config: autoregulation

| Property | Unit | Default | Description |
|---|---|---|---|
| `autoregulation_gain` | 0–1 | 1.0 | 1 = intact, 0 = pressure-passive (blend). |
| `autoreg_control_gain` | 1/s | 5.0 | Integral gain on the fractional CBF error. |
| `autoreg_leak` | 1/s | 0.05 | Pull of the integrator back to 1, so the baseline stays neutral (gain/leak ≈ 100: strong regulation, small droop). |
| `cbf_setpoint` | L/min | 0 | Target CBF; ≤ 0 = captured 30 s after build. Stored in every scenario (term 0.106). |
| `cpp_setpoint` | mmHg | 0 | Baseline CPP (read-out); captured likewise. |
| `autoreg_tc` | s | 1.0 | Lag on the applied factor. |
| `autoreg_factor_min`, `autoreg_factor_max` | – | 0.15, 6.0 | Maximal dilation and constriction (the autoregulation limits). |
| `cbf_tc`, `pres_tc` | s | 1.0, 3.0 | Smoothing of CBF and MAP (averages out the pulse). |

### Config: ICP

| Property | Unit | Default | Description |
|---|---|---|---|
| `cbv0` | mL | 0 | Baseline cerebral blood volume; ≤ 0 = captured 30 s after build. Stored in every scenario. |
| `icp_baseline` | mmHg | 5 | Normal ICP (read-out anchor). |
| `edema_volume` | mL | 0 | Added intracranial volume: oedema, haemorrhage, mass (`set_edema`). |
| `icp_e0`, `icp_k` | mmHg, 1/mL | 4.0, 0.18 | Exponential pressure–volume curve (compliant neonatal cranium). |
| `icp_excess_max` | mmHg | 70 | Clamp on the excess ICP. |

### Outputs

| Property | Unit | Description |
|---|---|---|
| `cbf` | L/min | Smoothed cerebral blood flow. |
| `sensed_map` | mmHg | Smoothed arterial pressure. |
| `cpp` | mmHg | MAP − ICP. |
| `icp`, `icp_excess` | mmHg | ICP and its excess above baseline. |
| `cerebral_blood_volume` | mL | CBV. |
| `autoreg_factor` | – | Applied factor on `AA_BR_ART.r_factor_ps` (saved; the integrator resumes from it on load, the smoothers from `cbf` and `sensed_map`). |
| `brain_to2` | mmol/L | `BR_CAP` O2 content (ischaemia read-out). |

## Calculation

Every 15 ms:

1. **Smooth** MAP and CBF (`AA_BR_ART.flow`); sum CBV.
2. **ICP:**
   ```
   dV = (CBV − cbv0) + edema_volume
   icp_excess = clamp(icp_e0 · (exp(icp_k · dV) − 1), 0, icp_excess_max)
   ```
   CPP = MAP − ICP.
5. **ICP as a pressure** (every step, since both are reset after use):
   - `BR_VEN_VUB.p2_ext += icp_excess`: the outflow pressure rises with ICP (vascular waterfall: the bridging veins cannot drain below ICP), so the driving pressure falls with CPP and perfusion stops as ICP reaches MAP;
   - `pres_ext += icp_excess` on `BR_ART`, `BR_CAP`, `BR_VEN`: their volume follows the transmural pressure, so raised ICP squeezes cerebral blood out (the Monro–Kellie buffer).

   Only the excess above `icp_baseline` is applied, so the calibrated resting bed is unchanged (`cbv0` is the resting cerebral blood volume).
3. **Baseline:** if not stored, CBF, CPP and CBV are captured 30 s after build.
4. **Autoregulation** (leaky integral control on flow):
   ```
   err = (CBF − cbf_setpoint) / cbf_setpoint
   int += (autoreg_control_gain · err − autoreg_leak · (int − 1)) · Δt         clamped to the limits
   applied = 1 + autoregulation_gain · (int − 1)
   autoreg_factor → applied   (lag autoreg_tc),   AA_BR_ART.r_factor_ps = autoreg_factor
   ```
   Within the limits CBF stays near its set-point; at a limit the bed becomes pressure-passive.

## Factor system

It owns `AA_BR_ART.r_factor_ps` (inflow), and writes the non-persistent `BR_VEN_VUB.p2_ext` and the cerebral compartments' `pres_ext` (added to, so other writers compose). The inflow channel is not in Circulation's groups; the brain's ANS and SVR tone acts on the `BR_ART` vessel, so the channels compose.

## Inputs and outputs

- **Reads:** `AA.pres`, `AA_BR_ART.flow`, the cerebral volumes, `BR_CAP.to2`.
- **Writes:** the channels above.
- **Written by:** the user (`set_edema`, `autoregulation_gain`, switches).
- **Read by:** `DataCollector` watchers and the Monitor (read-outs).

## Assumptions and limitations

- **Behaviour in term_neonate_72h** (re-validation (f), 2 min after each oedema step; CBF in mL/min):

  | Oedema (mL) | ICP | CPP | CBF intact (factor) | CBF pressure-passive | `brain_to2` intact / passive |
  |---|---|---|---|---|---|
  | 0 | 5.0 | 55.7 | 105 (1.00) | 105 | 6.6 / 6.6 |
  | 5 | 10.5 | 50 | 105 (0.80) | 96 | 6.6 / 6.3 |
  | 10 | 24 | 37–39 | 104 (0.31) | 74 | 6.6 / 5.4 |
  | 12 | 32–35 | 27–30 | 91 (0.15, dilation limit) | 59 | 6.2 / 4.1 |
  | 14 | 45 | 18 | 58 | 39 | 3.8 / 1.6 |
  | 16 | 60–61 | 2–4 | 16 | 11 | 0.2 / 0.0 |

  - **Pressure-passive** CBF falls in proportion to CPP and stops as ICP reaches MAP. **Intact** autoregulation holds CBF down to a CPP of ~35 mmHg; below ~30 its dilation reserve is exhausted (a lower limit of autoregulation near CPP 30 in the term newborn).
  - Until the re-validation ICP acted as a rise of the venous outflow resistance (`icp_outflow_gain` 0.03). That resistance is a small part of the cerebral bed, so CBF hardly fell: pressure-passive 92 mL/min with ICP above MAP, intact 104. Venous congestion also raised the cerebral blood volume, feeding ICP.
- **Neutral at rest.** The set-points dated from before the heart re-validation: term's natural cerebral flow had risen and the controller constricted 12 % at rest (factor 1.12). That was folded into `BR_ART` (`r_for`/`r_back` ×1.1228), so the factor is 1.00 at rest with CBF unchanged (106 mL/min), and `cbv0` was re-seeded to the resting cerebral blood volume (3.784 → 3.990 mL).
- **Dynamics.** After a step in arterial pressure CBF returns within ~5 s, without ringing (systemic resistance ×0.85: CBF +7 % at 2 s, +1 % at 5 s, then a steady +3 %, the leaky integrator's droop). With the former lags (`cbf_tc` 3 s, `autoreg_tc` 4 s) it rang with a ~22 s period for over a minute.
- **Resuming after a load.** The integrator restarts from the saved `autoreg_factor`, and the CBF and MAP smoothers from the saved `cbf` and `sensed_map`. Starting the CBF smoother at `cbf_setpoint` (as before the re-validation) zeroed the small standing error that the leaky integrator holds its factor with, so the leak pulled the factor away for the first seconds after every load.
- **One cerebral bed:** no regional flow, no CO2 reactivity (hypercapnia doesn't dilate the cerebral vessels), no venous haemorrhage model.

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Brain` (trimmed: wiring and gains are the defaults):

```json
{
  "name": "Brain",
  "model_type": "Brain",
  "is_enabled": true,
  "brain_running": true,
  "autoregulation_enabled": true,
  "autoregulation_gain": 1,
  "icp_enabled": true,
  "cbf_setpoint": 0.1059,
  "cpp_setpoint": 53.83,
  "cbv0": 3.9899,
  "edema_volume": 0,
  "icp_k": 0.18
}
```

## Usage in the scenarios

One instance in every scenario, running with intact autoregulation and the baseline stored. `cbf_setpoint` is 0.106 L/min in term_neonate_72h.

## References

No literature values; the gains, limits and the pressure–volume curve are model choices for teaching.

````

### FILE: explain-engine/docs/Breathing.md

````markdown
# Breathing

`Breathing` drives spontaneous breathing. It decides how much the patient should breathe (a target minute volume, set by the chemoreflex), splits that into a rate and a tidal volume, and turns it into a respiratory-muscle pressure that lowers the pleural (`THORAX`) pressure each breath. The effort follows the **neural drive**, not the measured tidal volume: the lungs, the airway and any device decide how much volume that effort moves. It is the spontaneous counterpart of the [Ventilator](./Ventilator.md), and the effort partner of [Respiration](./Respiration.md), which sets the mechanics the breath acts against.

## Physiology

The brainstem sets ventilation to keep arterial CO2 (and, weaker, O2) at its set-point: rising pCO2 increases minute ventilation through the chemoreflex. A newborn breathes fast and shallow, about 40/min at 5–6 mL/kg. At a higher drive both rate and depth rise; Mecklenburgh's relation describes the split, with tidal volume rising with rate.

Each breath the diaphragm and intercostal muscles contract during inspiration, lowering the pleural pressure so air flows in, and relax during expiration, which is passive. The same effort moves less air into stiff lungs (RDS) or through a narrow airway, and more on CPAP or pressure support. Patients partly defend their tidal volume against such loads through reflexes and muscle properties, but only partly. The rest is left to the chemoreflex, so a stiff lung shows as faster, shallower breathing and a higher pCO2.

## Inheritance

```
BaseModelClass
  └── Breathing
```

## Properties

### Config (set in the definition JSON)

| Property | Unit | Default | Description |
|---|---|---|---|
| `breathing_enabled` | boolean | `true` | Spontaneous breathing on/off (`switch_breathing`); off in a fetus. |
| `minute_volume_ref` | L/kg/min | 0.2 | Reference minute volume (term 0.207). |
| `minute_volume_ref_factor`, `minute_volume_ref_scaling_factor` | – | 1.0 | Persistent multipliers on the reference (no engine model writes them). |
| `vt_rr_ratio` | L·min/kg | 1.212e-4 | Mecklenburgh ratio: `Vt / RR` per kg (term 1.298e-4). |
| `vt_rr_ratio_factor`, `vt_rr_ratio_scaling_factor` | – | 1.0 | Multipliers on `vt_rr_ratio`. |
| `ie_ratio` | – | 0.3 | Inspiratory **fraction** of the breath (Ti/Ttot), not an I:E ratio. Term 0.40, preterm 0.38. |
| `rmp_gain` | mmHg/L | calibrated | Muscle pressure per litre of target tidal volume. |
| `rmp_calibrated` | boolean | `false` | `rmp_gain` holds a calibrated value (true in every scenario). |
| `rmp_gain_max` | mmHg | 100 | Cap on the peak muscle pressure. |
| `load_compensation` | 0–1 | 0.5 | Partial compensation of the effort for loads and support. |
| `mv_ans_factor` | – | 1.0 | Chemoreflex modulation of minute volume; written by the `EF_MV` efferent. |
| `ans_activity_factor` | – | 1.0 | Global multiplier on minute volume; no model writes it (a manual lever). |
| `thorax` | list | `["THORAX"]` | The container the muscle pressure acts on. |
| `hvd_enabled` | boolean | `true` | Hypoxic ventilatory depression (below). |
| `hvd_model` | – | `"AA"` | Arterial compartment whose pO2 is sensed. |
| `hvd_po2_threshold` | mmHg | 70 | The depression grows as pO2 falls below this (term rests at ~75). |
| `hvd_gain` | – | 2.0 | Drive reduction per fractional pO2 deficit below the threshold. |
| `hvd_max` | – | 0.8 | Largest fractional reduction of the drive. |
| `hvd_tc` | s | 120 | Time constant of the depression (onset and offset). |
| `hvd_factor` | – | 1.0 | Applied factor on the drive (state, saved; 1 = none). |

### Outputs

| Property | Unit | Description |
|---|---|---|
| `target_minute_volume` | L/min | Demanded minute volume. |
| `resp_rate` | /min | Computed rate (latched into each breath). |
| `resp_rate_measured` | /min | Rate from the observed breath timing. |
| `target_tidal_volume` | L | Demanded tidal volume. |
| `insp_tidal_volume`, `exp_tidal_volume` | L | Lung-volume rise over the last inspiration and fall from its peak; 0 while breathing is off. |
| `minute_volume` | L/min | `exp_tidal_volume · resp_rate`. |
| `resp_muscle_pressure` | mmHg | Current muscle pressure (positive = inspiratory effort). |
| `pmus_max` | mmHg | Peak muscle pressure of the current breath. |
| `load_factor` | – | Current effort trim from load compensation. |
| `insp_running`, `exp_running` | boolean | Spontaneous (neural) phase; both false while breathing is off. `_insp_running`/`_exp_running` remain as aliases. |
| `ncc_insp`, `ncc_exp` | steps | Phase step counters; `ncc_insp === 1` marks the first step of an inspiration. |

## Calculation

### Target minute volume and the rate / volume split

```
MV_ref               = minute_volume_ref · minute_volume_ref_factor · minute_volume_ref_scaling_factor · weight
target_minute_volume = (MV_ref + (mv_ans_factor − 1) · MV_ref) · ans_activity_factor · hvd_factor
resp_rate            = √( target_minute_volume / (vt_rr_ratio' · weight) )        Mecklenburgh: MV = ratio · RR²
target_tidal_volume  = target_minute_volume / resp_rate
```

`vt_rr_ratio'` includes its two factors. The inversion is guarded against a non-positive denominator or target.

### Hypoxic ventilatory depression

Under sustained hypoxaemia the newborn's ventilation rises within a minute (the peripheral chemoreflex, `EF_MV`) and then falls back over minutes, a central depression of the drive (De Boeck 1984; Rehan 1996). `hvd_factor` relaxes over `hvd_tc` towards

```
1 − min(hvd_gain · (hvd_po2_threshold − pO2) / hvd_po2_threshold, hvd_max)     while pO2 < hvd_po2_threshold, else 1
```

term_neonate_72h (re-validation): FiO₂ 0.15 → ventilation +16 % at 30 s, +18 % at 1 min, back to +4 % by 5 min (12 % below the peak; data ~14–16 %); the chemoreflex re-drives against the depression (factor 0.51 at 5 min), so the net fall is smaller than the factor. FiO₂ 0.07 (`probe_lactate`): pH 7.44 at 1 min (early hyperventilation), then 7.33 at 7 min as the depression lets the lactic acidosis show. Without it, the stronger peripheral chemoreflex of re-validation (l) kept that baby alkalotic (pH 7.41 at 7 min).

**term_neonate_72h calibration (2026-10):** `ie_ratio` 0.40 (Ti 0.65 s of 1.63 s); `vt_rr_ratio` set for RR 40 / Vt 5.3 mL/kg at 213 mL/kg/min; `minute_volume_ref` 0.207, with the chemoreceptor set-points re-anchored so the chemoreflex is neutral at PaCO2 39.7. With the linear muscle ramp, peak flows are 0.70 / 0.66 L/min/kg (reference 0.83 / 0.64). See `scripts/_fix_term_breathing_pattern.mjs` and [TermNeonateReference](./TermNeonateReference.md).

### Breath phases

While breathing is on, a breath starts when `_breath_timer` reaches `_breath_interval`. Its timing and target are **latched** for the whole breath, so a chemoreflex change during a breath acts on the next:

```
_breath_interval = 60 / resp_rate,   _ti = ie_ratio · _breath_interval,   _te = _breath_interval − _ti
```

Inspiration runs until `_breath_timer > _ti`, then expiration until the next start, where the finished breath is closed out (tidal volumes, calibration or load compensation).

**While breathing is off** there is no breath clock: no phases, tidal and minute volumes 0, rate 0, no muscle pressure. Switching it back on starts a breath at once.

**Tidal volumes are measured at the lungs** (`Respiration.lungs`), so they don't depend on the airway route (natural airway, ET tube, leak).

### Muscle pressure

```
pmus_max = min( rmp_gain · load_factor · latched target Vt , rmp_gain_max )
pmus(t)  = pmus_max · shape(t),        THORAX.pres_ext −= pmus(t)
```

`shape` ramps linearly from 0 to 1 over inspiration, then relaxes exponentially over expiration, `(e^(−4x) − e^(−4)) / (1 − e^(−4))`, with `x` the fraction of expiration elapsed. The pressure acts on the pleural space; THORAX resets `pres_ext` each step.

### Calibration

`rmp_gain` is the effort the patient's own respiratory system needs per litre of tidal volume. It is calibrated once and then frozen:
- **Starting estimate:** twice the elastance of the lungs and thorax in series, using their effective elastances `el_eff`, so factor layers count.
- **Per-breath correction** by `(target / exhaled Vt)^0.8`. The gain freezes after 3 consecutive breaths within 2 %, or after 40 breaths.
- **The shipped scenarios** carry a gain written by `scripts/_calibrate_breathing.mjs`, run on the natural airway with the ventilator off. Re-run it after changing a scenario's lung or thorax mechanics.
- **Older scenarios** stored `rmp_gain` as an elastance gain; without `rmp_calibrated` the value is discarded and recalibrated.

### Load compensation

A proportional trim of the effort, updated each breath and pulled back toward 1:

```
load_factor += 0.2 · [ (target / Vt − 1) · lc − (load_factor − 1) · (1 − lc) ]       lc = load_compensation (≤ 0.95)
steady state:  load_factor − 1 = lc / (1 − lc) · (target / Vt − 1),     clamped 0.25–4
```

`lc = 0` is a pure pressure generator; `lc → 1` defends the target tidal volume. The default 0.5 halves the tidal-volume deficit of a load.

## Factor system

None of the engine's factor layers. Its own multipliers (`*_factor`, `*_scaling_factor`, `mv_ans_factor`, `ans_activity_factor`) multiply the minute volume or the Vt/RR ratio and are never reset.

## Inputs and outputs

- **Reads:** the lungs' volumes; the lungs' and thorax's `el_eff` (initial estimate); `model.weight`.
- **Writes:** `THORAX.pres_ext`.
- **Written by:**
  - the `EF_MV` efferent of the chemoreflex (`mv_ans_factor`);
  - [Apnea](./Apnea.md) and Resuscitation (`breathing_enabled` through `switch_breathing`);
  - the Calibrator and scenario scripts (`minute_volume_ref`, `vt_rr_ratio`).
- **Read by:**
  - [Ventilator](./Ventilator.md): it arms its patient trigger on `ncc_insp === 1`, disarms on `!insp_running`, and classes spontaneous breaths by `insp_running`;
  - Monitor (counts a breath on `ncc_insp === 1` while breathing is on);
  - `DataCollector` watchers.

## Assumptions and limitations

- **The rate follows only the drive.** No vagal rate response to stiff lungs, no Hering–Breuer shortening of inspiration (parked).
- **Central vs obstructive apnoea.** A central apnoea switches breathing off; an obstructive one keeps the drive and closes `MOUTH_DS` (see [Apnea](./Apnea.md)).
- **One muscle-pressure shape** (linear ramp); infants reach peak flow earlier in inspiration, so peak inspiratory flow is ~15 % low at term.
- **`resp_rate_measured` has a start-up transient** over the first breaths; the settled value is correct.
- **Verification:** `npm run validate:resp` (see [TESTING](./TESTING.md)) checks the spontaneous steady state, the chemoreflex, resistive and elastic loads, CPAP and pressure support against clinical ranges. The known failures are the missing vagal and Hering–Breuer reflexes, plus listed ventilator and preterm calibration items.

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Breathing` (trimmed to the config props):

```json
{
  "name": "Breathing",
  "model_type": "Breathing",
  "is_enabled": true,
  "breathing_enabled": true,
  "minute_volume_ref": 0.20729,
  "minute_volume_ref_factor": 1,
  "minute_volume_ref_scaling_factor": 1,
  "vt_rr_ratio": 0.00012979,
  "vt_rr_ratio_factor": 1,
  "vt_rr_ratio_scaling_factor": 1,
  "ie_ratio": 0.4,
  "rmp_gain": 334.48,
  "rmp_calibrated": true,
  "rmp_gain_max": 100,
  "load_compensation": 0.5,
  "mv_ans_factor": 0.9978,
  "ans_activity_factor": 1
}
```

## Usage in the scenarios

One instance in every scenario.

| Scenario | Breathing | `minute_volume_ref` | `vt_rr_ratio` | `ie_ratio` | `rmp_gain` |
|---|---|---|---|---|---|
| term_neonate_72h | on | 0.207 | 1.30e-4 | 0.40 | 334 |

## References

The term breathing pattern (rate, tidal volume, minute ventilation, Ti/Ttot, peak flows) is referenced in [TermNeonateReference](./TermNeonateReference.md) (Schmalisch 2005; Hannover 2018).

- De Boeck C, Van Reempts P, Rigatto H, Chernick V. Naloxone reduces decrease in ventilation induced by hypoxia in newborn infants. *J Appl Physiol* 1984;56:1507–11. doi:10.1152/jappl.1984.56.6.1507 (term newborns on 15 % O2: ventilation ~14 % below its early peak)
- Rehan V, Haider AZ, Alvaro RE, et al. The biphasic ventilatory response to hypoxia in preterm infants is not due to a decrease in metabolism. *Pediatr Pulmonol* 1996;22:287–94. doi:10.1002/(SICI)1099-0496(199611)22:5<287::AID-PPUL1>3.0.CO;2-I (−16 ± 2 % from the peak at 5 min; likely central)

````

### FILE: explain-engine/docs/Calibrator.md

```markdown
# Calibrator

`Calibrator` (`explain/helpers/Calibrator.js`) is **engine infrastructure**, not a physiological model. It is a shared closed-loop calibrator: it drives measured physiological quantities (MAP, cardiac output, heart rate, PaO2/SpO2, PaCO2, base excess/pH, blood volume) toward target values by iterating one lever per target — apply lever → advance the model → measure → nudge → repeat. The nudge uses a proportional seed for the first move, then switches to the **secant method** once two samples exist.

The module is environment-agnostic on purpose. It is used by **two callers, both with direct `model` access**:

- `scripts/build_patient.mjs` (Node) — closed-loop builder that calibrates a fresh patient from a baseline definition (imports `makeController`, `runCalibration`).
- `explain/ModelEngine.js` (Web Worker) — `tune_model` tunes the **running** model in place (imports `buildLiveControllers`, `runCalibration`, `measureWindow`).

Each caller injects a `step(seconds)` callback (advance the model) and a `measureAll()` callback (read averaged vitals); the loop itself knows nothing about how the model runs. See [ARCHITECTURE](./ARCHITECTURE.md) for the worker message protocol and the factor/`_eff` pattern the live levers rely on.

## Role in the engine

In the worker, `ModelEngine.tune_model(payload)` performs a live, in-place calibration: it pauses the realtime loop, builds a `stepFn` that calls `_model_step()` synchronously, builds controllers from the requested `targets`, runs `runCalibration` (advancing `liveWarm(targets)` seconds between iterations: 35 s when SpO2/pO2 is a target, else 15 s), emits a `tuned` message with the result, then resumes realtime from the new operating point. No reload and no `ModelScaler` reset are involved — the levers compose with the patient's already-baked scaling. Outside the engine, `build_patient.mjs` uses the same `runCalibration` loop with its own controllers to converge a new patient before saving the definition.

## Key state / configuration it reads

- **`SLICE`** (`0.02` s) — module-private sub-cardiac-cycle sample step used by `measureWindow` for windowed averaging.
- **`DEFAULT_TOL`** (exported) — per-target convergence tolerances on the measured value:
  `map: 3`, `pp: 2`, `cvp: 1.5`, `pap_m: 3`, `pap_s: 4`, `hr: 6`, `co: 0.03`, `spo2: 2`, `po2: 6`, `pco2: 4`, `ph: 0.03`, `be: 1.5`, `blood_volume: 0.02`. Callers may override per target via `tolOverrides`.
- **`LIVE_TARGETS`** (exported) — the canonical list of live-tunable target names, for validation / UI / docs: `["map", "sys", "dia", "co", "hr", "pap_m", "pap_s", "po2", "spo2", "pco2", "be", "ph", "blood_volume"]`. `sys` and `dia` work only as a pair: `buildLiveControllers` turns them into a pulse-pressure target (`pp = sys − dia`) and, unless `map` is given, `map = dia + pp/3`, as the builder does. One alone is ignored.
- **`ARTERIAL_EL_MAX`** (`6.0`) and **`DIF_O2_FLOOR`** (`0.1`) (exported) — shared with the builder: the total arterial elastance multiplier (size scaling × pulse-pressure lever) the levers may reach, and the oxygen lever's diffusion floor. The limit used to be 2.0, set by explicit integration of the near-merged aortic compartments; **`enableImplicitAorta(model)`** (exported) switches the **`AORTIC_RESISTORS`** (exported: `AA_AAR` and `AAR_AD`) to backward-Euler flow (`Resistor.implicit`, see [Resistor](./Resistor.md)), after which term and 0.72 kg patients are stable to at least ×8.
- **`liveWarm(targets)`** (exported) — seconds between live-tune iterations: 35 when `spo2`/`po2` is a target (oxygen settles slowly; with 15 s an SpO2 tune was measured mid-fall and ended 2–3 points under target), else 15.
- **`LIVE_READ`** (module-private) — a map from measure key to a reader that pulls the value off the running `model` (e.g. `map` ← `Monitor.minmax.abp_pre_pres_mean`, `sys`/`dia`/`pp` ← `Monitor.minmax.abp_pre_pres_max`/`_min`/their difference, `pap_s` ← `pap_pres_max`, `lvo` ← `Monitor.flows.lvo`, `po2`/`pco2`/`ph`/`be` ← the `AA` compartment, `total_blood_volume` ← `Circulation`). Used by `measureWindow`.
- **`READ_KEY`** (module-private) — maps a canonical target name to the measure-dict key it reads when they differ: `co → lvo`, `spo2 → spo2_pre`, `blood_volume → total_blood_volume`.

## Key methods / exports

- **`makeController(spec)`** — wraps a lever spec into a stateful controller. Spec fields: `key` (canonical target, e.g. `"co"`), `readKey` (key into the measured dict, defaults to `key`), `lo`/`hi` (clamp bounds), `sign` (+1 if raising the lever raises the measured value), `gain` (proportional seed gain), `value` (current lever value), `set(v)` (apply lever to the model), `target`, `tol`. Its `step(measured)` method returns `false` (no move) when the measurement is within `tol` or non-numeric; otherwise it computes the next lever value — secant (`value + (target-measured)/slope`) once `prevL`/`prevM` exist and the slope is well-defined, else proportional (`value + sign*gain*(target-measured)`) — clamps to `[lo, hi]`, records the previous sample, applies via `set`, and returns `true`.
- **`runCalibration(controllers, opts)`** — the generic loop, shared by build + live tune. `opts`: `measureAll()`, `step(seconds)`, `settle` (default 90 s; one settle step before iterating), `warm` (45 s between iterations), `maxIters` (12), `final` (0; optional extra settle at the end), `log`. Each iteration measures all read keys, calls `step(v[readKey])` on every controller, and breaks early when no controller moved (converged). Returns `{ iters, converged, residuals: [{key, target, value, within}], measured }`.
- **`measureWindow(model, step, keys, window = 12)`** — advances the model in `SLICE`-sized increments over `window` seconds, averaging each requested key via `LIVE_READ`. This is the `measureAll` implementation the worker passes to `runCalibration`. (The `Monitor` model already beat-averages; this adds a short window on top for robustness.)
- **`buildLiveControllers(model, targets, tolOverrides = {})`** — builds the live-tune controller set from a `{name: value}` targets map. Returns `{ controllers, keys }`, where `keys` is the de-duplicated list of measure-dict keys to sample. Only creates a controller for targets present in `targets` (and whose required model exists). See levers below.

## Closed-loop control

Each controller couples one **lever** (a model property it writes via `set`) to one **measured quantity** (read by `readKey`). `runCalibration` settles, then repeatedly measures and lets every controller nudge its lever; convergence is "no controller moved this iteration," and per-target success is `|target − measured| ≤ tol`. The first nudge is proportional (seeded by `gain`/`sign`); thereafter each controller estimates local slope from its last two (lever, measurement) samples and takes a secant step, clamped to `[lo, hi]`.

**`maxStepFrac`** (opt-in; `0.5` in the offline builder and the live tuner, except the live BE/pH lever, whose `uma` often starts at 0): no step may move a lever by more than this fraction of its current value. A secant slope measured where the response is flat overshoots where it is steep — pCO2 against ventilatory drive is the typical case, one step from 0.67 to the 0.2 floor — and once the vital lands inside its tolerance the lever stays at that extreme, where it distorts other vitals (a baby breathing at minimum drive has a low alveolar pO2 that no diffusion lever can compensate).

**`signGuard`** (opt-in; on in the offline builder and the live tuner): a secant slope whose sign contradicts the controller's `sign` is rejected in favour of the proportional step. All controllers move at once, so part of a vital's change between two samples comes from its neighbours' levers; the secant then attributes it to its own lever and can read a physically impossible slope. Seen in a 7-target preterm build: with the new respiratory-rate lever moving pCO2, the oxygen controller walked alveolar diffusion to its *maximum* while SpO2 sat above target (with the guard it ends at its minimum, as expected on FiO2 0.4).

The live levers built by `buildLiveControllers` deliberately use the persistent **`*_factor_ps`** layer or direct setters — **not `ModelScaler` groups** — so they compose with a loaded patient's calibration and with the user's own changes, instead of overwriting the `*_factor_scaling_ps` layer absolutely the way `ModelScaler` does (see [ModelScaler](./ModelScaler.md) and the factor/`_eff` pattern in [ARCHITECTURE](./ARCHITECTURE.md)):

| Target | Lever | Notes |
|---|---|---|
| `map` | `r_factor_ps` on every resistor in `scaler_config.blood_systemic.resistance` (delta-accumulating), plus `BR_MAP.set_value` = the target's time-averaged equivalent | systemic resistance; ↑ raises MAP. A delta on the same `r_factor_ps` Circulation's channels (user SVR, Drugs, Hormones) add to, over the whole systemic set rather than only Circulation's arterioles (which alone have weak MAP authority). The target is the clinical mean (`abp_pre_pres_mean`, dia + pp/3); the baroreflex senses the time-averaged pressure, so its set-point is moved to the target plus the current gap `abp_pre_pres_mean_int − abp_pre_pres_mean`, and the ANS defends the new operating point. |
| `co` | `LV.el_max_factor_ps` and `RV.el_max_factor_ps` | ventricular contractility; reads `lvo` |
| `hr` | `Heart.heart_rate_ref` | HR reference setpoint |
| `po2` / `spo2` | `GASEX_LL/RL.dif_o2_factor_ps`, below `DIF_O2_FLOOR` `Shunts.ips_res` | the builder's continuous oxygen lever: alveolar O2 diffusion down to ×0.1, then the intrapulmonary shunt opens in proportion, to a tenth of its value at the start of the tune; one controller, reads `po2` or `spo2_pre` |
| `sys` + `dia` (→ `pp`, `map`) | `AA`, `AAR`, `AD` `el_base_factor_ps` | large-artery stiffness, as in the builder. Its upper bound is `0.95 · ARTERIAL_EL_MAX / scaling`, where `scaling` is any size stiffening still in `el_base_factor_scaling_ps`. The shipped scenarios have it baked into `el_base` (v1.0, see [ModelScaler](./ModelScaler.md)), so the bound is ×5.7 on top of the loaded stiffness; preterm_25wk is stable there (ABP 76/14 with the implicit aorta); the live tuner first calls `enableImplicitAorta` on the running model (a loaded scenario may predate it), because a live tune cannot discard a failed run. MAP is tuned by its own lever, which then leaves the large arteries' resistance alone: stability goes roughly with elastance / resistance, and lowering their resistance while stiffening them blew up a term neonate (×0.68 resistance, ×1.63 stiffness) although each alone was stable |
| `pap_m` / `pap_s` | pulmonary bed (`scaler_config.blood_pulmonary.resistance`) on `r_factor_ps`, `IPSL`/`IPSR` on `r_factor_scaling_ps` | pulmonary resistance, moving the intrapulmonary shunt with the bed as the builder does, so the shunt's share of pulmonary flow stays put. The lever multiplies each resistor's effective resistance relative to the start of the tune, applied as a delta (BloodVessel multiplies its layers, Resistor adds them); IPSL/IPSR use the scaling layer because Surfactant owns their `r_factor_ps`. `pap_m` wins when both are given |
| `pco2` | `Breathing.minute_volume_ref` (× multiplier) | spontaneous ventilatory drive; `sign: -1` (↓ drive raises pCO2) |
| `be` / `ph` | `Blood.set_solute("uma", …)` | Stewart unmeasured anions; `sign: -1` (↑ uma lowers BE/pH) |
| `blood_volume` | proportional rescale of every blood compartment's `vol`/`u_vol` | custom `step` (not a secant lever): scales by `target/measured` each iteration; converges in 1–2 iters because the body redistributes volume |

## The offline builder (`scripts/build_patient.mjs`)

The builder shares `makeController`/`runCalibration` but has its **own** controllers, because it
starts from a freshly built baseline rather than a running patient. Two differ from the live table:
`map` scales the `systemic_resistances` `ModelScaler` group (and `pap_m` the `pulmonary_resistances`
group), and it adds `cvp` ← venous unstressed volume (`VLB`/`VUB` `u_vol`). On a fetal baseline the
oxygen and CO2 levers are the placental maternal pool instead (see [fetal_circulation](./fetal_circulation.md)).

Two builder-only targets:

- **`sys` + `dia`** (a pair; one alone is ignored with a note): the builder derives the pulse pressure `pp = sys − dia` and, if `map` is absent, `map = dia + pp/3` (both listed under `build_report.derived_targets`). MAP keeps its resistance lever; `pp` gets **large-artery stiffness** — `el_base_factor_ps` on `AA`, `AAR`, `AD`, bounds 0.3 to `ARTERIAL_EL_MAX / size factor`. Stiffening raises systolic and lowers diastolic around a nearly unchanged mean, so the two levers barely interact. The MAP tolerance is at most 5 % of the target (±3 mmHg would be 10 % of a 720 g infant's MAP). Every neonatal build integrates the intra-aortic resistors implicitly (`enableImplicitAorta`); before that the integrator failed at about ×2 total arterial elastance, which capped small infants' pulse pressure.

**Arterial stiffness follows size (builder only).** `weight_scale` shrinks arterial volumes but leaves their elastance, so a small baby's arteries would be as compliant as a term baby's: a 1.08 kg / 28 wk build had a pulse pressure of 11 mmHg against a reference of about 15–27. Measured aortic pulse-wave velocity falls far less with size than vessel volume does (term ~4.2–4.6 m/s, preterm at 32 wk corrected ~3.2 m/s), and preterm arteries are intrinsically stiffer than term ones ([Tauzin et al., Pediatr Res 2006](https://www.nature.com/articles/pr2006354)). By Bramwell-Hill (PWV² = V·E/ρ) a roughly constant PWV with V ∝ W needs E to rise as W falls. The builder sets `el_base_factor_scaling_ps` on the systemic arteries (`AA`, `AAR`, `AD`, `RLB`, `RUB`, `*_ART`) to **(W/W0)^-0.5**, where W0 is the term reference weight 3.545 kg (not the baseline's, so an already-small baseline made before this rule, such as `bischoff_cohort` or `preterm_*wk`, is sized too; the factor is set absolutely, so a baseline that already carries it is unchanged). On the 1.08 kg case that is ×1.81: implied PWV 0.74 of term, matching the measured preterm/term ratio of 0.70–0.76. Without a pressure-pair target the pulse pressure then lands at about 16–18 mmHg, up from 11. It depends on heart rate: about 16 at the ~170/min an untargeted build settles at, about 18 with HR 158 targeted.

The factor is capped at ×2.5 (0.57 kg), the edge of the pulse-wave-velocity data it extrapolates; the old ×1.9 cap was the explicit integrator's limit and is gone with the implicit aortic resistors. The pulse-pressure lever multiplies on top (`BloodVessel` composes elastance factors multiplicatively), so its upper bound is `ARTERIAL_EL_MAX / size factor`. On the 0.72 kg Bischoff infant a 45/25 target now converges (it stopped at about 35/24 with the lever at the old bound). Term builds (no weight change), fetal mode and the live `ModelScaler.scale_to_weight` are unchanged. As a backstop, a build whose final pressures are non-finite, negative diastolic, systolic above 250 or output above 10 L/min is refused (exit 1) instead of emitted.
- **`rvo`** (L/min) — right-ventricular output via `Shunts.diameter_fo`. With the duct closed the two
  outputs differ only by the atrial shunt (RVO = LVO + Q_fo), so the foramen is the one lever that sets
  RVO given LVO; a given `fo_mm` is the starting point, a closed foramen starts at 0.25 mm. Tolerance
  0.03 L/min. Meaningful only when the duct is closed.
- **`svc`** (L/min) — superior vena cava flow via the upper/lower-body resistance split: the lever u
  divides the upper-body arteriolar resistance (`AA_BR_ART`, `AA_RUB`) by u and multiplies the
  lower-body arterioles (`AD_INT_ART`, `AD_LS_ART`, `AD_KID_ART`, `AD_RLB`) by u, bounds 0.4–3, so flow
  is redistributed while the total systemic resistance (the MAP lever's) stays nearly unchanged.
  Tolerance 0.015 L/min at 3.5 kg, scaled with weight.
- **`rr`** — spontaneous respiratory rate via `Breathing.vt_rr_ratio_factor`. Breathing sets `rate = √(target minute volume / (ratio × weight))`, so the controller steps in closed form, `f ← f × (measured / target)²`, bounds 0.2–5. Minute volume stays with the pCO2 lever; the two interact only through dead space. Refused (exit 1) when spontaneous breathing is off.

**Plasma solutes** — `na`, `k`, `cl`, `lactate`, `glucose` (mmol/L) and `albumin` (g/L) are structural: written to every blood compartment with `Blood.set_solute` before the loop. They feed the Stewart solver (`sid = na + k + 2ca + 2mg − cl − lact`, albumin as a weak acid), so with them a `be`/`ph` target is fitted by the unmeasured anions (`uma`) *left over* after the measured ions, rather than `uma` absorbing the whole acidosis. Two have their own controllers, which are moved with them: `Lactate.lact_baseline` (clearance target, t½ ≈ 6 min) and `Glucose.glucose_setpoint`. Kidney filtration moves the others only slightly over a build; the final arterial values are read back into `build_report.solutes`. If the measured ions already explain more than the measured acidosis, `uma` hits its floor of 0 and the BE target is reported missed with its lever at bound.

**Echo inputs:**

- **`pda_mm`** (structural): the duct's measured diameter at its narrowest, pulmonary end, in mm (0 = closed). The model sizes the duct as `diameter_relative × diameter_pa_max` (and `× diameter_ao_max` at the aortic end), so this sets `diameter_relative = pda_mm / diameter_pa_max`, first widening both maxima when the measured duct is larger. Takes precedence over the 0–1 `pda` fraction. Shunt direction and size are then outcomes of the pressures on either side (`build_report.measured.q_da`, L/s, + = left-to-right).
- **`pap_s`** (iterated): systolic pulmonary artery pressure, the value an echo gives from the tricuspid regurgitation jet (4v² + right atrial pressure). Same lever as `pap_m` (pulmonary resistance scale); `pap_m` wins when both are given.
- **`fo_mm`** (structural): the measured opening of the foramen ovale / atrial septum, in mm (0 = closed). Sets `Shunts.diameter_fo`, which sizes the FO resistors (`LA_RAIVCI`, `LA_RASVC`) by Poiseuille; `diameter_fo_max` is widened when the opening is larger (accepted up to 15 mm). The baseline's flap-valve asymmetry is kept: left-to-right flow meets `fo_lr_factor` × the right-to-left resistance (25 in `term_neonate_72h`), so a 3 mm PFO in a term baby carries about 50 mL/min left-to-right; with no asymmetry it would be about 190. Direction and size are outcomes (`build_report.measured.q_fo`, L/s, + = left-to-right). Refused on a fetal baseline, where the gestational-age seed sizes the foramen.
- **`ef`** (iterated): LV ejection fraction in %, as `Heart.lv_ef` (stroke volume / end-diastolic volume of the last beat). Lever: `LV.el_max_factor_ps` (LV contractility only, since an echo EF is left-ventricular), bounds 0.3–3, tolerance 5 %-points. This is the lever `co` uses on both ventricles, and `co` keeps it when both are given (`ef` is then listed under `superseded_targets` and only reported): output is the input that separates flow from resistance. Contractility moves EF far more than output (on `term_neonate_72h`, ×0.6–1.6 gives EF 47–70 % but LVO only 179–207 mL/kg/min), so a CO fitted on this lever can leave EF well away from the echo value. The normal-range tables have no EF row, so it is reported without a flag.

**The pulmonary-resistance lever moves the intrapulmonary shunt with the bed (builder only).** `pulmonary_resistances` scales the `blood_pulmonary.resistance` group, which does not include the intrapulmonary shunt resistors (`IPSL`/`IPSR`). On its own, raising pulmonary pressure therefore also raised the fraction of pulmonary flow bypassing ventilated alveoli: on a 1.08 kg / 28 wk case, from 33 % to 46 % at systolic PAP 36, SpO2 92.6 → 85.7. That is not the physiology. Pulmonary hypertension desaturates through the duct and foramen, and the shunt vessels constrict with the rest of the bed (see [Shunts](./Shunts.md#physiology)). So the builder's PAP lever also sets `r_factor_scaling_ps` on `IPSL`/`IPSR`, **relative to its starting value** (`f / f0`, with `f0` the seed's or `pathophysiology.pvr_scale`'s PVR). The seed's `ips_res` was calibrated with the seed PVR on the bed only, so that operating point does not move. On the same case at systolic PAP 36 the shunt fraction now stays at 33.4 %, SpO2 drops only to 91.7, and the ductal left-to-right flow falls from 55 to 27 mL/min. Builds without a PAP target, and the structural-only seed PVR, are unchanged. The live scaler's `pulmonary_resistances` group is unchanged too.

Before calibrating it applies the **structural** targets: `weight`, `gestational_age` (a seed bundle),
`height`, `age`, `hb`/`hb_gdl`, `temp`, `pda`/`pda_mm`, `fo_mm` and **`fio2`**. A spec with only structural targets (or none) is still built: there is nothing to iterate, so the patient is settled for `settle_seconds + final_seconds`, measured and emitted with an empty `targets` list and a note saying nothing was calibrated.

The gestational-age seed is for a term baseline. A baseline that is already preterm (`preterm_*wk`, `bischoff_cohort`: its `gestational_age` is below 37) carries the seed's multiplicative adjustments, so a spec that adds `gestational_age` below 37 to it is refused (exit 1) instead of applying prematurity twice. Use `term_neonate_72h` + `gestational_age`, or the preterm baseline without it. Fetal baselines use their own seed table and are exempt.

**`targets.fio2`** (fraction, 0.21–1.0) sets the inspired oxygen the patient breathes, via
`Gas.set_fio2`, before the loop runs. This matters for what the oxygen lever means: alveolar diffusion
is fitted to the measured SpO2/PO2 *at that FiO2*. A saturation of 91 % on 40 % oxygen needs much
worse gas exchange than 91 % in room air; without `fio2` the builder assumes room air and gives a
baby on oxygen far healthier lungs than it has. Rejected on a fetal baseline and outside 0.21–1.0.

**Oxygen lever below the diffusion floor (builder only).** On high FiO2 the diffusion factor can reach its floor (×0.1) with the baby still saturating above target: a 1.08 kg / 28 wk preterm on 40 % oxygen stopped at SpO2 92.8. The builder's oxygen controller therefore runs on one continuous scale, bounds 0.01–8. Above 0.1 it is the diffusion factor, exactly as before. Below it, diffusion stays at 0.1 and the intrapulmonary shunt opens: `Shunts.ips_res` falls in proportion to the lever, down to a tenth of the patient's starting value (the gestational-age seed's, e.g. 1900 at 28 wk). That is also the clinical picture: a sick preterm's hypoxaemia on oxygen is mostly shunt. On that case, ips_res 1900 → 800 → 300 takes SpO2 from 92.8 to 82.6 and 56, with MAP, PAP and output nearly unchanged and pCO2 a few mmHg higher (the pCO2 lever compensates). A build that opened the shunt says so under `build_report.notes`. Builds whose oxygen lever stays above 0.1 are unchanged. The live tuner uses the same continuous lever, with the shunt opened relative to its value at the start of the tune.

**`build_report`** — the emitted scenario carries a top-level, machine-readable report (stderr keeps
the human-readable one):

| Field | Meaning |
|---|---|
| `converged`, `iters`, `max_iters` | outcome of the loop |
| `targets[]` | per calibrated target: `target`, `value`, `delta`, `tolerance`, `within`, `lever`, `lever_value`, `lever_bounds`, `lever_at_bound` |
| `measured` | every measured vital: `{ value, flag }`, flag from the profile's ranges (`rangesFor`, `ok`/`LOW`/`HIGH`) |
| `postnatal_age_days` | the postnatal age the flags assumed: `spec.postnatal_age_days`, else `targets.age` × 365, else the baseline's age (term baselines: 0 = day 1) |
| `structural` | the structural targets that were applied |

**Age-dependent PAP ranges (term neonate).** Pulmonary artery pressure falls steeply over the first days, so the `neonate` profile's `pap_s`/`pap_d`/`pap_m` ranges follow postnatal age (`NEONATE_PAP_BY_AGE` in `_probe.mjs`): under 36 h systolic 28–60, diastolic 5–37, mean 15–54; 36–60 h 22–55, 5–25, 11–41; from 60 h the table's 18–40, 5–20, 12–30. These are mean ± 2 SD of 76 healthy term newborns by echo (Medicine 2016, [PMID 26817918](https://pubmed.ncbi.nlm.nih.gov/26817918/): systolic 43.8 ± 7.9 at 24 h, 38.1 ± 8.3 at 48 h, upper 95 % limit 40 at 72 h). Without them a normal day-1 baby was flagged HIGH: `term_neonate_72h`, described as 24 h old, measures 40/17 (mean 27), and a 3 mm PFO took it to 41.5. Preterm, fetal and adult ranges are not age-dependent. The age is metadata (`spec.postnatal_age_days`, which also sets `model.age` in years when `targets.age` is absent); no model reads it.
| `derived_targets` | `pp` (and `map`) computed from `sys`/`dia` |
| `solutes` | per solute set: `{ set, value }`, the arterial (AA) value after calibration |
| `ignored_targets` | `targets` keys the builder does not know. They are **ignored**, so they are listed |
| `superseded_targets` | `spo2` when `po2` is also given, `ph` when `be` is: one lever each, the first wins |
| `notes` | e.g. `pco2` targeted while spontaneous breathing is off (its lever cannot move it) |

`lever_at_bound: true` means the lever ran into its limit: the target is out of that lever's reach,
which is different from "needs more iterations". The scenario's `provenance` is set to
`"calibrator-fitted"` (it used to inherit the baseline's).

**Check on the baked preterm_25wk** (v1.0): `POST "calibrate"` with `{targets: {map: 42, hr: 150}}` converges in one iteration (MAP 40.5, HR 153, both within tolerance).

## Notes / caveats

- **`blood_volume` is special.** Its controller overrides `step` to proportionally rescale `vol`/`u_vol` on every blood-bearing compartment (those with a numeric `vol` and a non-empty `solutes` map), excluding `ECLS*` and `URINE`. It has `gain: 0` and a no-op `set` because it does not move a single lever.
- **Live tune is synchronous and pauses realtime.** `tune_model` clears the realtime interval and disables `DataCollector.rt_active` while calibrating, then resumes (`start()`) in a `finally` block. It uses shorter defaults than the builder (`settle: 20`, `warm: 15`, `window: 10`) supplied via `opts`.
- **Convergence is not guaranteed.** `runCalibration` stops at `maxIters` (default 12) or when no controller moves; the returned `converged` flag and `residuals[].within` tell the caller which targets landed inside tolerance. The worker emits `"converged"` or `"incomplete"` accordingly.
- **Coupled targets interact.** Several levers affect each other's measured values (e.g. blood volume ↔ MAP/CVP, ventilation ↔ pH). The shared loop nudges all controllers each iteration and relies on re-measurement + the secant slope to settle the coupled system; tight or conflicting targets may not all converge.
- **`measureAll` keys must match `readKey`.** `buildLiveControllers` returns exactly the `keys` to sample; passing a different key set to `measureWindow` would leave controllers reading `undefined` and refusing to move.

```

### FILE: explain-engine/docs/Capacitance.md

````markdown
# Capacitance

A `Capacitance` is the basic elastic compartment of the engine: it holds a volume and turns the volume above its unstressed volume into a pressure. Every blood and gas compartment is built on it. It is also the reference implementation of the additive [factor pattern](./ARCHITECTURE.md#7a-the-factor--effective-value-pattern).

## Physiology

A blood vessel, a heart chamber at rest, or an air space in the lung each behave like an elastic bag:

- **Unstressed volume.** Up to a certain volume the wall is slack, and filling it costs no pressure. In veins this is most of the blood they hold; it is the reserve the body mobilises by venoconstriction.
- **Elastance.** Above the unstressed volume, every extra millilitre raises the pressure. The stiffer the wall, the higher the *elastance* (mmHg per litre). Elastance is the inverse of *compliance*.
- **Stiffening.** Many walls get stiffer as they are stretched further (arteries at high pressure, a full pericardium). An optional non-linear term models this.

Blood or gas moves between compartments only through separate connectors (`Resistor`s). A Capacitance on its own just stores volume and reports a pressure.

## Inheritance

```
BaseModelClass
  └── Capacitance
        ├── BloodCapacitance      (+ blood composition mixing)
        │     └── BloodVessel     (+ own resistance, ANS; composes its factors multiplicatively)
        └── GasCapacitance        (+ gas composition, atmospheric pressure, humidity, heat)
```

`Container` and `TimeVaryingElastance` repeat the same elastance code but extend `BaseModelClass` directly.

## Properties

### Config (set in the definition JSON)

| Property | Unit | Default | Description |
|---|---|---|---|
| `u_vol` | L | 0.0 | Unstressed volume: the pressure from the wall is zero at this volume. |
| `el_base` | mmHg/L | 0.0 | Linear elastance (1 / compliance). |
| `el_k` | mmHg/L² | 0.0 | Non-linear elastance; adds `el_k·(vol − u_vol)²` above the unstressed volume only. 0 in most compartments. |
| `fixed_composition` | boolean | `false` | `true` makes the compartment an infinite reservoir: `volume_in`/`volume_out` don't change `vol` (and the subclasses don't mix its composition). |
| `vol` | L | 0.0 | Volume. Set in the definition as the starting volume, then changed by the connected resistors. |
| `u_vol_factor`, `el_base_factor`, `el_k_factor` | – | 1.0 | Non-persistent factors, reset to 1 every step. |
| `u_vol_factor_ps`, `el_base_factor_ps`, `el_k_factor_ps` | – | 1.0 | Persistent factors. |
| `u_vol_factor_scaling_ps`, `el_base_factor_scaling_ps`, `el_k_factor_scaling_ps` | – | 1.0 | Persistent scaling factors. |

### Outputs

| Property | Unit | Default | Description |
|---|---|---|---|
| `pres_in` | mmHg | 0.0 | Recoil pressure of the wall. |
| `pres` | mmHg | 0.0 | Total pressure: `pres_in + pres_ext`. This is what the resistors read. |
| `el_eff`, `el_k_eff` | mmHg/L, mmHg/L² | 0.0 | Effective elastances after the factor layers. |
| `u_vol_eff` | L | 0.0 | Effective unstressed volume after the factor layers, floored at 0. |

### Set by other models

| Property | Unit | Default | Description |
|---|---|---|---|
| `pres_ext` | mmHg | 0.0 | External pressure for this step, reset to 0 after use. Written by a [`Container`](./Container.md) (thorax, pericardium) on its members, and by `Resuscitation` on its targets. A saved state carries the last step's value, which acts once on the first step. |

## Calculation

`calc_model()` runs `calc_elastances()` → `calc_volumes()` → `calc_pressure()`.

1. **`calc_elastances`**
   ```
   el_eff   = el_base · (1 + (el_base_factor − 1) + (el_base_factor_ps − 1) + (el_base_factor_scaling_ps − 1))
   el_k_eff = el_k    · (1 + (el_k_factor − 1)    + (el_k_factor_ps − 1)    + (el_k_factor_scaling_ps − 1))
   ```
   then `el_base_factor` and `el_k_factor` are reset to 1.
2. **`calc_volumes`**
   ```
   u_vol_eff = max(0, u_vol · (1 + (u_vol_factor − 1) + (u_vol_factor_ps − 1) + (u_vol_factor_scaling_ps − 1)))
   ```
   then `u_vol_factor` is reset to 1. The floor exists because the layers add: two writers lowering them at once (Surfactant derecruitment and atelectasis on the same lung) could otherwise give a negative unstressed volume.
3. **`calc_pressure`**, with `S = vol − u_vol_eff`:
   ```
   pres_in = (S > 0 ? el_k_eff · S² : 0) + el_eff · S
   pres    = pres_in + pres_ext
   pres_ext = 0
   ```
   The non-linear term acts only above the unstressed volume. `S²` is also positive below it, where it would push against the linear term and bend the curve back up. For example, the term_neonate_72h aorta (`el_k` 1.5·10⁶) emptied 6 mL below `u_vol` would read about +13 mmHg instead of −41 mmHg. Both terms are 0 and flat at `S = 0`, so the curve is smooth there.

**Volume transfer.** The connected resistors call these after computing a flow:

- **`volume_in(dvol)`** adds `dvol` to `vol`, unless `fixed_composition`. Blood and gas subclasses extend it to mix the incoming composition.
- **`volume_out(dvol)`** removes `dvol` from `vol`, unless `fixed_composition`. If that would make `vol` negative, `vol` is set to 0 and the amount that could not be removed is returned. The resistor then delivers only what was really available, so volume is conserved and never created from an empty compartment.

## Factor system

`u_vol`, `el_base` and `el_k` each carry three layers, composed **additively** against the base (see [ARCHITECTURE §7a](./ARCHITECTURE.md#7a-the-factor--effective-value-pattern)). Who writes them in the current code:

| Layer | Writers |
|---|---|
| `_factor` (reset every step) | `Surfactant` (lung `u_vol`/`el_base`); `BloodVessel` and `HeartChamber` internally |
| `_factor_ps` | `Respiration` (`set_el_lung_factor`, thorax elastance, lung `u_vol`); `Heart` (pericardium); the `Calibrator`; the user and scenarios via `setPropValue` |
| `_factor_scaling_ps` | `ModelScaler`; `Uterus` (uterine vessel `u_vol`, pregnancy) |

`BloodVessel` overrides this composition and multiplies its layers (plus the ANS terms); `HeartChamber` adds drug, load and ANS terms. Check those pages before relying on the additive rule for them.

## Inputs and outputs

- **Reads:** nothing from other models; only its own props and `pres_ext`.
- **Written by:**
  - the connected `Resistor`s (`volume_in`/`volume_out`);
  - `Container`s and `Resuscitation` (`pres_ext`);
  - the factor writers above.
- **Read by:** every `Resistor` connected to it (`pres`), `Container`s (`vol`), `Breathing`, `Monitor`, `DataCollector` watchers, and the subclasses.

## Assumptions and limitations

- **Linear below the unstressed volume.** Below `u_vol` the pressure goes negative along the same linear elastance. Real veins collapse there instead, with a small negative pressure and a rising resistance. The model has no collapse behaviour.
- **Lumped compartment.** One pressure per compartment: no wave propagation, no spatial gradients.
- **Explicit volume update.** Pressure is computed from the volume at the start of the step. Very stiff compartments joined by very low resistances can make the explicit step unstable; `Resistor.implicit` handles this for the aorta (see [Resistor](./Resistor.md)).
- **No visco-elasticity.** The wall responds instantly; there is no stress relaxation or hysteresis.

## Example definition (JSON)

No scenario uses a plain `Capacitance`; every compartment is a subclass. These are the props this class contributes, from `term_neonate_72h.json`, `models.PV` (a `BloodVessel`, trimmed to the Capacitance props):

```json
{
  "name": "PV",
  "model_type": "BloodVessel",
  "vol": 0.01035,
  "u_vol": 0.00815,
  "el_base": 4507.3,
  "el_k": 0,
  "fixed_composition": false
}
```

## Usage in the scenarios

Through its subclasses it is every compartment that holds blood or gas: in term_neonate_72h 39 `BloodVessel`s, 10 `GasCapacitance`s and 3 `BloodCapacitance`s. Six of these are `fixed_composition` reservoirs:
- `MOUTH` (room air);
- `VENT_GASIN` and `VENT_GASOUT` (ventilator supply and exhaust);
- `ECLS_GAS_SOURCE` and `ECLS_GAS_OUT` (sweep gas);
- `PL_MAT` (maternal blood).

## References

No literature-derived values in this class: it is the standard lumped-compliance (Windkessel) element. The elastance and unstressed-volume values are scenario parameters, documented with the scenarios ([`TermNeonateReference`](./TermNeonateReference.md) and the other `*Reference.md` pages).

````

### FILE: explain-engine/docs/ChannelReader.md

````markdown
# ChannelReader

`ChannelReader.js` is the **main-thread consumer** of the realtime data plane — the exact mirror of the worker-side [ChannelWriter](./ChannelWriter.md). It is configured once from the worker's `rt_channels` handshake, then read every animation frame by the [RealtimeBus](./RealtimeBus.md): `drainChart()` returns every chart row written since the last drain (in order, no dropped samples), and `readAnim()` returns only the newest anim frame (older frames discarded). It hides the transport choice (`"shared"` vs `"transferable"`) behind one interface, exactly as the writer does. See [RealtimeChannels](./RealtimeChannels.md) for the buffer-layout contract the two ends share, and [ARCHITECTURE](./ARCHITECTURE.md) for the full pipeline.

## Role in the engine

`ChannelReader` is infrastructure, not a physiological model. It is instantiated **only by [RealtimeBus](./RealtimeBus.md)** (`this.reader = new ChannelReader()` in its constructor) and is driven entirely by the bus:

- the bus calls `configure(payload)` on the `RT_MSG.CHANNELS` handshake,
- in transferable mode the bus feeds it `RT_MSG.CHART` / `RT_MSG.ANIM` messages via `onMessage(msg)`,
- the bus's rAF `_tick()` calls `drainChart()` and `readAnim()`.

It has no dependency on Vue, the DOM, or `Model` — it only imports the shared constants from [RealtimeChannels](./RealtimeChannels.md).

## Transports

The active transport is taken from the descriptor at `configure` time (`this.transport = descriptor.transport`):

- **`RT_TRANSPORT.SHARED`** (`"shared"`) — the reader attaches typed-array views over the worker's `SharedArrayBuffer`s and reads them with `Atomics`. The chart ring uses a single-producer/single-consumer write cursor; the anim snapshot uses a seqlock. No per-tick messages are involved — the reader pulls directly from shared memory in the rAF loop.
- **`RT_TRANSPORT.TRANSFERABLE`** (`"transferable"`) — the worker posts one `ArrayBuffer` per flush; the bus hands those messages to `onMessage`, which queues chart rows and coalesces the latest anim frame. The fallback when `SharedArrayBuffer` / cross-origin isolation is unavailable.

## `configure(payload)`

Called on every `RT_MSG.CHANNELS` handshake. Payload shape:

```js
{
  descriptor,                              // ChannelWriter.descriptor() output
  chart: { version, slots },
  anim:  { version, components, layout }   // omitted if no anim channel
}
```

It records `transport` from `descriptor.transport`, then:

- **Chart registry:** `chartVersion = chart.version`, `chartSlots = chart.slots`, `chartStride = descriptor.chart?.stride ?? chartSlots.length`.
- **Anim registry** (only if `payload.anim` present): `animVersion`, `animComponents`, `animLayout`, and `animStride = descriptor.anim?.stride ?? layout?.stride ?? 0`.
- **Drops stale in-flight data:** resets `_chartQueue = []` and `_animPending = null`, so data buffered under a previous layout/version is discarded on reconfigure.
- In **shared** mode calls `_attachShared(descriptor)`.
- If `animStride > 0`, allocates `_animScratch = new Float32Array(animStride)` (the reusable torn-read copy buffer).

`_attachShared(d)` first **nulls any previously attached views** (a reconfigure may drop a channel), then:

- **Chart** (if `d.chart.ctrl` and `d.chart.ring`): wraps `_chartCtrl = new Int32Array(d.chart.ctrl)`, `_chartRing = new Float64Array(d.chart.ring)`, `_chartCapacity = d.chart.capacity`, and seeds `_chartLastRead = Atomics.load(_chartCtrl, CHART_CTRL.WRITE_IDX)` — reading **begins from "now"**, so pre-attach history is not replayed.
- **Anim** (if `d.anim.ctrl` and `d.anim.frames`): wraps `_animCtrl = new Int32Array(d.anim.ctrl)`, `_animFrames = new Float32Array(d.anim.frames)`, and resets `_animLastSeq = -1`.

## Reading: `drainChart()` vs `readAnim()`

The two channels have opposite drop semantics, matching the writer.

### `drainChart()` — no dropped samples

Returns every chart row appended since the last drain, in order, or `null` if nothing is new. Return shape:

```js
{ version, stride, slots, count, rows /* Float64Array, count*stride values */ }
```

It clears `lastChartGap` at entry, then dispatches by transport:

- **Shared (`_drainChartShared`):** loads `w = WRITE_IDX`; returns `null` if `w === _chartLastRead`. Otherwise `count = w - _chartLastRead`. **If `count > capacity` the reader stalled and the writer lapped it** — it keeps only the freshest `capacity` rows (`from = w - cap`) and sets `lastChartGap = true` as an overrun diagnostic. Rows are copied out of the ring with wrap (`(from + k) % cap`), `_chartLastRead` advances to `w`, and `READ_HINT` is published via `Atomics.store(ctrl, CHART_CTRL.READ_HINT, w)` (informational: nothing on the writer side reads it).
- **Transferable (`_drainChartTransferable`):** returns `null` if `_chartQueue` is empty; otherwise concatenates all queued batches into one `Float64Array` (`count` = sum of batch counts), clears the queue, and returns it.

### `readAnim()` — latest frame wins

Returns only the newest anim frame, or `null` if unchanged since the last read. Returns `null` immediately if `animStride === 0`. Return shape:

```js
{ version, stride, components, layout, frame /* Float32Array */ }
```

- **Shared (`_readAnimShared`):** a **seqlock torn-read retry** — it loops reading `SEQ`, then `ACTIVE`, copies the active frame (`active * stride`) into `_animScratch`, and repeats while `SEQ` changed mid-copy. Once a clean copy is obtained, returns `null` if `seq === _animLastSeq` (nothing new); otherwise updates `_animLastSeq` and returns the frame backed by `_animScratch`.
- **Transferable (`_readAnimTransferable`):** returns `null` if `_animPending` is null; otherwise returns the pending frame and clears `_animPending`.

In shared mode the returned `frame` is the reusable `_animScratch` buffer — consumers that retain values across frames must copy.

## `onMessage(msg)`

Handles the transferable transport only — **it is a no-op unless `transport === RT_TRANSPORT.TRANSFERABLE`**.

- **`"rt_chart"`:** **drops the message if `msg.version !== chartVersion`** (stale layout), else pushes `{ version, stride, count, data: new Float64Array(msg.buffer) }` onto `_chartQueue` (drained later by `_drainChartTransferable`).
- **`"rt_anim"`:** drops on version mismatch, else **coalesces** — stores `_animPending = { version, frame: new Float32Array(msg.buffer) }`, overwriting any previous pending frame so only the newest survives.

## Shared constants

The reader uses the control-header indices from [RealtimeChannels](./RealtimeChannels.md):

- **`CHART_CTRL`** — `WRITE_IDX` (0): monotonic total rows written (read via `Atomics.load` in `_drainChartShared`); `READ_HINT` (1): written back via `Atomics.store` (the writer does not read it; there is no stall detection). (`VERSION` (2), `CAPACITY` (3), `STRIDE` (4) are written by the writer and carried in the descriptor; the reader takes capacity/stride from the descriptor rather than the header.)
- **`ANIM_CTRL`** — `ACTIVE` (0): which of the two flip-buffer frames holds the newest data; `SEQ` (1): bumped by 1 after every publish (no odd/even "in progress" coding) — the basis of the torn-read retry in `_readAnimShared`, which re-copies when `SEQ` changed during the copy. (`VERSION` (2), `STRIDE` (3) likewise come from the descriptor.)
- `RT_TRANSPORT.SHARED` / `.TRANSFERABLE` select the read path.

## Notes / caveats

- **Symmetry with the writer.** Every `ChannelReader` path has a [ChannelWriter](./ChannelWriter.md) counterpart: `appendChartRow` ↔ `drainChart`, `writeAnimFrame` ↔ `readAnim`, `flush` ↔ `onMessage`, `descriptor()` ↔ `configure`. The synchronization invariant (writer publishes the cursor/`SEQ` last; reader reads it first) is what makes the lock-free shared paths safe.
- **Begins at "now".** On shared attach, `_chartLastRead` is seeded to the current `WRITE_IDX`, so rows written before the reader attached are intentionally not replayed.
- **Overrun is silent but flagged.** If the main thread stalls long enough for the writer to lap the ring, `drainChart` keeps only the freshest `capacity` rows and sets `lastChartGap = true` for that drain — a gap diagnostic, not an error.
- **Version gating.** Both `onMessage` (transferable) and the registry stored at `configure` reject data from a stale layout. After a reconfigure, queued/pending in-flight data is dropped and shared views are re-attached fresh.
- **Reused scratch buffer.** In shared mode `readAnim` returns `_animScratch`, which is overwritten on the next read; copy out anything you need to keep.

````

### FILE: explain-engine/docs/ChannelWriter.md

```markdown
# ChannelWriter

`ChannelWriter.js` is the **worker-side producer** of the realtime data plane. It writes chart rows and anim frames into the buffers defined by [RealtimeChannels](./RealtimeChannels.md), hiding the choice of transport (`"shared"` vs `"transferable"`) behind one interface so callers never branch on it. It is infrastructure, not a physiological model. It is instantiated once in `ModelEngine.build()` (and reused across `update_diagram`), and the matching consumer — `ChannelReader` — lives on the main thread. See [RealtimeChannels](./RealtimeChannels.md) for the buffer layout contract the two ends share, and [ARCHITECTURE](./ARCHITECTURE.md) for the full pipeline.

## Role in the engine

`ChannelWriter` is the single sink for the realtime fast path:

- The `DataCollector` calls `acquireChartRing()` (via `set_channels`) when the watchlist/layout changes, then `appendChartRow()` for each sample collected during `collect_data()`.
- [AnimationPacker](./AnimationPacker.md) calls `writeAnimFrame()` once per realtime tick (through its `pack_and_write`).
- `ModelEngine._model_step_rt()` calls `flush()` at the end of each tick (a no-op in shared mode).
- `ModelEngine._post_rt_channels()` calls `descriptor()` to build the one-time `RT_MSG.CHANNELS` handshake.

Transport is chosen **once at construction**:

- `"shared"` — `SharedArrayBuffer` + `Atomics` (default when cross-origin isolated). Worker writes, main thread reads in its rAF loop; **no per-tick `postMessage`**.
- `"transferable"` — one `ArrayBuffer` transferred per `flush()` (zero-copy). The fallback when `SharedArrayBuffer` is unavailable.

## Key state

Constructor: `new ChannelWriter(post, opts = {})`

- `post` — the worker's `postMessage` shim, `(msg, transferList?) => void`.
- `opts.transport` — force `"shared"` | `"transferable"`. Defaults to `"shared"` when `sharedMemoryAvailable()`, else `"transferable"`.

| Field | Mode | Description |
|---|---|---|
| `transport` | both | `RT_TRANSPORT.SHARED` or `.TRANSFERABLE`, fixed at construction |
| `_chartStride` | both | Floats per chart row (col 0 = time, then signals) |
| `_chartVersion` | both | Registry version the current chart rows belong to |
| `_chartCapacity` | both | Ring capacity in rows (default `CHART_RING_ROWS` = 8192) |
| `_chartCtrl` | shared | `Int32Array` chart control header (`CHART_CTRL` layout) |
| `_chartRing` | shared | `Float64Array` ring, `capacity * stride` floats |
| `_chartBatch` | transferable | `Float64Array` scratch the tick's rows are appended into |
| `_chartBatchRows` | transferable | Rows pending in the batch |
| `_chartBatchCap` | transferable | Batch capacity in rows (starts at 1024, grows ×2 if full) |
| `_animStride` | both | Floats per anim frame |
| `_animVersion` | both | Anim registry version |
| `_animCtrl` | shared | `Int32Array` anim control header (`ANIM_CTRL` layout) |
| `_animFrames` | shared | `Float32Array` of length `2 * stride` — two flip-buffer frames |
| `_animPending` | transferable | Latest `Float32Array` frame, coalesced until `flush()` |

## Key methods

### `acquireChartRing(stride, version, capacityRows = CHART_RING_ROWS)`

(Re)allocates the chart ring for a new column layout. Called at build and whenever the watchlist changes the number of signals.

- **Shared mode:** allocates a fresh `Int32Array` control header (over a SAB) with `WRITE_IDX`/`READ_HINT` zeroed and `VERSION`/`CAPACITY`/`STRIDE` set, plus a `Float64Array` ring (over a SAB) sized `capacityRows * stride`.
- **Transferable mode:** allocates a `Float64Array` batch of `1024 * stride` floats and resets the pending row count.

### `appendChartRow(values)`

Appends one chart row; `values.length` must equal `stride` (col 0 = time). No-op if `stride === 0`.

- **Shared mode:** reads `WRITE_IDX` with `Atomics.load`, writes the row into slot `(w % capacity) * stride`, then **publishes the new row last** via `Atomics.store(WRITE_IDX, w + 1)` — data is in place before the cursor advances.
- **Transferable mode:** copies the row into the batch at `batchRows * stride` and increments. If the batch is full within one tick (very unlikely), it grows the buffer once (×2) before writing.

### `acquireAnimSnapshot(stride, version)`

(Re)allocates the anim snapshot for a scenario's component layout (`stride` floats per frame, slot 0 = time).

- **Shared mode:** allocates an `Int32Array` control header with `ACTIVE`/`SEQ` zeroed and `VERSION`/`STRIDE` set, plus a `Float32Array` holding two physical frames back-to-back (`2 * stride`).
- **Transferable mode:** clears `_animPending`.

### `writeAnimFrame(values)`

Publishes the latest anim frame; `values.length` must equal anim stride. No-op if `stride === 0`.

- **Shared mode (seqlock):** loads `ACTIVE`, writes into the **inactive** frame (`next = active ^ 1`) at `next * stride`, then `Atomics.store(ACTIVE, next)` to flip, then `Atomics.add(SEQ, 1)` to signal a new publish. The reader uses `SEQ` to detect torn reads.
- **Transferable mode:** coalesces — allocates a fresh frame copy and stores it as `_animPending`; only the most recent frame survives until `flush()`.

### `flush()`

No-op unless transport is `"transferable"`. Otherwise:

- If chart rows are pending, copies exactly the used rows into a fresh `Float64Array` and posts `{ type: RT_MSG.CHART, version, stride, count, buffer }` transferring `buffer`; resets the pending count.
- If an anim frame is pending, posts `{ type: RT_MSG.ANIM, version, stride, buffer }` transferring its buffer; clears `_animPending`.

### `descriptor()`

Returns the transport descriptor merged by `ModelEngine` into the `RT_MSG.CHANNELS` handshake. Always carries `transport` plus `chart`/`anim` `{ stride, version }`. In shared mode it additionally exposes the underlying `SharedArrayBuffer`s (`chart.ctrl`, `chart.ring`, `chart.capacity`, `anim.ctrl`, `anim.frames`) for the reader to attach to — structured clone shares (does not copy) SABs across the worker boundary.

## Protocol / layout

The ring-buffer indices and frame layout are owned by [RealtimeChannels](./RealtimeChannels.md). In brief:

- **Chart ring** is single-producer/single-consumer with a monotonic `WRITE_IDX`; the physical slot is `WRITE_IDX % capacity`. Writing data **before** advancing the cursor (and the reader reading the cursor before the data) is the synchronization invariant.
- **Anim frames** use a flip buffer with a sequence counter: write inactive frame → flip `ACTIVE` → bump `SEQ` by 1. `SEQ` is not odd/even-coded (there is no "write in progress" marker); the reader retries if `SEQ` changed during its copy, which catches a flip (and a rewrite of the frame it was copying) mid-read.
- **`READ_HINT`** is written by the reader only (the last `WRITE_IDX` it drained). The writer never reads it and never blocks on a slow reader; a lapped reader recovers on its side (freshest `capacity` rows, `lastChartGap`).
- Both control headers carry a `VERSION` so a reader holding a stale registry rejects mismatched data after a layout change.

## Notes / caveats

- **One transport for the writer's lifetime.** It is decided at construction by `sharedMemoryAvailable()` (or `opts.transport`) and never switches. Reallocations (`acquireChartRing`/`acquireAnimSnapshot`) keep the same transport.
- **`flush()` is shared-mode-free.** In shared mode the reader pulls directly from the SABs in its rAF loop, so `flush()` returns immediately and no per-tick messages are sent. Calling it every tick (as `ModelEngine` does) is correct and cheap.
- **SharedArrayBuffer fallback.** When the page is not cross-origin isolated (no COOP/COEP), `SharedArrayBuffer` is unavailable and the writer transparently uses `"transferable"`: a copied-and-transferred `ArrayBuffer` per flush. Functionally identical to the consumer; only the per-tick cost differs.
- **Publish ordering matters.** In shared mode, `appendChartRow` stores the row data before bumping `WRITE_IDX`, and `writeAnimFrame` flips `ACTIVE`/`SEQ` after the frame is written. Reordering these would expose torn reads to the main thread.

```

### FILE: explain-engine/docs/Circulation.md

````markdown
# Circulation

`Circulation` is the coordinator of the blood vessels. It holds no blood itself. It groups the vessels by anatomical class, passes the autonomic vascular tone and the system-wide resistance settings (SVR, PVR) on to them, and reports how the blood volume is distributed. It also owns the circulation's vessels and connectors as sub-models.

## Physiology

Blood pressure and organ flow are set largely by the tone of the small arteries and arterioles, and venous return by the tone of the veins. Several things change that tone at once:
- **Sympathetic nervous system:** the baroreflex constricts the vessels when pressure falls.
- **Hormones:** angiotensin II and vasopressin constrict them.
- **Drugs:** e.g. noradrenaline through α1 receptors.
- **The clinician:** a vasodilator or vasopressor, or pulmonary vasodilators such as inhaled NO.

Circulation applies each of these to the right vessel class: the systemic or pulmonary arterioles for resistance (SVR, PVR), and the venules for venous resistance. It also reports where the blood is (systemic, pulmonary, heart), the way a clinician thinks of blood volume distribution.

## Inheritance

```
BaseModelClass
  └── Circulation
```

## Properties

### Config: groups (names of models)

| Property | Default | Description |
|---|---|---|
| `heart_chambers` | `[]` | Heart chambers, for the volume report. |
| `coronaries` | `[]` | Coronary bed, counted in the systemic volume. |
| `systemic_arteries`, `systemic_arterioles`, `systemic_capillaries`, `systemic_venules`, `systemic_veins` | `[]` | Systemic vessels by class. The arterioles are the SVR site, the venules the venous resistance site. |
| `pulmonary_arteries`, `pulmonary_arterioles`, `pulmonary_capillaries`, `pulmonary_venules`, `pulmonary_veins` | `[]` | Pulmonary vessels by class. The arterioles are the PVR site. |

### Config: resistance channels

Each channel is a multiplier around 1, applied to its vessel group. A change is added as a delta to the vessels' `r_factor_ps` (see [Calculation](#calculation)).

| Property | Default | Vessels | Owner |
|---|---|---|---|
| `svr_factor_art` | 1.0 | systemic arterioles | the user / scenario |
| `svr_factor_ven` | 1.0 | systemic venules | the user / scenario |
| `pvr_factor_art` | 1.0 | pulmonary arterioles | the user / scenario |
| `pvr_factor_ven` | 1.0 | pulmonary venules | the user / scenario |
| `svr_factor_drug` | 1.0 | systemic arterioles | `Drugs` (α1 vasoconstriction) |
| `svr_factor_hormones_art` | 1.0 | systemic arterioles | `Hormones` (angiotensin II, ADH) |
| `svr_factor_hormones_ven` | 1.0 | systemic venules | `Hormones` (angiotensin II) |

### Set by other models

| Property | Default | Written by |
|---|---|---|
| `ans_activity` | 1.0 | The `EF_SVR` efferent (baroreflex/chemoreflex vascular tone); passed to every vessel in the groups. |

### Outputs

| Property | Unit | Description |
|---|---|---|
| `total_blood_volume` | L | Systemic + pulmonary + heart volume (every 1 s). |
| `syst_blood_volume`, `pulm_blood_volume`, `heart_blood_volume` | L | Volumes per part; systemic includes the coronaries. Disabled vessels (placenta, ECLS) are not counted. |
| `syst_blood_volume_perc`, `pulm_blood_volume_perc`, `heart_blood_volume_perc` | % | Shares of the total (0 while the total is 0). |

### Internal state (public names, saved with the state)

| Property | Description |
|---|---|
| `prev_ans_activity`, `prev_svr_factor_art`, `prev_svr_factor_ven`, `prev_svr_factor_drug`, `prev_svr_factor_hormones_art`, `prev_svr_factor_hormones_ven`, `prev_pvr_factor_art`, `prev_pvr_factor_ven` | The values last applied; a difference triggers the update. `prev_ans_activity` starts at 0, so the first update always pushes `ans_activity`. |

## Calculation

`calc_model()` runs two throttled loops.

**Every 15 ms**, only for inputs that changed since the last tick:
- `ans_activity` → written onto every vessel in the groups (each `BloodVessel` applies it through its `ans_sens`, see [BloodVessel](./BloodVessel.md)).
- Each resistance channel → its change is added to the persistent factor of every vessel in its group:
  ```
  delta = new_value − prev_value
  r_factor_ps += delta        (each vessel of the group, clamped at 0)
  ```
  The user, Drugs and Hormones channels all add into the same `r_factor_ps`, together with anything else that writes it (scenario tuning, the `Calibrator`). Because they add, simultaneous channels combine additively: SVR ×2 plus a drug ×2 gives ×3, not ×4. The vessel's other layers (scaling, ANS, viscosity) then multiply on top.

**Every 1 s:** `calc_blood_volumes()` sums the enabled vessels and chambers into the volume outputs.

## Factor system

None of its own; it writes `BloodVessel.r_factor_ps` (see [BloodVessel → Factor system](./BloodVessel.md#factor-system)). Through the α-coupling, every resistance channel also stiffens the vessels it acts on.

## Inputs and outputs

- **Reads:** the vessels' and chambers' volumes (volume report).
- **Writes:** `ans_activity` and `r_factor_ps` of the vessels in its groups.
- **Written by:**
  - `EF_SVR` (`ans_activity`);
  - `Drugs` (`svr_factor_drug`), `Hormones` (`svr_factor_hormones_*`);
  - the user and scenarios (`svr_factor_art/_ven`, `pvr_factor_art/_ven`).

  The UI's SVR and PVR common tasks use `ModelScaler`'s resistance groups instead (the scaling layer).
- **Read by:** `Monitor` and `DataCollector` watchers (volume report).

## Assumptions and limitations

- **One autonomic signal for all vessels.** Regional differences come only from each vessel's `ans_sens`.
- **Channels add.** See [Calculation](#calculation). The clamp at 0 makes a channel irreversible past it: a delta that hits 0 is partly lost.
- **Membership is by name.** Only vessel names belong in the groups (a resistor name is skipped). `RUB`/`RLB` (the lumped upper and lower body, 36 % of systemic organ flow at term) belong in `systemic_arterioles`.
- **Renal autoregulation acts on the inflow connector.** `Kidneys` adjusts `AD_KID_ART` (the renal arteriole's inflow resistor), so KID_ART receives the systemic channels like the other arterioles and autoregulation counters them on top. Before this, an absolute write to KID_ART erased every SVR change there.

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Circulation` (trimmed; `components` holds the vessels and connectors):

```json
{
  "name": "Circulation",
  "model_type": "Circulation",
  "is_enabled": true,
  "heart_chambers": ["LA", "RAIVCI", "RASVC", "RV", "LV"],
  "coronaries": ["COR"],
  "systemic_arteries": ["AA", "AAR", "AD"],
  "systemic_arterioles": ["INT_ART", "KID_ART", "LS_ART", "BR_ART", "RUB", "RLB"],
  "systemic_capillaries": ["INT_CAP", "KID_CAP", "LS_CAP", "BR_CAP"],
  "systemic_venules": ["INT_VEN", "KID_VEN", "LS_VEN", "BR_VEN"],
  "systemic_veins": ["IVCI", "SVC", "VLB", "VUB"],
  "pulmonary_arteries": ["PA", "PAAL", "PAAR"],
  "pulmonary_arterioles": ["LL_ART", "RL_ART"],
  "pulmonary_capillaries": ["LL_CAP", "RL_CAP"],
  "pulmonary_venules": ["LL_VEN", "RL_VEN"],
  "pulmonary_veins": ["PV"],
  "svr_factor_art": 1,
  "svr_factor_ven": 1,
  "pvr_factor_art": 1,
  "pvr_factor_ven": 1
}
```

## Usage in the scenarios

One instance in every scenario. Its `components` are the 31 circulation vessels and 3 free resistors (`PV_LA`, `IVCI_RAIVCI`, `SVC_RASVC`); the vessels' own inflow connectors are created by the vessels. At rest the term blood volume is 286 mL: 81 % systemic, 11 % pulmonary, 8 % in the heart. The placenta (`Placenta`) and ECLS (`Ecls`) vessels belong to their own owners and are not in the groups.

## References

No literature-derived values: the groups and channels are model structure.

````

### FILE: explain-engine/docs/Container.md

````markdown
# Container

A `Container` is an elastic compartment that encloses other compartments. Its volume is the sum of what it contains, and its pressure is added to the outside pressure of every compartment inside it. The model uses it for the thorax and the pericardium.

## Physiology

The heart and lungs don't sit in open space. The lungs, the great vessels and the heart sit inside the chest (the *thorax*), and the heart sits inside its own sac (the *pericardium*). The pressure in these spaces acts on everything inside:

- **Thorax.** When the breathing muscles contract, the pressure in the chest falls below atmospheric. That suction expands the lungs and draws blood into the intrathoracic veins and the right heart. Chest compressions and positive-pressure ventilation raise the same pressure.
- **Pericardium.** At normal filling the pericardium is slack and doesn't squeeze the heart. Once the heart (or fluid in the sac) fills it beyond its reserve, the sac becomes very stiff very quickly (a J-shaped pressure–volume curve). It then limits filling of all four chambers together. That is the mechanism of **cardiac tamponade** and pericardial constraint.

Containers nest: the pericardium sits inside the thorax, so a fall in chest pressure reaches the heart chambers through both.

## Inheritance

```
BaseModelClass
  └── Container
```

`Container` extends `BaseModelClass` directly, not `Capacitance`. It repeats the `u_vol`/`el_base`/`el_k` elastance machinery and factor layers, but it holds no fluid, so nothing flows into or out of it.

## Properties

### Config (set in the definition JSON)

| Property | Unit | Default | Description |
|---|---|---|---|
| `u_vol` | L | 0.0 | Unstressed volume: below it the container exerts no recoil. For the pericardium this is the reserve volume. |
| `el_base` | mmHg/L | 0.0 | Linear elastance. |
| `el_k` | mmHg/L² | 0.0 | Non-linear elastance; acts only above `u_vol`. Volumes are in litres, so 10 mL of stretch is 0.01 L and `el_k` = 10⁵ gives 10 mmHg. |
| `vol_extra` | L | 0.0 | Volume added to the contained sum, e.g. pericardial fluid (written by `Heart` from `pc_extra_volume`). |
| `contained_components` | string[] | `[]` | Names of the enclosed models. |
| `u_vol_factor`, `el_base_factor`, `el_k_factor` | – | 1.0 | Non-persistent factors, reset to 1 every step. |
| `u_vol_factor_ps`, `el_base_factor_ps`, `el_k_factor_ps` | – | 1.0 | Persistent factors. |
| `u_vol_factor_scaling_ps`, `el_base_factor_scaling_ps`, `el_k_factor_scaling_ps` | – | 1.0 | Persistent scaling factors (`ModelScaler`). |

### Outputs

| Property | Unit | Default | Description |
|---|---|---|---|
| `vol` | L | 0.0 | `vol_extra` + the volumes of the enabled contained models. |
| `pres_in` | mmHg | 0.0 | Recoil pressure of the container wall. |
| `pres` | mmHg | 0.0 | `pres_in + pres_ext`: the pressure passed to the contents. |
| `el_eff`, `el_k_eff`, `u_vol_eff` | as above | 0.0 | Effective values after the factor layers. |

### Set by other models

| Property | Unit | Default | Description |
|---|---|---|---|
| `pres_ext` | mmHg | 0.0 | External pressure for this step, reset to 0 after use. Written by: `Breathing` (muscle pressure, subtracted from THORAX), `Resuscitation` (chest compressions, added to THORAX), the THORAX on the PERICARDIUM (its own `pres`). |

## Calculation

`calc_model()` runs `calc_elastances()` → `calc_volumes()` → `calc_pressure()`.

1. **`calc_elastances`**: `el_eff` and `el_k_eff` from the base value and the three factor layers, composed additively (see [Factor system](#factor-system)). Then the non-persistent factors are reset.
2. **`calc_volumes`**:

   ```
   vol       = vol_extra + Σ vol of the contained models that exist and are enabled
   u_vol_eff = u_vol · (additive factor layers)
   ```

3. **`calc_pressure`**, with `S = vol − u_vol_eff`:

   ```
   pres_in = (S > 0 ? el_k_eff · S² : 0) + el_eff · S
   pres    = pres_in + pres_ext
   for every contained model that exists and is enabled:  model.pres_ext += pres
   pres_ext = 0
   ```

   The non-linear term only acts on a stretched container, because `S²` is also positive below `u_vol`, where it would push the wrong way: a slack pericardium must not squeeze an under-filled heart. The contained models add their `pres_ext` to their own pressure and reset it in their own `calc_pressure`, so the contributions don't accumulate.

**Step order and lag.** Each model steps once per step, in insertion order (see [BaseModelClass](./BaseModelClass.md#composite-models-components)). In the shipped scenarios the order is: `Breathing` → heart chambers → `PERICARDIUM` → lungs and vessels → `THORAX`. So:
- the lungs and intrathoracic vessels feel the thorax pressure **one step** late;
- the heart chambers feel it **two steps** late (through the pericardium);
- the chambers feel the pericardial pressure one step late.

At the 0.5 ms step size this is 0.5–1 ms, negligible against a 400 ms heartbeat.

## Factor system

`u_vol`, `el_base` and `el_k` carry the three layers (`_factor`, `_factor_ps`, `_factor_scaling_ps`) and compose **additively**, as in [`Capacitance`](./Capacitance.md):

```
p_eff = p + (factor − 1)·p + (factor_ps − 1)·p + (factor_scaling_ps − 1)·p
```

The only model that writes a factor is `Heart`: its `pc_el_factor` (pericardial stiffness) moves `PERICARDIUM.el_base_factor_ps` and `el_k_factor_ps` together. See [ARCHITECTURE §7a](./ARCHITECTURE.md#7a-the-factor--effective-value-pattern).

## Inputs and outputs

- **Reads:** `vol` and `is_enabled` of each contained model.
- **Writes:** `pres_ext` of each contained model, every step.
- **Written by:**
  - `Breathing` and `Resuscitation` (THORAX `pres_ext`);
  - `Heart` (PERICARDIUM `vol_extra` from `pc_extra_volume`, and the stiffness factors from `pc_el_factor`);
  - `ModelScaler` (scaling factors).
- **Read by:** `Breathing` (THORAX elastance, to size the respiratory effort), `DataCollector` watchers.

## Assumptions and limitations

- **Uniform pressure.** The whole container has one pressure. Regional differences (e.g. pleural pressure gradients from apex to base) aren't modelled.
- **Membership is by name.** Missing or disabled members are skipped for both the volume and the pressure. Skipping disabled members also stops a disabled compartment, which never resets its `pres_ext`, from accumulating pressure.
- **Pericardium calibration** (`scripts/_fix_pericardium.mjs`):
  - `u_vol` is 1.15 × the maximal (end-diastolic) heart volume at rest, so the pericardium is slack at rest (term: 30.7 mL in it against 35.2 mL).
  - `el_k` gives +10 mmHg at 10 mL beyond that reserve (10⁵ mmHg/L²).
  - `el_base` is 0.
  - So `pc_el_factor` has no effect at rest and only acts once the pericardium is stretched (e.g. by `pc_extra_volume`).
- **The pericardial wall scales with the heart.** `el_k` = 10⁵ mmHg/L² × (35.2 mL / reserve)² (`scripts/_scale_pericardium.mjs`), so every scenario gets the same pressure for the same fractional stretch beyond its reserve: from 10⁵ at term to 2.6·10⁶ at 25 weeks. An effusion of 50 % of the reserve lowers LVO by 10 % at term and 6–7 % at 25–28 weeks.
- **The thorax elastance** (`el_base` 50 mmHg/L term, 150 at 25 weeks) represents the chest wall. Its `u_vol` and `el_base` are scenario-calibrated values.

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Heart.components.PERICARDIUM` (trimmed to the config props):

```json
{
  "name": "PERICARDIUM",
  "model_type": "Container",
  "is_enabled": true,
  "u_vol": 0.03525,
  "el_base": 0,
  "el_k": 100000,
  "vol_extra": 0,
  "contained_components": ["RAIVCI", "RASVC", "RV", "LA", "LV", "COR"]
}
```

## Usage in the scenarios

term_neonate_72h has two containers:

| Instance | Owner | Contains | Role |
|---|---|---|---|
| `THORAX` | `Respiration` | `ALL`, `ALR` (lungs), `PERICARDIUM`, `AA`, `AAR`, `PA`, `PAAL`, `PAAR`, `PV`, `IVCI`, `SVC`, lung arteries/capillaries/veins (`LL_*`, `RL_*`) | Chest wall and pleural pressure; target of the breathing muscles and of chest compressions. |
| `PERICARDIUM` | `Heart` | `RAIVCI`, `RASVC`, `RV`, `LA`, `LV`, `COR` | Pericardial constraint and tamponade. |

## References

No literature-derived values in this class. The pericardial reserve and wall stiffness are calibration choices documented in `scripts/_fix_pericardium.mjs`.

````

### FILE: explain-engine/docs/DataCollector.md

````markdown
# DataCollector

`DataCollector` (class `Datacollector`, `explain/helpers/DataCollector.js`) is **engine infrastructure, not a physiological model**. It is the engine's sampling/telemetry helper: it watches named model properties at two fixed rates and buffers their values so the main thread can pull time-series rows for charts and numeric read-outs. It is instantiated once per build in the Web Worker — `ModelEngine.build()` does `model["DataCollector"] = new DataCollector(model)` — and lives on the engine `model` object alongside `TaskScheduler` and `ModelScaler`. See [ARCHITECTURE](./ARCHITECTURE.md) for the two-thread picture and [TaskScheduler](./TaskScheduler.md) for the sibling mutation helper.

## Role in the engine

The collector sits inside the per-step loop. After every model has stepped, `_model_step()` calls:

```js
_get_data_collector()?.collect_data(model.model_time_total);
```

`collect_data(model_clock)` is therefore invoked on **every** model step, but it only actually samples when its internal interval counters have elapsed (see below). It does not advance the clock itself — it is handed `model.model_time_total`.

Who calls what, and when:

| Caller (in `ModelEngine.js`) | Method | When |
|---|---|---|
| `_model_step()` | `collect_data(model_clock)` | every step |
| `get_model_data()` / `_get_model_data_rt()` | `get_model_data()` | when the fast buffer is drained to the main thread |
| `get_model_data_slow()` / `_get_model_data_rt_slow()` | `get_model_data_slow()` | when the slow buffer is drained |
| `watch_props(args)` | `add_to_watchlist(prop)` | client subscribes a fast property |
| `watch_props_slow(args)` | `add_to_watchlist_slow(prop)` | client subscribes a slow property |
| `clear_watchlist()` / `clear_watchlist_slow()` | `clear_watchlist()` / `clear_watchlist_slow()` | client resets a watchlist |
| `calculate()` (at its end) | `clean_up()` / `clean_up_slow()` | drop entries whose model no longer exists |
| `build()` | `set_channels(writer, on_registry)` | wire the realtime typed transport |

The realtime loop flips `model.DataCollector.rt_active = true` on `start()` and back to `false` on `stop()`.

## Key state

| Field | Default | Meaning |
|---|---|---|
| `model` | — | back-reference to the engine `model` object |
| `watch_list` | `[ncc_atrial, ncc_ventricular]` | **fast** watch entries (resolved descriptors) |
| `watch_list_labels` | Set | dot-path labels already on the fast list (dedupe) |
| `watch_list_slow` | `[]` | **slow** watch entries |
| `watch_list_slow_labels` | Set | dedupe set for the slow list |
| `sample_interval` | `0.005` s | fast sampling period |
| `sample_interval_slow` | `1.0` s | slow sampling period |
| `_interval_counter` / `_interval_counter_slow` | `0` | accumulators, advanced by `modeling_stepsize` each call; on a sample the interval is subtracted (the remainder carries over, so the sampling does not drift) |
| `modeling_stepsize` | from `model` | step increment used to drive the counters |
| `collected_data` | `[]` | fast buffer (array of `{time, label: value, …}`) |
| `collected_data_slow` | `[]` | slow buffer |
| `legacy_mode` | `true` | when `true`, fast stream goes to `collected_data`; `set_channels()` sets it `false` to use the typed ring |
| `rt_active` | `false` | the typed ring is only written while the realtime loop runs |
| `_channels` / `_on_chart_registry` | `null` | non-enumerable (must not be structure-cloned with the model graph) |
| `registry_version`, `chart_slots`, `_chart_row` | — | typed-transport slot map / reusable Float64 scratch row |

On the typed path every slot is a number: a boolean prop is written as 1 / 0 (so a flag such as `Ventilator.triggered_breath` can drive a renderer), and any other non-number as 0.

The two ECG entries (`ncc_atrial`, `ncc_ventricular`) are constructed in the constructor and pushed onto `watch_list` immediately — see [Notes](#notes--caveats).

## Key methods

| Signature | What it does |
|---|---|
| `collect_data(model_clock)` | Samples each watchlist when its interval counter has reached the sample interval, subtracts the interval from that counter (carrying the remainder; a counter still above a shortened interval restarts at 0), appends one row (or writes one Float64 ring row), then advances both counters by `modeling_stepsize`. Disabled models contribute `0` (typed path) or are left out of the row (object paths, fast and slow). |
| `add_to_watchlist(properties)` | Clears `collected_data`, resolves each string dot-path via `_find_model_prop`, appends new (non-duplicate) entries to `watch_list`. Returns `false` if any path failed to resolve. Rebuilds the chart index when not in legacy mode. |
| `add_to_watchlist_slow(properties)` | Same as above for `watch_list_slow` / `collected_data_slow`. |
| `get_model_data()` | Returns `collected_data` and **replaces it with `[]`** (drain-and-clear). |
| `get_model_data_slow()` | Drain-and-clear for the slow buffer. |
| `clear_data()` / `clear_data_slow()` | Empty a buffer without touching watchlists. |
| `clear_watchlist()` | Empties the fast watchlist, then re-adds the two always-present ECG entries; rebuilds the chart index. |
| `clear_watchlist_slow()` | Empties the slow watchlist (no always-present entries). |
| `clean_up()` | Drops `watch_list` entries whose model no longer exists in `model.models` (the same instance); a disabled model keeps its watch. Rebuilds the labels set and chart index only when something was dropped. |
| `clean_up_slow()` | Same for the slow watchlist. |
| `set_sample_interval(v=0.005)` / `set_sample_interval_slow(v=1.0)` | Change a sampling period. |
| `set_channels(writer, on_registry)` | Attach the realtime typed transport, set `legacy_mode = false`, build the initial chart slot index. |
| `_exists(item)` *(private)* | True while the item's model is still the instance in `model.models` (used by `clean_up`). |
| `_add_ecg_watches()` *(private)* | Adds the two `Heart.ncc_*` watches when the model has a `Heart`. |
| `_find_model_prop(prop)` *(private)* | Resolves a dot-path against `model.models` (see below). Returns a descriptor or `null`. |
| `_rebuild_chart_index()` *(private)* | Re-derives `chart_slots`, bumps `registry_version`, reallocates the ring, re-fires the registry callback. No-op without an attached writer. |

### How dot-paths resolve

Watched properties are strings of the form `"Model.prop"` or `"Model.prop.subprop"`, resolved against `model.models` by `_find_model_prop`:

- **Two segments** (`"Heart.ncc_ventricular"`): requires `t[0] in model.models` and `t[1] in model.models[t[0]]`. Returns `{label, model, prop1, prop2: null}`.
- **Three segments** (`"AA.solutes.lact"`): requires the model and `prop1` to exist; `prop2` is **not** verified at resolve time. Returns `{label, model, prop1, prop2}`. At sample time the value is read as `model[prop1][prop2] || 0`.
- Anything that fails these checks returns `null`, and the corresponding `add_to_watchlist*` call reports failure.

## Interaction with models

The collector reaches into live model instances purely by property read — it never mutates them. Each watch entry stores a direct `model` reference (the resolved component) plus `prop1`/`prop2`; at sample time it reads `parameter.model[parameter.prop1]` (optionally `[parameter.prop2]`). Disabled components are not sampled on the object paths (their key is omitted from the row); on the typed path their slot is written as `0` so column alignment is preserved across the fixed-stride ring row.

This is the read side of the model contract; the write side (deferred mutation of `*_factor_ps` / base params) belongs to [TaskScheduler](./TaskScheduler.md).

## Notes / caveats

- **ECG counters are always watched.** The constructor pushes `Heart.ncc_atrial` and `Heart.ncc_ventricular` onto `watch_list` regardless of any user watchlist, and `clear_watchlist()` re-adds them. ECG reconstruction therefore always has its source data even when the client subscribed to nothing. These two entries resolve `model.models["Heart"]` at construction time; a build without a `Heart` simply has no ECG watches (it used to fail in `collect_data`).
- **`get_model_data*` is destructive.** It returns the buffer and immediately resets it to `[]`. Call it once per drain; a second call returns nothing until more is collected.
- **`clean_up()` drops only watches whose model is gone.** It runs after every `calculate()` and removes entries whose model is no longer the instance in `model.models` (e.g. after a rebuild), re-firing the chart-index rebuild in typed mode when it drops something. A merely **disabled** model keeps its watch: while it is off the typed path writes `0`, the object paths omit its key and the slow path skips it, so a model switched back on (ventilator, ECLS) is charted again, and the forced `Heart.ncc_*` watches can never be dropped.
- **Two divergent collection paths.** With a `ChannelWriter` attached and `rt_active` true, the fast stream is packed into a Float64 ring (no per-sample object allocation). Offline `calculate()` and legacy mode keep using `collected_data`, so `get_model_data()` still returns rows. Slow data always uses the object buffer.
- **`_channels` / `_on_chart_registry` are non-enumerable** on purpose: `get_model_state` posts the whole model graph (which reaches the collector through every component's `_model_engine` back-reference), and these function-bearing fields must not be structure-cloned.
- **The first sample comes one interval in:** the counters start at 0, so a 1 s calculation from build yields ~199 fast rows and the first slow row only after the next step.
- **Buffers grow until drained.** `calculate()` drains them at its end and posts them as `data` / `data_slow` messages; a caller that steps the engine without draining keeps every row.
- **Time is rounded** to 4 decimals (`Math.round(model_clock * 10000) / 10000`) before being stored.

````

### FILE: explain-engine/docs/Drugs.md

````markdown
# Drugs

`Drugs` is the pharmacology controller (PK/PD).
- **Dosing:** IV boluses and weight-based infusions add drug to a central vein.
- **Transport:** the drug spreads with the blood through every compartment's `drugs` dictionary.
- **Elimination:** a whole-body term everywhere plus organ clearance in the kidney, liver and gut capillaries.
- **Effects:** each drug acts on heart rate, contractility, relaxation, vascular resistance and ductal patency through sigmoid Emax curves, summed over the drugs.

It holds no blood. With no drug present it does nothing and its effects sit at 1.

## Physiology

An IV drug mixes into the central venous blood, reaches the heart and arterial tree within seconds, and is cleared by metabolism, mostly in the liver, kidney and the vessel walls. The plasma concentration settles where the infusion rate equals clearance; its half-life sets how fast it rises and falls.

The effect follows the concentration at the receptor along a sigmoid dose–response curve (Emax, EC50, Hill slope):
- **Adrenaline:** β1 (heart rate, contractility, faster relaxation) at low doses, plus α1 vasoconstriction at higher ones.
- **Noradrenaline:** mainly α1 vasoconstriction.
- **Prostaglandin E1:** keeps the ductus arteriosus open in duct-dependent heart disease. It is cleared largely in one pass through the lungs, hence the continuous infusion.

## Inheritance

```
BaseModelClass
  └── Drugs
```

## Properties

### Config (set in the definition JSON)

| Property | Unit | Default | Description |
|---|---|---|---|
| `drugs_running` | boolean | `true` | Effect switch (off releases the effects once; clearance keeps running). |
| `injection_site` | – | `"IVCI"` | Compartment receiving boluses and infusions. |
| `effect_site` | – | `"AA"` | Compartment whose concentration drives the effects. |
| `heart_name`, `circulation_name` | – | `"Heart"`, `"Circulation"` | Effect targets. |
| `drug_defs` | {drug: definition} | 3 drugs | Per-drug PK/PD (below). Built-in drugs a scenario lacks, and parameters a stored definition predates, are filled in from the code at build. |
| `infusions` | {drug: mcg/kg/min} | `{}` | Running infusions (saved with the state). |

**A drug definition:**
- `enabled`;
- `clearance.global`: 1/s, on every compartment;
- `clearance.sites`: {compartment: 1/s}, organ clearance;
- `ke0`: 1/s, effect-compartment rate; 0 = none;
- per effect `x` (`hr`, `cont`, `lus`, `svr`, `pda`): `x_emax` (maximal fractional change), `x_ec50` (ng/mL) and `x_hill`.

| Drug | Clearance global / sites (1/s) | HR | Inotropy | Lusitropy | SVR | Duct |
|---|---|---|---|---|---|---|
| adrenaline | 0.00383 / KID 0.104, LS 0.157, INT 0.070 | +0.9 @ 5.7 | +2.4 @ 18 | −0.75 @ 18 | +1.5 @ 18 | – |
| noradrenaline | 0.0036 / KID 0.12, LS 0.2, INT 0.08 | +0.2 @ 5.7 | +0.56 @ 18 | −0.19 @ 18 | +1.44 @ 18 | – |
| pge1 | 0.08 / – | – | – | – | – | +1.5 @ 0.02 |

(emax @ EC50 in ng/mL; Hill 1 throughout.)

### Outputs

| Property | Unit | Description |
|---|---|---|
| `concentrations` | {drug: ng/mL} | Effect-site concentration. |
| `biophase` | {drug: ng/mL} | The concentration driving the effect (the effect compartment when `ke0` > 0). |
| `conc_inj`, `conc_eff` | ng/mL | Adrenaline at the injection and effect sites (convenience read-outs). |
| `hr_drug_factor`, `cont_drug_factor`, `lus_drug_factor`, `svr_drug_factor`, `pda_drug_factor` | – | Summed effects (1 = none). |

## Calculation

Each step (ng/mL = mcg/L throughout):
1. **Idle check.** With no infusion and no drug in the blood, nothing is computed (the blood is re-scanned every 1 s, since drug can also arrive another way).
2. **Infusions:** `rate · weight / 60 · dt` mcg into the injection site.
3. **Elimination** (also while `drugs_running` is off): every compartment loses `clearance.global · c · dt`; the clearing organs lose their site rate as well. That organ clearance depends on how much drug the perfusion brings, so it falls with organ blood flow. Values below 1e-6 ng/mL are zeroed.
4. **Effects** (while running), per enabled drug, from the effect-site concentration (lagged by `ke0` when set):
   ```
   effect = emax · cⁿ / (EC50ⁿ + cⁿ),     factor = 1 + Σ over drugs
   ```
   - `Heart.hr_drug_factor`;
   - each chamber's `el_max_drug_factor` (inotropy) and `el_min_drug_factor` (lusitropy; < 1 = faster relaxation);
   - `Circulation.svr_factor_drug` (its own SVR channel, see [Circulation](./Circulation.md));
   - `Pda.diameter_drug_factor`.

**Dosing API:**
- `administer_bolus(drug, dose_mcg)`: adds `dose / volume` to the injection site;
- `set_infusion(drug, rate)`: mcg/kg/min, 0 stops it;
- `set_drug_param(drug, "path", value)`: e.g. `"hr_emax"`, `"clearance.global"`.

## Factor system

It owns the drug channels above: `hr_drug_factor`, `el_max_drug_factor`, `el_min_drug_factor`, `svr_factor_drug` and `diameter_drug_factor`. Effects of several drugs add.

## Inputs and outputs

- **Reads:** the compartments' `drugs`; `model.weight`.
- **Writes:** the compartments' `drugs` (seeded with every drug key, dosing, clearance); the channels above.
- **Written by:** the user and bot (dosing, parameters).
- **Read by:** Heart, the chambers, Circulation, Pda (the channels); `DataCollector` watchers.

## Assumptions and limitations

- **Catecholamine calibration** (re-validation (j), term_neonate_72h, 20-min infusions, closed loop with the reflexes):

  | Infusion (mcg/kg/min) | Arterial conc (ng/mL) | HR | MAP | LV output |
  |---|---|---|---|---|
  | adrenaline 0.05 / 0.1 / 0.3 | 2.0 / 4.0 / 11.8 | +11 / +16 / +24 % | +14 / +24 / +42 % | +15 / +25 / +45 % |
  | adrenaline 0.6 / 1.0 | 23.6 / 39.2 | +28 / +31 % | +54 / +62 % | +53 / +58 % |
  | noradrenaline 0.1 / 0.3 / 0.5 / 1.0 | 4.0 / 12.0 / 20.1 / 40.2 | 0 / −3 / −5 / −8 % | +9 / +18 / +22 / +28 % | +2 / +4 / +3 / +5 % |

  - **Clearance** 25 mL/kg/min for both, so the arterial half-life after stopping is ~2.2 min (130 s): Oualha 2014 (2 L/h·kg^0.75, i.e. 24 mL/kg/min at 3.5 kg, volume = blood volume, t½ ~2.3 min), Fisher 1993 (29 ± 16 mL/kg/min; 0.03–0.2 mcg/kg/min gave 0.67–9.4 ng/mL). Before: 116 mL/kg/min and t½ 20 s, so 0.1 mcg/kg/min reached only 0.9 ng/mL.
  - **Adrenaline** EC50s from Oualha 2014 (heart rate 5.7 ng/mL; the stroke volume × SVR product 18 ng/mL, used here for inotropy, lusitropy and SVR), Emax values fitted so the closed-loop response matches that study's model: 0.1 mcg/kg/min HR +15 %, MAP +24 %; up to 1.0 mcg/kg/min within a few percent of it. Before, the EC50s were 20–40 ng/mL and 0.5 mcg/kg/min raised HR by 5 bpm.
  - **Noradrenaline**: no neonatal PK/PD data. Clearance as adrenaline; mainly vascular, fitted to the neonatal cohorts (MAP +15–20 % at 0.1–0.5 mcg/kg/min, e.g. 30.6 → 37.8 and 34.4 → 39.4 mmHg; heart rate unchanged or lower).
  - **Boluses overshoot briefly.** With `ke0` 0 the effect follows the arterial concentration at once, and a bolus reaches the aorta unmixed: 5 mcg (1.4 mcg/kg) peaks at ~50 ng/mL and MAP ~156 mmHg for a few seconds, before mixing brings it to ~15 ng/mL. Real adrenaline takes tens of seconds to act; a `ke0` (biophase lag) would model that.
- **PGE1 cannot reopen a closed duct** (see [Pda](./Pda.md)); its systemic vasodilation and apnoea are not modelled.
- **No receptor down-regulation, no tachyphylaxis;** effects add without interaction.
- **Effect at the arterial concentration** by default (no biophase lag unless `ke0` is set).
- **Drugs live in the blood only** (no tissue distribution volume).

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Drugs` (trimmed to one drug):

```json
{
  "name": "Drugs",
  "model_type": "Drugs",
  "is_enabled": true,
  "drugs_running": true,
  "injection_site": "IVCI",
  "effect_site": "AA",
  "drug_defs": {
    "pge1": {
      "enabled": true,
      "clearance": { "global": 0.08, "sites": {} },
      "ke0": 0,
      "pda_ec50": 0.02, "pda_emax": 1.5, "pda_hill": 1
    }
  },
  "infusions": {}
}
```

## Usage in the scenarios

One instance in every scenario with adrenaline, noradrenaline and PGE1 defined and no infusion running.

## References

- Oualha M, Urien S, Spreux-Varoquaux O, et al. Pharmacokinetics, hemodynamic and metabolic effects of epinephrine to prevent post-operative low cardiac output syndrome in children. *Crit Care* 2014;18:R23. doi:10.1186/cc13707
- Fisher DG, Schwartz PH, Davis AL. Pharmacokinetics of exogenous epinephrine in critically ill children. *Crit Care Med* 1993;21:111–7. doi:10.1097/00003246-199301000-00021
- Heckmann M, Trotter A, Pohlandt F, Lindner W. Epinephrine treatment of hypotension in very low birthweight infants. *Acta Paediatr* 2002;91:566–70. doi:10.1080/080352502753711704
- Kallimath A, et al. Hemodynamic effects of noradrenaline in neonatal septic shock. *J Trop Pediatr* 2024;70. doi:10.1093/tropej/fmae001
- Gupta S, et al. The effect of norepinephrine on clinical and hemodynamic parameters in neonates with shock. *Eur J Pediatr* 2022;181:2379–87. doi:10.1007/s00431-022-04437-4
- Lu P, et al. Use of norepinephrine in preterm neonates with dopamine-resistant shock. *BMJ Paediatr Open* 2023;7. doi:10.1136/bmjpo-2022-001804

````

### FILE: explain-engine/docs/Ecls.md

````markdown
# Ecls

The `Ecls` device model simulates an **extracorporeal life support** (ECMO/ECLS) circuit: blood is
drained from a patient compartment, pumped through a membrane oxygenator and returned to the patient.
It is a **coordinator** — it owns the circuit sub-models (drainage cannula, inflow tubing, pump,
oxygenator, outflow tubing, return cannula, plus a sweep-gas side) and, each update tick, drives their
resistances, enabled/clamped states, pump pressure and gas-exchange constants, then reads back
smoothed pressures, flow and blood gases.

## Physiology

Extracorporeal life support (ECLS, ECMO) takes over gas exchange, and in the veno-arterial form also the circulation, while the lungs or heart recover. Neonatal indications include severe persistent pulmonary hypertension, meconium aspiration, congenital diaphragmatic hernia and cardiac failure.
- **Veno-arterial (VA):** blood is drained from the right atrium or a large vein, pumped through a membrane oxygenator and returned to the aorta (the carotid in neonates). It supports heart and lungs.
- **Veno-venous (VV):** blood is drained and returned to the right atrium, typically through one double-lumen cannula. It supports only the lungs; recirculation of returned blood into the drainage limb limits its efficiency.

Circuit flow is limited by venous drainage (cannula size, the patient's volume) as much as by the pump. Oxygenation depends on blood flow; CO2 removal depends on the sweep-gas flow.

## Inheritance

```
BaseModelClass
  └── Ecls   (ECLS/ECMO circuit coordinator)
```

`Ecls` extends `BaseModelClass` directly. Like the [`Ventilator`](./Ventilator.md), it is a composite
whose circuit sub-models (`ECLS_*`) are declared under `components`, instantiated into `model.models`
at build, and reached by name; `Ecls` itself contributes no compartment physics, only control.

## What it models

- A drainage → pump → oxygenator → return blood circuit wired into two named patient compartments
  (`drainage_site`, `return_site`).
- VA cannulation (separate drainage and return cannula) or VV cannulation with one double-lumen
  cannula (`cannulation`), with cannula libraries calibrated to the manufacturers' pressure-drop
  charts (Bio-Medicus 8–25 Fr, Avalon Elite 13/16 Fr dual-lumen), converted from water to blood.
- Circuit resistances that scale realistically with flow: nonlinear cannula pressure drops, laminar
  tubing from its geometry, and a per-device oxygenator pressure drop. See
  [Circuit calibration](#circuit-calibration).
- Centrifugal or roller pump drive, applied as an external pressure across the pump or oxygenator.
- A sweep-gas side feeding the oxygenator's gas exchanger, with adjustable FiO₂/FiCO₂ and diffusion
  constants.
- Smoothed, near-real-time pressure and flow read-outs via four
  [`RealTimeMovingAverage`](./RealTimeMovingAverage.md) filters, plus once-per-second blood-gas
  read-outs (venous and post-oxygenator).

## Circuit topology

```
patient(drainage_site) ─[ECLS_DRAINAGE]─► ECLS_TUBING_IN ─► ECLS_PUMP ─► ECLS_OXY ─► ECLS_TUBING_OUT ─[ECLS_RETURN]─► patient(return_site)
                                                                            │
                                                              [ECLS_GASEX: GasExchanger]
                                                                            │
                  ECLS_GAS_SOURCE ─[ECLS_GAS_INSP_VALVE]─► ECLS_GAS_OXY ─[ECLS_GAS_EXP_VALVE]─► ECLS_GAS_OUT   (sweep gas)
```

| Sub-model | Type | Role |
|---|---|---|
| `ECLS_DRAINAGE` | Resistor | Drainage cannula (`drainage_site → ECLS_TUBING_IN`) |
| `ECLS_TUBING_IN` | BloodCapacitance | Inflow tubing; its pressure is reported as `p_ven` |
| `ECLS_PUMP` | BloodVessel | Pump; its pressure is reported as `p_int`; centrifugal drive sets `p2_ext` |
| `ECLS_OXY` | BloodVessel | Membrane oxygenator; blood side of the gas exchanger; roller drive sets `p2_ext` |
| `ECLS_TUBING_OUT` | BloodCapacitance/BloodVessel | Outflow tubing; its pressure is reported as `p_art` |
| `ECLS_RETURN` | Resistor | Return cannula (`ECLS_TUBING_OUT → return_site`); its flow ×60 is `flow` |
| `ECLS_GAS_SOURCE` | GasCapacitance | Sweep-gas source (composition from `gas_fio2`/`gas_fico2`/…) |
| `ECLS_GAS_INSP_VALVE` | Resistor | Sweep-gas inlet valve; resistance sized each update so sweep flow tracks `gas_flow` |
| `ECLS_GAS_OXY` | GasCapacitance | Gas side of the oxygenator |
| `ECLS_GAS_EXP_VALVE` | Resistor | Sweep-gas outlet valve (`ECLS_GAS_OXY → ECLS_GAS_OUT`); enabled with the circuit, back-flow blocked |
| `ECLS_GAS_OUT` | GasCapacitance | Sweep-gas outlet |
| `ECLS_GASEX` | GasExchanger | O₂/CO₂ exchange between `ECLS_OXY` (blood) and `ECLS_GAS_OXY` (gas) |

Sub-model references (`_ecls_drainage`, `_ecls_pump`, …, `_ecls_gasex`) are resolved **lazily** inside
`calc_model` (each tick while running) rather than in an `init_model`.

## Properties

### Configuration (independent)

| Property | Unit | Description |
|---|---|---|
| `ecls_running` | bool | Master on/off for the circuit |
| `ecls_clamped` | bool | Clamp the blood path (`no_flow` on every blood sub-model; disables the gas exchanger) |
| `cannulation` | string | `"VA"` (default; separate drainage + return cannula) or `"VV-DL"` (one double-lumen cannula: both lumens in `drainage_site`) |
| `dl_cannula_type` | string | Key into `dl_cannulas`, used in `VV-DL` (default `Avalon Elite 13 Fr`) |
| `drainage_site` | string | Patient compartment the drainage cannula drains (default `RA`) |
| `return_site` | string | Patient compartment the return cannula feeds (default `AAR`). In `VV-DL` it is forced to `drainage_site`; the VA site is remembered and restored on the way back to `VA` |
| `drainage_cannula_type` | string | Key into `drainage_cannulas`, used in `VA` (default `Biomedicus venous 12 Fr`) |
| `return_cannula_type` | string | Key into `return_cannulas`, used in `VA` (default `Biomedicus arterial 10 Fr`) |
| `drainage_res_factor` | × | Multiplier on drainage-cannula resistance (default 1.0) |
| `return_res_factor` | × | Multiplier on return-cannula resistance |
| `tubing_res_factor` | × | Multiplier on both tubing resistances |
| `pump_res_factor` | × | Multiplier on pump resistance |
| `oxy_res_factor` | × | Multiplier on oxygenator resistance |
| `oxy_res_for` / `oxy_res_back` | mmHg/(L/s) | Oxygenator resistance; set from the selected oxygenator's `dp_a` (Quadrox-i Neonatal 2700) whenever `oxygenator_type` is applied, editable in between |
| `oxy_vol` | L | Oxygenator volume (default 0.09); overwritten by the selected oxygenator's `prime`, and applied as `ECLS_OXY.u_vol` |
| `pump_res_for` / `pump_res_back` | mmHg/(L/s) | Pump internal resistance (default 50/50); the inflow tubing's `tubing_in_res` is added in series on the same resistor |
| `pump_vol` | L | Pump volume (default 0.031); overwritten by the selected pump's `prime`, and applied as `ECLS_PUMP.u_vol` |
| `pump_rpm` | rpm | Pump speed — the primary control (default 1500) |
| `pump_height` | cm | Height of the pump and its pressure transducers **below** the patient's heart level (default 30; negative = above). Adds the blood column (≈ 0.78 mmHg/cm) to `p_ven`/`p_int`/`p_art`; flow is unaffected |
| `pump_type` | string | Key into `pumps` (default `Abbott PediMag`); selecting it copies the H-Q/roller coefficients and sets `pump_mode` |
| `pump_mode` | 0/1 | 0 = centrifugal (drives the pump), 1 = roller (drives the oxygenator); set from the selected pump's `type` |
| `pump_hq_a` / `pump_hq_b` / `pump_hq_c` | — | Centrifugal head-flow coefficients (mmHg per krpm², per krpm·(L/min), per (L/min)²) |
| `roller_ml_per_rev` / `roller_kp` / `roller_drive_max` | mL/rev, —, mmHg | Roller flow-source stroke volume, controller gain, drive clamp |
| `pumps` | dict | Pump device library (H-Q coefficients / roller params, `type`, `max_rpm`, `prime` per device) |
| `gas_flow` | L/min | Sweep-gas flow (default 0.5) |
| `gas_fio2` | fraction | Sweep-gas FiO₂ (default 0.205) |
| `gas_fico2` | fraction | Sweep-gas FiCO₂ (default 0.000392) |
| `gas_humidity` | fraction | Sweep-gas humidity (default 0.5) |
| `gas_temp` | °C | Sweep-gas temperature (default 20) |
| `blood_temp_active` | bool | Blood-side **heater-cooler** on/off (default `false` = neutral; `ECLS_OXY` behaves like any blood compartment) |
| `blood_temp` | °C | Heater-cooler target blood temperature at the oxygenator (default 37); e.g. 33.5 for therapeutic hypothermia |
| `blood_temp_tc` | s | Heat-exchanger equilibration time constant (default 2.0, fast) |
| `dif_o2` | mmol/(mmHg·s) | Gas-exchanger O₂ diffusion constant (default 0.0005) |
| `dif_co2` | mmol/(mmHg·s) | Gas-exchanger CO₂ diffusion constant (default 0.001) |
| `oxygenator_type` | string | Key into `oxygenators` (default `Getinge Quadrox-i Neonatal`); copies the membrane transfer caps |
| `oxy_o2_cap` / `oxy_co2_cap` | mmol/s | Active O₂/CO₂ membrane transfer ceilings, pushed onto `ECLS_GASEX` |
| `oxy_surface_area` / `oxy_rated_flow` | m², L/min | Selected oxygenator's surface area / rated blood flow (informational) |
| `oxygenators` | dict | Oxygenator device library (surface area, rated flow, `o2_cap`/`co2_cap`, prime and blood-side pressure drop `dp_a` per device) |
| `drainage_cannula_diameter`, `drainage_cannula_length` | m | Drainage cannula geometry (copied from the selected library entry) |
| `return_cannula_diameter`, `return_cannula_length` | m | Return cannula geometry (copied from the selected library entry) |
| `tubing_in_diameter`, `tubing_in_length`, `tubing_out_diameter`, `tubing_out_length` | m | Tubing geometry; sets the tubing resistances (Poiseuille, blood) and volumes |
| `pump_max_rpm` | rpm | Maximum speed of the selected pump (informational, from the pump library) |
| `pressure_avg_window`, `flow_avg_window` | samples | Window of the pressure and flow moving averages (default 400, ≈6 s at the 0.015 s update) |
| `prev_fio2`, `prev_fico2` | – | Last applied sweep-gas FiO2 / FiCO2; a change rebuilds the gas-source composition |
| `return_cannulas`, `drainage_cannulas` | dict | VA cannula libraries (inner diameter, length, water-chart fit `dp_a`/`dp_b` per device) |
| `dl_cannulas` | dict | Double-lumen (VV) cannula library: per device a `drainage` and a `return` lumen fit (`dp_a`/`dp_b`) |

### Computed (dependent) read-outs

| Property | Unit | Description |
|---|---|---|
| `p_ven` | mmHg | Filtered (moving-average) venous/inlet pressure as the transducer reads it: `ECLS_TUBING_IN.pres + p_hydrostatic` |
| `p_int` | mmHg | Filtered pressure at the pump interface: `ECLS_PUMP.pres + p_hydrostatic` |
| `p_art` | mmHg | Filtered arterial/outlet pressure: `ECLS_TUBING_OUT.pres + p_hydrostatic` |
| `p_hydrostatic` | mmHg | Hydrostatic offset of the transducers from `pump_height` (30 cm → 23.4 mmHg) |
| `flow` | L/min | Circuit blood flow (`ECLS_RETURN.flow × 60`) |
| `flow_avg` | L/min | Moving-average of `flow` |
| `pump_pressure` | mmHg | Pump drive pressure = `−head` (centrifugal H-Q) or `−`roller-controller output |
| `sat_ven_o2` | % | Venous (pre-oxygenator) O₂ saturation — tapped at the drainage tubing `ECLS_TUBING_IN` |
| `sat_postoxy_o2` | % | Post-oxygenator O₂ saturation — tapped at the oxygenator blood compartment `ECLS_OXY` |
| `pco2_postoxy` | mmHg | Post-oxygenator pCO₂ — tapped at `ECLS_OXY` |
| `drainage_res` / `return_res` | mmHg/(L/s) | Cannula (or lumen) resistance in blood at the current circuit flow — the chord dP(Q)/Q of the device's pressure-drop curve, before `*_res_factor` |
| `drainage_dp` / `return_dp` | mmHg | Pressure drop over the drainage / return cannula (lumen) at the current flow, factor included |
| `tubing_in_res` / `tubing_out_res` | mmHg/(L/s) | Poiseuille tubing resistances (blood) from the tubing geometry, recomputed each update (a scenario value is overwritten). `tubing_out_res` drives the `ECLS_OXY → ECLS_TUBING_OUT` resistor; `tubing_in_res` is added to the pump's inlet resistor |
| `tubing_in_vol` / `tubing_out_vol` | L | Tubing volumes from the tubing geometry (π·(d/2)²·length), applied as the `u_vol` of `ECLS_TUBING_IN` / `ECLS_TUBING_OUT` |

### Internal (`_`-prefixed) and moving averages

`prev_fio2` / `prev_fico2` (above) with `_prev_gas_temp` / `_prev_gas_humidity` detect sweep-gas
changes, so the gas-source composition is only rebuilt when one of them changes. `_stopped` makes the stop work
edge-triggered (see below). `_update_interval` (0.015 s) and `_update_counter` gate the main
control block; `_blood_comp_interval` (1.0 s) and `_blood_comp_counter` gate the blood-gas read-outs.
`pressure_avg_window` / `flow_avg_window` (default 400 samples, ≈6 s at the 0.015 s update rate)
size the four [`RealTimeMovingAverage`](./RealTimeMovingAverage.md) filters
(`_flow_avg_calculator`, `_p_ven_avg_calculator`, `_p_int_avg_calculator`, `_p_art_avg_calculator`).

## Cannula library

`drainage_cannulas` / `return_cannulas` (VA) are dictionaries of real devices (Biomedicus venous
8–25 Fr / arterial 8–21 Fr), each with an `inner_diameter` (m), `length` (m) and the fit
`dP = dp_a·Q + dp_b·Q²` (mmHg, Q in L/min) of its manufacturer pressure-drop chart, measured in water.
`dl_cannulas` (VV) holds double-lumen devices (Avalon Elite 13 / 16 Fr), with a separate fit for the
drainage and the return lumen. Keys use the `Biomedicus` spelling that `drainage_cannula_type` /
`return_cannula_type` reference, so a selection resolves. The **constructor is the single source of
truth** for the catalogue: scenario definitions do not embed their own copy (the last eight that did
were cleaned up on 2026-10-12), so every scenario sees the full catalogue and any cannula can be
selected in any scenario. Each update, `calc_model` copies the selected VA cannulas' geometry into
`*_cannula_diameter`/`_length` and turns the selected fits into the live resistances (next section).

## Circuit calibration

The circuit was recalibrated on 2026-10-12 so that the pump speed needed for a given flow comes out of
realistic circuit losses. Before, the whole neonatal circuit cost only ≈ 31 mmHg at 0.47 L/min, so the
patient's arterial pressure dominated the pump head on VA. VV (no arterial afterload) then needed
≈ 35 % fewer rpm than VA, which bedside practice does not show. With the calibration below, a 13 Fr
double-lumen VV run needs about the same or slightly more rpm than 12/10 Fr VA. That is because the
narrow return lumen costs more than the arterial cannula plus the arterial pressure.

**Cannulas: manufacturer charts, converted to blood.** Each chart was fitted (non-negative least
squares) as `dP = dp_a·Q + dp_b·Q²`. Cannula pressure drop is mostly inertial (entrance and exit
losses), so the quadratic term dominates and the drop rises steeply with flow. The charts are measured
in water at room temperature. Blood (≈ 3 cP at 37 °C and Hct 30–35 %, 1.06 kg/L) is handled by scaling
the linear term by `BLOOD_VISCOSITY_RATIO` (3.0) and the quadratic term by `BLOOD_DENSITY_RATIO` (1.06).
At neonatal flows that puts blood 30–60 % above the water chart. This is inside the 10–80 % excess
Broman et al measured in blood (*Perfusion* 2020, doi:10.1177/0267659120926009).

| Library entry | Chart used (water) | `dp_a` | `dp_b` | blood dP @ 0.5 L/min |
|---|---|---|---|---|
| Biomedicus arterial 8 / 10 / 12 Fr | Medtronic DLP pediatric one-piece arterial 77008 / 77010 / 77012 (proxy: the Bio-Medicus neck cannula's chart is not published as data) | 19.84 / 4.20 / 8.74 | 162.87 / 59.62 / 17.96 | 73 / 22 / 18 mmHg |
| Biomedicus arterial 15 / 17 / 19 / 21 Fr | Bio-Medicus NextGen femoral arterial | 0 / 0 / 0 / 0.39 | 11.35 / 6.08 / 3.45 / 2.07 | — (adult) |
| Biomedicus venous 10 / 12 / 14 Fr | Bio-Medicus NextGen pediatric venous 96830-110 / 112 / 114 | 10.78 / 6.61 / 4.79 | 47.42 / 17.08 / 9.27 | 29 / 14 / 10 mmHg |
| Biomedicus venous 8 Fr | none published; 10 Fr scaled by (ID 2.7/2.1 mm)⁴ | 29.4 | 129.5 | 78 mmHg |
| Biomedicus venous 21 / 23 / 25 Fr | Bio-Medicus NextGen femoral bi-caval venous 96670-121 / 123 / 125 | 3.09 / 2.91 / 1.90 | 2.52 / 1.71 / 1.18 | — (adult) |
| Avalon Elite 13 Fr, drainage / return lumen | Getinge Avalon Elite 10013-CE | 15.18 / 13.74 | 81.78 / 342.83 | 44 / 112 mmHg |
| Avalon Elite 16 Fr, drainage / return lumen | Getinge Avalon Elite 10016-CE | 6.27 / 0 | 32.10 / 168.95 | 18 / 45 mmHg |
| Crescent RA 13 Fr, drainage / return lumen | Medtronic Crescent RA 70413 (brochure chart) | 19.75 / 38.72 | 57.75 / 228.87 | 45 / 119 mmHg |
| Crescent RA 15 Fr, drainage / return lumen | Medtronic Crescent RA 70415 | 12.46 / 15.85 | 25.87 / 109.61 | 26 / 53 mmHg |
| Crescent RA 19 Fr, drainage / return lumen | Medtronic Crescent RA 70419 | 4.61 / 5.95 | 9.80 / 40.41 | 9 / 20 mmHg |

The digitised chart points came from the open `perfusion-tools` cannula pressure-drop dataset
(github.com/IMhongkeun/perfusion-tools, `data/cannula-pressure-drop.json`). That dataset digitises the
Medtronic cannulae catalog, the Bio-Medicus NextGen brochure and the Getinge Avalon Elite charts. An
independent blood data point supports the steep return lumen: an OriGen 13 Fr VV catheter costs
275 mmHg at 500 mL/min in lambs. The Crescent RA curves were digitised by pixel from the chart in the
Medtronic Crescent RA brochure (UC202207936b EN, 11/2024; water at 21 °C, items 70413/70415/70419).
Fits are within 0.4–2.0 mmHg RMS. The digitised points match the chart's gridlines (13 Fr infusion:
76 mmHg at 0.5 L/min, 266 at 1.0).

**How the nonlinearity is applied.** The engine's `Resistor.r_k` term is explicit (lagged by one step).
With these stiff curves it would oscillate. Instead `calc_model` writes the **chord resistance**
`R = (dp_a·3.0 + dp_b·1.06·|Q|)·60` (mmHg/(L/s)) each update, with Q the pump's flow EMA (time
constant 0.3 s, which damps the feedback). Q is held at `CANNULA_FLOW_FLOOR` (0.05 L/min) and above,
and R at `CANNULA_RES_MIN` (100 mmHg/(L/s)) and above. That second floor is for numerical stability,
not physiology: the stiff ECLS compartments (elastance ≈ 50 000 mmHg/L) need R ≥ ≈ 25 at the 0.5 ms
step, and large adult cannulas at near-zero flow would otherwise fall below it.

**Tubing.** Poiseuille with blood viscosity `BLOOD_VISCOSITY` 0.003 Pa·s from `tubing_*_diameter`/
`_length`: 1/4″ × 1 m ≈ 564 mmHg/(L/s) (was a fixed 50).

**Oxygenator.** `dp_a` in the oxygenator library, in mmHg per L/min of blood, linear because hollow
fibre is laminar. Quadrox-i Neonatal 45: ≈ 8 mmHg at 0.2 and ≈ 65 at 1.5 L/min (manufacturer figures
as cited in US patents 11759558 / 12296080), and clinically 53 ± 15 mmHg per L/min (*Perfusion* 2013,
seven patients). The larger devices have no figure at hand. They are assumed to cost the same ≈ 65 mmHg
at their own rated flow (`dp_a = 65 / rated_flow`). Selecting the oxygenator writes
`oxy_res_for/back = dp_a·60`. It was a fixed 1500 mmHg/(L/s), about 25 per L/min.

**Pump height.** The circuit transducers sit at pump level, and the pump usually sits below the
patient. They therefore read the line pressure plus the blood column between patient and pump,
ρ·g·h ≈ 0.78 mmHg per cm (`pump_height`, default 30 cm → +23.4 mmHg). This is applied to `p_ven`,
`p_int` and `p_art` only. The circuit is a closed loop: the column adds on the drainage limb and
subtracts on the return limb, so it does not change the flow, and the compartment pressures stay at
patient level. A future inflow-collapse model must use the unshifted cannula-side pressure. The 30 cm
default is an assumed console position. It was chosen because it puts neonatal VV `p_ven` (13 Fr
double lumen, 0.44 L/min) at ≈ −12 mmHg, inside the −10 to −20 mmHg seen at the bedside. The
line pressure itself is −36 mmHg: right atrium +2 minus a 37 mmHg drainage-lumen drop.

**PediMag H-Q.** No H-Q curve is published. See [Pump device library](#pump-device-library).

**Result, `term_neonate_72h`** (PediMag, Quadrox-i Neonatal, 1 m + 1 m of 1/4″ tubing; 40 s warm-up).
Pressures are line pressures at patient level (`pump_height` 0). With the 30 cm default, every
displayed circuit pressure reads 23.4 mmHg higher:

| rpm | VA 12 Fr venous / 10 Fr arterial → AAR: flow, P_ven, P_pre-oxy | VV Avalon 13 Fr → RA: flow, P_ven, P_pre-oxy |
|---|---|---|
| 2000 | 0.18 L/min, −3, 77 mmHg | 0.29 L/min, −18, 59 mmHg |
| 2400 | 0.38, −10, 102 | 0.37, −26, 85 |
| 2800 | 0.56, −17, 130 | 0.45, −36, 116 |
| 3200 | 0.75, −26, 162 | 0.53, −46, 152 |
| 3600 | 0.93, −36, 197 | 0.61, −58, 193 |

Before, the same VA run gave 0.47 L/min at 2800 rpm. VV with two single-lumen cannulas gave 0.47 L/min
at ≈ 1800 rpm. At ≈ 0.45 L/min VV now needs ≈ 10 % more rpm than VA, and ≈ 20 % more at 0.6 L/min.
Adult (`adult_female`, CentriMag, 25/19 Fr): 4000 rpm → 4.0 L/min (was 6.6), 5000 rpm → 6.0 (was 10.9).
The realistic adult cannula losses also remove most of the implausibly high adult flows noted on
2026-10-01.

## Calculation cycle (`calc_model`)

**When `ecls_running` is false:** the stop work runs once, on the running→stopped edge (and on the
first step after a load), guarded by `_stopped`; later stopped steps return immediately. It zeroes
`flow`/`flow_avg`/`p_ven`/`p_int`/`p_art`, `pump_pressure` and the `sat_ven_o2`/`sat_postoxy_o2`/
`pco2_postoxy` read-outs, resets the four moving-average filters, `_blood_comp_counter`, the pump
flow EMA and the roller integrator, and **disables every circuit sub-model** so a stopped circuit no
longer conducts passive flow, then returns. The refs are resolved here as well, so a circuit that has
never run is disabled from the first step (scenarios ship the sub-models with `is_enabled: true`).
It also zeroes `flow` on the circuit's five blood resistors (both cannulas and the three
BloodVessel-owned connectors) and on both sweep-gas valves: a disabled Resistor never runs
`calc_flow`, so its last flow would otherwise linger after a stop. Finally it zeroes `p1_ext`/`p2_ext`
on `ECLS_PUMP` and `ECLS_OXY` — a BloodVessel keeps its own copy and re-copies it to its resistors
every step, so a stale drive would persist and be saved with the state — applies the circuit volumes
and releases the heater-cooler.

**When running**, every `_update_interval` (0.015 s):

1. Rebuild any moving-average filter whose window size changed (`flow_avg_window` /
   `pressure_avg_window`).
2. Resolve the `ECLS_*` sub-model references; **skip the tick** if any of the eleven required ones is
   missing (`ECLS_GAS_EXP_VALVE` is resolved too, but its use is individually guarded rather than
   gating the tick).
3. Apply `drainage_site` / `return_site` to the cannula resistors. Then take the pressure-drop fits
   of the selected cannulas: both lumens of `dl_cannula_type` in `VV-DL`, or the two VA cannulas.
   Turn them into the chord resistances `drainage_res`/`return_res` at the current flow, and compute
   the Poiseuille `tubing_in_res`/`tubing_out_res` ([Circuit calibration](#circuit-calibration)).
   Apply the circuit volumes: the tubing `u_vol` from its geometry, `ECLS_PUMP`/`ECLS_OXY` `u_vol` from
   `pump_vol`/`oxy_vol` (the selected devices' `prime`), each part keeping its stressed volume.
   Re-apply the pump / oxygenator library entry if `pump_type` / `oxygenator_type` changed.
   (Before every tick, running or not, `_apply_cannulation` forces `return_site = drainage_site` in
   `VV-DL`, or restores the remembered VA return site.)
4. Sync every sub-model's `is_enabled` to `ecls_running` (including both sweep-gas valves); set
   `no_flow = ecls_clamped` on all blood sub-models; enable `ECLS_GASEX` only when **unclamped**
   (`is_enabled = !ecls_clamped`); block back-flow on `ECLS_GAS_EXP_VALVE`.
5. Push resistances onto each sub-model: drainage/return cannula, pump, oxygenator and outlet-tubing
   resistance × its `*_res_factor`. The two cannula resistances are further scaled by the blood they
   carry, `viscosity / viscosity_ref` of `ECLS_TUBING_IN` (drainage) and `ECLS_TUBING_OUT` (return),
   as the ECLS BloodVessels already do for their own resistors (haemodilution by the prime,
   transfusion). `ECLS_TUBING_IN` is a bare `BloodCapacitance` that owns no
   resistor, so the inflow tubing's `tubing_in_res × tubing_res_factor` is added in series to the
   pump's own inlet resistor.
6. Rebuild the sweep-gas composition when `gas_fio2`/`gas_fico2`/`gas_temp`/`gas_humidity` changed; size the inspiratory-valve
   resistance each update so sweep flow tracks `gas_flow` (see below).
7. Update `ECLS_GASEX.dif_o2` / `dif_co2` and the membrane transfer ceilings `o2_cap` / `co2_cap`
   (from the selected oxygenator) — the rated-flow limit.
8. **Pump drive** (see below).
9. Read raw pressures, push them through the moving-average filters into `p_ven`/`p_int`/`p_art`, set
   `flow` (= `ECLS_RETURN.flow × 60`) and `flow_avg`.
10. Once per `_blood_comp_interval` (1.0 s), recompute blood composition and read out `sat_ven_o2`
    (from the drainage tubing `ECLS_TUBING_IN`, pre-oxygenator) and `sat_postoxy_o2` / `pco2_postoxy`
    (from the oxygenator blood compartment `ECLS_OXY` itself — the true membrane outlet, rather than the
    downstream `ECLS_TUBING_OUT` which lags it by advective mixing).

### Pump drive — head-flow (H-Q) model

The pump develops a **flow-dependent head**, not a fixed pressure. The flow input is a short EMA
(`_pump_flow_ema_tc`, ~0.3 s) of the circuit flow (`ECLS_RETURN.flow × 60`, L/min) — lagged feedback
that keeps the operating point stable without the 6 s display `flow_avg`'s sluggishness.

**Centrifugal** (`pump_mode 0`) — rotodynamic characteristic, head clamped ≥ 0:
```
head = hq_a·(rpm/1000)² − hq_b·(rpm/1000)·Q − hq_c·Q²      // mmHg, Q in L/min
pump_pressure = −head
```
Head falls as flow rises, so the operating point is **afterload/preload sensitive** — the defining
behaviour of a centrifugal pump. (At insufficient rpm the head cannot overcome arterial afterload and
the circuit can run retrograde — physiological for valveless VA ECMO.)

**Roller** (`pump_mode 1`) — positive-displacement **flow source**. An integral controller trims the
drive so circuit flow tracks the target, making flow (nearly) **independent of afterload**:
```
Q_target = roller_ml_per_rev·rpm / 1000
_roller_drive += roller_kp·(Q_target − Q)     // clamped to [0, roller_drive_max]
pump_pressure = −_roller_drive
```

The drive is applied to the driven vessel's **downstream** node (`p2_ext`) and the other vessel's
`p1_ext`/`p2_ext` are zeroed — centrifugal drives `ECLS_PUMP`, roller drives `ECLS_OXY`:
```
pump_mode 0: ECLS_PUMP.p2_ext = pump_pressure;  ECLS_OXY  p1_ext = p2_ext = 0
pump_mode 1: ECLS_OXY.p2_ext  = pump_pressure;  ECLS_PUMP p1_ext = p2_ext = 0
```
The negative downstream-node pressure over-fills that compartment from upstream and pushes the circuit
**forward**; driving `p1_ext` (the upstream node) instead would push it backward. Zeroing the other
vessel means switching `pump_mode` at runtime cannot leave a stale drive applied (the `BloodVessel`
never self-resets `p1_ext`/`p2_ext`; only its owned resistor does, each step). `head` is applied as a
single-node external pressure — a lumped approximation of the true inlet→outlet head, adequate for the
0D circuit.

### Pump device library

`this.pumps` is a dictionary of real ECLS pumps (Abbott PediMag / CentriMag, Getinge Rotaflow RF-32,
Medtronic Bio-Pump BP-50, a generic roller), each carrying its H-Q coefficients (`hq_a`/`hq_b`/`hq_c`)
or roller parameters (`ml_per_rev`/`roller_kp`/`roller_drive_max`), `type` (`centrifugal`/`roller`),
`max_rpm`, and priming volume. Setting `pump_type` copies the entry's coefficients into the active
fields and sets `pump_mode` from `type` (in the constructor, and re-applied each update when `pump_type`
changes). `pump_rpm` remains the control.

The PediMag has no published H-Q curve. Since 2026-10-12 it uses a ≈ 640 mmHg deadhead at 5500 rpm
(`hq_a` 21.16). The published 540 mmHg "maximum outflow pressure" is read as a rated limit, as the
CentriMag's 600 turned out to be (measured deadhead 710, ratio 1.18). The curve shape is the CentriMag
fit scaled to the PediMag's head (×0.91) and flow range (1.5/10 L/min): `hq_b` 5.2, `hq_c` 15.4, flat
at neonatal flows like any mag-lev pump. The old `hq_b` 30.3 made the curve steep. It had been tuned
against the old, far too cheap circuit, and absorbed the missing circuit losses. With the calibrated
circuit, VA `term_neonate_72h` gives ≈ 0.56 L/min at 2800 rpm, close to the PediVAS operating point
(0.6 L/min). The Rotaflow and Bio-Pump `hq_b` predate the circuit calibration and have not been
re-checked.

The other H-Q coefficients are **fit to published pump characteristics** (`head = hq_a·(rpm/1000)² −
hq_b·(rpm/1000)·Q`, with `hq_c = 0`): the deadhead (`Q=0`) scaled as rpm² fixes `hq_a`, and the rated
flow at max rpm fixes the Euler-slip falloff `hq_b`. For the Rotaflow the deadhead is fixed by two
independent data points (~108 mmHg shut-off at 2000 rpm and ~700 mmHg at 5000 rpm → `hq_a ≈ 28`); the
others are anchored to their deadhead magnitude and rated flow. The linear `N·Q` falloff keeps a finite
slope at low flow, so raising afterload reduces flow across the operating range.

| Pump | `hq_a` | `hq_b` | `hq_c` | deadhead @ max rpm | rated flow |
|---|---|---|---|---|---|
| Abbott PediMag | 21.16 | 5.2 | 15.4 | ~640 mmHg @5500 | ~1.5 L/min |
| Abbott CentriMag | 23.17 | 0.85 | 0.38 | ~710 mmHg @5500 | 10 L/min |
| Getinge Rotaflow RF-32 | 28 | 13.0 | 0 | ~700 mmHg @5000 | ~10 L/min |
| Medtronic Bio-Pump BP-50 | 20 | 28.9 | 0 | ~180 mmHg @3000 | neonatal |

The CentriMag is fitted to the manufacturer's H-Q curves (CentriMag Circulatory Support System
Operation Manual PL-0047 Rev 11, Fig. 14, pump only, blood analog 4.02 cP), by least squares over points
read off all eight rpm curves (2000–5500 rpm), within 4.8 mmHg RMS. The curves are nearly flat with flow
(≈ −6 mmHg per L/min at 3000 rpm), so `hq_b`/`hq_c` are small. The manual's "maximum pressure head of
600 mmHg" is a rated limit; the 5500 rpm curve starts at ≈ 710 mmHg. The Rotaflow and Bio-Pump
coefficients are anchored to each pump's published deadhead and rated flow; they are **not** digitized
from the full manufacturer H-Q figures (which were not accessible), so their mid-curve shape is the
theoretical Euler-slip (linear) default. Sources: Wang et al 2020 *Artif Organs* (Rotaflow / CentriMag /
PediMag paediatric ECMO characterisation), the ROTAFLOW/CentriMag adult ECLS comparison, and the
manufacturers' rated-flow specifications. Note the **circuit** (cannula size, venous return)
sets the achievable flow ceiling, so a small patient stays preload-limited (e.g. ~0.5 L/min for a term
neonate) regardless of pump rating — afterload changes then move flow little until the preload limit is
relieved.

### Oxygenator device library and rated-flow transfer

`this.oxygenators` is a dictionary of real membrane oxygenators (Getinge Quadrox-i Neonatal / Pediatric
/ Small Adult, Medtronic Nautilus), each carrying its membrane `surface_area` (m²), `rated_flow`
(L/min), priming volume, and — the physics-driving fields — `o2_cap` / `co2_cap`, the **membrane
transfer ceilings** in mmol/s. Setting `oxygenator_type` copies these into the active `oxy_*` fields (in
the constructor, `init_model`, and each update when the selection changes); `Ecls` then pushes
`oxy_o2_cap` / `oxy_co2_cap` onto `ECLS_GASEX.o2_cap` / `co2_cap` beside the diffusion constants.

The caps make the oxygenator **rated-flow-limited** (see [GasExchanger](./GasExchanger.md)): below the
oxygenator's rated blood flow the outlet blood fully saturates, but once circuit flow exceeds the rating
the per-step transfer is capped and post-oxygenator saturation **falls** — an undersized oxygenator (or
one run past its rating) can no longer fully oxygenate. Because only `ECLS_GASEX` gets a cap, the native
lung's `GasExchanger` instances are unaffected. The `o2_cap`/`co2_cap` values are anchored to the
Quadrox-i Neonatal datasheet (~90 mL O₂/min, ~73 mL CO₂/min at 1.5 L/min) and scaled by rated flow for
the larger devices. At a term neonate's preload-limited ~0.5 L/min the outlet stays fully saturated for
every library oxygenator (correct — all are rated well above that); the decline appears only when blood
flow exceeds the selected device's rated flow.

### Sweep-gas inlet valve

Each update the inlet-valve resistance is sized so the sweep-gas flow tracks the `gas_flow` set-point.
The gas line `ECLS_GAS_SOURCE →[R_insp]→ ECLS_GAS_OXY →[R_exp]→ ECLS_GAS_OUT` is held at fixed pressure
at both ends, so in steady state `Q = ΔP / (R_insp + R_exp)`, giving:

```
R_insp = (ECLS_GAS_SOURCE.pres − ECLS_GAS_OUT.pres) / (gas_flow / 60) − R_exp
```

where `R_exp` is the live `ECLS_GAS_EXP_VALVE` resistance (not a hard-coded constant). `R_insp` is
clamped strictly positive. When `gas_flow ≤ 0` the inlet valve is set `no_flow` (sweep off) rather than
dividing by zero.

## Factor system

`Ecls` uses **plain resistance multipliers** (`drainage_res_factor`, `return_res_factor`,
`tubing_res_factor`, `pump_res_factor`, `oxy_res_factor`), not the engine's three-tier
`*_factor` / `*_factor_ps` / `*_factor_scaling_ps` pattern. Each multiplier scales the corresponding
cannula/tubing/pump/oxygenator resistance before it is written onto the sub-model's `r_for`/`r_back`.
The underlying `ECLS_*` blood sub-models still carry their own three-tier factor layers (see
[BloodVessel](./BloodVessel.md) / [Resistor](./Resistor.md)), but `Ecls` overwrites their `r_for`
directly each tick.

## Example definition (JSON)

Device-level fields from `term_neonate_72h.json` (the full block nests eleven `ECLS_*` sub-models under
`components`):

```json
{
  "name": "Ecls",
  "description": "extracorporeal life support",
  "is_enabled": true,
  "model_type": "Ecls",
  "components": { "ECLS_DRAINAGE": {}, "ECLS_TUBING_IN": {}, "ECLS_PUMP": {},
                  "ECLS_OXY": {}, "ECLS_TUBING_OUT": {}, "ECLS_RETURN": {},
                  "ECLS_GAS_SOURCE": {}, "ECLS_GAS_OXY": {}, "ECLS_GAS_OUT": {},
                  "ECLS_GAS_INSP_VALVE": {}, "ECLS_GASEX": {} },
  "ecls_running": false,
  "ecls_clamped": true,
  "drainage_site": "RASVC",
  "return_site": "AAR",
  "drainage_cannula_type": "Biomedicus venous 12 Fr",
  "return_cannula_type": "Biomedicus arterial 10 Fr",
  "drainage_res_factor": 1, "return_res_factor": 1,
  "tubing_res_factor": 1, "pump_res_factor": 1, "oxy_res_factor": 1,
  "oxy_res_for": 1500, "oxy_res_back": 1500, "oxy_vol": 0.09,
  "pump_rpm": 1500, "pump_mode": 0,
  "gas_flow": 0.5, "gas_fio2": 0.21, "gas_fico2": 0.000392,
  "gas_humidity": 0.5, "gas_temp": 20,
  "dif_o2": 0.0005, "dif_co2": 0.001,
  "pressure_avg_window": 400, "flow_avg_window": 400
}
```

`ecls_running` is the circuit's on/off switch, and every shipped scenario has it **off**
(`ecls_running: false`, since 2026-10-01). Switching it on at runtime gives a primed but clamped circuit
(`ecls_clamped: true`), so no blood flows until it is unclamped. Use `ecls_running` rather than the
model's `is_enabled`: with `is_enabled: false`, `calc_model` never runs, so nothing manages the
sub-models (and nothing refreshes the `Ecls.*` read-outs the UI watches).

## Inputs and outputs

- **Reads:** its circuit compartments (pressures, flows, compositions via [`calc_blood_composition`](./BloodComposition.md)); the drainage and return site compartments.
- **Writes:** its circuit components: cannula and tubing resistances, the pump's `p1_ext`/`p2_ext`, enabled and clamp states, the oxygenator exchanger (`dif_o2`, `dif_co2`, `o2_cap`, `co2_cap`), the sweep-gas source composition and valves; `ECLS_OXY` temperature control (heater-cooler).
- **Written by:** the user and bot (cannulation, pump, sweep gas, heater-cooler); the app's ECLS panel.
- **Read by:** the app's ECLS panel and diagram, `DataCollector` watchers.

## Usage in the model

- Used to model VA/VV ECMO support of a patient. For VA, set `drainage_site`/`return_site` to the
  patient compartments the cannulas are inserted into and pick the two cannula types. For VV, set
  `cannulation = "VV-DL"`, pick `dl_cannula_type` and the `drainage_site` (the return follows). Then
  set `ecls_running = true` and `ecls_clamped = false` and dial `pump_rpm` / `gas_flow` /
  `gas_fio2`.
- Reports `flow_avg`, `p_ven`/`p_int`/`p_art`, `sat_ven_o2`/`sat_postoxy_o2`/`pco2_postoxy` for the
  monitor.
- The blood sub-models exchange composition with the patient circuit through the named site
  compartments, so circuit O₂/CO₂ propagate back into the patient via the standard
  [BloodCapacitance](./BloodCapacitance.md) mixing.

## Assumptions and limitations

- **No recirculation model beyond the anatomy:** in VV the returned blood re-enters the drainage only as far as the mixing in the right atrium carries it; there is no separate recirculation fraction.
- **No circuit thrombosis, haemolysis, air or heparin effects.**

- **Stopping the circuit disables it.** The off-branch sets `is_enabled = false` on all sub-models
  (both sweep-gas valves included), so a stopped ECLS no longer conducts passive flow, and releases the
  heater-cooler (see below).
- **The heater-cooler releases cleanly.** Enabling `blood_temp_active` overrides `ECLS_OXY`'s own
  perfusion time constant with the fast `blood_temp_tc`; disabling it (or stopping ECLS) restores the
  compartment's original time constant and clears `temp_ext_override`, handing thermal control back to
  [`Thermoregulation`](./Thermoregulation.md) (which resumes warming `ECLS_OXY` toward core).
- **References are resolved lazily** each tick while running; a missing sub-model skips the tick rather
  than dereferencing undefined.
- **The pump is a `BloodVessel` driven by this device.** `ECLS_PUMP` is a [`BloodVessel`](./BloodVessel.md);
  the H-Q head and the roller flow source are applied by `Ecls` through its `p1_ext`/`p2_ext`. (A standby
  `BloodPump` class that mirrored this logic was removed in the v1.0 documentation pass.)
- **Flow is preload/afterload limited by the *circuit*, not the pump rating.** The H-Q curve sets the
  head; the cannula sizes and venous return set the achievable flow. A term neonate stays ~0.5 L/min
  even at high rpm (correct); increasing `pump_rpm` past the preload limit just raises head, not flow.
- **`flow` and `flow_avg` are in L/min** (`ECLS_RETURN.flow × 60`).

## History

### Crescent RA double-lumen cannulas (2026-10-12)

- `dl_cannulas` gains the Medtronic Crescent RA jugular dual-lumen catheter, 13 / 15 / 19 Fr, fitted
  to the brochure's pressure-flow chart (see the Circuit calibration table).
- `term_neonate_72h` VV at 2800 rpm: Crescent RA 13 Fr 0.43 L/min (`p_ven` −11) against Avalon Elite
  13 Fr 0.44 (−12); Crescent RA 15 Fr 0.63 (−9); Crescent RA 19 Fr 0.94 (+3).

### Pump height (2026-10-12)

- `pump_height` (cm below the patient, default 30) adds the hydrostatic column to the measured
  `p_ven`/`p_int`/`p_art`; new read-out `p_hydrostatic`. Read-out only, so flows are unchanged
  (checked headlessly: `term_neonate_72h` flow identical within run-to-run noise at 0 and 30 cm).
- `term_neonate_72h` at 2800 rpm: VV 13 Fr `p_ven` −36 → −12 mmHg, VA 12 Fr −17 → +6 mmHg. The user
  sees −10 to −20 mmHg on neonatal VV.

### Circuit calibration and double-lumen VV cannulation (2026-10-12)

- **Cannulas.** The cannulas are now flow-dependent: manufacturer pressure-drop charts, converted from
  water to blood, applied as a chord resistance at the circuit flow.
- **Tubing and oxygenator.** Tubing resistance now comes from the geometry (Poiseuille). The
  oxygenator resistance now comes from the selected device. PediMag H-Q: `hq_a` 17.85 → 21.16,
  `hq_b` 30.3 → 5.2, `hq_c` 0 → 15.4. See [Circuit calibration](#circuit-calibration).
- **VV cannulation.** `cannulation` / `dl_cannula_type` / `dl_cannulas` added. `VV-DL` puts both
  lumens of one Avalon Elite double-lumen cannula in the drainage site. The Medtronic Crescent
  entries were removed from the single-lumen libraries (their resistances were unsourced, and a VV
  cannula is one device).
- **Scenario clean-up.** `tubing_in_res` is live (in series on the pump inlet). The read-outs
  `drainage_dp`/`return_dp` were added. Eight scenarios (`fetus_30wk`, `term_fetus`, `tapvc`,
  `tapvc_obstructed`, `tof`, `tof_pa`, `tof_pink`, `tof_severe`) still embedded cannula (and some
  pump/oxygenator) library copies that override the class libraries. These were removed.
- **Effect.** VV (13 Fr DL) now needs about the same or slightly more rpm than VA (12/10 Fr) for the
  same flow, instead of ≈ 35 % fewer. Adult VA flows at high rpm are much lower and more plausible.

### Sweep-gas row in the diagram (2026-10-05)

- Every scenario's ECLS diagram block (`group: "ecls"`) gains the gas side: `ECLS_GAS_SOURCE`
  ("SWEEP"), `ECLS_GAS_OXY` (unlabelled, directly under `ECLS_OXY`) and `ECLS_GAS_OUT` ("EXHAUST"),
  joined by the connectors `ECLS_SWEEP_IN` (`ECLS_GAS_INSP_VALVE`) and `ECLS_SWEEP_OUT`
  (`ECLS_GAS_EXP_VALVE`). Sweep runs right to left, **countercurrent** to the blood as in a hollow-fibre
  oxygenator.
- Diagram data only. The gas nodes are grey and untinted, like `LUNG`, and their sizes are relative to
  the scenario's own `ECLS_OXY` (`fixed_size`), so the adult diagram scales them up too. The sweep dots
  follow the valve flow, so they stop at `gas_flow` 0 and keep moving while the blood side is clamped.
- To make room, the diagram's `settings.deviceBand` is 0.85 (default 0.5), and the cannula bypass tracks
  moved from 1.6 / 1.68 to 1.84 / 1.92, so a VV return line passes under the gas row.

### Merged right atrium → drainage reaches the whole venous return (2026-10-01)

- The ≈ 0.45 L/min (neonate) / ≈ 2.7 L/min (adult) drainage ceiling noted below was mostly caused by the
  **split right atrium**. `RAIVCI_RASVC` was closed (`no_flow`) in every scenario, so a `RASVC` cannula
  could only reach SVC return. Postnatal scenarios now merge the halves (see
  [HeartChamber](./HeartChamber.md#the-split-right-atrium)).
- `term_neonate_72h` VA (RASVC → AAR), PediMag: 4000 rpm → ≈ 1.06 L/min (p_ven ≈ −12 mmHg, was 0.45 at −135);
  5500 rpm → ≈ 1.5 L/min. Native LVO falls toward 0 as ECMO takes over the circulation.
- Follow-up: with the merged atrium, very high rpm now gives implausibly high flows, e.g. `adult_female`
  CentriMag ≈ 11 L/min at 5000 rpm. Neither caval/atrial collapse around the cannula (inflow limitation)
  nor possibly realistic adult cannula resistances are modelled yet.

### CentriMag H-Q refit to the manufacturer curves (2026-10-01)

- `pumps["Abbott CentriMag"]`: `hq_a` 24 → **23.17**, `hq_b` 11.1 → **0.85**, `hq_c` 0 → **0.38**,
  `max_rpm` 5000 → **5500**. This is a least-squares fit to the H-Q curves in the CentriMag Operation
  Manual (PL-0047 Rev 11, Fig. 14), RMS error 4.8 mmHg; the old coefficients were off by ≈ 216 mmHg
  RMS. The deadhead was about right (rpm² scaling holds, `hq_a` ≈ 23); the flow falloff was 5–7× too
  steep.
- Effect in `adult_female` (VA, RASVC → AAR): the crossover is unchanged at ≈ 2000 rpm. Flow rises much
  faster with rpm (≈ 2.6 L/min at 3000 vs 1.8 before) and reaches the drainage-limited plateau
  (≈ 2.7 L/min, RASVC empties) by ≈ 3000 rpm. That plateau is the venous-return / no-atrial-collapse
  limitation noted under "PediMag head corrected" below, and it is more apparent in the adult.
- The same manual also states a 540 mmHg "maximum pressure head" for the PediMag, which confirms its
  `hq_a` source. Since the CentriMag's 600 mmHg figure sits below its actual deadhead, the PediMag
  deadhead may likewise be somewhat higher than 540. Its `hq_a` is kept at 17.85, which the
  independent PediVAS operating points support.

### PediMag head corrected (2026-10-01)

- `pumps["Abbott PediMag"].hq_a` 9.9 → **17.85** mmHg/krpm². The old value assumed a ~300 mmHg deadhead
  at 5500 rpm; the published maximum outflow pressure is 540 mmHg (Wang et al 2020 *Artif Organs*).
  `hq_b` is unchanged; with it the corrected head reproduces the published PediVAS operating points
  (0.6 L/min @ 2800 rpm, 0.8 L/min @ 3200 rpm, 10 Fr return cannula). The class default, the standby
  `BloodPump` default and the six scenarios that set `pump_hq_a` explicitly were updated too. Those six
  (`fetus_30wk`, `term_fetus`, `tof*`) also embedded a full copy of the `pumps`/`oxygenators` libraries,
  which `init_model` copies over the class library and so pinned the old value. The copies were otherwise
  identical to the class libraries and have been removed, so these scenarios now inherit the library.
- Effect: in VA mode the centrifugal pump is non-occlusive, so flow reverses (aorta → circuit → RA)
  below the rpm whose zero-flow head equals the arterial–venous pressure difference:
  rpm_crossover = 1000·√(ΔP / hq_a). In `term_neonate_72h` (ΔP ≈ 57 mmHg) that moved from ≈ 2400 to
  ≈ 1750 rpm. (Rotaflow, `hq_a` 28: ≈ 1430 rpm.)
- Not changed, noted: with drainage from `RASVC`, ECLS flow plateaus around 0.4–0.45 L/min above
  ≈ 2800 rpm. Native output plus ECLS is then at the venous-return limit (RASVC empties, Pra ≈ −3 mmHg).
  More flow needs volume, which is realistic for neonatal full VA support. Atrial collapse around the
  cannula ("chatter") is not modelled, so the venous-line pressure keeps falling with rpm (−150 mmHg at
  4000, −370 mmHg at 5500) instead of the flow becoming unstable.

### Off by default (2026-10-01)

- All 39 scenarios now ship `ecls_running: false`. A clamped circuit is inert, and ECLS volume isn't
  counted in `Circulation.calc_blood_volumes`, so patient values are unchanged. Checked headlessly on
  `term_neonate_72h`: HR, MAP, SaO₂, pH and total blood volume are identical at 60 s.
- The stop branch now resolves its sub-model refs, so the circuit really is disabled from step 1, not
  only after its first run. It also zeroes the circuit resistors' flows on stop (no stale flow for the
  monitor or the diagram animation).

An audit of the ECLS model on 2026-07-21 fixed a set of correctness bugs and raised the physiological
fidelity of the pump, oxygenator, and cannula library. The audit was completed in a single session that
day (commits span 21:00–23:29), so this one date covers every change below. Commit hashes are on `main`.

### Correctness fixes (`298124e`, docs `c8abc7f`)

- **Pump-mode switch leak (A2).** Each `pump_mode` branch now zeroes the *inactive* vessel's external
  pressures, so switching centrifugal↔roller at runtime no longer leaves the previous mode's drive
  stuck on (double drive).
- **Roller-mode backward flow.** Roller mode drove the oxygenator's *upstream* node and pushed the
  circuit backward; it now drives the downstream node (`ECLS_OXY.p2_ext`), mirroring the centrifugal
  case, so it drives forward.
- **Heater-cooler residual state (A3).** The compartment's own `blood_temp_tc` is captured before the
  override and restored (via `_release_heater_cooler`) when the heater-cooler is disabled or ECLS stops,
  instead of leaving the fast device tc stuck on `ECLS_OXY`.
- **Sweep-gas inlet-valve controller (A4).** Replaced the fragile heuristic with the closed-form
  `R_insp = ΔP/Q − R_exp`, recomputed every update, reading the live expiratory-valve resistance, and
  shutting the sweep off (`no_flow`) when `gas_flow ≤ 0` instead of dividing by zero.
- **Expiratory sweep-gas valve (A5).** `ECLS_GAS_EXP_VALVE` is now resolved, enabled/disabled with the
  circuit, and its back-flow blocked so the fixed-pressure `ECLS_GAS_OUT` reservoir cannot back-fill the
  oxygenator gas side.
- **Inlet-tubing dead code (A1).** Removed the inert `r_for`/`r_back` write to `ECLS_TUBING_IN` (a
  `BloodCapacitance` that owns no resistor); `tubing_in_res` was vestigial. No behaviour change.
- `probe_ecls.mjs` gained sections D–F (pump mode, heater-cooler, sweep-gas controller).

### Pump physics (`bbd3ad8`, coefficients `7784c97`)

- Replaced the flow-independent `pump_pressure = −pump_rpm/25` with a real **head-flow (H-Q)
  characteristic** (`head = hq_a·(rpm/1000)² − hq_b·(rpm/1000)·Q`), a **roller flow-source** controller,
  and a **pump device library** (PediMag, CentriMag, Rotaflow RF-32, Bio-Pump BP-50, generic roller).
- H-Q coefficients **fit to published characteristics** — `hq_a` from the rpm²-scaled deadhead
  (Rotaflow anchored by two independent points), `hq_b` from rated flow. See [Pump device library](#pump-device-library).

### Oxygenator gas transfer (`494bb15`, `9602a13`, `bd22b0a`)

- **Rated-flow membrane limit (C1).** `GasExchanger` gained optional `o2_cap`/`co2_cap` ceilings
  (default 0 = legacy; the native lung `GASEX_LL`/`GASEX_RL` keep the exact old physics). ECLS drives
  them from an **oxygenator device library**, so post-oxygenator saturation now falls once blood flow
  exceeds the oxygenator's rated flow instead of pinning at ~100%.
- **Post-oxy blood-gas taps (C2).** `sat_postoxy_o2` / `pco2_postoxy` are read from `ECLS_OXY` (the true
  membrane compartment) rather than the downstream `ECLS_TUBING_OUT`.
- **Hyperoxia runaway fix (`bd22b0a`).** When an oxygenator drove blood O₂ content above the po₂ the
  composition solver could bracket, the solver left po₂ at the −1 sentinel; `GasExchanger` then read
  `po2_blood = −1` and pumped O₂ in at the capped rate every step — a self-sustaining runaway that
  inflated `to2` and pinned post-oxy saturation at −1 (seen on the adult scenarios, whose lower Hb
  reaches a higher po₂). Fixed by skipping the flux while a partial pressure is the −1 sentinel and
  raising the solver's po₂ ceiling 800 → 1000 mmHg. Native-lung ABG unchanged.

### Cannula library (`d47538e`, `c3f4278`)

- Added adult sizes (venous 21/23/25 Fr, arterial 15/17/19/21 Fr) and fixed the `Bio-Medicus` →
  `Biomedicus` key-naming mismatch so selections resolve.
- **Centralized** the catalogue in the constructor and removed the per-scenario embedded copies, so
  every scenario sees the full catalogue and any cannula can be selected in any scenario
  (behaviour-neutral: all scenarios resolve to their shipped resistances).

## References

The cannula, pump and oxygenator libraries are calibrated to the manufacturers' pressure-drop, head–flow and transfer charts (Bio-Medicus, Avalon Elite, Crescent, CentriMag, PediMag, Quadrox-i, Nautilus); see [Circuit calibration](#circuit-calibration).

````

### FILE: explain-engine/docs/Fluids.md

````markdown
# Fluids

`Fluids` gives fluids into the blood: timed **boluses and infusions** of named fluids (saline, Ringer's lactate, packed red cells, albumin, dextrose), and a continuous **maintenance** intake that replaces what the kidneys excrete. Each fluid is a composition (solutes in mmol/L, albumin in g/L, no O2 or CO2) mixed into a blood compartment through its normal `volume_in`, so everything it carries spreads with the circulation.

## Physiology

Fluid therapy changes the blood in three ways:
- **volume:** preload, cardiac output, blood pressure;
- **dilution:** haemoglobin, albumin and everything the fluid lacks;
- **composition:**
  - normal saline (154 mmol/L Na and Cl) lowers the strong ion difference and causes a hyperchloraemic acidosis;
  - Ringer's lactate is "balanced" (its lactate is metabolised to bicarbonate);
  - packed red cells raise haemoglobin;
  - 20 % albumin raises the oncotic pressure;
  - dextrose provides glucose.

A newborn's maintenance intake (feeds or IV fluid) replaces urine, insensible losses and growth.

## Inheritance

```
BaseModelClass
  └── Fluids
```

## Properties

### Config (set in the definition JSON)

| Property | Unit | Default | Description |
|---|---|---|---|
| `fluids` | {name: {solute: value}} | `{}` | The fluid library (see the table below). |
| `fluids_temp` | °C | 37 | Temperature of given fluids. |
| `maintenance_rate` | mL/kg/h | 0 | Continuous maintenance intake. term_neonate_72h 1.35. |
| `maintenance_fluid` | – | `"maintenance"` | Its composition (a key in `fluids`; missing = water). |
| `maintenance_site` | – | `"IVCI"` | Compartment receiving it. |

### State (saved with the state)

| Property | Description |
|---|---|
| `running_fluids` | Boluses and infusions in progress: `{vol, time_left, delta, site, to2, tco2, temp, solutes, drugs}` each. A state saved mid-bolus finishes it after reload. |

### The fluid library (every scenario)

| Fluid | Composition |
|---|---|
| `normal_saline` | Na 154, Cl 154 |
| `ringers_lactate` | Na 130, Cl 109, K 4, Ca 1.4, lactate 28 |
| `packed_cells` | Hb 12 mmol/L (~19 g/dL), Na 140, K 4.5, Cl 105, glucose 25: a fresh unit with a plasma-equivalent base |
| `albumin_20%` | albumin 200 g/L, Na 130, Cl 42, unmeasured anions 32 (the caprylate and tryptophan stabilisers) |
| `d5`, `d10` | glucose 278, 555 |
| `maintenance` | per scenario: the resting urine composition (term Na 69, K 20.6, Cl 64, …), so intake balances output |

## Calculation

**`add_volume(volume, in_time = 10, fluid_in = "normal_saline", site = "VLB")`** (mL, s) queues a fluid: `delta = volume / (in_time / 0.015)` per update, with the fluid's composition copied from the library (an unknown name gives pure water).

**Every 15 ms:**
1. Finished entries are dropped. For each running entry, `site.volume_in(delta, fluid)` mixes the increment in, then `time_left` counts down. A missing site is skipped.
2. **Maintenance:** `maintenance_rate · weight / 1000 · Δt / 3600` L of the maintenance fluid into `maintenance_site`.

**Effects** (term_neonate_72h, 20 mL/kg over 10 min, read 1 min later):

| Fluid | Hb (mmol/L) | Albumin (g/L) | Na | Lactate | BE | MAP |
|---|---|---|---|---|---|---|
| before | 10.0 | 25 | 138 | 1.5 | −2.4 | 58 |
| normal saline | 8.0 | 20 | 141 | 1.3 | **−7.1** | 62 |
| Ringer's lactate | 8.0 | 20 | 137 | **4.2** | −4.3 | 61 |
| 20 % albumin, 5 mL/kg | 9.4 | **35** | 138 | 1.5 | −3.7 | 59 |
| packed cells, 15 mL/kg | 10.3 | 21 | 139 | 1.4 | +0.2 | 66 |

## Factor system

None.

## Inputs and outputs

- **Reads:** the fluid library; `model.weight`.
- **Writes:** the target compartment, through `volume_in` (volume and composition).
- **Written by:** the user and bot (`add_volume`, rates); the scenario generators (maintenance rate and composition).
- **Read by:** `DataCollector` watchers.

## Assumptions and limitations

- **Everything stays in the blood.** There is no interstitial compartment, so all of a crystalloid bolus stays intravascular, where in vivo most leaves within minutes. Dilution and its acid–base effect are therefore stronger than in vivo, and albumin draws no fluid in.
- **Gas-free fluids:** a bolus dilutes O2 and CO2 content and haemoglobin (and so viscosity), as intended.
- **Packed cells are a fresh unit:** no storage lesion (high K, low pH, lactate), no citrate effect on calcium.
- **Ringer's lactate's lactate is cleared by [Lactate](./Lactate.md)** toward its baseline (half-life ~6 min), standing in for hepatic metabolism; no bicarbonate is generated beyond what the lower lactate implies.
- **Timing:** boluses run on the 15 ms update; the last increment can overshoot by a fraction of a step (< 0.1 %).

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Fluids` (trimmed to two fluids):

```json
{
  "name": "Fluids",
  "model_type": "Fluids",
  "is_enabled": true,
  "fluids_temp": 37,
  "fluids": {
    "normal_saline": { "na": 154, "cl": 154 },
    "ringers_lactate": { "na": 130, "cl": 109, "ca": 1.4, "k": 4, "lact": 28 }
  },
  "maintenance_rate": 1.352,
  "maintenance_fluid": "maintenance",
  "maintenance_site": "IVCI"
}
```

## Usage in the scenarios

One instance in every scenario with the library above; maintenance 1.35 mL/kg/h in term_neonate_72h, matching its resting urine output.

## References

Standard product compositions. 20 % albumin's anions are an estimate from its charge at 200 g/L plus the stabilisers.

````

### FILE: explain-engine/docs/Gas.md

````markdown
# Gas

`Gas` manages the gas side of the model, the counterpart of [Blood](./Blood.md); it is not a compartment. At build it gives every gas compartment the atmospheric pressure, temperature, humidity and starting composition. At runtime it provides the setters for FiO2, ambient temperature and humidity, and altitude, and it couples the airway's temperature to the body's.

## Physiology

The air a baby breathes is cool and dry: about 20 °C and 50 % humidity in a room, 21 % O2. On its way in, the nose and airways warm it to body temperature and saturate it with water vapour, so alveolar gas is 37 °C and 100 % humid, with a water vapour pressure of ~47 mmHg that dilutes the other gases. Conditioning the gas costs the body heat and water, a real loss in a small preterm infant (which is why gases are heated and humidified on a ventilator).

The partial pressure of inspired O2 is FiO2 × (barometric pressure − water vapour pressure). At altitude, a lower barometric pressure lowers it at the same FiO2.

## Inheritance

```
BaseModelClass
  └── Gas
```

## Properties

### Config (set in the definition JSON)

| Property | Unit | Default | Description |
|---|---|---|---|
| `pres_atm` | mmHg | 760 | Atmospheric pressure, given to every gas compartment. |
| `fio2` | – | 0.21 | Dry O2 fraction applied to fresh compartments and the sources at build. Afterwards: the last value given to `set_fio2`. Scenarios 0.21–0.30. |
| `temp` | °C | 20 | Temperature given to every gas compartment at build, before `temp_settings`. |
| `humidity` | – | 0.5 | Default relative humidity. |
| `temp_settings` | {name: °C} | `{}` | Per-compartment temperature. Scenarios: MOUTH 20, DS 32, ALL 37, ALR 37. |
| `humidity_settings` | {name: fraction} | `{}` | Per-compartment humidity. Scenarios: MOUTH 0.5, DS/ALL/ALR 1. |
| `thermoregulation_name` | – | `"Thermoregulation"` | Model whose `setpoint_temp` anchors the airway offsets. |
| `gas_containing_modeltypes` | list | `["GasCapacitance"]` | Model types treated as gas compartments. |

## Calculation

`calc_model` does nothing; the gas physics run in [GasCapacitance](./GasCapacitance.md) and [GasComposition](./GasComposition.md). All the work is at build and in the methods.

**Build (`init_model`):**
1. Every gas compartment gets `pres_atm`, and `temp` and `target_temp` from `temp`; then `temp_settings` and `humidity_settings` are applied by name.
2. A compartment with no gas at all is filled by [`calc_gas_composition`](./GasComposition.md) from `fio2`, its temperature and humidity. A loaded state keeps its own composition.
3. A compartment whose water vapour exceeds saturation at its final temperature is rebuilt (e.g. an idle ventilator circuit bootstrapped warmer by its device).
4. The fixed-composition sources named in the settings (MOUTH) are rebuilt from `fio2`, temperature and humidity, so the scenario's settings reach them.
5. For each body-warmed compartment (the non-fixed members of `temp_settings`: DS, ALL, ALR), its offset from the body set-point is stored: DS −5 °C, alveoli 0.

## Methods

| Method | Effect |
|---|---|
| `set_fio2(fio2, sites = ["OUT", "MOUTH"])` | Rebuilds each named site's composition at `fio2`; stores `fio2`. Absent sites are skipped (no scenario has `OUT`). Room-air FiO2 is set on MOUTH. |
| `set_temperature(t, sites = ["OUT", "MOUTH"])` | Adds the sites to `temp_settings` and re-applies all of them (`temp`, `target_temp`). Fixed sources are rebuilt with their **own** dry FiO2 (their water content follows the new temperature). |
| `set_humidity(h, sites = ["OUT", "MOUTH"])` | Same for humidity. Airway compartments relax to the new humidity on their own; fixed sources are rebuilt with their own FiO2. |
| `set_atmospheric_pressure(p)` | `pres_atm` on every gas compartment. In term_neonate_72h, 760 → 600 mmHg lowers mouth pO2 from 158 to 125 mmHg, alveolar pO2 105 → 76 and post-ductal pO2 73 → 57 mmHg (SO2 96.7 → 94.7 %) within 2 min. |
| `set_body_temperature(core)` | Called by Thermoregulation: `target_temp` of each body-warmed compartment = core + its stored offset, so fever and hypothermia reach the alveoli (and the dead space stays 5 °C below). Neutral at rest. |
| `drain_respiratory_heat()` | Called by Thermoregulation: returns and clears the heat (J, sensible + latent) the body-warmed compartments gave to the gas since the last call. |

## Factor system

None.

## Inputs and outputs

- **Reads:** `Thermoregulation.setpoint_temp` (build); the body-warmed compartments' heat accumulators.
- **Writes:** every gas compartment's `pres_atm`, `temp`, `target_temp`, `humidity`, and composition through `calc_gas_composition`.
- **Written by:** the user and bot (FiO2, temperature, humidity, altitude); Thermoregulation (`set_body_temperature`, `drain_respiratory_heat`).
- **Read by:** Thermoregulation (respiratory heat loss).

## Assumptions and limitations

- **Membership by `model_type` string**, as in Blood: a custom gas compartment type must be added to `gas_containing_modeltypes`.
- **Rebuilding a source discards its history.** `calc_gas_composition` writes a fresh composition (ambient CO2 0.04 %); this is why only fixed sources are rebuilt by the setters, never airway compartments.
- **The setters' sites accumulate.** A site passed to `set_temperature` or `set_humidity` stays in the settings and is re-applied on every later call.
- **Devices own their gas lines.** Ventilator and ECLS gas compartments receive `pres_atm` and the default temperature here but are set by their device; they are not in `temp_settings`.
- **Altitude changes only the ambient pressure.** No hypoxic ventilatory acclimatisation, no change in gas density.

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Gas` (trimmed to the config props):

```json
{
  "name": "Gas",
  "model_type": "Gas",
  "is_enabled": true,
  "pres_atm": 760,
  "fio2": 0.21,
  "temp": 20,
  "humidity": 0.5,
  "temp_settings": { "MOUTH": 20, "DS": 32, "ALL": 37, "ALR": 37 },
  "humidity_settings": { "MOUTH": 0.5, "DS": 1, "ALL": 1, "ALR": 1 },
  "thermoregulation_name": "Thermoregulation",
  "gas_containing_modeltypes": ["GasCapacitance"]
}
```

## Usage in the scenarios

One instance in every scenario, with the settings above. `fio2` 0.21 in term_neonate_72h.

## References

No literature values; the temperatures and humidities are the conventional room and airway values.

````

### FILE: explain-engine/docs/GasCapacitance.md

````markdown
# GasCapacitance

A `GasCapacitance` is a compliant gas compartment: the mouth, the airway dead space, the alveoli, and the gas lines of the ventilator and the ECLS oxygenator. On top of [Capacitance](./Capacitance.md)'s pressure–volume behaviour it carries a gas composition (O2, CO2, N2, water vapour, other), absolute pressure, temperature and humidity. Gas mixes in with every inflow, is warmed and humidified by the wall, and expands and contracts with temperature (ideal gas law). The airway dead space can carry its gas as a plug through a chain of sub-tanks instead of one well-mixed volume.

## Physiology

Air moves into the lungs because the alveolar pressure falls below the pressure at the mouth. On the way it is warmed and saturated with water by the airway lining; the heat and water come from the body. The first gas to reach the alveoli is the gas left in the **dead space** (the conducting airways) from the last expiration, rich in CO2. Only the part of each breath beyond the dead-space volume brings fresh gas, so alveolar ventilation = (tidal volume − dead space) × rate. With very small breaths, as in high-frequency oscillation, gas transport depends on dispersion along the airways rather than bulk flow.

Partial pressures follow Dalton's law: each gas's share of the molecules times the total pressure. The capnograph at the airway opening sees the gas at the mouth end of the dead space.

## Inheritance

```
BaseModelClass
  └── Capacitance
        └── GasCapacitance
```

## Properties

Volume, unstressed volume, elastances and their factor layers, `pres_ext` and `fixed_composition` come from [Capacitance](./Capacitance.md#properties). `fixed_composition: true` makes an **infinite reservoir**: volume, composition, temperature and water all stay constant (MOUTH, `VENT_GASIN`, `ECLS_GAS_SOURCE`).

### Config (set in the definition JSON)

| Property | Unit | Default | Description |
|---|---|---|---|
| `pres_atm` | mmHg | 760 | Atmospheric pressure; set by [Gas](./Gas.md). |
| `target_temp` | °C | 0 | Temperature the wall warms the gas toward; set by Gas (and, for the body-warmed compartments, from core temperature). |
| `humidity` | fraction | 1.0 | How wet the wall is: the relative humidity evaporation can reach (airway mucosa 1, dry gas line 0, MOUTH 0.5). |
| `temp_tc` | s | 1.0 | Thermal equilibration time constant. |
| `h2o_tc` | s | 0.2 | Water vapour equilibration time constant. |

### Config: series dead space (set by Respiration and the Ventilator)

| Property | Unit | Default | Description |
|---|---|---|---|
| `series_segments` | – | 1 | Number of composition sub-tanks; 1 = well mixed. DS: 32 in every scenario. |
| `distal_models` | list | `[]` | Neighbours at the distal end (DS: `ALL`, `ALR`). |
| `dispersion_coeff` | – | 0 | Flow-driven (Taylor-type) axial dispersion strength. DS: 0.015. |
| `dispersion_tau_max` | s | 0.1 | Cap on the one-way flow time in the dispersion term. |
| `diffusion_rate` | L/s per interface | 0 | Flow-independent (molecular) exchange. DS: 1e-5. |
| `tube_port_model` | – | `""` | Neighbour reached through the ET-tube lumen (the ventilator circuit); set by the Ventilator. |
| `tube_volume` | L | 0 | Rigid ET-tube lumen ahead of the tube port: π r² L while intubated, 0 otherwise (4 mm × 110 mm = 1.4 mL). |
| `tube_segments` | – | 3 | Sub-tanks of the tube lumen. |

### Outputs

| Property | Unit | Description |
|---|---|---|
| `pres` | mmHg | Absolute pressure: recoil + `pres_ext` + `pres_atm`. |
| `pres_rel` | mmHg | Pressure relative to atmospheric (airway / alveolar pressure as a clinician reads it). |
| `temp` | °C | Gas temperature. |
| `ctotal` | mmol/L | Total gas concentration. |
| `co2`, `cco2`, `cn2`, `ch2o`, `cother` | mmol/L | Concentrations per species. |
| `po2`, `pco2`, `pn2`, `ph2o`, `pother` | mmHg | Partial pressures. |
| `fo2`, `fco2`, `fn2`, `fh2o`, `fother` | – | Fractions of the (wet) gas. |

With series dead space on, the partial pressures and fractions are those of the **airway-opening** sub-tank (what a capnograph samples); the concentrations are the bulk mean.

## Calculation

Each step (`calc_model`):

1. **`add_heat`** (not for fixed compartments). Relax `temp` toward `target_temp`: `dT = (target − temp) · min(1, dt/temp_tc)`. The gas expands by `dV = n·R·dT / p` and every concentration dilutes by `V₀/V₁` (heating moves no molecules). The sensible heat drawn from the wall, `n · 29.1 J/(mol·K) · dT`, is metered.
2. **`add_watervapour`** (not for fixed compartments). Asymmetric target:
   - **evaporate** up to `humidity × SVP(temp)` (see [Units](./Units.md));
   - **condense** only out of supersaturation, down to `SVP(temp)`;
   - in between, the wall is neither source nor sink (a dry gas line doesn't dehumidify wet gas).

   The water concentration for the target is solved directly and approached with `min(1, dt/h2o_tc)`. Dry species dilute (or concentrate) by `V₀/V₁`. The latent heat, 43.4 kJ/mol, is metered; condensing returns it.
3. With series dead space: the same change is replayed on every sub-tank, then dispersion and diffusion between sub-tanks.
4. **Elastances, volumes, pressure** (Capacitance): `pres = recoil + pres_ext + pres_atm`; `pres_ext` is reset.
5. **`calc_gas_composition`:** `ctotal` = sum of the species; partial pressure = (c / ctotal) × `pres`; fractions likewise.

**Mixing (`volume_in`).** An inflow of `dvol` from a neighbour mixes in by volume: `c = (c·V + (c_in − c)·dvol) / V`, and the same for temperature. Before that:
- A **fixed-composition receiver** stays unchanged.
- **Gas from a pressurised fixed source** (e.g. the 1160 mmHg ventilator supply) is rescaled by `P_here / P_source`, so it arrives at the receiver's molar density; fractions are unchanged.
- **Between two ordinary compartments there is no rescaling,** so every molecule the donor loses arrives (rescaling there lost ~1 % of VO2 per transfer).

The incoming parcel keeps its temperature; `add_heat` handles the thermal expansion.

**Respiratory heat.** The metered heat (`_q_wall_sensible`, `_q_wall_latent`, signed: cooling and condensation credit the wall) is collected by `Gas.drain_respiratory_heat()` for Thermoregulation.

## Series dead space

A single well-mixed compartment is a poor dead space: mixing makes part of it "ventilated", so its effective dead space barely grows with its volume, and oscillatory flow (HFOV) is perfectly mixed every cycle. With `series_segments > 1` the compartment keeps **one pressure/volume node** (the network is unchanged) but carries its composition through a chain of sub-tanks, proximal → distal:

```
[ tube lumen sub-tanks (rigid, only while intubated) ] [ DS sub-tanks (share vol equally) ]
  ^ tube port (VENT_GASCIRCUIT)                        ^ airway port (MOUTH, leak)   distal port ^ (ALL, ALR)
```

- **Ports.** A neighbour in `distal_models` connects at the distal end; `tube_port_model` through the rigid tube sub-tanks; anything else (mouth, tube leak) at the proximal DS end.
- **Advection.** An inflow enters its end and every DS sub-tank grows by dvol/n, pushing gas along. An outflow leaves from the receiver's end. The donor side runs through `_seg_take`, called by the receiver's `volume_in`, so resistors need no changes.
- **Dispersion.** Neighbouring sub-tanks exchange `e = dispersion_coeff · q² · τ · dt / V_seg`: Taylor-type `u²·τ` dispersion written per segment (no airway geometry needed). τ is the time flow has run one way, capped at `dispersion_tau_max`, so fast oscillation disperses in proportion to f·Vt². Mass-conserving between unequal sub-tanks.
- **Molecular diffusion** (`diffusion_rate`) acts also without flow, so the dead space keeps mixing during apnoea.
- **Ends.** `_end_conc(neighbour)` / `_end_add(neighbour, dn)` read and change the sub-tank facing a neighbour; the gas `mix_flow` of a [Resistor](./Resistor.md#mixing-without-net-flow-mix_flow) uses them.
- **Bulk.** The bulk concentrations equal the mean of the DS sub-tanks, so heat, water and the gas law work unchanged.

Calibration when it was introduced (`scripts/probe_dead_space.mjs`, preterm_28wk, PRVC 5 mL/kg; HFOV with a 2.5 mm tube):

| Check | Well-mixed (1) | Series (32, dispersion 0.015) |
|---|---|---|
| PaCO2 with DS +0 / +50 / +100 % | 67 / 70 / 72 | 81 / 98 / 122, as (Vt − VD)·rate predicts |
| HFOV PaCO2 at 6 / 10 / 15 Hz | 10 / 11 / 11 (no frequency effect) | f·Vt² law: PaCO2·DCO2 constant within ±8 % over 8–15 Hz × amplitude 15–30 |
| Sub-tank count | – | 8 → 16 → 32 still changes HFOV (numerical dispersion), so the count is fixed at 32 and the dispersion term carries the transport |
| Runtime | – | +7–9 % |

## Factor system

[Capacitance](./Capacitance.md#factor-system)'s additive layers on `el_base`, `el_k` and `u_vol`. Surfactant, atelectasis and the Calibrator act on the alveoli through them.

## Inputs and outputs

- **Reads:** neighbours' composition and temperature (through `volume_in`); `pres_ext` written by others.
- **Written by:**
  - [Gas](./Gas.md) (`pres_atm`, `temp`, `target_temp`, `humidity`, composition);
  - [Respiration](./Respiration.md) (series dead space on DS);
  - the Ventilator (`tube_volume`, `tube_port_model`);
  - Breathing and the thorax coupling (`pres_ext`);
  - GasExchanger (`co2`, `cco2`);
  - the devices (their own gas lines).
- **Read by:** GasExchanger (alveolar pO2/pCO2), Monitor (etCO2, airway pressure), the Ventilator, `DataCollector` watchers.

## Assumptions and limitations

- **The airway wall is an unlimited water source.** Water loss isn't tracked; the heat is (metered for Thermoregulation). Condensate leaves the system.
- **Brief supersaturation on expiration is real.** Condensation lags (`h2o_tc`), so the dead space can sit slightly above 100 % RH while warm alveolar gas flows into it. In term_neonate_72h it swings between ~68 % and 102 % RH over a breath (22–35 °C). Sample a full cycle.
- **Humidifying inspired gas barely changes alveolar gas,** correctly: MOUTH 50 → 100 % RH moves alveolar pH2O ~0.2 mmHg, because the airway saturates the gas anyway. The clinical benefit of a humidifier (sparing the mucosa) has nothing to attach to, since the wall has no water debt.
- **Fixed-composition compartments don't self-correct.** Their temperature and humidity change only through `Gas.set_temperature` / `set_humidity`, which rebuild the composition.
- **No water or heat crosses the blood–gas barrier.**
- **Ideal gas, single heat capacity** (air's 29.1 J/(mol·K), also for water vapour).
- **Pressures are absolute.** Compare against `pres_atm`, or use `pres_rel`.

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Respiration.components.ALL` (trimmed to the config props; `target_temp` rounded):

```json
{
  "name": "ALL",
  "model_type": "GasCapacitance",
  "is_enabled": true,
  "fixed_composition": false,
  "u_vol": 0.04,
  "el_base": 331.94,
  "el_k": 0,
  "pres_atm": 760,
  "target_temp": 36.99,
  "humidity": 1,
  "temp_tc": 1,
  "h2o_tc": 0.2,
  "series_segments": 1
}
```

## Usage in the scenarios

Ten instances in every scenario:

| Compartment | Role | Notes |
|---|---|---|
| `MOUTH` | Room air | fixed, 20 °C, 50 % RH |
| `DS` | Airway dead space | 32 series sub-tanks, 32 °C, 100 % RH |
| `ALL`, `ALR` | Left and right alveoli | 37 °C, 100 % RH |
| `VENT_GASIN`, `VENT_GASCIRCUIT`, `VENT_GASOUT` | Ventilator supply, circuit, exhaust | `VENT_GASIN` fixed (pressurised source) |
| `ECLS_GAS_SOURCE`, `ECLS_GAS_OXY`, `ECLS_GAS_OUT` | Oxygenator sweep gas | source fixed |

## References

- Taylor GI. Dispersion of soluble matter in solvent flowing slowly through a tube. *Proc R Soc Lond A* 1953;219:186–203 (the `u²·τ` dispersion form).

````

### FILE: explain-engine/docs/GasComposition.md

````markdown
# GasComposition

`GasComposition` holds one function, `calc_gas_composition(gc, fio2, temp, humidity, fico2)`. It **overwrites** a gas compartment's whole composition with fresh gas of a given dry O2 (and CO2) fraction, at the compartment's current pressure, the given temperature and humidity. It initialises gas compartments and sets gas sources (room air, ventilator and oxygenator supply). It is a module of functions, not a model class.

The per-step partial pressures of a compartment are computed by its own method [`GasCapacitance.calc_gas_composition()`](./GasCapacitance.md#calculation), not by this function.

## Physiology

"FiO2 0.21" means 21 % of the **dry** gas is O2. Once the gas is humidified, water vapour takes its share of the total pressure, and the other gases share what's left:

```
pO2 = FiO2 · (P − pH2O)        in room air at 37 °C, 100 % RH: 0.21 · (760 − 47) ≈ 150 mmHg
```

## API

```js
import { calc_gas_composition } from "./component_models/GasComposition.js";
calc_gas_composition(gc, fio2 = 0.205, temp = 37, humidity = 1.0, fico2 = 0.000392);
```

| Argument | Unit | Default | Description |
|---|---|---|---|
| `gc` | – | – | A GasCapacitance. |
| `fio2` | – | 0.205 | Dry O2 fraction, clamped 0–1. Callers always pass it (Gas uses 0.21 at room air). |
| `temp` | °C | 37 | Temperature; written to `gc.temp`. |
| `humidity` | – | 1.0 | Relative humidity 0–1; written to `gc.humidity`. |
| `fico2` | – | 0.000392 | Dry CO2 fraction (ambient ~0.04 %), clamped to `1 − fio2`. Only the ECLS sweep gas passes its own. |

**Writes on `gc`:** `temp`, `humidity`, `ctotal`, and for each species (O2, CO2, N2, H2O, other) the concentration, partial pressure and fraction. It also refreshes `gc.pres` by running the compartment's elastance, volume and pressure calculations, without stepping it (no heat or water exchange).

## Calculation

1. **Dry mix.** O2 = `fio2`, CO2 = `fico2`; N2 takes the rest (the reference N2 share is rescaled to `1 − fio2 − fico2`; "other" is 0).
2. **Pressure:** `gc.pres` from the current volume. If it isn't positive, it returns after setting `temp` and `humidity`, leaving the composition unchanged.
3. **Total concentration** from the ideal gas law: `ctotal = P / (R·(273.15 + temp)) · 1000` (mmol/L).
4. **Water vapour:** `pH2O = svp_h2o(temp) · humidity` (see [Units](./Units.md)); `fH2O = pH2O/P`.
5. **Each dry species:** `p = f_dry · (P − pH2O)`, fraction `p/P`, concentration `fraction · ctotal`.

## Assumptions and limitations

- **`fo2` reads below the FiO2 you set.** It is the fraction of the *wet* gas: `fio2 · (1 − fH2O)`. At 20 °C and 50 % RH (MOUTH), 0.21 becomes 0.208. Divide by `1 − fh2o` for the dry fraction.
- **It discards the compartment's history,** including its CO2. That is why [Gas](./Gas.md) only rebuilds fixed sources at runtime, never airway compartments.
- **Dry air is O2 + N2 + CO2.** Argon (0.93 %) is counted as N2; "other" (e.g. an anaesthetic or helium) is always 0 here.
- **Uses the compartment's current pressure.** A source rebuilt at an elevated pressure (the 1160 mmHg ventilator supply) gets the matching molar density.

## Callers

| Caller | Compartments | When |
|---|---|---|
| [Gas](./Gas.md) | every gas compartment without gas; supersaturated ones; MOUTH | build; `set_fio2`, `set_temperature`, `set_humidity` |
| [Ventilator](./Ventilator.md) | `VENT_GASIN`, `VENT_GASCIRCUIT`, `VENT_GASOUT` | build, FiO2 / temperature / humidity changes |
| [Ecls](./Ecls.md) | `ECLS_GAS_SOURCE` | sweep-gas FiO2, CO2, temperature or humidity changes |

## References

None; ideal gas law and Dalton's law.

````

### FILE: explain-engine/docs/GasExchanger.md

````markdown
# GasExchanger

A `GasExchanger` moves O2 and CO2 by diffusion between a **blood** compartment and a **gas** compartment: the alveolar gas and pulmonary capillary blood of each lung, and the sweep gas and blood of the ECLS oxygenator. Every bit of oxygen the patient takes up and CO2 it removes through the lungs crosses one of these.

## Physiology

In the alveoli, gas and blood are separated by a membrane less than a micrometre thick. O2 diffuses from the alveolar gas (pO2 ~100 mmHg) into the mixed-venous blood (~40 mmHg), and CO2 the other way. The rate is Fick's law: flux = diffusing capacity × partial-pressure difference. The diffusing capacity lumps membrane area, thickness and the gas's solubility; CO2 diffuses about 20 times more easily than O2. In a healthy lung, blood equilibrates with alveolar gas well within its transit time, so oxygenation is limited by ventilation and perfusion, not diffusion. Lung disease (RDS, atelectasis, oedema) lowers the effective capacity by removing area.

The exchange also changes the gas volume: more O2 is taken up than CO2 given off (respiratory quotient < 1), so alveolar gas shrinks a little with every breath. During apnoea that shrinkage draws gas down the airways: apnoeic oxygenation.

## Inheritance

```
BaseModelClass
  └── GasExchanger
```

## Properties

### Config (set in the definition JSON)

| Property | Unit | Default | Description |
|---|---|---|---|
| `comp_blood` | – | `""` | Blood compartment (e.g. `LL_CAP`, `ECLS_OXY`). |
| `comp_gas` | – | `""` | Gas compartment (e.g. `ALL`, `ECLS_GAS_OXY`). |
| `dif_o2` | mmol/(mmHg·s) | 0 | O2 diffusing capacity. |
| `dif_co2` | mmol/(mmHg·s) | 0 | CO2 diffusing capacity. |
| `o2_cap`, `co2_cap` | mmol/s | 0, 0 | Optional membrane transfer ceiling; 0 = none. Only the ECLS oxygenator uses it (set by `Ecls` from the oxygenator's rated flow). |
| `bc_interval` | s | 0.002 | How often the blood-gas solve runs; fluxes in between use the last pO2/pCO2. |

### Factors

| Property | Default | Layer and writers |
|---|---|---|
| `dif_o2_factor`, `dif_co2_factor` | 1.0 | Non-persistent (reset each step): `Surfactant` (derecruitment). |
| `dif_o2_factor_ps`, `dif_co2_factor_ps` | 1.0 | Persistent, changed as deltas: `Respiration` (`set_gasexchange` and atelectasis), the `Calibrator`. |
| `dif_o2_factor_scaling_ps`, `dif_co2_factor_scaling_ps` | 1.0 | Scaling layer; nothing writes it. (Named `*_factor_scaling` before v1.0.) |

### Outputs

| Property | Unit | Description |
|---|---|---|
| `flux_o2`, `flux_co2` | mmol per step | Amount moved this step, positive = blood → gas (O2 uptake is negative). Divide by the step size for a rate. |
| `dif_o2_step`, `dif_co2_step` | mmol/(mmHg·s) | Effective diffusing capacities with the factors. |

## Calculation

Each step (skipped if either compartment is missing or empty):

1. **Blood gases** of `comp_blood` by [`calc_blood_composition`](./BloodComposition.md), every `bc_interval`. The gas side's partial pressures come from its own step.
2. **Factors**, additive, floored at 0 (several writers lowering them together must not make a negative capacity):
   ```
   dif_step = dif · (1 + (factor − 1) + (factor_ps − 1) + (factor_scaling_ps − 1)),   ≥ 0
   ```
3. **Fluxes** (Fick):
   ```
   flux_o2  = (pO2_blood  − pO2_gas)  · dif_o2_step  · dt
   flux_co2 = (pCO2_blood − pCO2_gas) · dif_co2_step · dt
   ```
   - A gas is skipped while the blood solve has failed (the `-1` sentinel); otherwise the gradient would pump a runaway flux.
   - With a ceiling set, each flux is clamped to `cap · dt`.
   - Each flux is capped at what the donor holds.
4. **Contents.** Blood `to2`/`tco2` and gas `co2`/`cco2` change by the flux over their volumes (a `fixed_composition` side is left unchanged).
5. **Gas volume.** The net molar exchange `flux_o2 + flux_co2` changes the gas volume at the gas compartment's pressure and temperature (ideal gas); every species keeps its moles in the new volume. Alveolar gas shrinks when uptake exceeds output, and the pressure drop draws gas in through the airways.

## Factor system

Additive layers, as in [Capacitance](./Capacitance.md#factor-system), with a floor at 0. See [ARCHITECTURE §7a](./ARCHITECTURE.md#7a-the-factor--effective-value-pattern).

## Inputs and outputs

- **Reads:** blood `po2`, `pco2`, `to2`, `tco2`, `vol`; gas `po2`, `pco2`, `co2`, `cco2`, `vol`, `pres`, `temp`.
- **Writes:** blood `to2`, `tco2` (and its solved gases); gas `co2`, `cco2`, every gas concentration and `vol` (volume change).
- **Written by:** `Surfactant`, `Respiration`, the `Calibrator` (factors); `Ecls` (`dif_o2`, `dif_co2`, `o2_cap`, `co2_cap` of `ECLS_GASEX`); the scenario generators (`dif_o2`, `dif_co2`).
- **Read by:** `DataCollector` watchers; the probes (`flux_o2` as VO2).

## Assumptions and limitations

- **Fick diffusion between two well-mixed compartments.** No capillary transit time, no end-capillary equilibration profile, no diffusion limitation that appears only at high cardiac output. Ventilation–perfusion mismatch comes from the network (intrapulmonary shunts, two lungs), not from inside the exchanger.
- **The CO2/O2 capacity ratio is 6 in every scenario,** a calibration value (`scripts/reseed_term_neonate.mjs` raised CO2 sixfold), not the physical ~20.
- **Diffusing capacities are per scenario,** set by the generators: term_neonate_72h 0.001 / 0.006 per lung. As a lung DLO2 that is ~2.7 mL/(min·mmHg) at term (0.76 per kg).
- **The fetal lungs exchange nothing** (`dif_o2` = `dif_co2` = 0), but the exchangers still run their blood solve.
- **No water vapour or nitrogen crosses the membrane** (no N2 washout into blood, no absorption atelectasis from N2).

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Respiration.components.GASEX_LL` (trimmed to the config props):

```json
{
  "name": "GASEX_LL",
  "model_type": "GasExchanger",
  "is_enabled": true,
  "comp_blood": "LL_CAP",
  "comp_gas": "ALL",
  "dif_o2": 0.001,
  "dif_co2": 0.006,
  "o2_cap": 0,
  "co2_cap": 0,
  "bc_interval": 0.002
}
```

## Usage in the scenarios

Three instances in term_neonate_72h:

| Exchanger | Blood ↔ gas | State |
|---|---|---|
| `GASEX_LL`, `GASEX_RL` | `LL_CAP` ↔ `ALL`, `RL_CAP` ↔ `ALR` | enabled (capacity 0 in a fetus) |
| `ECLS_GASEX` | `ECLS_OXY` ↔ `ECLS_GAS_OXY` | disabled until ECLS runs; set by `Ecls` |

| Scenario | `dif_o2` | `dif_co2` |
|---|---|---|
| term_neonate_72h | 0.001 | 0.006 |

## References

No literature values; the capacities are calibrated per scenario against arterial gases (see the `*Reference.md` pages).

````

### FILE: explain-engine/docs/GasMixing.md

````markdown
# GasMixing

`helpers/GasMixing.js` holds `exchange_gas`, the gas counterpart of [BloodMixing](./BloodMixing.md)'s `exchange_blood`: two gas compartments swap an equal volume of gas each step, so their compositions move toward each other without any net flow. It is what a [Resistor](./Resistor.md#mixing-without-net-flow-mix_flow)'s `mix_flow` does between gas compartments.

## Physiology

Gas moves between the airways and the alveoli not only by bulk flow. Near the alveoli, molecular diffusion takes over, and the heartbeat stirs the gas in the small airways (cardiogenic mixing). Both mix fresh and alveolar gas a little even between breaths, or with no breathing at all (apnoeic oxygenation, CO2 washout during apnoea).

## API

| Function | Arguments | Description |
|---|---|---|
| `exchange_gas(a, b, dv)` | two GasCapacitances, volume swapped each way (L) | Swaps `dv` of gas between the ends of `a` and `b` that face each other. |

```
dv   = min(dv, ½ · min(V_a_end, V_b_end))          stability clamp
Δn_k = (c_b,k − c_a,k) · dv                        mmol of species k moving b → a
a gains Δn_k at its end facing b, b loses it at its end facing a
```

- Applied to O2, CO2, N2, H2O and other; each species is conserved and no volume moves.
- **The end facing the neighbour:** for a well-mixed compartment its bulk; for a series dead space (see [GasCapacitance](./GasCapacitance.md#series-dead-space)) the sub-tank at that end, so DS–alveolus mixing acts on the distal sub-tank, not the whole dead space.
- **A `fixed_composition` side** keeps its composition (an infinite reservoir); the other side relaxes toward it.
- **No effect** when `dv ≤ 0` or either end volume is 0.
- **Temperature is not exchanged;** each compartment's wall sets it.

`Resistor.step_model` calls it when `mix_flow > 0`, the connection is open, and both sides are gas compartments; blood compartments go to `exchange_blood` instead.

## Usage in the scenarios

`DS_ALL` and `DS_ALR` (dead space ↔ alveoli) have `mix_flow` 0.001 L/s (60 mL/min each way) in every scenario. Per 0.5 ms step that is 0.5 µL, far below the clamp (a distal DS sub-tank is ~0.25 mL at term).

## Assumptions and limitations

- **One lumped exchange rate** for diffusion and cardiogenic mixing. It doesn't follow heart rate or stroke volume, and doesn't depend on the gas (CO2 and O2 mix equally).
- **Explicit:** concentrations from before the swap; the clamp keeps it stable.
- It shares scratch buffers between calls and so must not run re-entrantly (it never does in the single-threaded worker).

````

### FILE: explain-engine/docs/Glucose.md

````markdown
# Glucose

`Glucose` is the blood-glucose and insulin controller. Glucose is a blood solute (mmol/L) that flows with the blood like sodium. `Glucose` adds the liver's production into the central vein and removes the tissues' use from the same beds and shares as [Metabolism](./Metabolism.md). Insulin (rising with hyperglycaemia) and counter-regulation (rising with hypoglycaemia) adjust both. It holds no compartment and is neutral at rest.

## Physiology

A newborn uses about 4–6 mg glucose/kg/min, much of it in the brain. After the umbilical cord is cut, glucose comes from the liver (glycogen breakdown and gluconeogenesis) and from feeds or IV dextrose. Insulin, released as glucose rises, increases uptake by muscle and fat and suppresses hepatic output. Counter-regulatory hormones (glucagon, catecholamines, cortisol), released as glucose falls, raise hepatic output. Brain uptake does **not** depend on insulin, which is why hypoglycaemia injures the brain. Preterm and stressed infants are prone to both hypo- and hyperglycaemia.

## Inheritance

```
BaseModelClass
  └── Glucose
```

## Properties

### Config (set in the definition JSON)

| Property | Unit | Default | Description |
|---|---|---|---|
| `glucose_running` | boolean | `true` | Switch. Off stops source and sink and resets insulin and counter-regulation to 1. |
| `metabolism_name` | – | `"Metabolism"` | Supplies the consumption beds and shares. |
| `injection_site` | – | `"IVCI"` | Central vein receiving the hepatic output. |
| `plasma_model` | – | `"AA"` | Arterial blood whose glucose drives the controller. |
| `glu_use_rate` | mmol/kg/min | 0.03 | Tissue glucose use (5.4 mg/kg/min). |
| `hgp_rate` | mmol/kg/min | 0.03 | Hepatic glucose production (equal to use, so neutral at rest). |
| `glucose_setpoint` | mmol/L | 0 | Set-point; ≤ 0 = captured 30 s after build. Stored in every scenario. |
| `insulin_gain` | – | 0.54 | Insulin rise per fractional glucose excess (blunted newborn secretion: a dextrose load decays at ~1.5 %/min). |
| `insulin_suppression_gain` | – | 6 | Insulin fall per fractional glucose deficit (suppression stays prompt). |
| `counterreg_gain` | – | 6 | Counter-regulation rise per fractional glucose deficit (it does not fall above the set-point). |
| `insulin_tc`, `counterreg_tc` | s | 120, 120 | Time constants. |
| `uptake_insulin_gain` | – | 1.0 | Uptake rise per (insulin − 1). |
| `hgp_insulin_gain`, `hgp_counterreg_gain` | – | 0.8, 2.0 | Hepatic-output suppression by insulin and rise by counter-regulation. |
| `hormone_min`, `hormone_max` | – | 0, 10 | Clamp on insulin and counter-regulation. |
| `uptake_factor_min`, `uptake_factor_max` | – | 0.1, 5 | Clamp on the uptake factor. |
| `production_factor_min`, `production_factor_max` | – | 0, 8 | Clamp on the production factor. |
| `glucose_default` | mmol/L | 4.0 | Seed for any blood compartment without a glucose key. |
| `isf_volume` | L/kg | 0.31 | Interstitial glucose pool (term ECF ~0.40 L/kg minus the blood). |
| `isf_tc` | s | 300 | Time constant of the pool's equilibration with the blood. |
| `isf_glucose` | mmol/L | 0 | Interstitial glucose (state, saved); ≤ 0 = seeded at the consumption sites' mean. |
| `insulin_independent_sites` | list | `["BR_CAP"]` | Beds whose uptake insulin does not scale (brain: GLUT1/3). |
| `independent_km` | mmol/L | 1.0 | Saturation of their uptake: × (G/(Km+G)) / (Gs/(Km+Gs)), Gs the set-point. |

### Outputs

| Property | Unit | Description |
|---|---|---|
| `glucose` | mmol/L | Sensed arterial glucose. |
| `insulin`, `counterreg` | – | Activities (1 = rest). |
| `uptake_factor`, `production_factor` | – | Applied factors. |
| `glucose_use_step`, `glucose_prod_step` | mmol | Use and production in the last update. |

## Calculation

Every 1 s:

1. **Seed** a `glucose` key into every blood compartment that lacks one (once).
2. **Sense** `AA.solutes.glucose`. If no set-point is stored, capture it after 30 s.
3. **Controller**, with `e = (glucose − set-point) / set-point`:
   ```
   insulin    → clamp(1 + insulin_gain · e)   e > 0;   clamp(1 + insulin_suppression_gain · e)   e < 0   (tc 120 s)
   counterreg → clamp(1 − counterreg_gain · min(e, 0))                                           (tc 120 s)
   uptake_factor     = clamp(1 + uptake_insulin_gain · (insulin − 1))
   production_factor = clamp(1 − hgp_insulin_gain · (insulin − 1) + hgp_counterreg_gain · (counterreg − 1))
   ```
4. **Sink:** `glu_use_rate · weight / 60 · Δt` mmol, split over Metabolism's beds by their shares; each bed's part × `uptake_factor`, or × the saturable factor for the insulin-independent beds (each bed takes at most what it holds).
5. **Interstitial pool:** each bed exchanges `(V_isf/isf_tc) · share · Δt · (C_bed − isf_glucose)` with the pool (limited per update so neither side overshoots).
6. **Source:** `hgp_rate · weight / 60 · Δt · production_factor` mmol into `IVCI`.

**IV dextrose needs no extra code:** a dextrose fluid in [Fluids](./Fluids.md) carries `glucose` in its solutes, and the controller responds to the rise.

## Factor system

None; its own uptake and production factors.

## Inputs and outputs

- **Reads:** `AA.solutes.glucose`; Metabolism's `metabolic_active_models`; `model.weight`.
- **Writes:** `solutes.glucose` of the beds and of `IVCI` (and the seed in every blood compartment).
- **Written by:** the user (rates, switch); Fluids (dextrose, indirectly).
- **Read by:** `DataCollector` watchers, the Monitor.

## Assumptions and limitations

- **Behaviour in term_neonate_72h** (re-validation (i)):

  | Test | Glucose (mmol/L) |
  |---|---|
  | Rest, 30 min | 4.00 → 4.00; interstitial pool 3.70 |
  | Hepatic output stopped, 1 / 10 / 30 / 60 / 90 min | 3.68 / 3.27 / 2.72 / 1.95 / 1.25 (insulin 0.03 by 10 min; the brain keeps its use) |
  | D10 2 mL/kg (0.2 g/kg) over 1 min, 2 / 10 / 30 / 60 min | 10.1 / 6.1 / 5.6 / 5.0; K 1.54 %/min from 10 to 40 min, no rebound |

  Before the re-validation glucose lived only in the blood (changes 3–4× too fast; hepatic output stopped: 2.82 at 10 min, 0.01 at 90), insulin scaled the brain's uptake too, and a falling counter-regulation added to insulin's hepatic suppression: the same D10 bolus was cleared in ~8 min (K ~10 %/min) with a rebound to 1.99 mmol/L. The newborn insulin response to an IV glucose load is poor (Salle 1976); K ~1.5 %/min is a judgement within the 1–2 %/min usually reported. The brain's share (31 %, Metabolism's map) is near the 37 % of production used by the newborn dog's cerebral cortex, whose uptake stays constant across a wide glucose range (Huang 1989).
- **Only the brain's use depends on the glucose level** (saturable); the other beds' use depends on insulin only. A depleted bed's missing use is counted out of `glucose_use_step`.
- **No glucosuria** (`glucose` isn't in the Kidneys' `filterable_solutes`), no glycogen store, no lactate–glucose cycle.
- **Hepatic output enters `IVCI`;** in the fetus that is also where the placental supply arrives through the umbilical vein, so the same parameters stand in for the placental glucose supply.

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Glucose` (trimmed to the config props; gains are the defaults):

```json
{
  "name": "Glucose",
  "model_type": "Glucose",
  "is_enabled": true,
  "glucose_running": true,
  "metabolism_name": "Metabolism",
  "injection_site": "IVCI",
  "plasma_model": "AA",
  "glu_use_rate": 0.03,
  "hgp_rate": 0.03,
  "glucose_setpoint": 3.998
}
```

## Usage in the scenarios

One instance in every scenario, running with use = production = 0.03 mmol/kg/min. The set-points equal each scenario's `Blood.solutes.glucose`: term 4.0, fetus 3.7–4.2, preterm 5.5–7.0 mmol/L.

## References

- Bier DM, Leake RD, Haymond MW, et al. Measurement of "true" glucose production rates in infancy and childhood with 6,6-dideuteroglucose. *Diabetes* 1977;26:1016–23. doi:10.2337/diab.26.11.1016 (term neonates 6.07 ± 0.27 mg/kg/min; production scales with brain size)
- Huang MM, Kliegman RM, Chau K. Partitioning and extraction of glucose regulates cerebral glucose utilization in newborn dogs. *Biol Neonate* 1989;55:290–7. doi:10.1159/000242931 (cortex 37 % of production, uptake constant across glucose levels)
- Salle B, Ruitton-Uglienco A. Glucose disappearance rate, insulin response and growth hormone response in the small for gestational age and premature infant of very low birth weight. *Biol Neonate* 1976;29:1–17. doi:10.1159/000240843 (poor insulin response to an IV glucose load)

The use rate (5.4 mg/kg/min) is close to Bier's; the interstitial volume, its time constant, the K target and the other gains are model choices.

````

### FILE: explain-engine/docs/Heart.md

````markdown
# Heart

`Heart` is the cardiac driver. It holds no blood itself; the chambers ([`HeartChamber`](./HeartChamber.md)) and the coronary bed ([`BloodTimeVaryingElastance`](./BloodTimeVaryingElastance.md)) do. Heart does five things:
- runs the conduction system (rhythm, AV conduction, escape and ectopic beats);
- turns each beat into an activation signal that makes the chambers contract;
- passes autonomic, drug, temperature and myocardial-oxygen effects on to heart rate and the chambers;
- synthesises an ECG;
- measures each beat's volumes and pressures.

## Physiology

Each heartbeat starts in the **sinus node**. Its firing rate is the heart rate, set by a resting rate that the autonomic nervous system, drugs, temperature and hypoxia push up or down. The impulse spreads through the atria (P wave; the atria contract), pauses in the **AV node**, and then activates the ventricles (QRS; the ventricles contract). The ventricles stay refractory until repolarisation ends (T wave, end of QT).

Explain reproduces this sequence with timers and produces the conduction disorders a clinician meets:
- **First-degree AV block:** a long PR interval.
- **Second-degree (2:1, 3:1) block:** some P waves aren't followed by a QRS.
- **Complete heart block:** the atria and ventricles beat independently, the ventricles at a slow escape rate.
- **Sinus arrest** with a ventricular escape rhythm.
- **Ventricular tachycardia.**
- **Single premature ventricular contractions.**

The **activation signal** is what turns electricity into mechanics. During atrial and ventricular activation, Heart sends each chamber a value between 0 (relaxed) and 1 (fully contracted), which stiffens the chamber (see [TimeVaryingElastance](./TimeVaryingElastance.md)). The ventricles' pulse rises slowly and falls quickly, like the real ventricular pressure. The right ventricle can lag the left by a few milliseconds (`rv_delay` > 0), as in a pressure-loaded RV, or lead it (`rv_delay` < 0: the LV lags), so the pulmonary valve opens first, as in the transitional circulation.

Heart also measures each beat as an echo or catheter study would:
- end-diastolic and end-systolic volumes and pressures of all four chambers;
- stroke volume and ejection fraction of both ventricles.

It finds end-diastole and end-systole from the valves, the way they are defined clinically: the mitral valve closing starts systole, and the aortic valve closing ends it.

## Inheritance

```
BaseModelClass
  └── Heart
```

## Properties

### Config: rate and timing

| Property | Unit | Default | Description |
|---|---|---|---|
| `heart_rate_ref` | bpm | 110 | Resting (reference) sinus rate. term_neonate_72h 120.33. |
| `pq_time` | s | 0.1 | Atrial activation (P wave) and PQ interval. |
| `av_delay` | s | 0.0005 | AV-node pause after the PQ interval, before the QRS. |
| `qrs_time` | s | 0.075 | Ventricular depolarisation (QRS). |
| `qt_time` | s | 0.4 | QT at 60 bpm (a QTc), from QRS onset; rate-corrected each beat with Bazett, `cqt_time = qt_time·√(60/HR)`. Sets both the ECG QT and how long the ventricles contract. 0.4 in every scenario (neonatal QTc ~0.40 s). |
| `act_peak` | – | 0.85 | Fraction of the QT at which ventricular activation peaks (end-systole). |
| `relax_frac` | – | 0.06 | Relaxation after end-systole: the activation decays with τ = `relax_frac`·RR (30 ms at 120/min). 0 = a raised-cosine fall to zero at the end of the QT. |
| `rv_delay` | s | 0.0 | RV activation lag behind the LV; 0 = both together; negative = the LV (and the coronaries) lag the RV by \|`rv_delay`\|. `term_neonate_1h` uses −0.035 (early systolic right-to-left ductal flow); the removed `bischoff_bidir_pda` used 0.008. |

### Config: rhythm and conduction

| Property | Unit | Default | Description |
|---|---|---|---|
| `sa_node_enabled` | boolean | `true` | `false` = sinus arrest. |
| `av_block_mode` | – | `"none"` | `none`, `first_degree`, `second_degree` or `complete`. |
| `av_block_ratio` | – | 2 | Second degree: every `ratio`-th P wave is blocked (2 → 2:1). |
| `first_degree_pq_factor` | – | 2.5 | First degree: PQ interval multiplier. |
| `vent_pacemaker_mode` | – | `"escape"` | `escape` (slow back-up pacemaker) or `vt` (fast ventricular focus). |
| `vent_escape_enabled` | boolean | `true` | Enables the escape pacemaker. |
| `vent_escape_rate` | bpm | 50 | Escape rhythm rate. |
| `vt_rate` | bpm | 200 | Ventricular tachycardia rate. |
| `pvc_coupling` | s | 0.3 | Delay of a triggered PVC (`trigger_pvc()`). |

### Config: ECG

| Property | Unit | Default | Description |
|---|---|---|---|
| `p_amp`, `q_amp`, `r_amp`, `s_amp`, `t_amp` | mV | 0.15, −0.1, 1.0, −0.25, 0.25 | Wave amplitudes of the synthetic ECG. |

### Config: modulation

| Property | Unit | Default | Description |
|---|---|---|---|
| `ans_sens` | – | 1.0 | Sensitivity of rate and chambers to the ANS. |
| `hr_factor` | – | 1.0 | User heart-rate factor. |
| `hr_override` | boolean | `false` | Pins the rate to `heart_rate_ref`, ignoring all factors. |
| `cont_factor_left`, `cont_factor_right` | – | 1.0 | Contractility (left: LA, LV; right: RA halves, RV). A change is applied as a delta to the chambers' `el_max_factor_ps`. |
| `relax_factor_left`, `relax_factor_right` | – | 1.0 | Diastolic stiffness, applied the same way to `el_min_factor_ps`. |
| `pc_el_factor` | – | 1.0 | Pericardial stiffness (`PERICARDIUM` `el_base` and `el_k` `_factor_ps`). |
| `pc_extra_volume` | L | 0.0 | Pericardial fluid (`PERICARDIUM.vol_extra`): tamponade. |
| `cor_r_systolic_factor` | – | 0.0 | Systolic rise of the coronary inflow resistance: `AA_COR.r_factor = 1 + c·vaf` each step (intramural vessels compressed by the contracting myocardium). 5 in all shipped scenarios. |

### Set by other models

| Property | Unit | Default | Written by |
|---|---|---|---|
| `ans_activity_hr` | – | 1.0 | `EF_HR` efferent (baroreflex/chemoreflex chronotropy). |
| `ans_activity` | – | 1.0 | `EF_HEART` efferent: sympathetic drive to the chambers (inotropy, lusitropy). |
| `ans_activity_factor` | – | 1.0 | `Mob`: hypoxic scaling of that drive. |
| `hr_mob_factor` | – | 1.0 | `Mob`: myocardial-oxygen-balance effect on rate. |
| `hr_temp_factor` | – | 1.0 | `Thermoregulation`: temperature effect on rate. |
| `hr_drug_factor` | – | 1.0 | `Drugs`: chronotropy. |
| `hr_chemo_factor` | – | 1.0 | `EF_HR_CHEMO` efferent: hypoxic bradycardia (in no shipped scenario at present). |

### Outputs

| Property | Unit | Default | Description |
|---|---|---|---|
| `heart_rate` | bpm | 120 | Sinus rate this step (from the reference and the factors). |
| `heart_rate_measured` | bpm | 120 | Measured ventricular rate: 60 / time since the previous ventricular activation (falls when beats stop). |
| `ecg_signal` | mV | 0 | Synthetic lead-II-like ECG. |
| `aaf`, `vaf`, `rvaf` | – | 0 | Atrial, ventricular and right-ventricular activation (0–1). |
| `cqt_time` | s | 0 | Rate-corrected QT of the current beat. |
| `ncc_atrial`, `ncc_ventricular` | steps | 0 | Steps since the atrial / ventricular activation started (`-1` on the activating step). See [ARCHITECTURE §7b](./ARCHITECTURE.md#7b-ncc_-cycle-counters-live-on-the-components). |
| `cardiac_cycle_state` | – | 0 | 1 = systole (mitral closed → aortic closed), 0 = diastole. |
| `cardiac_cycle_running` | – | 0 | 1 from SA firing to the end of the QT. |
| `cardiac_cycle_time` | s | 0.353 | Duration of the last SA-to-end-of-QT activation. **Not the RR interval** (use `60 / heart_rate_measured`). |
| `lv_edv`, `lv_esv`, `lv_sv` | L | 0 | LV end-diastolic, end-systolic and stroke volume. |
| `lv_edp`, `lv_esp` | mmHg | 0 | LV end-diastolic and end-systolic pressure, **transmural** (`pres_in`: wall recoil, without the pericardial pressure). |
| `lv_ef` | fraction | 0 | `lv_sv / lv_edv`. |
| `rv_edv`, `rv_esv`, `rv_sv`, `rv_edp`, `rv_esp`, `rv_ef` | L, mmHg, fraction | 0 | The same for the RV. |
| `la_edv`, `la_esv`, `la_edp`, `la_esp` | L, mmHg | 0 | LA end-diastolic/end-systolic volume and pressure (latched at the ventricular transitions). |
| `ra_edv`, `ra_esv`, `ra_edp`, `ra_esp` | L, mmHg | 0 | The same for the RA; with a split right atrium the sum of the two halves' volumes and the mean of their pressures. |

### Internal state (public names, saved with the state)

| Property | Description |
|---|---|
| `prev_cardiac_cycle_running`, `prev_cardiac_cycle_state` | Last step's values, for edge detection (`Mob` reads `prev_cardiac_cycle_running`). |
| `prev_la_lv_flow`, `prev_lv_aa_flow` | Last step's mitral and LV-outflow flows, for systole detection. |
| `prev_cont_factor_left`, `prev_cont_factor_right`, `prev_relax_factor_left`, `prev_relax_factor_right`, `prev_pc_el_factor` | The factors last applied to the chambers; a change triggers the delta setters. |

## Calculation

`calc_model()` runs, in this order, each step:

1. **Contractility, relaxation and pericardium setters** (every 15 ms). When `cont_factor_*`, `relax_factor_*` or `pc_el_factor` changed, the *change* is added to the chambers' (or `PERICARDIUM`'s) persistent factor, floored at 0. `PERICARDIUM.vol_extra` is set from `pc_extra_volume`.
2. **Systole detection** from the previous step's valve flows:
   - mitral flow stopping (`LA_LV`) starts systole;
   - the active LV outflow valve stopping (`LV_AA`, or `LV_PA` in transposition) ends it.

   Without a working LV outflow (aortic atresia, HLHS), systole is the ventricular activation window instead.
3. **Heart rate**:
   ```
   HR = HR_ref · (1 + (ans_activity_hr − 1)·ans_sens + (hr_factor − 1) + (hr_mob_factor − 1)
                    + (hr_temp_factor − 1) + (hr_drug_factor − 1) + (hr_chemo_factor − 1))
   ```
   With `hr_override` it is `HR_ref`. It is floored at 0; at 0 the sinus node is silent.
4. **Conduction timers**:
   - **SA firing** (every `60/HR` s while `sa_node_enabled`) starts the PQ interval and the atrial activation (`ncc_atrial = −1`). The SA timer is not saved: after a load the node fires on the first step. (It used to wait a whole interval, which skipped one beat after every load: term MAP 61 → 53 mmHg for ~2 s, enough to set the brain autoregulation ringing.)
   - **After PQ**, the AV delay runs.
   - **After the AV delay**, the ventricles are activated if they aren't refractory and `av_block_mode` lets this beat through.
   - **After the QRS** comes the QT; the ventricles are refractory until it ends.
5. **Escape / ectopic pacemaker.**
   - If the ventricles have been quiet for `60 / vent_escape_rate` (or `60 / vt_rate` in `vt` mode) and aren't refractory, they fire on their own. At normal rates conducted beats always come first, so the escape pacemaker only appears when conduction fails.
   - A pending PVC fires `pvc_coupling` after `trigger_pvc()`.
6. **ECG** (`calc_ecg`): a sum of Gaussian waves (P in the PQ interval; Q, R, S in the QRS; T in the QT), positioned relative to each phase (T in the ST–T phase, which lasts `cqt_time − qrs_time` after the QRS), so the trace follows the timing settings. Isoelectric baseline 0 mV.
7. **Rate measurement** and the `ncc_*` counters advance.
8. **Activation** (`calc_varying_elastance`):
   ```
   aaf = sin(π·n_a/N_a)                       N_a = pq_time/dt, while 0 ≤ n_a < N_a
   x = n_v/N_v                                N_v = cqt_time/dt (the QT includes the QRS)
   vaf = ½(1 − cos(π·x/p))        for x < p   p = act_peak
       = exp(−(x−p)·cqt_time/τ)  for x ≥ p (cut below 0.005, restarted by the next QRS),  τ = relax_frac·60/HR
   rvaf = vaf shifted by rv_delay             (rv_delay < 0: vaf is the one shifted, by |rv_delay|)
   ```
   A raised cosine that rises to 1 at end-systole (`act_peak` of the QT), so the ventricles eject for most of the QT, then an exponential relaxation that still runs as the ventricle starts to fill (with `relax_frac` 0 a raised cosine back to zero at the end of the QT instead). Heart writes these values to the chambers' `act_factor`:
   - `aaf` → LA, RA (or RAIVCI/RASVC);
   - `vaf` → LV and COR;
   - `rvaf` → RV.

   It also passes `ans_sens` and `ans_activity · ans_activity_factor` to the chambers, and sets the coronary inflow resistor's non-persistent factor `AA_COR.r_factor = 1 + cor_r_systolic_factor · vaf`.
9. **Per-beat analysis** (`analyze`), at the systole/diastole transitions:
   - at end-systole, it latches the end-systolic volume and pressure;
   - at end-diastole, the end-diastolic values, then `SV = EDV − ESV` and `EF = SV / EDV` (0 if EDV = 0).

## Factor system

Heart has no factor layers of its own. It writes into the chambers':
- `cont_factor_*` → `el_max_factor_ps`;
- `relax_factor_*` → `el_min_factor_ps`;
- `pc_el_factor` → `PERICARDIUM` `el_base_factor_ps` and `el_k_factor_ps`.

Each is applied as a delta to the *shared* persistent layer, so the chamber's factor is the sum of Heart's and anyone else's change. The floor at 0 makes a delta that hits it irreversible: stepping a factor down past 0 and back up doesn't return to the start.

## Inputs and outputs

- **Reads:** the `LA_LV` flow and the active LV outflow valve's flow (systole timing); chamber volumes and `pres_in` (per-beat analysis); `PERICARDIUM`.
- **Writes:**
  - `act_factor`, `ans_sens`, `ans_activity` of LA, LV, RV, RA/RAIVCI/RASVC;
  - `act_factor` of COR, and `AA_COR.r_factor` (systolic coronary resistance);
  - the chambers' `el_max_factor_ps`/`el_min_factor_ps`;
  - `PERICARDIUM` factors and `vol_extra`.
- **Written by:** the ANS efferents (`EF_HR`, `EF_HEART`, `EF_HR_CHEMO`), `Mob`, `Thermoregulation`, `Drugs` (see above); the user (rate, rhythm, factors, `trigger_pvc`).
- **Read by:**
  - `Monitor` (heart rate, ECG);
  - `HeartFunction` (`lv_esp`/`lv_esv`/`lv_edp`/`lv_edv` and the RV values, for wall stress);
  - `Mob` (`cardiac_cycle_running`, `cardiac_cycle_time`; its chamber refs);
  - `Pda` (`ncc_ventricular`);
  - `DataCollector`, which always watches `ncc_atrial` and `ncc_ventricular`.

## Assumptions and limitations

- **QT sets both the ECG and the contraction.** With `qt_time` 0.40 the ECG QTc is 0.40 s and the ventricles eject for 157–180 ms (LV) in the postnatal and fetal scenarios at rest (term 180 ms at 121/min; fetus_term 166 ms; the fetal reference is 169 ms, Peixoto 2024, doi:10.1017/S1047951124025927). Until the 2026-10 re-validation QT was 0.25 s and the contraction lasted QRS + QT with a late-peaking `x·sin(πx)` pulse: ejection lasted only 118–131 ms, so peak flows and valve gradients were too high, and lengthening QT alone ate into diastolic filling (term mitral inflow 213 → 104 ms per beat). Counting the QT from QRS onset and the raised-cosine pulse keep filling, EF and output (≤1.4 % change).
- **Relaxation scales with the beat.** τ = `relax_frac`·RR, so relaxation speeds up with heart rate (the frequency-dependent acceleration of relaxation). A fixed τ was rejected: term output peaked at 150/min and fell to below rest at 210/min, while with τ ∝ RR it rises to ~180/min and plateaus. Sympathetic and drug lusitropy act on the passive stiffness only, not on τ. With the AV-valve inertance ([Resistor](./Resistor.md#inertance-inertance)) relax_frac 0.06 gives term mitral E/A 0.61/0.59 m/s (E/A 1.04); the since-removed preterm and fetal scenarios had 0.27–0.91; before the relaxation tail and inertance E/A was 1.8–5.4 everywhere.
- **The same timings in every scenario.** `pq_time` 0.1, `qrs_time` 0.075, `qt_time` 0.4, `act_peak` 0.85, `relax_frac` 0.06 and `av_delay` 0.0005 are used from 25 weeks to term and in the fetus.
- **The AV delay is nearly zero.** The PR interval is essentially `pq_time`, and atrial contraction (the `aaf` pulse) spans the whole PQ interval, ending just as the ventricles activate.
- **`cardiac_cycle_time` is the activation time, not the RR interval** (≈0.28 s against 0.50 s at term). `Mob` therefore uses its own measured beat interval for the stroke-work O2 cost (since v1.0).
- **End-diastolic and end-systolic pressures are transmural.** They exclude the pericardial (and thoracic) pressure, which is about −3 to −8 mmHg at term, so they read higher than a catheter's cavity pressure. Transmural is the right quantity for wall stress (`HeartFunction`).
- **Rate factors add.** Each factor adds `(factor − 1)·HR_ref`; they don't multiply.
- **Systole timing needs the left-heart valves.** `LA_LV` and an LV outflow valve are assumed present unless the LV has no outflow.
- **Deterministic rhythm.** No beat-to-beat variability; PVCs are triggered, not random (the engine forbids `Math.random()`).

## Calibration (term_neonate_72h)

- `heart_rate_ref` 120.33 gives a resting HR of 120; calm day-3 term infants measure 117–121 (Satoh 2016, He 2011, Agata 1994).
- LV `el_max` ×1.15 and RV `el_max` ×1.3 make stroke volume and ejection fraction match neonatal CMR (Jhaveri 2023: SV 1.6 mL/kg, EF 63 / 52.5 %) at unchanged output.

See `scripts/_fix_term_hr_contractility.mjs` and [TermNeonateReference](./TermNeonateReference.md).

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Heart` (trimmed to the main config props; `components` holds the chambers, valves and `PERICARDIUM`):

```json
{
  "name": "Heart",
  "model_type": "Heart",
  "is_enabled": true,
  "heart_rate_ref": 120.3333,
  "pq_time": 0.1,
  "qrs_time": 0.075,
  "qt_time": 0.4,
  "av_delay": 0.0005,
  "ans_sens": 1,
  "av_block_mode": "none",
  "vent_pacemaker_mode": "escape",
  "cont_factor_left": 1,
  "cont_factor_right": 1,
  "relax_factor_left": 1,
  "relax_factor_right": 1,
  "pc_el_factor": 1,
  "pc_extra_volume": 0
}
```

## Usage in the scenarios

One `Heart` in every scenario, at the top of the model list (it sets the chambers' activation before they step). It owns 14 sub-models:
- the chambers `LA`, `LV`, `RV`, `RAIVCI`, `RASVC`;
- the valves `LA_LV`, `RAIVCI_RV`, `RASVC_RV`, `RV_PA`, `LV_AA`, and the disabled `RV_AA`, `LV_PA`;
- the intra-atrial connection `RAIVCI_RASVC`;
- `PERICARDIUM`.

The coronary bed `COR` belongs to `Mob`.

Scenario differences:

| | `heart_rate_ref` | Contractility / relaxation factors |
|---|---|---|
| term_neonate_72h | 120.33 | – |

## References

- Bazett HC. An analysis of the time-relations of electrocardiograms. *Heart* 1920;7:353–370. (QT rate correction.)
- Peixoto AB et al. Influence of pre-existing maternal diabetes mellitus on fetal myocardial performance index and systolic-to-diastolic duration ratio. *Cardiol Young* 2025;35:53–59. doi:10.1017/S1047951124025927 (fetal LV ejection time 0.169 s in controls).
- Zhu F et al. Cardiopulmonary physiological effects of diuretic therapy in preterm infants with chronic pulmonary hypertension. *J Perinatol* 2023;43:1288–1294. doi:10.1038/s41372-023-01742-0 (preterm RV ejection time ≈ 200 ms from RVET:PAAT 5.9 × PAAT 34 ms).
- Term calibration sources (Satoh 2016, He 2011, Agata 1994, Jhaveri 2023) are listed in [TermNeonateReference](./TermNeonateReference.md).

````

### FILE: explain-engine/docs/HeartChamber.md

````markdown
# HeartChamber

A `HeartChamber` is a heart chamber: a [`TimeVaryingElastance`](./TimeVaryingElastance.md) that holds blood (composition mixed like a [`BloodCapacitance`](./BloodCapacitance.md)). Its contractility and relaxation respond to the autonomic nervous system, drugs, myocardial oxygen balance, load and remodelling. The atria and ventricles (`LA`, `LV`, `RV` and the two halves of the right atrium) are HeartChambers.

## Physiology

Each chamber stiffens when activated and relaxes in between (see [TimeVaryingElastance](./TimeVaryingElastance.md#physiology)). Two numbers describe it:
- **`el_max`, contractility:** how stiff it gets at peak contraction.
- **`el_min`, diastolic stiffness:** how easily it fills.

Several influences change those two numbers, and HeartChamber adds them up:

- **Sympathetic (β1) stimulation** raises contractility (*inotropy*) and speeds relaxation, lowering diastolic stiffness (*lusitropy*).
- **Inotropes and lusitropes** (adrenaline, milrinone, …) do the same through the `Drugs` model.
- **Myocardial hypoxia** (oxygen supply below demand) depresses contractility through `Mob`.
- **Load and remodelling.** An acutely overloaded ventricle loses contractility (afterload mismatch). A chronically overloaded one remodels: it dilates (larger unstressed volume), stiffens and loses contractility. `HeartFunction` models both.
- **The clinician or scenario** sets contractility and relaxation per side of the heart through `Heart` (`cont_factor_*`, `relax_factor_*`).

## Inheritance

```
BaseModelClass
  └── TimeVaryingElastance
        └── HeartChamber      (own factor composition with ANS/drug/Mob/load/remodel terms; blood mixing)
```

HeartChamber overrides `calc_elastances` and `calc_volumes` (extra terms, floors) and `volume_in` (blood mixing). `calc_pressure` is inherited unchanged. Its sibling [`BloodTimeVaryingElastance`](./BloodTimeVaryingElastance.md) (the coronary bed) has the mixing but none of the extra terms.

## Properties

Elastance, volume, activation and factor props are inherited: see [TimeVaryingElastance → Properties](./TimeVaryingElastance.md#properties).

### Config (set in the definition JSON)

| Property | Unit | Default | Description |
|---|---|---|---|
| `temp` | °C | 37.0 | Blood temperature; mixed on inflow, relaxed toward `body_temp` by `Blood`. |
| `viscosity` | cP | 6.0 | Overwritten by `Blood` from the chamber's haemoglobin every step; not mixed. |
| `solutes` | object | `{}` | Solute concentrations, seeded from `Blood` when empty. |
| `drugs` | object | `{}` | Drug concentrations (`Drugs`). |

### Set by other models

| Property | Unit | Default | Written by | Effect |
|---|---|---|---|---|
| `ans_sens` | – | 1.0 | `Heart` (its own `ans_sens`), every step | Sensitivity to `ans_activity`. |
| `ans_activity` | – | 1.0 | `Heart`: `ans_activity · ans_activity_factor` (`EF_HEART` drive scaled by `Mob`), every step | > 1 raises `el_max` and lowers `el_min`. |
| `el_max_mob_factor` | – | 1.0 | `Mob` (all chambers) | Hypoxic contractility depression. |
| `el_max_drug_factor` | – | 1.0 | `Drugs` (all chambers) | Inotropy. |
| `el_min_drug_factor` | – | 1.0 | `Drugs` (all chambers) | Lusitropy; < 1 = better relaxation. |
| `el_max_load_factor` | – | 1.0 | `HeartFunction` (LV, RV) | Acute load-induced contractility depression. |
| `el_max_remodel_factor` | – | 1.0 | `HeartFunction` (LV, RV) | Chronic remodelling: contractility. |
| `el_k_remodel_factor` | – | 1.0 | `HeartFunction` (LV, RV) | Chronic remodelling: diastolic stiffening. |
| `u_vol_remodel_factor` | – | 1.0 | `HeartFunction` (LV, RV) | Chronic remodelling: dilation. |
| `act_factor` | – | 0.0 | `Heart` | Activation (inherited; see [TimeVaryingElastance](./TimeVaryingElastance.md#set-by-other-models)). |

These factors are not reset each step; their writers hold them. The props `Blood` and `BloodComposition` write onto every blood compartment (`haldane_coeff`, `P50_0`, `viscosity_ref`, `body_temp`, `blood_temp_tc`, `temp_ext_override`, `prev_ph`, `prev_po2`) are described on [BloodCapacitance](./BloodCapacitance.md#set-by-other-models).

### Outputs

| Property | Unit | Default | Description |
|---|---|---|---|
| `to2`, `tco2` | mmol/L | 0.0 | Total O2 and CO2 content; mixed on inflow. |
| `ph`, `pco2`, `po2`, `so2`, `hco3`, `be` | as in [BloodCapacitance](./BloodCapacitance.md#outputs) | -1 | Blood gases, `-1` = not calculated. `Blood` solves them for `RAIVCI` (once per second). |

## Calculation

`calc_model()` (inherited) runs `calc_elastances()` → `calc_volumes()` → `calc_pressure()`.

1. **`calc_elastances`** composes every term **additively** against the base value:
   ```
   el_min_eff = el_min · (1 + (el_min_factor − 1) + (el_min_factor_ps − 1) + (el_min_factor_scaling_ps − 1)
                            + (el_min_drug_factor − 1)
                            − (ans_activity − 1)·ans_sens)                      ← subtracted: lusitropy
   el_max_eff = el_max · (1 + (el_max_factor − 1) + (el_max_factor_ps − 1) + (el_max_factor_scaling_ps − 1)
                            + (el_max_mob_factor − 1) + (el_max_drug_factor − 1)
                            + (el_max_load_factor − 1) + (el_max_remodel_factor − 1)
                            + (ans_activity − 1)·ans_sens)                      ← added: inotropy
   el_k_eff   = el_k · (1 + (el_k_factor − 1) + (el_k_factor_ps − 1) + (el_k_factor_scaling_ps − 1)
                          + (el_k_remodel_factor − 1)
                          + (the el_min modulation above: relaxation, drug lusitropy, ANS))
   ```
   The diastolic modulation scales the **whole** diastolic curve, `el_min` and `el_k` alike, so relaxation, lusitropy and the ANS still act on a chamber whose diastolic stiffness is quadratic.
   Then:
   - `el_min_eff` and `el_k_eff` are floored at 0 (the subtracted terms could take them below);
   - `el_max_eff` is raised to `el_min_eff` if it falls below it;
   - the non-persistent factors are reset.
2. **`calc_volumes`**: `u_vol_eff = u_vol · (1 + the three layers + (u_vol_remodel_factor − 1))`, floored at 0. `u_vol_factor` is reset.
3. **`calc_pressure`** (inherited): `pres_in = p_ed + (p_es − p_ed)·act_factor` (see [TimeVaryingElastance → Calculation](./TimeVaryingElastance.md#calculation)), plus the pericardial `pres_ext`.

**`volume_in(dvol, comp_from)`** adds the volume and mixes the incoming blood with [`mix_blood_in`](./BloodMixing.md): `to2`, `tco2`, solutes, drugs and temperature.

## Factor system

All layers and terms are **additive**, unlike `BloodVessel`'s multiplicative composition (see [ARCHITECTURE §7a](./ARCHITECTURE.md#7a-the-factor--effective-value-pattern)). Two consequences:

- **Effects add, they don't compound.** For example, `Heart` contractility +20 % and an inotrope +20 % give +40 %, not +44 %.
- **One sign is reversed.** The ANS term is *subtracted* for `el_min`: more sympathetic drive means a lower diastolic stiffness.

The persistent layers are written by `Heart`:
- `set_contractility` → `el_max_factor_ps`;
- `set_relaxation` → `el_min_factor_ps`, left and right separately.

The scaling layers are written by `ModelScaler`, and the `Calibrator` also writes `el_max_factor_ps`.

## Inputs and outputs

- **Reads:** the upstream compartment on inflow (composition).
- **Written by:**
  - `Heart` (activation, ANS, contractility and relaxation factors);
  - `Mob`, `Drugs`, `HeartFunction` (the terms above);
  - `Blood` (temperature, viscosity, seed composition);
  - `PERICARDIUM` (`pres_ext`);
  - the valves and connectors (volume).
- **Read by:**
  - the valves and connectors (`pres`);
  - `Heart` (volumes and `pres_in` for the per-beat analysis);
  - `Mob` (LV/RV pressure and volume for stroke work);
  - `Monitor`, `Blood` (`RAIVCI` blood gas);
  - `DataCollector` watchers (PV loops).

## Assumptions and limitations

- **Additive composition.** Large simultaneous effects add linearly. Several large negative terms together can only be stopped by the floor at 0.
- **One ANS signal, all chambers.** The atria and both ventricles get the same `ans_activity` and `ans_sens`.
- **Quadratic diastolic relation** (see [The diastolic relation](#the-diastolic-relation)): steeper than linear but less steep than the measured power law.
- **One unstressed volume** for the diastolic and systolic relations (inherited).
- **Right-ventricle unstressed volume: 1.64× the LV's in every scenario.** `u_vol` is also the volume intercept of the end-systolic relation, so it sets how stiff the contracting RV is. Until the re-validation the postnatal scenarios had 5.46× (term 4.0 vs 0.73 mL), which made the RV's end-systolic elastance about the LV's (term 28 vs 30 mmHg/mL), where real RVs have roughly ⅓–½ of it, and left the RV almost insensitive to afterload. They now use the fetal scenarios' ratio, with `el_max` and `el_k` refitted (`scripts/_fix_rv_unstressed.mjs`) so the resting RV end-diastolic and end-systolic volumes are unchanged:

  | Scenario | RV `u_vol` (mL) | RV / LV `el_max` (mmHg/mL) | Pulmonary arterioles ×2, RV SV (reflexes off) |
  |---|---|---|---|
  | term_neonate_72h | 4.0 → 1.20 | 9.8 / 30.5 (was 28.1) | −5.7 % (was −3.4 %) |

  The resting state moved ≤0.5 %. An open duct offloads the pulmonary artery, so in the PDA patients of the (since removed) Bischoff scenarios the RV felt less of a pulmonary resistance rise (−2 to −3 %).

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Heart.components.LV` (trimmed to the config props):

```json
{
  "name": "LV",
  "model_type": "HeartChamber",
  "is_enabled": true,
  "vol": 0.00606,
  "u_vol": 0.000733,
  "el_min": 0,
  "el_max": 30477.7,
  "el_k": 156107,
  "ans_sens": 1
}
```

## The diastolic relation

Normal hearts stiffen steeply as they fill. Volume-normalised end-diastolic pressure–volume curves share one shape across human, dog and rat hearts, `EDP ∝ V^2.79` (Klotz 2006). The engine's diastolic term is `el_min·S + el_k·S²` (`S = vol − u_vol`). The closest it gets is a **pure quadratic**, `el_min` 0 with all the stiffness in `el_k`: local stiffness at rest is then 2× the average, against 2.8× for the power law.

In every scenario all five chambers use the pure quadratic, with `el_k` from `scripts/_fix_chamber_edpvr.mjs`:
- **Fit:** the resting end-diastolic (ventricles) and mean (atria) volumes are unchanged, and so are the resting vitals.
- **Right atrium:** the two halves share one `el_k`, and their connector `RAIVCI_RASVC` is `implicit`. With stiffening atria the explicit scheme of that low-resistance connector oscillated.
- **Effect:** in term_neonate_72h with the reflexes off, +30 mL of blood raises stroke volume +17 % (linear: +34 %) and LV EDP +5.6 mmHg (linear: +3.6). That is the limited preload reserve of the newborn heart.

The since-removed `preterm_25wk` and `bischoff_ltr_pda`, small babies with a left-to-right duct, were not fitted. Their resting atrial pressures and ventricular volumes are set by the circulation around the heart and hardly respond to chamber stiffness, so fitting the atria on volume drove the LA soft until its pressure collapsed (preterm_25wk LA 3.2 → −1.4 mmHg). They use the unfitted start, `el_k = el_min_old / S₀` (`--iter 1 --force`), within 2–4 % of every resting volume and pressure. Against their reference pages nothing moves more than 1.5 % (HR, MAP, SpO2, SvO2, outputs), preterm_25wk's foramen ovale flow returns to left-to-right (−0.9 → +2.4 mL/kg/min) and mitral E/A rises from 0.35/0.42 to 0.69.

## Usage in the scenarios

Five chambers in every scenario, all owned by `Heart` and inside `PERICARDIUM`. Their elastances and activations are listed on [TimeVaryingElastance → Usage](./TimeVaryingElastance.md#usage-in-the-scenarios).

### The split right atrium

The right atrium is two chambers:
- `RAIVCI` receives the IVC and the coronary sinus (`COR_RAIVCI`);
- `RASVC` receives the SVC.

Each has its own tricuspid half (`RAIVCI_RV`, `RASVC_RV`, both `HeartValve`s) and foramen-ovale half (`LA_RAIVCI`, `LA_RASVC`, owned by `Shunts`). The two halves are joined by the `RAIVCI_RASVC` resistor (in `Heart.components`):

| Scenarios | `RAIVCI_RASVC` | Effect |
|---|---|---|
| Fetal (no shipped scenario at present) | `no_flow: true` (sealed; `mix_flow` inactive) | Preferential streaming: ductus venosus/IVC blood → foramen ovale → LA; SVC blood → RV. |
| Postnatal (term_neonate_72h) | open both ways, `r_for`/`r_back` 13 mmHg·s/L, `mix_flow` 0.01 L/s | One atrium in pressure (the halves within ≈ 0.01 mmHg) but only **partly mixed**, as IVC/SVC streaming is in a real atrium. `mix_flow` was chosen in the engine review to bring the RA SO2 gap between the halves from 6.1 to 1.5 %. |

Constraints on the resistance and mixing:
- **Stable resistance.** The postnatal resistance follows `R = max(1, ⌈2·dt·(E₁max + E₂max)⌉)`. R must stay above `dt·(E₁ + E₂)`, about 6 at dt 0.0005, or the explicit integration oscillates; the factor 2 covers ANS-raised elastance.
- **Not weight-scaled.** `RAIVCI_RASVC` isn't in the scaler config.
- **Mixed venous saturation.** `Blood` solves both `RAIVCI` and `PA`, the true mixed venous blood; the Monitor reads SvO2 from `PA` (see [Monitor](./Monitor.md)).

## References

- Klotz S, Hay I, Dickstein ML, et al. Single-beat estimation of end-diastolic pressure-volume relationship: a novel method with potential for noninvasive application. *Am J Physiol Heart Circ Physiol* 2006;291(1):H403–H412. [doi:10.1152/ajpheart.01240.2005](https://doi.org/10.1152/ajpheart.01240.2005)

Otherwise this class introduces no literature-derived values. For the time-varying elastance concept see [TimeVaryingElastance](./TimeVaryingElastance.md#references). Chamber elastances are scenario calibrations (see [TermNeonateReference](./TermNeonateReference.md)).

````

### FILE: explain-engine/docs/HeartFunction.md

````markdown
# HeartFunction

`HeartFunction` models how a ventricle becomes compromised when it works against too high a pressure (afterload) or is stretched by too much volume (preload). It watches each ventricle's wall stress beat by beat:
- **Acute:** stress well above the resting level depresses contractility quickly and reversibly.
- **Chronic:** stress that stays high remodels the ventricle slowly.

It acts on the `LV` and `RV` [`HeartChamber`](./HeartChamber.md)s through factor props only. It owns no sub-models.

## Physiology

The healthy responses to load need no extra code; they emerge from the time-varying elastance:
- **Frank–Starling:** more filling gives more stroke volume.
- **Afterload sensitivity:** higher ejection pressure gives a larger end-systolic volume and less stroke volume.

HeartFunction adds the **pathological** part: sustained load that actually *degrades* the ventricle.

The common signal is the **wall stress** (Laplace's law for a sphere): `σ = P · r / (2h)`.
- **Afterload** raises it through the pressure `P` (end-systolic stress).
- **Dilation** raises it through the cavity radius `r` (end-diastolic stress).

So one signal covers both pressure and volume overload.

- **Acute: afterload mismatch and over-distension (seconds to minutes).** When the stress rises well above its resting level, contractility falls. This follows Ross's afterload mismatch concept (stroke volume falls once the preload reserve is used up), not a sarcomere "descending limb", which does not exist in vivo. It recovers fully when the load normalises.
- **Chronic: remodelling (hours to days).** Sustained pressure overload (concentric remodelling) stiffens the ventricle and lowers contractility slightly. Sustained volume overload (eccentric remodelling) dilates the cavity and lowers contractility.

## Inheritance

```
BaseModelClass
  └── HeartFunction
```

## Properties

### Config: switches and geometry

| Property | Unit | Default | Description |
|---|---|---|---|
| `hf_active` | boolean | `true` | Master switch (both layers). |
| `remodel_active` | boolean | `true` | Chronic layer switch. |
| `hw_intercept`, `hw_slope` | g, g/g | 7.799, 0.004296 | Heart weight `hw = hw_intercept + hw_slope · weight_kg · 1000` (the same relation as `Mob`). |
| `wall_density` | g/mL | 1.05 | Myocardial density. |
| `wall_frac_lv`, `wall_frac_rv` | – | 0.35, 0.15 | Share of heart mass in the LV and RV free walls. |
| `wall_volume_lv`, `wall_volume_rv` | mL | 0.0 | Explicit wall volumes; ≤ 0 derives them from heart weight. |

### Config: acute layer

| Property | Unit | Default | Description |
|---|---|---|---|
| `stress_deadband` | – | 1.5 | The response starts above this multiple of the resting setpoint. |
| `g_es_lv`, `g_ed_lv` | 1/mmHg | 0.00125, 0.005 | LV contractility loss per mmHg of end-systolic / end-diastolic stress above the dead-band. |
| `g_es_rv`, `g_ed_rv` | 1/mmHg | 0.002, 0.0075 | The same for the RV (thinner wall, more load-sensitive). |
| `cont_tc` | s | 30 | Time constant of the response. |
| `cont_floor` | – | 0.2 | Lowest acute factor. |

### Config: chronic layer

| Property | Unit | Default | Description |
|---|---|---|---|
| `remodel_tc` | s | 86400 | Remodelling time constant (~1 day; shorten it to see remodelling in a short run). |
| `stress_avg_tc` | s | 300 | Time constant of the slow stress average that drives remodelling. |
| `k_conc`, `k_ecc` | 1/mmHg | 0.01, 0.02 | Concentric / eccentric drive per mmHg of sustained stress above the setpoint. |
| `mal_conc`, `mal_ecc` | – | 0.15, 0.25 | Contractility loss per unit concentric / eccentric remodelling. |
| `stiff_conc` | – | 0.5 | Diastolic stiffening (`el_k`) per unit concentric remodelling. |
| `dil_ecc` | – | 0.4 | Cavity dilation (`u_vol`) per unit eccentric remodelling. |
| `remodel_floor` | – | 0.3 | Lowest chronic contractility factor. |

### Config: setpoints

| Property | Unit | Default | Description |
|---|---|---|---|
| `sigma_es_ref_lv`, `sigma_ed_ref_lv`, `sigma_es_ref_rv`, `sigma_ed_ref_rv` | mmHg | 0.0 | Resting end-systolic / end-diastolic wall stress per ventricle. A value > 0 is kept as given. A value ≤ 0 is learned during the warm-up. |
| `setpoint_warmup` | s | 60 | Learning window, in elapsed model time since the model started (not the engine clock; saved scenarios have a non-zero `model_time_total`). |

### Outputs

| Property | Unit | Description |
|---|---|---|
| `hw` | g | Heart weight. |
| `wall_stress_es_lv`, `wall_stress_ed_lv`, `wall_stress_es_rv`, `wall_stress_ed_rv` | mmHg | Wall stress at end-systole and end-diastole. |
| `radius_es_lv`, `radius_ed_lv`, `radius_es_rv`, `radius_ed_rv` | cm | Cavity radius of the equivalent sphere. |
| `wall_thickness_lv`, `wall_thickness_rv` | cm | Wall thickness at end-diastole. |
| `el_max_load_factor_lv`, `el_max_load_factor_rv` | – | Acute factor (also written to the chamber). |
| `remodel_concentric_lv`, `remodel_eccentric_lv`, `remodel_concentric_rv`, `remodel_eccentric_rv` | – | Remodelling state. |

## Calculation

`calc_model()` (when `hf_active`) computes the heart weight and the two wall volumes, then for each ventricle:

1. **Geometry** (thin-walled sphere, volumes in mL ≙ cm³):
   ```
   r = (3·V_cav / 4π)^(1/3)        h = (3·(V_cav + V_wall) / 4π)^(1/3) − r
   σ_es = esp · r_es / (2·h_es)     σ_ed = edp · r_ed / (2·h_ed)
   ```
   `esp`, `esv`, `edp`, `edv` come from `Heart` (latched each beat); the pressures are transmural.
2. **Setpoints.** During the warm-up each setpoint not given in the definition tracks the highest stress seen. While a ventricle is still learning, both of its layers are held at no effect.
3. **Acute layer:**
   ```
   excess = max(0, σ − stress_deadband · σ_ref)          (end-systolic and end-diastolic)
   target = clamp(1 − g_es·excess_es − g_ed·excess_ed, cont_floor, 1)
   load_factor += dt/cont_tc · (target − load_factor)
   ```
4. **Chronic layer.** Slow averages of `σ_es` and `σ_ed` (time constant `stress_avg_tc`) drive:
   ```
   rc → k_conc · max(0, σ_es,slow − σ_es,ref)            (time constant remodel_tc)
   re → k_ecc  · max(0, σ_ed,slow − σ_ed,ref)
   ```
5. **Write the chamber factors:**
   ```
   el_max_load_factor    = load_factor
   el_max_remodel_factor = max(remodel_floor, 1 − mal_conc·rc − mal_ecc·re)
   el_k_remodel_factor   = 1 + stiff_conc·rc
   u_vol_remodel_factor  = 1 + dil_ecc·re
   ```

## Factor system

None of its own. It writes four of [`HeartChamber`'s](./HeartChamber.md#set-by-other-models) additive terms on the LV and RV; the atria are untouched.

## Inputs and outputs

- **Reads:** `Heart.lv_esp`, `lv_esv`, `lv_edp`, `lv_edv` and the `rv_*` equivalents; `model.weight`.
- **Writes:** `el_max_load_factor`, `el_max_remodel_factor`, `el_k_remodel_factor`, `u_vol_remodel_factor` on `LV` and `RV`, every step.
- **Read by:** `DataCollector` watchers; `scripts/probe_heartfunction.mjs`.

## Assumptions and limitations

- **The dead-band keeps normal loading out.** The response starts only above 1.5 × the resting stress. Without it, any preload rise above rest depressed contractility; the depressed ventricle dilated, which raised the stress further, and a normal +8 % volume load ran away to `cont_floor`. In term_neonate_72h (reflexes off), 1.5 × is reached at:
  - a MAP of ~80 mmHg (LV afterload);
  - LA ~9 mmHg (LV over-dilation);
  - a doubled PVR (RV).

  The gains are a quarter of their first values, so the depression is graded and stable. For example:
  - +50 mL blood volume → LV factor 0.84 (LA 17.6);
  - PVR ×4 → RV 0.81;
  - arterioles ×3 → LV 0.96.
- **Concentric remodelling does not thicken the wall.** The wall volume is fixed by heart weight, so there is no compensating fall in stress. Its diastolic stiffening acts on `el_k`, which is the whole diastolic stiffness of the chambers in every scenario.
- **Spherical geometry for both ventricles.** The crescent-shaped RV is treated as a sphere with 15 % of the heart mass.
- **The heart-weight relation has a large intercept** (7.8 g), so small infants get relatively thick walls and low wall stress. The stress values compare within a scenario, not between sizes.
- **One-beat start-up transient.** Right after a scenario loads, the first latched beat can exceed the dead-band briefly (LV end-diastolic up to 1.54 × in a 25-week PDA patient). The effect on the load factor is about 10⁻⁵.
- **Remodelling is slow by design** (`remodel_tc` one day). Over a normal session it stays at its saved value.

## Example definition (JSON)

From `term_neonate_72h.json`, `models.HeartFunction` (trimmed to the main config props):

```json
{
  "name": "HeartFunction",
  "model_type": "HeartFunction",
  "is_enabled": true,
  "hf_active": true,
  "remodel_active": true,
  "stress_deadband": 1.5,
  "setpoint_warmup": 60,
  "sigma_es_ref_lv": 77.3612,
  "sigma_ed_ref_lv": 25.9997,
  "sigma_es_ref_rv": 124.4274,
  "sigma_ed_ref_rv": 63.1358
}
```

## Usage in the scenarios

One instance in every scenario, enabled, with resting setpoints learned for that scenario. Use `scripts/_relearn_heartfunction.mjs <scenario> --write` to re-learn them after re-calibrating a scenario.

| Scenario | LV σ_es / σ_ed | RV σ_es / σ_ed |
|---|---|---|
| term_neonate_72h | 77.4 / 26.0 | 124.4 / 63.1 |

term_neonate_72h's set-points were re-learned in the re-validation (g). The heart changes (valves, AV inertance, RV, coronary flow, blood volume) had raised its resting LV end-diastolic stress ~19 % above the old set-point (21.6), so the LV dilated slowly at rest (eccentric remodelling ~0.07 per simulated day); after the re-learn it stays at 0.

`scripts/probe_heartfunction.mjs` exercises it on term_neonate_72h with an afterload and a volume challenge.

## References

- Ross J Jr. Afterload mismatch and preload reserve: a conceptual framework for the analysis of ventricular function. *Prog Cardiovasc Dis* 1976;18(4):255–264. [doi:10.1016/0033-0620(76)90021-9](https://doi.org/10.1016/0033-0620(76)90021-9)

The gains, dead-band and time constants are model choices, tuned for graded, stable behaviour (see [Assumptions](#assumptions-and-limitations)).

````

### FILE: explain-engine/docs/HeartValve.md

````markdown
# HeartValve

A `HeartValve` is a [`Resistor`](./Resistor.md) under its own `model_type`. It adds no code: the valve behaviour comes from its configuration (`no_back_flow: true`). The type is a label that marks the heart valves in a scenario.

```js
export class HeartValve extends Resistor {
  static model_type = "HeartValve";
}
```

## Physiology

The four heart valves keep blood moving one way: tricuspid (right atrium → right ventricle), pulmonary (right ventricle → pulmonary artery), mitral (left atrium → left ventricle) and aortic (left ventricle → aorta). A valve opens when the pressure upstream exceeds the pressure downstream and closes as soon as it reverses.

In Explain a valve is an ideal one-way resistance:
- It opens and closes instantly at zero pressure difference.
- It never leaks.
- Its small forward resistance gives a pressure drop proportional to flow.

That is why the valves set the timing of the cardiac cycle: the moments the mitral and aortic valves open and close divide the beat into filling, isovolumic contraction, ejection and isovolumic relaxation. `Heart` uses exactly those moments (the mitral and aortic flows starting and stopping) to measure end-diastolic and end-systolic volumes.

Valve disease is set up through configuration:
- **Atresia:** `no_flow: true`, or the valve disabled.
- **Regurgitation:** `no_back_flow: false` with a finite `r_back`.
- **Stenosis:** a higher `r_for`, or the turbulent `r_k`.

## Inheritance

```
BaseModelClass
  └── Resistor
        └── HeartValve
```

## Properties

All props and their defaults are `Resistor`'s: see [Resistor → Properties](./Resistor.md#properties). The ones that make a resistor a valve:

| Property | Typical value | Role |
|---|---|---|
| `no_back_flow` | `true` | One-way: no flow when the downstream pressure is higher. |
| `r_for` | 55 mmHg·s/L | Forward resistance of the open valve (all valves, all scenarios; to be retuned, see [limitations](#assumptions-and-limitations)). |
| `r_back` | 55 mmHg·s/L | Only acts if `no_back_flow` is turned off (regurgitation). |
| `no_flow` / `is_enabled` | `false` / `true` | Atresia, or an alternative connection switched off. |
| `implicit` | `true` on the outflow valves `LV_AA`, `RV_AA` | Stable flow into the stiff aorta (see [Resistor](./Resistor.md#implicit-flow-implicit)). |

## Calculation

Exactly [`Resistor`'s](./Resistor.md#calculation): forward flow `Δp / r_for_eff` (or the turbulent solve when `r_k > 0`); no flow backward while `no_back_flow`. Flow, volume transfer and composition mixing happen as in any resistor.

## Factor system

`Resistor`'s additive `r_factor` layers (see [Resistor → Factor system](./Resistor.md#factor-system)). No model writes them on the valves in the shipped scenarios.

## Inputs and outputs

- **Reads / writes:** the pressures of the two chambers or vessels it joins; their volumes and composition (as any resistor).
- **Read by:** `Heart` (`LA_LV` and the active LV outflow valve: their flow starting and stopping marks end-diastole and end-systole for the per-beat analysis), `Monitor` and `DataCollector` watchers.
- **Written by:** the scenario generators for congenital lesions (`no_flow`, `is_enabled`, `no_back_flow`, `r_back`; e.g. `_make_dtga.mjs`, `_make_hlhs.mjs`, `_make_ta.mjs`, `_make_paivs.mjs`).

## Assumptions and limitations

- **Ideal valves.** Instant opening and closing, no leaflet dynamics, no closing backflow, no regurgitation unless configured.
- **One resistance for every valve, and too high at term.** All valves have `r_for` 55 mmHg·s/L in all scenarios. At term that gives peak open-valve gradients of mitral 7.8, aortic 7.1, tricuspid 5.3 and pulmonary 4.7 mmHg. Normal neonatal velocities (about 0.5–0.7 m/s across the atrioventricular valves, 0.8–1.0 m/s across the outflow valves; ΔP ≈ 4v²) suggest roughly 1–2 and 3–4 mmHg. In the 1 kg preterm the gradients are 1.4–5.3 mmHg. A linear resistance also gives a gradient proportional to flow, where a real valve's grows with flow². The valve resistances are to be retuned per scenario in the scenario re-validation session.
- **The type is a label.** The UI shows the same fields for `HeartValve` and `Resistor`. Nothing in the engine branches on the type.

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Heart.components.LV_AA` (trimmed to the config props):

```json
{
  "name": "LV_AA",
  "model_type": "HeartValve",
  "is_enabled": true,
  "comp_from": "LV",
  "comp_to": "AA",
  "r_for": 55,
  "r_back": 55,
  "r_k": 0,
  "no_flow": false,
  "no_back_flow": true,
  "implicit": true
}
```

## Usage in the scenarios

Seven valves in term_neonate_72h, all owned by `Heart`:

| Valve | Connection | State |
|---|---|---|
| Tricuspid | `RAIVCI_RV`, `RASVC_RV` (one per right-atrial half) | enabled |
| Mitral | `LA_LV` | enabled |
| Pulmonary | `RV_PA` | enabled |
| Aortic | `LV_AA` | enabled, implicit |
| Alternative outflows | `RV_AA`, `LV_PA` | disabled; switched on by the transposition generator (`_make_dtga.mjs`) |

## References

No literature-derived values. The valve resistance is a scenario parameter.

````

### FILE: explain-engine/docs/Hormones.md

````markdown
# Hormones

`Hormones` is the slow neuro-hormonal controller of volume, pressure and osmolality: the renin–angiotensin–aldosterone system (RAAS) and antidiuretic hormone (ADH, vasopressin). It is the long-loop counterpart of the fast [Ans](./Ans.md) baroreflex. Each hormone is an activity level (1.0 = resting) that moves first-order toward a target set by its stimuli and acts through its own effector channels. It holds no blood and is neutral at rest: it only diverges when the patient is perturbed (haemorrhage, hyperosmolality) or a pathway is switched off.

## Physiology

- **Renin–angiotensin.** When renal perfusion pressure or circulating volume falls, the kidney releases renin, which generates angiotensin II within tens of seconds to minutes. Angiotensin II:
  - constricts the systemic arterioles (and the veins, mobilising volume);
  - constricts the efferent arteriole of the glomerulus, defending filtration pressure (GFR) when perfusion falls;
  - stimulates aldosterone.
- **Aldosterone** acts on the distal nephron over hours: it retains sodium and excretes potassium. Hyperkalaemia stimulates it directly.
- **ADH** rises with plasma osmolality (a 1–2 % rise is enough) and, less sensitively, with a large volume loss. It makes the collecting duct permeable to water (antidiuresis), and at high levels it constricts vessels.

## Inheritance

```
BaseModelClass
  └── Hormones
```

## Properties

### Config: gating and wiring

| Property | Unit | Default | Description |
|---|---|---|---|
| `hormones_running` | boolean | `true` | Master switch. Off releases every owned channel to 1 once, then idles. |
| `raas_enabled`, `adh_enabled` | boolean | `true` | Per-pathway switches (off holds that pathway's hormones at 1). |
| `perfusion_model`, `perfusion_prop` | – | `"KID_ART"`, `"pres"` | Renal perfusion pressure (averaged over each update). |
| `volume_model`, `volume_prop` | – | `"Circulation"`, `"total_blood_volume"` | Circulating volume. |
| `plasma_model` | – | `"AA"` | Plasma Na and K source (`solutes`). |
| `circulation_name`, `kidneys_name`, `efferent_name` | – | `"Circulation"`, `"Kidneys"`, `"KID_CAP_KID_VEN"` | Effector targets. |

### Config: set-points

| Property | Unit | Default | Description |
|---|---|---|---|
| `perfusion_setpoint` | mmHg | 40 | Healthy renal perfusion pressure of this patient. |
| `volume_setpoint` | L | 0.4 | Healthy circulating volume of this patient. |
| `osmo_na_setpoint` | mmol/L | 138 | Plasma Na (the osmolality proxy, osmolality ≈ 2·Na). |
| `k_setpoint` | mmol/L | 3.5 | Plasma K. |

The set-points are the patient's **healthy reference**, not its current state (see [Assumptions](#assumptions-and-limitations)).

### Config: dynamics and effects

| Property | Default | Description |
|---|---|---|
| `renin_gain`, `renin_vol_gain` | 3.0, 3.0 | Angiotensin drive per fractional perfusion and volume deficit. |
| `angiotensin_tc` | 30 s | Angiotensin time constant. |
| `aldo_gain`, `aldo_k_in_gain` | 1.0, 2.0 | Aldosterone drive per (angiotensin − 1) and per fractional K excess. |
| `aldosterone_tc` | 1800 s | Aldosterone time constant (physiologic; compress for demos). |
| `adh_gain_osmo`, `adh_gain_baro` | 4.0, 1.0 | ADH drive per fractional Na excess and per fractional volume deficit. |
| `adh_tc` | 120 s | ADH time constant. |
| `hormone_min`, `hormone_max` | 0, 8 | Clamp on every hormone activity. |
| `ang_svr_gain`, `ang_svr_ven_gain` | 0.3, 0.2 | Arteriolar and venular constriction per (angiotensin − 1). |
| `adh_svr_gain` | 0.05 | Arteriolar constriction per (ADH − 1). |
| `ang_efferent_gain` | 0.5 | Renal efferent constriction per (angiotensin − 1). |
| `aldo_na_gain`, `aldo_k_gain` | 0.01, 0.1 | Na reabsorption rise and K reabsorption fall per (aldosterone − 1). |
| `adh_water_gain` | 0.015 | Water reabsorption rise per (ADH − 1). |
| `svr_factor_min`, `svr_factor_max`, `efferent_factor_min`, `efferent_factor_max` | 0.5 / 5 | Clamps on the vascular effects. |
| `na_factor_min`, `na_factor_max`, `k_factor_min`, `k_factor_max`, `water_factor_min`, `water_factor_max` | 0.95/1.02, 0.2/1.5, 0.5/1.03 | Clamps on the renal effects. |

### Outputs

| Property | Description |
|---|---|
| `renin` | Instantaneous angiotensin drive (the target, un-lagged). |
| `angiotensin`, `aldosterone`, `adh` | Hormone activities (1 = rest). |
| `svr_factor`, `svr_ven_factor`, `efferent_factor` | Applied vascular effects. |
| `na_reabs_factor`, `k_reabs_factor`, `water_reabs_factor` | Applied renal effects. |
| `sensed_perfusion`, `sensed_volume`, `sensed_na`, `sensed_osmolality`, `sensed_k` | What the sensors read. |

## Calculation

Every step the renal perfusion pressure is integrated, so the controller senses its mean, not one sample of a pulsatile pressure. **Every 1 s:**

1. **Fractional errors** against the set-points: perfusion and volume deficits, Na and K excesses.
2. **Hormones** (each a first-order lag with step fraction `min(1, Δt/tc)`, clamped 0–8):
   ```
   renin       = 1 + renin_gain·perf_deficit + renin_vol_gain·vol_deficit
   angiotensin → renin                                                      (tc 30 s)
   aldosterone → 1 + aldo_gain·(angiotensin − 1) + aldo_k_in_gain·k_excess   (tc 1800 s)
   adh         → 1 + adh_gain_osmo·na_excess + adh_gain_baro·vol_deficit      (tc 120 s)
   ```
3. **Effects**, clamped:
   ```
   Circulation.svr_factor_hormones_art = 1 + 0.3·(ang − 1) + 0.05·(adh − 1)
   Circulation.svr_factor_hormones_ven = 1 + 0.2·(ang − 1)
   KID_CAP_KID_VEN.r_factor_ps         = 1 + 0.5·(ang − 1)                    renal efferent arteriole
   Kidneys.reabsorption_factors.na     = 1 + 0.01·(aldo − 1)
   Kidneys.reabsorption_factors.k      = 1 − 0.1·(aldo − 1)
   Kidneys.reabs_factor_adh            = 1 + 0.015·(adh − 1)
   ```

## Factor system

Hormones writes **its own channels**, so it composes with the other writers instead of overwriting them:
- **Circulation:** `svr_factor_hormones_art` / `_ven`, which Circulation adds to the vessels' `r_factor_ps` as deltas, next to the user's `svr_factor_art` and Drugs' `svr_factor_drug`. See [Circulation](./Circulation.md).
- **The renal efferent resistor:** its `r_factor_ps`, owned by Hormones. The renal *afferent* is left to the Kidneys' autoregulation, which acts on `AD_KID_ART`.
- **Kidneys:** dedicated hormone factors (`reabsorption_factors`, `reabs_factor_adh`), separate from the user's reabsorption layer. See [Kidneys](./Kidneys.md).

## Inputs and outputs

- **Reads:** `KID_ART.pres`, `Circulation.total_blood_volume`, `AA.solutes.na` and `.k`.
- **Writes:** the channels above.
- **Written by:** the user (switches, gains); the scenario generators (set-points, via `scripts/_reference.mjs`).
- **Read by:** Circulation, Kidneys and the efferent resistor (the channels); `DataCollector` watchers.

## Assumptions and limitations

- **Set-points are the healthy reference of the patient's size and gestation.** A lesion keeps its size's reference, so a coarctation's low renal pressure activates RAAS (angiotensin ≈ 2.5), as it should. `scripts/_reference.mjs` (`scaleHormoneReferences`) derives them: volume scales with weight, perfusion with the gestation's defended MAP (`BR_MAP.set_value`). `_make_preterm.mjs`, `_make_bischoff.mjs`, `_make_fetus*.mjs` and `build_patient.mjs` apply it; below 34 weeks the [Kidneys](./Kidneys.md) renal reference replaces `perfusion_setpoint`.
- **Near-neutral at rest** in term_neonate_72h (300 s from build): angiotensin, aldosterone and ADH 0.99–1.03. (The since-removed fetus_term was not: its fetal renal pressure, 39 mmHg, sat above its 35 mmHg reference, so angiotensin settled at 0.70.)
- **Aldosterone's volume effect is small:** water transport isn't osmotically coupled to Na, so aldosterone shows as lower urinary Na rather than volume. ADH and angiotensin carry the volume and pressure defence. With the physiologic `aldosterone_tc`, aldosterone barely moves in a short session.
- **The owned channels are overwritten** while running: edit them through the hormones, or switch them off (`hormones_running`, `raas_enabled`, `adh_enabled`), which releases them to 1.
- **Not modelled:** natriuretic peptides, thirst and intake, catecholamines (the ANS and Drugs cover those).
- **Validation (at introduction, 2026-10):** `scripts/headless.mjs <scenario> --bleed FRAC | --naload Δ`:
  - a −8 % haemorrhage raises angiotensin and aldosterone and constricts the efferent, so GFR is defended and urine falls toward oliguria;
  - +12 mmol/L Na raises ADH 1.0 → 1.35 and halves urine output, while RAAS stays quiet.

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Hormones` (trimmed to gating and set-points; gains and time constants are the defaults):

```json
{
  "name": "Hormones",
  "model_type": "Hormones",
  "is_enabled": true,
  "hormones_running": true,
  "raas_enabled": true,
  "adh_enabled": true,
  "perfusion_setpoint": 40.85,
  "volume_setpoint": 0.286,
  "osmo_na_setpoint": 138.19,
  "k_setpoint": 3.452,
  "angiotensin_tc": 30,
  "aldosterone_tc": 1800,
  "adh_tc": 120
}
```

## Usage in the scenarios

One instance in every scenario, running. term_neonate_72h: `perfusion_setpoint` 40.9 mmHg, `volume_setpoint` 0.301 L.

## References

No literature values; gains and time constants are model choices calibrated for teaching.

````

### FILE: explain-engine/docs/Kidneys.md

````markdown
# Kidneys

`Kidneys` turns the renal vascular bed (`KID_ART` → `KID_CAP` → `KID_VEN`) into a filtering organ. It holds no blood itself. Each step it:
- filters plasma out of the glomerular capillary `KID_CAP` by the Starling balance;
- reabsorbs most of the water and each solute by its own fraction;
- moves the rest into a `URINE` compartment it owns.

It also autoregulates glomerular filtration (myogenic and tubuloglomerular feedback) on the afferent arteriole, and offers the hooks through which [Hormones](./Hormones.md) applies ADH and aldosterone.

## Physiology

The glomerulus filters plasma at a rate set by the filtration coefficient and the net filtration pressure: glomerular capillary pressure minus Bowman's capsule pressure minus plasma oncotic pressure. Proteins and cells stay behind; small solutes pass at their plasma concentration. The tubules reabsorb ~99 % of the filtered water and sodium at term, less in the immature kidney, so a preterm infant loses more sodium (higher FENa) and concentrates urine poorly.

Renal blood flow and GFR stay nearly constant over a range of pressures:
- **myogenic response:** the afferent arteriole constricts when stretched;
- **tubuloglomerular feedback:** the macula densa senses distal NaCl delivery and constricts the afferent when it is high.

Neonatal GFR is low and rises steeply with gestation and postnatal age.

## Inheritance

```
BaseModelClass
  └── Kidneys
```

## Properties

### Config: filtration and reabsorption

| Property | Unit | Default | Description |
|---|---|---|---|
| `kidneys_running` | boolean | `true` | Switch for filtration. |
| `kid_cap_name`, `urine_name` | – | `"KID_CAP"`, `"URINE"` | Glomerular capillary and the bladder compartment (a component, kept out of the blood pool). |
| `kf` | L/(s·mmHg) | 6.6e-6 | Filtration coefficient. term 6.0e-6, preterm 2.1–3.4e-6 (scaled by body surface). |
| `p_bowman` | mmHg | 8 | Bowman's capsule pressure (preterm lower, scaled by the gestation's MAP). |
| `oncotic_base`, `albumin_ref` | mmHg, g/L | 18, 25 | Plasma oncotic pressure at the reference albumin (preterm 15). |
| `reabsorption_fraction` | – | 0.985 | Water reabsorption fraction. term_neonate_72h 0.98. |
| `reabsorption_fractions` | {solute: fraction} | `{}` | Per-solute fractions; absent = the water fraction (iso-osmotic). term_neonate_72h Na 0.99. |
| `filterable_solutes` | list | `na, k, ca, cl, lact, mg, phosphates, uma` | Solutes that pass the glomerulus. Everything else stays in the blood. |
| `kf_factor`, `kf_factor_ps`, `kf_factor_scaling_ps` | – | 1.0 | Additive layers on `kf` (the first reset each step). |
| `reabs_factor`, `reabs_factor_ps`, `reabs_factor_scaling_ps` | – | 1.0 | Multiplicative layers on the water fraction (the first reset each step). |
| `reabs_factor_adh` | – | 1.0 | ADH water channel (written by Hormones). |
| `reabsorption_factors` | {solute: factor} | `{}` | Aldosterone / drug channel on the per-solute fractions (written by Hormones: Na > 1, K < 1). |

### Config: autoregulation

| Property | Unit | Default | Description |
|---|---|---|---|
| `autoregulation_enabled` | boolean | `false` | On in every scenario. |
| `aff_resistor_name` | – | `"AD_KID_ART"` | The afferent's inflow resistor (the effector). |
| `myogenic_input_model`, `myogenic_input_prop` | – | `"KID_ART"`, `"pres"` | Pressure the myogenic limb senses. |
| `myogenic_p_set` | mmHg | 35 | Set-point: each scenario's resting `KID_ART.pres` (term_neonate_72h 40.9). |
| `myogenic_p_min`, `myogenic_p_max` | mmHg | 25, 55 | Autoregulatory window (term 25–65). |
| `myogenic_gain_up`, `myogenic_gain_down` | 1/mmHg | 0.06 | Resistance gain above and below the set-point (scenarios 0.18). |
| `myogenic_tc` | s | 4 | Myogenic time constant. |
| `tgf_use_nacl` | boolean | `true` | TGF senses GFR × Na (else GFR alone). |
| `tgf_setpoint` | – | 0 | TGF set-point; ≤ 0 = captured after `tgf_seed_delay`. Stored in every scenario. |
| `tgf_seed_delay` | s | 30 | Warm-up before the capture. |
| `tgf_gain`, `tgf_tc` | –, s | 0.8, 30 | TGF gain per fractional error (scenarios 2.0) and time constant. |
| `afferent_apply_tc` | s | 6 | Lag on the applied factor. |
| `afferent_factor_min`, `afferent_factor_max` | – | 0.5, 4 | Clamp on the applied factor (scenarios 0.5–10). |

### Outputs

| Property | Unit | Description |
|---|---|---|
| `nfp` | mmHg | Net filtration pressure. |
| `gfr` | mL/min | Glomerular filtration rate. |
| `urine_flow` | mL/min | Urine output. |
| `urine_volume` | mL | Cumulative urine (`URINE.vol`). |
| `fe_na` | % | Fractional excretion of sodium. |
| `myogenic_factor`, `tgf_factor`, `afferent_factor` | – | Limb factors and the applied afferent factor. |
| `sensed_pressure`, `tgf_signal` | mmHg, – | Inputs of the two limbs. |

## Calculation

Each step (nothing while off; skipped if `KID_CAP` or `URINE` is missing):

1. **Effective values:** `kf_eff` (additive layers); `reabs_eff` = fraction × its layers × `reabs_factor_adh`, clamped to 0–0.9999.
2. **Starling:**
   ```
   oncotic = oncotic_base · albumin / albumin_ref
   nfp     = max(0, KID_CAP.pres − p_bowman − oncotic)
   GFR     = kf_eff · nfp,      urine = GFR · (1 − reabs_eff)
   ```
3. **Transfer** of one step's filtrate `Vf`:
   - urine water `Vf·(1 − reabs_eff)` leaves `KID_CAP` for `URINE`;
   - each filterable solute leaves with `Vf · c · (1 − its fraction)`, its fraction modulated by `reabsorption_factors`;
   - **everything not filtered keeps its mass**, so its concentration rises by `V_before / V_after`. That covers albumin and Hb (haemoconcentration), glucose (no glucosuria), the drugs, and the blood's O2 and CO2.
4. **Autoregulation**, every 15 ms:
   ```
   myogenic → 1 + gain · (clamp(KID_ART.pres, p_min, p_max) − p_set)       (tc myogenic_tc)
   tgf      → 1 + tgf_gain · (GFR·Na − tgf_setpoint) / tgf_setpoint          (tc tgf_tc)
   afferent_factor → clamp(myogenic · tgf, min, max)                          (tc afferent_apply_tc)
   AD_KID_ART.r_factor_ps = afferent_factor
   ```
   It acts on the afferent's inflow resistor, upstream of the sensed `KID_ART.pres`, so the loop is negative feedback. The `KID_ART` vessel keeps the systemic channels Circulation adds (SVR, Hormones, Drugs). Switching autoregulation off releases the factor to 1 once.

## Factor system

- `kf` takes additive layers (as Capacitance).
- The reabsorption fraction takes multiplicative layers (it is a fraction).
- ADH and aldosterone have their own channels: `reabs_factor_adh` and `reabsorption_factors`.
- It owns `AD_KID_ART.r_factor_ps`.

## Inputs and outputs

- **Reads:** `KID_CAP` (`pres`, `vol`, `solutes`), `KID_ART.pres`.
- **Writes:** `KID_CAP` (`vol`, `solutes`, `drugs`, `to2`, `tco2`), `URINE` (`vol`, `solutes`), `AD_KID_ART.r_factor_ps`.
- **Written by:** Hormones (`reabs_factor_adh`, `reabsorption_factors`); the user and scenario scripts (calibration, see below).
- **Read by:** `DataCollector` watchers, the Monitor (urine output).

## Assumptions and limitations

- **Oncotic pressure is linear in albumin.**
- **Reabsorption fractions are static per solute:** no transport maxima, no secretion, no acid–base handling (bicarbonate, ammonium), no concentrating mechanism.
- **The bladder never empties** (`URINE` accumulates).
- **Urine water comes from `KID_CAP` only;** the rest of the body equilibrates through the circulation (no interstitial compartment).

### Calibration

- **Term:** `kf` was back-solved for a GFR of ~4 mL/min at a net filtration pressure of ~11 mmHg (a thin margin, so `p_bowman + oncotic` must stay well below `KID_CAP.pres`).
- **Preterm (below 34 weeks) — the kidney of its own gestation and size:** `scripts/_renal_reference.mjs` with `scripts/_renal_bed.mjs`, applied by `reseed_preterm.mjs`, `build_patient.mjs` and `_fix_renal_bed.mjs`. The rules were chosen with the model's author:

  | Quantity | Rule | Basis |
  |---|---|---|
  | GFR target | Vieux 2010 day-7 medians, 7.9 (27 wk) → 30.3 (31 wk) mL/min/1.73 m², exponential, extrapolated to 24 wk; plateau from 31 wk | Vieux R, et al. *Pediatrics* 2010. doi:10.1542/peds.2009-1426 |
  | `oncotic_base` | 15 mmHg ≤ 28 wk, linear to 18 at 40 wk | preterm plasma colloid osmotic pressure ~15 vs term ~17–19 |
  | `p_bowman` | 8 × BR_MAP set-point / 50 | immature transglomerular gradient only modestly lower |
  | `kf` | term `kf` × body surface / term body surface (Mosteller) | the filtration surface grows with the body |
  | Renal blood flow | follows the GFR target at term's filtration fraction | inulin and PAH clearance rise in parallel |
  | Glomerular pressure | `p_bowman` + oncotic + GFR target / `kf` | what that `kf` needs to filter the target |

  `solveRenalBed` then iterates the base resistances of `KID_ART` and `KID_VEN` until renal blood flow and `KID_CAP.pres` meet the targets. It seeds the myogenic set-point, the TGF set-point and Hormones' `perfusion_setpoint` at that rest. The resulting GFR and urine values are in the scenario tables below.

- **Tooling:** `node scripts/headless.mjs <scenario>` reproduces and re-tunes the renal panel (GFR, urine, FE, afferent factor) with overrides such as `--kf` and `--water`.

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Kidneys` (trimmed to the main config; `components` holds `URINE`):

```json
{
  "name": "Kidneys",
  "model_type": "Kidneys",
  "is_enabled": true,
  "kidneys_running": true,
  "kf": 6e-6,
  "p_bowman": 8,
  "oncotic_base": 18,
  "reabsorption_fraction": 0.98,
  "reabsorption_fractions": { "na": 0.99, "cl": 0.988, "lact": 0.99, "ca": 0.975, "mg": 0.95, "k": 0.88, "uma": 0.7, "phosphates": 0.82 },
  "autoregulation_enabled": true,
  "aff_resistor_name": "AD_KID_ART",
  "myogenic_p_set": 40.877,
  "myogenic_p_min": 25,
  "myogenic_p_max": 65,
  "myogenic_gain_up": 0.18,
  "myogenic_gain_down": 0.18,
  "tgf_gain": 2,
  "tgf_setpoint": 554.96,
  "afferent_factor_max": 10
}
```

## Usage in the scenarios

One instance in every scenario, with autoregulation on. Stored values at rest:

| Scenario | `kf` (×1e-6) | Water reabs. | GFR (mL/min) | Urine (mL/kg/h) |
|---|---|---|---|---|
| term_neonate_72h | 6.0 | 0.98 | 4.75 | 1.6 |

## References

- Vieux R, Hascoet JM, Merdariu D, Fresson J, Guillemin F. Glomerular filtration rate reference values in very preterm infants. *Pediatrics* 2010;125(5):e1186–92. doi:10.1542/peds.2009-1426.

````

### FILE: explain-engine/docs/Lactate.md

````markdown
# Lactate

`Lactate` makes blood lactate a product of tissue hypoxia. When a tissue bed's O2 content falls below an anaerobic threshold, the bed produces lactate in proportion to its unmet O2 demand. Lactate is cleared back toward its baseline everywhere. Lactate is a strong anion in the [BloodComposition](./BloodComposition.md) acid-base solver, so a rise lowers pH, bicarbonate and base excess, a lactic acidosis, with no change to the solver. It holds no compartment and is neutral at rest.

## Physiology

When tissue oxygen delivery falls below need (shock, asphyxia, severe hypoxaemia, anaemia), cells switch to anaerobic glycolysis. Each glucose then yields 2 lactate instead of being oxidised with 6 O2, so roughly 0.33 mmol lactate is made per mmol O2 not delivered. Lactate and its hydrogen ion acidify the blood. The liver (and kidney) clear it, with a half-life of minutes once perfusion is restored. A rising lactate is a key marker of perinatal asphyxia and shock; a falling one marks successful resuscitation.

## Inheritance

```
BaseModelClass
  └── Lactate
```

## Properties

### Config (set in the definition JSON)

| Property | Unit | Default | Description |
|---|---|---|---|
| `lactate_running` | boolean | `true` | Production switch (clearance always runs). |
| `metabolism_name` | – | `"Metabolism"` | Supplies the beds, their shares and VO2. |
| `lact_baseline` | mmol/L | 1.0 | Resting lactate, the clearance target. 1.5 in every scenario. |
| `threshold_frac` | – | 0.5 | Anaerobic threshold as a fraction of each bed's resting O2 content. |
| `lact_per_o2_deficit` | mmol/mmol | 0.33 | Lactate per mmol of unmet O2 demand. |
| `lact_clearance` | 1/s | 0.002 | First-order clearance toward baseline (half-life ~6 min). |
| `prod_gain` | – | 1.0 | Overall production scaler. |

### Baseline (captured, saved with the state)

| Property | Unit | Description |
|---|---|---|
| `baseline_captured` | boolean | The thresholds have been captured. |
| `baseline_to2` | {bed: mmol/L} | Each bed's resting O2 content: the minimum over the first 90 s after a fresh build. |

### Outputs

| Property | Unit | Description |
|---|---|---|
| `arterial_lactate` | mmol/L | `AA` lactate. |
| `total_production_step` | mmol | Lactate produced in the last update. |
| `anaerobic_fraction_max` | 0–1 | Worst bed's anaerobic fraction in the last update. |

## Calculation

Every 1 s:

1. **Baseline** (fresh build only): for 90 s each bed's lowest O2 content is recorded; then production is armed. The minimum puts the threshold below the operating trough, so even chronically hypoxic scenarios (cyanotic heart disease) stay neutral at rest.
2. **Production**, per bed with share f:
   ```
   threshold  = threshold_frac · baseline_to2
   anaerobic  = clamp((threshold − to2) / threshold, 0, 1)
   O2 demand  = vo2 · factors · weight / 60 / 22.414 · Δt · f                (mmol, as Metabolism)
   lactate   += anaerobic · O2 demand · lact_per_o2_deficit · prod_gain      (mmol, into that bed)
   ```
3. **Clearance:** every blood compartment's `lact` relaxes toward `lact_baseline` by `lact_clearance · Δt`.

**Example** (term_neonate_72h, FiO2 0.08): after 3 min SaO2 is 48 %, the worst bed is 42 % anaerobic and lactate 1.6 mmol/L; 3 min later it is 3.2 mmol/L with the worst bed fully anaerobic.

## Factor system

None.

## Inputs and outputs

- **Reads:** Metabolism (`metabolic_active_models`, `vo2` and its factors); each bed's `to2`, `vol`; `model.weight`.
- **Writes:** `solutes.lact` of the beds (production) and of every blood compartment (clearance).
- **Written by:** the user (rates, switch).
- **Read by:** BloodComposition (as a strong anion, through `solutes.lact`); `DataCollector` watchers, the Monitor.

## Assumptions and limitations

- **Threshold on content, not on delivery or the deficit.** Production starts when a bed's O2 content falls below half its resting value. It is separate from [Metabolism](./Metabolism.md)'s `o2_deficit` (O2 demand that found no O2 at all), so lactate rises well before the deficit appears.
- **Lactate lives only in the blood,** as glucose does (see [Glucose](./Glucose.md)): real lactate distributes through total body water, so concentration changes here run faster than in vivo.
- **Clearance is first-order and constant:** it doesn't fall with liver hypoperfusion or hypothermia, and it also raises a value below baseline (e.g. after dilution) back to baseline.
- **No glucose coupling:** producing lactate consumes no glucose, and clearing it makes none (no Cori cycle).
- **Order:** it must follow Metabolism in the scenario's `models` map, so it reads the O2 contents Metabolism just set.

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Lactate` (trimmed to the config props):

```json
{
  "name": "Lactate",
  "model_type": "Lactate",
  "is_enabled": true,
  "lactate_running": true,
  "metabolism_name": "Metabolism",
  "lact_baseline": 1.5,
  "threshold_frac": 0.5,
  "lact_per_o2_deficit": 0.33,
  "lact_clearance": 0.002,
  "prod_gain": 1
}
```

## Usage in the scenarios

One instance in every scenario, with the values above (baseline 1.5 mmol/L, matching `Blood.solutes.lact`).

## References

No literature values; 0.33 mmol lactate per mmol O2 is the glycolysis stoichiometry (2 lactate per glucose, 6 O2 per glucose), the clearance half-life is a model choice.

````

### FILE: explain-engine/docs/MODEL_DEFINITIONS.md

````markdown
# Model definitions (scenario files)

A scenario file is a single JSON document that describes one complete patient/experiment: the engine settings, every model instance with its parameters and current state, plus the UI metadata (diagram, animation, saved tabs/presets) that consumers may attach. The canonical library lives in this repo at `model_definitions/*.json`, with `model_definitions/index.json` listing the available scenarios — a flat JSON array of filename **stems** (no `.json`), each a valid argument to `Model.load(name)`. `Model.load(name)` fetches `<name>.json`, unwraps it, and hands the result to `build()`; how the file is served is the consumer's business.

> **This repo is the source of truth for scenarios — edit `model_definitions/` here.**
>
> **Only the term neonate is shipped** (since 2026-10-25). The 72 h baby was `term_neonate` until 2026-10-26; `Model.load` and `build_patient.mjs` still accept that name (`helpers/ScenarioAliases.js`). `term_neonate_72h` is the literature-validated healthy term
> neonate at 72 h ([TermNeonateReference](./TermNeonateReference.md)) and the root every other patient is
> built from. `term_neonate_1h` is the same baby 1 h after a vaginal birth with delayed cord clamping (open
> bidirectional duct, near-systemic pulmonary pressure, high output), `term_neonate_12h` the same baby at
> 12 h (closing left-to-right duct, PAP 41) and `term_neonate_24h` at 24 h (small restrictive duct, PAP 34),
> all generated from it by `scripts/_make_term_transition.mjs --age 1|12|24` ([TermTransitionReference](./TermTransitionReference.md)). The preterm scenarios (`preterm_25wk`, `preterm_28wk`, `preterm_30wk`, 2026-10-18/19), the
> fetal scenarios (`fetus_25wk`, `fetus_30wk`, `fetus_term`, 2026-10-19/20) and the three Bischoff 2021
> scenarios (2026-10-22/23) were removed on 2026-10-25, during the re-validation, together with their
> generators (`_make_preterm_validated.mjs`, `_make_fetus_validated.mjs`), lever profiles, reference pages and
> probe targets: term is finished first, then they are rebuilt from scratch. Git history holds them.
> The frozen set that the P1 companion and the ToF lesson used (`bischoff_cohort`, `p1_baseline`,
> `p1_pda_none`, `tof_severe`) was built on the older engine and was archived on 2026-10-20. Everything else
> is in [`model_definitions/archive/`](../model_definitions/archive/README.md) until it is rebuilt from
> the fixed term baby.
>
> Consumers generate their own copy from it. In the [explain-ui](https://github.com/explain-labs/explain-ui)
> web app, `scripts/sync-scenarios.mjs` copies this directory into its `public/model_definitions/`
> on every `predev`/`prebuild` and serves it statically. **That copy is generated, gitignored, and
> overwritten** — editing a canonical scenario there loses your work on the next `npm run dev`. (The
> sync is additive, so *new* files written alongside — user/developer snapshots — do persist.)

## Top-level keys

Only `model_definition` (plus the diagram/animation blocks consumed by the worker `AnimationPacker`) reaches the engine. Everything else is UI/metadata that the Vue layer and stores read off `model.loadedFileData`.

| Key | Type | Consumed by | Meaning |
|---|---|---|---|
| `name` | string | UI / store | Scenario display name (`loadedFileData.name`). Not used by the engine. |
| `user` | string | metadata | Author tag. Not used by the engine. |
| `description` | string | metadata | Free-text description. Not used by the engine. |
| `diagram_definition` | object | worker (`AnimationPacker`) | Sprite-diagram layout `{ settings, components }`. Back-filled into `model_definition` by `load()` (see below). |
| `animation_definition` | object | worker (`AnimationPacker`) | Animation layout `{ settings, components }`. Back-filled into `model_definition` by `load()`. |
| `configuration` | object | UI / stores only | Dashboard state (tabs, presets, monitors, controllers, optional `events`). The engine **never** reads this in `build()`. |
| `model_definition` | object | **engine** (`build`) | The only block the engine instantiates from. See below. |

`Model.load()` does the unwrap and back-fill:

```js
const definition = jsonData.model_definition || jsonData;          // unwrap
if (jsonData.diagram_definition && definition.diagram_definition === undefined)
  definition.diagram_definition = jsonData.diagram_definition;     // back-fill only if nested key absent
if (jsonData.animation_definition && definition.animation_definition === undefined)
  definition.animation_definition = jsonData.animation_definition;
this.build(definition);
```

So a scenario may hold the diagram/animation either at the top level **or** nested inside `model_definition`; the top-level copy is only used when the nested key is `undefined`. (The save path keeps the diagram/animation at the top level and strips the nested duplicate so an edit isn't shadowed — see `_processModelState`.)

## The `model_definition` block

This is the object the engine builds from. `build()` copies every key **except `models`** straight onto the live engine `model` object, then instantiates and initializes the `models` map.

| Key | Type | Meaning |
|---|---|---|
| `weight` | number (kg) | Patient weight. Frozen at build into `model._baseline_weight` (the weight-scaling anchor for `reset()` / `scale_to_weight()`). |
| `height` | number (m) | Patient height. Engine-stored; used by models that need it. |
| `gestational_age` | number (weeks) | Gestational age. |
| `age` | number | Postnatal age. |
| `modeling_stepsize` | number (s) | Integration step. `calculate(sec)` runs `sec / modeling_stepsize` steps; the realtime loop batches `rtInterval / modeling_stepsize` steps per tick. |
| `model_time_total` | number (s) | Accumulated simulation time. **Non-zero in saved scenarios** — the file is a mid-run snapshot, not a fresh state (see below). |
| `_baseline_weight` | number (kg) | Persisted weight-scaling baseline. Note `build()` overwrites this from `weight` regardless, so the two normally match. |
| `scaler_config` | object | Named lists of component names per scaling group, read by `ModelScaler`. See [`scaler_config`](#scaler_config). |
| `models` | object | `name → entry` map of every model instance. The heart of the file. See below. |
| `diagram_definition` | object | Optional nested copy of the sprite diagram (else back-filled from top level). |
| `animation_definition` | object | Optional nested copy of the animation layout (else back-filled from top level). |

## `models` entry shape

`models` is a map keyed by instance name. Each entry is one model instance. The reference `term_neonate_72h.json` has 68 top-level entries (1 each of the high-level systems — `Heart`, `Breathing`, `Ans`, `Circulation`, `Respiration`, `Blood`, `Gas`, `Metabolism`, `Pda`, `Shunts`, devices, …) plus 43 `Resistor` entries wiring compartments together. Composite models (e.g. `Circulation`) carry their own sub-network under `components`.

### Envelope keys (every entry)

| Key | Type | Meaning |
|---|---|---|
| `name` | string | Instance key. Must match its key in the `models` map; used for `comp_from`/`comp_to` wiring. |
| `model_type` | string | Class selector. Looked up in `available_model_map` (built from everything `ModelIndex.js` exports). A missing type aborts the build (see below). |
| `is_enabled` | boolean | Gate for `step_model()` — a disabled model does not compute. |
| `components` | object | Optional sub-models a composite owns; base `init_model` instantiates each into `model.models` and inits it. `{}` when none. |

Everything else in an entry is the model's own config and **state**.

### The three multiplier layers

Core physics params (`el_base`, `u_vol`, `el_k`, `r_for`, `r_back`, `r_k`, …) carry three multiplier layers that combine additively against the base into an `*_eff` value (see `Capacitance.calc_elastances` / `Resistor.calc_resistance`):

| Suffix | Persistence | Written by |
|---|---|---|
| `<p>_factor` | non-persistent — reset to `1.0` every step | transient interventions |
| `<p>_factor_ps` | persistent across steps | user / scenario / event adjustments |
| `<p>_factor_scaling_ps` | persistent | `ModelScaler` (weight/manual scaling); also the Calibrator's PAP lever on `IPSL`/`IPSR` `r_factor_scaling_ps`. 1.0 in every shipped scenario (baked into the base values since v1.0) |

`p_eff = p + (factor-1)*p + (factor_ps-1)*p + (factor_scaling_ps-1)*p`.

### Entries are full state snapshots, not pure config

This is the most important thing to understand about the format. A `models` entry is **not** a clean config block — it is a serialized dump of the live object, including computed outputs: `*_eff` effective values, `vol`, `pres`/`pres_in`, `flow`/`flow_forward`/`flow_backward`, and the full blood composition (`to2`, `tco2`, `ph`, `pco2`, `po2`, `so2`, `hco3`, `be`, `solutes`, `drugs`, `temp`, `viscosity`). `init_model` re-seeds these computed fields straight from the entry, which is why `model_time_total` is non-zero and a loaded scenario **resumes mid-run** at a settled steady state rather than starting from a transient. Authoring a scenario by hand means setting these consistently (or accepting a startup transient); the normal workflow is to let the engine settle, then save the snapshot.

### Example — a `Resistor` entry (verbatim from `term_neonate_72h.json`)

```json
{
  "name": "PA_PAAL",
  "description": "input connector for PAAL",
  "is_enabled": true,
  "model_type": "Resistor",
  "components": {},
  "r_for": 1493.6012345069396,
  "r_back": 1493.6012345069396,
  "r_k": 0,
  "comp_from": "PA",
  "comp_to": "PAAL",
  "no_flow": false,
  "no_back_flow": false,
  "p1_ext": 0,
  "p2_ext": 0,
  "fixed_composition": false,
  "r_factor": 1,
  "r_k_factor": 1,
  "r_factor_ps": 1,
  "r_k_factor_ps": 1,
  "r_factor_scaling_ps": 1,
  "r_k_factor_scaling_ps": 1,
  "flow": 0.007321647238428716,
  "r_for_eff": 1493.6013356657224,
  "r_back_eff": 1493.6013356657224,
  "r_k_eff": 0
}
```

`comp_from` / `comp_to` are the names of the compartments this resistor moves volume between; `flow` and the `*_eff` values are the snapshotted outputs. See [Resistor](./Resistor.md).

### Example — a blood compartment (abbreviated, `Circulation.components.AA`)

In `term_neonate_72h.json` the blood compartments are `BloodVessel` (a `BloodCapacitance` subclass that adds resistance/flow) living inside `Circulation.components`; a standalone `BloodCapacitance` has the same capacitance + composition shape minus the resistor fields. Abbreviated:

```json
{
  "name": "AA",
  "description": "capacitance model of the ascending aorta",
  "is_enabled": true,
  "model_type": "BloodVessel",
  "u_vol": 0.0033,
  "el_base": 21000,
  "el_k": 0,
  "pres_ext": -2.418,
  "fixed_composition": false,

  "u_vol_factor": 1, "el_base_factor": 1, "el_k_factor": 1,
  "u_vol_factor_ps": 1, "el_base_factor_ps": 1, "el_k_factor_ps": 1,
  "u_vol_factor_scaling_ps": 1, "el_base_factor_scaling_ps": 1, "el_k_factor_scaling_ps": 1,

  "vol": 0.006732, "pres": 68.105, "pres_in": 70.524,
  "el_eff": 20547.20, "u_vol_eff": 0.0033, "el_k_eff": 0,

  "temp": 37, "viscosity": 6,
  "solutes": { "na": 138.13, "k": 3.47, "hemoglobin": 10.02, "...": "..." },
  "drugs": { "adrenaline": 0, "noradrenaline": 0 },
  "to2": 8.454, "tco2": 23.593, "ph": 7.361, "pco2": 39.84,
  "po2": 74.88, "so2": 96.92, "hco3": 22.30, "be": -3.07,

  "r_for": 55, "r_back": 55, "no_back_flow": true, "alpha": 0.5,
  "flow": 0, "r_for_eff": 52.654, "r_back_eff": 52.654
}
```

The `vol`/`pres*`/`*_eff` block and the gas/solute/drug block are the persisted computed state. See [BloodCapacitance](./BloodCapacitance.md).

## How the engine consumes it

The load → build path, in brief (full step-by-step in [ARCHITECTURE](./ARCHITECTURE.md)):

1. `Model.load(name)` fetches the JSON, unwraps `model_definition`, back-fills diagram/animation, and posts a `POST build` envelope (payload JSON-stringified) to the worker.
2. `ModelEngine.build()` resets the live `model` object (fresh `models: {}` and the `ncc_*` counters), then copies every `model_definition` key **except `models`** onto it.
3. For each entry in `models`, it looks the class up by `model_type` in `available_model_map` and instantiates `new Class(model, name, model_type)`.
4. It then calls `init_model(args)` on every instance, where `args = [{ key, value }, …]` is each entry's own key/value pairs.
5. It attaches the `DataCollector`, `TaskScheduler`, `ModelScaler` helpers, freezes `model._baseline_weight = model.weight`, and emits `model_ready`.

**Missing `model_type` → ERROR.** If `available_model_map[model_type]` is undefined (usually a class that was never `export`ed from `ModelIndex.js`), `build()` increments the error counter, emits a `status` message `"ERROR: <type> model not found"`, and aborts — no `model_ready`. An exception thrown from a constructor or `init_model` aborts the build the same way.

## `scaler_config`

`scaler_config` is engine-consumed, but only via `ModelScaler` — it is never read by `build()` itself beyond being copied onto the live `model`. Its shape is `group → { param → [componentNames] }` (or, for the container groups, `group → [componentNames]`). The group keys present in `term_neonate_72h.json`:

```
blood, blood_pulmonary, blood_systemic,
heart, heart_left, heart_right,
lung, airway, left_lung, right_lung,
thorax, pericardium
```

Each group lists the component names that a given `scale_*` method touches, and the param sub-keys name which property gets scaled — e.g. `blood.volume`, `blood.el_base`, `blood.resistance`; `heart.el_min` / `heart.el_max`. `ModelScaler`'s factor groups set the `*_factor_scaling_ps` layer (`el_base_factor_scaling_ps`, `r_factor_scaling_ps`, `u_vol_factor_scaling_ps`, `el_min_/el_max_factor_scaling_ps`) **absolutely**; the volume groups scale `vol`/`u_vol` directly, and `incorporate` bakes the layer into the base values. A scenario that stores a calibration in the layer loses it on the first `scale` command, so the shipped scenarios are baked (layer at 1.0). `scaleModel(group, factor)` in the API routes to these methods. See [ModelScaler](./ModelScaler.md).

## `configuration` and events

`configuration` is **UI/store-only state** — the engine never reads it in `build()`. In `term_neonate_72h.json` it holds `diagram_speed`, `diagram_scale`, `chart_hires`, `default_tabs`, `tabs`, `presets`, `monitors`, `controllers`.

It may also carry an optional `configuration.events` array (absent in `term_neonate_72h.json`). Events are named, reusable bundles of timed property changes. They reach the engine **only** indirectly: the events store mirrors `configuration.events` in memory and, when an event fires, pushes each change through `Model.setPropValue` / `callModelFunction`, which the engine's [TaskScheduler](./TaskScheduler.md) applies. The shapes (explain-ui's `src/stores/events.ts`):

```ts
interface ScheduledEvent {
  id: string;
  name: string;
  changes: EventChange[];
  fire_at: number | null;   // absolute model_time_total (s) for auto-fire
  armed: boolean;
}

interface EventChange {
  model: string;            // model instance name, e.g. "Heart"
  target: string;           // raw engine prop, e.g. "heart_rate"
  type: "number" | "boolean" | "list";
  value: number | boolean | string;  // RAW engine value (no display factor)
  it: number;               // ramp duration (s); ignored for boolean/list (applied instantly)
  at: number;               // delay (s) before the change starts
}
```

## `diagram_definition` / `animation_definition`

Both are `{ settings, components }` objects. `settings` holds canvas-level options (background, grid, scaling, `max_to2`, …); `components` maps each diagram element to its picto/sprite layout and the engine model name(s) it binds to. These are consumed worker-side by the `AnimationPacker`, which builds the typed sprite-data contract for the renderers. Full structure is documented in [AnimationPacker](./AnimationPacker.md).

## `index.json`

A flat JSON array of scenario filename stems, e.g.:

```json
["fetus_25wk", "preterm_25wk", "preterm_28wk", "term_neonate_72h", "..."]
```

Each entry `X` maps to `model_definitions/X.json` and is a valid argument to `Model.load("X")`. Add a scenario here to make it selectable in consuming apps. (In explain-ui, `sync-scenarios.mjs` rebuilds its served `index.json` as the union of the canonical set and any local snapshots.)

````

### FILE: explain-engine/docs/MaternalPlacenta.md

````markdown
# MaternalPlacenta

> **Experimental.** Used only by the archived `adult_female_uterus` scenario (the Pregnancy panel is hidden in the app as unfinished). It builds and runs on the current engine, but its physiology isn't calibrated; see [Assumptions and limitations](#assumptions-and-limitations).

`MaternalPlacenta` is the **mother's** side of the placenta in the adult pregnancy model: the intervillous space (`PL_IVS`), a low-resistance blood lake fed by the spiral arteries off the uterine artery and drained by the uterine veins. It owns no blood. It controls `PL_IVS` and its resistors:
- the spiral arteries dilate with gestational age, so placental flow grows;
- the bed is closed when not pregnant;
- it adds a placental oxygen consumption;
- uterine contractions compress the bed.

It is not the fetal [Placenta](./Placenta.md), which has its own fixed maternal pool `PL_MAT`.

## Physiology

In pregnancy the spiral arteries of the uterus are remodelled into wide, low-resistance channels. Uteroplacental blood flow rises from almost nothing to several hundred mL/min at term, most of it to the placenta, which becomes the dominant share of uterine flow. The placenta itself consumes oxygen. During a contraction the rising pressure inside the uterus compresses the intervillous space and throttles placental perfusion, which is why long or frequent contractions stress the fetus.

## Inheritance

```
BaseModelClass
  └── MaternalPlacenta
```

## Properties

### Config: wiring (model names)

| Property | Default | Description |
|---|---|---|
| `pl_ivs_name` | `"PL_IVS"` | Intervillous space (a BloodVessel). |
| `spiral_res_name` | `"UT_ART_PL_IVS"` | Spiral-artery resistor (PL_IVS's inflow connector). |
| `drain_res_name` | `"PL_IVS_UT_VEN"` | Drainage resistor (owned by `UT_VEN`). |
| `ut_art_name` | `"UT_ART"` | Uterine artery (arterial O2 content for the read-outs). |
| `ut_in_res_name` | `"AD_UT_ART"` | Total uterine inflow (for the flow-share read-out). |
| `uterus_name` | `"Uterus"` | Source of `pregnant`, `preg_ga` and `iup`. |

### Config: physiology

| Property | Unit | Default | Description |
|---|---|---|---|
| `mp_running` | boolean | `true` | Master switch (flow also needs a pregnancy). |
| `preg_ga_threshold` | weeks | 4 | Below this gestational age the placenta is absent (no flow). |
| `preg_ga_term` | weeks | 40 | Age at which the term dilation is reached. |
| `spiral_res_term_factor` | – | 0.01 | `PL_IVS` resistance multiplier at term (archived scenario 0.0075). |
| `met_active` | boolean | `true` | Switches the placental O2 consumption. |
| `mp_vo2` | mL O2/kg/min | 0.04 | Placental O2 consumption at full perfusion, per kg maternal weight (archived scenario 0.33, i.e. ~20 mL/min at 60 kg). |
| `vo2_factor`, `vo2_factor_ps` | – | 1.0 | Non-persistent (reset each step) and persistent VO2 multipliers. |
| `resp_q` | – | 0.8 | Respiratory quotient (CO2 added per O2 used). |
| `contraction_pres_gain` | – | 0.6 | Fraction of the uterine pressure applied to `PL_IVS`. |

### Outputs

| Property | Unit | Description |
|---|---|---|
| `mp_active` | boolean | Pregnant, past the threshold and running. |
| `mp_blood_flow` | mL/min | Placental (spiral-artery) flow, smoothed over 5 s. |
| `mp_flow_fraction` | % | Placental share of total uterine inflow (both smoothed). |
| `mp_do2`, `mp_vo2_ml` | mL O2/min | O2 delivery and consumption. |
| `mp_o2er` | % | O2 extraction ratio. |
| `mp_avo2` | mmol/L | Arterio-venous O2 content difference (`UT_ART` − `PL_IVS`). |

## Calculation

Each step (references resolved lazily, so build order doesn't matter):

1. **Progress through pregnancy:** `frac = (preg_ga − threshold) / (term − threshold)`, clamped to 0–1, and 0 when not pregnant. The placenta is active when `mp_running` and `frac > 0`.
2. **Inactive:** `PL_IVS.no_flow` and the drainage's `no_flow_ext` are set, `PL_IVS.r_factor_scaling_ps` is restored to 1, and the outputs are zeroed. `PL_IVS` stays enabled as an inert pool with a defined pressure.
3. **Spiral-artery dilation:** `PL_IVS.r_factor_scaling_ps = 1 + frac·(spiral_res_term_factor − 1)`.
4. **Contraction compression:** `PL_IVS.pres_ext += Uterus.iup · contraction_pres_gain`.
5. **Placental metabolism.**
   - Consumption scales with perfusion: `vo2_eff = mp_vo2 · factors · (term_factor / res_factor)`, so a small early placenta uses little O2 and the extraction stays physiological.
   - `vo2_eff` is removed from `PL_IVS.to2` (STPD conversion, as in Metabolism), and `resp_q` times that amount is added to `tco2`.
6. **Read-outs:** smoothed flows, the flow share, DO2, VO2, O2ER and the AV difference.

## Factor system

It writes the **scaling layer** `PL_IVS.r_factor_scaling_ps`, the layer that belongs to `ModelScaler`. That is safe only while `PL_IVS` isn't in a scaler group (it isn't in the archived scenario). Its own `vo2_factor`/`vo2_factor_ps` are a simple multiplier pair.

## Inputs and outputs

- **Reads:** `Uterus.pregnant`, `preg_ga`, `iup`; `UT_ART.to2`; the flows of the spiral and uterine inflow resistors; `PL_IVS` volume and contents; `model.weight`.
- **Writes:** `PL_IVS.no_flow`, `r_factor_scaling_ps`, `pres_ext`, `to2`, `tco2`; `PL_IVS_UT_VEN.no_flow_ext`.
- **Written by:** the user (pregnancy settings through `Uterus`).

## Assumptions and limitations

- **Not calibrated across gestation.** At 40 weeks placental flow is 525 mL/min, 84 % of uterine flow, close to the term reference (~500–750 mL/min uteroplacental, ~80 % placental). But because resistance falls linearly with gestation, flow (∝ 1/R) stays small until the last weeks: 9 mL/min at 20 weeks, 42 at 36, 77 at 38. Real placental flow rises steadily from the first trimester. See the gestation table in [Uterus](./Uterus.md#assumptions-and-limitations).
- **No fetal coupling.** Gas exchange between `PL_IVS` and a fetal placental capillary needs a combined mother + fetus scenario; the fetal [Placenta](./Placenta.md) uses its own fixed maternal pool.
- **Linear growth** of spiral-artery conductance with gestational age between the threshold and term.
- **Scaling-layer use** (see [Factor system](#factor-system)), as in [Uterus](./Uterus.md).
- **Consumption is silently capped** when it would make `PL_IVS`'s O2 content negative.

## Example definition (JSON)

From `archive/adult_female_uterus.json`, `models.MaternalPlacenta` (trimmed to the physiology props; the wiring props are the defaults):

```json
{
  "name": "MaternalPlacenta",
  "model_type": "MaternalPlacenta",
  "is_enabled": true,
  "mp_running": true,
  "preg_ga_threshold": 4,
  "preg_ga_term": 40,
  "spiral_res_term_factor": 0.0075,
  "met_active": true,
  "mp_vo2": 0.33,
  "resp_q": 0.8,
  "contraction_pres_gain": 0.6
}
```

## Usage in the scenarios

Only `archive/adult_female_uterus` (60 kg adult female), with `PL_IVS` between `UT_ART` and `UT_VEN` in parallel with the uterine tissue bed (`UT_CAP`). The shipped scenario (term_neonate_72h) doesn't include it.

## References

None calibrated yet.

````

### FILE: explain-engine/docs/Metabolism.md

````markdown
# Metabolism

`Metabolism` is the body's oxygen consumption and CO2 production. Each step it removes the whole-body O2 uptake (VO2, scaled to weight) from the blood of the tissue beds, split by a fixed fraction per bed, and adds CO2 at the respiratory quotient. That is what makes venous blood desaturated and CO2-rich, which the lungs then reverse. The myocardium has its own balance in [Mob](./Mob.md).

## Physiology

At rest a newborn consumes about 6–7 mL O2/kg/min, roughly twice an adult's per kg, mostly for the brain, heart, liver, kidneys and gut, and for growth and heat. The tissues extract O2 from the capillary blood and give off CO2. The ratio of CO2 produced to O2 used, the respiratory quotient (RQ), depends on the fuel: about 0.7 for fat, 1.0 for carbohydrate, and above 1 when carbohydrate is turned into fat during growth.

Consumption rises with fever and cold (shivering and non-shivering thermogenesis) and falls with hypothermia (about 7 % per °C, Q10 ≈ 2). When a tissue's O2 supply fails, aerobic metabolism stops: no more O2 uptake or aerobic CO2 production, and the tissue switches to anaerobic glycolysis and lactate (see [Lactate](./Lactate.md)).

## Inheritance

```
BaseModelClass
  └── Metabolism
```

## Properties

### Config (set in the definition JSON)

| Property | Unit | Default | Description |
|---|---|---|---|
| `met_active` | boolean | `true` | Switch. |
| `vo2` | mL O2/kg/min | 8.1 | Whole-body O2 use excluding the myocardium (STPD). term_neonate_72h 7.73 (all four term babies; the 1–24 h babies add brown fat on top). |
| `vo2_factor` | – | 1.0 | Persistent user/scenario multiplier; no model writes it. |
| `vo2_temp_factor` | – | 1.0 | Q10 temperature effect; written by [Thermoregulation](./Thermoregulation.md). |
| `vo2_bat_factor` | – | 1.0 | O2 cost of brown-fat thermogenesis; written by Thermoregulation. |
| `resp_q` | – | 0.8 | Respiratory quotient. term_neonate_72h 0.8. |
| `metabolic_active_models` | {name: fraction} | `{}` | The beds and their share of VO2 (summing to 1). |
| `bat_site` | name | `"RUB"` | The blood compartment that carries the brown-fat O2 cost: brown fat lies in the neck, between the shoulder blades and in the axillae, i.e. the upper body. `""` (or a name the scenario lacks) spreads it over the beds like the rest of the VO2. |

### Outputs

| Property | Unit | Description |
|---|---|---|
| `o2_deficit` | mmol/s | O2 demand that found no O2 in its bed this step (0 at rest; positive in ischaemia). |

## Calculation

Each step (nothing while `met_active` is off):

```
vo2_step = vo2 · vo2_factor · vo2_temp_factor · weight / 60 · dt / 22.414      (mmol)
bat_step = vo2_step · (vo2_bat_factor − 1)                                       brown fat's O2 cost
```

For each bed with fraction f (a missing or empty bed is skipped):
```
demand = vo2_step · f              (+ bat_step · f when there is no usable bat_site)
used   = min(demand, to2 · V)                 never more O2 than the bed holds
to2   −= used / V
tco2  += resp_q · used / V                    CO2 only from O2 actually used
o2_deficit += (demand − used) / dt
```

The brown-fat cost `bat_step` is then taken, the same way, from `bat_site` alone. Spread over the beds it would also lower the brain's and the gut's venous saturation, which non-shivering thermogenesis does not; taken where the brown fat is, it raises the extraction of the upper body, whose blood flow rises with it (2026-10-26).

STPD conversion as in [Units](./Units.md). Example: with the brain's inflow closed in term_neonate_72h, `BR_CAP` empties of O2 within seconds and `o2_deficit` reads 0.005 mmol/s, the brain's 6.8 mL/min share; its tCO2 stays at ~31 mmol/L. Before v1.0 CO2 kept being added from the missing O2 and reached 225 mmol/L in 2 min.

`set_metabolic_active_model(site, fraction)` changes or adds one bed's share.

## Factor system

Its own multipliers on `vo2`: `vo2_factor` (user), `vo2_temp_factor` and `vo2_bat_factor` (Thermoregulation). They multiply; the part `vo2_bat_factor` adds is used at `bat_site`.

## Inputs and outputs

- **Reads:** each bed's `vol`, `to2`, `tco2`; `model.weight`.
- **Writes:** each bed's `to2`, `tco2`.
- **Written by:** Thermoregulation (`vo2_temp_factor`, `vo2_bat_factor`); the user and scenario scripts (`vo2`, `resp_q`, the fractions).
- **Read by:**
  - [Lactate](./Lactate.md) and [Glucose](./Glucose.md), which reuse the bed map (Lactate must follow Metabolism in the `models` map);
  - Thermoregulation (metabolic heat).

## Assumptions and limitations

- **Fixed shares.** A bed's O2 use doesn't depend on its flow or on its own O2 (no supply dependence above the zero floor), and doesn't follow organ activity (seizures, feeding, work of breathing).
- **The myocardium is separate** ([Mob](./Mob.md)), so lung uptake = Metabolism + Mob (term_neonate_72h: 7.73 + ~0.8 = 8.5 mL/kg/min).
- **The beds stand for whole organs and regions:** `RLB`/`RUB` the lumped lower and upper body, `AA`/`AD` the aortic wall.

### term_neonate_72h calibration (2026-10)

- **Venous extraction (2026-10-27).** `vo2` 6.30 → 7.73: lung uptake 7.07 → 8.51 mL/kg/min, mixed venous saturation 82.0 → 78.5 %, systemic extraction 0.155 → 0.19. The direct measurements in stable newborns are a right-atrial ScvO2 of 73.6 ± 5.3 % at an extraction of 0.21 (van der Hoeven 1996) and a peripheral-muscle extraction of 0.22–0.26 (Wolfsberger 2023). The brain and kidney kept their absolute O2 use (the brain's venous saturation already matched, 67 %); the extra went to the upper and lower body (+0.6 each), the gut (+0.15) and the liver (+0.08) mL/kg/min, which raised their shares. Ventilation rose to ~250 mL/kg/min (215 measured in quiet sleep), an accepted deviation. See `scripts/_fix_term_venous_vo2.mjs` and [TermNeonateReference](./TermNeonateReference.md).
- **Whole-body uptake (2026-10-18, superseded).** `vo2` 6.1396 gave a lung uptake of 7.0 mL/kg/min, slightly above quiet rest. First-week references are 6.26 ± 1.51 at thermoneutral rest and 45–50 kcal/kg/d, ~6.5–7.2 mL/kg/min. Knock-on changes:
  - CO2 production fell, so `Breathing.minute_volume_ref` and the chemoreceptor set-points were re-anchored;
  - by Fick, SvO2 is ~81–85 % (scenario 81.5 %);
  - Thermoregulation re-seeds its heat-loss trim at load.

  See `scripts/_fix_term_vo2.mjs`.
- **Brain share 0.313** (was 0.42–0.45, a Holliday-type estimate from adult CMRO2 per gram). Neonatal MRI finds a term CBF of 106 mL/min (Kooi 2019) and CMRO2 well below adult values (Liu 2014). Brain flow and O2 use were brought down together, keeping its extraction at ~35 %: CBF 144 → 106 mL/min, brain VO2 11.0 → 8.1 mL/min. The other beds took over the rest proportionally. See `scripts/_fix_term_brain_mri.mjs` and [TermNeonateReference](./TermNeonateReference.md).
- **The since-removed fetal scenarios** gave the brain 0.65 (see [fetal_circulation](./fetal_circulation.md)).

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Metabolism` (trimmed to the config props):

```json
{
  "name": "Metabolism",
  "model_type": "Metabolism",
  "is_enabled": true,
  "met_active": true,
  "vo2": 7.73061,
  "vo2_factor": 1,
  "resp_q": 0.8,
  "metabolic_active_models": {
    "BR_CAP": 0.25519, "RLB": 0.21416, "RUB": 0.16864,
    "INT_CAP": 0.15595, "LS_CAP": 0.10138, "KID_CAP": 0.09103,
    "AA": 0.00455, "AD": 0.0091
  },
  "bat_site": "RUB"
}
```

## Usage in the scenarios

One instance in every scenario, with the same eight beds.

| Scenario | `vo2` | `resp_q` | Brain share |
|---|---|---|---|
| term_neonate_72h | 7.73 | 0.80 | 0.255 |
| term_neonate_1h / _12h / _24h | 7.73 (+ brown fat 0.45 / 0.3 / 0.3 W/kg at `RUB`) | 0.80 | 0.255 |

## References

Kooi 2019 and Liu 2014 (cerebral flow and CMRO2) and the term VO2 references are cited with details in [TermNeonateReference](./TermNeonateReference.md).

````

### FILE: explain-engine/docs/Mob.md

````markdown
# Mob

`Mob` is the **myocardial oxygen balance**. It computes the heart's own O2 consumption, a basal part plus the cost of its mechanical stroke work, and takes it from the coronary blood pool `COR`. When coronary O2 runs low it depresses heart rate, contractility and the heart's response to sympathetic drive: the ischaemic, failing myocardium. It owns the coronary circulation (`COR` and its connectors) as sub-models.

## Physiology

The heart extracts more of its blood's oxygen than any other organ, about 70 % at rest (coronary sinus saturation ~30 %). It can therefore raise its O2 supply almost only by raising coronary flow. Its O2 use has two parts:
- a **basal** part, for ion pumps and housekeeping;
- a **work** part, proportional to the pressure–volume work of each beat (the P–V loop area) and divided by the contractile efficiency (~35 % of the extra O2 becomes external work).

The left ventricle is perfused mainly in diastole, when the muscle relaxes (see [Heart](./Heart.md) for the systolic compression). Coronary hypoxia makes the myocardium beat slower and weaker. Severe ischaemia ends in bradycardia and failure, a key step in neonatal collapse.

## Inheritance

```
BaseModelClass
  └── Mob
```

## Properties

### Config (set in the definition JSON)

| Property | Unit | Default | Description |
|---|---|---|---|
| `mob_active` | boolean | `true` | Switch. |
| `bm_vo2_per_g` | mmol O2/g/s | 3.7e-5 | Basal O2 use per gram of heart. |
| `hw_intercept`, `hw_slope` | g, g/g | 7.799, 0.004296 | Heart weight = intercept + slope · body weight (g): 23 g at 3.5 kg, 10.8 g at 0.7 kg. |
| `mech_efficiency` | – | 0.35 | Incremental (contractile) efficiency: stroke work / O2 energy. With the basal part included, whole-heart efficiency is the textbook ~15–20 %. |
| `caloric_equiv_o2` | J/mL O2 | 20.1 | Energy per mL O2 (STPD). |
| `resp_q` | – | 0.8 | Myocardial respiratory quotient. |
| `to2_ref`, `to2_min` | mmol/L | 0.2, 0.0002 | Coronary O2 content below which hypoxia effects start, and where they reach their floor. |
| `hr_factor_min`, `hr_factor_max`, `hr_tc` | –, s | 0.01, 1, 5 | Heart-rate channel range and time constant. |
| `cont_factor_min`, `cont_factor_max`, `cont_tc` | –, s | 0.01, 1, 5 | Contractility channel. |
| `ans_factor_min`, `ans_factor_max`, `ans_tc` | –, s | 0.01, 1, 5 | Sympathetic-responsiveness channel. |

### Outputs

| Property | Unit | Description |
|---|---|---|
| `hw` | g | Heart weight. |
| `bm_vo2`, `sw_vo2`, `mob_vo2` | mmol/s | Basal, stroke-work and total myocardial O2 use. |
| `mvo2_step` | mmol | O2 demanded this step. |
| `stroke_work_lv`, `stroke_work_rv`, `stroke_work_total` | mmHg·L | P–V loop areas of the last beat. |
| `beat_interval` | s | Measured time between the last two beats. |
| `mob` | mmol/s | Instantaneous O2 balance: coronary O2 inflow (`AA_COR.flow · AA.to2`) minus use. |
| `o2_deficit` | mmol/s | Demand `COR` could not supply this step (0 at rest). |
| `hr_factor`, `cont_factor`, `ans_activity_factor` | – | Applied hypoxia effects (1 = none). |
| `hr_g`, `cont_g`, `ans_g` | – | Hypoxia gains (rebuilt every step). |

## Calculation

Each step (skipped if `AA`, `AA_COR`, `COR`, `Heart`, `LV` or `RV` is missing):

1. **Basal:** `bm_vo2 = bm_vo2_per_g · hw`.
2. **Stroke work.** Each step adds the trapezoidal P·dV of LV and RV, split into filling and ejection areas. At each new beat (rising edge of `Heart.cardiac_cycle_running`) the loop area of the finished beat is stored and the beat interval measured:
   ```
   O2 per beat = max(SW_lv + SW_rv, 0) · 0.133322 J/(mmHg·L) / (mech_efficiency · 20.1 J/mL) / 22.414
   sw_vo2      = O2 per beat / beat_interval
   ```
   Before the first beat after a build or load, `60 / Heart.heart_rate` stands in for the interval. A pause longer than the last interval stretches it, so an arrested heart stops paying for its last beat.
3. **Coronary pool.** The step's demand `mob_vo2 · dt` is taken from `COR` as far as it holds O2; CO2 is added at `resp_q` for the O2 used; the shortfall is `o2_deficit`.
4. **Hypoxia effects.** The activation is `min(COR.to2, to2_ref) − to2_ref` (≤ 0, floored at `to2_min − to2_ref`). It is smoothed per channel and mapped linearly so the factor is 1 at `to2_ref` and `*_min` at `to2_min`:
   - `Heart.hr_mob_factor` = `hr_factor` (heart-rate sum);
   - each chamber's `el_max_mob_factor` = `cont_factor` (LV, RV, LA and the right-atrial halves);
   - `Heart.ans_activity_factor` = `ans_activity_factor` (scales the sympathetic drive the Heart passes to the chambers).

## Factor system

None of its own; it writes the hypoxia channels above. `el_max_mob_factor` is one of HeartChamber's additive `el_max` layers.

## Inputs and outputs

- **Reads:** `COR` (`to2`, `tco2`, `vol`), `AA.to2`, `AA_COR.flow`, `LV`/`RV` (`vol`, `pres`), Heart (`cardiac_cycle_running`, `heart_rate`); `model.weight`.
- **Writes:** `COR.to2`, `COR.tco2`; `Heart.hr_mob_factor`, `Heart.ans_activity_factor`; the chambers' `el_max_mob_factor`.
- **Read by:** Heart and the chambers (the channels); `DataCollector` watchers and the probes.

## Assumptions and limitations

- **Coronary flow is set by a resting O2 extraction** (re-validation, `scripts/_fix_coronary_extraction.mjs`): `AA_COR`'s resistance gives 55 % extraction in the postnatal scenarios (between newborn lambs, ~50 %, and adults, ~70 %) and 50 % in the fetal ones. Before, every scenario had about the same flow per kg body weight (10.5–11.4 mL/kg/min), so extraction ranged from 30 % (term, ~2× Aburawi's estimate) to 70 % (fetus_term). Values at rest (10 s averages after 2 min; MVO2 in mL O2/min/100 g, flow in mL/min):

  | Scenario | Heart weight | MVO2 | Coronary flow (per 100 g), before → after | Extraction |
  |---|---|---|---|---|
  | term_neonate_72h | 23.0 g | 10.6 | 37.4 (163) → 18.1 (79 per 100 g) | 30 → 55 % |

  The term flow (18 mL/min) is close to the ~20–25 mL/min whole-heart flow that Aburawi's healthy-neonate LAD flow of 8.2 mL/min suggests; the since-removed fetal scenarios got 105–195 per 100 g at 50 %, in the range of fetal-lamb microsphere data (Smolich 1996, Dalshaug 2002), and the preterm ones 59–64 at 55 %. The flow is a fixed resistance (plus the systolic compression): it does not follow MVO2 when demand rises (no metabolic coronary regulation).
- **The hypoxia effects start only at a very low `COR.to2`** (0.2 mmol/L, ~2 % saturation). At rest they are inactive, and they engage only in profound coronary hypoxia.
- **Contractility is depressed twice** under hypoxia: `cont_factor` lowers `el_max`, and `ans_activity_factor` lowers the sympathetic inotropy. Their combined strength is set by `cont_factor_min` and `ans_factor_min`.
- **Heart weight follows body weight only** (no hypertrophy).

### History (v1.0)

- **The stroke-work cost was spread over the contraction** (`Heart.cardiac_cycle_time`) instead of the beat, overstating it by RR / contraction time (×1.41 at term). The O2 the heart no longer uses moved to `Metabolism.vo2` in every scenario, so whole-body VO2 and the gases are unchanged (`scripts/_fix_mob_beat_interval.mjs`).
- **An O2 shortfall used to skip the whole step's uptake**, so the heart consumed nothing in ischaemia.

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Mob` (trimmed to the config props; `components` holds `COR`, `AA_COR`, `COR_RAIVCI`, `COR_RASVC`):

```json
{
  "name": "Mob",
  "model_type": "Mob",
  "is_enabled": true,
  "mob_active": true,
  "bm_vo2_per_g": 3.7e-5,
  "hw_intercept": 7.799,
  "hw_slope": 0.004296,
  "mech_efficiency": 0.35,
  "caloric_equiv_o2": 20.1,
  "resp_q": 0.8,
  "to2_ref": 0.2,
  "to2_min": 0.0002,
  "hr_factor_min": 0.01, "hr_factor_max": 1, "hr_tc": 5,
  "cont_factor_min": 0.01, "cont_factor_max": 1, "cont_tc": 5,
  "ans_factor_min": 0.01, "ans_factor_max": 1, "ans_tc": 5
}
```

## Usage in the scenarios

One instance in every scenario, with the defaults above, owning the coronary bed (`AA` → `AA_COR` → `COR` → right atrium).

## References

- Aburawi EH, Malcus P, Thuring A, Fellman V, Pesonen E. Coronary flow in neonates with impaired intrauterine growth. *J Am Soc Echocardiogr* 2012;25(3):313–8. doi:10.1016/j.echo.2011.11.019 (healthy controls: LAD flow 8.2 ± 3.0 mL/min at 1 week).
- Smolich JJ, Berger PJ, Walker AM. Interrelation between ventricular function, myocardial blood flow, and O2 consumption changes at birth in lambs. *Am J Physiol* 1996;270:H741–9. doi:10.1152/ajpheart.1996.270.2.H741 (LV myocardial flow 234 → 199 mL/min/100 g fetus → 4 h; LV AV O2 difference 3.6 → 7.5 mL/dL).
- Dalshaug GB, Scholz TD, Smith OM, et al. Effects of gestational age on myocardial blood flow and coronary flow reserve in pressure-loaded ovine fetal hearts. *Am J Physiol Heart Circ Physiol* 2002;282:H1359–69. doi:10.1152/ajpheart.00686.2001 (LV 258 vs 172, RV 341 vs 230 mL/min/100 g at 100 vs 128 days).

````

### FILE: explain-engine/docs/ModelRegistry.md

````markdown
# ModelRegistry

`helpers/ModelRegistry.js` is a two-function lookup table from `model_type` to model class. It lets `BaseModelClass` instantiate a sub-model by its `model_type`, built-in or custom, without importing the model barrels. Importing them would create an import cycle.

## API

| Function | Arguments | Returns | Description |
|---|---|---|---|
| `set_model_registry(model_map)` | `{ model_type: class }` | – | Replaces the table. `ModelEngine` calls it once at startup with the merged map: every `ModelIndex.js` export, then every `CustomModelIndex.js` export (a custom class with the same `model_type` replaces the built-in one, with a `console.warn`). |
| `get_model_class(model_type)` | string | class or `undefined` | Looks a class up. |

## Where it is used

`BaseModelClass.init_model` instantiates each entry of `this.components` that doesn't exist yet. It resolves the class as:

```js
get_model_class(model_type) ?? BuiltinModels[model_type]
```

The fallback is the `ModelIndex.js` namespace, keyed by export name. It only matters when the classes are used without `ModelEngine`, which is what fills the registry. Every built-in export name equals its `model_type` (all 46 checked), so the fallback finds the same class, but it doesn't know custom models.

Since `build()` pre-creates every declared sub-model from the same merged map (see [BaseModelClass](./BaseModelClass.md#composite-models-components)), this lookup only runs for models added at runtime (`add_model_to_engine`).

## Why it exists

Every model extends `BaseModelClass`. If `BaseModelClass` imported `CustomModelIndex.js` directly, then `CustomModelIndex → custom model → BaseModelClass` would be evaluated while `BaseModelClass` is still initializing, and the import would fail with "Cannot access 'BaseModelClass' before initialization". The registry breaks the cycle: `BaseModelClass` imports only this tiny module, and `ModelEngine`, which imports everything, fills it once the module graph is complete. The `ModelIndex.js` fallback import in `BaseModelClass` is safe because its bindings are only read lazily, inside `init_model`.

Don't replace it with a top-level import or spread of the barrels: both fail at module-evaluation time, not at build time.

## Notes

- The table is module state, one per worker. A second `set_model_registry` call replaces it entirely.
- Adding a custom model: see [`custom_models/README.md`](../custom_models/README.md) and [ARCHITECTURE §8](./ARCHITECTURE.md#8-how-to-add-a-new-model).

````

### FILE: explain-engine/docs/ModelScaler.md

````markdown
# ModelScaler

`ModelScaler` (`helpers/ModelScaler.js`) is engine infrastructure, not a physiological model. It scales whole groups of components at once: blood volumes, systemic or pulmonary resistances and elastances, heart contractility and stiffness, lungs and airways, the thorax and pericardium, and the patient's weight. A factor of 1.0 means no change. Each group targets an explicit list of components from the scenario's `scaler_config`.

It is created once per build (`model.ModelScaler = new ModelScaler(model, model.scaler_config)`) and driven by `scaleModel(group, factor)` (main thread) → `POST "scale"` → `ModelEngine.scale_model`, which dispatches on the group name.

## Who uses it

- **The app's common tasks:** SVR (`systemic_resistances`), PVR (`pulmonary_resistances`), venous capacity (`systemic_u_vol`), contractility (`heart_el_max`), diastolic stiffness (`heart_el_min`), lung compliance (both lung-elastance groups), lower airway resistance (`airway_lower_resistances`), blood volume (`blood_volume`). They read the current factor from the state and multiply it.
- **The bot** (`op: "scale"`) and **lessons** (`scale` steps), with an absolute factor (1.0 = the scenario as loaded).
- **The scenario generators and the patient builder:** `weight_scale` sizes a patient from its source scenario, and the resistance and heart groups are calibration levers. They end with `incorporate`.
- The **Scaler panel** of the app (hidden as unfinished).

## Two kinds of groups

**Volume groups** change the stored volumes directly, by the ratio to the last factor (`_prev`):

| Group | Method | Components |
|---|---|---|
| `blood_volume`, `heart_volume`, `lung_volume`, `thorax_volume`, `pericardium_volume` | `scale_*_volume` | `vol` and `u_vol` of `config.blood.volume`, `config.heart.volume`, `config.lung.volume`, `config.thorax`, `config.pericardium` |

**Factor groups** set the scaling layer `*_factor_scaling_ps` of their components **absolutely** to the factor:

| Subsystem | Groups | Layer |
|---|---|---|
| Blood (all) | `blood_elastances`, `blood_resistances` | `el_base_…`, `r_…` |
| Systemic | `systemic_elastances`, `systemic_resistances`, `systemic_u_vol` | `el_base_…`, `r_…`, `u_vol_…` |
| Pulmonary | `pulmonary_elastances`, `pulmonary_resistances`, `pulmonary_u_vol` | same |
| Airway | `airway_elastances`, `airway_u_vol`, `airway_upper_resistances`, `airway_lower_resistances` | |
| Lungs | `left_/right_lung_elastances`, `_resistances`, `_u_vol` | |
| Heart | `heart_el_min`, `heart_el_max`, `heart_resistances` (valves); `left_/right_heart_el_min`, `_el_max`, `_u_vol` | `el_min_…`, `el_max_…`, `r_…`, `u_vol_…` |
| Containers | `thorax_elastances`, `pericardium_elastances` | `el_base_…` |

Each method skips a name the scenario lacks or a component without that property.

## Utility groups

| Group | Effect |
|---|---|
| `weight_scale` | `scale_to_weight(kg)`: the five volume groups by `kg / _baseline_weight`, then `model.weight = kg`. Volumes only: elastances, resistances, heart rate and VO2 are not scaled (the inverse-scaling lines are deliberately commented out); the generators calibrate those separately. The placenta is not in any group. |
| `weight` | Sets `model.weight` only. |
| `add_volume` | Adds litres to `IVCI.vol`. |
| `incorporate` | Bakes every scaling layer into the base values (below). |
| `reset` | Every group back to 1.0 and `model.weight = _baseline_weight`. |

## `incorporate()`: baking the layer

For every component named anywhere in `scaler_config`:
- `u_vol`, `el_base`, `el_min`, `el_max` are multiplied by their scaling factor;
- `r_for` and `r_back` by `r_factor_scaling_ps`;
- the layer returns to 1.0, and `_prev` to 1.0.

Three rules keep the baked model exactly as it was:
- **BloodVessel R→E coupling.** A vessel's elastance includes `r_total_factor^alpha`, so a baked resistance factor `f` also multiplies `el_base` by `f^alpha`.
- **HeartChamber `el_k`.** A chamber's diastolic modulation, which contains the `el_min` scaling, also scales its non-linear `el_k`, so `el_k` is multiplied by the `el_min` factor.
- **Additive models** (all but BloodVessel). Their persistent layer acts as a fraction of the base, so `*_factor_ps` becomes `1 + (ps − 1)/f` and keeps its absolute effect.

What the bake cannot preserve exactly is the heart chambers' ANS term, which is additive as a fraction of the base. Once baked it acts on the actual contractility rather than the unscaled base, so after a bake the sympathetic inotropy and lusitropy are proportional.

**Why the shipped scenarios are baked.** The factor groups write the layer absolutely, so a calibration left in it is overwritten by the first `scale` command. Before v1.0 the non-term scenarios carried their size calibration there (preterm_25wk: systemic resistances ×2–3.96, `el_max` ×4.86, lung elastance ×7.1). As a result:
- "scale systemic_resistances 1.2" *lowered* its MAP (36.7 → 31.5 mmHg);
- `reset` dropped it to 30 mmHg.

`scripts/_bake_scaling.py` baked the nine non-term scenarios; the same command now raises MAP (35.6 → 37.5) and `reset` is a no-op. The generators and `build_patient.mjs` end with `incorporate`.

## Methods

Each group `<g>` calls `scale_<g>(factor)`, apart from the utility groups. The methods: `scale_blood_volume`, `scale_heart_volume`, `scale_lung_volume`, `scale_thorax_volume`, `scale_pericardium_volume`, `scale_blood_elastances`, `scale_blood_resistances`, `scale_pulmonary_elastances`, `scale_pulmonary_resistances`, `scale_pulmonary_u_vol`, `scale_systemic_elastances`, `scale_systemic_resistances`, `scale_systemic_u_vol`, `scale_airway_elastances`, `scale_airway_u_vol`, `scale_airway_upper_resistances`, `scale_airway_lower_resistances`, `scale_left_lung_elastances`, `scale_left_lung_resistances`, `scale_left_lung_u_vol`, `scale_right_lung_elastances`, `scale_right_lung_resistances`, `scale_right_lung_u_vol`, `scale_heart_el_min`, `scale_heart_el_max`, `scale_left_heart_el_min`, `scale_left_heart_el_max`, `scale_left_heart_u_vol`, `scale_right_heart_el_min`, `scale_right_heart_el_max`, `scale_right_heart_u_vol`, `scale_heart_resistances`, `scale_thorax_elastances`, `scale_pericardium_elastances`, `scale_to_weight`; `incorporate`, `reset`, `add_volume`.

Private helpers:
- `_apply(names, prop, factor)` sets a layer on a list of components;
- `_scale_vol(names, delta)` multiplies `vol` and `u_vol`;
- `_bake(names, base, layer)` and `_bake_resistance(names)` implement `incorporate`.

## Factor system

ModelScaler owns the `*_factor_scaling_ps` layer of the components in `scaler_config`. Other writers of that layer:
- **the Calibrator:** `IPSL`/`IPSR` `r_factor_scaling_ps`;
- **the archived Uterus and MaternalPlacenta:** pregnancy.

Volume scaling and `add_volume` change the base volumes instead.

## Assumptions and limitations

- **Absolute factor groups, delta-based volume groups.** `_prev` is not saved, so after a reload the volume groups start again from 1.0 (the loaded volumes); the factor groups read their state from the components.
- **Weight scaling is linear and volume-only.**
- **Groups are fixed lists per scenario** (`scaler_config`); components outside them are never scaled.

## Example definition (JSON)

From `term_neonate_72h.json`, `model_definition.scaler_config` (trimmed):

```json
{
  "blood_systemic": {
    "el_base": ["AA", "AAR", "AD", "INT_ART", "KID_ART", "..."],
    "resistance": ["AA", "AAR", "AD", "INT_ART", "KID_ART", "..."]
  },
  "heart": {
    "volume": ["LA", "LV", "RAIVCI", "RASVC", "RV", "COR"],
    "el_min": ["LA", "LV", "RAIVCI", "RASVC", "RV", "COR"],
    "el_max": ["LA", "LV", "RAIVCI", "RASVC", "RV", "COR"],
    "resistance": ["LA_LV", "LV_AA", "RV_PA", "RAIVCI_RV", "RASVC_RV", "LV_PA", "RV_AA", "COR_RAIVCI", "COR_RASVC"]
  },
  "thorax": ["THORAX"],
  "pericardium": ["PERICARDIUM"]
}
```

## References

None; engine infrastructure.

````

### FILE: explain-engine/docs/Monitor.md

````markdown
# Monitor

The `Monitor` device model is a **read-only patient monitor**. It does not change the physiology — it
samples other models each step and publishes bedside read-outs. It is an observer: it never writes to
the models it samples, and no model's physics depends on it, so it can be added or removed without
affecting the simulation. (The [Calibrator](./Calibrator.md) does read its read-outs — `heart_rate`,
`flows.lvo` and the `minmax` pressures — as its calibration targets, so a calibration run needs a
Monitor with the matching targets.) The `DataCollector` relays its read-outs (via the normal watchlist)
to the user.

The model is deliberately minimal. It computes a handful of bedside values itself — **heart rate**,
**respiratory rate**, **end-tidal CO₂**, **temperature** and the **O₂ saturations** (pre-/post-ductal
and venous) — and exposes everything else through three uniform, **JSON-configurable** read-out systems
(`flow_targets`, `minmax_targets`, `signal_targets`) plus a few derived metrics.

> **Arterial blood pressure is not a built-in field.** There is no `abp_syst`/`abp_diast`/`abp_mean`
> property on this model. To monitor a pressure waveform's per-beat extremes and mean, add the
> compartment (e.g. `AD` for post-ductal ABP) to `minmax_targets`; the values then publish as the flat
> keys `Monitor.minmax.<name>_pres_min` / `_pres_max` / `_pres_mean`.

## Physiology

A bedside monitor shows the vital signs a neonatal team watches: heart rate (from the ECG), pre- and post-ductal oxygen saturation (right hand and a foot; a difference signals right-to-left ductal shunting), blood pressures, respiratory rate, end-tidal CO2 and temperature. Its numbers are averaged over beats and breaths, so they lag fast changes by several seconds.

## Built-in read-outs

| Property | How |
|---|---|
| `heart_rate` | rolling average of the beat-to-beat rate over the last **`hr_avg_beats`** beats (bpm) |
| `resp_rate` | rolling average of the breath-to-breath rate over the last **`rr_avg_time`** seconds (breaths/min) |
| `etco2` | end-tidal CO₂; mirrored from `Ventilator.etco2` while the ventilator is enabled, otherwise derived from the spontaneous breath (see below) |
| `temp` | blood temperature (°C), mirrored each step from `AA.temp` (last value kept if AA is absent) |
| `sao2_pre`, `sao2_post` | pre-/post-ductal arterial O₂ saturation, from `AA.so2` / `AD.so2` |
| `svo2` | mixed-venous O₂ saturation, from the pulmonary artery (`PA.so2`). Falls back to `RAIVCI.so2` when there is no PA; `RAIVCI` holds IVC-side blood, which misses the brain's extraction where the right-atrial halves don't mix (the fetal scenarios). In `term_neonate_72h` the two agree (81.9 %). |

**Heart rate** — on each ventricular beat (`Heart.ncc_ventricular === 1`), the beat-to-beat rate is
`60 / interval` (interval = time since the previous beat). A running window of the last `hr_avg_beats`
rates is kept (with a running sum) and averaged into `heart_rate`, so it updates every beat.

**Asystole** — when no beat arrives for `asystole_time` (6 s), `heart_rate` reads 0 and its window is
cleared, the beat-averaged `flows` and the derived `fo_flow`/`do2_br`/`do2_lb` read 0, and the per-beat
`minmax` pressures/volumes are latched from the flat line — repeated every `asystole_time` while it
lasts — instead of holding the last beat. The interval that ends an asystole (longer than
`asystole_time`) is not counted as a beat-to-beat interval.

**Respiratory rate** — `calc_resp_rate()` detects a breath when an **active** breathing source reaches
the start of inspiration (`ncc_insp === 1`): the spontaneous `Breathing` model (when
`breathing_enabled`) or the `Ventilator` (when `is_enabled`). One breath counts once: a ventilator
breath that starts while a spontaneous inspiration is running (`Breathing.insp_running`) is the breath
that effort triggered or landed on, and an effort that starts during a ventilator inspiration
(`Ventilator._inspiration`) is fused into it. So in patient-triggered modes (PTV, PSV, synchronised
SIMV breaths) the rate is the patient's rate, and in unsynchronised CMV it is the set rate plus the
efforts that fall between the ventilator breaths. It keeps a rolling window of breath-to-breath
intervals spanning ~`rr_avg_time` seconds and reports `breaths / window-time × 60`, updated every
breath. When no breath starts for a whole window (apnoea), `resp_rate` follows the open interval
(`60 / time since the last breath`) and the window restarts with the next breaths; the interval that
ends the apnoea is not counted. Both references are optional (`?? null`); a missing source is simply
skipped.

**End-tidal CO₂** — while the `Ventilator` is enabled, `etco2` is mirrored straight from
`Ventilator.etco2`. Otherwise it is derived from the spontaneous breath: `calc_resp_rate` tracks the
running peak airway pCO₂ over each breath on the airway gas compartment named by `etco2_source`
(default `"DS"`, resolved to `_ds`), and latches that end-expiratory peak as `etco2` at the onset of the
next spontaneous breath (resetting the per-breath peak). If neither source is present the last value is
kept. When no breath starts for `rr_avg_time` (apnoea) and the ventilator is off, the spontaneous
`etco2` reads 0 (no expired breath to measure, as on a capnograph). Switching the ventilator on or off
resets the per-breath peak, so the first spontaneous breath after weaning does not report the
maximum over the whole ventilated period.

## Configurable read-outs

All three take a JSON array of `{ name, model }` objects, resolve them in `init_model` (dropping any
whose model does not resolve), and seed their output keys to `0` so the watch paths exist from the
start. This is the intended way to add bedside numbers without touching engine code.

### Flows (`flow_targets` → `Monitor.flows`)

`model` is a `"ModelName.prop"` dot-path (the prop defaults to `flow`):

```json
"flow_targets": [
  { "name": "kidney_flow", "model": "AD_KID_ART.flow" },
  { "name": "brain_flow",  "model": "AA_BR_ART.flow" }
]
```

Each connector's `flow · Δt` is integrated every step (`collect_flows`) and, once every
`flow_avg_beats` beats, converted to a beat-averaged value (`counter / beats_time · 60`) and published
under **`Monitor.flows.<name>`** in **L/min** — e.g. watch `Monitor.flows.kidney_flow`.

### Min/max (`minmax_targets` → `Monitor.minmax`)

`model` is a compartment name; the per-beat min/max of its `pres` and `vol` are tracked
(`collect_pressures`) and latched on each beat:

```json
"minmax_targets": [
  { "name": "left_ventricle", "model": "LV" },
  { "name": "right_atrium",   "model": "RAIVCI" }
]
```

Published as **flat** keys under `Monitor.minmax`, reset every beat:

| Key | Unit | Source |
|---|---|---|
| `<name>_pres_min`, `<name>_pres_max` | mmHg | compartment `pres` (total pressure) |
| `<name>_pres_mean` | mmHg | for the arterial targets in `arterial_mean_targets` (default `abp_pre`, `abp`, `pap`): the **clinical mean** `min + (max − min)/3`, as the reference literature reports MAP and mean PAP; for all other targets the true time-averaged mean. The arterial estimate badly underestimates atrial/venous means (CVP), whose a/c/v waves dip well below diastole |
| `<name>_pres_mean_int` | mmHg | **true time-averaged mean** over the beat (`Σpres / n`), every target. The model's central arterial waveforms have a form factor (mean − min)/(max − min) of about 0.5, so for `abp_pre` this sits ~5–7 mmHg above the clinical mean |
| `<name>_vol_min`, `<name>_vol_max` | mL | compartment `vol` (× 1000) |

Watch e.g. `Monitor.minmax.left_ventricle_pres_max`. The keys are **flat** (not a nested object)
because the `DataCollector` watcher resolves at most two property levels (`model.prop1.prop2`) — i.e.
a watch path of at most three dotted parts; `Monitor.minmax.left_ventricle.pres_max` (four parts)
would not resolve. Targets without a numeric `pres`/`vol` (e.g. a resistor) are not tracked.

### Raw signals (`signal_targets` → `Monitor.signals`)

For waveforms / raw values (no averaging), `model` is a `"ModelName.prop"` dot-path:

```json
"signal_targets": [
  { "name": "ecg",     "model": "Heart.ecg_signal" },
  { "name": "lv_pres", "model": "LV.pres" }
]
```

Each is read **unprocessed every step** (`collect_signals`) and published under
**`Monitor.signals.<name>`** — e.g. watch `Monitor.signals.ecg`. A `prop` is required (entries without
a `"."` are dropped).

## Derived metrics

Computed once every `flow_avg_beats` beats from the `flows` dict, so the scenario must define the
matching `flow_targets`:

| Output | Formula | Requires `flow_targets` |
|---|---|---|
| `fo_flow` | `flows.fo_ivci_flow + flows.fo_svc_flow` | `fo_ivci_flow`, `fo_svc_flow` |
| `do2_br` | `flows.brain_flow · AA.to2 / O2_MMOL_PER_ML` (= × 22.414, mL O₂/min) | `brain_flow` |
| `do2_lb` | `flows.kid_flow · 4 · AD.to2 / O2_MMOL_PER_ML` (mL O₂/min) | `kid_flow` |

`O2_MMOL_PER_ML` is `1/22.414` (STPD) from `helpers/Units.js`. `do2_lb` **assumes** the lower-body
flow is four times the renal flow (`kid_flow × 4`) — a fixed ratio, not a measured lower-body flow;
it does not follow redistribution between the kidneys and the rest of the lower body.

## Configuration

| Property | Unit | Default | Description |
|---|---|---|---|
| `hr_avg_beats` | beats | 12 | Heart-rate averaging window. |
| `flow_avg_beats` | beats | 1 | Flow averaging window. |
| `rr_avg_time` | s | 20 | Respiratory-rate averaging window. |
| `asystole_time` | s | 6 | No beat for this long reads as asystole. |
| `etco2_source` | – | `"DS"` | Airway gas compartment for the spontaneous end-tidal CO2. |
| `flow_targets`, `minmax_targets`, `signal_targets` | lists | `[]` | The configurable read-outs (above). |
| `arterial_mean_targets` | list | `["abp_pre", "abp", "pap"]` | `minmax_targets` names whose `_pres_mean` is the clinical mean, diastolic + pulse pressure / 3. |

| Property | Unit | Description |
|---|---|---|
| `flows`, `minmax`, `signals` | dicts | The configurable read-outs (above). |
| `fo_flow`, `do2_br`, `do2_lb` | L/min, mL O2/min | Derived metrics (above). |

The saturations are mirrored every step without averaging. Model references are resolved by name at build: `Heart` (beats), `Breathing` and `Ventilator` (breaths), `AA`, `AD`, `PA`, `RAIVCI`. The target entries name their own models; one that doesn't resolve is dropped.

**term_neonate_72h** configures `flow_targets` lvo, rvo, cor_flow, svc_flow, ivc_flow, da_flow, brain_flow, kid_flow, ua_flow, uv_flow, fo_ivci_flow and fo_svc_flow; `minmax_targets` lv, rv, abp_pre, abp, pap, cvp and la; `signal_targets` ecg, sat_pre, sat_post, abp, resp and co2.

## Inputs and outputs

- **Reads:** Heart (`ncc_ventricular`), Breathing and Ventilator (breath onsets, `etco2`), `AA`, `AD`, `PA`, `RAIVCI`, `DS`, and every configured target.
- **Writes:** nothing outside itself.
- **Read by:** the app's monitor panel, `DataCollector` watchers, the [Calibrator](./Calibrator.md) (calibration targets).

## Assumptions and limitations

- **Observer.** The Monitor never writes to the models it samples; no model's physics depends on it.
  The `DataCollector` reads its outputs through the watchlist like any other model, and the
  `Calibrator` reads them as calibration targets.
- **Breath sourcing.** `resp_rate` counts breaths from the spontaneous `Breathing` source *and* the
  `Ventilator` (each gated by its enable flag), merging the two onsets of one breath (above). Before
  the merge, every patient-triggered breath was counted twice (effort onset + triggered ventilator
  breath), so PTV/PSV showed about double the real rate. An effort during a ventilator inspiration
  in CMV is not counted (fused breath).
- **Start-up transient.** The first heart-rate and respiratory-rate windows include the time before
  the first beat/breath, so the very first read-out is slightly off; it settles after one window.
- **`do2_br` / `do2_lb` need `AA` / `AD`.** The oxygen-delivery metrics read the aortic O₂ content
  (`AA.to2` / `AD.to2`); both references are resolved with a `?? null` fallback, so they hold their
  last value if those compartments are absent (asystole still zeroes them).

## References

None; standard bedside monitoring definitions.

````

### FILE: explain-engine/docs/Orifice.md

````markdown
# Orifice

`helpers/Orifice.js` computes the Bernoulli (kinetic) pressure loss and the jet velocity of flow through a restrictive opening. [`Pda`](./Pda.md) (the ductus arteriosus) and [`Shunts`](./Shunts.md) (foramen ovale, VSD) share it, so the duct and the septal defects use one formula and one constant.

## Physiology

Blood squeezing through a small hole speeds up into a jet. Accelerating the blood costs pressure, and that loss grows with the **square** of the flow, on top of the ordinary viscous (Poiseuille) loss, which grows linearly. A restrictive duct or defect therefore holds a large pressure difference across it, and the jet is fast. This is what Doppler echocardiography measures: the jet velocity *v*, from which clinicians estimate the gradient with the simplified Bernoulli equation ΔP ≈ 4·v².

The jet is narrower than the anatomical opening (the *vena contracta*). The *discharge coefficient* Cd is the ratio of the jet's area to the hole's: about 0.6–0.65 for a sharp-edged hole, up to about 0.9 for a smooth funnel.

## API

| Name | Arguments | Returns | Description |
|---|---|---|---|
| `K_BERNOULLI` | – | 3.975·10⁻⁶ | `ρ · 3.75·10⁻⁹` with ρ = 1060 kg/m³: converts `Q²/A²` (Q in L/s, A in m²) to mmHg. |
| `orifice_b(diameter_mm, cd)` | anatomic diameter (mm), discharge coefficient | B (mmHg·s²/L²) | `B = K_BERNOULLI / A_eff²` with `A_eff = cd · π·(d/2)²`. Returns 0 for a closed orifice (`A_eff = 0`); the caller decides what closed means. |
| `jet_velocity(b, q)` | B, flow (L/s) | m/s, signed like `q` | `v = sign(q)·√(B·q² / (K_BERNOULLI·10⁶))`, exactly the vena-contracta velocity `Q / A_eff`. |

### Derivation

```
ΔP_kinetic = ½·ρ·v²,      v = Q·10⁻³ / A_eff        (Q in L/s → m³/s)
ΔP [mmHg]  = (½·ρ / 133.322) · (Q·10⁻³ / A_eff)²
           = (ρ · 3.75·10⁻⁹) · Q² / A_eff²  =  B · Q²
```

`½·ρ/133.322` = 3.975 mmHg per (m/s)², the exact form of the clinical "4" in ΔP = 4·v². `jet_velocity` uses the exact 3.975, so the velocity and the pressure loss are consistent. With the clinical 4 the velocity would read 0.3 % low.

## Where it is used

| Caller | Orifice | Cd (default) | How |
|---|---|---|---|
| `Pda` | the narrowest (pulmonary) end of the duct, `diameter_pa` | `discharge_coeff` 0.9 | B is added to the duct resistor `AAR_DA` as a flow-dependent resistance `B·|Q_prev|`, on top of the conical Poiseuille resistance. `velocity_doppler` = `jet_velocity(B, Q)`. |
| `Shunts` | foramen ovale `diameter_fo`, VSD `diameter_vsd` | `discharge_coeff_fo` 0.7, `discharge_coeff_vsd` 0.64 | B is added the same way to the FO and VSD resistors. `velocity_fo_doppler` and `velocity_vsd_doppler` come from `jet_velocity`. |

Shipped settings, for example:
- **term_neonate_72h:** duct closed (diameter 0), FO 1.5 mm, no VSD.

## Notes

- **Only the kinetic term.** `jet_velocity` uses the Bernoulli coefficient and the flow, not the total pressure drop, so the viscous loss along a long duct isn't attributed to the jet. Through an open, non-restrictive duct the jet velocity is low even when the total gradient isn't zero.
- **Semi-implicit use.** Both callers fold B into the linear resistance using last step's flow (`B·|Q_prev|`), because the old turbulent `r_k` term of `Resistor` was unstable. `Resistor` now solves `r_k` exactly each step, so passing B as `r_k` is an option, to be reviewed with Pda and Shunts.
- **Cd is a model constant**, not computed from the orifice geometry. The removed Bischoff scenarios used a low Cd (0.25) as a calibration lever for the ductal flow pattern; every shipped scenario now uses 0.9.

````

### FILE: explain-engine/docs/Pda.md

````markdown
# Pda

`Pda` is the ductus arteriosus: the connection between the aortic arch (`AAR`) and the pulmonary trunk (`PA`). Each step it turns the duct's size into a resistance (viscous loss along the duct plus a Bernoulli loss at its narrowest point), sets it on the duct resistor `AAR_DA`, and reports the shunt flow and the Doppler velocities a clinician would measure.

## Physiology

Before birth the duct carries most of the right ventricle's output past the fluid-filled lungs into the descending aorta. After birth, rising oxygen and falling prostaglandin E2 constrict it, functionally within days, starting at the pulmonary end. In preterm infants it often stays open: blood then runs left-to-right from the aorta into the lungs ("ductal steal"), flooding the lungs and draining the systemic circulation in diastole. When pulmonary pressure is high, flow becomes bidirectional or right-to-left and lowers the post-ductal saturation.

The **size** of the duct sets how much flows, and its **shape** sets the Doppler picture:
- **Large, unrestrictive duct:** low flow velocity, aortic and pulmonary pressures nearly equal, flow following the pressure difference over the cycle.
- **Restrictive duct (narrow, short throat):** a fast continuous jet (2–3 m/s) over a large pressure difference.

Prostaglandin E1 keeps a constricting duct open (duct-dependent heart disease).

## Inheritance

```
BaseModelClass
  └── Pda
```

## Properties

### Config (set in the definition JSON)

| Property | Unit | Default | Description |
|---|---|---|---|
| `diameter_ao_max` | mm | 3.0 | Fully open diameter at the aortic end. |
| `diameter_pa_max` | mm | 2.0 | Fully open diameter at the pulmonary (narrowest) end. **Equal to `diameter_ao_max` in every shipped scenario**, so the duct is a cylinder there. |
| `diameter_relative` | – | 0.0 | Patency fraction 0–1, scaling both ends together; 0 = closed. term 0, preterm 0.27–0.33, fetal 1. |
| `length` | mm | 20 | Length of the duct (the Poiseuille term). A restrictive jet needs a short throat (~1–2 mm). term_neonate_72h 14. |
| `discharge_coeff` | – | 0.9 | Vena-contracta coefficient of the pulmonary-end orifice; lower = tighter jet. 0.9 in every shipped scenario. |

### Set by other models

| Property | Unit | Default | Description |
|---|---|---|---|
| `diameter_drug_factor` | – | 1.0 | Patency multiplier from `Drugs` (PGE1 > 1). Multiplies `diameter_relative`, capped at the anatomic maximum. It cannot reopen a fully closed duct (`diameter_relative` 0). |
| `viscosity` | cP | 6 | Read from `AAR` every step (follows the haematocrit). |

### Outputs

| Property | Unit | Description |
|---|---|---|
| `diameter_relative_eff` | – | `diameter_relative · diameter_drug_factor`. |
| `diameter_ao`, `diameter_pa` | mm | Current diameters at both ends. |
| `res` | mmHg·s/L | Viscous resistance of the duct (conical Poiseuille). |
| `bernoulli_b` | mmHg·s²/L² | Orifice coefficient at the pulmonary end (see [Orifice](./Orifice.md)). |
| `flow` | L/s | Shunt flow; positive = left-to-right (aorta → pulmonary artery). |
| `flow_ao`, `flow_pa` | L/s | Aliases of `flow` (kept for older probes). |
| `velocity_doppler` | m/s | Jet velocity through the vena contracta, `Q / A_eff`: **the Doppler value to watch**. |
| `velocity_ao`, `velocity_pa` | m/s | Mean velocity through the anatomic area at each end (`Q / A`). |
| `velocity_pa_max`, `velocity_pa_min` | m/s | Per-beat extremes of `velocity_pa`, latched at each new ventricular activation. |
| `velocity_doppler_max`, `velocity_doppler_min` | m/s | Per-beat extremes of `velocity_doppler` (min < 0 = right-to-left). |
| `forward_fraction` | – | Fraction of the previous beat with left-to-right flow. |

## Calculation

Each step (skipped if `AAR_DA` is missing):

1. **Closed duct** (`diameter_relative` exactly 0). `AAR_DA` is sealed (`no_flow`, resistance 10⁸) and the outputs are zeroed.
2. **Geometry.**
   ```
   d_ao = min(diameter_relative · drug_factor · diameter_ao_max, diameter_ao_max)
   d_pa = likewise with diameter_pa_max
   ```
3. **Viscous resistance** over a linearly tapered cone (Hagen–Poiseuille integrated along the length):
   ```
   res = 8·η·L / (3π) · (r₁² + r₁·r₂ + r₂²) / (r₁³ · r₂³)        (a cylinder when r₁ = r₂)
   ```
4. **Bernoulli loss** at the pulmonary end: `B = K_BERNOULLI / (Cd · π·r_pa²)²`.
5. **Resistor:** `AAR_DA.r_for = AAR_DA.r_back = res + B·|Q_prev|`, with `r_k = 0`. The quadratic loss is linearised with the previous step's flow (semi-implicit, stable). It differs from the exact `res·Q + B·Q²` by about 1 % of the Bernoulli term per 0.5 ms step (see [Shunts](./Shunts.md#calculation)).
6. **Velocities:**
   - `velocity_doppler = jet_velocity(B, Q) = Q / A_eff`;
   - `velocity_ao` and `velocity_pa` are `Q / A` at the anatomic areas;
   - then the per-beat envelope is updated.

**Doppler velocity.** Because `B·Q²` is the kinetic (Bernoulli) loss, `velocity_doppler` is the velocity through the vena contracta, consistent across the whole closure trajectory. The viscous loss along the duct doesn't accelerate the blood, so it isn't attributed to the jet. Two consequences:
- a **long, narrow duct** is viscous-limited: low flow and low velocity even across a large gradient;
- the jet can't exceed `√(gradient / 3.975)`: a faster jet needs a larger aorta–pulmonary pressure difference, not a different duct geometry.

Earlier versions reported other velocity outputs (from a separate `DA` compartment and the old 4·v² rule); they were replaced by this single orifice velocity, consistent with [Shunts](./Shunts.md) and [Orifice](./Orifice.md).

## Factor system

None of its own. It writes the **base** `r_for`/`r_back`/`r_k`/`no_flow` of `AAR_DA` every step. `AAR_DA` is `implicit` in every scenario.

## Inputs and outputs

- **Reads:** `AAR.viscosity`, `AAR_DA.flow`, `Heart.ncc_ventricular` (beat boundary).
- **Writes:** `AAR_DA.r_for`, `r_back`, `r_k`, `no_flow`.
- **Written by:** `Drugs` (`diameter_drug_factor`); the user and the scenario generators (diameters, length, `discharge_coeff`).
- **Read by:**
  - `probe_vitals` (duct shunt), and `Monitor` through its configurable `flow_targets`;
  - `scripts/probe_pda.mjs`, `probe_term_reference.mjs` and the P1 paper scripts (Doppler envelope);
  - `DataCollector` watchers.

## Assumptions and limitations

- **No closure physiology.** Constriction by oxygen and falling PGE2, closure from the pulmonary end first, and the wall's passive and active elastance aren't computed. The duct's size is a scenario or user setting.
- **Symmetric patency.** `diameter_relative` scales both ends together. The shipped scenarios also set both ends equal, so the duct is a cylinder.
- **Absolute millimetres.** The diameters and `length` aren't scaled with body size; each scenario sets them (the since-removed fetal scenarios used Szpinda's gestational regressions, see [fetal_circulation](./fetal_circulation.md)).
- **PGE1 cannot reopen a closed duct** (`diameter_relative` 0 is a hard stop).
- **Reopening transient.** On the first step after reopening, the Bernoulli term is 0 (no previous flow), so flow briefly overshoots for one step.

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Pda` (trimmed to the config props; `components` holds `AAR_DA`):

```json
{
  "name": "Pda",
  "model_type": "Pda",
  "is_enabled": true,
  "diameter_ao_max": 3,
  "diameter_pa_max": 3,
  "diameter_relative": 0,
  "length": 14,
  "discharge_coeff": 0.9,
  "diameter_drug_factor": 1
}
```

## Usage in the scenarios

One instance in every scenario, owning `AAR_DA` (`AAR` → `PA`, implicit):

| Scenario | `diameter_relative` × max (mm) | `length` (mm) | `discharge_coeff` | Duct |
|---|---|---|---|---|
| term_neonate_72h | 0 | 14 | 0.9 | closed |

The archived `pda_restrictive_ltr` uses a short throat (`length` 1.5 mm, `discharge_coeff` 0.35, `diameter_relative` 0.13) for a restrictive jet.

## References

- Szpinda M. Morphometric study of the ductus arteriosus during human development. 2007 (fetal diameter and length regressions).

The orifice constant is derived in [Orifice](./Orifice.md).

````

### FILE: explain-engine/docs/Placenta.md

````markdown
# Placenta

`Placenta` is the coordinator of the fetal placental circulation:
- **the cord:** umbilical arteries from the descending aorta, umbilical vein back to the IVC;
- **the fetal placenta:** arteries, villous capillaries, veins;
- **the maternal blood pool** the villi exchange gases with.

It switches the unit on (fetal life) and off (after birth), clamps the cord, sets the resistances, the maternal gas content and the exchange constants. The blood and the gas transfer live in its sub-models.

## Physiology

In the fetus the placenta is the lung. About 40 % of the combined ventricular output leaves the descending aorta through the two umbilical arteries. It flows through the villous capillaries, where it takes up oxygen and gives off CO2 by diffusion with the mother's blood in the intervillous space, and returns oxygenated through the umbilical vein. That vein's blood reaches the IVC (in reality largely through the ductus venosus) and, by preferential streaming, crosses the foramen ovale to the left heart and the brain.

At birth the cord is clamped: placental flow stops, the low-resistance placental bed is lost (systemic resistance rises), and gas exchange must move to the lungs.

## Inheritance

```
BaseModelClass
  └── Placenta
```

## Properties

### Config (set in the definition JSON)

| Property | Unit | Default | Description |
|---|---|---|---|
| `placenta_running` | boolean | `false` | Enables the whole unit (flow and gas exchange). `true` in a fetus. |
| `umb_clamped` | boolean | `true` | Stops flow in the cord and placenta (`no_flow`) while the unit stays enabled, e.g. cord occlusion. `false` in a fetus. |
| `umb_art_res`, `umb_art_res_factor` | mmHg·s/L, – | 800, 1.0 | Resistance of the umbilical arteries `PL_UMB_ART`. |
| `umb_ven_res`, `umb_ven_res_factor` | mmHg·s/L, – | 100, 1.0 | Resistance of the umbilical vein `PL_UMB_VEN`. |
| `plf_res`, `plf_res_factor` | mmHg·s/L, – | 2000, 1.0 | Resistance of each fetal-placenta vessel (`PL_FETAL_ART`, `_CAP`, `_VEN`). |
| `mat_to2`, `mat_tco2` | mmol/L | 6.85, 23 | Total O2 and CO2 content of the maternal pool `PL_MAT`. |
| `dif_o2`, `dif_co2` | mmol/(mmHg·s) | 0.0005, 0.001 | Diffusion constants given to the exchanger `PL_GASEX`. |
| `skip_mat_gas_write` | boolean | `false` | Leave `PL_MAT`'s gases alone (when `Uterus` drives the maternal pool, see [Uterus](./Uterus.md)). |

The `*_factor` props are plain persistent multipliers; nothing resets them.

## Calculation

Every 15 ms, if all seven sub-models exist (otherwise skipped):

1. `is_enabled` of all of them, and of the return resistor `PL_UMB_VEN_IVCI`, follows `placenta_running`. Stopping the placenta therefore stops flow *and* exchange.
2. If running:
   - `no_flow` of the cord and placenta vessels and of `PL_UMB_VEN_IVCI` = `umb_clamped`;
   - base resistances: `PL_UMB_ART` = `umb_art_res·factor`, `PL_UMB_VEN` = `umb_ven_res·factor`, the three fetal-placenta vessels = `plf_res·factor` each;
   - `PL_MAT.to2/tco2` = `mat_to2/mat_tco2` (unless `skip_mat_gas_write`);
   - `PL_GASEX.dif_o2/dif_co2` = `dif_o2/dif_co2`.

These are the levers. Writing `PL_GASEX.dif_o2`, `PL_MAT.to2` or the vessels' `r_for` directly is overwritten within 15 ms.

## Factor system

None of its own. It writes the base `r_for`/`r_back` of its vessels; their own factor layers still apply (they compose multiplicatively, see [BloodVessel](./BloodVessel.md#factor-system)).

## Inputs and outputs

- **Writes:** its sub-models (above).
- **Written by:** the user and the fetal scenario generators (`scripts/_make_fetus*.mjs`, from the per-gestation table in `scripts/_ga_tables.mjs`); `Uterus` sets `skip_mat_gas_write` when coupled.
- **Read by:** nothing reads Placenta directly. The fetal oxygenation follows from its sub-models.

## Assumptions and limitations

- **No gestational age inside.** The constants in the code are term values (cord 55 cm, umbilical-artery cross-section 0.147 cm²). Fetal scenarios set the props per gestation (`_ga_tables.mjs`, see [fetal_circulation](./fetal_circulation.md)).
- **Gas exchange runs at full equilibration.** At the shipped settings fetal capillary blood equilibrates completely with the maternal pool: umbilical-vein pCO2 equals `PL_MAT` pCO2. So `mat_to2`/`mat_tco2` are the effective gas setpoints, and `dif_o2`/`dif_co2` have little authority. Calibrate fetal gases through the maternal contents.
- **The maternal pool is an infinite reservoir.** `PL_MAT` is `fixed_composition` with adult blood (`P50_0` 26.7). `mat_to2`/`mat_tco2` are contents (mmol/L), not partial pressures; they must be consistent with the pool's haemoglobin and P50.
  - **term_neonate_72h** ships haemoglobin 7.5 mmol/L with 3.825 / 24.29 mmol/L. The code defaults (6.85 / 23) date from a pool with neonatal blood.
  - **`Blood` writes to `PL_MAT` too** (`set_solute`, `set_P50`). Changing a fetal haemoglobin changes the maternal pool as well; the generators snapshot and restore it.
- **Not in any scaler group.** `ModelScaler.scale_to_weight` doesn't shrink the placenta; each fetal scenario sets its placental volumes explicitly.
- **The return resistor stays a standalone `Resistor`.** `PL_UMB_VEN_IVCI` must **not** be an entry in `IVCI.inputs`. As a vessel-owned connector, `IVCI` would rewrite its `is_enabled`/`no_flow` every step, and stopping or clamping the placenta would leak placental blood into the fetal IVC. Its resistance (49 mmHg·s/L) is a scenario value that Placenta doesn't set, and it is the same in every fetal scenario. The ductus venosus isn't modelled separately.
- **No placental transfusion.** At clamping, the blood in the cord and placenta (~83 mL at term) stays there; delayed cord clamping and cord milking can't be represented.

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Placenta` (trimmed to the config props; `components` holds the sub-models):

```json
{
  "name": "Placenta",
  "model_type": "Placenta",
  "is_enabled": true,
  "placenta_running": false,
  "umb_clamped": true,
  "umb_art_res": 800,
  "umb_ven_res": 100,
  "plf_res": 2000,
  "mat_to2": 3.825,
  "mat_tco2": 24.29,
  "dif_o2": 0.01,
  "dif_co2": 0.01
}
```

## Usage in the scenarios

One instance in every scenario. It owns `PL_UMB_ART`, `PL_FETAL_ART`, `PL_FETAL_CAP`, `PL_FETAL_VEN`, `PL_UMB_VEN` (BloodVessels), `PL_MAT` (BloodCapacitance) and `PL_GASEX` (BloodDiffusor). The return resistor `PL_UMB_VEN_IVCI` is a top-level resistor.

| Scenario | Running | Resistances art / ven / placenta | `mat_to2` / `mat_tco2` | Fetoplacental blood |
|---|---|---|---|---|
| term_neonate_72h | no (clamped) | – | – | – |

## References

- Umbilical artery cross-section at 37–39 weeks: doi:10.18203/2320-1770.ijrcog20183851.
- Spurway J, Logan P, Pak S. The development, structure and blood flow within the umbilical cord with particular reference to the venous system. *Australas J Ultrasound Med* 2012;15(3):97–102. doi:10.1002/j.2205-0140.2012.tb00013.x.
- Fetal placental (tissue) volume at term: doi:10.7863/jum.2008.27.11.1583.

````

### FILE: explain-engine/docs/README.md

```markdown
# Explain Engine — Model Documentation Index

This directory documents the **Explain physiological simulation engine** — the framework-agnostic
ES modules in this repository, not any consuming UI layer. Each model class and engine helper has
its own reference doc; this page is the map.

**New here?** Start with **[ARCHITECTURE](./ARCHITECTURE.md)** — the whole-model developer overview
(two-thread design, message protocol, build/step loop, the cross-cutting patterns every model uses,
and how to add a new model). Then dive into the per-class docs below.

Each per-class doc follows the v1.0 house template (see the template section in
[ARCHITECTURE](./ARCHITECTURE.md)): summary → physiology in plain language → inheritance → property
tables (with defaults) → calculation → factor system → inputs and outputs → assumptions and
limitations → example JSON → usage in the scenarios → references. Helpers and module functions use a
short form. The exemplar is [BloodCapacitance](./BloodCapacitance.md). Pages marked *experimental*
(MaternalPlacenta, Uterus, Resuscitation) describe models whose app panels are hidden as unfinished.

> **Factor layers:** every tunable has `*_factor` (per step), `*_factor_ps` (persistent) and
> `*_factor_scaling_ps` (scaling) layers; the name is the same in every model family. See
> [ARCHITECTURE §7a](./ARCHITECTURE.md#7a-the-factor--effective-value-pattern).

---

## Architecture & contract

| Doc | What it covers |
|---|---|
| [ARCHITECTURE](./ARCHITECTURE.md) | Whole-model overview: threads, wire protocol, build/step loop, cross-cutting patterns, how to add a model, the doc template. |
| [BaseModelClass](./BaseModelClass.md) | Abstract root of every model: lifecycle contract (construct → init_model → step_model → calc_model), shared fields. |

## Formats & developer workflow

| Doc | What it covers |
|---|---|
| [MODEL_DEFINITIONS](./MODEL_DEFINITIONS.md) | The scenario / model-definition JSON format a developer authors — top-level keys, the `model_definition.models` map, `scaler_config`, `configuration.events`, and how `build()` consumes it. |
| [TESTING](./TESTING.md) | Running the engine headlessly in Node — the zero-edit shim harness, the `probe_*.mjs` verification pattern, and the reseed/scenario-generation tooling in `scripts/`. |

## Base elements (`base_models/`)

The reusable physical primitives every component model is built from.

| Doc | Models |
|---|---|
| [Capacitance](./Capacitance.md) | Elastic volume compartment; pressure from volume above unstressed volume (linear + non-linear). Canonical factor/`_eff` implementation. |
| [Resistor](./Resistor.md) | Flow element between two compartments; pressure-driven flow (forward/back/non-linear R), moves volume. |
| [TimeVaryingElastance](./TimeVaryingElastance.md) | Compartment whose elastance varies over the cardiac cycle; basis for heart chambers. |
| [Container](./Container.md) | Enclosing pressure container (thorax/pericardium); applies external pressure to members. |
| [BloodDiffusor](./BloodDiffusor.md) | Diffusion of O₂/CO₂/solutes between two blood compartments. |
| [GasExchanger](./GasExchanger.md) | O₂/CO₂ transfer across the blood–gas (alveolar–capillary) barrier. |

## Blood side

| Doc | Models |
|---|---|
| [Blood](./Blood.md) | Whole-blood manager: Hb, blood volume, P50, composition init/propagation across compartments. |
| [BloodCapacitance](./BloodCapacitance.md) | Blood-filled compartment; `volume_in` mixes gases/solutes/drugs/temp/viscosity by volume fraction. **(template exemplar)** |
| [BloodTimeVaryingElastance](./BloodTimeVaryingElastance.md) | Time-varying-elastance compartment carrying blood composition (pumping chamber). |
| [BloodVessel](./BloodVessel.md) | Vessel segment with embedded resistor + ANS tone; **multiplicative** factor composition + α-coupling. |
| [BloodMixing](./BloodMixing.md) | Blood composition mixing on inflow and exchange without net flow (`mix_blood_in`, `exchange_blood`). *(helper)* |
| [Orifice](./Orifice.md) | Bernoulli orifice term and jet velocity shared by Shunts and Pda (`orifice_b`, `jet_velocity`). *(helper)* |
| [BloodComposition](./BloodComposition.md) | Acid–base / oxygenation solver (`calc_blood_composition`): Stewart SID + O₂/CO₂ dissociation, Haldane/Bohr coupling. *(module function, not a model_type)* |

## Gas side

| Doc | Models |
|---|---|
| [Gas](./Gas.md) | Gas-phase manager: atmospheric pressure, humidity, gas composition init. |
| [GasCapacitance](./GasCapacitance.md) | Gas-filled elastic compartment (lung/airway); tracks partial pressures/fractions. |
| [GasComposition](./GasComposition.md) | Builds a gas compartment's composition from a dry FiO2, temperature and humidity. *(module function)* |
| [GasMixing](./GasMixing.md) | Gas exchange between two gas compartments without net flow (`exchange_gas`, used by `Resistor.mix_flow`). *(helper)* |

## Cardiac

| Doc | Models |
|---|---|
| [Heart](./Heart.md) | Master cardiac driver: HR, conduction/cycle counters, activation, ECG, arrhythmias (AV block / escape / VT / PVC). |
| [HeartChamber](./HeartChamber.md) | A single chamber (LA/LV/RA/RV); time-varying elastance with ANS, mob, drug, load & remodel factors. |
| [HeartFunction](./HeartFunction.md) | Load-induced contractility compromise (afterload mismatch, wall-stress dilation, remodeling). |
| [HeartValve](./HeartValve.md) | Cardiac valve: a one-way [Resistor](./Resistor.md) under its own type. |
| [Mob](./Mob.md) | Myocardial oxygen balance / heart-muscle metabolism. |

## Vascular & circulatory

| Doc | Models |
|---|---|
| [Circulation](./Circulation.md) | High-level circulation orchestrator; wires/scales the systemic & pulmonary network. |
| [Shunts](./Shunts.md) | Intracardiac/extracardiac shunts (foramen ovale, VSD, intrapulmonary). |
| [Pda](./Pda.md) | Ductus arteriosus: viscous (cone) + Bernoulli resistance on `AAR_DA`, drug-modulated diameter, Doppler velocity envelope. |
| [Placenta](./Placenta.md) | **Fetal** placenta: cord, villous circulation and exchange with a fixed maternal pool. |
| [MaternalPlacenta](./MaternalPlacenta.md) | **Maternal** intervillous-space bed / spiral-artery perfusion. *(experimental)* |
| [Uterus](./Uterus.md) | Uterine circulation + pregnancy adaptation + contractions/labor (IUP waveform, MVU). *(experimental)* |

## Control & regulatory

| Doc | Models |
|---|---|
| [Ans](./Ans.md) | Autonomic nervous system controller; hub doc for the afferent→efferent baro/chemoreflex loop. |
| [AnsAfferent](./AnsAfferent.md) | Afferent receptor (input → firing rate, piecewise linear with a time constant). |
| [AnsEfferent](./AnsEfferent.md) | Efferent pathway (summed, clamped firing rate → effect factor on a target). |
| [Hormones](./Hormones.md) | RAAS/ADH controllers acting on vascular tone & fluid balance. |
| [Kidneys](./Kidneys.md) | Renal filtration (NFP/GFR autoregulation, reabsorption, urine, per-solute mass balance). |
| [Brain](./Brain.md) | Cerebral autoregulation (CBF control) + ICP / Monro-Kellie. |

## Metabolic, thermal & pharmacology

| Doc | Models |
|---|---|
| [Metabolism](./Metabolism.md) | Whole-body O₂ consumption / CO₂ production; Q10 temperature dependence. |
| [Thermoregulation](./Thermoregulation.md) | Body-temperature control; drives HR temp factor, metabolic Q10, blood temperature. |
| [Glucose](./Glucose.md) | Glucose/insulin homeostasis; IV dextrose. |
| [Lactate](./Lactate.md) | Hypoxia-driven lactate production → Stewart SID → metabolic acidosis. |
| [Drugs](./Drugs.md) | Pharmacology PK/PD (adrenaline, noradrenaline, PGE1): circuit transport, clearance, ke0, effect sites. |
| [Fluids](./Fluids.md) | IV fluid/infusion administration into blood compartments. |

## Respiratory

| Doc | Models |
|---|---|
| [Breathing](./Breathing.md) | Spontaneous breathing drive: chemoreflex minute volume split into rate and tidal volume, muscle pressure on the thorax. |
| [Apnea](./Apnea.md) | Apnea of prematurity: episodic ventilation suppression (central/obstructive/mixed) → emergent desaturation + hypoxic bradycardia. |
| [Respiration](./Respiration.md) | Respiratory coordinator: lung, chest-wall, airway and exchange levers, series dead space, atelectasis (recruitment, resorption). |
| [Surfactant](./Surfactant.md) | Dynamic RDS alveolar recruitment/derecruitment with hysteresis + surfactant therapy. |

## Devices (`device_models/`)

| Doc | Models |
|---|---|
| [Ventilator](./Ventilator.md) | Mechanical ventilator physics (modes incl. CPAP/PS/HFOV via ET tube); the base of Sle6000, and the adults' ventilator. |
| [Sle6000](./Sle6000.md) | SLE6000 neonatal ventilator, the ventilator of every scenario up to 30 kg: the Ventilator driven through the device's modes, settings, circuits and monitored values, with the OxyGenie closed-loop O2 controller. |
| [Ecls](./Ecls.md) | Extracorporeal life support (ECMO): pump, oxygenator, cannulae. |
| [Monitor](./Monitor.md) | Patient monitor; derives displayed vitals from model state. |
| [Resuscitation](./Resuscitation.md) | CPR: chest compressions and ventilation cycles. *(experimental)* |

## Engine helpers (`helpers/`)

Infrastructure that the worker attaches to the live `model` object — not physiological models.

| Doc | Helper |
|---|---|
| [DataCollector](./DataCollector.md) | Dual-rate (fast 0.005 s / slow 1.0 s) property watchlists + sample buffers. |
| [TaskScheduler](./TaskScheduler.md) | Deferred/tweened prop mutations and scheduled model-function calls. |
| [ModelScaler](./ModelScaler.md) | Group scaling (absolute factor on the `*_factor_scaling_ps` layer), volume-only weight scaling and `incorporate` (bake). The shipped scenarios are baked, so 1.0 = the scenario as loaded. |
| [ModelRegistry](./ModelRegistry.md) | Name → class registry that lets `BaseModelClass` build built-in and custom models as sub-components. |
| [Units](./Units.md) | Shared constants: STPD O2 conversion, gas constant, water vapour pressure. |
| [Calibrator](./Calibrator.md) | Closed-loop calibration controllers (shared by patient-build and live `tune_model`). |
| [ChannelWriter](./ChannelWriter.md) | Worker→main realtime producer; writes samples into shared-memory ring buffers. |
| [RealtimeChannels](./RealtimeChannels.md) | Shared constants/layout for the realtime channel protocol. |
| [ScenarioAliases](./ScenarioAliases.md) | Old names of renamed scenarios → current names (`Model.load`, `build_patient.mjs`). |
| [AnimationPacker](./AnimationPacker.md) | Packs per-component animation values (magnitude/tint) into the animation channel. |
| [RealTimeMovingAverage](./RealTimeMovingAverage.md) | O(1) rolling-average smoother for realtime signals. |

## Realtime read side (`realtime/`, main thread)

The main-thread mirror of the `ChannelWriter`/`RealtimeChannels`/`AnimationPacker` write side.

| Doc | Component |
|---|---|
| [RealtimeBus](./RealtimeBus.md) | `requestAnimationFrame` loop that drains a `ChannelReader` and pushes frames to renderer adapters (`onRegistry`/`onFrame`). |
| [ChannelReader](./ChannelReader.md) | Read side of the data plane; decodes the shared-memory (`Atomics`/seqlock) or transferable transport. |

## Clinical references

Not tied to a single class — physiology/clinical background and scenario-build roadmaps.

| Doc | What it covers |
|---|---|
| [fetal_circulation](./fetal_circulation.md) | (The fetal scenarios were removed on 2026-10-25 to be rebuilt; kept as the design record.) Fetal scenarios (`fetus_term`, `fetus_30wk`): the fetal invariants, why a gestational age costs a calibration pass, measured operating points, known limitations. |
| [TermNeonateReference](./TermNeonateReference.md) | Literature reference values for a healthy term neonate at ~72 h (hemodynamics, heart, flows, breathing, gases, metabolism, shunts), graded by evidence, with the matching JSON for validating `term_neonate_72h`. |
| [TermTransitionReference](./TermTransitionReference.md) | Reference values for the healthy term neonate in transition at 1, 12, 24 and 72 h (vaginal birth, delayed cord clamping, skin-to-skin): duct, PAP, LV output, lungs, gases, glucose, haematocrit, graded, with a JSON set per age. |
| [chd_duct_fo_dependent](./chd_duct_fo_dependent.md) | Duct- & foramen-ovale-dependent CHD taxonomy, lesion catalog, engine-lever mapping, build roadmap, bibliography. |

```

### FILE: explain-engine/docs/RealTimeMovingAverage.md

```markdown
# RealTimeMovingAverage

`RealTimeMovingAverage.js` is a small (~54-line) utility that computes a **rolling fixed-window average** over a stream of scalar samples in O(1) per update. It is generic engine infrastructure, not a physiological model. It is used by `device_models/Ecls.js` to smooth noisy realtime ECLS signals (one instance each for flow, venous pressure, internal pressure, and arterial pressure) before they are exposed as `flow_avg` / `p_ven` / `p_int` / `p_art`. Unlike the chart/anim data plane ([ChannelWriter](./ChannelWriter.md), [RealtimeChannels](./RealtimeChannels.md), [AnimationPacker](./AnimationPacker.md)), it crosses no thread boundary — it is just a numeric helper. See [ARCHITECTURE](./ARCHITECTURE.md) for the broader engine layout.

## Role in the engine

A model that produces a noisy per-step signal (e.g. ECLS pump flow) creates one `RealTimeMovingAverage` per signal in `init_model`, calls `addValue(raw)` each step, and assigns the returned smoothed value to the displayed property. When a configurable window changes at runtime, the model replaces the instance with a new one sized to the new window; on disable/reset it calls `reset()`.

## Key state

Constructor: `new RealTimeMovingAverage(windowSize)`

- `windowSize` — clamped to `Math.max(1, Math.trunc(windowSize))` (always a positive integer).

| Field | Description |
|---|---|
| `windowSize` | Number of samples retained in the window |
| `values` | Backing ring array of length `windowSize` |
| `count` | Samples seen so far, capped at `windowSize` |
| `writeIndex` | Next slot to overwrite (wraps modulo `windowSize`) |
| `sum` | Running sum of the windowed values |
| `currentAverage` | Most recently computed average |

## Key methods

### `addValue(newValue) → number`

Adds a sample and returns the updated average.

- **Warm-up** (`count < windowSize`): stores the value, adds it to `sum`, increments `count`.
- **Steady state**: subtracts the value being evicted at `writeIndex`, stores the new value there, and adjusts `sum` by `newValue - oldestValue`.
- Advances `writeIndex = (writeIndex + 1) % windowSize`, recomputes `currentAverage = sum / count`, and returns it.

The average divides by `count` (not `windowSize`), so during warm-up it is the true mean of the samples seen so far rather than being diluted by empty slots.

### `getCurrentAverage() → number`

Returns `currentAverage` without adding a sample.

### `reset()`

Re-initializes the buffer (`values`, `count`, `writeIndex`, `sum`, `currentAverage` all cleared) while keeping `windowSize`.

## Notes / caveats

- **Changing the window means a new instance.** There is no resize method; callers compare `windowSize` and construct a fresh `RealTimeMovingAverage` when it changes (as `Ecls` does).
- **O(1) update via incremental sum.** Float rounding can accumulate over very long runs since `sum` is maintained additively rather than recomputed; for the signal magnitudes and window sizes used here this is negligible.
- **A NaN never leaves.** One non-finite sample makes `sum` NaN, and subtracting it again when it leaves the window keeps it NaN; only `reset()` (or a new instance) recovers. Callers feed it finite values.
- **Self-contained.** No imports, no SharedArrayBuffer, no worker messaging — purely a numeric helper that can be used anywhere in the engine.

```

### FILE: explain-engine/docs/RealtimeBus.md

````markdown
# RealtimeBus

`RealtimeBus.js` is the **main-thread consumer** of the realtime data plane. It runs a single `requestAnimationFrame` loop that drains a [ChannelReader](./ChannelReader.md) — every new chart row plus the newest anim frame — and pushes them to registered renderer adapters (uPlot charts, the PixiJS diagram). It is deliberately framework-agnostic: it holds all state in ordinary fields and is **never placed inside Vue reactivity**, so 60 Hz telemetry can never trigger a re-render. It is the mirror of the worker-side [ChannelWriter](./ChannelWriter.md), and is separate from the control plane (status/state/`model_ready`/errors) that lives on `Model.js` + `ModelEmitter`. See [RealtimeChannels](./RealtimeChannels.md) for the buffer contract and [ARCHITECTURE](./ARCHITECTURE.md) for the full pipeline.

## Role in the engine

The worker emits two kinds of traffic on its single `postMessage` channel: the **control plane** (`state`, `data`, `model_ready`, `status`, `error`, …) and the **realtime data plane** (`RT_MSG.*`). Two listeners are attached to the same worker, and each ignores what it does not own:

- **`Model.onmessage` / `Model.receive()`** handles the control plane and ignores `RT_MSG.*`.
- **`RealtimeBus`** attaches its own `worker.addEventListener("message", …)` and handles **only** `RT_MSG.*` (see `_handleMessage`); it does not touch `Model.receive()`.

This keeps the data plane self-contained — per-frame telemetry flows worker → bus → adapter without passing through `Model`/`ModelEmitter` or any reactive store. The framework owns the *shell* (which signals to watch, layout, start/stop) and talks to the bus through its imperative API.

## Construction

```js
new RealtimeBus(workerOrModel)
```

`workerOrModel` may be either a `Model` instance (the bus reads `workerOrModel.modelEngine`) or a raw `Worker`. The constructor:

- resolves `this.worker = workerOrModel?.modelEngine || workerOrModel`,
- creates its own `this.reader = new ChannelReader()`,
- attaches `_onMessage` (a bound `_handleMessage`) as a `"message"` listener on the worker.

| Field | Description |
|---|---|
| `worker` | The resolved `Worker` the bus listens to |
| `reader` | The owned `ChannelReader` instance |
| `renderers` | Array of registered renderer adapters |
| `_running` | Whether the rAF loop is active |
| `_rafId` | Handle from `requestAnimationFrame`, or `null` |
| `_lastRegistry` | The most recent `RT_MSG.CHANNELS` payload, replayed to late-added renderers |
| `_onMessage` | The bound message listener (kept so `dispose()` can detach it) |

## Renderer-adapter contract

A renderer adapter is any object with these two callbacks (both optional in the sense that the bus null-checks each before calling):

```js
onRegistry(payload)        // optional: called when channels (re)configure
onFrame(chart, anim)       // called each rAF tick with the latest data
```

- **`onRegistry(payload)`** — receives the raw `RT_MSG.CHANNELS` payload (the same object passed to `reader.configure`). Called once when the registry arrives, and **replayed** to any renderer added afterward (`addRenderer` invokes it immediately if `_lastRegistry` is set), so adapters that register late still see the layout.
- **`onFrame(chart, anim)`** — called once per tick that produced new data. Either argument may be `null`.

`chart` is `null` or:

```js
{ version, stride, slots, count, rows /* Float64Array, count*stride values */ }
```

`anim` is `null` or:

```js
{ version, stride, components, layout, frame /* Float32Array, one frame */ }
```

These are exactly the return shapes of `ChannelReader.drainChart()` and `ChannelReader.readAnim()`.

## API

| Method | Behavior |
|---|---|
| `addRenderer(renderer)` | Pushes the adapter onto `renderers`; if `_lastRegistry` is set and the adapter has `onRegistry`, replays it immediately. Returns the renderer. |
| `removeRenderer(renderer)` | Removes the adapter from `renderers` (no-op if not present). |
| `start()` | Starts the rAF loop. Idempotent — returns immediately if already running. |
| `stop()` | Stops the loop and cancels the pending frame. Safe to call when not running. |
| `dispose()` | Calls `stop()`, detaches the worker message listener, and clears `renderers`. |

## Message handling

`_handleMessage(e)` reads `e.data`, ignores anything without a `type`, then switches:

- **`RT_MSG.CHANNELS`** (`"rt_channels"`) — the one-time registry handshake. Calls `reader.configure(payload)`, stores `_lastRegistry = payload`, then calls `onRegistry(payload)` on every renderer that has one. **Each `onRegistry` call is wrapped in `try/catch`** so one bad adapter cannot block the others (errors are logged via `console.error`).
- **`RT_MSG.CHART`** (`"rt_chart"`) or **`RT_MSG.ANIM`** (`"rt_anim"`) — transferable-transport data messages. Forwarded verbatim to `reader.onMessage(d)`. (In shared-memory mode these messages are never sent; the reader pulls directly from the SABs.)

All other message types are ignored — they belong to the control plane.

## The rAF drain loop

`start()` schedules a `loop` closure on `requestAnimationFrame`. Each iteration:

1. bails if `_running` went false,
2. calls `_tick()` inside `try/catch` — **a tick error is logged but never kills the loop**,
3. always reschedules itself via `requestAnimationFrame(loop)` and stores the handle in `_rafId`.

`_tick()` does the actual draining:

```js
const chart = this.reader.drainChart(); // every new row, in order, or null
const anim  = this.reader.readAnim();   // newest frame only, or null
if (chart == null && anim == null) return;   // nothing this frame
for (const r of this.renderers) {
  if (!r.onFrame) continue;
  try { r.onFrame(chart, anim); }
  catch (err) { console.error("RealtimeBus: renderer onFrame failed", err); }
}
```

So **chart never drops samples** (drained in order with ring-wrap handling) while **anim is latest-frame-wins**. Each renderer's `onFrame` is guarded individually so one throwing adapter cannot starve the rest. `stop()` flips `_running` and calls `cancelAnimationFrame(_rafId)`.

## Notes / caveats

- **Who instantiates it.** `src/composables/useRealtimeBus.ts` constructs a **singleton** `RealtimeBus(model)` and gates the loop on engine streaming: `model.on("rt_start", () => bus.start())` and `model.on("rt_stop", () => bus.stop())`. The loop therefore runs only while the engine is actively streaming. `disposeRealtimeBus()` calls `bus.dispose()` and clears the singleton.
- **Not reactive by design.** Adapters receive typed arrays directly. Do not stash `chart.rows` / `anim.frame` into Vue refs or React state — that defeats the entire reason this bus exists outside the reactive system.
- **Two listeners, one worker.** Both `Model` and the bus receive every worker message. The split is purely by `type`; do not route `RT_MSG.*` through `Model.receive()` or control-plane events through the bus.
- **Late-registered renderers are safe.** Because `_lastRegistry` is replayed on `addRenderer`, an adapter mounted after the handshake still gets its `onRegistry` before any `onFrame`.
- **`frame` is reused in shared mode.** The `anim.frame` typed array handed to `onFrame` may be the reader's reusable scratch buffer (see [ChannelReader](./ChannelReader.md)); adapters that need to retain values across frames must copy them.

````

### FILE: explain-engine/docs/RealtimeChannels.md

```markdown
# RealtimeChannels

`RealtimeChannels.js` is the **shared layout/contract** for the realtime data plane that carries per-frame floats from the `ModelEngine` worker to the main-thread render layer (uPlot charts + the PixiJS sprite diagram). It is pure infrastructure: the module exports **only constants and tiny pure helpers**, no worker- or DOM-specific code, so it can be imported by both the writer side ([ChannelWriter](./ChannelWriter.md)) and the reader side (`ChannelReader`, main thread) without dragging either environment's dependencies across. Think of it as the single source of truth both ends agree on for buffer offsets, control-header indices, message names, and transport selection.

## Role in the engine

This module defines the wire format; it does not move any data itself. It sits underneath the realtime fast path:

- [ChannelWriter](./ChannelWriter.md) (worker) allocates buffers laid out per these constants and writes samples.
- [AnimationPacker](./AnimationPacker.md) (worker) uses the `anim*` helpers to compute its frame stride and slot offsets.
- The main-thread `ChannelReader` attaches to the same buffers using the same constants to drain them in its `requestAnimationFrame` loop.

See [ARCHITECTURE](./ARCHITECTURE.md) for the full worker → main realtime pipeline.

It models **two independent channels with different drop semantics**:

- **CHART** — a ring of fixed-stride rows. The consumer must read **every** row in order (no dropped samples); it drains the span `[lastRead, writeIdx)`.
- **ANIM** — a single "latest frame wins" snapshot. The consumer only ever wants the newest frame; older frames are discarded.

And **two transports** that implement those channels:

- `"transferable"` — one `ArrayBuffer` posted per flush with an ownership transfer (zero-copy). No special hosting headers required.
- `"shared"` — a `SharedArrayBuffer` written by the worker and read by the main thread in its rAF loop, synchronized with `Atomics`. Requires COOP/COEP cross-origin isolation (`self.crossOriginIsolated === true`).

## Key state

This module is constants-only. Each export:

### Message types — `RT_MSG`

Used as the `type` field of worker → main messages (transferable transport + the one-time registry handshake).

| Constant | Value | Meaning |
|---|---|---|
| `RT_MSG.CHANNELS` | `"rt_channels"` | One-time handshake: registries (+ SAB handles in shared mode) |
| `RT_MSG.CHART` | `"rt_chart"` | Transferable: a batch of chart rows |
| `RT_MSG.ANIM` | `"rt_anim"` | Transferable: a single latest anim frame |

### Transport — `RT_TRANSPORT`

| Constant | Value |
|---|---|
| `RT_TRANSPORT.SHARED` | `"shared"` |
| `RT_TRANSPORT.TRANSFERABLE` | `"transferable"` |

### Chart control header — `CHART_CTRL`

Indices into the small `Int32Array` control array that sits alongside the chart data ring in shared mode. The chart ring is a **single-producer / single-consumer** ring cursor.

| Index | Value | Meaning |
|---|---|---|
| `CHART_CTRL.WRITE_IDX` | `0` | Total rows ever written (monotonic). Physical slot = `WRITE_IDX % capacity` |
| `CHART_CTRL.READ_HINT` | `1` | The last `WRITE_IDX` the reader drained (written by the reader). Nothing reads it back: the writer never waits for the reader, and a reader that was lapped keeps the freshest `capacity` rows and flags a gap (see [ChannelReader](./ChannelReader.md)) |
| `CHART_CTRL.VERSION` | `2` | Must match the registry the rows were written under |
| `CHART_CTRL.CAPACITY` | `3` | Number of rows the data ring holds |
| `CHART_CTRL.STRIDE` | `4` | Floats per row (col 0 = time, then signals) |
| `CHART_CTRL.LEN` | `5` | Length of the control `Int32Array` |

### Anim control header — `ANIM_CTRL`

Indices into the anim control array. The anim channel is a **seqlock over two physical frames** (a flip buffer): the writer fills the inactive frame, flips `ACTIVE`, then bumps `SEQ`; the reader copies the `ACTIVE` frame and retries if `SEQ` changed mid-copy (torn-read protection).

| Index | Value | Meaning |
|---|---|---|
| `ANIM_CTRL.ACTIVE` | `0` | `0` or `1` — which frame slot holds the newest data |
| `ANIM_CTRL.SEQ` | `1` | Bumped by 1 after every publish (after the flip). Its parity means nothing — the reader only checks whether it changed during its copy |
| `ANIM_CTRL.VERSION` | `2` | Registry version |
| `ANIM_CTRL.STRIDE` | `3` | Floats per frame (slot 0 = time, then component values) |
| `ANIM_CTRL.LEN` | `4` | Length of the control `Int32Array` |

### Defaults & layout constants

| Constant | Value | Meaning |
|---|---|---|
| `CHART_RING_ROWS` | `8192` | Chart ring capacity in rows. Sized for ~10 s window at the 0.005 s fast sample rate (≈2000 rows) × ~4 safety headroom |
| `CHART_TIME_COL` | `0` | Column 0 of every chart row is model time (Float64, seconds) |
| `ANIM_TIME_SLOT` | `0` | Slot 0 of every anim frame is model time |
| `ANIM_FLOATS_PER_COMPONENT` | `2` | Two floats per animated component: `[magnitude, tintSource]` |

## Key methods

All are pure helpers used to compute anim-frame geometry consistently on both sides.

| Signature | Behavior |
|---|---|
| `animStride(componentCount)` | Floats per anim frame: `ANIM_TIME_SLOT + 1 + componentCount * ANIM_FLOATS_PER_COMPONENT`. So `1 + 2*count`. |
| `animMagOffset(componentIndex)` | Float offset of a component's **magnitude** within a frame: `1 + componentIndex * 2`. |
| `animTintOffset(componentIndex)` | Float offset of a component's **tint-source** value: `1 + componentIndex * 2 + 1`. |
| `sharedMemoryAvailable()` | `true` iff `SharedArrayBuffer` is defined **and** `globalThis.crossOriginIsolated === true`. Drives default transport selection in [ChannelWriter](./ChannelWriter.md). |

## Protocol / layout

**Chart row layout** (Float64): `[time, signal_0, signal_1, …]` — column 0 is model time (`CHART_TIME_COL`), then one float per watched signal in registry order. Stride = `1 + signalCount`.

**Anim frame layout** (Float32): `[time, mag_0, tint_0, mag_1, tint_1, …]` — slot 0 is model time (`ANIM_TIME_SLOT`), then `(magnitude, tintSource)` pairs per animated component. Stride = `animStride(count)`.

**Shared-mode buffers:** each channel pairs a control `Int32Array` (`CHART_CTRL.LEN` / `ANIM_CTRL.LEN` entries) with a data typed array (`Float64Array` ring for chart, two-frame `Float32Array` for anim). The control array's `VERSION` / `STRIDE` / `CAPACITY` fields let the reader validate it is attached to a buffer that still matches the current registry.

**Handshake:** `RT_MSG.CHANNELS` is posted once per (re)allocation and carries the transport descriptor, the chart registry (`version` + `slots`), and the anim registry. In shared mode it additionally carries the `SharedArrayBuffer` handles (structured clone shares, not copies, SABs across the worker boundary). After the handshake, shared mode needs **no per-tick messages**; transferable mode posts `RT_MSG.CHART` / `RT_MSG.ANIM` on each flush.

## Notes / caveats

- **Transport is selected, not negotiated.** `sharedMemoryAvailable()` decides the default at writer construction. If the page is not cross-origin isolated, the entire data plane silently falls back to `"transferable"` and still works — just with one buffer posted per tick instead of zero.
- **Version gating.** Every control header carries a `VERSION`. A reader holding an old registry must ignore rows/frames whose version does not match; this is how a live watchlist or diagram change (which reallocates buffers and bumps the version) avoids mis-decoding stale data.
- This module has **no runtime behavior to break** — changing a constant here silently changes the contract for both [ChannelWriter](./ChannelWriter.md) and the reader. Keep the two ends in lockstep.

```

### FILE: explain-engine/docs/Resistor.md

````markdown
# Resistor

A `Resistor` moves blood or gas between two compartments, driven by the pressure difference between them. It is the flow element of every circuit in the model (vessels, valves, airways, ventilator and ECLS tubing) and the reference implementation of the additive factor pattern for resistances.

## Physiology

Blood flows from high to low pressure, and how much flows depends on the *resistance* of the path: flow = pressure difference / resistance. Narrow or constricted vessels have a high resistance. Resistance in mmHg·s/L is the same quantity as SVR or PVR, only in absolute units and for one connection.

Some refinements are available:
- **Valves.** A connection can let flow through in one direction only (heart valves, venous valves), or have a higher resistance backwards than forwards.
- **Turbulence.** Through a narrow opening (a stenotic valve, a restrictive duct) the pressure loss grows with the *square* of the flow (Bernoulli). An optional non-linear term models this.
- **Mixing without net flow.** Between two compartments that are really one continuous space (the two halves of the right atrium, the dead space and the alveoli), blood or gas also mixes by eddies or diffusion without any net flow.
- **Occlusion.** A connection can be closed completely (a clamped cord, an obstructed airway, a closed duct).

## Inheritance

```
BaseModelClass
  └── Resistor
        └── HeartValve   (no code of its own: same class under its own model_type)
```

A valve's one-way behaviour comes from `no_back_flow: true` in its definition, not from the class. Several plain Resistors are one-way too (`RAIVCI_RV`, `RASVC_RV`, `VLB_IVCI`, `VUB_SVC`, …).

**Vessel-owned connectors.** A [`BloodVessel`](./BloodVessel.md) creates one Resistor per entry in its `inputs`, named `<input>_<vessel>` (e.g. `PA_PAAL`). Every step the vessel writes its own effective values into that connector:

- `r_for`, `r_back`, `r_k`;
- `no_flow`, `no_back_flow`;
- `p1_ext`, `p2_ext`;
- `is_enabled`.

So set those on the vessel, not on the connector: a value written on the connector is overwritten. `implicit`, `mix_flow`, `no_flow_ext` and the connector's own factor layers are **not** overwritten. In term_neonate_72h 42 of the 75 resistors are vessel-owned and 33 stand alone (valves, shunts, airways, devices).

## Properties

### Config (set in the definition JSON)

| Property | Unit | Default | Description |
|---|---|---|---|
| `comp_from` | – | `""` | Upstream compartment (name). Positive flow goes from here to `comp_to`. |
| `comp_to` | – | `""` | Downstream compartment (name). |
| `r_for` | mmHg·s/L | 1.0 | Forward resistance (flow from `comp_from` to `comp_to`). |
| `r_back` | mmHg·s/L | 1.0 | Backward resistance. |
| `r_k` | mmHg·s²/L² | 0.0 | Turbulent (quadratic) coefficient: an extra pressure loss `r_k·flow²`. 0 in every shipped scenario. |
| `no_flow` | boolean | `false` | Closes the connection. |
| `no_flow_ext` | boolean | `false` | A second, independent closing gate for a model that does not own the resistor (an owning BloodVessel rewrites `no_flow` every step). Used by `MaternalPlacenta`. |
| `no_back_flow` | boolean | `false` | One-way connection (valve). |
| `implicit` | boolean | `false` | Numerical scheme for stiff pairs; see [Implicit flow](#implicit-flow-implicit). |
| `mix_flow` | L/s | 0.0 | Exchange without net flow; see [Mixing without net flow](#mixing-without-net-flow-mix_flow). |
| `inertance` | mmHg·s²/L | 0.0 | Inertance L of the blood column (ρ·length/area); see [Inertance](#inertance-inertance). 0 = purely resistive. |
| `r_factor`, `r_k_factor` | – | 1.0 | Non-persistent factors, reset to 1 every step. `r_factor` scales both `r_for` and `r_back`. |
| `r_factor_ps`, `r_k_factor_ps` | – | 1.0 | Persistent factors. |
| `r_factor_scaling_ps`, `r_k_factor_scaling_ps` | – | 1.0 | Persistent scaling factors. |

### Outputs

| Property | Unit | Default | Description |
|---|---|---|---|
| `flow` | L/s | 0.0 | Flow this step: positive forward, negative backward, 0 when closed. |
| `r_for_eff`, `r_back_eff` | mmHg·s/L | 1000 | Effective resistances after the factor layers (and the implicit correction). |
| `r_k_eff` | mmHg·s²/L² | 0 | Effective turbulent coefficient. |

### Set by other models

| Property | Unit | Default | Description |
|---|---|---|---|
| `p1_ext`, `p2_ext` | mmHg | 0.0 | Extra pressure on the inlet / outlet for this step, reset to 0 after use. On a vessel-owned connector the vessel copies its own `p1_ext`/`p2_ext` every step, so a value written on the vessel acts until it is set back to 0. |

### Internal

| Property | Description |
|---|---|
| `_comp_from`, `_comp_to` | Cached references to the two compartments. Re-resolved when `comp_from`/`comp_to` change (e.g. ECLS re-cannulation) or when the engine's `_models_version` changes (bumped at every `calculate()` call and realtime tick). |

## Calculation

`calc_model()` resolves the compartment references, then runs `calc_resistance()` → `calc_flow()` → the mixing exchange.

1. **`calc_resistance`**
   ```
   r_for_eff  = r_for  · (1 + (r_factor − 1) + (r_factor_ps − 1) + (r_factor_scaling_ps − 1))
   r_back_eff = r_back · (same three layers)
   r_k_eff    = r_k    · (1 + (r_k_factor − 1) + (r_k_factor_ps − 1) + (r_k_factor_scaling_ps − 1))
   ```
   `r_factor` and `r_k_factor` are reset to 1. With `implicit`, `dt·(E_from + E_to)` is added to both effective resistances.
2. **`calc_flow`**, with `p1 = comp_from.pres + p1_ext` and `p2 = comp_to.pres + p2_ext` (then `p1_ext`/`p2_ext` are reset):
   - closed (`no_flow` or `no_flow_ext`): `flow = 0`;
   - `p1 ≥ p2`: forward, `flow = f(p1 − p2, r_for_eff)`;
   - `p1 < p2` and not `no_back_flow`: backward, `flow = −f(p2 − p1, r_back_eff)`;
   - `p1 < p2` with `no_back_flow`: `flow = 0`;
   - a non-positive effective resistance gives `flow = 0` (guard against Infinity/NaN).

   `f(Δp, R)` solves `Δp = R·f + r_k·f²` exactly for this step:

   ```
   f = 2·Δp / (R + √(R² + 4·r_k·Δp))        (= Δp / R when r_k = 0)
   ```

   This form has no cancellation for small `r_k`. Because the loss is solved in the same step, the flow can't lag, oscillate or reverse direction.
3. **Volume transfer** (forward; mirrored for backward flow):
   ```
   not_removed = comp_from.volume_out(flow·dt)
   comp_to.volume_in(flow·dt − not_removed, comp_from)
   ```
   The upstream compartment returns what it could not supply, so a resistor never creates volume out of an empty compartment. `volume_in` also mixes the incoming blood or gas composition.
4. **Mixing**: if `mix_flow > 0` and the connection is open, an equal volume is swapped both ways (see below).

## Factor system

`r_for`/`r_back` (one shared family) and `r_k` carry the three layers, composed **additively** (see [ARCHITECTURE §7a](./ARCHITECTURE.md#7a-the-factor--effective-value-pattern)). Writers in the current code:

| Layer | Writers |
|---|---|
| `r_factor` (reset every step) | `Respiration` (airways), `Uterus`, `Heart` (`AA_COR`, systolic coronary resistance) |
| `r_factor_ps` | `Circulation`, `Brain`, `Kidneys`, `Hormones`, `Respiration`, `Surfactant`, the `Calibrator`; the user and scenarios via `setPropValue` |
| `r_factor_scaling_ps` | `ModelScaler`; the `Calibrator` (PAP lever on `IPSL`/`IPSR`); `Uterus`, `MaternalPlacenta` |

The factors of a vessel-owned connector multiply on top of the vessel's own effective resistance, which the vessel already composes from its own layers.

## Inputs and outputs

- **Reads:** `pres` of `comp_from` and `comp_to`; their elastances (`el_eff`, or `el_min_eff`/`el_max_eff`/`act_factor`) when `implicit`.
- **Writes:** the volume of both compartments (`volume_out`/`volume_in`); their composition through `volume_in` and the mixing exchange.
- **Written by:** an owning `BloodVessel` (see [Inheritance](#inheritance)); `Shunts`, `Pda`, `Placenta`, `MaternalPlacenta`, `Respiration`, `Apnea` and the devices (`no_flow`, resistances); the factor writers above.
- **Read by:** `Heart` (the mitral and aortic flows mark end-diastole and end-systole), `Mob` (`AA_COR` coronary flow), `Monitor` (its `flow_targets` read-outs), `DataCollector` watchers (the UI's flow charts).

## Assumptions and limitations

- **Resistive unless `inertance` is set.** Without inertance flow responds instantly to the pressure difference. Only the AV valves carry inertance (see below).
- **Laminar unless `r_k` is set.** Every shipped resistor is linear (`r_k = 0`). The duct and septal shunts compute their orifice losses separately (see [Pda](./Pda.md), [Shunts](./Shunts.md), `helpers/Orifice.js`).
- **Valves are ideal switches.** A `no_back_flow` connection closes instantly at zero pressure difference. There is no valve leaflet dynamics and no regurgitation unless `no_back_flow` is false with a finite `r_back`.
- **Explicit volume update.** See [Implicit flow](#implicit-flow-implicit) for when that matters.

## Inertance (`inertance`)

With `inertance` L > 0 the flow is a state that has to be accelerated: `dp = R·f + r_k·|f|·f + L·df/dt`. Each step it is updated semi-implicitly, `f ← (f + dt·dp/L) / (1 + dt·R/L)` with R = `r_for_eff` (or `r_back_eff` while flowing backward) plus `r_k_eff·|f|` linearised at the old flow, which is unconditionally stable for the resistor itself; with the compartments it oscillates at √(ΣE/L), far slower than the step for physiological L. The flow is kept in the public `flow`, so it survives a saved state. A valve (`no_back_flow`) closes when its flow comes to zero and stays closed until the pressure difference drives it forward again.

Inertance is used on the atrioventricular valves (`LA_LV`, `RAIVCI_RV`, `RASVC_RV`), where it shapes the E and A filling waves: without it the ventricle filled in an early surge (term mitral E 1.58 m/s against ~0.6). Term: twice the column of a 10 mm mitral (12 mm tricuspid) orifice and 1.5 cm of inflow, L = 3.04 (tricuspid pair 2.12) mmHg·s²/L; smaller hearts scale as geometrically similar ones, L ∝ weight^(−1/3) (`scripts/_fix_av_inertance.mjs`). It works together with the ventricles' exponential relaxation ([Heart](./Heart.md) `relax_frac`).

## Implicit flow (`implicit`)

`implicit` switches one resistor from the explicit `Δp / R` to the backward-Euler solution for the two compartments it joins, `Δp / (R + dt·(E_from + E_to))`. It does this by adding `dt·(E_from + E_to)` to `r_for_eff`/`r_back_eff` each step. `E` is the compartment's current **local** elastance: `el_eff`, or a time-varying elastance's instantaneous value, plus the slope `2·el_k_eff·S` of the non-linear term above the unstressed volume (for a time-varying elastance on its diastolic curve). It is a numerical scheme, not a change of the resistor law. Both forms are first-order accurate and agree when `R >> dt·ΣE`.

Explicit integration of two capacitances joined by a small resistance is stable only while `dt·(E_from + E_to)/R < 2`. For three equal capacitances in a row, as in the aorta (AA → AAR → AD, joined by `AA_AAR` and `AAR_AD`, R ≈ 70 mmHg·s/L), the limit is 4/3. Stiffening the large arteries, which a small infant's pulse pressure needs, crosses that limit at about ×2–3. Measured on the 0.72 kg Bischoff infant (AA pressure range, mmHg):

| Arterial stiffness | Explicit | Implicit `AA_AAR`, `AAR_AD` | Explicit, half time step |
|---|---|---|---|
| ×1.8 | 23.6–35.7 | 23.6–35.8 | 23.7–35.7 |
| ×3 | unstable | 21.4–39.8 | 21.5–39.6 |
| ×5 | unstable | 18.4–44.7 | 18.2–44.4 |

term_neonate_72h sets it on 13 resistors: the outflow valves (`LV_AA`, `RV_AA`), the aortic chain (`AA_AAR`, `AAR_AD`) and the aortic branches (`AA_COR`, `AA_BR_ART`, `AA_RUB`, `AAR_DA`, `AD_LS_ART`, `AD_KID_ART`, `AD_INT_ART`, `AD_RLB`, `AD_PL_UMB_ART`). The 8 scenarios with quadratic heart chambers also set it on `RAIVCI_RASVC`, the low-resistance (13 mmHg·s/L) link between the two right-atrial halves: their stiffness grows with filling, and the explicit scheme then flipped the flow's sign every step. The patient builder and the live tuner set it the same way on the aorta.

## Mixing without net flow (`mix_flow`)

Flow carries upstream blood downstream (advection). Between two compartments that are really one continuous pool, blood also mixes by eddies and vortex flow, even when the net flow between them is close to zero. Molecular diffusion can't stand in for that: O2 needs minutes to diffuse a millimetre.

`mix_flow` (L/s) adds that exchange. Each step an equal volume `dv = mix_flow·dt` is swapped both ways, with no net volume change, using the pre-exchange concentrations:

```
c_a += (c_b − c_a)·dv / V_a        c_b += (c_a − c_b)·dv / V_b
```

So `c_a·V_a + c_b·V_b` is conserved:
- **Blood:** for `to2`, `tco2`, every solute and drug, and temperature ([`helpers/BloodMixing.js`](../helpers/BloodMixing.js) `exchange_blood`). Viscosity follows the haemoglobin.
- **Gas:** for the five species O2, CO2, N2, H2O and other ([`helpers/GasMixing.js`](../helpers/GasMixing.js) `exchange_gas`). This stands for molecular diffusion and cardiogenic mixing at the airway–alveolus junction, which go on without flow (in apnoea). It uses the composition at the connecting ends, so a series dead space exchanges through its distal sub-tank.

Further rules:
- `dv` is clamped to half the smaller volume.
- A `fixed_composition` end keeps its composition.
- A closed connection doesn't exchange.
- The equilibration time constant is about `V_a·V_b / ((V_a + V_b)·mix_flow)`.

Shipped values (term_neonate_72h): `RAIVCI_RASVC` 0.01 L/s (right-atrial halves), `DS_ALL` and `DS_ALR` 0.001 L/s (dead space to alveoli).

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Circulation.components.PV_LA` (trimmed). The pulmonary venous inflow to the left atrium has a backward resistance 10× the forward one:

```json
{
  "name": "PV_LA",
  "model_type": "Resistor",
  "is_enabled": true,
  "comp_from": "PV",
  "comp_to": "LA",
  "r_for": 204.8,
  "r_back": 2048.4,
  "r_k": 0,
  "no_flow": false,
  "no_back_flow": false,
  "implicit": false,
  "mix_flow": 0
}
```

## Usage in the scenarios

Term_neonate has 75: 68 `Resistor` and 7 `HeartValve` (`LA_LV`, `RAIVCI_RV`, `RASVC_RV`, `RV_PA`, `LV_AA`, and the disabled `RV_AA`, `LV_PA`; one-way). The AV valves carry inertance; the aortic and pulmonary valves have per-scenario resistances from Doppler peak velocities (`scripts/_fix_outflow_valves.mjs`).

- **Vessel-owned (42):** the connector into every `BloodVessel`.
- **Stand-alone (33):**
  - heart inflow (`PV_LA`, `IVCI_RAIVCI`, `SVC_RASVC`) and the valves;
  - shunts (`AAR_DA`, `LA_RAIVCI`, `LA_RASVC`, `VSD`, `IPSL`, `IPSR`, `RAIVCI_RASVC`);
  - coronaries (`AA_COR`, `COR_RAIVCI`, `COR_RASVC`);
  - airways (`MOUTH_DS`, `DS_ALL`, `DS_ALR`);
  - ventilator and ECLS circuit connections;
  - the umbilical vein (`PL_UMB_VEN_IVCI`).

## References

No literature-derived values in this class. The resistances are scenario parameters (see the `*Reference.md` pages). The quadratic loss is the standard Bernoulli form (Δp ∝ Q²); the shipped orifice coefficients live in `helpers/Orifice.js`.

````

### FILE: explain-engine/docs/Respiration.md

````markdown
# Respiration

`Respiration` coordinates the respiratory system; it holds no gas itself. It groups the airway, lung, thorax and gas-exchange models by name and gives them system-wide levers: lung and chest-wall stiffness, upper and lower airway resistance, and gas-exchange capacity. It configures the airway dead space as a series (plug-flow) dead space, and it owns **atelectasis**: collapse of part of a lung, its recruitment and derecruitment with pressure, and resorption collapse behind a blocked bronchus.

## Physiology

The respiratory system is the airways (upper: nose, larynx, trachea; lower: bronchi down to the alveolar ducts), the lungs, and the chest wall around them. Disease acts on a few properties at once:
- **compliance:** stiff lungs in RDS, a stiff or floppy chest wall;
- **resistance:** bronchospasm, secretions, a narrow tube;
- **exchange surface:** lost alveoli, oedema.

**Atelectasis** is collapse of alveoli. A collapsed region loses its gas volume, its share of the lung's compliance and its exchange surface, but its blood keeps flowing past without picking up oxygen: an intrapulmonary shunt, partly limited by hypoxic pulmonary vasoconstriction. Collapsed units reopen above an *opening pressure* (a recruitment manoeuvre, a sustained inflation) and close again below a lower *closing pressure*. That hysteresis is why PEEP keeps a recruited lung open. Behind a blocked bronchus (mucus plug, a tube in the other main bronchus) the trapped gas is absorbed into the blood and the lung collapses: fast if the gas was oxygen, slowly if it was air, because nitrogen dissolves poorly.

## Inheritance

```
BaseModelClass
  └── Respiration
```

## Properties

### Config: groups (names of models)

| Property | Scenario value | Used by |
|---|---|---|
| `upper_airways` | `["MOUTH_DS"]` | `res_upper_airways_factor` |
| `lower_airways` | `["DS_ALL", "DS_ALR"]` | `res_lower_airways_factor` |
| `lower_airways_left`, `lower_airways_right` | `["DS_ALL"]`, `["DS_ALR"]` | bronchus obstruction |
| `dead_space` | `["DS"]` | series dead space |
| `thorax` | `["THORAX"]` | `el_thorax_factor` |
| `lungs`, `left_lung`, `right_lung` | `["ALL", "ALR"]`, `["ALL"]`, `["ALR"]` | `el_lungs_factor`; atelectasis; the dead space's distal end |
| `gas_exchangers`, `gas_exchanger_left_lung`, `gas_exchanger_right_lung` | `GASEX_LL`, `GASEX_RL` | `gex_factor`; atelectasis |
| `intrapulmonary_shunt_left`, `intrapulmonary_shunt_right` | `["IPSL"]`, `["IPSR"]` | atelectasis perfusion |
| `pulmonary_capillaries_left`, `pulmonary_capillaries_right` | `xL_ART_xL_CAP`, `xL_CAP_xL_VEN` | atelectasis perfusion |

Older (archived) scenarios spell `gas_exchangers` as `gas_echangers`; `init_model` accepts it.

### Config: system levers

Multipliers around 1; a change is added as a delta to the members' persistent layer (see [Calculation](#calculation)).

| Property | Default | Acts on |
|---|---|---|
| `el_lungs_factor` | 1.0 | lungs' `el_base_factor_ps` |
| `el_thorax_factor` | 1.0 | thorax's `el_base_factor_ps` |
| `res_upper_airways_factor` | 1.0 | upper airways' `r_factor_ps` |
| `res_lower_airways_factor` | 1.0 | lower airways' `r_factor_ps` |
| `gex_factor` | 1.0 | gas exchangers' `dif_o2_factor_ps` and `dif_co2_factor_ps` |

### Config: series dead space

| Property | Unit | Default | Description |
|---|---|---|---|
| `dead_space_segments` | – | 32 | Composition sub-tanks of the dead space (1 = well mixed). |
| `dead_space_dispersion` | – | 0.015 | Axial dispersion coefficient. |
| `dead_space_diffusion` | L/s per interface | 0 | Molecular diffusion along the dead space; scenarios 1e-5. |

Written onto every `dead_space` compartment each update, with `distal_models = lungs` (see [GasCapacitance → Series dead space](./GasCapacitance.md#series-dead-space)).

### Config: atelectasis

| Property | Unit | Default | Description |
|---|---|---|---|
| `atelectasis_left`, `atelectasis_right` | fraction | 0 | Collapsed fraction of each lung (clamped to `atelectasis_max`). Setting it also defines the unstable region. |
| `atelectasis_max` | fraction | 0.9 | Upper limit. |
| `atelectasis_hpv` | fraction | 0.3 | Share of the collapsed units' blood that hypoxic vasoconstriction diverts away from the lung. |
| `atelectasis_recruitable` | boolean | true | Pressure can reopen collapsed units. Off = obstructive/resorption atelectasis. |
| `atelectasis_open_pressure`, `atelectasis_open_sd` | cmH2O | 25, 3 | Opening pressures (normal distribution). |
| `atelectasis_close_pressure`, `atelectasis_close_sd` | cmH2O | 8.5, 1.5 | Closing pressures. |
| `atelectasis_tau_open`, `atelectasis_tau_close` | s | 3, 30 | Recruitment and derecruitment time constants. |
| `airway_obstructed_left`, `airway_obstructed_right` | boolean | false | A plug in the main bronchus. |
| `atelectasis_resorb_tau_air`, `atelectasis_resorb_tau_o2` | s | 1800, 240 | Resorption time constant with trapped air and trapped oxygen. |

## Calculation

**Every step:** while a lung has atelectasis, its perfusion split is rewritten on the non-persistent `r_factor` of its shunt and capillary resistors (see [Atelectasis](#atelectasis)).

**Every 15 ms:**
1. The series dead-space settings are pushed to the dead-space compartments.
2. Each lever that changed since the last update is applied by its setter: the change `new − previous` is added to the members' persistent layer, clamped at 0. Several models share these layers, so Respiration only ever adds its own change. A set-and-clear round trip restores the start values.
3. Changed atelectasis or obstruction settings are applied.
4. Per lung: an obstructed lung resorbs; an open lung with an unstable region recruits or derecruits with its distending pressure.

The setters (`set_el_lung_factor`, `set_el_thorax_factor`, `set_upper_airway_resistance`, `set_lower_airway_resistance`, `set_gasexchange`, `set_atelectasis_left/right`, `set_airway_obstructed_left/right`) can also be called directly; each records its new value, so a change is applied once either way. `set_tube_block(side, state)` is called by the Ventilator.

## Atelectasis

A shunt alone is not atelectasis. Lowering the intrapulmonary-shunt resistance reproduces the
hypoxaemia but leaves the lung fully aerated: FRC, compliance and Vt do not change, so neither the
ventilator readouts nor PEEP have anything to act on. A collapsed unit loses four things at once, and
each lung already has a channel for each:

| Collapsed fraction `c` | Channel | Layer |
|---|---|---|
| aerated volume ×(1 − c) | `ALL`/`ALR` `u_vol` | `u_vol_factor_ps` (delta) |
| elastance ×1/(1 − c) (fewer units in parallel) | `ALL`/`ALR` `el_base` | `el_base_factor_ps` (delta) |
| exchange surface ×(1 − c) | `GASEX_LL`/`GASEX_RL` `dif_o2`, `dif_co2` | `dif_*_factor_ps` (delta) |
| perfusion of the collapsed units → shunt | `IPSL`/`IPSR` and the capillary resistors | `r_factor` (every step) |

The gas side follows the other `set_*` methods: the change in the target multiplier since the last
call is added to the persistent layer, so a set-and-clear round trip restores the start values and it
composes with `el_lungs_factor`, `gex_factor` and Surfactant's non-persistent layer.

**Perfusion.** The capillary path and the intrapulmonary shunt both run from `xL_ART` to `xL_VEN`, so
they see the same pressure drop and split the lung's blood flow in the ratio of their conductances.
With `G_ips`, `G_cap` the conductances without the non-persistent layer and `s0 = G_ips / (G_ips + G_cap)`
the shunt share of the aerated lung:

```
G_tot' = (G_ips + G_cap) · (1 − c·hpv)                    hypoxic vasoconstriction diverts blood away
s'     = s0 + (1 − s0) · c·(1 − hpv) / (1 − c·hpv)        the rest of the collapsed units' blood is shunted
```

Each shunt resistor is scaled by `G_ips / (s'·G_tot')` and each capillary resistor by
`G_cap / ((1 − s')·G_tot')`, written on the non-persistent `r_factor` every step: `r_factor_ps` on
`IPSL`/`IPSR` belongs to [Surfactant](./Surfactant.md) and the scaling layer to the Calibrator and
`ModelScaler`, and the factors are computed against those layers so they compose. Because the split is
set from conductance ratios, the shunt share does not depend on the scenario's `Shunts.ips_res`
(preterm 1600–4200, term 5000). With `c = 0` nothing is written.

On `term_neonate_72h`, right lung, room air (`scripts/probe_atelectasis.mjs`, measured when atelectasis was introduced, 2026-10):

| c | SaO₂ | PaO₂ | lung Qs | Qs/Qt | ALR ml | CMV 20/5: Vte | C (ml/mbar) |
|---|---|---|---|---|---|---|---|
| 0 | 96.3 | 70 | 9 % | 9 % | 53 | 46.6 | 3.10 |
| 0.3 | 93.7 | 58 | 30 % | 19 % | 39 | 42.9 | 2.86 |
| 0.6 | 89.6 | 47 | 56 % | 32 % | 23 | 37.8 | 2.52 |
| 0.9 | 82.2 | 39 | 88 % | 47 % | 6 | 31.2 | 2.08 |

These are the static effects, measured with `atelectasis_recruitable = false`.

### Recruitment

Setting a lung's atelectasis (`set_atelectasis_left/right`, or the prop) defines both the collapsed
fraction `c` and the **unstable** region `u = c`: the units prone to collapse. Within it, `x = c / u`
is the share that is collapsed. Healthy lungs (`u = 0`) never derecruit, and setting 0 resolves the
atelectasis completely. Recruited units **stay unstable**: they keep their closing pressure, so only
PEEP keeps them open.

Each unit has an opening and a closing pressure, normally distributed (the Hickling picture of
recruitment). They are evaluated every update (15 ms) on the lung's instantaneous **distending
pressure** `p = ALx.pres_in` (alveolar recoil = airway − pleural) in cmH₂O:

```
can_stay_closed = 1 − Φ((p − TOP) / sd_open)      units whose opening pressure is above p
must_close      = 1 − Φ((p − TCP) / sd_close)     units whose closing pressure is above p
x > can_stay_closed:  x → can_stay_closed  with tau_open     (recruitment)
x < must_close:       x → must_close       with tau_close    (derecruitment)
otherwise:            hold                                    (hysteresis)
```

Because `p` is instantaneous, recruitment follows the time spent at pressure. A sustained inflation or
an HFOV sigh opens more than brief breaths at the same peak. Every change of `c` goes through the same
persistent-layer deltas as a user change, and the perfusion follows it every step.

**Calibration.** At end-expiration the pleural pressure in this model is about −4.5 cmH₂O, so the
distending pressure sits roughly 5 cmH₂O above the set PEEP. On `term_neonate_72h`, the collapsed lung's
distending pressure in cmH₂O, min–max:

| | range |
|---|---|
| spontaneous | 4–8 |
| CMV 20/0 | 5–22 |
| CMV 20/2 | 7–22 |
| CMV 20/5 | 10–22 |
| CMV 28/8 | 12–27 |

The closing pressure is 8.5 cmH₂O (about PEEP 4 at the airway), with sd 1.5. So PEEP ≥ 8 holds
everything, PEEP 5 lets about a fifth of the unstable region re-collapse, and PEEP 2 or no support
re-collapses most of it.

The opening pressure is 25 cmH₂O (sd 3), the range of a neonatal sustained inflation. CMV 20/5
recruits only a little (its peak sits in the tail), while PIP 28 or a sigh of 27 mbar opens most of it.

Trace on `term_neonate_72h`, right lung, set to 0.6 on SLE CMV 20/5 (`scripts/probe_atelectasis.mjs`, 2026-10):

| phase | c | SaO₂ | lung Qs | ALR ml |
|---|---|---|---|---|
| CMV 20/5, 2 min after setting 0.6 | 0.53 | 91.1 | 49 % | 32 |
| PIP 28 / PEEP 8, 1 min | 0.29 | 94.3 | 30 % | 52 |
| PIP 20 / PEEP 8, 2 min (holds) | 0.29 | 94.2 | 29 % | 50 |
| PEEP 5, 3 min (holds) | 0.29 | 94.7 | 29 % | 47 |
| PEEP 2, 3 min (re-collapses) | 0.49 | 92.2 | 45 % | 33 |
| HFOV MAP 12 + 5 sighs 27 mbar × 3 s | 0.19 | 94.7 | 22 % | 57 |
| Standby, spontaneous, 3 min | 0.55 | 90.6 | 50 % | 26 |

With `atelectasis_recruitable = false` (a mucus plug, resorption atelectasis) the collapse ignores
pressure. Where a scenario has [Surfactant](./Surfactant.md), it keeps its own whole-lung
recruitment on the non-persistent layer. The two run independently and their effects add.

The thresholds are calibrated on the term lung. In the since-removed `preterm_28wk`, recruitment with PIP 28 or sighs
works the same way, but PEEP 8 already lets some re-collapse. At PEEP ≤ 5, Surfactant derecruits the
whole lung as well, so a surfactant-deficient lung needs more PEEP, as at the bedside.

Because the factor layers add up, Surfactant's derecruitment and atelectasis together can take a
lung's effective unstressed volume or diffusion constant below zero. [Capacitance](./Capacitance.md)
floors `u_vol_eff` and [GasExchanger](./GasExchanger.md) the diffusion constants at 0. A negative
diffusion constant would pump gas against its gradient and blow up the blood gases.

### Bronchus obstruction and resorption

`airway_obstructed_left` / `_right` (setters `set_airway_obstructed_left/right`) close a main
bronchus (`DS_ALx.no_flow`) with a mucus plug. A tube in the right main bronchus blocks the left one
through `set_tube_block(side, state)` (called by [Ventilator](./Ventilator.md#airway-events)). That
block is kept apart from the plug, and the bronchus is closed while either holds. No gas moves in or out, and the
trapped gas is absorbed into the blood, so the lung collapses (resorption atelectasis):

```
c → atelectasis_max    with tau = tau_air + (tau_o2 − tau_air) · (FO₂_trapped − 0.21) / 0.79
```

Oxygen absorbs fast and nitrogen slowly, so the time constant runs from `atelectasis_resorb_tau_air`
(1800 s, trapped room air) to `_tau_o2` (240 s, trapped oxygen). `FO₂_trapped` is the lung's `fo2`
captured at the moment of obstruction. The absorbed gas leaves the lung: each update holds the
trapped lung at its captured recoil pressure, so it deflates instead of pressurising as it stiffens.
The collapsed units join the unstable region. While obstructed, pressure recruitment of that lung
pauses. Once the bronchus is open again, pressure recruits it and PEEP keeps it open.

On term_neonate_72h with a right-mainstem tube on CMV 20/5, the left lung's collapse after 10 minutes is
0.26 on air and 0.67 on oxygen. A right bronchial plug in a spontaneously breathing baby takes SaO₂
from 96 to 76 % in 5 minutes.

## Factor system

None of its own. It writes:

| Target | Layer |
|---|---|
| lungs, thorax | `el_base_factor_ps` (levers, atelectasis); lungs' `u_vol_factor_ps` (atelectasis) |
| airways | `r_factor_ps` (levers); `no_flow` (obstruction) |
| gas exchangers | `dif_o2_factor_ps`, `dif_co2_factor_ps` (`gex_factor`, atelectasis) |
| shunt and capillary resistors | `r_factor`, every step while there is atelectasis |

## Inputs and outputs

- **Reads:** the lungs' `pres_in`, `fo2`, `vol`, `u_vol_eff`, `el_eff`; the resistors' layers.
- **Writes:** the layers above; the dead space's series settings; trapped-lung volume (`volume_out`) during resorption.
- **Written by:** the user and bot (levers, atelectasis, plugs); the [Ventilator](./Ventilator.md#airway-events) (`set_tube_block`); scenario generators (`el_lungs_factor`, `gex_factor`).
- **Read by:** `DataCollector` watchers and the probes (`atelectasis_left/right`).

## Assumptions and limitations

- **Levers add.** The persistent layers are shared, so simultaneous writers add their changes. A layer driven to the 0 clamp loses the part of the change below 0.
- **Membership is by name.** Only models named in the lists are affected.
- **Atelectasis is per lung, not regional,** and calibrated on the term lung. In preterm lungs, [Surfactant](./Surfactant.md)'s own whole-lung recruitment runs in parallel; their effects add.
- **The perfusion split assumes the shunt and capillary paths share one pressure drop** (`xL_ART` → `xL_VEN`).

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Respiration` (trimmed: groups and atelectasis defaults left out):

```json
{
  "name": "Respiration",
  "model_type": "Respiration",
  "is_enabled": true,
  "lungs": ["ALL", "ALR"],
  "thorax": ["THORAX"],
  "el_lungs_factor": 1,
  "el_thorax_factor": 1,
  "res_upper_airways_factor": 1,
  "res_lower_airways_factor": 1,
  "gex_factor": 1,
  "dead_space_segments": 32,
  "dead_space_dispersion": 0.015,
  "dead_space_diffusion": 1e-5,
  "atelectasis_left": 0,
  "atelectasis_right": 0
}
```

## Usage in the scenarios

One instance in every scenario, owning `MOUTH`, `DS`, `ALL`, `ALR`, `THORAX`, `GASEX_LL` and `GASEX_RL`. term_neonate_72h uses the defaults above for every lever (1) and for atelectasis (0); disease (in the since-removed preterm scenarios) is carried by the compartments' own values and by Surfactant (enabled there).

## References

- Hickling KG. The pressure-volume curve is greatly modified by recruitment: a mathematical model of ARDS lungs. *Am J Respir Crit Care Med* 1998;158:194–202. doi:10.1164/ajrccm.158.1.9708049 (normally distributed opening and closing pressures).

````

### FILE: explain-engine/docs/Resuscitation.md

````markdown
# Resuscitation

The `Resuscitation` device model drives a **CPR** scenario: rhythmic chest compressions plus
ventilations, in the standard compression/ventilation cycles. It is a **coordinator** — it generates a
sinusoidal compression-pressure waveform and applies it to the circulation as an external pressure,
and it commands the [`Ventilator`](./Ventilator.md) and [`Breathing`](./Breathing.md) models to
deliver (or suppress) breaths.

> **Experimental in the app:** the Resuscitation panel is hidden as unfinished; the model and its probe work.

## Physiology

In neonatal cardiac arrest (or a heart rate below 60/min despite effective ventilation) chest compressions are given at a 3:1 ratio with ventilation (90 compressions and 30 breaths a minute), or continuously with asynchronous ventilation once the airway is secured. Compressions squeeze the heart and the great vessels between sternum and spine and raise the intrathoracic pressure, driving blood forward; the valves keep it from flowing back. Effective CPR produces a fraction of the normal cardiac output, enough to perfuse the heart and brain while the cause is treated.

## Inheritance

```
BaseModelClass
  └── Resuscitation   (CPR coordinator: compressions + ventilation timing)
```

`Resuscitation` extends `BaseModelClass` directly and owns no sub-models — it acts on existing models
(`Ventilator`, `Breathing`, and the compartments named in `chest_comp_targets`) by reference.

## What it models

- **Chest compressions** — a sinusoidal external pressure applied to a set of weighted target
  compartments (heart chambers, great vessels, lungs, coronaries).
- **Ventilations** — delivered through the mechanical `Ventilator` (spontaneous `Breathing` is
  switched off while CPR runs).
- **Compression/ventilation ratio** — e.g. 15 compressions : 2 breaths, or continuous compressions
  with asynchronous ventilation.

## Properties

### Configuration (independent)

| Property | Unit | Description |
|---|---|---|
| `cpr_enabled` | bool | Master on/off (normally toggled via `switch_cpr`) |
| `chest_comp_freq` | compressions/min | Compression frequency (default 100) |
| `chest_comp_max_pres` | mmHg | Peak compression pressure (default 10; scenarios use ~60) |
| `chest_comp_targets` | dict | `{ compartment: relative weight }` to compress |
| `chest_comp_no` | count | Compressions per cycle before a pause (default 15) |
| `chest_comp_cont` | bool | Continuous compressions (no ventilation pauses) (default false) |
| `vent_freq` | breaths/min | Ventilation frequency (default 30) |
| `vent_no` | count | Breaths per ventilation pause (default 2) |
| `vent_pres_pip` | cmH₂O | Ventilator PIP during CPR (default 16) |
| `vent_pres_peep` | cmH₂O | Ventilator PEEP during CPR (default 5) |
| `vent_insp_time` | s | Ventilator inspiratory time during CPR (default 1.0) |
| `vent_fio2` | fraction | Inspired O₂ fraction, pushed to the ventilator (default 0.21) |

### Computed (dependent)

| Property | Unit | Description |
|---|---|---|
| `chest_comp_pres` | mmHg | Current compression pressure (the waveform value) |
| `vent_settings_saved` | object or null | The ventilator settings CPR replaced (mode, pressures, rate, Ti, flow, synchronisation, trigger, FiO2), restored when CPR stops. Saved with the state, so the restore also works after a reload. |

### Internal (`_`-prefixed)

`_ventilator` / `_breathing` are references resolved in `init_model`. `_comp_timer` /
`_comp_counter` track the current compression; `_comp_pause` / `_comp_pause_interval` /
`_comp_pause_counter` manage the ventilation pause; `_vent_interval` / `_vent_counter` schedule the
breaths within a pause.

## Enabling CPR — `switch_cpr(state)`

Both branches first call `_reset_cycle()`, which zeroes every internal timer/counter
(`_comp_timer`, `_comp_counter`, `_comp_pause`, `_comp_pause_counter`, `_vent_counter`,
`_vent_breath_count`) and `chest_comp_pres`. This guarantees a re-toggle always restarts a clean
cycle rather than resuming mid-compression or mid-pause with stale state.

When turned **on** it: resets the cycle, saves the ventilator settings it is about to replace (mode,
PIP, PEEP, rate, Ti, flow, `synchronized`, `trigger_mode`, FiO₂), starts the ventilator
(`switch_ventilator(true)`), sets the fresh gas to `vent_fio2`, configures pressure control from
`vent_pres_pip` / `vent_pres_peep` / `vent_insp_time` at the circuit's own flow
(`set_pc(pip, peep, MANUAL_MODE_VENT_BACKUP_RATE, t_in, insp_flow)`), makes the breaths
**unsynchronised** (so the flow the compressions push through the tube can't trigger breaths),
switches off spontaneous `Breathing` (`switch_breathing(false)`), and sets `cpr_enabled = true`.
Switching it on while it is already on keeps the settings saved the first time.

On an [SLE6000](./Sle6000.md), the ventilator of every scenario up to 30 kg, these generic calls
are mirrored into the device settings (`_sync_from_generic`).
- The device screen shows PTV or CMV at the resuscitation PIP, PEEP and Ti.
- The rate is clamped to the device's 1/min minimum.
- It does not show Standby.

Turning it **off** resets the cycle and clears `cpr_enabled`, but **intentionally leaves the
ventilator running and spontaneous `Breathing` switched off** — this models the post-arrest,
still-ventilated patient. The ventilator gets back the settings saved when CPR started (not the
1/min backup rate), and the FiO₂ is restored through `set_fio2`. There is no automatic restore of spontaneous breathing; re-enable it
explicitly (`Breathing.switch_breathing(true)` / `Ventilator.switch_ventilator(false)`) if a
post-ROSC spontaneous state is wanted. All calls are null-guarded with `?.`.

## Calculation cycle (`calc_model`)

Runs every step while `cpr_enabled` (returns immediately otherwise):

   Frequencies are clamped to a small positive floor (`MIN_FREQ`) before being used in `60/f`
   denominators, so a configured `0` cannot produce an infinite-period cycle.
1. **Timing** — the compression pause equals the time for `vent_no` breaths
   (`_comp_pause_interval = (60/vent_freq)·vent_no`); breaths are spaced one breath-duration apart
   (`_vent_interval = 60/vent_freq`). In continuous mode the ventilator rate is set to `vent_freq`;
   otherwise it is dropped to `MANUAL_MODE_VENT_BACKUP_RATE` (a low mandatory-backup rate, **not** 0 —
   breaths are triggered manually during pauses, and the backup only fires if a trigger is missed).
2. **Pause handling** — while paused, `chest_comp_pres` is held at 0 (no compression force is applied
   during the ventilation pause); advance `_comp_pause_counter` until `_comp_pause_interval` elapses
   (then resume compressions). The first breath of the pause is delivered on pause entry; the
   remaining breaths are scheduled every `_vent_interval`, capped at `vent_no` total via
   `_vent_breath_count`, so exactly `vent_no` breaths are delivered per pause.
3. **Compression force** (when not paused) — a half-rectified sine:

   ```
   A = chest_comp_max_pres / 2
   f = chest_comp_freq / 60
   chest_comp_pres = A·sin(2πf·_comp_timer − π/2) + A
   ```

   so pressure ramps 0 → max → 0 each compression. After `60/chest_comp_freq` seconds the compression
   counter increments (only in non-continuous mode; in continuous mode the counter is unused and is
   not advanced).
4. **Cycle control** — after `chest_comp_no` compressions in non-continuous mode, enter a pause and
   trigger a breath.
5. **Apply force** — for each `{ compartment: weight }` in `chest_comp_targets`,
   `compartment.pres_ext += chest_comp_pres · weight`.

## Compression coupling (important)

The compression is delivered as **external pressure** (`pres_ext`), the channel that *every*
compartment type reads (blood vessels, heart chambers, the thorax `Container`, gas compartments). It
is added (`+=`) so it composes with other external pressures and is consumed + reset by each
compartment's `calc_pressure` every step.

> Previously the force was written to `pres_cc`, which only `GasCapacitance` (and the since-removed `BloodPump`) read — so
> the compressions reached the lungs but **not** the heart chambers or vessels, and generated no
> circulation. Writing `pres_ext` makes compressions actually drive forward flow. Because `pres_ext`
> is reset each step, a compression can lag a given compartment by at most one step depending on model
> step order.

Typical `chest_comp_targets` weights (scenario): ventricles `LV`/`RV` and coronaries `COR` at 1.0,
atria `RASVC`/`RAIVCI` at 0.8 and `LA` at 0.5, great vessels `AA`/`AAR` at 0.7 and `SVC`/`IVCI` at
0.5, lungs `ALL`/`ALR` at 0.2.

## `set_fio2(new_fio2)`

Forwards to `Ventilator.set_fio2` (null-guarded). `switch_cpr(true)` applies `vent_fio2` this way;
`init_model` no longer does (it ran after Gas had built the fresh gas and overwrote any scenario FiO₂
at every load).

## Factor system

`Resuscitation` has no `*_factor` parameters — compression strength is set directly via
`chest_comp_max_pres` and per-target weights in `chest_comp_targets`.

## Example definition (JSON)

From `term_neonate_72h.json`:

```json
{
  "name": "Resuscitation",
  "description": "Resuscitation model",
  "is_enabled": true,
  "model_type": "Resuscitation",
  "components": {},
  "cpr_enabled": false,
  "chest_comp_freq": 100,
  "chest_comp_max_pres": 60,
  "chest_comp_targets": {
    "ALL": 0.2, "ALR": 0.2,
    "LA": 0.5, "LV": 1, "RV": 1,
    "RAIVCI": 0.8, "RASVC": 0.8,
    "AA": 0.7, "AAR": 0.7,
    "SVC": 0.5, "IVCI": 0.5,
    "COR": 1
  },
  "chest_comp_no": 15,
  "chest_comp_cont": false,
  "vent_freq": 30,
  "vent_no": 2,
  "vent_pres_pip": 16,
  "vent_pres_peep": 5,
  "vent_insp_time": 1,
  "vent_fio2": 0.21
}
```

`cpr_enabled: false` is the resting state — CPR is started at runtime with `switch_cpr(true)`.

## Inputs and outputs

- **Reads:** the target compartments (names), `Ventilator.insp_flow`.
- **Writes:** `pres_ext` of the `chest_comp_targets`; the Ventilator (`switch_ventilator`, `set_pc`, `set_fio2`, `vent_rate`, `synchronized`, `trigger_breath`); `Breathing.switch_breathing(false)`.
- **Written by:** the user and bot (`switch_cpr`, the CPR settings).
- **Read by:** `DataCollector` watchers.

## Usage in the model

- One `Resuscitation` per scenario, enabled but with `cpr_enabled: false` at rest. Start CPR with
  `switch_cpr(true)`; it takes over the [`Ventilator`](./Ventilator.md) (PC mode) and silences
  spontaneous [`Breathing`](./Breathing.md).
- Compression force reaches the circulation through `pres_ext` on the targeted compartments, driving
  forward flow during arrest.

## Assumptions and limitations

- **Compressions are a pressure waveform, not a force on a chest model:** each target compartment gets a fixed fraction of the compression pressure. No thoracic pump versus cardiac pump distinction, no chest recoil or compression depth.
- **The default ratio is 15:2** (`chest_comp_no` 15, `vent_no` 2), the paediatric two-rescuer ratio; the neonatal 3:1 ratio is set with `chest_comp_no` 3 and `vent_no` 1.

- **Requires `Ventilator` and `Breathing`.** Both are resolved at init; all calls are null-guarded, so
  a missing ventilator no longer crashes at build (`set_fio2`) or during CPR — compressions still run,
  but no mechanical breaths are delivered.
- **Compression is order-sensitive.** Applied via `pres_ext +=`; if `Resuscitation` steps after a
  target compartment, that compartment sees the compression one step later. Stable at the default step
  size.
- **Frequencies are clamped, not assumed valid** — `chest_comp_freq` and `vent_freq` appear in
  `60/f` denominators and are floored at `MIN_FREQ`, so a configured `0` degrades to a very-low-rate
  cycle instead of producing `Infinity`/`NaN`.

## Verification — `scripts/probe_resuscitation.mjs`

Headless probe that warms a scenario, simulates a cardiac **arrest** (disables `Heart` and zeroes the
chamber activation factors so the ventricles are flaccid), then runs CPR via `switch_cpr(true)` and
prints a labelled `ok`/`FAIL` table:

```bash
node scripts/probe_resuscitation.mjs term_neonate_72h
node scripts/probe_resuscitation.mjs term_neonate_72h --cpr-seconds 60 --no-ans
```

It checks: the compression waveform sweeps 0 → `chest_comp_max_pres` → 0; the paused branch forces
`chest_comp_pres` to 0 (deterministic injection test — a natural pause is always entered at a
waveform zero-crossing, so the stale-pressure bug can only be exercised by injecting a value); mean
forward aortic-valve (`LV_AA`) flow under CPR rises well above the arrested baseline (compressions
actually drive circulation through `pres_ext`); exactly `vent_no` breaths are delivered per pause;
and a `switch_cpr` off→on re-toggle restarts a clean cycle. Like every probe here it is interactive
and **always exits 0** — read the table.

## References

- Neonatal resuscitation guidelines (ILCOR / ERC / AHA): compressions at 3:1 with ventilation, 120 events a minute.

````

### FILE: explain-engine/docs/ScenarioAliases.md

```markdown
# ScenarioAliases

`helpers/ScenarioAliases.js` maps the old names of renamed scenarios to their current names, so saved
links, lessons, user snapshots and patient-builder specs that still use an old name load the current
scenario instead of failing.

## Exports

| Export | Description |
|---|---|
| `SCENARIO_ALIASES` | `{ oldName: currentName }`. Currently `term_neonate` → `term_neonate_72h` (2026-10-26, when the transitional babies `term_neonate_1h` / `_12h` / `_24h` were added). |
| `resolveScenarioName(name)` | The current name for `name`, or `name` itself when it was never renamed. |

## Used by

- [Model](./ARCHITECTURE.md) `load(definition_name)`: resolves the name before fetching `/model_definitions/<name>.json` (logs the redirect).
- `scripts/build_patient.mjs`: resolves `spec.baseline` before reading the baseline file.

Scripts that read a scenario file by path (probes, generators) use the current names directly.

## Adding an alias

Rename the file in `model_definitions/`, update `index.json` and the references, and add the old name
here. Keep an alias for as long as published links or saved specs may use the old name.

```

### FILE: explain-engine/docs/Shunts.md

````markdown
# Shunts

`Shunts` sets the resistances of the cardiac and pulmonary shunt pathways other than the duct:
- the **foramen ovale** (FO), from its diameter: viscous Poiseuille loss plus a Bernoulli orifice loss, with an optional flap-valve asymmetry;
- the **ventricular septal defect** (VSD), the same way;
- the base resistance of the **intrapulmonary shunts** (IPSL, IPSR).

It also reports the shunt flows and velocities. The ductus arteriosus is [Pda](./Pda.md).

## Physiology

- **Foramen ovale.** In the fetus it carries oxygenated IVC blood from the right atrium into the left heart. After birth left-atrial pressure rises, and the flap closes against the septum, functionally at first. Most term newborns still have a small, mostly left-to-right patent foramen ovale (PFO) in the first days. When right-sided pressures rise (pulmonary hypertension), it can shunt right-to-left and cause desaturation.
- **VSD.** A hole in the ventricular septum. Flow through it is set by its size and by the pressure difference between the ventricles. A restrictive VSD keeps a high-velocity jet; a large one lets the ventricles equalise.
- **Intrapulmonary shunt.** Blood that crosses the lungs without meeting ventilated alveoli. Mostly it is venous admixture from perfused but unventilated lung (atelectasis, RDS, meconium, pneumonia); true anatomical channels are small in a normal lung, but can open in BPD, alveolar capillary dysplasia, CDH or meconium aspiration (Galambos). It is a major cause of hypoxaemia in lung disease.

## Inheritance

```
BaseModelClass
  └── Shunts
```

## Properties

### Config (set in the definition JSON)

| Property | Unit | Default | Description |
|---|---|---|---|
| `diameter_fo` | mm | 2.0 | Foramen ovale diameter; 0 = closed. term_neonate_72h 1.5. |
| `diameter_fo_max` | mm | 10.0 | Upper clamp. |
| `atrial_septal_width` | mm | 3.0 | Length of the FO channel in the Poiseuille law. |
| `fo_lr_factor` | – | 10.0 | Left-to-right resistance multiplier (flap valve). **1 in every shipped scenario.** |
| `fo_svc_fraction` | – | 0.5 | Share of the FO area opening onto the SVC half of the right atrium (`RASVC`); the rest opens onto `RAIVCI`. 0 in a fetus (crista dividens). |
| `discharge_coeff_fo` | – | 0.7 | Discharge coefficient of the FO orifice (between funnel and sharp edge). |
| `diameter_vsd` | mm | 2.0 | VSD diameter; 0 = closed (0 in every shipped scenario). |
| `diameter_vsd_max` | mm | 10.0 | Upper clamp. |
| `ventricular_septal_width` | mm | 5.0 | Length of the VSD channel. |
| `discharge_coeff_vsd` | – | 0.64 | Discharge coefficient of the VSD (sharp-edged hole). |
| `ips_res` | mmHg·s/L | 5000 | Base resistance of each intrapulmonary shunt resistor. term_neonate_72h 20 400; 10⁸ (closed) in a fetus. |

### Outputs

| Property | Unit | Description |
|---|---|---|
| `flow_fo` | L/s | FO flow, both paths together; positive = left-to-right. |
| `flow_vsd` | L/s | VSD flow; positive = LV to RV. |
| `res_fo`, `res_vsd` | mmHg·s/L | Viscous (Poiseuille) resistance of the whole orifice. |
| `bernoulli_b_fo`, `bernoulli_b_vsd` | mmHg·s²/L² | Orifice coefficient `B` (see [Orifice](./Orifice.md)). |
| `velocity_fo`, `velocity_vsd` | m/s | Mean velocity through the anatomic area (continuity). |
| `velocity_fo_doppler`, `velocity_vsd_doppler` | m/s | Jet velocity through the vena contracta, what Doppler measures. |

### Set by other models

| Property | Unit | Description |
|---|---|---|
| `viscosity` | cP | Read from the left atrium every step (it follows the haematocrit); 6.0 if no LA. |

## Calculation

Each step, after resolving its five resistors once (`LA_RAIVCI`, `LA_RASVC`, `VSD`, `IPSL`, `IPSR`; a missing one gives a single warning and the model skips):

1. **Gates.** A diameter of 0 sets the resistor's `no_flow`. An FO path whose area share is 0 is closed too.
2. **Resistances.** For each orifice of diameter `d` and length `L`:
   ```
   res = 8·η·L / (π·r⁴)                      Poiseuille, converted to mmHg·s/L
   B   = K_BERNOULLI / (Cd·π·r²)²            orifice loss, see Orifice
   ```
3. **Foramen ovale, split over two resistors.** The FO opens onto both halves of the right atrium, with area shares `a` (`fo_svc_fraction` and its complement). Each path gets
   ```
   r_back = res_fo / a + (B_fo / a²) · |Q_path,prev|        right → left
   r_for  = r_back · fo_lr_factor                           left → right
   ```
   so the two paths together behave exactly as one orifice of `diameter_fo`.
4. **VSD:** `r = res_vsd + B_vsd·|Q_prev|`, both directions.
5. **Intrapulmonary shunts:** `r_for = r_back = ips_res` on `IPSL` and `IPSR`.
6. **Outputs:** flows from the resistors, `velocity = Q / area`, `velocity_doppler = jet_velocity(B, Q)`.

**The Bernoulli term is linearised with the previous step's flow** (`B·|Q_prev|` added to the resistance), as in Pda. This is semi-implicit and stable for restrictive defects. It differs from the exact quadratic only by the flow's change in one 0.5 ms step (~1 % of the Bernoulli term in a pulsatile shunt). `Resistor.r_k` could solve the quadratic exactly, but it has a single coefficient for both directions, so it couldn't carry the flap's left-to-right factor.

## Factor system

None of its own. It writes the **base** `r_for`/`r_back` of its resistors every step. Other models modulate them through the resistors' layers:
- `Surfactant`: `IPSL`/`IPSR.r_factor_ps` (derecruitment);
- `Respiration`: `IPSL`/`IPSR.r_factor` (atelectasis and hypoxic vasoconstriction, non-persistent);
- the `Calibrator`: `IPSL`/`IPSR.r_factor_scaling_ps` and `ips_res`.

## Inputs and outputs

- **Reads:** `LA.viscosity`; the flows of its five resistors.
- **Writes:** `r_for`, `r_back`, `no_flow` of `LA_RAIVCI`, `LA_RASVC`, `VSD`; `r_for`, `r_back` of `IPSL`, `IPSR`.
- **Written by:** the user and scenario generators (diameters, `ips_res`); the `Calibrator` (`ips_res`).
- **Read by:** `Monitor` (`fo_flow`), `DataCollector` watchers, `scripts/probe_*` (Qp:Qs, Doppler).

## Assumptions and limitations

- **Echo-measured diameter, no flap.** All scenarios use `fo_lr_factor` 1: a diameter from an echo colour jet already reflects the flap's restriction. With 25, an FO was almost one-way (5 mm: Qp:Qs 0.99, Doppler 0.2 m/s). With 1, a 3 mm FO carries ~18 mL/kg/min (Qp:Qs 1.04, Doppler 0.66 m/s) and 5 mm ~32 mL/kg/min (Qp:Qs 1.14). Hiraishi 1991 finds a predominantly left-to-right PFO in most term newborns; Evans & Iyer 1994 a measurable Qp:Qs above ~3 mm.
- **The foramen is not the lever for the fetal ventricular split.** At fetal sizes `res_fo` is ~13× below the tricuspid valve's resistance, so the two ventricles draw on a common atrial pressure. 6 → 3 mm moves RV:LV by 0 points; only below 2 mm does it bite, and then violently (1 mm: 73:27). See [fetal_circulation](./fetal_circulation.md).
- **Absolute millimetres, not scaled.** `diameter_*` and the septal widths are set per scenario; no scaler touches them. Leaving `atrial_septal_width` at term thickness in a small body makes the foramen restrictive.
- **Intrapulmonary shunt behaviour.**
  - Pulmonary hypertension on its own shouldn't raise it: the hypoxaemia of PPHN comes from right-to-left flow across the duct and foramen, and in pulmonary vascular disease inert-gas studies find little shunt (Dantzker & Bower 1979).
  - Its vessels belong to the same bed, so a general change in pulmonary tone should move IPSL/IPSR with it; the builder's PVR lever does this.
  - The blunting of hypoxic vasoconstriction at very high pulmonary pressure (Benumof & Wahrenbrock 1975) isn't modelled.
- **References resolve once.** A resistor added or removed at runtime is not picked up.

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Shunts` (trimmed to the config props; `components` holds the five resistors):

```json
{
  "name": "Shunts",
  "model_type": "Shunts",
  "is_enabled": true,
  "diameter_fo": 1.5,
  "atrial_septal_width": 3,
  "fo_lr_factor": 1,
  "fo_svc_fraction": 0.5,
  "discharge_coeff_fo": 0.7,
  "diameter_vsd": 0,
  "ventricular_septal_width": 5,
  "discharge_coeff_vsd": 0.64,
  "ips_res": 20402.6
}
```

## Usage in the scenarios

One instance in every scenario. It owns `LA_RAIVCI`, `LA_RASVC` (LA → right-atrial halves), `VSD` (LV → RV), `IPSL` (`LL_ART` → `LL_VEN`) and `IPSR` (`RL_ART` → `RL_VEN`).

**term_neonate_72h calibration (2026-10):**
- **Foramen:** `diameter_fo` 1.5 mm, a small left-to-right PFO of ~6 mL/kg/min (Qp:Qs ~1.03). Basis: no PFO has closed by day 3 (He 2011), and neonatal CMR finds RV output a few mL/kg/min above LV output with the duct closed (Jhaveri 2023, Groves 2011). It also lets the scenario shunt right-to-left at atrial level when right-sided pressures rise. See `scripts/_fix_term_fo.mjs` and [TermNeonateReference](./TermNeonateReference.md).
- **Fetal scenarios:** `fo_svc_fraction` 0, the crista dividens. Before that, a third of the foramen flow came from the SVC half, and the aorta was only 0.9 saturation points above the pulmonary artery; with it the gap is 6.0 points (reference ~8). They also close the intrapulmonary shunts (`ips_res` 10⁸).

## References

- Hiraishi S, et al. *Heart* 1991. doi:10.1136/hrt.65.1.41 (PFO flow in term newborns).
- Evans N, Iyer P. *J Pediatr* 1994. doi:10.1016/s0022-3476(94)70079-6 (atrial shunting and Qp:Qs).
- Dantzker DR, Bower JS. *J Clin Invest* 1979, [jci.org/articles/view/109542](https://www.jci.org/articles/view/109542) (gas exchange in pulmonary vascular disease).
- Benumof JL, Wahrenbrock EA. *J Appl Physiol* 1975 (pulmonary vascular pressure and hypoxic vasoconstriction).
- Galambos C, et al. [PMC3960909](https://pmc.ncbi.nlm.nih.gov/articles/PMC3960909) (intrapulmonary arteriovenous anastomoses).

````

### FILE: explain-engine/docs/Sle6000.md

````markdown
# Sle6000

**Source:** [`device_models/Sle6000.js`](../device_models/Sle6000.js), settings table in
[`device_models/sle6000_params.js`](../device_models/sle6000_params.js)
**Model type:** `"Sle6000"`
**Inherits from:** [`Ventilator`](./Ventilator.md)

A model of the SLE6000 neonatal ventilator (SLE Ltd, instructions for use V2.0). It drives the generic
`Ventilator` through the device's own modes, settings, patient circuits and monitored values. The
manual is a copyrighted vendor document and is not in the repository. Page numbers below (pNN) refer
to it.

**Phase 1** covers the invasive conventional modes CPAP, CMV, PTV, PSV and SIMV, with volume
targeting (VTV). **Phase 2** adds the invasive oscillatory modes: HFOV, with VTV, sighs and
oscillation pause, and HFOV+CMV (see [HFO](#hfo-phase-2)). The closed-loop O2 controller
[OxyGenie](#oxygenie), with the SpO2 sensor, is in as well. These come in later phases:
- the non-invasive modes, including nHFOV
- alarms

## Using it in a scenario

The SLE6000 is the ventilator of every scenario up to 30 kg, the device's patient range of 0.3–30 kg
(manual). The adult scenarios (`adult_female`, `adult_female_uterus`) keep the generic `Ventilator`,
and the app shows no ventilator screen for them.

The scenario's ventilator block has `"model_type": "Sle6000"` and keeps the instance name
`"Ventilator"`. The Monitor, Resuscitation and every UI path read `models["Ventilator"]`, so they keep
working.

**Starting state:**
- **Off.** With `is_enabled` false the device loads in **Standby**, and `sle_apply` (or
  `sle_start`) starts it.
- **Ventilating.** A scenario that starts ventilated has `is_enabled` true, `sle_mode` and the
  `sle_*` settings. `init_model` then applies the mode.
  - Example: the CDH phenotypes and `pphn` start in CMV with `sle_rr`, `sle_ti`, `sle_peep`,
    `sle_pip` and `sle_o2`.
  - The switched-on circuit (`VENT_*` parts enabled, `MOUTH_DS` closed) is still written into the
    JSON, by the generators' `applyVentilator`.
  - Without `sle_mode`, the device shows whatever the generic settings are doing.

## Settings (device units)

Pressures are in mbar, as on the device. They are converted to cmH₂O (× 1.01972) when written to the
generic ventilator. The ranges, resolutions and defaults come from pp 163–169. `SLE_PARAMS` in
`sle6000_params.js` holds them, and the UI replica uses the same table.

| Property | Setting | Range | Resolution | Default |
|---|---|---|---|---|
| `sle_rr` | RR (BPM) | 1–150 | 1 | 30 |
| `sle_ti` | Ti / Ti Max (s) | 0.1–3.0 | 0.01 | 0.40 |
| `sle_peep` | PEEP / CPAP (mbar) | 0–35 | 0.5 below 10, then 1 | 4.0 |
| `sle_pip` | PIP / PIP Max (mbar) | 0–65 | 1 | 15 |
| `sle_rise` | Rise time (s) | 0–3.0 | 0.01 | 0.04 |
| `sle_trig_sens` | Trig Sens (l/min, flow) | 0.2–20 | 0.2 | 0.6 |
| `sle_term_sens` | Term Sens (% of peak flow) | 5–50 | 5 | 5 |
| `sle_rr_backup` | RR Backup, CPAP (BPM) | Off, 1–150 | 1 | Off (40 when switched on) |
| `sle_p_support` | P Support, SIMV (mbar) | Off, 0–65 | 1 | Off (8 when switched on) |
| `sle_vtv` | VTV target (ml) | Off, 1–300 | 0.2 / 1 / 5 | Off (3 when switched on) |
| `sle_o2` | O2 (%) | 21–100 | 1 | 21 |
| `sle_circuit` | Patient circuit (mm) | 10, 15 | – | 10 |

**Interlocks** (`sle_interlocks`):
- Ti leaves at least 0.1 s of expiration at the rate: RR, or RR Backup in CPAP.
- Rise time ≤ Ti.
- PEEP ≤ PIP.
- P Support ≤ PIP.

**Parameter memory.** Settings persist across modes (p124). The CPAP level in CPAP is the PEEP of
the other modes.

## Other properties

### Config

| Property | Unit | Default | Description |
|---|---|---|---|
| `sle_mode` | – | `"Standby"` | Standby, CPAP, CMV, PTV, PSV, SIMV, HFOV or HFOV+CMV. |
| `sle_o2_boost_inc` | % | 10 | O2 Boost increment (factory default, p128). |
| `sle_spo2_on` | boolean | `true` | SpO2 monitoring (p104). |
| `sle_spo2_target` | – | `"91-95"` | OxyGenie target range, one of `SLE_SPO2_TARGETS`. |
| `sle_spo2_avg` | s | 8 | SpO2 averaging time (3 s while OxyGenie is on). |
| `sle_oxy_high_o2` | % | 60 | "O2 > N %" message level while OxyGenie is on (p228). |
| `spo2_probe_attached` | boolean | `true` | The sensor is on the patient (an event: off gives no signal). |
| `oxy_kp`, `oxy_ki`, `oxy_kd` | % O2 per % SpO2, per %·s, per %/s | −1, −0.0125, −1 | OxyGenie PID gains (patent example embodiment). |

### Outputs

| Property | Unit | Description |
|---|---|---|
| `mon_dp`, `mon_dco2`, `mon_freq` | mbar, ml²/s, Hz | HFO monitored ΔP (peak to peak at the proximal airway), DCO2 (f · Vte², τ 3 cycles), frequency. |
| `o2_boost_remaining` | s | Time left of an O2 Boost. |
| `mon_spo2` | % or null | The ventilator's SpO2 (preductal, averaged; null = no valid signal). |
| `oxy_state` | – | OxyGenie state: `off`, `auto`, `fallback`, `override`. |
| `oxy_ref_o2` | % | Reference O2: the average requirement of the last hour. |
| `oxy_override_remaining` | s | Time left of a manual override. |
| `oxy_high_o2_flag` | boolean | "O2 > N %" shown. |

## `sle6000_params.js`

The device's settings table and helpers, shared with the UI replica:

| Export | Description |
|---|---|
| `SLE_PARAMS` | Per setting: range, resolution steps, default, unit (pp 163–169). |
| `SLE_MODES`, `SLE_MODE_NAMES`, `SLE_HFO_MODES` | Per mode the settings on the main and extra screens (and label overrides); the mode names; the oscillatory modes. |
| `SLE_SPO2_TARGETS`, `SLE_SPO2_AVG` | OxyGenie target ranges; SpO2 averaging times. |
| `sle_defaults()` | Default settings. |
| `sle_resolution(name, value)`, `sle_step(name, value, dir)` | Resolution at a value; the next value up or down. |
| `sle_clamp(name, value)` | Clamp to range and resolution. |
| `sle_format(name, value, decimals)` | Display string. |
| `sle_interlocks(settings, mode, changed)` | Apply the interlocks (Ti vs rate, rise ≤ Ti, PEEP ≤ PIP, …). |

## Inputs and outputs

- **Reads and writes:** everything [Ventilator](./Ventilator.md#inputs-and-outputs) does, through its settings; plus `AA.so2` (the SpO2 sensor); the O2 setting reaches the fresh gas through the generic `set_fio2`.
- **Written by:** the app's SLE6000 replica (`sle_apply`, `sle_set`, `sle_start`, `sle_standby`, …), the bot, Resuscitation (through the inherited generic API), the scenario generators (`applyVentilator`).
- **Read by:** the app's SLE6000 screens (`mon_*`, `oxy_*`), Monitor, `DataCollector` watchers.

## Control API

| Method | Effect |
|---|---|
| `sle_apply(settings)` | The device's preview → Confirm. Clamps and snaps each given setting, keeps the others, applies the interlocks, then starts or switches the mode. `settings` may hold any of the keys above without the `sle_` prefix, plus `mode` (`Standby`/`CPAP`/`CMV`/`PTV`/`PSV`/`SIMV`/`HFOV`/`HFOV+CMV`) and `circuit` (10/15). |
| `sle_set(name, value)` | `sle_apply({[name]: value})` |
| `sle_start(mode)` / `sle_standby()` | Start/Resume ventilation, by default in the last mode; Standby switches the ventilator off |
| `sle_manual_breath()` | One breath at the set PIP and Ti (p155); every mode but HFOV |
| `sle_sigh()` | HFOV Sigh: an oscillatory pause at Sigh P for Sigh Ti (p155) |
| `sle_osc_pause()` | HFOV Oscillation Pause: oscillation stops at MAP for up to 60 s, a second press cancels (p155). `hfo_pause_remaining` counts down |
| `sle_o2_boost(state)` | O2 Boost: set O2 + `sle_o2_boost_inc` (10 %) for 2 minutes, then back (p128). `o2_boost_remaining` counts down |
| `sle_set_circuit(d)` | 10 or 15 mm patient circuit |
| `sle_oxygenie(state)` | OxyGenie on/off (p119). On needs SpO2 monitoring and a running ventilator; it cancels an O2 Boost. See [OxyGenie](#oxygenie) |
| `sle_set_spo2(settings)` | Utilities → Sensors → SpO2 (p104): `on` (monitoring), `target` (`"90-94"`, `"91-95"`, `"92-96"`, `"94-98"`), `avg` (averaging time, s: 3 = 2–4, 5 = 4–6, 8, 10 … 16). Monitoring off switches OxyGenie off |
| `sle_spo2_monitoring(state)` / `sle_set_spo2_target(range)` | Single-setting forms of `sle_set_spo2`, for the bot and the model editor |
| `set_spo2_probe(attached)` | The sensor on or off the patient (an event, not a device setting). Off: no valid SpO2 |

Switching the ventilator off by any route (`switch_ventilator(false)`) is the device's Standby.

**Generic calls.** The generic `switch_ventilator(true)`, `set_pc`, `set_psv`, `set_simv`,
`set_cpap`, `set_vc`, `set_prvc` and `set_fio2` still work underneath. Resuscitation and the scripts use them.
- After each such call, `_sync_from_generic` mirrors the mode and the settings into `sle_mode` and
  `sle_*`, clamped to the device ranges. So the screen shows what the ventilator is doing, for
  example during CPR.
- `PC` maps to CMV, or to PTV when synchronised. `PS` maps to PSV.
- `set_hfov` maps to HFOV and `set_hfov_cmv` to HFOV+CMV.
- `set_vc` and `set_prvc` (the SLE6000 has neither) show as CMV, or PTV when synchronised, with
  VTV set to the tidal volume: the device's form of volume-targeted mandatory ventilation. This is
  display only; the generic ventilator keeps running VC/PRVC until the next `sle_apply`.
- A generic `set_fio2` (Resuscitation, scripts, the bot) moves the O2 control (`sle_o2`) with it
  and, like turning the O2 control, ends a running O2 Boost. The device's own O2 delivery (the O2
  control, O2 Boost, OxyGenie) goes through `_deliver_fio2`, which sets the fresh gas only, so a
  boost delivers above the set O2 without changing it.
- The next `sle_apply` drives the generic ventilator from the device settings again.

## Modes → generic ventilator

Every mode assumes a flow sensor at the tube (invasive). That means a flow trigger at `sle_trig_sens`
and flow-cycled support at `sle_term_sens`. The flow trigger has patient leak compensation up to
35 % (`leak_comp_max_perc`, §20.6.1 p127): a tube leak within that range doesn't auto-trigger, a
larger one does. PSV termination has the automatic leak compensation of §20.6.4: leak flows
up to 5 l/min or half the peak flow, while the leak is 10–50 %. Within that range a breath
cycles on flow, not Ti Max. See *Leak and the flow trigger* and *Leak and flow cycling* in
[Ventilator](./Ventilator.md).

| SLE mode | Generic mode | Notes |
|---|---|---|
| CPAP | `CPAP`, `backup_rate` = RR Backup | Backup and manual breaths at PIP / Ti (p16) |
| CMV | `PC`, not synchronised | Time-triggered, time-cycled (p16) |
| PTV | `PC`, synchronised (flow trigger) | Assist/control: every effort triggers a breath at PIP and Ti; RR covers apnoea (p17) |
| PSV | `PS`, `ps_cmh2o` = PIP − PEEP | Flow-cycled at Term Sens, Ti Max = Ti, RR covers apnoea (p17) |
| SIMV | `SIMV`, `ps_cmh2o` = P Support − PEEP | Assist window / mandatory breath point per window; P Support is an absolute level ≤ PIP (pp 18, 160) |

**VTV** (pp 70–78, 126):
- **On:** PIP becomes PIP Max, and the working pressure is servoed on Vte by the generic
  breath-to-breath trim (`pressure_regulated_volume_control`). A breath ends once it has delivered
  130 % of the target. The manual names this volume safety cut-off but gives no value, so 130 % is
  an assumption.
- **Off:** reverts to the set PIP, which the targeting never changes.
- **CPAP:** VTV is not applied to backup breaths in this phase.

## Patient circuits (p176)

| | BC6188 (10 mm) | BC6198 (15 mm) |
|---|---|---|
| Circuit compliance | 0.65 ml/cmH₂O | 1.07 ml/cmH₂O |
| Expiratory limb | 6 mbar/(l/s) | 2 mbar/(l/s) |
| Demand flow (`insp_flow`) | 20 l/min | 40 l/min |

**Compliance.** The manual gives the tubing compliance per metre: 1.89 and 3.72 ml/kPa/m. Over about
2.4 m of limbs that is 0.45 and 0.89 ml/cmH₂O. The humidifier chamber gas adds about 0.2 ml/cmH₂O.

**Expiratory limb.** The device has no expiratory valve (p24): PEEP is made by jets at the exhalation
block. So the expiratory resistance is only the limb's own, taken from the manual's pressure drops.

**Demand flow.** This is the cap of the demand valve, chosen so a 0.04 s rise is reachable. It is
**an assumption**: the manual gives no maximum flow.

## Monitored values (p175)

Filtered per breath as the manual describes. In CPAP a spontaneous breath closes out at each
inspiratory effort. In CMV, and in SIMV without P Support, the patient's breaths between ventilator
breaths are breaths of their own (Ventilator.md, *Unsupported spontaneous breaths*): they update Vte,
Vti, the leak and Vmin, and count in RR. The pressures, MAP, mechanics and timing come from the
ventilator breaths only.

| Property | Value | Filter |
|---|---|---|
| `mon_pip`, `mon_peep` | Peak and end-expiratory pressure (mbar) | per breath |
| `mon_map` | Mean airway pressure (mbar) | τ 5 breaths |
| `mon_vte`, `mon_vti` | Expired / inspired volume (ml) | τ 3 breaths |
| `mon_vmin` | Expired volume over the last 60 s (l/min) | sliding minute |
| `mon_leak`, `mon_leak_signed` | Leak (%): (ΣVti − ΣVte) / ΣVti over the last 5 breaths, so a breath out of step with the ventilator and the patient's breath after it cancel out. Filtered signed (`mon_leak_signed`) and clamped at 0 only for display: a window can read negative when the patient breathes out part of a ventilator breath in its own breaths, and clamping each window first turned that scatter into a phantom leak (5.4 % with no leak, now 0.4 %) | then τ 10 breaths |
| `mon_rr`, `mon_trig` | Total rate; patient-triggered breaths in the last 60 s | – |
| `mon_c` | Dynamic compliance (ml/mbar) | τ 3 breaths |
| `mon_r` | (PIP − PEEP) / peak expiratory flow (mbar/l/s) | τ 3 breaths |
| `mon_c20c` | C20/C | τ 3 breaths, `null` when not measurable |
| `mon_ti`, `mon_te`, `mon_ie` | Measured Ti, Te and Te/Ti (shown 1:x) | per breath |
| `mon_o2` | Oxygen cell (%) | first order, τ 15 s (45 s response, p176) |
| `mon_fg_flow` | Fresh gas flow through the demand valve (l/min) | τ 1 s |

**C20/C** is the compliance over the last 20 % of inspiration (between 80 % and 100 % of the set Ti)
divided by the whole-breath compliance: the overdistension index (Fisher et al. 1988). The manual
gives no formula.
- A pressure-limited breath holds its pressure over that stretch, so C20/C is only measurable when
  pressure still rises there (a slow rise, or a stiff lung). It is `null` otherwise.
- With the default 0.04 s rise it is usually `null`.

## HFO (phase 2)

The invasive oscillatory modes (pp 77–80, 125, 155, 160, 166). They run on the generic ventilator's
oscillator ([Ventilator → High-frequency oscillation](./Ventilator.md#high-frequency-oscillation-hfov_control)).

### Settings (p166)

| Property | Setting | Range | Resolution | Default |
|---|---|---|---|---|
| `sle_freq` | Frequency (Hz) | 3–20 | 0.1 | 10 |
| `sle_ie` | I:E (1:x) | 1:1, 1:2, 1:3 | list | 1:1 |
| `sle_map` | MAP (mbar), HFOV | 0–45 | 1 | 5 |
| `sle_dp` | ΔP / ΔP Max (mbar) | 4–180 | 1 | 4 |
| `sle_hfo_vtv` | VTV / Vte Target (ml), HFOV | Off, 0.2–50 | 0.1 below 2, 0.2 below 10, then 1 (p125) | Off (2 when switched on) |
| `sle_sigh_rr` | Sigh RR (BPM) | Off, 1–150 | 1 | Off (30 when switched on) |
| `sle_sigh_ti` | Sigh Ti (s) | 0.1–3.0 | 0.01 | 0.40 |
| `sle_sigh_p` | Sigh P (mbar) | 0–45 | 1 | 10 |
| `sle_hfo_activity` | HFO Activity, HFOV+CMV | Insp+Exp (0), Exp (1) | list | Insp+Exp |

**List settings.** The list-valued settings (`choices` in `SLE_PARAMS`, shown by `names`) step
through their list with +/−.

**Parameter memory.** The HFO VTV is a setting of its own (`sle_hfo_vtv`, 0.2–50 ml), so the
conventional `sle_vtv` keeps its value. HFOV+CMV uses the conventional RR, Ti, PEEP and PIP.

**Interlocks** (p78):
- Sigh Ti leaves at least 0.1 s at the Sigh RR. When Sigh RR is the setting just changed, Sigh RR
  gives way; otherwise Sigh Ti does.
- Raising MAP past Sigh P drags Sigh P up with it. Lowering MAP leaves Sigh P where it is.
- Sigh P can be set at most 15 mbar above MAP.

### Modes

| SLE mode | Generic mode | Notes |
|---|---|---|
| HFOV | `HFOV` | MAP, ΔP as the peak-to-peak amplitude, frequency, I:E 1:1 / 1:2 / 1:3 → `hfo_insp_fraction` 0.5 / 0.33 / 0.25 |
| HFOV + VTV | `HFOV`, `hfo_volume_guarantee` | ΔP becomes ΔP Max; the working ΔP is trimmed on the average Vte of each 0.5 s, not cycle by cycle (p125) |
| HFOV+CMV | `HFOV_CMV` | CMV breaths (RR, Ti, PEEP, PIP, rise) with the oscillation at ΔP and frequency in both phases, or in expiration only (HFO Activity) |

- **Bias flow.** 8 l/min, the device's continuous flow (p24); in HFO this is an assumption.
- **I:E in HFOV+CMV.** HFOV+CMV has no I:E setting; 1:1 is assumed.
- **Manual Breath.** HFOV has none (its button is Sigh). HFOV+CMV keeps Manual Breath.
- **Sigh.** `sle_sigh` and `sle_sigh_rr` hold the circuit at Sigh P for Sigh Ti.
- **Oscillation Pause.** It holds the circuit at MAP; it does not combine with a sigh.

### Monitored values in HFO (p175)

Per oscillation instead of per breath:
- `mon_vte` / `mon_vti`: τ 3 cycles.
- `mon_dco2`: DCO2 = f·Vte² (ml²/s), τ 3 cycles.
- `mon_map`: τ 5. In HFOV+CMV it is the per-breath mean instead.
- `mon_dp`: measured ΔP, the peak-to-peak pressure.
- `mon_freq`.
- `mon_vmin`: Vte·f.
- `mon_leak`.
- `mon_c` = Vte / ΔP.
- `mon_r` = ΔP / peak flow.
- `mon_ie`: the set 1:x in HFOV; the measured Te/Ti of the breath in HFOV+CMV.

**Measured vs set ΔP** (p125). The measured ΔP is the proximal peak-to-peak. On the device it can
be lower than the set ΔP; here the servo holds the circuit pressure, so it matches the set one.

**Screen layout.** The vendor screenshot of the HFOV screen (brochure) shows, in the double column:
- O2
- ΔP
- I:E and MAP
- Vmin, Vte, DCO2 and Leak
- R and C

## Airway events

The generic [Ventilator](./Ventilator.md#airway-events) supplies right mainstem intubation,
accidental extubation and circuit disconnection, and Standby ends them. There are no alarms yet, so
they show up in the monitored values (Vte, leak, C, pressures), the waveforms and the patient
monitor.

## OxyGenie

OxyGenie is the SLE6000's optional closed-loop O2 controller (manual chapter 19, pp 118–121). It keeps
the SpO2 inside a target range by setting the O2 once a second. The algorithm is the adaptive PID
controller developed in Hobart by Gale and Dargaville (University of Tasmania and Royal Hobart Hospital,
the VDL1.x algorithm), licensed to SLE in 2018. The constants below come from the example embodiment of
the patent and the device behaviour from the manual.

**Sources:**
- Patent US11135384B2, *Method, apparatus and system for automatically controlling inspired oxygen
  delivery* (Gale TJ, Dargaville PA; University of Tasmania; priority 2015).
- Dargaville PA et al. *Development and preclinical testing of an adaptive algorithm for automated
  control of inspired oxygen in the preterm infant.* Arch Dis Child Fetal Neonatal Ed 2017;102:F31–F36.
- Plottier GK et al. *Clinical evaluation of a novel adaptive algorithm for automated control of
  oxygen therapy in preterm infants on non-invasive respiratory support.* Arch Dis Child Fetal
  Neonatal Ed 2017;102:F37–F43.
- Sturrock S et al. *A randomised crossover trial of closed loop automated oxygen control in preterm,
  ventilated infants.* Acta Paediatr 2020 (OxyGenie on the SLE6000).

### The SpO2 sensor

- `mon_spo2` is the ventilator's own reading: the preductal saturation (`AA.so2`, the patient
  monitor's `sao2_pre`), read once a second (the blood gases update at 1 Hz) and averaged over the
  averaging time (`sle_spo2_avg`, default 8 s, p104). While OxyGenie is on the averaging is fixed at
  2–4 s (3 s here, p120).
- It is `null`, no valid signal, when SpO2 monitoring is off (`sle_spo2_on`) or the probe is off the
  patient (`spo2_probe_attached`).
- The simulated SpO2 has no noise, artefact or pleth/SIQ signal.

### States (`oxy_state`, pp 118–119)

| State | Screen | Behaviour |
|---|---|---|
| `off` | no status box | The O2 control is the user's setting |
| `auto` | "Auto" | The controller sets the O2 every second. The O2 control (`sle_o2`) shows the delivered value, in 0.5 % steps |
| `fallback` | "Waiting for signal", O2 `---` | No valid SpO2. First 60 s: hold the O2. Then, by the last valid reading: in the range, hold; above it, move down towards the reference O2; below it, move up towards it. A valid reading resumes Auto at once |
| `override` | "Manual Override" + countdown, blue | Touching O2 (any `sle_apply` that carries `o2`) delivers the user's O2 for 30 s (`oxy_override_remaining`); it cannot be cancelled. Then Auto resumes from that O2 |

Switching off (`sle_oxygenie(false)`, SpO2 monitoring off, Standby) leaves the O2 control at the last
delivered value. O2 Boost is refused while OxyGenie is on (p121).

### The controller (patent, example embodiment)

Every second, with the error `e = SpO2 − midpoint` of the target range (`sle_spo2_target`, 91–95 %
by default, so 93 %):

```
O2 = round_0.5( clamp( ref + clamp(P + I + D, ±40), 21, 100 ) )     ref = min(oxy_ref_o2, 60)
```

- **P** = `Kp · adapt · Kpfm · max(e, −13)`, with `Kp = −1` (% O2 per % SpO2).
  - `max(e, −13)`: the error is capped below, as SpO2 is unreliable low.
  - `Kpfm`, target-range attenuation: ×0.25 within 1 % of the midpoint, ×0.5 within 2 %, else ×1.
  - `adapt`, lung-severity adaptation: ×0.5 at a reference O2 of 21 % rising linearly to ×1.0 at
    40 %. A stiffer lung (higher O2 requirement) has a flatter SpO2 response to O2, so it gets more
    gain.
- **I** = `Ki · Σe`, `Ki = −0.0125` (% O2 per %·s).
  - Severinghaus compensation: while the integral term still holds the O2 up (I > 0) a positive
    error is multiplied by the steepness of the PaO2–SpO2 curve, so a hyperoxic infant is weaned
    fast. The multipliers (patent Table 2):

    | SpO2 % | ≤ 91 | 92 | 93 | 94 | 95 | 96 | 97 | 98 | 99 | 100 |
    |---|---|---|---|---|---|---|---|---|---|---|
    | × | 1 | 1.2 | 1.4 | 1.7 | 2.2 | 2.9 | 4.4 | 7.9 | 20.1 | 50 |

    The compensation stops when the integral term reaches zero.
  - At room air a positive error is not accumulated (there is nothing left to wean).
  - Anti-windup: |I| ≤ 40 %.
- **D** = `Kd · slope`, `Kd = −1`, the least-squares slope of the last 5 readings (%/s). It is zero
  while the SpO2 falls from above the target range (all 5 readings above it).
- **Reference O2** (`oxy_ref_o2`): starts at the O2 set when OxyGenie is switched on (the manual asks
  for an appropriate O2 before activation, p38), then every 30 minutes becomes the average delivered
  O2 of the last hour, by at most 10 % per update (p118). The integrand absorbs a change, so the O2
  does not jump. For the ±40 % limit the reference is capped at 60 %, so the O2 can always reach 21 %.
- **Bumpless restart:** at the end of an override and when the signal returns, the integrand is set
  so that the output equals the O2 delivered at that moment.
- **"O2 > N %"** (`oxy_high_o2_flag`, p228): set when Auto has delivered more than `sle_oxy_high_o2`
  (default 60 %) for 10 s, the default SpO2 alarm delay. There is no alarm system yet; the screen
  shows it as a message.

The gains are plain properties (`oxy_kp`, `oxy_ki`, `oxy_kd`), not device settings.

### Behaviour in the model

`scripts/probe_oxygenie.mjs` (CMV, apnoeic patient):

| Case | Result |
|---|---|
| preterm_26wk on air, SpO2 ≈ 70 % | O2 41 % after 60 s; SpO2 91.8 % after 10 min (O2 ≈ 53 %), never above 92 % |
| term_neonate_72h on 60 %, SpO2 ≈ 100 % | weaned to 21 % in about 8 min, SpO2 never below 97.9 % |

The O2 → SpO2 response of the model is slow and flat in shunt-dominated disease: right-lung
atelectasis needs ≈ 50 % O2 for 94 % with 60 % collapse. The SpO2 time constant after an O2 step is
about 30 s (alveolar wash-in plus circulation). So the closed loop responds through its integral term
over minutes, not the 19–20 s response time of the manual's test conditions (p169).

### Not modelled

From the patent: the self-tuning of Kp every 30 min (the hyperoxia/hypoxia time ratio), the Kp
boosts after a respiratory pause or a CPAP pressure loss, the transient O2 rise in apnoea, and the
signal validation (pleth shape, perfusion index, HR match). The patent derives the reference O2 from
a V/Q–shunt estimate it does not specify; the manual describes it as the average requirement of the
last hour, which is what is modelled. The 10 % reference rate limit is taken as 10 percentage points
(the patent does not say whether it is relative). The speed of the fallback drift ("slowly", p119) is
not given; it is 1 % per 30 s here. O2 Suction (p127) is not modelled, so its OxyGenie interlock
isn't either.

## Not modelled yet, and assumptions

- **Pressure response (12 ms).**
  - The delivered pressure follows its target with a first-order response,
    `pres_response_tau = 0.012 s` (`PRES_RESPONSE_TAU` in `Sle6000.js`). This applies to the PEEP
    to PIP ramp, the fall back to PEEP, and CPAP.
  - On the device, pressure is made by the jets at the exhalation block and read at the Y-piece
    past the limbs, with a pressure loop of finite speed. The base `Ventilator` without it is
    ideal: it holds the circuit on target within a step and drops to PEEP in about 16 ms. That
    makes the PV loop box-shaped.
  - The manual gives no figure. The value is calibrated on a reference PV loop of a healthy 3.5 kg
    neonate on 14/4 (term_neonate_72h, CMV 14/4, Ti 0.4 s, breathing off):

    | | ideal, Rise 0.04 | 12 ms, Rise 0.1 | reference |
    |---|---|---|---|
    | volume in at 90 % of PIP | 11 % | 24 % | ≈ 26 % |
    | volume left when back at PEEP + 10 % | 93 % | 84 % | ≈ 84 % |
    | Vt | 33.2 ml | 32.1 ml | 38 ml (its compliance ≈ 1.07 ml/cmH2O/kg against the model's 1.0) |

- **Rise time.**
  - The scenarios start with Rise **0.1 s** (`"sle_rise": 0.1`, a usual clinical starting value
    for a term neonate). The device's factory default of 0.04 s (p165) stays in `SLE_PARAMS`.
  - Together with the pressure response it brings the ventilated scenarios' PaCO2 up about
    1 mmHg: cdh_severe 63.8, cdh_moderate 51.7, cdh_lv_dysfunction 52.9, pphn 46.2.

- **Pneumatics.** The device's valveless jet principle (forward and reverse jets, p158) is
  approximated by the generic demand servo with an open expiratory limb. That reproduces the
  pressure waveforms, not the jet flows. The 8 l/min continuous flow (p24) is not modelled.
- **RR Backup outside CPAP.** The manual shows an RR Backup tile in PTV/PSV/SIMV. Here the RR of
  those modes covers apnoea, so that tile is not modelled.
- **Missing manual numbers.** The manual gives no VTV step size or gain, no VTV safety limit and no
  internal compliance. The model uses the generic ventilator's trim (½ of the error per breath, at
  most 3 cmH₂O) and a 130 % limit.
- **Pressure trigger.** The non-invasive modes and use without a flow sensor need one; it is not
  modelled. Inspiratory hold and Sigh Hold are not modelled either.
- **HFO.** The following are not modelled:
  - leak compensation (35 %, p125)
  - the frequency ↔ Vte target link (press and hold, p78)
  - Sigh Hold, with the 5/10 s user preference
  - the jet details of the HFO module (p158)

## Verification

`node scripts/probe_oxygenie.mjs` runs pass/fail checks of OxyGenie: titration of a hypoxaemic
preterm into the range, weaning a hyperoxic term neonate to air, the manual override and its bumpless
restart, the fallback hold and drift, the "O2 > N %" flag and the interlocks.

`node scripts/probe_sle6000.mjs` runs pass/fail checks on `term_neonate_72h`: 90 pass, 0 fail (2026-10-24, re-validation). Two earlier failures were resolved then:
- **PSV leak:** the 72 h term_neonate_72h breathes in for ~0.7 s, longer than the case's Ti Max of 0.6 s, so every breath ran to Ti Max even without a leak. The case now uses Ti Max 1.0 s and compares mean Ti (no leak 0.63 s; 0.8 mm uncompensated +0.20 s; compensated within 0.01 s of no leak).
- **CMV phantom leak:** see `mon_leak` below; the display used to read 5–6 % with no leak.

The checks:
- settings validation and interlocks
- CMV pressures, timing and monitored values
- PTV and PSV triggering
- PSV Term Sens cycling
- SIMV breaths per window
- VTV convergence and switch-off
- CPAP backup rate
- O2 Boost
- the 15 mm circuit
- HFOV:
  - MAP, ΔP, frequency, DCO2 and I:E delivered
  - VTV convergence and switch-off
  - setting clamps
- Sigh, Oscillation Pause (hold, countdown and cancel), Sigh RR and the Sigh interlocks
- HFOV+CMV:
  - rate
  - oscillation in both phases, and the Exp-only HFO Activity
  - breath MAP
  - manual breath
  - the way back to CMV

````

### FILE: explain-engine/docs/Surfactant.md

````markdown
# Surfactant

`Surfactant` turns the preterm lung's respiratory distress syndrome (RDS) into a dynamic, treatable process. The fraction of open alveoli rises and falls with the mean distending pressure, with hysteresis (recruitment above an opening threshold, derecruitment below a closing one). Giving surfactant lowers both thresholds, so the same CPAP or PEEP now opens the lung. The open fraction drives the lungs' compliance and FRC, the gas-exchange surface and the intrapulmonary shunt. It holds no compartment, and it is **neutral at rest**: a scenario keeps its calibrated operating point until PEEP changes or surfactant is given.

## Physiology

Surfactant lowers the surface tension in the alveoli. Without it, as in a preterm infant before ~34 weeks, small alveoli collapse at end-expiration:
- the lung is stiff and its functional residual capacity (FRC) low;
- blood flows past collapsed alveoli unoxygenated;
- the infant needs pressure (CPAP, PEEP) to keep the lung open.

A collapsed region reopens only above its opening pressure and recollapses below a lower closing pressure. Between the two, it holds. This hysteresis is why a recruited lung stays open on less pressure than it took to open it.

Exogenous surfactant, instilled into the trachea, works within minutes: compliance improves, FRC rises, oxygenation improves and the needed FiO2 falls. It doesn't change the lung's structural immaturity.

## Inheritance

```
BaseModelClass
  └── Surfactant
```

## Properties

### Config (set in the definition JSON)

| Property | Unit | Default | Description |
|---|---|---|---|
| `surfactant_running` | boolean | `true` | Master switch. Off releases every effect to 1 once, then idles. |
| `lung_models` | list | `["ALL", "ALR"]` | Alveolar compartments. |
| `gasex_models` | list | `["GASEX_LL", "GASEX_RL"]` | Gas exchangers. |
| `shunt_models` | list | `["IPSL", "IPSR"]` | Intrapulmonary shunt resistors. |
| `surfactant` | 0–1 | 0.3 | Surfactant maturity: 0 = severe deficiency, 1 = mature or fully treated. |
| `surfactant_target` | 0–1 or null | null | Therapy target the maturity ramps toward; null holds it. Set by `administer_surfactant`. |
| `surfactant_tc` | s | 180 | Ramp time constant of the therapy response. |
| `open_margin`, `close_margin` | mmHg | 2, 2 | Half-widths of the dead zone above and below the baseline pressure. |
| `surf_open_gain`, `surf_close_gain` | mmHg per unit | 14, 12 | Fall of the opening and closing thresholds per unit rise in maturity. |
| `k_open`, `k_close` | 1/(mmHg·s) | 0.5, 0.5 | Recruitment and derecruitment rates. |
| `pres_tc` | s | 4 | Smoothing of the transpulmonary pressure (averages out tidal swings). |
| `el_gain`, `uvol_gain`, `dif_gain`, `ips_gain` | per unit `r` | 0.7, 1.5, 2.0, 6.0 | Effect gains (see [Calculation](#calculation)). |
| `el_factor_min`, `el_factor_max`, `uvol_factor_min`, `uvol_factor_max`, `dif_factor_min`, `dif_factor_max`, `ips_factor_min`, `ips_factor_max` | – | 0.2/3, 0.3/3, 0.1/5, 0.1/30 | Clamps on the effect factors. |

### Baseline (captured, saved with the state)

| Property | Unit | Description |
|---|---|---|
| `baseline_captured` | boolean | The baseline has been captured (30 s after a fresh build). |
| `baseline_ptp` | mmHg | P0: the smoothed transpulmonary pressure at capture. |
| `baseline_open_fraction` | 0–1 | f0: the open fraction at capture, the neutral reference. |
| `baseline_surfactant` | 0–1 | surf0: the maturity at capture. |

### Outputs

| Property | Unit | Description |
|---|---|---|
| `open_fraction` | 0–1 | Fraction of open alveoli (0.5 in every scenario at build). |
| `transpulmonary_pressure` | mmHg | Smoothed mean alveolar recoil pressure (`pres_in` of the lungs). |
| `open_pressure`, `close_pressure` | mmHg | Current opening and closing thresholds. |
| `el_lung_factor`, `uvol_lung_factor`, `dif_factor`, `ips_factor` | – | Applied effect factors. |

## Calculation

Each step:

1. **Therapy:** `surfactant += dt/surfactant_tc · (surfactant_target − surfactant)` while a target is set.
2. **Pressure:** the lungs' mean `pres_in`, smoothed over `pres_tc`.
3. **Baseline** (once, 30 s after a fresh build): P0, f0 and surf0 are captured. A loaded state that already has `baseline_captured` keeps its own.
4. **Thresholds**, centred on the scenario's own baseline:
   ```
   TOP = P0 + open_margin  − surf_open_gain  · (surfactant − surf0)
   TCP = P0 − close_margin − surf_close_gain · (surfactant − surf0)
   ```
   At baseline P0 sits inside the dead zone, so any scenario is neutral without per-scenario tuning.
5. **Recruitment** (after the baseline is captured):
   ```
   d open / dt = k_open · max(0, P − TOP) · (1 − open)  −  k_close · max(0, TCP − P) · open
   ```
6. **Effects**, with `r = open_fraction − f0` (1.0 at baseline), each clamped:
   ```
   el_lung_factor   = 1 − el_gain · r      → ALL/ALR.el_base_factor     (stiffer when derecruited)
   uvol_lung_factor = 1 + uvol_gain · r    → ALL/ALR.u_vol_factor       (FRC)
   dif_factor       = 1 + dif_gain · r     → GASEX_*.dif_o2/co2_factor  (exchange surface)
   ips_factor       = 1 + ips_gain · r     → IPSL/IPSR.r_factor_ps      (less shunt when recruited)
   ```

`administer_surfactant(target = 1.0)` sets `surfactant_target` (clamped 0–1); it is callable through `callModelFunction` or the TaskScheduler.

**Example** (the since-removed preterm_25wk, surfactant given): after 15 min the open fraction is 1.0, `el_lung_factor` 0.65, `ips_factor` 4. SaO2 rises 90.9 → 97.8 %, PaO2 55 → 89 and PaCO2 falls 48 → 43 mmHg; left alveolar volume 7.1 → 11.4 mL.

## Factor system

| Target | Layer | Note |
|---|---|---|
| lungs | `el_base_factor`, `u_vol_factor` (non-persistent) | rewritten every step; composes with Respiration's `*_factor_ps` |
| gas exchangers | `dif_o2_factor`, `dif_co2_factor` (non-persistent) | |
| IPSL, IPSR | `r_factor_ps` (persistent) | owned by Surfactant; reset to 1 on switch-off |

## Inputs and outputs

- **Reads:** the lungs' `pres_in`.
- **Writes:** the layers above.
- **Written by:** the user and the bot (`administer_surfactant`, `surfactant_running`, `surfactant`); the scenario generators.
- **Read by:** Respiration's atelectasis perfusion (computes against IPSL/IPSR's `r_factor_ps`); `DataCollector` watchers.

## Assumptions and limitations

- **Whole-lung, one open fraction.** No regional or gravity-dependent collapse; both lungs share one state. [Respiration](./Respiration.md#atelectasis)'s per-lung atelectasis runs independently, and their effects add.
- **Relative to the baseline.** Effects are deviations from the open fraction at capture (0.5 in every scenario), so the scenario's static RDS phenotype stays its baked values plus these deviations.
- **Calibrated for a low operating pressure.** A spontaneously breathing preterm runs at a mean transpulmonary pressure of ~1–3 mmHg, so the margins are small and the surfactant gains large: a dose must pull the opening threshold clearly below the prevailing pressure to recruit.
- **No surfactant kinetics.** Maturity only ramps toward the target. There is no inactivation (meconium, protein leak), no redosing decay, no effect on the airway.
- **The first 30 s of a fresh build** hold the open fraction while the baseline is captured.

## Example definition (JSON)

From the removed `preterm_25wk.json` (no shipped scenario has a Surfactant model), `models.Surfactant` (trimmed to the config props):

```json
{
  "name": "Surfactant",
  "model_type": "Surfactant",
  "is_enabled": true,
  "surfactant_running": true,
  "lung_models": ["ALL", "ALR"],
  "gasex_models": ["GASEX_LL", "GASEX_RL"],
  "shunt_models": ["IPSL", "IPSR"],
  "surfactant": 0.2,
  "surfactant_target": null,
  "surfactant_tc": 180,
  "open_margin": 2,
  "close_margin": 2,
  "surf_open_gain": 14,
  "surf_close_gain": 12,
  "k_open": 0.5,
  "k_close": 0.5,
  "pres_tc": 4,
  "el_gain": 0.7,
  "uvol_gain": 1.5,
  "dif_gain": 2,
  "ips_gain": 6
}
```

## Usage in the scenarios

In no shipped scenario at present: the three preterm scenarios that had it (`surfactant` 0.2–0.3) were removed on 2026-10-25 to be rebuilt. `scripts/_add_surfactant.mjs` adds it to a scenario.

## References

No literature values; the gains and thresholds are calibrated on the (since-removed) preterm scenarios' response to CPAP and surfactant.

````

### FILE: explain-engine/docs/TESTING.md

````markdown
# Testing

How to exercise and verify the Explain engine **headlessly** — build a scenario, drive the step loop, and read model state directly from Node, without a browser, a Web Worker, or the Vue layer. This is the workflow used for physiological calibration and model-development verification. The tools here are the `scripts/*.mjs` files; this doc explains the shared harness they sit on, the canonical probe pattern, and the full inventory. See [ARCHITECTURE](./ARCHITECTURE.md) for the two-thread picture and the `{type, message, payload}` wire protocol these scripts reuse.

> **Everything you need is in this repo, with no install step.** The tools are the `scripts/*.mjs`
> files at this repo's root, beside the engine source they drive. They `import` the engine
> **read-only** — they never modify engine source — and run with **`node` directly**:
>
> ```bash
> git clone git@github.com:explain-labs/explain-engine.git && cd explain-engine
> node scripts/probe_vitals.mjs term_neonate_72h   # no npm install needed
> ```
>
> This repo has **zero dependencies and zero devDependencies**, so a bare clone runs a full
> calibrated simulation immediately. There is **no `npm test`** and no CI suite — `package.json`
> wires one convenience script (`probe`). These are interactive verification tools you run by hand.

## The headless harness

`scripts/_harness.mjs` exports a single function, `createEngine({ verbose })`, that boots the engine in plain Node and returns a small driver object:

```js
import { createEngine } from "./_harness.mjs";
const eng = await createEngine();           // pass { verbose: true } to see engine logs
const model = eng.build(def);               // build a model_definition, get the live model by reference
eng.calc(60);                               // run 60 sim-seconds synchronously
console.log(model.models.Heart.heart_rate); // state is final and readable immediately
```

| Member | What it does |
|---|---|
| `send(type, message, payload)` | Raw envelope dispatch — `self.onmessage({ data: { type, message, payload } })`. The same `{type, message, payload}` envelope [`Model.js`](../Model.js) posts over the wire (see [ARCHITECTURE](./ARCHITECTURE.md)). |
| `build(def)` | `send("POST", "build", def)` then `send("GET", "state", [])`; returns the live `model` handle (by reference). `def` is a `model_definition` object. |
| `calc(seconds)` | `send("POST", "calc", seconds)` — runs `seconds / modeling_stepsize` steps **synchronously**. |
| `scale(group, factor)` | `send("POST", "scale", { group, factor })` — routes to `ModelEngine.scale_model`. |
| `get model` | The captured live `model` object (same reference `build` returned, or `null` before build). |
| `log` | The original `console.log` (the harness silences `console.log` unless `verbose`), for callers that want to restore output. |

### The zero-engine-edit shim trick

[`ModelEngine.js`](../ModelEngine.js) is a **Web-Worker module**: its only entry point is `self.onmessage`, and it replies via `postMessage`. Neither global exists in plain Node. The harness fabricates them **before** importing the engine, so the engine loads unmodified:

1. **ESM resolve hook.** The engine uses Vite-style **extensionless** relative imports (e.g. `import ... from "./ModelIndex"`), which Node's ESM resolver rejects. `scripts/resolve-extensionless.mjs` is a resolve hook that catches a failed relative-specifier import and retries it with a `.js` suffix. The harness registers it first: `register("./resolve-extensionless.mjs", import.meta.url)`.
2. **Global shims, installed BEFORE the engine import.** `globalThis.self = globalThis`, and `globalThis.postMessage = (msg) => {…}` — the fake `postMessage` captures the engine's replies: a `state` message stashes the live `model` (`liveModel = msg.payload`, **by reference, not a clone**), and `error` / `status ERROR` messages are forwarded to `console.error`.
3. **Import the engine.** `await import("../ModelEngine.js")` runs the module body, which registers `self.onmessage` on the shimmed global.
4. **Drive it** through the same envelope the real worker uses: `send("POST", "build", def)`, `send("GET", "state", [])` to grab the live `model`, `send("POST", "calc", seconds)` to step.

Because `calc` runs the step loop **fully synchronously** (no `setInterval`, no realtime batching), model state is final and directly readable the instant `calc` returns — that is what makes deterministic, assertion-style probing possible.

### `headless.mjs` — the standalone calibration panel

`scripts/headless.mjs` is the original standalone harness (the harness shim was later extracted from it into `_harness.mjs`). It boots the engine the same way but is specialized as a **renal + hormonal calibration panel**: it builds a scenario, freezes the ANS by default (calibration protocol), and cycle-averages a Kidneys / Hormones read-out.

```
node scripts/headless.mjs <scenario> [--seconds N] [--window W] [--no-ans] [--no-autoreg] [--verbose]
```

`<scenario>` is a filename in `model_definitions/` without `.json`. It supports live-tuning overrides on the Kidneys/Hormones models (`--kf`, `--water`, `--frac na=…,k=…`, `--hset key=val,…`) and a perturbation phase (`--bleed FRAC`, `--naload DELTA`, `--phase2 S`), printing a JSON report to stdout (diagnostics to stderr).

## Writing/running a probe

A probe is a self-contained `.mjs` that boots the engine, runs a scripted physiological scenario, and prints a human-readable verdict. The shared shape (canonically in `scripts/probe_vitals.mjs`):

1. **Boot** — register the resolve hook, install the `self`/`postMessage` shims, `await import("../ModelEngine.js")`, define `send`. (Probes predating `_harness.mjs` inline this; newer ones import `createEngine`.)
2. **Build** — read `model_definitions/<scenario>.json`, unwrap `json.model_definition || json`, `send("POST","build",def)`, `send("GET","state",[])`, capture `model`. A build failure exits `1`.
3. **Isolate (optional)** — disable the system that would mask the one under test, typically the baroreflex: `if (model.models.Ans) model.models.Ans.is_enabled = false`. (`probe_vitals.mjs` keeps the ANS **on** — its target is the *regulated* operating point — and exposes `--no-ans` to turn it off.)
4. **Warm to steady state** — one big synchronous `send("POST","calc",SECONDS)` (default 60–120 s) to clear startup transients.
5. **Measure** — a slice-loop that advances the sim in small steps and cycle-averages the pulsatile signals so beat-to-beat ripple cancels:

   ```js
   const SLICE = 0.02;                  // 20 ms, sub-cardiac-cycle
   const N = Math.round(WINDOW / SLICE);
   for (let i = 0; i < N; i++) {
     send("POST", "calc", SLICE);
     add("map", M.minmax?.abp_pre_pres_mean);  // read off the live Monitor / component models
     // …
   }
   for (const k in acc) acc[k] /= N;
   ```

   The systemic and pulmonary arterial means (`map`, `pap_m`) are the clinical estimate diastolic + pulse pressure / 3, as in the reference literature; the Monitor publishes them that way (`Monitor.arterial_mean_targets`). The model's central arterial waveforms have a form factor (mean − diastolic) / pulse pressure of about 0.5, so their time-averaged means, reported as `map_int` and `pap_m_int`, are higher (about 5–7 mmHg systemic). CVP stays time-averaged. The builder aims the baroreflex set-point, which senses the time-averaged arch pressure, at the time-averaged equivalent of its MAP target.

   Reads come off the live [Monitor](./Monitor.md) (hemodynamics: `heart_rate`, `minmax.*`, `flows.*`, `sao2_*`, `etco2`, `temp`) and component models (e.g. `AA` for the arterial blood gas, `IVCI` for a mixed-venous proxy, `Pda.flow_pa` for the ductal shunt).
6. **Perturb (optional)** — apply an insult between phases (e.g. remove a volume fraction from every blood compartment for a haemorrhage, then `calc` again and re-measure) to compare baseline vs perturbed.
7. **Report** — print a labelled table with normal-range flags (`ok` / `LOW` / `HIGH`).

`probe_vitals.mjs` is the canonical example: it reports HR, ABP (sys/dia/mean), CVP, PAP, CO/RV-output, cardiac index, SpO2 (pre/post-ductal), PDA shunt, SvO2, RR, etCO2, temperature, and a full arterial blood gas, each flagged against a `RANGES` table selected by `--profile adult|neonate|neonate_1h|neonate_12h|neonate_24h|preterm_24|…|preterm_36` (auto-picked from body weight when omitted; a term baby under 6 h old gets `neonate_1h`, one from 6 to under 18 h `neonate_12h` and one from 18 to under 48 h `neonate_24h`, the ranges of the transition references). The measurement loop, the `RANGES` tables, and `selectProfile()`/`flagOf()` are shared via `scripts/_probe.mjs` so the generic builder (`build_patient.mjs`) measures identically.

### Run examples

```bash
node scripts/probe_vitals.mjs term_neonate_72h
node scripts/probe_vitals.mjs term_neonate_72h --no-ans --seconds 90
node scripts/probe_brain.mjs --scenario term_neonate_72h --bleed 0.3
node scripts/probe_pda.mjs <scenario with an open duct> --beats 6
```

Common flags seen across the vitals/brain/pda probes: `--seconds N` (warm-up), `--window W` (averaging window), `--verbose` (un-silence engine logs), `--no-ans` (freeze the baroreflex). Scenario-specific probes add their own (e.g. `probe_brain.mjs` `--bleed`/`--edema`/`--scenario`, `probe_pda.mjs` `--beats`/`--trace`). Confirm a probe's flags by reading its header comment — each script documents its own `Usage:` line.

## Important: probes are not CI gates

Probes are **interactive verification tools, not pass/fail test cases.** They print verdicts (labelled lines flagged `ok`/`LOW`/`HIGH`, or a `console.table`) and you read the result. A failed physiological assertion does **not** make the process exit non-zero — the only thing that exits `1` is a **build failure** (no `model`, missing required model). Do not wire them into a CI green/red check expecting a non-zero exit on a bad number; they will exit `0` while printing `HIGH`. Run the relevant probe by hand and inspect its output. The one exception is the respiratory suite below.

## The respiratory validation suite

`npm run validate:resp` (`scripts/validate_respiratory.mjs`) **is** a pass/fail gate: it exits `1` when a
check fails. It runs a fixed battery on term_neonate_72h, term_neonate_1h, term_neonate_12h and term_neonate_24h (classes `term_1h`, `term_12h` and `term_24h`: the age's pH, PaCO2, SpO2 and, at 1 and 12 h, a static compliance floor 15 % lower for residual lung liquid; preterm_28wk was removed on 2026-10-25 to be rebuilt, so the preterm-class checks, HFOV among them, wait for the rebuild; adult_female is archived), one child process per
scenario, and checks each result against clinical ranges per patient class in
`scripts/_resp_targets.mjs` (each range carries its literature source; the ranges are not fitted to the
model). The battery:

| case | what it does | checks |
|---|---|---|
| `base` | spontaneous steady state | RR, Vt/kg, MV/kg, PaCO2, pH, SpO2, pleural swing |
| `co2` | ventilatory drive cut to 70 % | chemoreflex gain: ventilation recovered per mmHg PaCO2 rise |
| `res_load` | lower-airway resistance ×3 | PaCO2 rise, Vt kept |
| `stiff` | lung elastance ×2 | rapid shallow breathing: Vt down, RR up |
| `cpap` | intubated, CPAP 5 | Vt and PaCO2 close to baseline |
| `ps` | intubated, PS 10 above PEEP 5 | Vt up, effort down, triggered fraction of efforts |
| `flowtrig` | as `ps`, flow trigger 0.6 L/min (0.3 below 2 kg), 5 % termination (no double triggering in short-time-constant lungs) | triggered fraction of efforts |
| `simv` | SIMV at half the spontaneous rate, PS 5, flow trigger, 5 % termination | one mandatory or synchronised breath per window, the other efforts supported |
| `apnea` | drive off | no muscle pressure |
| `cstat` | drive off, PC 15/5 with a pause | static compliance per kg |
| `hfov` | preterm only: f 8/10/12 Hz, amplitude 20 → 30 | PaCO2·DCO2 constant, PaCO2 falls with amplitude |

Volumes are measured at the lungs (ALL + ALR swing per breath) and effort as the THORAX pressure swing,
so the suite does not depend on how Breathing or the Ventilator measure their own tidal volume.

Known model failures are listed with their reason in `KNOWN_FAILURES`; they report as `XFAIL` and do not
fail the run. One that starts passing reports `XPASS`: remove its entry. Options: a scenario list,
`--quick` (shorter settling), `--only base,ps`, `--json`. A full run takes about 10 minutes.

## Probe inventory

35 `probe_*.mjs` scripts. Group by what they verify:

| Group | Scripts | Verifies |
|---|---|---|
| **Core vitals / calibration** | `probe_vitals.mjs`, `probe_tune.mjs`, `probe_ea.mjs` | Regulated vitals + ABG vs normal ranges; the live closed-loop tuner; mitral E/A ratio. |
| **Physiology systems** | `probe_brain.mjs`, `probe_respiratory.mjs`, `probe_surfactant.mjs`, `probe_derecruitment.mjs`, `probe_thermo.mjs`, `probe_glucose.mjs`, `probe_lactate.mjs`, `probe_renal.mjs`, `probe_heartfunction.mjs`, `probe_cpap.mjs`, `probe_apnea.mjs`, `probe_arrhythmia.mjs`, `probe_drugs.mjs`, `probe_pge1.mjs` | Cerebral autoregulation/ICP; respiratory/acid-base dose-response sweeps (FiO2, O2 diffusion, minute volume, UMA); RDS recruitment/derecruitment + surfactant; thermoregulation; glucose/insulin; hypoxic lactate; GFR + RAAS/ADH response to haemorrhage and volume load; load-induced contractility; CPAP/PS ventilation of spontaneous breathing; apnea of prematurity (episode count, SpO2/HR nadirs, desat→brady lag; `--no-chemoreflex` attribution); conduction arrhythmias; adrenaline/noradrenaline PK/PD; PGE1 ductal patency. |
| **Devices** | `probe_ventilator.mjs`, `probe_sle6000.mjs`, `probe_ecls.mjs`, `probe_resuscitation.mjs` | Pressure-control ventilation with spontaneous drive off, sweeping FiO2 / rate / PEEP; veno-arterial ECMO rescue under near-abolished alveolar diffusion, sweeping pump speed / sweep-gas flow (both report the **emergent** blood gas from the gas-exchange physics, not the device); the SLE6000 device model — pass/fail checks of its modes, settings validation, VTV, CPAP backup, O2 Boost and monitored values (exit 1 on failure); CPR — under a simulated arrest, verifies the compression waveform, that compressions drive forward aortic flow via `pres_ext`, the `vent_no`-breaths-per-pause timing, and a clean `switch_cpr` re-toggle. |
| **Fetal / maternal** | `probe_fetus.mjs [scenario]`, `probe_uterus.mjs`, `probe_placenta.mjs` | Fetal circulation (takes a scenario stem; no fetal scenario is shipped at present, see [fetal_circulation.md](./fetal_circulation.md)); uterine bed / pregnancy adaptation / contractions; maternal placenta. |
| **PDA / CDH** | `probe_p1.mjs` | Reproduces the cardiovascular paper's validation experiments from `papers/p1/experiments.json` (paper vs engine vs literature) |
| `probe_pda.mjs`, `probe_cdh.mjs` | PDA Doppler envelope classification; congenital diaphragmatic hernia phenotypes. |
| **CHD family** | `probe_as.mjs`, `probe_coarc.mjs`, `probe_dtga.mjs`, `probe_hlhs.mjs`, `probe_paivs.mjs`, `probe_pavsd.mjs`, `probe_ps.mjs`, `probe_ta.mjs`, `probe_tapvc.mjs`, `probe_tof.mjs` | Duct/FO-dependent congenital heart disease scenarios (aortic stenosis, coarctation, d-TGA, HLHS, PA-IVS, PA-VSD, pulmonary stenosis, tricuspid atresia, TAPVC, tetralogy of Fallot). |

> Every probe defaults to `term_neonate_72h`. Until the preterm and fetal scenarios are rebuilt, `probe_apnea`, `probe_surfactant` and `probe_derecruitment` (they need an Apnea or Surfactant model) `probe_fetus`/`probe_placenta` (they need a running placenta), `probe_oxygenie` (it titrates a hypoxaemic preterm, `preterm_26wk`) and `probe_pge1` (it needs a duct-dependent lesion, `pa_ivs`) have no shipped scenario to run on. `probe_tune` takes the scenario first: `probe_tune.mjs term_neonate_72h --map 50 --co x0.8`. Check the script's `Usage:` header.

## Other engine-dev tooling

The remaining `scripts/*.mjs` support calibration, scenario authoring, and steady-state baking. They reuse the same harness/shim and the same envelope.

| Group | Scripts | Role |
|---|---|---|
| **Calibration** | `build_patient.mjs`, `probe_build_patient.mjs`, `probe_tune.mjs` | Closed-loop calibration via [`helpers/Calibrator.js`](../helpers/Calibrator.js) (see [Calibrator](./Calibrator.md)) — `build_patient.mjs` builds a new calibrated patient from target vitals; `probe_build_patient.mjs` runs it on a few SPECs, reloads each emitted scenario in a fresh engine and checks it against its own `build_report` (targets still within tolerance, FiO2 persisted, desaturation in room air, derived blood-pressure targets, solutes held after reload) and prints levers that ended on a bound; `probe_tune.mjs` exercises the same live tuner headlessly. |
| **Reseeding** | `reseed_*.mjs` (e.g. `reseed_term_neonate`) | Warm a scenario to steady state and serialize it back into `model_definition` (baking equilibrium seeds, clearing startup transients). `reseed_term_neonate` changes no parameter: it settles 600 s, steps to a sinus-node firing (the phase a loaded heart restarts in) and serializes; it used to re-apply old calibration deltas first, which would now undo later calibrations. Each shares `_serialize_state.mjs` (replicates `Model._processModelState`). **Default is a dry run to `/tmp`**; pass `--write` to overwrite the scenario file in place. Only `reseed_term_neonate` remains here; the reseeders of the archived scenarios are in `scripts/archive/` (see below). |
| **Archived generators** | `scripts/archive/` (`_make_preterm`, `_make_fetus`, `_make_cdh_phenotypes`, `_make_dtga`, `_make_pda_patterns`, …, and their `reseed_*`) | The scripts of the archived scenarios: they derive a scenario from `term_neonate_72h` by phenotype-specific lever edits and read and write `model_definitions/archive/` only. Unvalidated against the current engine; see their README. New scenario titles still go in `_titles.mjs` (`setDiagramTitle`). |
| **Gestational-age tables** | `scripts/_ga_tables.mjs` | The per-GA seed levers used by `build_patient.mjs`. (The validated preterm/fetal generators and their profiles were removed on 2026-10-25 to be rebuilt.) |
| **Feature patchers** | `_add_neonatal_core.mjs`, `_add_brain.mjs`, `_add_surfactant.mjs`, `_add_titles.mjs` | Patch a model/feature into many existing scenario JSONs at once (without reseeding, to preserve calibration). `_add_titles.mjs` re-applies the `_titles.mjs` diagram titles in place. |
| **Shared internals** | `_harness.mjs`, `_probe.mjs`, `_serialize_state.mjs`, `_titles.mjs`, `resolve-extensionless.mjs` | `createEngine`; `measureVitals`/`RANGES`/`selectProfile`/`flagOf`; the `serializeState` baker; the scenario diagram-title map; the ESM `.js`-retry resolve hook. |

For the calibration math these tools drive, see [Calibrator](./Calibrator.md); for the signals the probes read, see [Monitor](./Monitor.md); for the message envelope they all speak, see [ARCHITECTURE](./ARCHITECTURE.md).

````

### FILE: explain-engine/docs/TaskScheduler.md

````markdown
# TaskScheduler

`TaskScheduler` (`explain/helpers/TaskScheduler.js`) is **engine infrastructure, not a physiological model**. It is the engine's deferred-mutation helper: it coordinates changes to model properties that should happen later, gradually, or via a method call — gradual numeric tweens, instant boolean/string swaps, and scheduled function executions, all tied to the modeling timestep. It is instantiated once per build in the Web Worker — `ModelEngine.build()` does `model["TaskScheduler"] = new TaskScheduler(model)` — and lives on the engine `model` object alongside `DataCollector` and `ModelScaler`. See [ARCHITECTURE](./ARCHITECTURE.md) for the two-thread picture and [DataCollector](./DataCollector.md) for the read-side sibling.

## Role in the engine

The scheduler is the write side of the per-step loop. After data collection, `_model_step()` calls:

```js
_get_task_scheduler()?.run_tasks();
```

`run_tasks()` runs on **every** model step, but only evaluates queued tasks when its internal interval counter exceeds `_task_interval` (0.015 s). Tasks are enqueued from the worker's message router:

| Caller (in `ModelEngine.js`) | Maps to | Public API surface |
|---|---|---|
| `set_property(new_prop_value)` | `add_task(new_task)` | `setPropValue(prop, value, it, at)` |
| `call_function(new_function_call)` | `add_function_call(new_function_call)` | `callModelFunction(...)` |
| `_model_step()` | `run_tasks()` | — (internal step loop) |

So the lifecycle is: a client (user panel, scenario event, or bot command) posts a `setPropValue` / `callModelFunction` message → the worker enqueues a task → `run_tasks()` later fires it against the live model.

## Key state

| Field | Default | Meaning |
|---|---|---|
| `_model_engine` | ctor arg | reference to the engine `model` (exposes `models`, `modeling_stepsize`) |
| `_t` | `modeling_stepsize` | per-step time increment driving the interval counter |
| `_is_initialized` | `false` | init flag (carried for contract symmetry) |
| `is_enabled` | `true` | when `false`, the interval counter stops advancing (tasks freeze) |
| `_tasks` | `{}` | dictionary of pending tasks keyed by `"task_<n>"` (a running counter) |
| `_task_interval` | `0.015` s | period at which the queue is evaluated |
| `_task_interval_counter` | `0.0` | accumulator, advanced by `_t` each call while enabled |

### Task types

Each task carries a numeric `type` that decides how it is applied:

| `type` | Trigger | Behavior |
|---|---|---|
| `0` | numeric target, `it > 0` | **tween** — `current_value` is stepped by `stepsize` each interval until it reaches `t`, then completes |
| `1` | boolean/string target, **or** numeric with `it <= 0` | **instant swap** — `current_value` set to `t` and written once, then completes |
| `2` | function call | **invoke** — `func.apply(model, args)` once, then completes |

`stepsize` for a type-0 tween is `(t - current_value) / (it / _task_interval)`, computed when the tween **starts** (after `at`), from the property's value at that moment — a property that changed during the delay doesn't jump back to its value at scheduling time.

## Key methods

| Signature | What it does |
|---|---|
| `add_task(new_task)` | Resolves `new_task.model` (a name) to a live instance and checks that `prop1`(`.prop2`) exists, infers `type` (0 numeric tween with `it > 0` / 1 instant write) and enqueues under a unique `task_<n>` key. Returns an error string (sent to the UI as an `error` message by `set_property`) for an unknown model or property, or a non-number target for a numeric property; nothing is queued then and no property is created. |
| `add_function_call(new_function_call)` | Splits `func` (`"Model.method"`), checks that the model exists and the method is a function (else returns an error string, sent as an `error` message by `call_function`), keeps the model and method **names** (the task list must stay structured-cloneable), marks the task `type = 2`, and enqueues it to fire after `at` seconds. |
| `run_tasks()` | When `_task_interval_counter > _task_interval`: resets the counter, iterates `_tasks`, decrements each task's `at` delay; once `at` elapses it starts type-0 tweens, performs type-1 swaps and type-2 calls immediately, and steps running tweens toward `t`. Completed tasks are deleted. Advances the counter by `_t` only while `is_enabled`. |
| `_new_id()` *(private)* | Returns the next `task_<n>` key (a running counter, so ids never collide). |
| `_set_value(task)` *(private)* | Writes `current_value` into `task.model[prop1]` or `task.model[prop1][prop2]`. |

### `setPropValue(prop, value, it, at)` semantics

- `prop` — the target dot-path (`Model.prop` or `Model.prop.subprop`); split into `model` / `prop1` / `prop2`.
- `value` (`t` on the task) — the destination value.
- `it` — interpolation time in seconds. `it > 0` on a numeric target tweens over that span (one increment per `_task_interval`); `it <= 0` writes instantly (type 1). Booleans/strings always write instantly.
- `at` — delay in seconds before the task begins; decremented by `_task_interval` each evaluation until it elapses.

**Example** (term_neonate_72h): `add_task({model: "Heart", prop1: "heart_rate_ref", t: 150, it: 10, at: 2})` holds 120.3 for 2 s, then rises ~3 bpm per second and reaches 150 at 12 s. `add_function_call({func: "Breathing.switch_breathing", args: [false], at: 5})` switches breathing off at 5 s. A misspelled property returns `TaskScheduler: property 'Heart.no_such' not found`.

## Interaction with models

The scheduler mutates live model instances **directly** by property assignment via `_set_value`. In practice the `prop1`/`prop2` target is typically a persistent factor (`*_factor_ps`) or a base parameter — writing the persistent layer is how a deferred adjustment composes with the factor/effective-value system (transient `*_factor` reset each step, persistent `*_factor_ps`, scaling `*_factor_scaling_ps`) described in [ARCHITECTURE](./ARCHITECTURE.md). Type-2 tasks instead call a model method (looked up by name when the task runs), e.g. an intervention like `administer_surfactant` or `trigger_pvc`.

The complementary read-only telemetry helper is [DataCollector](./DataCollector.md); the two run back-to-back inside `_model_step()` (collect, then run tasks).

## Notes / caveats

- **Zero-delta tweens complete at once.** A tween that starts with the property already at `t` has `stepsize` 0 and completes on its first step.
- **`is_enabled = false` freezes time, not the queue.** When disabled, `_task_interval_counter` stops advancing, so pending tasks neither tick nor fire; they resume from where they were when re-enabled. Tasks already in `_tasks` are not cleared.
- **Completion is one-shot.** Type-1 and type-2 tasks complete on their first eligible evaluation; type-0 completes when the remaining distance to `t` is at most `|stepsize|` (the final write snaps exactly to `t`). Completed tasks `delete` themselves from `_tasks`.
- **The queue travels with the model state.** The posted state includes the TaskScheduler, which is why pending tasks keep model and method *names* rather than function references.

````

### FILE: explain-engine/docs/TermNeonateReference.md

```markdown
# Term neonate at 72 h: literature reference values

Reference values for validating the `term_neonate_72h` scenario: a healthy term neonate of about 3.5 kg
at about 72 h postnatal age, in a calm, mixed sleep/awake state. Compiled 2026-10-18 from three
reference PDFs (kept out of the repository) and a PubMed search.

The machine-readable version is [`scripts/reference/term_neonate_72h.json`](../scripts/reference/term_neonate_72h.json).
It has one entry per variable with value, spread, method, age, sources (DOI/PMID), grade and the
model read-out to compare against.

**Grades**
- **A**: healthy term infants measured at day 2–4
- **B**: first week, a mixed cohort, or a figure read-off
- **C**: textbook range or extrapolation; no healthy-term primary data found

**Reading the tables:** ranges are the study's own normal limits: P2.3–P97.7, P5–P95, mean ± 2 SD
or a range, as marked. "Fig" means the value was read off a published graph (±2 mmHg / ±5 mL/kg/min).

## Measurement method matters

The comparison is only fair when the model read-out matches what the clinicians measured. The main
pitfalls found while compiling this set:

- **Blood pressure:** the references are cuff (oscillometric). The model reads the ascending aorta.
- **Heart rate:** it depends on behavioural state. Quiet sleep is ~112, a calm mixed state ~117–120,
  awake about +6 bpm. This set uses the calm, mixed state.
- **Cardiac output: compare stroke volume per kg first.** The two MRI studies differ in output
  (177 vs ~200–218 mL/kg/min) mainly because their heart rates differed (100 vs 142); SV/kg agrees
  (1.6 vs 1.7). Echo output is about twice as noisy as MRI (repeatability ±109 vs ±50 mL/kg/min).
- **Tidal breathing:** a face mask with a pneumotachograph adds ~13 % to Vt and ~30 % to minute
  ventilation, so dead-space-free (flow-through) data are used.
- **Blood gases:** capillary values from 48 ± 12 h. Capillary pH and pCO₂ approximate arterial
  values; capillary pO₂ does not, so PaO₂ stays grade C.
- **Lactate:** plasma (GLOW) reads lower than capillary whole blood (Cousineau).
- **Regional flows:** MRI (PC-MRA) and Doppler volume-flow estimates differ widely. The brain-flow
  MRI cohorts were scanned for clinical reasons at term-equivalent age.

## Hemodynamics

| Variable | Reference | Range | Method, age, n | Grade | Source |
|---|---|---|---|---|---|
| Heart rate | **118** bpm | 91–145 (P5–P95) | monitor pulse, day 3, n=2628 | A | Satoh 2016; also Hannover 2018 (quiet sleep 112, 87–133), Norway 2021, He 2011 (126 → 120 from day 1 to 3) |
| Systolic BP | **74** mmHg | 60–89 (P2.3–P97.7) | NIBP, GA 40 day 3 (Fig 4a), n=607 | A | van Zadelhoff 2023; Satoh 2016 70.5 ± 7.4 |
| Diastolic BP | **46** mmHg | 31–61 | NIBP (Fig 4c) | A | van Zadelhoff 2023; Satoh 44.3 ± 6.7 |
| Mean BP | **58** mmHg | 45–72 | NIBP (Fig 4b) | A | van Zadelhoff 2023 |
| Pulse pressure | ≈ 28 mmHg | — | derived | B | as above |
| CVP | — | 2–8 mmHg | invasive, sick infants only | C | textbook |
| PAP systolic | **36.0 ± 6.5** mmHg | (24 h 43.8, 48 h 38.1) | echo, 72 h, n=76 | A/B | Kang 2016; its "upper 95 % limit 39.97" looks like a CI of the mean, not a normal limit |
| PAP diastolic | **13.3 ± 6.2** mmHg | — | echo, 72 h | A/B | Kang 2016 |
| PAP mean | **25.3 ± 8.3** mmHg | — | echo, 72 h | A/B | Kang 2016 |

## Heart (cardiac MRI)

Jhaveri 2023: 20 healthy term newborns, average 3545 g (the scenario's weight), scanned at
31.8 ± 14 h, asleep after a feed (HR 100). Limits are mean ± 2 SD.

| Variable | LV | RV | Grade |
|---|---|---|---|
| EDV (mL/kg) | **2.5 ± 0.3** (1.9–3.1) | **3.1 ± 0.3** (2.5–3.7) | A/B |
| ESV (mL/kg) | **0.9 ± 0.2** (0.5–1.3) | **1.5 ± 0.2** (1.1–1.9) | A/B |
| SV (mL/kg) | **1.6 ± 0.1** (1.4–1.9) | **1.6 ± 0.2** (1.2–2.0) | A/B |
| EF (%) | **63.2 ± 3.4** (56.4–69.9) | **52.5 ± 3.3** (45.9–59.1) | A/B |

Groves 2011 cine MRI at CGA 40 (Fig 5): LV EDV ~2.45 mL/kg, ESV ~0.78, EF ~68 %; SV 1.73 ± 0.28 at
HR 142. RVEDV/LVEDV is 1.2 ± 0.2.

## Flows

| Variable | Reference (mL/kg/min) | Range | Method, age | Grade | Source |
|---|---|---|---|---|---|
| LV output | **~196** | 108–284 | PC-MRI, CGA 40 (Fig 3A) | B | Groves 2011; Jhaveri 177 ± 25 at HR 100 |
| RV output | **~199** | 100–298 | PC-MRI (Fig 3B) | B | Groves 2011; Jhaveri 181 ± 30 |
| SVC flow | **~83** | 28–138 | PC-MRI (Fig 3C) | B | Groves 2011 |
| Descending aorta | **~99** | 57–141 | PC-MRI (Fig 3D) | B | Groves 2011 |
| Brain | **28.5** (median; term 106 mL/min) | 9.8–94 | PC-MRA at TEA ~41 wk, n=344 | B | Kooi 2019; Liu 2014 14.9 ± 4.9 mL/100 g/min |
| Intestine (SMA) | **43 ± 13** | — | Doppler volume flow, preterm + term | B | Van Bel 1990; Agata 1994 ~48 at 96 h |
| Kidney | no credible absolute value | — | Doppler, left renal artery only: ~32 (24 h) / ~37 (96 h), unchanged over 1–96 h | C | Agata 1994 (Fig 2) |
| Liver/spleen (coeliac) | no credible absolute value | — | Doppler, coeliac: ~75 (24 h) / ~72 (96 h) | C | Agata 1994 (Fig 2) |

**Doppler volume flows are upper estimates.** Agata's single vessels (left MCA ~46, coeliac ~72,
SMA ~48, one renal artery ~37 mL/kg/min at 96 h) add up to ~203 of an LVO of 258 mL/kg/min, which is
not possible. The usable findings are the time course (organ flows stable from 24 to 96 h; renal flow
unchanged from 1 h) and the SMA agreement with Van Bel. Kidney and coeliac have no credible
absolute reference.

The model's LS bed is liver + spleen, so it compares with coeliac / hepatic arterial flow. Portal
inflow comes through the intestinal bed (INT), which the model drains into the lower-body veins.

## Breathing

| Variable | Reference | Range | Method, age, n | Grade | Source |
|---|---|---|---|---|---|
| Respiratory rate | **44** /min | 32–57 (P3–P97) | quiet sleep, median day 2, n=215 | A | Hannover 2018; Schmalisch 2005 39.2 ± 8.6 |
| Tidal volume | **5.57 ± 1.06** mL/kg | — | flow-through, day 7, n=48 | A/B | Schmalisch 2005 |
| Minute ventilation | **215 ± 52** mL/kg/min | — | flow-through | A/B | Schmalisch 2005 |
| Ti/Ttot | **0.40** (Ti 0.65 s, Te 0.98 s) | — | flow-through | A/B | Schmalisch 2005 |
| Peak tidal insp / exp flow | **0.83 ± 0.20 / 0.64 ± 0.19** L/min/kg | — | flow-through | A/B | Schmalisch 2005 |
| Compliance (Crs) | **~3.6** mL/cmH₂O (~1.0–1.1 /kg) | 3.2–4.0 | passive occlusion | B | Katier 2006 (prediction 4.0), Stocks 1994, Migdal 1987, Nowotny 1998 |
| Resistance (Rrs) | **52 ± 6** cmH₂O/L/s | (Katier ~75–80) | passive occlusion, n=9 | B | Nowotny 1998 |
| FRC | **27.1** mL/kg | 23.8–32.0 | helium, median day 2, n=24 | A | Yüksel 1995; nitrogen 24.0, plethysmography 29.8–31.1 |
| Anatomic dead space | **2.2** mL/kg | Vd/Vt ~0.3–0.4 | term, day 5 | A/B | Stokes 1986 |

## Gases and saturations

| Variable | Reference | Range | Method, age, n | Grade | Source |
|---|---|---|---|---|---|
| SpO₂ (pre-ductal) | **97.3 ± 1.4** % | — | pulse oximetry, median day 2, n=209 | A | Brockmann 2011; Poets 1996 97.6 (92–100) |
| pH | **7.395 ± 0.037** | 7.312–7.473 | capillary, 48 ± 12 h, n=119 | A | Cousineau 2005 |
| pCO₂ | **38.7 ± 5.1** mmHg | 28.5–48.7 | capillary | A | Cousineau 2005 |
| HCO₃ | ≈ 23.4 mmol/L | — | derived from pH/pCO₂ | B | Cousineau 2005 |
| Base excess | — | −4 to +2 | — | C | textbook |
| PaO₂ | — | 60–90 mmHg | arterial | C | textbook (Koch & Wendel 1968 unavailable) |
| EtCO₂ | ≈ PaCO₂ | gap 0 ± 7 mmHg | capnography | C | Lopez 2011 (healthy preterm controls) |
| SvO₂ | **~76 %** | 70–80 | right-atrial fibre-optic catheter, stable preterms in room air (73.6 ± 5.3 % at SaO₂ 93.4 %, extraction 0.21); peripheral-muscle extraction 0.22–0.26 in healthy term babies | B | van der Hoeven 1996 ([doi](https://doi.org/10.1136/fn.74.3.f177)); Wolfsberger 2023 ([doi](https://doi.org/10.3389/fped.2023.1276769)); sagittal sinus 72.4 % (Carmichael 2025, [doi](https://doi.org/10.1038/s41390-025-03966-6)), 63.9 % (Liu 2014); NIRS day 2: cerebral 78, renal 89, splanchnic 75 % (Bailey 2013). The Fick estimate from calorimetry VO₂ and MRI output is ~83 %. Revised 2026-10-27 (was ~83 %, derived) |

## Metabolism, blood, kidneys

| Variable | Reference | Range | Method, age, n | Grade | Source |
|---|---|---|---|---|---|
| VO₂ | **~8.4** mL/kg/min (lung uptake) | 6.3–9.5 | the O₂ use that gives the measured venous extraction (0.21) at the measured output; calorimetry 6.26 ± 1.51 (first week, thermoneutral rest, n=202) and 6.6–7.2 at 6–30 h (RQ 0.94 → 0.88) | C | derived (2026-10-27); phototherapy study 2001; Zoppi 1998 ([doi](https://doi.org/10.1038/sj.ejcn.1600564)). Raises ventilation to ~250 mL/kg/min against 215 measured in quiet sleep |
| Temperature | 37.0 °C | 36.5–37.5 | — | C | WHO/textbook |
| Glucose | **~4.0** mmol/L | — | plasma; 3.3 ± 0.6 to 48 h, 4.6 ± 0.7 by day 4 | A | GLOW 2020; Cousineau 3.8 ± 0.8 |
| Lactate | **1.4** mmol/L (plasma, median) | 0.8–3.3 | > 48 h, n=67 | A | GLOW 2021; Cousineau capillary 2.6 ± 0.7 (1.4–4.1) |
| Hb | **~17.0** g/dL | 12.8–21.2 (P5–P95) | day 3, 35–42 wk (Fig 3B) | B | Jopling 2009 (Utah, 800–1520 m) |
| Hct | **~49.5** % | 37–62.5 | Fig 3A | B | Jopling 2009 |
| Blood volume | — | 80–90 mL/kg | — | C | textbook |
| GFR | **~30** mL/min/1.73 m² | 19.6 (day 1) – 40.6 (day 5) | measured GFR, IPD meta-analysis, n=881 | A/B | Smeets 2022 |
| Urine output | — | 1–3 mL/kg/h | — | C | textbook |

## Shunts at 72 h

| Shunt | Reference | Grade | Source |
|---|---|---|---|
| Ductus arteriosus | patent in **4 %** at 60–72 h (12 % at 48–60 h, 21–22 % at 24–48 h) | A | Ha 2018 (n=56, echo every 12 h) |
| Foramen ovale | small, predominantly left-to-right PFO flow in most term newborns; no closure on day 1–3; CMR RV output exceeds LV by ~3–4 mL/kg/min with the duct closed | C | He 2011; Hiraishi 1991; Jhaveri 2023 / Groves 2011 (indirect) |

## First look at the model (step 3, scenario at `07b4ebf`)

Preliminary values taken while compiling; the formal comparison follows in step 5.

- **Matches:**
  - BP 72.6/45.8 (58.9)
  - LVO/RVO 200
  - SVC 81 and DAo 106
  - RR 40, Vt 5.6–5.8 mL/kg, MV 235
  - dead space 2.23 mL/kg
  - SpO₂ 96.8, pH 7.37, PaCO₂ 39.5
  - glucose 4.0
  - Hb 16.1 g/dL
  - GFR 34.7
  - ductus closed
- **Worth discussing:**
  - HR 131 (reference ~118); at the same output this gives SV 1.5 mL/kg against 1.6
  - Ti/Ttot 0.30 (reference 0.40)
  - Crs 3.4 mL/cmH₂O (low end)
  - lactate 1.0 (below both lactate references)
  - brain flow 40.5 mL/kg/min = 20 % of LVO (MRI median ~28.5)
  - intestinal flow 26 (reference 43 ± 13)
  - foramen ovale fully closed

## Recalibrations made from this reference

Use `node scripts/probe_term_reference.mjs` for the full comparison (`--file` probes a scenario file
outside `model_definitions/`).

| Date | Change | Before → after | Basis |
|---|---|---|---|
| 2026-10-18 | Brain flow and O₂ use (`scripts/_fix_term_brain_mri.mjs`); freed flow → upper body (RUB) | CBF 144 → 106 mL/min (20 → 15 % of LVO); brain VO₂ 11.0 → 8.1 mL/min (42 → 31 %); extraction unchanged at 35 %; SVC stays 81 | Kooi 2019 term median; Liu 2014 extraction |
| 2026-10-18 | Foramen ovale (`scripts/_fix_term_fo.mjs`): `diameter_fo` 0 → 1.5 mm (`fo_lr_factor` 1); chemoreflex and HeartFunction references re-anchored | FO 0 → 5.9 mL/kg/min L→R; RVO − LVO 0 → +6 mL/kg/min; gases, BP, HR unchanged | He 2011; Hiraishi 1991; CMR RV > LV output |
| 2026-10-18 | Resting lactate (`scripts/_fix_term_lactate.mjs`): `lact_baseline` 1.0 → 1.5; lact +0.5 / uma −0.5 in every patient blood compartment | lactate 1.0 → 1.5 mmol/L; pH, HCO₃, BE unchanged (7.364 / 22.35 / −2.40) | GLOW 2021 (1.4 plasma > 48 h); Cousineau 2005 (2.6 capillary, 1.4–4.1) |
| 2026-10-18 | Breathing pattern (`scripts/_fix_term_breathing_pattern.mjs`): `ie_ratio` 0.30 → 0.40; `vt_rr_ratio` → 1.29795e-4; `minute_volume_ref` and chemoreceptor set-points re-anchored | Ti/Ttot 0.30 → 0.40; RR 37.7 → 40.0; Vt 5.51 → 5.34; MV 208 → 213; peak flows 0.90/0.58 → 0.70/0.66 L/min/kg | Schmalisch 2005 (Ti, Vt, MV, peak flows); Hannover 2018 (RR) |
| 2026-10-18 | Heart rate and contractility (`scripts/_fix_term_hr_contractility.mjs`): `heart_rate_ref` 131.15 → 120.33; LV `el_max` ×1.15, RV ×1.3; chemoreflex and HeartFunction stress references re-anchored | HR 131 → 120; LV ESV/SV/EF 1.01/1.51/59.9 → 0.92/1.66/64.4; RV 1.65/1.51/47.8 → 1.54/1.66/51.8; output unchanged; PAP 38.9 → 40.6 systolic | Satoh 2016, He 2011, Agata 1994 (HR); Jhaveri 2023 (CMR volumes) |
| 2026-10-18 | Whole-body VO₂ (`scripts/_fix_term_vo2.mjs`): `Metabolism.vo2` 7.288 → 6.1396 (Mob's ~0.81 for the heart kept); `minute_volume_ref` and chemoreceptor set-points re-anchored | total VO₂ 8.1 → 7.0 mL/kg/min; MV 235 → 207; RR 40.4 → 37.5; Vt 5.8 → 5.5; SvO₂ 78.7 → 81.5; PaO₂ 73 → 76 | 6.26 ± 1.51 (first week, rest); REE 45–50 kcal/kg/d ≈ 6.5–7.2; calm mixed state |
| 2026-10-18 | Probe only: blood volume leaves out the bladder (URINE is a BloodCapacitance), found during the preterm 6.5 step | reported blood volume ~82–86 → 80.6 mL/kg; the scenario is unchanged | Whole-body volume balance (blood + bladder vs maintenance intake) closes exactly |
| 2026-10-25 | Blood volume (`scripts/_fix_blood_volume.mjs --factor 1.06`, re-validation re-anchoring): `vol`/`u_vol` of the 31 blood-volume compartments ×1.06, `Hormones.volume_setpoint` 0.286 → 0.3011 L (the new resting volume) | CVP 1.93 → 2.47 mmHg (was below 2 after the heart re-validation: valves, inertance, RV, coronary flow); blood volume 80.6 → 85.0 mL/kg (mid-reference); LVO 196 → 200, HR 118.1 → 116.9, MAP 60.2 → 60.9 | Reference ranges CVP 2–8, blood volume 80–90 mL/kg (textbook, grade C) |
| 2026-10-27 | Venous oxygen extraction (`scripts/_fix_term_venous_vo2.mjs`): per-bed O₂ use +0.6 upper body, +0.6 lower body, +0.15 gut, +0.08 liver mL/kg/min (brain and kidney keep their absolute use), `Metabolism.vo2` 6.30 → 7.73; `minute_volume_ref` and chemoreceptor set-points re-anchored; heat-loss trim re-seeded | lung VO₂ 7.07 → 8.51 mL/kg/min; mixed venous (PA) 82.0 → 78.5 %, SVC 82.6 → 79.0, IVC 82.7 → 79.0, brain venous 67.6 → 67.2; extraction 0.155 → 0.19; MV 213 → 250; RR 40 → 43.7; Vt 5.31 → 5.72; PaO₂ 75 → 72; PaCO₂, pH, BE, BP, HR, output unchanged | van der Hoeven 1996 (right atrium 73.6 ± 5.3 %, extraction 0.21); Wolfsberger 2023 (peripheral extraction 0.22–0.26). Partly reverses the 2026-10-18 VO₂ step (calorimetry); the ventilation now exceeds the quiet-sleep 215 (accepted) |
| 2026-10-25 | Re-bake of the stored state (re-validation (g)): HeartFunction set-points re-learned (`_relearn_heartfunction.mjs`: LV σ_ed 21.6 → 26.0, RV 57.0 → 63.1), then `scripts/reseed_term_neonate.mjs` (settle 600 s, save at a sinus-node firing); Heart fires on the first step after a load, Brain resumes its smoothers | Stored controller state now where it settles (Brain `autoreg_factor` 1.009 → 1.12, renal afferent 0.995 → 1.11, TGF 1.00 → 1.04, baroreflex firing 0.500 → 0.526, Thermoregulation `loss_trim` persisted); no phantom LV remodelling at rest; no MAP dip at load (was 61 → 53 mmHg for ~2 s); reference values within 0.5 % (CVP 2.47 → 2.44) | Stale state from before the heart re-validation; the load transient was a skipped beat |
| 2026-10-25 | Reflexes (re-validation (l)): baroreflex folded neutral at rest and `BR_MAP.set_value` 57.81 → 60.56 (`scripts/_fix_baro_setpoint.mjs`, now folding `el_k` and the venous `u_vol` too); `BR_MAP.tc` 4 → 0.5 s, `EF_HR.tc` 2 → 0.5 s; `CR_PO2.effect_weight` −0.15 → −0.4; state re-baked | Baroreflex firing at rest 0.524 → 0.499; baroreflex sensitivity 1.5 → 6.0 ms/mmHg; FiO₂ 0.15: ventilation +5 % flat → +19 % at 1 min, +11 % at 5 min; rest within 1 % (MAP 60.9 → 61.2) | Andriessen 2005, Yiallourou 2010 (6.4 ms/mmHg at 2–4 wk, user's target); Rigatto 1982, De Boeck 1984 |
| 2026-10-25 | Brain (re-validation (f)): ICP acts as a pressure (excess added to the venous outflow pressure, the waterfall, and to the cerebral vessels' external pressure) instead of an outflow resistance (`icp_outflow_gain`/`_factor_max` removed); `cbf_tc` 3 → 1 s, `autoreg_tc` 4 → 1 s; resting autoregulation folded into `BR_ART` (r ×1.1228, factor 1.12 → 1.00); `cbv0` 3.784 → 3.990 mL; state re-baked | Pressure-passive CBF follows CPP and stops as ICP reaches MAP (was 92 mL/min with ICP > MAP); intact autoregulation holds CBF to CPP ~35, lower limit ~30; CBF returns ~5 s after a pressure step without ringing; rest unchanged (CBF 106 mL/min) | Monro–Kellie, vascular waterfall (Starling resistor) |
| 2026-10-25 | Catecholamines (re-validation (j)), also the Drugs code defaults: clearance of adrenaline and noradrenaline scaled to 25 mL/kg/min; adrenaline EC50s 5.7 (HR) and 18 ng/mL (inotropy, lusitropy, SVR), Hill 1, Emax fitted closed-loop; noradrenaline mainly vascular | Half-life 20 s → 130 s; adrenaline 0.1 mcg/kg/min: 0.9 → 4.0 ng/mL, HR +0 → +16 %, MAP +0 → +24 %; noradrenaline 0.3: MAP +18 %, HR −3 % | Oualha 2014, Fisher 1993; neonatal noradrenaline cohorts (Kallimath 2024, Gupta 2022, Lu 2023) |
| 2026-10-25 | Glucose (re-validation (i)), also the code defaults: interstitial pool (0.31 L/kg, τ 5 min), brain uptake insulin-independent and saturable (Km 1 mmol/L), insulin secretion blunted above the set-point (`insulin_gain` 6 → 0.54) with prompt suppression below (`insulin_suppression_gain` 6), counter-regulation one-sided; state re-baked | Rest unchanged (4.0 mmol/L); hepatic output stopped: 2.82 → 3.27 mmol/L at 10 min, 0.01 → 1.25 at 90; D10 2 mL/kg: cleared in ~8 min with a rebound to 1.99 → K 1.54 %/min, +2.1 mmol/L at 10 min | Bier 1977, Huang 1989, Salle 1976 |
| 2026-10-25 | Thermoregulation (re-validation), also the code defaults: surface area `surface_area_k` 0.05 → 0.097 (0.116 → 0.226 m²); `h_radiative` 9.6 → 5.2, `h_convective` 7.0 → 4.9; perfusion coupling mass = the relaxed blood's heat capacity (`blood_volume_per_kg` removed); `loss_trim` re-seeded (−3.23 → −5.26 W) | Rest unchanged; dry-loss sensitivity 1.93 → 2.28 W/K (60 min at 28 °C: −0.97 → −1.10 °C; at 35 °C: +1.39 → +1.56 °C); skin evaporation 0.35 → 0.68 W (≈ respiratory, as measured); `Q_perf` returns to 0 | Sjörs 1997, Apedoh 1999, Riesenfeld 1995, Sedin 1983 |
| 2026-10-25 | Hypoxic ventilatory depression (final pass), new in Breathing: `hvd_factor` relaxes over 120 s towards 1 − min(2 · (70 − pO2)/70, 0.8) below a pO2 of 70 mmHg | FiO₂ 0.15: ventilation +18 % at 1 min, +4 % at 5 min (12 % below the peak; was +11 % sustained); FiO₂ 0.07: pH 7.44 at 1 min, 7.33 at 7 min (was 7.41: the stronger chemoreflex of (l) kept the baby alkalotic, probe_lactate failed); rest unchanged | De Boeck 1984, Rehan 1996 |

## Open items

- **Koch & Wendel 1968** (arterial gases, first week): unavailable, so PaO₂ and BE stay grade C.

```

### FILE: explain-engine/docs/TermTransitionReference.md

```markdown
# Term neonate in transition: reference values at 1, 12, 24 and 72 h

Reference values for the transitional term scenarios: a healthy term neonate of about 3.5 kg after an
uncomplicated **vaginal birth with delayed cord clamping (~1 min)**, breathing room air and nursed
**skin-to-skin or dressed at room temperature**, not yet fed at 1 h. The 72 h column is the
`term_neonate_72h` set ([TermNeonateReference](./TermNeonateReference.md)); the earlier ages describe what
changes on the way there. Compiled 2026-10-25 from PubMed.

The machine-readable sets are [`term_neonate_1h.json`](../scripts/reference/term_neonate_1h.json),
[`term_neonate_12h.json`](../scripts/reference/term_neonate_12h.json) and
[`term_neonate_24h.json`](../scripts/reference/term_neonate_24h.json), in the
same format as [`term_neonate_72h.json`](../scripts/reference/term_neonate_72h.json). Variables without
data at an age are reference-only there (no numbers) or carry the 72 h range, marked C.

**Grades**
- **A**: healthy term infants measured at (or within a few hours of) that age
- **B**: a nearby age, a mixed cohort or delivery mode, or direction only
- **C**: textbook, derived, or the 72 h value carried

## Each scenario is a snapshot

A baby at 1 h is mid-transition: the duct is closing, pulmonary pressure is falling, lung liquid is
being absorbed, and catecholamines are still high. Each transitional scenario is a **steady state of
that moment**. Its controllers (chemo- and baroreflex, Brain, Hormones, Glucose, HeartFunction and the
thermal loss trim) are re-anchored to the age's values, so the scenario holds them when loaded instead of
drifting toward 72 h. The time course is the series of scenarios, not something one scenario runs through.

## Decisions (2026-10-25)

- **Pulmonary artery pressure at 1 h:** near-systemic, PAP:SAP ~0.9. Every baby has a bidirectional duct
  at 2 h (Kang 2016), and bidirectional ductal flow goes with a ratio of 0.88–1.22 (Skinner 1991). Kang's
  absolute 2 h values (77/63 mmHg, from the ductal gradient plus cuff pressure) are above systemic
  pressure and would force right-to-left flow, so they are not used as targets.
- **Haematocrit and blood volume:** the delayed-clamping values (Hct ~55 % at 1 h, 57 % at 6 h). The 72 h
  baby (Hct 49.5, a mixed-clamping population) is left unchanged, so the series is not continuous in Hct.
- **Blood gases at 1 h:** textbook values, grade C. No quotable values were found: Weisbrot 1958, Koch &
  Wendel 1968 and Jovandaric 2018 (arterialized capillary gases at 1 and 2 h in 50 healthy newborns) give
  their numbers only in tables.
- **Blood volume at 1 h: ~80 mL/kg** (corrected from a textbook 92). At birth the baby's volume is the
  feto-placental volume (taken as 115 mL/kg) minus what stays in the placenta: 63–73 mL/kg after early
  clamping, 96–100 after 3-min clamping (Linderkamp 1992, Nelle 1995), so ~85 after ~1 min. In the first
  hours plasma leaves the circulation at a constant red cell mass, which is why Hct rises: 85 × 0.50/0.55 ≈ 77 at 1 h
  (3-min clamping at 2 h: 100 × 0.50/0.63 ≈ 79). The extra placental blood shows up as red cells, not as
  volume. Red cell mass 0.55 × 80 = 44 mL/kg then runs smoothly into the 72 h baby's 0.49 × 85 = 42.
- **VO2 (superseded 2026-10-27, see "Venous oxygenation" below):** 7.0 mL/kg/min at every age. The only human early value (~5 under 12 h, Hill & Robinson 1968)
  comes mostly from low-birth-weight infants, and lambs reach their postnatal VO2 within an hour.

## The 1 h scenario

`model_definitions/term_neonate_1h.json`, generated by `node scripts/_make_term_transition.mjs --age 1 --write`
from `term_neonate_72h`. The levers (factors relative to 72 h), in the script's profile:

| Lever | Value | Why |
|---|---|---|
| Duct | 4.6 mm at the pulmonary end, 5.1 mm at the aortic end | Kang 2016 at 2 h |
| Pulmonary resistance (and `Shunts.ips_res` alike) | x1.2 | with a 4.6 mm duct the pulmonary pressure follows the aorta, so a small rise gives the bidirectional flow |
| Systemic resistance | x0.5, but brain, gut, liver and kidney beds kept at 72 h | the high output runs through the duct, not the organs (Agata 1994; see below) |
| Heart `el_max` / `heart_rate_ref` | x1.6 / x1.07 | the catecholamine surge: high output |
| Blood volume / Hct | 80 mL/kg / 55 % | delayed clamping after the first plasma shift |
| Lactate / unmeasured anions | 2.2 / +2.1 mmol/L | GLOW; BE -5 |
| Glucose | 3.3 mmol/L (also the Glucose set-point) | GLOW, Hoseth |
| Minute volume reference | x1.11 | pCO2 ~36 |
| Lung liquid: alveolar (ALL/ALR) `u_vol` / `el_base` | x0.85 / x1.11 | see below |
| Brain | settles pressure-passive; `cbf_setpoint` re-anchored last | see below |
| Glomerular filtration coefficient (`Kidneys.kf`) | x0.8 | GFR at the day-1 value (see below) |
| `Heart.rv_delay` / main and branch PA `el_base` | −35 ms (the LV lags) / x2.5 | early systolic right-to-left ductal flow (see below) |
| Environment | 24 °C, 50 % humidity | dressed / skin-to-skin in the room (loss trim re-seeded) |

Then the controllers are re-anchored at rest: the baroreflex activity is folded into the base values
(BR_MAP set-point 46.3), the chemoreceptor set-points become the resting gases, the Hormones set-points
the resting volume and renal pressure, and HeartFunction re-learns its wall-stress set-points (RV
es 174 vs 124 at 72 h: the RV pumps against near-systemic pressure). Loaded, it holds for 10 min
(HR 137, MAP 47.7, duct 32–34 mL/kg/min, pH 7.345).

**First comparison (2026-10-25): 37 of 39 numeric targets in range.** Out: CVP 1.8 (2–8, carried from
72 h, C) and urine 1.1 mL/kg/h (most babies have not voided at 1 h). LV output 300 (346 ± 68), HR 137,
MAP 47.6, PAP 46.5 (ratio 0.98), duct net left-to-right 33 mL/kg/min with right-to-left flow 27 % of the
time, FO -1.4 mL/kg/min, SpO2 97.4 / 96.1, SvO2 88, pH 7.35 / pCO2 36.8 / BE -5.0, Hct 55, blood volume
80.4. Not yet addressed: FRC 30 (reference 23 at 4–6 h, lung liquid), compliance (lower on day 0),
brain autoregulation strongly constricted (factor 1.7: CBF held at its 72 h set-point while the
reference says it is lower at 1 h).

**Step 3a, lung liquid.** After a vaginal birth most lung liquid is gone within hours: Lee 1999 measured
FRC (argon) 23.1 mL/kg at 4–6 h and 24.9 at 24 h (−7 %, P = 0.08), and Lødrup Carlsen 1993 found Crs
lower on day 0 (first measured at 1 h) than later, with no size we could use. The model reads FRC
about 10 % above its helium reference even at 72 h (29.9 vs 27.1), so the 1 h baby is set relative to
its 72 h self: the residual liquid is a smaller aerated lung that is proportionally stiffer (liquid-filled
alveoli do not ventilate), alveolar `u_vol` x0.85 and `el_base` x1.11, which keeps the specific
compliance (Crs/FRC) about constant. Result: FRC 30.1 → 26.9 mL/kg (−11 %), Crs 3.41 → 3.14 mL/cmH2O
(−8 %, grade C). Tidal volume (5.4) and SpO2 (97.4 / 96.0) do not change: the breathing controller holds
its targets, and a smaller FRC only shrinks the oxygen store (the model has no V/Q effect of
interstitial liquid). Side effect: the smaller lung volume makes the pleural pressure more negative and
CVP falls from 1.8 to 1.4 (still 37 of 39 in range).

**Step 3b, where the high output goes.** Agata 1994 (23 term babies, Doppler flow volume at 1, 4–8, 24
and 96 h): middle cerebral, coeliac and superior mesenteric flow are significantly lower at 1 and 4–8 h
than after 24 h, renal flow does not change, LV output is 365 ± 69 at 1 h; the low organ flow comes with
low diastolic flow that correlates with the ductal diameter (diastolic steal), and LV output correlates
with the ductal diameter too. With the SVR halved in every bed the model did the opposite: brain held at
its 72 h set-point by autoregulation (factor 1.73), gut and coeliac +39 %, kidney +65 %. Now the organ
beds keep their 72 h resistance, the high output runs through the duct (net left-to-right 74 mL/kg/min,
Drayton 1987 62, 43–82) and the brain settles pressure-passive and takes that flow as its set-point.
Lowering PVR further (x1.0, x0.85) made the shunt too large (111, 143) and ended the bidirectional flow.

| mL/kg/min | 72 h | 1 h before | 1 h now | Agata, 1 h vs ≥ 24 h |
|---|---|---|---|---|
| LV output | 200 | 298 | 306 | ↑ (365 ± 69) |
| Duct net left-to-right | 0 | 34 | 74 | (Drayton ~62) |
| Brain | 29.9 | 30.0 (autoreg 1.73) | 24.9 (autoreg 1.00) | ↓ |
| Gut (SMA) | 27.2 | 37.9 | 23.3 | ↓ |
| Kidney | 28.2 | 46.4 | 29.6 | unchanged |
| SVC | 83.7 | 104 | 108 | 99 (day 1) |

The brain set-point (24.9 mL/kg/min, 88 mL/min) is close to the ultrasound values for term babies
(Kehrer 2003, carotid + vertebral: 69 ± 14 mL/min at 39–40 weeks, 83 ± 16 at 41–42). FO now runs left-to-right (+6), MAP 50.2, PAP 48.3, SpO2 97.5 / 96.8;
CVP falls to 1.0. Still 37 of 39 in range (CVP, urine); loaded, it holds for 10 min with the brain
autoregulation at 1.00 and the baroreflex firing at 0.47–0.52.

*Generator fix found on the way:* `Blood.init_model` calibrates the vessel resistances at the viscosity
of the blood the scenario loads with. The generator raised Hct to 55 % in the live model without moving
that reference, so it settled and re-anchored at ~21 % higher vascular resistance than the saved
scenario has on load (MAP 52.0 live vs 50.3 reloaded, brain autoregulation 1.21 and a slow baroreflex
drift after loading). It now takes the viscosity reference at the new Hb, as a load does.

**Step 3c, CVP: the reference, not the model.** The 2–8 mmHg carried from 72 h is a textbook range from
sick, catheterised infants. The only measurements in healthy newborns in the first hours are Siassi
1980: right atrial mean pressure +1.6 mmHg (−3 to +4), A-wave +4.9 (2–8), every 6 h from 2 to 24 h in
24 healthy spontaneously breathing preterm infants, not related to birth weight or gestation (grade C
for a term baby). The model's 1.0 mmHg sits in it, and it is low for physiological reasons: the residual
lung liquid makes the pleural pressure more negative and the ductal circuit returns more of the output
through the lungs and the left heart. The 1 h CVP reference is now 1.6 (−3 to +4); the 72 h one is
unchanged, and the model's 2.4 there gives the rise over the first days.

**Step 3d, urine and GFR.** The 0–1 mL/kg/h urine range came from first-void timing (Ogala 1986), but
that times the first emptying of the bladder, not production; the model has no bladder to fill and its
urine output is production. Production is low before the postnatal diuresis: urine flow stays low for
the first 7–22 h and then rises for ~12 h (Hogg 1977, 7 term babies), and before the diuresis it is
1.6 mL/kg/h on average with periods under 1 (Lorenz 1995, ELBW). The 1 h urine reference is now
0.5–1.5 mL/kg/h (C), and GFR gets a real target, 19.6 mL/min/1.73 m² on day 1 (Smeets 2022, A/B). The
model filtered 24.7 at 1 h (31.0 at 72 h). The glomerular filtration coefficient matures over the first
days, so the 1 h kidney has `Kidneys.kf` x0.8: GFR 20.7, urine 0.93, renal flow unchanged (29.4).
Re-anchoring the renal autoregulation to its 72 h afferent tone was tried and rejected: at the slightly
lower 1 h renal pressure GFR collapsed to ~8 and renal flow to 23 (against Agata's unchanged renal
flow), so the 1 h kidney keeps a near-maximally dilated afferent arteriole (factor 0.50) and has little
dilator reserve if the pressure falls. **All 40 numeric targets are now in range**; loaded, it holds for
10 min (BE drifts −5.15 → −5.19).

**Step 4a, the ductal Doppler pattern.** The duct was bidirectional, but in the wrong order: the aortic
valve opened 33 ms before the pulmonary valve, so each beat began with a left-to-right surge and the
right-to-left flow came in mid–late systole. The classic transitional pattern (bidirectional in all
babies at 2 h, Kang 2016) is right-to-left in early systole and left-to-right in late systole and
diastole. A stronger RV did not change the order (it has to reach almost the same diastolic pressure
as the LV through the open duct), so `Heart.rv_delay` now also takes negative values (the LV
activation lags the RV's). The 1 h baby has the LV lagging by 35 ms and main/branch pulmonary arteries
2.5x stiffer (the sharper systolic PA pressure peak of a small, high-resistance pulmonary tree):

| One beat (459 ms) | After QRS | Duct |
|---|---|---|
| Pulmonary valve opens | 61 ms (aortic 69 ms) | |
| Early systole | 63–175 ms | right-to-left, peak −230 mL/kg/min (−0.9 m/s) at 80 ms |
| Late systole | 180–240 ms | turns left-to-right |
| Diastole | 240–459 ms | left-to-right, ~0.75 m/s after aortic closure, easing to 0.4 m/s |

`probe_pda`: bidirectional signature confirmed (systolic peak −0.60 m/s right-to-left, diastolic
+0.78 m/s left-to-right), right-to-left for 19 % of the cycle, net 74 mL/kg/min left-to-right.
Nothing else moved: 40 of 40 in range (PAP 69/32/50, BP 70/33/51, SpO2 97.5 / 96.6); loaded, it holds
for 10 min. The 72 h baby (`rv_delay` 0) is unchanged.

**Step 4b, blood pressure by the ⅓ rule (2026-10-26).** The 1 h BP reference was the Kent 2007 day-1
median (65/45/50); medians do not add up to a consistent set, and 45 diastolic sat above every first-day
value in Taiwo 2022. It is now Taiwo's healthy term babies within 1 h of birth: 67.4/37.1, MAP 47.2
(dia + PP/3, as the Monitor now reports it; grade A). The baroreflex set-point used while the levers
settle was a time-averaged 50, i.e. a clinical MAP of ~45; it is now 53.5, the time-averaged equivalent of
47.2. Result: 71.4/33.8 (46.4), HR 133, PAP 45.6, LV output 313, duct 80 left-to-right with right-to-left
flow 15 % of the cycle (bidirectional signature confirmed). The diastolic stays ~3 mmHg low and the pulse
pressure ~7 mmHg wide: the large unrestrictive duct and the dilated systemic circulation run off the
aorta in diastole (accepted; raising SVR would also change the output and the duct). All 40 in range;
loaded, it holds for 10 min; respiratory battery 24/24.

## The 12 h scenario

`model_definitions/term_neonate_12h.json`, generated by `node scripts/_make_term_transition.mjs --age 12 --write`
from `term_neonate_72h` (built 2026-10-26). The levers (factors relative to 72 h):

| Lever | Value | Why |
|---|---|---|
| Duct | 2.47 mm at the pulmonary end, 2.72 mm at the aortic end; discharge coefficient 0.3 | Kang 2016 at 12 h; the duct constricts from the pulmonary end (see below) |
| Pulmonary resistance (and `Shunts.ips_res` alike) | x1.5 | PAP mean 41 (Kang 2016) |
| Systemic resistance | x0.65, brain, gut, liver and kidney beds kept at 72 h | output past the surge but still high |
| Heart `el_max` / `heart_rate_ref` | x1.5 / x1.025 | BP 69.8/40.4 (Taiwo 2022), HR 121 |
| Blood volume / Hct | 77 mL/kg / 57 % | the 1 h red cell mass after a further plasma shift |
| Lactate / unmeasured anions | 2.0 / +1.6 mmol/L | GLOW; BE -4 |
| Glucose | 3.2 mmol/L | GLOW |
| Minute volume reference | x1.11 | pCO2 ~35 |
| Lung liquid: alveolar `u_vol` / `el_base` | x0.92 / x1.05 | mostly cleared (Lee 1999) |
| Brain, kidney | as at 1 h (pressure-passive brain re-anchored; `Kidneys.kf` x0.8) | |
| Baroreflex set-point while settling | 56 | the time-averaged equivalent of a clinical MAP of 50 (see below) |
| `Heart.rv_delay` / PA `el_base` | 0 / x1 | no transitional timing: the flow is left-to-right throughout |
| Environment | 24 °C, 50 % humidity | dressed in the room |

**Mean arterial pressure by the ⅓ rule.** Taiwo's MAP is diastolic + pulse pressure / 3 at every time
point (69.8/40.4 → 50.2), as most clinical MAPs are. The model's ascending-aortic waveform has a broad
systolic peak and a nearly linear diastolic fall (form factor (mean − dia)/PP ≈ 0.5, at every age), so
its time-averaged mean sat 5–7 mmHg above the clinical one. Since 2026-10-26 the Monitor reports the
arterial means (`abp_pre`, `abp`, `pap`) by the ⅓ rule and keeps the time-average as
`<name>_pres_mean_int`; the baroreflex still senses the time-averaged pressure, so its set-point is the
time-averaged equivalent of the target (here 56 while settling, 52.7 after re-anchoring).

**The duct.** At 2.47 mm with the open-duct discharge coefficient (0.9) the duct passed 52 mL/kg/min
left-to-right (x1.4 PVR), above the 5–40 estimated from the 1 h flow; half of its pressure loss is the
Bernoulli jet and half viscous. A narrower jet at the constricting pulmonary end (Cd 0.3) with PVR x1.5
gives 31 mL/kg/min. Lowering the duct flow lowers the pulmonary flow and PAP, which widens the gradient,
so the duct and PVR were tuned together. At x1.6 PVR with the 0.9 duct a late-diastolic right-to-left
flow appeared (13 % of the cycle). `probe_pda`: left-to-right 100 % of the cycle, systolic peak 2.0 m/s,
end-diastolic 0.9 m/s.

**Result: all 40 numeric targets in range.** HR 124, BP 69.6/40.0 (49.8), PAP 62/32 (41.9), LV output
253 (290 interpolated), stroke volume 2.03, SVC 98, duct 31 left-to-right, FO −1.2, SpO2 97.5 / 97.3,
SvO2 87, pH 7.362 / pCO2 36.1 / BE −4.4, glucose 3.23, lactate 2.00, Hct 56.9, blood volume 77.7, GFR 24.5,
urine 1.1, temperature 37.0. Off the mean but in range: LV output, PAP systolic (a wide pulmonary pulse),
GFR. Loaded, it holds for 10 min (MAP 49.7–49.9, BE −4.39, brain autoregulation 1.00). Respiratory
battery 24/24 (class `term_12h`), `probe_vitals` clean (profile `neonate_12h`).

## The 24 h scenario

`model_definitions/term_neonate_24h.json`, generated by `node scripts/_make_term_transition.mjs --age 24 --write`
from `term_neonate_72h` (built 2026-10-26). The levers (factors relative to 72 h):

| Lever | Value | Why |
|---|---|---|
| Duct | 1.89 mm at the pulmonary end, 2.08 mm at the aortic end; discharge coefficient 0.25 | Kang 2016 at 24 h (closed in 38 %); constricted a little further than at 12 h |
| Pulmonary resistance (and `Shunts.ips_res` alike) | x1.3 | PAP mean 34 (Kang 2016) |
| Systemic resistance | x0.75, brain, gut, liver and kidney beds kept at 72 h | output 258 (Agata) |
| Heart `el_max` / `heart_rate_ref` | x1.35 / x1.025 | BP 71.3/41.2 (Taiwo 2022), HR 121 |
| Blood volume / Hct | 77 mL/kg / 57 % | as at 12 h |
| Lactate / unmeasured anions | 1.8 / +0.9 mmol/L | GLOW (interpolated); BE -3.5 |
| Glucose | 3.3 mmol/L | GLOW plateau |
| Minute volume reference | x1.12 | pCO2 ~35 |
| Lung liquid: alveolar `u_vol` / `el_base` | x0.96 / x1.02 | the last of it (Lee 1999: FRC 24.9 at 24 h) |
| Brain, kidney | as at 1 and 12 h | |
| Baroreflex set-point while settling | 57 | the time-averaged equivalent of a clinical MAP of 51.2 |
| Environment | 24 °C, 50 % humidity | dressed in the room |

**Result: all 40 numeric targets in range** on the first pass except the duct (26.6 mL/kg/min against the
0–25 estimate); Cd 0.3 → 0.25 brought it to 23. HR 122, BP 71.4/42.1 (51.9), PAP 53/25 (34.4), LV output
240 (258), stroke volume 1.95, SVC 94, duct 23 left-to-right (`probe_pda`: 100 % of the cycle, 2.26 m/s
systolic, 1.76 m/s end-diastolic, a restrictive closing duct), SpO2 97.6 / 97.4, pH 7.378 / pCO2 35.9 /
BE −3.56, glucose 3.33, lactate 1.80, Hct 56.9, blood volume 77.6, GFR 25.3, urine 1.14, temperature 36.98.
Off the mean but in range: PAP systolic (a wide pulmonary pulse, as at 12 h), FRC 29.6 (24.9; the model
reads FRC high at every age), GFR. Loaded, it holds for 10 min (MAP 51.8–51.9, BE −3.55 to −3.57).
`probe_vitals` clean (profile `neonate_24h`); respiratory battery 24/24 (class `term_24h`, static
compliance floor 0.95: the model's compliance rises 0.94 / 0.975 / 0.998 / 1.014 mL/cmH2O/kg at
1 / 12 / 24 / 72 h).

## Venous oxygenation and first-day brown fat (2026-10-27)

The venous saturations were high in every baby, most of all in the first day:
- SVC / RA 87.8 / 85.4 % at 1 h, 82.6 / 82.0 % at 72 h;
- the brain and the organs fitted the measurements; the excess came from the upper- and lower-body beds (skin, muscle).

Those beds carried more flow at 1 h than at 72 h (85 + 43 against 54 + 28 mL/kg/min: the generator dilated
everything but the organs), with more haemoglobin (Hct 55–57 %) and the same O2 use.

**Evidence**

| Site | Value | Population | Source |
|---|---|---|---|
| Right atrium (fibre-optic catheter) | 73.6 ± 5.3 % (P5–P95 65–82), extraction 0.21 ± 0.04 | 10 stable preterms in room air after RDS | van der Hoeven 1996 ([doi](https://doi.org/10.1136/fn.74.3.f177)) |
| Peripheral muscle (NIRS) | extraction 0.264 / 0.228 / 0.237 / 0.220 per 6 h, no change over the first 24 h | 55 healthy term babies | Wolfsberger 2023 ([doi](https://doi.org/10.3389/fped.2023.1276769)) |
| Cerebral (NIRS) | 78.2 % on day 1, 78.3 % on day 2; splanchnic lower, renal higher on day 1 | 38 healthy term babies | Bailey 2013 ([doi](https://doi.org/10.1055/s-0033-1349894)) |
| Sagittal sinus (MRI, QSM) | 72.4 ± 3.4 % | preterms at term-equivalent age | Carmichael 2025 ([doi](https://doi.org/10.1038/s41390-025-03966-6)) |
| RQ, energy expenditure | RQ 0.94 at 6 h, 0.88 at 30 h; VO2 ~6.6–7.2 | 46 term babies before milk feeding | Zoppi 1998 ([doi](https://doi.org/10.1038/sj.ejcn.1600564)) |

The direct venous data give an extraction of ~0.21, i.e. a mixed venous saturation of ~76–78 % at SaO2 97 %. The
indirect route (calorimetry VO2 6.3–7.2 with MRI output ~200 mL/kg/min) gives ~80–84 % by Fick; the measured
ventilation fits VO2 ~7. User decision: the venous data, 70–80 %.

**What changed**
1. **72 h** (`scripts/_fix_term_venous_vo2.mjs`):
   - lung VO2 7.07 → 8.51 mL/kg/min, the extra in the upper and lower body, gut and liver; the brain and kidney keep their absolute use;
   - mixed venous 82.0 → 78.5 %;
   - ventilation 213 → 250 mL/kg/min (215 measured in quiet sleep: an accepted deviation).
2. **Brown-fat O2 at the brown fat:** `Metabolism.bat_site` (`RUB`, the upper body). Before, the brown-fat O2 cost was spread over every bed, the brain included.
3. **First-day brown fat** (`NST_W_PER_KG` in the generator):
   - the heat is added to the loss after the trim seeds, and the set-point rises by heat / `bat_gain`, so the core stays at ~37 °C;
   - brown fat is most active right after birth (birth cooling, catecholamines, the TSH peak);
   - at 12 and 24 h the upper and lower body also keep part of their tone (bed factor 0.8). At 1 h they stay dilated: toned, they sent the output through the large duct (left-to-right 117 mL/kg/min).
4. **pCO2:** about 39–40 at every age (within each age's range). At 35–36 the higher CO2 output needed ~295 mL/kg/min.

| | 1 h | 12 h | 24 h | 72 h |
|---|---|---|---|---|
| Brown fat (W/kg) / body bed factor | 0.45 / dilated | 0.3 / 0.8 | 0.3 / 0.8 | – |
| RA (RAIVCI / RASVC) | 80.2 / 79.4 (was 85.4) | 80.1 / 79.5 (85.3) | 80.3 / 79.6 (85.4) | 78.5 / 78.2 (82.0) |
| SVC / IVC | 79.8 / 81.2 | 78.7 / 81.9 | 78.6 / 82.1 | 79.0 / 79.0 |
| PA (the probe's SvO2; ductal admixture) | 85.1 | 82.4 | 81.8 | 78.5 |
| Brain venous | 65.7 | 70.1 | 70.5 | 67.2 |
| Lung VO2 (mL/kg/min) | 10.1 | 9.5 | 9.6 | 8.5 |
| Ventilation (mL/kg/min) / pCO2 | 287 / 39.8 | 279 / 39.0 | 281 / 38.8 | 250 / 39.5 |

The 1–2 points the RA stays above 72 h come from the IVC, i.e. the kidney (87–88 %), which the renal NIRS also shows
higher on day 1. References: SvO2 (pulmonary artery) 82 / 78 / 78 / 76 % at 1 / 12 / 24 / 72 h (70–87 / 70–84 / 70–84 /
70–80); VO2 10 / 9.5 / 9.5 / 8.4. The higher first-day ventilation through a lung with residual liquid takes the pleural
swing to 8.2–8.6 cmH2O, so the transitional respiratory classes allow 2–9 (quiet breathing 2–8, Bhutani). Every baby
still has all its numeric targets in range and holds for 10 min. Not modelled: the rise of brown-fat blood flow with
thermogenesis, which matters only in a cold room.

## Hemodynamics

| Variable | 1 h | 12 h | 24 h | 72 h | Grade | Source |
|---|---|---|---|---|---|---|
| Heart rate (bpm) | 126 (P2–P98 102–162) at 2 h | 120–122 | 120–122; 121 ± 11 | 118 | A at 2/24 h | Tveiten 2021; Agata 1991 |
| SBP/DBP/MAP (mmHg) | **67.4/37.1/47.2** (SD 7.9/6.1/5.8) within 1 h of birth | **69.8/40.4/50.2** (SD 7.8/6.4/5.8) | 71.3/41.2/51.2 | 74/46/58 | A at 1/12/24 h | Taiwo 2022 (healthy term, at birth, 6, 12, 24, 36, 48 h; MAP = dia + PP/3); Kent 2007 (day-1 median 65/45/50, superseded); He 2011 (66/33/44 → 71/38/49, day 1 → 3) |
| LV output (mL/kg/min) | **327 ± 66; 365 ± 69** | ~290 (301 at 4–8 h) | 245 ± 56; 272 ± 48 | 196 (MRI) / 258 (echo, 96 h) | A | Agata 1991, 1994 |
| LV stroke volume (mL/kg) | 2.25 ± 0.37 | – | 2.02 ± 0.42 | 1.6 | A | Agata 1991 |
| SVC flow (mL/kg/min) | 99 (day 1) | 99 | 99 | 77–83 | B | Lee 2009 |
| PAP mean (mmHg) | ~45 (ratio ~0.9) | 41 ± 9 | 34 ± 10 | 25 ± 8 | B / A-B | Skinner 1991; Kang 2016 |
| PAP systolic (mmHg) | ~58 | 52.5 ± 9.1 | 43.8 ± 7.9 | 36 ± 6.5 | B / A-B | Kang 2016 |
| Cerebral (MCA) flow | lower than after 24 h (gut too; renal unchanged) | – | rises | – | B (direction) | Agata 1994 |
| CVP / right atrial mean (mmHg) | 1.6 (−3 to +4), 2–24 h | – | – | 2–8 (textbook, sick infants) | C (healthy preterm) | Siassi 1980 |

## Shunts

| Variable | 1 h | 12 h | 24 h | 72 h | Grade | Source |
|---|---|---|---|---|---|---|
| Ductal diameter (mm) | 4.60 ± 0.59 (2 h) | 2.47 ± 0.49 | 1.89 ± 0.41 | 1.20 ± 0.24 | A | Kang 2016 |
| Duct closed | 0 % | 0 % | 38 % (Lim 1992: 20 % day 1) | 95 % (Lim: 96 % day 3) | A | Kang 2016; Lim 1992 |
| Ductal direction | bidirectional in 100 % (2 h) | L→R only in 88 % | L→R | closed | A | Kang 2016 |
| Ductal L→R flow (mL/kg/min) | 62 (95 % CI 43–82) shortly after birth | falling fast; ~5–40 (derived from the diameter) | small; ~0–25 (derived) | unmeasurable by 48 h | B (n = 10) | Drayton 1987 |
| Foramen ovale | shunt in 92 % at ~40 min, mostly L→R, small diastolic R→L in 64 % | – | patent in 22/37 | shunt in 47 % (days 4–5), R→L in 19 % | A | Hiraishi 1991; Lim 1989 (patency) |

## Lungs and breathing

| Variable | 1 h | 12 h | 24 h | 72 h | Grade | Source |
|---|---|---|---|---|---|---|
| FRC (mL/kg) | 23.1 at 4–6 h (vaginal); TGV 32.7 < 6 h | – | 24.9 | 27.1 | A | Lee 1999; Milner 1978 |
| Compliance | lower on day 0 | – | higher from day 1 | 3.6 mL/cmH2O | B (direction) | Lødrup Carlsen 1993 |
| Tidal volume | lower on day 0 | – | rises from day 0 to day 1 | 5.6 mL/kg | B (direction) | Lødrup Carlsen 1993 |
| RR, minute ventilation | no data | – | – | 44; 215 mL/kg/min | – | carried from 72 h |
| SpO2 (%) | 96 ± 1 (1.5–13.5 h); median 98.3 (0–24 h) | 98 | 98 | 97.3 | A | Nikkola 2002; O'Brien 2000 |
| Pre/post-ductal gradient | gone by 15 min | – | – | – | A | Mariani 2007 |

## Gases and metabolism

| Variable | 1 h | 12 h | 24 h | 72 h | Grade | Source |
|---|---|---|---|---|---|---|
| pH / pCO2 / BE | 7.32 / 36 / −5 | 7.36 / 35 / −4 | 7.37 / 35 / −3.5 | 7.395 / 38.7 / −4..2 | C at 1, 12 and 24 h | textbook; cord UA P10 pH 7.21, BD 5.9 (Dudenhausen 1997) |
| Lactate (mmol/L) | 2.2 (1.1–6.2), 0–12 h | 2.0 | ~1.8 (interpolated) | 1.4 (0.8–3.3) | A | GLOW 2021 |
| Glucose (mmol/L) | ~3.3; 1 h not lower than later | ~3.2, rising to the plateau by 18 h | 3.3 ± 0.6 plateau | 3.3–4.6 (day 4: 4.6) | A/B | GLOW 2020; Hoseth 2000 |
| VO2 (mL/kg/min) | 7.0 (decision) | 7.0 | 7.0 | 6.3–7.0 | B | Hill & Robinson 1968 (~5 < 12 h, LBW) |
| Temperature (°C) | 36.8 (skin-to-skin rewarms 36.3 → 37.0 in 1 h) | 36.9 | rectal lower on day 1 than day 2 | 37.0 | B | Karlsson 1996; Fransson 2005 |
| Catecholamines | raised plateau to 3 h | adult resting level | resting | resting | B (no numbers) | Eliot 1980 |

## Blood and kidneys

| Variable | 1 h | 12 h | 24 h | 72 h | Grade | Source |
|---|---|---|---|---|---|---|
| Haematocrit (%) | ~55 (1-min DCC; 57.0 at 6 h) | ~57 | 56–59 (3-min DCC) | 49.5 (mixed clamping) | A/B | Ceriani Cernadas 2006; Linderkamp 1992; Nelle 1993; Jopling 2009 |
| Blood volume (mL/kg) | ~80 (75–85) | ~77 (red cell mass 44 at Hct 57) | ~77 | 80–90 | B (derived) at 1 h | Linderkamp 1992; Nelle 1995 |
| First void | none yet (42 % by 6 h) | 76 % voided | 95 % | – | A | Ogala 1986 |
| Urine production (mL/kg/h) | low before the diuresis (0.5–1.5) | diuresis starts (7–22 h) | in the diuresis (1–3) | 1–3 (textbook) | C | Hogg 1977; Lorenz 1995 |
| GFR (mL/min/1.73 m²) | 19.6 (day 1) | – | 19.6 (day 1) | ~30 (day 3) | A/B | Smeets 2022 |

## Sources

All found through PubMed; full citations, DOIs and PMIDs are in the JSON sets.

- Agata Y 1991, J Pediatr 119:441 ([doi](https://doi.org/10.1016/s0022-3476(05)82060-8)); Agata Y 1994, Pediatr Res 36:805 ([doi](https://doi.org/10.1203/00006450-199412000-00022))
- Tveiten L 2021, Arch Dis Child Fetal Neonatal Ed ([doi](https://doi.org/10.1136/archdischild-2020-320761))
- Taiwo AB 2022, Glob Pediatr Health 9:2333794X221099263, blood pressure at birth, 6, 12, 24, 36 and 48 h in 123 healthy term controls ([doi](https://doi.org/10.1177/2333794X221099263))
- Kent AL 2007, Pediatr Nephrol 22:1335 ([doi](https://doi.org/10.1007/s00467-007-0480-8)); He 2011, Chin Med J 124:2284 (PMID 21933558)
- Kang C 2016, Medicine 95:e2599 ([doi](https://doi.org/10.1097/MD.0000000000002599)); Lim MK 1992, Arch Dis Child ([doi](https://doi.org/10.1136/adc.67.10_spec_no.1217))
- Drayton MR 1987, Arch Dis Child 62:1030 ([doi](https://doi.org/10.1136/adc.62.10.1030)); Skinner JR 1991, Arch Dis Child 66:386 ([doi](https://doi.org/10.1136/adc.66.4_spec_no.386))
- Hiraishi S 1991, Br Heart J 65:41 ([doi](https://doi.org/10.1136/hrt.65.1.41)); Lim 1989, Early Hum Dev (PMID 2691234)
- Kehrer M 2003, Neuropediatrics 34:281, cerebral blood flow volume in preterm and term neonates (PMID 14681752, [doi](https://doi.org/10.1055/s-2003-44663))
- Hogg MI 1977, Br J Anaesth 49:891, urine flow in the first 24–40 h ([doi](https://doi.org/10.1093/bja/49.9.891)); Lorenz JM 1995, Pediatrics 96:484 (PMID 7651782)
- Siassi B 1980, Biol Neonate 37:285, right atrial pressure in the first 24 h ([doi](https://doi.org/10.1159/000241288))
- Lee A 2009, SVC flow ([doi](https://doi.org/10.1136/adc.2009.176883))
- Lee S 1999, Pediatr Pulmonol 27:318 (PMID 10344710); Milner AD 1978, Arch Dis Child 53:545 ([doi](https://doi.org/10.1136/adc.53.7.545)); Lødrup Carlsen KC 1993 (PMID 8112445)
- Nikkola E 2002, Acta Paediatr ([doi](https://doi.org/10.1080/080352502760272605)); O'Brien LM 2000 ([doi](https://doi.org/10.1136/fn.83.1.f35)); Mariani G 2007, J Pediatr 150:418 ([doi](https://doi.org/10.1016/j.jpeds.2006.12.015))
- Dudenhausen JW 1997, cord gases ([doi](https://doi.org/10.1016/s0020-7292(97)02890-7))
- Harris DL 2020 (GLOW glucose) ([doi](https://doi.org/10.1016/j.jpeds.2020.02.079)); Harris DL 2021 (GLOW lactate) ([doi](https://doi.org/10.1016/j.jpeds.2020.12.063)); Hoseth E 2000 ([doi](https://doi.org/10.1136/fn.83.2.f117))
- Hill JR, Robinson DC 1968, J Physiol 199:685 ([doi](https://doi.org/10.1113/jphysiol.1968.sp008673))
- Karlsson H 1996 ([doi](https://doi.org/10.1136/fn.75.2.f130)); Fransson AL 2005 ([doi](https://doi.org/10.1136/adc.2004.066589))
- Eliot RJ 1980, J Pediatr 96:311 ([doi](https://doi.org/10.1016/s0022-3476(80)80836-5))
- Nelle M 1995, Am J Perinatol 12:212 ([doi](https://doi.org/10.1055/s-2007-994455))
- Ceriani Cernadas JM 2006, Pediatrics 117:e779 ([doi](https://doi.org/10.1542/peds.2005-1156)); Linderkamp O 1992, Acta Paediatr ([doi](https://doi.org/10.1111/j.1651-2227.1992.tb12095.x)); Nelle M 1993 ([doi](https://doi.org/10.1016/0002-9378(93)90161-b)); Jopling J 2009 ([doi](https://doi.org/10.1542/peds.2008-2654))
- Ogala WN 1986 (PMID 3810846)

## Gaps

- Blood gases (pH, pCO2, pO2, BE) at 1, 12 and 24 h: the classic series need full text.
- Hourly blood pressure in the first hours (Kitterman 1969, Versmold 1981: no abstracts); Taiwo 2022 gives 6-hourly values from birth.
- Respiratory rate, tidal volume and compliance values in the first hours (direction only).
- Plasma catecholamine levels by hour (Eliot 1980 full text).
- Measured blood volume after 1-min clamping (Yao 1969 not in PubMed); the 1 h value is derived.

```

### FILE: explain-engine/docs/Thermoregulation.md

````markdown
# Thermoregulation

`Thermoregulation` is the body-temperature controller. It integrates a heat balance:
- **production:** metabolic heat from the O2 consumption, plus brown-fat thermogenesis below the set-point;
- **loss:** radiation, convection, evaporation, and the heat spent warming and humidifying inspired gas;
- **exchange with the blood pool:** heat flows by perfusion between the body (tissue) and the blood.

From the resulting core temperature it drives:
- the Q10 effect on O2 use (Metabolism);
- the heart-rate change with temperature (Heart);
- the temperature the blood and the airway gas warm toward (Blood, Gas).

It holds no compartment and is neutral at rest: a trim captured at warm-up balances the scenario's own environment.

## Physiology

A newborn loses heat quickly: a large surface for its mass, thin skin and little fat. The losses are:
- **radiation** to cooler surroundings and **convection** to the air;
- **evaporation**, very large in an extremely preterm infant in dry air;
- **respiration:** warming and humidifying inspired gas.

The thermoneutral environment (32–36 °C, higher for smaller infants) minimises the energy spent keeping warm. Newborns cannot shiver: in the cold they burn brown fat (non-shivering thermogenesis), which raises O2 consumption. Hypothermia slows metabolism (Q10 ≈ 2–2.5) and the heart; fever does the reverse.

## Inheritance

```
BaseModelClass
  └── Thermoregulation
```

## Properties

### Config: environment and switches

| Property | Unit | Default | Description |
|---|---|---|---|
| `thermoregulation_running` | boolean | `true` | Switch. Off releases the owned channels once. |
| `env_temp` | °C | 32 | Air temperature (term 32, preterm 34–36, fetus 37.3 for the amniotic fluid). |
| `radiant_temp` | °C or null | null | Radiant warmer temperature; null = `env_temp`. |
| `rel_humidity` | 0–1 | 0.5 | Ambient humidity (term 0.5, preterm 0.6–0.8, fetus 1). |
| `respiratory_heat_loss` | boolean | `true` | Count the airway conditioning heat (off in the fetus). |
| `resp_window` | s | 30 | Averaging window for the respiratory heat (must span several breaths). |
| `metabolism_name`, `heart_name`, `blood_name`, `gas_name` | – | the model names | Wiring. |

### Config: body and effectors

| Property | Unit | Default | Description |
|---|---|---|---|
| `setpoint_temp` | °C | 37 | Hypothalamic set-point (fetus 37.5). |
| `heat_capacity` | J/(kg·K) | 3470 | Specific heat of tissue. |
| `surface_area_k` | – | 0.097 | Body surface = k · weight^(2/3) m² (Meeh); 0.226 m² at 3.545 kg, as Haycock at 50 cm. |
| `h_radiative`, `h_convective` | W/(m²·K) | 5.2, 4.9 | Heat-transfer coefficients per total surface: radiative 6.7 per exposed skin (Sjörs 1997) × 78 % radiating area, convective under natural convection in an incubator (Apedoh 1999, term mannequin). |
| `evap_coeff` | W/m² | 6.0 | Skin evaporative loss per unit dryness (1 − humidity); with the respiratory heat metered separately (`Q_resp`), term skin ≈ respiratory loss at 50 %, as measured (Riesenfeld 1995). |
| `caloric_equiv_o2` | J/mL O2 | 20.1 | Heat per mL O2 consumed. |
| `blood_density`, `cp_blood` | kg/L, J/(kg·K) | 1.06, 3800 | Blood heat capacity. |
| `blood_temp_tc` | s | 10 | Perfusion equilibration time constant (match `Blood.blood_temp_tc`). |
| `bat_gain`, `bat_max_per_kg` | W/°C, W/kg | 6, 4.5 | Brown-fat heat per °C below the set-point, and its ceiling (0 in the fetus). |
| `q10` | – | 2.3 | Metabolic Q10. |
| `vo2_temp_factor_min`, `vo2_temp_factor_max` | – | 0.5, 2.5 | Clamp on the Q10 factor. |
| `hr_temp_gain` | 1/°C | 0.1 | Heart-rate factor change per °C. |
| `hr_temp_factor_min`, `hr_temp_factor_max` | – | 0.6, 1.6 | Clamp on the heart-rate factor. |

### Baseline (captured, saved with the state)

| Property | Unit | Description |
|---|---|---|
| `loss_trim` | W | Heat-loss offset (insulation, posture) that balances production at the set-point in the scenario's environment. |
| `loss_trim_seeded` | boolean | The trim has been captured. A fresh build starts at the set-point; a saved state keeps its own core temperature. |

### Outputs

| Property | Unit | Description |
|---|---|---|
| `core_temp`, `skin_temp`, `skin_gradient` | °C | Core, skin read-out (= core − `skin_gradient`, 1 °C) and the gradient. |
| `heat_production`, `heat_loss`, `brown_fat_heat` | W | Production, effective loss (with the trim), brown-fat part. |
| `q_respiratory`, `q_perfusion` | W | Airway conditioning heat; tissue → blood heat flow. |
| `blood_temp_mean` | °C | Heat-capacity-weighted mean blood temperature. |
| `vo2_temp_factor`, `vo2_bat_factor`, `hr_temp_factor` | – | Applied effects. |

## Calculation

Every 1 s:
```
Q_prod = vo2 · vo2_factor · vo2_temp_factor · weight / 60 · 20.1  +  brown fat     (W)
brown fat = min(bat_gain · max(0, set-point − core), bat_max_per_kg · weight)
SA     = surface_area_k · weight^(2/3)
Q_loss = SA·[h_rad·(core − radiant) + h_conv·(core − env)] + SA·evap_coeff·(1 − humidity) + Q_resp + loss_trim
Q_perf = (C_blood / blood_temp_tc) · (core − blood_mean)      C_blood = Σ vol·ρ·cp over the blood compartments Blood relaxes
d core / dt = (Q_prod − Q_loss − Q_perf) / (weight · heat_capacity − C_blood)
```
- **`Q_resp`** is the heat the airway compartments actually spent warming and humidifying gas, metered by [GasCapacitance](./GasCapacitance.md) and drained through [`Gas.drain_respiratory_heat`](./Gas.md), averaged over `resp_window`. It is signed, so heat recovered when expired gas cools in the dead space is credited back. It works the same under mechanical ventilation and in apnoea.
- **The trim** is captured once, after 5 s and a full `resp_window`, so production equals loss at the set-point.

**Effects** (written every update):
- `Metabolism.vo2_temp_factor = q10^((core − 37)/10)` (clamped);
- `Metabolism.vo2_bat_factor`: brown fat's O2 cost added to Metabolism's O2 use (its heat is counted once, above), taken from `Metabolism.bat_site` (the upper body);
- `Heart.hr_temp_factor = 1 + hr_temp_gain · (core − set-point)` (clamped);
- `Blood.set_perfusion_target(core)` and `Gas.set_body_temperature(core)`.

**Example** (term_neonate_72h, room moved from 32 to 24 °C):
- after 20 min: core 35.9 °C, brown fat 6.6 W (doubling Metabolism's O2 use, `vo2_bat_factor` 1.97), heart-rate factor 0.89, Q10 factor 0.91;
- after 40 min: core 35.3 °C.

## Factor system

It owns `Metabolism.vo2_temp_factor`, `vo2_bat_factor` and `Heart.hr_temp_factor`, and sets the perfusion and airway temperature targets.

## Inputs and outputs

- **Reads:** Metabolism (`vo2`, `vo2_factor`); `Blood.get_thermal_state`; `Gas.drain_respiratory_heat`; `model.weight`.
- **Writes:** the channels above.
- **Written by:** the user (environment, warmer, humidity, switch).
- **Read by:** Gas (its `setpoint_temp`, at build), `DataCollector` watchers, the Monitor.

## Assumptions and limitations

- **Heat production counts Metabolism only,** not the myocardium (Mob); the trim absorbs it at rest, but a change in cardiac work doesn't change heat.
- **Heat-loss geometry** (re-validation, term_neonate_72h): until then the surface area was half the real one (`surface_area_k` 0.05 → 0.116 m²) with coefficients above the measured ones (9.6 and 7.0 W/(m²·K)); the errors partly cancelled. Now 0.226 m² with 5.2 and 4.9; the dry-loss sensitivity is SA·(h_rad + h_conv) = 2.28 W/K (was 1.93), and the resting trim is −5.26 W (was −3.23), because the losses are computed from core rather than skin temperature.

  | Ambient step from 32 °C, 60 min | Before | Now |
  |---|---|---|
  | to 28 °C | 36.99 → 36.02 (brown fat 5.9 W) | 36.98 → 35.88 (brown fat 6.7 W) |
  | to 35 °C | 36.99 → 38.38 | 36.98 → 38.54 |

  Skin evaporation is now 0.68 W against ~0.8 W respiratory heat on room air (it was 0.35 W; the earlier note that `evap_coeff` double-counted the respiratory loss was wrong: the skin share was too small).
- **The perfusion coupling is energy-exact:** its mass is the heat capacity of the relaxed blood compartments (term 1212 J/K, 301 mL), not the former 0.08 L/kg estimate (1142 J/K). `Q_perf` is only the heat the blood takes up while the core moves (0.05–0.07 W while a heated humidifier warms the core) and returns to 0 (0.003 W after 5 h); the 1.2 W "sustained" in the docs pass came from an older state.
- **Heated humidifier** (inspired gas 37 °C, 100 %): respiratory heat 0.79 → −0.09 W; the core rises slowly (time constant ~2 h; no heat defence such as sweating or vasodilation is modelled): +0.18 °C after 1 h, +0.43 °C after 5 h and levelling off near +0.45 °C (the docs pass reported ~0.04 °C from a short window).
- **Respiratory water loss** isn't conserved (only its heat is charged).
- **The inspired air (`MOUTH`, 20 °C) and `env_temp` are independent:** a cold room doesn't cool the inspired gas.
- **No skin node, no peripheral vasoconstriction:** skin temperature is a fixed offset; the infant's own vasomotor defence is not modelled.

## Example definition (JSON)

From `term_neonate_72h.json`, `models.Thermoregulation` (trimmed to the main config):

```json
{
  "name": "Thermoregulation",
  "model_type": "Thermoregulation",
  "is_enabled": true,
  "thermoregulation_running": true,
  "env_temp": 32,
  "radiant_temp": null,
  "rel_humidity": 0.5,
  "respiratory_heat_loss": true,
  "setpoint_temp": 37,
  "surface_area_k": 0.097,
  "bat_gain": 6,
  "bat_max_per_kg": 4.5,
  "q10": 2.3
}
```

## Usage in the scenarios

One instance in every scenario.

| Scenario | `env_temp` (°C) | Humidity | Set-point | Brown fat | Respiratory heat |
|---|---|---|---|---|---|
| term_neonate_72h | 32 | 0.5 | 37 | yes | yes |

## References

- Sjörs G, Hammarlund K, Sedin G. Thermal balance in term and preterm newborn infants nursed in an incubator equipped with a radiant heat source. *Acta Paediatr* 1997;86:403–9. doi:10.1111/j.1651-2227.1997.tb09031.x (term skin 35.4 °C; radiative loss 32.8 W/m² exposed skin at a 30.5 °C roof)
- Apedoh A, et al. Mannequin-assessed dry-heat exchanges in the incubator-nursed newborn. *Biomed Instrum Technol* 1999;33:446–54. PMID 10511915 (convective 4.94, radiative 4.77 W/(m²·°C); radiating area 78 %, mattress contact 10 %)
- Riesenfeld T, Hammarlund K, Sedin G. Respiratory water loss in relation to gestational age in infants on their first day after birth. *Acta Paediatr* 1995;84:1056–9. doi:10.1111/j.1651-2227.1995.tb13824.x (term: respiratory ≈ transepidermal water loss at 50 % humidity)
- Sedin G, Hammarlund K, Strömberg B. Transepidermal water loss in full-term and pre-term infants. *Acta Paediatr Scand Suppl* 1983;305:27–31. doi:10.1111/j.1651-2227.1983.tb09855.x (skin evaporation falls linearly with ambient humidity)

The loss trim makes every scenario neutral at its own environment.

````

### FILE: explain-engine/docs/TimeVaryingElastance.md

````markdown
# TimeVaryingElastance

A `TimeVaryingElastance` is an elastic compartment whose stiffness changes during the heartbeat. It moves between a relaxed (diastolic) and a contracted (systolic) pressure–volume relation, driven by an activation signal from the `Heart`. It is the base of every heart chamber and of the coronary bed.

## Physiology

Heart muscle is soft when relaxed and stiff when contracted. If a chamber's volume is held fixed, its pressure therefore rises during systole and falls during diastole. The *time-varying elastance* concept (Suga and Sagawa) captures this with one number that changes over the cycle:

- **Diastole.** The chamber sits on its *end-diastolic pressure–volume relation*: low elastance (`el_min`), so it fills at low pressure. A stiff, poorly relaxing ventricle (diastolic dysfunction) has a high `el_min`.
- **Systole.** The elastance rises to `el_max`, the slope of the *end-systolic pressure–volume relation* and the classic load-independent index of contractility. A higher `el_max` means a stronger contraction.
- **In between,** the activation signal from the `Heart` (0 at rest, 1 at peak contraction) blends the two curves. That one signal produces ejection, isovolumic relaxation and filling, depending on the valves and the pressures around the chamber.

The same mechanism drives the coronary bed: the contracting myocardium squeezes the intramural vessels in systole.

## Inheritance

```
BaseModelClass
  └── TimeVaryingElastance
        ├── HeartChamber               (+ blood composition, ANS/drug/load contractility; own factor composition)
        └── BloodTimeVaryingElastance  (+ blood composition)
```

`HeartChamber` overrides `calc_elastances` and `calc_volumes` (extra layers; see [HeartChamber](./HeartChamber.md)) but uses `calc_pressure` from this class. `BloodTimeVaryingElastance` uses all of this class's calculation.

## Properties

### Config (set in the definition JSON)

| Property | Unit | Default | Description |
|---|---|---|---|
| `u_vol` | L | 0.0 | Unstressed volume (the end-systolic and end-diastolic relations share it). |
| `el_min` | mmHg/L | 0.0 | Minimal (diastolic) elastance. |
| `el_max` | mmHg/L | 0.0 | Maximal (end-systolic) elastance: contractility. |
| `el_k` | mmHg/L² | 0.0 | Non-linear term of the diastolic relation, above `u_vol` only. The heart chambers of every scenario use a pure quadratic diastolic relation (`el_min` 0, `el_k` > 0); see [HeartChamber](./HeartChamber.md#the-diastolic-relation). |
| `vol` | L | 0.0 | Volume; the starting volume in a definition. |
| `u_vol_factor`, `el_min_factor`, `el_max_factor`, `el_k_factor` | – | 1.0 | Non-persistent factors, reset to 1 every step. |
| `u_vol_factor_ps`, `el_min_factor_ps`, `el_max_factor_ps`, `el_k_factor_ps` | – | 1.0 | Persistent factors. |
| `u_vol_factor_scaling_ps`, `el_min_factor_scaling_ps`, `el_max_factor_scaling_ps`, `el_k_factor_scaling_ps` | – | 1.0 | Persistent scaling factors. |

### Outputs

| Property | Unit | Default | Description |
|---|---|---|---|
| `pres_in` | mmHg | 0.0 | Recoil pressure of the wall. |
| `pres` | mmHg | 0.0 | `pres_in + pres_ext`: what the valves and connectors read. |
| `el_min_eff`, `el_max_eff`, `el_k_eff` | mmHg/L, mmHg/L² | 0.0 | Effective values after the factor layers. `el_max_eff` is kept ≥ `el_min_eff`. |
| `u_vol_eff` | L | 0.0 | Effective unstressed volume, floored at 0. |

### Set by other models

| Property | Unit | Default | Description |
|---|---|---|---|
| `act_factor` | – | 0.0 | Activation, 0 (relaxed) to 1 (fully contracted). Written every step by `Heart`: `aaf` for the atria, `vaf` for the LV and the coronaries, `rvaf` for the RV (equal to `vaf` unless `Heart.rv_delay` is set). A saved value is overwritten on the first step. |
| `pres_ext` | mmHg | 0.0 | External pressure for this step (the `PERICARDIUM` container), reset after use. |

## Calculation

`calc_model()` runs `calc_elastances()` → `calc_volumes()` → `calc_pressure()`.

1. **`calc_elastances`**: `el_min_eff`, `el_max_eff` and `el_k_eff` from the base value and the three layers, composed additively. `el_max_eff` is raised to `el_min_eff` if it falls below it. The non-persistent factors are then reset.
2. **`calc_volumes`**: `u_vol_eff` from the three layers, floored at 0. `u_vol_factor` is reset.
3. **`calc_pressure`**, with `S = vol − u_vol_eff`:

   ```
   p_es    = el_max_eff · S                                     end-systolic relation (linear)
   p_ed    = (S > 0 ? el_k_eff · S² : 0) + el_min_eff · S       end-diastolic relation
   pres_in = p_ed + (p_es − p_ed) · act_factor
   pres    = pres_in + pres_ext
   pres_ext = 0
   ```

   At `act_factor` 0 the chamber is on its diastolic curve, at 1 on its systolic curve, and in between the pressure is blended linearly.

**Volume transfer.** `volume_in(dvol, comp_from)` adds `dvol` (the blood subclasses also mix the composition). `volume_out(dvol)` removes it, stops at 0 and returns what could not be removed, as in [Capacitance](./Capacitance.md). There is no `fixed_composition` here.

## Factor system

`u_vol`, `el_min`, `el_max` and `el_k` each carry the three layers, composed **additively** in this class (see [ARCHITECTURE §7a](./ARCHITECTURE.md#7a-the-factor--effective-value-pattern)). `HeartChamber` replaces this with its own composition. Writers in the current code:

| Layer | Writers |
|---|---|
| `_factor` (reset every step) | `HeartChamber` internally (ANS, drugs, load) |
| `_factor_ps` | `Heart`: `set_contractility` → `el_max_factor_ps`, `set_relaxation` → `el_min_factor_ps` (left and right separately); the `Calibrator` (`el_max_factor_ps`); the user via `setPropValue` |
| `_factor_scaling_ps` | `ModelScaler` (`scale_heart_el_min`/`el_max`, whole heart or left/right) |

## Inputs and outputs

- **Reads:** nothing from other models; `act_factor` and `pres_ext` are written onto it.
- **Written by:** `Heart` (`act_factor`, contractility and relaxation factors); `PERICARDIUM` (`pres_ext`); the connected resistors and valves (volume); `ModelScaler`.
- **Read by:**
  - the valves and connectors (`pres`), and `Heart` (volumes and pressures for the per-beat analysis: EDV, ESV, SV, EF);
  - `Resistor`s with `implicit`, which read the instantaneous local elastance: the diastolic `el_min_eff + 2·el_k_eff·S` blended toward `el_max_eff` by `act_factor`;
  - `DataCollector` watchers (PV loops).

## Assumptions and limitations

- **One unstressed volume for both relations.** The end-systolic relation passes through `u_vol` (`V0` = `u_vol`); a separate `V0` for the ESPVR isn't modelled.
- **Linear systolic relation.** `el_max` is a constant slope; the curvature of the real ESPVR at high loads is ignored.
- **Quadratic, not exponential, diastolic relation.** The diastolic term is `el_min·S + el_k·S²`; real EDPVRs are steeper (power law with exponent ~2.8, Klotz 2006). A pure quadratic (used for the heart chambers) is the closest this form gets. Apart from it, the pericardium is the only diastolic non-linearity.
- **No force–velocity or length-dependent activation.** Contraction depends on volume and activation only. Shortening deactivation and the Frank–Starling length effect on activation aren't modelled; preload acts through the pressure–volume relation alone.
- **Below the unstressed volume** the systolic term goes strongly negative (`el_max · S`), which acts as early-diastolic suction.

## Example definition (JSON)

No scenario uses a plain `TimeVaryingElastance`. The coronary bed uses this class's calculation unchanged; from `term_neonate_72h.json`, `models.Mob.components.COR` (a `BloodTimeVaryingElastance`, trimmed to the props this class defines):

```json
{
  "name": "COR",
  "model_type": "BloodTimeVaryingElastance",
  "is_enabled": true,
  "u_vol": 0.00028,
  "el_min": 30000,
  "el_max": 90000,
  "el_k": 0,
  "vol": 0.00067
}
```

## Usage in the scenarios

Six instances in every shipped scenario:

| Instance | Class | Activation | term_neonate_72h `el_min` / `el_k` / `el_max` | `u_vol` (mL) |
|---|---|---|---|---|
| `LV` | HeartChamber | `vaf` | 0 / 1.56·10⁵ / 30478 | 0.73 |
| `RV` | HeartChamber | `rvaf` | 0 / 8.85·10⁴ / 9826 | 1.20 |
| `LA` | HeartChamber | `aaf` | 0 / 2.11·10⁵ / 2975 | 0 |
| `RAIVCI`, `RASVC` | HeartChamber | `aaf` | 0 / 9.20·10⁵ / 5947 each | 0 |
| `COR` | BloodTimeVaryingElastance | `vaf` | 30000 / 0 / 90000 | 0.28 |

(`el_min`, `el_max` in mmHg/L, `el_k` in mmHg/L².)

The heart chambers are owned by `Heart`, the coronary bed by `Mob`.

## References

- Suga H, Sagawa K, Shoukas AA. Load independence of the instantaneous pressure-volume ratio of the canine left ventricle and effects of epinephrine and heart rate on the ratio. *Circ Res* 1973;32(3):314–322. [doi:10.1161/01.res.32.3.314](https://doi.org/10.1161/01.res.32.3.314) (the time-varying elastance concept).

The elastance and unstressed-volume values are scenario calibrations (see the `*Reference.md` pages).

````

### FILE: explain-engine/docs/Units.md

```markdown
# Units

`helpers/Units.js` holds the engine's shared physical constants and unit conversions. Every model that converts between gas volumes and amounts, or needs water vapour pressure, imports them from here, so each constant is defined once.

## Physiology

Gas amounts in physiology are quoted in two ways:
- **Volumes at STPD** (0 °C, 760 mmHg, dry): oxygen consumption (VO2, mL/kg/min), Hüfner's constant (1.36 mL O2 per g Hb), O2 solubility (0.0031 mL/dL per mmHg). At STPD one mmol of gas occupies 22.414 mL, whatever the body temperature.
- **Partial pressures** in gas mixtures, from the ideal gas law. Gas in the airways and alveoli is saturated with water vapour at body temperature (47 mmHg at 37 °C), which dilutes the other gases (the "− 47" in the alveolar gas equation).

## API

| Export | Value | Meaning |
|---|---|---|
| `O2_MMOL_PER_ML` | 1 / 22.414 mmol/mL | Every mL O2 (or CO2) ↔ mmol conversion. STPD, independent of temperature. |
| `GAS_CONSTANT` | 62.36367 L·mmHg/(mol·K) | Ideal gas constant, for `p·V = n·R·T` in gas compartments. |
| `svp_h2o(temp)` | mmHg | Saturation water vapour pressure at `temp` °C: `exp(20.386 − 5132 / (temp + 273.15))`. |

## Users

| Export | Imported by |
|---|---|
| `O2_MMOL_PER_ML` | [BloodComposition](./BloodComposition.md), [Metabolism](./Metabolism.md), [Mob](./Mob.md), [Lactate](./Lactate.md), [Uterus](./Uterus.md), [MaternalPlacenta](./MaternalPlacenta.md), [Monitor](./Monitor.md) |
| `GAS_CONSTANT` | [GasCapacitance](./GasCapacitance.md), [GasComposition](./GasComposition.md), [GasExchanger](./GasExchanger.md) |
| `svp_h2o` | [GasCapacitance](./GasCapacitance.md), [GasComposition](./GasComposition.md), [Gas](./Gas.md) |

No other file in the engine hard-codes these numbers.

## Assumptions and limitations

- **`svp_h2o` is a two-parameter Clausius–Clapeyron fit**, slightly low against the Buck equation: −0.4 % at 30 °C, −0.9 % at 33.5 °C, −1.3 % at 37 °C (46.5 vs 47.1 mmHg), −1.6 % at 40 °C. The inspired pO2 at 37 °C is therefore 0.13 mmHg higher than with the standard 47 in room air, 0.6 mmHg in 100 % O2.
- **CO2 uses the same molar volume as O2** (ideal gas). The real STPD molar volume of CO2 is ~22.26 mL/mmol, 0.7 % smaller.

## References

- 22.414 L/mol (ideal gas at STP) and R = 62.364 L·mmHg/(mol·K): CODATA values.
- Buck AL. New equations for computing vapor pressure and enhancement factor. *J Appl Meteorol* 1981;20:1527–32 (the comparison above).

```

### FILE: explain-engine/docs/Uterus.md

````markdown
# Uterus

> **Experimental.** Used only by the archived `adult_female_uterus` scenario (the Pregnancy panel is hidden in the app as unfinished). It builds and runs on the current engine, but its pregnancy physiology isn't calibrated; see [Assumptions and limitations](#assumptions-and-limitations).

`Uterus` turns the adult uterine vascular bed (`UT_ART` → `UT_CAP` → `UT_VEN`) into an organ. It holds no blood. It controls those vessels and adds:
- a uterine oxygen consumption, with blood-flow and oxygen read-outs;
- **pregnancy:** with gestational age the bed dilates and fills, and its O2 demand rises;
- **labour:** periodic contractions that raise the intrauterine pressure and throttle uterine flow;
- an optional coupling that feeds uterine arterial blood into the fetal placenta's maternal pool.

It is the single source of the pregnancy state (`pregnant`, `preg_ga`, `iup`) that [MaternalPlacenta](./MaternalPlacenta.md) reads.

## Physiology

Outside pregnancy the uterus receives a small blood flow (~50 mL/min). In pregnancy the uterine arteries and the spiral arteries remodel into wide, low-resistance vessels, and uterine blood flow rises to roughly 500–750 mL/min at term, 10–15 % of the mother's cardiac output, most of it to the placenta. The uterus and the conceptus consume more oxygen as they grow.

In labour the myometrium contracts every few minutes. The pressure inside the uterus (resting tone ~8–12 mmHg, peaks 40–60 mmHg above it) compresses the vessels in its wall: inflow falls and venous blood is squeezed out. Contraction strength is summarised clinically in **Montevideo units** (peak amplitude × contractions per 10 min; adequate labour ≥ 200).

## Inheritance

```
BaseModelClass
  └── Uterus
```

## Properties

### Config: wiring (model names)

| Property | Default | Description |
|---|---|---|
| `ut_art_name`, `ut_cap_name`, `ut_ven_name` | `"UT_ART"`, `"UT_CAP"`, `"UT_VEN"` | The uterine arteriole, capillary and venule (BloodVessels). |
| `ut_in_res_name` | `"AD_UT_ART"` | Inflow resistor (the uterine blood-flow read-out). |
| `ut_out_res_name` | `"UT_VEN_VLB"` | Venous drainage resistor (owned by `VLB`; scaled in pregnancy). |
| `pl_mat_name` | `"PL_MAT"` | Fetal placenta's maternal pool, for the coupling. |

### Config: metabolism and tone

| Property | Unit | Default | Description |
|---|---|---|---|
| `uterus_running` | boolean | `true` | Master switch. Off restores the pregnancy layers and zeroes the outputs. |
| `met_active` | boolean | `true` | Switches the uterine O2 consumption. |
| `ut_vo2` | mL O2/kg/min | 0.04 | Uterine O2 consumption per kg maternal weight (2.4 mL/min at 60 kg). Not part of `Metabolism`'s map. |
| `vo2_factor`, `vo2_factor_ps` | – | 1.0 | Non-persistent (reset each step) and persistent VO2 multipliers. |
| `resp_q` | – | 0.8 | Respiratory quotient. |
| `perfusion_factor` | – | 1.0 | Vascular tone of `UT_ART`: < 1 dilates, > 1 constricts. |

### Config: pregnancy

| Property | Unit | Default | Description |
|---|---|---|---|
| `pregnant` | boolean | `false` | Pregnancy switch. |
| `preg_ga` | weeks | 0 | Gestational age of the pregnancy (not `model.gestational_age`, which is the mother's own). |
| `preg_ga_threshold`, `preg_ga_term` | weeks | 4, 40 | The adaptations ramp linearly between these ages. |
| `preg_res_term_factor` | – | 0.083 | Resistance multiplier of `UT_ART`, `UT_VEN` and the drainage at term. |
| `preg_cap_res_term_factor` | – | 0.083 | Resistance multiplier of `UT_CAP` (myometrium) at term; archived scenario 0.43, so the placenta takes the larger share. |
| `preg_vol_term_factor` | – | 3.0 | Unstressed-volume multiplier of the bed at term (engorgement). |
| `preg_vo2_term_factor` | – | 8.0 | VO2 multiplier at term (archived scenario 2). |
| `couple_placenta` | boolean | `false` | Drive `PL_MAT`'s O2/CO2 content from `UT_ART` while pregnant. Set `Placenta.skip_mat_gas_write` with it. |

### Config: contractions

| Property | Unit | Default | Description |
|---|---|---|---|
| `contractions_running` | boolean | `false` | Labour switch. |
| `contraction_period` | s | 180 | Time between contraction onsets. |
| `contraction_duration` | s | 60 | Duration of each contraction. |
| `resting_tone` | mmHg | 8 | Intrauterine pressure between contractions. |
| `contraction_amplitude` | mmHg | 50 | Peak pressure above resting tone. |
| `contraction_pres_gain` | – | 0.6 | Fraction of the pressure applied to the bed vessels as external pressure. |
| `contraction_r_peak` | – | 2.0 | Bed resistance multiplier at the contraction peak. |

### Outputs

| Property | Unit | Description |
|---|---|---|
| `ut_blood_flow` | mL/min | Total uterine inflow (placental + myometrial), smoothed over 5 s. |
| `ut_do2`, `ut_vo2_ml` | mL O2/min | O2 delivery and the uterine consumption (`MaternalPlacenta` reports the placental one). |
| `ut_o2er` | % | Whole-uterus extraction `(Ca − Cv)/Ca` from `UT_ART` and `UT_VEN`, so it includes the placenta. |
| `ut_avo2` | mmol/L | Arterio-venous O2 content difference. |
| `iup` | mmHg | Intrauterine pressure (0 when contractions are off). |
| `contraction_active` | boolean | Inside a contraction. |
| `montevideo_units` | MVU | `contraction_amplitude · 600 / contraction_period` (the setting, not a measurement). |

## Calculation

Each step (references resolved lazily; skipped without the three vessels; outputs zeroed when `UT_CAP` is empty):

1. **Pregnancy scaling.** `frac = (preg_ga − threshold)/(term − threshold)`, 0–1, 0 when not pregnant. Linear in `frac`:
   - `r_factor_scaling_ps` of `UT_ART`, `UT_VEN` and the drainage resistor → `preg_res_term_factor`; of `UT_CAP` → `preg_cap_res_term_factor`;
   - `u_vol_factor_scaling_ps` of the three vessels → `preg_vol_term_factor`.
   Written every step, so they return to 1 when the pregnancy is switched off.
2. **VO2 multiplier** follows the myometrial flow gain (`1/cap_res_factor`), reaching `preg_vo2_term_factor` exactly at term, so the extraction stays physiological while flow rises.
3. **Contractions.** A timer runs over `contraction_period`; inside the first `contraction_duration` the intensity is a half-sine 0 → 1 → 0.
   - `iup = resting_tone + contraction_amplitude · intensity`;
   - each bed vessel gets `pres_ext += iup · contraction_pres_gain` (compression; venous blood squeezed out);
   - the bed's resistance factor is `1 + intensity·(contraction_r_peak − 1)`.
4. **Non-persistent tone:** `UT_ART.r_factor = perfusion_factor · contraction factor`; `UT_CAP` and `UT_VEN.r_factor` = contraction factor.
5. **Uterine metabolism** on `UT_CAP`: `ut_vo2 · factors · pregnancy multiplier`, STPD conversion as in Metabolism; `resp_q` times it added as CO2.
6. **Read-outs:** smoothed inflow, DO2, AV difference and O2ER.
7. **Coupling** (pregnant and `couple_placenta`): `PL_MAT.to2/tco2` = `UT_ART.to2/tco2`.

## Factor system

- It writes the **scaling layers** (`r_factor_scaling_ps`, `u_vol_factor_scaling_ps`), which belong to `ModelScaler`. That is safe only while the uterine vessels aren't in a scaler group (they aren't in the archived scenario).
- It writes the **non-persistent** `r_factor` every step (tone and contractions).
- It leaves `r_factor_ps` (Circulation's SVR channels) and the ANS alone; BloodVessel multiplies all layers.

## Inputs and outputs

- **Reads:** the three vessels and the inflow resistor (flows, O2 contents, `UT_CAP` volume); `model.weight`.
- **Writes:** the vessels' scaling layers, `r_factor`, `pres_ext`; `UT_CAP.to2/tco2`; `UT_VEN_VLB.r_factor_scaling_ps`; `PL_MAT.to2/tco2` when coupled.
- **Read by:** `MaternalPlacenta` (`pregnant`, `preg_ga`, `iup`).
- **Written by:** the user.

## Assumptions and limitations

- **Pregnancy isn't calibrated.** Measured in the archived scenario:

  | Gestation | Uterine flow (mL/min) | Placental share | MAP (mmHg) |
  |---|---|---|---|
  | not pregnant | 46 | – | 98 |
  | 20 wk | 78 | 11 % | 89 |
  | 28 wk | 96 | 15 % | 81 |
  | 36 wk | 166 | 25 % | 114 |
  | 40 wk | 628 | 84 % | 75 |

  The term value is right, but the path isn't. Resistance falls linearly with gestation, so flow (∝ 1/R) stays low until the last weeks and then jumps; real uterine flow rises steadily from the first trimester. MAP is non-monotonic with gestation. The maternal blood volume expansion, cardiac output rise and fall in SVR of pregnancy aren't modelled.
- **Scaling-layer use** (see [Factor system](#factor-system)).
- **Contractions are a fixed waveform.** No uterine electrophysiology, no oxytocin; `montevideo_units` restates the settings.
- **The coupling is plumbing only.** No combined mother + fetus scenario uses it.
- **Consumption is silently capped** when it would make `UT_CAP`'s O2 content negative.

## Example definition (JSON)

From `archive/adult_female_uterus.json`, `models.Uterus` (trimmed to the physiology props; the wiring props are the defaults):

```json
{
  "name": "Uterus",
  "model_type": "Uterus",
  "is_enabled": true,
  "uterus_running": true,
  "ut_vo2": 0.04,
  "perfusion_factor": 1,
  "pregnant": false,
  "preg_ga": 0,
  "preg_res_term_factor": 0.083,
  "preg_cap_res_term_factor": 0.43,
  "preg_vol_term_factor": 3,
  "preg_vo2_term_factor": 2,
  "couple_placenta": false,
  "contractions_running": false,
  "contraction_period": 180,
  "contraction_duration": 60,
  "resting_tone": 8,
  "contraction_amplitude": 50,
  "contraction_pres_gain": 0.6,
  "contraction_r_peak": 2
}
```

## Usage in the scenarios

Only `archive/adult_female_uterus` (60 kg adult female, not pregnant at build). There the uterine bed (`AD_UT_ART` → `UT_ART` → `UT_CAP` → `UT_VEN` → `VLB`) runs in parallel with the placental bed `PL_IVS` of [MaternalPlacenta](./MaternalPlacenta.md). With contractions on at term, the smoothed uterine flow swings between ~410 and ~670 mL/min over a cycle. None of the canonical neonatal and fetal scenarios include it.

## References

None calibrated yet.

````

### FILE: explain-engine/docs/Ventilator.md

````markdown
# Ventilator

> **In the app the ventilator is the [SLE6000](./Sle6000.md).** Every scenario up to 30 kg uses
> `Sle6000`, a subclass of this model; only the adult scenarios keep `Ventilator` itself.
> - This class is the physics underneath, and its API is what Resuscitation, the respiratory suite,
>   the probes and the calibration scripts call.
> - Its HFOV, VC and PRVC modes have no control in the app.

The `Ventilator` device model simulates a **mechanical ventilator** that drives the patient's lungs
through an endotracheal (ET) tube. It owns a small gas circuit — a fresh-gas reservoir, the patient
circuit, an expiratory (PEEP) reservoir, and the inspiratory/expiratory valves plus the ET-tube
resistor — and modulates those parts every step to deliver the configured ventilation mode (`PC`,
`PRVC`, `VC`, `PS`, `CPAP`, or `HFOV`). Pressures are entered in cmH₂O and converted to the engine's mmHg
internally.

## Physiology

A neonatal ventilator delivers gas through an endotracheal tube. The main ways it supports a baby:
- **pressure modes (PC, PS):** it raises the airway pressure to a set peak (PIP) for a set inspiratory time or until the flow decays, then lets it fall to PEEP;
- **volume-targeted modes:** volume control, or volume guarantee / PRVC, which adjust the pressure breath by breath to reach a set tidal volume;
- **CPAP:** a constant distending pressure while the baby breathes on its own;
- **high-frequency oscillation (HFOV):** tiny tidal volumes at 5–15 Hz around a mean airway pressure, where gas moves by dispersion rather than bulk flow.

PEEP and mean airway pressure keep the lung open (FRC, oxygenation); tidal volume and rate set CO2 removal. A ventilator also measures: pressures, volumes and flows, compliance and resistance, leak, end-tidal CO2. Synchronised modes deliver a breath when the patient's own effort is detected (trigger), and an uncuffed neonatal tube leaks around its outside.

## Inheritance

```
BaseModelClass
  └── Ventilator   (mechanical ventilator: owns gas circuit, drives modes)
```

`Ventilator` extends `BaseModelClass` directly. It is a **coordinator/composite**: its gas circuit
sub-models are declared under `components` in the definition and instantiated into `model.models` at
build time, where they participate in the global step loop like any other model. `Ventilator` only
reaches into them by name to set valve states, resistances and reservoir volumes.

## What it models

- An ET-tube-coupled mechanical ventilator with seven modes: pressure control (`PC`),
  pressure-regulated volume control (`PRVC`), volume control (`VC`), pressure support (`PS`),
  synchronised intermittent mandatory ventilation (`SIMV`, with optional pressure support),
  continuous positive airway pressure (`CPAP`, with an optional apnoea backup rate), and
  high-frequency oscillation (`HFOV`).
- Time-cycled (`PC`/`PRVC`/`VC`) and flow-cycled (`PS`, SIMV support breaths) breath delivery, with
  patient triggering: always on in `PS` and `SIMV`, optional (`synchronized`) in the time-cycled
  modes. The trigger is a volume trigger off the `Breathing` effort, or a flow trigger at the tube
  (`trigger_mode`). `PS` also carries a time-cycled mandatory backup so it delivers breaths during
  apnea.
- An optional end-inspiratory pause (`insp_pause`) that produces a plateau pressure, enabling measured
  static compliance and airway resistance.
- A flow-, diameter- and length-dependent ET-tube resistance (Rohrer form, symmetric in inspiration
  and expiration, valid from neonatal 2.5 mm to adult 9 mm tubes).
- A heated humidifier: the fresh gas and the circuit are held at `temp` / `humidity`.
- Per-breath read-outs: tidal volumes, minute volume, dynamic & static compliance, measured peak /
  plateau pressure and airway resistance, end-tidal CO₂, and the monitored values a ventilator
  screen shows: mean airway pressure, measured Ti / Te / I:E, rate, triggers per minute and
  dynamic resistance.

## Gas circuit (owned sub-models)

```
VENT_GASIN ──[VENT_INSP_VALVE]──► VENT_GASCIRCUIT ──[VENT_ETTUBE]──► DS (airway) ──...──► lungs
   fresh gas      inspiratory          patient                ET tube
   (fio2)           valve              circuit
                                          └────[VENT_EXP_VALVE]──► VENT_GASOUT (PEEP reservoir)
```

| Sub-model | Type | Role |
|---|---|---|
| `VENT_GASIN` | GasCapacitance | Fresh-gas reservoir, composition set from `fio2`/`temp`/`humidity` (fixed composition) |
| `VENT_GASCIRCUIT` | GasCapacitance | Patient-side circuit gas volume; its pressure is the reported airway `pres` |
| `VENT_GASOUT` | GasCapacitance | Expiratory reservoir, pinned to hold PEEP (composition = room air) |
| `VENT_INSP_VALVE` | Resistor | Inspiratory valve (`VENT_GASIN → VENT_GASCIRCUIT`) |
| `VENT_ETTUBE` | Resistor | ET tube (`VENT_GASCIRCUIT → DS`); its `r_for`/`r_back` are driven by `calc_ettube_resistance` |
| `VENT_EXP_VALVE` | Resistor | Expiratory valve (`VENT_GASCIRCUIT → VENT_GASOUT`) |
| `VENT_LEAK` | Resistor | Leak around an uncuffed tube (`DS → MOUTH`), driven by `leak_size`. Added by `init_model` when a scenario does not declare it. |
| `VENT_DISCONNECT` | Resistor | The open Y-piece of a disconnected circuit (`VENT_GASCIRCUIT → MOUTH`, `disconnect_resistance`), closed unless `circuit_connected` is false. Added by `init_model` when a scenario does not declare it. |

References to the first six are cached in `init_model` and held in `_ventilator_parts` for batch enable/disable. `VENT_LEAK` is handled separately: it is only open while the ventilator is on **and** `leak_size > 0`.

## Properties

### Configuration (independent)

| Property | Unit | Description |
|---|---|---|
| `pres_atm` | mmHg | Atmospheric reference pressure (default 760) |
| `fio2` | fraction | Fraction of inspired O₂ for the fresh gas (default 0.205) |
| `humidity` | fraction | Fresh-gas relative humidity (default 1.0) |
| `temp` | °C | Fresh-gas temperature (default 37) |
| `ettube_diameter` | mm | ET-tube inner diameter (default 4); drives the `_ett_k1`/`_ett_k2` Rohrer coefficients |
| `ettube_length` | mm | ET-tube length (default 110); scales resistance by `length/110` |
| `vent_mode` | string | `PC` / `PRVC` / `VC` / `PS` / `SIMV` / `CPAP` / `HFOV` / `HFOV_CMV` (default `PRVC`) |
| `hfo_map_cmh2o` | cmH₂O | HFOV mean airway pressure (default 10) |
| `hfo_amplitude_cmh2o` | cmH₂O | HFOV peak-to-peak circuit pressure swing (default 25) |
| `hfo_freq` | Hz | HFOV frequency (default 10) |
| `hfo_insp_fraction` | fraction | HFOV inspiratory fraction of the cycle: 0.33 = I:E 1:2 (default), 0.5 = 1:1 |
| `hfo_bias_flow` | L/min | HFOV continuous fresh-gas (bias) flow (default 10) |
| `pres_response_tau` | s | First-order response of the delivered pressure to its target in `pressure_control` and `cpap_control` (0 = ideal, the default; the Sle6000 uses 0.012) |
| `hfo_volume_guarantee` | bool | HFOV volume targeting: servo the amplitude to `hfo_tidal_volume_target` (default false) |
| `hfo_tidal_volume_target` | L | HFOV expired volume per oscillation to aim for (default 0.002) |
| `hfo_amplitude_max_cmh2o` | cmH₂O | HFOV volume targeting: the amplitude limit (default 40) |
| `hfo_sigh_rate` | /min | Automatic HFOV sighs (0 = off) |
| `hfo_sigh_time` / `hfo_sigh_cmh2o` | s / cmH₂O | Duration and held pressure of an HFOV sigh (default 0.4 s, 10) |
| `hfo_activity` | string | `HFOV_CMV`: oscillate in `both` phases (default) or in expiration only (`exp`) |
| `vent_rate` | breaths/min | Mechanical rate; in `PS` it is the backup/apnea rate (default 40) |
| `tidal_volume` | L | Target tidal volume for `PRVC` and `VC`, and the volume-guarantee target (default 0.015) |
| `insp_time` | s | Inspiratory time (default 0.4) |
| `insp_pause` | s | End-inspiratory hold duration (default 0 = off); carved out of `insp_time`, must be `< insp_time` |
| `insp_flow` | L/min | Maximal flow of the demand valve in `PC`/`PRVC`/`PS`/`CPAP`; the delivered (constant) flow in `VC` (default 12) |
| `leak_size` | mm | Equivalent diameter of the gap around an uncuffed tube; 0 = no leak (default). Useful range ≈ 0.5–1.25 mm neonatal, 1–3 mm adult — see *Tube leak* |
| `exp_valve_resistance` | mmHg·s/L | Expiratory limb + valve; 0 = auto by circuit size (default) — see *Expiratory valve* |
| `volume_guarantee` | bool | Volume guarantee on top of `PC` (incl. synchronized A/C), `PS` or `SIMV`: the working pressure is servoed breath-to-breath to `tidal_volume`, limited by `pip_cmh2o_max` (default false) |
| `rise_time` | s | Pressure rise time in `PC`/`PRVC`/`PS`: the target ramps PEEP → PIP over this time (default 0.1; 0 = as fast as `insp_flow` allows) |
| `exp_flow` | L/min | Expiratory flow setting (default 3; reserved — not used in the current math) |
| `pip_cmh2o` | cmH₂O | Peak inspiratory pressure target in `PC` (default 14); not used in `PS` |
| `ps_cmh2o` | cmH₂O | Pressure support level **above PEEP** in `PS` (default 10); the PS target is `peep_cmh2o + ps_cmh2o` |
| `pip_cmh2o_max` | cmH₂O | Pressure limit of the volume-targeted modes (PRVC, volume guarantee); the VC pop-off (default 14) |
| `peep_cmh2o` | cmH₂O | Positive end-expiratory pressure / CPAP level (default 3) |
| `trigger_volume_perc` | % | Trigger volume as a percent of `tidal_volume` (default 6), with `trigger_mode` `"volume"` |
| `trigger_mode` | string | `"volume"` (default): `trigger_volume_perc` of the set Vt during a patient effort; `"flow"`: `trigger_flow` at the tube |
| `trigger_flow` | L/min | Flow-trigger threshold: inspiratory flow at the tube during expiration (default 0.6) |
| `leak_compensation` | bool | Flow trigger: subtract the learned baseline leak flow before the threshold (default true) — see *Tube leak* |
| `leak_comp_max_perc` | % | Compensate only while the leak (3-breath mean of `leak_perc`) is at most this (default 100; the SLE6000 sets 35) |
| `leak_term_min_perc` / `leak_term_max_perc` | % | Flow cycling: compensate the leak only while it is within this range (default 0–100; the SLE6000 sets 10–50) |
| `leak_term_max_flow` | L/min | Flow cycling: cap on the compensated leak flow (default 0 = no cap; the SLE6000 sets 5). It is also capped at half the peak flow |
| `term_sens_perc` | % | Termination sensitivity: a `PS` (or SIMV support) breath cycles off when inspiratory flow falls below this % of its peak (default 30) |
| `backup_rate` | /min | `CPAP` apnoea backup: a time-cycled breath at `pip_cmh2o`/`insp_time` after `60/backup_rate` s without a spontaneous effort (default 0 = off) |
| `synchronized` | bool | Enable patient-trigger detection in `PC`/`PRVC`/`VC` (default false). `PS` and `SIMV` always trigger; ignored in `CPAP` |
| `tube_position` | string | Airway event: `trachea` (default), `right_main` (blocks the left main bronchus) or `extubated`; set with `set_tube_position` |
| `circuit_connected` | bool | Airway event: false opens the circuit's Y-piece and the tube's proximal end to the room (default true); set with `set_circuit_connected` |
| `disconnect_resistance` | mmHg·s/L | Resistance of the open Y-piece of a disconnected circuit (default 5) |

### Computed (dependent) read-outs

| Property | Unit | Description |
|---|---|---|
| `pres` | cmH₂O | Airway pressure = `(VENT_GASCIRCUIT.pres − pres_atm) · 1.35951` |
| `flow` | L/min | ET-tube flow `× 60` |
| `vol` | mL | Volume integrated from ET-tube flow over the current breath (reset each inspiration) |
| `exp_time` | s | Expiratory time = `60/vent_rate − insp_time` |
| `trigger_volume` | L | Trigger threshold = `(tidal_volume/100) · trigger_volume_perc` |
| `minute_volume` | L/min | Ventilator breaths: the last one's Vte · rate (the set `vent_rate` for purely mandatory modes; whenever the patient can trigger (`PS`, or `synchronized`) the *measured*, breath-averaged rate), plus the [unsupported spontaneous breaths](#unsupported-spontaneous-breaths)' exhaled volume per minute; CPAP uses the patient's spontaneous rate |
| `compliance` | mL/cmH₂O | Dynamic compliance (= `compliance_dynamic`), measured per breath at end-expiration |
| `compliance_dynamic` | mL/cmH₂O | `Vt / (p_peak − PEEP)` — always available |
| `compliance_static` | mL/cmH₂O | `Vt / (p_plat − PEEP)` — only when an inspiratory pause produced a plateau (else 0) |
| `resistance` | cmH₂O/(L/s) | Measured airway resistance `(p_peak − p_plat) / _insp_flow_at_pause` (the ET-tube flow interrupted by the hold; falls back to the set `insp_flow` when that is 0) — needs a plateau; `null` when unmeasurable |
| `p_peak` | cmH₂O | Measured peak inspiratory (circuit) pressure over the breath (in CPAP: over the spontaneous breath) |
| `p_plat` | cmH₂O | Measured plateau pressure, sampled during the inspiratory pause |
| `exp_tidal_volume` | L | Expired tidal volume (per breath, an unsupported spontaneous breath included) |
| `insp_tidal_volume` | L | Inspired tidal volume (per breath, an unsupported spontaneous breath included) |
| `tv_kg` | mL/kg | Expired tidal volume per kg (`exp_tidal_volume·1000 / weight`); also in CPAP |
| `ncc_insp` | counter | Ventilator inspiration step counter (see breath cycle counters) |
| `ncc_exp` | counter | Ventilator expiration step counter |
| `etco2` | mmHg | End-tidal CO₂, sampled from `DS.pco2` at each new inspiration |
| `co2` | mmHg | Current dead-space CO₂ (`DS.pco2`) |
| `triggered_breath` | bool | True once a patient-triggered/synchronized breath has been armed |
| `pip_delivered` | cmH₂O | The inspiratory pressure target in use: `pip_cmh2o` (PC), `peep + ps_cmh2o` (PS), or the working pressure in PRVC / volume guarantee |
| `leak_perc` | % | Per-breath leak at the tube flow sensor, `(Vti − Vte)/Vti` |
| `leak_flow_comp` | L/min | Baseline leak flow the flow trigger subtracts at the current pressure (0 = not compensating) |
| `pressure_limited` | bool | Volume-targeted modes: working pressure at `pip_cmh2o_max` while Vt is still below target (the "Vt low / Pmax reached" alarm condition) |
| `map_meas` | cmH₂O | Mean airway pressure over the last breath; without breaths (CPAP, HFOV, apnoea) over 3 s blocks |
| `hfo_amplitude_delivered` | cmH₂O | HFOV amplitude in use: the set one, or the working one with volume targeting |
| `hfo_tidal_volume` | L | HFOV volume per oscillation at the tube |
| `hfo_dco2` | mL²/s | HFOV gas transport coefficient f · Vt² |
| `hfo_map_meas` / `hfo_amplitude_meas` | cmH₂O | Measured mean and peak-to-peak circuit pressure in HFOV |
| `hfo_sigh_remaining` / `hfo_pause_remaining` | s | Time left of a running HFOV sigh / oscillation pause (0 = oscillating) |
| `ti_meas` / `te_meas` | s | Measured inspiratory time of the last breath and the expiratory time before it |
| `ie_ratio_meas` | – | `te_meas / ti_meas` (shown as 1:x) |
| `rr_meas` | /min | Breath-averaged ventilator rate plus the unsupported spontaneous breaths per minute; in CPAP the patient's rate while breathing |
| `trig_per_min` | /min | Patient-triggered ventilator breaths over the last 60 s |
| `r_dyn` | cmH₂O/(L/s) | `(p_peak − PEEP) / peak expiratory flow` of the last breath, the dynamic resistance neonatal ventilators report |

### Internal (`_`-prefixed)

`_pip`/`_pip_max`/`_peep` are the cmH₂O targets converted to mmHg (in `PS`, `_pip` is
`peep_cmh2o + ps_cmh2o`). `_ett_k1`/`_ett_k2` are the ET-tube Rohrer coefficients derived from
diameter. `_rate_avg` is the breath-averaged measured rate (minute volume), `_manual_breath` a
pending `trigger_breath()` request, and `_humidifier_applied` guards the first-step humidifier
re-apply. `_insp_time_counter`/`_exp_time_counter`,
`_insp_tidal_volume_counter`/`_exp_tidal_volume_counter`, `_trigger_volume_counter`, `_inspiration`,
`_expiration`, `_peak_flow`, `_trigger_blocked`, `_trigger_start`, `_tv_tolerance` (0.0005 L) and
the `_vent_*` sub-model references back the cycling/triggering logic. Added for the pause / VC /
measured-mechanics paths: `_pause`, `_pause_counter`, `_had_pause`, `_pip_meas` (running peak →
`p_peak`), `_insp_flow_at_pause`, `_min_exp_time` (0.1 s floor), `_mandatory_breath`,
`_breath_interval_counter` (PS backup + measured rate), and `_vc_vol_target` (the VC servo's
flow-phase cut-off). `_measured_rate` (60 / the last breath interval) is a diagnostic read by the
probe scripts only; nothing in the cycling logic uses it. The ET-tube resistance is not stored:
`calc_ettube_resistance()` writes it straight onto `VENT_ETTUBE.r_for`/`r_back`.

## Calculation cycle (`calc_model`)

1. On the first step, re-apply the humidifier settings (`_apply_humidifier`, see below). Convert
   `pip_cmh2o` (in `PS`: `peep_cmh2o + ps_cmh2o`) / `pip_cmh2o_max` / `peep_cmh2o` to mmHg
   (`÷ 1.35951`) into `_pip`/`_pip_max`/`_peep`.
2. If the mode is `PS` or `SIMV`, or `synchronized` is set and the mode is not CPAP or HFOV, run
   `triggering()`.
3. Dispatch on `vent_mode`:
   - `PC` / `PRVC` → `time_cycling()` then `pressure_control()`
   - `VC` → `time_cycling()` then `volume_control()`
   - `PS` → `flow_cycling()` then `pressure_control()`
   - `SIMV` → `simv_cycling()` then `pressure_control()`
   - `CPAP` → `cpap_cycling()` (`cpap_control()`, or a backup/manual breath)
   - `HFOV` / `HFOV_CMV` → `hfov_control()`

   Outside CPAP and HFO, `_detect_spont_breath()` then closes out an
   [unsupported spontaneous breath](#unsupported-spontaneous-breaths) at its onset.
4. Publish read-outs: airway `pres`, `flow` (ET-tube flow × 60), integrate `vol`, sample `co2` from
   `DS`, set `minute_volume` (using the breath-averaged measured rate whenever the patient can
   trigger; CPAP reports a spontaneous minute volume), advance the breath-interval counter, and refresh the ET-tube resistance. Compliance and
   resistance are **not** touched here — they are measured once per breath (see
   `calc_measured_mechanics`), so `calc_model` must not clobber them.
5. `_calc_monitoring()` gathers the monitored values: expiratory time and peak expiratory flow,
   the mean-pressure integral, `rr_meas` and the 60 s trigger count.

### Breath cycle counters (`ncc_insp` / `ncc_exp`)

The ventilator tracks its breath phase on the **instance** counters `this.ncc_insp` and
`this.ncc_exp`. Each cycling routine sets a counter to `-1` at the first step of a new phase and then
increments it every subsequent step, so a value of `1` marks the first full step of inspiration /
expiration (the same `ncc === 1` convention the `Breathing` model uses for spontaneous breaths).


### `time_cycling` (PC / PRVC / VC)

Recomputes `exp_time = max(60/vent_rate − insp_time, _min_exp_time)` — **floored at 0.1 s** so a high
rate / long `insp_time` can no longer drive it negative (which would jam the cycler into continuous
inspiration). The inspiratory phase is split into a **flow phase** and an optional **pause**, with
`Ti = flow phase + pause`, so `exp_time` and the set I:E ratio are preserved.

- End of the flow phase: when `_insp_time_counter > (insp_time − insp_pause)` — or, in `VC`, when the
  delivered volume `_insp_tidal_volume_counter` reaches the (servo-trimmed) target `_vc_vol_target`.
  If `insp_pause > 0` it enters a bounded hold (`_pause`, both valves shut); otherwise it ends
  inspiration immediately.
- End of the pause: after `insp_pause` seconds it samples `p_plat` from the equilibrated circuit
  pressure and ends inspiration.
- End of expiration: `_start_inspiration()` opens a new breath — resets `vol`, latches
  `exp_tidal_volume`, samples `etco2`/`tv_kg`, updates the measured rate, and calls
  `calc_measured_mechanics()` for the breath just completed. In the volume-targeted
  modes (`PRVC`, volume guarantee) `_start_inspiration` calls `pressure_regulated_volume_control()`;
  in `VC`, `time_cycling` calls `volume_control_servo()`. With volume guarantee the flow phase also
  ends once 130 % of `tidal_volume` has been delivered.

During the flow phase the routine also tracks the peak circuit pressure into `_pip_meas` (used as
`p_peak`). The active phase advances its counter each step and toggles `_trigger_blocked`.

### `flow_cycling` (PS)

Pressure support is patient-triggered and **flow-cycled**: a breath begins on a patient trigger
(`triggered_breath` with rising ET-tube flow), the routine tracks `_peak_flow`, and cycles to
expiration when flow falls below **`term_sens_perc` of peak** (default 30 %) — or, as a safety limit, when the breath reaches
`insp_time` (Ti max, for when flow never decays). It also runs a **time-cycled mandatory backup**:
if no breath has started within `60/vent_rate` (tracked breath-start to breath-start via
`_breath_interval_counter`), it delivers a mandatory, time-cycled breath (terminated at `insp_time`).
This provides apnea backup; patient triggers always run in `PS`, whatever `synchronized` says. Peak circuit pressure is
captured into `_pip_meas` for the mechanics read-outs.

### `pressure_control`

- **Pause** — if `_pause` is set, shut **both** valves so the circuit equilibrates with the lung
  (plateau), and return.
- **Inspiration** — close `VENT_EXP_VALVE` and drive `VENT_INSP_VALVE` with the pressure servo
  (`_pressure_servo`, below). Its target ramps from PEEP to PIP over `rise_time` and is then held.
  The result is a square pressure waveform with decelerating flow, as on a real pressure-controlled
  ventilator. Integrate inspiratory tidal volume from positive ET-tube flow, and record
  `_insp_flow_at_pause` for the resistance measurement.
- **Expiration** — open `VENT_EXP_VALVE` (`r_for` from `calc_exp_valve_resistance`, see *Expiratory valve*) and pin the expiratory reservoir volume to
  hold PEEP (`vol = _peep/el_base + u_vol`). The inspiratory valve runs the pressure servo with PEEP
  as its target (a demand valve). While the patient exhales the circuit sits above PEEP and the
  servo stays shut; once the patient inhales it supplies the flow. Integrate expiratory tidal volume
  from negative ET-tube flow.

  > Before 2026-10, the inspiratory valve was simply shut in expiration. The circuit was then sealed
  > between ventilator breaths, apart from the one-way exit to the PEEP reservoir. A spontaneously
  > breathing patient could only draw the ~0.15 L/min that the tubing compliance held, so many
  > efforts never reached the trigger volume (PS: 24 of 40 triggered) or reached it late (~0.37 s
  > into a ~0.46 s effort). During CPR, compressions also pumped the lungs empty through that exit,
  > so rescue breaths reached only about half the set PIP. With the demand valve, PS triggers 34
  > of 38 efforts at ~0.15–0.2 s, and synchronized PC goes from 10 to 28 triggered breaths/min.

### Pressure response (`_respond`)

With `pres_response_tau > 0`, the pressure target of `pressure_control` (the PEEP to PIP ramp, and
PEEP in expiration) and the CPAP level pass through a first-order filter before the demand servo
and the PEEP reservoir see them:

`f += (target − f) · min(1, dt / τ)`

A real ventilator's valves or jets and its pressure loop have a finite speed, and its sensor sits
at the Y-piece. Without the filter the circuit tracks the target within a step, and the PV loop
comes out as a sharp-cornered box. VC and HFO do not use it; they reset the filter state. See
[Sle6000](./Sle6000.md) for the 12 ms value and its calibration.

### `_pressure_servo(target)` (demand valve)

Meters fresh gas into the circuit so `VENT_GASCIRCUIT` follows `target` (mmHg above atmospheric):

```
q = clamp( q_out + gain · (target − P_circuit) / (E_circuit · dt) ,  0 , insp_flow/60 )
r_for(VENT_INSP_VALVE) = (VENT_GASIN.pres − P_circuit) / q        (no_flow when q ≈ 0)
```

`q_out` is what left the circuit last step (ET tube, plus the expiratory valve when it is open), so
the valve feeds the patient's demand forward and only corrects the residual pressure error.
`gain` (`_servo_gain`) is 0.8. A lower gain lags the target, which made the adult circuit
oscillate; at 1.0 PS starts to dither. The source sits about 400 mmHg above the circuit, so the
valve is close to an ideal flow source, and the one-step-old circuit pressure the Ventilator sees
(it steps before its components) is good enough. The valve never sucks gas back (`q ≥ 0`), and it
is capped at `insp_flow`. A flow-limited breath (small `insp_flow`, large lung) therefore ramps
instead of squaring, and may not reach PIP within `insp_time`.

This replaced an open–shut valve: fixed `r_for` from `insp_flow`, shut whenever the circuit
exceeded PIP. That valve chattered around PIP, with 80–700 pressure reversals per breath, and
CPAP dipped during spontaneous inspiration. Now there are about 2 reversals per breath in the
pressure modes, and CPAP holds its level.

### `volume_control` (VC)

Volume control delivers a roughly **constant inspiratory flow** by re-solving the inspiratory valve
resistance every step — `r_for = (VENT_GASIN.pres − VENT_GASCIRCUIT.pres) / (insp_flow/60)` pins the
flow near the target while the lung fills — until the delivered volume reaches `_vc_vol_target`, then
holds (the inspiratory pause, in `time_cycling`) and cycles to expiration. `pip_cmh2o_max` acts as a
pressure pop-off (shut the valve if the circuit exceeds it). Expiration mirrors `pressure_control`
(including the PEEP demand valve).
VC **bypasses** the PRVC PIP servo. Because the compliant circuit stores compression volume that
dumps into the lung, the delivered tidal volume is trimmed breath-to-breath by
`volume_control_servo()` (proportional, clamped to `[0.1·Vt, Vt]`) so `exp_tidal_volume` converges on
the set `tidal_volume`; if `insp_flow` is too low the breath is genuinely flow-limited and undershoots.

### `calc_measured_mechanics`

Called once per breath (at `_start_inspiration`) on the just-completed breath:
`compliance_dynamic = Vt / (p_peak − PEEP)` (always, and copied to `compliance`); and when a plateau
exists (`insp_pause > 0`), `compliance_static = Vt / (p_plat − PEEP)` and
`resistance = (p_peak − p_plat) / flow` with `flow` the interrupted ET-tube flow (`_insp_flow_at_pause`,
L/s), or the set `insp_flow / 60` when no flow was captured at the pause. Without a plateau,
`compliance_static = 0` and `resistance = null`.

### `simv_cycling` (SIMV)

The mandatory rate divides time into windows of `60/vent_rate`. Each window opens with an **assist
window**: the first patient trigger gets a synchronised mandatory breath (PIP, `insp_time`) and
closes the assist window until the next window starts. Without a trigger by the **mandatory breath
point** (`window − insp_time`) a mandatory breath is delivered, so it completes inside its window.
Later triggers in the same window are spontaneous breaths: with `ps_cmh2o > 0` they get pressure
support (`peep + ps_cmh2o`, flow-cycled at `term_sens_perc`, Ti max `insp_time`), otherwise the
patient breathes unsupported on PEEP.

- The support pressure never exceeds the mandatory pressure. With volume guarantee that is the
  working pressure, so the support can't out-ventilate the volume target.
- Volume guarantee trims the working pressure on mandatory breaths only.
- Unsupported spontaneous breaths are breaths of their own in the monitoring (see
  [Unsupported spontaneous breaths](#unsupported-spontaneous-breaths)), so volume guarantee trims on
  the mandatory breath's own Vte.

### Unsupported spontaneous breaths

In CMV, and in SIMV without pressure support, the patient can breathe between ventilator breaths
without starting one. A flow sensor at the tube sees each of these as a small breath of its own: the
SLE6000 reports Vte as the "expired volume of large and small breaths" and RR as the "total number of
breaths detected" (IFU §27.6.5, p175). `_detect_spont_breath()` (every step outside CPAP and HFO)
models that:

- **Onset.** In the ventilator's expiration, once the minimal expiratory time has passed, tube flow
  above `trigger_flow` (net of the learned leak flow, as the flow trigger) that did not start a
  ventilator breath. The detector is re-armed by expiratory flow, so one inspiration is one breath.
- **At the onset** the breath in progress is closed: the ventilator breath with its full measurements
  (`_close_vent_breath`: Vte, etCO₂, mechanics, leak, volume-guarantee trim), or the previous
  spontaneous breath (`_close_spont_breath`: Vte, Vti and leak only, as no pressure was applied).
- **Volumes.** A spontaneous breath counts its inspiratory and expiratory tube flow in the usual
  counters until it is closed by the next onset or by the next ventilator breath.
  - Not yet exhaling when a ventilator breath starts: the effort became that breath (it triggered
    it, or the SIMV window opened on it) and is not a breath of its own. The volume the patient
    inhaled so far counts in that breath's Vti, unless no patient effort was seen (flow in from an
    uncompensated leak refilling the circuit).
  - Cut off while exhaling (CMV): closed with the volume so far, but its Vti − Vte is not taken as a
    leak.
- **Rate and minute volume.** `rr_meas` adds the spontaneous breaths of the last 60 s (scaled while
  the window fills) to the breath-averaged ventilator rate. `minute_volume` is the last ventilator
  breath's Vte times its rate plus the spontaneous breaths' exhaled volume per minute.
- **Hook.** Every closed breath calls `_breath_closed(spont)`; the Sle6000 updates its monitored
  values there.

Before this the patient's breaths were folded into the ventilator breath's Vte (CMV at a set rate of 20
with a breathing term neonate: Vte 62 ml against a Vti of 36, C doubled, RR 20 instead of about 60,
and a tube leak hidden at 0 %).

### `cpap_cycling` (CPAP with apnoea backup)

`cpap_control()` runs unless a backup or manual breath is due. With `backup_rate > 0`, an apnoea
timer runs from the start of the last breath and restarts on every spontaneous effort
(`Breathing.ncc_insp === 1`). When it passes `60/backup_rate`, or when a manual breath is due
(`trigger_breath`), a time-cycled breath is delivered at `pip_cmh2o` for `insp_time` through
`pressure_control()`, after which CPAP resumes. A backup rate of 30 during apnoea gives 30 breaths
per minute.

### `cpap_control` (CPAP / PS coupling to spontaneous breathing)

CPAP holds the circuit at the CPAP level (= `peep_cmh2o`) and lets the patient breathe spontaneously
through the ET tube — **both valves stay open**. The inspiratory valve is the pressure servo, with
the CPAP level as its target, so it delivers the patient's inspiratory demand (up to `insp_flow`)
instead of letting the pressure dip. The expiratory reservoir is pinned, so the circuit floats at
CPAP. Tidal volumes are accumulated from ET-tube flow and closed out at each spontaneous inspiration
start (`Breathing.ncc_insp === 1`), where `tv_kg` and `p_peak` (peak circuit pressure over that
spontaneous breath) are latched too; `minute_volume = exp_tidal_volume · Breathing.resp_rate`.

> CPAP only ventilates a *spontaneously breathing* patient: with `Breathing` disabled it holds the
> pressure but delivers no tidal volume, as in reality. This is the half of the
> **CPAP/PS-via-ET-tube** coupling owned by the ventilator; the other half lives in `Breathing` (see
> below).

### `pressure_regulated_volume_control` (PRVC and volume guarantee)

PRVC and volume guarantee (`PC`/`PS` with `volume_guarantee`) share one breath-to-breath controller.
It runs at every breath start, on the breath just completed, after `calc_measured_mechanics`:

```
err  = tidal_volume − exp_tidal_volume                       (no change if |err| ≤ _tv_tolerance, 0.5 mL)
step = clamp( _vt_gain · err / compliance_dynamic , ±_vt_max_step )     _vt_gain 0.5, ±3 cmH₂O/breath
_pip_working = clamp( _pip_working + step , peep_cmh2o + 2 , pip_cmh2o_max )
```

`_pip_working` is the inspiratory pressure target in these modes (`pip_delivered`). It starts from
the set pressure (`pip_cmh2o`, or `peep + ps_cmh2o` in PS) whenever the mode changes or
`set_volume_guarantee` is called. **The user's `pip_cmh2o` is never written.** The old PRVC moved
`pip_cmh2o` itself by a fixed ±1 cmH₂O, which limit-cycled between two pressures whenever 1 cmH₂O
moved Vt by more than the tolerance (neonatal PRVC 15 mL alternated between PIP 8 and 9).

**Volume guarantee** also ends a breath early once it has delivered 130 % of the target
(`_vg_vt_limit`). This is the volutrauma guard of clinical VG for a sudden compliance rise: it caps
the breath, and the controller then trims the pressure down. `pressure_limited` flags when the limit
keeps Vt below target. With a spontaneously breathing patient in PS + VG, the controller withdraws
support (down to PEEP + 2) as the patient's own effort takes over the volume.

Verified (`term_neonate_72h` unless noted):
- PC + VG 15 mL converges to 15.3 mL at 8.6 cmH₂O.
- preterm 28 wk VG 5 mL converges to 5.3 mL at 7.3 cmH₂O.
- adult VG 450 mL converges to 451 mL at 13.6 cmH₂O.
- Lung made twice as stiff mid-run: Vt 9.7 recovers to 14.6 mL within about 5 breaths.
- Lung made twice as soft: Vt is capped at about 19.5 mL (130 %) while the pressure is trimmed
  down.

### `triggering` (`PS`, `SIMV`, and synchronized time-cycled modes)

**Flow trigger** (`trigger_mode = "flow"`, `flow_triggering()`): inspiratory flow at the tube above
`trigger_flow` (L/min) during expiration forces the breath, as a ventilator with a proximal flow
sensor does. It is armed once the minimal expiratory time (`_min_exp_time`) has passed, so the end
of the previous breath cannot re-trigger. With the 0.6 L/min default it triggers every effort on
`term_neonate_72h` and `adult_female` in PS (`validate:resp`, case `flowtrig`). A 28-week preterm's
efforts peak at ~0.5 L/min through the tube on PS, so they need a lower threshold; see the
suite's known failures.

**Volume trigger** (`trigger_mode = "volume"`, the default) sets `trigger_volume = (tidal_volume/100)·trigger_volume_perc`. When `Breathing.ncc_insp === 1` (the
onset of a patient effort) and the trigger is not blocked, it arms `_trigger_start` with a zeroed
`_trigger_volume_counter` and integrates **inspiratory** ET-tube flow only (`max(flow, 0)`), so the
expiratory tail of the previous breath cannot cancel the effort. It disarms (counter back to 0) when
the patient's inspiration ends or a ventilator inspiration starts, so a missed effort never carries
over into the next. Once the integrated volume exceeds `trigger_volume` it forces the breath
(`_exp_time_counter = exp_time + 0.1`) and sets `triggered_breath = true`: at most one trigger per
effort.

Some efforts are still missed or triggered late, roughly 1 in 10 in PS on `term_neonate_72h`. These all
start early in the ventilator's expiration, while the patient is still exhaling the previous
supported breath: the effort first has to stop the expiratory flow before any inspiratory flow
counts. This is the ineffective/delayed triggering seen clinically at high respiratory rates, and it
is kept on purpose. `scripts/probe_ventilator_trigger.mjs` counts efforts, blocked efforts,
triggered and backup breaths per minute.

## High-frequency oscillation (`hfov_control`)

`HFOV` replaces breath cycling with an oscillation of the circuit pressure around a mean.

- **Waveform.** The target is `MAP + w(t)`. `w` is a positive half-sine of amplitude `A·(1 − fi)`
  for the first `fi` of the cycle, then a negative half-sine of amplitude `A·fi` for the rest.
  The mean is therefore exactly MAP at any I:E, and the peak-to-peak is exactly `A`.
- **Active expiration.** `_bidirectional_servo` computes the net flow the circuit needs: the
  ET-tube flow plus the proportional pressure correction (gain 0.8, as `_pressure_servo`). A
  positive need is pushed in by the inspiratory valve. A negative need is pulled out through the
  expiratory valve, into `VENT_GASOUT` pinned 10 cmH₂O below the trough (the piston's pull). The
  bias flow runs through both valves on top, so the net is unchanged.
- **Read-outs, per cycle at the tube:**
  - `hfo_tidal_volume` (also `insp_/exp_tidal_volume` and `tv_kg`)
  - `hfo_dco2 = f·Vt²` (mL²/s)
  - `hfo_map_meas` and `hfo_amplitude_meas`
  - `p_peak`, `pip_delivered`, and `minute_volume = Vt·f·60`
- **Not applicable.** There is no triggering and no breath counters in HFOV. The leak (also
  `leak_perc`, per cycle) and the tube dead space still apply.
- **Volume targeting** (`hfo_volume_guarantee`, `set_hfo_volume_guarantee`).
  - Expired volumes vary a lot cycle by cycle. So the working amplitude is trimmed on the
    **average** expired volume of each 0.5 s block, not on every cycle.
  - Vt rises roughly in proportion to the amplitude, so each block corrects half of the gap to
    `amplitude · target / Vte`, by at most 3 cmH₂O.
  - The working amplitude stays within 4 cmH₂O and `hfo_amplitude_max_cmh2o`; `pressure_limited`
    flags a target that the limit stops.
  - The set `hfo_amplitude_cmh2o` is never changed, so switching targeting off returns to it.
  - On preterm_28wk, targeting converges in about 5 s.
- **Sighs and oscillation pause** (HFOV only).
  - `hfo_sigh()` stops the oscillation and holds the circuit at `hfo_sigh_cmh2o` for
    `hfo_sigh_time`. `hfo_sigh_rate` repeats this automatically.
  - `hfo_pause()` holds the circuit at MAP for up to 60 s; a second call cancels it.
  - During a hold the per-cycle measurements are suspended, and the oscillation restarts at the
    beginning of a cycle.
- **HFOV_CMV** (`set_hfov_cmv`). The base level is a time-cycled breath instead of MAP: PIP for
  `insp_time` (reached over `rise_time`), PEEP for the rest of `60/vent_rate`.
  - The oscillation is added in both phases, or only in expiration with `hfo_activity = "exp"`.
  - The breath keeps the usual bookkeeping:
    - the `ncc_insp` / `ncc_exp` counters (Monitor)
    - `rr_meas`
    - `ti_meas` / `te_meas`
    - the per-breath `map_meas`
  - `trigger_breath()` gives an early breath.
  - The per-cycle HFO read-outs run as in HFOV.
- **Stepsize.** 0.5 ms gives ≥ 130 steps per cycle up to 15 Hz.

**CO₂ clearance comes from the airway, not the device.** It relies on the series dead space with
axial dispersion ([GasCapacitance → Series dead space](./GasCapacitance.md#series-dead-space)). With
the old well-mixed dead space, PaCO₂ sat at 10–14 mmHg at any frequency. Now, on preterm_28wk with a
2.5 mm ETT, `PaCO₂·DCO₂` stays constant within about ±8 % over 8–15 Hz × amplitude 15–30. That is
the clinical relationship: CO₂ elimination ∝ f·Vt², so **raising the frequency reduces CO₂
clearance** (smaller Vt), and raising the amplitude increases it. The pressure swing is damped from
the circuit to the trachea and the alveoli. Oxygenation follows MAP through lung volume and
recruitment. `scripts/probe_hfov.mjs` prints all of these.

Limitations:
- The ET tube is resistive only. At 10–15 Hz, inertance adds about ωI ≈ 2 cmH₂O/(L/s) to a
  neonatal tube; this is neglected.
- Absolute PaCO₂ inherits the scenario's lung calibration (see the dead-space follow-up note).

## ET-tube dead space (`_set_tube_dead_space`)

While the ventilator is on, it sets the dead-space compartment's `tube_volume` to the lumen volume
`π·(d/2)²·L` and its `tube_port_model` to `VENT_GASCIRCUIT`. With series dead space on (the default,
see [GasCapacitance → Series dead space](./GasCapacitance.md#series-dead-space)), gas to and from
the circuit then passes through that rigid lumen, so a longer or wider tube adds dead space. On
preterm_28wk, a 2.5 mm tube at 200 mm instead of 110 mm (+0.44 mL) raises PaCO₂ 81 → 91. The leak
and the natural airway bypass the lumen. Switching the ventilator off sets `tube_volume` back to 0.

## Expiratory valve

`VENT_EXP_VALVE` stands for the expiratory limb and valve. `calc_exp_valve_resistance()` sets its
`r_for` whenever the valve opens (PC/PRVC/VC/PS expiration and CPAP). With `exp_valve_resistance = 0`
(auto) it follows the circuit that goes with the tube size:

| ET tube | circuit | r_for (mmHg·s/L) | ≈ cmH₂O/(L/s) |
|---|---|---|---|
| < 4.5 mm | neonatal | 10 | 14 |
| 4.5–6 mm | paediatric | 4 | 5 |
| ≥ 6 mm | adult | 2 | 3 |

ISO 80601-2-12 caps the expiratory pressure drop at 6 cmH₂O at 5, 30 and 60 L/min for the three
circuit classes; real circuits sit well below that. A positive `exp_valve_resistance` overrides the
auto value. The result is kept above the explicit-integration floor `dt · (E_circuit + E_reservoir)`,
like the ET tube.

> Before 2026-10 the valve was fixed at 10 mmHg·s/L for every patient. For an adult that is about
> 14 cmH₂O/(L/s): on CPAP 0.5 the circuit rose to ~3.3 cmH₂O in every exhalation, breaths stacked
> and PaCO₂ rose (`validate_respiratory`, `adult.cpap.paco2_delta`).

## Tube leak (`calc_leak`)

The leak models gas escaping around an uncuffed tube, from the trachea (`DS`) up through the larynx
to the mouth (`MOUTH`, the scenario's atmospheric reservoir). It is its own resistor, `VENT_LEAK`,
and it does not borrow `MOUTH_DS`, because `Respiration` (upper-airway resistance factor) and `Apnea`
(obstructive occlusion) already drive that one. `init_model` adds the `VENT_LEAK` definition to the
ventilator's components when a scenario or saved state does not declare it, so every scenario
supports a leak without being edited.

Its resistance uses the ET tube's Rohrer form for a short channel of diameter `leak_size` (length
20 mm), with the same numerical floor:

```
R_leak = (K1(leak_size) + K2(leak_size)·|V̇_leak|) · 20/110          (K1 ∝ d⁻⁴, K2 ∝ d⁻⁴·⁷⁵, as the ET tube)
```

The leak therefore grows with airway pressure: it is largest at PIP, and smaller but continuous at
PEEP. Because conductance scales with d⁴, the useful range is narrow:

| leak_size | term_neonate_72h PC 20/5 (3.5 mm tube) | adult_female PC 20/5 (7.5 mm tube) |
|---|---|---|
| 0.5 mm | 7 % | — |
| 0.75 mm | 23 % | — |
| 1.0 mm | 45 % | 14 % |
| 1.25 mm | 65 % | — |
| 2.0 mm | ~100 % | 57 % |
| 3.0 mm | — | 88 % |

`leak_perc` is measured the way a ventilator reports it, at the tube flow sensor:
`(Vti − Vte)/Vti` per breath. It is computed at each breath start, and in CPAP at each spontaneous
breath. Behaviour that comes out of the model (`scripts/probe_ventilator_leak.mjs`):

- **PC/PS compensate.** The pressure servo makes up the leaked gas, so the lung Vt barely drops.
  Vti rises and Vte falls. With term_neonate_72h PC 20/5 at 1 mm: Vti 61, Vte 34, lung 48.5 mL.
- **Volume guarantee over-delivers.** It regulates on Vte, so once the leak passes ~30 % it drives
  the pressure to its limit. The lung then gets *more* than the target (18 mL against 15), bounded
  only by the 130 % inspired-volume guard. This is the clinical reason VG is unreliable with large
  leaks.
- **PS cycles on Ti max without leak compensation.** The circuit feeds the leak at the
  inspiratory pressure, so the inspiratory flow levels off at the leak flow and never decays to
  `term_sens_perc` of peak. With leak compensation it cycles on flow again (see *Leak and flow
  cycling* below).
- **Dead-space flush.** The continuous leak flow through `DS` washes out CO₂, which lowers PaCO₂
  a little, much like tracheal gas insufflation.
- **VC is not compensated.** Leaked gas is lost from the set volume.

### Leak and the flow trigger (leak compensation)

During expiration the circuit keeps resupplying the leak through the tube to hold PEEP, so the tube
flow sensor reads a steady *inspiratory* flow equal to the leak flow at PEEP. Uncompensated, that
flow crosses `trigger_flow` and every breath auto-triggers once the minimal expiratory time has
passed: term_neonate_72h in SLE PTV 15/4/30, apnoeic, with a 1 mm leak was cycled at 58/min.

Neonatal ventilators compensate for this, and so does the model. It learns the leak the way the
device can, from its own sensor only (it never reads `VENT_LEAK`): over a whole breath the lung
returns to its start volume, so the breath's net volume through the sensor is the leaked volume.
With the orifice law Q = g·√P (P the circuit pressure),

```
g_breath = max(∫ flow dt, 0) / ∫ √P dt        (per breath, at the breath start)
g        ← g + (g_breath − g)/3                 (filtered over ~3 breaths)
trigger:   flow − g·√P  >  trigger_flow          (leak_flow_comp = g·√P, in L/min)
```

The first breaths after a leak appears are uncompensated while `g` builds up. Compensation applies
only while the 3-breath mean of `leak_perc` is at most `leak_comp_max_perc`; above it the leak
auto-triggers again, as on a device whose compensation range is exceeded. Results with the
SLE6000 (limit 35 %), PTV 15/4/30, `scripts/probe_sle6000.mjs` section 14:

| leak_size | Leak % | apnoeic: triggered / mandatory per 30 s | breathing: triggers per effort |
|---|---|---|---|
| 0 | 0 | 0 / 15 | 1.0 |
| 0.7 mm | 20 | 0 / 15 | 1.0 |
| 0.8 mm | 27 | 0 / 15 | 1.0 |
| 0.9 mm | 36 | 22 / 0 (auto-triggering) | — |
| 1.5 mm | 80 | 43 / 0 (auto-triggering) | — |

The volume trigger (`trigger_mode "volume"`) needs no compensation: it only arms on a `Breathing`
effort, so a leak alone never starts a breath. Not modelled: leak-corrected volumes.

### Leak and flow cycling

A flow-cycled breath (`PS`, and supported breaths in `SIMV`) ends when the inspiratory flow falls
to `term_sens_perc` of its peak. With a leak the flow levels off at the leak flow at the
inspiratory pressure instead. Once that is above the termination level, every breath runs to Ti
max: with SLE PSV 15/4 (Ti Max 0.6 s, Term Sens 5 %) that is every breath from about 0.7 mm
(20 % leak).

With leak compensation, `_term_flow()` takes the learned leak flow `q = g·√P` off first:

```
end of breath:   flow − q  <  term_sens · (peak − q)
```

The breath ends when the patient's own flow has decayed to Term Sens of its peak, just above the
leak flow level. The SLE6000 IFU (§20.6.4) says a termination level below the leak flow is
"terminated at the leak flow level". The flow approaches that level from above and never crosses
it, and the learned leak is about 10 % low at PIP (it is fitted over the whole breath). Ending at
exactly the leak flow therefore still ran to Ti max, and the form above is used instead.

As on the device:
- `q` is capped at half the peak flow and at `leak_term_max_flow`;
- it is applied only while the leak is within `leak_term_min_perc`–`leak_term_max_perc`.

Results with the SLE6000 (5 l/min, 10–50 %), `probe_sle6000.mjs` section 15:

| PSV 15/4, Ti Max 0.6 s | Leak % | breaths ending on Ti Max |
|---|---|---|
| 0.8 mm, compensation off | 28 | all |
| 0.8 mm | 28 | none (mean Ti 0.58 s) |
| 1.2 mm | 64 | all (above 50 %) |

`Breathing` subtracts the leak flow from the airway-opening flow (see below), because gas that
escapes around the tube never reaches the lungs.

## Airway events

Three events of the DOPE list, active only while ventilating. `switch_ventilator(false)` ends them:
the tube goes back to the trachea and the circuit is reconnected. Resistors look their compartments
up by name on every step, so each event re-routes `comp_from` / `comp_to` and restoring the names
restores the circuit exactly. The tube's own ends (`VENT_GASCIRCUIT`, `DS`) are captured at init.

| Event | Routing | What it shows |
|---|---|---|
| `tube_position = "right_main"` | sets [`Respiration.airway_obstructed_left`](./Respiration.md#bronchus-obstruction-and-resorption): `DS_ALL` closed | All the tidal volume goes to the right lung, so the measured C falls (term_neonate_72h CMV 20/5: 3.1 → 1.9 ml/mbar) and SpO₂ falls. The left lung collapses by resorption, faster on oxygen. Pulling back leaves the collapse for recruitment. |
| `tube_position = "extubated"` | `VENT_ETTUBE → MOUTH`; `MOUTH_DS` open; leak and tube dead space off | The ventilator blows into the room, so Vte is 0 and the leak 100 %. The patient breathes through the natural airway without PEEP. An apnoeic patient desaturates (60 % after 1 min). |
| `circuit_connected = false` | `VENT_ETTUBE` from `MOUTH`; `VENT_DISCONNECT` open | Circuit pressure falls to about 2 cmH₂O. The proximal flow sensor stays on the tube and reads only the patient's own breaths. No PEEP. |

The tube's block is kept apart from a bronchial plug (`Respiration.set_tube_block`), so either one
can be cleared without opening a bronchus the other still blocks. `scripts/probe_airway_events.mjs` checks every
event, its recovery, and the end of all events on Standby.

## Coupling to `Breathing`

`Breathing` measures its tidal volume at the lungs (see [Breathing](./Breathing.md)), so it does not
depend on the airway route: natural airway, ET tube or a tube leak. The Ventilator reads the
spontaneous phase from `Breathing`: the patient trigger arms on `ncc_insp === 1` and disarms when
`insp_running` ends, and CPAP closes out a spontaneous breath on `ncc_insp === 1`.

## ET-tube resistance (`calc_ettube_resistance`)

```
R  = (K1 + K2·|V̇|) · (ettube_length / 110)      V̇ = ET-tube flow (L/s), R in mmHg·s/L
K1 = 16.92 · (2.5/d)^4       mmHg·s/L         laminar (Poiseuille) term
K2 = 513.7 · (2.5/d)^4.75    mmHg·s²/L²       turbulent (Blasius) term   (d = ettube_diameter)
```

The pressure drop is the Rohrer form `ΔP = K1·V̇ + K2·V̇²`. It is anchored on in-vitro data for a
2.5 mm tube (81 and 139 cmH₂O/(L/s) at 5 and 10 L/min) and scaled to other diameters with the
physical exponents. It reproduces the adult literature (an 8 mm, 27 cm tube ≈ 7 cmH₂O/(L/s) at 1 L/s)
without a separate fit. With `|V̇|` the tube is symmetric: the previous linear fit used the
*signed* flow (so expiration always sat at its floor) and went negative above ~4.6 mm.

Effective values at 5 L/min, 110 mm: 2.5 mm ≈ 81, 3.0 mm ≈ 36, 3.5 mm ≈ 18, 4.0 mm ≈ 10
cmH₂O/(L/s). Measured data show smaller-than-Poiseuille differences between 3.0 and 4.0 mm
(connector losses), so the 3.5–4.0 mm values are on the low side.

The only floor is numerical: the tube flow is integrated explicitly, so `R` is kept at or above
`dt·(E_circuit + E_airway)`. Without that floor the circuit and the airway could equilibrate within
one step, and the pressure would oscillate. Only large adult tubes at low flow reach it. `R` is
written onto `VENT_ETTUBE.r_for` / `r_back` each step. `set_ettube_diameter` requires `d > 1.5`;
`set_ettube_length` requires `length ≥ 50`.

## Factor system

The `Ventilator` class itself exposes **no** three-tier `*_factor` parameters — it is a controller,
not a capacitance/resistor. Its owned gas sub-models (`VENT_*` capacitances and resistors) carry the
usual `el_base_factor*` / `r_factor*` tiers (see [Capacitance](./Capacitance.md) /
[Resistor](./Resistor.md)), but the ventilator drives those resistors by writing `r_for` directly, so
the factor layers on `VENT_INSP_VALVE` / `VENT_ETTUBE` / `VENT_EXP_VALVE` are generally left at 1.0.

## Control API

| Method | Effect |
|---|---|
| `switch_ventilator(state)` | Enable/disable the device and all `_ventilator_parts`; sets `no_flow = !state` on each part; blocks `MOUTH_DS` (`no_flow = state`); on: re-applies the humidifier; off: ends the airway events, resets read-outs and empties `VENT_GASCIRCUIT` to its unstressed volume (so a circuit stopped mid-inspiration does not empty into the airway on the next switch-on) |
| `set_pc(pip, peep, rate, t_in, insp_flow)` | Configure PC mode |
| `set_prvc(pip_max, peep, rate, tv, t_in, insp_flow)` | Configure PRVC (`tv` in mL → L) |
| `set_vc(peep, rate, tv, t_in, insp_flow, pip_max, insp_pause)` | Configure VC (`tv` in mL → L; `pip_max` is the pop-off ceiling; `insp_pause` clamped `< insp_time`) |
| `set_psv(pip, peep, rate, t_in, insp_flow)` | Configure PS mode (`pip` absolute → `ps_cmh2o = pip − peep`; `rate` = backup rate; `t_in` = backup Ti and Ti max) |
| `set_hfov(map, amplitude, freq, insp_fraction, bias_flow)` | Configure HFOV (cmH₂O, cmH₂O peak-to-peak, Hz, fraction, L/min) |
| `set_hfo_volume_guarantee(state, vt, amp_max)` | HFOV volume targeting on/off; optional target `vt` (mL, expired per oscillation) and amplitude limit (cmH₂O); restarts the working amplitude |
| `set_hfo_sigh(rate, t, pres)` / `hfo_sigh()` / `hfo_pause(state)` | Automatic HFOV sighs (/min, s, cmH₂O); one sigh now; oscillation pause at MAP (60 s, toggles) |
| `set_hfov_cmv(pip, peep, rate, t_in, amplitude, freq, activity, bias_flow)` | CMV breaths with HFO superimposed (`activity` `both` or `exp`) |
| `set_simv(pip, peep, rate, t_in, ps, insp_flow)` | Configure SIMV: mandatory breaths at `pip`/`rate`/`t_in`, spontaneous breaths supported by `ps` above PEEP (0 = unsupported) |
| `set_volume_guarantee(state, tv, pip_max)` | Volume guarantee on/off for PC/PS/SIMV; optional target `tv` (mL) and pressure limit `pip_max` (cmH₂O); restarts the working pressure |
| `set_cpap(cpap, insp_flow, backup_rate)` | Configure CPAP (`cpap` → `peep_cmh2o`; optional apnoea `backup_rate`, /min, 0 = off) |
| `set_pause(seconds)` | Set the end-inspiratory hold for any time-cycled mode (clamped `< insp_time`) |
| `set_fio2(new_fio2)` | Re-derive fresh-gas composition (a fraction ≤ 1, or a percentage > 1) |
| `set_humidity(new_humidity)` / `set_temp(new_temp)` | Re-derive fresh-gas composition (both `VENT_GASIN` and `VENT_GASCIRCUIT`), and push the new humidity / temperature onto those compartments — see note below |
| `set_ettube_diameter(d)` / `set_ettube_length(l)` | Update tube geometry → resistance |
| `trigger_breath()` | Manual breath: ignored during inspiration, otherwise delivered after the minimal expiratory time (all modes except CPAP) |
| `set_tube_position(pos)` | Airway event: `"trachea"`, `"right_main"` or `"extubated"` (see [Airway events](#airway-events)) |
| `set_circuit_connected(state)` | Airway event: `false` disconnects the circuit from the tube |

> **Why the setters write to the gas compartments directly.** `humidity` and `target_temp` are live
> targets that [`GasCapacitance`](./GasCapacitance.md) relaxes toward on every step. Setting only the
> Ventilator's own `temp`/`humidity` and recomputing the composition is not enough — the compartment
> keeps its old targets and is dragged straight back. `set_temp` therefore also sets
> `VENT_GASIN.temp`/`target_temp` and `VENT_GASCIRCUIT.target_temp`, and `set_humidity` sets
> `humidity` on both. Note that `VENT_GASIN` is `fixed_composition`, so `add_heat`/`add_watervapour`
> skip it entirely and it holds whatever it is given.
>
> **Humidifier at start-up.** `_apply_humidifier()` (temp, target_temp and humidity on
> `VENT_GASIN`/`VENT_GASCIRCUIT`, then their composition) runs in `init_model`, but `Gas.init_model`
> runs *after* the Ventilator and resets every gas compartment to the ambient temperature and FiO₂.
> `init_model` therefore clears `_humidifier_applied` again, so the humidifier is re-applied on the
> ventilator's first step; `switch_ventilator(true)` applies it too. Before this fix the circuit sat
> at the scenario's 20 °C instead of 37 °C.
>
> **The composition setters do not step the compartment.** `calc_gas_composition` (in
> `GasComposition.js`) reads the compartment pressure as it stands; it no longer calls the
> compartment's `calc_model`, which used to add an extra heat / water-vapour step on every setter
> call.

## Example definition (JSON)

A typical neonatal ventilator block (from `term_neonate_72h.json`), trimmed to the device-level fields —
the full definition also nests the six `VENT_*` sub-models under `components`:

```json
{
  "name": "Ventilator",
  "description": "mechanical ventilator model",
  "is_enabled": false,
  "model_type": "Ventilator",
  "components": { "VENT_GASIN": { "...": "GasCapacitance" },
                  "VENT_GASCIRCUIT": { "...": "GasCapacitance" },
                  "VENT_GASOUT": { "...": "GasCapacitance" },
                  "VENT_INSP_VALVE": { "...": "Resistor" },
                  "VENT_ETTUBE": { "...": "Resistor, comp_to: DS" },
                  "VENT_EXP_VALVE": { "...": "Resistor" } },
  "pres_atm": 760,
  "fio2": 0.21,
  "humidity": 1,
  "temp": 37,
  "ettube_diameter": 3.5,
  "ettube_length": 110,
  "vent_mode": "PC",
  "vent_rate": 40,
  "tidal_volume": 0.015,
  "insp_time": 0.4,
  "insp_pause": 0,
  "insp_flow": 12,
  "exp_flow": 3,
  "pip_cmh2o": 14,
  "pip_cmh2o_max": 14,
  "peep_cmh2o": 3,
  "trigger_volume_perc": 6,
  "synchronized": true
}
```

`is_enabled: false` is the normal resting state — the ventilator is switched on at runtime via
`switch_ventilator(true)` (or by `Resuscitation.switch_cpr`).

## Inputs and outputs

- **Reads:** its circuit components; `DS` (pCO2, the tube's dead-space sub-tanks); the lungs through the airway; `Breathing` (`ncc_insp`, `insp_running`, `breathing_enabled`, `resp_rate`) for triggering and monitoring.
- **Writes:** its circuit (valves, volumes, compositions, resistances); `MOUTH_DS.no_flow` (natural airway closed while intubated); `DS.tube_volume`/`tube_port_model` (tube dead space); `Respiration.set_tube_block` (right-main intubation).
- **Written by:** the user and bot (modes and settings through the `set_*` API); [Resuscitation](./Resuscitation.md) (CPR ventilation); [Sle6000](./Sle6000.md) (its subclass).
- **Read by:** Monitor (etCO2 and breath detection: `ncc_insp`, `_inspiration`, `is_enabled`), the app's ventilator screens, `DataCollector` watchers.

## Usage in the model

- One `Ventilator` per scenario; disabled at rest so the patient breathes spontaneously through
  `MOUTH_DS`. Turn it on with `switch_ventilator(true)` and pick a mode with `set_pc` / `set_prvc` /
  `set_psv` / `set_cpap`.
- The [`Resuscitation`](./Resuscitation.md) model drives the ventilator during CPR (`switch_cpr`
  starts it in PC and pulses `trigger_breath()` for the ventilation pauses).
- The [`Breathing`](./Breathing.md) model measures its tidal volume at the lungs, so spontaneous
  tidal-volume feedback continues during CPAP/PS whatever the airway route (see "Coupling to
  `Breathing`").

## Assumptions and limitations

- **An ideal device.** Valves respond within one step (unless `pres_response_tau` is set); no circuit compliance beyond the circuit compartment; no humidifier water loss.

- **`compliance`/`resistance` are measured per breath** at end-expiration (in
  `calc_measured_mechanics`), not recomputed every step. `compliance` mirrors `compliance_dynamic`
  (mL/cmH₂O). Static compliance and airway resistance (cmH₂O/(L/s)) require an inspiratory pause
  (`insp_pause > 0`); without one, `compliance_static = 0` and `resistance = null`.
- **`resistance` may be `null`** whenever no plateau was measured — downstream displays must tolerate
  a null.
- **Re-enabling is clean.** `switch_ventilator` calls `_reset_state()`, zeroing the internal cycle
  counters/flags so a re-enabled ventilator starts a fresh breath rather than resuming mid-cycle.
- **`trigger_breath()` takes no arguments.** It is ignored during inspiration (it used to restart
  the running breath) and works in `PS` too (it used to do nothing there).
- **`set_fio2` percent/fraction rule**: values ≤ 1 are treated as a fraction, values > 1 as a
  percentage (so `20` → 0.20, `45` → 0.45).
- **VC delivered volume is servo-trimmed.** `volume_control_servo` converges `exp_tidal_volume` on the
  set `tidal_volume` across circuits/flows; a too-low `insp_flow` still flow-limits and undershoots.
- **External-model references are null-safe.** `DS` (et/CO₂), `MOUTH_DS` (mouth blocking) and the
  `Breathing` model (trigger) are guarded with `?.`; the `VENT_*` sub-models are the ventilator's own
  components and are assumed present after build.
- **`exp_time` is floored at `_min_exp_time` (0.1 s)** — `60/vent_rate − insp_time` can no longer go
  negative at very high rates / long `insp_time`, so the cycler cannot jam into continuous inspiration.

## References

- ISO 80601-2-12 (critical care ventilators): the expiratory-limb pressure drop limits used for the automatic expiratory valve.
- SLE6000 instructions for use: monitoring definitions (see [Sle6000](./Sle6000.md)).

````

### FILE: explain-engine/docs/chd_duct_fo_dependent.md

```markdown
# Duct- and Foramen-Ovale-Dependent Congenital Heart Disease

*A clinical reference and engine-mapping for the Explain neonatal simulator.*

This document catalogs the **congenital heart defects (CHD) that dominate the neonatal intensive care unit because they depend on the ductus arteriosus and/or the foramen ovale (atrial septum) for survival**. These are the lesions in which a neonate is stable in utero and for the first hours-to-days of life, then collapses — with profound cyanosis or cardiogenic shock — as the duct and/or foramen ovale physiologically close. That transition, and the way it is governed by the pulmonary-to-systemic flow ratio (Qp:Qs) and the PVR/SVR balance, is exactly the physiology a simulator can teach.

It is organized in four parts:

1. **[Physiological taxonomy](#1-physiological-taxonomy)** — the four dependency categories.
2. **[Lesion catalog](#2-lesion-catalog)** — the curated NICU-core set, each mapped to the engine's levers.
3. **[Engine-lever summary & limitations](#3-engine-lever-summary--limitations)** — what is buildable today, what needs rewiring, what the engine cannot represent.
4. **[Build roadmap](#4-build-roadmap)** and **[bibliography](#5-bibliography)**.

> Scope note: this is the *curated NICU-core set* (~14 lesions across all four categories), not an exhaustive enumeration of every duct/FO-dependent variant.

---

## 1. Physiological taxonomy

The clinical organizing principle is **what the patent channel is keeping alive**:

| Category | What the duct/FO supplies | Closure event → presentation |
|---|---|---|
| **A. Duct-dependent pulmonary blood flow** | Lungs (systemic→pulmonary flow via PDA) | Duct closes → profound, O₂-resistant **cyanosis** |
| **B. Duct-dependent systemic blood flow** | Body (right→left flow via PDA) | Duct closes → **cardiogenic shock** (mimics sepsis) |
| **C. Duct- *and* FO-dependent mixing** (d-TGA) | Inter-circulatory mixing (parallel circuits) | Inadequate mixing → cyanosis; needs PDA **and** atrial shunt |
| **D. FO / atrial-septum-dependent** | Obligatory atrial-level shunt | Restrictive/intact atrial septum → emergency |

The unifying teaching concept is the **balanced parallel circulation**. In a duct-dependent lesion the systemic and pulmonary circuits run in parallel (rather than in series), sharing output across the duct and/or a septal communication; the patient's stability is set by the Qp:Qs ratio, which is in turn governed by the relative resistances of the two beds (PVR vs SVR). Lowering PVR (extra O₂, hyperventilation, alkalosis) floods the lungs at the expense of systemic flow in duct-dependent *systemic* lesions, and conversely helps in duct-dependent *pulmonary* lesions. This PVR/SVR lever is precisely what the engine exposes, which is why these lesions are well-suited to simulation (Khalil/Schranz 2019 [#1]; Martins 2008 [#16]).

**Prostaglandin E1 (alprostadil, PGE1)** maintains or reopens ductal patency and is the shared pharmacological rescue across categories A, B, and C; the highest-tier evidence is the Cochrane review (Akkinapally 2018 [#4]). Category D lesions add a second rescue — **balloon atrial septostomy** (the Rashkind procedure, first described 1966 [#17]) — to enlarge the atrial communication. Pulse-oximetry screening for critical CHD (pre- and post-ductal SpO₂) is the population-level safety net (Mahle 2009 AHA/AAP statement [#6]).

---

## 2. Lesion catalog

For each lesion: the **dependency**, the **mechanism**, and the **engine levers** that reproduce it. All cited engine identifiers were verified against the current tree:

- Ductus → `Pda` model, resistor `AAR_DA` wired `AAR → PA`, levers `diameter_relative` / `length` / `discharge_coeff` (bidirectional; see [`Pda.js`](../component_models/Pda.js) and [`docs/Pda.md`](./Pda.md) if present).
- Foramen ovale → `Shunts.diameter_fo` (LA↔RA via the split resistors `LA_RAIVCI` / `LA_RASVC`, with flap-valve asymmetry `fo_lr_factor`); restrictive/intact = `diameter_fo → 0`.
- VSD → `Shunts.diameter_vsd` (LV↔RV). Intrapulmonary shunt → `Shunts.ips_res`. See [`Shunts.js`](../component_models/Shunts.js).
- Valves are `HeartValve`s (a `Resistor` subclass) in `Heart.components`: `LA_LV` (mitral), `RV_PA` (pulmonary), `LV_AA` (aortic). The **tricuspid is split** into two resistors `RAIVCI_RV` + `RASVC_RV` (there is no single `RA_RV` valve model — `RA_RV` is only a diagram connector grouping the two). **Atresia** = `no_flow: true`; **stenosis** = raise `r_for` (set on both halves of the tricuspid).
- **TGA outflow tracts are pre-wired but disabled** in `term_neonate_72h.json`: `RV_AA` (RV→AA, `is_enabled: false`) and `LV_PA` (LV→PA, `is_enabled: false`), alongside the normal `RV_PA` and `LV_AA`.

### A. Duct-dependent pulmonary blood flow

In these lesions the right-heart outflow to the lungs is obstructed or absent, so pulmonary blood flow arrives **backwards through the duct** (aorta → PDA → pulmonary artery). Ductal closure causes profound, oxygen-resistant cyanosis.

- **A1 — Pulmonary atresia with intact ventricular septum (PA-IVS).** *Also FO-dependent.* The RV outflow is blind; lungs are fed only by the PDA, and all systemic venous return must cross the foramen ovale right→left to reach the left heart. RV and tricuspid valve are hypoplastic; ~10% have an RV-dependent coronary circulation, the key risk modifier (Chikkabyrappa 2018 [#9]; Jaggers AATS consensus 2025 [#10]).
  *Engine:* `RV_PA.no_flow = true`; `Pda.diameter_relative > 0`; `Shunts.diameter_fo > 0` (R→L); RV hypoplasia via `Heart.components.RV` `el_min`↑ / `u_vol`. **Fully buildable.**
  **✅ BUILT** as `pa_ivs` — `scripts/archive/_make_paivs.mjs` → `reseed_paivs.mjs` → `probe_paivs.mjs`. Calibrated: **zero antegrade flow** (atretic `RV_PA`), the **duct is the sole pulmonary supply** (≈ 590 mL/min, aorta→PA L→R), a **suprasystemic hypertensive blind RV** (peak ≈ 70 mmHg) that decompresses only through a restrictive **tricuspid-regurgitation jet** (≈ 500 mL/min — its single outlet), and an **obligate R→L FO** (≈ 500 mL/min = the whole systemic venous return) feeding the LV-only output → cyanosis (SpO₂ ≈ 74%, pO₂ ≈ 32 mmHg), MAP preserved at 50. Levers: `RV_PA.no_flow` (atresia, not stenosis — contrast `critical_ps`), `diameter_vsd: 0` (intact septum), RV hypoplasia (`el_min: 2500`, `u_vol: 0.002`), **tricuspid regurgitation** (`RAIVCI_RV`/`RASVC_RV` `no_back_flow: false`, `r_back: 5000` — a restrictive r_back lets the blind RV pressurize to suprasystemic levels yet stay volume-stable; free TR leaves it flaccid at ~12 mmHg, no TR traps volume), `diameter_fo: 6` (left at baseline `fo_lr_factor: 25` — R→L easy), `Pda.diameter_relative: 1.0`. Left heart structurally normal → no engine change. RV-dependent coronary circulation (sinusoids, ~10% of cases) not modeled.

- **A2 — Pulmonary atresia with VSD.** Lungs fed by the PDA and/or major aortopulmonary collateral arteries (MAPCAs). With a VSD the RV decompresses into the LV/aorta (Soquet 2019 [#11]; Presnell 2015 [#12]).
  *Engine:* `RV_PA.no_flow = true`; `Shunts.diameter_vsd > 0`; `Pda` open. **Buildable without MAPCAs** — collateral vessels are not modelable (see [limitations](#3-engine-lever-summary--limitations)).
  **✅ BUILT** as `pa_vsd` — `scripts/archive/_make_pavsd.mjs` → `reseed_pavsd.mjs` → `probe_pavsd.mjs`. Calibrated: **zero antegrade flow** (atretic `RV_PA`), a large VSD lets the **RV decompress into the LV/aorta** (`diameter_vsd: 5`, VSD flow RV→LV ≈ 450 mL/min, **RV/LV peaks equilibrated at 71/70 mmHg** — *not* a blind hypertensive RV, contrast PA-IVS), so the atrial septum stays intact (`diameter_fo: 0` — **not** FO-dependent); the **duct is the sole pulmonary supply** (`Pda.diameter_relative: 1.0`, fat 4 mm duct, ≈ 750 mL/min, no MAPCAs), mixed aortic blood → cyanosis (SpO₂ ≈ 78%, pO₂ ≈ 34), MAP 47. **Profoundly duct-dependent** — closing the duct crashes SpO₂ to ≈ 14% (the duct is the *only* pulmonary flow). *Calibration:* both ventricles eject into one aortic outlet, which the lumped model over-pumps, so `Heart.cont_factor_left/right: 0.6` normalizes the combined systemic output (a geometry compensation, not intrinsic weakness). Left heart normal → no engine change. **Limitation:** MAPCAs (a real alternative pulmonary supply) are not modelable — so duct closure here is more catastrophic than a MAPCA-supplied patient.

- **A3 — Critical pulmonary stenosis.** Severe but not complete RVOT obstruction; duct-dependent when critical. A right→left atrial "pop-off" across the FO offloads the pressured RA (Latson 2001 [#13]; Aggarwal 2018 [#14]).
  *Engine:* `RV_PA.r_for`↑ (stenosis, keep some antegrade flow); `Pda` open; `Shunts.diameter_fo` for the atrial pop-off. **Fully buildable.**
  **✅ BUILT** as `critical_ps` — `scripts/archive/_make_cps.mjs` → `reseed_cps.mjs` → `probe_ps.mjs`. Calibrated: **suprasystemic, pressure-loaded RV** (peak ≈ 110 mmHg) with an 84 mmHg trans-valvular gradient and a low post-stenotic PA; antegrade flow is a trickle (≈ 180 mL/min) while the **duct supplies the majority of pulmonary flow** (≈ 310 mL/min, aorta→PA L→R — close it and pulmonary flow halves); a **right→left FO pop-off** (≈ 340 mL/min) drives cyanosis (SpO₂ ≈ 77%, pO₂ ≈ 33 mmHg), systemic MAP preserved. Levers: `RV_PA.r_for: 8000` (patent — not atretic), `Heart.cont_factor_right: 0.6` (the pressure-loaded RV beginning to fail — keeps the peak realistic and deepens the pop-off), `Pda.diameter_relative: 0.7`, `diameter_fo: 5`. *Note:* the FO is left at the baseline `fo_lr_factor: 25` — its fetal-flap asymmetry already makes R→L easy, exactly the direction this lesion needs (contrast HLHS/TGA, which need `fo_lr_factor ≈ 1`). Left heart structurally normal → no engine change. *Modeling caveat:* the linear-resistance valve + time-varying-elastance RV trade peak pressure against antegrade flow, so the realistic peak comes via a mildly failing RV rather than a 200 mmHg hypercontractile one.

- **A4 — Tricuspid atresia (with pulmonary stenosis/atresia).** *Also FO-dependent.* The tricuspid valve is absent, so **all** systemic venous return is obligated right→left across the FO into the LA; the functionally single LV then supplies the body, while pulmonary flow comes via a VSD and/or the duct (Sumal 2020 [#15]). A restrictive atrial septum is poorly tolerated.
  *Engine:* `RA_RV.no_flow = true`; `Shunts.diameter_fo` (obligate R→L); `Shunts.diameter_vsd`; RV hypoplasia; `Pda` if pulmonary atresia / severe PS. **Buildable** (functionally single LV).
  **✅ BUILT** as `tricuspid_atresia` (type Ib — normally related great arteries, restrictive VSD + pulmonary stenosis, the cyanotic reduced-pulmonary-flow form) — `scripts/archive/_make_ta.mjs` → `reseed_ta.mjs` → `probe_ta.mjs`. Calibrated: **obligate FO R→L** (≈ 500 mL/min = the whole systemic venous return), the **single LV** as the only pump (CO ≈ 0.78 L/min), pulmonary flow reaching the lungs only via the **VSD→RV→PA route** (≈ 465 mL/min — the hypoplastic RV acts as a conduit, so VSD flow ≈ antegrade Qp) **supplemented duct-dependently** (duct L→R ≈ 300 mL/min; closing the duct drops SpO₂ 80→74%), cyanosis (SpO₂ ≈ 80%, pO₂ ≈ 35 mmHg), MAP 49 / PAP 33. Levers: the split tricuspid `RAIVCI_RV` + `RASVC_RV` `no_flow` (atresia), RV hypoplasia (`el_min: 2200`, `u_vol: 0.0025`, VSD-fed), `diameter_fo: 6` (baseline `fo_lr_factor: 25` → R→L easy), `diameter_vsd: 2` (restrictive) + `RV_PA.r_for: 800` (pulmonary stenosis) + `Pda.diameter_relative: 0.8`. Left heart normal → no engine change (single LV uses the normal cycle path). Cross-listed as a Category-D (FO-dependent) teaching case.

- **A5 — Tetralogy of Fallot with pulmonary atresia / severe RVOT obstruction.** Large VSD with an overriding aorta; in the pulmonary-atresia form, pulmonary flow is duct- (±MAPCA-) dependent (Miller AATS consensus 2022 [#18]; Bailliard 2009 [#19]).
  *Engine:* large `Shunts.diameter_vsd`; `RV_PA` high `r_for` (or `no_flow` for atresia); `Pda`; the aortic override via the pre-wired `RV_AA` valve (RV→AA) enabled alongside `LV_AA`.
  **✅ BUILT** as a four-phenotype family — `tof_pink`, `tof` (headline), `tof_severe`, `tof_pa` — term neonate **24 h old, 3.3 kg** (term_neonate_72h allometrically scaled from 3.545 kg with `weight_scale`, volumes only). `scripts/archive/_make_tof.mjs` → `reseed_tof.mjs` → `probe_tof.mjs`. Shared levers: `diameter_vsd: 5` (RV/LV peaks equalise in every variant — non-restrictive), `RV_AA` enabled so both ventricles eject into the aorta (RV share of aortic inflow ≈ 33–35%, 15% in `tof_pink`), `Heart.cont_factor_left/right` 0.7 (0.75 pink) to normalise the two-into-one-outlet output (as `pa_vsd`), `diameter_fo: 1.5` (small PFO). **No extra RV hypertrophy** — RVH develops postnatally under systemic loading (Alipour Symakani 2023), so the RV chamber keeps baseline stiffness on day 1. Calibrated operating points (ANS on, after reseed):

  | scenario | `RV_PA.r_for` | duct (`diameter_relative`, max) | RVOT gradient | VSD net | Qp:Qs | SpO₂ | MAP | Qs mL/kg/min |
  |---|---|---|---|---|---|---|---|---|
  | `tof_pink` | 600 (`RV_AA.r_for` 300) | 0 (closed) | 22 mmHg | L→R 275 mL/min | 1.38 | 93% | 51 | 156 |
  | `tof` | 1500 | 0.3, 3 mm (closing) | 37 mmHg | bidirectional (net L→R 120) | 0.93 | 85% | 52 | 164 |
  | `tof_severe` | 3000 | 0.6, 4 mm (on PGE1) | 37 mmHg | bidirectional ≈ 0 | 1.2 | 82% | 49 | 152 |
  | `tof_pa` | atretic (`no_flow`) | 0.8, 4 mm (sole Qp) | – | R→L | 1.36 | 78% | 50 | 144 |

  Duct dependence (`probe_tof.mjs <key> --close-duct`): `tof` barely moves (85→84%); `tof_severe` falls to SpO₂ ≈ 68%, Qp:Qs 0.55 (and decompensates further on longer runs); `tof_pa` collapses (SpO₂ < 20%, MAP ≈ 13).
  *Modeling notes:* (1) **VSD stability ceiling** — `diameter_vsd` above 5 mm makes the Poiseuille VSD resistance (∝ 1/d⁴) so low that the explicit step loop goes unstable (VSD flow oscillating at tens to hundreds of L/min); 5 mm already behaves as non-restrictive, so real 6–9 mm VSDs are represented at 5 mm. (2) Each variant is a **24 h snapshot** — no automatic ductal closure or PVR fall. (3) **Tet spells** (dynamic infundibular obstruction) are rare in the first days and not modelled as a mechanism; demonstrate one live by tweening `RV_PA.r_factor_ps` ×3–5 over ~20 s in `tof` (`setPropValue("RV_PA.r_factor_ps", 4, 20, 0)`; measured steady state: ×3 → SpO₂ 67%, ×5 → 57%, VSD reverses to net R→L, Qp:Qs 0.3–0.5) and rescue by raising SVR (knee-chest / phenylephrine), giving volume, and a β-blocker; back out the factor to end the spell. Refs: Bailliard 2009 [#19]; Vetten et al., *Prenat Diagn* 2025 (PMC12137033); Taiwo et al., *Glob Pediatr Health* 2022 (PMC9112315); Alipour Symakani et al., *Front Pediatr* 2023 (PMC10061113).

- **A6 — Severe (neonatal) Ebstein anomaly with functional pulmonary atresia.** Massive tricuspid regurgitation plus high PVR leaves the RV unable to open the pulmonary valve, so pulmonary flow becomes duct-dependent; much of the RV is "atrialized" (Luxford 2017 [#20]; Linnenbank 2025 [#21]).
  *Engine:* `RA_RV.r_back`↓ (tricuspid regurgitation), `Heart` RV contractility↓, `RV_PA` functionally closed, `Pda` open. **Partially buildable** — the *atrialized RV* cannot be represented as a separate chamber (fixed chamber set); approximate with TR + a weak RV.

### B. Duct-dependent systemic blood flow

Here the left-heart outflow to the body is obstructed or absent, so systemic perfusion arrives **right→left through the duct** (pulmonary artery → PDA → descending aorta). Ductal closure causes cardiogenic shock that mimics sepsis.

- **B1 — Hypoplastic left heart syndrome (HLHS).** *Also FO-dependent.* The LV cannot support the systemic circulation; the entire cardiac output is delivered by the RV → PDA → aorta, perfusing the arch and coronaries **retrograde**. Pulmonary venous return is obligated left→right across the FO. An intact or highly restrictive atrial septum is a lethal combination requiring emergent decompression (Connor 2007 [#22]; Schranz duct-stenting 2024 [#23]; Vlahos 2004 [#26]; Generali 2022 [#27]).
  *Engine:* `LV_AA.no_flow` or severe `r_for`↑ + LV hypoplasia (reuse the `cdh_lv_dysfunction` LV levers: `Heart.cont_factor_left`, LV `el_min` / `u_vol`); `LA_LV.no_flow` or high `r_for` (mitral atresia/stenosis); `Shunts.diameter_fo` L→R; `Pda` carrying R→L (PA→AAR; the `AAR_DA` resistor is bidirectional). The *restrictive/intact-septum* variant (`diameter_fo → 0`) is a high-value teaching toggle.
  **✅ BUILT** as `hlhs` (mitral + aortic atresia → LV fully excluded) — `scripts/archive/_make_hlhs.mjs` → `reseed_hlhs.mjs` → `probe_hlhs.mjs`. Calibrated single-RV parallel circulation: RV output ≈ 1.2 L/min split **Qp:Qs ≈ 1.7** (mild pulmonary over-circulation, the typical balance), systemic Qs ≈ 0.46 L/min via the duct (PA→aorta, R→L), **retrograde aortic-arch and coronary perfusion** (AAR→AA), obligate FO L→R ≈ 0.75 L/min, moderate cyanosis (SpO₂ ≈ 78%, pO₂ ≈ 34 mmHg), PAP > MAP (RV is the systemic pump). Levers: mitral+aortic atresia, `diameter_fo: 6` / `fo_lr_factor: 1`, `Pda.diameter_relative: 1.0` with a fat 4 mm duct, hypoplastic AA (`u_vol ×0.6`, `el_base ×1.4`), **pulmonary arteriolar resistance ×2 to balance Qp:Qs** (at baseline PVR the lungs steal the output → Qp:Qs ≈ 3.5, systemic hypoperfusion — itself a teaching failure mode). A second engine generalization was needed: `Heart.calc_model` now derives the cardiac cycle from the ventricular activation window when the LV has *no* outflow (aortic atresia → both `LV_AA` and `LV_PA` disabled), so the single-RV physiology keeps a valid cycle (and `HeartFunction` inputs); identity for any heart with a working LV outflow (normal, TGA, tricuspid atresia, PA-IVS).
  **✅ Restrictive/intact-septum variant BUILT** as `hlhs_restrictive` (same builder, only the atrial lever differs: `diameter_fo: 1`). The atrial communication is too small to pass the whole pulmonary venous return, so the LA cannot decompress: **LA pressure rises to ≈ 21 mmHg** (vs 4.5 open — a ≈ 19 mmHg trans-septal gradient = severe pulmonary venous hypertension), the obligate shunt is choked (≈ 420 vs 750 mL/min), single-RV preload/output fall (≈ 0.8 vs 1.2 L/min), and hypoxaemia is severe (**SpO₂ ≈ 64%, pO₂ ≈ 28 mmHg, pH ≈ 7.30**) — the lethal emergency needing immediate atrial decompression (balloon/blade septostomy or stenting). It remains a stable steady state because the septum is restrictive, not fully intact (`diameter_fo → 0` would trap the LA entirely and collapse). Alveolar oedema is not separately modeled — the hypoxaemia arises from the reduced pulmonary flow + obligatory mixing.

- **B2 — Critical aortic stenosis.** The LV cannot eject across the valve, so systemic perfusion becomes duct-dependent; high LV wall stress impairs coronary perfusion and drives LV dysfunction (Affolter 2014 [#24]).
  *Engine:* `LV_AA.r_for`↑; LV strain via the existing `HeartFunction` load-induced contractility model; `Pda` open. **Fully buildable.**
  **✅ BUILT** as `critical_as` — `scripts/archive/_make_cas.mjs` → `reseed_cas.mjs` → `probe_as.mjs`. Calibrated (left-sided mirror of `critical_ps`): **pressure-loaded, failing LV** (peak ≈ 127 mmHg, 83 mmHg trans-valvular gradient — a low-flow/low-gradient state) with reduced antegrade aortic flow (≈ 190 mL/min) while the **duct supplies ~40% of systemic flow** (R→L ≈ 125 mL/min, PA→aorta — close it → systemic shock); **differential cyanosis** (pre-ductal SpO₂ ≈ 96% from the LV-fed upper body vs post-ductal ≈ 85% from the duct-fed lower body); mild LA congestion (≈ 7.5 mmHg) decompressing L→R across the FO; low MAP (≈ 39) with compensatory tachycardia — the decompensating low-output picture. Levers: `LV_AA.r_for: 8000` (patent — not atretic, contrast HLHS), `Heart.cont_factor_left: 0.4` (failing LV — keeps the peak realistic ~110–130 not ~190 and deepens duct-dependence + differential cyanosis), `Pda.diameter_relative: 1.0`, `diameter_fo: 2.5` / `fo_lr_factor: 4` (modest L→R LA decompression). Aortic valve patent → no engine change. *Same modeling caveat as critical PS:* the realistic LV peak comes via a failing LV rather than a 190 mmHg hypercontractile one.

- **B3 — Critical coarctation of the aorta.** A discrete narrowing at the isthmus; the lower body is perfused by right→left ductal flow into the descending aorta, and abrupt ductal closure causes shock (Ganigara 2019 [#25]; Egan 2009 [#28]).
  *Engine:* `AAR_AD.r_for`↑ (or `no_flow` for near-atretic); `Pda` open feeding the lower body. **Buildable with a wiring note** — see B3/B4 caveat in [§3](#3-engine-lever-summary--limitations).
  **✅ BUILT** as `coarctation` — `scripts/archive/_make_coarc.mjs` → `reseed_coarc.mjs` → `probe_coarc.mjs`. Calibrated: a tight but patent isthmus gives the hallmark **pre/post-ductal pressure gradient** (upper body 101/55 vs lower 30/16, ≈ 55 mmHg mean — upper-body hypertension / weak femorals), a duct-dependent lower body (an antegrade isthmus trickle ≈ 130 mL/min plus the duct R→L ≈ 15 mL/min), and **differential cyanosis** (pre-ductal 97% vs post-ductal 87%). *Two engine facts resolved the wiring note (both JSON-only, no code change):* (1) re-point the duct to the descending aorta — `Pda.components.AAR_DA.comp_from: "AD"` (the `Pda` model drives whatever endpoints its resistor names, so the duct desaturates only the lower body → correct differential cyanosis); (2) the isthmus lever is **`Circulation.components.AD.r_for`** (= 30000 here), *not* `AAR_AD.r_for` — the `AD` BloodVessel adopts its same-named input resistor `AAR_AD` and overwrites `r_for` with `AD.r_for_eff` every step, so a direct edit to `AAR_AD.r_for` is wiped.

- **B4 — Interrupted aortic arch (IAA).** The aortic arch is discontinuous; the descending aorta is perfused entirely through the duct. Almost always with a VSD and a strong association with 22q11 deletion (DiGeorge). PGE1 "revolutionized" its management (Jonas 2015 [#29]; Burbano-Vera 2018 [#30]).
  *Engine:* `AAR_AD.no_flow = true`; `Shunts.diameter_vsd`; ductal lower-body path. **Buildable with rewire** (same caveat as B3).
  **✅ BUILT** as `iaa` (same builder as `coarctation`) — interruption is **`Circulation.components.AD.no_flow = true`** (the `AD` vessel propagates `no_flow` to the `AAR_AD` isthmus resistor). The lower body is **entirely duct-dependent** (isthmus flow = 0, duct R→L ≈ 210 mL/min into the descending aorta), with the characteristic **VSD** (`diameter_vsd: 4`, L→R ≈ 780 mL/min) and **differential cyanosis** (pre-ductal 97% vs post-ductal 84%). Same duct re-point as B3. 22q11/DiGeorge association is clinical context only (not modeled).

### C. Duct- and FO-dependent mixing

- **C1 — d-Transposition of the great arteries (d-TGA).** The aorta arises from the RV and the pulmonary artery from the LV, creating **two circulations in parallel** rather than in series. Survival is impossible without mixing — at the atrial level (FO/ASD), through the duct, and/or via a VSD. Cyanosis is inversely proportional to the amount of mixing. The classic neonatal rescue is PGE1 plus balloon atrial septostomy (Rashkind), pending the arterial switch (Martins 2008 [#16]; Rashkind 1966 [#17]; Cucerea 2024 [#33]; Beitzke 1983 [#35]).
  *Engine:* enable `RV_AA` + `LV_PA` and disable `RV_PA` + `LV_AA` (**all four already pre-wired in `term_neonate_72h.json`**); mixing via `Shunts.diameter_fo` + `Pda` (+ optional `diameter_vsd`). A septostomy is demonstrable by ramping `diameter_fo` via the event scheduler.
  **✅ BUILT** as `dtga` (intact ventricular septum) — `scripts/archive/_make_dtga.mjs` → `reseed_dtga.mjs` → `probe_dtga.mjs`. Calibrated to a stable parallel circulation (Qp:Qs ≈ 1, balanced ~0.8 L/min outputs) with cyanosis (SpO₂ ≈ 59%, pO₂ ≈ 25 mmHg). Mixing levers: `diameter_fo: 6`, `fo_lr_factor: 1` (a true ASD/septostomy hole is symmetric — a high flap factor would throttle the LA→RA flow that oxygenates the systemic circuit), `Pda.diameter_relative: 1.0`, `diameter_vsd: 0`. *Note:* FO ≥ ~7 mm at `fo_lr_factor 1` makes the Hagen-Poiseuille atrial resistance so low the explicit solver oscillates — keep septostomy demos at/below 6 mm or raise `atrial_septal_width`. One small engine generalization was needed: `Heart.calc_model` now detects end-systole from whichever LV outflow valve is active (`LV_AA` if enabled, else `LV_PA`), so the cardiac-cycle analysis and `HeartFunction` wall-stress inputs stay valid with the great arteries transposed (identity for normal anatomy).

### D. Foramen-ovale / atrial-septum-dependent

These lesions depend on an **obligatory atrial-level shunt**; a restrictive or intact atrial septum turns them into an emergency.

- **D1 — Total anomalous pulmonary venous connection (TAPVC), especially obstructed.** The pulmonary veins drain to the systemic venous side instead of the LA, so an obligatory right→left atrial shunt across the FO is the only way to fill the left heart. The obstructed form presents with severe cyanosis and low output, is **unresponsive to prostaglandin**, and is one of the few true neonatal cardiac-surgical emergencies (Ross 2017 [#36]; Vanderlaan 2018 [#37]; Campbell 2022 [#38]).
  *Engine:* reroute the pulmonary venous return (`PV_LA`) so it enters the right side, adding the anomalous connection with high `r_for` for the obstructed variant; `Shunts.diameter_fo` obligate R→L. **Buildable with a pulmonary-venous rewire.**
  **✅ BUILT** as `tapvc` (unobstructed) + `tapvc_obstructed` — `scripts/archive/_make_tapvc.mjs` → `reseed_tapvc.mjs` → `probe_tapvc.mjs`. The reroute is **JSON-only**: `PV_LA.comp_to: "SVC"` (the pulmonary veins drain to the SVC — supracardiac, the commonest type). *Diagram:* the `PV_LA` connector is re-pointed PV→SVC ("vertical vein"), so the animation shows the anomalous drainage and an LA fed only across the foramen ovale. PV keeps its ring position; since the SVC is off the ring, the path renders as a curved chord across the diagram interior, drawn `arc_flip` so it bends up over the pulmonary side rather than down over the upper-body nodes (a straight one would lie on top of the FO chord). `PV_LA` is a free-standing Resistor (the `LA` HeartChamber doesn't adopt it), so its `comp_to` *and* `r_for` set directly — the channel `r_for` is the obstruction lever. The FO is opened (`diameter_fo: 6`, baseline `fo_lr_factor: 25` → R→L easy) to carry the obligate shunt that fills the *entire* left heart; the duct stays closed (TAPVC is FO-dependent, not duct-dependent → PGE1-unresponsive). Calibrated (re-tuned 2026-10-01 for the merged RA, `diameter_fo: 8`) — **unobstructed** (`PV_LA.r_for: 335`): full mixing in the RA, normal PV pressure ≈ 10 mmHg, CO ≈ 0.58 L/min, mild cyanosis (SpO₂ ≈ 85%, pO₂ ≈ 40). Before the merge the split RA confined pulmonary venous return to `RASVC` and streamed it toward the FO, which is how the earlier SpO₂ ≈ 87 arose. With true complete mixing, ≈ 85 is the closest the levers reach without dropping PV pressure below normal. **Obstructed** (`PV_LA.r_for: 4600`): **pulmonary venous hypertension** (PV pressure ≈ 36 mmHg, vs a near-normal LA — the pathology is upstream, not in the left atrium), secondary **suprasystemic PAP** (≈ 51 ≥ MAP), low output (CO ≈ 0.43 L/min, MAP ≈ 44), severe cyanosis (SpO₂ ≈ 73%, pO₂ ≈ 31) — the surgical emergency. Alveolar oedema not separately modeled (the hypoxaemia arises from the reduced pulmonary flow + complete mixing).

> Cross-listed: **A1 (PA-IVS)**, **A4 (tricuspid atresia)**, and the **B1 (HLHS) restrictive-septum variant** are equally FO-dependent and double as Category-D teaching cases.

---

## 3. Engine-lever summary & limitations

**Directly available — JSON-only, no engine code change:**

| Defect feature | Lever |
|---|---|
| Ductus arteriosus | `Pda.diameter_relative` / `length` / `discharge_coeff` (AAR↔PA, bidirectional) |
| Foramen ovale | `Shunts.diameter_fo` (LA↔RA, flap-valve asymmetry via `fo_lr_factor`); restrictive/intact = `→0` |
| VSD | `Shunts.diameter_vsd` (LV↔RV) |
| Valve atresia | `RV_PA` / `LV_AA` / `LA_LV` (and tricuspid `RAIVCI_RV` + `RASVC_RV`) → `no_flow: true` |
| Valve stenosis | same valves → raise `r_for` |
| Valve regurgitation | lower `r_back` (e.g. tricuspid for Ebstein) |
| TGA outflow swap | enable `RV_AA` + `LV_PA`, disable `RV_PA` + `LV_AA` (pre-wired) |
| Chamber hypoplasia / dysfunction | `Heart.cont_factor_left/right`, `relax_factor_*`, chamber `el_min` / `u_vol`; `HeartFunction` load-induced contractility |
| Arch obstruction | `Circulation` `AAR_AD` / `AA_AAR` → `r_for`↑ or `no_flow` |
| Qp:Qs / PVR-SVR balance | pulmonary (`PAAL` / `PAAR` / `LL_ART` / `RL_ART`) and systemic bed resistances |

**Needs minor rewiring (JSON, possibly one small helper):**

- ~~**Descending-aorta ductal path (B3 coarctation, B4 IAA).**~~ **RESOLVED — JSON-only, no helper needed.** Re-point the duct with `Pda.components.AAR_DA.comp_from: "AD"` (the `Pda` model drives whatever endpoints its resistor names). The isthmus lever is `Circulation.components.AD.r_for` (coarctation) / `AD.no_flow` (IAA), because the `AD` BloodVessel adopts its same-named input resistor `AAR_AD` and overwrites it each step. Both `coarctation` and `iaa` are built this way.
- ~~**Anomalous pulmonary venous drainage (D1 TAPVC).**~~ **RESOLVED — JSON-only.** `PV_LA.comp_to: "SVC"` (free-standing resistor; the `LA` chamber doesn't adopt it, so `comp_to` and `r_for` both set directly). Built as `tapvc` / `tapvc_obstructed`.

**Genuine engine limitations — document and scope separately:**

- **MAPCAs** (A2, A5) — there is no collateral-vessel model; pulmonary supply must come from the duct alone.
- ~~**Aortic override** (A5 TOF)~~ **RESOLVED — JSON-only.** Enable the pre-wired `RV_AA` valve alongside `LV_AA` so both ventricles eject into the aorta; `RV_AA.r_for` sets the override share. Built as the `tof*` family.
- **Atrialized RV** (A6 Ebstein) — the chamber set is fixed at build time; approximate with severe TR (`RA_RV.r_back`↓) plus a weak RV.

---

## 4. Build roadmap

Each scenario follows the established workflow used for the CDH and PDA families: a `_make_*.mjs` deriver (load `term_neonate_72h.json`, apply a lever table, write JSON) → a `reseed_*.mjs` warm-to-steady-state pass → a `probe_*.mjs` validator. Tiering is by engine friction × clinical importance × reuse of existing assets.

**Tier 1 — build first (JSON-only, highest yield):**
- **d-TGA** (C1) — ✅ **built** (`dtga`); outflow swap pre-wired; flagship.
- **HLHS** (B1) — ✅ **built** (`hlhs`, mitral+aortic atresia) + ✅ **restrictive-septum variant** (`hlhs_restrictive`).
- **Critical pulmonary stenosis** (A3) — ✅ **built** (`critical_ps`).
- **PA-IVS** (A1) — ✅ **built** (`pa_ivs`).
- **Critical aortic stenosis** (B2) — ✅ **built** (`critical_as`).

**Tier 2 — build after a small rewire helper:**
- **Coarctation** (B3) + **IAA** (B4) — ✅ **built** (`coarctation`, `iaa`); the descending-aorta ductal path turned out JSON-only (re-point `AAR_DA.comp_from` to `AD`).
- **TAPVC** (D1) — ✅ **built** (`tapvc` + `tapvc_obstructed`); the pulmonary-venous rewire was JSON-only (`PV_LA.comp_to`).
- **Tricuspid atresia** (A4) — ✅ **built** (`tricuspid_atresia`).
- **PA + VSD** (A2) — ✅ **built** (`pa_vsd`, without MAPCAs).

**Tier 3 — needs an engine extension or accepts an approximation:**
- **Tetralogy of Fallot** (A5) — ✅ **built** (`tof_pink`, `tof`, `tof_severe`, `tof_pa`); override via `RV_AA`, no engine change.
- **Severe neonatal Ebstein** (A6) — atrialized-RV approximation.

**Shared tooling to add alongside Tier 1:**
- `probe_chd.mjs` — extend the `probe_cdh.mjs` pattern to report shunt directions and volumes (ductal, atrial), atrial pressures, the pre-/post-ductal SpO₂ split, and the Qp:Qs ratio.
- A **"close the duct" / "open the septum" event demo** using the existing event scheduler (`TaskScheduler`) to show decompensation as the duct closes and rescue as PGE1 reopens it or septostomy enlarges the FO.

---

## 5. Bibliography

All PMIDs were retrieved and confirmed via PubMed metadata; Rashkind 1966 [#17] and Martins 2008 [#16] were additionally confirmed to resolve. No single dedicated "parallel vs series circulation" paper exists — that concept is anchored to Martins 2008 [#16] and Khalil/Schranz 2019 [#1]. No standalone AHA/AAP PGE1 guideline surfaced; the Cochrane review [#4] is the highest-tier PGE1 source.

### Overarching — ductal-dependent circulation, PGE1, screening
1. Khalil M, … Schranz D. *Transl Pediatr* 2019. PMID 31161078 — classifies critical CHD into duct-dependent systemic / pulmonary / TGA; balanced parallel circulation and PVR/SVR management.
2. Strobel AM. *Emerg Med Clin North Am* 2015. PMID 26226862 — cyanosis-vs-shock presentation framework.
3. Barata IA. *Emerg Med Clin North Am* 2013. PMID 23915599 — early neonatal CHD = ductal-dependent presentations.
4. Akkinapally S, et al. *Cochrane Database Syst Rev* 2018. PMID 29486048 — **PGE1 for ductal patency** (top-tier evidence).
5. Gordon CM, et al. *J Pediatr Pharmacol Ther* 2024. PMID 38332962 — alprostadil dosing / effectiveness.
6. Mahle WT, et al. *Pediatrics* 2009. PMID 19581259 — **AHA/AAP pulse-ox CCHD screening statement**.
7. Mahle WT, et al. *Pediatrics* 2012. PMID 22201143 — AAP/AHA/ACC endorsement adopting CCHD pulse-ox screening.
8. Martin GR, et al. *Pediatrics* 2013. PMID 23776113 — implementation of the screening algorithm.

### Group A — duct-dependent pulmonary
9. Chikkabyrappa SM, et al. *Semin Cardiothorac Vasc Anesth* 2018. PMID 29411679 — PA-IVS preoperative physiology / imaging / management.
10. Jaggers J, et al. *J Thorac Cardiovasc Surg* 2025. PMID 40320005 — 2025 AATS consensus on PA-IVS.
11. Soquet J, Barron DJ, d'Udekem Y. *Ann Thorac Surg* 2019. PMID 30831109 — PA/VSD/MAPCAs management.
12. Presnell LB, et al. *World J Pediatr Congenit Heart Surg* 2015. PMID 26467877 — overview of PA and MAPCAs.
13. Latson LA. *J Interv Cardiol* 2001. PMID 12053395 — critical pulmonary stenosis.
14. Aggarwal V, et al. *Am J Cardiol* 2018. PMID 29681368 — balloon valvuloplasty outcomes in critical PS.
15. Sumal AS, et al. *J Card Surg* 2020. PMID 32484582 — tricuspid atresia review.
18. Miller JR, et al. *J Thorac Cardiovasc Surg* 2022. PMID 36522807 — AATS consensus on TOF in neonates/infants.
19. Bailliard F, Anderson RH. *Orphanet J Rare Dis* 2009. PMID 19144126 — Tetralogy of Fallot (open access).
20. Luxford JC, et al. *Semin Thorac Cardiovasc Surg* 2017. PMID 28823330 — neonatal Ebstein, 30-year review.
21. Linnenbank P, et al. *Children (Basel)* 2025. PMID 40564740 — Starnes→Cone strategy in severe Ebstein.

### Group B — duct-dependent systemic
22. Connor JA, Thiagarajan R. *Orphanet J Rare Dis* 2007. PMID 17498282 — HLHS (open access).
23. Schranz D. *Pediatr Cardiol* 2024. PMID 38664298 — duct stenting in duct-dependent systemic flow.
24. Affolter JT, Ghanayem NS. *Cardiol Young* 2014. PMID 25647388 — critical aortic stenosis, preoperative management.
25. Ganigara M, et al. *Semin Cardiothorac Vasc Anesth* 2019. PMID 31535945 — coarctation, preoperative physiology.
28. Egan M, Holzer RJ. *Expert Rev Cardiovasc Ther* 2009. PMID 19900023 — coarctation treatment comparison.
29. Jonas RA. *Semin Thorac Cardiovasc Surg* 2015. PMID 26686446 — management of interrupted aortic arch.
30. Burbano-Vera N, et al. *Semin Cardiothorac Vasc Anesth* 2018. PMID 29742969 — IAA perioperative considerations.

### Group C — duct/FO-dependent mixing (d-TGA)
16. Martins P, Castela E. *Orphanet J Rare Dis* 2008. PMID 18851735 — **parallel circulations, mixing** (open access).
17. Rashkind WJ, Miller WW. *JAMA* 1966;196(11):991-2. PMID 4160716 — **balloon atrial septostomy** (founding paper).
31. Séguéla PE, et al. *Arch Cardiovasc Dis* 2016. PMID 28024917 — tailored preoperative management of TGA.
32. Zaleski KL, et al. *Pediatr Cardiol* 2021. PMID 33492430 — selective/elective BAS does not eliminate PGE1 need.
33. Cucerea M, et al. *Biomedicines* 2024. PMID 39335532 — PGE1/BAS effects on cerebral oxygenation in d-TGA.
34. Gilg S, et al. *Pediatr Investig* 2024. PMID 38910849 — BAS and continued PGE1 to repair.
35. Beitzke A. *Br Heart J* 1983. PMID 6572529 — prostaglandin raises PaO₂ before septostomy in TGA.

### Group D — FO / atrial-septum-dependent
36. Ross FJ, et al. *Semin Cardiothorac Vasc Anesth* 2017. PMID 27694572 — TAPVC physiology; obstructed = PGE1-unresponsive emergency.
37. Vanderlaan RD, et al. *Semin Thorac Cardiovasc Surg Pediatr Card Surg Annu* 2018. PMID 29425529 — surgical approaches to TAPVC.
38. Campbell MJ, et al. *J Am Soc Echocardiogr* 2022. PMID 35863543 — fetal Doppler predicts severe postnatal obstruction.
39. White BR, et al. *Ann Thorac Surg* 2019. PMID 30885849 — risk factors for postoperative pulmonary venous obstruction.
40. Bravo-Valenzuela NJM, et al. *J Clin Ultrasound* 2021. PMID 33398887 — prenatal diagnosis of TAPVC.
41. Rychik J, et al. *Circulation* 2019. PMID 31256636 — AHA Fontan scientific statement (single-ventricle context).
26. Vlahos AP, et al. *Circulation* 2004. PMID 15136496 — HLHS with intact/restrictive atrial septum; emergent septostomy.
27. Generali T, et al. *World J Pediatr Congenit Heart Surg* 2022. PMID 35446214 — HLHS restrictive/intact septum; left-atrial decompression.
42. Mustafa HJ, et al. *Prenat Diagn* 2023. PMID 37596875 — fetal cardiac intervention in HLHS with restrictive septum (meta-analysis).
43. Arai S, et al. *Asian Cardiovasc Thorac Ann* 2015. PMID 26405018 — surgical outcome of HLHS with intact atrial septum.
44. Sukhavasi A, et al. *J Thorac Cardiovasc Surg* 2022. PMID 35414413 — PA-IVS strategies / long-term outcomes.
45. LaPar DJ, et al. *Semin Thorac Cardiovasc Surg Pediatr Card Surg Annu* 2019. PMID 31027561 — PA-IVS with borderline tricuspid valve.
46. Cheung EW, et al. *Ann Thorac Surg* 2023. PMID 36070807 — PA-IVS neonatal procedural outcomes (19-center study).

*Bibliographic data retrieved from PubMed; DOI links available per article.*

```

### FILE: explain-engine/docs/fetal_circulation.md

````markdown
# Fetal circulation scenarios

> **Scenarios removed (2026-10-25).** `fetus_25wk`, `fetus_30wk` and `fetus_term` were removed during the re-validation, to be rebuilt from scratch once term_neonate_72h is final. This page is kept as the design record (fetal invariants, operating points, what each lever did); the files and links it names are gone.

**Current scenarios (2026-10-19/20)**, all rebuilt from the literature-validated `term_neonate_72h` by
`node scripts/_make_fetus_validated.mjs --profile 25|30|40` (levers in `scripts/_fetal_profiles.mjs`):
- `fetus_25wk`, 25 wk, 0.7 kg (as preterm_25wk), validated against
  Fetus25wkReference (50 of 51). Size/maturity levers from preterm_25wk corrected by the
  fetus-30 / preterm-30 ratios; the heart needed less diastolic stiffness (`HEART_EL_MIN` 2.5) to keep MAP at the
  baroreflex set-point (systemic resistance was a weak lever: the placenta takes the flow). Operating point: HR 148,
  MAP 34, CVP 2.2, output ~440, RV:LV 58:42, UV 92 > IVC 80 > AA 72 > UA 68 %, umbilical flow 148, core 37.5.
- `fetus_30wk`, 30 wk, 1.5 kg, validated against
  Fetus30wkReference (49 of 51 graded rows in range); see
  [The rebuilt fetus_30wk](#the-rebuilt-fetus_30wk-2026-10-19) below;
- `fetus_term`, 40 wk, 3.545 kg (as term_neonate_72h), validated against
  TermFetusReference (50 of 51). What differs from 30 wk: placental O₂ diffusion 10× lower
  (`dif_o2` 0.003: at term the umbilical vein stays ~30 % short of the maternal side), no RV boost
  (`cont_factor_right` 1.0, `cont_factor_left` 1.15), PVR ×0.8 on the fetal ×9.5, umbilical flow ~142 mL/kg/min.
  Operating point: HR 142, MAP 48, CVP 3.3, output ~430, RV:LV 59:41, UV 80 > IVC 68 > AA 61 > UA 57 %, core 37.5.

The sections after that describe the **earlier pair**, now in `model_definitions/archive/` and replaced by these (built from the old
term base):

| Scenario | GA | Weight | Built by |
|---|---|---|---|
| `archive/term_fetus` | 40 wk | 3.545 kg | `scripts/_make_term_fetus.mjs` (single-point transform of `term_neonate_72h`) |
| `archive/fetus_30wk` | 30 wk | 1.35 kg | `scripts/_make_fetus.mjs 30` (per-GA transform of `term_fetus`) |

In that pipeline `term_fetus` was the anchor: it carried the fetal topology and its own fetal diagram, and
every other gestational age was derived from it by `_make_fetus.mjs`.

## The rebuilt fetus_30wk (2026-10-19)

**Route.** Live `term_neonate_72h` → weight scaling to 1.5 kg (the placenta scaled by hand: it is outside every
scaler group) → the fetal transform of `_make_term_fetus.mjs` re-done on the live model (placenta running,
cord patent, duct and foramen wide open, intrapulmonary shunts closed, fetal PVR, inert lungs, HbF, split
right atrium, amniotic environment) → the 30-week profile (the `preterm_30wk` maturity levers as starting
points) → reseeded with the preterm renal reference (`reseed_preterm.mjs --file`) → the fetal invariants
re-asserted on the baked file. The fetal diagram is taken from the archived `fetus_30wk`.

**Operating point** (`probe_term_reference.mjs`, which reads the fetal variables when the placenta runs):

| | `fetus_30wk` | reference |
|---|---|---|
| HR / MAP / CVP | 148 / 37.6 / 4.5 | 145 / 38 (ovine) / 3 |
| PA − Ao | ~0.8 mmHg | ≈ 0 |
| combined output | ~420 mL/kg/min | 420 |
| RV : LV | 59 : 41 | 59 : 41 |
| lungs / foramen / duct / placenta | ~17 / 24 / 41 / 33 % | 20 / 21 / 39 / 28 (Kiserud ~32) |
| umbilical flow | ~140 mL/kg/min | 120 (MRI 129) |
| O₂ UV / IVC / AA / DAo=UA / SVC | 89 / ~76 / ~70 / ~65 / ~54 % | 85 / 72 / 67 / 64 / 43 |
| UV gas pO₂ / pCO₂ / pH | 41 / 36 / 7.40 | 40 / 36 / 7.40 |
| UA pCO₂ / pH, UA − UV pCO₂ | ~45 / 7.32, ~8 | 41 / 7.37, 5 |
| VO₂ (umbilical Fick) | ~6.0 mL/kg/min | 6.0 (human 5.4–8.1) |
| core temperature | 37.50 °C | 37.5 |

**What the rebuild changed against the archived pipeline:**
- **Preferential streaming.** With the right atrium split, IVC and SVC blood still mixed in the left atrium,
  because the foramen is two resistors (`LA_RAIVCI`, `LA_RASVC`). The new `Shunts.fo_svc_fraction` (0–1,
  default 0.5) sets the share of the foramen's area that opens onto the SVC part; the fetus uses 0, so only IVC
  blood crosses (AA − PA saturation gap 0.9 → ~5–6 points).
- **Ventricular dominance by filling, not by contractility.** After weight scaling the RV was as stiff as the LV;
  `cont_factor_right` 1.2 → 1.8 moved the RV share only 52.5 → 54.8 %. A more compliant RV (`RV_EL_MIN` 0.8 on
  its diastolic elastance) gave 59 : 41 with the foramen and duct shares following.
- **The oxygen balance is an umbilical Fick problem.** The cordocentesis saturations (UV 85 / UA 64) only fit
  VO₂ and umbilical flow together: VO₂ 6.0 with ~130–140 mL/kg/min of umbilical blood (placental resistances
  ×0.75). The maternal pool is set to placental-venous blood at 30 wk (`mat_to2` 5.6, `mat_tco2` 21.5:
  pCO₂ ~35), and the umbilical vein equilibrates with it.
- **The fetal brain uses more than half of the O₂** (`Metabolism` `BR_CAP` share 0.65; Sun 2015: 58 %), so SVC
  blood returns at ~54 % instead of ~57 %.
- **Thermal bookkeeping.** `Blood.get_thermal_state` now leaves out fixed-composition compartments: the
  maternal pool (pinned at 37.0 °C) had acted as a ~4 W phantom heat sink.

**Known limitations:** no ductus venosus / liver route (IVC blood is mixed before the atrium); no placental heat
path (heat leaves through the amniotic "skin" path, `Thermoregulation.h_convective` 240); fetal urine is the
preterm kidney's ~3 mL/kg/h (reference ~13); arterial pressure and RQ are ovine. `scripts/probe_fetus.mjs`
currently fails to start (it imports `BloodComposition.js` before the extensionless-import hook is
registered); `probe_term_reference.mjs` covers its panel.

## What makes a scenario "fetal"

Six properties. They are asserted by `_make_fetus.mjs` and re-asserted by `reseed_fetus.mjs` after
warm-up, because each one silently destroys the fetal circulation while the model still builds and
still prints a plausible-looking panel:

| Invariant | Why |
|---|---|
| `Placenta.placenta_running === true` | the placenta is the gas-exchange organ |
| `Placenta.umb_clamped === false` | the cord is patent |
| `Shunts.ips_res >= 1e7` | intrapulmonary shunts closed — fetal lung flow is all capillary; an open IPS adds a parallel low-resistance path that inflates pulmonary flow |
| `Pda.diameter_relative === 1.0` | the duct is fully relaxed in utero |
| `Breathing.is_enabled === false` | no ventilatory drive |
| `GASEX_LL/RL.dif_o2 === dif_co2 === 0` | the fluid-filled lung exchanges no gas. Zeroing the *constants* is what makes this stick — clearing a `BloodDiffusor`'s `is_enabled` does not survive the build |

`selectProfile`'s `isFetal()` predicate (`scripts/_probe.mjs`) sniffs the first two, which is
unambiguous across the shipped library: every neonatal and adult scenario has
`placenta_running = false, umb_clamped = true`.

## Why gestational age costs a calibration pass

**Nothing in the engine reads `model.gestational_age`.** It is metadata, consumed only by probe
range tables and the chat context string. (`Uterus`/`MaternalPlacenta` have a `preg_ga`, but that is
the *maternal* pregnancy clock and is deliberately distinct.)

**`ModelScaler.scale_to_weight()` scales volumes only** — every elastance and resistance
inverse-allometry line in it is commented out. Worse, it cannot see the placenta at all: no `PL_*`
compartment appears in any scenario's `scaler_config`.

So scaling a fetus to a new gestation is not one call. It is a hand-fitted row of levers that
compensates for what volume scaling leaves behind, which is what
[`scripts/_ga_tables.mjs`](../scripts/_ga_tables.mjs) holds. The table is the documentation for each
column; the values are **starting points refined by probe iteration**, the same status as
`_make_preterm.mjs`'s `PRETERM` table.

The three traps that cost the most time, in order:

1. **The un-scaled placenta.** Forget it and you get a 1.35 kg fetus carrying a term placenta's
   blood: 164 mL/kg fetoplacental volume instead of ~122, with the placenta holding 52% of fetal
   blood instead of 35%. The model builds and runs and looks plausible.
2. **The placenta is a large parallel low-resistance path**, so systemic resistance is a weak MAP
   lever on its own — raising SVR mostly diverts flow into the umbilical circuit (placental share
   climbs past 55%). The umbilical/fetoplacental resistances must rise with it.
3. **Absolute anatomic millimetres.** `Pda.diameter_ao_max`/`diameter_pa_max`/`length` and
   `Shunts.diameter_fo`/`atrial_septal_width` are millimetres no scaler touches.
   `Pda.diameter_relative` is a `[0..1]` *patency fraction*, not a size — conflating the two is the
   easy bug. The duct is anchored to the Szpinda regressions quoted in `Pda.js`.

## Operating points

Measured with `node scripts/probe_fetus.mjs <scenario>`, not copied from a script header.

| | `fetus_term` (40 wk) | `fetus_30wk` | human reference |
|---|---|---|---|
| HR | 146.5 bpm | 147.8 | — |
| ABP sys/dia/**map** | 67.2 / 44.0 / **55.7** | 44.6 / 32.0 / **38.3** | — |
| PAP mean | 56.9 | 39.1 | — |
| **PA − Ao** | **1.2 mmHg** | **0.8** | ≈ 0 (wide-open duct) |
| CVP | 3.8 | 2.5 | — |
| CVO | 1.341 L/min = **378 mL/kg/min** | 0.508 L/min = **376** | ~400–450 |
| **RV : LV** | **55 : 45** | **55 : 45** | ~55 : 45 (MRI) |
| RV / LV ejection fraction | 57% / 55% | ~45% / ~41% | — |
| placental share of CVO | 41% | 41% | ~30 (MRI) / ~45 (ovine) |
| **pulmonary share** | **15%** | **12%** | 11–25% |
| ductus arteriosus | 41% | 44% | 30–46% |
| foramen ovale | 30% | 33% | 27–34% |
| O₂ gradient UV / IVC / AA / AD / UA | 88 / 71 / 66 / 61 / 61 % | 89 / 70 / 65 / 59 / 59 % | — |
| umbilical-artery gas | pH 7.27, pCO₂ 50, BE −5 | pH 7.27, pCO₂ 50, BE −5 | pH ~7.35 |

Pulmonary share is deliberately **lower at 30 wk than at term**: this table follows the human MRI
reading in which pulmonary blood flow rises toward term. The Doppler literature instead has it
peaking near 30 wk, which would invert that ordering — see the `pvr` note in `_ga_tables.mjs`.

**PA ≈ Ao is a fetal invariant, and it is what the ventricular split hangs on.** With a wide-open
duct the pulmonary artery and aorta are one chamber hydraulically, so their mean pressures must
match. They previously did not (PA 62.6 vs Ao 50.1, a 12.5 mmHg gap) — see below.

The **oxygenation ordering UV > IVC > AA > AD** is the primary pass/fail: it is what streaming
through the foramen ovale and ductus venosus produces, and it collapses first when a fetal scenario
is wrong. `AD == UA` is expected — it is the same blood.

Note the shunt flows print **negative** in `probe_fetus.mjs`: `Pda.flow_pa` and `Shunts.flow_fo` are
positive for left→right, so the fetal direction (PA→Ao, R→L) is negative. A negative percentage
there is correct, not an error.

## Ventricular dominance — what actually sets it

The fetus must be RV-dominant. Both scenarios used to come out LV-dominant (48:52 and 46:54); they
now run 55:45. The diagnosis is worth recording because two of the three obvious levers do nothing.

**The split is an identity, not a free parameter:**

```
LV output = foramen flow + pulmonary venous return
```

This holds exactly at every operating point measured. So the whole question is how much crosses the
foramen — and the right atrium divides its blood between the tricuspid valve and the foramen
according to which ventricle ejects better, *not* according to the foramen's size.

**What does not work:**

- **Foramen diameter.** `res_fo` (4.24 mmHg·s/L at 6 mm) is ~13× *lower* than the tricuspid valve's
  55, so the foramen is a hole, not a resistance — the two ventricles effectively draw from a common
  atrial pressure. Measured: 6.0 → 4.4 → 3.0 mm gives 48:52 at every value. It only bites below
  2 mm and then swings violently (1 mm → 73:27). A steep unstable band is a bad calibration knob.
- **`fo_lr_factor`.** No effect on the split.
- **RV unstressed volume, on its own.** Cutting it to the LV's value raises RV ejection fraction
  25 → 34% but leaves the split at 46:54: it makes the RV both stronger *and* more compliant, so the
  right atrium still decompresses across the foramen. It is an EF knob, not a split knob.
- **The foramen's second path (`LA_RASVC`).** Carries ~1%; disabling it changes nothing. (It is still
  anatomically wrong — superior-vena-cava blood does not cross the foramen in life.)

**What does work — and why it was a bug, not a tuning gap:**

1. **The ductus arteriosus was too narrow, and it is an RV-only afterload.** Duct resistance carries
   a Bernoulli orifice term scaling as 1/area² (`Pda.js:200-210`), so a narrow duct is expensive.
   At the previously shipped 3.0 mm it cost a **12.5 mmHg PA-over-Ao gradient that only the right
   ventricle pays** — which is why the RV under-ejected and the atrial blood went left. Three things
   independently said 3.0 mm was wrong: it breaks the PA ≈ Ao invariant the probe itself checks for;
   it contradicts the Szpinda regression quoted in `Pda.js:25` (3.95 mm at 40 wk); and the
   duct-dependent lesions `hlhs` and `pa_vsd` had already overridden it to 4.0 because 3.0 cannot
   carry systemic output. Measured on `term_fetus`: 3.0 mm → 12.5 mmHg / 48:52; 3.95 → 5.0 / 50:50;
   6.0 → 1.0 / 51:49; 8.0 → −0.1 / 52:48.
2. **`Heart.cont_factor_right` supplies the remainder** (1.30 at term, 1.16 at 30 wk). Monotone and
   well-behaved, and it also pulls the foramen share down toward the human 27–34%.
   It is *mostly* independent of PVR but not entirely: at a fixed duct the split held 55:45 across
   PVR ×21 → ×9.5, yet raising the 30 wk `pvr` from 1.35 to 2.30 cost a point (55:45 → 54:46) and
   needed `cont_right` 1.11 → 1.16 to recover. Re-check the split after any PVR change.
3. **`RV.u_vol` restores a physiological ejection fraction** (33 → 57% at term). Independent of the
   split, so it is set once and left alone.

**The residual compensation.** Points 2 and 3 are still compensation for a chamber parameterisation
the fetal transform inherits from `term_neonate_72h` unexamined: the RV ships with an unstressed volume
5.46× the LV's (4.00 vs 0.73 mL) and a *lower* `el_max` (22200 vs 27200) — correct for a neonate,
wrong for a fetus. The real repair is those chamber values, which is out of scope here because it
ripples into ~30 neonatal scenarios. The PDA family already works around the same weakness with
`cont_factor_right` between 1.52 and 5.2.

> Note the shipped `term_fetus` had drifted from its own generator header, which claimed RV:LV
> 51:49. The split appears to have crossed from RV- to LV-dominant across the new-PDA-model /
> bidirectional-shunts / HbF commits, and was never re-measured — commit `1689814` lists five
> quantities as unchanged and omits this one. **Re-measure with `probe_fetus.mjs`; do not trust a
> header.**

## Known limitations

These are inherited by every fetal scenario and are worth stating before the numbers are used for
teaching:

- **The umbilical arteriovenous CO₂ gradient is too wide.** UV pCO₂ 31 vs UA pCO₂ 50 is a 19 mmHg
  gradient where the literature is 8–10, and UA pH 7.27 is a post-labour value rather than an
  undisturbed in-utero one (cordocentesis: UA ≈ 7.35, UV ≈ 7.38). The lever is `Placenta.mat_tco2`.
- **Placental share runs sheep-like** (~41% against human MRI estimates of ~30%; the ovine figure is
  ~45%). Pulmonary, ductal and foramen shares are now all inside their human ranges, so the
  placental share is the remaining outlier. Judge a new gestation by its *delta from term* as well
  as by the absolute number.
- **CVO per kg is still nearly flat across gestation** (376 at 30 wk vs 378 at term) where human MRI
  data have it *falling* with GA, i.e. the 30 wk fetus should run clearly higher per kg. Both rose
  from ~314 once the duct and PVR were corrected, so the gap to the ~400–450 mL/kg/min literature
  figure is now small, but the gestational *trend* is still not reproduced.
- **The umbilical arteriovenous CO₂ gradient is unchanged by this work** and remains the largest
  outstanding discrepancy (see above).
- The **`Brain` compartment is now present** in both fetal scenarios. It had been missing: the
  committed `term_fetus` predated `Brain` being added to `term_neonate_72h`, and regenerating picked it
  up. Cerebral autoregulation is enabled, but its setpoints are the neonatal ones and have not been
  re-fitted for fetal pressures — treat brain-sparing behaviour as unvalidated.

## Workflow

```bash
node scripts/_make_fetus_validated.mjs --profile 30                  # term_neonate_72h -> fetus_30wk (fetal transform, baked)
node scripts/probe_term_reference.mjs fetus_30wk --ref scripts/reference/fetus_30wk.json   # vs Fetus30wkReference
```

Adding a gestation is a profile in `scripts/_fetal_profiles.mjs` plus a reference set
(`docs/Fetus<ga>wkReference.md`, `scripts/reference/fetus_<ga>wk.json`). The older
`_make_fetus.mjs`/`reseed_fetus.mjs` loop (from the archived `term_fetus`) is in `scripts/archive/`.

`scripts/build_patient.mjs` also understands fetal baselines — it auto-detects one, seeds from the
same `FETAL` table, skips the neonatal RDS/PDA levers, and drives pO₂/pCO₂ from
`Placenta.mat_to2`/`mat_tco2` instead of the (inert) alveolar diffusors and ventilatory drive.

> **Probes exit 0 on bad physiology.** Only a build failure exits 1. The fetal-invariant assertions
> in `_make_fetus.mjs` and `reseed_fetus.mjs` are the only real gates; everything else is a table
> you read.

````


## 4. Engine source

### FILE: explain-engine/CustomModelIndex.js

```javascript
// STUDENT EXTENSION POINT — this is where your own model classes get registered.
//
// Add one export line per custom model, exactly like ModelIndex.js does:
//
//   export { MyModel } from "./custom_models/MyModel";
//
// Everything exported here is merged into the engine's model registry on top of the
// built-in models from ModelIndex.js, so a custom model_type becomes usable in a
// model definition without touching any shared file. See custom_models/README.md.
//
// This file is intentionally EMPTY on main — add lines only on your own branch.
// Keeping main empty is what makes rebasing your branch onto main conflict-free.
export {};

```

### FILE: explain-engine/Model.js

```javascript
import ModelEmitter from "./ModelEmitter";
import { RT_MSG } from "./helpers/RealtimeChannels.js";
import { SCENARIO_ALIASES } from "./helpers/ScenarioAliases.js";

/**
 * Model manages lifecycle, messaging, and state synchronization between the UI
 * layer and the ModelEngine worker. It wraps all wire protocols (GET/POST/PUT/DELETE)
 * exposed by the engine and re-emits results via the ModelEmitter pub/sub system.
 * Components subscribe with explain.on(event, handler) / explain.off(event, handler).
 */
export default class Model extends ModelEmitter {
  // declare an object holding the worker thread which does the heavy llifting
  modelEngine = {};

  // declare an object holding the model definition as loaded from the server
  modelDefinition = {};

  // declare an object holding the model data
  modelData = {};
  modelDataSlow = {};

  // declare an object holding the model state
  modelState = {};

  // declare an object holding a saved model state
  savedState = {}

  // declare object holding the generated messages
  info_message = "";
  error_message = "";
  statusMessage = "";
  script_message = "";

  // declare a message log
  message_log = [];
  no_logs = 25;


  /**
   * Spin up the ModelEngine worker and attach message listeners immediately so
   * no early responses are missed.
   */
  constructor() {
    super();
    // spin up a new model engine worker thread
    this.modelEngine = new Worker(new URL("./ModelEngine.js", import.meta.url), { type: "module" });

    // catch unhandled worker errors (syntax errors, import failures, etc.)
    this.modelEngine.onerror = (event) => {
      const message = event.message || "Unknown worker error";
      console.error("Model worker error:", message, event);
      this.error_message = message;
      this.emit("error", { message, error: message, stack: null });
    };

    // set up a listener for messages from the model engine
    this.receive();
  }

  /**
   * Fetch a JSON model definition by name and push it into the engine once retrieved.
   * @param {string} definition_name File stem inside /model_definitions.
   */
  load(definition_name) {
    // a renamed scenario still loads under its old name (saved links, lessons, snapshots)
    const renamed = SCENARIO_ALIASES[definition_name];
    if (renamed) {
      console.log(`Model: '${definition_name}' was renamed '${renamed}'; loading that.`);
      definition_name = renamed;
    }
    console.log(`Model: Loading modeling definition: '${definition_name}'.`)
    const url = "/model_definitions/" + definition_name + ".json";

    fetch(url)
      .then((response) => {
        if (!response.ok) {
          throw new Error(
            "Uh oh! could not get the baseline_neonate from the server!"
          );
        }
        return response.json();
      })
      .then((jsonData) => {
        // store the full file data for the state store to pick up
        this.loadedFileData = jsonData;
        // unwrap model_definition if the file has that wrapper
        const definition = jsonData.model_definition || jsonData;
        // forward the diagram/animation definitions into the engine so the
        // worker-side AnimationPacker can build the sprite data contract.
        if (jsonData.diagram_definition && definition.diagram_definition === undefined) {
          definition.diagram_definition = jsonData.diagram_definition;
        }
        if (jsonData.animation_definition && definition.animation_definition === undefined) {
          definition.animation_definition = jsonData.animation_definition;
        }
        this.build(definition);
      })
      .catch((error) => {
        console.error("Error: ", error);
      });
  }

  /**
   * Proxy helper that posts raw messages to the worker if available.
   * @param {Object} message Envelope containing type/message/payload.
   */
  send(message) {
    if (this.modelEngine) {
      this.modelEngine.postMessage(message);
    }
  }

  /**
   * Attach the onmessage handler that translates engine responses into
   * local state mutations and emitter callbacks.
   */
  receive() {
    // set up a listener for messages from the model engine
    this.modelEngine.onmessage = (e) => {
      switch (e.data.type) {
        case "state":
          this.modelState = e.data.payload;
          this.emit("state");
          break;
        case "status":
          this.statusMessage = e.data.message;
          this.emit("status");
          break;
        case "model_ready":
          this.emit("model_ready", e.data.payload);
          break;
        case "rt_start":
          this.emit("rt_start");
          break;
        case "rt_stop":
          this.emit("rt_stop");
          break;
        case "data":
          this.modelData = e.data.payload;
          this.emit("data");
          break;
        case "data_slow":
          this.modelDataSlow = e.data.payload;
          this.emit("data_slow");
          break;
        case "rtf":
          this.modelData = e.data.payload;
          this.emit("rtf");
          break;
        case "rt_perf":
          // realtime factor of the worker loop (simulated / wall time over ~1 s; < 1 = falling behind)
          this.realtime_factor = e.data.payload;
          this.emit("rt_perf", e.data.payload);
          break;
        case "rts":
          this.modelDataSlow = e.data.payload;
          this.emit("rts");
          break;
        case "prop_value":
          this.emit("prop_value", e.data.payload);
          break;
        case "model_props":
          this.emit("model_props", e.data.payload);
          break;
        case "model_types":
          this.emit("model_types", e.data.payload);
          break;
        case "state_saved":
          this.savedState = this._processModelState({...e.data.payload});
          this.emit("state_saved");
          break;
        case "tuned":
          // live-tune finished; payload = { converged, residuals, iters }
          this.tuneResult = { ...e.data.payload, message: e.data.message };
          this.emit("tuned", this.tuneResult);
          break;
        case "error":
          this.error_message = e.data.message;
          console.error("Model engine error:", e.data.message, e.data.payload);
          this.emit("error", { message: e.data.message, ...e.data.payload });
          break;
        case RT_MSG.CHANNELS:
        case RT_MSG.CHART:
        case RT_MSG.ANIM:
          // realtime data plane — consumed by RealtimeBus, ignored here
          break;
        default:
          console.log("Unknown message type received from model engine");
          console.log(e.data);
          break;
      }
    };
  }

  // API CALLS
  /**
   * Inject a new explain definition into the engine.
   * @param {Object} explain_definition Parsed JSON definition.
   */
  build(explain_definition) {
    console.log("Model: Injecting the model definition into the ModelEngine.")
    this.modelDefinition = { ...explain_definition };
    this.send({
      type: "POST",
      message: "build",
      payload: JSON.stringify(explain_definition),
    });
  }

  /**
   * Re-bind the sprite diagram's animation to an edited diagram definition
   * WITHOUT rebuilding the model — the running simulation (model objects,
   * volumes, time) is preserved. Pass the diagram_definition object (the
   * `{ settings, components }` shape). The worker rebuilds its AnimationPacker
   * and re-posts the realtime channel registry so renderers rebind live.
   * @param {Object} diagram_definition
   */
  updateDiagram(diagram_definition) {
    this.send({
      type: "PUT",
      message: "diagram_definition",
      payload: JSON.stringify(diagram_definition),
    });
  }

  /**
   * Rebuild the engine using the last loaded definition snapshot.
   */
  restart() {
    this.send({
      type: "POST",
      message: "build",
      payload: JSON.stringify(this.modelDefinition),
    });
  }

  /**
   * Request an offline calculation run for a fixed number of seconds.
   * @param {number} time_to_calculate Simulation horizon in seconds.
   */
  calculate(time_to_calculate) {
    this.send({
      type: "POST",
      message: "calc",
      payload: parseInt(time_to_calculate),
    });
  }

  /**
   * Start the realtime loop inside the model engine.
   */
  start() {
    this.send({
      type: "POST",
      message: "start",
      payload: [],
    });
  }

  /**
   * Halt the realtime loop without clearing state.
   */
  stop() {
    this.send({
      type: "POST",
      message: "stop",
      payload: [],
    });
  }

  /**
   * Terminate the underlying worker and detach listeners to avoid leaks when
   * the owning component unmounts or hot reloads.
   */
  dispose() {
    if (this.modelEngine) {
      this.modelEngine.onmessage = null;
      this.modelEngine.terminate();
      this.modelEngine = null;
    }
  }

  /**
   * Remove every fast-sample watch entry.
   */
  clearWatchList() {
    this.send({
      type: "DELETE",
      message: "watchlist",
      payload: [],
    });
  }

  /**
   * Remove every slow-sample watch entry.
   */
  clearWatchListSlow() {
    this.send({
      type: "DELETE",
      message: "watchlist_slow",
      payload: [],
    });
  }

  /**
   * Subscribe to realtime values for given properties (model.prop1.prop2 strings).
   * @param {string|string[]} args Property path or array of paths.
   */
  watchModelProps(args) {
    // args is an array of strings with format model.prop1.prop2
    if (typeof args === "string") {
      args = [args];
    }
    this.send({
      type: "POST",
      message: "watch",
      payload: args,
    });
  }

  /**
   * Subscribe to slow-sampled values for given properties.
   * @param {string|string[]} args Property path or array of paths.
   */
  watchModelPropsSlow(args) {
    // args is an array of strings with format model.prop1.prop2
    if (typeof args === "string") {
      args = [args];
    }
    this.send({
      type: "POST",
      message: "watch_slow",
      payload: args,
    });
  }

  /**
   * Pull the latest fast-sampled model data snapshot.
   */
  getModelData() {
    this.send({
      type: "GET",
      message: "data",
      payload: [],
    });
  }

  /**
   * Pull the latest slow-sampled model data snapshot.
   */
  getModelDataSlow() {
    this.send({
      type: "GET",
      message: "data_slow",
      payload: [],
    });
  }

  /**
   * Update the fast sampler interval inside the engine.
   * @param {number} new_interval Interval in seconds.
   */
  setSampleInterval(new_interval) {
    this.send({
      type: "PUT",
      message: "sample_interval",
      payload: new_interval,
    });
  }

  /**
   * Update the slow sampler interval inside the engine.
   * @param {number} new_interval Interval in seconds.
   */
  setSampleIntervalSlow(new_interval) {
    this.send({
      type: "PUT",
      message: "sample_interval_slow",
      payload: new_interval,
    });
  }

  /**
   * Request the entire serialized engine state.
   */
  getModelState() {
    this.send({
      type: "GET",
      message: "state",
      payload: [],
    });
  }

  /**
   * Ask the engine to persist the current state as a saved snapshot.
   */
  saveModelState() {
    this.send({
      type: "POST",
      message: "save",
      payload: [],
    });
  }

  /**
   * Retrieve metadata about a specific model instance.
   * @param {string} model_name Name of the model instance in state.
   */
  getModelProps(model_name) {
    // get the properties of a specific model
    this.send({
      type: "GET",
      message: "model_props",
      payload: model_name,
    });
  }

  /**
   * Request the catalog of model types supported by the engine.
   */
  getModelTypes() {
    // get all the model types
    this.send({
      type: "GET",
      message: "model_types",
      payload: {},
    });
  }

  /**
   * Fetch a blood composition report for the given model instance.
   * @param {string} model_name Instance key inside modelState.
   */
  getBloodComposition(model_name) {
    // get the interface of a specific model
    this.send({
      type: "GET",
      message: "blood_composition",
      payload: model_name,
    });
  }


  /**
   * Create a brand-new model instance via the engine API.
   * @param {Object} model_args Arguments required by the engine to instantiate.
   */
  addNewModel(model_args) {
    // get the interface of a specific model
    this.send({
      type: "POST",
      message: "add",
      payload: model_args,
    });
  }

  /**
   * Remove a model instance from the engine.
   * @param {string} model_name Instance key inside modelState.
   */
  deleteModel(model_name) {
    // get the interface of a specific model
    this.send({
      type: "DELETE",
      message: "remove",
      payload: model_name,
    });
  }

  /**
   * Query the current value for a dot-delimited property path.
   * @param {string} property model.prop1.prop2 path.
   */
  getPropValue(property) {
    // get the value of a specific property with string format model.prop1.prop2
    this.send({
      type: "GET",
      message: "property_value",
      payload: property,
    });
  }

  /**
   * Schedule a property change with optional tweening parameters.
   * @param {string} prop model.prop1.prop2 path.
   * @param {number|string|boolean} new_value Target value.
   * @param {number} it Interpolation time in seconds (>= 0).
   * @param {number} at Delay before starting the interpolation.
   */
  setPropValue(prop, new_value, it = 1, at = 0) {
    // make sure the it is not zero
    if (it < 0) {
      it = 0;
    }
    let result = prop.split(".");
    let model = result[0];
    let prop1 = result[1];
    let prop2 = null;
    if (result.length > 2) {
      prop2 = result[2];
    }
    // set the property of a model with format {prop: model.prop1.prop2, v: value, at: time, it: time, type: task_type}
    this.send({
      type: "PUT",
      message: "property_value",
      payload: JSON.stringify({
        model: model,
        prop1: prop1,
        prop2: prop2,
        t: new_value,
        it: it,
        at: at,
        type: typeof new_value,
      }),
    });
  }

  /**
   * Ask the engine to execute a method on a model after an optional delay.
   * @param {string} model_function Dot path Model.method.
   * @param {Array} args Arguments to forward to the method.
   * @param {number} at Delay before invocation in seconds.
   */
  callModelFunction(model_function, args, at = 0) {
    this.send({
      type: "POST",
      message: "call",
      payload: JSON.stringify({
        func: model_function,
        args: args,
        it: 0,
        at: at,
        type: "function",
      }),
    });
  }

  /**
   * Scale a specific parameter group by a factor.
   * @param {string} group One of: "volumes", "unstressed_volumes", "elastances", "resistances", "reset"
   * @param {number} factor Scale factor (1.0 = no change, 0.5 = half, 2.0 = double)
   */
  scaleModel(group, factor = 1.0) {
    this.send({
      type: "POST",
      message: "scale",
      payload: { group, factor },
    });
  }

  /**
   * Live closed-loop tune: drive measured quantities of the RUNNING model toward
   * target values in place (no reload). Emits a "tuned" event with the result
   * ({ converged, residuals, iters }).
   * @param {Object} targets e.g. { co: 0.25, blood_volume: 0.26, map: 45 }
   *   (keys: map, co, hr, po2, spo2, pco2, be, ph, blood_volume)
   * @param {Object} [opts] { tol, settle, warm, maxIters, window }
   */
  tune(targets, opts = {}) {
    this.send({
      type: "POST",
      message: "calibrate",
      payload: JSON.stringify({ targets, opts }),
    });
  }

  /**
   * Remove transient helpers and local-only objects from a model state snapshot
   * so that it can be serialized or displayed cleanly.
   * @param {Object} model_state Raw state object returned by the engine.
   * @returns {Object} Sanitized model_state reference.
   */
  _processModelState(model_state) {
    // transfrom the modelstate object to a serializable object by removing the helper objects
    delete model_state["DataCollector"];
    delete model_state["TaskScheduler"];
    delete model_state["ModelScaler"];
    // diagram_definition / animation_definition are copied onto the live model at build (so the
    // worker AnimationPacker can read them) but they have a top-level home in the scenario file —
    // the save path re-adds them from loadedFileData. Strip them here so they are not baked into
    // model_definition as a stale duplicate that Model.load would then prefer over the top-level
    // copy (an edit to the top-level diagram would otherwise be silently ignored by the engine).
    delete model_state["diagram_definition"];
    delete model_state["animation_definition"];
    // remove the ncc counters
    for (const key in model_state) {
      if (key.startsWith("ncc")) {
        delete model_state[key];
      }
    }
    // iterate over all model and delete the local attributes
    Object.values(model_state.models).forEach((m) => {
      for (const key in m) {
        if (key.startsWith("_")) {
          delete m[key];
        }
        if (key === 'components') {
          if (Object.keys(m[key]).length > 0) {
            // build name array of keys
            let key_names = [] 
            Object.keys(m[key]).forEach(k => {
              key_names.push(k)
            })
            // replace
            key_names.forEach( key_name => {
              m['components'][key_name] = model_state.models[key_name]
              delete model_state.models[key_name]
            })
          }

        }
      }
    });
    return model_state;
  }
}

```

### FILE: explain-engine/ModelEmitter.js

```javascript
/**
 * Minimal pub/sub emitter mixin for Model.
 * Uses Map<string, Set<Function>> for O(1) add/remove.
 * No dependencies, no wildcard support — intentionally minimal.
 */
export default class ModelEmitter {
  _listeners = new Map();

  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(callback);
  }

  off(event, callback) {
    const set = this._listeners.get(event);
    if (set) {
      set.delete(callback);
      if (set.size === 0) {
        this._listeners.delete(event);
      }
    }
  }

  emit(event, ...args) {
    const set = this._listeners.get(event);
    if (set) {
      for (const callback of set) {
        callback(...args);
      }
    }
  }
}

```

### FILE: explain-engine/ModelEngine.js

```javascript
// This is a dedicated web worker instance for the physiological model engine
// Web workers run in a separate thread for performance reasons and have no access to the DOM nor the window object
// The scope is defined by self and communication with the main thread by a message channel
// https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers#web_workers_api

// Communication with the script which spawned the web worker takes place through a communication channel
// Messages are received in the onmessage event and are sent by the _send function

// Explain request object :
/* {
  type:       <string> stating the type of message (REST (PUT/POST/GET/DELETE/PATCH))
  message:    <string> stating the component of the model for which the message is intended (p.e. 'datalogger'/'interventions')
  payload:    <object> containing data to pass to the action
}
*/



// import all models present in the model_index module
import * as models from "./ModelIndex";
// student extension point: custom models, empty on main (see custom_models/README.md)
import * as custom_models from "./CustomModelIndex";
import DataCollector from "./helpers/DataCollector";
import { set_model_registry } from "./helpers/ModelRegistry";
import TaskScheduler from "./helpers/TaskScheduler";
import ModelScaler from "./helpers/ModelScaler";
import { buildLiveControllers, runCalibration, measureWindow, liveWarm } from "./helpers/Calibrator";
import ChannelWriter from "./helpers/ChannelWriter";
import AnimationPacker from "./helpers/AnimationPacker";
import { RT_MSG } from "./helpers/RealtimeChannels";
import { calc_blood_composition } from "./component_models/BloodComposition";

// store all imported models in a list to be able to instantiate them dynamically
let available_models = [];
Object.values(models).forEach((model) => available_models.push(model));
const available_model_map = {};
for (let i = 0; i < available_models.length; i++) {
  const model_class = available_models[i];
  available_model_map[model_class.model_type] = model_class;
}
// custom models are registered last, so a custom class deliberately reusing a built-in
// model_type replaces it everywhere; the warning is there to catch the accidental case
Object.values(custom_models).forEach((model_class) => {
  if (available_model_map[model_class.model_type]) {
    console.warn(`ModelEngine: custom model overrides built-in '${model_class.model_type}'`);
  }
  available_model_map[model_class.model_type] = model_class;
  available_models.push(model_class);
});
const model_types_cached = [...new Set(available_models.map((mt) => mt.model_type))];
// publish the merged map so composite models can instantiate sub-components by model_type
set_model_registry(available_model_map);
const ENABLE_STEP_ERROR_GUARD = true;
// step_model errors per model name since the last build. A model that throws usually throws on
// every step (2000 per simulated second at 0.5 ms), so only the first one per model is reported.
let step_errors = {};

// the models stepped by _model_step, as arrays (model.models is a large, mutated dictionary, so a
// for-in plus keyed lookup on every step is slow). Refreshed at the start of every calculate() call
// and every realtime tick, so models added or removed between calls are picked up; insertion order
// is the for-in order, so the step order is unchanged. Each refresh also bumps a non-enumerable
// version on the model object (not serialized) that tells cached cross-model references (Resistor)
// to re-resolve.
let _model_list = [];
let _model_names = [];
const _refresh_model_list = function () {
  _model_names = Object.keys(model.models);
  _model_list = _model_names.map((n) => model.models[n]);
  if (!Object.prototype.hasOwnProperty.call(model, "_models_version")) {
    Object.defineProperty(model, "_models_version", { value: 0, writable: true, enumerable: false, configurable: true });
  }
  model._models_version += 1;
};

const _get_data_collector = function () {
  return model?.DataCollector || null;
};

const _get_task_scheduler = function () {
  return model?.TaskScheduler || null;
};

const _normalize_payload = function (payload) {
  if (typeof payload === "string") {
    return JSON.parse(payload);
  }
  return payload;
};

// declare a model object holding the current model
let model = {
  models: {},
};

// declare the model initialization flag
let model_initialized = false;

// declare a model data object holding the high resolution model data
let model_data = {};

// declare a model data object holding the low resolution model data
let model_data_slow = {};

// set the realtime updateintervals
let rtInterval = 0.015;
let rtSlowInterval = 1.0;
let rtSlowCounter = 0.0;
let rtClock = null;
// wall-clock pacing of the realtime loop: setInterval ticks are not exact (late timers, a slow tick),
// so each tick runs the steps the wall clock is owed instead of a fixed batch. The debt is capped at
// RT_MAX_CATCHUP nominal batches, so a slow machine runs slower than real time instead of spiralling.
const RT_MAX_CATCHUP = 4;
let rtLastWall = 0.0; // performance.now() of the previous tick (ms)
let rtDebt = 0.0; // simulated time owed to the wall clock (s)
let rtPerfSim = 0.0; // simulated / wall time accumulated for the realtime factor (s)
let rtPerfWall = 0.0;

// realtime typed data-plane (chart ring + anim snapshot)
let channel_writer = null;
let animation_packer = null;
let build_counter = 0;

// set up the endpoints for requests from the main thread
self.onmessage = (e) => {
  try {
    switch (e.data.type) {
      case "GET": // retrieve a resource
        switch (e.data.message) {
          case "state":
            get_model_state();
            break;
          case "data":
            get_model_data();
            break;
          case "data_slow":
            get_model_data_slow();
            break;
          case "property_value":
            get_property(e.data.payload);
            break;
          case "model_props":
            get_model_props(e.data.payload);
            break;
          case "model_types":
              get_model_types(e.data.payload);
              break;
          case "blood_composition":
            get_blood_composition(e.data.payload);
            break;
        }
        break;
      case "PUT": // update a resource
        switch (e.data.message) {
          case "sample_interval":
            _get_data_collector()?.set_sample_interval(e.data.payload);
            break;
          case "sample_interval_slow":
            _get_data_collector()?.set_sample_interval_slow(e.data.payload);
            break;
          case "property_value":
            console.log("ModelEngine: task scheduler request: ", e.data.payload )
            set_property(_normalize_payload(e.data.payload));
            break;
          case "diagram_definition":
            update_diagram(_normalize_payload(e.data.payload));
            break;
        }
        break;
      case "POST": // create a new resource
        switch (e.data.message) {
          case "build":
            console.log("ModelEngine: received new model definition.")
            model_initialized = build(_normalize_payload(e.data.payload));
            break;
          case "start":
            console.log("ModelEngine: realtime model started.")
            start();
            break;
          case "stop":
            console.log("ModelEngine: realtime model stopped.")
            stop()
            break;
          case "calc":
            console.log(`ModelEngine: calculating ${e.data.payload} seconds.`)
            calculate(e.data.payload);
            break;
          case "call":
            console.log("ModelEngine: calling model a specific function", e.data.payload )
            call_function(_normalize_payload(e.data.payload));
            break;
          case "add":
            add_model_to_engine(e.data.payload);
            break;
          case "save":
            save_state();
            break;
          case "scale":
            scale_model(e.data.payload);
            break;
          case "calibrate":
            tune_model(_normalize_payload(e.data.payload));
            break;
          case "watch":
            watch_props(e.data.payload);
            break;
          case "watch_slow":
            watch_props_slow(e.data.payload);
            break;
        }
        break;
      case "DELETE": // remove a resource
        switch (e.data.message) {
          case "remove":
            remove_model_from_engine(e.data.payload)
            break;
          case "watchlist":
            clear_watchlist();
            break;
          case "watchlist_slow":
            clear_watchlist_slow();
            break;
        }
        break;
      default:
        console.log(`ModelEngine: invalid API request ${e.data.type}`)
        break;
    }
  } catch (err) {
    console.error("ModelEngine: unhandled error in message handler:", err);
    _send_error(`Unhandled error processing ${e.data.type} ${e.data.message}: ${err.message}`, err);
  }
};

// post the one-time realtime channel handshake: transport descriptor (+ SAB
// handles in shared mode) plus the chart and anim registries. Re-posted by the
// DataCollector callback whenever the chart layout/version changes.
const _post_rt_channels = function () {
  if (!channel_writer) return;
  postMessage({
    type: RT_MSG.CHANNELS,
    message: "",
    payload: {
      descriptor: channel_writer.descriptor(),
      chart: {
        version: model.DataCollector?.registry_version || 0,
        slots: model.DataCollector?.chart_slots || [],
      },
      anim: animation_packer ? animation_packer.registry() : null,
    },
  });
};

// Re-bind the sprite-diagram animation to an EDITED diagram definition without
// rebuilding the model — the live simulation (model objects, volumes, time)
// is left running. Swaps model.diagram_definition, rebuilds the AnimationPacker
// (component -> slot registry + direct model refs), re-acquires the anim
// snapshot at the new stride/version, and re-posts the rt_channels handshake so
// the main-thread reader and renderers rebind. Returns true on success.
const update_diagram = function (diagram_definition) {
  if (!model) return false;
  if (diagram_definition) model.diagram_definition = diagram_definition;
  if (!channel_writer) return false;
  try {
    build_counter += 1;
    animation_packer = new AnimationPacker(model, build_counter);
    channel_writer.acquireAnimSnapshot(
      animation_packer.stride || 0,
      animation_packer.version
    );
    _post_rt_channels();
    return true;
  } catch (e) {
    console.error("ModelEngine: diagram animation rebind failed:", e);
    return false;
  }
};

// define the model functions
const build = function (model_definition) {
  console.log("ModelEngine: building model from model definition.")
  // set the error counter
  let errors = 0;

  // set model initializer to false
  model_initialized = false;

  // erase all data
  model_data = {};
  model_data_slow = {};

  // stop all timers
  clearInterval(rtClock);

  // re-arm the step error report for the new model
  step_errors = {};

  // clear the current model object
  model = {
    models: {},
    scaler_config: {},
  };

  // initialize the model parameters, except the model components key which needs special processing
  for (const [key, value] of Object.entries(model_definition)) {
    if (key !== "models") {
      // copy model parameter to the model object
      model[key] = value;
    }
  }

  // initialize all sub models
  Object.values(model_definition.models).forEach((sub_model_def) => {
    const model_class = available_model_map[sub_model_def.model_type];

    // if the component model was found then instantiate a model
    if (model_class) {
      try {
        // instantiate the new component and give it a name, pass the model type and a reference to the whole model
        let new_sub_model = new model_class(
          model,
          sub_model_def.name,
          sub_model_def.model_type
        );
        // add the new component to the model object
        model.models[sub_model_def.name] = new_sub_model;
      } catch (e) {
        errors += 1;
        console.error("ModelEngine: model instantiation error: ", sub_model_def.name, e);
        _send({
          type: "status",
          message: "ERROR: failed to instantiate " + sub_model_def.name + " (" + sub_model_def.model_type + ")",
          payload: [],
        });
      }

    } else {
      errors += 1;
      console.log("Model type not found: ", sub_model_def.model_type);
      _send({
        type: "status",
        message: "ERROR: " + sub_model_def.model_type + " model not found",
        payload: [],
      });
    }
  });

  // the models listed in the definition; only these are initialized below; the sub-models are
  // initialized by their owner's init_model
  const top_level_models = Object.values(model.models);

  // pre-create the sub-models that composite models declare in `components` (recursively), so every
  // model exists before any init_model runs. Blood and Gas collect their compartments from
  // model.models in init_model, so without this they missed the compartments of an owner listed
  // after them in the definition. The owner still applies the component args in its own init_model
  // (BaseModelClass only instantiates a name that does not exist yet). Same insertion order as
  // BaseModelClass.init_model (all of a model's components, then each component's own), because the
  // step loop runs the models in insertion order.
  const create_components = function (components) {
    const created = [];
    Object.entries(components || {}).forEach(([component_name, component_def]) => {
      if (!component_def || model.models.hasOwnProperty(component_name)) return;
      const model_class = available_model_map[component_def.model_type];
      if (!model_class) {
        errors += 1;
        console.log("Model type not found: ", component_def.model_type);
        _send({
          type: "status",
          message: "ERROR: " + component_def.model_type + " model not found",
          payload: [],
        });
        return;
      }
      try {
        model.models[component_name] = new model_class(model, component_name, component_def.model_type);
      } catch (e) {
        errors += 1;
        console.error("ModelEngine: model instantiation error: ", component_name, e);
        _send({
          type: "status",
          message: "ERROR: failed to instantiate " + component_name + " (" + component_def.model_type + ")",
          payload: [],
        });
        return;
      }
      created.push(component_def);
    });
    created.forEach((component_def) => create_components(component_def.components));
  };
  Object.values(model_definition.models).forEach((sub_model_def) => create_components(sub_model_def.components));

  // initialize all sub models
  if (errors < 1) {
    // now initialize all the models with the correct properties stored in the model definition
    top_level_models.forEach((model_comp) => {
      // // find the arguments for the model in the model definition
      let args = [];
      for (const [key, value] of Object.entries(model_definition.models[model_comp.name])) {
        args.push({ key, value });
      }
      // set the arguments
      try {
        model_comp.init_model(args);
      } catch (e) {
        console.log("ModelEngine: model initialization error: ", model_comp.name);
        console.log(e);
        errors += 1;
        _send({
          type: "status",
          message:
            "ERROR: " +
            model_comp.name +
            "(" +
            model_comp.model_type +
            ") configuration error.",
          payload: [],
        });
      }
    });

    // add a datacollector instance to the model object
    model["DataCollector"] = new DataCollector(model);

    // add a task scheduler instance to the model object
    model["TaskScheduler"] = new TaskScheduler(model);

    // add a model scaler instance to the model object
    model["ModelScaler"] = new ModelScaler(model, model.scaler_config);

    // freeze the JSON's weight as the allometric baseline; reset() and
    // scale_to_weight() use this so behavior is correct regardless of scenario
    model._baseline_weight = model.weight;

    // wire up the realtime typed data plane (chart ring + anim snapshot).
    // Attaching channels flips the DataCollector to the typed fast path and
    // (re)posts the rt_channels handshake through the registry callback.
    try {
      build_counter += 1;
      channel_writer = new ChannelWriter((m, transfer) =>
        postMessage(m, transfer || [])
      );
      animation_packer = new AnimationPacker(model, build_counter);
      channel_writer.acquireAnimSnapshot(
        animation_packer.stride || 0,
        animation_packer.version
      );
      model.DataCollector.set_channels(channel_writer, _post_rt_channels);
    } catch (e) {
      console.error("ModelEngine: realtime channel setup failed:", e);
      channel_writer = null;
      animation_packer = null;
    }
  }

  if (errors > 0) {
    console.log("ModelEngine: model build failed.")
    _send({
      type: "status",
      message: `ERROR: model build failed"`,
      payload: [],
    });
    return false;
  } else {
    console.log("ModelEngine: model build succesful.")
    _send({
      type: "model_ready",
      message: "",
      payload: [],
    });
    return true;
  }
};

const remove_model_from_engine = function (model_name) {
  try {
    delete model.models[model_name]
    console.log('Removed model from engine: ', model_name)
    _send({
      type: "status",
      message: `Removed submodel from the model. `,
      payload: [],
    });
  } catch {
    console.log('Error in removing model from engine: ', model_name)
    _send({
      type: "status",
      message: `Error removing submodel from model. `,
      payload: [],
    });

  }

}

const add_model_to_engine = function (new_model) {

  // same lookup as build(): the merged map, where a custom model overrides a built-in one
  const base_model = available_model_map[new_model.model_type];
  // make a key value list of the args
  let arg_list = []
  Object.keys(new_model).forEach(arg => {
    let arg_object = { key: arg, value: new_model[arg]}
    arg_list.push(arg_object)
  })
  let new_sub_model = {}
  try {
    new_sub_model = new base_model(model, new_model.name);
    new_sub_model.init_model(arg_list)
    model.models[new_model.name] = new_sub_model
    console.log('Added model to engine: ', new_sub_model)
    _send({
      type: "status",
      message: `Submodel added to the model`,
      payload: [],
    });
  } catch (e) {
    console.error('Failed to add model to engine: ', new_model.name, e)
    _send({
      type: "status",
      message: base_model
        ? `ERROR: failed to add model ${new_model.name}: ${e.message}`
        : `ERROR: failed to add model ${new_model.name}: model type ${new_model.model_type} not found`,
      payload: [],
    });
  }

}

const start = function () {
  // start the model in realtime
  if (model_initialized) {
    // gate typed chart-ring writes to the realtime loop (offline calculate()
    // keeps using the object path)
    if (model.DataCollector) model.DataCollector.rt_active = true;
    // Re-post the channel handshake (chart + anim registries) now. The main-
    // thread RealtimeBus is created lazily after build, so it misses the
    // build-time handshake; re-posting on every start guarantees every renderer
    // (incl. the diagram's anim registry) is configured before frames flow.
    _post_rt_channels();
    // call the modelStep every rt_interval seconds
    clearInterval(rtClock);
    rtLastWall = performance.now();
    rtDebt = rtInterval; // the first tick runs one nominal batch
    rtPerfSim = 0.0;
    rtPerfWall = 0.0;
    rtClock = setInterval(_model_step_rt, rtInterval * 1000.0);
    // send status update
    _send({
      type: "rt_start",
      message: ``,
      payload: [],
    });
    _send({
      type: "status",
      message: `realtime model started`,
      payload: [],
    });
  } else {
    _send({
      type: "status",
      message: `ERROR: model not initialized.`,
      payload: [],
    });
  }
};

const stop = function () {
  // stop the realtime model
  if (model_initialized) {
    if (model.DataCollector) model.DataCollector.rt_active = false;
    clearInterval(rtClock);
    rtClock = null;
    // signal that realtime model stopped
    _send({
      type: "rt_stop",
      message: ``,
      payload: [],
    });
    _send({
      type: "status",
      message: `realtime model stopped`,
      payload: [],
    });
  }
};

const calculate = function (time_to_calculate) {
  // calculate a number of seconds of the model
  if (model_initialized) {
    let noOfSteps = time_to_calculate / model.modeling_stepsize;
    _send({
      type: "status",
      message: `calculating ${time_to_calculate} s (${noOfSteps} steps)`,
      payload: [],
    });
    const start = performance.now();
    _refresh_model_list();
    for (let i = 0; i < noOfSteps; i++) {
      _model_step();
    }
    const end = performance.now();
    const step_time = (end - start) / noOfSteps;

    _send({
      type: "status",
      message: `calculated in ${(end - start).toFixed(0)} ms (${step_time.toFixed(3)} ms/step)`,
      payload: [],
    });
    // get model data
    get_model_data();
    get_model_data_slow();
    get_model_state();
  } else {
    _send({
      type: "status",
      message: `ERROR: model not initialized.`,
      payload: [],
    });
  }

  // clean up the datacollector
  _get_data_collector()?.clean_up();
  _get_data_collector()?.clean_up_slow();
};

// Live closed-loop tune of the running model: drive measured quantities (CO, MAP,
// blood volume, …) to target values IN PLACE using the shared Calibrator. Pauses
// the realtime loop, runs the secant calibration synchronously against the live
// `model` (stepFn advances it), resumes, then emits the new state + a report.
// Levers compose with the patient's baked scaling (no reload, no ModelScaler reset).
const tune_model = function (payload) {
  if (!model_initialized) {
    _send({ type: "status", message: `ERROR: model not initialized.`, payload: [] });
    return;
  }
  const targets = (payload && payload.targets) || {};
  const opts = (payload && payload.opts) || {};

  // advance the model by `seconds` without emitting per-step state
  const stepFn = (seconds) => {
    const n = Math.round(seconds / model.modeling_stepsize);
    _refresh_model_list();
    for (let i = 0; i < n; i++) _model_step();
  };

  // pause the realtime loop during the (synchronous) calibration
  const wasRunning = rtClock != null;
  if (wasRunning) {
    if (model.DataCollector) model.DataCollector.rt_active = false;
    clearInterval(rtClock);
    rtClock = null;
  }

  _send({ type: "status", message: `tuning ${Object.keys(targets).join(", ")}…`, payload: [] });

  let result = { converged: false, residuals: [], iters: 0 };
  try {
    const { controllers, keys } = buildLiveControllers(model, targets, opts.tol || {});
    if (!controllers.length) {
      _send({ type: "tuned", message: "no tunable targets", payload: { converged: false, residuals: [], iters: 0 } });
    } else {
      result = runCalibration(controllers, {
        measureAll: () => measureWindow(model, stepFn, keys, opts.window ?? 10),
        step: stepFn,
        settle: opts.settle ?? 20,
        warm: opts.warm ?? liveWarm(targets),
        maxIters: opts.maxIters ?? 12,
        final: 0,
        log: () => {},
      });
      get_model_data();
      get_model_data_slow();
      get_model_state();
      _send({
        type: "tuned",
        message: result.converged ? "converged" : "incomplete",
        payload: result,
      });
    }
  } catch (err) {
    _send_error(`tune failed: ${err.message}`, err);
  } finally {
    if (wasRunning) start(); // resume realtime from the new operating point
  }
};

const set_property = function (new_prop_value) {
  const err = _get_task_scheduler()?.add_task(new_prop_value);
  if (err) _send_error("set_property", err);
};

const get_property = function (prop) {
  let p = prop.split(".");
  let v = {};
  switch (p.length) {
    case 2:
      v = model.models[p[0]][p[1]];
      break;
    case 3:
      v = model.models[p[0]][p[1]][p[2]];
      break;
  }
  _send({
    type: "prop_value",
    message: "",
    payload: { prop: prop, value: v },
  });
};

const get_model_props = function (model_name) {
  // return the public (non-underscore) properties of one live model instance
  const m = model.models[model_name];
  if (!m) {
    _send({
      type: "status",
      message: `ERROR: model not found (${model_name})`,
      payload: [],
    });
    return;
  }
  // copy onto a fresh object so the live instance is never mutated
  const props = {};
  for (const key in m) {
    if (!key.startsWith("_")) {
      props[key] = m[key];
    }
  }
  _send({
    type: "model_props",
    message: "",
    payload: props,
  });
}

const get_model_types = function () {
  _send({
    type: "model_types",
    message: "",
    payload: model_types_cached,
  });

}

const call_function = function (new_function_call) {
  const err = _get_task_scheduler()?.add_function_call(new_function_call);
  if (err) _send_error("call_function", err);
};

const clear_watchlist = function () {
  _get_data_collector()?.clear_watchlist();
};

const clear_watchlist_slow = function () {
  _get_data_collector()?.clear_watchlist_slow();
};

const watch_props = function (args) {
  const data_collector = _get_data_collector();
  if (!data_collector) {
    return;
  }
  args.forEach((prop) => {
    data_collector.add_to_watchlist(prop);
  });
};

const watch_props_slow = function (args) {
  const data_collector = _get_data_collector();
  if (!data_collector) {
    return;
  }
  args.forEach((prop) => {
    data_collector.add_to_watchlist_slow(prop);
  });
};

const get_model_state = function () {
  // get the current whole model state
  postMessage({
    type: "state",
    message: "",
    payload: model,
  });
};

const get_model_data = function () {
  // get the realtime model data from the datacollector
  model_data = _get_data_collector()?.get_model_data() || [];

  // send data to the ui
  postMessage({
    type: "data",
    message: "",
    payload: model_data,
  });
};

const get_model_data_slow = function () {
  // get the slow update model data from the datacollector
  model_data_slow = _get_data_collector()?.get_model_data_slow() || [];

  // send data to the ui
  postMessage({
    type: "data_slow",
    message: "",
    payload: model_data_slow,
  });
};

const get_blood_composition = function (model_name) {
  console.log("ModelEngine: calculating blood composition.")
  const m = model.models[model_name];
  if (!m) {
    _send({
      type: "status",
      message: `ERROR: blood composition model not found (${model_name})`,
      payload: [],
    });
    return;
  }

  try {
    calc_blood_composition(m);
    _send({
      type: "status",
      message: `blood composition calculated for ${model_name}`,
      payload: [],
    });
  } catch (e) {
    console.log("ModelEngine: blood composition calculation failed.", e);
    _send({
      type: "status",
      message: `ERROR: blood composition calculation failed for ${model_name}`,
      payload: [],
    });
  }
}

const scale_model = function (payload) {
  if (!model_initialized || !model.ModelScaler) {
    _send({
      type: "status",
      message: "ERROR: model not initialized.",
      payload: [],
    });
    return;
  }
  try {
    const { group, factor } = payload;
    console.log(`ModelEngine: scaling ${group} by factor ${factor}`);
    switch (group) {
      // volume scaling (scales actual vol + u_vol_factor_scaling)
      case "blood_volume":
        model.ModelScaler.scale_blood_volume(factor);
        break;
      case "heart_volume":
        model.ModelScaler.scale_heart_volume(factor);
        break;
      case "lung_volume":
        model.ModelScaler.scale_lung_volume(factor);
        break;
      case "thorax_volume":
        model.ModelScaler.scale_thorax_volume(factor);
        break;
      case "pericardium_volume":
        model.ModelScaler.scale_pericardium_volume(factor);
        break;
      // blood
      case "blood_elastances":
        model.ModelScaler.scale_blood_elastances(factor);
        break;
      case "blood_resistances":
        model.ModelScaler.scale_blood_resistances(factor);
        break;
      // pulmonary
      case "pulmonary_elastances":
        model.ModelScaler.scale_pulmonary_elastances(factor);
        break;
      case "pulmonary_resistances":
        model.ModelScaler.scale_pulmonary_resistances(factor);
        break;
      case "pulmonary_u_vol":
        model.ModelScaler.scale_pulmonary_u_vol(factor);
        break;
      // systemic
      case "systemic_elastances":
        model.ModelScaler.scale_systemic_elastances(factor);
        break;
      case "systemic_resistances":
        model.ModelScaler.scale_systemic_resistances(factor);
        break;
      case "systemic_u_vol":
        model.ModelScaler.scale_systemic_u_vol(factor);
        break;
      // airway (dead space + conducting airways)
      case "airway_elastances":
        model.ModelScaler.scale_airway_elastances(factor);
        break;
      case "airway_u_vol":
        model.ModelScaler.scale_airway_u_vol(factor);
        break;
      case "airway_upper_resistances":
        model.ModelScaler.scale_airway_upper_resistances(factor);
        break;
      case "airway_lower_resistances":
        model.ModelScaler.scale_airway_lower_resistances(factor);
        break;
      // left lung
      case "left_lung_elastances":
        model.ModelScaler.scale_left_lung_elastances(factor);
        break;
      case "left_lung_resistances":
        model.ModelScaler.scale_left_lung_resistances(factor);
        break;
      case "left_lung_u_vol":
        model.ModelScaler.scale_left_lung_u_vol(factor);
        break;
      // right lung
      case "right_lung_elastances":
        model.ModelScaler.scale_right_lung_elastances(factor);
        break;
      case "right_lung_resistances":
        model.ModelScaler.scale_right_lung_resistances(factor);
        break;
      case "right_lung_u_vol":
        model.ModelScaler.scale_right_lung_u_vol(factor);
        break;
      // heart
      case "heart_el_min":
        model.ModelScaler.scale_heart_el_min(factor);
        break;
      case "heart_el_max":
        model.ModelScaler.scale_heart_el_max(factor);
        break;
      case "left_heart_el_min":
        model.ModelScaler.scale_left_heart_el_min(factor);
        break;
      case "left_heart_el_max":
        model.ModelScaler.scale_left_heart_el_max(factor);
        break;
      case "left_heart_u_vol":
        model.ModelScaler.scale_left_heart_u_vol(factor);
        break;
      case "right_heart_el_min":
        model.ModelScaler.scale_right_heart_el_min(factor);
        break;
      case "right_heart_el_max":
        model.ModelScaler.scale_right_heart_el_max(factor);
        break;
      case "right_heart_u_vol":
        model.ModelScaler.scale_right_heart_u_vol(factor);
        break;
      case "heart_resistances":
        model.ModelScaler.scale_heart_resistances(factor);
        break;
      // containers
      case "thorax_elastances":
        model.ModelScaler.scale_thorax_elastances(factor);
        break;
      case "pericardium_elastances":
        model.ModelScaler.scale_pericardium_elastances(factor);
        break;
      // utility
      case "weight":
        model.weight = factor;
        break;
      case "weight_scale":
        model.ModelScaler.scale_to_weight(factor);
        break;
      case "add_volume":
        model.ModelScaler.add_volume(factor);
        break;
      case "incorporate":
        model.ModelScaler.incorporate();
        break;
      case "reset":
        model.ModelScaler.reset();
        model.weight = model._baseline_weight;
        break;
    }
    get_model_state();
    _send({
      type: "status",
      message: `${group} scaled by factor ${factor}`,
      payload: [],
    });
  } catch (e) {
    console.error("ModelEngine: scaling error:", e);
    _send_error(`Scaling error: ${e.message}`, e);
  }
};

const _model_step = function () {
  // iterate over all models (cached arrays, see _refresh_model_list)
  const list = _model_list;
  for (let m = 0; m < list.length; m++) {
    const model_component = list[m];
    const model_name = _model_names[m];
    if (ENABLE_STEP_ERROR_GUARD) {
      try {
        model_component.step_model();
      } catch(e) {
        // report the first error per model only; later ones are counted, not sent
        const count = (step_errors[model_name] || 0) + 1;
        step_errors[model_name] = count;
        if (count === 1) {
          console.error("Step model error: ", model_component.name, e);
          _send_error(`step_model error in ${model_component.name}: ${e.message} (further errors from this model are not reported until the next build)`, e);
        }
      }
    } else {
      model_component.step_model();
    }

  }

  // call the datacollector
  _get_data_collector()?.collect_data(model.model_time_total);

  // do the tasks
  _get_task_scheduler()?.run_tasks();

  // increase the model clock
  model.model_time_total += model.modeling_stepsize;
};

const save_state = function() {
  postMessage({
    type: "state_saved",
    message: "",
    payload: model,
  });
  
}

// define the local model functions
const _model_step_rt = function () {
  try {
    // run the steps the wall clock is owed since the previous tick (nominally rtInterval / stepsize)
    const now = performance.now();
    const wall = (now - rtLastWall) / 1000.0;
    rtLastWall = now;
    rtDebt = Math.min(rtDebt + wall, RT_MAX_CATCHUP * rtInterval);
    const dt = model.modeling_stepsize;
    // the small epsilon keeps a tick that is owed exactly n steps from rounding down to n - 1
    const noOfSteps = Math.floor(rtDebt / dt + 1e-9);
    rtDebt -= noOfSteps * dt;
    _refresh_model_list();
    for (let i = 0; i < noOfSteps; i++) {
      _model_step();
    }
    rtPerfSim += noOfSteps * dt;
    rtPerfWall += wall;

    // fast stream
    if (channel_writer && model.DataCollector && !model.DataCollector.legacy_mode) {
      // chart rows were written into the ring inside collect_data; here we pack
      // the latest anim frame and flush (flush is a no-op in shared mode).
      if (animation_packer) {
        animation_packer.pack_and_write(channel_writer, model.model_time_total);
      }
      channel_writer.flush();
    } else {
      // legacy object path
      _get_model_data_rt();
    }

    // get slow model data, with the realtime factor (simulated / wall time) since the last report
    if (rtSlowCounter > rtSlowInterval) {
      rtSlowCounter = 0;
      _get_model_data_rt_slow();
      if (rtPerfWall > 0.0) postMessage({ type: "rt_perf", message: "", payload: rtPerfSim / rtPerfWall });
      rtPerfSim = 0.0;
      rtPerfWall = 0.0;
    }
    rtSlowCounter += rtInterval;
  } catch (err) {
    // Stop the realtime loop to prevent repeated failures
    clearInterval(rtClock);
    rtClock = null;
    console.error("ModelEngine: fatal error in realtime loop:", err);
    _send_error(`Fatal error in realtime loop: ${err.message}`, err);
    _send({ type: "rt_stop", message: "", payload: [] });
  }
};

const _get_model_data_rt = function () {
  // get the realtime model data from the datacollector
  model_data = _get_data_collector()?.get_model_data() || [];

  // send data to the ui
  postMessage({
    type: "rtf",
    message: "",
    payload: model_data,
  });
};

const _get_model_data_rt_slow = function () {
  // get the realtime slow model data from the datacollector
  model_data = _get_data_collector()?.get_model_data_slow() || [];

  // send data to the ui
  postMessage({
    type: "rts",
    message: "",
    payload: model_data,
  });
};

const _send = function (message) {
  postMessage(message);
};

const _send_error = function (message, err) {
  postMessage({
    type: "error",
    message: message,
    payload: {
      error: err?.message || String(err),
      stack: err?.stack || null,
    },
  });
};

```

### FILE: explain-engine/ModelIndex.js

```javascript
// import the base models
export { BloodDiffusor } from "./base_models/BloodDiffusor";
export { Capacitance }  from "./base_models/Capacitance";
export { Container} from "./base_models/Container";
export { GasCapacitance } from "./component_models/GasCapacitance";
export { GasExchanger } from "./base_models/GasExchanger";
export { Resistor } from "./base_models/Resistor";
export { TimeVaryingElastance } from "./base_models/TimeVaryingElastance";

// import the component models
export { Blood } from "./component_models/Blood";
export { BloodCapacitance } from "./component_models/BloodCapacitance";
export { BloodTimeVaryingElastance } from "./component_models/BloodTimeVaryingElastance";
export { BloodVessel } from "./component_models/BloodVessel";
export { Fluids } from "./component_models/Fluids";

export { HeartValve } from "./component_models/HeartValve";
export { Placenta } from "./component_models/Placenta";
export { MaternalPlacenta } from "./component_models/MaternalPlacenta";
export { Shunts } from "./component_models/Shunts";
export { Pda } from "./component_models/Pda";

export { Heart } from "./component_models/Heart";
export { Mob } from "./component_models/Mob";
export { HeartFunction } from "./component_models/HeartFunction";
export { Circulation } from "./component_models/Circulation";
export { HeartChamber } from "./component_models/HeartChamber";

export { Gas } from "./component_models/Gas";
export { Breathing } from "./component_models/Breathing";
export { Apnea } from "./component_models/Apnea";
export { Respiration } from "./component_models/Respiration";
export { Surfactant } from "./component_models/Surfactant";

export { Ans } from "./component_models/Ans";
export { AnsAfferent } from "./component_models/AnsAfferent";
export { AnsEfferent } from "./component_models/AnsEfferent";
export { Metabolism } from "./component_models/Metabolism";
export { Brain } from "./component_models/Brain";
export { Thermoregulation } from "./component_models/Thermoregulation";
export { Glucose } from "./component_models/Glucose";
export { Lactate } from "./component_models/Lactate";
export { Kidneys } from "./component_models/Kidneys";
export { Uterus } from "./component_models/Uterus";
export { Hormones } from "./component_models/Hormones";
export { Drugs } from "./component_models/Drugs";


// import the device models
export { Ecls } from "./device_models/Ecls";
export { Monitor } from "./device_models/Monitor";
export { Resuscitation } from "./device_models/Resuscitation";
export { Ventilator } from "./device_models/Ventilator";
export { Sle6000 } from "./device_models/Sle6000";
```

### FILE: explain-engine/base_models/BaseModelClass.js

```javascript
import * as BuiltinModels from "../ModelIndex.js"
import { get_model_class } from "../helpers/ModelRegistry.js"

// Composite sub-components are instantiated by model_type. Ask the engine's registry first —
// it holds built-in AND custom models (see ../custom_models/README.md) — and fall back to the
// ModelIndex namespace, keyed by export name, when the engine has not populated it. Both are
// resolved lazily: ModelIndex and this file form an import cycle, so its bindings are still
// uninitialized while this module evaluates, and only complete by the time init_model runs.
const resolve_model_class = (model_type) => get_model_class(model_type) ?? BuiltinModels[model_type]

// This base model class is the blueprint for all the model objects (classes). It incorporates the properties and methods which all model objects must implement 
export class BaseModelClass {
  constructor(model_ref, name = "") {
    // initialize independent properties which all models implement
    this.name = name; // name of the model object
    this.description = ""; // description for documentation purposes
    this.is_enabled = false; // flag whether the model is enabled or not
    this.model_type = ""; // holds the model type e.g. BloodCapacitance
    this.components = {}; // sub-models this model owns, keyed by name: { name: definition } (see init_model)

    // initialize local properties
    this._model_engine = model_ref; // object holding a reference to the model engine
    this._t = model_ref.modeling_stepsize; // setting the modeling stepsize
    this._is_initialized = false; // flag whether the model is initialized or not
  }

  init_model(args = []) {
    // set the values of the independent properties
    args.forEach((arg) => {
      this[arg["key"]] = arg["value"];
    });


    Object.keys(this.components).forEach(component_name => {
      // do not overwrite existing models
      if (!this._model_engine.models.hasOwnProperty(component_name)) {
        this._model_engine.models[component_name] = new (resolve_model_class(this.components[component_name].model_type))(this._model_engine, component_name);
      }
    })
  
    // initialize all model sub models with the arguments
    Object.keys(this.components).forEach(component_name => {
      let args = [];
      for (const [key, value] of Object.entries(this.components[component_name])) {
        args.push({ key, value });
      }
      this._model_engine.models[component_name].init_model(args)
    })
    
    // flag that the model is initialized
    this._is_initialized = true;
  }

  step_model() {
    // this method is called by the model engine and if the model is enabled and initialized it will do the model calculations
    if (this.is_enabled && this._is_initialized) {
      this.calc_model();
    }
  }

  calc_model() {
    // this method is overridden by almost all model classes as this is the place where model calculations take place
    // Override this method in subclasses
  }
}

```

### FILE: explain-engine/base_models/BloodDiffusor.js

```javascript
import { BaseModelClass } from "./BaseModelClass";
import { calc_blood_composition } from "../component_models/BloodComposition"

export class BloodDiffusor extends BaseModelClass {
  // static properties
  static model_type = "BloodDiffusor";

  constructor(model_ref, name = "") {
    // call the parent constructor
    super(model_ref, name);

    // initialize independent properties
    this.comp_blood1 = "PLF"; // name of the first blood-containing model (legacy default; scenarios set it, e.g. PL_FETAL_CAP)
    this.comp_blood2 = "PLM"; // name of the second blood-containing model (legacy default; scenarios set it, e.g. PL_MAT)
    this.dif_o2 = 0.01; // diffusion constant for o2 (mmol/(mmHg*s))
    this.dif_co2 = 0.01; // diffusion constant for co2 (mmol/(mmHg*s))
    this.dif_solutes = {}; // diffusion constant for the different solutes (L/s: mmol/s per mmol/L of gradient)

     // non-persistent property factors. These factors reset to 1.0 after each model step
    this.dif_o2_factor = 1.0; // non-persistent diffusion factor for o2 (unitless)
    this.dif_co2_factor = 1.0; // non-persistent diffusion factor for co2 (unitless)
    this.dif_solutes_factor = 1.0; // non-persistent diffusion factor for solutes (unitless)

    // persistent property factors. These factors are persistent and do not reset
    this.dif_o2_factor_ps = 1.0; // persistent diffusion factor for o2 (unitless)
    this.dif_co2_factor_ps = 1.0; // persistent diffusion factor for co2 (unitless)
    this.dif_solutes_factor_ps = 1.0; // persistent diffusion factor for solutes (unitless)

    // scaling factors
    this.dif_o2_factor_scaling_ps = 1.0; // scaling factor for the o2 diffusion factor (unitless)
    this.dif_co2_factor_scaling_ps = 1.0; // scaling factor for the co2 diffusion factor (unitless)
    this.dif_solutes_factor_scaling_ps = 1.0; // scaling factor for the solute diffusion factor (unitless)
  
    // dependent properties
    this.dif_o2_step = 0.0; // effective o2 diffusion constant incl. the factors (mmol/(mmHg·s))
    this.dif_co2_step = 0.0; // effective co2 diffusion constant incl. the factors (mmol/(mmHg·s))

    // local variables
    this._comp_blood1 = null; // reference to the first blood-containing model
    this._comp_blood2 = null; // reference to the second blood-containing model
  }

  calc_model() {
    // find the two blood-containing models and store references
    this._comp_blood1 = this._model_engine.models[this.comp_blood1];
    this._comp_blood2 = this._model_engine.models[this.comp_blood2];
    if (!this._comp_blood1 || !this._comp_blood2) return;

    // calculate the blood composition of the blood components in this diffusor as we need the partial pressures for the gas diffusion
    calc_blood_composition(this._comp_blood1);
    calc_blood_composition(this._comp_blood2);

    // incorporate the factors
    this.dif_o2_step = this.dif_o2
        + (this.dif_o2_factor - 1) * this.dif_o2
        + (this.dif_o2_factor_ps - 1) * this.dif_o2
        + (this.dif_o2_factor_scaling_ps - 1) * this.dif_o2;

    this.dif_co2_step = this.dif_co2
        + (this.dif_co2_factor - 1) * this.dif_co2
        + (this.dif_co2_factor_ps - 1) * this.dif_co2
        + (this.dif_co2_factor_scaling_ps - 1) * this.dif_co2;

    let solutes_step = 1.0
        + (this.dif_solutes_factor - 1)
        + (this.dif_solutes_factor_ps - 1)
        + (this.dif_solutes_factor_scaling_ps - 1);

    // diffuse the gases, where diffusion is partial pressure-driven. A failed acid-base / O2 solve
    // leaves po2/pco2 at the -1 sentinel, which would drive a spurious flux: skip that gas this step
    const b1 = this._comp_blood1;
    const b2 = this._comp_blood2;
    if (b1.po2 >= 0.0 && b2.po2 >= 0.0) {
      const do2 = (b1.po2 - b2.po2) * this.dif_o2_step * this._t;
      this._transfer(do2, () => b1.to2, (v) => (b1.to2 = v), () => b2.to2, (v) => (b2.to2 = v));
    }
    if (b1.pco2 >= 0.0 && b2.pco2 >= 0.0) {
      const dco2 = (b1.pco2 - b2.pco2) * this.dif_co2_step * this._t;
      this._transfer(dco2, () => b1.tco2, (v) => (b1.tco2 = v), () => b2.tco2, (v) => (b2.tco2 = v));
    }

    // diffuse the solutes, where the diffusion is concentration gradient-driven (dif_solutes in L/s:
    // the flux in mmol/s per mmol/L of gradient). A solute missing on either side is skipped
    Object.keys(this.dif_solutes).forEach((sol) => {
      const c1 = b1.solutes[sol];
      const c2 = b2.solutes[sol];
      if (typeof c1 !== "number" || typeof c2 !== "number") return;
      const dsol = (c1 - c2) * this.dif_solutes[sol] * solutes_step * this._t;
      this._transfer(dsol, () => b1.solutes[sol], (v) => (b1.solutes[sol] = v),
        () => b2.solutes[sol], (v) => (b2.solutes[sol] = v));
    });

    // reset the non-persistent factors
    this.dif_o2_factor = 1.0;
    this.dif_co2_factor = 1.0;
    this.dif_solutes_factor = 1.0;
  }

  // move `amount` (mmol, positive from blood1 to blood2) between the two compartments. The flux is
  // limited to what the donor holds (no concentration below zero), and a fixed-composition (infinite
  // reservoir) or empty compartment keeps its concentration; the other side still changes
  _transfer(amount, get1, set1, get2, set2) {
    const b1 = this._comp_blood1;
    const b2 = this._comp_blood2;
    const n1 = b1.vol > 0.0 ? get1() * b1.vol : 0.0;
    const n2 = b2.vol > 0.0 ? get2() * b2.vol : 0.0;
    const free1 = !b1.fixed_composition && b1.vol > 0.0;
    const free2 = !b2.fixed_composition && b2.vol > 0.0;
    if (amount > 0.0 && free1) amount = Math.min(amount, Math.max(n1, 0.0));
    if (amount < 0.0 && free2) amount = Math.max(amount, -Math.max(n2, 0.0));
    if (free1) set1((n1 - amount) / b1.vol);
    if (free2) set2((n2 + amount) / b2.vol);
  }
}

```

### FILE: explain-engine/base_models/Capacitance.js

```javascript
import { BaseModelClass } from "./BaseModelClass";

export class Capacitance extends BaseModelClass {
  // static properties
  static model_type = "Capacitance";

  constructor(model_ref, name = "") {
    // call the parent constructor
    super(model_ref, name);

    // initialize independent properties
    this.u_vol = 0.0; // unstressed volume UV (L)
    this.el_base = 0.0; // baseline elastance E (mmHg/L)
    this.el_k = 0.0; // non-linear elastance coefficient K2 (mmHg/L²), acts only above the unstressed volume
    this.pres_ext = 0.0; // non persistent external pressure p2(t) (mmHg)
    this.fixed_composition = false;

    // non-persistent property factors. These factors reset to 1.0 after each model step
    this.u_vol_factor = 1.0; // non-persistent unstressed volume factor step (unitless)
    this.el_base_factor = 1.0; // non-persistent elastance factor step (unitless)
    this.el_k_factor = 1.0; // non-persistent elastance factor step (unitless)

    // persistent property factors. These factors are persistent and do not reset
    this.u_vol_factor_ps = 1.0;  // persistent unstressed volume factor (unitless)
    this.el_base_factor_ps = 1.0; // persistent elastance factor (unitless)
    this.el_k_factor_ps = 1.0; // persistent elastance factor (unitless)

    // persistent scaling factors
    this.u_vol_factor_scaling_ps = 1.0;
    this.el_base_factor_scaling_ps = 1.0;
    this.el_k_factor_scaling_ps = 1.0;

    // initialize dependent properties
    this.vol = 0.0; // volume v(t) (L)
    this.pres = 0.0; // pressure p1(t) (mmHg)
    this.pres_in = 0.0; // recoil pressure of the elastance (mmHg)

    // local variables
    this.el_eff = 0.0; // calculated elastance (mmHg/L)
    this.u_vol_eff = 0.0; // calculated unstressed volume (L)
    this.el_k_eff = 0.0; // calculated non-linear elastance coefficient (mmHg/L²)
  }

  // this routine is called in every model step by the ModelEngine Class
  calc_model() {
    // first calculate the current elastances and volumes
    this.calc_elastances();
    this.calc_volumes();
    // then calculate the pressure
    this.calc_pressure();
  }

  calc_elastances() {
    // calculate the elastance and non-linear elastance incorparting the factors
    this.el_eff = this.el_base 
        + (this.el_base_factor - 1) * this.el_base
        + (this.el_base_factor_ps - 1) * this.el_base
        + (this.el_base_factor_scaling_ps - 1) * this.el_base

    this.el_k_eff = this.el_k 
        + (this.el_k_factor - 1) * this.el_k
        + (this.el_k_factor_ps - 1) * this.el_k
        + (this.el_k_factor_scaling_ps - 1) * this.el_k

    // reset the non persistent factors
    this.el_base_factor = 1.0;
    this.el_k_factor = 1.0;
  }

  calc_volumes() {
    // calculate the unstressed volume incorporating the factors
    this.u_vol_eff = this.u_vol 
        + (this.u_vol_factor - 1) * this.u_vol
        + (this.u_vol_factor_ps - 1) * this.u_vol
        + (this.u_vol_factor_scaling_ps - 1) * this.u_vol
    // the factor layers add up and can take the sum below zero; an unstressed volume can't be negative
    if (this.u_vol_eff < 0.0) this.u_vol_eff = 0.0;

    // reset the non persistent factors
    this.u_vol_factor = 1.0;
  }
  
  calc_pressure() {
    // calculate the recoil pressure
    // the non-linear term only stiffens a stretched compartment (above its unstressed volume): (V - U)^2
    // is also positive below U, where it would push the wrong way and bend the P-V curve back up
    const _s = this.vol - this.u_vol_eff;
    this.pres_in = (_s > 0.0 ? this.el_k_eff * _s * _s : 0.0) + this.el_eff * _s;

    // calculate the total pressure by incorporating the external pressures
    this.pres = this.pres_in + this.pres_ext;

    // reset the external pressures
    this.pres_ext = 0.0;
  }

  volume_in(dvol) {
    if (!this.fixed_composition) {
      // add volume to the capacitance
      this.vol += dvol;
    }
  }

  volume_out(dvol) {
    if (!this.fixed_composition) {
      // remove volume from capacitance
      this.vol -= dvol;
    }

    // if the volume is zero or lower, handle it
    if (this.vol < 0.0) {
      let _vol_not_removed = -this.vol;
      // reset the volume to zero.
      this.vol = 0.0;
      // return the volume that was not removed
      return _vol_not_removed;
    }

    // return zero as all volume is removed
    return 0.0;
  }
}

```

### FILE: explain-engine/base_models/Container.js

```javascript
import { BaseModelClass } from "./BaseModelClass";

export class Container extends BaseModelClass {
  // static properties
  static model_type = "Container";

  constructor(model_ref, name = "") {
    // call the constructor of the parent class
    super(model_ref, name);

    // initialize independent properties
    this.u_vol = 0.0; // unstressed volume UV (L)
    this.el_base = 0.0; // baseline elastance E (mmHg/L)
    this.el_k = 0.0; // non-linear elastance K2 (mmHg/L^2), acts only above the unstressed volume
    this.pres_ext = 0.0; // non persistent external pressure p2(t) (mmHg)
    this.vol_extra = 0.0; // additional volume of the container (L)
    this.contained_components = []; // list of names of models this Container contains

    // non-persistent property factors. These factors reset to 1.0 after each model step
    this.u_vol_factor = 1.0; // non-persistent unstressed volume factor step (unitless)
    this.el_base_factor = 1.0; // non-persistent elastance factor step (unitless)
    this.el_k_factor = 1.0; // non-persistent elastance factor step (unitless)

    // persistent property factors. These factors are persistent and do not reset
    this.u_vol_factor_ps = 1.0;  // persistent unstressed volume factor (unitless)
    this.el_base_factor_ps = 1.0; // persistent elastance factor (unitless)
    this.el_k_factor_ps = 1.0; // persistent elastance factor (unitless)

    // scaling factors. These factors are persistent and do not reset, but they also scale the effect of the other factors instead of being added to them
    this.u_vol_factor_scaling_ps = 1.0;
    this.el_base_factor_scaling_ps = 1.0;
    this.el_k_factor_scaling_ps = 1.0;

    // initialize dependent properties
    this.vol = 0.0; // volume v(t) (L)
    this.pres = 0.0; // pressure p1(t) (mmHg)
    this.pres_in = 0.0; // recoil pressure of the elastance (mmHg)

    // local variables
    this.el_eff = 0.0; // calculated elastance (mmHg/L)
    this.u_vol_eff = 0.0; // calculated unstressed volume (L)
    this.el_k_eff = 0.0; // calculated non-linear elastance coefficient (mmHg/L²)
  }

  calc_model() {
    // first calculate the current elastances and volumes
    this.calc_elastances();
    this.calc_volumes();
    
    // then calculate the pressure
    this.calc_pressure();
  }

  calc_elastances() {
    // calculate the elastance and non-linear elastance incorparting the factors
    this.el_eff = this.el_base 
        + (this.el_base_factor - 1) * this.el_base
        + (this.el_base_factor_ps - 1) * this.el_base
        + (this.el_base_factor_scaling_ps - 1) * this.el_base;

    this.el_k_eff = this.el_k 
        + (this.el_k_factor - 1) * this.el_k
        + (this.el_k_factor_ps - 1) * this.el_k
        + (this.el_k_factor_scaling_ps - 1) * this.el_k;

    // reset the non persistent factors
    this.el_base_factor = 1.0;
    this.el_k_factor = 1.0;
  }

  calc_volumes() {
    // reset the starting volume to the additional volume of the container
    this.vol = this.vol_extra;

    // get the cumulative volume from all contained models and add it to the volume of the container.
    // skip missing components (bad/typo'd name) and disabled ones (they don't participate)
    this.contained_components.forEach((c) => {
      const m = this._model_engine.models[c];
      if (m && m.is_enabled) {
        this.vol += m.vol;
      }
    });
    
    // calculate the unstressed volume incorporating the factors
    this.u_vol_eff = this.u_vol 
        + (this.u_vol_factor - 1) * this.u_vol
        + (this.u_vol_factor_ps - 1) * this.u_vol
        + (this.u_vol_factor_scaling_ps - 1) * this.u_vol;

    // reset the non persistent factors
    this.u_vol_factor = 1.0;
  }

  calc_pressure() {
    // calculate the recoil pressure
    // the non-linear term only stiffens a stretched container (above its unstressed volume): (V - U)^2
    // is also positive below U, where it would push the wrong way (a slack pericardium does not
    // squeeze an under-filled heart)
    const _s = this.vol - this.u_vol_eff;
    this.pres_in = (_s > 0.0 ? this.el_k_eff * _s * _s : 0.0) + this.el_eff * _s;

    // calculate the total pressure by incorporating the external pressures
    this.pres = this.pres_in + this.pres_ext;

    // transfer the container pressure to the contained components. Skip missing components and
    // disabled ones — a disabled component never runs its calc_pressure to reset pres_ext, so
    // adding to it here would accumulate unbounded until it is re-enabled.
    this.contained_components.forEach((c) => {
      const m = this._model_engine.models[c];
      if (m && m.is_enabled) {
        m.pres_ext += this.pres;
      }
    });

    // reset the external pressure
    this.pres_ext = 0.0;
  }
}

```

### FILE: explain-engine/base_models/GasExchanger.js

```javascript
import { BaseModelClass } from "./BaseModelClass";
import { calc_blood_composition } from "../component_models/BloodComposition"
import { GAS_CONSTANT } from "../helpers/Units";

export class GasExchanger extends BaseModelClass {
  // static properties
  static model_type = "GasExchanger";

  constructor(model_ref, name = "") {
    // call the parent constructor
    super(model_ref, name);

    // initialize independent properties
    this.comp_blood = ""; // name of the blood component
    this.comp_gas = ""; // name of the gas component
    this.dif_o2 = 0.0; // diffusion constant for oxygen (mmol/mmHg * s)
    this.dif_co2 = 0.0; // diffusion constant for carbon dioxide (mmol/mmHg * s)

    // Optional membrane transfer ceiling (mmol/s). 0 = disabled = legacy pure-diffusion behaviour, so
    // this is inert for the native-lung exchangers (GASEX_LL/GASEX_RL), which never set it. Only the
    // ECLS oxygenator sets it (driven by the Ecls device) to model a rated-flow membrane: once blood
    // flow exceeds the membrane's rated flow, the per-step flux is capped, so the outlet compartment
    // cannot fully saturate and post-oxygenator saturation falls — instead of pinning at ~100%.
    this.o2_cap = 0.0; // max O2 transfer (mmol/s); 0 = no ceiling
    this.co2_cap = 0.0; // max CO2 transfer (mmol/s); 0 = no ceiling

    // non-persistent factors
    this.dif_o2_factor = 1.0; // factor modifying the oxygen diffusion constant
    this.dif_co2_factor = 1.0; // factor modifying the carbon diffusion constant

    // persistent factors
    this.dif_o2_factor_ps = 1.0; // factor modifying the oxygen diffusion constant
    this.dif_co2_factor_ps = 1.0; // factor modifying the carbon diffusion constant

    // scaling factors (the persistent scaling layer)
    this.dif_o2_factor_scaling_ps = 1.0; // scaling factor for the oxygen diffusion constant
    this.dif_co2_factor_scaling_ps = 1.0; // scaling factor for the carbon diffusion constant
    
    // dependent properties
    this.flux_o2 = 0.0; // O2 moved this step, blood -> gas (mmol per step; uptake is negative)
    this.flux_co2 = 0.0; // CO2 moved this step, blood -> gas (mmol per step)

    // local variables
    this._blood = null; // reference to the blood component
    this._gas = null; // reference to the gas component
    this.dif_o2_step = 0.0; // effective O2 diffusion constant incl. the factors (mmol/(mmHg·s))
    this.dif_co2_step = 0.0; // effective CO2 diffusion constant incl. the factors (mmol/(mmHg·s))
    // the blood-gas solve (calc_blood_composition, an iterative acid-base / O2 solve) runs every
    // bc_interval seconds instead of every step; the fluxes in between use the last po2/pco2
    this.bc_interval = 0.002;
    this._bc_counter = Infinity; // solve on the first step
  }

  calc_model() {
    // find the blood and gas components (cached; re-resolved when a name changes)
    if (this._blood_name !== this.comp_blood || this._gas_name !== this.comp_gas || !this._blood || !this._gas) {
      this._blood = this._model_engine.models[this.comp_blood];
      this._gas = this._model_engine.models[this.comp_gas];
      this._blood_name = this.comp_blood;
      this._gas_name = this.comp_gas;
      this._bc_counter = Infinity;
    }
    if (!this._blood || !this._gas) return;

    // set the blood composition of the blood component (every bc_interval, see the constructor)
    this._bc_counter += this._t;
    if (this._bc_counter >= this.bc_interval - 1e-12) {
      this._bc_counter = 0.0;
      calc_blood_composition(this._blood);
    }

    // get the partial pressures and gas concentrations from the components
    let po2_blood = this._blood.po2;
    let pco2_blood = this._blood.pco2;
    let to2_blood = this._blood.to2;
    let tco2_blood = this._blood.tco2;

    let co2_gas = this._gas.co2;
    let cco2_gas = this._gas.cco2;
    let po2_gas = this._gas.po2;
    let pco2_gas = this._gas.pco2;

    // guard against division by zero on either compartment (both volumes are used as denominators)
    if (this._blood.vol <= 0.0 || this._gas.vol <= 0.0) return;

    // incorporate the factors
    this.dif_o2_step = this.dif_o2 
        + (this.dif_o2_factor - 1) * this.dif_o2
        + (this.dif_o2_factor_ps - 1) * this.dif_o2
        + (this.dif_o2_factor_scaling_ps - 1) * this.dif_o2; // apply scaling factor to the diffusion factor

    this.dif_co2_step = this.dif_co2 
        + (this.dif_co2_factor - 1) * this.dif_co2
        + (this.dif_co2_factor_ps - 1) * this.dif_co2
        + (this.dif_co2_factor_scaling_ps - 1) * this.dif_co2; // apply scaling factor to the diffusion factor

    // the factor layers add up, so several writers lowering them at once (Surfactant derecruitment
    // plus atelectasis) can take the sum below zero; a negative diffusion constant would pump gas
    // against its gradient and blow up the blood gases, so floor it at no exchange
    if (this.dif_o2_step < 0.0) this.dif_o2_step = 0.0;
    if (this.dif_co2_step < 0.0) this.dif_co2_step = 0.0;


    // calculate the O2 flux from the blood to the gas compartment.
    // If calc_blood_composition could not resolve po2 it leaves the -1 sentinel (e.g. when an
    // oxygenator drives the O2 content above the solver's po2 ceiling). The raw (po2_blood - po2_gas)
    // gradient would then read po2_blood as -1 — a huge spurious uptake that keeps pumping O2 in every
    // step, a runaway that inflates to2 and keeps po2 unsolvable. Skip the O2 flux while po2 is invalid;
    // advection dilutes the compartment back into a solvable range and normal exchange resumes.
    this.flux_o2 = po2_blood < 0.0 ? 0.0 : (po2_blood - po2_gas) * this.dif_o2_step * this._t;

    // membrane transfer ceiling: cap the per-step flux magnitude at o2_cap*dt (mmol). Inert when
    // o2_cap == 0 (native lung). This is what makes the ECLS oxygenator rated-flow-limited.
    if (this.o2_cap > 0.0) {
      const o2_lim = this.o2_cap * this._t;
      if (this.flux_o2 > o2_lim) this.flux_o2 = o2_lim;
      else if (this.flux_o2 < -o2_lim) this.flux_o2 = -o2_lim;
    }

    // never move more than the donor holds (flooring the donor afterwards would leave the receiver
    // with the full flux and create molecules)
    this.flux_o2 = this._limit(this.flux_o2, to2_blood * this._blood.vol, co2_gas * this._gas.vol);

    // calculate the new O2 concentrations of the gas and blood compartments
    let new_to2_blood = (to2_blood * this._blood.vol - this.flux_o2) / this._blood.vol;
    let new_co2_gas = (co2_gas * this._gas.vol + this.flux_o2) / this._gas.vol;

    // calculate the CO2 flux from the blood to the gas compartment (same invalid-partial-pressure guard
    // as O2: a failed acid-base solve leaves pco2 at the -1 sentinel, which would drive a spurious flux).
    this.flux_co2 = pco2_blood < 0.0 ? 0.0 : (pco2_blood - pco2_gas) * this.dif_co2_step * this._t;

    // membrane transfer ceiling for CO2 (see O2 above). Inert when co2_cap == 0.
    if (this.co2_cap > 0.0) {
      const co2_lim = this.co2_cap * this._t;
      if (this.flux_co2 > co2_lim) this.flux_co2 = co2_lim;
      else if (this.flux_co2 < -co2_lim) this.flux_co2 = -co2_lim;
    }

    this.flux_co2 = this._limit(this.flux_co2, tco2_blood * this._blood.vol, cco2_gas * this._gas.vol);

    // calculate the new CO2 concentrations of the gas and blood compartments
    let new_tco2_blood = (tco2_blood * this._blood.vol - this.flux_co2) / this._blood.vol;
    let new_cco2_gas = (cco2_gas * this._gas.vol + this.flux_co2) / this._gas.vol;

    // transfer the new concentrations, guarding each compartment by fixed_composition so a fixed
    // (infinite-reservoir) compartment stays constant, mirroring BloodDiffusor
    if (!this._blood.fixed_composition) {
      this._blood.to2 = new_to2_blood;
      this._blood.tco2 = new_tco2_blood;
    }
    if (!this._gas.fixed_composition) {
      this._gas.co2 = new_co2_gas;
      this._gas.cco2 = new_cco2_gas;

      // the net molar exchange changes the gas volume (O2 uptake exceeds CO2 output when RQ < 1): at
      // the compartment's pressure and temperature dn mmol occupy dn / c_ideal litres. Every species
      // keeps its moles in the new volume, so the alveolar gas shrinks and the pressure drop draws
      // gas in through the airways (the mass flow behind apnoeic oxygenation and absorption)
      const gas = this._gas;
      const dn = this.flux_o2 + this.flux_co2;
      const c_ideal = gas.pres > 0.0 ? (gas.pres / (GAS_CONSTANT * (273.15 + gas.temp))) * 1000.0 : 0.0;
      if (dn !== 0.0 && c_ideal > 0.0) {
        const v0 = gas.vol;
        const v1 = v0 + dn / c_ideal;
        if (v1 > 0.0) {
          const k = v0 / v1;
          gas.co2 *= k;
          gas.cco2 *= k;
          gas.cn2 *= k;
          gas.ch2o *= k;
          gas.cother *= k;
          gas.vol = v1;
        }
      }
    }

    // reset the non-persistent factors
    this.dif_o2_factor = 1.0;
    this.dif_co2_factor = 1.0;
  }

  // clamp a flux (mmol, + = blood to gas) to the amount the donor side holds
  _limit(flux, n_blood, n_gas) {
    if (flux > 0.0) return Math.min(flux, Math.max(n_blood, 0.0));
    if (flux < 0.0) return Math.max(flux, -Math.max(n_gas, 0.0));
    return flux;
  }
}

```

### FILE: explain-engine/base_models/Resistor.js

```javascript
import { BaseModelClass } from "./BaseModelClass";
import { exchange_blood } from "../helpers/BloodMixing";
import { exchange_gas } from "../helpers/GasMixing";

export class Resistor extends BaseModelClass {
  // static properties
  static model_type = "Resistor";

  constructor(model_ref, name = "") {
    // call the constructor of the parent class
    super(model_ref, name);

    // initialize independent properties
    this.r_for = 1.0; // forward flow resistance Rf (mmHg*s/l)
    this.r_back = 1.0; // backward flow resistance Rb (mmHg*s/l )
    this.r_k = 0.0; // non-linear resistance coefficient K1 (mmHg·s²/L²)
    this.comp_from = ""; // holds the name of the upstream component
    this.comp_to = ""; // holds the name of the downstream component
    this.no_flow = false; // flags whether flow is allowed across this resistor
    // a second, independent gate for a controller that does NOT own this resistor: an owning
    // BloodVessel re-copies its own no_flow every step and would overwrite a gate written there
    this.no_flow_ext = false;
    this.no_back_flow = false; // flags whether backflow is allowed across this resistor
    // Numerical scheme, not physiology: when true the flow is computed backward-Euler for the pair
    // of compartments this resistor joins, flow = Δp / (R + dt·(E_from + E_to)), instead of the
    // explicit Δp / R. Explicit integration of two capacitances joined by a small resistance is
    // stable only while dt·(E_from + E_to)/R < 2 (< 4/3 for three equal ones in a row, as the
    // aorta AA–AAR–AD is); the implicit form is stable for any elastance and equals the explicit
    // one to first order when R >> dt·ΣE. Default false: only resistors that join near-merged
    // compartments need it (see docs/Resistor.md).
    this.implicit = false;
    this.p1_ext = 0.0; // external pressure on the inlet (mmHg)
    this.p2_ext = 0.0; // external pressure on the outlet (mmHg)
    // Mixing without net flow (L/s): an equal volume exchanged both ways each step. Blood: eddies and
    // vortex flow between compartments that are one continuous pool (helpers/BloodMixing.js
    // exchange_blood). Gas: molecular diffusion and cardiogenic mixing (helpers/GasMixing.js
    // exchange_gas). Advection by `flow` only carries upstream contents downstream. 0 (default) = off.
    this.mix_flow = 0.0;
    // Inertance L (mmHg·s²/L) of the blood column through this connection: dp = R·f + L·df/dt, so
    // the flow is a state that accelerates and decelerates instead of following the pressure
    // difference instantly (L = ρ·length/area). Used on the AV valves, where it shapes the E and A
    // waves. 0 (default) = the plain resistor.
    this.inertance = 0.0;

    // non-persistent property factors. These factors reset to 1.0 after each model step
    this.r_factor = 1.0; // non-persistent resistance factor
    this.r_k_factor = 1.0; // non-persistent non-linear coefficient factor

     // persistent property factors. These factors are persistent and do not reset
    this.r_factor_ps = 1.0; //  persistent resistance factor
    this.r_k_factor_ps = 1.0; // persistent non-linear coefficient factor

    // scaling factors
    this.r_factor_scaling_ps = 1.0; // persistent scaling factor for the resistance
    this.r_k_factor_scaling_ps = 1.0; // persistent scaling factor for the non-linear coefficient

    // initialize dependent properties
    this.flow = 0.0;  // flow f(t) (L/s)
    
    // local variables
    this._comp_from = {}; // holds a reference to the upstream component
    this._comp_to = {}; // holds a reference to the downstream component
    this.r_for_eff = 1000;  // calculated forward resistance (mmHg/L*s)
    this.r_back_eff = 1000; // calculated backward resistance (mmHg/L*s)
    this.r_k_eff = 0; // calculated non-linear resistance coefficient (mmHg·s²/L²)
    this._ref_version = -1; // _models_version the cached _comp_from/_comp_to were resolved at
    this._ref_from = null; // comp_from / comp_to names they were resolved for
    this._ref_to = null;
  }

  // this routine is called in every model step by the ModelEngine Class
  calc_model() {
    // find the up- and downstream components and store the references. Cached: re-resolved when a
    // name changes (e.g. ECLS re-cannulation) or the engine's model set may have changed
    // (_models_version is bumped at every calculate() call and realtime tick)
    const version = this._model_engine._models_version;
    if (this._ref_version !== version || this._ref_from !== this.comp_from || this._ref_to !== this.comp_to) {
      this._comp_from = this._model_engine.models[this.comp_from];
      this._comp_to = this._model_engine.models[this.comp_to];
      this._ref_version = version;
      this._ref_from = this.comp_from;
      this._ref_to = this.comp_to;
    }

    // calculate the resistances
    this.calc_resistance();

    // calculate the flow
    this.calc_flow();

    // exchange without net flow (never across a closed connection)
    if (this.mix_flow > 0.0 && !this.no_flow && !this.no_flow_ext && this._comp_from && this._comp_to) {
      if (typeof this._comp_from.to2 === "number" && typeof this._comp_to.to2 === "number") {
        exchange_blood(this._comp_from, this._comp_to, this.mix_flow * this._t);
      } else if (typeof this._comp_from._end_conc === "function" && typeof this._comp_to._end_conc === "function") {
        exchange_gas(this._comp_from, this._comp_to, this.mix_flow * this._t);
      }
    }
  }

  // calculate resistance
  calc_resistance() {
       // incorporate all factors influencing this resistor
       this.r_for_eff = this.r_for 
          + (this.r_factor - 1) * this.r_for
          + (this.r_factor_ps - 1) * this.r_for
          + (this.r_factor_scaling_ps - 1) * this.r_for; // apply scaling factor to the forward resistance

       this.r_back_eff = this.r_back 
          + (this.r_factor - 1) * this.r_back
          + (this.r_factor_ps - 1) * this.r_back
          + (this.r_factor_scaling_ps - 1) * this.r_back; // apply scaling factor to the backward resistance

       this.r_k_eff = this.r_k 
          + (this.r_k_factor - 1) * this.r_k
          + (this.r_k_factor_ps - 1) * this.r_k
          + (this.r_k_factor_scaling_ps - 1) * this.r_k; // apply scaling factor to the non-linear coefficient

      // reset the non persistent factors
      this.r_factor = 1.0;
      this.r_k_factor = 1.0;

      // backward-Euler pair correction (see `implicit` above)
      if (this.implicit) {
        const k = this._t * (this._elastance(this._comp_from) + this._elastance(this._comp_to));
        this.r_for_eff += k;
        this.r_back_eff += k;
      }
  }

  // current local elastance dP/dV of a compartment for the implicit correction: a capacitance's el_eff, or
  // a time-varying elastance's instantaneous value between its minimum and maximum, plus the slope of the
  // non-linear term above the unstressed volume (2·el_k·S; for a time-varying elastance it belongs to the
  // diastolic curve, so it fades with the activation)
  _elastance(c) {
    if (!c) return 0.0;
    const s = typeof c.vol === "number" && typeof c.u_vol_eff === "number" ? c.vol - c.u_vol_eff : 0.0;
    const k = s > 0.0 && typeof c.el_k_eff === "number" ? 2.0 * c.el_k_eff * s : 0.0;
    if (typeof c.el_max_eff === "number" && typeof c.act_factor === "number")
      return c.el_min_eff + k + (c.el_max_eff - c.el_min_eff - k) * c.act_factor;
    return typeof c.el_eff === "number" ? c.el_eff + k : 0.0;
  }

  // flow magnitude (L/s) for a pressure drop dp >= 0 through a linear resistance r plus the turbulent
  // term: dp = r * f + r_k_eff * f^2. Solved exactly for this step, in the form without cancellation,
  // f = 2 dp / (r + sqrt(r^2 + 4 r_k dp)), so the turbulent loss never lags, chatters or reverses the
  // flow. r_k_eff = 0 keeps the plain dp / r.
  _flow(dp, r) {
    if (!(this.r_k_eff > 0.0)) return dp / r;
    return (2.0 * dp) / (r + Math.sqrt(r * r + 4.0 * this.r_k_eff * dp));
  }

  calc_flow() {
    // get the pressure of the volume containing compartments and incorporate the external pressures
    let _p1_t = this._comp_from.pres + this.p1_ext;
    let _p2_t = this._comp_to.pres + this.p2_ext;

    // reset the external pressures
    this.p1_ext = 0.0;
    this.p2_ext = 0.0;

    // with inertance the flow is a state carried from the previous step
    if (this.inertance > 0.0) {
      this._calc_inertial_flow(_p1_t - _p2_t);
      return;
    }

    // reset the current flow
    this.flow = 0.0;

    // return if no flow is allowed across this resistor
    if (this.no_flow || this.no_flow_ext) return;

    // calculate the forward flow between two components
    if (_p1_t >= _p2_t) {
      // guard against a non-positive resistance (would produce Infinity/NaN flow)
      if (this.r_for_eff <= 0.0) return;
      // calculate the forward flow: dp = r_for_eff * flow + r_k_eff * flow^2 (see _flow)
      this.flow = this._flow(_p1_t - _p2_t, this.r_for_eff);

      // update the volumes of the connected components but do not remove the volume which could not be removed from the upstream component (to prevent volume loss)
      const vol_not_removed = this._comp_from.volume_out(this.flow * this._t);
      this._comp_to.volume_in(this.flow * this._t - vol_not_removed, this._comp_from);
      
      // return from this function
      return;
    }

    // calculate the backward flow between two components
    if (_p1_t < _p2_t && !this.no_back_flow) {
      // guard against a non-positive resistance (would produce Infinity/NaN flow)
      if (this.r_back_eff <= 0.0) return;
      // calculate the backward flow (negative), same relation on the pressure difference's magnitude
      this.flow = -this._flow(_p2_t - _p1_t, this.r_back_eff);

      // update the volumes of the connected components but do not remove the volume which could not be removed from the upstream component (to prevent volume loss)
      let vol_not_removed = this._comp_to.volume_out(-this.flow * this._t);
      this._comp_from.volume_in(-this.flow * this._t - vol_not_removed,this._comp_to);

      // return from this function
      return;
    }

    // reached only when p1 < p2 and backflow is blocked: no flow this step
  }

  _calc_inertial_flow(dp) {
    // dp = R·f + r_k·|f|·f + L·df/dt, integrated semi-implicitly in f (the resistive terms at the new
    // flow, r_k linearised at the old one), which is unconditionally stable for the resistor itself;
    // the coupling with the compartments' pressures oscillates at sqrt(ΣE/L), far slower than the
    // step for physiological L. A valve (no_back_flow) closes when its flow comes to zero: it cannot
    // reverse, so the flow is held at 0 until the pressure difference drives it forward again.
    if (this.no_flow || this.no_flow_ext) {
      this.flow = 0.0;
      return;
    }
    const f0 = this.flow;
    const r = (f0 >= 0.0 ? this.r_for_eff : this.r_back_eff) + this.r_k_eff * Math.abs(f0);
    if (!(r > 0.0)) {
      this.flow = 0.0;
      return;
    }
    const a = this._t / this.inertance;
    let f = (f0 + a * dp) / (1.0 + a * r);
    if (this.no_back_flow && f < 0.0) f = 0.0;
    this.flow = f;
    if (f > 0.0) {
      const vol_not_removed = this._comp_from.volume_out(f * this._t);
      this._comp_to.volume_in(f * this._t - vol_not_removed, this._comp_from);
    } else if (f < 0.0) {
      const vol_not_removed = this._comp_to.volume_out(-f * this._t);
      this._comp_from.volume_in(-f * this._t - vol_not_removed, this._comp_to);
    }
  }
}

```

### FILE: explain-engine/base_models/TimeVaryingElastance.js

```javascript
import { BaseModelClass } from "./BaseModelClass";

export class TimeVaryingElastance extends BaseModelClass {
  // static properties
  static model_type = "TimeVaryingElastance";

  constructor(model_ref, name = "") {
    // call the parent constructor
    super(model_ref, name);

    // initialize independent properties
    this.u_vol = 0.0; // unstressed volume UV (L)
    this.el_min = 0.0; // minimal elastance Emin (mmHg/L)
    this.el_max = 0.0; // maximal elastance emax(n) (mmHg/L)
    this.el_k = 0.0; // non-linear elastance coefficient K2 (mmHg/L²), diastolic curve, above the unstressed volume only
    this.pres_ext = 0.0; // non persistent external pressure p2(t) (mmHg)
    this.act_factor = 0.0; // activation factor from the heart model (unitless)

    // non-persistent property factors. These factors reset to 1.0 after each model step
    this.u_vol_factor = 1.0; // non-persistent unstressed volume factor step (unitless)
    this.el_min_factor = 1.0; // non-persistent minimal elastance factor step (unitless)
    this.el_max_factor = 1.0; // non-persistent maximal elastance factor step (unitless)
    this.el_k_factor = 1.0; // non-persistent elastance factor step (unitless)

    // persistent property factors. These factors are persistent and do not reset
    this.u_vol_factor_ps = 1.0; // persistent unstressed volume factor (unitless)
    this.el_min_factor_ps = 1.0; // persistent minimal elastance factor (unitless)
    this.el_max_factor_ps = 1.0; // persistent maximal elastance factor (unitless)
    this.el_k_factor_ps = 1.0; // persistent elastance factor (unitless)

    // scaling factors. These factors are persistent and do not reset
    this.u_vol_factor_scaling_ps = 1.0; // persistent scaling factor for the unstressed volume (unitless)
    this.el_min_factor_scaling_ps = 1.0; // persistent scaling factor for the minimal elastance (unitless)
    this.el_max_factor_scaling_ps = 1.0; // persistent scaling factor for the maximal elastance (unitless)
    this.el_k_factor_scaling_ps = 1.0; // persistent scaling factor for the elastance non-linearity (unitless)

    // initialize dependent properties
    this.vol = 0.0; // volume v(t) (L)
    this.pres = 0.0; // pressure p1(t) (mmHg)
    this.pres_in = 0.0; // recoil pressure of the elastance (mmHg)

    // local properties
    this.el_min_eff = 0.0; // calculated minimal elastance (mmHg/L)
    this.el_max_eff = 0.0; // calculated maximal elastance (mmHg/L)
    this.u_vol_eff = 0.0; // calculated unstressed volume (L)
    this.el_k_eff = 0.0; // calculated non-linear elastance coefficient (mmHg/L²)
  }

  // this routine is called in every model step by the ModelEngine Class
  calc_model() {
    // calculate the elastances and volumes
    this.calc_elastances();
    this.calc_volumes();
    // calculate the pressure
    this.calc_pressure();
  }

  calc_elastances() {    
    // calculate the elastances and non-linear elastance incorparting the factors
    this.el_min_eff = this.el_min 
        + (this.el_min_factor - 1) * this.el_min
        + (this.el_min_factor_ps - 1) * this.el_min
        + (this.el_min_factor_scaling_ps - 1) * this.el_min; // apply scaling factor to the elastance factor
    
    this.el_max_eff = this.el_max 
        + (this.el_max_factor - 1) * this.el_max
        + (this.el_max_factor_ps - 1) * this.el_max
        + (this.el_max_factor_scaling_ps - 1) * this.el_max; // apply scaling factor to the elastance factor

    this.el_k_eff = this.el_k 
        + (this.el_k_factor - 1) * this.el_k
        + (this.el_k_factor_ps - 1) * this.el_k
        + (this.el_k_factor_scaling_ps - 1) * this.el_k; // apply scaling factor to the elastance factor

    // make sure that el_max is not smaller than el_min
    if (this.el_max_eff < this.el_min_eff) {
      this.el_max_eff = this.el_min_eff;
    }
    
    // reset the non persistent factors
    this.el_min_factor = 1.0;
    this.el_max_factor = 1.0;
    this.el_k_factor = 1.0;
  }

  calc_volumes() {
    // calculate the unstressed volume incorporating the factors
    this.u_vol_eff = this.u_vol 
        + (this.u_vol_factor - 1) * this.u_vol
        + (this.u_vol_factor_ps - 1) * this.u_vol
        + (this.u_vol_factor_scaling_ps - 1) * this.u_vol; // apply scaling factor to the unstressed volume
    // the factor layers add up and can take the sum below zero; an unstressed volume can't be negative
    if (this.u_vol_eff < 0.0) this.u_vol_eff = 0.0;

    // reset the non persistent factors
    this.u_vol_factor = 1.0;
  }

  calc_pressure() {
    // calculate the recoil pressure
    // the non-linear diastolic term only acts above the unstressed volume (see Capacitance.calc_pressure)
    const _s = this.vol - this.u_vol_eff;
    let p_ms = _s * this.el_max_eff;
    let p_ed = (_s > 0.0 ? this.el_k_eff * _s * _s : 0.0) + this.el_min_eff * _s;

    // calculate the current recoil pressure
    this.pres_in = (p_ms - p_ed) * this.act_factor + p_ed;

    // calculate the total pressure by incorporating the external pressures
    this.pres = this.pres_in + this.pres_ext

    // reset the external pressure
    this.pres_ext = 0.0;
  }

  // override the volume_in method
  volume_in(dvol, comp_from) {
    // add volume to the capacitance
    this.vol += dvol;
  }

  volume_out(dvol) {
    // remove volume from capacitance
    this.vol -= dvol;

    // if the volume is zero or lower, handle it
    if (this.vol < 0.0) {
      let _vol_not_removed = -this.vol;
      // reset the volume to zero.
      this.vol = 0.0;
      // return the volume that was not removed
      return _vol_not_removed;
    }

    // return zero as all volume is removed
    return 0.0;
  }
}

```


## 5. Scenario format

Scenarios in `model_definitions/*.json` are full app documents (`animation_definition`,
`diagram_definition`, `configuration`, and **`model_definition`**). `Model.load()` fetches
`/model_definitions/<name>.json` and unwraps `jsonData.model_definition || jsonData` before
`build()`. Inside `model_definition`: engine settings plus **`models`** — a map of
`name → { name, model_type, …params }` wired together by Resistor `comp_from`/`comp_to`.
Available scenarios are listed in `public/model_definitions/index.json`.

### FILE: public/model_definitions/index.json

```json
[
  "term_neonate_12h",
  "term_neonate_1h",
  "term_neonate_24h",
  "term_neonate_72h"
]

```
