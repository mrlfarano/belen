import { describe, expect, it } from 'vitest'
import { extractBui } from './extract'

describe('extractBui', () => {
  it('pulls a fenced payload out and strips it from the prose', () => {
    const text = [
      'Here is the comparison.',
      '```bui',
      '{"v":1,"blocks":[{"type":"table","columns":["a"],"rows":[["1"]]}]}',
      '```',
      'Sort it yourself.',
    ].join('\n')

    const result = extractBui(text)

    expect(result).not.toBeNull()
    expect(result!.payload.blocks).toHaveLength(1)
    expect(result!.prose).toBe('Here is the comparison.\n\nSort it yourself.')
  })

  it('returns null when there is no fence', () => {
    expect(extractBui('just prose')).toBeNull()
  })

  it('returns null when the fenced JSON is invalid', () => {
    const text = '```bui\n{"v":1,"blocks":[{"type":"iframe"}]}\n```'
    expect(extractBui(text)).toBeNull()
  })

  it('returns null when the fenced JSON is malformed', () => {
    const text = '```bui\n{not json}\n```'
    expect(extractBui(text)).toBeNull()
  })
})
