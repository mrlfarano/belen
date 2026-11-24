import { describe, expect, it } from 'vitest'
import { parseBuiPartial } from './partial'

const full = JSON.stringify({
  v: 1,
  blocks: [
    { type: 'text', text: 'hello' },
    { type: 'table', columns: ['a'], rows: [['1']] },
  ],
})

describe('partial BUI parser', () => {
  it('parses a complete payload', () => {
    const result = parseBuiPartial(full)
    expect(result.complete).toBe(true)
    expect(result.blocks).toHaveLength(2)
  })

  it('keeps complete blocks when the stream is cut mid-second-block', () => {
    const cut = full.slice(0, full.indexOf('"columns"'))
    const result = parseBuiPartial(cut)
    expect(result.complete).toBe(false)
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0].type).toBe('text')
  })

  it('returns no blocks when cut inside the first block', () => {
    const result = parseBuiPartial('{"v":1,"blocks":[{"type":"text","te')
    expect(result.complete).toBe(false)
    expect(result.blocks).toHaveLength(0)
  })

  it('parses a fenced payload surrounded by prose', () => {
    const result = parseBuiPartial(`Here is the table.\n\`\`\`bui\n${full}\n\`\`\``)
    expect(result.complete).toBe(true)
    expect(result.blocks).toHaveLength(2)
  })

  it('is incomplete when the blocks array closes but the root does not', () => {
    const result = parseBuiPartial('{"v":1,"blocks":[{"type":"text","text":"hi"}]')
    expect(result.complete).toBe(false)
    expect(result.blocks).toHaveLength(1)
  })

  it('reports no start for garbage', () => {
    expect(parseBuiPartial('').started).toBe(false)
    expect(parseBuiPartial('hello').started).toBe(false)
  })

  it('renders a chart block as soon as it closes mid-stream', () => {
    const chart = JSON.stringify({
      v: 1,
      blocks: [
        { type: 'text', text: 'Prices are falling.' },
        {
          type: 'chart',
          chart: 'bar',
          categories: ['a', 'b'],
          series: [{ name: 's', points: [2, 1] }],
        },
      ],
    })

    const cut = chart.slice(0, chart.indexOf('"points"'))
    const result = parseBuiPartial(cut)
    expect(result.complete).toBe(false)
    expect(result.blocks).toHaveLength(1)

    const done = parseBuiPartial(chart)
    expect(done.complete).toBe(true)
    expect(done.blocks[1].type).toBe('chart')
  })
})
