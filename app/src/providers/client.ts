import { Channel, invoke } from '@tauri-apps/api/core'
import type {
  AppConfig,
  ChatMessage,
  ModelInfo,
  ProviderSpec,
  StreamEvent,
  TestResult,
} from './types'

export function discover(spec: ProviderSpec): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>('provider_discover', { spec })
}

export function testProvider(spec: ProviderSpec, model: string): Promise<TestResult> {
  return invoke<TestResult>('provider_test', { spec, model })
}

export function streamChat(
  spec: ProviderSpec,
  model: string,
  messages: ChatMessage[],
  system: string | undefined,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const channel = new Channel<StreamEvent>()
  channel.onmessage = onEvent
  return invoke('provider_stream', { spec, model, system, messages, onEvent: channel })
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

export function loadProviderKey(id: string): Promise<string | null> {
  return invoke<string | null>('key_get', { name: providerKey(id) })
}
