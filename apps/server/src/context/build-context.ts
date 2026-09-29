import { readFile } from 'node:fs/promises'
import type { Activity, EnvSnapshot } from '@chatty/shared'
import { personaDir } from '../paths.js'
import { getLibraryContext } from '../library/library-store.js'
import type { ContextBundle, RuntimeDeps } from '../types.js'

async function readPersonaFile(name: string) {
  return readFile(`${personaDir}/${name}`, 'utf8')
}

export async function buildContext(userMessage: string, deps: RuntimeDeps, activity?: Activity): Promise<ContextBundle> {
  const memoryActivity = activity ?? deps.state.getCurrentPlan()?.activity ?? 'general'
  const now = new Date()
  const tzOffset = -now.getTimezoneOffset()
  const tzSign = tzOffset >= 0 ? '+' : '-'
  const pad = (n: number) => String(Math.abs(n)).padStart(2, '0')
  const localIso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${tzSign}${pad(Math.floor(tzOffset / 60))}:${pad(tzOffset % 60)}`
  const [djPersona, user, taste, routines, playlists, importedLibrary, moodRules, weather, calendar] = await Promise.all([
    readPersonaFile('dj-persona.md'),
    readPersonaFile('user.md'),
    readPersonaFile('taste.md'),
    readPersonaFile('routines.md'),
    readPersonaFile('playlists.json'),
    getLibraryContext(userMessage),
    readPersonaFile('mood-rules.md'),
    deps.weather.getCurrentSummary(),
    deps.calendar.getTodaySummary(),
  ])

  const environment: EnvSnapshot = {
    nowIso: localIso,
    weather,
    calendarSummary: calendar,
  }

  return {
    persona: {
      djPersona,
      user,
      taste,
      routines,
      playlists: importedLibrary ? `${playlists}\n\nImported cross-platform library:\n${importedLibrary}` : playlists,
      moodRules,
    },
    environment,
    history: deps.state.getMessages(12),
    lastTracks: deps.state.getRecentTracks(6),
    memories: deps.state.getMemoriesFor(memoryActivity),
    memoryView: deps.state.getMemoryView(memoryActivity),
    currentPlan: deps.state.getCurrentPlan(),
    userMessage,
  }
}
