import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startIsolated } from './harness/service.ts';
import { grantFor } from './harness/grant.ts';
import type { Channel } from '../service/protocol.ts';

const next = (state: string) =>
  '```morrow-next\n' +
  JSON.stringify({ state, focus: '检查反馈', reason: '等待结果', nextStep: '读取复核', waitMinutes: 60 }) +
  '\n```';

test('pending wakes survive completion and registered waits without changing wait records', async (t) => {
  for (const state of ['wait', 'continue']) {
    for (const registered of [false, true]) {
      await t.test(`${state}, registered wait=${registered}`, async () => {
        const s = await startIsolated();
        try {
          const grant = grantFor(s, { projectId: s.project.id, channelId: s.channel.id });
          s.engine.setControl(s.channel.id, { enabled: true });
          s.store.put('channels', { ...s.channel, status: 'running', intervalMinutes: 60 });
          if (registered)
            await grant.call('wait', {
              watchIds: [],
              releaseIds: [],
              deadline: new Date(Date.now() + 3600000).toISOString(),
              reason: '等待复核',
            });
          const wait = s.store.get('loop_waits', s.channel.id);
          s.engine.loop.wake(s.channel.id, '第一次反馈');
          s.engine.loop.wake(s.channel.id, '复核已经完成');
          assert.equal(s.store.get<Channel>('channels', s.channel.id)?.status, 'running');
          s.engine.finishWithoutReport(grant.run, next(state));
          const before = Date.now();
          s.engine.completeAutonomousWork(grant.run, next(state), true);
          const channel = s.store.get<Channel>('channels', s.channel.id)!;
          assert(Date.parse(channel.nextRunAt) >= before + 5000);
          assert(Date.parse(channel.nextRunAt) <= Date.now() + 5000);
          assert.match(channel.work!.nextStep, /复核已经完成/);
          assert.equal((channel as any).pendingWake, undefined);
          assert.deepEqual(s.store.get('loop_waits', s.channel.id), wait);
        } finally {
          await s.cleanup();
        }
      });
    }
  }
});

test('pending wakes respect needs_input, manual pause, changed direction and absent work decisions', async (t) => {
  for (const mode of ['needs_input', 'paused', 'direction', 'missing', 'no-wake']) {
    await t.test(mode, async () => {
      const s = await startIsolated();
      try {
        const grant = grantFor(s, { projectId: s.project.id, channelId: s.channel.id });
        s.engine.setControl(s.channel.id, { enabled: true });
        s.store.put('channels', { ...s.channel, status: 'running', intervalMinutes: 60 });
        if (mode !== 'no-wake') s.engine.loop.wake(s.channel.id, '新的反馈');
        if (mode === 'paused') s.engine.setControl(s.channel.id, { enabled: false });
        if (mode === 'direction')
          s.store.put('channels', { ...s.store.get<Channel>('channels', s.channel.id)!, goal: '新的方向' });
        const text = mode === 'missing' ? '没有有效安排' : next(mode === 'needs_input' ? 'needs_input' : 'wait');
        s.engine.finishWithoutReport(grant.run, text);
        s.engine.completeAutonomousWork(grant.run, text, true);
        const channel = s.store.get<Channel>('channels', s.channel.id)!;
        assert.equal((channel as any).pendingWake, undefined);
        if (mode === 'needs_input' || mode === 'paused') {
          assert.equal(channel.nextRunAt, '');
          assert.equal(s.engine.control(channel.id).enabled, false);
          assert.equal(channel.status, mode === 'needs_input' ? 'blocked' : 'paused');
        } else if (mode === 'direction') {
          assert(Date.parse(channel.nextRunAt) > Date.now() + 20000);
          assert(Date.parse(channel.nextRunAt) <= Date.now() + 30000);
        } else {
          assert(Date.parse(channel.nextRunAt) > Date.now() + 30 * 60000);
        }
        s.engine.setControl(channel.id, { enabled: false });
        s.engine.loop.wake(channel.id, '暂停后不得写入');
        assert.equal((s.store.get<Channel>('channels', channel.id) as any).pendingWake, undefined);
      } finally {
        await s.cleanup();
      }
    });
  }
});

test('failed or interrupted runs clear pending wakes without resuming work', async () => {
  const s = await startIsolated();
  try {
    for (const status of ['failed', 'interrupted']) {
      const grant = grantFor(s, { projectId: s.project.id, channelId: s.channel.id });
      s.engine.setControl(s.channel.id, { enabled: true });
      s.store.put('channels', { ...s.channel, status: 'running', intervalMinutes: 60 });
      s.engine.loop.wake(s.channel.id, '失败前的反馈');
      s.engine.finishFailure(grant.run, status, '测试失败清理');
      const channel = s.store.get<Channel>('channels', s.channel.id)!;
      assert.equal((channel as any).pendingWake, undefined);
      assert.equal(channel.nextRunAt, '');
      assert.equal(s.engine.control(channel.id).enabled, false);
    }
  } finally {
    await s.cleanup();
  }
});
