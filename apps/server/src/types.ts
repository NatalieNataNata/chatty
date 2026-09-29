import type {
  Activity,
  AgentSkill,
  AgentDecision,
  BehaviorEvent,
  ChatMessage,
  EnvSnapshot,
  LedgerEvent,
  MemoryCandidate,
  MemoryRecord,
  ProfileFact,
  ConversationSummary,
  PlaybackTarget,
  PlayerState,
  RadioPlan,
  SayEvent,
  ToolRequest,
  ToolResult,
  Track,
} from '@chatty/shared'

export interface MusicSearchOptions {
  preferredCandidates?: Array<{ title: string; artist: string }>
  /** 当用户明确指定 artist 时，搜索应优先补齐该 artist 的候选 */
  strictArtist?: string
}

export interface PersonaBundle {
  djPersona: string
  user: string
  taste: string
  routines: string
  playlists: string
  moodRules: string
}

export interface ContextBundle {
  persona: PersonaBundle
  environment: EnvSnapshot
  history: ChatMessage[]
  lastTracks: Track[]
  memories: MemoryRecord[]
  memoryView: {
    profile: Record<string, unknown>
    facts: ProfileFact[]
    conversationSummary: ConversationSummary | null
    skills: AgentSkill[]
  }
  currentPlan: RadioPlan | null
  userMessage: string
  /** 对话意图和回复策略指令（由 ConversationIntent + ResponsePolicy 生成） */
  conversationPolicy?: string
}

export interface MusicProvider {
  search(query: string, context: ContextBundle, options?: MusicSearchOptions): Promise<Track[]>
  getUserPlaylists?(): Promise<unknown>
}

export interface TtsProvider {
  synthesize(text: string): Promise<SayEvent>
}

export interface CalendarProvider {
  getTodaySummary(): Promise<string>
}

export interface WeatherProvider {
  getCurrentSummary(): Promise<string>
}

export interface AgentProvider {
  decide(context: ContextBundle): Promise<AgentDecision>
  narrateTrack(context: ContextBundle, track: Track, moment: 'programme_open' | 'track_change' | 'explain'): Promise<string>
  composeOpening(
    context: ContextBundle,
    currentTrack: Track | null,
    mode: 'fresh' | 'resume',
  ): Promise<{ line: string; suggestions: string[] }>
}

export interface RuntimeDeps {
  state: StateStore
  music: MusicProvider
  tts: TtsProvider
  calendar: CalendarProvider
  weather: WeatherProvider
  agent: AgentProvider
  broadcaster: Broadcaster
}

export interface StateStore {
  getMessages(limit?: number): ChatMessage[]
  addMessage(message: ChatMessage): void
  getPlayerState(): PlayerState
  setPlayerState(player: PlayerState): void
  addLog(message: string): void
  getLogs(limit?: number): Array<{ message: string; at: string }>
  remember(key: string, value: string): void
  getMemories(): Array<{ key: string; value: string }>
  getRecentTracks(limit?: number): Track[]
  appendPlayedTrack(track: Track): void
  getTarget(): PlaybackTarget
  getCurrentPlan(): RadioPlan | null
  setCurrentPlan(plan: RadioPlan): void
  addBehaviorEvent(event: BehaviorEvent): BehaviorEvent
  getBehaviorEvents(limit?: number): BehaviorEvent[]
  addMemoryCandidate(candidate: MemoryCandidate): void
  getPendingMemoryCandidate(): MemoryCandidate | null
  resolveMemoryCandidate(id: string, status: 'confirmed' | 'rejected'): void
  upsertMemory(record: MemoryRecord): void
  getMemoriesFor(activity?: Activity): MemoryRecord[]
  getAllMemoryRecords(): MemoryRecord[]
  deleteMemory(id: string): void
  appendLedger(event: Omit<LedgerEvent, 'id' | 'recordedAt'> & Partial<Pick<LedgerEvent, 'id' | 'recordedAt'>>): LedgerEvent
  getLedgerEvents(limit?: number): LedgerEvent[]
  getProfileFacts(keys?: string[]): ProfileFact[]
  setProfileFact(key: string, value: unknown, occurredAt?: string): ProfileFact
  getConversationSummary(sessionId?: string): ConversationSummary | null
  getMemoryView(activity?: Activity): ContextBundle['memoryView']
  getSkillsFor(activity?: Activity): AgentSkill[]
  recordSkillUse(skillId: string, planId?: string | null): void
  recordPlanOutcome(plan: RadioPlan, outcome: 'completed' | 'abandoned'): AgentSkill | null
}

