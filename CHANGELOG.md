# Changelog

All notable changes to BELEN are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is SemVer.

## [Unreleased]

### Added

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
