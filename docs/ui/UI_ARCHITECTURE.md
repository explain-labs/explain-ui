# UI Architecture — the Vue layer

The whole-UI developer overview. This directory documents the **Vue 3 + Vite + TypeScript app**
that wraps the framework-agnostic [Explain engine](../../explain-engine/docs/ARCHITECTURE.md). The engine runs
in a Web Worker and speaks a typed wire protocol; the UI's single job is to drive that engine and
render what comes back. The cross-cutting idea that explains every file under `src/` is the
**two-plane split**: a slow, reactive *control plane* and a fast, non-reactive *data plane*. Read
this first, then the per-area docs in [README](./README.md).

> The root [`CLAUDE.md`](../../CLAUDE.md) is the quick reference (alias, npm scripts, the
> `model-interface` field list). These docs are the long form.

---

## 1. The two-plane split (the spine)

The app never lets the ~60 Hz simulation stream touch Vue reactivity — re-rendering components
60×/second would melt the main thread. Instead it runs two parallel pipelines off the same worker.

| | **Control plane** | **Data plane** |
|---|---|---|
| Carries | status, `model_ready`, errors, whole-model state, the ~1 Hz **slow** stream (`rts`) | the ~60 Hz per-frame **fast** stream (chart rows + animation frame) |
| Owner | [`useExplain.ts`](./Composables.md) singleton wrapping [`@explain/Model`](../../explain-engine/docs/ARCHITECTURE.md) | [`useRealtimeBus.ts`](./Composables.md) → [`@explain/realtime/RealtimeBus`](../../explain-engine/docs/RealtimeBus.md) |
| Mechanism | engine events → Vue `ref`/`shallowRef` → Pinia stores → components | a single `requestAnimationFrame` loop drains a [`ChannelReader`](../../explain-engine/docs/ChannelReader.md) and calls each renderer adapter's `onFrame(chart, anim)` |
| Reactive? | **Yes** (this is the only path into Vue refs) | **No** — renderers hold plain typed arrays and paint canvas/WebGL directly |
| Consumers | numeric readouts, control panels, the editor, chat | [host components](./HostComponents.md) + their [render-layer](./RenderLayer.md) adapters |

```
                    ┌──────────────── Web Worker (ModelEngine.js) ────────────────┐
                    │  build/step loop · DataCollector · ChannelWriter            │
                    └───────▲───────────────────────────┬─────────────────────────┘
       control plane        │ events (state, rts, …)    │ RT_MSG.CHART / ANIM
       (≤1 Hz, reactive)    │                           │ (≈60 Hz, typed buffers)
                    ┌───────┴────────┐          ┌────────▼─────────┐
                    │  useExplain    │          │  useRealtimeBus  │  rAF loop
                    │  (singleton)   │          │  (singleton)     │
                    └───────┬────────┘          └────────┬─────────┘
              Pinia stores ─┤                            │ onFrame(chart, anim)
              components ────┘                  renderer adapters (uPlot / canvas / Pixi)
```

Transport for the data plane is **SharedArrayBuffer** when the page is cross-origin isolated
(`globalThis.crossOriginIsolated === true` — surfaced in `MainPage.vue` as the `COI` indicator),
otherwise transferable `postMessage`. The choice is invisible to the UI; the bus handles both.

See [RenderLayer](./RenderLayer.md) for the typed-buffer formats and the channels handshake, and the
engine-side write docs: [ChannelWriter](../../explain-engine/docs/ChannelWriter.md),
[RealtimeChannels](../../explain-engine/docs/RealtimeChannels.md), [AnimationPacker](../../explain-engine/docs/AnimationPacker.md).

---

## 2. Bootstrap

`src/main.ts` is the entire startup:

```ts
createApp(App)
  .use(createPinia())                                  // state management
  .use(router)                                         // 3-route history router
  .use(PrimeVue, { theme: { preset: DarkBlue,          // Aura, primary remapped emerald → blue
                            options: { darkModeSelector: ".dark" } } })
  .use(ConfirmationService)
  .directive("tooltip", Tooltip)                       // the v-tooltip used across MainPage
  .mount("#app");
```

`DarkBlue` is a `definePreset(Aura, …)` that overrides the semantic `primary` palette to `{blue.*}`
so buttons/selectors read dark-blue. Global CSS is `primeicons/primeicons.css` + `src/styles/theme.css`.

