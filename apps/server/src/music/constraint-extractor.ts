import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const currentDir = dirname(fileURLToPath(import.meta.url))
const aliasPath = resolve(currentDir, 'artist-alias.json')

// 加载别名映射
let aliasMap: Record<string, string> = {}
try {
  aliasMap = JSON.parse(readFileSync(aliasPath, 'utf8'))
} catch {
  // 文件不存在时使用空映射
}

export interface ExtractedConstraint {
  artist?: string
  strict: boolean
}

/**
 * 从用户消息中提取音乐约束。
 *
 * 先通过别名映射匹配，再通过正则提取。
 * 不依赖 LLM，纯规则驱动。
 */
export function extractMusicConstraint(message: string): ExtractedConstraint {
  const input = message.trim().toLowerCase()

  // 1. 尝试别名映射匹配（全文匹配）
  for (const [alias, canonical] of Object.entries(aliasMap)) {
    if (input.includes(alias.toLowerCase())) {
      return { artist: canonical, strict: true }
    }
  }

  // 2. 正则提取：中文模式
  const chinesePatterns = [
    /(?:来点|放点|来首|放首|点一首|播放|我想听|想听)\s*(.+?)的?(?:歌|音乐|歌曲)/,
    /(?:来点|放点|来首|放首|点一首|播放)\s+([A-Za-z一-鿿]{2,}(?:\s[A-Za-z一-鿿]+)?)(?:$|\s|的)/,
  ]
  for (const pattern of chinesePatterns) {
    const match = input.match(pattern)
    if (match) {
      const extracted = match[1].trim()
      // 排除通用词（适合、轻柔、放松等）
      if (isGenericTerm(extracted)) continue
      // 二次查找别名
      for (const [alias, canonical] of Object.entries(aliasMap)) {
        if (extracted.includes(alias.toLowerCase())) {
          return { artist: canonical, strict: true }
        }
      }
      // 如果提取到的词看起来像人名/歌手名（首字母大写英文或2-4个中文字符），直接使用
      if (looksLikeArtistName(extracted)) {
        return { artist: capitalizeName(extracted), strict: true }
      }
    }
  }

  // 3. 正则提取：英文模式
  const englishPatterns = [
    /(?:play|hear|listen to|some|put on)\s+(.+?)(?:songs|music|song|'s|$)/i,
    /(.+?)(?:songs|music|'s music)\s*(?:for|to|please|$)/i,
  ]
  for (const pattern of englishPatterns) {
    const match = input.match(pattern)
    if (match) {
      const extracted = match[1].trim()
      if (isGenericTerm(extracted)) continue
      for (const [alias, canonical] of Object.entries(aliasMap)) {
        if (extracted.includes(alias.toLowerCase())) {
          return { artist: canonical, strict: true }
        }
      }
      // 如果看起来像人名（首字母大写的单词组合）
      if (/^[A-Z][a-z]*(?:\s[A-Z][a-z]*)*$/.test(extracted)) {
        return { artist: extracted, strict: true }
      }
    }
  }

  return { strict: false }
}

function isGenericTerm(term: string): boolean {
  const genericWords = ['适合', '轻柔', '放松', '安静', '舒缓', '燃', 'high', '轻缓', 'soft', 'chill', 'calm', 'night', 'mood', 'something', 'music', 'song', 'songs', '轻音乐', '纯音乐', '温柔']
  const lower = term.toLowerCase()
  return genericWords.some((w) => lower.includes(w))
}

function looksLikeArtistName(term: string): boolean {
  // 中文歌手名通常是2-4个字
  if (/^[\u4e00-\u9fff]{2,4}$/.test(term)) return true
  // 英文歌手名：首字母大写的单词组合
  if (/^[A-Za-z]+(?:\s[A-Za-z]+)*$/.test(term) && term.length > 1) return true
  return false
}

function capitalizeName(name: string): string {
  // 对于英文名：首字母大写
  if (/^[a-zA-Z]/.test(name)) {
    return name.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  }
  // 中文名保持不变
  return name
}
