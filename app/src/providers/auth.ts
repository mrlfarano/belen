import { invoke } from '@tauri-apps/api/core'
import { loadProviderKey, providerOAuthKey } from './client'
import type { OAuthTokens, ProviderConfig, ProviderSpec, TokenSet } from './types'

export async function loadOAuth(id: string): Promise<OAuthTokens | null> {
  const raw = await invoke<string | null>('key_get', { name: providerOAuthKey(id) })
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as OAuthTokens
    return parsed?.accessToken ? parsed : null
  } catch {
    return null
  }
}

export async function saveOAuth(id: string, tokens: OAuthTokens): Promise<void> {
  await invoke('key_set', { name: providerOAuthKey(id), value: JSON.stringify(tokens) })
}

export async function clearOAuth(id: string): Promise<void> {
  await invoke('key_set', { name: providerOAuthKey(id), value: '' })
}

function withExpiry(set: TokenSet, previous?: OAuthTokens | null): OAuthTokens {
  return {
    accessToken: set.accessToken,
    refreshToken: set.refreshToken ?? previous?.refreshToken,
    expiresAt: set.expiresIn ? Date.now() + set.expiresIn * 1000 : undefined,
  }
}

/**
 * Turns a saved provider config into a request spec for the Rust layer.
 * OAuth tokens refresh 60 s before expiry; nothing secret is returned to state.
 */
export async function resolveSpec(provider: ProviderConfig): Promise<ProviderSpec> {
  const base = { kind: provider.kind, baseUrl: provider.baseUrl }
  const mode = provider.authMode ?? 'apiKey'

  if (mode === 'env') {
    return { ...base, auth: 'env', envVar: provider.envVar || 'OPENAI_API_KEY' }
  }

  if (mode === 'oauth') {
    let tokens = await loadOAuth(provider.id)
    if (!tokens) throw new Error('Not connected — run OAuth in Settings')

    if (tokens.expiresAt && Date.now() > tokens.expiresAt - 60_000) {
      if (!tokens.refreshToken || !provider.oauth) {
        throw new Error('OAuth token expired — reconnect in Settings')
      }
      const next = await invoke<TokenSet>('oauth_refresh', {
        req: {
          tokenEndpoint: provider.oauth.tokenEndpoint,
          clientId: provider.oauth.clientId,
          refreshToken: tokens.refreshToken,
        },
      })
      tokens = withExpiry(next, tokens)
      await saveOAuth(provider.id, tokens)
    }

    return { ...base, auth: 'bearer', apiKey: tokens.accessToken }
  }

  const key = await loadProviderKey(provider.id)
  return {
    ...base,
    auth: mode === 'bearer' ? 'bearer' : 'apiKey',
    apiKey: key ?? undefined,
  }
}
