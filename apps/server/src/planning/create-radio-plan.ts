import type { IntentResult, PlanSegment, ProgrammeDraft, RadioPlan } from '@chatty/shared'
import type { PlanDraft } from '../types.js'

type SegmentTemplate = Omit<PlanSegment, 'id' | 'completed'>

function templates(intent: IntentResult): SegmentTemplate[] {
  if (intent.activity === 'study') {
    return [
      { label: 'Settle in', durationMin: 10, energy: 'low', query: 'familiar atmospheric focus low lyrics', djPolicy: 'intro' },
      { label: 'Deep focus', durationMin: 40, energy: 'steady', query: 'instrumental electronic ambient deep focus', djPolicy: 'quiet' },
      { label: 'Soft landing', durationMin: 10, energy: 'low', query: 'gentle neo classical focus ending', djPolicy: 'transition' },
    ]
  }
  if (intent.activity === 'running') {
    return [
      { label: 'Warm up', durationMin: 8, energy: 'rising', query: 'running warm up rhythmic pop electronic', djPolicy: 'intro' },
      { label: 'Hold the pace', durationMin: 27, energy: 'high', query: 'high energy running workout steady beat', djPolicy: 'check_in' },
      { label: 'Cool down', durationMin: 10, energy: 'low', query: 'running cool down uplifting mellow', djPolicy: 'transition' },
    ]
  }
  if (intent.activity === 'commute') {
    return [
      { label: 'Leave the day', durationMin: 12, energy: 'medium', query: 'city commute familiar indie pop', djPolicy: 'intro' },
      { label: 'City flow', durationMin: 25, energy: 'steady', query: 'night drive electronic city lights', djPolicy: 'quiet' },
      { label: 'Arrival', durationMin: 8, energy: 'low', query: 'soft arrival evening indie', djPolicy: 'transition' },
    ]
  }
  return [
    { label: 'Open the room', durationMin: 12, energy: intent.energy, query: `${intent.mood} personal radio opener`, djPolicy: 'intro' },
    { label: 'Stay with it', durationMin: 25, energy: 'steady', query: `${intent.mood} atmospheric personal mix`, djPolicy: 'quiet' },
    { label: 'Turn the corner', durationMin: 8, energy: 'low', query: `${intent.mood} gentle radio transition`, djPolicy: 'transition' },
  ]
}

/**
 * 将 PlanDraft（Planner 输出的策略草案）转换为 ProgrammeDraft，
 * 复用现有的 createRadioPlanFromDraft 做实例化。
 *
 * 这是 Planner → Executor 的协议翻译层：
 * Planner 输出 strategy（做什么），
 * createRadioPlan 把它实例化为可执行状态。
 */
export function planDraftToProgrammeDraft(draft: PlanDraft): ProgrammeDraft {
  return {
    goal: draft.goal,
    durationMin: draft.constraints.duration,
    constraints: draft.constraints.energy ? [`energy: ${draft.constraints.energy}`] : [],
    replanTriggers: ['two consecutive skips', 'activity changed', 'explicit feedback', 'queue exhausted'],
    segments: draft.steps.map((step) => ({
      label: step.segmentType.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
      durationMin: step.duration,
      energy: step.strategy.energy as PlanSegment['energy'],
      query: step.strategy.query,
      djPolicy: step.strategy.djPolicy as PlanSegment['djPolicy'],
    })),
  }
}

export function createRadioPlan(intent: IntentResult, userMessage: string): RadioPlan {
  const createdAt = new Date().toISOString()
  const durationMin = intent.durationMin ?? templates(intent).reduce((sum, segment) => sum + segment.durationMin, 0)
  const baseSegments = templates(intent)
  const templateTotal = baseSegments.reduce((sum, segment) => sum + segment.durationMin, 0)
  const segments = baseSegments.map((segment, index) => ({
    ...segment,
    id: crypto.randomUUID(),
    durationMin: Math.max(3, Math.round((segment.durationMin / templateTotal) * durationMin)),
    completed: false,
  }))

  return {
    id: crypto.randomUUID(),
    goal: userMessage,
    intent: { ...intent, durationMin },
    activity: intent.activity,
    durationMin,
    segments,
    currentSegmentIndex: 0,
    status: 'active',
    constraints: intent.lyricDensity === 'low' ? ['prefer low lyric density'] : [],
    replanTriggers: ['two consecutive skips', 'activity changed', 'explicit feedback', 'queue exhausted'],
    createdAt,
    updatedAt: createdAt,
  }
}

export function createRadioPlanFromDraft(intent: IntentResult, draft: ProgrammeDraft, userMessage: string): RadioPlan {
  const createdAt = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    goal: draft.goal.trim() || userMessage,
    intent: { ...intent, durationMin: draft.durationMin },
    activity: intent.activity,
    durationMin: draft.durationMin,
    segments: draft.segments.map((segment) => ({
      ...segment,
      id: crypto.randomUUID(),
      completed: false,
    })),
    currentSegmentIndex: 0,
    status: 'active',
    constraints: draft.constraints,
    replanTriggers: draft.replanTriggers.length
      ? draft.replanTriggers
      : ['two consecutive skips', 'activity changed', 'explicit feedback', 'queue exhausted'],
    createdAt,
    updatedAt: createdAt,
  }
}
