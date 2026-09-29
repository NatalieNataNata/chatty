import { useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { MemoryCandidate, MemoryRecord, NowResponse, PlayerState, RadioPlan, SayEvent, WsEvent } from '@chatty/shared'

declare global {
  interface Window {
    chattyVoiceInput?: {
      start: () => Promise<{ ok: boolean; error?: string }>
      stop: () => Promise<void>
      onResult: (callback: (payload: { type: 'ready' | 'partial' | 'final' | 'error'; text?: string; message?: string }) => void) => () => void
    }
  }
}

interface LibrarySummary {
  total: number
  files: Array<{ name: string; importedAt: string; trackCount: number }>
  sources: string[]
}

interface NeteasePlaylist {
  id: string
  name: string
  trackCount: number
  coverUrl?: string
}

interface PlaylistTrackSummary {
  title: string
  artist: string
  album?: string
}

interface AgentStatus {
  connected: boolean
  provider: 'deepseek' | 'openai' | 'offline'
  model: string
  lastError?: string | null
  issue?: RuntimeIssue | null
}

interface RuntimeIssue {
  service: 'deepseek' | 'openai' | 'fish'
  code: string
  message: string
  actionUrl: string
  actionLabel: string
}

interface LiveContext {
  city: string
  weather: string
  temperature: number | null
  precise: boolean
  live: boolean
}

const musicPlatforms = [
  { id: 'netease', label: '网易云', available: true },
  { id: 'qq', label: 'QQ 音乐', available: true },
  { id: 'kugou', label: '酷狗', available: false },
  { id: 'youtube', label: 'YouTube', available: false },
  { id: 'apple', label: 'Apple Music', available: false },
  { id: 'spotify', label: 'Spotify', available: false },
] as const

type MusicPlatformId = (typeof musicPlatforms)[number]['id']

const emptyPlayer: PlayerState = {
  currentTrack: null,
  queue: [],
  isPlaying: false,
  lastSay: null,
  mode: 'idle',
  reason: '',
  target: 'web',
}

const silentAudio = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAACAgICA'
const defaultMusicVolume = 0.58
const musicDuckingRatio = 0.26
const djVoiceGain = 1.42
const desktopShell = new URLSearchParams(window.location.search).get('desktop') === '1'
const ownsAudio = desktopShell || new URLSearchParams(window.location.search).get('audio') === '1'

function formatTime(value: number) {
  const safe = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`
}

function memoryActivityLabel(activity: MemoryCandidate['suggestedContext']) {
  return ({
    study: '学习或工作',
    running: '运动',
    commute: '通勤',
    relax: '放松',
    sleep: '睡前',
    general: '这种场景',
  })[activity]
}

interface ConversationLine {
  role: 'user' | 'agent'
  text: string
  timestamp: string
}

function buildConversation(messages: NowResponse['messages']): ConversationLine[] {
  const conversation: ConversationLine[] = []

  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'user') {
      conversation.push({ role: 'user', text: message.content, timestamp: message.timestamp })
      continue
    }

    const spoken = message.content
      .split('\n')
      .filter((line) => line.startsWith('SAY:'))
      .map((line) => line.slice(4).trim())
      .filter(Boolean)
    for (const text of spoken.length ? spoken : [message.content]) {
      conversation.push({ role: 'agent', text, timestamp: message.timestamp })
    }
  }

  return conversation.slice(-20)
}

function HighlightedSpeech({ text, progress }: { text: string; progress: number }) {
  if (progress >= text.length) return text
  const words = [...text.matchAll(/\S+/g)]
  const current = words.find((word) => (word.index ?? 0) + word[0].length >= progress) ?? words.at(-1)
  if (!current) return text
  const start = current.index ?? 0
  const end = start + current[0].length
  return <>
    <span className="said-text">{text.slice(0, start)}</span>
    <span className="active-word">{text.slice(start, end)}</span>
    <span className="future-text">{text.slice(end)}</span>
  </>
}

function Waveform({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    let animationFrame = 0
    let phase = 0
    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const ratio = window.devicePixelRatio || 1
      canvas.width = rect.width * ratio
      canvas.height = rect.height * ratio
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
    }

    const draw = () => {
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      context.clearRect(0, 0, width, height)
      context.fillStyle = 'rgba(255,255,255,.88)'
      const count = Math.max(54, Math.floor(width / 6))
      const gap = width / count

      for (let index = 0; index < count; index += 1) {
        const x = index * gap
        const envelope = 0.2 + Math.sin((index / count) * Math.PI) * 0.8
        const signal =
          Math.sin(index * 0.42 + phase) * 0.48 +
          Math.sin(index * 0.13 - phase * 0.7) * 0.3 +
          Math.sin(index * 0.93 + phase * 0.2) * 0.22
        const energy = active ? 0.55 + Math.abs(signal) * 0.95 : 0.12 + Math.abs(signal) * 0.16
        const barHeight = Math.max(2, height * envelope * energy * 0.58)
        context.fillRect(x, height - barHeight, Math.max(2, gap - 2), barHeight)
      }

      phase += active ? 0.055 : 0.008
      animationFrame = requestAnimationFrame(draw)
    }

    resize()
    draw()
    window.addEventListener('resize', resize)
    return () => {
      cancelAnimationFrame(animationFrame)
      window.removeEventListener('resize', resize)
    }
  }, [active])

  return <canvas ref={canvasRef} className="wave-canvas" aria-hidden="true" />
}

function ProfileParticleSphere() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    let frame = 0
    let pointerX = -1000
    let pointerY = -1000
    let targetX = -1000
    let targetY = -1000
    let sphereStrength = 0
    let targetStrength = 0
    let movementEnergy = 0

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const ratio = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.round(rect.width * ratio))
      canvas.height = Math.max(1, Math.round(rect.height * ratio))
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
    }
    const followPointer = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom
      targetStrength = inside ? 1 : 0
      if (!inside) return
      targetX = event.clientX - rect.left
      targetY = event.clientY - rect.top
      movementEnergy = Math.min(1, movementEnergy + Math.hypot(event.movementX, event.movementY) * 0.025)
    }
    const draw = () => {
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      const grid = 14
      const radius = Math.max(135, Math.min(175, Math.min(width, height) * 0.3))
      pointerX += (targetX - pointerX) * 0.2
      pointerY += (targetY - pointerY) * 0.2
      sphereStrength += (targetStrength - sphereStrength) * 0.11
      movementEnergy *= 0.93
      context.clearRect(0, 0, width, height)

      for (let baseY = 7; baseY < height; baseY += grid) {
        for (let baseX = 7; baseX < width; baseX += grid) {
          const dx = baseX - pointerX
          const dy = baseY - pointerY
          const distance = Math.hypot(dx, dy)
          const proximity = Math.max(0, 1 - distance / radius)
          const softEdge = proximity * proximity * (3 - 2 * proximity)
          const depth = Math.pow(softEdge, 0.78) * sphereStrength
          const angle = movementEnergy * depth * 0.38
          const cos = Math.cos(angle)
          const sin = Math.sin(angle)
          const rotatedX = dx * cos - dy * sin
          const rotatedY = dx * sin + dy * cos
          const bulge = 1 + depth * 0.18
          const x = pointerX + rotatedX * bulge
          const y = pointerY + rotatedY * bulge
          const size = 0.88 + depth * 1.12

          context.beginPath()
          context.arc(x, y, size, 0, Math.PI * 2)
          context.fillStyle = `rgba(174,125,255,${0.27 + depth * 0.46})`
          context.shadowColor = 'rgba(166,108,255,.55)'
          context.shadowBlur = depth * 3.5
          context.fill()
        }
      }
      context.shadowBlur = 0
      frame = requestAnimationFrame(draw)
    }

    resize()
    window.addEventListener('resize', resize)
    window.addEventListener('pointermove', followPointer)
    frame = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', followPointer)
    }
  }, [])

  return <canvas ref={canvasRef} className="profile-particle-sphere" aria-hidden="true" />
}

function App() {
  const [player, setPlayer] = useState<PlayerState>(emptyPlayer)
  const [messages, setMessages] = useState<NowResponse['messages']>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)
  const [chatExpanded, setChatExpanded] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [spokenChars, setSpokenChars] = useState(0)
  const [activeSpeech, setActiveSpeech] = useState<SayEvent | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [duration, setDuration] = useState(0)
  const [clock, setClock] = useState('')
  const [view, setView] = useState<'studio' | 'queue' | 'profile'>('studio')
  const [neteaseStatus, setNeteaseStatus] = useState<'checking' | 'disconnected' | 'waiting' | 'scanned' | 'connected'>('checking')
  const [neteaseQr, setNeteaseQr] = useState<string | null>(null)
  const [neteaseKey, setNeteaseKey] = useState<string | null>(null)
  const [library, setLibrary] = useState<LibrarySummary>({ total: 0, files: [], sources: [] })
  const [importingLibrary, setImportingLibrary] = useState(false)
  const [neteasePlaylists, setNeteasePlaylists] = useState<NeteasePlaylist[]>([])
  const [loadingNeteasePlaylists, setLoadingNeteasePlaylists] = useState(false)
  const [syncingPlaylistId, setSyncingPlaylistId] = useState<string | null>(null)
  const [playlistSyncMessage, setPlaylistSyncMessage] = useState('')
  const [expandedPlaylistId, setExpandedPlaylistId] = useState<string | null>(null)
  const [playlistTracks, setPlaylistTracks] = useState<Record<string, PlaylistTrackSummary[]>>({})
  const [agentWarning, setAgentWarning] = useState('')
  const [runtimeIssues, setRuntimeIssues] = useState<RuntimeIssue[]>([])
  const [agentActivity, setAgentActivity] = useState('Ready')
  const [radioPlan, setRadioPlan] = useState<RadioPlan | null>(null)
  const [memories, setMemories] = useState<MemoryRecord[]>([])
  const [pendingMemory, setPendingMemory] = useState<MemoryCandidate | null>(null)
  const [openingSuggestions, setOpeningSuggestions] = useState<string[]>([])
  const [voiceListening, setVoiceListening] = useState(false)
  const [selectedTasteTag, setSelectedTasteTag] = useState<string | null>(null)
  const [liveContext, setLiveContext] = useState<LiveContext>({ city: '北京', weather: 'Loading weather…', temperature: null, precise: false, live: false })
  const [locating, setLocating] = useState(false)
  const [musicVolume, setMusicVolume] = useState(() => {
    const stored = window.localStorage.getItem('chatty.music-volume')
    if (stored === null) return defaultMusicVolume
    const saved = Number(stored)
    return Number.isFinite(saved) && saved >= 0 && saved <= 1 ? saved : defaultMusicVolume
  })
  const [selectedPlatformId, setSelectedPlatformId] = useState<MusicPlatformId>(() => {
    const saved = window.localStorage.getItem('chatty.playback-platform')
    return musicPlatforms.some((platform) => platform.id === saved) ? (saved as MusicPlatformId) : 'netease'
  })
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null)
  const djAudioContextRef = useRef<AudioContext | null>(null)
  const djGainRef = useRef<GainNode | null>(null)
  const djCompressorRef = useRef<DynamicsCompressorNode | null>(null)
  const volumeAnimationRef = useRef<number | null>(null)
  const queuedSpeechRef = useRef<SayEvent[]>([])
  const spokenSpeechIdsRef = useRef(new Set<string>())
  const speechPlayingRef = useRef(false)
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const playlistInputRef = useRef<HTMLInputElement | null>(null)
  const lastProgressReportRef = useRef(0)
  const lastAudibleVolumeRef = useRef(musicVolume > 0 ? musicVolume : defaultMusicVolume)
  const openingRequestedRef = useRef(false)

  const conversation = buildConversation(messages)
  const currentLine = activeSpeech?.text ?? player.lastSay?.text
  const status = sending ? 'Thinking…' : speaking ? 'Speaking…' : player.isPlaying ? 'On air' : 'Standing by'
  const active = speaking || player.isPlaying
  const dateLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
  const selectedPlatform = musicPlatforms.find((platform) => platform.id === selectedPlatformId) ?? musicPlatforms[0]
  const musicSetupRequired = neteaseStatus !== 'connected' || library.total === 0
  // Keep the live track inside one continuous set, even while a DJ link is holding
  // the previous track under the incoming queue.
  const programmeTracks = player.currentTrack && !player.queue.some((track) => track.id === player.currentTrack?.id)
    ? [player.currentTrack, ...player.queue]
    : player.queue

  useEffect(() => {
    const updateClock = () => {
      setClock(new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))
    }
    updateClock()
    const timer = window.setInterval(updateClock, 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    void Promise.all([
      fetch('/api/plan/current').then((response) => response.json()),
      fetch('/api/memories').then((response) => response.json()),
    ]).then(([planData, memoryData]) => {
      setRadioPlan((planData as { plan: RadioPlan | null }).plan)
      setMemories((memoryData as { memories: MemoryRecord[] }).memories)
      setPendingMemory((memoryData as { pending: MemoryCandidate | null }).pending)
    })
  }, [])

  useEffect(() => {
    void fetch('/api/now')
      .then((response) => response.json())
      .then((data: NowResponse) => {
        setPlayer(data.player)
        setMessages(data.messages)
      })
      .catch(() => setAgentWarning('Chatty could not restore the radio. You can still reconnect below.'))
  }, [])

  useEffect(() => {
    const bridge = window.chattyVoiceInput
    if (!bridge) return
    return bridge.onResult((payload) => {
      if ((payload.type === 'partial' || payload.type === 'final') && payload.text) {
        setInput(payload.text)
        setChatExpanded(true)
      }
      if (payload.type === 'final') {
        setVoiceListening(false)
        setAgentWarning('')
      }
      if (payload.type === 'error') {
        setVoiceListening(false)
        setAgentWarning(payload.message ?? 'Voice input could not hear that. Please try again.')
      }
    })
  }, [])

  useEffect(() => {
    void fetch('/api/music/netease/status')
      .then((response) => response.json())
      .then((data: { connected: boolean }) => setNeteaseStatus(data.connected ? 'connected' : 'disconnected'))
      .catch(() => setNeteaseStatus('disconnected'))
  }, [])

  useEffect(() => {
    void refreshLibrary()
  }, [])

  useEffect(() => {
    if (neteaseStatus !== 'connected' || library.total > 0) return
    void refreshLibrary()
    const timer = window.setInterval(() => void refreshLibrary(), 1500)
    return () => window.clearInterval(timer)
  }, [neteaseStatus, library.total])

  useEffect(() => {
    if (neteaseStatus !== 'connected' || library.total === 0 || openingRequestedRef.current) return
    openingRequestedRef.current = true
    void fetch('/api/session/opening', { method: 'POST' })
      .then((response) => response.json())
      .then((opening: { asked: boolean; kind: 'fresh' | 'resume' | 'setup' | null; suggestions: string[]; speech: SayEvent | null }) => {
        if (!opening.asked) return
        setOpeningSuggestions(opening.suggestions ?? [])
        if (ownsAudio && opening.speech) speak(opening.speech)
        return fetch('/api/now').then((response) => response.json()).then((data: NowResponse) => {
          setPlayer(data.player)
          setMessages(data.messages)
        })
      })
      .catch(() => setAgentWarning('Chatty could not start the opening conversation. You can still type a request below.'))
  }, [neteaseStatus, library.total])

  useEffect(() => {
    void refreshRuntimeStatus()
  }, [])

  useEffect(() => {
    void fetch('/api/context/live')
      .then((response) => response.json())
      .then((data: LiveContext) => setLiveContext(data))
  }, [])

  useEffect(() => {
    window.localStorage.setItem('chatty.playback-platform', selectedPlatformId)
  }, [selectedPlatformId])

  useEffect(() => {
    if (neteaseStatus === 'connected') void loadNeteasePlaylists()
  }, [neteaseStatus])

  useEffect(() => {
    if (!neteaseKey || (neteaseStatus !== 'waiting' && neteaseStatus !== 'scanned')) return

    const timer = window.setInterval(() => {
      void fetch(`/api/music/netease/login/status?key=${encodeURIComponent(neteaseKey)}`)
        .then((response) => response.json())
        .then((data: { status: 'waiting' | 'scanned' | 'connected' | 'expired' }) => {
          if (data.status === 'connected') {
            setNeteaseStatus('connected')
            setNeteaseQr(null)
            setNeteaseKey(null)
          } else if (data.status === 'expired') {
            setNeteaseStatus('disconnected')
            setNeteaseQr(null)
            setNeteaseKey(null)
          } else {
            setNeteaseStatus(data.status)
          }
        })
    }, 1800)

    return () => window.clearInterval(timer)
  }, [neteaseKey, neteaseStatus])

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${protocol}://${window.location.host}/stream`)

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data) as WsEvent
      if (message.type === 'now_playing') {
        setPlayer(message.payload)
        // Text must arrive even if TTS cannot be generated, otherwise the
        // conversation appears to vanish when the voice provider is down.
        void fetch('/api/now').then((response) => response.json()).then((data: NowResponse) => setMessages(data.messages))
      }
      if (message.type === 'agent_state') setAgentActivity(message.payload.message)
      if (message.type === 'plan_updated') setRadioPlan(message.payload)
      if (message.type === 'memory_question') {
        setOpeningSuggestions([])
        setPendingMemory(message.payload)
        setChatExpanded(true)
        void fetch('/api/now').then((response) => response.json()).then((data: NowResponse) => setMessages(data.messages))
      }
      if (message.type === 'tool_state') setAgentActivity(message.payload.ok ? `Used ${message.payload.name.replaceAll('_', ' ')}` : `${message.payload.name} unavailable`)
      if (message.type === 'dj_scheduled') setAgentActivity('Preparing the next DJ transition')
      // The desktop app is the default audio owner so browser previews cannot double the DJ voice.
      if (message.type === 'tts_ready') {
        void fetch('/api/now').then((response) => response.json()).then((data: NowResponse) => {
          setPlayer(data.player)
          setMessages(data.messages)
        })
        if (ownsAudio) speak(message.payload)
      }
    }

    return () => ws.close()
  }, [])

  useEffect(() => {
    const audio = audioRef.current
    const track = player.currentTrack
    if (!audio || !track) return

    if (audio.src !== track.audioUrl) {
      audio.loop = false
      audio.muted = false
      audio.volume = musicVolume
      audio.src = track.audioUrl
      setElapsed(0)
      lastProgressReportRef.current = 0
    }

    if (player.isPlaying) {
      void audio.play().catch(() => undefined)
    } else {
      audio.pause()
    }
  }, [player.currentTrack, player.isPlaying])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.volume = speaking ? musicVolume * musicDuckingRatio : musicVolume
  }, [musicVolume, speaking])

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, currentLine])

  useEffect(() => {
    const collapseChat = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && chatExpanded) setChatExpanded(false)
    }
    window.addEventListener('keydown', collapseChat)
    return () => window.removeEventListener('keydown', collapseChat)
  }, [chatExpanded])

  useEffect(() => {
    const handleSpacebar = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat) return

      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, button, [contenteditable="true"]')) return

      event.preventDefault()
      if (speaking) {
        interruptVoice()
        return
      }

      void controlPlayback(player.isPlaying ? 'pause' : 'play')
    }

    window.addEventListener('keydown', handleSpacebar)
    return () => window.removeEventListener('keydown', handleSpacebar)
  }, [player.isPlaying, speaking])

  function speak(event: SayEvent) {
    if (spokenSpeechIdsRef.current.has(event.id)) return
    spokenSpeechIdsRef.current.add(event.id)
    queuedSpeechRef.current.push(event)
    playNextSpeech()
  }

  function playNextSpeech() {
    if (speechPlayingRef.current) return
    const event = queuedSpeechRef.current.shift()
    if (!event) return
    speechPlayingRef.current = true

    let completed = false
    const complete = () => {
      if (completed) return
      completed = true
      finishSpeaking(event)
      speechPlayingRef.current = false
      playNextSpeech()
    }

    if (event.audioUrl && ttsAudioRef.current) {
      const voice = ttsAudioRef.current
      prepareDjAudio(voice)
      voice.loop = false
      voice.muted = false
      voice.volume = 1
      voice.src = event.audioUrl
      voice.onplay = () => beginSpeaking(event)
      voice.ontimeupdate = () => {
        const ratio = voice.duration ? voice.currentTime / voice.duration : 0
        setSpokenChars(Math.round(event.text.length * ratio))
      }
      voice.onended = complete
      voice.onerror = () => {
        voice.onended = null
        complete()
      }
      void voice.play().catch(() => {
        voice.onended = null
        voice.onerror = null
        complete()
      })
      return
    }

    // Voice identity is strict: never substitute a system or browser voice.
    complete()
  }

  function beginSpeaking(event: SayEvent) {
    setActiveSpeech(event)
    setSpeaking(true)
    setSpokenChars(0)
    fadeMusicTo(musicVolume * musicDuckingRatio, 360)
  }

  function finishSpeaking(event: SayEvent) {
    setSpeaking(false)
    setSpokenChars(event.text.length)
    fadeMusicTo(musicVolume, 850)
    void fetch('/api/speech/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: event.id }),
    })
      .then((response) => response.json())
      .then((next: PlayerState) => setPlayer(next))
      .finally(() => setActiveSpeech((current) => current?.id === event.id ? null : current))
  }

  function prepareDjAudio(voice: HTMLAudioElement) {
    const AudioContextClass = window.AudioContext
    if (!djAudioContextRef.current) {
      const context = new AudioContextClass()
      const source = context.createMediaElementSource(voice)
      const compressor = context.createDynamicsCompressor()
      const gain = context.createGain()
      compressor.threshold.value = -30
      compressor.knee.value = 22
      compressor.ratio.value = 6
      compressor.attack.value = 0.008
      compressor.release.value = 0.22
      gain.gain.value = djVoiceGain
      source.connect(compressor).connect(gain).connect(context.destination)
      djAudioContextRef.current = context
      djCompressorRef.current = compressor
      djGainRef.current = gain
    }

    djGainRef.current!.gain.value = djVoiceGain
    void djAudioContextRef.current.resume()
  }

  function fadeMusicTo(target: number, durationMs: number) {
    const music = audioRef.current
    if (!music) return
    if (volumeAnimationRef.current) cancelAnimationFrame(volumeAnimationRef.current)

    const startVolume = music.volume
    const startedAt = performance.now()
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / durationMs)
      const eased = 1 - Math.pow(1 - progress, 3)
      music.volume = startVolume + (target - startVolume) * eased
      if (progress < 1) volumeAnimationRef.current = requestAnimationFrame(tick)
    }
    volumeAnimationRef.current = requestAnimationFrame(tick)
  }

  function interruptVoice() {
    queuedSpeechRef.current = []
    speechPlayingRef.current = false
    const voice = ttsAudioRef.current
    if (voice) {
      voice.onended = null
      voice.onerror = null
      voice.pause()
      voice.currentTime = 0
    }
    setSpeaking(false)
    fadeMusicTo(musicVolume, 280)
  }

  function changeMusicVolume(nextValue: number) {
    const next = Math.min(1, Math.max(0, nextValue))
    setMusicVolume(next)
    window.localStorage.setItem('chatty.music-volume', String(next))
    if (next > 0) lastAudibleVolumeRef.current = next
  }

  function toggleMusicMute() {
    changeMusicVolume(musicVolume > 0 ? 0 : lastAudibleVolumeRef.current)
  }

  async function sendMessage(message: string) {
    if (!message || sending) return
    setOpeningSuggestions([])
    const previousSayId = player.lastSay?.id

    const audio = audioRef.current
    if (audio && !player.currentTrack) {
      audio.src = silentAudio
      audio.loop = true
      audio.muted = true
      void audio.play().catch(() => undefined)
    }

    const voice = ttsAudioRef.current
    if (voice) {
      voice.src = silentAudio
      voice.loop = true
      voice.muted = true
      void voice.play().catch(() => undefined)
    }

    setSending(true)
    setCommandOpen(false)
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      })
      if (!response.ok) {
        const detail = await response.json().catch(() => null) as { message?: string } | null
        await refreshRuntimeStatus()
        throw new Error(detail?.message ?? 'Chatty could not start the programme.')
      }
      const now = (await fetch('/api/now').then((result) => result.json())) as NowResponse
      setPlayer(now.player)
      setMessages(now.messages)
      if (ownsAudio && now.player.lastSay?.audioUrl && now.player.lastSay.id !== previousSayId) speak(now.player.lastSay)
      setInput('')
      const memoryData = await fetch('/api/memories').then((result) => result.json()) as { memories: MemoryRecord[]; pending: MemoryCandidate | null }
      setMemories(memoryData.memories)
      setPendingMemory(memoryData.pending)
      setAgentWarning('')
      await refreshRuntimeStatus()
    } catch (error) {
      setAgentWarning(error instanceof Error ? error.message : 'Chatty could not complete that request.')
    } finally {
      setSending(false)
    }
  }

  async function submitMessage(event: FormEvent) {
    event.preventDefault()
    await sendMessage(input.trim())
  }

  function submitInputOnEnter(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
  }

  function toggleVoiceInput() {
    const bridge = window.chattyVoiceInput
    if (!bridge) {
      setAgentWarning('Native macOS voice input is unavailable in this build. Update Chatty, then allow Microphone and Speech Recognition access.')
      return
    }
    if (voiceListening) {
      void bridge.stop()
      setVoiceListening(false)
      return
    }
    void bridge.start().then((result) => {
      if (!result.ok) {
        setAgentWarning(result.error ?? 'Voice input could not start. Allow Microphone and Speech Recognition access in macOS settings.')
        return
      }
      setVoiceListening(true)
      setChatExpanded(true)
      setAgentWarning('')
    })
  }

  async function controlPlayback(action: 'play' | 'pause' | 'previous' | 'next' | 'ended' | 'select' | 'remove' | 'move_up' | 'move_down', trackId?: string) {
    if (!player.currentTrack && action === 'play') return
    const next = (await fetch('/api/playback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, trackId }),
    }).then((response) => response.json())) as PlayerState
    setPlayer(next)
  }

  function reportProgress(audio: HTMLAudioElement) {
    setElapsed(audio.currentTime)
    const marker = Math.floor(audio.currentTime / 15) * 15
    if (!player.currentTrack || marker < 15 || marker <= lastProgressReportRef.current) return
    lastProgressReportRef.current = marker
    void fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'progress',
        track: { id: player.currentTrack.id, title: player.currentTrack.title, artist: player.currentTrack.artist },
        activity: radioPlan?.activity ?? 'general',
        planId: radioPlan?.id ?? null,
        segmentId: radioPlan?.segments[radioPlan.currentSegmentIndex]?.id ?? null,
        progressSec: marker,
      }),
    })
  }

  async function deleteMemory(id: string) {
    await fetch(`/api/memories/${id}`, { method: 'DELETE' })
    setMemories((current) => current.filter((memory) => memory.id !== id))
  }

  async function cycleMemoryScope(memory: MemoryRecord) {
    const nextScope: MemoryRecord['scope'] = memory.scope === 'session' ? 'contextual' : memory.scope === 'contextual' ? 'global' : 'session'
    const response = await fetch(`/api/memories/${memory.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: nextScope, context: nextScope === 'contextual' ? (radioPlan?.activity ?? 'general') : null }),
    })
    if (!response.ok) return
    const data = await response.json() as { record: MemoryRecord }
    setMemories((current) => current.map((item) => item.id === memory.id ? data.record : item))
  }

  async function runProgrammeCue(message: string) {
    if (sending) return
    setSending(true)
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      })
      if (!response.ok) throw new Error('Chatty could not rebuild the programme.')
      const now = (await fetch('/api/now').then((result) => result.json())) as NowResponse
      setPlayer(now.player)
      setMessages(now.messages)
      await refreshRuntimeStatus()
    } catch (error) {
      setAgentWarning(error instanceof Error ? error.message : 'Chatty could not rebuild the programme.')
    } finally {
      setSending(false)
    }
  }

  async function refreshRuntimeStatus() {
    const [brain, voice] = await Promise.all([
      fetch('/api/agent/status').then((response) => response.json()) as Promise<AgentStatus>,
      fetch('/api/tts/status').then((response) => response.json()) as Promise<{ issue?: RuntimeIssue | null }>,
    ])
    setRuntimeIssues([brain.issue, voice.issue].filter((issue): issue is RuntimeIssue => Boolean(issue)))
  }

  async function startNeteaseLogin() {
    if (neteaseStatus === 'connected') return
    setNeteaseStatus('waiting')
    const response = await fetch('/api/music/netease/login/start', { method: 'POST' })
    if (!response.ok) {
      setNeteaseStatus('disconnected')
      return
    }
    const data = (await response.json()) as { key: string; qrImage: string }
    setNeteaseKey(data.key)
    setNeteaseQr(data.qrImage)
  }

  async function loadNeteasePlaylists() {
    setLoadingNeteasePlaylists(true)
    try {
      const response = await fetch('/api/music/netease/playlists')
      if (!response.ok) throw new Error('Could not read playlists')
      setNeteasePlaylists((await response.json()) as NeteasePlaylist[])
    } finally {
      setLoadingNeteasePlaylists(false)
    }
  }

  async function syncNeteasePlaylist(playlist: NeteasePlaylist) {
    setSyncingPlaylistId(playlist.id)
    setPlaylistSyncMessage('')
    try {
      const response = await fetch(`/api/music/netease/playlists/${encodeURIComponent(playlist.id)}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: playlist.name }),
      })
      if (!response.ok) throw new Error('Sync failed')
      const result = (await response.json()) as { imported: number; total: number }
      await refreshLibrary()
      setPlaylistSyncMessage(`${playlist.name} · ${result.imported} tracks synced`)
    } catch {
      setPlaylistSyncMessage(`${playlist.name} could not be synced. Try reconnecting.`)
    } finally {
      setSyncingPlaylistId(null)
    }
  }

  async function syncAllNeteasePlaylists() {
    setSyncingPlaylistId('all')
    setPlaylistSyncMessage('')
    let imported = 0
    try {
      for (const playlist of neteasePlaylists) {
        const response = await fetch(`/api/music/netease/playlists/${encodeURIComponent(playlist.id)}/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: playlist.name }),
        })
        if (response.ok) imported += ((await response.json()) as { imported: number }).imported
      }
      await refreshLibrary()
      setPlaylistSyncMessage(`${neteasePlaylists.length} playlists · ${imported} tracks synced`)
    } finally {
      setSyncingPlaylistId(null)
    }
  }

  async function toggleNeteasePlaylist(playlist: NeteasePlaylist) {
    if (expandedPlaylistId === playlist.id) {
      setExpandedPlaylistId(null)
      return
    }
    setExpandedPlaylistId(playlist.id)
    if (playlistTracks[playlist.id]) return
    const response = await fetch(`/api/music/netease/playlists/${encodeURIComponent(playlist.id)}/tracks?name=${encodeURIComponent(playlist.name)}`)
    if (response.ok) {
      const tracks = (await response.json()) as PlaylistTrackSummary[]
      setPlaylistTracks((current) => ({ ...current, [playlist.id]: tracks }))
    }
  }

  async function refreshLibrary() {
    const response = await fetch('/api/library')
    if (!response.ok) return
    setLibrary((await response.json()) as LibrarySummary)
  }

  function locateAndRefreshWeather() {
    if (!navigator.geolocation) return
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (position) => {
        void fetch('/api/context/location', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
        })
          .then((response) => response.json())
          .then((data: LiveContext) => setLiveContext(data))
          .finally(() => setLocating(false))
      },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 10 * 60_000 },
    )
  }

  async function importPlaylist(file: File) {
    setImportingLibrary(true)
    setAgentWarning('')
    try {
      const response = await fetch('/api/library/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, content: await file.text() }),
      })
      if (!response.ok) throw new Error('Import failed')
      const result = (await response.json()) as { imported: number; total: number }
      await refreshLibrary()
      setAgentWarning(`${result.imported} tracks added to Chatty's private library.`)
    } catch {
      setAgentWarning('This playlist file could not be read. Try JSON, CSV or TXT.')
    } finally {
      setImportingLibrary(false)
      if (playlistInputRef.current) playlistInputRef.current.value = ''
    }
  }

  function seek(event: React.PointerEvent<HTMLDivElement>) {
    const audio = audioRef.current
    if (!audio || !duration) return
    const rect = event.currentTarget.getBoundingClientRect()
    audio.currentTime = ((event.clientX - rect.left) / rect.width) * duration
  }

  const progress = duration ? Math.min(1, elapsed / duration) : 0

  return (
    <main className={desktopShell ? 'stage desktop-shell' : 'stage'}>
      {desktopShell ? <div className="desktop-titlebar" aria-hidden="true" /> : null}
      <div className="fluid fluid-blue" />
      <div className="fluid fluid-violet" />
      <div className="fluid fluid-accent" />
      <div className="grain" />

      <section className={`radio view-${view}${chatExpanded ? ' chat-expanded' : ''}`} aria-label="Chatty private radio">
        <header className="console-header">
          <button className="brand brand-button" type="button" onClick={() => setView('profile')} aria-label="Open Chatty profile">
            <img className="avatar" src="/chatty-avatar.png" alt="Chatty" /><span>CHATTY</span>
          </button>
          <div className="station-nav">
            <button className={view === 'studio' ? 'selected' : ''} type="button" onClick={() => setView('studio')}>STUDIO</button>
            <button className={view === 'queue' ? 'selected' : ''} type="button" onClick={() => setView('queue')}>QUEUE</button>
            <button className={view === 'profile' ? 'selected' : ''} type="button" onClick={() => setView('profile')}>PROFILE</button>
          </div>
          <div className="header-context">
            <button className="context-pill" type="button" onClick={locateAndRefreshWeather} title={liveContext.weather}>
              {locating ? 'LOCATING…' : `${liveContext.city.toUpperCase()} · ${liveContext.temperature ?? '--'}°`}
            </button>
          </div>
        </header>

        <div className="broadcast-status">
          <span className={active ? 'live-dot active' : 'live-dot'} />
          <span>{status.toUpperCase()}</span>
          <span className="status-divider">/</span>
          <span>{agentActivity.toUpperCase()}</span>
        </div>

        <section className="clock-face">
          <div className="digital-clock">{clock}</div>
          <div className="date-label">{dateLabel}</div>
        </section>

        <section className="deck">
          <div className="deck-side">
            <div className="artwork-shell">
              {player.currentTrack?.artwork ? <img src={player.currentTrack.artwork} alt="" /> : <div className="artwork-placeholder">C</div>}
              <span className="edition-mark">CHATty<br />FM 01</span>
            </div>
            <div className="deck-transport" aria-label="Playback controls">
              <button className="skip-control" type="button" onClick={() => void controlPlayback('previous')} disabled={player.queue.length < 2} aria-label="Previous track">‹</button>
              <button
                className="round-control"
                type="button"
                onClick={() => void controlPlayback(player.isPlaying ? 'pause' : 'play')}
                disabled={!player.currentTrack}
                aria-label={player.currentTrack ? (player.isPlaying ? 'Pause radio' : 'Play radio') : 'Choose what to hear before starting the radio'}
                title={player.currentTrack ? undefined : 'Choose a cue below to start the radio'}
              >
                {player.isPlaying ? <PauseIcon /> : <PlayIcon />}
              </button>
              <button className="skip-control" type="button" onClick={() => void controlPlayback('next')} disabled={player.queue.length < 2} aria-label="Next track">›</button>
            </div>
            <div className="volume-control deck-volume">
              <button type="button" onClick={toggleMusicMute} aria-label={musicVolume > 0 ? 'Mute music' : 'Unmute music'}>
                <VolumeIcon muted={musicVolume === 0} />
              </button>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={musicVolume}
                onChange={(event) => changeMusicVolume(Number(event.target.value))}
                aria-label="Music volume"
                style={{ '--volume-level': `${musicVolume * 100}%` } as React.CSSProperties}
              />
              <span>{Math.round(musicVolume * 100)}</span>
            </div>
          </div>
          <div className="deck-main">
            <div className="deck-label">NOW PLAYING</div>
            <h1>{player.currentTrack?.title ?? 'WAITING FOR A CUE'}</h1>
            <p>{player.currentTrack?.artist ?? 'Tell Chatty what this moment needs'}</p>
            <Waveform active={active} />
            <div className="track-progress" onPointerDown={seek}><span style={{ width: `${progress * 100}%` }} /></div>
            <div className="track-times"><span>{formatTime(elapsed)}</span><span>{formatTime(duration || player.currentTrack?.durationSec || 0)}</span></div>
          </div>
        </section>

        <button className="queue-panel queue-panel-button" type="button" onClick={() => setView('queue')} aria-label="Open the full upcoming playlist">
          <div className="section-title"><span>NEXT UP</span><span>{player.queue.length || 0} TRACKS</span></div>
          <div className="queue-list">
            {(player.queue.length ? player.queue.slice(0, 3) : [null, null]).map((track, index) => (
              <div className={track?.id === player.currentTrack?.id ? 'queue-row current' : 'queue-row'} key={track?.id ?? `empty-${index}`}>
                <span className="queue-number">{String(index + 1).padStart(2, '0')}</span>
                <span className="queue-title">{track?.title ?? (index === 0 ? 'Your next song appears here' : 'Chatty is building the set')}</span>
                <span className="queue-artist">{track?.artist ?? '—'}</span>
                <span>{track ? formatTime(track.durationSec) : '--:--'}</span>
              </div>
            ))}
          </div>
          {player.queue.length > 3 ? <span className="queue-open-all">VIEW ALL {player.queue.length} TRACKS →</span> : null}
        </button>

        <section className="dj-panel">
          <div className="dj-title">
            <button className="avatar-button" type="button" onClick={() => setView('profile')} aria-label="Open Chatty profile"><img className="dj-avatar" src="/chatty-avatar.png" alt="" /></button>
            <button className="dj-name-button" type="button" onClick={() => setView('profile')}>Chatty</button>
            <span className="dj-state">{speaking ? 'VOICE LIVE' : 'AI DJ'}</span>
            <button className="chat-mode-toggle" type="button" onClick={() => setChatExpanded((current) => !current)}>
              {chatExpanded ? 'BACK TO RADIO' : 'OPEN CONVERSATION'}
            </button>
          </div>
          <div className="transcript" ref={transcriptRef}>
            {conversation.length === 0 && !currentLine ? (
              <div className="turn current-turn"><p>Tell me what this moment feels like. I&rsquo;ll take it from here.</p></div>
            ) : null}
            {conversation.map((line, index) => {
              const isCurrent = line.role === 'agent' && line.text === currentLine && index === conversation.length - 1
              const date = new Date(line.timestamp)
              return (
                <div className={`turn ${line.role === 'user' ? 'user-turn' : 'agent-turn'} ${isCurrent ? 'current-turn' : ''}`} key={`${line.timestamp}-${index}`}>
                  <div className="turn-head">{line.role === 'user' ? 'YOU' : 'CHATTY'} · {date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</div>
                  <p>{isCurrent && speaking ? <HighlightedSpeech text={line.text} progress={spokenChars} /> : line.text}</p>
                </div>
              )
            })}
          </div>
          {pendingMemory ? (
            <div className="memory-question">
              <p>快捷回复</p>
              <div>
                <button type="button" onClick={() => void sendMessage('只是现在不想听')}>只是现在</button>
                <button type="button" onClick={() => void sendMessage(`${memoryActivityLabel(pendingMemory.suggestedContext)}时少放`)}>当前场景少放</button>
                <button type="button" onClick={() => void sendMessage('以后都少放')}>以后都少放</button>
                <button type="button" onClick={() => void sendMessage('不用记，我只是想换一首')}>不用记</button>
              </div>
            </div>
          ) : null}
          {!pendingMemory && openingSuggestions.length > 0 ? (
            <div className="opening-suggestions" aria-label="Quick listening choices">
              <span>Try one, or say anything</span>
              {openingSuggestions.map((suggestion) => (
                <button type="button" key={suggestion} onClick={() => void sendMessage(suggestion)}>{suggestion}</button>
              ))}
            </div>
          ) : null}
        </section>

        {runtimeIssues.length ? <div className="runtime-issues" role="alert">
          {runtimeIssues.map((issue) => <article key={`${issue.service}-${issue.code}`}>
            <div><strong>{issue.service === 'fish' ? 'FISH CUSTOM VOICE' : `${issue.service.toUpperCase()} BRAIN`}</strong><span>{issue.code.replaceAll('_', ' ')}</span></div>
            <p>{issue.message}</p>
            <a href={issue.actionUrl} target="_blank" rel="noreferrer">{issue.actionLabel} →</a>
          </article>)}
        </div> : null}
        {agentWarning ? <div className="agent-warning">{agentWarning}</div> : null}
        <form className="request-bar" onSubmit={submitMessage}>
          <span className="request-label">REQUEST</span>
          <input
            value={input}
            onFocus={() => setChatExpanded(true)}
            onChange={(event) => {
              setInput(event.target.value)
              if (event.target.value) setOpeningSuggestions([])
            }}
            onKeyDown={submitInputOnEnter}
            placeholder="来点适合现在的歌"
            aria-label="Tell Chatty what you want to hear"
          />
          <button type="button" className="mood-button" onClick={() => setCommandOpen(true)} aria-label="Open quick cues">+</button>
          <button type="button" className={voiceListening ? 'mood-button voice-input listening' : 'mood-button voice-input'} onClick={toggleVoiceInput} aria-label={voiceListening ? 'Stop voice input' : 'Start voice input'} title={voiceListening ? 'Stop listening' : 'Speak your request'}><MicIcon active={voiceListening} /></button>
          <button type="submit" className="request-send" disabled={sending || !input.trim()} aria-label="Send request">{sending ? '···' : '↗'}</button>
        </form>

        {view === 'profile' ? (
          <section className="app-page profile-page" aria-label="Chatty profile">
            <ProfileParticleSphere />
            <button className="page-back" type="button" onClick={() => setView('studio')}>← BACK TO STUDIO</button>
            <div className="profile-hero">
              <img className="profile-avatar" src="/chatty-avatar.png" alt="Chatty the DJ" />
              <div>
                <p className="profile-kicker">YOUR PRIVATE AI DJ</p>
                <h1>Chatty</h1>
                <p className="profile-status"><span className="live-dot active" /> ON AIR · VOICE CONNECTED</p>
              </div>
            </div>
            <blockquote>Your mood is my prompt.<br />I don&rsquo;t follow the algorithm. I have taste.</blockquote>
            <div className="profile-stats">
              <div><span>ON AIR</span><strong>24/7</strong></div>
              <div><span>GENRES</span><strong>∞</strong></div>
              <div><span>LISTENER</span><strong>1</strong></div>
            </div>
            <div className="taste-tags" aria-label="Chatty taste tags">
              {['JAZZ-HIPHOP', 'NEO-CLASSICAL', '90S', 'TRIP-HOP', 'INDIE', 'AMBIENT', 'POST-PUNK', 'SHIBUYA-KEI'].map((tag) => <button className={selectedTasteTag === tag ? 'selected' : ''} type="button" key={tag} onClick={() => setSelectedTasteTag((current) => current === tag ? null : tag)} aria-pressed={selectedTasteTag === tag}>{tag}</button>)}
            </div>
            <div className="profile-note"><span>TASTE.MD</span><p>Built around your routines, listening history, moods and the songs you keep coming back to.</p></div>
            <section className="memory-vault" aria-label="Chatty long term memory">
              <div className="memory-vault-heading"><span>LONG-TERM MEMORY</span><strong>{memories.length} CONFIRMED</strong></div>
              {memories.length ? memories.map((memory) => (
                <article key={memory.id}>
                  <div><b>{memory.subject}</b><button className="memory-scope" type="button" onClick={() => void cycleMemoryScope(memory)} title="Change memory scope">{memory.scope}{memory.context ? ` · ${memory.context}` : ''}</button></div>
                  <p>{memory.preference}</p>
                  <button className="memory-delete" type="button" onClick={() => void deleteMemory(memory.id)} aria-label={`Delete memory ${memory.subject}`}>×</button>
                </article>
              )) : <p className="memory-empty">Confirmed preferences will appear here. Skips alone are never treated as permanent.</p>}
            </section>
            <input
              ref={playlistInputRef}
              className="playlist-file-input"
              type="file"
              accept=".json,.csv,.txt,application/json,text/csv,text/plain"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void importPlaylist(file)
              }}
            />
            <button className="connect-music import-library" type="button" onClick={() => playlistInputRef.current?.click()} disabled={importingLibrary}>
              {importingLibrary ? 'READING YOUR PLAYLIST…' : 'IMPORT PLAYLIST DATA →'}
            </button>
            <section className="platform-connect" aria-label="Choose a playback platform">
              <div className="platform-heading">
                <div><span>PLAYBACK PLATFORMS</span><p>Choose where Chatty should find and play full tracks.</p></div>
                <i>{selectedPlatform.available ? 'AVAILABLE' : 'COMING SOON'}</i>
              </div>
              <div className="platform-pills">
                {musicPlatforms.map((platform) => (
                  <button
                    className={platform.id === selectedPlatformId ? 'selected' : ''}
                    type="button"
                    key={platform.id}
                    onClick={() => setSelectedPlatformId(platform.id)}
                  >
                    {platform.label}{platform.available ? <b /> : <small>SOON</small>}
                  </button>
                ))}
              </div>
              <div className="platform-detail">
                <div>
                  <strong>{selectedPlatform.label}</strong>
                  <p>{selectedPlatform.id === 'qq' ? 'Cross-platform adapter port is ready. QQ account authorization and playback are not connected yet.' : selectedPlatform.available ? 'Available now. Connection is stored only on this Mac.' : 'This connector is reserved for a later update.'}</p>
                </div>
                {selectedPlatform.id === 'netease' ? (
                  <button type="button" onClick={() => void startNeteaseLogin()} disabled={neteaseStatus === 'checking'}>
                    {neteaseStatus === 'connected' ? 'CONNECTED ✓' : 'CONNECT →'}
                  </button>
                ) : <span>{selectedPlatform.id === 'qq' ? 'CONNECTOR READY · AUTH PENDING' : 'NOT YET CONNECTED'}</span>}
              </div>
              {selectedPlatform.id === 'netease' && neteaseStatus === 'connected' ? (
                <section className="netease-library" aria-label="Your Netease playlists">
                  <div className="netease-library-heading">
                    <div><strong>YOUR NETEASE PLAYLISTS</strong><span>{neteasePlaylists.length} PLAYLISTS</span></div>
                    <button type="button" disabled={loadingNeteasePlaylists || syncingPlaylistId !== null || !neteasePlaylists.length} onClick={() => void syncAllNeteasePlaylists()}>
                      {syncingPlaylistId === 'all' ? 'SYNCING…' : 'SYNC ALL'}
                    </button>
                  </div>
                  {playlistSyncMessage ? <p className="playlist-sync-message">{playlistSyncMessage}</p> : null}
                  {loadingNeteasePlaylists ? <p className="playlist-loading">Reading your playlists…</p> : (
                    <div className="netease-playlist-list">
                      {neteasePlaylists.map((playlist) => {
                        const synced = library.files.some((file) => file.name === `netease-${playlist.id}.json`)
                        const expanded = expandedPlaylistId === playlist.id
                        const tracks = playlistTracks[playlist.id]
                        return (
                          <article className={expanded ? 'netease-playlist expanded' : 'netease-playlist'} key={playlist.id}>
                            <div className="netease-playlist-row">
                              <button className="playlist-open" type="button" onClick={() => void toggleNeteasePlaylist(playlist)}>
                                {playlist.coverUrl ? <img src={playlist.coverUrl} alt="" /> : <span className="playlist-cover-placeholder">♪</span>}
                                <span><b>{playlist.name}</b><small>{playlist.trackCount} tracks · {synced ? 'synced' : 'not synced'}</small></span>
                                <i>{expanded ? '−' : '+'}</i>
                              </button>
                              <button className="playlist-sync" type="button" disabled={syncingPlaylistId !== null} onClick={() => void syncNeteasePlaylist(playlist)}>
                                {syncingPlaylistId === playlist.id ? 'SYNCING…' : synced ? 'RESYNC' : 'SYNC'}
                              </button>
                            </div>
                            {expanded ? <div className="playlist-track-preview">
                              {!tracks ? <p>Loading tracks…</p> : tracks.slice(0, 30).map((track, index) => <div key={`${track.title}-${track.artist}-${index}`}><i>{String(index + 1).padStart(2, '0')}</i><span><b>{track.title}</b><small>{track.artist}</small></span></div>)}
                              {tracks?.length && tracks.length > 30 ? <p>+ {tracks.length - 30} more tracks</p> : null}
                            </div> : null}
                          </article>
                        )
                      })}
                    </div>
                  )}
                </section>
              ) : null}
            </section>
          </section>
        ) : null}

        {view === 'queue' ? (
          <section className="app-page schedule-page" aria-label="Programme queue">
            <button className="page-back" type="button" onClick={() => setView('studio')}>← BACK TO STUDIO</button>
            <p className="profile-kicker">TODAY&rsquo;S RADIO</p>
            <h1>{radioPlan?.goal ?? 'Natalie’s Room Tone'}</h1>
            <div className="schedule-block queue-editor">
              <div className="schedule-heading">
                <strong>CURRENT SET{radioPlan ? ` · ${radioPlan.activity.toUpperCase()}` : ''}</strong>
                <span>{programmeTracks.length} TRACKS · CLICK A SONG TO PLAY</span>
              </div>
              {programmeTracks.length ? programmeTracks.map((track, index) => (
                <div className={track.id === player.currentTrack?.id ? 'queue-edit-row current' : 'queue-edit-row'} key={track.id}>
                  <button className="queue-track-button" type="button" onClick={() => void controlPlayback('select', track.id)}>
                    <i>{String(index + 1).padStart(2, '0')}</i><span><b>{track.title}</b><small>{track.artist}</small></span>
                    {track.id === player.currentTrack?.id ? <em className="queue-live">ON AIR</em> : null}
                  </button>
                  <div className="queue-actions">
                    <button type="button" disabled={index === 0} onClick={() => void controlPlayback('move_up', track.id)} aria-label={`Move ${track.title} up`}>↑</button>
                    <button type="button" disabled={index === programmeTracks.length - 1} onClick={() => void controlPlayback('move_down', track.id)} aria-label={`Move ${track.title} down`}>↓</button>
                    <button type="button" onClick={() => void controlPlayback('remove', track.id)} aria-label={`Remove ${track.title}`}>×</button>
                  </div>
                </div>
              )) : <p className="empty-queue">Ask Chatty for music in Studio and the editable queue will appear here.</p>}
            </div>
            <div className="schedule-block programme-card">
              <div><strong>LATER · DEEP WORK</strong><span>Ambient · Neo-classical · Electronic</span><span>Rebuild this set around your current mood and schedule.</span></div>
              <button type="button" disabled={sending} onClick={() => void runProgrammeCue('Build me a new deep-work radio set for later today. Keep it focused, personal, and explain the transition in English.')}>{sending ? 'BUILDING…' : 'REBUILD SET →'}</button>
            </div>
            <button className="music-source-card" type="button" onClick={() => setView('profile')}><img src="/chatty-avatar.png" alt="" /><div><strong>CHATTY LOCAL LIBRARY</strong><span>Open your library, import playlists, or choose a playback platform.</span></div><i>{library.total} TRACKS · OPEN →</i></button>
          </section>
        ) : null}
      </section>

      {neteaseQr ? (
        <div className="netease-backdrop" onMouseDown={() => { setNeteaseQr(null); setNeteaseKey(null); setNeteaseStatus('disconnected') }}>
          <section className="netease-dialog" onMouseDown={(event) => event.stopPropagation()}>
            <button type="button" className="dialog-close" onClick={() => { setNeteaseQr(null); setNeteaseKey(null); setNeteaseStatus('disconnected') }}>×</button>
            <p className="profile-kicker">NETEASE MUSIC</p>
            <h2>扫码连接你的音乐</h2>
            <img src={neteaseQr} alt="Netease Music login QR code" />
            <p>{neteaseStatus === 'scanned' ? '已扫码，请在手机上确认登录。' : '打开手机网易云音乐，扫描这个二维码。'}</p>
            <span>密码不会交给 Chatty，登录凭证只保存在这台 Mac。</span>
          </section>
        </div>
      ) : null}

      {commandOpen ? (
        <div className="command-backdrop" onMouseDown={() => setCommandOpen(false)}>
          <form className="command-sheet" onSubmit={submitMessage} onMouseDown={(event) => event.stopPropagation()}>
            <div className="command-grip" />
            <p className="command-label">A cue for Chatty</p>
            <h2>现在想听什么？</h2>
            <textarea autoFocus value={input} onChange={(event) => setInput(event.target.value)} rows={3} placeholder="比如：来点适合下雨夜晚通勤的歌" />
            <div className="quick-cues">
              {['适合现在的歌', '专注一小时', '学习听', '做爱听', '说说为什么选这首'].map((cue) => (
                <button type="button" key={cue} onClick={() => setInput(cue)}>{cue}</button>
              ))}
            </div>
            <button className="send-cue" type="submit" disabled={sending || !input.trim()}>{sending ? 'Chatty 正在想…' : '开始这期节目'}</button>
          </form>
        </div>
      ) : null}

      {musicSetupRequired && !neteaseQr ? (
        <section className="source-onboarding" aria-label="Connect your music library">
          {neteaseStatus === 'disconnected' ? <div className="source-onboarding-tabs">
              {musicPlatforms.slice(0, 3).map((platform) => (
                <button
                  key={platform.id}
                  type="button"
                  className={platform.id === selectedPlatformId ? 'selected' : ''}
                  onClick={() => setSelectedPlatformId(platform.id)}
                >
                  {platform.label}{platform.id === 'qq' ? <small> SOON</small> : null}
                </button>
              ))}
            </div> : null}
          <div className="source-onboarding-card">
            <p className="profile-kicker">CHATTY PERSONAL LIBRARY</p>
            {neteaseStatus === 'checking' ? (
              <div className="source-syncing"><b>●</b><h2>正在检查音乐账号</h2><p>Chatty 会先确认你的音乐库，再开始电台。</p></div>
            ) : neteaseStatus === 'connected' ? (
              <div className="source-syncing"><b>↻</b><h2>正在同步你的歌单</h2><p>第一次同步完成后，Chatty 才会根据真实音乐库开始选歌。</p></div>
            ) : selectedPlatformId === 'netease' ? (
              <>
                <h2>先连接你的网易云歌单</h2>
                <p>登录是开始电台的第一步。扫码后 Chatty 会读取并同步你的歌单，再询问你此刻想听什么。</p>
                <div className="source-qr-placeholder"><b>NE</b><span>打开网易云音乐<br />扫码登录</span></div>
                <button type="button" className="source-login-button" onClick={() => void startNeteaseLogin()}>扫码登录网易云音乐 →</button>
              </>
            ) : (
              <><h2>连接你的音乐库</h2><div className="source-pending"><b>QQ</b><p>QQ 音乐的真实授权和播放适配正在接入。现在不会把它伪装成已经连接。</p></div></>
            )}
          </div>
        </section>
      ) : null}

      <audio
        ref={audioRef}
        preload="metadata"
        onTimeUpdate={(event) => reportProgress(event.currentTarget)}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onEnded={() => void controlPlayback('ended')}
      />
      <audio ref={ttsAudioRef} preload="auto" />
    </main>
  )
}

