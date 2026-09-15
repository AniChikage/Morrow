import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { connectionDetail, NativeConversations } from '../service/native-conversations.ts';
import { applyDesktopPatches } from '../service/codex-desktop-transport.ts';
import { importNativeImages, readNativeImage } from '../service/native-media.ts';
import { extractReport } from '../service/reports.ts';
import type { NativeTransport, NativeSnapshot, NativeWorkOptions } from '../service/native-conversations.ts';
import { setLogSink } from '../service/log.ts';
import { startIsolated, stopScheduler, type IsolatedService } from './harness/service.ts';
/** A real context window the App reports today; a share of it is one context reading. */
const contextWindow = 828400;
const contextUsed = (share: number) => Math.round(contextWindow * share);
const context = (share: number) => ({
  latestTokenUsageInfo: {
    total: { totalTokens: contextUsed(share) },
    last: {
      totalTokens: contextUsed(share),
      inputTokens: 1,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 1,
      reasoningOutputTokens: 0,
    },
    modelContextWindow: contextWindow,
  },
});
/** One finished compaction as the App records it inside a turn of its own. */
const compactionTurn = (source = 'manual') => ({
  turnId: randomUUID(),
  status: 'completed',
  items: [{ id: randomUUID(), type: 'contextCompaction', completed: true, source }],
});
class FakeNative implements NativeTransport {
  connected = true;
  cwd = '';
  threadId = randomUUID();
  sent: Array<{ text: string; id?: string; images?: Array<{ path: string }>; workOptions?: NativeWorkOptions }> = [];
  interruptions: string[] = [];
  compactions: string[] = [];
  /** `reject` refuses the compaction request; `hang` accepts it and never finishes it. */
  compactFailure: 'reject' | 'hang' | undefined;
  answers: any[] = [];
  failure = false;
  definitiveFailure = false;
  readFailure = false;
  listeners = new Set<(snapshot: NativeSnapshot) => void>();
  snapshot: NativeSnapshot = {
    threadId: this.threadId,
    ownerClientId: 'actual-app-owner',
    revision: 1,
    syncedAt: new Date().toISOString(),
    state: { turns: [], requests: [], currentPermissions: { sandboxPolicy: { type: 'readOnly' } } },
  };
  async connect() {
    if (!this.connected) throw new Error('App disconnected');
  }
  status() {
    return {
      connected: this.connected,
      socketPath: '/isolated-fixture.sock',
      lastError: this.connected ? null : 'App disconnected',
    };
  }
  async listThreads(cwd: string) {
    return realpathSync(cwd) === realpathSync(this.cwd)
      ? [{ id: this.threadId, title: '原生任务', cwd, updatedAt: Date.now() }]
      : [];
  }
  async readThread(id: string) {
    if (id !== this.threadId) throw new Error('not found');
    if (!this.connected || this.readFailure) throw new Error('App disconnected');
    return structuredClone(this.snapshot);
  }
  async subscribe(id: string, listener: (snapshot: NativeSnapshot) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(state: any) {
    this.snapshot = {
      ...this.snapshot,
      revision: this.snapshot.revision + 1,
      syncedAt: new Date().toISOString(),
      state: { ...this.snapshot.state, ...state, cwd: this.cwd },
    };
    for (const listener of this.listeners) listener(structuredClone(this.snapshot));
  }
  async sendMessage(
    id: string,
    text: string,
    clientMessageId?: string,
    images?: Array<{ path: string }>,
    workOptions?: NativeWorkOptions
  ) {
    this.sent.push({ text, id: clientMessageId, images, workOptions });
    if (this.definitiveFailure) throw Object.assign(new Error('native rejection'), { outcomeUnknown: false });
    if (this.failure) throw new Error('acknowledgement lost');
    const turnId = randomUUID();
    this.emit({
      turns: [
        ...this.snapshot.state.turns,
        {
          turnId,
          status: 'inProgress',
          params: { clientUserMessageId: clientMessageId },
          items: [
            {
              id: randomUUID(),
              type: 'userMessage',
              clientId: clientMessageId,
              content: [
                { type: 'text', text },
                ...(images || []).map((image) => ({ type: 'localImage', path: image.path })),
              ],
            },
          ],
        },
      ],
    });
    return { turn: { id: turnId } };
  }
  async interrupt(id: string, turnId: string) {
    this.interruptions.push(turnId);
    return { ok: true };
  }
  /**
   * The App's own compaction: it runs `thread/compact/start` itself, so the result arrives as an
   * idle task with a completed `contextCompaction` item and a smaller context reading.
   */
  async compact(id: string) {
    this.compactions.push(id);
    if (this.compactFailure === 'reject') throw new Error(`connect ECONNREFUSED ${join(this.cwd, 'ipc/ipc.sock')}`);
    if (this.compactFailure === 'hang') {
      this.emit({ threadRuntimeStatus: { type: 'active' } });
      return { ok: true };
    }
    const info = this.snapshot.state.latestTokenUsageInfo;
    this.emit({
      threadRuntimeStatus: { type: 'idle' },
      latestTokenUsageInfo: {
        ...info,
        last: { ...info?.last, totalTokens: Math.round((info?.modelContextWindow ?? 0) * 0.1) },
      },
      turns: [...this.snapshot.state.turns, compactionTurn()],
    });
    return { ok: true };
  }
  async respond(id: string, requestId: string | number, kind: any, response: unknown) {
    this.answers.push({ id, requestId, kind, response });
    return { ok: true };
  }
  close() {
    this.connected = false;
    this.listeners.clear();
  }
}
async function setup() {
  const transport = new FakeNative();
  const s = await startIsolated({
    nativeTransport: ({ path }) => Object.assign(transport, { cwd: path }),
    project: { name: 'Native', goal: 'Continue native work' },
  });
  return { ...s, transport };
}
test('shared background creates one native task per channel and records creation before sending', async () => {
  const s = await setup();
  try {
    let created = 0;
    Object.assign(s.transport, {
      backgroundReady: true,
      createThread: async (cwd: string) => {
        created++;
        assert.equal(cwd, s.project.path);
        s.transport.emit({ turns: [] });
        return s.transport.readThread(s.transport.threadId);
      },
    });
    const status = await s.api('GET', '/api/native/status');
    assert.equal(status.backgroundReady, true);
    assert.equal(status.capabilities.create, true);
    const [first, second] = await Promise.all([s.native.create(s.channel.id), s.native.create(s.channel.id)]);
    assert.equal(created, 1);
    assert.equal(first.threadId, second.threadId);
    assert.equal(first.threadId, s.transport.threadId);
    assert.equal(s.transport.sent.length, 0);
    const binding = s.store.get<any>('native_bindings', s.channel.id);
    assert.equal(binding.createdByMorrow, true);
    assert.equal(binding.projectId, s.project.id);
    const actions = s.store.all<any>('events').map((event) => event.action);
    assert(actions.includes('native.creation-requested'));
    assert(actions.includes('native.created'));
    const receipt = await s.api('POST', `/api/channels/${s.channel.id}/native/messages`, {
      text: 'Native first input',
      requestId: randomUUID(),
    });
    assert.equal(receipt.state, 'accepted');
    assert.equal(s.transport.sent.length, 1);
    assert.equal(s.transport.sent[0].workOptions, undefined);
  } finally {
    await s.cleanup();
  }
});
test('a native channel inherits App permissions where a narrower saved scope is refused, and scoped work tools attach to the same task', async () => {
  const s = await setup();
  try {
    await s.native.bind(s.channel.id, s.transport.threadId);
    s.transport.emit({ currentPermissions: { sandboxPolicy: { type: 'dangerFullAccess' } } });
    // New channels inherit App permissions; a narrowed channel cannot silently inherit full access.
    assert.equal(s.channel.permission, 'native');
    await s.api('PATCH', `/api/channels/${s.channel.id}`, { permission: 'workspace-write' });
    await s.api('POST', `/api/channels/${s.channel.id}/action`, { action: 'resume' }, 409);
    await s.api('PATCH', `/api/channels/${s.channel.id}`, { permission: 'native' });
    await s.engine.action(s.channel.id, 'resume');
    assert.equal(s.transport.sent.length, 1);
    assert.deepEqual(s.transport.sent[0].workOptions, {});
    assert.match(s.transport.sent[0].text, /--operation context/);
    const run = s.store.all<any>('runs').find((r) => r.source === 'morrow-schedule');
    assert.equal(run.sessionId, s.transport.threadId);
    const context = JSON.parse(readFileSync(join(s.home, 'runs', run.id, 'agent-context.json'), 'utf8'));
    const response = await fetch(context.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${context.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'context', input: {} }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).project.id, s.project.id);
    completeWork(s, nextWork('wait', 60));
    assert.equal(s.store.get<any>('runs', run.id).status, 'completed');
    const expired = await fetch(context.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${context.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'context', input: {} }),
    });
    assert.equal(expired.status, 409);
  } finally {
    await s.cleanup();
  }
});
for (const legacy of [false, true])
  test(`an explicitly recreated ${legacy ? 'legacy' : 'current'} empty task retains its audit; uncertain sends never permit replacement`, async () => {
    const s = await setup();
    try {
      let created = 0;
      const originalRead = s.transport.readThread.bind(s.transport);
      let missing = '';
      Object.assign(s.transport, {
        backgroundReady: true,
        readThread: async (id: string) => {
          if (id === missing) throw new Error('no rollout found for thread id ' + id);
          return originalRead(id);
        },
        createThread: async () => {
          created++;
          s.transport.threadId = randomUUID();
          s.transport.snapshot = {
            ...s.transport.snapshot,
            threadId: s.transport.threadId,
            state: { turns: [], requests: [], cwd: s.project.path },
          };
          return originalRead(s.transport.threadId);
        },
      });
      const first = await s.native.create(s.channel.id);
      missing = first.threadId;
      if (legacy) {
        const { createdByMorrow, ...binding } = s.store.get<any>('native_bindings', s.channel.id);
        s.store.put('native_bindings', { ...binding, createdByNoHuman: true });
      }
      let view = await s.api('GET', `/api/channels/${s.channel.id}/native/conversation`);
      assert.equal(view.canRecreateEmpty, true);
      assert.equal(created, 1);
      const replacement = await s.native.create(s.channel.id);
      assert.notEqual(replacement.threadId, first.threadId);
      assert.equal(created, 2);
      assert(
        s.store
          .all<any>('events')
          .some(
            (event) => event.action === 'native.empty-recreated' && event.changes?.before?.threadId === first.threadId
          )
      );
      missing = replacement.threadId;
      s.store.put('native_outbox', { id: 'uncertain', threadId: missing, state: 'unknown' });
      view = await s.api('GET', `/api/channels/${s.channel.id}/native/conversation`);
      assert.equal(view.canRecreateEmpty, false);
      await s.native.create(s.channel.id);
      assert.equal(created, 2);
    } finally {
      await s.cleanup();
    }
  });
