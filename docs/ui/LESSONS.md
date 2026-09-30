# Lessons

A lesson is a guided, step-by-step page at **`/lesson/<id>`**, built for the [nicupicu.nl](https://nicupicu.nl) modules on congenital heart lesions. Each step shows text (and optionally an image) beside the live model. The model is shown as a diagram without an edit toolbar, a trimmed bedside monitor and a chosen set of numerics. There are also intervention controls, such as opening and closing the ductus arteriosus or foramen ovale. Lesson text is bilingual (NL/EN) with a toggle in the header.

Lessons are **files in this repo**, bundled with the app. The working example is `src/lessons/tof/` (severe tetralogy of Fallot on the `tof_severe` scenario).

## What lives here

| File | Role |
|---|---|
| `src/lessons/<id>/lesson.ts` | The lesson definition: `export default defineLesson({...})` |
| `src/lessons/<id>/steps/<step>.<nl\|en>.md` | Step text, one markdown file per step per language |
| `src/lessons/<id>/img/*` | Images, used as a step `image` or from markdown as `![alt](img/file.svg)` |
| `src/lessons/types.ts` | Schema: `Lesson`, `LessonStep`, `LessonAction`, `LessonNumeric`, `Op` |
| `src/lessons/interventions.ts` | Intervention registry (`INTERVENTIONS`): the controls lessons can offer |
| `src/lessons/index.ts` | Registry: `getLesson`, `hasLesson`, `listLessons`, `loadStepMarkdown`, `imageUrl` (Vite globs) |
| `src/lessons/i18n.ts` | `Lang`, `L10n`, `t()`, `useLessonLang()` (persisted in localStorage), UI strings |
| `src/composables/useLesson.ts` | Runtime: load, step navigation, `applyOps`, control state |
| `src/pages/LessonPage.vue` | The page layout |
| `src/components/lesson/LessonStepPanel.vue` | Step title, markdown, image, action buttons, prev/next |
| `src/components/lesson/LessonControls.vue` | Renders the lesson's interventions |
| `src/utils/markdown.ts` | Shared markdown-it setup (`html:false`, external links in a new tab, lesson image paths) |

## Adding a lesson

1. Create `src/lessons/<id>/lesson.ts`. The `id` must equal the folder name. For a nicupicu lesson it must also equal the lesson account id.
2. Write `steps/<step-id>.nl.md` and `.en.md` for each step. A missing language falls back to the other.
3. Open `/lesson/<id>` in `npm run dev`. It is picked up automatically: the non-lesson MainPage header gets a **Lessons** menu, and a lesson account with this id lands on the page.

```ts
import { defineLesson } from "@/lessons/types";

export default defineLesson({
  id: "tof",
  title: { nl: "Tetralogie van Fallot", en: "Tetralogy of Fallot" },
  scenario: "tof_severe",                 // file stem in model_definitions/
  controls: ["ductus", "foramen_ovale"],  // ids from interventions.ts
  monitorLanes: ["ecg", "spo2_pre", "spo2_post", "abp"],
  numerics: [{ key: "vitals", title: "Vitals", parameters: [
    { label: "SpO₂ pre", props: ["Monitor.sao2_pre"], unit: "%" },
  ]}],
  steps: [
    { id: "duct-dependent", title: { nl: "…", en: "…" },
      highlight: ["Monitor.sao2_pre"],     // numeric cards to ring
      controls: ["ductus"],                // interventions to spotlight
      actions: [{ id: "close", label: { nl: "Sluit de ductus", en: "Close the duct" },
                  ops: [{ kind: "control", id: "ductus", state: "off" }] }] },
  ],
});
```

### `Lesson`

| Field | Meaning |
|---|---|
| `id`, `title`, `subtitle?` | Identity and header text (`L10n`: a string, or `{ nl, en }`) |
| `scenario` | Bundled scenario to start from. A lesson account's `stateId` (curated cloud state) overrides it; the account's `scenario` field does **not** |
| `autoRun?` | Start the realtime loop once the model is built (default `true`) |
| `runOnAction?` | Start the loop when an op is applied while paused (default `true`) |
| `controls` | Intervention ids, in display order. A control whose `requires` models are missing from the scenario is hidden |
| `numerics` | Groups of numeric cards: `{ key, title, collapsed?, parameters: [{ label, props, unit?, factor?, rounding?, weight_based? }] }`. These are the same display rules as `configuration.monitors` (see [Numerics](./Numerics.md)) |
| `monitorLanes?` | Bedside-monitor lanes (`ecg`, `spo2_pre`, `spo2_post`, `abp`, `resp`, `co2`). Default is the first four |
| `steps` | The step sequence |

### `LessonStep`

| Field | Meaning |
|---|---|
| `id` | Also the markdown file stem |
| `title` | Step title (and the tooltip on the header step dot) |
| `image?` | `{ file, caption? }`: a file in `img/`, shown under the text |
| `actions?` | Buttons: `{ id, label, icon?, severity?, ops }` |
| `highlight?` | Numeric paths (a card's first `props` entry) to ring amber on this step |
| `diagramHighlight?` | Diagram component/connector names (e.g. `DA`, `FO`, `VSD`, `RV_AA`) to point at with a pulsing amber outline and caption. Names missing from the scenario are skipped |
| `diagramLabels?` | Caption per highlighted name, overriding the shared names in `src/lessons/diagramLabels.ts`. `""` highlights without a caption |
| `monitorHighlight?` | Monitor lanes (`LaneId`) to frame in amber |
| `source?` | Folder the step's markdown/images come from (default: the lesson's own). The shared intro uses `"_shared"` |
| `controls?` | Intervention ids to spotlight. All controls stay usable on every step |
| `onEnter?` | Ops applied when the learner arrives on the step (and on the first load if the page opens on it) |
| `draft?` | Shown only in dev builds, with a "draft" tag |

### Ops

Actions, `onEnter` and button interventions are lists of ops, applied in order:

| Op | Effect |
|---|---|
| `{ kind: "set", path, value, it?, at? }` | `setProp(path, value, it=1, at=0)`: numbers tween over `it` s of model time, booleans/strings swap |
| `{ kind: "call", fn, args?, at? }` | `call(fn, args, at)`, e.g. `fn: "Drugs.set_infusion", args: ["pge1", 0.05]` |
| `{ kind: "control", id, state }` | Drive an intervention: `"on"`/`"off"` for toggles, a raw number for sliders |
| `{ kind: "calculate", seconds }` | Fast-forward model time synchronously |
| `{ kind: "run" }` / `{ kind: "pause" }` | Start/stop the realtime loop |
| `{ kind: "restart" }` | Rebuild the starting state and return to step 1 |

## Shared intro and diagram legend

`src/lessons/_shared/intro.ts` exports `introSteps()`: three "how to read Explain" steps. Their markdown is in `_shared/steps/`. A lesson prepends them with `steps: [...introSteps(), …]`.

| Step | Covers | Points at |
|---|---|---|
| `read-diagram` | Colour = O₂ content (mixed blood still looks blue), size = blood volume, moving dots = flow | LA, RA, LV, RV |
| `read-shunts` | Connectors and shunt direction | DA, FO, VSD |
| `read-monitor` | ECG, pre- vs post-ductal SpO₂ (AA vs AD), post-ductal ABP, and the flow-card sign convention | SpO₂ pre/post lanes and the DA/FO flow cards |

The lesson page also overlays `DiagramLegend.vue` on the diagram. It is collapsible, remembers its state per browser, and its colour bar samples the renderer's own ramp.

## Adding an intervention

Add one entry to `INTERVENTIONS` in `src/lessons/interventions.ts`, then name its id in a lesson's `controls` (or drive it from an action with a `control` op).

| Kind | Fields | UI |
|---|---|---|
| `toggle` | `read` (`Model.prop`), `on`/`off`: `{ label, value, it? }` | Two-option switch. `value: "baseline"` = the value the scenario was built with |
| `slider` | `read`, `min`/`max`/`step` (display units), `unit?`, `factor?` or `percentOf?`, `rounding?`, `it?`, `toOps?` | Slider (applied on release) plus a number field (applied on Enter/blur). The default applies a `set` on `read`; `toOps(raw)` replaces it (e.g. for a drug infusion `call`) |
| `button` | `ops`, `icon?` | One-shot button |

All kinds take `label`, `help?` (a line under the control) and `requires?` (model names that must exist).

Slider details:
- **Display units:** display = raw × `factor`. With `percentOf: "Model.maxProp"`, display = raw / max × 100 instead.
- **Tween duration:** `it` is the duration of a **full-range** move. A smaller move tweens proportionally faster, with a minimum of 1 s.
- **Control ops:** a `control` op with `"off"` moves the slider to its minimum, and `"on"` moves it to the scenario's baseline value.
- **The two current sliders:**
  - `ductus` shows `Pda.diameter_relative` as a percentage of the maximum duct diameter. Fully closing from 100% takes 50 s, so from the ToF baseline (60%) it takes 30 s.
  - `foramen_ovale` shows `Shunts.diameter_fo` as a percentage of `Shunts.diameter_fo_max`, which is 10 mm.

A toggle shows whichever of its two values the current value is nearer to. While a control is moving, it shows a "closing…/opening…" label until the tween arrives; a slider also shows "current → target". A step action button that drives the control fills up as a progress bar and shows the percentage. Only the button whose direction matches fills: an `"off"` op fills while closing, any other while opening. Progress is how far the value has moved from its start toward the target; tweens are linear in model time. It updates at the slow-stream rate (~1 Hz), and a paused model holds it where it is.

Lessons open in Dutch (`DEFAULT_LANG` in `i18n.ts`). A learner's NL/EN choice is remembered per browser.

Check engine paths against the scenario first (Model editor, or `modelState` from `useExplain()`). Candidates noted for the ToF lesson:
- **PGE1:** `call Drugs.set_infusion ["pge1", rate]`.
- **FiO₂:** `Gas.fio2`.
- **Knee-chest (SVR up):** `Circulation.svr_factor_art`.
- **Tet spell:** tween `RV_PA.r_factor_ps` ×3–5 over about 20 s. See the tet-spell recipe in [`chd_duct_fo_dependent.md`](../../explain-engine/docs/chd_duct_fo_dependent.md).

## Gotchas

- **Changes need a running model.** `setProp`/`call` only queue work on the engine's TaskScheduler, which runs inside the step loop. The lesson therefore auto-runs, and applying an op while paused starts the loop (`runOnAction`).
- **Going back doesn't undo.** Step navigation doesn't restore the model. If a step needs a known state, put explicit ops in its `onEnter` (e.g. `{ kind: "control", id: "ductus", state: "on" }`), or use a `restart` action.
- **A duct closed to exactly 0 can't be reopened by PGE1.** At `diameter_relative === 0` the Pda takes its closed-duct shortcut, and the drug factor multiplies the diameter. Reopening with a `set`/toggle works. A future PGE1 lesson should close to a small value (e.g. 0.05) instead. See [`Pda.md`](../../explain-engine/docs/Pda.md).
- **`Shunts.diameter_vsd` must stay ≤ 5 mm**, or the step loop becomes unstable.
- **Model time vs. real time.** Tweens run in model time. In realtime that is about wall-clock time, so keep durations short (a 30 s duct closure stands in for hours).
- **Readonly.** The lesson page has no save UI, and the server refuses writes for readonly lesson accounts anyway.

## Wiring

```
/api/auth/launch ─302→ / ─router.beforeEach─ auth.lesson.id has content? ─yes→ /lesson/<id>
                                                                         └─no──→ MainPage (loadLesson fallback)
LessonPage ── useLesson(lesson) ── provide(LessonKey)
   │            │ load(scenario) | loadFromObject(cloud state)
   │            │ modelReady → watchSlow(control paths) → onEnter → start()
   ├─ LessonStepPanel (inject)  markdown via loadStepMarkdown + renderMarkdown
   ├─ Diagram :toolbar=false · Monitor :lanes   (inside v-if="modelReady")
   ├─ NumericReadoutPanel :highlight=step.highlight
   └─ LessonControls (inject)   applyControl → setProp/call (+ start if paused)
```

The router guard also keeps a lesson account on its own lesson (`/lesson/other` redirects back) and sends unknown ids to `/`. `App.vue` keys `<router-view>` on the route name + id, so switching lessons remounts the page. A `?step=` change does not remount it.
