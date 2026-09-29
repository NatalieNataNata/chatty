import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { observeBehavior, resolvePendingMemory } from './memory/memory-engine.js'
import { buildMusicDiscoveryQuery, deprioritizeQueueAfterSkip, diversifyTracks, excludeKnownTracks, feedbackFromSkips, isSurpriseMusicRequest } from './music/select-tracks.js'
import { createRadioPlan } from './planning/create-radio-plan.js'
import { classifyIntent } from './router/classify-intent.js'
import { classifyIntentSemantic } from './agent/intent-classifier.js'
import { SqliteStateStore } from './state/store.js'
import { completeSpeechTransition } from './playback/complete-speech.js'

test('turns a vague study request into a low-interruption 60 minute plan', () => {
  const intent = classifyIntent('我现在在学习，放一点适合的歌')
  const plan = createRadioPlan(intent, '我现在在学习，放一点适合的歌')
  assert.equal(intent.activity, 'study')
  assert.equal(intent.djFrequency, 'minimal')
  assert.equal(plan.durationMin, 60)
  assert.deepEqual(plan.segments.map((segment) => segment.label), ['Settle in', 'Deep focus', 'Soft landing'])
})

test('creates a staged running plan without asking for a duration', () => {
  const intent = classifyIntent('跑步听')
  const plan = createRadioPlan(intent, '跑步听')
  assert.equal(plan.activity, 'running')
  assert.equal(plan.durationMin, 45)
  assert.equal(plan.segments[1].energy, 'high')
})

test('treats a surprise request as an actual playback change', () => {
  const taskIntent = classifyIntent('随便选，给我个惊喜')
  const conversationIntent = classifyIntentSemantic('随便选，给我个惊喜')
  assert.equal(taskIntent.kind, 'change_track')
  assert.equal(conversationIntent.intent, 'change_music_request')
  assert.equal(conversationIntent.playbackPermission.canChangeSong, true)
  assert.equal(isSurpriseMusicRequest('随便选，给我个惊喜'), true)
})

test('builds a surprise pool from tracks outside the visible and recent queue', () => {
  const track = (id: string, title: string) => ({ id, title, artist: `Artist ${id}`, audioUrl: `https://audio.test/${id}.mp3`, durationSec: 180, moodTags: [] })
  const known = [track('one', 'Known One'), track('two', 'Known Two')]
  const pool = excludeKnownTracks([...known, track('three', 'Fresh Three'), track('four', 'Fresh Four')], known)
  assert.deepEqual(pool.map((item) => item.id), ['three', 'four'])
})

test('does not use an invented song title for a vague music request', () => {
  const intent = classifyIntent('来点适合现在的歌')
  const query = buildMusicDiscoveryQuery('来点适合现在的歌', intent, null, [], 'After the Rain')
  assert.notEqual(query, 'After the Rain')
  assert.match(query, /music/)
})

test('removes recent tracks and repeated title families from a radio queue', () => {
  const track = (id: string, title: string, artist: string) => ({
    id,
    title,
    artist,
    audioUrl: `https://audio.test/${id}.mp3`,
    durationSec: 180,
    moodTags: [],
  })
  const recent = [track('recent', 'After the Rain', 'Old Artist')]
  const selected = diversifyTracks([
    track('recent', 'After the Rain', 'Old Artist'),
    track('cover', 'After the Rain (Remix)', 'New Artist'),
    track('one', 'Blue Hour', 'Artist One'),
    track('two', 'Window Seat', 'Artist Two'),
    track('three', 'Open Sky', 'Artist Three'),
  ], recent, 3)

  assert.deepEqual(selected.map((item) => item.id), ['one', 'two', 'three'])
})

test('can build a full radio queue instead of stopping at three songs', () => {
  const track = (id: string) => ({ id, title: `Track ${id}`, artist: `Artist ${id}`, audioUrl: `https://audio.test/${id}.mp3`, durationSec: 220, moodTags: [] })
  const queue = diversifyTracks(Array.from({ length: 16 }, (_, index) => track(String(index))), [], 16)
  assert.equal(queue.length, 16)
})

test('moves tracks similar to a skipped song behind dissimilar choices immediately', () => {
  const track = (id: string, artist: string, album: string) => ({ id, title: id, artist, album, audioUrl: `https://audio.test/${id}.mp3`, durationSec: 220, moodTags: [] })
  const skipped = track('skipped', 'Same Artist', 'Same Album')
  const queue = deprioritizeQueueAfterSkip([
    skipped,
    track('same-artist', 'Same Artist', 'Other Album'),
    track('same-album', 'Other Artist', 'Same Album'),
    track('fresh', 'Fresh Artist', 'Fresh Album'),
  ], skipped)
  assert.deepEqual(queue.map((item) => item.id), ['skipped', 'fresh', 'same-artist', 'same-album'])
})

