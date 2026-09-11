import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startReceiver } from '../../tests/harness/receiver.ts';
import { grantFor } from '../../tests/harness/grant.ts';
import { computeMetrics } from './metrics.ts';
import { findingsSection, liveNotice, metricsSection, scaleNote, writeMetrics } from './report.ts';
import { projectBrief, readTree, usageURL } from './scenario.ts';
import { freePort, startApp } from './serve.ts';
import { LiveStop, bindPollMs, runLiveStep } from './timeline.ts';
import type {
  ItemView,
  LiveClock,
  LiveRunner,
  LiveSession,
  LiveStopReason,
  NativeStatusView,
  RunView,
} from './timeline.ts';
import type { InvariantResult, Labels, MemorySeed, Scenario, ServedApp, TimelineRecord } from './scenario.ts';
import type { AppStop, RunningApp } from './serve.ts';
import type { MetricsStore, Metrics } from './metrics.ts';
import type { Receiver } from '../../tests/harness/receiver.ts';
import type { Channel, Event, Project, Run, UsageReading, WorkItem } from '../../service/protocol.ts';
import type { FeedbackWatch, Release } from '../../service/autonomy-types.ts';
import type { Verification } from '../../service/verification-types.ts';

/**
 * live 模式：同一套场景、同一套指标，换成真实的 Codex App 任务来跑。设计与负责人已经拍板的决定写在
 * `docs/acceptance/LIVE-MODE-PROPOSAL.md`。
 *
 * 这里只做编排。它自己**不**假设服务怎么起、时间怎么过、任务怎么列举：那些都在 `LiveDeps` 里，生产
 * 工厂 `productionDeps()` 提供真实实现，测试提供假实现——所以整条编排（参数校验、关联等待、预算、
 * 停止条件、清理顺序）能在不连真实 App、不消耗任何额度的情况下被测。
 *
 * 生产工厂负责三条硬约束：断言 `MORROW_TEST_MODE !== '1'`；不 import `tests/harness/env.ts`；
 * `startServer({ home, port: 0 })` 时**不传** `nativeTransport` 与 `reviewTransport`，不传才会走生产的
 * App follower 与官方 `codex exec` 只读复核。
 */

/** 人要做的准备写在这个文件里，`run` 拒绝没有它的目录。 */
export const preparedFile = 'prepared.json';
/** live 专属产物：绑定的任务、三道闸、额度读数、每一轮的真实耗时与工具清单、停止原因。 */
export const liveFile = 'live.json';

/** 用法错误（缺参数、目录不对、场景不符）。`run.ts` 把它映射成退出码 2。 */
export class LiveUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveUsageError';
  }
}

/** 第 6 节的表：只有运行本身出错才非零退出，模型的表现全部进指标。 */
export const stopExitCodes: Record<LiveStopReason, number> = {
  'timeline-finished': 0,
  'budget-exhausted': 0,
  'usage-blocked': 0,
  'needs-input': 0,
  'awaiting-approval': 0,
  'no-app-task': 1,
  'turn-timeout': 1,
  'thread-not-ready': 1,
  'restart-required': 1,
  'wall-clock': 1,
  error: 1,
};

export const stopLabels: Record<LiveStopReason, string> = {
  'timeline-finished': '时间线走完',
  'budget-exhausted': '--budget 用完',
  'usage-blocked': '项目额度上限或保留线阻断',
  'needs-input': '某一轮以 needs_input 结束',
  'awaiting-approval': '停在人工上线确认',
  'no-app-task': '没等到可用的 App 任务',
  'turn-timeout': '一轮超过 --turn-timeout',
  'thread-not-ready': '关联的 App 任务中途不再就绪',
  'restart-required': '检测到旧转接，需要重开 Codex App',
  'wall-clock': '墙钟超过 --wall-clock',
  error: '运行本身出错',
};

/** live 运行的三道闸与几个上限。`budget` 必填，没有缺省。 */
export type LiveOptions = {
  runId: string;
  /** 本次运行允许出现的 `morrow-schedule` 轮次总数。必填。 */
  budget: number;
  /** 项目额度上限：Morrow 归到本项目的估算用量。 */
  projectLimit?: number;
  projectWindow?: '5h' | 'weekly';
  /** 保留线：按精确账户读数判断，保护作者自己要用的额度。 */
  reserve?: number;
  reserveWindow?: '5h' | 'weekly';
  /** `advance N` 实际等 `N × advanceScale` 分钟；显式设 1 表示不压缩。 */
  advanceScale?: number;
  maxWaitMinutes?: number;
  waitBindMinutes?: number;
  turnTimeoutMinutes?: number;
  reviewTimeoutMinutes?: number;
  wallClockMinutes?: number;
  /** 产物目录；缺省 `artifacts/acceptance/<run-id>`，必须是 `prepare` 建好的那一个。 */
  out?: string;
};

export const liveDefaults = {
  projectLimit: 5,
  projectWindow: '5h' as const,
  reserve: 20,
  reserveWindow: 'weekly' as const,
  /** 决定 3：缺省压缩 10 倍（20 分钟压成 2 分钟），可显式设 1。 */
  advanceScale: 0.1,
  maxWaitMinutes: 10,
  waitBindMinutes: 10,
  turnTimeoutMinutes: 10,
  reviewTimeoutMinutes: 6,
  wallClockMinutes: 60,
};

export type LiveSettings = Required<Omit<LiveOptions, 'out'>> & { out: string };

