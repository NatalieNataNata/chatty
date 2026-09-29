import type { EngineDecision, DecisionEngineProvider, DecisionEngineDeps, ContextBundle, RuntimeEvent } from '../types.js'
import type { RadioPlan } from '@chatty/shared'

/**
 * DecisionEngine：收到 EventFilter 确认的事件后，决定下一步操作。
 *
 * DecisionEngine 只产出 RuntimeAction，不碰 state。
 * 实际执行交由 ActionExecutor。
 */
export class DecisionEngine implements DecisionEngineProvider {
  constructor(private readonly deps: DecisionEngineDeps) {}

  async decide(event: RuntimeEvent, context: ContextBundle, currentPlan: RadioPlan): Promise<EngineDecision> {
    switch (event.type) {
      case 'segment_completed': {
        const nextIndex = currentPlan.segments.findIndex((seg) => seg.id === event.segmentId) + 1
        if (nextIndex >= currentPlan.segments.length) {
          return { reason: 'All segments completed.', actions: [{ capability: 'noop', input: {}, reason: 'Radio session finished.' }] }
        }
        return { reason: `Moving to segment ${nextIndex + 1}.`, actions: [{ capability: 'segment_navigator', input: { action: 'advance' }, reason: 'Segment boundary reached.' }] }
      }

      case 'skip_pattern': {
        return this.decideSkipPattern(event, context, currentPlan)
      }

      default:
        return { reason: 'No adjustment needed.', actions: [{ capability: 'noop', input: {}, reason: 'Event does not require action.' }] }
    }
  }

  private async decideSkipPattern(event: RuntimeEvent & { type: 'skip_pattern' }, context: ContextBundle, currentPlan: RadioPlan): Promise<EngineDecision> {
    try {
      const revision = await this.deps.planner.revise(currentPlan, event, context)
      if (!revision) {
        return { reason: 'Planner determined no revision needed.', actions: [{ capability: 'noop', input: {}, reason: 'No plan revision required.' }] }
      }

      const segmentId = revision.patch.segmentId
      return {
        reason: revision.reason,
        actions: [
          { capability: 'plan_revision', input: { revision }, reason: revision.reason },
          { capability: 'music_queue_builder', input: { segmentId, query: revision.patch.changes.query }, reason: 'Plan segment adjusted; queue needs refresh.' },
          { capability: 'dj_speech_generator', input: { mode: 'recovery', text: revision.reason }, reason: 'Explain adjustment to listener.' },
        ],
      }
    } catch {
      return { reason: 'Skip pattern evaluation failed.', actions: [{ capability: 'noop', input: {}, reason: 'Could not evaluate skip pattern.' }] }
    }
  }
}
