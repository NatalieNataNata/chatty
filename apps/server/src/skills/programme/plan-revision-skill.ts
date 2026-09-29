import type { PlanRevision } from '../../types.js'
import type { Skill, SkillResult, SkillContext } from '../skill.js'
import { applyRevision } from '../../runtime/plan-revision.js'

export interface PlanRevisionInput {
  revision: PlanRevision
}

export interface PlanRevisionOutput {
  updated: boolean
}

/**
 * PlanRevisionSkill：将 PlanRevision 应用到当前 RadioPlan。
 *
 * V2.2 迁移：从 ActionExecutor 的 applyRevision 直接调用
 * 提升为 Skill，使计划修改变为可注册能力。
 */
export class PlanRevisionSkill implements Skill<PlanRevisionInput, PlanRevisionOutput> {
  name = 'plan_revision'
  description = 'Apply a PlanRevision to the current RadioPlan. Modifies segment parameters (energy, query, etc.) at runtime.'
  tags = ['programme', 'revision', 'planning']
  inputSchema = { revision: 'PlanRevision' }

  async execute(input: PlanRevisionInput, context: SkillContext): Promise<SkillResult<PlanRevisionOutput>> {
    if (!input.revision) {
      return { status: 'failed', error: { code: 'INVALID_INPUT', message: 'revision is required.' } }
    }

    const plan = context.state?.getCurrentPlan()
    if (!plan) {
      return { status: 'failed', error: { code: 'NO_ACTIVE_PLAN', message: 'No active plan to revise.' } }
    }

    const updated = applyRevision(plan, input.revision)
    context.state?.setCurrentPlan(updated)
    context.broadcaster?.emitPlan(updated)
    return { status: 'success', data: { updated: true } }
  }
}
