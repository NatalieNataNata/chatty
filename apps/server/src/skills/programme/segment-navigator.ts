import type { RadioPlan } from '@chatty/shared'
import type { Skill, SkillResult, SkillContext } from '../skill.js'
import { getTransitionText } from '../../templates/response-templates.js'

export interface SegmentNavInput { action: 'advance' | 'complete' }
export interface SegmentNavOutput { advanced: boolean; completed: boolean }

export class SegmentNavigatorSkill implements Skill<SegmentNavInput, SegmentNavOutput> {
  name = 'segment_navigator'
  description = 'Advance or complete programme segments. Handles segment index transitions and plan completion lifecycle.'
  tags = ['programme', 'navigation', 'scheduling']
  inputSchema = { action: '"advance" | "complete"' }

  async execute(input: SegmentNavInput, context: SkillContext): Promise<SkillResult<SegmentNavOutput>> {
    const state = context.state
    const broadcaster = context.broadcaster
    if (!state || !broadcaster) {
      return { status: 'failed', error: { code: 'MISSING_RUNTIME', message: 'state and broadcaster required.' } }
    }

    const plan = state.getCurrentPlan()
    if (!plan || plan.status !== 'active') {
      return { status: 'failed', error: { code: 'NO_ACTIVE_PLAN', message: 'No active plan to advance.' } }
    }

    if (input.action === 'complete' || plan.currentSegmentIndex + 1 >= plan.segments.length) {
      const finished: RadioPlan = { ...plan, status: 'completed', updatedAt: new Date().toISOString() }
      state.setCurrentPlan(finished)
      state.recordPlanOutcome(finished, 'completed')
      broadcaster.emitPlan(finished)
      return { status: 'success', data: { advanced: false, completed: true } }
    }

    const nextIndex = plan.currentSegmentIndex + 1
    const segments = plan.segments.map((seg, index) =>
      index <= plan.currentSegmentIndex ? { ...seg, completed: true } : seg,
    )
    const next: RadioPlan = { ...plan, segments, currentSegmentIndex: nextIndex, updatedAt: new Date().toISOString() }
    state.setCurrentPlan(next)
    broadcaster.emitPlan(next)

    const text = getTransitionText(next.activity, next.segments[next.currentSegmentIndex]?.label)
    if (text) broadcaster.emitDjScheduled({ text, at: 'now', reason: 'programme_segment_transition' })
    return { status: 'success', data: { advanced: true, completed: false } }
  }
}
