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
  | { type: 'done'; usage?: unknown }
  | { type: 'error'; message: string }

export type ChatMessage = {
  role: string
  content: string
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

export type AppConfig = {
  provider?: ProviderConfig
  skills?: string[]
  grants?: Record<string, string[]>
}
