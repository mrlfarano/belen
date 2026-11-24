import type { BuiBlock } from './schema'

/**
 * Pure chart geometry. The renderer stays thin; everything here is
 * deterministic, allocation-light and unit-testable. No dependencies.
 */

export type ChartSpec = Extract<BuiBlock, { type: 'chart' }>

/** Full-canvas viewBox for axis charts (bar / line / area). */
export const VIEW_W = 640
export const VIEW_H = 300

const MARGIN = { top: 14, right: 14, bottom: 42, left: 64 }

export type Rect = { x: number; y: number; w: number; h: number }

export function plotArea(): Rect {
  return {
    x: MARGIN.left,
    y: MARGIN.top,
    w: VIEW_W - MARGIN.left - MARGIN.right,
    h: VIEW_H - MARGIN.top - MARGIN.bottom,
  }
}

/** Square viewBox for pie / donut. */
export const PIE_W = 300
export const PIE_H = 300

/* ---------- scales ---------- */

const round10 = (v: number) => Math.round(v * 1e10) / 1e10

function niceNum(range: number, round: boolean): number {
  if (!Number.isFinite(range) || range <= 0) return 1
  const exponent = Math.floor(Math.log10(range))
  const frac = range / Math.pow(10, exponent)
  let nice: number
  if (round) nice = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10
  else nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10
  return nice * Math.pow(10, exponent)
}

export type Scale = { min: number; max: number; ticks: number[] }

/** A readable axis: rounded bounds, 3–5 ticks, never degenerate. */
export function niceScale(min: number, max: number, ticksWanted = 4): Scale {
  if (min > max) [min, max] = [max, min]
  if (min === max) {
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.5 : 1
    min -= pad
    max += pad
  }
  const range = niceNum(max - min, false)
  const step = niceNum(range / Math.max(1, ticksWanted - 1), true)
  const lo = Math.floor(min / step) * step
  const hi = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(round10(v))
  return { min: round10(lo), max: round10(hi), ticks }
}

/* ---------- formatting ---------- */

const trim = (n: number) => {
  if (!Number.isFinite(n)) return '–'
  const s = n.toFixed(2).replace(/\.?0+$/, '')
  return s === '-0' ? '0' : s
}

/** Compact axis label: 1k, 2.4M; small numbers stay raw. */
export function formatTick(v: number): string {
  if (v === 0) return '0'
  const abs = Math.abs(v)
  if (abs >= 1e6) return `${trim(v / 1e6)}M`
  if (abs >= 1e3) return `${trim(v / 1e3)}k`
  return trim(v)
}

/** Full value label with optional unit suffix, used on bars and in legends. */
export function formatValue(v: number, unit?: string): string {
  const abs = Math.abs(v)
  const body = abs >= 1e6 ? `${trim(v / 1e6)}M` : abs >= 1e4 ? `${trim(v / 1e3)}k` : trim(v)
  return unit ? `${body} ${unit}` : body
}

/* ---------- bar ---------- */

export type BarRect = {
  x: number
  y: number
  w: number
  h: number
  series: number
  category: number
  label: string
}

export type BarGeometry = {
  rects: BarRect[]
  scale: Scale
  catCenters: number[]
  baseline: number
}

/** Grouped bars on an honest zero baseline. */
export function barGeometry(spec: ChartSpec, area: Rect = plotArea()): BarGeometry {
  const values = spec.series.flatMap((s) => s.points)
  const scale = niceScale(Math.min(0, ...values), Math.max(0, ...values))
  const span = scale.max - scale.min
  const toY = (v: number) => area.y + area.h - ((v - scale.min) / span) * area.h
  const baseline = toY(0)

  const n = spec.categories.length
  const group = area.w / n
  const count = spec.series.length
  const barW = Math.max(2, (group * 0.62) / count)

  const rects: BarRect[] = []
  const catCenters: number[] = []

  for (let c = 0; c < n; c++) {
    const center = area.x + group * c + group / 2
    catCenters.push(center)
    const rowStart = center - (barW * count) / 2
    for (let s = 0; s < count; s++) {
      const value = spec.series[s].points[c]
      const yv = toY(value)
      const rect: BarRect = {
        x: rowStart + barW * s,
        y: Math.min(yv, baseline),
        w: barW,
        h: Math.abs(baseline - yv),
        series: s,
        category: c,
        label: formatValue(value, spec.unit),
      }
      rects.push(rect)
    }
  }

  return { rects, scale, catCenters, baseline }
}

/* ---------- line / area ---------- */

export type LinePoint = { x: number; y: number; value: number }

export type LineGeometry = {
  lines: { series: number; points: LinePoint[]; path: string; areaPath: string }[]
  scale: Scale
  catCenters: number[]
  baseline: number
}

function linePath(points: LinePoint[]): string {
  if (points.length === 0) return ''
  if (points.length === 1) {
    const p = points[0]
    return `M ${p.x} ${p.y} l 0.01 0`
  }
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
}

