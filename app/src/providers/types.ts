export type ProviderKind = 'openai' | 'anthropic' | 'google' | 'ollama' | 'lmstudio'
export type AuthKind = 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'none'

export type ProviderDef = {
  id: string
  label: string
  kind: ProviderKind
  baseUrl: string
  auth: AuthKind
  blurb: string
  /** Used when the provider has no /models endpoint (e.g. Z.ai). */
  fallbackModels?: string[]
}

export type AuthMode = 'apiKey' | 'bearer' | 'env' | 'oauth'

export type ProviderSpec = {
  kind: string
  baseUrl: string
  apiKey?: string
  headers?: Record<string, string>
  auth?: string
  headerName?: string
  envVar?: string
}

export type ModelInfo = {
  id: string
  label: string
  contextWindow?: number
}

export type TestResult = {
  ok: boolean
  ttftMs: number
  text: string
  error?: string
}

export type StreamEvent =
  | { type: 'token'; text: string }
  | { type: 'toolCall'; callId: string; name: string; arguments: string }
  | { type: 'done'; usage?: unknown }
  | { type: 'error'; message: string }

/** A tool call the model asked for, in provider-neutral form. */
export type ToolCallRef = {
  id: string
  name: string
  /** Raw JSON text as produced by the model — untrusted until validated. */
  arguments: string
}

export type ChatMessage = {
  role: string
  content: string
  /** assistant → tool calls it issued. */
  toolCalls?: ToolCallRef[]
  /** role "tool" → the call id this message answers. */
  toolCallId?: string
  /** role "tool" → the tool name, required by some providers (Google). */
  name?: string
}

export type ProviderConfig = {
  id: string
  label: string
  kind: string
  baseUrl: string
  model: string
  temperature: number
  maxTokens: number
  authMode?: AuthMode
  envVar?: string
  oauth?: OAuthConfig
}

export type OAuthConfig = {
  clientId: string
  deviceEndpoint: string
  tokenEndpoint: string
  scope: string
}

export type OAuthTokens = {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
}

export type DeviceStart = {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresIn: number
  interval: number
}

export type TokenSet = {
  accessToken: string
  refreshToken?: string
  expiresIn?: number
  tokenType?: string
  scope?: string
}

export type TokenPoll = {
  status: string
  tokens?: TokenSet
  error?: string
}

export type ChatWidth = 'narrow' | 'default' | 'wide' | 'full'

export type FilesAccess = 'read' | 'write'
export type AskBefore = 'changes' | 'commands' | 'never'
export type SearchBackend = 'tavily'

/**
 * The tool switches (Settings → Chat → Tools). An absent switch is on, and a
 * malformed value means "off"; the Rust broker reads the same section and
 * refuses a class that is switched off, so this is a preference, not the trust
 * boundary.
 */
export type ToolsConfig = {
  /** Web search and page fetch. */
  network?: boolean
  /** `read` keeps the workspace read-only; `write` adds create and edit. */
  files?: FilesAccess
  /** Commands on this computer. */
  shell?: boolean
  /** Which calls pause for approval in the room. */
  askBefore?: AskBefore
  search?: SearchBackend
}

export type AppConfig = {
  provider?: ProviderConfig
  skills?: string[]
  grants?: Record<string, string[]>
  chat?: {
    /** Conversation column width; absent = 'default' (the 0.2 look). */
    width?: ChatWidth
  }
  /**
   * Absolute path of the workspace the tools may look into. Absent means the
   * user's home folder, which the broker resolves itself.
   */
  workspace?: string
  tools?: ToolsConfig
}
