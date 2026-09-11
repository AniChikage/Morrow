import './harness/env.ts';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineScenario, invariant } from '../scripts/acceptance/scenario.ts';
import { prepareLive, productionDeps, runLive, stopExitCodes } from '../scripts/acceptance/live.ts';
import type { LiveDeps, LiveOptions, LiveResult } from '../scripts/acceptance/live.ts';
import type {
  ItemView,
  LiveSession,
  NativeStatusView,
  RunView,
  ThreadCandidate,
} from '../scripts/acceptance/timeline.ts';
import type { Receiver } from './harness/receiver.ts';
import type { RunningApp } from '../scripts/acceptance/serve.ts';
import type { Scenario, Step } from '../scripts/acceptance/scenario.ts';

/**
 * live 模式的编排自检。**绝不连真实的 Codex App，也绝不消耗任何额度**：整条编排跑在注入的假依赖
 * 上（假服务、假时钟、假任务列举、假种子应用），真实的那套实现只在 `productionDeps()` 里，这里只
 * 验证它在 fixture 测试模式下拒绝启动。
 *
 * 覆盖的是编排本身：参数校验、两步调用的交接、关联等待与关联前的两条断言、`turn` 只认本次运行新
 * 出现的 `morrow-schedule` 行、第 6 节的每一条停止条件与退出码、第 7 节的清理顺序与 `cleanup.json`、
 * `advance` 的缩放与真实耗时，以及 live 下的指标口径。
 */

