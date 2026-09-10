import './harness/env.ts';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureNotice, runScenario } from '../scripts/acceptance/fixture.ts';
import { computeMetrics, policySelfCheck } from '../scripts/acceptance/metrics.ts';
import { compare, reportInput } from '../scripts/acceptance/report.ts';
import smoke from '../scripts/acceptance/scenarios/smoke.ts';
import type { RunOptions, RunResult } from '../scripts/acceptance/fixture.ts';
import type { Metrics } from '../scripts/acceptance/metrics.ts';

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

/** Runs the scenario into a throwaway report directory; the directories go at the end of the file. */
async function execute(options: RunOptions = {}): Promise<Ran> {
  const out = mkdtempSync(join(tmpdir(), 'morrow-acceptance-'));
  directories.push(out);
  return { result: await runScenario(smoke, { mode: 'fixture', policy: 'careful', ...options, out }), out };
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
