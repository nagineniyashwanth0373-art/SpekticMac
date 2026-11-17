const { app, BrowserWindow, globalShortcut, session, powerSaveBlocker, clipboard, screen, ipcMain } = require('electron')
const path = require('path')
const crypto = require('crypto')
const fs = require('fs')
const { exec, execSync } = require('child_process')

// 1. Single-Instance Lock
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) { app.exit(0) }

// 2. WebRTC & Media Permissions CommandLine Switches
app.commandLine.appendSwitch('remote-debugging-port', '0')
app.commandLine.appendSwitch('disable-renderer-accessibility', '1')
app.commandLine.appendSwitch('enable-usermedia-screen-capturing')
app.commandLine.appendSwitch('auto-select-desktop-capture-source', 'Screen')
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')

process.on('uncaughtException', (err) => { 
  console.error('[Spektic] Uncaught:', err)
  try { disableNetworkLockdown() } catch (e) {}
})
process.on('unhandledRejection', (reason) => { 
  console.error('[Spektic] Rejection:', reason) 
})

let mainWindow = null
let appHash = ''
let processWatchdogTimer = null
let clipboardTimer = null
let powerBlockerId = null
let blackoutWindows = []
let isQuitting = false
let isCheckingProcesses = false
let isNetworkLockdownActive = false
let activeNetworkServices = []

// 3. SHA-256 Hash
function calculateAppHash() {
  try {
    const buf = fs.readFileSync(__filename)
    appHash = crypto.createHash('sha256').update(buf).digest('hex')
  } catch (e) {
    appHash = 'INVALID_HASH'
  }
}

// ============================================================
// 4. macOS SYSTEM NETWORK ISOLATION & RESTORATION ENGINE
// ============================================================
// Exactly matches the Windows desktop app behavior:
// While Spektic is running:
//   - All other applications (Chrome, Safari, Slack, Discord, AnyDesk, etc.)
//     have their internet severed via blackhole system proxy (127.0.0.1:9999).
//   - Spektic's internal Chromium session runs with { proxyRules: 'direct://' }
//     which BYPASSES system proxies, giving Spektic full high-speed access
//     for Teams, Meet, WebRTC, and exams.
// When Spektic exits (or crashes):
//   - Internet is SYNCHRONOUSLY relieved/restored to all other apps immediately.
// ============================================================

const LOG_FILE = '/tmp/spektic_network_lockdown.log'
const USER_LOG_DIR = path.join(app.getPath('appData') || '/tmp', 'SpekticLogs')
const USER_LOG_FILE = path.join(USER_LOG_DIR, 'network_lockdown.log')

try {
  if (!fs.existsSync(USER_LOG_DIR)) fs.mkdirSync(USER_LOG_DIR, { recursive: true })
} catch (e) {}

function logLockdown(message, data = null) {
  const ts = new Date().toISOString()
  let line = `[${ts}] ${message}`
  if (data !== null) {
    if (typeof data === 'object') {
      try { line += '\n' + JSON.stringify(data, null, 2) } catch (e) { line += ' ' + String(data) }
    } else {
      line += ' ' + String(data)
    }
  }
  console.log(line)
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8')
    fs.appendFileSync(USER_LOG_FILE, line + '\n', 'utf8')
  } catch (e) {}
}

function getActiveNetworkServices() {
  if (process.platform !== 'darwin') return []
  try {
    const out = execSync('networksetup -listallnetworkservices', { encoding: 'utf8', timeout: 5000 })
    const services = out
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.includes('*') && !s.includes('An asterisk'))
    return services
  } catch (err) {
    logLockdown('⚠️ Failed to query network services:', err.message)
    return ['Wi-Fi', 'Ethernet']
  }
}

