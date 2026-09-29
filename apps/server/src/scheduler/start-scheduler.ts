import type { BehaviorEvent, RadioPlan } from '@chatty/shared'
import type { RuntimeDeps, RuntimeEvent, RuntimeAction, ActionResult, ThinkingPolicy } from '../types.js'
import { EventFilter } from '../runtime/event-filter.js'
import { DecisionEngine } from '../runtime/decision-engine.js'
import { ActionExecutor } from '../runtime/action-executor.js'
import { ObservationStore } from '../runtime/observation-store.js'
import { TraceStore } from '../runtime/trace-store.js'
import { getThinkingPolicy, summarizeObservations } from '../runtime/thinking-policy.js'
import { PlannerAgent } from '../agent/planner.js'
import { SkillRegistry } from '../skills/skill-registry.js'
import { MusicQueueBuilderSkill } from '../skills/music/queue-builder.js'
import { DjSpeechGeneratorSkill } from '../skills/dj/speech-generator.js'
import { SegmentNavigatorSkill } from '../skills/programme/segment-navigator.js'
import { PlanRevisionSkill } from '../skills/programme/plan-revision-skill.js'
import { NoopSkill } from '../skills/noop.js'
import { MemoryLedger } from '../memory/memory-ledger.js'
import { UserProfile } from '../memory/user-profile.js'
import { SessionTracker } from '../memory/session-context.js'
import { OutcomeStore } from '../evaluation/outcome-store.js'
import { StrategyEvaluator } from '../evaluation/strategy-evaluator.js'
import { computeMetrics, extractStrategySignature } from '../evaluation/metrics.js'
import { buildContext } from '../context/build-context.js'
import { getTransitionText } from '../templates/response-templates.js'



export class ProgrammeScheduler {
  private readonly eventFilter: EventFilter
  private readonly decisionEngine: DecisionEngine
  private readonly actionExecutor: ActionExecutor
  readonly skillRegistry: SkillRegistry
  readonly memoryLedger: MemoryLedger
  readonly userProfile: UserProfile
  readonly sessionTracker: SessionTracker
  readonly outcomeStore: OutcomeStore
  readonly strategyEvaluator: StrategyEvaluator
  private readonly observationStore: ObservationStore
  readonly traceStore: TraceStore
  private readonly planner: PlannerAgent

  private lastDecisionAt: number | null = null
  private currentPolicy: ThinkingPolicy = getThinkingPolicy('general')

  constructor(private readonly deps: RuntimeDeps) {
    this.planner = new PlannerAgent(deps.agent)
    this.skillRegistry = new SkillRegistry()
    this.skillRegistry.register(new MusicQueueBuilderSkill())
    this.skillRegistry.register(new DjSpeechGeneratorSkill())
    this.skillRegistry.register(new SegmentNavigatorSkill())
    this.skillRegistry.register(new PlanRevisionSkill())
    this.skillRegistry.register(new NoopSkill())

    this.memoryLedger = new MemoryLedger(deps.state)
    this.userProfile = new UserProfile(this.memoryLedger, deps.state)
    this.sessionTracker = new SessionTracker()

    this.eventFilter = new EventFilter()
    this.observationStore = new ObservationStore()
    this.outcomeStore = new OutcomeStore()
    this.strategyEvaluator = new StrategyEvaluator(this.outcomeStore)
    this.traceStore = new TraceStore()
    this.decisionEngine = new DecisionEngine({ agent: deps.agent, state: deps.state, planner: this.planner })
    this.actionExecutor = new ActionExecutor({
      state: deps.state,
      broadcaster: deps.broadcaster,
      planner: this.planner,
      skillRegistry: this.skillRegistry,
      onActionFailed: (actionType, reason) => {
        this.deps.broadcaster.emitLog(`Action failed [${actionType}]: ${reason}`)
      },
    })
  }

  start() {
    this.deps.broadcaster.emitLog('Programme scheduler active.')
  }

