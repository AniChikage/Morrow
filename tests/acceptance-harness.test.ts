import './harness/env.ts';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startIsolated } from './harness/service.ts';
import { fixtureNotice, runScenario } from '../scripts/acceptance/fixture.ts';
import { computeMetrics, policySelfCheck } from '../scripts/acceptance/metrics.ts';
import { compare, reportInput } from '../scripts/acceptance/report.ts';
import fieldnote from '../scripts/acceptance/scenarios/fieldnote.ts';
import namecheck from '../scripts/acceptance/scenarios/namecheck.ts';
import parcelnotes from '../scripts/acceptance/scenarios/parcelnotes.ts';
import relaydesk from '../scripts/acceptance/scenarios/relaydesk.ts';
import smoke from '../scripts/acceptance/scenarios/smoke.ts';
import usagegap from '../scripts/acceptance/scenarios/usagegap.ts';
import type { RunOptions, RunResult } from '../scripts/acceptance/fixture.ts';
import type { Metrics } from '../scripts/acceptance/metrics.ts';
import type { Labels, Scenario } from '../scripts/acceptance/scenario.ts';

const readLines = (file: string) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

type Ran = { result: RunResult; out: string };
const directories: string[] = [];
after(() => {
  for (const out of directories) rmSync(out, { recursive: true, force: true });
});

/** Runs a scenario into a throwaway report directory; the directories go at the end of the file. */
async function run(scenario: Scenario, options: RunOptions = {}): Promise<Ran> {
  const out = mkdtempSync(join(tmpdir(), 'morrow-acceptance-'));
  directories.push(out);
  return { result: await runScenario(scenario, { mode: 'fixture', policy: 'careful', ...options, out }), out };
}

const execute = (options: RunOptions = {}) => run(smoke, options);

/**
 * One careful run of a historical scenario: every invariant holds, the timeline finishes and the
 * budget is respected. Each scenario's own metric assertions follow in its own test.
 */
async function carefulRun(scenario: Scenario): Promise<Metrics> {
  const { result } = await run(scenario);
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
  assert.equal(result.invariants.length, scenario.invariants.length);
  for (const row of result.invariants) assert.equal(row.ok, true, `${scenario.id} · ${row.name}: ${row.detail}`);
  assert.equal(result.timeline.length, scenario.timeline.length);
  assert.equal(result.turns, scenario.timeline.filter((step) => step.verb === 'turn').length);
  assert.equal(result.turns, scenario.budget.turns, `${scenario.id} 的预算应当正好是时间线里的轮次数`);
  assert(result.reviews <= scenario.budget.reviews!, `${scenario.id} spent ${result.reviews} reviews`);
  assert(
    result.calls.every((row) => row.status === 200),
    `${scenario.id}: careful 的每一次工作接口调用都应当被接受`
  );
  return metricsOf(result);
}

// Runs are shared between tests: a full fixture run starts a real service on a temporary directory,
// so this file performs three of them, not one per assertion.
const once = (make: () => Promise<Ran>) => {
  let pending: Promise<Ran> | undefined;
  return () => (pending ??= make());
};
const careful = once(() => execute());
/** A second careful run, kept, so one run serves both the repeatability checks and the report reads. */
const carefulAgain = once(() => execute({ keep: true }));
const naive = once(() => execute({ policy: 'naive' }));

const metricsOf = (result: RunResult): Metrics => {
  assert(result.metrics, 'the run produced metrics');
  return result.metrics!;
};

