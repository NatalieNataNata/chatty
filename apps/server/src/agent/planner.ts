import type { ProgrammeDraft } from '@chatty/shared'
import type { AgentProvider, ContextBundle, PlanDraft, PlanRevision, PlanStepDraft, PlannerProvider, RuntimeEvent } from '../types.js'
import type { RadioPlan } from '@chatty/shared'
import { applyRevision, requestRevision } from '../runtime/plan-revision.js'

/**
 * PlannerAgent: 负责电台节目的策略起草和运行中修正。
 *
 * 两个核心职责：
 *   createPlan  — 从 LLM 的 programme 输出结构化 PlanDraft
 *   revise()    — 运行时根据事件修正正在执行的计划
 */
export class PlannerAgent implements PlannerProvider {
  constructor(private readonly agent: AgentProvider) {}

  async draft(context: ContextBundle): Promise<PlanDraft> {
    throw new Error('Not implemented directly — use createPlanDraft() from agent decision.')
  }

  async revise(plan: RadioPlan, event: RuntimeEvent, context: ContextBundle): Promise<PlanRevision | null> {
    // requestRevision 内部调 agent.decide() 作为 LLM 入口
    // V1 用通用的 OpenAiAgentProvider.decide，后续可拆专用 LLM 调用
    try {
      const decision = await this.agent.decide({
        ...context,
        userMessage: `[Plan Revision] Event: ${event.type}. Current plan: ${plan.activity}`,
        currentPlan: plan,
      })
      if (!decision.reason && !decision.play?.length && !decision.intent) return null

      const segment = plan.segments[plan.currentSegmentIndex]
      if (!segment) return null

      const adjustEnergy = decision.intent?.energy
      const needsChange = adjustEnergy && adjustEnergy !== segment.energy
      const hasNewQuery = decision.play?.[0]?.query

      if (!needsChange && !hasNewQuery) return null

      const patch = {
        segmentId: segment.id,
        changes: {
          ...(needsChange ? { energy: adjustEnergy as 'low' | 'medium' | 'high' | 'steady' | 'rising' } : {}),
          ...(hasNewQuery ? { query: decision.play![0].query } : {}),
        },
      }

      return {
        type: 'plan_patch',
        reason: decision.reason || 'Runtime adjustment based on listener feedback.',
        patch,
      }
    } catch {
      return null
    }
  }
}

/**
 * 从 AgentDecision.programme 创建 PlanDraft。
 * 这是 Planner 的实例化入口——将 LLM 的自由输出
 * 转换为类型化、可实例化的 PlanDraft。
 */
export function createPlanDraft(programme: ProgrammeDraft, activity: string): PlanDraft {
  const steps: PlanStepDraft[] = programme.segments.map((segment, index) => ({
    id: `step-${index + 1}`,
    segmentType: segment.label.toLowerCase().replace(/\s+/g, '_'),
    duration: segment.durationMin,
    strategy: {
      energy: segment.energy,
      query: segment.query,
      djPolicy: segment.djPolicy,
    },
  }))

  return {
    goal: programme.goal,
    constraints: {
      activity,
      duration: programme.durationMin,
    },
    steps,
  }
}

/**
 * 从 PlanDraft 生成简短的策略描述（用于日志 / 播报）。
 */
export function summarizePlanDraft(draft: PlanDraft): string {
  const steps = draft.steps.map((step) => `${step.segmentType}(${step.duration}min/${step.strategy.energy})`).join(' → ')
  return `${draft.constraints.activity}: ${draft.goal} [${steps}]`
}
