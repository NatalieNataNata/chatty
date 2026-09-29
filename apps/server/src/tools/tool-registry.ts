import type { ToolRequest, ToolResult } from '@chatty/shared'
import { searchLibrary, getLibrarySummary, resolvePersonalCandidates } from '../library/library-store.js'
import type { ContextBundle, RuntimeDeps, ToolRegistry } from '../types.js'

export class ChattyToolRegistry implements ToolRegistry {
  constructor(private readonly deps: RuntimeDeps) {}

  async execute(request: ToolRequest, context: ContextBundle): Promise<ToolResult> {
    try {
      let output: unknown
      const query = typeof request.arguments.query === 'string' ? request.arguments.query : context.userMessage

      if (request.name === 'memory_search') output = this.deps.state.getMemoryView(context.currentPlan?.activity ?? 'general')
      else if (request.name === 'library_search') output = await searchLibrary(query)
      else if (request.name === 'music_search' || request.name === 'resolve_audio') {
        const rawCandidates = (request.arguments as any).preferredCandidates
        const preferredCandidates = Array.isArray(rawCandidates)
          ? (rawCandidates as any[]).filter((item): item is { title: string; artist: string } => Boolean(
            item && typeof item === 'object' && 'title' in item && 'artist' in item
            && typeof item.title === 'string' && typeof item.artist === 'string',
          ))
          : []
        const strictArtist = typeof (request.arguments as any).strictArtist === 'string' ? (request.arguments as any).strictArtist : undefined
        const personalCandidates = await resolvePersonalCandidates(preferredCandidates, query, 18, strictArtist)
        if (!personalCandidates.length) {
          throw new Error('Your personal music library is empty. Connect and sync a playlist before starting Chatty radio.')
        }
        output = await this.deps.music.search(query, context, { preferredCandidates: personalCandidates, strictArtist })
      }
      else if (request.name === 'get_user_playlists') output = this.deps.music.getUserPlaylists
        ? await this.deps.music.getUserPlaylists()
        : await getLibrarySummary()
      else if (request.name === 'get_weather') output = await this.deps.weather.getCurrentSummary()
      else if (request.name === 'get_calendar') output = await this.deps.calendar.getTodaySummary()
      else if (request.name === 'tts_synthesize') {
        const text = typeof request.arguments.text === 'string' ? request.arguments.text : ''
        output = await this.deps.tts.synthesize(text)
      } else if (request.name === 'schedule_segue') {
        output = { scheduled: true, at: request.arguments.at ?? 'next_transition' }
      } else if (request.name === 'playback_control') {
        output = { accepted: true, action: request.arguments.action ?? 'play' }
      }

      const result = { id: request.id, name: request.name, ok: true, output }
      this.deps.state.appendLedger({ type: 'tool_executed', entityType: 'tool_request', entityId: request.id, payload: result, occurredAt: new Date().toISOString(), actor: 'agent' })
      return result
    } catch (error) {
      const result = {
        id: request.id,
        name: request.name,
        ok: false,
        error: error instanceof Error ? error.message : 'Tool execution failed.',
      }
      this.deps.state.appendLedger({ type: 'tool_executed', entityType: 'tool_request', entityId: request.id, payload: result, occurredAt: new Date().toISOString(), actor: 'agent' })
      return result
    }
  }
}
