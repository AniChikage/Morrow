import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveUsageError, liveDefaults, prepareLive, runLive } from './live.ts';
import { computeMetrics, policySelfCheck, unknown } from './metrics.ts';
import { aggregate, aggregateSection, compare, reportInput, writeMetrics } from './report.ts';
import type { LiveOptions } from './live.ts';
import type { RunOptions, RunResult } from './fixture.ts';
import type { Scenario } from './scenario.ts';

const usage = `用法：
  node scripts/acceptance/run.ts run <scenario|all> [--mode fixture] [--policy careful|naive|careful,naive]
                                     [--repeat N] [--out <目录>] [--keep] [--seed <n>]
  node scripts/acceptance/run.ts prepare <scenario> --mode live [--run-id <id>] [--budget N] [--out <目录>]
  node scripts/acceptance/run.ts run <scenario> --mode live --run-id <id> --budget N
                                     [--project-limit ${liveDefaults.projectLimit}] [--project-window ${liveDefaults.projectWindow}]
                                     [--reserve ${liveDefaults.reserve}] [--reserve-window ${liveDefaults.reserveWindow}]
                                     [--advance-scale ${liveDefaults.advanceScale}] [--max-wait ${liveDefaults.maxWaitMinutes}]
                                     [--wait-bind ${liveDefaults.waitBindMinutes}] [--turn-timeout ${liveDefaults.turnTimeoutMinutes}]
                                     [--approval-wait ${liveDefaults.approvalWaitMinutes}]
                                     [--review-timeout ${liveDefaults.reviewTimeoutMinutes}] [--wall-clock ${liveDefaults.wallClockMinutes}]
  node scripts/acceptance/run.ts compare <运行目录A> <运行目录B> [--ignore-volatile]
  node scripts/acceptance/run.ts metrics <运行目录|数据目录> [--out <文件>]
  node scripts/acceptance/run.ts list

live 模式分两步：prepare 建目录、写种子、打印人要在 Codex App 里做的四步；人做完之后再 run 同一个 --run-id。
一次 live 运行真的驱动 Codex App 并消耗账户额度：--budget 必填，没有缺省；--policy 和 run all 在 live 下被拒绝。
时间单位都是分钟；--project-limit / --reserve 是百分比。
发布确认永远是人做的：stdin 是 TTY 时 run 会在终端上问一次（--approval-wait），输入 approve/reject 就以人的身份
走服务的审阅路径并继续时间线；不是 TTY、直接回车或超时都停在人工确认。runner 没有自批准的路径。`;

const scenarioDir = new URL('./scenarios/', import.meta.url);
/** Loaded on demand: `fixture.ts` imports `tests/harness/env.ts`, which sets `MORROW_TEST_MODE=1` at
 * import time — a live run must never see that, or the service builds a desktop fixture transport. */
const fixture = () => import('./fixture.ts');

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') return finish(usage, 0);
  if (command === 'list') return list();
  if (command === 'compare') return compareRuns(rest);
  if (command === 'metrics') return metricsFor(rest);
  if (command === 'prepare') return prepareRun(rest);
  if (command !== 'run') return finish(`未知子命令 ${command}\n${usage}`, 2);

  const id = rest.find((arg) => !arg.startsWith('--'));
  if (!id) return finish(`run 需要场景 ID 或 all\n${usage}`, 2);
  const mode = flag(rest, 'mode') || 'fixture';
  if (mode === 'live') return runLiveScenario(id, rest);
  if (mode !== 'fixture') return finish(`未知模式 ${mode}；只有 fixture 与 live\n${usage}`, 2);
  const policies = (flag(rest, 'policy') || 'careful').split(',').filter(Boolean);
  const repeat = Number(flag(rest, 'repeat') || '1');
  if (!Number.isInteger(repeat) || repeat < 1) return finish('--repeat 需要一个不小于 1 的整数', 2);
  const options: RunOptions = {
    mode: 'fixture',
    keep: rest.includes('--keep'),
    ...(flag(rest, 'out') ? { out: flag(rest, 'out') } : {}),
    ...(flag(rest, 'seed') === undefined ? {} : { seed: Number(flag(rest, 'seed')) }),
  };
  if (id === 'all') {
    if (repeat > 1) return finish('run all 不接受 --repeat；重复运行请指定单个场景', 2);
    return runAll(policies, options);
  }
  if (policies.length > 1) return finish('单个场景一次只跑一种策略；用 run all 跑矩阵', 2);
  let scenario;
  try {
    scenario = await load(id);
  } catch (error) {
    return finish(error instanceof Error ? error.message : String(error), 2);
  }
  return runOne(scenario, policies[0], options, repeat);
}

