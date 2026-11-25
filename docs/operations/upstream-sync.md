# Upstream sync

This repo stacks three layers: T3 Code (`pingdotgg/t3code`), PM3code (`maddada/pm3code`, which adds
Project Manager threads and follows T3 Code nightlies), and this fork's own work (pipelines and
roles). All three share git history, so updates arrive as ordinary merges.

## Automatic

`.github/workflows/sync-upstream.yml` runs daily and on demand (Actions, Sync upstream, Run
workflow). It merges, in order:

1. **PM3code `pm`.** The main route for T3 Code updates: PM3code has already resolved the
   conflicts between T3 Code and its own changes.
2. **T3 Code `main`**, only when it merges cleanly on top. On 25 Nov 2026 a direct merge hit 13
   conflicts, all in files PM3code changes, so expect this step to be skipped until PM3code
   catches up.

Whatever merged goes to the `sync/upstream` branch and one pull request, whose description says
what merged and which files blocked anything that did not. If PM3code itself does not merge, the
workflow opens an issue instead.

One-time setup:

- Actions are off by default on forks: enable them in the repo's Actions tab.
- Settings, Actions, General, Workflow permissions: turn on **Allow GitHub Actions to create and
  approve pull requests**.
- Pull requests opened by the workflow do not trigger CI. Close and reopen the PR, or push a commit
  to `sync/upstream`, to run it.

## By hand

```sh
git remote add pm3code https://github.com/maddada/pm3code.git
git remote add t3code https://github.com/pingdotgg/t3code.git
git fetch pm3code pm && git fetch t3code main

git switch -c sync/manual pm
git merge pm3code/pm        # usually clean
git merge t3code/main       # take T3 Code ahead of PM3code; may conflict
```

On conflicts:

- `pnpm-lock.yaml`: take either side, then run `vp i` and commit the regenerated lockfile.
- Files under `apps/server/src/pm/`, `packages/pm/` and anything marked `// t3code-pm:` are
  PM3code's. Keep upstream's change and re-apply PM3code's marked lines. Waiting for PM3code to
  merge that T3 Code release is the lower-effort option.
- Lines marked `// pipelines:` are this fork's. Keep them, adapted to upstream's new code.

Then run `vp run check:changed pm` and open a PR.

## Keeping merges cheap

- Put new work in new files and folders (`packages/pipelines`, `apps/server/src/pipelines`).
- Keep edits to upstream files to a few lines, marked `// pipelines:`, so a conflict shows at once
  whose line it is.
- Never change upstream tables, migrations or wire schemas; add side tables and new fields the way
  `PM_DESIGN.md` describes.