`src/App.vue` is a one-liner — just `<router-view />`. All real UI is reached through the router.

### Routing & the auth gate

`src/router/index.ts` (`createWebHistory`) has four routes:

| Path | Name | Component | Meta |
|---|---|---|---|
| `/` | `main` | `MainPage.vue` | `requiresAuth: true` |
| `/login` | `login` | `LoginPage.vue` | — |
| `/register` | `register` | `RegisterPage.vue` | — |
| `/lesson/:id` | `lesson` | `LessonPage.vue` (lazy) | `requiresAuth: true` — guided lessons, see [LESSONS](./LESSONS.md) |

A `beforeEach` guard rehydrates the session on first navigation (`if (!auth.ready) await auth.fetchMe()`),
redirects unauthenticated users away from protected routes to `/login?redirect=…`, and bounces
already-authed users off `/login`/`/register`. This is a **UX gate only** — the real security boundary
is the server-side HttpOnly session cookie checked by `/api`. See [PagesAndAuth](./PagesAndAuth.md).

---

## 3. The workspace — `MainPage.vue`

Everything the user interacts with lives in one page, gated on `modelReady`. It is a three-column
flex layout, each column a PrimeVue `Tabs` group, with sticky top and bottom bars.

```
┌─ top bar ── logo · "Active state: <name>" ········· user email · AdminUsersButton · Sign out ─┐
├───────────────┬──────────────────────────────────────────────┬──────────────────────────────┤
│ controlTab    │ vizTab                                        │ monitorTab                   │
│ (left ¼)      │ (center ½)                                    │ (right ¼)                    │
│               │                                               │                              │
│ editor        │ diagram | chart | loop | chat | builder |     │ monitoring | monitor         │
│ tasks         │   sle6000 | docs                              │                              │
│ ecls          │ Diagram · RealtimeChart · LoopChart ·         │ (NumericReadoutPanel ×N,     │
│ resuscitation │ ChatPanel · PatientBuilderPanel ·             │  dashboard switcher,         │
│ pregnancy     │ Sle6000Screen · DocViewer                     │  compact/trend prefs,        │
│ scaler        │                                               │  manage/export) ·            │
│ events        │                                               │ Monitor                      │
├───────────────┴──────────────────────────────────────────────┴──────────────────────────────┤
└─ bottom bar ── COI/MODEL/STATUS · ▶/■ + fast-forward(calcSecs) · local-scenario loader · Save ┘
```

| Column | Tab values | Components | Doc |
|---|---|---|---|
| Left (`controlTab`) | `editor` `tasks` `ecls` `resuscitation`¹ `pregnancy`¹ `scaler`¹ `events` | `ModelEditor`, `CommonTasksPanel`, `EclsPanel`, `ResuscitationPanel`, `PregnancyPanel`, `ScalerPanel`, `EventSchedulerPanel` | [ControlPanels](./ControlPanels.md) |
| Center (`vizTab`) | `diagram` `chart` `loop` `chat` `builder` `sle6000` `docs` | `Diagram`, `RealtimeChart`, `LoopChart`, `ChatPanel`, `PatientBuilderPanel`, `Sle6000Screen` (the ventilator; no HFOV yet), `DocViewer` | [HostComponents](./HostComponents.md), [ChatAndBot](./ChatAndBot.md), [PatientBuilder](./PatientBuilder.md) |
| Right (`monitorTab`) | `monitoring` `monitor` | `NumericReadoutPanel` (×group), `Monitor` | [Numerics](./Numerics.md), [HostComponents](./HostComponents.md) |

¹ Unfinished: hidden in production builds, shown under `npm run dev` (`UNFINISHED_PANELS` in `MainPage.vue`).

The bottom bar holds the run controls: a single ▶/■ toggle (also bound to **Spacebar**, suppressed
while typing in inputs), a fast-forward `calculate(calcSecs)` button with a `CALC_OPTIONS`
(`5/10/30/60/120/300 s`) selector, a model-developer-only local-scenario `Select` (+ startup-default
star + delete), and [`SaveStatePanel`](./ControlPanels.md). Scenario selection loads immediately via a
watcher on `current` (no Load button). Startup priority: model-developer default local scenario →
user default cloud state → bundled `term_neonate`.

---

## 4. Directory map