const runScript = fileURLToPath(new URL('../scripts/acceptance/run.ts', import.meta.url));
const directories: string[] = [];
after(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

const workspace = () => {
  const dir = mkdtempSync(join(tmpdir(), 'morrow-live-'));
  directories.push(dir);
  return dir;
};

/**
 * 一个最小场景。它不是验收场景：埋入问题与看板事项只用来检查"发现原文"和探索指标的口径确实会被
 * 算出来，时间线由每个测试自己给。
 */
function scenario(timeline: Step[], budget = 3): Scenario {
  return defineScenario({
    id: 'liveprobe',
    title: 'live 编排自检',
    goal: '只验证 live 编排本身，不验证任何模型行为',
    brief: ['应用：{{appUrl}}', '使用数据：{{usageUrl}}'].join('\n'),
    project: {
      files: { 'server.js': '// 假依赖不会真的启动它\n', 'release.txt': 'seed\n' },
      artifactPath: 'release.txt',
      serve: { args: ['server.js'], ready: '/', probe: '/usage' },
    },
    feedback: {
      initial: { features: { bulkexport: { visits: 14 } }, abandonedSessions: 96 },
      path: '/usage',
      pointer: '/features/bulkexport/visits',
      condition: { operator: 'gte', expected: 120 },
      outcome: {
        id: 'bulkexport-visits',
        claim: '访问次数达到 120',
        scope: '同一 /usage 样本',
        verification: '读取 /features/bulkexport/visits',
        disconfirm: '低于 120',
        rule: { pointer: '/features/bulkexport/visits', operator: 'gte', expected: 120 },
      },
      guardrail: {
        id: 'abandoned-sessions',
        claim: '放弃会话数不高于 96',
        scope: '同一 /usage 样本',
        verification: '读取 /abandonedSessions',
        disconfirm: '高于 96',
        rule: { pointer: '/abandonedSessions', operator: 'lte', expected: 96 },
      },
    },
    memory: [
      {
        stale: true,
        note: '过期经验，用来检查预置记忆真的走了工作接口',
        operation: 'learning.upsert',
        input: { kind: 'hypothesis', title: '旧结论' },
      },
    ],
    planted: [
      {
        id: 'buried-entrance',
        kind: 'entrance',
        feature: 'bulkexport',
        where: 'server.js',
        description: '入口太深',
        shouldFix: true,
      },
    ],
    budget: { turns: budget },
    timeline,
    invariants: [
      invariant('every-turn-produced-a-continuity-block', ({ transport }) => {
        const missing = transport.turns.filter((row: any) => !['continue', 'wait'].includes(row.decision));
        return {
          ok: !missing.length,
          detail: `${transport.turns.length} 轮中 ${missing.length} 轮没有有效的 morrow-next`,
        };
      }),
    ],
  });
}

type Knobs = {
  /**
   * `makeDue` 之后假调度器做什么。`interrupted` 模拟引擎的 finishFailure：那一轮以 `interrupted`
   * 结束，频道被置 `paused` 且开关被关掉。
   */
  onMakeDue?: 'complete' | 'running' | 'nothing' | 'native-app' | 'interrupted';
  /**
   * App 自己中断 Morrow 这一轮之后，又自己以 `turnTrigger: 'resume_interrupted_task'` 续跑：第
   * `afterSleeps`（缺省 1）次 `sleep` 之后往 `runs` 里塞一行 `native-app` 运行；`status: 'running'`
   * 的那行再过 `finishAfterSleeps`（缺省 2）次 `sleep` 落到 `completed`。`trigger` 可以换成别的值，
   * `never` 则一行都不塞——用来验证「没找到续跑轮次就照旧记 interrupted」。
   */
  appResume?: {
    afterSleeps?: number;
    status?: 'running' | 'completed';
    finishAfterSleeps?: number;
    trigger?: string;
    never?: boolean;
  };
  /** 每一轮结束时给出的 `morrow-next` 状态。 */
  decision?: string;
  /** `native.list` 依次返回的候选；最后一项重复。 */
  threads?: ThreadCandidate[][];
  /** `native.list` 依次抛出的错误文本；`undefined` 表示这次照 `threads` 返回。最后一项重复。 */
  threadErrors?: Array<string | undefined>;
  /** `native/status` 依次返回的状态；最后一项重复。 */
  statuses?: Array<Partial<NativeStatusView>>;
  /** 未关联时启动一轮的状态码。 */
  unboundStatus?: number;
  /** 关联前 `capabilities.create` 的取值。 */
  createCapability?: boolean;
  /** 预先存在的 `runs` 行，模拟关联时同步进来的历史。 */
  existingRuns?: RunView[];
  items?: ItemView[];
  tables?: Record<string, any[]>;
  /** `pendingRelease()` 的返回值。 */
  release?: { id: string; title: string; status: string; reviewHash: string; itemIds: string[] };
  /** `pendingReviews()` 依次返回的数；最后一项重复。 */
  reviews?: number[];
  usageWaitAfterTurns?: number;
  /** 第 N 次假时钟 `sleep` 之后频道被额度门禁挡住；用来在等待中途（例如 `advance` 里）触发门禁。 */
  usageWaitAfterSleeps?: number;
  /** 第 N 次假时钟 `sleep` 之后 `readyThreadCount` 掉到 0。 */
  notReadyAfterSleeps?: number;
  /**
   * 真实调度器自己发起的一轮：到了第 `afterPolls` 次 `poll`（或第 `afterSleeps` 次 `sleep`）就往 `runs`
   * 里塞一行 `morrow-schedule`，runner 从来没有 `makeDue` 过它。`status: 'running'` 的那行再过
   * `finishAfterSleeps`（缺省 2）次 `sleep` 落到 `completed`。
   */
  schedulerRun?: {
    afterPolls?: number;
    afterSleeps?: number;
    status: 'running' | 'completed';
    finishAfterSleeps?: number;
    decision?: string;
    /** 已完成的那行带不带 `startedAt`/`finishedAt`；不带时接管的记录要标明起止取自接管时刻。 */
    withTimes?: boolean;
  };
  /** restart 之后原生连接一直恢复不了。 */
  notReadyAfterRestart?: boolean;
};

type Fake = {
  deps: LiveDeps;
  /** 按发生顺序记下每一次副作用，用来检查清理顺序。 */
  order: string[];
  logs: string[];
  session: LiveSession;
  runs: RunView[];
  /** 假时钟当前时刻。 */
  at(): number;
};

const status = (over: Partial<NativeStatusView> = {}): NativeStatusView => ({
  connected: true,
  connectionMode: 'app-follower',
  boundThreadCount: 1,
  readyThreadCount: 1,
  restartRequired: false,
  appVersion: '26.903.61454',
  runtimeVersion: '0.153.4',
  detail: '已连接 Codex App。',
  capabilities: { create: false },
  ...over,
});

/** 一整套假依赖。每个测试只调它需要的那几个旋钮。 */
function fake(knobs: Knobs = {}): Fake {
  const order: string[] = [];
  const logs: string[] = [];
  let now = Date.parse('2026-09-11T09:00:00.000Z');
  const runs: RunView[] = [...(knobs.existingRuns || [])];
  const decisions = new Map<string, string>();
  const tables: Record<string, any[]> = { runs: [], channels: [], items: knobs.items || [], ...(knobs.tables || {}) };
  let threadCall = 0;
  let statusCall = 0;
  let reviewCall = 0;
  let paused = false;
  /** 频道开关（真实实现读 `controls` 行的 `enabled`）。 */
  let enabled = false;
  let restarted = false;
  let turnsRun = 0;
  let sleeps = 0;
  let polls = 0;
  const next = <T>(rows: T[] | undefined, index: number, fallback: T): T =>
    rows && rows.length ? rows[Math.min(index, rows.length - 1)] : fallback;

  /**
   * 真实调度器自己开的一轮。runner 没有 `makeDue` 过它，所以它只能被时间线的下一个 `turn` 步骤接管；
   * 塞进去的时机按 `poll` 或 `sleep` 的次数算，好让它落在某个步骤的中间。
   */
  let scheduled: RunView | undefined;
  let scheduledAtSleep = 0;
  const schedulerTick = () => {
    const spec = knobs.schedulerRun;
    if (!spec) return;
    if (!scheduled) {
      const due =
        (spec.afterPolls !== undefined && polls >= spec.afterPolls) ||
        (spec.afterSleeps !== undefined && sleeps >= spec.afterSleeps);
      if (!due) return;
      scheduledAtSleep = sleeps;
      const withTimes = spec.withTimes !== false;
      scheduled = {
        id: 'run-scheduler',
        source: 'morrow-schedule',
        status: spec.status,
        reportStatus: 'valid',
        sessionId: 'thread-1',
        nativeTurnId: 'turn-scheduler',
        permission: 'native',
        model: 'gpt-5.3-codex',
        ...(withTimes ? { startedAt: new Date(now - 90_000).toISOString() } : {}),
        ...(spec.status === 'completed' && withTimes ? { finishedAt: new Date(now - 30_000).toISOString() } : {}),
      };
      runs.push(scheduled);
      tables.runs = runs.slice();
      if (spec.status === 'completed') decisions.set(scheduled.id, spec.decision || 'continue');
      return;
    }
    if (scheduled.status === 'running' && sleeps >= scheduledAtSleep + (spec.finishAfterSleeps ?? 2)) {
      scheduled.status = 'completed';
      scheduled.finishedAt = new Date(now).toISOString();
      tables.runs = runs.slice();
      decisions.set(scheduled.id, spec.decision || 'continue');
    }
  };

  /**
   * App 自己的续跑轮次。它是一行 `native-app` 运行，`trigger` 来自 `native_turns` 的
   * `raw.params.turnTrigger`；runner 从来没有 `makeDue` 过它，也不该拿它计预算。
   */
  let resumeRow: RunView | undefined;
  let interruptedAtSleep: number | undefined;
  let resumeAtSleep = 0;
  const resumeTick = () => {
    const spec = knobs.appResume;
    if (!spec || spec.never || interruptedAtSleep === undefined) return;
    if (!resumeRow) {
      if (sleeps < interruptedAtSleep + (spec.afterSleeps ?? 1)) return;
      resumeAtSleep = sleeps;
      resumeRow = {
        id: 'run-app-resume',
        source: 'native-app',
        status: spec.status || 'completed',
        trigger: spec.trigger ?? 'resume_interrupted_task',
        sessionId: 'thread-1',
        nativeTurnId: 'turn-app-resume',
        permission: 'native',
        model: 'gpt-5.3-codex',
        startedAt: new Date(now).toISOString(),
        ...(spec.status === 'running' ? {} : { finishedAt: new Date(now + 40_000).toISOString() }),
      };
      runs.push(resumeRow);
      tables.runs = runs.slice();
      return;
    }
    if (resumeRow.status === 'running' && sleeps >= resumeAtSleep + (spec.finishAfterSleeps ?? 2)) {
      resumeRow.status = 'completed';
      resumeRow.finishedAt = new Date(now).toISOString();
      tables.runs = runs.slice();
    }
  };

  const session: LiveSession = {
    home: '/nonexistent/home',
    projectPath: '/nonexistent/project',
    projectId: 'project-1',
    channelId: 'channel-1',
    store: {
      all: (table: string) => (tables[table] || []).slice(),
      get: (table: string, id: string) => (tables[table] || []).find((row: any) => row.id === id),
    },
    nativeStatus: async () => {
      order.push('status');
      const dropped = knobs.notReadyAfterSleeps !== undefined && sleeps >= knobs.notReadyAfterSleeps;
      return status({
        ...next(knobs.statuses, statusCall++, {}),
        ...(restarted ? { readyThreadCount: 0 } : {}),
        ...(dropped ? { readyThreadCount: 0, detail: '任务窗口已关闭' } : {}),
      });
    },
    runUnbound: async () => {
      order.push('run-unbound');
      return knobs.unboundStatus ?? 409;
    },
    listThreads: async () => {
      order.push('list');
      const failure = next<string | undefined>(knobs.threadErrors, threadCall, undefined);
      if (failure) {
        threadCall++;
        throw new Error(failure);
      }
      return next(knobs.threads, threadCall++, [{ id: 'thread-1', title: '任务', cwd: '/nonexistent/project' }]);
    },
    bind: async (threadId) => {
      order.push(`bind:${threadId}`);
    },
    interrupt: async (turnId) => {
      order.push(`interrupt:${turnId}`);
    },
    setChannelBudget: async (value) => {
      order.push(`channel-budget:${value}`);
    },
    setProjectBudget: async (value) => {
      order.push(`project-budget:${value.limitPercent}/${value.window}`);
    },
    setReserve: async (value, stopWhenUsageUnknown) => {
      order.push(`reserve:${value.keepPercent}/${value.window}/${stopWhenUsageUnknown}`);
    },
    readUsage: async () => {
      order.push('usage');
      return {
        at: new Date(now).toISOString(),
        source: 'protocol',
        windows: [{ name: '5h', usedPercent: order.filter((row) => row === 'usage').length === 1 ? 11 : 14.5 }],
      };
    },
    seedMemory: async (seeds) => {
      order.push(`seed-memory:${seeds.length}`);
      return seeds.filter((seed) => seed.stale).map((_, index) => `stale-${index}`);
    },
    enableControl: () => {
      order.push('enable');
      enabled = true;
    },
    makeDue: () => {
      // 真实实现先 `setControl(enabled: true)` 再置到期：引擎会在一轮 `interrupted` 之后关掉开关。
      order.push('enable');
      enabled = true;
      paused = false;
      order.push('make-due');
      turnsRun++;
      const id = `run-${turnsRun}`;
      const mode = knobs.onMakeDue || 'complete';
      if (mode === 'nothing') return;
      if (mode === 'native-app') {
        runs.push({ id, source: 'native-app', status: 'completed' });
        return;
      }
      const row: RunView = {
        id,
        source: 'morrow-schedule',
        status: mode === 'running' ? 'running' : mode === 'interrupted' ? 'interrupted' : 'completed',
        reportStatus: mode === 'interrupted' ? 'missing' : 'valid',
        sessionId: 'thread-1',
        nativeTurnId: `turn-${turnsRun}`,
        permission: 'native',
        model: 'gpt-5.3-codex',
        startedAt: new Date(now).toISOString(),
        ...(mode === 'running' ? {} : { finishedAt: new Date(now).toISOString() }),
      };
      runs.push(row);
      tables.runs = runs.slice();
      if (mode === 'complete') decisions.set(id, knobs.decision || 'continue');
      if (mode === 'interrupted') {
        // 引擎的 finishFailure：频道置 paused，开关关掉。
        paused = true;
        enabled = false;
        interruptedAtSleep = sleeps;
      }
    },
    channel: () => ({
      status: paused ? 'paused' : 'waiting',
      enabled,
      nextRunAt: '',
      maxRunsPerDay: 6,
      runsToday: turnsRun,
      ...((knobs.usageWaitAfterTurns !== undefined && turnsRun >= knobs.usageWaitAfterTurns) ||
      (knobs.usageWaitAfterSleeps !== undefined && sleeps >= knobs.usageWaitAfterSleeps)
        ? { usageWait: { kind: 'reserve', window: 'weekly', resetsAt: '2026-09-15T00:00:00.000Z', since: '' } }
        : {}),
      ...(knobs.decision === 'needs_input'
        ? { work: { state: 'needs_input', nextStep: '使用数据里的 askedFor 字段是什么口径？' } }
        : {}),
    }),
    runs: () => runs.slice(),
    turnTools: (run) =>
      run.nativeTurnId
        ? run.source === 'native-app'
          ? ['agentMessage', 'webSearch']
          : ['commandExecution', 'webSearch', 'toolCall:browser']
        : [],
    turnDecision: (runId) => decisions.get(runId) || 'none',
    pollWatches: async () => {
      order.push('poll');
      polls++;
      schedulerTick();
      return { polled: 1, evidence: 1, statuses: ['watching'] };
    },
    pendingReviews: () => next(knobs.reviews, reviewCall++, 0),
    reviewStatuses: () => ['passed'],
    pendingRelease: () => knobs.release,
    guide: async (text) => {
      order.push(`guide:${text}`);
      return { state: 'queued' };
    },
    pause: async () => {
      order.push('pause');
      paused = true;
      enabled = false;
    },
    resume: () => {
      order.push('resume');
      paused = false;
      enabled = true;
    },
    restart: async () => {
      order.push('restart');
      if (knobs.notReadyAfterRestart) restarted = true;
    },
    items: () => {
      order.push('items');
      return knobs.items || [];
    },
    drain: async () => {
      order.push('drain');
    },
    close: async () => {
      order.push('close');
    },
  };

  const app: RunningApp = {
    url: 'http://127.0.0.1:65000',
    pid: 424242,
    probe: { features: { bulkexport: { visits: 14 } } },
    output: () => '',
    stop: async () => {
      order.push('app-stop');
      return { stopped: true, code: 0, signal: null, killed: false };
    },
  };

  const receiver: Receiver = {
    url: 'http://127.0.0.1:65001',
    posts: 0,
    uploaded: '',
    receipt: {},
    setFeedback: () => order.push('set-feedback'),
    setMode: () => order.push('set-mode'),
    close: async () => {
      order.push('receiver-close');
    },
  };

  const deps: LiveDeps = {
    startService: async (options) => {
      order.push(`start-service:${options.home.endsWith('/home')}`);
      assert.match(options.project.brief || '', /应用：http:\/\/127\.0\.0\.1:/);
      return session;
    },
    clock: {
      now: () => now,
      sleep: async (ms) => {
        now += Math.max(0, ms);
        sleeps++;
        schedulerTick();
        resumeTick();
      },
    },
    log: (text) => logs.push(text),
    freePort: async () => 65000,
    startApp: async () => {
      order.push('app-start');
      return app;
    },
    startReceiver: async () => receiver,
  };
  return { deps, order, logs, session, runs, at: () => now };
}

/** prepare 一次，再用同一个 run-id 跑一次；返回结果和产物目录。 */
async function live(
  timeline: Step[],
  knobs: Knobs = {},
  options: Partial<LiveOptions> & { budget?: number } = {},
  budget = 3
): Promise<{ result: LiveResult; out: string; fake: Fake }> {
  const out = join(workspace(), 'run');
  const scene = scenario(timeline, Math.max(budget, options.budget ?? budget));
  prepareLive(scene, { runId: 'probe-1', out }, () => {});
  const instance = fake(knobs);
  const result = await runLive(
    scene,
    { runId: 'probe-1', out, budget: options.budget ?? budget, ...options },
    instance.deps
  );
  return { result, out, fake: instance };
}

const cli = (...args: string[]) =>
  spawnSync(process.execPath, [runScript, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', NO_COLOR: '1' },
  });

/* ------------------------------- 参数校验 ------------------------------- */

test('live 模式的用法错误都以退出码 2 结束，并且不再打印旧的提案提示', () => {
  const missing = cli('run', 'usagegap', '--mode', 'live');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--run-id 必填/);
  assert.doesNotMatch(missing.stderr + missing.stdout, /尚未实现/);

  const noBudget = cli('run', 'usagegap', '--mode', 'live', '--run-id', 'x');
  assert.equal(noBudget.status, 2);
  assert.match(noBudget.stderr, /--budget 必填/);

  const policy = cli('run', 'usagegap', '--mode', 'live', '--run-id', 'x', '--budget', '3', '--policy', 'careful');
  assert.equal(policy.status, 2);
  assert.match(policy.stderr, /--policy 在 live 模式下被拒绝/);

  const all = cli('run', 'all', '--mode', 'live', '--run-id', 'x', '--budget', '3');
  assert.equal(all.status, 2);
  assert.match(all.stderr, /run all 在 live 模式下被拒绝/);

  const repeat = cli('run', 'usagegap', '--mode', 'live', '--run-id', 'x', '--budget', '3', '--repeat', '2');
  assert.equal(repeat.status, 2);
  assert.match(repeat.stderr, /--repeat 在 live 模式下被拒绝/);

  const window = cli(
    'run',
    'usagegap',
    '--mode',
    'live',
    '--run-id',
    'x',
    '--budget',
    '3',
    '--project-window',
    'daily'
  );
  assert.equal(window.status, 2);
  assert.match(window.stderr, /只能是 5h 或 weekly/);
});

