import { describe, expect, it } from 'vitest'
import { clockLine } from './clock'

// Constructed from local-time components, so the expectations hold in any
// time zone the suite happens to run in.
const sample = new Date(2026, 10, 25, 9, 5)

describe('clockLine', () => {
  it('names the weekday, date and year', () => {
    // 25 November 2026 is a Wednesday.
    expect(clockLine(sample)).toContain('Today is Wednesday, 25 November 2026.')
  })

  it('gives the local time zero-padded, with the zone offset', () => {
    const offset = -sample.getTimezoneOffset()
    const sign = offset >= 0 ? '+' : '-'
    const abs = Math.abs(offset)
    const zone = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
    expect(clockLine(sample)).toContain(`computer is 09:05 (${zone}).`)
  })

  it('keeps midnight and single-digit fields apart', () => {
    expect(clockLine(new Date(2026, 0, 2, 0, 0))).toMatch(/computer is 00:00 \(UTC[+-]\d{2}:\d{2}\)\.$/)
  })

  it('describes the present moment when given no date', () => {
    expect(clockLine()).toMatch(
      /^Today is \w+, \d{1,2} \w+ \d{4}\. The local time on the user's computer is \d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)\.$/,
    )
  })
})
