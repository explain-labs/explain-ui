# Releasing: one command

`scripts/release.sh` takes a finished change from open PRs to live, in the order the two repos need:

```
scripts/release.sh --engine 119 --ui 153    # engine PR + UI PR
scripts/release.sh --engine 119             # engine only: the script opens its own bump PR
scripts/release.sh --ui 153                 # UI only
scripts/release.sh --engine 119 --dry-run   # check the PRs and print the plan
```

| Step | What happens | Checked before going on |
|---|---|---|
| 1 | Preflight: the PRs exist, target `main`, are open (or already merged) and have no conflicts | — |
| 2 | Merge the engine PR (`gh pr merge --admin`; the `main` rulesets require a review) | the PR shows MERGED |
| 3 | In a throwaway worktree of the UI PR branch (or of `main`): merge `main` in, point `explain-engine` at the new engine `main`, run `sync-scenarios`, `build_command_catalog` and `build_knowledge_pack --tier=lite`; commit and push only what changed. With `--ui` the commit lands on that PR's branch, otherwise on a new `release/engine-<sha>` PR | — |
| 4 | Merge the UI PR | the PR shows MERGED |
| 5 | `ssh kvm2 'sudo -n deploy-app explain'` | the deploy reports the new `main` commit healthy |
| 6 | Update the bot host, pack only: `update_bot_host.sh --restart` with `EXPLAIN_GLUE` pointed at a temp dir, so the live `glue/api.py` (newer than the repo's) is never overwritten | the bot answers ok, sits on the new commit, and its `api.py` hash is unchanged |
| 7 | Fast-forward this checkout and its engine to `main`, when this checkout is on a clean `main` | — |

Any failed check stops the script with `release: STOPPED: …`; nothing after it runs. A rerun is safe: merged PRs are skipped, an unchanged pack is not committed, and the deploy and bot update are idempotent.

The hosts are the ssh aliases `kvm2` and `lucy-mac-mini` (override with `DEPLOY_HOST`, `BOT_HOST`). The script needs `gh` logged in with admin rights on both repos, and `node_modules` in this checkout (the command catalog uses esbuild).
