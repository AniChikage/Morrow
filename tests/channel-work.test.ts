import test from 'node:test';
import assert from 'node:assert/strict';
import {
  autonomousCharter,
  autonomousPrompt,
  autonomousTurnNote,
  parseWorkDecision,
  usageLine,
} from '../service/channel-work.ts';
import { nativeCapabilities, nativeCapabilitiesMeasuredAt } from '../service/native-capabilities.ts';
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
  const plain = autonomousPrompt({ project, channel, reportSchema: {} });
  const sentence = '额度紧张时优先做便宜且有信息价值的事，或选择等待。';
  assert(plain.includes(sentence));
  assert(!plain.includes('当前额度'));
  assert(plain.indexOf(sentence) > plain.indexOf('本频道沿用 Codex App 中此任务的权限设置'));
  assert(plain.indexOf(sentence) < plain.indexOf('上线必须通过'));
  const reading = {
    at: '2026-09-09T10:00:00.000Z',
    source: 'protocol' as const,
    windows: [{ name: '5h' as const, usedPercent: 42, resetsAt: '2026-09-09T13:00:00.000Z' }],
  };
  const budget = {
    runsToday: 1,
    maxRunsPerDay: 32,
    usage: {
      reading,
      stale: false,
      unknown: false,
      reserve: { window: '5h' as const, keepPercent: 10 },
      project: { window: 'weekly' as const, limitPercent: 30, usedPercent: 12.5 },
    },
  };
  const withLimits = autonomousPrompt({ project, channel, reportSchema: {}, budget });
  // The reading changes every turn, so it travels with the turn note rather than the charter.
  assert(!autonomousCharter({ project, channel, budget }).includes('当前额度'));
  assert(autonomousTurnNote({ project, channel, budget }).includes('当前额度'));
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
test('the inherited App scope, the measured capability line and product exploration are all in the autonomous prompt', () => {
  const project = { name: 'p', path: '/tmp/p', goal: '目标' };
  const channel = { name: '自主推进', goal: '方向', permission: 'native' };
  const prompt = autonomousPrompt({ project, channel, reportSchema: {} });
  assert(
    prompt.includes(
      '本频道沿用 Codex App 中此任务的权限设置；实际能否写入、联网或使用工具以 App 当前权限为准，仍需遵守项目规则和上线确认'
    )
  );
  assert(!prompt.includes('不要假设拥有完整访问'));
  // The exploration paragraph sits right after the goal/direction block, before the context instructions.
  const exploration =
    '产品层面的探索是常规工作的一部分：用可用的原生工具（Computer Use；浏览器插件可用时）走完整流程、看使用数据、找体验问题，把发现记为 feature/issue/hypothesis 并附可回看的证据；优先用原生记忆保存跨轮次的个人经验，Morrow 的记录只放影响决策的认识与证据。';
  assert(prompt.includes(exploration));
  assert(prompt.indexOf(exploration) > prompt.indexOf('当前工作方向：方向'));
  assert(prompt.indexOf(exploration) < prompt.indexOf('沿用这条原生任务的完整上下文'));
  // One dated line naming what the probe found and what it did not; nothing here is a live check.
  assert(prompt.includes(`原生能力（${nativeCapabilitiesMeasuredAt} 实测）：`));
  assert(prompt.includes('可用 应用内浏览器插件、Computer Use（@oai/sky）、Web 搜索、Morrow 工作接口（agent-cli.ts）'));
  assert(prompt.includes('部分可用 原生记忆'));
  assert(!prompt.includes('不可用 应用内浏览器插件'));
  assert(prompt.includes('未实测 Chrome / Edge 浏览器'));
  // The dated inventory itself moved to the `contract` operation; the line points there.
  assert(prompt.includes('以 contract 操作返回的 nativeCapabilities 说明为准'));
  // A read-only channel keeps its own scope sentence and still learns what the native tools can do.
  const readOnly = autonomousPrompt({ project, channel: { ...channel, permission: 'read-only' }, reportSchema: {} });
  assert(readOnly.includes('本频道为只读范围：仅调查验证并提出有依据的建议'));
  assert(readOnly.includes(`原生能力（${nativeCapabilitiesMeasuredAt} 实测）：`));
});
test('the capability inventory stays a dated record with a reachable status for every entry', () => {
  assert(nativeCapabilities.length >= 6);
  for (const entry of nativeCapabilities) {
    assert.equal(entry.measuredAt, nativeCapabilitiesMeasuredAt);
    assert(['available', 'unavailable', 'partial', 'untested'].includes(entry.status));
    for (const field of ['id', 'name', 'note', 'howTo'] as const) assert(entry[field].trim().length > 0);
  }
  assert.equal(new Set(nativeCapabilities.map((entry) => entry.id)).size, nativeCapabilities.length);
  const byId = new Map(nativeCapabilities.map((entry) => [entry.id, entry]));
  assert.equal(byId.get('in-app-browser')!.status, 'available');
  assert.equal(byId.get('chrome-browser')!.status, 'untested');
  assert.equal(byId.get('computer-use')!.status, 'available');
  assert.equal(byId.get('native-memory')!.status, 'partial');
  assert.equal(byId.get('web-search')!.status, 'available');
  assert.equal(byId.get('morrow-work-interface')!.status, 'available');
});
