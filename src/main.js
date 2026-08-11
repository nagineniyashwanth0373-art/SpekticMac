const { app, BrowserWindow, globalShortcut, session, powerSaveBlocker, clipboard, screen, ipcMain } = require('electron')
const path = require('path')
const crypto = require('crypto')
const fs = require('fs')
const { exec } = require('child_process')

// 1. Single-Instance Lock
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) { app.exit(0) }

// 2. Global Crash Prevention
app.commandLine.appendSwitch('remote-debugging-port', '0')
app.commandLine.appendSwitch('disable-renderer-accessibility', '1')
process.on('uncaughtException', (err) => { console.error('[Spektic] Uncaught:', err) })
process.on('unhandledRejection', (reason) => { console.error('[Spektic] Rejection:', reason) })

let mainWindow = null
let appHash = ''
let processWatchdogTimer = null
let clipboardTimer = null
let powerBlockerId = null
let blackoutWindows = []
let isQuitting = false
let isCheckingProcesses = false
let isFirewallActive = false

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
// 4. PERSISTENT LOGGING & DUAL-LAYER macOS NETWORK LOCKDOWN
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

function runNetworkLockdownVerifiers(callback) {
  logLockdown('--- RUNNING AUTOMATED NETWORK LOCKDOWN VERIFIERS ---')
  const results = {
    timestamp: new Date().toISOString(),
    defaultRouteDeleted: false,
    pfctlStatus: 'UNKNOWN',
    pfctlBlockRuleActive: false,
    externalTrafficBlocked: false,
    spekticWhitelisted: false,
    details: {}
  }

  // 1. Check Route Table
  exec('/sbin/route -n get default', (err, stdout, stderr) => {
    const routeOut = (stdout || '') + (stderr || '')
    if (err || routeOut.includes('not in table') || routeOut.includes('not found')) {
      results.defaultRouteDeleted = true
      results.details.routeCheck = 'PASS: Default route deleted from routing table'
      logLockdown('✅ [VERIFIER 1/4 - ROUTE TABLE]: Default gateway successfully removed (PASS)')
    } else {
      results.defaultRouteDeleted = false
      results.details.routeCheck = `FAIL: Default route still exists: ${routeOut.trim()}`
      logLockdown('❌ [VERIFIER 1/4 - ROUTE TABLE]: Default gateway route still active!', routeOut.trim())
    }

    // 2. Check PFCTL Status & Rules
    exec('/sbin/pfctl -s info 2>&1; echo "---RULES---"; /sbin/pfctl -s rules 2>&1', (pfErr, pfOut) => {
      const pfStr = String(pfOut || '')
      results.details.pfOutput = pfStr

      if (pfStr.toLowerCase().includes('status: enabled')) {
        results.pfctlStatus = 'ENABLED'
        logLockdown('✅ [VERIFIER 2/4 - KERNEL PF]: pfctl is ACTIVE & ENABLED (PASS)')
      } else {
        results.pfctlStatus = 'DISABLED'
        logLockdown('❌ [VERIFIER 2/4 - KERNEL PF]: pfctl is DISABLED (FAIL)')
      }

      if (pfStr.includes('block drop out all')) {
        results.pfctlBlockRuleActive = true
        logLockdown('✅ [VERIFIER 2b - KERNEL RULES]: "block drop out all" rule is actively loaded (PASS)')
      } else {
        results.pfctlBlockRuleActive = false
        logLockdown('❌ [VERIFIER 2b - KERNEL RULES]: "block drop out all" rule is MISSING (FAIL)')
      }

      // 3. Test External Traffic Block (Google test)
      exec('curl -I -s --connect-timeout 2 --max-time 3 https://www.google.com 2>&1', (curlErr, curlOut) => {
        const cOut = String(curlOut || '')
        if (curlErr || !cOut || cOut.includes('Could not resolve') || cOut.includes('timed out') || cOut.includes('Failed to connect') || cOut.includes('Network is unreachable') || cOut.includes('Connection refused')) {
          results.externalTrafficBlocked = true
          results.details.externalBlock = `PASS: External Google request blocked (${curlErr ? curlErr.message : 'Blocked'})`
          logLockdown('✅ [VERIFIER 3/4 - EXTERNAL BLOCK]: Google.com is UNREACHABLE (PASS - Internet Blocked)')
        } else {
          results.externalTrafficBlocked = false
          results.details.externalBlock = `FAIL: Google request succeeded! ${cOut.slice(0, 100)}`
          logLockdown('❌ [VERIFIER 3/4 - EXTERNAL BLOCK]: Google.com was REACHABLE! (FAIL - Internet NOT blocked)', cOut.slice(0, 120))
        }

        // 4. Test Spektic Whitelist (spektic.com)
        exec('curl -I -s --connect-timeout 4 --max-time 6 https://spektic.com/join 2>&1', (spkErr, spkOut) => {
          const sOut = String(spkOut || '')
          if (!spkErr && sOut && (sOut.includes('HTTP/') || sOut.includes('200') || sOut.includes('301') || sOut.includes('302') || sOut.includes('308'))) {
            results.spekticWhitelisted = true
            results.details.spekticAccess = 'PASS: Spektic exam server is reachable'
            logLockdown('✅ [VERIFIER 4/4 - WHITELIST TEST]: Spektic.com is REACHABLE (PASS)')
          } else {
            results.spekticWhitelisted = false
            results.details.spekticAccess = `WARN: Spektic response: ${spkErr ? spkErr.message : sOut}`
            logLockdown('⚠️ [VERIFIER 4/4 - WHITELIST TEST]: Spektic.com test response:', spkErr ? spkErr.message : sOut)
          }

          logLockdown('================ NETWORK LOCKDOWN VERIFICATION SUMMARY ================', results)
          if (callback) callback(results)
        })
      })
    })
  })
}

