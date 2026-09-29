import type { Skill, SkillContext, SkillResult } from './skill.js'

/**
 * SkillRegistry：能力注册表。
 *
 * 替代 ActionExecutor 中的 switch 语句。
 * 能力提供者只需注册一次，调用方按名称查询即可。
 *
 * 初始化：
 *   registry.register(new MusicQueueBuilderSkill())
 *   registry.register(new DjSpeechSkill())
 *
 * 调用：
 *   const skill = registry.get('music_queue_builder')
 *   const result = await skill.execute(input, context)
 */
export class SkillRegistry {
  private readonly skills = new Map<string, Skill>()

  register(skill: Skill<any, any>): void {
    this.skills.set(skill.name, skill)
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name)
  }

  has(name: string): boolean {
    return this.skills.has(name)
  }

  /**
   * 按能力名称查找并执行。
   * 如果未注册，返回 failed 结果。
   */
  async execute(
    name: string,
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const skill = this.skills.get(name)
    if (!skill) {
      return {
        status: 'failed',
        error: { code: 'SKILL_NOT_FOUND', message: `Skill "${name}" is not registered.` },
      }
    }
    return skill.execute(input, context) as Promise<SkillResult>
  }

  /**
   * 列出所有已注册的能力名称。
   */
  listSkills(): string[] {
    return [...this.skills.keys()]
  }

  /**
   * 获取能力数量。
   */
  get size(): number {
    return this.skills.size
  }
}
