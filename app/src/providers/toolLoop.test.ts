import { describe, expect, it, vi } from 'vitest'
import {
  afterRound,
  createToolSession,
  MAX_TOOL_ROUNDS,
  nextRoundMessages,
} from './toolLoop'
import type { Approval, BrokerResult, ToolBroker } from './toolLoop'
import type { ChatMessage, StreamEvent } from './types'

const toolEvent = (callId: string, name: string, args: string): Extract<StreamEvent, { type: 'toolCall' }> => ({
  type: 'toolCall',
  callId,
  name,
  arguments: args,
})

const okBroker = (content = '{"result":"fine"}'): ToolBroker =>
  vi.fn(async (name: string, _args: string, callId: string): Promise<BrokerResult> => ({
    callId,
    ok: true,
    content,
  }))

const silentUi = () => ({ onCallStart: vi.fn(), onCallDone: vi.fn() })

describe('tool session', () => {
  it('dispatches valid calls through the broker and records results by call id', async () => {
    const broker = okBroker()
    const ui = silentUi()
    const session = createToolSession(broker, ui)

    await session.handle(toolEvent('call_1', 'workspace_read', '{"path":"README.md"}'))
    expect(broker).toHaveBeenCalledWith('workspace_read', '{"path":"README.md"}', 'call_1', false)
    expect(session.used).toBe(true)
    expect(ui.onCallDone).toHaveBeenCalledWith(
      'call_1',
      'ok',
      expect.stringContaining('result'),
      expect.any(Number),
    )

    const history = session.extendHistory(
      [{ role: 'user', content: 'read me' }],
      '',
    )
    expect(history[1].role).toBe('assistant')
    expect(history[1].toolCalls?.[0]).toEqual({
      id: 'call_1',
      name: 'workspace_read',
      arguments: '{"path":"README.md"}',
    })
    expect(history[2]).toMatchObject({ role: 'tool', toolCallId: 'call_1', name: 'workspace_read' })
  })

  it('answers malformed model arguments without touching the broker', async () => {
    const broker = okBroker()
    const ui = silentUi()
    const session = createToolSession(broker, ui)

    await session.handle(toolEvent('call_x', 'workspace_read', '{"path": '))
    expect(broker).not.toHaveBeenCalled()
    expect(ui.onCallDone).toHaveBeenCalledWith('call_x', 'error', expect.any(String), 0)

    const history = session.extendHistory([], '')
    expect(history[1].content).toContain('error')
    expect(history[1].toolCallId).toBe('call_x')
  })

  it('reports broker denials as structured denied results', async () => {
    const broker: ToolBroker = vi.fn(async (_n, _a, callId) => ({
      callId,
      ok: true,
      denied: true,
      content: '{"error":"denied: path escapes the workspace"}',
    }))
    const ui = silentUi()
    const session = createToolSession(broker, ui)

    await session.handle(toolEvent('c1', 'workspace_read', '{"path":"../../x"}'))
    expect(ui.onCallDone).toHaveBeenCalledWith(
      'c1',
      'denied',
      expect.stringContaining('denied'),
      expect.any(Number),
    )
    const history = session.extendHistory([], '')
    expect(history[1].content).toContain('denied')
  })

  it('wraps broker failures as error results', async () => {
    const broker: ToolBroker = vi.fn(async (_n, _a, callId) => ({
      callId,
      ok: false,
      content: '',
      error: 'tool timed out',
    }))
    const ui = silentUi()
    const session = createToolSession(broker, ui)

    await session.handle(toolEvent('c1', 'workspace_search', '{"query":"x"}'))
    expect(ui.onCallDone).toHaveBeenCalledWith('c1', 'error', expect.stringContaining('timed out'), expect.any(Number))
    const history = session.extendHistory([], '')
    expect(history[1].content).toContain('timed out')
  })

  it('marks queued calls cancelled instead of dispatching them', async () => {
    const broker = okBroker()
    const ui = silentUi()
    const session = createToolSession(broker, ui)
    session.cancel()

    await session.handle(toolEvent('c1', 'workspace_list', '{}'))
    expect(broker).not.toHaveBeenCalled()
    const history = session.extendHistory([], '')
    expect(history[1].content).toContain('cancelled')
  })

  it('serializes concurrent tool events in stream order', async () => {
    const order: string[] = []
    const broker: ToolBroker = vi.fn(async (name) => {
      order.push(`start:${name}`)
      await new Promise((r) => setTimeout(r, name === 'workspace_list' ? 30 : 1))
      order.push(`end:${name}`)
      return { callId: 'x', ok: true, content: '{}' }
    })
    const session = createToolSession(broker, silentUi())

    const first = session.handle(toolEvent('a', 'workspace_list', '{}'))
    const second = session.handle(toolEvent('b', 'workspace_read', '{"path":"a"}'))
    await Promise.all([first, second])

    expect(order.indexOf('start:workspace_list')).toBeLessThan(order.indexOf('start:workspace_read'))
    expect(order.indexOf('end:workspace_list')).toBeLessThan(order.indexOf('end:workspace_read'))
  })

  it('keeps the untrusted result content out of the UI preview', async () => {
    const huge = 'x'.repeat(50_000)
    const broker: ToolBroker = vi.fn(async (_n, _a, callId) => ({ callId, ok: true, content: huge }))
    const ui = silentUi()
    const session = createToolSession(broker, ui)

    await session.handle(toolEvent('c1', 'workspace_read', '{"path":"big.txt"}'))
    const preview = ui.onCallDone.mock.calls[0][2] as string
    expect(preview.length).toBeLessThanOrEqual(301)
    // The full content only rides in history for the follow-up round.
    const history = session.extendHistory([], '')
    expect(history[1].content.length).toBeLessThanOrEqual(16_001)
  })

  it('documents the round bound for one send', () => {
    expect(MAX_TOOL_ROUNDS).toBeGreaterThanOrEqual(1)
    expect(MAX_TOOL_ROUNDS).toBeLessThanOrEqual(20)
  })
})

