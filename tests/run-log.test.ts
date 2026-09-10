import './harness/env.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { startIsolated } from './harness/service.ts';
import type { Run } from '../service/protocol.ts';

test('channel run logs join durable records by run and native turn, leave originals unchanged, and expand on demand', async () => {
  const s = await startIsolated();
  try {
    const run: Run = {
      id: randomUUID(),
      projectId: s.project.id,
      channelId: s.channel.id,
      runtime: 'codex',
      status: 'completed',
      startedAt: '2026-09-10T00:00:00Z',
      finishedAt: '2026-09-10T00:01:00Z',
      sessionId: 'thread-one',
      nativeTurnId: 'turn-one',
      summary: '原始总结',
      workDirection: '改善导入',
    };
    s.store.put('runs', run);
    s.engine.audit({
      projectId: run.projectId,
      channelId: run.channelId,
      runId: run.id,
      actor: 'agent',
      action: 'channel.next-step',
      text: '继续验证',
      after: { state: 'wait', focus: '导入失败', reason: '出现复现证据', nextStep: '等待新报告' },
    });
    s.engine.audit({
      projectId: run.projectId,
      channelId: run.channelId,
      runId: run.id,
      actor: 'agent',
      action: 'feature.updated',
      itemId: 'item-one',
      text: '更新事项',
      after: { title: '修复导入' },
    });
    s.engine.audit({
      projectId: run.projectId,
      channelId: run.channelId,
      runId: run.id,
      actor: 'agent',
      action: 'decision.reviewed',
      text: '验证判断',
    });
    s.store.put('loop_evidence', {
      id: 'ev-one',
      projectId: run.projectId,
      channelId: run.channelId,
      runId: run.id,
      origin: 'execution',
      summary: '命令已执行',
      source: 'npm test',
      data: {
        command: 'npm test',
        exitCode: 0,
        status: 'completed',
        boundVersion: true,
        outputComplete: true,
        nativeItemId: 'native-one',
        output: 'ok',
      },
    });
    s.store.put('loop_verifications', {
      id: 'review-one',
      projectId: run.projectId,
      channelId: run.channelId,
      runId: run.id,
      status: 'passed',
      summary: '独立核对通过',
    });
    s.store.put('native_items', {
      id: 'native-one',
      threadId: run.sessionId,
      turnId: run.nativeTurnId,
      type: 'commandExecution',
      raw: { command: 'npm test', status: 'completed', exitCode: 0 },
      text: '工具内容',
    });
    s.store.put('native_items', {
      id: 'native-file',
      threadId: run.sessionId,
      turnId: run.nativeTurnId,
      type: 'fileChange',
      raw: { changes: [{ path: 'src/import.ts' }] },
    });
    s.store.put('native_items', {
      id: 'native-other',
      threadId: run.sessionId,
      turnId: 'other-turn',
      type: 'commandExecution',
      raw: { command: '不得串入' },
    });
    s.store.put('loop_evidence', {
      id: 'ev-other',
      projectId: run.projectId,
      channelId: 'other-channel',
      runId: run.id,
      origin: 'file',
      summary: '不得串入',
    });
    const get = () => s.api('GET', `/api/runs?channelId=${run.channelId}`);
    const log = (await get()).runs[0].log;
    assert.equal(log.work.focus, '导入失败');
    assert.equal(log.work.reason, '出现复现证据');
    assert.equal(log.work.nextStep, '等待新报告');
    assert.deepEqual(log.files, ['src/import.ts']);
    assert.equal(log.commands.length, 1);
    assert.equal(log.commands[0].sealed, true);
    assert.equal(log.commands[0].exitCode, 0);
    assert.deepEqual(log.outputs.map((o: any) => o.kind).sort(), ['判断', '看板事项', '证据', '独立复核'].sort());
    assert.equal(log.activity, undefined);
    assert.ok(!JSON.stringify(log).includes('不得串入'));
    const detail = await s.api('GET', `/api/runs/${run.id}`);
    assert.equal(detail.run.log.activity.length, 2);
    assert.deepEqual(s.store.get('runs', run.id), run);
    // A later channel decision must not replace a historical round's persisted work.
    s.store.put('channels', { ...s.channel, work: { state: 'continue', focus: '新方向', runId: 'another' } });
    assert.equal((await get()).runs[0].log.work.focus, '导入失败');
  } finally {
    await s.cleanup();
  }
});

test('run summaries bound native output and counts and never invent missing outcomes', async () => {
  const s = await startIsolated();
  try {
    const run = {
      id: randomUUID(),
      projectId: s.project.id,
      channelId: s.channel.id,
      runtime: 'codex',
      status: 'completed',
      startedAt: '2026-09-10T00:00:00Z',
      sessionId: 'thread',
      nativeTurnId: 'turn',
      summary: '没有结构化结论',
    };
    s.store.put('runs', run);
    for (let i = 0; i < 105; i++)
      s.store.put('native_items', {
        id: `item-${i}`,
        threadId: 'thread',
        turnId: 'turn',
        type: 'commandExecution',
        text: 'x'.repeat(8000),
        raw: { command: `command ${i}`, status: 'completed', aggregatedOutput: 'y'.repeat(8000) },
      });
    const page = await s.api('GET', `/api/runs?channelId=${run.channelId}`);
    const log = page.runs[0].log;
    assert.equal(log.work, undefined);
    assert.equal(log.commands.length, 20);
    assert.equal(log.commands[0].exitCode, undefined);
    assert.equal(log.commands[0].sealed, false);
    assert.ok(log.commands[0].output.length <= 301);
    assert.equal(log.truncated, true);
    const details = await s.api('GET', `/api/runs/${run.id}`);
    assert.equal(details.run.log.activity.length, 100);
    assert.ok(details.run.log.activity.every((a: any) => a.text.length <= 4001));
  } finally {
    await s.cleanup();
  }
});
