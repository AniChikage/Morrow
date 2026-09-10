import { spawn } from 'node:child_process';
import { runtimePath } from './runtimes.ts';
import type { UsageReading, UsageWindow, UsageWindowReading } from './protocol.ts';

/**
 * App-server method that returns the account's rate-limit windows. Confirmed against the real App on
 * 2026-09-09: this name, camelCase fields, `resetsAt` in unix seconds. A method-not-found error still
 * reads only as "usage unknown", never as a failure. That probe also showed the main `codex` limit can
 * expose a weekly window alone (`secondary: null`), with a 5-hour window only inside
 * `rateLimitsByLimitId` for a separate model bucket; reading per limit id is not implemented.
 */
export const usageReadMethod = 'account/rateLimits/read';
/** Notification carrying the same payload when the backend refreshes the limits itself; confirmed 2026-09-09. */
export const usageUpdatedNotification = 'account/rateLimits/updated';
const isoTime = (value: unknown): string | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Unix seconds or milliseconds: anything below 1e12 cannot be a millisecond timestamp of this century.
    const date = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value === 'string') {
    const date = new Date(
      /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) * (Number(value) < 1e12 ? 1000 : 1) : value
    );
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
};
/** Maps a rate-limit payload (camelCase or snake_case) to Morrow's reading; `undefined` when nothing usable is in it. */
export function parseUsageReading(payload: unknown, at = new Date().toISOString()): UsageReading | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const raw = payload as Record<string, any>;
  const limits = raw.rateLimits ?? raw.rate_limits ?? raw;
  if (!limits || typeof limits !== 'object') return undefined;
  const windows: UsageWindowReading[] = [];
  for (const [key, fallback] of [
    ['primary', '5h'],
    ['secondary', 'weekly'],
  ] as const) {
    const entry = limits[key];
    if (!entry || typeof entry !== 'object') continue;
    const value = entry.usedPercent ?? entry.used_percent;
    if (value == null || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) continue;
    const used = Number(value);
    if (!Number.isFinite(used)) continue;
    const minutes = Number(entry.windowDurationMins ?? entry.window_duration_mins);
    const hasMinutes = Number.isFinite(minutes) && minutes > 0;
    const name: UsageWindow = hasMinutes ? (minutes <= 600 ? '5h' : 'weekly') : fallback;
    if (windows.some((window) => window.name === name)) continue;
    const resetsAt = isoTime(entry.resetsAt ?? entry.resets_at);
    windows.push({
      name,
      usedPercent: Math.min(100, Math.max(0, used)),
      ...(resetsAt ? { resetsAt } : {}),
      ...(hasMinutes ? { windowMinutes: minutes } : {}),
    });
  }
  return windows.length ? { at, source: 'protocol', windows } : undefined;
}

/** Independent read-only RPC client. No task or model turn is created and no App launch path is changed. */
export class CodexUsageReader {
  private pending?: Promise<UsageReading | undefined>;
  private stop?: () => void;
  private options: { executable?: () => string; timeoutMs?: number };
  constructor(options: { executable?: () => string; timeoutMs?: number } = {}) {
    this.options = options;
  }
  read(): Promise<UsageReading | undefined> {
    if (this.pending) return this.pending;
    this.pending = this.query().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private query(): Promise<UsageReading | undefined> {
    const executable = this.options.executable?.() ?? runtimePath('codex');
    if (!executable) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const child = spawn(
        executable,
        ['app-server', '--listen', 'stdio://', '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"'],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      );
      let settled = false,
        buffer = '',
        bytes = 0;
      const finish = (reading?: UsageReading) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.stop = undefined;
        child.stdin.end();
        child.kill('SIGTERM');
        const kill = setTimeout(() => child.kill('SIGKILL'), 1000);
        kill.unref();
        child.once('close', () => clearTimeout(kill));
        resolve(reading);
      };
      const timer = setTimeout(() => finish(), this.options.timeoutMs ?? 12_000);
      this.stop = () => finish();
      child.once('error', () => finish());
      child.once('close', () => finish());
      child.stdin.on('error', () => finish());
      child.stderr.on('data', () => {});
      const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) return finish();
        buffer += chunk.toString();
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let message: any;
          try {
            message = JSON.parse(line);
          } catch {
            return finish();
          }
          if (message.id === 1) {
            if (message.error) return finish();
            send({ method: 'initialized' });
            send({ id: 2, method: usageReadMethod, params: {} });
          } else if (message.id === 2) finish(message.error ? undefined : parseUsageReading(message.result));
          if (settled) return;
        }
      });
      send({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'morrow_usage', version: '1' }, capabilities: { experimentalApi: true } },
      });
    });
  }
  close() {
    this.stop?.();
  }
}
