import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { dataDir } from '../paths.js'

export interface LibraryTrack {
  title: string
  artist: string
  album?: string
  playlist?: string
  source?: string
}

interface LibraryFile {
  name: string
  importedAt: string
  trackCount: number
}

interface MusicLibrary {
  tracks: LibraryTrack[]
  files: LibraryFile[]
}

const libraryFile = resolve(dataDir, 'music-library.json')
const emptyLibrary: MusicLibrary = { tracks: [], files: [] }

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function artistName(value: unknown): string | undefined {
  if (typeof value === 'string') return text(value)
  if (Array.isArray(value)) {
    const names = value.map((item) => (typeof item === 'string' ? item : text((item as { name?: unknown })?.name))).filter(Boolean)
    return names.join(' / ') || undefined
  }
  return text((value as { name?: unknown })?.name)
}

function collectJson(value: unknown, tracks: LibraryTrack[], inheritedPlaylist?: string, inheritedSource?: string) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectJson(item, tracks, inheritedPlaylist, inheritedSource))
    return
  }
  if (!value || typeof value !== 'object') return

  const item = value as Record<string, unknown>
  const title = text(item.title) ?? text(item.trackName) ?? (item.artist || item.artists || item.ar ? text(item.name) : undefined)
  const artist = artistName(item.artist) ?? artistName(item.artists) ?? artistName(item.ar) ?? text(item.singer)
  const albumValue = item.album ?? item.al
  const album = typeof albumValue === 'string' ? text(albumValue) : text((albumValue as { name?: unknown })?.name)
  const source = text(item.source) ?? text(item.platform) ?? inheritedSource

  if (title && artist) tracks.push({ title, artist, album, playlist: inheritedPlaylist, source })

  const playlist = text(item.playlist) ?? (Array.isArray(item.tracks) || Array.isArray(item.songs) ? text(item.name) : undefined) ?? inheritedPlaylist
  for (const key of ['tracks', 'songs', 'items', 'data', 'playlists']) {
    if (item[key]) collectJson(item[key], tracks, playlist, source)
  }
}

function parseCsvLine(line: string) {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"' && line[index + 1] === '"') {
      cell += '"'
      index += 1
    } else if (char === '"') quoted = !quoted
    else if (char === ',' && !quoted) {
      cells.push(cell.trim())
      cell = ''
    } else cell += char
  }
  cells.push(cell.trim())
  return cells
}

function parseCsv(content: string): LibraryTrack[] {
  const rows = content.split(/\r?\n/).filter(Boolean).map(parseCsvLine)
  const headers = (rows.shift() ?? []).map((header) => header.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, ''))
  const find = (...names: string[]) => headers.findIndex((header) => names.includes(header))
  const titleIndex = find('title', 'name', 'track', 'song', '歌曲', '歌名')
  const artistIndex = find('artist', 'artists', 'singer', '歌手', '艺人')
  const albumIndex = find('album', '专辑')
  const playlistIndex = find('playlist', '歌单')
  const sourceIndex = find('source', 'platform', '平台', '来源')

  return rows
    .map((row) => ({
      title: row[titleIndex]?.trim(),
      artist: row[artistIndex]?.trim(),
      album: albumIndex >= 0 ? row[albumIndex]?.trim() : undefined,
      playlist: playlistIndex >= 0 ? row[playlistIndex]?.trim() : undefined,
      source: sourceIndex >= 0 ? row[sourceIndex]?.trim() : undefined,
    }))
    .filter((track) => Boolean(track.title && track.artist))
    .map((track) => ({ ...track, title: track.title!, artist: track.artist! }))
}

function parseText(content: string): LibraryTrack[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*\d.\s]+/, ''))
    .filter(Boolean)
    .map((line) => {
      const parts = line.includes('\t') ? line.split('\t') : line.split(/\s+[—–-]\s+/)
      return { title: parts[0]?.trim(), artist: parts.slice(1).join(' - ').trim() }
    })
    .filter((track) => Boolean(track.title && track.artist))
    .map((track) => ({ title: track.title!, artist: track.artist! }))
}

async function readLibrary(): Promise<MusicLibrary> {
  try {
    return JSON.parse(await readFile(libraryFile, 'utf8')) as MusicLibrary
  } catch {
    return emptyLibrary
  }
}

export async function importPlaylistFile(name: string, content: string) {
  const extension = name.toLowerCase().split('.').pop()
  let imported: LibraryTrack[] = []

  if (extension === 'json') collectJson(JSON.parse(content), imported)
  else if (extension === 'csv') imported = parseCsv(content)
  else imported = parseText(content)

  return importLibraryTracks(name, imported)
}

export async function importLibraryTracks(name: string, imported: LibraryTrack[]) {
  const library = await readLibrary()
  const unique = new Map<string, LibraryTrack>()
  for (const track of [...library.tracks, ...imported]) unique.set(`${track.title.toLowerCase()}|${track.artist.toLowerCase()}`, track)
  const next: MusicLibrary = {
    tracks: [...unique.values()],
    files: [...library.files.filter((file) => file.name !== name), { name, importedAt: new Date().toISOString(), trackCount: imported.length }],
  }

  await mkdir(dataDir, { recursive: true })
  await writeFile(libraryFile, JSON.stringify(next, null, 2), { mode: 0o600 })
  return { imported: imported.length, total: next.tracks.length, files: next.files }
}