const nextWork = (state = 'continue', waitMinutes?: number) =>
  '完成实际验证。\n```morrow-next\n' +
  JSON.stringify({
    state,
    focus: '登录体验',
    reason: '上次验证发现可复现的问题',
    nextStep: state === 'needs_input' ? '先修登录还是导入？' : '验证登录错误提示',
    ...(waitMinutes ? { waitMinutes } : {}),
  }) +
  '\n```';
const completeWork = (s: any, text: string) =>
  s.transport.emit({
    turns: s.transport.snapshot.state.turns.map((turn: any) => ({
      ...turn,
      status: 'completed',
      items: [...turn.items, { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text }],
    })),
  });
test('a follower turn ending on an ordinary wait says the board was not changed, never that a CLI ended', async () => {
  const s = await setup();
  try {
    await s.native.bind(s.channel.id, s.transport.threadId);
    await s.engine.action(s.channel.id, 'resume');
    const run = s.store.all<any>('runs').find((row: any) => row.source === 'morrow-schedule');
    completeWork(s, nextWork('wait', 60));
    const finished = s.store.get<any>('runs', run.id);
    assert.equal(finished.status, 'completed');
    assert.equal(finished.reportStatus, 'missing');
    assert.equal(finished.reportError, '本轮结束，未附看板报告，看板未改动。');
    const completed = s.store
      .all<any>('events')
      .find((event: any) => event.runId === run.id && event.action === 'run.completed');
    assert.equal(completed.text, '原生任务轮次正常结束。本轮结束，未附看板报告，看板未改动。');
    // A CLI turn keeps saying that a CLI ended, and a run row written before `executionOwner`
    // existed is one; what did not happen is the same sentence for both kinds.
    for (const owner of ['cli', undefined] as const)
      assert.equal(
        extractReport(undefined, nextWork('wait', 60), owner).error,
        'CLI 已结束，未提供看板报告；看板未改动。'
      );
    // A report that is present but unusable says the same thing about the board, either way.
    for (const owner of ['codex-app', 'cli'] as const)
      assert.match(extractReport('not an object', '', owner).error, /^看板报告未通过验证：.+。看板未改动。$/);
    assert.equal(extractReport(undefined, '```morrow-report\n{}\n', 'codex-app').error, '看板报告代码块未完整结束。');
    assert.equal(s.transport.interruptions.length, 0);
  } finally {
    await s.cleanup();
  }
});
test('scheduled native turns clear old pending wakes and retain feedback arriving before the final wait', async () => {
  const s = await setup();
  try {
    await s.native.bind(s.channel.id, s.transport.threadId);
    s.store.put('channels', {
      ...s.store.get<any>('channels', s.channel.id),
      pendingWake: { reason: '旧轮次反馈', at: new Date().toISOString() },
    });
    await s.engine.action(s.channel.id, 'resume');
    assert.equal(s.store.get<any>('channels', s.channel.id).pendingWake, undefined);
    s.engine.loop.wake(s.channel.id, '本轮复核完成');
    completeWork(s, nextWork('wait', 60));
    const channel = s.store.get<any>('channels', s.channel.id);
    assert.equal(channel.status, 'waiting');
    assert(Date.parse(channel.nextRunAt) <= Date.now() + 5000);
    assert.match(channel.work.nextStep, /本轮复核完成/);
    assert.equal(channel.pendingWake, undefined);
    assert.equal(s.transport.sent.length, 1);
  } finally {
    await s.cleanup();
  }
});
test('a scheduled native turn starts from the channel as it is after the App sync, not as it was before', async () => {
  const s = await setup();
  try {
    await s.native.bind(s.channel.id, s.transport.threadId);
    const read = s.transport.readThread.bind(s.transport);
    let edited = false;
    Object.assign(s.transport, {
      readThread: async (threadId: string) => {
        // Stands for anything that edits this channel while the App is still answering: a PATCH
        // from the interface, guidance accepted by the ingest of this very snapshot, or feedback.
        if (!edited) {
          edited = true;
          s.store.put('channels', {
            ...s.store.get<any>('channels', s.channel.id),
            goal: '同步期间改过的目标',
            pendingWake: { reason: '同步期间到达的反馈', at: new Date().toISOString() },
          });
        }
        return read(threadId);
      },
    });
    await s.engine.action(s.channel.id, 'resume');
    const channel = s.store.get<any>('channels', s.channel.id);
    assert.equal(channel.status, 'running');
    assert.equal(channel.goal, '同步期间改过的目标');
    // The wake arrived after this turn's prompt was decided, so it is still there for the next one.
    assert.equal(channel.pendingWake?.reason, '同步期间到达的反馈');
    const run = s.store.all<any>('runs').find((row) => row.source === 'morrow-schedule');
    assert.equal(run.workDirection, '同步期间改过的目标');
    assert.equal(s.transport.sent.length, 1);
    assert.match(s.transport.sent[0].text, /同步期间改过的目标/);
  } finally {
    await s.cleanup();
  }
});
test('a reconnected shared projection with a reset counter finishes the same native run and preserves its history', async () => {
  const s = await setup();
  try {
    s.transport.snapshot.revision = 500;
    await s.native.bind(s.channel.id, s.transport.threadId);
    await s.engine.action(s.channel.id, 'resume');
    const run = s.store.all<any>('runs')[0];
    s.transport.snapshot = { ...s.transport.snapshot, ownerClientId: 'shared:host:new-connection', revision: 0 };
    completeWork(s, nextWork('wait', 60));
    assert.equal(s.store.get<any>('runs', run.id).status, 'completed');
    assert.match(s.store.runText(run.id, 'final'), /完成实际验证/);
    assert.equal(s.native.binding(s.channel.id)?.threadId, s.transport.threadId);
    assert.equal(s.store.all('runs').length, 1);
  } finally {
    await s.cleanup();
  }
});
test('a native legacy needsHuman report cannot disable a registered release wait or override a manual pause', async () => {
  const s = await setup();
  try {
    await s.native.bind(s.channel.id, s.transport.threadId);
    await s.engine.action(s.channel.id, 'resume');
    const run = s.store.all<any>('runs')[0];
    const deadline = new Date(Date.now() + 3600000).toISOString();
    s.store.put('loop_waits', {
      id: s.channel.id,
      projectId: s.project.id,
      runId: run.id,
      watchIds: [],
      releaseIds: [],
      deadline,
      reason: '等待上线确认',
      status: 'waiting',
    });
    completeWork(
      s,
      '已准备好，等待上线确认。\n```morrow-report\n' +
        JSON.stringify({ summary: '等待上线确认', items: [], knowledge: [], nextCheckMinutes: 60, needsHuman: true }) +
        '\n```\n' +
        nextWork('wait', 60)
    );
    assert.equal(s.engine.control(s.channel.id).enabled, true);
    assert.equal(s.store.get<any>('channels', s.channel.id).status, 'waiting');
    assert.equal(s.store.get<any>('channels', s.channel.id).nextRunAt, deadline);
    await s.engine.action(s.channel.id, 'pause');
    s.engine.loop.signal(s.channel.id, 'receipt', '发布结果');
    assert.equal(s.engine.control(s.channel.id).enabled, false);
    assert.equal(s.store.get<any>('channels', s.channel.id).nextRunAt, '');
  } finally {
    await s.cleanup();
  }
});
test('start prepares one task, native decisions drive follow-up and user guidance resumes the same work', async () => {
  const s = await setup();
  try {
    let creates = 0;
    Object.assign(s.transport, {
      backgroundReady: true,
      createThread: async () => {
        creates++;
        s.transport.emit({ turns: [] });
        return s.transport.readThread(s.transport.threadId);
      },
    });
    await Promise.all([s.engine.action(s.channel.id, 'resume'), s.engine.action(s.channel.id, 'resume')]);
    assert.equal(creates, 1);
    assert.equal(s.transport.sent.length, 1);
    assert.match(s.transport.sent[0].text, /先核对最新指导、事实、进展和未知，再选择有价值的行动/);
    assert.equal(s.engine.control(s.channel.id).enabled, true);
    completeWork(s, nextWork());
    let channel = s.store.get<any>('channels', s.channel.id);
    assert.equal(channel.work.state, 'continue');
    assert(Date.parse(channel.nextRunAt) - Date.now() < 31000);
    assert.equal(s.store.all<any>('runs')[0].status, 'completed');
    assert.equal(s.store.snapshot([]).channels[0].autonomyEnabled, true);
    s.store.put('channels', { ...channel, nextRunAt: new Date(0).toISOString() });
    s.engine.tick();
    for (let i = 0; i < 100 && s.transport.sent.length < 2; i++) await new Promise((done) => setTimeout(done, 5));
    assert.equal(s.transport.sent.length, 2);
    assert.match(s.transport.sent[1].text, /验证登录错误提示/);
    completeWork(s, nextWork('needs_input'));
    channel = s.store.get<any>('channels', s.channel.id);
    assert.equal(channel.work.awaitingReply, true);
    assert.equal(s.engine.control(s.channel.id).enabled, false);
    const requestId = randomUUID();
    await s.native.send(s.channel.id, '先修登录，保留现有布局', requestId);
    assert.equal(s.transport.sent.at(-1)?.text, '先修登录，保留现有布局');
    assert.equal(s.engine.control(s.channel.id).enabled, true);
    assert.equal(s.store.get<any>('channels', s.channel.id).work.awaitingReply, false);
    const guided = s.store.all<any>('events').filter((event) => event.action === 'channel.guided').length;
    await s.native.send(s.channel.id, '先修登录，保留现有布局', requestId);
    assert.equal(s.store.all<any>('events').filter((event) => event.action === 'channel.guided').length, guided);
    assert.equal(creates, 1);
    assert.equal(
      (await s.native.conversation(s.channel.id, {})).items.filter((item) => item.autonomousContext).length,
      2
    );
  } finally {
    await s.cleanup();
  }
});
test('wait decisions persist while manual pause prevents later chat from reactivating work', async () => {
  const s = await setup();
  try {
    await s.native.bind(s.channel.id, s.transport.threadId);
    await s.engine.action(s.channel.id, 'resume');
    completeWork(s, nextWork('wait', 120));
    let channel = s.store.get<any>('channels', s.channel.id);
    assert.equal(channel.work.waitMinutes, 120);
    assert(Date.parse(channel.nextRunAt) - Date.now() > 119 * 60000);
    await s.engine.action(s.channel.id, 'pause');
    await s.native.send(s.channel.id, '只是问问当前进展', randomUUID());
    assert.equal(s.engine.control(s.channel.id).enabled, false);
    assert.equal(s.store.get<any>('channels', s.channel.id).nextRunAt, '');
    const saved = s.store.get<any>('channels', s.channel.id).work;
    assert.equal(saved.runId, s.store.all<any>('runs').find((run) => run.source === 'morrow-schedule').id);
    assert(s.store.all<any>('events').some((event) => event.action === 'channel.next-step'));
  } finally {
    await s.cleanup();
  }
});
test('unknown guidance waits for native confirmation and cannot override a subsequent pause', async () => {
  const s = await setup();
  try {
    await s.native.bind(s.channel.id, s.transport.threadId);
    await s.engine.action(s.channel.id, 'resume');
    completeWork(s, nextWork('needs_input'));
    s.transport.failure = true;
    const requestId = randomUUID();
    const receipt = await s.native.send(s.channel.id, '先修登录', requestId);
    assert.equal(receipt.state, 'unknown');
    assert.equal(s.engine.control(s.channel.id).enabled, false);
    await s.engine.action(s.channel.id, 'pause');
    s.transport.emit({
      turns: [
        ...s.transport.snapshot.state.turns,
        {
          turnId: 'later-confirmed',
          status: 'completed',
          items: [
            {
              id: 'late-user',
              type: 'userMessage',
              clientId: requestId,
              content: [{ type: 'text', text: '先修登录' }],
            },
          ],
        },
      ],
    });
    assert.equal(s.store.get<any>('native_outbox', s.channel.id + ':' + requestId).state, 'accepted');
    assert.equal(s.engine.control(s.channel.id).enabled, false);
    assert.equal(s.store.get<any>('channels', s.channel.id).work.awaitingReply, false);
  } finally {
    await s.cleanup();
  }
});
test('a reply from the native App also releases an agent question without starting a second session', async () => {
  const s = await setup();
  try {
    await s.native.bind(s.channel.id, s.transport.threadId);
    await s.engine.action(s.channel.id, 'resume');
    completeWork(s, nextWork('needs_input'));
    s.transport.emit({
      turns: [
        ...s.transport.snapshot.state.turns,
        {
          turnId: 'app-guidance',
          status: 'inProgress',
          items: [{ id: 'app-user', type: 'userMessage', content: [{ type: 'text', text: '先修登录' }] }],
        },
      ],
    });
    assert.equal(s.engine.control(s.channel.id).enabled, true);
    assert.equal(s.store.get<any>('channels', s.channel.id).work.awaitingReply, false);
    assert.equal(s.transport.sent.length, 1);
  } finally {
    await s.cleanup();
  }
});
test('an obsolete direction never installs the old next step', async () => {
  const s = await setup();
  try {
    await s.native.bind(s.channel.id, s.transport.threadId);
    await s.engine.action(s.channel.id, 'resume');
    const channel = s.store.get<any>('channels', s.channel.id);
    s.store.put('channels', { ...channel, goal: '先解决用户最新指定的问题' });
    completeWork(s, nextWork('needs_input'));
    assert.equal(s.store.get<any>('channels', s.channel.id).work, undefined);
    assert.equal(s.engine.control(s.channel.id).enabled, true);
    assert(s.store.all<any>('events').some((event) => event.action === 'channel.plan-outdated'));
  } finally {
    await s.cleanup();
  }
});
test('follower-only and failed background connection cannot claim native creation is available', async () => {
  const s = await setup();
  try {
    await assert.rejects(() => s.native.create(s.channel.id), /Codex App/);
    assert.equal(s.store.all('native_bindings').length, 0);
    Object.assign(s.transport, {
      backgroundReady: true,
      createThread: async () => {
        throw new Error('should not run');
      },
      connect: async () => {
        throw new Error('ambiguous native host');
      },
    });
    const status = await s.api('GET', '/api/native/status');
    assert.equal(status.connected, false);
    assert.equal(status.capabilities.create, false);
    assert.match(status.detail, /ambiguous/);
    assert.equal(status.rawDetail, undefined);
  } finally {
    await s.cleanup();
  }
});
test('each known native connection failure reads as one human sentence, and nothing else leaks a path or an errno', () => {
  /** What the socket reported, and the one line a person is shown instead of it. */
  const cases: Array<[string, string]> = [
    ['connect ECONNREFUSED /Users/yukun/.codex/ipc/ipc.sock', 'Codex App 未运行，打开后会自动重连'],
    [
      "ENOENT: no such file or directory, connect '/Users/yukun/.codex/ipc/ipc.sock'",
      'Codex App 未运行，打开后会自动重连',
    ],
    ['connect ETIMEDOUT /Users/yukun/.codex/ipc/ipc.sock', 'Codex App 没有响应，稍后会重试'],
    ['Request timed out after 15000ms', 'Codex App 没有响应，稍后会重试'],
    ["EACCES: permission denied, connect '/Users/yukun/.codex/ipc/ipc.sock'", '无法访问 Codex App 的本机连接（权限）'],
    ['EPERM: operation not permitted', '无法访问 Codex App 的本机连接（权限）'],
    // Anything else keeps its own first line, without the path and without the errno.
    ['ECONNRESET while reading /Users/yukun/.codex/ipc/ipc.sock\n    at Socket.onError (node:net)', 'while reading'],
    ['no rollout found for /Users/yukun/.codex/sessions/rollout.jsonl', 'no rollout found for'],
    // Text with nothing technical in it is shown exactly as the service wrote it.
    ['未找到 Codex App 的本机对话连接，请打开 Codex App。', '未找到 Codex App 的本机对话连接，请打开 Codex App。'],
    ['读/写权限不足', '读/写权限不足'],
    ['', ''],
  ];
  for (const [raw, human] of cases) {
    const detail = connectionDetail(raw);
    assert.equal(detail, human, raw);
    // Whatever the reason, what a person reads carries neither an absolute path nor an errno.
    assert.doesNotMatch(detail, /(?<![\w一-鿿])\/[\w.~@+-]/, raw);
    assert.doesNotMatch(detail, /\bE(?!RROR\b)[A-Z][A-Z0-9]{2,}\b/, raw);
    assert.equal(detail.includes('\n'), false, raw);
    // Mapping is idempotent, so a stored human sentence read back is never rewritten again.
    assert.equal(connectionDetail(detail), detail, raw);
  }
  // A transport that reports readiness without a reason at all still means there is no reason.
  assert.equal(connectionDetail(undefined), '');
});
test('a failed native task sync tells the channel page the App is not running and keeps the socket text beside it', async () => {
  const s = await setup();
  try {
    await s.api('POST', `/api/channels/${s.channel.id}/native/bind`, { threadId: s.transport.threadId });
    const raw = 'connect ECONNREFUSED /Users/yukun/.codex/ipc/ipc.sock';
    const human = 'Codex App 未运行，打开后会自动重连';
    const read = s.transport.readThread.bind(s.transport);
    Object.assign(s.transport, {
      readThread: async () => {
        throw new Error(raw);
      },
    });
    const failed = await s.api('GET', `/api/channels/${s.channel.id}/native/conversation`);
    assert.equal(failed.syncError, human);
    assert.equal(failed.rawSyncError, raw);
    // The same channel page reads the connection detail; it must not fall back to the raw text.
    assert.equal(failed.status.detail, human);
    assert.equal(failed.status.rawDetail, raw);
    const binding = s.store.get<any>('native_bindings', s.channel.id);
    assert.equal(binding.syncError, human);
    assert.equal(binding.rawSyncError, raw);
    // Connecting failing the same way says the same thing, with the original kept for diagnosis.
    s.transport.connected = false;
    Object.assign(s.transport, {
      connect: async () => {
        throw new Error(raw);
      },
    });
    const status = await s.api('GET', '/api/native/status');
    assert.equal(status.connected, false);
    assert.equal(status.detail, human);
    assert.equal(status.rawDetail, raw);
    // Once the App answers again both the human sentence and the text behind it are gone.
    s.transport.connected = true;
    Object.assign(s.transport, { connect: async () => {}, readThread: read });
    const recovered = await s.api('GET', `/api/channels/${s.channel.id}/native/conversation`);
    assert.equal(recovered.syncError, undefined);
    assert.equal(recovered.rawSyncError, undefined);
    const restored = s.store.get<any>('native_bindings', s.channel.id);
    assert.equal(restored.syncError, '');
    assert.equal(restored.rawSyncError, undefined);
    assert.equal(s.transport.interruptions.length, 0);
  } finally {
    await s.cleanup();
  }
});
test('a bind whose first read fails carries that failure, not a generic sentence', async () => {
  const s = await setup();
  try {
    const raw = 'connect ECONNREFUSED /Users/yukun/.codex/ipc/ipc.sock';
    Object.assign(s.transport, {
      readThread: async () => {
        throw new Error(raw);
      },
    });
    // The App is unreachable, so nothing reads the task again after the binding is written: what the
    // page shows is exactly what `bind` recorded.
    s.transport.connected = false;
    const bound = await s.api('POST', `/api/channels/${s.channel.id}/native/bind`, { threadId: s.transport.threadId });
    const human = 'Codex App 未运行，打开后会自动重连';
    assert.equal(bound.syncError, human);
    assert.equal(bound.rawSyncError, raw);
    const binding = s.store.get<any>('native_bindings', s.channel.id);
    assert.equal(binding.threadId, s.transport.threadId);
    assert.equal(binding.syncError, human);
    assert.equal(binding.rawSyncError, raw);
  } finally {
    await s.cleanup();
  }
});
test('native binding uses the same project task, persists full original messages, deduplicates sends and preserves sessions on settings edits', async () => {
  const s = await setup();
  try {
    const list = await s.api('GET', `/api/channels/${s.channel.id}/native/threads`);
    assert.equal(list.threads[0].id, s.transport.threadId);
    await s.api('POST', `/api/channels/${s.channel.id}/native/bind`, { threadId: 'other-project' }, 404);
    await s.api('POST', `/api/channels/${s.channel.id}/native/bind`, { threadId: s.transport.threadId });
    const text = '  原样输入\n不要添加调度上下文  ';
    const requestId = randomUUID();
    const receipt = await s.api('POST', `/api/channels/${s.channel.id}/native/messages`, { text, requestId });
    assert.equal(receipt.state, 'accepted');
    assert.equal(s.transport.sent[0].text, text);
    await s.api('POST', `/api/channels/${s.channel.id}/native/messages`, { text, requestId });
    assert.equal(s.transport.sent.length, 1);
    await s.api('POST', `/api/channels/${s.channel.id}/native/messages`, { text: 'different', requestId }, 409);
    const conversation = await s.api('GET', `/api/channels/${s.channel.id}/native/conversation`);
    assert.equal(conversation.items[0].text, text);
    assert.equal(conversation.thread.activeTurnId, receipt.turnId);
    const updated = await s.api('PATCH', `/api/channels/${s.channel.id}`, {
      model: 'native-model',
      permission: 'workspace-write',
    });
    assert.equal(updated.sessionId, s.transport.threadId);
    await s.api('POST', `/api/channels/${s.channel.id}/messages`, { text: 'old-note' }, 409);
    assert.equal(s.store.all<any>('runs')[0].source, 'morrow-chat');
    assert.equal(s.engine.budgetCount(s.channel.id), 0);
    // Projecting a snapshot journals nothing: `native_events` holds original IPC deltas only, and
    // this transport delivers whole snapshots.
    assert.equal(s.store.all('native_events').length, 0);
    assert.equal(s.store.all<any>('native_outbox')[0].text, text);
  } finally {
    await s.cleanup();
  }
});
test('native external history remains complete, paged, revision safe and available offline', async () => {
  const s = await setup();
  try {
    await s.api('POST', `/api/channels/${s.channel.id}/native/bind`, { threadId: s.transport.threadId });
    const long = '外部完整消息'.repeat(4000);
    const turns = Array.from({ length: 185 }, (_, i) => ({
      turnId: `turn-${i}`,
      status: 'completed',
      items: [{ id: `item-${i}`, type: 'agentMessage', text: i === 184 ? long : `message ${i}` }],
    }));
    s.transport.emit({ turns });
    const page = await s.api('GET', `/api/channels/${s.channel.id}/native/conversation?limit=80`);
    assert.equal(page.items.length, 80);
    assert.equal(page.items.at(-1).text, long);
    assert.equal(page.hasMore, true);
    const older = await s.api(
      'GET',
      `/api/channels/${s.channel.id}/native/conversation?limit=80&before=${page.cursor}`
    );
    assert.equal(older.items.length, 80);
    assert.equal(new Set([...page.items, ...older.items].map((row) => row.id)).size, 160);
    s.native.ingest({ ...s.transport.snapshot, revision: 0, state: { turns: [] } });
    assert.equal(s.store.all<any>('native_items').filter((row) => row.present).length, 185);
    s.transport.connected = false;
    const cached = await s.api('GET', `/api/channels/${s.channel.id}/native/conversation`);
    assert.equal(cached.status.connected, false);
    assert.equal(cached.items.at(-1).text, long);
    assert.equal(s.store.all('runs').length, 185);
    assert(s.store.all<any>('runs').every((run) => run.source === 'native-app'));
    assert.equal(s.engine.budgetCount(s.channel.id), 0);
  } finally {
    await s.cleanup();
  }
});
test('unknown sends are never retried and native approvals and interrupt are scoped to the active turn', async () => {
  const s = await setup();
  try {
    await s.api('POST', `/api/channels/${s.channel.id}/native/bind`, { threadId: s.transport.threadId });
    s.transport.failure = true;
    const requestId = randomUUID();
    const first = await s.api('POST', `/api/channels/${s.channel.id}/native/messages`, { text: 'hello', requestId });
    assert.equal(first.state, 'unknown');
    await s.api('POST', `/api/channels/${s.channel.id}/native/messages`, { text: 'hello', requestId });
    assert.equal(s.transport.sent.length, 1);
    s.transport.emit({
      turns: [{ turnId: 'external-turn', status: 'inProgress', items: [] }],
      requests: [
        {
          id: 42,
          method: 'item/commandExecution/requestApproval',
          params: { threadId: s.transport.threadId, turnId: 'external-turn' },
        },
      ],
    });
    await s.api('POST', `/api/channels/${s.channel.id}/native/interrupt`, { turnId: 'wrong' }, 409);
    await s.api('POST', `/api/channels/${s.channel.id}/native/interrupt`, { turnId: 'external-turn' });
    assert.deepEqual(s.transport.interruptions, ['external-turn']);
    await assert.rejects(() => s.native.respond(s.channel.id, 'wrong', { decision: 'accept' }), /已经处理或已失效/);
    await s.native.respond(s.channel.id, '42', { decision: 'decline' });
    assert.equal(s.transport.answers[0].requestId, 42);
    assert.equal(s.transport.answers[0].kind, 'command');
    const answered = s.store.all<any>('native_requests')[0];
    assert.equal(answered.status, 'responded');
    assert(answered.resolvedAt);
    // The projection that stops listing it settles it and keeps the moment it was actually answered.
    s.transport.emit({ requests: [] });
    const settled = s.store.all<any>('native_requests')[0];
    assert.equal(settled.status, 'resolved');
    assert.equal(settled.resolvedAt, answered.resolvedAt);
  } finally {
    await s.cleanup();
  }
});
test('native bounded scheduling inherits compatible settings, observes completion, rejects unsafe scope and never starts a CLI', async () => {
  const s = await setup();
  try {
    await s.api('POST', `/api/channels/${s.channel.id}/native/bind`, { threadId: s.transport.threadId });
    await s.api('PATCH', `/api/channels/${s.channel.id}`, { permission: 'read-only' });
    s.transport.emit({ currentPermissions: { sandboxPolicy: { type: 'dangerFullAccess' } } });
    await s.api('POST', `/api/channels/${s.channel.id}/action`, { action: 'run' }, 409);
    assert.equal(s.transport.sent.length, 0);
    s.transport.emit({ currentPermissions: { sandboxPolicy: { type: 'readOnly' } } });
    await s.api('POST', `/api/channels/${s.channel.id}/action`, { action: 'run' });
    assert.equal(s.transport.sent.length, 1);
    assert.equal(s.engine.active.size, 0);
    const run = s.store.all<any>('runs')[0];
    assert.equal(run.executionOwner, 'codex-app');
    assert.equal(run.permission, 'read-only');
    assert.deepEqual(s.transport.sent[0].workOptions?.sandboxPolicy, { type: 'readOnly', networkAccess: false });
    const turns = s.transport.snapshot.state.turns.map((turn: any) => ({
      ...turn,
      status: 'completed',
      items: [...turn.items, { id: 'native-final', type: 'agentMessage', text: '原生 App 中完成的同一轮次。' }],
    }));
    s.transport.emit({ turns });
    assert.equal(s.store.get<any>('runs', run.id).status, 'completed');
    assert.match(s.store.runText(run.id, 'final'), /同一轮次/);
    assert.equal(s.store.all('items').length, 0);
  } finally {
    await s.cleanup();
  }
});
test('a stored native turn keeps its own fields without a second copy of its items, and an older projection rebuilds', async () => {
  const s = await setup();
  try {
    await s.api('POST', `/api/channels/${s.channel.id}/native/bind`, { threadId: s.transport.threadId });
    s.transport.emit({
      turns: [
        {
          turnId: 'recorded',
          status: 'completed',
          params: { turnTrigger: 'composer' },
          items: [{ id: 'recorded-item', type: 'agentMessage', phase: 'final_answer', text: '原生轮次结果' }],
        },
      ],
    });
    const stored = () => s.store.nativeRows<any>('native_turns', s.transport.threadId)[0];
    // Every item is already its own row; the turn keeps the fields only it has.
    assert.equal(stored().raw.items, undefined);
    assert.equal(stored().raw.params.turnTrigger, 'composer');
    assert.equal(stored().nativeTurnId, 'recorded');
    assert.equal(s.store.nativeRows<any>('native_items', s.transport.threadId).at(-1).text, '原生轮次结果');
    const current = stored().projectionVersion;
    assert(current > 2);
    // A row an older projection cached with its items duplicated is rebuilt, not kept.
    s.store.put('native_turns', {
      ...stored(),
      projectionVersion: 1,
      raw: { ...stored().raw, items: [{ id: 'recorded-item' }] },
    });
    s.native.turnCache.clear();
    s.native.observed.clear();
    s.native.ingest(structuredClone(s.transport.snapshot));
    assert.equal(stored().raw.items, undefined);
    assert.equal(stored().projectionVersion, current);
    assert.equal(s.store.all('runs').length, 1);
  } finally {
    await s.cleanup();
  }
});
test('per-thread disconnect disables sending, same-revision reconnect clears errors without duplicate writes, and partial history retains older items', async () => {
  const s = await setup();
  try {
    await s.api('POST', `/api/channels/${s.channel.id}/native/bind`, { threadId: s.transport.threadId });
    s.transport.emit({
      turns: [
        { turnId: 'old', status: 'completed', items: [{ id: 'old-message', type: 'agentMessage', text: 'older' }] },
        { turnId: 'new', status: 'completed', items: [{ id: 'new-message', type: 'agentMessage', text: 'latest' }] },
      ],
    });
    const before = { events: s.store.all('native_events').length, items: s.store.all('native_items').length };
    s.transport.readFailure = true;
    const disconnected = await s.api('GET', `/api/channels/${s.channel.id}/native/conversation`);
    assert.equal(disconnected.status.connected, false);
    assert.equal(disconnected.status.capabilities.send, false);
    s.transport.readFailure = false;
    const reconnected = await s.api('GET', `/api/channels/${s.channel.id}/native/conversation`);
    assert.equal(reconnected.status.connected, true);
    assert.deepEqual(
      { events: s.store.all('native_events').length, items: s.store.all('native_items').length },
      before
    );
    s.transport.emit({
      turnHistory: {
        history: {
          isComplete: false,
          islands: [{ entries: [{ value: 'new' }] }],
          entitiesByKey: { new: s.transport.snapshot.state.turns[1] },
        },
      },
    });
    const partial = await s.api('GET', `/api/channels/${s.channel.id}/native/conversation`);
    assert.deepEqual(
      partial.items.map((item: any) => item.text),
      ['older', 'latest']
    );
  } finally {
    await s.cleanup();
  }
});
test('daemon restart observes external native work without taking ownership or interrupting App, while definitive scheduler rejection settles', async () => {
  const s = await setup();
  let restarted: IsolatedService | undefined;
  try {
    await s.api('POST', `/api/channels/${s.channel.id}/native/bind`, { threadId: s.transport.threadId });
    const receipt = await s.api('POST', `/api/channels/${s.channel.id}/native/messages`, {
      text: 'native chat',
      requestId: randomUUID(),
    });
    const run = s.store.all<any>('runs')[0];
    await s.close();
    assert.equal(s.transport.interruptions.length, 0);
    s.transport.connected = true;
    restarted = await s.restart();
    await restarted.native.conversation(s.channel.id, {});
    assert.equal(restarted.native.scheduled.size, 0);
    assert.equal(restarted.store.get<any>('runs', run.id).status, 'running');
    s.transport.emit({
      turns: s.transport.snapshot.state.turns.map((turn: any) => ({
        ...turn,
        status: 'completed',
        items: [
          ...turn.items,
          { id: 'final', type: 'agentMessage', phase: 'commentary', text: 'not final' },
          { id: 'final-answer', type: 'agentMessage', phase: 'final_answer', text: 'native final' },
        ],
      })),
    });
    assert.equal(restarted.store.get<any>('runs', run.id).status, 'completed');
    assert.equal(restarted.store.runText(run.id, 'final'), 'native final');
    assert.equal(restarted.engine.budgetCount(s.channel.id), 0);
    s.transport.definitiveFailure = true;
    await restarted.engine.action(s.channel.id, 'run');
    const failed = restarted.store.all<any>('runs').find((row) => row.source === 'morrow-schedule');
    assert.equal(failed.status, 'failed');
    assert.equal(restarted.native.scheduled.size, 0);
    assert.equal(s.transport.interruptions.length, 0);
    assert(receipt.turnId);
  } finally {
    await restarted?.close();
    await s.cleanup();
  }
});
test('native image API persists selected bytes and sends opaque attachments once without changing image-only input', async () => {
  const s = await setup();
  try {
    const path = join(s.root, 'pixel.png');
    writeFileSync(
      path,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxIoAAAAASUVORK5CYII=',
        'base64'
      )
    );
    await s.api('POST', `/api/channels/${s.channel.id}/native/bind`, { threadId: s.transport.threadId });
    const images = importNativeImages(s.store, s.home, s.channel.id, [path]);
    const requestId = randomUUID();
    await s.api('POST', `/api/channels/${s.channel.id}/native/messages`, { text: '', requestId, attachments: images });
    assert.equal(s.transport.sent[0].text, '');
    assert.equal(s.transport.sent[0].images?.length, 1);
    assert.notEqual(s.transport.sent[0].images?.[0].path, path);
    await s.api('POST', `/api/channels/${s.channel.id}/native/messages`, {
      text: '',
      requestId,
      attachments: images.map((image: any) => ({ ...image, name: 'presentation-only' })),
    });
    assert.equal(s.transport.sent.length, 1);
    const conversation = await s.api('GET', `/api/channels/${s.channel.id}/native/conversation`);
    const loaded = readNativeImage(s.store, s.channel.id, conversation.items[0].id, 1);
    assert.match(loaded.dataUrl, /^data:image\/png;base64,/);
  } finally {
    await s.cleanup();
  }
});
test('actual App steering messages remain user input, reconcile unknown delivery, deduplicate canonical messages and reproject old snapshots', async () => {
  const s = await setup();
  try {
    await s.api('POST', `/api/channels/${s.channel.id}/native/bind`, { threadId: s.transport.threadId });
    const requestId = randomUUID(),
      turnId = randomUUID(),
      serverId = randomUUID();
    const text = '  Morrow 双端追加验收\n保留原文  ';
    const createdAt = '2026-09-07T08:30:00.000Z';
    const steering = {
      type: 'steeringUserMessage',
      id: randomUUID(),
      targetTurnId: turnId,
      targetTurnStartedAtMs: 1788769000000,
      status: 'accepted',
      serverUserMessageId: serverId,
      clientUserMessageId: requestId,
      input: [{ type: 'text', text }],
      attachments: [],
      restoreMessage: { id: requestId, text, context: [], cwd: s.project.path, createdAt },
      compareKey: 'native-comparison-key',
    };
    s.store.put('native_outbox', {
      id: `${s.channel.id}:${requestId}`,
      requestId,
      channelId: s.channel.id,
      projectId: s.project.id,
      threadId: s.transport.threadId,
      text,
      state: 'unknown',
      source: 'chat',
      createdAt,
    });
    s.transport.emit({
      turns: [{ turnId, status: 'inProgress', items: [steering, { type: 'steered', id: serverId }] }],
    });
    let view = await s.api('GET', `/api/channels/${s.channel.id}/native/conversation`);
    assert.equal(view.items.length, 1);
    assert.equal(view.items[0].role, 'user');
    assert.equal(view.items[0].text, text);
    assert.equal(view.items[0].createdAt, createdAt);
    assert.deepEqual(view.items[0].raw, steering);
    assert.equal(s.store.get<any>('native_outbox', `${s.channel.id}:${requestId}`).state, 'accepted');
    assert.equal(s.store.get<any>('native_outbox', `${s.channel.id}:${requestId}`).turnId, turnId);
    const run = s.store.all<any>('runs')[0];
    assert.equal(s.store.runText(run.id, 'prompt'), text);
    const existing = s.store.get<any>('native_items', view.items[0].id);
    s.store.put('native_items', { ...existing, role: 'tool', text: '' });
    const thread = s.store.get<any>('native_threads', s.transport.threadId);
    s.store.put('native_threads', { ...thread, projectionVersion: 1 });
    s.native.observed.clear();
    s.native.ingest(structuredClone(s.transport.snapshot));
    view = await s.api('GET', `/api/channels/${s.channel.id}/native/conversation`);
    assert.equal(view.items[0].role, 'user');
    assert.equal(view.items[0].text, text);
    const canonical = { type: 'userMessage', id: serverId, clientId: requestId, content: [{ type: 'text', text }] };
    s.transport.emit({
      turns: [{ turnId, status: 'inProgress', items: [steering, { type: 'steered', id: serverId }, canonical] }],
    });
    view = await s.api('GET', `/api/channels/${s.channel.id}/native/conversation`);
    assert.equal(view.items.length, 1);
    assert.equal(view.items[0].type, 'userMessage');
    assert.equal(view.items[0].text, text);
    assert.equal(s.store.runText(run.id, 'prompt'), text);
    assert.equal(s.transport.sent.length, 0);
  } finally {
    await s.cleanup();
  }
});
test('streaming a long native history journals every delta while coalescing only projections and flushing on close', async () => {
  const s = await setup();
  try {
    await s.api('POST', `/api/channels/${s.channel.id}/native/bind`, { threadId: s.transport.threadId });
    const items = Array.from({ length: 1066 }, (_, index) => ({
      id: `item-${index}`,
      type: 'agentMessage',
      phase: 'commentary',
      text: `${index}:` + 'history '.repeat(512),
    }));
    const state = { turns: [{ turnId: 'large-turn', status: 'inProgress', items }], requests: [] };
    let snapshot = { ...s.transport.snapshot, revision: s.transport.snapshot.revision + 1, state };
    s.native.ingest(snapshot, true);
    const baselineItem = s.store.get<any>(
      'native_items',
      [...s.native.itemCache.get(snapshot.threadId)!.values()][0].id
    );
    const beforeEvents = s.store.all('native_events').length;
    const counts = { threads: 0, items: 0, scans: 0 };
    const put = s.store.put.bind(s.store);
    const rows = s.store.nativeRows.bind(s.store);
    s.store.put = ((table: string, row: any) => {
      if (table === 'native_threads') counts.threads++;
      if (table === 'native_items') counts.items++;
      return put(table, row);
    }) as typeof s.store.put;
    s.store.nativeRows = ((table: any, id: string) => {
      if (table === 'native_items') counts.scans++;
      return rows(table, id);
    }) as typeof s.store.nativeRows;
    for (let index = 1; index <= 40; index++) {
      const change = {
        type: 'patches' as const,
        baseRevision: snapshot.revision,
        revision: snapshot.revision + 1,
        patches: [{ op: 'replace' as const, path: ['turns', 0, 'items', 1065, 'text'], value: `stream ${index}` }],
      };
      snapshot = {
        ...snapshot,
        revision: change.revision,
        syncedAt: new Date().toISOString(),
        state: applyDesktopPatches(snapshot.state, change.patches) as typeof state,
      };
      s.native.queueSnapshot(snapshot, change);
    }
    assert.equal(s.store.all('native_events').length - beforeEvents, 40);
    assert.equal(counts.threads, 0);
    assert.equal(counts.items, 0);
    s.native.flushPending(snapshot.threadId);
    assert.equal(counts.items, 1);
    assert.equal(counts.threads, 0);
    assert.equal(counts.scans, 0);
    assert.equal(s.native.threadCache.get(snapshot.threadId)?.revision, snapshot.revision);
    assert.deepEqual(s.store.get('native_items', baselineItem.id), baselineItem);
    const lastChange = {
      type: 'patches' as const,
      baseRevision: snapshot.revision,
      revision: snapshot.revision + 1,
      patches: [{ op: 'replace' as const, path: ['turns', 0, 'items', 1065, 'text'], value: 'final pending text' }],
    };
    snapshot = {
      ...snapshot,
      revision: lastChange.revision,
      state: applyDesktopPatches(snapshot.state, lastChange.patches) as typeof state,
    };
    s.native.queueSnapshot(snapshot, lastChange);
    // Every delta of the streaming turn is durable before any of it is coalesced.
    assert.equal(s.store.all<any>('native_events').filter((event) => event.kind === 'native.patch').length, 41);
    s.native.close();
    assert.equal(s.native.pendingSnapshots.size, 0);
    assert.equal(s.store.get<any>('native_threads', snapshot.threadId).revision, snapshot.revision);
    assert.equal(
      s.store.nativeRows<any>('native_items', snapshot.threadId).find((item) => item.raw.id === 'item-1065').text,
      'final pending text'
    );
    // The checkpoint `close()` wrote covers all 41 revisions, so recovery can never read them again.
    assert.equal(s.store.all('native_events').length, 0);
    assert.equal(s.transport.interruptions.length, 0);
  } finally {
    await s.cleanup();
  }
});
test('unflushed native deltas recover from the durable journal before App reconnect', async () => {
  const s = await setup();
  let recovered: NativeConversations | undefined;
  try {
    await s.api('POST', `/api/channels/${s.channel.id}/native/bind`, { threadId: s.transport.threadId });
    const state = {
      turns: [
        {
          turnId: 'recover-turn',
          status: 'inProgress',
          items: [{ id: 'recover-item', type: 'agentMessage', phase: 'commentary', text: 'before' }],
        },
      ],
      requests: [],
    };
    const initial = { ...s.transport.snapshot, revision: s.transport.snapshot.revision + 1, state };
    s.native.ingest(initial, true);
    const change = {
      type: 'patches' as const,
      baseRevision: initial.revision,
      revision: initial.revision + 1,
      patches: [{ op: 'replace' as const, path: ['turns', 0, 'items', 0, 'text'], value: 'durable after crash' }],
    };
    const latest = { ...initial, revision: change.revision, state: applyDesktopPatches(initial.state, change.patches) };
    s.native.queueSnapshot(latest, change);
    assert.equal(s.store.get<any>('native_threads', initial.threadId).revision, initial.revision);
    // Simulate process death before its projection timer, leaving the committed delta.
    for (const timer of s.native.pendingTimers.values()) clearTimeout(timer);
    s.native.pendingTimers.clear();
    s.native.pendingSnapshots.clear();
    s.native.closed = true;
    s.transport.connected = false;
    recovered = new NativeConversations(s.store, s.engine, s.transport);
    recovered.recoverCheckpoint(initial.threadId);
    const view = await recovered.conversation(s.channel.id, {});
    assert.equal(view.status.connected, false);
    assert.equal(view.items[0].text, 'durable after crash');
    assert.equal(s.store.get<any>('native_threads', initial.threadId).revision, latest.revision);
    assert.equal(s.transport.interruptions.length, 0);
  } finally {
    recovered?.close();
    await s.cleanup();
  }
});

