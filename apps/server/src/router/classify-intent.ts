import type { Activity, IntentResult } from '@chatty/shared'

function detectActivity(input: string): Activity {
  if (/(学习|写作业|看书|复习|敲代码|工作|study|coding|focus|work)/.test(input)) return 'study'
  if (/(跑步|跑起来|健身|运动|训练|running|run\b|workout|gym)/.test(input)) return 'running'
  if (/(通勤|开车|上班路上|下班路上|commute|drive)/.test(input)) return 'commute'
  if (/(睡觉|助眠|入睡|sleep|bedtime)/.test(input)) return 'sleep'
  if (/(放松|休息|发呆|relax|chill)/.test(input)) return 'relax'
  return 'general'
}

function detectDuration(input: string, activity: Activity) {
  const chinese = input.match(/(\d+)\s*(分钟|小时)/)
  const english = input.match(/(\d+)\s*(min|minute|minutes|hour|hours)/)
  const match = chinese ?? english
  if (match) {
    const amount = Number(match[1])
    return /(小时|hour)/.test(match[2]) ? amount * 60 : amount
  }
  if (activity === 'study') return 60
  if (activity === 'running') return 45
  return null
}

export function classifyIntent(message: string): IntentResult {
  const input = message.toLowerCase()
  const activity = detectActivity(input)
  const durationMin = detectDuration(input, activity)
  const preference = /(记住|remember|偏好|喜欢|不喜欢|不要放|别放|永远|以后|never)/.test(input)
  const changeTrack = /(换|切|下一首|跳过|惊喜|随便选|different|another|switch|skip|next|surprise)/.test(input)
  const explain = /(为什么|原因|介绍|explain|why.*(song|track)|tell me about)/.test(input)
  const playback = /(暂停|继续|停止|音量|pause|resume|stop|volume)/.test(input)
  const music = /(歌|音乐|播放|来点|电台|听|music|radio|soundtrack|song|track|playlist|play\b|listen|hear|recommend)/.test(input)
  const kind = preference
    ? 'preference'
    : changeTrack
      ? 'change_track'
      : explain
        ? 'explain_choice'
        : playback
          ? 'playback_control'
          : music || activity !== 'general'
            ? 'start_radio'
            : 'conversation'

  return {
    kind,
    activity,
    mood: /(难过|sad|低落)/.test(input) ? 'low' : /(开心|兴奋|happy|excited)/.test(input) ? 'bright' : 'open',
    energy: activity === 'running' ? 'high' : activity === 'study' || activity === 'sleep' ? 'low' : 'medium',
    durationMin,
    lyricDensity: activity === 'study' || activity === 'sleep' ? 'low' : 'any',
    djFrequency: activity === 'study' || activity === 'sleep' ? 'minimal' : activity === 'running' ? 'active' : 'balanced',
    confidence: activity !== 'general' || kind !== 'conversation' ? 0.88 : 0.68,
  }
}
