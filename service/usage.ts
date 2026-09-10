import { randomUUID } from 'node:crypto';
import { choice, integer, keys, object, usageWindows } from './protocol.ts';
import type {
  Channel,
  Project,
  Run,
  Settings,
  UsageBudget,
  UsageReading,
  UsageReserve,
  UsageSample,
  UsageStatus,
  UsageWindow,
  UsageWindowReading,
} from './protocol.ts';
import type { NativeTransport } from './native-conversations.ts';
import { Store, now } from './store.ts';

/** A reading older than this is re-read before it decides anything; the UI shows it as stale. */
export const usageFreshnessMs = 10 * 60_000;
/** Newest sample rows kept in `usage_samples`; older polls and run samples are pruned. */
export const usageSampleLimit = 2000;
/** A failed read is not retried more often than this, so a dead protocol does not get hammered by the scheduler. */
export const usageRetryBackoffMs = 30_000;
/** Nominal window lengths, used when a reading does not carry its own duration. */
export const usageWindowMinutes: Record<UsageWindow, number> = { '5h': 300, weekly: 10080 };
export const usageWindowLabels: Record<UsageWindow, string> = { '5h': '5 小时', weekly: '每周' };
export type UsageGate =
  | { blocked: false }
  | {
      blocked: true;
      kind: 'reserve' | 'budget' | 'unknown';
      window?: UsageWindow;
      resetsAt?: string;
      until: string;
      /** A read is in flight and nothing is known yet: callers wait a few seconds silently. */
      pending?: boolean;
      message: string;
    };
export type ProjectUsage = { usedPercent: number; runs: number; windowStart: string };
/** The context/prompt view of the limits: daily runs plus the account and project usage numbers. */
export type BudgetContext = {
  runsToday: number;
  maxRunsPerDay: number;
  usage: {
    reading?: UsageReading;
    stale?: boolean;
    unknown: boolean;
    reserve?: UsageReserve;
    project?: { window: UsageWindow; limitPercent: number; usedPercent: number };
  };
};
/** One second past the next UTC midnight: the shared "try again tomorrow" moment of every daily limit. */
export function nextUtcDay(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(0, 0, 1, 0);
  return d.toISOString();
}
const pad = (value: number) => String(value).padStart(2, '0');
/** Local wall-clock `MM-DD HH:mm` for event and gate messages; the service runs beside the user. */
export function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const percent = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));
const future = (iso?: string) => !!iso && Date.parse(iso) > Date.now();
function usageWindowInput(value: unknown, field: string): UsageWindow {
  return choice(value, field, usageWindows);
}
export function usageBudgetInput(value: unknown): UsageBudget | null {
  if (value === null) return null;
  const data = object(value);
  keys(data, ['window', 'limitPercent']);
  return {
    window: usageWindowInput(data.window, 'window'),
    limitPercent: integer(data.limitPercent, 'limitPercent', 1, 100),
  };
}
export function usageReserveInput(value: unknown): UsageReserve | null {
  if (value === null) return null;
  const data = object(value);
  keys(data, ['window', 'keepPercent']);
  return {
    window: usageWindowInput(data.window, 'window'),
    keepPercent: integer(data.keepPercent, 'keepPercent', 1, 99),
  };
}
/** Per-window growth between two readings; only windows present in both count, and negative growth is a reset. */
export function usageDelta(before: UsageReading, after: UsageReading): Partial<Record<UsageWindow, number>> {
  const delta: Partial<Record<UsageWindow, number>> = {};
  for (const window of after.windows) {
    const start = before.windows.find((w) => w.name === window.name);
    if (!start) continue;
    delta[window.name] = Math.max(0, Math.round((window.usedPercent - start.usedPercent) * 10) / 10);
  }
  return delta;
}
const stripScope = ({ id, phase, projectId, channelId, runId, ...reading }: UsageSample): UsageReading => reading;

/**
 * Reads the account's rate-limit windows through the native transport, keeps bounded samples, attributes
 * before/after differences to runs, and decides whether a new automatic turn may start.
 */
