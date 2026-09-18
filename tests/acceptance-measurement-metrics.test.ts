import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, type MetricsStore } from '../scripts/acceptance/metrics.ts';

const time = (minute: number) => new Date(Date.UTC(2026, 8, 10) + minute * 60000).toISOString();
function fixture() {
  const path = '/isolated-project/metrics.json';
  const sample = (id: string, count: number, minute: number) => ({
    id,
    origin: 'file',
    source: path,
    watchId: 'watch',
    createdAt: time(minute),
    observedAt: time(minute),
    data: { count, at: time(minute), samples: 10 },
  });
  const baseline = sample('baseline', 100, -1);
  const first = sample('first', 105, 1);
  const decision: any = {
    id: 'decision',
    createdAt: time(0),
    status: 'reviewed',
    expectations: [
      {
        id: 'growth',
        kind: 'outcome',
        source: { kind: 'watch', watchId: 'watch', path },
        notBefore: time(0),
        deadline: time(10),
        rule: { pointer: '/count', operator: 'gte', expected: 10 },
        measurement: {
          comparison: 'delta',
          baseline: { evidenceId: baseline.id },
          freshness: { pointer: '/at', maxAgeSeconds: 120 },
          checks: [{ label: '足够样本', pointer: '/samples', operator: 'gte', expected: 5 }],
        },
      },
    ],
    review: {
      createdAt: time(3),
      outcome: 'not_improved',
      evidenceIds: [first.id],
      assessment: {
        results: [{ expectationId: 'growth', verdict: 'not_met', checkedBy: 'rule', evidenceIds: [first.id] }],
      },
    },
  };
  const compute = (evidence: unknown[]) => {
    const rows: Record<string, any[]> = { strategy_decisions: [decision], loop_evidence: evidence };
    const store: MetricsStore = {
      all: <T>(table: string) => (rows[table] || []) as T[],
      get: <T>(table: string, id: string) => (rows[table] || []).find((row) => row.id === id) as T | undefined,
    };
    return computeMetrics({ home: '/unused', store });
  };
  return { sample, baseline, first, decision, compute };
}
const latency = (minutes: number) => ({ reactions: 1, minMinutes: minutes, maxMinutes: minutes, meanMinutes: minutes });

test('encoded objects in parsed observations cannot supply a metric, baseline or quality fields', () => {
  const f = fixture();
  for (const evidence of [
    [f.baseline, { ...f.first, data: JSON.stringify(f.first.data) }],
    [{ ...f.baseline, data: JSON.stringify(f.baseline.data) }, f.first],
  ]) {
    const metrics = f.compute(evidence);
    assert.notEqual(metrics.goalOutcome, 'unknown');
    if (metrics.goalOutcome !== 'unknown') assert.equal(metrics.goalOutcome.verdict, 'unknown');
    assert.equal(metrics.adjustmentLatency, 'unknown');
  }
});

test('delta outcomes use the frozen baseline and later evidence cannot rewrite historical latency', () => {
  const f = fixture();
  const original = f.compute([f.baseline, f.first]);
  assert.deepEqual(original.adjustmentLatency, latency(2));
  assert.notEqual(original.goalOutcome, 'unknown');
  if (original.goalOutcome !== 'unknown') {
    assert.equal(original.goalOutcome.value, 5);
    assert.equal(original.goalOutcome.verdict, 'not_met');
  }
  const later = f.compute([f.baseline, f.first, f.sample('after-review', 0, 4)]);
  assert.deepEqual(later.adjustmentLatency, original.adjustmentLatency);
  const onlyLater = f.compute([f.baseline, f.sample('after-review', 0, 4)]);
  assert.equal(onlyLater.adjustmentLatency, 'unknown');
  const collectedLater = { ...f.first, createdAt: time(4) };
  assert.equal(f.compute([f.baseline, collectedLater]).adjustmentLatency, 'unknown');
});

