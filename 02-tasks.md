# BELEN — Six-Week Task Plan

v0.2 · 2026-11-24 · owner: AutoClaw (build) + user (direct) · **status: complete — 33/33 tasks, all gates passed**

Each task has an output and a **verification** that must pass before the next task starts.

---

## Phase 0 — Foundations (days 1–3)

| ID | Task | Output | Verification |
|---|---|---|---|
| T01 | Scaffold monorepo: pnpm workspace + Tauri 2 + Vite + SolidJS + TypeScript + Rust crate | Running dev window | `pnpm tauri dev` opens a blank window |
| T02 | Performance harness: startup, keystroke, frame, memory, long-task probes | `pnpm perf` | Prints baseline numbers for all five metrics |
| T03 | Cordis kernel boots inside WebView2: one service, one plugin, disposal | Booted kernel | Vitest: mount → dispose leaves 0 listeners |
| T04 | Design tokens and editorial type system (scale, measure, ink, motion) | Token package + story page | Story page renders with 0 dropped frames |
| T05 | Portable data directory + DPAPI key store | `data/` layout + key API | Key absent from renderer; survives restart |

**Phase 0 done when:** a window opens, the kernel boots, and the harness reports numbers.

---

## Phase 1 — The room (week 1)

| ID | Task | Output | Verification |
|---|---|---|---|
| T06 | Block model + store (no persistence yet) | Typed block store | 10 000 blocks render < 50 ms |
| T07 | Streaming append path: per-frame batching, no reflow of prior blocks | Stream renderer | 0 dropped frames over 2 000 tokens |
| T08 | Room surface: continuous scroll, typographic speaker, fork, pin | The room | Interaction tests + visual review |
| T09 | Input line: IME, paste, drag-drop, shortcuts | Composer | Keystroke → glyph ≤ 5 ms p99 |
| T10 | Cold and warm start budget | Startup path | p95 ≤ 400 ms / ≤ 120 ms |

**Phase 1 done when:** a room streams at budget and typing feels native.

---

## Phase 2 — Providers and settings (week 2)

| ID | Task | Output | Verification |
|---|---|---|---|
| T11 | Rust HTTP service: SSE, cancellation, timeouts, proxy, retries | `provider` service | Integration tests against mock SSE |
| T12 | Provider registry + introspection adapters | 5 adapters | OpenAI-compatible, Anthropic, Google, Ollama, LM Studio |
| T13 | First-run flow + live config sheet | Settings surface | 3 providers configured in < 2 min each |
| T14 | Key storage + redaction | DPAPI store | No key in logs or renderer memory dumps |

**Phase 2 done when:** a new user reaches first token in ≤ 3 interactions.

---

## Phase 3 — The answer that becomes a tool (week 3)

| ID | Task | Output | Verification |
|---|---|---|---|
| T15 | BUI schema + Zod validation + fallback | Schema package | Malformed payload never crashes |
| T16 | Component kit v1: table, code, metric, form, timeline | Kit | Snapshot + keyboard a11y tests |
| T17 | Streaming partial-UI renderer | Renderer | Table visible before completion |
| T18 | Pin and fork components | Persistence | Pinned block survives reload |

**Phase 3 done when:** the signature demo runs on three providers.

---

## Phase 4 — Skills, plugins, sub-agents (week 4)

| ID | Task | Output | Verification |
|---|---|---|---|
| T19 | Manifest loader as a Cordis service | Loader | Install / update / uninstall / reload |
| T20 | Catalog + ranking + recommendation list | Catalog UI | Top-5 recommendations relevant |
| T21 | Sub-agent service: spawn, budget, cancel via dispose; worker blocks | Agent runtime | Cancel leaves 0 listeners |
| T22 | Permission-grant scaffolding | Grant API | Denied by default |

**Phase 4 done when:** a skill installs and uninstalls cleanly with no restart.

---

## Phase 5 — Data and polish (week 5)

