import type { MemoryPolicy } from '../types.js'

/**
 * 默认 MemoryPolicy。
 *
 * 写入规则：
 *   - play/completed/skip → 写入（基础行为信号）
 *   - positive_feedback → 写入（高质量的偏好信号）
 *   - preference_signal → 写入（用户的明确偏好表达）
 *
 * 读取规则：
 *   - study / running / relax → 加载用户画像（这些活动受偏好影响大）
 *   - sleep → 不加载（睡眠场景不需要个性化）
 */
export const defaultMemoryPolicy: MemoryPolicy = {
  shouldWrite: (eventType: string): boolean => {
    const writeable = ['music_played', 'song_skipped', 'song_completed', 'positive_feedback', 'negative_feedback', 'preference_signal']
    return writeable.includes(eventType)
  },

  shouldLoadForActivity: (activity: string): boolean => {
    return ['study', 'running', 'relax', 'commute', 'general'].includes(activity)
  },
}
