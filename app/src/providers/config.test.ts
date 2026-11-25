import { describe, expect, it } from 'vitest'
import {
  ASK_BEFORE_OPTIONS,
  CHAT_WIDTHS,
  mergeConfig,
  toolsOf,
  withChatWidth,
  withTools,
  widthOf,
  withWorkspace,
} from './config'
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
    // Every value the type allows has a choice, and the strictest is first.
    expect(ASK_BEFORE_OPTIONS.map((o) => o.id)).toEqual(['changes', 'commands', 'never'])
  })
})

describe('workspace', () => {
  it('trims and drops empty values', () => {
    expect(withWorkspace(baseConfig, '  C:\\repo  ').workspace).toBe('C:\\repo')
    expect(withWorkspace(baseConfig, '   ').workspace).toBeUndefined()
  })
})

describe('tool switches', () => {
  const everythingOn = {
    network: true,
    files: 'write',
    shell: true,
    askBefore: 'changes',
    search: 'tavily',
  } as const
  const everythingOff = { ...everythingOn, network: false, files: 'read', shell: false } as const

  it('are all on when the section is missing or empty', () => {
    expect(toolsOf(null)).toEqual(everythingOn)
    expect(toolsOf({})).toEqual(everythingOn)
    expect(toolsOf({ tools: {} })).toEqual(everythingOn)
    expect(toolsOf({ tools: { network: null } } as unknown as AppConfig)).toEqual(everythingOn)
  })

  it('count anything but the exact schema as off, like the broker does', () => {
    const odd = {
      tools: { network: 'yes', files: 'editor', shell: 1, askBefore: 'sometimes' },
    } as unknown as AppConfig
    expect(toolsOf(odd)).toEqual(everythingOff)
  })

  it('let a malformed value turn off its own class only', () => {
    const odd = { tools: { network: 'yes', shell: true } } as unknown as AppConfig
    expect(toolsOf(odd)).toEqual({ ...everythingOn, network: false })
  })

  it('turn everything off when the section itself is not an object', () => {
    expect(toolsOf({ tools: 'yes' } as unknown as AppConfig)).toEqual(everythingOff)
  })

  it('read back exactly what was switched', () => {
    const on = toolsOf(
      withTools(null, { network: true, files: 'write', shell: true, askBefore: 'commands' }),
    )
    expect(on).toEqual({ ...everythingOn, askBefore: 'commands' })

    // An install that turned a class off keeps it off across restarts.
    const off = toolsOf(
      withTools(null, { network: false, files: 'read', shell: false, askBefore: 'never' }),
    )
    expect(off).toEqual({ ...everythingOff, askBefore: 'never' })
  })

  it('change one switch without disturbing the others or the rest of the config', () => {
    const next = withTools(withTools(baseConfig, { network: true }), { shell: true })
    expect(next.tools).toEqual({ network: true, shell: true })
    expect(next.provider?.id).toBe('zai')
    expect(next.grants).toEqual({ summarize: ['net'] })
  })
})
