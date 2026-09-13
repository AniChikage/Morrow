import { randomUUID } from 'node:crypto';
import type { MemorySeed, Scenario, Step, TimelineRecord } from './scenario.ts';
import type { MetricsStore } from './metrics.ts';
import type { ScriptedNativeTransport } from '../../tests/harness/scripted-native.ts';
import type { Receiver } from '../../tests/harness/receiver.ts';
import type { IsolatedService } from '../../tests/harness/service.ts';
import type { Channel, Run } from '../../service/protocol.ts';
import type { FeedbackWatch, Release } from '../../service/autonomy-types.ts';

/** Virtual clock the runner owns; `Date` is mocked, so every service timestamp follows it. */
export type Clock = { now(): string; advance(minutes: number): void };

export type Runner = {
  scenario: Scenario;
  service: IsolatedService;
  transport: ScriptedNativeTransport;
  receiver: Receiver;
  clock: Clock;
  /** Scheduled turns the run may still spend. */
  turnBudget: number;
};

/** How long a step waits for the service, measured on the real clock (`Date` is virtual). */
const stepTimeoutMs = 20_000;
/** Watches are only polled by an explicit `poll` step; see `parkWatches`. */
const parkMs = 365 * 24 * 3600_000;

export async function runStep(runner: Runner, step: Step, index: number): Promise<TimelineRecord> {
  const { verb, ...args } = step;
  const record: TimelineRecord = {
    index,
    verb,
    args: args as Record<string, unknown>,
    virtualTime: runner.clock.now(),
    result: {},
  };
  record.result = await execute(runner, step);
  return record;
}

async function execute(runner: Runner, step: Step): Promise<Record<string, unknown>> {
  switch (step.verb) {
    case 'turn':
      return turn(runner);
    case 'poll':
      return poll(runner);
    case 'set':
      runner.receiver.setFeedback(step.value);
      return { truth: step.truth || 'none', value: step.value };
    case 'mode':
      runner.receiver.setMode(step.mode);
      return { mode: step.mode };
    case 'approve':
      return decide(runner, 'approve');
    case 'reject':
      return decide(runner, 'reject', step.feedback);
    case 'guide':
      return guide(runner, step.text);
    case 'verify':
      return verify(runner);
    case 'restart':
      return restart(runner);
    case 'pause':
      await runner.service.engine.action(channelId(runner), 'pause');
      return { enabled: runner.service.engine.control(channelId(runner)).enabled };
    case 'resume':
      return resume(runner);
    case 'advance':
      runner.clock.advance(step.minutes);
      return { minutes: step.minutes, virtualTime: runner.clock.now() };
  }
}

const channelId = (runner: Runner) => runner.service.channel.id;
const channelRow = (runner: Runner) => runner.service.store.get<Channel>('channels', channelId(runner))!;
const runs = (runner: Runner) =>
  runner.service.store.all<Run>('runs').filter((row) => row.channelId === channelId(runner));

/**
 * Runs one scheduled turn the way the daemon would: make the channel due, then hand the tick to the
 * real scheduler so its daily budget, reviewer wait, project serialization and usage gates all apply.
 */
async function turn(runner: Runner): Promise<Record<string, unknown>> {
  if (runner.turnBudget <= 0)
    throw new Error(`turn budget of ${runner.scenario.budget.turns} turns is exhausted; the run fails`);
  runner.turnBudget--;
  parkWatches(runner);
  const before = new Set(runs(runner).map((row) => row.id));
  const channel = channelRow(runner);
  runner.service.store.put('channels', {
    ...channel,
    status: 'waiting',
    nextRunAt: new Date(Date.now() - 1000).toISOString(),
  });
  runner.service.engine.tick();
  const started = await waitFor(
    () => runs(runner).find((row) => !before.has(row.id) && row.source === 'morrow-schedule'),
    () => `a scheduled run to start (${gateDetail(runner)})`
  );
  const finished = await waitFor(
    () => {
      const row = runner.service.store.get<Run>('runs', started.id)!;
      return row.status === 'running' ? undefined : row;
    },
    () => `run ${started.id} to finish (status ${runner.service.store.get<Run>('runs', started.id)?.status})`
  );
  await runner.transport.settled();
  await drain(runner);
  const turnRecord = runner.transport.turns.at(-1);
  if (turnRecord?.error) throw new Error(`turn policy failed: ${turnRecord.error}`);
  return {
    runId: finished.id,
    status: finished.status,
    reportStatus: finished.reportStatus,
    decision: turnRecord?.decision || 'none',
    channelStatus: channelRow(runner).status,
  };
}

/**
 * Polls every live watch through the loop's own entry point. Fixture runs own observation timing:
 * `parkWatches` keeps the scheduler's own polling out of the way so a sample is taken only here.
 */
async function poll(runner: Runner): Promise<Record<string, unknown>> {
  const before = runner.service.store.all('loop_evidence').length;
  const live = runner.service.store
    .all<FeedbackWatch>('loop_watches')
    .filter((row) => row.status !== 'cancelled' && (row.status === 'watching' || row.continuous !== false));
  for (const watch of live) await runner.service.engine.loop.poll(watch.id);
  await drain(runner);
  parkWatches(runner);
  return {
    polled: live.length,
    evidence: runner.service.store.all('loop_evidence').length - before,
    statuses: live.map((row) => runner.service.store.get<FeedbackWatch>('loop_watches', row.id)?.status),
  };
}

async function decide(runner: Runner, decision: 'approve' | 'reject', feedback?: string) {
  const release = runner.service.store
    .all<Release>('loop_releases')
    .filter((row) => row.status === 'awaiting_approval')
    .at(-1);
  if (!release) throw new Error(`no release is awaiting approval; cannot ${decision}`);
  await runner.service.api('POST', `/api/releases/${release.id}/review`, {
    reviewHash: release.reviewHash,
    decision,
    ...(feedback === undefined ? {} : { feedback }),
  });
  await drain(runner);
  const settled = await waitFor(
    () => {
      const row = runner.service.store.get<Release>('loop_releases', release.id)!;
      return ['approved', 'publishing'].includes(row.status) ? undefined : row;
    },
    () => `release ${release.id} to settle (${runner.service.store.get<Release>('loop_releases', release.id)?.status})`
  );
  return { releaseId: release.id, status: settled.status, posts: runner.receiver.posts };
}

async function guide(runner: Runner, text: string) {
  const receipt = await runner.service.api('POST', `/api/channels/${channelId(runner)}/native/messages`, {
    text,
    requestId: randomUUID(),
  });
  await runner.transport.settled();
  return { state: receipt.state, acknowledgements: runner.transport.acknowledgements };
}