export interface Broadcaster {
  emitNow(): void
  emitLog(message: string): void
  emitState(mode: string, message: string): void
  emitTts(event: SayEvent): void
  emitPlan(plan: RadioPlan): void
  emitTool(result: ToolResult): void
  emitMemoryQuestion(candidate: MemoryCandidate): void
  emitDjScheduled(payload: { text: string; at: string; reason: string }): void
}

export interface ToolRegistry {
  execute(request: ToolRequest, context: ContextBundle): Promise<ToolResult>
}

// ── V1 Planner / Decision Engine types ──

export interface PlanStepDraft {
  id: string
  segmentType: string
  duration: number
  strategy: {
    energy: string
    query: string
    djPolicy: string
  }
}

export interface PlanDraft {
  goal: string
  constraints: {
    activity: string
    duration: number
    energy?: string
  }
  steps: PlanStepDraft[]
}

export interface PlanPatch {
  segmentId: string
  changes: {
    energy?: string
    query?: string
    durationMin?: number
    djPolicy?: string
  }
}

export interface PlanRevision {
  type: 'plan_patch'
  reason: string
  patch: PlanPatch
}

export type RuntimeEvent =
  | { type: 'song_completed'; trackId: string; planId: string; segmentId: string }
  | { type: 'segment_completed'; planId: string; segmentId: string }
  | { type: 'skip_pattern'; count: number; activity: string; recentArtists: string[] }
  | { type: 'user_request'; message: string }
  | { type: 'playback_error'; reason: string }
  | { type: 'action_failed'; actionType: string; reason: string }
  | { type: 'plan_progress'; planId: string; progress: number }

export interface EngineDecision {
  reason: string
  actions: RuntimeAction[]
}

export interface RuntimeAction {
  capability: string
  input: Record<string, unknown>
  reason: string
}

export interface ActionResult {
  status: 'success' | 'partial' | 'failed' | 'unsupported'
  actionType: string
  error?: { code: string; message: string }
}

export interface PlannerProvider {
  draft(context: ContextBundle): Promise<PlanDraft>
  revise(plan: RadioPlan, event: RuntimeEvent, context: ContextBundle): Promise<PlanRevision | null>
}

export interface DecisionEngineProvider {
  decide(event: RuntimeEvent, context: ContextBundle, currentPlan: RadioPlan): Promise<EngineDecision>
}

export interface ActionExecutorDeps {
  state: StateStore
  broadcaster: Broadcaster
  planner: PlannerProvider
  /** V2: SkillRegistry 实例，ActionExecutor 优先通过它执行能力 */
  skillRegistry: { get: (name: string) => any; execute: (name: string, input: Record<string, unknown>, context: any) => Promise<{ status: string; data?: any; error?: { code: string; message: string }; recoveryHints?: string[] }> }
  onActionFailed?: (actionType: string, reason: string) => void
}

// ── V3: Experience / Evaluation ──

export interface StrategySignature {
  activity: string
  energyProfile: string
  djPolicy: string
  genreHint?: string
}

export interface StrategyOutcome {
  strategyId: string
  strategy: StrategySignature
  recordedAt: string
  metrics: {
    completionRate: number
    skipRate: number
    sessionDurationMin: number
    totalPlays: number
    totalSkips: number
  }
}

export interface ExperienceSnapshot {
  activity: string
  topStrategies: Array<{
    strategy: StrategySignature
    avgCompletionRate: number
    totalSessions: number
  }>
}

// ── V4: Personal Memory Layer ──