test('a streaming turn checkpoints at most every 30 s, bounds the journal by that checkpoint and still recovers a mid-turn death', async () => {
  const s = await setup();
  let recovered: NativeConversations | undefined;
  try {
    await s.api('POST', `/api/channels/${s.channel.id}/native/bind`, { threadId: s.transport.threadId });
    const state = {
      turns: [
        {
          turnId: 'long-turn',
          status: 'inProgress',
          items: [{ id: 'streamed', type: 'agentMessage', phase: 'commentary', text: 'start' }],
        },
      ],
      requests: [],
    };
    let snapshot = { ...s.transport.snapshot, revision: s.transport.snapshot.revision + 1, state };
    s.native.ingest(snapshot, true);
    const stored = () => s.store.get<any>('native_threads', snapshot.threadId).revision;
    const journal = () => s.store.all<any>('native_events').map((row) => row.revision);
    /** One IPC delta of the streaming turn, journaled and projected the way the subscription does. */
    const stream = (text: string, sinceCheckpoint: number) => {
      s.native.checkpointAt.set(snapshot.threadId, Date.now() - sinceCheckpoint);
      const change = {
        type: 'patches' as const,
        baseRevision: snapshot.revision,
        revision: snapshot.revision + 1,
        patches: [{ op: 'replace' as const, path: ['turns', 0, 'items', 0, 'text'], value: text }],
      };
      snapshot = {
        ...snapshot,
        revision: change.revision,
        syncedAt: new Date().toISOString(),
        state: applyDesktopPatches(snapshot.state, change.patches) as typeof state,
      };
      s.native.queueSnapshot(snapshot, change);
      s.native.flushPending(snapshot.threadId);
    };
    const first = stored();
    assert.deepEqual(journal(), []);
    // 25 s into the turn the whole thread state is not rewritten again; the delta is durable anyway.
    stream('25 秒', 25000);
    assert.equal(stored(), first);
    assert.deepEqual(journal(), [snapshot.revision]);
    // Past 30 s it is, and that checkpoint retires the journal rows it now covers.
    stream('31 秒', 31000);
    assert.equal(stored(), snapshot.revision);
    assert.deepEqual(journal(), []);
    stream('再 25 秒', 25000);
    assert.equal(stored(), snapshot.revision - 1);
    assert.deepEqual(journal(), [snapshot.revision]);
    // The process dies mid-turn, before its next checkpoint; the journal is what recovery replays.
    s.native.closed = true;
    s.transport.connected = false;
    recovered = new NativeConversations(s.store, s.engine, s.transport);
    recovered.recoverCheckpoint(snapshot.threadId);
    const view = await recovered.conversation(s.channel.id, {});
    assert.equal(view.status.connected, false);
    assert.equal(view.items.at(-1)?.text, '再 25 秒');
    assert.equal(stored(), snapshot.revision);
    assert.deepEqual(journal(), []);
    assert.equal(s.transport.interruptions.length, 0);
  } finally {
    recovered?.close();
    await s.cleanup();
  }
});

