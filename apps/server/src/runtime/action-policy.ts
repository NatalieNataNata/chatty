import type { RuntimeAction, ActionPolicy, ActionResult } from '../types.js'
import { DefaultActionPolicies } from '../types.js'

/**
 * 获取某个 action 的执行策略。
 */
export function getActionPolicy(action: RuntimeAction): ActionPolicy {
  return DefaultActionPolicies[action.capability] ?? { maxRetries: 0, timeoutMs: 5000 }
}

/**
 * 判断是否应该重试。
 */
export function shouldRetry(result: ActionResult, retryCount: number, policy: ActionPolicy): boolean {
  if (result.status !== 'failed') return false
  return retryCount < policy.maxRetries
}

/**
 * 判断是否有降级动作可用。
 */
export function hasFallback(policy: ActionPolicy): boolean {
  return Boolean(policy.fallbackActions && policy.fallbackActions.length > 0)
}
