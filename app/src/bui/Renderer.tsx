import { createMemo, createSignal, For, Show } from 'solid-js'
import type { BuiBlock, BuiPayload } from './schema'
import {
  barGeometry,
  chartSummary,
  formatTick,
  formatValue,
  lineGeometry,
  pieGeometry,
  PIE_H,
  PIE_W,
  plotArea,
  VIEW_H,
  VIEW_W,
} from './chart'

export default function BuiRenderer(props: {
  payload: BuiPayload
  pinned?: boolean
  onTogglePin?: () => void
}) {
  return (
    <div class="bui">
      <For each={props.payload.blocks}>
        {(block) => (
          <BuiBlockView
            block={block}
            pinned={props.pinned}
            onTogglePin={props.onTogglePin}
          />
        )}
      </For>
    </div>
  )
}

function BuiBlockView(props: {
  block: BuiBlock
  pinned?: boolean
  onTogglePin?: () => void
}) {
  switch (props.block.type) {
    case 'text':
      return <p class="body">{props.block.text}</p>
    case 'table':
      return (
        <TableView
          block={props.block}
          pinned={props.pinned}
          onTogglePin={props.onTogglePin}
        />
      )
    case 'code':
      return <CodeView block={props.block} />
    case 'metric':
      return <MetricView block={props.block} />
    case 'form':
      return <FormView block={props.block} />
    case 'timeline':
      return <TimelineView block={props.block} />
    case 'worker':
      return <WorkerView block={props.block} />
    case 'chart':
      return (
        <ChartView
          block={props.block}
          pinned={props.pinned}
          onTogglePin={props.onTogglePin}
        />
      )
  }
}

