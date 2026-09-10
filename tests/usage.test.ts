import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { usageFreshnessMs } from '../service/usage.ts';
import type { UsageReading, UsageWindow } from '../service/protocol.ts';
import { FakeReviewer } from './harness/fake-reviewer.ts';
import { startIsolated } from './harness/service.ts';
import { grantFor } from './harness/grant.ts';
import { pause, until } from './harness/wait.ts';
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const reading = (usedPercent: number, resetsAt?: string, window: UsageWindow = '5h'): UsageReading => ({
  at: new Date().toISOString(),
  source: 'protocol',
  windows: [{ name: window, usedPercent, ...(resetsAt ? { resetsAt } : {}) }],
});
/** The reviewer double plus one App task Morrow can bind and schedule, and an injectable usage read. */
class UsageNative extends FakeReviewer {
  cwd = '';
  threadId = randomUUID();
  reads = 0;
  readUsage?: () => Promise<UsageReading | undefined>;
  constructor() {
    super();
    this.snapshots.set(this.threadId, {
      threadId: this.threadId,
      ownerClientId: 'actual-app-owner',
      revision: 1,
      syncedAt: new Date().toISOString(),
      state: { cwd: '', turns: [], requests: [], currentPermissions: { sandboxPolicy: { type: 'readOnly' } } },
    });
  }
  bindTo(cwd: string) {
    this.cwd = cwd;
    this.snapshots.get(this.threadId)!.state.cwd = cwd;
  }
  async listThreads(cwd = '') {
    return cwd && realpathSync(cwd) === realpathSync(this.cwd)
      ? [{ id: this.threadId, title: '原生任务', cwd, updatedAt: Date.now() }]
      : [];
  }
  usage(source: () => UsageReading | undefined | Promise<UsageReading | undefined>) {
    this.readUsage = async () => {
      this.reads++;
      return source();
    };
  }
  /** Ends the scheduled turn on the bound task without a board report. */
  finishTurn(text = '这一轮已完成。') {
    this.complete(this.threadId, { items: [{ id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text }] });
  }
}
async function setup() {
  const transport = new UsageNative();
  const s = await startIsolated({
    nativeTransport: ({ path }) => {
      transport.bindTo(path);
      return transport;
    },
    project: { name: '额度项目', goal: '在额度内持续推进', files: { 'source.js': 'export const value=1;\n' } },
  });
  const { project, channel } = s;
  await s.api('POST', `/api/channels/${channel.id}/native/bind`, { threadId: transport.threadId });
  const channelRow = () => s.store.get<any>('channels', channel.id);
  const projectRow = () => s.store.get<any>('projects', project.id);
  const systemEvents = (needle: string) =>
    s.store
      .all<any>('events')
      .filter((e) => e.channelId === channel.id && e.kind === 'system' && e.text.includes(needle));
  /** Makes the scheduler consider the channel due right now. */
  const due = () => s.store.put('channels', { ...channelRow(), nextRunAt: iso(-1000) });
  /** A running run with its work grant, so `context` can be read the way a native turn reads it. */
  const grant = () =>
    grantFor(s, {
      projectId: project.id,
      channelId: channel.id,
      overrides: { sessionId: transport.threadId, nativeTurnId: 'implementer-turn' },
    });
  return { ...s, transport, channelRow, projectRow, systemEvents, due, grant };
}
test('a reached reserve line parks scheduled work until the reset with one event, and refuses manual runs', async () => {
  const s = await setup();
  try {
    await s.api('PATCH', '/api/settings', { usageReserve: { window: '5h', keepPercent: 10 } });
    const resetsAt = iso(3600_000);
    s.transport.usage(() => reading(92, resetsAt));
    await s.engine.usage.refresh();
    const refused = await s.api('POST', `/api/channels/${s.channel.id}/action`, { action: 'run' }, 429);
    assert.match(refused.error, /已用 92%.*保留线（保留 10%）/);
    await s.engine.action(s.channel.id, 'resume');
    const waiting = s.channelRow();
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.nextRunAt, resetsAt);
    assert.equal(waiting.usageWait.kind, 'reserve');
    assert.equal(waiting.usageWait.window, '5h');
    assert.equal(waiting.usageWait.resetsAt, resetsAt);
    assert.equal(s.transport.sent.length, 0);
    assert.equal(s.store.all('runs').length, 0);
    assert.equal(s.engine.budgetCount(s.channel.id), 0);
    assert.equal(s.systemEvents('保留线').length, 1);
    for (let attempt = 0; attempt < 3; attempt++) {
      s.due();
      s.engine.tick();
      await pause(20);
    }
    assert.equal(s.systemEvents('保留线').length, 1);
    assert.equal(s.channelRow().nextRunAt, resetsAt);
    assert.equal(s.channelRow().usageWait.since, waiting.usageWait.since);
    assert.equal(s.transport.sent.length, 0);
    const state = await s.api('GET', '/api/state');
    assert.deepEqual(state.settings.usageReserve, { window: '5h', keepPercent: 10 });
    assert.equal(state.usage.stale, false);
    assert.equal(state.usage.reading.windows[0].usedPercent, 92);
    assert.equal('phase' in state.usage.reading, false);
    assert.equal(state.channels.find((c: any) => c.id === s.channel.id).usageWait.kind, 'reserve');
    const status = await s.api('GET', '/api/native/status');
    assert.equal(status.usage.reading.windows[0].usedPercent, 92);
  } finally {
    await s.cleanup();
  }
});
test('once the window resets and the reading drops, the parked channel starts and its wait is cleared', async () => {
  const s = await setup();
  try {
    await s.api('PATCH', '/api/settings', { usageReserve: { window: '5h', keepPercent: 10 } });
    const resetsAt = iso(1200);
    s.transport.usage(() => reading(95, resetsAt));
    await s.engine.usage.refresh();
    await s.engine.action(s.channel.id, 'resume');
    assert.equal(s.channelRow().nextRunAt, resetsAt);
    s.transport.usage(() => reading(12, iso(3600_000)));
    await pause(1300);
    // The old value expired with its window: the tick re-reads and waits a few seconds silently.
    s.engine.tick();
    await pause(30);
    const pending = s.channelRow();
    assert.equal(pending.status, 'waiting');
    assert(pending.nextRunAt > resetsAt);
    assert.equal(pending.usageWait.kind, 'reserve');
    assert.equal(s.systemEvents('保留线').length, 1);
    assert.equal(s.transport.sent.length, 0);
    s.due();
    s.engine.tick();
    await until(() => s.store.all<any>('runs').length === 1);
    assert.equal(s.transport.sent.length, 1);
    assert.equal(s.channelRow().usageWait, undefined);
    assert.equal(s.channelRow().status, 'running');
    assert.equal(s.store.all<any>('runs')[0].trigger, 'schedule');
  } finally {
    await s.cleanup();
  }
});
test('a project budget sums attributed run deltas inside the window and clearing it releases the channel', async () => {
  const s = await setup();
  try {
    const budget = { window: '5h', limitPercent: 30 };
    const updated = await s.api('PATCH', `/api/projects/${s.project.id}/usage-budget`, { usageBudget: budget });
    assert.deepEqual(updated.usageBudget, budget);
    assert.deepEqual(s.projectRow().usageBudget, budget);
    const audit = s.store
      .all<any>('events')
      .find((e) => e.action === 'project.updated' && e.projectId === s.project.id);
    assert.equal(audit.actor, 'human');
    assert.deepEqual(audit.changes, { before: { usageBudget: null }, after: { usageBudget: budget } });
    const run = (delta: number, finishedAt: string, id = randomUUID()) =>
      s.store.put('runs', {
        id,
        projectId: s.project.id,
        channelId: s.channel.id,
        runtime: 'codex',
        model: '',
        permission: 'native',
        trigger: 'schedule',
        resumedFromSessionId: '',
        reportStatus: 'missing',
        reportError: '',
        status: 'completed',
        startedAt: finishedAt,
        finishedAt,
        summary: '',
        sessionId: '',
        usage: { delta: { '5h': delta }, attribution: 'estimated' },
      });
    run(20, iso(-60_000));
    run(15, iso(-120_000));
    run(50, iso(-6 * 3600_000));
    const view = await s.api('GET', `/api/projects/${s.project.id}/usage`);
    assert.deepEqual(view.budget, budget);
    assert.equal(view.reading, undefined);
    assert.equal(view.stale, true);
    assert.equal(view.project.usedPercent, 35);
    assert.equal(view.project.runs, 2);
    assert.equal(view.gate.kind, 'budget');
    assert.match(view.gate.message, /本项目归因的5 小时额度估算已达上限 30%（已用 35%，估算）/);
    await s.api('POST', `/api/channels/${s.channel.id}/action`, { action: 'run' }, 429);
    await s.engine.action(s.channel.id, 'resume');
    const waiting = s.channelRow();
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.usageWait.kind, 'budget');
    assert.equal(waiting.usageWait.window, '5h');
    assert.equal(waiting.nextRunAt, s.engine.nextBudget());
    assert.equal(s.systemEvents('估算').length, 1);
    assert.equal(s.store.all<any>('runs').filter((r) => r.status === 'running').length, 0);
    const cleared = await s.api('PATCH', `/api/projects/${s.project.id}/usage-budget`, { usageBudget: null });
    assert.equal('usageBudget' in cleared, false);
    assert.equal(s.projectRow().usageBudget, undefined);
    const released = s.channelRow();
    assert(released.nextRunAt <= iso(5000));
    assert(released.nextRunAt < waiting.nextRunAt);
    assert.deepEqual(s.engine.usage.gate(s.projectRow()), { blocked: false });
    s.due();
    s.engine.tick();
    await until(() => s.transport.sent.length === 1);
    assert.equal(s.channelRow().usageWait, undefined);
  } finally {
    await s.cleanup();
  }
});
test('a queued independent review stays queued while the gate blocks and runs once the reading allows', async () => {
  const s = await setup();
  try {
    await s.api('PATCH', '/api/settings', { usageReserve: { window: '5h', keepPercent: 10 } });
    s.transport.usage(() => reading(95, iso(3600_000)));
    await s.engine.usage.refresh();
    const { call } = s.grant();
    writeFileSync(join(s.path, 'result.json'), JSON.stringify({ value: 1 }));
    const evidence = await call('evidence.capture', { summary: '实际文件内容', path: 'result.json' });
    const item = await call('feature.upsert', {
      title: '完整结果',
      summary: '修复并追踪返回值',
      kind: 'feature',
      status: 'verified',
      evidenceIds: [evidence.id],
      nextStep: '验证反例',
    });
    assert.equal(item.pendingVerification, true);
    const row = () => s.store.get<any>('loop_verifications', item.verificationId);
    const waits = () => s.store.all<any>('events').filter((e) => e.action === 'verification.usage-wait');
    for (let attempt = 0; attempt < 2; attempt++) {
      await s.engine.loop.verification.start(item.verificationId);
      assert.equal(row().status, 'queued');
      assert.equal(row().usageWait.kind, 'reserve');
      assert(row().retryAt > new Date().toISOString());
      assert(row().retryAt <= iso(61_000));
      assert.equal(s.transport.sent.length, 0);
    }
    assert.equal(waits().length, 1);
    s.engine.loop.verification.tick();
    assert.equal(row().status, 'queued');
    s.transport.usage(() => reading(20, iso(3600_000)));
    await s.engine.usage.refresh();
    await s.engine.loop.verification.start(item.verificationId);
    assert.equal(row().status, 'running');
    assert.equal(row().usageWait, undefined);
    assert.equal(row().retryAt, undefined);
    assert.equal(s.transport.sent.length, 1);
    assert.deepEqual(s.transport.sent[0].options, {
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    });
    s.transport.complete();
    assert.equal(row().status, 'passed');
    assert.equal(s.store.get<any>('items', item.id).status, 'verified');
  } finally {
    await s.cleanup();
  }
});
test('without limits nothing is read; an unavailable reading only blocks when the user opted in', async () => {
  const s = await setup();
  try {
    s.transport.usage(() => reading(99));
    for (let attempt = 0; attempt < 3; attempt++)
      assert.deepEqual(s.engine.usage.gate(s.projectRow()), { blocked: false });
    assert.equal(s.transport.reads, 0);
    // Nothing has been read yet, which the UI must not present as a protocol that returned nothing.
    assert.deepEqual(s.engine.usage.status(), { stale: true, attempted: false });
    await s.api('PATCH', '/api/settings', { usageReserve: { window: '5h', keepPercent: 10 } });
    // A read that has not answered yet: a short silent wait, and manual starts are told to retry shortly.
    let answer!: (value: UsageReading | undefined) => void;
    s.transport.usage(() => new Promise<UsageReading | undefined>((resolve) => (answer = resolve)));
    const pending = s.engine.usage.gate(s.projectRow());
    assert.equal(pending.blocked && pending.kind, 'unknown');
    assert.equal(pending.blocked && pending.pending, true);
    assert.equal(pending.blocked && pending.message, '正在读取额度');
    const retry = await s.api('POST', `/api/channels/${s.channel.id}/action`, { action: 'run' }, 409);
    assert.equal(retry.error, '额度读数尚未就绪，几秒后重试');
    assert.equal(s.systemEvents('额度').length, 0);
    answer(undefined);
    await pause(10);
    assert.deepEqual(s.engine.usage.gate(s.projectRow()), { blocked: false });
    // The attempt happened and produced nothing: the reason is kept, bounded and token-free.
    assert.deepEqual(s.engine.usage.status(), {
      stale: true,
      attempted: true,
      lastError: '原生后台没有返回额度读数',
    });
    const { call } = s.grant();
    const context = await call('context');
    assert.equal(context.budget.usage.unknown, true);
    assert.equal(context.budget.usage.reading, undefined);
    assert.deepEqual(context.budget.usage.reserve, { window: '5h', keepPercent: 10 });
    assert.equal(context.budget.maxRunsPerDay, 32);
    assert.equal(typeof context.budget.runsToday, 'number');
    await s.api('PATCH', '/api/settings', { stopWhenUsageUnknown: true });
    const blocked = s.engine.usage.gate(s.projectRow());
    assert(blocked.blocked && blocked.kind === 'unknown' && !blocked.pending);
    const until = Date.parse(blocked.blocked ? blocked.until : '');
    assert(Math.abs(until - (Date.now() + usageFreshnessMs)) < 5000);
    assert.match(blocked.blocked ? blocked.message : '', /额度读数不可用，已按设置停止自动工作/);
    await s.engine.action(s.channel.id, 'resume');
    assert.equal(s.channelRow().status, 'waiting');
    assert.equal(s.channelRow().usageWait.kind, 'unknown');
    assert.equal(s.systemEvents('额度读数不可用').length, 1);
    assert.equal(s.transport.sent.length, 0);
    await s.api('PATCH', '/api/settings', { stopWhenUsageUnknown: false });
    assert.deepEqual(s.engine.usage.gate(s.projectRow()), { blocked: false });
  } finally {
    await s.cleanup();
  }
});
test('a reading younger than ten minutes is reused; an older one triggers a re-read', async () => {
  const s = await setup();
  try {
    await s.api('PATCH', '/api/settings', { usageReserve: { window: 'weekly', keepPercent: 20 } });
    s.transport.usage(() => reading(30, iso(6 * 24 * 3600_000), 'weekly'));
    await s.engine.usage.refresh();
    assert.equal(s.transport.reads, 1);
    for (let attempt = 0; attempt < 3; attempt++)
      assert.deepEqual(s.engine.usage.gate(s.projectRow()), { blocked: false });
    await pause(10);
    assert.equal(s.transport.reads, 1);
    const sample = s.engine.usage.latest()!;
    s.store.put('usage_samples', { ...sample, at: iso(-usageFreshnessMs - 60_000) });
    assert.equal(s.engine.usage.status().stale, true);
    assert.deepEqual(s.engine.usage.gate(s.projectRow()), { blocked: false });
    await until(() => s.transport.reads === 2);
    await until(() => s.engine.usage.status().stale === false);
    assert.equal(s.store.all('usage_samples').length, 2);
  } finally {
    await s.cleanup();
  }
});
test('runs carry before/after account samples and their estimated per-window delta', async () => {
  const s = await setup();
  try {
    const readings = [reading(40, iso(3600_000)), reading(43, iso(3600_000))];
    s.transport.usage(() => readings.shift());
    await s.api('POST', `/api/channels/${s.channel.id}/action`, { action: 'run' });
    const run = s.store.all<any>('runs')[0];
    await until(() => s.store.get<any>('runs', run.id).usage?.before);
    assert.equal(s.store.get<any>('runs', run.id).usage.before.windows[0].usedPercent, 40);
    s.transport.finishTurn();
    const finished = await until(() => {
      const row = s.store.get<any>('runs', run.id);
      return row.usage?.delta ? row : undefined;
    });
    assert.equal(finished.status, 'completed');
    assert.deepEqual(finished.usage.delta, { '5h': 3 });
    assert.equal(finished.usage.attribution, 'estimated');
    assert.equal(finished.usage.after.windows[0].usedPercent, 43);
    const samples = s.store.all<any>('usage_samples').filter((row) => row.runId === run.id);
    assert.deepEqual(
      samples.map((row) => row.phase),
      ['before', 'after']
    );
    assert(samples.every((row) => row.projectId === s.project.id && row.channelId === s.channel.id));
    assert.equal(s.transport.reads, 2);
  } finally {
    await s.cleanup();
  }
});
test('settings and budget routes validate input, refuse demo projects and work grants, and audit changes', async () => {
  const s = await setup();
  try {
    assert.equal(s.store.get('settings', 'global'), undefined);
    const initial = await s.api('GET', '/api/settings');
    assert.equal(initial.id, 'global');
    assert.equal(initial.usageReserve, undefined);
    assert.equal(s.store.get<any>('settings', 'global').id, 'global');
    for (const input of [
      {},
      { foo: 1 },
      { usageReserve: { window: 'daily', keepPercent: 10 } },
      { usageReserve: { window: '5h', keepPercent: 0 } },
      { usageReserve: { window: '5h', keepPercent: 100 } },
      { usageReserve: { window: '5h', keepPercent: 10, extra: true } },
      { usageReserve: 'none' },
      { stopWhenUsageUnknown: 'yes' },
    ])
      await s.api('PATCH', '/api/settings', input, 400);
    const saved = await s.api('PATCH', '/api/settings', {
      usageReserve: { window: 'weekly', keepPercent: 25 },
      stopWhenUsageUnknown: true,
    });
    assert.deepEqual(saved.usageReserve, { window: 'weekly', keepPercent: 25 });
    assert.equal(saved.stopWhenUsageUnknown, true);
    const cleared = await s.api('PATCH', '/api/settings', { usageReserve: null });
    assert.equal(cleared.usageReserve, undefined);
    assert.equal(cleared.stopWhenUsageUnknown, true);
    const audits = s.store.all<any>('events').filter((e) => e.action === 'settings.updated');
    assert.equal(audits.length, 2);
    assert.equal(audits[0].actor, 'human');
    assert.equal(audits[0].projectId, '');
    assert.equal(audits[0].changes.before.usageReserve, undefined);
    assert.deepEqual(audits[0].changes.after.usageReserve, { window: 'weekly', keepPercent: 25 });
    assert.deepEqual(audits[1].changes.before.usageReserve, { window: 'weekly', keepPercent: 25 });
    assert.equal(audits[1].changes.after.usageReserve, undefined);
    for (const input of [
      {},
      { usageBudget: { window: '5h', limitPercent: 0 } },
      { usageBudget: { window: '5h', limitPercent: 101 } },
      { usageBudget: { window: 'daily', limitPercent: 10 } },
      { usageBudget: { window: '5h' } },
      { usageBudget: { window: '5h', limitPercent: 10 }, goal: 'x' },
    ])
      await s.api('PATCH', `/api/projects/${s.project.id}/usage-budget`, input, 400);
    await s.api('PATCH', '/api/projects/missing/usage-budget', { usageBudget: null }, 404);
    await s.api('GET', '/api/projects/missing/usage', undefined, 404);
    await s.api('POST', '/api/demo', {});
    const demo = s.store.all<any>('projects').find((p) => p.isDemo);
    await s.api(
      'PATCH',
      `/api/projects/${demo.id}/usage-budget`,
      { usageBudget: { window: '5h', limitPercent: 10 } },
      409
    );
    const { token: secret } = s.grant();
    await s.api('GET', '/api/settings', undefined, 401, secret);
    await s.api('PATCH', '/api/settings', { stopWhenUsageUnknown: false }, 401, secret);
    await s.api('PATCH', `/api/projects/${s.project.id}/usage-budget`, { usageBudget: null }, 401, secret);
    await s.api('GET', `/api/projects/${s.project.id}/usage`, undefined, 401, secret);
    await s.api('PATCH', `/api/projects/${s.project.id}/usage-budget`, {
      usageBudget: { window: '5h', limitPercent: 40 },
    });
    const state = await s.api('GET', '/api/state');
    assert.deepEqual(state.settings, s.store.get('settings', 'global'));
    assert.deepEqual(state.usage, { stale: true, attempted: false });
    assert.deepEqual(state.projects.find((p: any) => p.id === s.project.id).usageBudget, {
      window: '5h',
      limitPercent: 40,
    });
    assert.equal('usageWait' in state.channels.find((c: any) => c.id === s.channel.id), false);
  } finally {
    await s.cleanup();
  }
});

