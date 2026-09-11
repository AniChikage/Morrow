import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  autonomousCharter,
  autonomousCharterReview,
  autonomousTurnNote,
  boardDigest,
  charterResendReason,
  charterTurnLimit,
} from '../service/channel-work.ts';
import { now } from '../service/store.ts';
import { startIsolated, type IsolatedService } from './harness/service.ts';
import { grantFor } from './harness/grant.ts';
import { fixtureBrief, seedBoard, turnNoteLimit } from '../scripts/prompt-size.ts';
import type { Channel, Project, Run } from '../service/protocol.ts';

const threadId = 'charter-thread';
/** The run row a scheduled native turn writes, so the charter bookkeeping sees a real turn. */
const scheduled: Partial<Run> = { sessionId: threadId, source: 'morrow-schedule', executionOwner: 'codex-app' };

async function setup(items = 10) {
  const s = await startIsolated({
    project: { name: '章程与轮次提示', goal: '把持续工作的每轮输入压到必要范围', brief: fixtureBrief },
  });
  s.store.put('native_bindings', {
    id: s.channel.id,
    projectId: s.project.id,
    threadId,
    cwd: s.path,
    createdAt: now(),
  });
  const ids = { projectId: s.project.id, channelId: s.channel.id };
  const project = () => s.store.get<Project>('projects', ids.projectId)!;
  const channel = () => s.store.get<Channel>('channels', ids.channelId)!;
  /** One scheduled turn: mints the run and its grant, then builds the prompt the way the scheduler does. */
  const turn = () => {
    const grant = grantFor(s, { ...ids, overrides: scheduled });
    return { run: grant.run, text: s.engine.prompt(project(), channel(), grant.run) };
  };
  /** The turn is accepted, completes and saves a work decision, so the next turn needs no charter. */
  const complete = (run: Run, focus = '继续当前方向') => {
    s.store.put('runs', { ...run, status: 'completed', nativeTurnId: `${run.id}-turn`, finishedAt: now() });
    s.store.put('channels', {
      ...channel(),
      work: {
        state: 'continue' as const,
        focus,
        reason: '上一轮的证据仍然支持这个方向。',
        nextStep: '继续补齐观测再核对结果。',
        runId: run.id,
        updatedAt: now(),
        awaitingReply: false,
      },
    });
  };
  /** One complete turn: built, accepted by the native task, and closed with a work decision. */
  const step = (focus?: string) => {
    const value = turn();
    complete(value.run, focus);
    return value;
  };
  const board = seedBoard(s, items);
  return { ...s, ids, project, channel, turn, complete, step, board };
}
const charterMark = '你是这个项目中持续工作的 Codex。';
const noteMark = '沿用本任务开头的项目说明（版本 1）、工作方向与规则；操作约定见 contract。';

test('the first turn carries the charter and the next unchanged turn is a short note', async () => {
  const s = await setup();
  try {
    const first = s.turn();
    assert(first.text.includes(charterMark));
    assert(first.text.includes(fixtureBrief));
    assert(first.text.includes(noteMark));
    // Delivery is recorded against the bound thread, at the charter's own digest.
    const record = s.channel().promptCharter!;
    assert.equal(record.threadId, threadId);
    assert.equal(record.turnsSince, 1);
    assert.equal(record.hash.length, 64);
    s.complete(first.run, s.board[1].title);
    const second = s.turn();
    assert(!second.text.includes(charterMark));
    assert(!second.text.includes(fixtureBrief));
    assert(second.text.includes(noteMark));
    // Everything a turn still needs: the reminder, the last arrangement, usage and the board digest.
    assert(second.text.includes(`关注点：${s.board[1].title}`));
    assert(!second.text.includes(`"runId":"${first.run.id}"`));
    assert(second.text.includes('看板（未解决'));
    assert(second.text.includes('结束附 morrow-next'));
    // This run's own grant path: the previous run's credential is already scoped out.
    assert(second.text.includes(`runs/${second.run.id}/tool.sh`));
    assert(!second.text.includes(`runs/${first.run.id}/tool.sh`));
    assert(second.text.length < turnNoteLimit, `turn note is ${second.text.length} chars`);
    assert.equal(s.channel().promptCharter!.turnsSince, 2);
    assert.equal(s.channel().promptCharter!.hash, record.hash);
  } finally {
    await s.cleanup();
  }
});