describe('rounds', () => {
  it('ends the run on an answer that calls nothing, even after earlier rounds did', async () => {
    const session = createToolSession(okBroker(), silentUi())

    // Round 1: the model reads a file.
    await session.handle(toolEvent('c1', 'workspace_read', '{"path":"README.md"}'))
    expect(afterRound(session.takeRound(), 1)).toBe('again')

    // Round 2: the model only answers. This used to start another round,
    // because the session "had been used", until the limit ran out.
    expect(afterRound(session.takeRound(), 2)).toBe('final')
  })

  it('pauses at the limit instead of starting one more round', async () => {
    const session = createToolSession(okBroker(), silentUi())
    await session.handle(toolEvent('c1', 'workspace_read', '{"path":"README.md"}'))
    const round = session.takeRound()
    expect(afterRound(round, MAX_TOOL_ROUNDS - 1)).toBe('again')
    expect(afterRound(round, MAX_TOOL_ROUNDS)).toBe('paused')
  })

  it('hands each round only its own calls, once', async () => {
    const session = createToolSession(okBroker(), silentUi())

    await session.handle(toolEvent('c1', 'workspace_read', '{"path":"README.md"}'))
    await session.handle(toolEvent('c2', 'workspace_list', '{}'))
    await session.pending
    expect(session.takeRound().calls.map((c) => c.id)).toEqual(['c1', 'c2'])

    // Taking again before anything new happened yields nothing.
    expect(session.takeRound()).toEqual({ calls: [], results: [] })

    await session.handle(toolEvent('c3', 'workspace_search', '{"query":"x"}'))
    await session.pending
    const second = session.takeRound()
    expect(second.calls.map((c) => c.id)).toEqual(['c3'])
    expect(second.results.map((r) => r.toolCallId)).toEqual(['c3'])
  })

  it('carries every earlier exchange into the next round', async () => {
    const session = createToolSession(okBroker(), silentUi())
    let sent: ChatMessage[] = [{ role: 'user', content: 'find it' }]

    await session.handle(toolEvent('c1', 'workspace_read', '{"path":"a"}'))
    await session.pending
    sent = nextRoundMessages(sent, 'let me look', session.takeRound())

    await session.handle(toolEvent('c2', 'workspace_search', '{"query":"x"}'))
    await session.pending
    sent = nextRoundMessages(sent, 'found it', session.takeRound())

    expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool'])
    // The second answer carries the second round's call, not the first's.
    expect(sent[1].toolCalls?.map((c) => c.id)).toEqual(['c1'])
    expect(sent[3].toolCalls?.map((c) => c.id)).toEqual(['c2'])
    expect(sent[2].toolCallId).toBe('c1')
    expect(sent[4].toolCallId).toBe('c2')

    // A round without calls leaves the messages exactly as they were.
    expect(nextRoundMessages(sent, 'done', session.takeRound())).toBe(sent)
  })
})

/** An approver that never answers until the test does, like a user reading the panel. */
const gate = () => {
  const pending: Array<{ callId: string; resolve: (decision: Approval) => void }> = []
  const requestApproval = vi.fn(
    (callId: string) => new Promise<Approval>((resolve) => pending.push({ callId, resolve })),
  )
  return { ui: { onCallStart: vi.fn(), onCallDone: vi.fn(), requestApproval }, pending }
}

