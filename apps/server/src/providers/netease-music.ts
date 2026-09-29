import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import neteaseApiPackage from 'NeteaseCloudMusicApi'
import type { SoundQualityType } from 'NeteaseCloudMusicApi'
import type { Track } from '@chatty/shared'
import { dataDir } from '../paths.js'
import type { ContextBundle, MusicProvider, MusicSearchOptions } from '../types.js'

const sessionFile = resolve(dataDir, 'netease-session.json')
const { cloudsearch, login_qr_check, login_qr_create, login_qr_key, playlist_track_all, song_url_v1, user_account, user_playlist } = neteaseApiPackage
const neteaseProxy = process.env.NETEASE_PROXY ?? process.env.FISH_AUDIO_PROXY ?? process.env.HTTPS_PROXY

function requestOptions<T extends object>(options: T): T & { proxy?: string } {
  return { ...options, ...(neteaseProxy ? { proxy: neteaseProxy } : {}) }
}

interface NeteaseSession {
  cookie: string
  connectedAt: string
}

interface NeteaseSong {
  id: number
  name: string
  dt?: number
  ar?: Array<{ name: string }>
  al?: { name?: string; picUrl?: string }
}

export interface NeteasePlaylistSummary {
  id: string
  name: string
  trackCount: number
  coverUrl?: string
}

async function readSession(): Promise<NeteaseSession | null> {
  try {
    return JSON.parse(await readFile(sessionFile, 'utf8')) as NeteaseSession
  } catch {
    return null
  }
}

export class NeteaseMusicProvider implements MusicProvider {
  async getConnectionStatus() {
    return { connected: Boolean(await readSession()) }
  }

  async startQrLogin() {
    const keyResponse = await login_qr_key(requestOptions({}))
    const key = (keyResponse.body as { data?: { unikey?: string } }).data?.unikey
    if (!key) throw new Error('Netease did not return a QR login key.')

    const qrResponse = await login_qr_create(requestOptions({ key, qrimg: true }))
    const qrImage = (qrResponse.body as { data?: { qrimg?: string } }).data?.qrimg
    if (!qrImage) throw new Error('Netease did not return a QR image.')

    return { key, qrImage }
  }

  async checkQrLogin(key: string) {
    const response = await login_qr_check(requestOptions({ key }))
    const body = response.body as { code?: number; message?: string; cookie?: string }

    if (body.code === 803 && body.cookie) {
      await mkdir(dataDir, { recursive: true })
      await writeFile(sessionFile, JSON.stringify({ cookie: body.cookie, connectedAt: new Date().toISOString() }, null, 2), {
        mode: 0o600,
      })
      return { status: 'connected' as const, message: 'Netease Music connected.' }
    }

    if (body.code === 800) return { status: 'expired' as const, message: 'QR code expired.' }
    if (body.code === 802) return { status: 'scanned' as const, message: 'Confirm login on your phone.' }
    return { status: 'waiting' as const, message: body.message ?? 'Waiting for scan.' }
  }

  async getUserPlaylists(): Promise<NeteasePlaylistSummary[]> {
    const session = await readSession()
    if (!session) throw new Error('Netease Music is not connected.')

    const accountResponse = await user_account(requestOptions({ cookie: session.cookie }))
    const accountBody = accountResponse.body as { account?: { id?: number }; profile?: { userId?: number } }
    const userId = accountBody.account?.id ?? accountBody.profile?.userId
    if (!userId) throw new Error('Netease did not return the connected account.')

    const response = await user_playlist(requestOptions({ uid: userId, limit: 1000, offset: 0, cookie: session.cookie }))
    const playlists = (response.body as {
      playlist?: Array<{ id: number; name: string; trackCount?: number; coverImgUrl?: string }>
    }).playlist ?? []

    return playlists.map((playlist) => ({
      id: String(playlist.id),
      name: playlist.name,
      trackCount: playlist.trackCount ?? 0,
      coverUrl: playlist.coverImgUrl,
    }))
  }

  async getPlaylistTracks(id: string, playlistName: string) {
    const session = await readSession()
    if (!session) throw new Error('Netease Music is not connected.')

    const tracks: NeteaseSong[] = []
    const pageSize = 500
    for (let offset = 0; offset < 10_000; offset += pageSize) {
      const response = await playlist_track_all(requestOptions({ id, limit: pageSize, offset, cookie: session.cookie }))
      const page = (response.body as { songs?: NeteaseSong[] }).songs ?? []
      tracks.push(...page)
      if (page.length < pageSize) break
    }

    return tracks.map((song) => ({
      title: song.name,
      artist: song.ar?.map((artist) => artist.name).join(' / ') || 'Unknown artist',
      album: song.al?.name,
      playlist: playlistName,
      source: '网易云音乐',
    }))
  }

