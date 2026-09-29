import type { StrategyOutcome, StrategySignature } from '../types.js'

/**
 * OutcomeStore：策略执行结果存储。
 *
 * 记录每次完整 session 结束后"用了什么策略"和"效果如何"。
 * 数据来源：TraceStore（决策链路）+ ObservationStore（用户行为）。
 *
 * 不同于 TraceStore 的单次决策追踪，
 * OutcomeStore 保存的是聚合后的 Session 级别指标。
 */
export class OutcomeStore {
  private readonly outcomes: StrategyOutcome[] = []
  private readonly maxEntries: number

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries
  }

  /**
   * 记录一次 session 的策略结果。
   */
  record(outcome: StrategyOutcome): void {
    this.outcomes.push(outcome)
    if (this.outcomes.length > this.maxEntries) {
      this.outcomes.shift()
    }
  }

  /**
   * 获取某个活动的最新结果。
   */
  getByActivity(activity: string, limit = 20): StrategyOutcome[] {
    return this.outcomes
      .filter((o) => o.strategy.activity === activity)
      .slice(-limit)
  }

  /**
   * 获取所有结果（用于聚合）。
   */
  getAll(): StrategyOutcome[] {
    return [...this.outcomes]
  }

  /**
   * 根据策略签名计算历史平均表现。
   */
  getAverageForStrategy(signature: Partial<StrategySignature>): { avgCompletionRate: number; avgSkipRate: number; count: number } {
    const matching = this.outcomes.filter((o) => {
      if (signature.activity && o.strategy.activity !== signature.activity) return false
      if (signature.energyProfile && o.strategy.energyProfile !== signature.energyProfile) return false
      if (signature.djPolicy && o.strategy.djPolicy !== signature.djPolicy) return false
      return true
    })

    if (!matching.length) return { avgCompletionRate: 0, avgSkipRate: 0, count: 0 }

    return {
      avgCompletionRate: matching.reduce((s, o) => s + o.metrics.completionRate, 0) / matching.length,
      avgSkipRate: matching.reduce((s, o) => s + o.metrics.skipRate, 0) / matching.length,
      count: matching.length,
    }
  }

  /**
   * 重置（测试用）。
   */
  reset(): void {
    this.outcomes.length = 0
  }
}
