import type { PlayerState } from '@chatty/shared'

export function completeSpeechTransition(current: PlayerState, speechId: string): PlayerState {
  if (current.lastSay?.id !== speechId) return current

  const shouldStartNewSet = current.lastSay.afterSpeech === 'play_queue_head' && current.queue.length > 0
  const currentTrack = shouldStartNewSet ? current.queue[0] : current.currentTrack
  return {
    ...current,
    currentTrack,
    isPlaying: Boolean(currentTrack) && current.isPlaying,
    mode: current.isPlaying ? 'playing' : 'idle',
    lastSay: { ...current.lastSay, afterSpeech: 'continue' },
  }
}
