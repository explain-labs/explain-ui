# Render Layer

`src/render/` is the **data-plane render layer**: the plain-TypeScript renderer adapters that the [RealtimeBus](../../explain-engine/docs/RealtimeBus.md) drives at ~60 Hz. Each adapter owns a canvas / WebGL surface (uPlot, raw 2D canvas, or PixiJS) and implements the `RendererAdapter` contract so the bus can hand it `onFrame(chart, anim)` every `requestAnimationFrame` tick. Nothing here is Vue-reactive: adapters read typed buffers directly and redraw, so per-frame telemetry never triggers a component re-render. The [host components](./HostComponents.md) construct these adapters, register them with the bus, and feed them control-plane settings imperatively.

## What lives here

| File | Responsibility |
|---|---|
| `types.ts` | Shell-side TypeScript mirrors of the bus shapes: `ChartFrame`, `AnimFrame`, `AnimComponent`, `AnimLayout`, `ChannelsPayload`, and the `RendererAdapter` contract |
| `ChartRenderer.ts` | uPlot adapter for the fast chart channel — rolling-window strip chart, 1–2 series, shared/split axes, lock/auto Y, area fill, CSV snapshot |
| `LoopRenderer.ts` | Raw-canvas X-Y "loop" plotter (e.g. PV loop): one chart signal against another parametrically; polyline, not uPlot |
| `SleLoopRenderer.ts` | SLE6000 loop (V/P, F/V, F/P): one signal against another per breath. Breath edges come from `Ventilator.ncc_insp` and HFO cycle edges from `Ventilator._hfo_phase` (`sleLoopBuffer.ts`, unit-tested). It overlays the last 3 breaths fading, a white saved loop, and axes snapped to round ranges |
| `MonitorRenderer.ts` | Bedside-monitor sweep renderer — stacked waveform lanes with a shared sweep head + big slow-stream numerics gutter. Used by `Monitor.vue` |
| `DiagramRenderer.ts` | PixiJS v8 adapter for the sprite circulation diagram (viewer + editor): compartments scaled by volume, tinted by `to2`; connectors with streaming flow dots |
| `diagramConstants.ts` | Shared editor constants: `PICTOS`, `PATH_TYPES`, `LAYOUT_PATCH_WHITELIST` |

## The `RendererAdapter` contract

Defined in `types.ts`. Every renderer in this folder `implements RendererAdapter`:

```ts
interface RendererAdapter {
  onRegistry?(payload: ChannelsPayload): void;   // channels (re)configured
  onFrame(chart: ChartFrame | null, anim: AnimFrame | null): void;  // per rAF tick
  dispose?(): void;
}
```

- **`onRegistry(payload)`** — optional. Called when the worker's `RT_MSG.CHANNELS` handshake arrives, and **replayed immediately** by `RealtimeBus.addRenderer` if a registry already landed (late-registered adapters still get the layout). Adapters use it to resolve their signal names → column/slot indices against `payload.chart.slots` (and, for the diagram, `payload.anim.components`).
- **`onFrame(chart, anim)`** — required. Called once per tick that produced new data; **either argument may be `null`** (chart-only renderers ignore `anim`, the diagram ignores `chart`). Each call is wrapped in `try/catch` by the bus so one throwing adapter cannot starve the others.
- **`dispose()`** — optional. Tears down observers, destroys the plot/app, removes the canvas. Hosts call it from `onBeforeUnmount` after `removeRenderer`.

### Typed-buffer shapes (`types.ts`)

```ts
interface ChartFrame {
  version: number;
  stride: number;        // floats per row (col 0 = time, then one per slot)
  slots: string[];       // ["time", "<Model.prop>", …]
  count: number;         // number of rows in this drain
  rows: Float64Array;    // count * stride values, row-major
}

interface AnimFrame {
  version: number;
  stride: number;
  components: AnimComponent[];
  layout: AnimLayout;    // { count, stride, max_to2 }
  frame: Float32Array;   // one frame: [time, (mag, tint) * componentCount]
}

interface AnimComponent { name: string; index: number; kind: "vol"|"flow"; models: string[]; tinting: boolean; }
interface AnimLayout    { count: number; stride: number; max_to2: number; }
```

`ChartFrame.rows` is **count×stride** `Float64Array`: row `r`'s time is `rows[r*stride]`, and signal `s` is `rows[r*stride + 1 + slotIndex]`. `AnimFrame.frame` is a single `Float32Array`; a component's two values are read with the `animMagOffset(idx)` / `animTintOffset(idx)` helpers from `@explain/helpers/RealtimeChannels` (`1 + idx*2` and `1 + idx*2 + 1`). In shared transport `frame` is the reader's reusable scratch buffer — copy if you need to retain it.

