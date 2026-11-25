# BELEN — agent instructions

BELEN is a portable Windows and macOS (Apple Silicon) app: one `BELEN.exe`
on Windows, a bare `BELEN` on macOS, `data/` beside it, no installer. It
ships through **itself**: releases go to GitHub Releases, and the app's
Settings → About tab installs them over the air.

Machines: **HAMMER** (Mac — **every build happens here, always**; its
self-hosted Actions runner picks up every push to `main`), **illaoi** (Mac —
where development usually happens) and **MAYA** (Windows — where the Windows
exe is tried by hand). HAMMER builds the macOS binary natively and
cross-compiles the Windows exe, with `app/scripts/build-hammer.sh`. A session
can run on either Mac — `hostname -s` says which — and from the other one
HAMMER is `ssh la@hammer` over Tailscale. The signing key's original lives on
HAMMER (see the rules below).

## The loop — how every bug fix and feature ships

Work on illaoi unless told otherwise. Any change that should reach the user's
app follows this exact sequence:

1. **Implement** in the relevant module. Frontend gates before pushing:
   ```bash
   pnpm --dir app typecheck   # must be clean
   pnpm --dir app test        # must be green (Vitest)
   ```
2. **Bump the version** — patch for fixes, minor for features — in ALL of:
   `app/package.json`, `app/src-tauri/tauri.conf.json`,
   `app/src-tauri/Cargo.toml`, and the `belen` entry in
   `app/src-tauri/Cargo.lock`. `pnpm release sign` refuses to run when the
   three manifests disagree. (Hand-editing the lock's belen version entry is
   expected here; leave the rest of the lock alone.)
3. **Add a CHANGELOG.md entry** under a new `## [X.Y.Z] — date` heading.
4. **Commit to `main` and push.** Merging a PR is a push to `main`.
5. **HAMMER builds it.** Every push to `main` runs the `build` workflow
   (`.github/workflows/build.yml`) on HAMMER's self-hosted runner with
   `app/scripts/build-hammer.sh`: the frontend gates, the Rust tests, the
   macOS binary, and the Windows exe cross-compiled.
   ```bash
   gh run list --repo mrlfarano/belen --limit 1
   gh run watch <run-id> --repo mrlfarano/belen --exit-status
   ```
   Green means both binaries are in `~/builds/belen/` on HAMMER and uploaded
   as the `belen-macos` and `belen-windows` artifacts. To build by hand
   instead — always on HAMMER, so through `ssh la@hammer` unless that is
   where the session runs:
   ```bash
   ssh la@hammer 'zsh -lc "cd ~/dev/belen && git pull --ff-only && zsh app/scripts/build-hammer.sh"'
   ```
   Done means the last line it prints is `HAMMER_BUILD_OK`.
6. **Release** (only when the change should actually reach the app) — both
   platforms, Windows first so its `publish` creates the release and the
   macOS call adds to it. The binaries are in `~/builds/belen/` on HAMMER;
   from another machine, copy them over first. `publish` needs `gh` logged
   in, which on HAMMER lives in the Keychain — so release from a desktop
   session, not over SSH.
   ```bash
   rm -rf /tmp/belen-rel && mkdir -p /tmp/belen-rel/win /tmp/belen-rel/mac
   cp ~/builds/belen/BELEN.exe /tmp/belen-rel/win/
   cp ~/builds/belen/BELEN     /tmp/belen-rel/mac/
   pnpm --dir app release sign /tmp/belen-rel/win/BELEN.exe --out=/tmp/belen-rel/win/latest.json --notes="one line for the update dialog"
   pnpm --dir app release sign /tmp/belen-rel/mac/BELEN --platform=macos --out=/tmp/belen-rel/mac/latest-macos.json --notes="one line for the update dialog"
   pnpm --dir app release publish /tmp/belen-rel/win/BELEN.exe /tmp/belen-rel/win/latest.json
   pnpm --dir app release publish /tmp/belen-rel/mac/BELEN /tmp/belen-rel/mac/latest-macos.json --platform=macos
   ```
   The first `publish` creates the `vX.Y.Z` release **with both assets in
   one operation**; the second adds the macOS pair to it. Never draft-first,
   never create or move tags by hand.
7. **Tell the user to update**: Settings → About → **Check for updates** →
   **Update & restart**. Done means the user confirms the new version in the
   About tab and the room shows `BELEN X.Y.Z installed.`

Docs-only pushes build too; that is fine — no release follows.

## Rules learned the hard way

- **Never delete or recreate a git tag under a published release.** It
  silently re-drafts the release and `releases/latest/download/` 404s for
  minutes. Fix a wrong tag by cutting the release properly, not by surgery.