function enableNetworkLockdown(callback) {
  logLockdown('================ STARTING macOS NETWORK ISOLATION ================')
  logLockdown(`Process platform: ${process.platform}, PID: ${process.pid}`)

  if (process.platform !== 'darwin') {
    logLockdown('Non-macOS platform detected, skipping macOS network isolation.')
    if (callback) callback()
    return
  }

  activeNetworkServices = getActiveNetworkServices()
  logLockdown('Detected active network services:', activeNetworkServices)

  // Cut down internet for all other apps by blackholing system proxies
  activeNetworkServices.forEach(svc => {
    try {
      execSync(`networksetup -setwebproxy "${svc}" 127.0.0.1 9999`, { timeout: 3000 })
      execSync(`networksetup -setsecurewebproxy "${svc}" 127.0.0.1 9999`, { timeout: 3000 })
      execSync(`networksetup -setsocksfirewallproxy "${svc}" 127.0.0.1 9999`, { timeout: 3000 })
      logLockdown(`🔒 Severed external internet on service: "${svc}" via blackhole proxy 127.0.0.1:9999`)
    } catch (e) {
      logLockdown(`⚠️ Error setting blackhole proxy on "${svc}": ${e.message}`)
    }
  })

  // Start self-healing fallback watchdog script that monitors PID death
  try {
    const pid = process.pid
    const watchdogScript = `#!/bin/bash
# Spektic Mac Emergency Fallback Watchdog
while kill -0 ${pid} 2>/dev/null; do sleep 1; done
echo "[Watchdog] PID ${pid} exited. Relieving network to all apps..." >> /tmp/spektic_network_lockdown.log
SERVICES=$(networksetup -listallnetworkservices 2>/dev/null | grep -v 'An asterisk' | grep -v '\\*')
for s in $SERVICES; do
  networksetup -setwebproxystate "$s" off 2>/dev/null
  networksetup -setsecurewebproxystate "$s" off 2>/dev/null
  networksetup -setsocksfirewallproxystate "$s" off 2>/dev/null
done
/sbin/pfctl -d 2>/dev/null
/sbin/pfctl -f /etc/pf.conf 2>/dev/null
rm -f /tmp/spektic_watchdog.sh
`
    fs.writeFileSync('/tmp/spektic_watchdog.sh', watchdogScript, { mode: 0o755 })
    exec('nohup /tmp/spektic_watchdog.sh > /dev/null 2>&1 &')
  } catch (e) {}

  isNetworkLockdownActive = true
  logLockdown('✅ Network isolation active. All external apps blocked from internet.')
  if (callback) callback()
}

function disableNetworkLockdown() {
  if (process.platform !== 'darwin') return
  logLockdown('🔓 Relieving network lockdown: Restoring internet to all apps...')

  const services = activeNetworkServices.length > 0 ? activeNetworkServices : getActiveNetworkServices()
  services.forEach(svc => {
    try {
      execSync(`networksetup -setwebproxystate "${svc}" off`, { timeout: 3000 })
      execSync(`networksetup -setsecurewebproxystate "${svc}" off`, { timeout: 3000 })
      execSync(`networksetup -setsocksfirewallproxystate "${svc}" off`, { timeout: 3000 })
      logLockdown(`✅ Relieved internet on service: "${svc}" (Proxies disabled)`)
    } catch (e) {
      logLockdown(`⚠️ Error disabling proxy on "${svc}": ${e.message}`)
    }
  })

  // Ensure pfctl and legacy routes are fully restored if touched
  try {
    execSync('/sbin/pfctl -d 2>/dev/null; /sbin/pfctl -f /etc/pf.conf 2>/dev/null', { timeout: 3000 })
  } catch (e) {}

  try {
    if (fs.existsSync('/tmp/spektic_gw.txt')) {
      const gw = fs.readFileSync('/tmp/spektic_gw.txt', 'utf8').trim()
      if (gw) {
        execSync(`/sbin/route add default "${gw}" 2>/dev/null`, { timeout: 3000 })
      }
    }
  } catch (e) {}

  try {
    execSync('rm -f /tmp/spektic_pf.conf /tmp/spektic_fw.sh /tmp/spektic_watchdog.sh /tmp/spektic_gw.txt', { timeout: 2000 })
  } catch (e) {}

  isNetworkLockdownActive = false
  logLockdown('✅ Full internet connectivity restored to all applications.')
}

// 5. Internal Network Security for Spektic Chromium Engine
// Spektic uses direct:// to bypass system proxies completely,
// ensuring Teams, Google Meet, WebRTC, and exams connect at 100% full speed.
const ALLOWED_DOMAINS = [
  'spektic.com', 'vercel.app', 'workers.dev', 'livekit.cloud', 'localhost', '127.0.0.1',
  'teams.microsoft.com', 'teams.live.com', 'skype.com', 'microsoft.com', 'microsoftonline.com', 'live.com', 'office.com',
  'meet.google.com', 'google.com', 'gstatic.com', 'googleusercontent.com',
  'zoom.us',
  'hackerrank.com', 'codility.com', 'leetcode.com', 'github.com'
]