test('run 拒绝没有 prepared.json 的目录、场景不符的目录，以及已经跑过的目录', async () => {
  const out = join(workspace(), 'run');
  const scene = scenario([{ verb: 'turn' }]);
  await assert.rejects(() => runLive(scene, { runId: 'probe-1', out, budget: 1 }, fake().deps), /没有 prepared.json/);

  prepareLive(scene, { runId: 'probe-1', out }, () => {});
  await assert.rejects(
    () => runLive(scenario([{ verb: 'turn' }]), { runId: 'other', out, budget: 1 }, fake().deps),
    /准备的是 run-id probe-1/
  );

  const mismatch = JSON.parse(readFileSync(join(out, 'prepared.json'), 'utf8'));
  writeFileSync(join(out, 'prepared.json'), JSON.stringify({ ...mismatch, scenario: 'usagegap' }));
  await assert.rejects(
    () => runLive(scene, { runId: 'probe-1', out, budget: 1 }, fake().deps),
    /准备的是场景 usagegap/
  );

  const ran = join(workspace(), 'ran');
  prepareLive(scene, { runId: 'probe-2', out: ran }, () => {});
  mkdirSync(join(ran, 'home'), { recursive: true });
  await assert.rejects(() => runLive(scene, { runId: 'probe-2', out: ran, budget: 1 }, fake().deps), /已经有 home\//);
  // prepare 也拒绝已经跑过的目录。
  assert.throws(() => prepareLive(scene, { runId: 'probe-2', out: ran }, () => {}), /已经有 home\//);
});

test('--budget 与 --advance-scale 的取值在编排之前就被拒绝', async () => {
  const out = join(workspace(), 'run');
  const scene = scenario([{ verb: 'turn' }]);
  prepareLive(scene, { runId: 'probe-1', out }, () => {});
  await assert.rejects(() => runLive(scene, { runId: 'probe-1', out, budget: 0 }, fake().deps), /--budget 必填/);
  await assert.rejects(
    () => runLive(scene, { runId: 'probe-1', out, budget: 1, advanceScale: 2 }, fake().deps),
    /--advance-scale/
  );
});

/* --------------------------------- prepare --------------------------------- */

test('prepare 建目录、写种子与 prepared.json，并打印步骤 0 和人要做的四步', () => {
  const out = join(workspace(), 'run');
  const printed: string[] = [];
  const prepared = prepareLive(scenario([{ verb: 'turn' }]), { runId: 'probe-1', out, budget: 3 }, (text) =>
    printed.push(text)
  );
  assert.equal(prepared.scenario, 'liveprobe');
  assert.equal(prepared.runId, 'probe-1');
  assert.equal(prepared.files, 2);
  assert.equal(prepared.projectPath, join(out, 'project'));
  assert.equal(readFileSync(join(out, 'project', 'release.txt'), 'utf8'), 'seed\n');
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'prepared.json'), 'utf8')), prepared);
  assert.equal(existsSync(join(out, 'home')), false, 'prepare 不起服务，也不建数据目录');
  const text = printed.join('\n');
  assert.match(text, /步骤 0（人要先做）：暂停你自己安装版 Morrow 里的自主频道/);
  assert.match(text, new RegExp(`1\\. 打开 Codex App`));
  assert.ok(text.includes(join(out, 'project')), '打印的是绝对项目路径');
  assert.match(text, /--run-id probe-1 --budget 3/);
  // 第 3 步要求任务加载了但不在前台：前台的任务窗口会让 App 重放 thread settings 并中断 follower 轮次。
  assert.match(text, /把 App 切到别的任务或关闭这个任务的窗口视图（不要删除任务）/);
  assert.doesNotMatch(text, /保持这个任务打开，不要关闭窗口/);
  // 同一个 run-id 不能准备两次：现场不能被覆盖。
  assert.throws(() => prepareLive(scenario([{ verb: 'turn' }]), { runId: 'probe-1', out }, () => {}), /已经存在/);
});

