import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { waitFor } from './timeline.ts';
import type { ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { ServeSpec, ServedApp } from './scenario.ts';

/** Output kept from a served app; enough to read a failed start, not enough to fill a report. */
const outputLimit = 16 * 1024;
/** Real-clock limits. The virtual clock is frozen during a run, so these cannot use `Date`. */
const readyTimeoutMs = 15_000;
const stopTimeoutMs = 5_000;

export type AppStop = { stopped: boolean; code: number | null; signal: string | null; killed: boolean };
export type RunningApp = ServedApp & {
  pid?: number;
  /** stdout and stderr of the app, capped at 16 KiB. */
  output(): string;
  /** Sends SIGTERM, waits for the exit, and escalates to SIGKILL only if it has to. */
  stop(): Promise<AppStop>;
};

/**
 * A free loopback port. The app is started after the project exists, but its address has to be in
 * the project brief before that, so the runner reserves the port first. Binding and releasing is the
 * only way to learn a free one; the gap until the app binds it is a few milliseconds, and a run that
 * loses the race fails loudly on the readiness probe rather than measuring the wrong app.
 */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * Runs the seed project as a real app for the length of one run: `node <args…>` in the isolated
 * project directory, with the reserved port in `PORT` and a minimal environment (no Morrow variables
 * and no credentials). Waits until `ready` answers, then reads `probe` once as JSON so a scenario can
 * assert what the seed itself reports. Nothing is executed through a shell.
 */
export async function startApp(spec: ServeSpec, options: { cwd: string; port: number }): Promise<RunningApp> {
  const url = `http://127.0.0.1:${options.port}`;
  const child = spawn(process.execPath, spec.args, {
    cwd: options.cwd,
    env: {
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || '',
      NO_COLOR: '1',
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      PORT: String(options.port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '';
  const keep = (chunk: unknown) => {
    text = (text + String(chunk)).slice(-outputLimit);
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  let exit: AppStop | undefined;
  child.once('exit', (code, signal) => {
    exit = { stopped: true, code, signal, killed: false };
  });
  const app: RunningApp = {
    url,
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    output: () => text,
    stop: () => stop(child, () => exit),
  };
  try {
    await waitFor(
      async () => {
        if (exit) throw new Error(`应用启动后立即退出（code ${exit.code}，signal ${exit.signal}）：${text.trim()}`);
        return await answers(url + (spec.ready || '/'));
      },
      () => `the seed app to answer ${url}${spec.ready || '/'}（输出：${text.trim() || '无'}）`,
      readyTimeoutMs
    );
    if (spec.probe) app.probe = await readJSON(url + spec.probe);
  } catch (error) {
    await app.stop();
    throw error;
  }
  return app;
}

async function answers(url: string) {
  try {
    const response = await fetch(url);
    await response.arrayBuffer();
    return response.ok;
  } catch {
    // Not listening yet; `waitFor` decides when to give up.
    return false;
  }
}

async function readJSON(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`读取 ${url} 返回 ${response.status}`);
  return await response.json();
}

/** Stops the app the way the dogfood rules require: ask, wait for the exit, and only then force it. */
async function stop(child: ChildProcess, exit: () => AppStop | undefined): Promise<AppStop> {
  const known = exit();
  if (known) return known;
  child.kill('SIGTERM');
  try {
    return await waitFor(
      () => exit(),
      () => `the seed app (pid ${child.pid}) to exit`,
      stopTimeoutMs
    );
  } catch {
    child.kill('SIGKILL');
    const forced = await waitFor(
      () => exit(),
      () => `the seed app (pid ${child.pid}) to exit after SIGKILL`,
      stopTimeoutMs
    ).catch(() => undefined);
    return { ...(forced || { stopped: false, code: null, signal: null }), killed: true };
  }
}
