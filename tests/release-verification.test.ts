import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FakeReviewer } from './harness/fake-reviewer.ts';
import { startIsolated } from './harness/service.ts';
import { grantFor } from './harness/grant.ts';
import type { Verification } from '../service/verification-types.ts';

/**
 * The release gate has two halves: every item carries a review from the version it was changed at,
 * and the candidate itself carries one release-level review of the current version. These tests
 * cover both halves through the real work interface with an explicit native protocol double; no
 * model is called, no project command runs, and the user's data directory is never touched.
 */
async function fixture() {
  const reviewer = new FakeReviewer();
  reviewer.autoComplete = true;
  const s = await startIsolated({
    project: {
      name: '发布级复核',
      goal: '让一次多事项发布只付一次复核',
      files: { 'release.txt': 'build one\n', 'checks.log': '2 tests passed\n' },
    },
  });
  s.engine.loop.verification.connect(reviewer, (v) => v);
  const grant = grantFor(s, {
    projectId: s.project.id,
    channelId: s.channel.id,
    // Execution captures bind to a native task and turn; nothing is executed by this fixture.
    overrides: { sessionId: 'isolated-test', nativeTurnId: 'isolated-turn' },
  });
  const call = (operation: string, input: unknown, status = 200) => grant.call(operation, input, status, randomUUID());
  const stored = (id: string) => s.store.get<Verification>('loop_verifications', id)!;
  /** One feature plus the actual file evidence its own review and the release checks cite. */
  const feature = async (title: string) => {
    const item = await call('feature.upsert', {
      title,
      summary: `${title}的实际改动`,
      kind: 'feature',
      status: 'investigating',
      evidenceIds: [],
      nextStep: '准备独立复核',
    });
    const evidence = await call('evidence.capture', {
      itemId: item.id,
      summary: `${title}的检查日志`,
      path: 'checks.log',
    });
    return { item, evidence };
  };
  /** Runs the queued review to its verdict; the double reports whatever `reviewer.verdict` says. */
  const settle = async (id: string) => {
    await s.engine.loop.verification.start(id);
    return stored(id);
  };
  const reviewItem = async (itemId: string, evidenceId: string) =>
    settle((await call('verification.request', { itemId, evidenceIds: [evidenceId] })).id);
  const reviewRelease = async (itemIds: string[], evidenceIds: string[]) =>
    settle((await call('verification.request', { kind: 'release', itemIds, evidenceIds })).id);
  const proposal = (itemIds: string[], evidenceId: string) => ({
    itemIds,
    title: '一次合并发布',
    changes: '把已复核的事项一起交付',
    rationale: '逐项复核在多事项发布上重复付费',
    expectedBenefit: '预期减少复核开销；线上收益尚待验证',
    checks: [{ name: '完整检查', result: 'passed', evidenceIds: [evidenceId] }],
    risks: '影响发布路径',
    rollback: '恢复上一个产物',
    observationPlan: '发布后读取指标文件',
    artifactPath: 'release.txt',
    target: { url: 'http://127.0.0.1:9/deploy', statusUrl: 'http://127.0.0.1:9/status', label: '隔离发布端' },
  });
  /** Changes the project so every review taken before it is no longer bound to the current source. */
  const editSource = (text: string) => writeFileSync(join(s.path, 'release.txt'), text);
  return { ...s, reviewer, grant, call, feature, reviewItem, reviewRelease, settle, stored, proposal, editSource };
}

