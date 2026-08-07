const { app, BrowserWindow, globalShortcut, session, powerSaveBlocker, clipboard, screen, ipcMain } = require('electron')
const path = require('path')
const crypto = require('crypto')
const fs = require('fs')
const { exec, execSync } = require('child_process')

// Disable Remote Debugging Port and UI Automation Scraping
app.commandLine.appendSwitch('remote-debugging-port', '0')
app.commandLine.appendSwitch('disable-renderer-accessibility', '1')

let mainWindow
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

// 2. SYSTEM-WIDE macOS NETWORK BLACKHOLE LOCKDOWN (Cuts internet for all other Mac apps)
function applySystemNetworkLockdown() {
  if (process.platform !== 'darwin') return
  try {
    console.log('[Spektic macOS] Locking down system-wide internet for all other apps...')
    
    // Set system HTTP/HTTPS proxy to dead blackhole address (127.0.0.1:9999) for all network services
    const services = ['Wi-Fi', 'Ethernet', 'iPhone USB', 'Thunderbolt Bridge']
    services.forEach((service) => {
      exec(`networksetup -setwebproxy "${service}" 127.0.0.1 9999`, () => {})
      exec(`networksetup -setsecurewebproxy "${service}" 127.0.0.1 9999`, () => {})
    })

    // Force Spektic to bypass the blackhole proxy and connect directly
    session.defaultSession.setProxy({
      proxyRules: 'direct://'
    })
  } catch (e) {
    console.error('[Spektic macOS] Network lockdown error:', e)
  }
}

function restoreSystemNetworkLockdown() {
  if (process.platform !== 'darwin') return
  try {
    console.log('[Spektic macOS] Restoring system-wide internet for normal apps...')
    const services = ['Wi-Fi', 'Ethernet', 'iPhone USB', 'Thunderbolt Bridge']
    services.forEach((service) => {
      exec(`networksetup -setwebproxystate "${service}" off`, () => {})
      exec(`networksetup -setsecurewebproxystate "${service}" off`, () => {})
    })
  } catch (e) {}
}

// 3. Comprehensive macOS Process Assassin (Includes Google Chrome & all browsers)
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

// 4. Multi-Monitor Secondary Screen Blackout Array
function createMultiMonitorBlackouts() {
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
}

