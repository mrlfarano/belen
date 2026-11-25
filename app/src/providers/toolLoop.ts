import { describeCall, validateToolArgs } from './tools'
import type { ChatMessage, StreamEvent } from './types'

/**
 * One assistant turn that may involve tool rounds. The session assembles
 * streamed tool calls, validates model arguments, dispatches through the
 * broker, and produces the provider-neutral history extension the next round
 * needs (assistant tool_calls + matching tool results, keyed by call id).
 *
 * Model arguments and tool results are untrusted: they are validated, bounded,
 * and never persisted in room state — only this run's local history uses them.
 */
export type BrokerResult = {
  callId: string
  ok: boolean
  content: string
  truncated?: boolean
  denied?: boolean
  error?: string
}

export type ToolBroker = (name: string, argsJson: string, callId: string) => Promise<BrokerResult>

export type ToolSessionUi = {
  onCallStart: (callId: string, summary: string) => void
  onCallDone: (callId: string, status: 'ok' | 'denied' | 'error', preview: string, ms: number) => void
}

/** How many model↔tool round trips one send() may take. */
export const MAX_TOOL_ROUNDS = 6

/** Per-result cap on what is handed back to the model. */
export const RESULT_CONTENT_LIMIT = 16_000

const PREVIEW_LIMIT = 300

export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`

type CallRecord = { id: string; name: string; arguments: string }
type ResultRecord = { id: string; name: string; content: string }

export function createToolSession(broker: ToolBroker, ui: ToolSessionUi) {
  const calls: CallRecord[] = []
  const results: ResultRecord[] = []
  let cancelled = false
  /** Serializes broker dispatch; tool events arrive in stream order. */
  let chain: Promise<void> = Promise.resolve()

  const record = (id: string, name: string, content: string) => {
    results.push({ id, name, content })
  }

  const handleOne = (callId: string, name: string, argsRaw: string): Promise<void> => {
    calls.push({ id: callId, name, arguments: argsRaw })

    const check = validateToolArgs(name, argsRaw)
    ui.onCallStart(callId, check.ok ? describeCall(name, check.args) : `${name} — bad arguments`)

    if (!check.ok) {
      // Malformed model output never reaches the broker; the model gets a
      // structured error so it can correct itself in the next round.
      record(callId, name, JSON.stringify({ error: check.error }))
      ui.onCallDone(callId, 'error', clip(check.error, PREVIEW_LIMIT), 0)
      return Promise.resolve()
    }

    if (cancelled) {
      record(callId, name, JSON.stringify({ error: 'cancelled' }))
      ui.onCallDone(callId, 'error', 'cancelled', 0)
      return Promise.resolve()
    }

    const started = Date.now()
    return broker(name, JSON.stringify(check.args), callId)
      .then((res) => {
        const ms = Date.now() - started
        const status: 'ok' | 'denied' | 'error' = !res.ok
          ? 'error'
          : res.denied
            ? 'denied'
            : 'ok'
        const content =
          res.ok && !res.error
            ? clip(res.content, RESULT_CONTENT_LIMIT)
            : JSON.stringify({ error: res.error ?? 'tool failed' })
        record(callId, name, content)
        ui.onCallDone(callId, status, clip(res.error ?? res.content, PREVIEW_LIMIT), ms)
      })
      .catch((e: unknown) => {
        const ms = Date.now() - started
        const message = e instanceof Error ? e.message : String(e)
        record(callId, name, JSON.stringify({ error: message }))
        ui.onCallDone(callId, 'error', clip(message, PREVIEW_LIMIT), ms)
      })
  }

  return {
    /** Feed one assembled tool call from the stream; returns when dispatched. */
    handle(event: Extract<StreamEvent, { type: 'toolCall' }>): Promise<void> {
      chain = chain.then(() => handleOne(event.callId, event.name, event.arguments))
      return chain
    },
    /** True once at least one tool call was seen this run. */
    get used(): boolean {
      return calls.length > 0
    },
    get pending(): Promise<void> {
      return chain
    },
    cancel(): void {
      cancelled = true
    },
    get cancelled(): boolean {
      return cancelled
    },
    /**
     * History for the follow-up round: the conversation so far, then one
     * assistant message carrying its text and every tool call, then one tool
     * message per result with the matching call id.
     */
    extendHistory(base: ChatMessage[], assistantText: string): ChatMessage[] {
      if (calls.length === 0) return base
      return [
        ...base,
        {
          role: 'assistant',
          content: assistantText,
          toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
        },
        ...results.map((r) => ({
          role: 'tool',
          content: r.content,
          toolCallId: r.id,
          name: r.name,
        })),
      ]
    },
  }
}
