import type { Activity, MemoryRecord } from '@chatty/shared'

export function resolveMemoryScope(message: string): MemoryRecord['scope'] | null {
  const input = message.toLowerCase()
  if (/(以后|今后|永远|一直|都不要|都少放|再也|from now on|never|always)/i.test(input)) return 'global'
  if (/(学习|工作|敲代码|跑步|运动|健身|通勤|开车|睡觉|睡前|放松|这种场景|当前场景|while|when i)/i.test(input)) return 'contextual'
  if (/(今天|现在|这会|这次|这一轮|暂时|此刻|先不|just now|today|for now|this session)/i.test(input)) return 'session'
  return null
}

export function isMemoryRejection(message: string) {
  return /(不是|没有|别记|不用记|不要记|只是想换|就想换|no\b|forget it|don't remember)/i.test(message.toLowerCase())
}

export function expiryFor(scope: MemoryRecord['scope'], now = new Date()) {
  return scope === 'session' ? new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString() : null
}

export function shouldCreateImplicitCandidate(type: string, hasTrack: boolean) {
  return type === 'skip' && hasTrack
}

export function policyReadActivity(activity: Activity) {
  return activity
}
