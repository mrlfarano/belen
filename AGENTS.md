# BELEN — agent instructions

BELEN is a portable Windows and macOS (Apple Silicon) app: one `BELEN.exe`
on Windows, a bare `BELEN` on macOS, `data/` beside it, no installer. It
ships through **itself**: releases go to GitHub Releases, and the app's
Settings → About tab installs them over the air.

Machines: **illaoi** (Mac — develop here, reach HAMMER over Tailscale as
`ssh la@hammer`), **HAMMER** (Mac — every release is cut from a session on
it) and **MAYA** (Windows — builds and tests there via a self-hosted
Actions runner). The Rust crate compiles on Windows and macOS; illaoi
builds and runs it too, plus the frontend gates. The signing key's original
lives on HAMMER (see the rules below).

## The loop — how every bug fix and feature ships

Every change lands as a pull request, and every pull request that changes
the app gets a release: one PR, one version, one release on both platforms.
The user tests by updating BELEN from the app, so the release *is* the test
build. Work on illaoi unless told otherwise, and follow this exact sequence:

1. **Implement** in the relevant module. Frontend gates before opening the
   PR:
   ```bash
   pnpm --dir app typecheck   # must be clean
   pnpm --dir app test        # must be green (Vitest)
   ```
   Run the Rust tests too when the PR touches `src-tauri/` (see Handy
   facts). Nothing else checks a PR: no workflow runs on pull requests,
   because the self-hosted runner must never execute them.
