import { config as loadEnv } from 'dotenv'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import staticFiles from '@fastify/static'
import websocket from '@fastify/websocket'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { behaviorEventSchema, chatRequestSchema, nowResponseSchema, playbackRequestSchema, wsEventSchema } from '@chatty/shared'
import type { Activity, BehaviorEvent, MemoryRecord } from '@chatty/shared'
import { createAgentProvider, getAgentRuntimeStatus } from './agent/index.js'
import { clearOpenAiConfig, loadOpenAiConfig, saveOpenAiConfig } from './agent/local-config.js'
import { StubCalendarProvider } from './providers/stub-calendar.js'
import { NeteaseMusicProvider } from './providers/netease-music.js'
import { createTtsProvider, getTtsRuntimeStatus } from './providers/tts.js'
import { StubWeatherProvider } from './providers/stub-weather.js'
import { runChat } from './run-chat.js'
import { startScheduler } from './scheduler/start-scheduler.js'
import { SqliteStateStore } from './state/store.js'
import type { Broadcaster, RuntimeDeps } from './types.js'
import { dataDir, projectRoot } from './paths.js'
import { getLibrarySummary, importLibraryTracks, importPlaylistFile, resolvePersonalCandidates } from './library/library-store.js'
import { observeBehavior } from './memory/memory-engine.js'
import { buildContext } from './context/build-context.js'
import { completeSpeechTransition } from './playback/complete-speech.js'
import { deprioritizeQueueAfterSkip, diversifyTracks, feedbackFromSkips } from './music/select-tracks.js'

loadEnv({ path: process.env.DOTENV_CONFIG_PATH ?? resolve(projectRoot, '.env') })

const app = Fastify({ logger: false })

loadOpenAiConfig()

await app.register(cors, { origin: true })
await app.register(websocket)

if (process.env.CHATTY_SERVE_WEB === 'true') {
  await app.register(staticFiles, {
    root: resolve(projectRoot, 'apps', 'web', 'dist'),
  })
}

const state = new SqliteStateStore(process.env.SQLITE_PATH)
const sockets = new Set<WebSocket>()

const broadcaster: Broadcaster = {
  emitNow() {
    const payload = nowResponseSchema.parse({
      player: state.getPlayerState(),
      messages: state.getMessages(20),
      logs: state.getLogs(20),
    })

    const event = wsEventSchema.parse({
      type: 'now_playing',
      payload: payload.player,
    })

    const queueEvent = wsEventSchema.parse({
      type: 'queue_updated',
      payload: { queue: payload.player.queue },
    })

    for (const socket of sockets) {
      socket.send(JSON.stringify(event))
      socket.send(JSON.stringify(queueEvent))
    }
  },
  emitLog(message) {
    state.addLog(message)
    const event = wsEventSchema.parse({
      type: 'log',
      payload: { message, at: new Date().toISOString() },
    })

    for (const socket of sockets) {
      socket.send(JSON.stringify(event))
    }
  },
  emitState(mode, message) {
    const current = state.getPlayerState()
    state.setPlayerState({ ...current, mode: mode as typeof current.mode })
    const event = wsEventSchema.parse({
      type: 'agent_state',
      payload: { mode, message },
    })

    for (const socket of sockets) {
      socket.send(JSON.stringify(event))
    }
  },
  emitTts(payload) {
    const event = wsEventSchema.parse({
      type: 'tts_ready',
      payload,
    })

    for (const socket of sockets) {
      socket.send(JSON.stringify(event))
    }
  },
  emitPlan(payload) {
    const event = wsEventSchema.parse({ type: 'plan_updated', payload })
    for (const socket of sockets) socket.send(JSON.stringify(event))
  },
  emitTool(payload) {
    const event = wsEventSchema.parse({ type: 'tool_state', payload })
    for (const socket of sockets) socket.send(JSON.stringify(event))
  },
  emitMemoryQuestion(payload) {
    const event = wsEventSchema.parse({ type: 'memory_question', payload })
    for (const socket of sockets) socket.send(JSON.stringify(event))
  },
  emitDjScheduled(payload) {
    const event = wsEventSchema.parse({ type: 'dj_scheduled', payload })
    for (const socket of sockets) socket.send(JSON.stringify(event))
  },
}

