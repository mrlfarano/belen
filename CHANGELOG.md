# Changelog

All notable changes to BELEN are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is SemVer.

## [Unreleased]

## [0.5.0] — 2026-11-25

### Changed

- **Her tools are on from the first run.** Web search and page reading, file
  changes and commands used to stay off until switched on in Settings → Chat →
  Tools, which is why she came out with nothing but the clock. They are on
  until you switch them off, and an install that already saved a choice keeps
  it. Commands and file changes still wait for you in the room.
- **Your home folder is the workspace** when Settings names none, so the file
  tools and commands have somewhere to work. The model is told the root on
  every send. Choose another folder in Settings → Chat to change it.
- **All seven built-in skills install themselves** before anyone has chosen
  skills in Settings → Skills, with the capabilities they need. A saved list
  is kept as it is, even an empty one.
- **Web search needs no key.** She reads Bing's results page under the app's
  own name instead of calling Tavily, and the Tavily key field is gone from
  Settings. This is not an offered API: if the page changes or the engine
  refuses, search says so instead of coming back empty, and nothing works
  around a refusal. Searches go out at least a second apart, at most twenty a
  minute.
- **Both platforms build on HAMMER.** Every push to `main` — a merged PR —
  runs the `build` workflow on HAMMER's self-hosted runner: the macOS binary
  natively, the Windows exe cross-compiled there for the first time. The
  hosted macOS workflow and MAYA's runner workflow are gone.

### Fixed

- **Web tools could not run with no workspace attached.** The room sent every
  tool call without its workspace argument, and Tauri refuses a call that is
  missing a required argument — before the broker ever saw it. The argument
  is optional now.

## [0.4.0] — 2026-11-25

### Added

- **Tools the user switches on** (Settings → Chat → Tools). Every one of them
  stays off until turned on, and the Rust broker reads the switches itself for
  each call, so nothing depends on the webview's good behaviour.
  - **Clock.** She knows the date and the local time — one line rebuilt for
    every send, in the room and in sub-agents. This part is always on.
  - **Web.** `web_search` (Tavily; the key goes into the encrypted key store)
    and `web_fetch`, which reads public http(s) pages only: loopback, private
    and link-local addresses are refused, every redirect hop is checked again,
    and DNS is pinned to the address that passed the check.
  - **Change files.** `workspace_write` and `workspace_edit` inside the
    attached workspace, behind the read tools' path rules — including through
    symlinks and junctions, even towards a file that does not exist yet. An
    edit replaces exactly one match or says why it did not; a write lands
    whole or not at all.
  - **Run commands.** `run_command` — PowerShell on Windows, zsh on macOS —
    from the workspace or a subfolder of it. Commands run in their own
    process group; a time limit (default 60 s, max 5 min) or `Esc` takes the
    whole tree with them. Variables that look like credentials never reach a
    command.
- **Approvals in the room.** By default each command and each file change
  waits as its own block, showing the whole command or the file's before and
  after, with *Allow once / Allow for this session / Deny*. `Esc` is a deny.
  Changeable under "Ask before".
- Tool rounds per send went from 6 to 12.

### Fixed

- **Tool calls never ran.** The broker refused every tool call as
  "cancelled": a stream counted as cancelled once it was no longer
  registered, and a stream unregisters the moment the model's reply ends —
  which is always before the renderer dispatches the call. Only streams the
  user actually cancelled count now.
- **The tool result never got back to the model.** The run was stopped the
  moment the first reply's stream ended, while the tool call was only being
  dispatched — so the follow-up round, where the model reads the result, was
  always cancelled on arrival. The round's own completion now decides.
- **The tool loop never ended on a final answer.** After one tool call,
  further rounds were started until the limit ("Paused after 6 tool rounds"),
  each rebuilding its history from the first message. A round now ends the
  run when it makes no new calls, and each round carries the exchanges before
  it.

### Changed

- The spec's "no network except the provider" gained one exception: the web
  tools, and only while they are switched on.

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