function TableView(props: {
  block: Extract<BuiBlock, { type: 'table' }>
  pinned?: boolean
  onTogglePin?: () => void
}) {
  const [sort, setSort] = createSignal<number | null>(null)
  const [dir, setDir] = createSignal<1 | -1>(1)

  const rows = () => {
    const index = sort()
    if (index === null) return props.block.rows
    return [...props.block.rows].sort(
      (a, b) => (a[index] ?? '').localeCompare(b[index] ?? '') * dir(),
    )
  }

  const toggle = (index: number) => {
    if (sort() === index) {
      setDir((d) => (d === 1 ? -1 : 1))
    } else {
      setSort(index)
      setDir(1)
    }
  }

  return (
    <div class="artifact-wrap">
      <table class="artifact" aria-label="Table">
        <thead>
          <tr>
            <For each={props.block.columns}>
              {(column, index) => (
                <th>
                  <button
                    class="th-button"
                    classList={{ sorted: sort() === index() }}
                    onClick={() => toggle(index())}
                  >
                    {column}
                    <Show when={sort() === index()}>
                      <span class="sort-mark">{dir() === 1 ? '▲' : '▼'}</span>
                    </Show>
                  </button>
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={rows()}>
            {(row) => (
              <tr>
                <For each={row}>{(cell) => <td>{cell}</td>}</For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <div class="artifact-foot">
        <span>Declarative component · v1</span>
        <Show
          when={props.onTogglePin}
          fallback={
            <Show when={props.block.pin}>
              <span class="pin active">Pinned</span>
            </Show>
          }
        >
          <button
            class="pin"
            classList={{ active: props.pinned }}
            onClick={() => props.onTogglePin?.()}
          >
            {props.pinned ? 'Pinned' : 'Pin'}
          </button>
        </Show>
      </div>
    </div>
  )
}

function CodeView(props: { block: Extract<BuiBlock, { type: 'code' }> }) {
  return (
    <pre class="code-block">
      <code>{props.block.text}</code>
    </pre>
  )
}

function MetricView(props: { block: Extract<BuiBlock, { type: 'metric' }> }) {
  return (
    <div class="metric">
      <span class="metric-label">{props.block.label}</span>
      <span class="metric-value">{props.block.value}</span>
      <Show when={props.block.hint}>
        <span class="metric-hint">{props.block.hint}</span>
      </Show>
    </div>
  )
}

function FormView(props: { block: Extract<BuiBlock, { type: 'form' }> }) {
  return (
    <form class="bui-form" onSubmit={(e) => e.preventDefault()}>
      <For each={props.block.fields}>
        {(field) => (
          <label class="field">
            <span class="field-label">{field.label}</span>
            <Show
              when={field.kind === 'select'}
              fallback={
                <input
                  class="field-input"
                  type={field.kind === 'number' ? 'number' : 'text'}
                  name={field.name}
                />
              }
            >
              <select class="field-input" name={field.name}>
                <For each={field.options ?? []}>{(option) => <option>{option}</option>}</For>
              </select>
            </Show>
          </label>
        )}
      </For>
      <button class="block-action" type="submit">
        Submit
      </button>
    </form>
  )
}

function TimelineView(props: { block: Extract<BuiBlock, { type: 'timeline' }> }) {
  return (
    <ol class="timeline">
      <For each={props.block.items}>
        {(item) => (
          <li class="timeline-item">
            <span class="timeline-dot" />
            <div>
              <span class="timeline-label">{item.label}</span>
              <Show when={item.detail}>
                <span class="timeline-detail">{item.detail}</span>
              </Show>
            </div>
          </li>
        )}
      </For>
    </ol>
  )
}

function WorkerView(props: { block: Extract<BuiBlock, { type: 'worker' }> }) {
  return (
    <div class="worker">
      <span class="pulse" />
      <span class="worker-label">{props.block.label}</span>
      <span class="worker-state">{props.block.status}</span>
    </div>
  )
}

/* ---------- chart ---------- */

type ChartBlock = Extract<BuiBlock, { type: 'chart' }>

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

function ChartView(props: {
  block: ChartBlock
  pinned?: boolean
  onTogglePin?: () => void
}) {
  const spec = () => props.block
  const round = () => spec().chart === 'pie' || spec().chart === 'donut'
  const bar = createMemo(() => barGeometry(spec()))
  const line = createMemo(() => lineGeometry(spec()))
  const pie = createMemo(() => pieGeometry(spec()))
  const area = plotArea()

  const frame = () => (spec().chart === 'bar' ? bar() : line())
  const toY = (value: number, min: number, max: number) =>
    area.y + area.h - ((value - min) / (max - min)) * area.h

  const catLabel = (text: string) =>
    clip(text, spec().categories.length > 8 ? 9 : 14)

  const valueLabels = () =>
    spec().series.length === 1 && spec().categories.length <= 12

  return (
    <figure class="chart">
      <Show when={spec().title}>
        <figcaption class="chart-title">{spec().title}</figcaption>
      </Show>

      <Show
        when={round()}
        fallback={
          <svg
            class="chart-svg"
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            role="img"
            aria-label={chartSummary(spec())}
          >
            <For each={frame().scale.ticks}>
              {(tick) => {
                const y = toY(tick, frame().scale.min, frame().scale.max)
                return (
                  <g>
                    <line
                      class={tick === 0 ? 'axis' : 'grid'}
                      x1={area.x}
                      x2={area.x + area.w}
                      y1={y}
                      y2={y}
                    />
                    <text class="tick-label" x={area.x - 10} y={y + 3} text-anchor="end">
                      {formatTick(tick)}
                    </text>
                  </g>
                )
              }}
            </For>

            <For each={spec().categories}>
              {(_, index) => {
                const center = frame().catCenters[index()]
                return (
                  <text
                    class="cat-label"
                    x={center}
                    y={area.y + area.h + 26}
                    text-anchor="middle"
                  >
                    {catLabel(spec().categories[index()])}
                  </text>
                )
              }}
            </For>

            <Show
              when={spec().chart === 'bar'}
              fallback={
                <For each={line().lines}>
                  {(seriesLine) => (
                    <g>
                      <Show when={spec().chart === 'area'}>
                        <path class={`area cs-${seriesLine.series}`} d={seriesLine.areaPath} />
                      </Show>
                      <path class={`line cs-${seriesLine.series}`} d={seriesLine.path} />
                      <For each={seriesLine.points}>
                        {(point, index) => (
                          <circle class={`dot cs-${seriesLine.series}`} cx={point.x} cy={point.y} r="3">
                            <title>
                              {`${spec().categories[index()] ?? ''} — ${formatValue(point.value, spec().unit)}`}
                            </title>
                          </circle>
                        )}
                      </For>
                    </g>
                  )}
                </For>
              }
            >
              <For each={bar().rects}>
                {(rect) => (
                  <g>
                    <rect
                      class={`bar cs-${rect.series}`}
                      x={rect.x}
                      y={rect.y}
                      width={rect.w}
                      height={rect.h}
                      rx="1"
                    >
                      <title>{`${spec().categories[rect.category]} — ${rect.label}`}</title>
                    </rect>
                    <Show when={valueLabels()}>
                      <text
                        class="val-label"
                        x={rect.x + rect.w / 2}
                        y={rect.y < bar().baseline ? rect.y - 7 : rect.y + rect.h + 13}
                        text-anchor="middle"
                      >
                        {rect.label}
                      </text>
                    </Show>
                  </g>
                )}
              </For>
            </Show>
          </svg>
        }
      >
        <div class="chart-pie-row">
          <svg
            class="chart-svg chart-svg-pie"
            viewBox={`0 0 ${PIE_W} ${PIE_H}`}
            role="img"
            aria-label={chartSummary(spec())}
          >
            <For each={pie().arcs}>
              {(arc, index) => (
                <path class={`wedge cs-${index()}`} d={arc.path} fill-rule="evenodd">
                  <title>
                    {`${spec().categories[arc.category]} — ${arc.label} (${Math.round(arc.share * 100)}%)`}
                  </title>
                </path>
              )}
            </For>
            <Show when={pie().arcs.length === 0}>
              <circle class="wedge-empty" cx={pie().cx} cy={pie().cy} r={pie().r} />
            </Show>
            <Show when={spec().chart === 'donut' && spec().title}>
              <text class="donut-title" x={pie().cx} y={pie().cy - 6} text-anchor="middle">
                {clip(spec().title ?? '', 16)}
              </text>
            </Show>
          </svg>
          <ul class="chart-legend">
            <For each={pie().arcs}>
              {(arc, index) => (
                <li>
                  <span class={`chart-chip cs-${index()}`} />
                  <span class="legend-name">{spec().categories[arc.category]}</span>
                  <span class="legend-value">
                    {formatValue(spec().series[0].points[arc.category], spec().unit)}
                  </span>
                  <span class="legend-share">{Math.round(arc.share * 100)}%</span>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>

      <Show when={spec().series.length > 1 && !round()}>
        <ul class="chart-legend chart-legend-inline">
          <For each={spec().series}>
            {(series, index) => (
              <li>
                <span class={`chart-chip cs-${index()}`} />
                <span class="legend-name">{series.name}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <div class="artifact-foot">
        <span>Declarative component · v1</span>
        <Show
          when={props.onTogglePin}
          fallback={
            <Show when={props.block.pin}>
              <span class="pin active">Pinned</span>
            </Show>
          }
        >
          <button
            class="pin"
            classList={{ active: props.pinned }}
            onClick={() => props.onTogglePin?.()}
          >
            {props.pinned ? 'Pinned' : 'Pin'}
          </button>
        </Show>
      </div>
    </figure>
  )
}
