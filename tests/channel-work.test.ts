import test from 'node:test';
import assert from 'node:assert/strict';
import { autonomousPrompt, parseWorkDecision, usageLine } from '../service/channel-work.ts';
const block = (value: unknown) => '```morrow-next\n' + JSON.stringify(value) + '\n```';
test('only bounded, explicit agent decisions can schedule more work', () => {
  const decision = { state: 'wait', focus: '验证', reason: '等待新证据', nextStep: '检查测试结果', waitMinutes: 20 };
  assert.deepEqual(parseWorkDecision(block(decision)), decision);
  for (const value of [
    { ...decision, state: 'launch' },
    { ...decision, waitMinutes: 0 },
    { ...decision, waitMinutes: 100000 },
    { ...decision, waitMinutes: 1.5 },
    { ...decision, nextStep: '' },
    { ...decision, reason: 'x'.repeat(2001) },
  ])
    assert.equal(parseWorkDecision(block(value)), null);
  assert.equal(parseWorkDecision('没有新的工作。'), null);
  assert.equal(parseWorkDecision('```morrow-next\n{'), null);
});
test('legacy NoHuman decision blocks remain readable after the Morrow rename', () => {
  const decision = {
    state: 'wait',
    focus: '兼容迁移',
    reason: '等待旧版数据导入完成',
    nextStep: '检查导入结果',
    waitMinutes: 60,
  };
  assert.deepEqual(parseWorkDecision('```nohuman-next\n' + JSON.stringify(decision) + '\n```'), decision);
});
test('the autonomous prompt asks for cheap, informative work under tight usage and states the numbers that apply', () => {
  const project = { name: 'p', path: '/tmp/p', goal: '目标' };
  const channel = { name: '自主推进', goal: '方向', permission: 'native' };
  const plain = autonomousPrompt(project, channel, [], null, {});
  const sentence = '额度紧张时优先做便宜且有信息价值的事，或选择等待。';
  assert(plain.includes(sentence));
  assert(!plain.includes('当前额度'));
  assert(plain.indexOf(sentence) > plain.indexOf('本频道沿用 Codex App 当前的权限设置'));
  assert(plain.indexOf(sentence) < plain.indexOf('上线必须通过'));
  const reading = {
    at: '2026-09-09T10:00:00.000Z',
    source: 'protocol' as const,
    windows: [{ name: '5h' as const, usedPercent: 42, resetsAt: '2026-09-09T13:00:00.000Z' }],
  };
  const withLimits = autonomousPrompt(
    project,
    channel,
    [],
    null,
    {},
    {
      runsToday: 1,
      maxRunsPerDay: 32,
      usage: {
        reading,
        stale: false,
        unknown: false,
        reserve: { window: '5h', keepPercent: 10 },
        project: { window: 'weekly', limitPercent: 30, usedPercent: 12.5 },
      },
    }
  );
  assert(
    withLimits.includes(
      '当前额度：账户5 小时额度已用 42%，保留线 10%（用到 90% 即停止自动工作）；本项目归因的每周额度估算已用 12.5%，上限 30%。'
    )
  );
  assert.equal(
    usageLine({
      runsToday: 0,
      maxRunsPerDay: 8,
      usage: { unknown: true, reserve: { window: 'weekly', keepPercent: 15 } },
    }),
    '当前额度：账户每周额度读数不可用，保留线 15%。'
  );
  assert.equal(usageLine({ runsToday: 0, maxRunsPerDay: 8, usage: { reading, unknown: false } }), '');
  assert.equal(usageLine(undefined), '');
});
