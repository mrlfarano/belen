#!/bin/zsh
# Builds BELEN on HAMMER. Every build happens here.
#
#   on HAMMER:    zsh -lc 'zsh app/scripts/build-hammer.sh'
#   from illaoi:  ssh la@hammer 'zsh -lc "cd ~/dev/belen && git pull --ff-only && zsh app/scripts/build-hammer.sh"'
#
# .github/workflows/build.yml runs it on HAMMER's self-hosted runner for every
# push to main, which is what a merged PR is.
#
# `macos` or `windows` as the first argument builds that platform only.
#
# It builds the checkout the script lives in, wherever that is (the dev
# checkout, or the runner's own), runs the frontend gates and the Rust tests,
# and leaves the binaries in ~/builds/belen/: `BELEN` (Apple Silicon, macOS
# 11+) and `BELEN.exe` (Windows x64). The last line it prints is
# `HAMMER_BUILD_OK`.
#
# macOS follows what the hosted workflow used to do, step for step. Windows is
# cross-compiled: `pnpm tauri build --no-bundle --target x86_64-pc-windows-msvc`
# would call
#     cargo build --bins --features tauri/custom-protocol --release --target …
# (captured once with a logging cargo shim); here that call goes through
# cargo-xwin, which supplies clang-cl, lld-link and the Windows SDK.
#
# Needs on HAMMER: `brew install llvm lld`, `rustup target add
# x86_64-pc-windows-msvc`, and cargo-xwin. Node and pnpm come from the login
# shell, which is why every call above goes through `zsh -lc`.

set -euo pipefail

script=${(%):-%x}
app=$(cd "$(dirname "$script")/.." && pwd)
repo=$(cd "$app/.." && pwd)
want="${1:-all}"
target="${CARGO_TARGET_DIR:-$app/src-tauri/target}"

cd "$app"
echo "building $(git rev-parse --short HEAD) on $(hostname -s)"

export MACOSX_DEPLOYMENT_TARGET=11.0
mkdir -p ~/builds/belen

echo "== pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile 2>&1 | tail -2

if [ "$want" = all ] || [ "$want" = macos ]; then
  echo "== macOS: frontend gates"
  pnpm typecheck
  pnpm test 2>&1 | tail -5
  echo "== macOS: cargo test --locked"
  # Every test runs where the login Keychain can be reached. Where it answers
  # "User interaction is not allowed" — over SSH, and on the runner — the two
  # tests that write to it are skipped by name, and the log says so. Any
  # other failure fails the build.
  rc=0
  out=$(cargo test --locked --manifest-path src-tauri/Cargo.toml 2>&1) || rc=$?
  if [ "$rc" -ne 0 ] && print -r -- "$out" | grep -q "User interaction is not allowed"; then
    echo "(no Keychain access here: the two Keychain tests are skipped — $(print -r -- "$out" | grep -m1 "User interaction is not allowed"))"
    rc=0
    out=$(cargo test --locked --manifest-path src-tauri/Cargo.toml \
      -- --skip keychain_roundtrip --skip keychain_names_normalize 2>&1) || rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    print -r -- "$out" | grep -E "FAILED|panicked|^error"
    exit "$rc"
  fi
  print -r -- "$out" | grep -E "test result: ok\. [0-9]+ passed"
  echo "== macOS: pnpm tauri build --no-bundle"
  pnpm tauri build --no-bundle 2>&1 | tail -3
  cp "$target/release/belen" ~/builds/belen/BELEN
  chmod +x ~/builds/belen/BELEN
fi

if [ "$want" = all ] || [ "$want" = windows ]; then
  echo "== windows: pnpm build"
  pnpm build 2>&1 | tail -3
  echo "== windows: cargo xwin build"
  export PATH="/opt/homebrew/opt/llvm/bin:/opt/homebrew/opt/lld/bin:$PATH"
  export XWIN_ACCEPT_LICENSE=1
  # Not `-C target-feature=+crt-static`, although scripts/build.ps1 sets it on
  # MAYA, where link.exe is used. Tauri already links the Visual C++ runtime
  # statically (the `static_vcruntime` crate: libcmt + libvcruntime, Universal
  # CRT from Windows), so the exe needs no redistributable either way — and
  # rustc's own crt-static directives collide with that crate's under
  # lld-link, leaving the C runtime out entirely. Under link.exe they coexist.
  unset RUSTFLAGS
  cargo xwin build --manifest-path src-tauri/Cargo.toml \
    --bins --features tauri/custom-protocol --release \
    --target x86_64-pc-windows-msvc 2>&1 | tail -12
  cp "$target/x86_64-pc-windows-msvc/release/belen.exe" ~/builds/belen/BELEN.exe
fi

# pnpm rewrites the lockfile on this machine; that is not a change to keep.
git -C "$repo" checkout -- app/pnpm-lock.yaml 2>/dev/null || true
echo "== ~/builds/belen"
ls -l ~/builds/belen/BELEN ~/builds/belen/BELEN.exe 2>/dev/null
shasum -a 256 ~/builds/belen/BELEN ~/builds/belen/BELEN.exe 2>/dev/null
echo "BELEN $(node -p "require('./src-tauri/tauri.conf.json').version") built on $(hostname -s)."
echo "HAMMER_BUILD_OK"