test('the smoke scenario runs end to end in fixture mode with every invariant holding', async () => {
  const { result, out } = await careful();
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
  assert.equal(result.invariants.length, smoke.invariants.length);
  for (const row of result.invariants) assert.equal(row.ok, true, `${row.name}: ${row.detail}`);

  const scheduled = smoke.timeline.filter((step) => step.verb === 'turn').length;
  assert.equal(result.turns, scheduled);
  assert.equal(result.turns, smoke.budget.turns);
  assert.equal(result.reviews, smoke.budget.reviews);
  assert.equal(result.timeline.length, smoke.timeline.length);
  assert.deepEqual(
    result.timeline.map((row) => row.verb),
    smoke.timeline.map((step) => step.verb)
  );

  // The loop actually closed: a sealed release, a human approval, and two contract reviews.
  const operations = result.calls.map((row) => row.operation);
  assert.equal(operations.filter((name) => name === 'release.propose').length, 1);
  assert.equal(operations.filter((name) => name === 'decision.choose').length, 2);
  assert.equal(operations.filter((name) => name === 'decision.review').length, 2);
  // One review of the item's own change, and one of the release candidate as a whole.
  assert.equal(operations.filter((name) => name === 'verification.request').length, 2);
  assert.equal(operations.filter((name) => name === 'execution.prepare').length, 1);
  assert(
    result.calls.every((row) => row.status === 200),
    'every work-interface call was accepted'
  );

  const timeline = readLines(join(out, 'timeline.jsonl'));
  assert.equal(timeline.length, smoke.timeline.length);
  assert.deepEqual(
    timeline.map((row) => row.verb),
    smoke.timeline.map((step) => step.verb)
  );
  assert(timeline.every((row) => typeof row.virtualTime === 'string' && row.virtualTime.endsWith('Z')));
  const calls = readLines(join(out, 'calls.jsonl'));
  assert.deepEqual(
    calls.map((row) => row.operation),
    operations
  );
  assert(existsSync(join(out, 'summary.md')));
  assert(result.summary.includes(fixtureNotice), 'the report states what a fixture run does not prove');
  assert.equal(readFileSync(join(out, 'summary.md'), 'utf8'), result.summary);

  // The labels are the metrics' only non-SQLite input, and they are written next to the report.
  const labels = JSON.parse(readFileSync(join(out, 'labels.json'), 'utf8'));
  assert.deepEqual(labels, result.labels);
  assert.equal(labels.staleMemoryIds.length, smoke.memory.filter((row) => row.stale).length);
  assert.deepEqual(
    labels.truth.map((row: any) => row.truth),
    smoke.timeline.flatMap((step) => (step.verb === 'set' && step.truth ? [step.truth] : []))
  );
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'metrics.json'), 'utf8')), metricsOf(result));

  const cleanup = JSON.parse(readFileSync(join(out, 'cleanup.json'), 'utf8'));
  assert.equal(cleanup.serviceClosed, true);
  assert.equal(cleanup.directoriesRemoved, true);
  assert(cleanup.channelsPaused >= 1);
  assert.equal(existsSync(cleanup.root), false, 'the temporary data directory is gone');
});

test('two runs of the same scenario issue the same sequence of work-interface operations', async () => {
  const first = await careful();
  const second = await carefulAgain();
  assert.equal(first.result.ok, true);
  assert.equal(second.result.ok, true);
  // Ids and timestamps differ every run; the sequence of operations and their outcomes must not.
  assert.deepEqual(
    second.result.calls.map((row) => `${row.operation}:${row.status}`),
    first.result.calls.map((row) => `${row.operation}:${row.status}`)
  );
  assert.deepEqual(
    second.result.timeline.map((row) => `${row.verb}:${row.virtualTime}`),
    first.result.timeline.map((row) => `${row.verb}:${row.virtualTime}`)
  );
  assert.deepEqual(
    second.result.invariants.map((row) => row.name + row.ok),
    first.result.invariants.map((row) => row.name + row.ok)
  );
  assert.equal(second.result.turns, first.result.turns);
  assert.equal(second.result.reviews, first.result.reviews);
});

test('the careful metrics record the frozen contract, the human approval and the labelled window', async () => {
  const metrics = metricsOf((await careful()).result);
  assert.equal(metrics.turns.scheduled, smoke.budget.turns);
  assert.equal(metrics.reviews.passed, smoke.budget.reviews);
  assert.equal(metrics.decisions.reviewed, 2);
  assert.equal(metrics.expectations.byAgent, 0, 'every expectation carried a rule the service checked');
  assert.equal(metrics.guardrails.defined, 2);
  assert.equal(metrics.guardrails.violationsCaught, 1, 'the second window broke the guardrail and the review said so');
  assert.equal(metrics.releases.published, 1);
  assert.deepEqual(metrics.humanInterventions, { total: 2, approve: 1, reject: 0, guide: 1 });
  assert.equal(metrics.restartConsistency.ok, true);
  assert.equal(metrics.goalOutcome !== 'unknown' && metrics.goalOutcome.verdict, 'not_met');
  // No usage reading exists in fixture mode, so the cost is explicitly unknown rather than zero.
  assert.equal(metrics.cost, 'unknown');
  assert.notEqual(metrics.adjustmentLatency, 'unknown');
  assert.equal(metrics.adjustmentLatency !== 'unknown' && metrics.adjustmentLatency.minMinutes, 15);
  assert.equal(metrics.misattribution !== 'unknown' && metrics.misattribution.count, 0);
});

