import { spawn } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

const exe =
  process.env.BELEN_EXE ||
  join(process.env.USERPROFILE, '.belen-target', 'release', 'belen.exe')
const report = resolve('data/summon.json')

// Target is 120 ms. The gate allows 150 ms because the second process's
// startup and single-instance IPC add ~20–40 ms of variance; a dedicated
// summon helper binary (Phase 2) can remove most of that.
const GATE_MS = 150

if (!existsSync(exe)) {
  console.error(`No build at ${exe}`)
  process.exit(1)
}

try {
  unlinkSync(report)
} catch {
  /* no previous report */
}

const env = { ...process.env, BELEN_DATA_DIR: resolve('data') }

// 1. First instance: starts the resident process and shows the window.
const first = spawn(exe, [], { stdio: 'ignore', env })
await new Promise((r) => setTimeout(r, 4000))

// 2. Second instance: detects the first, sends the summon, exits.
const t0 = Date.now()
spawn(exe, [`--summon-t0=${t0}`], { stdio: 'ignore', env })

const deadline = Date.now() + 10_000
const timer = setInterval(() => {
  if (existsSync(report)) {
    let latency
    try {
      latency = JSON.parse(readFileSync(report, 'utf8')).latencyMs
    } catch {
      return
    }
    clearInterval(timer)
    const pass = latency <= GATE_MS
    console.log(
      `resident summon: ${latency} ms  ${pass ? 'PASS' : 'FAIL'} (≤ ${GATE_MS} ms gate; target 120 ms)`,
    )
    first.kill()
    process.exit(pass ? 0 : 1)
  }

  if (Date.now() > deadline) {
    clearInterval(timer)
    first.kill()
    console.error('Timed out waiting for data/summon.json')
    process.exit(1)
  }
}, 50)
