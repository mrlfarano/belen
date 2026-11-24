import { invoke } from '@tauri-apps/api/core'

export type RustSnapshot = {
  bootMs: number
  setupMs: number
  workingSetBytes: number
  exeBytes: number
}

export type PerfReport = {
  startupMs: number
  setupMs: number
  navToModuleMs: number
  navToPaintMs: number
  keystrokeP99Ms: number
  keystrokeMaxMs: number
  keystrokeFrameP99Ms: number
  keystrokeFrameMaxMs: number
  medianFrameMs: number
  droppedFrames: number
  frames: number
  maxFrameMs: number
  longTasks: number
  longTaskTotalMs: number
  workingSetBytes: number
  exeBytes: number
  visibility: string
  hasFocus: boolean
  dpr: number
  viewportWidth: number
  viewportHeight: number
  streamTokens: number
  streamDroppedFrames: number
  streamFrames: number
  collectedAt: string
  budget: Record<string, { target: number; unit: string; pass: boolean }>
}

/** A frame is "dropped" when it takes 1.5× the display's median frame time. */
const REFRESH_TOLERANCE = 1.5

const BUDGET = {
  startupMs: { target: 1000, unit: 'ms' },
  keystrokeP99Ms: { target: 5, unit: 'ms' },
  droppedFrames: { target: 0, unit: 'frames' },
  workingSetBytes: { target: 120 * 1024 * 1024, unit: 'bytes' },
  exeBytes: { target: 15 * 1024 * 1024, unit: 'bytes' },
} as const

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))

async function rustSnapshot(): Promise<RustSnapshot> {
  try {
    return await invoke<RustSnapshot>('perf_report')
  } catch {
    return { bootMs: 0, setupMs: 0, workingSetBytes: 0, exeBytes: 0 }
  }
}

export async function keystrokeProbe(samples = 120) {
  const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    'input, textarea',
  )
  if (!el) return { p99: 0, max: 0, frameP99: 0, frameMax: 0 }

  el.focus()
  const handle: number[] = []
  const frame: number[] = []

  for (let i = 0; i < samples; i++) {
    const t0 = performance.now()
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    el.value = 'a'.repeat((i % 12) + 1)
    el.dispatchEvent(
      new InputEvent('input', { data: 'a', inputType: 'insertText', bubbles: true }),
    )
    // Force style + layout so the sample is BELEN's work, not the display's
    // refresh interval (which is reported separately as frameP99).
    void el.offsetHeight
    handle.push(performance.now() - t0)

    await nextFrame()
    frame.push(performance.now() - t0)
  }

  handle.sort((a, b) => a - b)
  frame.sort((a, b) => a - b)

  return {
    p99: round(handle[Math.min(handle.length - 1, Math.floor(handle.length * 0.99))]),
    max: round(handle[handle.length - 1]),
    frameP99: round(frame[Math.min(frame.length - 1, Math.floor(frame.length * 0.99))]),
    frameMax: round(frame[frame.length - 1]),
  }
}

export function frameMonitor(frames = 180) {
  return new Promise<{
    frames: number
    dropped: number
    medianFrameMs: number
    maxFrameMs: number
  }>((resolve) => {
    const deltas: number[] = []
    let last = performance.now()
    let i = 0

    // The first frames include window focus and compositor warm-up; the budget
    // governs steady-state streaming, so they are excluded from the sample.
    const WARMUP_FRAMES = 10

    const tick = (now: number) => {
      const delta = now - last
      last = now
      if (i > WARMUP_FRAMES) deltas.push(delta)
      i += 1

      if (i < frames) {
        requestAnimationFrame(tick)
        return
      }

      const sorted = [...deltas].sort((a, b) => a - b)
      const median = sorted[Math.floor(sorted.length / 2)] ?? 16.7
      const dropped = deltas.filter((d) => d > median * REFRESH_TOLERANCE).length
      resolve({
        frames,
        dropped,
        medianFrameMs: round(median),
        maxFrameMs: round(sorted[sorted.length - 1] ?? 0),
      })
    }

    requestAnimationFrame(tick)
  })
}

export function longTaskMonitor(durationMs = 600) {
  return new Promise<{ longTasks: number; longTaskTotalMs: number }>((resolve) => {
    let count = 0
    let total = 0
    let observer: PerformanceObserver | undefined

    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          count += 1
          total += entry.duration
        }
      })
      observer.observe({ type: 'longtask', buffered: true })
    } catch {
      /* not supported */
    }

    setTimeout(() => {
      observer?.disconnect()
      resolve({ longTasks: count, longTaskTotalMs: Math.round(total) })
    }, durationMs)
  })
}

/**
 * Streams tokens into the real room's active block through the frame-batched
 * sink while a frame monitor counts dropped frames.
 */
export async function streamProbe(tokens = 2000) {
  const target = (
    window as unknown as {
      __belen?: {
        push: (delta: string) => void
        append: (kind: string, text?: string) => string
        setActive: (id: string | null) => void
      }
    }
  ).__belen

  if (!target) return { tokens: 0, dropped: 0, frames: 0, medianFrameMs: 0, maxFrameMs: 0 }

  const id = target.append('assistant', '')
  target.setActive(id)

  const monitor = frameMonitor(240)
  for (let i = 0; i < tokens; i++) {
    target.push('word ')
    if (i % 6 === 0) await nextFrame()
  }
  const frames = await monitor

  target.setActive(null)
  return { tokens, ...frames }
}

export async function runPerfSuite(): Promise<PerfReport> {
  // Let the window settle and try to take focus: an occluded WebView2 throttles
  // rAF, which would make the frame numbers measure the window state, not BELEN.
  await new Promise((resolve) => setTimeout(resolve, 300))
  window.focus()

  const rust = await rustSnapshot()
  const keys = await keystrokeProbe(120)
  const stream = await streamProbe(2000)
  const frames = await frameMonitor(180)
  const long = await longTaskMonitor(600)

  const report = {
    startupMs: round(rust.bootMs),
    setupMs: round(rust.setupMs),
    navToModuleMs: round(
      (window as unknown as { __belenNavToModule?: number }).__belenNavToModule ?? 0,
    ),
    navToPaintMs: round(
      (window as unknown as { __belenNavToPaint?: number }).__belenNavToPaint ?? 0,
    ),
    keystrokeP99Ms: keys.p99,
    keystrokeMaxMs: keys.max,
    keystrokeFrameP99Ms: keys.frameP99,
    keystrokeFrameMaxMs: keys.frameMax,
    medianFrameMs: frames.medianFrameMs,
    droppedFrames: frames.dropped,
    frames: frames.frames,
    maxFrameMs: frames.maxFrameMs,
    longTasks: long.longTasks,
    longTaskTotalMs: long.longTaskTotalMs,
    workingSetBytes: rust.workingSetBytes,
    exeBytes: rust.exeBytes,
    visibility: document.visibilityState,
    hasFocus: document.hasFocus(),
    dpr: devicePixelRatio,
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
    streamTokens: stream.tokens,
    streamDroppedFrames: stream.dropped,
    streamFrames: stream.frames,
    collectedAt: new Date().toISOString(),
  }

  const budget: PerfReport['budget'] = {}
  for (const [key, spec] of Object.entries(BUDGET)) {
    const value = report[key as keyof typeof report] as number
    budget[key] = { target: spec.target, unit: spec.unit, pass: value <= spec.target }
  }

  return { ...report, budget }
}