test('runtime usage refresh works before association or budget configuration; ordinary status reads stay cheap', async () => {
  const transport = new UsageNative();
  const s = await startIsolated({ nativeTransport: transport, project: false });
  try {
    transport.usage(() => reading(37, iso(3600_000)));
    const initial = await s.api('GET', '/api/native/status');
    assert.equal(initial.usage.attempted, false);
    assert.equal(transport.reads, 0);
    const first = await s.api('GET', '/api/native/status?refreshUsage=1');
    assert.equal(first.usage.reading.windows[0].usedPercent, 37);
    assert.equal(first.usage.stale, false);
    assert.equal(first.usage.attempted, true);
    transport.usage(() => reading(41, iso(3600_000)));
    await s.api('GET', '/api/native/status');
    assert.equal(transport.reads, 1);
    const next = await s.api('GET', '/api/native/status?refreshUsage=1');
    assert.equal(next.usage.reading.windows[0].usedPercent, 41);
    transport.usage(() => {
      throw new Error('usage fixture unavailable');
    });
    const failed = await s.api('GET', '/api/native/status?refreshUsage=1');
    assert.equal(failed.connected, true);
    assert.equal(failed.usage.reading.windows[0].usedPercent, 41);
    assert.equal(failed.usage.lastError, 'usage fixture unavailable');
    assert.equal(s.store.all('projects').length, 0);
    assert.equal(s.store.all('native_bindings').length, 0);
    assert.equal(s.store.all('runs').length, 0);
    assert.equal(transport.sent.length, 0);
  } finally {
    await s.cleanup();
  }
});
