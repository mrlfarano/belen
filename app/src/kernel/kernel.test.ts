import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { KernelService } from './index'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'probe/ping': () => void
  }
}

describe('BELEN kernel', () => {
  it('boots a Cordis service and exposes it on the context', async () => {
    const root = new Context()
    const fiber = root.plugin(KernelService)
    await fiber.await()

    expect(root.kernel).toBeInstanceOf(KernelService)
    expect(root.kernel.status().uptimeMs).toBeGreaterThanOrEqual(0)
  })

  it('disposes a plugin and runs every reversible effect exactly once', async () => {
    let cleanups = 0
    const probe = (ctx: Context) => {
      ctx.effect(() => {
        const timer = setInterval(() => {}, 1_000)
        return () => {
          clearInterval(timer)
          cleanups += 1
        }
      })
    }

    const root = new Context()
    const fiber = root.plugin(probe)
    await fiber.await()
    await fiber.dispose()

    expect(cleanups).toBe(1)
  })

  it('removes event listeners with the owning fiber', async () => {
    let hits = 0
    const root = new Context()
    const fiber = root.plugin((ctx: Context) => {
      ctx.on('probe/ping', () => {
        hits += 1
      })
    })
    await fiber.await()

    root.emit('probe/ping')
    expect(hits).toBe(1)

    await fiber.dispose()
    root.emit('probe/ping')
    expect(hits).toBe(1)
  })
})
