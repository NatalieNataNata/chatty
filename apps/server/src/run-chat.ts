import type { ChatMessage, PlayerState, RadioPlan, Track } from '@chatty/shared'
import { agentDecisionSchema } from '@chatty/shared'
import { buildContext } from './context/build-context.js'
import { captureExplicitPreference, resolvePendingMemory } from './memory/memory-engine.js'
import { buildMusicDiscoveryQuery, diversifyTracks, excludeKnownTracks, feedbackFromSkips, isSurpriseMusicRequest } from './music/select-tracks.js'
import type { MusicQueryConstraint } from './music/select-tracks.js'
import { createRadioPlan, createRadioPlanFromDraft, planDraftToProgrammeDraft } from './planning/create-radio-plan.js'
import { createPlanDraft } from './agent/planner.js'
import { extractMusicConstraint } from './music/constraint-extractor.js'
import { classifyIntentSemantic } from './agent/intent-classifier.js'
import { getResponsePolicy, buildPolicyInstruction } from './agent/response-policy.js'
import { classifyIntent } from './router/classify-intent.js'
import { ChattyToolRegistry } from './tools/tool-registry.js'
import type { RuntimeDeps } from './types.js'

function uniqueTrack(queue: Track[], next: Track) {
  return queue.some((track) => track.id === next.id) ? queue : [...queue, next]
}

async function synthesizeCustomVoice(line: string, deps: RuntimeDeps) {
  try {
    return await deps.tts.synthesize(line)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Custom voice is unavailable.'
    deps.broadcaster.emitLog(`Chatty stayed silent because the custom voice failed: ${message}`)
    return null
  }
}

async function speakAndRecord(line: string, deps: RuntimeDeps, player: PlayerState, userMessage: string) {
  const event = await synthesizeCustomVoice(line, deps)
  const next = event ? { ...player, lastSay: event, mode: 'speaking' as const } : player
  deps.state.setPlayerState(next)
  if (event) deps.broadcaster.emitTts(event)
  deps.state.addMessage({ role: 'user', content: userMessage, timestamp: new Date().toISOString() })
  deps.state.addMessage({ role: 'agent', content: `SAY: ${line}`, timestamp: new Date().toISOString() })
  deps.broadcaster.emitNow()
  return { decision: agentDecisionSchema.parse({ say: [line], play: [], reason: 'Memory confirmation handled locally.' }), player: next }
}

function activeQuery(plan: RadioPlan | null) {
  const segQuery = plan?.segments[plan.currentSegmentIndex]?.query
  if (!segQuery) return null
  const planConstraint = plan?.constraints?.find((c) => c.startsWith('artist:'))
  if (planConstraint) {
    const artist = planConstraint.replace('artist:', '').replace('(strict)', '')
    return `${artist} ${segQuery}`
  }
  return segQuery
}

function queueSizeFor(intent: ReturnType<typeof classifyIntent>, plan: RadioPlan | null) {
  if (intent.kind === 'change_track') return 8
  const minutes = plan?.durationMin ?? intent.durationMin ?? 30
  // A radio set needs enough songs to survive an uninterrupted work session.
  // We use a conservative 3.8-minute average and cap first-load latency.
  return Math.max(8, Math.min(18, Math.ceil(minutes / 3.8)))
}

function deliverNarration(
  narrationPromise: Promise<string>,
  deps: RuntimeDeps,
  summaryLines: string[],
  recordMessage = true,
  afterSpeech: 'continue' | 'play_queue_head' = 'continue',
) {
  void narrationPromise.then(async (narration) => {
    if (!narration) return
    if (recordMessage) {
      deps.state.addMessage({
        role: 'agent',
        content: [...summaryLines, `SAY: ${narration}`].filter(Boolean).join('\n'),
        timestamp: new Date().toISOString(),
      })
    }
    deps.broadcaster.emitNow()
    const synthesized = await synthesizeCustomVoice(narration, deps)
    if (!synthesized) {
      deps.broadcaster.emitNow()
      return
    }
    const event = { ...synthesized, afterSpeech }
    const latestPlayer = deps.state.getPlayerState()
    deps.state.setPlayerState({ ...latestPlayer, lastSay: event, mode: 'speaking' })
    deps.broadcaster.emitTts(event)
    deps.broadcaster.emitNow()
  }).catch((error) => {
    deps.broadcaster.emitLog(`DJ narration failed: ${error instanceof Error ? error.message : String(error)}`)
    deps.broadcaster.emitNow()
  })
}

