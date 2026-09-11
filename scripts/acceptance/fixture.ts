import { mock } from 'node:test';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import '../../tests/harness/env.ts';
import { startIsolated } from '../../tests/harness/service.ts';
import { startReceiver } from '../../tests/harness/receiver.ts';
import { grantFor } from '../../tests/harness/grant.ts';
import { ScriptedNativeTransport } from '../../tests/harness/scripted-native.ts';
import { policies } from './fake-agent.ts';
import { policyScenario, projectBrief, readTree, usageURL } from './scenario.ts';
import { computeMetrics } from './metrics.ts';
import { metricsSection, writeMetrics } from './report.ts';
import { freePort, startApp } from './serve.ts';
import { drain, runStep, stopScheduler } from './timeline.ts';
import type { Runner } from './timeline.ts';
import type { AppStop, RunningApp } from './serve.ts';
import type { CallRecord, InvariantResult, Labels, Scenario, ServedApp, TimelineRecord } from './scenario.ts';
import type { Metrics } from './metrics.ts';
import type { IsolatedService } from '../../tests/harness/service.ts';
import type { Run } from '../../service/protocol.ts';

/** The sentence every report carries, so a green fixture run is never read as model validation. */
export const fixtureNotice = 'fixture 结果验证框架机制，不验证模型自主性。';
/** Virtual clock start. Fixed so two runs of the same scenario produce the same timestamps. */
export const virtualStart = '2026-02-02T09:00:00.000Z';

export type RunOptions = {
  mode?: 'fixture' | 'live';
  policy?: string;
  /** Where the run's report is written; defaults to `artifacts/acceptance/<run-id>`. */
  out?: string;
  /** Keep the temporary data and project directories instead of removing them. */
  keep?: boolean;
  /** Recorded in the report. The bundled policies are deterministic and do not read it. */
  seed?: number;
};

export type InvariantReport = InvariantResult & { name: string };
export type RunResult = {
  ok: boolean;
  runId: string;
  scenario: string;
  policy: string;
  out: string;
  turns: number;
  reviews: number;
  calls: CallRecord[];
  timeline: TimelineRecord[];
  labels: Labels;
  /** Undefined only when the run failed before a data directory existed. */
  metrics?: Metrics;
  invariants: InvariantReport[];
  /** The seed app this run served, when the scenario has a `project.serve` block. */
  app?: ServedApp;
  failures: string[];
  summary: string;
};

/** The run identity `metrics <runDir>` reads back, since no table records it. */
export type RunFacts = {
  runId: string;
  mode: 'fixture';
  scenario: string;
  scenarioVersion: string;
  policy: string;
  seed?: number;
  budget: { turns: number; reviews?: number };
  wallMs: number;
};

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Runs one scenario in this process against a real service on a temporary data directory. Nothing
 * calls a model, nothing leaves loopback, and the user's data directory is never touched: the native
 * backend is `ScriptedNativeTransport` and the outside world is a local receiver.
 */
