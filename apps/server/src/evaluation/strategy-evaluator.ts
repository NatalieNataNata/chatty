import type { ExperienceSnapshot, StrategyOutcome, StrategySignature } from '../types.js'
import { OutcomeStore } from './outcome-store.js'

/**
 * StrategyEvaluator：查询历史策略表现，供 Planner 参考。
 *
 * Planner 在生成新计划时，通过 evaluator 了解
 * "对于这个用户的这个活动，什么策略历史上效果好"。
 *
 * 这不是 ML 模型——它只是聚合查询。
 * 但足以让 Planner 从 5 次学习经验后做出更好的决策。
 */
export class StrategyEvaluator {
  constructor(private readonly store: OutcomeStore) {}

  /**
   * 获取某个活动的最佳策略快照。
   * Planner 在 draft/revise 时传入这个数据。
   */
  getExperience(activity: string): ExperienceSnapshot {
    const outcomes = this.store.getByActivity(activity, 30)
    if (!outcomes.length) return { activity, topStrategies: [] }

    // 按策略签名分组
    const groups = new Map<string, StrategyOutcome[]>()
    for (const outcome of outcomes) {
      const key = `${outcome.strategy.energyProfile}|${outcome.strategy.djPolicy}`
      const group = groups.get(key) ?? []
      group.push(outcome)
      groups.set(key, group)
    }

    // 计算每组平均完成率，取前 3
    const ranked = [...groups.entries()]
      .map(([key, group]) => ({
        key,
        avgCompletionRate: group.reduce((s, o) => s + o.metrics.completionRate, 0) / group.length,
        totalSessions: group.length,
        strategy: group[0].strategy,
      }))
      .sort((a, b) => b.avgCompletionRate - a.avgCompletionRate)
      .slice(0, 3)

    return {
      activity,
      topStrategies: ranked.map((r) => ({
        strategy: r.strategy,
        avgCompletionRate: r.avgCompletionRate,
        totalSessions: r.totalSessions,
      })),
    }
  }

  /**
   * 判断某个活动是否有足够的经验数据。
   */
  hasSufficientExperience(activity: string, minSessions = 3): boolean {
    return this.store.getByActivity(activity, minSessions + 1).length >= minSessions
  }

  /**
   * 生成经验摘要文本（供 LLM Planner 参考）。
   */
  summarizeExperience(activity: string): string {
    const exp = this.getExperience(activity)
    if (!exp.topStrategies.length) return 'No prior experience for this activity.'

    return exp.topStrategies.map((s, i) =>
      `#${i + 1}: ${s.strategy.energyProfile} energy, ${s.strategy.djPolicy} DJ style — ${(s.avgCompletionRate * 100).toFixed(0)}% completion (${s.totalSessions} sessions)`,
    ).join('\n')
  }
}
