import { createSignal, For, Show } from 'solid-js'
import { CATALOG } from './catalog'
import { skills } from './runtime'
import type { Capability } from './types'

type Props = {
  onChange: (ids: string[], grants: Record<string, Capability[]>) => void
}

export default function SkillsPanel(props: Props) {
  const [version, setVersion] = createSignal(0)

  const snapshot = () => {
    version()
    const ids = skills.installed().map((m) => m.id)
    const grants: Record<string, Capability[]> = {}
    for (const manifest of CATALOG) {
      const granted = skills.granted(manifest.id)
      if (granted.length) grants[manifest.id] = granted
    }
    return { ids, grants }
  }

  const toggle = async (id: string) => {
    const manifest = CATALOG.find((m) => m.id === id)
    if (!manifest) return

    if (skills.isInstalled(id)) {
      await skills.uninstall(id)
    } else {
      for (const capability of skills.missing(manifest)) {
        skills.grant(id, capability)
      }
      await skills.install(manifest)
    }

    setVersion((v) => v + 1)
    const next = snapshot()
    props.onChange(next.ids, next.grants)
  }

  return (
    <div class="skills-panel">
      <h1 class="lede">
        Skills that
        <br />
        stay reversible.
      </h1>
      <p class="body dim">
        Manifests only. Installing mounts a Cordis fiber; removing disposes it — no
        code, no leaked listeners. Non-chat capabilities are granted explicitly.
      </p>

      <div class="skill-list">
        <For each={CATALOG}>
          {(manifest) => {
            const installed = () => {
              version()
              return skills.isInstalled(manifest.id)
            }
            const missing = () => {
              version()
              return skills.missing(manifest)
            }

            return (
              <div class="skill-row">
                <div class="skill-main">
                  <div class="skill-head">
                    <span class="skill-name">{manifest.name}</span>
                    <span class="skill-kind">{manifest.kind}</span>
                    <For each={manifest.capabilities}>
                      {(capability) => <span class="cap">{capability}</span>}
                    </For>
                  </div>
                  <p class="skill-desc">{manifest.description}</p>
                  <Show when={!installed() && missing().length > 0}>
                    <span class="grant-note">needs {missing().join(', ')}</span>
                  </Show>
                </div>

                <button class="block-action" onClick={() => void toggle(manifest.id)}>
                  {installed()
                    ? 'Remove'
                    : missing().length > 0
                      ? 'Grant & install'
                      : 'Install'}
                </button>
              </div>
            )
          }}
        </For>
      </div>
    </div>
  )
}
