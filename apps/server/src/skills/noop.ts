import type { Skill, SkillResult, SkillContext } from './skill.js'

/**
 * NoopSkill：占位能力。当 DecisionEngine 确定无需任何操作时使用。
 * 避免 ActionExecutor 对 "空动作" 做特殊判断。
 */
export class NoopSkill implements Skill<Record<string, never>, { ok: boolean }> {
  name = 'noop'
  description = 'No operation. Used when the DecisionEngine determines no action is needed.'
  tags = ['system', 'noop']
  inputSchema = {}

  async execute(_input: Record<string, never>, _context: SkillContext): Promise<SkillResult<{ ok: boolean }>> {
    return { status: 'success', data: { ok: true } }
  }
}
