import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { matchedName, namesFeature, unknown } from './metrics.ts';
import type { Metrics, MetricsInput } from './metrics.ts';
import type { CallRecord, Labels, TimelineRecord } from './scenario.ts';

/** Which runner produced a report. It changes the fixed caveat, not the metrics. */
export type ReportMode = 'fixture' | 'live';

/**
 * The sentence every live report carries. A live run is one sample of one model in one isolated
 * environment: the feedback samples, the receiver and the usage data are all built on this machine.
 */
export const liveNotice =
  'live 结果是隔离环境下的模型验证，不是真实业务效果；一次运行是一次抽样。反馈样本、接收端和使用数据都是本机构造的。';

export type Scalar = string | number | boolean | null;
export type Flat = Record<string, Scalar>;

/** Every metrics file is written here, so `compare` and `metrics` always look in the same place. */
export const metricsFile = 'metrics.json';

export function writeMetrics(out: string, metrics: unknown) {
  writeFileSync(join(out, metricsFile), JSON.stringify(metrics, null, 2) + '\n');
}

/** `<dir>/metrics.json`, or the file itself when a path to one is given. */
export function readMetrics(path: string): unknown {
  const file = statSync(path).isDirectory() ? join(path, metricsFile) : path;
  if (!existsSync(file)) throw new Error(`找不到 ${file}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * Everything `metrics <dir>` reads. A report directory keeps its data directory under `home/` (only
 * with `--keep`) plus the labels, calls, timeline and run identity beside it; a Morrow data
 * directory holds `workspace.sqlite` itself and no labels at all, so the label-dependent metrics
 * come back `unknown`. Used by the CLI and by the test that checks the two agree.
 */
export function reportInput(dir: string): MetricsInput {
  const root = resolve(dir);
  const home = existsSync(join(root, 'workspace.sqlite'))
    ? root
    : existsSync(join(root, 'home', 'workspace.sqlite'))
      ? join(root, 'home')
      : '';
  if (!home) throw new Error(`${root} 里没有 workspace.sqlite，也没有 home/workspace.sqlite`);
  const labels = readJSON<Labels>(join(root, 'labels.json'));
  const calls = readLines<CallRecord>(join(root, 'calls.jsonl'));
  const timeline = readLines<TimelineRecord>(join(root, 'timeline.jsonl'));
  const run = readJSON<NonNullable<MetricsInput['run']>>(join(root, 'run.json'));
  return {
    home,
    ...(labels ? { labels } : {}),
    ...(calls ? { calls } : {}),
    ...(timeline ? { timeline } : {}),
    ...(run ? { run } : {}),
  };
}

function readJSON<T>(file: string): T | undefined {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : undefined;
}

function readLines<T>(file: string): T[] | undefined {
  if (!existsSync(file)) return undefined;
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

/** Dotted leaf paths, so two metrics objects can be diffed and averaged key by key. */
export function flatten(value: unknown, prefix = ''): Flat {
  if (value === null || typeof value !== 'object') return { [prefix]: value as Scalar };
  const result: Flat = {};
  const entries = Array.isArray(value)
    ? value.map((row, index) => [String(index), row] as const)
    : Object.entries(value as Record<string, unknown>);
  if (!entries.length) return { [prefix]: '' };
  for (const [key, row] of entries) Object.assign(result, flatten(row, prefix ? `${prefix}.${key}` : key));
  return result;
}

const idLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[0-9a-f]{32}$/i;
const volatileNames = new Set(['id', 'ids', 'out', 'home', 'root', 'path', 'wallMs', 'runId', 'runIds']);

/**
 * Ids, timestamps, wall-clock durations, run ids and paths differ between two runs of the same
 * scenario by construction. `--ignore-volatile` drops them, so two careful runs must show no
 * differences at all.
 */
export function isVolatile(key: string): boolean {
  return key.split('.').some((part) => volatileNames.has(part) || /(Id|Ids|At|Ms)$/.test(part) || idLike.test(part));
}

export type Difference = { key: string; a: Scalar | undefined; b: Scalar | undefined };
export type Comparison = { differences: Difference[]; compared: number; ignored: number; markdown: string };

/** Markdown diff table of two `metrics.json` files (or of the report directories holding them). */
export function compare(a: string, b: string, options: { ignoreVolatile?: boolean } = {}): Comparison {
  const left = flatten(readMetrics(a));
  const right = flatten(readMetrics(b));
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  const kept = options.ignoreVolatile ? keys.filter((key) => !isVolatile(key)) : keys;
  const differences = kept
    .filter((key) => serialize(left[key]) !== serialize(right[key]))
    .map((key) => ({ key, a: left[key], b: right[key] }));
  const markdown = [
    `# metrics 对比`,
    '',
    `- A：${a}`,
    `- B：${b}`,
    `- 比较了 ${kept.length} 个指标键${options.ignoreVolatile ? `，忽略 ${keys.length - kept.length} 个易变键（ID、时间戳、墙钟时长、路径）` : ''}`,
    `- 差异：${differences.length}`,
    '',
    ...(differences.length
      ? [
          '| 指标 | A | B |',
          '| --- | --- | --- |',
          ...differences.map((row) => `| ${row.key} | ${cell(row.a)} | ${cell(row.b)} |`),
        ]
      : ['两份报告在比较范围内完全一致。']),
    '',
  ].join('\n');
  return { differences, compared: kept.length, ignored: keys.length - kept.length, markdown };
}

