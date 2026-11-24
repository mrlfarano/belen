import { describe, expect, it } from 'vitest'
import {
  barGeometry,
  chartSummary,
  formatTick,
  formatValue,
  lineGeometry,
  niceScale,
  pieGeometry,
  plotArea,
  type ChartSpec,
} from './chart'
import { parseBui } from './schema'

/** Builds a valid chart spec through the schema so tests stay honest. */
function make(over: Record<string, unknown> = {}): ChartSpec {
  const parsed = parseBui({
    v: 1,
    blocks: [
      {
        type: 'chart',
        chart: 'bar',
        categories: ['a', 'b', 'c'],
        series: [{ name: 's', points: [1, 2, 3] }],
        ...over,
      },
    ],
  })
  if (!parsed) throw new Error('test chart did not validate')
  return parsed.blocks[0] as ChartSpec
}

describe('niceScale', () => {
  it('covers the data with rounded ticks', () => {
    const scale = niceScale(0.35, 2.4)
    expect(scale.min).toBeLessThanOrEqual(0.35)
    expect(scale.max).toBeGreaterThanOrEqual(2.4)
    expect(scale.ticks[0]).toBe(scale.min)
    expect(scale.ticks[scale.ticks.length - 1]).toBe(scale.max)
    expect(scale.ticks.length).toBeGreaterThanOrEqual(3)
  })

  it('never degenerates on constant data', () => {
    const scale = niceScale(3, 3)
    expect(scale.min).toBeLessThan(3)
    expect(scale.max).toBeGreaterThan(3)
    expect(scale.ticks.length).toBeGreaterThan(1)
  })

  it('never degenerates on all-zero data', () => {
    const scale = niceScale(0, 0)
    expect(scale.min).toBeLessThan(0)
    expect(scale.max).toBeGreaterThan(0)
  })
})

describe('formatting', () => {
  it('compacts ticks', () => {
    expect(formatTick(0)).toBe('0')
    expect(formatTick(2.4)).toBe('2.4')
    expect(formatTick(1000)).toBe('1k')
    expect(formatTick(2400000)).toBe('2.4M')
  })

  it('formats values with an optional unit', () => {
    expect(formatValue(0.35)).toBe('0.35')
    expect(formatValue(0.35, 'USD')).toBe('0.35 USD')
    expect(formatValue(2.4)).toBe('2.4')
    expect(formatValue(128000)).toBe('128k')
  })
})

describe('barGeometry', () => {
  it('draws one rect per series point on a zero baseline', () => {
    const geo = barGeometry(make())
    expect(geo.rects).toHaveLength(3)
    expect(geo.baseline).toBeCloseTo(plotArea().y + plotArea().h, 5)
  })

  it('taller values sit higher on screen', () => {
    const geo = barGeometry(make())
    const low = geo.rects.find((r) => r.category === 0)! // value 1
    const high = geo.rects.find((r) => r.category === 2)! // value 3
    expect(high.y).toBeLessThan(low.y)
    expect(high.h).toBeGreaterThan(low.h)
  })

  it('groups multi-series bars without overlap', () => {
    const spec = make({
      series: [
        { name: 'a', points: [2, 1, 3] },
        { name: 'b', points: [1, 2, 1] },
      ],
    })
    const geo = barGeometry(spec)
    expect(geo.rects).toHaveLength(6)
    for (let c = 0; c < 3; c++) {
      const group = geo.rects.filter((r) => r.category === c)
      expect(group[0].x + group[0].w).toBeLessThanOrEqual(group[1].x + 0.001)
    }
  })

  it('lets negative bars grow below the baseline', () => {
    const spec = make({ series: [{ name: 's', points: [-2, 1, 3] }] })
    const geo = barGeometry(spec)
    const negative = geo.rects.find((r) => r.category === 0)!
    expect(negative.y).toBeCloseTo(geo.baseline, 5)
    expect(negative.y + negative.h).toBeGreaterThan(geo.baseline)
  })
})

describe('lineGeometry', () => {
  it('spreads points across the plot with the last on the right edge', () => {
    const geo = lineGeometry(make({ chart: 'line' }))
    expect(geo.catCenters[0]).toBeCloseTo(plotArea().x, 5)
    expect(geo.catCenters[2]).toBeCloseTo(plotArea().x + plotArea().w, 5)
  })

  it('centres a single category', () => {
    const geo = lineGeometry(make({ chart: 'line', categories: ['only'], series: [{ name: 's', points: [2] }] }))
    expect(geo.catCenters[0]).toBeCloseTo(plotArea().x + plotArea().w / 2, 5)
  })

  it('closes the area path down to the baseline', () => {
    const geo = lineGeometry(make({ chart: 'area' }))
    const path = geo.lines[0].areaPath
    expect(path).toMatch(/Z$/)
    expect(path).toContain(`${geo.baseline}`)
  })

  it('higher values map to smaller screen y', () => {
    const geo = lineGeometry(make({ chart: 'line' }))
    const points = geo.lines[0].points
    expect(points[2].y).toBeLessThan(points[0].y)
  })
})

describe('pieGeometry', () => {
  it('splits shares that sum to one', () => {
    const geo = pieGeometry(make({ chart: 'pie' }))
    const total = geo.arcs.reduce((sum, arc) => sum + arc.share, 0)
    expect(total).toBeCloseTo(1, 6)
  })

  it('draws a single slice as a full circle', () => {
    const geo = pieGeometry(make({ chart: 'pie', series: [{ name: 's', points: [0, 5, 0] }] }))
    expect(geo.arcs).toHaveLength(1)
    expect(geo.arcs[0].share).toBeCloseTo(1, 6)
    expect(geo.arcs[0].path).toMatch(/^M .+ a /)
    expect(geo.arcs[0].path).not.toContain('A ')
  })

  it('clamps negative values to zero instead of corrupting the circle', () => {
    const geo = pieGeometry(make({ chart: 'donut', series: [{ name: 's', points: [-3, 1, 0] }] }))
    expect(geo.arcs).toHaveLength(1)
    expect(geo.arcs[0].share).toBeCloseTo(1, 6)
  })

  it('renders nothing for an all-zero series', () => {
    const geo = pieGeometry(make({ chart: 'pie', series: [{ name: 's', points: [0, 0, 0] }] }))
    expect(geo.arcs).toHaveLength(0)
  })
})

describe('chartSummary', () => {
  it('speaks the data, not the pixels', () => {
    const summary = chartSummary(
      make({ title: 'Price per 1M', unit: 'USD', series: [{ name: 'Price', points: [2.4, 0.9, 0.35] }] }),
    )
    expect(summary).toContain('Price per 1M')
    expect(summary).toContain('a: 2.4 USD')
    expect(summary).toContain('c: 0.35 USD')
  })

  it('stays bounded for long series', () => {
    const categories = Array.from({ length: 30 }, (_, i) => `c${i}`)
    const points = categories.map((_, i) => i)
    const summary = chartSummary(make({ chart: 'line', categories, series: [{ name: 's', points }] }))
    expect(summary).toContain('30 points')
    expect(summary.length).toBeLessThan(200)
  })
})
