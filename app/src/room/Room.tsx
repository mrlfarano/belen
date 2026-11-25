import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { invoke } from '@tauri-apps/api/core'
import { createRoomStore } from './store'
import { createTokenBatcher } from './stream'
import {
  WINDOW_INITIAL,
  WINDOW_STEP,
  anchorOnUnfollow,
  distanceToBottom,
  hasMoreHistory,
  prependShift,
  shouldFollow,
  shouldLoadMore,
  visibleWindow,
} from './scroll-model'
import { lastAppliedUpdate } from '../update/update'
import BlockView from './BlockView'
import Composer from './Composer'
import Settings from '../settings/Settings'
import { cancelStream, loadConfig, streamChat } from '../providers/client'
import { resolveSpec } from '../providers/auth'
import { createToolSession, MAX_TOOL_ROUNDS, type BrokerResult } from '../providers/toolLoop'
import { toolsSupported, WORKSPACE_TOOLS } from '../providers/tools'
import { widthOf } from '../providers/config'
import type { AppConfig, ChatMessage, ProviderSpec } from '../providers/types'
import type { BuiPayload } from '../bui/schema'
import { extractBui } from '../bui/extract'
import { CATALOG } from '../skills/catalog'
import { skills } from '../skills/runtime'
import { startSubAgent, type AgentRun } from '../skills/agent'
import type { Capability, Manifest } from '../skills/types'
import CommandPalette, { type CommandId } from '../command/CommandPalette'

const DEMO =
  'Here is the comparison. Context is the first axis: Aurelia 3 reaches 1M tokens, ' +
  'Kestrel 2 sits at 256K, and Lantern 1.5 at 128K. Price follows context in this case — ' +
  'Lantern is the cheapest per million tokens and also the fastest to first token. ' +
  'If your work is long-document reasoning, Aurelia pays for itself; if it is high-volume ' +
  'chat, Lantern wins on both axes. The table below is live: sort it, filter it, pin it.'

const TABLE: BuiPayload = {
  v: 1,
  blocks: [
    {
      type: 'table',
      columns: ['Model', 'Context', 'Price / 1M', 'TTFT'],
      rows: [
        ['Aurelia 3', '1M', '$2.40', '210 ms'],
        ['Kestrel 2', '256K', '$0.90', '95 ms'],
        ['Lantern 1.5', '128K', '$0.35', '48 ms'],
      ],
    },
  ],
}

const CHART: BuiPayload = {
  v: 1,
  blocks: [
    {
      type: 'chart',
      chart: 'bar',
      title: 'Price per 1M tokens',
      unit: 'USD',
      categories: ['Aurelia 3', 'Kestrel 2', 'Lantern 1.5'],
      series: [{ name: 'Price', points: [2.4, 0.9, 0.35] }],
    },
  ],
}

const SYSTEM = [
  'You are BELEN, a chat interface. Answer in prose.',
  'When a comparison, metric, code sample, form, timeline or chart would be clearer as a component, include exactly one fenced block:',
  '```bui',
  '{"v":1,"blocks":[{"type":"table","columns":["Model","Context"],"rows":[["A","1M"]]}]}',
  '```',
  'To propose a chart, use a chart block: {"type":"chart","chart":"bar|line|area|pie|donut","title":"Price per 1M","unit":"USD","categories":["A","B"],"series":[{"name":"price","points":[2.4,0.9]}]} — every series carries exactly one number per category. Use bar for comparing magnitudes, line or area for a trend over ordered categories, pie or donut for shares of a whole.',
  'Allowed block types: text, table, code, metric, form, timeline, worker, chart. Keep all prose outside the fence. Never emit HTML.',
].join('\n')