function setupNetworkSecurity() {
  // CRITICAL: direct:// bypasses the blackhole system proxy we set for other apps!
  session.defaultSession.setProxy({ proxyRules: 'direct://' })

  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    try {
      const url = new URL(details.url)
      const hostname = url.hostname.toLowerCase()
      const isAllowed = ALLOWED_DOMAINS.some(d => hostname.includes(d) || hostname === d)
      if (isAllowed || url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'file:') {
        callback({ cancel: false })
      } else {
        // Allow external links (e.g. customized coding tests or dynamic recruiter links)
        callback({ cancel: false })
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
        if (url.includes('spektic.com') || url.includes('vercel.app') || url.includes('workers.dev')) {
          details.requestHeaders['x-secure-exam-key'] = appHash
        }
      } catch (e) {}
      callback({ requestHeaders: details.requestHeaders })
    }
  )

  // Full WebRTC & Media Permissions for Microsoft Teams & Google Meet
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    if (permission === 'media' || permission === 'display-capture' || permission === 'notifications') {
      return cb(true)
    }
    cb(true)
  })

  session.defaultSession.setPermissionCheckHandler((wc, permission, origin) => {
    return true
  })
}

// 6. Process Assassin (Kills Remote Sharing & Cheating Tools)
const PROHIBITED_MAC_APPS = [
  'Google Chrome', 'Google Chrome Canary', 'Chromium',
  'Safari', 'Firefox', 'Microsoft Edge', 'Brave Browser', 'Arc', 'Opera', 'Vivaldi',
  'ScreenCaptureAgent', 'screencapture', 'AirPlayUIAgent', 'TouchBarAgent',
  'QuickTime Player', 'Loom', 'Screenflow', 'Camtasia', 'obs', 'obs64',
  'FaceTime', 'Webex',
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
    stdout.split('\n').forEach(line => {
      const proc = line.trim()
      PROHIBITED_MAC_APPS.forEach(appName => {
        if (proc.toLowerCase().includes(appName.toLowerCase())) {
          exec(`pkill -f -9 "${appName}"`, () => {})
        }
      })
    })
  })
}

// 7. Multi-Monitor Blackout
function createMultiMonitorBlackouts() {
  try {
    blackoutWindows.forEach(w => { try { w.destroy() } catch (e) {} })
    blackoutWindows = []
    const displays = screen.getAllDisplays()
    const primary = screen.getPrimaryDisplay()
    displays.forEach(display => {
      if (display.id !== primary.id) {
        const b = new BrowserWindow({
          x: display.bounds.x, y: display.bounds.y,
          width: display.bounds.width, height: display.bounds.height,
          fullscreen: true, kiosk: true, alwaysOnTop: true, frame: false,
          backgroundColor: '#000000', resizable: false, movable: false,
          minimizable: false, maximizable: false, closable: false
        })
        b.setContentProtection(true)
        b.setAlwaysOnTop(true, 'screen-saver')
        b.setVisibleOnAllWorkspaces(true)
        b.loadURL('data:text/html,<html><body style="background:black;margin:0;padding:0;color:white;display:flex;align-items:center;justify-content:center;font-family:sans-serif;height:100vh;"><h2>Secondary Screen Disabled By Spektic</h2></body></html>')
        blackoutWindows.push(b)
      }
    })
  } catch (e) {}
}

// 8. Safe Quit — Guaranteed Network Restoration
function safeQuit() {
  if (isQuitting) return
  isQuitting = true
  logLockdown('🛑 [Spektic] Safe Quit initiated...')

  if (processWatchdogTimer) clearInterval(processWatchdogTimer)
  if (clipboardTimer) clearInterval(clipboardTimer)
  if (powerBlockerId !== null) { try { powerSaveBlocker.stop(powerBlockerId) } catch (e) {} }

  // 1. SYNCHRONOUSLY RESTORE NETWORK TO ALL APPS
  disableNetworkLockdown()

  // 2. Clear UI & Exit
  try { globalShortcut.unregisterAll() } catch (e) {}
  blackoutWindows.forEach(w => { try { w.destroy() } catch (e) {} })
  if (mainWindow && !mainWindow.isDestroyed()) { try { mainWindow.destroy() } catch (e) {} }

  logLockdown('🛑 [Spektic] Process exiting cleanly.')
  app.exit(0)
}

ipcMain.on('spektic-force-quit', () => { safeQuit() })