/** 补齐缺省值，并把三道闸的取值固定下来，好让它们既能原样打印也能写进 `live.json`。 */
export function liveSettings(options: LiveOptions): LiveSettings {
  if (!Number.isInteger(options.budget) || options.budget < 1)
    throw new LiveUsageError('--budget 必填，且必须是不小于 1 的整数：一次 live 运行真的消耗账户额度。');
  if (!options.runId) throw new LiveUsageError('--run-id 必填；先用 prepare 建好目录再 run。');
  const scale = options.advanceScale ?? liveDefaults.advanceScale;
  if (!(scale > 0) || scale > 1) throw new LiveUsageError('--advance-scale 必须在 0 到 1 之间（1 表示不压缩）。');
  return {
    runId: options.runId,
    budget: options.budget,
    projectLimit: options.projectLimit ?? liveDefaults.projectLimit,
    projectWindow: options.projectWindow ?? liveDefaults.projectWindow,
    reserve: options.reserve ?? liveDefaults.reserve,
    reserveWindow: options.reserveWindow ?? liveDefaults.reserveWindow,
    advanceScale: scale,
    maxWaitMinutes: options.maxWaitMinutes ?? liveDefaults.maxWaitMinutes,
    waitBindMinutes: options.waitBindMinutes ?? liveDefaults.waitBindMinutes,
    turnTimeoutMinutes: options.turnTimeoutMinutes ?? liveDefaults.turnTimeoutMinutes,
    reviewTimeoutMinutes: options.reviewTimeoutMinutes ?? liveDefaults.reviewTimeoutMinutes,
    wallClockMinutes: options.wallClockMinutes ?? liveDefaults.wallClockMinutes,
    out: resolve(options.out || join(repoRoot, 'artifacts', 'acceptance', options.runId)),
  };
}

/** `prepared.json`：`prepare` 留给 `run` 的唯一交接。 */
export type Prepared = {
  scenario: string;
  scenarioVersion: string;
  runId: string;
  createdAt: string;
  root: string;
  /** 人要在 Codex App 里选的那个绝对目录。 */
  projectPath: string;
  files: number;
};

export type LiveDeps = {
  /** 起一个隔离服务并建好项目与频道；生产实现见 `productionDeps()`。 */
  startService(options: {
    home: string;
    projectPath: string;
    project: { name: string; goal: string; brief?: string };
  }): Promise<LiveSession>;
  clock: LiveClock;
  /** 打给人看的输出。 */
  log(text: string): void;
  freePort(): Promise<number>;
  startApp(
    spec: { args: string[]; ready?: string; probe?: string },
    options: { cwd: string; port: number }
  ): Promise<RunningApp>;
  startReceiver(options: { feedback?: unknown }): Promise<Receiver>;
};

export type InvariantReport = InvariantResult & { name: string };

/** `run.json` 在 live 模式下的内容；`metrics <runDir>` 靠它复现同一份 `config`。 */
export type LiveRunFacts = {
  runId: string;
  mode: 'live';
  scenario: string;
  scenarioVersion: string;
  /** live 模式里干策略这件事的是真实模型，所以策略名就是 `live`。 */
  policy: 'live';
  budget: { turns: number };
  wallMs: number;
};

export type LiveFacts = {
  runId: string;
  scenario: string;
  threadId: string;
  appVersion: string;
  runtimeVersion: string;
  connectionMode: string;
  /** 三道闸，原样记下来。 */
  gates: {
    budget: number;
    channelMaxRunsPerDay: number;
    projectUsageBudget: { window: string; limitPercent: number };
    usageReserve: { window: string; keepPercent: number };
    stopWhenUsageUnknown: true;
  };
  advanceScale: number;
  limits: {
    maxWaitMinutes: number;
    waitBindMinutes: number;
    turnTimeoutMinutes: number;
    reviewTimeoutMinutes: number;
    wallClockMinutes: number;
  };
  usageBefore: UsageReading | 'unknown';
  usageAfter: UsageReading | 'unknown';
  usageDelta: Record<string, number> | 'unknown';
  /** 每一轮的真实起止与耗时，加上这一轮 `native_items` 里出现过的工具类型清单。 */
  turns: LiveRunner['turns'];
  /** 每个时间线步骤的真实起止与耗时。 */
  steps: Array<{ index: number; verb: string; startedAt: string; finishedAt: string; wallMs: number }>;
  spentTurns: number;
  remainingSteps: number;
  stop: { reason: LiveStopReason; label: string; detail: string; exitCode: number };
  /** 关联前的两条断言，和 `scripts/probe-app-follower.ts` 一样。 */
  guards: { createCapability: boolean | 'unknown'; unboundRunStatus: number | 'unknown' };
};

export type LiveResult = {
  ok: boolean;
  exitCode: number;
  runId: string;
  scenario: string;
  out: string;
  stop: { reason: LiveStopReason; detail: string };
  turns: number;
  timeline: TimelineRecord[];
  labels: Labels;
  metrics?: Metrics;
  invariants: InvariantReport[];
  app?: ServedApp;
  live: LiveFacts;
  failures: string[];
  summary: string;
};

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** live 运行期间作者自己的自主频道先暂停；runner 跨不了数据目录，只能提醒。 */
export const pauseOwnChannelsReminder = [
  '步骤 0（人要先做）：暂停你自己安装版 Morrow 里的自主频道。',
  'runner 只能在自己的隔离数据目录里工作，管不到你的正式数据目录；但两者会抢同一个账号的额度，也会抢同一个 App 的任务并发。',
].join('\n');

/**
 * 第一步：建目录、写种子、留下 `prepared.json`，再把人要做的四步用绝对路径打出来，然后退出。
 * 两步调用（决定 2）让"目录已经被别的运行覆盖"不可能发生，也不要求人守在终端边上等。
 */
