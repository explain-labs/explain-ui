# Explain — Documentation

This is the documentation home for the Explain project. It is split into two clearly separated sets,
mirroring the two halves of the system — but they live in **two different repositories**:

| Set | Covers | Source it documents | Start here |
|---|---|---|---|
| **[`ui/`](./ui/README.md)** | The Vue 3 + Vite + TypeScript **app** layer | `src/` (this repo) | [`ui/UI_ARCHITECTURE.md`](./ui/UI_ARCHITECTURE.md) |
| **[`explain-engine/docs/`](../explain-engine/docs/README.md)** | The framework-agnostic **physiological simulation engine** (per-class reference) | `explain-engine/` (submodule) | [`explain-engine/docs/ARCHITECTURE.md`](../explain-engine/docs/ARCHITECTURE.md) |

The boundary between the two is real and worth keeping in mind: the **engine** knows nothing about Vue
and runs inside a Web Worker; the **UI** wraps it on the main thread. The UI docs link *into* the engine
docs (via `../../explain-engine/docs/X.md`) where the app touches engine internals; the engine docs stay
UI-agnostic. The conceptual spine of both sets is the **two-plane split** — a reactive ~1 Hz control plane
(`useExplain` over `@explain/Model`) and a non-reactive ~60 Hz data plane (`useRealtimeBus` over the
worker's shared-memory channels).

> **Note on layout:** the engine's reference docs live *in the engine repository*, beside the code they
> document, so they resolve for anyone who clones
> [`explain-engine`](https://github.com/explain-labs/explain-engine) on its own — it is the citable artifact.
> They appear here at `explain-engine/docs/` only because the engine is mounted as a submodule. **A checkout
> without `git submodule update --init` has no engine docs**, and the app's doc viewer will show no Engine
> group.

Both sets are served in-app by the doc viewer (`src/components/host/DocViewer.vue`), which globs
`/docs/**/*.md` and `/explain-engine/docs/**/*.md` at build time.

## See also

- [`../CLAUDE.md`](../CLAUDE.md) — repo quick reference (alias, npm scripts, schema field list).
- [`../INSTALL.md`](../INSTALL.md) — setup / install guide.
- [`../explain-engine/README.md`](../explain-engine/README.md) — the engine's onboarding walkthrough.