export type Aggregate = Record<string, { mean: number; min: number; max: number; runs: number }>;

/** Mean, min and max per numeric metric across the runs of one `--repeat N` batch. */
export function aggregate(runs: unknown[]): Aggregate {
  const flat = runs.map((row) => flatten(row));
  const result: Aggregate = {};
  for (const key of [...new Set(flat.flatMap((row) => Object.keys(row)))].sort()) {
    const values = flat.map((row) => row[key]).filter((value): value is number => typeof value === 'number');
    if (!values.length) continue;
    result[key] = {
      mean: Math.round((values.reduce((total, value) => total + value, 0) / values.length) * 100) / 100,
      min: Math.min(...values),
      max: Math.max(...values),
      runs: values.length,
    };
  }
  return result;
}

/**
 * How much the live run compressed the scenario's observation waits, and what that makes
 * incomparable. A scale of 1 is no compression, and says so rather than staying silent.
 */
export function scaleNote(advanceScale: number): string[] {
  if (advanceScale >= 1)
    return ['观察窗口没有被压缩（`--advance-scale 1`）：每个 `advance` 都真实等了场景写的分钟数。'];
  return [
    `观察窗口被压缩了 ${Math.round(10 / (advanceScale * 10)) === 0 ? (1 / advanceScale).toFixed(1) : String(Math.round(1 / advanceScale))} 倍（\`--advance-scale ${advanceScale}\`）：` +
      '每个 `advance N` 只真实等了 `N × ' +
      advanceScale +
      '` 分钟。因此 `adjustmentLatency` 的绝对分钟数**不可**与 fixture 直接比较，只能与同样缩放比例的另一次 live 运行比较。',
  ];
}

/**
 * Every finding this run filed, verbatim, so a person can spot-check it. The discovery rate is a
 * text match on the `/usage` feature id or one of the scenario's aliases for it — a lower bound, not
 * a human score: a run may name the feature without having understood the problem, and a run may
 * have understood it without naming it at all. Each hit says which name it was, so a reader can tell
 * an id match from a title match without re-deriving it.
 */
export function findingsSection(
  labels: Labels | undefined,
  items: Array<{
    id: string;
    title: string;
    summary: string;
    nextStep: string;
    kind: string;
    status: string;
    evidence: string[];
  }>
): string[] {
  const planted = (labels?.planted || []).filter((row) => !!row.feature);
  if (!planted.length) return [];
  const matched = items.filter((item) => planted.some((row) => namesFeature(item, row.feature!, row.aliases)));
  return [
    '## 每条发现的原文',
    '',
    '发现率是**文本匹配**得出的下限判据，不是人工评分：匹配规则是「事项正文里出现了那个 `/usage` 功能 ID，' +
      '或者场景给它登记的别名（数据里的中文标题）」，对夹具状态机和真实模型是同一条规则。' +
      '模型可能提到功能却没真的理解那个问题，也可能理解了却一个名字都没写——所以下面给出原文，请人抽查。',
    '',
    ...(matched.length
      ? matched.flatMap((item) => [
          `### ${item.title}`,
          '',
          `- 种类：${item.kind} · 状态：${item.status} · 命中的埋入功能：${planted
            .filter((row) => namesFeature(item, row.feature!, row.aliases))
            .map(
              (row) =>
                `${row.feature}（${row.id}/${row.kind}${row.shouldFix ? '' : '，反例：不该修'}）${hitBy(item, row)}`
            )
            .join('、')}`,
          `- 正文：${item.summary || '（空）'}`,
          `- 下一步：${item.nextStep || '（空）'}`,
          ...(item.evidence.length
            ? [`- 证据：${item.evidence.map((line) => oneLine(line)).join(' · ')}`]
            : ['- 证据：无']),
          '',
        ])
      : ['- 本次运行没有记录任何提到埋入功能 ID 的事项。', '']),
    ...(items.length > matched.length
      ? [`此外还有 ${items.length - matched.length} 条事项没有提到任何埋入的功能 ID，未列出。`, '']
      : []),
  ];
}

/**
 * Whether this item hit the planted problem by its `/usage` feature id or by one of the aliases. A
 * fixture policy writes the id; a real model usually writes the feature's own title, and the two
 * should not read the same in the report.
 */
function hitBy(
  item: { title: string; summary: string; nextStep: string },
  row: { feature?: string; aliases?: string[] }
): string {
  const hit = matchedName(item, row.feature!, row.aliases);
  return hit === undefined || hit === row.feature ? '· 命中功能 ID' : `· 命中别名「${hit}」`;
}