export function prepareLive(
  scenario: Scenario,
  options: { runId?: string; out?: string; budget?: number } = {},
  log: (text: string) => void = console.log
): Prepared {
  const runId = options.runId || `${scenario.id}-live-${stamp()}-${randomUUID().slice(0, 8)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId))
    throw new LiveUsageError(`--run-id 只能用字母、数字、点、下划线和连字符，且不能以符号开头：${runId}`);
  const root = resolve(options.out || join(repoRoot, 'artifacts', 'acceptance', runId));
  if (existsSync(join(root, 'home')))
    throw new LiveUsageError(`${root} 已经有 home/：这个 run-id 跑过了。换一个 --run-id，现场不要覆盖。`);
  if (existsSync(join(root, preparedFile)))
    throw new LiveUsageError(
      `${join(root, preparedFile)} 已经存在：这个 run-id 已经准备过了，直接 run，或换一个 --run-id。`
    );
  const projectPath = join(root, 'project');
  mkdirSync(projectPath, { recursive: true });
  const files = scenario.project.seedDir ? readTree(scenario.project.seedDir) : scenario.project.files || {};
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(projectPath, name)), { recursive: true });
    writeFileSync(join(projectPath, name), text);
  }
  const prepared: Prepared = {
    scenario: scenario.id,
    scenarioVersion: scenario.version,
    runId,
    createdAt: new Date().toISOString(),
    root,
    projectPath,
    files: Object.keys(files).length,
  };
  writeFileSync(join(root, preparedFile), JSON.stringify(prepared, null, 2) + '\n');
  log(
    [
      pauseOwnChannelsReminder,
      '',
      `已准备 live 运行 ${runId}（场景 ${scenario.id}，种子 ${prepared.files} 个文件）。`,
      `产物目录：${root}`,
      '',
      '接下来人要做四步：',
      '1. 打开 Codex App，新建一个任务，目录选：',
      `     ${projectPath}`,
      '2. 在这个任务里发一条首条消息（例如「准备好了」），等它回完。',
      '3. 保持这个任务打开，不要关闭窗口，也不要在它里面继续手动提问。',
      '4. 回到终端执行（`--budget` 必填，没有缺省）：',
      `     npm run acceptance -- run ${scenario.id} --mode live --run-id ${runId} --budget ${options.budget ?? 3}`,
      '',
      'runner 会自己发现并关联那个任务；关联前会先断言 capabilities.create === false，以及未关联时启动一轮返回 409。',
    ].join('\n')
  );
  return prepared;
}

/** `run` 只接受 `prepare` 建好、还没跑过的目录，而且场景要对得上。 */
export function readPrepared(out: string, scenario: Scenario, runId: string): Prepared {
  const file = join(out, preparedFile);
  if (!existsSync(file))
    throw new LiveUsageError(
      `${out} 里没有 ${preparedFile}：live 运行分两步。先执行 npm run acceptance -- prepare ${scenario.id} --mode live`
    );
  if (existsSync(join(out, 'home')))
    throw new LiveUsageError(`${out} 已经有 home/：这个 run-id 跑过了，现场不要覆盖。换一个 --run-id 重新 prepare。`);
  const prepared = JSON.parse(readFileSync(file, 'utf8')) as Prepared;
  if (prepared.scenario !== scenario.id)
    throw new LiveUsageError(`${file} 准备的是场景 ${prepared.scenario}，不是 ${scenario.id}。`);
  if (prepared.runId !== runId) throw new LiveUsageError(`${file} 准备的是 run-id ${prepared.runId}，不是 ${runId}。`);
  if (!existsSync(prepared.projectPath))
    throw new LiveUsageError(`${prepared.projectPath} 不存在：重新 prepare 一次。`);
  return prepared;
}

/**
 * 一次 live 运行。返回值里带退出码：只有运行本身出错才非零（决定 4），模型的表现全部作为指标报告。
 */
export async function runLive(
  scenario: Scenario,
  options: LiveOptions,
  deps: LiveDeps = productionDeps()
): Promise<LiveResult> {
  const settings = liveSettings(options);
  const prepared = readPrepared(settings.out, scenario, settings.runId);
  const out = settings.out;
  const startedAt = deps.clock.now();
  const failures: string[] = [];
  const timeline: TimelineRecord[] = [];
  const steps: LiveFacts['steps'] = [];
  const labels: Labels = { staleMemoryIds: [], truth: [], planted: scenario.planted };
  let invariants: InvariantReport[] = [];
  let metrics: Metrics | undefined;
  let session: LiveSession | undefined;
  let app: RunningApp | undefined;
  let runner: LiveRunner | undefined;
  /** 报告要给出每条发现的原文，所以在关服务之前把事项读出来。 */
  let items: ItemView[] = [];
  /** 算一次，指标和 `run.json` 用同一份，否则 `metrics <运行目录>` 会得到不同的 `wallMs`。 */
  let runFacts: LiveRunFacts | undefined;
  let stop: { reason: LiveStopReason; detail: string } = { reason: 'error', detail: '运行还没有走到任何停止条件' };
  const live: LiveFacts = {
    runId: settings.runId,
    scenario: scenario.id,
    threadId: '',
    appVersion: '',
    runtimeVersion: '',
    connectionMode: '',
    gates: {
      budget: settings.budget,
      // 复核与轮次共用频道的 UTC 日预算，所以上限要盖住两者。
      channelMaxRunsPerDay: settings.budget * 2,
      projectUsageBudget: { window: settings.projectWindow, limitPercent: settings.projectLimit },
      usageReserve: { window: settings.reserveWindow, keepPercent: settings.reserve },
      stopWhenUsageUnknown: true,
    },
    advanceScale: settings.advanceScale,
    limits: {
      maxWaitMinutes: settings.maxWaitMinutes,
      waitBindMinutes: settings.waitBindMinutes,
      turnTimeoutMinutes: settings.turnTimeoutMinutes,
      reviewTimeoutMinutes: settings.reviewTimeoutMinutes,
      wallClockMinutes: settings.wallClockMinutes,
    },
    usageBefore: 'unknown',
    usageAfter: 'unknown',
    usageDelta: 'unknown',
    turns: [],
    steps,
    spentTurns: 0,
    remainingSteps: scenario.timeline.length,
    stop: { reason: 'error', label: stopLabels.error, detail: '', exitCode: 1 },
    guards: { createCapability: 'unknown', unboundRunStatus: 'unknown' },
  };
  const cleanup = {
    app: undefined as undefined | ({ url: string; pid?: number } & Partial<AppStop> & { note?: string }),
    threadId: '',
    /** 有意为之：绑定留着，事后要能在 App 里打开那条任务逐条看模型真的做了什么。 */
    unbound: false,
    channelsPaused: 0,
    serviceClosed: false,
    /** 现场只有这一份，不删。 */
    directoriesRemoved: false,
    keep: true,
    root: out,
    usageAfter: 'unknown' as UsageReading | 'unknown',
    notes: [] as string[],
  };

  deps.log(
    [
      pauseOwnChannelsReminder,
      '',
      `live 运行 ${settings.runId}（场景 ${scenario.id} v${prepared.scenarioVersion}）。三道闸：`,
      `- 轮次上限 --budget ${settings.budget}（频道 maxRunsPerDay 设为 ${settings.budget * 2}，复核与轮次共用日预算）`,
      `- 项目额度上限 --project-limit ${settings.projectLimit}% / --project-window ${settings.projectWindow}`,
      `- 保留线 --reserve ${settings.reserve}% / --reserve-window ${settings.reserveWindow}，并置 stopWhenUsageUnknown: true`,
      `- 观察窗口缩放 --advance-scale ${settings.advanceScale}；单个 advance 最多真实等待 ${settings.maxWaitMinutes} 分钟`,
      `- 上限：--wait-bind ${settings.waitBindMinutes} · --turn-timeout ${settings.turnTimeoutMinutes} · --review-timeout ${settings.reviewTimeoutMinutes} · --wall-clock ${settings.wallClockMinutes}（分钟）`,
      `- 不实现 --allow-approve：时间线走到 approve 就打印发布信息、暂停频道、以「停在人工确认」结束。`,
      '',
    ].join('\n')
  );

  const receiver = await deps.startReceiver({ feedback: scenario.feedback.initial });
  try {
    const appUrl = scenario.project.serve ? `http://127.0.0.1:${await deps.freePort()}` : undefined;
    const brief =
      scenario.brief === undefined
        ? undefined
        : projectBrief(scenario.brief, {
            ...(appUrl ? { appUrl } : {}),
            usageUrl: usageURL(scenario, receiver.url),
          });
    session = await deps.startService({
      home: join(out, 'home'),
      projectPath: prepared.projectPath,
      project: { name: scenario.title, goal: scenario.goal, ...(brief === undefined ? {} : { brief }) },
    });
    if (scenario.project.serve && appUrl)
      app = await deps.startApp(scenario.project.serve, {
        cwd: prepared.projectPath,
        port: Number(new URL(appUrl).port),
      });

    // 关联前的两条断言，照 scripts/probe-app-follower.ts：Morrow 不能创建 App 任务，未关联就启动会被拒。
    const first = await session.nativeStatus();
    live.guards.createCapability = first.capabilities.create;
    const unbound = await session.runUnbound();
    live.guards.unboundRunStatus = unbound;
    if (first.capabilities.create !== false || unbound !== 409)
      throw new LiveStop(
        'error',
        `关联前的断言不成立（capabilities.create=${first.capabilities.create}，未关联时 run 返回 ${unbound}，应当是 false 与 409）；不继续消耗额度`
      );

    await session.setChannelBudget(live.gates.channelMaxRunsPerDay);
    await session.setProjectBudget(live.gates.projectUsageBudget);
    await session.setReserve(live.gates.usageReserve, true);
    live.usageBefore = ((await session.readUsage()) as UsageReading | undefined) ?? 'unknown';
    labels.staleMemoryIds = await session.seedMemory(scenario.memory);

    const threadId = await waitForThread(scenario, prepared, session, deps, settings);
    live.threadId = cleanup.threadId = threadId;
    await session.bind(threadId);
    const ready = await waitForReady(session, deps, settings);
    live.appVersion = ready.appVersion || '';
    live.runtimeVersion = ready.runtimeVersion || '';
    live.connectionMode = ready.connectionMode || '';
    deps.log(
      `已关联 App 任务 ${threadId}（connectionMode=${live.connectionMode || '未知'}，App ${live.appVersion || '版本未知'}，运行时 ${live.runtimeVersion || '版本未知'}）。`
    );

    // 直接置开关：`action(id,'resume')` 会立刻开一轮不在时间线里的轮次。
    session.enableControl();
    runner = {
      scenario,
      session,
      receiver,
      clock: deps.clock,
      log: deps.log,
      limits: {
        turnTimeoutMs: settings.turnTimeoutMinutes * 60_000,
        reviewTimeoutMs: settings.reviewTimeoutMinutes * 60_000,
        maxWaitMs: settings.maxWaitMinutes * 60_000,
        advanceScale: settings.advanceScale,
        wallClockEnd: startedAt + settings.wallClockMinutes * 60_000,
      },
      budget: settings.budget,
      // 关联 App 任务会把它的历史同步进来；那些轮次不属于本次运行，不计预算也不当结果。
      baseline: new Set(session.runs().flatMap((row) => (row.source === 'morrow-schedule' ? [row.id] : []))),
      seen: new Set<string>(),
      turns: live.turns,
    };

    stop = { reason: 'timeline-finished', detail: '时间线全部走完' };
    for (const [index, step] of scenario.timeline.entries()) {
      const from = deps.clock.now();
      try {
        const record = await runLiveStep(runner, step, index);
        timeline.push(record);
        if (step.verb === 'set' && step.truth)
          labels.truth.push({ stepIndex: index, truth: step.truth, virtualTime: record.virtualTime });
      } catch (error) {
        timeline.push({
          index,
          verb: step.verb,
          args: step as unknown as Record<string, unknown>,
          virtualTime: new Date(deps.clock.now()).toISOString(),
          result: { error: message(error) },
        });
        steps.push(stepFacts(index, step.verb, from, deps.clock.now()));
        if (error instanceof LiveStop) {
          stop = { reason: error.reason, detail: error.detail };
          if (stopExitCodes[error.reason] !== 0) failures.push(`step ${index}（${step.verb}）：${error.detail}`);
        } else {
          stop = { reason: 'error', detail: message(error) };
          failures.push(`step ${index}（${step.verb}）：${message(error)}`);
        }
        break;
      }
      steps.push(stepFacts(index, step.verb, from, deps.clock.now()));
      live.remainingSteps = scenario.timeline.length - (index + 1);
      if (runner.stop) {
        stop = runner.stop;
        break;
      }
    }
    if (stop.reason === 'timeline-finished') live.remainingSteps = 0;
    live.spentTurns = runner.seen.size;

    invariants = scenario.invariants.map((row) => ({
      name: row.name,
      ...safeCheck(row, {
        store: session!.store,
        service: { path: prepared.projectPath, home: session!.home },
        // live 下没有 ScriptedNativeTransport；每轮的 morrow-next 结论来自真实的审计事件。
        transport: {
          turns: live.turns.map((turn) => ({ decision: turn.decision })),
          reviews: session!.reviewStatuses().length,
          acknowledgements: 0,
          calls: [],
        },
        receiver,
        timeline,
        ...(app ? { app: { url: app.url, ...(app.probe === undefined ? {} : { probe: app.probe }) } } : {}),
      }),
    }));
  } catch (error) {
    if (error instanceof LiveStop) {
      stop = { reason: error.reason, detail: error.detail };
      if (stopExitCodes[error.reason] !== 0) failures.push(error.detail);
    } else {
      stop = { reason: 'error', detail: message(error) };
      failures.push(message(error));
    }
  } finally {
    // 第 7 节的清理，顺序固定：种子应用先 SIGTERM，暂停频道，不解绑、不删目录，指标在服务还开着时算。
    if (app) {
      const stopped = await app.stop().catch((error) => ({ stopped: false, note: message(error) }));
      cleanup.app = { url: app.url, ...(app.pid === undefined ? {} : { pid: app.pid }), ...stopped };
    }
    if (session) {
      cleanup.channelsPaused = await pauseChannels(session, failures);
      live.usageAfter = cleanup.usageAfter =
        ((await session.readUsage().catch(() => undefined)) as UsageReading | undefined) ?? 'unknown';
      live.usageDelta = usageDelta(live.usageBefore, live.usageAfter);
      cleanup.notes.push('绑定有意保留：事后要能在 Codex App 里打开这条任务逐条核对模型真的做了什么。');
      cleanup.notes.push('未向原任务发别的停止请求：CLI 复核如果是未知结局，按 0.9.5 的约定保持未知。');
      cleanup.notes.push('home/ 与 project/ 原样留在产物目录里，这是唯一一份现场。');
      runFacts = facts(scenario, settings, startedAt, deps.clock.now());
      try {
        metrics = computeMetrics({
          home: session.home,
          store: session.store,
          labels,
          // 决定 6：不从 events 重建 calls.jsonl，`repeatedFailures` 在 live 下保持 unknown。
          timeline,
          run: runFacts,
        });
      } catch (error) {
        failures.push(`metrics failed: ${message(error)}`);
      }
      items = session.items();
      await session.close().catch((error) => failures.push(`关闭服务失败：${message(error)}`));
      cleanup.serviceClosed = true;
    }
    await receiver.close().catch(() => {});
  }

  const exitCode = failures.length && stopExitCodes[stop.reason] === 0 ? 1 : stopExitCodes[stop.reason];
  live.stop = { reason: stop.reason, label: stopLabels[stop.reason], detail: stop.detail, exitCode };
  const result: LiveResult = {
    ok: exitCode === 0,
    exitCode,
    runId: settings.runId,
    scenario: scenario.id,
    out,
    stop,
    turns: live.turns.length,
    timeline,
    labels,
    ...(metrics ? { metrics } : {}),
    invariants,
    ...(app ? { app: { url: app.url, ...(app.probe === undefined ? {} : { probe: app.probe }) } } : {}),
    live,
    failures,
    summary: '',
  };
  result.summary = liveSummary(scenario, result, settings, items);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'timeline.jsonl'), lines(timeline));
  writeFileSync(join(out, 'labels.json'), JSON.stringify(labels, null, 2) + '\n');
  writeFileSync(
    join(out, 'run.json'),
    JSON.stringify(runFacts ?? facts(scenario, settings, startedAt, deps.clock.now()), null, 2) + '\n'
  );
  writeFileSync(join(out, liveFile), JSON.stringify(live, null, 2) + '\n');
  writeFileSync(join(out, 'cleanup.json'), JSON.stringify(cleanup, null, 2) + '\n');
  if (metrics) writeMetrics(out, metrics);
  writeFileSync(join(out, 'summary.md'), result.summary);
  return result;
}

