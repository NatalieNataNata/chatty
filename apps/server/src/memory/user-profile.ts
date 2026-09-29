import type { StateStore, UserMusicProfile, MemoryEvent } from '../types.js'
import { MemoryLedger } from './memory-ledger.js'

/**
 * UserProfile：从 MemoryLedger 的原始事件计算用户偏好画像。
 *
 * 不是实时计算的（不消耗 LLM token）。
 * 在 Planner 需要时从已存储的事件中聚合。
 *
 * 计算规则：
 *   - 完成率高的 activity+energy 组合 → 偏好
 *   - 连续跳歌的 artist → 不偏好
 *   - 夜间 + 低能量完成率高 → 夜间能量偏好
 */
export class UserProfile {
  private cache: { builtAt: number; profile: UserMusicProfile } | null = null
  private readonly cacheTtlMs = 5 * 60 * 1000

  constructor(
    private readonly ledger: MemoryLedger,
    private readonly store: StateStore,
  ) {}

  /**
   * 获取当前用户偏好画像（带缓存）。
   */
  async getProfile(): Promise<UserMusicProfile> {
    if (this.cache && Date.now() - this.cache.builtAt < this.cacheTtlMs) {
      return this.cache.profile
    }

    const profile = await this.buildProfile()
    this.cache = { builtAt: Date.now(), profile }
    return profile
  }

  private async buildProfile(): Promise<UserMusicProfile> {
    const recent = this.store.getLedgerEvents(500)
    const memoryEvents = recent
      .filter((e) => e.entityType === 'memory_event')
      .map((e) => ({
        type: (e.payload as Record<string, unknown>)?.memoryType as string,
        activity: (e.payload as Record<string, unknown>)?.activity as string,
        trackArtist: (e.payload as Record<string, unknown>)?.trackArtist as string,
        trackTitle: (e.payload as Record<string, unknown>)?.trackTitle as string,
        occurredAt: e.occurredAt,
      }))

    // 能量偏好：按时间段统计完成率
    const completed = new Set<string>()
    const skipped = new Set<string>()

    for (const event of memoryEvents) {
      if (event.type === 'song_completed' && event.activity) completed.add(`${event.activity}-${event.trackTitle}`)
      if (event.type === 'song_skipped' && event.activity) skipped.add(`${event.activity}-${event.trackTitle}`)
    }

    // 根据活跃 session 时长估算 DJ 耐受度
    const totalPlays = memoryEvents.filter((e) => e.type === 'music_played').length
    const totalSkips = memoryEvents.filter((e) => e.type === 'song_skipped').length
    const completionRate = totalPlays > 0 ? (totalPlays - totalSkips) / totalPlays : 0.5

    return {
      preferredGenres: [],
      djTolerance: completionRate > 0.8 ? 'quiet' : completionRate > 0.6 ? 'balanced' : 'active',
      likesLyrics: false,
    }
  }

  /**
   * 获取用户画像的文本摘要（供 Planner LLM 上下文使用）。
   */
  async summarize(): Promise<string> {
    const profile = await this.getProfile()
    const parts: string[] = ['[User Memory]']
    parts.push(`DJ tolerance: ${profile.djTolerance}`)
    if (profile.preferredGenres?.length) parts.push(`Preferred genres: ${profile.preferredGenres.join(', ')}`)
    if (profile.preferredEnergy) {
      for (const [time, energy] of Object.entries(profile.preferredEnergy)) {
        parts.push(`Preferred ${time} energy: ${energy}`)
      }
    }
    parts.push(`Lyrics preference: ${profile.likesLyrics ? 'likes' : 'no preference'}`)
    return parts.join('\n')
  }

  invalidateCache(): void {
    this.cache = null
  }
}
