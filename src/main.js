const { app, BrowserWindow, globalShortcut, session, systemPreferences } = require('electron')
const path = require('path')
const crypto = require('crypto')
const fs = require('fs')
const { exec } = require('child_process')

let mainWindow
let appHash = ''
let processWatchdogTimer = null

// 1. Calculate SHA-256 Hash of this application script
function calculateAppHash() {
  try {
    const mainPath = __filename
    const fileBuffer = fs.readFileSync(mainPath)
    const hashSum = crypto.createHash('sha256')
    hashSum.update(fileBuffer)
    appHash = hashSum.digest('hex')
    console.log(`[Spektic macOS] Generated App Hash: ${appHash}`)
  } catch (err) {
    console.error(`[Spektic macOS] Failed to generate hash:`, err)
    appHash = 'INVALID_HASH_TAMPERING_DETECTED'
  }
}

// 2. Prohibited macOS Process Assassin
const PROHIBITED_MAC_APPS = [
  'Discord',
  'TeamViewer',
  'AnyDesk',
  'obs',
  'Spotify',
  'Slack',
  'Zoom',
  'Skype',
  'Telegram',
  'WhatsApp',
  'ScreenCapture',
  'Camtasia'
]

function killProhibitedProcesses() {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return

  // Query running processes using native OS ps command
  exec('ps -ax -o comm=', (err, stdout) => {
    if (err || !stdout) return

    const runningLines = stdout.split('\n')
    runningLines.forEach((line) => {
      const processPath = line.trim()
      PROHIBITED_MAC_APPS.forEach((appName) => {
        if (processPath.toLowerCase().includes(appName.toLowerCase())) {
          console.log(`[Spektic macOS] Assassinating prohibited app: ${processPath}`)
          exec(`pkill -f -9 "${appName}"`, () => {})
        }
      })
    })
  })
}

// 3. Create Locked Down Electron Window
function createWindow() {
  calculateAppHash()

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    fullscreen: true,
    kiosk: true, // macOS Kiosk Mode: Hides Menu Bar, Dock, & Mission Control gestures
    alwaysOnTop: true, // Keeps window Z-index on top of macOS desktop
    frame: false,
    autoHideMenuBar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      devTools: false // Strip Developer Tools
    }
  })

  // CRITICAL MAC PROTECTION: Turn Zoom/Google Meet/OBS screen recording into a BLACK BOX!
  mainWindow.setContentProtection(true)

  // 4. Inject Dynamic SHA-256 Hash into Cloudflare Worker Headers
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://*/*', 'http://*/*'] },
    (details, callback) => {
      const url = details.url.toLowerCase()
      if (
        url.includes('spektic.com') ||
        url.includes('vercel.app') ||
        url.includes('workers.dev') ||
        url.includes('localhost')
      ) {
        details.requestHeaders['x-secure-exam-key'] = appHash
      }
      callback({ requestHeaders: details.requestHeaders })
    }
  )

  // Automatically grant camera/microphone permissions for AI proctoring & WebRTC
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') {
      return callback(true)
    }
    callback(false)
  })

  // Load Secure Exam URL
  const TARGET_URL = 'https://spektic.com/join'
  mainWindow.loadURL(TARGET_URL)

  // 5. macOS Keyboard Trap (Block Command+Tab, Command+Q, Command+Space)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.meta || input.alt || input.control) {
      // Input.meta = Command key on Mac
      const key = input.key.toLowerCase()
      if (
        key === 'tab' ||
        key === 'q' ||
        key === 'w' ||
        key === 'space' ||
        key === 'r' ||
        key === 'h' ||
        key === 'm'
      ) {
        console.log(`[Spektic macOS] Blocked Shortcut: Cmd+${key}`)
        event.preventDefault()
      }
    }
  })

  // Prevent Window Closing
  mainWindow.on('close', (e) => {
    e.preventDefault()
  })

  // Start 2-Second Process Watchdog
  processWatchdogTimer = setInterval(killProhibitedProcesses, 2000)
}

app.whenReady().then(() => {
  // Register macOS System Global Shortcuts Lockdown
  const shortcutsToBlock = [
    'Command+Tab',
    'Command+Q',
    'Command+W',
    'Command+Space', // Spotlight Search
    'Command+Option+Esc', // Force Quit Menu
    'Command+Shift+3', // Screenshot
    'Command+Shift+4', // Screenshot Snipping
    'Command+Shift+5'  // Screen Recording Bar
  ]

  shortcutsToBlock.forEach((sc) => {
    try {
      globalShortcut.register(sc, () => {
        console.log(`[Spektic macOS] Blocked Global System Hotkey: ${sc}`)
      })
    } catch (e) {}
  })

  createWindow()
})

app.on('will-quit', () => {
  if (processWatchdogTimer) clearInterval(processWatchdogTimer)
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