export async function runScenario(scenario: Scenario, options: RunOptions = {}): Promise<RunResult> {
  // The CLI already refuses `--mode live`; this is the second line of defence for a direct caller.
  // A live run needs its own runner (a real App task, real quota, real clock) — see the design in
  // `docs/acceptance/LIVE-MODE-PROPOSAL.md`, which has to be confirmed before anything is built.
  if (options.mode && options.mode !== 'fixture')
    throw new Error(`mode ${options.mode} 尚未实现；先确认 docs/acceptance/LIVE-MODE-PROPOSAL.md`);
  const policyName = options.policy || 'careful';
  const turnPolicy = policies[policyName];
  if (!turnPolicy) throw new Error(`unknown policy ${policyName}; available: ${Object.keys(policies).join(', ')}`);
  // The run id is taken before the clock is frozen, so repeated runs never share an output directory.
  const runId = `${scenario.id}-${policyName}-${stamp()}-${randomUUID().slice(0, 8)}`;
  const out = resolve(options.out || join(repoRoot, 'artifacts', 'acceptance', runId));
  mkdirSync(out, { recursive: true });

  const startedAt = performance.now();
  const failures: string[] = [];
  const timeline: TimelineRecord[] = [];
  const labels: Labels = { staleMemoryIds: [], truth: [], planted: scenario.planted };
  let invariants: InvariantReport[] = [];
  let metrics: Metrics | undefined;
  let runFacts: RunFacts | undefined;
  let service: IsolatedService | undefined;
  let transport: ScriptedNativeTransport | undefined;
  let app: RunningApp | undefined;
  const cleanup = {
    channelsPaused: 0,
    serviceClosed: false,
    directoriesRemoved: false,
    root: '',
    keep: !!options.keep,
    /** The served seed app, when the scenario has one: its address and how it was stopped. */
    app: undefined as undefined | ({ url: string; pid?: number } & Partial<AppStop> & { note?: string }),
  };

  mock.timers.enable({ apis: ['Date'], now: new Date(virtualStart) });
  const receiver = await startReceiver({ feedback: scenario.feedback.initial });
  try {
    // The app's address goes into the project brief, so its port is reserved before the project
    // directory exists and the process itself is started once that directory carries the seed.
    const appUrl = scenario.project.serve ? `http://127.0.0.1:${await freePort()}` : undefined;
    const view = policyScenario(scenario, receiver.url, { ...(appUrl ? { appUrl } : {}) });
    const brief =
      scenario.brief === undefined
        ? undefined
        : projectBrief(scenario.brief, { ...(appUrl ? { appUrl } : {}), usageUrl: usageURL(scenario, receiver.url) });
    service = await startIsolated({
      nativeTransport: ({ home, path }) => {
        transport = new ScriptedNativeTransport({ home, projectPath: path, scenario: view, turnPolicy });
        return transport;
      },
      project: {
        name: scenario.title,
        goal: scenario.goal,
        ...(brief === undefined ? {} : { brief }),
        files: seedFiles(scenario),
      },
    });
    cleanup.root = service.root;
    if (scenario.project.serve && appUrl)
      app = await startApp(scenario.project.serve, { cwd: service.path, port: Number(new URL(appUrl).port) });
    stopScheduler(service);
    transport!.attach(service);
    await service.api('POST', `/api/channels/${service.channel.id}/native/bind`, { threadId: transport!.threadId });
    labels.staleMemoryIds = await seedMemory(service, scenario);
    // Reviews share the channel's UTC daily budget with turns, so the cap has to cover both.
    await service.api('PATCH', `/api/channels/${service.channel.id}`, {
      maxRunsPerDay: scenario.budget.turns + (scenario.budget.reviews || 0),
    });
    // Enabling the control directly keeps the scheduler gates in the path without the immediate turn
    // that `action(id, 'resume')` would start outside the timeline.
    service.engine.setControl(service.channel.id, { enabled: true });

    const runner: Runner = {
      scenario,
      service,
      transport: transport!,
      receiver,
      clock: {
        now: () => new Date().toISOString(),
        advance: (minutes) => mock.timers.tick(minutes * 60_000),
      },
      turnBudget: scenario.budget.turns,
    };
    for (const [index, step] of scenario.timeline.entries()) {
      try {
        const record = await runStep(runner, step, index);
        timeline.push(record);
        if (step.verb === 'set' && step.truth)
          labels.truth.push({ stepIndex: index, truth: step.truth, virtualTime: record.virtualTime });
      } catch (error) {
        timeline.push({
          index,
          verb: step.verb,
          args: step as unknown as Record<string, unknown>,
          virtualTime: runner.clock.now(),
          result: { error: message(error) },
        });
        failures.push(`step ${index} (${step.verb}): ${message(error)}`);
        break;
      }
    }
    if (transport!.turns.length > scenario.budget.turns)
      failures.push(`spent ${transport!.turns.length} turns against a budget of ${scenario.budget.turns}`);
    if (scenario.budget.reviews !== undefined && transport!.reviews > scenario.budget.reviews)
      failures.push(`spent ${transport!.reviews} reviews against a budget of ${scenario.budget.reviews}`);
    invariants = scenario.invariants.map((row) => ({
      name: row.name,
      ...safeCheck(row, {
        store: service!.store,
        service: service!,
        transport: transport!,
        receiver,
        timeline,
        ...(app ? { app: { url: app.url, ...(app.probe === undefined ? {} : { probe: app.probe }) } } : {}),
      }),
    }));
    failures.push(...invariants.filter((row) => !row.ok).map((row) => `invariant ${row.name}: ${row.detail}`));
  } catch (error) {
    failures.push(message(error));
  } finally {
    // The app the run started is its own to stop, before anything else, whether the run passed or not.
    if (app) {
      const stopped = await app.stop().catch((error) => ({ stopped: false, note: message(error) }));
      cleanup.app = { url: app.url, ...(app.pid === undefined ? {} : { pid: app.pid }), ...stopped };
    }
    if (service) cleanup.channelsPaused = await pauseChannels(service);
    runFacts = facts(scenario, runId, policyName, options, startedAt);
    if (service) {
      // Measured on the still open store, after the run's own last act, so the numbers describe
      // exactly the database the report directory carries.
      try {
        metrics = computeMetrics({
          home: service.home,
          store: service.store,
          labels,
          calls: transport?.calls || [],
          timeline,
          run: runFacts,
        });
      } catch (error) {
        failures.push(`metrics failed: ${message(error)}`);
      }
      await service.close().catch(() => {});
      cleanup.serviceClosed = true;
      // Copying after the close so the SQLite file in the report is a checkpointed, readable copy.
      if (options.keep) copyInto(out, service);
      if (!options.keep) {
        rmSync(service.root, { recursive: true, force: true });
        cleanup.directoriesRemoved = true;
      }
    }
    await receiver.close();
    mock.timers.reset();
  }

  const result: RunResult = {
    ok: !failures.length,
    runId,
    scenario: scenario.id,
    policy: policyName,
    out,
    turns: transport?.turns.length || 0,
    reviews: transport?.reviews || 0,
    calls: transport?.calls || [],
    timeline,
    labels,
    ...(metrics ? { metrics } : {}),
    invariants,
    ...(app ? { app: { url: app.url, ...(app.probe === undefined ? {} : { probe: app.probe }) } } : {}),
    failures,
    summary: '',
  };
  result.summary = summaryMarkdown(scenario, result, options);
  writeFileSync(join(out, 'timeline.jsonl'), lines(timeline));
  writeFileSync(join(out, 'calls.jsonl'), lines(result.calls));
  writeFileSync(join(out, 'cleanup.json'), JSON.stringify(cleanup, null, 2) + '\n');
  writeFileSync(join(out, 'labels.json'), JSON.stringify(labels, null, 2) + '\n');
  writeFileSync(join(out, 'run.json'), JSON.stringify(runFacts, null, 2) + '\n');
  if (metrics) writeMetrics(out, metrics);
  writeFileSync(join(out, 'summary.md'), result.summary);
  return result;
}

