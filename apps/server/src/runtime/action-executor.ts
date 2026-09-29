import type { ActionExecutorDeps, ActionResult, RuntimeAction } from '../types.js'
import type { SkillContext } from '../skills/skill.js'
import { getActionPolicy, shouldRetry, hasFallback } from './action-policy.js'

/**
 * ActionExecutor：唯一职责是从 SkillRegistry 找到能力并执行。
 *
 * V2.1 重构后不再有 switch 语句。
 * 它不知道任何具体能力的存在——只做四件事：
 *   1. 按 capability 名称查 SkillRegistry
 *   2. 找不到返回 SKILL_NOT_FOUND
 *   3. 找到就执行
 *   4. 失败时重试 / 降级
 *
 * 这标志着 ActionExecutor 从 "能力地图" 变成了 "纯路由层"。
 */
export class ActionExecutor {
  constructor(private readonly deps: ActionExecutorDeps) {}

  async execute(action: RuntimeAction, skillContext?: Partial<SkillContext>): Promise<ActionResult> {
    const policy = getActionPolicy(action)
    let retryCount = 0

    while (true) {
      const result = await this.executeOnce(action, skillContext)

      if (result.status === 'success') return result

      if (shouldRetry(result, retryCount, policy)) {
        retryCount++
        continue
      }

      this.deps.onActionFailed?.(action.capability, result.error?.message ?? 'Execution failed')

      if (hasFallback(policy) && policy.fallbackActions) {
        const fallback = policy.fallbackActions[0]
        const fbResult = await this.executeOnce(fallback, skillContext)
        return { ...fbResult, actionType: action.capability }
      }

      return result
    }
  }

  private async executeOnce(action: RuntimeAction, skillContext?: Partial<SkillContext>): Promise<ActionResult> {
    const skill = this.deps.skillRegistry.get(action.capability)
    if (!skill) {
      return {
        status: 'failed',
        actionType: action.capability,
        error: { code: 'SKILL_NOT_FOUND', message: `Capability "${action.capability}" is not registered.` },
      }
    }

    try {
      const context: SkillContext = {
        context: skillContext?.context ?? null as never,
        activity: skillContext?.activity ?? '',
        segmentId: skillContext?.segmentId,
        state: this.deps.state,
        broadcaster: this.deps.broadcaster,
      }
      const result = await skill.execute(action.input, context)
      return {
        status: result.status,
        actionType: action.capability,
        error: result.error,
      }
    } catch (error) {
      return {
        status: 'failed',
        actionType: action.capability,
        error: { code: 'SKILL_EXECUTION_ERROR', message: error instanceof Error ? error.message : 'Skill execution failed.' },
      }
    }
  }
}