const oneLine = (text: string) => text.replaceAll('\n', ' ').replaceAll('|', '\\|').slice(0, 300);

/** The metrics section `summary.md` carries, under the report's fixed caveat for its mode. */
export function metricsSection(metrics: Metrics | undefined, mode: ReportMode = 'fixture'): string[] {
  if (!metrics) return ['## 指标', '', '- 未计算（运行提前失败，没有可读的数据目录）', ''];
  const flat = flatten(metrics);
  // The exploration block gets its own readable section below, so it is not repeated here.
  const rows = Object.keys(flat)
    .filter((key) => !key.startsWith('config.') && !key.startsWith('usagegap.'))
    .map((key) => `| ${key} | ${cell(flat[key])} |`);
  const config = Object.keys(flat)
    .filter((key) => key.startsWith('config.'))
    .map((key) => `${key.slice('config.'.length)}=${cell(flat[key])}`);
  return [
    '## 指标',
    '',
    `全部指标从 SQLite 计算；标签相关的指标缺少 \`labels.json\` 时是 \`${unknown}\`，不是 0。`,
    '',
    '| 指标 | 取值 |',
    '| --- | --- |',
    ...rows,
    '',
    `配置：${config.join(' · ')}`,
    '',
    ...explorationSection(metrics, mode),
  ];
}

/**
 * The exploration metrics of a scenario like `usagegap`, with the caveat they must never be read
 * without. A fixture policy is a hardwired state machine, so these numbers say the framework can
 * record and compute "what was found, how it was attributed, what was wrongly fixed" — they do not
 * say a model would find any of it on its own. That is what live mode is for; there the same numbers
 * describe one real model in one isolated run, as a text-matched lower bound rather than a score.
 */
export function explorationSection(metrics: Metrics | undefined, mode: ReportMode = 'fixture'): string[] {
  const rows = metrics?.usagegap;
  if (!rows || typeof rows !== 'object') return [];
  const rate = (value: number | string) => (typeof value === 'number' ? `${value}%` : value);
  return [
    '## 探索指标',
    '',
    mode === 'live'
      ? 'live 下这些取值来自真实模型的一次运行：一次抽样，不可重复，也不能与另一次运行比"零差异"。' +
        '判定规则是事项正文里出现了埋入的 `/usage` 功能 ID 或它的别名（数据里的中文标题），是**下限判据**，' +
        '不是人工评分——每条发现的原文见下一节，上面写明了命中的是 ID 还是哪个别名。'
      : 'fixture 结果验证框架机制，不验证模型自主性：这些取值只说明「发现、附证据、归因、误修」这类判断' +
        '能被真实记录下来并算出来。两种策略都是写死的状态机，探索本身只能在 live 模式下衡量。',
    '',
    '| 指标 | 取值 | 指标键 |',
    '| --- | --- | --- |',
    `| 埋入问题发现率 | ${rows.discovered}/${rows.planted}（${rate(rows.discoveryPercent)}） | usagegap.discovered |`,
    `| 附采集证据的发现 | ${rows.findingsWithEvidence}/${rows.findings}（${rate(rows.evidencePercent)}） | usagegap.findingsWithEvidence |`,
    `| 低使用率归因正确 | ${rows.attribution.correct}/${rows.attribution.cases}（${rate(rows.attribution.percent)}）· 归错 ${rows.attribution.wrong} · 未记录 ${rows.attribution.missing} | usagegap.attribution.correct |`,
    `| 改进设了预期与观测 | ${rows.improvements.withBoth}/${rows.improvements.chosen} · 其中真的用观测核对过 ${rows.improvements.observed} | usagegap.improvements.observed |`,
    `| 误修反例 | ${rows.misFix.count}/${rows.misFix.mustNotFix}（${rate(rows.misFix.percent)}）· 命中 ${rows.misFix.ids.join('、') || '无'} | usagegap.misFix.count |`,
    '',
  ];
}

/** The aggregate table a `--repeat N` batch writes instead of a single run's metrics table. */
export function aggregateSection(values: Aggregate): string[] {
  const keys = Object.keys(values).filter((key) => !isVolatile(key));
  return [
    '## 指标（多次运行的均值与极值）',
    '',
    '| 指标 | 均值 | 最小 | 最大 | 次数 |',
    '| --- | --- | --- | --- | --- |',
    ...keys.map(
      (key) => `| ${key} | ${values[key].mean} | ${values[key].min} | ${values[key].max} | ${values[key].runs} |`
    ),
    '',
  ];
}

/**
 * `JSON.stringify` of a `Scalar` is always a quoted string, a number, `true`/`false` or `null`, so
 * a bare `<missing>` cannot collide with any real value and needs no control byte to stay distinct.
 */
const serialize = (value: Scalar | undefined) => (value === undefined ? '<missing>' : JSON.stringify(value));
const cell = (value: Scalar | undefined) =>
  value === undefined
    ? '（缺失）'
    : typeof value === 'string'
      ? value.replaceAll('|', '\\|') || '（空）'
      : String(value);