test('a checkpoint rewrites only the thread header, stores the state once per change, and still recovers a 25 s mid-turn death', async () => {
  const s = await setup();
  let recovered: NativeConversations | undefined;
  try {
    await s.api('POST', `/api/channels/${s.channel.id}/native/bind`, { threadId: s.transport.threadId });
    const items = Array.from({ length: 200 }, (_, index) => ({
      id: `item-${index}`,
      type: 'agentMessage',
      phase: 'commentary',
      text: `${index}:` + 'history '.repeat(256),
    }));
    const state = { turns: [{ turnId: 'split-turn', status: 'inProgress', items }], requests: [] };
    let snapshot = { ...s.transport.snapshot, revision: s.transport.snapshot.revision + 1, state };
    s.native.ingest(snapshot, true);
    const raw = (table: 'native_threads' | 'native_thread_state') =>
      JSON.parse(
        (s.store.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(snapshot.threadId) as { data: string }).data
      );
    // The header carries no conversation state of its own, and names the state row that holds it.
    assert.equal(raw('native_threads').state, undefined);
    assert(JSON.stringify(raw('native_threads')).length < 1024);
    assert.equal(raw('native_threads').stateHash, raw('native_thread_state').hash);
    assert.equal(raw('native_thread_state').state.turns[0].items.length, 200);
    // Every reader of `native_threads` still sees one whole snapshot.
    assert.equal(s.store.get<any>('native_threads', snapshot.threadId).state.turns[0].items.length, 200);
    assert.equal(s.store.all<any>('native_threads')[0].state.turns[0].items.length, 200);
    const bytes: Record<string, number> = { native_threads: 0, native_thread_state: 0 };
    const write = s.store.write.bind(s.store);
    s.store.write = ((table: string, id: string, data: string) => {
      if (table in bytes) bytes[table] += data.length;
      return write(table, id, data);
    }) as typeof s.store.write;
    /** The same task read again, which is what a poll of an open channel page produces. */
    const reread = (revision = snapshot.revision) => {
      s.native.observed.clear();
      s.native.ingest({ ...snapshot, revision, syncedAt: new Date().toISOString() }, true);
    };
    reread();
    // The state at this revision is already stored, so the large row is not rewritten to say so.
    assert.equal(bytes.native_thread_state, 0);
    assert(bytes.native_threads > 0 && bytes.native_threads < 1024);
    // Nor at a later revision whose projection produced the same bytes.
    reread(snapshot.revision + 1);
    assert.equal(bytes.native_thread_state, 0);
    snapshot = { ...snapshot, revision: snapshot.revision + 1 };
    // A state that is actually different is written once, and the header still costs a few hundred.
    const header = bytes.native_threads;
    s.native.observed.clear();
    snapshot = {
      ...snapshot,
      revision: snapshot.revision + 1,
      syncedAt: new Date().toISOString(),
      state: { ...state, turns: [{ ...state.turns[0], items: [...items, { ...items[0], id: 'extra' }] }] },
    };
    s.native.ingest(snapshot, true);
    assert(bytes.native_thread_state > 400_000);
    assert(bytes.native_threads - header < 1024);
    assert.equal(raw('native_thread_state').state.turns[0].items.length, 201);
    // The turn keeps streaming without a checkpoint for 25 s, then the process dies; recovery reads
    // the header, the state behind it and the journal, and still ends on the last delta.
    const change = {
      type: 'patches' as const,
      baseRevision: snapshot.revision,
      revision: snapshot.revision + 1,
      patches: [{ op: 'replace' as const, path: ['turns', 0, 'items', 200, 'text'], value: '25 秒后死亡' }],
    };
    s.native.checkpointAt.set(snapshot.threadId, Date.now() - 25000);
    const latest = {
      ...snapshot,
      revision: change.revision,
      syncedAt: new Date().toISOString(),
      state: applyDesktopPatches(snapshot.state, change.patches) as typeof state,
    };
    s.native.queueSnapshot(latest, change);
    s.native.flushPending(latest.threadId);
    assert.equal(raw('native_threads').revision, snapshot.revision);
    s.native.closed = true;
    s.transport.connected = false;
    recovered = new NativeConversations(s.store, s.engine, s.transport);
    recovered.recoverCheckpoint(latest.threadId);
    const view = await recovered.conversation(s.channel.id, {});
    assert.equal(view.status.connected, false);
    assert.equal(view.items.at(-1)?.text, '25 秒后死亡');
    assert.equal(raw('native_threads').revision, latest.revision);
    assert.equal(s.store.get<any>('native_threads', latest.threadId).state.turns[0].items.at(-1).text, '25 秒后死亡');
    assert.equal(s.transport.interruptions.length, 0);
  } finally {
    recovered?.close();
    await s.cleanup();
  }
});

