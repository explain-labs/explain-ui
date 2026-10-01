# Explain Knowledge Pack — integration guide

This folder makes the `explain` bot an expert on the Explain engine, the same way Claude
Code is: by giving it the engine source, the physiology docs, and the architecture notes
and letting it read them on demand.

## Files

| File | What it is | How produced |
|------|------------|--------------|
| `explain-knowledge-pack.md` | The corpus: architecture + all `docs/engine/*.md` + engine source + scenario format. Currently built at **lite** tier (~178K tokens, 78 files) so it fits a 200K-context model. | `node scripts/build_knowledge_pack.mjs --tier=lite` |
| `explain-CLAUDE-section.md` | The `CLAUDE.md` pointer that orients an Agent-SDK bot to the pack (grep it, cite paths, handle the live patient-state block) and to the command files below. | hand-written |
| `command-protocol.md` | **Bot-facing**: how to emit an action (the fenced `explain-command` JSON format + rules). The webapp parses these out of the reply and offers the user an Apply button. | hand-written |
| `command-catalog.md` | **Bot-facing**: the exhaustive list of currently-allowed commands with value ranges. Generated from the webapp's allowlist + parameter schema so the bot can't propose something the app rejects. | `node scripts/build_command_catalog.mjs` |
| `neonatal-reference.md` | **Bot-facing**: reference values the bot uses to fill what a Patient-builder form leaves empty (size by gestational age, haemoglobin, the engine's normal-range table). **Draft until a clinician signs it off.** | hand-written; tables 1 and 3 copied from `explain-engine/scripts/build_patient.mjs` (`PRETERM_SEED`) and `_probe.mjs` (`RANGES`) |
| `system-prompt.md` | A role/instruction preamble — only needed for the **fallback** (non-Agent-SDK) wiring below. | build script |
| `README.md` | This guide. | hand-written |

Rebuild after any engine change:

```sh
node scripts/build_knowledge_pack.mjs --tier=lite # ~178K tokens, fits a 200K-context model — the checked-in build
node scripts/build_knowledge_pack.mjs             # full tier (~359K tokens) — needs a 1M-context model
```

Lite drops the `component_models/` and `device_models/` source, the `helpers/`
(`ModelScaler`, `Calibrator`, `TaskScheduler`, `DataCollector`), `realtime/`, and the UI
`model-interface` registry. The bot keeps the architecture notes, every physiology doc,
and the core engine classes, so it can still reason about the model — it just can't quote
those class bodies. The command files it needs to *act* (`command-protocol.md`,
`command-catalog.md`) are deployed to the workdir separately by `update_bot_host.sh` and
are unaffected by the tier.

**The pack is a snapshot** — it does not update itself when the engine changes; the
rebuild + redeploy is the maintenance cost.

---

## Primary method — Agent-SDK bot (this is what the `explain` bot is)

The `explain` bot on the Mac mini is a **Claude Agent SDK** bot — effectively Claude Code
running in a directory. Its call sets:

```python
ClaudeAgentOptions(
    cwd=str(BOT_DIR),
    setting_sources=["project"],          # loads that dir's CLAUDE.md + .claude/
    allowed_tools=[... "Read", "Glob", "Grep" ...],
)
```

So it already loads its working directory's `CLAUDE.md` and can `Read`/`Grep` files. You do
**not** need to edit the bot's code or build a prompt-cache server. Just put the knowledge in
the bot's working directory and point its `CLAUDE.md` at it:

1. **Copy** `explain-knowledge-pack.md`, `command-protocol.md`, and `command-catalog.md`
   into the bot's working directory — for this deploy,
   `/Users/lucy/claude-bots/explain/workdir/`.
2. **Append** the contents of `explain-CLAUDE-section.md` to that directory's `CLAUDE.md`
   (create it if absent). This pointer tells the bot about the pack *and* the two command
   files.
3. **Reload** by starting a fresh conversation ("new conversation" in the web app, or
   `/reset` in Telegram) so the updated `CLAUDE.md` is read at session start. The pack and
   command files are read on demand by the Read/Grep tool, so no process restart or rebuild
   is required.

The bot then greps `explain-knowledge-pack.md` for the relevant model/topic and answers
grounded, citing exact paths (`explain/base_models/Resistor.js`, `docs/engine/Heart.md`).

**Refresh** after an engine change: re-run the build script and re-copy
`explain-knowledge-pack.md` to the bot directory. No `CLAUDE.md` change needed on refresh.

### Verify it worked

Ask the bot: *"What is the exact formula for an effective elastance in Explain, and which
file defines it?"* A correct answer cites `explain/base_models/Capacitance.js` and the
`p_eff = p + (factor-1)*p + (factor_ps-1)*p + (factor_scaling_ps-1)*p` pattern. A vague
answer with no file path means the `CLAUDE.md` pointer didn't load (wrong directory, or the
session wasn't reset).

---

## Fallback method — non-Agent-SDK bot (relays straight to the Anthropic API)

Use this **only** if the bot host is *not* an Agent-SDK bot but instead builds an Anthropic
API call directly (no Read/Grep tools, no project `CLAUDE.md`). Then the pack has to ride in
the **`system`** parameter as a prompt-cached block. The self-contained `bot-server/bot.py`
in this repo implements exactly this as a drop-in `/v1/ask` server. For the `explain` bot you
do **not** need it — prefer the primary method above.

Load the pack into `system` as content blocks with `cache_control` so the prefix is cached:

```python
resp = client.messages.create(
    model="claude-opus-4-8",          # 1M context — the full pack is >200K tokens
    max_tokens=4096,
    system=[
        {"type": "text", "text": SYSTEM_PROMPT},                      # system-prompt.md
        {"type": "text", "text": KNOWLEDGE_PACK,
         "cache_control": {"type": "ephemeral"}},                     # or {"type":"ephemeral","ttl":"1h"}
    ],
    messages=[{"role": "user", "content": prompt}],                   # question + patient-state block
)
```

Keep the per-request question and the live patient-state block in `messages`, **not** in
`system`, so the cached prefix stays byte-identical between requests. Verify caching with
`usage.cache_read_input_tokens` (non-zero on the 2nd+ request of a session).

### Model & context window (fallback)

- The full pack (~200K tokens) needs a **1M-context model**: `claude-opus-4-8` (1M context,
  128K max output) or `claude-sonnet-4-6` (1M context, cheaper). Both are GA — no beta header
  for the 1M window or for prompt caching.
- If the bot is pinned to a 200K-context model, build `--tier=lite` (~95K tokens) instead.

### Caching economics (fallback)

Cache **reads** cost ~0.1× input price; **writes** 1.25× (5-min TTL) or 2× (1-hour TTL). For
a sporadically-used bot, prefer the **1-hour TTL** so a session's follow-ups all hit the
cache. At Opus prices a cold request is ~$1.35, a warm one ~$0.11.

---

## Refresh workflow (the one ongoing cost, either method)

After changing the engine (a new model in `explain/ModelIndex.js`, edited physics, a new
doc), re-run the build and redeploy the pack:

```sh
node scripts/build_knowledge_pack.mjs
# Agent-SDK: copy explain-knowledge-pack.md to the bot's workdir/
# fallback:  copy explain-knowledge-pack.md (+ system-prompt.md) to the bot host
```

Consider wiring the rebuild into a git pre-commit hook or CI step so the pack never drifts
from the engine.
