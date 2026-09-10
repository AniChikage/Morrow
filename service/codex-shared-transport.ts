import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import WebSocket from 'ws';
import { applyDesktopPatches, NativeDesktopError, type NativeThreadSnapshot, type NativeThreadChange } from './codex-desktop-transport.ts';
import type { NativeWorkOptions } from './native-conversations.ts';

export interface SharedHost { version: number; launchId: string; bridgePid: number; appPid: number; runtimePid: number; codexHome: string; executable: string; socketPath: string; startedAt: string }
const alive = (pid: number) => { try { if (!Number.isInteger(pid) || pid < 1) return false; process.kill(pid, 0); return true; } catch { return false; } };
const samePath = (left: string, right: string) => { try { return realpathSync(left) === realpathSync(right); } catch { return resolve(left) === resolve(right); } };
function privatePath(path: string, kind: 'file' | 'directory' | 'socket'): boolean {
  try { const stat = lstatSync(path); return stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 && (kind === 'file' ? stat.isFile() : kind === 'directory' ? stat.isDirectory() : stat.isSocket()); } catch { return false; }
}
function findSharedHosts(directory: string, codexHome: string): SharedHost[] {
  if (!privatePath(directory, 'directory')) return [];
  const hosts: SharedHost[] = [];
  for (const name of readdirSync(directory).filter(name => /^host-[0-9]+\.json$/.test(name))) {
    const path = join(directory, name); if (!privatePath(path, 'file')) continue;
    try {
      const host = JSON.parse(readFileSync(path, 'utf8'));
      if (host.version !== 1 || typeof host.launchId !== 'string' || typeof host.codexHome !== 'string' || !samePath(host.codexHome, codexHome) || !isAbsolute(host.socketPath) || !alive(host.bridgePid) || !alive(host.runtimePid) || !alive(host.appPid)) continue;
      if (!privatePath(resolve(host.socketPath, '..'), 'directory') || !privatePath(host.socketPath, 'socket')) continue;
      hosts.push(host);
    } catch { /* Ignore stale or incomplete receipts from a previous launch. */ }
  }
  return hosts;
}
export function findSharedHost(directory:string,codexHome:string):SharedHost|null {const hosts=findSharedHosts(directory,codexHome);if(hosts.length>1)throw new NativeDesktopError('发现多个 Codex 后台，尚无法确认原生任务所属后台。','ambiguous_host');return hosts[0]||null;}

