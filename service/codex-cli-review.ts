import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { runtimePath } from './runtimes.ts';

export type ReviewObservation = {
  threadId?: string;
  turnId?: string;
  items: Record<string, any>[];
  status: 'inProgress' | 'completed' | 'failed';
  error?: string;
};
export interface ReviewRunner {
  start(options: {
    cwd: string;
    prompt: string;
    timeoutMs: number;
    model?: string;
    observe: (snapshot: ReviewObservation) => void;
  }): { cancel(): void; done: Promise<void> };
}
export function reviewArguments(model?: string): string[] {
  return [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--color',
    'never',
    '--sandbox',
    'read-only',
    '-c',
    'approval_policy="never"',
    '-c',
    'web_search="disabled"',
    '-c',
    'mcp_servers={}',
    '-c',
    'features.apps=false',
    ...(model ? ['--model', model] : []),
    '-',
  ];
}
/** Do not carry the implementer's Morrow grant or App-local runtime pipes into a review. */
export function reviewEnvironment(source = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env))
    if (
      /^(MORROW_|NOHUMAN_|NODE_REPL_|BROWSER_USE_|SKY_|CODEX_INTERNAL_|CODEX_APP_|CODEX_THREAD_|CODEX_TURN_|CODEX_SESSION_)/.test(
        key
      ) ||
      [
        'CODEX_CLI_PATH',
        'CODEX_MCP_NODE_PATH',
        'CODEX_BROWSER_USE_NODE_PATH',
        'CODEX_NODE_REPL_PATH',
        'NODE_OPTIONS',
        'ELECTRON_RUN_AS_NODE',
      ].includes(key)
    )
      delete env[key];
  return env;
}
function reviewItem(item: Record<string, any>) {
  if (item.type === 'command_execution')
    return {
      ...item,
      type: 'commandExecution',
      aggregatedOutput: item.aggregated_output ?? '',
      exitCode: item.exit_code,
    };
  if (item.type === 'agent_message')
    return { ...item, type: 'agentMessage', text: item.text ?? '', phase: 'final_answer' };
  if (item.type === 'file_change') return { ...item, type: 'fileChange' };
  return item;
}
/** This source tree's own supervisor: what a dev run and every test spawn without a pinned copy. */
const workerSource = () => fileURLToPath(new URL('./codex-cli-worker.ts', import.meta.url));
type ReviewRunnerOptions = {
  executable?: () => string;
  /** Where to spawn the supervisor from; the daemon passes the copy pinned for the build it runs. */
  worker?: () => string;
  env?: NodeJS.ProcessEnv;
  maxBytes?: number;
};
/** Runs one official CLI session and exposes only actual streamed items. CLI exit must also succeed. */
export class CodexCliReviewRunner implements ReviewRunner {
  private options: ReviewRunnerOptions;
  constructor(options: ReviewRunnerOptions = {}) {
    this.options = options;
  }
  /** The supervisor this runner starts, read-only: the pinned copy, or this source tree's own file. */
  get worker() {
    return this.options.worker?.() ?? workerSource();
  }
  start(input: Parameters<ReviewRunner['start']>[0]) {
    const executable = this.options.executable?.() ?? runtimePath('codex');
    if (!executable) throw new Error('未找到官方 Codex 命令行，无法启动独立只读复核。');
    const child = spawn(process.execPath, [this.worker], {
      env: reviewEnvironment(this.options.env),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const items = new Map<string, Record<string, any>>();
    let threadId: string | undefined,
      turnId: string | undefined,
      completed = false,
      error = '',
      stderr = '',
      buffer = '',
      bytes = 0,
      canceled = false,
      closed = false;
    const decoder = new StringDecoder('utf8');
    const observation = (status: ReviewObservation['status']): ReviewObservation => ({
      threadId,
      turnId,
      items: [...items.values()],
      status,
      ...(error ? { error } : {}),
    });
    const cancel = () => {
      if (canceled || closed) return;
      canceled = true;
      if (child.connected) child.disconnect();
      child.kill('SIGTERM');
    };
    const fail = (reason: string) => {
      error ||= reason;
      cancel();
    };
    const line = (text: string) => {
      if (!text.trim()) return;
      let event: any;
      try {
        event = JSON.parse(text);
      } catch {
        fail('CLI 返回了无法解析的事件，不能核验完整结果');
        return;
      }
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') threadId = event.thread_id;
      if (event.type === 'turn.started' && typeof event.turn_id === 'string') turnId = event.turn_id;
      if (event.item && typeof event.item === 'object' && event.item.id != null)
        items.set(String(event.item.id), reviewItem(event.item));
      if (event.type === 'turn.completed') completed = true;
      if (event.type === 'error' || event.type === 'turn.failed')
        error ||= typeof event.message === 'string' ? event.message : event.error?.message || 'CLI 复核运行失败';
      // A terminal model event is insufficient until stdout closes and the process exits successfully.
      input.observe(observation('inProgress'));
    };
    child.stdout!.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (this.options.maxBytes ?? 4 * 1024 * 1024)) return fail('CLI 复核输出超过上限，不能核验完整结果');
      buffer += decoder.write(chunk);
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const text = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        line(text);
        if (canceled) break;
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-64 * 1024);
    });
    const done = new Promise<void>((resolve) => {
      let exited = false,
        outputEnded = false,
        errorEnded = false,
        exitCode: number | null = null;
      const finish = () => {
        if (closed || !exited || !outputEnded || !errorEnded) return;
        closed = true;
        if (!canceled) {
          buffer += decoder.end();
          if (buffer.trim()) line(buffer);
        }
        if (!threadId) error ||= 'CLI 没有返回原生会话 ID';
        if (exitCode !== 0 || canceled || !completed)
          error ||= stderr.trim().slice(-1500) || 'CLI 未正常完成，结果保留未知';
        input.observe(observation(error ? 'failed' : 'completed'));
        resolve();
      };
      child.once('error', (e) => {
        error = e.message;
      });
      child.once('exit', (code) => {
        exited = true;
        exitCode = code;
        finish();
      });
      child.stdout!.once('close', () => {
        outputEnded = true;
        finish();
      });
      child.stderr!.once('close', () => {
        errorEnded = true;
        finish();
      });
      child.once('close', (code) => {
        exited = outputEnded = errorEnded = true;
        exitCode = code;
        finish();
      });
    });
    child.send(
      {
        executable,
        args: reviewArguments(input.model),
        cwd: input.cwd,
        prompt: input.prompt,
        timeoutMs: input.timeoutMs,
      },
      (error) => {
        if (error && !closed) fail(error.message);
      }
    );
    return { cancel, done };
  }
}
