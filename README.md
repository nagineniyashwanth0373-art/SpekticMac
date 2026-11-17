# Spektic for macOS (Electron.js Architecture)

This is the native macOS implementation of the Spektic Secure Exam Browser.

## Security Features Implemented:
1. **macOS Kiosk Lockdown:** Sets `kiosk: true` & `alwaysOnTop: true`, automatically disabling the macOS Dock, Menu Bar, Mission Control (3-finger swipe), and App Exposé.
2. **Screen Capture Blackout (`setContentProtection`):** Turns Zoom, Google Meet, OBS Studio, and macOS native screen recording into a solid black box (`0x000000`).
3. **Google Meet & Zoom WebRTC Engine:** Native `setDisplayMediaRequestHandler` auto-satisfies screenshare requests, while modern Chrome User-Agent and hardware WebRTC flags guarantee smooth video and audio.
4. **macOS TCC Privacy Permissions:** Automated prompts for Camera and Microphone with native usage descriptions in `Info.plist`.
5. **Per-App Network Isolation:** Blackholes system proxies (`127.0.0.1:9999`) for all background apps (Chrome, Safari, Slack, Discord) while Spektic routes directly via `direct://`, with emergency watchdog script auto-restoring network on exit.
6. **macOS Keyboard Hook:** Traps `Command+Tab`, `Command+Q`, `Command+Space` (Spotlight), `Command+Option+Esc` (Force Quit), and `Command+Shift+3/4/5` (Screenshots).
7. **macOS Process Assassin:** Background loop hunting down prohibited macOS processes (`Discord`, `TeamViewer`, `AnyDesk`, `OBS`, `Spotify`, etc.) using `pkill`.
8. **SHA-256 Cloudflare Handshake:** Computes SHA-256 digest of the app bundle and attaches `x-secure-exam-key` to all network requests.

---

## How to Build the `.dmg` File for Free (No Mac Required)

1. Push this folder to your **GitHub Repository**:
   ```bash
   git push origin main
   ```
2. GitHub Actions will automatically run `.github/workflows/build-mac.yml` on a cloud Apple macOS server.
3. Once finished, go to your GitHub repository -> **Actions** -> Click the latest build -> Download **`Spektic-macOS-Installers`**.
4. You will get:
   - **`Spektic-1.0.0-arm64.dmg`** (for Apple Silicon M1 / M2 / M3 / M4 Macs)
   - **`Spektic-1.0.0.dmg`** (for Intel x64 Macs)

---

## 30-Minute Mac Test Session Guide (For your friend's MacBook):

1. **Send `.dmg` to your friend.**
2. **Bypass Mac Gatekeeper (First 2 mins):**
   - Since this build is self-signed without a $99 Apple Dev Certificate, macOS will show: *"Spektic cannot be opened because it is from an unidentified developer"*.
   - Tell your friend to: `Right-Click Spektic.dmg -> Select Open -> Click "Open"`.
3. **Run & Test:**
   - Double click `Spektic.app` inside the mounted `.dmg`.
   - Spektic will launch full-screen.
   - Screen sharing over Zoom/Meet will turn into a **black screen** (proving content protection works!).
