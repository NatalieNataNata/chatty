import type { ObservationEntry } from '../types.js'

/**
 * 从观测条目中计算一段窗口内的指标。
 */
export function computeMetrics(observations: ObservationEntry[]) {
  if (!observations.length) {
    return { completionRate: 1, skipRate: 0, totalPlays: 0, totalSkips: 0 }
  }

  const skips = observations.filter((o) => o.eventType === 'skip').length
  const plays = observations.filter((o) => o.eventType === 'play').length
  const completes = observations.filter((o) => o.eventType === 'completed').length
  const total = plays + completes

  return {
    completionRate: total > 0 ? completes / total : 1,
    skipRate: total > 0 ? skips / total : 0,
    totalPlays: plays,
    totalSkips: skips,
  }
}

/**
 * 从计划段中提取策略签名。
 * 用于匹配 OutcomeStore 中的历史记录。
 */
export function extractStrategySignature(
  activity: string,
  segments: Array<{ energy: string; djPolicy: string; query?: string }>,
): { energyProfile: string; djPolicy: string; genreHint?: string } {
  const energyProfile = segments.map((s) => s.energy).join('-')
  const mainDjPolicy = segments[1]?.djPolicy ?? segments[0]?.djPolicy ?? 'balanced'
  const genreHint = segments[0]?.query?.split(/\s+/).slice(0, 2).join(' ')
  return { energyProfile, djPolicy: mainDjPolicy, genreHint }
}