test('stale per-item reviews plus one current release-level review are enough to propose a release', async () => {
  const f = await fixture();
  try {
    const first = await f.feature('第一项改动');
    const second = await f.feature('第二项改动');
    const firstReview = await f.reviewItem(first.item.id, first.evidence.id);
    const secondReview = await f.reviewItem(second.item.id, second.evidence.id);
    assert.equal(firstReview.status, 'passed');
    assert.equal(secondReview.status, 'passed');
    // Everything after this point happens on a later source version, so both item reviews go stale.
    f.editSource('build two\n');
    assert.equal(f.engine.loop.verification.current(firstReview), false);
    assert.equal(f.engine.loop.verification.current(secondReview), false);
    const execution = await f.grant.execute('node --test');
    assert.equal(execution.origin, 'execution');
    const release = await f.reviewRelease([first.item.id, second.item.id], [execution.id]);
    assert.equal(release.status, 'passed');
    assert.equal(release.kind, 'release');
    assert.deepEqual(release.itemIds?.slice().sort(), [first.item.id, second.item.id].sort());
    assert.equal(f.engine.loop.verification.current(release), true);
    const proposed = await f.call('release.propose', f.proposal([first.item.id, second.item.id], first.evidence.id));
    assert.equal(proposed.status, 'awaiting_approval');
    assert.equal(proposed.releaseVerificationId, release.id);
    assert.deepEqual(proposed.verificationIds.slice().sort(), [firstReview.id, secondReview.id].sort());
    // Two items, three reviews total: one per change plus one for the candidate, not one per item
    // per source version.
    assert.equal(f.store.all<Verification>('loop_verifications').length, 3);
    assert.equal(f.reviewer.sent.length, 3);
    // The release-level review is reachable from the release and from each item's own work view.
    const view = await f.api('GET', `/api/projects/${f.project.id}/work`);
    assert(view.verifications.some((row: any) => row.id === release.id && row.kind === 'release'));
    const scoped = await f.api('GET', `/api/projects/${f.project.id}/work?itemId=${second.item.id}`);
    assert(scoped.verifications.some((row: any) => row.id === release.id));
  } finally {
    await f.cleanup();
  }
});

test('a release without any release-level review is refused even when every item passed its own', async () => {
  const f = await fixture();
  try {
    const only = await f.feature('唯一改动');
    assert.equal((await f.reviewItem(only.item.id, only.evidence.id)).status, 'passed');
    const refused = await f.call('release.propose', f.proposal([only.item.id], only.evidence.id), 409);
    assert.match(refused.error, /发布级复核/);
    assert.equal(f.store.all('loop_releases').length, 0);
  } finally {
    await f.cleanup();
  }
});

test('a release-level review stops covering the candidate as soon as the source changes again', async () => {
  const f = await fixture();
  try {
    const only = await f.feature('唯一改动');
    await f.reviewItem(only.item.id, only.evidence.id);
    const execution = await f.grant.execute('node --test');
    const release = await f.reviewRelease([only.item.id], [execution.id]);
    assert.equal(release.status, 'passed');
    f.editSource('build three\n');
    assert.equal(f.engine.loop.verification.current(release), false);
    const refused = await f.call('release.propose', f.proposal([only.item.id], only.evidence.id), 409);
    assert.match(refused.error, /当前源版本的发布级复核/);
  } finally {
    await f.cleanup();
  }
});

test('a release-level review that leaves out one proposed item does not cover the proposal', async () => {
  const f = await fixture();
  try {
    const covered = await f.feature('被覆盖的改动');
    const missing = await f.feature('未被覆盖的改动');
    await f.reviewItem(covered.item.id, covered.evidence.id);
    await f.reviewItem(missing.item.id, missing.evidence.id);
    const execution = await f.grant.execute('node --test');
    const release = await f.reviewRelease([covered.item.id], [execution.id]);
    assert.deepEqual(release.itemIds, [covered.item.id]);
    const refused = await f.call(
      'release.propose',
      f.proposal([covered.item.id, missing.item.id], covered.evidence.id),
      409
    );
    assert.match(refused.error, /发布级复核/);
    // The same review still covers the smaller proposal it was actually taken for.
    const proposed = await f.call('release.propose', f.proposal([covered.item.id], covered.evidence.id));
    assert.equal(proposed.releaseVerificationId, release.id);
  } finally {
    await f.cleanup();
  }
});

test('an item that never passed a review blocks both the release-level request and the proposal', async () => {
  const f = await fixture();
  try {
    const reviewed = await f.feature('已复核的改动');
    const never = await f.feature('从未复核的改动');
    await f.reviewItem(reviewed.item.id, reviewed.evidence.id);
    const execution = await f.grant.execute('node --test');
    const refusedRequest = await f.call(
      'verification.request',
      { kind: 'release', itemIds: [reviewed.item.id, never.item.id], evidenceIds: [execution.id] },
      409
    );
    assert.match(refusedRequest.error, new RegExp(`#${never.item.number}`));
    assert.equal(f.store.all<Verification>('loop_verifications').filter((row) => row.kind === 'release').length, 0);
    // Even a release-level review of the reviewed item alone cannot carry the unreviewed one.
    await f.reviewRelease([reviewed.item.id], [execution.id]);
    const refusedProposal = await f.call(
      'release.propose',
      f.proposal([reviewed.item.id, never.item.id], reviewed.evidence.id),
      409
    );
    assert.match(refusedProposal.error, /至少需要一次独立复核通过/);
  } finally {
    await f.cleanup();
  }
});