export class UsageMonitor {
  store: Store;
  transport?: NativeTransport;
  reading: Promise<UsageReading | undefined> | null = null;
  lastAttemptAt = 0;
  lastError = '';
  /** Strips the desktop token before an error reaches the UI; the engine replaces it with its own. */
  redact: (value: string) => string = (value) => value;
  timer: NodeJS.Timeout | undefined;
  closed = false;
  constructor(store: Store, transport?: NativeTransport) {
    this.store = store;
    this.transport = transport;
  }
  connect(transport: NativeTransport) {
    this.transport = transport;
  }
  /** The single settings row; until the first read or save a stable, unwritten default stands in for it. */
  settings(): Settings {
    return this.store.get<Settings>('settings', 'global') || { id: 'global', updatedAt: '' };
  }
  ensureSettings(): Settings {
    const current = this.store.get<Settings>('settings', 'global');
    return current || this.store.put('settings', { id: 'global', updatedAt: now() } satisfies Settings);
  }
  saveSettings(patch: { usageReserve?: UsageReserve | null; stopWhenUsageUnknown?: boolean }): Settings {
    const current = this.ensureSettings();
    const next: Settings = { ...current, updatedAt: now() };
    if (patch.usageReserve === null) delete next.usageReserve;
    else if (patch.usageReserve) next.usageReserve = patch.usageReserve;
    if (patch.stopWhenUsageUnknown !== undefined) next.stopWhenUsageUnknown = patch.stopWhenUsageUnknown;
    return this.store.put('settings', next);
  }
  /** Automatic reads only happen while some limit or enabled channel can use them. */
  configured(): boolean {
    return (
      !!this.settings().usageReserve ||
      this.store.all<Project>('projects').some((project) => !!project.usageBudget) ||
      this.store.all<any>('controls').some((control) => control.enabled)
    );
  }
  latest(): UsageSample | undefined {
    const row = this.store.db
      .prepare("SELECT data FROM usage_samples ORDER BY json_extract(data,'$.at') DESC, rowid DESC LIMIT 1")
      .get() as any;
    return row ? JSON.parse(row.data) : undefined;
  }
  /** Old readings and readings whose window has reset since no longer describe the account. */
  isStale(sample: UsageReading): boolean {
    const age = Date.now() - Date.parse(sample.at);
    if (!(age >= 0 && age < usageFreshnessMs)) return true;
    return sample.windows.some((window) => !!window.resetsAt && Date.parse(window.resetsAt) <= Date.now());
  }
  fresh(): UsageSample | undefined {
    const sample = this.latest();
    return sample && !this.isStale(sample) ? sample : undefined;
  }
  status(): UsageStatus {
    const sample = this.latest();
    const error = this.lastError ? this.redact(this.lastError).slice(0, 200) : '';
    return {
      ...(sample ? { reading: stripScope(sample) } : {}),
      stale: sample ? this.isStale(sample) : true,
      attempted: this.lastAttemptAt > 0,
      ...(error ? { lastError: error } : {}),
    };
  }
  record(
    reading: UsageReading,
    phase: UsageSample['phase'],
    scope: { projectId?: string; channelId?: string; runId?: string } = {}
  ): UsageSample {
    const sample: UsageSample = { id: randomUUID(), ...reading, phase, ...scope };
    this.store.transaction(() => {
      this.store.put('usage_samples', sample);
      const count = Number((this.store.db.prepare('SELECT COUNT(*) AS n FROM usage_samples').get() as any).n);
      if (count > usageSampleLimit)
        this.store.db
          .prepare(
            'DELETE FROM usage_samples WHERE rowid NOT IN (SELECT rowid FROM usage_samples ORDER BY rowid DESC LIMIT ?)'
          )
          .run(usageSampleLimit);
    });
    return sample;
  }
  /** One transport read shared by every concurrent caller; failures are remembered, never thrown. */
  read(): Promise<UsageReading | undefined> {
    if (this.reading) return this.reading;
    this.lastAttemptAt = Date.now();
    const transport = this.transport;
    if (!transport?.readUsage) {
      this.lastError = '原生后台不支持读取额度';
      return Promise.resolve(undefined);
    }
    this.reading = (async () => {
      try {
        const reading = await transport.readUsage!();
        if (!reading) {
          this.lastError = '原生后台没有返回额度读数';
          return undefined;
        }
        this.lastError = '';
        return reading;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : '额度读取失败';
        return undefined;
      } finally {
        this.reading = null;
      }
    })();
    return this.reading;
  }
  /** Reads now and records a `poll` sample; deduplicated with any read already in flight. */
  async refresh(): Promise<UsageReading | undefined> {
    const reading = await this.read();
    if (reading && !this.closed) this.record(reading, 'poll');
    return reading;
  }
  /** Kicks a background refresh unless one is running or the last attempt failed moments ago. */
  refreshInBackground() {
    if (this.reading) return;
    if (this.lastError && Date.now() - this.lastAttemptAt < usageRetryBackoffMs) return;
    void this.refresh();
  }
  async sample(
    phase: 'before' | 'after',
    scope: { projectId: string; channelId: string; runId: string }
  ): Promise<UsageReading | undefined> {
    const reading = await this.read();
    if (!reading || this.closed) return undefined;
    this.record(reading, phase, scope);
    return reading;
  }
  /** Usage this project's runs consumed inside the window: an estimate, since the user's own Codex work shares the account. */
  projectUsage(projectId: string, window: UsageWindow, reading?: UsageReading): ProjectUsage {
    const current = reading?.windows.find((w) => w.name === window);
    const length = (current?.windowMinutes || usageWindowMinutes[window]) * 60_000;
    const windowStart = new Date(
      current?.resetsAt && future(current.resetsAt) ? Date.parse(current.resetsAt) - length : Date.now() - length
    ).toISOString();
    const rows = this.store.db
      .prepare(
        "SELECT data FROM runs WHERE json_extract(data,'$.projectId')=? AND json_extract(data,'$.usage.delta') IS NOT NULL"
      )
      .all(projectId)
      .map((row: any) => JSON.parse(row.data) as Run)
      .filter((run) => (run.finishedAt || run.startedAt) >= windowStart);
    const usedPercent = rows.reduce((sum, run) => sum + Math.max(0, run.usage?.delta?.[window] || 0), 0);
    return { usedPercent: Math.round(usedPercent * 10) / 10, runs: rows.length, windowStart };
  }
  budgetContext(project: Project, channel: Channel): BudgetContext {
    const settings = this.settings();
    const status = this.status();
    return {
      runsToday: this.store.runCount(channel.id, now().slice(0, 10)),
      maxRunsPerDay: channel.maxRunsPerDay,
      usage: {
        ...(status.reading ? { reading: status.reading, stale: status.stale } : {}),
        unknown: !status.reading,
        ...(settings.usageReserve ? { reserve: settings.usageReserve } : {}),
        ...(project.usageBudget
          ? {
              project: {
                window: project.usageBudget.window,
                limitPercent: project.usageBudget.limitPercent,
                usedPercent: this.projectUsage(project.id, project.usageBudget.window, status.reading).usedPercent,
              },
            }
          : {}),
      },
    };
  }
  /**
   * Synchronous decision for a new automatic turn or review. Nothing is read unless a reserve or this
   * project's budget applies; the reserve (exact account reading) is checked before the budget (estimate).
   */
  gate(project: Project): UsageGate {
    const settings = this.settings();
    const reserve = settings.usageReserve;
    const budget = project.usageBudget;
    if (!reserve && !budget) return { blocked: false };
    const latest = this.latest();
    const fresh = latest && !this.isStale(latest) ? latest : undefined;
    if (!fresh) this.refreshInBackground();
    // A stale reading still decides, except for a window whose reset already passed: that value is gone.
    const windowReading = (window: UsageWindow): UsageWindowReading | undefined => {
      const current = latest?.windows.find((w) => w.name === window);
      return current && !(current.resetsAt && Date.parse(current.resetsAt) <= Date.now()) ? current : undefined;
    };
    const until = (resetsAt?: string) => (future(resetsAt) ? resetsAt! : nextUtcDay());
    let unknown = false;
    if (reserve) {
      const current = windowReading(reserve.window);
      if (!current) unknown = true;
      else if (current.usedPercent >= 100 - reserve.keepPercent) {
        const at = until(current.resetsAt);
        return {
          blocked: true,
          kind: 'reserve',
          window: reserve.window,
          ...(current.resetsAt ? { resetsAt: current.resetsAt } : {}),
          until: at,
          message: `账户${usageWindowLabels[reserve.window]}额度已用 ${percent(current.usedPercent)}%，达到保留线（保留 ${reserve.keepPercent}%），等待 ${clock(at)} 重置`,
        };
      }
    }
    if (budget) {
      const usage = this.projectUsage(project.id, budget.window, latest ? stripScope(latest) : undefined);
      if (usage.usedPercent >= budget.limitPercent) {
        const current = windowReading(budget.window);
        const at = until(current?.resetsAt);
        return {
          blocked: true,
          kind: 'budget',
          window: budget.window,
          ...(current?.resetsAt ? { resetsAt: current.resetsAt } : {}),
          until: at,
          message: `本项目归因的${usageWindowLabels[budget.window]}额度估算已达上限 ${budget.limitPercent}%（已用 ${percent(usage.usedPercent)}%，估算），等待 ${clock(at)} 重置`,
        };
      }
    }
    if (!unknown) return { blocked: false };
    const failedRecently = !!this.lastError && Date.now() - this.lastAttemptAt < usageFreshnessMs;
    if (this.reading && !failedRecently)
      return {
        blocked: true,
        kind: 'unknown',
        pending: true,
        until: new Date(Date.now() + 5000).toISOString(),
        message: '正在读取额度',
      };
    if (settings.stopWhenUsageUnknown !== true) return { blocked: false };
    const at = new Date(Date.now() + usageFreshnessMs).toISOString();
    return {
      blocked: true,
      kind: 'unknown',
      until: at,
      message: `额度读数不可用，已按设置停止自动工作，${clock(at)} 后重试`,
    };
  }
  /** Periodic refresh while limits are configured; one read right away once the transport is reachable. */
  start() {
    if (this.timer || this.closed) return;
    void (async () => {
      try {
        await this.transport?.connect();
      } catch {
        /* The first periodic read reports the connection state instead. */
      }
      if (!this.closed && this.configured()) await this.refresh();
    })();
    this.timer = setInterval(() => {
      if (!this.closed && this.configured()) void this.refresh();
    }, usageFreshnessMs);
    this.timer.unref();
  }
  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
