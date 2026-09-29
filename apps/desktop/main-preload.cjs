const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('chattyVoiceInput', {
  start: () => ipcRenderer.invoke('chatty:voice-start'),
  stop: () => ipcRenderer.invoke('chatty:voice-stop'),
  onResult: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('chatty:voice-result', listener)
    return () => ipcRenderer.removeListener('chatty:voice-result', listener)
  },
})
