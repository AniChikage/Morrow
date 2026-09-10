import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runScenario } from './fixture.ts';
import type { Scenario } from './scenario.ts';

const usage = `用法：
  node scripts/acceptance/run.ts run <scenario> [--mode fixture] [--policy careful] [--out <目录>] [--keep] [--seed <n>]
  node scripts/acceptance/run.ts list
  node scripts/acceptance/run.ts compare | metrics   （尚未实现）`;

const scenarioDir = new URL('./scenarios/', import.meta.url);

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') return finish(usage, 0);
  if (command === 'compare' || command === 'metrics') return finish(`${command} not implemented in this step`, 2);
  if (command === 'list') return list();
  if (command !== 'run') return finish(`未知子命令 ${command}\n${usage}`, 2);

  const id = rest.find((arg) => !arg.startsWith('--'));
  if (!id) return finish(`run 需要场景 ID\n${usage}`, 2);
  const options = {
    mode: (flag(rest, 'mode') || 'fixture') as 'fixture' | 'live',
    policy: flag(rest, 'policy') || 'careful',
    out: flag(rest, 'out'),
    keep: rest.includes('--keep'),
    seed: flag(rest, 'seed') === undefined ? undefined : Number(flag(rest, 'seed')),
  };
  const scenario = await load(id);
  const result = await runScenario(scenario, options);
  console.log(result.summary);
  if (!result.ok) return finish(`场景 ${id} 未通过：\n- ${result.failures.join('\n- ')}`, 1);
  return finish(`场景 ${id} 通过，报告写入 ${result.out}`, 0);
}

async function list() {
  const ids = readdirSync(scenarioDir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => name.slice(0, -3))
    .sort();
  for (const id of ids) {
    const scenario = await load(id);
    const turns = scenario.timeline.filter((step) => step.verb === 'turn').length;
    console.log(
      `${id.padEnd(12)} ${scenario.title} · ${turns} 轮 · ${scenario.timeline.length} 步 · 目标：${scenario.goal}`
    );
  }
  return finish('', 0);
}

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

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
