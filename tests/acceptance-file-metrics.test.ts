import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, type MetricsStore } from '../scripts/acceptance/metrics.ts';

test('missing or mistyped equals fields stay unknown and do not start reaction latency', () => {
  const evaluate = (samples: unknown[], expected: boolean | number | string = true, pointer = '/ok') => {
    const file = '/isolated-project/metrics.json';
    const evidence = samples.map((data, index) => ({
      id: `sample-${index}`,
      origin: 'file',
      source: file,
      watchId: 'file-watch',
      data,
      createdAt: `2026-09-10T00:0${index + 1}:00.000Z`,
      observedAt: `2026-09-10T00:0${index + 1}:00.000Z`,
    }));
    const decision = {
      id: 'decision',
      createdAt: '2026-09-10T00:00:00.000Z',
      status: 'reviewed',
      expectations: [
        {
          id: 'ok',
          kind: 'outcome',
          source: { kind: 'watch', watchId: 'file-watch', path: file },
          notBefore: '2026-09-10T00:00:00.000Z',
          deadline: '2026-09-10T00:10:00.000Z',
          rule: { pointer, operator: 'equals', expected },
        },
      ],
      review: {
        outcome: 'not_improved',
        createdAt: '2026-09-10T00:03:00.000Z',
        assessment: {
          results: [{ expectationId: 'ok', verdict: 'not_met', checkedBy: 'rule', evidenceIds: [evidence.at(-1)!.id] }],
        },
      },
    };
    const rows: Record<string, any[]> = { strategy_decisions: [decision], loop_evidence: evidence };
    const store: MetricsStore = {
      all: <T>(table: string) => (rows[table] || []) as T[],
      get: <T>(table: string, id: string) => (rows[table] || []).find((row) => row.id === id) as T | undefined,
    };
    const metrics = computeMetrics({ home: '/unused', store });
    assert.notEqual(metrics.goalOutcome, 'unknown', 'a matching evidence row exists, even if its field is unknown');
    if (metrics.goalOutcome === 'unknown') throw new Error('matching evidence was lost');
    return { verdict: metrics.goalOutcome.verdict, latency: metrics.adjustmentLatency };
  };
  for (const data of [
    {},
    { ok: null },
    { ok: 'false' },
    { ok: 0 },
    { ok: {} },
    { ok: [] },
    { ok: NaN },
    { ok: Infinity },
    Object.create({ ok: false }),
  ])
    assert.deepEqual(evaluate([data]), { verdict: 'unknown', latency: 'unknown' });
  assert.deepEqual(evaluate([{ ok: '1' }], 1), { verdict: 'unknown', latency: 'unknown' });
  assert.deepEqual(evaluate([{ ok: true }], 'true'), { verdict: 'unknown', latency: 'unknown' });
  assert.equal(evaluate([{ ok: true }]).verdict, 'met');
  assert.equal(evaluate([{ ok: false }]).verdict, 'not_met');
  assert.deepEqual(evaluate([{}, { ok: false }]), {
    verdict: 'not_met',
    latency: { reactions: 1, minMinutes: 1, maxMinutes: 1, meanMinutes: 1 },
  });
  assert.equal(evaluate([{ 'a/b': { '~flag': true } }], true, '/a~1b/~0flag').verdict, 'met');
});

test('file-watch evidence contributes to outcome and reaction metrics without accepting a different source', () => {
  const observedAt = '2026-09-10T00:01:00.000Z';
  const file = '/isolated-project/metrics.json';
  const evidence = {
    id: 'sample',
    origin: 'file',
    source: file,
    watchId: 'file-watch',
    createdAt: observedAt,
    observedAt,
    data: { completion: 0.5 },
  };
  const decision = {
    id: 'decision',
    createdAt: '2026-09-10T00:00:00.000Z',
    status: 'reviewed',
    expectations: [
      {
        id: 'completion',
        kind: 'outcome',
        source: { kind: 'watch', watchId: 'file-watch', path: file },
        notBefore: '2026-09-10T00:00:00.000Z',
        deadline: '2026-09-10T00:10:00.000Z',
        rule: { pointer: '/completion', operator: 'gte', expected: 0.8 },
      },
    ],
    review: {
      outcome: 'not_improved',
      createdAt: '2026-09-10T00:03:00.000Z',
      evidenceIds: ['sample'],
      assessment: {
        results: [{ expectationId: 'completion', verdict: 'not_met', checkedBy: 'rule', evidenceIds: ['sample'] }],
      },
    },
  };
  const compute = (patch = {}) => {
    const rows: Record<string, any[]> = { strategy_decisions: [decision], loop_evidence: [{ ...evidence, ...patch }] };
    const store: MetricsStore = {
      all: <T>(table: string) => (rows[table] || []) as T[],
      get: <T>(table: string, id: string) => (rows[table] || []).find((row) => row.id === id) as T | undefined,
    };
    return computeMetrics({ home: '/unused', store });
  };
  const metrics = compute();
  assert.notEqual(metrics.goalOutcome, 'unknown');
  if (metrics.goalOutcome !== 'unknown') {
    assert.equal(metrics.goalOutcome.value, 0.5);
    assert.equal(metrics.goalOutcome.evidenceId, 'sample');
    assert.equal(metrics.goalOutcome.verdict, 'not_met');
  }
  assert.deepEqual(metrics.adjustmentLatency, { reactions: 1, minMinutes: 2, maxMinutes: 2, meanMinutes: 2 });
  assert.equal(metrics.reviewsCitingCapturedEvidence, 1);
  assert.equal(metrics.expectations.byRule, 1);
  assert.equal(metrics.expectations.rulePercent, 100);
  for (const patch of [{ origin: 'http' }, { watchId: 'another-watch' }, { source: '/other/metrics.json' }]) {
    const wrong = compute(patch);
    assert.equal(wrong.goalOutcome, 'unknown');
    assert.equal(wrong.adjustmentLatency, 'unknown');
  }
});
