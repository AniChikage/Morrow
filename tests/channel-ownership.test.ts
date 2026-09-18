import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boardDigest } from '../service/channel-work.ts';
import { now } from '../service/store.ts';
import { startIsolated } from './harness/service.ts';
import { grantFor } from './harness/grant.ts';
import { FakeReviewer } from './harness/fake-reviewer.ts';
import type { Channel, Event, WorkItem } from '../service/protocol.ts';

const future = () => new Date(Date.now() + 3600000).toISOString();
const threadId = 'ownership-thread';

/**
 * One project, two channels, one board. Each channel holds its own work grant, the way two scheduled
 * turns of the same project do. Nothing calls a model: the native transport is a protocol double.
 */
async function setup() {
  const native = new FakeReviewer();
  const s = await startIsolated({
    nativeTransport: native,
    project: { name: '事项归属', goal: '让两条方向安全分工', files: { 'result.json': JSON.stringify({ value: 1 }) } },
  });
  const other: Channel = await s.api(
    'POST',
    '/api/channels',
    { projectId: s.project.id, name: '运营洞察', goal: '从真实反馈中发现机会', runtime: 'codex' },
    201
  );
  const a = grantFor(s, { projectId: s.project.id, channelId: s.channel.id });
  const b = grantFor(s, { projectId: s.project.id, channelId: other.id });
  const feature = (patch: Record<string, unknown> = {}) => ({
    title: '首次使用受阻',
    summary: '共享看板上的事项',
    kind: 'issue',
    status: 'investigating',
    evidenceIds: [],
    nextStep: '先复现用户描述的路径',
    ...patch,
  });
  /** A complete, otherwise valid `decision.choose`, so a refusal can only come from ownership. */
  const chooseInput = async (call: typeof a.call, itemId: string) => ({
    objectiveVersion: (await call('context')).strategy.objective.version,
    itemId,
    options: [
      {
        title: '先定位放弃的步骤',
        kind: 'investigate',
        benefit: '减少盲目改动',
        cost: '一次分析',
        uncertainty: '数据能否区分原因',
      },
    ],
    selected: 0,
    rationale: '先减少不确定性',
    nextStep: '检查现有路径反馈',
    expectedOutcome: '能区分技术问题与需求问题',
    evaluation: '检查事件覆盖',
    stopWhen: '证据足以区分原因',
    understandingRefs: [],
    evidenceIds: [],
    watchIds: [],
    reviewAt: future(),
    maxRuns: 1,
    expectations: [
      {
        id: 'finding',
        kind: 'outcome',
        claim: '能区分受阻原因',
        scope: '隔离项目的首次使用数据',
        source: { kind: 'file', path: 'result.json' },
        verification: '检查数据能否区分竞争解释',
        disconfirm: '仍无法区分原因',
        deadline: future(),
      },
    ],
  });
  const item = (id: string) => s.store.get<WorkItem>('items', id)!;
  const audits = (itemId: string, action: string) =>
    s.store.all<Event>('events').filter((row) => row.itemId === itemId && row.action === action);
  return { ...s, native, other, a, b, feature, chooseInput, item, audits };
}

test('the first channel that advances an item owns it, and the other channel is refused every write', async () => {
  const s = await setup();
  try {
    const created = await s.a.call('feature.upsert', s.feature());
    assert.equal(created.ownerChannelId, s.channel.id);
    assert.equal(s.item(created.id).ownerChannelId, s.channel.id);
    const claimed = s.audits(created.id, 'item.claimed');
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].actor, 'system');
    assert.equal(claimed[0].channelId, s.channel.id);
    // Writing again keeps the same owner and records no second claim.
    await s.a.call('feature.upsert', s.feature({ id: created.id, revision: created.revision, nextStep: '继续复现' }));
    assert.equal(s.audits(created.id, 'item.claimed').length, 1);
    // Contributing an observation is not advancing the item, so it stays open to the other channel.
    const note = await s.b.call('evidence.record', {
      itemId: created.id,
      summary: '另一条频道的观察',
      source: '隔离夹具',
      observedAt: now(),
      data: { value: 2 },
    });
    const refusal = `事项 #${created.number} 由频道「自主推进」负责；只能推进分派给本频道或无人负责的事项`;
    const revision = s.item(created.id).revision;
    assert.equal(
      (await s.b.call('feature.upsert', s.feature({ id: created.id, revision, nextStep: '换个方向' }), 409)).error,
      refusal
    );
    assert.equal((await s.b.call('decision.choose', await s.chooseInput(s.b.call, created.id), 409)).error, refusal);
    assert.equal(
      (await s.b.call('verification.request', { itemId: created.id, evidenceIds: [note.id] }, 409)).error,
      refusal
    );
    // Nothing of the refused writes was stored, and reads stay open to every channel.
    assert.equal(s.item(created.id).revision, revision);
    assert.equal(s.item(created.id).nextStep, '继续复现');
    assert.equal(s.store.all('strategy_decisions').length, 0);
    const context = await s.b.call('context');
    assert.equal(context.features.find((row: WorkItem) => row.id === created.id).ownerChannelId, s.channel.id);
    assert.equal(context.channelNames[s.channel.id], '自主推进');
    assert.equal(context.channelNames[s.other.id], '运营洞察');
  } finally {
    await s.cleanup();
  }
});

