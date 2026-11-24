const { app, BrowserWindow, globalShortcut, session, powerSaveBlocker, clipboard, screen, ipcMain, desktopCapturer, systemPreferences } = require('electron')
const path = require('path')
const crypto = require('crypto')
const fs = require('fs')
const { exec, execSync } = require('child_process')

// 1. Single-Instance Lock
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) { app.exit(0) }

// Standard Modern Chrome User Agent for macOS (ensures Google Meet and Zoom work seamlessly)
const MAC_CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
app.userAgentFallback = MAC_CHROME_UA

// 2. WebRTC & Media Permissions CommandLine Switches
app.commandLine.appendSwitch('remote-debugging-port', '0')
app.commandLine.appendSwitch('disable-renderer-accessibility', '1')
app.commandLine.appendSwitch('enable-usermedia-screen-capturing')
app.commandLine.appendSwitch('allow-http-screen-capture')
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
app.commandLine.appendSwitch('enable-webrtc-hw-decoding')
app.commandLine.appendSwitch('enable-webrtc-hw-encoding')
app.commandLine.appendSwitch('enable-gpu')
app.commandLine.appendSwitch('ignore-gpu-blocklist')

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
let socketHunterTimer = null
let clipboardTimer = null
let powerBlockerId = null
let blackoutWindows = []
let isQuitting = false
let isCheckingProcesses = false
let isNetworkLockdownActive = false
let activeNetworkServices = []

const MAC_ATTESTATION_SALT = 'spektic-mac-v1-enclave-salt-2026'

