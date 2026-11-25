import { describe, expect, it, vi } from 'vitest'
import { createToolSession, MAX_TOOL_ROUNDS } from './toolLoop'
import type { BrokerResult, ToolBroker } from './toolLoop'
import type { StreamEvent } from './types'

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
    expect(broker).toHaveBeenCalledWith('workspace_read', '{"path":"README.md"}', 'call_1')
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
    expect(MAX_TOOL_ROUNDS).toBeLessThanOrEqual(10)
  })
})
