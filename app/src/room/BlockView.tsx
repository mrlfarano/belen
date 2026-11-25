import { createSignal, Show } from 'solid-js'
import type { Block } from './types'
import BuiRenderer from '../bui/Renderer'
import BuiStreamView from '../bui/BuiStreamView'
import { parseBui } from '../bui/schema'

export default function BlockView(props: {
  block: Block
  active: boolean
  onPin: (id: string) => void
  onFork: (id: string) => void
  onCancel?: (id: string) => void
}) {
  const b = () => props.block
  const payload = () => (b().component ? parseBui(b().component) : null)

  return (
    <article
      class="block"
      classList={{
        'block-user': b().kind === 'user',
        'block-assistant': b().kind === 'assistant' || b().kind === 'text',
        'block-artifact': b().kind === 'artifact',
        pinned: !!b().pinned,
        active: props.active,
      }}
    >
      <Show when={b().kind === 'user'}>
        <p class="user-line">{b().text}</p>
      </Show>

      <Show when={b().kind === 'assistant' || b().kind === 'text'}>
        <p class="body">
          {b().text}
          <Show when={props.active}>
            <span class="inline-caret" aria-hidden="true" />
          </Show>
        </p>
        <div class="block-actions">
          <button class="block-action" onClick={() => props.onPin(b().id)}>
            {b().pinned ? 'Pinned' : 'Pin'}
          </button>
          <button class="block-action" onClick={() => props.onFork(b().id)}>
            Fork
          </button>
          <Show when={b().forkOf}>
            <span class="fork-mark">↳ forked</span>
          </Show>
        </div>
      </Show>

      <Show when={b().kind === 'artifact'}>
        <Show
          when={payload()}
          fallback={
            <Show
              when={b().text}
              fallback={<p class="body dim">Unsupported component</p>}
            >
              <BuiStreamView
                text={b().text!}
                pinned={!!b().pinned}
                onTogglePin={() => props.onPin(b().id)}
              />
            </Show>
          }
        >
          {(valid) => (
            <BuiRenderer
              payload={valid()}
              pinned={!!b().pinned}
              onTogglePin={() => props.onPin(b().id)}
            />
          )}
        </Show>
      </Show>

      <Show when={b().kind === 'tool'}>
        <ToolView block={b()} />
      </Show>

      <Show when={b().kind === 'worker'}>
        <WorkerView block={b()} onCancel={props.onCancel} />
      </Show>

      <Show when={b().kind === 'system'}>
        <p class="system-line">{b().text}</p>
      </Show>
    </article>
  )
}

/** Read-only tool activity: label, status, and a bounded result preview. */
function ToolView(props: { block: Block }) {
  const [open, setOpen] = createSignal(props.block.meta?.status === 'running')

  return (
    <details
      class="tool-block"
      open={open()}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary class="worker tool-summary">
        <span
          class="pulse tool-glyph"
          classList={{
            ok: props.block.meta?.status === 'ok',
            denied: props.block.meta?.status === 'denied',
            error: props.block.meta?.status === 'error',
          }}
        />
        <span class="worker-label">{props.block.meta?.label || 'tool'}</span>
        <span class="worker-state">{props.block.meta?.status ?? 'queued'}</span>
        <Show when={props.block.meta?.ms}>
          <span class="fork-mark">{props.block.meta?.ms}</span>
        </Show>
      </summary>
      <Show when={props.block.meta?.output}>
        <p class="body worker-output tool-output">{props.block.meta?.output}</p>
      </Show>
    </details>
  )
}

function WorkerView(props: { block: Block; onCancel?: (id: string) => void }) {
  const [open, setOpen] = createSignal(
    props.block.meta?.status === 'running' || !!props.block.meta?.output,
  )

  return (
    <details
      class="worker-block"
      open={open()}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary class="worker">
        <span class="pulse" />
        <span class="worker-label">{props.block.text || 'Worker'}</span>
        <span class="worker-state">{props.block.meta?.status ?? 'running'}</span>
        <Show when={props.block.meta?.status === 'running' && props.onCancel}>
          <button
            class="worker-stop"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              props.onCancel?.(props.block.id)
            }}
          >
            Stop
          </button>
        </Show>
      </summary>
      <p class="body worker-output">{props.block.meta?.output ?? ''}</p>
    </details>
  )
}