export async function runChat(message: string, deps: RuntimeDeps) {
  deps.broadcaster.emitState('thinking', 'Understanding the moment and checking memory.')
  const fallbackIntent = classifyIntent(message)
  const surpriseRequest = isSurpriseMusicRequest(message)
  const player = deps.state.getPlayerState()

  const resolvedMemory = resolvePendingMemory(deps.state, message, fallbackIntent.activity)
  if (resolvedMemory) return speakAndRecord(resolvedMemory.say, deps, player, message)

  const userEntry: ChatMessage = { role: 'user', content: message, timestamp: new Date().toISOString() }
  deps.state.addMessage(userEntry)
  let context = await buildContext(message, deps)
  // 对话意图分类（纯规则，不消耗 LLM token）
  const convDecision = classifyIntentSemantic(message)
  const convPolicy = getResponsePolicy(convDecision.intent)
  const canPlay = convDecision.playbackPermission
  context = { ...context, conversationPolicy: buildPolicyInstruction(convPolicy) + `\nPlayback permission: canChangeSong=${canPlay.canChangeSong}, canModifyQueue=${canPlay.canModifyQueue}, canTriggerPlanner=${canPlay.canTriggerPlanner}.` }
  const tools = new ChattyToolRegistry(deps)

  deps.broadcaster.emitState('thinking', 'Chatty is directing the next part of the programme.')
  let decision: import('@chatty/shared').AgentDecision
  try {
    decision = agentDecisionSchema.parse(await deps.agent.decide(context))
  } catch (error) {
    deps.broadcaster.emitLog(`LLM decide failed, using rule fallback: ${error instanceof Error ? error.message : String(error)}`)
    const fallbackSay = message.includes('歌') || message.includes('music') || message.includes('play')
      ? [`Chatty couldn't reach its music brain right now. You can try again in a moment.`]
      : [`I'm having trouble connecting right now. Give me a moment and try again.`]
    decision = agentDecisionSchema.parse({ say: fallbackSay, play: [], reason: 'LLM fallback', tool_requests: [], intent: { kind: 'conversation', activity: 'general', confidence: 0 } })
  }
  // 规范化：处理 LLM 返回 null 时 Zod 类型系统无法推断 default 的情况
  const safeDecision = {
    ...decision,
    say: (decision.say ?? []) as string[],
    reason: (decision.reason ?? '') as string,
    memory_write: (decision.memory_write ?? []) as Array<unknown>,
    programme: canPlay.canTriggerPlanner ? decision.programme : null,
    play: canPlay.canChangeSong ? (decision.play ?? []) : [],
    tool_requests: canPlay.canModifyQueue ? (decision.tool_requests ?? []) : (decision.tool_requests ?? []).filter((t: { name: string }) => !['music_search', 'resolve_audio', 'rebuild_queue'].includes(t.name)),
  }

  // 安全网：过滤 LLM 输出的已知不良回复模式
  if (safeDecision.say) {
    safeDecision.say = safeDecision.say.map((line: string) => {
      if (/Give me a moment/i.test(line) && /find the right way/i.test(line)) {
        const artist = line.match(/(?:Taylor Swift|Justin Bieber|周杰伦|\w+)/)?.[0] ?? ''
        return artist ? `Sure, pulling up some ${artist} for you.` : `Here's something for this moment.`
      }
      if (/This is Chatty/i.test(line) && /fill the silence/i.test(line)) return 'Here with the next track. What are you in the mood for?'
      return line
    }).filter(Boolean)
  }

  // Action Gate Trace：记录被拦截的操作
  const blockedPlay = !canPlay.canChangeSong && (decision.play ?? []).length > 0
  const blockedPlanner = !canPlay.canTriggerPlanner && decision.programme
  const blockedTools = !canPlay.canModifyQueue && (decision.tool_requests ?? []).some((t: { name: string }) => ['music_search', 'resolve_audio', 'rebuild_queue'].includes(t.name))
  if (blockedPlay || blockedPlanner || blockedTools) {
    const reasons: string[] = []
    if (blockedPlay) reasons.push(`play (${(decision.play ?? []).length} actions)`)
    if (blockedPlanner) reasons.push('programme')
    if (blockedTools) reasons.push('music tool requests')
    deps.broadcaster.emitLog(`Action Gate [${convDecision.intent}]: blocked ${reasons.join(', ')}`)
    deps.state.appendLedger({
      type: 'tool_executed', entityType: 'action_gate', entityId: crypto.randomUUID(),
      payload: {
        intent: convDecision.intent,
        playbackPermission: canPlay,
        blocked: reasons,
        requestedPlay: decision.play?.length ?? 0,
        requestedTools: decision.tool_requests?.length ?? 0,
      },
      occurredAt: new Date().toISOString(), actor: 'system',
    })
  }

  // Explicit playback commands must win over an LLM that only promises an action in prose.
  const intent = fallbackIntent.kind === 'change_track' ? fallbackIntent : (decision.intent ?? fallbackIntent)
  captureExplicitPreference(deps.state, message, intent.activity)

  let plan = deps.state.getCurrentPlan()
  const planMusicConstraint = extractMusicConstraint(message)
  // 无论 intent kind，只要有 artist 约束就注入 plan
  if (planMusicConstraint.artist && plan) {
    const constraintStr = `artist:${planMusicConstraint.artist}${planMusicConstraint.strict ? '(strict)' : ''}`
    if (!plan.constraints.includes(constraintStr)) {
      plan = { ...plan, constraints: [...plan.constraints, constraintStr] }
      deps.state.setCurrentPlan(plan)
    }
  }
  if (intent.kind === 'start_radio') {
    if (safeDecision.programme) {
      const draft = createPlanDraft(safeDecision.programme, intent.activity)
      plan = createRadioPlanFromDraft(intent, planDraftToProgrammeDraft(draft), message)
    } else {
      plan = createRadioPlan(intent, message)
    }
    deps.state.setCurrentPlan(plan)
    // start_radio 分支中 plan 是新创建的，需要重新注入
    if (planMusicConstraint.artist) {
      const cs = `artist:${planMusicConstraint.artist}${planMusicConstraint.strict ? '(strict)' : ''}`
      if (!plan.constraints.includes(cs)) {
        plan = { ...plan, constraints: [...plan.constraints, cs] }
        deps.state.setCurrentPlan(plan)
      }
    }
    for (const skill of deps.state.getSkillsFor(intent.activity)) deps.state.recordSkillUse(skill.id, plan.id)
    deps.broadcaster.emitPlan(plan)
    context = await buildContext(message, deps, intent.activity)
  }

  const requestedTools = safeDecision.tool_requests.slice(0, 6)
  for (const request of requestedTools) deps.broadcaster.emitTool(await tools.execute(request, context))

  let nextPlayer: PlayerState = { ...player, mode: 'thinking', reason: safeDecision.reason }
  for (const memory of safeDecision.memory_write) {
    // Model proposals are evidence, never a direct route into a user preference.
    deps.state.appendLedger({
      type: 'agent_memory_write_rejected', entityType: 'memory_proposal', entityId: crypto.randomUUID(), payload: memory,
      occurredAt: new Date().toISOString(), actor: 'agent',
    })
  }

  const playActions = safeDecision.play.length
    ? safeDecision.play
    : intent.kind === 'start_radio' || intent.kind === 'change_track'
      ? [{ query: activeQuery(plan) ?? message, reason: 'Execute the active radio plan.', target: 'web' as const, preferredCandidates: [] }]
      : []
  const selectedTracks: Track[] = []
  const avoided = deps.state.getMemoriesFor(plan?.activity ?? intent.activity).filter((memory) => memory.preference.startsWith('avoid '))

  for (const action of playActions.slice(0, 1)) {
    // 提取约束：优先从消息文本提取，其次从 LLM preferredCandidates 推断
    const messageConstraint = extractMusicConstraint(message)
    let actionConstraint: MusicQueryConstraint | undefined = undefined
    if (messageConstraint.artist) {
      actionConstraint = messageConstraint
    } else {
      const artists = action.preferredCandidates?.map((c) => c.artist.trim().toLowerCase()).filter(Boolean) ?? []
      const unique = [...new Set(artists)]
      if (unique.length === 1 && unique[0]) {
        actionConstraint = { artist: unique[0], strict: true }
      }
    }
    if (actionConstraint) {
      deps.broadcaster.emitLog(`Music constraint: strict artist="${actionConstraint.artist}"`)
    }

    const discoveryRequest = surpriseRequest
      ? `unexpected personal-library discovery different from the current set ${player.currentTrack?.artist ?? ''} ${Date.now()}`
      : context.userMessage
    const query = buildMusicDiscoveryQuery(discoveryRequest, intent, plan, context.lastTracks, surpriseRequest ? discoveryRequest : (action.query ?? activeQuery(plan) ?? undefined))
    const result = await tools.execute({
      id: crypto.randomUUID(),
      name: 'music_search',
      arguments: { query, preferredCandidates: action.preferredCandidates, strictArtist: actionConstraint?.artist } as Record<string, unknown>,
    }, context)
    deps.broadcaster.emitTool(result)
    const candidates = result.ok && Array.isArray(result.output) ? (result.output as Track[]) : []
    // Music Retrieval Recovery: strict artist request got 0 candidates
    if (actionConstraint && !candidates.length) {
      const artist = actionConstraint.artist
      deps.broadcaster.emitLog(`Music not found: strict artist "${artist}" returned 0 results`)
      const notFoundMsg = `I couldn't find any songs by ${artist} in your library. Want to try something else?`
      // Override the LLM's say with a not-found message, skip playback
      if (safeDecision.say) safeDecision.say.unshift(notFoundMsg)
      continue
    }

    const unseenCandidates = surpriseRequest
      ? excludeKnownTracks(candidates, [...player.queue, ...context.lastTracks, ...(player.currentTrack ? [player.currentTrack] : [])])
      : candidates
    const surprisePool = unseenCandidates.length >= 3 ? unseenCandidates : candidates
    const filtered = surprisePool.filter((track) => !avoided.some((memory) => track.artist.toLowerCase().includes(memory.subject.toLowerCase())))
    const recentTracks = player.currentTrack ? [player.currentTrack, ...context.lastTracks] : context.lastTracks
    const sessionFeedback = actionConstraint
      ? undefined
      : feedbackFromSkips(deps.state.getBehaviorEvents(40).filter((event) => !plan?.id || event.planId === plan.id))
    const tracks = diversifyTracks(
      filtered.length ? filtered : candidates,
      recentTracks,
      queueSizeFor(intent, plan),
      actionConstraint,
      sessionFeedback,
    )
    const requestsChange = intent.kind === 'change_track'
    const track = requestsChange ? tracks.find((candidate) => candidate.id !== player.currentTrack?.id) ?? tracks[0] : tracks[0]
    if (!track) continue

    selectedTracks.push(...tracks)
    deps.state.appendPlayedTrack(track)
    const keepCurrentTrackUnderSpeech = Boolean(player.currentTrack)
    nextPlayer = {
      ...nextPlayer,
      currentTrack: keepCurrentTrackUnderSpeech ? player.currentTrack : track,
      queue: tracks.reduce(uniqueTrack, [] as Track[]),
      isPlaying: true,
      mode: 'playing',
      target: action.target ?? nextPlayer.target,
    }
    deps.state.addBehaviorEvent({
      type: 'play',
      track: { id: track.id, title: track.title, artist: track.artist },
      activity: plan?.activity ?? intent.activity,
      planId: plan?.id ?? null,
      segmentId: plan?.segments[plan.currentSegmentIndex]?.id ?? null,
    })
  }

  // Keep the current song under the DJ voice; the new set starts when the voice finishes.
  deps.state.setPlayerState(nextPlayer)
  if (selectedTracks.length) deps.broadcaster.emitNow()

  if (playActions.length && selectedTracks.length === 0) {
    const failureLine = '我刚才没能从网易云拿到可播放的新歌，所以没有偷偷改你的队列。再试一次，或者告诉我想换到什么方向。'
    deps.state.addMessage({ role: 'agent', content: `SAY: ${failureLine}`, timestamp: new Date().toISOString() })
    const unchanged = { ...player, mode: player.isPlaying ? 'playing' as const : 'idle' as const }
    deps.state.setPlayerState(unchanged)
    deliverNarration(Promise.resolve(failureLine), deps, [], false)
    deps.broadcaster.emitLog(`Playback action failed honestly: no playable tracks were returned for ${intent.kind}.`)
    deps.broadcaster.emitNow()
    return { intent, plan, decision, player: unchanged }
  }

  const narrationTrack = selectedTracks[0] ?? (intent.kind === 'explain_choice' ? player.currentTrack : null)
  const summaryLines = [
    plan ? `PLAN: ${plan.activity} · ${plan.durationMin} min · ${plan.segments.map((segment) => segment.label).join(' → ')}` : '',
    ...selectedTracks.map((track) => `PLAY: ${track.title} - ${track.artist}`),
  ].filter(Boolean)

  if (narrationTrack) {
    deps.broadcaster.emitState('playing', 'The music is ready. Chatty is taking the mic.')
    const immediateLink = surpriseRequest
      ? `这次真的换个方向——${narrationTrack.title}，${narrationTrack.artist}。`
      : safeDecision.say.filter(Boolean).join('\n\n').trim()
    deliverNarration(
      immediateLink
        ? Promise.resolve(immediateLink)
        : deps.agent.narrateTrack(
          { ...context, currentPlan: plan },
          narrationTrack,
          intent.kind === 'explain_choice' ? 'explain' : intent.kind === 'change_track' ? 'track_change' : 'programme_open',
        ),
      deps,
      summaryLines,
      true,
      player.currentTrack && player.currentTrack.id !== narrationTrack.id ? 'play_queue_head' : 'continue',
    )
  } else {
    const narration = safeDecision.say.slice(0, 3).join(' ')
    deps.state.addMessage({ role: 'agent', content: narration ? `SAY: ${narration}` : safeDecision.reason, timestamp: new Date().toISOString() })
    if (narration) deliverNarration(Promise.resolve(narration), deps, [], false)
  }

  nextPlayer = { ...nextPlayer, mode: nextPlayer.isPlaying ? 'playing' : 'idle' }
  deps.state.setPlayerState(nextPlayer)
  deps.broadcaster.emitLog(`Handled ${intent.kind} intent for ${intent.activity}.`)
  deps.broadcaster.emitNow()
  return { intent, plan, decision, player: nextPlayer }
}
