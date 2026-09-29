import type { Skill, SkillResult, SkillContext } from '../skill.js'
import { getDjFallbackText } from '../../templates/response-templates.js'

export interface DjSpeechInput {
  mode: 'intro' | 'transition' | 'recovery'
  text?: string
  context?: { currentSegment?: string; reason?: string; userMood?: string }
}

export interface DjSpeechOutput { text: string }

export class DjSpeechGeneratorSkill implements Skill<DjSpeechInput, DjSpeechOutput> {
  name = 'dj_speech_generator'
  description = 'Generate DJ speech lines for various programme moments: intro, transition, and recovery.'
  tags = ['speech', 'dj', 'communication']
  inputSchema = { mode: '"intro" | "transition" | "recovery"', text: 'string (optional)', context: 'object (optional)' }

  async execute(input: DjSpeechInput, _context: SkillContext): Promise<SkillResult<DjSpeechOutput>> {
    const text = input.text ?? getDjFallbackText(input.mode, input.context?.reason)
    return { status: 'success', data: { text } }
  }
}
