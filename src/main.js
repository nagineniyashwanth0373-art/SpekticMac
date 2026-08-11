const { app, BrowserWindow, globalShortcut, session, powerSaveBlocker, clipboard, screen, ipcMain } = require('electron')
const path = require('path')
const crypto = require('crypto')
const fs = require('fs')
const { exec } = require('child_process')

// 1. Single-Instance Lock
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  console.log('[Spektic macOS] Another instance is already running. Exiting immediately.')
  app.exit(0)
}

// 2. Global Crash Prevention & Security Switches
app.commandLine.appendSwitch('remote-debugging-port', '0')
app.commandLine.appendSwitch('disable-renderer-accessibility', '1')

process.on('uncaughtException', (err) => {
  console.error('[Spektic macOS] Caught Unhandled Exception:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[Spektic macOS] Caught Unhandled Rejection:', reason)
})

let mainWindow = null
let appHash = ''
let processWatchdogTimer = null
let clipboardTimer = null
let powerBlockerId = null
let blackoutWindows = []
let isQuitting = false
let isCheckingProcesses = false

// 3. Calculate SHA-256 Hash of this application script
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

// 4. Safe Network Cleanup
function cleanupSystemProxies() {
  if (process.platform !== 'darwin') return
  try {
    exec('networksetup -listallnetworkservices', (err, stdout) => {
      if (err || !stdout) return
      const services = stdout
        .split('\n')
        .map(s => s.trim())
        .filter(s => s.length > 0 && !s.includes('*') && !s.includes('An asterisk'))

      services.forEach((service) => {
        exec(`networksetup -setwebproxystate "${service}" off`, () => {})
        exec(`networksetup -setsecurewebproxystate "${service}" off`, () => {})
      })
    })
  } catch (e) {}
}

// 5. Strict Domain Whitelist for Spektic
const ALLOWED_DOMAINS = [
  'spektic.com',
  'vercel.app',
  'workers.dev',
  'livekit.cloud',
  'localhost',
  '127.0.0.1'
]

function setupNetworkSecurity() {
  session.defaultSession.setProxy({
    proxyRules: 'direct://'
  })

  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    try {
      const url = new URL(details.url)
      const hostname = url.hostname.toLowerCase()
      
      const isAllowed = ALLOWED_DOMAINS.some(domain => hostname.includes(domain) || hostname === domain)
      
      if (isAllowed || url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'file:') {
        callback({ cancel: false })
      } else {
        console.log(`[Spektic macOS] Blocked Outbound Request: ${details.url}`)
        callback({ cancel: true })
      }
    } catch (e) {
      callback({ cancel: false })
    }
  })

  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://*/*', 'http://*/*'] },
    (details, callback) => {
      try {
        const url = details.url.toLowerCase()
        if (
          url.includes('spektic.com') ||
          url.includes('vercel.app') ||
          url.includes('workers.dev') ||
          url.includes('localhost')
        ) {
          details.requestHeaders['x-secure-exam-key'] = appHash
        }
      } catch (e) {}
      callback({ requestHeaders: details.requestHeaders })
    }
  )

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') {
      return callback(true)
    }
    callback(false)
  })
}

// 6. ULTRA-AGGRESSIVE macOS Process Assassin (Terminates Chrome, Meet, Teams, Zoom, Audio & Screen Sharers)
const PROHIBITED_NAMES = [
  'Google Chrome',
  'Google Chrome Helper',
  'Google Chrome Helper (Renderer)',
  'Google Chrome Helper (GPU)',
  'Chromium',
  'Safari',
  'SafariNetworking',
  'firefox',
  'Microsoft Edge',
  'Microsoft Edge Helper',
  'Brave Browser',
  'Brave Browser Helper',
  'Arc',
  'Opera',
  'Vivaldi',
  'Zoom',
  'zoom.us',
  'Microsoft Teams',
  'FaceTime',
  'Webex',
  'Skype',
  'Slack',
  'Discord',
  'Discord Helper',
  'Telegram',
  'WhatsApp',
  'ScreenCaptureAgent',
  'screencapture',
  'AirPlayUIAgent',
  'QuickTime Player',
  'Loom',
  'Screenflow',
  'Camtasia',
  'obs',
  'obs64',
  'TeamViewer',
  'AnyDesk',
  'Notes',
  'TextEdit',
  'Calculator',
  'Pages',
  'Microsoft Word',
  'Preview',
  'Sublime Text',
  'VSCode',
  'Terminal',
  'iTerm',
  'Activity Monitor'
]