export async function getLibrarySummary() {
  const library = await readLibrary()
  const sources = [...new Set(library.tracks.map((track) => track.source).filter(Boolean))]
  return { total: library.tracks.length, files: library.files, sources }
}

function hash(value: string) {
  let result = 0
  for (const character of value) result = ((result << 5) - result + character.charCodeAt(0)) | 0
  return Math.abs(result)
}

export async function getLibraryContext(query = '') {
  const library = await readLibrary()
  if (!library.tracks.length) return ''
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 1)
  const scored = library.tracks
    .map((track) => {
      const haystack = `${track.title} ${track.artist} ${track.album ?? ''} ${track.playlist ?? ''}`.toLowerCase()
      return { track, score: terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0) }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 40)
    .map((entry) => entry.track)
  const sampleSize = 140
  const offset = hash(query) % library.tracks.length
  const step = Math.max(1, Math.floor(library.tracks.length / sampleSize))
  const sampled = Array.from({ length: Math.min(sampleSize, library.tracks.length) }, (_, index) => library.tracks[(offset + index * step) % library.tracks.length])
  const candidates = new Map<string, LibraryTrack>()
  for (const track of [...scored, ...sampled]) candidates.set(`${track.title.toLowerCase()}|${track.artist.toLowerCase()}`, track)
  const playlistCounts = new Map<string, number>()
  for (const track of library.tracks) {
    const playlist = track.playlist ?? 'Unsorted'
    playlistCounts.set(playlist, (playlistCounts.get(playlist) ?? 0) + 1)
  }
  return JSON.stringify({
    importedFiles: library.files,
    playlists: [...playlistCounts].map(([name, trackCount]) => ({ name, trackCount })),
    candidateTracks: [...candidates.values()],
    totalTracks: library.tracks.length,
    note: 'candidateTracks is a rotating, request-aware shortlist from the full personal library. Prefer real matches from it; use semantic search when none fit.',
  })
}

export async function searchLibrary(query: string, limit = 20) {
  const library = await readLibrary()
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 1)
  return library.tracks
    .map((track) => {
      const haystack = `${track.title} ${track.artist} ${track.album ?? ''} ${track.playlist ?? ''} ${track.source ?? ''}`.toLowerCase()
      return { track, score: terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0) }
    })
    .filter((entry) => entry.score > 0 || terms.length === 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.track)
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

/**
 * The AI may suggest a title from the visible library shortlist. This resolver
 * is the final gate: it never lets an invented or platform-wide result through.
 */
export async function resolvePersonalCandidates(
  preferred: Array<{ title: string; artist: string }>,
  query: string,
  limit = 18,
  strictArtist?: string,
  excluded: Array<{ title: string; artist: string }> = [],
) {
  const library = await readLibrary()
  if (!library.tracks.length) return []

  const excludedKeys = new Set(excluded.map((track) => `${normalize(track.title)}|${normalize(track.artist)}`))
  const picked = new Map<string, LibraryTrack>()
  for (const candidate of preferred) {
    const title = normalize(candidate.title)
    const artist = normalize(candidate.artist)
    const match = library.tracks.find((track) => {
      const trackTitle = normalize(track.title)
      const trackArtist = normalize(track.artist)
      return trackTitle === title && (trackArtist.includes(artist) || artist.includes(trackArtist))
    })
    const key = match ? `${normalize(match.title)}|${normalize(match.artist)}` : ''
    if (match && !excludedKeys.has(key)) picked.set(key, match)
  }

  // 如果有 strict artist 约束：将本地库中该 artist 的所有歌曲也加入候选
  if (strictArtist) {
    const artistLower = normalize(strictArtist)
    for (const track of library.tracks) {
      if (picked.size >= limit) break
      const trackArtist = normalize(track.artist)
      if (trackArtist.includes(artistLower) || artistLower.includes(trackArtist)) {
        const key = `${normalize(track.title)}|${trackArtist}`
        if (!picked.has(key) && !excludedKeys.has(key)) picked.set(key, track)
      }
    }
  }

  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 1)
  const ranked = library.tracks
    .map((track) => {
      const haystack = `${track.title} ${track.artist} ${track.album ?? ''} ${track.playlist ?? ''}`.toLowerCase()
      return { track, score: terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0) }
    })
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.track)

  // A semantic request such as "music for coding" may not appear in metadata.
  // The model-selected tracks win; this rotating personal-only sample fills gaps.
  const offset = hash(query) % library.tracks.length
  const fallback = Array.from({ length: library.tracks.length }, (_, index) => library.tracks[(offset + index) % library.tracks.length])
  for (const track of [...ranked, ...fallback]) {
    if (picked.size >= limit) break
    const key = `${normalize(track.title)}|${normalize(track.artist)}`
    if (!excludedKeys.has(key)) picked.set(key, track)
  }
  return [...picked.values()].slice(0, limit).map(({ title, artist }) => ({ title, artist }))
}