const stepFacts = (index: number, verb: string, from: number, to: number) => ({
  index,
  verb,
  startedAt: new Date(from).toISOString(),
  finishedAt: new Date(to).toISOString(),
  wallMs: to - from,
});

/**
 * 等到**恰好一个** cwd 与项目目录相符的 App 任务：0 个继续等，多于一个就中止并把候选列出来。自动挑
 * 一个会让「我们测的是哪个任务」变得不可知。
 */
async function waitForThread(
  scenario: Scenario,
  prepared: Prepared,
  session: LiveSession,
  deps: LiveDeps,
  settings: LiveSettings
): Promise<string> {
  deps.log(
    [
      'Morrow 不能创建 App 任务（capabilities.create 恒为 false），所以这一步要人开头。如果还没做：',
      '1. 打开 Codex App，新建一个任务，目录选：',
      `     ${prepared.projectPath}`,
      '2. 在这个任务里发一条首条消息（例如「准备好了」），等它回完。',
      '3. 保持这个任务打开，不要关闭窗口，也不要在它里面继续手动提问。',
      '4. 留在这个终端；runner 会自己发现并关联它。',
      '',
      `等待中：每 ${bindPollMs / 1000} 秒检查一次，最多等 ${settings.waitBindMinutes} 分钟。`,
    ].join('\n')
  );
  const end = deps.clock.now() + settings.waitBindMinutes * 60_000;
  for (;;) {
    const threads = await session.listThreads().catch(() => []);
    if (threads.length === 1) return threads[0].id;
    if (threads.length > 1)
      throw new LiveStop(
        'no-app-task',
        [
          `项目目录下有 ${threads.length} 个 App 任务，无法确定测的是哪一个。请只保留一个，再重新 run：`,
          ...threads.map((row) => `  - ${row.id} · ${row.title || '（无标题）'} · 更新于 ${row.updatedAt || '未知'}`),
        ].join('\n')
      );
    if (deps.clock.now() >= end)
      throw new LiveStop(
        'no-app-task',
        `等了 ${settings.waitBindMinutes} 分钟也没有在 ${prepared.projectPath} 下看到 App 任务（场景 ${scenario.id}）`
      );
    await deps.clock.sleep(bindPollMs);
  }
}

