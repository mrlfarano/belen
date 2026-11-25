import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import type { Capability, Manifest } from './types'

declare module '@deepseek-ai/cordis' {
  interface Context {
    skills: SkillsService
  }
}

/**
 * Manifests are data, never code. Installing one mounts a Cordis fiber; the
 * fiber owns the reversible effect, so uninstalling cannot leak listeners.
 */
export class SkillsService extends Service {
  private fibers = new Map<string, Fiber>()
  private manifests = new Map<string, Manifest>()
  private grants = new Map<string, Set<Capability>>()
  private disposals = 0

  constructor(ctx: Context) {
    super(ctx, 'skills')
  }

  installed(): Manifest[] {
    return [...this.manifests.values()]
  }

  get(id: string): Manifest | undefined {
    return this.manifests.get(id)
  }

  isInstalled(id: string): boolean {
    return this.fibers.has(id)
  }

  granted(id: string): Capability[] {
    return [...(this.grants.get(id) ?? [])]
  }

  grant(id: string, capability: Capability): void {
    const set = this.grants.get(id) ?? new Set<Capability>()
    set.add(capability)
    this.grants.set(id, set)
  }

  /** Capabilities a manifest still needs before it can install. */
  missing(manifest: Manifest): Capability[] {
    const granted = this.grants.get(manifest.id) ?? new Set<Capability>()
    return manifest.capabilities.filter((c) => c !== 'chat' && !granted.has(c))
  }

  /**
   * Installs the skills an install had: the ones saved in config, or — before
   * anyone has chosen any — every manifest in `catalog`, with the capabilities
   * each needs. A saved list is kept as it is, even an empty one.
   */
  async restore(
    saved: string[] | undefined,
    grants: Record<string, string[]> | undefined,
    catalog: Manifest[],
  ): Promise<void> {
    for (const [id, caps] of Object.entries(grants ?? {})) {
      for (const capability of caps) this.grant(id, capability as Capability)
    }
    // The built-ins are this app's own code, so choosing them for the user
    // means granting what they ask for.
    const firstRun = saved === undefined
    for (const manifest of catalog) {
      if (!firstRun && !saved.includes(manifest.id)) continue
      if (firstRun) {
        for (const capability of this.missing(manifest)) this.grant(manifest.id, capability)
      }
      try {
        await this.install(manifest)
      } catch {
        /* missing grant — the skills panel will ask again */
      }
    }
  }

  async install(manifest: Manifest): Promise<void> {
    if (this.fibers.has(manifest.id)) return

    const missing = this.missing(manifest)
    if (missing.length) {
      throw new Error(`missing grants: ${missing.join(', ')}`)
    }

    const fiber = this.ctx.plugin((ctx) => {
      ctx.effect(() => () => {
        this.disposals += 1
      })
    })

    await fiber.await()
    this.fibers.set(manifest.id, fiber)
    this.manifests.set(manifest.id, manifest)
  }

  async uninstall(id: string): Promise<void> {
    const fiber = this.fibers.get(id)
    if (!fiber) return
    await fiber.dispose()
    this.fibers.delete(id)
    this.manifests.delete(id)
  }

  /** Test/diagnostic counter: every uninstall must run exactly one teardown. */
  disposalCount(): number {
    return this.disposals
  }
}