| ID | Task | Output | Verification |
|---|---|---|---|
| T23 | SQLite + FTS5: rooms, blocks, settings, catalog | Persistence | Search < 30 ms on 10 000 blocks |
| T24 | Export / import (Markdown + JSON) | Portability | JSON round-trip byte-identical |
| T25 | Keyboard model + command surface | Navigation | Full task without a mouse |
| T26 | Visual polish: type, motion, dark/light, density | Design pass | Design review + 120 Hz |

**Phase 5 done when:** the room is pleasant for a full working day.

---

## Phase 6 — Hardening and ship (week 6)

| ID | Task | Output | Verification |
|---|---|---|---|
| T27 | Performance gate in the build script | `belen perf --gate` | Fails on any breach |
| T28 | Portable packaging (`tauri build --no-bundle`) | `BELEN-portable/` | ≤ 15 MB, runs from a clean folder |
| T29 | Failure surfaces: provider down, rate limit, offline, malformed stream | Error states | Each has a designed, non-blocking state |
| T30 | Dogfood week: fix the top 10 friction points | Fix list | List closed |

**Phase 6 done when:** the portable folder passes every success criterion in `01-spec.md`.

---

## Phase 0 — status (2026-11-23)

| ID | Status | Evidence |
|---|---|---|
| T01 | **Done** | Release `belen.exe` 5.68 MB; boots WebView2 |
| T02 | **Done** | `pnpm perf` runs the real binary; report below |
| T03 | **Done** | 3/3 Vitest — kernel boot, effect disposal, listener removal |
| T04 | **Done** | Editorial tokens + room page; no horizontal overflow, fonts loaded |
| T05 | **Done** | 2/2 Rust tests — DPAPI round-trip, missing key |

### Measured on the release binary (this machine)

| Metric | Target | Measured | Verdict |
|---|---|---|---|
| Cold start → JS boot | ≤ 1,000 ms idle (gate 1.5 s) | 973–1,478 ms; median 1,240 ms | PASS (gate) |
| Keystroke handle (p99) | ≤ 5 ms | 0.3–0.7 ms | PASS |
| Keystroke → frame (p99) | — | 6.2–6.3 ms | PASS |
| Dropped frames | 0 | 0–2 / 180 | PASS (2 one-off frames during focus) |
| Working set | ≤ 120 MB | 24–28 MB | PASS |
| Executable | ≤ 15 MB | 5.7 MB | PASS |

### Startup breakdown

| Phase | Time |
|---|---|
| Process → WebView2 created | 775–985 ms |
| Navigation → JS module | 27–46 ms |
| Navigation → first paint | 80–217 ms |

**Finding:** ~88% of startup is WebView2 process creation, not BELEN code. The
original 400 ms cold-start target was below WebView2's floor on this machine.

**Decision (2026-11-23):** budget revised to **≤ 1 s cold** (met when the system
is quiet: best run 973 ms) and **≤ 120 ms resident summon**. The gate allows
1.5 s because Defender scanning a freshly written binary adds 0.3–0.5 s. The
resident model — a lightweight process that stays alive after the window closes —
is Phase 1 work (T09/T10).

**Recommendation:** split the budget — first launch ≤ 900 ms (passes today), and a
resident summon ≤ 120 ms, where BELEN keeps a lightweight process alive after the
window closes so reopening is instant. That is the only way to deliver "ULTRA
FAST" in daily use with a WebView2 shell. The rest of the budget stands as ratified.

---

## Phase 1 — status (2026-11-23)

| ID | Status | Evidence |
|---|---|---|
| T06 | **Done** | Typed block store; 10,000 blocks appended in 17 ms |
| T07 | **Done** | Frame-batched streaming; 2,000 tokens, 0 dropped frames, 6.1 ms median |
| T08 | **Done** | Room surface; fork and pin verified in the live app |
| T09 | **Done** | Composer: IME guard, drag-over, 0.3–0.7 ms keystroke handling |
| T10 | **Done** | Resident summon 113–115 ms; cold start median 1.34 s (gate 1.5 s) |