/** One polyline per series; areaPath closes down to the zero baseline. */
export function lineGeometry(spec: ChartSpec, area: Rect = plotArea()): LineGeometry {
  const values = spec.series.flatMap((s) => s.points)
  const includeZero = spec.chart === 'area'
  const lo = includeZero ? Math.min(0, ...values) : Math.min(...values)
  const scale = niceScale(lo, Math.max(...values))
  const span = scale.max - scale.min
  const toY = (v: number) => area.y + area.h - ((v - scale.min) / span) * area.h
  const baseline = toY(0)

  const n = spec.categories.length
  const catCenters: number[] = []
  for (let c = 0; c < n; c++) {
    catCenters.push(n > 1 ? area.x + (area.w * c) / (n - 1) : area.x + area.w / 2)
  }

  const lines = spec.series.map((series, s) => {
    const points = series.points.map((value, c) => ({
      x: catCenters[c],
      y: toY(value),
      value,
    }))
    const path = linePath(points)
    const first = points[0]
    const last = points[points.length - 1]
    const areaPath =
      points.length > 1
        ? `${path} L ${last.x} ${baseline} L ${first.x} ${baseline} Z`
        : path
    return { series: s, points, path, areaPath }
  })

  return { lines, scale, catCenters, baseline }
}

/* ---------- pie / donut ---------- */

export type PieArc = {
  path: string
  share: number
  label: string
  category: number
}

export type PieGeometry = {
  arcs: PieArc[]
  cx: number
  cy: number
  r: number
  ir: number
}

function arcPoint(cx: number, cy: number, r: number, angle: number) {
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) }
}

/**
 * Pie and donut from the first series. Negative values are clamped to zero —
 * a negative wedge is meaningless and must not corrupt the circle.
 */
export function pieGeometry(spec: ChartSpec): PieGeometry {
  const cx = PIE_W / 2
  const cy = PIE_H / 2
  const r = 112
  const ir = spec.chart === 'donut' ? 70 : 0

  const points = spec.series[0].points.map((v) => Math.max(0, v))
  const total = points.reduce((a, b) => a + b, 0)

  if (total <= 0) return { arcs: [], cx, cy, r, ir }

  const arcs: PieArc[] = []
  let angle = -Math.PI / 2

  points.forEach((value, category) => {
    const sweep = (value / total) * Math.PI * 2
    if (sweep <= 0) return
    const start = angle
    const end = angle + sweep
    const large = sweep > Math.PI ? 1 : 0
    let path: string

    if (sweep >= Math.PI * 2 - 1e-6) {
      // A full circle: the arc command cannot express 360°, so draw it directly.
      if (ir > 0) {
        path =
          `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 Z ` +
          `M ${cx - ir} ${cy} a ${ir} ${ir} 0 1 0 ${2 * ir} 0 a ${ir} ${ir} 0 1 0 ${-2 * ir} 0 Z`
      } else {
        path = `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 Z`
      }
    } else if (ir > 0) {
      const p1 = arcPoint(cx, cy, r, start)
      const p2 = arcPoint(cx, cy, r, end)
      const p3 = arcPoint(cx, cy, ir, end)
      const p4 = arcPoint(cx, cy, ir, start)
      path =
        `M ${p1.x} ${p1.y} A ${r} ${r} 0 ${large} 1 ${p2.x} ${p2.y} ` +
        `L ${p3.x} ${p3.y} A ${ir} ${ir} 0 ${large} 0 ${p4.x} ${p4.y} Z`
    } else {
      const p1 = arcPoint(cx, cy, r, start)
      const p2 = arcPoint(cx, cy, r, end)
      path = `M ${cx} ${cy} L ${p1.x} ${p1.y} A ${r} ${r} 0 ${large} 1 ${p2.x} ${p2.y} Z`
    }

    arcs.push({
      path,
      share: value / total,
      label: formatValue(value, spec.unit),
      category,
    })
    angle = end
  })

  return { arcs, cx, cy, r, ir }
}

/* ---------- accessibility ---------- */

/** Spoken chart: the data, not the pixels. Bounded so long series stay usable. */
export function chartSummary(spec: ChartSpec): string {
  const head = spec.title ? `${spec.title}. ` : `${spec.chart} chart. `
  const total = spec.series.reduce((n, s) => n + s.points.length, 0)

  if (total > 24) {
    const parts = spec.series.map((s) => {
      const min = Math.min(...s.points)
      const max = Math.max(...s.points)
      return `${s.name}: ${s.points.length} points from ${formatValue(min, spec.unit)} to ${formatValue(max, spec.unit)}`
    })
    return head + parts.join('; ')
  }

  const parts = spec.series.map((s) => {
    const pairs = s.points
      .map((v, i) => `${spec.categories[i] ?? i}: ${formatValue(v, spec.unit)}`)
      .join(', ')
    return `${s.name} — ${pairs}`
  })
  return head + parts.join('; ')
}
