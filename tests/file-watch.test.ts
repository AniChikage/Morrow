import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, symlinkSync, unlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { startIsolated } from './harness/service.ts';
import { grantFor } from './harness/grant.ts';

const future = () => new Date(Date.now() + 3600000).toISOString();
const input = (path = 'metrics.json', pointer = '/count') => ({
  kind: 'file',
  path,
  title: '文件反馈',
  pointer,
  condition: 'changed',
  deadline: future(),
});

test('missing files stay quiet, creation and changes wake waits, unchanged samples stay quiet and evidence survives restart', async () => {
  const s = await startIsolated();
  let restarted: Awaited<ReturnType<typeof s.restart>> | undefined;
  try {
    const { call } = grantFor(s, { projectId: s.project.id, channelId: s.channel.id });
    const w = await call('watch.create', input('.morrow/metrics.json'));
    const wait = () => call('wait', { watchIds: [w.id], releaseIds: [], deadline: future(), reason: '等文件变化' });
    await wait();
    const before = s.store.all('events').length;
    await s.engine.loop.poll(w.id);
    await s.engine.loop.poll(w.id);
    assert.equal(s.store.all('loop_evidence').length, 0);
    assert.equal(s.store.all('events').length, before);
    assert.equal(s.store.get<any>('loop_waits', s.channel.id).status, 'waiting');
    mkdirSync(join(s.path, '.morrow'));
    const raw = JSON.stringify({ count: 1 });
    writeFileSync(join(s.path, '.morrow/metrics.json'), raw);
    await s.engine.loop.poll(w.id);
    const evidence = s.store.all<any>('loop_evidence')[0];
    assert.equal(evidence.origin, 'file');
    assert.equal(evidence.source, realpathSync(join(s.path, '.morrow/metrics.json')));
    assert.equal(evidence.digest, createHash('sha256').update(raw).digest('hex'));
    assert.equal(evidence.pointer, '/count');
    assert.equal(evidence.value, 1);
    assert.deepEqual(evidence.data, { count: 1 });
    assert.equal(s.store.get<any>('loop_waits', s.channel.id).status, 'ready');
    await wait();
    await s.engine.loop.poll(w.id);
    assert.equal(s.store.all('loop_evidence').length, 1);
    assert.equal(s.store.get<any>('loop_waits', s.channel.id).status, 'waiting');
    writeFileSync(join(s.path, '.morrow/metrics.json'), JSON.stringify({ count: 2 }));
    await s.engine.loop.poll(w.id);
    assert.equal(s.store.all('loop_evidence').length, 2);
    assert.equal(s.store.get<any>('loop_waits', s.channel.id).status, 'ready');
    await wait();
    unlinkSync(join(s.path, '.morrow/metrics.json'));
    await s.engine.loop.poll(w.id);
    assert.equal(s.store.all('loop_evidence').length, 2);
    assert.equal(s.store.get<any>('loop_waits', s.channel.id).status, 'waiting');
    writeFileSync(join(s.path, '.morrow/metrics.json'), JSON.stringify({ count: 2 }));
    await s.engine.loop.poll(w.id);
    assert.equal(s.store.all('loop_evidence').length, 3);
    assert.equal(s.store.get<any>('loop_waits', s.channel.id).status, 'ready');
    await s.close();
    restarted = await s.restart();
    assert.deepEqual(restarted.store.get('loop_evidence', evidence.id), evidence);
    assert.equal(restarted.store.get<any>('loop_watches', w.id).path, w.path);
  } finally {
    await restarted?.cleanup();
    await s.cleanup();
  }
});

test('non-JSON with a pointer audits only once, recovers, and plain text without a pointer is captured', async () => {
  const s = await startIsolated();
  try {
    const { call } = grantFor(s, { projectId: s.project.id, channelId: s.channel.id });
    writeFileSync(join(s.path, 'metrics.json'), 'not json');
    const w = await call('watch.create', input());
    await s.engine.loop.poll(w.id);
    await s.engine.loop.poll(w.id);
    assert.equal(s.store.all<any>('events').filter((e) => e.action === 'feedback.unavailable').length, 1);
    assert.equal(s.store.all('loop_evidence').length, 0);
    writeFileSync(join(s.path, 'metrics.json'), '{"count":3}');
    await s.engine.loop.poll(w.id);
    assert.equal(s.store.get<any>('loop_watches', w.id).error, undefined);
    writeFileSync(join(s.path, 'plain.txt'), 'ready');
    const plain = await call('watch.create', input('plain.txt', ''));
    await s.engine.loop.poll(plain.id);
    const e = s.store.all<any>('loop_evidence').find((e) => e.watchId === plain.id);
    assert.equal(e.data, 'ready');
    assert.equal(e.value, 'ready');
  } finally {
    await s.cleanup();
  }
});