test('a resolved item is released, a blocked one keeps its owner, and the other channel may then take it', async () => {
  const s = await setup();
  try {
    const created = await s.a.call('feature.upsert', s.feature());
    // A blocked item stays this channel's responsibility: it stopped on it and owes the next step.
    const blocked = await s.a.call(
      'feature.upsert',
      s.feature({ id: created.id, revision: created.revision, status: 'blocked', nextStep: '等待用户答复' })
    );
    assert.equal(blocked.ownerChannelId, s.channel.id);
    await s.a.call(
      'feature.upsert',
      s.feature({ id: created.id, revision: blocked.revision, status: 'investigating' })
    );
    // A real passing review of the current source version, so completion is not deferred.
    const evidence = await s.a.call('evidence.capture', {
      itemId: created.id,
      summary: '当前材料',
      path: 'result.json',
    });
    const job = await s.a.call('verification.request', { itemId: created.id, evidenceIds: [evidence.id] });
    await s.engine.loop.verification.start(job.id);
    s.native.complete();
    assert.equal(s.store.get<any>('loop_verifications', job.id).status, 'passed');
    const resolved = await s.a.call(
      'feature.upsert',
      s.feature({
        id: created.id,
        revision: s.item(created.id).revision,
        status: 'resolved',
        evidenceIds: [evidence.id],
      })
    );
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.ownerChannelId, null);
    assert.equal(s.item(created.id).ownerChannelId, undefined);
    const released = s.audits(created.id, 'item.released');
    assert.equal(released.length, 1);
    assert.equal(released[0].actor, 'system');
    assert.deepEqual(released[0].changes, {
      before: { ownerChannelId: s.channel.id },
      after: { ownerChannelId: null },
    });
    // Released work is open again: the other channel can pick it up and becomes responsible.
    const taken = await s.b.call(
      'feature.upsert',
      s.feature({ id: created.id, revision: s.item(created.id).revision, status: 'investigating' })
    );
    assert.equal(taken.ownerChannelId, s.other.id);
    // An update that takes an unowned item records the responsibility it replaced as well, so the
    // item's history reads the change and not just the result.
    assert.deepEqual(s.audits(created.id, 'item.claimed').at(-1)!.changes, {
      before: { ownerChannelId: null },
      after: { ownerChannelId: s.other.id },
    });
  } finally {
    await s.cleanup();
  }
});

test('a human assigns and releases responsibility and overrides the channel currently holding it', async () => {
  const s = await setup();
  try {
    const created = await s.a.call('feature.upsert', s.feature());
    const assigned = await s.api('PATCH', `/api/items/${created.id}`, { ownerChannelId: s.other.id });
    assert.equal(assigned.ownerChannelId, s.other.id);
    const audit = s.audits(created.id, 'item.assigned');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor, 'human');
    assert.equal(audit[0].text, `事项 #${created.number}「${created.title}」分派给频道「运营洞察」。`);
    assert.deepEqual(audit[0].changes, {
      before: { ownerChannelId: s.channel.id },
      after: { ownerChannelId: s.other.id },
    });
    // The channel that had claimed it is now the one refused; the assignee may work.
    assert.equal(
      (
        await s.a.call(
          'feature.upsert',
          s.feature({ id: created.id, revision: assigned.revision, nextStep: '继续' }),
          409
        )
      ).error,
      `事项 #${created.number} 由频道「运营洞察」负责；只能推进分派给本频道或无人负责的事项`
    );
    await s.b.call('feature.upsert', s.feature({ id: created.id, revision: assigned.revision, nextStep: '我来推进' }));
    const releasedRow = await s.api('PATCH', `/api/items/${created.id}`, { ownerChannelId: null });
    assert.equal(releasedRow.ownerChannelId, undefined);
    assert.equal(s.audits(created.id, 'item.assigned').at(-1)!.text.includes('已改为无人负责'), true);
    // An unowned item is open to either channel again.
    const retaken = await s.a.call(
      'feature.upsert',
      s.feature({ id: created.id, revision: releasedRow.revision, nextStep: '重新接手' })
    );
    assert.equal(retaken.ownerChannelId, s.channel.id);
    // Any channel of the same project may be made responsible; anything else is refused.
    const third = await s.api(
      'POST',
      '/api/channels',
      { projectId: s.project.id, name: '第三方向', goal: '另一条方向', runtime: 'codex' },
      201
    );
    assert.equal(
      (await s.api('PATCH', `/api/items/${created.id}`, { ownerChannelId: third.id })).ownerChannelId,
      third.id
    );
    assert.equal(
      (await s.api('PATCH', `/api/items/${created.id}`, { ownerChannelId: 'not-a-channel-of-this-project' }, 404))
        .error,
      '负责频道不属于该项目'
    );
  } finally {
    await s.cleanup();
  }
});

