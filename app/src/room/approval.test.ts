import { describe, expect, it } from 'vitest'
import { approvalPreview } from './approval'

describe('approvalPreview', () => {
  it('shows a command whole, every line of it', () => {
    const preview = approvalPreview('run_command', { command: 'git status\nrm -rf tmp' })
    expect(preview).toBe('git status\nrm -rf tmp')
  })

  it('names the folder a command runs in when it is not the workspace root', () => {
    expect(approvalPreview('run_command', { command: 'ls', cwd: 'src/app' })).toBe('(in src/app/)\nls')
    expect(approvalPreview('run_command', { command: 'ls' })).toBe('ls')
  })

  it('shows the file a write lands in and everything it will contain', () => {
    const preview = approvalPreview('workspace_write', { path: 'notes/a.txt', content: 'hello' })
    expect(preview).toBe(
      'path: notes/a.txt\n\nCreates the file, or replaces whatever is there entirely.\n\nhello',
    )
    expect(approvalPreview('workspace_write', { path: 'a.txt', content: '' })).toContain('(an empty file)')
  })

  it('shows an edit as before and after, and says when it replaces everywhere', () => {
    const preview = approvalPreview('workspace_edit', {
      path: 'a.rs',
      oldText: 'fn a()',
      newText: 'fn b()',
    })
    expect(preview).toBe('path: a.rs\n\nreplace:\nfn a()\n\nwith:\nfn b()')
    expect(
      approvalPreview('workspace_edit', { path: 'a.rs', oldText: 'a', newText: 'b', replaceAll: true }),
    ).toContain('path: a.rs — every occurrence')
  })

  it('says so when it had to cut a long body, instead of ending quietly', () => {
    const preview = approvalPreview('run_command', { command: 'x'.repeat(5_000) })
    expect(preview).toContain('… (1000 more characters not shown)')
  })

  it('falls back to the raw arguments for anything else', () => {
    expect(approvalPreview('web_fetch', { url: 'https://a.com' })).toBe('web_fetch\n{\n  "url": "https://a.com"\n}')
  })
})
