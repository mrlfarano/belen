import { Channel, invoke } from '@tauri-apps/api/core'
import type {
  AppConfig,
  ChatMessage,
  ModelInfo,
  ProviderSpec,
  StreamEvent,
  TestResult,
} from './types'
import type { ToolSchema } from './tools'

export function discover(spec: ProviderSpec): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>('provider_discover', { spec })
}

export function testProvider(spec: ProviderSpec, model: string): Promise<TestResult> {
  return invoke<TestResult>('provider_test', { spec, model })
}

/**
 * Streams one assistant turn. `tools` attaches the workspace tool schemas;
 * `streamId` lets provider_cancel abort the HTTP stream mid-flight.
 * Existing callers (sub-agents, probes) omit both and behave as before.
 */
export function streamChat(
  spec: ProviderSpec,
  model: string,
  messages: ChatMessage[],
  system: string | undefined,
  onEvent: (event: StreamEvent) => void,
  tools?: ToolSchema[],
  streamId?: string,
): Promise<void> {
  const channel = new Channel<StreamEvent>()
  channel.onmessage = onEvent
  return invoke('provider_stream', {
    spec,
    model,
    system,
    messages,
    tools: tools ?? [],
    streamId: streamId ?? '',
    onEvent: channel,
  })
}

/** Aborts the HTTP stream registered under `streamId` (no-op if finished). */
export function cancelStream(streamId: string): Promise<void> {
  return invoke('provider_cancel', { streamId })
}

export async function loadConfig(): Promise<AppConfig> {
  const raw = await invoke<Record<string, unknown>>('config_get')
  return raw as AppConfig
}

export function saveConfig(config: AppConfig): Promise<void> {
  return invoke('config_set', { config })
}

export const providerKey = (id: string) => `provider-${id}`
export const providerOAuthKey = (id: string) => `provider-${id}-oauth`
/** The web search key lives in the same key store as provider keys, under its own name. */
export const searchKeyName = (backend: string) => `search-${backend}`

export function loadProviderKey(id: string): Promise<string | null> {
  return invoke<string | null>('key_get', { name: providerKey(id) })
}
