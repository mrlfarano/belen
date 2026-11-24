import { createStore, produce } from 'solid-js/store'
import type { Block, BlockKind, RoomState } from './types'

let seq = 0
const nextId = () => `b${++seq}`

export function createRoomStore(initial?: Partial<Pick<RoomState, 'id' | 'title'>>) {
  const [room, setRoom] = createStore<RoomState>({
    id: initial?.id ?? 'room-1',
    title: initial?.title ?? 'Room 01',
    order: [],
    byId: {},
    activeId: null,
  })

  const append = (kind: BlockKind, text = '', extra: Partial<Block> = {}) => {
    const id = nextId()
    setRoom(
      produce((r) => {
        r.order.push(id)
        r.byId[id] = { id, kind, text, createdAt: performance.now(), ...extra }
      }),
    )
    return id
  }

  /** Bulk append — one store transaction for N blocks. */
  const appendMany = (blocks: Array<{ kind: BlockKind; text?: string; extra?: Partial<Block> }>) => {
    const ids: string[] = []
    setRoom(
      produce((r) => {
        for (const b of blocks) {
          const id = nextId()
          ids.push(id)
          r.order.push(id)
          r.byId[id] = { id, kind: b.kind, text: b.text ?? '', createdAt: performance.now(), ...b.extra }
        }
      }),
    )
    return ids
  }

  const appendText = (id: string, delta: string) => {
    setRoom('byId', id, 'text', (t) => (t ?? '') + delta)
  }

  const setText = (id: string, text: string) => setRoom('byId', id, 'text', text)

  const setMeta = (id: string, key: string, value: string) =>
    setRoom('byId', id, 'meta', key, value)

  const appendOutput = (id: string, delta: string) =>
    setRoom('byId', id, 'meta', 'output', (output) => (output ?? '') + delta)

  const setActive = (id: string | null) => setRoom('activeId', id)

  const togglePin = (id: string) => setRoom('byId', id, 'pinned', (p) => !p)

  const fork = (id: string) => {
    const source = room.byId[id]
    if (!source) return null
    return append(source.kind, source.text ?? '', {
      forkOf: id,
      component: source.component,
    })
  }

  const remove = (id: string) =>
    setRoom(
      produce((r) => {
        const i = r.order.indexOf(id)
        if (i >= 0) r.order.splice(i, 1)
        delete r.byId[id]
        if (r.activeId === id) r.activeId = null
      }),
    )

  const clear = () =>
    setRoom(
      produce((r) => {
        r.order = []
        r.byId = {}
        r.activeId = null
      }),
    )

  const hydrate = (state: {
    id?: string
    title?: string
    order: string[]
    byId: Record<string, Block>
  }) =>
    setRoom(
      produce((r) => {
        if (state.id) r.id = state.id
        if (state.title) r.title = state.title
        r.order = state.order.filter((id) => !!state.byId[id])
        r.byId = state.byId
        r.activeId = null
      }),
    )

  const snapshot = () => ({
    id: room.id,
    title: room.title,
    order: [...room.order],
    byId: { ...room.byId },
  })

  return {
    room,
    append,
    appendMany,
    appendText,
    setText,
    setMeta,
    appendOutput,
    setActive,
    togglePin,
    fork,
    remove,
    clear,
    hydrate,
    snapshot,
  }
}

export type RoomStore = ReturnType<typeof createRoomStore>
