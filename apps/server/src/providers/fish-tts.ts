import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { SayEvent } from '@chatty/shared'
import { fetch, ProxyAgent } from 'undici'
import { dataDir } from '../paths.js'
import type { TtsProvider } from '../types.js'

const cacheDir = resolve(dataDir, 'tts')
const proxyAgents = new Map<string, ProxyAgent>()

function isConnectionFailure(error: unknown) {
  const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : null
  const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : ''
  const detail = error instanceof Error ? error.message : String(error)
  return /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(code)
    || /fetch failed|network error|dns/i.test(detail)
}

function proxyCandidates() {
  const configured = [
    process.env.FISH_AUDIO_PROXY,
    process.env.HTTPS_PROXY,
    process.env.HTTP_PROXY,
    ...(process.env.FISH_AUDIO_PROXY_CANDIDATES?.split(',') ?? []),
  ]
  const commonLocalProxies = [
    'http://127.0.0.1:7897', // Clash Verge Rev default
    'http://127.0.0.1:7890', // Clash / ClashX default
    'http://127.0.0.1:7891',
  ]

  return [...new Set([...configured, ...commonLocalProxies].map((value) => value?.trim()).filter(Boolean) as string[])]
}

function getProxyAgent(url: string) {
  const existing = proxyAgents.get(url)
  if (existing) return existing
  const agent = new ProxyAgent(url)
  proxyAgents.set(url, agent)
  return agent
}

async function requestFish(url: string, init: Parameters<typeof fetch>[1]) {
  let lastConnectionError: unknown
  const attempts = [
    ...proxyCandidates().map((proxyUrl) => ({ label: proxyUrl, dispatcher: getProxyAgent(proxyUrl) })),
    { label: 'direct connection', dispatcher: undefined },
  ]

  for (const attempt of attempts) {
    try {
      return await fetch(url, {
        ...init,
        dispatcher: attempt.dispatcher,
        signal: AbortSignal.timeout(30_000),
      })
    } catch (error) {
      if (!isConnectionFailure(error) && !(error instanceof DOMException && error.name === 'TimeoutError')) throw error
      lastConnectionError = error
    }
  }

  const detail = lastConnectionError instanceof Error ? lastConnectionError.message : String(lastConnectionError)
  throw new Error(`Fish Audio is unreachable through the configured, local, and direct network paths: ${detail}`)
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export class FishTtsProvider implements TtsProvider {
  async synthesize(text: string): Promise<SayEvent> {
    const apiKey = process.env.FISH_AUDIO_API_KEY
    if (!apiKey) throw new Error('FISH_AUDIO_API_KEY is required for Fish Audio TTS.')

    const voiceId = process.env.FISH_AUDIO_VOICE_ID
    const model = process.env.FISH_AUDIO_MODEL ?? 's2.1-pro-free'
    const speed = Number(process.env.FISH_AUDIO_SPEED ?? 0.9)
    const cacheKey = createHash('sha256').update(`fish:${model}:${voiceId ?? 'default'}:${speed}:${text}`).digest('hex')
    const filename = `${cacheKey}.mp3`
    const filePath = resolve(cacheDir, filename)

    if (await exists(filePath)) {
      return {
        id: randomUUID(),
        text,
        createdAt: new Date().toISOString(),
        audioUrl: `/tts/${filename}`,
        provider: 'fish',
      }
    }

    const response = await requestFish('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        model,
      },
      body: JSON.stringify({
        text,
        ...(voiceId ? { reference_id: voiceId } : {}),
        format: 'mp3',
        mp3_bitrate: 128,
        latency: 'normal',
        normalize: true,
        prosody: {
          speed,
          volume: 0,
          normalize_loudness: true,
        },
      }),
    })

    if (!response.ok) {
      const detail = await response.text()
      throw new Error(`Fish Audio TTS failed (${response.status}): ${detail}`)
    }

    await mkdir(cacheDir, { recursive: true })
    await writeFile(filePath, Buffer.from(await response.arrayBuffer()))

    return {
      id: randomUUID(),
      text,
      createdAt: new Date().toISOString(),
      audioUrl: `/tts/${filename}`,
      provider: 'fish',
    }
  }
}