test('the naive policy finishes the whole timeline inside the budget and fails on protocol use', async () => {
  const { result } = await naive();
  assert.equal(result.ok, false);
  assert.equal(result.timeline.length, smoke.timeline.length, 'the run completed; no step threw');
  assert.equal(result.turns, smoke.budget.turns);
  assert(result.reviews <= smoke.budget.reviews!, `spent ${result.reviews} reviews`);
  // Exactly the two invariants that encode correct use of the protocol fail: the choice froze no
  // guardrail, and no review ever cited a captured sample. Nothing else broke.
  assert.deepEqual(
    result.invariants.filter((row) => !row.ok).map((row) => row.name),
    ['decision-has-frozen-expectations', 'review-cites-captured-evidence']
  );
  assert.deepEqual(result.failures, [
    'invariant decision-has-frozen-expectations: 0/1 个选择同时冻结了结果预期和护栏',
    'invariant review-cites-captured-evidence: 0 次复盘逐项引用了实际采集的 HTTP 证据',
  ]);
  // It still ended every turn with a valid continuity block and got a release published.
  const blocks = result.invariants.find((row) => row.name === 'every-turn-produced-a-continuity-block');
  assert.equal(blocks?.ok, true, blocks?.detail || 'the continuity invariant ran');
  assert.equal(metricsOf(result).releases.published, 1);
  // Its own refused calls are recorded rather than thrown away.
  const refused = result.calls.filter((row) => row.status >= 400);
  assert(refused.length >= 4, `${refused.length} refused calls were recorded`);
  assert.deepEqual([...new Set(refused.map((row) => row.operation))].sort(), ['decision.review', 'release.propose']);
});

test('the four metrics separate the two policies in the expected direction', async () => {
  const first = metricsOf((await careful()).result);
  const second = metricsOf((await naive()).result);
  const check = policySelfCheck(first, second);
  for (const row of check.rows) assert.equal(row.ok, true, `${row.metric}: ${row.detail}`);
  assert.equal(check.ok, true);
  assert.deepEqual(
    check.rows.map((row) => row.metric),
    [
      'guardrails.defined',
      'guardrails.violationsCaught',
      'staleMemory.followed',
      'reviewsCitingCapturedEvidence',
      'repeatedFailures.groups',
    ]
  );
  // The direction, spelled out: naive adopts the planted experience and repeats refused material.
  assert.equal(first.staleMemory !== 'unknown' && first.staleMemory.ignored, 1);
  assert.equal(second.staleMemory !== 'unknown' && second.staleMemory.followed, 1);
  assert.equal(first.repeatedFailures !== 'unknown' && first.repeatedFailures.refused, 0);
  assert.equal(second.repeatedFailures !== 'unknown' && second.repeatedFailures.groups, 2);
});

test('namecheck carries one frozen rule across two windows and catches the second one breaking it', async () => {
  const metrics = await carefulRun(namecheck);
  // The improvement and the regression are both read off the same frozen rule, by the service.
  assert.equal(metrics.decisions.improved, 1);
  assert.equal(metrics.decisions.notImproved, 1);
  assert.equal(metrics.expectations.byAgent, 0);
  assert.equal(metrics.guardrails.violationsCaught, 1, '第二个窗口真的突破了护栏，复盘说了出来');
  // The dip the scenario labels `noise` was not read as proof of anything.
  assert.equal(metrics.misattribution !== 'unknown' && metrics.misattribution.count, 0);
  assert.equal(metrics.adjustmentLatency !== 'unknown' && metrics.adjustmentLatency.minMinutes, 15);
  // 0.6.0 era: the recall mechanism did not exist yet, so the planted experience is simply untouched.
  assert.equal(metrics.staleMemory !== 'unknown' && metrics.staleMemory.ignored, 1);
  assert.equal(metrics.releases.published, 1);
  assert.equal(metrics.releases.receiverPosts, 1);
});

