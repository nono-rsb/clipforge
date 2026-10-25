// Pont minimal entre la page et l'app PC.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clipforgeDesktop', {
  onSaved: cb => ipcRenderer.on('saved', (_, file) => cb(file)),
  show: file => ipcRenderer.send('show', file),
});
