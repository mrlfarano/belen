import { z } from 'zod'

export const BUI_VERSION = 1

const TextBlock = z.object({
  type: z.literal('text'),
  text: z.string().max(20_000),
})

const TableBlock = z.object({
  type: z.literal('table'),
  columns: z.array(z.string().max(80)).min(1).max(12),
  rows: z.array(z.array(z.string().max(500)).max(12)).max(200),
  pin: z.boolean().optional(),
})

const CodeBlock = z.object({
  type: z.literal('code'),
  lang: z.string().max(24).optional(),
  text: z.string().max(20_000),
})

const MetricBlock = z.object({
  type: z.literal('metric'),
  label: z.string().max(80),
  value: z.string().max(80),
  hint: z.string().max(120).optional(),
})

const FormBlock = z.object({
  type: z.literal('form'),
  fields: z
    .array(
      z.object({
        name: z.string().max(64),
        label: z.string().max(80),
        kind: z.enum(['text', 'number', 'select']).default('text'),
        options: z.array(z.string().max(80)).max(20).optional(),
      }),
    )
    .min(1)
    .max(12),
})

const TimelineBlock = z.object({
  type: z.literal('timeline'),
  items: z
    .array(
      z.object({
        label: z.string().max(120),
        detail: z.string().max(300).optional(),
      }),
    )
    .min(1)
    .max(50),
})

const WorkerBlock = z.object({
  type: z.literal('worker'),
  label: z.string().max(80),
  status: z.enum(['running', 'done', 'error']).default('running'),
})

const ChartSeries = z.object({
  name: z.string().max(80),
  points: z.array(z.number()).min(1).max(60),
})

const ChartBlock = z
  .object({
    type: z.literal('chart'),
    chart: z.enum(['bar', 'line', 'area', 'pie', 'donut']),
    title: z.string().max(120).optional(),
    unit: z.string().max(12).optional(),
    categories: z.array(z.string().max(80)).min(1).max(60),
    series: z.array(ChartSeries).min(1).max(8),
    pin: z.boolean().optional(),
  })
  .superRefine((block, ctx) => {
    for (const [i, series] of block.series.entries()) {
      if (series.points.length !== block.categories.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['series', i, 'points'],
          message: `must hold exactly ${block.categories.length} points, one per category`,
        })
      }
      for (const [j, value] of series.points.entries()) {
        if (!Number.isFinite(value)) {
          ctx.addIssue({
            code: 'custom',
            path: ['series', i, 'points', j],
            message: 'must be a finite number',
          })
        }
      }
    }
  })

export const BuiBlockSchema = z.discriminatedUnion('type', [
  TextBlock,
  TableBlock,
  CodeBlock,
  MetricBlock,
  FormBlock,
  TimelineBlock,
  WorkerBlock,
  ChartBlock,
])

export const BuiPayloadSchema = z.object({
  v: z.literal(BUI_VERSION),
  blocks: z.array(BuiBlockSchema).min(1).max(64),
})

export type BuiBlock = z.infer<typeof BuiBlockSchema>
export type BuiPayload = z.infer<typeof BuiPayloadSchema>

/** Returns the payload when valid, otherwise null so the caller can fall back to text. */
export function parseBui(input: unknown): BuiPayload | null {
  const result = BuiPayloadSchema.safeParse(input)
  return result.success ? result.data : null
}
