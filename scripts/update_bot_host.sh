#!/usr/bin/env bash
#
# Update the Explain bot host (the mac mini that runs the Agent-SDK bot) from this
# git checkout. RUN THIS ON THE BOT HOST as the bot user (e.g. `lucy`).
#
# It does the things a deploy needs and `git pull` alone does NOT:
#   1. `git pull` the repo checkout, then update the `explain` submodule — the
#      engine now lives in a separate repo (github.com/explain-labs/explain-engine)
#      mounted at explain-engine/, so the bot's builder explain-engine/scripts/build_patient.mjs
#      and the scenario library only arrive when the submodule is synced
#   2. copy the bot-facing docs into the bot's workdir (the bot reads them there,
#      they are NOT read from the checkout)
#   3. sync the API wrapper (bot-host/api.py -> the live glue/api.py) and restart
#      the launchd service if (and only if) the wrapper actually changed
#
# Paths default to the mini's layout; override via env if your host differs:
#   EXPLAIN_REPO     the git checkout            (default ~/claude-bots/explain/explain-repo)
#   EXPLAIN_WORKDIR  the bot's working dir       (default ~/claude-bots/explain/workdir)
#   EXPLAIN_GLUE     dir holding the live api.py (default ~/claude-bots/explain/glue)
#   EXPLAIN_API_LABEL  launchd label             (default nl.tim.claudebot.explainapi)
#   EXPLAIN_VENV_PY  python that compiles api.py (default ~/claude-bots/.venv/bin/python)
#
# Usage:
#   ./scripts/update_bot_host.sh            # pull + deploy docs; restart only if api.py changed
#   ./scripts/update_bot_host.sh --restart  # also force a restart (e.g. after a docs-only change)
#
# The api.py sync is one-way (repo -> live) and will REFUSE to run if the live
# file is newer than this checkout's copy, rather than discard edits made
# directly on the host. Reconcile and commit, or set FORCE_WRAPPER=1 if this
# copy is the authoritative one.
#
set -euo pipefail

REPO_DIR="${EXPLAIN_REPO:-$HOME/claude-bots/explain/explain-repo}"
WORKDIR="${EXPLAIN_WORKDIR:-$HOME/claude-bots/explain/workdir}"
GLUE_DIR="${EXPLAIN_GLUE:-$HOME/claude-bots/explain/glue}"
API_LABEL="${EXPLAIN_API_LABEL:-nl.tim.claudebot.explainapi}"
VENV_PY="${EXPLAIN_VENV_PY:-$HOME/claude-bots/.venv/bin/python}"

RESTART=0
[ "${1:-}" = "--restart" ] && RESTART=1

echo "==> 1/4 git pull + submodule sync  ($REPO_DIR)"
git -C "$REPO_DIR" pull --ff-only
# The engine (explain-engine/) is a git submodule; --init handles a fresh checkout, and
# --recursive covers any nested submodules. Without this the checkout would carry
# a stale/empty explain-engine/ and the bot's builder + scenarios would be missing.
git -C "$REPO_DIR" submodule update --init --recursive

echo "==> 2/4 deploy bot docs -> workdir  ($WORKDIR)"
mkdir -p "$WORKDIR/patients"
# the pack is what the bot greps for engine knowledge; without this copy the workdir
# keeps whatever snapshot was placed there by hand and a deploy silently no-ops
cp "$REPO_DIR/knowledge-pack/explain-knowledge-pack.md" "$WORKDIR/explain-knowledge-pack.md"
cp "$REPO_DIR/knowledge-pack/system-prompt.md"          "$WORKDIR/system-prompt.md"
cp "$REPO_DIR/knowledge-pack/command-protocol.md"       "$WORKDIR/command-protocol.md"
cp "$REPO_DIR/knowledge-pack/command-catalog.md"        "$WORKDIR/command-catalog.md"
cp "$REPO_DIR/knowledge-pack/neonatal-reference.md"     "$WORKDIR/neonatal-reference.md"
cp "$REPO_DIR/knowledge-pack/explain-CLAUDE-section.md" "$WORKDIR/explain-CLAUDE-section.md"
# the agent loads workdir/CLAUDE.md via setting_sources=["project"]
cp "$REPO_DIR/knowledge-pack/explain-CLAUDE-section.md" "$WORKDIR/CLAUDE.md"

