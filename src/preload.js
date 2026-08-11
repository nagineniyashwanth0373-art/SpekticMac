const { contextBridge, ipcRenderer } = require('electron')

// Expose safe quit API to renderer
contextBridge.exposeInMainWorld('spekticAPI', {
  exitApp: () => ipcRenderer.send('spektic-force-quit')
})
