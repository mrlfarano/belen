import { describe, expect, it } from 'vitest'
import { createTokenBatcher } from './stream'

describe('token batcher', () => {
  it('coalesces 2,000 tokens into a single flush', () => {
    const queue: Array<() => void> = []
    const flushes: string[] = []
    const batcher = createTokenBatcher((d) => flushes.push(d), (cb) => queue.push(cb))

    for (let i = 0; i < 2_000; i++) batcher.push('x')

    expect(queue).toHaveLength(1)
    queue.shift()!()

    expect(flushes).toHaveLength(1)
    expect(flushes[0]).toBe('x'.repeat(2_000))
    expect(batcher.pending).toBe(0)
  })

  it('schedules once per drain, not once per token', () => {
    const queue: Array<() => void> = []
    let flushes = 0
    const batcher = createTokenBatcher(() => (flushes += 1), (cb) => queue.push(cb))

    batcher.push('a')
    batcher.push('b')
    expect(queue).toHaveLength(1)
    queue.shift()!()

    batcher.push('c')
    expect(queue).toHaveLength(1)
    queue.shift()!()

    expect(flushes).toBe(2)
  })

  it('does not flush an empty buffer', () => {
    let flushes = 0
    const batcher = createTokenBatcher(() => (flushes += 1), () => {})
    batcher.flush()
    expect(flushes).toBe(0)
  })
})
