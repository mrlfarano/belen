import { describe, expect, it } from 'vitest'
import { createRoomStore } from './store'
import type { BuiPayload } from '../bui/schema'

describe('room store', () => {
  it('appends 10,000 blocks in one transaction under 50 ms', () => {
    const store = createRoomStore()
    const blocks = Array.from({ length: 10_000 }, (_, i) => ({
      kind: 'text' as const,
      text: `block ${i}`,
    }))

    const t0 = performance.now()
    store.appendMany(blocks)
    const ms = performance.now() - t0

    expect(store.room.order.length).toBe(10_000)
    expect(ms).toBeLessThan(50)
  })

  it('appends text to a block without touching the others', () => {
    const store = createRoomStore()
    const a = store.append('assistant', 'Hello')
    const b = store.append('assistant', 'Other')

    store.appendText(a, ' world')

    expect(store.room.byId[a].text).toBe('Hello world')
    expect(store.room.byId[b].text).toBe('Other')
  })

  it('pins and unpins a block', () => {
    const store = createRoomStore()
    const id = store.append('assistant', 'text')

    store.togglePin(id)
    expect(store.room.byId[id].pinned).toBe(true)

    store.togglePin(id)
    expect(store.room.byId[id].pinned).toBe(false)
  })

  it('forks a block into a new assistant block', () => {
    const store = createRoomStore()
    const id = store.append('assistant', 'original')

    const forked = store.fork(id)

    expect(forked).not.toBeNull()
    expect(store.room.byId[forked!].forkOf).toBe(id)
    expect(store.room.byId[forked!].text).toBe('original')
  })

  it('forks a component payload without losing it', () => {
    const store = createRoomStore()
    const payload: BuiPayload = { v: 1, blocks: [{ type: 'text', text: 'x' }] }
    const id = store.append('artifact', '', { component: payload })

    const forked = store.fork(id)!

    expect(store.room.byId[forked].kind).toBe('artifact')
    expect(store.room.byId[forked].component).toEqual(payload)
  })

  it('round-trips a room through JSON byte-identically', () => {
    const a = createRoomStore()
    a.append('user', 'hello')
    a.append('assistant', 'world')
    a.append('artifact', '', {
      component: { v: 1, blocks: [{ type: 'text', text: 'x' }] },
    })

    const json = JSON.stringify(a.snapshot())
    const b = createRoomStore()
    b.hydrate(JSON.parse(json))

    expect(JSON.stringify(b.snapshot())).toBe(json)
  })

  it('removes a block and clears the active id', () => {
    const store = createRoomStore()
    const id = store.append('assistant', 'bye')
    store.setActive(id)

    store.remove(id)

    expect(store.room.order).toHaveLength(0)
    expect(store.room.byId[id]).toBeUndefined()
    expect(store.room.activeId).toBeNull()
  })
})