test('new requirements or threads resend the full charter; a stale delivered charter gets a review', async () => {
  const s = await setup();
  try {
    s.step();
    // A saved brief version is a changed requirement, so the charter goes out again with it.
    await s.api('PATCH', `/api/projects/${s.ids.projectId}`, {
      brief: fixtureBrief + '\n\n新增约束：不得改动计费。',
      revision: 1,
    });
    const afterBrief = s.step();
    assert(afterBrief.text.includes(charterMark));
    assert(afterBrief.text.includes('新增约束：不得改动计费。'));
    assert(afterBrief.text.includes('沿用本任务开头的项目说明（版本 2）'));
    assert(!s.step().text.includes(charterMark));
    // A different direction changes the charter text as well.
    await s.api('PATCH', `/api/channels/${s.ids.channelId}`, { goal: '改为先补齐线上观测能力' });
    const afterGoal = s.step();
    assert(afterGoal.text.includes(charterMark));
    assert(afterGoal.text.includes('当前工作方向：改为先补齐线上观测能力'));
    assert(!s.step().text.includes(charterMark));
    // Rebinding to another native task means the new task never saw the charter.
    s.store.put('native_bindings', { ...s.store.get<any>('native_bindings', s.ids.channelId), threadId: 'other' });
    const rebound = s.step();
    assert(rebound.text.includes(charterMark));
    assert.equal(s.channel().promptCharter!.threadId, 'other');
    assert.equal(s.channel().promptCharter!.turnsSince, 1);
    // Eight more turns reuse it, and the tenth turn reviews the delivered charter.
    for (let index = 2; index < charterTurnLimit; index++) {
      assert(!s.step().text.includes(charterMark), `turn ${index} under one charter should be a note`);
      assert.equal(s.channel().promptCharter!.turnsSince, index);
    }
    const tenth = s.turn();
    assert(!tenth.text.includes(charterMark));
    assert(tenth.text.includes('章程回顾'));
    assert(!tenth.text.includes(fixtureBrief));
    assert.equal(tenth.text.split('项目目标：').length, 2);
    assert.equal(s.channel().promptCharter!.turnsSince, 1);
    assert.equal(
      charterResendReason({
        record: { threadId, hash: 'h', sentAt: now(), turnsSince: 9 },
        threadId,
        hash: 'h',
        previousRun: { id: 'unaccepted', status: 'failed', executionOwner: 'codex-app' },
      }),
      'previous-turn-not-started'
    );
  } finally {
    await s.cleanup();
  }
});

test('a turn that never started, failed or saved no decision cannot be assumed to have delivered the charter', async () => {
  const s = await setup();
  try {
    const first = s.turn();
    assert(first.text.includes(charterMark));
    // Completed, but the reply carried no `morrow-next` block: the next turn restates the rules.
    s.store.put('runs', { ...first.run, status: 'completed', nativeTurnId: 'accepted', finishedAt: now() });
    const noDecision = s.turn();
    assert(noDecision.text.includes('章程回顾'));
    assert(!noDecision.text.includes(fixtureBrief));
    // A turn the native task never accepted clears the record when the run is failed.
    s.engine.finishFailure({ ...noDecision.run, ...scheduled }, 'failed', '原生 App 拒绝了本轮请求');
    assert.equal(s.channel().promptCharter, undefined);
    const afterReject = s.turn();
    assert(afterReject.text.includes(charterMark));
    // An accepted unfinished run requests a reminder of its already delivered charter.
    assert.equal(
      charterResendReason({
        record: { threadId, hash: 'h', sentAt: now(), turnsSince: 1 },
        threadId,
        hash: 'h',
        previousRun: { id: 'r1', status: 'running', nativeTurnId: 't1', executionOwner: 'codex-app' },
        work: { runId: 'r1' },
      }),
      'previous-turn-unfinished'
    );
    assert.equal(
      charterResendReason({
        record: { threadId, hash: 'h', sentAt: now(), turnsSince: 1 },
        threadId,
        hash: 'h',
        previousRun: { id: 'r1', status: 'completed', executionOwner: 'codex-app' },
        work: { runId: 'r1' },
      }),
      'previous-turn-not-started'
    );
    assert.equal(
      charterResendReason({
        record: { threadId, hash: 'h', sentAt: now(), turnsSince: 1 },
        threadId,
        hash: 'h',
        previousRun: { id: 'r1', status: 'completed', nativeTurnId: 't1', executionOwner: 'codex-app' },
        work: { runId: 'r1' },
      }),
      ''
    );
  } finally {
    await s.cleanup();
  }
});