/** Drives whatever independent review is queued to a verdict, then applies its saved finalization. */
async function verify(runner: Runner) {
  const verification = runner.service.engine.loop.verification;
  const pending = () =>
    runner.service.store.all<any>('loop_verifications').filter((row) => ['queued', 'running'].includes(row.status))
      .length;
  if (!pending()) return { reviews: runner.transport.reviews, pending: 0, note: 'nothing queued' };
  for (let pass = 0; pass < 4 && pending(); pass++) {
    verification.tick();
    await drain(runner);
    await runner.transport.settled();
  }
  // A passed review still has to settle the request it was gating.
  verification.tick();
  await drain(runner);
  await waitFor(
    () => (pending() ? undefined : true),
    () => `independent reviews to settle (${pending()} still queued or running)`
  );
  const rows = runner.service.store.all<any>('loop_verifications');
  return {
    reviews: runner.transport.reviews,
    verdicts: rows.map((row) => row.status),
    finalizations: runner.service.store.all<any>('loop_finalizations').map((row) => row.status),
  };
}

async function restart(runner: Runner) {
  await drain(runner);
  await runner.service.restart();
  stopScheduler(runner.service);
  runner.transport.attach(runner.service);
  return {
    port: runner.service.port,
    channelStatus: channelRow(runner).status,
    running: runs(runner).filter((row) => row.status === 'running').length,
  };
}

function resume(runner: Runner) {
  runner.service.engine.setControl(channelId(runner), { enabled: true });
  const channel = channelRow(runner);
  runner.service.store.put('channels', { ...channel, status: 'waiting' });
  return { enabled: runner.service.engine.control(channelId(runner)).enabled };
}

/**
 * Stops the daemon's own one-second loop. Every gate still runs — the runner calls `engine.tick()`
 * itself — but no turn, poll or publication happens at a moment the timeline did not ask for.
 */
export function stopScheduler(service: IsolatedService) {
  if (service.engine.timer) clearInterval(service.engine.timer);
  service.engine.timer = undefined;
}

/** Pushes every live watch's next poll far out, so only a `poll` step collects a sample. */
export function parkWatches(runner: Runner) {
  const parked = new Date(Date.now() + parkMs).toISOString();
  for (const watch of runner.service.store.all<FeedbackWatch>('loop_watches'))
    if (watch.status !== 'cancelled' && watch.nextPollAt !== parked)
      runner.service.store.put('loop_watches', { ...watch, nextPollAt: parked });
}

/** Waits for the loop's tracked background work (publications, polls, reviews) to come to rest. */
export async function drain(runner: Pick<Runner, 'service'>) {
  const loop = runner.service.engine.loop;
  for (let pass = 0; pass < 20 && loop.pending.size; pass++) await Promise.allSettled([...loop.pending]);
}

/**
 * Polls `predicate` on the real clock. `until` in the harness measures with `Date.now`, which the
 * virtual clock freezes, so a fixture run needs its own timeout source.
 */
export async function waitFor<T>(predicate: () => T | Promise<T>, label: () => string, timeoutMs = stepTimeoutMs) {
  const end = performance.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value as NonNullable<T>;
    if (performance.now() >= end) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label()}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Why the scheduler may have parked a turn instead of starting it. */
function gateDetail(runner: Runner) {
  const channel = channelRow(runner);
  const reviews = runner.service.store
    .all<any>('loop_verifications')
    .filter((row) => ['queued', 'running'].includes(row.status)).length;
  const today = new Date().toISOString().slice(0, 10);
  return [
    `enabled=${runner.service.engine.control(channel.id).enabled}`,
    `status=${channel.status}`,
    `nextRunAt=${channel.nextRunAt}`,
    `runsToday=${runner.service.store.runCount(channel.id, today)}/${channel.maxRunsPerDay}`,
    `reviewsPending=${reviews}`,
    channel.usageWait ? `usageWait=${JSON.stringify(channel.usageWait)}` : 'usageWait=none',
  ].join(' ');
}

/* ------------------------------------------------------------------------- *
 * live 模式
 *
 * 同一条时间线，换成真实的 Codex App 任务来跑。三件 fixture 为了可重复做的事里只保留一件：
 * `setControl(enabled: true)` 仍然直接置开关（`action(id,'resume')` 会立刻开一轮不在时间线里的
 * 轮次）；daemon 的 1 秒定时器不停，观察也不推远，日预算、复核等待、项目串行与额度门禁都留在真实
 * 调度器自己的路径上。虚拟时钟不能用（服务、Codex App 与 `codex exec` 是三个进程），所以 `advance`
 * 变成有上限的真实 `sleep`，缩放比例写进报告。
 * ------------------------------------------------------------------------- */

/** 真实时钟。live 模式不冻结 `Date`：等待是真的等，耗时是真的耗时。 */
export type LiveClock = { now(): number; sleep(ms: number): Promise<void> };

/** `native.list` 的一个候选任务，只留 runner 用来确认"恰好一个"的字段。 */
export type ThreadCandidate = { id: string; title?: string; cwd?: string; updatedAt?: string };

/** `GET /api/native/status` 里 runner 真正依赖的那几项。 */
export type NativeStatusView = {
  connected: boolean;
  connectionMode?: string;
  boundThreadCount?: number;
  readyThreadCount?: number;
  restartRequired?: boolean;
  appVersion?: string;
  runtimeVersion?: string;
  detail?: string;
  capabilities: { create: boolean };
};

/** 一行 `runs`，只留 runner 与报告要读的字段。 */
export type RunView = {
  id: string;
  source?: string;
  status: string;
  reportStatus?: string;
  sessionId?: string;
  nativeTurnId?: string;
  permission?: string;
  model?: string;
  startedAt?: string;
  finishedAt?: string;
  /**
   * **App 自己**给这一轮打的 `turnTrigger`（例如 `resume_interrupted_task`），生产实现从
   * `native_turns` 里该 run 的 `raw.params.turnTrigger` 读，**只对 `native-app` 行解析**：runner 要
   * 看的只有 App 自己开的那些轮次。注意这不是 `runs.trigger`——那是 Morrow 自己记的 `manual`/`schedule`。
   */
  trigger?: string;
};

export type ChannelView = {
  status: string;
  /** 频道开关（`controls` 行的 `enabled`）。引擎会在一轮 `interrupted` 之后把它关掉。 */
  enabled?: boolean;
  nextRunAt?: string;
  maxRunsPerDay?: number;
  runsToday?: number;
  usageWait?: { kind: string; window?: string; resetsAt?: string; since: string };
  work?: { state: string; focus?: string; reason?: string; nextStep?: string };
};

export type ReleaseView = {
  id: string;
  title?: string;
  status: string;
  reviewHash?: string;
  itemIds?: string[];
  changes?: string;
  artifact?: { name: string; sha256: string; bytes: number };
};