test('prepare 把项目目录做成独立 git 仓库并提交种子，工作树是干净的', () => {
  const out = join(workspace(), 'run');
  const printed: string[] = [];
  const prepared = prepareLive(scenario([{ verb: 'turn' }]), { runId: 'probe-1', out }, (text) => printed.push(text));
  assert.equal(prepared.git, true);
  assert.equal(JSON.parse(readFileSync(join(out, 'prepared.json'), 'utf8')).git, true);
  assert.equal(existsSync(join(out, 'project', '.git')), true, '项目目录自己就是一个仓库');
  const git = (...args: string[]) => spawnSync('git', ['-C', join(out, 'project'), ...args], { encoding: 'utf8' });
  assert.equal(git('status', '--porcelain').stdout, '', 'runs[].treeState 应当看到一棵干净的树');
  assert.match(git('log', '-1', '--pretty=%s%n%an%n%ae').stdout, /^seed\nmorrow-live\nmorrow-live@localhost\n$/);
  assert.match(printed.join('\n'), /项目目录已经是一个独立 git 仓库，种子提交为 "seed"/);
});

/* ------------------------------- 关联与断言 ------------------------------- */

test('列举到 0 个任务继续等，等到恰好一个才关联', async () => {
  const { result, fake: instance } = await live([{ verb: 'turn' }], { threads: [[], [], [{ id: 'thread-9' }]] });
  assert.equal(result.exitCode, 0);
  assert.equal(instance.order.filter((row) => row === 'list').length, 3);
  assert.ok(instance.order.includes('bind:thread-9'));
  assert.equal(result.live.threadId, 'thread-9');
});

test('列举到多于一个任务时中止并列出候选，不自动挑一个', async () => {
  const { result } = await live([{ verb: 'turn' }], {
    threads: [
      [
        { id: 'thread-a', title: 'A' },
        { id: 'thread-b', title: 'B' },
      ],
    ],
  });
  assert.equal(result.stop.reason, 'no-app-task');
  assert.equal(result.exitCode, 1);
  assert.match(result.stop.detail, /thread-a/);
  assert.match(result.stop.detail, /thread-b/);
});

test('listThreads 抛错时继续等但不静默：打印一次错误，超时把最后一次错误写进 detail', async () => {
  const failed = (instance: Fake) => instance.logs.filter((line) => line.includes('列举 App 任务失败'));

  const recovered = await live([{ verb: 'turn' }], { threadErrors: ['ECONNREFUSED 127.0.0.1:1455', undefined] });
  assert.equal(recovered.result.exitCode, 0);
  assert.equal(recovered.result.live.threadId, 'thread-1', '一次失败之后仍然关联成功');
  assert.equal(failed(recovered.fake).length, 1, '同一条错误只打印一次');
  assert.match(failed(recovered.fake)[0], /ECONNREFUSED 127\.0\.0\.1:1455/);

  const changed = await live([{ verb: 'turn' }], { threadErrors: ['后台还没连上', '任务列举超时', undefined] });
  assert.deepEqual(
    failed(changed.fake).map((line) => line.split('：').at(-1)),
    ['后台还没连上', '任务列举超时'],
    '错误文本变化时再打印一次'
  );

  const timedOut = await live([{ verb: 'turn' }], { threadErrors: ['后台还没连上'] }, { waitBindMinutes: 1 });
  assert.equal(timedOut.result.stop.reason, 'no-app-task');
  assert.equal(timedOut.result.exitCode, 1);
  assert.match(timedOut.result.stop.detail, /最后一次列举失败：后台还没连上/);
  assert.equal(failed(timedOut.fake).length, 1, '一直是同一条错误就不重复打印');
});

