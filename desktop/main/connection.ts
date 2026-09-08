import { app } from 'electron';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { access, mkdir, readFile, writeFile, rename, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ConnectionConfig, ConnectionInfo, EventsPage, EventsQuery, Snapshot, WorkspaceEvent } from '../shared/types';
import { connectionConfig } from './validation';

const execute = promisify(execFile);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
class ServiceError extends Error { constructor(message: string, readonly status = 0) { super(message); } }

export class ServiceConnection {
  readonly dataDirectory = process.env.NOHUMAN_HOME || join(homedir(), 'Library/Application Support/NoHuman');
  readonly localPort = Number(process.env.NOHUMAN_PORT || 43821);
  private config: ConnectionConfig = { mode: 'local', host: '', port: this.localPort, directory: this.dataDirectory };
  private connected = false;
  private error = '';
  private remoteToken = '';
  private tunnel?: ChildProcess;
  private generation = 0;
  private transitioning = false;
  private initialized?: Promise<void>;
  private readonly tunnelPort = 43822;
  private readonly preferencesPath = join(this.dataDirectory, 'desktop-connection.json');

  initialize(): Promise<void> {
    return this.initialized ??= this.initializeOnce();
  }
  private async initializeOnce(): Promise<void> {
    let config = this.config;
    try { config = connectionConfig(JSON.parse(await readFile(this.preferencesPath, 'utf8'))); }
    catch { config = await this.importSwiftConnection(); }
    await this.switchConnection(config, false);
  }
  info(): ConnectionInfo {
    return { config: { ...this.config }, connected: this.connected, name: this.config.mode === 'ssh' ? `远程 · ${this.config.host}` : '本机 Mac', ...(this.error ? { error: this.error } : {}) };
  }
  async getInfo(): Promise<ConnectionInfo> { await this.initialize(); return this.info(); }
  async connect(config: ConnectionConfig): Promise<ConnectionInfo> {
    await this.initialize();
    return this.switchConnection(config, true);
  }
  private async importSwiftConnection(): Promise<ConnectionConfig> {
    if (process.platform !== 'darwin') return this.config;
    const preference = async (key: string): Promise<string> => {
      try { return (await execute('/usr/bin/defaults', ['read', 'ai.nohuman.desktop', key], { timeout: 2000, maxBuffer: 8192 })).stdout.trim(); }
      catch { return ''; }
    };
    // Only connection preferences are read. Provider accounts and credentials are untouched.
    const [usingRemote, host, port, directory] = await Promise.all(['usingRemote', 'remoteHost', 'remotePort', 'remoteDirectory'].map(preference));
    if (usingRemote !== '1' && usingRemote !== 'true') return this.config;
    try { return connectionConfig({ mode: 'ssh', host, port: Number(port || 43821), directory: directory || '~/.local/share/nohuman' }); }
    catch { return this.config; }
  }
  private async switchConnection(config: ConnectionConfig, persist: boolean): Promise<ConnectionInfo> {
    if (this.transitioning) throw new Error('连接正在切换，请稍后重试。');
    this.transitioning = true;
    this.generation += 1;
    this.connected = false;
    this.error = '';
    this.config = config.mode === 'local' ? { mode: 'local', host: '', port: this.localPort, directory: this.dataDirectory } : config;
    await this.stopTunnel();
    try {
      if (config.mode === 'ssh') await this.startTunnel(this.config);
      else await this.ensureLocalService();
      await this.requestDirect<Snapshot>('state');
      this.connected = true;
      if (persist) {
        await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
        const temporary = `${this.preferencesPath}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(this.config, null, 2), { mode: 0o600 });
        await rename(temporary, this.preferencesPath);
      }
    } catch (error) {
      this.error = this.safeError(error);
      this.connected = false;
      await this.stopTunnel();
    } finally { this.transitioning = false; }
    return this.info();
  }
  private async probe(port: number): Promise<'online' | 'absent' | 'other'> {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
      const value = await response.json() as { ok?: boolean; service?: string };
      return response.ok && value.ok === true && value.service === 'nohuman' ? 'online' : 'other';
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause;
      return cause?.code === 'ECONNREFUSED' ? 'absent' : 'other';
    }
  }
  private async ensureLocalService(): Promise<void> {
    const health = await this.probe(this.localPort);
    if (health === 'online') return;
    if (health === 'other') throw new Error(`本机 ${this.localPort} 端口已有无法识别的服务，请检查连接设置。`);
    const projectRoot = app.getAppPath();
    const candidates = app.isPackaged ? [join(process.resourcesPath, 'bin/node')] : [join(projectRoot, '.build/runtime-cache/node/bin/node'), process.env.NOHUMAN_NODE || '', '/opt/homebrew/bin/node', '/usr/local/bin/node'];
    let node = '';
    for (const candidate of candidates) {
      if (!candidate) continue;
      try { await access(candidate, constants.X_OK); node = candidate; break; } catch { /* next candidate */ }
    }
    if (!node) throw new Error('未找到随应用打包的 Node.js 24+，请重新构建 NoHuman。');
    const version = (await execute(node, ['--version'], { timeout: 5000, maxBuffer: 1024 })).stdout;
    if (Number(version.match(/^v(\d+)/)?.[1] || 0) < 24) throw new Error('执行服务需要 Node.js 24 或更高版本。');
    const entry = app.isPackaged ? join(process.resourcesPath, 'service/server.ts') : join(projectRoot, 'service/server.ts');
    await access(entry);
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    const log = await open(join(this.dataDirectory, 'service.log'), 'a', 0o600);
    try {
      const path = [join(homedir(), '.local/bin'), join(homedir(), '.cargo/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', process.env.PATH || ''].join(':');
      const child = spawn(node, [entry], {
        cwd: app.isPackaged ? process.resourcesPath : projectRoot, detached: true, stdio: ['ignore', log.fd, log.fd],
        env: { ...process.env, PATH: path, NOHUMAN_HOME: this.dataDirectory, NOHUMAN_PORT: String(this.localPort) }
      });
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref(); // The independent daemon intentionally survives app shutdown.
    } finally { await log.close(); }
    for (let attempt = 0; attempt < 48; attempt += 1) {
      if (await this.probe(this.localPort) === 'online') return;
      await delay(250);
    }
    throw new Error('执行服务未能启动，请查看数据目录中的 service.log。现有服务不会被自动重启。');
  }
  private async startTunnel(config: ConnectionConfig): Promise<void> {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const tokenPath = config.directory.startsWith('~/') ? `"$HOME"/${quote(`${config.directory.slice(2)}/token`)}` : quote(`${config.directory}/token`);
    let token = '';
    try {
      const result = await execute('/usr/bin/ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', config.host, `head -c 129 -- ${tokenPath}`], { timeout: 12000, maxBuffer: 1024 });
      token = result.stdout.trim();
    } catch { throw new Error('无法读取远程服务令牌。请先在终端完成 SSH 首次连接，并确认远程服务已运行。'); }
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('远程令牌格式无效，请确认远程数据目录。');
    const child = spawn('/usr/bin/ssh', ['-N', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-L', `127.0.0.1:${this.tunnelPort}:127.0.0.1:${config.port}`, config.host], { stdio: 'ignore' });
    this.tunnel = child;
    this.remoteToken = token;
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.once('exit', () => {
      if (this.tunnel === child) { this.connected = false; this.remoteToken = ''; this.error = 'SSH 连接已断开，请重新连接。'; }
    });
    await delay(700);
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('SSH 隧道未能建立，请检查主机连接或本机 43822 端口。');
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (await this.probe(this.tunnelPort) === 'online') return;
      await delay(250);
    }
    throw new Error('SSH 已连接，但远程 NoHuman 服务无响应，请确认服务端口。');
  }
  async stopTunnel(): Promise<void> {
    const child = this.tunnel;
    this.tunnel = undefined;
    this.remoteToken = '';
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([new Promise<void>(resolve => child.once('exit', () => resolve())), delay(800)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  private safeError(error: unknown): string {
    if (error instanceof ServiceError && error.status === 401) return '执行服务拒绝认证，请检查数据目录是否属于当前服务。';
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) return '执行服务响应超时，请稍后重试。';
    if (error instanceof TypeError && error.message === 'fetch failed') return '无法连接执行服务，请检查服务是否运行。';
    const message = error instanceof Error ? error.message : '无法连接执行服务。';
    return this.remoteToken ? message.replaceAll(this.remoteToken, '[REDACTED]') : message;
  }
  private async requestDirect<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const generation = this.generation;
    const port = this.config.mode === 'ssh' ? this.tunnelPort : this.localPort;
    const token = this.config.mode === 'ssh' ? this.remoteToken : (await readFile(join(this.dataDirectory, 'token'), 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('执行服务尚未准备好，请检查连接。');
    const response = await fetch(`http://127.0.0.1:${port}/api/${path}`, {
      method, signal: AbortSignal.timeout(15000), redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (Number(response.headers.get('content-length') || 0) > 40 * 1024 * 1024) throw new Error('执行服务响应过大。');
    const source = await response.text();
    if (source.length > 40 * 1024 * 1024) throw new Error('执行服务响应过大。');
    if (generation !== this.generation) throw new Error('连接已经切换，请重试。');
    const sanitized = source.replaceAll(token, '[REDACTED]');
    let data: unknown;
    try { data = JSON.parse(sanitized); } catch { throw new Error('执行服务返回了无效响应。'); }
    if (!response.ok) throw new ServiceError(typeof (data as { error?: unknown })?.error === 'string' ? (data as { error: string }).error : `操作失败（${response.status}）。`, response.status);
    return data as T;
  }
  async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    await this.initialize();
    if (this.transitioning) throw new Error('连接正在切换，请稍后重试。');
    const generation = this.generation;
    try {
      const result = await this.requestDirect<T>(path, method, body);
      if (generation === this.generation) { this.connected = true; this.error = ''; }
      return result;
    }
    catch (error) {
      this.recordFailure(error, generation);
      throw new Error(this.safeError(error));
    }
  }
  private recordFailure(error: unknown, generation: number): void {
    if (generation === this.generation && (!(error instanceof ServiceError) || error.status === 401)) {
      this.connected = false;
      this.error = this.safeError(error);
    }
  }
  async state(): Promise<Snapshot> { return this.request<Snapshot>('state'); }
  async events(query: EventsQuery): Promise<EventsPage> {
    await this.initialize();
    if (this.transitioning) throw new Error('连接正在切换，请稍后重试。');
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => { if (value !== undefined) params.set(key, String(value)); });
    const generation = this.generation;
    try {
      const page = await this.requestDirect<EventsPage>(`events?${params}`);
      if (generation === this.generation) { this.connected = true; this.error = ''; }
      return page;
    }
    catch (error) {
      if (!(error instanceof ServiceError) || error.status !== 404 || error.message !== '接口不存在') {
        this.recordFailure(error, generation);
        throw new Error(this.safeError(error));
      }
      // Existing daemon versions remain running: pagination degrades to their retained snapshot.
      const snapshot = await this.state();
      // Snapshots already follow SQLite insertion order, including equal-timestamp events.
      let events = snapshot.events.filter(event => (!query.channelId || event.channelId === query.channelId) && (!query.projectId || (event.projectId || snapshot.channels.find(channel=>channel.id===event.channelId)?.projectId) === query.projectId) && (!query.itemId || event.itemId === query.itemId) && (!query.runId || event.runId === query.runId));
      const boundary = (cursor: string, before: boolean) => {
        const index = events.findIndex(event => event.id === cursor);
        if (index >= 0) return before ? events.slice(0, index) : events.slice(index + 1);
        return []; // A cursor outside the retained old-daemon snapshot cannot be paged further.
      };
      if (query.before) events = boundary(query.before, true);
      if (query.after) events = boundary(query.after, false);
      const limit = query.limit ?? 50;
      const hasMore = events.length > limit;
      const page: WorkspaceEvent[] = query.after ? events.slice(0, limit) : events.slice(-limit);
      return { events: page, hasMore, ...(page.length ? { cursor: (query.after ? page.at(-1) : page[0])!.id } : {}) };
    }
  }
}
