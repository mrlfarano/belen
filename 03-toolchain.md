# BELEN — Toolchain

v0.1 · 2026-11-23 · verified on this machine

---

## 1. Already installed (verified)

| Tool | Version | Role in BELEN |
|---|---|---|
| Windows 11 Pro | 10.0.26100 | OS and target |
| PowerShell | 5.1.26100 | Build scripts, environment setup |
| Node.js | 24.20.0 | Frontend build, Cordis runtime |
| npm | 11.19.0 | Package management |
| pnpm | 12.3.4 | Workspace package management |
| Rust | 1.98.1 (`x86_64-pc-windows-msvc`) | Tauri shell, SQLite, HTTP, DPAPI |
| Cargo | 1.98.1 | Rust build |
| Visual Studio Community 2026 | 18.10.2 | MSVC linker — **verified end-to-end** |
| Windows SDK | 10.0.26100.0 | Link libraries |
| WebView2 Runtime | 157.0.4341.60 | Rendering engine |
| Git | 2.55.0 | Version control |
| Python | 3.13.15 | Optional tooling only |
| winget | 1.29.380 | Fallback installer if ever needed |

**Verification performed:** a Rust binary was compiled and executed through `VsDevCmd.bat -arch=x64 -host_arch=x64` → `link-ok`.

---

## 2. To add — project-local, no admin rights

### Node side
- `@tauri-apps/cli` (devDependency) — Tauri CLI
- `@tauri-apps/api` — IPC and channels
- `solid-js` — fine-grained UI runtime (no VDOM; keeps streaming cheap)
- `vite`, `typescript`, `vitest`
- `zod` — BUI and manifest validation
- `@deepseek-ai/cordis` **4.1.0** — the Cordis kernel. Note: the unscoped `cordis` package is at `4.0.0-rc.13`; the stable 4.1.0 release is under the DeepSeek scope.

### Rust side
- `tauri`, `tauri-build`, plus the Tauri 2 plugin crates
- `tauri-plugin-single-instance` — resident summon
- `reqwest`, `tokio`, `futures-util` — HTTP and SSE
- `rusqlite` (bundled) — SQLite with FTS5 (Phase 5)
- `serde`, `serde_json`, `thiserror`, `anyhow`
- `windows` crate — DPAPI (`CryptProtectData`)

### Fonts
- OFL variable fonts, subset and preloaded (e.g. an editorial serif + a text sans + a mono for code)

---

## 3. Deliberately not used

| Rejected | Why |
|---|---|
| Electron | Forbidden by the guardrails; also blows the 400 ms / 120 MB / 15 MB budget |
| A bundled Node runtime inside the app | Adds ~50–80 MB and startup latency; Cordis core runs in WebView2 instead |
| .NET SDK | Not needed; only the runtime is present |
| Python at runtime | Tooling only |
| Tauri's Node-side loader (`@cordisjs/plugin-loader`) | Node-only; would force a sidecar. BELEN ships a first-party manifest loader |

---

## 4. Architecture placement

```
┌──────────────────────────── WebView2 (renderer) ────────────────────────────┐
│  SolidJS room · BUI renderer · streaming append path                        │
│  Cordis kernel (Context tree · Fibers · Services · reversible effects)      │
│  Manifest loader service · provider service (proxy) · agent service         │
└───────────────────────────────▲─────────────────────────────────────────────┘
                                │ Tauri commands (request/response)
                                │ Tauri channels (streaming tokens)
┌───────────────────────────────┴─────────────────────────────────────────────┐
│  Rust core: HTTP/SSE · SQLite + FTS5 · DPAPI keys · FS · process             │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Why this split**

- Cordis's core dependencies are pure (`cosmokit`, `@standard-schema/spec`) — it runs in the webview.
- Rust owns every capability that needs the OS: network without CORS, secrets, disk.
- Streaming never does one IPC per token; tokens are batched per animation frame.

---

## 5. Build and run

```powershell
pnpm install

powershell -ExecutionPolicy Bypass -File scripts/build.ps1            # debug
powershell -ExecutionPolicy Bypass -File scripts/build.ps1 -Release    # release
powershell -ExecutionPolicy Bypass -File scripts/build.ps1 -TauriBuild # portable, no installer
powershell -ExecutionPolicy Bypass -File scripts/build.ps1 -Test       # Rust unit tests

pnpm perf                       # launches the real binary in --perf mode
pnpm summon                     # measures resident summon latency
pnpm mock                       # local OpenAI-compatible mock on :8787
pnpm probe                      # end-to-end provider probe against the mock
```

`scripts/build.ps1` wraps `VsDevCmd.bat` so `link.exe` is on PATH, and applies two
machine-specific overrides. Always build through it.

### Trap 1 — a global Cargo config from another project

`C:\Users\me\.cargo\config.toml` belongs to a different project. It forces `rust-lld`
and injects `-C link-arg=C:/Users/me/dev/Screenshotter/src-tauri/app.res` into every
MSVC link, which duplicates Tauri's generated manifest and fails with:

```
error: duplicate resource: type MANIFEST (ID 24)/name ID 1/language 1033
```

The build script overrides it for this project only (`RUSTFLAGS` +
`CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER=link.exe`) and leaves the user's global
config untouched.

### Trap 2 — MAX_PATH

The repo lives under a long account path. Cargo's default target dir pushes linker
outputs to exactly 260 characters, and `link.exe` fails with `LNK1104: cannot open
file ...build_script_build....exe`. The build script redirects the target to
`%USERPROFILE%\.belen-target`.

### Artifacts

- Debug: `%USERPROFILE%\.belen-target\debug\belen.exe`
- Release: `%USERPROFILE%\.belen-target\release\belen.exe`
- Portable build: `pnpm tauri build --no-bundle` → `src-tauri/target/release/belen.exe`
  (override `CARGO_TARGET_DIR` to keep it short)
- Perf report: `BELEN/app/data/perf.json`

`link.exe` and `cl.exe` are **not** on PATH in a normal shell; they live under
`C:\Program Files\Microsoft Visual Studio\18\Community\VC\Tools\MSVC\14.51.36231\bin\Hostx64\x64\`.

---

## 6. What I need from you

**Nothing installed.** Everything required is already on this machine or installs project-locally with `pnpm` / `cargo` (network access only).

The single environment step is running Rust builds through `VsDevCmd` — which is already verified.
