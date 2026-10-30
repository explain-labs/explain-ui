#!/usr/bin/env bash
#
# Release in one command: merge the engine PR, bump the engine on the UI side,
# regenerate the bot pack, merge the UI PR, deploy the site and update the bot.
# Each step only runs once the previous one is verified (PR shows MERGED, the
# deploy reports the expected commit healthy, the bot answers ok).
#
# Usage:
#   scripts/release.sh [--engine <PR>] [--ui <PR>] [--dry-run]
#
#   --engine N  merge explain-engine PR N, then bump the UI to the new engine main
#   --ui N      the UI PR to release; the bump + pack go onto its branch.
#               Without --ui (engine only) the script opens its own bump PR.
#               Without --engine the engine pointer is left as the PR has it.
#   --dry-run   check the PRs and print the plan; change nothing
#
# Steps:
#   1. preflight: PRs exist, are open (or already merged) and have no conflicts
#   2. merge the engine PR (gh --admin)
#   3. in a throwaway worktree of the UI PR branch (or of main): merge main in,
#      bump the engine submodule, sync scenarios, rebuild the command catalog and
#      the lite knowledge pack; commit and push only what changed
#   4. merge the UI PR (gh --admin)
#   5. deploy main on the VPS (deploy-app) and check the deployed commit
#   6. update the bot host, pack only (the live glue/api.py is newer than the
#      repo's, so it is never overwritten), and check it is unchanged and healthy
#   7. fast-forward this checkout (and its engine) to main if it is on a clean main
#
# Hosts default to the ssh aliases kvm2 and lucy-mac-mini (DEPLOY_HOST, BOT_HOST).
set -euo pipefail

UI_REPO="explain-labs/explain-ui"
ENGINE_REPO="explain-labs/explain-engine"
DEPLOY_HOST="${DEPLOY_HOST:-kvm2}"
BOT_HOST="${BOT_HOST:-lucy-mac-mini}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

ENGINE_PR=""
UI_PR=""
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --engine) ENGINE_PR="${2:?--engine needs a PR number}"; shift 2 ;;
    --ui) UI_PR="${2:?--ui needs a PR number}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "release: unknown argument $1" >&2; exit 1 ;;
  esac
done
[ -n "$ENGINE_PR$UI_PR" ] || { echo "usage: scripts/release.sh [--engine <PR>] [--ui <PR>] [--dry-run]" >&2; exit 1; }

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nrelease: STOPPED: %s\n' "$*" >&2; exit 1; }
pr_field() { gh pr view "$2" --repo "$1" --json "$3" --jq ".$3"; }

# merge a PR with admin rights (the main rulesets require a review) and verify it
merge_pr() {
  local repo="$1" pr="$2" state i
  state="$(pr_field "$repo" "$pr" state)"
  if [ "$state" = "MERGED" ]; then echo "    $repo#$pr is already merged"; return; fi
  # right after a push GitHub may still be computing mergeability; retry a few times
  for i in 1 2 3 4 5 6; do
    if gh pr merge "$pr" --repo "$repo" --merge --admin >/dev/null 2>&1; then break; fi
    sleep 5
  done
  state="$(pr_field "$repo" "$pr" state)"
  [ "$state" = "MERGED" ] || die "$repo#$pr is $state, not merged"
  echo "    merged $repo#$pr"
}

check_pr() {
  local repo="$1" pr="$2" state base mergeable
  state="$(pr_field "$repo" "$pr" state)" || die "$repo#$pr not found"
  base="$(pr_field "$repo" "$pr" baseRefName)"
  [ "$base" = "main" ] || die "$repo#$pr targets $base, not main"
  case "$state" in
    MERGED) echo "    $repo#$pr: already merged" ;;
    OPEN)
      mergeable="$(pr_field "$repo" "$pr" mergeable)"
      [ "$mergeable" != "CONFLICTING" ] || die "$repo#$pr has merge conflicts"
      echo "    $repo#$pr: open, $(pr_field "$repo" "$pr" title)" ;;
    *) die "$repo#$pr is $state" ;;
  esac
}