function enableNetworkLockdown(callback) {
  logLockdown('================ STARTING NETWORK LOCKDOWN ================')
  logLockdown(`Process platform: ${process.platform}, PID: ${process.pid}`)
  logLockdown(`Log file path: ${LOG_FILE}`)
  logLockdown(`User accessible log: ${USER_LOG_FILE}`)

  if (process.platform !== 'darwin') {
    logLockdown('Non-macOS platform detected, skipping macOS pfctl lockdown.')
    callback()
    return
  }

  logLockdown('Step 1: Resolving exam server IPs via DNS...')

  // Resolve spektic.com to get its actual IPs before blocking
  exec('dig +short spektic.com www.spektic.com', { timeout: 6000 }, (err, dnsOut) => {
    const resolvedIPs = []
    if (dnsOut) {
      dnsOut.split('\n').forEach(line => {
        const ip = line.trim()
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
          resolvedIPs.push(ip)
        }
      })
    }
    logLockdown('Resolved Spektic Server IPs:', resolvedIPs)

    // Cloudflare CDN IP ranges
    const cfRanges = [
      '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13',
      '141.101.64.0/18', '162.158.0.0/15', '198.41.128.0/17',
      '188.114.96.0/20', '173.245.48.0/20', '103.21.244.0/22',
      '103.22.200.0/22', '103.31.4.0/22', '108.162.192.0/18',
      '190.93.240.0/20', '197.234.240.0/22', '131.0.72.0/22'
    ]
    // Vercel CDN ranges
    const vercelRanges = ['76.76.21.0/24', '64.29.16.0/20', '76.223.0.0/16']

    // ---- Write pfctl rules file ----
    const pfLines = []
    pfLines.push('# Spektic Kernel Firewall')
    pfLines.push('set skip on lo0')
    pfLines.push('')
    pfLines.push('# Block ALL outbound traffic by default')
    pfLines.push('block drop out all')
    pfLines.push('')
    pfLines.push('# Allow DNS resolution')
    pfLines.push('pass out quick proto udp to any port 53')
    pfLines.push('pass out quick proto tcp to any port 53')
    pfLines.push('')
    pfLines.push('# Allow resolved Spektic server IPs (all protocols)')
    resolvedIPs.forEach(ip => {
      pfLines.push(`pass out quick proto {tcp, udp} to ${ip}`)
    })
    pfLines.push('')
    pfLines.push('# Allow Cloudflare CDN (where spektic.com is hosted)')
    cfRanges.forEach(r => {
      pfLines.push(`pass out quick proto tcp to ${r} port {80, 443}`)
    })
    pfLines.push('')
    pfLines.push('# Allow Vercel CDN')
    vercelRanges.forEach(r => {
      pfLines.push(`pass out quick proto tcp to ${r} port {80, 443}`)
    })

    try {
      fs.writeFileSync('/tmp/spektic_pf.conf', pfLines.join('\n'), 'utf8')
      logLockdown('Wrote /tmp/spektic_pf.conf with rules:\n' + pfLines.join('\n'))
    } catch (e) {
      logLockdown('❌ Failed to write pf.conf:', e.message)
      callback()
      return
    }

    // ---- Write the watchdog auto-restore script ----
    const pid = process.pid
    const watchdogLines = [
      '#!/bin/bash',
      '# Spektic Watchdog: monitors PID and auto-restores network on exit/crash',
      `while kill -0 ${pid} 2>/dev/null; do sleep 2; done`,
      '',
      'echo "[Watchdog] PID exited — restoring network..." >> /tmp/spektic_network_lockdown.log',
      'GW=$(cat /tmp/spektic_gw.txt 2>/dev/null)',
      'if [ -n "$GW" ]; then',
      '  /sbin/route add default "$GW" >> /tmp/spektic_network_lockdown.log 2>&1',
      'fi',
      '/sbin/pfctl -d >> /tmp/spektic_network_lockdown.log 2>&1',
      '/sbin/pfctl -f /etc/pf.conf >> /tmp/spektic_network_lockdown.log 2>&1',
      '/sbin/pfctl -E >> /tmp/spektic_network_lockdown.log 2>&1',
      'rm -f /tmp/spektic_pf.conf /tmp/spektic_fw.sh /tmp/spektic_watchdog.sh /tmp/spektic_gw.txt',
    ]
    try {
      fs.writeFileSync('/tmp/spektic_watchdog.sh', watchdogLines.join('\n'), { mode: 0o755 })
      logLockdown('Wrote /tmp/spektic_watchdog.sh')
    } catch (e) {
      logLockdown('❌ Failed to write watchdog:', e.message)
      callback()
      return
    }

    // ---- Write the main firewall enable script ----
    const fwLines = []
    fwLines.push('#!/bin/bash')
    fwLines.push('exec >> /tmp/spektic_fw_exec.log 2>&1')
    fwLines.push('echo "=== EXECUTING SPEKTIC FIREWALL SCRIPT $(date) ==="')
    fwLines.push('')
    fwLines.push('# Restore any leftover state from a previous run')
    fwLines.push('OLD_GW=$(cat /tmp/spektic_gw.txt 2>/dev/null)')
    fwLines.push('if [ -n "$OLD_GW" ]; then')
    fwLines.push('  /sbin/route add default "$OLD_GW" 2>/dev/null')
    fwLines.push('  sleep 0.2')
    fwLines.push('fi')
    fwLines.push('')
    fwLines.push('# Get the current default gateway')
    fwLines.push("GW=$(/sbin/route -n get default 2>/dev/null | grep 'gateway:' | awk '{print $2}')")
    fwLines.push('if [ -z "$GW" ]; then')
    fwLines.push("  GW=$(netstat -rn -f inet 2>/dev/null | grep '^default' | awk '{print $2}' | head -n 1)")
    fwLines.push('fi')
    fwLines.push('echo "Detected Default Gateway: $GW"')
    fwLines.push('if [ -n "$GW" ]; then')
    fwLines.push('  echo "$GW" > /tmp/spektic_gw.txt')
    fwLines.push('fi')
    fwLines.push('')
    fwLines.push('# Get configured DNS servers')
    fwLines.push("DNS_SERVERS=$(scutil --dns 2>/dev/null | grep 'nameserver' | awk '{print $3}' | sort -u)")
    fwLines.push('echo "DNS Servers: $DNS_SERVERS"')
    fwLines.push('')
    fwLines.push('# ======== LAYER 1: ROUTE TABLE ========')
    fwLines.push('if [ -n "$GW" ]; then')
    fwLines.push('  echo "Deleting default routes..."')
    fwLines.push('  /sbin/route -n delete default')
    fwLines.push('  /sbin/route -n delete -inet6 default 2>/dev/null')
    fwLines.push('')
    fwLines.push('  echo "Adding Spektic server whitelist routes..."')
    resolvedIPs.forEach(ip => {
      fwLines.push(`  /sbin/route -n add -host ${ip} "$GW"`)
    })
    fwLines.push('')
    fwLines.push('  echo "Adding Cloudflare & Vercel CDN routes..."')
    cfRanges.forEach(r => {
      fwLines.push(`  /sbin/route -n add -net ${r} "$GW"`)
    })
    vercelRanges.forEach(r => {
      fwLines.push(`  /sbin/route -n add -net ${r} "$GW"`)
    })
    fwLines.push('')
    fwLines.push('  echo "Adding DNS server routes..."')
    fwLines.push('  for DNS in $DNS_SERVERS; do')
    fwLines.push('    /sbin/route -n add -host "$DNS" "$GW" 2>/dev/null')
    fwLines.push('  done')
    fwLines.push('  /sbin/route -n add -host 8.8.8.8 "$GW" 2>/dev/null')
    fwLines.push('  /sbin/route -n add -host 8.8.4.4 "$GW" 2>/dev/null')
    fwLines.push('  /sbin/route -n add -host 1.1.1.1 "$GW" 2>/dev/null')
    fwLines.push('  /sbin/route -n add -host 1.0.0.1 "$GW" 2>/dev/null')
    fwLines.push('fi')
    fwLines.push('')
    fwLines.push('# ======== LAYER 2: PACKET FILTER (pfctl) ========')
    fwLines.push('echo "Enabling kernel pfctl packet filter..."')
    fwLines.push('/sbin/pfctl -d 2>/dev/null')
    fwLines.push('/sbin/pfctl -f /tmp/spektic_pf.conf')
    fwLines.push('/sbin/pfctl -E')
    fwLines.push('')
    fwLines.push('# ======== SELF-HEALING WATCHDOG ========')
    fwLines.push('echo "Starting watchdog..."')
    fwLines.push('nohup bash /tmp/spektic_watchdog.sh > /dev/null 2>&1 &')
    fwLines.push('echo "=== SCRIPT FINISHED $(date) ==="')

    try {
      fs.writeFileSync('/tmp/spektic_fw.sh', fwLines.join('\n'), { mode: 0o755 })
      logLockdown('Wrote /tmp/spektic_fw.sh')
    } catch (e) {
      logLockdown('❌ Failed to write fw script:', e.message)
      callback()
      return
    }

    // ---- Execute with Touch ID / Admin prompt ----
    logLockdown('Step 2: Requesting Touch ID / Admin authorization for network lockdown...')
    const appleScriptCmd = 'osascript -e \'do shell script "/bin/bash /tmp/spektic_fw.sh" with administrator privileges\''
    logLockdown(`Executing command: ${appleScriptCmd}`)

    exec(appleScriptCmd, { timeout: 60000 }, (err3, stdout3, stderr3) => {
      if (err3) {
        logLockdown('❌ Network lockdown script execution FAILED / DISMISSED:', {
          error: err3.message,
          code: err3.code,
          signal: err3.signal,
          stderr: stderr3
        })
      } else {
        isFirewallActive = true
        logLockdown('✅ Network lockdown script executed successfully!', {
          stdout: stdout3,
          stderr: stderr3
        })
      }

      // Check /tmp/spektic_fw_exec.log for granular execution details
      try {
        if (fs.existsSync('/tmp/spektic_fw_exec.log')) {
          const execLog = fs.readFileSync('/tmp/spektic_fw_exec.log', 'utf8')
          logLockdown('--- /tmp/spektic_fw_exec.log output ---\n' + execLog)
        }
      } catch (e) {}

      // Step 3: Run comprehensive verification checks
      runNetworkLockdownVerifiers((verResult) => {
        logLockdown('Lockdown activation & verification complete.', verResult)
        callback()
      })
    })
  })
}

