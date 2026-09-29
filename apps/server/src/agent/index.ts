import type { AgentProvider } from '../types.js'
import { OpenAiAgentProvider } from './openai-agent.js'

let lastAgentError: string | null = null
let lastAgentIssue: ReturnType<typeof classifyAgentIssue> | null = null
let agentCalls = 0
let agentFailures = 0

function classifyAgentIssue(error: unknown) {
  const record = typeof error === 'object' && error ? error as Record<string, unknown> : {}
  const code = String(record.code ?? '')
  const status = Number(record.status ?? 0)
  const detail = error instanceof Error ? error.message : String(error)
  const provider = process.env.CHATTY_BRAIN_PROVIDER === 'deepseek' ? 'DeepSeek' : 'OpenAI'
  const providerId = provider === 'DeepSeek' ? 'deepseek' : 'openai'
  const actionUrl = providerId === 'deepseek' ? 'https://platform.deepseek.com/top_up' : 'https://platform.openai.com/settings/organization/billing/overview'
  const balance = code === 'insufficient_quota' || code === 'insufficient_balance' || status === 402 || /balance|quota|余额|insufficient/i.test(detail)
  const authentication = status === 401 || /authentication|api key|unauthorized/i.test(detail)
  const model = status === 400 && /model/i.test(detail)
  const issueCode = balance ? 'insufficient_balance' : authentication ? 'authentication' : model ? 'invalid_model' : 'unavailable'
  const message = balance
    ? `${provider} API balance is insufficient. Chatty cannot use the full AI brain until it is recharged.`
    : authentication
      ? `${provider} rejected the saved API key. Reconnect the brain in Profile.`
      : model
        ? `${provider} rejected the configured model. Chatty needs its brain configuration repaired.`
        : `${provider} could not be reached. Check the network or try again.`
  return { service: providerId, code: issueCode, message, actionUrl, actionLabel: balance ? `RECHARGE ${provider.toUpperCase()}` : `OPEN ${provider.toUpperCase()}` }
}

export function getAgentRuntimeStatus() {
  return { lastError: lastAgentError, issue: lastAgentIssue, agentCalls, agentFailures }
}

export function createAgentProvider(): AgentProvider {
  if (process.env.OPENAI_API_KEY) {
    const openai = new OpenAiAgentProvider()
    return {
      async decide(context) {
        agentCalls += 1
        try {
         const decision = await openai.decide(context)
         lastAgentError = null
         lastAgentIssue = null
         return decision
       } catch (error) {
          agentFailures += 1
          lastAgentIssue = classifyAgentIssue(error)
          lastAgentError = lastAgentIssue.message
          throw new Error(lastAgentIssue.message)
        }
      },
      async narrateTrack(context, track, moment) {
        agentCalls += 1
        try {
          const narration = await openai.narrateTrack(context, track, moment)
          lastAgentError = null
          lastAgentIssue = null
          return narration
        } catch (error) {
          agentFailures += 1
          lastAgentIssue = classifyAgentIssue(error)
          lastAgentError = lastAgentIssue.message
          throw new Error(lastAgentIssue.message)
        }
      },
      async composeOpening(context, currentTrack) {
        agentCalls += 1
        try {
          const opening = await openai.composeOpening(context, currentTrack)
          lastAgentError = null
          lastAgentIssue = null
          return opening
        } catch (error) {
          agentFailures += 1
          lastAgentIssue = classifyAgentIssue(error)
          lastAgentError = lastAgentIssue.message
          throw new Error(lastAgentIssue.message)
        }
      },
    }
  }

  lastAgentError = 'No API key configured. Chatty needs an LLM to operate.'
  lastAgentIssue = { service: 'openai', code: 'not_configured', message: 'Set an API key in your profile or .env to start the radio brain.', actionUrl: '', actionLabel: '' }
  throw new Error(lastAgentError)
}