test('--wait-bind 内没等到任务就以退出码 1 结束', async () => {
  const { result } = await live([{ verb: 'turn' }], { threads: [[]] }, { waitBindMinutes: 1 });
  assert.equal(result.stop.reason, 'no-app-task');
  assert.equal(result.exitCode, 1);
  assert.match(result.stop.detail, /等了 1 分钟/);
});

test('关联前的两条断言不成立就中止，不继续消耗额度', async () => {
  const create = await live([{ verb: 'turn' }], {
    createCapability: true,
    statuses: [{ capabilities: { create: true } }],
  });
  assert.equal(create.result.stop.reason, 'error');
  assert.equal(create.result.exitCode, 1);
  assert.match(create.result.stop.detail, /capabilities\.create=true/);
  assert.equal(create.fake.order.filter((row) => row.startsWith('bind:')).length, 0);
  assert.equal(create.result.live.guards.createCapability, true);

  const unbound = await live([{ verb: 'turn' }], { unboundStatus: 200 });
  assert.equal(unbound.result.exitCode, 1);
  assert.match(unbound.result.stop.detail, /未关联时 run 返回 200/);
  assert.equal(unbound.fake.order.filter((row) => row.startsWith('bind:')).length, 0);
  assert.equal(unbound.result.live.guards.unboundRunStatus, 200);
});

test('三道闸在关联之前就设好，并原样写进 live.json 与打印出来', async () => {
  const { result, fake: instance } = await live(
    [{ verb: 'turn' }],
    {},
    { budget: 4, projectLimit: 7, projectWindow: 'weekly', reserve: 30, reserveWindow: '5h' }
  );
  assert.deepEqual(result.live.gates, {
    budget: 4,
    channelMaxRunsPerDay: 8,
    projectUsageBudget: { window: 'weekly', limitPercent: 7 },
    usageReserve: { window: '5h', keepPercent: 30 },
    stopWhenUsageUnknown: true,
  });
  assert.ok(instance.order.includes('channel-budget:8'));
  assert.ok(instance.order.includes('project-budget:7/weekly'));
  assert.ok(instance.order.includes('reserve:30/5h/true'));
  assert.ok(instance.order.indexOf('reserve:30/5h/true') < instance.order.indexOf('bind:thread-1'));
  const printed = instance.logs.join('\n');
  assert.match(printed, /--budget 4/);
  assert.match(printed, /--project-limit 7% \/ --project-window weekly/);
  assert.match(printed, /--reserve 30% \/ --reserve-window 5h/);
  assert.match(printed, /不实现 --allow-approve/);
});

/* --------------------------------- 轮次 --------------------------------- */

test('turn 只认本次运行新出现的 morrow-schedule 行', async () => {
  const existing = [
    { id: 'history-native', source: 'native-app', status: 'completed' },
    { id: 'history-schedule', source: 'morrow-schedule', status: 'completed' },
  ];
  const { result } = await live([{ verb: 'turn' }], { existingRuns: existing });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timeline[0].result.runId, 'run-1', '同步进来的历史轮次不能被当成本轮结果');
  assert.equal(result.live.spentTurns, 1, '关联前就存在的轮次不计预算');
  assert.deepEqual(result.live.turns[0].tools, ['commandExecution', 'webSearch', 'toolCall:browser']);
});

