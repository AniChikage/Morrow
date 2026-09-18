import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startIsolated, type IsolatedService } from './harness/service.ts';
import { FakeReviewer } from './harness/fake-reviewer.ts';
import { until } from './harness/wait.ts';
import type { AgentResult, Channel, Event, Run, WorkItem } from '../service/protocol.ts';

/**
 * 事项归属 at the turn report entry point. The work interface refuses a write on an item another
 * channel is responsible for (`ProjectWorkLoop.requireOwner`); the same rule has to hold for the
 * `morrow-report` a finished turn returns, or a channel could overwrite another channel's item by
 * reporting it. Both entry points — the CLI turn and the native App turn — go through
 * `Engine.finishSuccess`, so each path is covered here. Nothing runs a model: the CLI is the fixture
 * runtime and the native transport is a protocol double.
 */

/** One report entry for `item`, valid on its own so a refusal can only come from ownership. */
const entry = (item: Pick<WorkItem, 'id'>, title: string) => ({
  id: item.id,
  title,
  summary: '本轮的结论',
  status: 'investigating',
  kind: 'feature',
  evidence: ['fixture.txt:1 — 可复查的测试证据'],
  nextStep: '下一步',
});
const report = (summary: string, items: ReturnType<typeof entry>[]): AgentResult =>
  ({ summary, items, nextCheckMinutes: 60, knowledge: [], needsHuman: false }) as AgentResult;
/** The final message of a native turn: the board report plus the work decision every turn returns. */
const nativeFinal = (result: AgentResult) =>
  '本轮结束。\n```morrow-report\n' +
  JSON.stringify(result) +
  '\n```\n```morrow-next\n' +
  JSON.stringify({
    state: 'wait',
    focus: '事项归属',
    reason: '等待下一次复查',
    nextStep: '继续观察',
    waitMinutes: 60,
  }) +
  '\n```';

async function setup(options: { nativeTransport?: FakeReviewer } = {}) {
  const s = await startIsolated({
    ...options,
    scheduler: false,
    project: { name: '报告归属', goal: '报告入口也遵守事项归属' },
  });
  const other: Channel = await s.api(
    'POST',
    '/api/channels',
    { projectId: s.project.id, name: '运营洞察', goal: '另一条方向', runtime: 'codex' },
    201
  );
  /** A board item the human opened; `owner` assigns responsibility through the human route. */
  const board = async (title: string, owner?: string) => {
    const created: WorkItem = await s.api('POST', `/api/projects/${s.project.id}/items`, { title }, 201);
    return owner
      ? ((await s.api('PATCH', `/api/items/${created.id}`, { ownerChannelId: owner })) as WorkItem)
      : created;
  };
  const item = (id: string) => s.store.get<WorkItem>('items', id)!;
  const audits = (itemId: string, action: string) =>
    s.store.all<Event>('events').filter((row) => row.itemId === itemId && row.action === action);
  return { ...s, other, board, item, audits };
}
/**
 * A native task bound to `channelId`, prepared the way `tests/native-errors.test.ts` prepares one:
 * the double creates the thread, carries a sandbox policy the channel accepts, and lists it for the
 * project directory so `bind` accepts it. Returns its thread id.
 */
async function bindNative(s: IsolatedService, transport: FakeReviewer, channelId: string) {
  const thread = await transport.createThread(s.path);
  thread.state.currentPermissions = { sandboxPolicy: { type: 'readOnly' } };
  transport.listThreads = async () =>
    [...transport.snapshots.values()].map((row) => ({
      id: row.threadId,
      title: '原生任务',
      cwd: s.path,
      updatedAt: Date.now(),
    }));
  await s.native.bind(channelId, thread.threadId);
  return thread.threadId;
}
/** Runs one CLI turn on `channelId` with `result` as its report, and returns the finished run row. */
async function cliTurn(
  s: IsolatedService,
  channelId: string,
  result: AgentResult,
  fixture: Record<string, unknown> = {}
) {
  const before = s.store.all<Run>('runs').filter((row) => row.status === 'completed').length;
  writeFileSync(join(s.path, '.fixture.json'), JSON.stringify({ markdown: true, result, ...fixture }));
  await s.api('POST', `/api/channels/${channelId}/action`, { action: 'run' });
  return until(() => {
    const runs = s.store.all<Run>('runs').filter((row) => row.status === 'completed');
    return runs.length > before ? runs.at(-1)! : undefined;
  });
}

