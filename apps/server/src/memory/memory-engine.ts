import type { Activity, BehaviorEvent, MemoryCandidate, MemoryRecord } from '@chatty/shared'
import type { StateStore } from '../types.js'
import { expiryFor, isMemoryRejection, policyReadActivity, resolveMemoryScope, shouldCreateImplicitCandidate } from './policy.js'

export function observeBehavior(state: StateStore, input: BehaviorEvent) {
  const event = state.addBehaviorEvent(input)
  if (!shouldCreateImplicitCandidate(event.type, Boolean(event.track))) return { event, candidate: null }

  const skips = state.getBehaviorEvents(8).filter((item) => item.type === 'skip' && item.track)
  const recent = skips.slice(-2)
  if (recent.length < 2 || recent[0].track?.artist !== recent[1].track?.artist) return { event, candidate: null }

  const subject = recent[1].track!.artist
  const pending = state.getPendingMemoryCandidate()
  if (pending?.subject === subject) return { event, candidate: null }

  const activityPhrase: Record<Activity, string> = {
    study: '学习或工作时',
    running: '运动时',
    commute: '通勤时',
    relax: '放松时',
    sleep: '睡前',
    general: '这种时候',
  }
  const candidate: MemoryCandidate = {
    id: crypto.randomUUID(),
    subject,
    preference: `avoid ${subject}`,
    suggestedContext: policyReadActivity(event.activity),
    confidence: 0.72,
    evidence: recent.map((item) => `Skipped ${item.track!.title} by ${subject} during ${item.activity}`),
    question: `我注意到你连续跳过了两首 ${subject}。只是现在不想听、${activityPhrase[event.activity]}少放，还是以后都不要推荐？`,
    status: 'pending',
    createdAt: new Date().toISOString(),
  }
  state.addMemoryCandidate(candidate)
  return { event, candidate }
}

function activityFromMessage(message: string, fallback: Activity): Activity {
  if (/(学习|工作|敲代码|study|work|coding)/i.test(message)) return 'study'
  if (/(跑步|运动|健身|run|running|workout)/i.test(message)) return 'running'
  if (/(通勤|开车|commute|drive)/i.test(message)) return 'commute'
  if (/(睡觉|助眠|sleep)/i.test(message)) return 'sleep'
  if (/(放松|休息|relax)/i.test(message)) return 'relax'
  return fallback
}

export function resolvePendingMemory(state: StateStore, message: string, currentActivity: Activity) {
  const candidate = state.getPendingMemoryCandidate()
  if (!candidate) return null
  const input = message.toLowerCase()

  if (isMemoryRejection(input)) {
    state.resolveMemoryCandidate(candidate.id, 'rejected')
    return { say: '明白，只当作这次换歌，不会记成你的偏好。', record: null }
  }

  const scope = resolveMemoryScope(input)
  if (!scope) {
    if (/(少放|别放|不想听|跳过|换(?:一)?首|avoid|skip)/i.test(input)) {
      return { say: '我再确认一下：只是现在少放、当前场景少放，还是以后都少放？', record: null }
    }
    return null
  }

  const now = new Date()
  const context = scope === 'contextual' ? activityFromMessage(message, candidate.suggestedContext || currentActivity) : null
  const record: MemoryRecord = {
    id: crypto.randomUUID(),
    subject: candidate.subject,
    preference: candidate.preference,
    scope,
    context,
    status: 'confirmed',
    confidence: 1,
    evidence: [...candidate.evidence, `User confirmed: ${message}`],
    expiresAt: expiryFor(scope, now),
    validFrom: now.toISOString(),
    validTo: null,
    recordedAt: now.toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }
  state.upsertMemory(record)
  state.resolveMemoryCandidate(candidate.id, 'confirmed')
  const activityPhrase: Record<Activity, string> = {
    study: '学习或工作时',
    running: '运动时',
    commute: '通勤时',
    relax: '放松时',
    sleep: '睡前',
    general: '这种时候',
  }
  const confirmation = scope === 'global'
    ? `记住了，以后会少放 ${candidate.subject}。`
    : scope === 'contextual'
      ? `记住了，${activityPhrase[context ?? 'general']}会少放 ${candidate.subject}。`
      : `好的，这次先少放 ${candidate.subject}，不会当成长期偏好。`
  return { say: confirmation, record }
}

export function captureExplicitPreference(state: StateStore, message: string, activity: Activity) {
  if (!/(以后|永远|再也|from now on|never)/i.test(message)) return null
  if (!/(不要|别放|不听|不喜欢|avoid|don't play|do not play)/i.test(message)) return null
  const now = new Date().toISOString()
  const record: MemoryRecord = {
    id: crypto.randomUUID(),
    subject: message,
    preference: message,
    scope: 'global',
    context: null,
    status: 'confirmed',
    confidence: 1,
    evidence: [`Explicit user preference: ${message}`],
    expiresAt: null,
    validFrom: now,
    validTo: null,
    recordedAt: now,
    createdAt: now,
    updatedAt: now,
  }
  state.upsertMemory(record)
  return record
}
