import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI } from '../shared/types';

// Expose business operations only. Neither ipcRenderer nor the bearer token crosses the bridge.
const api: DesktopAPI = {
  getProjectWork: (id, itemId, before) => ipcRenderer.invoke('morrow:get-project-work', id, itemId || '', before || ''),
  getProjectBrief: (id) => ipcRenderer.invoke('morrow:get-project-brief', id),
  updateProject: (id, data) => ipcRenderer.invoke('morrow:update-project', id, data),
  getSettings: () => ipcRenderer.invoke('morrow:get-settings'),
  updateSettings: (data) => ipcRenderer.invoke('morrow:update-settings', data),
  updateProjectUsageBudget: (id, usageBudget) =>
    ipcRenderer.invoke('morrow:update-project-usage-budget', id, usageBudget),
  getProjectUsage: (id) => ipcRenderer.invoke('morrow:get-project-usage', id),
  reviewRelease: (id, hash, decision, feedback) =>
    ipcRenderer.invoke('morrow:review-release', id, hash, decision, feedback),
  reconcileRelease: (id) => ipcRenderer.invoke('morrow:reconcile-release', id),
  getReleaseScript: (id) => ipcRenderer.invoke('morrow:get-release-script', id),
  requestUpgradeRestart: () => ipcRenderer.invoke('morrow:request-upgrade-restart'),
  getState: () => ipcRenderer.invoke('morrow:get-state'),
  getConnection: () => ipcRenderer.invoke('morrow:get-connection'),
  connect: (config) => ipcRenderer.invoke('morrow:connect', config),
  createProject: (data) => ipcRenderer.invoke('morrow:create-project', data),
  createChannel: (data) => ipcRenderer.invoke('morrow:create-channel', data),
  updateChannel: (id, data) => ipcRenderer.invoke('morrow:update-channel', id, data),
  channelAction: (id, action) => ipcRenderer.invoke('morrow:channel-action', id, action),
  getNativeStatus: (refreshUsage = false) => ipcRenderer.invoke('morrow:get-native-status', refreshUsage),
  restoreNativeBackground: () => ipcRenderer.invoke('morrow:restore-native-background'),
  listNativeThreads: (id) => ipcRenderer.invoke('morrow:list-native-threads', id),
  getNativeConversation: (id, query) => ipcRenderer.invoke('morrow:get-native-conversation', id, query || {}),
  bindNativeThread: (id, threadId) => ipcRenderer.invoke('morrow:bind-native-thread', id, threadId),
  sendNativeMessage: (id, input) => ipcRenderer.invoke('morrow:send-native-message', id, input),
  interruptNativeTurn: (id, turnId) => ipcRenderer.invoke('morrow:interrupt-native-turn', id, turnId),
  openNativeApp: (id) => ipcRenderer.invoke('morrow:open-native-app', id),
  createItem: (data) => ipcRenderer.invoke('morrow:create-item', data),
  patchItem: (id, data) => ipcRenderer.invoke('morrow:patch-item', id, data),
  getRuns: (query) => ipcRenderer.invoke('morrow:get-runs', query),
  getRun: (id) => ipcRenderer.invoke('morrow:get-run', id),
  getRunOutput: (id, query) => ipcRenderer.invoke('morrow:get-run-output', id, query),
  loadDemo: () => ipcRenderer.invoke('morrow:load-demo'),
  refreshRuntimes: () => ipcRenderer.invoke('morrow:refresh-runtimes'),
  getEvents: (query) => ipcRenderer.invoke('morrow:get-events', query),
  chooseFolder: () => ipcRenderer.invoke('morrow:choose-folder'),
  openProjectFolder: (id) => ipcRenderer.invoke('morrow:open-project-folder', id),
  openDataFolder: () => ipcRenderer.invoke('morrow:open-data-folder'),
  openExternal: (url) => ipcRenderer.invoke('morrow:open-external', url),
  onCommand: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, command: unknown) => {
      if (
        typeof command === 'string' &&
        ['new-project', 'search', 'settings', 'close-tab', 'back', 'forward', 'toggle-sidebar'].includes(command)
      )
        callback(command);
    };
    ipcRenderer.on('morrow:command', listener);
    return () => ipcRenderer.removeListener('morrow:command', listener);
  },
};
contextBridge.exposeInMainWorld('morrow', api);
