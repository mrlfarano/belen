import type { AppConfig, AskBefore, ChatWidth, SearchBackend, ToolsConfig } from './types'

/**
 * Returns `base` with `patch` applied, preserving every unrelated section
 * (provider, skills, grants, chat, workspace). Settings surfaces call this
 * before config_set so saving one section never wipes the others.
 */
export function mergeConfig(base: AppConfig | null, patch: AppConfig): AppConfig {
  return { ...(base ?? {}), ...patch }
}

export const CHAT_WIDTHS: Array<{ id: ChatWidth; label: string }> = [
  { id: 'narrow', label: 'Narrow' },
  { id: 'default', label: 'Default' },
  { id: 'wide', label: 'Wide' },
  { id: 'full', label: 'Full' },
]

export const widthOf = (config: AppConfig | null | undefined): ChatWidth =>
  config?.chat?.width ?? 'default'

/** The width setting as stored: 'default' stays explicit so Reset is a real action. */
export function withChatWidth(config: AppConfig | null, width: ChatWidth): AppConfig {
  return mergeConfig(config, { chat: { ...(config?.chat ?? {}), width } })
}

export function withWorkspace(config: AppConfig | null, workspace: string): AppConfig {
  const trimmed = workspace.trim()
  return mergeConfig(config, { workspace: trimmed || undefined })
}

export type Tools = Required<ToolsConfig>

const ASK_BEFORE: AskBefore[] = ['changes', 'commands', 'never']
const SEARCH_BACKENDS: SearchBackend[] = ['tavily']

/** The "Ask before" choices, in the order Settings shows them. */
export const ASK_BEFORE_OPTIONS: Array<{ id: AskBefore; label: string }> = [
  { id: 'changes', label: 'Commands and file changes' },
  { id: 'commands', label: 'Commands only' },
  { id: 'never', label: 'Never' },
]

/**
 * The tool switches with every default filled in. Mirrors the broker's
 * `Policy` (tools.rs): a value that is not exactly the schema counts as off,
 * so a hand-edited config never shows the model a tool the broker refuses.
 */
export function toolsOf(config: AppConfig | null | undefined): Tools {
  const tools = config?.tools
  return {
    network: tools?.network === true,
    files: tools?.files === 'write' ? 'write' : 'read',
    shell: tools?.shell === true,
    askBefore: isOneOf(ASK_BEFORE, tools?.askBefore, 'changes'),
    search: isOneOf(SEARCH_BACKENDS, tools?.search, 'tavily'),
  }
}

export function withTools(
  config: AppConfig | null | undefined,
  patch: Partial<ToolsConfig>,
): AppConfig {
  return mergeConfig(config ?? null, { tools: { ...(config?.tools ?? {}), ...patch } })
}

const isOneOf = <T extends string>(allowed: T[], value: T | undefined, fallback: T): T =>
  value !== undefined && allowed.includes(value) ? value : fallback
