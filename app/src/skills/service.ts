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
