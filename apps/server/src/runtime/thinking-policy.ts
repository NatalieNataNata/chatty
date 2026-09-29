import type { RuntimeEvent, ThinkingPolicy } from '../types.js'
import { ThinkingPresets } from '../types.js'
import type { ObservationEntry } from '../types.js'

/**
 * 根据活动类型获取 ThinkingPolicy 预设。
 * 未匹配的活动使用 general 预设。
 */
export function getThinkingPolicy(activity: string): ThinkingPolicy {
  return ThinkingPresets[activity] ?? ThinkingPresets.general
}

/**
 * 判断当前事件是否值得唤醒 Agent 做决策。
 *
 * 升级后的 EventFilter.shouldTrigger 逻辑：
 * 1. 用户主动请求 → 立即唤醒
 * 2. 事件在 immediateTriggers 中 → 检查间隔和阈值
 * 3. 其他事件 → 根据 mode 决定
 */
export function shouldTriggerDecision(
  event: RuntimeEvent,
  policy: ThinkingPolicy,
  lastDecisionAt: number | null,
  recentObservations: ObservationEntry[],
): boolean {
  // 用户主动请求 → 无条件唤醒
  if (event.type === 'user_request') return true

  // 播放错误 → 立即处理
  if (event.type === 'playback_error') return true

  // 不在 triggers 列表中的事件 → 不唤醒
  if (!policy.immediateTriggers.includes(event.type)) return false

  // 检查时间间隔
  if (lastDecisionAt !== null) {
    const elapsed = Date.now() - lastDecisionAt
    if (elapsed < policy.minDecisionIntervalMs) {
      // 间隔不够 → 检查是否超过阈值
      return checkThresholds(event, policy, recentObservations)
    }
  }

  return true
}

function checkThresholds(
  event: RuntimeEvent,
  policy: ThinkingPolicy,
  observations: ObservationEntry[],
): boolean {
  if (event.type === 'skip_pattern') {
    const maxSkips = policy.thresholds.skipCount ?? Infinity
    return event.count >= maxSkips
  }

  if (event.type === 'segment_completed' && policy.mode === 'quiet') {
    // quiet 模式下，段完成不主动决策
    return false
  }

  return false
}

/**
 * 生成 skip_pattern 事件的简要摘要（用于 LLM 上下文）。
 */
export function summarizeObservations(observations: ObservationEntry[], maxAgeMs = 10 * 60 * 1000): string {
  const recent = observations.filter((o) => Date.now() - o.timestamp < maxAgeMs)
  if (!recent.length) return 'No recent observations.'

  const skips = recent.filter((o) => o.eventType === 'skip')
  const plays = recent.filter((o) => o.eventType === 'play')
  const completes = recent.filter((o) => o.eventType === 'completed')

  return [
    `Last ${Math.round(maxAgeMs / 60000)}min:`,
    `  played: ${plays.length}`,
    `  skipped: ${skips.length}`,
    `  completed: ${completes.length}`,
    skips.length > 0 ? `  skipped artists: ${[...new Set(skips.map((s) => s.trackArtist).filter(Boolean))].join(', ')}` : '',
  ].filter(Boolean).join('\n')
}
