import { describe, expect, it } from 'vitest'
import { TOOL_NAMES, validateToolArgs, toolsSupported, WORKSPACE_TOOLS } from './tools'

describe('tool catalog', () => {
  it('ships exactly the three read-only tools', () => {
    expect([...TOOL_NAMES].sort()).toEqual(['workspace_list', 'workspace_read', 'workspace_search'])
  })

  it('never includes write, shell or network verbs', () => {
    const names = WORKSPACE_TOOLS.map((t) => t.name).join(',')
    expect(names).not.toMatch(/write|edit|delete|shell|exec|fetch|http|net/i)
  })
})

describe('toolsSupported', () => {
  it('enables tools for protocol kinds that stream tool calls', () => {
    expect(toolsSupported('openai', 'C:\\w')).toBe(true)
    expect(toolsSupported('anthropic', 'C:\\w')).toBe(true)
    expect(toolsSupported('google', 'C:\\w')).toBe(true)
  })

  it('keeps local-only providers chatting normally', () => {
    expect(toolsSupported('ollama', 'C:\\w')).toBe(false)
    expect(toolsSupported('lmstudio', 'C:\\w')).toBe(false)
  })

  it('requires a configured workspace', () => {
    expect(toolsSupported('openai', undefined)).toBe(false)
    expect(toolsSupported('openai', '   ')).toBe(false)
    expect(toolsSupported('openai', '')).toBe(false)
  })
})

describe('validateToolArgs', () => {
  it('accepts valid calls', () => {
    expect(validateToolArgs('workspace_list', '{}')).toMatchObject({ ok: true })
    expect(validateToolArgs('workspace_list', '{"path":"src"}')).toMatchObject({ ok: true })
    expect(validateToolArgs('workspace_read', '{"path":"README.md"}')).toMatchObject({ ok: true })
    expect(
      validateToolArgs('workspace_read', '{"path":"README.md","maxBytes":1024}'),
    ).toMatchObject({ ok: true })
    expect(
      validateToolArgs('workspace_search', '{"query":"fn main","maxMatches":10}'),
    ).toMatchObject({ ok: true })
  })

  it('rejects unknown tools (deny-by-default)', () => {
    expect(validateToolArgs('write_file', '{}').ok).toBe(false)
    expect(validateToolArgs('run_shell', '{"cmd":"rm -rf /"}').ok).toBe(false)
  })

  it('rejects malformed JSON with a clear error', () => {
    const r = validateToolArgs('workspace_read', '{"path": ')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/not valid JSON/)
  })

  it('rejects missing required arguments', () => {
    const r = validateToolArgs('workspace_read', '{}')
    expect(r.ok).toBe(false)
  })

  it('rejects unknown fields (model injections like cmd or cwd)', () => {
    expect(validateToolArgs('workspace_read', '{"path":"a","cmd":"evil"}').ok).toBe(false)
    expect(validateToolArgs('workspace_search', '{"query":"x","cwd":".."}').ok).toBe(false)
  })

  it('rejects out-of-range bounds', () => {
    expect(validateToolArgs('workspace_read', '{"path":"a","maxBytes":99999999}').ok).toBe(false)
    expect(validateToolArgs('workspace_search', '{"query":"x","maxMatches":5000}').ok).toBe(false)
    expect(validateToolArgs('workspace_search', '{"query":""}').ok).toBe(false)
    expect(validateToolArgs('workspace_search', `{"query":"${'x'.repeat(300)}"}`).ok).toBe(false)
  })

  it('rejects wrong types', () => {
    expect(validateToolArgs('workspace_read', '{"path":42}').ok).toBe(false)
    expect(validateToolArgs('workspace_list', '{"path":true}').ok).toBe(false)
  })

  it('treats empty arguments as an empty object for the argless tool', () => {
    expect(validateToolArgs('workspace_list', '').ok).toBe(true)
    expect(validateToolArgs('workspace_read', '').ok).toBe(false)
  })
})
