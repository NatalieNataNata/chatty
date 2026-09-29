import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { dataDir } from '../paths.js'

const configPath = resolve(dataDir, 'openai-config.json')

export function loadOpenAiConfig() {
  if (!existsSync(configPath)) return
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { apiKey?: string; model?: string; baseURL?: string; provider?: string }
    if (config.apiKey && !process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = config.apiKey
    // Migrate an early UI placeholder that was never a valid DeepSeek API model.
    const model = config.provider === 'deepseek' && config.model === 'deepseek-chat'
      ? 'deepseek-v4-flash'
      : config.model
    if (model) process.env.OPENAI_MODEL = model
    if (config.baseURL) process.env.OPENAI_BASE_URL = config.baseURL
    if (config.provider) process.env.CHATTY_BRAIN_PROVIDER = config.provider
    if (model && model !== config.model && config.apiKey && config.baseURL && config.provider) {
      saveOpenAiConfig(config.apiKey, model, config.baseURL, config.provider)
    }
  } catch {
    // Ignore a damaged local settings file and keep the offline brain available.
  }
}

export function saveOpenAiConfig(apiKey: string, model: string, baseURL: string, provider: string) {
  writeFileSync(configPath, JSON.stringify({ apiKey, model, baseURL, provider }), { mode: 0o600 })
  chmodSync(configPath, 0o600)
  process.env.OPENAI_API_KEY = apiKey
  process.env.OPENAI_MODEL = model
  process.env.OPENAI_BASE_URL = baseURL
  process.env.CHATTY_BRAIN_PROVIDER = provider
}

export function clearOpenAiConfig() {
  if (existsSync(configPath)) rmSync(configPath)
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_BASE_URL
  delete process.env.CHATTY_BRAIN_PROVIDER
}
