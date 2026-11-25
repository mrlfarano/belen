import { describe, expect, it } from 'vitest'
import { CHAT_WIDTHS, mergeConfig, withChatWidth, widthOf, withWorkspace } from './config'
import type { AppConfig } from './types'

const baseConfig: AppConfig = {
  provider: { id: 'zai', label: 'Z.ai', kind: 'openai', baseUrl: 'https://x', model: 'm', temperature: 0.7, maxTokens: 4096 },
  skills: ['summarize'],
  grants: { summarize: ['net'] },
}

describe('mergeConfig', () => {
  it('preserves unrelated sections (the settings-save wipe regression)', () => {
    const next = mergeConfig(baseConfig, { chat: { width: 'wide' } })
    expect(next.provider?.id).toBe('zai')
    expect(next.skills).toEqual(['summarize'])
    expect(next.grants).toEqual({ summarize: ['net'] })
    expect(next.chat?.width).toBe('wide')
  })

  it('lets a patch replace its own section', () => {
    const next = mergeConfig(baseConfig, { skills: [] })
    expect(next.skills).toEqual([])
    expect(next.provider?.id).toBe('zai')
  })

  it('tolerates a null base (first run)', () => {
    const next = mergeConfig(null, { workspace: 'C:\\w' })
    expect(next.workspace).toBe('C:\\w')
  })
})

describe('chat width', () => {
  it('defaults when unset', () => {
    expect(widthOf(null)).toBe('default')
    expect(widthOf({})).toBe('default')
    expect(widthOf({ chat: {} })).toBe('default')
  })

  it('round-trips through the config (restart persistence shape)', () => {
    const saved = withChatWidth(baseConfig, 'narrow')
    expect(saved.chat?.width).toBe('narrow')
    expect(widthOf(saved)).toBe('narrow')
  })

  it('keeps other chat fields when changing width', () => {
    const withExtra: AppConfig = { chat: { width: 'wide' } }
    const saved = withChatWidth(withExtra, 'full')
    expect(saved.chat?.width).toBe('full')
  })

  it('offers exactly the four documented options', () => {
    expect(CHAT_WIDTHS.map((w) => w.id)).toEqual(['narrow', 'default', 'wide', 'full'])
  })
})

describe('workspace', () => {
  it('trims and drops empty values', () => {
    expect(withWorkspace(baseConfig, '  C:\\repo  ').workspace).toBe('C:\\repo')
    expect(withWorkspace(baseConfig, '   ').workspace).toBeUndefined()
  })
})