const neteaseMusic = new NeteaseMusicProvider()
let neteaseLibrarySync: Promise<void> | null = null

function bootstrapNeteaseLibrary() {
  if (neteaseLibrarySync) return neteaseLibrarySync
  neteaseLibrarySync = (async () => {
    const [status, library] = await Promise.all([neteaseMusic.getConnectionStatus(), getLibrarySummary()])
    if (!status.connected || library.total > 0) return
    const playlists = await neteaseMusic.getUserPlaylists()
    for (const playlist of playlists) {
      const tracks = await neteaseMusic.getPlaylistTracks(playlist.id, playlist.name)
      await importLibraryTracks(`netease-${playlist.id}.json`, tracks)
    }
    broadcaster.emitLog(`Imported ${playlists.length} Netease playlists into Chatty's personal library.`)
  })().catch((error) => {
    broadcaster.emitLog(`Netease personal library sync failed: ${error instanceof Error ? error.message : String(error)}`)
  }).finally(() => {
    neteaseLibrarySync = null
  })
  return neteaseLibrarySync
}

const weather = new StubWeatherProvider()

const deps: RuntimeDeps = {
  state,
  music: neteaseMusic,
  tts: createTtsProvider(),
  weather,
  calendar: new StubCalendarProvider(),
  agent: createAgentProvider(),
  broadcaster,
}

const scheduler = startScheduler(deps)
let openingDelivered = false

