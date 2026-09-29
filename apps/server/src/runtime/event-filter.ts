import type { EventFilterProvider, RuntimeEvent, ThinkingPolicy, ObservationEntry } from '../types.js'
import { shouldTriggerDecision } from './thinking-policy.js'

/**
 * EventFilter：判断一个运行时事件是否值得唤醒 Agent。
 *
 * Agent 每次思考都有成本（LLM token、延迟）。
 * EventFilter 结合 ThinkingPolicy 阻挡低价值事件。
 */
export class EventFilter implements EventFilterProvider {
  shouldTrigger(
    event: RuntimeEvent,
    policy: ThinkingPolicy,
    lastDecisionAt: number | null,
    recentObservations: ObservationEntry[],
  ): boolean {
    // 委托给 thinking-policy 的核心逻辑
    return shouldTriggerDecision(event, policy, lastDecisionAt, recentObservations)
  }
}
