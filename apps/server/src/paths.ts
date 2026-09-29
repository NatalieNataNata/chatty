import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const currentDir = dirname(fileURLToPath(import.meta.url))

export const projectRoot = process.env.CHATTY_PROJECT_ROOT ?? resolve(currentDir, '..', '..', '..')
export const personaDir = process.env.CHATTY_PERSONA_DIR ?? resolve(projectRoot, 'persona')
export const dataDir = process.env.CHATTY_DATA_DIR ?? resolve(projectRoot, 'data')
