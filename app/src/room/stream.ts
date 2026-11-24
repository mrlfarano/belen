export type Scheduler = (cb: () => void) => void

/**
 * Coalesces token deltas into one store write per animation frame.
 * Without this, a 100 tok/s stream causes 100 re-renders per second.
 */
export function createTokenBatcher(
  onFlush: (delta: string) => void,
  schedule: Scheduler = (cb) => requestAnimationFrame(cb),
) {
  let buffer = ''
  let scheduled = false

  const flush = () => {
    scheduled = false
    if (!buffer) return
    const delta = buffer
    buffer = ''
    onFlush(delta)
  }

  return {
    push(delta: string) {
      buffer += delta
      if (!scheduled) {
        scheduled = true
        schedule(flush)
      }
    },
    flush,
    get pending() {
      return buffer.length
    },
  }
}
