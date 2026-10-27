const { contextBridge, ipcRenderer } = require('electron');
// Narrow capabilities only: no filesystem paths, URLs, or general IPC are accepted from the page.
contextBridge.exposeInMainWorld('polygateUpdates', {
  getState: () => ipcRenderer.invoke('polygate:updates:state'),
  check: () => ipcRenderer.invoke('polygate:updates:check'),
  install: () => ipcRenderer.invoke('polygate:updates:install'),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('polygate:updates:changed', listener);
    return () => ipcRenderer.removeListener('polygate:updates:changed', listener);
  },
});
