import { Context, Service } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    kernel: KernelService
  }
}

/**
 * The BELEN kernel is a Cordis service. Everything else — providers, rooms,
 * skills, sub-agents — is a plugin that injects it.
 */
export class KernelService extends Service {
  readonly bootedAt = performance.now()

  constructor(ctx: Context) {
    super(ctx, 'kernel')
  }

  status() {
    return { bootedAt: this.bootedAt, uptimeMs: performance.now() - this.bootedAt }
  }
}

export function bootKernel() {
  const root = new Context()
  const fiber = root.plugin(KernelService)
  return { root, fiber }
}