test('fieldnote reads the stale note before judging it, and a changed cohort blocks attribution', async () => {
  const metrics = await carefulRun(fieldnote);
  // The planted note was read and explicitly not reused; that is the whole point of the era.
  assert.equal(metrics.staleMemory !== 'unknown' && metrics.staleMemory.avoided, 1);
  assert.equal(metrics.staleMemory !== 'unknown' && metrics.staleMemory.followed, 0);
  // Neither window could produce a conclusive result: the first had no sample, the second was a
  // different cohort. The numbers are still recorded rather than thrown away.
  assert.equal(metrics.decisions.inconclusive, 2);
  assert.equal(metrics.decisions.improved, 0);
  assert.equal(metrics.reviewsCitingCapturedEvidence, 1);
  assert.equal(metrics.misattribution !== 'unknown' && metrics.misattribution.count, 0, '环境变化没有被当成本次效果');
  assert.equal(metrics.goalOutcome !== 'unknown' && metrics.goalOutcome.verdict, 'not_met');
});

test('relaydesk keeps the broken guardrail, its window and the collected sample across a restart', async () => {
  const metrics = await carefulRun(relaydesk);
  assert.equal(metrics.guardrails.defined, 2);
  assert.equal(metrics.guardrails.violationsCaught, 1);
  assert.equal(metrics.decisions.improved, 1, '第一个窗口达到了预期');
  assert.equal(metrics.decisions.notImproved, 1, '第二个窗口的重复订单不能被其他指标抵消');
  assert.equal(metrics.staleMemory !== 'unknown' && metrics.staleMemory.avoided, 1);
  assert.equal(metrics.restartConsistency.restarts, 1);
  assert.equal(metrics.restartConsistency.ok, true);
  assert.equal(metrics.adjustmentLatency !== 'unknown' && metrics.adjustmentLatency.reactions, 1);
});

test('parcelnotes refuses the proxy metric and reconciles a publication it could not confirm', async () => {
  const metrics = await carefulRun(parcelnotes);
  // The proxy metric tripled in the second window; the frozen outcome and guardrail did not.
  assert.equal(metrics.decisions.notImproved, 1);
  assert.equal(metrics.guardrails.violationsCaught, 1);
  assert.equal(metrics.goalOutcome !== 'unknown' && metrics.goalOutcome.pointer, '/completeBodies');
  assert.equal(metrics.goalOutcome !== 'unknown' && metrics.goalOutcome.verdict, 'not_met');
  // The receiver took the artifact once and dropped the connection: reconciled, never resent.
  assert.equal(metrics.releases.published, 1);
  assert.equal(metrics.releases.postsAttempted, 1);
  assert.equal(metrics.releases.receiverPosts, 1);
  assert.deepEqual(metrics.humanInterventions, { total: 1, approve: 1, reject: 0, guide: 0 });
});

