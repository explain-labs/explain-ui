# Interactive manual

The interactive manual is a set of **guided tours** that run as an overlay on the real simulator (`MainPage`). Each step dims the page, frames one element in the amber spotlight used by the lessons, and shows a card next to it with the step text. A step can switch a column's tab first, apply engine ops, reuse the lesson highlights inside the diagram, monitor and numeric cards, and wait for the learner to do something ("Try it yourself").

Users open it from **Help** in the MainPage header. On a first visit (no stored progress), the header also offers *New here? Take the tour*. Lesson accounts don't see either. The text is English only.

The manual is related to [LESSONS](./LESSONS.md), but the two do different jobs. A lesson is its own page about physiology. The manual explains the interface, on the interface itself.

## What lives here

| File | Role |
|---|---|
| `src/manual/tours/<id>/tour.ts` | A tour: `export default defineTour({...})`. The `id` must equal the folder name |
| `src/manual/tours/<id>/steps/<step>.md` | Step text (markdown, `html:false`), one file per step |
| `src/manual/types.ts` | Schema: `Tour`, `TourStep`, `UiOp`, `AdvanceOn`, `TourOp` (the lesson `Op` minus `control`/`restart`) |
| `src/manual/targets.ts` | `TOUR_TARGETS`: every allowed `data-tour` key (type-checked), plus `findTarget()` |
| `src/manual/index.ts` | Registry built from Vite globs: `getTour`, `listTours`, `toursByChapter`, `loadStepMarkdown` |
| `src/composables/useTour.ts` | Singleton runtime: start/next/prev/stop, ui ops, target lookup, gates, progress, canvas highlights |
| `src/components/manual/TourOverlay.vue` | Dimming, spotlight ring and step card (positioned with `@floating-ui/dom`) |
| `src/components/manual/ManualMenu.vue` | The header **Help** button and chapter/tour list |
| `src/stores/layout.ts` | Active tab of each MainPage column (`controlTab`/`vizTab`/`monitorTab`), so tours can switch tabs |

## Adding a tour

1. Create `src/manual/tours/<id>/tour.ts` with `defineTour({ id, title, summary, chapter, order, steps })`. `chapter` groups tours in the Help menu, and `order` sorts them.
2. Write `steps/<step-id>.md` for each step.
3. If a step points at something new, add `data-tour="<area>.<thing>"` to that element and add the key to `TOUR_TARGETS`. Put the attribute on a stable, visible element: PrimeVue components and single-root components forward it to their root. Don't use `display: contents`, because it has no box to spotlight.
4. `npm run dev`, then open **Help** and run the tour. A missing target logs `manual: tour … target … not found` in the console (dev only).

## `TourStep`

| Field | Meaning |
|---|---|
| `id`, `title` | The id is also the markdown stem |
| `target` | `data-tour` key to spotlight. If omitted (or not found within 3 s), the card is centred with no spotlight |
| `placement` | Preferred side for the card: `top`/`bottom`/`left`/`right`. It flips or shifts to stay on screen |
| `ui` | Applied in order before the step shows: `{ tab: "control"\|"viz"\|"monitor", value }` switches a column's tab, `{ click: key }` clicks an element (e.g. to open a popover) |
| `onEnter` | Engine ops (`set`, `call`, `calculate`, `run`, `pause`), the same as lesson ops. Only applied when a model is loaded |
| `diagramHighlight`, `diagramLabels` | Diagram names to ring, with captions. Defaults come from `src/lessons/diagramLabels.ts` (English) |
| `monitorHighlight` | Patient-monitor lanes to frame |
| `numericHighlight` | Numeric card paths (`props[0]`) to ring on the monitoring dashboard |
| `advanceOn` | A "Try it yourself" gate: `{ tab, value }`, `{ running: true\|false }`, `{ click: true }` (click on the target) or `{ appear: key }` (a `data-tour` element shows up, e.g. the diagram inspector once something is selected). Next becomes Skip, and the tour continues when the condition is met. A condition that already holds on arrival doesn't gate |

## Behaviour

- The page outside the spotlight is inert: four blockers surround the hole. The spotlit element itself stays clickable. The dimming sits at z 900, below PrimeVue overlays (z 1000+), so a Select or Popover opened from the target still shows on top. The ring and card sit at z 1199–1200, above the modal mask (z 1100), so a step can point into a Dialog.
- The target's position is re-read every animation frame while a tour runs, so tab switches, panel growth and scrolling are followed. The target is scrolled into view on step entry.
- Keys: ←/→ step, Esc closes. They are ignored while typing in a field. Space still toggles the simulation.
- Progress (finished tours, last step) is stored in localStorage under `explain.manual.progress`. Finished tours get a ✓ in the menu, and *Reset progress* clears it.

## Gotchas

- Tours that need a model element (most of them) are disabled in the menu until a model is loaded. Set `needsModel: false` for a tour that doesn't.
- Panels behind role checks (e.g. *Save to cloud* for model developers) can be missing for some users. Write the step text so it still makes sense when the target falls back to a centred card.
- Going back does not undo `onEnter` ops.
- A target with no box (`display: none`, a collapsed section) is treated as missing: the card is centred. When several elements share a key (one per list row), `findTarget` picks the first **visible** one. The `appear` gate also waits for the element to be visible, not just mounted (so v-show'n rows count only once shown).

## Roadmap

1. Getting started *(done)*: layout, scenario, run, diagram, monitors, fast-forward, panels, saving.
2. Diagram editing *(done)*: edit mode, add, select/move, inspector, connect, view settings, export/import.
3. Charts and PV loops *(done)*: series, view options, presets, CSV, reading a PV loop.
4. Monitoring dashboards *(done)*: reading cards, toolbar, dashboards, groups, the group editor.
5. Model editor *(done)*: picking a model, sections, field types, factors, functions, refresh, keeping/undoing.
6. Common tasks *(done)*: categories, −/+ and step size, reset, watching the effect, the bot.
7. Ventilator: the generic-panel tour was removed with that panel (the ventilator is now the SLE6000 replica); an SLE6000 tour is still to be written.
8. ECLS *(done)*: running/clamping, pump and oxygenator devices, sweep gas, cannulas and sites (VA/VV), resistance factors, measurements, the circuit in the diagram.
9. Resuscitation and pregnancy *(on hold: the panels are not ready yet)* · 10. Event scheduler *(done; the scaler is on hold: not finished yet)* · 11. AI bot *(done)*: questions, action cards, what it can do, Guided/Full, auto-apply, attachments, revert · 12. Saving and loading states *(done)*: what a state holds, cloud saves, My saved states, default state, scenarios vs states, developer snapshots.
