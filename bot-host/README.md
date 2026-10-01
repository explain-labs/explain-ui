# bot-host — the Agent-SDK wrapper deployed on the bot machine

This directory holds the **API wrapper that runs on the Explain bot host** (the mac
mini running the Claude Agent-SDK bot), kept under version control so the deploy is
reproducible. It is *not* part of the Vite web app — nothing here is imported by the
front-end build.

## `api.py`

The FastAPI service (`uvicorn api:app`, port 8091) that the web app's `/api/chat`
proxy talks to. It wraps the Claude Agent SDK (`query()`), and adds the
**build-a-patient** capability:

- Accepts `attachments` (PDF → document block, CSV/text → text block, image) on
  `POST /v1/ask`, so the bot can read uploaded target-value sheets.
- After the model replies, `maybe_build()` looks for a fenced ` ```explain-build ` block
  holding a build **SPEC**, runs `explain/scripts/build_patient.mjs` itself (fixed argv, spec on
  stdin, 300 s timeout, off the event loop), and returns the calibrated patient as the
  response **`artifact`** — splicing the calibration report + a `loadDefinition` action
  card into the visible answer. The model needs **no shell/Write tools**: it only emits
  the SPEC; the wrapper does the build.
- Alongside the `artifact` it returns **`build`**, the structured calibration report:
  `converged`, `iters`, `unmet`, `residuals` (every reported vital with its value,
  target, Δ and normal-range flag — targeted or not), the capped raw `log`, the echoed
  `spec`, and `source`. It is built from the `build_report` the engine's builder embeds
  in the scenario (`detail_from_build_report()`), which adds `lever_limits` (targets
  whose calibration lever ran into its bound), `ignored_targets`, `superseded_targets`
  and `notes`. For an engine that predates `build_report` it falls back to parsing the
  builder's stderr (`parse_build_report()`, `source: "stderr"`). The one-line
  verdict in the answer hides a target that is inside tolerance but out of range, and
  any untargeted vital that drifted; `build` carries both.
- Rejects a SPEC that would **apply the prematurity adjustments twice**
  (`double_seed_error()`): a baseline that is itself preterm (`preterm_*`,
  `bischoff_cohort`) combined with `targets.gestational_age` below 37. The builder
  applies its gestational-age seed whenever that target is below 37, whatever the
  baseline. Fetal baselines use a separate seed table and are not checked.

This is the canonical copy. The deployed location on the bot host is
`~/claude-bots/explain/glue/api.py` (a different directory, outside this checkout), so a
plain `git pull` does **not** update it — use the deploy script below, which syncs it.

### Env (set in the bot host's launchd plist / `.env`)

| var | default | meaning |
|-----|---------|---------|
| `EXPLAIN_REPO`  | `<workdir>/../explain-repo` | checkout holding `explain/scripts/build_patient.mjs` (in the `explain` submodule) |
| `NODE_BIN`      | `$(which node)` → `/opt/homebrew/bin/node` | node used to run the builder |
| `BUILD_TIMEOUT` | `300` | max seconds for one patient build |
| `ALLOWED_TOOLS` | `Read,Glob,Grep,WebSearch,WebFetch` | the bot stays read-only — **do not add Bash/Write** |

## Deploying / updating the bot host

Run the deploy script **on the bot host** (as the bot user):

```bash
~/claude-bots/explain/explain-repo/scripts/update_bot_host.sh           # pull + docs; restart only if api.py changed
~/claude-bots/explain/explain-repo/scripts/update_bot_host.sh --restart # force a restart
```

It `git pull`s the checkout, copies the bot-facing docs into `workdir/` (the bot reads
them there, not from the checkout), syncs this `api.py` into `glue/api.py` (with a
backup) and restarts the launchd service only when the wrapper actually changed.

### First-time reconcile (one-off)

If the checkout has files that were copied in by hand (not via git), `git pull --ff-only`
will refuse. Reset it to the remote once, then use the script from then on:

```bash
cd ~/claude-bots/explain/explain-repo
git fetch origin && git reset --hard origin/main && git clean -fd
./scripts/update_bot_host.sh --restart
```