async function restorePersistedRadio() {
  const saved = state.getPlayerState()
  const recent = state.getRecentTracks(12)
  const queue = saved.queue.length ? saved.queue : recent
  const currentTrack = saved.currentTrack ?? queue[0] ?? null
  if (!currentTrack) return

  state.setPlayerState({
    ...saved,
    currentTrack,
    queue: queue.length ? queue : [currentTrack],
    isPlaying: true,
    mode: 'playing',
  })

  try {
    const plan = state.getCurrentPlan()
    const query = plan?.segments[plan.currentSegmentIndex]?.query ?? `${currentTrack.title} ${currentTrack.artist}`
    const context = await buildContext(query, deps)
    const wanted = [currentTrack, ...queue.filter((track) => track.id !== currentTrack.id)].slice(0, 18)
    const strictArtist = plan?.constraints.find((constraint) => constraint.startsWith('artist:'))
      ?.replace('artist:', '').replace('(strict)', '')
    const personalCandidates = await resolvePersonalCandidates(
      wanted.map((track) => ({ title: track.title, artist: track.artist })),
      query,
      18,
      strictArtist,
    )
    const refreshed = await neteaseMusic.search(
      query,
      context,
      { preferredCandidates: personalCandidates, strictArtist },
    )
    const exact = refreshed.find((track) => track.title === currentTrack.title && track.artist === currentTrack.artist) ?? refreshed[0]
    if (!exact) return
    const recentIds = new Set(state.getRecentTracks(30).map((track) => track.id))
    const remaining = refreshed.filter((track) => track.id !== exact.id)
    const restoredQueue = [
      exact,
      ...remaining.filter((track) => !recentIds.has(track.id)),
      ...remaining.filter((track) => recentIds.has(track.id)),
    ]
    const latest = state.getPlayerState()
    state.setPlayerState({ ...latest, currentTrack: exact, queue: restoredQueue, isPlaying: true, mode: 'playing' })
    broadcaster.emitNow()
  } catch (error) {
    broadcaster.emitLog(`Previous radio queue resumed with its saved stream: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function buildQueueRefill(currentQueue: ReturnType<typeof state.getPlayerState>['queue']) {
  const plan = state.getCurrentPlan()
  const query = plan?.segments[plan.currentSegmentIndex]?.query ?? 'music for this moment'
  const strictArtist = plan?.constraints.find((constraint) => constraint.startsWith('artist:'))
    ?.replace('artist:', '').replace('(strict)', '')
  const recent = [...currentQueue, ...state.getRecentTracks(30)]
  const personalCandidates = await resolvePersonalCandidates([], query, 18, strictArtist, recent)
  if (!personalCandidates.length) return []
  const context = await buildContext(query, deps, plan?.activity)
  const candidates = await neteaseMusic.search(query, context, { preferredCandidates: personalCandidates, strictArtist })
  const feedback = strictArtist
    ? undefined
    : feedbackFromSkips(state.getBehaviorEvents(40).filter((event) => !plan?.id || event.planId === plan.id))
  return diversifyTracks(candidates, recent, 18, strictArtist ? { artist: strictArtist, strict: true } : undefined, feedback)
}

void restorePersistedRadio()

app.get('/health', async () => ({ ok: true }))

app.get('/api/agent/status', async () => ({
  connected: Boolean(process.env.OPENAI_API_KEY),
  provider: process.env.OPENAI_API_KEY ? (process.env.CHATTY_BRAIN_PROVIDER ?? 'openai') : 'offline',
  model: process.env.OPENAI_MODEL ?? 'gpt-5-mini',
  ...getAgentRuntimeStatus(),
}))

app.get('/api/tts/status', async () => getTtsRuntimeStatus())

app.post('/api/session/opening', async () => {
  if (openingDelivered || state.getPendingMemoryCandidate()) {
    return { asked: false, kind: null, speech: null }
  }

  openingDelivered = true
  const player = state.getPlayerState()
  const kind = player.currentTrack ? 'resume' : 'fresh'

  try {
    const context = await buildContext('Open this radio session with a fresh listener check-in.', deps, state.getCurrentPlan()?.activity)
    const line = await deps.agent.composeOpening(context, player.currentTrack)
    state.addMessage({ role: 'agent', content: `SAY: ${line}`, timestamp: new Date().toISOString() })
    broadcaster.emitNow()
    const speech = { ...(await deps.tts.synthesize(line)), afterSpeech: 'continue' as const }
    const latest = state.getPlayerState()
    state.setPlayerState({ ...latest, lastSay: speech, mode: 'speaking' })
    broadcaster.emitTts(speech)
    broadcaster.emitNow()
    return { asked: true, kind, speech }
  } catch (error) {
    broadcaster.emitLog(`Chatty could not compose the live opening: ${error instanceof Error ? error.message : String(error)}`)
    return { asked: false, kind: null, speech: null }
  }
})

app.get('/api/context/live', async () => weather.getSnapshot())

app.post('/api/context/location', async (request, reply) => {
  const { latitude, longitude } = request.body as { latitude?: number; longitude?: number }
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return reply.code(400).send({ message: 'Valid coordinates are required.' })
  return weather.updateLocation(latitude as number, longitude as number)
})

app.post('/api/agent/connect', async (request, reply) => {
  const { apiKey, provider = 'deepseek' } = request.body as { apiKey?: string; provider?: 'deepseek' | 'openai' }
  const key = apiKey?.trim()
  if (!key || !key.startsWith('sk-')) return reply.code(400).send({ message: 'Enter a valid API key.' })
  const selectedModel = provider === 'deepseek' ? 'deepseek-v4-flash' : 'gpt-5-mini'
  const baseURL = provider === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com/v1'
  saveOpenAiConfig(key, selectedModel, baseURL, provider)
  deps.agent = createAgentProvider()
  return { connected: true, provider, model: selectedModel, lastError: null }
})

app.delete('/api/agent/connect', async () => {
  clearOpenAiConfig()
  deps.agent = createAgentProvider()
  return { connected: false, provider: 'offline', model: process.env.OPENAI_MODEL ?? 'gpt-5-mini' }
})

app.get('/tts/:filename', async (request, reply) => {
  const { filename } = request.params as { filename: string }
  if (!/^[a-f0-9]{64}\.mp3$/.test(filename)) return reply.code(404).send()

  try {
    const audio = await readFile(resolve(dataDir, 'tts', filename))
    return reply.type('audio/mpeg').header('Cache-Control', 'public, max-age=31536000, immutable').send(audio)
  } catch {
    return reply.code(404).send()
  }
})

app.get('/api/now', async () =>
  nowResponseSchema.parse({
    player: state.getPlayerState(),
    messages: state.getMessages(20),
    logs: state.getLogs(20),
  }),
)

app.get('/api/plan/current', async () => ({ plan: state.getCurrentPlan() }))

app.get('/api/traces', async () => ({ traces: scheduler.traceStore.getRecent(20) }))

app.get('/api/memories', async () => ({
  memories: state.getAllMemoryRecords(),
  pending: state.getPendingMemoryCandidate(),
}))

app.get('/api/memory/ledger', async (request) => {
  const { limit } = request.query as { limit?: string }
  return { events: state.getLedgerEvents(Math.min(Math.max(Number(limit) || 100, 1), 500)) }
})

app.get('/api/profile/facts', async () => ({ facts: state.getProfileFacts() }))

app.post('/api/memories/:id/confirm', async (request, reply) => {
  const { id } = request.params as { id: string }
  const { scope, context } = request.body as { scope?: MemoryRecord['scope']; context?: Activity | null }
  const candidate = state.getPendingMemoryCandidate()
  if (!candidate || candidate.id !== id) return reply.code(404).send({ message: 'Memory candidate not found.' })
  if (!scope || !['session', 'contextual', 'global'].includes(scope)) return reply.code(400).send({ message: 'Valid memory scope is required.' })
  const now = new Date()
  const record: MemoryRecord = {
    id: crypto.randomUUID(),
    subject: candidate.subject,
    preference: candidate.preference,
    scope,
    context: scope === 'contextual' ? (context ?? candidate.suggestedContext) : null,
    status: 'confirmed',
    confidence: 1,
    evidence: candidate.evidence,
    expiresAt: scope === 'session' ? new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString() : null,
    validFrom: now.toISOString(),
    validTo: null,
    recordedAt: now.toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }
  state.upsertMemory(record)
  state.resolveMemoryCandidate(candidate.id, 'confirmed')
  return { record }
})

app.patch('/api/memories/:id', async (request, reply) => {
  const { id } = request.params as { id: string }
  const input = request.body as Partial<Pick<MemoryRecord, 'preference' | 'scope' | 'context'>>
  const existing = state.getAllMemoryRecords().find((memory) => memory.id === id)
  if (!existing) return reply.code(404).send({ message: 'Memory not found.' })
  if (input.scope && !['session', 'contextual', 'global'].includes(input.scope)) {
    return reply.code(400).send({ message: 'Valid memory scope is required.' })
  }

  const scope = input.scope ?? existing.scope
  const record: MemoryRecord = {
    ...existing,
    id: crypto.randomUUID(),
    preference: input.preference?.trim() || existing.preference,
    scope,
    context: scope === 'contextual' ? (input.context ?? existing.context ?? 'general') : null,
    expiresAt: scope === 'session' ? (existing.expiresAt ?? new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()) : null,
    validFrom: new Date().toISOString(),
    validTo: null,
    recordedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  state.upsertMemory(record)
  return { record }
})

app.delete('/api/memories/:id', async (request) => {
  const { id } = request.params as { id: string }
  state.deleteMemory(id)
  return { deleted: true }
})

async function handleBehavior(input: BehaviorEvent) {
  const plan = state.getCurrentPlan()
  const event = behaviorEventSchema.parse({
    ...input,
    activity: input.activity ?? plan?.activity ?? 'general',
    planId: input.planId ?? plan?.id ?? null,
    segmentId: input.segmentId ?? plan?.segments[plan.currentSegmentIndex]?.id ?? null,
  })
  const observed = observeBehavior(state, event)
  if (observed.candidate) {
    state.addMessage({ role: 'agent', content: `SAY: ${observed.candidate.question}`, timestamp: new Date().toISOString() })
    broadcaster.emitMemoryQuestion(observed.candidate)
    try {
      const speech = await deps.tts.synthesize(observed.candidate.question)
      const player = state.getPlayerState()
      state.setPlayerState({ ...player, lastSay: speech, mode: 'speaking' })
      broadcaster.emitTts(speech)
    } catch (error) {
      broadcaster.emitLog(`Chatty stayed silent because the custom voice failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const segue = scheduler.observe(observed.event)
  if (segue) {
    state.addMessage({ role: 'agent', content: `SAY: ${segue}`, timestamp: new Date().toISOString() })
    try {
      const speech = await deps.tts.synthesize(segue)
      const player = state.getPlayerState()
      state.setPlayerState({ ...player, lastSay: speech, mode: 'speaking' })
      broadcaster.emitTts(speech)
    } catch (error) {
      broadcaster.emitLog(`Chatty stayed silent because the custom voice failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  broadcaster.emitNow()
  return observed
}

app.post('/api/events', async (request) => handleBehavior(behaviorEventSchema.parse(request.body)))

app.get('/api/music/netease/status', async () => neteaseMusic.getConnectionStatus())

app.get('/api/music/netease/playlists', async (_request, reply) => {
  try {
    return await neteaseMusic.getUserPlaylists()
  } catch {
    return reply.code(401).send({ message: 'Reconnect Netease Music to read your playlists.' })
  }
})

app.post('/api/music/netease/playlists/:id/sync', async (request, reply) => {
  const { id } = request.params as { id: string }
  const { name } = request.body as { name?: string }
  if (!name) return reply.code(400).send({ message: 'Playlist name is required.' })
  try {
    const tracks = await neteaseMusic.getPlaylistTracks(id, name)
    return await importLibraryTracks(`netease-${id}.json`, tracks)
  } catch {
    return reply.code(502).send({ message: 'Chatty could not sync this Netease playlist.' })
  }
})

app.get('/api/music/netease/playlists/:id/tracks', async (request, reply) => {
  const { id } = request.params as { id: string }
  const { name } = request.query as { name?: string }
  if (!name) return reply.code(400).send({ message: 'Playlist name is required.' })
  try {
    return await neteaseMusic.getPlaylistTracks(id, name)
  } catch {
    return reply.code(502).send({ message: 'Chatty could not read this Netease playlist.' })
  }
})

app.get('/api/library', async () => getLibrarySummary())

app.post('/api/library/import', async (request, reply) => {
  const body = request.body as { name?: string; content?: string }
  if (!body.name || typeof body.content !== 'string') return reply.code(400).send({ message: 'A file name and content are required.' })
  if (!/\.(json|csv|txt)$/i.test(body.name)) return reply.code(400).send({ message: 'Supported formats: JSON, CSV and TXT.' })
  try {
    return await importPlaylistFile(body.name, body.content)
  } catch {
    return reply.code(400).send({ message: 'Chatty could not read this playlist file.' })
  }
})

app.post('/api/music/netease/login/start', async () => neteaseMusic.startQrLogin())

app.get('/api/music/netease/login/status', async (request, reply) => {
  const { key } = request.query as { key?: string }
  if (!key) return reply.code(400).send({ message: 'Missing QR login key.' })
  const result = await neteaseMusic.checkQrLogin(key)
  if (result.status === 'connected') void bootstrapNeteaseLibrary()
  return result
})

app.post('/api/chat', async (request, reply) => {
  const body = chatRequestSchema.parse(request.body)
  const result = await runChat(body.message, deps)
  return reply.send(result)
})

app.post('/api/speech/complete', async (request) => {
  const { id } = request.body as { id?: string }
  const current = state.getPlayerState()
  if (!id) return current
  const next = completeSpeechTransition(current, id)
  state.setPlayerState(next)
  broadcaster.emitNow()
  return next
})

app.post('/api/playback', async (request, reply) => {
  const { action, trackId } = playbackRequestSchema.parse(request.body)
  const current = state.getPlayerState()
  let next = current
  let behaviorType: BehaviorEvent['type'] | null = null
  let behaviorTrack = current.currentTrack

  if (action === 'play') {
    next = { ...current, isPlaying: Boolean(current.currentTrack), mode: current.currentTrack ? 'playing' : 'idle' }
    behaviorType = 'play'
  }

  if (action === 'pause') {
    next = { ...current, isPlaying: false, mode: 'idle' }
    behaviorType = 'pause'
  }

  if (action === 'previous' && current.queue.length > 0) {
    const currentIndex = current.currentTrack
      ? current.queue.findIndex((track) => track.id === current.currentTrack?.id)
      : 0
    const previousIndex = (Math.max(currentIndex, 0) - 1 + current.queue.length) % current.queue.length
    const previousTrack = current.queue[previousIndex]
    next = { ...current, currentTrack: previousTrack, isPlaying: true, mode: 'playing' }
    behaviorType = 'manual_select'
    behaviorTrack = previousTrack
  }

  if ((action === 'next' || action === 'ended') && current.queue.length > 0) {
    const adaptiveQueue = action === 'next' && current.currentTrack
      ? deprioritizeQueueAfterSkip(current.queue, current.currentTrack)
      : current.queue
    const currentIndex = current.currentTrack
      ? adaptiveQueue.findIndex((track) => track.id === current.currentTrack?.id)
      : -1
    let nextQueue = adaptiveQueue
    let nextTrack = adaptiveQueue[(currentIndex + 1) % adaptiveQueue.length]
    if (action === 'ended' && currentIndex >= adaptiveQueue.length - 1) {
      try {
        const refill = await buildQueueRefill(adaptiveQueue)
        if (refill.length) {
          nextQueue = refill
          nextTrack = refill[0]
          broadcaster.emitLog(`Radio queue automatically refilled with ${refill.length} new tracks.`)
        }
      } catch (error) {
        broadcaster.emitLog(`Radio queue refill failed; keeping the current set: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    next = { ...current, queue: nextQueue, currentTrack: nextTrack, isPlaying: true, mode: 'playing' }
    behaviorType = action === 'ended' ? 'completed' : 'skip'
    behaviorTrack = current.currentTrack
    if (nextTrack && nextTrack.id !== current.currentTrack?.id) state.appendPlayedTrack(nextTrack)
  }

  if (action === 'select' && trackId) {
    const selected = current.queue.find((track) => track.id === trackId)
    if (selected) {
      next = { ...current, currentTrack: selected, isPlaying: true, mode: 'playing' }
      behaviorType = 'manual_select'
      behaviorTrack = selected
    }
  }

  if (action === 'remove' && trackId) {
    behaviorTrack = current.queue.find((track) => track.id === trackId) ?? current.currentTrack
    const queue = current.queue.filter((track) => track.id !== trackId)
    const removedCurrent = current.currentTrack?.id === trackId
    const currentTrack = removedCurrent ? (queue[0] ?? null) : current.currentTrack
    next = {
      ...current,
      queue,
      currentTrack,
      isPlaying: removedCurrent ? Boolean(currentTrack) : current.isPlaying,
      mode: removedCurrent && !currentTrack ? 'idle' : current.mode,
    }
    behaviorType = 'remove'
  }

  if ((action === 'move_up' || action === 'move_down') && trackId) {
    const queue = [...current.queue]
    const from = queue.findIndex((track) => track.id === trackId)
    const to = action === 'move_up' ? from - 1 : from + 1
    if (from >= 0 && to >= 0 && to < queue.length) {
      ;[queue[from], queue[to]] = [queue[to], queue[from]]
      next = { ...current, queue }
    }
  }

  state.setPlayerState(next)
  if (behaviorType) {
    await handleBehavior({
      type: behaviorType,
      track: behaviorTrack ? { id: behaviorTrack.id, title: behaviorTrack.title, artist: behaviorTrack.artist } : null,
      activity: state.getCurrentPlan()?.activity ?? 'general',
      planId: state.getCurrentPlan()?.id ?? null,
      segmentId: state.getCurrentPlan()?.segments[state.getCurrentPlan()!.currentSegmentIndex]?.id ?? null,
    })
  } else broadcaster.emitNow()
  return reply.send(next)
})

app.get('/stream', { websocket: true }, (socket) => {
  sockets.add(socket)
  broadcaster.emitNow()
  socket.on('close', () => {
    sockets.delete(socket)
  })
})

const port = Number(process.env.PORT ?? 8787)
await app.listen({ port, host: '0.0.0.0' })
void bootstrapNeteaseLibrary()

console.log(`Chatty server listening on http://localhost:${port}`)