// 5. System Proxy Cleanup
function cleanupSystemProxies() {
  if (process.platform !== 'darwin') return
  try {
    exec('networksetup -listallnetworkservices', (err, stdout) => {
      if (err || !stdout) return
      const services = stdout.split('\n').map(s => s.trim()).filter(s => s.length > 0 && !s.includes('*') && !s.includes('An asterisk'))
      services.forEach(svc => {
        exec(`networksetup -setwebproxystate "${svc}" off`, () => {})
        exec(`networksetup -setsecurewebproxystate "${svc}" off`, () => {})
      })
    })
  } catch (e) {}
}

// 6. Domain Whitelist (Spektic's internal browser engine layer)
const ALLOWED_DOMAINS = ['spektic.com', 'vercel.app', 'workers.dev', 'livekit.cloud', 'localhost', '127.0.0.1']

function setupNetworkSecurity() {
  session.defaultSession.setProxy({ proxyRules: 'direct://' })
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    try {
      const url = new URL(details.url)
      const hostname = url.hostname.toLowerCase()
      const isAllowed = ALLOWED_DOMAINS.some(d => hostname.includes(d) || hostname === d)
      if (isAllowed || url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'file:') {
        callback({ cancel: false })
      } else {
        callback({ cancel: true })
      }
    } catch (e) { callback({ cancel: false }) }
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
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    if (permission === 'media') return cb(true)
    cb(false)
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

// 8. Multi-Monitor Blackout
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
        b.loadURL('data:text/html,<html><body style="background:black;margin:0;padding:0"></body></html>')
        blackoutWindows.push(b)
      }
    })
  } catch (e) {}
}

