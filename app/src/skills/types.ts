export type ManifestKind = 'skill' | 'plugin' | 'sub-agent'

export type Capability = 'chat' | 'provider' | 'files' | 'shell' | 'network'

export type Budget = {
  maxTurns: number
  maxTokens: number
  maxMs: number
}

export type Manifest = {
  id: string
  kind: ManifestKind
  name: string
  description: string
  version: string
  /** Capabilities the manifest needs. `chat` is granted by default; the rest are not. */
  capabilities: Capability[]
  /** Injected as the system prompt for skills and sub-agents. */
  instructions?: string
  /** Built-in handler id for plugins. */
  handler?: string
  /** Sub-agent limits. */
  budget?: Budget
}