/** Lets every pending microtask run, so a call reaches the gate. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

const command = (callId: string) => toolEvent(callId, 'run_command', '{"command":"git status"}')
const edit = (callId: string) =>
  toolEvent(callId, 'workspace_edit', '{"path":"a","oldText":"x","newText":"y"}')

describe('approval gate', () => {
  it('holds a gated call until the user allows it, then dispatches it as approved', async () => {
    const broker = okBroker()
    const { ui, pending } = gate()
    const session = createToolSession(broker, ui)

    const run = session.handle(command('c1'))
    await settled()
    expect(pending.map((p) => p.callId)).toEqual(['c1'])
    expect(ui.requestApproval).toHaveBeenCalledWith('c1', 'run_command', { command: 'git status' })
    expect(broker).not.toHaveBeenCalled()

    pending[0].resolve('once')
    await run
    expect(broker).toHaveBeenCalledWith('run_command', '{"command":"git status"}', 'c1', true)
    expect(ui.onCallDone).toHaveBeenCalledWith('c1', 'ok', expect.any(String), expect.any(Number))
  })

  it('runs nothing when the user denies, and tells the model so', async () => {
    const broker = okBroker()
    const { ui, pending } = gate()
    const session = createToolSession(broker, ui)

    const run = session.handle(edit('c1'))
    await settled()
    pending[0].resolve('deny')
    await run

    expect(broker).not.toHaveBeenCalled()
    expect(ui.onCallDone).toHaveBeenCalledWith('c1', 'denied', 'denied by the user', 0)
    expect(session.extendHistory([], '')[1].content).toContain('denied by the user')
  })

  it('stops asking for a tool once it is allowed for the session', async () => {
    const broker = okBroker()
    const { ui, pending } = gate()
    const session = createToolSession(broker, ui)

    const first = session.handle(command('c1'))
    await settled()
    pending[0].resolve('session')
    await first
    await session.handle(command('c2'))

    expect(ui.requestApproval).toHaveBeenCalledTimes(1)
    expect(broker).toHaveBeenLastCalledWith('run_command', '{"command":"git status"}', 'c2', true)
  })

  it('lets a session grant cover one tool, not its whole class', async () => {
    const broker = okBroker()
    const { ui, pending } = gate()
    const session = createToolSession(broker, ui)

    const first = session.handle(command('c1'))
    await settled()
    pending[0].resolve('session')
    await first
    const second = session.handle(toolEvent('c2', 'workspace_write', '{"path":"a","content":"b"}'))
    await settled()

    expect(ui.requestApproval).toHaveBeenCalledTimes(2)
    pending[1].resolve('deny')
    await second
  })

  it('never holds a call that only reads', async () => {
    const broker = okBroker()
    const { ui, pending } = gate()
    const session = createToolSession(broker, ui)

    await session.handle(toolEvent('c1', 'workspace_read', '{"path":"README.md"}'))
    await session.handle(toolEvent('c2', 'web_search', '{"query":"x"}'))

    expect(ui.requestApproval).not.toHaveBeenCalled()
    expect(pending).toEqual([])
    expect(broker).toHaveBeenLastCalledWith('web_search', '{"query":"x"}', 'c2', false)
  })

  it('follows the ask-before setting: commands only, or never', async () => {
    const broker = okBroker()
    const { ui } = gate()

    const commandsOnly = createToolSession(broker, ui, 'commands')
    await commandsOnly.handle(edit('c1'))
    expect(ui.requestApproval).not.toHaveBeenCalled()
    expect(broker).toHaveBeenLastCalledWith('workspace_edit', expect.any(String), 'c1', false)

    const never = createToolSession(broker, ui, 'never')
    await never.handle(command('c2'))
    expect(ui.requestApproval).not.toHaveBeenCalled()
    expect(broker).toHaveBeenLastCalledWith('run_command', expect.any(String), 'c2', false)
  })

  it('denies a gated call when there is no way to ask', async () => {
    const broker = okBroker()
    const ui = silentUi()
    const session = createToolSession(broker, ui)

    await session.handle(command('c1'))

    expect(broker).not.toHaveBeenCalled()
    expect(ui.onCallDone).toHaveBeenCalledWith('c1', 'denied', 'denied by the user', 0)
  })

  it('treats a wait cut short by cancel as cancelled: nothing runs', async () => {
    const broker = okBroker()
    const { ui } = gate()
    const session = createToolSession(broker, ui)

    const run = session.handle(command('c1'))
    await settled()
    session.cancel()
    await run

    expect(broker).not.toHaveBeenCalled()
    expect(ui.onCallDone).toHaveBeenCalledWith('c1', 'error', 'cancelled', 0)
    expect(session.extendHistory([], '')[1].content).toContain('cancelled')
  })
})
