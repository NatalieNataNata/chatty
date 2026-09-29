import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Activity, AgentSkill, BehaviorEvent, ChatMessage, ConversationSummary, LedgerEvent, MemoryCandidate, MemoryRecord, PlaybackTarget, PlayerState, ProfileFact, RadioPlan, Track } from '@chatty/shared'
import { agentSkillSchema, behaviorEventSchema, conversationSummarySchema, ledgerEventSchema, memoryCandidateSchema, memoryRecordSchema, playerStateSchema, profileFactSchema, radioPlanSchema, trackSchema } from '@chatty/shared'
import { dataDir } from '../paths.js'
import type { StateStore } from '../types.js'

const defaultPlayer: PlayerState = {
  currentTrack: null,
  queue: [],
  isPlaying: false,
  lastSay: null,
  mode: 'idle',
  reason: '',
  target: 'web',
}

export class SqliteStateStore implements StateStore {
  private db: Database.Database

  constructor(dbPath = resolve(dataDir, 'chatty.db')) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.bootstrap()
  }

  private bootstrap() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memories (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS played_tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_json TEXT NOT NULL,
        played_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS radio_plans (
        id TEXT PRIMARY KEY,
        plan_json TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS behavior_events (
        id TEXT PRIMARY KEY,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_records (
        id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_candidates (
        id TEXT PRIMARY KEY,
        candidate_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ledger_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        event_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profile_facts (
        id TEXT PRIMARY KEY,
        fact_json TEXT NOT NULL,
        fact_key TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        valid_to TEXT,
        status TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS profile_facts_current_idx ON profile_facts (fact_key, valid_to, status);
      CREATE TABLE IF NOT EXISTS conversation_summaries (
        session_id TEXT PRIMARY KEY,
        summary_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_skills (
        id TEXT PRIMARY KEY,
        skill_json TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plan_outcomes (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        activity TEXT NOT NULL,
        outcome TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
    `)

    this.db.prepare('INSERT OR IGNORE INTO app_state (key, value) VALUES (?, ?)').run('player', JSON.stringify(defaultPlayer))
    this.seedSkills()
    this.backfillLegacyState()
  }

  private seedSkills() {
    const now = new Date().toISOString()
    const skills: AgentSkill[] = [
      {
        id: 'study-radio-v1', name: 'Study radio arc', version: 1, activities: ['study'], trigger: 'A listener asks for focused work music.',
        steps: ['Read current activity, explicit preferences, and recent skips.', 'Prefer personal-library tracks with low lyric density when requested.', 'Open briefly, preserve long uninterrupted passages, and only replan on an explicit request or repeated skips.'],
        guardrails: ['Do not infer a permanent dislike from a skip.', 'Do not interrupt deep-focus listening without a reason.'], status: 'active', source: 'system', evidence: [], createdAt: now, updatedAt: now,
      },
      {
        id: 'running-radio-v1', name: 'Running radio arc', version: 1, activities: ['running'], trigger: 'A listener asks for a running or workout set.',
        steps: ['Build a warm-up, sustained-energy, and cool-down arc.', 'Use observed skips as temporary evidence only.', 'Replan energy when the listener explicitly asks or changes activity.'],
        guardrails: ['Keep transitions brief while the listener is moving.'], status: 'active', source: 'system', evidence: [], createdAt: now, updatedAt: now,
      },
      {
        id: 'preference-confirmation-v1', name: 'Preference confirmation', version: 1, activities: ['study', 'running', 'commute', 'relax', 'sleep', 'general'], trigger: 'Repeated behavior suggests a possible preference.',
        steps: ['Record the behavior as evidence.', 'Ask whether it applies now, to this activity, or globally.', 'Write a fact only after explicit confirmation.'],
        guardrails: ['Never silently turn implicit behavior into a permanent preference.'], status: 'active', source: 'system', evidence: [], createdAt: now, updatedAt: now,
      },
    ]
    const insert = this.db.prepare('INSERT OR IGNORE INTO agent_skills (id, skill_json, status, updated_at) VALUES (?, ?, ?, ?)')
    for (const skill of skills) insert.run(skill.id, JSON.stringify(skill), skill.status, skill.updatedAt)
  }

  private backfillLegacyState() {
    const ledgerCount = (this.db.prepare('SELECT COUNT(*) AS count FROM ledger_events').get() as { count: number }).count
    if (ledgerCount > 0) return

    const messages = this.db.prepare('SELECT id, role, content, timestamp FROM messages ORDER BY id ASC').all() as Array<{ id: number; role: ChatMessage['role']; content: string; timestamp: string }>
    for (const message of messages) {
      this.appendLedger({
        type: 'message_recorded', entityType: 'message', entityId: String(message.id), payload: { role: message.role, content: message.content, timestamp: message.timestamp },
        occurredAt: message.timestamp, actor: message.role === 'user' ? 'user' : message.role === 'agent' ? 'agent' : 'system',
      })
    }

    const behaviors = this.db.prepare('SELECT event_json FROM behavior_events ORDER BY created_at ASC').all() as Array<{ event_json: string }>
    for (const row of behaviors) {
      const event = behaviorEventSchema.parse(JSON.parse(row.event_json))
      this.appendLedger({ type: 'behavior_observed', entityType: 'behavior_event', entityId: event.id!, payload: event, occurredAt: event.createdAt!, actor: 'user' })
    }

    const records = this.db.prepare('SELECT id, record_json FROM memory_records').all() as Array<{ id: string; record_json: string }>
    for (const row of records) {
      const parsed = memoryRecordSchema.parse(JSON.parse(row.record_json))
      const normalized: MemoryRecord = {
        ...parsed,
        validFrom: parsed.validFrom ?? parsed.createdAt,
        validTo: parsed.validTo ?? null,
        recordedAt: parsed.recordedAt ?? parsed.updatedAt,
      }
      this.db.prepare('UPDATE memory_records SET record_json = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(normalized), normalized.status, normalized.updatedAt, row.id)
      this.appendLedger({ type: 'memory_confirmed', entityType: 'memory_record', entityId: normalized.id, payload: normalized, occurredAt: normalized.validFrom!, actor: 'user' })
      if (normalized.status === 'confirmed' && !normalized.validTo) {
        this.setProfileFact(`memory.${normalized.scope}.${normalized.context ?? 'all'}.${normalized.subject.toLowerCase()}`, {
          preference: normalized.preference,
          memoryId: normalized.id,
          confidence: normalized.confidence,
        }, normalized.validFrom)
      }
    }

    const plans = this.db.prepare('SELECT plan_json FROM radio_plans ORDER BY updated_at ASC').all() as Array<{ plan_json: string }>
    for (const row of plans) {
      const plan = radioPlanSchema.parse(JSON.parse(row.plan_json))
      this.appendLedger({ type: 'plan_created', entityType: 'radio_plan', entityId: plan.id, payload: plan, occurredAt: plan.updatedAt, actor: 'agent' })
    }
  }

  private upsertState(key: string, value: string) {
    this.db
      .prepare(`
        INSERT INTO app_state (key, value)
        VALUES (@key, @value)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
      .run({ key, value })
  }

  appendLedger(input: Omit<LedgerEvent, 'id' | 'recordedAt'> & Partial<Pick<LedgerEvent, 'id' | 'recordedAt'>>): LedgerEvent {
    const event = ledgerEventSchema.parse({
      ...input,
      id: input.id ?? crypto.randomUUID(),
      recordedAt: input.recordedAt ?? new Date().toISOString(),
    })
    this.db
      .prepare('INSERT INTO ledger_events (id, event_json, occurred_at, recorded_at) VALUES (?, ?, ?, ?)')
      .run(event.id, JSON.stringify(event), event.occurredAt, event.recordedAt)
    return event
  }

  getLedgerEvents(limit = 100): LedgerEvent[] {
    const rows = this.db
      .prepare('SELECT event_json FROM ledger_events ORDER BY sequence DESC LIMIT ?')
      .all(limit) as Array<{ event_json: string }>
    return rows.reverse().map((row) => ledgerEventSchema.parse(JSON.parse(row.event_json)))
  }

  private refreshConversationSummary() {
    const all = this.db.prepare('SELECT role, content, timestamp FROM messages ORDER BY id ASC').all() as ChatMessage[]
    const windowSize = 12
    const archived = all.slice(0, Math.max(0, all.length - windowSize))
    if (!archived.length) return
    const now = new Date().toISOString()
    const lines = archived.slice(-8).map((message) => {
      const compact = message.content.replace(/\s+/g, ' ').trim().slice(0, 180)
      return `${message.role === 'user' ? 'Listener' : 'Chatty'}: ${compact}`
    })
    const summary: ConversationSummary = {
      sessionId: 'primary',
      content: lines.join('\n'),
      sourceMessageCount: archived.length,
      createdAt: this.getConversationSummary()?.createdAt ?? now,
      updatedAt: now,
    }
    this.db
      .prepare(`INSERT INTO conversation_summaries (session_id, summary_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET summary_json = excluded.summary_json, updated_at = excluded.updated_at`)
      .run(summary.sessionId, JSON.stringify(summary), summary.updatedAt)
  }

  getConversationSummary(sessionId = 'primary'): ConversationSummary | null {
    const row = this.db.prepare('SELECT summary_json FROM conversation_summaries WHERE session_id = ?').get(sessionId) as { summary_json: string } | undefined
    return row ? conversationSummarySchema.parse(JSON.parse(row.summary_json)) : null
  }

  getMessages(limit = 20): ChatMessage[] {
    const rows = this.db
      .prepare('SELECT role, content, timestamp FROM messages ORDER BY id DESC LIMIT ?')
      .all(limit) as ChatMessage[]

    return rows.reverse()
  }

  addMessage(message: ChatMessage) {
    const result = this.db
      .prepare('INSERT INTO messages (role, content, timestamp) VALUES (?, ?, ?)')
      .run(message.role, message.content, message.timestamp)
    this.appendLedger({
      type: 'message_recorded', entityType: 'message', entityId: String(result.lastInsertRowid), payload: message,
      occurredAt: message.timestamp, actor: message.role === 'user' ? 'user' : message.role === 'agent' ? 'agent' : 'system',
    })
    this.refreshConversationSummary()
  }

  getPlayerState(): PlayerState {
    const row = this.db.prepare('SELECT value FROM app_state WHERE key = ?').get('player') as
      | { value: string }
      | undefined

    if (!row) {
      return defaultPlayer
    }

    return playerStateSchema.parse(JSON.parse(row.value))
  }

  setPlayerState(player: PlayerState) {
    this.upsertState('player', JSON.stringify(player))
  }

  addLog(message: string) {
    this.db.prepare('INSERT INTO logs (message, at) VALUES (?, ?)').run(message, new Date().toISOString())
  }

  getLogs(limit = 20) {
    const rows = this.db
      .prepare('SELECT message, at FROM logs ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<{ message: string; at: string }>

    return rows.reverse()
  }

  remember(key: string, value: string) {
    this.db
      .prepare(`
        INSERT INTO memories (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
      .run(key, value)
  }

  getMemories() {
    return this.db.prepare('SELECT key, value FROM memories ORDER BY key ASC').all() as Array<{
      key: string
      value: string
    }>
  }

  getRecentTracks(limit = 10): Track[] {
    const rows = this.db
      .prepare('SELECT track_json FROM played_tracks ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<{ track_json: string }>

    return rows.map((row) => trackSchema.parse(JSON.parse(row.track_json)))
  }

  appendPlayedTrack(track: Track) {
    this.db
      .prepare('INSERT INTO played_tracks (track_json, played_at) VALUES (?, ?)')
      .run(JSON.stringify(track), new Date().toISOString())
  }

  getTarget(): PlaybackTarget {
    return this.getPlayerState().target
  }

  getCurrentPlan(): RadioPlan | null {
    const row = this.db
      .prepare("SELECT plan_json FROM radio_plans WHERE status IN ('active', 'paused') ORDER BY updated_at DESC LIMIT 1")
      .get() as { plan_json: string } | undefined
    return row ? radioPlanSchema.parse(JSON.parse(row.plan_json)) : null
  }

  setCurrentPlan(plan: RadioPlan) {
    const transaction = this.db.transaction(() => {
      this.db.prepare("UPDATE radio_plans SET status = 'replaced' WHERE status = 'active' AND id != ?").run(plan.id)
      this.db
        .prepare(`INSERT INTO radio_plans (id, plan_json, status, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET plan_json = excluded.plan_json, status = excluded.status, updated_at = excluded.updated_at`)
        .run(plan.id, JSON.stringify(plan), plan.status, plan.updatedAt)
    })
    transaction()
    this.appendLedger({ type: 'plan_created', entityType: 'radio_plan', entityId: plan.id, payload: plan, occurredAt: plan.updatedAt, actor: 'agent' })
  }

  addBehaviorEvent(input: BehaviorEvent): BehaviorEvent {
    const event = behaviorEventSchema.parse({
      ...input,
      id: input.id ?? crypto.randomUUID(),
      createdAt: input.createdAt ?? new Date().toISOString(),
    })
    this.db
      .prepare('INSERT INTO behavior_events (id, event_json, created_at) VALUES (?, ?, ?)')
      .run(event.id, JSON.stringify(event), event.createdAt)
    this.appendLedger({ type: 'behavior_observed', entityType: 'behavior_event', entityId: event.id!, payload: event, occurredAt: event.createdAt!, actor: 'user' })
    return event
  }

  getBehaviorEvents(limit = 50): BehaviorEvent[] {
    const rows = this.db
      .prepare('SELECT event_json FROM behavior_events ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<{ event_json: string }>
    return rows.reverse().map((row) => behaviorEventSchema.parse(JSON.parse(row.event_json)))
  }

  addMemoryCandidate(candidate: MemoryCandidate) {
    this.db
      .prepare('INSERT OR REPLACE INTO memory_candidates (id, candidate_json, status, created_at) VALUES (?, ?, ?, ?)')
      .run(candidate.id, JSON.stringify(candidate), candidate.status, candidate.createdAt)
    this.appendLedger({ type: 'memory_candidate_created', entityType: 'memory_candidate', entityId: candidate.id, payload: candidate, occurredAt: candidate.createdAt, actor: 'agent' })
  }

  getPendingMemoryCandidate(): MemoryCandidate | null {
    const row = this.db
      .prepare("SELECT candidate_json FROM memory_candidates WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1")
      .get() as { candidate_json: string } | undefined
    return row ? memoryCandidateSchema.parse(JSON.parse(row.candidate_json)) : null
  }

  resolveMemoryCandidate(id: string, status: 'confirmed' | 'rejected') {
    const row = this.db.prepare('SELECT candidate_json FROM memory_candidates WHERE id = ?').get(id) as
      | { candidate_json: string }
      | undefined
    if (!row) return
    const candidate = memoryCandidateSchema.parse(JSON.parse(row.candidate_json))
    const next = { ...candidate, status }
    this.db.prepare('UPDATE memory_candidates SET candidate_json = ?, status = ? WHERE id = ?').run(JSON.stringify(next), status, id)
    this.appendLedger({
      type: status === 'confirmed' ? 'memory_confirmed' : 'memory_forgotten', entityType: 'memory_candidate', entityId: id,
      payload: next, occurredAt: new Date().toISOString(), actor: 'user',
    })
  }

  upsertMemory(record: MemoryRecord) {
    const now = new Date().toISOString()
    const normalized: MemoryRecord = {
      ...record,
      validFrom: record.validFrom ?? now,
      validTo: record.validTo ?? null,
      recordedAt: record.recordedAt ?? now,
      updatedAt: record.updatedAt ?? now,
    }
    const sameFact = this.getAllMemoryRecords().filter((current) =>
      current.status === 'confirmed' && !current.validTo && current.id !== normalized.id &&
      current.subject === normalized.subject && current.scope === normalized.scope && current.context === normalized.context,
    )
    for (const previous of sameFact) {
      const superseded: MemoryRecord = { ...previous, status: 'superseded', validTo: normalized.validFrom, updatedAt: now }
      this.db.prepare('UPDATE memory_records SET record_json = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(superseded), superseded.status, now, previous.id)
      this.appendLedger({ type: 'memory_superseded', entityType: 'memory_record', entityId: previous.id, payload: superseded, occurredAt: normalized.validFrom!, actor: 'system' })
    }
    this.db
      .prepare(`INSERT INTO memory_records (id, record_json, status, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json, status = excluded.status, updated_at = excluded.updated_at`)
      .run(normalized.id, JSON.stringify(normalized), normalized.status, normalized.updatedAt)
    this.setProfileFact(`memory.${normalized.scope}.${normalized.context ?? 'all'}.${normalized.subject.toLowerCase()}`, {
      preference: normalized.preference,
      memoryId: normalized.id,
      confidence: normalized.confidence,
    }, normalized.validFrom)
    this.appendLedger({ type: 'memory_confirmed', entityType: 'memory_record', entityId: normalized.id, payload: normalized, occurredAt: normalized.validFrom!, actor: 'user' })
  }

  getMemoriesFor(activity: Activity = 'general'): MemoryRecord[] {
    const now = new Date().toISOString()
    return this.getAllMemoryRecords().filter((memory) =>
      memory.status === 'confirmed' &&
      !memory.validTo &&
      (!memory.expiresAt || memory.expiresAt > now) &&
      (memory.scope === 'global' || memory.scope === 'session' || memory.context === activity),
    )
  }

  getAllMemoryRecords(): MemoryRecord[] {
    const rows = this.db.prepare('SELECT record_json FROM memory_records ORDER BY updated_at DESC').all() as Array<{
      record_json: string
    }>
    return rows
      .map((row) => memoryRecordSchema.parse(JSON.parse(row.record_json)))
      .filter((memory) => memory.status === 'confirmed' && !memory.validTo)
  }

  deleteMemory(id: string) {
    const current = this.getAllMemoryRecords().find((memory) => memory.id === id)
    if (!current) return
    const now = new Date().toISOString()
    const forgotten: MemoryRecord = { ...current, status: 'forgotten', validTo: now, updatedAt: now }
    this.db.prepare('UPDATE memory_records SET record_json = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(forgotten), forgotten.status, now, id)
    this.appendLedger({ type: 'memory_forgotten', entityType: 'memory_record', entityId: id, payload: forgotten, occurredAt: now, actor: 'user' })
  }

  getProfileFacts(keys?: string[]): ProfileFact[] {
    const rows = this.db.prepare("SELECT fact_json FROM profile_facts WHERE status = 'active' AND valid_to IS NULL ORDER BY valid_from DESC").all() as Array<{ fact_json: string }>
    const facts = rows.map((row) => profileFactSchema.parse(JSON.parse(row.fact_json)))
    return keys?.length ? facts.filter((fact) => keys.includes(fact.key)) : facts
  }

  setProfileFact(key: string, value: unknown, occurredAt = new Date().toISOString()): ProfileFact {
    const now = new Date().toISOString()
    const current = this.getProfileFacts([key])
    for (const previous of current) {
      const superseded: ProfileFact = { ...previous, status: 'superseded', validTo: occurredAt }
      this.db.prepare('UPDATE profile_facts SET fact_json = ?, valid_to = ?, status = ? WHERE id = ?')
        .run(JSON.stringify(superseded), occurredAt, superseded.status, previous.id)
      this.appendLedger({ type: 'profile_fact_superseded', entityType: 'profile_fact', entityId: previous.id, payload: superseded, occurredAt, actor: 'system' })
    }
    const ledger = this.appendLedger({ type: 'profile_fact_recorded', entityType: 'profile_fact', entityId: crypto.randomUUID(), payload: { key, value }, occurredAt, actor: 'system' })
    const fact: ProfileFact = { id: ledger.entityId, key, value, validFrom: occurredAt, validTo: null, recordedAt: now, sourceLedgerId: ledger.id, status: 'active' }
    this.db.prepare('INSERT INTO profile_facts (id, fact_json, fact_key, valid_from, valid_to, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(fact.id, JSON.stringify(fact), key, fact.validFrom, fact.validTo, fact.status)
    return fact
  }

  getSkillsFor(activity: Activity = 'general'): AgentSkill[] {
    const rows = this.db.prepare("SELECT skill_json FROM agent_skills WHERE status = 'active' ORDER BY updated_at DESC").all() as Array<{ skill_json: string }>
    return rows.map((row) => agentSkillSchema.parse(JSON.parse(row.skill_json))).filter((skill) => skill.activities.includes(activity))
  }

  recordSkillUse(skillId: string, planId: string | null = null) {
    this.appendLedger({ type: 'skill_used', entityType: 'agent_skill', entityId: skillId, payload: { planId }, occurredAt: new Date().toISOString(), actor: 'agent' })
  }

  recordPlanOutcome(plan: RadioPlan, outcome: 'completed' | 'abandoned'): AgentSkill | null {
    const now = new Date().toISOString()
    this.db.prepare('INSERT INTO plan_outcomes (id, plan_id, activity, outcome, recorded_at) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), plan.id, plan.activity, outcome, now)
    this.appendLedger({ type: 'skill_used', entityType: 'plan_outcome', entityId: plan.id, payload: { activity: plan.activity, outcome }, occurredAt: now, actor: 'system' })
    if (outcome !== 'completed') return null

    const successful = this.db.prepare("SELECT plan_id FROM plan_outcomes WHERE activity = ? AND outcome = 'completed' ORDER BY recorded_at DESC LIMIT 3")
      .all(plan.activity) as Array<{ plan_id: string }>
    if (successful.length < 3) return null
    const id = `learned-${plan.activity}-v1`
    const existing = this.db.prepare('SELECT skill_json FROM agent_skills WHERE id = ?').get(id) as { skill_json: string } | undefined
    if (existing) return agentSkillSchema.parse(JSON.parse(existing.skill_json))

    const skill: AgentSkill = {
      id,
      name: `Learned ${plan.activity} programme pattern`,
      version: 1,
      activities: [plan.activity],
      trigger: `Three completed ${plan.activity} radio plans showed this trajectory is reusable.`,
      steps: ['Start from the listener\'s confirmed preferences and current plan constraints.', 'Build a varied queue from the personal library instead of repeating title families.', 'Keep DJ interruptions proportional to the activity and replan only from explicit feedback or material behavior evidence.'],
      guardrails: ['This skill contains no raw conversation or private user text.', 'Confirmed preferences always override this learned procedure.'],
      status: 'active', source: 'learned', evidence: successful.map((row) => row.plan_id), createdAt: now, updatedAt: now,
    }
    this.db.prepare('INSERT INTO agent_skills (id, skill_json, status, updated_at) VALUES (?, ?, ?, ?)')
      .run(skill.id, JSON.stringify(skill), skill.status, skill.updatedAt)
    this.appendLedger({ type: 'skill_used', entityType: 'agent_skill', entityId: skill.id, payload: { promotedFromPlans: skill.evidence }, occurredAt: now, actor: 'system' })
    return skill
  }

  getMemoryView(activity: Activity = 'general') {
    const facts = this.getProfileFacts()
    const profile = Object.fromEntries(facts.filter((fact) => !fact.key.startsWith('memory.')).map((fact) => [fact.key, fact.value]))
    return {
      profile,
      facts: facts.filter((fact) => fact.key.startsWith('memory.')),
      conversationSummary: this.getConversationSummary(),
      skills: this.getSkillsFor(activity),
    }
  }
}
