# Changelog

All notable changes to BELEN are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is SemVer.

## [Unreleased]

## [0.3.0] — 2026-11-25

### Added

- **macOS build (Apple Silicon).** BELEN now also ships as a portable bare
  binary — `BELEN`, no `.app` bundle — with the same `data/` layout beside
  it as on Windows. Every push builds it in CI (`macos build` workflow,
  `belen-macos` artifact).
- **Keychain key storage on macOS.** API keys and OAuth tokens are stored
  as generic passwords in the login Keychain (service `dev.belen.desktop`);
  Windows keeps DPAPI. No secrets live in `data/` on either platform.
- **Separate macOS update feed.** macOS installs check a signed
  `latest-macos.json`, so a Windows install can never be handed a macOS
  binary (or vice versa). Releases now publish both platforms.
- **First run on macOS (unsigned build).** Put `BELEN` in a writable folder
  (for example `~/Apps/BELEN/` — not `/Applications`), run `chmod +x
  BELEN`, and for browser downloads `xattr -d com.apple.quarantine BELEN`.
  After an update macOS may ask for Keychain access — choose **Always
  Allow**, or saved keys cannot be read.

## [0.2.2] — 2026-11-24

### Added

- **Read-only workspace tools.** Attach a workspace in Settings → Chat and the
  model can list, read and search its files through a Rust broker (`tool_exec`)
  — path-validated, size-capped, nothing writable. Streamed tool calls are
  assembled by call id, arguments are validated before dispatch, and the loop
  is bounded at six model↔tool rounds per send.
- **Conversation width setting** in Settings → Chat (narrow / default / wide).
- **Jump to latest ↓** button while reading history.

### Fixed

- Streaming stays put and stays intact: a follow-up send or Escape while an
  answer is streaming no longer bleeds the old stream into the new reply (runs
  are generation-guarded and aborted in Rust via `provider_cancel`), and the
  tokens received in the last frame are kept, not dropped.
- Auto-scroll follows streamed text as it grows, not just new blocks; a
  ResizeObserver re-pins after late layout (components, webfonts), and reading
  history freezes the visible window so appends never shift the page.
- Multibyte characters split across network chunks no longer arrive as
  mojibake — SSE lines are decoded only once complete (`drain_lines`).
- Sub-agents now receive the recent conversation, so `/critic` actually
  reviews BELEN's last answer instead of an empty room.
- Worker output and long unbroken text no longer push the transcript into
  horizontal scrolling.

## [0.2.1] — 2026-11-24

### Added

- **Push-to-build pipeline.** Every push to `main` builds the portable exe on
  the Windows machine via a self-hosted runner and stages it for testing.

### Fixed

- The About tab now always shows the running app's version — previously it
  stayed blank until a check succeeded.

## [0.2.0] — 2026-11-24

### Added

- **Self-update, on demand.** Settings → About (also in the `Ctrl+K` palette)
  checks the release feed for a signed manifest, shows the new version and
  notes, and installs after confirmation: the portable exe is hash-verified,
  swapped in place and restarted; `data/` is untouched. Nothing checks or
  downloads unless you click.
- **Release tooling.** `pnpm release init / sign / publish` generates the
  Ed25519 update keypair (private key kept outside the repo), signs the built
  exe into `latest.json`, and uploads both to the GitHub release via `gh`.
- MIT license; repository README with an animated demo of the room.

## [0.1.0] — 2026-11-24

First public release.

### Added

- **The room.** Single continuous typographic surface with block types
  `user`, `assistant`, `text`, `tool`, `artifact`, `worker`, `system`; speaker
  rendered as typography, never bubbles. Virtualised long rooms (blocks beyond
  ~200, `content-visibility: auto`) with no reflow while streaming.
- **BUI protocol (v1).** Declarative, versioned JSON component format — the
  model proposes, BELEN renders. Inline tables (sortable, filterable, pinnable)
  and charts; unknown blocks degrade to text.
- **Fork and pin.** Any assistant block can be forked into a branch or pinned
  as persistent context.
- **Command surface.** `Ctrl+K` summons chrome, `Esc` returns to the room.
- **Provider support.** OpenAI-compatible, Anthropic, Google, Ollama, LM
  Studio; streaming across all of them.
- **Auth.** API-key and OAuth modes; keys encrypted at rest with DPAPI in
  `data/keys/*.dpapi`.
- **Cordis kernel.** Reversible-effect runtime (Context · Fiber · Service) in
  pure TypeScript inside WebView2, with a custom manifest loader for skills and
  plugins (no Node shipped).
- **Built-in skills.** `export-markdown`, `concise`, `table-first`, `cite`,
  `researcher`, `critic`.
- **Performance harness.** `pnpm perf` enforces the budget (cold start ≤ 400 ms,
  warm launch ≤ 120 ms, p99 keystroke ≤ 5 ms, 0 dropped frames, idle working set
  ≤ 120 MB, portable folder ≤ 15 MB) against the real binary; `pnpm summon`
  measures resident summon latency.
- **Portable build.** `scripts/build.ps1 -TauriBuild` produces a no-installer
  portable exe (~10 MB with data beside it).
- **Dev tooling.** Mock OpenAI-compatible provider (`pnpm mock`) and end-to-end
  provider probe (`pnpm probe`); Vitest suite for the kernel, BUI, room store,
  and skills.
