import { streamChat } from '../providers/client'
import type { ChatMessage, ProviderSpec } from '../providers/types'
import { kernel } from './runtime'
import type { Manifest } from './types'
import { clockLine } from '../room/clock'

export type AgentHandlers = {
  onToken: (text: string) => void
  onStatus: (status: string, detail?: string) => void
}

export type AgentRun = {
  cancel: () => void
  finished: Promise<void>
  readonly closed: boolean
}

export type AgentStream = typeof streamChat

type Options = {
  manifest: Manifest
  input: string
  /** Recent room turns ahead of the input, so agents like critic can see
   *  the answer they are meant to review. */
  context?: ChatMessage[]
  model: string
  spec: ProviderSpec
  handlers: AgentHandlers
  /** Test hook: fires exactly once when the run is closed. */
  onCleanup?: () => void
}

/**
 * Starts one bounded model pass. The run owns a Cordis fiber; cancelling closes
 * the run exactly once, disposes the fiber, and drops any later token.
 */
export function startSubAgent(opts: Options, stream: AgentStream = streamChat): AgentRun {
  const budget = opts.manifest.budget ?? { maxTurns: 1, maxTokens: 1200, maxMs: 30_000 }
  let cancelled = false
  let settled = false
  let closed = false
  let chars = 0
  let timer: number | undefined

  const fiber = kernel.plugin((ctx) => {
    ctx.effect(() => () => {
      /* the run's reversible effect; disposal is the cancel path */
    })
  })

  const close = () => {
    if (closed) return
    closed = true
    if (timer) clearTimeout(timer)
    opts.onCleanup?.()
    void fiber.dispose()
  }

  const cancel = () => {
    if (cancelled) return
    cancelled = true
    opts.handlers.onStatus('error', 'cancelled')
    close()
  }

  const finished = (async () => {
    try {
      await stream(
        opts.spec,
        opts.model,
        [...(opts.context ?? []), { role: 'user', content: opts.input }],
        // Same "now" the room gets: a sub-agent has no clock of its own either.
        [clockLine(), opts.manifest.instructions].join('\n\n'),
        (event) => {
          if (cancelled) return

          if (event.type === 'token') {
            chars += event.text.length
            if (chars > budget.maxTokens * 4) {
              cancelled = true
              opts.handlers.onStatus('error', 'token budget')
              close()
              return
            }
            opts.handlers.onToken(event.text)
          }

          if (event.type === 'done') {
            settled = true
            opts.handlers.onStatus('done')
          }

          if (event.type === 'error') {
            settled = true
            opts.handlers.onStatus('error', event.message)
          }
        },
      )
    } finally {
      settled = true
      close()
    }
  })()

  timer = setTimeout(() => {
    if (settled) return
    cancelled = true
    opts.handlers.onStatus('error', 'time budget')
    close()
  }, budget.maxMs)

  return {
    cancel,
    finished,
    get closed() {
      return closed
    },
  }
}
