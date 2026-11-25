import { z } from 'zod'

/**
 * The three standard read-only workspace tools. Nothing here writes, edits,
 * shells out, or touches the network — the Rust broker denies by default and
 * this list is the only allowlist.
 *
 * Authorizing more capability later is a deliberate, separate act:
 *  - edits/writes: a new broker verb class with an explicit per-workspace grant
 *    in Settings (deny-by-default, diff preview before apply),
 *  - arbitrary shell: requires a separate "advanced" opt-in plus per-call
 *    confirmation, and must never be reachable through this allowlist,
 *  - general network access: a dedicated egress allowlist in the broker, never
 *    keyed off the chat provider config.
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

export const TOOL_NAMES = new Set(WORKSPACE_TOOLS.map((t) => t.name))

/** Provider kinds whose adapters stream tool calls through the broker. */
const TOOL_KINDS = new Set(['openai', 'anthropic', 'google'])

/**
 * Tools attach only when the provider protocol supports them and a workspace
 * is configured. Everything else keeps chatting exactly as before.
 */
export const toolsSupported = (
  kind: string,
  workspace: string | undefined,
): boolean => TOOL_KINDS.has(kind) && typeof workspace === 'string' && workspace.trim().length > 0

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

const SCHEMAS: Record<string, z.ZodType> = {
  workspace_list: listArgs,
  workspace_read: readArgs,
  workspace_search: searchArgs,
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
  const path = typeof args.path === 'string' ? args.path : ''
  if (name === 'workspace_list') return path ? `list ${path}/` : 'list workspace'
  if (name === 'workspace_read') return `read ${path}`
  if (name === 'workspace_search') {
    const q = typeof args.query === 'string' ? JSON.stringify(args.query) : ''
    return path ? `search ${q} in ${path}/` : `search ${q}`
  }
  return name
}
