param(
  [switch]$Release,
  [switch]$TauriBuild,
  [switch]$Dev,
  [switch]$Test
)

$ErrorActionPreference = 'Stop'

$appRoot = Split-Path -Parent $PSScriptRoot
$vsDevCmd = 'C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat'

if (-not (Test-Path $vsDevCmd)) {
  throw "VsDevCmd.bat not found at $vsDevCmd"
}

# The machine-global ~/.cargo/config.toml belongs to another project. It forces
# rust-lld and injects a foreign app.res into every MSVC link, which collides with
# Tauri's generated manifest. Override it for this build only.
$env:RUSTFLAGS = '-C target-feature=+crt-static'
$env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = 'link.exe'

# The repo lives under a very long account path; Cargo's default target dir
# pushes linker outputs past Windows' 260-character MAX_PATH (LNK1104).
$env:CARGO_TARGET_DIR = Join-Path $env:USERPROFILE '.belen-target'

Set-Location $appRoot

$cmd = 'call "' + $vsDevCmd + '" -arch=x64 -host_arch=x64 >nul 2>&1'

if ($Dev) {
  $cmd += ' && pnpm tauri dev'
} elseif ($TauriBuild) {
  $cmd += ' && pnpm tauri build --no-bundle'
} elseif ($Test) {
  $cmd += ' && cargo test --manifest-path src-tauri/Cargo.toml'
} elseif ($Release) {
  $cmd += ' && cargo build --release --manifest-path src-tauri/Cargo.toml'
} else {
  $cmd += ' && cargo build --manifest-path src-tauri/Cargo.toml'
}

cmd.exe /c $cmd
exit $LASTEXITCODE
