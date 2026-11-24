import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SkillsService } from './service'
import type { Manifest } from './types'

const skill: Manifest = {
  id: 'test-skill',
  kind: 'skill',
  name: 'Test skill',
  description: 'test',
  version: '1.0.0',
  capabilities: ['chat'],
}

async function boot() {
  const root = new Context()
  const fiber = root.plugin(SkillsService)
  await fiber.await()
  return root.skills
}

describe('skills runtime', () => {
  it('registers synchronously when constructed', () => {
    const root = new Context()
    const service = new SkillsService(root)

    expect(root.skills).toBeDefined()
    service.grant('probe', 'files')
    expect(root.skills.granted('probe')).toEqual(['files'])
  })

  it('installs a manifest and disposes it exactly once', async () => {
    const skills = await boot()

    await skills.install(skill)
    expect(skills.isInstalled(skill.id)).toBe(true)
    expect(skills.installed()).toHaveLength(1)

    await skills.uninstall(skill.id)
    expect(skills.isInstalled(skill.id)).toBe(false)
    expect(skills.disposalCount()).toBe(1)
  })

  it('is idempotent on install', async () => {
    const skills = await boot()
    await skills.install(skill)
    await skills.install(skill)
    expect(skills.installed()).toHaveLength(1)
  })

  it('denies non-chat capabilities by default', async () => {
    const skills = await boot()
    const plugin: Manifest = {
      ...skill,
      id: 'file-plugin',
      kind: 'plugin',
      capabilities: ['files'],
    }

    await expect(skills.install(plugin)).rejects.toThrow('missing grants: files')
    expect(skills.isInstalled(plugin.id)).toBe(false)
  })

  it('installs after an explicit grant', async () => {
    const skills = await boot()
    const plugin: Manifest = {
      ...skill,
      id: 'file-plugin',
      kind: 'plugin',
      capabilities: ['files'],
    }

    skills.grant(plugin.id, 'files')
    await skills.install(plugin)

    expect(skills.isInstalled(plugin.id)).toBe(true)
    expect(skills.granted(plugin.id)).toEqual(['files'])
  })

  it('removes the manifest from the installed list', async () => {
    const skills = await boot()
    await skills.install(skill)
    await skills.uninstall(skill.id)
    expect(skills.installed()).toHaveLength(0)
    expect(skills.get(skill.id)).toBeUndefined()
  })
})