/** 只看 `connected` 不够：`readyThreadCount` 数的是「这个任务真的加载好了」。 */
async function waitForReady(session: LiveSession, deps: LiveDeps, settings: LiveSettings): Promise<NativeStatusView> {
  const end = deps.clock.now() + settings.waitBindMinutes * 60_000;
  let last: NativeStatusView | undefined;
  for (;;) {
    last = await session.nativeStatus();
    if (last.restartRequired)
      throw new LiveStop('restart-required', `检测到旧转接：${last.detail || '请在当轮结束后重开 Codex App'}`);
    if (last.connected && last.boundThreadCount === 1 && last.readyThreadCount === 1) return last;
    if (deps.clock.now() >= end)
      throw new LiveStop(
        'no-app-task',
        `关联后 ${settings.waitBindMinutes} 分钟内没有等到就绪：connected=${last.connected} boundThreadCount=${last.boundThreadCount ?? '未知'} readyThreadCount=${last.readyThreadCount ?? '未知'}；${last.detail || '无说明'}`
      );
    await deps.clock.sleep(bindPollMs);
  }
}

async function pauseChannels(session: LiveSession, failures: string[]) {
  try {
    await session.pause();
    await session.drain();
    return 1;
  } catch (error) {
    failures.push(`暂停频道失败：${message(error)}`);
    return 0;
  }
}

