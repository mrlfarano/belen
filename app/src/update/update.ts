import { Channel, invoke } from '@tauri-apps/api/core'

export type UpdateInfo = {
  version: string
  notes: string | null
  url: string
}

export type CheckResult = {
  current: string
  available: UpdateInfo | null
}

export type ApplyProgress = {
  received: number
  total: number | null
}

export function checkForUpdates(): Promise<CheckResult> {
  return invoke<CheckResult>('update_check')
}

export function applyUpdate(onProgress: (p: ApplyProgress) => void): Promise<UpdateInfo> {
  const channel = new Channel<ApplyProgress>()
  channel.onmessage = onProgress
  return invoke('update_apply', { onProgress: channel })
}

export function lastAppliedUpdate(): Promise<string | null> {
  return invoke<string | null>('update_last')
}

const MB = 1024 * 1024

export function progressLabel(p: ApplyProgress): string {
  if (p.total && p.total > 0) {
    const pct = Math.min(100, Math.round((p.received / p.total) * 100))
    return `Downloading ${pct}%`
  }
  return `Downloading ${(p.received / MB).toFixed(1)} MB`
}
