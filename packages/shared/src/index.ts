import { z } from 'zod'

export const playbackTargetSchema = z.enum(['web', 'upnp'])
export type PlaybackTarget = z.infer<typeof playbackTargetSchema>

export const agentPlayItemSchema = z.object({
  query: z.string().optional(),
  songId: z.string().optional(),
  reason: z.string().optional(),
  target: playbackTargetSchema.default('web'),
  preferredCandidates: z.array(z.object({
    title: z.string(),
    artist: z.string(),
  })).max(8).default([]),
})

export const agentSegueSchema = z.object({
  style: z.string(),
  tone: z.string().optional(),
  duckMusic: z.boolean().default(true),
})

export const memoryWriteSchema = z.object({
  key: z.string(),
  value: z.string(),
})

export const intentKindSchema = z.enum([
  'start_radio',
  'conversation',
  'explain_choice',
  'change_track',
  'preference',
  'memory_confirmation',
  'playback_control',
])
export const activitySchema = z.enum(['study', 'running', 'commute', 'relax', 'sleep', 'general'])
export const energySchema = z.enum(['low', 'medium', 'high', 'rising', 'steady'])
export type Activity = z.infer<typeof activitySchema>

export const intentResultSchema = z.object({
  kind: intentKindSchema,
  activity: activitySchema.default('general'),
  mood: z.string().default('open'),
  energy: energySchema.default('medium'),
  durationMin: z.number().int().positive().max(480).nullable().default(null),
  lyricDensity: z.enum(['low', 'medium', 'high', 'any']).default('any'),
  djFrequency: z.enum(['minimal', 'balanced', 'active']).default('balanced'),
  confidence: z.number().min(0).max(1),
})
export type IntentResult = z.infer<typeof intentResultSchema>

export const planSegmentSchema = z.object({
  id: z.string(),
  label: z.string(),
  durationMin: z.number().int().positive(),
  energy: energySchema,
  query: z.string(),
  djPolicy: z.enum(['intro', 'quiet', 'transition', 'check_in']),
  completed: z.boolean().default(false),
})
export type PlanSegment = z.infer<typeof planSegmentSchema>

export const programmeDraftSchema = z.object({
  goal: z.string(),
  durationMin: z.number().int().positive().max(480),
  constraints: z.array(z.string()).default([]),
  replanTriggers: z.array(z.string()).default([]),
  segments: z.array(z.object({
    label: z.string(),
    durationMin: z.number().int().positive(),
    energy: energySchema,
    query: z.string(),
    djPolicy: z.enum(['intro', 'quiet', 'transition', 'check_in']),
  })).min(1).max(8),
})
export type ProgrammeDraft = z.infer<typeof programmeDraftSchema>

