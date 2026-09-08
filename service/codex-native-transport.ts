import { CodexDesktopTransport, NativeDesktopError } from './codex-desktop-transport.ts';
import { CodexSharedTransport } from './codex-shared-transport.ts';
import type { NativeTransport, NativeSnapshot, NativeWorkOptions } from './native-conversations.ts';

/** Keep the existing follower available while the App transitions to its shared host. */
export class CodexNativeTransport implements NativeTransport {
  desktop: CodexDesktopTransport;
  shared: CodexSharedTransport;
  current: NativeTransport;
  subscriptions = new Set<{ id: string; listener: (snapshot: NativeSnapshot, change: any) => void; stop?: () => void }>();
  connecting: Promise<void> | null = null;
  disposed = false;
  constructor(desktop = new CodexDesktopTransport(), shared = new CodexSharedTransport()) { this.desktop = desktop; this.shared = shared; this.current = desktop; }
  get backgroundReady() { return this.current === this.shared && this.shared.status().connected; }
  async connect() {
    if (this.disposed) throw new NativeDesktopError('原生连接已关闭。');
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      let selected: NativeTransport = this.shared;
      try { await this.shared.connect(); } catch (error) {
        // Ambiguous hosts are a configuration failure, never permission to choose one.
        if ((error as any)?.code !== 'shared_host_unavailable') throw error;
        selected = this.desktop; await this.desktop.connect();
      }
      if (selected === this.current) return;
      this.current = selected;
      for (const subscription of this.subscriptions) {
        subscription.stop?.(); subscription.stop = undefined;
        void this.attachSubscription(subscription, selected).catch(() => { /* The next read surfaces the native recovery error. */ });
      }
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  status() { return this.current.status(); }
  threadStatus(id: string) { return this.current.threadStatus?.(id) || { ready: false, detail: '正在连接原生任务。' }; }
  async listThreads(cwd: string) { await this.connect(); return this.current.listThreads(cwd); }
  async readThread(id: string) { await this.connect(); return this.current.readThread(id); }
  async loadCompleteHistory(id: string) { await this.connect(); return this.current.loadCompleteHistory?.(id) || this.current.readThread(id); }
  private async attachSubscription(subscription: { id: string; listener: (snapshot: NativeSnapshot, change: any) => void; stop?: () => void }, transport: NativeTransport) {
    const stop = await transport.subscribeChanges!(subscription.id, (snapshot, change) => { if (!this.disposed && this.current === transport && this.subscriptions.has(subscription)) subscription.listener(snapshot, change); });
    if (this.disposed || this.current !== transport || !this.subscriptions.has(subscription)) stop(); else subscription.stop = stop;
  }
  async subscribeChanges(id: string, listener: (snapshot: NativeSnapshot, change: any) => void) {
    await this.connect(); const subscription = { id, listener, stop: undefined as (() => void) | undefined }; this.subscriptions.add(subscription);
    try { await this.attachSubscription(subscription, this.current); } catch (error) { this.subscriptions.delete(subscription); throw error; }
    return () => { this.subscriptions.delete(subscription); subscription.stop?.(); };
  }
  async subscribe(id: string, listener: (snapshot: NativeSnapshot) => void) { return this.subscribeChanges(id, snapshot => listener(snapshot)); }
  async createThread(cwd: string) { await this.connect(); if (!this.backgroundReady) throw new NativeDesktopError('完成一次 Codex 后台连接设置后，即可直接在这里新建对话。', 'shared_host_unavailable'); return this.shared.createThread(cwd); }
  async sendMessage(id: string, text: string, requestId?: string, images?: Array<{ path: string }>, workOptions?:NativeWorkOptions) {
    await this.connect();
    if(workOptions&&!this.backgroundReady)throw new NativeDesktopError('自动工作需要 Codex 共享后台连接，以应用原生自动审查和频道工作范围。','shared_host_unavailable');
    return this.current.sendMessage(id, text, requestId, images, workOptions);
  }
  async interrupt(id: string, turnId: string) { await this.connect(); return this.current.interrupt(id, turnId); }
  async respond(id: string, requestId: string | number, kind: 'command' | 'file' | 'permissions' | 'userInput' | 'mcp', response: unknown) { await this.connect(); return this.current.respond(id, requestId, kind, response); }
  close() { this.disposed = true; for (const item of this.subscriptions) item.stop?.(); this.subscriptions.clear(); this.desktop.close(); this.shared.close(); }
}
