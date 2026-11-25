import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { invoke } from '@tauri-apps/api/core'
import { knownModels, PROVIDERS } from '../providers/registry'
import {
  discover,
  loadDefaultWorkspace,
  providerKey,
  providerOAuthKey,
  saveConfig,
  testProvider,
} from '../providers/client'
import { loadOAuth } from '../providers/auth'
import {
  ASK_BEFORE_OPTIONS,
  CHAT_WIDTHS,
  toolsOf,
  withChatWidth,
  withTools,
  widthOf,
  withWorkspace,
} from '../providers/config'
import type {
  AppConfig,
  AuthMode,
  ChatWidth,
  DeviceStart,
  ModelInfo,
  TestResult,
  TokenPoll,
  ToolsConfig,
} from '../providers/types'
import SkillsPanel from '../skills/SkillsPanel'
import UpdatePanel from '../update/UpdatePanel'
import type { Capability } from '../skills/types'

type Props = {
  config: AppConfig | null
  onClose: () => void
  onSaved: (config: AppConfig) => void
  onChange?: (config: AppConfig) => void
  initialTab?: 'provider' | 'chat' | 'skills' | 'about'
  onBeforeRestart?: () => void
  autoCheck?: boolean
}

const ENV_DEFAULTS: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GEMINI_API_KEY',
  ollama: 'OLLAMA_API_KEY',
  lmstudio: 'LMSTUDIO_API_KEY',
}

const defaultEnv = (kind: string) => ENV_DEFAULTS[kind] ?? 'API_KEY'