// 9. Universal DOM Meeting Info Scrubber (Removes Teams / Meet meeting details)
function injectSecurityUI(wc) {
  try {
    wc.insertCSS(`
      * { -webkit-touch-callout: none !important; }
      #spektic-exit-btn {
        position: fixed !important; top: 16px !important; right: 16px !important;
        z-index: 2147483647 !important; background: #dc2626 !important; color: #fff !important;
        border: 2px solid rgba(255,255,255,0.9) !important; padding: 10px 22px !important;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif !important;
        font-size: 14px !important; font-weight: 800 !important; border-radius: 8px !important;
        cursor: pointer !important; pointer-events: auto !important;
        box-shadow: 0 4px 14px rgba(0,0,0,0.6) !important;
      }
      #spektic-exit-btn:hover { background: #b91c1c !important; transform: scale(1.05) !important; }
    `)

    wc.executeJavaScript(`
      // 1. Exit Button
      if (!document.getElementById('spektic-exit-btn')) {
        const b = document.createElement('button');
        b.id = 'spektic-exit-btn'; b.innerText = '✕ Exit Spektic';
        b.onclick = (e) => { 
          e.preventDefault(); e.stopPropagation();
          if (window.spekticAPI && window.spekticAPI.exitApp) { window.spekticAPI.exitApp(); }
          else { window.location.href = 'https://spektic.com/spektic-quit-action'; }
        };
        document.body.appendChild(b);
      }

      // 2. Meeting Scrubber (Blocks meeting ID / passcode / invite links from leaking)
      if (!window.__spekticScrubberRunning) {
        window.__spekticScrubberRunning = true;
        const scrubSelectors = [
          '[aria-label*="Meeting info" i]',
          '[aria-label*="Meeting details" i]',
          '[aria-label*="Share invite" i]',
          '[aria-label*="Copy link" i]',
          '[data-tid*="meeting-info" i]',
          '[data-tid*="share-invite" i]',
          '[data-tid*="copy-link" i]'
        ];

        function scrubElements() {
          scrubSelectors.forEach(sel => {
            document.querySelectorAll(sel).forEach(el => {
              el.style.setProperty('display', 'none', 'important');
              el.style.setProperty('visibility', 'hidden', 'important');
              el.style.setProperty('pointer-events', 'none', 'important');
            });
          });

          // Text Node Scrubber for passcodes
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
          let node;
          while (node = walker.nextNode()) {
            if (node.nodeValue && /meeting\\s*id|passcode|teams\\.microsoft\\.com\\/l\\/meetup/i.test(node.nodeValue)) {
              node.nodeValue = '[Meeting Shield Protected]';
            }
          }
        }

        setInterval(scrubElements, 800);
      }
    `)
  } catch (e) {}
}

// 10. Create Main Window
function createWindow() {
  calculateAppHash()
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
  mainWindow.webContents.on('context-menu', e => { e.preventDefault() })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const u = url.toLowerCase()
    if (u.includes('spektic-quit-action') || u.includes('quit-exam')) { 
      event.preventDefault()
      safeQuit()
      return 
    }
  })

  session.defaultSession.on('will-download', e => { e.preventDefault() })
  mainWindow.on('close', e => { if (!isQuitting) { e.preventDefault(); safeQuit() } })

  // Support custom target URL argument (e.g. electron . --url="https://...")
  let targetUrl = 'https://spektic.com/join'
  const customUrlArg = process.argv.find(a => a.startsWith('http://') || a.startsWith('https://'))
  if (customUrlArg) {
    targetUrl = customUrlArg
  }

  logLockdown(`Loading target exam URL: ${targetUrl}`)
  mainWindow.loadURL(targetUrl)

  mainWindow.webContents.on('dom-ready', () => { injectSecurityUI(mainWindow.webContents) })
  mainWindow.webContents.on('did-finish-load', () => { injectSecurityUI(mainWindow.webContents) })

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if ((input.meta && input.shift && input.alt && input.key.toLowerCase() === 'q') ||
        (input.meta && input.alt && input.key.toLowerCase() === 'q')) { 
      safeQuit()
      return 
    }
    if (input.meta || input.alt || input.control) {
      if (['tab','q','w','space','r','h','m','c','v'].includes(input.key.toLowerCase())) { 
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

// 11. App Lifecycle & Failsafe Signals
app.whenReady().then(() => {
  const shortcuts = [
    'Command+Tab', 'Command+Q', 'Command+W', 'Command+Space',
    'Command+Option+Esc', 'Command+Shift+3', 'Command+Shift+4', 'Command+Shift+5'
  ]
  shortcuts.forEach(sc => { try { globalShortcut.register(sc, () => {}) } catch (e) {} })
  try { globalShortcut.register('Command+Shift+Option+Q', () => { safeQuit() }) } catch (e) {}

  // 1. Isolate system network (blocks other apps)
  // 2. Open exam window (with direct:// high-speed connectivity)
  enableNetworkLockdown(() => {
    createWindow()
  })
})

// Failsafe shutdown hooks to ensure internet is ALWAYS relieved on exit
process.on('SIGINT', () => safeQuit())
process.on('SIGTERM', () => safeQuit())
process.on('SIGHUP', () => safeQuit())
process.on('exit', () => {
  try { disableNetworkLockdown() } catch (e) {}
})

app.on('before-quit', () => { safeQuit() })
app.on('will-quit', () => { safeQuit() })
app.on('window-all-closed', () => { safeQuit() })
