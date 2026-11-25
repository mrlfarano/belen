import { describeCall, needsApproval, validateToolArgs } from './tools'
import type { AskBefore, ChatMessage, StreamEvent, ToolCallRef } from './types'

/**
 * One assistant turn that may involve tool rounds. The session assembles
 * streamed tool calls, validates model arguments, dispatches through the
 * broker, and produces the provider-neutral history extension the next round
 * needs (assistant tool_calls + matching tool results, keyed by call id).
 *
 * Model arguments and tool results are untrusted: they are validated, bounded,
 * and never persisted in room state — only this run's local history uses them.
 *
 * A call that changes the world — a command, a file change — stops at the
 * approval gate until the user answers in the room. The gate sits here, in the
 * one place every call passes through; a session with no way to ask denies
 * rather than runs.
 */
export type BrokerResult = {
  callId: string
  ok: boolean
  content: string
  truncated?: boolean
  denied?: boolean
  error?: string
}

export type ToolBroker = (
  name: string,
  argsJson: string,
  callId: string,
  /** True only after the user okayed this call in the room. */
  approved: boolean,
) => Promise<BrokerResult>

/** The user's answer to a call that was waiting. */
export type Approval = 'once' | 'session' | 'deny'

/** One model↔tool exchange: the calls a round issued and what came back. */
export type ToolRound = {
  calls: ToolCallRef[]
  results: ChatMessage[]
}

/** What to do once a model round has finished. */
export function afterRound(round: ToolRound, roundsSoFar: number): 'final' | 'again' | 'paused' {
  // Only a round that made new calls needs another one. (It used to be "the
  // session was ever used", which started rounds until the limit every time
  // a tool had been called once.)
  if (round.calls.length === 0) return 'final'
  return roundsSoFar < MAX_TOOL_ROUNDS ? 'again' : 'paused'
}

/**
 * The messages for the round that follows: what the model was sent, its
 * answer with the calls that answer made, and what those calls returned.
 * Fed its own output next round, the history grows by one exchange each time.
 */
export function nextRoundMessages(
  sent: ChatMessage[],
  assistantText: string,
  round: ToolRound,
): ChatMessage[] {
  if (round.calls.length === 0) return sent
  return [
    ...sent,
    { role: 'assistant', content: assistantText, toolCalls: round.calls },
    ...round.results,
  ]
}

export type ToolSessionUi = {
  onCallStart: (callId: string, summary: string) => void
  onCallDone: (callId: string, status: 'ok' | 'denied' | 'error', preview: string, ms: number) => void
  /**
   * A gated call waits on this until the user decides. Absent ⇒ the call is
   * denied: a session that cannot ask must not run it.
   */
  requestApproval?: (
    callId: string,
    name: string,
    args: Record<string, unknown>,
  ) => Promise<Approval>
}

/**
 * How many model↔tool round trips one send() may take. Six was enough to look
 * something up; getting work done — search, read, change, run, read again —
 * needs more.
 */
export const MAX_TOOL_ROUNDS = 12

/** Per-result cap on what is handed back to the model. */
export const RESULT_CONTENT_LIMIT = 16_000

const PREVIEW_LIMIT = 300

export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`

type CallRecord = { id: string; name: string; arguments: string }
type ResultRecord = { id: string; name: string; content: string }

export function createToolSession(broker: ToolBroker, ui: ToolSessionUi, askBefore: AskBefore = 'changes') {
  const calls: CallRecord[] = []
  const results: ResultRecord[] = []
  /** Tools the user allowed "for this session"; they stop asking. */
  const allowedForSession = new Set<string>()
  let cancelled = false
  /** Serializes broker dispatch; tool events arrive in stream order. */
  let chain: Promise<void> = Promise.resolve()
  /** Calls waiting on the user, so cancel() can answer them. */
  const waiting = new Map<string, () => void>()
  /** How many calls (and, by the same count, results) a past round took. */
  let handedOver = 0

  const record = (id: string, name: string, content: string) => {
    results.push({ id, name, content })
  }

  const cancelledCall = (callId: string, name: string) => {
    record(callId, name, JSON.stringify({ error: 'cancelled' }))
    ui.onCallDone(callId, 'error', 'cancelled', 0)
  }

  const ask = (
    callId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<Approval> => {
    const request = ui.requestApproval
    if (!request) return Promise.resolve('deny')
    return new Promise<Approval>((resolve) => {
      waiting.set(callId, () => resolve('deny'))
      request(callId, name, args).then(
        (decision) => {
          waiting.delete(callId)
          resolve(decision)
        },
        () => {
          waiting.delete(callId)
          resolve('deny')
        },
      )
    })
  }

  const handleOne = async (callId: string, name: string, argsRaw: string): Promise<void> => {
    calls.push({ id: callId, name, arguments: argsRaw })

    const check = validateToolArgs(name, argsRaw)
    ui.onCallStart(callId, check.ok ? describeCall(name, check.args) : `${name} — bad arguments`)

    if (!check.ok) {
      // Malformed model output never reaches the broker; the model gets a
      // structured error so it can correct itself in the next round.
      record(callId, name, JSON.stringify({ error: check.error }))
      ui.onCallDone(callId, 'error', clip(check.error, PREVIEW_LIMIT), 0)
      return
    }

    if (cancelled) {
      cancelledCall(callId, name)
      return
    }

    let approved = false
    if (needsApproval(askBefore, name)) {
      if (allowedForSession.has(name)) {
        // Already allowed for this session: the broker still needs the word.
        approved = true
      } else {
        const decision = await ask(callId, name, check.args)
        if (cancelled) {
          cancelledCall(callId, name)
          return
        }
        if (decision === 'deny') {
          record(callId, name, JSON.stringify({ error: 'denied by the user' }))
          ui.onCallDone(callId, 'denied', 'denied by the user', 0)
          return
        }
        if (decision === 'session') allowedForSession.add(name)
        approved = true
      }
    }

    const started = Date.now()
    try {
      const res = await broker(name, JSON.stringify(check.args), callId, approved)
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
    } catch (e: unknown) {
      const ms = Date.now() - started
      const message = e instanceof Error ? e.message : String(e)
      record(callId, name, JSON.stringify({ error: message }))
      ui.onCallDone(callId, 'error', clip(message, PREVIEW_LIMIT), ms)
    }
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
    /**
     * The calls the round that just finished issued, and what they returned.
     * Each call hands them over: the next one reports only what came after.
     * Take it once `pending` has settled, so every result is in.
     */
    takeRound(): ToolRound {
      const round: ToolRound = {
        calls: calls.slice(handedOver).map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
        results: results.slice(handedOver).map((r) => ({ role: 'tool', content: r.content, toolCallId: r.id, name: r.name })),
      }
      handedOver = calls.length
      return round
    },
    cancel(): void {
      cancelled = true
      for (const abort of waiting.values()) abort()
      waiting.clear()
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