  /**
   * 每次行为事件入口。
   * 1. 记录到 ObservationStore
   * 2. 根据当前 plan activity 更新 thinking policy
   * 3. 构建 RuntimeEvent → 移交 emitDecision
   */
  observe(event: BehaviorEvent) {
    const plan = this.deps.state.getCurrentPlan()
    // 记录到长期记忆
    this.memoryLedger.recordBehavior(event)
    if (!plan || plan.status !== 'active') return null

    this.observationStore.record(event)
    this.currentPolicy = getThinkingPolicy(plan.activity)

    if (event.type === 'completed') {
      const completed = this.deps.state.getBehaviorEvents(100).filter((item) => item.planId === plan.id && item.type === 'completed').length
      if (completed > 0 && completed % 3 === 0) {
        // 每3首完成触发一次段推进（后续可迁移到 DecisionEngine）
        const currentP = this.deps.state.getCurrentPlan()
        if (!currentP || currentP.status !== 'active') return null
        if (currentP.currentSegmentIndex >= currentP.segments.length - 1) {
          const finished = { ...currentP, status: 'completed' as const, updatedAt: new Date().toISOString() }
          this.deps.state.setCurrentPlan(finished)
          this.deps.state.recordPlanOutcome(finished, 'completed')
          this.deps.broadcaster.emitPlan(finished)
          return null
        }
        const segments = currentP.segments.map((seg, index) =>
          index < currentP.currentSegmentIndex + 1 ? { ...seg, completed: true } : seg,
        )
        const next = { ...currentP, segments, currentSegmentIndex: currentP.currentSegmentIndex + 1, updatedAt: new Date().toISOString() } as RadioPlan
        this.deps.state.setCurrentPlan(next)
        this.deps.broadcaster.emitPlan(next)
        const text = getTransitionText(next.activity, next.segments[next.currentSegmentIndex]?.label)
        if (text) this.deps.broadcaster.emitDjScheduled({ text, at: 'now', reason: 'programme_segment_transition' })
        return text
      }
    }

    if (event.type === 'skip') {
      const recent = this.observationStore.getRecent(10 * 60 * 1000)
      const skips = recent.filter((e) => e.eventType === 'skip')
      if (skips.length >= (this.currentPolicy.thresholds.skipCount ?? 3)) {
        void this.emitDecision({
          type: 'skip_pattern',
          count: skips.length,
          activity: plan.activity,
          recentArtists: [...new Set(skips.map((s) => s.trackArtist).filter(Boolean) as string[])],
        }, plan)
      }
    }

    return null
  }

  /**
   * 核心决策循环：ThinkingPolicy → EventFilter → DecisionEngine → ActionExecutor → Trace
   */
  private async emitDecision(event: RuntimeEvent, plan: RadioPlan) {
    const recent = this.observationStore.getRecent(10 * 60 * 1000)
    const experience = this.strategyEvaluator.summarizeExperience(plan.activity)
    const results: Array<{ actionType: string; status: ActionResult['status']; error?: ActionResult['error'] }> = []

    if (!this.eventFilter.shouldTrigger(event, this.currentPolicy, this.lastDecisionAt, recent)) {
      return
    }

    this.lastDecisionAt = Date.now()
    const traceStart = Date.now()

    try {
      const context = await buildContext(event.type, this.deps, plan.activity)
      const obsSummary = summarizeObservations(recent)
      const userProfileSummary = await this.userProfile.summarize()
      const sessionSummary = this.sessionTracker.summarize()
      const memoryPrefix = [experience && `[Experience] ${experience}`, userProfileSummary, sessionSummary].filter(Boolean).join('\n') + '\n'

      const decision = await this.decisionEngine.decide(
        { ...event } as RuntimeEvent,
        { ...context, userMessage: `${memoryPrefix}${event.type} | ${obsSummary}` },
        plan,
      )

      for (const action of decision.actions) {
        const result = await this.actionExecutor.execute(action)
        this.deps.broadcaster.emitLog(`Action [${action.capability}]: ${result.status}`)
        results.push({ actionType: action.capability, status: result.status, error: result.error })
      if (result.status === 'failed') break
     }

      // 如果计划已完成，记录策略结果
      const updatedPlan = this.deps.state.getCurrentPlan()
      if (updatedPlan?.status === 'completed' && updatedPlan.id === plan.id) {
        const plays = this.observationStore.getRecent(30 * 60 * 1000).filter((o) => o.eventType === 'play')
        const completedSongs = this.observationStore.getRecent(30 * 60 * 1000).filter((o) => o.eventType === 'completed')
        const skips = this.observationStore.getRecent(30 * 60 * 1000).filter((o) => o.eventType === 'skip')
        const total = plays.length + completedSongs.length
        const signature = extractStrategySignature(
          updatedPlan.activity,
          updatedPlan.segments,
        )
        this.outcomeStore.record({
          strategyId: `${updatedPlan.activity}-${Date.now()}`,
          strategy: { activity: updatedPlan.activity, ...signature },
          recordedAt: new Date().toISOString(),
          metrics: {
            completionRate: total > 0 ? completedSongs.length / total : 0,
            skipRate: total > 0 ? skips.length / total : 0,
            sessionDurationMin: updatedPlan.durationMin,
            totalPlays: plays.length,
            totalSkips: skips.length,
          },
        })
        this.deps.broadcaster.emitLog(`Recorded outcome for ${updatedPlan.activity}: ${completedSongs.length}/${total} completed`)
      }

      this.traceStore.record(
        event.type,
        JSON.stringify(event).slice(0, 200),
        decision.reason,
        decision.actions,
        results,
        Date.now() - traceStart,
      )
    } catch (error) {
      this.deps.broadcaster.emitLog(`Decision loop failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export function startScheduler(deps: RuntimeDeps) {
  const scheduler = new ProgrammeScheduler(deps)
  scheduler.start()
  return scheduler
}
