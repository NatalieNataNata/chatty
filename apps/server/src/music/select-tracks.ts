import type { IntentResult, RadioPlan, Track } from '@chatty/shared'

export interface MusicQueryConstraint {
  artist?: string
  strict?: boolean
}

export interface SessionMusicFeedback {
  penalizedArtists?: Set<string>
  blockedArtists?: Set<string>
}

export function isSurpriseMusicRequest(message: string) {
  return /(给我.*惊喜|惊喜一下|随便选|意想不到|surprise\s+me)/i.test(message)
}

export function excludeKnownTracks(candidates: Track[], knownTracks: Track[]) {
  const known = new Set(knownTracks.map((track) => `${track.title.toLowerCase()}|${track.artist.toLowerCase()}`))
  return candidates.filter((track) => !known.has(`${track.title.toLowerCase()}|${track.artist.toLowerCase()}`))
}

export function buildMusicDiscoveryQuery(
  userMessage: string,
  intent: IntentResult,
  plan: RadioPlan | null,
  recentTracks: Track[],
  requestedQuery?: string,
) {
  void recentTracks
  const requested = requestedQuery?.trim()
  const vagueRequest = /(适合|来点|随便|推荐|现在|学习|工作|跑步|通勤|睡觉|放松|歌单|电台|something|recommend|study|work|running|sleep|mood)/i.test(userMessage)
  const words = requested?.split(/\s+/) ?? []
  const titleLike = Boolean(requested && words.length <= 5 && words.every((word) => /^[A-Z][a-z'’-]*$/.test(word) || /^(a|an|and|of|the|to|in|on)$/i.test(word)))
  if (vagueRequest && titleLike) {
    return plan?.segments[plan.currentSegmentIndex]?.query
      ?? [intent.mood, intent.activity === 'general' ? '' : intent.activity, intent.energy, intent.lyricDensity === 'low' ? 'low vocals' : '', 'music'].filter(Boolean).join(' ')
  }
  return requested || userMessage.trim()
}

function titleFamily(title: string) {
  return title
    .toLowerCase()
    .replace(/[（(\[].*?[）)\]]/g, ' ')
    .replace(/\b(feat|ft|remix|mix|version|cover|edit)\b.*$/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join(' ')
}

export function diversifyTracks(
  candidates: Track[],
  recentTracks: Track[],
  limit = 3,
  constraint?: MusicQueryConstraint,
  feedback?: SessionMusicFeedback,
) {
  const recentIds = new Set(recentTracks.map((track) => track.id))
  const recentTitles = new Set(recentTracks.map((track) => titleFamily(track.title)))
  const selected: Track[] = []
  const selectedTitles = new Set<string>()
  const selectedArtists = new Set<string>()

  // Hard constraint: 如果指定了 strict artist，只选该 artist 的歌曲
  if (constraint?.artist && constraint?.strict) {
    const artistLower = constraint.artist.toLowerCase()
    const filtered = candidates.filter((track) => track.artist.toLowerCase().includes(artistLower) || artistLower.includes(track.artist.toLowerCase()))
    for (const track of filtered) {
      const family = titleFamily(track.title)
      if (recentIds.has(track.id) || recentTitles.has(family)) continue
      if (selectedTitles.has(family)) continue
      if (selectedArtists.has(track.artist.toLowerCase())) continue
      selected.push(track)
      selectedTitles.add(family)
      selectedArtists.add(track.artist.toLowerCase())
      if (selected.length >= limit) break
    }
    // 如果 strict artist 的歌曲不够 limit，少放也不要填其他 artist
    return selected
  }

  const blockedArtists = feedback?.blockedArtists ?? new Set<string>()
  const penalizedArtists = feedback?.penalizedArtists ?? new Set<string>()
  const orderedCandidates = [...candidates].sort((left, right) => {
    const leftPenalty = penalizedArtists.has(left.artist.toLowerCase()) ? 1 : 0
    const rightPenalty = penalizedArtists.has(right.artist.toLowerCase()) ? 1 : 0
    return leftPenalty - rightPenalty
  })
  const sessionFiltered = orderedCandidates.filter((track) => !blockedArtists.has(track.artist.toLowerCase()))
  const pool = sessionFiltered.length >= Math.min(limit, 3) ? sessionFiltered : orderedCandidates
  const passes = [
    (track: Track) => !recentIds.has(track.id) && !recentTitles.has(titleFamily(track.title)),
    (track: Track) => !recentIds.has(track.id),
    () => true,
  ]

  for (const pass of passes) {
    for (const track of pool) {
      const family = titleFamily(track.title)
      const artist = track.artist.toLowerCase()
      if (!pass(track) || selected.some((item) => item.id === track.id)) continue
      if (selectedTitles.has(family) || selectedArtists.has(artist)) continue
      selected.push(track)
      selectedTitles.add(family)
      selectedArtists.add(artist)
      if (selected.length === limit) return selected
    }
  }

  return selected
}

export function feedbackFromSkips(events: Array<{ type: string; track: { artist: string } | null }>): SessionMusicFeedback {
  const counts = new Map<string, number>()
  for (const event of events) {
    if (event.type !== 'skip' || !event.track) continue
    const artist = event.track.artist.toLowerCase()
    counts.set(artist, (counts.get(artist) ?? 0) + 1)
  }
  return {
    penalizedArtists: new Set([...counts].filter(([, count]) => count >= 1).map(([artist]) => artist)),
    blockedArtists: new Set([...counts].filter(([, count]) => count >= 2).map(([artist]) => artist)),
  }
}

export function deprioritizeQueueAfterSkip(queue: Track[], skipped: Track) {
  const currentIndex = queue.findIndex((track) => track.id === skipped.id)
  if (currentIndex < 0) return queue
  const rotated = [...queue.slice(currentIndex), ...queue.slice(0, currentIndex)]
  const remaining = rotated.slice(1)
  const skippedArtist = skipped.artist.toLowerCase()
  const skippedAlbum = skipped.album?.toLowerCase()
  const similar = (track: Track) => track.artist.toLowerCase() === skippedArtist
    || Boolean(skippedAlbum && track.album?.toLowerCase() === skippedAlbum)
  return [rotated[0], ...remaining.filter((track) => !similar(track)), ...remaining.filter(similar)]
}