export type ItemView = {
  id: string;
  title: string;
  summary: string;
  nextStep: string;
  kind: string;
  status: string;
  evidence: string[];
};

/**
 * 编排核心用到的全部服务操作，收窄成一个可替换的接口：生产实现包住 `startServer` 返回的
 * engine/loop/store/native，测试用假实现驱动同一段编排，绝不连真实 App，也绝不消耗额度。
 */
export type LiveSession = {
  /** 隔离数据目录，指标从它旁边的 `workspace.sqlite` 算。 */
  home: string;
  projectPath: string;
  projectId: string;
  channelId: string;
  /** 只读视图；`computeMetrics` 直接用它，所以假实现也能跑真实的指标代码。 */
  store: MetricsStore;
  nativeStatus(): Promise<NativeStatusView>;
  /** 未关联时启动一轮应当被拒；返回实际状态码，编排核心断言它是 409。 */
  runUnbound(): Promise<number>;
  listThreads(): Promise<ThreadCandidate[]>;
  bind(threadId: string): Promise<void>;
  /** 精确中断某一轮的 turn，不影响作者在 App 里的别的任务。 */
  interrupt(turnId: string): Promise<void>;
  setChannelBudget(maxRunsPerDay: number): Promise<void>;
  setProjectBudget(budget: { window: string; limitPercent: number }): Promise<void>;
  setReserve(reserve: { window: string; keepPercent: number }, stopWhenUsageUnknown: boolean): Promise<void>;
  /** `engine.usage.refresh()`：运行前后各取一次真实账户读数。 */
  readUsage(): Promise<unknown>;
  /** 通过工作接口写入场景预置记忆，返回被标成过期的记录 ID。 */
  seedMemory(seeds: MemorySeed[]): Promise<string[]>;
  /** 直接置开关，让第一轮仍由时间线发起。 */
  enableControl(): void;
  /**
   * 把频道置为到期，其余交给真实调度器。**同时重新打开频道开关**：引擎对 `interrupted` 的运行会把
   * 频道置 `paused` 并关掉 control（`service/engine.ts` 的 `finishFailure`），只改 `status`/`nextRunAt`
   * 的话真实调度器永远不会再启动一轮——首跑 usagegap-live-01 的第 2 轮就是这样干等到 `--turn-timeout`。
   */
  makeDue(): void;
  channel(): ChannelView;
  runs(): RunView[];
  /** 这一轮 `native_items` 里出现过的工具类型清单。 */
  turnTools(run: RunView): string[];
  /** 这一轮结束时给出的 `morrow-next` 状态；没有有效块时返回 `none`。 */
  turnDecision(runId: string): string;
  pollWatches(): Promise<{ polled: number; evidence: number; statuses: unknown[] }>;
  /** 还没落到终态的独立复核数。 */
  pendingReviews(): number;
  reviewStatuses(): string[];
  pendingRelease(): ReleaseView | undefined;
  /**
   * 人在终端上给出的上线决定，走服务正式的审阅路径：`POST /api/releases/:id/review`（桌面凭证，
   * 隔离数据目录自己的那份 token），和桌面端按下"确认上线"调的是同一条路由，所以审计记成
   * `actor:'human'` 的 `release.approved`/`release.rejected`，批准后由服务自己去上传封存产物。
   * runner 不写库、不伪造审计，也没有任何自批准的路径。
   */
  reviewRelease(
    releaseId: string,
    reviewHash: string,
    decision: 'approve' | 'reject',
    feedback?: string
  ): Promise<void>;
  /** 某个发布当前的状态，用来等它落到终态。 */
  releaseState(releaseId: string): string | undefined;
  guide(text: string): Promise<{ state?: string }>;
  pause(): Promise<void>;
  resume(): void;
  restart(): Promise<void>;
  items(): ItemView[];
  drain(): Promise<void>;
  close(): Promise<void>;
};

/** 为什么这次 live 运行停下了；退出码由 `live.ts` 的表决定，不在这里。 */
export type LiveStopReason =
  | 'timeline-finished'
  | 'budget-exhausted'
  | 'usage-blocked'
  | 'needs-input'
  | 'awaiting-approval'
  | 'no-app-task'
  | 'turn-timeout'
  | 'thread-not-ready'
  | 'restart-required'
  | 'wall-clock'
  | 'error';

/** 有序停止的信号。抛出它表示"按第 6 节的表停下"，而不是"运行坏了"。 */
export class LiveStop extends Error {
  reason: LiveStopReason;
  detail: string;
  constructor(reason: LiveStopReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = 'LiveStop';
    this.reason = reason;
    this.detail = detail;
  }
}

export type LiveLimits = {
  /** 一轮真实运行的等待上限。 */
  turnTimeoutMs: number;
  /** 等人在终端上给出上线决定的上限；也用来等一个待确认的发布出现。 */
  approvalWaitMs: number;
  /** 等独立复核落到终态的上限，略大于 `codex exec` 的 5 分钟硬上限。也用来等发布落到终态。 */
  reviewTimeoutMs: number;
  /** 单个 `advance` 真实等待的上限。 */
  maxWaitMs: number;
  /** `advance N` 实际等 `N × advanceScale` 分钟。 */
  advanceScale: number;
  /** 墙钟兜底的截止时刻（`clock.now()` 同一时间基准）。 */
  wallClockEnd: number;
};

/** 一次终端上的人工上线确认，写进 `live.json` 的 `approvals`。 */
export type LiveApproval = {
  releaseId: string;
  decision: 'approve' | 'reject';
  /** 人按下回车的真实时刻。 */
  at: string;
  /** 这个决定是人在终端上输入的。runner 没有自批准的路径，所以这一项恒为 true。 */
  byHumanAtTerminal: true;
  /** 发布最后落到的状态；`pending` 表示 `--review-timeout` 内还没落到终态。 */
  outcome: string;
  /** 服务把这次确认记成了哪条 `actor:'human'` 的审计；`missing` 表示没找到，那是要看的结果。 */
  audit: 'release.approved' | 'release.rejected' | 'missing';
  /** `reject` 时人给出的意见（如果时间线的步骤带了）。 */
  feedback?: string;
};

