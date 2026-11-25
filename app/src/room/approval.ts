const PREVIEW_LIMIT = 4_000

const text = (args: Record<string, unknown>, key: string) =>
  typeof args[key] === 'string' ? (args[key] as string) : ''

const clip = (value: string) =>
  value.length <= PREVIEW_LIMIT
    ? value
    : `${value.slice(0, PREVIEW_LIMIT)}\n… (${value.length - PREVIEW_LIMIT} more characters not shown)`

/**
 * What the room shows while a gated call waits for the user: the whole of
 * what would happen, in the terms the user reads it. A label may summarize;
 * this may not — nobody approves a command by reading a digest of it.
 */
export function approvalPreview(name: string, args: Record<string, unknown>): string {
  if (name === 'run_command') {
    const cwd = text(args, 'cwd')
    return [cwd ? `(in ${cwd}/)` : '', clip(text(args, 'command'))].filter(Boolean).join('\n')
  }
  if (name === 'workspace_write') {
    const content = text(args, 'content')
    return [
      `path: ${text(args, 'path')}`,
      'Creates the file, or replaces whatever is there entirely.',
      content ? clip(content) : '(an empty file)',
    ].join('\n\n')
  }
  if (name === 'workspace_edit') {
    return [
      `path: ${text(args, 'path')}${args.replaceAll ? ' — every occurrence' : ''}`,
      `replace:\n${clip(text(args, 'oldText'))}`,
      `with:\n${clip(text(args, 'newText'))}`,
    ].join('\n\n')
  }
  return `${name}\n${clip(JSON.stringify(args, null, 2))}`
}
