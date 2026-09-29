const { ipcRenderer } = require('electron')

window.addEventListener('DOMContentLoaded', () => {
  const pet = document.querySelector('[data-pet]')
  const close = document.querySelector('[data-close]')
  let dragging = false

  pet?.addEventListener('dblclick', (event) => {
    if (event.target === close) return
    ipcRenderer.send('chatty:open-main')
  })

  close?.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    ipcRenderer.send('chatty:hide-pet')
  })

  pet?.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || event.target === close) return
    dragging = true
    ipcRenderer.send('chatty:pet-drag-start', { x: event.screenX, y: event.screenY })
  })

  window.addEventListener('mousemove', (event) => {
    if (!dragging) return
    ipcRenderer.send('chatty:pet-drag-move', { x: event.screenX, y: event.screenY })
  })

  window.addEventListener('mouseup', () => {
    dragging = false
    ipcRenderer.send('chatty:pet-drag-end')
  })

  ipcRenderer.send('chatty:pet-ready')
})
