# Numerics

The numeric read-out layer is the Vue app's **dashboard side**: dense cards that turn the ~1 Hz slow stream into labelled, unit-scaled values with a trend arrow and a sparkline. It is strictly on the CONTROL plane — values come from `useExplain().slowValues` (the `rts` slow stream) plus a small client-side history buffer (`useSlowHistory`). It never reads the ~60 Hz DATA plane. Everything lives inside `src/pages/MainPage.vue`, which renders one `NumericReadoutPanel` per enabled `configuration.monitors` group.

## What lives here

| File | Responsibility |
|---|---|
| `src/components/numerics/NumericReadoutPanel.vue` | Read-only card grid ⇄ inline editor for one monitor group |
| `src/components/numerics/Sparkline.vue` | Dependency-free SVG trend line (`currentColor`) |
| `src/utils/monitorFormat.ts` | `scaleValue` / `formatParam` — shared display logic |
| `src/utils/csv.ts` | `seriesToCsv` / `copyText` / `downloadText` for buffer export |
| `src/stores/monitors.ts` | Pinia store: dashboards ⇄ `configuration.monitor_dashboards`, group/param CRUD, auto-persist |
| `src/composables/useSlowHistory.ts` | Singleton ring buffer over the slow stream → `history`/`stats`/`delta` |
| `src/composables/useMonitorPrefs.ts` | localStorage view prefs: `compact`, `sparkWindowSec` |

## Data model

A `MonitorParam` (`stores/monitors.ts`) is one read-out:

| Field | Meaning |
|---|---|
| `label`, `unit` | display caption + unit string |
| `props[]` | engine dot-paths (`"Model.prop"` or `"Model.minmax.sub"`); **two props render as `a/b`** (e.g. systolic/diastolic) |
| `factor` | raw engine value × factor for display |
| `rounding` | decimal places |
| `weight_based` | divide by patient weight (per-kg read-outs) |

A `MonitorGroup` is one collapsible `Panel` of params with a stable JSON `key`; a `MonitorDashboard` is a named set of groups. The store holds groups as an **ordered array** that round-trips to the keyed `monitors` object (JS insertion order ⇄ key order).

## NumericReadoutPanel.vue

Props: `group: MonitorGroup`, `editable?` (manage mode → show the edit pencil), `compact?` (hide sparklines, denser 4-col grid), `highlight?: string[]` (cards whose first prop path is listed get an amber ring and a short pulse; used by lesson steps). No emits — edits mutate the `monitors` store directly, which auto-persists.

### Read-only mode

Renders a card grid (2-col, or 4-col compact). Each card shows `label · value · unit`, an optional `min–max` range label, and a `Sparkline`.

- **Subscription:** `onMounted(subscribe)` + `watch(parameters)` collect every `props[]` path into a set and call `watchSlow([...paths])`. The engine accumulates + dedups, so multiple panels coexist without clobbering each other's watchlists.
- **Value:** `latest` = last row of `slowValues`; `fmt(p) = formatParam(p, latest, weight)`.
- **Weight:** read from `modelState.weight` (fallback 1) for per-kg params.
- **Trend tint + sparkline** are driven by the **first** prop: `sparkPoints(p) = history(path)` (raw buffer — a constant scale doesn't change the line's shape); `sparkClass(p)` tints by `delta(path)` (green up / rose down / neutral).
- **Range + detail:** single-prop params show `min–max` over `prefs.sparkWindowSec` via `scaledStats` (each of min/max/mean/last run through `scaleValue`). A hover `Popover` shows a larger sparkline + min/mean/max/now stats and the raw paths.
- **Collapse** is local state seeded from `group.collapsed`, so the user can toggle without changing the saved default.

### Editing mode

Toggled per-group by the pencil (only when `editable`; closes when manage mode leaves). It mutates `group`/`param` objects in place and calls `store.persist()` (debounced) on every change (`touch()`):

- **Group:** title (`InputText`), move up/down (`store.moveGroup`), delete, `enabled`/`collapsed` toggles.
- **Param primary prop:** a `Model` `Select` + a `Property` `Select` (numeric/factor fields from `getInterface(model)` via `useModelInterface`), **plus a raw-path `InputText` escape hatch** (e.g. `Monitor.minmax.abp_pres_max`). Picking a prop on slot 0 auto-suggests `factor`/`rounding`/`label` from the interface field (never clobbering a typed label). Each path shows a live `now: <value>` validity check resolved against `modelState` (works while paused) — green check or amber "not resolving".
- **Optional 2nd prop** (the `a/b` value) via raw path only.
- **Display metadata:** `unit`, `× factor`, `dp` rounding, `/kg` (`weight_based`).
- **Add/remove param** via `store.addParam` / `store.removeParam`.

