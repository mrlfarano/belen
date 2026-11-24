import { describe, expect, it } from 'vitest'
import { parseBui } from './schema'

describe('BUI schema', () => {
  it('accepts a table payload', () => {
    const payload = {
      v: 1,
      blocks: [
        { type: 'text', text: 'Here is the comparison.' },
        {
          type: 'table',
          columns: ['Model', 'Context'],
          rows: [['Aurelia 3', '1M']],
        },
      ],
    }

    const parsed = parseBui(payload)
    expect(parsed).not.toBeNull()
    expect(parsed!.blocks).toHaveLength(2)
  })

  it('rejects an unknown component', () => {
    expect(parseBui({ v: 1, blocks: [{ type: 'iframe', src: 'x' }] })).toBeNull()
  })

  it('rejects the wrong version', () => {
    expect(parseBui({ v: 2, blocks: [{ type: 'text', text: 'x' }] })).toBeNull()
  })

  it('rejects more than 64 blocks', () => {
    const blocks = Array.from({ length: 65 }, () => ({ type: 'text', text: 'x' }))
    expect(parseBui({ v: 1, blocks })).toBeNull()
  })

  it('rejects more than 200 table rows', () => {
    const rows = Array.from({ length: 201 }, () => ['a'])
    expect(
      parseBui({ v: 1, blocks: [{ type: 'table', columns: ['c'], rows }] }),
    ).toBeNull()
  })

  it('returns null for garbage so the caller can fall back to text', () => {
    expect(parseBui(null)).toBeNull()
    expect(parseBui('<html>')).toBeNull()
    expect(parseBui({})).toBeNull()
  })

  it('accepts a chart payload', () => {
    const payload = {
      v: 1,
      blocks: [
        {
          type: 'chart',
          chart: 'bar',
          title: 'Price per 1M',
          unit: 'USD',
          categories: ['Aurelia 3', 'Kestrel 2', 'Lantern 1.5'],
          series: [{ name: 'Price', points: [2.4, 0.9, 0.35] }],
        },
      ],
    }

    const parsed = parseBui(payload)
    expect(parsed).not.toBeNull()
    expect(parsed!.blocks[0].type).toBe('chart')
  })

  it('accepts every chart kind', () => {
    for (const chart of ['bar', 'line', 'area', 'pie', 'donut']) {
      const parsed = parseBui({
        v: 1,
        blocks: [
          { type: 'chart', chart, categories: ['a'], series: [{ name: 's', points: [1] }] },
        ],
      })
      expect(parsed).not.toBeNull()
    }
  })

  it('rejects an unknown chart kind', () => {
    expect(
      parseBui({
        v: 1,
        blocks: [
          { type: 'chart', chart: 'scatter', categories: ['a'], series: [{ name: 's', points: [1] }] },
        ],
      }),
    ).toBeNull()
  })

  it('rejects a series whose points do not match the categories', () => {
    expect(
      parseBui({
        v: 1,
        blocks: [
          {
            type: 'chart',
            chart: 'bar',
            categories: ['a', 'b', 'c'],
            series: [{ name: 's', points: [1, 2] }],
          },
        ],
      }),
    ).toBeNull()
  })

  it('rejects non-finite points', () => {
    expect(
      parseBui({
        v: 1,
        blocks: [
          {
            type: 'chart',
            chart: 'line',
            categories: ['a', 'b'],
            series: [{ name: 's', points: [1, Infinity] }],
          },
        ],
      }),
    ).toBeNull()
  })

  it('rejects more than 60 categories', () => {
    const categories = Array.from({ length: 61 }, (_, i) => `c${i}`)
    expect(
      parseBui({
        v: 1,
        blocks: [
          { type: 'chart', chart: 'bar', categories, series: [{ name: 's', points: categories.map(() => 1) }] },
        ],
      }),
    ).toBeNull()
  })
})
