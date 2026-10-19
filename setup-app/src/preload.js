'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setup', {
  state: () => ipcRenderer.invoke('setup:state'),
  chooseDir: () => ipcRenderer.invoke('setup:choose-dir'),
  checkDisk: (dir) => ipcRenderer.invoke('setup:check-disk', dir),
  install: (options) => ipcRenderer.invoke('setup:install', options),
  repair: (options) => ipcRenderer.invoke('setup:repair', options),
  uninstall: () => ipcRenderer.invoke('setup:uninstall'),
  launch: (exe) => ipcRenderer.invoke('setup:launch', exe),
  quit: () => ipcRenderer.invoke('setup:quit'),
  minimize: () => ipcRenderer.invoke('setup:minimize'),
  onProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('setup:progress', handler);
    return () => ipcRenderer.removeListener('setup:progress', handler);
  },
});