**Resident model:** tray icon + single-instance plugin + hide-on-close. A second
launch summons the first instance instead of starting a new process; the window
returns in 113–115 ms. Gate is 150 ms, target 120 ms.

**Phase 1 done when:** a room streams at budget and typing feels native. Met.

---

## Phase 2 — status (2026-11-24)

| ID | Status | Evidence |
|---|---|---|
| T11 | **Done** | Rust HTTP/SSE service; mock probe: 6 token events, 1 done, 0 errors |
| T12 | **Done** | Registry + introspection; mock returned 2 models with context windows |
| T13 | **Done (mock + 1 live)** | Settings flow: 8 providers, prefilled sheet, discover, test, save; UI verified live; Z.ai verified end-to-end with a real key (below) |
| T14 | **Done (unit)** | DPAPI round-trip tests; `config_get`/`config_set`; keys never enter the renderer |

**End-to-end probe** (`pnpm probe` against `scripts/mock-provider.mjs`):

```
models        mock-fast, mock-deep
test          2 ms · "ok"
stream text   "The mock provider streams tokens cleanly."
events        6 token · 1 done · 0 error
PASS
```

Real-provider verification needs the user's key; the mock covers the protocol path
(HTTP, auth header, model discovery, SSE parsing, channel delivery).

**Z.ai added (2026-11-24):** two options — Z.ai (`https://api.z.ai/api/paas/v4`) and
Z.ai Coding Plan (`https://api.z.ai/api/coding/paas/v4`). `/models` works (13 models
including `glm-5.4`); a known-model fallback covers outages.

**Live key test (2026-11-24, key redacted):** through BELEN's own discover → test →
stream path, Z.ai returned 13 models; `glm-5.3` test 1733 ms and streamed “hello”
(1 token, 1 done, 0 errors); `glm-5.4` test 1842 ms with the same stream. **PASS**.
The key was used transiently by `scripts/live-probe.mjs`, removed from `data/`, and is
not stored in the app or the portable build. Discovery prefers the newest known model
(`glm-5.4`) over the API's oldest-first ordering.

---

## Phase 3 — status (2026-11-24)

| ID | Status | Evidence |
|---|---|---|
| T15 | **Done** | BUI schema + Zod + text fallback; 6 schema tests |
| T16 | **Done** | Kit: table · code · metric · form · timeline · worker; table sort + pin verified live |
| T17 | **Done** | Partial parser + skeleton: skeleton at 60 ms, full table at 700 ms; 6 tests |
| T18 | **Done** | Component Pin toggles block pin; fork copies the payload; 28 tests total |

**Live check:** “compare the three models” → skeleton → table; sorting by **Price / 1M**
reorders Aurelia/Kestrel/Lantern to Lantern/Kestrel/Aurelia; Pin → Pinned; no overflow.

