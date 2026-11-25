import { describe, expect, it } from 'vitest'
import {
  describeCall,
  needsApproval,
  SHELL_TOOLS,
  TOOL_NAMES,
  toolsFor,
  validateToolArgs,
  WEB_TOOLS,
  WORKSPACE_TOOLS,
  WRITE_TOOLS,
} from './tools'
import type { AppConfig } from './types'

const READ = ['workspace_list', 'workspace_read', 'workspace_search']
const names = (tools: { name: string }[]) => tools.map((t) => t.name)

describe('tool catalog', () => {
  it('keeps the read-only group exactly as shipped', () => {
    expect(names(WORKSPACE_TOOLS)).toEqual(READ)
    expect(names(WORKSPACE_TOOLS).join(',')).not.toMatch(/write|edit|delete|shell|exec|fetch|http|net/i)
  })

  it('has no name in two groups, and no name outside a group', () => {
    const all = [...WORKSPACE_TOOLS, ...WEB_TOOLS, ...WRITE_TOOLS, ...SHELL_TOOLS].map((t) => t.name)
    expect(new Set(all).size).toBe(all.length)
    expect([...TOOL_NAMES].sort()).toEqual([...all].sort())
  })
})

describe('toolsFor', () => {
  it('offers all eight before anyone has touched the switches', () => {
    for (const config of [null, {}, { tools: {} }]) {
      expect(names(toolsFor(config, 'openai'))).toEqual([...READ, ...names([...WEB_TOOLS, ...WRITE_TOOLS, ...SHELL_TOOLS])])
    }
  })

  it('offers only the workspace reads when every other class is switched off', () => {
    const off: AppConfig = { tools: { network: false, files: 'read', shell: false } }
    expect(names(toolsFor(off, 'openai'))).toEqual(READ)
  })

  it('needs a protocol that streams tool calls', () => {
    const all: AppConfig = {
      workspace: 'C:\\w',
      tools: { network: true, files: 'write', shell: true },
    }
    for (const kind of ['openai', 'anthropic', 'google']) expect(toolsFor(all, kind)).toHaveLength(8)
    expect(toolsFor(all, 'ollama')).toEqual([])
    expect(toolsFor(all, 'lmstudio')).toEqual([])
  })

  it('needs no workspace: with none chosen, the broker works in the home folder', () => {
    const changes: AppConfig = { tools: { network: false, files: 'write', shell: true } }
    expect(names(toolsFor(changes, 'openai'))).toEqual([
      ...READ,
      'workspace_write',
      'workspace_edit',
      'run_command',
    ])
    // A blank folder counts as none chosen, and a chosen one changes nothing.
    expect(names(toolsFor({ workspace: '   ' }, 'openai'))).toHaveLength(8)
    expect(names(toolsFor({ workspace: 'C:\\w' }, 'openai'))).toHaveLength(8)
  })

  it('ignores switches that are not exactly on', () => {
    const odd = {
      workspace: 'C:\\w',
      tools: { network: 'true', files: 'Write', shell: 1 },
    } as unknown as AppConfig
    expect(names(toolsFor(odd, 'openai'))).toEqual(READ)
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
    expect(validateToolArgs('delete_file', '{"path":"a"}').ok).toBe(false)
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

describe('validateToolArgs for the newer tools', () => {
  it('accepts well-formed calls', () => {
    expect(validateToolArgs('web_search', '{"query":"rust 1.90"}').ok).toBe(true)
    expect(validateToolArgs('web_search', '{"query":"x","maxResults":10}').ok).toBe(true)
    expect(validateToolArgs('web_fetch', '{"url":"https://example.com/a?b=1"}').ok).toBe(true)
    expect(validateToolArgs('workspace_write', '{"path":"notes/a.txt","content":"hi"}').ok).toBe(true)
    // An empty file is a legitimate thing to create.
    expect(validateToolArgs('workspace_write', '{"path":"notes/a.txt","content":""}').ok).toBe(true)
    expect(
      validateToolArgs(
        'workspace_edit',
        '{"path":"a.rs","oldText":"fn a()","newText":"fn b()","replaceAll":true}',
      ).ok,
    ).toBe(true)
    expect(
      validateToolArgs('run_command', '{"command":"git status","timeoutMs":5000,"cwd":"src"}').ok,
    ).toBe(true)
  })

  it('refuses addresses the fetcher would refuse anyway', () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com', 'example.com', 'https://']) {
      expect(validateToolArgs('web_fetch', JSON.stringify({ url })).ok).toBe(false)
    }
  })

  it('rejects empty and out-of-range arguments', () => {
    expect(validateToolArgs('web_search', '{"query":""}').ok).toBe(false)
    expect(validateToolArgs('web_search', '{"query":"x","maxResults":50}').ok).toBe(false)
    expect(validateToolArgs('workspace_edit', '{"path":"a","oldText":"","newText":"x"}').ok).toBe(false)
    expect(validateToolArgs('run_command', '{"command":""}').ok).toBe(false)
    expect(validateToolArgs('run_command', '{"command":"x","timeoutMs":999}').ok).toBe(false)
    expect(validateToolArgs('run_command', '{"command":"x","timeoutMs":300001}').ok).toBe(false)
    expect(validateToolArgs('run_command', `{"command":"${'x'.repeat(9000)}"}`).ok).toBe(false)
    expect(
      validateToolArgs('workspace_write', `{"path":"a","content":"${'x'.repeat(300_000)}"}`).ok,
    ).toBe(false)
  })

  it('rejects fields the tool does not have', () => {
    expect(validateToolArgs('web_fetch', '{"url":"https://a.com","method":"POST"}').ok).toBe(false)
    expect(validateToolArgs('run_command', '{"command":"x","shell":"cmd"}').ok).toBe(false)
    expect(validateToolArgs('workspace_write', '{"path":"a","content":"x","overwrite":true}').ok).toBe(
      false,
    )
  })
})

describe('needsApproval', () => {
  it('asks for commands and file changes by default, and for nothing else', () => {
    for (const name of ['run_command', 'workspace_write', 'workspace_edit']) {
      expect(needsApproval('changes', name)).toBe(true)
    }
    for (const name of ['web_search', 'web_fetch', ...READ]) {
      expect(needsApproval('changes', name)).toBe(false)
    }
  })

  it('lets file changes through when only commands ask', () => {
    expect(needsApproval('commands', 'run_command')).toBe(true)
    expect(needsApproval('commands', 'workspace_edit')).toBe(false)
  })

  it('asks for nothing once the user turned approvals off', () => {
    expect(needsApproval('never', 'run_command')).toBe(false)
    expect(needsApproval('never', 'workspace_write')).toBe(false)
  })
})

describe('describeCall', () => {
  it('names the target of each newer tool', () => {
    expect(describeCall('web_search', { query: 'rust' })).toBe('search the web for "rust"')
    expect(describeCall('web_fetch', { url: 'https://a.com' })).toBe('fetch https://a.com')
    expect(describeCall('workspace_write', { path: 'a.txt' })).toBe('write a.txt')
    expect(describeCall('workspace_edit', { path: 'src/a.rs' })).toBe('edit src/a.rs')
  })

  it('never lets a label hide that a command has more lines', () => {
    expect(describeCall('run_command', { command: 'git status' })).toBe('run git status')
    expect(describeCall('run_command', { command: 'git status\nrm -rf x' })).toBe(
      'run git status (+1 more line)',
    )
    expect(describeCall('run_command', { command: 'a\nb\nc' })).toBe('run a (+2 more lines)')
    expect(describeCall('run_command', { command: 'x'.repeat(100) })).toBe(`run ${'x'.repeat(80)}…`)
  })
})
