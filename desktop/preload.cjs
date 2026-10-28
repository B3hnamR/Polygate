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
contextBridge.exposeInMainWorld('polygateDesktop', {
  getPrefs: () => ipcRenderer.invoke('polygate:desktop:prefs'),
  setCloseToTray: value => ipcRenderer.invoke('polygate:desktop:close-to-tray', value === true),
  // The compact portrait view: a small window to keep beside other work.
  getView: () => ipcRenderer.invoke('polygate:desktop:view'),
  setCompact: value => ipcRenderer.invoke('polygate:desktop:set-compact', value === true),
  setPinned: value => ipcRenderer.invoke('polygate:desktop:set-pinned', value === true),
  onView: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('polygate:desktop:view', listener);
    return () => ipcRenderer.removeListener('polygate:desktop:view', listener);
  },
});
