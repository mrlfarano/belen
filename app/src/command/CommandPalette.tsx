import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'

export type CommandId =
  | 'settings'
  | 'skills'
  | 'export-md'
  | 'export-json'
  | 'import-json'
  | 'new-room'
  | 'theme'

const COMMANDS: Array<{ id: CommandId; label: string; hint?: string }> = [
  { id: 'settings', label: 'Open settings', hint: 'provider' },
  { id: 'skills', label: 'Skills and sub-agents', hint: 'install' },
  { id: 'export-md', label: 'Export room as Markdown', hint: 'file' },
  { id: 'export-json', label: 'Export room as JSON', hint: 'file' },
  { id: 'import-json', label: 'Import room from JSON', hint: 'file' },
  { id: 'new-room', label: 'New room', hint: 'clear' },
  { id: 'theme', label: 'Toggle light / dark', hint: 'appearance' },
]

type Props = {
  onClose: () => void
  onCommand: (id: CommandId) => void
  onImport: (json: string) => void
}

export default function CommandPalette(props: Props) {
  const [query, setQuery] = createSignal('')
  const [index, setIndex] = createSignal(0)
  let input: HTMLInputElement | undefined
  let file: HTMLInputElement | undefined

  const filtered = () => {
    const q = query().trim().toLowerCase()
    if (!q) return COMMANDS
    return COMMANDS.filter(
      (c) => c.label.toLowerCase().includes(q) || (c.hint ?? '').includes(q),
    )
  }

  const run = (id: CommandId) => {
    if (id === 'import-json') {
      file?.click()
      return
    }
    props.onCommand(id)
    props.onClose()
  }

  const onKey = (e: KeyboardEvent) => {
    const list = filtered()
    if (e.key === 'Escape') {
      props.onClose()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => Math.min(list.length - 1, i + 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => Math.max(0, i - 1))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const item = list[index()]
      if (item) run(item.id)
    }
  }

  createEffect(() => {
    query()
    setIndex(0)
  })

  onMount(() => input?.focus())

  return (
    <div
      class="palette"
      role="dialog"
      aria-modal="true"
      aria-label="Commands"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <div class="palette-panel">
        <input
          ref={input}
          class="palette-input"
          placeholder="Type a command…"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={onKey}
        />

        <div class="palette-list">
          <For each={filtered()}>
            {(command, i) => (
              <button
                class="palette-item"
                classList={{ active: index() === i() }}
                onMouseEnter={() => setIndex(i())}
                onClick={() => run(command.id)}
              >
                <span>{command.label}</span>
                <Show when={command.hint}>
                  <span class="palette-hint">{command.hint}</span>
                </Show>
              </button>
            )}
          </For>
          <Show when={filtered().length === 0}>
            <p class="palette-empty">No command matches.</p>
          </Show>
        </div>

        <input
          ref={file}
          type="file"
          accept="application/json,.json"
          class="palette-file"
          onChange={async (e) => {
            const selected = e.currentTarget.files?.[0]
            if (!selected) return
            const text = await selected.text()
            props.onImport(text)
            props.onClose()
          }}
        />
      </div>
    </div>
  )
}