/** The run identity the report carries, so `metrics <runDir>` reproduces the same `config`. */
function facts(scenario: Scenario, runId: string, policy: string, options: RunOptions, startedAt: number): RunFacts {
  return {
    runId,
    mode: 'fixture',
    scenario: scenario.id,
    scenarioVersion: scenario.version,
    policy,
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    budget: {
      turns: scenario.budget.turns,
      ...(scenario.budget.reviews === undefined ? {} : { reviews: scenario.budget.reviews }),
    },
    wallMs: Math.round(performance.now() - startedAt),
  };
}

/** The seed the project directory starts from: a directory read verbatim, or the inline file map. */
function seedFiles(scenario: Scenario): Record<string, string> {
  if (scenario.project.seedDir) return readTree(scenario.project.seedDir);
  return scenario.project.files || {};
}

/**
 * Writes the scenario's planted memory through the real work interface, before any turn runs, and
 * returns the ids of the records the scenario marked stale — the labels the metrics need. A policy
 * only ever sees the records themselves, in `context`.
 */
async function seedMemory(service: IsolatedService, scenario: Scenario): Promise<string[]> {
  if (!scenario.memory.length) return [];
  // `native-app` keeps this preparation run out of the channel's daily scheduling budget.
  const grant = grantFor(service, {
    projectId: service.project.id,
    channelId: service.channel.id,
    overrides: { source: 'native-app', summary: '场景预置记忆' },
  });
  const stale: string[] = [];
  for (const seed of scenario.memory) {
    const row = await grant.call(seed.operation, seed.input);
    if (seed.stale && typeof row?.id === 'string') stale.push(row.id);
  }
  service.store.put('runs', {
    ...(service.store.get<Run>('runs', grant.run.id) as Run),
    status: 'completed',
    finishedAt: new Date().toISOString(),
  });
  return stale;
}