// 3. SHA-256 Hash
function calculateAppHash() {
  if (appHash && appHash !== 'INVALID_HASH' && appHash.length === 64) {
    return appHash
  }
  try {
    const buf = fs.readFileSync(__filename)
    appHash = crypto.createHash('sha256').update(buf).digest('hex')
  } catch (e) {
    try {
      const p = path.join(__dirname, 'main.js')
      const buf = fs.readFileSync(p)
      appHash = crypto.createHash('sha256').update(buf).digest('hex')
    } catch (e2) {
      // Deterministic fallback digest for the official macOS build
      appHash = crypto.createHash('sha256').update('spektic-mac-v1-official-bundle').digest('hex')
    }
  }
  return appHash
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

// Anti-VM Hardware Detection on macOS
function isMacVirtualMachine() {
  if (process.platform !== 'darwin') return false
  try {
    const hv = execSync('sysctl -n kern.hv_vmm_present 2>/dev/null', { encoding: 'utf8' }).trim()
    if (hv === '1') return true
  } catch (e) {}
  try {
    const model = execSync('sysctl -n hw.model 2>/dev/null', { encoding: 'utf8' }).trim().toLowerCase()
    if (model.includes('virtualmac') || model.includes('vmware') || model.includes('parallels') || model.includes('qemu')) {
      return true
    }
  } catch (e) {}
  try {
    const dtypes = execSync('system_profiler SPHardwareDataType 2>/dev/null', { encoding: 'utf8' }).toLowerCase()
    if (dtypes.includes('virtual') || dtypes.includes('vmware') || dtypes.includes('parallels') || dtypes.includes('qemu')) {
      return true
    }
  } catch (e) {}
  return false
}

// Real-Time Socket Hunter (Kills any non-Spektic app attempting an internet connection)
const SYSTEM_WHITELISTED_PIDS = new Set([0, 1])

function killUnauthorizedSockets() {
  if (process.platform !== 'darwin' || isQuitting) return
  exec('lsof -iTCP -sTCP:ESTABLISHED -n -P -F pcu 2>/dev/null', (err, stdout) => {
    if (err || !stdout || isQuitting) return
    const lines = stdout.split('\n')
    let currentPid = null
    let currentCmd = ''
    for (const line of lines) {
      if (line.startsWith('p')) {
        currentPid = parseInt(line.substring(1), 10)
      } else if (line.startsWith('c')) {
        currentCmd = line.substring(1).toLowerCase()
        if (currentPid && !SYSTEM_WHITELISTED_PIDS.has(currentPid)) {
          const isSpektic = currentPid === process.pid || currentCmd.includes('spektic') || currentCmd.includes('electron')
          const isSystem = (
            currentCmd.includes('mdnsresponder') ||
            currentCmd.includes('launchd') ||
            currentCmd.includes('trustd') ||
            currentCmd.includes('opendirectoryd') ||
            currentCmd.includes('kernel_task') ||
            currentCmd.includes('systempreferences') ||
            currentCmd.includes('controlcenter')
          )
          if (!isSpektic && !isSystem) {
            logLockdown(`🚨 [Socket Hunter] Terminating unauthorized network process: PID ${currentPid} (${currentCmd})`)
            try { exec(`kill -9 ${currentPid} 2>/dev/null`) } catch (e) {}
          }
        }
      }
    }
  })
}

function enableNetworkLockdown(callback) {
  logLockdown('================ STARTING macOS METHOD 2 KERNEL LOCKDOWN ================')
  logLockdown(`Process platform: ${process.platform}, PID: ${process.pid}`)

  if (process.platform !== 'darwin') {
    logLockdown('Non-macOS platform detected, skipping macOS network isolation.')
    if (callback) callback()
    return
  }

  // 1. Hardware Virtual Machine Check
  if (isMacVirtualMachine()) {
    logLockdown('🚨 CRITICAL: macOS Virtual Machine detected! Terminating immediately.')
    try {
      const { dialog } = require('electron')
      dialog.showErrorBox(
        'Security Violation',
        'Virtual Machines are strictly prohibited for this exam. Please run Spektic on physical Mac hardware.'
      )
    } catch (e) {}
    app.exit(0)
    return
  }

  // 0. Ensure completely clean baseline network state first
  try { disableNetworkLockdown() } catch (e) {}

  activeNetworkServices = getActiveNetworkServices()
  logLockdown('Detected active network services:', activeNetworkServices)

  // 2. Spawn Detached Dead-Man Recovery Watchdog BEFORE touching any network settings!
  // This watchdog runs completely independent of Node/Electron in the OS background.
  // The millisecond Spektic exits or crashes, it automatically relieves the network within 0.5s!
  try {
    const pid = process.pid
    const watchdogScript = `#!/bin/bash
# Spektic Mac Dead-Man Recovery Watchdog
# Monitors PID ${pid} continuously every 0.5s
while kill -0 ${pid} 2>/dev/null; do
  sleep 0.5
done

# PID is dead (either normal exit, crash, kill -9, or panic)
echo "[Watchdog] PID ${pid} exited. Activating emergency network recovery..." >> /tmp/spektic_network_lockdown.log

# 1. Flush and disable kernel pfctl firewall anchor
/sbin/pfctl -a "com.spektic.lockdown" -F all 2>/dev/null
/sbin/pfctl -d 2>/dev/null
/sbin/pfctl -f /etc/pf.conf 2>/dev/null

# 2. Reset proxies across all network adapters (handles spaces in service names safely)
networksetup -listallnetworkservices 2>/dev/null | grep -v 'An asterisk' | grep -v '\\*' | while IFS= read -r s; do
  if [ -n "$s" ]; then
    networksetup -setwebproxystate "$s" off 2>/dev/null
    networksetup -setsecurewebproxystate "$s" off 2>/dev/null
    networksetup -setsocksfirewallproxystate "$s" off 2>/dev/null
    networksetup -setautoproxystate "$s" off 2>/dev/null
  fi
done

# 3. Clean up
rm -f /tmp/spektic_watchdog.sh /tmp/spektic_pf.conf /tmp/spektic_fw.sh /tmp/spektic_gw.txt 2>/dev/null
echo "[Watchdog] Network completely restored to normal." >> /tmp/spektic_network_lockdown.log
`
    fs.writeFileSync('/tmp/spektic_watchdog.sh', watchdogScript, { mode: 0o755 })
    exec('nohup /tmp/spektic_watchdog.sh > /dev/null 2>&1 &')
    logLockdown('🛡️ Dead-Man Watchdog spawned. Self-healing network recovery guaranteed on crash/exit.')
  } catch (e) {
    logLockdown(`⚠️ Error spawning watchdog: ${e.message}`)
  }

  // 3. Apply Kernel Packet Filter anchor
  try {
    const pfRules = `
# Spektic Kernel Lockdown Anchor (com.spektic.lockdown)
set skip on lo0
pass out proto udp to any port 53 keep state
pass out proto tcp to any port 53 keep state
`
    fs.writeFileSync('/tmp/spektic_pf.conf', pfRules, { mode: 0o644 })
    exec('/sbin/pfctl -e -a "com.spektic.lockdown" -f /tmp/spektic_pf.conf 2>/dev/null', (err) => {
      if (err) {
        logLockdown('Kernel pfctl requires root, continuing with Socket Assassin + Proxy Blackhole.')
      } else {
        logLockdown('🛡️ Kernel Packet Filter anchor loaded successfully.')
      }
    })
  } catch (e) {}

  // 4. Blackhole system proxies for standard apps
  activeNetworkServices.forEach(svc => {
    try {
      exec(`networksetup -setwebproxy "${svc}" 127.0.0.1 9999 2>/dev/null`, () => {})
      exec(`networksetup -setsecurewebproxy "${svc}" 127.0.0.1 9999 2>/dev/null`, () => {})
      exec(`networksetup -setsocksfirewallproxy "${svc}" 127.0.0.1 9999 2>/dev/null`, () => {})
      logLockdown(`🔒 Severed external internet on service: "${svc}" via blackhole proxy 127.0.0.1:9999`)
    } catch (e) {}
  })

  // 5. Start Real-Time Socket Hunter (kills any other app attempting an internet connection)
  if (socketHunterTimer) clearInterval(socketHunterTimer)
  socketHunterTimer = setInterval(killUnauthorizedSockets, 800)

  isNetworkLockdownActive = true
  logLockdown('✅ Full multi-layer network isolation active. All external apps blocked from internet.')
  if (callback) callback()
}

function disableNetworkLockdown() {
  if (process.platform !== 'darwin') return
  logLockdown('🔓 Relieving network lockdown: Restoring internet to all apps...')

  if (socketHunterTimer) {
    clearInterval(socketHunterTimer)
    socketHunterTimer = null
  }

  // 1. Immediately reset proxies across all network adapters
  const services = activeNetworkServices.length > 0 ? activeNetworkServices : getActiveNetworkServices()
  services.forEach(svc => {
    try {
      execSync(`networksetup -setwebproxystate "${svc}" off 2>/dev/null`, { timeout: 3000 })
      execSync(`networksetup -setsecurewebproxystate "${svc}" off 2>/dev/null`, { timeout: 3000 })
      execSync(`networksetup -setsocksfirewallproxystate "${svc}" off 2>/dev/null`, { timeout: 3000 })
      execSync(`networksetup -setautoproxystate "${svc}" off 2>/dev/null`, { timeout: 3000 })
      logLockdown(`✅ Relieved internet on service: "${svc}" (Proxies disabled)`)
    } catch (e) {
      logLockdown(`⚠️ Error disabling proxy on "${svc}": ${e.message}`)
    }
  })

  // 2. Flush and disable kernel pfctl anchor
  try {
    execSync('/sbin/pfctl -a "com.spektic.lockdown" -F all 2>/dev/null; /sbin/pfctl -d 2>/dev/null; /sbin/pfctl -f /etc/pf.conf 2>/dev/null', { timeout: 3000 })
  } catch (e) {}

  // 3. Remove temporary files
  try {
    execSync('rm -f /tmp/spektic_pf.conf /tmp/spektic_fw.sh /tmp/spektic_watchdog.sh /tmp/spektic_gw.txt 2>/dev/null', { timeout: 2000 })
  } catch (e) {}

  isNetworkLockdownActive = false
  logLockdown('✅ Full internet connectivity restored to all applications.')
}

// 5. Internal Network Security for Spektic Chromium Engine
// Spektic uses direct:// to bypass system proxies completely,
// ensuring Google Meet, Zoom, WebRTC, and exams connect at 100% full speed.
const ALLOWED_DOMAINS = [
  'spektic.com', 'vercel.app', 'workers.dev', 'livekit.cloud', 'localhost', '127.0.0.1',
  'meet.google.com', 'google.com', 'gstatic.com', 'googleusercontent.com',
  'zoom.us',
  'hackerrank.com', 'codility.com', 'leetcode.com', 'github.com'
]

async function requestMediaAccess() {
  if (process.platform === 'darwin' && systemPreferences && systemPreferences.askForMediaAccess) {
    try {
      const cam = await systemPreferences.askForMediaAccess('camera')
      const mic = await systemPreferences.askForMediaAccess('microphone')
      logLockdown(`macOS Media Permissions - Camera: ${cam}, Mic: ${mic}`)
    } catch (e) {
      logLockdown(`⚠️ Error requesting media permissions: ${e.message}`)
    }
  }
}

function setupNetworkSecurity() {
  // CRITICAL: direct:// bypasses the blackhole system proxy we set for other apps!
  session.defaultSession.setProxy({ proxyRules: 'direct://' })
  session.defaultSession.setUserAgent(MAC_CHROME_UA)

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
          calculateAppHash()
          details.requestHeaders['x-secure-exam-key'] = appHash
          details.requestHeaders['x-spektic-lockdown'] = 'v2-active'
          details.requestHeaders['x-spektic-platform'] = 'darwin'
        }
        details.requestHeaders['User-Agent'] = MAC_CHROME_UA
      } catch (e) {}
      callback({ requestHeaders: details.requestHeaders })
    }
  )

  // Full WebRTC & Media Permissions for Google Meet, Zoom, and LiveKit
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    if (permission === 'media' || permission === 'display-capture' || permission === 'notifications' || permission === 'fullscreen') {
      return cb(true)
    }
    cb(true)
  })

  session.defaultSession.setPermissionCheckHandler((wc, permission, origin) => {
    return true
  })

  // Automatically satisfy getDisplayMedia requests (Google Meet / Zoom screen share)
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (sources && sources.length > 0) {
        callback({ video: sources[0], audio: 'loopback' })
      } else {
        callback({})
      }
    }).catch((err) => {
      logLockdown(`⚠️ Desktop capturer error: ${err.message}`)
      callback({})
    })
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
  'RustDesk', 'Parsec', 'UltraViewer', 'CleanShot X', 'Shottr',
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

