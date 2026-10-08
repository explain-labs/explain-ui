# Host Components

`src/components/host/` holds the Vue 3 **host** components that bridge the two planes. Each one owns a DOM surface (a `<div>` mount), constructs a plain-TS [renderer adapter](./RenderLayer.md), and registers it with the singleton [RealtimeBus](../../explain-engine/docs/RealtimeBus.md) so the bus drives it at ~60 Hz on the **data plane**. The Vue layer itself only touches the **control plane**: it picks which signals to watch (`watchProps`/`watchSlow` via `useExplain`), reads slow ~1 Hz numerics, and pushes view settings into the adapter imperatively. Per-frame samples flow worker → bus → adapter and **never** through Vue reactivity.

## What lives here

| File | Responsibility |
|---|---|
| `RealtimeChart.vue` | Strip-chart host: pick up to two model.prop series; shared/split axes, lock-Y, fill, presets, CSV. Drives one or two `ChartRenderer`s |
| `LoopChart.vue` | X-Y loop host (PV loop): pick an x and a y series; presets, CSV. Drives one `LoopRenderer` |
| `Monitor.vue` | Bedside-monitor host: six fixed waveform lanes + slow-stream numerics. Drives a `MonitorRenderer` |
| `VentilatorScope.vue` | Ventilator graphics: Paw/Flow/Volume lanes. Reuses `MonitorRenderer` with vent signals |
| `sle6000/Sle6000Screen.vue` | SLE6000 ventilator replica (center pane): the device's touchscreen, driving the engine's `Sle6000` model. Drives a `Sle6000Renderer` |
| `Diagram.vue` | PixiJS circulation diagram + editor toolbar/inspector. Lazily mounts `DiagramRenderer`; bridges live edits to the engine |

Supporting: `src/composables/useChartParams.ts` (model/param catalog + presets) and `src/stores/diagram.ts` (publishes the live diagram renderer to the bot pipeline).

## The lifecycle pattern

Every host follows the same shape:

```ts
const { addRenderer, removeRenderer } = useRealtimeBus();
let adapter: SomeRenderer | null = null;

onMounted(() => {
  adapter = new SomeRenderer(el.value!, /* config */);
  addRenderer(adapter);          // bus replays the current registry to onRegistry
  watchProps([/* fast paths */]); // additive: ensure the signals are sampled
});

onBeforeUnmount(() => {
  if (adapter) { removeRenderer(adapter); adapter.dispose(); }
});
```

`addRenderer` immediately replays the cached `RT_MSG.CHANNELS` registry to the adapter's `onRegistry` (so a host mounted after the engine built still resolves its slot indices). Watch-list calls are **additive** — hosts never clear the shared fast watchlist, since other hosts (and the always-on ECG counters) live in it. `removeRenderer` + `dispose()` on unmount detach the adapter and free its canvas/WebGL surface.

## RealtimeChart.vue

Two `ChartRenderer` instances (`adapterTop`, `adapterBottom`); the bottom one carries `setColorOffset(1)` so a split B-series is blue. The user picks series A and B as `model` → `parameter` (`Select`s populated by `useChartParams`). View toggles: **Split** (A on top, B on a second stacked chart), **Shared Y** (both on one axis), **Fill**, **Auto Y / Lock Y**, and a rolling **window** select.

`applyView()` is the routing core: `watchProps(paths)` ensures the picks are sampled, then per view it calls `setSharedAxis` / `setVisible` on the right adapter(s) (split → one series each, single → both on top, bottom hidden with `setVisible([])`). A `watch([pathA, pathB, split, sharedAxis])` re-runs it and resets locked ranges back to autoscale.

- **Lock-Y:** `autoY=false` → `setAutoScaleY(false)` snapshots the live ranges; `refreshYAxes()` pulls `getYAxes()` into a reactive `yAxes` array of `{ role, key, label, color, min, max }`; inline `InputNumber`s call `setYRange(key,min,max)` per edit.
- **Presets:** `useChartParams("RealTimeCharts")`. Selecting a preset fills A/B from its first two `paths`; a preset may also ship `fill` and a fixed scale (`autoscale:false` + `yMin`/`yMax` → `applyFixedYRange` after `nextTick`). Save/delete via a name input.
- **CSV:** `onDownload` snapshots `adapterTop.getSeries()` (plus the bottom chart when split, merged on a shared time base) → `seriesToCsv` → `downloadText("realtime_chart.csv", …)`.