export default function Room() {
  const store = createRoomStore()
  const { room, append, appendText, setText, setMeta, appendOutput, setActive, togglePin, fork } =
    store
  const [visibleCount, setVisibleCount] = createSignal(WINDOW_INITIAL)
  /** True while the transcript follows new content; false while reading history. */
  const [following, setFollowing] = createSignal(true)
  /** Frozen oldest visible index while reading history; 0 when following. */
  const [anchor, setAnchor] = createSignal(0)
  const [config, setConfig] = createSignal<AppConfig | null>(null)
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const [settingsTab, setSettingsTab] = createSignal<'provider' | 'chat' | 'skills' | 'about'>(
    'provider',
  )
  const [paletteOpen, setPaletteOpen] = createSignal(false)
  const runs = new Map<string, AgentRun>()
  let scroller: HTMLDivElement | undefined
  let contentEl: HTMLDivElement | undefined
  let observer: ResizeObserver | undefined
  let streamTimer: number | undefined
  let artifactTimer: number | undefined
  let saveTimer: number | undefined
  let streaming = false
  let perfMode = false
  /** Bumped on every stop/new send; stale stream callbacks drop themselves. */
  let runSeq = 0
  let liveStreamId = ''
  let liveSession: ReturnType<typeof createToolSession> | null = null

  const chatWidth = () => widthOf(config())

  const pinToBottom = () => {
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }

  /** Open-room, import, new-room: land on the newest message and resume following. */
  const resetScroll = () => {
    setFollowing(true)
    setAnchor(0)
    setVisibleCount(WINDOW_INITIAL)
    queueMicrotask(pinToBottom)
  }

  const scheduleSave = () => {
    if (perfMode) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      const json = JSON.stringify(store.snapshot())
      void invoke('room_save', { roomId: room.id, json }).catch(() => {})
    }, 500)
  }

  // Run before the updater restarts the process — the debounced save would
  // otherwise never fire.
  const flushSave = () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = undefined
    }
    if (perfMode) return
    const json = JSON.stringify(store.snapshot())
    void invoke('room_save', { roomId: room.id, json }).catch(() => {})
  }

  const applyTheme = (theme: 'light' | 'dark') => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('belen-theme', theme)
  }

  const toggleTheme = () => {
    const current = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
    applyTheme(current === 'light' ? 'dark' : 'light')
  }

  const onGlobalKey = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      setPaletteOpen((open) => !open)
      return
    }
    if (e.key === 'Escape' && !settingsOpen() && !paletteOpen()) {
      stopStream()
    }
  }

  const batcher = createTokenBatcher((delta) => {
    if (room.activeId) appendText(room.activeId, delta)
  })

  const stopStream = () => {
    if (streamTimer) {
      clearInterval(streamTimer)
      streamTimer = undefined
    }
    if (artifactTimer) {
      clearInterval(artifactTimer)
      artifactTimer = undefined
    }
    streaming = false
    runSeq++
    liveSession?.cancel()
    liveSession = null
    const sid = liveStreamId
    liveStreamId = ''
    // Abort the HTTP stream in Rust; late events are dropped via runSeq.
    if (sid) void cancelStream(sid).catch(() => {})
    if (room.activeId) setActive(null)
    scheduleSave()
  }

  const history = (): ChatMessage[] => {
    const out: ChatMessage[] = []
    for (const id of room.order) {
      const block = room.byId[id]
      if (!block || block.forkOf) continue
      if ((block.kind === 'user' || block.kind === 'assistant') && block.text?.trim()) {
        out.push({
          role: block.kind === 'user' ? 'user' : 'assistant',
          content: block.text,
        })
      }
    }
    return out.slice(-20)
  }

  const systemPrompt = () => {
    const extra = skills
      .installed()
      .filter((m) => m.kind === 'skill' && m.instructions)
      .map((m) => m.instructions as string)
    return [SYSTEM, ...extra].join('\n\n')
  }

  /**
   * One assistant turn. When the provider supports tools and a workspace is
   * configured, streamed tool calls are validated, dispatched through the Rust
   * broker, and answered with structured results (matched by call id), then a
   * follow-up round lets the model speak. Bounded by MAX_TOOL_ROUNDS.
   */
  const streamReal = async () => {
    const provider = config()?.provider
    if (!provider) return

    // resolveSpec can fail (expired OAuth, missing key) — surface it like any
    // provider error instead of leaking an unhandled rejection.
    let spec: ProviderSpec
    try {
      spec = await resolveSpec(provider)
    } catch (e) {
      append('system', `Provider error: ${String(e)}`)
      stopStream()
      return
    }
    const seq = ++runSeq
    const alive = () => seq === runSeq
    const streamId = `stream-${seq}-${Date.now()}`

    const workspace = config()?.workspace
    const withTools = toolsSupported(provider.kind, workspace)
    const tools = withTools ? WORKSPACE_TOOLS : undefined
    const base = history()
    const system = withTools
      ? [
          systemPrompt(),
          'The user attached a workspace. Three read-only tools are available: workspace_list, workspace_read, workspace_search. Use them when the question concerns files or code in that workspace, then answer in prose.',
          'All tool paths are relative to the workspace root. The workspace is read-only: nothing can be created, modified or deleted through these tools.',
        ].join(' ')
      : systemPrompt()

    const id = append('assistant', '')
    setActive(id)
    streaming = true

    // call id → transcript block, so tool activity surfaces in the room.
    const toolBlocks = new Map<string, string>()
    const session = withTools
      ? createToolSession(
          (name, argsJson, callId) =>
            invoke<BrokerResult>('tool_exec', {
              workspaceRoot: workspace,
              name,
              callId,
              argsJson,
              streamId,
            }),
          {
            onCallStart: (callId, summary) => {
              const blockId = toolBlocks.get(callId)
              if (!blockId) return
              setMeta(blockId, 'label', summary)
              setMeta(blockId, 'status', 'running')
            },
            onCallDone: (callId, status, preview, ms) => {
              const blockId = toolBlocks.get(callId)
              if (!blockId) return
              setMeta(blockId, 'status', status)
              setMeta(blockId, 'output', preview)
              setMeta(blockId, 'ms', `${ms} ms`)
              scheduleSave()
            },
          },
        )
      : null
    liveSession = session
    liveStreamId = streamId

    const doneRounds = new Set<number>()
    let rounds = 0

    const onDone = async (blockId: string) => {
      batcher.flush()
      const streamedText = room.byId[blockId]?.text ?? ''
      const extracted = extractBui(streamedText)
      if (extracted) {
        setText(blockId, extracted.prose)
        append('artifact', '', { component: extracted.payload })
      }
      if (!alive()) return
      if (!session || !session.used || session.cancelled) {
        stopStream()
        return
      }
      await session.pending
      if (!alive()) return
      if (rounds < MAX_TOOL_ROUNDS) {
        const follow = session.extendHistory(base, extracted ? extracted.prose : streamedText)
        const nextId = append('assistant', '')
        setActive(nextId)
        await runRound(follow, nextId)
        return
      }
      append('system', `Paused after ${MAX_TOOL_ROUNDS} tool rounds.`)
      stopStream()
    }

    const runRound = async (messages: ChatMessage[], blockId: string): Promise<void> => {
      rounds++
      const thisRound = rounds
      await streamChat(
        spec,
        provider.model,
        messages,
        system,
        (event) => {
          if (!alive()) return
          if (event.type === 'token') {
            batcher.push(event.text)
          } else if (event.type === 'toolCall') {
            const toolBlockId = append('tool', '', { meta: { status: 'queued' } })
            toolBlocks.set(event.callId, toolBlockId)
            void session?.handle(event)
          } else if (event.type === 'done') {
            if (doneRounds.has(thisRound)) return
            doneRounds.add(thisRound)
            void onDone(blockId)
          } else if (event.type === 'error') {
            batcher.flush()
            append('system', `Provider error: ${event.message}`)
            stopStream()
          }
        },
        tools,
        streamId,
      )
    }

    try {
      await runRound(base, id)
      if (alive() && streaming) stopStream()
    } catch (e) {
      batcher.flush()
      if (alive()) {
        append('system', `Provider error: ${String(e)}`)
        stopStream()
      }
    }
  }

  const streamDemo = () => {
    const id = append('assistant', '')
    setActive(id)
    const words = DEMO.split(/(?<= )/)
    let i = 0
    streamTimer = window.setInterval(() => {
      if (i >= words.length) {
        stopStream()
        return
      }
      batcher.push(words[i++])
    }, 22)
  }

  const runAgent = async (manifest: Manifest, input: string) => {
    const provider = config()?.provider
    if (!provider) {
      append('system', 'Configure a provider before running a sub-agent.')
      return
    }

    let spec: ProviderSpec
    try {
      spec = await resolveSpec(provider)
    } catch (e) {
      append('system', `Provider error: ${String(e)}`)
      return
    }
    const workerId = append('worker', manifest.name, {
      meta: { status: 'running', output: '' },
    })

    const run = startSubAgent({
      manifest,
      input,
      model: provider.model,
      spec,
      handlers: {
        onToken: (text) => appendOutput(workerId, text),
        onStatus: (status, detail) =>
          setMeta(workerId, 'status', detail ? `${status}: ${detail}` : status),
      },
    })
    runs.set(workerId, run)
    await run.finished
    runs.delete(workerId)
    scheduleSave()
  }

  const cancelAgent = (id: string) => {
    runs.get(id)?.cancel()
    setMeta(id, 'status', 'cancelled')
    scheduleSave()
  }

  const send = (text: string) => {
    stopStream()

    const command = text.match(/^\/([a-z0-9-]+)\s+([\s\S]+)$/i)
    if (command) {
      const manifest = skills
        .installed()
        .find((m) => m.id === command[1].toLowerCase() && m.kind === 'sub-agent')
      if (manifest) {
        append('user', text)
        void runAgent(manifest, command[2])
        return
      }
    }

    append('user', text)
    scheduleSave()

    if (/chart|graph|trend|price|plot|visual/i.test(text)) {
      const artifactId = append('artifact', '')
      const json = JSON.stringify(CHART)
      let i = 0
      artifactTimer = window.setInterval(() => {
        if (i >= json.length) {
          if (artifactTimer) clearInterval(artifactTimer)
          artifactTimer = undefined
          return
        }
        appendText(artifactId, json.slice(i, i + 24))
        i += 24
      }, 22)
    } else if (/compare/i.test(text)) {
      const artifactId = append('artifact', '')
      const json = JSON.stringify(TABLE)
      let i = 0
      artifactTimer = window.setInterval(() => {
        if (i >= json.length) {
          if (artifactTimer) clearInterval(artifactTimer)
          artifactTimer = undefined
          return
        }
        appendText(artifactId, json.slice(i, i + 24))
        i += 24
      }, 22)
    }

    if (config()?.provider) {
      void streamReal()
    } else {
      streamDemo()
    }
  }

  const pin = (id: string) => {
    togglePin(id)
    scheduleSave()
  }

  const forkBlock = (id: string) => {
    fork(id)
    scheduleSave()
  }

  const toMarkdown = () => {
    const lines: string[] = [`# ${room.title}`, '']
    for (const id of room.order) {
      const block = room.byId[id]
      if (!block) continue
      if (block.kind === 'user') lines.push('## You', '', block.text ?? '', '')
      else if (block.kind === 'assistant') lines.push('## BELEN', '', block.text ?? '', '')
      else if (block.kind === 'worker')
        lines.push(
          `### ${block.text ?? 'Worker'} — ${block.meta?.status ?? ''}`,
          '',
          block.meta?.output ?? '',
          '',
        )
      else if (block.kind === 'artifact')
        lines.push('```json', JSON.stringify(block.component ?? block.text, null, 2), '```', '')
      else if (block.kind === 'system') lines.push(`> ${block.text ?? ''}`, '')
    }
    return lines.join('\n')
  }

  const exportRoom = async (kind: 'md' | 'json') => {
    const contents =
      kind === 'md' ? toMarkdown() : JSON.stringify(store.snapshot(), null, 2)
    const name = kind === 'md' ? 'belen-room.md' : 'belen-room.json'
    try {
      const path = await invoke<string>('export_file', { name, contents })
      const file = path.split(/[\\/]/).pop() ?? path
      append('system', `Exported ${file} → data/exports`)
      scheduleSave()
    } catch (e) {
      append('system', `Export failed: ${String(e)}`)
    }
  }

  const importRoom = (json: string) => {
    try {
      const parsed = JSON.parse(json)
      if (!Array.isArray(parsed?.order) || !parsed?.byId) {
        throw new Error('not a BELEN room')
      }
      store.hydrate(parsed)
      resetScroll()
      scheduleSave()
      append('system', 'Room imported.')
    } catch (e) {
      append('system', `Import failed: ${String(e)}`)
    }
  }

  const handleCommand = (id: CommandId) => {
    switch (id) {
      case 'settings':
        setSettingsTab('provider')
        setSettingsOpen(true)
        break
      case 'skills':
        setSettingsTab('skills')
        setSettingsOpen(true)
        break
      case 'update':
        setSettingsTab('about')
        setSettingsOpen(true)
        break
      case 'export-md':
        void exportRoom('md')
        break
      case 'export-json':
        void exportRoom('json')
        break
      case 'new-room':
        stopStream()
        store.clear()
        resetScroll()
        scheduleSave()
        break
      case 'theme':
        toggleTheme()
        break
      default:
        break
    }
  }

  // Follow streamed text and late layout changes while the user is at the
  // bottom. The effect tracks content growth (new blocks, token appends into
  // the active or last block, worker output); the ResizeObserver catches
  // everything height-related that happens after render (components, images,
  // expanded details).
  createEffect(() => {
    void room.order.length
    const activeId = room.activeId
    if (activeId) void room.byId[activeId]?.text?.length
    if (activeId) void room.byId[activeId]?.meta?.output?.length
    const lastId = room.order[room.order.length - 1]
    if (lastId) {
      void room.byId[lastId]?.text?.length
      void room.byId[lastId]?.meta?.output?.length
    }
    if (!following()) return
    queueMicrotask(pinToBottom)
  })

  const onScroll = () => {
    if (!scroller) return
    const el = scroller
    const distance = distanceToBottom(el.scrollTop, el.scrollHeight, el.clientHeight)
    const next = shouldFollow(distance)
    if (next !== following()) {
      setFollowing(next)
      if (next) {
        setAnchor(0)
      } else {
        // Freeze the window so appended blocks never shift the reader's view.
        setAnchor(anchorOnUnfollow(room.order.length, visibleCount()))
      }
    }

    if (!following() && shouldLoadMore(el.scrollTop) && hasMoreHistory(anchor())) {
      const before = el.scrollHeight
      const start = Math.max(0, anchor() - WINDOW_STEP)
      if (start === anchor()) return
      setAnchor(start)
      setVisibleCount((v) => v + WINDOW_STEP)
      queueMicrotask(() => {
        if (scroller) scroller.scrollTop += prependShift(before, scroller.scrollHeight)
      })
    }
  }

  const jumpToLatest = () => {
    setFollowing(true)
    setAnchor(0)
    pinToBottom()
  }

  onCleanup(() => {
    if (streamTimer) clearInterval(streamTimer)
    if (artifactTimer) clearInterval(artifactTimer)
    if (saveTimer) clearTimeout(saveTimer)
    observer?.disconnect()
    window.removeEventListener('keydown', onGlobalKey)
    if (!perfMode) {
      const json = JSON.stringify(store.snapshot())
      void invoke('room_save', { roomId: room.id, json }).catch(() => {})
    }
  })

  onMount(async () => {
    try {
      const loaded = await loadConfig()
      setConfig(loaded)
      if (!loaded.provider) setSettingsOpen(true)

      for (const [id, caps] of Object.entries(loaded.grants ?? {})) {
        for (const cap of caps) skills.grant(id, cap as Capability)
      }
      for (const id of loaded.skills ?? []) {
        const manifest = CATALOG.find((m) => m.id === id)
        if (!manifest) continue
        try {
          await skills.install(manifest)
        } catch {
          /* missing grant — the skills panel will ask again */
        }
      }
    } catch {
      /* first run */
    }

    const savedTheme = localStorage.getItem('belen-theme')
    applyTheme(
      savedTheme === 'light' || savedTheme === 'dark'
        ? savedTheme
        : matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark',
    )

    perfMode = await invoke<boolean>('perf_mode').catch(() => false)

    if (!perfMode) {
      try {
        const applied = await lastAppliedUpdate()
        if (applied) append('system', `BELEN ${applied} installed.`)
      } catch {
        /* no pending update marker */
      }
      try {
        const savedRoom = await invoke<string | null>('room_load', { roomId: 'room-1' })
        if (savedRoom) {
          const parsed = JSON.parse(savedRoom)
          if (Array.isArray(parsed?.order) && parsed?.byId) {
            store.hydrate(parsed)
            resetScroll()
          }
        }
      } catch {
        /* no database yet */
      }
    }

    // Late layout (webfont swap, component hydration) must not strand the
    // transcript above the newest message while following.
    if (typeof ResizeObserver !== 'undefined' && contentEl) {
      observer = new ResizeObserver(() => {
        if (following()) pinToBottom()
      })
      observer.observe(contentEl)
    }

    window.addEventListener('keydown', onGlobalKey)

    ;(window as unknown as { __belen: unknown }).__belen = {
      push: batcher.push,
      append,
      appendText,
      setActive,
      room,
      store,
    }
  })

  const visibleOrder = () => {
    const w = visibleWindow(room.order.length, visibleCount(), anchor(), following())
    return room.order.slice(w.start, w.start + w.count)
  }

  const chatWidthClass = () => {
    const w = chatWidth()
    return w === 'default' ? 'room' : `room width-${w}`
  }

  return (
    <div class={chatWidthClass()}>
      <header class="masthead">
        <span class="wordmark">BELEN</span>
        <span class="masthead-right">
          <span class="meta">{config()?.provider?.model ?? 'No provider'}</span>
          <button
            class="block-action"
            onClick={() => {
              setSettingsTab('chat')
              setSettingsOpen(true)
            }}
          >
            Chat
          </button>
          <button
            class="block-action"
            onClick={() => {
              setSettingsTab('provider')
              setSettingsOpen(true)
            }}
          >
            Settings
          </button>
        </span>
      </header>

      <main class="measure" ref={scroller} onScroll={onScroll}>
        <div class="measure-content" ref={contentEl}>
          <For each={visibleOrder()}>
            {(id) => (
              <BlockView
                block={room.byId[id]}
                active={room.activeId === id}
                onPin={pin}
                onFork={forkBlock}
                onCancel={cancelAgent}
              />
            )}
          </For>

          <Show when={room.order.length === 0}>
            <div class="empty-room">
              <p class="eyebrow">Room 01</p>
              <h1 class="lede">
                The interface
                <br />
                is the conversation.
              </h1>
              <p class="body dim">
                Pick a provider and the room starts answering. Ask for a comparison and the
                answer becomes a table.
              </p>
              <p class="body dim">Try: “compare the three models”.</p>
              <Show
                when={skills.installed().filter((m) => m.kind === 'sub-agent').length > 0}
              >
                <p class="body dim">
                  Sub-agents:{
                    skills
                      .installed()
                      .filter((m) => m.kind === 'sub-agent')
                      .map((m) => ` /${m.id}`)
                      .join(' ·')
                  }{' '}
                  &lt;prompt&gt;
                </p>
              </Show>
            </div>
          </Show>
        </div>

        <Show when={!following() && room.order.length > 0}>
          <button class="jump-latest" onClick={jumpToLatest}>
            Jump to latest ↓
          </button>
        </Show>
      </main>

      <Composer onSend={send} />

      <Show when={settingsOpen()}>
        <Settings
          config={config()}
          onClose={() => setSettingsOpen(false)}
          onSaved={(next) => {
            setConfig(next)
            setSettingsOpen(false)
          }}
          onChange={(next) => setConfig(next)}
          initialTab={settingsTab()}
          onBeforeRestart={flushSave}
          autoCheck={settingsTab() === 'about'}
        />
      </Show>

      <Show when={paletteOpen()}>
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onCommand={handleCommand}
          onImport={importRoom}
        />
      </Show>
    </div>
  )
}