test('latency ignores bad-quality samples and finds the earliest eligible observation regardless of row order', () => {
  const f = fixture();
  const invalid = { ...f.first, data: { ...f.first.data, samples: 0 } };
  assert.deepEqual(f.compute([f.baseline, invalid, f.sample('valid', 105, 2)]).adjustmentLatency, latency(1));
  const stale = { ...f.first, data: { ...f.first.data, at: time(-5) } };
  assert.equal(f.compute([f.baseline, stale]).adjustmentLatency, 'unknown');
  const futureData = { ...f.first, data: { ...f.first.data, at: time(2) } };
  assert.equal(f.compute([f.baseline, futureData]).adjustmentLatency, 'unknown');
  assert.deepEqual(f.compute([f.baseline, f.sample('later', 105, 2), f.first]).adjustmentLatency, latency(2));
  assert.equal(f.compute([f.baseline, f.sample('before', 0, -2)]).adjustmentLatency, 'unknown');
  assert.equal(f.compute([f.baseline, f.sample('before', 0, -2)]).goalOutcome, 'unknown');
  f.decision.review.createdAt = time(12);
  assert.equal(f.compute([f.baseline, f.sample('outside-window', 0, 11)]).adjustmentLatency, 'unknown');
  assert.equal(f.compute([f.baseline, f.sample('outside-window', 0, 11)]).goalOutcome, 'unknown');
});

test('delta needs a valid same-source baseline captured before the choice; absolute can lack a baseline', () => {
  const f = fixture();
  for (const baseline of [
    undefined,
    { ...f.baseline, source: '/another/file.json' },
    { ...f.baseline, createdAt: time(1) },
    { ...f.baseline, data: { ...f.baseline.data, samples: 0 } },
    { ...f.baseline, data: { ...f.baseline.data, count: '100' } },
    { ...f.baseline, data: { ...f.baseline.data, at: time(-5) } },
  ]) {
    const metrics = f.compute([...(baseline ? [baseline] : []), f.first]);
    assert.equal(metrics.adjustmentLatency, 'unknown');
    assert.notEqual(metrics.goalOutcome, 'unknown');
    if (metrics.goalOutcome !== 'unknown') assert.equal(metrics.goalOutcome.verdict, 'unknown');
  }
  f.decision.expectations[0].measurement.comparison = 'absolute';
  f.decision.expectations[0].measurement.baseline = { unavailable: '不需要差值' };
  assert.deepEqual(f.compute([f.sample('absolute', 5, 1)]).adjustmentLatency, latency(2));
});

test('HTTP measurement evidence follows the same baseline and quality rules', () => {
  const f = fixture();
  f.decision.expectations[0].source = { kind: 'watch', watchId: 'watch', url: 'https://example.test/metrics' };
  const rows = [f.baseline, f.first].map((row) => ({ ...row, origin: 'http', source: 'https://example.test/metrics' }));
  assert.deepEqual(f.compute(rows).adjustmentLatency, latency(2));
});

test('unusable execution evidence cannot establish an outcome or violation time', () => {
  const f = fixture();
  const expected = f.decision.expectations[0];
  delete expected.measurement;
  expected.source = { kind: 'execution', command: 'node --test' };
  expected.rule = { pointer: '/exitCode', operator: 'equals', expected: 0 };
  const row = {
    ...f.first,
    origin: 'execution',
    source: 'node --test',
    data: { exitCode: 9, boundVersion: true, outputComplete: true },
  };
  for (const patch of [{ boundVersion: false }, { outputComplete: false }, { exitCode: '9' }]) {
    const metrics = f.compute([{ ...row, data: { ...row.data, ...patch } }]);
    assert.equal(metrics.adjustmentLatency, 'unknown');
    if (metrics.goalOutcome !== 'unknown') assert.equal(metrics.goalOutcome.verdict, 'unknown');
  }
  assert.deepEqual(f.compute([row]).adjustmentLatency, latency(2));
});