- **HAMMER's runner must be online.** It is a login-time service
  (`~/Library/LaunchAgents/actions.runner.mrlfarano-belen.HAMMER.plist`), so
  it runs while `la` is logged in on HAMMER; a `build` run that sits
  `queued` means HAMMER is down or not logged in. Check with
  `gh api repos/mrlfarano/belen/actions/runners`; on HAMMER,
  `cd ~/actions-runner && ./svc.sh status`. MAYA's runner is still
  registered, but no workflow uses it.
- **HAMMER's runner runs repository code.** Give a workflow that targets
  `[self-hosted, hammer]` only `push` to `main` and `workflow_dispatch` —
  never `pull_request`, nor anything else a fork can set off.
- **To try an exe on MAYA by hand**, put it in `%USERPROFILE%\belen-dev\`,
  so the real install and its `data/` stay untouched. A running BELEN locks
  its exe: Windows allows renaming a running image but not overwriting it.
- **Cross-compiling to Windows: no `+crt-static`.** `scripts/build.ps1` sets
  `-C target-feature=+crt-static` on MAYA, where link.exe is used. Under
  HAMMER's lld-link, rustc's crt-static directives collide with the
  `static_vcruntime` crate Tauri always uses, and the C runtime is left out
  (`undefined symbol: strlen`). Tauri links the Visual C++ runtime statically
  by itself, so the exe needs no redistributable either way. The details sit
  in `app/scripts/build-hammer.sh`.
- **HAMMER's login Keychain answers "User interaction is not allowed"
  outside a desktop session** — over `ssh la@hammer`, and on the runner. There
  the two Rust tests that write to it cannot run (`build-hammer.sh` skips
  them by name, and the log says so). Over SSH, `gh` cannot read its stored
  login either, so `pnpm release publish` fails there. Both work in a
  desktop session on HAMMER; run the two Keychain tests in one when touching
  `keys.rs`.
- **The updater refuses debug builds and non-HTTPS feeds** (loopback http is
  allowed for rehearsals via `BELEN_UPDATE_FEED`). Don't try to update from
  a `tauri dev` build.
- **Signing key**: `~/.belen/update-private.pem` (chmod 600). The original
  lives on HAMMER; a copy is on illaoi, where the repo and releases live.
  The public key is committed at `app/src-tauri/update.pubkey` and compiled
  into every binary. Losing the private key means existing installs can only
  be updated by hand — back it up offline; do not regenerate casually, and
  never commit any `.private.pem`.
- **CI files are sensitive here** — `.github/workflows/build.yml` runs on
  HAMMER's runner, with that machine's tools and Keychain behind it. Change
  it only with the user's explicit ask, and prefer the smallest edit.
- **Every release publishes both platforms.** Both update feeds are fetched
  from whichever release is Latest, so a release that ships only one
  platform leaves the other platform's installs with a 404 update feed.

## Handy facts

- Repo: `github.com/mrlfarano/belen` (public). Feeds:
  `https://github.com/mrlfarano/belen/releases/latest/download/latest.json`
  (Windows) and `latest-macos.json` at the same path (macOS).
- Manifest `latest.json` (macOS: `latest-macos.json`, same format):
  `version, pubDate, url, sha256, notes, signature`
  — Ed25519 over `BELEN-UPDATE-1\n{version}\n{sha256}`. The download URL is
  never taken from the webview; `update_apply` re-fetches and re-verifies.
- Update swap: rename running exe → `.old`, rename `.exe.new` in, rollback on
  failure; restart via `--wait-pid=<pid>` handoff so the single-instance
  plugin never sees two processes. `data/` is never touched; `.old` and the
  applied-update marker are cleaned up on next start.
- Rust unit tests (DPAPI / Keychain, updater) run on HAMMER in every build
  (`app/scripts/build-hammer.sh`: all of them in a desktop session; on the
  runner and over SSH the two Keychain tests are skipped — see above), and
  on MAYA with `powershell -ExecutionPolicy Bypass -File scripts\build.ps1
  -Test` — run them when touching `src-tauri/`. Performance-sensitive
  changes: `pnpm perf` on MAYA before releasing.
- If a build ever runs on MAYA, go through `scripts/build.ps1`: it works
  around a machine-global `~/.cargo/config.toml` from another project, and
  a MAX_PATH issue solved by `CARGO_TARGET_DIR=%USERPROFILE%\.belen-target`.
- On HAMMER: the dev checkout is `~/dev/belen`, the runner `~/actions-runner`,
  and every build lands in `~/builds/belen/` (`BELEN`, `BELEN.exe`). The
  cross toolchain is `brew install llvm lld`, `rustup target add
  x86_64-pc-windows-msvc` and cargo-xwin (Windows SDK cached in
  `~/Library/Caches/cargo-xwin`). Every pnpm run there rewrites
  `app/pnpm-lock.yaml`; restore it (`git checkout -- app/pnpm-lock.yaml`)
  before committing, and stage files by name.
