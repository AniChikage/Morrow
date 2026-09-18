import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../service/store.ts';
import { computeMetrics, openCopy, type MetricsStore } from '../scripts/acceptance/metrics.ts';

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

test('review metrics close the loop per item and separate a cap or a spent account from a verdict', () => {
  let at = Date.parse('2026-09-10T00:00:00.000Z');
  /** One review row, in the order they are written; only the fields these metrics read. */
  const review = (row: Record<string, any>) => ({
    id: `review-${(at += 60_000)}`,
    createdAt: new Date(at).toISOString(),
    summary: '',
    ...row,
  });
  const verifications = [
    // Closed: a counterexample, an interrupted retry, then a pass.
    review({ itemId: 'closed', status: 'failed' }),
    review({ itemId: 'closed', status: 'unknown', summary: '独立复核达到 5 分钟上限，结果保留未知' }),
    review({ itemId: 'closed', status: 'passed' }),
    // Open: the pass came first, and the newest word on this item is a counterexample.
    review({ itemId: 'open', status: 'passed' }),
    review({ itemId: 'open', status: 'failed' }),
    // Never failed at all, so it is neither closed nor open.
    review({ itemId: 'quiet', status: 'passed' }),
    // A release candidate judges the candidate, not one item's acceptance, and is not counted per
    // item — nor is a review that carries only a decision.
    review({ status: 'failed', kind: 'release', itemIds: ['open', 'quiet'] }),
    review({ decisionId: 'decision', status: 'failed' }),
    // The other release cap, and a spent account in both the shape it is recorded in now and the
    // raw text older rows carry in place of a conclusion.
    review({
      status: 'unknown',
      kind: 'release',
      itemIds: ['quiet'],
      summary: '独立复核达到 8 分钟上限，结果保留未知',
    }),
    review({
      itemId: 'quiet',
      status: 'unknown',
      summary: '账号额度已用尽，09-15 11:41 后自动重试',
      usageWait: { kind: 'account', until: '2026-09-15T11:41:00.000Z', since: '2026-09-15T10:41:00.000Z' },
      error: "You've hit your usage limit. … try again at Sep 15th, 2026 11:41 AM.",
    }),
    review({
      itemId: 'quiet',
      status: 'unknown',
      summary: "复核未正常完成：You've hit your usage limit. … try again at Sep 15th, 2026 11:41 AM.",
    }),
    // The account interrupted this attempt, which then reached a verdict: not a review the account
    // stopped, even though it still carries the text of the interruption.
    review({
      itemId: 'quiet',
      status: 'passed',
      error: "You've hit your usage limit. … try again at Sep 15th, 2026 11:41 AM.",
    }),
  ];
  const rows: Record<string, any[]> = { loop_verifications: verifications };
  const metrics = computeMetrics({
    home: '/unused',
    store: {
      all: <T>(table: string) => (rows[table] || []) as T[],
      get: <T>(table: string, id: string) => (rows[table] || []).find((row) => row.id === id) as T | undefined,
    },
  });
  assert.deepEqual(metrics.reviews, {
    total: 12,
    passed: 4,
    failed: 4,
    unknownResult: 4,
    unfinished: 0,
    failedThenPassed: 1,
    failedOpen: 1,
    failedOpenItemIds: ['open'],
    stoppedByCap: 2,
    stoppedByQuota: 2,
  });
});

test('the metrics copy is compact, consistent and never writes the data directory it reads', () => {
  const home = mkdtempSync(join(tmpdir(), 'morrow-metrics-copy-'));
  const store = new Store(join(home, 'workspace.sqlite'));
  try {
    // Enough rows that the file has pages to give back once most of them go, which is what a
    // daemon that prunes its own journal and reprojects its turns leaves behind.
    for (let index = 0; index < 400; index++)
      store.put('native_threads', {
        id: `thread-${index}`,
        threadId: `thread-${index}`,
        state: { note: 'x'.repeat(4096) },
      });
    store.put('runs', { id: 'kept-run', projectId: 'p', channelId: 'c', status: 'completed' });
    store.db.exec("DELETE FROM native_threads WHERE id<>'thread-0'");
    store.close();
    const path = join(home, 'workspace.sqlite');
    /** Every file of the data directory by content, so only an actual write can fail this. */
    const content = () =>
      Object.fromEntries(
        readdirSync(home)
          .sort()
          .map((name) => [
            name,
            createHash('sha256')
              .update(readFileSync(join(home, name)))
              .digest('hex'),
          ])
      );
    const before = content();
    const size = statSync(path).size;
    const opened = openCopy(home);
    try {
      assert.equal(opened.store.get<any>('runs', 'kept-run').status, 'completed');
      assert.equal(opened.store.all('native_threads').length, 1);
    } finally {
      opened.close();
    }
    // Only read, and given no file it did not have: the whole directory is byte-identical.
    assert.deepEqual(content(), before);
    assert.equal(statSync(path).size, size);
    // The same holds while a daemon is holding the directory, where the copy has to be taken
    // through SQLite because the log and the database cannot be copied as one consistent moment.
    const live = new Store(path);
    try {
      live.put('runs', { id: 'while-attached', projectId: 'p', channelId: 'c', status: 'running' });
      const attached = content();
      assert(Object.keys(attached).includes('workspace.sqlite-wal'));
      const second = openCopy(home);
      try {
        assert.equal(second.store.get<any>('runs', 'while-attached').status, 'running');
        assert.equal(second.store.get<any>('runs', 'kept-run').status, 'completed');
      } finally {
        second.close();
      }
      // The database and its log are untouched. The shared-memory file is SQLite's own scratch
      // index of that log, which every reader of a WAL database updates and which SQLite rebuilds
      // from the log whenever no process holds the database.
      const { 'workspace.sqlite-shm': scratch, ...rest } = content();
      const { 'workspace.sqlite-shm': _ignored, ...expected } = attached;
      assert.deepEqual(rest, expected);
      assert.equal(typeof scratch, 'string');
    } finally {
      live.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
