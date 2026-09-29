import type { SessionContext } from '../types.js'

/**
 * SessionContext：当前会话状态。
 *
 * 与长期 UserProfile 的区别：
 *   UserProfile: 用户是怎么样的人（跨 session 稳定）
 *   SessionContext: 用户现在是什么状态（当前 session 动态）
 *
 * Session 结束后可丢弃。
 */
export class SessionTracker {
  private context: SessionContext = {
    sessionStartTime: Date.now(),
    interactionCount: 0,
  }

  /**
   * 更新当前 session 上下文。
   */
  update(partial: Partial<Omit<SessionContext, 'sessionStartTime'>>): void {
    this.context = { ...this.context, ...partial }
    this.context.interactionCount += 1
  }

  /**
   * 获取当前 session 上下文。
   */
  get(): SessionContext {
    return { ...this.context }
  }

  /**
   * 生成 session 摘要文本（供 Planner LLM 上下文）。
   */
  summarize(): string {
    const parts: string[] = ['[Session Context]']
    if (this.context.currentActivity) parts.push(`Current activity: ${this.context.currentActivity}`)
    if (this.context.currentMood) parts.push(`Current mood: ${this.context.currentMood}`)
    if (this.context.temporaryPreference) {
      for (const [key, value] of Object.entries(this.context.temporaryPreference)) {
        parts.push(`Temporary preference: ${key}=${value}`)
      }
    }
    parts.push(`Session interactions: ${this.context.interactionCount}`)
    return parts.join('\n')
  }

  /**
   * 重置 session（新会话开始时）。
   */
  reset(activity?: string): void {
    this.context = {
      sessionStartTime: Date.now(),
      interactionCount: 0,
      currentActivity: activity,
    }
  }
}