test('a release-level review needs an execution capture bound to the candidate source version', async () => {
  const f = await fixture();
  try {
    const only = await f.feature('唯一改动');
    await f.reviewItem(only.item.id, only.evidence.id);
    // Captured file content proves what was read, never that a check actually ran.
    const withoutExecution = await f.call(
      'verification.request',
      { kind: 'release', itemIds: [only.item.id], evidenceIds: [only.evidence.id] },
      400
    );
    assert.match(withoutExecution.error, /至少一项当前源版本的执行证据/);
    const execution = await f.grant.execute('node --test');
    f.editSource('build four\n');
    // A real run, but of the previous source version: it says nothing about this candidate.
    const stale = await f.call(
      'verification.request',
      { kind: 'release', itemIds: [only.item.id], evidenceIds: [execution.id] },
      400
    );
    assert.match(stale.error, /至少一项当前源版本的执行证据/);
    assert.equal(f.store.all<Verification>('loop_verifications').filter((row) => row.kind === 'release').length, 0);
  } finally {
    await f.cleanup();
  }
});

test('a failed release-level review is kept as failed and no proposal is accepted on top of it', async () => {
  const f = await fixture();
  try {
    const only = await f.feature('唯一改动');
    await f.reviewItem(only.item.id, only.evidence.id);
    const execution = await f.grant.execute('node --test');
    f.reviewer.verdict = 'fail';
    const release = await f.reviewRelease([only.item.id], [execution.id]);
    assert.equal(release.status, 'failed');
    assert.equal(release.kind, 'release');
    assert(release.findings.some((finding) => finding.severity === 'blocking'));
    const refused = await f.call('release.propose', f.proposal([only.item.id], only.evidence.id), 409);
    assert.match(refused.error, /发布级复核/);
    assert.equal(f.store.all('loop_releases').length, 0);
    // Asking again for the same candidate replays the counterexample instead of buying a retry.
    f.reviewer.verdict = 'pass';
    const sent = f.reviewer.sent.length;
    const again = await f.call('verification.request', {
      kind: 'release',
      itemIds: [only.item.id],
      evidenceIds: [execution.id],
    });
    assert.equal(again.id, release.id);
    assert.equal(again.status, 'failed');
    assert.equal(f.reviewer.sent.length, sent);
  } finally {
    await f.cleanup();
  }
});

test('the same candidate and item set reuse the passed release-level review instead of paying again', async () => {
  const f = await fixture();
  try {
    const only = await f.feature('唯一改动');
    await f.reviewItem(only.item.id, only.evidence.id);
    const execution = await f.grant.execute('node --test');
    const release = await f.reviewRelease([only.item.id], [execution.id]);
    const sent = f.reviewer.sent.length;
    const again = await f.call('verification.request', {
      kind: 'release',
      itemIds: [only.item.id],
      evidenceIds: [execution.id],
    });
    assert.equal(again.id, release.id);
    assert.equal(again.status, 'passed');
    assert.equal(f.reviewer.sent.length, sent);
    assert.equal(f.store.all<Verification>('loop_verifications').filter((row) => row.kind === 'release').length, 1);
  } finally {
    await f.cleanup();
  }
});

test('completing an item still needs that item’s own review of the current source version', async () => {
  const f = await fixture();
  try {
    const only = await f.feature('唯一改动');
    const itemReview = await f.reviewItem(only.item.id, only.evidence.id);
    f.editSource('build five\n');
    const execution = await f.grant.execute('node --test');
    const release = await f.reviewRelease([only.item.id], [execution.id]);
    assert.equal(release.status, 'passed');
    // The release-level review covers the candidate, not the item's own acceptance: the engine's
    // completion gate still wants a current review of this item.
    const scope = { ...f.grant.run, id: 'test', expiresAt: '' } as any;
    assert.throws(() => f.engine.loop.verification.requirePassed(scope, only.item.id), /当前源版本的独立复核/);
    assert.equal(f.engine.loop.verification.requirePassedEver(scope, only.item.id).id, itemReview.id);
    const completion = await f.call('feature.upsert', {
      id: only.item.id,
      revision: f.store.get<any>('items', only.item.id).revision,
      title: only.item.title,
      summary: only.item.summary ?? '唯一改动的实际改动',
      kind: 'feature',
      status: 'verified',
      evidenceIds: [only.evidence.id],
      nextStep: '等待当前版本的独立复核',
    });
    assert.equal(completion.pendingVerification, true);
    assert.notEqual(completion.verificationId, release.id);
    assert.equal(f.store.get<any>('items', only.item.id).status, 'investigating');
    const fresh = f.stored(completion.verificationId);
    assert.equal(fresh.kind, undefined);
    assert.equal(fresh.itemId, only.item.id);
    await f.settle(fresh.id);
    assert.equal(f.store.get<any>('items', only.item.id).status, 'verified');
  } finally {
    await f.cleanup();
  }
});