| Path | Holds | Doc |
|---|---|---|
| `src/main.ts`, `src/App.vue` | bootstrap + `<router-view>` shell | §2 above |
| `src/router/` | the 4-route history router + auth/lesson guard | [PagesAndAuth](./PagesAndAuth.md) |
| `src/pages/` | `MainPage` / `LessonPage` / `LoginPage` / `RegisterPage` (the "views") | [PagesAndAuth](./PagesAndAuth.md) |
| `src/lessons/`, `src/components/lesson/` | lesson content, intervention registry, lesson page parts | [LESSONS](./LESSONS.md) |
| `src/composables/` | engine bridge, realtime bus, chart params, slow history, prefs | [Composables](./Composables.md) |
| `src/stores/` | Pinia: `auth`, `model`, `states`, `monitors`, `events`, `chat`, `diagram` | [Stores](./Stores.md) |
| `src/components/host/` | renderer host wrappers (mount canvas, register adapter) | [HostComponents](./HostComponents.md) |
| `src/components/controls/` | model editor + bespoke subsystem panels + chat | [ControlPanels](./ControlPanels.md), [ChatAndBot](./ChatAndBot.md) |
| `src/components/numerics/` | `NumericReadoutPanel`, `Sparkline` | [Numerics](./Numerics.md) |
| `src/render/` | non-reactive uPlot / canvas / Pixi adapters + typed-buffer types | [RenderLayer](./RenderLayer.md) |
| `src/model-interface/` | UI-owned parameter-edit schema (relocated out of the engine) | [ModelInterface](./ModelInterface.md) |
| `src/services/` | bot command parse/validate/execute + allowlist | [ChatAndBot](./ChatAndBot.md) |
| `src/utils/` | `csv.ts`, `monitorFormat.ts` (pure helpers) | [Numerics](./Numerics.md) |
| `src/styles/` | `theme.css` | — |

> There is **no `views/`** directory (the pages are in `src/pages/`) and **no `ParameterPanel.vue`**
> (the generic editor is `controls/ModelEditor.vue`).

---

## 5. Toolchain

From `package.json` (caret ranges = minimums; `package-lock.json` pins exact resolutions):

| Area | Library | Version |
|---|---|---|
| Framework | `vue` | `^3.5.0` |
| Router | `vue-router` | `^4.4.0` |
| State | `pinia` | `^2.2.0` |
| UI kit | `primevue` / `@primevue/themes` / `primeicons` | `^4.2.0` / `^4.2.0` / `^7.0.0` |
| Styling | `tailwindcss` + `@tailwindcss/vite` + `tailwindcss-primeui` | `^4.0.0` / `^4.0.0` / `^0.6.0` |
| Charts | `uplot` | `^1.6.0` |
| Diagram | `pixi.js` | `^8.6.0` |
| Markdown | `markdown-it` | `^14.2.0` |
| Build | `vite` / `@vitejs/plugin-vue` / `typescript` / `vue-tsc` | `^6.0.0` / `^5.2.0` / `^5.7.0` / `^2.1.0` |

> PrimeVue 4 and Tailwind 4 are both major rewrites of their v3 APIs — match the major when consulting
> external docs. The engine is imported through the `@explain` alias (set in `vite.config.ts` /
> `tsconfig.json`); `@` maps to `src/`.

Scripts: `npm run dev` (Vite), `npm run build` (`vue-tsc --noEmit && vite build`), `npm run typecheck`,
`npm run preview`; `npm start`/`npm run serve` run the production Node server (`server/index.mjs`).

---

## 6. The UI house-doc template

Each per-area doc in this folder follows the same shape (the UI analogue of the engine template in
[ARCHITECTURE §9](../../explain-engine/docs/ARCHITECTURE.md)):

1. **Title + one-paragraph summary** — what this layer is, in plain terms.
2. **What lives here** — a `File | Responsibility` table for the files the doc covers.
3. **Per-unit sections** — for each composable/store/component/renderer: its reactive state +
   exported API (or props/emits), in pipe tables.
4. **Wiring** — how it connects to the engine, the other plane, and sibling layers, using real symbol
   names and relative cross-links (`[RealtimeBus](../../explain-engine/docs/RealtimeBus.md)`, `[Stores](./Stores.md)`).
5. **Gotchas** — the non-obvious constraints (`shallowRef`, singleton lifecycles, additive watchlists,
   the server-cookie auth boundary, lazy Pixi import, …).
