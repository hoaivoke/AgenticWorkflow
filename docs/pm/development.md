# PM3code: development notes

For what the fork is and how to install it, see the [README](../../README.md). The design is in
[PM_DESIGN.md](../../PM_DESIGN.md). PM code lives in `apps/*/src/pm`, `apps/server/src/pm` and
`packages/pm`; each small edit to an upstream file is marked `t3code-pm:`. The PM runs a port of
the Ghostex coordinator playbook (`packages/pm/src/playbook.ts`).

## Data and compatibility

- The fork's default data folder is **`~/.t3-pm`**, not `~/.t3`, so it never shares state with
  the official app. `T3CODE_PM_HOME` overrides it. The desktop app and the `t3-pm` command ignore
  `T3CODE_HOME`, which may name the official app's data, and pass the fork's home on to the server
  as `T3CODE_HOME` themselves.
- `t3-pm service install` uses its own names (`t3code-pm.service`, `com.t3codepm.service`,
  `t3code-pm-<domain>-<user>`). The fork publishes no runtime archive for it, so it stops unless
  `T3CODE_RELEASE_BASE_URL` names a mirror holding one; it never fetches upstream's `t3`.
- PM state lives in `pm_*` tables with their own migration ledger (`pm_migrations`). Upstream
  builds open a fork database and ignore those tables; the fork opens an upstream database and adds
  them. No upstream table is altered.
- PM3code reads the official app's `~/.t3` (`T3CODE_PM_T3_HOME` overrides it, for tests) and
  never writes it: the database is read through a read-only `ATTACH` into a `VACUUM INTO` copy,
  settings files are only read. Imported threads get new ids and copies of their checkpoint refs,
  because both apps key refs by thread id and storage cleanup deletes refs of removed threads.
  Code: `apps/server/src/pm/t3`.
- Upstream clients (app.t3.codes, the store apps) can talk to a fork server and see PMs as plain
  threads. The orchestration protocol version is unchanged.
- The server never updates itself from npm: npm's `t3` package is upstream and would replace the
  fork.

## Building and running

```sh
vp i
vp run dev                      # server + web, state in this checkout's .t3 when it is a worktree
vp run dist:desktop:dmg:arm64   # "PM3code" for Apple Silicon, ad-hoc signed (see below to notarize)
vp run dist:desktop:win:x64     # Windows installer
vp run dist:desktop:linux       # Linux AppImage
```

A plain clone shares `~/.t3/dev` in dev mode; isolate it with
`vp run migrate-dev-db --base-dir <clone>/.t3` and `vp run dev --home-dir <clone>/.t3`.
The free `Replay (dev)` provider has a `pm` scenario that drives the real `pm_*` tools.

The desktop app is **PM3code** (`com.t3codepm.desktop`, URL scheme `t3code-pm`, command
`t3-pm`). It keeps its data in `~/.t3-pm` and its Electron profile in
`~/Library/Application Support/t3code-pm`. It updates from this repository's GitHub releases
(`PM_UPDATE_FEED` in `packages/pm/src/identity.ts`), and offers only `pm-v*` tags. Its ids, folders, scheme and command keep the
older `t3code-pm` spelling on purpose: installs from 0.1.0 and 0.2.0, which were named T3 Code PM,
keep their data.

Release DMGs are signed with a Developer ID and notarized. Build them on a Mac whose keychain has
the Developer ID Application identity and a notarytool profile
(`xcrun notarytool store-credentials notarytool-profile`):

```sh
T3CODE_DESKTOP_SIGNED=true CSC_NAME=<team ID> T3CODE_DESKTOP_VERSION=<version> vp run dist:desktop:dmg:arm64
```

`CSC_NAME` picks the identity by its team ID or SHA-1 hash, and `APPLE_KEYCHAIN_PROFILE` names
another profile. The app is signed with the hardened runtime and
`scripts/pm-entitlements.mac.plist`, notarized and stapled, then the DMG is signed, notarized and
stapled too. Unsigned builds stay ad-hoc signed; each one has a new signature, so macOS asks again
for the "t3code-pm Safe Storage" keychain item after updating to one. Signed builds share one
designated requirement (bundle id and team), so updates between them keep the keychain grant.
Squirrel.Mac also refuses an update signed by another identity, so an ad-hoc build cannot
update itself at all.

The resource monitor needs Rust 1.95 or newer when building.

## Releasing

Tag `pm-v<version>` and upload these files to the release. The updater reads the newest release
marked Latest, so publish it as a full release, never a pre-release.

- **macOS**, from the signed local build in `release/`: `PM3code-<version>-arm64.dmg`,
  `PM3code-<version>-arm64.zip`, `PM3code-<version>-arm64.zip.blockmap` and `latest-mac.yml`.
  The zip is what installed apps download.
- **Windows and Linux**, from the `release-assets` artifact of the **PM desktop packages**
  workflow run: `PM3code-<version>-x64.exe`, its `.blockmap`, `latest.yml`,
  `PM3code-x86_64.AppImage` and `latest-linux.yml`.
- **Android**: the APK, unchanged.

Each `latest*.yml` names its version, so every file must come from builds of the same version.
To try an update before releasing, build a lower and a higher version with
`T3CODE_DESKTOP_MOCK_UPDATES=true T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT=<port>`, which bakes
`http://localhost:<port>` into the app instead of GitHub. Serve the higher one's `latest-mac.yml`,
zip and zip blockmap with `T3CODE_DESKTOP_MOCK_UPDATE_SERVER_ROOT=<folder>
T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT=<port> vp run start:mock-update-server`, and open the lower
one unzipped from its zip, outside Applications. The app the update relaunches does not inherit
your shell, so `launchctl setenv T3CODE_PM_HOME <throwaway>` first (and `unsetenv` after), or it
opens your real `~/.t3-pm`. Both builds must be signed with the same Developer ID.

## Building the Android APK

The APK is **PM3code** (`com.t3codepm.app`). It installs beside the official app, never takes
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
It never pushes. One of its checks, `scripts/pm-protocol-check.sh`, fails when the fork's
orchestration protocol differs from upstream's: the official apps refuse a server on another
protocol.

## Translations

PM strings live in their own catalogs (`apps/{web,mobile}/src/pm/i18n/translations`), never in
upstream's generated `translations/*.json`. After changing PM copy, run
`node scripts/pm-i18n.ts generate` and translate the new keys by hand;
`node scripts/pm-i18n.ts check` is the matching check.