  private async resolveSong(song: NeteaseSong, cookie: string, personal = false): Promise<Track | null> {
    // 音质降级策略：exhigh → higher → standard，任意成功即返回
    const levels = ['exhigh', 'higher', 'standard'] as const
    let audioUrl: string | undefined
    let lastError: string | undefined
    for (const level of levels) {
      try {
        const stream = await song_url_v1(requestOptions({ id: song.id, level: level as SoundQualityType, cookie }))
        const data = (stream.body as { data?: Array<{ url?: string; time?: number }> }).data
        audioUrl = data?.[0]?.url
        if (audioUrl && audioUrl !== '') break
        lastError = `level=${level} returned no url`
      } catch (error) {
        lastError = `level=${level} failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    if (!audioUrl) {
      console.error(`[Netease] resolveSong failed for "${song.name}" (id=${song.id}): ${lastError ?? 'unknown'}`)
      return null
    }

    return {
      id: `netease-${song.id}`,
      title: song.name,
      artist: song.ar?.map((artist) => artist.name).join(' / ') || 'Unknown artist',
      album: song.al?.name,
      artwork: song.al?.picUrl,
      audioUrl,
      durationSec: Math.max(1, Math.round((song.dt ?? 0) / 1000)),
      moodTags: personal ? ['netease', 'personal-library'] : ['netease'],
    }
  }

  private async findExactCandidate(title: string, artist: string, cookie: string) {
    const result = await cloudsearch(requestOptions({ keywords: `${title} ${artist}`, type: 1, limit: 6, cookie }))
    const songs = (result.body as { result?: { songs?: NeteaseSong[] } }).result?.songs ?? []
    const normalizedTitle = title.toLowerCase().replace(/\s+/g, '')
    const normalizedArtist = artist.toLowerCase().replace(/\s+/g, '')
    return songs.find((song) => {
      const songTitle = song.name.toLowerCase().replace(/\s+/g, '')
      const songArtists = (song.ar ?? []).map((item) => item.name).join('/').toLowerCase().replace(/\s+/g, '')
      return songTitle === normalizedTitle && (songArtists.includes(normalizedArtist) || normalizedArtist.includes(songArtists))
    }) ?? songs.find((song) => song.name.toLowerCase().replace(/\s+/g, '') === normalizedTitle)
  }

  async search(query: string, context: ContextBundle, options?: MusicSearchOptions): Promise<Track[]> {
    const session = await readSession()
    if (!session) throw new Error('Netease Music is not connected. Connect your music account first.')

    try {
      // Phase 1: 精确匹配 preferred candidates（来自 local library）
      // Netease becomes unreliable when a full queue fans out into many searches at once.
      // Resolve in small batches, and let one failed candidate fall through instead of
      // failing the whole programme action.
      const personalSongs: NeteaseSong[] = []
      const candidates = (options?.preferredCandidates ?? []).slice(0, 18)
      for (let index = 0; index < candidates.length; index += 3) {
        const batch = candidates.slice(index, index + 3)
        const resolved = await Promise.all(batch.map(async (candidate) => {
          try {
            return await this.findExactCandidate(candidate.title, candidate.artist, session.cookie)
          } catch (error) {
            console.error(`[Netease] candidate lookup failed for "${candidate.title}": ${error instanceof Error ? error.message : String(error)}`)
            return null
          }
        }))
        personalSongs.push(...resolved.filter((song): song is NeteaseSong => Boolean(song)))
      }
      const personalTracks = (await Promise.all(personalSongs.map((song) => this.resolveSong(song, session.cookie, true))))
        .filter((track): track is Track => Boolean(track))

      const unique = new Map<string, Track>()
      for (const track of personalTracks) unique.set(track.id, track)

      // Phase 2: 如果 strict artist 且候选不足，直接按 artist 搜索补充
      const strictArtist = options?.strictArtist
      if (strictArtist && unique.size < 12) {
        const result = await cloudsearch(requestOptions({ keywords: strictArtist, type: 1, limit: 30, cookie: session.cookie }))
        const songs = (result.body as { result?: { songs?: NeteaseSong[] } }).result?.songs ?? []
        const extraSongs = (await Promise.all(
          songs.slice(0, 12 - unique.size).map((song) => this.resolveSong(song, session.cookie)),
        )).filter((track): track is Track => Boolean(track))
        for (const track of [...extraSongs, ...personalTracks]) unique.set(track.id, track)
      }

      const tracks = [...unique.values()].slice(0, 18)
      if (!tracks.length) throw new Error('None of the selected tracks from your personal library could be played on Netease Music.')
      return tracks
    } catch (error) {
      throw new Error(error instanceof Error ? `Netease Music search failed: ${error.message}` : 'Netease Music search failed.')
    }
  }
}