test('the board digest lists open items compactly and only expands the ones a turn must react to', async () => {
  const s = await setup(0);
  try {
    const runId = 'previous-run';
    const items = [
      {
        number: 1,
        kind: 'feature',
        status: 'open',
        title: '人建立的事项',
        nextStep: '人写下的下一步',
        origin: 'human',
      },
      {
        number: 2,
        kind: 'issue',
        status: 'investigating',
        title: '上一轮改动过',
        nextStep: '上一轮留下的下一步',
        lastRunId: runId,
        origin: 'agent',
      },
      {
        number: 3,
        kind: 'hypothesis',
        status: 'open',
        title: '别的事项',
        nextStep: '不该展开的下一步',
        origin: 'agent',
      },
      { number: 4, kind: 'feature', status: 'resolved', title: '已解决一', nextStep: '不再列出', origin: 'human' },
      { number: 5, kind: 'feature', status: 'resolved', title: '已解决二', nextStep: '不再列出', origin: 'agent' },
    ];
    const digest = boardDigest(items, { lastRunId: runId });
    assert(digest.startsWith('看板（未解决 3 项，共 5 项）：\n'));
    assert(digest.includes('#1 feature open 人建立的事项｜下一步：人写下的下一步'));
    assert(digest.includes('#2 issue investigating 上一轮改动过｜下一步：上一轮留下的下一步'));
    assert(digest.includes('#3 hypothesis open 别的事项\n'));
    assert(!digest.includes('不该展开的下一步'));
    // Resolved items are counted, never listed.
    assert(!digest.includes('已解决一'));
    assert(!digest.includes('已解决二'));
    assert(digest.includes('另有 2 项已解决，未列出。'));
    // Without a previous run only the human items expand.
    assert(!boardDigest(items, {}).includes('上一轮留下的下一步'));
    assert.equal(boardDigest([], {}), '看板：暂无事项。\n');
    assert.equal(boardDigest([items[3]], {}), '看板：全部 1 项已解决。\n');
    // Over the cap the digest keeps what a turn must react to and counts the rest by number.
    const many = Array.from({ length: 200 }, (_, index) => ({
      number: index + 6,
      kind: 'feature',
      status: 'open',
      title: `批量事项 ${index + 1}`,
      nextStep: '不该展开的下一步',
      origin: 'agent',
    }));
    const capped = boardDigest([...items, ...many], { lastRunId: runId, limit: 1200 });
    assert(capped.length <= 1200, `capped digest is ${capped.length} chars`);
    assert(capped.includes('人写下的下一步'));
    assert(capped.includes('上一轮留下的下一步'));
    assert(capped.includes('项未展开：'));
    assert(!capped.includes('不该展开的下一步'));
    // A digest that is still too long is truncated and says where the full board is.
    assert(boardDigest([...items, ...many], { limit: 200 }).includes('完整看板用 context 读取'));
  } finally {
    await s.cleanup();
  }
});