test('turn 接管真实调度器已经在跑的那一轮，不再 makeDue', async () => {
  const { result, fake: instance } = await live([{ verb: 'poll' }, { verb: 'turn' }], {
    schedulerRun: { afterPolls: 1, status: 'running', finishAfterSleeps: 2 },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stop.reason, 'timeline-finished');
  assert.equal(
    instance.order.filter((row) => row === 'make-due').length,
    0,
    '有轮次正在跑时不能 makeDue：那会把频道状态覆写成 waiting'
  );
  assert.equal(result.live.turns.length, 1);
  assert.equal(result.live.turns[0].runId, 'run-scheduler');
  assert.equal(result.live.turns[0].adopted, 'running');
  assert.equal(result.live.turns[0].decision, 'continue');
  assert.equal(result.live.turns[0].timesFrom, 'run');
  assert.deepEqual(result.live.turns[0].tools, ['commandExecution', 'webSearch', 'toolCall:browser']);
  assert.ok(
    Date.parse(result.live.turns[0].startedAt) < Date.parse(result.live.steps[1].startedAt),
    '接管的轮次起止取自 runs 行：它在这个步骤开始之前就起跑了'
  );
  assert.equal(result.timeline[1].result.runId, 'run-scheduler');
  assert.equal(result.timeline[1].result.adopted, 'running');
  assert.equal(result.live.spentTurns, 1);
});

test('turn 接管调度器自己跑完、runner 从未等过的那一轮，不再开新轮', async () => {
  const { result, fake: instance } = await live([{ verb: 'poll' }, { verb: 'turn' }], {
    schedulerRun: { afterPolls: 1, status: 'completed' },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(instance.order.filter((row) => row === 'make-due').length, 0, '已经跑完的那轮不该再开一轮');
  assert.equal(result.live.turns.length, 1);
  assert.equal(result.live.turns[0].runId, 'run-scheduler');
  assert.equal(result.live.turns[0].adopted, 'completed');
  assert.equal(result.live.turns[0].decision, 'continue');
  assert.equal(result.live.turns[0].timesFrom, 'run');
  assert.equal(result.live.turns[0].wallMs, 60_000, '起止取自 runs 行上的 startedAt/finishedAt');
  assert.equal(result.live.spentTurns, 1);
  assert.match(instance.logs.join('\n'), /直接把它记为本步骤的轮次/);

  // 行上没有起止时退回接管时刻，并在记录里标明。
  const noTimes = await live([{ verb: 'poll' }, { verb: 'turn' }], {
    schedulerRun: { afterPolls: 1, status: 'completed', withTimes: false },
  });
  assert.equal(noTimes.result.live.turns[0].timesFrom, 'clock');
  assert.equal(noTimes.result.live.turns[0].wallMs, 0);
});

test('被接管的轮次也进「每一轮」表：表行数与 spentTurns 对得上', async () => {
  const { result, fake: instance } = await live(
    [{ verb: 'turn' }, { verb: 'poll' }, { verb: 'turn' }],
    { schedulerRun: { afterPolls: 1, status: 'completed' } },
    { budget: 3 }
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stop.reason, 'timeline-finished');
  assert.equal(
    instance.order.filter((row) => row === 'make-due').length,
    1,
    '第二个 turn 接管调度器那轮，一个时间线 turn 不该消耗两轮'
  );
  assert.equal(result.live.spentTurns, 2);
  assert.equal(result.live.turns.length, result.live.spentTurns, '「每一轮」表不能比 spentTurns 少行');
  assert.deepEqual(
    result.live.turns.map((turn) => [turn.runId, turn.adopted]),
    [
      ['run-1', undefined],
      ['run-scheduler', 'completed'],
    ]
  );
  assert.match(result.summary, /调度器（接管已完成）/);
  assert.match(result.summary, /一样出现在这张表里/);
});

test('预算用完的那一刻仍然接管调度器已经跑过的轮次，挡住的是下一步要开的新轮', async () => {
  const { result, fake: instance } = await live(
    [{ verb: 'turn' }, { verb: 'poll' }, { verb: 'turn' }, { verb: 'turn' }],
    { schedulerRun: { afterPolls: 1, status: 'completed' } },
    { budget: 2 },
    3
  );
  assert.equal(result.stop.reason, 'budget-exhausted');
  assert.equal(result.exitCode, 0);
  assert.equal(result.live.spentTurns, 2);
  assert.equal(result.live.turns.length, 2, '第 3 步接管了调度器那轮，第 4 步才被预算挡住');
  assert.equal(instance.order.filter((row) => row === 'make-due').length, 1);
  assert.equal(result.live.remainingSteps, 1);
});

test('makeDue 会重新打开频道开关，而且 liveGateDetail 打印 enabled=', async () => {
  // 引擎对 interrupted 的运行会把频道置 paused 并关掉开关；第 2 个 turn 的 makeDue 必须先打开它，
  // 否则真实调度器永远不会再启动一轮——首跑 usagegap-live-01 就是这样干等满 --turn-timeout。
  const { result, fake: instance } = await live(
    [{ verb: 'turn' }, { verb: 'turn' }],
    { onMakeDue: 'interrupted', appResume: { never: true } },
    { budget: 3 }
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stop.reason, 'timeline-finished');
  const dues = instance.order.reduce<number[]>((at, row, index) => (row === 'make-due' ? [...at, index] : at), []);
  assert.equal(dues.length, 2);
  for (const at of dues) assert.equal(instance.order[at - 1], 'enable', 'makeDue 之前紧跟着一次 enable');
  assert.equal(result.live.turns.length, 2, '开关重新打开了，所以第 2 轮真的起来了');

  // 开关的取值进 liveGateDetail：首跑那次的说明里看不出真实原因。
  const stuck = await live([{ verb: 'turn' }], { onMakeDue: 'nothing' }, { turnTimeoutMinutes: 1 });
  assert.equal(stuck.result.stop.reason, 'turn-timeout');
  assert.match(stuck.result.stop.detail, /enabled=true/);
});

test('App 自己中断这一轮又自己续跑时，两者记成同一轮，时间线继续', async () => {
  const { result, fake: instance } = await live(
    [{ verb: 'turn' }, { verb: 'poll' }],
    { onMakeDue: 'interrupted', appResume: { status: 'running', finishAfterSleeps: 2 } },
    { budget: 3 }
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stop.reason, 'timeline-finished', '不是失败条件：时间线继续往下走');
  assert.equal(result.timeline.length, 2);
  assert.equal(result.live.turns.length, 1, '这一对是同一轮，不是两行');
  const turn = result.live.turns[0];
  assert.equal(turn.runId, 'run-1');
  assert.equal(turn.status, 'interrupted', 'Morrow 那一轮的结局如实保留');
  assert.equal(turn.interruptedByApp, true);
  assert.equal(turn.resumedRunId, 'run-app-resume');
  assert.equal(turn.resumedStatus, 'completed');
  assert.equal(turn.resumedWallMs, 2000, '续跑那一轮的耗时取它自己 runs 行上的起止');
  assert.equal(turn.decision, 'none', 'decision 仍取引擎对 Morrow 那一轮解析出的值');
  assert.deepEqual(
    turn.tools,
    ['agentMessage', 'commandExecution', 'toolCall:browser', 'webSearch'],
    'tools 是两轮的并集'
  );
  assert.equal(result.live.spentTurns, 1, '续跑那一轮是 native-app，不计 --budget');
  assert.equal(result.timeline[0].result.interruptedByApp, true);
  assert.equal(result.timeline[0].result.resumedRunId, 'run-app-resume');
  assert.match(instance.logs.join('\n'), /turnTrigger=resume_interrupted_task/);
  assert.match(result.summary, /App 中断后自行续跑 → completed/);
  assert.match(result.summary, /标成「App 中断后自行续跑」的那几轮/);
  assert.match(result.summary, /interrupted on purpose/);

  // 续跑那一轮一出现就已经是终态时同样记得下来。
  const settled = await live([{ verb: 'turn' }], { onMakeDue: 'interrupted', appResume: {} }, { budget: 3 });
  assert.equal(settled.result.live.turns[0].resumedStatus, 'completed');
  assert.equal(settled.result.live.turns[0].resumedWallMs, 40_000);
});

test('没有出现 App 续跑轮次时照旧记 interrupted，也不算失败', async () => {
  const never = await live([{ verb: 'turn' }], { onMakeDue: 'interrupted', appResume: { never: true } });
  assert.equal(never.result.exitCode, 0);
  assert.equal(never.result.stop.reason, 'timeline-finished');
  assert.equal(never.result.live.turns[0].status, 'interrupted');
  assert.equal(never.result.live.turns[0].interruptedByApp, undefined);
  assert.deepEqual(never.result.live.turns[0].tools, ['commandExecution', 'webSearch', 'toolCall:browser']);
  assert.match(never.fake.logs.join('\n'), /15 秒内也没有出现 App 自己的续跑轮次，如实记为 interrupted/);
  assert.doesNotMatch(never.result.summary, /App 中断后自行续跑/);

  // 别的 turnTrigger 不算：只认 App 自己的 resume_interrupted_task。
  const other = await live([{ verb: 'turn' }], { onMakeDue: 'interrupted', appResume: { trigger: 'composer' } });
  assert.equal(other.result.live.turns[0].interruptedByApp, undefined);
});

test('runner 自己中断的那一轮不去找 App 的续跑轮次', async () => {
  const { result } = await live(
    [{ verb: 'turn' }],
    { onMakeDue: 'running', appResume: { status: 'completed' } },
    { turnTimeoutMinutes: 1 }
  );
  assert.equal(result.stop.reason, 'turn-timeout');
  assert.equal(result.exitCode, 1);
  assert.equal(result.live.turns.length, 0, '超时的那一轮本来就没有记录，不该被当成 App 中断');
});

test('新出现的 native-app 轮次不算一轮，turn 会超时并精确中断', async () => {
  const { result, fake: instance } = await live(
    [{ verb: 'turn' }],
    { onMakeDue: 'native-app' },
    { turnTimeoutMinutes: 1 }
  );
  assert.equal(result.stop.reason, 'turn-timeout');
  assert.equal(result.exitCode, 1);
  assert.equal(
    instance.order.filter((row) => row.startsWith('interrupt:')).length,
    0,
    '还没有 nativeTurnId 时不发中断'
  );
});

test('一轮超过 --turn-timeout 时先精确中断本轮 turn，再以退出码 1 结束', async () => {
  const { result, fake: instance } = await live(
    [{ verb: 'turn' }],
    { onMakeDue: 'running' },
    { turnTimeoutMinutes: 1 }
  );
  assert.equal(result.stop.reason, 'turn-timeout');
  assert.equal(result.exitCode, 1);
  assert.ok(instance.order.includes('interrupt:turn-1'));
  assert.match(result.stop.detail, /已请求停止本轮/);
});

test('--budget 用完时以退出码 0 结束，并在报告里写明剩余步数', async () => {
  const { result } = await live([{ verb: 'turn' }, { verb: 'poll' }, { verb: 'turn' }], {}, { budget: 1 }, 2);
  assert.equal(result.stop.reason, 'budget-exhausted');
  assert.equal(result.exitCode, 0);
  assert.equal(result.ok, true);
  assert.equal(result.live.spentTurns, 1);
  assert.equal(result.live.remainingSteps, 1);
  assert.match(result.summary, /剩余 1 步未执行/);
});

test('某一轮以 needs_input 结束时打印问题、以退出码 0 结束，runner 不代替人回答', async () => {
  const { result, fake: instance } = await live([{ verb: 'turn' }, { verb: 'poll' }], { decision: 'needs_input' });
  assert.equal(result.stop.reason, 'needs-input');
  assert.equal(result.exitCode, 0);
  assert.equal(result.timeline.length, 1, '后面的步骤不再执行');
  assert.match(instance.logs.join('\n'), /askedFor 字段是什么口径/);
});

test('额度门禁挡住频道时以退出码 0 结束，并记下阻断时的窗口', async () => {
  const { result } = await live([{ verb: 'turn' }, { verb: 'turn' }], { usageWaitAfterTurns: 1 }, { budget: 3 });
  assert.equal(result.stop.reason, 'usage-blocked');
  assert.equal(result.exitCode, 0);
  assert.match(result.stop.detail, /reserve（weekly 窗口）/);
});

test('readyThreadCount 中途掉到 0 就以退出码 1 结束，不新建替代任务', async () => {
  const { result, fake: instance } = await live(
    [{ verb: 'turn' }],
    { onMakeDue: 'running', statuses: [{}, {}, { readyThreadCount: 0, detail: '任务窗口已关闭' }] },
    { turnTimeoutMinutes: 30 }
  );
  assert.equal(result.stop.reason, 'thread-not-ready');
  assert.equal(result.exitCode, 1);
  assert.match(result.stop.detail, /readyThreadCount=0/);
  assert.equal(instance.order.filter((row) => row.startsWith('bind:')).length, 1, '不为了掩盖而重新关联');
});

test('restartRequired 变为 true 就以退出码 1 结束', async () => {
  const atBind = await live([{ verb: 'turn' }], { statuses: [{}, { restartRequired: true }] });
  assert.equal(atBind.result.stop.reason, 'restart-required');
  assert.equal(atBind.result.exitCode, 1);

  const midRun = await live(
    [{ verb: 'turn' }],
    { onMakeDue: 'running', statuses: [{}, {}, { restartRequired: true }] },
    { turnTimeoutMinutes: 30 }
  );
  assert.equal(midRun.result.stop.reason, 'restart-required');
  assert.equal(midRun.result.exitCode, 1);
});

test('墙钟超过 --wall-clock 时以退出码 1 结束', async () => {
  const { result } = await live(
    [{ verb: 'turn' }],
    { onMakeDue: 'running' },
    { wallClockMinutes: 1, turnTimeoutMinutes: 30 }
  );
  assert.equal(result.stop.reason, 'wall-clock');
  assert.equal(result.exitCode, 1);
});

test('时间线走到 approve 就打印发布信息、暂停频道、以退出码 0 停在人工确认', async () => {
  const release = {
    id: 'release-1',
    title: '把批量导出的入口提到首页',
    status: 'awaiting_approval',
    reviewHash: 'abc123',
    itemIds: ['item-1'],
  };
  const { result, fake: instance } = await live([{ verb: 'turn' }, { verb: 'approve' }, { verb: 'turn' }], { release });
  assert.equal(result.stop.reason, 'awaiting-approval');
  assert.equal(result.exitCode, 0);
  assert.equal(result.timeline.length, 2);
  const printed = instance.logs.join('\n');
  assert.match(printed, /live 模式不代替人做上线确认/);
  assert.match(printed, /reviewHash：abc123/);
  assert.ok(instance.order.includes('pause'));
});

/* ------------------------------ advance 缩放 ------------------------------ */

test('advance 变成有上限的真实等待，缩放比例与真实耗时都记下来', async () => {
  const { result } = await live(
    [
      { verb: 'advance', minutes: 20 },
      { verb: 'advance', minutes: 600 },
    ],
    {},
    { advanceScale: 0.1, maxWaitMinutes: 10 }
  );
  assert.equal(result.stop.reason, 'timeline-finished');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(
    result.timeline.map((row) => [row.result.minutes, row.result.waitedMs, row.result.cappedByMaxWait]),
    [
      [20, 120_000, false],
      [600, 600_000, true],
    ]
  );
  assert.equal(result.live.advanceScale, 0.1);
  assert.equal(result.live.steps[0].wallMs, 120_000);
  assert.match(result.summary, /观察窗口被压缩了 10 倍/);
  assert.match(result.summary, /不可.*与 fixture 直接比较/);
});

test('--advance-scale 1 表示不压缩，报告如实说明', async () => {
  const { result } = await live([{ verb: 'advance', minutes: 5 }], {}, { advanceScale: 1 });
  assert.equal(result.timeline[0].result.waitedMs, 300_000);
  assert.match(result.summary, /观察窗口没有被压缩/);
});

test('advance 的等待分片过 guard：额度门禁与任务掉线在整段等待结束之前就被发现', async () => {
  const blocked = await live(
    [{ verb: 'advance', minutes: 20 }, { verb: 'turn' }],
    { usageWaitAfterSleeps: 3 },
    { advanceScale: 0.1, maxWaitMinutes: 10 }
  );
  assert.equal(blocked.result.stop.reason, 'usage-blocked');
  assert.equal(blocked.result.exitCode, 0);
  assert.match(blocked.result.stop.detail, /reserve（weekly 窗口）/);
  assert.equal(blocked.result.timeline.length, 1, '后面的步骤不再执行');
  assert.ok(
    blocked.result.live.steps[0].wallMs < 120_000,
    `advance 应当在整段 120 秒等待结束之前停下，实际等了 ${blocked.result.live.steps[0].wallMs}ms`
  );

  const notReady = await live(
    [{ verb: 'advance', minutes: 20 }, { verb: 'turn' }],
    { notReadyAfterSleeps: 2 },
    { advanceScale: 0.1, maxWaitMinutes: 10 }
  );
  assert.equal(notReady.result.stop.reason, 'thread-not-ready');
  assert.equal(notReady.result.exitCode, 1);
  assert.match(notReady.result.stop.detail, /readyThreadCount=0/);
  assert.ok(
    notReady.result.live.steps[0].wallMs < 120_000,
    `任务掉线应当在整段等待结束之前被发现，实际等了 ${notReady.result.live.steps[0].wallMs}ms`
  );
});

/* ------------------------------- verify 与指导 ------------------------------- */

test('verify 在 live 下是 no-op；有排队的复核时只等它落到终态', async () => {
  const none = await live([{ verb: 'verify' }], { reviews: [0] });
  assert.equal(none.result.timeline[0].result.pending, 0);
  assert.match(String(none.result.timeline[0].result.note), /no-op/);

  const waited = await live([{ verb: 'verify' }], { reviews: [1, 1, 0] });
  assert.equal(waited.result.exitCode, 0);
  assert.equal(waited.result.timeline[0].result.pending, 1);
  assert.deepEqual(waited.result.timeline[0].result.verdicts, ['passed']);
});

test('guide、pause、resume、restart 在 live 下照旧走同一条原生任务', async () => {
  const { result, fake: instance } = await live(
    [{ verb: 'guide', text: '先看使用数据再决定' }, { verb: 'pause' }, { verb: 'resume' }, { verb: 'restart' }],
    {}
  );
  assert.equal(result.exitCode, 0);
  assert.ok(instance.order.includes('guide:先看使用数据再决定'));
  assert.ok(instance.order.includes('resume'));
  assert.ok(instance.order.includes('restart'));
  assert.equal(result.timeline[0].result.state, 'queued');
  // 重开服务之后 runner 自己等到关联恢复才继续，否则下一步的 guard 会把重连当成「任务不再就绪」。
  assert.equal(result.timeline[3].result.readyThreadCount, 1);
});

test('restart 之后关联恢复不了就以退出码 1 结束', async () => {
  const { result } = await live([{ verb: 'restart' }], { notReadyAfterRestart: true }, { turnTimeoutMinutes: 1 });
  assert.equal(result.stop.reason, 'thread-not-ready');
  assert.equal(result.exitCode, 1);
  assert.match(result.stop.detail, /重开服务后没有等到关联恢复/);
});

/* --------------------------------- 清理 --------------------------------- */

test('清理按固定顺序执行，cleanup.json 记下 live 专属字段', async () => {
  const { result, out, fake: instance } = await live([{ verb: 'turn' }]);
  const cleanup = JSON.parse(readFileSync(join(out, 'cleanup.json'), 'utf8'));
  assert.equal(cleanup.app.stopped, true);
  assert.equal(cleanup.app.pid, 424242);
  assert.equal(cleanup.app.killed, false);
  assert.equal(cleanup.threadId, 'thread-1');
  assert.equal(cleanup.unbound, false, '绑定有意保留');
  assert.equal(cleanup.channelsPaused, 1);
  assert.equal(cleanup.serviceClosed, true);
  assert.equal(cleanup.directoriesRemoved, false);
  assert.equal(cleanup.keep, true);
  assert.equal(cleanup.root, out);
  assert.equal(cleanup.usageAfter.windows[0].usedPercent, 14.5);
  assert.ok(cleanup.notes.some((note: string) => note.includes('绑定有意保留')));
  const tail = instance.order.slice(instance.order.lastIndexOf('app-stop'));
  assert.deepEqual(
    tail.filter((row) => ['app-stop', 'pause', 'usage', 'items', 'close', 'receiver-close'].includes(row)),
    ['app-stop', 'pause', 'usage', 'items', 'close', 'receiver-close']
  );
  assert.equal(existsSync(join(out, 'project', 'release.txt')), true, '现场只有这一份，不删');
  assert.deepEqual(result.live.usageDelta, { '5h': 3.5 });
});

test('运行失败时也照同样的顺序清理', async () => {
  const { out, fake: instance } = await live([{ verb: 'turn' }], { onMakeDue: 'running' }, { turnTimeoutMinutes: 1 });
  const cleanup = JSON.parse(readFileSync(join(out, 'cleanup.json'), 'utf8'));
  assert.equal(cleanup.app.stopped, true);
  assert.equal(cleanup.serviceClosed, true);
  assert.equal(cleanup.directoriesRemoved, false);
  assert.ok(instance.order.includes('app-stop'));
  assert.ok(instance.order.lastIndexOf('close') > instance.order.lastIndexOf('pause'));
});

/* --------------------------------- 报告 --------------------------------- */

test('live 的指标口径：mode=live、policy=live，repeatedFailures 保持 unknown 并写明原因', async () => {
  const { result, out } = await live([{ verb: 'turn' }], {
    tables: {
      usage_samples: [
        {
          id: 's1',
          at: '2026-09-11T09:00:00.000Z',
          source: 'protocol',
          phase: 'poll',
          windows: [{ name: '5h', usedPercent: 11 }],
        },
        {
          id: 's2',
          at: '2026-09-11T09:30:00.000Z',
          source: 'protocol',
          phase: 'poll',
          windows: [{ name: '5h', usedPercent: 14.5 }],
        },
      ],
    },
  });
  const metrics = result.metrics!;
  assert.equal(metrics.config.mode, 'live');
  assert.equal(metrics.config.policy, 'live');
  assert.equal(metrics.repeatedFailures, 'unknown');
  assert.match(metrics.repeatedFailuresSource, /agent-cli/);
  assert.match(metrics.repeatedFailuresSource, /无法与 fixture 比较/);
  assert.notEqual(metrics.cost, 'unknown');
  assert.deepEqual(metrics.cost === 'unknown' ? undefined : metrics.cost.byWindow, { '5h': 3.5 });
  assert.equal(existsSync(join(out, 'calls.jsonl')), false, '不从 events 重建 calls.jsonl');
  const facts = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'));
  assert.equal(facts.mode, 'live');
  assert.equal(facts.policy, 'live');
  assert.deepEqual(facts.budget, { turns: 3 });
  // 同一份身份既进指标又写文件，所以 `metrics <运行目录>` 会得到同一个 wallMs。
  assert.equal(metrics.time.wallMs, facts.wallMs);
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'labels.json'), 'utf8')).staleMemoryIds, ['stale-0']);
});