test('renamed service recovers a legacy responsibility run without resending or resetting its budget', async () => {
  const s = await setup();
  let restarted: IsolatedService | undefined;
  try {
    await s.native.bind(s.channel.id, s.transport.threadId);
    await s.engine.action(s.channel.id, 'run');
    const run = s.store.all<any>('runs').find((row) => row.source === 'morrow-schedule');
    assert.equal(run.status, 'running');
    s.store.put('runs', { ...run, source: 'nohuman-schedule' });
    await s.close();
    assert.equal(s.transport.interruptions.length, 0);
    s.transport.connected = true;
    restarted = await s.restart();
    await restarted.native.conversation(s.channel.id, {});
    assert.equal(restarted.native.scheduled.get(s.channel.id)?.run.id, run.id);
    assert.equal(restarted.engine.budgetCount(s.channel.id), 1);
    completeWork(s, nextWork('wait', 60));
    const recovered = restarted.store.get<any>('runs', run.id);
    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.source, 'nohuman-schedule');
    assert.equal(recovered.sessionId, s.transport.threadId);
    assert.equal(recovered.nativeTurnId, run.nativeTurnId);
    assert.equal(restarted.store.all('runs').length, 1);
    assert.equal(s.transport.sent.length, 1);
    assert.equal(restarted.engine.budgetCount(s.channel.id), 1);
    assert.equal(restarted.native.scheduled.size, 0);
    assert.match(restarted.store.runText(run.id, 'final'), /完成实际验证/);
  } finally {
    await restarted?.close();
    await s.cleanup();
  }
});
test('native status reports App installation and backend versions without probing this Mac in test mode', async () => {
  const s = await setup();
  try {
    const initial = await s.api('GET', '/api/native/status');
    assert.equal(initial.connected, true);
    assert.equal(initial.appInstalled, false);
    assert.equal('appVersion' in initial, false);
    assert.equal('runtimeVersion' in initial, false);
    Object.assign(s.transport, { backgroundReady: true, runtimeVersion: 'codex-app-server/1.2.3' });
    const ready = await s.api('GET', '/api/native/status');
    assert.equal(ready.backgroundReady, true);
    assert.equal(ready.runtimeVersion, 'codex-app-server/1.2.3');
    // A version seen earlier is not reported once the backend is gone.
    s.transport.connected = false;
    const offline = await s.api('GET', '/api/native/status');
    assert.equal(offline.connected, false);
    assert.equal('runtimeVersion' in offline, false);
  } finally {
    await s.cleanup();
  }
});
test('the test hook fakes an installed App with a bundle version', async () => {
  process.env.MORROW_TEST_CODEX_APP_VERSION = '9.9.9-fixture';
  const s = await setup();
  try {
    const status = await s.api('GET', '/api/native/status');
    assert.equal(status.appInstalled, true);
    assert.equal(status.appVersion, '9.9.9-fixture');
  } finally {
    delete process.env.MORROW_TEST_CODEX_APP_VERSION;
    await s.cleanup();
  }
});

