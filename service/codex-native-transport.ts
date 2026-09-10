import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { homedir } from 'node:os';
import { CodexSharedTransport, type RpcSocket } from './codex-shared-transport.ts';
import { NativeDesktopError } from './codex-desktop-transport.ts';
import { runtimePath } from './runtimes.ts';

/** JSON-RPC over a CLI child owned by Morrow. Never controls App processes. */
class CliSocket extends EventEmitter implements RpcSocket {
  readyState = 0;
  child: ChildProcessWithoutNullStreams;
  constructor(executable: string, env: NodeJS.ProcessEnv) {
    super();
    this.child = spawn(executable, ['app-server', '--listen', 'stdio://'], { cwd: homedir(), env, stdio: ['pipe', 'pipe', 'pipe'] });
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    this.child.once('spawn', () => { if (this.readyState === 0) { this.readyState = 1; this.emit('open'); } });
    this.child.on('error', error => this.emit('error', error));
    this.child.stdin.on('error', error => this.emit('error', error));
    this.child.stderr.resume(); // Drain diagnostics without exposing credentials or retaining unbounded logs.
    this.child.stdout.on('data', chunk => {
      buffer += decoder.write(chunk);
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (line.trim()) this.emit('message', line);
      }
      if (Buffer.byteLength(buffer) > 256 * 1024 * 1024) {
        this.emit('error', new Error('Codex CLI 消息超过读取上限。')); this.terminate();
      }
    });
    this.child.once('close', () => { this.readyState = 3; this.emit('close'); });
  }
  send(data: string, callback?: (error?: Error | null) => void) {
    if (this.readyState !== 1) { callback?.(new Error('Codex CLI 未连接。')); return; }
    this.child.stdin.write(`${data}\n`, callback);
  }
  terminate() {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.child.stdin.end();
    this.child.kill('SIGTERM'); // Only our child; never pkill, App IPC, or an external task.
  }
}

export class CodexNativeTransport extends CodexSharedTransport {
  readonly executionBackend = 'cli' as const;
  constructor(options: { executable?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {
    super({ timeoutMs: options.timeoutMs, createSocket: () => {
      const executable = options.executable || runtimePath('codex');
      if (!executable) throw new NativeDesktopError('未找到 Codex CLI，请在终端安装并运行 codex login。', 'cli_unavailable');
      const env = { ...process.env, ...options.env };
      delete env.CODEX_CLI_PATH; // Retired App bridge override is not CLI configuration.
      return new CliSocket(executable, env);
    } });
  }
  get backgroundReady() { return !!this.status().connected; }
  override threadStatus(id: string) {
    const value = super.threadStatus(id);
    return { ...value, detail: this.error || (value.ready ? '已连接 Codex CLI。' : '正在恢复 Codex CLI 任务。') };
  }
}