export type LiveRunner = {
  scenario: Scenario;
  session: LiveSession;
  receiver: Receiver;
  clock: LiveClock;
  log(text: string): void;
  /**
   * 终端上的提问与读入。**只有 stdin 是 TTY 时生产工厂才提供它**——缺了就表示没有人守在终端边上，
   * `approve`/`reject` 于是照旧停在人工确认。返回 `undefined` 表示超时（或输入流关了）。
   */
  prompt?(question: string, timeoutMs: number): Promise<string | undefined>;
  limits: LiveLimits;
  /** `--budget`：本次运行允许出现的 `morrow-schedule` 轮次总数。 */
  budget: number;
  /**
   * 编排开始前就已经存在的 `morrow-schedule` 行。它们不属于本次运行，所以既不计预算，也不会被
   * 错认成某一轮的结果——0.9.5 验收踩过的正是这个坑。
   */
  baseline: Set<string>;
  /** 本次运行新出现的 `morrow-schedule` 行；真实调度器自己发起的轮次一样计入。 */
  seen: Set<string>;
  /**
   * runner 自己请求停过的轮次（`runId`）。只有 `--turn-timeout` 的那条路径会往里加。有了它，
   * 「这一轮以 `interrupted` 结束」能分成两种：runner 自己停的，和别人（App）停的。
   */
  interrupts: Set<string>;
  /** 每一轮的真实起止、耗时、结论与工具清单，写进 `live.json`。 */
  turns: Array<{
    stepIndex: number;
    runId: string;
    status: string;
    reportStatus?: string;
    decision: string;
    sessionId?: string;
    nativeTurnId?: string;
    permission?: string;
    model?: string;
    startedAt: string;
    finishedAt: string;
    wallMs: number;
    tools: string[];
    /**
     * 这一轮不是本步骤 `makeDue` 开的，而是真实调度器自己发起、被这个 `turn` 步骤接管的：
     * `running` 是接管时还在跑，`completed` 是接管时已经跑完而 runner 从未等过。
     */
    adopted?: 'running' | 'completed';
    /** 接管的轮次起止取自哪里：`run` 是 `runs` 行上的时间，`clock` 是行上没有、用了接管时的当前时刻。 */
    timesFrom?: 'run' | 'clock' | 'mixed';
    /**
     * App 自己中断了这一轮，又以 `turnTrigger: 'resume_interrupted_task'` 开一轮把活干完。这一对
     * 属于同一轮工作，所以记在同一条里：`status` 仍是 Morrow 那轮的 `interrupted`，续跑那轮的
     * 结局在 `resumedStatus`，`tools` 是两轮的并集，`decision` 仍取引擎对 Morrow 那轮解析出的值。
     */
    interruptedByApp?: true;
    resumedRunId?: string;
    resumedStatus?: string;
    resumedWallMs?: number;
  }>;
  /** 每一次终端上的人工上线确认，写进 `live.json`。 */
  approvals: LiveApproval[];
  stop?: { reason: LiveStopReason; detail: string };
  /** 原生状态的节流缓存：每次等待都查一遍会变成一串真实 IPC 往返。 */
  statusAt?: number;
  status?: NativeStatusView;
};

/** 等待里每次检查之间的间隔。 */
const livePollMs = 1_000;
/** 关联等待按提案第 2 节每 3 秒查一次。 */
export const bindPollMs = 3_000;
/** 轮询原生状态是一次真实 IPC 往返，等待中最多这么频繁地查。 */
const statusEveryMs = 5_000;
/** `advance` 的真实等待切成不超过这么长的片，每片之间过一遍 `guard`。 */
const advanceSliceMs = 5_000;

/** 本次运行里**新出现**的 `morrow-schedule` 行；真实调度器自己发起的轮次也算。 */
function observeRuns(runner: LiveRunner) {
  for (const row of runner.session.runs())
    if (row.source === 'morrow-schedule' && !runner.baseline.has(row.id)) runner.seen.add(row.id);
  return runner.seen.size;
}

/**
 * 本次运行新出现（不在 `baseline`）、而且还没有被任何时间线步骤记进 `runner.turns` 的
 * `morrow-schedule` 行。真实调度器自己发起的轮次就在这里等着被下一个 `turn` 步骤接管。
 */
function unrecordedRuns(runner: LiveRunner): RunView[] {
  const recorded = new Set(runner.turns.map((turn) => turn.runId));
  return runner.session
    .runs()
    .filter((row) => row.source === 'morrow-schedule' && !runner.baseline.has(row.id) && !recorded.has(row.id));
}

/**
 * 第 6 节里那些"任一条成立就有序停下"的条件，在每个步骤之前和每次等待的每一轮都检查一遍。抛出
 * `LiveStop` 而不是返回，好让深在等待里的代码也能立刻停。
 */
async function guard(runner: LiveRunner, options: { status?: boolean } = {}) {
  const at = runner.clock.now();
  if (at > runner.limits.wallClockEnd)
    throw new LiveStop(
      'wall-clock',
      `墙钟超过 --wall-clock，已经过去 ${Math.round((at - runner.limits.wallClockEnd) / 60_000)} 分钟的余量`
    );
  if (observeRuns(runner) > runner.budget)
    throw new LiveStop(
      'budget-exhausted',
      `本次运行已经出现 ${runner.seen.size} 个 morrow-schedule 轮次，超过 --budget ${runner.budget}`
    );
  const channel = runner.session.channel();
  if (channel.usageWait)
    throw new LiveStop(
      'usage-blocked',
      `频道被额度门禁挡住：${channel.usageWait.kind}${channel.usageWait.window ? `（${channel.usageWait.window} 窗口）` : ''}，窗口重置 ${channel.usageWait.resetsAt || '未知'}`
    );
  if (options.status === false) return;
  if (runner.status && at - (runner.statusAt ?? 0) < statusEveryMs) return;
  runner.statusAt = at;
  const status = (runner.status = await runner.session.nativeStatus());
  if (status.restartRequired) throw new LiveStop('restart-required', '检测到旧转接：需要人在当轮结束后重开 Codex App');
  if (!status.connected || status.readyThreadCount !== 1)
    throw new LiveStop(
      'thread-not-ready',
      `关联的 App 任务不再就绪（connected=${status.connected} readyThreadCount=${status.readyThreadCount ?? '未知'}）：${status.detail || '无说明'}`
    );
}

/** 真实时钟上的轮询等待；每一轮都过一遍 `guard`，所以致命条件不会被等待掩盖。 */
export async function waitLive<T>(
  runner: LiveRunner,
  predicate: () => T | Promise<T>,
  label: () => string,
  timeoutMs: number,
  pollMs = livePollMs
): Promise<NonNullable<T>> {
  const end = runner.clock.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value as NonNullable<T>;
    if (runner.clock.now() >= end)
      throw new Error(`等待 ${label()} 超过 ${Math.round(timeoutMs / 60_000)} 分钟（${timeoutMs}ms）`);
    await runner.clock.sleep(pollMs);
    await guard(runner);
  }
}

