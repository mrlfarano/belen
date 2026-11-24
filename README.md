# BELEN

**The interface is the conversation.**

BELEN is a native Windows room where you type, the model answers, and the answer becomes the tool you need. A single continuous typographic surface — no bubbles, no cards, no avatars, no sidebar. Provider-agnostic, local-first, portable.

## Highlights

- **One room, not a chat client.** Blocks (`user`, `assistant`, `tool`, `artifact`, `worker`, `system`) scroll as one document; the speaker is typography, chrome is summoned (`Ctrl+K`) and dismissed (`Esc`).
- **BUI — the answer that becomes a tool.** The model streams text *and* declarative JSON components (tables, charts) that render inline, sortable and pinnable, before the sentence finishes. Unknown components degrade to text; nothing breaks the page.
- **Bring your own provider.** OpenAI-compatible endpoints, Anthropic, Google, Ollama, LM Studio — keys stored locally, encrypted with DPAPI.
- **Cordis-spined plugin runtime.** Skills and plugins load from manifests via a reversible-effect kernel (Context · Fiber · Service) that runs inside WebView2 — no Node shipped.
- **Portable.** One folder, no installer, no admin, no registry — `data/` lives beside the executable. ~10 MB.
- **Fast by budget.** Cold start ≤ 400 ms, warm launch ≤ 120 ms, p99 keystroke ≤ 5 ms, zero dropped frames, idle working set ≤ 120 MB — enforced by `pnpm perf` against the real binary.

## Requirements

- Windows 11 + WebView2 Runtime
- Node 24+, pnpm 12+
- Rust 1.98 (MSVC) + Visual Studio 2026 Build Tools

## Quickstart

```powershell
pnpm install
powershell -ExecutionPolicy Bypass -File scripts/build.ps1
```

Then run `%USERPROFILE%\.belen-target\debug\belen.exe`.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Vite dev server on `127.0.0.1:1420` |
| `pnpm build` | Production frontend into `dist/` |
| `pnpm test` | Cordis kernel tests (Vitest) |
| `pnpm typecheck` | TypeScript check |
| `pnpm perf` | Launch the real binary in `--perf` mode and print the budget report |
| `pnpm summon` | Measure resident summon latency |
| `pnpm mock` | Local OpenAI-compatible mock provider on `:8787` |
| `pnpm probe` | End-to-end provider probe (discover, test, stream) |
| `scripts/build.ps1` | Debug build (VsDevCmd + machine overrides) |
| `scripts/build.ps1 -Release` | Release build with LTO |
| `scripts/build.ps1 -TauriBuild` | Portable build, no installer |
| `scripts/build.ps1 -Test` | Rust unit tests (DPAPI) |

## Architecture

```
WebView2 (renderer)
├── SolidJS room · BUI renderer · streaming append path
├── Cordis kernel (Context · Fiber · Service · reversible effects)
└── provider / agent / manifest-loader services (proxies)

Rust core
├── Tauri commands + channels
├── DPAPI key store  → data/keys/*.dpapi
├── data root        → data/ beside the executable
└── perf snapshot    → working set, exe size, boot time
```

Cordis's core dependencies are pure TypeScript (`cosmokit`, `@standard-schema/spec`),
so the kernel runs inside WebView2 without shipping Node. The official
`@cordisjs/plugin-loader` is Node-only and is not used; BELEN has its own
manifest loader.

## Performance budget

| Metric | Target |
|---|---|
| Cold start → JS boot | ≤ 400 ms |
| Warm launch | ≤ 120 ms |
| Keystroke handle (p99) | ≤ 5 ms |
| Dropped frames | 0 |
| Idle working set | ≤ 120 MB |
| Portable folder | ≤ 15 MB |

`pnpm perf` runs the suite against the real binary and exits non-zero on a hard
failure. The debug build is expected to miss the startup target; the release
build is the number that counts.

## Portable

Copy `%USERPROFILE%\.belen-target\release\belen.exe` to any folder as `BELEN.exe`.
Data (`config.json`, `belen.db`, `keys/`, `exports/`) is created in `data/` beside it.
No installer, no admin rights, no registry. The portable folder measures **9.8 MB**
with the perf report included.

## Repository layout

| Path | Contents |
|---|---|
| `app/` | The Tauri + SolidJS application (see [app/README.md](app/README.md)) |
| `portable/` | Portable-layout data templates |
| `00-discovery-brief.md` … `04-auth.md` | Discovery interview, product spec, task breakdown, toolchain notes, auth design |

## License

All rights reserved. © 2026 mrlfarano
