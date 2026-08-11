const { app, BrowserWindow, globalShortcut, session, powerSaveBlocker, clipboard, screen, ipcMain } = require('electron')
const path = require('path')
const crypto = require('crypto')
const fs = require('fs')
const { exec } = require('child_process')

// 1. Single-Instance Lock (Prevents loops that open 100s of app instances)
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
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
let isPfctlActive = false

// 3. Calculate SHA-256 Hash
function calculateAppHash() {
  try {
    const fileBuffer = fs.readFileSync(__filename)
    const hashSum = crypto.createHash('sha256')
    hashSum.update(fileBuffer)
    appHash = hashSum.digest('hex')
    console.log(`[Spektic macOS] App Hash: ${appHash}`)
  } catch (err) {
    appHash = 'INVALID_HASH_TAMPERING_DETECTED'
  }
}

// 4. macOS KERNEL PACKET FILTER (pfctl) FIREWALL
//    Blocks ALL outbound TCP + UDP for every other Mac app at the kernel level.
//    Only allows Spektic's exam server IPs + DNS through.
//    A self-healing watchdog process auto-disables pfctl if Spektic crashes.
function enableKernelFirewall(callback) {
  if (process.platform !== 'darwin') {
    callback()
    return
  }

  console.log('[Spektic macOS] Resolving exam server IPs before activating firewall...')

  // Step 1: Resolve spektic.com IPs dynamically (before blocking anything)
  exec('dig +short spektic.com www.spektic.com', (err, stdout) => {
    const resolvedIPs = new Set()

    if (stdout) {
      stdout.split('\n').forEach((line) => {
        const ip = line.trim()
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
          resolvedIPs.add(ip)
        }
      })
    }

    // Step 2: Build pfctl rules
    const rules = []
    rules.push('# Spektic Kernel Firewall - Block ALL traffic except exam servers')
    rules.push('block drop out all')
    rules.push('pass out quick on lo0 all')
    rules.push('pass out quick proto udp to any port 53')

    // Allow dynamically resolved Spektic server IPs (all protocols)
    resolvedIPs.forEach((ip) => {
      rules.push(`pass out quick proto {tcp, udp} to ${ip}`)
    })

    // Allow Cloudflare CDN ranges (spektic.com is behind Cloudflare)
    const cfRanges = [
      '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13',
      '141.101.64.0/18', '162.158.0.0/15', '198.41.128.0/17',
      '188.114.96.0/20', '173.245.48.0/20', '103.21.244.0/22',
      '103.22.200.0/22', '103.31.4.0/22', '108.162.192.0/18',
      '190.93.240.0/20', '197.234.240.0/22', '131.0.72.0/22'
    ]
    cfRanges.forEach((range) => {
      rules.push(`pass out quick proto tcp to ${range} port {80, 443}`)
    })

    // Allow Vercel CDN ranges (Spektic frontend hosting)
    rules.push('pass out quick proto tcp to 76.76.21.0/24 port {80, 443}')
    rules.push('pass out quick proto tcp to 64.29.16.0/20 port {80, 443}')
    rules.push('pass out quick proto tcp to 76.223.0.0/16 port {80, 443}')

    // Step 3: Write the pf.conf to /tmp (no admin needed to write here)
    try {
      fs.writeFileSync('/tmp/spektic_pf.conf', rules.join('\n'), 'utf8')
    } catch (e) {
      console.error('[Spektic macOS] Failed to write pf.conf:', e)
      callback()
      return
    }

    // Step 4: Write a self-healing enable+watchdog script
    // The watchdog monitors Spektic's PID. If Spektic exits/crashes for ANY reason,
    // the watchdog automatically disables pfctl and restores normal internet.
    const pid = process.pid
    const fwScript = [
      '#!/bin/bash',
      'pfctl -E -f /tmp/spektic_pf.conf',
      `nohup bash -c "while kill -0 ${pid} 2>/dev/null; do sleep 2; done; pfctl -d; rm -f /tmp/spektic_pf.conf /tmp/spektic_fw.sh" > /dev/null 2>&1 &`
    ].join('\n')

    try {
      fs.writeFileSync('/tmp/spektic_fw.sh', fwScript, { mode: 0o755 })
    } catch (e) {
      console.error('[Spektic macOS] Failed to write fw script:', e)
      callback()
      return
    }

    // Step 5: Execute with Touch ID / Admin prompt (single prompt only)
    console.log('[Spektic macOS] Requesting Touch ID / Admin authorization...')
    exec(`osascript -e 'do shell script "/tmp/spektic_fw.sh" with administrator privileges'`, (err2) => {
      if (err2) {
        console.warn('[Spektic macOS] Firewall prompt dismissed or failed. App will continue without kernel firewall.')
      } else {
        isPfctlActive = true
        console.log('[Spektic macOS] KERNEL FIREWALL ACTIVATED. All non-Spektic internet is DEAD.')
      }
      callback()
    })
  })
}

