# Spektic for macOS (Electron.js Architecture)

This is the native macOS implementation of the Spektic Secure Exam Browser.

## Security Features Implemented:
1. **macOS Kiosk Lockdown:** Sets `kiosk: true` & `alwaysOnTop: true`, automatically disabling the macOS Dock, Menu Bar, Mission Control (3-finger swipe), and App Expose.
2. **Screen Capture Blackout (`setContentProtection`):** Turns Zoom, Google Meet, OBS Studio, and macOS native screen recording into a solid black box (`0x000000`).
3. **macOS Keyboard Hook:** Traps `Command+Tab`, `Command+Q`, `Command+Space` (Spotlight), `Command+Option+Esc` (Force Quit), and `Command+Shift+3/4/5` (Screenshots).
4. **macOS Process Assassin:** Background loop hunting down prohibited macOS processes (`Discord`, `TeamViewer`, `AnyDesk`, `OBS`, `Spotify`, etc.) using `pkill`.
5. **SHA-256 Cloudflare Handshake:** Computes SHA-256 digest of the app bundle and attaches `x-secure-exam-key` to all network requests.

---

## How to Build the `.dmg` File for Free (No Mac Required)

1. Push this folder to a **GitHub Repository**.
2. GitHub Actions will automatically run `.github/workflows/build-mac.yml` on a cloud Apple macOS server.
3. Once finished, go to your GitHub repository -> **Actions** -> Click the latest build -> Download **`Spektic-macOS-Installer.zip`**.
4. Unzip the file to get **`Spektic-1.0.0.dmg`**.

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