/**
 * Step one of a live run: make the report directory, write the seed project into it, leave
 * `prepared.json`, and print the four steps a person has to take in the Codex App — Morrow cannot
 * create an App task, so a live run has to be started by a human. Nothing is launched here.
 */
async function prepareRun(rest: string[]) {
  const id = rest.find((arg) => !arg.startsWith('--'));
  if (!id) return finish(`prepare 需要场景 ID\n${usage}`, 2);
  if (id === 'all') return finish('prepare 只接受单个场景；一次 live 运行只跑一个场景', 2);
  const mode = flag(rest, 'mode') || 'live';
  if (mode !== 'live') return finish(`prepare 只用于 live 模式（收到 --mode ${mode}）\n${usage}`, 2);
  let scenario;
  try {
    scenario = await load(id);
  } catch (error) {
    return finish(error instanceof Error ? error.message : String(error), 2);
  }
  const budget = number(rest, 'budget');
  try {
    const prepared = prepareLive(scenario, {
      ...(flag(rest, 'run-id') ? { runId: flag(rest, 'run-id')! } : {}),
      ...(flag(rest, 'out') ? { out: flag(rest, 'out')! } : {}),
      ...(budget === undefined ? {} : { budget }),
    });
    return finish(`已写入 ${join(prepared.root, 'prepared.json')}`, 0);
  } catch (error) {
    return finish(error instanceof Error ? error.message : String(error), error instanceof LiveUsageError ? 2 : 1);
  }
}

/**
 * Step two: start the isolated service with the production App follower, wait for the task the
 * person created, bind it, and run the timeline against a real model. Only a run that broke itself
 * exits non-zero (decision 4); what the model did is reported as metrics.
 */
async function runLiveScenario(id: string, rest: string[]) {
  if (id === 'all') return finish('run all 在 live 模式下被拒绝：一次 live 运行只跑一个场景', 2);
  if (flag(rest, 'policy') !== undefined)
    return finish('--policy 在 live 模式下被拒绝：干这件事的是真实 App 任务里的模型，config.policy 记作 live', 2);
  if (flag(rest, 'repeat') !== undefined)
    return finish('--repeat 在 live 模式下被拒绝：每次 live 运行都要单独 prepare，并单独付额度', 2);
  const runId = flag(rest, 'run-id');
  if (!runId) return finish(`--run-id 必填：先 prepare，再用同一个 run-id run\n${usage}`, 2);
  const budget = number(rest, 'budget');
  if (budget === undefined)
    return finish('--budget 必填，没有缺省：一次 live 运行真的消耗账户额度。第一次建议 --budget 3', 2);
  let scenario;
  try {
    scenario = await load(id);
  } catch (error) {
    return finish(error instanceof Error ? error.message : String(error), 2);
  }
  let options: LiveOptions;
  try {
    options = {
      runId,
      budget,
      ...pick(rest, 'project-limit', 'projectLimit'),
      ...pick(rest, 'reserve', 'reserve'),
      ...pick(rest, 'advance-scale', 'advanceScale'),
      ...pick(rest, 'max-wait', 'maxWaitMinutes'),
      ...pick(rest, 'wait-bind', 'waitBindMinutes'),
      ...pick(rest, 'turn-timeout', 'turnTimeoutMinutes'),
      ...pick(rest, 'approval-wait', 'approvalWaitMinutes'),
      ...pick(rest, 'review-timeout', 'reviewTimeoutMinutes'),
      ...pick(rest, 'wall-clock', 'wallClockMinutes'),
      ...window(rest, 'project-window', 'projectWindow'),
      ...window(rest, 'reserve-window', 'reserveWindow'),
      ...(flag(rest, 'out') ? { out: flag(rest, 'out')! } : {}),
    };
  } catch (error) {
    return finish(error instanceof Error ? error.message : String(error), 2);
  }
  let result;
  try {
    result = await runLive(scenario, options);
  } catch (error) {
    return finish(error instanceof Error ? error.message : String(error), error instanceof LiveUsageError ? 2 : 1);
  }
  console.log(result.summary);
  if (result.exitCode === 0)
    return finish(`live 运行结束：${result.stop.reason} · ${result.stop.detail}\n报告写入 ${result.out}`, 0);
  return finish(
    `live 运行未完成（${result.stop.reason}）：\n- ${[result.stop.detail, ...result.failures].join('\n- ')}\n报告写入 ${result.out}`,
    result.exitCode
  );
}