test('usagegap serves the seed app, files findings with evidence and leaves the counterexample alone', async () => {
  const { result } = await run(usagegap);
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
  assert.equal(result.invariants.length, usagegap.invariants.length);
  for (const row of result.invariants) assert.equal(row.ok, true, `usagegap · ${row.name}: ${row.detail}`);
  assert.equal(result.timeline.length, usagegap.timeline.length);
  assert.equal(result.turns, usagegap.budget.turns);
  assert(result.reviews <= usagegap.budget.reviews!, `usagegap spent ${result.reviews} reviews`);
  assert(
    result.calls.every((row) => row.status === 200),
    'usagegap: careful 的每一次工作接口调用都应当被接受'
  );

  // The seed app really ran: its own `/usage` carries the five features the scenario planted.
  assert(result.app?.url.startsWith('http://127.0.0.1:'), 'the run served the seed app');
  const probe = result.app!.probe as { features: Record<string, unknown> };
  assert.deepEqual(Object.keys(probe.features).sort(), usagegap.planted.map((row) => row.feature!).sort());
  // Started by this run, so stopped by it: `cleanup.json` says so, whatever the outcome was.
  const cleanup = JSON.parse(readFileSync(join(result.out, 'cleanup.json'), 'utf8'));
  assert.equal(cleanup.app.stopped, true, JSON.stringify(cleanup.app));
  assert.equal(cleanup.app.killed, false, 'SIGTERM was enough; nothing had to be forced');

  const metrics = metricsOf(result);
  const explored = metrics.usagegap;
  assert(explored !== 'unknown', 'the exploration metrics were computed');
  // Every planted problem was filed, each citing the sample the framework itself collected.
  assert.deepEqual(
    { planted: explored.planted, discovered: explored.discovered, percent: explored.discoveryPercent },
    { planted: 5, discovered: 5, percent: 100 }
  );
  assert.deepEqual(
    { findings: explored.findings, withEvidence: explored.findingsWithEvidence },
    { findings: 5, withEvidence: 5 }
  );
  // Both low-usage cases were given the right cause, and the counterexample was never worked on.
  const { details, ...attribution } = explored.attribution;
  assert.deepEqual(attribution, { cases: 2, correct: 2, wrong: 0, missing: 0, contradictory: 0, percent: 100 });
  // One item per case, and nothing filed both ways: the details say what each verdict was read from.
  assert.deepEqual(
    details.map((row) => ({ ...row, itemIds: row.itemIds.length })),
    [
      { id: 'buried-entrance', feature: 'bulkexport', verdict: 'correct', itemIds: 1 },
      { id: 'not-needed', feature: 'taxreport', verdict: 'correct', itemIds: 1 },
    ]
  );
  assert(
    result.summary.includes('· 矛盾 0 ·') && result.summary.includes('`not-needed`（taxreport）：归因正确'),
    '报告的探索指标表列出了矛盾计数与逐条归因'
  );
  assert.deepEqual(explored.misFix, { mustNotFix: 1, count: 0, ids: [], percent: 0 });
  // The improvement was framed before it was judged, and judged against the observation itself.
  assert.deepEqual(explored.improvements, {
    chosen: 1,
    withExpectation: 1,
    withObservation: 1,
    withBoth: 1,
    observed: 1,
    percent: 100,
  });
  // The rest of the loop behaves like the historical scenarios: two windows, one guardrail break.
  assert.equal(metrics.decisions.improved, 1);
  assert.equal(metrics.decisions.notImproved, 1);
  assert.equal(metrics.guardrails.violationsCaught, 1);
  assert.equal(metrics.expectations.byAgent, 0);
  assert.equal(metrics.releases.published, 1);
  assert.equal(metrics.misattribution !== 'unknown' && metrics.misattribution.count, 0, '外部故障没有被算成本次效果');
  assert.equal(metrics.staleMemory !== 'unknown' && metrics.staleMemory.avoided, 1);
  // The headline number stayed above its threshold; the guardrail is what refused the conclusion.
  assert.equal(metrics.goalOutcome !== 'unknown' && metrics.goalOutcome.verdict, 'met');
  assert(result.summary.includes('## 探索指标'), 'the report carries the exploration section');
  assert(
    result.summary.includes('探索本身只能在 live 模式下衡量'),
    'the exploration metrics are reported with their caveat'
  );
});

test('the exploration self-check rules are skipped for a scenario that has no usage report', async () => {
  const { result } = await careful();
  const metrics = metricsOf(result);
  assert.equal(metrics.usagegap, 'unknown', 'smoke plants no problems with a kind, so the block is unknown');
  const rules = policySelfCheck(metrics, metrics).rows.map((row) => row.metric);
  assert(!rules.some((metric) => metric.startsWith('usagegap.')), rules.join('、'));
  // Demanded by name they are compared anyway, and an unknown side is never a pass.
  const demanded = policySelfCheck(metrics, metrics, ['usagegap.discovered']);
  assert.equal(demanded.rows.find((row) => row.metric === 'usagegap.discovered')?.ok, false);
});

/* ------------------------- 低使用率归因与插入顺序 ------------------------- */

/**
 * The two low-usage planted problems on their own, with the `/usage` titles as aliases. Everything
 * else `usagegap` plants is irrelevant here: these are the only two cases attribution judges.
 */
const attributionLabels = (): Labels => ({
  staleMemoryIds: [],
  truth: [],
  planted: [
    {
      id: 'buried-entrance',
      kind: 'entrance',
      feature: 'bulkexport',
      aliases: ['批量导出'],
      where: 'page-home.js',
      description: '入口只在页脚，要三次点击',
      shouldFix: true,
    },
    {
      id: 'not-needed',
      kind: 'not-needed',
      feature: 'taxreport',
      aliases: ['税务报表'],
      where: 'page-taxreport.js',
      description: '目标用户访谈里没人要求过它',
      shouldFix: false,
    },
  ],
});

type Filed = { id: string; title: string };

/**
 * Files the given items into a fresh isolated service — a real board, no App and no model — and
 * returns `usagegap.attribution` computed on that store, with the ids it actually got. Item ids are
 * new every time, so a test that compares two runs compares titles, not ids.
 */