export interface MemoryEvent {
  id: string
  type: 'music_played' | 'song_skipped' | 'song_completed' | 'positive_feedback' | 'negative_feedback' | 'preference_signal'
  timestamp: number
  payload: Record<string, unknown>
}

export interface UserMusicProfile {
  preferredEnergy?: Record<string, string>
  preferredGenres?: string[]
  djTolerance: 'quiet' | 'balanced' | 'active'
  likesLyrics: boolean
}

export interface SessionContext {
  currentActivity?: string
  currentMood?: string
  temporaryPreference?: Record<string, unknown>
  sessionStartTime: number
  interactionCount: number
}

export interface MemoryPolicy {
  shouldWrite: (eventType: string, payload: Record<string, unknown>) => boolean
  shouldLoadForActivity: (activity: string) => boolean
}

// ── V1.4: Execution Reliability ──

export interface ActionPolicy {
  /** 最大重试次数 */
  maxRetries: number
  /** 单次超时（ms），0 表示不超时 */
  timeoutMs: number
  /** 失败后的降级动作 */
  fallbackActions?: RuntimeAction[]
}

export const DefaultActionPolicies: Record<string, ActionPolicy> = {
  rebuild_queue: { maxRetries: 1, timeoutMs: 10000 },
  apply_plan_revision: { maxRetries: 0, timeoutMs: 5000 },
  schedule_dj_message: { maxRetries: 0, timeoutMs: 5000 },
  advance_segment: { maxRetries: 0, timeoutMs: 3000 },
}

export interface TraceEntry {
  timestamp: number
  event: { type: string; detail: string }
  decision: {
    reason: string
    actions: RuntimeAction[]
  }
  results: Array<{
    actionType: string
    status: ActionResult['status']
    error?: ActionResult['error']
  }>
  durationMs: number
}

// ── V1.3: Thinking Policy ──

export interface ThinkingPolicy {
  mode: 'active' | 'quiet' | 'transition'
  /** 两次主动决策之间的最小间隔（ms） */
  minDecisionIntervalMs: number
  /** 哪些事件类型可以打破间隔限制 */
  immediateTriggers: RuntimeEvent['type'][]
  /** 阈值触发条件 */
  thresholds: {
    skipCount?: number
    errorCount?: number
  }
}

export const ThinkingPresets: Record<string, ThinkingPolicy> = {
  running: {
    mode: 'active',
    minDecisionIntervalMs: 5 * 60 * 1000,
    immediateTriggers: ['user_request', 'playback_error', 'skip_pattern'],
    thresholds: { skipCount: 3 },
  },
  study: {
    mode: 'quiet',
    minDecisionIntervalMs: 20 * 60 * 1000,
    immediateTriggers: ['user_request', 'playback_error'],
    thresholds: {},
  },
  sleep: {
    mode: 'quiet',
    minDecisionIntervalMs: 30 * 60 * 1000,
    immediateTriggers: ['user_request'],
    thresholds: {},
  },
  commute: {
    mode: 'transition',
    minDecisionIntervalMs: 8 * 60 * 1000,
    immediateTriggers: ['user_request', 'skip_pattern', 'playback_error'],
    thresholds: { skipCount: 2 },
  },
  general: {
    mode: 'active',
    minDecisionIntervalMs: 3 * 60 * 1000,
    immediateTriggers: ['user_request', 'playback_error', 'skip_pattern'],
    thresholds: { skipCount: 3 },
  },
}

// ── V1.3: Observation Store ──

export interface ObservationEntry {
  timestamp: number
  eventType: string
  segmentId?: string
  trackId?: string
  trackArtist?: string
  planId?: string
}

export interface ObservationMetrics {
  playCount: number
  skipCount: number
  completionRate: number
  totalSongs: number
}

export interface EventFilterProvider {
  shouldTrigger(
    event: RuntimeEvent,
    policy: ThinkingPolicy,
    lastDecisionAt: number | null,
    recentObservations: ObservationEntry[],
  ): boolean
}

export interface PlannerDeps {
  agent: AgentProvider
  state: StateStore
}

export interface DecisionEngineDeps {
  agent: AgentProvider
  state: StateStore
  planner: PlannerProvider
}