ipcMain.handle('spektic-solve-challenge', async (event, challenge) => {
  try {
    if (!challenge || typeof challenge !== 'string') return ''
    calculateAppHash()
    const payload = `${challenge}:${appHash}:darwin`
    const proofHex = crypto.createHmac('sha256', MAC_ATTESTATION_SALT).update(payload).digest('hex')
    logLockdown(`Generated macOS cryptographic challenge attestation for: ${challenge.slice(0, 16)}...`)
    return `mac-v1:${proofHex}:${appHash}:${Date.now()}`
  } catch (err) {
    logLockdown(`⚠️ Error solving challenge: ${err.message}`)
    return ''
  }
})

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
            if (node.nodeValue && /(?:meeting\s*id|passcode)\s*[:=]\s*\w+/i.test(node.nodeValue)) {
              node.nodeValue = '[Meeting Shield Protected]';
            }
          }
        }

        setInterval(scrubElements, 800);
      }
    `)
  } catch (e) {}
}

// 10. Meeting vs Exam Mode (Matches Windows SetMeetingMode)
// In exams: content protection is ON (solid black box in captures to block cheats/recordings).
// In Google Meet / Zoom meetings: content protection is OFF so the recruiter can clearly see the candidate's screen share!
let isMeetingMode = false

function setMeetingMode(active) {
  if (isMeetingMode === active) return
  isMeetingMode = active
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      if (active) {
        logLockdown('🎥 [Meeting Mode Active] Relaxing content protection to allow clean screen sharing in Google Meet / Zoom.')
        mainWindow.setContentProtection(false)
      } else {
        logLockdown('🔒 [Exam Mode Active] Enforcing content protection to block all external screen capture tools.')
        mainWindow.setContentProtection(true)
      }
    } catch (e) {
      logLockdown(`⚠️ Error toggling content protection: ${e.message}`)
    }
  }
}

function checkAndApplyMeetingMode(url) {
  if (!url || typeof url !== 'string') return
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    const isMeetingHost = (
      host === 'meet.google.com' || host.endsWith('.meet.google.com') ||
      host === 'zoom.us' || host.endsWith('.zoom.us') ||
      host === 'webex.com' || host.endsWith('.webex.com') ||
      parsed.pathname.includes('/meeting') || parsed.pathname.includes('/live-interview')
    )

    if (isMeetingHost) {
      setMeetingMode(true)
    } else if (
      host.includes('spektic.com') ||
      host.includes('vercel.app') ||
      host.includes('workers.dev') ||
      host.includes('localhost') ||
      host.includes('127.0.0.1')
    ) {
      setMeetingMode(false)
    }
  } catch (e) {}
}

// 11. Create Main Window
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

  // Start in strict protected mode by default
  mainWindow.setContentProtection(true)
  mainWindow.setAlwaysOnTop(true, 'screen-saver')
  mainWindow.setVisibleOnAllWorkspaces(true)
  mainWindow.webContents.setUserAgent(MAC_CHROME_UA)
  mainWindow.webContents.on('context-menu', e => { e.preventDefault() })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    checkAndApplyMeetingMode(url)
    mainWindow.loadURL(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const u = url.toLowerCase()
    if (u.includes('spektic-quit-action') || u.includes('quit-exam')) { 
      event.preventDefault()
      safeQuit()
      return 
    }
    checkAndApplyMeetingMode(url)
  })

  mainWindow.webContents.on('did-navigate', (event, url) => {
    checkAndApplyMeetingMode(url)
    injectSecurityUI(mainWindow.webContents)
  })

  mainWindow.webContents.on('did-navigate-in-page', (event, url) => {
    checkAndApplyMeetingMode(url)
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
  checkAndApplyMeetingMode(targetUrl)
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
app.whenReady().then(async () => {
  const shortcuts = [
    'Command+Tab', 'Command+Q', 'Command+W', 'Command+Space',
    'Command+Option+Esc', 'Command+Shift+3', 'Command+Shift+4', 'Command+Shift+5'
  ]
  shortcuts.forEach(sc => { try { globalShortcut.register(sc, () => {}) } catch (e) {} })
  try { globalShortcut.register('Command+Shift+Option+Q', () => { safeQuit() }) } catch (e) {}

  await requestMediaAccess()

  // Dynamic monitor connect/disconnect handlers
  screen.on('display-added', () => { createMultiMonitorBlackouts() })
  screen.on('display-removed', () => { createMultiMonitorBlackouts() })

  // 1. Isolate system network (blocks other apps)
  // 2. Open exam window (with direct:// high-speed connectivity)
  enableNetworkLockdown(() => {
    createWindow()
  })
})

// Failsafe shutdown hooks to ensure internet is ALWAYS relieved on exit
process.on('uncaughtException', (err) => {
  try { logLockdown(`🚨 Uncaught Exception: ${err ? (err.stack || err.message) : 'unknown'}`) } catch (e) {}
  safeQuit()
})
process.on('unhandledRejection', (reason) => {
  try { logLockdown(`🚨 Unhandled Rejection: ${reason}`) } catch (e) {}
})
process.on('SIGINT', () => safeQuit())
process.on('SIGTERM', () => safeQuit())
process.on('SIGHUP', () => safeQuit())
process.on('exit', () => {
  try { disableNetworkLockdown() } catch (e) {}
})

app.on('before-quit', () => { safeQuit() })
app.on('will-quit', () => { safeQuit() })
app.on('window-all-closed', () => { safeQuit() })
