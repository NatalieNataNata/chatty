/**
 * ConversationIntent：对话意图分类（纯规则，不消耗 LLM token）。
 *
 * 与 task intent (classifyIntent) 正交：
 *   classifyIntent → 用户要做什么活动（study/running）
 *   ConversationIntent → 用户在用什么语气和什么意图说话
 *
 * 关键设计：playbackPermission 决定了这次对话是否允许触发播放操作。
 * 这是 Agent 行动边界（Action Boundary）的核心——"讨论音乐" ≠ "控制音乐"。
 */

export type ConversationIntent =
  | 'music_request'            // "来点适合现在的歌" — 主动要新音乐
  | 'change_music_request'     // "换一首""下一首" — 明确要求切歌
  | 'positive_feedback'        // "好听""你怎么这么会选" — 肯定当前播放
  | 'negative_feedback'        // "不好听""不对味" — 不满意当前播放
  | 'ask_current_song_opinion' // "你觉得这歌咋样" — 讨论当前歌曲
  | 'ask_current_song_reason'  // "为什么选这首" — 询问选歌理由
  | 'ask_song_info'            // "这首是谁唱的" — 询问歌曲信息
  | 'casual_chat'              // 闲聊
  // TEMPORARY: sleep_context will be replaced by User Understanding Layer in V4.5
  // Current approach (conversation intent → policy) conflates user state with user intent.
  // V4.5 will split into UserState (activity/energy/mood) and UserIntent (request/feedback/chat).
  | 'sleep_context'            // "失眠""睡不着" — 用户状态表达，V4.5 移除
  | 'user_preference_update'   // "以后别放XXX" — 偏好更新
  | 'silence_request'          // "安静" — 要求沉默

/**
 * 播放操作权限。
 * 决定这次对话是否允许触发 Planner、Music Skill、Queue 修改。
 */
export interface PlaybackPermission {
  canChangeSong: boolean
  canModifyQueue: boolean
  canTriggerPlanner: boolean
}

/**
 * ConversationDecision：对话意图 + 播放权限。
 */
export interface ConversationDecision {
  intent: ConversationIntent
  playbackPermission: PlaybackPermission
}

/** 不允许任何播放操作 */
const NO_PLAYBACK: PlaybackPermission = { canChangeSong: false, canModifyQueue: false, canTriggerPlanner: false }

/** 允许完整的播放控制 */
const FULL_PLAYBACK: PlaybackPermission = { canChangeSong: true, canModifyQueue: true, canTriggerPlanner: true }

const permissionMap: Record<ConversationIntent, PlaybackPermission> = {
  music_request: FULL_PLAYBACK,
  change_music_request: FULL_PLAYBACK,
  positive_feedback: NO_PLAYBACK,
  negative_feedback: NO_PLAYBACK,
  ask_current_song_opinion: NO_PLAYBACK,
  ask_current_song_reason: NO_PLAYBACK,
  ask_song_info: NO_PLAYBACK,
  casual_chat: NO_PLAYBACK,
  sleep_context: NO_PLAYBACK,
  user_preference_update: NO_PLAYBACK,
  silence_request: NO_PLAYBACK,
}

// 模式匹配：高优先级在前
interface IntentPattern {
  intent: ConversationIntent
  patterns: RegExp[]
  priority: number
}