function PlayIcon() {
  return <svg viewBox="0 0 14 14" aria-hidden="true"><path d="M3.5 2.2 11.5 7l-8 4.8z" fill="currentColor" /></svg>
}

function PauseIcon() {
  return <svg viewBox="0 0 14 14" aria-hidden="true"><rect x="3" y="2" width="2.5" height="10" rx=".8" fill="currentColor" /><rect x="8.5" y="2" width="2.5" height="10" rx=".8" fill="currentColor" /></svg>
}

function MicIcon({ active }: { active: boolean }) {
  return <svg viewBox="0 0 14 14" aria-hidden="true"><rect x="4.5" y="1.2" width="5" height="7" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.25" /><path d="M2.7 6.7a4.3 4.3 0 0 0 8.6 0M7 11v2M4.7 13h4.6" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />{active ? <circle cx="11.5" cy="2.4" r="1.2" fill="currentColor" /> : null}</svg>
}

function VolumeIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 6h3l3-2.8v9.6L5 10H2z" fill="currentColor" />
      {muted
        ? <path d="m10.2 6 3.6 4m0-4-3.6 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        : <path d="M10.2 5.3c1.5 1.3 1.5 4.1 0 5.4M12.1 3.8c2.5 2.2 2.5 6.2 0 8.4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />}
    </svg>
  )
}

export default App