test('the board digest names the responsible channel and lists this channel first', async () => {
  const s = await setup();
  try {
    const names = { own: '自主推进', other: '运营洞察' };
    const items = [
      {
        number: 1,
        kind: 'issue',
        status: 'open',
        title: '外部反馈调查',
        nextStep: '不该展开',
        origin: 'human',
        ownerChannelId: 'other',
      },
      { number: 2, kind: 'feature', status: 'open', title: '空白待接手', nextStep: '人写下的下一步', origin: 'human' },
      {
        number: 3,
        kind: 'feature',
        status: 'open',
        title: '注册流程修复',
        nextStep: '自己的下一步',
        origin: 'human',
        ownerChannelId: 'own',
      },
    ];
    const digest = boardDigest(items, { channelId: 'own', channelNames: names });
    const lines = digest.trim().split('\n').slice(1);
    assert.equal(lines[0], '#3 feature open 注册流程修复｜本频道｜下一步：自己的下一步');
    assert.equal(lines[1], '#2 feature open 空白待接手｜下一步：人写下的下一步');
    assert.equal(lines[2], '#1 issue open 外部反馈调查｜负责：运营洞察');
    // A human item this channel may not act on keeps its line but not its next step.
    assert(!digest.includes('不该展开'));
    // An owner that is no longer a channel of this project still reads as someone else's.
    assert(boardDigest(items, { channelId: 'own' }).includes('#1 issue open 外部反馈调查｜负责：已移除的频道'));
    // Without a current channel nothing is annotated as this channel's own work.
    assert(!boardDigest(items, { channelNames: names }).includes('本频道'));
    assert(boardDigest(items, { channelNames: names }).includes('#3 feature open 注册流程修复｜负责：自主推进'));
    // The same annotation reaches a real turn note through the shared board.
    s.store.put('native_bindings', {
      id: s.channel.id,
      projectId: s.project.id,
      threadId,
      cwd: s.path,
      createdAt: now(),
    });
    const mine = await s.a.call('feature.upsert', s.feature({ title: '本频道推进的事项' }));
    const theirs = await s.b.call('feature.upsert', s.feature({ title: '运营频道推进的事项' }));
    const prompt = s.engine.prompt(
      s.store.get<any>('projects', s.project.id),
      s.store.get<any>('channels', s.channel.id),
      s.a.run
    );
    assert(prompt.includes(`#${mine.number} issue investigating 本频道推进的事项｜本频道`));
    assert(prompt.includes(`#${theirs.number} issue investigating 运营频道推进的事项｜负责：运营洞察`));
    assert(prompt.includes('只推进分派给本频道或无人负责的事项；别的频道负责的事项不要改动，可以在正文提出建议。'));
    assert(prompt.indexOf(`#${mine.number}`) < prompt.indexOf(`#${theirs.number}`));
  } finally {
    await s.cleanup();
  }
});

test('a temporary project that is not a repository records no tree reading and blocks nobody', async () => {
  const s = await setup();
  try {
    writeFileSync(join(s.path, 'untracked.txt'), 'not in any repository');
    assert.deepEqual(s.engine.treeConflict(s.store.get<any>('projects', s.project.id), s.channel.id), undefined);
    const run = { ...s.a.run, status: 'completed' };
    assert.deepEqual(s.engine.recordTreeState(run).treeState, { dirty: false, files: [], unknown: true });
  } finally {
    await s.cleanup();
  }
});
