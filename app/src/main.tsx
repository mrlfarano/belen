import { render } from 'solid-js/web'
import { invoke } from '@tauri-apps/api/core'
import App from './App'
import { runPerfSuite } from './perf'
import './styles/tokens.css'
import './styles/base.css'
import './styles/room.css'

const root = document.getElementById('root')!

// Navigation-relative phase marks (performance.now() is relative to navigation start).
;(window as unknown as { __belenNavToModule: number }).__belenNavToModule = performance.now()

// Mark JS boot as early as possible; `--perf` reads this as the startup number.
void invoke('perf_mark_boot').catch(() => {})

render(() => <App />, root)

requestAnimationFrame(() => {
  ;(window as unknown as { __belenNavToPaint: number }).__belenNavToPaint = performance.now()
})

/**
 * `--perf` launches the real binary in measurement mode:
 * run the suite, write data/perf.json, exit non-zero on breach.
 */
async function maybePerfMode() {
  try {
    const on = await invoke<boolean>('perf_mode')
    if (!on) return
    const report = await runPerfSuite()
    await invoke('perf_write', { report })
    await invoke('exit_app')
  } catch {
    /* not running under Tauri (Vite dev) */
  }
}

void maybePerfMode()

async function maybeProbeMode() {
  try {
    if (!(await invoke<boolean>('probe_mode'))) return
    const { runProbe } = await import('./providers/probe')
    await runProbe()
  } catch (e) {
    console.error(e)
  }
}

void maybeProbeMode()
