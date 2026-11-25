import type { AppConfig, ChatWidth } from './types'

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