// 9. Safe Quit — restores internet, no second Touch ID prompt
function safeQuit() {
  if (isQuitting) return
  isQuitting = true
  logLockdown('🛑 [Spektic] Safe Quit initiated — cleaning up and exiting...')

  if (processWatchdogTimer) clearInterval(processWatchdogTimer)
  if (clipboardTimer) clearInterval(clipboardTimer)
  if (powerBlockerId !== null) { try { powerSaveBlocker.stop(powerBlockerId) } catch (e) {} }

  // Proactive cleanup (best effort — watchdog handles the rest automatically)
  exec('rm -f /tmp/spektic_pf.conf /tmp/spektic_fw.sh', () => {})
  cleanupSystemProxies()

  try { globalShortcut.unregisterAll() } catch (e) {}
  blackoutWindows.forEach(w => { try { w.destroy() } catch (e) {} })
  if (mainWindow && !mainWindow.isDestroyed()) { try { mainWindow.destroy() } catch (e) {} }

  logLockdown('🛑 [Spektic] Process exiting. Watchdog will restore default routes and pfctl.')
  // Exit — watchdog detects PID death and auto-restores default route + pfctl
  app.exit(0)
}

ipcMain.on('spektic-force-quit', () => { safeQuit() })

// 10. Inject Exit Button
function injectSecurityUI(wc) {
  try {
    wc.insertCSS(`
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
      }
      #spektic-exit-btn:hover { background: #b91c1c !important; transform: scale(1.05) !important; }
    `)
    wc.executeJavaScript(`
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

// 11. Create Main Window
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
  mainWindow.webContents.on('context-menu', e => { e.preventDefault() })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const u = url.toLowerCase()
    if (u.includes('spektic-quit-action') || u.includes('quit-exam')) { event.preventDefault(); safeQuit(); return }
    if (!u.includes('spektic.com') && !u.includes('vercel.app') && !u.includes('workers.dev') && !u.includes('localhost')) { event.preventDefault() }
  })

  session.defaultSession.on('will-download', e => { e.preventDefault() })
  mainWindow.on('close', e => { if (!isQuitting) { e.preventDefault(); safeQuit() } })

  mainWindow.loadURL('https://spektic.com/join')
  mainWindow.webContents.on('dom-ready', () => { injectSecurityUI(mainWindow.webContents) })
  mainWindow.webContents.on('did-finish-load', () => { injectSecurityUI(mainWindow.webContents) })

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if ((input.meta && input.shift && input.alt && input.key.toLowerCase() === 'q') ||
        (input.meta && input.alt && input.key.toLowerCase() === 'q')) { safeQuit(); return }
    if (input.meta || input.alt || input.control) {
      if (['tab','q','w','space','r','h','m','c','v'].includes(input.key.toLowerCase())) { event.preventDefault() }
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
  // Clean leftover files from any previous crash
  exec('rm -f /tmp/spektic_pf.conf /tmp/spektic_fw.sh /tmp/spektic_watchdog.sh', () => {})

  const shortcuts = [
    'Command+Tab', 'Command+Q', 'Command+W', 'Command+Space',
    'Command+Option+Esc', 'Command+Shift+3', 'Command+Shift+4', 'Command+Shift+5'
  ]
  shortcuts.forEach(sc => { try { globalShortcut.register(sc, () => {}) } catch (e) {} })
  try { globalShortcut.register('Command+Shift+Option+Q', () => { safeQuit() }) } catch (e) {}

  // SEQUENCE: Block internet FIRST → then open exam window
  enableNetworkLockdown(() => {
    createWindow()
  })
})

app.on('will-quit', () => { safeQuit() })
app.on('window-all-closed', () => { safeQuit() })
