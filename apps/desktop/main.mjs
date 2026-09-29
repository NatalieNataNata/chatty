import { app, BrowserWindow, ipcMain, screen, session, shell, systemPreferences } from 'electron'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(desktopDir, '..', '..')
const port = 18787
const desktopInstancePort = 18786
const devServerUrl = process.env.CHATTY_DEV_URL

app.setName('Chatty')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
if (!app.isPackaged) app.setPath('userData', resolve(app.getPath('appData'), 'chatty-fm-agent'))
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

let mainWindow = null
let petWindow = null
let desktopInstanceServer = null
let petDragOffset = null
let isQuitting = false
let speechProcess = null
let speechSession = null

function speechHelperPath() {
  if (app.isPackaged) return resolve(process.resourcesPath, 'app.asar.unpacked', 'apps', 'desktop', 'speech-recognition')
  return resolve(desktopDir, 'speech-recognition')
}

function stopSpeechInput({ notifyIfEmpty = false } = {}) {
  const session = speechSession
  speechSession = null
  if (speechProcess && !speechProcess.killed) speechProcess.kill('SIGTERM')
  speechProcess = null
  if (notifyIfEmpty && session && !session.gotText && !session.finished) {
    session.finished = true
    session.sender.send('chatty:voice-result', { type: 'error', message: 'Voice input could not hear that. Try speaking a little closer to the microphone.' })
  }
}

function startSpeechInput(event, locale = 'zh-CN') {
  stopSpeechInput()
  const child = spawn(speechHelperPath(), [locale], { stdio: ['ignore', 'pipe', 'pipe'] })
  speechProcess = child
  const activeSession = { sender: event.sender, gotText: false, finished: false }
  speechSession = activeSession
  let remainder = ''

  child.stdout.on('data', (chunk) => {
    remainder += chunk.toString()
    const lines = remainder.split('\n')
    remainder = lines.pop() ?? ''
    for (const line of lines) {
      try {
        const payload = JSON.parse(line)
        if (payload.text) activeSession.gotText = true
        if (payload.type === 'final' || payload.type === 'error') activeSession.finished = true
        activeSession.sender.send('chatty:voice-result', payload)
      } catch {
        // The helper only speaks JSON; malformed output must not crash the desktop app.
      }
    }
  })
  child.once('error', () => {
    if (speechSession === activeSession) {
      activeSession.finished = true
      event.sender.send('chatty:voice-result', { type: 'error', message: 'Chatty could not start macOS Speech Recognition. Reopen Chatty and try again.' })
    }
  })
  child.once('exit', () => {
    if (speechSession === activeSession) {
      speechSession = null
      speechProcess = null
      if (!activeSession.finished && !activeSession.gotText) {
        event.sender.send('chatty:voice-result', { type: 'error', message: 'Voice input ended before macOS heard a request. Please try again.' })
      }
    }
  })
}

function acquireDesktopInstanceLock() {
  return new Promise((resolveLock) => {
    const server = createServer()
    server.once('error', () => resolveLock(false))
    server.listen(desktopInstancePort, '127.0.0.1', () => {
      desktopInstanceServer = server
      resolveLock(true)
    })
  })
}

function configureRuntime() {
  // Development and packaged builds share one local agent identity and connection store.
  const dataDir = resolve(app.getPath('appData'), 'chatty-fm-agent', 'data')
  mkdirSync(dataDir, { recursive: true })

  process.env.PORT = String(port)
  process.env.CHATTY_SERVE_WEB = 'true'
  process.env.CHATTY_DATA_DIR = dataDir

  if (app.isPackaged) {
    process.env.DOTENV_CONFIG_PATH = resolve(process.resourcesPath, '.env')
    process.env.CHATTY_PERSONA_DIR = resolve(process.resourcesPath, 'persona')
  } else {
    process.env.DOTENV_CONFIG_PATH = resolve(projectRoot, '.env')
    process.env.CHATTY_PROJECT_ROOT = projectRoot
    process.env.CHATTY_PERSONA_DIR = resolve(projectRoot, 'persona')
  }
}

async function startAgent() {
  if (devServerUrl) return
  configureRuntime()
  await import('../server/dist/index.js')
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 430,
    height: 764,
    minWidth: 390,
    minHeight: 693,
    show: false,
    title: 'Chatty',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#05080c',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      preload: resolve(desktopDir, 'main-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.setAspectRatio(9 / 16)

  mainWindow.loadURL(devServerUrl ? `${devServerUrl}/?desktop=1` : `http://127.0.0.1:${port}/?desktop=1`)
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    app.quit()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function createPetWindow() {
  const workArea = screen.getPrimaryDisplay().workArea
  const width = 150
  const height = 190
  const margin = 18
  petWindow = new BrowserWindow({
    width,
    height,
    x: workArea.x + workArea.width - width - margin,
    y: workArea.y + workArea.height - height - margin,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    webPreferences: {
      preload: resolve(desktopDir, 'pet-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  petWindow.loadFile(resolve(desktopDir, 'pet.html'))
  petWindow.on('closed', () => {
    petWindow = null
  })
}

ipcMain.on('chatty:open-main', () => {
  if (!mainWindow) createWindow()
  if (mainWindow?.isMinimized()) mainWindow.restore()
  mainWindow?.show()
  mainWindow?.focus()
  app.focus({ steal: true })
})

ipcMain.on('chatty:hide-pet', () => app.quit())

ipcMain.on('chatty:pet-drag-start', (_event, point) => {
  if (!petWindow || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return
  const [windowX, windowY] = petWindow.getPosition()
  petDragOffset = { x: point.x - windowX, y: point.y - windowY }
})

ipcMain.on('chatty:pet-drag-move', (_event, point) => {
  if (!petWindow || !petDragOffset || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return
  petWindow.setPosition(Math.round(point.x - petDragOffset.x), Math.round(point.y - petDragOffset.y))
})

ipcMain.on('chatty:pet-drag-end', () => {
  petDragOffset = null
})

ipcMain.on('chatty:pet-ready', () => console.log('Chatty pet controls connected.'))

ipcMain.handle('chatty:voice-start', async (event) => {
  const microphoneGranted = await systemPreferences.askForMediaAccess('microphone')
  if (!microphoneGranted) return { ok: false, error: 'Allow Microphone access for Chatty in macOS Settings, then try again.' }
  startSpeechInput(event, event.sender.getURL().includes('lang=en') ? 'en-US' : 'zh-CN')
  return { ok: true }
})

ipcMain.handle('chatty:voice-stop', async () => {
  stopSpeechInput({ notifyIfEmpty: true })
})

app.on('second-instance', () => {
  if (!mainWindow) createWindow()
  if (mainWindow?.isMinimized()) mainWindow.restore()
  mainWindow?.show()
  mainWindow?.focus()
})

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return
  if (!(await acquireDesktopInstanceLock())) {
    app.quit()
    return
  }
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => callback(permission === 'geolocation' || permission === 'media'))
  await startAgent()
  createWindow()
  createPetWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  isQuitting = true
  stopSpeechInput()
  petWindow?.destroy()
  desktopInstanceServer?.close()
})