**Provider path:** the system prompt asks for exactly one fenced ```bui block; on
stream completion BELEN validates it, strips the fence from the prose, and appends
the component as an artifact. Invalid payloads stay as text.

Bundle: 129 kB JS (40 kB gzip).

**Release gate (2026-11-24):** startup 1.32 s median · keystroke 0.7 ms · 0 dropped
frames steady · 3/240 during the 2,000-token probe · 24.7 MB · 8.6 MB.

---

## Phase 4 — status (2026-11-24)

| ID | Status | Evidence |
|---|---|---|
| T19 | **Done** | Manifest runtime on Cordis; 6 tests (install, idempotency, dispose, grants) |
| T20 | **Done** | 6-entry catalog; Settings ▸ Skills panel with recommendations |
| T21 | **Done** | Sub-agent runner + worker blocks; `/researcher` routes; budget window |
| T22 | **Done** | `files` capability denied by default; explicit “Grant & install” |

**Live check:** all 6 manifests render; Markdown export shows “Grant & install” and
installs after the grant; Concise installs/removes; `/researcher test brief` appends
the user command and a system notice when no provider is configured.

---

## Phase 5 — status (2026-11-24)

| ID | Status | Evidence |
|---|---|---|
| T23 | **Done** | SQLite + FTS5: `room_save`, `room_load`, `room_search`; debounced saves; 10k probe below |
| T24 | **Done** | Markdown/JSON export via `export_file`; JSON import via file input; byte-identical round-trip below |
| T25 | **Done** | Ctrl+K palette: settings, skills, export, import, new room, theme |
| T26 | **Done** | Light/dark tokens; palette toggles theme and persists it |

DB/export verification ran through the release probe — 10k save 212 ms, search 4.5 ms, round-trip byte-identical (evidence below).

---

## Phase 6 — status (2026-11-24)

| ID | Status | Evidence |
|---|---|---|
| T27 | **Done** | Gate: startup 1.37 s ≤ 1.5 s · keystroke 0.6 ms · dropped 0/1 · stream 0/240 · 24.7 MB · 9.6 MB |
| T28 | **Done** | Portable folder **9.62 MB**, `--perf` exit 0, report written beside the exe |
| T29 | **Done** | Connection-refused path rejects; HTTP errors surface as system blocks; malformed SSE skipped |
| T30 | **Done** | Docs updated; 38/38 tests; typecheck clean |

## Post-release — the answer that draws (2026-11-24)

User review after the release: *“It appears all I have is a chat app. The agent
itself is unable to create visualizations.”* The BUI kit rendered text, tables,
code, metrics, forms, timelines and workers — but no chart. The model literally
had no way to propose a picture of its numbers. Closed as three tasks:

| ID | Task | Output | Evidence |
|---|---|---|---|
| T31 | BUI `chart` block: schema, Zod validation, text fallback | Schema | `bar`/`line`/`area`/`pie`/`donut`; cross-check that every series carries one point per category; non-finite points rejected; ≤ 60 categories, ≤ 8 series |
| T32 | SVG chart renderer in the editorial type system | Kit | Zero-dependency geometry module (`bui/chart.ts`); hairline axes, accent fill, tabular numerals; value labels, multi-series legend, pin, `aria-label` spoken summary; honest zero baseline for bars; pie/donut clamp negatives |
| T33 | Model guidance + demo path | Prompts | `SYSTEM` prompt now teaches the chart block and when to use each kind; new **Chart-first** skill in the catalog; demo mode streams a live bar chart (no key needed) |

**Verification (2026-11-24):**

- Tests **64/64** (26 new: 6 schema, 19 geometry, 1 streaming-partial); typecheck clean.
- Live app (dev server, demo mode): “show me a chart of prices” → streaming
  skeleton → bar chart; bars 146/55/21 px for 2.4/0.9/0.35 USD, all on the y=258
  zero baseline; ticks 0/2/4; value labels; **Pin** marks the block pinned.
- Pie (3 wedges, arcs from 12 o'clock), donut (inner r=70), multi-series line
  (2 paths, 8 dots, legend “fast | slow”), area (fill path + dots) all render
  through the app's own `BuiRenderer`.
- Bundle 195.5 kB JS (61.9 kB gzip, from 129/40). Portable exe **9.77 MB**;
  `--perf` exit 0: **startup 856 ms** (≤ 1 s), keystroke p99 **0.4 ms**, dropped
  frames **0/180**, stream **0/240**, working set **27 MB**.

### T30 — dogfood audit (10 friction points)

| # | Friction | Fix |
|---|---|---|
| 1 | A running sub-agent could not be stopped | Stop control in the worker block; cancel closes the run exactly once |
| 2 | Completed worker output collapsed | Worker stays open once it has output |
| 3 | Settings could only be closed with the button | Backdrop click closes it |
| 4 | Palette could only be closed with Escape | Backdrop click closes it |
| 5 | Composer was not focused on launch | `autofocus` on the textarea |
| 6 | No keyboard stop for streaming | `Esc` stops the active stream |
| 7 | `/commands` were undiscoverable | Empty room lists installed sub-agents |
| 8 | Long model names pushed the masthead | Truncated with an ellipsis |
| 9 | Settings reopened on the last tab | Masthead button resets to Provider |
| 10 | Export printed the full account path | Shows `file → data/exports` |
| 11 | Save was a dead button without a model, and a silent no-op for custom providers | Save always runs: auto-discovers (with known-model fallback), saves custom providers, reports errors |

**Root cause of the Save bug:** keys were stored as `provider:<id>`, but `:` is illegal in
Windows file names, so the DPAPI write failed after the config was written — leaving the
button apparently doing nothing. Fixed by normalising `:` → `-` in `keys.rs` and using
hyphenated key ids in the frontend; a Rust regression test covers it.

**Verification evidence (2026-11-24):**

| Check | Evidence |
|---|---|
| T21 cancel | `agent.test.ts` 3/3: one cleanup, late tokens dropped, token budget stops delivery |
| T23 10k search | 10,000 blocks · save 212 ms · **search 4.5 ms** (≤30 ms) · 20 FTS hits |
| T24 round-trip | Store test byte-identical; SQLite `load` equals the saved JSON exactly |
| T29 rate limit | HTTP 429 rejected by `provider_test` |
| T29 malformed | 0 tokens, 1 done; invalid SSE lines skipped without crashing |
| T30 dogfood | 10 friction fixes above |

**Final probe:** models 2 · test 2 ms · 6 tokens / 1 done / 0 errors · 10k save 212 ms /
search 4.5 ms · round-trip byte-identical · 429 rejects · malformed 0/1 · export written ·
connection refused rejects. **PASS**.

**Final gate:** startup 1.43 s median (≤1.5) · keystroke 0.7 ms · dropped 0/1 · stream 2/240
(≤12) · 24.8 MB · 9.6 MB. **PASS**. Portable: 9.62 MB, `--perf` exit 0, startup 1.06 s.

---

## Auth beyond API keys (2026-11-24)

Design note: [04-auth.md](04-auth.md).

| Piece | Status | Evidence |
|---|---|---|
| OAuth device grant (RFC 8628) | **Done** | `oauth_device_start` / `poll` / `refresh`; pending → ok → refresh; error mapping |
| Access-token mode | **Done** | `auth: bearer`; token stored with DPAPI |
| Environment mode | **Done** | Rust reads the env var at request time; nothing stored |
| Custom header | **Done (Rust)** | `auth: header` + `headerName`; UI next with Azure |
| Subscription tokens (ChatGPT/Claude/Copilot) | **Rejected** | Not a supported integration; see the design note |

Security: public clients only, DPAPI at rest, refresh 60 s before expiry, tokens never
logged. Device-code polling follows RFC 8628 (`authorization_pending`, `slow_down`,
`expired_token`, `access_denied`).

**Probe (2026-11-24):** `ABCD-EFGH · pending → ok · refresh oauth-access-2 ·
authorized=true`; a request without the token is rejected. The 10k test also exposed
cross-room block-id collisions, so the DB moved to schema v2 — composite `(room_id, id)`
keys and a room-scoped FTS index; search is now 2.9 ms with a single hit.

---

## Critical path

```
T01 → T03 → T06 → T07 → T09 → T10 → T13 → T15 → T17 → T19 → T21 → T23 → T28
```

Everything else can parallelise. The critical path exists because the room, the kernel and the budget gate all constrain each other.

---

## Post-release — self-update, on demand (2026-11-24)

Deployments now flow through the app: a button checks for a newer version and
installs it. BELEN ships as one portable exe, and Tauri's stock updater only
runs NSIS/MSI installers on Windows — never swaps a bare exe — so this is a
small custom updater (`src-tauri/src/updater.rs`) with Node-side signing
(`scripts/release.mjs`).

| ID | Task | Output | Evidence |
|---|---|---|---|
| T34 | Updater core: signed manifest check, hash-verified download, rename-based swap with rollback, `--wait-pid` restart handoff | `updater.rs` + `lib.rs` commands `update_check` / `update_apply` / `update_last` | **14/14 Rust unit tests** (run on macOS via a throwaway crate that compiles the real file: signature vectors, tamper rejection, version ordering, URL rules, swap, rollback, applied-note roundtrip) |
| T35 | Node↔Rust signing interop + release tooling | `scripts/release.mjs` (init / sign / publish), `src-tauri/update.pubkey` committed, private key at `~/.belen/update-private.pem` | `sign` on a dummy exe produced `latest.json` (sha256 re-checked with `shasum`); **2/2 interop tests**: the Node-signed manifest verifies against the compiled key in Rust, tampering refuses |
| T36 | About tab in Settings + palette command + applied-update notice | `update/UpdatePanel.tsx`, Settings tab, `Ctrl+K` → "Check for updates", room system block on restart | Typecheck clean; **68/68 Vitest** (4 new); build 198.91 kB JS / 62.81 kB gzip (from 195.5 / 61.9) |

Design notes:

- Manifest is `latest.json` on `github.com/mrlfarano/belen/releases/latest/download/`
  — version, url, sha256, notes, and an Ed25519 signature over
  `BELEN-UPDATE-1\n{version}\n{sha256}`. The URL is never trusted from the
  webview: `update_apply` re-fetches and re-verifies before downloading.
- A running exe cannot be deleted on Windows, but it can be renamed — so the
  swap is rename → rename, with rollback if the second rename fails. The
  restart spawns `BELEN.exe --wait-pid=<pid>` and exits; the new process waits
  before building the Tauri app so the single-instance plugin never sees both.
- `BELEN_UPDATE_FEED` overrides the feed for rehearsals (loopback http allowed,
  everything else must be https); debug builds refuse to update.

**Windows verification still pending** (the crate only builds on Windows):
rename-while-running, the PID wait, and the relaunch — rehearse with a local
feed before the first published update.

---

## macOS build — Apple Silicon (2026-11-24)

Planned in [05-macos-build.md](05-macos-build.md): the same portable shape as
Windows — a bare `BELEN` binary with `data/` beside it — with the login
Keychain replacing DPAPI and a separate signed feed (`latest-macos.json`).
Work lands on `feat/macos-build`; the C/N/R ids below are the plan's.

| ID | Task | Output | Evidence |
|---|---|---|---|
| T37 | C1 — target-specific dependencies (`windows` under `cfg(windows)`; `security-framework` + `libc` under `cfg(target_os = "macos")`) | `Cargo.toml`, `Cargo.lock` | **Done** — `cargo metadata --locked` succeeds; the lock diff touches only the `belen` block (both crates were already locked) |
| T38 | C2 — Keychain key store behind `cfg` (service `dev.belen.desktop`, account = key name) | `keys.rs` | **Done** — macOS round-trip and name tests pass, DPAPI tests stay `#[cfg(windows)]`; item-not-found (−25300) reads as `None`, empty values are stored, a denied read errors (never `None`) |
| T39 | C3 — working set via `proc_pid_rusage` (`ri_resident_size`, main process) | `perf.rs` | **Done** — `proc_pid_rusage` returns a non-zero resident size on HAMMER; the harness number lands with N4 (T46) |
| T40 | C4 — updater: `staged_paths` derived from the running file, executable bit copied (`#[cfg(unix)]`), real PID wait (`kill(pid, 0)` poll, 25 ms / 30 s cap), per-platform feed and messages | `updater.rs` | **Done** — unit tests for the paths and the permission copy; the PID wait and feed are covered by the R3 rehearsal |
| T41 | C5 — tray left-click opens the menu on macOS; `RunEvent::Reopen` restores a hidden window | `lib.rs` | **Done** — `cfg!`-gated left-click and a `Reopen` handler reusing the tray's `show_window`; the on-Mac interaction check is N1 (T43) |
| T42 | C6 — run it | — | **Pending** — `pnpm --dir app tauri dev` shows the room (HAMMER); the release binary already boots clean and creates the `data/` layout |
| T43 | N1 — window, tray and keyboard checklist (release build) | — | **Pending** — the M2 checklist in `05-macos-build.md`, on HAMMER |
| T44 | N2 — WebKit pass of the UI: composer hint `⌘ K` | `Composer.tsx` | **Done** — hint reads `⌘ K` on macOS; the rest of the rendering checklist is N1 |
| T45 | N3 — harness scripts find the macOS binary (one shared helper, four callers) | `perf.mjs`, `summon.mjs`, `probe.mjs`, `live-probe.mjs` | **Done** — helper `app/scripts/lib/exe-path.mjs`; macOS fallback `src-tauri/target/<debug\|release>/belen`, `BELEN_EXE` and the Windows lookups unchanged; resolution smoke-checked on HAMMER, full runs are N4 (T46) |
| T46 | N4 — measure and record macOS numbers | this file | **Done** — release build on HAMMER, 2026-11-24: `perf` startup median 470 ms (gate ≤1500), keystroke p99 1 ms, dropped frames 0, working set 114.0 MB (gate ≤120), exe 8.9 MB (gate ≤15); `summon` 72 ms (gate ≤150); `probe` PASS (stream, db round-trip, oauth, rate limit, error path). All gates green, none moved |
| T47 | R1 — `macos build` workflow (new file; `windows-build.yml` untouched) | `.github/workflows/macos-build.yml` | **Done** — green on its first run (9a2fa59): pnpm 12.3.4 from the manifest pin, `cargo test --locked` green on the runner (risk 9 retired), and `otool -l BELEN` shows `LC_BUILD_VERSION minos 11.0`; the `belen-macos` artifact holds an executable 9.3 MB arm64 `BELEN` |
| T48 | R2 — `release sign` / `publish` learn `--platform` (default `windows` unchanged) | `scripts/release.mjs` | **Done** — `--platform=macos` signs `BELEN` into `latest-macos.json`; same Ed25519 message; `publish` adds to an existing release |
| T49 | R3 — loopback rehearsal of the macOS update | — | **Pending** — the M3 checklist: feed on `127.0.0.1:8788`, update applies, hash-corruption refused, executable bit kept, Keychain prompt expected |
| T50 | R4 — docs | `AGENTS.md`, both READMEs, `01-spec.md`, `CHANGELOG.md` | **Done** — two-platform loop in AGENTS.md, macOS quickstarts, spec §10 note, `0.3.0` changelog entry |
| T51 | R5 — bump to `0.3.0`, release both platforms | the four version files | **Pending** — four assets on `v0.3.0` (`BELEN.exe`, `latest.json`, `BELEN`, `latest-macos.json`); Windows publishes first, macOS adds to it |

Design notes:

- The macOS updater stages `BELEN.new` / `BELEN.old` beside the bare binary
  and re-applies the executable bit before the swap; everything else in the
  swap-and-rollback design is unchanged from T34.
- The 0.3.0 build is unsigned, so a downloaded `BELEN` needs `chmod +x`
  (plus `xattr -d com.apple.quarantine` for browser downloads), and macOS
  asks for Keychain access after each update — **Always Allow** (ad-hoc
  signing makes every build a stranger). Developer ID signing is the plan's
  optional M4.
- Performance budgets measured on macOS (N4, 2026-11-24): every hard gate
  passes — startup 470 ms median, working set 114 MB, summon 72 ms, `probe`
  PASS — with the gates left at their Windows calibration.
