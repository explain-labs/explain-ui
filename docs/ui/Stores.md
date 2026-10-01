# Stores

The Pinia stores in `src/stores/` hold the app's **control-plane** state: the authenticated session, the scenario catalog and selection, server-persisted saved states, and the editable scenario sub-objects (monitors, events) plus the chat/diagram bridges. None of them carry per-frame telemetry. This is the app's **two-plane split**: the control plane — engine status, `model_ready`, errors, whole-model state, and the ~1 Hz slow stream — reaches these stores through `src/composables/useExplain.ts` (the singleton wrapping `@explain/Model`); the ~60 Hz **data plane** is owned by `src/composables/useRealtimeBus.ts` → [RealtimeBus](../../explain-engine/docs/RealtimeBus.md) and **never** touches a store. Everything visible lives inside `src/pages/MainPage.vue`. See [Composables](./Composables.md) for the engine-facing layer.

## What lives here

| File | Responsibility |
|---|---|
| `src/stores/auth.ts` | Authenticated session (MongoDB cookie session; dev auto-login) |
| `src/stores/model.ts` | Scenario catalog + current selection |
| `src/stores/states.ts` | Per-user cloud-saved model states (CRUD via `/api/states`) |
| `src/stores/monitors.ts` | Monitor dashboards/groups/params editor, mirrored to scenario JSON |
| `src/stores/events.ts` | Named scheduled-event bundles, mirrored to scenario JSON |
| `src/stores/chat.ts` | Explain-Labs bot chat + bot-proposed model/diagram commands |
| `src/stores/patientBuilder.ts` | Patient-builder form, its bot request and result — see [PatientBuilder](./PatientBuilder.md) |
| `src/stores/diagram.ts` | Bridge publishing the live `DiagramRenderer` to the chat pipeline |

## `auth`

Mirrors the public user fields the server returns; the session itself is an HttpOnly cookie (JS never holds a token). In dev (`import.meta.env.DEV`) `fetchMe()` auto-logs-in a local `developer` account. `hasDb` is false in dev when the server has no `MONGODB_URI` (local mode), and the cloud/admin UI hides on it.

| State | Type | Description |
|---|---|---|
| `user` | `Ref<AuthUser \| null>` | Public user fields (`email`, `name`, `admin`, `institution`, `modelDeveloper`, `defaultState`, `defaultLocalState`) |
| `status` | `Ref<"idle"\|"loading"\|"authed"\|"error">` | Auth lifecycle |
| `error` | `Ref<string \| null>` | Last auth error |
| `ready` | `Ref<boolean>` | Initial cookie check complete (router guard gate) |
| `isAuthenticated` | `ComputedRef<boolean>` | `user !== null` |

| Method | Signature | Description |
|---|---|---|
| `login` | `(email, password) => Promise<boolean>` | `POST /api/auth/login` (cookie session) |
| `register` | `(fields) => Promise<boolean>` | `POST /api/auth/register`; server signs in on success |
| `fetchMe` | `() => Promise<boolean>` | Rehydrate from cookie; dev bypass auto-login |
| `logout` | `() => Promise<void>` | `POST /api/auth/logout`; clears client state regardless |
| `listUsers` | `() => Promise<AuthUser[]>` | Admin: `GET /api/auth/users` |
| `setModelDeveloper` | `(email, value) => Promise<AuthUser \| null>` | Admin: toggle model-developer flag |
| `setDefaultLocalState` | `(name \| null) => void` | Dev: persist startup scenario to `localStorage["explain.model.defaultLocalState"]` |

## `model`

The scenario catalog. Pure control-plane; realtime data never lives here.

| State | Type | Description |
|---|---|---|
| `scenarios` | `Ref<string[]>` | Names from `/model_definitions/index.json` |
| `current` | `Ref<string \| null>` | Currently selected scenario name |

| Method | Signature | Description |
|---|---|---|
| `fetchScenarios` | `() => Promise<void>` | Load `/model_definitions/index.json` into `scenarios` |

## `states`

Per-user states persisted server-side in MongoDB (`server/states.mjs`). The reloadable file object is assembled by `SaveStatePanel.vue` (same shape as a file snapshot); the cookie identifies the owner server-side.