async function attributionOf(
  entries: Array<{ title: string; kind: string }>,
  labels: Labels = attributionLabels()
): Promise<{ attribution: Exclude<Metrics['usagegap'], string>['attribution']; filed: Filed[] }> {
  const service = await startIsolated({ scheduler: false });
  try {
    const filed: Filed[] = [];
    for (const row of entries) {
      const item = await service.api(
        'POST',
        `/api/projects/${service.project.id}/items`,
        {
          ...row,
          summary: '回归用的合成事项：分类写在 kind 上，命中写在标题里。',
          status: 'investigating',
          nextStep: '仍须验证。',
        },
        201
      );
      filed.push({ id: item.id, title: item.title });
    }
    const metrics = computeMetrics({ home: service.home, store: service.store, labels });
    assert.notEqual(metrics.usagegap, 'unknown', '两条埋入问题都带 kind 与 feature，指标块必须算得出来');
    return { attribution: (metrics.usagegap as Exclude<Metrics['usagegap'], string>).attribution, filed };
  } finally {
    await service.cleanup();
    assert(!existsSync(service.root), '临时服务目录已删除');
  }
}

/** The verdicts with the titles behind them, so two runs are comparable despite fresh item ids. */
const byTitle = (row: Awaited<ReturnType<typeof attributionOf>>) =>
  row.attribution.details.map((detail) => ({
    ...detail,
    itemIds: detail.itemIds.map((id) => row.filed.find((item) => item.id === id)!.title).sort(),
  }));

test('归因取全部命中事项：同样四条发现换插入顺序结果不变，两种分类都出现时记为矛盾', async () => {
  // 每条 case 都被记了两遍，一遍缺陷一遍待验证判断。取第一条的旧口径下，这四条按 [0,1,2,3] 插入得
  // 100%、按 [2,3,0,1] 插入得 0%，`wrong` 恒为 0，矛盾从不上报——这正是看板事项 #30。
  const entries = [
    { title: 'bulkexport 的入口太深', kind: 'issue' },
    { title: 'taxreport 使用率低，目标用户本来不需要', kind: 'hypothesis' },
    { title: 'bulkexport 使用率低，目标用户本来不需要', kind: 'hypothesis' },
    { title: 'taxreport 的入口太深', kind: 'issue' },
  ];
  const first = await attributionOf([0, 1, 2, 3].map((index) => entries[index]));
  const second = await attributionOf([2, 3, 0, 1].map((index) => entries[index]));
  assert.deepEqual(byTitle(first), byTitle(second), '同样四条事项，换插入顺序后每条判定都必须一致');

  const { details, ...counts } = first.attribution;
  assert.deepEqual(counts, { cases: 2, correct: 0, wrong: 0, missing: 0, contradictory: 2, percent: 0 });
  assert.deepEqual(
    byTitle(first),
    [
      {
        id: 'buried-entrance',
        feature: 'bulkexport',
        verdict: 'contradictory',
        itemIds: ['bulkexport 使用率低，目标用户本来不需要', 'bulkexport 的入口太深'],
      },
      {
        id: 'not-needed',
        feature: 'taxreport',
        verdict: 'contradictory',
        itemIds: ['taxreport 使用率低，目标用户本来不需要', 'taxreport 的入口太深'],
      },
    ],
    '矛盾的那两条事项都要列出来，报告才能给人看'
  );
  assert.equal(details.length, counts.cases, '`details` 每条 case 恰好一行');
});

