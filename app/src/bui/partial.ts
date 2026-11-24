import { BuiBlockSchema, type BuiBlock } from './schema'

export type PartialBui = {
  blocks: BuiBlock[]
  /** True when the payload's root object closed. */
  complete: boolean
  /** True when a JSON object was found at all. */
  started: boolean
}

/**
 * Extracts the outermost JSON object, tolerating a truncated stream and an
 * optional ```bui fence. Returns `complete: false` when the braces never close.
 */
function extractJson(input: string): { text: string; complete: boolean } | null {
  let text = input.trim()

  const fence = text.indexOf('```')
  if (fence >= 0) {
    const firstLineEnd = text.indexOf('\n', fence)
    if (firstLineEnd >= 0) text = text.slice(firstLineEnd + 1)
    const closing = text.lastIndexOf('```')
    if (closing >= 0) text = text.slice(0, closing)
  }

  const start = text.indexOf('{')
  if (start < 0) return null
  text = text.slice(start)

  let depth = 0
  let inString = false
  let escape = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      depth += 1
      continue
    }
    if (ch === '}') {
      depth -= 1
      if (depth === 0) return { text: text.slice(0, i + 1), complete: true }
    }
  }

  return { text, complete: false }
}

/** Parses every top-level block object that is already complete. */
function parseCompleteBlocks(text: string): BuiBlock[] {
  const key = text.indexOf('"blocks"')
  if (key < 0) return []

  const open = text.indexOf('[', key)
  if (open < 0) return []

  const blocks: BuiBlock[] = []
  let depth = 0
  let inString = false
  let escape = false
  let start = -1

  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i]

    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }

    if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
      continue
    }

    if (ch === '}') {
      depth -= 1
      if (depth === 0 && start >= 0) {
        const raw = text.slice(start, i + 1)
        try {
          const parsed = BuiBlockSchema.safeParse(JSON.parse(raw))
          if (parsed.success) blocks.push(parsed.data)
        } catch {
          /* incomplete or invalid block — skip */
        }
        start = -1
      }
      if (depth < 0) break
      continue
    }

    if (ch === ']' && depth === 0) break
  }

  return blocks
}

export function parseBuiPartial(input: string): PartialBui {
  const json = extractJson(input)
  if (!json) return { blocks: [], complete: false, started: false }

  const blocks = parseCompleteBlocks(json.text)
  return {
    blocks,
    complete: json.complete && blocks.length > 0,
    started: true,
  }
}