export interface RpcSocket {
  readyState: number;
  on(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  send(data: string, callback?: (error?: Error | null) => void): void;
  terminate(): void;
}
interface Options { directory?: string; codexHome?: string; host?: SharedHost; timeoutMs?: number; preferredLaunchId?:()=>string|undefined; preferredThreadIds?:()=>string[]; onConnected?:(host:SharedHost)=>void; createSocket?:()=>RpcSocket }
type ChangeListener = (snapshot: NativeThreadSnapshot, change: NativeThreadChange) => void;
const userInput = (text: string, images: Array<{ path: string }>) => {
  if (!text.trim() && !images.length) throw new NativeDesktopError('请输入消息或添加图片。', 'invalid_message');
  if (images.some(image => !isAbsolute(image.path) || image.path.includes('\0'))) throw new NativeDesktopError('图片必须使用本地绝对路径。', 'invalid_image');
  return [...(text.trim() ? [{ type: 'text', text, text_elements: [] }] : []), ...images.map(image => ({ type: 'localImage', path: image.path }))];
};

/** A second client of the exact runtime started by Codex App, never another server. */
export class CodexSharedTransport {
  options: Options;
  socket: RpcSocket | null = null;
  host: SharedHost | null = null;
  initialized = false;
  disposed = false;
  error: string | null = null;
  connecting: Promise<void> | null = null;
  pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; mutation: boolean }>();
  snapshots = new Map<string, NativeThreadSnapshot>();
  listeners = new Map<string, Set<ChangeListener>>();
  loading = new Map<string, Promise<NativeThreadSnapshot>>();
  buffered = new Map<string, any[]>();
  sequence = 0;
  projectionOwner = '';
  responseSequences = new WeakMap<object, number>();
  constructor(options: Options = {}) { this.options = options; }
  status() { return { connected: this.initialized && this.socket?.readyState === WebSocket.OPEN, socketPath: this.host?.socketPath || '', lastError: this.error }; }
  threadStatus(id: string) { const snapshot = this.snapshots.get(id); return { ready: this.status().connected && !!snapshot && !this.loading.has(id), detail: this.error || (snapshot ? '已连接 Codex App 共享后台。' : '正在恢复原生任务。'), ...(snapshot ? { lastSyncedAt: snapshot.syncedAt } : {}) }; }
  async connect(): Promise<void> {
    if (this.disposed) throw new NativeDesktopError('原生后台连接已关闭。');
    if (this.status().connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => { this.connecting = null; }); return this.connecting;
  }
  private async selectHost():Promise<SharedHost|null>{
    if(this.options.host)return this.options.host;
    const hosts=findSharedHosts(this.options.directory||join(homedir(),'Library/Application Support/Morrow/codex-bridge'),this.options.codexHome||process.env.CODEX_HOME||join(homedir(),'.codex'));
    const preferred=hosts.find(host=>host.launchId===this.options.preferredLaunchId?.());if(preferred)return preferred;
    if(hosts.length<2)return hosts[0]||null;
    const known=new Set(this.options.preferredThreadIds?.()||[]);
    if(known.size){
      // Inspect only in-memory ownership. Resuming a task here would load it in
      // every candidate and destroy the very evidence used to choose its host.
      const probes=await Promise.allSettled(hosts.map(async host=>{const probe=new CodexSharedTransport({host,timeoutMs:5000});try{return (await probe.loadedThreads()).some(id=>known.has(id));}finally{probe.close();}}));
      const matches=hosts.filter((_,index)=>probes[index].status==='fulfilled'&&(probes[index] as PromiseFulfilledResult<boolean>).value);
      if(matches.length===1&&probes.every(result=>result.status==='fulfilled'))return matches[0];
    }
    throw new NativeDesktopError('发现多个 Codex 后台，尚无法唯一确认已绑定任务所属后台；没有切换或恢复到其他后台。','ambiguous_host');
  }
  async loadedThreads():Promise<string[]>{
    await this.connect();const ids:string[]=[];let cursor:string|undefined;const seen=new Set<string>();
    do{const page=await this.request('thread/loaded/list',{limit:100,...(cursor?{cursor}:{})});ids.push(...page.data);cursor=page.nextCursor||undefined;if(cursor&&(seen.has(cursor)||seen.size>=100))throw new NativeDesktopError('原生已加载任务分页无效。','protocol_mismatch');if(cursor)seen.add(cursor);}while(cursor);
    return ids;
  }
  private async open() {
    this.host = this.options.createSocket ? null : await this.selectHost();
    if (!this.host && !this.options.createSocket) throw new NativeDesktopError('Codex App 尚未连接共享后台。', 'shared_host_unavailable');
    // Revisions belong to this client's connection, not the long-lived host.
    // A daemon reconnect starts at zero and must not be dropped as stale.
    this.projectionOwner=`${this.options.createSocket ? 'cli' : 'shared'}:${this.host?.launchId || ''}:${randomUUID()}`;
    const socket = this.options.createSocket?.() || new WebSocket('ws://localhost/rpc', { createConnection: () => createConnection(this.host!.socketPath), perMessageDeflate: false, maxPayload: 256 * 1024 * 1024, handshakeTimeout: this.options.timeoutMs || 15_000 });
    this.socket = socket;
    socket.on('message', data => { try { this.receive(JSON.parse(data.toString())); } catch (error) { this.error = String(error); socket.terminate(); } });
    socket.on('error', error => { this.error = error.message; });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.initialized = false; this.socket = null; this.snapshots.clear();
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new NativeDesktopError('Codex 连接已断开。', pending.mutation ? 'delivery_unknown' : 'desktop_unavailable', pending.mutation)); }
      this.pending.clear();
    });
    try {
      await new Promise<void>((done, reject) => { socket.once('open', done); socket.once('error', reject); socket.once('close', () => reject(new NativeDesktopError('Codex 在初始化前退出。'))); });
      const result = await this.request('initialize', { clientInfo: { name: 'morrow', title: 'Morrow', version: '0.4.3' }, capabilities: { experimentalApi: true } });
      if (this.host && !samePath(result.codexHome, this.host.codexHome)) throw new NativeDesktopError('原生后台工作目录不匹配。', 'wrong_host');
      socket.send(JSON.stringify({ method: 'initialized' })); this.initialized = true; this.error = null;if(this.host)this.options.onConnected?.(this.host);
    } catch (error) { socket.terminate(); throw error; }
  }
  private request(method: string, params: any, mutation = false): Promise<any> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      if (this.socket?.readyState !== WebSocket.OPEN) { reject(new NativeDesktopError('原生后台未连接。')); return; }
      const timer = setTimeout(() => { this.pending.delete(id); reject(new NativeDesktopError(mutation ? '后台操作结果尚未确认，请等待同步，不要重复发送。' : '原生后台响应超时。', 'request_timeout', mutation)); }, this.options.timeoutMs || 15_000);
      this.pending.set(id, { resolve, reject, timer, mutation });
      this.socket.send(JSON.stringify({ id, method, params }), error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(new NativeDesktopError(error.message, 'delivery_unknown', mutation)); } });
    });
  }
  private receive(message: any) {
    const sequence = ++this.sequence;
    if (message.id != null && !message.method) {
      const pending = this.pending.get(String(message.id)); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(String(message.id));
      if (message.error) pending.reject(new NativeDesktopError(message.error.message || '原生请求失败。', String(message.error.code), false)); else { if (message.result && typeof message.result === 'object') this.responseSequences.set(message.result, sequence); pending.resolve(message.result); }
      return;
    }
    const id = message.params?.threadId || message.params?.thread?.id;
    if (typeof id !== 'string' || (!this.snapshots.has(id) && !this.loading.has(id))) return;
    if (this.loading.has(id)) { const queue = this.buffered.get(id) || []; queue.push({ message, sequence }); this.buffered.set(id, queue); return; }
    this.apply(id, message);
  }
  private emit(id: string, patches: any[], nativeEvent?: any) {
    const old = this.snapshots.get(id); if (!old) return;
    const revision = old.revision + 1;
    const snapshot = { ...old, revision, syncedAt: new Date().toISOString(), state: applyDesktopPatches(old.state, patches) };
    this.snapshots.set(id, snapshot);
    const change = { type: 'patches' as const, baseRevision: old.revision, revision, patches, ...(nativeEvent ? { nativeEvent } : {}) };
    for (const listener of this.listeners.get(id) || []) listener(snapshot, change);
  }
  private apply(id: string, event: any) {
    const state = this.snapshots.get(id)!.state, p = event.params || {}, method = event.method;
    const patches: any[] = [];
    const set = (path: Array<string | number>, value: any) => patches.push({ op: 'add', path, value });
    let turnIndex = state.turns.findIndex((turn: any) => turn.turnId === (p.turnId || p.turn?.id));
    if (method === 'thread/status/changed') set(['threadRuntimeStatus'], p.status);
    else if (method === 'thread/name/updated') set(['name'], p.threadName ?? p.name ?? '');
    else if (method === 'turn/started' || method === 'turn/completed') {
      const old = state.turns[turnIndex]; const turn = { ...old, ...p.turn, turnId: p.turn.id, items: p.turn.items?.length ? p.turn.items : old?.items || [] };
      patches.push({ op: turnIndex < 0 ? 'add' : 'replace', path: ['turns', turnIndex < 0 ? state.turns.length : turnIndex], value: turn });
      set(['threadRuntimeStatus'], { type: method === 'turn/started' ? 'active' : 'idle' });
    } else if (method === 'item/started' || method === 'item/completed') {
      if (turnIndex < 0) { set(['turns', state.turns.length], { turnId: p.turnId, id: p.turnId, status: 'inProgress', items: [p.item] }); }
      else { const index = state.turns[turnIndex].items.findIndex((item: any) => item.id === p.item.id); patches.push({ op: index < 0 ? 'add' : 'replace', path: ['turns', turnIndex, 'items', index < 0 ? state.turns[turnIndex].items.length : index], value: p.item }); }
    } else if ((method?.endsWith('/delta') || method?.endsWith('Delta')) && turnIndex >= 0) {
      const index = state.turns[turnIndex].items.findIndex((item: any) => item.id === p.itemId);
      if (index >= 0 && typeof p.delta === 'string') {
        const item = state.turns[turnIndex].items[index];
        const field = method === 'item/agentMessage/delta' ? 'text' : method === 'item/commandExecution/outputDelta' ? 'aggregatedOutput' : 'text';
        set(['turns', turnIndex, 'items', index, field], (item[field] || '') + p.delta);
      }
    }
    if (event.id != null && method) set(['requests', state.requests.length], { id: event.id, method, params: p });
    if (method === 'serverRequest/resolved') set(['requests'], state.requests.filter((request: any) => String(request.id) !== String(p.requestId)));
    if (!method?.startsWith('codex/event/')) this.emit(id, patches, event);
  }
  async readThread(id: string): Promise<NativeThreadSnapshot> {
    await this.connect();
    if (this.loading.has(id)) return this.loading.get(id)!;
    if (this.snapshots.has(id)) return structuredClone(this.snapshots.get(id)!);
    const hydratedAt = new Map<string, number>();
    const operation = (async () => {
      const result = await this.request('thread/resume', { threadId: id, excludeTurns: true });
      const turns: any[] = []; let cursor: string | null = null; const seen = new Set<string>();
      do { const page = await this.request('thread/turns/list', { threadId: id, limit: 100, cursor, sortDirection: 'asc', itemsView: 'full' }); turns.push(...page.data); for (const turn of page.data) hydratedAt.set(turn.id, this.responseSequences.get(page) || 0); cursor = page.nextCursor; if (cursor && seen.has(cursor)) throw new NativeDesktopError('原生历史分页游标重复。', 'protocol_mismatch'); if (cursor) seen.add(cursor); } while (cursor);
      const snapshot: NativeThreadSnapshot = { threadId: id, ownerClientId: this.projectionOwner, revision: 0, syncedAt: new Date().toISOString(), state: { id, name: result.thread.name, cwd: result.cwd, model: result.model, latestThreadSettings: { model: result.model, cwd: result.cwd, approvalPolicy: result.approvalPolicy, sandboxPolicy: result.sandbox }, currentPermissions: { runtimeWorkspaceRoots: [result.cwd], approvalPolicy: result.approvalPolicy, sandboxPolicy: result.sandbox }, threadRuntimeStatus: result.thread.status, turns: turns.map(turn => ({ ...turn, turnId: turn.id })), requests: [] } };
      this.snapshots.set(id, snapshot); return snapshot;
    })();
    this.loading.set(id, operation);
    try {
      await operation; this.loading.delete(id);
      for (const { message, sequence } of this.buffered.get(id) || []) {
        const cutoff = hydratedAt.get(message.params?.turnId || message.params?.turn?.id);
        const representedByHistory = message.id == null && (message.method?.startsWith('item/') || message.method?.startsWith('turn/'));
        if (!representedByHistory || cutoff === undefined || sequence > cutoff) this.apply(id, message);
      }
      this.buffered.delete(id);
      return structuredClone(this.snapshots.get(id)!);
    } catch (error) { this.loading.delete(id); this.buffered.delete(id); this.snapshots.delete(id); throw error; }
  }
  async loadCompleteHistory(id: string) { return this.readThread(id); }
  async subscribeChanges(id: string, listener: ChangeListener) {
    const snapshot = await this.readThread(id); const group = this.listeners.get(id) || new Set(); group.add(listener); this.listeners.set(id, group);
    listener(snapshot, { type: 'snapshot', revision: snapshot.revision, conversationState: snapshot.state });
    return () => { group.delete(listener); if (!group.size) this.listeners.delete(id); };
  }
  async subscribe(id: string, listener: (snapshot: NativeThreadSnapshot) => void) { return this.subscribeChanges(id, snapshot => listener(structuredClone(snapshot))); }
  async listThreads(cwd: string) { await this.connect(); const result = await this.request('thread/list', { cwd, limit: 250, archived: false, sortKey: 'updated_at' }); return result.data.map((thread: any) => ({ id: thread.id, title: thread.name || thread.preview || '未命名对话', cwd: thread.cwd, model: thread.model, updatedAt: thread.updatedAt * 1000 })); }
  async createThread(cwd: string): Promise<NativeThreadSnapshot> {
    if (!isAbsolute(cwd)) throw new NativeDesktopError('项目必须对应绝对路径。', 'invalid_project');
    await this.connect(); const result = await this.request('thread/start', { cwd, ephemeral: false }, true);
    const snapshot: NativeThreadSnapshot = { threadId: result.thread.id, ownerClientId: this.projectionOwner, revision: 0, syncedAt: new Date().toISOString(), state: { id: result.thread.id, cwd: result.cwd, model: result.model, latestThreadSettings: { cwd: result.cwd, model: result.model, approvalPolicy: result.approvalPolicy, sandboxPolicy: result.sandbox }, currentPermissions: { runtimeWorkspaceRoots: [result.cwd], approvalPolicy: result.approvalPolicy, sandboxPolicy: result.sandbox }, threadRuntimeStatus: result.thread.status, turns: [], requests: [] } };
    this.snapshots.set(snapshot.threadId, snapshot); return structuredClone(snapshot);
  }
  async forkThread(threadId: string, cwd: string): Promise<NativeThreadSnapshot> {
    await this.connect();
    const result = await this.request('thread/fork', { threadId, cwd, excludeTurns: false }, true);
    const id = result.thread.id;
    const snapshot: NativeThreadSnapshot = { threadId: id, ownerClientId: this.projectionOwner, revision: 0, syncedAt: new Date().toISOString(), state: {
      id, name: result.thread.name, cwd: result.cwd, model: result.model,
      latestThreadSettings: { cwd: result.cwd, model: result.model, approvalPolicy: result.approvalPolicy, sandboxPolicy: result.sandbox },
      currentPermissions: { runtimeWorkspaceRoots: [result.cwd], approvalPolicy: result.approvalPolicy, sandboxPolicy: result.sandbox },
      threadRuntimeStatus: result.thread.status, turns: (result.thread.turns || []).map((turn: any) => ({ ...turn, turnId: turn.id })), requests: [],
    } };
    this.snapshots.set(id, snapshot); return structuredClone(snapshot);
  }
  async sendMessage(id: string, text: string, requestId = randomUUID(), images: Array<{ path: string }> = [], workOptions?:NativeWorkOptions) {
    const input = userInput(text, images); const snapshot = await this.readThread(id);
    const active = snapshot.state.turns.findLast((turn: any) => turn.status === 'inProgress');
    if(active&&workOptions)throw new NativeDesktopError('原生任务已开始新的轮次，自动工作将在空闲后继续。','thread_busy');
    const result=await this.request(active ? 'turn/steer' : 'turn/start', { threadId: id, input, clientUserMessageId: requestId, ...(active ? { expectedTurnId: active.turnId } : workOptions || {}) }, true);
    if(workOptions){
      // Acknowledged native overrides also apply to subsequent turns. Keep the
      // local permission projection consistent with that native contract.
      const state=this.snapshots.get(id)!.state;
      this.emit(id,[{op:'add',path:['latestThreadSettings'],value:{...state.latestThreadSettings,...workOptions}},{op:'add',path:['currentPermissions'],value:{...state.currentPermissions,...workOptions}}]);
    }
    return result;
  }
  async interrupt(id: string, turnId: string) { await this.readThread(id); return this.request('turn/interrupt', { threadId: id, turnId }, true); }
  async respond(id: string, requestId: string | number, kind: string, value: unknown) {
    const snapshot = await this.readThread(id); const request = snapshot.state.requests.find((request: any) => String(request.id) === String(requestId));
    const matches = kind === 'command' ? 'commandExecution/requestApproval' : kind === 'file' ? 'fileChange/requestApproval' : kind === 'permissions' ? 'permissions/requestApproval' : kind === 'userInput' ? 'tool/requestUserInput' : kind === 'mcp' ? 'elicitation/request' : '';
    if (!request || !matches || !request.method.includes(matches)) throw new NativeDesktopError('原生请求已处理或类型不匹配。', 'stale_request');
    const result = ['command', 'file'].includes(kind) ? { decision: value } : value;
    this.socket!.send(JSON.stringify({ id: request.id, result }));
    this.emit(id, [{ op: 'replace', path: ['requests'], value: snapshot.state.requests.filter((item: any) => item.id !== request.id) }]); return { ok: true };
  }
  close() { this.disposed = true; this.socket?.terminate(); this.listeners.clear(); }
}
