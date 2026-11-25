# BELEN — agent instructions

BELEN is a portable Windows app: one `BELEN.exe`, `data/` beside it, no
installer. It ships through **itself**: releases go to GitHub Releases, and
the app's Settings → About tab installs them over the air.

Machines: **HAMMER** (Mac — develop here) and **MAYA** (Windows — builds and
tests there via a self-hosted Actions runner). The Rust crate compiles only
on Windows; HAMMER can run the frontend gates and release tooling.

## The loop — how every bug fix and feature ships

Work on HAMMER unless told otherwise. Any change that should reach the user's
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
   expected here; cargo regenerates the rest on MAYA.)
3. **Add a CHANGELOG.md entry** under a new `## [X.Y.Z] — date` heading.
4. **Commit to `main` and push.** The push triggers the `windows build`
   workflow automatically — but only if the runner is up (see below).
5. **Watch the build** and wait for green:
   ```bash
   gh run list --repo mrlfarano/belen --limit 1
   gh run watch <run-id> --repo mrlfarano/belen --exit-status
   ```
   Green means the exe is staged at `%USERPROFILE%\belen-dev\BELEN.exe` on
   MAYA (for the user's manual testing) and uploaded as the `belen-windows`
   artifact.
6. **Release** (only when the change should actually reach the app):
   ```bash
   rm -rf /tmp/belen-rel && mkdir -p /tmp/belen-rel
   gh run download <run-id> --repo mrlfarano/belen -n belen-windows -D /tmp/belen-rel
   pnpm --dir app release sign /tmp/belen-rel/BELEN.exe --out=/tmp/belen-rel/latest.json --notes="one line for the update dialog"
   pnpm --dir app release publish /tmp/belen-rel/BELEN.exe /tmp/belen-rel/latest.json
   ```
   `publish` creates the `vX.Y.Z` release **with both assets in one
   operation**. Never draft-first, never create or move tags by hand.
7. **Tell the user to update**: Settings → About → **Check for updates** →
   **Update & restart**. Done means the user confirms the new version in the
   About tab and the room shows `BELEN X.Y.Z installed.`

Docs-only pushes also trigger a build; that is fine — no release follows.

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
- **The runner must be running.** If a workflow sits `queued` forever, MAYA's
  runner is down: on MAYA, `cd C:\Users\me\actions-runner; ./run.cmd`
  (keep the window open). Builds also fail if a step assumes the repo root
  is the app — see `working-directory` above.
- **The updater refuses debug builds and non-HTTPS feeds** (loopback http is
  allowed for rehearsals via `BELEN_UPDATE_FEED`). Don't try to update from
  a `tauri dev` build.
- **Signing key**: `~/.belen/update-private.pem` (HAMMER, chmod 600). The
  public key is committed at `app/src-tauri/update.pubkey` and compiled into
  every exe. Losing the private key means existing installs can only be
  updated by hand — back it up offline; do not regenerate casually, and
  never commit any `.private.pem`.
- **CI files are sensitive here** (`.github/workflows/windows-build.yml`
  encodes the build machine's quirks) — change them only with the user's
  explicit ask, and prefer the smallest edit.

## Handy facts

- Repo: `github.com/mrlfarano/belen` (public). Feed:
  `https://github.com/mrlfarano/belen/releases/latest/download/latest.json`.
- Manifest `latest.json`: `version, pubDate, url, sha256, notes, signature`
  — Ed25519 over `BELEN-UPDATE-1\n{version}\n{sha256}`. The download URL is
  never taken from the webview; `update_apply` re-fetches and re-verifies.
- Update swap: rename running exe → `.old`, rename `.exe.new` in, rollback on
  failure; restart via `--wait-pid=<pid>` handoff so the single-instance
  plugin never sees two processes. `data/` is never touched; `.old` and the
  applied-update marker are cleaned up on next start.
- Rust unit tests (DPAPI, updater) run on MAYA with
  `powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Test` — run
  that when touching `src-tauri/`. Performance-sensitive changes: `pnpm perf`
  on MAYA before releasing.
- Build traps on MAYA (handled by `scripts/build.ps1` — always build through
  it): a machine-global `~/.cargo/config.toml` from another project, and a
  MAX_PATH issue solved by `CARGO_TARGET_DIR=%USERPROFILE%\.belen-target`.