test('the board digest in a real turn carries human and last-touched next steps and no board JSON', async () => {
  const s = await setup(0);
  try {
    const human = await s.api(
      'POST',
      `/api/projects/${s.project().id}/items`,
      { title: '用户提出的问题', summary: '用户在界面里写下的事项', kind: 'issue', nextStep: '先复现用户描述的路径' },
      201
    );
    assert.equal(s.store.get<any>('items', human.id).origin, 'human');
    const first = s.turn();
    s.complete(first.run);
    const grant = grantFor(s, { ...s.ids, overrides: scheduled });
    const touched = await grant.call('feature.upsert', {
      title: 'agent 建立的事项',
      summary: '本轮实际推进的事项',
      kind: 'feature',
      status: 'investigating',
      evidenceIds: [],
      nextStep: '按上一轮计划补齐观测',
    });
    // That write belongs to the previous turn, so the next turn sees it as last touched.
    s.store.put('items', { ...s.store.get<any>('items', touched.id), lastRunId: first.run.id });
    const second = s.engine.prompt(s.project(), s.channel(), grant.run);
    assert(second.includes(`#${human.number} issue open 用户提出的问题｜下一步：先复现用户描述的路径`));
    assert(second.includes(`#${touched.number} feature investigating agent 建立的事项｜下一步：按上一轮计划补齐观测`));
    // The compact digest replaces the full board JSON; the summaries are read through `context`.
    assert(!second.includes('用户在界面里写下的事项'));
    assert(!second.includes('"sourceChannelIds"'));
    assert.equal(s.store.get<any>('items', touched.id).origin, 'agent');
  } finally {
    await s.cleanup();
  }
});

test('a turn holding the Morrow work grant is not also given the fallback board-report schema', async () => {
  const s = await setup(3);
  try {
    const withTools = s.turn();
    assert(withTools.text.includes('--operation context'));
    assert(withTools.text.includes('--operation contract'));
    assert(!withTools.text.includes('morrow-report'));
    assert(!withTools.text.includes('nextCheckMinutes'));
    // Every turn still has to save continuity through `morrow-next`.
    assert(withTools.text.includes('morrow-next'));
    s.complete(withTools.run);
    assert(s.turn().text.includes('morrow-next'));
    // Without a grant the optional report is the only path to the board, so it is described again.
    const baseURL = s.engine.loop.baseURL;
    s.engine.loop.baseURL = '';
    try {
      const withoutTools = s.engine.prompt(s.project(), s.channel(), { ...withTools.run, id: randomUUID() });
      assert(withoutTools.includes('morrow-report'));
      assert(withoutTools.includes('nextCheckMinutes'));
      assert(!withoutTools.includes('--operation context'));
    } finally {
      s.engine.loop.baseURL = baseURL;
    }
  } finally {
    await s.cleanup();
  }
});

test('the prompt sizes the change is measured by: charter once, then turn notes under the limit', async () => {
  const s = await setup();
  try {
    const first = s.turn();
    s.complete(first.run);
    const second = s.turn();
    assert(first.text.length > second.text.length * 2, `${first.text.length} vs ${second.text.length}`);
    assert(second.text.length < turnNoteLimit, `turn note is ${second.text.length} chars`);
    // The full board JSON alone used to be larger than the whole turn note now is.
    assert(JSON.stringify(s.board).length > 14000);
    assert(second.text.length < JSON.stringify(s.board).length / 5);
  } finally {
    await s.cleanup();
  }
});

test('the charter record survives the channel row the native scheduler writes from its own copy', async () => {
  const s = await setup(1);
  try {
    // `startScheduled` reads the channel, builds the prompt and then writes that same object back.
    const stale = s.channel();
    const grant = grantFor(s, { ...s.ids, overrides: scheduled });
    s.engine.prompt(s.project(), stale, grant.run);
    s.store.put('channels', { ...stale, status: 'running', lastRunAt: now(), nextRunAt: '' });
    assert.equal(s.channel().promptCharter!.threadId, threadId);
    assert.equal(s.channel().promptCharter!.turnsSince, 1);
  } finally {
    await s.cleanup();
  }
});

test('older item rows learn who opened them from their own audit events, once', async () => {
  const s = await setup(0);
  try {
    const human = await s.api(
      'POST',
      `/api/projects/${s.project().id}/items`,
      { title: '人建立的旧事项', summary: '迁移前写下的事项', kind: 'issue', nextStep: '复查' },
      201
    );
    const agent: any = { ...s.store.get<any>('items', human.id), id: randomUUID(), number: 99, title: '旧的自动事项' };
    s.store.put('items', agent);
    // Rows written before the field existed, and the marker that made the migration a one-shot.
    for (const id of [human.id, agent.id]) {
      const { origin, ...row } = s.store.get<any>('items', id);
      s.store.put('items', row);
      assert.equal(s.store.get<any>('items', id).origin, undefined);
    }
    s.store.db.prepare('DELETE FROM migrations WHERE id=?').run('item-origin-v1');
    const restarted: IsolatedService = await s.restart();
    assert.equal(restarted.store.get<any>('items', human.id).origin, 'human');
    assert.equal(restarted.store.get<any>('items', agent.id).origin, 'agent');
    // A human row is not rewritten on the next start.
    restarted.store.put('items', { ...restarted.store.get<any>('items', human.id), origin: 'human' });
    await restarted.restart();
    assert.equal(restarted.store.get<any>('items', human.id).origin, 'human');
  } finally {
    await s.cleanup();
  }
});

