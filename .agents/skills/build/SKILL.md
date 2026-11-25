---
name: build
description: Ship a BELEN release end to end — choose and bump the version, write the changelog, push so HAMMER builds both binaries, then publish the public GitHub release with both update feeds after an explicit go from the user. Use whenever the user wants to build or release the app, cut a version, ship changes to installs, or produce new Windows/macOS executables — "build a new release", "ship it", "cut 0.6.0", "make the executables", even when they only say "build". This is not the frontend `pnpm build`; it is the whole release.
---

# Build — ship a BELEN release

Turns merged work on `main` into a public `vX.Y.Z` release. Every installed
app auto-updates from it, so a release is always **both platforms** (a
one-platform release leaves the other platform's update feed 404ing), always
pushed through HAMMER's build, and never published without an explicit go.
The project AGENTS.md holds the background and the war stories; this skill is
the procedure.

Run the steps in order. Do not skip the pause in step 8.

## 1. Preflight

- `hostname -s` says which Mac this is — builds run on **HAMMER** (via the
  push-triggered workflow, from any machine); publishing needs `gh` logged in,
  which works from a desktop session on HAMMER or from illaoi. Over SSH on
  HAMMER the Keychain is unreadable — stop at step 8 and say so instead of
  publishing from there.
- `git fetch --tags` (local tags can lag: a release prepared here but
  published elsewhere, or prepared and never published), then confirm `main`
  is up to date (`git status -sb`; pull `--ff-only` if behind).
- `git status --short` must show no uncommitted *tracked* changes. Untracked
  scratch dirs (`.zcode/`, `.agent/`) are fine. Uncommitted code changes:
  ask whether they belong in this release before continuing.
- Sanity-check publishing early so surprises surface now, not at step 9:
  `gh auth status`.

## 2. Work out the release state

The manifests and the changelog are the ground truth, not the git tag — a
release can be prepared (bumped and changelogged) without having been
published. Read: the version in `app/package.json`, the top release heading
in `CHANGELOG.md`, the last tag (`git describe --tags --abbrev=0`), and
`gh release view --repo mrlfarano/belen --json tagName`. Three cases:

- **Prepared, unpublished** (manifest version above the last tag and the
  changelog has its heading): continue that release — do not bump again.
  Verify the entry covers everything in `git log <last-tag>..HEAD` (read
  diffs where a subject is unclear) and add anything missing.
- **Nothing prepared** (manifest version equals the last published tag):
  derive what's new from `git log <tag>..HEAD`. Empty log → nothing to
  release, say so and stop. Otherwise choose the version (step 3), bump
  (step 4), write the changelog (step 5).
- **Mismatch** (manifests disagree with each other, or sit below the last
  tag): stop and investigate before touching anything — this is not a state
  the loop creates.

## 3. Choose the version (only when nothing is prepared)

SemVer, from the changes: fixes only → patch (`0.5.0` → `0.5.1`); any new
user-facing feature or behaviour change → minor (`0.5.0` → `0.6.0`). If the
user named a version explicitly, use it, but flag a clash with the change
(a feature shipped as a patch). State the choice with a one-line reason at
the pause in step 8 — the user can override.

## 4. Bump the version in all four places

1. `app/package.json`
2. `app/src-tauri/tauri.conf.json`
3. `app/src-tauri/Cargo.toml`
4. the `belen` entry in `app/src-tauri/Cargo.lock` (hand-edit only its
   `version` line; leave the rest of the lock alone)

All four must agree — `pnpm release sign` refuses when the manifests
disagree. Nothing else in any lockfile changes.

## 5. Write the changelog

Add a new heading above the previous release's in `CHANGELOG.md` (below
`## [Unreleased]`), Keep a Changelog sections, matching the file's voice:
bold lead-in sentence, then what changed and why the user cares, present
tense, the app is "she". Example of the shape:

```markdown
## [0.6.0] — 2026-11-25

### Changed

- **Bold lead-in that states the change.** One to three sentences on what
  happens now and why it matters.
```

Write `### Added` / `### Changed` / `### Fixed` sections only when they have
entries. From the same material, draft the **update-dialog notes**: one
plain line for `--notes=` (e.g. "Tools are on from the first run; web search
needs no key.").

## 6. Gates, commit, push

```bash
pnpm --dir app typecheck   # must be clean
pnpm --dir app test        # must be green
```

On HAMMER, every pnpm run rewrites `app/pnpm-lock.yaml` — restore it
(`git checkout -- app/pnpm-lock.yaml`) before committing, and stage files by
name: the four version files, `CHANGELOG.md`. Commit to `main` in the repo's
sentence style (no conventional-commit prefixes) and push. Docs-only and
skill-only pushes still build; that is fine.

## 7. Watch the HAMMER build

```bash
gh run list --repo mrlfarano/belen --limit 1
gh run watch <run-id> --repo mrlfarano/belen --exit-status
```

Green means both binaries exist on HAMMER in `~/builds/belen/` (`BELEN`,
`BELEN.exe`) and as the `belen-macos` / `belen-windows` artifacts. Red means
read the log, fix, commit, push, watch again — the release waits for green.
A run sitting `queued` means HAMMER is down or logged out:
`gh api repos/mrlfarano/belen/actions/runners`; on HAMMER itself,
`cd ~/actions-runner && ./svc.sh status`.

## 8. Pause — show the release, wait for the go

This is the gate before anything public happens. Show the user, in one
message: the version (with the patch/minor reason), the changelog entry
verbatim, the one-line update notes, and the two assets about to be
uploaded. Publishing creates a public release that every install
auto-updates from, so wait for an explicit go. An edit to the changelog or
notes at this point is cheap — take it, re-commit, and let the docs-only
build run.

## 9. Publish — Windows first, then macOS

The Windows `publish` creates the `vX.Y.Z` release with both assets in one
operation; the macOS call adds its pair to it. Never draft-first, never
create or move tags by hand. If this is HAMMER and the binaries are local,
skip the copy.

```bash
rm -rf /tmp/belen-rel && mkdir -p /tmp/belen-rel/win /tmp/belen-rel/mac
cp ~/builds/belen/BELEN.exe /tmp/belen-rel/win/
cp ~/builds/belen/BELEN     /tmp/belen-rel/mac/
pnpm --dir app release sign /tmp/belen-rel/win/BELEN.exe --out=/tmp/belen-rel/win/latest.json --notes="<update-dialog notes>"
pnpm --dir app release sign /tmp/belen-rel/mac/BELEN --platform=macos --out=/tmp/belen-rel/mac/latest-macos.json --notes="<update-dialog notes>"
pnpm --dir app release publish /tmp/belen-rel/win/BELEN.exe /tmp/belen-rel/win/latest.json
pnpm --dir app release publish /tmp/belen-rel/mac/BELEN /tmp/belen-rel/mac/latest-macos.json --platform=macos
```

## 10. Verify, then hand off to the user

```bash
gh release view vX.Y.Z --repo mrlfarano/belen   # four assets: both binaries + both manifests
```

Both feeds resolve at
`https://github.com/mrlfarano/belen/releases/latest/download/latest.json`
and `latest-macos.json` at the same path — fetch each and check its
`version` field. Then tell the user: **Settings → About → Check for updates
→ Update & restart**. Done means the About tab shows the new version and the
room says `BELEN X.Y.Z installed.`