async function pauseChannels(service: IsolatedService) {
  let paused = 0;
  for (const channel of service.store.all<{ id: string }>('channels'))
    try {
      await service.engine.action(channel.id, 'pause');
      paused++;
    } catch {
      // A channel that is already stopped still counts as left safe.
    }
  await drain({ service });
  return paused;
}

function copyInto(out: string, service: IsolatedService) {
  try {
    cpSync(service.home, join(out, 'home'), { recursive: true });
    cpSync(service.path, join(out, 'project'), { recursive: true });
  } catch {
    // Keeping a copy is a convenience; a failure here must not fail the run.
  }
}

function safeCheck(row: { check(context: any): InvariantResult }, context: any): InvariantResult {
  try {
    return row.check(context);
  } catch (error) {
    return { ok: false, detail: `invariant threw: ${message(error)}` };
  }
}

function summaryMarkdown(scenario: Scenario, result: RunResult, options: RunOptions) {
  const verbs = new Map<string, number>();
  for (const row of result.timeline) verbs.set(row.verb, (verbs.get(row.verb) || 0) + 1);
  return [
    `# ${scenario.title}（${scenario.id}）`,
    '',
    fixtureNotice,
    '',
    `- 模式：fixture · 策略：${result.policy} · seed：${options.seed ?? 'none'} · 场景版本：${scenario.version}`,
    `- 结果：${result.ok ? 'passed' : 'failed'}`,
    `- 轮次：${result.turns}/${scenario.budget.turns} · 独立复核：${result.reviews}/${scenario.budget.reviews ?? '未设上限'}`,
    `- 工作接口调用：${result.calls.length} 次 · 时间线步骤：${result.timeline.length}/${scenario.timeline.length}`,
    `- 步骤分布：${[...verbs].map(([verb, count]) => `${verb}×${count}`).join('、') || '无'}`,
    ...(result.app ? [`- 种子应用：${result.app.url}（本次运行期间真实运行，结束时已停止）`] : []),
    `- 产物目录：${result.out}`,
    '',
    '## Invariants',
    '',
    ...(result.invariants.length
      ? result.invariants.map((row) => `- ${row.ok ? 'PASS' : 'FAIL'} ${row.name} — ${row.detail}`)
      : ['- 未执行（运行提前失败）']),
    '',
    ...metricsSection(result.metrics),
    ...(result.failures.length ? ['## 失败原因', '', ...result.failures.map((row) => `- ${row}`), ''] : []),
  ].join('\n');
}

const lines = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const stamp = () => new Date().toISOString().replaceAll(':', '-').replace('.', '-');