function usageDelta(
  before: UsageReading | 'unknown',
  after: UsageReading | 'unknown'
): Record<string, number> | 'unknown' {
  if (before === 'unknown' || after === 'unknown') return 'unknown';
  const delta: Record<string, number> = {};
  for (const window of after.windows) {
    const start = before.windows.find((row) => row.name === window.name);
    if (start) delta[window.name] = Math.round((window.usedPercent - start.usedPercent) * 100) / 100;
  }
  return delta;
}

function facts(scenario: Scenario, settings: LiveSettings, from: number, to: number): LiveRunFacts {
  return {
    runId: settings.runId,
    mode: 'live',
    scenario: scenario.id,
    scenarioVersion: scenario.version,
    policy: 'live',
    budget: { turns: settings.budget },
    wallMs: to - from,
  };
}

function safeCheck(row: { check(context: any): InvariantResult }, context: any): InvariantResult {
  try {
    return row.check(context);
  } catch (error) {
    return { ok: false, detail: `invariant threw: ${message(error)}` };
  }
}

/**
 * live 的 `summary.md`。三件事必须在里面：固定标注（这是隔离环境下的模型验证，不是真实业务效果）、
 * 观察窗口的压缩比例，以及每条发现的原文——发现率是文本匹配得出的下限判据，不是人工评分。
 */
function liveSummary(scenario: Scenario, result: LiveResult, settings: LiveSettings, items: ItemView[]): string {
  const verbs = new Map<string, number>();
  for (const row of result.timeline) verbs.set(row.verb, (verbs.get(row.verb) || 0) + 1);
  const live = result.live;
  return [
    `# ${scenario.title}（${scenario.id}）· live`,
    '',
    liveNotice,
    '',
    ...scaleNote(settings.advanceScale),
    '',
    `- 模式：live · 策略：live（干这件事的是真实模型）· 场景版本：${scenario.version}`,
    `- 停止原因：${stopLabels[result.stop.reason]}（${result.stop.reason}）· 退出码 ${result.exitCode}`,
    `- 说明：${result.stop.detail}`,
    `- 轮次：${live.spentTurns}/${settings.budget}（--budget）· 时间线步骤：${result.timeline.length}/${scenario.timeline.length}，剩余 ${live.remainingSteps} 步未执行`,
    `- 三道闸：--budget ${settings.budget}（频道 maxRunsPerDay ${live.gates.channelMaxRunsPerDay}）· 项目额度 ${settings.projectLimit}%/${settings.projectWindow} · 保留线 ${settings.reserve}%/${settings.reserveWindow}（stopWhenUsageUnknown: true）`,
    `- 关联：任务 ${live.threadId || '未关联'} · connectionMode ${live.connectionMode || '未知'} · App ${live.appVersion || '未知'} · 运行时 ${live.runtimeVersion || '未知'}`,
    `- 关联前断言：capabilities.create=${live.guards.createCapability} · 未关联时 run 返回 ${live.guards.unboundRunStatus}`,
    `- 账户额度：运行前 ${reading(live.usageBefore)} → 运行后 ${reading(live.usageAfter)} · 差值 ${live.usageDelta === 'unknown' ? 'unknown' : JSON.stringify(live.usageDelta)}`,
    `- 步骤分布：${[...verbs].map(([verb, count]) => `${verb}×${count}`).join('、') || '无'}`,
    ...(result.app ? [`- 种子应用：${result.app.url}（本次运行期间真实运行，结束时已停止）`] : []),
    `- 产物目录：${result.out}（home/ 与 project/ 原样保留；绑定未解除）`,
    '',
    '## 每一轮',
    '',
    ...(live.turns.length
      ? [
          '| 轮次 | 状态 | morrow-next | 真实耗时 | 模型 | 出现过的工具类型 |',
          '| --- | --- | --- | --- | --- | --- |',
          ...live.turns.map(
            (turn, index) =>
              `| ${index + 1} | ${turn.status}${turn.reportStatus ? `/${turn.reportStatus}` : ''} | ${turn.decision} | ${Math.round(turn.wallMs / 1000)}s | ${turn.model || '未记录'} | ${turn.tools.join('、') || '无记录'} |`
          ),
          '',
        ]
      : ['- 没有轮次真实跑起来。', '']),
    '## Invariants（逐条评估，但不决定退出码）',
    '',
    'live 模式下这些条目从「应当为真的断言」变成「被测量的对象」：某一条不成立正是我们想知道的结果。',
    '',
    ...(result.invariants.length
      ? result.invariants.map((row) => `- ${row.ok ? 'PASS' : 'FAIL'} ${row.name} — ${row.detail}`)
      : ['- 未执行（运行在时间线之前就停下了）']),
    '',
    ...metricsSection(result.metrics, 'live'),
    ...findingsSection(result.labels, items),
    ...(result.failures.length ? ['## 失败原因', '', ...result.failures.map((row) => `- ${row}`), ''] : []),
  ].join('\n');
}