test('a newer failed or unknown overlapping review blocks an older covering pass without blocking unrelated items', async () => {
  for (const verdict of ['fail', 'unknown'] as const) {
    for (const overlap of ['subset', 'overlap'] as const) {
      const f = await fixture();
      try {
        const items = await Promise.all(['A', 'B', 'C'].map((name) => f.feature(name)));
        for (const item of items) await f.reviewItem(item.item.id, item.evidence.id);
        const [a, b, c] = items.map((entry) => entry.item.id);
        const execution = await f.grant.execute('node --test');
        const passed = await f.reviewRelease([a, b], [execution.id]);
        f.reviewer.verdict = verdict;
        const rejected = await f.reviewRelease(overlap === 'subset' ? [a] : [a, c], [execution.id]);
        assert.equal(rejected.status, verdict === 'fail' ? 'failed' : 'unknown');
        for (const proposed of [[a], [a, b]]) {
          const result = await f.call('release.propose', f.proposal(proposed, execution.id), 409);
          assert.match(result.error, /发布级复核/);
        }
        assert.equal(f.store.all('loop_releases').length, 0);
        const unrelated = await f.call('release.propose', f.proposal([b], execution.id));
        assert.equal(unrelated.releaseVerificationId, passed.id);
        assert.equal(f.stored(rejected.id).status, rejected.status);
      } finally {
        await f.cleanup();
      }
    }
  }
});

test('pending overlapping reviews cannot be skipped, while a newer subset pass keeps the covering pass usable', async () => {
  const f = await fixture();
  try {
    const a = await f.feature('A'),
      b = await f.feature('B');
    for (const item of [a, b]) await f.reviewItem(item.item.id, item.evidence.id);
    const ids = [a.item.id, b.item.id];
    const execution = await f.grant.execute('node --test');
    const passed = await f.reviewRelease(ids, [execution.id]);
    f.reviewer.autoComplete = false;
    const pending = await f.call('verification.request', {
      kind: 'release',
      itemIds: [a.item.id],
      evidenceIds: [execution.id],
    });
    await f.call('release.propose', f.proposal(ids, execution.id), 409);
    await f.engine.loop.verification.start(pending.id);
    await f.call('release.propose', f.proposal(ids, execution.id), 409);
    f.reviewer.complete();
    assert.equal(f.stored(pending.id).status, 'passed');
    const result = await f.call('release.propose', f.proposal(ids, execution.id));
    assert.equal(result.releaseVerificationId, passed.id);
  } finally {
    await f.cleanup();
  }
});

test('a passed bounded retry supersedes only its own unknown scope and does not rewrite history', async () => {
  const f = await fixture();
  try {
    const a = await f.feature('A'),
      b = await f.feature('B');
    for (const item of [a, b]) await f.reviewItem(item.item.id, item.evidence.id);
    const ids = [a.item.id, b.item.id];
    const execution = await f.grant.execute('node --test');
    const passed = await f.reviewRelease(ids, [execution.id]);
    f.reviewer.verdict = 'unknown';
    const unknown = await f.reviewRelease([a.item.id], [execution.id]);
    await f.call('release.propose', f.proposal(ids, execution.id), 409);
    f.reviewer.verdict = 'pass';
    const retry = await f.call('verification.retry', { id: unknown.id });
    await f.settle(retry.id);
    const result = await f.call('release.propose', f.proposal(ids, execution.id));
    assert.equal(result.releaseVerificationId, passed.id);
    assert.equal(f.stored(unknown.id).status, 'unknown');
    assert.equal(f.stored(retry.id).status, 'passed');
    // An unrelated source version cannot invalidate this candidate's review history.
    f.editSource('other source\n');
    const otherExecution = await f.grant.execute('node --test');
    f.reviewer.verdict = 'fail';
    const other = await f.reviewRelease([b.item.id], [otherExecution.id]);
    f.editSource('build one\n');
    assert.equal(f.engine.loop.verification.current(other), false);
    const again = await f.call('release.propose', f.proposal(ids, execution.id));
    assert.equal(again.releaseVerificationId, passed.id);
  } finally {
    await f.cleanup();
  }
});

