import { spawn, type ChildProcess } from 'node:child_process';

// A private supervisor for one review. The IPC pipe closes even if Morrow is killed,
// so its CLI process group cannot outlive the service or the independent hard deadline.
let child: ChildProcess | undefined;
let deadline: ReturnType<typeof setTimeout> | undefined;
let escalation: ReturnType<typeof setTimeout> | undefined;
let stopping = false;
let exited = false;
function signal(signal: NodeJS.Signals) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}
function stop() {
  if (stopping || exited) return;
  stopping = true;
  signal('SIGTERM');
  escalation = setTimeout(() => signal('SIGKILL'), 1000);
  escalation.unref();
  if (!child) process.exit(1);
}
process.once('disconnect', stop);
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.once(
  'message',
  (message: { executable: string; args: string[]; cwd: string; prompt: string; timeoutMs: number }) => {
    if (stopping || exited) return;
    deadline = setTimeout(stop, Math.min(message.timeoutMs, 300_000));
    child = spawn(message.executable, message.args, {
      cwd: message.cwd,
      env: process.env,
      detached: true,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(message.prompt);
    child.once('error', (error) => {
      process.stderr.write(error.message + '\n');
      process.exitCode = 1;
    });
    child.once('close', (code) => {
      exited = true;
      if (deadline) clearTimeout(deadline);
      if (escalation) clearTimeout(escalation);
      // Kill any descendants left behind after the top-level CLI exited.
      signal('SIGKILL');
      if (process.connected) process.disconnect?.();
      process.exitCode = stopping ? 1 : (code ?? 1);
    });
  }
);
