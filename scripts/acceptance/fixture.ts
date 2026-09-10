import { mock } from 'node:test';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import '../../tests/harness/env.ts';
import { startIsolated } from '../../tests/harness/service.ts';
import { startReceiver } from '../../tests/harness/receiver.ts';
import { grantFor } from '../../tests/harness/grant.ts';
import { ScriptedNativeTransport } from '../../tests/harness/scripted-native.ts';
import { policies } from './fake-agent.ts';
import { policyScenario } from './scenario.ts';
import { drain, runStep, stopScheduler } from './timeline.ts';
import type { Runner } from './timeline.ts';
import type { CallRecord, InvariantResult, Scenario, TimelineRecord } from './scenario.ts';
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
  invariants: InvariantReport[];
  failures: string[];
  summary: string;
};

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Runs one scenario in this process against a real service on a temporary data directory. Nothing
 * calls a model, nothing leaves loopback, and the user's data directory is never touched: the native
 * backend is `ScriptedNativeTransport` and the outside world is a local receiver.
 */
export async function runScenario(scenario: Scenario, options: RunOptions = {}): Promise<RunResult> {
  if (options.mode && options.mode !== 'fixture')
    throw new Error(`mode ${options.mode} is not implemented in this step; only fixture runs exist`);
  const policyName = options.policy || 'careful';
  const turnPolicy = policies[policyName];
  if (!turnPolicy) throw new Error(`unknown policy ${policyName}; available: ${Object.keys(policies).join(', ')}`);
  // The run id is taken before the clock is frozen, so repeated runs never share an output directory.
  const runId = `${scenario.id}-${policyName}-${stamp()}-${randomUUID().slice(0, 8)}`;
  const out = resolve(options.out || join(repoRoot, 'artifacts', 'acceptance', runId));
  mkdirSync(out, { recursive: true });

  const failures: string[] = [];
  const timeline: TimelineRecord[] = [];
  let invariants: InvariantReport[] = [];
  let service: IsolatedService | undefined;
  let transport: ScriptedNativeTransport | undefined;
  const cleanup = {
    channelsPaused: 0,
    serviceClosed: false,
    directoriesRemoved: false,
    root: '',
    keep: !!options.keep,
  };

  mock.timers.enable({ apis: ['Date'], now: new Date(virtualStart) });
  const receiver = await startReceiver({ feedback: scenario.feedback.initial });
  try {
    const view = policyScenario(scenario, receiver.url);
    service = await startIsolated({
      nativeTransport: ({ home, path }) => {
        transport = new ScriptedNativeTransport({ home, projectPath: path, scenario: view, turnPolicy });
        return transport;
      },
      project: {
        name: scenario.title,
        goal: scenario.goal,
        ...(scenario.brief === undefined ? {} : { brief: scenario.brief }),
        files: seedFiles(scenario),
      },
    });
    cleanup.root = service.root;
    stopScheduler(service);
    transport!.attach(service);
    await service.api('POST', `/api/channels/${service.channel.id}/native/bind`, { threadId: transport!.threadId });
    await seedMemory(service, scenario);
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
        timeline.push(await runStep(runner, step, index));
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
      ...safeCheck(row, { store: service!.store, service: service!, transport: transport!, receiver, timeline }),
    }));
    failures.push(...invariants.filter((row) => !row.ok).map((row) => `invariant ${row.name}: ${row.detail}`));
  } catch (error) {
    failures.push(message(error));
  } finally {
    if (service) {
      cleanup.channelsPaused = await pauseChannels(service);
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
    invariants,
    failures,
    summary: '',
  };
  result.summary = summaryMarkdown(scenario, result, options);
  writeFileSync(join(out, 'timeline.jsonl'), lines(timeline));
  writeFileSync(join(out, 'calls.jsonl'), lines(result.calls));
  writeFileSync(join(out, 'cleanup.json'), JSON.stringify(cleanup, null, 2) + '\n');
  writeFileSync(join(out, 'summary.md'), result.summary);
  return result;
}

function seedFiles(scenario: Scenario): Record<string, string> {
  if (scenario.project.seedDir) return readSeedDir(scenario.project.seedDir);
  return scenario.project.files || {};
}

/** Reads a seed directory verbatim into the file map `startIsolated` writes into the project. */
function readSeedDir(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const next = join(current, entry.name);
      if (entry.isDirectory()) walk(next, name);
      else files[name] = readFileSync(next, 'utf8');
    }
  };
  walk(resolve(dir), '');
  return files;
}

/** Writes the scenario's planted memory through the real work interface, before any turn runs. */
async function seedMemory(service: IsolatedService, scenario: Scenario) {
  if (!scenario.memory.length) return;
  // `native-app` keeps this preparation run out of the channel's daily scheduling budget.
  const grant = grantFor(service, {
    projectId: service.project.id,
    channelId: service.channel.id,
    overrides: { source: 'native-app', summary: '场景预置记忆' },
  });
  for (const seed of scenario.memory) await grant.call(seed.operation, seed.input);
  service.store.put('runs', {
    ...(service.store.get<Run>('runs', grant.run.id) as Run),
    status: 'completed',
    finishedAt: new Date().toISOString(),
  });
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
    `- 产物目录：${result.out}`,
    '',
    '## Invariants',
    '',
    ...(result.invariants.length
      ? result.invariants.map((row) => `- ${row.ok ? 'PASS' : 'FAIL'} ${row.name} — ${row.detail}`)
      : ['- 未执行（运行提前失败）']),
    '',
    ...(result.failures.length ? ['## 失败原因', '', ...result.failures.map((row) => `- ${row}`), ''] : []),
  ].join('\n');
}

const lines = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const stamp = () => new Date().toISOString().replaceAll(':', '-').replace('.', '-');