test('scheduled file polling respects enabled channels, intervals and cancellation', async () => {
  const s = await startIsolated();
  try {
    const { call } = grantFor(s, { projectId: s.project.id, channelId: s.channel.id });
    writeFileSync(join(s.path, 'metrics.json'), '{"count":1}');
    const w = await call('watch.create', input());
    const tick = async () => {
      s.engine.loop.tick();
      await Promise.all(s.engine.loop.pending);
    };
    await tick();
    assert.equal(s.store.all('loop_evidence').length, 0);
    s.store.put('channels', { ...s.channel, status: 'running' });
    s.store.put('controls', { id: s.channel.id, enabled: true });
    await tick();
    assert.equal(s.store.all('loop_evidence').length, 1);
    writeFileSync(join(s.path, 'metrics.json'), '{"count":2}');
    await tick();
    assert.equal(s.store.all('loop_evidence').length, 1);
    s.store.put('loop_watches', { ...s.store.get<any>('loop_watches', w.id), nextPollAt: new Date(0).toISOString() });
    await tick();
    assert.equal(s.store.all('loop_evidence').length, 2);
    await call('watch.cancel', { id: w.id });
    writeFileSync(join(s.path, 'metrics.json'), '{"count":3}');
    await tick();
    assert.equal(s.store.all('loop_evidence').length, 2);
  } finally {
    await s.cleanup();
  }
});

test('file watches reject escape, symlink components, mixed sources and later symlink replacements', async () => {
  const s = await startIsolated();
  try {
    const { call } = grantFor(s, { projectId: s.project.id, channelId: s.channel.id });
    await call('watch.create', input('../outside.json'), 403);
    await call('watch.create', input(s.root), 403);
    await call('watch.create', input('.'), 403);
    await call('watch.create', { ...input(), url: 'http://localhost/' }, 400);
    await call('watch.create', { ...input(), kind: 'command' }, 400);
    writeFileSync(join(s.path, 'real.json'), '{"count":1}');
    symlinkSync('real.json', join(s.path, 'link.json'));
    symlinkSync(s.path, join(s.path, 'linked-dir'));
    symlinkSync('absent.json', join(s.path, 'dangling'));
    for (const path of ['link.json', 'linked-dir/absent.json', 'dangling'])
      await call('watch.create', input(path), 403);
    const w = await call('watch.create', input('later.json'));
    symlinkSync('real.json', join(s.path, 'later.json'));
    await s.engine.loop.poll(w.id);
    assert.match(s.store.get<any>('loop_watches', w.id).error, /符号链接/);
    assert.equal(s.store.all('loop_evidence').length, 0);
    unlinkSync(join(s.path, 'later.json'));
    writeFileSync(join(s.path, 'later.json'), 'x'.repeat(512 * 1024 + 1));
    await s.engine.loop.poll(w.id);
    assert.match(s.store.get<any>('loop_watches', w.id).error, /512/);
  } finally {
    await s.cleanup();
  }
});

for (const includeWatch of [false, true])
  test(`file expectations accept fresh evidence and reject another file (watch expectation: ${includeWatch})`, async () => {
    const s = await startIsolated();
    try {
      const { call } = grantFor(s, { projectId: s.project.id, channelId: s.channel.id });
      writeFileSync(join(s.path, 'metrics.json'), '{"count":2}');
      writeFileSync(join(s.path, 'other.json'), '{"count":2}');
      const w = await call('watch.create', input());
      const other = await call('watch.create', input('other.json'));
      await s.engine.loop.poll(w.id);
      const baseline = s.store.get<any>('loop_watches', w.id).lastEvidenceId;
      const context = await call('context');
      const expectation = {
        kind: 'outcome',
        claim: 'count为2',
        scope: '隔离文件',
        verification: '核对count',
        disconfirm: 'count不是2',
        deadline: future(),
        rule: { pointer: '/count', operator: 'equals', expected: 2 },
      };
      const d = await call('decision.choose', {
        objectiveVersion: context.strategy.objective.version,
        options: [
          { title: '核对文件', kind: 'observe', benefit: '获得实际值', cost: '读文件', uncertainty: '真实效果未知' },
        ],
        selected: 0,
        rationale: '隔离核验',
        nextStep: '采集',
        expectedOutcome: 'count为2',
        evaluation: '字段核对',
        stopWhen: '字段缺失',
        understandingRefs: [],
        evidenceIds: [],
        watchIds: [w.id],
        reviewAt: future(),
        maxRuns: 2,
        expectations: [
          { ...expectation, id: 'file', source: { kind: 'file', path: 'metrics.json' } },
          ...(includeWatch ? [{ ...expectation, id: 'watch', source: { kind: 'watch', watchId: w.id } }] : []),
        ],
      });
      // A new expectation needs one new observation even when bytes match its old baseline.
      await s.engine.loop.poll(w.id);
      const id = s.store.get<any>('loop_watches', w.id).lastEvidenceId;
      assert.notEqual(id, baseline);
      await s.engine.loop.poll(w.id);
      assert.equal(s.store.get<any>('loop_watches', w.id).lastEvidenceId, id);
      await s.engine.loop.poll(other.id);
      const wrong = s.store.get<any>('loop_watches', other.id).lastEvidenceId;
      const review = (evidenceId: string) => ({
        id: d.id,
        revision: d.revision,
        outcome: 'improved',
        conclusion: '文件结果一致',
        evidenceIds: [evidenceId],
        nextDirection: '观察',
        assessment: {
          results: (includeWatch ? ['file', 'watch'] : ['file']).map((expectationId) => ({
            expectationId,
            verdict: 'met',
            reason: '字段核对',
            evidenceIds: [evidenceId],
          })),
          conditions: 'matched',
          conditionReason: '同文件',
          diagnosis: 'expected',
          explanation: '只验证字段',
          adjustment: 'observe',
        },
      });
      await call('decision.review', review(wrong), 400);
      const result = await call('decision.review', review(id));
      assert.equal(result.pendingVerification, true);
      assert.equal(result.verificationId.length > 0, true);
    } finally {
      await s.cleanup();
    }
  });