echo "==> 3/4 sync API wrapper  (bot-host/api.py -> $GLUE_DIR/api.py)"
if [ -f "$REPO_DIR/bot-host/api.py" ]; then
  if [ ! -f "$GLUE_DIR/api.py" ] || ! cmp -s "$REPO_DIR/bot-host/api.py" "$GLUE_DIR/api.py"; then
    # Guard against clobbering a hand-edited live file (added 2026-11-10).
    #
    # This step is a one-way repo -> live copy, so if someone edits the live
    # api.py directly and never brings the change back here, the next run of
    # this script silently discards their work and restarts the service with
    # the older code. That is not hypothetical: between 2026-10-05 and
    # 2026-11-10 the live file was 34 lines ahead of this one (session
    # rotation, turn-stats logging, the is_error raise, the ask_explain
    # rename) while this copy was ahead on the term_neonate_72h baseline
    # default — a two-way divergence in which a copy in *either* direction
    # would have lost something. The stale api.py.bak.* next to the live file
    # is the receipt from the last time this ran.
    #
    # mtime is a weak signal, but it is the one available here, and it is
    # right in the case that matters: a live file newer than this one means
    # edits happened downstream of the last sync. Reconcile by hand, then
    # re-run. FORCE_WRAPPER=1 overrides when you know this copy is correct.
    #
    # Known limitation: `-nt` is strictly-newer, so two files written in the
    # same second compare equal and the guard does not fire. That is the right
    # trade-off here (equal mtime means they were synced together) but it does
    # mean this is a safety net, not a proof — the content diff is still worth
    # a look before any forced install.
    if [ -f "$GLUE_DIR/api.py" ] \
       && [ "$GLUE_DIR/api.py" -nt "$REPO_DIR/bot-host/api.py" ] \
       && [ -z "${FORCE_WRAPPER:-}" ]; then
      echo "    REFUSING to overwrite the live wrapper: $GLUE_DIR/api.py is NEWER" >&2
      echo "    than $REPO_DIR/bot-host/api.py, so it carries edits this checkout" >&2
      echo "    does not have. Copying now would discard them." >&2
      echo "" >&2
      echo "    Inspect:   diff $REPO_DIR/bot-host/api.py $GLUE_DIR/api.py" >&2
      echo "    Reconcile: bring the live changes into bot-host/api.py and commit," >&2
      echo "               then re-run this script (it becomes a no-op)." >&2
      echo "    Override:  FORCE_WRAPPER=1 $0 $*   # only if this copy is authoritative" >&2
      exit 1
    fi
    # validate before installing so a bad file never reaches the live service
    "$VENV_PY" -m py_compile "$REPO_DIR/bot-host/api.py"
    [ -f "$GLUE_DIR/api.py" ] && cp "$GLUE_DIR/api.py" "$GLUE_DIR/api.py.bak.$(date +%s)"
    cp "$REPO_DIR/bot-host/api.py" "$GLUE_DIR/api.py"
    echo "    wrapper changed -> installed (backup kept); will restart"
    RESTART=1
  else
    echo "    wrapper unchanged"
  fi
else
  echo "    (no bot-host/api.py in the checkout — skipping wrapper sync)"
fi

if [ "$RESTART" = 1 ]; then
  echo "==> 4/4 restart $API_LABEL"
  launchctl kickstart -k "gui/$(id -u)/$API_LABEL"
  sleep 2
  curl -s -m 4 http://localhost:8091/healthz || echo "  (health check failed — check logs/api.stderr.log)"
  echo
else
  echo "==> 4/4 no restart needed (docs changes are picked up per new conversation)"
fi
echo "deploy complete."
