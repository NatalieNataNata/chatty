import type { StateStore, Broadcaster } from '../types.js'
import type { ContextBundle } from '../types.js'

/**
 * 技能执行上下文。
 * 包含 Agent 运行时当前可用的全部状态，供 Skill 在执行时参考。
 */
export interface SkillContext {
  context: ContextBundle
  activity: string
  segmentId?: string
  state?: StateStore
  broadcaster?: Broadcaster
}

/**
 * 技能执行结果。
 * 由 ActionResult 演化而来，增加了 recoveryHints 供 DecisionEngine 降级参考。
 */
export interface SkillResult<T = unknown> {
  status: 'success' | 'partial' | 'failed'
  data?: T
  error?: {
    code: string
    message: string
  }
  recoveryHints?: string[]
}

/**
 * 技能（Skill）：Agent 能力的最小可管理单元。
 *
 * 每个 Skill 封装一个独立能力：音乐搜索、队列构建、DJ 播报等。
 * ActionExecutor 通过 SkillRegistry 按名称查找并调用 Skill。
 *
 * V2 的核心变化：能力从 ActionExecutor 的 switch 语句
 * 变成可注册、可查询、可替换的 First-class Citizen。
 */
export interface Skill<TInput = any, TOutput = any> {
  /** 唯一标识，例如 "music_queue_builder" */
  name: string
  /** 人类可读的描述 */
  description: string
  /** 能力标签，用于未来 Skill Router 检索 */
  tags: string[]
  /** 输入 Schema 描述（用于 Planner / Router 理解能力） */
  inputSchema?: Record<string, string>
  /** 执行入口 */
  execute(input: TInput, context: SkillContext): Promise<SkillResult<TOutput>>
}