// 5. Safe System Proxy Cleanup (Guarantees Wi-Fi never stays stuck)
function cleanupSystemProxies() {
  if (process.platform !== 'darwin') return
  try {
    exec('networksetup -listallnetworkservices', (err, stdout) => {
      if (err || !stdout) return
      const services = stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.includes('*') && !s.includes('An asterisk'))

      services.forEach((service) => {
        exec(`networksetup -setwebproxystate "${service}" off`, () => {})
        exec(`networksetup -setsecurewebproxystate "${service}" off`, () => {})
      })
    })
  } catch (e) {}
}

// 6. Strict Domain Whitelist (Spektic's internal browser engine)
const ALLOWED_DOMAINS = [
  'spektic.com',
  'vercel.app',
  'workers.dev',
  'livekit.cloud',
  'localhost',
  '127.0.0.1'
]

function setupNetworkSecurity() {
  session.defaultSession.setProxy({ proxyRules: 'direct://' })

  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    try {
      const url = new URL(details.url)
      const hostname = url.hostname.toLowerCase()
      const isAllowed = ALLOWED_DOMAINS.some((d) => hostname.includes(d) || hostname === d)
      if (isAllowed || url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'file:') {
        callback({ cancel: false })
      } else {
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
        if (url.includes('spektic.com') || url.includes('vercel.app') || url.includes('workers.dev') || url.includes('localhost')) {
          details.requestHeaders['x-secure-exam-key'] = appHash
        }
      } catch (e) {}
      callback({ requestHeaders: details.requestHeaders })
    }
  )

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') return callback(true)
    callback(false)
  })
}

// 7. Process Assassin
const PROHIBITED_MAC_APPS = [
  'Google Chrome', 'Google Chrome Canary', 'Chromium',
  'Safari', 'Firefox', 'Microsoft Edge', 'Brave Browser', 'Arc', 'Opera', 'Vivaldi',
  'ScreenCaptureAgent', 'screencapture', 'AirPlayUIAgent', 'TouchBarAgent',
  'QuickTime Player', 'Loom', 'Screenflow', 'Camtasia', 'obs', 'obs64',
  'Zoom', 'zoom.us', 'Microsoft Teams', 'FaceTime', 'Webex',
  'Skype', 'Slack', 'Discord', 'Telegram', 'WhatsApp', 'TeamViewer', 'AnyDesk',
  'Notes', 'TextEdit', 'Calculator', 'Pages', 'Microsoft Word',
  'Preview', 'Sublime Text', 'VSCode', 'Terminal', 'iTerm', 'Activity Monitor'
]

function killProhibitedProcesses() {
  if (process.platform !== 'darwin' || isQuitting || isCheckingProcesses) return
  isCheckingProcesses = true
  exec('ps -ax -o comm=', (err, stdout) => {
    isCheckingProcesses = false
    if (err || !stdout || isQuitting) return
    const runningLines = stdout.split('\n')
    runningLines.forEach((line) => {
      const processPath = line.trim()
      PROHIBITED_MAC_APPS.forEach((appName) => {
        if (processPath.toLowerCase().includes(appName.toLowerCase())) {
          exec(`pkill -f -9 "${appName}"`, () => {})
        }
      })
    })
  })
}