/** 一个 live 步骤，语义见提案第 3 节。真实时间写进 `virtualTime`（字段名沿用 fixture）。 */
export async function runLiveStep(runner: LiveRunner, step: Step, index: number): Promise<TimelineRecord> {
  const { verb, ...args } = step;
  const record: TimelineRecord = {
    index,
    verb,
    args: args as Record<string, unknown>,
    virtualTime: new Date(runner.clock.now()).toISOString(),
    result: {},
  };
  await guard(runner);
  record.result = await executeLive(runner, step, index);
  return record;
}

async function executeLive(runner: LiveRunner, step: Step, index: number): Promise<Record<string, unknown>> {
  switch (step.verb) {
    case 'turn':
      return liveTurn(runner, index);
    case 'poll':
      return await runner.session.pollWatches();
    case 'set':
      runner.receiver.setFeedback(step.value);
      return { truth: step.truth || 'none', value: step.value };
    case 'mode':
      runner.receiver.setMode(step.mode);
      return { mode: step.mode };
    case 'approve':
    case 'reject':
      return liveDecide(runner, step);
    case 'guide':
      return liveGuide(runner, step.text);
    case 'verify':
      return liveVerify(runner);
    case 'restart':
      return liveRestart(runner);
    case 'pause':
      await runner.session.pause();
      return { channelStatus: runner.session.channel().status };
    case 'resume':
      runner.session.resume();
      return { channelStatus: runner.session.channel().status };
    case 'advance':
      return liveAdvance(runner, step.minutes);
  }
}

/**
 * 一轮真实轮次。真实调度器不停，所以一轮以 `continue` 结束 30 秒后它会自己开下一轮：走到这个步骤时
 * 可能已经有一轮在 `running`，也可能已经跑完了一轮 runner 从未等过。所以先**接管**那样的轮次，而不是
 * 无条件 `makeDue`——不接管有三个后果：`makeDue` 会把正在跑的频道状态覆写成 `waiting`；调度器自己开
 * 的那轮计进 `seen` 却不进 `runner.turns`，于是「每一轮」表比 `spentTurns` 少行；一个时间线 `turn` 实
 * 际消耗两轮。
 *
 * 顺序是：先找本次运行新出现（不在 `baseline`）且尚未记进 `runner.turns` 的 `morrow-schedule` 行——有
 * `running` 的就等它结束并记为本步骤的轮次，有已完成但未记录的就直接记下（不再开新轮）；两者都没有
 * 才 `makeDue` 并等新行。`--budget` 因此只挡"开新轮"这件事：接管已经发生的轮次不多花额度。
 *
 * 0.9.5 验收踩过的坑是同步进来的历史 `native-app` 轮次被错认成本轮结果，所以既按来源过滤，也按"运行
 * 开始前就存在的行"排除。
 */
async function liveTurn(runner: LiveRunner, stepIndex: number): Promise<Record<string, unknown>> {
  const before = new Set(runner.seen);
  observeRuns(runner);
  const unrecorded = unrecordedRuns(runner);
  const takeover = unrecorded.find((row) => row.status === 'running') || unrecorded[0];
  const adopted: 'running' | 'completed' | undefined = takeover
    ? takeover.status === 'running'
      ? 'running'
      : 'completed'
    : undefined;
  let startedAt = runner.clock.now();
  let started: RunView;
  if (takeover) {
    started = takeover;
    runner.log(
      adopted === 'running'
        ? `真实调度器已经在跑 ${takeover.id}，这一步接管它并等它结束，不再 makeDue。`
        : `真实调度器自己跑完了 ${takeover.id} 而 runner 从未等过，这一步直接把它记为本步骤的轮次，不再开新轮。`
    );
  } else {
    if (runner.seen.size >= runner.budget)
      throw new LiveStop('budget-exhausted', `已经用掉 ${runner.seen.size}/${runner.budget} 轮，下一轮会超出 --budget`);
    const known = new Set(runner.session.runs().map((row) => row.id));
    runner.session.makeDue();
    startedAt = runner.clock.now();
    started = await waitLive(
      runner,
      () => runner.session.runs().find((row) => !known.has(row.id) && row.source === 'morrow-schedule'),
      () => `真实调度器发起一轮 morrow-schedule 运行（${liveGateDetail(runner)}）`,
      runner.limits.turnTimeoutMs
    ).catch((error) => {
      throw error instanceof LiveStop ? error : new LiveStop('turn-timeout', message(error));
    });
  }
  runner.seen.add(started.id);
  const finished = adopted === 'completed' ? started : await waitFinished(runner, started, startedAt);
  await runner.session.drain();
  const decision = runner.session.turnDecision(finished.id);
  const endedAt = runner.clock.now();
  const times = adopted
    ? adoptedTimes(finished, startedAt, endedAt)
    : {
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(endedAt).toISOString(),
        wallMs: endedAt - startedAt,
      };
  const resumed = await appResume(runner, finished);
  const pair = resumed
    ? {
        interruptedByApp: true as const,
        resumedRunId: resumed.run.id,
        resumedStatus: resumed.run.status,
        resumedWallMs: resumed.wallMs,
      }
    : {};
  runner.turns.push({
    stepIndex,
    runId: finished.id,
    status: finished.status,
    ...(finished.reportStatus === undefined ? {} : { reportStatus: finished.reportStatus }),
    decision,
    ...(finished.sessionId === undefined ? {} : { sessionId: finished.sessionId }),
    ...(finished.nativeTurnId === undefined ? {} : { nativeTurnId: finished.nativeTurnId }),
    ...(finished.permission === undefined ? {} : { permission: finished.permission }),
    ...(finished.model === undefined ? {} : { model: finished.model }),
    ...times,
    // 续跑的那一轮是同一轮工作的后半段，所以工具清单取两轮的并集（生产的 turnTools 本来就是排序的）。
    tools: resumed
      ? [...new Set([...runner.session.turnTools(finished), ...runner.session.turnTools(resumed.run)])].sort()
      : runner.session.turnTools(finished),
    ...(adopted ? { adopted } : {}),
    ...pair,
  });
  const result = {
    runId: finished.id,
    status: finished.status,
    reportStatus: finished.reportStatus,
    decision,
    channelStatus: runner.session.channel().status,
    spentTurns: runner.seen.size,
    newThisRun: runner.seen.size - before.size,
    wallMs: times.wallMs,
    ...(adopted ? { adopted } : {}),
    ...pair,
  };
  if (decision === 'needs_input') {
    const work = runner.session.channel().work;
    runner.log(
      [
        '',
        '真实模型在这一轮提了问题，runner 不代替人回答：',
        `- ${work?.nextStep || work?.reason || '（正文里没有给出问题）'}`,
        '',
      ].join('\n')
    );
    runner.stop = { reason: 'needs-input', detail: work?.nextStep || '这一轮以 needs_input 结束' };
  }
  return result;
}

