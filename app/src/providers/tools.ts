import { z } from 'zod'
import { toolsOf } from './config'
import type { AppConfig, AskBefore } from './types'

/**
 * The tools the model can be given, grouped by the switch that owns them
 * (Settings → Chat → Tools). Every class is on until the user turns it off,
 * and the Rust broker reads those switches itself for every call (`Policy` in
 * tools.rs) — this file only decides what to advertise and validates what
 * comes back.
 *
 *  - workspace reads: list, read, search. They work in the workspace chosen
 *    in Settings, or in the user's home when none is.
 *  - web: search and fetch.
 *  - workspace writes: create and edit. Each change waits for the user.
 *  - commands: PowerShell on Windows, zsh on macOS. Each command waits for
 *    the user — this is real, unsandboxed access to the machine, and that
 *    approval is the guard.
 */

export type ToolSchema = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

const relPath = { type: 'string', description: 'Path relative to the workspace root.' }

/** The three read-only workspace tools, as shipped in 0.2.2. */
export const WORKSPACE_TOOLS: ToolSchema[] = [
  {
    name: 'workspace_list',
    description:
      'List the files and folders directly inside the selected workspace (or one subfolder of it). Paths are relative to the workspace root.',
    parameters: object(
      {
        path: {
          type: 'string',
          description: 'Optional subfolder to list, relative to the workspace root.',
        },
      },
      [],
    ),
  },
  {
    name: 'workspace_read',
    description:
      'Read the beginning of one text file from the selected workspace (up to 64 KB). Paths are relative to the workspace root.',
    parameters: object(
      {
        path: { type: 'string', description: 'File to read, relative to the workspace root.' },
        maxBytes: {
          type: 'integer',
          description: 'Optional byte cap between 1 and 65536. Default 65536.',
        },
      },
      ['path'],
    ),
  },
  {
    name: 'workspace_search',
    description:
      'Search every text file in the selected workspace for a piece of text (case-insensitive substring). Returns matching file paths, line numbers and the line text. Paths are relative to the workspace root.',
    parameters: object(
      {
        query: { type: 'string', description: 'Text to look for (1-200 characters).' },
        path: {
          type: 'string',
          description: 'Optional subfolder to restrict the search to.',
        },
        maxMatches: {
          type: 'integer',
          description: 'Optional cap between 1 and 100. Default 50.',
        },
      },
      ['query'],
    ),
  },
]

export const WEB_TOOLS: ToolSchema[] = [
  {
    name: 'web_search',
    description:
      'Search the web. Returns the title, URL and a short description of each result; open the promising ones with web_fetch before relying on them.',
    parameters: object(
      {
        query: { type: 'string', description: 'What to look for.' },
        maxResults: {
          type: 'integer',
          description: 'Optional number of results between 1 and 10. Default 5.',
        },
      },
      ['query'],
    ),
  },
  {
    name: 'web_fetch',
    description:
      'Read one public web page as plain text (up to 12,000 characters), with its title and links. Only public http(s) addresses; pages on a local network are refused.',
    parameters: object(
      { url: { type: 'string', description: 'Absolute http(s) URL of the page.' } },
      ['url'],
    ),
  },
]

export const WRITE_TOOLS: ToolSchema[] = [
  {
    name: 'workspace_write',
    description:
      'Create a file in the workspace, or replace an existing one entirely. Paths are relative to the workspace root. The user approves each change before it applies.',
    parameters: object(
      {
        path: relPath,
        content: { type: 'string', description: 'The full new contents of the file.' },
      },
      ['path', 'content'],
    ),
  },
  {
    name: 'workspace_edit',
    description:
      'Change part of a text file in the workspace by replacing one exact piece of text. Read the file first: oldText must match exactly once, whitespace included, unless replaceAll is set. The user approves each change before it applies.',
    parameters: object(
      {
        path: relPath,
        oldText: { type: 'string', description: 'The exact text to replace.' },
        newText: { type: 'string', description: 'What replaces it.' },
        replaceAll: {
          type: 'boolean',
          description: 'Optional. Replace every occurrence instead of exactly one.',
        },
      },
      ['path', 'oldText', 'newText'],
    ),
  },
]

export const SHELL_TOOLS: ToolSchema[] = [
  {
    name: 'run_command',
    description:
      "Run one command line in the workspace on the user's computer — PowerShell on Windows, zsh on macOS — and return its output. The user approves each command before it runs. Nothing here is sandboxed.",
    parameters: object(
      {
        command: { type: 'string', description: 'The command line to run.' },
        timeoutMs: {
          type: 'integer',
          description: 'Optional time limit in milliseconds between 1000 and 300000. Default 60000.',
        },
        cwd: {
          type: 'string',
          description: 'Optional subfolder of the workspace to run in, relative to its root.',
        },
      },
      ['command'],
    ),
  },
]

export const TOOL_NAMES = new Set(
  [...WORKSPACE_TOOLS, ...WEB_TOOLS, ...WRITE_TOOLS, ...SHELL_TOOLS].map((t) => t.name),
)