## Channels handshake & transport

`ChannelsPayload` (the `RT_MSG.CHANNELS` payload) is:

```ts
interface ChannelsPayload {
  descriptor: any;       // transport + SAB/ctrl handles (read by ChannelReader)
  chart: { version: number; slots: string[] };
  anim: { version: number; components: AnimComponent[]; layout: AnimLayout } | null;
}
```

The worker posts this **once per (re)build**, then streams `RT_MSG.CHART` / `RT_MSG.ANIM` (transferable) or writes SABs directly (shared). The bus's `_handleMessage` routes `CHANNELS` → `reader.configure` + every adapter's `onRegistry`, and `CHART`/`ANIM` → `reader.onMessage`. Adapters never see raw messages — only the drained `ChartFrame` / `AnimFrame`. Transport selection (`RT_TRANSPORT.SHARED` when `crossOriginIsolated`, else `TRANSFERABLE`) is invisible to renderers: the same `onFrame` shapes arrive either way.

## ChartRenderer (uPlot)

Strip chart over the fast chart channel. Appends **every** drained row (no dropped samples), keeps a rolling `windowS`-second window, redraws once per frame via `plot.setData`. Holds plain `xs`/`ys[]` arrays. `onRegistry` caches `allLabels = slots.slice(1)` (slot 0 is `time`); `rebuildDisplay` resolves the host-supplied `visible` labels → drawn series + their `displayIdx` data columns, preserving `visible` order regardless of watchlist insertion order.

