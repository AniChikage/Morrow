import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDirectory, ServiceConnection } from './connection';
import { channelInput, channelPatch, choice, connectionConfig, eventsInput, externalURL, id, itemStatuses, projectInput, text, itemInput, itemPatch, runsInput, runOutputInput, nativeHistoryInput, nativeMessageInput, nativeResponseInput, integer } from './validation';

import { launchNativeSession } from './native-session';
import type { NativeSessionTarget } from '../shared/types';

const dirname = fileURLToPath(new URL('.', import.meta.url));
const packagedURL = 'morrow://app/index.html';
const developmentURL = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
if (developmentURL) {
  const parsed = new URL(developmentURL);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)) throw new Error('开发页面必须使用本机 HTTP 地址。');
}
protocol.registerSchemesAsPrivileged([{ scheme: 'morrow', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.setName('Morrow');
const explicitDataDirectory = process.env.MORROW_HOME || process.env.NOHUMAN_HOME;
app.setPath('userData', explicitDataDirectory ? join(explicitDataDirectory, 'desktop-ui') : resolveDataDirectory());
app.enableSandbox();
const service = new ServiceConnection();
let window: BrowserWindow | null = null;

function trustedURL(value: string): boolean {
  try {
    const url = new URL(value);
    if (developmentURL) return url.origin === new URL(developmentURL).origin;
    return url.protocol === 'morrow:' && url.host === 'app' && url.pathname === '/index.html';
  } catch { return false; }
}
function validateSender(event: IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !trustedURL(event.senderFrame.url)) throw new Error('不受信任的应用请求。');
}
function handle(channel: string, arity: number, callback: (...args: unknown[]) => unknown): void {
  ipcMain.handle(`morrow:${channel}`, (event, ...args: unknown[]) => {
    validateSender(event);
    if (args.length !== arity) throw new Error('请求参数不正确。');
    return callback(...args);
  });
}
async function openWebLink(value: unknown): Promise<void> { await shell.openExternal(externalURL(value)); }
function sendCommand(command: string): void {
  const target = window || createWindow();
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  if (target.webContents.isLoading()) target.webContents.once('did-finish-load', () => target.webContents.send('morrow:command', command));
  else target.webContents.send('morrow:command', command);
}
function configureMenu(): void {
  const menu: MenuItemConstructorOptions[] = [
    { label: 'Morrow', submenu: [
      { role: 'about', label: '关于 Morrow' }, { type: 'separator' },
      { label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => sendCommand('settings') },
      { type: 'separator' }, { role: 'services', label: '服务' }, { type: 'separator' },
      { role: 'hide', label: '隐藏 Morrow' }, { role: 'hideOthers', label: '隐藏其他应用' }, { role: 'unhide', label: '显示全部' },
      { type: 'separator' }, { role: 'quit', label: '退出 Morrow' }
    ] },
    { label: '文件', submenu: [
      { label: '新建项目', accelerator: 'CmdOrCtrl+N', click: () => sendCommand('new-project') },
      { label: '搜索', accelerator: 'CmdOrCtrl+K', click: () => sendCommand('search') },
      { type: 'separator' }, { label: '关闭标签页', accelerator: 'CmdOrCtrl+W', click: () => sendCommand('close-tab') }
    ] },
    { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    { label: '显示', submenu: [
      { label: '后退', accelerator: 'CmdOrCtrl+[', click: () => sendCommand('back') },
      { label: '前进', accelerator: 'CmdOrCtrl+]', click: () => sendCommand('forward') },
      { label: '显示 / 隐藏侧栏', accelerator: 'CmdOrCtrl+B', click: () => sendCommand('toggle-sidebar') },
      { type: 'separator' }, { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { type: 'separator' }, { role: 'togglefullscreen', label: '进入全屏幕' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools' as const, label: '开发者工具' }] : [])
    ] },
    { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放' }, { type: 'separator' }, { role: 'front', label: '全部置于顶层' }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
}
function registerIPC(): void {
  handle('get-state', 0, () => service.state());
  handle('get-connection', 0, () => service.getInfo());
  handle('connect', 1, value => service.connect(connectionConfig(value)));
  handle('create-project', 1, value => service.request('projects', 'POST', projectInput(value)));
  handle('create-channel', 1, value => service.request('channels', 'POST', channelInput(value)));
  handle('update-channel', 2, (channelId, value) => service.request(`channels/${id(channelId)}`, 'PATCH', channelPatch(value)));
  handle('channel-action', 2, (channelId, action) => service.request(`channels/${id(channelId)}/action`, 'POST', { action: choice(action, ['run', 'pause', 'resume']) }));
  handle('send-message', 2, (channelId, value) => service.request(`channels/${id(channelId)}/messages`, 'POST', { text: text(value, '消息', 10000) }));
  handle('get-native-status', 0, () => service.request('native/status'));
  handle('setup-native-background', 0, () => { throw new Error('Morrow 直接使用 Codex CLI，无需设置 App 桥接。'); });
  handle('restore-native-background', 0, async () => {
    if ((await service.getInfo()).config.mode !== 'local') throw new Error('请在本机 Mac 恢复连接设置。');
    return service.request('native/background/restore', 'POST', {});
  });
  handle('list-native-threads', 1, channelId => service.request(`channels/${id(channelId)}/native/threads`));
  handle('get-native-conversation', 2, (channelId, value) => {
    const params = new URLSearchParams();
    Object.entries(nativeHistoryInput(value)).forEach(([key, entry]) => { if (entry !== undefined) params.set(key, String(entry)); });
    return service.request(`channels/${id(channelId)}/native/conversation?${params}`);
  });
  handle('bind-native-thread', 2, (channelId, threadId) => service.request(`channels/${id(channelId)}/native/bind`, 'POST', { threadId: id(threadId) }));
  handle('create-native-thread', 1, channelId => service.request(`channels/${id(channelId)}/native/create`, 'POST', {}));
  handle('send-native-message', 2, (channelId, value) => service.request(`channels/${id(channelId)}/native/messages`, 'POST', nativeMessageInput(value)));
  handle('interrupt-native-turn', 2, (channelId, turnId) => service.request(`channels/${id(channelId)}/native/interrupt`, 'POST', { turnId: id(turnId) }));
  handle('respond-native-request', 3, (channelId, requestId, response) => service.request(`channels/${id(channelId)}/native/respond`, 'POST', { requestId: text(requestId, '原生请求标识', 200), response: nativeResponseInput(response) }));
  handle('open-native-app', 1, () => { throw new Error('Morrow 已直接使用 Codex CLI，请在频道内继续对话。'); });
  handle('choose-native-images', 1, async channelId => {
    const channel = id(channelId);
    if ((await service.getInfo()).config.mode !== 'local') throw new Error('图片需要位于执行主机，请在对应主机添加。');
    const selection = await dialog.showOpenDialog(window!, { title: '向原生会话添加图片', properties: ['openFile', 'multiSelections'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
    if (selection.canceled || !selection.filePaths.length) return [];
    return service.request(`channels/${channel}/native/images`, 'POST', { paths: selection.filePaths });
  });
  handle('get-native-image', 3, (channelId, itemId, index) => service.request(`channels/${id(channelId)}/native/images/${id(itemId)}/${integer(index, 0, 100)}`));
  handle('update-item', 2, (itemId, status) => service.request(`items/${id(itemId)}`, 'PATCH', { status: choice(status, itemStatuses) }));
  handle('get-project-work',2,(projectId,itemId)=>service.request(`projects/${id(projectId)}/work${itemId?'?itemId='+encodeURIComponent(id(itemId)):''}`));
  handle('review-release',4,(releaseId,hash,decision,feedback)=>service.request(`releases/${id(releaseId)}/review`,'POST',{reviewHash:text(hash,'版本校验',64),decision:choice(decision,['approve','reject']),feedback:text(feedback,'指导意见',10000,true)}));
  handle('reconcile-release',1,releaseId=>service.request(`releases/${id(releaseId)}/reconcile`,'POST',{}));
  handle('create-item',1,value=>{const {projectId,...data}=itemInput(value);return service.request(`projects/${projectId}/items`,'POST',data);});
  handle('patch-item',2,(itemId,value)=>service.request(`items/${id(itemId)}`,'PATCH',itemPatch(value)));
  handle('get-runs',1,value=>{const params=new URLSearchParams();Object.entries(runsInput(value)).forEach(([key,val])=>{if(val!==undefined)params.set(key,String(val));});return service.request(`runs?${params}`);});
  handle('get-run',1,runId=>service.request(`runs/${id(runId)}`));
  handle('get-run-output',2,(runId,value)=>{const params=new URLSearchParams();Object.entries(runOutputInput(value)).forEach(([key,val])=>{if(val!==undefined)params.set(key,String(val));});return service.request(`runs/${id(runId)}/output?${params}`);});
  handle('open-native-session',1,async channelId=>{
    if((await service.getInfo()).config.mode!=='local')throw new Error('原生会话位于远程主机，请在远程终端中继续。');
    const target=await service.request<NativeSessionTarget>(`channels/${id(channelId)}/native-handoff`,'POST',{});
    await launchNativeSession(target);
  });
  handle('load-demo', 0, () => service.request('demo', 'POST', {}));
  handle('refresh-runtimes', 0, () => service.request('runtimes/refresh', 'POST', {}));
  handle('get-events', 1, query => service.events(eventsInput(query)));
  handle('choose-folder', 0, async () => {
    if ((await service.getInfo()).config.mode === 'ssh') throw new Error('远程项目请填写远程主机上的绝对目录路径。');
    const result = await dialog.showOpenDialog(window!, { title: '选择项目目录', buttonLabel: '接入此目录', properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  handle('open-project-folder', 1, async projectId => {
    const targetId = id(projectId);
    if ((await service.getInfo()).config.mode === 'ssh') throw new Error('远程项目目录位于 SSH 主机，无法在本机 Finder 中打开。');
    const project = (await service.state()).projects.find(candidate => candidate.id === targetId);
    if (!project || project.isDemo || !project.path) throw new Error('此项目没有关联本地目录。');
    if (!(await stat(project.path)).isDirectory()) throw new Error('项目目录已经不存在。');
    const error = await shell.openPath(project.path);
    if (error) throw new Error('无法打开项目目录。');
  });
  handle('open-data-folder', 0, async () => { const error = await shell.openPath(service.dataDirectory); if (error) throw new Error('无法打开本机数据目录。'); });
  handle('open-external', 1, openWebLink);
}
async function registerRendererProtocol(): Promise<void> {
  const root = resolve(dirname, '../renderer');
  const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
  protocol.handle('morrow', async request => {
    try {
      const url = new URL(request.url);
      if (request.method !== 'GET' || url.host !== 'app') return new Response('Forbidden', { status: 403 });
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.includes('\0') || pathname.includes('\\')) return new Response('Forbidden', { status: 403 });
      const filename = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!filename.startsWith(root + sep) || !mime[extname(filename)]) return new Response('Not found', { status: 404 });
      const data = await readFile(filename);
      return new Response(new Uint8Array(data), { headers: {
        'Content-Type': mime[extname(filename)], 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"
      } });
    } catch { return new Response('Not found', { status: 404 }); }
  });
}
function createWindow(): BrowserWindow {
  const target = new BrowserWindow({
    width: 1320, height: 840, minWidth: 1000, minHeight: 680, title: 'Morrow', show: false,
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 }, backgroundColor: '#f5f5f6',
    webPreferences: { preload: join(dirname, '../preload/index.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false }
  });
  window = target;
  target.webContents.setWindowOpenHandler(({ url }) => { void openWebLink(url).catch(() => undefined); return { action: 'deny' }; });
  target.webContents.on('will-navigate', (event, url) => { if (!trustedURL(url)) event.preventDefault(); });
  target.webContents.on('will-attach-webview', event => event.preventDefault());
  target.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  target.webContents.session.setPermissionCheckHandler(() => false);
  target.webContents.on('did-fail-load', (_event, code, description) => { if (code !== -3) console.error(`Morrow renderer failed (${code}): ${description}`); });
  target.on('ready-to-show', () => target.show());
  target.on('closed', () => { if (window === target) window = null; });
  void target.loadURL(developmentURL || packagedURL);
  return target;
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(async () => {
    await registerRendererProtocol();
    registerIPC();
    configureMenu();
    app.setAboutPanelOptions({ applicationName: 'Morrow', applicationVersion: app.getVersion(), copyright: 'Morrow · 本地优先的持续 Agent 工作空间' });
    createWindow();
    void service.initialize();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  }).catch(error => { console.error('Morrow startup failed:', error instanceof Error ? error.message : error); app.quit(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  let quitting = false;
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    // Wait only for the SSH tunnel owned by this app. The independent daemon stays running.
    void service.stopTunnel().finally(() => app.quit());
  });
}