test('long notes and human boards are bounded without changing stored input or exposing bookkeeping', () => {
  const items = Array.from({ length: 60 }, (_, i) => ({
    number: i + 1,
    origin: 'human',
    kind: 'issue',
    status: 'open',
    title: '长标题'.repeat(80),
    nextStep: '步骤'.repeat(400),
  }));
  const previous = { focus: '关注'.repeat(500), nextStep: '动作'.repeat(1000), runId: 'private-bookkeeping' };
  const before = JSON.stringify({ items, previous });
  const context = {
    project: { brief: fixtureBrief, briefRevision: 7, goal: '真实目标' },
    channel: { name: '自主', goal: '真实方向', permission: 'read-only' },
    items,
    previous,
  };
  assert(boardDigest(items).length <= 1200);
  assert(!autonomousTurnNote(context).includes('private-bookkeeping'));
  assert(!autonomousTurnNote(context).includes('真实方向'));
  assert.equal(JSON.stringify({ items, previous }), before);
  const full = autonomousCharter(context);
  assert(full.includes(fixtureBrief));
  assert(full.includes('只读范围'));
  assert(full.replace(fixtureBrief, '').length < 1000);
  const review = autonomousCharterReview(context);
  assert(review.includes('真实目标'));
  assert(review.includes('真实方向'));
  assert(review.includes('版本 7'));
  for (const rule of ['release.propose', '证据必须可回看', 'needs_input', '完整章程见本任务开头'])
    assert(review.includes(rule));
  assert(!review.includes(fixtureBrief));
});

test('an accepted unfinished turn gets a review and the next completed turn returns to a note', async () => {
  const s = await setup();
  try {
    const first = s.step();
    s.store.put('runs', { ...first.run, nativeTurnId: 'accepted', status: 'failed' });
    const reminder = s.step();
    assert(reminder.text.includes('章程回顾'));
    assert(!reminder.text.includes(fixtureBrief));
    assert(!s.step().text.includes('章程回顾'));
  } finally {
    await s.cleanup();
  }
});

test('the complete note and review stay bounded with long arrangements, large boards and both usage limits', () => {
  const tools = '工具入口'.repeat(62);
  const context = {
    project: { briefRevision: 7, goal: '目标'.repeat(1000) },
    channel: { name: '自主', goal: '方向'.repeat(1000), permission: 'native' },
    items: Array.from({ length: 300 }, (_, i) => ({
      number: i + 1,
      origin: 'human',
      title: '事项'.repeat(200),
      nextStep: '行动'.repeat(500),
      kind: 'opportunity',
      status: 'investigating',
    })),
    previous: { focus: '关注'.repeat(1000), nextStep: '下一步'.repeat(1000) },
    tools,
    budget: {
      runsToday: 0,
      maxRunsPerDay: 32,
      usage: {
        unknown: true,
        reserve: { window: 'weekly' as const, keepPercent: 50 },
        project: { window: 'weekly' as const, usedPercent: 33, limitPercent: 50 },
      },
    },
  };
  const note = autonomousTurnNote(context) + tools;
  assert(note.length <= 1500, String(note.length));
  assert((autonomousCharterReview(context) + note).length <= 2500);
  assert(note.includes('当前额度'));
  assert(note.includes('完整看板用 context 读取'));
  assert(note.includes('morrow-next'));
});

test('measurement brief has the stated length and a tiny board budget preserves its read path', () => {
  assert.equal(fixtureBrief.length, 4400);
  const items = Array.from({ length: 300 }, (_, number) => ({
    number,
    kind: 'issue',
    status: 'open',
    title: '长标题',
  }));
  const digest = boardDigest(items, { limit: 50 });
  assert(digest.length <= 50);
  assert(digest.includes('context'));
});
