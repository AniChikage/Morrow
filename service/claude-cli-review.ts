import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { runtimePath } from './runtimes.ts';
import { reviewEnvironment } from './codex-cli-review.ts';
import type { ReviewObservation, ReviewRunner } from './codex-cli-review.ts';

/**
 * What one review is started with. `ReviewRunner` fixes the fields every runner needs; these two are
 * extra context this one uses and the others ignore: the review's own id names the CLI session, and
 * `isolated` says whether the working directory is the disposable checkout of the reviewed version
 * (`service/review-checkout.ts`) — the only condition under which a reviewer may run commands that
 * write, because everything it writes is thrown away with the checkout.
 */
export type ReviewStart = Parameters<ReviewRunner['start']>[0] & { id?: string; isolated?: boolean };
/** Built-in tools a review may use, stated twice below: what exists, and what runs without asking. */
export const claudeReviewTools = { isolated: 'Read,Grep,Glob,Bash', shared: 'Read,Grep,Glob' };
/**
 * One bounded Claude Code turn: no project hooks, plugins or MCP servers, no approval prompts, and
 * the prompt on stdin. The shape is `service/runtimes.ts`'s `invocation()` for a read-only channel;
 * `Bash` is added only for a review that runs in a checkout of its own.
 */
export function claudeReviewArguments(options: { id: string; isolated?: boolean; model?: string }): string[] {
  const tools = options.isolated ? claudeReviewTools.isolated : claudeReviewTools.shared;
  return [
    '--print',
    '--verbose',
    '--output-format',
    'stream-json',
    '--safe-mode',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--tools',
    tools,
    '--allowedTools',
    tools,
    '--permission-mode',
    'dontAsk',
    '--name',
    `Morrow:review-${options.id}`,
    ...(options.model ? ['--model', options.model] : []),
  ];
}
/** A tool result arrives as a string or as content blocks; both become the one string a check reads. */
const resultText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((block: any) => (block && typeof block === 'object' && typeof block.text === 'string' ? block.text : ''))
          .join('')
      : '';
/** What the record shows the reviewer ran: the tool and the arguments it was called with. */
const toolCommand = (name: unknown, input: unknown) =>
  `${typeof name === 'string' ? name : 'tool'} ${JSON.stringify(input ?? {})}`.slice(0, 2000);
/** This source tree's own supervisor; the daemon passes the copy pinned for the build it runs. */
const workerSource = () => fileURLToPath(new URL('./codex-cli-worker.ts', import.meta.url));
type ReviewRunnerOptions = {
  executable?: () => string;
  /** Where to spawn the supervisor from, shared with the Codex runner: one review, one process group. */
  worker?: () => string;
  env?: NodeJS.ProcessEnv;
  maxBytes?: number;
};
/**
 * Runs one bounded Claude Code turn as an independent review, so a review need not spend the same
 * account the implementer already spent. It exposes only what the CLI actually streamed, and the CLI
 * must both report a successful result and exit successfully.
 *
 * Tool calls are reported as `commandExecution` observations — the tool and its arguments as the
 * command, its result as the output — because that is the shape `WorkVerification` counts as a real
 * check, and a read-only review has no shell at all to run one with. The CLI does not expose a
 * numeric status for a tool call, so a result it did not mark as an error is recorded as 0 and one
 * it did as 1. No observation is ever reported as a `fileChange`: the write-capable tools are not
 * offered, and writes a command makes inside a disposable checkout are allowed there.
 */
export class ClaudeCliReviewRunner implements ReviewRunner {
  private options: ReviewRunnerOptions;
  constructor(options: ReviewRunnerOptions = {}) {
    this.options = options;
  }
  get worker() {
    return this.options.worker?.() ?? workerSource();
  }
  start(input: ReviewStart) {
    const executable = this.options.executable?.() ?? runtimePath('claude');
    if (!executable) throw new Error('未找到 Claude Code 命令行，无法启动独立复核。');
    const child = spawn(process.execPath, [this.worker], {
      env: reviewEnvironment(this.options.env),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const items = new Map<string, Record<string, any>>();
    let threadId: string | undefined,
      completed = false,
      error = '',
      stderr = '',
      buffer = '',
      bytes = 0,
      messages = 0,
      canceled = false,
      closed = false;
    const decoder = new StringDecoder('utf8');
    const observation = (status: ReviewObservation['status']): ReviewObservation => ({
      threadId,
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
      if (typeof event?.session_id === 'string' && event.session_id) threadId = event.session_id;
      const content = Array.isArray(event?.message?.content)
        ? event.message.content.filter((block: any) => block && typeof block === 'object')
        : [];
      if (event?.type === 'assistant') {
        const said = content
          .filter((block: any) => block.type === 'text' && typeof block.text === 'string')
          .map((block: any) => block.text)
          .join('\n');
        // Extended thinking carries no answer and no tool call; it is not an observation.
        if (said.trim()) {
          const key = `message-${messages++}`;
          items.set(key, { id: key, type: 'agentMessage', text: said });
        }
        for (const block of content)
          if (block.type === 'tool_use' && typeof block.id === 'string')
            items.set(block.id, {
              id: block.id,
              type: 'commandExecution',
              command: toolCommand(block.name, block.input),
              cwd: input.cwd,
              status: 'inProgress',
              aggregatedOutput: '',
            });
      }
      if (event?.type === 'user')
        for (const block of content)
          if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            const started = items.get(block.tool_use_id);
            if (!started) continue;
            items.set(block.tool_use_id, {
              ...started,
              status: 'completed',
              exitCode: block.is_error === true ? 1 : 0,
              aggregatedOutput: resultText(block.content),
            });
          }
      // The turn's own terminal line, and the only place the whole final answer is complete.
      if (event?.type === 'result') {
        completed = event.is_error !== true;
        const answer = typeof event.result === 'string' ? event.result : '';
        items.set('final', { id: 'final', type: 'agentMessage', phase: 'final_answer', text: answer });
        if (!completed) error ||= answer || (typeof event.subtype === 'string' ? event.subtype : 'CLI 复核运行失败');
      }
      if (event?.type === 'error')
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
        if (!threadId) error ||= 'CLI 没有返回会话 ID';
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
        args: claudeReviewArguments({
          id: input.id || randomUUID(),
          isolated: input.isolated,
          model: input.model,
        }),
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