2. **Bump the version** — patch for fixes, minor for features, major for
   changes that break existing installs (a data format, a setting or a
   workflow they can no longer use as it is; 1.0.0 is the user's call) —
   in ALL of:
   `app/package.json`, `app/src-tauri/tauri.conf.json`,
   `app/src-tauri/Cargo.toml`, and the `belen` entry in
   `app/src-tauri/Cargo.lock`. `pnpm release sign` refuses to run when the
   three manifests disagree. (Hand-editing the lock's belen version entry is
   expected here; cargo regenerates the rest on MAYA.)
3. **Add a CHANGELOG.md entry** under a new `## [X.Y.Z] — date` heading.
4. **Open a pull request into `main`** from a feature branch, carrying the
   change, the bump and the changelog entry. Title it with the version and
   the change (`0.4.1: fix the room losing its scroll position`) and say in
   the body how it was verified. Then hand it over: **the user merges.**
   Never merge a PR yourself and never push straight to `main`.
5. **Watch the build** once the PR is merged. Its merge commit triggers the
   `windows build` and `macos build` workflows — the Windows one only if
   MAYA's runner is up (see below):
   ```bash
   sha=$(gh pr view <pr-number> --repo mrlfarano/belen --json mergeCommit --jq .mergeCommit.oid)
   gh run list --repo mrlfarano/belen --commit "$sha" --json databaseId,workflowName,status,conclusion
   gh run watch <run-id> --repo mrlfarano/belen --exit-status   # once per run
   ```
   Wait for both runs. Green means the `belen-windows` (`BELEN.exe`) and
   `belen-macos` (a bare `BELEN` binary) artifacts are uploaded. The copy
   staged at `%USERPROFILE%\belen-dev\BELEN.exe` on MAYA is a convenience
   only; it is not how a change is tested any more.
6. **Release on HAMMER** — every release, both platforms, from a session
   running on HAMMER (check `scutil --get LocalHostName` prints `Hammer`; a
   session on another machine cannot do this step — see the rules below).
   Cut it from a pristine copy of the merge commit, because `release sign`
   reads the version from the manifests around it. Sign first; nothing in
   this block reaches GitHub:
   ```bash
   rm -rf /tmp/belen-rel && git -C ~/dev/belen fetch origin
   git clone --quiet --no-checkout ~/dev/belen /tmp/belen-rel/src
   git -C /tmp/belen-rel/src checkout --quiet --detach <merge-sha>
   mkdir -p /tmp/belen-rel/win /tmp/belen-rel/mac
   gh run download <windows-run-id> --repo mrlfarano/belen -n belen-windows -D /tmp/belen-rel/win
   gh run download <macos-run-id>   --repo mrlfarano/belen -n belen-macos   -D /tmp/belen-rel/mac
   node /tmp/belen-rel/src/app/scripts/release.mjs sign /tmp/belen-rel/win/BELEN.exe --out=/tmp/belen-rel/win/latest.json --notes="<one line for the update dialog>"
   node /tmp/belen-rel/src/app/scripts/release.mjs sign /tmp/belen-rel/mac/BELEN --platform=macos --out=/tmp/belen-rel/mac/latest-macos.json --notes="<one line for the update dialog>"
   ```
   Read both manifests before going on: the version is the PR's and `notes`
   is real text, not the placeholder. Then publish — the step that cannot be
   taken back — Windows first, so its `publish` creates the release and the
   macOS call adds to it:
   ```bash
   node /tmp/belen-rel/src/app/scripts/release.mjs publish /tmp/belen-rel/win/BELEN.exe /tmp/belen-rel/win/latest.json
   node /tmp/belen-rel/src/app/scripts/release.mjs publish /tmp/belen-rel/mac/BELEN /tmp/belen-rel/mac/latest-macos.json --platform=macos
   gh release view vX.Y.Z --repo mrlfarano/belen --json assets --jq '.assets[].name'
   ```
   The first `publish` creates the `vX.Y.Z` release **with both assets in
   one operation**; the second adds the macOS pair to it. Never draft-first,
   never create or move tags by hand. The last command must list four
   assets — `BELEN.exe`, `latest.json`, `BELEN`, `latest-macos.json` —
   before anyone is told to update.
7. **Tell the user to update** — on the Mac or on Windows, their choice:
   Settings → About → **Check for updates** → **Update & restart**. That
   update is the test: nobody runs the new build before it. If it
   misbehaves, fix forward with a new PR and a new patch release. Done
   means the user confirms the new version in the About tab and the room
   shows `BELEN X.Y.Z installed.`

Not every PR gets a release. A docs-only PR (this file, the specs, the task
tables) carries no bump and no changelog entry; its push still triggers a
build, which is fine. A red build releases nothing: fix it with a follow-up
PR that keeps the same, still-unpublished version and folds its changelog
lines into that version's entry. A published version is immutable — never
reuse one. Land one PR at a time: a second PR opened before the first is
released takes the next version number, so rebase and re-bump it before it
merges.

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
- **Signing key**: `~/.belen/update-private.pem` (chmod 600). The original
  lives on HAMMER, where every release is cut; the copy on illaoi is a
  backup.
  The public key is committed at `app/src-tauri/update.pubkey` and compiled
  into every binary. Losing the private key means existing installs can only
  be updated by hand — back it up offline; do not regenerate casually, and
  never commit any `.private.pem`.
- **A release needs a session running on HAMMER, not `ssh la@hammer`.**
  HAMMER's `gh` login is in its login keychain, which an SSH session can't
  reach: over ssh, `gh auth status` says `Failed to log in`, so `publish`
  would fail. From a session on another machine, hand step 6 to a session
  on HAMMER instead of tunnelling it.
- **On HAMMER every `pnpm <script>` rewrites `app/pnpm-lock.yaml`** — its
  pnpm is 12.21.0 against the pinned 12.3.4, and the run drops the
  `@pnpm/exe` entry. It is pnpm's doing, not a dependency change: after
  the gates, `git restore app/pnpm-lock.yaml` before committing. Step 6
  calls `app/scripts/release.mjs` through `node` for the same reason.
- **Never run the release block to try it out.** `publish` is live the
  moment it runs, under the user's own `gh` login, and a release cannot be
  unpublished cleanly. To rehearse, run the `sign` lines only, then delete
  `/tmp/belen-rel`. When a command has to skip lines, print what is about
  to run and confirm the skipped ones are absent first. (Learned
  2026-11-25: a rehearsal with a broken filter published 0.4.0 with the
  placeholder notes.)
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
- Rust unit tests (DPAPI / Keychain, updater) run on MAYA with
  `powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Test`, and on
  HAMMER with `cargo test --manifest-path app/src-tauri/Cargo.toml` — run
  them when touching `src-tauri/`. The `windows build` workflow never runs
  them, so on Windows they only run by hand. Performance-sensitive changes:
  `pnpm perf` on MAYA before releasing.
- Build traps on MAYA (handled by `scripts/build.ps1` — always build through
  it): a machine-global `~/.cargo/config.toml` from another project, and a
  MAX_PATH issue solved by `CARGO_TARGET_DIR=%USERPROFILE%\.belen-target`.
