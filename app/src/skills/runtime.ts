import { Context } from '@deepseek-ai/cordis'
import { SkillsService } from './service'

/**
 * One kernel per app. The service registers synchronously on construction, so
 * the room and settings can read `skills` without an async boot.
 */
export const kernel = new Context()
export const skills = new SkillsService(kernel)