// 5. Create Locked Down Primary Electron Window
function createWindow() {
  calculateAppHash()
  applySystemNetworkLockdown()

  // Prevent display sleep during the exam
  powerBlockerId = powerSaveBlocker.start('prevent-display-sleep')

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    fullscreen: true,
    kiosk: true, // macOS Kiosk Mode
    alwaysOnTop: true, // Keeps window on top
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

  // CRITICAL MAC PROTECTION: Turn Zoom/Google Meet/OBS screen recording into a BLACK BOX!
  mainWindow.setContentProtection(true)

  // Disable Right-Click Context Menu
  mainWindow.webContents.on('context-menu', (e) => {
    e.preventDefault()
  })

  // Block Popups and New Windows
  mainWindow.webContents.setWindowOpenHandler(() => {
    console.log('[Spektic macOS] Blocked Popup / New Window Request')
    return { action: 'deny' }
  })

  // Intercept Navigation & Clean Instant Exit
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const lowerUrl = url.toLowerCase()
    
    // Clean Exit Handler
    if (lowerUrl.includes('spektic-quit-action') || lowerUrl.includes('quit-exam')) {
      event.preventDefault()
      console.log('[Spektic macOS] Force Quitting Spektic and restoring network...')
      restoreSystemNetworkLockdown()
      if (processWatchdogTimer) clearInterval(processWatchdogTimer)
      if (clipboardTimer) clearInterval(clipboardTimer)
      if (powerBlockerId !== null) powerSaveBlocker.stop(powerBlockerId)
      globalShortcut.unregisterAll()
      app.exit(0)
      return
    }

    if (
      !lowerUrl.includes('spektic.com') &&
      !lowerUrl.includes('vercel.app') &&
      !lowerUrl.includes('workers.dev') &&
      !lowerUrl.includes('localhost')
    ) {
      console.log(`[Spektic macOS] Blocked Navigation to: ${url}`)
      event.preventDefault()
    }
  })

  // Block File Downloads on macOS
  session.defaultSession.on('will-download', (event) => {
    console.log('[Spektic macOS] Blocked File Download Request')
    event.preventDefault()
  })

  // 6. Inject Dynamic SHA-256 Hash into Cloudflare Worker Headers
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

  // 7. INJECT SECURITY CSS & 1-CLICK INSTANT EXIT BUTTON
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.insertCSS(`
      * {
        -webkit-touch-callout: none !important;
        -webkit-user-select: none !important;
        user-select: none !important;
        cursor: none !important; /* Hide OS Cursor System-Wide on Exam */
      }
      input, textarea {
        -webkit-user-select: auto !important;
        user-select: auto !important;
        cursor: auto !important;
      }
      /* Custom Instant Exit Button */
      #spektic-exit-btn {
        position: fixed;
        top: 14px;
        right: 14px;
        z-index: 2147483647;
        background: #dc2626;
        color: #ffffff;
        border: 2px solid #ffffff;
        padding: 10px 20px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 14px;
        font-weight: 800;
        border-radius: 8px;
        cursor: pointer !important;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
      }
      #spektic-exit-btn:hover {
        background: #b91c1c;
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

  // 8. macOS Keyboard Trap
  mainWindow.webContents.on('before-input-event', (event, input) => {
    // Secret Emergency Exit Hotkey: Command + Shift + Option + Q
    if (input.meta && input.shift && input.alt && input.key.toLowerCase() === 'q') {
      console.log('[Spektic macOS] Developer Emergency Quit Triggered')
      restoreSystemNetworkLockdown()
      app.exit(0)
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
        console.log(`[Spektic macOS] Blocked Shortcut: Cmd+${key}`)
        event.preventDefault()
      }
    }
  })

  // Cover secondary displays with blackout shields
  createMultiMonitorBlackouts()

  // Start 2-Second Process Watchdog (Kills all prohibited apps)
  processWatchdogTimer = setInterval(killProhibitedProcesses, 2000)

  // Start 2-Second Aggressive Clipboard Eraser
  clipboardTimer = setInterval(() => {
    try {
      clipboard.clear()
    } catch (e) {}
  }, 2000)
}

// 9. System Initialization & Global Shortcut Lockdown
app.whenReady().then(() => {
  const shortcutsToBlock = [
    'Command+Tab',
    'Command+Q',
    'Command+W',
    'Command+Space', // Spotlight Search
    'Command+Option+Esc', // Force Quit Menu
    'Command+Shift+3', // Screenshot
    'Command+Shift+4', // Screenshot Snipping
    'Command+Shift+5' // Screen Recording Bar
  ]

  shortcutsToBlock.forEach((sc) => {
    try {
      globalShortcut.register(sc, () => {
        console.log(`[Spektic macOS] Blocked Global System Hotkey: ${sc}`)
      })
    } catch (e) {}
  })

  // Secret Emergency Exit Hotkey: Command + Shift + Option + Q
  try {
    globalShortcut.register('Command+Shift+Option+Q', () => {
      console.log('[Spektic macOS] Global Emergency Quit Triggered')
      restoreSystemNetworkLockdown()
      app.exit(0)
    })
  } catch (e) {}

  createWindow()
})

app.on('will-quit', () => {
  restoreSystemNetworkLockdown()
  if (processWatchdogTimer) clearInterval(processWatchdogTimer)
  if (clipboardTimer) clearInterval(clipboardTimer)
  if (powerBlockerId !== null) powerSaveBlocker.stop(powerBlockerId)
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  restoreSystemNetworkLockdown()
  if (process.platform !== 'darwin') {
    app.exit(0)
  }
})
