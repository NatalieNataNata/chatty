import OpenAI from 'openai'
import { fetch, ProxyAgent } from 'undici'
import { agentDecisionSchema } from '@chatty/shared'
import type { Track } from '@chatty/shared'
import type { AgentProvider, ContextBundle } from '../types.js'

export class OpenAiAgentProvider implements AgentProvider {
  private client: OpenAI
  private proxyClient: OpenAI | null
  private model: string

  constructor() {
    const proxyUrl = process.env.OPENAI_PROXY
      ?? process.env.DEEPSEEK_PROXY
      ?? (process.env.CHATTY_BRAIN_PROVIDER === 'deepseek' ? process.env.FISH_AUDIO_PROXY : undefined)
      ?? process.env.HTTPS_PROXY
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
    })
    this.proxyClient = proxyUrl
      ? new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        baseURL: process.env.OPENAI_BASE_URL,
        fetch: ((input: unknown, init?: unknown) => fetch(input as never, {
          ...(init as object),
          dispatcher: new ProxyAgent(proxyUrl),
        } as never)) as unknown as typeof globalThis.fetch,
      })
      : null
    this.model = process.env.OPENAI_MODEL ?? 'gpt-5-mini'
  }

  private async request<T>(run: (client: OpenAI) => Promise<T>) {
    try {
      return await run(this.client)
    } catch (error) {
      // Direct access is fastest when available. If it flakes out, the local
      // Clash route is a real second network path, not a different AI brain.
      if (this.proxyClient) {
        try {
          return await run(this.proxyClient)
        } catch (proxyError) {
          throw proxyError
        }
      }
      throw error
    }
  }

  async decide(context: ContextBundle) {
    const system = [
      context.persona.djPersona,
      context.conversationPolicy,
      '',
      'You must answer with JSON only.',
      'Omit unused fields instead of setting them to null. Array fields must always be arrays (empty if unused).',
      'Schema: {"intent":{"kind":"start_radio"|"conversation"|"explain_choice"|"change_track"|"preference"|"memory_confirmation"|"playback_control","activity":"study"|"running"|"commute"|"relax"|"sleep"|"general","mood":string,"energy":"low"|"medium"|"high"|"rising"|"steady","durationMin":number|null,"lyricDensity":"low"|"medium"|"high"|"any","djFrequency":"minimal"|"balanced"|"active","confidence":number},"programme":null|{"goal":string,"durationMin":number,"constraints":string[],"replanTriggers":string[],"segments":[{"label":string,"durationMin":number,"energy":"low"|"medium"|"high"|"rising"|"steady","query":string,"djPolicy":"intro"|"quiet"|"transition"|"check_in"}]},"say":string[],"play":[{"query"?:string,"reason"?:string,"target"?:"web"|"upnp","preferredCandidates":[{"title":string,"artist":string}]}],"reason":string,"segue"?:{"style":string,"tone"?:string,"duckMusic"?:boolean},"memory_write":[{"key":string,"value":string}],"tool_requests":[{"id":string,"name":"memory_search"|"library_search"|"music_search"|"get_user_playlists"|"resolve_audio"|"playback_control"|"get_weather"|"get_calendar"|"tts_synthesize"|"schedule_segue","arguments":object}]}',
      'Always infer and return intent. You are the programme director, not a keyword classifier.',
      'For a new listening request, design programme as a coherent radio arc from the actual request, memories, time, environment, and available library. Do not select from canned scene templates. For ordinary conversation, programme must be null.',
      'Use the conversation history. Respond to what the user actually said; never fall back to generic radio filler.',
      'For ordinary conversation, respond at the depth the exchange naturally calls for and do not add a play action unless music would genuinely help.',
      'For music requests, make an editorial programming decision and add at most one play action. The query should express the musical qualities you need for retrieval.',
      'For every music request, say must contain one complete, speakable DJ link for the listener before the next track begins. Never leave say empty for a music request. It must sound like a live programme decision, not a status message.',
      'The imported cross-platform library in persona.playlists is the listener’s own collection. Prefer suitable songs from it. Put several real matching title/artist pairs in preferredCandidates; never invent candidates. Leave it empty if the library has no appropriate match.',
      'A play.query is for music retrieval: use genre, activity, energy, instrumentation, or a user-supplied artist/title. Never invent a song title and use it as the query.',
      'When the user requests music, describe the direction in your say — mood, energy, genre, artist — without naming a specific song title. For example: "Here\'s something mellow for late night" or "Keeping it upbeat with some pop." The system handles actual track selection after your response.',
      'Respect confirmed memories and the current radio plan. Session memories expire; contextual memories only apply to their named activity.',
      'memoryView is the authoritative task view: profile facts use exact keys, the conversation summary is compressed history, and skills are reusable verified procedures. Do not treat raw behavior as a confirmed preference.',
      'Request a tool only when its result is not already present in context. Never claim a tool succeeded; the local executor reports that.',
      'Do not create permanent preferences from skips or other implicit behavior. Ask for scope first.',
      'If the user asks a follow-up, answer it directly and preserve continuity with the previous turns.',
      'Every string in say must be natural English, even when the user writes in Chinese. Speak with the substance of a real DJ when the moment warrants it; do not impose a word or sentence limit.',
      'Voice: confident but warm. Speak like a real DJ with taste — editorial, not theatrical. Be restrained, never melodramatic or flirtatious by default.',
    ].join('\n')

    const user = JSON.stringify(context)
    const response = await this.request((client) => client.chat.completions.create({
      model: this.model,
      temperature: 0.7,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
    }))

    const content = response.choices[0]?.message?.content ?? '{}'
    return agentDecisionSchema.parse(JSON.parse(content))
  }

  async narrateTrack(context: ContextBundle, track: Track, moment: 'programme_open' | 'track_change' | 'explain') {
    const system = [
      context.persona.djPersona,
      'Write the spoken link that Chatty will broadcast immediately. Do not use headings, bullets, stage directions, quotation marks, or JSON.',
      'Decide the natural depth and length from the live context. Do not count words, obey a sentence quota, or pad the link.',
      'Connect the listener’s request, the current atmosphere, and the programme arc to the selected track. Mention the real title and artist naturally once.',
      'Use only the supplied metadata as factual information. Never invent release years, biographies, recording stories, lyrics, instruments, or musical history.',
      'You may describe the intended listening effect, but frame it as your reason for choosing the track rather than an unverifiable fact about the recording.',
      moment === 'explain' ? 'Directly answer why this track was chosen.' : 'End by handing the listener gently into the track.',
    ].join('\n')
    const response = await this.request((client) => client.chat.completions.create({
      model: this.model,
      temperature: 0.82,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify({ moment, request: context.userMessage, environment: context.environment, plan: context.currentPlan, memories: context.memories, track: { title: track.title, artist: track.artist, album: track.album } }) },
      ],
    }))
    const narration = response.choices[0]?.message?.content?.trim()
    if (!narration) throw new Error('The DJ brain returned an empty track narration.')
    return narration
  }

  async composeOpening(context: ContextBundle, currentTrack: Track | null) {
    const system = [
      context.persona.djPersona,
      'Write the live opening line for a private AI radio session.',
      'Output natural English only, with no headings, quotation marks, stage directions, or JSON.',
      'Do not reuse a stock greeting. Vary the rhythm and wording from recent conversation history.',
      'Ground the line in the actual time, environment, active programme, and current track when useful.',
      'End with one natural question that helps the listener choose whether to continue, change direction, or describe what they want now.',
      'Keep it concise enough to speak aloud, but do not use a fixed template.',
      'Do not claim an action has happened and do not select or change music in this line.',
    ].join('\n')
    const response = await this.request((client) => client.chat.completions.create({
      model: this.model,
      temperature: 0.95,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify({
          environment: context.environment,
          plan: context.currentPlan,
          recentConversation: context.history.slice(-8),
          memories: context.memories,
          currentTrack: currentTrack ? { title: currentTrack.title, artist: currentTrack.artist, album: currentTrack.album } : null,
        }) },
      ],
    }))
    const opening = response.choices[0]?.message?.content?.trim()
    if (!opening) throw new Error('The DJ brain returned an empty opening line.')
    return opening
  }
}
