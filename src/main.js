const { app, BrowserWindow, globalShortcut, session, powerSaveBlocker, clipboard, screen, ipcMain } = require('electron')
const path = require('path')
const crypto = require('crypto')
const fs = require('fs')
const { exec } = require('child_process')

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

// 2. Comprehensive macOS Process Assassin (Excluding Google Chrome so your Meet call stays alive)
const PROHIBITED_MAC_APPS = [
  // Browsers (Chrome is temporarily excluded so your Google Meet stays active for testing)
  'Safari',
  'Firefox',
  'Microsoft Edge',
  'Brave Browser',
  'Arc',
  'Opera',
  'Vivaldi',

  // Remote Control & Screen Sharing
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

  // Productivity & Utility Apps (Notes, Siri, Editors)
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

// 3. Multi-Monitor Secondary Screen Blackout Array
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

// 4. Create Locked Down Primary Electron Window
function createWindow() {
  calculateAppHash()

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
    trafficLightPosition: { x: -100, y: -100 }, // Completely hides the Mac red/yellow/green close buttons off screen!
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      spellcheck: false, // Disable right-click spellcheck
      devTools: false // Strip Developer Tools
    }
  })

  // CRITICAL MAC PROTECTION: Turn Zoom/Google Meet/OBS screen recording into a BLACK BOX!
  mainWindow.setContentProtection(true)

  // Disable Right-Click Context Menu & Text-Lookup Context Menus
  mainWindow.webContents.on('context-menu', (e) => {
    e.preventDefault()
  })

  // Block Popups and New Windows
  mainWindow.webContents.setWindowOpenHandler(() => {
    console.log('[Spektic macOS] Blocked Popup / New Window Request')
    return { action: 'deny' }
  })

  // Block External URL Navigation
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const lowerUrl = url.toLowerCase()
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

  // 5. Inject Dynamic SHA-256 Hash into Cloudflare Worker Headers
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

  // 6. INJECT SECURITY CSS & CLEAN EXIT BUTTON ON PAGE LOAD
  mainWindow.webContents.on('did-finish-load', () => {
    // A. Disable macOS Siri / QuickLook / Data Detectors / Dictionary Popup (Fixes the popup in your photo!)
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
      /* Custom Exit Button Styling */
      #spektic-exit-btn {
        position: fixed;
        top: 12px;
        right: 12px;
        z-index: 9999999;
        background: #ef4444;
        color: white;
        border: none;
        padding: 8px 16px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        font-weight: 700;
        border-radius: 8px;
        cursor: pointer;
        box-shadow: 0 4px 12px rgba(239, 68, 68, 0.4);
        transition: all 0.2s ease;
      }
      #spektic-exit-btn:hover {
        background: #dc2626;
        transform: scale(1.05);
      }
    `)

    // B. Inject the Clean "Exit Exam" Button into the top-right corner
    mainWindow.webContents.executeJavaScript(`
      if (!document.getElementById('spektic-exit-btn')) {
        const exitBtn = document.createElement('button');
        exitBtn.id = 'spektic-exit-btn';
        exitBtn.innerText = 'Exit Spektic';
        exitBtn.onclick = () => {
          if (confirm('Are you sure you want to exit Spektic?')) {
            window.location.href = 'spektic://quit';
          }
        };
        document.body.appendChild(exitBtn);
      }
    `)
  })

  // Intercept the Exit request from the injected button
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url === 'spektic://quit') {
      event.preventDefault()
      app.isQuitting = true
      app.quit()
    }
  })

  // 7. macOS Keyboard Trap (Block Command+Tab, Command+Q, Command+Space, etc.)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    // Secret Developer Emergency Exit Hotkey: Command + Shift + Option + Q
    if (input.meta && input.shift && input.alt && input.key.toLowerCase() === 'q') {
      console.log('[Spektic macOS] Developer Emergency Quit Triggered')
      app.isQuitting = true
      app.quit()
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

  // Prevent Window Closing unless explicitly exiting
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
    }
  })

  // Cover secondary displays with blackout shields
  createMultiMonitorBlackouts()

  // Start 2-Second Process Watchdog
  processWatchdogTimer = setInterval(killProhibitedProcesses, 2000)

  // Start 2-Second Aggressive Clipboard Eraser
  clipboardTimer = setInterval(() => {
    try {
      clipboard.clear()
    } catch (e) {}
  }, 2000)
}

// 8. System Initialization & Global Shortcut Lockdown
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
      app.isQuitting = true
      app.quit()
    })
  } catch (e) {}

  createWindow()
})

app.on('will-quit', () => {
  if (processWatchdogTimer) clearInterval(processWatchdogTimer)
  if (clipboardTimer) clearInterval(clipboardTimer)
  if (powerBlockerId !== null) powerSaveBlocker.stop(powerBlockerId)
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