function killProhibitedProcesses() {
  if (process.platform !== 'darwin' || isQuitting || isCheckingProcesses) return
  isCheckingProcesses = true

  // Method 1: killall -9 on all prohibited binary names (Instantly assassinates Google Chrome & all helpers)
  PROHIBITED_NAMES.forEach((name) => {
    exec(`killall -9 "${name}"`, () => {})
    exec(`pkill -9 -i -f "${name}"`, () => {})
  })

  // Method 2: Dynamic process list sweep via ps
  exec('ps -ax -o comm=', (err, stdout) => {
    isCheckingProcesses = false
    if (err || !stdout || isQuitting) return

    const runningLines = stdout.split('\n')
    runningLines.forEach((line) => {
      const processPath = line.trim()
      PROHIBITED_NAMES.forEach((appName) => {
        if (processPath.toLowerCase().includes(appName.toLowerCase())) {
          exec(`pkill -9 -f "${appName}"`, () => {})
        }
      })
    })
  })
}

// 7. Multi-Monitor Secondary Screen Blackout Array
function createMultiMonitorBlackouts() {
  try {
    blackoutWindows.forEach((win) => {
      try { win.destroy() } catch (e) {}
    })
    blackoutWindows = []

    const displays = screen.getAllDisplays()
    const primaryDisplay = screen.getPrimaryDisplay()

    displays.forEach((display) => {
      if (display.id !== primaryDisplay.id) {
        const blackout = new BrowserWindow({
          x: display.bounds.x,
          y: display.bounds.y,
          width: display.bounds.width,
          height: display.bounds.height,
          fullscreen: true,
          kiosk: true,
          alwaysOnTop: true,
          frame: false,
          backgroundColor: '#000000',
          resizable: false,
          movable: false,
          minimizable: false,
          maximizable: false,
          closable: false
        })

        blackout.setContentProtection(true)
        blackout.setAlwaysOnTop(true, 'screen-saver')
        blackout.setVisibleOnAllWorkspaces(true)
        blackout.loadURL('data:text/html,<html><body style="background-color:black;margin:0;padding:0;"></body></html>')
        blackoutWindows.push(blackout)
      }
    })
  } catch (e) {}
}

// 8. 100% Guaranteed Instant Safe-Quit Handler
function safeQuit() {
  if (isQuitting) return
  isQuitting = true
  console.log('[Spektic macOS] Force Quit Triggered. Restoring OS and terminating instantly.')

  if (processWatchdogTimer) clearInterval(processWatchdogTimer)
  if (clipboardTimer) clearInterval(clipboardTimer)
  
  if (powerBlockerId !== null) {
    try { powerSaveBlocker.stop(powerBlockerId) } catch (e) {}
  }

  cleanupSystemProxies()

  try { globalShortcut.unregisterAll() } catch (e) {}

  blackoutWindows.forEach((win) => {
    try { win.destroy() } catch (e) {}
  })

  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.destroy() } catch (e) {}
  }

  app.exit(0)
}

// IPC quit handler (from preload/renderer)
ipcMain.on('spektic-force-quit', () => {
  safeQuit()
})

// Function to inject UI CSS & Exit Button
function injectSecurityUI(webContents) {
  try {
    webContents.insertCSS(`
      * {
        -webkit-touch-callout: none !important;
        -webkit-user-select: none !important;
        user-select: none !important;
        cursor: default !important;
      }
      input, textarea {
        -webkit-user-select: auto !important;
        user-select: auto !important;
      }
      /* Prominent Fixed Exit Button */
      #spektic-exit-btn {
        position: fixed !important;
        top: 16px !important;
        right: 16px !important;
        z-index: 2147483647 !important;
        background: #dc2626 !important;
        color: #ffffff !important;
        border: 2px solid rgba(255, 255, 255, 0.9) !important;
        padding: 10px 22px !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
        font-size: 14px !important;
        font-weight: 800 !important;
        border-radius: 8px !important;
        cursor: pointer !important;
        pointer-events: auto !important;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.6) !important;
        transition: transform 0.15s ease, background 0.15s ease !important;
      }
      #spektic-exit-btn:hover {
        background: #b91c1c !important;
        transform: scale(1.05) !important;
      }
    `)

    webContents.executeJavaScript(`
      if (!document.getElementById('spektic-exit-btn')) {
        const exitBtn = document.createElement('button');
        exitBtn.id = 'spektic-exit-btn';
        exitBtn.innerText = '✕ Exit Spektic';
        exitBtn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (window.spekticAPI && window.spekticAPI.exitApp) {
            window.spekticAPI.exitApp();
          } else {
            window.location.href = 'https://spektic.com/spektic-quit-action';
          }
        };
        document.body.appendChild(exitBtn);
      }
    `)
  } catch (e) {}
}

