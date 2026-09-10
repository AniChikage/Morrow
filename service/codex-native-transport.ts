import { CodexDesktopTransport } from './codex-desktop-transport.ts';
import { CodexUsageReader } from './codex-usage.ts';
import type { NativeTransport, NativeSnapshot, NativeWorkOptions } from './native-conversations.ts';

/** Follows tasks owned by the App. Never replaces its executable, server, or task ownership. */
export class CodexNativeTransport implements NativeTransport {
  readonly connectionMode = 'app-follower' as const;
  readonly desktop: CodexDesktopTransport;
  private readonly usage: CodexUsageReader;
  constructor(desktop = new CodexDesktopTransport(), usage = new CodexUsageReader()) {
    this.desktop = desktop;
    this.usage = usage;
  }
  get backgroundReady() {
    return this.desktop.status().connected;
  }
  async connect() {
    return this.desktop.connect();
  }
  status() {
    return this.desktop.status();
  }
  threadStatus(id: string) {
    return this.desktop.threadStatus(id);
  }
  listThreads(cwd: string) {
    return this.desktop.listThreads(cwd);
  }
  readThread(id: string) {
    return this.desktop.readThread(id);
  }
  loadCompleteHistory(id: string) {
    return this.desktop.loadCompleteHistory(id);
  }
  subscribeChanges(id: string, listener: (snapshot: NativeSnapshot, change: any) => void) {
    return this.desktop.subscribeChanges(id, listener);
  }
  subscribe(id: string, listener: (snapshot: NativeSnapshot) => void) {
    return this.desktop.subscribe(id, listener);
  }
  readUsage() {
    return this.usage.read();
  }
  sendMessage(
    id: string,
    text: string,
    requestId?: string,
    images?: Array<{ path: string }>,
    workOptions?: NativeWorkOptions
  ) {
    return this.desktop.sendMessage(id, text, requestId, images, workOptions);
  }
  interrupt(id: string, turnId: string) {
    return this.desktop.interrupt(id, turnId);
  }
  respond(
    id: string,
    requestId: string | number,
    kind: 'command' | 'file' | 'permissions' | 'userInput' | 'mcp',
    response: unknown
  ) {
    return this.desktop.respond(id, requestId, kind, response);
  }
  close() {
    this.desktop.close();
    this.usage.close();
  }
}
