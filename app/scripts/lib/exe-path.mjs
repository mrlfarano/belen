// Shared default-binary lookup for the harness scripts (perf, summon, probe,
// live). BELEN_EXE overrides on every platform. Windows keeps the exact
// derivations the scripts had before this helper existed — MAYA builds through
// build.ps1, which sets CARGO_TARGET_DIR to %USERPROFILE%\.belen-target.
// macOS falls back to the local cargo output under src-tauri/target/, resolved
// relative to app/ so the scripts behave the same from the repo root
// (pnpm --dir app) as from app/.

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const isMac = process.platform === 'darwin'

const macExe = (flavor) => join(appRoot, 'src-tauri', 'target', flavor, 'belen')

// The binary perf measures. Windows: the debug build, preferring MAYA's short
// path, exactly as before. macOS: release only — the perf gates (1.5 s start,
// 15 MB executable) are calibrated for a release build, so never silently
// measure a debug binary.
export function resolvePerfExe() {
  if (process.env.BELEN_EXE) return process.env.BELEN_EXE

  if (process.platform === 'win32') {
    const short = process.env.USERPROFILE
      ? join(process.env.USERPROFILE, '.belen-target', 'debug', 'belen.exe')
      : null
    const local = join(appRoot, 'src-tauri', 'target', 'debug', 'belen.exe')
    return short && existsSync(short) ? short : local
  }
  return macExe('release')
}

// The binary summon / probe / live poke. Windows: MAYA's release short path,
// exactly as before. macOS: the release build if it exists, else the debug
// build, else the release path (for the scripts' "No build at" message).
export function resolveBelenExe() {
  if (process.env.BELEN_EXE) return process.env.BELEN_EXE

  if (process.platform === 'win32') {
    return join(process.env.USERPROFILE, '.belen-target', 'release', 'belen.exe')
  }
  const release = macExe('release')
  const debug = macExe('debug')
  return isMac && !existsSync(release) && existsSync(debug) ? debug : release
}

// Where to point the user when the binary is missing. Windows builds through
// build.ps1; macOS is a plain Tauri build.
export const buildHint = isMac
  ? 'Run: pnpm tauri build --no-bundle'
  : 'Run: pnpm build && powershell -File scripts/build.ps1 -Release'