test('a superseded unknown cannot be retried after the daily limit resets to hide a newer failed or passed review', async () => {
  for (const verdict of ['fail', 'pass'] as const) {
    const f = await fixture();
    try {
      const item = await f.feature('A');
      await f.reviewItem(item.item.id, item.evidence.id);
      const execution = await f.grant.execute('node --test');
      f.reviewer.verdict = 'unknown';
      const original = await f.reviewRelease([item.item.id], [execution.id]);
      f.reviewer.verdict = verdict;
      const retry = await f.call('verification.retry', { id: original.id });
      await f.settle(retry.id);
      // Seed yesterday's attempts only in this disposable database; production history stays immutable.
      const yesterday = new Date(Date.now() - 86400000).toISOString();
      for (const id of [original.id, retry.id])
        f.store.put('loop_verifications', { ...f.stored(id), createdAt: yesterday });
      const count = f.store.all('loop_verifications').length;
      const result = await f.call('verification.retry', { id: original.id }, 409);
      assert.match(result.error, /更新.*复核|已被.*取代/);
      assert.equal(f.store.all('loop_verifications').length, count);
      assert.equal(f.stored(original.id).status, 'unknown');
      assert.equal(f.stored(retry.id).status, verdict === 'fail' ? 'failed' : 'passed');
    } finally {
      await f.cleanup();
    }
  }
});

test('only the latest unknown may use the next day retry budget', async () => {
  const f = await fixture();
  try {
    const item = await f.feature('A');
    await f.reviewItem(item.item.id, item.evidence.id);
    const execution = await f.grant.execute('node --test');
    f.reviewer.verdict = 'unknown';
    const original = await f.reviewRelease([item.item.id], [execution.id]);
    const newer = await f.call('verification.retry', { id: original.id });
    await f.settle(newer.id);
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    for (const id of [original.id, newer.id])
      f.store.put('loop_verifications', { ...f.stored(id), createdAt: yesterday });
    await f.call('verification.retry', { id: original.id }, 409);
    f.reviewer.verdict = 'pass';
    const current = await f.call('verification.retry', { id: newer.id });
    await f.settle(current.id);
    const proposed = await f.call('release.propose', f.proposal([item.item.id], execution.id));
    assert.equal(proposed.releaseVerificationId, current.id);
    assert.equal(f.stored(original.id).status, 'unknown');
    assert.equal(f.stored(newer.id).status, 'unknown');
  } finally {
    await f.cleanup();
  }
});

test('changing release scope cannot hide a current failure; a source fix permits a new candidate', async () => {
  const f = await fixture();
  try {
    const a = await f.feature('A'),
      b = await f.feature('B');
    for (const item of [a, b]) await f.reviewItem(item.item.id, item.evidence.id);
    const execution = await f.grant.execute('node --test');
    f.reviewer.verdict = 'fail';
    const failure = await f.reviewRelease([a.item.id], [execution.id]);
    f.reviewer.verdict = 'unknown';
    const unknown = await f.reviewRelease([a.item.id, b.item.id], [execution.id]);
    await f.call('verification.retry', { id: unknown.id }, 409);
    // Seed a hypothetical later pass defensively: neither this row nor its wider scope erases the failure.
    f.store.put('loop_verifications', { ...f.stored(unknown.id), status: 'passed' });
    await f.call('release.propose', f.proposal([a.item.id], execution.id), 409);
    await f.call('release.propose', f.proposal([a.item.id, b.item.id], execution.id), 409);
    f.editSource('fixed source\n');
    f.reviewer.verdict = 'pass';
    const fresh = await f.grant.execute('node --test');
    const verified = await f.reviewRelease([a.item.id, b.item.id], [fresh.id]);
    const result = await f.call('release.propose', f.proposal([a.item.id, b.item.id], fresh.id));
    assert.equal(result.releaseVerificationId, verified.id);
    assert.equal(f.stored(failure.id).status, 'failed');
  } finally {
    await f.cleanup();
  }
});