# ---- 1. preflight ----------------------------------------------------------------
say "1/7 preflight"
gh auth status >/dev/null 2>&1 || die "gh is not logged in"
[ -n "$ENGINE_PR" ] && check_pr "$ENGINE_REPO" "$ENGINE_PR"
UI_BRANCH=""
if [ -n "$UI_PR" ]; then
  check_pr "$UI_REPO" "$UI_PR"
  [ "$(pr_field "$UI_REPO" "$UI_PR" isCrossRepository)" = "false" ] || die "$UI_REPO#$UI_PR comes from a fork"
  # an already merged UI PR is done: a bump still needed then goes into a PR of its own
  if [ "$(pr_field "$UI_REPO" "$UI_PR" state)" = "OPEN" ]; then UI_BRANCH="$(pr_field "$UI_REPO" "$UI_PR" headRefName)"
  else UI_PR=""; fi
fi

if [ "$DRY" = 1 ]; then
  say "dry run: the plan"
  [ -n "$ENGINE_PR" ] && echo "    merge $ENGINE_REPO#$ENGINE_PR; bump the UI engine pointer to the new engine main"
  if [ -n "$UI_PR" ]; then echo "    bump + bot pack onto branch $UI_BRANCH, then merge $UI_REPO#$UI_PR"
  else echo "    open a bump + bot pack PR on $UI_REPO and merge it"; fi
  echo "    deploy main on $DEPLOY_HOST; update the bot on $BOT_HOST (pack only)"
  exit 0
fi

# ---- 2. engine PR ----------------------------------------------------------------
ENGINE_SHA=""
if [ -n "$ENGINE_PR" ]; then
  say "2/7 merge the engine PR"
  merge_pr "$ENGINE_REPO" "$ENGINE_PR"
  ENGINE_SHA="$(gh api "repos/$ENGINE_REPO/commits/main" --jq .sha)"
  echo "    engine main is now ${ENGINE_SHA:0:7}"
else
  say "2/7 no engine PR, skipped"
fi

# ---- 3. bump + bot pack in a throwaway worktree -----------------------------------
say "3/7 engine bump + bot pack"
WT_PARENT="$(mktemp -d)"
WT="$WT_PARENT/ui"
cleanup() { git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || true; rm -rf "$WT_PARENT"; }
trap cleanup EXIT

git -C "$ROOT" fetch -q origin
if [ -n "$UI_BRANCH" ]; then
  git -C "$ROOT" worktree add -q --detach "$WT" "origin/$UI_BRANCH"
  PUSH_BRANCH="$UI_BRANCH"
  # build the pack from what main will look like after the merge
  git -C "$WT" merge -q --no-edit origin/main >/dev/null || die "branch $UI_BRANCH does not merge cleanly with main"
else
  git -C "$ROOT" worktree add -q --detach "$WT" origin/main
  PUSH_BRANCH="release/engine-${ENGINE_SHA:0:7}"
fi
# the engine checkout borrows objects from this checkout's engine, so it is quick
git -C "$WT" submodule update -q --init --reference "$ROOT/explain-engine"
if [ -n "$ENGINE_SHA" ]; then
  git -C "$WT/explain-engine" fetch -q origin
  git -C "$WT/explain-engine" checkout -q --detach "$ENGINE_SHA"
  git -C "$WT" add explain-engine
fi
ln -s "$ROOT/node_modules" "$WT/node_modules"
(
  cd "$WT"
  node scripts/sync-scenarios.mjs >/dev/null
  node scripts/build_command_catalog.mjs >/dev/null
  node scripts/build_knowledge_pack.mjs --tier=lite >/dev/null
)
git -C "$WT" add knowledge-pack
if git -C "$WT" diff --cached --quiet; then
  echo "    nothing to commit (engine pointer and bot pack already current)"
else
  git -C "$WT" diff --cached --stat | sed 's/^/    /'
  MSG="Release: bot knowledge pack (lite) regenerated"
  [ -n "$ENGINE_SHA" ] && MSG="Bump engine to ${ENGINE_SHA:0:7} (#$ENGINE_PR merged); bot knowledge pack (lite) regenerated"
  git -C "$WT" commit -q -m "$MSG"
  git -C "$WT" push -q origin "HEAD:refs/heads/$PUSH_BRANCH"
  echo "    pushed to $PUSH_BRANCH"
  if [ -z "$UI_PR" ]; then
    UI_PR="$(gh pr create --repo "$UI_REPO" --base main --head "$PUSH_BRANCH" \
      --title "Bump engine to ${ENGINE_SHA:0:7} (#$ENGINE_PR)" \
      --body "Engine bump to ${ENGINE_SHA:0:7} ($ENGINE_REPO#$ENGINE_PR) and the regenerated bot knowledge pack. Opened by scripts/release.sh." \
      | sed 's#.*/##')"
    echo "    opened $UI_REPO#$UI_PR"
  fi
