const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('generatorAPI', {
  getState: () => ipcRenderer.invoke('generator:get-state'),
  getHistory: () => ipcRenderer.invoke('generator:get-history'),
  selectPrivateKey: () => ipcRenderer.invoke('generator:select-private-key'),
  generateLicense: (payload) => ipcRenderer.invoke('generator:generate-license', payload),
  revokeLicense: (payload) => ipcRenderer.invoke('generator:revoke-license', payload),
  saveLicense: (payload) => ipcRenderer.invoke('generator:save-license', payload),
  openExternal: (target) => ipcRenderer.invoke('generator:open-external', target),
});
