const { contextBridge, ipcRenderer } = require('electron')

// Expose safe quit API to renderer
contextBridge.exposeInMainWorld('spekticAPI', {
  exitApp: () => ipcRenderer.send('spektic-force-quit')
})

// Expose native attestation solver for macOS (matches Windows spekticNative interface seamlessly)
contextBridge.exposeInMainWorld('spekticNative', {
  solveChallenge: (challenge) => ipcRenderer.invoke('spektic-solve-challenge', challenge),
  isMac: true,
  platform: 'darwin'
})