/** One numeric live flag, absent when not given; a malformed value is a usage error, not a default. */
function number(args: string[], name: string): number | undefined {
  const raw = flag(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new LiveUsageError(`--${name} 需要一个数字，收到 ${raw}`);
  return value;
}

const pick = (args: string[], name: string, key: string) => {
  const value = number(args, name);
  return value === undefined ? {} : { [key]: value };
};

const window = (args: string[], name: string, key: string) => {
  const raw = flag(args, name);
  if (raw === undefined) return {};
  if (raw !== '5h' && raw !== 'weekly') throw new LiveUsageError(`--${name} 只能是 5h 或 weekly，收到 ${raw}`);
  return { [key]: raw };
};

/** One scenario with one policy, once or `--repeat N` times with a mean/min/max report. */
async function runOne(scenario: Scenario, policy: string, options: RunOptions, repeat: number) {
  const { runScenario, fixtureNotice } = await fixture();
  if (repeat === 1) {
    const result = await runScenario(scenario, { ...options, policy });
    console.log(result.summary);
    if (!result.ok) return finish(`场景 ${scenario.id} 未通过：\n- ${result.failures.join('\n- ')}`, 1);
    return finish(`场景 ${scenario.id} 通过，报告写入 ${result.out}`, 0);
  }
  const root = resolve(options.out || join(repoRoot, 'artifacts', 'acceptance', `${scenario.id}-${policy}-repeat`));
  mkdirSync(root, { recursive: true });
  const results: RunResult[] = [];
  for (let pass = 1; pass <= repeat; pass++)
    results.push(await runScenario(scenario, { ...options, policy, out: join(root, `run-${pass}`) }));
  const values = aggregate(results.flatMap((row) => (row.metrics ? [row.metrics] : [])));
  const summary = [
    `# ${scenario.title}（${scenario.id}）× ${repeat} 次`,
    '',
    fixtureNotice,
    '',
    `- 策略：${policy} · 通过：${results.filter((row) => row.ok).length}/${repeat}`,
    ...results.map((row, index) => `- run-${index + 1}：${row.ok ? 'passed' : 'failed'} · ${row.out}`),
    '',
    ...aggregateSection(values),
  ].join('\n');
  writeFileSync(join(root, 'summary.md'), summary);
  writeMetrics(root, { scenario: scenario.id, policy, repeat, runs: results.map((row) => row.out), aggregate: values });
  console.log(summary);
  const failed = results.filter((row) => !row.ok).length;
  if (failed) return finish(`${failed}/${repeat} 次运行未通过，报告写入 ${root}`, 1);
  return finish(`${repeat} 次运行全部通过，报告写入 ${root}`, 0);
}

/** Every scenario under `scenarios/` with every listed policy, plus the harness self-check. */
async function runAll(policies: string[], options: RunOptions) {
  const { runScenario } = await fixture();
  const scenarios = await Promise.all(ids().map(load));
  const rows: Array<{ scenario: string; policy: string; result: RunResult }> = [];
  for (const scenario of scenarios)
    for (const policy of policies) {
      const out = options.out ? join(options.out, `${scenario.id}-${policy}`) : undefined;
      const result = await runScenario(scenario, { ...options, policy, ...(out ? { out } : {}) });
      rows.push({ scenario: scenario.id, policy, result });
    }
  console.log(matrix(rows));

  const problems: string[] = [];
  for (const { policy, result } of rows)
    if (!result.ok && policy === 'careful')
      problems.push(`careful 在 ${result.scenario} 未通过：${result.failures.join('；')}`);
  for (const scenario of scenarios) {
    const careful = rows.find((row) => row.scenario === scenario.id && row.policy === 'careful')?.result.metrics;
    const naive = rows.find((row) => row.scenario === scenario.id && row.policy === 'naive')?.result.metrics;
    if (!careful || !naive) continue;
    const check = policySelfCheck(careful, naive, scenario.selfCheck);
    console.log(selfCheckTable(scenario.id, check));
    if (!check.ok)
      problems.push(
        `${scenario.id} 的自检未通过：${check.rows
          .filter((row) => !row.ok)
          .map((row) => `${row.metric}（${row.detail}）`)
          .join('；')}`
      );
  }
  if (problems.length) return finish(`- ${problems.join('\n- ')}`, 1);
  return finish('全部 careful 运行通过，naive 在约定指标上劣于 careful。', 0);
}

function matrix(rows: Array<{ scenario: string; policy: string; result: RunResult }>) {
  return [
    '## 场景 × 策略',
    '',
    '| 场景 | 策略 | 结果 | 轮次 | 复核 | 护栏定义/抓到 | 引用采集证据的复盘 | 跟随过期经验 | 重复失败 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(({ scenario, policy, result }) => {
      const m = result.metrics;
      const guard = m ? `${m.guardrails.defined}/${m.guardrails.violationsCaught}` : unknown;
      const stale = m && typeof m.staleMemory === 'object' ? m.staleMemory.followed : unknown;
      const repeated = m && typeof m.repeatedFailures === 'object' ? m.repeatedFailures.groups : unknown;
      const cited = m ? m.reviewsCitingCapturedEvidence : unknown;
      return `| ${scenario} | ${policy} | ${result.ok ? 'passed' : 'failed'} | ${result.turns} | ${result.reviews} | ${guard} | ${cited} | ${stale} | ${repeated} |`;
    }),
    '',
  ].join('\n');
}

