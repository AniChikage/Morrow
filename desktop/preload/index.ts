import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI } from '../shared/types';

// Expose business operations only. Neither ipcRenderer nor the bearer token crosses the bridge.
const api: DesktopAPI = {
  getProjectWork: (id,itemId) => ipcRenderer.invoke('nohuman:get-project-work',id,itemId||''),
  reviewRelease: (id,hash,decision,feedback) => ipcRenderer.invoke('nohuman:review-release',id,hash,decision,feedback),
  reconcileRelease: id => ipcRenderer.invoke('nohuman:reconcile-release',id),
  getState: () => ipcRenderer.invoke('nohuman:get-state'),
  getConnection: () => ipcRenderer.invoke('nohuman:get-connection'),
  connect: config => ipcRenderer.invoke('nohuman:connect', config),
  createProject: data => ipcRenderer.invoke('nohuman:create-project', data),
  createChannel: data => ipcRenderer.invoke('nohuman:create-channel', data),
  updateChannel: (id, data) => ipcRenderer.invoke('nohuman:update-channel', id, data),
  channelAction: (id, action) => ipcRenderer.invoke('nohuman:channel-action', id, action),
  sendMessage: (id, text) => ipcRenderer.invoke('nohuman:send-message', id, text),
  getNativeStatus: () => ipcRenderer.invoke('nohuman:get-native-status'),
  setupNativeBackground: () => ipcRenderer.invoke('nohuman:setup-native-background'),
  restoreNativeBackground: () => ipcRenderer.invoke('nohuman:restore-native-background'),
  listNativeThreads: id => ipcRenderer.invoke('nohuman:list-native-threads', id),
  getNativeConversation: (id, query) => ipcRenderer.invoke('nohuman:get-native-conversation', id, query || {}),
  bindNativeThread: (id, threadId) => ipcRenderer.invoke('nohuman:bind-native-thread', id, threadId),
  createNativeThread: id => ipcRenderer.invoke('nohuman:create-native-thread', id),
  sendNativeMessage: (id, input) => ipcRenderer.invoke('nohuman:send-native-message', id, input),
  interruptNativeTurn: (id, turnId) => ipcRenderer.invoke('nohuman:interrupt-native-turn', id, turnId),
  respondNativeRequest: (id, requestId, response) => ipcRenderer.invoke('nohuman:respond-native-request', id, requestId, response),
  openNativeApp: id => ipcRenderer.invoke('nohuman:open-native-app', id),
  chooseNativeImages: id => ipcRenderer.invoke('nohuman:choose-native-images', id),
  getNativeImage: (id, itemId, index) => ipcRenderer.invoke('nohuman:get-native-image', id, itemId, index),
  updateItem: (id, status) => ipcRenderer.invoke('nohuman:update-item', id, status),
  createItem: data => ipcRenderer.invoke('nohuman:create-item',data),
  patchItem: (id,data) => ipcRenderer.invoke('nohuman:patch-item',id,data),
  getRuns: query => ipcRenderer.invoke('nohuman:get-runs',query),
  getRun: id => ipcRenderer.invoke('nohuman:get-run',id),
  getRunOutput: (id,query) => ipcRenderer.invoke('nohuman:get-run-output',id,query),
  openNativeSession: id => ipcRenderer.invoke('nohuman:open-native-session',id),
  loadDemo: () => ipcRenderer.invoke('nohuman:load-demo'),
  refreshRuntimes: () => ipcRenderer.invoke('nohuman:refresh-runtimes'),
  getEvents: query => ipcRenderer.invoke('nohuman:get-events', query),
  chooseFolder: () => ipcRenderer.invoke('nohuman:choose-folder'),
  openProjectFolder: id => ipcRenderer.invoke('nohuman:open-project-folder', id),
  openDataFolder: () => ipcRenderer.invoke('nohuman:open-data-folder'),
  openExternal: url => ipcRenderer.invoke('nohuman:open-external', url),
  onCommand: callback => {
    const listener = (_event: Electron.IpcRendererEvent, command: unknown) => {
      if (typeof command === 'string' && ['new-project', 'search', 'settings', 'close-tab', 'back', 'forward', 'toggle-sidebar'].includes(command)) callback(command);
    };
    ipcRenderer.on('nohuman:command', listener);
    return () => ipcRenderer.removeListener('nohuman:command', listener);
  }
};
contextBridge.exposeInMainWorld('nohuman', api);
