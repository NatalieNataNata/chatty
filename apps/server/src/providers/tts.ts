import type { TtsProvider } from '../types.js'
import { FishTtsProvider } from './fish-tts.js'

const runtimeStatus: {
  activeProvider: 'fish' | null
  lastError: string | null
  issue: {
    service: 'fish'
    code: 'not_configured' | 'insufficient_balance' | 'authentication' | 'rate_limit' | 'unavailable'
    message: string
    actionUrl: string
    actionLabel: string
  } | null
} = {
  activeProvider: null,
  lastError: null,
  issue: null,
}

function fishIssue(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error)
  const status = Number(detail.match(/failed \((\d+)\)/)?.[1] ?? 0)
  const balance = status === 402 || /credit|balance|quota|余额|insufficient/i.test(detail)
  const authentication = status === 401 || status === 403 || /api key|unauthorized/i.test(detail)
  const rateLimit = status === 429
  const code: 'insufficient_balance' | 'authentication' | 'rate_limit' | 'unavailable' = balance
    ? 'insufficient_balance'
    : authentication
      ? 'authentication'
      : rateLimit
        ? 'rate_limit'
        : 'unavailable'
  const message = balance
    ? 'Fish Audio credits are insufficient. Chatty is silent because only your custom voice is permitted.'
    : authentication
      ? 'Fish Audio rejected the configured API key. Chatty will not substitute another voice.'
      : rateLimit
        ? 'Fish Audio is rate-limiting voice generation. Chatty will stay silent and keep your selected voice unchanged.'
        : 'Fish Audio could not generate your custom voice. Chatty will not substitute another voice.'
  return { service: 'fish' as const, code, message, actionUrl: 'https://fish.audio/app/', actionLabel: balance ? 'RECHARGE FISH AUDIO' : 'OPEN FISH AUDIO' }
}

class CustomVoiceOnlyTtsProvider implements TtsProvider {
  private readonly fish = new FishTtsProvider()

  async synthesize(text: string) {
    if (!process.env.FISH_AUDIO_API_KEY) {
      runtimeStatus.lastError = 'Fish Audio API key is not configured.'
      runtimeStatus.issue = { service: 'fish', code: 'not_configured', message: 'Fish Audio is not configured. Chatty will stay silent rather than use another voice.', actionUrl: 'https://fish.audio/app/api-keys/', actionLabel: 'CREATE FISH API KEY' }
      throw new Error(runtimeStatus.lastError)
    }
    if (!process.env.FISH_AUDIO_VOICE_ID) {
      runtimeStatus.lastError = 'The custom Fish Audio voice ID is not configured.'
      runtimeStatus.issue = { service: 'fish', code: 'not_configured', message: 'Your custom Fish voice is not configured. Chatty will stay silent rather than use another voice.', actionUrl: 'https://fish.audio/app/', actionLabel: 'OPEN FISH AUDIO' }
      throw new Error(runtimeStatus.lastError)
    }

    try {
      const result = await this.fish.synthesize(text)
      runtimeStatus.activeProvider = 'fish'
      runtimeStatus.lastError = null
      runtimeStatus.issue = null
      return result
    } catch (error) {
      runtimeStatus.activeProvider = null
      runtimeStatus.lastError = error instanceof Error ? error.message : String(error)
      runtimeStatus.issue = fishIssue(error)
      console.error(`Custom Fish voice unavailable: ${runtimeStatus.lastError}`)
      throw error
    }
  }
}

export function createTtsProvider(): TtsProvider {
  return new CustomVoiceOnlyTtsProvider()
}

export function getTtsRuntimeStatus() {
  return {
    configured: Boolean(process.env.FISH_AUDIO_API_KEY),
    customVoiceConfigured: Boolean(process.env.FISH_AUDIO_VOICE_ID),
    model: process.env.FISH_AUDIO_MODEL ?? 's2.1-pro-free',
    policy: 'custom_voice_only' as const,
    ...runtimeStatus,
  }
}
