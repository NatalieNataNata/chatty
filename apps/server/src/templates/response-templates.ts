/**
 * ResponseTemplateRegistry：统一管理所有固定话术模板。
 *
 * 长期目标：所有非 LLM 生成的响应文本都从这里获取。
 * 短期目标：将 transitionLine / fallbackLine / intro 等硬编码字符串集中管理。
 */

export interface ResponseTemplate {
  id: string
  intent: string
  conditions?: {
    activity?: string[]
  }
  text: string
}

/**
 * 获取过渡话术。
 * 当 segment 推进时，DJ 说一句简短的过渡语。
 */
export function getTransitionText(activity: string, segmentLabel?: string): string {
  const label = segmentLabel?.toLowerCase() ?? ''
  if (activity === 'running') {
    return `Moving into ${label}. Let the rhythm carry the pace.`
  }
  if (activity === 'study') {
    return `Moving into ${label}. Keeping the room quiet for focus.`
  }
  return `Next up: ${label}. Let's ease into it.`
}

/**
 * 获取 DJ 播报降级文本（当 LLM 未能生成话术时）。
 * 这些文本不包含具体上下文，只做最低限度的过渡。
 */
export function getDjFallbackText(mode: string, reason?: string): string {
  switch (mode) {
    case 'transition':
      return 'Next track coming up.'
    case 'recovery':
      return reason
        ? `Adjusting the feel. ${reason}`
        : 'Let\'s try a different direction.'
    default:
      return 'Here\'s the next part of the set.'
  }
}