const reading = (value: UsageReading | 'unknown') =>
  value === 'unknown'
    ? 'unknown'
    : value.windows.map((row) => `${row.name} ${row.usedPercent}%`).join(' / ') || '无窗口';

/**
 * 生产 deps：真实时钟、真实等待、真实服务。断言放在这里，不放在编排核心里，测试才能用假依赖跑编排。
 */
export function productionDeps(): LiveDeps {
  return {
    startService: startLiveService,
    clock: {
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
    },
    log: (text) => console.log(text),
    freePort,
    startApp,
    startReceiver,
  };
}

/**
 * 一个隔离服务加一个项目，走生产的 App follower 与官方 `codex exec` 只读复核：`startServer` 时**不传**
 * `nativeTransport`，也**不传** `reviewTransport`。不 import `tests/harness/env.ts`；那个模块在 import
 * 时就设 `MORROW_TEST_MODE=1`，会让 `NativeConversations` 构造桌面夹具 transport。
 */
async function startLiveService(options: {
  home: string;
  projectPath: string;
  project: { name: string; goal: string; brief?: string };
}): Promise<LiveSession> {
  if (process.env.MORROW_TEST_MODE === '1')
    throw new Error(
      'live 模式拒绝在 fixture 测试模式下启动：MORROW_TEST_MODE=1 会让服务构造桌面夹具 transport，而不是生产的 App follower。'
    );
  const { startServer } = await import('../../service/server.ts');
  let current = await startServer({ home: options.home, port: 0 });
  const token = readFileSync(join(current.home, 'token'), 'utf8').trim();
  const request = async (method: string, route: string, body?: unknown, auth = token) => {
    const response = await fetch(`http://127.0.0.1:${current.port}${route}`, {
      method,
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const api = async (method: string, route: string, body?: unknown, status = 200, auth = token) => {
    const result = await request(method, route, body, auth);
    if (result.status !== status)
      throw new Error(`${method} ${route} 返回 ${result.status}（期望 ${status}）：${JSON.stringify(result.body)}`);
    return result.body;
  };
  let projectId = '';
  let channelId = '';
  try {
    const project = (await api(
      'POST',
      '/api/projects',
      {
        name: options.project.name,
        path: options.projectPath,
        goal: options.project.goal,
        ...(options.project.brief === undefined ? {} : { brief: options.project.brief }),
      },
      201
    )) as Project;
    projectId = project.id;
    const channel = current.store.all<Channel>('channels').find((row) => row.projectId === projectId);
    if (!channel) throw new Error('新项目没有默认频道');
    channelId = channel.id;
  } catch (error) {
    await current.close().catch(() => {});
    throw error;
  }
  const store: MetricsStore = {
    all: (table) => current.store.all(table),
    get: (table, id) => current.store.get(table, id),
  };
  const channelRow = () => current.store.get<Channel>('channels', channelId)!;
  const runRows = () => current.store.all<Run>('runs').filter((row) => row.channelId === channelId);
  const verifications = () => current.store.all<Verification>('loop_verifications');
  const view = (row: Run): RunView => ({
    id: row.id,
    ...(row.source === undefined ? {} : { source: row.source }),
    status: row.status,
    ...(row.reportStatus === undefined ? {} : { reportStatus: row.reportStatus }),
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    ...(row.nativeTurnId === undefined ? {} : { nativeTurnId: row.nativeTurnId }),
    ...(row.permission === undefined ? {} : { permission: row.permission }),
    ...(row.model ? { model: row.model } : {}),
    ...(row.startedAt ? { startedAt: row.startedAt } : {}),
    ...(row.finishedAt ? { finishedAt: row.finishedAt } : {}),
  });
  const session: LiveSession = {
    home: current.home,
    projectPath: options.projectPath,
    projectId,
    channelId,
    store,
    nativeStatus: async () => {
      const status = await current.native.status();
      return {
        connected: status.connected,
        ...(status.connectionMode === undefined ? {} : { connectionMode: status.connectionMode }),
        ...(status.boundThreadCount === undefined ? {} : { boundThreadCount: status.boundThreadCount }),
        ...(status.readyThreadCount === undefined ? {} : { readyThreadCount: status.readyThreadCount }),
        ...(status.restartRequired === undefined ? {} : { restartRequired: status.restartRequired }),
        ...(status.appVersion === undefined ? {} : { appVersion: status.appVersion }),
        ...(status.runtimeVersion === undefined ? {} : { runtimeVersion: status.runtimeVersion }),
        detail: status.detail,
        capabilities: { create: status.capabilities.create },
      };
    },
    runUnbound: async () => (await request('POST', `/api/channels/${channelId}/action`, { action: 'run' })).status,
    listThreads: async () => {
      const listed = await current.native.list(channelId);
      return listed.threads.map((row: any) => ({
        id: row.id,
        ...(row.title === undefined ? {} : { title: row.title }),
        ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
        ...(row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt }),
      }));
    },
    bind: async (threadId) => {
      await current.native.bind(channelId, threadId);
    },
    interrupt: async (turnId) => {
      await current.native.interrupt(channelId, turnId);
    },
    setChannelBudget: async (maxRunsPerDay) => {
      await api('PATCH', `/api/channels/${channelId}`, { maxRunsPerDay });
    },
    setProjectBudget: async (usageBudget) => {
      await api('PATCH', `/api/projects/${projectId}/usage-budget`, { usageBudget });
    },
    setReserve: async (usageReserve, stopWhenUsageUnknown) => {
      await api('PATCH', '/api/settings', { usageReserve, stopWhenUsageUnknown });
    },
    readUsage: () => current.engine.usage.refresh(),
    seedMemory: async (seeds: MemorySeed[]) => {
      if (!seeds.length) return [];
      // `native-app` 让这次预置不占频道的日调度预算。
      const grant = grantFor(
        { store: current.store, engine: current.engine, home: current.home, api: api as any },
        { projectId, channelId, overrides: { source: 'native-app', summary: '场景预置记忆' } }
      );
      const stale: string[] = [];
      for (const seed of seeds) {
        const row = await grant.call(seed.operation, seed.input);
        if (seed.stale && typeof row?.id === 'string') stale.push(row.id);
      }
      current.store.put('runs', {
        ...(current.store.get<Run>('runs', grant.run.id) as Run),
        status: 'completed',
        finishedAt: new Date().toISOString(),
      });
      return stale;
    },
    enableControl: () => {
      current.engine.setControl(channelId, { enabled: true });
      current.store.put('channels', { ...channelRow(), status: 'waiting' });
    },
    makeDue: () => {
      current.store.put('channels', {
        ...channelRow(),
        status: 'waiting',
        nextRunAt: new Date(Date.now() - 1000).toISOString(),
      });
    },
    channel: () => {
      const row = channelRow();
      return {
        status: row.status,
        nextRunAt: row.nextRunAt,
        maxRunsPerDay: row.maxRunsPerDay,
        runsToday: current.store.runCount(channelId, new Date().toISOString().slice(0, 10)),
        ...(row.usageWait === undefined ? {} : { usageWait: row.usageWait }),
        ...(row.work === undefined ? {} : { work: row.work }),
      };
    },
    runs: () => runRows().map(view),
    turnTools: (run) => {
      if (!run.sessionId || !run.nativeTurnId) return [];
      const types = new Set<string>();
      for (const row of current.store.nativeRows<any>('native_items', run.sessionId)) {
        if (row.turnId !== run.nativeTurnId) continue;
        types.add(String(row.type));
        if (row.raw?.tool) types.add(`${row.type}:${row.raw.tool}`);
        if (row.raw?.server) types.add(`${row.type}:${row.raw.server}`);
      }
      return [...types].sort();
    },
    turnDecision: (runId) => {
      const event = current.store
        .all<Event>('events')
        .filter((row) => row.runId === runId && row.action === 'channel.next-step')
        .at(-1);
      const state = (event?.changes?.after as { state?: unknown } | undefined)?.state;
      return typeof state === 'string' ? state : 'none';
    },
    pollWatches: async () => {
      const before = current.store.all('loop_evidence').length;
      const live = current.store
        .all<FeedbackWatch>('loop_watches')
        .filter((row) => row.status !== 'cancelled' && (row.status === 'watching' || row.continuous !== false));
      for (const watch of live) await current.engine.loop.poll(watch.id);
      await session.drain();
      return {
        polled: live.length,
        evidence: current.store.all('loop_evidence').length - before,
        statuses: live.map((row) => current.store.get<FeedbackWatch>('loop_watches', row.id)?.status),
      };
    },
    pendingReviews: () => verifications().filter((row) => ['queued', 'running'].includes(row.status)).length,
    reviewStatuses: () => verifications().map((row) => row.status),
    pendingRelease: () => {
      const row = current.store
        .all<Release>('loop_releases')
        .filter((release) => release.status === 'awaiting_approval')
        .at(-1);
      return row
        ? {
            id: row.id,
            title: row.title,
            status: row.status,
            reviewHash: row.reviewHash,
            itemIds: row.itemIds,
            changes: row.changes,
            artifact: row.artifact,
          }
        : undefined;
    },
    guide: async (text) => {
      const receipt = await api('POST', `/api/channels/${channelId}/native/messages`, {
        text,
        requestId: randomUUID(),
      });
      return { state: receipt?.state };
    },
    pause: async () => {
      await current.engine.action(channelId, 'pause');
    },
    resume: () => {
      current.engine.setControl(channelId, { enabled: true });
      current.store.put('channels', { ...channelRow(), status: 'waiting' });
    },
    restart: async () => {
      await session.drain();
      await current.close();
      current = await startServer({ home: options.home, port: 0 });
    },
    items: () =>
      current.store.all<WorkItem>('items').map((row) => ({
        id: row.id,
        title: row.title,
        summary: row.summary,
        nextStep: row.nextStep,
        kind: row.kind,
        status: row.status,
        evidence: row.evidence || [],
      })),
    drain: async () => {
      const loop = current.engine.loop;
      for (let pass = 0; pass < 20 && loop.pending.size; pass++) await Promise.allSettled([...loop.pending]);
    },
    close: () => current.close(),
  };
  return session;
}

const lines = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const stamp = () => new Date().toISOString().replaceAll(':', '-').replace('.', '-');
