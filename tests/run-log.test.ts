import './harness/env.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { startIsolated } from './harness/service.ts';
import { grantFor } from './harness/grant.ts';
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
      present: true,
      threadId: run.sessionId,
      turnId: run.nativeTurnId,
      type: 'commandExecution',
      raw: { command: 'npm test', status: 'completed', exitCode: 0 },
      text: '工具内容',
    });
    s.store.put('native_items', {
      id: 'native-file',
      present: true,
      threadId: run.sessionId,
      turnId: run.nativeTurnId,
      type: 'fileChange',
      raw: { changes: [{ path: 'src/import.ts' }] },
    });
    s.store.put('native_items', {
      id: 'native-other',
      present: true,
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
        present: true,
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

test('native removal and restoration update every log surface while sealed execution evidence stays immutable', async () => {
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
      sessionId: 'revision-thread',
      nativeTurnId: 'revision-turn',
      summary: '',
    };
    s.store.put('runs', run);
    const rows = [
      {
        id: 'withdrawn-command',
        type: 'commandExecution',
        raw: { command: 'withdrawn command', status: 'completed', exitCode: 0 },
      },
      { id: 'withdrawn-file', type: 'fileChange', raw: { changes: [{ path: 'withdrawn.ts' }] } },
      { id: 'withdrawn-mcp', type: 'mcpToolCall', raw: {}, text: 'withdrawn MCP output' },
      {
        id: 'captured-command',
        type: 'commandExecution',
        raw: { command: 'sealed check', status: 'completed', exitCode: 0 },
      },
    ].map((row, ordinal) => ({ ...row, threadId: run.sessionId, turnId: run.nativeTurnId, present: true, ordinal }));
    for (const row of rows) s.store.put('native_items', row);
    const evidence = {
      id: 'sealed-evidence',
      projectId: run.projectId,
      channelId: run.channelId,
      runId: run.id,
      origin: 'execution',
      summary: '封存检查',
      source: 'sealed check',
      digest: 'immutable-original-digest',
      data: {
        command: 'sealed check',
        nativeItemId: 'captured-command',
        status: 'completed',
        exitCode: 0,
        output: 'ok',
        outputComplete: true,
        boundVersion: true,
      },
    };
    s.store.put('loop_evidence', evidence);
    const detail = async () => (await s.api('GET', `/api/runs/${run.id}`)).run.log;
    const before = await detail();
    assert.equal(before.commands.length, 2);
    assert.deepEqual(before.files, ['withdrawn.ts']);
    assert.equal(before.activity.length, 4);
    // This is the production representation used when an item leaves the native snapshot.
    for (const row of rows) s.store.put('native_items', { ...row, present: false });
    const removed = await detail();
    assert.deepEqual(
      removed.commands.map((c: any) => c.id),
      ['sealed-evidence']
    );
    assert.equal(removed.commands[0].sealed, true);
    assert.deepEqual(removed.files, []);
    assert.deepEqual(removed.activity, []);
    const list = (await s.api('GET', `/api/runs?channelId=${run.channelId}`)).runs[0].log;
    assert.deepEqual(list.commands, removed.commands);
    assert.deepEqual(list.files, []);
    assert.deepEqual(s.store.get('loop_evidence', evidence.id), evidence);
    for (const row of rows) assert.deepEqual(s.store.get('native_items', row.id), { ...row, present: false });
    await s.restart();
    assert.deepEqual((await detail()).activity, []);
    for (const row of rows.slice(0, 3)) s.store.put('native_items', row);
    const restored = await detail();
    assert.equal(restored.commands.length, 2);
    assert.deepEqual(restored.files, ['withdrawn.ts']);
    assert.deepEqual(
      restored.activity.map((i: any) => i.id),
      rows.slice(0, 3).map((row) => row.id)
    );
    assert.deepEqual(s.store.get('loop_evidence', evidence.id), evidence);
  } finally {
    await s.cleanup();
  }
});

test('removed native items cannot consume the command, activity or file summary limits', async () => {
  const s = await startIsolated();
  try {
    const run = {
      id: randomUUID(),
      projectId: s.project.id,
      channelId: s.channel.id,
      runtime: 'codex',
      status: 'completed',
      startedAt: '2026-09-10T00:00:00Z',
      sessionId: 'limited-thread',
      nativeTurnId: 'turn',
      summary: '',
    };
    s.store.put('runs', run);
    const put = (id: string, present: boolean, type: string, raw: unknown) =>
      s.store.put('native_items', { id, threadId: run.sessionId, turnId: run.nativeTurnId, present, type, raw });
    for (let i = 0; i < 105; i++) put(`removed-command-${i}`, false, 'commandExecution', { command: 'removed' });
    for (let i = 0; i < 25; i++)
      put(`removed-file-${i}`, false, 'fileChange', { changes: [{ path: `removed-${i}.ts` }] });
    put('visible-command', true, 'commandExecution', { command: 'visible command', status: 'completed', exitCode: 0 });
    put('visible-file', true, 'fileChange', { changes: [{ path: 'visible.ts' }] });
    const log = (await s.api('GET', `/api/runs/${run.id}`)).run.log;
    assert.deepEqual(
      log.commands.map((c: any) => c.id),
      ['visible-command']
    );
    assert.deepEqual(log.files, ['visible.ts']);
    assert.deepEqual(
      log.activity.map((a: any) => a.id),
      ['visible-command', 'visible-file']
    );
    assert.equal(log.truncated, false);
  } finally {
    await s.cleanup();
  }
});

test('completed morrow-next decisions survive trailing citations and project log projections', async () => {
  const s = await startIsolated();
  try {
    const cases = [];
    for (const state of ['continue', 'wait'] as const) {
      const grant = grantFor(s, { projectId: s.project.id, channelId: s.channel.id });
      const work = {
        state,
        focus: `原始关注-${state}`,
        reason: '真实检查已完成',
        nextStep: '核对后续反馈',
        ...(state === 'wait' ? { waitMinutes: 5 } : {}),
      };
      const text =
        '已完成检查。\n```morrow-next\n' +
        JSON.stringify(work) +
        '\n```\n<oai-mem-citation>历史引用</oai-mem-citation>';
      const run = { ...grant.run, status: 'completed' as const, finishedAt: new Date().toISOString(), summary: text };
      s.store.put('runs', run);
      s.engine.completeAutonomousWork(run, text, false);
      cases.push({ run, work });
    }
    await s.restart();
    const page = await s.api('GET', `/api/runs?channelId=${s.channel.id}`);
    for (const { run, work } of cases) {
      const expected = { state: work.state, focus: work.focus, reason: work.reason, nextStep: work.nextStep };
      assert.deepEqual(page.runs.find((r: any) => r.id === run.id).log.work, expected);
      assert.deepEqual((await s.api('GET', `/api/runs/${run.id}`)).run.log.work, expected);
      assert.equal(s.store.get<Run>('runs', run.id)?.summary, run.summary);
    }
  } finally {
    await s.cleanup();
  }
});
