import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProjectWorkLoop } from '../service/project-loop.ts';
import { FakeReviewer } from './harness/fake-reviewer.ts';
import { startIsolated, type IsolatedService } from './harness/service.ts';
import { grantFor } from './harness/grant.ts';
import { startReceiver } from './harness/receiver.ts';
async function setup() {
  const receiver = await startReceiver({ feedback: { activation: 0.2 } });
  const remoteURL = receiver.url;
  const s = await startIsolated({ project: { name: '闭环验收', goal: '持续改善首次使用体验' } });
  await s.api(
    'POST',
    '/api/channels',
    { projectId: s.project.id, name: '共享观察验收', goal: '独立验证跨频道反馈', runtime: 'codex' },
    201
  );
  const grant = grantFor(s, { projectId: s.project.id, channelId: s.channel.id });
  const { run, context } = grant;
  const call = (operation: string, input: unknown, requestId = randomUUID(), expected = 200) =>
    grant.call(operation, input, expected, requestId);
  const featureSummary = '追踪实际体验';
  const feature = await call('feature.upsert', {
    title: '改善首次使用',
    summary: featureSummary,
    kind: 'feature',
    status: 'investigating',
    evidenceIds: [],
    nextStep: '建立反馈',
  });
  writeFileSync(join(s.path, 'checks.log'), '2 tests passed\n');
  const evidence = await call('evidence.capture', { itemId: feature.id, summary: '隔离测试日志', path: 'checks.log' });
  writeFileSync(join(s.path, 'release.txt'), 'immutable build one');
  // Release transport tests now cross the independent native gate with an explicit
  // protocol double; they do not claim that a real model verified this fixture.
  const reviewer = new FakeReviewer();
  reviewer.autoComplete = true;
  s.engine.loop.verification.connect(reviewer, (v) => v);
  const completion = await call('feature.upsert', {
    id: feature.id,
    revision: s.store.get<any>('items', feature.id).revision,
    title: feature.title,
    summary: featureSummary,
    kind: feature.kind,
    status: 'verified',
    evidenceIds: [evidence.id],
    nextStep: '准备本地发布',
  });
  assert.equal(completion.pendingVerification, true);
  await s.engine.loop.verification.start(completion.verificationId);
  assert.equal(s.store.get<any>('loop_verifications', completion.verificationId).status, 'passed');
  assert.equal(s.store.get<any>('items', feature.id).status, 'verified');
  assert.equal(s.store.get<any>('loop_finalizations', completion.finalizationId).status, 'applied');
  const releaseInput = {
    itemIds: [feature.id],
    title: '首次体验改进',
    changes: '修正失败提示并补充关键流程反馈',
    rationale: '测试发现失败状态无法恢复',
    expectedBenefit: '预期减少首次操作失败；线上收益尚待验证',
    checks: [{ name: '恢复流程测试', result: 'passed', evidenceIds: [evidence.id] }],
    risks: '影响首次使用路径',
    rollback: '恢复上一个产物',
    observationPlan: '观察关键操作完成率，再决定是否继续',
    artifactPath: 'release.txt',
    target: { url: remoteURL + '/deploy', statusUrl: remoteURL + '/status', label: '隔离测试发布端' },
  };
  return {
    ...s,
    call,
    context,
    run,
    feature,
    evidence,
    releaseInput,
    remoteURL,
    get posts() {
      return receiver.posts;
    },
    get uploaded() {
      return receiver.uploaded;
    },
    setFeedback: receiver.setFeedback,
    setMode: receiver.setMode,
    cleanup: async () => {
      await s.close();
      await receiver.close();
      await s.cleanup();
    },
  };
}
const future = () => new Date(Date.now() + 3600000).toISOString();
test('review retains old referenced evidence and native context offers scoped full reads without replaying large logs', async () => {
  const s = await setup();
  try {
    const release = await s.call('release.propose', s.releaseInput);
    for (let i = 0; i < 110; i++) s.store.put('loop_evidence', { ...s.evidence, id: `later-${i}`, itemId: undefined });
    const view = await s.api('GET', `/api/projects/${s.project.id}/work`);
    assert(view.evidence.some((row: any) => row.id === s.evidence.id));
    assert(view.releases.some((row: any) => row.id === release.id));
    const original = 'full evidence\n'.repeat(300);
    writeFileSync(join(s.path, 'long.log'), original);
    const long = await s.call('evidence.capture', { itemId: s.feature.id, summary: '完整证据', path: 'long.log' });
    // The write response is a receipt: provenance, digest and size, never the captured bytes.
    assert.equal(long.data, undefined);
    assert.equal(long.bytes, Buffer.byteLength(original));
    assert.equal(long.origin, 'file');
    assert.equal(typeof long.digest, 'string');
    assert(JSON.stringify(long).length < 1000);
    // The stored row is what the response used to be, so the saving is the content it no longer echoes.
    assert.equal(s.store.get<any>('loop_evidence', long.id).data, original);
    // An agent statement is echoed the same way: the payload it just sent does not come back.
    const payload = { claim: '首次完成率已回到基线以上', checked: false, sample: 'x'.repeat(4000) };
    const recorded = await s.call('evidence.record', {
      itemId: s.feature.id,
      summary: '本轮结论（agent 陈述）',
      source: 'agent:isolated-test',
      observedAt: new Date().toISOString(),
      data: payload,
    });
    assert.equal(recorded.data, undefined);
    assert.equal(recorded.origin, 'agent');
    assert.equal(recorded.bytes, Buffer.byteLength(JSON.stringify(payload)));
    assert(JSON.stringify(recorded).length < 1000);
    assert.deepEqual((await s.call('evidence.read', { id: recorded.id })).data, payload);
    const context = await s.call('context', {});
    const preview = context.evidence.find((row: any) => row.id === long.id);
    assert.equal(preview.data, undefined);
    assert.equal(preview.truncated, undefined);
    assert.equal(preview.bytes, Buffer.byteLength(original));
    for (const field of ['id', 'summary', 'source', 'origin', 'digest', 'observedAt'] as const)
      assert.equal(preview[field], (long as any)[field]);
    assert.equal(preview.itemId, s.feature.id);
    // Only `evidence.read` replays the preserved content.
    assert.equal((await s.call('evidence.read', { id: long.id })).data, original);
    s.store.put('loop_evidence', { ...long, data: original, id: 'foreign-evidence', projectId: 'another' });
    await s.call('evidence.read', { id: 'foreign-evidence' }, randomUUID(), 404);
  } finally {
    await s.cleanup();
  }
});
test('native tools maintain one project feature, evidence and revised conclusions with scoped idempotent writes', async () => {
  const s = await setup();
  try {
    const context = await s.call('context', {});
    assert.equal(context.features[0].id, s.feature.id);
    assert.equal(context.evidence[0].origin, 'file');
    assert.equal(context.features[0].evidence.length, 1);
    // Data in `context`, the unchanging contract text behind one read-only operation.
    for (const field of ['operations', 'releaseAdapter', 'principles', 'nativeCapabilities'] as const)
      assert.equal(context[field], undefined);
    const contract = await s.call('contract', {});
    assert.equal(typeof contract.operations['feature.upsert'], 'string');
    assert(contract.operations['release.propose'].includes('local-script'));
    assert(contract.releaseAdapter.includes('Idempotency-Key'));
    assert(contract.principles.includes('证据、解释和预期收益分开'));
    assert.equal(contract.nativeCapabilities.length >= 6, true);
    assert.equal(contract.briefRevision, 0);
    // A read operation: no requestId, and it never mutates.
    assert.deepEqual(await s.api('POST', '/api/agent', { operation: 'contract' }, 200, s.context.token), contract);
    await s.call('contract', { itemId: s.feature.id }, randomUUID(), 400);
    const id = randomUUID();
    const input = {
      itemId: s.feature.id,
      kind: 'hypothesis',
      title: '失败提示导致放弃',
      rationale: '需要区分技术故障与需求不足',
      expectedResult: '恢复后完成率增加',
      evaluation: '比较观测到的完成率',
      conclusion: '',
      status: 'active',
      evidenceIds: [],
    };
    const first = await s.call('learning.upsert', input, id);
    assert.deepEqual(await s.call('learning.upsert', input, id), first);
    await s.call('learning.upsert', { ...input, title: '不同内容' }, id, 409);
    const revised = await s.call('learning.upsert', {
      ...input,
      id: first.id,
      revision: 1,
      status: 'refuted',
      conclusion: '新证据不支持原判断',
      evidenceIds: [s.evidence.id],
    });
    assert.equal(revised.revision, 2);
    await s.call('learning.upsert', { ...input, id: first.id, revision: 1 }, randomUUID(), 409);
    const upserted = await s.call('feature.upsert', {
      id: s.feature.id,
      revision: s.store.get<any>('items', s.feature.id).revision,
      title: s.feature.title,
      summary: '继续追踪',
      kind: 'feature',
      status: 'verified',
      evidenceIds: [s.evidence.id],
      nextStep: '准备上线',
    });
    // A receipt of what was written, not a second copy of the board row.
    const stored = s.store.get<any>('items', s.feature.id);
    assert.deepEqual(
      Object.keys(upserted).filter((key) => !key.endsWith('Id') && key !== 'pendingVerification'),
      ['id', 'number', 'revision', 'kind', 'status', 'title']
    );
    assert.deepEqual(
      [upserted.id, upserted.number, upserted.revision, upserted.title],
      [stored.id, stored.number, stored.revision, stored.title]
    );
    assert.equal(upserted.summary, undefined);
    assert.equal(upserted.evidence, undefined);
    assert.equal(upserted.nextStep, undefined);
    assert(JSON.stringify(upserted).length < 1000);
    assert.equal(stored.origin, 'agent');
    assert.equal(s.store.all('items').length, 1);
    await s.call('release.approve', {}, randomUUID(), 400);
    await s.api('POST', '/api/releases/unknown/review', {}, 401, s.context.token);
    s.store.put('items', { ...s.feature, id: 'foreign', projectId: 'other' });
    await s.call(
      'evidence.record',
      { itemId: 'foreign', summary: 'wrong', source: 'fake', observedAt: new Date().toISOString() },
      randomUUID(),
      404
    );
    s.store.put('runs', { ...s.run, status: 'completed' });
    await s.call(
      'evidence.record',
      { summary: 'late', source: 'fake', observedAt: new Date().toISOString() },
      randomUUID(),
      409
    );
  } finally {
    await s.cleanup();
  }
});
test('release requires human approval, publishes exactly the sealed artifact once, then real HTTP feedback resumes work', async () => {
  const s = await setup();
  try {
    const release = await s.call('release.propose', s.releaseInput);
    assert.equal(release.status, 'awaiting_approval');
    s.engine.loop.tick();
    await Promise.allSettled([...s.engine.loop.pending]);
    assert.equal(s.posts, 0);
    const watch = await s.call('watch.create', {
      itemId: s.feature.id,
      title: '首次完成率',
      url: s.remoteURL + '/feedback',
      pointer: '/activation',
      condition: 'gte',
      expected: 0.6,
      deadline: future(),
      intervalSeconds: 30,
      releaseId: release.id,
    });
    await s.call('wait', { watchIds: [watch.id], releaseIds: [], deadline: future(), reason: '等待上线后的真实反馈' });
    s.engine.setControl(s.channel.id, { enabled: true });
    s.engine.completeAutonomousWork(s.run as any, '', true);
    assert(Date.parse(s.store.get<any>('channels', s.channel.id).nextRunAt) > Date.now() + 100000);
    await s.engine.loop.poll(watch.id);
    assert.equal(s.store.get<any>('loop_watches', watch.id).lastDigest, undefined);
    await s.api('POST', `/api/releases/${release.id}/review`, { reviewHash: 'stale', decision: 'approve' }, 409);
    assert.equal(s.posts, 0);
    writeFileSync(join(s.path, 'release.txt'), 'unreviewed later changes');
    await s.api('POST', `/api/releases/${release.id}/review`, { reviewHash: release.reviewHash, decision: 'approve' });
    await Promise.allSettled([...s.engine.loop.pending]);
    assert.equal(s.posts, 1);
    assert.equal(s.uploaded, 'immutable build one');
    assert.equal(s.engine.loop.release(release.id).status, 'published');
    await s.api('POST', `/api/releases/${release.id}/review`, { reviewHash: release.reviewHash, decision: 'approve' });
    assert.equal(s.posts, 1);
    await s.engine.loop.poll(watch.id);
    assert.equal(s.store.get<any>('loop_watches', watch.id).status, 'watching');
    s.setFeedback({ activation: 0.7 });
    await s.engine.loop.poll(watch.id);
    assert.equal(s.store.get<any>('loop_watches', watch.id).status, 'triggered');
    assert.equal(s.store.get<any>('loop_waits', s.channel.id).status, 'ready');
    assert(Date.parse(s.store.get<any>('channels', s.channel.id).nextRunAt) < Date.now() + 10000);
    const view = await s.api('GET', `/api/projects/${s.project.id}/work?itemId=${s.feature.id}`);
    assert.equal(view.evidence.filter((v: any) => v.origin === 'http').length, 2);
    assert.equal(view.releases[0].id, release.id);
    assert(s.store.all<any>('events').some((e) => e.action === 'release.approved' && e.actor === 'human'));
  } finally {
    await s.cleanup();
  }
});
test('uncertain deployment is reconciled read-only after restart without a duplicate publication', async () => {
  const s = await setup();
  try {
    const release = await s.call('release.propose', s.releaseInput);
    s.setMode('disconnect');
    await s.api('POST', `/api/releases/${release.id}/review`, { reviewHash: release.reviewHash, decision: 'approve' });
    await Promise.allSettled([...s.engine.loop.pending]);
    assert.equal(s.engine.loop.release(release.id).status, 'unknown');
    assert.equal(s.posts, 1);
    const recovered = new ProjectWorkLoop(s.store, s.home);
    recovered.recover();
    await recovered.reconcile(release.id);
    assert.equal(recovered.release(release.id).status, 'published');
    recovered.tick();
    await recovered.close();
    assert.equal(s.posts, 1);
  } finally {
    await s.cleanup();
  }
});
test('invalid receipts and modified sealed files never masquerade as a successful approved release', async () => {
  const s = await setup();
  try {
    const release = await s.call('release.propose', s.releaseInput);
    s.setMode('wrong');
    await s.api('POST', `/api/releases/${release.id}/review`, { reviewHash: release.reviewHash, decision: 'approve' });
    await Promise.allSettled([...s.engine.loop.pending]);
    assert.equal(s.engine.loop.release(release.id).status, 'unknown');
    const another = await s.call('release.propose', { ...s.releaseInput, title: '另一版本' });
    writeFileSync(s.engine.loop.artifactPath(another.id), 'tampered');
    await s.api(
      'POST',
      `/api/releases/${another.id}/review`,
      { reviewHash: another.reviewHash, decision: 'approve' },
      409
    );
    assert.equal(s.posts, 1);
  } finally {
    await s.cleanup();
  }
});
test('changed feedback needs a baseline, cross-channel waits wake correctly, and manual pause remains authoritative', async () => {
  const s = await setup();
  try {
    const watch = await s.call('watch.create', {
      itemId: s.feature.id,
      title: '观察变化',
      url: s.remoteURL + '/feedback',
      pointer: '/activation',
      condition: 'changed',
      deadline: future(),
      intervalSeconds: 30,
    });
    await s.engine.loop.poll(watch.id);
    assert.equal(s.store.get<any>('loop_watches', watch.id).status, 'watching');
    const count = s.store.all('loop_evidence').length;
    await s.engine.loop.poll(watch.id);
    assert.equal(s.store.all('loop_evidence').length, count);
    const other = s.store.all<any>('channels')[1];
    s.engine.setControl(other.id, { enabled: true });
    s.store.put('loop_waits', {
      id: other.id,
      projectId: s.project.id,
      runId: 'other-run',
      watchIds: [watch.id],
      releaseIds: [],
      deadline: future(),
      status: 'waiting',
      reason: '共享观察',
    });
    s.engine.setControl(s.channel.id, { enabled: false });
    s.store.put('channels', { ...s.channel, status: 'paused', nextRunAt: '' });
    s.setFeedback({ activation: 0.3 });
    await s.engine.loop.poll(watch.id);
    assert.equal(s.store.get<any>('channels', s.channel.id).nextRunAt, '');
    assert.equal(s.store.get<any>('loop_waits', other.id).status, 'ready');
    assert(s.store.get<any>('channels', other.id).nextRunAt);
  } finally {
    await s.cleanup();
  }
});
test('a rejected release persists feedback and leaves independent work enabled', async () => {
  const s = await setup();
  try {
    const release = await s.call('release.propose', s.releaseInput);
    await s.call('wait', { watchIds: [], releaseIds: [release.id], deadline: future(), reason: '等待上线确认' });
    s.engine.setControl(s.channel.id, { enabled: true });
    s.engine.completeAutonomousWork(s.run as any, '', true);
    await s.api('POST', `/api/releases/${release.id}/review`, {
      reviewHash: release.reviewHash,
      decision: 'reject',
      feedback: '补充失败恢复验证',
    });
    assert.equal(s.engine.loop.release(release.id).feedback, '补充失败恢复验证');
    assert.equal(s.engine.control(s.channel.id).enabled, true);
    assert.equal(s.posts, 0);
    assert.equal(s.store.get<any>('loop_waits', s.channel.id).status, 'ready');
  } finally {
    await s.cleanup();
  }
});
test('feedback failures wake investigation once and expired observations never invent a successful result', async () => {
  const s = await setup();
  try {
    const watch = await s.call('watch.create', {
      itemId: s.feature.id,
      title: '检查数据缺口',
      url: s.remoteURL + '/feedback',
      pointer: '/missing',
      condition: 'changed',
      deadline: future(),
      intervalSeconds: 30,
    });
    await s.call('wait', { watchIds: [watch.id], releaseIds: [], deadline: future(), reason: '等待数据' });
    s.engine.setControl(s.channel.id, { enabled: true });
    s.engine.completeAutonomousWork(s.run as any, '', true);
    await s.engine.loop.poll(watch.id);
    await s.engine.loop.poll(watch.id);
    assert.equal(s.store.all<any>('events').filter((e) => e.action === 'feedback.unavailable').length, 1);
    assert.equal(s.store.get<any>('loop_waits', s.channel.id).status, 'ready');
    assert.equal(s.store.get<any>('loop_watches', watch.id).status, 'watching');
    s.store.put('loop_watches', { ...s.store.get<any>('loop_watches', watch.id), deadline: new Date(0).toISOString() });
    await s.engine.loop.poll(watch.id);
    assert.equal(s.store.get<any>('loop_watches', watch.id).status, 'expired');
    assert.equal(s.store.all<any>('loop_evidence').filter((e) => e.origin === 'http').length, 0);
  } finally {
    await s.cleanup();
  }
});
test('SQLite restart retains sealed releases, observations, waits and existing channel preferences', async () => {
  const s = await setup();
  let restarted: IsolatedService | undefined;
  try {
    const release = await s.call('release.propose', s.releaseInput);
    await s.call('wait', {
      watchIds: [],
      releaseIds: [release.id],
      deadline: future(),
      reason: '等待已准备版本的确认',
    });
    s.store.put('runs', { ...s.run, status: 'completed' });
    const before = s.store.get<any>('channels', s.channel.id);
    await s.close();
    restarted = await s.restart();
    assert.deepEqual(restarted.store.get('channels', s.channel.id), before);
    assert.equal(restarted.engine.loop.release(release.id).reviewHash, release.reviewHash);
    assert.equal(restarted.store.get<any>('loop_waits', s.channel.id).status, 'waiting');
    assert.equal(restarted.store.get<any>('items', s.feature.id).evidence.length, 1);
    assert.equal(readFileSync(restarted.engine.loop.artifactPath(release.id), 'utf8'), 'immutable build one');
    assert.equal(s.posts, 0);
  } finally {
    await restarted?.close();
    await s.cleanup();
  }
});
test('long-term feedback continues after its review deadline, wakes on new evidence, stays quiet when unchanged and stops on cancellation', async () => {
  const s = await setup();
  try {
    const watch = await s.call('watch.create', {
      itemId: s.feature.id,
      title: '持续监测体验',
      url: s.remoteURL + '/feedback',
      pointer: '/activation',
      condition: 'changed',
      deadline: future(),
      intervalSeconds: 30,
    });
    assert.equal(watch.continuous, true);
    await s.engine.loop.poll(watch.id);
    s.store.put('loop_watches', { ...s.store.get<any>('loop_watches', watch.id), deadline: new Date(0).toISOString() });
    await s.engine.loop.poll(watch.id);
    assert.equal(s.store.get<any>('loop_watches', watch.id).status, 'expired');
    await s.call('wait', { watchIds: [], releaseIds: [], deadline: future(), reason: '稳定时降低复查频率' });
    s.engine.setControl(s.channel.id, { enabled: true });
    s.engine.completeAutonomousWork(s.run as any, '', true);
    const sleeping = s.store.get<any>('channels', s.channel.id).nextRunAt;
    await s.engine.loop.poll(watch.id);
    assert.equal(s.store.get<any>('channels', s.channel.id).nextRunAt, sleeping);
    s.setFeedback({ activation: 0.1 });
    await s.engine.loop.poll(watch.id);
    const awake = s.store.get<any>('channels', s.channel.id).nextRunAt;
    assert(Date.parse(awake) < Date.now() + 6000);
    const observed = s.store.all<any>('loop_evidence').length;
    await s.engine.loop.poll(watch.id);
    assert.equal(s.store.get<any>('channels', s.channel.id).nextRunAt, awake);
    assert.equal(s.store.all<any>('loop_evidence').length, observed);
    await s.call('watch.cancel', { id: watch.id });
    s.setFeedback({ activation: 0 });
    await s.engine.loop.poll(watch.id);
    assert.equal(s.store.all<any>('loop_evidence').length, observed);
    const once = await s.call('watch.create', {
      title: '一次性实验',
      url: s.remoteURL + '/feedback',
      pointer: '/activation',
      condition: 'changed',
      deadline: future(),
      continuous: false,
    });
    s.store.put('loop_watches', { ...once, deadline: new Date(0).toISOString() });
    await s.engine.loop.poll(once.id);
    await s.engine.loop.poll(once.id);
    assert.equal(s.store.get<any>('loop_watches', once.id).lastDigest, undefined);
  } finally {
    await s.cleanup();
  }
});
test('the native command-line tool reads its scoped context and accepts JSON over stdin', async () => {
  const s = await setup();
  try {
    const contextPath = join(s.home, 'runs', s.run.id, 'agent-context.json');
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [
        fileURLToPath(new URL('../service/agent-cli.ts', import.meta.url)),
        '--context',
        contextPath,
        '--operation',
        'evidence.record',
        '--input',
        '-',
        '--request-id',
        'cli-input-check',
      ]);
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (v) => (stdout += v));
      child.stderr.on('data', (v) => (stderr += v));
      child.once('error', reject);
      child.once('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr))));
      child.stdin.end(
        JSON.stringify({
          itemId: s.feature.id,
          summary: '原生工具输入验收',
          source: 'isolated-native-tool',
          observedAt: new Date().toISOString(),
          data: { observed: true },
        })
      );
    });
    const evidence = JSON.parse(output);
    assert.equal(evidence.origin, 'agent');
    assert.equal(evidence.projectId, s.project.id);
    assert.equal(output.includes(s.context.token), false);
    assert.equal(s.store.get<any>('items', s.feature.id).evidence.length, 2);
  } finally {
    await s.cleanup();
  }
});
