import type { RadioPlan } from '@chatty/shared'
import type { PlanPatch, PlanRevision, RuntimeEvent, ContextBundle } from '../types.js'
import type { OpenAiAgentProvider } from '../agent/openai-agent.js'

/**
 * PlanRevisionApplier：将 Planner.revise() 输出的 PlanRevision
 * 应用到当前 RadioPlan，生成新的版本。
 *
 * 和 createRadioPlan 的区别：
 *   createRadioPlan 从零创建计划
 *   applyRevision 在运行中修改计划
 */
export function applyRevision(plan: RadioPlan, revision: PlanRevision): RadioPlan {
  if (revision.type !== 'plan_patch') return plan

  const segments = plan.segments.map((seg) => {
    if (seg.id !== revision.patch.segmentId) return seg

    return {
      ...seg,
      ...(revision.patch.changes.energy ? { energy: revision.patch.changes.energy as typeof seg.energy } : {}),
      ...(revision.patch.changes.query ? { query: revision.patch.changes.query } : {}),
      ...(revision.patch.changes.durationMin ? { durationMin: revision.patch.changes.durationMin } : {}),
      ...(revision.patch.changes.djPolicy ? { djPolicy: revision.patch.changes.djPolicy as typeof seg.djPolicy } : {}),
    }
  })

  const updated: RadioPlan = {
    ...plan,
    segments,
    updatedAt: new Date().toISOString(),
  }
  return updated
}

/**
 * 用 LLM 生成一个 PlanRevision。
 * Planner.revise() 的底层调用。
 */
export async function requestRevision(
  llmClient: OpenAiAgentProvider,
  plan: RadioPlan,
  event: RuntimeEvent,
  context: ContextBundle,
): Promise<PlanRevision | null> {
  const segment = plan.segments[plan.currentSegmentIndex]
  if (!segment) return null

  const prompt = `You are the plan revision agent for a private AI radio station.
The current plan is: ${plan.activity} — ${plan.goal}
Current segment: ${segment.label} (energy: ${segment.energy}, query: "${segment.query}")
An event occurred: ${JSON.stringify(event)}

If the event suggests the current segment needs adjustment, output a patch.
Otherwise respond with {"type":"plan_patch","reason":"No adjustment needed","patch":null}

Respond with JSON only:
{"type":"plan_patch","reason":"...","patch":{"segmentId":"${segment.id}","changes":{"energy":"low"|"medium"|"high"|"steady"|"rising","query":"..."}}}`

  try {
    const decision = await llmClient.decide({
      ...context,
      userMessage: prompt,
      currentPlan: plan,
    })
    if (!decision.reason && !decision.play?.length) return null

    // 从 decision 推断 patch 内容
    const adjustEnergy = decision.intent?.energy ?? segment.energy
    const needsChange = adjustEnergy !== segment.energy || (decision.play?.length ?? 0) > 0
    if (!needsChange) return null

    return {
      type: 'plan_patch',
      reason: decision.reason || 'Adjusted based on runtime feedback.',
      patch: {
        segmentId: segment.id,
        changes: {
          energy: adjustEnergy as PlanPatch['changes']['energy'],
          query: decision.play?.[0]?.query || segment.query,
        },
      },
    }
  } catch {
    return null
  }
}
