// Preload script. Runs sandboxed, so it must stay CommonJS and may only use
// the small set of Electron APIs available to sandboxed preloads.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gitdl', {
  ping: () => ipcRenderer.invoke('ipc:ping'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  detectGit: (gitPath) => ipcRenderer.invoke('git:detect', gitPath),

  listTasks: () => ipcRenderer.invoke('task:list'),
  startTask: (mode, opts) => ipcRenderer.invoke('task:start', mode, opts),
  pauseTask: (id) => ipcRenderer.invoke('task:pause', id),
  resumeTask: (id) => ipcRenderer.invoke('task:resume', id),
  retryTask: (id) => ipcRenderer.invoke('task:retry', id),
  cancelTask: (id) => ipcRenderer.invoke('task:cancel', id),
  removeTask: (id) => ipcRenderer.invoke('task:remove', id),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),

  pickDirectory: (title) => ipcRenderer.invoke('dialog:pickDirectory', title),
  pickFile: (title) => ipcRenderer.invoke('dialog:pickFile', title),
  pickSaveFile: (defaultPath) => ipcRenderer.invoke('dialog:pickSaveFile', defaultPath),
  revealPath: (target) => ipcRenderer.invoke('shell:reveal', target),

  // Engine events are pushed from the main process on a single channel.
  onEngineEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('engine:event', listener);
    return () => ipcRenderer.removeListener('engine:event', listener);
  },
});
