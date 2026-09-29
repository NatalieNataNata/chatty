import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ConversationIntent, ConversationDecision, PlaybackPermission } from './conversation-intent.js'
import { classifyConversationDecision } from './conversation-intent.js'

const currentDir = dirname(fileURLToPath(import.meta.url))
const examplesPath = resolve(currentDir, 'intent-examples.json')

let examples: Record<string, string[]> = {}
try {
  examples = JSON.parse(readFileSync(examplesPath, 'utf8'))
} catch {
  // fallback to regex classifier
}

const deterministicRules: Array<{ patterns: RegExp[]; intent: ConversationIntent }> = [
  { patterns: [/^(换|切|skip|next|下一首|跳)/i], intent: 'change_music_request' },
  { patterns: [/^(随便选|给我.*惊喜|惊喜一下|surprise\s+me)/i], intent: 'change_music_request' },
  { patterns: [/^安静|别说话|闭嘴|shut up/i], intent: 'silence_request' },
  { patterns: [/^(记住|以后|永远|never|always).*(play|放)/i], intent: 'user_preference_update' },
]

// 独立权限映射：semantic intent → permission（不依赖 regex fallback）
const SEMANTIC_PERMISSIONS: Record<string, PlaybackPermission> = {
  music_request: { canChangeSong: true, canModifyQueue: true, canTriggerPlanner: true },
  change_music_request: { canChangeSong: true, canModifyQueue: true, canTriggerPlanner: true },
  positive_feedback: { canChangeSong: false, canModifyQueue: false, canTriggerPlanner: false },
  ask_current_song_opinion: { canChangeSong: false, canModifyQueue: false, canTriggerPlanner: false },
  casual_chat: { canChangeSong: false, canModifyQueue: false, canTriggerPlanner: false },
}

function semanticSimilarity(a: string, b: string): number {
  const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')
  const x = normalize(a)
  const y = normalize(b)

  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>()
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
    return set
  }
  const bx = bigrams(x)
  const by = bigrams(y)
  const intersection = new Set([...bx].filter((c) => by.has(c)))
  const union = new Set([...bx, ...by])
  const bigramScore = union.size > 0 ? intersection.size / union.size : 0

  const tokensX = new Set(x.split(/\s+/).filter(Boolean))
  const tokensY = new Set(y.split(/\s+/).filter(Boolean))
  const tokenOverlap = [...tokensX].filter((t) => tokensY.has(t)).length
  const tokenScore = Math.min(1, tokenOverlap / Math.max(1, Math.min(tokensX.size, tokensY.size)))

  return bigramScore * 0.55 + tokenScore * 0.45
}

export interface SemanticDecision extends ConversationDecision {
  confidence: number
  fallback: boolean
}

/**
 * Semantic Intent Classifier.
 * 优先使用 character-bigram similarity 匹配 intent examples，
 * 低置信或明确命令 fallback 到 regex classifier。
 */
export function classifyIntentSemantic(message: string): SemanticDecision {
  const input = message.trim().toLowerCase()

  // 1. 确定性规则（高置信模式）
  for (const rule of deterministicRules) {
    for (const pattern of rule.patterns) {
      if (pattern.test(input)) {
        const dec = classifyConversationDecision(message)
        return { ...dec, confidence: 1.0, fallback: false }
      }
    }
  }

  // 2. Semantic similarity matching
  const results: Array<{ intent: string; score: number }> = []
  for (const [intent, intentExamples] of Object.entries(examples)) {
    let maxScore = 0
    for (const example of intentExamples) {
      const score = semanticSimilarity(input, example)
      if (score > maxScore) maxScore = score
    }
    if (maxScore > 0) results.push({ intent, score: maxScore })
  }

  results.sort((a, b) => b.score - a.score)
  const best = results[0]
  const confidence = best?.score ?? 0
  const threshold = 0.28

  if (best && confidence >= threshold) {
    const intent = best.intent as ConversationIntent
    const perm = SEMANTIC_PERMISSIONS[intent] ?? { canChangeSong: false, canModifyQueue: false, canTriggerPlanner: false }
    return { intent, playbackPermission: perm, confidence, fallback: false }
  }

  // 3. Low confidence → fallback to regex classifier
  const fallback = classifyConversationDecision(message)
  return { ...fallback, confidence, fallback: true }
}
