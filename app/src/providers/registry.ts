import type { ModelInfo, ProviderDef } from './types'

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    auth: 'bearer',
    blurb: 'GPT-4o · GPT-4.1 · o3',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    auth: 'x-api-key',
    blurb: 'Claude Sonnet · Opus',
  },
  {
    id: 'google',
    label: 'Google',
    kind: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    auth: 'x-goog-api-key',
    blurb: 'Gemini 2.5 · Gemini 3',
  },
  {
    id: 'zai',
    label: 'Z.ai',
    kind: 'openai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    auth: 'bearer',
    blurb: 'GLM-5.4 · GLM-5.3 · live model list',
    fallbackModels: ['glm-5.4', 'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-4.7', 'glm-4.6'],
  },
  {
    id: 'zai-coding',
    label: 'Z.ai Coding Plan',
    kind: 'openai',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    auth: 'bearer',
    blurb: 'GLM Coding Plan subscription',
    fallbackModels: ['glm-5.4', 'glm-5.3', 'glm-5.3-flash', 'glm-4.6'],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    auth: 'bearer',
    blurb: '300+ models, one key',
  },
  {
    id: 'groq',
    label: 'Groq',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    auth: 'bearer',
    blurb: 'Fast inference',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    kind: 'ollama',
    baseUrl: 'http://localhost:11434',
    auth: 'none',
    blurb: 'Local models',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    kind: 'lmstudio',
    baseUrl: 'http://localhost:1234/v1',
    auth: 'none',
    blurb: 'Local models',
  },
]

export function knownModels(provider: ProviderDef): ModelInfo[] {
  return (provider.fallbackModels ?? []).map((id) => ({ id, label: id }))
}
