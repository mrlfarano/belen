# BELEN — agent instructions

BELEN is a portable Windows and macOS (Apple Silicon) app: one `BELEN.exe`
on Windows, a bare `BELEN` on macOS, `data/` beside it, no installer. It
ships through **itself**: releases go to GitHub Releases, and the app's
Settings → About tab installs them over the air.

Machines: **illaoi** (Mac — develop here), **HAMMER** (Mac — **every build
happens here, always**; reach it over Tailscale as `ssh la@hammer`) and
**MAYA** (Windows — where the Windows exe is tried by hand; its self-hosted
Actions runner is only a fallback). HAMMER builds the macOS binary natively
and cross-compiles the Windows exe. illaoi runs the frontend gates and the
release tooling. The signing key's original lives on HAMMER (see the rules
below).

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
4. **Commit to `main` and push.**
5. **Build on HAMMER** — always on HAMMER:
   ```bash
   ssh la@hammer 'zsh -l -s' < app/scripts/build-hammer.sh
   ```
   It fast-forwards `~/dev/belen` on HAMMER to `origin/main`, runs the
   frontend gates and the Rust tests, builds the macOS binary and
   cross-compiles the Windows exe, and leaves both in `~/builds/belen/`
   (`BELEN`, `BELEN.exe`) with their checksums. Done means the last line it
   prints is `HAMMER_BUILD_OK`.
6. **Release** (only when the change should actually reach the app) — both
   platforms, Windows first so its `publish` creates the release and the
   macOS call adds to it:
   ```bash
   rm -rf /tmp/belen-rel && mkdir -p /tmp/belen-rel/win /tmp/belen-rel/mac
   scp la@hammer:builds/belen/BELEN.exe /tmp/belen-rel/win/
   scp la@hammer:builds/belen/BELEN     /tmp/belen-rel/mac/
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

Pushes still trigger the `macos build` and `windows build` workflows. They
are a check and a fallback now: release binaries come from HAMMER, and
nothing waits on them.

## Rules learned the hard way

- **Never delete or recreate a git tag under a published release.** It
  silently re-drafts the release and `releases/latest/download/` 404s for
  minutes. Fix a wrong tag by cutting the release properly, not by surgery.
- **Workflow `run:` blocks are ASCII only.** Windows PowerShell 5.1 reads the
  generated script in the ANSI codepage; a single em dash parses as a string
  delimiter and mangles the whole step.
- **Every workflow step that touches the app needs `working-directory: app`**
  — the lockfile and `scripts/build.ps1` live there, not at the repo root.
- **The test folder may have the app running.** The stage step already
  renames a locked `BELEN.exe` aside (`BELEN.previous.exe`); don't "fix" it
  back to a plain overwrite.
- **Nothing waits on MAYA's runner.** The `windows build` workflow needs it,
  so with MAYA asleep that run sits `queued` — release binaries come from
  HAMMER. Only the CI fallback needs it started by hand on MAYA:
  `cd C:\Users\me\actions-runner; ./run.cmd` (keep the window open). CI
  builds also fail if a step assumes the repo root is the app — see
  `working-directory` above.
- **Cross-compiling to Windows: no `+crt-static`.** `scripts/build.ps1` sets
  `-C target-feature=+crt-static` on MAYA, where link.exe is used. Under
  HAMMER's lld-link, rustc's crt-static directives collide with the
  `static_vcruntime` crate Tauri always uses, and the C runtime is left out
  (`undefined symbol: strlen`). Tauri links the Visual C++ runtime statically
  by itself, so the exe needs no redistributable either way. The details sit
  in `app/scripts/build-hammer.sh`.
- **HAMMER's login Keychain refuses SSH sessions** ("User interaction is not
  allowed"), so the two Rust tests that write to it cannot run through
  `ssh la@hammer`; the build script skips them by name. Run them in a GUI
  session when touching `keys.rs`.
- **The updater refuses debug builds and non-HTTPS feeds** (loopback http is
  allowed for rehearsals via `BELEN_UPDATE_FEED`). Don't try to update from
  a `tauri dev` build.
- **Signing key**: `~/.belen/update-private.pem` (chmod 600). The original
  lives on HAMMER; a copy is on illaoi, where the repo and releases live.
  The public key is committed at `app/src-tauri/update.pubkey` and compiled
  into every binary. Losing the private key means existing installs can only
  be updated by hand — back it up offline; do not regenerate casually, and
  never commit any `.private.pem`.
- **CI files are sensitive here** (`.github/workflows/windows-build.yml`
  encodes the build machine's quirks) — change them only with the user's
  explicit ask, and prefer the smallest edit.
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
- Rust unit tests (DPAPI / Keychain, updater) run on HAMMER as part of
  `app/scripts/build-hammer.sh` (all but the two Keychain tests, see above),
  and on MAYA with `powershell -ExecutionPolicy Bypass -File
  scripts\build.ps1 -Test` — run them when touching `src-tauri/`.
  Performance-sensitive changes: `pnpm perf` on MAYA before releasing.
- Build traps on MAYA (handled by `scripts/build.ps1` — always build through
  it): a machine-global `~/.cargo/config.toml` from another project, and a
  MAX_PATH issue solved by `CARGO_TARGET_DIR=%USERPROFILE%\.belen-target`.
