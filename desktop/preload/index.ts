import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI } from '../shared/types';

// Expose business operations only. Neither ipcRenderer nor the bearer token crosses the bridge.
const api: DesktopAPI = {
  getProjectWork: (id,itemId) => ipcRenderer.invoke('morrow:get-project-work',id,itemId||''),
  reviewRelease: (id,hash,decision,feedback) => ipcRenderer.invoke('morrow:review-release',id,hash,decision,feedback),
  reconcileRelease: id => ipcRenderer.invoke('morrow:reconcile-release',id),
  getState: () => ipcRenderer.invoke('morrow:get-state'),
  getConnection: () => ipcRenderer.invoke('morrow:get-connection'),
  connect: config => ipcRenderer.invoke('morrow:connect', config),
  createProject: data => ipcRenderer.invoke('morrow:create-project', data),
  createChannel: data => ipcRenderer.invoke('morrow:create-channel', data),
  updateChannel: (id, data) => ipcRenderer.invoke('morrow:update-channel', id, data),
  channelAction: (id, action) => ipcRenderer.invoke('morrow:channel-action', id, action),
  sendMessage: (id, text) => ipcRenderer.invoke('morrow:send-message', id, text),
  getNativeStatus: () => ipcRenderer.invoke('morrow:get-native-status'),
  setupNativeBackground: () => ipcRenderer.invoke('morrow:setup-native-background'),
  restoreNativeBackground: () => ipcRenderer.invoke('morrow:restore-native-background'),
  listNativeThreads: id => ipcRenderer.invoke('morrow:list-native-threads', id),
  getNativeConversation: (id, query) => ipcRenderer.invoke('morrow:get-native-conversation', id, query || {}),
  bindNativeThread: (id, threadId) => ipcRenderer.invoke('morrow:bind-native-thread', id, threadId),
  createNativeThread: id => ipcRenderer.invoke('morrow:create-native-thread', id),
  sendNativeMessage: (id, input) => ipcRenderer.invoke('morrow:send-native-message', id, input),
  interruptNativeTurn: (id, turnId) => ipcRenderer.invoke('morrow:interrupt-native-turn', id, turnId),
  respondNativeRequest: (id, requestId, response) => ipcRenderer.invoke('morrow:respond-native-request', id, requestId, response),
  openNativeApp: id => ipcRenderer.invoke('morrow:open-native-app', id),
  chooseNativeImages: id => ipcRenderer.invoke('morrow:choose-native-images', id),
  getNativeImage: (id, itemId, index) => ipcRenderer.invoke('morrow:get-native-image', id, itemId, index),
  updateItem: (id, status) => ipcRenderer.invoke('morrow:update-item', id, status),
  createItem: data => ipcRenderer.invoke('morrow:create-item',data),
  patchItem: (id,data) => ipcRenderer.invoke('morrow:patch-item',id,data),
  getRuns: query => ipcRenderer.invoke('morrow:get-runs',query),
  getRun: id => ipcRenderer.invoke('morrow:get-run',id),
  getRunOutput: (id,query) => ipcRenderer.invoke('morrow:get-run-output',id,query),
  openNativeSession: id => ipcRenderer.invoke('morrow:open-native-session',id),
  loadDemo: () => ipcRenderer.invoke('morrow:load-demo'),
  refreshRuntimes: () => ipcRenderer.invoke('morrow:refresh-runtimes'),
  getEvents: query => ipcRenderer.invoke('morrow:get-events', query),
  chooseFolder: () => ipcRenderer.invoke('morrow:choose-folder'),
  openProjectFolder: id => ipcRenderer.invoke('morrow:open-project-folder', id),
  openDataFolder: () => ipcRenderer.invoke('morrow:open-data-folder'),
  openExternal: url => ipcRenderer.invoke('morrow:open-external', url),
  onCommand: callback => {
    const listener = (_event: Electron.IpcRendererEvent, command: unknown) => {
      if (typeof command === 'string' && ['new-project', 'search', 'settings', 'close-tab', 'back', 'forward', 'toggle-sidebar'].includes(command)) callback(command);
    };
    ipcRenderer.on('morrow:command', listener);
    return () => ipcRenderer.removeListener('morrow:command', listener);
  }
};
contextBridge.exposeInMainWorld('morrow', api);
