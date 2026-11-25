import { describe, expect, it } from 'vitest'
import { startSubAgent, type AgentStream } from './agent'
import type { StreamEvent } from '../providers/types'
import type { Manifest } from './types'

const manifest: Manifest = {
  id: 'test-agent',
  kind: 'sub-agent',
  name: 'Test agent',
  description: 'test',
  version: '1.0.0',
  capabilities: ['chat'],
  budget: { maxTurns: 1, maxTokens: 100, maxMs: 5_000 },
  instructions: 'be brief',
}

const spec = {
  kind: 'openai',
  baseUrl: 'http://127.0.0.1:8787/v1',
}

describe('sub-agent run', () => {
  it('prepends room context ahead of the input', async () => {
    let seen: Array<{ role: string; content: string }> = []
    const stream: AgentStream = async (_spec, _model, messages, _system, onEvent) => {
      seen = messages
      onEvent({ type: 'token', text: 'ok' })
      onEvent({ type: 'done' })
    }

    const run = startSubAgent(
      {
        manifest,
        input: 'review this',
        context: [
          { role: 'user', content: 'question' },
          { role: 'assistant', content: 'the answer under review' },
        ],
        model: 'mock-fast',
        spec,
        handlers: { onToken: () => {}, onStatus: () => {} },
      },
      stream,
    )
    await run.finished

    expect(seen).toEqual([
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'the answer under review' },
      { role: 'user', content: 'review this' },
    ])
  })

  it('sends a bare input when no context is given', async () => {
    let seen: Array<{ role: string; content: string }> = []
    const stream: AgentStream = async (_spec, _model, messages, _system, onEvent) => {
      seen = messages
      onEvent({ type: 'done' })
    }

    const run = startSubAgent(
      {
        manifest,
        input: 'standalone prompt',
        model: 'mock-fast',
        spec,
        handlers: { onToken: () => {}, onStatus: () => {} },
      },
      stream,
    )
    await run.finished

    expect(seen).toEqual([{ role: 'user', content: 'standalone prompt' }])
  })

  it('is told what day it is, ahead of its instructions', async () => {
    let system: string | undefined
    const stream: AgentStream = async (_spec, _model, _messages, prompt, onEvent) => {
      system = prompt
      onEvent({ type: 'done' })
    }

    const run = startSubAgent(
      {
        manifest,
        input: 'hello',
        model: 'mock-fast',
        spec,
        handlers: { onToken: () => {}, onStatus: () => {} },
      },
      stream,
    )
    await run.finished

    expect(system).toMatch(/^Today is \w+, \d{1,2} \w+ \d{4}\. /)
    expect(system?.endsWith('be brief')).toBe(true)
  })

  it('cancel disposes the run once and drops late tokens', async () => {
    let emit: ((event: StreamEvent) => void) | undefined
    let unblock: (() => void) | undefined

    const stream: AgentStream = (_spec, _model, _messages, _system, onEvent) =>
      new Promise<void>((resolve) => {
        emit = onEvent
        unblock = resolve
      })

    let cleanups = 0
    let tokens = ''
    const statuses: string[] = []

    const run = startSubAgent(
      {
        manifest,
        input: 'hello',
        model: 'mock-fast',
        spec,
        handlers: {
          onToken: (text) => (tokens += text),
          onStatus: (status) => statuses.push(status),
        },
        onCleanup: () => (cleanups += 1),
      },
      stream,
    )

    emit!({ type: 'token', text: 'before' })
    expect(tokens).toBe('before')

    run.cancel()
    expect(run.closed).toBe(true)
    expect(statuses).toContain('error')

    emit!({ type: 'token', text: 'after' })
    unblock!()
    await run.finished

    expect(tokens).toBe('before')
    expect(cleanups).toBe(1)
  })

  it('closes once on natural completion', async () => {
    const stream: AgentStream = async (_spec, _model, _messages, _system, onEvent) => {
      onEvent({ type: 'token', text: 'ok' })
      onEvent({ type: 'done' })
    }

    let cleanups = 0
    let tokens = ''
    const run = startSubAgent(
      {
        manifest,
        input: 'hello',
        model: 'mock-fast',
        spec,
        handlers: {
          onToken: (text) => (tokens += text),
          onStatus: () => {},
        },
        onCleanup: () => (cleanups += 1),
      },
      stream,
    )

    await run.finished

    expect(tokens).toBe('ok')
    expect(cleanups).toBe(1)
    expect(run.closed).toBe(true)
  })

  it('stops delivering when the token budget is exceeded', async () => {
    const stream: AgentStream = async (_spec, _model, _messages, _system, onEvent) => {
      for (let i = 0; i < 200; i++) {
        onEvent({ type: 'token', text: 'xxxxx' })
      }
      onEvent({ type: 'done' })
    }

    let cleanups = 0
    let tokens = ''
    const statuses: string[] = []
    const run = startSubAgent(
      {
        manifest,
        input: 'hello',
        model: 'mock-fast',
        spec,
        handlers: {
          onToken: (text) => (tokens += text),
          onStatus: (status, detail) => statuses.push(`${status}:${detail ?? ''}`),
        },
        onCleanup: () => (cleanups += 1),
      },
      stream,
    )

    await run.finished

    expect(tokens.length).toBeLessThanOrEqual(100 * 4)
    expect(statuses.some((s) => s.includes('token budget'))).toBe(true)
    expect(cleanups).toBe(1)
  })
})