export const radioPlanSchema = z.object({
  id: z.string(),
  goal: z.string(),
  intent: intentResultSchema,
  activity: activitySchema,
  durationMin: z.number().int().positive(),
  segments: z.array(planSegmentSchema).min(1),
  currentSegmentIndex: z.number().int().nonnegative().default(0),
  status: z.enum(['active', 'paused', 'completed', 'replaced']).default('active'),
  constraints: z.array(z.string()).default([]),
  replanTriggers: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type RadioPlan = z.infer<typeof radioPlanSchema>

export const toolNameSchema = z.enum([
  'memory_search',
  'library_search',
  'music_search',
  'get_user_playlists',
  'resolve_audio',
  'playback_control',
  'get_weather',
  'get_calendar',
  'tts_synthesize',
  'schedule_segue',
])
export const toolRequestSchema = z.object({
  id: z.string(),
  name: toolNameSchema,
  arguments: z.record(z.string(), z.unknown()).default({}),
})
export type ToolRequest = z.infer<typeof toolRequestSchema>
export const toolResultSchema = z.object({
  id: z.string(),
  name: toolNameSchema,
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z.string().optional(),
})
export type ToolResult = z.infer<typeof toolResultSchema>

export const behaviorEventTypeSchema = z.enum([
  'play',
  'pause',
  'completed',
  'skip',
  'manual_select',
  'favorite',
  'remove',
  'feedback',
  'progress',
])
export const behaviorEventSchema = z.object({
  id: z.string().optional(),
  type: behaviorEventTypeSchema,
  track: z.object({ id: z.string(), title: z.string(), artist: z.string() }).nullable().default(null),
  activity: activitySchema.default('general'),
  planId: z.string().nullable().default(null),
  segmentId: z.string().nullable().default(null),
  progressSec: z.number().nonnegative().optional(),
  detail: z.string().optional(),
  createdAt: z.string().optional(),
})
export type BehaviorEvent = z.infer<typeof behaviorEventSchema>

export const memoryScopeSchema = z.enum(['session', 'contextual', 'global'])
export const memoryStatusSchema = z.enum(['candidate', 'confirmed', 'rejected', 'superseded', 'forgotten'])
export const memoryRecordSchema = z.object({
  id: z.string(),
  subject: z.string(),
  preference: z.string(),
  scope: memoryScopeSchema,
  context: activitySchema.nullable(),
  status: memoryStatusSchema,
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()).default([]),
  expiresAt: z.string().nullable(),
  validFrom: z.string().optional(),
  validTo: z.string().nullable().optional(),
  recordedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type MemoryRecord = z.infer<typeof memoryRecordSchema>
export const memoryCandidateSchema = z.object({
  id: z.string(),
  subject: z.string(),
  preference: z.string(),
  suggestedContext: activitySchema,
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()).default([]),
  question: z.string(),
  status: z.enum(['pending', 'confirmed', 'rejected']).default('pending'),
  createdAt: z.string(),
})
export type MemoryCandidate = z.infer<typeof memoryCandidateSchema>

export const ledgerEventTypeSchema = z.enum([
  'message_recorded',
  'behavior_observed',
  'memory_candidate_created',
  'memory_confirmed',
  'memory_superseded',
  'memory_forgotten',
  'agent_memory_write_rejected',
  'profile_fact_recorded',
  'profile_fact_superseded',
  'plan_created',
  'tool_executed',
  'skill_used',
])
export type LedgerEventType = z.infer<typeof ledgerEventTypeSchema>

export const ledgerEventSchema = z.object({
  id: z.string(),
  type: ledgerEventTypeSchema,
  entityType: z.string(),
  entityId: z.string(),
  payload: z.unknown(),
  occurredAt: z.string(),
  recordedAt: z.string(),
  actor: z.enum(['user', 'agent', 'system']).default('system'),
})
export type LedgerEvent = z.infer<typeof ledgerEventSchema>

export const profileFactSchema = z.object({
  id: z.string(),
  key: z.string(),
  value: z.unknown(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  recordedAt: z.string(),
  sourceLedgerId: z.string().nullable(),
  status: z.enum(['active', 'superseded', 'forgotten']),
})
export type ProfileFact = z.infer<typeof profileFactSchema>

export const conversationSummarySchema = z.object({
  sessionId: z.string(),
  content: z.string(),
  sourceMessageCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type ConversationSummary = z.infer<typeof conversationSummarySchema>

export const agentSkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number().int().positive(),
  activities: z.array(activitySchema).min(1),
  trigger: z.string(),
  steps: z.array(z.string()).min(1),
  guardrails: z.array(z.string()).default([]),
  status: z.enum(['active', 'retired']).default('active'),
  source: z.enum(['system', 'learned']).default('system'),
  evidence: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type AgentSkill = z.infer<typeof agentSkillSchema>

export const agentDecisionSchema = z.object({
  intent: intentResultSchema.optional(),
  programme: programmeDraftSchema.nullable().optional(),
  say: z.array(z.string()).nullable().default([]),
  play: z.array(agentPlayItemSchema).nullable().default([]),
  reason: z.string().nullable().default(''),
  segue: agentSegueSchema.nullable().optional(),
  memory_write: z.array(memoryWriteSchema).nullable().default([]),
  tool_requests: z.array(toolRequestSchema).nullable().default([]),
})

export type AgentDecision = z.infer<typeof agentDecisionSchema>

export const trackSchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  album: z.string().optional(),
  artwork: z.string().optional(),
  audioUrl: z.string().url(),
  durationSec: z.number(),
  moodTags: z.array(z.string()).default([]),
})

export type Track = z.infer<typeof trackSchema>

export const chatMessageSchema = z.object({
  role: z.enum(['user', 'agent', 'system']),
  content: z.string(),
  timestamp: z.string(),
})

export type ChatMessage = z.infer<typeof chatMessageSchema>

export const envSnapshotSchema = z.object({
  nowIso: z.string(),
  weather: z.string(),
  calendarSummary: z.string(),
})

export type EnvSnapshot = z.infer<typeof envSnapshotSchema>

export const chatRequestSchema = z.object({
  message: z.string().min(1),
})

export const playbackRequestSchema = z.object({
  action: z.enum(['play', 'pause', 'previous', 'next', 'ended', 'select', 'remove', 'move_up', 'move_down']),
  trackId: z.string().optional(),
})

export type PlaybackRequest = z.infer<typeof playbackRequestSchema>

export const sayEventSchema = z.object({
  id: z.string(),
  text: z.string(),
  createdAt: z.string(),
  audioUrl: z.string().optional(),
  provider: z.enum(['fish', 'macos', 'browser']).optional(),
  afterSpeech: z.enum(['continue', 'play_queue_head']).optional(),
})

export type SayEvent = z.infer<typeof sayEventSchema>

export const playerStateSchema = z.object({
  currentTrack: trackSchema.nullable(),
  queue: z.array(trackSchema),
  isPlaying: z.boolean(),
  lastSay: sayEventSchema.nullable(),
  mode: z.enum(['idle', 'thinking', 'speaking', 'playing']),
  reason: z.string(),
  target: playbackTargetSchema,
})

export type PlayerState = z.infer<typeof playerStateSchema>

export const wsEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('agent_state'),
    payload: z.object({
      mode: z.string(),
      message: z.string(),
    }),
  }),
  z.object({
    type: z.literal('now_playing'),
    payload: playerStateSchema,
  }),
  z.object({
    type: z.literal('tts_ready'),
    payload: sayEventSchema,
  }),
  z.object({
    type: z.literal('queue_updated'),
    payload: z.object({
      queue: z.array(trackSchema),
    }),
  }),
  z.object({
    type: z.literal('log'),
    payload: z.object({
      message: z.string(),
      at: z.string(),
    }),
  }),
  z.object({ type: z.literal('plan_updated'), payload: radioPlanSchema }),
  z.object({ type: z.literal('tool_state'), payload: toolResultSchema }),
  z.object({ type: z.literal('memory_question'), payload: memoryCandidateSchema }),
  z.object({
    type: z.literal('dj_scheduled'),
    payload: z.object({ text: z.string(), at: z.string(), reason: z.string() }),
  }),
])

export type WsEvent = z.infer<typeof wsEventSchema>

export const nowResponseSchema = z.object({
  player: playerStateSchema,
  messages: z.array(chatMessageSchema),
  logs: z.array(z.object({ message: z.string(), at: z.string() })),
})

export type NowResponse = z.infer<typeof nowResponseSchema>
