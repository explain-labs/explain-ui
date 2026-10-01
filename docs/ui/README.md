# Explain — UI Layer Documentation

This directory documents the **Vue 3 + Vite + TypeScript app** under `src/` — the UI that drives the
[Explain physiological simulation engine](../../explain-engine/docs/README.md). The engine (the
framework-agnostic ES modules under `explain-engine/`, a submodule) has its own per-class reference
set in [`explain-engine/docs/`](../../explain-engine/docs/README.md); **this** set covers the app
layer that wraps it.
See the [top-level documentation index](../README.md) for the UI⇄engine map.

**New here?** Start with **[UI_ARCHITECTURE](./UI_ARCHITECTURE.md)** — the whole-UI overview: the
two-plane split (reactive control plane vs. non-reactive ~60 Hz data plane), bootstrap, the
`MainPage` three-column workspace, the toolchain, and the house doc template. Then dive into the
per-area docs below.

Each doc follows the same house template (summary → "what lives here" table → per-unit API tables →
wiring → gotchas), adapted for Vue units. Cross-links into the engine docs use relative paths
(`../../explain-engine/docs/X.md`).

---

## Architecture & entry points

| Doc | What it covers |
|---|---|
| [UI_ARCHITECTURE](./UI_ARCHITECTURE.md) | Whole-UI overview: the two-plane split, `main.ts`/`App.vue` bootstrap, routing + auth gate, the `MainPage` three-column layout & tab map, directory map, toolchain versions, the doc template. |
| [PagesAndAuth](./PagesAndAuth.md) | The three pages (`MainPage`/`LoginPage`/`RegisterPage`), the router + `beforeEach` guard, the `auth` store, and the server-side HttpOnly-cookie security boundary + dev auto-login. |
| [LESSONS](./LESSONS.md) | Guided, bilingual lesson pages (`/lesson/:id`): the lesson file format, step markdown, the intervention registry, ops, and how lesson accounts land on them. |
| [MANUAL](./MANUAL.md) | The interactive manual: guided tours on the simulator (spotlight + step card), the tour file format, `data-tour` targets, ui ops, "try it yourself" gates, and progress. |
| [NICUPICU_INTEGRATION](./NICUPICU_INTEGRATION.md) | nicupicu.nl lesson accounts: one account per congenital heart lesion, entered via `/api/auth/launch` links (static or signed), plus the `scripts/lesson-account.mjs` CLI and the doc to hand to nicupicu. |

## Engine bridge & state

| Doc | What it covers |
|---|---|
| [Composables](./Composables.md) | The six composables: `useExplain` (control-plane singleton over `@explain/Model`), `useRealtimeBus` (data-plane singleton over `RealtimeBus`), `useChartParams`, `useSlowHistory`, `useMonitorPrefs`, `useModelInterface`. |
| [Stores](./Stores.md) | The Pinia stores: `auth`, `model` (scenarios), `states` (cloud saves), `monitors` (dashboards/groups), `events` (scheduled changes), `chat`, `patientBuilder` (see [PatientBuilder](./PatientBuilder.md)), `diagram` (renderer bridge), plus `layout` (MainPage active tabs, see [MANUAL](./MANUAL.md)). |

## Rendering & visualization

| Doc | What it covers |
|---|---|
| [RenderLayer](./RenderLayer.md) | `src/render/`: the `RendererAdapter` contract, the typed buffers (`ChartFrame`/`AnimFrame`), the channels handshake + SAB-vs-postMessage transport, and the four renderers (`ChartRenderer` uPlot, `LoopRenderer`, `MonitorRenderer`, `DiagramRenderer` Pixi). |
| [HostComponents](./HostComponents.md) | `src/components/host/`: `RealtimeChart`, `LoopChart`, `Monitor`, `VentilatorScope`, `Diagram` — the mount → `addRenderer` → `dispose` lifecycle, series selection, CSV export, and the diagram editor + live re-bind. |

## Controls & readouts

| Doc | What it covers |
|---|---|
| [ControlPanels](./ControlPanels.md) | `src/components/controls/`: the generic registry-driven `ModelEditor` plus the bespoke `Ventilator`/`Ecls`/`Resuscitation`/`Pregnancy`/`Scaler`/`EventScheduler`/`SaveState`/`AdminUsersButton` panels, and the `setProp()` vs `call()` write conventions. |
| [Numerics](./Numerics.md) | `src/components/numerics/`: `NumericReadoutPanel` (card grid ⇄ inline editor over a monitors group), `Sparkline`, and the `monitorFormat`/`csv` utilities. |

## Schema & AI bot

| Doc | What it covers |
|---|---|
| [ModelInterface](./ModelInterface.md) | `src/model-interface/`: the UI-owned `InterfaceField` schema, `groupByEditMode`, `MODEL_INTERFACES`/`getInterfaceForType`, why it was relocated out of the engine, and its dual editor + bot-validator consumers. |
| [PatientBuilder](./PatientBuilder.md) | The "Patient builder" tab: the form schema and target rules (`patientSchema`), the bot request / provenance / build-report handling (`patientBuilder` service + store), and Apply / Save. |
| [ChatAndBot](./ChatAndBot.md) | The "Explain AI Bot" tab: `ChatPanel`, the `chat` store + `/api/chat` proxy, and `src/services/` command pipeline (`botCommands` parse→validate→execute + `botCommandAllowlist`). |

---

## See also

- [`../../CLAUDE.md`](../../CLAUDE.md) — the repo quick reference (alias, npm scripts, schema field list).
- [`../../explain-engine/docs/README.md`](../../explain-engine/docs/README.md) — the engine (physics) documentation index.
- [`../../explain-engine/docs/ARCHITECTURE.md`](../../explain-engine/docs/ARCHITECTURE.md) — the engine's two-thread design,
  wire protocol, and the realtime write side the UI's data plane reads from.
