import { parseBui, type BuiPayload } from './schema'

/**
 * Pulls the first fenced ```bui payload out of an answer, returns the validated
 * payload and the prose with the fence removed.
 */
export function extractBui(
  text: string,
): { payload: BuiPayload; prose: string } | null {
  const match = text.match(/```bui\s*([\s\S]*?)```/i)
  if (!match) return null

  try {
    const payload = parseBui(JSON.parse(match[1].trim()))
    if (!payload) return null
    return { payload, prose: text.replace(match[0], '').trim() }
  } catch {
    return null
  }
}