test('uses skips as session feedback without turning them into permanent memory', () => {
  const track = (id: string, artist: string) => ({ id, title: id, artist, audioUrl: `https://audio.test/${id}.mp3`, durationSec: 220, moodTags: [] })
  const feedback = feedbackFromSkips([
    { type: 'skip', track: { artist: 'Repeated Artist' } },
    { type: 'skip', track: { artist: 'Repeated Artist' } },
    { type: 'skip', track: { artist: 'One-off Artist' } },
  ])
  const selected = diversifyTracks([
    track('blocked', 'Repeated Artist'),
    track('penalized', 'One-off Artist'),
    track('fresh-1', 'Fresh One'),
    track('fresh-2', 'Fresh Two'),
  ], [], 3, undefined, feedback)
  assert.deepEqual(selected.map((item) => item.id), ['fresh-1', 'fresh-2', 'penalized'])
})

test('requires confirmation before turning consecutive skips into contextual memory', () => {
  const store = new SqliteStateStore(join(tmpdir(), `chatty-agent-${crypto.randomUUID()}.db`))
  const event = (id: string, title: string) => ({
    type: 'skip' as const,
    track: { id, title, artist: 'Jay Chou' },
    activity: 'study' as const,
    planId: null,
    segmentId: null,
  })
  assert.equal(observeBehavior(store, event('1', 'Song A')).candidate, null)
  const candidate = observeBehavior(store, event('2', 'Song B')).candidate
  assert.ok(candidate)
  assert.equal(store.getAllMemoryRecords().length, 0)
  const resolution = resolvePendingMemory(store, '学习的时候别放周杰伦', 'study')
  assert.equal(resolution?.record?.scope, 'contextual')
  assert.equal(resolution?.record?.context, 'study')
  assert.equal(store.getAllMemoryRecords().length, 1)
})

test('keeps a now-only skip preference in the session instead of long-term memory', () => {
  const store = new SqliteStateStore(join(tmpdir(), `chatty-session-memory-${crypto.randomUUID()}.db`))
  const event = (id: string) => ({ type: 'skip' as const, track: { id, title: id, artist: 'Test Artist' }, activity: 'relax' as const, planId: null, segmentId: null })
  observeBehavior(store, event('one'))
  observeBehavior(store, event('two'))
  const resolution = resolvePendingMemory(store, '只是现在不想听', 'relax')
  assert.equal(resolution?.record?.scope, 'session')
  assert.ok(resolution?.record?.expiresAt)
})

test('writes long-term memory only after an explicit future-scoped confirmation', () => {
  const store = new SqliteStateStore(join(tmpdir(), `chatty-global-memory-${crypto.randomUUID()}.db`))
  const event = (id: string) => ({ type: 'skip' as const, track: { id, title: id, artist: 'Test Artist' }, activity: 'general' as const, planId: null, segmentId: null })
  observeBehavior(store, event('one'))
  observeBehavior(store, event('two'))
  const clarification = resolvePendingMemory(store, '少放一点', 'general')
  assert.equal(clarification?.record, null)
  assert.ok(store.getPendingMemoryCandidate())
  assert.equal(store.getAllMemoryRecords().length, 0)
  const resolution = resolvePendingMemory(store, '以后都少放', 'general')
  assert.equal(resolution?.record?.scope, 'global')
  assert.equal(resolution?.record?.expiresAt, null)
})

test('lets the listener reject a proposed preference in conversation', () => {
  const store = new SqliteStateStore(join(tmpdir(), `chatty-rejected-memory-${crypto.randomUUID()}.db`))
  const event = (id: string) => ({ type: 'skip' as const, track: { id, title: id, artist: 'Test Artist' }, activity: 'general' as const, planId: null, segmentId: null })
  observeBehavior(store, event('one'))
  observeBehavior(store, event('two'))
  const resolution = resolvePendingMemory(store, '不用记，我只是想换一首', 'general')
  assert.equal(resolution?.record, null)
  assert.equal(store.getPendingMemoryCandidate(), null)
  assert.equal(store.getAllMemoryRecords().length, 0)
})