const patterns: IntentPattern[] = [
  { intent: 'silence_request', priority: 100, patterns: [
    /(别说话|闭嘴|shut\s*up|be\s*quiet|stop\s*talking|no\s*talk)/i,
  ]},
  { intent: 'user_preference_update', priority: 90, patterns: [
    /(记住|以后|永远记住|remember|from now on|never play|always)/i,
    /(以后.*不要|以后.*别|永远.*不要|from now on.*(don't|never)|never.*(play|放)|记得|记住)/i,
  ]},
  { intent: 'change_music_request', priority: 80, patterns: [
    /(换一首|下一首|换歌|切歌|来首别的|给我.*惊喜|惊喜一下|随便选|different|skip|next|another\s+song|surprise\s+me)/i,
  ]},
  { intent: 'ask_current_song_opinion', priority: 70, patterns: [
    /(这歌|这首|这首歌|这个歌|这曲子)/i,
    /(咋样|怎么样|觉得|感觉|意见|opinion|what do you think|how do you like|your thoughts)/i,
  ]},
  { intent: 'ask_song_info', priority: 60, patterns: [
    /(谁唱的|谁唱的歌|歌手|背后的故事|这首歌的背景|who sings|who is this by|tell me about this song|about this track)/i,
  ]},
  { intent: 'positive_feedback', priority: 50, patterns: [
    /(怎么这么会选|太会了|好歌|好听|有品位|nice|good song|great pick|perfect|awesome|喜欢这首|这首好)/i,
    /(你懂我|你太懂了|get me|you know what i like|this is fire|banger|vibe|hits different)/i,
    /(我喜欢|喜欢这个|喜欢这种|好听|好听啊|好听极了|这首好听|这个好听|不错|有品位)/i,
  ]},
  { intent: 'negative_feedback', priority: 45, patterns: [
    /(不好听|不行|难听|不合适|不对味|not my vibe|terrible|bad song|not feeling)/i,
  ]},
  { intent: 'ask_current_song_reason', priority: 55, patterns: [
    /(为什么选|为什么放|原因|理由|为什么|explain|why this|why did you|how did you pick|tell me about.*(song|track|choice|this))/i,
    /(说说|说说什么|讲讲|介绍一下|introduce|what.*song|about.*track)/i,
  ]},
  { intent: 'sleep_context', priority: 35, patterns: [
    /(失眠|睡不着|睡不好|凌晨|半夜醒来|很难入睡|can.t sleep|insomnia|wide awake|up all night)/i,
  ]},
  { intent: 'music_request', priority: 30, patterns: [
    /(来点|放|播放|推荐|来首|来一首|点歌|想听|听点|听听|听歌|听下|music|play\b|play some|play something|put on|song|track|radio)/i,
    /(适合|适合现在|什么歌|听什么|recommend|suggestion)/i,
    /(听音乐|放音乐|听首歌|放首歌|放个歌|播音乐|播歌)/i,
  ]},
  // 有优先级低的正向反馈匹配需要避免被 music_request 误抓
  { intent: 'casual_chat', priority: 10, patterns: [
    /.*/, // 兜底，永远不会显式触发
  ]},
]

/**
 * 分类：纯规则，不消耗 LLM token。
 * 返回 ConversationDecision 包含 intent + 播放权限。
 */
export function classifyConversationDecision(message: string): ConversationDecision {
  const input = message.trim()
  if (!input) return { intent: 'casual_chat', playbackPermission: NO_PLAYBACK }

  // 按优先级从高到低匹配
  const sorted = [...patterns].sort((a, b) => b.priority - a.priority)

  for (const { intent, patterns: regexps } of sorted) {
    // sleep_context 与 music_request 共存时 → music_request 优先
    if (intent === 'sleep_context') {
      const hasMusic = /** @type {RegExp[]} */(patterns.find(p => p.intent === 'music_request')?.patterns ?? [])
        .some(pat => pat.test(input))
      if (hasMusic) return { intent: 'music_request', playbackPermission: FULL_PLAYBACK }
    }

    // ask_current_song_opinion 需要两个条件都满足
    if (intent === 'ask_current_song_opinion') {
      const hasSongRef = /(这歌|这首|这首歌|这个歌|这曲子|this song|this track|this one)/i.test(input)
      const hasAskOpinion = /(咋样|怎么样|觉得|感觉|意见|opinion|what do you think|how do you like|your thoughts)/i.test(input)
      if (hasSongRef && hasAskOpinion) {
        return { intent, playbackPermission: permissionMap[intent] }
      }
      continue
    }

    // ask_song_info 也需要两个条件
    if (intent === 'ask_song_info') {
      const hasSongRef = /(这歌|这首|这首歌|这个歌|这曲子|this song|this track|this one)/i.test(input)
      const hasAskInfo = /(谁唱的|谁唱的|歌手|背景|who sings|who is this|about|info|tell me)/i.test(input)
      if (hasSongRef && hasAskInfo) {
        return { intent, playbackPermission: permissionMap[intent] }
      }
      continue
    }

    for (const pattern of regexps) {
      if (pattern.test(input)) {
        return { intent, playbackPermission: permissionMap[intent] }
      }
    }
  }

  return { intent: 'casual_chat', playbackPermission: NO_PLAYBACK }
}

/** 向后兼容：只返回 intent 字符串 */
export function classifyConversationIntent(message: string): ConversationIntent {
  return classifyConversationDecision(message).intent
}