test('summary.md 带 live 固定标注、每条发现的原文，以及 invariants 不决定退出码的说明', async () => {
  const items: ItemView[] = [
    {
      id: 'item-1',
      title: '使用数据发现：bulkexport 入口太深',
      summary: '批量导出的入口只在归档看板页脚，要三次点击。',
      nextStep: '把入口提到首页并观察访问次数。',
      kind: 'issue',
      status: 'investigating',
      evidence: ['[evidence-1] /usage 样本：visits=14'],
    },
    {
      id: 'item-2',
      title: '与埋入功能无关的事项',
      summary: '不该出现在发现清单里。',
      nextStep: '',
      kind: 'opportunity',
      status: 'open',
      evidence: [],
    },
  ];
  const { result } = await live([{ verb: 'turn' }], { items, tables: { items } });
  assert.match(result.summary, /live 结果是隔离环境下的模型验证，不是真实业务效果；一次运行是一次抽样/);
  assert.match(result.summary, /## 每条发现的原文/);
  assert.match(result.summary, /发现率是\*\*文本匹配\*\*得出的下限判据，不是人工评分/);
  assert.match(result.summary, /使用数据发现：bulkexport 入口太深/);
  assert.match(result.summary, /批量导出的入口只在归档看板页脚/);
  assert.match(result.summary, /bulkexport（buried-entrance\/entrance）/);
  assert.match(result.summary, /还有 1 条事项没有提到任何埋入的功能 ID/);
  assert.match(result.summary, /Invariants（逐条评估，但不决定退出码）/);
  assert.match(result.summary, /模式：live · 策略：live/);
  assert.match(result.summary, /connectionMode app-follower/);
  assert.equal(result.invariants.length, 1);
  assert.equal(result.invariants[0].ok, true);
});

test('invariant 不成立不影响退出码：它在 live 下是被测量的对象', async () => {
  const { result } = await live([{ verb: 'turn' }], { decision: 'stop' });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stop.reason, 'timeline-finished');
  assert.equal(result.invariants[0].ok, false);
  assert.match(result.summary, /FAIL every-turn-produced-a-continuity-block/);
});

/* ------------------------------- 生产工厂 ------------------------------- */

test('生产工厂在 MORROW_TEST_MODE=1 下拒绝启动', async () => {
  assert.equal(process.env.MORROW_TEST_MODE, '1', 'harness/env.ts 在 import 时就设了测试模式');
  await assert.rejects(
    () =>
      productionDeps().startService({
        home: join(workspace(), 'home'),
        projectPath: workspace(),
        project: { name: 'x', goal: 'y' },
      }),
    /MORROW_TEST_MODE=1/
  );
});

test('停止原因到退出码的映射就是提案第 6 节的那张表', () => {
  assert.deepEqual(stopExitCodes, {
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
  });
});
