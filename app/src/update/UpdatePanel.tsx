import { createSignal, onMount, Show } from 'solid-js'
import { getVersion } from '@tauri-apps/api/app'
import { applyUpdate, checkForUpdates, progressLabel } from './update'
import type { ApplyProgress, CheckResult } from './update'

type Props = {
  onBeforeRestart: () => void
  autoCheck?: boolean
}

type Phase = 'idle' | 'checking' | 'available' | 'downloading' | 'restarting'

export default function UpdatePanel(props: Props) {
  const [result, setResult] = createSignal<CheckResult | null>(null)
  const [localVersion, setLocalVersion] = createSignal<string | null>(null)
  const [phase, setPhase] = createSignal<Phase>('idle')
  const [progress, setProgress] = createSignal<ApplyProgress | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [upToDate, setUpToDate] = createSignal(false)

  const busy = () => phase() === 'checking' || phase() === 'downloading'

  // The running exe's own version — shown even when the feed is unreachable.
  const currentVersion = () => result()?.current ?? localVersion() ?? null

  const statusLine = () => {
    switch (phase()) {
      case 'checking':
        return 'Checking…'
      case 'downloading':
        return progress() ? progressLabel(progress()!) : 'Downloading…'
      case 'restarting':
        return 'Restarting…'
      default:
        return null
    }
  }

  const runCheck = async () => {
    if (busy() || phase() === 'restarting') return
    setPhase('checking')
    setError(null)
    setUpToDate(false)
    try {
      const next = await checkForUpdates()
      setResult(next)
      setPhase(next.available ? 'available' : 'idle')
      if (!next.available) setUpToDate(true)
    } catch (e) {
      setPhase(result() && result()!.available ? 'available' : 'idle')
      setError(String(e))
    }
  }

  const runInstall = async () => {
    if (phase() !== 'available') return
    setError(null)
    setPhase('downloading')
    try {
      props.onBeforeRestart()
      const info = await applyUpdate((p) => setProgress(p))
      // The Rust side spawned the new exe and is exiting; this may or may not
      // land before the process goes away.
      setResult({ current: result()?.current ?? '', available: info })
      setPhase('restarting')
    } catch (e) {
      setPhase(result()?.available ? 'available' : 'idle')
      setError(String(e))
    }
  }

  onMount(async () => {
    setLocalVersion(await getVersion().catch(() => null))
    if (props.autoCheck) void runCheck()
  })

  return (
    <div class="skills-panel">
      <h1 class="lede">
        About
        <br />
        BELEN.
      </h1>
      <p class="body dim">
        Updates are checked when you ask — nothing downloads or runs on its own.
      </p>

      <p class="hint-line">Version {currentVersion() ?? '…'}</p>

      <div class="settings-row">
        <button
          class="block-action"
          onClick={() => void runCheck()}
          disabled={busy() || phase() === 'restarting'}
        >
          {phase() === 'checking' ? 'Checking…' : 'Check for updates'}
        </button>
        <Show when={statusLine()}>
          <span class="status-line">{statusLine()}</span>
        </Show>
        <Show when={upToDate()}>
          <span class="status-line">Up to date</span>
        </Show>
      </div>

      <Show when={phase() === 'available' && result()?.available}>
        <p class="notice-line">BELEN {result()!.available!.version} is available.</p>
        <Show when={result()!.available!.notes}>
          <p class="body dim">{result()!.available!.notes}</p>
        </Show>
        <div class="settings-row">
          <button class="primary-action" onClick={() => void runInstall()}>
            Update &amp; restart
          </button>
          <span class="hint-line">BELEN restarts itself when the download completes.</span>
        </div>
      </Show>

      <Show when={error()}>
        <p class="error-line">{error()}</p>
      </Show>

      <p class="hint-line">
        The portable exe is swapped in place; your data is untouched. If the folder is
        read-only, download the new build from the releases page instead.
      </p>
    </div>
  )
}
