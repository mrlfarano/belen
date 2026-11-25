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

describe('restoring skills at start', () => {
  const plugin: Manifest = { ...skill, id: 'file-plugin', kind: 'plugin', capabilities: ['files'] }
  const installed = (skills: SkillsService) => skills.installed().map((m) => m.id)

  it('before anyone chose skills, installs every built-in one with what it needs', async () => {
    const skills = await boot()
    await skills.restore(undefined, undefined, [skill, plugin])
    expect(installed(skills)).toEqual(['test-skill', 'file-plugin'])
    expect(skills.granted('file-plugin')).toEqual(['files'])
  })

  it('keeps a saved list as it is, even an empty one', async () => {
    const skills = await boot()
    await skills.restore([], undefined, [skill, plugin])
    expect(installed(skills)).toEqual([])

    await skills.restore([skill.id], undefined, [skill, plugin])
    expect(installed(skills)).toEqual([skill.id])
  })

  it('does not grant a saved skill what was never granted', async () => {
    const skills = await boot()
    await skills.restore([plugin.id], undefined, [plugin])
    expect(installed(skills)).toEqual([])
  })

  it('restores the saved grants first', async () => {
    const skills = await boot()
    await skills.restore([plugin.id], { [plugin.id]: ['files'] }, [plugin])
    expect(installed(skills)).toEqual([plugin.id])
  })
})