test('归因：分类一致才判对错，一条都没有是 missing，别名命中的事项一样参与', async () => {
  // 只记了入口那条，而且记成了缺陷：它算对，反例没有任何事项提到，是 missing 而不是归错。
  const partial = await attributionOf([{ title: 'bulkexport 的入口太深', kind: 'issue' }]);
  const { details: partialDetails, ...partialCounts } = partial.attribution;
  assert.deepEqual(partialCounts, { cases: 2, correct: 1, wrong: 0, missing: 1, contradictory: 0, percent: 50 });
  assert.deepEqual(
    partialDetails.map((row) => [row.id, row.verdict, row.itemIds.length]),
    [
      ['buried-entrance', 'correct', 1],
      ['not-needed', 'missing', 0],
    ]
  );

  // 两条都一致地记反了：入口记成待验证判断、反例记成缺陷——两条都是归错，不是矛盾。
  const swapped = await attributionOf([
    { title: 'bulkexport 使用率低，先观察', kind: 'hypothesis' },
    { title: 'taxreport 使用率低，先修它', kind: 'issue' },
  ]);
  const { details: swappedDetails, ...swappedCounts } = swapped.attribution;
  assert.deepEqual(swappedCounts, { cases: 2, correct: 0, wrong: 2, missing: 0, contradictory: 0, percent: 0 });
  assert.deepEqual(
    swappedDetails.map((row) => row.verdict),
    ['wrong', 'wrong']
  );

  // 别名：第二条一个 ID 都没写，只按数据里的中文标题称呼那个功能。它参与了判定——否则第一条单独
  // 成立，这里会是 `correct`。
  const alias = await attributionOf([
    { title: 'bulkexport 的入口太深', kind: 'issue' },
    { title: '让值班人员从首页直接找到批量导出', kind: 'hypothesis' },
    { title: 'taxreport 使用率低，目标用户本来不需要', kind: 'hypothesis' },
  ]);
  const { details: aliasDetails, ...aliasCounts } = alias.attribution;
  assert.deepEqual(aliasCounts, { cases: 2, correct: 1, wrong: 0, missing: 0, contradictory: 1, percent: 50 });
  assert.deepEqual(
    aliasDetails.map((row) => [row.id, row.verdict, row.itemIds.length]),
    [
      ['buried-entrance', 'contradictory', 2],
      ['not-needed', 'correct', 1],
    ]
  );
});

test('a scenario’s own self-check demands are compared even when the generic rule would skip them', async () => {
  const metrics = metricsOf((await careful()).result);
  const blind = { ...metrics, guardrails: { ...metrics.guardrails, violationsCaught: 0 } } as Metrics;
  // Nothing to compare, so the generic check leaves the row out rather than passing it by default.
  assert(!policySelfCheck(blind, blind).rows.some((row) => row.metric === 'guardrails.violationsCaught'));
  const demanded = policySelfCheck(blind, blind, ['guardrails.violationsCaught']);
  assert.equal(demanded.rows.find((row) => row.metric === 'guardrails.violationsCaught')?.ok, false);
  assert.equal(demanded.ok, false);
  // A demand that matches no rule is a failure too: a typo must not read as a satisfied demand.
  assert.equal(policySelfCheck(metrics, metrics, ['guardrails.typo']).rows.at(-1)?.ok, false);
  // The scenarios the plan names really do demand the three metrics it names.
  for (const scenario of [namecheck, relaydesk])
    assert.deepEqual(scenario.selfCheck, [
      'guardrails.violationsCaught',
      'staleMemory.followed',
      'repeatedFailures.groups',
    ]);
});

test('comparing two careful runs with --ignore-volatile shows no differences', async () => {
  const first = await careful();
  const second = await carefulAgain();
  const volatile = compare(first.out, second.out);
  assert.deepEqual(
    volatile.differences.map((row) => row.key).filter((key) => !key.startsWith('wakeups.byWatch.')),
    ['goalOutcome.evidenceId', 'staleMemory.ids.0', 'time.wallMs'],
    'only ids and the wall clock differ between two runs of the same scenario'
  );
  const stable = compare(first.out, second.out, { ignoreVolatile: true });
  assert.deepEqual(stable.differences, [], stable.markdown);
  assert(stable.compared > 50, `${stable.compared} metric keys were compared`);
  assert(stable.markdown.includes('差异：0'));
});

test('metrics on a kept report directory reproduce the run’s own metrics.json', async () => {
  const { result, out } = await carefulAgain();
  assert.equal(result.ok, true);
  assert(existsSync(join(out, 'home', 'workspace.sqlite')), '--keep copied the data directory into the report');
  const recomputed = computeMetrics(reportInput(out));
  assert.deepEqual(recomputed, metricsOf(result));
  assert.deepEqual(recomputed, JSON.parse(readFileSync(join(out, 'metrics.json'), 'utf8')));

  // The same command on a bare data directory has no labels, so those metrics are unknown, not 0.
  const bare = computeMetrics({ home: join(out, 'home') });
  assert.equal(bare.staleMemory, 'unknown');
  assert.equal(bare.repeatedFailures, 'unknown');
  assert.equal(bare.misattribution, 'unknown');
  assert.equal(bare.releases.receiverPosts, 'unknown');
  assert.equal(bare.guardrails.defined, recomputed.guardrails.defined, 'SQLite-only metrics are unaffected');
});
