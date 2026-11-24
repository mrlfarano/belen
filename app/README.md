# BELEN

**The interface is the conversation.** A native Windows room where the model's answer can become the tool you need.

This is the app workspace. Product context lives one level up in [../01-spec.md](../01-spec.md).

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

## Machine-specific notes

The build wrapper exists because this machine has two traps: a global Cargo
config from another project that injects a foreign `app.res`, and a repository
path long enough to hit Windows' 260-character `MAX_PATH` in Cargo's default
target directory. Both are handled in `scripts/build.ps1`; details in
[../03-toolchain.md](../03-toolchain.md).
