import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createConnection, type Socket } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

// This is the installed desktop's owner/follower IPC, not the app-server protocol.
// NoHuman remains a follower: it never takes ownership or launches another Codex.
export interface NativeThreadSummary { id: string; title: string; cwd: string; updatedAt: number; createdAt: number; archived: boolean; model: string | null; source: string }
export interface NativeThreadSnapshot { threadId: string; ownerClientId: string; revision: number; syncedAt: string; state: Record<string, any> }
export type NativeThreadChange = { type: 'snapshot'; revision: number; conversationState: Record<string, any> } | { type: 'patches'; baseRevision: number; revision: number; patches: Array<{ op: 'add' | 'replace' | 'remove'; path: Array<string | number>; value?: unknown }> };
export interface NativeDesktopStatus { connected: boolean; socketPath: string; lastError: string | null }
export interface NativeImageInput { path: string }
export type NativeResponseKind = 'command' | 'file' | 'permissions' | 'userInput' | 'mcp';
interface Options { codexHome?: string; socketPath?: string; requestTimeoutMs?: number; reconnectDelayMs?: number; maxFrameBytes?: number }
interface Pending { resolve: (message: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; mutation: boolean }
interface Subscription { owner: string | null; snapshot: NativeThreadSnapshot | null; error: NativeDesktopError | null; listeners: Set<(snapshot: NativeThreadSnapshot) => void>; changeListeners: Set<(snapshot: NativeThreadSnapshot, change: NativeThreadChange) => void>; waiting: Set<{ resolve: (snapshot: NativeThreadSnapshot) => void; reject: (error: Error) => void; copy: boolean; timer: ReturnType<typeof setTimeout> }>; attaching?: Promise<void> }
const BROADCAST_VERSION = 11;
const RESPONSE_METHODS: Record<NativeResponseKind, [string, string]> = {
  command: ['thread-follower-command-approval-decision', 'item/commandExecution/requestApproval'],
  file: ['thread-follower-file-approval-decision', 'item/fileChange/requestApproval'],
  permissions: ['thread-follower-permissions-request-approval-response', 'item/permissions/requestApproval'],
  userInput: ['thread-follower-submit-user-input', 'item/tool/requestUserInput'],
  mcp: ['thread-follower-submit-mcp-server-elicitation-response', 'mcpServer/elicitation/request'],
};

export class NativeDesktopError extends Error {
  code: string; outcomeUnknown: boolean;
  constructor(message: string, code = 'desktop_unavailable', outcomeUnknown = false) { super(message); this.name = 'NativeDesktopError'; this.code = code; this.outcomeUnknown = outcomeUnknown; }
}
export function encodeDesktopFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4); header.writeUInt32LE(body.length); return Buffer.concat([header, body]);
}
export function applyDesktopPatches(state: Record<string, any>, patches: unknown): Record<string, any> {
  if (!Array.isArray(patches)) throw new NativeDesktopError('原生对话增量格式不受支持。', 'protocol_mismatch');
  // Native snapshots are immutable. Clone only containers along changed paths,
  // preserving unchanged item identity and prior revisions for queued consumers.
  const owned = new WeakSet<object>();
  const copy = (value: any): any => {
    if (value == null || typeof value !== 'object') throw new NativeDesktopError('无效的原生对话增量路径。', 'protocol_mismatch');
    const next = Array.isArray(value) ? value.slice() : { ...value }; owned.add(next); return next;
  };
  let result: any = patches.length ? copy(state) : state;
  for (const patch of patches) {
    if (!patch || !['add', 'replace', 'remove'].includes(patch.op) || !Array.isArray(patch.path) || patch.path.some((key: unknown) => (typeof key !== 'string' && typeof key !== 'number') || ['__proto__', 'constructor', 'prototype'].includes(String(key)))) throw new NativeDesktopError('原生对话增量格式不受支持。', 'protocol_mismatch');
    if (patch.path.length === 0) { if (patch.op === 'remove' || !patch.value || typeof patch.value !== 'object') throw new NativeDesktopError('无效的原生对话快照。', 'protocol_mismatch'); result = structuredClone(patch.value); owned.add(result); continue; }
    let parent = result;
    for (const key of patch.path.slice(0, -1)) {
      if (parent == null || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new NativeDesktopError('原生对话增量缺少前置版本。', 'revision_gap');
      const child = parent[key]; if (child == null || typeof child !== 'object') throw new NativeDesktopError('无效的原生对话增量路径。', 'protocol_mismatch');
      parent = owned.has(child) ? child : (parent[key] = copy(child));
    }
    const key = patch.path.at(-1);
    if (parent == null || typeof parent !== 'object') throw new NativeDesktopError('无效的原生对话增量路径。', 'protocol_mismatch');
    if (Array.isArray(parent) && key !== 'length') {
      const index = Number(key); if (!Number.isInteger(index) || index < 0 || index > parent.length || (patch.op !== 'add' && index >= parent.length)) throw new NativeDesktopError('无效的原生对话数组增量。', 'protocol_mismatch');
      if (patch.op === 'remove') parent.splice(index, 1); else if (patch.op === 'add') parent.splice(index, 0, structuredClone(patch.value)); else parent[index] = structuredClone(patch.value);
    } else if (patch.op === 'remove') delete parent[key]; else parent[key] = structuredClone(patch.value);
  }
  return result;
}

function nativeInput(text: string, images: NativeImageInput[] = []): Array<Record<string, unknown>> {
  if (!Array.isArray(images) || images.some(image => typeof image?.path !== 'string' || !isAbsolute(image.path) || image.path.includes('\0'))) throw new NativeDesktopError('原生图片必须使用有效的本地绝对路径。', 'invalid_image');
  if (!text.trim() && images.length === 0) throw new NativeDesktopError('请输入消息或添加图片。', 'invalid_message');
  return [...(text.trim() ? [{ type: 'text', text, text_elements: [] }] : []), ...images.map(image => ({ type: 'localImage', path: image.path }))];
}

export class CodexDesktopTransport {
  private readonly codexHome: string;
  private readonly timeout: number;
  private readonly options: Options;
  private socket: Socket | null = null;
  private socketPath: string;
  private clientId = 'initializing-client';
  private pending = new Map<string, Pending>();
  private subscriptions = new Map<string, Subscription>();
  private incomingHeader = Buffer.alloc(4);
  private incomingHeaderBytes = 0;
  private incomingFrame: Buffer | null = null;
  private incomingFrameBytes = 0;
  private connecting: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private lastError: string | null = null;
  constructor(options: Options = {}) {
    this.options = options; this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
    this.socketPath = options.socketPath ?? join(this.codexHome, 'ipc', 'ipc.sock'); this.timeout = options.requestTimeoutMs ?? 15_000;
  }
  status(): NativeDesktopStatus { return { connected: !!this.socket && !this.socket.destroyed && this.clientId !== 'initializing-client', socketPath: this.socketPath, lastError: this.lastError }; }
  threadStatus(threadId: string): { ready: boolean; detail: string; lastSyncedAt?: string } { const sub = this.subscriptions.get(threadId); return { ready: this.status().connected && !!sub?.owner && !!sub.snapshot && !sub.error, detail: sub?.error?.message ?? (sub?.snapshot ? '已同步原生任务。' : '尚未收到当前原生任务快照。'), ...(sub?.snapshot ? { lastSyncedAt: sub.snapshot.syncedAt } : {}) }; }
  async connect(): Promise<void> {
    if (this.disposed) throw new NativeDesktopError('原生对话连接已关闭。');
    if (this.status().connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connectInternal().finally(() => { this.connecting = null; }); return this.connecting;
  }
  private validateSocket(path: string): boolean {
    try { const socket = lstatSync(path), dir = lstatSync(resolve(path, '..')), uid = process.getuid?.(); return socket.isSocket() && uid !== undefined && socket.uid === uid && dir.isDirectory() && dir.uid === uid && (dir.mode & 0o022) === 0; } catch { return false; }
  }
  private async connectInternal(): Promise<void> {
    if (!this.validateSocket(this.socketPath) && !this.options.socketPath) {
      const legacy = join(tmpdir(), 'codex-ipc', `ipc-${process.getuid?.()}.sock`); if (this.validateSocket(legacy)) this.socketPath = legacy;
    }
    if (!this.validateSocket(this.socketPath)) { this.lastError = '未找到 Codex App 的本机对话连接，请打开 Codex App。'; throw new NativeDesktopError(this.lastError); }
    const socket = createConnection(this.socketPath); this.socket = socket; this.clearIncoming(); this.clientId = 'initializing-client';
    socket.on('data', chunk => this.receive(socket, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.on('error', error => { this.lastError = error.message; });
    socket.on('close', () => this.disconnected(socket));
    try {
      await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { socket.destroy(); reject(new NativeDesktopError('连接 Codex App 超时。')); }, this.timeout); socket.once('connect', () => { clearTimeout(timer); resolve(); }); socket.once('error', error => { clearTimeout(timer); reject(error); }); });
      const response = await this.request('initialize', { clientType: 'nohuman' }, 0);
      if (typeof response.result?.clientId !== 'string') throw new NativeDesktopError('Codex App 初始化协议不兼容。', 'protocol_mismatch');
      this.clientId = response.result.clientId; this.lastError = null;
      for (const [threadId, sub] of this.subscriptions) if ((sub.listeners.size + sub.changeListeners.size)) void this.attach(threadId, sub).catch(error => { this.lastError = error.message; });
    } catch (error) { socket.destroy(); this.lastError = error instanceof Error ? error.message : String(error); throw error; }
  }
  private write(message: any): void {
    if (!this.socket || this.socket.destroyed) throw new NativeDesktopError('Codex App 已断开。');
    const frame = encodeDesktopFrame(message); if (frame.length - 4 > (this.options.maxFrameBytes ?? 256 * 1024 * 1024)) throw new NativeDesktopError('原生对话数据超过协议限制。', 'frame_too_large'); this.socket.write(frame);
  }
  private request(method: string, params: any, version: number, targetClientId?: string, mutation = false): Promise<any> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new NativeDesktopError(mutation ? 'Codex App 未及时确认操作，结果未知；请等待同步，勿重复发送。' : 'Codex App 响应超时。', 'request_timeout', mutation)); }, this.timeout);
      this.pending.set(requestId, { resolve, reject, timer, mutation });
      try { this.write({ type: 'request', requestId, sourceClientId: this.clientId, version, method, params, ...(targetClientId ? { targetClientId } : {}), timeoutMs: this.timeout - 250 }); } catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }
  private clearIncoming(): void { this.incomingHeaderBytes = 0; this.incomingFrame = null; this.incomingFrameBytes = 0; }
  private receive(socket: Socket, chunk: Buffer): void {
    if (this.disposed || socket !== this.socket) return;
    // Allocate each announced frame once. Repeated Buffer.concat copied a large
    // initial history again for every socket chunk (quadratic total copying).
    let offset = 0;
    try {
      while (offset < chunk.length && !this.disposed && socket === this.socket) {
        if (!this.incomingFrame) {
          const count = Math.min(4 - this.incomingHeaderBytes, chunk.length - offset);
          chunk.copy(this.incomingHeader, this.incomingHeaderBytes, offset, offset + count); this.incomingHeaderBytes += count; offset += count;
          if (this.incomingHeaderBytes < 4) return;
          const size = this.incomingHeader.readUInt32LE(0); this.incomingHeaderBytes = 0;
          if (!size || size > (this.options.maxFrameBytes ?? 256 * 1024 * 1024)) throw new NativeDesktopError('Codex App 数据帧不受支持。', 'protocol_mismatch');
          this.incomingFrame = Buffer.allocUnsafe(size); this.incomingFrameBytes = 0;
        }
        const count = Math.min(this.incomingFrame.length - this.incomingFrameBytes, chunk.length - offset);
        chunk.copy(this.incomingFrame, this.incomingFrameBytes, offset, offset + count); this.incomingFrameBytes += count; offset += count;
        if (this.incomingFrameBytes === this.incomingFrame.length) {
          const frame = this.incomingFrame; this.incomingFrame = null; this.incomingFrameBytes = 0;
          this.handle(JSON.parse(frame.toString('utf8')));
        }
      }
    } catch (error) { this.lastError = error instanceof Error ? error.message : String(error); socket.destroy(); }
  }
  private handle(message: any): void {
    if (message.type === 'response') {
      const pending = this.pending.get(message.requestId); if (!pending) return; this.pending.delete(message.requestId); clearTimeout(pending.timer);
      if (message.resultType === 'error') pending.reject(new NativeDesktopError(message.error === 'no-client-found' ? '请先在 Codex App 中打开此对话，再连接同步。' : String(message.error), message.error)); else pending.resolve(message); return;
    }
    if (message.type === 'client-discovery-request') { this.write({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } }); return; }
    if (message.type !== 'broadcast') return;
    if (message.method === 'client-status-changed' && message.params?.status === 'disconnected') {
      for (const [id, sub] of this.subscriptions) if (sub.owner === message.params.clientId) { sub.owner = null; sub.snapshot = null; sub.error = new NativeDesktopError('原生任务所有者已断开，正在重新连接。'); if ((sub.listeners.size + sub.changeListeners.size)) this.scheduleReconnect(id); } return;
    }
    const params = message.params; if (params?.hostId !== 'local' || typeof params.conversationId !== 'string') return;
    const sub = this.subscriptions.get(params.conversationId); if (!sub) return;
    if (message.method === 'thread-stream-following-status-requested' && message.version === 1 && (sub.listeners.size + sub.changeListeners.size) && sub.owner === message.sourceClientId) { this.follow(params.conversationId, sub, true); return; }
    if (message.method !== 'thread-stream-state-changed' || message.sourceClientId !== sub.owner) return;
    if (message.version !== BROADCAST_VERSION) { this.lastError = 'Codex App 对话协议版本已变化，请更新 NoHuman。'; sub.snapshot = null; sub.error = new NativeDesktopError(this.lastError, 'protocol_mismatch'); this.failWaiters(sub, sub.error); return; }
    const change = params.change;
    try {
      let state: Record<string, any>;
      if (!Number.isInteger(change?.revision) || change.revision < 0) throw new Error('invalid revision');
      if (sub.snapshot && change.revision < sub.snapshot.revision) return;
      if (change.type === 'snapshot') { if (!change.conversationState || change.conversationState.id !== params.conversationId) throw new Error('thread mismatch'); state = change.conversationState; }
      else if (change.type === 'patches' && sub.snapshot && change.baseRevision === sub.snapshot.revision && change.revision > change.baseRevision) state = applyDesktopPatches(sub.snapshot.state, change.patches);
      else { this.refreshSnapshot(params.conversationId, sub); return; }
      sub.error = null;
      sub.snapshot = { threadId: params.conversationId, ownerClientId: sub.owner!, revision: change.revision, syncedAt: new Date().toISOString(), state };
      this.lastError = null; for (const listener of sub.listeners) { try { listener(structuredClone(sub.snapshot)); } catch { /* A consumer failure must not close the native transport. */ } }
      for (const listener of sub.changeListeners) { try { listener(sub.snapshot, change); } catch { /* Consumer owns persistence/retry; never mutate this shared snapshot. */ } }
      for (const waiter of sub.waiting) { clearTimeout(waiter.timer); waiter.resolve(waiter.copy ? structuredClone(sub.snapshot) : sub.snapshot); } sub.waiting.clear();
    } catch { this.lastError = '原生对话增量无法应用，正在重新同步。'; this.refreshSnapshot(params.conversationId, sub); }
  }
  private disconnected(socket: Socket): void {
    if (socket !== this.socket) return; this.socket = null; this.clientId = 'initializing-client'; this.clearIncoming(); this.lastError ??= 'Codex App 已断开。';
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new NativeDesktopError('Codex App 连接已断开。', pending.mutation ? 'delivery_unknown' : 'desktop_unavailable', pending.mutation)); } this.pending.clear();
    for (const sub of this.subscriptions.values()) { sub.owner = null; sub.snapshot = null; sub.error = new NativeDesktopError('Codex App 连接已断开。'); this.failWaiters(sub, new NativeDesktopError('Codex App 连接已断开。')); }
    if (!this.disposed && [...this.subscriptions.values()].some(sub => (sub.listeners.size + sub.changeListeners.size))) this.scheduleReconnect();
  }
  private scheduleReconnect(threadId?: string): void {
    if (this.disposed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.connect().then(async () => { for (const [id, sub] of this.subscriptions) if ((sub.listeners.size + sub.changeListeners.size) && !sub.owner) await this.attach(id, sub); }).catch(error => { this.lastError = error.message; this.scheduleReconnect(); }); }, this.options.reconnectDelayMs ?? 2000); this.reconnectTimer.unref();
  }
  private failWaiters(sub: Subscription, error: Error): void { for (const waiter of sub.waiting) { clearTimeout(waiter.timer); waiter.reject(error); } sub.waiting.clear(); }
  private follow(threadId: string, sub: Subscription, following: boolean): void {
    if (!sub.owner || !this.status().connected) return;
    this.write({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1, sourceClientId: this.clientId, targetClientIds: [sub.owner], params: { conversationId: threadId, hostId: 'local', following } });
  }
  private refreshSnapshot(threadId: string, sub: Subscription): void { sub.snapshot = null; sub.error = new NativeDesktopError('正在重新同步原生任务。', 'resyncing'); this.follow(threadId, sub, false); this.follow(threadId, sub, true); }
  private async attach(threadId: string, sub: Subscription): Promise<void> {
    if (sub.attaching) return sub.attaching;
    sub.attaching = (async () => { const response = await this.request('thread-owner-discovery', { hostId: 'local', conversationId: threadId }, 1); if (typeof response.handledByClientId !== 'string') throw new NativeDesktopError('Codex App 对话所有者不可用。'); sub.owner = response.handledByClientId; sub.error = null; this.follow(threadId, sub, true); })().finally(() => { sub.attaching = undefined; }); return sub.attaching;
  }
  private subscription(threadId: string): Subscription {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(threadId)) throw new NativeDesktopError('无效的原生对话 ID。', 'invalid_thread');
    let sub = this.subscriptions.get(threadId); if (!sub) { sub = { owner: null, snapshot: null, error: null, listeners: new Set(), changeListeners: new Set(), waiting: new Set() }; this.subscriptions.set(threadId, sub); } return sub;
  }
  async readThread(threadId: string): Promise<NativeThreadSnapshot> { return this.readThreadSnapshot(threadId, true); }
  private async readThreadSnapshot(threadId: string, copy: boolean): Promise<NativeThreadSnapshot> {
    await this.connect(); const sub = this.subscription(threadId);
    if (sub.error?.code === 'protocol_mismatch') throw sub.error;
    if (sub.snapshot && sub.owner && !sub.error) return copy ? structuredClone(sub.snapshot) : sub.snapshot;
    await this.attach(threadId, sub);
    if (sub.error?.code === 'protocol_mismatch') throw sub.error;
    if (sub.snapshot) return copy ? structuredClone(sub.snapshot) : sub.snapshot;
    return new Promise((resolve, reject) => { const waiter = { resolve, reject, copy, timer: setTimeout(() => { sub.waiting.delete(waiter); reject(new NativeDesktopError('Codex App 对话快照响应超时。')); }, this.timeout) }; sub.waiting.add(waiter); });
  }
  async subscribe(threadId: string, listener: (snapshot: NativeThreadSnapshot) => void): Promise<() => void> {
    const sub = this.subscription(threadId); sub.listeners.add(listener);
    try { const snapshot = await this.readThread(threadId); listener(snapshot); } catch (error) { sub.listeners.delete(listener); throw error; }
    return () => { sub.listeners.delete(listener); if (!(sub.listeners.size + sub.changeListeners.size)) { this.follow(threadId, sub, false); this.subscriptions.delete(threadId); } };
  }
  /** Every native change, in order. Snapshot/change are shared and MUST NOT be mutated. */
  async subscribeChanges(threadId: string, listener: (snapshot: NativeThreadSnapshot, change: NativeThreadChange) => void): Promise<() => void> {
    const sub = this.subscription(threadId); let delivered = false;
    const receive = (snapshot: NativeThreadSnapshot, change: NativeThreadChange) => { delivered = true; listener(snapshot, change); };
    sub.changeListeners.add(receive);
    try {
      const snapshot = await this.readThreadSnapshot(threadId, false);
      if (!delivered) receive(snapshot, { type: 'snapshot', revision: snapshot.revision, conversationState: snapshot.state });
    } catch (error) { sub.changeListeners.delete(receive); throw error; }
    return () => { sub.changeListeners.delete(receive); if (!(sub.listeners.size + sub.changeListeners.size)) { this.follow(threadId, sub, false); this.subscriptions.delete(threadId); } };
  }
  async loadCompleteHistory(threadId: string): Promise<NativeThreadSnapshot> {
    const snapshot = await this.readThread(threadId); const response = await this.request('thread-follower-load-complete-history', { conversationId: threadId }, 1, snapshot.ownerClientId);
    const sub = this.subscription(threadId); if (sub.snapshot && sub.snapshot.revision >= response.result?.revision) return structuredClone(sub.snapshot);
    this.refreshSnapshot(threadId, sub); return this.readThread(threadId);
  }
  async listThreads(cwd: string): Promise<NativeThreadSummary[]> {
    if (!isAbsolute(cwd)) throw new NativeDesktopError('项目必须对应绝对路径。', 'invalid_project');
    let path: string; try { path = realpathSync(cwd); } catch { path = resolve(cwd); }
    const database = new DatabaseSync(join(this.codexHome, 'state_5.sqlite'), { readOnly: true });
    try {
      const columns = new Set((database.prepare('PRAGMA table_info(threads)').all() as any[]).map(row => row.name));
      const rows = database.prepare(`SELECT id, ${columns.has('name') ? "COALESCE(NULLIF(name, ''), title) AS title" : 'title'}, cwd, updated_at, created_at, archived, source, ${columns.has('model') ? 'model' : 'NULL AS model'} FROM threads WHERE (cwd = ? OR cwd = ?) AND archived = 0 ${columns.has('agent_path') ? 'AND agent_path IS NULL' : ''} ORDER BY updated_at DESC LIMIT 250`).all(cwd, path) as any[];
      return rows.map(row => ({ id: row.id, title: row.title || '未命名对话', cwd: row.cwd, updatedAt: row.updated_at * 1000, createdAt: row.created_at * 1000, archived: !!row.archived, model: row.model, source: row.source }));
    } finally { database.close(); }
  }
  async sendMessage(threadId: string, text: string, clientMessageId: string = randomUUID(), images: NativeImageInput[] = []): Promise<unknown> {
    const input = nativeInput(text, images);
    const snapshot = await this.readThread(threadId);
    const history = snapshot.state.turnHistory?.history;
    const turns = history?.islands && history.entitiesByKey ? history.islands.flatMap((island: any) => (island.entries ?? []).map((entry: any) => history.entitiesByKey[entry.value]).filter(Boolean)) : snapshot.state.turns ?? [];
    if (snapshot.state.threadRuntimeStatus?.type === 'active' || (snapshot.state.threadRuntimeStatus?.type !== 'idle' && turns.at(-1)?.status === 'inProgress')) return this.steer(threadId, text, clientMessageId, images);
    const response = await this.request('thread-follower-start-turn', { conversationId: threadId, turnStart: { request: { threadId, input, clientUserMessageId: clientMessageId }, context: { inheritThreadSettings: true } } }, 2, snapshot.ownerClientId, true);
    return response.result?.result ?? response.result;
  }
  async steer(threadId: string, text: string, clientMessageId: string = randomUUID(), images: NativeImageInput[] = []): Promise<unknown> {
    const input = nativeInput(text, images); const snapshot = await this.readThread(threadId);
    // Desktop steer expects its composer restore object, not a userMessage item.
    // Its handler reads context.workspaceRoots and context.commentAttachments.
    const cwd = snapshot.state.cwd ?? snapshot.state.latestThreadSettings?.cwd;
    const workspaceRoots = snapshot.state.currentPermissions?.runtimeWorkspaceRoots ?? (cwd ? [cwd] : []);
    const restoreMessage = {
      id: clientMessageId, text, cwd, createdAt: Date.now(),
      context: {
        prompt: text, workspaceRoots,
        collaborationMode: snapshot.state.latestCollaborationMode ?? snapshot.state.latestThreadSettings?.collaborationMode ?? null,
        addedFiles: [], fileAttachments: [], pastedTextAttachments: [], ideContext: null, commentAttachments: [],
        imageAttachments: images.map((image, index) => ({ id: `${clientMessageId}-${index}`, src: pathToFileURL(image.path).href, localPath: image.path, filename: basename(image.path) })),
      },
    };
    const response = await this.request('thread-follower-steer-turn', { conversationId: threadId, input, clientUserMessageId: clientMessageId, restoreMessage, attachments: [] }, 1, snapshot.ownerClientId, true); return response.result?.result ?? response.result;
  }
  async interrupt(threadId: string, expectedTurnId: string): Promise<unknown> { if (!expectedTurnId) throw new NativeDesktopError('缺少要停止的原生轮次。', 'invalid_turn'); const snapshot = await this.readThread(threadId); return (await this.request('thread-follower-interrupt-turn', { conversationId: threadId, mode: 'user-stop', expectedTurnId }, 4, snapshot.ownerClientId, true)).result; }
  async respond(threadId: string, requestId: string | number, kind: NativeResponseKind, response: unknown): Promise<unknown> {
    const snapshot = await this.readThread(threadId); const mapping = RESPONSE_METHODS[kind]; if (!mapping) throw new NativeDesktopError('此原生请求请在 Codex App 中处理。', 'unsupported_request');
    const request = (snapshot.state.requests ?? []).find((item: any) => String(item.id) === String(requestId)); if (!request || request.method !== mapping[1]) throw new NativeDesktopError('该请求已处理或类型不匹配，请刷新对话。', 'stale_request');
    return (await this.request(mapping[0], { conversationId: threadId, requestId: request.id, ...(['command', 'file'].includes(kind) ? { decision: response } : { response }) }, 1, snapshot.ownerClientId, true)).result;
  }
  close(): void { this.disposed = true; if (this.reconnectTimer) clearTimeout(this.reconnectTimer); for (const [id, sub] of this.subscriptions) this.follow(id, sub, false); this.socket?.destroy(); for (const sub of this.subscriptions.values()) this.failWaiters(sub, new NativeDesktopError('原生对话连接已关闭。')); this.subscriptions.clear(); }
}
