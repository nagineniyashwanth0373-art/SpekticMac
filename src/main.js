const { app, BrowserWindow, globalShortcut, session, powerSaveBlocker, clipboard, screen, ipcMain } = require('electron')
const path = require('path')
const crypto = require('crypto')
const fs = require('fs')
const { exec } = require('child_process')

// Disable Remote Debugging Port and UI Automation Scraping
app.commandLine.appendSwitch('remote-debugging-port', '0')
app.commandLine.appendSwitch('disable-renderer-accessibility', '1')

// Global crash prevention handlers
process.on('uncaughtException', (err) => {
  console.error('[Spektic macOS] Uncaught Exception:', err)
})
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Spektic macOS] Unhandled Rejection:', reason)
})

let mainWindow = null
let appHash = ''
let processWatchdogTimer = null
let clipboardTimer = null
let powerBlockerId = null
let blackoutWindows = []

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

// 2. Safe Network Cleanup (Ensures no dead proxies are ever left behind on the Mac)
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

// 3. Strict Domain Whitelist for Spektic (Only allowed exam endpoints receive network traffic)
const ALLOWED_DOMAINS = [
  'spektic.com',
  'vercel.app',
  'workers.dev',
  'livekit.cloud',
  'localhost',
  '127.0.0.1'
]

function setupNetworkSecurity() {
  // Allow direct connection for Spektic
  session.defaultSession.setProxy({
    proxyRules: 'direct://'
  })

  // Block any web request outside allowed exam/proctoring domains
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    try {
      const url = new URL(details.url)
      const hostname = url.hostname.toLowerCase()
      
      const isAllowed = ALLOWED_DOMAINS.some(domain => hostname.includes(domain) || hostname === domain)
      
      if (isAllowed || url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'file:') {
        callback({ cancel: false })
      } else {
        console.log(`[Spektic macOS] Blocked Unauthorized Outbound Request: ${details.url}`)
        callback({ cancel: true })
      }
    } catch (e) {
      callback({ cancel: false })
    }
  })

  // Inject SHA-256 key into request headers for Spektic/Cloudflare endpoints
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

  // Auto-grant camera & microphone for WebRTC AI proctoring
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') {
      return callback(true)
    }
    callback(false)
  })
}

// 4. Aggressive Process Assassin (Kills all other browsers and cheating tools)
const PROHIBITED_MAC_APPS = [
  'Google Chrome',
  'Google Chrome Canary',
  'Chromium',
  'Safari',
  'Firefox',
  'Microsoft Edge',
  'Brave Browser',
  'Arc',
  'Opera',
  'Vivaldi',
  'TeamViewer',
  'AnyDesk',
  'obs',
  'Zoom',
  'Skype',
  'Slack',
  'Discord',
  'Telegram',
  'WhatsApp',
  'ScreenCapture',
  'Camtasia',
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
  if (process.platform !== 'darwin') return

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

// 5. Multi-Monitor Secondary Screen Blackout Array
function createMultiMonitorBlackouts() {
  try {
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
        blackout.loadURL('data:text/html,<html><body style="background-color:black;margin:0;padding:0;"></body></html>')
        blackoutWindows.push(blackout)
      }
    })
  } catch (e) {}
}

// 6. Safe & Fast Shutdown Handler
function safeQuit() {
  console.log('[Spektic macOS] Safe Quit Triggered. Cleaning up...')
  
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

// 7. Create Main Lockdown Window
function createWindow() {
  calculateAppHash()
  cleanupSystemProxies()
  setupNetworkSecurity()

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
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      spellcheck: false,
      devTools: false
    }
  })

  // Turn Zoom/Meet/OBS screen recordings into a BLACK BOX
  mainWindow.setContentProtection(true)

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
    
    // Check if Exit Exam button was clicked
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

  // Load Exam Portal
  const TARGET_URL = 'https://spektic.com/join'
  mainWindow.loadURL(TARGET_URL)

  // Inject CSS for Anti-Siri Lookup & Clean Exit Button
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.insertCSS(`
      * {
        -webkit-touch-callout: none !important;
        -webkit-user-select: none !important;
        user-select: none !important;
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
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.6) !important;
        transition: transform 0.15s ease, background 0.15s ease !important;
      }
      #spektic-exit-btn:hover {
        background: #b91c1c !important;
        transform: scale(1.05) !important;
      }
    `)

    mainWindow.webContents.executeJavaScript(`
      if (!document.getElementById('spektic-exit-btn')) {
        const exitBtn = document.createElement('button');
        exitBtn.id = 'spektic-exit-btn';
        exitBtn.innerText = '✕ Exit Spektic';
        exitBtn.onclick = () => {
          window.location.href = 'https://spektic.com/spektic-quit-action';
        };
        document.body.appendChild(exitBtn);
      }
    `)
  })

  // Keyboard Trap
  mainWindow.webContents.on('before-input-event', (event, input) => {
    // Emergency Quit Shortcut: Command + Shift + Option + Q
    if (input.meta && input.shift && input.alt && input.key.toLowerCase() === 'q') {
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

  // Cover secondary displays
  createMultiMonitorBlackouts()

  // Process Watchdog
  processWatchdogTimer = setInterval(killProhibitedProcesses, 1500)

  // Clipboard Eraser
  clipboardTimer = setInterval(() => {
    try { clipboard.clear() } catch (e) {}
  }, 2000)
}

// 8. App Lifecycle & Global Shortcut Registration
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