/**
 * 等一轮真实结束。超时就先精确中断本轮的 turn，再中止；不给原任务发别的停止请求。接管进行中的轮次
 * 走的也是这里，所以 `--turn-timeout` 从接管那一刻起算。
 */
async function waitFinished(runner: LiveRunner, started: RunView, startedAt: number): Promise<RunView> {
  return waitLive(
    runner,
    () => {
      const row = runner.session.runs().find((candidate) => candidate.id === started.id);
      return row && row.status !== 'running' ? row : undefined;
    },
    () => `轮次 ${started.id} 真实结束（当前 ${runner.session.runs().find((row) => row.id === started.id)?.status}）`,
    runner.limits.turnTimeoutMs - (runner.clock.now() - startedAt)
  ).catch(async (error) => {
    if (error instanceof LiveStop) throw error;
    const row = runner.session.runs().find((candidate) => candidate.id === started.id);
    runner.interrupts.add(started.id);
    const interrupted = row?.nativeTurnId
      ? await runner.session
          .interrupt(row.nativeTurnId)
          .then(() => '已请求停止本轮')
          .catch((reason) => `中断失败：${message(reason)}`)
      : '本轮还没有 nativeTurnId，未发中断';
    throw new LiveStop('turn-timeout', `${message(error)}；${interrupted}`);
  });
}

/** App 自己中断之后的续跑要在这么久之内出现，否则就认为它不会来了。 */
const appResumeWindowMs = 15_000;

/**
 * 接住「App 自己中断这一轮、又自己把它续跑完」的情况。首跑 usagegap-live-01 就是这样：任务窗口在
 * 前台时 App 对该任务重放了 thread settings，把 Morrow 跟随的这一轮标成
 * `turn_aborted reason=interrupted`（"interrupted on purpose"），紧接着自己以
 * `turnTrigger: 'resume_interrupted_task'` 开了新一轮并跑完（Morrow 侧记成一行 `native-app` 运行）。
 * 不是 runner 发的中断，`events` 里也没有 `native.interrupt`。
 *
 * 这一对属于同一轮工作，所以在最多 15 秒内找同一线程上随后出现的那行续跑运行，找到就等它结束
 * （仍受 `--turn-timeout`），由调用方把两者记进同一条 turn 记录。找不到就照旧记 `interrupted`。
 * 这不是失败条件：无论找不找到，时间线都继续往下走。
 *
 * 只按「`interrupted` 且 runner 自己没请求过停」触发，并且要求续跑那行的 `startedAt` 不早于被中断
 * 那一轮——线程的历史里可能本来就有一行 `resume_interrupted_task`，那不是本次运行的事。
 */
async function appResume(runner: LiveRunner, finished: RunView): Promise<{ run: RunView; wallMs: number } | undefined> {
  if (finished.status !== 'interrupted' || runner.interrupts.has(finished.id)) return undefined;
  const notBefore = msAt(finished.startedAt) ?? runner.clock.now();
  const taken = new Set(runner.turns.flatMap((turn) => (turn.resumedRunId ? [turn.resumedRunId] : [])));
  const candidate = () =>
    runner.session
      .runs()
      .find(
        (row) =>
          row.source === 'native-app' &&
          row.trigger === 'resume_interrupted_task' &&
          row.sessionId === finished.sessionId &&
          !taken.has(row.id) &&
          (msAt(row.startedAt) ?? 0) >= notBefore
      );
  const found = await waitLive(
    runner,
    candidate,
    () => 'App 自己以 resume_interrupted_task 续跑的轮次出现',
    appResumeWindowMs
  ).catch((error) => {
    if (error instanceof LiveStop) throw error;
    return undefined;
  });
  if (!found) {
    runner.log(
      `轮次 ${finished.id} 以 interrupted 结束，而 runner 没有发过中断；${appResumeWindowMs / 1000} 秒内也没有出现 App 自己的续跑轮次，如实记为 interrupted。`
    );
    return undefined;
  }
  runner.log(
    [
      `轮次 ${finished.id} 是被 App 自己中断的（runner 没有发过中断），App 随后以 turnTrigger=resume_interrupted_task`,
      `开了 ${found.id} 把这一轮续完。两者记为同一轮：状态保留 interrupted，续跑的结局记在 resumedStatus，`,
      '工具清单取两轮的并集。morrow-next 仍取引擎对 Morrow 那一轮解析出的值——App 自己 resume 的轮次引擎不解析，所以通常是 none。',
    ].join('')
  );
  const from = runner.clock.now();
  const settled =
    found.status === 'running'
      ? await waitLive(
          runner,
          () => {
            const row = runner.session.runs().find((candidate) => candidate.id === found.id);
            return row && row.status !== 'running' ? row : undefined;
          },
          () =>
            `App 续跑的轮次 ${found.id} 结束（当前 ${runner.session.runs().find((row) => row.id === found.id)?.status}）`,
          runner.limits.turnTimeoutMs
        ).catch((error) => {
          if (error instanceof LiveStop) throw error;
          // 这一轮是 App 自己开的，不给它发停止请求（和清理里「不给原任务发别的停止请求」同一条约定）。
          throw new LiveStop('turn-timeout', `${message(error)}；这一轮是 App 自己开的，runner 未发中断`);
        })
      : found;
  const started = msAt(settled.startedAt);
  const ended = msAt(settled.finishedAt);
  return {
    run: settled,
    wallMs: started !== undefined && ended !== undefined ? Math.max(0, ended - started) : runner.clock.now() - from,
  };
}

/**
 * 被接管的轮次不是 runner 开的，runner 的时钟量不到它的真实起止，所以优先取 `runs` 行上的
 * `startedAt`/`finishedAt`；行上没有就退回接管时的当前时刻，并在 `timesFrom` 里标明哪一半是这么来的。
 */
function adoptedTimes(row: RunView, from: number, to: number) {
  const start = msAt(row.startedAt) ?? from;
  const end = msAt(row.finishedAt) ?? to;
  const sources: Array<'run' | 'clock'> = [
    msAt(row.startedAt) ? 'run' : 'clock',
    msAt(row.finishedAt) ? 'run' : 'clock',
  ];
  return {
    startedAt: new Date(start).toISOString(),
    finishedAt: new Date(end).toISOString(),
    wallMs: Math.max(0, end - start),
    timesFrom: (sources[0] === sources[1] ? sources[0] : 'mixed') as 'run' | 'clock' | 'mixed',
  };
}

const msAt = (text?: string) => {
  const at = text ? Date.parse(text) : Number.NaN;
  return Number.isFinite(at) ? at : undefined;
};

