import type { BuiPayload } from '../bui/schema'

export type BlockKind =
  | 'user'
  | 'assistant'
  | 'text'
  | 'tool'
  | 'artifact'
  | 'worker'
  | 'system'

/** A declarative component payload proposed by the model and rendered by BELEN. */
export type BuiComponent = BuiPayload

export type Block = {
  id: string
  kind: BlockKind
  text?: string
  createdAt: number
  pinned?: boolean
  forkOf?: string | null
  component?: BuiPayload
  meta?: Record<string, string>
}

export type RoomState = {
  id: string
  title: string
  /** Block ids in document order. */
  order: string[]
  /** Id → block, so token appends are O(1) regardless of room length. */
  byId: Record<string, Block>
  activeId: string | null
}