export default function Settings(props: Props) {
  const [selected, setSelected] = createSignal<string | null>(null)
  const [baseUrl, setBaseUrl] = createSignal('')
  const [apiKey, setApiKey] = createSignal('')
  const [kind, setKind] = createSignal('openai')
  const [authMode, setAuthMode] = createSignal<AuthMode>('apiKey')
  const [envVar, setEnvVar] = createSignal('OPENAI_API_KEY')
  const [models, setModels] = createSignal<ModelInfo[]>([])
  const [model, setModel] = createSignal('')
  const [temperature, setTemperature] = createSignal(0.7)
  const [maxTokens, setMaxTokens] = createSignal(4096)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [notice, setNotice] = createSignal<string | null>(null)
  const [test, setTest] = createSignal<TestResult | null>(null)
  const [tab, setTab] = createSignal<'provider' | 'chat' | 'skills' | 'about'>(
    props.initialTab ?? 'provider',
  )
  const [workspaceField, setWorkspaceField] = createSignal(props.config?.workspace ?? '')
  /** The workspace when the field is empty: the user's home folder. */
  const [defaultWorkspace, setDefaultWorkspace] = createSignal('')
  const switches = () => toolsOf(props.config)

  const [oauthClientId, setOauthClientId] = createSignal('')
  const [deviceEndpoint, setDeviceEndpoint] = createSignal('')
  const [tokenEndpoint, setTokenEndpoint] = createSignal('')
  const [scope, setScope] = createSignal('')
  const [device, setDevice] = createSignal<DeviceStart | null>(null)
  const [oauthStatus, setOauthStatus] = createSignal<string | null>(null)
  const [oauthAccess, setOauthAccess] = createSignal<string | null>(null)

  let disposed = false

  const provider = () => PROVIDERS.find((p) => p.id === selected()) ?? null

  createEffect(() => {
    const p = provider()
    if (p) setKind(p.kind)
  })

  const openExisting = async () => {
    const saved = props.config?.provider
    if (!saved) return

    setSelected(saved.id)
    setBaseUrl(saved.baseUrl)
    setKind(saved.kind)
    setModel(saved.model)
    setTemperature(saved.temperature)
    setMaxTokens(saved.maxTokens)
    setAuthMode(saved.authMode ?? 'apiKey')
    setEnvVar(saved.envVar ?? defaultEnv(saved.kind))

    if (saved.oauth) {
      setOauthClientId(saved.oauth.clientId)
      setDeviceEndpoint(saved.oauth.deviceEndpoint)
      setTokenEndpoint(saved.oauth.tokenEndpoint)
      setScope(saved.oauth.scope)
    }

    if ((saved.authMode ?? 'apiKey') === 'oauth') {
      const tokens = await loadOAuth(saved.id)
      setOauthAccess(tokens?.accessToken ?? null)
      if (tokens) setOauthStatus('Connected')
    } else {
      const key = await invoke<string | null>('key_get', { name: providerKey(saved.id) })
      setApiKey(key ?? '')
    }

    setModels([{ id: saved.model, label: saved.model }])
  }

  if (props.config?.provider) void openExisting()

  const choose = (id: string) => {
    const p = PROVIDERS.find((x) => x.id === id)
    setSelected(id)
    setError(null)
    setNotice(null)
    setTest(null)
    setModels([])
    setAuthMode('apiKey')
    setOauthClientId('')
    setDeviceEndpoint('')
    setTokenEndpoint('')
    setScope('')
    setDevice(null)
    setOauthStatus(null)
    setOauthAccess(null)

    if (p) {
      setBaseUrl(p.baseUrl)
      setKind(p.kind)
      setEnvVar(defaultEnv(p.kind))
      if (p.auth === 'none') setApiKey('')
    }
    if (id === 'custom') {
      setBaseUrl('')
      setKind('openai')
      setEnvVar(defaultEnv('openai'))
    }
  }

  const spec = () => {
    const mode = authMode()
    if (mode === 'env') {
      return {
        kind: kind(),
        baseUrl: baseUrl().trim(),
        auth: 'env',
        envVar: envVar().trim(),
      }
    }
    if (mode === 'oauth') {
      return {
        kind: kind(),
        baseUrl: baseUrl().trim(),
        auth: 'bearer',
        apiKey: oauthAccess() ?? undefined,
      }
    }
    return {
      kind: kind(),
      baseUrl: baseUrl().trim(),
      auth: mode === 'bearer' ? 'bearer' : 'apiKey',
      apiKey: apiKey().trim() || undefined,
    }
  }

  const ensureAuth = () => {
    if (authMode() === 'oauth' && !oauthAccess()) {
      setNotice('Connect OAuth before testing or discovering.')
      return false
    }
    return true
  }

  const runDiscover = async () => {
    if (!ensureAuth()) return
    setBusy(true)
    setError(null)
    setTest(null)
    setNotice(null)
    try {
      const list = await discover(spec())
      setModels(list)
      if (!model()) {
        const current = provider()
        const preferred = current ? knownModels(current) : []
        const pick = preferred.find((p) => list.some((m) => m.id === p.id))
        setModel(pick?.id ?? list[0]?.id ?? '')
      }
    } catch (e) {
      const current = provider()
      const fallback = current ? knownModels(current) : []
      if (current && fallback.length) {
        setModels(fallback)
        if (!model()) setModel(fallback[0].id)
        setNotice(`Discovery unavailable — using ${current.label}'s known models.`)
      } else {
        setError(String(e))
      }
    } finally {
      setBusy(false)
    }
  }

  const runTest = async () => {
    if (!model() || !ensureAuth()) return
    setBusy(true)
    setError(null)
    setTest(null)
    try {
      setTest(await testProvider(spec(), model()))
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const connectOAuth = async () => {
    const id = selected()
    if (!id || !oauthClientId().trim() || !deviceEndpoint().trim() || !tokenEndpoint().trim()) {
      return
    }

    setBusy(true)
    setError(null)
    setNotice(null)
    setDevice(null)
    setOauthStatus('Starting…')

    try {
      const start = await invoke<DeviceStart>('oauth_device_start', {
        req: {
          deviceEndpoint: deviceEndpoint().trim(),
          clientId: oauthClientId().trim(),
          scope: scope().trim(),
        },
      })
      setDevice(start)
      setOauthStatus(`Enter ${start.userCode}`)

      let interval = Math.max(1, start.interval) * 1000
      const deadline = Date.now() + start.expiresIn * 1000

      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, interval))
        if (disposed || selected() !== id) return

        const poll = await invoke<TokenPoll>('oauth_device_poll', {
          req: {
            tokenEndpoint: tokenEndpoint().trim(),
            clientId: oauthClientId().trim(),
            deviceCode: start.deviceCode,
          },
        })

        if (poll.status === 'ok' && poll.tokens) {
          const tokens = {
            accessToken: poll.tokens.accessToken,
            refreshToken: poll.tokens.refreshToken,
            expiresAt: poll.tokens.expiresIn
              ? Date.now() + poll.tokens.expiresIn * 1000
              : undefined,
          }
          await invoke('key_set', {
            name: providerOAuthKey(id),
            value: JSON.stringify(tokens),
          })
          setOauthAccess(tokens.accessToken)
          setOauthStatus('Connected')
          setDevice(null)
          return
        }

        if (poll.status === 'pending') continue
        if (poll.status === 'slow_down') {
          interval += 5000
          continue
        }

        setOauthStatus(`Failed: ${poll.status}${poll.error ? ` — ${poll.error}` : ''}`)
        return
      }

      setOauthStatus('Code expired — start again')
    } catch (e) {
      setOauthStatus(null)
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    const id = selected()
    if (!id) return

    if (authMode() === 'oauth' && !oauthAccess()) {
      setNotice('Connect OAuth before saving.')
      return
    }

    setBusy(true)
    setError(null)
    setNotice(null)

    try {
      let chosen = model()

      // Save used to be disabled without a model, which looked like a dead button.
      // Now it discovers the list, preferring the newest known model.
      if (!chosen) {
        setNotice('Finding a model…')

        let list: ModelInfo[] = []
        try {
          list = await discover(spec())
        } catch (e) {
          const current = provider()
          const fallback = current ? knownModels(current) : []
          if (!current || !fallback.length) throw e
          list = fallback
          setNotice(`Discovery unavailable — using ${current.label}'s known models.`)
        }

        setModels(list)
        const current = provider()
        const preferred = current ? knownModels(current) : []
        const pick = preferred.find((p) => list.some((m) => m.id === p.id))
        chosen = pick?.id ?? list[0]?.id ?? ''

        if (!chosen) {
          setNotice('No models returned — check the key and endpoint.')
          return
        }
        setModel(chosen)
      }

      // Merge over the saved config: replacing it wholesale would wipe
      // skills, grants, and the chat settings.
      const next: AppConfig = {
        ...(props.config ?? {}),
        provider: {
          id,
          label: provider()?.label ?? 'Custom provider',
          kind: kind(),
          baseUrl: baseUrl().trim(),
          model: chosen,
          temperature: temperature(),
          maxTokens: maxTokens(),
          authMode: authMode(),
          envVar: envVar().trim(),
          oauth: {
            clientId: oauthClientId().trim(),
            deviceEndpoint: deviceEndpoint().trim(),
            tokenEndpoint: tokenEndpoint().trim(),
            scope: scope().trim(),
          },
        },
      }

      await invoke('config_set', { config: next })

      if ((authMode() === 'apiKey' || authMode() === 'bearer') && apiKey().trim()) {
        await invoke('key_set', { name: providerKey(id), value: apiKey().trim() })
      }

      setNotice(null)
      props.onSaved(next)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const onSkillsChanged = async (
    ids: string[],
    grants: Record<string, Capability[]>,
  ) => {
    const next: AppConfig = { ...(props.config ?? {}), skills: ids, grants }
    await saveConfig(next)
    props.onChange?.(next)
  }

  const changeWidth = async (width: ChatWidth) => {
    const next = withChatWidth(props.config, width)
    await saveConfig(next)
    props.onChange?.(next)
  }

  const changeWorkspace = async (raw: string) => {
    setWorkspaceField(raw)
    const next = withWorkspace(props.config, raw)
    await saveConfig(next)
    props.onChange?.(next)
  }

  const changeTools = async (patch: Partial<ToolsConfig>) => {
    const next = withTools(props.config, patch)
    await saveConfig(next)
    props.onChange?.(next)
  }

  onMount(() => {
    void loadDefaultWorkspace().then(
      (home) => setDefaultWorkspace(home),
      () => {},
    )
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => {
      disposed = true
      window.removeEventListener('keydown', onKey)
    })
  })

  return (
    <div
      class="settings"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <div class="settings-panel">
        <header class="settings-head">
          <span class="wordmark">BELEN</span>
          <button class="block-action" onClick={props.onClose}>
            Close
          </button>
        </header>

        <div class="settings-tabs">
          <button
            classList={{ active: tab() === 'provider' }}
            onClick={() => setTab('provider')}
          >
            Provider
          </button>
          <button
            classList={{ active: tab() === 'chat' }}
            onClick={() => setTab('chat')}
          >
            Chat
          </button>
          <button
            classList={{ active: tab() === 'skills' }}
            onClick={() => setTab('skills')}
          >
            Skills
          </button>
          <button
            classList={{ active: tab() === 'about' }}
            onClick={() => setTab('about')}
          >
            About
          </button>
        </div>

        <Show when={tab() === 'chat'}>
          <h2 class="settings-title">Chat</h2>

          <label class="field">
            <span class="field-label">Conversation width</span>
            <div class="width-options" role="group" aria-label="Conversation width">
              <For each={CHAT_WIDTHS}>
                {(w) => (
                  <button
                    class="width-option"
                    classList={{ active: widthOf(props.config) === w.id }}
                    onClick={() => void changeWidth(w.id)}
                  >
                    {w.label}
                  </button>
                )}
              </For>
              <button class="width-reset" onClick={() => void changeWidth('default')}>
                Reset
              </button>
            </div>
            <p class="hint-line">
              Applies to the conversation column. Default keeps the classic 66-character
              measure; oversized tables, charts and code scroll inside their own containers.
            </p>
          </label>

          <label class="field">
            <span class="field-label">Workspace</span>
            <input
              class="field-input"
              value={workspaceField()}
              onChange={(e) => void changeWorkspace(e.currentTarget.value)}
              placeholder={defaultWorkspace() || 'C:\\path\\to\\workspace  ·  /path/to/workspace'}
              spellcheck={false}
            />
            <p class="hint-line">
              Folder the assistant works in with her file tools (list, read, search) and her
              commands. Leave it empty to use your home folder. Paths outside it and credential
              files (.env, keys, the key store) are refused by a Rust broker.
            </p>
          </label>

          <div class="field">
            <span class="field-label">Tools</span>
            <label class="tool-switch">
              <input
                type="checkbox"
                checked={switches().network}
                onChange={(e) => void changeTools({ network: e.currentTarget.checked })}
              />
              <span>Web: search the web and read pages</span>
            </label>
            <label class="tool-switch">
              <input
                type="checkbox"
                checked={switches().files === 'write'}
                onChange={(e) =>
                  void changeTools({ files: e.currentTarget.checked ? 'write' : 'read' })
                }
              />
              <span>Change files: create and edit files in the workspace</span>
            </label>
            <label class="tool-switch">
              <input
                type="checkbox"
                checked={switches().shell}
                onChange={(e) => void changeTools({ shell: e.currentTarget.checked })}
              />
              <span>Run commands: PowerShell on Windows, zsh on macOS</span>
            </label>
            <p class="hint-line">
              On until you turn them off. Web search needs no key: it reads Bing's results page,
              which the engine can refuse. Commands and file changes are real: nothing is
              sandboxed, and by default each one waits for you in the room.
            </p>
          </div>

          <div class="field">
            <span class="field-label">Ask before</span>
            <For each={ASK_BEFORE_OPTIONS}>
              {(option) => (
                <label class="tool-switch">
                  <input
                    type="radio"
                    name="ask-before"
                    checked={switches().askBefore === option.id}
                    onChange={() => void changeTools({ askBefore: option.id })}
                  />
                  <span>{option.label}</span>
                </label>
              )}
            </For>
            <p class="hint-line">Which calls wait for you in the room before they run.</p>
          </div>
        </Show>

        <Show when={tab() === 'provider'}>
          <Show when={!selected()}>
            <h1 class="lede">
              Who do you
              <br />
              inference with?
            </h1>
            <p class="body dim">
              Pick a provider. BELEN pulls its models and settings automatically.
            </p>

            <div class="provider-list">
              <For each={PROVIDERS}>
                {(p) => (
                  <button class="provider-row" onClick={() => choose(p.id)}>
                    <span class="provider-name">{p.label}</span>
                    <span class="provider-blurb">{p.blurb}</span>
                    <span class="provider-arrow">→</span>
                  </button>
                )}
              </For>
              <button class="provider-row" onClick={() => choose('custom')}>
                <span class="provider-name">Something else</span>
                <span class="provider-blurb">
                  Any OpenAI-compatible, Anthropic or Google endpoint
                </span>
                <span class="provider-arrow">→</span>
              </button>
            </div>
          </Show>

          <Show when={selected()}>
            <button class="back-link" onClick={() => setSelected(null)}>
              ← All providers
            </button>
            <h2 class="settings-title">{provider()?.label ?? 'Custom provider'}</h2>

            <label class="field">
              <span class="field-label">Endpoint</span>
              <input
                class="field-input"
                value={baseUrl()}
                onInput={(e) => setBaseUrl(e.currentTarget.value)}
                placeholder="https://api.example.com/v1"
              />
            </label>

            <Show when={selected() === 'custom'}>
              <label class="field">
                <span class="field-label">Protocol</span>
                <select
                  class="field-input"
                  value={kind()}
                  onChange={(e) => setKind(e.currentTarget.value)}
                >
                  <option value="openai">OpenAI-compatible</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="google">Google</option>
                </select>
              </label>
            </Show>

            <label class="field">
              <span class="field-label">Authentication</span>
              <select
                class="field-input"
                value={authMode()}
                onChange={(e) => setAuthMode(e.currentTarget.value as AuthMode)}
              >
                <option value="apiKey">API key</option>
                <option value="bearer">Access token (bearer)</option>
                <option value="env">Environment variable</option>
                <option value="oauth">OAuth device code</option>
              </select>
            </label>

            <Show when={authMode() === 'apiKey' || authMode() === 'bearer'}>
              <label class="field">
                <span class="field-label">
                  {authMode() === 'bearer'
                    ? 'Access token'
                    : `API key ${provider()?.auth === 'none' ? '(optional)' : ''}`}
                </span>
                <input
                  class="field-input"
                  type="password"
                  value={apiKey()}
                  onInput={(e) => setApiKey(e.currentTarget.value)}
                  placeholder={authMode() === 'bearer' ? 'eyJ…' : 'sk-…'}
                />
              </label>
            </Show>

            <Show when={authMode() === 'env'}>
              <label class="field">
                <span class="field-label">Environment variable</span>
                <input
                  class="field-input"
                  value={envVar()}
                  onInput={(e) => setEnvVar(e.currentTarget.value)}
                  placeholder="OPENAI_API_KEY"
                />
              </label>
              <p class="hint-line">
                Read at request time by the Rust core. Nothing is written to disk.
              </p>
            </Show>

            <Show when={authMode() === 'oauth'}>
              <div class="field-grid">
                <label class="field">
                  <span class="field-label">Client ID</span>
                  <input
                    class="field-input"
                    value={oauthClientId()}
                    onInput={(e) => setOauthClientId(e.currentTarget.value)}
                    placeholder="public client id"
                  />
                </label>
                <label class="field">
                  <span class="field-label">Scope</span>
                  <input
                    class="field-input"
                    value={scope()}
                    onInput={(e) => setScope(e.currentTarget.value)}
                    placeholder="api://…/.default offline_access"
                  />
                </label>
              </div>

              <label class="field">
                <span class="field-label">Device endpoint</span>
                <input
                  class="field-input"
                  value={deviceEndpoint()}
                  onInput={(e) => setDeviceEndpoint(e.currentTarget.value)}
                  placeholder="https://…/devicecode"
                />
              </label>

              <label class="field">
                <span class="field-label">Token endpoint</span>
                <input
                  class="field-input"
                  value={tokenEndpoint()}
                  onInput={(e) => setTokenEndpoint(e.currentTarget.value)}
                  placeholder="https://…/token"
                />
              </label>

              <div class="settings-row">
                <button
                  class="block-action"
                  onClick={connectOAuth}
                  disabled={
                    busy() ||
                    !oauthClientId().trim() ||
                    !deviceEndpoint().trim() ||
                    !tokenEndpoint().trim()
                  }
                >
                  {oauthAccess() ? 'Reconnect' : 'Connect'}
                </button>
                <Show when={oauthStatus()}>
                  <span class="status-line">{oauthStatus()}</span>
                </Show>
              </div>

              <Show when={device()}>
                <div class="device-box">
                  <span class="field-label">Code</span>
                  <span class="device-code">{device()!.userCode}</span>
                  <a
                    class="device-link"
                    href={device()!.verificationUriComplete ?? device()!.verificationUri}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {device()!.verificationUri}
                  </a>
                </div>
              </Show>
            </Show>

            <div class="settings-row">
              <button class="block-action" onClick={runDiscover} disabled={busy()}>
                {busy() ? 'Working…' : 'Discover models'}
              </button>
              <Show when={test()}>
                <span class="status-line">
                  TTFT {test()!.ttftMs} ms · {test()!.text || 'ok'}
                </span>
              </Show>
            </div>

            <Show when={notice()}>
              <p class="notice-line">{notice()}</p>
            </Show>

            <Show when={models().length > 0}>
              <label class="field">
                <span class="field-label">Model</span>
                <select
                  class="field-input"
                  value={model()}
                  onChange={(e) => setModel(e.currentTarget.value)}
                >
                  <For each={models()}>{(m) => <option value={m.id}>{m.label}</option>}</For>
                </select>
              </label>
            </Show>

            <div class="field-grid">
              <label class="field">
                <span class="field-label">Temperature · {temperature().toFixed(2)}</span>
                <input
                  class="field-range"
                  type="range"
                  min="0"
                  max="2"
                  step="0.05"
                  value={temperature()}
                  onInput={(e) => setTemperature(Number(e.currentTarget.value))}
                />
              </label>
              <label class="field">
                <span class="field-label">Max tokens</span>
                <input
                  class="field-input"
                  type="number"
                  value={maxTokens()}
                  onInput={(e) => setMaxTokens(Number(e.currentTarget.value))}
                />
              </label>
            </div>

            <Show when={error()}>
              <p class="error-line">{error()}</p>
            </Show>

            <Show when={!model()}>
              <p class="hint-line">
                No model selected — Save will discover one automatically.
              </p>
            </Show>

            <div class="settings-actions">
              <button class="block-action" onClick={runTest} disabled={busy() || !model()}>
                Test
              </button>
              <button class="primary-action" onClick={save} disabled={busy()}>
                {busy() ? 'Saving…' : 'Save'}
              </button>
            </div>
          </Show>
        </Show>

        <Show when={tab() === 'skills'}>
          <SkillsPanel onChange={(ids, grants) => void onSkillsChanged(ids, grants)} />
        </Show>

        <Show when={tab() === 'about'}>
          <UpdatePanel
            onBeforeRestart={() => props.onBeforeRestart?.()}
            autoCheck={props.autoCheck}
          />
        </Show>
      </div>
    </div>
  )
}