// 9. Create Main Lockdown Window
function createWindow() {
  calculateAppHash()
  cleanupSystemProxies()
  setupNetworkSecurity()

  // Assassinate Google Chrome and all browsers immediately on launch
  killProhibitedProcesses()

  try {
    powerBlockerId = powerSaveBlocker.start('prevent-display-sleep')
  } catch (e) {}

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    fullscreen: true,
    kiosk: true,
    alwaysOnTop: true,
    frame: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: -100, y: -100 },
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      spellcheck: false,
      devTools: false
    }
  })

  // Turn Zoom/Meet/OBS screen recordings into a BLACK BOX
  mainWindow.setContentProtection(true)
  
  // High-level Screen-Saver Kiosk Lock (stays above all Mac gestures)
  mainWindow.setAlwaysOnTop(true, 'screen-saver')
  mainWindow.setVisibleOnAllWorkspaces(true)

  // Disable Right-Click Context Menu
  mainWindow.webContents.on('context-menu', (e) => {
    e.preventDefault()
  })

  // Block Popups and New Windows
  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' }
  })

  // Navigation Guard & Exit Action Intercept
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const lowerUrl = url.toLowerCase()
    
    if (lowerUrl.includes('spektic-quit-action') || lowerUrl.includes('quit-exam')) {
      event.preventDefault()
      safeQuit()
      return
    }

    if (
      !lowerUrl.includes('spektic.com') &&
      !lowerUrl.includes('vercel.app') &&
      !lowerUrl.includes('workers.dev') &&
      !lowerUrl.includes('localhost')
    ) {
      console.log(`[Spektic macOS] Blocked External Navigation to: ${url}`)
      event.preventDefault()
    }
  })

  // Block File Downloads on macOS
  session.defaultSession.on('will-download', (event) => {
    event.preventDefault()
  })

  // Prevent accidental close unless isQuitting is true
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      safeQuit()
    }
  })

  // Load Exam Portal
  const TARGET_URL = 'https://spektic.com/join'
  mainWindow.loadURL(TARGET_URL)

  // Inject UI on both dom-ready and did-finish-load
  mainWindow.webContents.on('dom-ready', () => {
    injectSecurityUI(mainWindow.webContents)
  })

  mainWindow.webContents.on('did-finish-load', () => {
    injectSecurityUI(mainWindow.webContents)
  })

  // Keyboard Trap
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if ((input.meta && input.shift && input.alt && input.key.toLowerCase() === 'q') ||
        (input.meta && input.alt && input.key.toLowerCase() === 'q')) {
      safeQuit()
      return
    }

    if (input.meta || input.alt || input.control) {
      const key = input.key.toLowerCase()
      if (
        key === 'tab' ||
        key === 'q' ||
        key === 'w' ||
        key === 'space' ||
        key === 'r' ||
        key === 'h' ||
        key === 'm' ||
        key === 'c' ||
        key === 'v'
      ) {
        event.preventDefault()
      }
    }
  })

  // Handle second-instance attempts
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  // Cover secondary displays
  createMultiMonitorBlackouts()

  // Process Watchdog (Runs every 1s using killall to murder Google Chrome and meeting apps)
  processWatchdogTimer = setInterval(killProhibitedProcesses, 1000)

  // Clipboard Eraser
  clipboardTimer = setInterval(() => {
    try { clipboard.clear() } catch (e) {}
  }, 2000)
}

// 10. App Lifecycle & Global Shortcut Registration
app.whenReady().then(() => {
  const shortcutsToBlock = [
    'Command+Tab',
    'Command+Q',
    'Command+W',
    'Command+Space',
    'Command+Option+Esc',
    'Command+Shift+3',
    'Command+Shift+4',
    'Command+Shift+5'
  ]

  shortcutsToBlock.forEach((sc) => {
    try {
      globalShortcut.register(sc, () => {})
    } catch (e) {}
  })

  // Emergency Global Shortcut
  try {
    globalShortcut.register('Command+Shift+Option+Q', () => {
      safeQuit()
    })
  } catch (e) {}

  createWindow()
})

app.on('will-quit', () => {
  safeQuit()
})

app.on('window-all-closed', () => {
  safeQuit()
})
