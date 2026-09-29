import type { ConversationIntent, PlaybackPermission } from './conversation-intent.js'

/**
 * ResponsePolicy：回复策略。
 * 控制 LLM 生成 say[] 时的语气、长度、以及需要避免的主题。
 */
export interface ResponsePolicy {
  intent: ConversationIntent
  tone: 'dj' | 'playful' | 'warm' | 'neutral'
  verbosity: 'short' | 'medium'
  avoid: string[]
  playbackPermission: PlaybackPermission
}

const NO_PLAYBACK: PlaybackPermission = { canChangeSong: false, canModifyQueue: false, canTriggerPlanner: false }
const FULL_PLAYBACK: PlaybackPermission = { canChangeSong: true, canModifyQueue: true, canTriggerPlanner: true }

const policies: Record<ConversationIntent, ResponsePolicy> = {
  music_request: {
    intent: 'music_request', tone: 'dj', verbosity: 'short',
    avoid: ['emotional_support', 'existential_response', 'generic_filler'],
    playbackPermission: FULL_PLAYBACK,
  },
  change_music_request: {
    intent: 'change_music_request', tone: 'dj', verbosity: 'short',
    avoid: ['emotional_support', 'generic_filler'],
    playbackPermission: FULL_PLAYBACK,
  },
  positive_feedback: {
    intent: 'positive_feedback', tone: 'playful', verbosity: 'short',
    avoid: ['emotional_support', 'therapy_language', 'existential_response', 'loneliness_implication'],
    playbackPermission: NO_PLAYBACK,
  },
  negative_feedback: {
    intent: 'negative_feedback', tone: 'warm', verbosity: 'short',
    avoid: ['defensive', 'dismissive', 'generic_filler'],
    playbackPermission: NO_PLAYBACK,
  },
  ask_current_song_opinion: {
    intent: 'ask_current_song_opinion', tone: 'dj', verbosity: 'medium',
    avoid: ['emotional_support', 'generic_filler', 'redirect_to_new_music'],
    playbackPermission: NO_PLAYBACK,
  },
  ask_song_info: {
    intent: 'ask_song_info', tone: 'neutral', verbosity: 'short',
    avoid: ['emotional_support', 'redirect_to_new_music'],
    playbackPermission: NO_PLAYBACK,
  },
  ask_current_song_reason: {
    intent: 'ask_current_song_reason', tone: 'dj', verbosity: 'medium',
    avoid: ['emotional_support', 'therapy_language', 'companionship', 'generic_filler', 'loneliness_implication'],
    playbackPermission: NO_PLAYBACK,
  },
  casual_chat: {
    intent: 'casual_chat', tone: 'neutral', verbosity: 'short',
    avoid: ['emotional_support', 'therapy_language', 'loneliness_implication', 'companionship'],
    playbackPermission: NO_PLAYBACK,
  },
  sleep_context: {
    intent: 'sleep_context', tone: 'neutral', verbosity: 'short',
    avoid: ['therapy_language', 'emotional_dependency', 'companionship', 'loneliness_implication', 'existential_response'],
    playbackPermission: NO_PLAYBACK,
  },
  user_preference_update: {
    intent: 'user_preference_update', tone: 'warm', verbosity: 'short',
    avoid: ['generic_filler'],
    playbackPermission: NO_PLAYBACK,
  },
  silence_request: {
    intent: 'silence_request', tone: 'neutral', verbosity: 'short',
    avoid: ['emotional_support', 'therapy_language', 'prolonged_response'],
    playbackPermission: NO_PLAYBACK,
  },
}

export function getResponsePolicy(intent: ConversationIntent): ResponsePolicy {
  return policies[intent] ?? policies.casual_chat
}

/**
 * 根据 ResponsePolicy 生成对 LLM 的约束指令文本。
 */
export function buildPolicyInstruction(policy: ResponsePolicy): string {
  const lines: string[] = [
    `[Conversation Policy]`,
    `Intent: ${policy.intent}`,
    `Tone: ${policy.tone}. ${
      policy.tone === 'playful' ? 'Light-hearted, confident, matching the listener\'s energy.' :
      policy.tone === 'dj' ? 'Speak as a DJ making a programme decision. Natural, editorial, never theatrical.' :
      policy.tone === 'warm' ? 'Friendly but restrained. Acknowledge without overreacting.' :
      'Calm and straightforward. No emotional framing.'
    }`,
    `Verbosity: ${policy.verbosity}. ${
      policy.verbosity === 'short' ? 'One to two sentences max. Get to the point.' :
      'Develop the thought naturally but stay on topic.'
    }`,
    `Avoid: ${policy.avoid.join(', ').replace(/_/g, ' ')}.`,
    `Playback permission: ${policy.playbackPermission.canChangeSong ? 'allowed' : 'denied'}. You may ${policy.playbackPermission.canTriggerPlanner ? '' : 'NOT '}trigger a new plan or modify the queue.`,
  ]

  switch (policy.intent) {
    case 'positive_feedback':
      lines.push('The listener is appreciating the music. Match their energy, confirm their taste, and keep the current track playing. Do not switch songs or suggest new music.')
      lines.push('Do not generate a play action. Keep the say only.')
      break
    case 'ask_current_song_opinion':
      lines.push('The listener is asking your opinion about the current track. Respond as a DJ commenting on the active song. Do NOT suggest a new track or queue change.')
      lines.push('Do not generate a play action. Keep the say only.')
      break
    case 'ask_current_song_reason':
      lines.push('The listener wants to know why you chose this song. Explain your selection: reference the track\'s mood, energy, or how it fits the current programme arc.')
      lines.push('Be specific about musical qualities — tempo, atmosphere, instrumentation. Do not talk about the listener\'s emotional state.')
      lines.push('Do not generate a play action. Keep the say only.')
      break
    case 'ask_song_info':
      lines.push('The listener is asking about the current song. Use available metadata. Do not switch tracks.')
      lines.push('Do not generate a play action. Keep the say only.')
      break
    case 'music_request':
      lines.push('The listener wants new music. Acknowledge briefly, then focus on curating the next track or set. Do not produce a literary monologue.')
      break
    case 'change_music_request':
      lines.push('The listener wants to change the current song. Acknowledge and proceed to the next selection.')
      break
    case 'silence_request':
      lines.push('The listener wants quiet. Acknowledge minimally and stop talking.')
      break
    case 'negative_feedback':
      lines.push('The listener is not enjoying the current selection. Acknowledge without being defensive.')
      break
    case 'sleep_context':
      lines.push('The listener mentioned a sleep or state-of-being concern. Acknowledge briefly (one sentence) and offer a music suggestion if appropriate.')
      lines.push('Do NOT: act as a therapist, offer emotional comfort, say "I\'m here", say "you don\'t have to fill the silence", or imply companionship.')
      lines.push('DO: respond as a late-night radio host. A brief comment about the hour, then a musical suggestion that fits the mood.')
      lines.push('Keep it short. One sentence acknowledgement + one sentence music nudge. No more.')
      break
    case 'casual_chat':
      lines.push('Keep it brief and natural. Do not shift into emotional support mode.')
      lines.push('Default to DJ persona: even casual responses should sound like a radio host, not a therapist or friend.')
      break
  }

  return lines.join('\n')
}
