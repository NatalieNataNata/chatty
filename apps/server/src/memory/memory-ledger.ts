import type { StateStore, MemoryEvent } from '../types.js'
import type { BehaviorEvent } from '@chatty/shared'

/**
 * MemoryLedger：个人记忆账本。
 *
 * 职责：接收原始行为事件和反馈信号，持久化到 SQLite ledger。
 * 只追加，不修改。
 *
 * 与 ObservationStore 的区别：
 *   ObservationStore 是运行时短时记忆（内存，200条上限，重启丢失）。
 *   MemoryLedger 是长期记忆（SQLite，持久化，支持聚合查询）。
 *
 * 复用已有基础设施：store.appendLedger() + store.getLedgerEvents()
 * 不引入新存储。
 */
export class MemoryLedger {
  constructor(private readonly store: StateStore) {}

  /**
   * 记录一个行为事件到长期记忆。
   */
  recordBehavior(event: BehaviorEvent): void {
    const memoryEvent: MemoryEvent = {
      id: event.id ?? crypto.randomUUID(),
      type: this.mapBehaviorType(event.type),
      timestamp: Date.now(),
      payload: {
        type: event.type,
        trackTitle: event.track?.title,
        trackArtist: event.track?.artist,
        activity: event.activity,
        planId: event.planId,
        segmentId: event.segmentId,
      },
    }
    this.write(memoryEvent)
  }

  /**
   * 记录一条明确反馈信号。
   */
  recordFeedback(type: 'positive_feedback' | 'negative_feedback' | 'preference_signal', detail: string, activity?: string): void {
    const memoryEvent: MemoryEvent = {
      id: crypto.randomUUID(),
      type,
      timestamp: Date.now(),
      payload: { detail, activity: activity ?? 'general' },
    }
    this.write(memoryEvent)
  }

  /**
   * 写一条事件记录（to SQLite ledger）。
   */
  private write(event: MemoryEvent): void {
    this.store.appendLedger({
      type: 'behavior_observed',
      entityType: 'memory_event',
      entityId: event.id,
      payload: { memoryType: event.type, ...event.payload },
      occurredAt: new Date(event.timestamp).toISOString(),
      actor: 'user',
    })
  }

  /**
   * 按类型查询近期记忆事件。
   */
  getEvents(type: MemoryEvent['type'], limit = 50): MemoryEvent[] {
    const ledger = this.store.getLedgerEvents(200)
    return ledger
      .filter((e) => {
        const payload = e.payload as Record<string, unknown>
        return e.entityType === 'memory_event' && payload?.memoryType === type
      })
      .slice(-limit)
      .map((e) => ({
        id: e.entityId,
        type: ((e.payload as Record<string, unknown>)?.memoryType ?? 'music_played') as MemoryEvent['type'],
        timestamp: new Date(e.occurredAt).getTime(),
        payload: (e.payload as Record<string, unknown>) ?? {},
      }))
  }

  /**
   * 获取某个活动的所有记忆事件。
   */
  getEventsForActivity(activity: string, limit = 100): MemoryEvent[] {
    const ledger = this.store.getLedgerEvents(500)
    return ledger
      .filter((e) => {
        const payload = e.payload as Record<string, unknown>
        return e.entityType === 'memory_event' && payload?.activity === activity
      })
      .slice(-limit)
      .map((e) => ({
        id: e.entityId,
        type: ((e.payload as Record<string, unknown>)?.memoryType as MemoryEvent['type']) ?? 'music_played',
        timestamp: new Date(e.occurredAt).getTime(),
        payload: (e.payload as Record<string, unknown>) ?? {},
      }))
  }

  private mapBehaviorType(type: BehaviorEvent['type']): MemoryEvent['type'] {
    switch (type) {
      case 'play': return 'music_played'
      case 'skip': return 'song_skipped'
      case 'completed': return 'song_completed'
      default: return 'music_played'
    }
  }
}
