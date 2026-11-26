# Upstream sync

This repo stacks three layers: T3 Code (`pingdotgg/t3code`), PM3code (`maddada/pm3code`, which adds
Project Manager threads), and this fork's own commits (pipelines and roles). PM3code follows T3 Code
nightlies by **rebasing** onto them, so its `pm` branch history is rewritten on each sync. This fork
follows the same model: its own commits sit on top of PM3code and are replayed onto each new
PM3code, never merged.

The branch `upstream/pm3code` marks the PM3code commit the default branch sits on. Everything after
it on `pm` is this fork's.

## Automatic

`.github/workflows/sync-upstream.yml` runs daily and on demand (Actions, Sync upstream, Run
workflow). When PM3code has moved, it:

1. replays this fork's commits onto PM3code's newest `pm` as the branch `sync/upstream`,
   regenerating `pnpm-lock.yaml` when that is the only conflict;
2. runs `vp run check:changed pm3code/pm`, `node scripts/pm-i18n.ts check`, and the fork regression
   test suite on the new base;
3. comments on the open "Upstream sync" issue (or opens one) and writes a Job Summary with the
   recent upstream commits, check results, or conflicting files.

It never changes `pm` on a schedule. To test-drive a big update before promoting, run the workflow
with **build_preview** ticked to get a downloadable Apple Silicon `.dmg` artifact from
`sync/upstream` without publishing a release. To take the update, run the workflow with **promote**
ticked: it keeps the old tip as `pm-before-sync-<date>`, moves `pm` to `sync/upstream`, and moves
the `upstream/pm3code` marker.

One-time setup: Actions are off by default on forks; enable them in the repo's Actions tab.

## By hand

For a conflict the workflow reported:

```sh
git fetch origin && git remote add pm3code https://github.com/maddada/pm3code.git
git fetch pm3code pm
git switch -c sync/manual origin/pm
git rebase --onto pm3code/pm origin/upstream/pm3code
# fix the listed files, git add them, git rebase --continue
vp i && vp run check:changed pm3code/pm
git push origin origin/pm:refs/heads/pm-before-sync-manual
git push --force-with-lease=pm:origin/pm origin sync/manual:pm
git push --force origin pm3code/pm:upstream/pm3code
```

- `pnpm-lock.yaml`: take PM3code's (`git checkout --ours pnpm-lock.yaml` during a rebase), then
  `vp install --lockfile-only`.
- Lines marked `// pipelines:` are this fork's. Keep upstream's change and put the marked lines
  back.

T3 Code changes arrive once PM3code takes them, usually within a day or two. To get one sooner,
run PM3code's own `scripts/sync-upstream.sh` with a remote pointing at `pingdotgg/t3code`. It rebases
onto T3 Code `main` and lists the conflicts PM3code's changes cause. The next PM3code sync replaces
that work, so do it only for a change you need now.

## Keeping syncs cheap

- Put new work in new files and folders (`packages/pipelines`, `apps/server/src/pipelines`).
- Keep edits to PM3code or T3 Code files to a few lines, marked `// pipelines:`.
- Never change upstream tables, migrations or wire schemas; add side tables and new fields the way
  `PM_DESIGN.md` describes.
- Keep this fork's history short: a few commits replay faster and conflict less than many.
