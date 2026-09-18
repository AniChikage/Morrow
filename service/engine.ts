import {
  autonomousCharter,
  autonomousCharterReview,
  autonomousTurnNote,
  charterHash,
  charterResendReason,
  parseWorkDecision,
  projectBriefBlock,
  treeLine,
} from './channel-work.ts';
import { cliTurnText } from './prompts/cli-turn.ts';
import { ProjectWorkLoop } from './project-loop.ts';
import type { Scope } from './project-loop.ts';
import { UpgradeManager } from './upgrade.ts';
import { AppResumeTracker } from './app-resume.ts';
import type { UpgradeBlocker } from './upgrade.ts';
import type { BuildIdentity } from './build-identity.ts';
import { UsageMonitor, nextUtcDay, usageDelta } from './usage.ts';
import type { UsageGate } from './usage.ts';
import { spawn, execFileSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { APIError, resultSchema, usesApp } from './protocol.ts';
import type { AgentResult, Channel, Control, Event, Project, Run, Runtime, WorkItem } from './protocol.ts';
import type { Verification } from './verification-types.ts';
import { sanitizeEventDetail } from './event-details.ts';
import type { EventDetail } from './protocol.ts';
import { Store, now } from './store.ts';
import { logError } from './log.ts';
import { cliTurnMinutes, decodeLine, diagnoseFailure, invocation, runtimeTitles } from './runtimes.ts';
import { workMcpLaunch } from './agent-mcp.ts';
import { projectTreeState, sourceVersion } from './source-version.ts';
import type { Evidence } from './autonomy-types.ts';
import { pinHelpers } from './runtime-helpers.ts';
import { extractReport } from './reports.ts';
/** A Morrow-orchestrated turn, as opposed to native chat or a turn the App itself started. */
const scheduledRun = (row: Run) => !row.source || ['morrow-schedule', 'nohuman-schedule'].includes(row.source);
/** What a report's verified/resolved claim says while the independent review it needs has not passed. */
const reviewWaitPrefix = '等待当前版本的独立复核；';
/** How a claimed status reads in the work log and in the evidence a reviewer receives. */
const claimedStatusText: Record<string, string> = { verified: '已验证', resolved: '已解决' };
/**
 * What a report's verified/resolved claim still needs once the item has no passed review of the
 * current source: `prefix` goes in front of `nextStep`, `queue` says the service must request the
 * review itself, and `note` is one work-log line when the claim cannot be reviewed as reported.
 */
type ReviewPlan = { prefix: string; queue: boolean; note?: string };
type Active = {
  child: ChildProcessWithoutNullStreams;
  channelId: string;
  projectPath: string;
  runId: string;
  interrupted: string;
  timer: NodeJS.Timeout;
  done: Promise<void>;
  killTimer?: NodeJS.Timeout;
};
export class Engine {
  native?: {
    readonly backgroundReady?: boolean;
    create?(id: string): Promise<unknown>;
    binding(id: string): { threadId: string } | undefined;
    isBusy(id: string): boolean;
    isProjectBusy(projectId: string, exceptId?: string): boolean;
    startScheduled(id: string, scheduled: boolean): Promise<void>;
    pause(id: string): Promise<void>;
  };
  store: Store;
  home: string;
  runtimes: Runtime[] = [];
  active = new Map<string, Active>();
  timer: NodeJS.Timeout | undefined;
  closed = false;
  token: string;
  loop: ProjectWorkLoop;
  /** Account usage readings and the reserve/budget gate; the transport is attached by the server. */
  usage: UsageMonitor;
  /** The automatic version switch: one persisted request per installed build, and its phase. */
  upgrade: UpgradeManager;
  /** Durable user intent, and the bounded recovery after the App continues an interrupted turn (#32). */
  appResume: AppResumeTracker;
  /** Before-samples still in flight per run, so the after-sample can wait for its counterpart. */
  usageBefore = new Map<string, Promise<void>>();
  /** The working-tree wait each channel has already announced, so a repeated tick repeats no event. */
  treeWaits = new Map<string, string>();
  /** The pending version switch each channel has already announced, for the same reason. */
  upgradeWaits = new Map<string, string>();
  constructor(store: Store, home: string, token: string, identity?: BuildIdentity) {
    this.store = store;
    this.home = home;
    this.token = token;
    this.loop = new ProjectWorkLoop(store, home);
    this.usage = new UsageMonitor(store);
    this.upgrade = new UpgradeManager(store, home, identity);
    this.appResume = new AppResumeTracker(store, this);
    this.upgrade.blockersOf = () => this.workBlockers();
    this.usage.redact = (value) => this.redact(value);
    this.loop.redact = (value) => this.redact(value);
    this.loop.usage = this.usage;
    this.loop.upgrade = this.upgrade;
    // Pinned before anything can start a turn, so an install that replaces this bundle while the
    // daemon keeps working cannot change the helper the daemon spawns.
    this.loop.helpers = pinHelpers(home, this.upgrade.identity.fingerprint);
  }
  /**
   * Real work in progress right now, read from the engine, the native connection and the loop rather
   * than from `channels.status`: an active CLI run, a native turn starting/scheduled/active, a send
   * still waiting for the native task, a queued or running review, and a publication in flight.
   * Empty means idle. Nothing here is ever interrupted; it is only reported.
   */
  workBlockers(): UpgradeBlocker[] {
    const name = (channelId: string) => this.store.get<Channel>('channels', channelId)?.name || '已移除的频道';
    const blockers: UpgradeBlocker[] = [];
    for (const active of this.active.values())
      blockers.push({ kind: 'run', label: `频道「${name(active.channelId)}」正在执行` });
    for (const channel of this.store.all<Channel>('channels'))
      if (this.native?.isBusy(channel.id))
        blockers.push({ kind: 'native', label: `频道「${channel.name}」原生轮次进行中` });
    for (const project of this.store.all<Project>('projects'))
      if (!project.isDemo && this.native?.isProjectBusy(project.id))
        blockers.push({ kind: 'native', label: `项目「${project.name}」有正在进行的原生任务轮次` });
    for (const entry of this.store.all<{ id: string; threadId: string; state: string }>('native_outbox'))
      if (entry.state === 'pending') blockers.push({ kind: 'send', label: '有一条原生消息尚未被任务接收' });
    for (const row of this.store.all<Verification>('loop_verifications'))
      if (['queued', 'running'].includes(row.status))
        blockers.push({
          kind: 'review',
          label: row.status === 'running' ? '独立复核正在进行' : '独立复核已排队等待执行',
        });
    for (const release of this.store.all<{ id: string; status: string; title: string }>('loop_releases'))
      if (release.status === 'publishing' || this.loop.inFlight.has(release.id))
        blockers.push({ kind: 'publication', label: `发布「${release.title}」正在执行` });
    return blockers;
  }
  control(id: string): Control {
    return (
      this.store.get('controls', id) || {
        id,
        enabled: false,
        pid: 0,
        runId: '',
      }
    );
  }
  setControl(id: string, fields: Partial<Control>) {
    return this.store.put('controls', {
      ...this.control(id),
      ...fields,
      ...(fields.enabled === false ? { startRetry: undefined } : {}),
    });
  }
  redact(text: string) {
    return text.replaceAll(this.token, '[REDACTED]');
  }
  persistIO(
    runId: string,
    stream: 'prompt' | 'stdout' | 'stderr' | 'final' | 'report',
    text: string,
    file?: string,
    append = false,
    mirror = true
  ) {
    const safe = this.redact(text);
    if (mirror)
      for (let offset = 0; offset < safe.length; offset += 32768)
        this.store.io(runId, stream, safe.slice(offset, offset + 32768));
    if (!file) return;
    try {
      if (append) appendFileSync(file, safe, { mode: 0o600 });
      else writeFileSync(file, safe, { mode: 0o600 });
    } catch {
      const run = this.store.get<Run>('runs', runId);
      if (run) this.event(run.channelId, runId, 'system', '私有文件副本写入失败；本轮输入输出已保存在数据库。');
    }
  }
  event(
    channelId: string,
    runId: string,
    kind: string,
    text: string,
    detail?: EventDetail,
    metadata: Partial<Pick<Event, 'projectId' | 'itemId' | 'actor' | 'action' | 'changes'>> = {}
  ) {
    return this.store.event(
      channelId,
      runId,
      kind,
      this.redact(text).slice(0, 12000),
      sanitizeEventDetail(detail, (value) => this.redact(value)),
      JSON.parse(this.redact(JSON.stringify(metadata)))
    );
  }
  audit(entry: {
    projectId: string;
    channelId?: string;
    runId?: string;
    itemId?: string;
    actor: 'human' | 'agent' | 'system';
    action: string;
    text: string;
    before?: unknown;
    after?: unknown;
  }) {
    return this.event(entry.channelId || '', entry.runId || '', 'system', entry.text, undefined, {
      projectId: entry.projectId,
      itemId: entry.itemId,
      actor: entry.actor,
      action: entry.action,
      ...(entry.before !== undefined || entry.after !== undefined
        ? { changes: { before: entry.before, after: entry.after } }
        : {}),
    });
  }
  recover() {
    // An installed build is reconciled against the build actually running before anything is scheduled.
    this.upgrade.recover();
    this.loop.recover();
    for (const run of this.store
      .all<Run>('runs')
      .filter((r) => r.status === 'running' && r.executionOwner !== 'codex-app')) {
      const control = this.control(run.channelId);
      this.store.ioStream(run.id, 'stdout', '', this.token, true);
      this.store.ioStream(run.id, 'stderr', '', this.token, true);
      // A detached orphan is killed only when its command still identifies this exact run.
      if (control.pid > 0) {
        try {
          const command = execFileSync('/bin/ps', ['-p', String(control.pid), '-o', 'command='], {
            encoding: 'utf8',
            timeout: 1000,
          });
          if (command.includes(run.id)) process.kill(-control.pid, 'SIGKILL');
        } catch {}
      }
      this.store.put('runs', {
        ...run,
        status: 'interrupted',
        reportStatus: run.reportStatus === 'pending' ? 'missing' : run.reportStatus,
        finishedAt: now(),
        summary: '服务重新启动，上次执行已中断。请检查工作区后手动继续。',
      });
      const c = this.store.get<Channel>('channels', run.channelId);
      if (c)
        this.store.put('channels', {
          ...c,
          status: 'paused',
          nextRunAt: '',
        });
      this.setControl(run.channelId, { enabled: false, pid: 0, runId: '' });
      this.event(run.channelId, run.id, 'system', '恢复了中断记录，频道已暂停，避免重复执行。');
    }
    for (const c of this.store.all<Channel>('channels'))
      if (c.status === 'running' && !this.store.get('native_bindings', c.id)) {
        this.store.put('channels', {
          ...c,
          ...(c.work ? { work: { ...c.work, awaitingReply: false } } : {}),
          status: 'paused',
          nextRunAt: '',
        });
        this.setControl(c.id, { enabled: false, pid: 0, runId: '' });
      }
  }
  startScheduler() {
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
  }
  tick() {
    if (this.closed) return;
    this.upgrade.tick();
    this.loop.tick();
    // Only a channel whose control is on can be acted on below, so the tick asks for those instead
    // of reading every channel of every project once a second.
    for (const channel of this.store.enabledChannels()) {
      const control = this.control(channel.id);
      if (
        control.enabled &&
        !this.active.has(channel.id) &&
        !this.native?.isBusy(channel.id) &&
        channel.nextRunAt &&
        channel.nextRunAt <= now()
      )
        try {
          Promise.resolve(this.start(channel.id, true)).catch((e) => this.failScheduled(channel.id, e));
        } catch (e) {
          this.failScheduled(channel.id, e);
        }
    }
  }
  /** Only called after a read-only native preflight failed, before a run/outbox was created. */
  deferNativeStart(id: string, code: string, generation: number) {
    const control = this.control(id);
    const channel = this.store.get<Channel>('channels', id);
    if (!channel || !control.enabled || this.appResume.intent(id).generation !== generation) return;
    const prior = control.startRetry;
    const attempts = Math.min((prior?.generation === generation ? prior.attempts : 0) + 1, 7);
    const seconds = Math.min(5 * 2 ** (attempts - 1), 300);
    this.store.transaction(() => {
      this.setControl(id, { startRetry: { attempts, code, generation } });
      this.store.put('channels', {
        ...channel,
        status: 'waiting',
        nextRunAt: new Date(Date.now() + seconds * 1000).toISOString(),
      });
      if (!prior || prior.code !== code || prior.generation !== generation)
        this.event(id, '', 'system', 'Codex App 连接暂不可用；尚未提交新轮次，将自动重试，恢复后继续原任务。');
    });
  }
  clearNativeStartRetry(id: string) {
    if (!this.control(id).startRetry) return;
    this.setControl(id, { startRetry: undefined });
    this.event(id, '', 'system', 'Codex App 连接已恢复，继续原任务。');
  }
  failScheduled(id: string, error: unknown) {
    const c = this.store.get<Channel>('channels', id);
    if (!c) return;
    this.setControl(id, { enabled: false });
    this.store.put('channels', { ...c, status: 'blocked', nextRunAt: '' });
    this.event(id, '', 'error', error instanceof Error ? error.message : '调度失败');
    // A channel that stops scheduling itself is the failure a person notices hours later; the
    // reason belongs in the daemon's own log too, not only in that channel's timeline.
    logError('schedule.failed', error, { channelId: id, projectId: c.projectId });
  }
  budgetCount(id: string) {
    const day = now().slice(0, 10);
    return this.store.runCount(id, day);
  }
  nextBudget() {
    return nextUtcDay();
  }
  /** Parks a scheduled channel on the usage gate; one system event per distinct wait, none for a pending read. */
  waitForUsage(channel: Channel, gate: Extract<UsageGate, { blocked: true }>) {
    if (gate.pending) {
      this.store.put('channels', { ...channel, status: 'waiting', nextRunAt: gate.until });
      return;
    }
    const previous = channel.usageWait;
    const changed = !previous || previous.kind !== gate.kind || previous.window !== gate.window;
    this.store.put('channels', {
      ...channel,
      status: 'waiting',
      nextRunAt: gate.until,
      usageWait: {
        kind: gate.kind,
        ...(gate.window ? { window: gate.window } : {}),
        ...(gate.resetsAt ? { resetsAt: gate.resetsAt } : {}),
        since: changed ? now() : previous!.since,
      },
    });
    if (changed) this.event(channel.id, '', 'system', `${gate.message}。`);
  }
  /**
   * Reads the account usage as a run starts; the reading lands on the run row when it arrives, never
   * blocking the start. Only a Codex run is measured: the reading is the Codex account's own, so a
   * Claude Code or Trae turn would be attributed usage it did not spend.
   */
  trackUsageBefore(run: Run) {
    if (run.runtime !== 'codex') return;
    const scope = { projectId: run.projectId, channelId: run.channelId, runId: run.id };
    const task = this.usage
      .sample('before', scope)
      .then((before) => {
        if (!before) return;
        const current = this.store.get<Run>('runs', run.id);
        if (!current) return;
        const usage = { ...current.usage, before, attribution: 'estimated' as const };
        // The in-memory row is written again later by the run's owner; keep it carrying the sample.
        run.usage = usage;
        this.store.put('runs', { ...current, usage });
      })
      .catch(() => {})
      .finally(() => this.usageBefore.delete(run.id));
    this.usageBefore.set(run.id, task);
  }
  /**
   * Reads the account usage after a run and stores the per-window difference as this run's estimated
   * share. Skipped for the runtimes that do not spend the Codex account, as `trackUsageBefore` is.
   */
  trackUsageAfter(run: Run) {
    if (run.runtime !== 'codex') return;
    const scope = { projectId: run.projectId, channelId: run.channelId, runId: run.id };
    void (async () => {
      await this.usageBefore.get(run.id);
      const after = await this.usage.sample('after', scope);
      if (!after) return;
      const current = this.store.get<Run>('runs', run.id);
      if (!current) return;
      const before = current.usage?.before;
      const usage = {
        ...current.usage,
        after,
        ...(before ? { delta: usageDelta(before, after) } : {}),
        attribution: 'estimated' as const,
      };
      run.usage = usage;
      this.store.put('runs', { ...current, usage });
    })().catch(() => {});
  }
  activations = new Map<string, Promise<void>>();
  activationVersions = new Map<string, number>();
  async action(id: string, action: string) {
    if (action === 'pause') this.activationVersions.set(id, (this.activationVersions.get(id) || 0) + 1);
    if (action !== 'resume') return this.performAction(id, action);
    if (this.activations.has(id)) return this.activations.get(id)!;
    const operation = this.performAction(id, action);
    this.activations.set(id, operation);
    try {
      return await operation;
    } finally {
      this.activations.delete(id);
    }
  }
  async performAction(id: string, action: string) {
    const activationVersion = this.activationVersions.get(id) || 0;
    const c = this.store.get<Channel>('channels', id);
    if (!c) throw new APIError(404, '频道不存在');
    // A person asked for this: pausing, running once, or continuing. The durable intent generation
    // advances before anything else happens, so any continuation candidate still under observation
    // is closed even if this action is then refused.
    if (action === 'pause' || action === 'run' || action === 'resume') this.appResume.advance(id, action);
    if (action === 'pause') {
      this.setControl(id, { enabled: false });
      this.loop.verification.cancelChannel(id);
      this.store.put('channels', {
        ...c,
        ...(c.work ? { work: { ...c.work, awaitingReply: false } } : {}),
        status: 'paused',
        nextRunAt: '',
      });
      this.interrupt(id, '用户暂停了执行');
      if (this.native?.binding(id)) await this.native.pause(id);
      this.event(id, '', 'system', '频道已暂停。');
      return;
    }
    const p = this.store.get<Project>('projects', c.projectId);
    if (p?.isDemo) throw new APIError(409, '示例频道仅用于预览，请创建真实项目后运行');
    if (this.active.has(id) || this.native?.isBusy(id)) throw new APIError(409, '该频道正在执行');
    // Only a channel whose turns run inside the App needs a task bound to it. A CLI-direct Codex
    // channel has no App task to create and must not be given one: it starts its own subprocess
    // below, exactly as a Claude Code or Trae channel does. Follower IPC cannot create a task;
    // `create` 409s and the person binds an App-created thread instead.
    if (
      usesApp(c) &&
      !this.native?.binding(id) &&
      (process.env.MORROW_TEST_MODE !== '1' || this.native?.backgroundReady)
    ) {
      if (!this.native?.create) throw new APIError(409, 'Codex 后台连接尚未准备好');
      await this.native.create(id);
    }
    if (action !== 'pause' && (this.activationVersions.get(id) || 0) !== activationVersion) return;
    if (action === 'resume') {
      this.setControl(id, { enabled: true });
      try {
        await this.start(id, true, true);
      } catch (e) {
        // A turn that began between the check above and this call — a scheduling tick is one second
        // wide — is not a reason to undo what the person asked for. 「持续运行」 asked for autonomy,
        // and autonomy is now on with a turn already running, which is the state they wanted. Any
        // other failure really did leave nothing running, so the control goes back off.
        if (this.active.has(id) || this.native?.isBusy(id)) return;
        this.setControl(id, { enabled: false });
        throw e;
      }
    } else await this.start(id, false);
  }
  /**
   * Whether `channel` has to wait behind the review `row`. A running reviewer owns the frozen project
   * source, and so does a queued one that can actually start. The exception is a queued review the
   * account usage gate is holding (`retryAt` still ahead, written by `WorkVerification.start` when
   * the reserve line blocks or its reading is pending): that hold can last until the account's window
   * resets, 额度门禁 reads the Codex account, and a Claude Code or Trae channel never spends it — so
   * such a review must not freeze those channels. The consequence is deliberate: if the source moves
   * while the review waits, `start` finds the material stale and concludes the review unknown, and
   * the next verified claim requests a new one with fresh material. Codex channels are unchanged.
   *
   * This one asks about the account, not about the App, so it stays a `runtime` test: a CLI-direct
   * Codex channel spends the same Codex quota an App one does and is held behind the same line.
   */
  reviewHolds(channel: Channel, row: Omit<Verification, 'prompt'>) {
    if (row.status === 'running') return true;
    if (row.status !== 'queued') return false;
    return channel.runtime === 'codex' || !row.retryAt || row.retryAt <= now();
  }
  /**
   * `scheduled` chooses between parking the channel and refusing; `humanAction` says whether a person
   * asked for this start, because `resume` is scheduled work a human just requested and must hear
   * about a blocking working tree instead of silently waiting.
   */
  start(id: string, scheduled: boolean, humanAction = !scheduled) {
    if (this.closed) throw new APIError(503, '服务正在关闭');
    const channel = this.store.get<Channel>('channels', id)!;
    const project = this.store.get<Project>('projects', channel.projectId)!;
    if (project.isDemo) throw new APIError(409, '示例项目不能执行');
    if (this.active.has(id)) throw new APIError(409, '频道正在执行');
    // A newly installed version is waiting for real idleness. No new turn starts, and nothing already
    // running is interrupted: a scheduled start parks and re-checks, a person hears why.
    const upgrade = this.upgrade.record();
    if (upgrade) {
      if (humanAction) throw new APIError(409, this.upgrade.refusal('切换完成后会自动继续，请稍后再运行'));
      this.store.put('channels', {
        ...channel,
        status: 'waiting',
        nextRunAt: new Date(Date.now() + 5000).toISOString(),
      });
      // One event per channel per switch: the scheduler re-checks this gate on every tick.
      if (this.upgradeWaits.get(id) !== upgrade.id) {
        this.upgradeWaits.set(id, upgrade.id);
        this.event(id, '', 'system', '新版本已安装，本频道等待当前工作结束后随服务切换，再自动继续。');
      }
      return;
    }
    // A queued/running reviewer owns the frozen project source. Existing
    // reassessment signals must not launch another autonomous turn that can
    // invalidate that source or spend a run just to poll the pending review.
    if (this.loop.verification.rows(project.id).some((row) => this.reviewHolds(channel, row))) {
      if (!scheduled) throw new APIError(409, '项目独立复核尚未完成，完成后会继续原任务');
      this.store.put('channels', {
        ...channel,
        status: 'waiting',
        nextRunAt: new Date(Date.now() + 5000).toISOString(),
      });
      return;
    }
    if (
      [...this.active.values()].some((a) => a.projectPath === project.path) ||
      this.native?.isProjectBusy(project.id, id)
    ) {
      if (!scheduled) throw new APIError(409, '同一项目已有频道正在执行，请稍后重试');
      this.store.put('channels', {
        ...channel,
        status: 'waiting',
        nextRunAt: new Date(Date.now() + 5000).toISOString(),
      });
      return;
    }
    // One shared working tree per project: a channel never starts on another channel's uncommitted
    // changes, because it can neither see them nor safely commit or revert them.
    const conflict = this.treeConflict(project, id);
    if (conflict) {
      if (humanAction) throw new APIError(409, conflict.message);
      this.store.put('channels', {
        ...channel,
        status: 'waiting',
        nextRunAt: new Date(Date.now() + channel.intervalMinutes * 60000).toISOString(),
      });
      // One event per distinct wait: the scheduler re-checks this gate on every tick.
      if (this.treeWaits.get(id) !== conflict.key) {
        this.treeWaits.set(id, conflict.key);
        this.event(id, '', 'system', `${conflict.message}。`);
      }
      return;
    }
    this.treeWaits.delete(id);
    if (this.budgetCount(id) >= channel.maxRunsPerDay) {
      if (!scheduled) throw new APIError(429, '已达到每日运行次数上限（UTC 日界），请调整预算或明天继续');
      this.store.put('channels', {
        ...channel,
        status: 'waiting',
        nextRunAt: this.nextBudget(),
      });
      this.event(id, '', 'system', '已达到每日预算，将在下一个 UTC 日恢复。');
      return;
    }
    // Usage gate: the account reserve line (exact) and this project's attributed budget (estimate).
    // Both read the Codex account, so they say nothing about a Claude Code or Trae turn and are not
    // applied to one; the per-day run budget above still bounds every runtime. The test is the
    // runtime, not the transport: a CLI-direct Codex turn is billed to the same account.
    const gate = channel.runtime === 'codex' ? this.usage.gate(project) : ({ blocked: false } as const);
    if (gate.blocked) {
      if (!scheduled)
        throw gate.pending ? new APIError(409, '额度读数尚未就绪，几秒后重试') : new APIError(429, gate.message);
      this.waitForUsage(channel, gate);
      return;
    }
    try {
      if (!statSync(project.path).isDirectory()) throw new Error();
    } catch {
      throw new APIError(400, '项目目录不存在或不可访问');
    }
    // Where a turn runs is the channel's own choice, not a property of its runtime: `app` (the
    // default for Codex) hands it to the bound App task, `cli` runs the bounded subprocess below.
    // The fixture exception is unchanged: under MORROW_TEST_MODE an App-transport channel with no
    // binding still falls through to the fixture CLI runtime, which is how the service tests drive
    // a Codex channel with no desktop App present.
    if (usesApp(channel) && (process.env.MORROW_TEST_MODE !== '1' || this.native?.binding(id))) {
      if (!this.native) throw new APIError(409, '请连接并绑定 Codex App 中的原生任务');
      return this.native.startScheduled(id, scheduled);
    }
    // The bounded CLI subprocess below is how Claude Code and Trae channels work, and how a Codex
    // channel whose transport is `cli` works: one `codex exec` turn per run, with no App task and no
    // App-managed approvals. The work interface is the host Morrow MCP wrapping this run's grant.
    const runtime = this.runtimes.find((r) => r.id === channel.runtime);
    if (!runtime?.available)
      throw new APIError(409, `${runtimeTitles[channel.runtime]} CLI 不可用，请在运行环境页刷新并检查安装`);
    const run: Run = {
      id: randomUUID(),
      projectId: project.id,
      channelId: id,
      runtime: channel.runtime,
      model: channel.model,
      permission: channel.permission,
      trigger: scheduled ? 'schedule' : 'manual',
      resumedFromSessionId: channel.sessionId,
      reportStatus: 'pending',
      reportError: '',
      status: 'running',
      startedAt: now(),
      finishedAt: '',
      summary: '',
      sessionId: channel.sessionId,
    };
    const runDir = join(this.home, 'runs', run.id);
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const outputPath = join(runDir, 'last-message.json');
    this.store.put('runs', run);
    const prompt = this.prompt(project, channel, run);
    if (Buffer.byteLength(prompt) > 1024 * 1024)
      throw new APIError(400, '项目看板与备注上下文超过 1 MiB，无法安全启动本轮；请整理过长的事项内容后重试');
    this.trackUsageBefore(run);
    this.persistIO(run.id, 'prompt', prompt, join(runDir, 'prompt.txt'));
    const itemRevisions = new Map(this.store.projectItems(project.id).map((item) => [item.id, item.revision]));
    this.store.put('channels', {
      ...channel,
      // The question this turn was asked to answer is no longer waiting: whatever a person left is
      // already in the prompt above, as a new note beside the previous turn's summary. The decision
      // itself is kept, so the page can still say what the last turn asked and that it was answered.
      ...(channel.work ? { work: { ...channel.work, awaitingReply: false } } : {}),
      status: 'running',
      lastRunAt: run.startedAt,
      nextRunAt: '',
      usageWait: undefined,
      pendingWake: undefined,
    });
    this.event(
      id,
      run.id,
      'system',
      `${runtime.name} 开始执行 · ${channel.permission === 'read-only' ? '只读分析' : channel.permission === 'native' ? '完整访问' : '工作区编辑'} · ${channel.sessionId ? '恢复原生会话' : '完整上下文启动'}。`
    );
    const launcher = join(runDir, 'tool.sh');
    const child = spawn(
      runtime.path,
      invocation(
        channel,
        run.id,
        outputPath,
        existsSync(launcher) ? workMcpLaunch(process.execPath, this.loop.helpers['agent-mcp.ts'], launcher) : undefined
      ),
      {
        cwd: project.path,
        env: { ...process.env, NO_COLOR: '1' },
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((r) => (resolveDone = r));
    const limit = cliTurnMinutes * 60000;
    const timeout = process.env.MORROW_TEST_MODE === '1' ? Number(process.env.MORROW_TEST_TIMEOUT_MS || limit) : limit;
    const active: Active = {
      child,
      channelId: id,
      projectPath: project.path,
      runId: run.id,
      interrupted: '',
      timer: setTimeout(() => this.interrupt(id, `执行超时（${cliTurnMinutes} 分钟），频道已暂停`), timeout),
      done,
    };
    this.active.set(id, active);
    this.setControl(id, { pid: child.pid || 0, runId: run.id });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let pending = '';
    let stderrPending = '';
    let finalText = '';
    let finalValue: unknown;
    let totalBytes = 0;
    let terminalOutcome: 'completed' | 'failed' | undefined;
    let spawnError = '';
    let failureDiagnosis: { priority: number; summary: string } | undefined;
    const diagnose = (text: string) => {
      const candidate = diagnoseFailure(channel.runtime, text);
      if (candidate && (!failureDiagnosis || candidate.priority > failureDiagnosis.priority))
        failureDiagnosis = candidate;
    };
    const toolNames = new Map<string, string>();
    const line = (text: string, newline = true) => {
      this.persistIO(run.id, 'stdout', text + (newline ? '\n' : ''), join(runDir, 'stdout.jsonl'), true, false);
      if (!text.trim()) return;
      const decoded = decodeLine(text);
      // Progress chatter reaches the raw log and stops there: no event, no failure diagnosis, no
      // session id. Diagnosis especially — `quotaFailure` matches the words inside the ordinary
      // `rate_limit_event` Claude Code emits on every turn, so reading those would report every
      // failed Claude turn as a spent account and hide the real cause. Nothing is lost: every line
      // that carries state (`system/init`, a refused rate limit, results) is not skipped.
      if (decoded.skip) return;
      // A failure diagnosis reads what the runtime says about this turn, never what the workspace
      // contains. A tool line carries the project's own bytes — a command's output, a file's
      // contents, a grep hit — and `quotaFailure` matches ordinary text like `429 tests passed` or
      // a source line that merely names the patterns, so reading one would outrank the real reason
      // and report the turn as a spent account. Results, system lines, a refused rate limit and
      // stderr still reach the diagnosis: that is where a real account failure is stated.
      const carriesWorkspaceContent =
        decoded.kind === 'tool' ||
        [decoded.detail, ...(decoded.additionalDetails || [])].some(
          (detail) => detail?.type === 'tool_use' || detail?.type === 'tool_result'
        );
      // Text the model wrote is no better a witness: the name it gave a background task is tool
      // input in all but shape, and the answer of a turn that did not fail is not a failure report
      // at all — turns in this project discuss quota, rate limits and test counts routinely. `kind`
      // is `result` only where `is_error` was false; a failed result decodes to `error` and keeps
      // its diagnosis, which is where a real account failure is stated.
      const modelAuthored = decoded.kind === 'result' || !!decoded.backgroundTask;
      if (!carriesWorkspaceContent && !modelAuthored) diagnose(text);
      if (decoded.sessionId && /^[a-zA-Z0-9_-]{1,200}$/.test(decoded.sessionId)) {
        run.sessionId = decoded.sessionId;
        this.store.put('runs', run);
        const c = this.store.get<Channel>('channels', id)!;
        this.store.put('channels', { ...c, sessionId: decoded.sessionId });
      }
      if (decoded.final !== undefined) finalValue = decoded.final;
      if (decoded.finalText !== undefined) finalText = decoded.finalText;
      if (decoded.terminalOutcome) terminalOutcome = decoded.terminalOutcome;
      const addEvent = (detail?: EventDetail, extra = false) => {
        if (detail?.toolCallId) {
          if (typeof detail.tool === 'string') toolNames.set(detail.toolCallId, detail.tool);
          else if (toolNames.has(detail.toolCallId)) detail = { ...detail, tool: toolNames.get(detail.toolCallId) };
        }
        this.event(id, run.id, extra ? 'tool' : decoded.kind, decoded.text, detail);
      };
      addEvent(decoded.detail);
      for (const detail of decoded.additionalDetails || []) addEvent(detail, true);
    };
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      totalBytes += Buffer.byteLength(chunk);
      if (totalBytes > 20 * 1024 * 1024) {
        this.interrupt(id, '输出超过 20 MB 限制，执行已暂停');
        return;
      }
      this.store.ioStream(run.id, 'stdout', text, this.token);
      pending += text;
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        line(pending.slice(0, index));
        pending = pending.slice(index + 1);
      }
      if (pending.length > 1024 * 1024) this.interrupt(id, '单条运行日志过大，执行已暂停');
    });
    const stderrLine = (text: string, newline = true) => {
      diagnose(text);
      this.persistIO(run.id, 'stderr', text + (newline ? '\n' : ''), join(runDir, 'stderr.log'), true, false);
      if (text.trim()) this.event(id, run.id, 'system', text);
    };
    child.stderr.on('data', (chunk) => {
      totalBytes += Buffer.byteLength(chunk);
      if (totalBytes > 20 * 1024 * 1024) {
        this.interrupt(id, '输出超过限制，执行已暂停');
        return;
      }
      this.store.ioStream(run.id, 'stderr', chunk, this.token);
      stderrPending += chunk;
      let index;
      while ((index = stderrPending.indexOf('\n')) >= 0) {
        stderrLine(stderrPending.slice(0, index));
        stderrPending = stderrPending.slice(index + 1);
      }
      if (stderrPending.length > 1024 * 1024) this.interrupt(id, '单条错误日志过大，执行已暂停');
    });
    child.on('error', (e) => {
      spawnError = e.message;
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    child.on('close', async (code, signal) => {
      clearTimeout(active.timer);
      this.store.ioStream(run.id, 'stdout', '', this.token, true);
      this.store.ioStream(run.id, 'stderr', '', this.token, true);
      if (pending) line(pending, false);
      if (stderrPending) stderrLine(stderrPending, false);
      // A CLI parent may exit while a detached-stdio tool ignores SIGTERM.
      // Keep the project lock until its process group has been stopped.
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
        for (let attempt = 0; attempt < 50; attempt++) {
          try {
            process.kill(-child.pid, 0);
          } catch {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      if (active.killTimer) clearTimeout(active.killTimer);
      try {
        if (code !== null) run.exitCode = code;
        if (signal) run.signal = signal;
        let finalOutput = finalText;
        try {
          if (statSync(outputPath).size <= 1024 * 1024) finalOutput = readFileSync(outputPath, 'utf8') || finalOutput;
        } catch {}
        if (!finalOutput && finalValue !== undefined) finalOutput = JSON.stringify(finalValue);
        this.persistIO(run.id, 'final', finalOutput);
        if (active.interrupted) this.finishFailure(run, 'interrupted', active.interrupted);
        else if (spawnError || code !== 0 || terminalOutcome === 'failed')
          this.finishFailure(
            run,
            'failed',
            failureDiagnosis?.summary ||
              (spawnError
                ? `CLI 启动失败：${spawnError}`
                : `CLI 执行失败（退出码 ${code ?? signal ?? 'unknown'}），请检查运行日志、登录和配额。`)
          );
        else {
          const report = extractReport(finalValue, finalOutput, run.executionOwner);
          run.reportStatus = report.status;
          run.reportError = report.error;
          if (report.result) {
            try {
              this.finishSuccess(run, channel, report.result, runDir, itemRevisions, finalOutput);
            } catch (error) {
              run.reportStatus = 'invalid';
              run.reportError = `看板报告未同步：${error instanceof Error ? error.message : '数据无效'}`;
              this.finishWithoutReport(run, finalOutput);
            }
          } else this.finishWithoutReport(run, finalOutput);
        }
      } finally {
        this.active.delete(id);
        this.setControl(id, { pid: 0, runId: '' });
        resolveDone();
      }
    });
  }
  /**
   * The last scheduled turn on this channel, ignoring native chat, App-owned turns and `exceptId`.
   * Selected in SQL: chat turns on the same channel must not push it out of reach and make the next
   * turn look like a first turn.
   */
  previousScheduledRun(channelId: string, exceptId?: string) {
    return this.store.latestScheduledRun({ channelId, exceptId });
  }
  /**
   * Records the project's shared working tree as this turn leaves it, so the next turn of another
   * channel does not start on top of uncommitted changes it cannot see. Read-only (`git status`) and
   * never throwing: an unreadable tree is recorded as `unknown` and blocks nobody. The row is
   * mutated in place, so the caller's own write carries it.
   */
  recordTreeState(run: Run) {
    if (!scheduledRun(run)) return run;
    const project = this.store.get<Project>('projects', run.projectId);
    run.treeState = project?.path ? projectTreeState(project.path) : { dirty: false, files: [], unknown: true };
    return run;
  }
  /**
   * Why this channel must not start now: the shared working tree is dirty and the project's most
   * recent finalized scheduled turn belongs to another channel that left it dirty. The same channel
   * may continue on its own changes, and a tree only a human touched (no scheduled turn recorded it
   * dirty) never blocks anyone. That turn is read straight from storage, so no amount of native chat
   * recorded after it can quietly turn the guard off.
   */
  treeConflict(project: Project, channelId: string) {
    const tree = projectTreeState(project.path);
    if (!tree.dirty) return undefined;
    const last = this.store.latestScheduledRun({ projectId: project.id, withTreeState: true });
    if (!last || last.channelId === channelId || !last.treeState!.dirty) return undefined;
    const name = this.store.get<Channel>('channels', last.channelId)?.name || '已移除的频道';
    return {
      key: `${last.channelId}:${tree.files.length}`,
      message: `工作树有频道「${name}」未提交的改动（${tree.files.length} 个文件），等待其提交或清理后再开始`,
    };
  }
  /**
   * Records what this turn delivered so the next one can send only a note. Delivery is recorded at
   * prompt time; a turn the native task never accepted clears it again in `finishFailure`, and a turn
   * that ended without a work decision resends the charter through `charterResendReason`.
   */
  recordCharter(channel: Channel, stored: Channel, delivery: { threadId: string; hash: string; resent: boolean }) {
    const previous = stored.promptCharter;
    const promptCharter = {
      threadId: delivery.threadId,
      hash: delivery.hash,
      sentAt: delivery.resent || !previous ? now() : previous.sentAt,
      turnsSince: delivery.resent ? 1 : (previous?.turnsSince || 0) + 1,
    };
    // The native scheduler writes this same channel row again from the object it passed in.
    channel.promptCharter = promptCharter;
    this.store.put('channels', { ...stored, promptCharter });
  }
  prompt(project: Project, channel: Channel, run?: Run) {
    const items = this.store.projectItems(project.id);
    // The App charter is for a turn that really runs inside the bound task. A CLI-direct channel
    // gets the bounded-CLI prompt below even if an App task were somehow still bound to it.
    const binding = this.native?.binding(channel.id);
    if (usesApp(channel) && binding) {
      // `prepare` mints this run's own grant, so its entry line goes out with every turn.
      const tools = run ? this.loop.prepare(run) : '';
      const stored = this.store.get<Channel>('channels', channel.id) || channel;
      const previousRun = this.previousScheduledRun(channel.id, run?.id);
      // What is uncommitted in the shared tree right now, and whether this channel's own last turn
      // left it that way; the charter carries the rule, this line carries the current state.
      const tree = projectTreeState(project.path);
      const context = {
        project,
        channel,
        items,
        previous: stored.work,
        budget: this.usage.budgetContext(project, channel),
        tools,
        channelNames: this.loop.channelNames(project.id),
        // Without the work grant the optional board report is the only way a turn can reach the board.
        ...(tools ? {} : { reportSchema: resultSchema }),
        ...(previousRun ? { lastRunId: previousRun.id } : {}),
        ...(tree.dirty ? { tree: { files: tree.files, own: !!previousRun?.treeState?.dirty } } : {}),
      };
      const charter = autonomousCharter(context);
      const hash = charterHash(charter);
      const resendReason = charterResendReason({
        record: stored.promptCharter,
        threadId: binding.threadId,
        hash,
        previousRun,
        work: stored.work,
      });
      const resent = !!resendReason;
      const reviewOnly = ['charter-stale', 'previous-turn-unfinished', 'no-work-decision'].includes(resendReason);
      if (run) this.recordCharter(channel, stored, { threadId: binding.threadId, hash, resent });
      return (
        (reviewOnly ? autonomousCharterReview(context) : resent ? charter : '') + autonomousTurnNote(context) + tools
      );
    }
    const notes = this.store.messages(channel.id);
    const knowledge = this.store.contextKnowledge(project.id, channel.id);
    const prior = this.store.channelRuns(channel.id).filter((row) => row.id !== run?.id);
    const tools = run ? this.loop.prepare(run) : '';
    // The same working-tree reading the native charter carries: what is uncommitted right now, and
    // whether this channel's own last turn left it that way. An interrupted CLI turn resumes with
    // its files still uncommitted, which the resumed session cannot see on its own.
    const cliTree = projectTreeState(project.path);
    const cliPrevious = this.previousScheduledRun(channel.id, run?.id);
    // Which notes this turn is the first to see: anything left after the previous scheduled turn
    // started. Without a previous turn every note is new, so a first turn answers all of them.
    const since = cliPrevious?.startedAt || '';
    // The brief appears once, as a labelled block; the JSON context carries the rest of the project row.
    const { brief, ...projectContext } = project;
    return cliTurnText({
      goal: project.goal,
      brief: projectBriefBlock(project),
      responsibility: channel.goal,
      permission: channel.permission,
      runtime: channel.runtime,
      minutes: cliTurnMinutes,
      ...(cliTree.dirty ? { tree: treeLine({ files: cliTree.files, own: !!cliPrevious?.treeState?.dirty }) } : {}),
      context: JSON.stringify({
        project: projectContext,
        channel: { name: channel.name, goal: channel.goal },
        items,
        humanNotes: notes.map((n) => ({
          text: n.text,
          createdAt: n.createdAt,
          ...(n.createdAt > since ? { new: true } : {}),
        })),
        knowledge,
        previousRuns: prior.map((r) => ({ summary: r.summary, status: r.status, startedAt: r.startedAt })),
      }),
      intervalMinutes: channel.intervalMinutes,
      ...(tools ? { tools } : { schema: JSON.stringify(resultSchema) }),
    });
  }
  completeAutonomousWork(run: Run, text: string, wasEnabled: boolean) {
    const decision = parseWorkDecision(text);
    try {
      const channel = this.store.get<Channel>('channels', run.channelId)!;
      if (!decision) {
        if (channel.work) this.store.put('channels', { ...channel, work: undefined });
        return;
      }
      if (run.workDirection !== undefined && run.workDirection !== channel.goal) {
        if (wasEnabled && this.control(channel.id).enabled)
          this.store.put('channels', {
            ...channel,
            status: 'waiting',
            nextRunAt: new Date(Date.now() + 30_000).toISOString(),
          });
        this.audit({
          projectId: channel.projectId,
          channelId: channel.id,
          runId: run.id,
          actor: 'system',
          action: 'channel.plan-outdated',
          text: '工作方向已更新，旧安排仅保留在历史中。',
        });
        return;
      }
      const registeredWait = this.store.get<any>('loop_waits', channel.id);
      const needsInput =
        registeredWait?.runId !== run.id && (decision.state === 'needs_input' || channel.status === 'blocked');
      const work = {
        ...decision,
        state: needsInput ? ('needs_input' as const) : decision.state,
        runId: run.id,
        updatedAt: now(),
        awaitingReply: wasEnabled && needsInput,
      };
      this.store.transaction(() => {
        if (work.awaitingReply) this.setControl(channel.id, { enabled: false });
        const enabled = this.control(channel.id).enabled;
        this.store.put('channels', {
          ...channel,
          work,
          status: work.awaitingReply ? 'blocked' : enabled ? 'waiting' : 'paused',
          nextRunAt: enabled
            ? new Date(
                Date.now() +
                  (decision.state === 'continue' ? 30_000 : (decision.waitMinutes || channel.intervalMinutes) * 60_000)
              ).toISOString()
            : '',
        });
        this.audit({
          projectId: channel.projectId,
          channelId: channel.id,
          runId: run.id,
          actor: 'agent',
          action: 'channel.next-step',
          text: work.nextStep,
          after: work,
        });
      });
    } finally {
      this.loop.finish(run);
      this.loop.strategy.finish(run);
      // Registered waits also choose nextRunAt in finish(). Consume the signal last so they
      // cannot overwrite feedback that arrived before this turn's final work decision.
      const channel = this.store.get<Channel>('channels', run.channelId);
      if (channel?.pendingWake) {
        const resume =
          (decision?.state === 'wait' || decision?.state === 'continue') &&
          (run.workDirection === undefined || run.workDirection === channel.goal) &&
          wasEnabled &&
          this.control(channel.id).enabled &&
          channel.status === 'waiting' &&
          channel.work &&
          !channel.work.awaitingReply;
        const nextStep = `收到变化：${channel.pendingWake.reason}；${channel.work?.nextStep || ''}`;
        this.store.put('channels', {
          ...channel,
          pendingWake: undefined,
          ...(resume
            ? {
                nextRunAt: new Date(Date.now() + 5000).toISOString(),
                work: { ...channel.work!, nextStep },
              }
            : {}),
        });
        if (resume)
          this.audit({
            projectId: channel.projectId,
            channelId: channel.id,
            runId: run.id,
            actor: 'system',
            action: 'channel.wake-consumed',
            text: nextStep,
          });
      }
    }
  }
  acceptNativeGuidance(id: string) {
    const channel = this.store.get<Channel>('channels', id);
    if (!channel) return;
    // Guidance is the newer instruction, wherever it arrived from; it closes older App-resume candidates.
    this.appResume.advance(id, 'guidance');
    for (const decision of this.loop.strategy.active(channel.projectId))
      if (decision.channelId === id)
        this.loop.strategy.notify(channel.projectId, '收到用户新指导，先判断是否需要调整当前选择', decision.id);
    if (!channel.work?.awaitingReply && !this.control(id).enabled) return;
    this.store.transaction(() => {
      this.setControl(id, { enabled: true });
      this.store.put('channels', {
        ...channel,
        ...(channel.work ? { work: { ...channel.work, awaitingReply: false } } : {}),
        status: this.native?.isBusy(id) ? channel.status : 'waiting',
        nextRunAt: this.native?.isBusy(id) ? channel.nextRunAt : new Date(Date.now() + 5000).toISOString(),
      });
      this.audit({
        projectId: channel.projectId,
        channelId: id,
        actor: 'system',
        action: 'channel.guided',
        text: '已收到指导；沿用同一对话，在当前工作结束后继续。',
      });
    });
  }
  finishWithoutReport(run: Run, finalOutput: string) {
    this.recordTreeState(run);
    const current = this.store.get<Channel>('channels', run.channelId)!;
    const enabled = this.control(run.channelId).enabled;
    const summary = finalOutput.trim() ? finalOutput.trim().slice(0, 20000) : 'CLI 正常结束，未返回文字总结。';
    this.store.transaction(() => {
      this.store.put('runs', { ...run, status: 'completed', finishedAt: now(), summary });
      this.store.put('channels', {
        ...current,
        status: enabled ? 'waiting' : 'paused',
        nextRunAt: enabled ? new Date(Date.now() + current.intervalMinutes * 60000).toISOString() : '',
      });
      this.audit({
        projectId: run.projectId,
        channelId: run.channelId,
        runId: run.id,
        actor: 'system',
        action: 'run.completed',
        text: `${run.executionOwner === 'codex-app' ? '原生任务轮次' : 'CLI'}正常结束。${run.reportError}`,
      });
    });
    this.trackUsageAfter(run);
  }
  finishSuccess(
    run: Run,
    original: Channel,
    result: AgentResult,
    runDir: string,
    itemRevisions?: Map<string, number>,
    /** The turn's own final answer, kept with the report as the material a reviewer re-checks. */
    finalOutput = ''
  ) {
    this.recordTreeState(run);
    for (const item of result.items)
      if (item.id) {
        const existing = this.store.get<WorkItem>('items', item.id);
        if (!existing || existing.projectId !== original.projectId) throw new Error('返回的事项 ID 不属于当前项目');
      }
    const time = now();
    this.persistIO(run.id, 'report', JSON.stringify(result, null, 2), join(runDir, 'result.json'));
    const conflicts: string[] = [];
    /** Report entries refused because another channel is responsible for the item (事项归属). */
    const refused: string[] = [];
    /** Claims whose own independent review this report has to queue, once the board write is stored. */
    const claims: Array<{ item: WorkItem; reported: AgentResult['items'][number]; status: string }> = [];
    /** Work-log lines about a claim that could not be reviewed now; written with the run's other notes. */
    const notes: string[] = [];
    // This turn as the work interface sees it, so the report follows the same ownership rule as a
    // `feature.upsert` from the same turn instead of a second, looser one.
    const scope = {
      id: 'report',
      projectId: original.projectId,
      channelId: run.channelId,
      runId: run.id,
      expiresAt: time,
    };
    this.store.transaction(() => {
      for (const item of result.items) {
        const old = item.id ? this.store.get<WorkItem>('items', item.id) : undefined;
        // Ownership is read off the row as it stands now, not off the snapshot the turn started
        // from: a reassignment made while the turn ran decides who may write. It is checked before
        // the revision comparison, as in `feature.upsert`, because it is an authorization rule —
        // the entry is not applied at all, and the report keeps its original text in the run record.
        if (old && !this.loop.mayAdvance(run.channelId, old)) {
          refused.push(old.id);
          this.audit({
            projectId: original.projectId,
            channelId: run.channelId,
            runId: run.id,
            itemId: old.id,
            actor: 'system',
            action: 'report.item-refused',
            text: `事项 #${old.number} 由频道「${this.loop.channelName(old.ownerChannelId!)}」负责，报告中的改动未应用。`,
            after: { itemId: old.id, reportedTitle: item.title, ownerChannelId: old.ownerChannelId },
          });
          continue;
        }
        if (old && itemRevisions && old.revision !== itemRevisions.get(old.id)) {
          conflicts.push(old.id);
          this.audit({
            projectId: original.projectId,
            channelId: run.channelId,
            runId: run.id,
            itemId: old.id,
            actor: 'agent',
            action: 'item.conflict',
            text: `「${old.title}」在本轮运行后被更新，保留现有版本；本轮建议留在报告中。`,
            before: old,
            after: item,
          });
          continue;
        }
        const updated: WorkItem = {
          ...old,
          ...item,
          id: old?.id || randomUUID(),
          projectId: original.projectId,
          origin: old?.origin || 'agent',
          number: old?.number || this.store.nextItemNumber(original.projectId),
          channelId: old?.channelId ?? run.channelId,
          sourceChannelIds: [...new Set([...(old?.sourceChannelIds || []), run.channelId])],
          lastRunId: run.id,
          revision: (old?.revision || 0) + 1,
          createdAt: old?.createdAt || time,
          updatedAt: time,
        };
        if (['verified', 'resolved'].includes(updated.status)) {
          const claimed = updated.status;
          this.store.put('items', { ...updated, status: 'investigating' });
          try {
            this.loop.verification.requirePassed(scope, updated.id);
          } catch {
            // No passed review of this source version, so the claim does not stand yet. A reporting
            // turn has no work interface to request one with, so the service decides here what the
            // claim still needs and, in the common case, queues that review itself below.
            const plan = this.reviewPlan(original.projectId, updated, claimed);
            updated.status = 'investigating';
            updated.nextStep = `${plan.prefix}${updated.nextStep}`;
            if (plan.note) notes.push(plan.note);
            if (plan.queue) claims.push({ item: updated, reported: item, status: claimed });
          }
        }
        // The stored status decides responsibility, exactly as in the work interface: writing an item
        // nobody is responsible for claims it, a resolved one is released, and every other status
        // (`blocked` included) keeps the channel it had. Audited by `owner` as `item.claimed` /
        // `item.released` before the write itself, so the item's own history reads in that order.
        const responsible = this.loop.owner(scope, old ?? updated, updated.status);
        if (responsible) updated.ownerChannelId = responsible;
        else delete updated.ownerChannelId;
        this.store.put('items', updated);
        this.audit({
          projectId: original.projectId,
          channelId: run.channelId,
          runId: run.id,
          itemId: updated.id,
          actor: 'agent',
          action: old ? 'item.updated' : 'item.created',
          text: `${old ? '更新' : '创建'}事项 #${updated.number}`,
          before: old,
          after: updated,
        });
      }
      // After every board write, so the evidence row attaches to the item as it now stands and the
      // completion held against the review records the revision actually stored. Still before the
      // run row is closed, because a work-interface scope only exists while this turn is running.
      for (const claim of claims) {
        const note = this.queueReportReview(scope, run, claim.item, claim.reported, finalOutput, claim.status);
        if (note) notes.push(note);
      }
      for (const k of result.knowledge)
        this.store.put('knowledge', {
          ...k,
          id: randomUUID(),
          projectId: original.projectId,
          channelId: run.channelId,
          runId: run.id,
          createdAt: time,
        });
      this.store.put('results', { id: run.id, result, createdAt: time });
      // Refused entries are a division-of-work outcome, not a broken report: the report stays valid
      // (and stays stored as it was reported), while the run record and the work log say how many
      // changes were not applied. A revision conflict is counted and worded separately.
      run.reportStatus = conflicts.length ? 'conflict' : 'valid';
      run.reportError = [
        conflicts.length ? `${conflicts.length} 项在执行期间被修改，已保留现有版本；请查看报告建议。` : '',
        refused.length ? `${refused.length} 条改动因归属被拒，未写入看板；见工作日志。` : '',
      ]
        .filter(Boolean)
        .join('');
      this.store.put('runs', {
        ...run,
        status: 'completed',
        finishedAt: time,
        summary: result.summary,
      });
      // Structured release/feedback waits keep the authorized loop enabled.
      // Older native reports may also say needsHuman for that same approval.
      const needsHuman = result.needsHuman && this.store.get<any>('loop_waits', run.channelId)?.runId !== run.id;
      if (needsHuman) this.setControl(run.channelId, { enabled: false });
      const current = this.store.get<Channel>('channels', run.channelId)!;
      const enabled = this.control(run.channelId).enabled;
      this.store.put('channels', {
        ...current,
        // A bounded CLI turn has no `morrow-next` block to parse, so without this its question would
        // exist only inside the run summary: the page would say 已暂停 and never that a turn is
        // waiting for an answer. The report's summary is the question — a report carries no separate
        // field for one — and the page reads it off `work` exactly as it reads a native question.
        // The native path keeps its own decision: `completeAutonomousWork` runs right after this one
        // and replaces `work` with the block that turn wrote.
        ...(needsHuman && run.executionOwner !== 'codex-app'
          ? {
              work: {
                state: 'needs_input' as const,
                focus: '',
                reason: '本轮需要人工输入',
                nextStep: Array.from(result.summary).slice(0, 4000).join(''),
                runId: run.id,
                updatedAt: time,
                awaitingReply: true,
              },
            }
          : {}),
        status: needsHuman ? 'blocked' : enabled ? 'waiting' : 'paused',
        nextRunAt: enabled
          ? new Date(Date.now() + Math.max(current.intervalMinutes, result.nextCheckMinutes) * 60000).toISOString()
          : '',
      });
      this.event(run.channelId, run.id, 'result', result.summary);
      if (refused.length)
        this.event(
          run.channelId,
          run.id,
          'system',
          `${refused.length} 条改动因归属被拒，未写入看板：这些事项由别的频道负责，报告原文仍保留在本轮记录里。`
        );
      for (const note of notes) this.event(run.channelId, run.id, 'system', note);
      if (needsHuman) this.event(run.channelId, run.id, 'system', '此轮需要人工输入，频道已停止自动调度。');
    });
    this.trackUsageAfter(run);
  }
  /**
   * What a report's verified/resolved claim still needs, after `requirePassed` refused it. A review
   * of this item is already on its way, or the last one found counterexamples in a source nobody has
   * changed since — in both cases another review would decide nothing — or this turn must queue one.
   */
  reviewPlan(projectId: string, item: WorkItem, claimed: string): ReviewPlan {
    const rows = this.loop.verification.rows(projectId, item.id);
    if (rows.some((row) => ['queued', 'running'].includes(row.status)))
      return { prefix: reviewWaitPrefix, queue: false };
    const latest = rows.at(-1);
    let digest = '';
    try {
      digest = sourceVersion(this.store.get<Project>('projects', projectId)!.path).digest;
    } catch {
      /* An unreadable source version decides nothing; the request below reports the real reason. */
    }
    if (latest?.status === 'failed' && digest && latest.version.digest === digest) {
      const blocking = latest.findings.find((finding) => finding.severity === 'blocking');
      return {
        prefix: '上一次独立复核未通过且源码此后未变，先处理复核发现；',
        queue: false,
        note:
          `#${item.number} 的上一次独立复核未通过，源码此后没有变化，因此没有再发起复核：先修正问题再汇报` +
          `${claimedStatusText[claimed] || claimed}。${blocking ? `首个阻断性发现：${blocking.message}` : '复核未留下阻断性发现，请查看复核结论。'}`,
      };
    }
    return { prefix: reviewWaitPrefix, queue: true };
  }
  /**
   * Queue the independent review this turn's own claim needs, and hold the claimed status against it
   * so a passing review completes the item without another turn. The report and the tool activity
   * Morrow recorded become one `agent` evidence row with separately labelled sources. Recorded
   * calls have neither exit codes nor source-version binding; they are not execution evidence.
   * Nothing here may fail the report — a refusal rolls its own writes back, keeps the item in
   * 调查中 behind the wait prefix,
   * and returns the work-log line that says the next turn's claim will try again.
   */
  queueReportReview(
    scope: Scope,
    run: Run,
    item: WorkItem,
    reported: AgentResult['items'][number],
    finalOutput: string,
    claimed: string
  ): string | undefined {
    try {
      this.store.transaction(() => {
        const time = now();
        const data = this.reportEvidenceData(run, reported, finalOutput);
        const entry: Evidence = {
          id: randomUUID(),
          projectId: run.projectId,
          channelId: run.channelId,
          runId: run.id,
          itemId: item.id,
          summary:
            `${runtimeTitles[run.runtime]} 本轮汇报与最终答复为模型自述（声称${claimedStatusText[claimed] || claimed}）；` +
            `另附 Morrow 从${run.executionOwner === 'codex-app' ? '本轮事件' : ' CLI 事件流'}记录的 ` +
            `${data.recordedTools.calls.length} 次工具调用（非模型自述；无退出码与版本绑定），需独立复核。`,
          source: `run:${run.id}`,
          observedAt: time,
          createdAt: time,
          origin: 'agent',
          data,
        };
        this.store.put('loop_evidence', entry);
        this.loop.linkEvidence(entry);
        this.loop.strategy.evidenceObserved(entry);
        this.loop.audit(
          scope,
          'evidence.recorded',
          entry.summary,
          item.id,
          { id: entry.id, origin: entry.origin, source: entry.source },
          'system'
        );
        const verification = this.loop.verification.request(scope, { itemId: item.id, evidenceIds: [entry.id] });
        // `linkEvidence` added this row to the item, so the revision the completion is held against
        // is the stored one, not the revision the report itself wrote a moment earlier.
        const stored = this.store.get<WorkItem>('items', item.id)!;
        this.loop.verification.defer(scope, verification, 'feature.complete', item.id, stored.revision, {
          status: claimed,
        });
      });
    } catch (error) {
      return `#${item.number} 的独立复核未能自动发起：${
        error instanceof Error ? error.message : '未知原因'
      }；下一轮汇报时会再试`;
    }
  }
  /**
   * The turn's own report and the tool activity Morrow recorded for it, bounded so one evidence row
   * stays well inside the 512 KB of material a review may carry. Excerpts give way before whole
   * calls do, and the claim itself last; nothing here throws, because a row that cannot be shortened
   * is still better reported than lost.
   */
  reportEvidenceData(run: Run, reported: AgentResult['items'][number], finalOutput: string) {
    const calls = new Map<string, { tool: string; input?: unknown; output?: unknown; failed: boolean }>();
    for (const event of this.store.eventPage({ runId: run.id, limit: 1000 }).events) {
      const detail = event.detail;
      if (!detail?.toolCallId) continue;
      const call = calls.get(detail.toolCallId) || { tool: detail.tool || detail.type, failed: false };
      if (detail.tool) call.tool = detail.tool;
      if (detail.input !== undefined) call.input = detail.input;
      if (detail.output !== undefined) call.output = detail.output;
      if (detail.status === 'failed') call.failed = true;
      calls.set(detail.toolCallId, call);
    }
    // A turn's last calls are the ones its claim rests on, so the cap keeps the tail, not the head.
    const recorded = [...calls.values()].slice(-40);
    const excerpt = (value: unknown, limit: number) => {
      if (value === undefined) return undefined;
      try {
        return (typeof value === 'string' ? value : JSON.stringify(value) || '').slice(0, limit);
      } catch {
        return '[无法序列化]';
      }
    };
    const build = (tool: number, output: number, claim: number, count: number) => ({
      runtime: run.runtime,
      reportedBy: 'model',
      reportNote: 'report 与 finalOutput 为模型自述，未经独立复核。',
      report: {
        status: reported.status,
        summary: reported.summary.slice(0, claim),
        evidence: reported.evidence.map((value) => value.slice(0, claim)),
        nextStep: reported.nextStep.slice(0, claim),
      },
      recordedTools: {
        recordedBy: run.executionOwner === 'codex-app' ? 'morrow-run-events' : 'morrow-cli-stream',
        note:
          run.executionOwner === 'codex-app'
            ? '由 Morrow 从本轮事件记录，非模型自述；无退出码与版本绑定。'
            : '由 Morrow 从 CLI 事件流记录，非模型自述；无退出码与版本绑定。',
        calls: recorded.slice(recorded.length - count).map((call) => ({
          tool: call.tool,
          input: excerpt(call.input, tool),
          output: excerpt(call.output, tool),
          failed: call.failed,
        })),
      },
      finalOutput: finalOutput.slice(0, output),
    });
    let data = build(2000, 4000, 10000, recorded.length);
    for (const [tool, output, claim, count] of [
      [500, 2000, 5000, recorded.length],
      [200, 1000, 2000, Math.min(recorded.length, 10)],
      [0, 0, 500, 0],
    ] as const) {
      if (JSON.stringify(data).length <= 512 * 1024) break;
      data = build(tool, output, claim, count);
    }
    return data;
  }
  finishFailure(run: Run, status: string, summary: string) {
    this.recordTreeState(run);
    this.store.put('runs', {
      ...run,
      reportStatus: run.reportStatus === 'pending' ? 'missing' : run.reportStatus,
      status,
      finishedAt: now(),
      summary,
    });
    const c = this.store.get<Channel>('channels', run.channelId)!;
    this.store.put('channels', {
      ...c,
      // A turn the native task never accepted delivered no charter; the next one must send it again.
      ...(run.executionOwner === 'codex-app' && !run.nativeTurnId ? { promptCharter: undefined } : {}),
      status: status === 'interrupted' ? 'paused' : 'blocked',
      nextRunAt: '',
      pendingWake: undefined,
    });
    this.setControl(run.channelId, { enabled: false });
    this.event(run.channelId, run.id, status === 'interrupted' ? 'system' : 'error', summary);
    // The interrupted turn is final here: it keeps `interrupted`, its grant is already refused, and
    // only a record of what to watch for is added. Nothing about the App's own turn is changed.
    if (status === 'interrupted') this.appResume.observeInterruption(run);
    this.trackUsageAfter(run);
  }
  interrupt(id: string, reason: string) {
    const a = this.active.get(id);
    if (!a || a.interrupted) return;
    a.interrupted = reason;
    this.setControl(id, { enabled: false });
    try {
      if (a.child.pid) process.kill(-a.child.pid, 'SIGTERM');
    } catch {}
    a.killTimer = setTimeout(() => {
      try {
        if (a.child.pid) process.kill(-a.child.pid, 'SIGKILL');
      } catch {}
    }, 1500);
    a.killTimer.unref();
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.usage.close();
    const active = [...this.active.values()];
    for (const a of active) this.interrupt(a.channelId, '服务已关闭，执行中断');
    await Promise.all(active.map((a) => a.done));
  }
}
