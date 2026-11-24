import { invoke } from '@tauri-apps/api/core'
import { discover, providerKey, testProvider, streamChat } from './client'
import { resolveSpec } from './auth'
import { createRoomStore } from '../room/store'
import type { ModelInfo, ProviderSpec, StreamEvent } from './types'

export async function runProbe() {
  const spec = await invoke<ProviderSpec & { mode?: string; model?: string }>('probe_read')

  if (spec.mode === 'live') {
    await runLiveProbe(spec)
    return
  }

  const models = await discover(spec)
  const model = models[0]?.id
  if (!model) throw new Error('mock provider returned no models')

  const test = await testProvider(spec, model)

  let rateLimit = false
  try {
    await testProvider(
      { kind: 'openai', baseUrl: 'http://127.0.0.1:8787/v1/ratelimit' },
      'mock-fast',
    )
  } catch (e) {
    rateLimit = String(e).includes('429')
  }

  let malformedTokens = 0
  let malformedDone = 0
  await streamChat(
    { kind: 'openai', baseUrl: 'http://127.0.0.1:8787/v1/bad' },
    'mock-fast',
    [{ role: 'user', content: 'x' }],
    undefined,
    (event) => {
      if (event.type === 'token') malformedTokens += 1
      if (event.type === 'done') malformedDone += 1
    },
  )
  const malformed = {
    tokens: malformedTokens,
    done: malformedDone,
    ok: malformedTokens === 0 && malformedDone === 1,
  }

  const device = await invoke<{
    deviceCode: string
    userCode: string
    verificationUri: string
    expiresIn: number
    interval: number
  }>('oauth_device_start', {
    req: {
      deviceEndpoint: 'http://127.0.0.1:8787/oauth/device',
      clientId: 'belen-test',
      scope: 'chat',
    },
  })

  const pollReq = (deviceCode: string) => ({
    req: {
      tokenEndpoint: 'http://127.0.0.1:8787/oauth/token',
      clientId: 'belen-test',
      deviceCode,
    },
  })

  const firstPoll = await invoke<{ status: string }>('oauth_device_poll', pollReq(device.deviceCode))
  const secondPoll = await invoke<{
    status: string
    tokens?: { accessToken: string; refreshToken?: string }
  }>('oauth_device_poll', pollReq(device.deviceCode))

  const refreshed = await invoke<{ accessToken: string }>('oauth_refresh', {
    req: {
      tokenEndpoint: 'http://127.0.0.1:8787/oauth/refresh',
      clientId: 'belen-test',
      refreshToken: secondPoll.tokens?.refreshToken ?? '',
    },
  })

  const authorized = await testProvider(
    {
      kind: 'openai',
      baseUrl: 'http://127.0.0.1:8787/v1/oauth',
      auth: 'bearer',
      apiKey: refreshed.accessToken,
    },
    'mock-fast',
  )

  let oauthRejects = false
  try {
    await testProvider({ kind: 'openai', baseUrl: 'http://127.0.0.1:8787/v1/oauth' }, 'mock-fast')
  } catch {
    oauthRejects = true
  }

  const oauth = {
    userCode: device.userCode,
    first: firstPoll.status,
    second: secondPoll.status,
    access: secondPoll.tokens?.accessToken,
    refreshed: refreshed.accessToken,
    authorized: authorized.text === 'oauth ok',
    rejectsWithoutToken: oauthRejects,
  }

  let errorPath = false
  try {
    await testProvider(
      { kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1' },
      'mock-fast',
    )
  } catch {
    errorPath = true
  }

  let text = ''
  const events: string[] = []
  await streamChat(spec, model, [{ role: 'user', content: 'hello' }], undefined, (event: StreamEvent) => {
    events.push(event.type)
    if (event.type === 'token') text += event.text
  })

  const result = {
    models: models.map((m) => ({ id: m.id, contextWindow: m.contextWindow })),
    test,
    text,
    tokenEvents: events.filter((e) => e === 'token').length,
    doneEvents: events.filter((e) => e === 'done').length,
    errorEvents: events.filter((e) => e === 'error').length,
    errorPath,
    rateLimit,
    malformed,
    oauth,
    db: await probeDb(),
  }

  await invoke('probe_write', { result })
  await invoke('exit_app')
}

async function runLiveProbe(spec: ProviderSpec & { model?: string }) {
  let models: ModelInfo[] = []
  let discoverError: string | null = null

  try {
    models = await discover(spec)
  } catch (e) {
    discoverError = String(e)
  }

  const model = spec.model || models[0]?.id || 'glm-5.3'
  const test = await testProvider(spec, model)

  let text = ''
  const events: string[] = []
  await streamChat(
    spec,
    model,
    [{ role: 'user', content: 'Reply with exactly: hello' }],
    undefined,
    (event) => {
      events.push(event.type)
      if (event.type === 'token') text += event.text
    },
  )

  const result = {
    mode: 'live',
    models: models.map((m) => m.id),
    discoverError,
    model,
    test,
    text,
    tokenEvents: events.filter((e) => e === 'token').length,
    doneEvents: events.filter((e) => e === 'done').length,
    errorEvents: events.filter((e) => e === 'error').length,
    saved: await saveRoundTrip(spec, model),
  }

  await invoke('probe_write', { result })
  await invoke('exit_app')
}

async function saveRoundTrip(spec: ProviderSpec, model: string) {
  const provider = {
    id: 'zai',
    label: 'Z.ai',
    kind: spec.kind,
    baseUrl: spec.baseUrl,
    model,
    temperature: 0.7,
    maxTokens: 4096,
    authMode: 'apiKey' as const,
    envVar: '',
    oauth: { clientId: '', deviceEndpoint: '', tokenEndpoint: '', scope: '' },
  }

  await invoke('config_set', { config: { provider } })
  const name = providerKey('zai')
  await invoke('key_set', { name, value: spec.apiKey ?? '' })

  const loaded = await invoke<{ provider?: typeof provider }>('config_get')
  const loadedKey = await invoke<string | null>('key_get', { name })

  let testOk = false
  let ttftMs = 0
  if (loaded.provider) {
    const savedSpec = await resolveSpec(loaded.provider)
    const savedTest = await testProvider(savedSpec, loaded.provider.model)
    testOk = savedTest.text.trim().length > 0
    ttftMs = savedTest.ttftMs
  }

  // Never leave the test key or config behind.
  await invoke('key_set', { name, value: '' })
  await invoke('config_set', { config: {} })

  return {
    configOk: loaded.provider?.model === model,
    keyOk: loadedKey === spec.apiKey,
    testOk,
    ttftMs,
  }
}

const round = (n: number) => Math.round(n * 100) / 100

async function probeDb() {
  const roomId = 'probe-room'
  const json = JSON.stringify({
    id: roomId,
    title: 'Probe',
    order: ['p1', 'p2'],
    byId: {
      p1: { id: 'p1', kind: 'user', text: 'hello database world', createdAt: 0 },
      p2: { id: 'p2', kind: 'assistant', text: 'the answer is 42', createdAt: 0 },
    },
  })

  await invoke('room_save', { roomId, json })
  const loaded = await invoke<string | null>('room_load', { roomId })
  const hits = await invoke<Array<{ id: string; snippet: string }>>('room_search', {
    query: 'database',
  })
  const exportPath = await invoke<string>('export_file', {
    name: 'probe-export.md',
    contents: '# probe export',
  })

  const temp = createRoomStore()
  temp.hydrate(JSON.parse(json))
  const roundTrip = JSON.stringify(temp.snapshot()) === json

  const big = {
    id: 'probe-big',
    title: 'Probe big',
    order: [] as string[],
    byId: {} as Record<string, unknown>,
  }
  for (let i = 0; i < 10_000; i++) {
    const id = `p${i}`
    big.order.push(id)
    big.byId[id] = {
      id,
      kind: 'text',
      text: `block ${i} lorem ipsum ${i % 97}`,
      createdAt: 0,
    }
  }
  const bigJson = JSON.stringify(big)

  const saveStart = performance.now()
  await invoke('room_save', { roomId: 'probe-big', json: bigJson })
  const saveMs = performance.now() - saveStart

  const searchStart = performance.now()
  const bigHits = await invoke<Array<{ id: string; snippet: string }>>('room_search', {
    query: 'lorem',
  })
  const searchMs = performance.now() - searchStart

  const loadedBig = await invoke<string | null>('room_load', { roomId: 'probe-big' })
  const bigRoundTrip = loadedBig === bigJson

  return {
    loadedMatches: loaded === json,
    roundTrip,
    hits: hits.length,
    firstHit: hits[0]?.id ?? null,
    exportPath,
    big: {
      blocks: 10_000,
      saveMs: round(saveMs),
      searchMs: round(searchMs),
      hits: bigHits.length,
      roundTrip: bigRoundTrip,
    },
  }
}