fi

# ---- 4. UI PR ----------------------------------------------------------------------
if [ -n "$UI_PR" ]; then
  say "4/7 merge the UI PR"
  merge_pr "$UI_REPO" "$UI_PR"
else
  say "4/7 no UI change to merge (the bump was already on main)"
fi
UI_SHA="$(gh api "repos/$UI_REPO/commits/main" --jq .sha)"
echo "    UI main is now ${UI_SHA:0:7}"

# ---- 5. deploy -----------------------------------------------------------------------
say "5/7 deploy on $DEPLOY_HOST"
DEPLOY_OUT="$(ssh "$DEPLOY_HOST" 'sudo -n deploy-app explain' 2>&1)" || { echo "$DEPLOY_OUT"; die "deploy-app failed"; }
echo "$DEPLOY_OUT" | grep '^\[deploy-app' | sed 's/^/    /'
echo "$DEPLOY_OUT" | grep -q "healthy.*deployed ${UI_SHA:0:7}" || die "the deploy did not report ${UI_SHA:0:7} healthy"
RELEASE="$(echo "$DEPLOY_OUT" | sed -n 's/.*creating release \([^ ]*\).*/\1/p')"

# ---- 6. bot host -----------------------------------------------------------------------
say "6/7 update the bot on $BOT_HOST (pack only)"
API_SHA() { ssh "$BOT_HOST" 'shasum -a 256 ~/claude-bots/explain/glue/api.py' | cut -c1-12; }
API_BEFORE="$(API_SHA)"
BOT_OUT="$(ssh "$BOT_HOST" 'cd ~/claude-bots/explain/explain-repo && EXPLAIN_GLUE=$(mktemp -d) bash scripts/update_bot_host.sh --restart' 2>&1)" \
  || { echo "$BOT_OUT"; die "update_bot_host.sh failed"; }
echo "$BOT_OUT" | grep -q '"ok":true' || { echo "$BOT_OUT"; die "the bot did not answer ok after the restart"; }
API_AFTER="$(API_SHA)"
[ "$API_BEFORE" = "$API_AFTER" ] || die "the live glue/api.py changed ($API_BEFORE -> $API_AFTER)"
BOT_SHA="$(ssh "$BOT_HOST" 'git -C ~/claude-bots/explain/explain-repo rev-parse HEAD')"
[ "$BOT_SHA" = "$UI_SHA" ] || die "the bot host is on ${BOT_SHA:0:7}, not ${UI_SHA:0:7}"
echo "    bot ok on ${BOT_SHA:0:7}; live api.py unchanged ($API_AFTER)"

# ---- 7. this checkout ----------------------------------------------------------------------
say "7/7 local checkout"
if [ "$(git -C "$ROOT" branch --show-current)" = "main" ] && [ -z "$(git -C "$ROOT" status --porcelain --ignore-submodules=all)" ]; then
  git -C "$ROOT" pull -q --ff-only
  git -C "$ROOT/explain-engine" checkout -q main
  git -C "$ROOT/explain-engine" pull -q --ff-only
  echo "    main at $(git -C "$ROOT" rev-parse --short HEAD), engine on main at $(git -C "$ROOT/explain-engine" rev-parse --short HEAD)"
else
  echo "    left alone (not on a clean main)"
fi

say "released"
[ -n "$ENGINE_PR" ] && echo "    engine   $ENGINE_REPO#$ENGINE_PR -> main ${ENGINE_SHA:0:7}"
[ -n "$UI_PR" ] && echo "    ui       $UI_REPO#$UI_PR -> main ${UI_SHA:0:7}"
echo "    site     release ${RELEASE:-?}"
echo "    bot      ${BOT_SHA:0:7}, health ok"
