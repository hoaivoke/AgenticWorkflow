# T3 Code PM: development notes

For what the fork is and how to install it, see the [README](../../README.md). The design is in
[PM_DESIGN.md](../../PM_DESIGN.md). PM code lives in `apps/*/src/pm`, `apps/server/src/pm` and
`packages/pm`; each small edit to an upstream file is marked `t3code-pm:`. The PM runs a port of
the Ghostex coordinator playbook (`packages/pm/src/playbook.ts`).

## Data and compatibility

- The fork's default data folder is **`~/.t3-pm`**, not `~/.t3`, so it never shares state with
  the official app. `T3CODE_HOME` still overrides it.
- PM state lives in `pm_*` tables with their own migration ledger (`pm_migrations`). Upstream
  builds open a fork database and ignore those tables; the fork opens an upstream database and adds
  them. No upstream table is altered.
- Upstream clients (app.t3.codes, the store apps) can talk to a fork server and see PMs as plain
  threads. The orchestration protocol version is unchanged.
- The server never updates itself from npm: npm's `t3` package is upstream and would replace the
  fork.

## Building and running

```sh
vp i
vp run dev                      # server + web, state in this checkout's .t3 when it is a worktree
vp run dist:desktop:dmg:arm64   # "T3 Code PM" for Apple Silicon, ad-hoc signed
vp run dist:desktop:win:x64     # Windows installer
vp run dist:desktop:linux       # Linux AppImage
```

A plain clone shares `~/.t3/dev` in dev mode; isolate it with
`vp run migrate-dev-db --base-dir <clone>/.t3` and `vp run dev --home-dir <clone>/.t3`.
The free `Replay (dev)` provider has a `pm` scenario that drives the real `pm_*` tools.

The desktop app is **T3 Code PM** (`com.t3codepm.desktop`, URL scheme `t3code-pm`, command
`t3-pm`). It keeps its data in `~/.t3-pm` and its Electron profile in
`~/Library/Application Support/t3code-pm`, and has no update feed. Each new ad-hoc signed macOS
build has a new signature, which is why macOS asks again for the "t3code-pm Safe Storage" keychain
item after an update.

The resource monitor needs Rust 1.95 or newer when building.

## Building the Android APK

The APK is **T3 Code PM** (`com.t3codepm.app`). It installs beside the official app, never takes
upstream's over-the-air updates, and talks to any T3 server; PM views show only on a fork server.
Building it needs a JDK 17 and the Android SDK:

```sh
T3CODE_PM_KEYSTORE=~/keys/t3code-pm.keystore \
T3CODE_PM_KEYSTORE_PASSWORD_FILE=~/keys/t3code-pm.password \
scripts/pm-build-apk.sh ~/Downloads
```

Make the keystore once with `keytool -genkeypair -keystore ~/keys/t3code-pm.keystore -alias
t3code-pm -keyalg RSA -keysize 4096 -validity 10000` and keep it: Android only installs updates
signed with the same key. Never commit it.

T3 Connect does not work in the fork APK. The APK is built without the T3 Connect settings, so
it shows no sign-in. A build with them shows Clerk's sign-in, but Clerk rejects the fork's
redirect (`clerk://com.t3codepm.app.callback` is not an authorized redirect URI for T3's
instance), so only T3's own apps can sign in.

To reach a dev server from the phone, `vp run dev --share` publishes it on the tailnet over HTTPS
(it needs HTTPS certificates turned on in the tailnet's DNS settings). Pairing codes come from
`node apps/server/src/bin.ts auth pairing create` or the desktop's Settings, Connections.

## Syncing with upstream

```sh
scripts/sync-upstream.sh
```

It fetches `main` from the remote that points at pingdotgg/t3code (or `UPSTREAM_REMOTE`), keeps
the old tip as `<branch>-before-sync-<date>`, rebases, rebuilds `pnpm-lock.yaml` from upstream's,
and runs `vp run check:changed` against upstream plus the PM translation and mobile import checks.
On a conflict it lists the files and which of them hold `t3code-pm:` hunks: keep upstream's change,
put the marked lines back, `git add` the files and run the command it prints (`... --continue`),
which finishes the rebase and then the checks. A failing check may be upstream's own: it says so.
It never pushes.

## Translations

PM strings live in their own catalogs (`apps/{web,mobile}/src/pm/i18n/translations`), never in
upstream's generated `translations/*.json`. After changing PM copy, run
`node scripts/pm-i18n.ts generate` and translate the new keys by hand;
`node scripts/pm-i18n.ts check` is the matching check.