test('a CLI report refuses another channel item, applies the rest of the same report and claims what nobody owns', async () => {
  const s = await setup();
  try {
    const theirs = await s.board('A 负责的事项', s.channel.id);
    const unowned = await s.board('无人负责的事项');
    const run = await cliTurn(
      s,
      s.other.id,
      report('混合报告：一条跨归属，一条合法', [
        entry(theirs, 'B 想改 A 负责的事项'),
        entry(unowned, 'B 接手无人负责的事项'),
      ])
    );
    // Nothing of the refused entry was written: not the title, not the revision, not the run stamp.
    assert.equal(s.item(theirs.id).title, 'A 负责的事项');
    assert.equal(s.item(theirs.id).revision, theirs.revision);
    assert.equal(s.item(theirs.id).ownerChannelId, s.channel.id);
    assert.equal(s.item(theirs.id).lastRunId, '');
    assert.equal(s.audits(theirs.id, 'item.updated').filter((row) => row.runId === run.id).length, 0);
    // The other entry of the same report applied, and writing an unowned item claimed it.
    assert.equal(s.item(unowned.id).title, 'B 接手无人负责的事项');
    assert.equal(s.item(unowned.id).revision, unowned.revision + 1);
    assert.equal(s.item(unowned.id).ownerChannelId, s.other.id);
    assert.equal(s.item(unowned.id).lastRunId, run.id);
    const claimed = s.audits(unowned.id, 'item.claimed');
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].actor, 'system');
    // The refusal is audited as a system event, separately from a revision conflict.
    const refusals = s.audits(theirs.id, 'report.item-refused');
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0].actor, 'system');
    assert.equal(refusals[0].channelId, s.other.id);
    assert.equal(refusals[0].runId, run.id);
    assert.equal(refusals[0].text, `事项 #${theirs.number} 由频道「自主推进」负责，报告中的改动未应用。`);
    assert.deepEqual(refusals[0].changes, {
      after: { itemId: theirs.id, reportedTitle: 'B 想改 A 负责的事项', ownerChannelId: s.channel.id },
    });
    assert.equal(s.audits(theirs.id, 'item.conflict').length, 0);
    // A refused entry does not make the report invalid; the run record says how many were refused.
    assert.equal(run.reportStatus, 'valid');
    assert.equal(run.reportError, '1 条改动因归属被拒，未写入看板；见工作日志。');
    assert(
      s.store
        .all<Event>('events')
        .some((row) => row.runId === run.id && row.kind === 'system' && row.text.includes('1 条改动因归属被拒'))
    );
    // The report itself is kept exactly as it was reported, refused entry included.
    assert.equal(
      s.store.get<{ result: AgentResult }>('results', run.id)!.result.items.find((row) => row.id === theirs.id)?.title,
      'B 想改 A 负责的事项'
    );
    assert(s.store.runText(run.id, 'report').includes('B 想改 A 负责的事项'));
    // The same channel reporting the item it now owns writes normally and claims nothing twice.
    const second = await cliTurn(
      s,
      s.other.id,
      report('继续推进自己负责的事项', [entry(unowned, 'B 继续推进自己的事项')])
    );
    assert.equal(second.reportStatus, 'valid');
    assert.equal(second.reportError, '');
    assert.equal(s.item(unowned.id).title, 'B 继续推进自己的事项');
    assert.equal(s.item(unowned.id).revision, unowned.revision + 2);
    assert.equal(s.item(unowned.id).ownerChannelId, s.other.id);
    assert.equal(s.audits(unowned.id, 'item.claimed').length, 1);
    assert.equal(s.audits(unowned.id, 'report.item-refused').length, 0);
  } finally {
    await s.cleanup();
  }
});

test('a CLI report follows the assignment made while the turn ran, not the one it started from', async () => {
  const s = await setup();
  try {
    const item = await s.board('轮次开始时无人负责');
    const before = s.store.all<Run>('runs').filter((row) => row.status === 'completed').length;
    writeFileSync(
      join(s.path, '.fixture.json'),
      JSON.stringify({
        markdown: true,
        delay: 400,
        result: report('轮次进行中被改派', [entry(item, '改派后仍想写入')]),
      })
    );
    await s.api('POST', `/api/channels/${s.other.id}/action`, { action: 'run' });
    // The human reassigns the item to the other channel while this turn is still running.
    const assigned: WorkItem = await s.api('PATCH', `/api/items/${item.id}`, { ownerChannelId: s.channel.id });
    assert.equal(s.store.all<Run>('runs').find((row) => row.channelId === s.other.id)?.status, 'running');
    const run = await until(() => {
      const runs = s.store.all<Run>('runs').filter((row) => row.status === 'completed');
      return runs.length > before ? runs.at(-1)! : undefined;
    });
    assert.equal(s.item(item.id).title, assigned.title);
    assert.equal(s.item(item.id).revision, assigned.revision);
    assert.equal(s.item(item.id).ownerChannelId, s.channel.id);
    assert.equal(s.item(item.id).lastRunId, '');
    assert.equal(s.audits(item.id, 'report.item-refused').length, 1);
    // The reassignment also bumped the revision; ownership is the reason recorded, not a conflict.
    assert.equal(s.audits(item.id, 'item.conflict').length, 0);
    assert.equal(run.reportStatus, 'valid');
    assert(run.reportError.includes('1 条改动因归属被拒'));
  } finally {
    await s.cleanup();
  }
});

