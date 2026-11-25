import { describe, expect, it } from 'vitest'
import { progressLabel } from './update'

const MB = 1024 * 1024

describe('update progress label', () => {
  it('shows a percentage when the size is known', () => {
    expect(progressLabel({ received: 2.5 * MB, total: 10 * MB })).toBe('Downloading 25%')
  })

  it('clamps above 100%', () => {
    expect(progressLabel({ received: 11 * MB, total: 10 * MB })).toBe('Downloading 100%')
  })

  it('falls back to megabytes when the size is unknown', () => {
    expect(progressLabel({ received: 3.2 * MB, total: null })).toBe('Downloading 3.2 MB')
  })

  it('shows zero before the first byte', () => {
    expect(progressLabel({ received: 0, total: 0 })).toBe('Downloading 0.0 MB')
    expect(progressLabel({ received: 0, total: 10 * MB })).toBe('Downloading 0%')
  })
})
