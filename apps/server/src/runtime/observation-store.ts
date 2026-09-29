import type { BehaviorEvent } from '@chatty/shared'
import type { ObservationEntry, ObservationMetrics } from '../types.js'

/**
 * ObservationStore：短期运行记忆。
 *
 * 保存最近 N 条行为事件（跳歌、播放、完成等），
 * 供 EventFilter 和 DecisionEngine 在运行时参考。
 *
 * 这不是长期记忆 — 只活在内存里，不写入 SQLite。
 */
export class ObservationStore {
  private readonly entries: ObservationEntry[] = []
  private readonly maxEntries: number

  constructor(maxEntries = 200) {
    this.maxEntries = maxEntries
  }

  /**
   * 记录一个行为事件到观测窗口。
   */
  record(event: BehaviorEvent): void {
    const entry: ObservationEntry = {
      timestamp: Date.now(),
      eventType: event.type,
      segmentId: event.segmentId ?? undefined,
      trackId: event.track?.id,
      trackArtist: event.track?.artist,
      planId: event.planId ?? undefined,
    }

    this.entries.push(entry)

    // 保留最近的 N 条
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries)
    }
  }

  /**
   * 获取最近一段时间内的观测条目。
   */
  getRecent(windowMs = 10 * 60 * 1000): ObservationEntry[] {
    const cutoff = Date.now() - windowMs
    return this.entries.filter((e) => e.timestamp >= cutoff)
  }

  /**
   * 获取特定 segment 的观测。
   */
  getSegmentObservations(segmentId: string, windowMs = 10 * 60 * 1000): ObservationEntry[] {
    return this.getRecent(windowMs).filter((e) => e.segmentId === segmentId)
  }

  /**
   * 获取聚合指标。
   */
  getMetrics(segmentId?: string, windowMs = 10 * 60 * 1000): ObservationMetrics {
    const relevant = segmentId
      ? this.getSegmentObservations(segmentId, windowMs)
      : this.getRecent(windowMs)

    const skips = relevant.filter((e) => e.eventType === 'skip').length
    const plays = relevant.filter((e) => e.eventType === 'play').length
    const completes = relevant.filter((e) => e.eventType === 'completed').length
    const totalSongs = plays + completes

    return {
      playCount: plays,
      skipCount: skips,
      completionRate: totalSongs > 0 ? completes / totalSongs : 1,
      totalSongs,
    }
  }

  /**
   * 清除所有观测（如 plan 切换时）。
   */
  reset(): void {
    this.entries.length = 0
  }
}