test('a native turn report refuses another channel item and applies the rest of the same report', async () => {
  const native = new FakeReviewer();
  const s = await setup({ nativeTransport: native });
  try {
    const theirs = await s.board('A 负责的事项', s.channel.id);
    const unowned = await s.board('无人负责的事项');
    const threadId = await bindNative(s, native, s.other.id);
    await s.engine.action(s.other.id, 'resume');
    const run = s.store.all<Run>('runs').find((row) => row.channelId === s.other.id)!;
    assert.equal(run.executionOwner, 'codex-app');
    native.complete(threadId, {
      items: [
        {
          id: 'final',
          type: 'agentMessage',
          phase: 'final_answer',
          text: nativeFinal(
            report('原生轮次的混合报告', [
              entry(theirs, '原生路径想改 A 负责的事项'),
              entry(unowned, '原生路径接手无人负责的事项'),
            ])
          ),
        },
      ],
    });
    const finished = s.store.get<Run>('runs', run.id)!;
    assert.equal(finished.status, 'completed');
    assert.equal(finished.reportStatus, 'valid');
    assert.equal(finished.reportError, '1 条改动因归属被拒，未写入看板；见工作日志。');
    assert.equal(s.item(theirs.id).title, 'A 负责的事项');
    assert.equal(s.item(theirs.id).revision, theirs.revision);
    assert.equal(s.item(theirs.id).ownerChannelId, s.channel.id);
    assert.equal(s.item(unowned.id).title, '原生路径接手无人负责的事项');
    assert.equal(s.item(unowned.id).ownerChannelId, s.other.id);
    const refusals = s.audits(theirs.id, 'report.item-refused');
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0].actor, 'system');
    assert.deepEqual(refusals[0].changes, {
      after: { itemId: theirs.id, reportedTitle: '原生路径想改 A 负责的事项', ownerChannelId: s.channel.id },
    });
    assert(
      s.store
        .all<Event>('events')
        .some((row) => row.runId === run.id && row.kind === 'system' && row.text.includes('1 条改动因归属被拒'))
    );
    assert(s.store.runText(run.id, 'report').includes('原生路径想改 A 负责的事项'));
  } finally {
    await s.cleanup();
  }
});

test('a native turn report is refused when the item is reassigned before the turn finishes', async () => {
  const native = new FakeReviewer();
  const s = await setup({ nativeTransport: native });
  try {
    const item = await s.board('原生轮次开始时无人负责');
    const threadId = await bindNative(s, native, s.other.id);
    await s.engine.action(s.other.id, 'resume');
    const run = s.store.all<Run>('runs').find((row) => row.channelId === s.other.id)!;
    // The human reassigns the item while the native turn is still running.
    assert.equal(run.status, 'running');
    const assigned: WorkItem = await s.api('PATCH', `/api/items/${item.id}`, { ownerChannelId: s.channel.id });
    native.complete(threadId, {
      items: [
        {
          id: 'final',
          type: 'agentMessage',
          phase: 'final_answer',
          text: nativeFinal(report('原生轮次进行中被改派', [entry(item, '改派后仍想写入')])),
        },
      ],
    });
    assert.equal(s.store.get<Run>('runs', run.id)!.status, 'completed');
    assert.equal(s.store.get<Run>('runs', run.id)!.reportStatus, 'valid');
    assert.equal(s.item(item.id).title, assigned.title);
    assert.equal(s.item(item.id).revision, assigned.revision);
    assert.equal(s.item(item.id).ownerChannelId, s.channel.id);
    assert.equal(s.item(item.id).lastRunId, '');
    assert.equal(s.audits(item.id, 'report.item-refused').length, 1);
    assert.equal(s.audits(item.id, 'item.conflict').length, 0);
  } finally {
    await s.cleanup();
  }
});