/** Provider kinds whose adapters stream tool calls through the broker. */
const TOOL_KINDS = new Set(['openai', 'anthropic', 'google'])

/**
 * The tools to advertise for one send: protocol support first, then the
 * switches. The workspace tools are always among them — with no folder chosen
 * in Settings, the broker works in the user's home. Everything else keeps
 * chatting as before.
 */
export function toolsFor(config: AppConfig | null | undefined, kind: string): ToolSchema[] {
  if (!TOOL_KINDS.has(kind)) return []
  const switches = toolsOf(config)
  return [
    ...WORKSPACE_TOOLS,
    ...(switches.network ? WEB_TOOLS : []),
    ...(switches.files === 'write' ? WRITE_TOOLS : []),
    ...(switches.shell ? SHELL_TOOLS : []),
  ]
}

/** What a tool changes in the world, which decides whether it waits for the user. */
export function approvalClass(name: string): 'command' | 'change' | null {
  if (name === 'run_command') return 'command'
  if (name === 'workspace_write' || name === 'workspace_edit') return 'change'
  return null
}

/** Mirrors `Policy::needs_approval` in tools.rs: the broker refuses the call otherwise. */
export function needsApproval(askBefore: AskBefore, name: string): boolean {
  if (askBefore === 'never') return false
  const gate = approvalClass(name)
  return gate === 'command' || (gate === 'change' && askBefore === 'changes')
}

const listArgs = z.strictObject({
  path: z.string().min(1).max(512).optional(),
})

const readArgs = z.strictObject({
  path: z.string().min(1).max(512),
  maxBytes: z.number().int().positive().max(65_536).optional(),
})

const searchArgs = z.strictObject({
  query: z.string().min(1).max(200),
  path: z.string().min(1).max(512).optional(),
  maxMatches: z.number().int().positive().max(100).optional(),
})

const webSearchArgs = z.strictObject({
  query: z.string().min(1).max(400),
  maxResults: z.number().int().min(1).max(10).optional(),
})

const webFetchArgs = z.strictObject({
  url: z
    .string()
    .min(8)
    .max(2_000)
    .regex(/^https?:\/\/[^\s/?#]+/i, 'url must be an absolute http(s) address'),
})

const writeArgs = z.strictObject({
  path: z.string().min(1).max(512),
  content: z.string().max(256 * 1024),
})

const editArgs = z.strictObject({
  path: z.string().min(1).max(512),
  oldText: z.string().min(1).max(32_000),
  newText: z.string().max(64_000),
  replaceAll: z.boolean().optional(),
})

const commandArgs = z.strictObject({
  command: z.string().min(1).max(8_000),
  timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
  cwd: z.string().min(1).max(512).optional(),
})

const SCHEMAS: Record<string, z.ZodType> = {
  workspace_list: listArgs,
  workspace_read: readArgs,
  workspace_search: searchArgs,
  web_search: webSearchArgs,
  web_fetch: webFetchArgs,
  workspace_write: writeArgs,
  workspace_edit: editArgs,
  run_command: commandArgs,
}

export type ValidatedArgs =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string }

/**
 * Model-produced arguments are untrusted input: parse as JSON, reject unknown
 * fields, and validate against the per-tool schema before anything reaches the
 * broker.
 */
export function validateToolArgs(name: string, raw: string): ValidatedArgs {
  const schema = SCHEMAS[name]
  if (!schema) return { ok: false, error: `unknown tool: ${name}` }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw || '{}')
  } catch {
    return { ok: false, error: 'arguments are not valid JSON' }
  }

  const result = schema.safeParse(parsed)
  if (!result.success) {
    const first = result.error.issues[0]
    const where = first.path.length ? ` at ${first.path.join('.')}` : ''
    return { ok: false, error: `invalid arguments${where}: ${first.message}` }
  }
  return { ok: true, args: result.data as Record<string, unknown> }
}

/** One-line human summary for the chat transcript — never the raw content. */
export function describeCall(name: string, args: Record<string, unknown>): string {
  const text = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : '')
  const quoted = (key: string) => {
    const value = text(key)
    return value ? JSON.stringify(value) : ''
  }
  const path = text('path')
  if (name === 'workspace_list') return path ? `list ${path}/` : 'list workspace'
  if (name === 'workspace_read') return `read ${path}`
  if (name === 'workspace_search') {
    const q = quoted('query')
    return path ? `search ${q} in ${path}/` : `search ${q}`
  }
  if (name === 'web_search') return `search the web for ${quoted('query')}`
  if (name === 'web_fetch') return `fetch ${text('url')}`
  if (name === 'workspace_write') return `write ${path}`
  if (name === 'workspace_edit') return `edit ${path}`
  if (name === 'run_command') {
    // The first line only — but a label must never hide that there is more.
    const lines = text('command').split('\n')
    const head = lines[0]
    const rest = lines.length - 1
    const label = head.length > 80 ? `${head.slice(0, 80)}…` : head
    return rest > 0 ? `run ${label} (+${rest} more line${rest > 1 ? 's' : ''})` : `run ${label}`
  }
  return name
}
