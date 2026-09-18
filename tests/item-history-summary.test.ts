import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startIsolated } from './harness/service.ts';
import { grantFor } from './harness/grant.ts';
import { FakeReviewer } from './harness/fake-reviewer.ts';
// The desktop's own summary and labels, loaded directly: the point of this file is that the two
// layers agree on the shape of `changes`, so nothing here re-implements or mocks either side.
import { statusLabel } from '../desktop/renderer/components/format.ts';
import { itemChangeSummary } from '../desktop/renderer/features/itemChangeSummary.ts';
import type { Channel, WorkspaceEvent } from '../desktop/shared/types.ts';

/**
 * One project, two channels and one item, driven only through the real work interface (`/api/agent`)
 * and the human item route. Every assertion reads the audit row the service actually stored and asks
 * `desktop/renderer/features/itemChangeSummary.ts` to describe it, so a service write that stops
 * carrying `before` — the gap that existed until the previous build — fails here. Nothing calls a
 * model: the native transport is a protocol double.
 */
async function setup() {
  const native = new FakeReviewer();
  // A review that reports its verdict as soon as it is asked, so a deferred completion is applied
  // inside `verification.start` exactly as `tests/project-loop.test.ts` drives it.
  native.autoComplete = true;
  const s = await startIsolated({
    nativeTransport: native,
    scheduler: false,
    project: {
      name: '事项历史',
      goal: '让事项历史读到真实发生的改动',
      files: { 'checks.log': '2 tests passed\n' },
    },
  });
  const other: Channel = await s.api(
    'POST',
    '/api/channels',
    { projectId: s.project.id, name: '运营洞察', goal: '从真实反馈中发现机会', runtime: 'codex' },
    201
  );
  const a = grantFor(s, { projectId: s.project.id, channelId: s.channel.id });
  const b = grantFor(s, { projectId: s.project.id, channelId: other.id });
  const audits = (itemId: string, action: string) =>
    s.store.all<WorkspaceEvent>('events').filter((row) => row.itemId === itemId && row.action === action);
  const latest = (itemId: string, action: string) => {
    const rows = audits(itemId, action);
    assert.equal(rows.length > 0, true, `没有 ${action} 记录`);
    return rows.at(-1)!;
  };
  /** The summary the item history renders, from the stored row and the stored channel list. */
  const summary = (itemId: string, action: string) =>
    itemChangeSummary(latest(itemId, action), s.store.all<Channel>('channels'));
  const revision = (itemId: string) => s.store.get<{ revision: number }>('items', itemId)!.revision;
  const feature = (patch: Record<string, unknown> = {}) => ({
    title: '首次使用受阻',
    summary: '记录当前理解',
    kind: 'issue',
    status: 'investigating',
    evidenceIds: [] as string[],
    nextStep: '先复现用户描述的路径',
    ...patch,
  });
  return { ...s, native, other, a, b, audits, latest, summary, revision, feature };
}

test('the item history summary the desktop renders describes what the work interface actually wrote', async () => {
  const s = await setup();
  try {
    // A creation states only what it stored, so there is nothing to compare against and the row
    // keeps describing itself. This is the shape older Agent records have for every action.
    const item = await s.a.call('feature.upsert', s.feature());
    assert.deepEqual(Object.keys(s.latest(item.id, 'feature.created').changes!), ['after']);
    assert.equal(s.summary(item.id, 'feature.created'), '');
    // Claiming the item is audited separately, and names the channel rather than its id.
    assert.equal(s.channel.name, '自主推进');
    assert.equal(s.summary(item.id, 'item.claimed'), `负责频道 → ${s.channel.name}`);
    // An update that moves the status, the next step and the description at once.
    await s.a.call(
      'feature.upsert',
      s.feature({
        id: item.id,
        revision: s.revision(item.id),
        status: 'blocked',
        summary: '等待用户答复后继续',
        nextStep: '等待用户答复',
      })
    );
    // A broken label table must not let the expectation pass by echoing the raw status.
    assert.notEqual(statusLabel('investigating'), 'investigating');
    assert.notEqual(statusLabel('blocked'), 'blocked');
    assert.equal(
      s.summary(item.id, 'feature.updated'),
      `状态 ${statusLabel('investigating')} → ${statusLabel('blocked')}、下一步已更新、说明已修改`
    );
    // A human releasing responsibility through the item route.
    await s.api('PATCH', `/api/items/${item.id}`, { ownerChannelId: null });
    assert.equal(s.summary(item.id, 'item.assigned'), '负责频道 → 无人负责');
    // The other channel then takes the unowned item; the summary names that channel, picked out of
    // the full channel list rather than assumed.
    await s.b.call('feature.upsert', s.feature({ id: item.id, revision: s.revision(item.id), nextStep: '我来推进' }));
    assert.equal(s.summary(item.id, 'item.claimed'), `负责频道 → ${s.other.name}`);
    // A completion the review has not reached yet keeps the item open, and is applied later by the
    // review that passes; that deferred write is the one the history must be able to describe.
    const material = await s.b.call('evidence.capture', {
      itemId: item.id,
      summary: '隔离测试日志',
      path: 'checks.log',
    });
    const completion = await s.b.call(
      'feature.upsert',
      s.feature({
        id: item.id,
        revision: s.revision(item.id),
        status: 'verified',
        evidenceIds: [material.id],
        nextStep: '等待独立复核',
      })
    );
    assert.equal(completion.pendingVerification, true);
    await s.engine.loop.verification.start(completion.verificationId);
    assert.equal(s.store.get<any>('loop_finalizations', completion.finalizationId).status, 'applied');
    assert.equal(s.store.get<any>('items', item.id).status, 'verified');
    assert.equal(
      s.summary(item.id, 'feature.completed'),
      `状态 ${statusLabel('investigating')} → ${statusLabel('verified')}`
    );
  } finally {
    await s.cleanup();
  }
});