| State | Type | Description |
|---|---|---|
| `savedStates` | `Ref<SavedStateSummary[]>` | List (`id`, `name`, `description`, timestamps) |
| `loading` | `Ref<boolean>` | List fetch in flight |
| `error` | `Ref<string \| null>` | Last error |
| `currentId` | `Ref<string \| null>` | Id of the cloud state loaded into the engine (`null` for local/file) |

| Method | Signature | Description |
|---|---|---|
| `setCurrent` | `(id \| null) => void` | Set the active cloud-state id |
| `fetchList` | `() => Promise<void>` | `GET /api/states/list` |
| `saveCurrent` | `({name, description?, file}) => Promise<boolean>` | `POST /api/states/save`; sets `currentId` |
| `loadState` | `(id) => Promise<any \| null>` | `GET /api/states/get`; returns the reloadable file object |
| `deleteState` | `(id) => Promise<boolean>` | `POST /api/states/delete` |
| `setDefault` | `(id \| null) => Promise<boolean>` | Flag a cloud state default; mirrors `auth.user.defaultState` |
| `setDefaultLocal` | `(name \| null) => Promise<boolean>` | Model-dev local startup scenario; mirrors `auth.user.defaultLocalState` |
| `has` | `(name) => boolean` | Whether a saved state with that name exists |

## `monitors`

Monitor **dashboards** live in `loadedFileData.configuration.monitor_dashboards` (array; each owns a keyed `monitors` object). Legacy single `configuration.monitors` scenarios are migrated into one default dashboard. The store mirrors them in memory as **ordered arrays** (array order ⇄ object-key insertion order round-trips on persist) and debounce-auto-saves edits.

| State | Type | Description |
|---|---|---|
| `dashboards` | `Ref<MonitorDashboard[]>` | All dashboards `{ id, name, groups }` |
| `activeId` | `Ref<string>` | Selected dashboard id (view-only, not persisted) |
| `activeDashboard` | `ComputedRef<MonitorDashboard \| null>` | Active dashboard (falls back to first) |
| `groups` | `ComputedRef<MonitorGroup[]>` | Active dashboard's groups — what panels render |

Key methods: `syncFromScenario()` (reload from the loaded file), dashboard CRUD `addDashboard`/`removeDashboard`/`renameDashboard`/`moveDashboard`/`setActive`, group CRUD `addGroup`/`removeGroup`/`moveGroup`, param CRUD `addParam`/`removeParam`/`moveParam`, and `persist()`. A `MonitorParam` is `{ label, unit?, factor?, rounding?, props?, weight_based? }` where `props` are engine dot-paths (two props render as `a/b`).

## `events`

Named, reusable bundles of timed property changes, stored in `loadedFileData.configuration.events`. Driven by the engine [TaskScheduler](../../explain-engine/docs/TaskScheduler.md) when fired.

| State | Type | Description |
|---|---|---|
| `events` | `Ref<ScheduledEvent[]>` | `{ id, name, changes[], fire_at, armed }` bundles |

| Method | Signature | Description |
|---|---|---|
| `syncFromScenario` | `() => void` | Reload from `configuration.events` (structuredClone) |
| `upsert` | `(ev) => void` | Insert or replace by `id` |
| `remove` | `(id) => void` | Delete by `id` |
| `persist` | `() => Promise<boolean>` | Write `configuration.events` back via `/api/save-snapshot` |

An `EventChange` is `{ model, target, type, value, it, at }` — `value` is the RAW engine value, `it` the ramp seconds (numbers only), `at` the delay before the change starts.

## `chat`

Chat with the `explain-labs_claude` bot via the dev-server proxy `POST /api/chat` (key injected server-side). Each turn ships a compact patient snapshot (`buildContext()`), and the bot may embed `explain-command` JSON blocks that become click-to-apply `PendingCommand`s (confirm-before-apply, or auto-apply).

| State | Type | Description |
|---|---|---|
| `messages` | `Ref<ChatMessage[]>` | Conversation; assistant messages may carry `commands` + an out-of-band `artifact` |
| `isLoading` | `Ref<boolean>` | Reply in flight |
| `error` | `Ref<string \| null>` | Last chat/parse error |
| `conversationId` | `Ref<string \| null>` | Server conversation id |
| `autoApply` | `Ref<boolean>` | Run valid commands on arrival; persisted (`explain.chat.autoApply`) |
| `commandScope` | `Ref<CommandScope>` | `"full"` (any registry field) vs `"guided"` (26-command allowlist); persisted (`explain.chat.scope`) |