Default on mount: aortic pressure `AA.pres` on series A when present.

## LoopChart.vue

One `LoopRenderer`. The user picks an x and a y `model.prop`; `applyView()` does `watchProps([x, y])` then `adapter.setSignals(x, y)`. Window select drives `setWindow`. Presets (`useChartParams("LoopCharts")`) map `paths[0]→x`, `paths[1]→y`. `onDownload` → `adapter.getSeries()` → `loop_chart.csv`. Default on mount: `LV.vol` (x) vs `LV.pres` (y) — a pressure-volume loop.

## Monitor.vue & VentilatorScope.vue

Both build a `MonitorRenderer` from a `LANES: MonitorLane[]` array and split fast vs. slow. `Monitor.vue` takes its lanes from the `LANE_DEFS` catalogue in `src/render/monitorLanes.ts`. Optional props, whose defaults reproduce the full monitor: `lanes?: LaneId[]` (a subset, in order; fixed for the component's lifetime), `height?`/`minHeight?`, `showWindowSelect?` and `highlight?: LaneId[]` (lanes framed in amber through `MonitorRenderer.setHighlight`). Each lane carries its `slow` paths, so the watchlists follow the chosen lanes.

- **Fast (waveforms):** `FAST_PATHS = LANES.map(l => l.signal)` → `watchProps(FAST_PATHS)`; the bus feeds these to `onFrame`, never through Vue.
- **Slow (numerics):** `SLOW_PATHS` → `watchSlow(...)`; a `latest` computed reads the newest `slowValues` snapshot and `watch(latest, n => adapter.setNumerics(n))` pushes it into the renderer's gutter. Safe at ~1 Hz.
- **Re-watch on rebuild:** `watch(modelReady, ...)` re-issues `watchProps`/`watchSlow` because each engine `build()` resets the `DataCollector` watchlist.

`Monitor.vue` lanes: ECG, SpO₂ pre/post, ABP (post-ductal AD, max/min with mean sub), Resp, CO₂; signals are the `Monitor.signals.*` purpose-built waveforms, numerics are `Monitor.*` slow values. `VentilatorScope.vue` reuses the same renderer with Paw/Flow/Volume lanes off `Ventilator.pres`/`flow`/`vol` and PIP/PEEP/MV/Vt numerics (Vt scaled L→mL). Each has a **sweep** window select → `setWindow`.

## sle6000/ — the SLE6000 ventilator screen

An on-screen replica of the SLE6000 touchscreen (IFU V2.0 §21; see the engine's
[`Sle6000`](../../explain-engine/docs/Sle6000.md) doc). It sits in the center pane as the `sle6000` tab,
which is in `UNFINISHED_PANELS` (dev builds only) until the HFO phase lands. The tab shows a notice with
a load button when the patient's ventilator is not an `Sle6000`.

- **Frame.** `Sle6000Screen.vue` lays the device out on a fixed 1024 × 768 frame, CSS-scaled to the
  pane width. It has:
  - the information bar: mode button, messages, lock, pause, clock;
  - the button column: Additional Parameters and Manual Breath. Alarms, Utilities and Layout are
    disabled for now;
  - the waveforms;
  - the monitored values;
  - the parameter row with +/− and Confirm.
- **Settings table.** `sleUi.ts` imports the settings table from the engine
  (`@explain/device_models/sle6000_params`), so ranges, resolutions, per-mode rows and interlocks
  have one source. It adds the display parts: decimals, labels such as PIP MAX / VTV Target, the
  monitored-value groups, and the slow paths.
- **`ParamTile.vue`.** One parameter control: an SVG 270° arc gauge, coloured by type (time blue,
  pressure orange, O2 green, sensitivity white). Its states are available, selected (white) and
  preview (black). A tap selects it. A hold emits `hold`: 2 s switches on an Off function (VTV, RR
  Backup, P Support), and 3 s on O2 toggles O2 Boost.
- **`MonitoredValues.vue`.** The grouped value column, in a single (8) or double (16) layout. A
  1 s hold switches between them.
- **`ModePanel.vue`.** The Invasive / Standby tabs, the mode buttons and the 10/15 mm circuit picker.
  HFO and non-invasive are shown disabled.
- **`src/render/Sle6000Renderer.ts`.** Pressure / flow / volume as on the device: blue traces on
  white, grey header strips, a y-axis that snaps to round ranges (grows at once, shrinks a sweep
  later), and a pause (`setPaused`). It uses the same column store as `MonitorRenderer`, plus
  `setCssScale` so the canvas backs the real pixel size inside the scaled frame.

**Colours.** The IFU draws the screen as grey line art, but the device has SLE's dark, low-glare
"Lunar" interface. Its colours are sampled by eye from vendor product photos (the GE HealthCare
SLE6000 product page, and the Inspiration Healthcare SLE6000 N/C/H brochure with SIMV + VTV and HFOV
screens). They live in one palette, `sle6000/sleTheme.ts`, which the frame applies as `--sle-*` CSS
variables and passes to the renderer:
- black screen, with dark-grey header strips, buttons and tiles
- pressure trace slate-teal, filled; flow bright green; volume teal, filled; red sweep head
- tile arcs: time light blue, pressure/volume amber, O2 green, sensitivities white
- a yellow alarm-mute outline
- white monitored values, each with a grey "label (unit)" under it

The mode panel colours are an assumption, because no photo shows it open. The palette also reserves
the etCO2 yellow and the orange-red alarm-limit lines for later phases.

**Write rule.** Edits are local until Confirm: `pending` settings, `previewMode`, `pendingCircuit`.
Confirm sends one `call("Ventilator.sle_apply", [settings])`, so every change goes through the
engine's clamping and interlocks. The screen never `setProp`s.
- Manual Breath calls `sle_manual_breath`, and O2 Boost calls `sle_o2_boost`.
- The settings read off the slow stream (`Ventilator.sle_*`). The values just sent overlay them until
  two slow samples have arrived.
- Timeouts follow the device: a selected parameter is discarded after 15 s, a panel or preview after
  120 s, and the additional row closes after 120 s.

## Diagram.vue — editor & live re-bind

Optional props: `toolbar?` (default `true`; `false` hides the edit toggle and so every edit affordance, as on the lesson page), `height?` (default `65vh`), `minHeight?` (default `480px`) and `highlight?: { names, labels? }`, which is forwarded to `DiagramRenderer.setHighlight` (lesson pointing).

The richest host. Pixi is **lazily** imported so it lands in its own chunk:

```ts
const { DiagramRenderer } = await import("@/render/DiagramRenderer");
adapter = new DiagramRenderer(el.value, diagram);
await adapter.init();
```

`mountRenderer(diagram)` reads the diagram from `model.loadedFileData.diagram_definition`, wires callbacks, syncs toolbar state from `diagram.settings`, `addRenderer(adapter)`, and **publishes the renderer** to `useDiagramStore().register(adapter)` so the chat/bot pipeline can drive edits while it's mounted.

**Selection inspector.** `adapter.setSelectCallback((name, comp, kind) => …)` mirrors the selected component/connector's `layout` into a panel of refs (alpha, z, tinting, models, plus sprite color/scale/rotation/picto/label for compartments, or path type/width for connectors). Edits call either:
- `patch(p)` → `adapter.applyLayoutPatch(name, p)` for **cosmetic** layout changes (re-renders live, no engine touch), or
- `setModels` / `setTinting` / `setLabel` / `setPicto` for component-level changes.

**Live re-bind (no model rebuild).** Cosmetic patches stay client-side. **Structural** edits (add / connect / delete / `setModels` / `setTinting`) fire the renderer's change callback:

```ts
adapter.setChangeCallback(() => pushDiagram());
function pushDiagram() {
  if (adapter) model.updateDiagram?.(adapter.getDiagram());
}
```

`model.updateDiagram(getDiagram())` ships the edited definition to the worker, which rebuilds the `AnimationPacker` and re-handshakes the channel — so new/changed components start animating **without rebuilding the running model**. The live anim binding is otherwise fixed at build time, which is why newly added components are static until this push (or a rebuild).

**Toolbar.** Edit / Connect toggles; `addCompartment(model, picto)`; Delete + keyboard shortcuts (Delete/Backspace removes selection, Escape clears — ignored while typing in a field); Grid on/off + size (`setGrid`/`setGridSize`); global **scale** (`setScaling` — sprites, labels, path widths, dots, persisted to `settings.scaling`); **O₂ tint window** lo/hi (`setTo2Range`, persisted to `settings.to2_lo`/`to2_hi`); Export/Import JSON (import accepts a diagram or a full scenario, tearing down and remounting).

**ECLS circuit.** The ECLS diagram components are in the `"ecls"` device group (see [RenderLayer](./RenderLayer.md)). `Diagram.vue` watches `Ecls.ecls_running`/`drainage_site`/`return_site`/`pump_rpm`/`pump_mode` (`ECLS_DIAGRAM.watch` in `diagramConstants.ts`) — off the slow stream while running (re-subscribed on every `model_ready`, since a build resets the watchlist) and off each state snapshot while paused — and shows the group while ECLS is on (`ecls_running`, the ECLS panel's Running toggle; every scenario ships it off). Clamped or not: a clamped circuit is drawn static, since its flow is forced to 0 and the dots fade out. The drainage/return connectors are re-routed via `setConnectorEnds` to `componentForModel(site)`, so a VA→VV site change in the ECLS panel moves the line. The pump sprite spins with `Ecls.pump_rpm`/`pump_mode` via `pumpSpinRate` (roller pumps at their true rate; centrifugal speeds compressed to a readable 0–1.5 rev/s, since 25–65 rev/s would only strobe). The view is re-applied after every (re)mount.

## useChartParams.ts

Shared catalog + preset logic for `RealtimeChart.vue` and `LoopChart.vue`, parameterized by `presetKey` (`"RealTimeCharts"` / `"LoopCharts"`):

- `modelNames` — sorted keys of `modelState.models`.
- `numericProps(modelName)` — that model's numeric-valued props, sorted (the editable parameter list).
- `pathToSel(path)` — `"Model.prop"` → `[model, prop]` for loading a preset into the selectors.
- `presets` — `configuration.presets[presetKey]` from the loaded scenario, merged under `savedPresets` (session-only, until the chart remounts on reload); `savePreset` / `deletePreset` manage the session layer.

## diagram.ts (store)

A tiny Pinia store bridging `Diagram.vue` (which owns the renderer locally) and the engine-only chat/bot pipeline. `register(r)` / `unregister(r)` publish/clear `activeRenderer` (a `shallowRef`; unregister guards against a remount race), and `getDiagram()` returns the live definition. When the renderer is absent (Diagram tab torn down), bot diagram commands surface as an actionable "open the Diagram tab" card rather than failing silently.

## Wiring

- Data-plane bus + buffer contract: [RealtimeBus](../../explain-engine/docs/RealtimeBus.md), [ChannelReader](../../explain-engine/docs/ChannelReader.md), [RealtimeChannels](../../explain-engine/docs/RealtimeChannels.md).
- Anim registry/frame layout for the diagram: [AnimationPacker](../../explain-engine/docs/AnimationPacker.md).
- The adapters these hosts construct: [RenderLayer](./RenderLayer.md).
- Control-plane composable (`watchProps`/`watchSlow`/`slowValues`/`modelReady`/`model`): `src/composables/useExplain.ts`; bus singleton: `src/composables/useRealtimeBus.ts`.

## Gotchas

- **Additive watchlists — never clear.** Hosts only ever *add* to the shared fast/slow watchlists. Each engine `build()` resets the `DataCollector`, so `Monitor`/`VentilatorScope` re-issue their watches on `modelReady`; the chart hosts re-issue via `applyView` when picks change.
- **Slow numerics are the only reactive path.** Waveforms (`watchProps`) bypass Vue entirely; only the 1 Hz `slowValues` snapshot is read reactively and pushed via `setNumerics`. Don't route fast data through refs.
- **Two charts always exist in RealtimeChart.** `adapterBottom` is constructed even when not split (kept hidden via `setVisible([])`), so a split toggle is instant and CSV export can merge it.
- **Diagram requires the tab mounted.** `DiagramRenderer` is owned by `Diagram.vue`; bot/chat diagram commands work only while the tab (and thus `diagramStore.activeRenderer`) is live. Diagram and Chat are sibling non-lazy tabs, so it normally stays mounted.
- **Cosmetic vs. structural edits differ.** `applyLayoutPatch` is local and never rebuilds; only structural edits call `pushDiagram()` → `model.updateDiagram` for the live anim re-bind. Added components are static until that push.
- **Pixi lazy-import.** `Diagram.vue` `await import`s the renderer so PixiJS stays out of the main bundle — keep it a type-only import at module scope.
