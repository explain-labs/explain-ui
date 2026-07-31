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

Each `InterfaceField` describes one editable field: `target` (prop name, or method name for `function`), `type` (`number`/`boolean`/`string`/`list`/`multiple-list`/`factor`/`function`/`prop-list`/`reference`), `caption`, `edit_mode` (`basic`/`extra`/`factors`/`advanced`), `build_prop`, `readonly`; numbers add `factor` (display = raw×factor), `delta`, `rounding`, `ll`/`ul`, `slider`; lists add `options`/`choices`/`custom_options`; functions add `args`. When you add a configurable parameter, add a matching field to the model_type's array in `registry.ts` or it won't be editable in the app. The registry was generated by dumping each class's effective (inheritance-resolved) interface from `explain-engine/ModelIndex.js`.

## Composite models

Some component models build sub-models inside `init_model` via the `this.components` mechanism (base `init_model` instantiates any declared component into `model.models` and inits it). This lets a high-level model own a local sub-network while its children still participate in the global step loop. Always register internally created models on `model.models` (by going through `components` or the engine map) so the scheduler/collector can reach them.

## Docs

Prose documentation is split into two sets in **two repositories**: [`docs/ui/`](docs/ui/README.md) (the Vue app) lives here, and [`explain-engine/docs/`](explain-engine/docs/README.md) (the physics engine) lives in the engine repo beside the code it documents — it reaches this tree through the submodule. [`docs/README.md`](docs/README.md) is the index for both.

[`explain-engine/docs/*.md`](explain-engine/docs/README.md) contains the physiological derivations for several models (`BloodCapacitance`, `BloodVessel`, `HeartChamber`, `Pda`, …). Consult these before changing the math in those classes. `explain-engine/README.md` has a student-onboarding walkthrough and a usage cheat sheet (drive the engine via the `model` returned by `useExplain()`).

Note: a checkout without `git submodule update --init` has no engine docs at all.

## UI documentation

The **Vue UI layer** (everything under `src/`) is documented in [`docs/ui/`](docs/ui/README.md) — start at [`docs/ui/README.md`](docs/ui/README.md), or [`docs/ui/UI_ARCHITECTURE.md`](docs/ui/UI_ARCHITECTURE.md) for the whole-UI overview. That set is the long form of the two `model_interface` sections above and covers the parts `CLAUDE.md` doesn't: the two-plane (reactive control / non-reactive ~60 Hz data) architecture, the Pinia stores, the `src/render/` adapters (uPlot/Pixi), the host + control + numeric components, the chat/bot command pipeline (`src/services/`), and routing/auth. This file stays the quick reference; `docs/ui/` is canonical for the UI.

```


## 2. Engine onboarding

### FILE: explain-engine/README.md

````markdown
# Explain Engine

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.21389097.svg)](https://doi.org/10.5281/zenodo.21389097)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A framework-agnostic, dependency-free physiological simulation engine (whole-body neonatal
and adult cardiorespiratory model). It runs in a dedicated Web Worker (`ModelEngine.js`) and
is controlled from the main thread through the `Model` wrapper (`Model.js`).

This repository is self-contained: it has no runtime or build dependencies, and the tooling
under `scripts/` (headless harness, probes, sensitivity-analysis campaign) runs on plain Node
with no install step. Consumers mount it as a git submodule — see
[`explain-ui`](https://github.com/explain-labs/explain-ui) for the web app built on it.

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

Example: `MicroVascularUnit` creates and configures internal `BloodVessel` components (arteriole/capillary/venule), then registers them in the engine model map. This allows a higher-level model to encapsulate a local network while still participating in global stepping.

## Adding a new model type

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

A few things that bite newcomers: payloads crossing the worker boundary are JSON-stringified for `build`/`property_value`/`call`; UI metadata is **not** on the model classes (it lives in `src/model-interface/registry.ts`); cardiac/breathing timing counters live on the engine `model` object (`ncc_*`), not on the components; and the factor / `*_factor_ps` / `*_factor_scaling_ps` effective-value pattern means core physics params are never used raw. These and other gotchas are covered in [`./docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Student onboarding manual

### 1. Running the model

1. Start the Vite dev server (`npm run dev`) from this directory (Vue 3 + Vite + TypeScript app; production build via `npm run build`).
2. The explain engine bootstraps via `src/composables/useExplain.ts`, a singleton that instantiates `Model` (imported as `@explain/Model`) and loads the default definition.
3. Use UI buttons or call the engine wrapper returned by `useExplain()` (`model`) to `build`, `load`, `start`, `stop`, or `calculate(seconds)`.
4. Place custom definitions under `model_definitions` and run `explain.load("definition_name")` (omit `.json`).

### 2. Observing & tweaking data

- Fast telemetry: `explain.watchModelProps(["Heart.heart_rate", "Ventilator.peep"])`.
- Change parameters with easing: `explain.setPropValue("Ventilator.peep", 10, 5 /* seconds */, 0 /* delay */)`.
- Trigger functions: `explain.callModelFunction("Heart.resetBaro", [], 0.25)`.

### 3. Adding models

**Base models** (`base_models`)
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

1. Definitions live in `model_definitions/*.json`.
2. Each entry contains `{ name, model_type, settings, inputs }`.
3. Example block:

```json
{
  "name": "MyDevice",
  "model_type": "MyDevice",
  "settings": { "pressure": 18 },
  "inputs": { "Lung": "Lung" }
}
```

4. Reload via `explain.load("my_definition")` or rebuild in place with `explain.restart()`.

### 5. Debugging checklist

- Watch worker traffic in DevTools (console logs prefixed with `Model:`).
- Hook events: `document.addEventListener("status", (evt) => console.log(evt.detail))`.
- Snapshot: `explain.getModelState()`; inspect the payload emitted by the worker.
- Missing models usually mean `model_type` typos or missing exports in `ModelIndex`.

### 6. Cleanup

- When done (component unmount, hot reload), call `explain.dispose()` to terminate the worker and drop listeners.

## Citation

If you use this software, please cite it via its archived release. The DOI below is the
**concept (all-versions) DOI** and always resolves to the latest release:

> Antonius, T. *Explain: a whole-body physiological simulation engine* (v0.1.0). Zenodo. https://doi.org/10.5281/zenodo.21389097

Machine-readable metadata lives in [`CITATION.cff`](./CITATION.cff); GitHub's "Cite this repository" button reads it directly. To cite a specific version, use that release's version-specific DOI from the [Zenodo record](https://doi.org/10.5281/zenodo.21389097) instead of the concept DOI.


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
| `load(definition_name)` | Fetches `/model_definitions/<name>.json`, unwraps `jsonData.model_definition \|\| jsonData`, forwards `diagram_definition`/`animation_definition`, then calls `build`. |
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
| `scaleModel(group, factor=1.0)` | POST `scale` — allometric/manual scaling via ModelScaler. |
| `tune(targets, opts={})` | POST `calibrate` — live closed-loop tuning to target vitals; emits `tuned`. |

---

## 4. Build flow (`ModelEngine.build()`)

`build(model_definition)` runs synchronously and returns a boolean (`model_initialized`). Ordered steps:

1. **Reset.** `errors = 0`; `model_initialized = false`; clear `model_data`/`model_data_slow`; `clearInterval(rtClock)`.
2. **Fresh `model` object** with empty `models: {}`, empty `scaler_config`, and the six `ncc_*` counters zeroed (`ncc_atrial`, `ncc_ventricular`, `ncc_breathing_insp`, `ncc_breathing_exp`, `ncc_ventilator_insp`, `ncc_ventilator_exp`).
3. **Copy engine-level settings.** Every top-level key of the definition except `models` is copied onto `model` (`weight`, `modeling_stepsize`, `model_time_total`, `scaler_config`, …).
4. **Instantiate.** For each entry in `model_definition.models`, look up the class by `sub_model_def.model_type` in `available_model_map`. If found, `new model_class(model, name, model_type)` and store on `model.models[name]`. A missing type or a constructor throw increments `errors` and emits a `status` `ERROR:` message. (The constructor's 3rd `model_type` arg is ignored by the base class.)
5. **Initialize (only if `errors < 1`).** For each instance, build `args` as a `[{key, value}, …]` list from the definition entry and call `init_model(args)`. An init throw increments `errors` and emits a `status` `ERROR:`.
6. **Attach helpers.** `model.DataCollector = new DataCollector(model)`, `model.TaskScheduler = new TaskScheduler(model)`, `model.ModelScaler = new ModelScaler(model, model.scaler_config)`.
7. **Freeze baseline weight.** `model._baseline_weight = model.weight` (the allometric anchor `reset()`/`scale_to_weight()` use).
8. **Wire the realtime data plane.** Construct `ChannelWriter` and `AnimationPacker`, acquire the anim snapshot, and `DataCollector.set_channels(...)`. Failures here are caught and degrade to the legacy object path (they do **not** fail the build).
9. **Emit.** If `errors > 0`: `status` `ERROR: model build failed` and return `false`. Otherwise emit `model_ready` and return `true`.

Note the two-pass structure: **all** instances are constructed before **any** are initialized. This is what lets `init_model` resolve cross-model references (`this._lv = this._model_engine.models["LV"]`) — every sibling already exists by the time init runs.

---

## 5. Step loop

`_model_step()` is the single time step:

1. For each model in `model.models` **in insertion order**, call `step_model()`. When `ENABLE_STEP_ERROR_GUARD` (currently `true`) each call is wrapped in try/catch and a throw emits an `error` event but does not abort the loop — one bad model can't kill the simulation.
2. `DataCollector.collect_data(model.model_time_total)`.
3. `TaskScheduler.run_tasks()`.
4. `model.model_time_total += model.modeling_stepsize`.

Two ways to drive it:

- **`calculate(seconds)`** — synchronous offline run of `seconds / model.modeling_stepsize` steps in a tight `for` loop, then emits one `data`/`data_slow`/`state` snapshot and reports timing via `status`. The chart ring is bypassed (object data path).
- **`start()` → `_model_step_rt`** — `setInterval(_model_step_rt, rtInterval * 1000)` with `rtInterval = 0.015` s wall clock. Each tick runs `rtInterval / modeling_stepsize` model steps, then either writes typed chart rows + packs the animation frame through `ChannelWriter`/`AnimationPacker` (fast path) or falls back to the `rtf` object message. Slow data (`rts`) is emitted once per `rtSlowInterval = 1.0` s. A throw inside the realtime loop clears the interval and emits `rt_stop` so it fails safe. `stop()` clears the interval and flips `DataCollector.rt_active = false`.

---

## 6. The model-class contract

Every model lives in `base_models/`, `component_models/`, or `device_models/` and extends [`BaseModelClass`](./BaseModelClass.md) (directly or through an intermediate like `Capacitance`/`Resistor`/`TimeVaryingElastance`).

- **`static model_type`** — the string key used in `available_model_map` and in definition JSON. Model classes carry **no UI metadata**; the edit schema is a consumer concern (in explain-ui it lives at `src/model-interface/registry.ts`).
- **`constructor(model_ref, name = "")`** — `model_ref` is the whole engine `model` object; the base stores it as `this._model_engine` and caches `this._t = model_ref.modeling_stepsize`. Initialize independent props (config), dependent props (computed outputs), and `_`-prefixed local refs here. (`build()` passes a 3rd `model_type` arg the base ignores.)
- **`init_model(args)`** — base impl maps each `{key, value}` in `args` onto `this[key]`, then instantiates and inits anything declared in `this.components` (registering each on `model.models`), and finally sets `this._is_initialized = true`. Override to resolve cross-model references, then call/replicate the base behaviour.
- **`step_model()`** — base impl runs `calc_model()` only when `is_enabled && _is_initialized`. Don't override unless you need custom gating.
- **`calc_model()`** — where the physics happens. Override this.

---

## 7. Cross-cutting patterns

These are documented once here; per-class docs should link back rather than restate them.

### 7a. The factor / effective-value pattern

Core physics params are never used raw. Each tunable has a base value plus three multiplier layers combined **additively** against the base into an `*_eff` (or `*_step`) value:

| Layer | Persistence | Set by |
|---|---|---|
| `<p>_factor` | **non-persistent** — reset to `1.0` at the end of each step | transient interventions (TaskScheduler type-0 tween targets, per-step effects) |
| `<p>_factor_ps` | **persistent** | user/scenario adjustments |
| scaling layer | **persistent** | `ModelScaler` only |

The formula (see `Capacitance.calc_elastances` / `Resistor.calc_resistance`):

```
p_eff = p + (factor-1)*p + (factor_ps-1)*p + (factor_scaling-1)*p
```

When adding a tunable param, follow this convention so it composes with interventions and scaling.

**⚠️ The scaling-layer suffix is NOT uniform across the engine.** Verify before you copy:

- The **capacitance / resistor / time-varying-elastance** family uses **`*_factor_scaling_ps`** (e.g. `el_base_factor_scaling_ps`, `u_vol_factor_scaling_ps`, `r_factor_scaling_ps` in [`Capacitance.js`](../base_models/Capacitance.js) / [`Resistor.js`](../base_models/Resistor.js)).
- The **diffusor / exchanger** family uses **`*_factor_scaling`** with **no `_ps`** (e.g. `dif_o2_factor_scaling`, `dif_co2_factor_scaling` in [`GasDiffusor.js`](../base_models/GasDiffusor.js); likewise `GasExchanger`, `BloodDiffusor`).

If you scale a diffusor through the `*_scaling_ps` name it will silently do nothing.

### 7b. `ncc_*` cycle counters live on the engine `model` object

The cardiac/breathing/ventilator timing counters are **not** component fields — they are initialized on `model` in `build()`: `model.ncc_atrial`, `model.ncc_ventricular`, `model.ncc_breathing_insp`, `model.ncc_breathing_exp`, `model.ncc_ventilator_insp`, `model.ncc_ventilator_exp`. The `Heart`, `Breathing`, and `Ventilator` models read/advance them through `this._model_engine`. The `DataCollector` **always** watches `Heart.ncc_ventricular` and `Heart.ncc_atrial` (pushed onto the watchlist in its constructor and on reset) so the ECG is available regardless of the user watchlist.

### 7c. Blood/gas composition propagation

There is no global solver moving solutes around — composition rides the flow. `Resistor.calc_flow` moves volume by calling `comp_from.volume_out(flow*dt)` then `comp_to.volume_in(...)`. `BloodCapacitance.volume_in(dvol, comp_from)` mixes the incoming substances by the incoming volume fraction:

```
concentration += ((concentration_from - concentration) * dvol) / vol
```

applied to `to2`, `tco2`, every entry in `solutes` and `drugs`, plus `temp` and `viscosity` (treated as solutes). This dilution is how blood gases, solutes, drugs, and temperature propagate through the circuit. Gas compartments propagate analogously through `GasDiffusor`/`GasExchanger` partial-pressure-driven diffusion. See [`BloodCapacitance.md`](./BloodCapacitance.md).

### 7d. ModelScaler touches only the scaling layer

[`ModelScaler`](./ModelScaler.md) writes **only** the `*_factor_scaling_ps` layer (and direct volume adjustments) — never the base param or the `_ps` user layer — so allometric scaling composes cleanly with user/scenario adjustments. `scaleModel(group, factor)` routes through the big `switch` in `ModelEngine.scale_model` to the many `scale_*` methods (`scale_blood_volume`, `scale_systemic_resistances`, `scale_to_weight`, …). `reset` calls `ModelScaler.reset()` and restores `model.weight = model._baseline_weight`.

---

## 8. How to add a new model

1. **Create the class** in `base_models/`, `component_models/`, or `device_models/`, extending `BaseModelClass` (or a suitable intermediate).
2. **Give it a `static model_type`** string — the key used at build and in definition JSON.
3. **Implement `init_model(args)`** (resolve cross-model refs, set `_is_initialized`) and **`calc_model()`** (the physics).
4. **Follow the factor convention** (§7a) for any tunable param so it composes with interventions and scaling — and use the **correct scaling suffix** for the family you're modelling.
5. **Export it from [`ModelIndex.js`](../ModelIndex.js).** The engine builds `available_model_map` from everything `ModelIndex` exports. **Forgetting this export is the usual cause of "model type not found" at build.**
6. **Reference the `model_type`** in your `model_definitions/*.json` `models` map.
7. **Add a `model_type` entry to the consumer's edit schema** (in explain-ui: `src/model-interface/registry.ts`) so the parameters become editable in the app (the engine ships no UI metadata).
8. **Write a doc** in `docs/engine/` following the template in §10.

---

## 9. The house doc template

Every per-class doc in `docs/engine/` should follow this structure (the canonical exemplar is [`BloodCapacitance.md`](./BloodCapacitance.md)):

1. **Title + one-paragraph summary** — what the model is, in plain terms.
2. **Inheritance** — an ASCII tree showing the chain up to `BaseModelClass`, and which classes extend this one.
3. **What it models** — the physiological/engineering role.
4. **Properties** — tables split into inherited vs. unique, with `Property | Unit | Description` columns. Mark sentinel values (e.g. `-1 = not calculated`).
5. **Calc / math sections** — the equations and the order `calc_model()` runs them, referencing the actual method names.
6. **Factor system** — the three-tier table for this model's tunables (link to §7a here rather than re-deriving it).
7. **Example definition (JSON)** — a real, minimal `models` entry.
8. **Usage in the model** — how it's wired into scenarios and which models reference it.

---

## 10. Helpers

One line each; follow the link for detail.

- **[DataCollector](./DataCollector.md)** — fast (`watch_list`, default `sample_interval` 0.005 s) and slow (`watch_list_slow`, 1.0 s) watchlists of dot-path props; `collect_data()` buffers, `get_model_data()` drains, `clean_up()` drops disabled-model entries. Always watches `Heart.ncc_*`.
- **[TaskScheduler](./TaskScheduler.md)** — deferred mutations every `_task_interval` (0.015 s): numeric tweens (type 0), instant boolean/string swaps (type 1), scheduled method calls (type 2). Writes directly to model props (usually a `*_factor_ps` or base param).
- **[ModelScaler](./ModelScaler.md)** — allometric/manual scaling; touches only the `*_factor_scaling_ps` layer; routed via `ModelEngine.scale_model`.
- **[Calibrator](./Calibrator.md)** — shared closed-loop secant calibration (`buildLiveControllers`/`runCalibration`/`measureWindow`); backs both offline patient-building and the live `tune_model` path.
- **[ChannelWriter](./ChannelWriter.md)** — typed realtime data-plane writer (chart ring + anim snapshot); flushed each realtime tick.
- **[RealtimeChannels](./RealtimeChannels.md)** — the `RT_MSG` message constants and channel/transport descriptors for the typed data plane.
- **[AnimationPacker](./AnimationPacker.md)** — builds the component→slot registry and packs per-frame sprite animation data from the live model.
- **[RealTimeMovingAverage](./RealTimeMovingAverage.md)** — moving-average helper used for smoothing realtime-derived signals.

### Realtime read side (`explain/realtime/`, main thread)

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
# Autonomic Nervous System (Ans, AnsAfferent, AnsEfferent)

The autonomic nervous system (ANS) subsystem is a closed-loop reflex controller. It senses
physiological quantities (pressures, blood gases), converts them to normalized **receptor firing
rates**, and feeds those back as **effect factors** onto target models (heart rate, contractility,
vascular tone, minute volume, …). It is the model's baroreflex and chemoreflex.

Three classes work together:

| Class | Role | Analogy |
|---|---|---|
| `Ans` | Manager — enables/disables the loop and refreshes the blood gases its receptors read | central control |
| `AnsAfferent` | Receptor — maps one input quantity to a firing rate (0–1) | baro-/chemoreceptor |
| `AnsEfferent` | Effector — averages incoming firing rates and writes an effect factor to a target | efferent nerve |

## Data flow

```
            input_prop (e.g. AAR.pres, AA.po2)
                   │
                   ▼
            ┌───────────────┐   firing_rate (0–1)      ┌───────────────┐   effector (factor)
   sensor → │  AnsAfferent  │ ───────────────────────► │  AnsEfferent  │ ──────────────────────► target_model.target_prop
            │  (receptor)   │   update_effector(fr, w)  │  (effector)   │   (e.g. Heart.ans_activity_hr)
            └───────────────┘                           └───────────────┘
                   ▲                                                                    │
                   └──────────────────── physiological response ────────────────────────┘
```

An afferent can drive **several** efferents (its `efferents` list); an efferent can be driven by
**several** afferents (they accumulate via `update_effector`). All three run on their own throttled
interval, decoupled from the model step size.

## `Ans` — the manager

`calc_model()` runs every `_update_interval` (0.05 s) and does two things:

1. Propagates its `ans_active` flag to every sub-model listed in `components` (the afferents and
   efferents), so the whole loop can be switched on/off at once.
2. Recomputes the blood composition (`calc_blood_composition`) for every compartment named in
   `blood_composition_models`, so chemoreceptor afferents reading `po2`/`pco2`/`ph` see fresh values.

`Ans` holds no control logic itself — it is wiring and gating.

## `AnsAfferent` — receptor curve

Each afferent maps its input to a normalized firing rate in **[0, 1]**, with **0.5 as the setpoint**
(no effect). Updated every `_update_interval` (0.015 s):

1. **Read input:** `input_value = models[input_model][input_prop]`.
2. **Activation** (deviation from setpoint, clamped to the configured window):
   - `input_value > max_value` → `activation = max_value − set_value`
   - `input_value < min_value` → `activation = min_value − set_value`
   - otherwise → `activation = input_value − set_value`
3. **Gain** — the slope that maps activation onto the firing-rate range, separately above and below
   the setpoint so an asymmetric input window still spans 0→1:
   - activation > 0: `gain = (1.0 − 0.5) / (max_value − set_value)`
   - activation ≤ 0: `gain = (0.5 − 0.0) / (set_value − min_value)`
   - (each guarded against a zero-width range → gain 0)
4. **Target firing rate:** `new_firing_rate = 0.5 + gain · activation`.
5. **First-order lag** with time constant `tc` (forward Euler), so the receptor responds gradually:
   `firing_rate += (Δt / tc) · (new_firing_rate − firing_rate)`  (with `Δt = _update_interval`; if
   `tc == 0` the new rate is applied instantly).
6. **Broadcast:** call `update_effector(firing_rate, effect_weight)` on each connected efferent.

So a rising input (e.g. arterial pressure) above setpoint drives the firing rate toward 1; below
setpoint toward 0; at setpoint it sits at 0.5.

## `AnsEfferent` — effect translation

Each efferent collects firing rates from its afferents during the interval and, every
`_update_interval` (0.015 s), turns the average into an effect factor written to its target.

**Accumulation** (`update_effector`, called by each afferent):
```
_cum_firing_rate         += (firing_rate − 0.5) · weight   // summed weighted deviation
_cum_firing_rate_counter += 1                              // number of afferent votes
```

**Averaging** (`calc_model`): the resting firing rate must be 0.5 *regardless of how many afferents
feed the efferent*, so the 0.5 setpoint is added **after** averaging the deviations:
```
firing_rate = 0.5 + _cum_firing_rate / _cum_firing_rate_counter   (or 0.5 if no afferent fired)
```
> Note: an earlier version seeded the accumulator with 0.5 and divided that by the vote count, which
> made the resting rate 0.5/N — wrong for any efferent with more than one afferent. The accumulator
> now holds only deviations and is reset to 0.

**Translation** to an effect factor — piecewise linear, pinned to `1.0` (no effect) at firing rate
0.5 and continuous at the breakpoint:
```
firing_rate ≥ 0.5 :  effector = 1.0 + (effect_at_max_firing_rate − 1.0) / 0.5 · (firing_rate − 0.5)
firing_rate < 0.5 :  effector = effect_at_min_firing_rate + (1.0 − effect_at_min_firing_rate) / 0.5 · firing_rate
```
At firing rate 1.0 the effector equals `effect_at_max_firing_rate`; at 0.0 it equals
`effect_at_min_firing_rate`; at 0.5 it equals 1.0. If `ans_active` is false the effector is forced to
1.0 (no effect).

A first-order lag with time constant `tc` smooths the effector, then it is written straight onto the
target: `models[target_model][target_prop] = effector`. The accumulator is reset for the next window.

## Configuration (model-definition fields)

**AnsAfferent**: `input_model`, `input_prop`, `min_value` / `set_value` / `max_value` (the receptor
window, in the input's own units), `tc`, `efferents` (list of efferent names), `effect_weight`.

**AnsEfferent**: `target_model`, `target_prop` (the factor it drives, e.g. `Heart.ans_activity_hr`),
`effect_at_min_firing_rate`, `effect_at_max_firing_rate`, `tc`.

**Ans**: `ans_active`, `components` (its afferents/efferents), `blood_composition_models`.

Example wiring (term neonate): afferent `BR_MAP` reads `AAR.pres` and drives `EF_HR`, `EF_SVR`,
`EF_HEART`; efferent `EF_HR` writes `Heart.ans_activity_hr` with
`effect_at_max_firing_rate = 0.428`, `effect_at_min_firing_rate = 1.5` (high pressure → faster
firing → factor < 1 → lower heart rate; the baroreflex).

## Notes & caveats

- **Timing / lag.** Afferents, efferents and the manager each run on their own interval and the
  afferent→efferent hand-off depends on step order, so the loop carries up to one interval of lag.
  This is intended (receptors and effectors are not instantaneous) and stable at the default
  intervals.
- **Reference guarding.** `AnsAfferent` skips its update when `input_model` is missing and only calls
  `update_effector` on efferents that resolve to a model with that hook; `AnsEfferent` skips the write
  when `target_model` is missing. So broken afferent/efferent wiring degrades gracefully. The `Ans`
  manager itself (`components`, `blood_composition_models`) still dereferences its names directly — a
  name that does not resolve to a built model there will throw.
- **Setpoint = 0.5** everywhere — both the receptor output and the effector's neutral point. Keep new
  afferents/efferents on that convention so resting tone composes to "no effect".

````

### FILE: explain-engine/docs/AnsAfferent.md

```markdown
# AnsAfferent

An `AnsAfferent` is an autonomic **receptor**: it reads one input quantity (e.g. arterial pressure or
a blood gas), maps it through a baro-/chemoreceptor curve to a normalized firing rate (0–1, setpoint
0.5), low-passes it with a time constant, and broadcasts it to the connected efferents.

It is one of the three classes that make up the autonomic feedback loop — **see
[Ans.md](./Ans.md)** for the full description of the receptor curve (input → activation → gain →
firing rate), the data flow, the configuration fields (`input_model`, `input_prop`, `min/set/max`,
`tc`, `efferents`, `effect_weight`), and the reference-guarding behaviour.

```

### FILE: explain-engine/docs/AnsEfferent.md

```markdown
# AnsEfferent

An `AnsEfferent` is an autonomic **effector**: it averages the firing rates pushed to it by the
afferents, translates that average into an effect factor, smooths it with a time constant, and writes
it onto a target model property (e.g. `Heart.ans_activity_hr`).

It is one of the three classes that make up the autonomic feedback loop — **see
[Ans.md](./Ans.md)** for the full description of the firing-rate averaging (setpoint added after
averaging, so the resting rate stays 0.5 regardless of how many afferents feed it), the effect
translation, the configuration fields (`target_model`, `target_prop`, `effect_at_min/max_firing_rate`,
`tc`), and the reference-guarding behaviour.

```

### FILE: explain-engine/docs/BaseModelClass.md

````markdown
# BaseModelClass

`BaseModelClass` is the abstract root every model in the engine extends. It defines the common
**lifecycle** (construct → init → step → calc) and the shared fields the engine relies on; subclasses
add the actual physics in `calc_model()`. It has **no `model_type`** of its own and is never
instantiated directly, and it carries **no factor system** — the factor / effective-value pattern is
introduced by the elastance/resistance subclasses ([`Capacitance`](./Capacitance.md),
[`Resistor`](./Resistor.md), [`TimeVaryingElastance`](./TimeVaryingElastance.md)).

## Inheritance

```
BaseModelClass                       (abstract root — lifecycle + shared fields)
  ├── Capacitance                        → BloodCapacitance → BloodVessel, GasCapacitance
  ├── Resistor                           → HeartValve
  ├── TimeVaryingElastance               → HeartChamber, BloodTimeVaryingElastance
  ├── Container
  └── … every component & device model (Heart, Breathing, Ans, Ventilator, …)
```

## What it models

Nothing physiological on its own — it is the contract that makes a class a "model" the engine can
build, step, collect from and scale. Every component lives in `explain/base_models/`,
`explain/component_models/`, or `explain/device_models/` and ultimately extends this class.

## Properties

### Shared fields (independent / config)

| Property | Description |
|---|---|
| `name` | Unique model name (its key in `model.models`) |
| `description` | Free-text description (documentation only) |
| `is_enabled` | When false the model is skipped in the step loop; defaults to `false` |
| `model_type` | The class key used at build time and in the definition JSON (set by subclasses) |
| `components` | Dictionary of sub-models this model owns (composite-model mechanism) |

### Local / internal fields

| Property | Description |
|---|---|
| `_model_engine` | Reference to the whole engine `model` object (shared state, counters, other models) |
| `_t` | The modeling step size, **captured at construction** from `model_engine.modeling_stepsize` |
| `_is_initialized` | Set `true` at the end of `init_model`; gates stepping |

## Lifecycle

1. **Construct** `(model_ref, name = "")` — store the engine reference as `_model_engine`, snapshot
   the step size into `_t`, and set the shared-field defaults. (`build()` passes a 3rd `model_type`
   argument that the base constructor ignores.)
2. **`init_model(args)`** — apply the definition's `{key, value}` args onto the instance
   (`this[arg.key] = arg.value`); then for each entry in `this.components`: instantiate the sub-model
   into `model.models` (only if a model of that name does not already exist) and call `init_model` on
   it with its own args. Finally set `_is_initialized = true`.
3. **`step_model()`** — called every step by the engine; runs `calc_model()` **only when
   `is_enabled && _is_initialized`**. Don't override unless you need custom gating.
4. **`calc_model()`** — empty here; **overridden by almost every subclass** to do the per-step
   calculation. This is where the physics lives.

## Composite models (`components`)

A model can own a local sub-network by declaring sub-models in `components`. `init_model` instantiates
each into the global `model.models` map (skipping any name that already exists) and initializes it, so
the children still participate in the global step loop, data collection and scaling. `Pda`,
`Placenta`, `Ecls` and the `Ventilator` use this to own their internal circuits.

## Subclass contract

- Declare a static `model_type` string (the key used at build time and in the definition JSON), and
  add an `export` line in `explain/ModelIndex.js` so the engine's `available_model_map` can find it.
- In the constructor, call `super(model_ref, name)`, then initialize independent (config) props,
  dependent (computed) props, and `_`-prefixed local refs.
- Override `init_model` only to resolve cross-model references (e.g.
  `this._lv = this._model_engine.models["LV"]`); call `super.init_model(args)` (or set
  `_is_initialized = true` yourself) so stepping is enabled.
- Override `calc_model()` with the per-step physics.

## Example definition (JSON)

`BaseModelClass` is abstract — there is no definition block for it. Every concrete model's definition,
however, carries the shared fields it defines (`name`, `description`, `is_enabled`, `model_type`,
`components`) alongside that model's own parameters:

```json
{
  "name": "PA_PAAL",
  "description": "input connector for PAAL",
  "model_type": "Resistor",
  "is_enabled": true,
  "components": {}
}
```

## Usage in the model

- The foundational contract for every model; you extend it (directly or via an intermediate like
  `Capacitance` / `Resistor` / `TimeVaryingElastance`) to add a new model.
- The engine's build/step machinery (`ModelEngine`), `DataCollector` and `ModelScaler` all rely on
  these shared fields and the `is_enabled && _is_initialized` gate.

## Notes

- **`_t` is a snapshot.** It is read once at construction. There is no runtime setter for
  `modeling_stepsize`, and the build sets it before any model is constructed, so `_t` is always correct
  in practice — but a future runtime step-size change would need `_t` refreshed on every model (and on
  `TaskScheduler`).
- The base `init_model` does **not** error on unknown args — it assigns any `{key, value}` straight
  onto the instance, so definition typos become stray properties rather than build failures.

````

### FILE: explain-engine/docs/Blood.md

````markdown
# Blood

`Blood` is a **manager model**, not a compartment. It owns the circulating blood properties (haemoglobin and the other solutes, dissolved gases, temperature, viscosity, the O₂–Hb affinity baseline and the Haldane coefficient), seeds them onto every blood-containing compartment at build time, exposes setters to change them at runtime, and once per second samples representative compartments to publish arterial and venous blood gases. The acid-base / oxygenation chemistry itself lives in [`BloodComposition`](./BloodComposition.md); `Blood` only sets the inputs and reads the outputs.

## Inheritance

```
BaseModelClass
  └── Blood   (whole-blood property manager)
```

`Blood` extends `BaseModelClass` directly. It holds no volume or pressure of its own — it operates on the [`BloodCapacitance`](./BloodCapacitance.md)-family compartments via references collected at init.

## What it models

A single `Blood` instance per scenario represents the circulating blood as a whole:

- the **reference composition** every freshly-built blood compartment starts from,
- the **propagation path** that pushes `haldane_coeff` / `P50_0` (and, via setters, temperature, viscosity, gases and solutes) out to all blood compartments, and
- the **blood-gas read-outs** (pre-ductal arterial, post-ductal arterial, venous, mixed-venous) that the Monitor and UI display.

It does not move volume or compute pressure; flow mixing is done per-compartment in [`BloodCapacitance.volume_in`](./BloodCapacitance.md), gas exchange in the diffusors/exchangers, and metabolism in the metabolic models.

## Properties

### Configuration (set from the model definition / `init_model`)

| Property | Unit | Description |
|---|---|---|
| `viscosity` | cP | Reference blood viscosity (default 6.0) |
| `temp` | degC | Reference blood temperature (default 37.0) |
| `to2` | mmol/L | Reference total O₂ concentration seeded into compartments |
| `tco2` | mmol/L | Reference total CO₂ concentration seeded into compartments |
| `solutes` | object | Reference circulating solute set (Na, K, Ca, Mg, Cl, lactate, albumin, phosphates, uma, hemoglobin, glucose, …) |
| `P50_0` | mmHg | O₂–Hb affinity baseline (pO₂ at 50% saturation): fetal HbF ≈ 18.8, neonatal 20.0, adult 26.7 (default 20.0) |
| `haldane_coeff` | unitless | Haldane-effect strength propagated to every compartment; `0` disables it (default 1.0) |
| `blood_containing_modeltypes` | array | Model types treated as blood compartments: `BloodVessel`, `HeartChamber`, `BloodCapacitance`, `BloodTimeVaryingElastance`, `BloodPump`, `MicroVascularUnit` |

### Computed / published (dependent)

| Property | Unit | Description |
|---|---|---|
| `preductal_art_bloodgas` | object | `{ph, pco2, po2, hco3, be, so2}` sampled from the ascending aorta `AA` |
| `art_bloodgas` | object | Post-ductal arterial blood gas sampled from the descending aorta `AD` |
| `ven_bloodgas` | object | Venous read-out (declared on the model; venous solves run on `IVCI`/`SVC`/`RAIVCI`) |
| `art_solutes` | object | Snapshot of `AD.solutes` (arterial solute concentrations) |

### Local references (`_`-prefixed)

| Property | Description |
|---|---|
| `_update_interval` | Sampling period for `calc_model` (1.0 s) |
| `_update_counter` | Time accumulator toward `_update_interval` |
| `_ascending_aorta` | Reference to `model.models["AA"]` (pre-ductal site) |
| `_descending_aorta` | Reference to `model.models["AD"]` (post-ductal site) |
| `_blood_components` | Array of every blood-containing compartment, collected at init |

## Build-time bootstrap (`init_model`)

After applying the definition args, `init_model` walks `model.models` and, for every model whose `model_type` is in `blood_containing_modeltypes`:

1. pushes it onto `_blood_components`,
2. propagates `model.haldane_coeff = this.haldane_coeff`,
3. sets `model.P50_0 = this.P50_0` **only if the compartment has no `P50_0` of its own** (`model.P50_0 === undefined`) — a maternal pool kept at adult affinity therefore survives,
4. **only for freshly-constructed compartments** (`Object.keys(model.solutes).length === 0`) copies the reference composition: `to2`, `tco2`, a shallow clone of `solutes`, `temp`, `viscosity`.

The empty-solutes guard (rather than a `to2 == 0 && tco2 == 0` proxy) is deliberate: a restored / loaded saved state already carries per-compartment composition, and that composition is preserved even when a compartment legitimately has `to2 == 0`. Finally it caches the `AA`/`AD` references and sets `art_solutes = {...this.solutes}`.

## Publishing blood gases (`calc_model`)

`calc_model` accumulates `_t` into `_update_counter` and only acts once `_update_counter >= _update_interval` (1.0 s), then resets the counter. On each tick it calls `calc_blood_composition` (see [BloodComposition](./BloodComposition.md)) on selected compartments and copies the results:

- **`AA`** → `preductal_art_bloodgas`
- **`AD`** → `art_bloodgas`, and `art_solutes = {...AD.solutes}`
- **`IVCI`** and **`SVC`** → venous solve (composition updated in place)
- **`RAIVCI`** (if present) → mixed-venous solve. The Monitor reads SvO₂ from `RAIVCI`, so its composition must be solved here or `so2` stays at the `-1` sentinel.

## Runtime setters

Each setter updates the reference value on `Blood` and/or pushes a value out to the compartments. Those that accept a `bc_site` apply to a single named compartment when one is given, otherwise to every compartment in `_blood_components`.

| Setter | Effect |
|---|---|
| `set_temperature(temp, bc_site = "")` | Sets `temp` on all compartments (or one site); updates `this.temp` |
| `set_viscosity(viscosity)` | Sets `viscosity` on all compartments; updates `this.viscosity` |
| `set_haldane_coeff(coeff)` | Sets `haldane_coeff` on all compartments; updates `this.haldane_coeff` |
| `set_P50(p50)` | Sets `P50_0` on all compartments; updates `this.P50_0` (pick the dissociation curve, e.g. fetal vs adult) |
| `set_to2(to2, bc_site = "")` | Sets `to2` on all compartments (or one site) |
| `set_tco2(tco2, bc_site = "")` | Sets `tco2` on all compartments (or one site) |
| `set_solute(solute, value, bc_site = "")` | Sets one solute on a named site; or (no site) sets it on every compartment **and** on the reference `this.solutes` |

Note: `set_temperature`, `set_viscosity`, `set_haldane_coeff`, `set_P50` and `set_solute` (no site) write back to the matching reference property; `set_to2` / `set_tco2` (no site) push to the compartments only and do **not** update `this.to2` / `this.tco2`.

## Example definition (JSON)

From `term_neonate.json` (`model_definition.models.Blood`):

```json
{
  "name": "Blood",
  "description": "blood composition model",
  "is_enabled": true,
  "model_type": "Blood",
  "viscosity": 6,
  "temp": 37.0,
  "to2": 7,
  "tco2": 25.5,
  "solutes": {
    "na": 138, "k": 3.5, "ca": 1, "cl": 106, "lact": 1, "mg": 0.75,
    "albumin": 25, "phosphates": 1.64, "uma": 6, "hemoglobin": 10, "glucose": 4
  },
  "P50_0": 20,
  "haldane_coeff": 1
}
```

`hemoglobin` is carried in `solutes` in **mmol/L** (the solver converts to g/dL internally). The `preductal_art_bloodgas` / `art_bloodgas` / `ven_bloodgas` / `art_solutes` objects also appear in a saved scenario, but they are computed outputs, not inputs.

## Usage in the model

- Exactly one `Blood` instance per scenario. It must be built after the compartments exist so `_blood_components`, `AA` and `AD` resolve.
- The reference `to2`/`tco2`/`solutes` are **seeds only**; after build the simulation tracks per-compartment values updated by flow mixing ([BloodCapacitance](./BloodCapacitance.md)), diffusion ([BloodDiffusor](./BloodDiffusor.md)) and metabolism.
- `set_P50` / `set_haldane_coeff` are the levers for selecting a dissociation curve (fetal vs neonatal vs adult) and tuning the arterio-venous CO₂ behaviour respectively.
</content>

````

### FILE: explain-engine/docs/BloodCapacitance.md

````markdown
# BloodCapacitance

A BloodCapacitance is a volume compartment that holds blood with tracked composition: dissolved gases, solutes, drugs, temperature, and viscosity. It extends the base `Capacitance` class with blood-specific mixing logic.

## Inheritance

```
BaseModelClass
  └── Capacitance            (volume, elastance, pressure)
        └── BloodCapacitance (blood composition tracking)
```

BloodCapacitance is itself the parent of `BloodVessel` (adds resistance and flow) and is used standalone for compartments that hold blood but have no built-in resistance (e.g., a pure compliance chamber). Flow into and out of a standalone BloodCapacitance is handled by separate `Resistor` models that reference it.

## What it models

A passive blood-containing compartment. It holds a volume of blood at a pressure determined by its elastance, and tracks the composition of that blood as fluid flows in and out. It does not have its own resistance or flow -- those are provided by connected `Resistor` or `BloodVessel` models.

## Properties

### Inherited from Capacitance

All capacitance properties are available. See the Capacitance base model for the full list. Key ones:

| Property | Unit | Description |
|---|---|---|
| `u_vol` | L | Unstressed volume |
| `el_base` | mmHg/L | Baseline elastance |
| `el_k` | unitless | Non-linear elastance coefficient |
| `vol` | L | Current volume |
| `pres` | mmHg | Total pressure |
| `pres_in` | mmHg | Recoil pressure |
| `pres_tm` | mmHg | Transmural pressure |

### Blood composition (unique to BloodCapacitance)

| Property | Unit | Description |
|---|---|---|
| `temp` | degC | Blood temperature |
| `viscosity` | cP | Blood viscosity |
| `to2` | mmol/L | Total oxygen concentration |
| `tco2` | mmol/L | Total carbon dioxide concentration |
| `ph` | unitless | Blood pH (-1 = not calculated) |
| `pco2` | mmHg | Partial pressure of CO2 (-1 = not calculated) |
| `po2` | mmHg | Partial pressure of O2 (-1 = not calculated) |
| `so2` | unitless | Oxygen saturation (-1 = not calculated) |
| `hco3` | mmol/L | Bicarbonate concentration (-1 = not calculated) |
| `be` | mmol/L | Base excess (-1 = not calculated) |
| `solutes` | object | Dictionary of solute concentrations (keyed by name) |
| `drugs` | object | Dictionary of drug concentrations (keyed by name) |

Note: `ph`, `pco2`, `po2`, `so2`, `hco3`, and `be` are initialized to -1 and are calculated by external gas exchange models (e.g., `AcidBase`). They are not computed by the BloodCapacitance itself.

### Haldane effect

`calc_blood_composition` (in `BloodComposition.js`) couples oxygen saturation back into the CO2
dissociation. The plasma CO2 partition gains an SO₂-dependent term:

```
cco2p = tco2 / (1 + kc/hp + kc*kd/hp² + haldane_coeff * (1 - so2))
pco2  = cco2p / alpha_co2p
```

Lower SO₂ raises the effective CO2-carrying capacity, so at a given `tco2` deoxygenated blood shows a
lower `pco2`/`hco3` — the Haldane effect. `so2` is taken from the previous calculation step (the
acid-base and oxygen solvers run sequentially); at steady state the one-step lag vanishes. The
strength is set by `haldane_coeff` on the `Blood` model (propagated to every blood component and
adjustable at runtime via `Blood.set_haldane_coeff`); `haldane_coeff = 0` disables the effect and
reproduces the previous behaviour. Note this is distinct from the **CO₂-Bohr effect** (high pCO₂
right-shifts P50, reducing O₂ affinity), which is modelled separately via the `dpCO2` term.

## Mixing logic (`volume_in`)

BloodCapacitance overrides the `volume_in` method to perform composition mixing when blood flows in from another compartment. For each tracked substance, the mixing uses a linear dilution formula:

```
concentration += ((concentration_from - concentration) * dvol) / vol
```

This is applied to:
- `to2` and `tco2` (dissolved gases)
- All entries in `solutes`
- All entries in `drugs`
- `temp` (temperature treated as a solute for mixing)
- `viscosity` (treated as a solute for mixing)

The `comp_from` parameter (the upstream compartment) must have matching properties (`to2`, `tco2`, `solutes`, `drugs`, `temp`, `viscosity`).

## Three-tier factor system

BloodCapacitance inherits the full three-tier factor system from Capacitance:

| Tier | Factors | Purpose |
|---|---|---|
| Non-persistent | `u_vol_factor`, `el_base_factor`, `el_k_factor` | Transient effects, reset each step |
| Persistent (`_ps`) | `u_vol_factor_ps`, `el_base_factor_ps`, `el_k_factor_ps` | Ongoing physiological modulation |
| Scaling (`_scaling_ps`) | `u_vol_factor_scaling_ps`, `el_base_factor_scaling_ps`, `el_k_factor_scaling_ps` | ModelScaler weight/manual scaling |

## Calculation cycle

BloodCapacitance does not override `calc_model()` -- it inherits the Capacitance cycle:

1. `calc_elastances()` -- compute effective elastance from base + all factor tiers
2. `calc_volumes()` -- compute effective unstressed volume from base + all factor tiers
3. `calc_pressure()` -- compute recoil, transmural, and total pressure

## Example definition (JSON)

```json
{
  "name": "PV",
  "description": "pulmonary veins",
  "model_type": "BloodCapacitance",
  "is_enabled": true,
  "vol": 0.04,
  "u_vol": 0.038,
  "el_base": 3100,
  "el_k": 0,
  "fixed_composition": false
}
```

## Usage in the model

- Used for compartments that are pure compliances (no built-in resistance), such as specific pooling volumes
- Serves as the parent class for `BloodVessel`, which adds resistance, flow, and ANS coupling

````

### FILE: explain-engine/docs/BloodComposition.md

````markdown
# BloodComposition

`BloodComposition.js` is **not a model class** — it is a module that exports the function **`calc_blood_composition(bc)`**, the acid-base and blood-gas solver for the engine. Given a blood compartment's total dissolved-gas contents (`to2`, `tco2`), its solutes and temperature, it computes pH, pCO₂, pO₂, SO₂, HCO₃⁻ and base excess and writes them back onto the compartment. It is invoked by [`Blood`](./Blood.md), by [`BloodDiffusor`](./BloodDiffusor.md) and the gas exchangers, and by any read-out (Monitor, ANS chemoreceptors, ECLS) that needs partial pressures.

## Inheritance

```
(module function — not a class)

  calc_blood_composition(bc)                      ← exported entry point + result cache
    └── _calc_blood_composition_js(bc)            ← the solve
          ├── _brent_root_finding(_net_charge_plasma, …)   acid-base (H⁺)
          │     └── _net_charge_plasma(hp)        Stewart charge balance + CO₂ partition
          └── _brent_root_finding(_do2_content, …)         oxygenation (pO₂)
                ├── _do2_content(po2)             O₂ content residual
                └── _calc_so2(po2)                Hill saturation
```

These are plain module-scoped functions. The constants, independent variables and state variables (`ph`, `po2`, `so2`, `pco2`, `hco3`, `be`, `P50`, …) are **module-level `let`/`const` globals**, reused across every call — the solver is single-threaded and stateful per call, not re-entrant. Results are returned by mutating the passed-in compartment object `bc`.

## What it models

Two coupled physiological solves, each implemented as a Brent root-find:

1. **Acid-base** — a Stewart strong-ion / charge-balance model. Total CO₂ is partitioned into dissolved CO₂, bicarbonate and carbonate via the carbonic-acid equilibria; albumin and phosphate provide non-bicarbonate buffering. The solver finds the plasma H⁺ that makes net charge zero, yielding pH, pCO₂, HCO₃⁻ and base excess.
2. **Oxygenation** — an O₂–haemoglobin dissociation model (Hill equation) with a P50 that is right/left-shifted by pH (Bohr), pCO₂ (carbamino CO₂-Bohr), temperature and 2,3-DPG. The solver finds the pO₂ whose total O₂ content (Hb-bound + dissolved) matches the compartment's `to2`; SO₂ falls out of the Hill equation.

The two solves are coupled through the **Haldane effect** (O₂ saturation → CO₂ carrying capacity) and the **CO₂-Bohr effect** (pCO₂ → O₂ affinity).

## Inputs and outputs

Read from the compartment `bc`:

| Input | Source | Description |
|---|---|---|
| `bc.to2` | mmol/L | Total O₂ concentration (target for the O₂ solve) |
| `bc.tco2` | mmol/L | Total CO₂ concentration (input to the acid-base solve) |
| `bc.temp` | degC | Temperature (CO₂ solubility, P50 shift) |
| `bc.solutes.na/k/ca/mg/cl/lact` | mmol/L | Strong ions → SID |
| `bc.solutes.albumin/phosphates/uma` | — | Non-bicarbonate buffers / unmeasured anions |
| `bc.solutes.hemoglobin` | mmol/L | Haemoglobin (converted to g/dL via `/0.6206`) |
| `bc.P50_0` | mmHg | O₂–Hb affinity baseline (falls back to 20.0) |
| `bc.haldane_coeff` | unitless | Haldane strength (falls back to `DEFAULT_HALDANE_COEFF = 1.0`) |
| `bc.so2` | % | **Previous-step** SO₂ used for the Haldane term (falls back to 0.98 fraction) |
| `bc.prev_ph`, `bc.prev_po2` | — | Previous results used to set narrow root-find brackets |

Written back to the compartment `bc`:

| Output | Unit | Description |
|---|---|---|
| `bc.ph` | — | Plasma pH |
| `bc.pco2` | mmHg | Partial pressure of CO₂ |
| `bc.hco3` | mmol/L | Bicarbonate |
| `bc.be` | mmol/L | Base excess |
| `bc.po2` | mmHg | Partial pressure of O₂ |
| `bc.so2` | % | O₂ saturation |
| `bc.prev_po2` | mmHg | Updated to the solved pO₂ (next-call bracket seed) |

## Constants

| Constant | Value | Meaning |
|---|---|---|
| `kw` | 2.5119e-11 | Water dissociation constant |
| `kc` | 7.94328235e-4 | Carbonic-acid dissociation constant |
| `kd` | 6.0255959e-8 | Bicarbonate dissociation constant |
| `alpha_co2p` | 0.03067 | CO₂ solubility coefficient |
| `n` | 2.7 | Hill coefficient |
| `alpha_o2` | 1.38e-5 | O₂ solubility coefficient (declared) |
| `gas_constant` | 62.36367 | For the mmol/L → mL conversion factor |
| `left_hp_wide` / `right_hp_wide` | 5.85e-6 / 3.16e-4 | Wide H⁺ brackets (mmol/L) |
| `left_o2_wide` / `right_o2_wide` | 0 / 800.0 | Wide pO₂ brackets (mmHg) |
| `delta_ph_limits` | 0.1 | ± window for the narrow pH bracket |
| `delta_o2_limits` | 10.0 | ± window for the narrow pO₂ bracket |
| `brent_accuracy` | 1e-6 | Root-find tolerance |
| `max_iterations` | 60 | Root-find iteration cap |
| `DEFAULT_HALDANE_COEFF` | 1.0 | Haldane fallback when `bc.haldane_coeff` is undefined |

## Result cache (`calc_blood_composition`)

The exported wrapper memoises the last solve per compartment. It stores `_bc_prev_*` snapshots of `tco2`, `to2`, `temp`, `prev_ph`, `prev_po2`, the strong ions, buffers, haemoglobin and `model_time_total` on `bc`. If every cached input matches the current values (and the step stamp matches, when defined), it returns immediately without re-solving. Otherwise it calls `_calc_blood_composition_js(bc)` and refreshes the cache. This is what makes it cheap to call `calc_blood_composition` from many places each second.

## Acid-base solve (Stewart / charge balance)

`_calc_blood_composition_js` computes the **strong ion difference**:

```
SID = Na + K + 2·Ca + 2·Mg − Cl − lactate
```

then brackets H⁺. If `prev_ph > 0` the brackets are tightened to `10^−(prev_ph ± 0.1)·1000`; the narrow solve is retried with the wide brackets if it fails. `_brent_root_finding` solves `_net_charge_plasma(H⁺) = 0`:

```
cco2p = tco2 / (1 + kc/H + kc·kd/H² + haldane_coeff·(1 − SO₂_prev))
hco3  = kc · cco2p / H
co3p  = kd · hco3 / H
ohp   = kw / H
pco2  = cco2p / alpha_co2p
a_base = albumin·(0.123·pH − 0.631) + phosphates·(0.309·pH − 0.469)

net charge = H + SID − hco3 − 2·co3p − ohp − a_base − uma
```

The `haldane_coeff·(1 − SO₂_prev)` term in the CO₂ partition is the **Haldane effect**: as saturation falls it raises the effective CO₂-carrying capacity, lowering dissolved CO₂ (hence `pco2`/`hco3`) at a given `tco2`. It uses the *previous-step* SO₂ (`bc.so2/100`, default 0.98) to break the O₂↔CO₂ coupling; at steady state `SO₂_prev == SO₂` so the one-step lag vanishes. `haldane_coeff = 0` disables it.

Once H⁺ is found, base excess is:

```
be = (hco3 − 25.1 + (2.3·Hb + 7.7)·(pH − 7.4)) · (1 − 0.023·Hb)
```

and `ph`, `pco2`, `hco3`, `be` are written to `bc`.

## P50 shift (Bohr / CO₂-Bohr / temperature / DPG)

Before the O₂ solve, P50 is shifted from its baseline `P50_0`:

```
ΔpH   = ph − 7.40        (Bohr)
ΔpCO2 = pco2 − 40.0       (carbamino CO₂-Bohr)
ΔT    = temp − 37.0
ΔDPG  = dpg − 5.0

log10(P50) = log10(P50_0) − 0.48·ΔpH + 0.0015·ΔpCO2 + 0.024·ΔT + 0.051·ΔDPG
P50   = 10^log10(P50)
P50_n = P50^n
```

`dpg` is a module variable fixed at 5.0 (no DPG input is wired in, so `ΔDPG = 0` in practice). The `0.0015·ΔpCO2` term is the carbamino-specific CO₂-Bohr coefficient; the pH-mediated part of the CO₂ effect already runs through `−0.48·ΔpH`.

## Oxygen solve (Hill + dissolved O₂)

A second Brent solve finds the pO₂ whose O₂ content matches `to2`. Brackets are `prev_po2 ± 10` when available (retried wide on failure). `_do2_content(po2)` returns the residual `to2 − to2_estimate`, where:

```
SO₂        = po2^n / (po2^n + P50_n)                       (Hill, _calc_so2)
to2_est    = (0.0031·po2 + 1.36·Hb_gdl·SO₂) · 10           (mL O₂ per L blood)
to2_est    = to2_est · inv_mmol_to_ml                      (→ mmol/L)
```

with `Hb_gdl = hemoglobin / 0.6206` and `inv_mmol_to_ml = 760 / (gas_constant·(273.15 + temp))`. On success `bc.po2`, `bc.so2 = so2·100`, and `bc.prev_po2` are written. The Hill SO₂ uses the shifted `P50_n`, so the Bohr/CO₂-Bohr/temperature shifts feed directly into saturation.

## Root finder (`_brent_root_finding`)

A standard Brent solver combining inverse quadratic interpolation, the secant method and bisection fallback, capped at `max_iterations` with `brent_accuracy` tolerance. It returns `-1` if the bracket does not straddle a root (`f(x0)·f(x1) > 0`) or if it fails to converge — which is why both the acid-base and O₂ solves fall back from narrow to wide brackets and log a failure if even the wide bracket fails.

## Notes & caveats

- **Two distinct CO₂↔O₂ couplings.** The CO₂→O₂-affinity term (`ΔpCO2`, "CO₂-Bohr") shifts P50; the **Haldane effect** (SO₂→CO₂ capacity) is the separate term in the CO₂ partition. Don't conflate them.
- **One-step lag.** Because the Haldane term reads the previous SO₂, and the acid-base solve runs before the O₂ solve within a call, the coupling is explicit (lagged), not simultaneous. It converges at steady state.
- The module-level state variables make the solver **non-re-entrant** — it must not be called concurrently for two compartments.
- See [Blood.md](./Blood.md) for how the inputs are seeded and the outputs published, and [BloodCapacitance.md](./BloodCapacitance.md) for the compartment that carries the values.
</content>

````

### FILE: explain-engine/docs/BloodDiffusor.md

````markdown
# BloodDiffusor

A `BloodDiffusor` exchanges gases and solutes between **two blood compartments**. It is used wherever blood equilibrates with blood across a membrane rather than with a gas phase — most notably the placenta (fetal capillary ↔ maternal pool). O₂ and CO₂ move down their **partial-pressure** gradients; each configured solute moves down its **concentration** gradient.

## Inheritance

```
BaseModelClass
  └── BloodDiffusor   (blood↔blood gas/solute exchange)
```

`BloodDiffusor` extends `BaseModelClass` directly (note: the source lives in `base_models/`, not `component_models/`). It is not a capacitance — it holds no volume and computes no pressure; it only mutates the composition of the two compartments it references.

## What it models

```
blood1 (po2, pco2, solutes)  ⇌[BloodDiffusor]⇌  blood2 (po2, pco2, solutes)
   gases:   flux = (p1 − p2) · dif_step · Δt        (partial-pressure driven)
   solutes: flux = (c1 − c2) · dif · solutes_step · Δt   (concentration driven)
```

Each step it refreshes both compartments' blood composition (so the partial pressures are current), composes the effective diffusion constants from the factor tiers, then transfers O₂, CO₂ and each configured solute from the higher to the lower side, conserving mass.

## Properties

### Configuration

| Property | Unit | Description |
|---|---|---|
| `comp_blood1` | name | First blood compartment (default `"PLF"`) |
| `comp_blood2` | name | Second blood compartment (default `"PLM"`) |
| `dif_o2` | mmol/(mmHg·s) | O₂ diffusion constant |
| `dif_co2` | mmol/(mmHg·s) | CO₂ diffusion constant |
| `dif_solutes` | object | Per-solute diffusion constants, keyed by solute name (mmol/(mmol·s)) |

### Factor tiers (see below)

`dif_o2_factor`, `dif_o2_factor_ps`, `dif_o2_factor_scaling`; `dif_co2_factor`, `dif_co2_factor_ps`, `dif_co2_factor_scaling`; `dif_solutes_factor`, `dif_solutes_factor_ps`, `dif_solutes_factor_scaling` — all default `1.0`.

### Computed / dependent

| Property | Unit | Description |
|---|---|---|
| `dif_o2_step` | mmol/(mmHg·s) | Effective O₂ diffusion constant for the current step |
| `dif_co2_step` | mmol/(mmHg·s) | Effective CO₂ diffusion constant for the current step |

### Local references (`_`-prefixed)

`_comp_blood1`, `_comp_blood2` — resolved each step from `model.models[comp_blood1/2]`.

## Factor system

`dif_o2`, `dif_co2` and the per-solute `dif_solutes` follow the engine's three-tier factor / effective-value pattern (same convention as [Capacitance](./Capacitance.md)). For O₂ and CO₂ the effective constant is built additively against the base:

```
dif_o2_step = dif_o2
            + (dif_o2_factor       − 1)·dif_o2
            + (dif_o2_factor_ps    − 1)·dif_o2
            + (dif_o2_factor_scaling − 1)·dif_o2
```

(identically for `dif_co2_step`). Solutes share one dimensionless multiplier applied to every per-solute constant:

```
solutes_step = 1 + (dif_solutes_factor − 1) + (dif_solutes_factor_ps − 1) + (dif_solutes_factor_scaling − 1)
```

| Tier | Factors | Purpose |
|---|---|---|
| Non-persistent | `dif_o2_factor`, `dif_co2_factor`, `dif_solutes_factor` | Transient interventions; **reset to 1.0 at the end of every `calc_model`** |
| Persistent (`_ps`) | `dif_o2_factor_ps`, `dif_co2_factor_ps`, `dif_solutes_factor_ps` | Ongoing scenario/user modulation; persist across steps |
| Scaling | `dif_o2_factor_scaling`, `dif_co2_factor_scaling`, `dif_solutes_factor_scaling` | ModelScaler weight/manual scaling |

## Calculation cycle (`calc_model`)

1. Resolve `_comp_blood1` / `_comp_blood2` from the engine map.
2. Call [`calc_blood_composition`](./BloodComposition.md) on both compartments so `po2`/`pco2`/solute concentrations are current.
3. Compose `dif_o2_step`, `dif_co2_step` and `solutes_step` from the factors.
4. **O₂:** `do2 = (blood1.po2 − blood2.po2) · dif_o2_step · _t`, then update each side's `to2` by `(to2·vol ∓ do2)/vol`.
5. **CO₂:** same with `pco2` / `dif_co2_step` → `tco2`.
6. **Solutes:** for each key in `dif_solutes`, `dsol = (c1 − c2) · dif_solutes[sol] · solutes_step · _t`, update each side's concentration.
7. Reset the non-persistent factors (`dif_o2_factor`, `dif_co2_factor`, `dif_solutes_factor`) to `1.0`.

`_t` is the modeling stepsize. Every write is **guarded by `!fixed_composition && vol > 0`**, so a fixed reservoir (e.g. the maternal pool) supplies/absorbs gas and solute without changing its own composition, and an empty compartment never divides by zero.

## Example definition (JSON)

From `term_fetus.json` — `PL_GASEX`, a component of the `Placenta` model, connecting the fetal capillary to the fixed maternal pool:

```json
{
  "name": "PL_GASEX",
  "description": "blood diffusor model of the diffusion across the placenta",
  "is_enabled": true,
  "model_type": "BloodDiffusor",
  "comp_blood1": "PL_FETAL_CAP",
  "comp_blood2": "PL_MAT",
  "dif_o2": 0.03,
  "dif_co2": 0.04,
  "dif_solutes": {},
  "dif_o2_factor": 1,
  "dif_co2_factor": 1,
  "dif_solutes_factor": 1,
  "dif_o2_factor_ps": 1,
  "dif_co2_factor_ps": 1,
  "dif_solutes_factor_ps": 1,
  "dif_o2_factor_scaling": 1,
  "dif_co2_factor_scaling": 1,
  "dif_solutes_factor_scaling": 1
}
```

Here `PL_MAT` carries `fixed_composition: true`, so the diffusor drives fetal gases toward the maternal set-point while the maternal pool stays constant.

## Usage in the model

- The placenta's `PL_GASEX` is the canonical instance: it connects the fetal capillary to the fixed maternal pool, equilibrating fetal blood gases toward maternal values.
- This is the reference implementation the other exchangers follow — it already guards `fixed_composition` on every write, which is why the maternal pool stays constant.
- Gases use **partial pressures** (so they respect the dissociation curves computed by [BloodComposition](./BloodComposition.md)), while solutes use **raw concentrations**.
- The compartments referenced must be [BloodCapacitance](./BloodCapacitance.md)-family models carrying `to2`/`tco2`/`solutes`/`vol`/`fixed_composition`.
</content>

````

### FILE: explain-engine/docs/BloodPump.md

````markdown
# BloodPump

A `BloodPump` is a [`BloodCapacitance`](./BloodCapacitance.md) that adds a mechanical pump. It inherits all blood-volume and composition behaviour and overrides `calc_pressure` to generate a pump pressure proportional to RPM, which it applies as an external pressure on its inlet or outlet [Resistor](./Resistor.md) to drive flow — modelling a centrifugal or roller pump.

## Inheritance

```
BaseModelClass
  └── Capacitance
        └── BloodCapacitance       (blood volume + composition mixing)
              └── BloodPump        (adds pump pressure)
```

It inherits the full capacitance cycle, the blood-composition mixing in [`BloodCapacitance.volume_in`](./BloodCapacitance.md), and the `fixed_composition` / empty-compartment guards. It overrides only `calc_pressure`.

## What it models

A pumped blood chamber. Its own recoil/transmural pressure is computed exactly as a `BloodCapacitance`, but in addition it imposes a **pump pressure** (negative, proportional to RPM) on a connected resistor. The negative external pressure creates the pressure gradient that moves blood through the resistor, i.e. the pump head.

## Properties

### Configuration (unique to BloodPump)

| Property | Unit | Description |
|---|---|---|
| `pump_rpm` | rpm | Pump speed (rotations per minute) |
| `pump_mode` | enum | `0` = centrifugal (drives the **inlet** resistor), `1` = roller (drives the **outlet** resistor) |
| `inlet` | name | Name of the inlet `BloodResistor` |
| `outlet` | name | Name of the outlet `BloodResistor` |
| `pres_cc` | mmHg | External pressure from chest compressions (reset to 0 each step) |
| `pres_mus` | mmHg | External muscle pressure (reset to 0 each step) |

Plus the inherited capacitance configuration (`u_vol`, `el_base`, `el_k`, `pres_ext`, `fixed_composition`, …) and the [factor tiers](./BloodCapacitance.md).

### Computed / dependent

| Property | Unit | Description |
|---|---|---|
| `pump_pressure` | mmHg | Pump head = `−pump_rpm / 25` |
| `pres_in` | mmHg | Recoil pressure |
| `pres_tm` | mmHg | Transmural pressure |
| `pres` | mmHg | Total pressure incl. external pressures |

### Local references (`_`-prefixed)

`_inlet`, `_outlet` — resolved each step from `model.models[inlet/outlet]`.

## Pump pressure (`calc_pressure`)

`BloodPump` overrides `calc_pressure` (it does not override `calc_model`, so it inherits the elastance/volume steps from Capacitance):

```
pres_in = el_k_eff·(vol − u_vol_eff)² + el_eff·(vol − u_vol_eff)
pres_tm = pres_in − pres_ext
pres    = pres_in + pres_ext + pres_cc + pres_mus
                                                  # then pres_ext, pres_cc, pres_mus reset to 0

pump_pressure = −pump_rpm / 25
centrifugal (pump_mode 0):  inlet.p1_ext  = 0;  inlet.p2_ext  = pump_pressure
roller      (pump_mode 1):  outlet.p1_ext = pump_pressure;  outlet.p2_ext = 0
```

The connector writes are **null-guarded** (`if (this._inlet)` / `if (this._outlet)`) so an unwired pump does not crash. The negative pump pressure on the resistor's external inlet/outlet pressure is what produces the driving gradient.

## Status

> ⚠️ **Currently unused.** No scenario instantiates a `BloodPump`. The ECLS pump (`ECLS_PUMP`) is a [`BloodVessel`](./BloodVessel.md) driven directly by the [`Ecls`](./Ecls.md) device, which duplicates this pump-pressure logic. The class is registered (exported in `ModelIndex.js`) and UI-exposed, and was made defensively correct — it declares `pres_cc`/`pres_mus`/`inlet`/`outlet`, null-guards the connectors and computes `pres_tm` — so it will not crash or produce `NaN` if instantiated, but it is legacy/standby code.

## Example definition (JSON)

No scenario contains a `BloodPump`, so the following is **illustrative** (the inherited capacitance fields plus the pump-specific fields):

```json
{
  "name": "PUMP",
  "description": "blood pump",
  "model_type": "BloodPump",
  "is_enabled": true,
  "vol": 0.05,
  "u_vol": 0.05,
  "el_base": 5000,
  "el_k": 0,
  "fixed_composition": false,
  "pump_rpm": 3000,
  "pump_mode": 0,
  "inlet": "PUMP_IN",
  "outlet": "PUMP_OUT"
}
```

## Usage in the model

- Intended for an extracorporeal pump chamber wired between an inlet and outlet `BloodResistor`.
- In practice the live ECLS circuit does not use it — see [Ecls](./Ecls.md). Prefer that path for new extracorporeal work unless this class is brought back into active use.
</content>

````

### FILE: explain-engine/docs/BloodTimeVaryingElastance.md

````markdown
# BloodTimeVaryingElastance

A BloodTimeVaryingElastance is a volume compartment with a time-varying elastance (cyclically changing stiffness) that holds blood with tracked composition. It is used for compartments that contract and relax cyclically but are not heart chambers -- for example, a pulsatile vessel segment driven by an external activation signal.

## Inheritance

```
BaseModelClass
  └── TimeVaryingElastance         (volume, time-varying elastance, pressure)
        └── BloodTimeVaryingElastance  (blood composition tracking)
```

## Relationship to HeartChamber

Both `BloodTimeVaryingElastance` and `HeartChamber` extend `TimeVaryingElastance`. The difference is that `HeartChamber` adds ANS-mediated modulation of contractility (el_max) and relaxation (el_min) via beta-adrenergic receptor modeling. `BloodTimeVaryingElastance` does not have ANS coupling -- it uses the parent's `calc_elastances()` directly.

## What it models

A compartment whose elastance varies over time between a minimum (`el_min`) and maximum (`el_max`) value, driven by an external activation factor (`act_factor`). This produces pulsatile pressure changes. The compartment also tracks blood composition (gases, solutes, drugs, temperature, viscosity) using the same mixing logic as `BloodCapacitance`.

## Properties

### Inherited from TimeVaryingElastance

| Property | Unit | Description |
|---|---|---|
| `u_vol` | L | Unstressed volume |
| `el_min` | mmHg/L | Minimum elastance (during relaxation/diastole) |
| `el_max` | mmHg/L | Maximum elastance (during contraction/systole) |
| `el_k` | unitless | Non-linear elastance coefficient |
| `act_factor` | 0-1 | Activation factor (set externally, e.g., by Heart model) |
| `vol` | L | Current volume |
| `pres` | mmHg | Total pressure |
| `pres_in` | mmHg | Recoil pressure |
| `pres_tm` | mmHg | Transmural pressure |
| `pres_ext` | mmHg | External pressure (non-persistent, resets each step) |

### Blood composition (unique to BloodTimeVaryingElastance)

| Property | Unit | Description |
|---|---|---|
| `temp` | degC | Blood temperature |
| `viscosity` | cP | Blood viscosity |
| `to2` | mmol/L | Total oxygen concentration |
| `tco2` | mmol/L | Total carbon dioxide concentration |
| `ph` | unitless | Blood pH (-1 = not calculated) |
| `pco2` | mmHg | Partial pressure of CO2 (-1 = not calculated) |
| `po2` | mmHg | Partial pressure of O2 (-1 = not calculated) |
| `so2` | unitless | Oxygen saturation (-1 = not calculated) |
| `hco3` | mmol/L | Bicarbonate concentration (-1 = not calculated) |
| `be` | mmol/L | Base excess (-1 = not calculated) |
| `solutes` | object | Dictionary of solute concentrations |
| `drugs` | object | Dictionary of drug concentrations |

### Calculated intermediates

| Property | Unit | Description |
|---|---|---|
| `el_min_eff` | mmHg/L | Effective minimum elastance this step (after all factors) |
| `el_max_eff` | mmHg/L | Effective maximum elastance this step |
| `el_k_eff` | unitless | Effective non-linear elastance coefficient |
| `u_vol_eff` | L | Effective unstressed volume |

## Three-tier factor system

| Tier | Factors | Purpose |
|---|---|---|
| Non-persistent | `u_vol_factor`, `el_min_factor`, `el_max_factor`, `el_k_factor` | Transient effects, reset each step |
| Persistent (`_ps`) | `u_vol_factor_ps`, `el_min_factor_ps`, `el_max_factor_ps`, `el_k_factor_ps` | Ongoing physiological modulation |
| Scaling (`_scaling_ps`) | `u_vol_factor_scaling_ps`, `el_min_factor_scaling_ps`, `el_max_factor_scaling_ps`, `el_k_factor_scaling_ps` | ModelScaler weight/manual scaling |

Each effective value is computed additively:

```
el_min_eff = el_min
  + (el_min_factor - 1) * el_min
  + (el_min_factor_ps - 1) * el_min
  + (el_min_factor_scaling_ps - 1) * el_min
```

Note: `el_max_eff` is clamped to never fall below `el_min_eff`.

## Pressure calculation

The time-varying elastance produces a pressure that interpolates between end-diastolic and maximum systolic pressure based on the activation factor:

```
p_ms = (vol - u_vol_eff) * el_max_eff
p_ed = el_k_eff * (vol - u_vol_eff)^2 + el_min_eff * (vol - u_vol_eff)
pres_in = (p_ms - p_ed) * act_factor + p_ed
```

When `act_factor = 0` (diastole), pressure equals `p_ed`. When `act_factor = 1` (peak systole), pressure equals `p_ms`.

## Mixing logic (`volume_in`)

Overrides `volume_in` to perform composition mixing when blood flows in, identical to `BloodCapacitance`:

```
concentration += ((concentration_from - concentration) * dvol) / vol
```

Applied to: `to2`, `tco2`, all `solutes`, all `drugs`, `temp`, `viscosity`.

## Calculation cycle

Inherits from `TimeVaryingElastance`:

1. `calc_elastances()` -- compute el_min_eff, el_max_eff, el_k_eff from base values + all factor tiers
2. `calc_volumes()` -- compute u_vol_eff from base + all factor tiers
3. `calc_pressure()` -- compute time-varying recoil pressure from activation factor

## Externally managed mode

When `is_externally_managed = true`, all three tiers of factors are reset to 1.0 every step. The parent model sets base properties directly.

## Example definition (JSON)

```json
{
  "name": "COR",
  "description": "coronary circulation",
  "model_type": "BloodTimeVaryingElastance",
  "is_enabled": true,
  "vol": 0.005,
  "u_vol": 0.004,
  "el_min": 5000,
  "el_max": 15000,
  "el_k": 0
}
```

## Usage in the model

- Used for compartments that exhibit pulsatile behavior driven by an external activation signal but do not need the ANS-mediated contractility/relaxation modulation of HeartChamber
- The coronary circulation (COR) is a typical example -- it is compressed during systole by ventricular contraction via the `act_factor` set by the Heart model

````

### FILE: explain-engine/docs/BloodVessel.md

````markdown
# BloodVessel

A BloodVessel represents a blood vessel segment in the circulatory model. It combines a volume compartment (capacitance) with flow resistance and supports autonomic nervous system (ANS) regulation.

## Inheritance

```
BaseModelClass
  └── Capacitance          (volume, elastance, pressure)
        └── BloodCapacitance   (blood composition: O2, CO2, solutes, drugs, temperature)
              └── BloodVessel  (resistance, flow, ANS coupling)
```

## What it models

A BloodVessel is both a **capacitance** (it holds a volume of blood at a certain pressure) and a **resistance** (blood flows through it with a pressure drop). Each BloodVessel creates one or more internal `Resistor` objects based on its `inputs` list. These resistors handle the actual flow calculations between upstream components and this vessel.

When the ANS changes vascular tone, the vessel's resistance **and** elastance change simultaneously. This coupling is governed by the `alpha` parameter and is a distinguishing feature of the Explain model.

## Initialization

During `init_model()`, the BloodVessel creates a `Resistor` instance for each entry in its `inputs` array. Each resistor is named `{inputName}_{vesselName}` (e.g., `AA_AD1`) and is registered in the model engine. These resistors are marked as `is_externally_managed = true`, meaning the BloodVessel controls their properties directly -- the resistors do not apply their own factors.

If a resistor already exists in the model engine (e.g., when loading from a saved state), the existing instance is reused.

## Calculation cycle (`calc_model`)

Each model step executes in this order:

1. **`calc_resistances()`** -- compute effective forward, backward, and non-linear resistances
2. **`calc_elastances()`** -- compute effective elastance with ANS and resistance-elastance coupling
3. **Update resistors** -- push the calculated values to all internal `Resistor` objects
4. **`calc_volumes()`** -- compute effective unstressed volume (inherited from Capacitance)
5. **`calc_pressure()`** -- compute recoil, transmural, and total pressure (inherited from Capacitance)
7. **`get_flows()`** -- sum forward and backward flows from all internal resistors

## Properties

### Base properties (from definition JSON)

| Property | Unit | Description |
|---|---|---|
| `u_vol` | L | Unstressed volume -- the volume at which transmural pressure is zero |
| `el_base` | mmHg/L | Baseline elastance (stiffness). Higher = stiffer vessel |
| `el_k` | unitless | Non-linear elastance coefficient. Adds quadratic pressure term at high volumes |
| `r_for` | mmHg·s/L | Forward flow resistance |
| `r_back` | mmHg·s/L | Backward flow resistance |
| `r_k` | unitless | Non-linear resistance coefficient. Adds flow-dependent resistance |
| `inputs` | string[] | Names of upstream components (a Resistor is created for each) |
| `alpha` | 0-1 | Resistance-elastance coupling factor (see ANS section) |
| `ans_sens` | 0-1 | Sensitivity to ANS activity. 0 = no effect, 1 = full effect |
| `no_flow` | boolean | If true, all flow is blocked |
| `no_back_flow` | boolean | If true, backward flow is blocked (valve-like behavior) |

### Dependent properties (calculated each step)

| Property | Unit | Description |
|---|---|---|
| `vol` | L | Current blood volume in the vessel |
| `pres` | mmHg | Total pressure (recoil + external) |
| `pres_in` | mmHg | Recoil pressure from elastance |
| `pres_tm` | mmHg | Transmural pressure (recoil - external) |
| `flow` | L/s | Net flow (forward - backward) |
| `flow_forward` | L/s | Total forward flow across all input resistors |
| `flow_backward` | L/s | Total backward flow across all input resistors |

### Calculated intermediates (available for monitoring)

| Property | Unit | Description |
|---|---|---|
| `r_for_eff` | mmHg·s/L | Effective forward resistance this step (after all factors) |
| `r_back_eff` | mmHg·s/L | Effective backward resistance this step |
| `r_k_eff` | unitless | Effective non-linear resistance coefficient |
| `el_eff` | mmHg/L | Effective elastance (from Capacitance) |
| `u_vol_eff` | L | Effective unstressed volume (from Capacitance) |

## Three-tier factor system

Each physical property can be modulated by three independent factor tiers. All factors default to 1.0 (no change).

**Composition differs by property.** `BloodVessel` **overrides** `calc_resistances()` and `calc_elastances()`, so its resistance (`r_for`/`r_back`/`r_k`) and elastance (`el_base`/`el_k`) tiers compose **multiplicatively** (the product of the three factors, plus the ANS multiplier for `r`/`el`):

```
value_eff = base * factor * factor_ps * factor_scaling_ps   # r_for, r_back, r_k, el_base, el_k
```

Multiplicative composition lets simultaneous factors compound correctly: `r_factor = 2` with `r_factor_ps = 2` gives a true 4× rise, not the linearised 3× the additive form produces.

The unstressed volume `u_vol` is **not** overridden — it is computed by the inherited `Capacitance.calc_volumes()`, which is still **additive** (matching the base-class convention):

```
u_vol_eff = u_vol
  + (u_vol_factor - 1) * u_vol             # tier 1: non-persistent
  + (u_vol_factor_ps - 1) * u_vol          # tier 2: persistent
  + (u_vol_factor_scaling_ps - 1) * u_vol  # tier 3: scaling
```

### Tier 1: Non-persistent factors (reset every step)

| Factor | Affects |
|---|---|
| `el_base_factor` | `el_base` |
| `el_k_factor` | `el_k` |
| `u_vol_factor` | `u_vol` |
| `r_factor` | `r_for`, `r_back` |
| `r_k_factor` | `r_k` |

These are set by other models during a step (e.g., the breathing model applying intrathoracic pressure effects) and automatically reset to 1.0 after use (`r_factor`/`r_k_factor` in `calc_resistances`, `el_base_factor`/`el_k_factor` in `calc_elastances`, `u_vol_factor` in `calc_volumes`).

### Tier 2: Persistent factors (`_ps`)

| Factor | Affects |
|---|---|
| `el_base_factor_ps` | `el_base` |
| `el_k_factor_ps` | `el_k` |
| `u_vol_factor_ps` | `u_vol` |
| `r_factor_ps` | `r_for`, `r_back` |
| `r_k_factor_ps` | `r_k` |

These persist across steps and are used by controllers like the ANS or Heart model to apply ongoing physiological modulation.

### Tier 3: Scaling factors (`_scaling_ps`)

| Factor | Affects |
|---|---|
| `el_base_factor_scaling_ps` | `el_base` |
| `el_k_factor_scaling_ps` | `el_k` |
| `u_vol_factor_scaling_ps` | `u_vol` |
| `r_factor_scaling_ps` | `r_for`, `r_back` |
| `r_k_factor_scaling_ps` | `r_k` |

These are used exclusively by the `ModelScaler` for weight-based or manual scaling. Having a dedicated tier means scaling does not interfere with physiological factors in tier 2. (Note the `_scaling_ps` suffix — capacitance/resistor/elastance scaling factors all carry it; this differs from the diffusor/exchanger models, whose scaling factors are bare `*_factor_scaling`.)

## ANS and resistance-elastance coupling

The ANS influences both resistance and elastance, but through different pathways:

### Resistance

ANS modulates resistance directly, scaled by sensitivity. The ANS contribution is a sensitivity-weighted multiplier `ans_mult = 1 + (ans_activity - 1) * ans_sens`, composed multiplicatively with the three resistance-factor tiers:

```
ans_mult       = 1 + (ans_activity - 1) * ans_sens
r_total_factor = r_factor * r_factor_ps * r_factor_scaling_ps * ans_mult

r_for_eff = r_for * r_total_factor
r_back_eff = r_back * r_total_factor
```

`r_k` carries its own factor stack with the same ANS coupling: `r_k_eff = r_k · r_k_factor · r_k_factor_ps · r_k_factor_scaling_ps · ans_mult`. The combined `r_total_factor` is cached and reused by the elastance step (single source of truth for the α-coupling).

### Elastance (alpha coupling)

When a vessel constricts (resistance increases), its wall also becomes stiffer (elastance increases). The `alpha` parameter controls how strongly resistance changes translate into elastance changes via a power law applied **once** to the *combined* resistance multiplier `r_total_factor` (which already folds in the ANS contribution):

```
el_passive_mult = el_base_factor * el_base_factor_ps * el_base_factor_scaling_ps
el_geom_mult    = r_total_factor ^ alpha            # α-coupling to resistance

el_eff = el_base * el_passive_mult * el_geom_mult
```

`el_k` is **not** α-coupled — the non-linear stiffening term is treated as a structural property of the wall, so it carries only its own passive multipliers:

```
el_k_eff = el_k * el_k_factor * el_k_factor_ps * el_k_factor_scaling_ps
```

Typical alpha values:
- **Large arteries**: 0.5 (moderate coupling)
- **Arterioles**: 0.63 (stronger coupling)
- **Veins/venules**: 0.75 (strongest coupling)

An alpha of 0.0 means resistance changes have no effect on elastance.

## Externally managed mode

`is_externally_managed` is a flag (default `false`) read by an owning model to indicate that it controls this object directly. A `BloodVessel` sets it to `true` on every input `Resistor` it creates, then overwrites that resistor's `r_for`/`r_back`/`r_k` from its own effective values each step (so the resistor never applies its own factor stack). The same pattern is used when a `BloodVessel` is itself a sub-component of a parent model (typically a `MicroVascularUnit`): the parent sets the base properties (`el_base`, `r_for`, `r_back`, `u_vol`, etc.) directly each step, and the non-persistent tier-1 factors reset to 1.0 automatically — the parent is expected to leave the persistent (`_ps`) and scaling (`_scaling_ps`) tiers at 1.0 so its directly-set values are not double-modulated.

## Pressure calculation

Pressure is calculated by the inherited `Capacitance.calc_pressure()`:

```
pres_in = el_k_eff * (vol - u_vol_eff)^2 + el_eff * (vol - u_vol_eff)
pres_tm = pres_in - pres_ext
pres    = pres_in + pres_ext
```

Where `pres_ext` is a non-persistent external pressure (e.g., intrathoracic pressure) that resets to 0 each step.

## Example definition (JSON)

```json
{
  "name": "AD1",
  "description": "descending aorta segment 1",
  "model_type": "BloodVessel",
  "is_enabled": true,
  "vol": 0.02725,
  "u_vol": 0.02625,
  "el_base": 625,
  "el_k": 0,
  "r_for": 6.2,
  "r_back": 6.2,
  "r_k": 0,
  "inputs": ["AA"],
  "alpha": 0.5,
  "ans_sens": 0.0
}
```

## Usage in the model hierarchy

- **Standalone**: Used for large arteries (AA, AD1, AD2) and veins (IVCI, SVCI) that are directly defined in the model.
- **Inside MicroVascularUnit**: Three BloodVessels (ART, CAP, VEN) are created as sub-components. They are marked `is_externally_managed = true` and the MVU distributes properties across them.
- **Inside Heart (indirectly)**: Heart valves use standalone `Resistor` objects that connect HeartChamber components, not BloodVessels.

````

### FILE: explain-engine/docs/Brain.md

````markdown
# Brain (cerebral autoregulation + ICP)

The `Brain` model is the **neonatal cerebral haemodynamics controller** — it couples cerebral
blood-flow **autoregulation** with **intracranial pressure (ICP)** through the cerebral perfusion
pressure `CPP = MAP − ICP`. Like [`Kidneys`](./Kidneys.md) and [`Hormones`](./Hormones.md) it is a
**controller/process model**: it holds no blood, resolves references to other models lazily, runs on
an update interval, and **owns its effector channels while enabled** (releasing them once on
disable). Default config is **neutral** — the baseline CPP/CBF setpoint and the baseline cerebral
blood volume are **auto-seeded** after a warm-up, so a scenario that ships a `Brain` model behaves
identically at rest and only diverges when blood pressure changes, autoregulation is impaired, or
intracranial volume rises.

## The cerebral bed (pre-wired in the scenarios)

```
AA ──AA_BR_ART──► BR_ART ──► BR_CAP ──► BR_VEN ──BR_VEN_VUB──► VUB
     (arteriole         (autoregulated bed: summed for CBV)      (venous outflow;
      effector)          BR_CAP = dominant O2 sink (fvo2~0.45)    ICP raises its R)
```

`CBF = AA_BR_ART.flow`. `BR_CAP` is the dominant neonatal O2 sink ([`Metabolism`](./Metabolism.md)
`fvo2 ≈ 0.45`), so a fall in CBF shows up as `BR_CAP.to2` collapsing — the HIE / ischaemia signature
(`brain_to2` read-out).

## Autoregulation = closed-loop control of CBF

Autoregulation is modelled as **closed-loop control on FLOW**, not open-loop pressure→resistance
scaling — because the cerebral bed is several resistors in series and `AA_BR_ART` is only ~44 % of
the total path resistance, so a fixed pressure-driven scaling of one resistor would not hold CBF. A
**leaky integrator** adjusts the arteriole resistor's `AA_BR_ART.r_factor_ps` to hold CBF at its
seeded setpoint (`u` = update interval, `err` = fractional CBF error):

```
err  = (cbf_smooth − cbf_setpoint) / cbf_setpoint
d    = autoreg_control_gain·err − autoreg_leak·(_ar_int − 1)     # leaky integral
_ar_int = clamp(_ar_int + d·u, autoreg_factor_min, autoreg_factor_max)
applied = clamp(1 + autoregulation_gain·(_ar_int − 1), …)        # blend toward pressure-passive
autoreg_factor ← lag(autoreg_factor → applied, autoreg_tc)       # anti-oscillation lag
AA_BR_ART.r_factor_ps = autoreg_factor
```

Too much flow (`err > 0`) → constrict. The **leak** (`autoreg_leak`) relaxes the integrator toward
neutral (`1.0`), so at the baseline (`err ≈ 0`) the factor returns to `1.0` — **no windup**, the
baseline stays collision-free/neutral. Under a sustained insult the error term dominates and the
correction is held (`control_gain / leak ≈ 5 / 0.05 = 100` → strong autoregulation with a small
droop). `autoregulation_gain ∈ [0, 1]` blends between **intact (1)** and **pressure-passive (0)**:
the immature / sick neonatal brain is pressure-passive (set the gain `< 1` or `0` for HIE / extreme
preterm — the IVH/HIE substrate, where CBF follows pressure: surge → haemorrhage, drop → ischaemia).

> **Why `AA_BR_ART` is the effector.** It is a free-standing `Resistor` that is **not** in
> [`Circulation`](./Circulation.md)'s ANS/SVR fan-out, so writing its `r_factor_ps` composes
> cleanly with systemic tone (the brain's ANS/SVR tone lives on `BR_ART` and is left alone) — same
> no-collision precedent as the Kidneys afferent and the Hormones efferent.

The sensed MAP (`AA.pres`) and CBF are both **smoothed** first-order (`pres_tc`/`cbf_tc ≈ 3 s`),
because the instantaneous resistor pressures/flows are pulsatile — so `CPP` tracks the **mean**
arterial pressure, not the instantaneous value. CBF is converted L/s → L/min (`×60`).

## ICP (Monro–Kellie, exponential compliance)

Cerebral blood volume `CBV = BR_ART + BR_CAP + BR_VEN` volume (L → mL). The volume excess above
baseline drives an exponential pressure-volume curve:

```
ΔV         = (CBV − CBV0) + edema_volume                  # mL  (CBV0 auto-seeded)
icp_excess = clamp(icp_e0·(exp(icp_k·ΔV) − 1), 0, icp_excess_max)   # mmHg (floored at 0)
ICP        = icp_baseline + icp_excess
CPP        = sensed_map − ICP
```

`edema_volume` is the settable oedema / mass / haemorrhage lever (mL), set via `set_edema(volume_ml)`.
The neonatal cranium is **compliant** (open fontanelle / sutures) → a gentler curve than the adult,
carried by `icp_k`.

> **ICP is applied as a RESISTANCE on the OUTFLOW, not as `pres_ext`.** External pressure on a series
> of compartments does not change their steady-state through-flow, so ICP instead raises the cerebral
> venous **outflow** resistor: `BR_VEN_VUB.r_factor_ps = clamp(1 + icp_outflow_gain·icp_excess, 1,
> icp_outflow_factor_max)`. This models **venous compression / the vascular waterfall** — rising ICP
> congests the venous outflow → CBF falls (and the closed-loop autoregulation then defends CBF by
> dilating the inflow, until the reserve is exhausted). The ICP → outflow-R → venous-congestion →
> CBV → ICP loop is **positive feedback**, so `icp_outflow_gain` is kept low (loop gain < 1).

## Clinical demonstrations it enables

- **Autoregulation intact vs pressure-passive on hypotension** — with `autoregulation_gain = 1`
  CBF is protected as MAP falls; with the gain low/0 CBF collapses with pressure → IVH/HIE.
- **Raised ICP / HIE** — `set_edema(…)` (oedema/mass) + lost autoregulation → CPP falls, CBF falls,
  `brain_to2` collapses → cerebral ischaemia.
- **Emergent coupling** — autoregulatory **vasodilation raises ICP** (it increases arterial CBV),
  and rising ICP feeds back onto CBF through the outflow resistance.

## Read-outs
| Read-out | Unit | Meaning |
|---|---|---|
| `cbf` | L/min | cerebral blood flow (smoothed `AA_BR_ART.flow`) |
| `cpp` | mmHg | cerebral perfusion pressure (`sensed_map − icp`) |
| `icp` | mmHg | intracranial pressure (`icp_baseline + icp_excess`) |
| `icp_excess` | mmHg | ICP above baseline (drives the outflow-R) |
| `cerebral_blood_volume` | mL | CBV (`BR_ART+BR_CAP+BR_VEN`) |
| `brain_to2` | mmol/L | `BR_CAP.to2` — ischaemia read-out |
| `autoreg_factor` | — | applied `AA_BR_ART.r_factor_ps` |
| `sensed_map` | mmHg | smoothed mean arterial pressure |

## Configuration
| Param | Default | Meaning |
|---|---|---|
| `brain_running` | `true` | master gate (false → owned channels released to neutral) |
| `autoregulation_enabled` | `true` | cerebral autoregulation on/off |
| `icp_enabled` | `true` | intracranial-pressure coupling on/off |
| `autoregulation_gain` | `1.0` | 1 = intact, 0 = pressure-passive (blend) |
| `autoreg_control_gain` | `5.0` | CBF-error feedback gain (per fractional error per second) |
| `autoreg_leak` | `0.05` | 1/s — integrator leak toward neutral (no windup) |
| `autoreg_factor_min` / `max` | `0.15` / `6.0` | max vasodilation / vasoconstriction limits |
| `autoreg_tc` | `4.0` s | lag on the applied factor (anti-oscillation) |
| `cbf_tc` / `pres_tc` | `3.0` / `3.0` s | smoothing of pulsatile CBF / arterial pressure |
| `cbf_setpoint` / `cpp_setpoint` | auto-seeded | baseline CBF (L/min) / CPP (mmHg) targets |
| `icp_baseline` | `5.0` mmHg | normal neonatal ICP (read-out anchor) |
| `edema_volume` | `0.0` mL | oedema / mass / haemorrhage lever (`set_edema()`) |
| `icp_e0` | `4.0` mmHg | scale of the exponential P-V curve |
| `icp_k` | `0.18` 1/mL | intracranial stiffness (neonatal-compliant) |
| `icp_excess_max` | `70.0` mmHg | clamp on the ICP excess |
| `icp_outflow_gain` | `0.03` | fractional outflow-R rise per mmHg of ICP excess |
| `icp_outflow_factor_max` | `8.0` | clamp on the outflow-resistance factor |

Wiring refs (`map_model` `AA`, `arteriole_resistor`/`cbf_resistor` `AA_BR_ART`,
`cerebral_compartments` `[BR_ART, BR_CAP, BR_VEN]`, `outflow_resistor` `BR_VEN_VUB`, `oxy_model`
`BR_CAP`) are resolved lazily on the first step. The controller runs on a 15 ms tick
(`_update_interval`); the baseline CPP / CBF setpoint and `CBV0` are seeded once after a
`_warmup_delay` (30 s) so they reflect the settled circuit, not the startup transient. Disabling
(`brain_running = false`) writes `AA_BR_ART.r_factor_ps` and `BR_VEN_VUB.r_factor_ps` back to `1.0`
once, restoring neutral cerebral haemodynamics.

## Related models
[`Kidneys`](./Kidneys.md) (the autoregulation pattern Brain mirrors) ·
[`Metabolism`](./Metabolism.md) (cerebral O2 consumption at `BR_CAP`) ·
[`Circulation`](./Circulation.md) (systemic SVR / `AA` perfusion pressure) ·
[`Monitor`](./Monitor.md) (read-out surfacing) · [`Hormones`](./Hormones.md) (sibling controller).

````

### FILE: explain-engine/docs/Breathing.md

````markdown
# Breathing

The Breathing model is the **spontaneous breathing driver**. It decides how much the patient should
breathe (target minute volume), splits that into a respiratory rate and tidal volume, generates a
respiratory-muscle effort waveform over each breath, and applies that effort to the `THORAX`
container — which in turn drives the lungs. It is the spontaneous counterpart to the `Ventilator`
device, and the effort partner of [Respiration](./Respiration.md) (which sets the mechanics the breath
acts against).

## Inheritance

```
BaseModelClass
  └── Breathing   (breath-effort generator — no compartment of its own)
```

Extends `BaseModelClass` directly. It owns no volume/pressure; instead `calc_model()` runs a breath
state machine and writes its effort onto `THORAX.el_base_factor` each step.

## What it models

```
minute volume target  ──Mecklenburgh──►  resp_rate + tidal volume
        │                                        │
        │                              breath phase state machine (insp / exp)
        ▼                                        ▼
   resp-muscle pressure waveform  ──►  THORAX.el_base_factor  ──►  thoracic recoil  ──►  lung volume change
                                                                          ▲
                                              adaptive rmp_gain ◄── tidal-volume feedback
```

## Properties

### Configuration (set in the model definition)

| Property | Default | Unit | Description |
|---|---|---|---|
| `breathing_enabled` | `true` | — | spontaneous breathing on/off (`switch_breathing`) |
| `minute_volume_ref` | `0.2` | L/kg/min | reference minute volume |
| `minute_volume_ref_factor` | `1.0` | — | non-persistent multiplier on the reference MV |
| `minute_volume_ref_scaling_factor` | `1.0` | — | scaling (weight) multiplier on the reference MV |
| `vt_rr_ratio` | `0.0001212` | — | Mecklenburgh tidal-volume / rate² ratio |
| `vt_rr_ratio_factor` | `1.0` | — | multiplier on `vt_rr_ratio` |
| `vt_rr_ratio_scaling_factor` | `1.0` | — | scaling multiplier on `vt_rr_ratio` |
| `rmp_gain_max` | `100.0` | mmHg/L | ceiling on the muscle-pressure gain |
| `ie_ratio` | `0.3` | — | inspiratory fraction of the breath |
| `mv_ans_factor` | `1.0` | — | autonomic modulation of minute volume |
| `ans_activity_factor` | `1.0` | — | global ANS activity multiplier on minute volume |

### Computed / reported (outputs)

| Property | Unit | Description |
|---|---|---|
| `target_minute_volume` | L/min | demanded minute volume |
| `resp_rate` | breaths/min | computed rate driving the breath interval |
| `resp_rate_measured` | breaths/min | rate inferred from observed breath timing |
| `target_tidal_volume` | L | demanded tidal volume |
| `minute_volume` | L/min | achieved MV (`exp_tidal_volume · resp_rate`) |
| `insp_tidal_volume` | L | integrated inspiratory volume of the last breath |
| `exp_tidal_volume` | L | integrated expiratory volume of the last breath (negative inflow) |
| `resp_muscle_pressure` | mmHg/L | current muscle-effort applied to the thorax |
| `rmp_gain` | mmHg/L | adaptive effort gain (tidal-volume feedback) |
| `ncc_insp` / `ncc_exp` | steps | inspiration / expiration step counters |

### Local (internal)

`_eMin4 = e⁻⁴` (Mecklenburgh constant), `_ti`/`_te` (inspiration/expiration times), `_breath_timer`,
`_breath_interval`, `_insp_running`/`_exp_running` phase flags, `_insp_timer`/`_exp_timer`,
`_temp_insp_volume`/`_temp_exp_volume` volume integrators, and `_rr_counter`/`_rr_factor` for the
measured-rate logic. `debug_factor1` is declared but unused.

## Target minute volume and the rate/volume split

```
minute_volume_ref' = minute_volume_ref · minute_volume_ref_factor · minute_volume_ref_scaling_factor · weight
target_minute_volume = (minute_volume_ref' + (mv_ans_factor − 1)·minute_volume_ref') · ans_activity_factor
```

The split uses the **Mecklenburgh** relationship `VT / RR = vt_rr_ratio`, i.e. tidal volume scales
with rate. Substituting into `MV = VT · RR` gives `MV = vt_rr_ratio · RR²`, inverted in
`vt_rr_controller`:

```
resp_rate           = sqrt( target_minute_volume / (vt_rr_ratio' · weight) )
target_tidal_volume = target_minute_volume / resp_rate
```

(`vt_rr_ratio'` folds in `vt_rr_ratio_factor` and `vt_rr_ratio_scaling_factor`.) The inversion is
guarded against a non-positive denominator or target so it cannot produce an `Infinity`/`NaN` rate;
when breathing is disabled `vt_rr_controller` sets `resp_rate = 0` and returns.

## Breath phase state machine

Driven by `_breath_timer` against `_breath_interval = 60 / resp_rate`, with inspiration/expiration
times set by `ie_ratio`:

```
_ti = ie_ratio · _breath_interval        (inspiration time)
_te = _breath_interval − _ti              (expiration time)
```

- `_breath_timer > _breath_interval` → start **inspiration** (reset timers, `ncc_insp = 0`).
- `_insp_timer > _ti` → start **expiration**; latch `insp_tidal_volume` from the accumulated inflow.
- `_exp_timer > _te` → end the breath; latch `exp_tidal_volume`, run the gain controller, update
  `minute_volume = exp_tidal_volume · resp_rate`.

### Airway-flow integration (route-agnostic)

Tidal volumes are integrated from the **active airway inlet's** `flow · Δt` — positive flow during
inspiration, negative during expiration. The inlet flow `_aw_flow` is the **sum** of two resistors,
each contributing 0 when it is disabled, blocked (`no_flow`) or absent:

```
_aw_flow = (MOUTH_DS.flow      if MOUTH_DS exists and !no_flow)
         + (VENT_ETTUBE.flow   if VENT_ETTUBE exists, is_enabled and !no_flow)
```

This makes the feedback loop route-agnostic: with the ventilator off, `VENT_ETTUBE` is disabled so
`_aw_flow` is exactly `MOUTH_DS.flow` (the natural-airway spontaneous baseline). When the patient is
intubated (e.g. on CPAP), `MOUTH_DS` is blocked so `_aw_flow` becomes `VENT_ETTUBE.flow` — the
tidal-volume feedback keeps working through the ET tube. Both resistors feed the dead space `DS` with
the same sign convention (positive = inspiration), so the sum collapses to the single open route.

## Respiratory-muscle pressure

`calc_resp_muscle_pressure` builds the effort waveform, scaled by `rmp_gain`:

- **Inspiration:** linear ramp `mp = (ncc_insp / (ti / Δt)) · rmp_gain`.
- **Expiration:** Mecklenburgh exponential decay
  `mp = (e^(−4·fraction) − e^(−4)) / (1 − e^(−4)) · rmp_gain`, with `fraction = ncc_exp / (te / Δt)`.

### Coupling to the thorax (important)

The effort is applied as `THORAX.el_base_factor += resp_muscle_pressure` each step (a non-persistent
factor, reset to 1.0 by the Container every step). This **modulates thoracic elastance**, not an
external pressure. It produces inspiration because the `THORAX` operates **below its unstressed
volume** (`vol < u_vol`): there `(vol − u_vol) < 0`, so raising the elastance makes the recoil
pressure *more negative*, increasing the suction transmitted to the lungs and drawing air in. (An
older external-pressure form, `THORAX.pres_ext += −resp_muscle_pressure`, is left commented out for
reference.)

## Adaptive gain (tidal-volume feedback)

At the end of each breath, `rmp_gain` is nudged ±0.1 to close the gap between the achieved
`exp_tidal_volume` and `target_tidal_volume`, clamped to `[0, rmp_gain_max]`. This is a slow integral
controller that learns the muscle effort needed to hit the target tidal volume. It only updates while
`breathing_enabled` is true.

## Example definition (JSON)

From `term_neonate.json`:

```json
{
  "name": "Breathing",
  "description": "spontaneous breathing model",
  "model_type": "Breathing",
  "is_enabled": true,
  "breathing_enabled": true,
  "minute_volume_ref": 0.2,
  "minute_volume_ref_factor": 1.0,
  "minute_volume_ref_scaling_factor": 1.0,
  "vt_rr_ratio": 0.00012,
  "vt_rr_ratio_factor": 1.0,
  "vt_rr_ratio_scaling_factor": 1.0,
  "rmp_gain_max": 100.0,
  "ie_ratio": 0.3,
  "mv_ans_factor": 1.0,
  "ans_activity_factor": 1.0
}
```

## Usage in the model

- The **ANS** drives `mv_ans_factor` / `ans_activity_factor` to raise or lower ventilatory drive (e.g.
  hypoxic/hypercapnic chemoreflex).
- `ModelScaler` writes the `*_scaling_factor` levers so reference minute volume and the VT/RR ratio
  track body weight.
- When `breathing_enabled` is false, `resp_rate`, the activation counters, `target_tidal_volume` and
  the muscle pressure are all zeroed (so the thorax coupling adds 0), but the phase machine keeps
  ticking so the tidal-volume integrators can still measure externally driven (ventilator) flow.

## Notes & caveats

- **Airway inlets are null-checked.** `MOUTH_DS` and `VENT_ETTUBE` are looked up each step and only
  contribute when present and open, so a scenario without an ET tube simply uses the mouth route.
  `THORAX`, however, is dereferenced without a null check at the end of `calc_model` — it is core to
  breathing and always present, so a configuration lacking it would throw.
- **`resp_rate_measured` has a startup transient.** `_rr_factor` starts at 0, so the
  `_rr_counter > 4·_rr_factor` branch fires repeatedly until it settles after the first breaths (same
  pattern as the `Heart` measured-rate logic). The settled value is correct.
- **`debug_factor1`** is declared but unused (debug cruft).

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

In the worker, `ModelEngine.tune_model(payload)` performs a live, in-place calibration: it pauses the realtime loop, builds a `stepFn` that calls `_model_step()` synchronously, builds controllers from the requested `targets`, runs `runCalibration`, emits a `tuned` message with the result, then resumes realtime from the new operating point. No reload and no `ModelScaler` reset are involved — the levers compose with the patient's already-baked scaling. Outside the engine, `build_patient.mjs` uses the same `runCalibration` loop with its own controllers to converge a new patient before saving the definition.

## Key state / configuration it reads

- **`SLICE`** (`0.02` s) — module-private sub-cardiac-cycle sample step used by `measureWindow` for windowed averaging.
- **`DEFAULT_TOL`** (exported) — per-target convergence tolerances on the measured value:
  `map: 3`, `cvp: 1.5`, `pap_m: 3`, `hr: 6`, `co: 0.03`, `spo2: 2`, `po2: 6`, `pco2: 4`, `ph: 0.03`, `be: 1.5`, `blood_volume: 0.02`. Callers may override per target via `tolOverrides`.
- **`LIVE_TARGETS`** (exported) — the canonical list of live-tunable target names, for validation / UI / docs: `["map", "co", "hr", "po2", "spo2", "pco2", "be", "ph", "blood_volume"]`.
- **`LIVE_READ`** (module-private) — a map from measure key to a reader that pulls the value off the running `model` (e.g. `map` ← `Monitor.minmax.abp_pre_pres_mean`, `lvo` ← `Monitor.flows.lvo`, `po2`/`pco2`/`ph`/`be` ← the `AA` compartment, `total_blood_volume` ← `Circulation`). Used by `measureWindow`.
- **`READ_KEY`** (module-private) — maps a canonical target name to the measure-dict key it reads when they differ: `co → lvo`, `spo2 → spo2_pre`, `blood_volume → total_blood_volume`.

## Key methods / exports

- **`makeController(spec)`** — wraps a lever spec into a stateful controller. Spec fields: `key` (canonical target, e.g. `"co"`), `readKey` (key into the measured dict, defaults to `key`), `lo`/`hi` (clamp bounds), `sign` (+1 if raising the lever raises the measured value), `gain` (proportional seed gain), `value` (current lever value), `set(v)` (apply lever to the model), `target`, `tol`. Its `step(measured)` method returns `false` (no move) when the measurement is within `tol` or non-numeric; otherwise it computes the next lever value — secant (`value + (target-measured)/slope`) once `prevL`/`prevM` exist and the slope is well-defined, else proportional (`value + sign*gain*(target-measured)`) — clamps to `[lo, hi]`, records the previous sample, applies via `set`, and returns `true`.
- **`runCalibration(controllers, opts)`** — the generic loop, shared by build + live tune. `opts`: `measureAll()`, `step(seconds)`, `settle` (default 90 s; one settle step before iterating), `warm` (45 s between iterations), `maxIters` (12), `final` (0; optional extra settle at the end), `log`. Each iteration measures all read keys, calls `step(v[readKey])` on every controller, and breaks early when no controller moved (converged). Returns `{ iters, converged, residuals: [{key, target, value, within}], measured }`.
- **`measureWindow(model, step, keys, window = 12)`** — advances the model in `SLICE`-sized increments over `window` seconds, averaging each requested key via `LIVE_READ`. This is the `measureAll` implementation the worker passes to `runCalibration`. (The `Monitor` model already beat-averages; this adds a short window on top for robustness.)
- **`buildLiveControllers(model, targets, tolOverrides = {})`** — builds the live-tune controller set from a `{name: value}` targets map. Returns `{ controllers, keys }`, where `keys` is the de-duplicated list of measure-dict keys to sample. Only creates a controller for targets present in `targets` (and whose required model exists). See levers below.

## Closed-loop control

Each controller couples one **lever** (a model property it writes via `set`) to one **measured quantity** (read by `readKey`). `runCalibration` settles, then repeatedly measures and lets every controller nudge its lever; convergence is "no controller moved this iteration," and per-target success is `|target − measured| ≤ tol`. The first nudge is proportional (seeded by `gain`/`sign`); thereafter each controller estimates local slope from its last two (lever, measurement) samples and takes a secant step, clamped to `[lo, hi]`.

The live levers built by `buildLiveControllers` deliberately use the persistent **`*_factor_ps`** layer or direct setters — **not `ModelScaler` groups** — so they compose with whatever scaling a loaded patient already baked in (e.g. a preterm's SVR/PVR scaling), instead of overwriting the `*_factor_scaling_ps` layer absolutely the way `ModelScaler` does (see [ModelScaler](./ModelScaler.md) and the factor/`_eff` pattern in [ARCHITECTURE](./ARCHITECTURE.md)):

| Target | Lever | Notes |
|---|---|---|
| `map` | `Circulation.svr_factor_art` | systemic arteriolar resistance factor; ↑ raises MAP |
| `co` | `LV.el_max_factor_ps` and `RV.el_max_factor_ps` | ventricular contractility; reads `lvo` |
| `hr` | `Heart.heart_rate_ref` | HR reference setpoint |
| `po2` / `spo2` | `GASEX_LL.dif_o2_factor_ps` and `GASEX_RL.dif_o2_factor_ps` | alveolar O2 diffusion factor; one controller, reads `po2` or `spo2_pre` |
| `pco2` | `Breathing.minute_volume_ref` (× multiplier) | spontaneous ventilatory drive; `sign: -1` (↓ drive raises pCO2) |
| `be` / `ph` | `Blood.set_solute("uma", …)` | Stewart unmeasured anions; `sign: -1` (↑ uma lowers BE/pH) |
| `blood_volume` | proportional rescale of every blood compartment's `vol`/`u_vol` | custom `step` (not a secant lever): scales by `target/measured` each iteration; converges in 1–2 iters because the body redistributes volume |

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

A `Capacitance` is the base **volume compartment** of the engine: it holds a volume and produces a
pressure from its elastance. It is the canonical implementation of the factor / effective-value
pattern for elastance-based elements. `BloodCapacitance`, `GasCapacitance` and (indirectly)
`BloodVessel` build on it.

## Inheritance

```
BaseModelClass
  └── Capacitance              (volume → elastance → pressure)
        ├── BloodCapacitance       (+ blood composition mixing)
        │     └── BloodVessel          (+ resistance, flow, ANS coupling)
        └── GasCapacitance         (+ gas composition, atmospheric/external pressures)
```

See [BaseModelClass.md](./BaseModelClass.md) for the lifecycle contract and shared fields, and
[BloodCapacitance.md](./BloodCapacitance.md) for the blood-tracking subclass.

## What it models

A passive elastic compartment. Volume flows in and out (driven by external [`Resistor`](./Resistor.md)
models that reference it via `comp_from`/`comp_to`), and the compartment converts the volume above its
unstressed volume into a recoil pressure through its elastance. It has no built-in resistance or flow
of its own.

## Properties

### Config / independent (set in the definition JSON)

| Property | Unit | Description |
|---|---|---|
| `u_vol` | L | Unstressed volume (volume at which recoil pressure is zero) |
| `el_base` | mmHg/L | Baseline (linear) elastance |
| `el_k` | unitless | Non-linear elastance coefficient (quadratic stiffening term) |
| `pres_ext` | mmHg | External pressure applied this step (non-persistent; cleared each step) |
| `fixed_composition` | bool | When true, `volume_in`/`volume_out` do not change `vol` (infinite reservoir) |

Factor inputs (all default `1.0`) — see [Factor system](#factor-system):
`u_vol_factor`, `el_base_factor`, `el_k_factor` (non-persistent);
`u_vol_factor_ps`, `el_base_factor_ps`, `el_k_factor_ps` (persistent);
`u_vol_factor_scaling_ps`, `el_base_factor_scaling_ps`, `el_k_factor_scaling_ps` (scaling).

### Computed / dependent (engine outputs)

| Property | Unit | Description |
|---|---|---|
| `vol` | L | Current volume |
| `pres` | mmHg | Total pressure (`pres_in + pres_ext`) |
| `pres_in` | mmHg | Internal recoil pressure of the elastance |
| `pres_tm` | mmHg | Transmural pressure (`pres_in − pres_ext`) |
| `el_eff` | mmHg/L | Effective elastance after the factor layers |
| `u_vol_eff` | L | Effective unstressed volume after the factor layers |
| `el_k_eff` | unitless | Effective non-linear coefficient after the factor layers |

## Calculation cycle (`calc_model`)

Each step runs, in order: `calc_elastances()` → `calc_volumes()` → `calc_pressure()`.

### `calc_elastances`

```
el_eff   = el_base + (el_base_factor − 1)·el_base + (el_base_factor_ps − 1)·el_base + (el_base_factor_scaling_ps − 1)·el_base
el_k_eff = el_k    + (el_k_factor − 1)·el_k       + (el_k_factor_ps − 1)·el_k       + (el_k_factor_scaling_ps − 1)·el_k
```

Then resets the non-persistent factors `el_base_factor` and `el_k_factor` to `1.0`.

### `calc_volumes`

```
u_vol_eff = u_vol + (u_vol_factor − 1)·u_vol + (u_vol_factor_ps − 1)·u_vol + (u_vol_factor_scaling_ps − 1)·u_vol
```

Then resets the non-persistent factor `u_vol_factor` to `1.0`.

### `calc_pressure`

```
pres_in = el_k_eff · (vol − u_vol_eff)² + el_eff · (vol − u_vol_eff)
pres_tm = pres_in − pres_ext                 (transmural)
pres    = pres_in + pres_ext                 (total)
pres_ext := 0                                (external pressure is non-persistent)
```

The `el_k_eff` term adds non-linear stiffening; because it uses `(vol − u_vol_eff)²` (sign-independent)
it also raises pressure *below* the unstressed volume — this is the engine convention, and `el_k` is
`0` for most compartments. `pres_ext` is an external pressure (e.g. from a [`Container`](./Container.md)
or chest compression) applied this step and then cleared.

## Volume flow

- **`volume_in(dvol)`** — adds `dvol` to `vol` (skipped when `fixed_composition`). Subclasses extend
  this to mix in the incoming composition.
- **`volume_out(dvol)`** — removes `dvol` from `vol` (skipped when `fixed_composition`); if the volume
  would go negative it is clamped to `0` and the **un-removed** amount is returned, so a `Resistor`
  never pulls volume that isn't there. A `fixed_composition` compartment therefore supplies volume
  without depleting (an infinite reservoir).

## Factor system

Core physics parameters (`el_base`, `u_vol`, `el_k`) are **never used raw**. Each has three multiplier
layers that combine **additively against the base** into an `*_eff` value:

| Layer | Persistence | Set by |
|---|---|---|
| `<p>_factor` | reset to `1.0` every step | transient interventions |
| `<p>_factor_ps` | persistent | user / scenario / regulator models (ANS, MOB, Circulation…) |
| `<p>_factor_scaling_ps` | persistent | `ModelScaler` (allometric/weight scaling) |

```
p_eff = p + (factor − 1)·p + (factor_ps − 1)·p + (factor_scaling_ps − 1)·p
```

A factor of `1.0` means "no effect"; simultaneous factors add their deltas. `calc_elastances` /
`calc_volumes` reset only the non-persistent `*_factor` layer each step. When you add a tunable
parameter, follow this convention so it composes with interventions and scaling.

## Example definition (JSON)

Plain `Capacitance` is rarely instantiated directly in scenarios (the blood/gas subclasses are used);
a definition block carries the config fields below (factor fields default to `1.0` and are usually
omitted):

```json
{
  "name": "EXAMPLE_COMP",
  "description": "passive elastic compartment",
  "model_type": "Capacitance",
  "is_enabled": true,
  "vol": 0.04,
  "u_vol": 0.038,
  "el_base": 3100,
  "el_k": 0,
  "fixed_composition": false
}
```

## Usage in the model

- The foundational elastance element; almost every volume-holding compartment is a `Capacitance`
  subclass.
- Use it (or a subclass) for any compartment that is a pure compliance with no built-in flow —
  flow is provided by separate [`Resistor`](./Resistor.md) models that reference it.
- `fixed_composition` turns it into an infinite reservoir (outside air, maternal blood,
  ventilator/ECLS gas sources).

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

- **Shared (`_drainChartShared`):** loads `w = WRITE_IDX`; returns `null` if `w === _chartLastRead`. Otherwise `count = w - _chartLastRead`. **If `count > capacity` the reader stalled and the writer lapped it** — it keeps only the freshest `capacity` rows (`from = w - cap`) and sets `lastChartGap = true` as an overrun diagnostic. Rows are copied out of the ring with wrap (`(from + k) % cap`), `_chartLastRead` advances to `w`, and `READ_HINT` is published via `Atomics.store(ctrl, CHART_CTRL.READ_HINT, w)` so the writer can detect a stalled reader.
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

- **`CHART_CTRL`** — `WRITE_IDX` (0): monotonic total rows written (read via `Atomics.load` in `_drainChartShared`); `READ_HINT` (1): written back via `Atomics.store` so the writer can spot a stalled reader. (`VERSION` (2), `CAPACITY` (3), `STRIDE` (4) are written by the writer and carried in the descriptor; the reader takes capacity/stride from the descriptor rather than the header.)
- **`ANIM_CTRL`** — `ACTIVE` (0): which of the two flip-buffer frames holds the newest data; `SEQ` (1): bumped on every publish (odd while a write is in progress) — the basis of the torn-read retry in `_readAnimShared`. (`VERSION` (2), `STRIDE` (3) likewise come from the descriptor.)
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
- **Anim frames** use a seqlock: write inactive frame → flip `ACTIVE` → bump `SEQ`. Odd `SEQ` means a write is in progress; the reader retries if `SEQ` changes mid-copy.
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

`Circulation` is **not a physical compartment** — it is a high-level coordinator that groups the
circulatory models by anatomical class and applies whole-tree adjustments to them. It does two jobs:
it propagates **autonomic vascular tone** and **resistance-factor targets** onto the vessels, and it
tallies the **blood-volume distribution** across the systemic, pulmonary and cardiac compartments for
reporting. It holds no volume, pressure or flow of its own — it only reads from and writes onto the
vessels and chambers named in its lists.

## Inheritance

```
BaseModelClass
  └── Circulation   (group coordinator — no physics of its own)
```

Unlike `Capacitance`/`Resistor` descendants, `Circulation` extends `BaseModelClass` directly. It has
no `el_base`/`r_for`/`vol`; `calc_model()` instead iterates over named members and writes onto their
factor layers. It is the systemic/pulmonary counterpart to `Respiration` (which coordinates the
respiratory tree the same way).

## What it models

It groups every blood-carrying model and exposes a small set of system-wide levers:

- **Autonomic tone** — `ans_activity` is copied onto every vessel's own `ans_activity`, which drives
  the α-coupled vasoreactivity computed inside each `BloodVessel`.
- **Resistance tone** — `svr_factor_art`/`svr_factor_ven` and `pvr_factor_art`/`pvr_factor_ven` set
  the systemic and pulmonary arteriolar/venular resistance; `svr_factor_drug` is an independent
  channel owned by the Drugs PK/PD model that composes additively with `svr_factor_art`.
- **Volume bookkeeping** — `calc_blood_volumes()` sums compartment volumes into systemic / pulmonary /
  heart totals and percentages.

Group membership is **name-based**: a vessel only receives tone or is counted if its name appears in
the appropriate list, so the lists must be kept in sync with the circulation topology.

## Properties

### Configuration (set in the model definition)

| Property | Default | Description |
|---|---|---|
| `heart_chambers` | `[]` | names of all heart chambers (LA/RA/LV/RV streams) |
| `coronaries` | `[]` | names of coronary compartments (counted into the systemic total) |
| `systemic_arteries` | `[]` | systemic artery names |
| `systemic_arterioles` | `[]` | systemic arteriole names (the SVR tone site) |
| `systemic_capillaries` | `[]` | systemic capillary names |
| `systemic_venules` | `[]` | systemic venule names (the venous tone site) |
| `systemic_veins` | `[]` | systemic vein names |
| `pulmonary_arteries` | `[]` | pulmonary artery names |
| `pulmonary_arterioles` | `[]` | pulmonary arteriole names (the PVR tone site) |
| `pulmonary_capillaries` | `[]` | pulmonary capillary names |
| `pulmonary_venules` | `[]` | pulmonary venule names |
| `pulmonary_veins` | `[]` | pulmonary vein names |
| `ans_activity` | `1.0` | autonomic tone propagated to all vessels (1.0 = no effect) |
| `svr_factor_art` | `1.0` | systemic **arteriolar** resistance target |
| `svr_factor_ven` | `1.0` | systemic **venular** resistance target |
| `svr_factor_drug` | `1.0` | independent systemic-arteriolar channel owned by the Drugs model |
| `pvr_factor_art` | `1.0` | pulmonary **arteriolar** resistance target |
| `pvr_factor_ven` | `1.0` | pulmonary **venular** resistance target |

### Computed / reported (outputs)

| Property | Unit | Description |
|---|---|---|
| `total_blood_volume` | L | systemic + pulmonary + heart volume |
| `syst_blood_volume` | L | systemic vessels + coronaries |
| `pulm_blood_volume` | L | pulmonary vessels |
| `heart_blood_volume` | L | heart chambers |
| `syst_blood_volume_perc` | % | systemic share of total (0 when total = 0) |
| `pulm_blood_volume_perc` | % | pulmonary share of total |
| `heart_blood_volume_perc` | % | heart share of total |

### Local (internal)

`_bloodvessel_list`, `_systemic_bloodvessel_list`, `_pulmonary_bloodvessel_list` are flattened name
lists built in `init_model`. `prev_*` shadow each target so a change can be detected and applied as a
delta. `_update_interval` (0.015 s) / `_update_interval_slow` (1.0 s) throttle the two loops.

> Definition files may also carry stale `svr_factor`/`pvr_factor`/`prev_svr_factor`/`prev_pvr_factor`
> fields left over from an earlier single-factor scheme. The **current** source reads only the
> `*_art`/`*_ven` (and `*_drug`) factors above; the bare `svr_factor`/`pvr_factor` keys are ignored.

## Calculation cycle (`calc_model`)

Two throttled loops:

- **Fast (every 0.015 s)** — apply tone changes *only when an input changed* (each guarded by a
  `prev_*` comparison so the work is skipped when nothing moved):
  - `ans_activity` → written onto every vessel's `ans_activity`.
  - `svr_factor_art` / `svr_factor_ven` → `set_svr_factor_art` / `set_svr_factor_ven`.
  - `svr_factor_drug` → `set_svr_factor_drug`.
  - `pvr_factor_art` / `pvr_factor_ven` → `set_pvr_factor_art` / `set_pvr_factor_ven`.
- **Slow (every 1.0 s)** — `calc_blood_volumes()` tallies the volume distribution (throttled for
  performance, so `*_blood_volume*` lag fast transients by up to a second).

## Vascular tone: the `set_*_factor` methods

Resistance tone is applied through each vessel's **persistent** resistance factor `r_factor_ps` — the
layer that survives steps and accumulates contributions from several models (Circulation, ANS, Drugs,
Hormones). Because it is cumulative, Circulation applies the **delta** since the last call, not the
absolute value:

```
delta = new_factor − prev_factor
for each vessel in the group:  r_factor_ps += delta   (clamped at 0)
this.<factor> := new_factor
```

The delta is computed **once** so every vessel in the group receives the same change, and
`r_factor_ps` is clamped at 0 (a negative resistance factor is non-physical). The five methods differ
only in which list they drive:

| Method | Vessel list | Role |
|---|---|---|
| `set_svr_factor_art` | `systemic_arterioles` | systemic arteriolar resistance |
| `set_svr_factor_drug` | `systemic_arterioles` | independent drug channel (composes additively with art) |
| `set_svr_factor_ven` | `systemic_venules` | systemic venular resistance |
| `set_pvr_factor_art` | `pulmonary_arterioles` | pulmonary arteriolar resistance |
| `set_pvr_factor_ven` | `pulmonary_venules` | pulmonary venular resistance |

> Resistance tone is applied at the **arteriolar and venular** levels only — the dominant resistance
> sites — not on the large arteries/veins or capillaries. `ans_activity`, by contrast, is broadcast to
> *every* vessel in `_bloodvessel_list`.

## Blood-volume tally (`calc_blood_volumes`)

Sums `vol` over **enabled** members of each group:

```
syst_blood_volume  = Σ systemic vessels + Σ coronaries
pulm_blood_volume  = Σ pulmonary vessels
heart_blood_volume = Σ heart chambers
total_blood_volume = syst + pulm + heart
*_perc = 100 · part / total          (0 when total = 0)
```

Coronary volume is counted into the **systemic** total. Disabled models and missing names are skipped,
and the percentages are guarded against a zero total (NaN avoidance before the circulation fills).

## Example definition (JSON)

From `term_neonate.json` (lists trimmed for brevity):

```json
{
  "name": "Circulation",
  "description": "high level circulation model",
  "model_type": "Circulation",
  "is_enabled": true,
  "heart_chambers": ["LA", "RAIVCI", "RASVC", "RV", "LV"],
  "coronaries": ["COR"],
  "systemic_arteries": ["AA", "AAR", "AD"],
  "systemic_arterioles": ["INT_ART", "KID_ART", "LS_ART", "BR_ART"],
  "systemic_capillaries": ["INT_CAP", "KID_CAP", "LS_CAP", "BR_CAP"],
  "systemic_venules": ["INT_VEN", "KID_VEN", "LS_VEN", "BR_VEN"],
  "systemic_veins": ["IVCI", "SVC", "VLB", "VUB", "RLB", "RUB"],
  "pulmonary_arteries": ["PA", "PAAL", "PAAR"],
  "pulmonary_arterioles": ["LL_ART", "RL_ART"],
  "pulmonary_capillaries": ["LL_CAP", "RL_CAP"],
  "pulmonary_venules": ["LL_VEN", "RL_VEN"],
  "pulmonary_veins": ["PV", "PV_LA"],
  "ans_activity": 1.0,
  "svr_factor_art": 1.0,
  "svr_factor_ven": 1.0,
  "svr_factor_drug": 1.0,
  "pvr_factor_art": 1.0,
  "pvr_factor_ven": 1.0
}
```

## Usage in the model

- The **ANS** effector writes `Circulation.ans_activity`; Circulation fans it out to every
  `BloodVessel` so the per-vessel α-coupled vasoreactivity uses one shared activity level.
- The **Hormones** (RAAS/ADH) and **Drugs** models adjust `svr_factor_art` / `svr_factor_drug` /
  `pvr_factor_*` to raise or lower regional resistance; Circulation translates each target into a
  shared delta on the relevant `r_factor_ps`.
- `scaleModel`/`ModelScaler` does **not** go through Circulation — it writes the `*_scaling_ps` layer
  on each vessel directly. Circulation only ever touches `r_factor_ps`.
- The `*_blood_volume*` outputs feed monitoring/diagnostics (volume distribution between systemic,
  pulmonary and cardiac compartments).

See also [Respiration](./Respiration.md) (the respiratory-tree counterpart) and
[BloodVessel](./BloodVessel.md) (the per-vessel resistance/ANS coupling that Circulation drives).

````

### FILE: explain-engine/docs/Container.md

````markdown
# Container

A `Container` is an enclosing compartment that **wraps other compartments** and squeezes them with its
own recoil pressure — the model of the thorax and the pericardium. Its volume is the sum of what it
contains, and its pressure is transmitted to those contents. It reuses the elastance machinery of
[`Capacitance`](./Capacitance.md) but holds no flow of its own.

## Inheritance

```
BaseModelClass
  └── Container          (sum contained volume → elastance → broadcast pressure)
```

`Container` extends `BaseModelClass` directly (it does not derive from `Capacitance`), but implements
the same `el_base`/`u_vol`/`el_k` factor pattern and the same `calc_pressure` recoil formula. See
[BaseModelClass.md](./BaseModelClass.md) for the lifecycle contract.

## What it models

```
THORAX (Container) ── contains ──► PERICARDIUM (Container) ── contains ──► LV, RV, LA, RA, COR
        ── also contains ──► lungs (ALL, ALR), great vessels, …
```

`THORAX` holds the lungs, heart and intrathoracic vessels; `PERICARDIUM` (inside the thorax) holds the
heart chambers. Containers nest, so pressure propagates inward (thorax → pericardium → chambers). A
container's own volume is derived from its members, so it does not store fluid itself and is never a
flow endpoint.

## Properties

### Config / independent (set in the definition JSON)

| Property | Unit | Description |
|---|---|---|
| `u_vol` | L | Unstressed volume of the container |
| `el_base` | mmHg/L | Baseline (linear) elastance |
| `el_k` | unitless | Non-linear elastance coefficient |
| `pres_ext` | mmHg | External pressure applied this step (non-persistent; cleared each step) |
| `vol_extra` | L | Additional fixed volume added to the contained sum |
| `contained_components` | string[] | Names of the models this container encloses |

Factor inputs (all default `1.0`) — see [Factor system](#factor-system):
`u_vol_factor`, `el_base_factor`, `el_k_factor` (non-persistent);
`u_vol_factor_ps`, `el_base_factor_ps`, `el_k_factor_ps` (persistent);
`u_vol_factor_scaling_ps`, `el_base_factor_scaling_ps`, `el_k_factor_scaling_ps` (scaling).

### Computed / dependent (engine outputs)

| Property | Unit | Description |
|---|---|---|
| `vol` | L | Container volume (`vol_extra + Σ contained.vol`) |
| `pres` | mmHg | Total pressure (`pres_in + pres_ext`) |
| `pres_in` | mmHg | Internal recoil pressure |
| `pres_tm` | mmHg | Transmural pressure (`pres_in − pres_ext`) |
| `el_eff` | mmHg/L | Effective elastance after the factor layers |
| `u_vol_eff` | L | Effective unstressed volume after the factor layers |
| `el_k_eff` | unitless | Effective non-linear coefficient after the factor layers |

## Calculation cycle (`calc_model`)

Each step: `calc_elastances()` → `calc_volumes()` → `calc_pressure()`.

### `calc_elastances`

Composes `el_eff` and `el_k_eff` from the base values and the three factor layers (identical to
[`Capacitance`](./Capacitance.md)), then resets the non-persistent `el_base_factor` / `el_k_factor`
to `1.0`.

### `calc_volumes`

```
vol = vol_extra + Σ contained.vol          (over members that exist and are enabled)
u_vol_eff = u_vol + (u_vol_factor − 1)·u_vol + (u_vol_factor_ps − 1)·u_vol + (u_vol_factor_scaling_ps − 1)·u_vol
```

Then resets the non-persistent `u_vol_factor` to `1.0`. Members are looked up by name in
`model.models`; missing or disabled members are skipped.

### `calc_pressure`

```
pres_in = el_k_eff · (vol − u_vol_eff)² + el_eff · (vol − u_vol_eff)
pres_tm = pres_in − pres_ext
pres    = pres_in + pres_ext
for each contained component (existing & enabled):  component.pres_ext += pres
pres_ext := 0
```

The container's full pressure is **added** to every contained component's `pres_ext`, which those
components read in their own `calc_pressure`. Because contents reset `pres_ext` each step, the
contributions compose without accumulating.

## Factor system

`el_base`, `u_vol`, `el_k` are **never used raw**. Each combines three multiplier layers **additively
against the base** into an `*_eff` value:

| Layer | Persistence | Set by |
|---|---|---|
| `<p>_factor` | reset to `1.0` every step | transient interventions |
| `<p>_factor_ps` | persistent | user / scenario / regulator models (e.g. `Breathing`) |
| `<p>_factor_scaling_ps` | persistent | `ModelScaler` (allometric/weight scaling) |

```
p_eff = p + (factor − 1)·p + (factor_ps − 1)·p + (factor_scaling_ps − 1)·p
```

Same pattern as [`Capacitance`](./Capacitance.md).

## Notes

- **Membership is name-based and enable-aware.** Volume is summed and pressure transmitted only for
  members that resolve to a model and are `is_enabled`; missing or disabled members are skipped (so a
  disabled chamber neither adds phantom volume nor accumulates an unbounded `pres_ext`).
- **Sub-unstressed operation matters.** The thorax runs *below* its unstressed volume (`vol < u_vol`),
  so a higher elastance makes `pres_in` more negative — this is how `Breathing`'s muscle effort
  (which raises `THORAX.el_base_factor`) produces inspiratory suction.
- The order of stepping sets whether a content sees this step's container pressure or last step's (at
  most one step of lag) — inherent to sequential stepping, stable at the default step size.

## Example definition (JSON)

```json
{
  "name": "UPPER_BODY",
  "description": "passive container grouping cephalic vessels for tilt",
  "model_type": "Container",
  "is_enabled": true,
  "u_vol": 0,
  "el_base": 0,
  "el_k": 0,
  "pres_ext": 0,
  "vol_extra": 0,
  "contained_components": ["BR_ART", "BR_CAP", "BR_VEN", "RUB", "VUB", "THORAX"]
}
```

## Usage in the model

- `THORAX` and `PERICARDIUM` are the canonical containers (created inside the respiration/heart
  composite models); they transmit intrathoracic/pericardial pressure to the lungs, great vessels and
  heart chambers.
- `Breathing` drives `THORAX.el_base_factor` to generate the inspiratory pressure swing.
- Also used as passive grouping containers (e.g. `UPPER_BODY`) for postural/tilt experiments.

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
| `stop()` / model rebuild path | `clean_up()` / `clean_up_slow()` | drop entries for disabled models |
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
| `_interval_counter` / `_interval_counter_slow` | `0` | accumulators, advanced by `modeling_stepsize` each call |
| `modeling_stepsize` | from `model` | step increment used to drive the counters |
| `collected_data` | `[]` | fast buffer (array of `{time, label: value, …}`) |
| `collected_data_slow` | `[]` | slow buffer |
| `legacy_mode` | `true` | when `true`, fast stream goes to `collected_data`; `set_channels()` sets it `false` to use the typed ring |
| `rt_active` | `false` | the typed ring is only written while the realtime loop runs |
| `_channels` / `_on_chart_registry` | `null` | non-enumerable (must not be structure-cloned with the model graph) |
| `registry_version`, `chart_slots`, `_chart_row` | — | typed-transport slot map / reusable Float64 scratch row |

The two ECG entries (`ncc_atrial`, `ncc_ventricular`) are constructed in the constructor and pushed onto `watch_list` immediately — see [Notes](#notes--caveats).

## Key methods

| Signature | What it does |
|---|---|
| `collect_data(model_clock)` | Samples each watchlist when its interval counter has reached the sample interval, resets that counter, appends one row (or writes one Float64 ring row), then advances both counters by `modeling_stepsize`. Disabled models contribute `0` (typed path) or are skipped (legacy path). |
| `add_to_watchlist(properties)` | Clears `collected_data`, resolves each string dot-path via `_find_model_prop`, appends new (non-duplicate) entries to `watch_list`. Returns `false` if any path failed to resolve. Rebuilds the chart index when not in legacy mode. |
| `add_to_watchlist_slow(properties)` | Same as above for `watch_list_slow` / `collected_data_slow`. |
| `get_model_data()` | Returns `collected_data` and **replaces it with `[]`** (drain-and-clear). |
| `get_model_data_slow()` | Drain-and-clear for the slow buffer. |
| `clear_data()` / `clear_data_slow()` | Empty a buffer without touching watchlists. |
| `clear_watchlist()` | Empties the fast watchlist, then re-adds the two always-present ECG entries; rebuilds the chart index. |
| `clear_watchlist_slow()` | Empties the slow watchlist (no always-present entries). |
| `clean_up()` | Filters `watch_list` down to entries whose `model.is_enabled` is truthy, rebuilds the labels set and chart index. |
| `clean_up_slow()` | Same for the slow watchlist. |
| `set_sample_interval(v=0.005)` / `set_sample_interval_slow(v=0.005)` | Change a sampling period. |
| `set_channels(writer, on_registry)` | Attach the realtime typed transport, set `legacy_mode = false`, build the initial chart slot index. |
| `_find_model_prop(prop)` *(private)* | Resolves a dot-path against `model.models` (see below). Returns a descriptor or `null`. |
| `_rebuild_chart_index()` *(private)* | Re-derives `chart_slots`, bumps `registry_version`, reallocates the ring, re-fires the registry callback. No-op without an attached writer. |

### How dot-paths resolve

Watched properties are strings of the form `"Model.prop"` or `"Model.prop.subprop"`, resolved against `model.models` by `_find_model_prop`:

- **Two segments** (`"Heart.ncc_ventricular"`): requires `t[0] in model.models` and `t[1] in model.models[t[0]]`. Returns `{label, model, prop1, prop2: null, ref}`.
- **Three segments** (`"AA.solutes.lactate"`): requires the model and `prop1` to exist; `prop2` is **not** verified at resolve time. Returns `{label, model, prop1, prop2}`. At sample time the value is read as `model[prop1][prop2] || 0`.
- Anything that fails these checks returns `null`, and the corresponding `add_to_watchlist*` call reports failure.

## Interaction with models

The collector reaches into live model instances purely by property read — it never mutates them. Each watch entry stores a direct `model` reference (the resolved component) plus `prop1`/`prop2`; at sample time it reads `parameter.model[parameter.prop1]` (optionally `[parameter.prop2]`). Disabled components are not sampled on the legacy path; on the typed path their slot is written as `0` so column alignment is preserved across the fixed-stride ring row.

This is the read side of the model contract; the write side (deferred mutation of `*_factor_ps` / base params) belongs to [TaskScheduler](./TaskScheduler.md).

## Notes / caveats

- **ECG counters are always watched.** The constructor pushes `Heart.ncc_atrial` and `Heart.ncc_ventricular` onto `watch_list` regardless of any user watchlist, and `clear_watchlist()` re-adds them. ECG reconstruction therefore always has its source data even when the client subscribed to nothing. These two entries resolve `model.models["Heart"]` at construction time, so the build must have a `Heart` component.
- **`get_model_data*` is destructive.** It returns the buffer and immediately resets it to `[]`. Call it once per drain; a second call returns nothing until more is collected.
- **`clean_up()` drops disabled-model entries.** After a model is disabled, its watch entries are filtered out so `collect_data` does not dereference a dead component; this also re-fires the chart-index rebuild in typed mode.
- **Two divergent collection paths.** With a `ChannelWriter` attached and `rt_active` true, the fast stream is packed into a Float64 ring (no per-sample object allocation). Offline `calculate()` and legacy mode keep using `collected_data`, so `get_model_data()` still returns rows. Slow data always uses the object buffer.
- **`_channels` / `_on_chart_registry` are non-enumerable** on purpose: `get_model_state` posts the whole model graph (which reaches the collector through every component's `_model_engine` back-reference), and these function-bearing fields must not be structure-cloned.
- **Time is rounded** to 4 decimals (`Math.round(model_clock * 10000) / 10000`) before being stored.

````

### FILE: explain-engine/docs/Drugs.md

````markdown
# Drugs (pharmacology PK/PD)

The `Drugs` model is the **pharmacology PK/PD controller** — a process/controller model in the same
family as [`Hormones`](./Hormones.md) and `Ans`. It holds **no blood of its own**, resolves
references to other models **lazily** (the blood compartments are built by [`Circulation`](./Circulation.md)
after this model inits), runs each step, and **owns its effector channels while enabled** (releasing
them once to neutral on disable, gated by `drugs_running`). Default config is **neutral**: with no
drug present every concentration is `0`, so every `*_drug_factor` reads `1.0` (no effect) and a
scenario that ships a `Drugs` model behaves identically until a dose is given.

The novelty versus `Hormones` is that the "signal" being controlled is an actual **drug mass that
rides the blood circuit** — `Drugs` does not transport anything itself; it seeds a drug key into
every blood compartment's `drugs{}` dict and lets the engine's existing `volume_in` mixing advect it,
exactly as Na/K solutes propagate (see [`BloodCapacitance`](./BloodCapacitance.md)).

## Per-drug causal loop

```
SOURCE (dosing)          TRANSPORT (free)            SINK (clearance)            BIOPHASE         EFFECT (summed)
injection_site.drugs{}   volume_in mixing carries    diffuse global term on      optional ke0     sigmoid Emax/Hill per drug
  bolus    C += dose/vol the seeded drug key around  EVERY compartment  +        effect-comp lag  SUMMED onto shared channels:
  infusion C += rate·wt  the whole circuit, by       organ-localized intrinsic   dCe/dt =         Heart.hr_drug_factor   (β1 chrono)
           /60·dt/vol     incoming-volume fraction    clearance at named sites    ke0·(C−Ce)       chamber.el_max_drug_factor (β1 ino)
  (mcg → ng/mL)          (drugs ride blood, free)    (KID_CAP/LS_CAP, perf.-scl.) → hysteresis    Circulation.svr_factor_drug (α1)
                                                                                                   Pda.diameter_drug_factor (PGE1)
```

- **SOURCE** — dosing injects drug mass into the `injection_site` compartment's `drugs{}` dict
  (default `IVCI`, a central vein). A **bolus** adds `dose / vol` (dose in mcg, vol in L → ng/mL); a
  weight-based **infusion** adds `(rate · weight / 60) · dt / vol` each step (rate in mcg/kg/min).
- **TRANSPORT** — handled entirely by the engine. `Drugs` only **seeds** the drug key (value `0.0`)
  into every blood-carrying compartment once (`_seed_drugs`, lazily on first step); the existing
  `volume_in` mixing then advects it for free, like solutes. Blood model types that participate:
  `BloodVessel`, `HeartChamber`, `BloodCapacitance`, `BloodTimeVaryingElastance`, `BloodPump`,
  `MicroVascularUnit`.
- **SINK** — elimination is a **diffuse first-order** term (`clearance.global`, 1/s, e.g. COMT/MAO/
  uptake) decaying the drug on **every** compartment, **plus** organ-localized **intrinsic clearance**
  (`clearance.sites`, 1/s) at named clearing compartments (e.g. `KID_CAP` renal, `LS_CAP` hepatic).
  Because those organs are continuously perfused, the localized term behaves as a **well-stirred
  organ model**: whole-body clearance scales with organ blood flow — if perfusion falls the drug
  lingers, exactly like real renal/hepatic clearance.
- **BIOPHASE** — an optional effect compartment per drug, `dCe/dt = ke0·(C_site − Ce)`. With
  `ke0 > 0` the PD map is driven by the lagged biophase concentration `Ce`, giving onset/offset
  **hysteresis** (effect peak trails plasma peak). `ke0 = 0` (default) → PD uses the effect-site conc
  directly.
- **EFFECT** — each drug contributes an independent sigmoid `effect = emax·c^n / (ec50^n + c^n)`
  (`_emax`), and contributions are **summed across all enabled drugs** onto the shared
  `*_drug_factor` channels, so drugs **compose additively** rather than overwrite. `_emax` returns
  `0` for any effect a drug leaves undefined (`emax` undefined), so drugs compose without every drug
  defining every channel.

The effect-site concentration is read from the `effect_site` compartment (default `AA`, a systemic
artery). Concentration unit convention throughout: **mcg/L ≡ ng/mL** (dose in mcg, blood volumes in L).

## Effector channels (owned, default-neutral)

| Channel | Target | Pharmacology |
|---|---|---|
| `hr_drug_factor` | [`Heart`](./Heart.md)`.hr_drug_factor` | β1 chronotropy (heart rate) |
| `cont_drug_factor` | each chamber's `el_max_drug_factor` (via the Heart inotropy path, mirroring Mob) | β1 inotropy (contractility) |
| `svr_drug_factor` | [`Circulation`](./Circulation.md)`.svr_factor_drug` | α1 systemic vasoconstriction |
| `pda_drug_factor` | [`Pda`](./Pda.md)`.diameter_drug_factor` | ductal patency (PGE1) |

Inotropy is fanned to every heart chamber through the `Heart`'s resolved chamber refs
(`_lv`/`_rv`/`_la`/`_raivci`/`_rasvc`/`_ra`), exactly as `Mob` writes `el_max_mob_factor`. The SVR
channel is independent of the ANS and Hormones channels (`svr_factor_art/_ven`), so they compose.

## Drugs currently defined (`drug_defs`)

| Drug | PK (`clearance`) | PD effects |
|---|---|---|
| `adrenaline` | global 0.022 + sites KID_CAP 0.6 / LS_CAP 0.9 / INT_CAP 0.4 | HR (ec50 20, emax 0.6), cont (ec50 25, emax 0.8), SVR (ec50 40, emax 0.5) |
| `noradrenaline` | global 0.018 + sites KID_CAP 0.6 / LS_CAP 1.0 / INT_CAP 0.4 | predominantly α1 SVR (ec50 25, emax 0.9), modest cont (emax 0.35), minimal HR (emax 0.1) |
| `pge1` | global 0.08, no sites | **ductal patency only** — `pda_ec50 0.02`, `pda_emax 1.5`, `pda_hill 1.0` |

**PGE1 (prostaglandin E1 / alprostadil)** is the duct-dependent-CHD agent: its **only** effect is
ductal patency through the channel `Pda.diameter_drug_factor`. Its very low `pda_ec50` (0.02 ng/mL)
reflects a **potent + heavily cleared** drug — extensive pulmonary first-pass metabolism (~80% per
lung pass, hence the high `global` clearance, short half-life, and need for continuous infusion)
yields a low effect-site conc (~0.01–0.05 ng/mL at a clinical 0.01–0.05 mcg/kg/min infusion) that
sits on the sigmoid's rising limb. `pda_emax 1.5` allows up to a ~2.5× patency factor at saturation
(capped at the anatomic maximum inside [`Pda`](./Pda.md)). It defines no HR/inotropy/SVR params — and
because `_emax` is undefined-safe, drugs **compose without every drug defining every channel**
(PGE1 has only `pda_*`; the catecholamines only `hr_*`/`cont_*`/`svr_*`).

### The `init_model` merge

`init_model` captures the constructor's full built-in `drug_defs`, lets `super.init_model(args)`
overwrite it with whatever a scenario baked, then merges:

```js
this.drug_defs = { ...default_defs, ...this.drug_defs };
```

Scenario tuning wins for drugs it defines, but any **newly-added built-in drug** the baked state
predates (e.g. `pge1`, added after older scenarios were serialized) is still present — so new drugs
become available in **old scenarios without re-baking the JSON**.

## Dosing API

Callable via `callModelFunction` / the `TaskScheduler` (see the engine docs):

| Method | Effect |
|---|---|
| `administer_bolus(drug, dose_mcg)` | instantaneous IV bolus — adds `dose_mcg / vol` to the injection-site `drugs{}` |
| `set_infusion(drug, rate_mcg_kg_min)` | start/stop a weight-based continuous infusion; `rate 0` stops it |
| `set_drug_param(drug, param, value)` | set a PK/PD constant via a **dotted path** into the per-drug def (e.g. `"hr_emax"`, `"ke0"`, `"clearance.global"`) — the nested dict is unreachable by the flat `setPropValue` path |

## Read-outs

| Read-out | Meaning |
|---|---|
| `concentrations` | `{ drug: effect-site conc (ng/mL) }` |
| `biophase` | `{ drug: effect-compartment conc Ce (ng/mL) }` (= site conc when `ke0 = 0`) |
| `conc_inj` / `conc_eff` | adrenaline injection-site / effect-site conc (convenience) |
| `hr_drug_factor` / `cont_drug_factor` / `svr_drug_factor` / `pda_drug_factor` | applied (summed) effector factors (1.0 = no effect) |
| `infusions` | active continuous infusions `{ drug: rate_mcg_kg_min }` |

## Notes / scope

- While enabled, `Drugs` **owns** the four `*_drug_factor` channels (`Heart.hr_drug_factor`, each
  chamber's `el_max_drug_factor`, `Circulation.svr_factor_drug`, `Pda.diameter_drug_factor`) — manual
  edits are overwritten each step. The clean "off" switch is `drugs_running = false`, which releases
  all owned channels back to `1.0` exactly once.
- Adding a drug = a new `drug_defs` entry; it is seeded, transported, cleared and aggregated
  automatically. Surfacing per-drug params + dosing methods to the UI registry is the next milestone.

## See also
[`Heart`](./Heart.md) · [`Circulation`](./Circulation.md) · [`Pda`](./Pda.md) ·
[`Hormones`](./Hormones.md) · [`BloodCapacitance`](./BloodCapacitance.md)

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
- A selectable cannula library (real Bio-Medicus / Medtronic Crescent devices) that sets cannula
  geometry and resistance.
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
| `ECLS_OXY` | BloodVessel | Membrane oxygenator; blood side of the gas exchanger; roller drive sets `p1_ext` |
| `ECLS_TUBING_OUT` | BloodCapacitance/BloodVessel | Outflow tubing; its pressure is reported as `p_art` |
| `ECLS_RETURN` | Resistor | Return cannula (`ECLS_TUBING_OUT → return_site`); its flow ×60 is `flow` |
| `ECLS_GAS_SOURCE` | GasCapacitance | Sweep-gas source (composition from `gas_fio2`/`gas_fico2`/…) |
| `ECLS_GAS_INSP_VALVE` | Resistor | Sweep-gas inlet valve (resistance set from `gas_flow`) |
| `ECLS_GAS_OXY` | GasCapacitance | Gas side of the oxygenator |
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
| `drainage_site` | string | Patient compartment the drainage cannula drains (default `RA`) |
| `return_site` | string | Patient compartment the return cannula feeds (default `AAR`) |
| `drainage_cannula_type` | string | Key into `drainage_cannulas` (default `Bio-Medicus venous 12 Fr`) |
| `return_cannula_type` | string | Key into `return_cannulas` (default `Bio-Medicus arterial 10 Fr`) |
| `drainage_res_factor` | × | Multiplier on drainage-cannula resistance (default 1.0) |
| `return_res_factor` | × | Multiplier on return-cannula resistance |
| `tubing_res_factor` | × | Multiplier on both tubing resistances |
| `pump_res_factor` | × | Multiplier on pump resistance |
| `oxy_res_factor` | × | Multiplier on oxygenator resistance |
| `oxy_res_for` / `oxy_res_back` | mmHg/(L/s) | Oxygenator resistance (default 1500/1500) |
| `oxy_vol` | L | Oxygenator volume (default 0.09) |
| `pump_res_for` / `pump_res_back` | mmHg/(L/s) | Pump resistance (default 50/50) |
| `pump_vol` | L | Pump volume (default 0.031) |
| `pump_rpm` | rpm | Pump speed (default 1500) |
| `pump_mode` | 0/1 | 0 = centrifugal (drives the pump), 1 = roller (drives the oxygenator) |
| `gas_flow` | L/min | Sweep-gas flow (default 0.5) |
| `gas_fio2` | fraction | Sweep-gas FiO₂ (default 0.205) |
| `gas_fico2` | fraction | Sweep-gas FiCO₂ (default 0.000392) |
| `gas_humidity` | fraction | Sweep-gas humidity (default 0.5) |
| `gas_temp` | °C | Sweep-gas temperature (default 20) |
| `dif_o2` | mmol/(mmHg·s) | Gas-exchanger O₂ diffusion constant (default 0.0005) |
| `dif_co2` | mmol/(mmHg·s) | Gas-exchanger CO₂ diffusion constant (default 0.001) |
| `drainage_cannula_diameter` / `_length` | m | Drainage cannula geometry (copied from the selected library entry) |
| `return_cannula_diameter` / `_length` | m | Return cannula geometry (copied from the selected library entry) |
| `tubing_in_diameter`/`_length`, `tubing_out_diameter`/`_length` | m | Tubing geometry |
| `cannula_sizes_single`, `cannula_size_double` | Fr | Available cannula sizes (UI metadata) |
| `return_cannulas`, `drainage_cannulas` | dict | Cannula library (inner diameter, length, resistance per device) |

### Computed (dependent) read-outs

| Property | Unit | Description |
|---|---|---|
| `p_ven` | mmHg | Filtered (moving-average) venous/inlet pressure (`ECLS_TUBING_IN.pres`) |
| `p_int` | mmHg | Filtered pressure at the pump interface (`ECLS_PUMP.pres`) |
| `p_art` | mmHg | Filtered arterial/outlet pressure (`ECLS_TUBING_OUT.pres`) |
| `flow` | L/min | Circuit blood flow (`ECLS_RETURN.flow × 60`) |
| `flow_avg` | L/min | Moving-average of `flow` |
| `pump_pressure` | mmHg | Pump drive pressure = `−pump_rpm / 25` |
| `sat_ven_o2` | % | Venous (pre-oxygenator) O₂ saturation |
| `sat_postoxy_o2` | % | Post-oxygenator O₂ saturation |
| `pco2_postoxy` | mmHg | Post-oxygenator pCO₂ |
| `drainage_res` / `return_res` | mmHg/(L/s) | Active cannula resistances (from the selected library entry) |
| `tubing_in_res` / `tubing_out_res` | mmHg/(L/s) | Tubing resistances |
| `tubing_in_vol` / `tubing_out_vol` | L | Tubing volumes |

### Internal (`_`-prefixed) and moving averages

`prev_fio2` / `prev_fico2` / `prev_gas_flow` detect sweep-gas changes so compositions/valve resistance
are only recomputed when needed. `_update_interval` (0.015 s) and `_update_counter` gate the main
control block; `_blood_comp_interval` (1.0 s) and `_blood_comp_counter` gate the blood-gas read-outs.
`pressure_avg_window` / `flow_avg_window` (default 400 samples, ≈0.9 s at the 0.015 s update rate)
size the four [`RealTimeMovingAverage`](./RealTimeMovingAverage.md) filters
(`_flow_avg_calculator`, `_p_ven_avg_calculator`, `_p_int_avg_calculator`, `_p_art_avg_calculator`).

## Cannula library

`drainage_cannulas` / `return_cannulas` are dictionaries of real devices (Bio-Medicus, Medtronic
Crescent), each with an `inner_diameter` (m), `length` (m) and measured `resistance` (mmHg/(L/s)).
Setting `drainage_cannula_type` / `return_cannula_type` copies the matching entry's geometry and
resistance into the active `*_cannula_*` / `*_res` parameters — once in the constructor, and re-checked
each tick in `calc_model`.

## Calculation cycle (`calc_model`)

**When `ecls_running` is false:** zero `flow`/`flow_avg`/`p_ven`/`p_int`/`p_art`, reset the four
moving-average filters and `_blood_comp_counter`, and **disable every circuit sub-model** so a stopped
circuit no longer conducts passive flow, then return. (Sub-model refs are only non-null once the
circuit has run.)

**When running**, every `_update_interval` (0.015 s):

1. Rebuild any moving-average filter whose window size changed (`flow_avg_window` /
   `pressure_avg_window`).
2. Resolve the eleven `ECLS_*` sub-model references; **skip the tick** if any is missing.
3. Apply `drainage_site` / `return_site` to the cannula resistors, and copy the selected cannula
   geometry/resistance from the library.
4. Sync every sub-model's `is_enabled` to `ecls_running`; set `no_flow = ecls_clamped` on all blood
   sub-models; enable `ECLS_GASEX` only when **unclamped** (`is_enabled = !ecls_clamped`).
5. Push resistances onto each sub-model: cannula/tubing/pump/oxygenator resistance × its `*_res_factor`.
6. Recompute the sweep-gas composition when `gas_fio2`/`gas_fico2` changed, and the inspiratory-valve
   resistance when `gas_flow` changed.
7. Update `ECLS_GASEX.dif_o2` / `dif_co2`.
8. **Pump drive** (see below).
9. Read raw pressures, push them through the moving-average filters into `p_ven`/`p_int`/`p_art`, set
   `flow` (= `ECLS_RETURN.flow × 60`) and `flow_avg`.
10. Once per `_blood_comp_interval` (1.0 s), recompute blood composition on the two tubing
    compartments and read out `sat_ven_o2`, `sat_postoxy_o2`, `pco2_postoxy`.

### Pump drive

```
pump_pressure = −pump_rpm / 25
pump_mode 0 (centrifugal): ECLS_PUMP.p1_ext = 0,   ECLS_PUMP.p2_ext = pump_pressure
pump_mode 1 (roller):      ECLS_OXY.p1_ext = pump_pressure,   ECLS_OXY.p2_ext = 0
```

The negative external pressure on the downstream node creates the pressure gradient that drives flow
through the circuit (the resistors compute flow from the resulting node pressures).

### Sweep-gas inlet valve

When `gas_flow` changes, the inlet-valve resistance is sized from the source-to-out pressure drop and
the requested flow:

```
res = (ECLS_GAS_SOURCE.pres − ECLS_GAS_OUT.pres) / (gas_flow / 60)
if res > 60: ECLS_GAS_INSP_VALVE.r_for = res − 50
```

## Factor system

`Ecls` uses **plain resistance multipliers** (`drainage_res_factor`, `return_res_factor`,
`tubing_res_factor`, `pump_res_factor`, `oxy_res_factor`), not the engine's three-tier
`*_factor` / `*_factor_ps` / `*_factor_scaling_ps` pattern. Each multiplier scales the corresponding
cannula/tubing/pump/oxygenator resistance before it is written onto the sub-model's `r_for`/`r_back`.
The underlying `ECLS_*` blood sub-models still carry their own three-tier factor layers (see
[BloodVessel](./BloodVessel.md) / [Resistor](./Resistor.md)), but `Ecls` overwrites their `r_for`
directly each tick.

## Example definition (JSON)

Device-level fields from `term_neonate.json` (the full block nests eleven `ECLS_*` sub-models under
`components`, and embeds the cannula library):

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
  "ecls_running": true,
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

Note `ecls_clamped: true` ships the circuit on but clamped — no blood flows until it is unclamped.

## Usage in the model

- Used to model VA/VV ECMO support of a patient. Set `drainage_site`/`return_site` to the patient
  compartments the cannulas are inserted into, pick cannula types, then set `ecls_running = true` and
  `ecls_clamped = false` and dial `pump_rpm` / `gas_flow` / `gas_fio2`.
- Reports `flow_avg`, `p_ven`/`p_int`/`p_art`, `sat_ven_o2`/`sat_postoxy_o2`/`pco2_postoxy` for the
  monitor.
- The blood sub-models exchange composition with the patient circuit through the named site
  compartments, so circuit O₂/CO₂ propagate back into the patient via the standard
  [BloodCapacitance](./BloodCapacitance.md) mixing.

## Notes & caveats

- **Stopping the circuit disables it.** The off-branch sets `is_enabled = false` on all sub-models, so
  a stopped ECLS no longer conducts passive flow.
- **References are resolved lazily** each tick while running; a missing sub-model skips the tick rather
  than dereferencing undefined.
- **Pump logic is duplicated.** The `pump_pressure = −pump_rpm/25` computation mirrors
  `BloodPump.calc_pressure`; `ECLS_PUMP` is a [`BloodVessel`](./BloodVessel.md) driven externally
  rather than a `BloodPump`.
- **`flow` is reported in L/min** (`× 60`) even though the source comment labels it L/s.

````

### FILE: explain-engine/docs/Fluids.md

````markdown
# Fluids

The `Fluids` model administers **intravenous fluids** — boluses and infusions — into a blood
compartment over a set time. It is a small scheduler: a call queues a fluid, and each update step it
drips a fraction of that fluid's volume (with its solute composition) into the target compartment via
the compartment's `volume_in`. It holds no volume itself; it pushes volume and composition onto an
existing blood compartment.

## Inheritance

```
BaseModelClass
  └── Fluids   (IV fluid/infusion scheduler)
```

Fluids extends `BaseModelClass` directly. It owns no compartment and declares no `components`; it
mutates the blood compartments named as infusion sites through their `volume_in` method (see
[`BloodCapacitance`](./BloodCapacitance.md)).

## What it models

A queue of in-progress infusions. Each queued fluid carries a target site, a per-step volume
increment, a remaining time, and a solute composition drawn from the `fluids` library. Every update
interval the scheduler delivers each fluid's increment and advances its timer, removing fluids whose
time has elapsed.

## Properties

### Configuration (independent)

| Property | Unit | Description |
|---|---|---|
| `fluids_temp` | °C | Temperature stamped on every administered fluid (default 37.0) |
| `fluids` | object | Library `{ fluidType: { solute: concentration, … } }` of available fluids |
| `default_volume` | mL | Default bolus volume offered to the UI |

### Local / internal (`_`-prefixed)

| Property | Unit | Description |
|---|---|---|
| `_update_interval` | s | Processing cadence (`0.015`) |
| `_update_counter` | s | Accumulates `_t` toward `_update_interval` |
| `_running_fluid_list` | array | Queue of in-progress fluid objects |
| `_default_time` | s | Vestigial default infusion time (unused) |
| `_default_type` | string | Vestigial default fluid type (unused) |

Fluids publishes no dependent read-out properties.

## Administering a fluid — `add_volume(volume, in_time, fluid_in, site)`

| Argument | Default | Meaning |
|---|---|---|
| `volume` | — | volume to give, in **mL** |
| `in_time` | 10 | duration over which to give it, in **seconds** |
| `fluid_in` | `"normal_saline"` | fluid type — key into the `fluids` dictionary for the solute mix |
| `site` | `"VLB"` | name of the target blood compartment |

It builds a fluid object and pushes it onto the running list:

```
vol       = volume / 1000                                  (mL → L)
time_left = in_time                                        (s)
delta     = (volume/1000) / (in_time / _update_interval)   (L delivered per processing step)
solutes   = { ...fluids[fluid_in] }                        (composition of the chosen fluid)
to2 = tco2 = 0,  temp = fluids_temp,  viscosity = 1,  drugs = {}
```

`delta` is sized so the full volume is delivered across the `in_time / _update_interval` processing
steps. An unknown `fluid_in` yields empty solutes (`{...undefined}` → `{}`), i.e. a solute-free
fluid, rather than an error.

## Processing — `process_fluid_list` (every `_update_interval`, 0.015 s)

`calc_model` accumulates `_t` into `_update_counter`; once it exceeds `_update_interval` the counter
resets and `process_fluid_list` runs:

1. **Drop finished fluids** — `removeByProperty` filters out any with `time_left ≤ 0`.
2. **For each remaining fluid:**
   - Deliver this step's increment: `models[site]?.volume_in(delta, fluid)` — the compartment adds
     `delta` litres and mixes in the fluid's composition (solutes, temperature, viscosity) by volume
     fraction. (See [`BloodCapacitance`](./BloodCapacitance.md)'s `volume_in` mixing logic.)
   - Decrement `vol` by `delta` and advance the timer (`time_left -= _update_interval`); when it
     reaches 0, zero the delta so no further volume is added before the fluid is removed next cycle.

The delivery happens **before** the timer/zeroing, so the final increment is actually administered.

## Notes & caveats

- **Full dose is delivered.** The increment is applied before the timer is zeroed; an earlier ordering
  zeroed the last `delta` before delivering it, losing one step's worth — negligible for a long
  infusion but significant for a short bolus (a one-step bolus delivered nothing).
- **Missing target site is skipped** (optional-chaining guard) rather than throwing.
- **Composition is gas-free and low-viscosity.** Administered fluid carries `to2 = tco2 = 0` and
  `viscosity = 1`, so a large bolus dilutes the compartment's oxygen/CO₂ content and lowers its
  viscosity — the intended haemodilution effect.
- **Vestigial fields.** `fluid.vol` is decremented but not used as a stop condition (delivery is
  timer-driven); `_default_time` / `_default_type` are unused.

## Example definition (JSON)

From `term_neonate.json`:

```json
{
  "name": "Fluids",
  "description": "fluids model",
  "is_enabled": true,
  "model_type": "Fluids",
  "components": {},
  "fluids_temp": 37,
  "fluids": {
    "normal_saline":  { "na": 154, "cl": 154 },
    "ringers_lactate":{ "na": 130, "cl": 109, "ca": 1.4, "k": 4 },
    "packed_cells":   { "hemoglobin": 12 },
    "albumin_20%":    { "albumin": 20 },
    "d5":             { "glucose": 278 },
    "d10":            { "glucose": 555 }
  },
  "default_volume": 10
}
```

(The adult `adult_female.json` scenario ships the same library with `default_volume: 250`.)

## Usage in the model

- One Fluids instance per scenario; the UI exposes `add_volume` (via the model-interface registry) so
  the user can give boluses/infusions interactively, and scenario events can schedule infusions.
- Targets any blood compartment by name; the default site `VLB` is the lower-body venous pool.
- Solute keys in the `fluids` library must match the solute names tracked on the target compartment
  (`na`, `cl`, `ca`, `k`, `hemoglobin`, `albumin`, `glucose`, …) so they mix correctly through
  [`BloodCapacitance`](./BloodCapacitance.md)'s composition mixing.

````

### FILE: explain-engine/docs/Gas.md

````markdown
# Gas

The `Gas` model is a **manager** for the gas-containing compartments — the gas-phase analogue of
[`Blood`](./Blood.md). It is not itself a compartment: it seeds atmospheric pressure, temperature,
humidity and the initial gas composition onto every [`GasCapacitance`](./GasCapacitance.md) at build,
and exposes setters to change those at runtime. Its `calc_model` is empty; the per-compartment
chemistry is done by `GasCapacitance` and the gas-exchange/diffusion elements.

## Inheritance

```
BaseModelClass
  └── Gas   (gas-system manager — atmospheric pressure, temperature, humidity, initial composition)
```

## What it models

Global gas-phase boundary conditions. At build it walks `model.models`, collects every model whose
`model_type` is in `gas_containing_modeltypes` (default `["GasCapacitance"]`), and pushes the shared
`pres_atm`/`temp`/`target_temp` onto each. It then overrides individual compartments with any
per-site `temp_settings` / `humidity_settings`, and bootstraps each freshly-constructed compartment's
gas composition from the global `fio2` via the standalone
[`calc_gas_composition`](./GasComposition.md). At runtime its setters re-apply these boundary
conditions (atmospheric pressure, temperature, humidity, FiO₂) to chosen sites.

## Properties

### Config

| Property | Unit | Description |
|---|---|---|
| `pres_atm` | mmHg | Atmospheric pressure (default 760), propagated to every gas compartment |
| `fio2` | fraction | Inspired O₂ fraction (default 0.21) used to bootstrap compositions |
| `temp` | °C | Global gas temperature (default 20) applied as both `temp` and `target_temp` |
| `humidity` | fraction | Global gas humidity 0–1 (default 0.5) |
| `temp_settings` | object | Map `compartment_name → temperature (°C)` overriding the global temp per site |
| `humidity_settings` | object | Map `compartment_name → humidity (fraction)` overriding the global humidity per site |
| `gas_containing_modeltypes` | list | Model types treated as gas compartments (default `["GasCapacitance"]`) |

### Local / computed

| Property | Description |
|---|---|
| `_gas_components` | Array of resolved gas-compartment instances, populated in `init_model` |

`Gas` carries no factor parameters of its own.

## Bootstrap (`init_model`)

1. Apply the `args` (config) onto the instance.
2. Rebuild `_gas_components`: for every model whose `model_type` is in `gas_containing_modeltypes`,
   push it and set `model.pres_atm = pres_atm`, `model.temp = temp`, `model.target_temp = temp`.
3. For each entry in `temp_settings`, set that compartment's `temp` **and** `target_temp`.
4. For each entry in `humidity_settings`, set that compartment's `humidity`.
5. **Bootstrap composition only for freshly-constructed compartments** — those whose
   `co2 + cco2 + cn2 + ch2o + cother === 0` — by calling
   `calc_gas_composition(model, fio2, model.temp, model.humidity)`. Guarding on the raw
   concentrations (rather than the derived `ctotal`) preserves a restored/loaded saved state even if
   `ctotal` was not serialized.

`calc_model` is intentionally empty.

## Setters (runtime)

- **`set_atmospheric_pressure(new_pres_atm)`** — set `pres_atm` and propagate it to every compartment
  in `_gas_components`.
- **`set_temperature(new_temp, sites = ["OUT", "MOUTH"])`** — record `temp_settings[site]` for each
  site (`parseFloat`), then apply `temp` **and** `target_temp` to all recorded sites.
- **`set_humidity(new_humidity, sites = ["OUT", "MOUTH"])`** — record `humidity_settings[site]`
  (`parseFloat`) and apply `humidity` to all recorded sites.
- **`set_fio2(new_fio2, sites = ["OUT", "MOUTH"])`** — set `fio2` (`parseFloat`, to avoid string
  concatenation corrupting the `1 − (fio2 + fico2)` fraction math), then re-derive each site's
  composition via the standalone [`calc_gas_composition`](./GasComposition.md) at that site's current
  `temp`/`humidity`.

## Example definition (JSON)

From `term_neonate.json` — note the per-site temperature/humidity profile (cool, half-humid mouth;
warm, fully-saturated alveoli):

```json
{
  "name": "Gas",
  "description": "gas composition model",
  "model_type": "Gas",
  "is_enabled": true,
  "pres_atm": 760,
  "fio2": 0.21,
  "temp": 20,
  "humidity": 0.5,
  "humidity_settings": { "MOUTH": 0.5, "DS": 1, "ALL": 1, "ALR": 1 },
  "temp_settings": { "MOUTH": 20, "DS": 32, "ALL": 37, "ALR": 37 },
  "gas_containing_modeltypes": ["GasCapacitance"]
}
```

## Usage in the model

- Built once per scenario; runs first so every [`GasCapacitance`](./GasCapacitance.md) starts with a
  consistent pressure/temperature/humidity and a physiological room-air (or FiO₂-set) composition.
- The setters are the entry points the UI / `Ventilator` / `Ecls` and the bot use to change inspired
  oxygen, ambient pressure, and airway conditioning at runtime.
- Compartments not listed in `humidity_settings` start at the global `humidity` and are humidified
  over time by `GasCapacitance.add_watervapour`.
- The gas chemistry itself is documented in [`GasComposition`](./GasComposition.md) and
  [`GasCapacitance`](./GasCapacitance.md).

````

### FILE: explain-engine/docs/GasCapacitance.md

````markdown
# GasCapacitance

A `GasCapacitance` is a volume compartment that holds **gas** instead of blood. It extends the base
[`Capacitance`](./Capacitance.md) with gas-specific state: a five-species composition
(O₂, CO₂, N₂, water vapour, "other") tracked as concentrations, partial pressures and fractions,
plus temperature/humidity dynamics and the atmospheric/external pressures relevant to a gas space.
It models airways, alveoli and the gas side of devices (ventilator circuit, ECLS sweep gas).

## Inheritance

```
BaseModelClass
  └── Capacitance          (volume, elastance, pressure)
        └── GasCapacitance (gas composition, heat, water vapour, atmospheric/external pressures)
```

Gas flow into and out of a `GasCapacitance` is handled by separate `Resistor` models that reference
it (e.g. `MOUTH_DS` connecting `MOUTH` → `DS`). Diffusion of individual species is handled by
[`GasExchanger`](./GasExchanger.md) (gas ↔ blood) and [`GasDiffusor`](./GasDiffusor.md) (gas ↔ gas).

## What it models

A passive gas-containing compartment. It holds a volume of gas at a pressure determined by its
elastance plus the surrounding pressures (atmospheric, chest-compression, muscle), and tracks the
composition of that gas. Each step it relaxes its temperature toward a target, evaporates water
vapour toward saturation, recomputes pressure, and re-derives the partial pressures and fractions
from the current concentrations. Like its parent it has no built-in resistance or flow.

## Properties

### Inherited from Capacitance

See [`Capacitance`](./Capacitance.md) for the full list and the factor system. Key ones:

| Property | Unit | Description |
|---|---|---|
| `u_vol` | L | Unstressed volume (config) |
| `el_base` | mmHg/L | Baseline elastance (config) |
| `el_k` | unitless | Non-linear elastance coefficient (config) |
| `pres_ext` | mmHg | External pressure, non-persistent — cleared each step (config) |
| `fixed_composition` | bool | Freeze volume and composition (infinite reservoir) (config) |
| `vol` | L | Current volume (computed) |
| `pres` | mmHg | Total pressure (computed) |
| `pres_in` | mmHg | Recoil pressure (computed) |
| `pres_tm` | mmHg | Transmural pressure (computed) |

`GasCapacitance` also re-initializes `fixed_composition` to `false` in its own constructor.

### Config (unique to GasCapacitance)

| Property | Unit | Description |
|---|---|---|
| `pres_atm` | mmHg | Atmospheric pressure (default 760); set by the [`Gas`](./Gas.md) manager at build |
| `pres_cc` | mmHg | Chest-compression external pressure, non-persistent — cleared each step |
| `pres_mus` | mmHg | Muscle external pressure, non-persistent — cleared each step |
| `target_temp` | °C | Temperature the gas relaxes toward (set per-site by `Gas`) |
| `temp` | °C | Current gas temperature (also runtime state; seeded by `Gas`) |
| `humidity` | fraction | Relative humidity 0–1 (seeded by `Gas`) |

### Computed (gas state)

Concentrations are in mmol/L; partial pressures in mmHg; fractions are unitless 0–1.

| Property | Unit | Description |
|---|---|---|
| `ctotal` | mmol/L | Total gas molecule concentration (`ch2o + co2 + cco2 + cn2 + cother`) |
| `co2` | mmol/L | Oxygen concentration (note: the name is "concentration of O₂", not CO₂) |
| `cco2` | mmol/L | Carbon dioxide concentration |
| `cn2` | mmol/L | Nitrogen concentration |
| `ch2o` | mmol/L | Water vapour concentration |
| `cother` | mmol/L | Other-gases concentration |
| `po2` | mmHg | Partial pressure of O₂ |
| `pco2` | mmHg | Partial pressure of CO₂ |
| `pn2` | mmHg | Partial pressure of N₂ |
| `ph2o` | mmHg | Partial pressure of water vapour |
| `pother` | mmHg | Partial pressure of other gases |
| `pres_rel` | mmHg | Pressure relative to atmospheric (`pres − pres_atm`) |
| `fo2` | fraction | Fraction of O₂ |
| `fco2` | fraction | Fraction of CO₂ |
| `fn2` | fraction | Fraction of N₂ |
| `fh2o` | fraction | Fraction of water vapour |
| `fother` | fraction | Fraction of other gases |

`_gas_constant = 62.36367` (L·mmHg/(mol·K)) is a local constant used by `add_heat` / `add_watervapour`.

## Factor system

`GasCapacitance` inherits the full three-tier factor system from [`Capacitance`](./Capacitance.md)
acting on `el_base`, `u_vol` and `el_k`:

| Tier | Factors | Purpose |
|---|---|---|
| Non-persistent | `el_base_factor`, `u_vol_factor`, `el_k_factor` | Transient effects, reset to 1.0 each step |
| Persistent (`_ps`) | `el_base_factor_ps`, `u_vol_factor_ps`, `el_k_factor_ps` | Ongoing modulation (e.g. lung recruitment) |
| Scaling (`_scaling_ps`) | `el_base_factor_scaling_ps`, `u_vol_factor_scaling_ps`, `el_k_factor_scaling_ps` | `ModelScaler` weight/manual scaling |

The gas composition itself is **not** factor-driven (no `*_factor` on the concentrations).

## Calculation cycle (`calc_model`)

`GasCapacitance` overrides `calc_model` (it does not simply inherit the Capacitance cycle):

1. **`add_heat`** — relax `temp` toward `target_temp`: `dT = (target_temp − temp) · 0.0005`, then
   `temp += dT`. Adjust volume for the temperature change via the ideal gas law
   `dV = (ctotal · vol · R · dT) / pres` (added as `dV / 1000`); skipped when `fixed_composition`.
   Volume is floored at 0.
2. **`add_watervapour`** — drive `ch2o` toward the saturated vapour concentration:
   `dH2O = 0.00001 · (pH2Ot − ph2o) · Δt`, where `pH2Ot = calc_watervapour_pressure()`. The
   concentration update `ch2o = (ch2o·vol + dH2O) / vol` and the corresponding volume change are both
   skipped when `fixed_composition`.
3. **`calc_elastances` / `calc_volumes`** (inherited) compute `el_eff`, `u_vol_eff`, `el_k_eff`.
4. **`calc_pressure`** — calls `super.calc_pressure()` (recoil + `pres_ext`, then clears `pres_ext`),
   then adds the gas-space external pressures:
   ```
   pres     = pres_in + pres_ext + pres_cc + pres_mus + pres_atm
   pres_rel = pres − pres_atm
   pres_cc := 0;  pres_mus := 0          (both non-persistent, cleared each step)
   ```
5. **`calc_gas_composition`** (the method, see below) — recompute `ctotal` and derive partial
   pressures and fractions from the current concentrations.

### `calc_watervapour_pressure`

Saturated water-vapour pressure as a function of temperature (Kelvin via `+273.15`):

```
pH2Ot = exp(20.386 − 5132 / (temp + 273.15))
```

### `calc_gas_composition` (method)

Recomputes the total concentration and derives partials/fractions from the **current** species
concentrations (returns early if `ctotal === 0` to avoid division by zero):

```
ctotal = ch2o + co2 + cco2 + cn2 + cother
p_s    = (c_s / ctotal) · pres        for s ∈ {h2o, o2, co2, n2, other}
f_s    =  c_s / ctotal
```

This is distinct from the standalone [`calc_gas_composition`](./GasComposition.md) *initializer*,
which instead sets the concentrations from a target FiO₂/temperature/humidity mix.

## Composition mixing (`volume_in`)

`GasCapacitance` overrides `volume_in(dvol, comp_from)`. It calls `super.volume_in` to update the
volume, then mixes the incoming concentrations and temperature by volume fraction (the same
algebraically-correct dilution as [`BloodCapacitance`](./BloodCapacitance.md)):

```
co2  = (co2·vol  + (comp_from.co2  − co2)·dvol)  / vol      (and cco2, cn2, ch2o, cother)
temp = (temp·vol + (comp_from.temp − temp)·dvol) / vol
```

Mixing is **skipped for `fixed_composition`** compartments (an infinite reservoir holds its
composition and temperature constant) and **guarded against an empty compartment** (`vol <= 0`
returns early — no division by zero).

## Example definition (JSON)

A lung alveolar compartment (left lung) — non-fixed composition, warmed and humidified by the
[`Gas`](./Gas.md) manager:

```json
{
  "name": "ALL",
  "description": "gas capacitance model of the alveolar space of the left lung",
  "model_type": "GasCapacitance",
  "is_enabled": true,
  "u_vol": 0.04,
  "el_base": 186,
  "el_k": 0,
  "pres_ext": 0,
  "fixed_composition": false
}
```

A fixed-composition reservoir (ventilator gas source) keeps its composition and volume constant:

```json
{
  "name": "VENT_GASIN",
  "description": "gas reservoir of the mechanical ventilator",
  "model_type": "GasCapacitance",
  "is_enabled": false,
  "u_vol": 5,
  "el_base": 1000,
  "el_k": 0,
  "fixed_composition": true
}
```

(`temp`, `humidity`, `target_temp` and `pres_atm` are normally seeded by the [`Gas`](./Gas.md)
manager from its `temp_settings` / `humidity_settings` / `pres_atm`, rather than per-compartment.)

## Usage in the model

- Airway/alveolar chain: `MOUTH` (fixed-composition outside air) → `DS` (dead space) → `ALL`/`ALR`
  (left/right alveoli), wired by `Resistor`s; `GASEX_LL`/`GASEX_RL` exchange O₂/CO₂ between the
  alveoli and the lung-capillary blood.
- Device gas spaces: ventilator (`VENT_GASIN`/`VENT_GASCIRCUIT`/`VENT_GASOUT`) and ECLS
  (`ECLS_GAS_SOURCE`/`ECLS_GAS_OXY`/`ECLS_GAS_OUT`); the gas sources are `fixed_composition: true`.
- The [`Gas`](./Gas.md) manager discovers every `GasCapacitance` at build, seeds its pressure,
  temperature and humidity, and bootstraps the initial composition via the standalone
  [`calc_gas_composition`](./GasComposition.md).

````

### FILE: explain-engine/docs/GasComposition.md

````markdown
# GasComposition

`GasComposition.js` exports the standalone function
**`calc_gas_composition(gc, fio2 = 0.205, temp = 37, humidity = 1.0, fico2 = 0.000392)`** — an
**initializer** that sets a gas compartment's full composition from a target dry-gas mix and the
local temperature and humidity. It is the counterpart to the
[`GasCapacitance.calc_gas_composition`](./GasCapacitance.md) *method* (which instead derives partial
pressures from the compartment's already-present concentrations).

## Inheritance

This is **not a class** — it is a module-level function, so it has no inheritance chain. It takes a
gas-compartment instance `gc` (typically a [`GasCapacitance`](./GasCapacitance.md)) by reference and
writes its composition fields in place. It does not extend `BaseModelClass` and is not registered in
`ModelIndex.js`.

## What it models

The wet (humidified) gas composition of a compartment at its current pressure. Given a **dry**
inspired fraction of O₂ and CO₂, with N₂ (and "other") taking the remainder, it computes the
saturated water-vapour pressure at the compartment's temperature, removes that vapour pressure from
the available dry-gas pressure, and partitions the rest among O₂, CO₂, N₂ and "other" — yielding a
mutually consistent set of partial pressures, fractions and concentrations that sum to `ctotal`.

## Parameters

| Parameter | Default | Description |
|---|---|---|
| `gc` | — | The gas compartment to write (mutated in place) |
| `fio2` | 0.205 | Target **dry** O₂ fraction |
| `temp` | 37 | Temperature (°C) used for the gas law and vapour pressure |
| `humidity` | 1.0 | Relative humidity 0–1 |
| `fico2` | 0.000392 | Target **dry** CO₂ fraction |

Reference dry-air constants (module-local): `_fo2_dry = 0.205`, `_fco2_dry = 0.000392`,
`_fn2_dry = 0.794608`, `_fother_dry = 0.0`, `_gas_constant = 62.36367` (L·mmHg/(mol·K)).

## Calculation

### 1. Dry-gas fractions (re-normalize N₂ / other to the supplied O₂/CO₂)

```
new_fo2_dry    = fio2
new_fco2_dry   = fico2
new_fn2_dry    = _fn2_dry    · (1 − (fio2 + fico2)) / (1 − (_fo2_dry + _fco2_dry))
new_fother_dry = _fother_dry · (1 − (fio2 + fico2)) / (1 − (_fo2_dry + _fco2_dry))
```

### 2. Get a current pressure

It calls `gc.calc_model()` to ensure `gc.pres` is up to date, reads `pressure = gc.pres`, then
**persists** the supplied `temp` and `humidity` onto `gc` (so the compartment's own per-step
calculations stay consistent with the concentrations set below). If `pressure <= 0` it **returns
early** (a non-physical pressure would otherwise produce Infinity/NaN fractions).

### 3. Total concentration (ideal gas law)

```
ctotal = (pressure / (R · (273.15 + temp))) · 1000        (mmol/L)
```

### 4. Water vapour (saturated × humidity)

```
ph2o = exp(20.386 − 5132 / (temp + 273.15)) · humidity
fh2o = ph2o / pressure
ch2o = fh2o · ctotal
```

### 5. Partition the remaining (dry) pressure among each species

For each species `s ∈ {o2, co2, n2, other}`, the dry fraction is applied to the **non-vapour**
pressure `(pressure − ph2o)`, and the fraction/concentration follow:

```
p_s = new_f{s}_dry · (pressure − ph2o)
f_s = p_s / pressure
c_s = f_s · ctotal
```

(Recall `gc.co2` is the **oxygen** concentration — see [`GasCapacitance`](./GasCapacitance.md).)
All partial pressures, fractions and concentrations are thus mutually consistent and the
concentrations sum to `ctotal`.

## When it is used

To **seed or reset** a compartment to a known gas mix, never as the per-step update:

- at build, by [`Gas.init_model`](./Gas.md) for freshly-constructed compartments;
- when FiO₂ / temperature / humidity changes, via `Gas.set_fio2` (and the `Ventilator` / `Ecls`
  setters);
- on the ventilator / ECLS gas sources.

The per-step composition update is done by the [`GasCapacitance.calc_gas_composition`](./GasCapacitance.md)
*method*, which derives partials from existing concentrations and does **not** overwrite the mix.

## Notes

- The Kelvin conversions use `273.15` consistently (matching the per-step water-vapour formula in
  `GasCapacitance.calc_watervapour_pressure`).
- ⚠️ It **overwrites** the composition. Calling it on a diffusing compartment every step would reset
  it to the fixed inspired mix — which is exactly why [`GasDiffusor`](./GasDiffusor.md) and
  [`GasExchanger`](./GasExchanger.md) use the *method*, not this function.

````

### FILE: explain-engine/docs/GasDiffusor.md

````markdown
# GasDiffusor

A `GasDiffusor` diffuses gases between **two gas compartments**, driven by their partial-pressure
difference. It is the gas-to-gas analogue of [`BloodDiffusor`](./BloodDiffusor.md) (blood-to-blood)
and [`GasExchanger`](./GasExchanger.md) (blood-to-gas). It moves four species — O₂, CO₂, N₂ and
"other" — down their gradients between two [`GasCapacitance`](./GasCapacitance.md) compartments.

## Inheritance

```
BaseModelClass
  └── GasDiffusor   (partial-pressure-driven gas-to-gas diffusion of O₂/CO₂/N₂/other)
```

Lives in `base_models/` (alongside `GasExchanger` and `BloodDiffusor`). It is a transport element,
not a compartment: it holds no volume and writes directly into the two compartments it references.

## What it models

```
gas1 (po2, pco2, pn2, pother)  ⇌[GasDiffusor]⇌  gas2 (...)
   flux_s = (p1_s − p2_s) · dif_s_step · Δt        for s ∈ {o2, co2, n2, other}
```

Each step it refreshes both compartments' partial pressures from their current concentrations,
composes the effective diffusion constants, then for each species moves the flux out of `comp_gas1`
and into `comp_gas2`.

## Properties

### Config

| Property | Unit | Description |
|---|---|---|
| `comp_gas1` | name | First gas compartment (the `p1` side) |
| `comp_gas2` | name | Second gas compartment (the `p2` side) |
| `dif_o2` | mmol/(mmHg·s) | O₂ diffusion constant (default 0.01) |
| `dif_co2` | mmol/(mmHg·s) | CO₂ diffusion constant (default 0.01) |
| `dif_n2` | mmol/(mmHg·s) | N₂ diffusion constant (default 0.01) |
| `dif_other` | mmol/(mmHg·s) | Other-gases diffusion constant (default 0.01) |

### Computed / local

| Property | Unit | Description |
|---|---|---|
| `dif_o2_step` / `dif_co2_step` / `dif_n2_step` / `dif_other_step` | mmol/(mmHg·s) | Effective diffusion constants after the factors |
| `_comp_gas1` / `_comp_gas2` | ref | Resolved compartment instances |

## Factor system

Each diffusion constant uses the three-tier [factor / effective-value pattern](./Capacitance.md).
Note the scaling tier here is named **`_factor_scaling`** (not `_factor_scaling_ps` as on
`Capacitance`):

| Tier | Factors | Purpose |
|---|---|---|
| Non-persistent | `dif_o2_factor`, `dif_co2_factor`, `dif_n2_factor`, `dif_other_factor` | Transient effects, reset to 1.0 each step |
| Persistent (`_ps`) | `dif_o2_factor_ps`, … | Ongoing modulation |
| Scaling (`_scaling`) | `dif_o2_factor_scaling`, … | `ModelScaler` scaling |

The effective constant (shown for O₂; identical form for CO₂/N₂/other):

```
dif_o2_step = dif_o2
            + (dif_o2_factor          − 1) · dif_o2
            + (dif_o2_factor_ps       − 1) · dif_o2
            + (dif_o2_factor_scaling  − 1) · dif_o2
```

## Calculation cycle (`calc_model`)

1. Resolve `_comp_gas1` / `_comp_gas2` from `model.models`.
2. Refresh each compartment's partial pressures via the
   **[`GasCapacitance.calc_gas_composition`](./GasCapacitance.md) method** — which derives partials
   from the current concentrations. **Not** the standalone
   [`calc_gas_composition`](./GasComposition.md) initializer, which would reset both compartments to
   a fixed room-air mix every step (and so produce no real diffusion).
3. Compose the four effective diffusion constants (`dif_*_step`).
4. For each species, compute `d = (p1 − p2) · dif_step · Δt` and apply it — subtract from
   `comp_gas1`, add to `comp_gas2`, mixing into the concentration over the compartment volume:
   ```
   comp_gas1.c = (comp_gas1.c · vol1 − d) / vol1
   comp_gas2.c = (comp_gas2.c · vol2 + d) / vol2
   ```
   Each write is **guarded by `fixed_composition` and a positive volume** (`vol > 0`), so a fixed
   (infinite-reservoir) compartment stays constant and an empty compartment cannot produce NaN.
5. Reset the non-persistent factors (`dif_o2_factor` … `dif_other_factor`) to 1.0.

## Example definition (JSON)

No standard scenario wires a `GasDiffusor` (the lung exchanges to blood through a
[`GasExchanger`](./GasExchanger.md), not gas-to-gas), so there is no in-repo example. A correct
definition follows the shape of the other transport elements:

```json
{
  "name": "GASDIF_EXAMPLE",
  "description": "gas-to-gas diffusor between two gas compartments",
  "model_type": "GasDiffusor",
  "is_enabled": true,
  "comp_gas1": "DS",
  "comp_gas2": "ALL",
  "dif_o2": 0.01,
  "dif_co2": 0.01,
  "dif_n2": 0.01,
  "dif_other": 0.01
}
```

## Usage in the model

- **Not used in the standard scenarios** — this element is latent but correct if wired up (e.g. to
  model diffusive mixing between two gas spaces without bulk flow).
- The method-vs-initializer distinction in step 2 is essential: using the standalone initializer here
  would overwrite both compartments with the inspired mix every step.

````

### FILE: explain-engine/docs/GasExchanger.md

````markdown
# GasExchanger

A `GasExchanger` moves O₂ and CO₂ across the **blood–gas barrier** — between a blood compartment and a
gas compartment — driven by their partial-pressure difference. It models alveolar gas exchange in the
lung and the membrane of an ECLS oxygenator.

## Inheritance

```
BaseModelClass
  └── GasExchanger   (partial-pressure-driven O₂/CO₂ transfer between blood and gas)
```

Lives in `base_models/` (alongside `GasDiffusor` and `BloodDiffusor`). It is a transport element, not
a compartment: it holds no volume and writes directly into the blood and gas compartments it
references. It pairs a [`BloodCapacitance`](./BloodCapacitance.md)-family compartment with a
[`GasCapacitance`](./GasCapacitance.md).

## What it models

```
blood (po2, pco2)  ⇌[GasExchanger]⇌  gas (po2, pco2)
   flux_o2  = (po2_blood  − po2_gas)  · dif_o2_step  · Δt
   flux_co2 = (pco2_blood − pco2_gas) · dif_co2_step · Δt
```

Each step it recomputes the blood gas composition, computes the O₂ and CO₂ fluxes from the
partial-pressure gradients, and transfers them between the blood's total contents (`to2`/`tco2`,
mmol/L) and the gas compartment's concentrations (`co2`/`cco2`, mmol/L). The fluxes are signed, so the
same element loads O₂ into blood at the lung when `po2_gas > po2_blood` and the gradient simply flips
direction for CO₂.

## Properties

### Config

| Property | Unit | Description |
|---|---|---|
| `comp_blood` | name | Blood compartment (the `po2`/`pco2` blood side) |
| `comp_gas` | name | Gas compartment (the `po2`/`pco2` gas side) |
| `dif_o2` | mmol/(mmHg·s) | O₂ diffusion constant (default 0.0) |
| `dif_co2` | mmol/(mmHg·s) | CO₂ diffusion constant (default 0.0) |

### Computed / local

| Property | Unit | Description |
|---|---|---|
| `flux_o2` | mmol | O₂ transferred this step (blood → gas positive) |
| `flux_co2` | mmol | CO₂ transferred this step (blood → gas positive) |
| `dif_o2_step` / `dif_co2_step` | mmol/(mmHg·s) | Effective diffusion constants after the factors |
| `_blood` / `_gas` | ref | Resolved compartment instances |

## Factor system

`dif_o2` and `dif_co2` use the three-tier [factor / effective-value pattern](./Capacitance.md). Note
the scaling tier here is named **`_factor_scaling`** (not `_factor_scaling_ps` as on `Capacitance`):

| Tier | Factors | Purpose |
|---|---|---|
| Non-persistent | `dif_o2_factor`, `dif_co2_factor` | Transient effects, reset to 1.0 each step |
| Persistent (`_ps`) | `dif_o2_factor_ps`, `dif_co2_factor_ps` | `Respiration` / scenario modulation of diffusion capacity |
| Scaling (`_scaling`) | `dif_o2_factor_scaling`, `dif_co2_factor_scaling` | `ModelScaler` scaling |

The effective constant (shown for O₂; identical for CO₂):

```
dif_o2_step = dif_o2
            + (dif_o2_factor          − 1) · dif_o2
            + (dif_o2_factor_ps       − 1) · dif_o2
            + (dif_o2_factor_scaling  − 1) · dif_o2
```

## Calculation cycle (`calc_model`)

1. Resolve `_blood` / `_gas` from `model.models`.
2. Call `calc_blood_composition(_blood)` (from [`BloodComposition`](./BloodComposition.md)) to get
   current blood `po2`/`pco2`; read `po2_blood`, `pco2_blood`, `to2_blood`, `tco2_blood` and the gas
   `co2`, `cco2`, `po2`, `pco2`.
3. **Skip the step** if either compartment's volume is `<= 0` (both volumes are denominators).
4. Compose the effective diffusion constants `dif_o2_step` / `dif_co2_step` from the factors.
5. **O₂ flux** and new contents:
   ```
   flux_o2      = (po2_blood − po2_gas) · dif_o2_step · Δt
   new_to2_blood = (to2_blood · vol_blood − flux_o2) / vol_blood     (floored at 0)
   new_co2_gas   = (co2_gas   · vol_gas   + flux_o2) / vol_gas       (floored at 0)
   ```
6. **CO₂ flux** and new contents:
   ```
   flux_co2      = (pco2_blood − pco2_gas) · dif_co2_step · Δt
   new_tco2_blood = (tco2_blood · vol_blood − flux_co2) / vol_blood  (floored at 0)
   new_cco2_gas   = (cco2_gas   · vol_gas   + flux_co2) / vol_gas     (floored at 0)
   ```
7. Write the results back, **guarding each compartment by `fixed_composition`**: the blood
   `to2`/`tco2` are updated only if `!_blood.fixed_composition`, and the gas `co2`/`cco2` only if
   `!_gas.fixed_composition` — so a fixed (infinite-reservoir) compartment is not changed.
8. Reset the non-persistent factors (`dif_o2_factor`, `dif_co2_factor`) to 1.0.

Note the flux sign convention: positive `flux_o2`/`flux_co2` moves substance **out of blood and into
gas**. At the lung `po2_gas > po2_blood`, so `flux_o2` is negative (O₂ loads into blood) while
`pco2_blood > pco2_gas` makes `flux_co2` positive (CO₂ off-loads to gas).

## Example definition (JSON)

From `term_neonate.json` — the left-lung exchanger between the left-lung capillary blood and the left
alveolar gas:

```json
{
  "name": "GASEX_LL",
  "description": "gas exchanger model of the blood-gas connection of the left lung",
  "model_type": "GasExchanger",
  "is_enabled": true,
  "comp_blood": "LL_CAP",
  "comp_gas": "ALL",
  "dif_o2": 0.001,
  "dif_co2": 0.006
}
```

## Usage in the model

- `GASEX_LL` / `GASEX_RL` — left / right lung capillary blood ↔ alveolar gas (`ALL` / `ALR`); the
  `dif_o2`/`dif_co2` factors are how `Respiration` (and scaling) modulate diffusion capacity.
- `ECLS_GASEX` — ECLS oxygenator blood ↔ sweep gas; the sweep gas is a `fixed_composition` reservoir,
  so only the blood side is updated.
- The volume guard and `fixed_composition` guards ensure a collapsed alveolus cannot produce NaN and a
  fixed sweep-gas / blood reservoir stays constant.

````

### FILE: explain-engine/docs/Glucose.md

````markdown
# Glucose (blood-glucose / insulin controller)

The `Glucose` model is a **slow blood-glucose process controller** — same family as
[`Hormones`](./Hormones.md), [`Kidneys`](./Kidneys.md) and [`Drugs`](./Drugs.md): it holds no
compartment of its own, resolves references to other models lazily, runs on an `_update_interval`,
and **owns its source/sink while enabled** (releasing them once on disable). Default config is
**neutral at rest** — the set-point auto-seeds to the resting arterial glucose, `insulin` and
`counterreg` sit at `1.0`, and because the default `hgp_rate == glu_use_rate` hepatic production
exactly balances peripheral utilization, so total body glucose mass is conserved. A scenario that
ships it behaves identically at rest and only diverges on perturbation.

`glucose` is a **new blood solute (mmol/L)**. It advects through the whole circuit for free via the
engine's existing `volume_in` solute mixing in `BloodCapacitance`/`HeartChamber`, exactly like Na/K
— the controller only seeds the key and adjusts its source/sink. (A scenario should also list
`"glucose"` in [`Blood`](./Blood.md)`.solutes` so every compartment starts seeded; `_seed_keys()`
below is a lazy safety net that mirrors [`Drugs`](./Drugs.md).)

## Causal loop

```
SENSE                      CONTROL (1.0 = baseline)        EFFECTORS (owned, default-neutral)
AA.solutes.glucose ──┬──► insulin     (hyperglycemia ↑) ──► uptake_factor      → peripheral SINK ↑
   (plasma_model)    │                                  └─► production_factor  → hepatic SOURCE ↓
                     └──► counterreg   (hypoglycemia  ↑) ──► production_factor  → hepatic SOURCE ↑

SOURCE  hepatic glucose production → IVCI (injection_site):  prod = (hgp_rate/60)·weight·u·production_factor  [mmol]
SINK    peripheral utilization, split over Metabolism.metabolic_active_models by fvo2:
                                                            use  = (glu_use_rate/60)·weight·u·uptake_factor   [mmol]
```

- **SOURCE** — endogenous hepatic glucose output added straight to the central vein `IVCI`
  (`_inject.solutes.glucose += prod_total / _inject.vol`), modulated by `production_factor`.
- **SINK** — peripheral utilization distributed over the *same* compartments and fractions
  [`Metabolism`](./Metabolism.md) uses for O₂ (`metabolic_active_models`, a `site → fvo2` map),
  scaled by `uptake_factor`. A `MicroVascularUnit` site redirects to its `<site>_CAP` compartment;
  sites with `vol <= 0` are skipped, and concentration is floored at 0.
- **CONTROL** — `insulin` rises with hyperglycemia (↑uptake, ↓hepatic output); `counterreg` rises
  with hypoglycemia (↑hepatic output). At the set-point both `== 1.0`.

## Dynamics

Every `_update_interval` (default `1.0 s`), `_update_glucose(u)` runs (`u` = elapsed):

```
glu_err            = (glucose − glucose_setpoint) / glucose_setpoint
insulin_target     = clamp(1 + insulin_gain·glu_err,     hormone_min, hormone_max)
counterreg_target  = clamp(1 − counterreg_gain·glu_err,  hormone_min, hormone_max)
insulin            = lag(insulin, insulin_target, u, insulin_tc)          # x += u·(1/tc)·(−x+target)
counterreg         = lag(counterreg, counterreg_target, u, counterreg_tc)
uptake_factor      = clamp(1 + uptake_insulin_gain·(insulin−1),  uptake_factor_min, uptake_factor_max)
production_factor  = clamp(1 − hgp_insulin_gain·(insulin−1) + hgp_counterreg_gain·(counterreg−1),
                           production_factor_min, production_factor_max)
```

**Auto-seed.** After a `_warmup_delay` (30 s, to let the arterio-venous gradient settle), the
set-point is pinned once to the then-current sensed `glucose` (`_seeded = true`) — this is what makes
a shipped scenario neutral regardless of its resting glucose. The master gate `glucose_running`
(false) calls `_release()` once, pinning every read-out back to neutral, then idles.

## IV dextrose — no extra code

IV dextrose works through the existing [`Fluids`](./Fluids.md) mechanism with **zero** changes here:
a `d5`/`d10` fluid type simply carries `glucose` in its `solutes`, so infusing it raises compartment
glucose the same way any fluid raises Na/K. The controller then senses the rise and responds
(insulin↑, hepatic output↓). Likewise, `glucose` is deliberately **not** in
[`Kidneys`](./Kidneys.md)`.filterable_solutes` — there is **no glucosuria** in this version.

## Read-outs
| Read-out | Meaning |
|---|---|
| `glucose` | sensed arterial glucose (mmol/L, from `plasma_model.solutes.glucose`) |
| `insulin` / `counterreg` | controller activity (1.0 = baseline) |
| `uptake_factor` / `production_factor` | applied SINK / SOURCE multipliers |
| `glucose_use_step` / `glucose_prod_step` | last-update total utilization / production (mmol) |

## Key parameters (defaults / units)
| Param | Default | Meaning |
|---|---|---|
| `glu_use_rate` | `0.03` mmol/kg/min | peripheral utilization (~5.4 mg/kg/min) |
| `hgp_rate` | `0.03` mmol/kg/min | hepatic production (`== glu_use_rate` → neutral at rest) |
| `glucose_setpoint` | `4.0` mmol/L (~72 mg/dL) | controller target (auto-seeded to resting value) |
| `insulin_gain` / `counterreg_gain` | `6.0` / `6.0` | drive per fractional glucose excess / deficit |
| `insulin_tc` / `counterreg_tc` | `120 s` / `120 s` | controller lag time constants |
| `uptake_insulin_gain` | `1.0` | uptake-factor rise per `(insulin−1)` |
| `hgp_insulin_gain` / `hgp_counterreg_gain` | `0.8` / `2.0` | hepatic suppression / rise per hormone |
| `hormone_min/max` | `0.0` / `10.0` | insulin & counterreg clamps |
| `uptake_factor_min/max` | `0.1` / `5.0` | SINK clamp |
| `production_factor_min/max` | `0.0` / `8.0` | SOURCE clamp |
| `glucose_default` | `4.0` mmol/L | value used to seed the solute key where missing |
| `metabolism_name` / `injection_site` / `plasma_model` | `Metabolism` / `IVCI` / `AA` | lazy wiring refs |

## Wiring & related models
- [`Metabolism`](./Metabolism.md) — supplies `metabolic_active_models` (the `site → fvo2`
  consumption map the SINK reuses, so glucose use tracks O₂ use).
- [`Fluids`](./Fluids.md) — IV dextrose enters via a `glucose`-carrying fluid type (no glucose code).
- [`Hormones`](./Hormones.md) / [`Drugs`](./Drugs.md) — same controller pattern (lazy refs, update
  interval, owned effectors, lazy key-seeding for new solutes).

````

### FILE: explain-engine/docs/Heart.md

````markdown
# Heart

The `Heart` model is the **cardiac driver**. It owns the rhythm and conduction, synthesizes the ECG,
generates the activation that contracts the chambers, applies neuro-hormonal control to contractility/
relaxation/heart rate, and measures per-beat haemodynamics. It does not hold blood itself — the
chambers (`HeartChamber`/`BloodTimeVaryingElastance`) do; the Heart drives their `act_factor`.

## Conduction and rhythm

A timed state machine models the cardiac conduction system, gated off the engine-level counters
`ncc_atrial` / `ncc_ventricular`:

```
SA node fires ─► PQ (atrial) ─► AV delay ─► QRS (ventricular) ─► QT ─► (refractory clears) ─► next beat
```

- **Heart rate** is the reference rate scaled by the autonomic and modulating factors
  (`ans_activity_hr · ans_sens`, `hr_factor`, `hr_mob_factor`, …); `hr_override` pins it to the
  reference.
- The **sinus interval** `60 / heart_rate` drives the SA node; `pq_time`, `av_delay`, `qrs_time` and
  the rate-corrected `qt_time` (Bazett) set the phase durations.

## Conduction-driven arrhythmias

The atrial and ventricular activations are **decoupled** so the two chambers can beat independently —
real conduction disorders rather than a fixed SA→QRS sequence. This is gated behind **default-neutral**
properties (at the defaults the logic is identity, so every scenario's normal rhythm is unchanged), and
because the ECG and chamber activation already key off `ncc_atrial` (P) and `ncc_ventricular` (QRS)
*independently*, dissociated rhythms render correctly with no ECG changes.

Two intervention points:

- **AV-node conduction gate** at the av-delay → ventricle step. The atrial impulse activates the
  ventricles only if `!ventricle_is_refractory && _av_conducts()`. `av_block_mode` selects:
  `none` (1:1), `first_degree` (1:1 with a prolonged PR — `pq_time · first_degree_pq_factor`),
  `second_degree` (drop every `av_block_ratio`-th P → 2:1, 3:1, …), `complete` (no impulse conducts).
  A blocked impulse leaves a P wave with no following QRS.
- **Independent ventricular pacemaker** (`_vent_activation_timer`): fires a ventricular activation when
  the ventricle has been quiet for `60 / rate` and is not refractory. `vent_pacemaker_mode = "escape"`
  (slow, `vent_escape_rate` ≈ 50 bpm — only fires when conducted beats fail, i.e. complete block or
  sinus arrest) or `"vt"` (fast ventricular focus, `vt_rate` → ventricular tachycardia). All ventricular
  activations route through `_activate_ventricle()` (starts QRS, resets `ncc_ventricular` and the escape
  timer).

This yields the canonical conduction rhythms: **complete heart block** (atria at the sinus rate,
ventricles at the escape rate — AV dissociation), **2nd-degree / 2:1 block** (ventricular rate ≈ ½
atrial), **sinus arrest** (`sa_node_enabled = false` → SA silent → escape rhythm), **ventricular
tachycardia**, and a triggered **PVC** (`trigger_pvc()` → one premature beat after `pvc_coupling`).

> **Neutrality.** At the defaults (`av_block_mode = "none"`, `sa_node_enabled = true`, escape mode at
> 50 bpm) the changes are identity — `_av_conducts()` returns `true`, and the escape pacemaker never
> fires because every conducted beat (all scenario rates > 50 bpm) resets its timer first. The feature
> lives entirely on the existing `Heart`, so it is available in every scenario with no model-definition
> edits. PVCs are deterministic (`trigger_pvc()`), not random — the engine forbids `Math.random()`.

## Activation → chamber contraction (`calc_varying_elastance`)

Two activation functions are computed each step and pushed onto the chambers as `act_factor`:

- **Atrial** `aaf` — a half-sine over the PQ window (→ atria: LA, RA / RAIVCI, RASVC).
- **Ventricular** `vaf` — a skewed pulse over `qrs_time + qt_time` (→ ventricles: LV, RV, coronaries).

The Heart also propagates `ans_sens`, `ans_activity` (scaled by `ans_activity_factor` from the MOB
hypoxia feedback) to the chambers, so the autonomic and myocardial-oxygen-balance effects reach
`HeartChamber.calc_elastances`.

## Contractility / relaxation / pericardium control

Throttled setters apply **deltas** to persistent chamber factors:

- `set_contractillity(left, right)` → chamber `el_max_factor_ps` (inotropy).
- `set_relaxation(left, right)` → chamber `el_min_factor_ps` (lusitropy).
- `set_pericardium(el_factor, extra_volume)` → `PERICARDIUM.el_base_factor_ps` and `vol_extra`.

## Per-beat measurements (`analyze`)

At the systole↔diastole transitions it latches the end-systolic and end-diastolic volumes and
pressures for LV/RV/LA/RA, and derives stroke volume and ejection fraction:

```
SV = EDV − ESV          EF = SV / EDV   (guarded against EDV = 0)
```

## ECG (`calc_ecg`)

A lead-II-like signal synthesized from a sum of Gaussians (P, Q, R, S, T), each positioned within its
conduction phase so the morphology tracks the configured `pq`/`qrs`/`qt` timings; baseline is
isoelectric at 0 mV.

## Configuration (model-definition fields)

`heart_rate_ref`, `pq_time`, `qrs_time`, `qt_time`, `av_delay`; ECG amplitudes `p_amp`…`t_amp`;
`ans_sens`, `ans_activity`, `ans_activity_hr`; the `*_factor` modulators; `pc_el_factor`,
`pc_extra_volume`. Rhythm/conduction: `sa_node_enabled`, `av_block_mode`, `av_block_ratio`,
`first_degree_pq_factor`, `vent_pacemaker_mode`, `vent_escape_rate`, `vt_rate`, `pvc_coupling`
(+ the `trigger_pvc()` method).

## Notes & caveats

- **End-diastolic pressures.** The diastole-branch in `analyze` now writes `*_edp` (it previously
  wrote `*_esp`, leaving `lv_edp`/`rv_edp`/… at 0 and corrupting the end-systolic values).
- **MOB coupling.** `ans_activity_factor` scales the sympathetic drive the Heart sends to the
  chambers; it is set by the `Mob` model's hypoxia feedback (1.0 = no effect).
- The systole detection reads `LA_LV.flow` / `LV_AA.flow` directly — these mitral/aortic-valve
  connectors are assumed present.

````

### FILE: explain-engine/docs/HeartChamber.md

````markdown
# HeartChamber

A HeartChamber represents a cardiac chamber (atrium or ventricle) with time-varying elastance, ANS-mediated contractility and relaxation, and blood composition tracking. It is the model used for LA, LV, RAIVCI, RASVC, and RV.

## Inheritance

```
BaseModelClass
  └── TimeVaryingElastance         (volume, time-varying elastance, pressure)
        └── HeartChamber           (ANS coupling, blood composition)
```

## Relationship to BloodTimeVaryingElastance

Both `HeartChamber` and `BloodTimeVaryingElastance` extend `TimeVaryingElastance` and add blood composition tracking. The key difference is that HeartChamber overrides `calc_elastances()` to incorporate autonomic nervous system effects on contractility and relaxation via beta-1 adrenergic receptor modeling.

## What it models

A cardiac chamber whose elastance cycles between `el_min` (diastole) and `el_max` (systole), driven by the `act_factor` provided by the `Heart` model. The ANS modulates both values:

- **Diastolic function (el_min)**: Beta-1 receptor activation produces a lusitropic effect -- it *decreases* el_min, improving relaxation. A lower el_min means better diastolic filling.
- **Systolic function (el_max)**: Beta-1 receptor activation produces a positive inotropic effect -- it *increases* el_max, strengthening contraction.

The `Heart` model also applies contractility (`cont_factor_left/right`) and relaxation (`relax_factor_left/right`) factors via the `el_max_factor_ps` and `el_min_factor_ps` persistent factors.

## Properties

### Inherited from TimeVaryingElastance

| Property | Unit | Description |
|---|---|---|
| `u_vol` | L | Unstressed volume |
| `el_min` | mmHg/L | Minimum elastance (diastolic stiffness) |
| `el_max` | mmHg/L | Maximum elastance (systolic stiffness / contractility) |
| `el_k` | unitless | Non-linear elastance coefficient |
| `act_factor` | 0-1 | Activation factor (set by Heart model: `aaf` for atria, `vaf` for ventricles) |
| `vol` | L | Current blood volume |
| `pres` | mmHg | Total pressure |
| `pres_in` | mmHg | Recoil pressure |
| `pres_tm` | mmHg | Transmural pressure |
| `pres_ext` | mmHg | External pressure (non-persistent, e.g., pericardial pressure) |

### ANS properties (unique to HeartChamber)

| Property | Unit | Description |
|---|---|---|
| `ans_sens` | 0-1 | Sensitivity to ANS activity. Set by the Heart model. |
| `ans_activity` | unitless | ANS activity level. 1.0 = baseline, >1 = sympathetic stimulation. Set by Heart model. |

### Blood composition

| Property | Unit | Description |
|---|---|---|
| `temp` | degC | Blood temperature |
| `viscosity` | cP | Blood viscosity |
| `to2` | mmol/L | Total oxygen concentration |
| `tco2` | mmol/L | Total carbon dioxide concentration |
| `ph` | unitless | Blood pH (-1 = not calculated) |
| `pco2` | mmHg | Partial pressure of CO2 (-1 = not calculated) |
| `po2` | mmHg | Partial pressure of O2 (-1 = not calculated) |
| `so2` | unitless | Oxygen saturation (-1 = not calculated) |
| `hco3` | mmol/L | Bicarbonate concentration (-1 = not calculated) |
| `be` | mmol/L | Base excess (-1 = not calculated) |
| `solutes` | object | Dictionary of solute concentrations |
| `drugs` | object | Dictionary of drug concentrations |

### Calculated intermediates

| Property | Unit | Description |
|---|---|---|
| `el_min_eff` | mmHg/L | Effective minimum elastance this step |
| `el_max_eff` | mmHg/L | Effective maximum elastance this step |
| `el_k_eff` | unitless | Effective non-linear elastance coefficient |
| `u_vol_eff` | L | Effective unstressed volume |

## ANS elastance modulation

HeartChamber overrides `calc_elastances()` to add ANS effects. The key difference from the parent class:

### Diastolic function (lusitropic effect)

ANS activation *decreases* el_min (better relaxation):

```
el_min_eff = el_min
  + (el_min_factor - 1) * el_min
  + (el_min_factor_ps - 1) * el_min
  + (el_min_factor_scaling_ps - 1) * el_min
  - (ans_activity - 1) * el_min * ans_sens    // note: SUBTRACTED
```

### Systolic function (inotropic effect)

ANS activation *increases* el_max (stronger contraction):

```
el_max_eff = el_max
  + (el_max_factor - 1) * el_max
  + (el_max_factor_ps - 1) * el_max
  + (el_max_factor_scaling_ps - 1) * el_max
  + (el_max_mob_factor - 1) * el_max          // myocardial-oxygen-balance (Mob)
  + (el_max_drug_factor - 1) * el_max         // inotropy (Drugs PK/PD)
  + (el_max_load_factor - 1) * el_max         // acute load-induced depression (HeartFunction)
  + (el_max_remodel_factor - 1) * el_max      // chronic remodeling (HeartFunction)
  + (ans_activity - 1) * el_max * ans_sens    // note: ADDED
```

A safety check ensures `el_max_eff` never falls below `el_min_eff`.

`el_k_eff` likewise adds a chronic remodeling term (`el_k_remodel_factor`, diastolic stiffening from
HeartFunction) alongside its three factor tiers, and `calc_volumes()` is overridden to add the
eccentric-dilation term (`u_vol_remodel_factor`, HeartFunction) to `u_vol_eff`. All four of these
extra factors default to `1.0` (no effect) and are *not* reset each step — see
[HeartFunction.md](./HeartFunction.md) and the Mob/Drugs models.

## Three-tier factor system

| Tier | Factors | Purpose |
|---|---|---|
| Non-persistent | `u_vol_factor`, `el_min_factor`, `el_max_factor`, `el_k_factor` | Transient effects, reset each step |
| Persistent (`_ps`) | `u_vol_factor_ps`, `el_min_factor_ps`, `el_max_factor_ps`, `el_k_factor_ps` | Heart model contractility/relaxation factors |
| Scaling (`_scaling_ps`) | `u_vol_factor_scaling_ps`, `el_min_factor_scaling_ps`, `el_max_factor_scaling_ps`, `el_k_factor_scaling_ps` | ModelScaler weight/manual scaling |

The persistent factors are the primary mechanism by which the `Heart` model controls chamber function:
- `el_max_factor_ps` is adjusted by `Heart.set_contractillity()` via `cont_factor_left/right`
- `el_min_factor_ps` is adjusted by `Heart.set_relaxation()` via `relax_factor_left/right`

## Pressure calculation

Inherited from `TimeVaryingElastance`:

```
p_ms = (vol - u_vol_eff) * el_max_eff
p_ed = el_k_eff * (vol - u_vol_eff)^2 + el_min_eff * (vol - u_vol_eff)
pres_in = (p_ms - p_ed) * act_factor + p_ed
```

During diastole (`act_factor = 0`), pressure is determined by `el_min_eff` (and `el_k_eff` for non-linear behavior). During systole (`act_factor` approaches peak), pressure is dominated by `el_max_eff`.

## Mixing logic (`volume_in`)

Overrides `volume_in` to perform composition mixing when blood flows in:

```
concentration += ((concentration_from - concentration) * dvol) / vol
```

Applied to: `to2`, `tco2`, all `solutes`, all `drugs`, `temp`, `viscosity`.

## Calculation cycle

1. `calc_elastances()` -- compute el_min_eff, el_max_eff, el_k_eff with ANS modulation (overridden)
2. `calc_volumes()` -- compute u_vol_eff including the `u_vol_remodel_factor` term (overridden)
3. `calc_pressure()` -- compute time-varying pressure (inherited from TimeVaryingElastance)

## Interaction with the Heart model

The `Heart` model orchestrates all HeartChamber instances:

1. Sets `act_factor` each step: `aaf` (atrial activation function) for LA, RAIVCI, RASVC; `vaf` (ventricular activation function) for LV, RV
2. Sets `ans_activity` and `ans_sens` for ANS coupling
3. Adjusts `el_max_factor_ps` via `set_contractillity()` (systolic function control)
4. Adjusts `el_min_factor_ps` via `set_relaxation()` (diastolic function control)

Flow between chambers is handled by separate `Resistor` models (e.g., `LA_LV` for the mitral valve, `LV_AA` for the aortic valve).

## Example definition (JSON)

```json
{
  "name": "LV",
  "description": "left ventricle",
  "model_type": "HeartChamber",
  "is_enabled": true,
  "vol": 0.0267,
  "u_vol": 0.003,
  "el_min": 133,
  "el_max": 5800,
  "el_k": 0
}
```

## Instances in the model

| Name | Chamber | Activation |
|---|---|---|
| `LA` | Left atrium | Atrial (aaf) |
| `LV` | Left ventricle | Ventricular (vaf) |
| `RAIVCI` | Right atrium (IVC portion) | Atrial (aaf) |
| `RASVC` | Right atrium (SVC portion) | Atrial (aaf) |
| `RV` | Right ventricle | Ventricular (vaf) |

````

### FILE: explain-engine/docs/HeartFunction.md

````markdown
# HeartFunction — Load-Induced Ventricular Contractility Compromise

`HeartFunction` models how a ventricle becomes **compromised** when it labors against a very high
pressure (afterload) or is over-dilated by too much volume (preload). It is a feedback controller in
the same family as `Mob` and `Ans`: it runs in the step loop, reads the per-beat metrics that
`Heart.analyze()` already produces, and writes multiplier **factors** onto the `LV` and `RV`
`HeartChamber`s. It owns no sub-models and touches no base parameters directly.

## Physiology — why a single signal (wall stress)

The healthy Frank–Starling response (more filling → more stroke volume) and afterload sensitivity
(higher ejection pressure → higher end-systolic volume, lower stroke volume) are **already emergent**
in the time-varying elastance core (`TimeVaryingElastance.calc_pressure`): the ESPVR
(`el_max` = Ees = contractility) and the EDPVR coupled to the circuit reproduce them with no extra
code. What `HeartFunction` adds is the **pathological** part — sustained load actually *degrading*
contractility rather than just shifting the operating point on a fixed curve.

The unifying signal is the **Laplace wall stress** of a thin-walled sphere:

```
sigma = P · r / (2 · h)
```

A single quantity captures both mechanisms:

- **Afterload** raises `sigma` through the pressure `P` (end-systolic wall stress `sigma_es`).
- **Dilation** raises `sigma` through the cavity radius `r` (end-diastolic wall stress `sigma_ed`).

This is more faithful than driving off raw pressure/volume, and unlike an Ea/Ees ratio it captures
pure volume overload. Note the modern physiology: there is **no true sarcomere "descending limb" in
vivo** (titin caps sarcomere length ~2.2 µm). High-afterload decompensation is **afterload mismatch**
(Ross 1976) — stroke volume falls when preload reserve is exhausted or Ees is low — and dilation harm
is the Laplace wall-stress / energetic mismatch, not overstretch. The model is built around that view.

## Geometry

Per ventricle, from the end-systolic and end-diastolic cavity volumes (`Heart.lv_esv/lv_edv`,
`rv_esv/rv_edv`):

```
r      = (3 · V_cav / 4π)^(1/3)                                  cavity radius  (V in mL → r in cm)
R_out  = (3 · (V_cav + V_wall) / 4π)^(1/3)                       outer radius
h      = R_out − r                                               wall thickness
```

Wall volume scales with heart weight (reusing Mob's relation), split by a configurable LV/RV mass
fraction, so it tracks body weight automatically:

```
hw       = hw_intercept + hw_slope · weight_kg · 1000            [g]
V_wall_x = wall_volume_x  (if > 0)  else  hw · wall_frac_x / wall_density   [mL]
```

Wall stress uses the chamber transmural recoil pressure (`pres_in`) and the per-phase volume:
`sigma_es = lv_esp · r_es / (2·h_es)`, `sigma_ed = lv_edp · r_ed / (2·h_ed)`.

## Setpoints (auto-calibration)

Baseline wall stress depends on each scenario's geometry, so the setpoints `sigma_*_ref_{lv,rv}`
auto-calibrate: during an initial window (`setpoint_warmup` seconds **of elapsed model time since the
model started** — not the absolute engine clock, since scenarios are saved with a non-zero
`model_time_total`) the model tracks the resting peak wall stress and freezes the reference to it.
While warming up, all factors are held at `1.0` (no effect). Provide a positive `sigma_*_ref` in the
definition to override and skip auto-learning.

## Acute layer (reversible, seconds–minutes)

When end-systolic stress (afterload) or end-diastolic stress (over-dilation) exceeds its setpoint,
contractility is depressed, smoothed by a first-order lag toward the target:

```
excess_es  = max(0, sigma_es − ref_es)
excess_ed  = max(0, sigma_ed − ref_ed)
target     = clamp(1 − g_es·excess_es − g_ed·excess_ed, cont_floor, 1)
load_factor += dt · (1/cont_tc) · (target − load_factor)
```

`load_factor` is written to the chamber's `el_max_load_factor`. It fully recovers to `1.0` within
~`cont_tc` when the load normalizes (afterload mismatch is reversible / inotrope-correctable).

## Chronic layer (remodeling, slow)

A slow wall-stress average (time constant `stress_avg_tc`) drives two remodeling integrators with the
time constant `remodel_tc` (default ~1 day; compress it to observe remodeling within a short run):

- **Concentric** `rc` (sustained high `sigma_es`, pressure overload): thickens the wall (raises the
  effective `V_wall`, lowering `sigma` — compensation) with a maladaptive tail of diastolic
  stiffening and a mild contractility decline.
- **Eccentric** `re` (sustained high `sigma_ed`, volume overload): dilates the cavity and declines
  contractility.

These map onto chamber factors:

```
el_max_remodel_factor = clamp(1 − mal_conc·rc − mal_ecc·re, remodel_floor, 1)
el_k_remodel_factor   = 1 + stiff_conc · rc      (concentric diastolic stiffening)
u_vol_remodel_factor  = 1 + dil_ecc · re         (eccentric cavity dilation)
```

## Wiring into the chamber

`HeartChamber.calc_elastances()` adds the two `el_max` terms and the `el_k` term, and
`HeartChamber.calc_volumes()` (overridden) adds the `u_vol` term — all following the existing additive
`+ (factor − 1) · base` convention, so they compose cleanly with the ANS inotropic term and Mob's
`el_max_mob_factor`. The existing `el_max_eff < el_min_eff` clamp protects the lower bound. Atria are
left untouched (factors stay `1.0`).

## Verification

`scripts/probe_heartfunction.mjs` builds `term_neonate`, warms up, then applies an afterload challenge
and a volume-overload challenge, printing wall stress, the acute factor, and the remodeling state.
Observed behavior: at baseline factors stay ≈1.0; a transfusion drives `sigma_ed`/`sigma_es` well above
setpoint, collapses ejection fraction, depresses `el_max_load_factor` to its floor, and—on a
time-compressed run—dilates `u_vol_remodel_factor` and drops `el_max_remodel_factor` (the full
both-timescale decompensation cascade). An afterload challenge raises `sigma_es` and depresses
contractility directionally; note that the `term_neonate` circulation has a low-resistance runoff, so
forcing severe *pure* pressure overload is hard in that scenario (a model-of-circulation property, not
a `HeartFunction` limitation).

## Key parameters

| Parameter | Meaning |
| --- | --- |
| `hf_active`, `remodel_active` | master switches for the acute and chronic layers |
| `wall_frac_lv/rv`, `wall_volume_lv/rv`, `wall_density` | wall-volume geometry |
| `g_es_lv/rv`, `g_ed_lv/rv` | acute contractility-depression gains (afterload / dilation) |
| `cont_tc`, `cont_floor` | acute response time constant and lower bound |
| `remodel_tc`, `stress_avg_tc` | chronic remodeling and stress-averaging time constants |
| `k_conc`, `k_ecc`, `mal_conc`, `mal_ecc`, `stiff_conc`, `dil_ecc`, `remodel_floor` | remodeling gains and bound |
| `setpoint_warmup`, `sigma_*_ref_*` | setpoint auto-calibration window / overrides |

````

### FILE: explain-engine/docs/HeartValve.md

````markdown
# HeartValve

A `HeartValve` is a `Resistor` with a distinct `model_type` — it adds no code of its own:

```js
export class HeartValve extends Resistor {
  static model_type = "HeartValve";
}
```

All of its behaviour (flow mechanics, the forward/backward resistances, the non-linear term, the
flags) comes from [`Resistor`](./Resistor.md). The separate type exists for clarity in definitions and
so the UI can present valve-relevant fields.

## Valve behaviour

Valve action is configuration, not code: a heart valve sets **`no_back_flow = true`** so blood flows
only in the forward direction (e.g. `LA_LV`, `RV_PA`, `LV_AA`). A valve that is atretic/absent in a
given scenario additionally sets `no_flow = true`.

See [Resistor.md](./Resistor.md) for the flow equations, the `volume_out`/`volume_in` handshake, and
the resistance/factor details.

````

### FILE: explain-engine/docs/Hormones.md

````markdown
# Hormones (RAAS / ADH)

The `Hormones` model is the **long-loop neuro-hormonal volume / osmolality controller** — the slow
counterpart to the fast [`Ans`](./Ans.md) baroreflex. It models the
renin–angiotensin–aldosterone system (RAAS) plus ADH (vasopressin) as a small set of named,
inspectable hormone **activity levels** (`1.0` = resting baseline), each driven first-order toward a
stimulus-set target and each writing effector channels that are **independent of the ANS** (so they
compose, never collide).

Like the [`Kidneys`](./Kidneys.md) autoregulation loop it is a **controller/process model**: it
holds no blood, resolves references to other models lazily, runs on an update interval, and **owns
its effector channels while enabled** (releasing them once on disable). Default config is
**neutral** — with setpoints anchored to the scenario's resting state, every `(hormone − 1) ≈ 0`,
so a scenario that ships a `Hormones` model behaves identically at rest and only diverges when
perturbed or when a pathway is clamped.

## Sensors → hormones → effectors

```
SENSORS (lazy refs)                 HORMONES (1.0 = baseline)        EFFECTORS (owned, default-neutral)
KID_ART.pres ───────────┐
Circulation.total_blood_volume ─┬─► angiotensin ─┐                 Circulation.svr_factor_art / _ven   (arteriolar/venular constriction)
AA.solutes.na (osm≈2·Na) ──┐    │   (renin=drive) ├─► aldosterone   KID_CAP_KID_VEN.r_factor_ps         (renal EFFERENT constriction)
AA.solutes.k ──────────────┼────┘                │   (cascade+K)    Kidneys.reabsorption_factors.na/.k  (Na retention / K wasting)
                           └─────────────────────┴─► adh            Kidneys.reabs_factor_adh            (water retention / antidiuresis)
```

- **angiotensin II** ← low renal perfusion + low blood volume. `renin` is the instantaneous drive;
  `angiotensin` is its lagged effective level (`angiotensin_tc`).
- **aldosterone** ← angiotensin (cascade) + hyperkalemia. Slow (`aldosterone_tc`).
- **adh** ← plasma osmolality (osmotic, `osm ≈ 2·Na`) + low volume/pressure (baroregulated).

> **Why the renal EFFERENT, not the afferent.** The renal afferent (`KID_ART.r_factor_ps`) is owned
> by the Kidneys autoregulation loop (overwritten every tick). Angiotensin II therefore acts renally
> through the **efferent** arteriole (`KID_CAP_KID_VEN`, a free-standing `Resistor`) — which is also
> its signature physiology: efferent constriction raises glomerular pressure and **defends GFR** when
> perfusion falls. Systemic constriction goes through `Circulation.svr_factor_art/_ven`, which fans a
> delta out to every systemic arteriole/venule's `r_factor_ps` (`BloodVessel` α-couples that into
> elastance — realistic combined constriction). The ANS uses a *separate* `ans_activity` channel, so
> the two compose without clashing.

## Dynamics

Each hormone relaxes first-order toward a stimulus target on the controller tick
(`_update_interval`, default 1 s; hormones are slow so a fine tick is unnecessary):
`x += u·(1/tc)·(−x + target)`, clamped to `[hormone_min, hormone_max]`. With `p/V/Na/K` the sensed
values and `*_setpoint` the resting anchors:

```
renin       = 1 + renin_gain·(p_set−p)/p_set + renin_vol_gain·(V_set−V)/V_set        → angiotensin (lag)
aldo_target = 1 + aldo_gain·(angiotensin−1) + aldo_k_in_gain·(K−K_set)/K_set         → aldosterone (slow lag)
adh_target  = 1 + adh_gain_osmo·(Na−Na_set)/Na_set + adh_gain_baro·(V_set−V)/V_set   → adh (lag)
```

Each `*_enabled` gate that is off pins its hormone(s) to `1.0` (neutral). Effector factors map
`1 + gain·(hormone−1)` (K wasting is `1 − aldo_k_gain·(aldo−1)`), each clamped, then written to the
owned channel.

## Kidneys integration

Two neutral-by-default hooks were added to `Kidneys` for this layer (see [`Kidneys`](./Kidneys.md)):
- **`reabs_factor_adh`** — ADH's dedicated water-reabsorption multiplier, folded into `_reabs_eff`
  (separate from the user `reabs_factor_ps` layer).
- **`reabsorption_factors`** (per-solute dict) — aldosterone's per-solute multiplier applied in
  `_solute_reabs` (`na > 1` retain, `k < 1` waste); also reusable for diuretics.

## Read-outs
| Read-out | Meaning |
|---|---|
| `angiotensin` / `aldosterone` / `adh` | effective hormone activity (1.0 = baseline) |
| `renin` | instantaneous angiotensin drive (un-lagged) |
| `svr_factor` / `svr_ven_factor` | applied systemic arteriolar / venular constriction factor |
| `efferent_factor` | applied renal efferent `r_factor_ps` |
| `na_reabs_factor` / `k_reabs_factor` / `water_reabs_factor` | applied Kidneys reabsorption factors |
| `sensed_perfusion` / `sensed_volume` / `sensed_na` / `sensed_osmolality` / `sensed_k` | sensor read-outs |

## Configuration & calibration
Anchor `perfusion_setpoint` ≈ baseline `KID_ART.pres` (neonate ≈ 40, adult ≈ 82 mmHg),
`volume_setpoint` ≈ baseline `Circulation.total_blood_volume` (neonate ≈ 0.286 L, adult ≈ 4.84 L),
`osmo_na_setpoint` ≈ 138, `k_setpoint` ≈ 3.5 — so resting hormone levels ≈ 1.0 and no channel rails
(measured headless with `Ans` disabled). Gains/time-constants are configurable per hormone; both
scenarios ship **enabled** with **physiologic** time constants (`angiotensin_tc` 30 s, `adh_tc`
120 s, `aldosterone_tc` 1800 s).

**Validated headless** (`scripts/headless.mjs <scenario> --bleed FRAC | --naload Δ --phase2 S`,
optionally `--hset aldosterone_tc=…` to compress for a quick loop check):
- **Resting neutrality:** hormones ≈ 1.0; GFR/urine/FENa unchanged from the no-hormone calibration;
  disabling (`hormones_running=false`) is byte-identical.
- **Hemorrhage (−8% volume):** angiotensin/aldosterone↑, efferent constricts → GFR defended
  (adult 100 → 72 mL/min), urine → oliguria (1.0 → 0.64 mL/kg/hr).
- **Hyperosmolar (+12 mmol/L Na):** ADH↑ (1.0 → 1.35) → antidiuresis (urine 1.0 → 0.48 mL/kg/hr),
  RAAS stays quiet (osmolality drives only ADH).
- Stable over long physiologic-`tc` runs (no oscillation/railing).

## Simplifications / limitations (current scope)
- **Aldosterone's volume effect is muted:** the engine's water transport follows the water fraction,
  not osmotically coupled to Na, so aldosterone shows mainly as ↓FENa / ↓urine-Na rather than large
  volume shifts. ADH (water) and AngII (vasoconstriction) carry the volume/pressure defense.
- With **physiologic** `aldosterone_tc` (~30 min), aldosterone barely moves in short scenarios —
  expected; compress `aldosterone_tc` for interactive demos.
- While enabled, `Hormones` **owns** `Circulation.svr_factor_*`, `KID_CAP_KID_VEN.r_factor_ps`, and
  the Kidneys hormone factors — manual edits to those channels are overridden (same precedent as
  autoregulation owning `KID_ART.r_factor_ps`). The clean "off" switch is `hormones_running = false`
  (or per-pathway `raas_enabled` / `adh_enabled`), which releases the channels back to neutral.
- Not modeled: ANP / natriuretic peptides, thirst / fluid intake, direct osmotic water-follows-Na
  coupling. Severe (>~15%) acute hemorrhage can drive the circulation model to non-physiologic
  (negative) pressures — a pre-existing circulation limitation, independent of this layer.

````

### FILE: explain-engine/docs/Kidneys.md

````markdown
# Kidneys

The `Kidneys` model turns the otherwise passive renal vascular bed
(`KID_ART → KID_CAP → KID_VEN`) into an active filtration unit. It is a
**controller/process model** (like [`Placenta`](./Placenta.md)) — it holds no
blood itself, it operates on the existing glomerular capillary `KID_CAP` and a
new `URINE` bladder compartment it owns.

**Scope: fluid balance & urine output, per-solute reabsorption, and optional GFR autoregulation**
(myogenic + TGF, see below). Reabsorption fractions are static (no hormonal control yet); no
clearance/acid-base or RAAS/ADH — those are future phases.

## What it does each step

```
oncotic = oncotic_base · (KID_CAP.solutes.albumin / albumin_ref)   # rises with hemoconcentration
NFP     = max(0, KID_CAP.pres − p_bowman − oncotic)                 # Starling net filtration pressure
GFR     = kf_eff · NFP                                              # glomerular filtration rate (L/s)
Vf      = GFR · dt                                                  # filtrate volume this step (L)
Uw      = Vf · (1 − reabsorption_fraction)                          # net urine WATER leaving the blood
```

### Per-solute reabsorption (mass balance)

Each filterable solute is reabsorbed by **its own** fraction, so urine need not be
iso-osmotic with plasma. `_transfer(Vf, wr)` does a conservative **mass balance** (NOT
`volume_in`, which would copy *all* solutes incl. albumin/Hb and cause artifactual
proteinuria). With water fraction `wr` and per-solute fraction `fr[s]`:

```
fr[s]  = reabsorption_fractions[s]  (else wr)         # clamped [0, 0.9999]
Mf[s]  = Vf · C_plasma[s]                             # filtered solute mass
Mx[s]  = min(Mf[s] · (1 − fr[s]), C[s]·V)             # excreted mass (clamped to available)
C'[s]  = (C[s]·V − Mx[s]) / (V − Uw)                  # new blood conc (reabsorbed stays in blood)
URINE.solutes[s] = (URINE.solutes[s]·Uvol + Mx[s]) / (Uvol + Uw)
```

Only the **net** excreted water (`Uw`) and solute mass (`Mx`) leave `KID_CAP`; the
reabsorbed remainder is simply never removed (it returns to blood). `albumin` & `hemoglobin`
are **not** filtered — total mass conserved, concentration scaled by `vol_before/vol_after`
(hemoconcentration). Volume is guarded with a `1e-9` floor.

- **Backward compatible:** if `fr[s] = wr` for every solute (e.g. an empty
  `reabsorption_fractions`), then `Mx[s] = C[s]·Uw` and `C'[s] = C[s]` — urine is iso-osmotic
  with plasma and output is identical to the old single-fraction model.
- `fr[s] > wr` → solute concentrates in blood / **dilutes** in urine; `fr[s] < wr` →
  **concentrates** in urine.

Net effect: diuresis slowly lowers circulating blood volume; `URINE.vol` accumulates total
diuresis; the kidney now handles water and each solute independently (e.g. Na/Cl avidly
reabsorbed, phosphate/urate spilled).

> **Hormonal modulation hooks (driven by the [`Hormones`](./Hormones.md) RAAS/ADH model).** Two
> dedicated, neutral-by-default factor channels let a hormonal controller modulate reabsorption
> without colliding with the user/scenario `reabs_factor_ps` layer or the absolute
> `reabsorption_fractions` dict:
> - **`reabs_factor_adh`** (water) — a 4th multiplier folded into `_reabs_eff`
>   (`reabsorption_fraction · reabs_factor · reabs_factor_ps · reabs_factor_scaling_ps · reabs_factor_adh`).
>   ADH drives antidiuresis through it. Default `1.0`.
> - **`reabsorption_factors`** (per-solute dict) — multiplies each solute's fraction in `_solute_reabs`
>   (`fr ·= reabsorption_factors[s] ?? 1`), so aldosterone can retain Na (`na > 1`) and waste K
>   (`k < 1`); also reusable for diuretics. Default `{}` (every solute → 1.0). Distinct from the
>   absolute `reabsorption_fractions` dict (this modulates on top of it).
>
> Both default to neutral, so a scenario without a `Hormones` model is byte-identical. The absolute
> `reabsorption_fractions` is also still scheduler-tweakable per key
> (`setPropValue("Kidneys.reabsorption_fractions.na", …)`). The water fraction keeps its
> `reabs_factor`/`_ps`/`_scaling_ps` stack; explicit per-solute overrides track the `wr` fallback
> when absent.

## Read-outs
| Property | Unit | Meaning |
|---|---|---|
| `gfr` | mL/min | glomerular filtration rate |
| `urine_flow` | mL/min | net urine output |
| `nfp` | mmHg | net filtration pressure |
| `urine_volume` | mL | cumulative diuresis (= `URINE.vol × 1000`) |
| `fe_na` | % | fractional excretion of Na (= `(1 − fr_na)·100`) |

Per-solute urine concentrations live in `URINE.solutes`.

## Configuration
| Param | Meaning |
|---|---|
| `kidneys_running` | master gate (false → GFR/urine = 0, bladder holds) |
| `kf` | glomerular filtration coefficient (L/s·mmHg) — **the dominant, scenario-specific calibration knob** |
| `p_bowman` | Bowman's capsule pressure (mmHg) |
| `oncotic_base`, `albumin_ref` | plasma oncotic pressure at the reference albumin |
| `reabsorption_fraction` | **water** reabsorption fraction (urine water = GFR·(1−FR)) |
| `reabsorption_fractions` | per-solute reabsorption dict `{na, k, …}`; absent → uses the water fraction |
| `filterable_solutes` | small solutes filtered into urine (albumin/Hb excluded) |

`kf` carries the additive 3-layer factor stack (`kf_factor` / `_ps` / `_scaling_ps`),
`reabsorption_fraction` a multiplicative one (clamped to [0, 0.9999]). The two scenarios now ship
**distinct, headless-calibrated** per-solute fractions reflecting neonatal tubular immaturity (the
neonate excretes a larger fraction of every solute → higher FE across the board):

| reabsorption fraction | neonate | adult | → FE neonate / adult |
|---|---|---|---|
| water (`reabsorption_fraction`) | 0.980 | 0.990 | — |
| na | 0.990 | 0.993 | **1.0% / 0.7%** |
| cl | 0.988 | 0.991 | 1.2% / 0.9% |
| lact | 0.99 | 0.99 | 1.0% / 1.0% |
| ca | 0.975 | 0.985 | 2.5% / 1.5% |
| mg | 0.95 | 0.96 | 5.0% / 4.0% |
| k | 0.88 | 0.90 | 12% / 10% |
| phosphates | 0.82 | 0.88 | 18% / 12% |
| uma | 0.70 | 0.92 | 30% / 8% |

FENa is now **distinct** between scenarios (neonate ~1%, adult ~0.7%) — neonatal Na handling is
immature, so its FENa is correctly higher. Each Na/Cl fraction stays above its scenario's water
fraction (net-reabsorbed → dilute in urine); K/Mg/Ca/phosphate/urate fall below it (net-excreted →
concentrated in urine).

The `URINE` compartment is a `BloodCapacitance` declared in the Kidneys
`components` block (auto-instantiated by the base `init_model`), a pure sink with
no resistor connections (it never feeds back into the circulation).

> **Wiring note.** `KID_CAP` is a component of the `Circulation` model and may be
> instantiated *after* `Kidneys` in build order, so `_kid_cap` is resolved **lazily**
> on the first `calc_model` step (the `URINE` own-component is resolved in `init_model`).

## Calibration
`kf` differs ~6× between scenarios because baseline `KID_CAP.pres` differs
(neonate ≈ 37, adult ≈ 79 mmHg). Back-solve `kf ≈ target_GFR(L/s) / NFP_baseline`.
Targets: neonate GFR ~2–4 mL/min & urine ~1–3 mL/kg/hr; adult GFR ~90–110 mL/min
& urine ~0.5–1.5 mL/kg/hr. Keep `p_bowman + oncotic_base` well below `KID_CAP.pres`
(the neonate NFP margin is thin, ~11 mmHg) or filtration stops.

**Headless calibration.** Reproduce/re-tune with the in-repo runner
`node scripts/headless.mjs <term_neonate|adult_female>` (builds the scenario, freezes `Ans`,
steps to steady state, cycle-averages the renal panel: GFR, urine mL/kg/hr, NFP, the full FE
panel, urine concentrations, and `afferent_factor`). Override knobs without editing the scenario
JSON via `--kf`, `--water`, `--frac na=…,k=…`; add `--no-autoreg` to isolate raw filtration. The
shipped values were calibrated this way (autoregulation enabled, `Ans` disabled):

| measured (cycle-avg, steady state) | neonate | adult |
|---|---|---|
| GFR | 3.9 mL/min | 100 mL/min |
| urine output | 1.3 mL/kg/hr | 1.0 mL/kg/hr |
| FENa | 1.0% | 0.7% |
| NFP / `KID_CAP.pres` | 10.9 / 37.0 mmHg | 44.0 / 79.0 mmHg |
| `afferent_factor` (autoreg neutrality) | 1.02 | 0.88 |

Stable across 60–150 s warm-ups (no drift/oscillation); `afferent_factor` ≈ 1 confirms
autoregulation sits near-neutral at baseline (no railing).

## GFR autoregulation (myogenic + TGF)

Optional closed-loop autoregulation (`autoregulation_enabled`, **default `false`** → the
model is byte-identical to the no-autoregulation behaviour until toggled on). When enabled, a
controller adjusts the **afferent arteriole** — the `KID_ART` `BloodVessel` (`aff_vessel_name`)
— by writing its `r_factor_ps`. A `BloodVessel` owns its input resistor and pushes its computed
resistance into it every step, so this modulates the renal supply resistor `AD_KID_ART`.
Constricting it (`r_factor_ps > 1`) cuts renal inflow → lowers `KID_CAP.pres` → NFP → GFR (and
α-couples a small elastance stiffening); dilating (`< 1`) raises them. Renal blood flow
autoregulates alongside GFR. The controller runs on a 15 ms tick (`u`); each limb and the
applied factor are first-order lagged (`x += u·(1/tc)·(−x + target)`).

> **Why control the afferent vessel (upstream of the sensor), not the glomerular inflow.** The
> myogenic limb senses `KID_ART.pres`, which sits *downstream* of `AD_KID_ART`. Constricting
> `AD_KID_ART` lowers `KID_ART.pres` (more drop upstream), so the loop is **negative feedback**
> (sense high → constrict → pressure falls → self-correcting). Controlling the downstream
> `KID_ART_KID_CAP` resistor instead would *raise* the sensed pressure when it constricts —
> positive feedback that rails the operating point. `AD_KID_ART` is also the dominant series
> resistance, so a firm plateau needs only modest gain.

**Myogenic limb (fast, `myogenic_tc ≈ 4 s`)** — senses the pressure the afferent feels
(`myogenic_input_model.myogenic_input_prop`, default `KID_ART.pres`). Piecewise-linear,
saturating outside the autoregulatory window `[p_min, p_max]`:

```
act = clamp(p_in, p_min, p_max) − p_set                 # deviation, saturated at the shoulders
gain = (p_in >= p_set) ? gain_up : gain_down
myo_target = 1 + gain·act                               # at setpoint → 1.0; rise → constrict
```

**TGF limb (slow, `tgf_tc ≈ 30 s`)** — senses distal NaCl delivery
`tgf_signal = GFR × KID_CAP.solutes.na` (`tgf_use_nacl`; falls back to `GFR` alone). When
`tgf_setpoint ≤ 0` it **auto-seeds**: the signal is smoothed by an EMA and the setpoint is
captured only after a `tgf_seed_delay` (default 30 s) warm-up, so it reflects the steady
state rather than the startup transient (seeding too early biases it low → standing
constriction at rest). The TGF limb stays neutral (`tgf_factor = 1`) until seeded.

```
err = (tgf_signal − tgf_setpoint) / tgf_setpoint
tgf_target = 1 + tgf_gain·err                           # high delivery → constrict
```

**Combine → clamp → lag → write** (`afferent_apply_tc ≈ 6 s`):

Each limb target is floored at a small positive (`_limb_factor_floor`) so a large downward
deviation × high gain can't drive a factor negative. Then:

```
combined = myogenic_factor · tgf_factor                 # multiplicative
combined = clamp(combined, afferent_factor_min, afferent_factor_max)
afferent_factor ← lag(afferent_factor → combined)       # then re-clamp
KID_ART.r_factor_ps = afferent_factor                   # vessel propagates to AD_KID_ART
```

As perfusion pressure (`AD.pres`) rises, the afferent constricts and holds GFR / renal blood
flow ~flat; beyond the window the factor saturates and GFR follows pressure again (the classic
shoulders). The three lags + hard clamp keep the loop well-damped and `r_for_eff > 0`.

| Read-out | Meaning |
|---|---|
| `myogenic_factor` / `tgf_factor` | per-limb afferent multipliers |
| `afferent_factor` | applied (lagged, clamped) `r_factor_ps` on the afferent |
| `sensed_pressure` | pressure driving the myogenic limb (mmHg) |
| `tgf_signal` | current TGF signal (`GFR×Na` or `GFR`) |

> **Ordering / one-step sensor delay.** `Kidneys` is a top-level model, so it steps before the
> `Circulation` sub-compartments (`KID_ART`, `AD_KID_ART`, …) that are created during the build's
> init pass. It therefore writes `KID_ART.r_factor_ps` **before** `KID_ART` steps and composes it
> into the resistance it pushes to `AD_KID_ART` — same step, no effector lag (and `r_factor_ps`
> persists, so ordering is non-fatal regardless). `Kidneys` reads `KID_ART.pres` from the previous
> step's pass — a deliberate one-step sensor delay the lags absorb. Disabling mid-run writes
> `KID_ART.r_factor_ps` back to `1.0` once, restoring linear behaviour.

**Calibration.** Set `myogenic_p_set` to each scenario's baseline `KID_ART.pres` so the
controller is near-neutral at steady state (the negative feedback makes this a fine-centering,
not a stability requirement). Both scenarios ship **enabled**:

| param | neonate | adult |
|---|---|---|
| `autoregulation_enabled` | **true** | **true** |
| `myogenic_p_set` / `_p_min` / `_p_max` | 40 / 25 / 65 | 83 / 55 / 140 |
| `myogenic_gain_up` / `_down` | 0.18 | 0.25 |
| `myogenic_tc` | 4 s | 4 s |
| `tgf_gain` / `tgf_tc` | 2.0 / 30 s | 3.0 / 30 s |
| `afferent_apply_tc` | 6 s | 6 s |
| `afferent_factor_min` / `max` | 0.5 / 10.0 | 0.5 / 20.0 |
| `tgf_setpoint` | 0 (auto-seed) | 0 (auto-seed) |

Validated headless (build the scenario, disable `Ans`, cycle-average, sweep preload to vary the
upstream perfusion pressure `AD.pres`). Measured against `AD.pres` (the controller regulates
`KID_ART.pres`, so it cannot be the x-axis): autoregulation cuts GFR variation **~77%** (neonate)
and **~79%** (adult) vs off, stable, with ANS-on baseline `afferent_factor` ≈ 1.0 (neonate 1.02,
adult 0.88) — no railing.

## Simplifications (current scope)
- Autoregulation is **opt-in**; with it off, GFR rides directly on `KID_CAP.pres` (linear in
  perfusion pressure).
- Oncotic pressure is linear in albumin (not Landis-Pappenheimer).
- Reabsorption is per-solute (each solute its own fraction), but **static** — no tubular load /
  transport-maximum / secretion kinetics, and not yet hormonally driven (RAAS/ADH is the next phase).
- `URINE` never empties on its own (a future `void_bladder()` function can reset it).

````

### FILE: explain-engine/docs/Lactate.md

````markdown
# Lactate

The `Lactate` model turns the previously-**static** `lact` blood solute into a **hypoxia-driven
product** — a slow process/controller in the same family as [`Hormones`](./Hormones.md) and
[`Glucose`](./Glucose.md). It holds no compartment of its own, resolves references to other models
lazily, runs on an `_update_interval`, and is **NEUTRAL at rest**: with tissues adequately oxygenated
there is no O₂ debt (no production), and lactate already sitting at its baseline produces no net
clearance flux. A scenario shipping a `Lactate` model therefore keeps its baseline ABG and only
diverges when tissue oxygenation falls (shock, asphyxia, severe hypoxia).

## Inheritance

```
BaseModelClass
  └── Lactate   (hypoxia-driven lactate → Stewart SID → metabolic acidosis)
```

Lactate extends `BaseModelClass` directly. Like [`Metabolism`](./Metabolism.md) and the other process
models it owns no compartment; it only writes `solutes.lact` onto existing blood compartments.

## What it models

Anaerobic lactate production under tissue O₂ debt, plus first-order whole-body clearance toward a
resting baseline. It reuses [`Metabolism`](./Metabolism.md)'s tissue consumption map and whole-body
VO₂ to locate the sites and size the O₂ demand, captures each site's resting tissue `to2` over a
warm-up window, and produces lactate in proportion to the unmet O₂ demand when `to2` falls below a
fraction of that resting level.

## Why it changes pH with no solver change

`Lactate` writes **only** `solutes.lact` on the blood compartments. The existing Stewart acid-base
solver in [`BloodComposition`](./BloodComposition.md) already consumes `lact` as a strong anion when
it forms the strong-ion difference:

```js
sid = sol["na"] + sol["k"] + 2 * sol["ca"] + 2 * sol["mg"] - sol["cl"] - sol["lact"];
```

Raising `lact` lowers the SID → lower pH / HCO3 / BE — i.e. a **lactic metabolic acidosis** — with no
change whatsoever to the solver. The coupling is one-directional (the O₂ sensors in `Mob`/`Ans` read
`to2`, not pH), so there is no oscillation risk.

**Insertion order matters.** Lactate must run **after** [`Metabolism`](./Metabolism.md) (which sets
each tissue's `to2` for the step) and **before** `Blood` (which solves composition). This is handled
by the model's position in the scenario JSON `models` map — insert it just after `Metabolism`.

## Properties

### Configuration (independent)

| Property | Unit | Default | Description |
|---|---|---|---|
| `lactate_running` | bool | `true` | Master gate — `false` stops production (clearance still settles once toward baseline) |
| `metabolism_name` | string | `"Metabolism"` | Name of the model supplying the tissue map + VO₂ |
| `lact_baseline` | mmol/L | `1.0` | Resting blood lactate; the clearance target |
| `threshold_frac` | unitless | `0.5` | Anaerobic threshold as a fraction of each site's resting-MINIMUM `to2` |
| `lact_per_o2_deficit` | mmol/mmol | `0.33` | Lactate produced per mmol of unmet O₂ demand (~2 lactate per glucose / 6 O₂ per glucose) |
| `lact_clearance` | 1/s | `0.002` | First-order clearance rate toward baseline (t½ ≈ 6 min) |
| `prod_gain` | unitless | `1.0` | Overall scaler on production (clinical-tuning convenience) |

### Computed / read-out (dependent)

| Property | Unit | Description |
|---|---|---|
| `arterial_lactate` | mmol/L | `AA.solutes.lact` arterial read-out |
| `total_production_step` | mmol | Total lactate produced in the last update |
| `anaerobic_fraction_max` | 0..1 | Worst-site anaerobic fraction this update |

### Local / internal (`_`-prefixed)

| Property | Unit | Description |
|---|---|---|
| `_update_interval` | s | Controller cadence (`1.0`) |
| `_warmup_delay` | s | Window over which the resting-MINIMUM site `to2` is captured (`90.0`) |
| `_seeded` | bool | Set once warm-up completes; production stays gated off until then |
| `_baseline_to2` | object | Per-site resting (minimum) `to2` captured at warm-up |
| `_blood_components` | array | Cached list of compartments carrying a `lact` solute |
| `_metabolism` | ref | Cached reference to the Metabolism model |

## Per-tissue-site mechanism (`_update_lactate`)

`Lactate` reuses `Metabolism.metabolic_active_models` (the tissue consumption map, per-site VO₂
fraction `fvo2`) plus the whole-body `vo2`, `vo2_factor` and `vo2_temp_factor`. For each active site
(a `MicroVascularUnit` is followed to its `_CAP` compartment):

```
threshold = threshold_frac * resting_to2          (resting captured at warm-up, see below)
anaerobic = clamp((threshold − to2) / threshold, 0, 1)        (the Mob activation idiom)

local_o2_demand = (0.039 · vo2 · vo2_factor · vo2_temp_factor · weight / 60) · u · fvo2   [mmol O₂]
lactate_produced (mmol) = anaerobic · local_o2_demand · lact_per_o2_deficit · prod_gain
   → comp.solutes.lact += lactate_produced / comp.vol
```

(`u` is the elapsed time since the last update, normally `_update_interval`.) `lact_per_o2_deficit
≈ 0.33` reflects ~2 lactate per glucose / 6 O₂ per glucose ⇒ ~0.33 mmol lactate per mmol of unmet O₂
demand.

**Clearance** runs every update on every blood compartment carrying a `lact` solute, relaxing
first-order toward `lact_baseline` (Cori cycle / hepatic + renal handling):

```
comp.solutes.lact += (lact_baseline − comp.solutes.lact) · lact_clearance · u
```

## The hypoxia threshold: minimum-over-warm-up capture

The per-site anaerobic `threshold` auto-seeds from the running **MINIMUM** tissue `to2` captured
across the warm-up window (`_warmup_delay`, 90 s) — **not** a single instant. Each warm-up step,
`_baseline_to2[site]` is set to `min(previous, comp.to2)`. Using the trough makes the threshold
(`threshold_frac · resting`, i.e. 50 % of the resting minimum at the default `threshold_frac`) sit
below the operating low point, so the model stays neutral at rest even in **chronically hypoxic**
scenarios (cyanotic CHD, fetus) whose steady-state tissue `to2` is low and swings cyclically near the
threshold.

Production is gated off entirely until `_seeded` becomes true (`_warmup_counter >= _warmup_delay`);
before that the model only settles compartments toward baseline via clearance. This is what makes a
freshly built scenario neutral at rest: no spurious lactate surge during the startup transient.

## Calculation cadence (`calc_model`)

`calc_model` accumulates `_t` into `_update_counter` and, once it reaches `_update_interval` (1 s),
calls `_update_lactate(u)` with the elapsed interval `u` and resets the counter. References are
resolved lazily in `_resolve_refs` (the Metabolism model and the list of `lact`-carrying
compartments) on first use.

## Example definition (JSON)

From `term_neonate.json`:

```json
{
  "name": "Lactate",
  "description": "hypoxia-driven lactate production",
  "is_enabled": true,
  "model_type": "Lactate",
  "components": {},
  "lactate_running": true,
  "metabolism_name": "Metabolism",
  "lact_baseline": 1,
  "threshold_frac": 0.5,
  "lact_per_o2_deficit": 0.33,
  "lact_clearance": 0.002,
  "prod_gain": 1
}
```

## Usage in the model

- Insert immediately after [`Metabolism`](./Metabolism.md) in the scenario `models` map (after the
  tissue `to2` is set for the step, before `Blood` solves composition).
- Neutral at rest in every shipping scenario; it diverges only under tissue O₂ debt, where it produces
  a lactic metabolic acidosis through the Stewart SID with no solver change.

## See also
- [`Metabolism`](./Metabolism.md) — supplies the tissue consumption map and VO₂; sets `to2` each step.
- [`BloodComposition`](./BloodComposition.md) — the Stewart solver that turns `lact` into a pH shift.
- [`Mob`](./Mob.md) — the myocardial O₂ balance model whose `clamp` activation idiom is reused here.
- [`Glucose`](./Glucose.md) — sibling slow-process solute model.

````

### FILE: explain-engine/docs/MODEL_DEFINITIONS.md

````markdown
# Model definitions (scenario files)

A scenario file is a single JSON document that describes one complete patient/experiment: the engine settings, every model instance with its parameters and current state, plus the UI metadata (diagram, animation, saved tabs/presets) that consumers may attach. The canonical library lives in this repo at `model_definitions/*.json`, with `model_definitions/index.json` listing the available scenarios — a flat JSON array of filename **stems** (no `.json`), each a valid argument to `Model.load(name)`. `Model.load(name)` fetches `<name>.json`, unwraps it, and hands the result to `build()`; how the file is served is the consumer's business.

> **This repo is the source of truth for scenarios — edit `model_definitions/` here.**
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
| `weight` | number (kg) | Patient weight. Frozen at build into `model._baseline_weight` (the allometric anchor for `reset()` / `scale_to_weight()`). |
| `height` | number (m) | Patient height. Engine-stored; used by models that need it. |
| `gestational_age` | number (weeks) | Gestational age. |
| `age` | number | Postnatal age. |
| `modeling_stepsize` | number (s) | Integration step. `calculate(sec)` runs `sec / modeling_stepsize` steps; the realtime loop batches `rtInterval / modeling_stepsize` steps per tick. |
| `model_time_total` | number (s) | Accumulated simulation time. **Non-zero in saved scenarios** — the file is a mid-run snapshot, not a fresh state (see below). |
| `_baseline_weight` | number (kg) | Persisted allometric baseline. Note `build()` overwrites this from `weight` regardless, so the two normally match. |
| `scaler_config` | object | Named lists of component names per scaling group, read by `ModelScaler`. See [`scaler_config`](#scaler_config). |
| `models` | object | `name → entry` map of every model instance. The heart of the file. See below. |
| `diagram_definition` | object | Optional nested copy of the sprite diagram (else back-filled from top level). |
| `animation_definition` | object | Optional nested copy of the animation layout (else back-filled from top level). |

## `models` entry shape

`models` is a map keyed by instance name. Each entry is one model instance. The reference `term_neonate.json` has 68 top-level entries (1 each of the high-level systems — `Heart`, `Breathing`, `Ans`, `Circulation`, `Respiration`, `Blood`, `Gas`, `Metabolism`, `Pda`, `Shunts`, devices, …) plus 43 `Resistor` entries wiring compartments together. Composite models (e.g. `Circulation`) carry their own sub-network under `components`.

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
| `<p>_factor_scaling_ps` | persistent | **only** `ModelScaler` (allometric/manual scaling) |

`p_eff = p + (factor-1)*p + (factor_ps-1)*p + (factor_scaling_ps-1)*p`.

### Entries are full state snapshots, not pure config

This is the most important thing to understand about the format. A `models` entry is **not** a clean config block — it is a serialized dump of the live object, including computed outputs: `*_eff` effective values, `vol`, `pres`/`pres_in`/`pres_tm`, `flow`/`flow_forward`/`flow_backward`, and the full blood composition (`to2`, `tco2`, `ph`, `pco2`, `po2`, `so2`, `hco3`, `be`, `solutes`, `drugs`, `temp`, `viscosity`). `init_model` re-seeds these computed fields straight from the entry, which is why `model_time_total` is non-zero and a loaded scenario **resumes mid-run** at a settled steady state rather than starting from a transient. Authoring a scenario by hand means setting these consistently (or accepting a startup transient); the normal workflow is to let the engine settle, then save the snapshot.

### Example — a `Resistor` entry (verbatim from `term_neonate.json`)

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
  "is_externally_managed": false,
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

In `term_neonate.json` the blood compartments are `BloodVessel` (a `BloodCapacitance` subclass that adds resistance/flow) living inside `Circulation.components`; a standalone `BloodCapacitance` has the same capacitance + composition shape minus the resistor fields. Abbreviated:

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

  "vol": 0.006732, "pres": 68.105, "pres_in": 70.524, "pres_tm": 72.942,
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

`scaler_config` is engine-consumed, but only via `ModelScaler` — it is never read by `build()` itself beyond being copied onto the live `model`. Its shape is `group → { param → [componentNames] }` (or, for the container groups, `group → [componentNames]`). The group keys present in `term_neonate.json`:

```
blood, blood_pulmonary, blood_systemic,
heart, heart_left, heart_right,
lung, airway, left_lung, right_lung,
thorax, pericardium
```

Each group lists the component names that a given `scale_*` method touches, and the param sub-keys name which property gets scaled — e.g. `blood.volume`, `blood.el_base`, `blood.resistance`; `heart.el_min` / `heart.el_max`. `ModelScaler` writes **only** the `*_factor_scaling_ps` layer (`el_base_factor_scaling_ps`, `r_factor_scaling_ps`, `u_vol_factor_scaling_ps`, `el_min_/el_max_factor_scaling_ps`), except the volume groups which scale `vol`/`u_vol` directly. `scaleModel(group, factor)` in the API routes to these methods. See [ModelScaler](./ModelScaler.md).

## `configuration` and events

`configuration` is **UI/store-only state** — the engine never reads it in `build()`. In `term_neonate.json` it holds `diagram_speed`, `diagram_scale`, `chart_hires`, `default_tabs`, `tabs`, `presets`, `monitors`, `controllers`.

It may also carry an optional `configuration.events` array (absent in `term_neonate.json`). Events are named, reusable bundles of timed property changes. They reach the engine **only** indirectly: the events store mirrors `configuration.events` in memory and, when an event fires, pushes each change through `Model.setPropValue` / `callModelFunction`, which the engine's [TaskScheduler](./TaskScheduler.md) applies. The shapes (explain-ui's `src/stores/events.ts`):

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
["adult_female", "term_neonate", "term_fetus", "preterm_28wk", "..."]
```

Each entry `X` maps to `model_definitions/X.json` and is a valid argument to `Model.load("X")`. Add a scenario here to make it selectable in consuming apps. (In explain-ui, `sync-scenarios.mjs` rebuilds its served `index.json` as the union of the canonical set and any local snapshots.)

````

### FILE: explain-engine/docs/MaternalPlacenta.md

````markdown
# MaternalPlacenta

The `MaternalPlacenta` model is a **controller/process model** (extends `BaseModelClass`) for the
**maternal** side of the placenta: the perfused **intervillous space** (`PL_IVS`), a low-resistance
blood lake fed by the **spiral arteries** off the uterine arterial supply (`UT_ART`) and draining to
the uterine veins (`UT_VEN`), in parallel with the non-placental uterine tissue (`UT_CAP`). Like
[Uterus](./Uterus.md) and [Placenta](./Placenta.md) it owns no blood of its own — it operates on the
existing `PL_IVS` compartment that `Circulation` supplies, gating and scaling it from a single set of
parameters. Its perfusion grows from ~0 (non-pregnant: the placenta does not exist) to the
**dominant share** of uterine flow at term, driven entirely by the `Uterus`'s pregnancy gestational
age (`preg_ga`).

> **Maternal vs fetal — do not confuse the two placenta models.** [`Placenta`](./Placenta.md) is the
> **fetal** placental circulation: fetal blood runs through the umbilical vessels to the fetal-side
> capillary (`PL_FETAL_CAP`) and exchanges gas across the membrane with a *fixed-composition* maternal
> pool (`PL_MAT`). `MaternalPlacenta` is the **maternal** side: a real, perfused intervillous bed
> (`PL_IVS`) carrying maternal blood off the uterine circulation, with its own flow, metabolism, and
> contraction response. The legacy `PL_MAT` fixed pool used by the fetal `Placenta` is left untouched
> by this model; the two are not yet coupled (see *Usage in the model*).

## Inheritance

```
BaseModelClass
  └── MaternalPlacenta   (maternal intervillous-space controller)
```

## What it models

`MaternalPlacenta` runs once per step (`calc_model`) and, when the bed is active, does five things to
the `PL_IVS` compartment and its connecting resistors:

1. **Growth with gestation.** The spiral arteries dilate as pregnancy advances. The model scales
   `PL_IVS`'s input resistance down with GA via the persistent `r_factor_scaling_ps` layer, so
   maternal placental blood flow grows from near-zero early to the dominant share of uterine flow at
   term. The spiral-artery resistor *is* `PL_IVS`'s own input resistor.
2. **Gating.** When not pregnant (or stopped) the bed is held `no_flow` on both the spiral inflow and
   the drainage, so it adds zero perturbation to the calibrated uterine baseline. `PL_IVS` stays
   `is_enabled` (an inert pool with a defined pressure).
3. **Placental metabolism.** A dedicated placental VO2 is applied to `PL_IVS` using the same molar
   conversion as `Metabolism`/`Uterus` (`0.039 mmol O2/mL`), giving real O₂ extraction across the
   intervillous space.
4. **Contraction compression.** The uterine intrauterine pressure (`Uterus.iup`) is applied as
   external pressure on `PL_IVS`, so contractions throttle placental perfusion.
5. **Read-outs.** Placental blood flow (mL/min), its share of uterine flow (%), DO2, VO2, O2ER, and
   the arterio-venous O₂ content difference.

The spiral-artery resistor (`UT_ART_PL_IVS`) hangs off `UT_ART` in **parallel** with the
non-placental myometrial capillary (`UT_CAP`); both beds drain into the common `UT_VEN`:

```
            ┌──[UT_ART_PL_IVS]──► PL_IVS ──[PL_IVS_UT_VEN]──┐
UT_ART ─────┤   (spiral arteries)  (intervillous bed)        ├──► UT_VEN
            └──────────────────► UT_CAP ─────────────────────┘
                                 (non-placental myometrium)
```

## Properties

### Configuration (independent parameters)

| Property | Unit | Description |
|---|---|---|
| `mp_running` | bool | Master gate. Flow is *additionally* gated by pregnancy (read from the `Uterus`). |
| `pl_ivs_name` | string | Name of the intervillous-space compartment (the blood lake). Default `"PL_IVS"`. |
| `spiral_res_name` | string | Name of the spiral-artery resistor — owned by `PL_IVS`, equals its `r_for_eff`. Default `"UT_ART_PL_IVS"`. |
| `drain_res_name` | string | Name of the drainage resistor (owned by `UT_VEN`). Default `"PL_IVS_UT_VEN"`. |
| `ut_art_name` | string | Arterial source compartment, for arterial O₂-content read-outs. Default `"UT_ART"`. |
| `ut_in_res_name` | string | Total uterine inflow resistor, for the flow-share read-out. Default `"AD_UT_ART"`. |
| `uterus_name` | string | Where `preg_ga` / `pregnant` / `iup` are read from (single source of truth). Default `"Uterus"`. |
| `preg_ga_threshold` | weeks | Below this GA the placenta is treated as absent (no flow). Default `4.0`. |
| `preg_ga_term` | weeks | GA anchor at which the term dilation is reached. Default `40.0`. |
| `spiral_res_term_factor` | unitless | `PL_IVS` resistance multiplier at term (small → large flow). Default `0.01`. |
| `met_active` | bool | Placental O₂ consumption / CO₂ production on/off. Default `true`. |
| `mp_vo2` | mL O₂/kg/min | Placental oxygen use (scenario-calibrated). Default `0.04`. |
| `vo2_factor` | unitless | Non-persistent VO2 multiplier — reset to `1.0` every step. Default `1.0`. |
| `vo2_factor_ps` | unitless | Persistent VO2 multiplier (interventions). Default `1.0`. |
| `resp_q` | unitless | Respiratory quotient (CO₂ produced / O₂ consumed). Default `0.8`. |
| `contraction_pres_gain` | unitless | Fraction of the uterine IUP applied as `pres_ext` on `PL_IVS`. Default `0.6`. |

### Read-outs (dependent parameters)

| Property | Unit | Description |
|---|---|---|
| `mp_blood_flow` | mL/min | Maternal placental blood flow (EMA-smoothed spiral-artery flow). |
| `mp_flow_fraction` | % | Placental flow as a percentage of total uterine inflow. |
| `mp_do2` | mL O₂/min | Oxygen delivery into the intervillous space. |
| `mp_vo2_ml` | mL O₂/min | Oxygen uptake. |
| `mp_o2er` | % | Oxygen extraction ratio (`mp_vo2_ml / mp_do2`). |
| `mp_avo2` | mmol/L | Arterio-venous O₂ content difference (`UT_ART.to2 − PL_IVS.to2`). |
| `mp_active` | bool | Whether the placental bed is perfused (pregnant **and** running). |

### Internal state (not configured)

`_pl_ivs`, `_spiral_res`, `_drain_res`, `_ut_art`, `_ut_in_res`, `_uterus` are lazily-resolved model
references (resolved in `calc_model`, not `init_model`, since they may be built after this controller).
`_flow_ema` / `_ut_in_ema` are exponentially-smoothed flows (L/s) and `_flow_tc` (5.0 s) is the
smoothing time constant.

## `init_model(args)`

Calls `super.init_model(args)` to apply the config args. It does **not** resolve the compartment /
resistor / `Uterus` references — those are resolved lazily inside `calc_model` so the model is
independent of build order.

## `calc_model()`

Runs every step. Steps in order:

1. **Lazy reference resolution.** Resolve any still-null reference (`_pl_ivs`, `_spiral_res`,
   `_drain_res`, `_ut_art`, `_ut_in_res`, `_uterus`) from `model_engine.models`. If `PL_IVS` cannot be
   found, return immediately.

2. **Pregnancy progress.** Read `ga = Uterus.preg_ga` and `pregnant = Uterus.pregnant`. Compute a
   normalized fraction:

   ```
   frac = 0
   if pregnant and ga > preg_ga_threshold:
       frac = (ga - preg_ga_threshold) / (preg_ga_term - preg_ga_threshold)   # clamped to ≤ 1.0
   active = mp_running and frac > 0
   mp_active = active
   ```

3. **Gating.** Re-asserted every step:
   - `PL_IVS.no_flow = !active` and `drain_res.no_flow = !active`. A non-pregnant or stopped placenta
     is perfectly inert (no perturbation of the uterine baseline), but `PL_IVS` stays `is_enabled` so
     it retains a defined pressure.
   - If **not active**: restore `PL_IVS.r_factor_scaling_ps = 1.0` (the layer this model owns), zero
     all read-outs, and return.

4. **Spiral-artery dilation.** Scale `PL_IVS` input resistance down with GA:

   ```
   res_factor = 1.0 + frac * (spiral_res_term_factor - 1.0)
   PL_IVS.r_factor_scaling_ps = res_factor
   ```

   Written every step (idempotent — the engine recomputes `r_for_eff` from the base each step;
   `BloodVessel` composes `r_factor_scaling_ps` multiplicatively, disjoint from the layers any other
   model writes).

5. **Contraction compression.** Add the uterine IUP as external pressure on the bed:

   ```
   PL_IVS.pres_ext += Uterus.iup * contraction_pres_gain
   ```

   Re-asserted each step (the compartment resets `pres_ext` after use).

6. **Placental metabolism (when `met_active` and `PL_IVS.vol > 0`).** VO2 is scaled by **perfusion**,
   not GA, so a small early-gestation placenta with little flow consumes little O₂ (a full-strength
   VO2 on a tiny early flow would drive O2ER far above 100%):

   ```
   flow_ratio = (res_factor > 0) ? spiral_res_term_factor / res_factor : 0      # 0..1, ~1 at term
   vo2_eff    = mp_vo2 * vo2_factor * vo2_factor_ps * flow_ratio                 # mL O2/kg/min
   vo2_step   = (O2_MMOL_PER_ML * vo2_eff * model.weight / 60.0) * _t            # mmol per step

   PL_IVS.to2  = max(0, (PL_IVS.to2 * vol - vo2_step) / vol)
   PL_IVS.tco2 = max(0, (PL_IVS.tco2 * vol + vo2_step * resp_q) / vol)
   mp_vo2_ml   = vo2_eff * model.weight                                         # mL O2/min
   ```

   where `O2_MMOL_PER_ML = 0.039` and `vol = PL_IVS.vol`. Then `vo2_factor` is reset to `1.0`. When
   inactive metabolism, `mp_vo2_ml = 0`.

7. **Smoothed flows (EMA).** With `alpha = _t / (_flow_tc + _t)`:

   ```
   _flow_ema  += (spiral_res.flow  - _flow_ema)  * alpha     # L/s
   _ut_in_ema += (ut_in_res.flow   - _ut_in_ema) * alpha     # L/s
   mp_blood_flow   = _flow_ema * 60000.0                     # L/s -> mL/min
   mp_flow_fraction = (_ut_in_ema > 0) ? (_flow_ema / _ut_in_ema) * 100.0 : 0   # %
   ```

   Both numerator and denominator of the share are smoothed so the ratio is not polluted by pulsatile
   sampling.

8. **O₂ delivery / extraction read-outs.** Arterial content is taken from `UT_ART` (falls back to
   `PL_IVS` if `_ut_art` is missing); venous content is `PL_IVS`:

   ```
   art_to2    = ut_art ? ut_art.to2 : PL_IVS.to2
   flow_l_min = _flow_ema * 60.0                              # L/min
   mp_do2  = (flow_l_min * art_to2) / O2_MMOL_PER_ML          # mL O2/min
   mp_avo2 = art_to2 - PL_IVS.to2                             # mmol/L
   mp_o2er = (mp_do2 > 0) ? (mp_vo2_ml / mp_do2) * 100.0 : 0  # %
   ```

## Factor system

`MaternalPlacenta` does not expose a base/`_ps`/`_scaling_ps` factor triplet of its own. It is a
controller that **writes** other models' factor layers:

- **`PL_IVS.r_factor_scaling_ps`** — owned and written by this model for spiral-artery dilation. It is
  the *scaling* layer, disjoint from the ANS (`r_factor`/`r_factor_ps`) layers, and composes
  multiplicatively in `BloodVessel`. When the bed is inactive this model restores it to `1.0`.
- **`vo2_factor` / `vo2_factor_ps`** — multipliers on the placental VO2 (non-persistent and persistent
  respectively), mirroring the `Uterus` / `Metabolism` convention. `vo2_factor` is reset to `1.0`
  every step.

## Example definition (JSON)

From `model_definitions/adult_female_uterus.json`:

```json
{
  "name": "MaternalPlacenta",
  "description": "maternal placenta: perfused intervillous space fed by spiral arteries off the uterine bed",
  "is_enabled": true,
  "model_type": "MaternalPlacenta",
  "components": {},
  "mp_running": true,
  "pl_ivs_name": "PL_IVS",
  "spiral_res_name": "UT_ART_PL_IVS",
  "drain_res_name": "PL_IVS_UT_VEN",
  "ut_art_name": "UT_ART",
  "ut_in_res_name": "AD_UT_ART",
  "uterus_name": "Uterus",
  "preg_ga_threshold": 4,
  "preg_ga_term": 40,
  "spiral_res_term_factor": 0.0075,
  "met_active": true,
  "mp_vo2": 0.33,
  "vo2_factor": 1,
  "vo2_factor_ps": 1,
  "resp_q": 0.8,
  "contraction_pres_gain": 0.6,
  "mp_blood_flow": 0,
  "mp_flow_fraction": 0,
  "mp_do2": 0,
  "mp_vo2_ml": 0,
  "mp_o2er": 0,
  "mp_avo2": 0
}
```

The scenario also defines the compartment and resistors this model drives: `PL_IVS`
(a `BloodCapacitance`/`BloodVessel` intervillous lake), `UT_ART_PL_IVS` (spiral-artery resistor off
`UT_ART`), and `PL_IVS_UT_VEN` (drainage to `UT_VEN`). The scenario value
`spiral_res_term_factor = 0.0075` is slightly lower than the class default (`0.01`) to hit the target
term placental flow.

## Usage in the model

- **Scenario:** ships in `adult_female_uterus`, the maternal pregnancy scenario built on
  `adult_female`. It is the *maternal placenta (Part 5)* layer on top of the uterine bed (Part 1) and
  the [`Uterus`](./Uterus.md) organ (Parts 2–4).

- **Coupling with the [Uterus](./Uterus.md).** The `Uterus` is the single source of truth for
  pregnancy state. `MaternalPlacenta` reads `Uterus.preg_ga` and `Uterus.pregnant` (to gate and scale
  flow) and `Uterus.iup` (to compress the bed during contractions). The `Uterus` itself dilates the
  *conduit* and *myometrial* (`UT_CAP`) beds via its own `preg_*` scaling; note its
  `preg_cap_res_term_factor` lets the non-placental myometrium stay a modest minority while the
  intervillous bed carries the dominant share at term. Both `UT_CAP` and `PL_IVS` drain into the
  **common `UT_VEN`**, which is why the `Uterus`'s `ut_o2er` read-out is computed from the
  arterio-venous content difference rather than a single bed's VO2/DO2.

- **Spiral arteries off `UT_ART`, parallel to `UT_CAP`.** The spiral-artery resistor `UT_ART_PL_IVS`
  taps the same arterial source as the myometrial capillary, so dilating `PL_IVS`'s input resistance
  (lowering `spiral_res_term_factor`) shifts the share of uterine inflow toward the placenta — the
  `mp_flow_fraction` read-out tracks this share.

- **Contrast with the fetal [Placenta](./Placenta.md).** The fetal `Placenta` model exchanges gas
  across the membrane with a fixed-composition maternal pool (`PL_MAT`) — an infinite reservoir held
  at `mat_to2`/`mat_tco2`, not a perfused bed. `MaternalPlacenta` models the maternal blood lake
  (`PL_IVS`) as a *real* perfused compartment with its own inflow, metabolism, and venous drainage.
  The two are **not yet coupled**: there is no `PL_GASEX`-style diffusor between `PL_IVS` and a fetal
  capillary in this version (that requires a combined mother+fetus scenario with a fetal circulation).
  The legacy fixed `PL_MAT` pool is left untouched, and `MaternalPlacenta` runs standalone on the
  maternal side. The `Uterus`'s `couple_placenta` hook drives `PL_MAT` (the fetal-`Placenta` pool)
  from uterine arterial blood — that is a separate mechanism and does not feed `PL_IVS`.

````

### FILE: explain-engine/docs/Metabolism.md

````markdown
# Metabolism

The Metabolism model is the whole-body tissue **oxygen sink and CO₂ source**. Every model step it
removes oxygen from, and adds carbon dioxide to, a configured set of blood compartments, driving the
arterio-venous gas gradient that the rest of the circulation transports and the lungs/placenta clear.
It is the counterpart to gas exchange ([`GasExchanger`](./GasExchanger.md), `BloodDiffusor`):
exchange *loads* O₂ and *unloads* CO₂ at the lung/membrane; metabolism *unloads* O₂ and *loads* CO₂ at
the tissues.

## Inheritance

```
BaseModelClass
  └── Metabolism   (whole-body O₂ consumption / CO₂ production)
```

Metabolism extends `BaseModelClass` directly. It is a *process* model: it holds no compartment of its
own and instead writes `to2`/`tco2` onto the blood compartments named in `metabolic_active_models`.

## What it models

A single whole-body oxygen consumption `vo2` (ml O₂ / kg / min) is distributed across several blood
compartments according to a per-compartment **fractional oxygen use** `fvo2`. CO₂ production follows
from the **respiratory quotient** `resp_q` (CO₂ produced / O₂ consumed). Temperature dependence is
applied through a Q10 factor (`vo2_temp_factor`) owned by [`Thermoregulation`](./Thermoregulation.md).

```
vo2 (ml/kg/min) ──split by fvo2──► per-compartment O₂ draw ──×resp_q──► per-compartment CO₂ release
```

## Properties

### Configuration (independent)

| Property | Unit | Description |
|---|---|---|
| `met_active` | bool | Master on/off switch; when false `calc_model` returns immediately |
| `vo2` | ml/kg/min | Whole-body oxygen consumption |
| `vo2_factor` | unitless | External multiplier on VO₂ (set by other models / interventions); `1.0` = no effect |
| `vo2_temp_factor` | unitless | Q10 temperature multiplier on VO₂, written by [`Thermoregulation`](./Thermoregulation.md); `1.0` at 37 °C / when that model is absent or disabled |
| `resp_q` | unitless | Respiratory quotient (CO₂ produced / O₂ consumed), typically ~0.8 |
| `metabolic_active_models` | object | `{ compartmentName: fvo2 }` — where O₂ is consumed and CO₂ produced; `fvo2` are fractions of the whole-body VO₂ and should sum to ≈ 1.0 |

### Computed / internal

Metabolism publishes no dependent read-out properties; its only outputs are the mutations it writes
to each target compartment's `to2` and `tco2`. The per-step O₂ draw `vo2_step` is a local variable
recomputed each step (not stored on the instance).

## Q10 temperature dependence

`vo2_temp_factor` is a **persistent channel written by `Thermoregulation`** (it is not reset each
step like a non-persistent factor). It encodes the Q10 rule — metabolic rate rises/falls with body
temperature — and multiplies into `vo2_step` alongside `vo2_factor`. It defaults to `1.0`, which is
its value at 37 °C and whenever the `Thermoregulation` model is absent or disabled, so a scenario
without thermoregulation is unaffected.

## Step calculation (`calc_model`)

Runs every model step when `met_active` is true.

1. **Whole-body O₂ use for this step**, converted ml → mmol and per-minute → per-step:

   ```
   vo2_step = (0.039 · vo2 · vo2_factor · vo2_temp_factor · weight) / 60 · Δt        [mmol]
   ```

   - `0.039` mmol/ml is the O₂ molar density at 37 °C, 1 atm (≈ 1 / 25.4 L·mol⁻¹).
   - `weight` is the engine body weight (kg); `Δt` (`this._t`) is the model step size.

2. **For each entry in `metabolic_active_models` (`{ compartment: fvo2 }`):**
   - Resolve the compartment. If it is a `MicroVascularUnit`, metabolism is applied to its capillary
     sub-compartment `<name>_CAP` instead (tissue gas exchange happens in the capillary).
   - Skip silently (via `continue`) if the compartment is missing or its volume is ≤ 0, so the
     remaining compartments are still processed.
   - O₂ removed and CO₂ added this step (distributed by `fvo2`):

     ```
     dto2  = vo2_step · fvo2
     dtco2 = vo2_step · fvo2 · resp_q
     to2  := max(0, (to2·vol − dto2) / vol)
     tco2 :=        (tco2·vol + dtco2) / vol
     ```

     A fixed amount of O₂/CO₂ is exchanged with the compartment's blood volume; the new concentration
     follows from the compartment volume. `to2` is floored at 0 so a compartment cannot go O₂-negative.

`set_metabolic_active_model(site, new_fvo2)` adds or updates one site's fraction at runtime.

## Notes & caveats

- **`fvo2` should sum to ~1.0.** If the configured fractions sum to more (or less) than 1, the
  effective whole-body VO₂ is correspondingly higher (or lower) than the `vo2` setting — a definition
  concern, not enforced by the model.
- **O₂ floor breaks strict conservation.** When `to2` would go negative it is clamped to 0, but the
  matching CO₂ is still produced in full. At physiological gradients this never triggers; under
  extreme O₂ debt it would slightly over-produce CO₂. Anaerobic metabolism is not modelled here — see
  [`Lactate`](./Lactate.md), which captures the same O₂ debt as lactate production.
- **Empty / missing compartments are skipped** (volume ≤ 0 or an unresolved name) so they neither
  divide by zero nor halt processing of the remaining compartments.

## Example definition (JSON)

From `term_neonate.json`:

```json
{
  "name": "Metabolism",
  "description": "Metabolism model",
  "is_enabled": true,
  "model_type": "Metabolism",
  "components": {},
  "met_active": true,
  "vo2": 8.1,
  "vo2_factor": 1,
  "vo2_temp_factor": 1.0,
  "resp_q": 0.8,
  "metabolic_active_models": {
    "RLB": 0.15,
    "INT_CAP": 0.15,
    "LS_CAP": 0.1,
    "KID_CAP": 0.1,
    "RUB": 0.1,
    "AA": 0.005,
    "AD": 0.01,
    "BR_CAP": 0.453
  }
}
```

Here the whole-body VO₂ of 8.1 ml/kg/min is spread over the brain capillary `BR_CAP` (0.453, the
largest sink), lower/upper body (`RLB`/`RUB`), gut/liver/kidney capillaries (`INT_CAP`/`LS_CAP`/
`KID_CAP`), and small fractions on the aortic compartments `AA`/`AD`. (The adult `adult_female.json`
scenario uses `vo2: 3.5` with a slightly different split.)

## Usage in the model

- One Metabolism instance per scenario; it is the sole driver of resting tissue O₂ extraction and CO₂
  generation, and thus of the venous desaturation that gas exchange must reverse.
- [`Lactate`](./Lactate.md) reuses Metabolism's `metabolic_active_models` map and `vo2`/`vo2_factor`/
  `vo2_temp_factor` to compute hypoxia-driven lactate, and must be inserted in the scenario `models`
  map immediately after Metabolism.
- [`Thermoregulation`](./Thermoregulation.md) modulates consumption by writing `vo2_temp_factor`.
- The myocardium has its own dedicated balance, [`Mob`](./Mob.md); the heart is therefore not listed
  in `metabolic_active_models`.

````

### FILE: explain-engine/docs/Mob.md

````markdown
# Mob — Myocardial Oxygen Balance

`Mob` models the **oxygen economy of the heart muscle**: how much O₂ the myocardium consumes, how
that O₂ is drawn from the coronary blood pool, and how myocardial **hypoxia** feeds back onto cardiac
function (rate, contractility, autonomic drive). It is the cardiac analogue of
[`Metabolism`](./Metabolism.md) — but where Metabolism is a passive tissue sink, `Mob` also closes a
regulatory loop with the `Heart`.

## Inheritance

```
BaseModelClass
  └── Mob   (myocardial O₂ consumption + coronary draw + hypoxia feedback)
```

Mob extends `BaseModelClass` directly. It **owns the coronary sub-network** (`COR`, `AA_COR`,
`COR_RAIVCI`, `COR_RASVC`) declared under its `components` block; the base `init_model` instantiates
those into `model.models` so they participate in the global step loop.

## What it models

Myocardial VO₂ as the sum of a basal term and a stroke-work term (both natively in mmol O₂ per gram
of heart tissue), the per-step consumption of that O₂ from the coronary blood pool with CO₂ added
back via the respiratory quotient, and three first-order-smoothed hypoxia feedback channels onto the
Heart (rate, contractility, autonomic activity).

## Properties

### Configuration (independent)

| Property | Unit | Description |
|---|---|---|
| `mob_active` | bool | Master on/off; `calc_model` returns immediately when false |
| `to2_ref` | mmol/L | Upper edge of the coronary-O₂ hypoxia window (no effect at/above) |
| `to2_min` | mmol/L | Lower edge of the hypoxia window (floor of activation) |
| `resp_q` | unitless | Respiratory quotient (CO₂ produced / O₂ consumed), default `0.1` |
| `bm_vo2_per_g` | mmol/(g·s) | Basal myocardial O₂ cost per gram of myocardium |
| `sw_vo2_per_g` | mmol/(g·mmHg·mL) | Stroke-work O₂ cost per gram per unit P-V loop area |
| `hw_intercept`, `hw_slope` | g, g/g | Heart-mass-from-body-weight regression: `hw = hw_intercept + hw_slope · weight_kg · 1000` |
| `hr_factor_min/max`, `hr_tc` | unitless, s | Heart-rate hypoxia channel bounds + time constant |
| `cont_factor_min/max`, `cont_tc` | unitless, s | Contractility hypoxia channel bounds + time constant |
| `ans_factor_min/max`, `ans_tc` | unitless, s | Autonomic hypoxia channel bounds + time constant |

### Computed / read-out (dependent)

| Property | Unit | Description |
|---|---|---|
| `hw` | g | Heart weight derived from body weight |
| `bm_vo2` | mmol/s | Basal myocardial O₂ consumption rate |
| `sw_vo2` | mmol/s | Stroke-work O₂ consumption rate |
| `mob_vo2` | mmol/s | Total myocardial O₂ consumption (`bm_vo2 + sw_vo2`) |
| `mvo2_step` | mmol | O₂ consumed this step (`mob_vo2 · Δt`) |
| `stroke_work_lv` / `stroke_work_rv` / `stroke_work_total` | mmHg·mL | Per-beat P-V loop area (left / right / sum) |
| `hr_factor` / `cont_factor` / `ans_activity_factor` | unitless | Current values of the three hypoxia channels (1.0 = no effect) |
| `mob` | — | Rough instantaneous O₂-balance reporter (not dimensionally meaningful — see caveats) |

## Oxygen consumption

Two physiologically explicit terms, both in **mmol O₂ / s**, scaled by heart weight `hw`:

```
hw      = hw_intercept + hw_slope · weight_kg · 1000           [g]   (heart mass from body weight)
bm_vo2  = bm_vo2_per_g · hw                                    [mmol/s]   basal metabolism
sw_vo2  = sw_vo2_per_g · hw · stroke_work_total / cycle_time   [mmol/s]   contractile (stroke) work
mob_vo2 = bm_vo2 + sw_vo2
```

### Stroke work (`calc_sw_vo2`)

**Stroke work** is the area of the ventricular pressure–volume loop, accumulated by trapezoidal `P·dV`
integration each step and split by flow direction:

- filling (dV > 0) accumulates into `_pv_area_*_inc`
- ejection (dV < 0) accumulates into `_pv_area_*_dec`
- at the rising edge of `Heart.cardiac_cycle_running` (start of a new cycle):
  `stroke_work = _pv_area_dec − _pv_area_inc` (the enclosed loop area), the per-beat O₂ cost
  `_sw_vo2_per_beat = sw_vo2_per_g · hw · stroke_work_total` is computed, and the accumulators reset.

The per-beat stroke-work cost is then amortized over the current `cardiac_cycle_time` to give the
`sw_vo2` rate.

## Coronary pool update

Per step, `mvo2_step = mob_vo2 · Δt` is drawn from the coronary blood pool `COR`, with CO₂ added back
via the respiratory quotient `resp_q`:

```
COR.to2  := (to2·vol − mvo2_step) / vol
COR.tco2 := (tco2·vol + mvo2_step·resp_q) / vol
```

The update is applied only when it keeps `to2 ≥ 0` (see caveats).

## Hypoxia feedback to the Heart (`calc_hypoxia_effects`)

Coronary O₂ (`COR.to2`) drives a one-sided `activation_function`: at/above `to2_ref` there is no
effect; below it the activation goes negative, reaching its floor at `to2_min`. The per-channel gain
is rebuilt each step (`(factor_max − factor_min) / (to2_ref − to2_min)`) so live edits to the
bounds take effect. Three independent channels each low-pass the activation with their own time
constant (`hr_tc`, `cont_tc`, `ans_tc`) and map it onto a factor in `[*_min, *_max]`:

| Channel | Computed factor | Written to | Effect |
|---|---|---|---|
| Heart rate | `hr_factor` | `Heart.hr_mob_factor` | lowers heart rate (bradycardia) |
| Contractility | `cont_factor` | each chamber's `el_max_mob_factor` (LV, RV, LA, and RAIVCI/RASVC if present) | lowers `el_max` (negative inotropy) |
| Autonomic | `ans_activity_factor` | `Heart.ans_activity_factor` | scales the sympathetic drive the Heart propagates to the chambers |

At normal coronary O₂ all three factors are 1.0 (no effect); under severe coronary hypoxia each drives
toward its `*_min` (default 0.01), i.e. profound suppression of rate, contractility and autonomic
responsiveness — the model of an ischemic, failing myocardium.

### How the channels reach the physics

- **`hr_mob_factor`** is read in `Heart.calc_model` (heart-rate sum).
- **`el_max_mob_factor`** is read in `HeartChamber.calc_elastances` as an additive factor on `el_max`
  (alongside `el_max_factor`, `el_max_factor_ps`, …).
- **`ans_activity_factor`** is read in `Heart.calc_varying_elastance`: the chambers receive
  `ans_activity · ans_activity_factor` instead of `ans_activity`, so it scales the sympathetic
  inotropy/lusitropy term in `HeartChamber.calc_elastances`.

## Notes & caveats

- **Contractility and autonomic channels compound.** Because the autonomic channel also acts on
  contractility (it scales `ans_activity`, which drives `el_max`/`el_min`), hypoxia suppresses
  contractility through **two** channels; the combined strength should be validated/tuned (via
  `cont_factor_min` and `ans_factor_min`) against expected behaviour in the host app.
- **O₂-debt handling freezes the pool.** When a step's consumption would drive `COR.to2` negative, the
  whole coronary update is skipped (O₂ not floored to 0, no CO₂ added), so `COR.to2` cannot fall below
  one step's consumption. Under extreme ischemia the hypoxia signal therefore plateaus rather than
  reaching `to2_min`.
- **`mob` is a rough reporter only.** The published `mob` value mixes a rate balance (mmol/s) with a
  concentration (`to2_cor`, mmol/L) and is not dimensionally meaningful; do not use it as a true
  balance.
- **Negative stroke work is not guarded.** If the filling-phase P·dV area exceeds the ejection-phase
  area (`stroke_work_total < 0`), `sw_vo2` and hence `mob_vo2` can go negative, which would *add* O₂ to
  the coronary pool. This does not occur for a normally ejecting ventricle.
- **Model references are not null-guarded.** `AA`, `AA_COR`, `COR`, `Heart`, `LV`, `RV` and the
  Heart's `_lv`/`_rv`/`_la` are dereferenced directly; a configuration lacking any of them throws.

## Example definition (JSON)

From `term_neonate.json` (coronary sub-components abbreviated):

```json
{
  "name": "Mob",
  "description": "myocardial oxygen balance v2 (basal + stroke-work, mmol O2/g)",
  "is_enabled": true,
  "model_type": "Mob",
  "components": {
    "COR":        { "model_type": "BloodTimeVaryingElastance", "u_vol": 0.00028, "el_min": 30000, "el_max": 90000, "...": "..." },
    "AA_COR":     { "model_type": "Resistor", "comp_from": "AA",  "comp_to": "COR", "r_for": 75000, "...": "..." },
    "COR_RAIVCI": { "model_type": "Resistor", "comp_from": "COR", "comp_to": "RAIVCI", "...": "..." },
    "COR_RASVC":  { "model_type": "Resistor", "comp_from": "COR", "comp_to": "RASVC",  "...": "..." }
  },
  "mob_active": true,
  "to2_min": 0.0002,
  "to2_ref": 0.2,
  "resp_q": 0.1,
  "bm_vo2_per_g": 3.7e-5,
  "sw_vo2_per_g": 2.0e-7,
  "hw_intercept": 7.799,
  "hw_slope": 0.004296,
  "hr_factor_max": 1, "hr_factor_min": 0.01, "hr_tc": 5,
  "cont_factor_max": 1, "cont_factor_min": 0.01, "cont_tc": 5,
  "ans_factor_max": 1, "ans_factor_min": 0.01, "ans_tc": 5
}
```

## Usage in the model

- One Mob instance per scenario carrying a heart; it is the only consumer of coronary-pool O₂ and the
  sole source of myocardial hypoxia feedback.
- The coronary network it owns (`COR` + connecting resistors) is *not* listed in
  [`Metabolism`](./Metabolism.md)'s `metabolic_active_models` — the heart's O₂ economy is handled
  exclusively here.
- Its hypoxia channels reach the `Heart`/`HeartChamber` physics through `hr_mob_factor`,
  `el_max_mob_factor` and `ans_activity_factor` (see above).

````

### FILE: explain-engine/docs/ModelScaler.md

````markdown
# ModelScaler

`ModelScaler` (`explain/helpers/ModelScaler.js`) is **engine infrastructure**, not a physiological model. It provides granular, factor-based scaling of model parameters by subsystem — blood, heart, lung, airways, and the thorax/pericardium containers — plus a single-call allometric weight scaler. A factor of `1.0` means no change, `0.5` halves the value, `2.0` doubles it. Each scaling group targets an explicit, predefined list of component names (read from a config object) rather than scanning every model by type, which keeps scaling predictable.

It is instantiated once per build in `ModelEngine.build()`:

```js
model["ModelScaler"] = new ModelScaler(model, model.scaler_config);
```

and driven from the public API via `scaleModel(group, factor)` (main thread) → `scale_model` message → the big `switch` in `ModelEngine.scale_model`. See [ARCHITECTURE](./ARCHITECTURE.md) for the build flow and the worker message wire protocol.

## Role in the engine

`ModelScaler` is the engine's mechanism for adjusting a whole patient's size or subsystem characteristics in one call, without editing the scenario JSON or rebuilding. It is the only component that writes the **`*_factor_scaling_ps` scaling layer** (the third tier of the factor/`_eff` pattern documented in [ARCHITECTURE](./ARCHITECTURE.md)) — it never touches the transient `*_factor` or the user/scenario `*_factor_ps` layers, so its scaling composes with interventions and live tuning instead of clobbering them. (Note: volume scaling and `add_volume` are the exception — they mutate raw `vol`/`u_vol` directly; see below.)

It is constructed with a reference to the whole engine `model` object and a `config`. All its group methods resolve component names against `this._model.models[name]` and silently skip names that are absent or lack the targeted property, so a config can list components that not every scenario contains.

## Key state / configuration it reads

- **`scaler_config`** — passed in as the constructor's second argument (defaults to `{}` in the engine's initial state, populated from the scenario's `scaler_config`). It is a nested map of group → property-role → list of component names, e.g. `config.blood.volume`, `config.blood.el_base`, `config.blood.resistance`, `config.blood_pulmonary.el_base`, `config.blood_systemic.resistance`, `config.airway.resistance_upper`, `config.left_lung.u_vol`, `config.heart.el_min`/`el_max`/`resistance`/`volume`, `config.heart_left`/`heart_right`, `config.thorax`, `config.pericardium`. Each group method reads the specific list it needs from this object.
- **`this._prev`** — an internal table of the last factor applied per group (`blood_vol`, `heart_el_min`, etc., all seeded to `1.0`). Volume scaling uses it to compute a **delta** (`factor / prev`) so repeated absolute factors are applied multiplicatively against the raw volume rather than re-multiplying from the original. `incorporate()` and `reset()` return these entries toward `1.0`.
- **`model._baseline_weight`** — read by `scale_to_weight`; frozen at build time. `reset` (in the engine) restores `model.weight = model._baseline_weight`.

## Key methods / exports

`ModelScaler` is a default-exported class. Its public surface is a large family of `scale_*` methods, each scaling one role on one subsystem, plus a few utilities. `scaleModel(group, factor)` does not call these directly — `ModelEngine.scale_model(payload)` switches on `payload.group` and dispatches to the matching method with `payload.factor`.

**Volume scaling** (mutates raw `vol` and `u_vol` by the computed delta):
`scale_blood_volume`, `scale_heart_volume`, `scale_lung_volume`, `scale_thorax_volume`, `scale_pericardium_volume`.

**Elastance / resistance / unstressed-volume scaling** (write the `*_factor_scaling_ps` layer):

| Subsystem | Methods |
|---|---|
| Blood (global) | `scale_blood_elastances`, `scale_blood_resistances` |
| Pulmonary | `scale_pulmonary_elastances`, `scale_pulmonary_resistances`, `scale_pulmonary_u_vol` |
| Systemic | `scale_systemic_elastances`, `scale_systemic_resistances`, `scale_systemic_u_vol` |
| Airway | `scale_airway_elastances`, `scale_airway_u_vol`, `scale_airway_upper_resistances`, `scale_airway_lower_resistances` |
| Left lung | `scale_left_lung_elastances`, `scale_left_lung_resistances`, `scale_left_lung_u_vol` |
| Right lung | `scale_right_lung_elastances`, `scale_right_lung_resistances`, `scale_right_lung_u_vol` |
| Heart (both) | `scale_heart_el_min`, `scale_heart_el_max`, `scale_heart_resistances` |
| Left heart | `scale_left_heart_el_min`, `scale_left_heart_el_max`, `scale_left_heart_u_vol` |
| Right heart | `scale_right_heart_el_min`, `scale_right_heart_el_max`, `scale_right_heart_u_vol` |
| Containers | `scale_thorax_elastances`, `scale_pericardium_elastances` |

The properties written are `el_base_factor_scaling_ps`, `r_factor_scaling_ps`, `u_vol_factor_scaling_ps`, `el_min_factor_scaling_ps`, and `el_max_factor_scaling_ps`. (The `*_u_vol` heart methods write `u_vol_factor_scaling_ps` onto the components listed in the heart's `el_min` group.)

**Utility / lifecycle:**

- `scale_to_weight(new_weight)` — allometric scaling from a single new weight. Computes `vol_factor = new_weight / baseline` and `inv_factor = baseline / new_weight`, scales the five volume groups linearly with weight, and sets `this._model.weight = new_weight`. The elastance/resistance/unstressed-volume inverse-scaling calls are present but currently commented out, so by default only volumes (and `model.weight`) change. No-ops if `_baseline_weight` or `new_weight` is missing/≤0. Reached via the `weight_scale` group.
- `add_volume(vol_liters)` — adds liters directly to the `IVCI` compartment's `vol` (a bolus/bleed lever). Reached via the `add_volume` group.
- `incorporate()` — **bakes** every accumulated `*_factor_scaling_ps` (and the resistance `r_for`/`r_back`) into the corresponding base property, then resets that factor to `1.0` and clears `this._prev`. Use to make current scaling permanent. Reached via the `incorporate` group.
- `reset()` — calls every `scale_*` method with `1.0`, returning all scaling factors and volumes to baseline. The engine's `reset` case additionally restores `model.weight = model._baseline_weight`.

The engine's `weight` group is handled inline (`model.weight = factor`) and does not call a `ModelScaler` method.

## The scaling layer

Core physics parameters are never used raw; each has three multiplier tiers that combine additively into an `*_eff` value (see [ARCHITECTURE](./ARCHITECTURE.md) for the full factor/`_eff` derivation):

- `<p>_factor` — transient, reset to `1.0` every step.
- `<p>_factor_ps` — persistent user/scenario adjustments.
- `<p>_factor_scaling_ps` — persistent **scaling** layer.

`ModelScaler` writes **only** the `*_factor_scaling_ps` tier (via its `_apply(names, prop, factor)` helper, which sets the property absolutely on each named component). It never reads or writes `_factor` or `_factor_ps`. That separation is deliberate: allometric/size scaling stays in its own lane so a loaded patient's baked scaling and any live user interventions or `tune` levers (which use `*_factor_ps`) remain independent and composable. The one place this layering is left behind is volume: `_scale_vol` and `add_volume` change raw `vol`/`u_vol` (and `incorporate`/`_bake_resistance` fold scaling into the raw base params), because those represent actual fluid quantities rather than a multiplier.

Because `_apply` **sets** the scaling layer to an absolute value, calling a scaling group overwrites whatever scaling was already there. This is why the live `tune_model` path (see [Calibrator](./Calibrator.md)) deliberately avoids `ModelScaler` groups and uses `*_factor_ps` levers instead — so it composes with a preterm patient's baked SVR/PVR scaling rather than clobbering it.

## Notes / caveats

- **Volume groups bypass the scaling layer.** `scale_*_volume` and `add_volume` mutate raw `vol`/`u_vol`; only the elastance/resistance/u_vol-factor groups touch `*_factor_scaling_ps`. Volume groups also use the `_prev` delta so repeated absolute factors behave multiplicatively.
- **Names are config-driven and skipped if missing.** A group only affects components listed in `scaler_config`; absent components or undefined target properties are silently ignored. An empty `scaler_config` (the engine default) means most groups are no-ops until a scenario supplies lists.
- **`scale_to_weight` is volume-only by default.** Its elastance/resistance inverse-scaling lines are commented out in the source; do not assume pressures are held constant across body sizes without re-enabling them.
- **`incorporate()` is destructive and irreversible** — once factors are baked into base params, `reset()` cannot recover the pre-bake values (it only zeroes the now-`1.0` factors).
- **`_prev` is internal bookkeeping**, not persisted to scenario state; a rebuild creates a fresh `ModelScaler` with all `_prev` at `1.0`.

````

### FILE: explain-engine/docs/Monitor.md

````markdown
# Monitor

The `Monitor` device model is a **read-only patient monitor**. It does not change the physiology — it
samples other models each step and publishes bedside read-outs. It is a pure observer: nothing in the
engine reads from it, and it never writes to the models it samples, so it can be added or removed
without affecting the simulation. The `DataCollector` relays its read-outs (via the normal watchlist)
to the user.

The model is deliberately minimal. It computes a handful of bedside values itself — **heart rate**,
**respiratory rate**, **end-tidal CO₂**, **temperature** and the **O₂ saturations** (pre-/post-ductal
and venous) — and exposes everything else through three uniform, **JSON-configurable** read-out systems
(`flow_targets`, `minmax_targets`, `signal_targets`) plus a few derived metrics.

> **Arterial blood pressure is not a built-in field.** There is no `abp_syst`/`abp_diast`/`abp_mean`
> property on this model. To monitor a pressure waveform's per-beat extremes and mean, add the
> compartment (e.g. `AD` for post-ductal ABP) to `minmax_targets`; the values then publish as the flat
> keys `Monitor.minmax.<name>_pres_min` / `_pres_max` / `_pres_mean`.

## Built-in read-outs

| Output | How |
|---|---|
| `heart_rate` | rolling average of the beat-to-beat rate over the last **`hr_avg_beats`** beats (bpm) |
| `resp_rate` | rolling average of the breath-to-breath rate over the last **`rr_avg_time`** seconds (breaths/min) |
| `etco2` | end-tidal CO₂; mirrored from `Ventilator.etco2` while the ventilator is enabled, otherwise derived from the spontaneous breath (see below) |
| `temp` | blood temperature (°C), mirrored each step from `AA.temp` (last value kept if AA is absent) |
| `sao2_pre`, `sao2_post` | pre-/post-ductal arterial O₂ saturation, from `AA.so2` / `AD.so2` |
| `svo2` | venous O₂ saturation, from the right atrium / IVC (`RAIVCI.so2`) |

**Heart rate** — on each ventricular beat (`Heart.ncc_ventricular === 1`), the beat-to-beat rate is
`60 / interval` (interval = time since the previous beat). A running window of the last `hr_avg_beats`
rates is kept (with a running sum) and averaged into `heart_rate`, so it updates every beat.

**Respiratory rate** — `calc_resp_rate()` detects a breath when an **active** breathing source reaches
the start of inspiration (`ncc_insp === 1`): the spontaneous `Breathing` model (when
`breathing_enabled`) or the `Ventilator` (when `is_enabled`). It keeps a rolling window of
breath-to-breath intervals spanning ~`rr_avg_time` seconds and reports `breaths / window-time × 60`,
updated every breath. Both references are optional (`?? null`); a missing source is simply skipped.

**End-tidal CO₂** — while the `Ventilator` is enabled, `etco2` is mirrored straight from
`Ventilator.etco2`. Otherwise it is derived from the spontaneous breath: `calc_resp_rate` tracks the
running peak airway pCO₂ over each breath on the airway gas compartment named by `etco2_source`
(default `"DS"`, resolved to `_ds`), and latches that end-expiratory peak as `etco2` at the onset of the
next spontaneous breath (resetting the per-breath peak). If neither source is present the last value is
kept.

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
| `<name>_pres_mean` | mmHg | **true time-averaged mean** over the beat (`Σpres / n`), not the arterial `(2·min+max)/3` estimate — that approximation badly underestimates atrial/venous means (CVP) whose a/c/v waves dip well below diastole, so an integral mean is used and is correct for all waveforms |
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
| `do2_br` | `flows.brain_flow · AA.to2 · 22.4` | `brain_flow` |
| `do2_lb` | `flows.kid_flow · 4 · AD.to2 · 22.4` | `kid_flow` |

## Configuration

`hr_avg_beats` (12), `flow_avg_beats` (1), `rr_avg_time` (20 s), `sat_avg_time` (5 s), plus the three
`*_targets` arrays. Model references are resolved by name: `Heart` (beats), `Breathing` + `Ventilator`
(breaths). The `flow_targets`/`minmax_targets`/`signal_targets` entries name their own models.

## Notes & caveats

- **Pure observer.** The Monitor never writes to the models it samples; no model depends on it. The
  `DataCollector` reads its outputs through the watchlist like any other model.
- **Breath sourcing.** `resp_rate` counts breaths from the spontaneous `Breathing` source *and* the
  `Ventilator` (each gated by its enable flag). In assisted ventilation, where both are active, both
  breath types are counted, which can overcount the rate; in purely spontaneous or purely ventilated
  states it is correct.
- **Start-up transient.** The first heart-rate and respiratory-rate windows include the time before
  the first beat/breath, so the very first read-out is slightly off; it settles after one window.
- **`do2_br` / `do2_lb` need `AA` / `AD`.** The oxygen-delivery metrics read the aortic O₂ content
  (`AA.to2` / `AD.to2`); both references are resolved with a `?? null` fallback, so they hold their
  last value if those compartments are absent.

````

### FILE: explain-engine/docs/Pda-velocity.md

````markdown
# Pda — Velocity Outputs

> **Update (quadratic stenosis element).** The trade-off this document analyses has since been
> resolved at the source. The duct resistance is now the standard quadratic stenosis element
> `ΔP = R·Q + B·Q²`, where `R·Q` is the viscous (Poiseuille) loss and `B·Q²` is the Bernoulli orifice
> loss with `B = ρ/(2·A_eff²)`. Because `B·Q²` *is* the modified-Bernoulli relation, the single output
> `velocity_doppler = sign(Q)·√(B·Q²/4)` is now identical to continuity `Q/A_eff` through the effective
> orifice — the two formulas that used to disagree are the same number. The element separates viscous
> loss (which does not accelerate fluid) from kinetic energy (the jet), so `velocity_doppler` is honest
> across the whole closure trajectory, and the empirical jet-correction outputs (`velocity_*_jet`) and
> `jet_exponent` were removed. The continuity bulk means `velocity_ao`/`velocity_pa` remain as anatomic
> reference values. The historical analysis below is retained for background.
>
> One caveat the new element makes explicit: a restrictive jet only forms in an **orifice-like (short)
> throat**. A long, narrow duct is viscous-limited — low flow *and* low velocity even at a large
> gradient — which is correct (the old `√(full gradient/4)` over-reported there). See `Pda.md` usage
> notes; restrictive scenarios set a short `length` (~1–2 mm).
>
> The duct is now a **single resistor** `AAR → PA` (the intermediate `DA` blood-capacitance, shown in
> the figures below, was numerically vestigial and was removed). The "noisy Bernoulli" discussion
> below — which was rooted in the `DA` node's pressure transients feeding the velocity calc — is moot:
> `velocity_doppler` is now derived from the resistive flow (`sign(Q)·√(B·Q²/4)`), not from any node
> pressure. The historical analysis is retained only for background.

The `Pda` model exposes several velocity properties at the pulmonary end of the duct. Two of them are computed by fundamentally different physics and behave in complementary ways: a modified-Bernoulli formulation, and a continuity (flow ÷ area) formulation. This document explains *why* each method behaves the way it does, when each one is right, and where they disagree.

## The properties

`Pda.calc_model` (in `src/explain/component_models/Pda.js`, lines 329–332) sets four velocity outputs:

- **`velocity_doppler`** — the raw modified-Bernoulli jet velocity at the pulmonary end: `v_jet_pa = sign(ΔP) · √(|ΔP|/4)`.
- **`velocity_pa`** — that same jet velocity, scaled by continuity from the vena-contracta cross-section to the PA-end area: `v_jet_pa · (A_min / A_pa)`.
- **`velocity_ao`** — the analogous quantity at the aortic end of the duct.
- **`velocity_pa_area`** — the bulk mean velocity from the resistive flow: `Q_DA→PA / A_pa`.

In what follows, "the Bernoulli path" means `velocity_pa` / `velocity_doppler`, and "the continuity path" means `velocity_pa_area`.

## Observed trade-off

| | Bernoulli path | Continuity path |
|---|---|---|
| Peak velocity rises as the duct constricts | ✓ matches clinical Doppler | ✗ peak *falls* — unphysiological |
| Waveform shape resembles a real Doppler envelope | ✗ jagged / noisy | ✓ smooth |
| Open-duct peak velocity is clinically realistic | ✗ tends to overshoot | ✓ ~1 m/s as expected |

The rest of the doc explains each row.

## The two formulas

### Modified Bernoulli — `v = √(ΔP / 4)` (m/s, ΔP in mmHg)

This is the standard simplification of `½ρv² = ΔP` for blood (ρ ≈ 1060 kg/m³). Converting ΔP from mmHg to Pa and solving for v in m/s gives `v ≈ 0.5015·√(ΔP_mmHg)`, which is conventionally reported as `v² = ΔP/4`.

The formula assumes:
- The fluid is inviscid (no viscous dissipation between the upstream and downstream pressure-measurement sites).
- The proximal velocity is small enough to ignore.
- All of the trans-ductal pressure energy is converted to kinetic energy at the vena contracta.

In a *restrictive* lesion these assumptions are approximately true and the equation correctly reports the **jet peak velocity** at the vena contracta. In a *non-restrictive* segment the inviscid assumption fails (viscous drag is significant) and the equation over-estimates v.

### Continuity — `v = Q / A`

The bulk mean velocity at the chosen cross-section. In `Pda.js` it is evaluated at `A_pa`, the anatomic area at the PA end of the duct. `Q` is the resistive flow returned by the `DA_PA` `Resistor` instance (`src/explain/base_models/Resistor.js`, lines 204–254). The Resistor solves `Q = (p1 − p2) / R` each step — pure resistive, no inertance term.

This gives the average velocity over the anatomic lumen. When the flow profile is smooth and fills the lumen (low Reynolds number, no jet), the bulk mean is close to the Doppler peak. When a jet forms inside a much-narrower vena contracta, the bulk mean across the anatomic lumen dramatically underestimates the jet peak.

## Why the Bernoulli peak RISES as the duct constricts

`Pda.calc_conical_resistance` (lines 364–394) is a Hagen–Poiseuille integration over a linearly tapered cone:

```
R = (8 · μ · L / 3π) · (r1² + r1·r2 + r2²) / (r1³ · r2³)
```

So `R ∝ 1/r⁴` (to leading order). As the duct constricts, R rises rapidly and the duct becomes the dominant resistance between the aorta and the pulmonary artery. Increasingly, the *systemic-pulmonary pressure difference itself* (roughly 30–60 mmHg after transition) is dropped across the duct, so ΔP across the duct approaches that systemic-pulmonary difference.

`v = √(ΔP / 4)` with ΔP = 60 mmHg gives ~3.9 m/s — the textbook value for a restrictive PDA jet. As ΔP grows from a few mmHg (open) to tens of mmHg (constricted), v grows monotonically, matching clinical Doppler observations.

## Why the continuity peak FALLS as the duct constricts

Combine the network behavior:

- `Q ∝ ΔP / R`, and `R ∝ 1/d⁴`, so `Q ∝ ΔP · d⁴`.
- `A ∝ d²`.

Therefore `v = Q / A ∝ (ΔP · d⁴) / d² = ΔP · d²`. The `d²` factor dominates the (bounded) rise in ΔP, so `v → 0` as `d → 0`.

This is *not a bug*. The continuity formula reports the bulk mean velocity across the **anatomic** lumen. Real flow through a stenotic orifice does *not* fill the anatomic lumen smoothly — it forms a high-speed core jet through a vena contracta narrower than the anatomic opening, surrounded by separation/recirculation. The Doppler probe measures the **jet peak**, not the anatomic mean, so continuity-at-anatomic-area systematically underestimates the clinical Doppler value as the duct constricts.

## Why the continuity waveform looks like a clean Doppler envelope

`Q` comes from a Resistor whose only input each step is the instantaneous pressure difference between its two endpoints. Those endpoints are aortic-arch and pulmonary-artery node pressures filtered through the entire systemic and pulmonary circulation ODE — large reservoirs, slow compliances, smooth cardiac forcing. The resulting `Q` waveform inherits that smoothness: a clean systolic acceleration, a diastolic phase, no high-frequency content.

`velocity_pa_area = Q · 0.001 / A_pa` is just `Q` rescaled by a constant, so it inherits the smooth shape directly. That is why this output looks like a real Doppler envelope.

## Why the Bernoulli waveform looks noisier

The code at lines 319–322 uses **local** gradients across each half of the duct:

```js
const dp_ao = p_aa - p_da;
const dp_pa = p_da - p_pa;
v_jet_ao = Math.sign(dp_ao) * Math.sqrt(Math.abs(dp_ao) / 4.0);
v_jet_pa = Math.sign(dp_pa) * Math.sqrt(Math.abs(dp_pa) / 4.0);
```

`p_da` is the pressure at the DA capacitance node (`src/explain/base_models/Capacitance.js`, lines 168–180: pressure is the instantaneous elastic recoil on `vol − u_vol`). The DA node holds a small volume of blood and its pressure swings transiently within each cardiac cycle around the mean of `p_aa` and `p_pa`. Those swings inject into `dp_ao` and `dp_pa` with opposite signs and produce cycle-by-cycle artifacts in `v_jet_*`.

**Discrepancy worth flagging**: the comment block at lines 306–311 *claims* a single trans-ductal gradient `p_aa − p_pa` is used "to keep the sign of all three outputs consistent during flow reversal (PHT / bidirectional shunting); using the local p_da would let the DA capacitance's transient pressure swings flip the sign of one half independently of the other." That comment describes the *intent*, but the code uses local gradients. Either the code or the comment is stale — this is the most likely source of the "noisy Bernoulli" observation, and resolving it would meaningfully clean up the Bernoulli waveform.

## Why Bernoulli OVER-estimates at baseline

`v = √(ΔP/4)` assumes *all* of ΔP converts to kinetic energy at the orifice. In an open duct with low Reynolds number, a meaningful fraction of ΔP is instead dissipated viscously along the length of the duct — that fraction does not accelerate fluid. The Bernoulli formula over-states v by exactly that fraction. The equation only becomes accurate once viscous loss is small relative to jet kinetic energy, i.e., once the orifice is restrictive enough that flow detaches and forms a jet.

## Why continuity is realistic at baseline

Open PDA carries roughly 0.5–1.5 L/min through a 2–4 mm lumen, putting Reynolds number well below the turbulent threshold (~2300). Flow is laminar/transitional, the profile fills the lumen, and the bulk mean velocity is a good approximation of the Doppler envelope peak (≈ 0.5–1.5 m/s). This matches what clinicians see on echo for non-restrictive PDA.

## Doppler reality check

Echo Doppler reports the highest velocity in the sample volume — physically that is the vena contracta jet peak.

- **Non-restrictive PDA**: jet peak ≈ bulk mean. Continuity is right; Bernoulli over-shoots.
- **Restrictive PDA**: jet peak ≫ bulk mean. Bernoulli is right; continuity from anatomic area is wrong.

Neither single formula is correct across the whole closure trajectory.

## Summary

| Regime              | v = Q/A (continuity)         | v = √(ΔP/4) (Bernoulli)        |
|---------------------|------------------------------|--------------------------------|
| Open duct (low R)   | ✓ realistic peak & shape     | ✗ overestimates (viscous loss) |
| Restrictive duct    | ✗ underestimates (no jet)    | ✓ peak rises correctly         |
| Waveform shape      | ✓ smooth (network-filtered)  | ✗ noisy (p_da transients)      |

The user's empirical observations match the physics exactly: each formula is right in one regime and wrong in the other.

## Path forward (not implemented)

Two follow-up steps would resolve the trade-off without removing either existing output:

1. **Hybrid output `velocity_pa_combined`**. Blend Bernoulli and continuity via a sigmoid weight in `R_total / R_open_total` (the same driver already used for the elastance coupling at `Pda.js` lines 294–301, which mirrors the `BloodVessel` α-pattern at `src/explain/component_models/BloodVessel.js` lines 4–17 and 353–366). Below a ratio of ~5 the weight favors continuity (open-duct regime, smooth and realistic); above ~20 it favors Bernoulli (restrictive regime, jet peak rises); the transition is smooth between. Keeping the existing outputs preserves backward compatibility with old preset charts.

2. **Single trans-ductal gradient for Bernoulli**. Align the code at lines 319–322 with the comment block at lines 306–311 — drive both `v_jet_ao` and `v_jet_pa` from `p_aa − p_pa` rather than from the local gradients. This removes the spurious `p_da` transient artifacts and is independently worth doing even without (1).

## Cross-references

- Resistor flow equation: `src/explain/base_models/Resistor.js`, lines 204–254.
- Capacitance pressure equation: `src/explain/base_models/Capacitance.js`, lines 168–180.
- BloodVessel α-coupling (header + code): `src/explain/component_models/BloodVessel.js`, lines 4–17 and 353–366.
- Prior art (Shunts uses continuity only): `src/explain/component_models/Shunts.js`, lines 240–245.

````

### FILE: explain-engine/docs/Pda.md

````markdown
# Pda

A `Pda` (Patent Ductus Arteriosus) is a component model representing the ductus arteriosus — the fetal shunt between the aortic arch and the pulmonary artery. Unlike a typical `BloodVessel`, the `Pda` is a thin coordinator: it owns a single `Resistor` sub-model (`AAR_DA`, connecting `AAR` → `PA`) and drives its resistance from a set of geometric inputs (diameter, length, viscosity), implementing the **standard quadratic stenosis element** `ΔP = R·Q + B·Q²`.

See also: [Pda-velocity.md](./Pda-velocity.md) for the rationale behind the velocity outputs.

## Inheritance

```
BaseModelClass
  └── Pda    (coordinates the single resistor AAR_DA)
```

The `Pda` does not extend `Capacitance` or `BloodVessel` itself. It steps once per cycle and writes the derived resistance onto its resistor.

## What it models

The ductus arteriosus is a short conical vessel (~2–3 cm) connecting the pulmonary trunk to the descending aorta. In utero it is held open by PGE₂; after birth, rising PO₂ and falling PGE₂ trigger smooth-muscle constriction that closes it functionally within 12–24 hours, followed by fibrotic remodeling over 2–3 weeks.

The model represents the duct as a **linearly tapered cone**, wider at the aortic end and narrower at the pulmonary end. Closure scales both diameters together via `diameter_relative` from `1.0` (fully open) to `0.0` (closed). The whole duct is a **single resistor** carrying the quadratic stenosis element `ΔP = R·Q + B·Q²`:

- `R·Q` — the **viscous** (Hagen-Poiseuille) loss integrated over the full tapered cone (`res`).
- `B·Q²` — the **convective / Bernoulli orifice** loss at the narrowest (pulmonary) end, the vena contracta. `B = K_BERNOULLI / A_eff²` with `A_eff = discharge_coeff · A_pa`. This term *is* the modified-Bernoulli relation, so the jet velocity it produces is self-consistent with the flow and with continuity through the effective orifice.

```
AAR ──[AAR_DA: Resistor]── PA
         r_for/r_back = res + B·|Q|
         (quadratic stenosis element; r_k = 0)
```

There is **no intermediate compartment**: the duct was historically modeled as two resistors around a small `DA` blood-capacitance, but that capacitance was numerically vestigial (a 1000× change in its compliance moved shunt/velocity/gas by 0%, and it turned over ~2.5×/s so it neither delayed nor buffered transport), so the duct was collapsed to a single resistor between `AAR` and `PA`. Blood-gas composition propagates by the `Resistor`'s direct `volume_out`/`volume_in` mixing between the two compartments.

**Numerical scheme.** The quadratic term is applied via a **semi-implicit linearization**: each step `AAR_DA.r_for/r_back` is set to `res + B·|Q_prev|` (and `r_k = 0`), so the resistor solves `Q = ΔP / (res + B·|Q_prev|)`. At steady state this reproduces `ΔP = res·Q + B·Q²` exactly, but it is unconditionally stable. The engine's native explicit quadratic term (`Resistor.r_k`, evaluating `flow = (ΔP − r_k·Q_prev²)/r_for`) is **not** used here: for an open duct the viscous resistance (~10³–10⁴) is far below `2·√(B·ΔP)` (~2×10⁴), so the explicit form diverges.

## Calculation cycle (`calc_model`)

**Closed-duct fast path.** When `diameter_relative === 0` (the postnatal steady state) the cone math,
the Bernoulli √, and the continuity divisions all degenerate, so `calc_model` short-circuits: it
forces `no_flow = true` and `r_for/r_back = 1e8` on the resistor (`r_k = 0`, `B = 0`), zeroes the
velocities, and returns early. The full path below runs only while the duct is patent
(`diameter_relative > 0`).

Each open-duct step executes in this order:

1. **Viscosity** — pulled from the upstream `AAR` compartment (tracks hematocrit).
2. **Diameters** — `diameter_ao` and `diameter_pa` from the effective relative diameter `diameter_relative_eff = diameter_relative · diameter_drug_factor` (PGE1 patency) × their respective maxima, each capped at the anatomic max.
3. **Flow gating** — set `no_flow` when the pulmonary end is fully constricted (`diameter_pa === 0`).
4. **Viscous resistance** — `res = calc_conical_resistance(d_ao, d_pa, length, viscosity)` over the full cone.
5. **Bernoulli orifice term** — compute `B = K_BERNOULLI / A_eff²` from the pulmonary effective orifice area, then set `AAR_DA.r_for/r_back = res + B·|Q_prev|` (semi-implicit quadratic stenosis element).
6. **Velocities** — the honest Bernoulli jet (`velocity_doppler = sign(Q)·√(B·Q²/4)`) plus the anatomic continuity bulk means (`velocity_ao`, `velocity_pa`) for reference.

## Properties

### Geometry (independent)

| Property | Unit | Description |
|---|---|---|
| `diameter_ao_max` | mm | Maximum diameter at the aortic end (open duct) |
| `diameter_pa_max` | mm | Maximum diameter at the pulmonary end (open duct) |
| `diameter_relative` | 0..1 | Linear scale on both end diameters. 1 = fully open, 0 = closed |
| `length` | mm | Total length of the cone |

### Physics inputs (independent)

| Property | Unit | Description |
|---|---|---|
| `discharge_coeff` | 0.3..1 | Effective vena-contracta contraction `Cd` of the pulmonary orifice. The Bernoulli coefficient uses `A_eff = Cd · A_pa`, so `B ∝ 1/Cd²`. The single tuning knob for peak jet velocity (lower `Cd` → tighter jet → higher velocity). Default `0.8` |
| `diameter_drug_factor` | multiplier | Patency multiplier owned by the `Drugs` model (`1.0` = neutral). Prostaglandin E1 (alprostadil / PGE1) drives this above `1.0` to hold a constricting duct open in duct-dependent CHD; it multiplies `diameter_relative` (the product is capped at the anatomic max). **It does not reopen a fully-closed duct** — the `diameter_relative === 0` fast path stays keyed on the raw value (clinically the duct is maintained patent from birth on PGE1, never allowed to reach 0). Default `1.0` |

### Dependent (recomputed each step)

| Property | Unit | Description |
|---|---|---|
| `diameter_relative_eff` | 0..1 | Effective relative diameter after the drug factor (`diameter_relative · diameter_drug_factor`); the read-out that actually drives the geometry |
| `diameter_ao` | mm | Current diameter at aortic end (= `min(diameter_relative_eff · diameter_ao_max, diameter_ao_max)`) |
| `diameter_pa` | mm | Current diameter at pulmonary end (= `min(diameter_relative_eff · diameter_pa_max, diameter_pa_max)`) |
| `viscosity` | cP | Blood viscosity pulled from the upstream `AAR` compartment |
| `flow` | L/s | Shunt flow through the duct; +ve = L→R (aorta → pulmonary) |
| `flow_ao`, `flow_pa` | L/s | Aliases of `flow` (single resistor now; kept for probe/back-compat) |
| `res` | mmHg·s/L | Viscous resistance of the full cone (linear part, pushed to `AAR_DA.r_for/r_back`) |
| `bernoulli_b` | mmHg·s²/L² | Orifice Bernoulli coefficient `B = K_BERNOULLI / A_eff²` (quadratic part, folded into `AAR_DA.r_for/r_back` as `B·|Q_prev|`) |

### Velocity outputs (dependent)

| Property | Unit | Description |
|---|---|---|
| `velocity_doppler` | m/s | Jet peak from the Bernoulli (kinetic) term: `sign(Q)·√(|B·Q²|/4)`. Equals continuity `Q/A_eff` through the effective orifice, so it is honest across both open and restrictive regimes and reverses sign cleanly during bidirectional / PHT shunting |
| `velocity_ao` | m/s | Bulk mean velocity at the *anatomic* aortic end (continuity, `Q/A`) — for reference / open-duct flows |
| `velocity_pa` | m/s | Bulk mean velocity at the *anatomic* pulmonary end (continuity, `Q/A`) — for reference / open-duct flows |

`velocity_doppler` is now the single value to monitor. See [Pda-velocity.md](./Pda-velocity.md) for why the quadratic element makes one honest velocity possible (the old jet-correction outputs and `jet_exponent` were removed).

## Closure

The duct seals purely through its resistance: as `diameter_relative → 0`, the cone collapses and
`res → ∞` (Hagen-Poiseuille `~1/d⁴`), and at exactly `diameter_relative === 0` the closed-duct fast
path forces `no_flow = true` with `r_for/r_back = 1e8`. (The earlier model additionally stiffened a
`DA` capacitance via a BloodVessel-style `el = el_base · (R/R_open)^alpha` coupling; with the duct
collapsed to a single resistor and no intermediate compartment, that coupling — and the `el_base`/
`alpha` parameters — were removed.)

## Resistance formulas

The two functions below compute only the **viscous** (`R·Q`) part of the stenosis element. The
**Bernoulli** (`B·Q²`) part is computed inline in `calc_model` from the pulmonary effective orifice
area: `B = K_BERNOULLI / A_eff²`, `A_eff = discharge_coeff · π·(d_pa/2)²`, with `K_BERNOULLI = ρ/(2·133.322)·1e-6 ≈ 3.976e-6` (mmHg·s²/L²·m², ρ ≈ 1060 kg/m³) — the prefactor that makes `B·Q² ≈ 4·v²`, the textbook modified-Bernoulli form.

### Uniform cylinder — `calc_resistance(diameter, length, viscosity)`

Standard Hagen-Poiseuille:

```
R = (8 · μ · L) / (π · r⁴)        in Pa·s/m³
```

then converted to `mmHg·s/L`.

### Conical taper — `calc_conical_resistance(d1, d2, length, viscosity)`

Hagen-Poiseuille integrated over a linearly tapered cone:

```
R = (8 · μ · L) / (3 · π) · (r1² + r1·r2 + r2²) / (r1³ · r2³)    in Pa·s/m³
```

then converted to `mmHg·s/L`. Reduces to the uniform cylinder when `r1 = r2`.

Both functions return a large sentinel (`1e8`) when the geometry collapses (`d ≤ 0` or `L ≤ 0`).

## Sub-model wiring

The Pda references two models by name, cached in `init_model()`:

| Reference | Looks up | Type | Role |
|---|---|---|---|
| `_aar_da` | `AAR_DA` | `Resistor` | AAR → PA, the duct; gets `r_for/r_back = res + B·|Q_prev|` (`r_k = 0`) and `no_flow` |
| `_aar` | `AAR` | `BloodCapacitance` | upstream (aortic-arch) compartment, read-only viscosity source |

`AAR_DA` is declared in the Pda's `components` dictionary in the model definition JSON and instantiated
by `BaseModelClass.init_model()` before `Pda.init_model()` caches the reference. `AAR` is a top-level
circuit compartment (not owned by the Pda).

## Example definition (JSON)

```json
{
  "name": "Pda",
  "description": "ductus arteriosus model",
  "is_enabled": true,
  "model_type": "Pda",
  "components": {
    "AAR_DA": {
      "name": "AAR_DA",
      "description": "ductus arteriosus (aorta-pulmonary) resistor",
      "is_enabled": true,
      "model_type": "Resistor",
      "r_for": 100000000,
      "r_back": 100000000,
      "r_k": 0,
      "comp_from": "AAR",
      "comp_to": "PA",
      "no_flow": true,
      "no_back_flow": false
    }
  },
  "diameter_ao_max": 3.0,
  "diameter_pa_max": 2.0,
  "diameter_relative": 0,
  "length": 20,
  "discharge_coeff": 0.8
}
```

## Usage notes

- **Closure is symmetric in this model.** Real PDA closure proceeds from the pulmonary end first, but the current implementation scales both `diameter_ao` and `diameter_pa` by the same `diameter_relative`. Asymmetric closure would require independent scaling factors.
- **`velocity_doppler` is the value to monitor** — it is the honest jet peak across both open and restrictive regimes (it equals continuity `Q/A_eff` through the effective orifice). `velocity_pa`/`velocity_ao` remain as anatomic continuity bulk means for reference. Some older model definitions still watch `Pda.velocity_pa`; consider repointing the chart channel to `velocity_doppler`.
- **A restrictive jet requires an orifice-like (short) throat `length`.** Because the viscous term scales with `length` (Poiseuille over the cone) while the Bernoulli term does not, a long, narrow duct is viscous-limited and will *not* jet — flow and velocity both stay low even at a large trans-ductal gradient (this is physically correct, and is what makes the new element honest where the old `√(full gradient/4)` over-reported). To model a restrictive/closing PDA, set `length` to the throat length (~1–2 mm) and tune `discharge_coeff` (lower → tighter jet). The `preterm_28wk_restrictive_pda` scenario uses `length = 1.5`, `discharge_coeff = 0.5` (≈2.5 m/s continuous L→R, low pulsatility).
- **Velocity is gradient-limited.** Since `B·Q² = 4·v²` and `B·Q²` can at most equal the full trans-ductal gradient, the peak jet velocity cannot exceed `√(gradient/4)`. Raising peak velocity beyond that ceiling requires a larger systemic–pulmonary pressure difference (e.g. higher SVR / lower PVR), not duct geometry.
- **Viscosity is dynamic.** `viscosity` is pulled from the upstream `AAR` compartment each step (which itself follows hematocrit), so `res` tracks viscosity changes automatically.

````

### FILE: explain-engine/docs/Placenta.md

````markdown
# Placenta

The `Placenta` model is a **coordinator** for the **fetal** placental circulation and gas exchange.
Like [Pda](./Pda.md) and [Shunts](./Shunts.md), it owns no physics of its own — it drives a set of
pre-built sub-models (umbilical and fetal-placental resistors, the maternal blood pool, and a
blood-blood gas diffusor) from a single set of parameters, and switches the whole unit on or off.

> **This is the FETAL placenta.** It exchanges gases against a **fixed-composition maternal pool**
> (`PL_MAT`) whose O₂/CO₂ contents are held at constant scalars (`mat_to2`/`mat_tco2`) — i.e. an
> idealized, infinite maternal reservoir. The *maternal* intervillous bed and uterine supply are
> modelled separately by [MaternalPlacenta](./MaternalPlacenta.md) and [Uterus](./Uterus.md); when
> those are active they take over the maternal pool (see `skip_mat_gas_write` below).

## Inheritance

```
BaseModelClass
  └── Placenta   (group coordinator — no compartment of its own)
```

Extends `BaseModelClass` directly. `calc_model()` writes onto referenced sub-models; it has no
`el_base`/`vol`/`r_for` of its own.

## What it models

Fetal blood leaves the descending aorta, runs through the umbilical arteries to the fetal side of the
placenta, exchanges O₂/CO₂ with maternal blood across the placental membrane, and returns via the
umbilical vein to the inferior vena cava.

```
DA ──[PL_UMB_ART]──► PL_FETAL_ART ─► PL_FETAL_CAP ─► PL_FETAL_VEN ──[PL_UMB_VEN]──► (PL_UMB_VEN_IVCI) ──► IVCI
                                          │
                                    [PL_GASEX: BloodDiffusor]
                                          │
                                       PL_MAT  (maternal pool, fixed composition)
```

| Reference | Model | Role |
|---|---|---|
| `_umb_art` / `_umb_ven` | `PL_UMB_ART` / `PL_UMB_VEN` | umbilical artery / vein resistors |
| `_plf_art` / `_plf_cap` / `_plf_ven` | `PL_FETAL_ART/CAP/VEN` | fetal-placental resistors |
| `_plm` | `PL_MAT` | maternal blood pool — a `fixed_composition` reservoir held at `mat_to2`/`mat_tco2` |
| `_gas_exchanger` | `PL_GASEX` | `BloodDiffusor` exchanging O₂/CO₂ between fetal capillary and maternal pool |
| `_umb_ven_ret` | `PL_UMB_VEN_IVCI` | standalone umbilical-vein → IVC return resistor (Placenta-owned) |

## Properties

### Configuration (set in the model definition)

| Property | Default | Unit | Description |
|---|---|---|---|
| `placenta_running` | `false` | — | master on/off (drives `is_enabled` of all sub-models) |
| `umb_clamped` | `true` | — | clamp the umbilical/fetal vessels (`no_flow`) while running |
| `skip_mat_gas_write` | `false` | — | when true, do **not** write `PL_MAT` gases here (the Uterus coupling is authoritative) |
| `umb_art_res` | `800` | mmHg·s/L | umbilical-artery resistance |
| `umb_art_res_factor` | `1.0` | — | multiplier on `umb_art_res` |
| `umb_ven_res` | `100` | mmHg·s/L | umbilical-vein resistance |
| `umb_ven_res_factor` | `1.0` | — | multiplier on `umb_ven_res` |
| `plf_res` | `2000` | mmHg·s/L | fetal-placental resistance (applied to art/cap/ven) |
| `plf_res_factor` | `1.0` | — | multiplier on `plf_res` |
| `mat_to2` | `6.85` | mmol/L | maternal total O₂ content held on `PL_MAT` |
| `mat_tco2` | `23` | mmol/L | maternal total CO₂ content held on `PL_MAT` |
| `dif_o2` | `0.0005` | mmol/mmHg·s | O₂ diffusion constant pushed to `PL_GASEX` |
| `dif_co2` | `0.001` | mmol/mmHg·s | CO₂ diffusion constant pushed to `PL_GASEX` |

### Declared outputs

`umb_art_flow`, `umb_art_velocity`, `umb_ven_flow`, `umb_ven_velocity` are declared as dependent
parameters but are **not** updated by the current `calc_model` (reserved read-outs). Read umbilical
flow from the resistors (`PL_UMB_ART.flow` / `PL_UMB_VEN.flow`) instead.

### Local (internal)

`_update_interval` (0.015 s) / `_update_counter` throttle the loop; `_umb_art`/`_umb_ven`/`_plf_*`/
`_plm`/`_gas_exchanger`/`_umb_ven_ret` cache the sub-model references resolved in `init_model`.

## Calculation cycle (`calc_model`)

Every `_update_interval` (0.015 s):

1. **Guard** — return if any required sub-model reference is missing.
2. **Sync enabled state** — every sub-model's `is_enabled` (including the `_umb_ven_ret` return
   resistor) is set to `placenta_running`. This runs on **every** tick (not only while running) so
   that *stopping* the placenta actually disables flow and gas exchange.
3. **Only while running:**
   - **Clamp** — set `no_flow = umb_clamped` on the umbilical/fetal resistors and on the return
     resistor (so a clamp stops flow on both sides).
   - **Resistances** — `umb_art_res · factor`, `umb_ven_res · factor`, `plf_res · factor` onto the
     respective resistors (`plf_res` is applied to the fetal art/cap/ven trio).
   - **Maternal gases** — unless `skip_mat_gas_write`, hold `PL_MAT.to2 = mat_to2`,
     `PL_MAT.tco2 = mat_tco2` (the maternal pool is `fixed_composition`, so the diffusor draws from it
     without depleting it).
   - **Diffusion constants** — push `dif_o2`, `dif_co2` to the gas exchanger.

## Example definition (JSON)

From `term_fetus.json` (placenta running, cord unclamped):

```json
{
  "name": "Placenta",
  "description": "Placenta model",
  "model_type": "Placenta",
  "is_enabled": true,
  "placenta_running": true,
  "umb_clamped": false,
  "skip_mat_gas_write": false,
  "umb_art_res": 680,
  "umb_art_res_factor": 1,
  "umb_ven_res": 100,
  "umb_ven_res_factor": 1,
  "plf_res": 1500,
  "plf_res_factor": 1,
  "mat_to2": 7.4,
  "mat_tco2": 21,
  "dif_o2": 0.03,
  "dif_co2": 0.04
}
```

## Usage in the model

- In **fetal** scenarios (e.g. `term_fetus.json`) the placenta is the gas exchanger and the lungs are
  inert; the open FO ([Shunts](./Shunts.md)) and ductus arteriosus ([Pda](./Pda.md)) complete fetal
  circulation.
- **Birth transition** is modelled by clamping (`umb_clamped = true`, flow stops) and then stopping
  (`placenta_running = false`, the whole unit is disabled).
- When the **maternal–fetal coupling** is active, [Uterus](./Uterus.md) / [MaternalPlacenta](./MaternalPlacenta.md)
  drive `PL_MAT` instead; set `skip_mat_gas_write = true` so the maternal pool has exactly **one**
  authoritative writer per step.

## Notes & caveats

- **Two independent off-switches.** `placenta_running = false` disables every sub-model (flow *and*
  gas exchange stop). `umb_clamped = true` stops flow only (via `no_flow`) while the placenta keeps
  running — useful to model cord occlusion with the unit otherwise intact.
- **Maternal pool is an infinite reservoir.** `PL_MAT` is `fixed_composition`, so the diffusor
  exchanges gases with it without changing its composition; the Placenta also re-asserts
  `mat_to2`/`mat_tco2` each tick (unless `skip_mat_gas_write`).
- **`mat_to2`/`mat_tco2` are total contents (mmol/L), not partial pressures** — the gas exchange
  itself is partial-pressure driven inside `PL_GASEX`, which derives pCO₂/pO₂ from these contents.
- **Sub-model references are required.** `calc_model` skips the tick if any is missing rather than
  dereferencing null.
- **The umbilical-vein → body return is an autonomous resistor under Placenta control.** The return
  segment `PL_UMB_VEN → IVCI` is the resistor `PL_UMB_VEN_IVCI`, declared as a standalone `Resistor`
  in the model definition — deliberately **not** an entry in `IVCI.inputs`. If it were an IVCI input,
  `IVCI` (a `BloodVessel`) would auto-create and co-manage it, re-asserting its `is_enabled`/`no_flow`
  every step and leaving it outside the placenta's two off-switches (a one-way leak of placental blood
  into the fetal IVC whenever the unit was stopped or clamped). As a free resistor, nothing else owns
  it: the `Placenta` resolves it by name in `init_model` (`_umb_ven_ret`) and drives its `is_enabled`
  (= `placenta_running`) and `no_flow` (= `umb_clamped`) alongside the rest of the unit. Its
  resistance is left at the scenario value, so running-unclamped hemodynamics are unchanged.
  **When wiring a new placenta scenario, connect the umbilical vein to the IVC with a standalone
  `PL_UMB_VEN_IVCI` resistor — do not add `PL_UMB_VEN` to `IVCI.inputs`,** or the off-switches break.

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

Each per-class doc follows the same house template (see the template section in
[ARCHITECTURE](./ARCHITECTURE.md)): summary → inheritance → what it models → property tables →
calculation/math → factor system → example JSON → usage. The exemplar is
[BloodCapacitance](./BloodCapacitance.md).

> **Cross-cutting footgun:** the factor/effective-value scaling tier is **not uniformly named**.
> The capacitance/resistor/time-varying-elastance family uses `*_factor_scaling_ps`, but the
> diffusor/exchanger family (`GasDiffusor`, `GasExchanger`, `BloodDiffusor`) uses `*_factor_scaling`
> (no `_ps`). See [ARCHITECTURE §cross-cutting patterns](./ARCHITECTURE.md).

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
| [GasDiffusor](./GasDiffusor.md) | Diffusion of gases between two gas compartments. |
| [GasExchanger](./GasExchanger.md) | O₂/CO₂ transfer across the blood–gas (alveolar–capillary) barrier. |

## Blood side

| Doc | Models |
|---|---|
| [Blood](./Blood.md) | Whole-blood manager: Hb, blood volume, P50, composition init/propagation across compartments. |
| [BloodCapacitance](./BloodCapacitance.md) | Blood-filled compartment; `volume_in` mixes gases/solutes/drugs/temp/viscosity by volume fraction. **(template exemplar)** |
| [BloodTimeVaryingElastance](./BloodTimeVaryingElastance.md) | Time-varying-elastance compartment carrying blood composition (pumping chamber). |
| [BloodVessel](./BloodVessel.md) | Vessel segment with embedded resistor + ANS tone; **multiplicative** factor composition + α-coupling. |
| [BloodPump](./BloodPump.md) | Active blood-pump compartment (flow source). |
| [BloodComposition](./BloodComposition.md) | Acid–base / oxygenation solver (`calc_blood_composition`): Stewart SID + O₂/CO₂ dissociation, Haldane/Bohr coupling. *(module function, not a model_type)* |

## Gas side

| Doc | Models |
|---|---|
| [Gas](./Gas.md) | Gas-phase manager: atmospheric pressure, humidity, gas composition init. |
| [GasCapacitance](./GasCapacitance.md) | Gas-filled elastic compartment (lung/airway); tracks partial pressures/fractions. |
| [GasComposition](./GasComposition.md) | Computes gas partial pressures/fractions from total pressure, humidity, temperature. *(module function)* |

## Cardiac

| Doc | Models |
|---|---|
| [Heart](./Heart.md) | Master cardiac driver: HR, conduction/cycle counters, activation, ECG, arrhythmias (AV block / escape / VT / PVC). |
| [HeartChamber](./HeartChamber.md) | A single chamber (LA/LV/RA/RV); time-varying elastance with ANS, mob, drug, load & remodel factors. |
| [HeartFunction](./HeartFunction.md) | Load-induced contractility compromise (afterload mismatch, wall-stress dilation, remodeling). |
| [HeartValve](./HeartValve.md) | Cardiac valve — thin directional [Resistor](./Resistor.md) subclass. *(intentional stub)* |
| [Mob](./Mob.md) | Myocardial oxygen balance / heart-muscle metabolism. |

## Vascular & circulatory

| Doc | Models |
|---|---|
| [Circulation](./Circulation.md) | High-level circulation orchestrator; wires/scales the systemic & pulmonary network. |
| [Shunts](./Shunts.md) | Intracardiac/extracardiac shunts (foramen ovale, VSD, intrapulmonary). |
| [Pda](./Pda.md) | Patent ductus arteriosus: single AAR→PA resistor with quadratic stenosis; drug-modulated diameter. |
| [Pda-velocity](./Pda-velocity.md) | Design rationale for the PDA Doppler velocity output (+ retained historical analysis). |
| [Placenta](./Placenta.md) | **Fetal** placenta as a gas exchanger to a fixed maternal pool. |
| [MaternalPlacenta](./MaternalPlacenta.md) | **Maternal** intervillous-space bed / spiral-artery perfusion. |
| [Uterus](./Uterus.md) | Uterine circulation + pregnancy adaptation + contractions/labor (IUP waveform, MVU). |

## Control & regulatory

| Doc | Models |
|---|---|
| [Ans](./Ans.md) | Autonomic nervous system controller; hub doc for the afferent→efferent baro/chemoreflex loop. |
| [AnsAfferent](./AnsAfferent.md) | Afferent receptor pathway (sensor → firing rate). *(stub → [Ans](./Ans.md))* |
| [AnsEfferent](./AnsEfferent.md) | Efferent effector pathway (firing rate → effect factor). *(stub → [Ans](./Ans.md))* |
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
| [Breathing](./Breathing.md) | Spontaneous breathing drive; muscle pressure on the active airway inlet (MOUTH_DS or VENT_ETTUBE). |
| [Respiration](./Respiration.md) | Respiratory subsystem orchestrator (lung mechanics / gas-exchange wiring & scaling). |
| [Surfactant](./Surfactant.md) | Dynamic RDS alveolar recruitment/derecruitment with hysteresis + surfactant therapy. |

## Devices (`device_models/`)

| Doc | Models |
|---|---|
| [Ventilator](./Ventilator.md) | Mechanical ventilator (modes incl. CPAP/PS via ET tube); pressure/flow into the airway. |
| [Ecls](./Ecls.md) | Extracorporeal life support (ECMO): pump, oxygenator, cannulae. |
| [Monitor](./Monitor.md) | Patient monitor; derives displayed vitals from model state. |
| [Resuscitation](./Resuscitation.md) | Resuscitation interventions (chest compressions). |

## Engine helpers (`helpers/`)

Infrastructure that the worker attaches to the live `model` object — not physiological models.

| Doc | Helper |
|---|---|
| [DataCollector](./DataCollector.md) | Dual-rate (fast 0.005 s / slow 1.0 s) property watchlists + sample buffers. |
| [TaskScheduler](./TaskScheduler.md) | Deferred/tweened prop mutations and scheduled model-function calls. |
| [ModelScaler](./ModelScaler.md) | Allometric/weight scaling; writes only the `*_factor_scaling_ps` layer. |
| [Calibrator](./Calibrator.md) | Closed-loop calibration controllers (shared by patient-build and live `tune_model`). |
| [ChannelWriter](./ChannelWriter.md) | Worker→main realtime producer; writes samples into shared-memory ring buffers. |
| [RealtimeChannels](./RealtimeChannels.md) | Shared constants/layout for the realtime channel protocol. |
| [AnimationPacker](./AnimationPacker.md) | Packs per-component animation values (magnitude/tint) into the animation channel. |
| [RealTimeMovingAverage](./RealTimeMovingAverage.md) | O(1) rolling-average smoother for realtime signals. |

## Realtime read side (`explain/realtime/`, main thread)

The main-thread mirror of the `ChannelWriter`/`RealtimeChannels`/`AnimationPacker` write side.

| Doc | Component |
|---|---|
| [RealtimeBus](./RealtimeBus.md) | `requestAnimationFrame` loop that drains a `ChannelReader` and pushes frames to renderer adapters (`onRegistry`/`onFrame`). |
| [ChannelReader](./ChannelReader.md) | Read side of the data plane; decodes the shared-memory (`Atomics`/seqlock) or transferable transport. |

## Clinical references

Not tied to a single class — physiology/clinical background and scenario-build roadmaps.

| Doc | What it covers |
|---|---|
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
| `CHART_CTRL.READ_HINT` | `1` | Lets the writer detect a stalled reader |
| `CHART_CTRL.VERSION` | `2` | Must match the registry the rows were written under |
| `CHART_CTRL.CAPACITY` | `3` | Number of rows the data ring holds |
| `CHART_CTRL.STRIDE` | `4` | Floats per row (col 0 = time, then signals) |
| `CHART_CTRL.LEN` | `5` | Length of the control `Int32Array` |

### Anim control header — `ANIM_CTRL`

Indices into the anim control array. The anim channel is a **seqlock over two physical frames** (a flip buffer): the writer fills the inactive frame, flips `ACTIVE`, then bumps `SEQ`; the reader copies the `ACTIVE` frame and retries if `SEQ` changed mid-copy (torn-read protection).

| Index | Value | Meaning |
|---|---|---|
| `ANIM_CTRL.ACTIVE` | `0` | `0` or `1` — which frame slot holds the newest data |
| `ANIM_CTRL.SEQ` | `1` | Bumped on every publish; odd while a write is in progress |
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

A `Resistor` moves volume between two compartments driven by their pressure difference. It is the
**flow element** of the circuit and the canonical implementation of the factor / effective-value
pattern for resistances; `HeartValve` is a thin subclass, and `BloodVessel` creates `Resistor`s
internally.

## Inheritance

```
BaseModelClass
  └── Resistor          (pressure-driven flow between two compartments)
        └── HeartValve      (+ no_back_flow valve behaviour)
```

See [BaseModelClass.md](./BaseModelClass.md) for the lifecycle contract and shared fields.

## What it models

Flow from `comp_from` to `comp_to`, with separate forward/backward resistances and an optional
non-linear (turbulent) term:

```
ΔP = (comp_from.pres + p1_ext) − (comp_to.pres + p2_ext)
forward  (ΔP ≥ 0):  flow = (ΔP − r_k_eff · prev_flow²) / r_for_eff
backward (ΔP < 0):  flow = (ΔP + r_k_eff · prev_flow²) / r_back_eff     (unless no_back_flow)
```

The resistor does not store volume itself — it reads the two compartments' pressures, computes a flow,
and hands the volume across via their `volume_out`/`volume_in` methods.

## Properties

### Config / independent (set in the definition JSON)

| Property | Unit | Description |
|---|---|---|
| `r_for` | mmHg·s/L | Forward flow resistance |
| `r_back` | mmHg·s/L | Backward flow resistance |
| `r_k` | unitless | Non-linear (turbulent) resistance coefficient |
| `comp_from` | string | Name of the upstream compartment |
| `comp_to` | string | Name of the downstream compartment |
| `no_flow` | bool | When true, block all flow (set `flow = 0` and return) |
| `no_back_flow` | bool | When true, block backward flow (valve behaviour) |
| `p1_ext` | mmHg | External pressure added at the inlet (non-persistent; cleared each step) |
| `p2_ext` | mmHg | External pressure added at the outlet (non-persistent; cleared each step) |
| `fixed_composition` | bool | Passed through to the endpoints' volume handling |
| `is_externally_managed` | bool | Flag read by owning models to skip their own flow calc |

Factor inputs (all default `1.0`) — see [Factor system](#factor-system):
`r_factor`, `r_k_factor` (non-persistent); `r_factor_ps`, `r_k_factor_ps` (persistent);
`r_factor_scaling_ps`, `r_k_factor_scaling_ps` (scaling). Note a **single** `r_factor` layer scales
both `r_for` and `r_back`.

### Computed / dependent (engine outputs)

| Property | Unit | Description |
|---|---|---|
| `flow` | L/s | Current flow (positive = forward, negative = backward) |
| `r_for_eff` | mmHg·s/L | Effective forward resistance after the factor layers |
| `r_back_eff` | mmHg·s/L | Effective backward resistance after the factor layers |
| `r_k_eff` | unitless | Effective non-linear coefficient after the factor layers |
| `_comp_from` / `_comp_to` | ref | Resolved references to the up/downstream compartments |
| `_prev_flow` | L/s | Flow from the previous step (used by the non-linear term) |

## Calculation cycle (`calc_model`)

Each step: resolve `_comp_from`/`_comp_to` from `model.models`, then `calc_resistance()` →
`calc_flow()`.

### `calc_resistance`

```
r_for_eff  = r_for  + (r_factor − 1)·r_for   + (r_factor_ps − 1)·r_for   + (r_factor_scaling_ps − 1)·r_for
r_back_eff = r_back + (r_factor − 1)·r_back  + (r_factor_ps − 1)·r_back  + (r_factor_scaling_ps − 1)·r_back
r_k_eff    = r_k    + (r_k_factor − 1)·r_k   + (r_k_factor_ps − 1)·r_k   + (r_k_factor_scaling_ps − 1)·r_k
```

Then resets the non-persistent factors `r_factor` and `r_k_factor` to `1.0`.

### `calc_flow`

1. Compute inlet/outlet pressures including the non-persistent `p1_ext`/`p2_ext`, then clear those and
   reset `flow` to `0`.
2. If `no_flow`, set `_prev_flow = 0` and return.
3. Pick the direction by the sign of `ΔP` (forward if `ΔP ≥ 0`, else backward unless `no_back_flow`),
   guard against a non-positive effective resistance, and compute `flow` with the lagged non-linear
   term.
4. Move the volume across:
   - `comp_from.volume_out(flow · Δt)` returns any volume it could not supply;
   - `comp_to.volume_in(flow · Δt − un-supplied, comp_from)` adds the rest and mixes composition.

   This `volume_out` → `volume_in` handshake conserves volume — a resistor never creates volume from
   an empty compartment.
5. Store `_prev_flow = flow` (or clear it to `0` when no flow occurred — no-flow or blocked backflow)
   so the non-linear term stays consistent next step.

## Factor system

The resistances are **never used raw**. Each parameter combines three multiplier layers **additively
against the base** into an `*_eff` value:

| Layer | Persistence | Set by |
|---|---|---|
| `<p>_factor` | reset to `1.0` every step | transient interventions |
| `<p>_factor_ps` | persistent | user / scenario / regulator models (ANS, Circulation…) |
| `<p>_factor_scaling_ps` | persistent | `ModelScaler` (allometric/weight scaling) |

```
p_eff = p + (factor − 1)·p + (factor_ps − 1)·p + (factor_scaling_ps − 1)·p
```

`r_factor` / `r_factor_ps` / `r_factor_scaling_ps` apply identically to both `r_for` and `r_back`;
`r_k` has its own `r_k_factor` family. This is the same pattern as [`Capacitance`](./Capacitance.md).

## Notes

- **Non-linear term.** It reads `_prev_flow`, not the just-reset `flow` — an explicit lagged scheme; at
  steady state `prev_flow == flow`. (An earlier version used the zeroed `flow`, so `r_k` was inert.)
- **Resistance guard.** A non-positive effective resistance is skipped (no flow) to avoid an
  Infinity/NaN flow.
- `r_k` is `0` in the standard scenarios, so the linear Poiseuille term dominates; the non-linear term
  is available for turbulent/stenotic elements.

## Example definition (JSON)

```json
{
  "name": "PA_PAAL",
  "description": "input connector for PAAL",
  "model_type": "Resistor",
  "is_enabled": true,
  "r_for": 1493.7,
  "r_back": 1493.7,
  "r_k": 0,
  "comp_from": "PA",
  "comp_to": "PAAL",
  "no_flow": false,
  "no_back_flow": false,
  "p1_ext": 0,
  "p2_ext": 0,
  "fixed_composition": false,
  "is_externally_managed": false
}
```

## Usage in the model

- Every connection that carries flow between two compartments is a `Resistor` (a typical neonate
  scenario has ~40 of them wiring the circuit together by `comp_from`/`comp_to`).
- Set `no_back_flow` for valve-like behaviour (or use `HeartValve`).
- `r_factor_ps` is the standard lever for vasoconstriction/dilation (PVR/SVR adjustments by ANS and
  scenario tuning); `r_factor_scaling_ps` is written by `ModelScaler` for weight-based scaling.

````

### FILE: explain-engine/docs/Respiration.md

````markdown
# Respiration

`Respiration` is a **coordinator**, not a physical compartment (the same pattern as
[Circulation](./Circulation.md)). It groups the models of the respiratory tract by name and applies
whole-system adjustments to their elastance, resistance and gas-exchange factors. It owns no volume,
pressure or flow of its own.

It is the *mechanical/structural* counterpart to [Breathing](./Breathing.md): `Breathing` generates
the breath effort, while `Respiration` sets the lung/thorax stiffness, airway resistance and
gas-exchange efficiency that the breath acts against.

## Inheritance

```
BaseModelClass
  └── Respiration   (group coordinator — no physics of its own)
```

Extends `BaseModelClass` directly; `calc_model()` iterates over named members and writes onto their
persistent factor layers rather than computing any physics itself.

## What it models

A single set of system-wide multipliers over the respiratory tree:

- **Lung / chest-wall stiffness** — `el_lungs_factor`, `el_thorax_factor`.
- **Airway resistance** — `res_upper_airways_factor`, `res_lower_airways_factor`.
- **Gas-exchange efficiency** — `gex_factor` (drives both O₂ and CO₂ diffusion).

Each multiplier is translated into a **delta** on the corresponding `*_factor_ps` of the grouped
models, so it composes additively with other writers of that persistent layer.

## Properties

### Group lists (set in the model definition)

| List | Default members | Role |
|---|---|---|
| `upper_airways` | `["MOUTH_DS"]` | mouth → dead-space resistor |
| `lower_airways` (`_left`/`_right`) | `["DS_ALL", "DS_ALR"]` | dead-space → alveolar resistors |
| `dead_space` | `["DS"]` | conducting-airway gas compartment |
| `thorax` | `["THORAX"]` | chest-wall container |
| `lungs` (`left_lung`/`right_lung`) | `["ALL", "ALR"]` | alveolar gas compartments |
| `gas_echangers` (`_left`/`_right`) | `["GASEX_LL", "GASEX_RL"]` | blood↔gas exchangers |
| `pleural_space_left`/`_right` | `[]` | reserved (declared, not driven) |
| `intrapulmonary_shunt` | `["IPS"]` (scenarios override, e.g. `["IPSL","IPSR"]`) | reserved (declared, not driven) |

> Note: `gas_echangers` is a (consistent) misspelling of "exchangers" — both the property and the
> definition key use it, so it is left as-is. Some definitions also carry a correctly-spelled
> `gas_exchangers` field; the source reads only `gas_echangers`.

### Factor inputs (set in the model definition)

| Property | Default | Method | Drives |
|---|---|---|---|
| `el_lungs_factor` | `1.0` | `set_el_lung_factor` | `el_base_factor_ps` on the lungs |
| `el_thorax_factor` | `1.0` | `set_el_thorax_factor` | `el_base_factor_ps` on the thorax |
| `res_upper_airways_factor` | `1.0` | `set_upper_airway_resistance` | `r_factor_ps` on the upper airways |
| `res_lower_airways_factor` | `1.0` | `set_lower_airway_resistance` | `r_factor_ps` on the lower airways |
| `gex_factor` | `1.0` | `set_gasexchange` | `dif_o2_factor_ps` **and** `dif_co2_factor_ps` on the exchangers |

### Local (internal)

`_update_interval` (0.015 s) / `_update_counter` throttle the loop; `_prev_*` shadow each factor so a
change can be detected and applied as a delta.

## Calculation cycle (`calc_model`)

One throttled loop (every 0.015 s) that applies each factor **only when it changed** (guarded by a
`_prev_*` comparison). Each changed input calls its `set_*` method, then stores the new value into
`_prev_*`.

## The `set_*` methods — delta application

Every target is a **persistent** factor (`*_factor_ps`) that accumulates contributions from several
models, so `Respiration` applies the **delta** since its last call, not the absolute value:

```
delta = new_factor − prev_factor
for each model in the group:  factor_ps += delta   (clamped at 0)
this.<factor> := new_factor          (prev_factor stored by calc_model after the call)
```

The delta is computed **once** so every model in the group gets the same change, and each factor is
clamped at 0 (negative elastance/resistance/diffusion factors are non-physical). `set_gasexchange`
applies the delta to both the O₂ and CO₂ diffusion factors, clamping each independently.

## Factor system

`Respiration` does not itself carry the three-tier `_factor`/`_factor_ps`/`_factor_scaling_ps` pattern
(it has no base physics param). Instead it is one of the *writers* of the **persistent** `*_factor_ps`
tier on the grouped models: `el_base_factor_ps` (lungs/thorax), `r_factor_ps` (airways) and
`dif_o2/co2_factor_ps` (exchangers). It never touches the non-persistent (`_factor`) or scaling
(`_factor_scaling_ps`) tiers — those belong to transient interventions and `ModelScaler` respectively.

All factor inputs default to 1.0 (no effect). Disease scenarios raise lung/airway factors (e.g. RDS →
stiff lungs, bronchospasm → high lower-airway resistance) or lower `gex_factor` (impaired diffusion).

## Example definition (JSON)

From `term_neonate.json`:

```json
{
  "name": "Respiration",
  "description": "high level respiration model",
  "model_type": "Respiration",
  "is_enabled": true,
  "upper_airways": ["MOUTH_DS"],
  "lower_airways": ["DS_ALL", "DS_ALR"],
  "lower_airways_left": ["DS_ALL"],
  "lower_airways_right": ["DS_ALR"],
  "dead_space": ["DS"],
  "thorax": ["THORAX"],
  "lungs": ["ALL", "ALR"],
  "left_lung": ["ALL"],
  "right_lung": ["ALR"],
  "gas_echangers": ["GASEX_LL", "GASEX_RL"],
  "intrapulmonary_shunt": ["IPSL", "IPSR"],
  "el_lungs_factor": 1.0,
  "el_thorax_factor": 1.0,
  "res_upper_airways_factor": 1.0,
  "res_lower_airways_factor": 1.0,
  "gex_factor": 1.0
}
```

## Usage in the model

- Disease models (RDS / surfactant, CDH, bronchospasm) set `el_lungs_factor`,
  `res_lower_airways_factor` or `gex_factor` to impose stiff lungs, narrowed airways or impaired
  diffusion without touching the individual compartment definitions.
- Because the targets are the shared `*_factor_ps` layer, Respiration composes with whatever the
  surfactant/recruitment model or `ModelScaler` is doing to the same compartments.
- It is the structural partner of [Breathing](./Breathing.md) (effort generator) and the respiratory
  analogue of [Circulation](./Circulation.md) (vascular-tree coordinator).

## Notes & caveats

- **Factors are cumulative and shared.** `*_factor_ps` is written by several models; `Respiration`
  only adds its delta. A factor driven to the 0 clamp stops tracking further decreases until the
  target rises again — inherent to the per-model persistent-factor scheme.
- **Side- and space-specific lists are reserved.** `pleural_space_left/right`, `intrapulmonary_shunt`,
  and the `_left`/`_right` airway/lung/exchanger lists are declared but **not** used by any method —
  hooks for future per-side control.
- **Group membership is name-based** — a model is only affected if its name is in the relevant list.

````

### FILE: explain-engine/docs/Resuscitation.md

````markdown
# Resuscitation

The `Resuscitation` device model drives a **CPR** scenario: rhythmic chest compressions plus
ventilations, in the standard compression/ventilation cycles. It is a **coordinator** — it generates a
sinusoidal compression-pressure waveform and applies it to the circulation as an external pressure,
and it commands the [`Ventilator`](./Ventilator.md) and [`Breathing`](./Breathing.md) models to
deliver (or suppress) breaths.

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

### Internal (`_`-prefixed)

`_ventilator` / `_breathing` are references resolved in `init_model`. `_comp_timer` /
`_comp_counter` track the current compression; `_comp_pause` / `_comp_pause_interval` /
`_comp_pause_counter` manage the ventilation pause; `_vent_interval` / `_vent_counter` schedule the
breaths within a pause.

## Enabling CPR — `switch_cpr(state)`

When turned **on** it: starts the ventilator (`switch_ventilator(true)`), configures pressure control
from `vent_pres_pip` / `vent_pres_peep` / `vent_insp_time` (`set_pc(pip, peep, 1.0, t_in, 5.0)`),
switches off spontaneous `Breathing` (`switch_breathing(false)`), and sets `cpr_enabled = true`.
Turning it **off** just clears `cpr_enabled` (the ventilator/breathing states are left as they are).
All calls are null-guarded with `?.`.

## Calculation cycle (`calc_model`)

Runs every step while `cpr_enabled` (returns immediately otherwise):

1. **Timing** — the compression pause equals the time for `vent_no` breaths
   (`_comp_pause_interval = (60/vent_freq)·vent_no`); the per-breath interval is
   `_vent_interval = _comp_pause_interval/vent_no + _t`. In continuous mode the ventilator rate is set
   to `vent_freq`; otherwise it is forced to `1.0` (breaths are triggered manually during pauses).
2. **Pause handling** — while paused, advance `_comp_pause_counter` until `_comp_pause_interval`
   elapses (then resume compressions), and fire `Ventilator.trigger_breath()` every `_vent_interval`.
3. **Compression force** (when not paused) — a half-rectified sine:

   ```
   A = chest_comp_max_pres / 2
   f = chest_comp_freq / 60
   chest_comp_pres = A·sin(2πf·_comp_timer − π/2) + A
   ```

   so pressure ramps 0 → max → 0 each compression. After `60/chest_comp_freq` seconds the compression
   counter increments.
4. **Cycle control** — after `chest_comp_no` compressions in non-continuous mode, enter a pause and
   trigger a breath.
5. **Apply force** — for each `{ compartment: weight }` in `chest_comp_targets`,
   `compartment.pres_ext += chest_comp_pres · weight`.

## Compression coupling (important)

The compression is delivered as **external pressure** (`pres_ext`), the channel that *every*
compartment type reads (blood vessels, heart chambers, the thorax `Container`, gas compartments). It
is added (`+=`) so it composes with other external pressures and is consumed + reset by each
compartment's `calc_pressure` every step.

> Previously the force was written to `pres_cc`, which only `GasCapacitance` and `BloodPump` read — so
> the compressions reached the lungs but **not** the heart chambers or vessels, and generated no
> circulation. Writing `pres_ext` makes compressions actually drive forward flow. Because `pres_ext`
> is reset each step, a compression can lag a given compartment by at most one step depending on model
> step order.

Typical `chest_comp_targets` weights (scenario): ventricles `LV`/`RV` and coronaries `COR` at 1.0,
atria `RASVC`/`RAIVCI` at 0.8 and `LA` at 0.5, great vessels `AA`/`AAR` at 0.7 and `SVC`/`IVCI` at
0.5, lungs `ALL`/`ALR` at 0.2.

## `set_fio2(new_fio2)`

Forwards to `Ventilator.set_fio2` (null-guarded). Called once in `init_model` from `vent_fio2` so the
ventilator's fresh gas matches the configured CPR FiO₂.

## Factor system

`Resuscitation` has no `*_factor` parameters — compression strength is set directly via
`chest_comp_max_pres` and per-target weights in `chest_comp_targets`.

## Example definition (JSON)

From `term_neonate.json`:

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

## Usage in the model

- One `Resuscitation` per scenario, enabled but with `cpr_enabled: false` at rest. Start CPR with
  `switch_cpr(true)`; it takes over the [`Ventilator`](./Ventilator.md) (PC mode) and silences
  spontaneous [`Breathing`](./Breathing.md).
- Compression force reaches the circulation through `pres_ext` on the targeted compartments, driving
  forward flow during arrest.

## Notes & caveats

- **Requires `Ventilator` and `Breathing`.** Both are resolved at init; all calls are null-guarded, so
  a missing ventilator no longer crashes at build (`set_fio2`) or during CPR — compressions still run,
  but no mechanical breaths are delivered.
- **Compression is order-sensitive.** Applied via `pres_ext +=`; if `Resuscitation` steps after a
  target compartment, that compartment sees the compression one step later. Stable at the default step
  size.
- **Frequencies must be > 0** — `chest_comp_freq` and `vent_freq` appear in denominators; zero would
  yield a degenerate (infinite-period) cycle.

````

### FILE: explain-engine/docs/Shunts.md

````markdown
# Shunts

The `Shunts` model is a thin coordinator (like [Pda](./Pda.md)) that drives the resistances of the
**non-ductal shunts** from a small set of geometric inputs. It does not hold volume or pressure
itself — it owns no sub-models of its own but writes each step onto five pre-existing `Resistor`s.

It covers three shunt families:

| Shunt | Resistors driven | Path |
|---|---|---|
| **Foramen ovale (FO)** | `LA_RAIVCI`, `LA_RASVC` | LA ↔ the two right-atrial streams (RAIVCI, RASVC) |
| **Ventricular septal defect (VSD)** | `VSD` | LV ↔ RV |
| **Intrapulmonary shunts (IPS)** | `IPSL`, `IPSR` | arterial → venous within each lung (LL_ART→LL_VEN, RL_ART→RL_VEN) |

(The ductus arteriosus is handled separately by the [Pda](./Pda.md) model.)

## Inheritance

```
BaseModelClass
  └── Shunts   (group coordinator — no compartment of its own)
```

Extends `BaseModelClass` directly. `calc_model()` computes Hagen-Poiseuille resistances and writes
them onto the referenced `Resistor`s; it has no `el_base`/`vol`/`r_for` of its own.

## What it models

The FO and VSD are openings whose resistance follows the **Hagen-Poiseuille** law from their diameter,
the septal thickness (length), and blood viscosity. Closure is expressed directly via `diameter_fo` /
`diameter_vsd` (0 mm = closed → `no_flow`). The intrapulmonary shunts are a small *fixed* resistance
representing anatomic right-to-left lung shunting; they are **not** diameter-driven.

## Properties

### Configuration (set in the model definition)

| Property | Default | Unit | Description |
|---|---|---|---|
| `diameter_fo` | `2.0` | mm | foramen ovale diameter (0 = closed) |
| `diameter_fo_max` | `10.0` | mm | FO diameter ceiling (clamp) |
| `diameter_vsd` | `2.0` | mm | ventricular septal defect diameter (0 = closed) |
| `diameter_vsd_max` | `10.0` | mm | VSD diameter ceiling (clamp) |
| `atrial_septal_width` | `3.0` | mm | FO channel length |
| `ventricular_septal_width` | `5.0` | mm | VSD channel length |
| `fo_lr_factor` | `10.0` | — | left-to-right resistance multiplier on the FO (flap valve) |
| `ips_res` | `5000` | mmHg·s/L | fixed intrapulmonary shunt resistance |
| `viscosity` | `6.0` | cP | blood viscosity used in the resistance formula |

### Computed / reported (outputs)

| Property | Unit | Description |
|---|---|---|
| `res_fo` | mmHg·s/L | computed FO resistance (per orifice, before `fo_lr_factor`) |
| `res_vsd` | mmHg·s/L | computed VSD resistance |
| `flow_fo` | L/s | combined FO flow (`LA_RAIVCI.flow + LA_RASVC.flow`) |
| `flow_vsd` | L/s | VSD flow |
| `velocity_fo` | m/s | FO orifice velocity from combined flow |
| `velocity_vsd` | m/s | VSD orifice velocity |

### Local (internal)

`_fo_ivci`, `_fo_svc`, `_vsd`, `_ipsl`, `_ipsr` cache the five resistor references;
`_refs_resolved`/`_refs_warned` gate the one-time resolution and the single missing-wiring warning.

## Calculation cycle (`calc_model`)

1. **Resolve references once.** `_resolve_refs()` caches `LA_RAIVCI`, `LA_RASVC`, `VSD`, `IPSL`,
   `IPSR`. If any is missing it logs a single warning and `calc_model` returns early every step (so a
   partial wiring degrades gracefully instead of throwing).
2. **Clamp diameters** to their `*_max`.
3. **Flow gating** — set `no_flow = (diameter === 0)` on the FO (`LA_RAIVCI`, `LA_RASVC`) and VSD
   resistors.
4. **Resistances** — `res_fo`, `res_vsd` from `calc_resistance(diameter, septal_width, viscosity)`.
5. **Push resistances** to the resistors (see FO asymmetry below); IPS resistors get the constant
   `ips_res`.
6. **Read back flows** and compute orifice velocities (`Q/A`).

## Foramen ovale: flap-valve asymmetry and the split path

The FO is driven through **two** resistors (`LA_RAIVCI`, `LA_RASVC`) because the model splits the
right atrium into an IVC-stream and an SVC-stream. Each resistor receives:

```
r_for  = res_fo · fo_lr_factor      (LA → RA, restricted)
r_back = res_fo                     (RA → LA, easy)
```

`fo_lr_factor` (default 10, often higher in scenarios — e.g. 25) makes left-to-right flow much harder
than right-to-left, reproducing the **flap-valve** behaviour: in fetal/transitional physiology the FO
shunts right-to-left, and reverses only under raised left-atrial pressure.

> **Modelling note.** Because the FO is represented as two *parallel* resistors that each carry the
> full `res_fo`, the orifice's effective resistance is `res_fo / 2`. `velocity_fo` is therefore
> computed from the **combined** flow (`LA_RAIVCI.flow + LA_RASVC.flow`) over the single-orifice area
> from `diameter_fo`.

## Velocity outputs

```
area     = π · (diameter_mm · 1e-3 / 2)²          [m²]
velocity = (flow_L/s · 1e-3) / area               [m/s]   (0 when area = 0)
```

`velocity_fo` uses the summed FO flow; `velocity_vsd` uses the VSD flow.

## Resistance formula — `calc_resistance(diameter, length, viscosity)`

Standard Hagen-Poiseuille for a uniform cylinder:

```
R = (8 · μ · L) / (π · r⁴)        in Pa·s/m³   →  × 0.00000750062  →  mmHg·s/L
```

with diameter/length in mm and viscosity in cP. Returns the sentinel `1e8` (no flow) when
`diameter ≤ 0` or `length ≤ 0`. (This is a private copy of the same formula [Pda](./Pda.md) uses.)

## Example definition (JSON)

From `term_neonate.json` (a healthy term neonate — both septal openings closed):

```json
{
  "name": "Shunts",
  "description": "shunts (FO, ASD, VSD) model",
  "model_type": "Shunts",
  "is_enabled": true,
  "diameter_fo": 0,
  "diameter_fo_max": 10,
  "diameter_vsd": 0,
  "diameter_vsd_max": 10,
  "atrial_septal_width": 3,
  "ventricular_septal_width": 5,
  "fo_lr_factor": 25,
  "viscosity": 6,
  "ips_res": 25000
}
```

## Usage in the model

- A healthy term neonate runs with `diameter_fo = 0` and `diameter_vsd = 0` (closed); transitional and
  congenital scenarios open them (e.g. patent foramen ovale, muscular/perimembranous VSD).
- The fetal scenario keeps the FO open with a high `fo_lr_factor` so it shunts right-to-left, matching
  fetal circulation (see [Placenta](./Placenta.md) and the term-fetus scenario).
- `IPSL`/`IPSR` provide a small constant anatomic right-to-left lung shunt independent of the septal
  defects; raising/lowering `ips_res` tunes baseline shunt fraction.

## Notes & caveats

- **References resolve only once.** After the five resistors are cached, they are never re-resolved; a
  model added/removed at runtime would not be picked up. Missing wiring at first call is reported with
  a single console warning.
- **`viscosity` is a static input here** — unlike [Pda](./Pda.md) (which pulls it from its capacitance
  each step), `Shunts.viscosity` is whatever the definition sets and does not track hematocrit.
- **IPS resistance is fixed.** `IPSL`/`IPSR` always receive `ips_res`; there is no diameter or
  flow-gating on them.

````

### FILE: explain-engine/docs/Surfactant.md

````markdown
# Surfactant

The `Surfactant` model turns the previously **static** preterm RDS lung phenotype — baked-in stiff
alveoli, low FRC, reduced alveolar diffusion and an intrapulmonary shunt — into a **dynamic,
treatable** process: pressure-driven alveolar **recruitment / derecruitment with hysteresis**, plus a
**surfactant-therapy** response. It is a slow **process controller** in the same family as
[`Hormones`](./Hormones.md) / [`Kidneys`](./Kidneys.md) / `Lactate`: it holds no compartment,
resolves references to other models lazily, and is **neutral at rest**. A scenario that ships it keeps
its calibrated RDS operating point unchanged and only diverges when PEEP/CPAP changes or surfactant is
given.

It is the *pathophysiology/therapy* layer that sits on top of the lung mechanics owned by
[`Respiration`](./Respiration.md), the alveolar gas exchange of [`GasExchanger`](./GasExchanger.md),
and the venous admixture of [`Shunts`](./Shunts.md) — driven by the airway pressure that
[`Breathing`](./Breathing.md) and the [`Ventilator`](./Ventilator.md) impose.

## Recruitment state

```
SENSOR (lazy refs)                  STATE                         EFFECTORS (owned while running)
ALL.pres_in ─┐ mean, smoothed                                     ALL/ALR.el_base_factor   1−el_gain·r   (compliance)
ALR.pres_in ─┴─► P_tp ──► [ hysteresis dead zone ] ──► open_fraction ─► ALL/ALR.u_vol_factor 1+uvol_gain·r (FRC)
                          TCP ····· TOP                            GASEX_*.dif_o2/co2_factor 1+dif_gain·r  (gas exchange)
surfactant ───► lowers TOP/TCP                                    IPSL/IPSR.r_factor_ps    1+ips_gain·r   (less shunt)
```

`open_fraction` ∈ `[0,1]` is the fraction of alveoli that are open. It is driven by the mean
(breath-averaged) **transpulmonary pressure** `P_tp` = alveolar recoil pressure (`GasCapacitance.pres_in`,
averaged over both lungs `ALL`/`ALR` and smoothed first-order over `pres_tc` so tidal swings don't
dominate):

```
dOpen = [ k_open·max(0, P_tp − TOP)·(1 − open)     recruit above the opening threshold
        − k_close·max(0, TCP − P_tp)·open ] · dt   derecruit below the closing threshold
```

Between the closing threshold `TCP` and the opening threshold `TOP` there is a hysteresis **dead zone**
(`open` holds) — the signature of lung recruitment.

## Auto-centered thresholds (the robustness trick)

At warm-up (after `_warmup_delay` = 30 s, once the circuit has settled) the model captures the baseline
mean `P_tp` (`P0`), `open_fraction` (`f0`) and `surfactant` level (`surf0`), then centers the dead zone
on `P0`:

```
TOP = P0 + open_margin  − surf_open_gain ·(surfactant − surf0)
TCP = P0 − close_margin − surf_close_gain·(surfactant − surf0)
```

So at the scenario's own baseline (`surfactant == surf0`, `P_tp == P0`) the operating pressure sits
inside the dead zone → `open` holds at `f0` → the model is **neutral and stable at ANY scenario's
operating point with no per-scenario threshold tuning**. Raising PEEP pushes `P_tp` above `TOP` →
recruit; losing PEEP pushes it below `TCP` → derecruit; **surfactant lowers `TOP`/`TCP`** so the same
prevailing airway pressure now recruits the lung. Recruitment is **gated off until seeded** (`open_fraction`
holds at its init value during warm-up), so the `f0` (≈ 0.5) headroom is identical for every scenario
regardless of the warm-up pressure transient.

## Effectors

All effects are referenced to `f0`, so each factor is exactly `1.0` at baseline. With
`r = open_fraction − f0` (`+` = recruited above baseline, `−` = derecruited):

| Channel | Target | Factor | Effect of recruitment |
|---|---|---|---|
| `el_lung_factor` | `ALL`/`ALR`.`el_base_factor` | `1 − el_gain·r` | lower elastance / more compliant |
| `uvol_lung_factor` | `ALL`/`ALR`.`u_vol_factor` | `1 + uvol_gain·r` | higher FRC |
| `dif_factor` | `GASEX_LL`/`GASEX_RL`.`dif_o2_factor` & `dif_co2_factor` | `1 + dif_gain·r` | more gas-exchange surface |
| `ips_factor` | `IPSL`/`IPSR`.`r_factor_ps` | `1 + ips_gain·r` | higher shunt resistance → less venous admixture |

Each factor is clamped (`el` `[0.2,3.0]`, `uvol` `[0.3,3.0]`, `dif` `[0.1,5.0]`, `ips` `[0.1,30.0]`).

**Which factor layer matters.** The first three use the **non-persistent** factor layer
(`el_base_factor` / `u_vol_factor` / `dif_*_factor`) — reset to `1.0` each step by the compartment and
**re-written here every step** — so they compose additively with the [`Respiration`](./Respiration.md)
controller, which owns the persistent `*_factor_ps` layer (see the
[factor / effective-value pattern](./Capacitance.md)). The shunt instead modulates the **persistent**
`r_factor_ps` on `IPSL`/`IPSR` (those resistors carry their `r_for`/`r_back` from `Shunts.ips_res`);
that channel is **owned by Surfactant** and released back to `1.0` on disable.

## Surfactant therapy

`surfactant` ∈ `[0,1]` is alveolar maturity: `0` = severe deficiency (RDS), `1` = mature / fully
treated (default baseline `0.3`). The dosing API instills surfactant and ramps maturity up first-order:

```
administer_surfactant(target = 1.0)   // sets surfactant_target; callable via callModelFunction / TaskScheduler
surfactant += dt·(1/surfactant_tc)·(surfactant_target − surfactant)   // surfactant_tc = 180 s
```

The acute compliance/recruitment response therefore develops over a few minutes. Setting
`surfactant_target = null` holds maturity at its current value.

## Read-outs

| Read-out | Meaning |
|---|---|
| `open_fraction` | recruited alveolar fraction `[0,1]` |
| `transpulmonary_pressure` | smoothed mean `P_tp` (mmHg) |
| `open_pressure` / `close_pressure` | current `TOP` / `TCP` (mmHg) |
| `surfactant` | current alveolar maturity `[0,1]` |
| `el_lung_factor` / `uvol_lung_factor` / `dif_factor` / `ips_factor` | applied effector factors |

## Configuration & calibration

| Parameter | Default | Meaning |
|---|---|---|
| `surfactant` / `surfactant_tc` | `0.3` / `180.0` s | baseline maturity / therapy ramp time constant |
| `open_margin` / `close_margin` | `2.0` / `2.0` mmHg | dead-zone half-widths above/below `P0` |
| `surf_open_gain` / `surf_close_gain` | `14.0` / `12.0` mmHg | drop in `TOP` / `TCP` per unit surfactant rise |
| `k_open` / `k_close` | `0.5` / `0.5` (1/(mmHg·s)) | recruitment / derecruitment rates |
| `pres_tc` | `4.0` s | smoothing of `P_tp` |
| `el_gain` / `uvol_gain` / `dif_gain` / `ips_gain` | `0.7` / `1.5` / `2.0` / `6.0` | effect gains per unit `r` |
| `_warmup_delay` | `30.0` s | delay before capturing `P0` / `f0` / `surf0` |

> **Calibration note.** A spontaneously-breathing preterm runs at a **low** mean `P_tp` (~1–3 mmHg), so
> the margins are deliberately small and the surfactant gains large: a therapeutic dose must clearly
> pull the opening threshold below the prevailing airway pressure for recruitment to occur.

## Gating

`surfactant_running` (default `true`) is the master gate. When set `false`, `_release_channels()` runs
**once** — resetting `el_base_factor`/`u_vol_factor` on the lungs, `dif_o2_factor`/`dif_co2_factor` on
the gas exchangers, and the persistent `r_factor_ps` on the shunts all back to `1.0` — then the model
idles. This is the clean "off" switch that returns the lung to its underlying (static) phenotype.

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
> node scripts/probe_vitals.mjs term_neonate   # no npm install needed
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
| `send(type, message, payload)` | Raw envelope dispatch — `self.onmessage({ data: { type, message, payload } })`. The same `{type, message, payload}` envelope `explain/Model.js` posts over the wire (see [ARCHITECTURE](./ARCHITECTURE.md)). |
| `build(def)` | `send("POST", "build", def)` then `send("GET", "state", [])`; returns the live `model` handle (by reference). `def` is a `model_definition` object. |
| `calc(seconds)` | `send("POST", "calc", seconds)` — runs `seconds / modeling_stepsize` steps **synchronously**. |
| `scale(group, factor)` | `send("POST", "scale", { group, factor })` — routes to `ModelEngine.scale_model`. |
| `get model` | The captured live `model` object (same reference `build` returned, or `null` before build). |
| `log` | The original `console.log` (the harness silences `console.log` unless `verbose`), for callers that want to restore output. |

### The zero-engine-edit shim trick

`explain/ModelEngine.js` is a **Web-Worker module**: its only entry point is `self.onmessage`, and it replies via `postMessage`. Neither global exists in plain Node. The harness fabricates them **before** importing the engine, so the engine loads unmodified:

1. **ESM resolve hook.** The engine uses Vite-style **extensionless** relative imports (e.g. `import ... from "./ModelIndex"`), which Node's ESM resolver rejects. `scripts/resolve-extensionless.mjs` is a resolve hook that catches a failed relative-specifier import and retries it with a `.js` suffix. The harness registers it first: `register("./resolve-extensionless.mjs", import.meta.url)`.
2. **Global shims, installed BEFORE the engine import.** `globalThis.self = globalThis`, and `globalThis.postMessage = (msg) => {…}` — the fake `postMessage` captures the engine's replies: a `state` message stashes the live `model` (`liveModel = msg.payload`, **by reference, not a clone**), and `error` / `status ERROR` messages are forwarded to `console.error`.
3. **Import the engine.** `await import("../explain/ModelEngine.js")` runs the module body, which registers `self.onmessage` on the shimmed global.
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

1. **Boot** — register the resolve hook, install the `self`/`postMessage` shims, `await import("../explain/ModelEngine.js")`, define `send`. (Probes predating `_harness.mjs` inline this; newer ones import `createEngine`.)
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

   Reads come off the live [Monitor](./Monitor.md) (hemodynamics: `heart_rate`, `minmax.*`, `flows.*`, `sao2_*`, `etco2`, `temp`) and component models (e.g. `AA` for the arterial blood gas, `IVCI` for a mixed-venous proxy, `Pda.flow_pa` for the ductal shunt).
6. **Perturb (optional)** — apply an insult between phases (e.g. remove a volume fraction from every blood compartment for a haemorrhage, then `calc` again and re-measure) to compare baseline vs perturbed.
7. **Report** — print a labelled table with normal-range flags (`ok` / `LOW` / `HIGH`).

`probe_vitals.mjs` is the canonical example: it reports HR, ABP (sys/dia/mean), CVP, PAP, CO/RV-output, cardiac index, SpO2 (pre/post-ductal), PDA shunt, SvO2, RR, etCO2, temperature, and a full arterial blood gas, each flagged against a `RANGES` table selected by `--profile adult|neonate|preterm_24|…|preterm_36` (auto-picked from body weight when omitted). The measurement loop, the `RANGES` tables, and `selectProfile()`/`flagOf()` are shared via `scripts/_probe.mjs` so the generic builder (`build_patient.mjs`) measures identically.

### Run examples

```bash
node scripts/probe_vitals.mjs term_neonate
node scripts/probe_vitals.mjs preterm_28wk --profile preterm_28
node scripts/probe_vitals.mjs adult_female --no-ans --seconds 90
node scripts/probe_brain.mjs --scenario term_neonate --bleed 0.3
node scripts/probe_pda.mjs preterm_28wk --beats 6
```

Common flags seen across the vitals/brain/pda probes: `--seconds N` (warm-up), `--window W` (averaging window), `--verbose` (un-silence engine logs), `--no-ans` (freeze the baroreflex). Scenario-specific probes add their own (e.g. `probe_brain.mjs` `--bleed`/`--edema`/`--scenario`, `probe_pda.mjs` `--beats`/`--trace`). Confirm a probe's flags by reading its header comment — each script documents its own `Usage:` line.

## Important: probes are not CI gates

Probes are **interactive verification tools, not pass/fail test cases.** They print verdicts (labelled lines flagged `ok`/`LOW`/`HIGH`, or a `console.table`) and you read the result. A failed physiological assertion does **not** make the process exit non-zero — the only thing that exits `1` is a **build failure** (no `model`, missing required model). Do not wire them into a CI green/red check expecting a non-zero exit on a bad number; they will exit `0` while printing `HIGH`. There is no `npm test` and no aggregate runner — run the relevant probe by hand and inspect its output.

## Probe inventory

~29 `probe_*.mjs` scripts. Group by what they verify:

| Group | Scripts | Verifies |
|---|---|---|
| **Core vitals / calibration** | `probe_vitals.mjs`, `probe_tune.mjs`, `probe_ea.mjs` | Regulated vitals + ABG vs normal ranges; the live closed-loop tuner; mitral E/A ratio. |
| **Physiology systems** | `probe_brain.mjs`, `probe_surfactant.mjs`, `probe_derecruitment.mjs`, `probe_thermo.mjs`, `probe_glucose.mjs`, `probe_lactate.mjs`, `probe_heartfunction.mjs`, `probe_cpap.mjs`, `probe_arrhythmia.mjs`, `probe_drugs.mjs`, `probe_pge1.mjs` | Cerebral autoregulation/ICP; RDS recruitment/derecruitment + surfactant; thermoregulation; glucose/insulin; hypoxic lactate; load-induced contractility; CPAP/PS ventilation of spontaneous breathing; conduction arrhythmias; adrenaline/noradrenaline PK/PD; PGE1 ductal patency. |
| **Fetal / maternal** | `probe_fetus.mjs`, `probe_uterus.mjs`, `probe_placenta.mjs` | Fetal circulation; uterine bed / pregnancy adaptation / contractions; maternal placenta. |
| **PDA / CDH** | `probe_pda.mjs`, `probe_cdh.mjs` | PDA Doppler envelope classification; congenital diaphragmatic hernia phenotypes. |
| **CHD family** | `probe_as.mjs`, `probe_coarc.mjs`, `probe_dtga.mjs`, `probe_hlhs.mjs`, `probe_paivs.mjs`, `probe_pavsd.mjs`, `probe_ps.mjs`, `probe_ta.mjs`, `probe_tapvc.mjs` | Duct/FO-dependent congenital heart disease scenarios (aortic stenosis, coarctation, d-TGA, HLHS, PA-IVS, PA-VSD, pulmonary stenosis, tricuspid atresia, TAPVC). |

> `probe_knowledge_pack.mjs` is **not** an engine test — it validates the clinical-chat knowledge pack, not engine physiology. Ignore it for engine verification.

## Other engine-dev tooling

The remaining `scripts/*.mjs` support calibration, scenario authoring, and steady-state baking. They reuse the same harness/shim and the same envelope.

| Group | Scripts | Role |
|---|---|---|
| **Calibration** | `build_patient.mjs`, `probe_tune.mjs` | Closed-loop calibration via `explain/helpers/Calibrator.js` (see [Calibrator](./Calibrator.md)) — `build_patient.mjs` builds a new calibrated patient from target vitals; `probe_tune.mjs` exercises the same live tuner headlessly. |
| **Reseeding** | `reseed_*.mjs` (e.g. `reseed_term_neonate`, `reseed_preterm`, `reseed_adult_female`, the CHD set) | Warm a scenario to steady state and serialize it back into `model_definition` (baking equilibrium seeds, clearing startup transients). Each shares `_serialize_state.mjs` (replicates `Model._processModelState`). **Default is a dry run to `/tmp`**; pass `--write` to overwrite the scenario file in place. |
| **Scenario generation** | `_make_*.mjs` (e.g. `_make_preterm`, `_make_cdh_phenotypes`, `_make_dtga`, `_make_pda_patterns`, …) | Generate/derive a scenario JSON (usually from `term_neonate`) by applying phenotype-specific lever edits. |
| **Feature patchers** | `_add_neonatal_core.mjs`, `_add_brain.mjs`, `_add_surfactant.mjs` | Patch a model/feature into many existing scenario JSONs at once (without reseeding, to preserve calibration). |
| **Shared internals** | `_harness.mjs`, `_probe.mjs`, `_serialize_state.mjs`, `resolve-extensionless.mjs` | `createEngine`; `measureVitals`/`RANGES`/`selectProfile`/`flagOf`; the `serializeState` baker; the ESM `.js`-retry resolve hook. |

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
| `_tasks` | `{}` | dictionary of pending tasks keyed by `"task_<rand>"` |
| `_task_interval` | `0.015` s | period at which the queue is evaluated |
| `_task_interval_counter` | `0.0` | accumulator, advanced by `_t` each call while enabled |

### Task types

Each task carries a numeric `type` that decides how it is applied:

| `type` | Trigger | Behavior |
|---|---|---|
| `0` | numeric target, `it > 0` | **tween** — `current_value` is stepped by `stepsize` each interval until it reaches `t`, then completes |
| `1` | boolean/string target, **or** numeric with `it <= 0` | **instant swap** — `current_value` set to `t` and written once, then completes |
| `2` | function call | **invoke** — `func.apply(model, args)` once, then completes |

`stepsize` for a type-0 tween is `(t - current_value) / (it / _task_interval)`; a tween whose computed `stepsize` is exactly `0` is **not** enqueued.

## Key methods

| Signature | What it does |
|---|---|
| `add_task(new_task)` | Resolves `new_task.model` (a name) to a live instance, reads the current value of `prop1`(`.prop2`), infers `type` (0 numeric / 1 boolean-string), computes the tween `stepsize` from `it`, and enqueues under a random `task_<id>` key. `it <= 0` forces an instant (type-1) write. |
| `add_function_call(new_function_call)` | Splits `func` (`"Model.method"`), resolves the model and the method reference, marks the task `type = 2`, and enqueues it to fire after `at` seconds. |
| `run_tasks()` | When `_task_interval_counter > _task_interval`: resets the counter, iterates `_tasks`, decrements each task's `at` delay; once `at` elapses it starts type-0 tweens, performs type-1 swaps and type-2 calls immediately, and steps running tweens toward `t`. Completed tasks are deleted. Advances the counter by `_t` only while `is_enabled`. |
| `remove_task(task_id)` | Deletes `"task_<task_id>"` if present; returns whether something was removed. |
| `remove_all_tasks()` | Empties `_tasks`. |
| `_set_value(task)` *(private)* | Writes `current_value` into `task.model[prop1]` or `task.model[prop1][prop2]`. |

### `setPropValue(prop, value, it, at)` semantics

- `prop` — the target dot-path (`Model.prop` or `Model.prop.subprop`); split into `model` / `prop1` / `prop2`.
- `value` (`t` on the task) — the destination value.
- `it` — interpolation time in seconds. `it > 0` on a numeric target tweens over that span (one increment per `_task_interval`); `it <= 0` writes instantly (type 1). Booleans/strings always write instantly.
- `at` — delay in seconds before the task begins; decremented by `_task_interval` each evaluation until it elapses.

## Interaction with models

The scheduler mutates live model instances **directly** by property assignment via `_set_value`. In practice the `prop1`/`prop2` target is typically a persistent factor (`*_factor_ps`) or a base parameter — writing the persistent layer is how a deferred adjustment composes with the factor/effective-value system (transient `*_factor` reset each step, persistent `*_factor_ps`, scaling `*_factor_scaling_ps`) described in [ARCHITECTURE](./ARCHITECTURE.md). Type-2 tasks instead call a model method (`func.apply(task.model, task.args)`), e.g. an intervention like `administer_surfactant` or `trigger_pvc`.

The complementary read-only telemetry helper is [DataCollector](./DataCollector.md); the two run back-to-back inside `_model_step()` (collect, then run tasks).

## Notes / caveats

- **Task ids are random and collidable.** `add_task` / `add_function_call` mint `"task_" + Math.floor(Math.random() * 10000)` with no uniqueness check, so two near-simultaneous tasks can in principle overwrite each other in `_tasks`. `remove_task` takes the numeric suffix.
- **Zero-delta tweens are silently dropped.** A type-0 task whose computed `stepsize` is `0.0` is never enqueued by `add_task` — if the current value already equals the target there is nothing to do.
- **`is_enabled = false` freezes time, not the queue.** When disabled, `_task_interval_counter` stops advancing, so pending tasks neither tick nor fire; they resume from where they were when re-enabled. Tasks already in `_tasks` are not cleared.
- **Completion is one-shot.** Type-1 and type-2 tasks complete on their first eligible evaluation; type-0 completes when the remaining distance to `t` is smaller than `|stepsize|` (the final write snaps exactly to `t`). Completed tasks `delete` themselves from `_tasks`.
- **`run_tasks()` is excluded from the model state clone.** `get_model_props` deletes `TaskScheduler` (and `DataCollector`) from the posted model copy, so its internal queue is not serialized across the worker boundary.

````

### FILE: explain-engine/docs/Thermoregulation.md

````markdown
# Thermoregulation

The `Thermoregulation` model is the **body-temperature process controller** for the neonate — a slow
counterpart to [`Hormones`](./Hormones.md) (RAAS/ADH) and the [`Kidneys`](./Kidneys.md)
autoregulation loop. It holds no compartment of its own, resolves references to other models lazily,
runs on an `_update_interval` accumulator, and **owns its effector channels while enabled** (releasing
them once on disable). It models a **single well-mixed core node** whose temperature is the running
balance of heat produced against heat lost. Default config is **neutral**: thanks to the `_loss_trim`
auto-seed the core sits exactly at `setpoint_temp` (37 °C) at rest, every owned factor is `1.0`, and
baseline vitals/ABG are unchanged. The model only diverges when the thermal environment is perturbed
(cold incubator, radiant warmer, evaporative loss) or when heat production changes.

## Sensors → core node → effectors

```
SENSORS (lazy refs)              CORE NODE (single-node heat balance)        EFFECTORS (owned, default-neutral)
Metabolism.vo2 · vo2_factor ──┐
env_temp / radiant_temp ──────┼─► Q_prod (metabolic + brown fat)            Metabolism.vo2_temp_factor  (Q10 metabolic coupling)
rel_humidity ─────────────────┼─► Q_loss (radiative+convective+evap +trim)  Heart.hr_temp_factor        (temperature → heart rate)
weight (Meeh SA) ─────────────┘    dCore = (Q_prod − Q_loss)/(m·c)·dt        Blood.set_temperature(core) (acid-base / O2 dissoc. dT term)
```

## Heat balance

Every `_update_interval` (default **1 s** — temperature is slow), `_update_temperature(u)` runs the
single-node balance with `u` the exact elapsed time since the last update:

```
Q_prod  = metabolic + brown_fat                                                  [W]
  metabolic = (vo2_eff · weight / 60) · caloric_equiv_o2
    vo2_eff = Metabolism.vo2 · Metabolism.vo2_factor · vo2_temp_factor           (mL O2/kg/min)
  brown_fat = min( bat_gain · max(0, setpoint − core), bat_max_per_kg · weight ) [W]
Q_loss_eff = SA·[ h_radiative·(core − radiant_eff) + h_convective·(core − env_temp) ]
             + SA·evap_coeff·(1 − rel_humidity) + _loss_trim                     [W]
  SA = surface_area_k · weight^(2/3)              (Meeh surface area, m^2)
  radiant_eff = radiant_temp if set, else env_temp
dCore = (Q_prod − Q_loss_eff) / (weight · heat_capacity) · u                     [degC]
```

Neonates **cannot shiver**: below set-point they defend temperature by **non-shivering (brown-fat)
thermogenesis** (`brown_fat_heat`), a linear deficit term capped at `bat_max_per_kg · weight`. The
high neonatal surface-to-mass ratio (the Meeh `weight^(2/3)` term) is what makes them lose heat so
fast. A read-out-only `skin_temp = core_temp − skin_gradient` is also exposed.

## The auto-seed neutrality idiom

A neonate at rest is not in raw radiative/convective balance with a 32 °C incubator — clothing,
posture, nesting and insulation supply an offset the single-node geometry doesn't capture. Rather
than tune coefficients per scenario, the model **auto-seeds** it: at the first update after
`_warmup_delay` (5 s, to let the circuit settle), it sets

```
_loss_trim = Q_prod − q_loss_raw      (evaluated at core == setpoint)
```

so `Q_loss_eff == Q_prod` exactly and `dCore = 0`. The body is therefore **neutral at any baseline
weight, VO2, or env_temp the scenario ships with**, and only the *subsequent* change of
`env_temp` / `radiant_temp` / `rel_humidity` / VO2 moves the core. This is the same idiom as the
Hormones setpoint anchoring and the Kidneys TGF seed.

## Effectors (owned channels)

On each update `_apply_effectors()` maps core temperature to three channels, all default-neutral and
independent of `Ans` / `Drugs`:

| Channel | Mapping | Notes |
|---|---|---|
| `Metabolism.vo2_temp_factor` | `q10 ^ ((core − 37)/10)`, clamped `[vo2_temp_factor_min, vo2_temp_factor_max]` | **new** Q10 metabolic coupling; folds into `vo2_eff` |
| `Heart.hr_temp_factor` | `1 + hr_temp_gain·(core − setpoint)`, clamped `[hr_temp_factor_min, hr_temp_factor_max]` | drives a previously-dormant Heart channel (already summed into HR in `Heart.calc`) |
| `Blood.set_temperature(core)` | propagates core temp to **every** blood compartment | feeds the temperature (dT) term of the Stewart acid-base / O2-dissociation solver (`BloodComposition`) |

The master gate `thermoregulation_running` (default `true`), when set `false`, calls
`_release_channels()` **once** — resetting `vo2_temp_factor`/`hr_temp_factor` to `1.0` and
`Blood.set_temperature(37.0)` — then idles. This is the clean "off" switch; while enabled, manual
edits to those channels are overwritten each tick.

## Key parameters (defaults / units)

| Parameter | Default | Meaning |
|---|---|---|
| `env_temp` | `32.0 °C` | ambient air temperature (neutral-thermal incubator) |
| `radiant_temp` | `null` | radiant-warmer effective temp; `null` → use `env_temp` |
| `rel_humidity` | `0.5` | ambient relative humidity (fraction) — modulates evaporative loss |
| `setpoint_temp` | `37.0 °C` | hypothalamic set-point |
| `heat_capacity` | `3470 J/kg/K` | specific heat of body tissue |
| `surface_area_k` | `0.05` | Meeh constant in `SA = k·weight^(2/3)` |
| `h_radiative` / `h_convective` | `5.5` / `4.0 W/m²/K` | radiative / convective transfer coefficients |
| `evap_coeff` | `6.0 W/m²` per `(1−humidity)` | evaporative/respiratory loss coefficient |
| `caloric_equiv_o2` | `20.1 J/mL` | heat released per mL O2 consumed |
| `bat_gain` / `bat_max_per_kg` | `6.0 W/°C` / `4.5 W/kg` | brown-fat gain and ceiling |
| `q10` | `2.3` | Q10 of metabolic rate (per 10 °C) |
| `hr_temp_gain` | `0.1` | HR factor rise per °C above set-point (~10%/°C) |
| `vo2_temp_factor_min/max` | `0.5` / `2.5` | Q10 clamp |
| `hr_temp_factor_min/max` | `0.6` / `1.6` | HR-factor clamp |

Read-outs: `core_temp`, `skin_temp`, `heat_production`, `heat_loss`, `brown_fat_heat`,
`vo2_temp_factor`, `hr_temp_factor`.

## Risk note

The path **core → VO2 (Q10) → metabolic heat → core** is **positive feedback**: a warmer core raises
VO2 which raises heat production which warms the core further. It is bounded by the dominant heat-loss
limb (which grows ∝ `core − env_temp` and so always overtakes) plus the `vo2_temp_factor` clamp
`[0.5, 2.5]`. Keep the clamp in place when re-tuning `q10` or `caloric_equiv_o2`.

## See also
[`Metabolism`](./Metabolism.md) (VO2 source + the Q10 effector target) ·
[`Heart`](./Heart.md) (`hr_temp_factor` channel) ·
[`Blood`](./Blood.md) (`set_temperature` → acid-base / O2-dissociation) ·
[`Hormones`](./Hormones.md) (sibling controller / neutrality idiom).

````

### FILE: explain-engine/docs/TimeVaryingElastance.md

````markdown
# TimeVaryingElastance

A `TimeVaryingElastance` is a volume compartment whose stiffness **varies over the cardiac cycle** —
the base for contractile chambers (`HeartChamber`, `BloodTimeVaryingElastance`). Each step it
interpolates between a relaxed (diastolic) and a contracted (systolic) pressure–volume relation,
driven by an activation factor. It is the canonical implementation of the factor / effective-value
pattern for the dual-elastance case.

## Inheritance

```
BaseModelClass
  └── TimeVaryingElastance        (el_min/el_max, act_factor)
        ├── HeartChamber               (+ blood composition, ANS/MOB contractility)
        └── BloodTimeVaryingElastance  (+ blood composition)
```

See [BaseModelClass.md](./BaseModelClass.md) for the lifecycle contract and shared fields.

## What it models

A chamber whose recoil pressure swings between an end-diastolic curve (relaxed) and an end-systolic
curve (contracted) under an activation signal. With `act_factor = 0` it behaves like a passive
[`Capacitance`](./Capacitance.md) on its diastolic curve; with `act_factor = 1` it sits on its
systolic curve. This is the standard time-varying-elastance model of cardiac contraction.

## Properties

### Config / independent (set in the definition JSON)

| Property | Unit | Description |
|---|---|---|
| `u_vol` | L | Unstressed volume |
| `el_min` | mmHg/L | Minimal (end-diastolic) elastance — the EDPVR |
| `el_max` | mmHg/L | Maximal (end-systolic) elastance — the ESPVR |
| `el_k` | unitless | Non-linear elastance coefficient (diastolic curve only) |
| `pres_ext` | mmHg | External pressure applied this step (non-persistent; cleared each step) |
| `act_factor` | unitless | Activation factor (0 → 1), supplied by the `Heart` model |

Factor inputs (all default `1.0`) — see [Factor system](#factor-system):
`u_vol_factor`, `el_min_factor`, `el_max_factor`, `el_k_factor` (non-persistent);
`u_vol_factor_ps`, `el_min_factor_ps`, `el_max_factor_ps`, `el_k_factor_ps` (persistent);
`u_vol_factor_scaling_ps`, `el_min_factor_scaling_ps`, `el_max_factor_scaling_ps`,
`el_k_factor_scaling_ps` (scaling).

### Computed / dependent (engine outputs)

| Property | Unit | Description |
|---|---|---|
| `vol` | L | Current volume |
| `pres` | mmHg | Total pressure (`pres_in + pres_ext`) |
| `pres_in` | mmHg | Internal recoil pressure |
| `pres_tm` | mmHg | Transmural pressure (`pres_in − pres_ext`) |
| `el_min_eff` | mmHg/L | Effective minimal elastance after the factor layers |
| `el_max_eff` | mmHg/L | Effective maximal elastance after the factor layers |
| `u_vol_eff` | L | Effective unstressed volume after the factor layers |
| `el_k_eff` | unitless | Effective non-linear coefficient after the factor layers |

## Calculation cycle (`calc_model`)

Each step: `calc_elastances()` → `calc_volumes()` → `calc_pressure()`.

### `calc_elastances`

```
el_min_eff = el_min + (el_min_factor − 1)·el_min + (el_min_factor_ps − 1)·el_min + (el_min_factor_scaling_ps − 1)·el_min
el_max_eff = el_max + (el_max_factor − 1)·el_max + (el_max_factor_ps − 1)·el_max + (el_max_factor_scaling_ps − 1)·el_max
el_k_eff   = el_k   + (el_k_factor − 1)·el_k     + (el_k_factor_ps − 1)·el_k     + (el_k_factor_scaling_ps − 1)·el_k
```

It then clamps `el_max_eff` to be ≥ `el_min_eff`, and resets the non-persistent factors
`el_min_factor`, `el_max_factor`, `el_k_factor` to `1.0`.

### `calc_volumes`

```
u_vol_eff = u_vol + (u_vol_factor − 1)·u_vol + (u_vol_factor_ps − 1)·u_vol + (u_vol_factor_scaling_ps − 1)·u_vol
```

Then resets the non-persistent factor `u_vol_factor` to `1.0`.

### `calc_pressure`

```
p_ms = (vol − u_vol_eff) · el_max_eff                                  (end-systolic, linear)
p_ed = el_k_eff · (vol − u_vol_eff)² + el_min_eff · (vol − u_vol_eff)  (end-diastolic, non-linear)
pres_in = (p_ms − p_ed) · act_factor + p_ed
pres    = pres_in + pres_ext                                          (total)
pres_tm = pres_in − pres_ext                                          (transmural)
pres_ext := 0                                                         (external pressure is non-persistent)
```

`act_factor` runs `0 → 1` over a contraction: at 0 the chamber sits on its diastolic curve (`p_ed`), at
1 on its systolic curve (`p_ms`), interpolating linearly in between. The non-linear `el_k` term lives
only in the diastolic relation (the EDPVR stiffens at high filling), which is the physiologically
expected shape.

`act_factor` is supplied by the `Heart` model (the atrial/ventricular activation functions `aaf`/
`vaf`); see [HeartChamber.md](./HeartChamber.md) for the ANS/MOB contractility coupling layered on top
of `el_max`.

## Volume flow

`volume_in`/`volume_out` behave as in [Capacitance](./Capacitance.md): `volume_out` clamps at `0` and
returns the un-removed volume; subclasses extend `volume_in` to mix the incoming blood composition. The
`volume_out` negative-volume guard (`vol < 0 && vol < u_vol`) is functionally equivalent to `vol < 0`
for any non-negative `u_vol`. Heart chambers can fall below their unstressed volume during ejection
(ventricular suction), which the formula handles naturally.

## Factor system

Both elastances plus `el_k` and `u_vol` are **never used raw**. Each combines three multiplier layers
**additively against the base** into an `*_eff` value:

| Layer | Persistence | Set by |
|---|---|---|
| `<p>_factor` | reset to `1.0` every step | transient interventions |
| `<p>_factor_ps` | persistent | user / scenario / regulator models (ANS, MOB…) |
| `<p>_factor_scaling_ps` | persistent | `ModelScaler` (allometric/weight scaling) |

```
p_eff = p + (factor − 1)·p + (factor_ps − 1)·p + (factor_scaling_ps − 1)·p
```

Same pattern as [`Capacitance`](./Capacitance.md), applied to `el_min`, `el_max`, `el_k`, and `u_vol`.
Contractility interventions typically drive `el_max_factor_ps`.

## Example definition (JSON)

Plain `TimeVaryingElastance` is not instantiated directly in scenarios (the contractile subclasses are
used); a definition block carries the config fields below (factor fields default to `1.0` and are
usually omitted):

```json
{
  "name": "EXAMPLE_CHAMBER",
  "description": "contractile chamber",
  "model_type": "TimeVaryingElastance",
  "is_enabled": true,
  "vol": 0.015,
  "u_vol": 0.005,
  "el_min": 100,
  "el_max": 1500,
  "el_k": 0,
  "act_factor": 0
}
```

## Usage in the model

- The base for every contractile cardiac chamber: `HeartChamber` (LV/RV/LA/RA) and
  `BloodTimeVaryingElastance`.
- `el_max_factor_ps` is the primary contractility lever (used by ANS/MOB and scenario tuning);
  `el_min`/`el_min_factor_ps` set diastolic stiffness (e.g. for filling-pressure / CVP shaping).
- `act_factor` is written each step by the `Heart` model — do not set it statically.

````

### FILE: explain-engine/docs/Uterus.md

````markdown
# Uterus

The `Uterus` model turns the otherwise-passive uterine vascular bed (`UT_ART → UT_CAP → UT_VEN`)
into a living organ. Like [`Placenta`](./Placenta.md), [`MaternalPlacenta`](./MaternalPlacenta.md) and
`Kidneys`, it is a **controller / process model**: it extends `BaseModelClass`, owns no blood of its
own, and instead operates each step on the existing uterine compartments and resistors that
`Circulation` supplies. It does three things: (1) imposes a dedicated uterine oxygen consumption on
`UT_CAP`; (2) applies pregnancy adaptation — gestational-age scaling of bed resistance, unstressed
volume and VO₂ that grows uterine blood flow from ~50 mL/min toward 500–700 mL/min at term; and
(3) models uterine contractions / labor via a periodic intrauterine-pressure (IUP) waveform that
compresses and throttles the bed. It is calibration-neutral at its defaults (non-pregnant, no
contractions).

## Inheritance

```
BaseModelClass
  └── Uterus   (uterine bed controller: metabolism + pregnancy scaling + contractions)
```

## What it models

The uterine circulation is the bed `UT_ART → UT_CAP → UT_VEN`, fed by the inflow resistor
`AD_UT_ART` (off the abdominal aorta `AD`) and drained by `UT_VEN_VLB` (into the lower-body venous
bed `VLB`). `Uterus` does not hold blood; it modulates the components by reference name:

| Reference | Default name | Role |
|---|---|---|
| `_ut_art` | `UT_ART` | arteriolar inflow vessel |
| `_ut_cap` | `UT_CAP` | capillary — metabolism / gas-exchange site (myometrium) |
| `_ut_ven` | `UT_VEN` | venular outflow vessel |
| `_ut_in_res` | `AD_UT_ART` | inflow resistor — the uterine blood-flow source (read for flow) |
| `_ut_out_res` | `UT_VEN_VLB` | venular drainage resistor (owned by `VLB`; scaled here in pregnancy) |
| `_pl_mat` | `PL_MAT` | maternal placental pool — driven only when `couple_placenta` is on |

All references are resolved **lazily** in `calc_model()` (build-order independent), because the
Circulation compartments may be instantiated after this controller.

Three behaviours, all gated:

- **Uterine metabolism** — a dedicated uterine VO₂ (`ut_vo2`, mL O₂/kg/min) applied directly to
  `UT_CAP` using the same molar conversion as the whole-body `Metabolism` model
  (`0.039 mmol O₂/mL` at 37 °C). It is deliberately **not** registered in
  `Metabolism.metabolic_active_models`, so the calibrated whole-body VO₂ map is untouched and the
  uterus carries an independent, pregnancy-scalable O₂ demand.
- **Pregnancy adaptation** — `preg_ga` (pregnancy gestational age, weeks; distinct from the
  engine-level `model.gestational_age`, which is the mother's own birth GA) drives a linear ramp that
  drops bed resistance and raises unstressed volume + VO₂ from the non-pregnant baseline to term
  anchors, expanding uterine flow.
- **Contractions / labor** — a periodic IUP waveform (resting tone + half-sine contraction every
  `contraction_period` s) that throttles the bed by both physical compression (`pres_ext`) and a
  transient resistance rise (`r_factor`), with MVU / activity read-outs.

## Properties

### Config (independent — set in JSON)

| Property | Unit | Description |
|---|---|---|
| `uterus_running` | bool | Master gate for uterine organ function. When false, the pregnancy scaling layers this model owns are restored to 1.0 and outputs zeroed. |
| `ut_art_name` | string | Name of the arteriolar inflow vessel (`UT_ART`). |
| `ut_cap_name` | string | Name of the capillary / metabolism site (`UT_CAP`). |
| `ut_ven_name` | string | Name of the venular outflow vessel (`UT_VEN`). |
| `ut_in_res_name` | string | Name of the inflow resistor read for blood flow (`AD_UT_ART`). |
| `ut_out_res_name` | string | Name of the venular drainage resistor scaled in pregnancy (`UT_VEN_VLB`). |
| `met_active` | bool | Uterine O₂ consumption on/off. |
| `ut_vo2` | mL O₂/kg/min | Uterine oxygen use applied to `UT_CAP` (scenario-calibrated, ~25 % O2ER at baseline). |
| `vo2_factor` | unitless | Non-persistent VO₂ multiplier — reset to 1.0 every step (transient interventions). |
| `vo2_factor_ps` | unitless | Persistent VO₂ multiplier (interventions / scaling). |
| `resp_q` | unitless | Respiratory quotient (CO₂ produced / O₂ consumed). |
| `perfusion_factor` | unitless | Transient vaso-tone knob written to `UT_ART.r_factor`. <1 = vasodilation (more flow), >1 = vasoconstriction. |
| `pregnant` | bool | Master pregnancy gate (default false → preserves the non-pregnant calibration). |
| `preg_ga` | weeks | Pregnancy gestational age (0 = non-pregnant … 40 = term). |
| `preg_ga_threshold` | weeks | Below this GA the bed is treated as non-pregnant (no scaling). |
| `preg_ga_term` | weeks | GA anchor at which the term multipliers are reached. |
| `preg_res_term_factor` | unitless | Conduit (`UT_ART`/`UT_VEN`) resistance multiplier at term. |
| `preg_cap_res_term_factor` | unitless | `UT_CAP` (myometrium) resistance multiplier at term — dilates separately from the conduits. Defaults to the conduit factor unless overridden. |
| `preg_vol_term_factor` | unitless | Bed unstressed-volume multiplier at term (engorgement). |
| `preg_vo2_term_factor` | unitless | Uterine / conceptus VO₂ multiplier at term. |
| `couple_placenta` | bool | When pregnant and true, drive the `PL_MAT` pool gas content from uterine arterial blood. |
| `pl_mat_name` | string | Name of the maternal placental pool driven when coupling (`PL_MAT`). |
| `contractions_running` | bool | Master gate for contractions (default false → bed untouched). |
| `contraction_period` | s | Seconds between contraction onsets (active labor ≈ every 180 s / 3 min). |
| `contraction_duration` | s | Duration of each contraction's rise + fall. |
| `resting_tone` | mmHg | Baseline IUP between contractions. |
| `contraction_amplitude` | mmHg | Peak IUP above resting tone. |
| `contraction_pres_gain` | unitless (0..1) | Fraction of IUP applied as `pres_ext` to the bed. |
| `contraction_r_peak` | unitless (≥1) | Bed resistance multiplier at peak contraction. |

### Computed (dependent — read-outs)

| Property | Unit | Description |
|---|---|---|
| `ut_blood_flow` | mL/min | Smoothed uterine blood flow (EMA of the inflow resistor flow). |
| `ut_do2` | mL O₂/min | Oxygen delivery. |
| `ut_vo2_ml` | mL O₂/min | Oxygen uptake (rate). |
| `ut_o2er` | % | Oxygen extraction ratio, from the actual arterio-venous content difference. |
| `ut_avo2` | mmol/L | Arterio-venous O₂ content difference (whole-uterus). |
| `iup` | mmHg | Current intrauterine pressure. |
| `contraction_active` | bool | True while inside a contraction. |
| `montevideo_units` | — | MVU = peak amplitude × contractions per 10 min (labor adequacy). |

### Internal state (not config)

`_flow_ema` (smoothed inflow, L/s), `_flow_tc` (smoothing time constant, 5.0 s),
`_contraction_timer` (s elapsed within the current contraction cycle). `_t` is the modeling
step-size (s) inherited from the base.

## `calc_model()` — calculation cycle

After lazy reference resolution and the gating guards (`uterus_running`; presence of `UT_ART`,
`UT_CAP`, `UT_VEN`; and `UT_CAP.vol > 0`), the step runs in order:

### Pregnancy bed scaling

A normalised pregnancy progress `frac ∈ [0, 1]` is computed by `_preg_frac()`:

```
frac = 0                                                       if !pregnant or preg_ga ≤ preg_ga_threshold
frac = (preg_ga - preg_ga_threshold) / (preg_ga_term - preg_ga_threshold)   otherwise, clamped to 1
```

Term-anchored multipliers are then linearly interpolated from 1.0 (non-pregnant) toward each
`*_term_factor`:

```
res_factor     = 1 + frac · (preg_res_term_factor     - 1)   // conduits UT_ART / UT_VEN / drainage
cap_res_factor = 1 + frac · (preg_cap_res_term_factor - 1)   // UT_CAP (myometrium)
vol_factor     = 1 + frac · (preg_vol_term_factor     - 1)   // bed unstressed volume
```

These are written **every step** to the persistent scaling layers (idempotent — the engine
recomputes each `*_eff` from the base each step, so re-asserting never compounds):

```
UT_ART.r_factor_scaling_ps = UT_VEN.r_factor_scaling_ps = res_factor
UT_CAP.r_factor_scaling_ps = cap_res_factor
UT_ART/UT_CAP/UT_VEN.u_vol_factor_scaling_ps = vol_factor
UT_VEN_VLB.r_factor_scaling_ps = res_factor          // drainage resistor, if present
```

Scaling the `UT_VEN_VLB` drainage resistor matters: it is owned by `VLB` (which re-asserts its base
`r_for` each step), but its `r_factor_scaling_ps` layer is free. Without scaling it, the unscaled
drainage resistance becomes the dominant series resistor at term, capping flow at ~385 mL/min and
pinning `UT_VEN` pressure high.

### VO₂ scaling (tied to flow, not GA)

VO₂ expansion tracks the **flow** expansion (`~1/cap_res_factor`), not GA linearly — because flow is
convex in GA (flow ~ 1/R, R linear in GA), a GA-linear VO₂ would outpace perfusion mid-gestation and
push O2ER unphysiologically high:

```
flow_factor      = 1 / cap_res_factor
flow_factor_term = 1 / preg_cap_res_term_factor
preg_vo2 = 1 + ((flow_factor - 1) / (flow_factor_term - 1)) · (preg_vo2_term_factor - 1)   if flow_factor_term > 1
preg_vo2 = 1                                                                                otherwise
```

`preg_vo2` reaches `preg_vo2_term_factor` exactly when flow reaches its term expansion.

### Uterine contractions

When `contractions_running`, the cycle timer advances by `_t` and wraps at `contraction_period`. The
contraction intensity is a smooth half-sine over the active window, flat between contractions:

```
intensity = sin(π · _contraction_timer / contraction_duration)   for _contraction_timer < contraction_duration
intensity = 0                                                     otherwise
contraction_active = intensity > 0
iup = resting_tone + contraction_amplitude · intensity
```

The IUP throttles the bed two ways:

```
pres_ext += iup · contraction_pres_gain          // physical compression on UT_ART, UT_CAP, UT_VEN
contraction_r_factor = 1 + intensity · (contraction_r_peak - 1)   // controllable flow reduction
montevideo_units = contraction_amplitude · (600 / contraction_period)
```

When contractions are off, the timer/`iup`/`montevideo_units` are zeroed and `contraction_r_factor`
stays 1.0.

### Resistance composition (transient layer)

The transient perfusion knob and the contraction factor are written to the **non-persistent**
`r_factor` layer (the vessels reset it to 1.0 each step, so it is re-asserted every step):

```
UT_ART.r_factor = perfusion_factor · contraction_r_factor
UT_CAP.r_factor = contraction_r_factor
UT_VEN.r_factor = contraction_r_factor
```

### Uterine O₂ consumption / CO₂ production

When `met_active`, applied to `UT_CAP` (same molar conversion as `Metabolism`):

```
vo2_eff  = ut_vo2 · vo2_factor · vo2_factor_ps · preg_vo2                       (mL O₂/kg/min)
vo2_step = (O2_MMOL_PER_ML · vo2_eff · model.weight / 60) · _t                  (mmol per step)

UT_CAP.to2  = max(0, (to2·vol  − vo2_step)        / vol)
UT_CAP.tco2 = max(0, (tco2·vol + vo2_step·resp_q) / vol)
ut_vo2_ml   = vo2_eff · model.weight                                            (mL O₂/min)
```

with `O2_MMOL_PER_ML = 0.039`. `vo2_factor` is then reset to 1.0 (the non-persistent layer).

### Flow & oxygen read-outs

Inflow is exponentially smoothed (`_flow_tc = 5.0 s`, long enough to average several cardiac cycles)
to tame the pulsatile resistor flow:

```
alpha = _t / (_flow_tc + _t)
_flow_ema += (AD_UT_ART.flow − _flow_ema) · alpha
ut_blood_flow = _flow_ema · 60000                       (L/s → mL/min)

flow_l_min = _flow_ema · 60                             (L/s → L/min)
ut_do2  = (flow_l_min · UT_ART.to2) / O2_MMOL_PER_ML    (mL O₂/min)
ut_avo2 = UT_ART.to2 − UT_VEN.to2                       (mmol/L)
ut_o2er = (ut_avo2 / UT_ART.to2) · 100                  (%, 0 if UT_ART.to2 ≤ 0)
```

O2ER is derived from the actual content difference `(Ca − Cv)/Ca`, which is flow- and
VO₂-source-independent — important because `UT_VEN` is the **common outflow** of both the myometrial
(`UT_CAP`) and placental (`PL_IVS`, via [`MaternalPlacenta`](./MaternalPlacenta.md)) beds. At baseline
this equals the older VO₂/DO₂ form.

### Maternal-placental coupling

When `pregnant && couple_placenta`, the maternal placental pool `PL_MAT` gas content is driven from
uterine arterial blood so the placental maternal supply tracks uterine perfusion:

```
PL_MAT.to2  = UT_ART.to2
PL_MAT.tco2 = UT_ART.tco2
```

`Placenta` is the other writer of `PL_MAT`; its `skip_mat_gas_write` flag must be set so exactly one
model is authoritative per step. (Note: this is the legacy fixed `PL_MAT` pool of the fetal
[`Placenta`](./Placenta.md) — distinct from the perfused `PL_IVS` intervillous space owned by
[`MaternalPlacenta`](./MaternalPlacenta.md).)

### Helper methods

- `_preg_frac()` — normalised pregnancy progress, as above.
- `_reset_preg_scaling()` — restores the pregnancy scaling layers this model owns
  (`r_factor_scaling_ps`, `u_vol_factor_scaling_ps` on `UT_ART/UT_CAP/UT_VEN`, plus the drainage
  resistor's `r_factor_scaling_ps`) to 1.0; called when `uterus_running` is false so disabling the
  organ doesn't strand the scaled bed.
- `_zero_outputs()` — zeroes all read-outs (used when gated off or `UT_CAP.vol ≤ 0`).

## Factor system

`Uterus` is a controller, so it does not carry the `el_*`/`r_*` factor triplets itself — instead it
**writes into** the factor layers of the bed components it controls, and the math above relies on
those layers being disjoint so they compose multiplicatively:

| Layer it writes | On | Purpose |
|---|---|---|
| `r_factor_scaling_ps` | `UT_ART`, `UT_CAP`, `UT_VEN`, `UT_VEN_VLB` | persistent pregnancy resistance scaling (idempotent each step) |
| `u_vol_factor_scaling_ps` | `UT_ART`, `UT_CAP`, `UT_VEN` | persistent pregnancy volume (engorgement) scaling |
| `r_factor` (non-persistent) | `UT_ART`, `UT_CAP`, `UT_VEN` | transient `perfusion_factor` × contraction resistance, re-asserted each step |
| `pres_ext` (additive) | `UT_ART`, `UT_CAP`, `UT_VEN` | contraction physical compression, re-added each step |

These layers are deliberately disjoint from the ANS (`ans_*`), the SVR layer (`r_factor_ps`) and each
other, so the uterine controller stacks cleanly on top of the rest of the circulation. For its own
metabolism, `Uterus` exposes the standard `vo2_factor` (non-persistent, reset each step) /
`vo2_factor_ps` (persistent) pair on the VO₂ rate.

## Example definition (JSON)

From `adult_female_uterus.json` (`model_definition.models.Uterus`):

```json
{
  "name": "Uterus",
  "description": "uterine organ: perfusion + oxygen consumption read-outs",
  "is_enabled": true,
  "model_type": "Uterus",
  "components": {},
  "uterus_running": true,
  "ut_art_name": "UT_ART",
  "ut_cap_name": "UT_CAP",
  "ut_ven_name": "UT_VEN",
  "ut_in_res_name": "AD_UT_ART",
  "ut_out_res_name": "UT_VEN_VLB",
  "met_active": true,
  "ut_vo2": 0.04,
  "vo2_factor": 1,
  "vo2_factor_ps": 1,
  "resp_q": 0.8,
  "perfusion_factor": 1,
  "pregnant": false,
  "preg_ga": 0,
  "preg_ga_threshold": 4,
  "preg_ga_term": 40,
  "preg_res_term_factor": 0.083,
  "preg_cap_res_term_factor": 0.43,
  "preg_vol_term_factor": 3,
  "preg_vo2_term_factor": 2,
  "couple_placenta": false,
  "pl_mat_name": "PL_MAT",
  "contractions_running": false,
  "contraction_period": 180,
  "contraction_duration": 60,
  "resting_tone": 8,
  "contraction_amplitude": 50,
  "contraction_pres_gain": 0.6,
  "contraction_r_peak": 2
}
```

At these defaults (non-pregnant, contractions off) the bed runs at its calibrated baseline:
`ut_blood_flow ≈ 49 mL/min`, `ut_vo2_ml = 2.4 mL O₂/min`, `ut_o2er ≈ 28 %`. Note this scenario
overrides `preg_cap_res_term_factor` to `0.43` (so the myometrial capillary stays a modest minority
of uterine flow once a maternal placenta carries the dominant share) and `preg_vo2_term_factor` to
`2` rather than the constructor defaults of `0.083` / `8.0`.

## Usage in the model

- **Scenario:** `adult_female_uterus.json` (the maternal/pregnancy line built on `adult_female`).
- **Bed it drives:** the `UT_ART → UT_CAP → UT_VEN` uterine vascular bed, fed by `AD_UT_ART` (off the
  abdominal aorta) and drained by `UT_VEN_VLB` (into the lower-body venous bed).
- **Couples to** [`MaternalPlacenta`](./MaternalPlacenta.md): both organs read pregnancy progress from
  the same `preg_ga`, and `UT_VEN` is the common outflow of both the myometrial (`UT_CAP`) and
  placental intervillous (`PL_IVS`) beds, so the whole-uterus O2ER read-out stays correct once the
  placenta carries flow. `MaternalPlacenta` reads `Uterus.preg_ga`, `Uterus.pregnant` and
  `Uterus.iup` (for spiral-artery dilation and contraction compression) — `Uterus` is the single
  source of truth for pregnancy state.
- **Distinct from** the fetal [`Placenta`](./Placenta.md): `Placenta` models the **fetal** side
  (umbilical circulation + the fixed `PL_MAT` reservoir); `Uterus` and `MaternalPlacenta` model the
  **maternal** uterine circulation. When `couple_placenta` is enabled, `Uterus` drives the legacy
  `PL_MAT` pool from uterine arterial blood.

````

### FILE: explain-engine/docs/Ventilator.md

````markdown
# Ventilator

The `Ventilator` device model simulates a **mechanical ventilator** that drives the patient's lungs
through an endotracheal (ET) tube. It owns a small gas circuit — a fresh-gas reservoir, the patient
circuit, an expiratory (PEEP) reservoir, and the inspiratory/expiratory valves plus the ET-tube
resistor — and modulates those parts every step to deliver the configured ventilation mode (`PC`,
`PRVC`, `PS`, or `CPAP`). Pressures are entered in cmH₂O and converted to the engine's mmHg
internally.

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

- An ET-tube-coupled mechanical ventilator with four modes: pressure control (`PC`), pressure-regulated
  volume control (`PRVC`), pressure support (`PS`), and continuous positive airway pressure (`CPAP`).
- Time-cycled (`PC`/`PRVC`) and flow-cycled (`PS`) breath delivery, with optional patient
  synchronization (trigger detection off the `Breathing` model).
- A flow- and diameter-dependent ET-tube resistance (turbulent tube behaviour).
- Per-breath read-outs: tidal volumes, minute volume, dynamic compliance, end-tidal CO₂.

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

References to all six are cached in `init_model` and held in `_ventilator_parts` for batch enable/disable.

## Properties

### Configuration (independent)

| Property | Unit | Description |
|---|---|---|
| `pres_atm` | mmHg | Atmospheric reference pressure (default 760) |
| `fio2` | fraction | Fraction of inspired O₂ for the fresh gas (default 0.205) |
| `humidity` | fraction | Fresh-gas relative humidity (default 1.0) |
| `temp` | °C | Fresh-gas temperature (default 37) |
| `ettube_diameter` | mm | ET-tube inner diameter (default 4); drives the `_a`/`_b` resistance coefficients |
| `ettube_length` | mm | ET-tube length (default 110); scales resistance by `length/110` |
| `vent_mode` | string | `PC` / `PRVC` / `PS` / `CPAP` (default `PRVC`) |
| `vent_rate` | breaths/min | Mechanical rate (default 40) |
| `tidal_volume` | L | Target tidal volume for PRVC (default 0.015) |
| `insp_time` | s | Inspiratory time (default 0.4) |
| `insp_flow` | L/min | Inspiratory flow setting (default 12) |
| `exp_flow` | L/min | Expiratory flow setting (default 3; not used in the current math) |
| `pip_cmh2o` | cmH₂O | Peak inspiratory pressure target (default 14) |
| `pip_cmh2o_max` | cmH₂O | PIP ceiling for PRVC auto-regulation (default 14) |
| `peep_cmh2o` | cmH₂O | Positive end-expiratory pressure / CPAP level (default 3) |
| `trigger_volume_perc` | % | Trigger volume as a percent of `tidal_volume` (default 6) |
| `synchronized` | bool | Enable patient-trigger detection (default false; ignored in CPAP) |

### Computed (dependent) read-outs

| Property | Unit | Description |
|---|---|---|
| `pres` | cmH₂O | Airway pressure = `(VENT_GASCIRCUIT.pres − pres_atm) · 1.35951` |
| `flow` | L/min | ET-tube flow `× 60` |
| `vol` | mL | Volume integrated from ET-tube flow over the current breath (reset each inspiration) |
| `exp_time` | s | Expiratory time = `60/vent_rate − insp_time` |
| `trigger_volume` | L | Trigger threshold = `(tidal_volume/100) · trigger_volume_perc` |
| `minute_volume` | L/min | `exp_tidal_volume · vent_rate` (CPAP uses the patient's spontaneous rate instead) |
| `compliance` | mL/cmH₂O | Dynamic compliance, measured per breath at end-expiration |
| `resistance` | — | Left as `null` (placeholder; see notes) |
| `exp_tidal_volume` | L | Expired tidal volume (per breath) |
| `insp_tidal_volume` | L | Inspired tidal volume (per breath) |
| `tv_kg` | mL/kg | Expired tidal volume per kg (`exp_tidal_volume·1000 / weight`) |
| `ncc_insp` | counter | Ventilator inspiration step counter (see breath cycle counters) |
| `ncc_exp` | counter | Ventilator expiration step counter |
| `etco2` | mmHg | End-tidal CO₂, sampled from `DS.pco2` at each new inspiration |
| `co2` | mmHg | Current dead-space CO₂ (`DS.pco2`) |
| `triggered_breath` | bool | True once a patient-triggered/synchronized breath has been armed |

### Internal (`_`-prefixed)

`_pip`/`_pip_max`/`_peep` are the cmH₂O targets converted to mmHg. `_a`/`_b` are the ET-tube
resistance coefficients derived from diameter. `_insp_time_counter`/`_exp_time_counter`,
`_insp_tidal_volume_counter`/`_exp_tidal_volume_counter`, `_trigger_volume_counter`, `_inspiration`,
`_expiration`, `_peak_flow`, `_prev_et_tube_flow`, `_trigger_blocked`, `_trigger_start`,
`_tv_tolerance` (0.0005 L), `_et_tube_resistance`, and the `_vent_*` sub-model references back the
cycling/triggering logic.

## Calculation cycle (`calc_model`)

1. Convert `pip_cmh2o` / `pip_cmh2o_max` / `peep_cmh2o` to mmHg (`÷ 1.35951`) into `_pip`/`_pip_max`/`_peep`.
2. If `synchronized` **and** not CPAP, run `triggering()`.
3. Dispatch on `vent_mode`:
   - `PC` / `PRVC` → `time_cycling()` then `pressure_control()`
   - `PS` → `flow_cycling()` then `pressure_control()`
   - `CPAP` → `cpap_control()`
4. Publish read-outs: airway `pres`, `flow` (ET-tube flow × 60), integrate `vol`, sample `co2` from
   `DS`, set `minute_volume` (except in CPAP, which reports a spontaneous minute volume), and refresh
   the ET-tube resistance.

### Breath cycle counters (`ncc_insp` / `ncc_exp`)

The ventilator tracks its breath phase on the **instance** counters `this.ncc_insp` and
`this.ncc_exp`. Each cycling routine sets a counter to `-1` at the first step of a new phase and then
increments it every subsequent step, so a value of `1` marks the first full step of inspiration /
expiration (the same `ncc === 1` convention the `Breathing` model uses for spontaneous breaths).

> Drift note: the engine `model` object also initializes `model.ncc_ventilator_insp` and
> `model.ncc_ventilator_exp` (in `ModelEngine.build`), but the current `Ventilator` does **not** read
> or write those — it drives its own `ncc_insp`/`ncc_exp`. The engine-level counters are reserved/
> vestigial for the ventilator.

### `time_cycling` (PC / PRVC)

Recomputes `exp_time = 60/vent_rate − insp_time`. When `_insp_time_counter` exceeds `insp_time`, it
closes inspiration (latches `insp_tidal_volume`, sets `_expiration`). When `_exp_time_counter` exceeds
`exp_time`, it opens a new inspiration: resets `vol`, latches `exp_tidal_volume`, samples `etco2` and
`tv_kg` from `DS`/weight, and computes per-breath `compliance`:

```
compliance = 1 / ( (_pip − _peep)·1.35951 / (exp_tidal_volume·1000) )      [mL/cmH₂O]
```

In PRVC it then calls `pressure_regulated_volume_control()`. The active phase advances its counter
each step and toggles `_trigger_blocked`.

### `flow_cycling` (PS)

Pressure support begins only after a triggered breath. While ET-tube flow is rising it stays in
inspiration and tracks `_peak_flow`; when flow falls below **30 % of peak** it cycles to expiration
and clears `triggered_breath`. Negative ET-tube flow with no active triggered breath integrates the
expiratory tidal volume.

### `pressure_control`

- **Inspiration** — close `VENT_EXP_VALVE`, open `VENT_INSP_VALVE` with
  `r_for = (VENT_GASIN.pres + _pip − pres_atm − _peep) / (insp_flow/60)`; shut the inspiratory valve
  again once `VENT_GASCIRCUIT.pres` exceeds PIP; integrate inspiratory tidal volume from positive ET-tube flow.
- **Expiration** — close `VENT_INSP_VALVE`, open `VENT_EXP_VALVE` (`r_for = 10`), and pin the
  expiratory reservoir volume to hold PEEP (`vol = _peep/el_base + u_vol`); integrate expiratory tidal
  volume from negative ET-tube flow.

### `cpap_control` (CPAP / PS coupling to spontaneous breathing)

CPAP holds the circuit at the CPAP level (= `peep_cmh2o`) and lets the patient breathe spontaneously
through the ET tube — **both valves stay open**. The inspiratory valve feeds fresh gas toward the
CPAP target and shuts off at/above it; the expiratory reservoir is pinned so the circuit floats at
CPAP. Tidal volumes are accumulated from ET-tube flow and closed out at each spontaneous inspiration
start (`Breathing.ncc_insp === 1`); `minute_volume = exp_tidal_volume · Breathing.resp_rate`.

> CPAP only ventilates a *spontaneously breathing* patient: with `Breathing` disabled it holds the
> pressure but delivers no tidal volume, as in reality. This is the half of the
> **CPAP/PS-via-ET-tube** coupling owned by the ventilator; the other half lives in `Breathing` (see
> below).

### `pressure_regulated_volume_control` (PRVC auto-PIP)

At each expiration, nudge `pip_cmh2o` by ±1 cmH₂O toward `tidal_volume` (within `_tv_tolerance`),
clamped between `peep_cmh2o + 2` and `pip_cmh2o_max`.

### `triggering` (synchronized modes)

Sets `trigger_volume = (tidal_volume/100)·trigger_volume_perc`. When `Breathing.ncc_insp === 1` and
the trigger is not blocked, it arms `_trigger_start` and integrates ET-tube flow; once the integrated
volume exceeds `trigger_volume` it forces the breath (`_exp_time_counter = exp_time`) and sets
`triggered_breath = true`.

## Coupling to `Breathing` (active airway inlet)

`Breathing` measures airway-opening flow **route-agnostically**: it sums `MOUTH_DS.flow` (natural
airway) and `VENT_ETTUBE.flow` (ET tube), each only when that inlet is enabled and not blocked. With
the ventilator off, `VENT_ETTUBE` is disabled so the sum collapses to `MOUTH_DS` (the spontaneous
baseline). When the ventilator is on, `switch_ventilator(true)` blocks `MOUTH_DS` (`no_flow = true`),
so `Breathing` reads `VENT_ETTUBE` instead — which is why the tidal-volume feedback loop keeps working
during CPAP/PS of an intubated, spontaneously breathing patient.

## ET-tube resistance (`calc_ettube_resistance`)

```
R = (a·flow + b) · (ettube_length / 110)        floored at 15
a = −2.375·d + 11.9375
b = −14.375·d + 65.9374        (d = ettube_diameter, from set_ettube_diameter)
```

Resistance is flow- and diameter-dependent (turbulent tube behaviour) and is written onto
`VENT_ETTUBE.r_for` / `r_back` each step. `set_ettube_diameter` requires `d > 1.5`;
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
| `switch_ventilator(state)` | Enable/disable the device and all `_ventilator_parts`; sets `no_flow = !state` on each part; blocks `MOUTH_DS` (`no_flow = state`); resets read-outs when turned off |
| `set_pc(pip, peep, rate, t_in, insp_flow)` | Configure PC mode |
| `set_prvc(pip_max, peep, rate, tv, t_in, insp_flow)` | Configure PRVC (`tv` in mL → L) |
| `set_psv(pip, peep, rate, t_in, insp_flow)` | Configure PS mode |
| `set_cpap(cpap, insp_flow)` | Configure CPAP (`cpap` → `peep_cmh2o`) |
| `set_fio2(new_fio2)` | Re-derive fresh-gas composition (accepts a fraction or a percentage > 20) |
| `set_humidity(new_humidity)` / `set_temp(new_temp)` | Re-derive fresh-gas composition |
| `set_ettube_diameter(d)` / `set_ettube_length(l)` | Update tube geometry → resistance |
| `trigger_breath(...)` | Force the next breath by expiring the current one (its `pip`/`peep`/… arguments are ignored) |

## Example definition (JSON)

A typical neonatal ventilator block (from `term_neonate.json`), trimmed to the device-level fields —
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

## Usage in the model

- One `Ventilator` per scenario; disabled at rest so the patient breathes spontaneously through
  `MOUTH_DS`. Turn it on with `switch_ventilator(true)` and pick a mode with `set_pc` / `set_prvc` /
  `set_psv` / `set_cpap`.
- The [`Resuscitation`](./Resuscitation.md) model drives the ventilator during CPR (`switch_cpr`
  starts it in PC and pulses `trigger_breath()` for the ventilation pauses).
- The [`Breathing`](./Breathing.md) model reads `VENT_ETTUBE` as its airway inlet whenever the
  ventilator has blocked `MOUTH_DS`, so spontaneous tidal-volume feedback continues during CPAP/PS.

## Notes & caveats

- **`compliance` is per-breath, in mL/cmH₂O**, measured at end-expiration; it is *not* recomputed
  every step (an earlier every-step formula used inconsistent units and was removed).
- **`resistance` is left as `null`** in `calc_model` — a placeholder; the meaningful airway resistance
  is `_et_tube_resistance` / `VENT_ETTUBE.r_for`.
- **`trigger_breath(...)` ignores its arguments**; it only forces the current breath to expire.
- **External-model references are null-safe.** `DS` (et/CO₂), `MOUTH_DS` (mouth blocking) and the
  `Breathing` model (trigger) are guarded with `?.`; the `VENT_*` sub-models are the ventilator's own
  components and are assumed present after build.
- **`exp_time = 60/vent_rate − insp_time` can go negative** if `insp_time` exceeds the breath period
  at very high rates — a configuration error, not guarded.

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
- **TGA outflow tracts are pre-wired but disabled** in `term_neonate.json`: `RV_AA` (RV→AA, `is_enabled: false`) and `LV_PA` (LV→PA, `is_enabled: false`), alongside the normal `RV_PA` and `LV_AA`.

### A. Duct-dependent pulmonary blood flow

In these lesions the right-heart outflow to the lungs is obstructed or absent, so pulmonary blood flow arrives **backwards through the duct** (aorta → PDA → pulmonary artery). Ductal closure causes profound, oxygen-resistant cyanosis.

- **A1 — Pulmonary atresia with intact ventricular septum (PA-IVS).** *Also FO-dependent.* The RV outflow is blind; lungs are fed only by the PDA, and all systemic venous return must cross the foramen ovale right→left to reach the left heart. RV and tricuspid valve are hypoplastic; ~10% have an RV-dependent coronary circulation, the key risk modifier (Chikkabyrappa 2018 [#9]; Jaggers AATS consensus 2025 [#10]).
  *Engine:* `RV_PA.no_flow = true`; `Pda.diameter_relative > 0`; `Shunts.diameter_fo > 0` (R→L); RV hypoplasia via `Heart.components.RV` `el_min`↑ / `u_vol`. **Fully buildable.**
  **✅ BUILT** as `pa_ivs` — `scripts/_make_paivs.mjs` → `reseed_paivs.mjs` → `probe_paivs.mjs`. Calibrated: **zero antegrade flow** (atretic `RV_PA`), the **duct is the sole pulmonary supply** (≈ 590 mL/min, aorta→PA L→R), a **suprasystemic hypertensive blind RV** (peak ≈ 70 mmHg) that decompresses only through a restrictive **tricuspid-regurgitation jet** (≈ 500 mL/min — its single outlet), and an **obligate R→L FO** (≈ 500 mL/min = the whole systemic venous return) feeding the LV-only output → cyanosis (SpO₂ ≈ 74%, pO₂ ≈ 32 mmHg), MAP preserved at 50. Levers: `RV_PA.no_flow` (atresia, not stenosis — contrast `critical_ps`), `diameter_vsd: 0` (intact septum), RV hypoplasia (`el_min: 2500`, `u_vol: 0.002`), **tricuspid regurgitation** (`RAIVCI_RV`/`RASVC_RV` `no_back_flow: false`, `r_back: 5000` — a restrictive r_back lets the blind RV pressurize to suprasystemic levels yet stay volume-stable; free TR leaves it flaccid at ~12 mmHg, no TR traps volume), `diameter_fo: 6` (left at baseline `fo_lr_factor: 25` — R→L easy), `Pda.diameter_relative: 1.0`. Left heart structurally normal → no engine change. RV-dependent coronary circulation (sinusoids, ~10% of cases) not modeled.

- **A2 — Pulmonary atresia with VSD.** Lungs fed by the PDA and/or major aortopulmonary collateral arteries (MAPCAs). With a VSD the RV decompresses into the LV/aorta (Soquet 2019 [#11]; Presnell 2015 [#12]).
  *Engine:* `RV_PA.no_flow = true`; `Shunts.diameter_vsd > 0`; `Pda` open. **Buildable without MAPCAs** — collateral vessels are not modelable (see [limitations](#3-engine-lever-summary--limitations)).
  **✅ BUILT** as `pa_vsd` — `scripts/_make_pavsd.mjs` → `reseed_pavsd.mjs` → `probe_pavsd.mjs`. Calibrated: **zero antegrade flow** (atretic `RV_PA`), a large VSD lets the **RV decompress into the LV/aorta** (`diameter_vsd: 5`, VSD flow RV→LV ≈ 450 mL/min, **RV/LV peaks equilibrated at 71/70 mmHg** — *not* a blind hypertensive RV, contrast PA-IVS), so the atrial septum stays intact (`diameter_fo: 0` — **not** FO-dependent); the **duct is the sole pulmonary supply** (`Pda.diameter_relative: 1.0`, fat 4 mm duct, ≈ 750 mL/min, no MAPCAs), mixed aortic blood → cyanosis (SpO₂ ≈ 78%, pO₂ ≈ 34), MAP 47. **Profoundly duct-dependent** — closing the duct crashes SpO₂ to ≈ 14% (the duct is the *only* pulmonary flow). *Calibration:* both ventricles eject into one aortic outlet, which the lumped model over-pumps, so `Heart.cont_factor_left/right: 0.6` normalizes the combined systemic output (a geometry compensation, not intrinsic weakness). Left heart normal → no engine change. **Limitation:** MAPCAs (a real alternative pulmonary supply) are not modelable — so duct closure here is more catastrophic than a MAPCA-supplied patient.

- **A3 — Critical pulmonary stenosis.** Severe but not complete RVOT obstruction; duct-dependent when critical. A right→left atrial "pop-off" across the FO offloads the pressured RA (Latson 2001 [#13]; Aggarwal 2018 [#14]).
  *Engine:* `RV_PA.r_for`↑ (stenosis, keep some antegrade flow); `Pda` open; `Shunts.diameter_fo` for the atrial pop-off. **Fully buildable.**
  **✅ BUILT** as `critical_ps` — `scripts/_make_cps.mjs` → `reseed_cps.mjs` → `probe_ps.mjs`. Calibrated: **suprasystemic, pressure-loaded RV** (peak ≈ 110 mmHg) with an 84 mmHg trans-valvular gradient and a low post-stenotic PA; antegrade flow is a trickle (≈ 180 mL/min) while the **duct supplies the majority of pulmonary flow** (≈ 310 mL/min, aorta→PA L→R — close it and pulmonary flow halves); a **right→left FO pop-off** (≈ 340 mL/min) drives cyanosis (SpO₂ ≈ 77%, pO₂ ≈ 33 mmHg), systemic MAP preserved. Levers: `RV_PA.r_for: 8000` (patent — not atretic), `Heart.cont_factor_right: 0.6` (the pressure-loaded RV beginning to fail — keeps the peak realistic and deepens the pop-off), `Pda.diameter_relative: 0.7`, `diameter_fo: 5`. *Note:* the FO is left at the baseline `fo_lr_factor: 25` — its fetal-flap asymmetry already makes R→L easy, exactly the direction this lesion needs (contrast HLHS/TGA, which need `fo_lr_factor ≈ 1`). Left heart structurally normal → no engine change. *Modeling caveat:* the linear-resistance valve + time-varying-elastance RV trade peak pressure against antegrade flow, so the realistic peak comes via a mildly failing RV rather than a 200 mmHg hypercontractile one.

- **A4 — Tricuspid atresia (with pulmonary stenosis/atresia).** *Also FO-dependent.* The tricuspid valve is absent, so **all** systemic venous return is obligated right→left across the FO into the LA; the functionally single LV then supplies the body, while pulmonary flow comes via a VSD and/or the duct (Sumal 2020 [#15]). A restrictive atrial septum is poorly tolerated.
  *Engine:* `RA_RV.no_flow = true`; `Shunts.diameter_fo` (obligate R→L); `Shunts.diameter_vsd`; RV hypoplasia; `Pda` if pulmonary atresia / severe PS. **Buildable** (functionally single LV).
  **✅ BUILT** as `tricuspid_atresia` (type Ib — normally related great arteries, restrictive VSD + pulmonary stenosis, the cyanotic reduced-pulmonary-flow form) — `scripts/_make_ta.mjs` → `reseed_ta.mjs` → `probe_ta.mjs`. Calibrated: **obligate FO R→L** (≈ 500 mL/min = the whole systemic venous return), the **single LV** as the only pump (CO ≈ 0.78 L/min), pulmonary flow reaching the lungs only via the **VSD→RV→PA route** (≈ 465 mL/min — the hypoplastic RV acts as a conduit, so VSD flow ≈ antegrade Qp) **supplemented duct-dependently** (duct L→R ≈ 300 mL/min; closing the duct drops SpO₂ 80→74%), cyanosis (SpO₂ ≈ 80%, pO₂ ≈ 35 mmHg), MAP 49 / PAP 33. Levers: the split tricuspid `RAIVCI_RV` + `RASVC_RV` `no_flow` (atresia), RV hypoplasia (`el_min: 2200`, `u_vol: 0.0025`, VSD-fed), `diameter_fo: 6` (baseline `fo_lr_factor: 25` → R→L easy), `diameter_vsd: 2` (restrictive) + `RV_PA.r_for: 800` (pulmonary stenosis) + `Pda.diameter_relative: 0.8`. Left heart normal → no engine change (single LV uses the normal cycle path). Cross-listed as a Category-D (FO-dependent) teaching case.

- **A5 — Tetralogy of Fallot with pulmonary atresia / severe RVOT obstruction.** Large VSD with an overriding aorta; in the pulmonary-atresia form, pulmonary flow is duct- (±MAPCA-) dependent (Miller AATS consensus 2022 [#18]; Bailliard 2009 [#19]).
  *Engine:* large `Shunts.diameter_vsd`; `RV_PA.no_flow` or high `r_for`; high PVR; `Pda` open. **Partially buildable** — *aortic override* (the aorta straddling both ventricles) is not directly representable; approximate the right-to-left streaming through the VSD.

- **A6 — Severe (neonatal) Ebstein anomaly with functional pulmonary atresia.** Massive tricuspid regurgitation plus high PVR leaves the RV unable to open the pulmonary valve, so pulmonary flow becomes duct-dependent; much of the RV is "atrialized" (Luxford 2017 [#20]; Linnenbank 2025 [#21]).
  *Engine:* `RA_RV.r_back`↓ (tricuspid regurgitation), `Heart` RV contractility↓, `RV_PA` functionally closed, `Pda` open. **Partially buildable** — the *atrialized RV* cannot be represented as a separate chamber (fixed chamber set); approximate with TR + a weak RV.

### B. Duct-dependent systemic blood flow

Here the left-heart outflow to the body is obstructed or absent, so systemic perfusion arrives **right→left through the duct** (pulmonary artery → PDA → descending aorta). Ductal closure causes cardiogenic shock that mimics sepsis.

- **B1 — Hypoplastic left heart syndrome (HLHS).** *Also FO-dependent.* The LV cannot support the systemic circulation; the entire cardiac output is delivered by the RV → PDA → aorta, perfusing the arch and coronaries **retrograde**. Pulmonary venous return is obligated left→right across the FO. An intact or highly restrictive atrial septum is a lethal combination requiring emergent decompression (Connor 2007 [#22]; Schranz duct-stenting 2024 [#23]; Vlahos 2004 [#26]; Generali 2022 [#27]).
  *Engine:* `LV_AA.no_flow` or severe `r_for`↑ + LV hypoplasia (reuse the `cdh_lv_dysfunction` LV levers: `Heart.cont_factor_left`, LV `el_min` / `u_vol`); `LA_LV.no_flow` or high `r_for` (mitral atresia/stenosis); `Shunts.diameter_fo` L→R; `Pda` carrying R→L (PA→AAR; the `AAR_DA` resistor is bidirectional). The *restrictive/intact-septum* variant (`diameter_fo → 0`) is a high-value teaching toggle.
  **✅ BUILT** as `hlhs` (mitral + aortic atresia → LV fully excluded) — `scripts/_make_hlhs.mjs` → `reseed_hlhs.mjs` → `probe_hlhs.mjs`. Calibrated single-RV parallel circulation: RV output ≈ 1.2 L/min split **Qp:Qs ≈ 1.7** (mild pulmonary over-circulation, the typical balance), systemic Qs ≈ 0.46 L/min via the duct (PA→aorta, R→L), **retrograde aortic-arch and coronary perfusion** (AAR→AA), obligate FO L→R ≈ 0.75 L/min, moderate cyanosis (SpO₂ ≈ 78%, pO₂ ≈ 34 mmHg), PAP > MAP (RV is the systemic pump). Levers: mitral+aortic atresia, `diameter_fo: 6` / `fo_lr_factor: 1`, `Pda.diameter_relative: 1.0` with a fat 4 mm duct, hypoplastic AA (`u_vol ×0.6`, `el_base ×1.4`), **pulmonary arteriolar resistance ×2 to balance Qp:Qs** (at baseline PVR the lungs steal the output → Qp:Qs ≈ 3.5, systemic hypoperfusion — itself a teaching failure mode). A second engine generalization was needed: `Heart.calc_model` now derives the cardiac cycle from the ventricular activation window when the LV has *no* outflow (aortic atresia → both `LV_AA` and `LV_PA` disabled), so the single-RV physiology keeps a valid cycle (and `HeartFunction` inputs); identity for any heart with a working LV outflow (normal, TGA, tricuspid atresia, PA-IVS).
  **✅ Restrictive/intact-septum variant BUILT** as `hlhs_restrictive` (same builder, only the atrial lever differs: `diameter_fo: 1`). The atrial communication is too small to pass the whole pulmonary venous return, so the LA cannot decompress: **LA pressure rises to ≈ 21 mmHg** (vs 4.5 open — a ≈ 19 mmHg trans-septal gradient = severe pulmonary venous hypertension), the obligate shunt is choked (≈ 420 vs 750 mL/min), single-RV preload/output fall (≈ 0.8 vs 1.2 L/min), and hypoxaemia is severe (**SpO₂ ≈ 64%, pO₂ ≈ 28 mmHg, pH ≈ 7.30**) — the lethal emergency needing immediate atrial decompression (balloon/blade septostomy or stenting). It remains a stable steady state because the septum is restrictive, not fully intact (`diameter_fo → 0` would trap the LA entirely and collapse). Alveolar oedema is not separately modeled — the hypoxaemia arises from the reduced pulmonary flow + obligatory mixing.

- **B2 — Critical aortic stenosis.** The LV cannot eject across the valve, so systemic perfusion becomes duct-dependent; high LV wall stress impairs coronary perfusion and drives LV dysfunction (Affolter 2014 [#24]).
  *Engine:* `LV_AA.r_for`↑; LV strain via the existing `HeartFunction` load-induced contractility model; `Pda` open. **Fully buildable.**
  **✅ BUILT** as `critical_as` — `scripts/_make_cas.mjs` → `reseed_cas.mjs` → `probe_as.mjs`. Calibrated (left-sided mirror of `critical_ps`): **pressure-loaded, failing LV** (peak ≈ 127 mmHg, 83 mmHg trans-valvular gradient — a low-flow/low-gradient state) with reduced antegrade aortic flow (≈ 190 mL/min) while the **duct supplies ~40% of systemic flow** (R→L ≈ 125 mL/min, PA→aorta — close it → systemic shock); **differential cyanosis** (pre-ductal SpO₂ ≈ 96% from the LV-fed upper body vs post-ductal ≈ 85% from the duct-fed lower body); mild LA congestion (≈ 7.5 mmHg) decompressing L→R across the FO; low MAP (≈ 39) with compensatory tachycardia — the decompensating low-output picture. Levers: `LV_AA.r_for: 8000` (patent — not atretic, contrast HLHS), `Heart.cont_factor_left: 0.4` (failing LV — keeps the peak realistic ~110–130 not ~190 and deepens duct-dependence + differential cyanosis), `Pda.diameter_relative: 1.0`, `diameter_fo: 2.5` / `fo_lr_factor: 4` (modest L→R LA decompression). Aortic valve patent → no engine change. *Same modeling caveat as critical PS:* the realistic LV peak comes via a failing LV rather than a 190 mmHg hypercontractile one.

- **B3 — Critical coarctation of the aorta.** A discrete narrowing at the isthmus; the lower body is perfused by right→left ductal flow into the descending aorta, and abrupt ductal closure causes shock (Ganigara 2019 [#25]; Egan 2009 [#28]).
  *Engine:* `AAR_AD.r_for`↑ (or `no_flow` for near-atretic); `Pda` open feeding the lower body. **Buildable with a wiring note** — see B3/B4 caveat in [§3](#3-engine-lever-summary--limitations).
  **✅ BUILT** as `coarctation` — `scripts/_make_coarc.mjs` → `reseed_coarc.mjs` → `probe_coarc.mjs`. Calibrated: a tight but patent isthmus gives the hallmark **pre/post-ductal pressure gradient** (upper body 101/55 vs lower 30/16, ≈ 55 mmHg mean — upper-body hypertension / weak femorals), a duct-dependent lower body (an antegrade isthmus trickle ≈ 130 mL/min plus the duct R→L ≈ 15 mL/min), and **differential cyanosis** (pre-ductal 97% vs post-ductal 87%). *Two engine facts resolved the wiring note (both JSON-only, no code change):* (1) re-point the duct to the descending aorta — `Pda.components.AAR_DA.comp_from: "AD"` (the `Pda` model drives whatever endpoints its resistor names, so the duct desaturates only the lower body → correct differential cyanosis); (2) the isthmus lever is **`Circulation.components.AD.r_for`** (= 30000 here), *not* `AAR_AD.r_for` — the `AD` BloodVessel adopts its same-named input resistor `AAR_AD` and overwrites `r_for` with `AD.r_for_eff` every step, so a direct edit to `AAR_AD.r_for` is wiped.

- **B4 — Interrupted aortic arch (IAA).** The aortic arch is discontinuous; the descending aorta is perfused entirely through the duct. Almost always with a VSD and a strong association with 22q11 deletion (DiGeorge). PGE1 "revolutionized" its management (Jonas 2015 [#29]; Burbano-Vera 2018 [#30]).
  *Engine:* `AAR_AD.no_flow = true`; `Shunts.diameter_vsd`; ductal lower-body path. **Buildable with rewire** (same caveat as B3).
  **✅ BUILT** as `iaa` (same builder as `coarctation`) — interruption is **`Circulation.components.AD.no_flow = true`** (the `AD` vessel propagates `no_flow` to the `AAR_AD` isthmus resistor). The lower body is **entirely duct-dependent** (isthmus flow = 0, duct R→L ≈ 210 mL/min into the descending aorta), with the characteristic **VSD** (`diameter_vsd: 4`, L→R ≈ 780 mL/min) and **differential cyanosis** (pre-ductal 97% vs post-ductal 84%). Same duct re-point as B3. 22q11/DiGeorge association is clinical context only (not modeled).

### C. Duct- and FO-dependent mixing

- **C1 — d-Transposition of the great arteries (d-TGA).** The aorta arises from the RV and the pulmonary artery from the LV, creating **two circulations in parallel** rather than in series. Survival is impossible without mixing — at the atrial level (FO/ASD), through the duct, and/or via a VSD. Cyanosis is inversely proportional to the amount of mixing. The classic neonatal rescue is PGE1 plus balloon atrial septostomy (Rashkind), pending the arterial switch (Martins 2008 [#16]; Rashkind 1966 [#17]; Cucerea 2024 [#33]; Beitzke 1983 [#35]).
  *Engine:* enable `RV_AA` + `LV_PA` and disable `RV_PA` + `LV_AA` (**all four already pre-wired in `term_neonate.json`**); mixing via `Shunts.diameter_fo` + `Pda` (+ optional `diameter_vsd`). A septostomy is demonstrable by ramping `diameter_fo` via the event scheduler.
  **✅ BUILT** as `dtga` (intact ventricular septum) — `scripts/_make_dtga.mjs` → `reseed_dtga.mjs` → `probe_dtga.mjs`. Calibrated to a stable parallel circulation (Qp:Qs ≈ 1, balanced ~0.8 L/min outputs) with cyanosis (SpO₂ ≈ 59%, pO₂ ≈ 25 mmHg). Mixing levers: `diameter_fo: 6`, `fo_lr_factor: 1` (a true ASD/septostomy hole is symmetric — a high flap factor would throttle the LA→RA flow that oxygenates the systemic circuit), `Pda.diameter_relative: 1.0`, `diameter_vsd: 0`. *Note:* FO ≥ ~7 mm at `fo_lr_factor 1` makes the Hagen-Poiseuille atrial resistance so low the explicit solver oscillates — keep septostomy demos at/below 6 mm or raise `atrial_septal_width`. One small engine generalization was needed: `Heart.calc_model` now detects end-systole from whichever LV outflow valve is active (`LV_AA` if enabled, else `LV_PA`), so the cardiac-cycle analysis and `HeartFunction` wall-stress inputs stay valid with the great arteries transposed (identity for normal anatomy).

### D. Foramen-ovale / atrial-septum-dependent

These lesions depend on an **obligatory atrial-level shunt**; a restrictive or intact atrial septum turns them into an emergency.

- **D1 — Total anomalous pulmonary venous connection (TAPVC), especially obstructed.** The pulmonary veins drain to the systemic venous side instead of the LA, so an obligatory right→left atrial shunt across the FO is the only way to fill the left heart. The obstructed form presents with severe cyanosis and low output, is **unresponsive to prostaglandin**, and is one of the few true neonatal cardiac-surgical emergencies (Ross 2017 [#36]; Vanderlaan 2018 [#37]; Campbell 2022 [#38]).
  *Engine:* reroute the pulmonary venous return (`PV_LA`) so it enters the right side, adding the anomalous connection with high `r_for` for the obstructed variant; `Shunts.diameter_fo` obligate R→L. **Buildable with a pulmonary-venous rewire.**
  **✅ BUILT** as `tapvc` (unobstructed) + `tapvc_obstructed` — `scripts/_make_tapvc.mjs` → `reseed_tapvc.mjs` → `probe_tapvc.mjs`. The reroute is **JSON-only**: `PV_LA.comp_to: "SVC"` (the pulmonary veins drain to the SVC — supracardiac, the commonest type). `PV_LA` is a free-standing Resistor (the `LA` HeartChamber doesn't adopt it), so its `comp_to` *and* `r_for` set directly — the channel `r_for` is the obstruction lever. The FO is opened (`diameter_fo: 6`, baseline `fo_lr_factor: 25` → R→L easy) to carry the obligate shunt that fills the *entire* left heart; the duct stays closed (TAPVC is FO-dependent, not duct-dependent → PGE1-unresponsive). Calibrated — **unobstructed** (`PV_LA.r_for: 335`): full mixing in the RA, normal PV pressure ≈ 10 mmHg, CO ≈ 0.6 L/min, mild cyanosis (SpO₂ ≈ 87%, pO₂ ≈ 42). **Obstructed** (`PV_LA.r_for: 5000`): **pulmonary venous hypertension** (PV pressure ≈ 37 mmHg, vs a near-normal LA — the pathology is upstream, not in the left atrium), secondary **suprasystemic PAP** (≈ 51 ≥ MAP), low output (CO ≈ 0.43 L/min, MAP ≈ 44), severe cyanosis (SpO₂ ≈ 73%, pO₂ ≈ 31) — the surgical emergency. Alveolar oedema not separately modeled (the hypoxaemia arises from the reduced pulmonary flow + complete mixing).

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
- **Aortic override** (A5 TOF) — a single aortic root straddling both ventricles is not representable; approximate the right-to-left streaming through the VSD.
- **Atrialized RV** (A6 Ebstein) — the chamber set is fixed at build time; approximate with severe TR (`RA_RV.r_back`↓) plus a weak RV.

---

## 4. Build roadmap

Each scenario follows the established workflow used for the CDH and PDA families: a `_make_*.mjs` deriver (load `term_neonate.json`, apply a lever table, write JSON) → a `reseed_*.mjs` warm-to-steady-state pass → a `probe_*.mjs` validator. Tiering is by engine friction × clinical importance × reuse of existing assets.

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
- **TOF with pulmonary atresia** (A5) — aortic-override approximation.
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


## 4. Engine source

### FILE: explain-engine/Model.js

```javascript
import ModelEmitter from "./ModelEmitter";
import { RT_MSG } from "./helpers/RealtimeChannels.js";

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
import DataCollector from "./helpers/DataCollector";
import TaskScheduler from "./helpers/TaskScheduler";
import ModelScaler from "./helpers/ModelScaler";
import { buildLiveControllers, runCalibration, measureWindow } from "./helpers/Calibrator";
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
const model_types_cached = [...new Set(available_models.map((mt) => mt.model_type))];
const ENABLE_STEP_ERROR_GUARD = true;

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

  // clear the current model object
  model = {
    models: {},
    scaler_config: {},
    ncc_atrial: 0,
    ncc_ventricular: 0,
    ncc_breathing_insp: 0,
    ncc_breathing_exp: 0,
    ncc_ventilator_insp: 0,
    ncc_ventilator_exp: 0,
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

  // initialize all sub models
  if (errors < 1) {
    // now initialize all the models with the correct properties stored in the model definition
    Object.values(model.models).forEach((model_comp) => {
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

  const base_model = available_models.find(item => item.model_type === new_model.model_type );
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
  } catch {
    console.log('Failed to add model to engine: ')
    _send({
      type: "status",
      message: `ERROR: failed to add model`,
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
        warm: opts.warm ?? 15,
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
  _get_task_scheduler()?.add_task(new_prop_value);
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
  _get_task_scheduler()?.add_function_call(new_function_call);
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
  // iterate over all models
  for (const model_name in model.models) {
    const model_component = model.models[model_name];
    if (ENABLE_STEP_ERROR_GUARD) {
      try {
        model_component.step_model();
      } catch(e) {
        console.error("Step model error: ", model_component.name, e);
        _send_error(`step_model error in ${model_component.name}: ${e.message}`, e);
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
    // so the rt_interval determines how often the model is calculated
    const noOfSteps = rtInterval / model.modeling_stepsize;
    for (let i = 0; i < noOfSteps; i++) {
      _model_step();
    }

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

    // get slow model data
    if (rtSlowCounter > rtSlowInterval) {
      rtSlowCounter = 0;
      _get_model_data_rt_slow();
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
export { GasDiffusor } from "./base_models/GasDiffusor"
export { GasExchanger } from "./base_models/GasExchanger";
export { Resistor } from "./base_models/Resistor";
export { TimeVaryingElastance } from "./base_models/TimeVaryingElastance";

// import the component models
export { Blood } from "./component_models/Blood";
export { BloodCapacitance } from "./component_models/BloodCapacitance";
export { BloodTimeVaryingElastance } from "./component_models/BloodTimeVaryingElastance";
export { BloodVessel } from "./component_models/BloodVessel";
export { BloodPump } from "./component_models/BloodPump";
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
```

### FILE: explain-engine/base_models/BaseModelClass.js

```javascript
import * as Models from "../ModelIndex.js"

// This base model class is the blueprint for all the model objects (classes). It incorporates the properties and methods which all model objects must implement 
export class BaseModelClass {
  // model interface list as described above

  constructor(model_ref, name = "") {
    // initialize independent properties which all models implement
    this.name = name; // name of the model object
    this.description = ""; // description for documentation purposes
    this.is_enabled = false; // flag whether the model is enabled or not
    this.model_type = ""; // holds the model type e.g. BloodCapacitance
    this.components = {}; // holds a dictionary 

    // initialize local properties
    this._model_engine = model_ref; // object holding a reference to the model engine
    this._t = model_ref.modeling_stepsize; // setting the modeling stepsize
    this._is_initialized = false; // flag whether the model is initialized or not
  }

  init_model(args = {}) {
    // set the values of the independent properties
    args.forEach((arg) => {
      this[arg["key"]] = arg["value"];
    });


    Object.keys(this.components).forEach(component_name => {
      // do not overwrite existing models
      if (!this._model_engine.models.hasOwnProperty(component_name)) {
        this._model_engine.models[component_name] = new Models[this.components[component_name].model_type](this._model_engine, component_name);
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
    this.comp_blood1 = "PLF"; // name of the first blood-containing model
    this.comp_blood2 = "PLM"; // name of the second blood-containing model
    this.dif_o2 = 0.01; // diffusion constant for o2 (mmol/mmHg * s)
    this.dif_co2 = 0.01; // diffusion constant for co2 (mmol/mmHg * s)
    this.dif_solutes = {}; // diffusion constant for the different solutes (mmol/mmol * s)

     // non-persistent property factors. These factors reset to 1.0 after each model step
    this.dif_o2_factor = 1.0; // non-persistent diffusion factor for o2 (unitless)
    this.dif_co2_factor = 1.0; // non-persistent diffusion factor for co2 (unitless)
    this.dif_solutes_factor = 1.0; // non-persistent diffusion factor for solutes (unitless)

    // persistent property factors. These factors are persistent and do not reset
    this.dif_o2_factor_ps = 1.0; // persistent diffusion factor for o2 (unitless)
    this.dif_co2_factor_ps = 1.0; // persistent diffusion factor for co2 (unitless)
    this.dif_solutes_factor_ps = 1.0; // persistent diffusion factor for solutes (unitless)

    // scaling factors
    this.dif_o2_factor_scaling = 1.0; // scaling factor for the o2 diffusion factor (unitless)
    this.dif_co2_factor_scaling = 1.0; // scaling factor for the co2 diffusion factor (unitless)
    this.dif_solutes_factor_scaling = 1.0; // scaling factor for the solute diffusion factor (unitless)
  
    // dependent properties
    this.dif_o2_step = 0.0; // state variable for the o2 diffusion (mmol)
    this.dif_co2_step = 0.0; // state variable for the co2 diffusion (mmol)

    // local variables
    this._comp_blood1 = null; // reference to the first blood-containing model
    this._comp_blood2 = null; // reference to the second blood-containing model
  }

  calc_model() {
    // find the two blood-containing models and store references
    this._comp_blood1 = this._model_engine.models[this.comp_blood1];
    this._comp_blood2 = this._model_engine.models[this.comp_blood2];

    // calculate the blood composition of the blood components in this diffusor as we need the partial pressures for the gas diffusion
    calc_blood_composition(this._comp_blood1);
    calc_blood_composition(this._comp_blood2);

    // incorporate the factors
    this.dif_o2_step = this.dif_o2
        + (this.dif_o2_factor - 1) * this.dif_o2
        + (this.dif_o2_factor_ps - 1) * this.dif_o2
        + (this.dif_o2_factor_scaling - 1) * this.dif_o2;

    this.dif_co2_step = this.dif_co2
        + (this.dif_co2_factor - 1) * this.dif_co2
        + (this.dif_co2_factor_ps - 1) * this.dif_co2
        + (this.dif_co2_factor_scaling - 1) * this.dif_co2;

    let solutes_step = 1.0
        + (this.dif_solutes_factor - 1)
        + (this.dif_solutes_factor_ps - 1)
        + (this.dif_solutes_factor_scaling - 1);

    // diffuse the gases, where diffusion is partial pressure-driven
    let do2 = (this._comp_blood1.po2 - this._comp_blood2.po2) * this.dif_o2_step * this._t;

    // update the concentrations (skip a fixed-composition or empty compartment)
    if (!this._comp_blood1.fixed_composition && this._comp_blood1.vol > 0.0) {
      this._comp_blood1.to2 = (this._comp_blood1.to2 * this._comp_blood1.vol - do2) / this._comp_blood1.vol;
    }
    if (!this._comp_blood2.fixed_composition && this._comp_blood2.vol > 0.0) {
      this._comp_blood2.to2 = (this._comp_blood2.to2 * this._comp_blood2.vol + do2) / this._comp_blood2.vol;
    }

    let dco2 = (this._comp_blood1.pco2 - this._comp_blood2.pco2) * this.dif_co2_step * this._t;
    // update the concentrations
    if (!this._comp_blood1.fixed_composition && this._comp_blood1.vol > 0.0) {
      this._comp_blood1.tco2 = (this._comp_blood1.tco2 * this._comp_blood1.vol - dco2) / this._comp_blood1.vol;
    }
    if (!this._comp_blood2.fixed_composition && this._comp_blood2.vol > 0.0) {
      this._comp_blood2.tco2 = (this._comp_blood2.tco2 * this._comp_blood2.vol + dco2) / this._comp_blood2.vol;
    }

    // diffuse the solutes, where the diffusion is concentration gradient-driven
    Object.keys(this.dif_solutes).forEach((sol) => {
      let dif = this.dif_solutes[sol] * solutes_step;
      let dsol = (this._comp_blood1.solutes[sol] - this._comp_blood2.solutes[sol]) * dif * this._t;
      // update the concentration
      if (!this._comp_blood1.fixed_composition && this._comp_blood1.vol > 0.0) {
        this._comp_blood1.solutes[sol] = (this._comp_blood1.solutes[sol] * this._comp_blood1.vol - dsol) / this._comp_blood1.vol;
      }
      if (!this._comp_blood2.fixed_composition && this._comp_blood2.vol > 0.0) {
        this._comp_blood2.solutes[sol] = (this._comp_blood2.solutes[sol] * this._comp_blood2.vol + dsol) / this._comp_blood2.vol;
      }
    });

    // reset the non-persistent factors
    this.dif_o2_factor = 1.0;
    this.dif_co2_factor = 1.0;
    this.dif_solutes_factor = 1.0;
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
    this.el_k = 0.0; // non-linear elastance factor K2 (unitless)
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
    this.pres_tm = 0.0; // transmural pressure (mmHg)

    // local variables
    this.el_eff = 0.0; // calculated elastance (mmHg/L)
    this.u_vol_eff = 0.0; // calculated unstressed volume (L)
    this.el_k_eff = 0.0; // calculated elastance non-linear k (unitless)
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

    // reset the non persistent factors
    this.u_vol_factor = 1.0;
  }
  
  calc_pressure() {
    // calculate the recoil pressure
    this.pres_in = this.el_k_eff * Math.pow(this.vol - this.u_vol_eff, 2) + this.el_eff * (this.vol - this.u_vol_eff);

    // calculate the transmural pressure
    this.pres_tm = this.pres_in - this.pres_ext;

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

    // return if the volume is zero or lower
    if (this.vol <= 0.0) return;
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
    this.el_k = 0.0; // non-linear elastance factor K2 (unitless)
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
    this.pres_tm = 0.0; // transmural pressure (mmHg)

    // local variables
    this.el_eff = 0.0; // calculated elastance (mmHg/L)
    this.u_vol_eff = 0.0; // calculated unstressed volume (L)
    this.el_k_eff = 0.0; // calculated elastance non-linear k (unitless)
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
    this.pres_in = this.el_k_eff * Math.pow(this.vol - this.u_vol_eff, 2) + this.el_eff * (this.vol - this.u_vol_eff);

    // calculate the transmural pressure
    this.pres_tm = this.pres_in - this.pres_ext;

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

### FILE: explain-engine/base_models/GasDiffusor.js

```javascript
import { BaseModelClass } from "./BaseModelClass";

export class GasDiffusor extends BaseModelClass {
  // static properties
  static model_type = "GasDiffusor";

  constructor(model_ref, name = "") {
    // call the parent constructor
    super(model_ref, name);

    // initialize independent properties
    this.comp_gas1 = ""; // name of the first gas-containing model
    this.comp_gas2 = ""; // name of the second gas-containing model
    this.dif_o2 = 0.01; // diffusion constant for o2 (mmol/mmHg * s)
    this.dif_co2 = 0.01; // diffusion constant for co2 (mmol/mmHg * s)
    this.dif_n2 = 0.01; // diffusion constant for n2 (mmol/mmHg * s)
    this.dif_other = 0.01; // diffusion constant for n2 (mmol/mmHg * s)

    // non-persistent property factors. These factors reset to 1.0 after each model step
    this.dif_o2_factor = 1.0; // non-persistent diffusion factor for o2 (unitless)
    this.dif_co2_factor = 1.0; // non-persistent diffusion factor for co2 (unitless)
    this.dif_n2_factor = 1.0; // non-persistent diffusion factor for n2 (unitless)
    this.dif_other_factor = 1.0; // non-persistent diffusion factor for other gasses (unitless)

    // persistent property factors. These factors are persistent and do not reset
    this.dif_o2_factor_ps = 1.0; // persistent diffusion factor for o2 (unitless)
    this.dif_co2_factor_ps = 1.0; // persistent diffusion factor for co2 (unitless)
    this.dif_n2_factor_ps = 1.0; // persistent diffusion factor for n2 (unitless)
    this.dif_other_factor_ps = 1.0; // persistent diffusion factor for other gasses (unitless)

    // scaling factors. These factors are persistent and do not reset, but they are applied as scaling factors to the diffusion factors, meaning that they apply to the total diffusion factor after applying the non-persistent and persistent factors
    this.dif_o2_factor_scaling = 1.0;
    this.dif_co2_factor_scaling = 1.0;
    this.dif_n2_factor_scaling = 1.0;
    this.dif_other_factor_scaling = 1.0;

    // local variables
    this._comp_gas1 = null; // reference to the first gas-containing model
    this._comp_gas2 = null; // reference to the second gas-containing model
    this.dif_o2_step = 0.0; // state variable for the o2 diffusion (mmol)
    this.dif_co2_step = 0.0; // state variable for the co2 diffusion (mmol)
    this.dif_n2_step = 0.0; // state variable for the n2 diffusion (mmol)
    this.dif_other_step = 0.0; // state variable for the other gasses diffusion (mmol)
  }

  calc_model() {
    // find the two gas-containing models and store references
    this._comp_gas1 = this._model_engine.models[this.comp_gas1];
    this._comp_gas2 = this._model_engine.models[this.comp_gas2];

    // refresh the partial pressures of both gas compartments from their current concentrations,
    // as we need the partial pressures for the gas diffusion. Use the GasCapacitance method (which
    // derives partials from the actual concentrations) — NOT the standalone calc_gas_composition
    // initializer, which would reset both compartments to a fixed (room-air) composition.
    this._comp_gas1.calc_gas_composition();
    this._comp_gas2.calc_gas_composition();

    // incorporate the factors
    this.dif_o2_step = this.dif_o2
        + (this.dif_o2_factor - 1) * this.dif_o2
        + (this.dif_o2_factor_ps - 1) * this.dif_o2
        + (this.dif_o2_factor_scaling - 1) * this.dif_o2;

    this.dif_co2_step = this.dif_co2
        + (this.dif_co2_factor - 1) * this.dif_co2
        + (this.dif_co2_factor_ps - 1) * this.dif_co2
        + (this.dif_co2_factor_scaling - 1) * this.dif_co2;

    this.dif_n2_step = this.dif_n2
        + (this.dif_n2_factor - 1) * this.dif_n2
        + (this.dif_n2_factor_ps - 1) * this.dif_n2
        + (this.dif_n2_factor_scaling - 1) * this.dif_n2;

    this.dif_other_step = this.dif_other
        + (this.dif_other_factor - 1) * this.dif_other
        + (this.dif_other_factor_ps - 1) * this.dif_other
        + (this.dif_other_factor_scaling - 1) * this.dif_other;

    // diffuse the gases, where diffusion is partial pressure-driven. Each concentration write is
    // guarded by fixed_composition so a fixed (infinite-reservoir) compartment stays constant,
    // mirroring BloodDiffusor.
    let do2 = (this._comp_gas1.po2 - this._comp_gas2.po2) * this.dif_o2_step * this._t;
    if (!this._comp_gas1.fixed_composition && this._comp_gas1.vol > 0.0) {
      this._comp_gas1.co2 = (this._comp_gas1.co2 * this._comp_gas1.vol - do2) / this._comp_gas1.vol;
    }
    if (!this._comp_gas2.fixed_composition && this._comp_gas2.vol > 0.0) {
      this._comp_gas2.co2 = (this._comp_gas2.co2 * this._comp_gas2.vol + do2) / this._comp_gas2.vol;
    }

    let dco2 = (this._comp_gas1.pco2 - this._comp_gas2.pco2) * this.dif_co2_step * this._t;
    if (!this._comp_gas1.fixed_composition && this._comp_gas1.vol > 0.0) {
      this._comp_gas1.cco2 = (this._comp_gas1.cco2 * this._comp_gas1.vol - dco2) / this._comp_gas1.vol;
    }
    if (!this._comp_gas2.fixed_composition && this._comp_gas2.vol > 0.0) {
      this._comp_gas2.cco2 = (this._comp_gas2.cco2 * this._comp_gas2.vol + dco2) / this._comp_gas2.vol;
    }

    let dn2 = (this._comp_gas1.pn2 - this._comp_gas2.pn2) * this.dif_n2_step * this._t;
    if (!this._comp_gas1.fixed_composition && this._comp_gas1.vol > 0.0) {
      this._comp_gas1.cn2 = (this._comp_gas1.cn2 * this._comp_gas1.vol - dn2) / this._comp_gas1.vol;
    }
    if (!this._comp_gas2.fixed_composition && this._comp_gas2.vol > 0.0) {
      this._comp_gas2.cn2 = (this._comp_gas2.cn2 * this._comp_gas2.vol + dn2) / this._comp_gas2.vol;
    }

    let dother = (this._comp_gas1.pother - this._comp_gas2.pother) * this.dif_other_step * this._t;
    if (!this._comp_gas1.fixed_composition && this._comp_gas1.vol > 0.0) {
      this._comp_gas1.cother = (this._comp_gas1.cother * this._comp_gas1.vol - dother) / this._comp_gas1.vol;
    }
    if (!this._comp_gas2.fixed_composition && this._comp_gas2.vol > 0.0) {
      this._comp_gas2.cother = (this._comp_gas2.cother * this._comp_gas2.vol + dother) / this._comp_gas2.vol;
    }

    // reset the non-persistent factors
    this.dif_o2_factor = 1.0;
    this.dif_co2_factor = 1.0;
    this.dif_n2_factor = 1.0;
    this.dif_other_factor = 1.0;

  }
}

```

### FILE: explain-engine/base_models/GasExchanger.js

```javascript
import { BaseModelClass } from "./BaseModelClass";
import { calc_blood_composition } from "../component_models/BloodComposition"

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

    // non-persistent factors
    this.dif_o2_factor = 1.0; // factor modifying the oxygen diffusion constant
    this.dif_co2_factor = 1.0; // factor modifying the carbon diffusion constant

    // persistent factors
    this.dif_o2_factor_ps = 1.0; // factor modifying the oxygen diffusion constant
    this.dif_co2_factor_ps = 1.0; // factor modifying the carbon diffusion constant

    // scaling factor
    this.dif_o2_factor_scaling = 1.0; // scaling factor for the oxygen diffusion constant
    this.dif_co2_factor_scaling = 1.0; // scaling factor for the carbon diffusion constant
    
    // dependent properties
    this.flux_o2 = 0.0; // oxygen flux (mmol)
    this.flux_co2 = 0.0; // carbon dioxide flux (mmol)

    // local variables
    this._blood = null; // reference to the blood component
    this._gas = null; // reference to the gas component
    this.dif_o2_step = 0.0; // state variable for the o2 diffusion (mmol)
    this.dif_co2_step = 0.0; // state variable for the co2 diffusion (mmol)
  }

  calc_model() {
    // find the blood and gas components
    this._blood = this._model_engine.models[this.comp_blood];
    this._gas = this._model_engine.models[this.comp_gas];

    // set the blood composition of the blood component
    calc_blood_composition(this._blood);

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
        + (this.dif_o2_factor_scaling - 1) * this.dif_o2; // apply scaling factor to the diffusion factor

    this.dif_co2_step = this.dif_co2 
        + (this.dif_co2_factor - 1) * this.dif_co2
        + (this.dif_co2_factor_ps - 1) * this.dif_co2
        + (this.dif_co2_factor_scaling - 1) * this.dif_co2; // apply scaling factor to the diffusion factor


    // calculate the O2 flux from the blood to the gas compartment
    this.flux_o2 = (po2_blood - po2_gas) * this.dif_o2_step * this._t;

    // calculate the new O2 concentrations of the gas and blood compartments
    let new_to2_blood = (to2_blood * this._blood.vol - this.flux_o2) / this._blood.vol;
    if (new_to2_blood < 0) new_to2_blood = 0.0;

    let new_co2_gas = (co2_gas * this._gas.vol + this.flux_o2) / this._gas.vol;
    if (new_co2_gas < 0) new_co2_gas = 0.0;

    // calculate the CO2 flux from the blood to the gas compartment
    this.flux_co2 = (pco2_blood - pco2_gas) * this.dif_co2_step * this._t;

    // calculate the new CO2 concentrations of the gas and blood compartments
    let new_tco2_blood = (tco2_blood * this._blood.vol - this.flux_co2) / this._blood.vol;
    if (new_tco2_blood < 0) new_tco2_blood = 0.0;

    let new_cco2_gas = (cco2_gas * this._gas.vol + this.flux_co2) / this._gas.vol;
    if (new_cco2_gas < 0) new_cco2_gas = 0.0;

    // transfer the new concentrations, guarding each compartment by fixed_composition so a fixed
    // (infinite-reservoir) compartment stays constant, mirroring BloodDiffusor/GasDiffusor
    if (!this._blood.fixed_composition) {
      this._blood.to2 = new_to2_blood;
      this._blood.tco2 = new_tco2_blood;
    }
    if (!this._gas.fixed_composition) {
      this._gas.co2 = new_co2_gas;
      this._gas.cco2 = new_cco2_gas;
    }

    // reset the non-persistent factors
    this.dif_o2_factor = 1.0;
    this.dif_co2_factor = 1.0;
  }
}

```

### FILE: explain-engine/base_models/Resistor.js

```javascript
import { BaseModelClass } from "./BaseModelClass";

export class Resistor extends BaseModelClass {
  // static properties
  static model_type = "Resistor";

  constructor(model_ref, name = "") {
    // call the constructor of the parent class
    super(model_ref, name);

    // initialize independent properties
    this.r_for = 1.0; // forward flow resistance Rf (mmHg*s/l)
    this.r_back = 1.0; // backward flow resistance Rb (mmHg*s/l )
    this.r_k = 0.0; // non-linear resistance coefficient K1 (unitless)
    this.comp_from = ""; // holds the name of the upstream component
    this.comp_to = ""; // holds the name of the downstream component
    this.no_flow = false; // flags whether flow is allowed across this resistor
    this.no_back_flow = false; // flags whether backflow is allowed across this resistor
    this.p1_ext = 0.0; // external pressure on the inlet (mmHg)
    this.p2_ext = 0.0; // external pressure on the outlet (mmHg)
    this.fixed_composition = false;
    this.is_externally_managed = false; // flag read by owning models to skip their own flow calc

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
    this.r_k_eff = 0; // calculated non-linear resistance factor (unitless)
    this._prev_flow = 0.0; // flow from previous model step (L/s)
  }

  // this routine is called in every model step by the ModelEngine Class
  calc_model() {
    // find the up- and downstream components and store the references
    this._comp_from = this._model_engine.models[this.comp_from];
    this._comp_to = this._model_engine.models[this.comp_to];

    // calculate the resistances
    this.calc_resistance();

    // calculate the flow
    this.calc_flow();
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
  }

  calc_flow() {
    // get the pressure of the volume containing compartments and incorporate the external pressures
    let _p1_t = this._comp_from.pres + this.p1_ext;
    let _p2_t = this._comp_to.pres + this.p2_ext;

    // reset the external pressures
    this.p1_ext = 0.0;
    this.p2_ext = 0.0;

    // reset the current flow
    this.flow = 0.0;

    // return if no flow is allowed across this resistor
    if (this.no_flow) {
      this._prev_flow = 0.0;
      // return from this function
      return;
    }

    // calculate the forward flow between two components
    if (_p1_t >= _p2_t) {
      // guard against a non-positive resistance (would produce Infinity/NaN flow)
      if (this.r_for_eff <= 0.0) {
        this._prev_flow = 0.0;
        return;
      }
      // calculate the forward flow. The non-linear term uses the previous step's flow (explicit
      // lagged scheme) — not this.flow, which was just reset to 0 above.
      this.flow = (_p1_t - _p2_t - this.r_k_eff * Math.pow(this._prev_flow, 2)) / this.r_for_eff;

      // update the volumes of the connected components but do not remove the volume which could not be removed from the upstream component (to prevent volume loss)
      const vol_not_removed = this._comp_from.volume_out(this.flow * this._t);
      this._comp_to.volume_in(this.flow * this._t - vol_not_removed, this._comp_from);

      // store the previous flow
      this._prev_flow = this.flow;
      
      // return from this function
      return;
    }

    // calculate the backward flow between two components
    if (_p1_t < _p2_t && !this.no_back_flow) {
      // guard against a non-positive resistance (would produce Infinity/NaN flow)
      if (this.r_back_eff <= 0.0) {
        this._prev_flow = 0.0;
        return;
      }
      // calculate the backward flow. The non-linear term uses the previous step's flow (explicit
      // lagged scheme) — not this.flow, which was just reset to 0 above.
      this.flow = (_p1_t - _p2_t + this.r_k_eff * Math.pow(this._prev_flow, 2)) / this.r_back_eff;

      // update the volumes of the connected components but do not remove the volume which could not be removed from the upstream component (to prevent volume loss)
      let vol_not_removed = this._comp_to.volume_out(-this.flow * this._t);
      this._comp_from.volume_in(-this.flow * this._t - vol_not_removed,this._comp_to);

      // store the previous flow
      this._prev_flow = this.flow;

      // return from this function
      return;
    }

    // reached only when p1 < p2 and backflow is blocked: no flow occurred this step,
    // so clear the stored flow to keep the non-linear term consistent next step
    this._prev_flow = 0.0;
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
    this.el_k = 0.0; // non-linear elastance coefficient K2 (unitless)
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
    this.pres_tm = 0.0; // transmural pressure (mmHg)

    // local properties
    this.el_min_eff = 0.0; // calculated minimal elastance (mmHg/L)
    this.el_max_eff = 0.0; // calculated maximal elastance (mmHg/L)
    this.u_vol_eff = 0.0; // calculated unstressed volume (L)
    this.el_k_eff = 0.0; // calculated elastance non-linear k (unitless)
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

    // reset the non persistent factors
    this.u_vol_factor = 1.0;
  }

  calc_pressure() {
    // calculate the recoil pressure
    let p_ms = (this.vol - this.u_vol_eff) * this.el_max_eff;
    let p_ed = this.el_k_eff * Math.pow(this.vol - this.u_vol_eff, 2) + this.el_min_eff * (this.vol - this.u_vol_eff);

    // calculate the current recoil pressure
    this.pres_in = (p_ms - p_ed) * this.act_factor + p_ed;

    // calculate the total pressure by incorporating the external pressures
    this.pres = this.pres_in + this.pres_ext

    // calculate the transmural pressure
    this.pres_tm = this.pres_in - this.pres_ext;

    // reset the external pressure
    this.pres_ext = 0.0;
  }

  // override the volume_in method
  volume_in(dvol, comp_from) {
    // add volume to the capacitance
    this.vol += dvol;

    // return if the volume is zero or lower
    if (this.vol <= 0.0) return;
  }

  volume_out(dvol) {
    // remove volume from capacitance
    this.vol -= dvol;

    // if the volume is zero or lower, handle it
    if (this.vol < 0.0 && this.vol < this.u_vol) {
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
  "adult_female",
  "adult_female_uterus",
  "bischoff_cohort",
  "cdh_lv_dysfunction",
  "cdh_moderate",
  "cdh_severe",
  "coarctation",
  "critical_as",
  "critical_ps",
  "dtga",
  "hlhs",
  "hlhs_restrictive",
  "iaa",
  "pa_ivs",
  "pa_vsd",
  "pda_bidirectional",
  "pda_bidirectional_unrestrictive",
  "pda_restrictive_ltr",
  "pda_restrictive_rtl",
  "pda_unrestrictive_ltr",
  "pda_unrestrictive_rtl",
  "pphn",
  "preterm_24wk",
  "preterm_26wk",
  "preterm_28wk",
  "preterm_30wk",
  "preterm_32wk",
  "preterm_34wk",
  "preterm_36wk",
  "tapvc",
  "tapvc_obstructed",
  "term_fetus",
  "term_neonate",
  "tricuspid_atresia"
]

```