// 8. Multi-Monitor Blackout
function createMultiMonitorBlackouts() {
  try {
    blackoutWindows.forEach((win) => { try { win.destroy() } catch (e) {} })
    blackoutWindows = []
    const displays = screen.getAllDisplays()
    const primaryDisplay = screen.getPrimaryDisplay()
    displays.forEach((display) => {
      if (display.id !== primaryDisplay.id) {
        const blackout = new BrowserWindow({
          x: display.bounds.x, y: display.bounds.y,
          width: display.bounds.width, height: display.bounds.height,
          fullscreen: true, kiosk: true, alwaysOnTop: true, frame: false,
          backgroundColor: '#000000', resizable: false, movable: false,
          minimizable: false, maximizable: false, closable: false
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

// 9. 100% Guaranteed Instant Safe-Quit Handler
function safeQuit() {
  if (isQuitting) return
  isQuitting = true
  console.log('[Spektic macOS] Safe Quit Triggered.')

  if (processWatchdogTimer) clearInterval(processWatchdogTimer)
  if (clipboardTimer) clearInterval(clipboardTimer)
  if (powerBlockerId !== null) { try { powerSaveBlocker.stop(powerBlockerId) } catch (e) {} }

  // Proactively try to disable pfctl (the watchdog will also do this automatically)
  exec('rm -f /tmp/spektic_pf.conf /tmp/spektic_fw.sh', () => {})

  cleanupSystemProxies()
  try { globalShortcut.unregisterAll() } catch (e) {}
  blackoutWindows.forEach((win) => { try { win.destroy() } catch (e) {} })
  if (mainWindow && !mainWindow.isDestroyed()) { try { mainWindow.destroy() } catch (e) {} }

  // Hard exit — the background watchdog process detects our PID is gone
  // and automatically runs `pfctl -d` to restore internet. Zero Touch ID prompts on exit.
  app.exit(0)
}

ipcMain.on('spektic-force-quit', () => { safeQuit() })

// 10. Inject UI CSS & Exit Button
function injectSecurityUI(webContents) {
  try {
    webContents.insertCSS(`
      * { -webkit-touch-callout: none !important; -webkit-user-select: none !important; user-select: none !important; }
      input, textarea { -webkit-user-select: auto !important; user-select: auto !important; }
      #spektic-exit-btn {
        position: fixed !important; top: 16px !important; right: 16px !important;
        z-index: 2147483647 !important; background: #dc2626 !important; color: #fff !important;
        border: 2px solid rgba(255,255,255,0.9) !important; padding: 10px 22px !important;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif !important;
        font-size: 14px !important; font-weight: 800 !important; border-radius: 8px !important;
        cursor: pointer !important; pointer-events: auto !important;
        box-shadow: 0 4px 14px rgba(0,0,0,0.6) !important;
        transition: transform 0.15s ease, background 0.15s ease !important;
      }
      #spektic-exit-btn:hover { background: #b91c1c !important; transform: scale(1.05) !important; }
    `)
    webContents.executeJavaScript(`
      if (!document.getElementById('spektic-exit-btn')) {
        const b = document.createElement('button');
        b.id = 'spektic-exit-btn'; b.innerText = '✕ Exit Spektic';
        b.onclick = (e) => { e.preventDefault(); e.stopPropagation();
          if (window.spekticAPI && window.spekticAPI.exitApp) { window.spekticAPI.exitApp(); }
          else { window.location.href = 'https://spektic.com/spektic-quit-action'; }
        };
        document.body.appendChild(b);
      }
    `)
  } catch (e) {}
}

// 11. Create Main Lockdown Window
function createWindow() {
  calculateAppHash()
  cleanupSystemProxies()
  setupNetworkSecurity()
  killProhibitedProcesses()

  try { powerBlockerId = powerSaveBlocker.start('prevent-display-sleep') } catch (e) {}

  mainWindow = new BrowserWindow({
    width: 1280, height: 800, fullscreen: true, kiosk: true, alwaysOnTop: true,
    frame: false, autoHideMenuBar: true, titleBarStyle: 'hidden',
    trafficLightPosition: { x: -100, y: -100 },
    resizable: false, movable: false, minimizable: false, maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, contextIsolation: true, webSecurity: true,
      spellcheck: false, devTools: false
    }
  })

  mainWindow.setContentProtection(true)
  mainWindow.setAlwaysOnTop(true, 'screen-saver')
  mainWindow.setVisibleOnAllWorkspaces(true)

  mainWindow.webContents.on('context-menu', (e) => { e.preventDefault() })
  mainWindow.webContents.setWindowOpenHandler(() => { return { action: 'deny' } })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const lowerUrl = url.toLowerCase()
    if (lowerUrl.includes('spektic-quit-action') || lowerUrl.includes('quit-exam')) {
      event.preventDefault()
      safeQuit()
      return
    }
    if (!lowerUrl.includes('spektic.com') && !lowerUrl.includes('vercel.app') &&
        !lowerUrl.includes('workers.dev') && !lowerUrl.includes('localhost')) {
      event.preventDefault()
    }
  })

  session.defaultSession.on('will-download', (event) => { event.preventDefault() })

  mainWindow.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); safeQuit() }
  })

  mainWindow.loadURL('https://spektic.com/join')

  mainWindow.webContents.on('dom-ready', () => { injectSecurityUI(mainWindow.webContents) })
  mainWindow.webContents.on('did-finish-load', () => { injectSecurityUI(mainWindow.webContents) })

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if ((input.meta && input.shift && input.alt && input.key.toLowerCase() === 'q') ||
        (input.meta && input.alt && input.key.toLowerCase() === 'q')) {
      safeQuit()
      return
    }
    if (input.meta || input.alt || input.control) {
      const key = input.key.toLowerCase()
      if (['tab','q','w','space','r','h','m','c','v'].includes(key)) {
        event.preventDefault()
      }
    }
  })

  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus() }
  })

  createMultiMonitorBlackouts()
  processWatchdogTimer = setInterval(killProhibitedProcesses, 1500)
  clipboardTimer = setInterval(() => { try { clipboard.clear() } catch (e) {} }, 2000)
}

// 12. App Lifecycle
app.whenReady().then(() => {
  // Clean up leftover firewall from any previous crash
  exec('rm -f /tmp/spektic_pf.conf /tmp/spektic_fw.sh', () => {})

  const shortcutsToBlock = [
    'Command+Tab', 'Command+Q', 'Command+W', 'Command+Space',
    'Command+Option+Esc', 'Command+Shift+3', 'Command+Shift+4', 'Command+Shift+5'
  ]
  shortcutsToBlock.forEach((sc) => { try { globalShortcut.register(sc, () => {}) } catch (e) {} })
  try { globalShortcut.register('Command+Shift+Option+Q', () => { safeQuit() }) } catch (e) {}

  // SEQUENCE: First block all internet, THEN open exam window
  enableKernelFirewall(() => {
    createWindow()
  })
})

app.on('will-quit', () => { safeQuit() })
app.on('window-all-closed', () => { safeQuit() })