| Method | Signature | Description |
|---|---|---|
| `sendMessage` | `(text, attachments=[]) => Promise<void>` | Send a turn with `buildContext()`; pushes the reply |
| `newConversation` | `() => void` | Reset messages/id/error/applied log |
| `applyCommand` | `(messageIndex, cmdIndex) => Promise<void>` | Apply one pending command to engine/diagram/events |
| `dismissCommand` | `(messageIndex, cmdIndex) => void` | Mark a pending command dismissed |
| `applyAll` | `(messageIndex) => Promise<void>` | Apply all commands in a reply, in order, awaiting each |

`buildContext()` reads `useExplain` (`modelState`, `slowValues`, `watchSlow`, `tuneResult`), the active monitors, the live model map, the current diagram (`useDiagramStore().getDiagram()`), and the recent applied-log. Commands route by `normalized.kind`: `loadDefinition` → `useExplain().loadFromObject` (definition from the reply `artifact`), `diagram` → `executeDiagramCommand` over a `diagramHandle()`, `event` → `useEventsStore().upsert` + `persist`, else `executeCommand(..., useExplain())`.

## `diagram`

A bridge so the chat command pipeline can drive diagram edits without the renderer becoming a global. `Diagram.vue` `register()`s its locally-owned `DiagramRenderer` while mounted.

| State / Method | Type | Description |
|---|---|---|
| `activeRenderer` | `ShallowRef<DiagramRenderer \| null>` | The mounted renderer (`null` when the Diagram tab is torn down) |
| `register` | `(r) => void` | Publish the active renderer |
| `unregister` | `(r) => void` | Clear it (only if `r` is still active) |
| `getDiagram` | `() => any \| null` | Current diagram object from the active renderer |

## Wiring

- `monitors`, `events`, and `chat` read the loaded scenario via `useExplain().model.loadedFileData` — the untouched originally-loaded object — and write their sub-objects (`configuration.monitor_dashboards`/`.monitors`, `.events`) back through the dev `POST /api/save-snapshot` endpoint, preserving the original `model_definition` (never snapshotting the live running sim).
- `chat` consumes the control-plane refs from `useExplain` (`modelState`, `slowValues`, `tuneResult`) — the slow stream originates from the worker's [DataCollector](../../explain-engine/docs/DataCollector.md) slow watchlist via `watchSlow` — and issues engine mutations (`setProp`/`scale`/`tune`/`loadFromObject`) through the same composable. It bridges to the diagram through `diagram.activeRenderer` + `Model.updateDiagram`.
- `states.setDefault`/`setDefaultLocal` mirror their result into `auth.user`; `auth`/`states`/`model` are pure HTTP control-plane stores with no engine coupling beyond the scenario name.
- No store ever holds renderer adapters or per-frame frames — those belong to `useRealtimeBus` → [RealtimeBus](../../explain-engine/docs/RealtimeBus.md).

## Gotchas

- **`monitors` groups are ordered arrays, persisted as keyed objects.** Reordering relies on JS insertion-ordered object keys to round-trip array order ⇄ `monitors` key order. `activeId` is view-only and never persisted.
- **`monitors.persist()` is debounced 500 ms** (one file write per keystroke burst); `monitors`/`events` persist failures are logged and kept in memory only (prod has no save-snapshot endpoint).
- **`monitors` mirrors the first dashboard into the legacy `configuration.monitors`** for backward-compat on every persist.
- **`diagram.activeRenderer` is a `shallowRef`** holding the live PixiJS renderer — deliberately kept shallow and out of deep reactivity. When absent, diagram commands surface as an actionable invalid card rather than failing silently. `unregister` guards against a remount clearing a newer renderer.
- **`auth` holds no token** — only mirrored public fields; the real session is the HttpOnly cookie sent via `credentials: "include"`. Dev local mode (no `MONGODB_URI`) never contacts MongoDB.
- **`chat` persists `autoApply`/`commandScope` to localStorage** and validates each bot command against `modelState` (batch-aware for diagram name dependencies). The bot-built patient `artifact` rides out-of-band on the message (too large, ~300 KB, for the command block).
- **`stores` read but do not deep-diff engine snapshots** — they go through `useExplain`'s `shallowRef`s; nothing here subscribes the fast data plane.