/** 一个发布已经落到终态：不会再自己变了。`approved`/`publishing` 还在路上。 */
const settledRelease = ['published', 'failed', 'unknown', 'rejected'];

/**
 * 暂停会中断频道当前那一轮（`engine.action(id,'pause')` 的语义），所以先把正在跑的轮次记进
 * `interrupts`：那是 **runner 自己**停的，不是 App 停的。不记的话下一个 `turn` 步骤接管到这一行
 * `interrupted` 时会去找"App 自己的续跑轮次"，白等 15 秒，还可能把结论写反。
 */
function noteOwnInterrupts(runner: LiveRunner) {
  for (const row of runner.session.runs())
    if (row.status === 'running' && row.source === 'morrow-schedule') runner.interrupts.add(row.id);
}

/**
 * 发布确认永远是人做的：runner 没有自批准的路径，也没有 `--allow-approve`。它只做两件事之一。
 *
 * **stdin 是 TTY**（有人守在终端边上）：把发布信息打出来，在终端上问一次，最多等 `--approval-wait`。
 * 人输入 `approve`/`reject` 就以**人**的身份走服务正式的审阅路径（`POST /api/releases/:id/review`，
 * 和桌面端按下"确认上线"同一条路由，审计是 `actor:'human'` 的 `release.approved`/`release.rejected`），
 * 然后等发布落到终态并**继续时间线**——完整时间线因此走得过去。直接回车、超时或输入别的东西都不算决定：
 * 照旧停在人工确认。没有待确认的发布时先等最多 `--approval-wait` 看它会不会出现，仍然没有才停。
 *
 * **stdin 不是 TTY**：没有人能回答，所以行为和以前一样——打印发布信息、暂停频道、以"停在人工确认"结束。
 *
 * 提问期间频道先暂停：人可能想很久，而真实调度器不停，30 分钟的 30 秒间隔足够把 `--budget` 烧光。
 * 有了决定就把频道恢复回去，下一个 `turn` 的 `makeDue` 照常接着走。等"发布出现"的那一段**不**暂停——
 * 发布是模型在某一轮里提的，暂停了它就永远不会出现。
 */
async function liveDecide(runner: LiveRunner, step: Step & { verb: 'approve' | 'reject' }) {
  const verb = step.verb;
  const feedback = step.verb === 'reject' ? step.feedback : undefined;
  const interactive = !!runner.prompt;
  let release = runner.session.pendingRelease();
  if (!release && interactive) {
    runner.log(
      `时间线走到 ${verb}，但现在没有待确认的发布。先等最多 ${Math.round(runner.limits.approvalWaitMs / 60_000)} 分钟看它会不会出现。`
    );
    release = await waitLive(
      runner,
      () => runner.session.pendingRelease(),
      () => '出现一个待人工确认的发布',
      runner.limits.approvalWaitMs
    ).catch((error) => {
      if (error instanceof LiveStop) throw error;
      return undefined;
    });
  }
  runner.log(
    [
      '',
      `时间线走到 ${verb}：live 模式下这一步由**人**在终端上做，runner 没有自批准的路径。`,
      release
        ? [
            `- 发布：${release.title || '（无标题）'}（${release.id}）`,
            `- reviewHash：${release.reviewHash || '未知'}`,
            `- 事项：${(release.itemIds || []).join('、') || '无'}`,
            `- 产物：${release.artifact ? `${release.artifact.name} · ${release.artifact.bytes} 字节 · ${release.artifact.sha256.slice(0, 16)}…` : '无'}`,
            `- 改动：${(release.changes || '').slice(0, 400) || '（未填写）'}`,
          ].join('\n')
        : '- 现在没有等待确认的发布；时间线仍然停在这里，因为这一步是人的决定。',
      '',
    ].join('\n')
  );
  if (!interactive || !release) {
    if (!interactive)
      runner.log('stdin 不是 TTY：没有人能在这里回答，所以暂停频道并停在人工确认（这不是失败，退出码 0）。');
    noteOwnInterrupts(runner);
    await runner.session.pause();
    runner.stop = {
      reason: 'awaiting-approval',
      detail: release ? `停在人工确认：发布 ${release.id}` : `停在人工确认：时间线的 ${verb} 步骤`,
    };
    return {
      verb,
      interactive,
      ...(release ? { releaseId: release.id, releaseStatus: release.status, reviewHash: release.reviewHash } : {}),
      channelStatus: runner.session.channel().status,
    };
  }

  // 人可能想很久：先暂停，真实调度器就不会在这段时间里自己发起轮次把 --budget 烧掉。
  noteOwnInterrupts(runner);
  await runner.session.pause();
  const minutes = Math.round(runner.limits.approvalWaitMs / 60_000);
  const answer = await runner.prompt!(
    `输入 approve 批准、reject 拒绝，直接回车或超时（最多 ${minutes} 分钟）则停在人工确认：`,
    runner.limits.approvalWaitMs
  );
  const decision = answer?.trim().toLowerCase();
  if (decision !== 'approve' && decision !== 'reject') {
    runner.log(
      decision === undefined
        ? `等了 ${minutes} 分钟也没有读到输入：停在人工确认（退出码 0），现场留在产物目录里。`
        : decision === ''
          ? '读到的是直接回车：停在人工确认（退出码 0），现场留在产物目录里。'
          : `读到的不是 approve 也不是 reject（"${decision.slice(0, 40)}"）：停在人工确认（退出码 0）。`
    );
    runner.stop = { reason: 'awaiting-approval', detail: `停在人工确认：发布 ${release.id}` };
    return {
      verb,
      interactive,
      releaseId: release.id,
      releaseStatus: release.status,
      reviewHash: release.reviewHash,
      answered: decision ?? 'timeout',
      channelStatus: runner.session.channel().status,
    };
  }

  const at = new Date(runner.clock.now()).toISOString();
  await runner.session.reviewRelease(release.id, release.reviewHash || '', decision, feedback);
  await runner.session.drain();
  runner.log(`已以人的身份提交 ${decision}（服务的 /api/releases/${release.id}/review），等它落到终态。`);
  const outcome =
    (await waitLive(
      runner,
      () => {
        const status = runner.session.releaseState(release!.id);
        return status && settledRelease.includes(status) ? status : undefined;
      },
      () => `发布 ${release!.id} 落到终态（当前 ${runner.session.releaseState(release!.id) || '未知'}）`,
      runner.limits.reviewTimeoutMs
    ).catch((error) => {
      if (error instanceof LiveStop) throw error;
      runner.log(`发布 ${release!.id} 在 --review-timeout 内还没落到终态：如实记成 pending，时间线继续。`);
      return undefined;
    })) ?? 'pending';
  const approval: LiveApproval = {
    releaseId: release.id,
    decision,
    at,
    byHumanAtTerminal: true,
    outcome,
    audit: humanAudit(runner, release.id, decision),
    ...(feedback === undefined ? {} : { feedback }),
  };
  runner.approvals.push(approval);
  runner.log(`发布 ${release.id}：${decision} → ${outcome}（审计 ${approval.audit}）。时间线继续，频道恢复自动工作。`);
  // 决定已经落库，把频道放回自动工作；下一个 turn 的 makeDue 照常接着走。
  runner.session.resume();
  return {
    verb,
    interactive,
    releaseId: release.id,
    decision,
    outcome,
    audit: approval.audit,
    answered: decision,
    channelStatus: runner.session.channel().status,
  };
}