| Method | Purpose |
|---|---|
| `setVisible(labels)` | Choose which watched channels to plot, in order (colours follow order) |
| `setWindow(seconds)` | Rolling x-window length |
| `setSharedAxis(on)` | All series on one left `y` scale vs. one independent `y<i>` scale + axis each (series 0 left, series 1 right) |
| `setColorOffset(n)` | Shift into the `COLORS` palette (split chart's lone B series → blue) |
| `setAutoScaleY(on)` | Toggle uPlot autoscale; switching OFF snapshots the live ranges and pins them |
| `applyFixedYRange(min,max)` | Pin every active y scale to an explicit range (preset-supplied) |
| `setYRange(key,min,max)` | Edit one locked scale's range; re-feeds data so it applies even when paused |
| `getYAxes()` | Describe editable axes (key/label/color/min/max) for the host controls |
| `setFill(on)` | Translucent area fill under each trace (Doppler-like) |
| `getSeries()` | Snapshot `{ time, labels, cols }` of the rolling buffer for CSV export |

x-scale `range` fn pins exactly `[dataMax - windowS, dataMax]` (no uPlot padding). uPlot's own legend + cursor are disabled; the host draws its own legend. A `ResizeObserver` calls `setSize`.

## LoopRenderer (canvas)

Parametric X-Y plot for closed, non-monotonic loops (PV loop), so it draws a polyline directly on a 2D canvas rather than uPlot. `onRegistry` caches `slots`; `setSignals(x,y)` / `applySignals` resolve `xi`/`yi` via `slots.indexOf`. `onFrame` pushes `(time, x, y)` per row, trims to `windowS` (and a hard `MAX_POINTS = 20000` cap), then `draw()` autoscales to the current point cloud and strokes the trail in blue with rotated axis labels. `getSeries()` returns `{ time, labels:[xSig,ySig], cols:[xs,ys] }`. DPR-aware via `ResizeObserver`.

## MonitorRenderer (canvas sweep)

Bedside-monitor renderer: one canvas, `lanes: MonitorLane[]` stacked vertically with a single shared **sweep head** (refresh bar travels left→right, overwriting the previous pass, with a small blanked erase gap just ahead). Waveforms come off the fast chart stream (`onFrame`); the big numerics come off the **slow 1 Hz stream**, pushed in via `setNumerics`.

```ts
interface MonitorLane {
  signal: string;        // chart slot path, e.g. "Monitor.signals.ecg"
  label: string; color: string; unit: string;
  fill?: boolean;
  fixedRange?: [number, number];               // omit → autoscale over the window
  readNumeric: (n: Record<string, number>) => string;   // big value, slow-keyed
  readSub?:    (n: Record<string, number>) => string;    // small secondary
}
```

`onRegistry` resolves each lane's `signal` → slot index. Per row, time maps to a column `c = floor((time mod windowS)/windowS * plotW)`; the lane's value is written into `cols[li][c]` and `filled[li][c]=1`. `draw()` renders each lane (autoscale or `fixedRange`), the numerics gutter (`GUTTER = 132` px right column), and the shared sweep marker. `setWindow` re-allocs the width-keyed column store; the store is also reset on resize.

`setHighlight(indices)` frames lanes in amber, with an amber caption and a gentle pulse, so a lesson step can point at them. The pulse only animates while frames arrive; a paused sim shows a static frame.

## DiagramRenderer (PixiJS v8)

Viewer **and** editor for the circulation diagram. Lazily imported by `Diagram.vue` so PixiJS lands in its own async chunk. `init()` is async: creates the `Application`, preloads sprite pictos via `Assets.load`, builds procedural glow/vignette textures, then builds compartments and connectors from `diagram.components`.

**Per-frame (`onFrame(_chart, anim)`):** for each compartment, `radiusFromVolume(frame[animMagOffset(idx)])` scales the disc/glow/rim, and `frame[animTintOffset(idx)]` (`to2`) maps through `rgbFromTo2` across the `[to2Lo, to2Hi]` window onto a deox-blue → ox-red ramp, smoothed by `TINT_LERP`. For each connector, the magnitude is `|flow|` (advances + sizes the streaming dot train) and the tint is the upstream component's `to2`. `onRegistry` builds `animIndex[name] = component.index` from `payload.anim.components`.

**Positions:** `sprite.pos.type` is `"arc"` (on the ring at `dgs`), `"rel"` (`x`/`y` in ring radii from the centre) or `"bottom"` (`x` in ring radii, `y` = px up from the canvas bottom edge — the scenario `TITLE` uses it, so the caption sits at the foot of the diagram whatever the panel height or device band). The ring geometry keeps a strip clear for bottom-pinned captions (`footerHeight`: offset + half the caption + a gap, at least the normal margin); a drag keeps a bottom-pinned node bottom-pinned. The edge margin is `settings.ringMargin` px at scaling 1 (default 60, × `scaling`): diagrams whose sprites are large for their scaling raise it — the 0.4-scaled adult scenarios use 135 (adult volumes are ~15× a neonate's), with `yOffset` 0, so the lungs aren't clipped at the top.

**Connector paths:** `layout.path.type` is one of `PATH_TYPES` (`diagramConstants.ts`): `straight`, `arc`/`arc_r` (along the ring between ring nodes, or a chord-arc to an off-ring node), `arc_flip` (that chord-arc mirrored), or `outer` for device lines such as the ECLS cannulas. An `outer` route runs radially out of the ring node, along a concentric track outside the ring, and onto the device node (`outerRoute`, polyline geometry `poly`). The track normally passes through the device node itself. If that arc would cross another node of the same device group (a VV return line heading for RA across the ECLS row), it switches to the bypass track `path.track` (ring radii; ECLS: return 1.6, drainage 1.68, below the row's labels). As a last resort it goes the long way round. A radial run always meets the concentric track at 90°, so `roundCorners` turns each such elbow into a quadratic-Bézier bend (`path.corner`, ring radii, default 0.2, capped at 45% of the adjacent run). Dots on a `poly` move at the same px speed as on a ring arc.

**Live control knobs (no rebuild):** `setScaling`, `setTo2Range(lo,hi)`, `setGrid`/`setGridSize`, `setLabel`, `setPicto`, `setModels`, `setTinting`. Several re-apply immediately so a paused sim updates and persist into `diagram.settings` for export.

**Colour ramp:** `TO2_LO/TO2_HI`, `DEOX_RGB/OX_RGB`, `RAMP_GAMMA` and `rgbFromTo2` live in `diagramConstants.ts`, which has no Pixi. The lesson legend draws the same ramp from there via `to2RampCss()`.

**Device groups:** a component may carry `group: "<name>"` (the ECLS circuit uses `"ecls"`).
- Grouped components are built like any other but start **hidden**; `setGroupVisible(group, on)` shows/hides their sprite, glow, rim, label, paths and dots. `enabled: false` still means "never drawn".
- A connector shows only when its own group and both endpoints are shown, so a line into a hidden device never dangles.
- While any grouped node is visible, the ring shrinks up to open a **device band** below it: `ringR = (H − 2·margin) / (2 + b)` with `b = settings.deviceBand` (default `DEVICE_BAND_DEFAULT` = 0.35 × ringR), centre raised by `b·ringR/2`. Grouped nodes use ordinary `rel` positions (y > 1 lands in the band).
- Layout options that support the band: `sprite.band_pos` is an alternate position used while the band is open (drags in band mode write to it); `sprite.fixed_size` gives a constant disc radius instead of volume sizing (devices whose priming volume would dwarf the heart).
- `setSpin(name, revPerSec)` spins a sprite (and its rim) on top of its authored rotation, advanced by wall-clock time in `onFrame` — so it stops when the sim pauses. Runtime only; `layout.sprite.rotation` and the export are untouched.
- Edit mode shows every group (so device nodes can be positioned); leaving it restores the runtime visibility. Hidden nodes skip per-frame updates and lesson highlights.
- `setConnectorEnds(name, from?, to?)` re-routes a connector's live endpoints (runtime override — the definition's `dbcFrom`/`dbcTo` and the export are untouched); `componentForModel(model)` finds the drawn ungrouped component whose `models` include an engine model (e.g. `RASVC` → `RA`).

**Lesson highlight:** `setHighlight(names, labels)` points at components or connectors by diagram name.
- It draws on its own `highlightG` layer, independent of the editor selection and of edit mode.
- **Components** get an amber pulsing ring round the sprite; **connectors** get a wide amber glow along the path. Each can have an optional caption: under the sprite for a component, at the path midpoint for a connector.
- It is redrawn on the Pixi ticker while active, so it follows volume-scaled sprites and resizes.
- Unknown names are ignored; `[]` clears.

**Editor:** `setEditMode`, `setConnectMode`, sprite drag (`onSpriteDown`/`onDragMove`/`onDragEnd` — snaps to the layout ring or commits a relative position, grid-snap when on), `select`/`clearSelection`/`deleteSelected`/`removeByName`, `addCompartment`, `connect`/`createConnection`, `applyLayoutPatch(name, patch)` (deep-merges into `component.layout` and re-renders live). `setSelectCallback(fn)` notifies the host of selection; `setChangeCallback(fn)` fires after **structural** edits (add/connect/delete/models/tinting) so the host can push the diagram to the engine for a live anim re-bind. `getDiagram()` returns the mutated definition for export. Connector hit-testing uses a `PolylineHitArea` so thin strokes are clickable.

## Wiring

- Engine producer + buffer contract: [RealtimeBus](../../explain-engine/docs/RealtimeBus.md), [ChannelReader](../../explain-engine/docs/ChannelReader.md), [RealtimeChannels](../../explain-engine/docs/RealtimeChannels.md).
- The anim frame layout (`[time, (mag, tint)*N]`) and the `AnimComponent` registry are produced by [AnimationPacker](../../explain-engine/docs/AnimationPacker.md).
- The bus singleton + start/stop gating: `src/composables/useRealtimeBus.ts`.
- Hosts that construct and drive these adapters: [HostComponents](./HostComponents.md).

## Gotchas

- **Shared, additive fast watchlist.** The fast watchlist is global (PV loop's LV props, the always-on ECG counters, other charts' picks all live there). `ChartRenderer` therefore defaults `visible = []` and draws **nothing** until the host calls `setVisible`; signal resolution is by name against `slots`, so a series simply doesn't appear until its watch is applied.
- **`anim.frame` is reused in shared mode.** The diagram smooths tint across frames using its own `cr/cg/cb` fields, but any adapter that retains raw frame values must copy them — the buffer is the reader's scratch.
- **MonitorRenderer is generic.** `Monitor.vue` instantiates it with its `lanes`; it has no monitor-specific assumptions beyond the `MonitorLane` shape, so another host can reuse it with different lanes.
- **Loops use canvas, not uPlot.** A PV loop isn't monotonic in x, so uPlot can't draw it; `LoopRenderer` strokes a raw polyline and autoscales each frame.
- **Width-keyed buffers reset on resize.** `MonitorRenderer`'s column store and the diagram's geometry are recomputed on `ResizeObserver` ticks; the monitor clears its sweep history on a window change.
- **Pixi is lazy.** `DiagramRenderer` is `await import(...)`-ed in `Diagram.vue`; never static-import it into the main bundle. `init()` is async and must complete before `onFrame` does anything (guarded by `ready`).
- **to2 window matters per scenario.** `to2` is O₂ *content*, which scales with Hb; a fixed `[lo, hi]` pegs a low-Hb (adult) circuit blue. The default window is `[3.0, 8.8]`; diagrams override via `settings.to2_lo`/`to2_hi`.
