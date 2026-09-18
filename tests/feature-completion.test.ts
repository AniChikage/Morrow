import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startIsolated } from './harness/service.ts';
import { grantFor } from './harness/grant.ts';
import { FakeReviewer } from './harness/fake-reviewer.ts';

async function fixture() {
  const native = new FakeReviewer();
  const s = await startIsolated({
    nativeTransport: native,
    project: { files: { 'source.js': 'export const value=1;\n' } },
  });
  const { call } = grantFor(s, { projectId: s.project.id, channelId: s.channel.id });
  try {
    const input = {
      title: '当前事项完成',
      summary: '同一验收材料',
      kind: 'issue',
      status: 'investigating',
      evidenceIds: [],
      nextStep: '完成本地核验',
    };
    const item = await call('feature.upsert', input);
    writeFileSync(join(s.path, 'result.json'), JSON.stringify({ value: 1 }));
    const context = await call('context');
    const future = new Date(Date.now() + 3600000).toISOString();
    const chosen = await call('decision.choose', {
      objectiveVersion: context.strategy.objective.version,
      options: [
        {
          title: '核对结果',
          kind: 'investigate',
          benefit: '验证完成条件',
          cost: '隔离夹具',
          uncertainty: '仅测试门禁',
        },
      ],
      selected: 0,
      rationale: '历史窗口夹具',
      nextStep: '读取文件',
      expectedOutcome: '结果值正确',
      evaluation: '核对实际文件',
      stopWhen: '出现反例',
      understandingRefs: [],
      evidenceIds: [],
      watchIds: [],
      reviewAt: future,
      maxRuns: 1,
      itemId: item.id,
      expectations: [
        {
          id: 'result',
          kind: 'outcome',
          claim: '结果为1',
          scope: '临时项目',
          source: { kind: 'file', path: 'result.json' },
          verification: '值为1',
          disconfirm: '不为1',
          deadline: future,
          rule: { pointer: '/value', operator: 'equals', expected: 1 },
        },
      ],
    });
    const decision = s.store.get<any>('strategy_decisions', chosen.id)!;
    // Seed a pre-existing expired window only in the disposable database; never edit real historical expectations.
    const old = {
      ...decision,
      status: 'reviewed',
      createdAt: new Date(Date.now() - 7200000).toISOString(),
      expectations: decision.expectations.map((e: any) => ({
        ...e,
        notBefore: new Date(Date.now() - 7200000).toISOString(),
        deadline: new Date(Date.now() - 3600000).toISOString(),
      })),
    };
    s.store.put('strategy_decisions', old);
    const evidence = await call('evidence.capture', { itemId: item.id, summary: '当前材料', path: 'result.json' });
    const job = await call('verification.request', { itemId: item.id, evidenceIds: [evidence.id] });
    await s.engine.loop.verification.start(job.id);
    native.complete();
    const passed = s.store.get<any>('loop_verifications', job.id)!;
    assert.equal(passed.status, 'passed');
    assert.equal(s.engine.loop.verification.current(passed), true);
    return { s, call, native, input, item, old, chosen, evidence, job };
  } catch (error) {
    await s.cleanup();
    throw error;
  }
}

test('a current standalone item review completes after an expired reviewed action without rewriting history', async () => {
  const { s, call, input, item, old, chosen, evidence, job } = await fixture();
  try {
    const count = s.store.all('loop_verifications').length;
    const result = await call('feature.upsert', {
      ...input,
      id: item.id,
      revision: s.store.get<any>('items', item.id)!.revision,
      status: 'resolved',
      evidenceIds: [evidence.id],
    });
    assert.equal(result.status, 'resolved');
    assert.equal(result.verificationId, job.id);
    assert.equal(s.store.all('loop_verifications').length, count);
    assert.deepEqual(s.store.get<any>('strategy_decisions', chosen.id), old);
  } finally {
    await s.cleanup();
  }
});

for (const scenario of [
  'source',
  'title',
  'summary',
  'kind',
  'extra-reference',
  'new-observation',
  'unassigned-observation',
  'failed',
  'unknown',
  'new-action',
  'unreviewed-action',
]) {
  test(`completion cannot skip ${scenario}`, async () => {
    const { s, call, native, input, item, old, evidence, job } = await fixture();
    try {
      const patch: Record<string, unknown> = {};
      let ids = [evidence.id];
      if (scenario === 'source') writeFileSync(join(s.path, 'source.js'), 'changed source');
      if (scenario === 'title') patch.title = 'changed title';
      if (scenario === 'summary') patch.summary = 'changed acceptance';
      if (scenario === 'kind') patch.kind = 'feature';
      if (scenario === 'extra-reference') {
        const added = await call('evidence.record', {
          itemId: item.id,
          summary: 'new material',
          source: 'fixture',
          observedAt: new Date().toISOString(),
          data: { value: 2 },
        });
        ids.push(added.id);
      }
      if (scenario === 'new-observation' || scenario === 'unassigned-observation')
        await call('evidence.capture', {
          ...(scenario === 'new-observation' ? { itemId: item.id } : {}),
          summary: 'new raw sample',
          path: 'result.json',
        });
      if (scenario === 'failed' || scenario === 'unknown') {
        const added = await call('evidence.record', {
          itemId: item.id,
          summary: 'next review material',
          source: 'fixture',
          observedAt: new Date().toISOString(),
          data: {},
        });
        const next = await call('verification.request', { itemId: item.id, evidenceIds: [evidence.id, added.id] });
        await s.engine.loop.verification.start(next.id);
        native.verdict = scenario === 'failed' ? 'fail' : 'unknown';
        native.complete();
      }
      if (scenario === 'new-action') {
        // A new action with a still-open window cannot inherit the historical standalone pass.
        s.store.put('strategy_decisions', {
          ...old,
          id: 'new-action',
          status: 'reviewed',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          expectations: old.expectations.map((e: any) => ({
            ...e,
            notBefore: new Date().toISOString(),
            deadline: new Date(Date.now() + 3600000).toISOString(),
          })),
        });
      }
      if (scenario === 'unreviewed-action') s.store.put('strategy_decisions', { ...old, status: 'active' });
      const before = s.store.get<any>('items', item.id)!;
      await call(
        'feature.upsert',
        { ...input, ...patch, id: item.id, revision: before.revision, status: 'resolved', evidenceIds: ids },
        409
      );
      assert.deepEqual(s.store.get<any>('items', item.id), before);
      assert.equal(s.store.get<any>('loop_verifications', job.id)!.status, 'passed');
    } finally {
      await s.cleanup();
    }
  });
}

test('another item review and progress notes cannot replace the current item review', async () => {
  const { s, call, native, input, item, evidence, job } = await fixture();
  try {
    const other = await call('feature.upsert', { ...input, title: 'another item' });
    const note = await call('evidence.record', {
      itemId: other.id,
      summary: 'other item',
      source: 'fixture',
      observedAt: new Date().toISOString(),
      data: {},
    });
    const review = await call('verification.request', { itemId: other.id, evidenceIds: [note.id] });
    await s.engine.loop.verification.start(review.id);
    native.complete();
    await call('evidence.record', {
      itemId: item.id,
      summary: 'progress only',
      source: 'fixture',
      observedAt: new Date().toISOString(),
      data: {},
    });
    const result = await call('feature.upsert', {
      ...input,
      id: item.id,
      revision: s.store.get<any>('items', item.id)!.revision,
      status: 'resolved',
      evidenceIds: [evidence.id],
    });
    assert.equal(result.verificationId, job.id);
    assert.notEqual(result.verificationId, review.id);
  } finally {
    await s.cleanup();
  }
});