function selfCheckTable(scenario: string, check: ReturnType<typeof policySelfCheck>) {
  return [
    `## 自检：${scenario}（naive 必须更差）`,
    '',
    '| 指标 | careful | naive | 期望 | 结果 |',
    '| --- | --- | --- | --- | --- |',
    ...check.rows.map(
      (row) => `| ${row.metric} | ${row.careful} | ${row.naive} | ${row.expected} | ${row.ok ? 'PASS' : 'FAIL'} |`
    ),
    '',
  ].join('\n');
}

function compareRuns(rest: string[]) {
  const [a, b] = rest.filter((arg) => !arg.startsWith('--'));
  if (!a || !b) return finish(`compare 需要两个运行目录\n${usage}`, 2);
  const result = compare(a, b, { ignoreVolatile: rest.includes('--ignore-volatile') });
  console.log(result.markdown);
  return finish('', 0);
}

/**
 * The same metrics for any report directory or any Morrow data directory, read-only. A data
 * directory has no labels, so the label-dependent metrics come back `unknown` rather than 0.
 */
function metricsFor(rest: string[]) {
  const [dir] = rest.filter((arg) => !arg.startsWith('--'));
  if (!dir) return finish(`metrics 需要一个运行目录或数据目录\n${usage}`, 2);
  let input;
  try {
    input = reportInput(dir);
  } catch (error) {
    return finish(error instanceof Error ? error.message : String(error), 2);
  }
  const metrics = computeMetrics(input);
  const target = flag(rest, 'out');
  if (target) writeFileSync(resolve(target), JSON.stringify(metrics, null, 2) + '\n');
  else console.log(JSON.stringify(metrics, null, 2));
  return finish(target ? `指标写入 ${resolve(target)}` : '', 0);
}

async function list() {
  for (const id of ids()) {
    const scenario = await load(id);
    const turns = scenario.timeline.filter((step) => step.verb === 'turn').length;
    console.log(
      `${id.padEnd(12)} ${scenario.title} · ${turns} 轮 · ${scenario.timeline.length} 步 · 目标：${scenario.goal}`
    );
  }
  return finish('', 0);
}

const ids = () =>
  readdirSync(scenarioDir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => name.slice(0, -3))
    .sort();

async function load(id: string): Promise<Scenario> {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`场景 ID 只能包含小写字母、数字和连字符：${id}`);
  const path = fileURLToPath(new URL(`./scenarios/${id}.ts`, import.meta.url));
  const module = await import(path).catch(() => {
    throw new Error(`找不到场景 ${id}；用 list 查看可用场景`);
  });
  return module.default as Scenario;
}

function flag(args: string[], name: string) {
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('--')) return args[index + 1];
  return args
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');
}

function finish(text: string, code: number) {
  if (text) (code ? console.error : console.log)(text);
  process.exitCode = code;
}

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
