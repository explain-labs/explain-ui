# ChatAndBot

The **"Explain AI Bot"** tab is a conversational surface over the `explain-labs_claude` bot (a Claude Agent-SDK bot running on a separate host). It does two things at once: it answers questions about *this* simulated patient (each turn carries a compact live snapshot), and it can **propose actions** on the running model. Actions ride inside the reply as fenced ```` ```explain-command ```` JSON blocks; the app parses them, validates each against the UI-owned schema (see [ModelInterface](./ModelInterface.md)), and attaches them to the message as confirm-before-apply cards. Validation reuses the **same** `MODEL_INTERFACES` bounds/units the human editor uses, so a bot command behaves exactly like a hand edit.

## What lives here

| File | Responsibility |
|---|---|
| `src/components/controls/ChatPanel.vue` | Conversation UI: markdown rendering, attachments, scope/auto-apply toggles, Apply/Dismiss/Apply-all/Revert cards |
| `src/stores/chat.ts` | `useChatStore`: `/api/chat` proxy call, per-turn patient snapshot, parse + attach + apply commands |
| `src/services/botCommands.ts` | `parseCommands` → `validateCommand` → `executeCommand` / `executeDiagramCommand` pipeline (Vue/Pixi-free) |
| `src/services/botCommandAllowlist.ts` | Single source of truth for the Guided allowlist + scale groups + diagram actions |

## `ChatPanel.vue`

Pure presentation over `useChatStore`. Key behaviours:

- **Markdown.** Assistant replies render through `markdown-it` configured `{ html: false, linkify: true, breaks: true }`. `html: false` is the primary XSS guard (raw HTML in model output is escaped). A `link_open` rule rewrites links to `target="_blank" rel="noopener noreferrer"`. User and `failed` bubbles stay plain text (`whitespace-pre-wrap`), never `v-html`.
- **Attachments.** `readFile()` turns a `File` into a `ChatAttachment`: csv/tsv/txt → `{kind:"csv", data:<raw text>}`; pdf/image → `{kind:"pdf"|"image", data:<base64>, media_type}` (the `data:<mt>;base64,` prefix is stripped). The bot extracts target physiology from these to build a patient. `ACCEPT` is `.pdf,.csv,.tsv,.txt,image/*,…`.
- **Command surface (Guided vs Full).** A `SelectButton` writes `chat.commandScope` (`"guided"` | `"full"`). Guided = the curated allowlist; Full = any settable registry field. `onScope` ignores the `null` a re-click can emit.
- **Auto-apply toggle.** `chat.autoApply` — when on, valid commands run the moment the reply lands (no click). Off by default; persisted.
- **Action cards.** Each `PendingCommand` renders with its `description`, a status chip (`applied` / `dismissed` / `can't apply`), an optional `error`, and — while `pending` — **Apply** (`chat.applyCommand`) / **Dismiss** (`chat.dismissCommand`). **Apply all** shows only when a message has ≥2 still-pending commands (`hasMultiplePending`).
- **Revert.** A toolbar button calls `useExplain().revert()` — reload the patient as it was loaded, discarding all live changes. A `tuning` spinner shows while a closed-loop tune runs in the worker.

## `stores/chat.ts` (`useChatStore`)

State: `messages`, `isLoading`, `error`, `conversationId`, `autoApply` + `commandScope` (both `localStorage`-persisted), and `appliedLog` (an audit of applied actions, echoed back to the bot).

- **`buildContext()`** assembles a plain-text snapshot sent with every turn: weight/GA/age; the enabled monitor groups formatted exactly like `NumericReadoutPanel` (latest slow-stream sample × factor, weight-divided where flagged); the **live model map** (instance names grouped by `model_type`, so the bot can map a natural-language target onto an instance name + its settable fields); the **current diagram** (component names, model bindings, connectors) when the Diagram tab is mounted; the **last tune result** (residuals, met/missed); and the recent `appliedLog`. It also pushes every monitored path onto the slow watchlist (`watchSlow`).
- **`sendMessage(text, attachments)`** POSTs `{ prompt, context, conversation_id, attachments? }` to `/api/chat` (the dev-server proxy injects the API key server-side; see `vite.config.ts`). It guards against a non-JSON body (a stale dev server falls through to the SPA HTML) before trusting `res.ok`, requires `body.answer` to be a string, and stores `body.conversation_id`. The reply's optional `body.artifact` (a full bot-built patient definition, ~300 KB) is delivered out-of-band and passed to `pushAssistantReply`. The bot host also returns `body.build` (the structured calibration report for that artifact: `converged`, `iters`, `unmet`, per-vital `residuals`, raw `log`, echoed `spec`); the chat store does not read it.
- **`pushAssistantReply(answer, artifact)`** runs `parseCommands`, then validates each command with `validateCommand(cmd, modelState, commandScope, { names })`. Diagram validation is **batch-aware**: the known-component-name set is seeded from the live diagram and updated as each command validates, so a `connect` can reference a component an earlier `addComponent` in the same reply introduces. Valid → `pending`, invalid → `invalid` (kept visible with its reason). If `autoApply`, it immediately runs `applyAll`.
- **`applyCommand(mi, ci)`** routes by `normalized.kind`: `loadDefinition` → `useExplain().loadFromObject(message.artifact ?? definition)`; `diagram` → `executeDiagramCommand` over a renderer-backed `diagramHandle()` (throws if the Diagram tab isn't open); `event` → saved into the Event Scheduler store (`upsert` + best-effort `persist`, **not** fired here); everything else → `executeCommand(normalized, useExplain())`. On success it marks `applied` and appends to `appliedLog`; on throw it marks `invalid` with the error.
- **`applyAll(mi)`** applies in order and **awaits each**, because diagram edits can depend on earlier ones in the same reply. `dismissCommand` and `newConversation` round out the API.

Exported store members: `messages`, `isLoading`, `error`, `conversationId`, `autoApply`, `commandScope`, `sendMessage`, `newConversation`, `applyCommand`, `dismissCommand`, `applyAll`.

## `services/botCommands.ts`

The parse → validate → execute pipeline. Pure and Vue/Pixi-free (the chat store supplies the engine/renderer handles), so it is unit-testable with a plain `modelState`.

| Exported symbol | Role |
|---|---|
| `parseCommands(answer)` | Strip every ```` ```explain-command ```` block (`BLOCK_RE`), `JSON.parse` each (one object or an array); returns `{ clean, commands, parseErrors }`. Bad JSON is surfaced in `parseErrors`, never silent. |
| `validateCommand(cmd, modelState, scope?, diagram?)` | Scope gate + registry-schema check + display→raw unit conversion → `ValidationResult { ok, normalized?, description, error? }`. |
| `validateDiagramCommand(cmd, modelState, names)` | Per-action diagram validation (separate surface; gated on a mounted renderer, not the allowlist). |
| `isSettableField(f, op)` | `call` ⇒ `type==="function"`; else `!readonly && type ∈ {number, factor, boolean, list}`. |
| `executeCommand(norm, explain)` | Dispatch an engine command to the matching `ExplainHandle` method. |
| `executeDiagramCommand(norm, h)` | Apply a diagram edit to the renderer, then `h.push()` to re-bind the live animation. |

**Ops** (`CommandOp`): `setProp`, `call`, `start`, `stop`, `revert`, `event`, `loadDefinition`, `scale`, `tune`, `diagram` (plus `calculate`/`load` declared in the allowlist type). Scope rules:

- `start` / `stop` / `revert` — no model/target, allowed in both scopes.
- `setProp` / `call` — Guided requires an allowlist match (`isAllowed`); Full relies on the per-field settable + bounds checks. Numbers/factors are bounds-checked (`ll`/`ul`, display units) and converted with `toRaw`; lists checked against `resolveChoices`; booleans forced to `it: 0`.
- `event` — a named bundle of scheduled prop changes, each validated **exactly like a `setProp`** (same gate/bounds/units); the whole event is rejected if any change is bad.
- `loadDefinition`, `tune`, `scale` — **Full scope only** (rejected in Guided). `tune` targets must be in `LIVE_TARGETS` (`map/sys/dia/co/hr/pap_m/pap_s/po2/spo2/pco2/be/ph/blood_volume`), with `sys` and `dia` only together; `scale` groups must be in `SCALE_GROUPS`; an inline `loadDefinition.definition` is sanity-checked (`definitionError`) and size-capped at 64 KiB (the real path is the response `artifact`).
- `diagram` — validated separately; rejected when no renderer is mounted (`names === null`).

`NormalizedCommand` is the engine-ready union (`call`/`setProp`/`event`/`loadDefinition`/`scale`/`tune`/`revert`/`start`/`stop`/`diagram`) with values already in raw units. `executeCommand` maps each kind onto the `ExplainHandle` slice (`call`, `setProp`, `start`, `stop`, `scale`, `tune`, `revert`, `loadFromObject`).

## `services/botCommandAllowlist.ts`

The single source of truth for Guided scope. `COMMAND_ALLOWLIST: AllowEntry[]` enumerates the curated safe commands (Ventilator on/off + params, Heart/Ans, Breathing/Metabolism, Drugs, Resuscitation, start/stop/revert, plus `tune` and `loadDefinition` notes). `isAllowed(op, model?, target?)` matches an entry (ops without a model/target match on op alone). `SCALE_GROUPS` (`isScaleGroup`) lists the physiologically-safe scaler groups (e.g. `blood_volume`, `systemic_resistances`, `heart_el_max`; `weight_scale`/`incorporate`/`reset`/`add_volume` deliberately excluded). `DIAGRAM_ACTIONS` (`isDiagramAction`) enumerates the seven diagram actions. The bot-facing **catalog generator** `scripts/build_command_catalog.mjs` reads this **same** file, so the bot is never told it can do something the app would refuse — widen the bot's reach by editing this file and regenerating the catalog.

## Wiring

```
bot reply (markdown + ```explain-command``` blocks, optional response.artifact)
   │ chat.sendMessage → /api/chat (dev proxy injects API key)
   ▼
parseCommands ──► clean prose (markdown-it, html:false) + BotCommand[]
   │
   ▼ per command (batch-aware diagram names)
validateCommand(cmd, modelState, scope) ── reads MODEL_INTERFACES (ModelInterface.md)
   │   guided → COMMAND_ALLOWLIST   |   full → settable-field + ll/ul + toRaw
   ▼
PendingCommand card  ── Apply ─► applyCommand ─► executeCommand / executeDiagramCommand
                                                  / loadFromObject(artifact) / events store
```

## Gotchas

- **Definitions travel out-of-band.** A bot-built patient (~300 KB) does **not** ride in the command block — it arrives in the `/api/chat` response `artifact` and is applied via `loadFromObject`. The inline `definition` is a dev/small fallback only, size-capped at 64 KiB.
- **`event` op saves, it does not fire.** A bot `event` is `upsert`ed into the Event Scheduler panel (armed: false); the user arms/fires it there. Per-change `at` is its only timing mechanism here.
- **Diagram edits need the Diagram tab open.** `validateCommand`/`applyCommand` reject diagram ops when no renderer is mounted (`names === null`). `applyAll` awaits each so a `connect` sees its `addComponent`'s sprite loaded first.
- **Stale dev server looks like success.** A missing `/api/chat` or `/api/delete-snapshot` falls through to the SPA's `index.html` (HTTP 200, HTML body); both call sites `res.json().catch(()=>null)` and check the body shape before trusting the response.
- **`html: false` is the XSS boundary.** Never switch markdown-it to `html: true`; assistant text is untrusted and injected via `v-html`.
- **Guided ⊂ Full.** Switching a rejected command's scope to Full is the documented fix surfaced in the error string; `loadDefinition`/`tune`/`scale` are Full-only by design.