test('keeps an append-only ledger and resolves profile facts by valid time', () => {
  const store = new SqliteStateStore(join(tmpdir(), `chatty-memory-${crypto.randomUUID()}.db`))
  store.setProfileFact('location.city', 'Shanghai', '2026-01-01T00:00:00.000Z')
  store.setProfileFact('location.city', 'Beijing', '2026-02-01T00:00:00.000Z')

  const current = store.getProfileFacts(['location.city'])
  assert.equal(current.length, 1)
  assert.equal(current[0].value, 'Beijing')
  assert.deepEqual(store.getLedgerEvents().map((event) => event.type), [
    'profile_fact_recorded', 'profile_fact_superseded', 'profile_fact_recorded',
  ])
})

test('forgets a memory by closing validity while retaining the audit ledger', () => {
  const store = new SqliteStateStore(join(tmpdir(), `chatty-forget-${crypto.randomUUID()}.db`))
  const now = new Date().toISOString()
  store.upsertMemory({
    id: 'memory-1', subject: 'Jay Chou', preference: 'avoid Jay Chou', scope: 'contextual', context: 'study', status: 'confirmed',
    confidence: 1, evidence: ['User confirmed'], expiresAt: null, validFrom: now, validTo: null, recordedAt: now, createdAt: now, updatedAt: now,
  })
  assert.equal(store.getMemoriesFor('study').length, 1)
  store.deleteMemory('memory-1')
  assert.equal(store.getMemoriesFor('study').length, 0)
  assert.ok(store.getLedgerEvents().some((event) => event.type === 'memory_forgotten'))
})

test('creates a compressed conversation view while keeping raw messages in the ledger', () => {
  const store = new SqliteStateStore(join(tmpdir(), `chatty-summary-${crypto.randomUUID()}.db`))
  for (let index = 0; index < 15; index += 1) {
    store.addMessage({ role: index % 2 ? 'agent' : 'user', content: `Message ${index}`, timestamp: `2026-01-01T00:${String(index).padStart(2, '0')}:00.000Z` })
  }
  assert.equal(store.getMessages(12).length, 12)
  assert.equal(store.getConversationSummary()?.sourceMessageCount, 3)
  assert.equal(store.getLedgerEvents(20).filter((event) => event.type === 'message_recorded').length, 15)
})

test('loads only activity-relevant procedural skills into the memory view', () => {
  const store = new SqliteStateStore(join(tmpdir(), `chatty-skills-${crypto.randomUUID()}.db`))
  const view = store.getMemoryView('study')
  assert.ok(view.skills.some((skill) => skill.id === 'study-radio-v1'))
  assert.ok(view.skills.some((skill) => skill.id === 'preference-confirmation-v1'))
  assert.ok(!view.skills.some((skill) => skill.id === 'running-radio-v1'))
})

test('promotes repeated successful programme trajectories into a privacy-safe learned skill', () => {
  const store = new SqliteStateStore(join(tmpdir(), `chatty-learned-skill-${crypto.randomUUID()}.db`))
  const intent = classifyIntent('我现在在学习，放一点适合的歌')
  store.recordPlanOutcome(createRadioPlan(intent, 'private wording one'), 'completed')
  store.recordPlanOutcome(createRadioPlan(intent, 'private wording two'), 'completed')
  const skill = store.recordPlanOutcome(createRadioPlan(intent, 'private wording three'), 'completed')
  assert.equal(skill?.source, 'learned')
  assert.equal(skill?.evidence.length, 3)
  assert.ok(!JSON.stringify(skill).includes('private wording'))
  assert.ok(store.getMemoryView('study').skills.some((item) => item.id === 'learned-study-v1'))
})

test('keeps the old song under speech and starts the new set only when that speech completes', () => {
  const track = (id: string) => ({ id, title: id, artist: 'Artist', audioUrl: `https://audio.test/${id}.mp3`, durationSec: 180, moodTags: [] })
  const oldTrack = track('old-background')
  const newTrack = track('new-set')
  const state = {
    currentTrack: oldTrack,
    queue: [newTrack],
    isPlaying: true,
    lastSay: { id: 'speech-1', text: 'Here is the next part of the set.', createdAt: new Date().toISOString(), afterSpeech: 'play_queue_head' as const },
    mode: 'speaking' as const,
    reason: '',
    target: 'web' as const,
  }

  assert.equal(state.currentTrack.id, 'old-background')
  const completed = completeSpeechTransition(state, 'speech-1')
  assert.equal(completed.currentTrack?.id, 'new-set')
  assert.equal(completed.isPlaying, true)
  assert.equal(completed.lastSay?.afterSpeech, 'continue')
})