test('follower status reports actual associations and the retired setup endpoint cannot change launch configuration', async () => {
  const s = await setup();
  try {
    Object.assign(s.transport, {
      connectionMode: 'app-follower',
      backgroundReady: true,
      threadStatus: () => ({ ready: true, detail: 'fixture loaded' }),
    });
    const before = await s.native.status();
    assert.equal(before.boundThreadCount, 0);
    assert.equal(before.capabilities.create, false);
    await s.native.bind(s.channel.id, s.transport.threadId);
    const linked = await s.native.status();
    assert.equal(linked.boundThreadCount, 1);
    assert.equal(linked.readyThreadCount, 1);
    const rejected = await s.api('POST', '/api/native/background/setup', {}, 410);
    assert.match(rejected.error, /已退役/);
    assert.equal(s.store.get<any>('migrations', 'codex-background-bridge'), undefined);
    assert.equal(s.native.binding(s.channel.id)?.threadId, s.transport.threadId);
    assert.equal(s.transport.sent.length, 0);
  } finally {
    await s.cleanup();
  }
});

test('a nearly full task context is compacted before the scheduled turn is sent, and the work continues', async () => {
  const s = await setup();
  try {
    await s.native.bind(s.channel.id, s.transport.threadId);
    // The service waits 180 s for the App by default; the poll interval follows this field.
    s.native.compactWaitMs = 300;
    s.transport.emit(context(0.7));
    const order: number[] = [];
    const send = s.transport.sendMessage.bind(s.transport);
    Object.assign(s.transport, {
      sendMessage: (...args: Parameters<typeof send>) => {
        order.push(s.transport.compactions.length);
        return send(...args);
      },
    });
    await s.engine.action(s.channel.id, 'resume');
    // The compaction is finished before the turn's own message reaches the task.
    assert.deepEqual(order, [1]);
    assert.deepEqual(s.transport.compactions, [s.transport.threadId]);
    assert.equal(s.transport.sent.length, 1);
    assert.equal(s.transport.interruptions.length, 0);
    const texts = s.store.all<any>('events').map((event) => event.text);
    assert(texts.includes('任务上下文已用 70%（579880 / 828400），先压缩再继续。'));
    assert(texts.includes('上下文已压缩：70% → 10%，继续本轮工作。'));
    const audit = s.store.all<any>('events').find((event) => event.action === 'native.compacted');
    assert.equal(audit.actor, 'system');
    assert.equal(audit.channelId, s.channel.id);
    assert.deepEqual(audit.changes.after, { before: 579880, after: 82840, window: 828400, percent: 70 });
  } finally {
    await s.cleanup();
  }
});
test('no compaction is attempted below the threshold, on an unknown reading, or without transport support', async () => {
  for (const [name, prepare] of [
    ['below the threshold', (s: IsolatedService & { transport: FakeNative }) => s.transport.emit(context(0.3))],
    [
      'no reading at all',
      (s: IsolatedService & { transport: FakeNative }) => s.transport.emit({ latestTokenUsageInfo: undefined }),
    ],
    [
      'an unusable reading',
      (s: IsolatedService & { transport: FakeNative }) =>
        s.transport.emit({ latestTokenUsageInfo: { last: { totalTokens: contextUsed(0.7) } } }),
    ],
    [
      'no compact method',
      (s: IsolatedService & { transport: FakeNative }) => {
        s.transport.emit(context(0.7));
        // The shared and test-mode transports have none, so a double without it must be safe too.
        Object.assign(s.transport, { compact: undefined });
      },
    ],
  ] as const) {
    const s = await setup();
    try {
      await s.native.bind(s.channel.id, s.transport.threadId);
      s.native.compactWaitMs = 300;
      prepare(s);
      await s.engine.action(s.channel.id, 'resume');
      assert.deepEqual(s.transport.compactions, [], name);
      assert.equal(s.transport.sent.length, 1, name);
      assert.equal(s.store.all<any>('events').filter((event) => event.text.includes('压缩')).length, 0, name);
    } finally {
      await s.cleanup();
    }
  }
});
test('a refused compaction still starts the turn, is logged once and says nothing technical', async () => {
  const s = await setup();
  try {
    await s.native.bind(s.channel.id, s.transport.threadId);
    s.native.compactWaitMs = 300;
    s.transport.compactFailure = 'reject';
    s.transport.emit(context(0.7));
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    try {
      await s.engine.action(s.channel.id, 'resume');
    } finally {
      setLogSink();
    }
    assert.deepEqual(s.transport.compactions, [s.transport.threadId]);
    assert.equal(s.transport.sent.length, 1);
    const failures = lines.map((line) => JSON.parse(line)).filter((row) => row.event === 'native.compact.failed');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].threadId, s.transport.threadId);
    const event = s.store.all<any>('events').find((row) => row.text.startsWith('上下文压缩未完成'));
    assert.equal(event.text, '上下文压缩未完成（Codex App 未运行，打开后会自动重连），本轮照常开始。');
    assert.equal(/\//.test(event.text), false);
    assert.equal(/\bE[A-Z][A-Z0-9]{2,}\b/.test(event.text), false);
  } finally {
    await s.cleanup();
  }
});
test('a compaction that does not finish parks the scheduled start and refuses a manual one', async () => {
  const s = await setup();
  try {
    stopScheduler(s);
    await s.native.bind(s.channel.id, s.transport.threadId);
    s.native.compactWaitMs = 200;
    s.transport.compactFailure = 'hang';
    s.transport.emit(context(0.7));
    await s.native.startScheduled(s.channel.id, true);
    const channel = s.store.get<any>('channels', s.channel.id);
    assert.equal(channel.status, 'waiting');
    assert(Date.parse(channel.nextRunAt) > Date.now());
    assert.equal(s.transport.sent.length, 0);
    assert.deepEqual(s.transport.compactions, [s.transport.threadId]);
    await assert.rejects(s.native.startScheduled(s.channel.id, false), {
      message: 'Codex App 正在执行此任务，请等待当前轮次完成',
    });
    assert.equal(s.transport.compactions.length, 1);
  } finally {
    await s.cleanup();
  }
});
test('the boundary after a turn compacts once, and the next start waits it out instead of asking again', async () => {
  const s = await setup();
  try {
    stopScheduler(s);
    await s.native.bind(s.channel.id, s.transport.threadId);
    s.native.compactWaitMs = 200;
    await s.engine.action(s.channel.id, 'resume');
    assert.equal(s.transport.sent.length, 1);
    assert.deepEqual(s.transport.compactions, []);
    // The turn ends with the context nearly full; the App accepts the request and stays busy on it.
    s.transport.compactFailure = 'hang';
    s.transport.emit(context(0.7));
    completeWork(s, nextWork());
    assert.deepEqual(s.transport.compactions, [s.transport.threadId]);
    assert.equal(s.engine.control(s.channel.id).enabled, true);
    await s.native.startScheduled(s.channel.id, true);
    assert.equal(s.store.get<any>('channels', s.channel.id).status, 'waiting');
    assert.equal(s.transport.sent.length, 1);
    assert.equal(s.transport.compactions.length, 1);
    // Once the App finishes it, the next start proceeds and the reading asks for nothing more.
    s.transport.compactFailure = undefined;
    s.transport.emit({
      threadRuntimeStatus: { type: 'idle' },
      ...context(0.1),
      turns: [...s.transport.snapshot.state.turns, compactionTurn()],
    });
    await s.native.startScheduled(s.channel.id, true);
    assert.equal(s.transport.sent.length, 2);
    assert.equal(s.transport.compactions.length, 1);
  } finally {
    await s.cleanup();
  }
});
test("the App's own compaction is announced once, however often the task is read again", async () => {
  const s = await setup();
  try {
    await s.native.bind(s.channel.id, s.transport.threadId);
    const pending = compactionTurn('automatic');
    const announced = () =>
      s.store.all<any>('events').filter((row) => row.text.startsWith('Codex App 已压缩任务上下文'));
    s.transport.emit({ turns: [{ ...pending, items: [{ ...pending.items[0], completed: false }] }] });
    assert.equal(announced().length, 0);
    assert.equal(s.store.get<any>('native_bindings', s.channel.id).compactionsSeen, undefined);
    s.transport.emit({ turns: [pending] });
    s.transport.emit({ turns: [pending] });
    assert.equal(announced().length, 1);
    assert.equal(announced()[0].text, 'Codex App 已压缩任务上下文（自动）');
    assert.equal(s.store.get<any>('native_bindings', s.channel.id).compactionsSeen.length, 1);
  } finally {
    await s.cleanup();
  }
});
