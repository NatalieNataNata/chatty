import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const apiPort = 18789
const webPort = 5174
const projectRoot = resolve(import.meta.dirname, '..')
const dataDir = resolve(homedir(), 'Library', 'Application Support', 'chatty-fm-agent', 'data')
const children = []

function run(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  })
  children.push(child)
  child.on('exit', (code) => {
    if (!stopping && code && code !== 0) stop(code)
  })
  return child
}

async function waitFor(url, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 150))
  }
  throw new Error(`${label} did not start.`)
}

function waitForExit(child, label) {
  return new Promise((resolveExit, reject) => {
    child.once('exit', (code) => code === 0 ? resolveExit() : reject(new Error(`${label} failed with exit code ${code}.`)))
  })
}

let stopping = false
function stop(code = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill('SIGTERM')
  setTimeout(() => process.exit(code), 250)
}

process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())

try {
  await waitForExit(run('npm', ['run', 'build', '--workspace', '@chatty/shared']), 'Shared types build')

  run('npm', ['run', 'dev', '--workspace', '@chatty/server'], {
    PORT: String(apiPort),
    CHATTY_DATA_DIR: dataDir,
    CHATTY_PROJECT_ROOT: projectRoot,
    DOTENV_CONFIG_PATH: resolve(projectRoot, '.env'),
  })
  run('npm', ['run', 'dev', '--workspace', '@chatty/web'], {
    CHATTY_API_PORT: String(apiPort),
    CHATTY_WEB_PORT: String(webPort),
  })

  await Promise.all([
    waitFor(`http://127.0.0.1:${apiPort}/health`, 'Chatty agent'),
    waitFor(`http://127.0.0.1:${webPort}`, 'Chatty interface'),
  ])

  const desktop = run(resolve(projectRoot, 'node_modules/.bin/electron'), ['apps/desktop/main.mjs'], {
    CHATTY_DEV_URL: `http://127.0.0.1:${webPort}`,
  })
  desktop.on('exit', (code) => stop(code ?? 0))
} catch (error) {
  console.error(error)
  stop(1)
}