## Formatting (`monitorFormat.ts`)

Shared so the panel and any export format values identically:

```
scaleValue(param, raw, weight) = raw * (factor ?? 1) / (weight_based ? weight : 1)
formatParam(param, latest, weight): join each props[] value (scaled, fixed to rounding) with "/"
```

A missing/non-numeric value renders as `—`. `formatParam` is the single source of the displayed string.

## Sparkline.vue

Tiny dependency-free SVG trend line. Props: `points: number[]` (oldest → newest), `width?` (96), `height?` (22).

- Filters non-finite points; needs ≥2 to draw.
- Auto-scales to its own min/max (flat series → centred horizontal line).
- Builds an SVG `path` (`M`/`L`), inverted so higher value = higher up.
- Stroke is `currentColor` (parent tints via a text-color class) with `vector-effect="non-scaling-stroke"`; `aria-hidden`.

## Trend history (`useSlowHistory.ts`)

The slow stream keeps **no** history — `slowValues` is replaced with the latest drained batch each `rts` event. This singleton ring buffer fills that gap:

- One module-level `watch(slowValues)` ingests **every row in the batch** (so fast-forward `calculate()` bursts populate history too), keyed by the row's numeric props.
- Per-path buffers capped at `MAX_LEN = 300` (~5 min at 1 Hz). A backwards `time` jump (reload/restart) clears all buffers; duplicate samples (same `time`) are skipped.
- Exposes `history(path, windowSec?)`, `stats(path, windowSec?)` → `{min,max,mean,last,n}`, and `delta(path, n=10)` → signed change for tinting.

## Prefs (`useMonitorPrefs.ts`)

Singleton reactive object persisted to `localStorage` (`explain.monitors.prefs`): `compact` (dense grid, no sparklines) and `sparkWindowSec` (30 / 60 / 300). Purely a per-browser display choice — never written to scenario JSON.

## Store & persistence (`monitors.ts`)

- `syncFromScenario()` loads `configuration.monitor_dashboards` (array; each dashboard owns a keyed `monitors` object). Legacy scenarios with a single `configuration.monitors` are migrated into one default dashboard.
- CRUD (`add/remove/move` dashboard/group/param) operates on the active dashboard's ordered array.
- `persist()` is **debounced 500 ms** → `persistNow()` writes `configuration.monitor_dashboards` (and mirrors the first dashboard into legacy `configuration.monitors`) back into `loadedFileData` and POSTs `/api/save-snapshot`. The original `model_definition` is preserved — **it never snapshots the live running sim**, only the dashboard config.

## CSV export (`csv.ts`)

For exporting chart/series buffers (used by the chart panels, shared util):

- `seriesToCsv(time, labels, cols)` — a `time` column + one column per labelled series, rows aligned to the **shortest** column so ragged buffers stay valid.
- `copyText(text)` — best-effort clipboard write (resolves `false` if unavailable).
- `downloadText(filename, text, mime="text/csv;charset=utf-8")` — Blob → anchor download.

## Wiring

```
rts (~1 Hz)  ──▶  useExplain.slowValues  ──┬──▶  NumericReadoutPanel.latest  ──▶  formatParam  ──▶  card value
                                           └──▶  useSlowHistory ring buffer  ──▶  history/stats/delta  ──▶  Sparkline + trend + range
edit pencil  ──▶  mutate group/param  ──▶  store.persist (debounced)  ──▶  /api/save-snapshot (configuration only)
```

`NumericReadoutPanel` subscribes its paths via `watchSlow`; the read-out value comes from the latest slow row, the trend from the history buffer.

## Gotchas

- **History lives client-side.** `slowValues` is the latest drained batch only; sparklines/range/trend come entirely from `useSlowHistory`, which is empty until samples accumulate after a (re)build.
- **Re-subscribe on path changes.** The panel re-runs `subscribe()` when `parameters` change, but a scenario rebuild resets the engine watchlist — paths must be re-registered (handled because `slowValues` updates re-drive the computed cards; the watchlist is re-added on the next `watchSlow`).
- **Trend uses the first prop only.** For an `a/b` param the sparkline/range tracks `props[0]`.
- **Persistence saves config, not state.** `monitors.persist()` writes only `configuration.*` into `loadedFileData`; the running `model_definition` is untouched. Use `SaveStatePanel` to snapshot the live engine.
- **Raw-path escape hatch bypasses the registry.** Editor model/prop selects only list interface-declared numeric fields; deep paths like `Monitor.minmax.abp_pres_max` must be typed into the raw-path input, validated by the live `now:` resolver.
