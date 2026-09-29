import type { RuntimeAction, ActionResult, TraceEntry } from '../types.js'

/**
 * TraceStore：记录每次决策循环的完整链路。
 *
 * 保存：什么事件 → Agent 做了什么决定 → 每个动作执行结果 → 耗时
 *
 * 用于调试、回放、以及后续 Reflection Agent 分析决策质量。
 * 与 ObservationStore 的区别：ObservationStore 记录用户行为，
 * TraceStore 记录 Agent 自己的决策过程。
 */
export class TraceStore {
  private readonly traces: TraceEntry[] = []
  private readonly maxEntries: number

  constructor(maxEntries = 100) {
    this.maxEntries = maxEntries
  }

  /**
   * 记录一次决策循环。
   */
  record(event: string, eventDetail: string, reason: string, actions: RuntimeAction[], results: Array<{ actionType: string; status: ActionResult['status']; error?: ActionResult['error'] }>, durationMs: number): void {
    const entry: TraceEntry = {
      timestamp: Date.now(),
      event: { type: event, detail: eventDetail },
      decision: { reason, actions },
      results,
      durationMs,
    }
    this.traces.push(entry)
    if (this.traces.length > this.maxEntries) {
      this.traces.shift()
    }
  }

  /**
   * 获取最近的决策记录。
   */
  getRecent(count = 20): TraceEntry[] {
    return this.traces.slice(-count)
  }

  /**
   * 获取特定类型事件的决策记录。
   */
  getByEventType(eventType: string, count = 10): TraceEntry[] {
    return this.traces.filter((t) => t.event.type === eventType).slice(-count)
  }

  /**
   * 获取失败率统计。
   */
  getFailureRate(windowMs = 60 * 60 * 1000): { total: number; failed: number; rate: number } {
    const recent = this.traces.filter((t) => Date.now() - t.timestamp < windowMs)
    const failed = recent.filter((t) => t.results.some((r) => r.status === 'failed'))
    return {
      total: recent.length,
      failed: failed.length,
      rate: recent.length > 0 ? failed.length / recent.length : 0,
    }
  }

  /**
   * 清除所有 trace。
   */
  reset(): void {
    this.traces.length = 0
  }
}
