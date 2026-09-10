import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureNotice, runScenario } from './fixture.ts';
import { computeMetrics, policySelfCheck, unknown } from './metrics.ts';
import { aggregate, aggregateSection, compare, reportInput, writeMetrics } from './report.ts';
import type { RunOptions, RunResult } from './fixture.ts';
import type { Scenario } from './scenario.ts';

const usage = `用法：
  node scripts/acceptance/run.ts run <scenario|all> [--mode fixture] [--policy careful|naive|careful,naive]
                                     [--repeat N] [--out <目录>] [--keep] [--seed <n>]
  node scripts/acceptance/run.ts compare <运行目录A> <运行目录B> [--ignore-volatile]
  node scripts/acceptance/run.ts metrics <运行目录|数据目录> [--out <文件>]
  node scripts/acceptance/run.ts list`;

const scenarioDir = new URL('./scenarios/', import.meta.url);

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') return finish(usage, 0);
  if (command === 'list') return list();
  if (command === 'compare') return compareRuns(rest);
  if (command === 'metrics') return metricsFor(rest);
  if (command !== 'run') return finish(`未知子命令 ${command}\n${usage}`, 2);

  const id = rest.find((arg) => !arg.startsWith('--'));
  if (!id) return finish(`run 需要场景 ID 或 all\n${usage}`, 2);
  const policies = (flag(rest, 'policy') || 'careful').split(',').filter(Boolean);
  const repeat = Number(flag(rest, 'repeat') || '1');
  if (!Number.isInteger(repeat) || repeat < 1) return finish('--repeat 需要一个不小于 1 的整数', 2);
  const options: RunOptions = {
    mode: (flag(rest, 'mode') || 'fixture') as 'fixture' | 'live',
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

/** One scenario with one policy, once or `--repeat N` times with a mean/min/max report. */
async function runOne(scenario: Scenario, policy: string, options: RunOptions, repeat: number) {
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
    const check = policySelfCheck(careful, naive);
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