/**
 * 服务有没有把这次确认记成 `actor:'human'` 的审计。runner 不写这条事件，只读回来——「人工上线确认」这道
 * 门禁要证明的正是它，所以记录的是查到的结果，查不到就如实记 `missing`。
 */
function humanAudit(runner: LiveRunner, releaseId: string, decision: 'approve' | 'reject'): LiveApproval['audit'] {
  const action = decision === 'approve' ? 'release.approved' : 'release.rejected';
  const rows = runner.session.store.all<{
    action?: string;
    actor?: string;
    changes?: { after?: { releaseId?: string } };
  }>('events');
  const found = rows.some(
    (row) => row.action === action && row.actor === 'human' && row.changes?.after?.releaseId === releaseId
  );
  return found ? action : 'missing';
}

/** 以 `source:'chat'` 向同一条原生任务发一条指导；它真的消耗一轮 App 对话，不计编排预算。 */
async function liveGuide(runner: LiveRunner, text: string) {
  const receipt = await runner.session.guide(text);
  return { state: receipt.state || 'unknown', text };
}

/**
 * fixture 的 `verify` 自己驱动复核；live 下独立复核走真实 `codex exec`（只读、临时会话、5 分钟硬
 * 上限），runner 只在有排队的复核时等它落到终态。
 */
async function liveVerify(runner: LiveRunner) {
  const pending = runner.session.pendingReviews();
  if (!pending) return { pending: 0, note: 'live 下 verify 是 no-op；当前没有排队的独立复核' };
  await waitLive(
    runner,
    () => (runner.session.pendingReviews() ? undefined : true),
    () => `独立复核落到终态（还有 ${runner.session.pendingReviews()} 个排队或进行中）`,
    runner.limits.reviewTimeoutMs
  );
  return { pending, verdicts: runner.session.reviewStatuses(), note: 'live 下 verify 只等真实复核结束' };
}

/**
 * 关服务再在同一 `home` 上打开：绑定、历史与待核对回执都应当还在。重开之后原生连接要花一点时间
 * 才重新就绪，所以这里自己等到就绪再往下走——否则下一个步骤的 `guard` 会把正在重连的状态当成
 * 「任务不再就绪」。等待本身不过 `guard`，它检查的正是这件事。
 */
async function liveRestart(runner: LiveRunner): Promise<Record<string, unknown>> {
  await runner.session.restart();
  runner.status = undefined;
  runner.statusAt = undefined;
  const end = runner.clock.now() + runner.limits.turnTimeoutMs;
  for (;;) {
    const status = await runner.session.nativeStatus();
    if (status.restartRequired)
      throw new LiveStop('restart-required', `重开服务后检测到旧转接：${status.detail || '需要重开 Codex App'}`);
    if (status.connected && status.boundThreadCount === 1 && status.readyThreadCount === 1)
      return {
        channelStatus: runner.session.channel().status,
        boundThreadCount: status.boundThreadCount,
        readyThreadCount: status.readyThreadCount,
        running: runner.session.runs().filter((row) => row.status === 'running').length,
      };
    if (runner.clock.now() >= end)
      throw new LiveStop(
        'thread-not-ready',
        `重开服务后没有等到关联恢复：connected=${status.connected} boundThreadCount=${status.boundThreadCount ?? '未知'} readyThreadCount=${status.readyThreadCount ?? '未知'}`
      );
    await runner.clock.sleep(bindPollMs);
  }
}

/**
 * 虚拟时钟不能用（见提案第 3 节），所以 `advance N` 是真实 `sleep(min(N × scale, --max-wait))`，真实
 * 耗时记进时间线。缩放意味着 `adjustmentLatency` 的绝对分钟数不可与 fixture 直接比较。
 *
 * 等待切成不超过 `advanceSliceMs` 的片，每片之间过一遍 `guard`：`--max-wait` 最长 10 分钟，一次
 * `sleep` 到底会让这段时间里真实调度器自己发起的轮次不被计数，预算、额度门禁（`usageWait`）、
 * `readyThreadCount` 掉 0、`restartRequired` 和墙钟也都要等到 sleep 结束才被发现。分片之后这些条件
 * 最迟 5 秒就会被看到，`waitedMs` 仍然是 `clock.now()` 的真实差值，语义不变。
 */
async function liveAdvance(runner: LiveRunner, minutes: number) {
  const wanted = minutes * runner.limits.advanceScale * 60_000;
  const waitMs = Math.min(wanted, runner.limits.maxWaitMs);
  const from = runner.clock.now();
  runner.log(`advance ${minutes} 分钟 × ${runner.limits.advanceScale} = 真实等待 ${Math.round(waitMs / 1000)} 秒`);
  const end = from + waitMs;
  for (let left = waitMs; left > 0; left = end - runner.clock.now()) {
    await runner.clock.sleep(Math.min(left, advanceSliceMs));
    await guard(runner);
  }
  return {
    minutes,
    advanceScale: runner.limits.advanceScale,
    plannedMs: Math.round(wanted),
    waitedMs: runner.clock.now() - from,
    cappedByMaxWait: wanted > runner.limits.maxWaitMs,
    sliceMs: advanceSliceMs,
    at: new Date(runner.clock.now()).toISOString(),
  };
}

/**
 * 真实调度器为什么可能还没发起这一轮。`enabled=` 排在最前面：首跑 usagegap-live-01 干等满
 * `--turn-timeout` 的原因正是频道开关被引擎关掉了，而当时这行说明里看不出来。
 */
function liveGateDetail(runner: LiveRunner) {
  const channel = runner.session.channel();
  return [
    `enabled=${channel.enabled ?? '未知'}`,
    `status=${channel.status}`,
    `nextRunAt=${channel.nextRunAt || '空'}`,
    `runsToday=${channel.runsToday ?? '未知'}/${channel.maxRunsPerDay ?? '未知'}`,
    `reviewsPending=${runner.session.pendingReviews()}`,
    channel.usageWait ? `usageWait=${JSON.stringify(channel.usageWait)}` : 'usageWait=none',
  ].join(' ');
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
