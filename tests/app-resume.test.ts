import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startIsolated, stopScheduler, type IsolatedService } from './harness/service.ts';
import { until } from './harness/wait.ts';
import type { NativeSnapshot, NativeTransport } from '../service/native-conversations.ts';
import type { AppResumeRecord, Channel, ChannelIntent, Run } from '../service/protocol.ts';

/**
 * Bounded replay of #32's first real occurrence: the saved shapes of the interrupted orchestrated
 * turn `263590d5…` and the App's own continuation `ca83b3e0…` (`turnTrigger =
 * resume_interrupted_task`), with their long texts trimmed. No Codex App, model or user repository
 * is involved: every turn below is appended to a fixture task and pushed through the service's own
 * native ingestion.
 */
const live = JSON.parse(readFileSync(new URL('./fixtures/app-resume-live01.json', import.meta.url), 'utf8'));
const [chatTemplate, orchestratedTemplate, resumeTemplate] = Object.values(
  live.state.turnHistory.history.entitiesByKey
) as any[];
const clone = (turn: any, fields: Record<string, unknown> = {}) => ({ ...structuredClone(turn), ...fields });
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

class ReplayNative implements NativeTransport {
  threadId = live.threadId;
  otherThreadId = randomUUID();
  cwd = '';
  turns: any[] = [];
  /** Whether the task reports its history as whole; `false` replays a partial page. */
  complete = true;
  sent: Array<{ text: string; requestId: string }> = [];
  interruptions: string[] = [];
  listeners = new Set<(snapshot: NativeSnapshot) => void>();
  revision = 1;
  backgroundReady = true;
  async connect() {}
  status() {
    return { connected: true, socketPath: '/app-resume-fixture.sock', lastError: null };
  }
  async listThreads(cwd: string) {
    return realpathSync(cwd) === realpathSync(this.cwd)
      ? [
          { id: this.threadId, title: '原生任务', cwd, updatedAt: Date.now() },
          { id: this.otherThreadId, title: '另一个原生任务', cwd, updatedAt: Date.now() },
        ]
      : [];
  }
  /** The saved thread state with this replay's turn list in task order. */
  state() {
    const keys = this.turns.map((_, index) => `tail:0:local:${index}`);
    const busy = this.turns.some((turn) => ['inProgress', 'running'].includes(turn.status));
    const history = live.state.turnHistory.history;
    return {
      ...live.state,
      cwd: this.cwd,
      threadRuntimeStatus: { type: busy ? 'active' : 'idle' },
      turnsPagination: { ...live.state.turnsPagination, hasLoadedOldest: this.complete },
      turnHistory: {
        ...live.state.turnHistory,
        history: {
          ...history,
          isComplete: this.complete,
          islands: [{ ...history.islands[0], entries: keys.map((key) => ({ key, value: key })) }],
          entitiesByKey: Object.fromEntries(keys.map((key, index) => [key, this.turns[index]])),
        },
      },
    };
  }
  snapshot(): NativeSnapshot {
    return {
      threadId: this.threadId,
      ownerClientId: 'app-resume-fixture',
      revision: this.revision,
      syncedAt: new Date().toISOString(),
      state: this.state(),
    };
  }
  async readThread(id: string) {
    if (id !== this.threadId) throw new Error('not found');
    return structuredClone(this.snapshot());
  }
  async subscribe(_id: string, listener: (snapshot: NativeSnapshot) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit() {
    this.revision++;
    const snapshot = structuredClone(this.snapshot());
    for (const listener of this.listeners) listener(snapshot);
  }
  async sendMessage(_id: string, text: string, requestId = '') {
    this.sent.push({ text, requestId });
    const turnId = randomUUID();
    this.turns.push(
      clone(orchestratedTemplate, {
        turnId,
        status: 'inProgress',
        params: { ...orchestratedTemplate.params, clientUserMessageId: requestId },
      })
    );
    this.emit();
    return { turn: { id: turnId } };
  }
  async interrupt(_id: string, turnId: string) {
    this.interruptions.push(turnId);
    this.finish(turnId, 'interrupted');
    return { ok: true };
  }
  async respond() {
    return { ok: true };
  }
  close() {
    this.listeners.clear();
  }
  /** Ends the named turn (or the last one) with a terminal native status and publishes it. */
  finish(turnId = this.turns.at(-1)?.turnId, status = 'interrupted') {
    const turn = this.turns.find((row) => row.turnId === turnId);
    if (turn) turn.status = status;
    this.emit();
    return turnId as string;
  }
  /** Appends a turn the App started by itself, carrying the real continuation marker. */
  append(template: any, fields: Record<string, unknown> = {}, emit = true) {
    const turn = clone(template, { turnId: randomUUID(), ...fields });
    this.turns.push(turn);
    if (emit) this.emit();
    return turn;
  }
  resume(status = 'completed', emit = true) {
    return this.append(resumeTemplate, { status }, emit);
  }
}

type Fixture = IsolatedService & { transport: ReplayNative };

async function setup(): Promise<Fixture> {
  const transport = new ReplayNative();
  const service = await startIsolated({
    nativeTransport: ({ path }) => Object.assign(transport, { cwd: path }),
    project: { name: 'App 续跑', goal: '验证 App 自行续跑后的有界恢复' },
    scheduler: false,
  });
  await service.native.bind(service.channel.id, transport.threadId);
  return Object.assign(service, { transport });
}
/** Starts one ordinary orchestrated turn with automatic work on, and returns its run. */
async function orchestratedTurn(s: Fixture) {
  await s.engine.action(s.channel.id, 'resume');
  return await until(() =>
    s.store.all<Run>('runs').find((run) => run.source === 'morrow-schedule' && run.status === 'running')
  );
}
const records = (s: Fixture) => s.store.all<AppResumeRecord>('app_resumes');
const record = (s: Fixture) => records(s).at(-1)!;
const channelRow = (s: Fixture) => s.store.get<Channel>('channels', s.channel.id)!;
const grantOf = (s: Fixture, runId: string) =>
  JSON.parse(readFileSync(join(s.home, 'runs', runId, 'agent-context.json'), 'utf8')) as {
    url: string;
    token: string;
  };
/** One work-interface call with a run's own grant, returning the HTTP status and body. */
async function callWith(grant: { url: string; token: string }, operation: string, requestId = randomUUID()) {
  const response = await fetch(grant.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${grant.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, input: {}, requestId }),
  });
  return { status: response.status, body: await response.json() };
}
/** Lets the channel's next wait fall due without touching the user's own intent. */
function dueNow(s: Fixture) {
  s.store.put('channels', { ...channelRow(s), nextRunAt: new Date(Date.now() - 1000).toISOString() });
}

test('one marked continuation of a single interrupted turn restores ordinary waiting only, and the next turn gets its own grant', async () => {
  const s = await setup();
  try {
    const run = await orchestratedTurn(s);
    const intent = run.workIntent!;
    assert.equal(intent.autonomyEnabled, true);
    assert.equal(intent.threadId, s.transport.threadId);
    assert.equal(intent.workDirection, s.channel.goal);
    assert.equal(intent.generation, s.engine.appResume.intent(s.channel.id).generation);
    const originalGrant = grantOf(s, run.id);
    s.transport.finish(run.nativeTurnId, 'interrupted');
    await until(() => s.store.get<Run>('runs', run.id)!.status === 'interrupted');
    // The interrupted turn is final: it keeps its own status, report state and channel pause.
    const interrupted = s.store.get<Run>('runs', run.id)!;
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.reportStatus, 'missing');
    assert.equal(channelRow(s).status, 'paused');
    assert.equal(s.engine.control(s.channel.id).enabled, false);
    const observed = record(s);
    assert.equal(observed.status, 'observing');
    assert.equal(observed.pauseCause, 'native-interrupt');
    assert.equal(observed.originalNativeTurnId, run.nativeTurnId);
    // The App continues by itself and completes.
    const resume = s.transport.resume('completed');
    await until(() => record(s).status === 'resumed');
    const linked = record(s);
    assert.equal(linked.relation, 'inferred-sequence');
    assert.equal(linked.marker, 'resume_interrupted_task');
    assert.equal(linked.resumeNativeTurnId, resume.turnId);
    assert.equal(linked.originalRunId, run.id);
    assert.ok(linked.basis.includes('adjacent-turn-order'));
    // Two runs, kept apart: the App's turn keeps its own native-app origin and terminal state.
    const resumeRun = s.store.get<Run>('runs', linked.resumeRunId!)!;
    assert.equal(resumeRun.source, 'native-app');
    assert.equal(resumeRun.status, 'completed');
    assert.equal(resumeRun.id !== run.id, true);
    assert.equal(s.store.get<Run>('runs', run.id)!.status, 'interrupted');
    assert.equal(s.store.get<Run>('runs', run.id)!.summary, interrupted.summary);
    // Only ordinary waiting is restored; nothing is sent and the scheduler decides when to run.
    assert.equal(channelRow(s).status, 'waiting');
    assert.equal(s.engine.control(s.channel.id).enabled, true);
    assert.equal(s.transport.sent.length, 1);
    assert.equal(s.transport.interruptions.length, 0);
    const restored = s.store.all<any>('events').filter((event) => event.action === 'channel.app-resume-restored');
    assert.equal(restored.length, 1);
    assert.match(restored[0].text, /App 续跑完成，下一轮核对其工作/);
    assert.equal(s.store.snapshot([]).channels[0].appResume!.state, 'resumed');
    // The next normal turn mints its own grant; the interrupted turn's grant stays refused.
    dueNow(s);
    s.engine.tick();
    const next = await until(() =>
      s.store
        .all<Run>('runs')
        .find((row) => row.source === 'morrow-schedule' && row.status === 'running' && row.id !== run.id)
    );
    const nextGrant = grantOf(s, next.id);
    assert.notEqual(nextGrant.token, originalGrant.token);
    assert.equal((await callWith(nextGrant, 'context')).status, 200);
    assert.equal((await callWith(originalGrant, 'context')).status, 409);
    assert.equal(next.workIntent!.generation, intent.generation);
  } finally {
    await s.cleanup();
  }
});

test('an unmarked turn, another task, a non-orchestrated predecessor, an incomplete history and several candidates never link or resume', async () => {
  const s = await setup();
  try {
    const run = await orchestratedTurn(s);
    s.transport.finish(run.nativeTurnId, 'interrupted');
    await until(() => record(s).status === 'observing');
    // Close in time but carrying no marker: an App turn seconds later is not a continuation.
    s.transport.append(chatTemplate, { status: 'completed' });
    await until(() => record(s).exclusions.length > 0);
    assert.equal(record(s).status, 'unconfirmed');
    assert.ok(record(s).exclusions.includes('no-resume-marker'));
    assert.equal(record(s).resumeRunId, undefined);
    assert.equal(channelRow(s).status, 'paused');
    // A later marked turn now has work in between, which the order alone cannot resolve.
    s.transport.resume('completed');
    await until(() => record(s).exclusions.includes('intervening-turns'));
    assert.equal(record(s).status, 'unconfirmed');
    assert.equal(channelRow(s).status, 'paused');
    assert.equal(s.engine.control(s.channel.id).enabled, false);
  } finally {
    await s.cleanup();
  }
  // Several marked candidates after the same interruption stay unconfirmed.
  const many = await setup();
  try {
    const run = await orchestratedTurn(many);
    many.transport.finish(run.nativeTurnId, 'interrupted');
    await until(() => record(many).status === 'observing');
    // Both marked turns arrive in one snapshot: the order alone cannot say which continues what.
    many.transport.resume('completed', false);
    many.transport.resume('completed');
    await until(() => record(many).exclusions.includes('multiple-candidates'));
    assert.equal(record(many).status, 'unconfirmed');
    assert.ok(record(many).exclusions.includes('multi-segment-resume'));
    assert.equal(channelRow(many).status, 'paused');
  } finally {
    await many.cleanup();
  }
  // A partial history page proves no order, so nothing links until the whole history is read.
  const partial = await setup();
  try {
    const run = await orchestratedTurn(partial);
    partial.transport.finish(run.nativeTurnId, 'interrupted');
    await until(() => record(partial).status === 'observing');
    partial.transport.complete = false;
    partial.transport.resume('completed');
    await until(() => record(partial).exclusions.includes('native-history-incomplete'));
    assert.equal(record(partial).status, 'unconfirmed');
    assert.equal(channelRow(partial).status, 'paused');
    // The same task read whole afterwards resolves the same turns.
    partial.transport.complete = true;
    partial.transport.emit();
    await until(() => record(partial).status === 'resumed');
    assert.equal(channelRow(partial).status, 'waiting');
  } finally {
    await partial.cleanup();
  }
  // A marked turn whose predecessor is a native chat turn is nobody's continuation record: there is
  // no interrupted orchestrated turn to recover, so nothing is observed at all.
  const chat = await setup();
  try {
    await chat.native.sync(chat.transport.threadId);
    chat.transport.append(chatTemplate, { status: 'interrupted' });
    chat.transport.resume('completed');
    await until(() => chat.store.all<Run>('runs').some((row) => row.status === 'completed'));
    assert.equal(records(chat).length, 0);
    assert.equal(channelRow(chat).status, 'paused');
    assert.equal(chat.engine.control(chat.channel.id).enabled, false);
  } finally {
    await chat.cleanup();
  }
  // A marked turn Morrow itself submitted is not the App continuing on its own.
  const owned = await setup();
  try {
    const run = await orchestratedTurn(owned);
    owned.transport.finish(run.nativeTurnId, 'interrupted');
    await until(() => record(owned).status === 'observing');
    const resume = owned.transport.resume('completed', false);
    owned.store.put('runs', {
      ...owned.store.get<Run>('runs', run.id)!,
      id: randomUUID(),
      nativeTurnId: resume.turnId,
      source: 'morrow-chat',
      status: 'completed',
    });
    owned.engine.appResume.observe(owned.transport.threadId, owned.transport.turns, true);
    assert.equal(record(owned).status, 'kept-paused');
    assert.ok(record(owned).exclusions.includes('resume-turn-not-app-owned'));
    assert.equal(channelRow(owned).status, 'paused');
  } finally {
    await owned.cleanup();
  }
  // A record is only ever matched against its own task, and a channel bound elsewhere is closed
  // rather than linked, even when the old task's history is replayed straight into the tracker.
  const other = await setup();
  try {
    const run = await orchestratedTurn(other);
    other.transport.finish(run.nativeTurnId, 'interrupted');
    await until(() => record(other).status === 'observing');
    other.transport.resume('completed', false);
    other.engine.appResume.observe(other.transport.otherThreadId, other.transport.turns, true);
    assert.equal(record(other).status, 'observing');
    assert.deepEqual(record(other).exclusions, []);
    other.store.put('native_bindings', {
      ...other.store.get<any>('native_bindings', other.channel.id),
      threadId: other.transport.otherThreadId,
    });
    other.engine.appResume.observe(other.transport.threadId, other.transport.turns, true);
    assert.equal(record(other).status, 'kept-paused');
    assert.ok(record(other).exclusions.includes('binding-changed'));
    assert.equal(channelRow(other).status, 'paused');
    assert.equal(other.engine.control(other.channel.id).enabled, false);
  } finally {
    await other.cleanup();
  }
});

test('a human pause wins before the interruption, after the candidate and around terminal processing, and a restart replays no send', async () => {
  const before = await setup();
  try {
    const run = await orchestratedTurn(before);
    // Pausing interrupts the running native turn; the cause is recorded as the person's, not the App's.
    await before.engine.action(before.channel.id, 'pause');
    await until(() => before.store.get<Run>('runs', run.id)!.status === 'interrupted');
    assert.deepEqual(before.transport.interruptions, [run.nativeTurnId]);
    assert.equal(record(before).pauseCause, 'human-pause');
    assert.equal(record(before).status, 'kept-paused');
    before.transport.resume('completed');
    await until(() => before.transport.turns.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(record(before).status, 'kept-paused');
    assert.equal(channelRow(before).status, 'paused');
    assert.equal(before.engine.control(before.channel.id).enabled, false);
    assert.equal(before.transport.sent.length, 1);
  } finally {
    await before.cleanup();
  }
  // A pause after the candidate was linked, while the App turn is still running.
  const during = await setup();
  try {
    const run = await orchestratedTurn(during);
    during.transport.finish(run.nativeTurnId, 'interrupted');
    await until(() => record(during).status === 'observing');
    const resume = during.transport.resume('inProgress');
    await until(() => record(during).status === 'linked');
    await during.engine.action(during.channel.id, 'pause');
    assert.equal(record(during).status, 'kept-paused');
    assert.ok(record(during).exclusions.includes('human-pause'));
    during.transport.finish(resume.turnId, 'completed');
    await until(() => during.store.all<Run>('runs').some((row) => row.status === 'completed'));
    assert.equal(record(during).status, 'kept-paused');
    assert.equal(channelRow(during).status, 'paused');
    assert.equal(during.engine.control(during.channel.id).enabled, false);
    assert.equal(during.transport.sent.length, 1);
  } finally {
    await during.cleanup();
  }
  // A pause that lands between the completed continuation and the recovery write, and the same
  // terminal state replayed after a restart.
  const restart = await setup();
  try {
    const run = await orchestratedTurn(restart);
    restart.transport.finish(run.nativeTurnId, 'interrupted');
    await until(() => record(restart).status === 'observing');
    const paused = record(restart);
    // A person pauses first; the completed continuation is only read afterwards.
    await restart.engine.action(restart.channel.id, 'pause');
    restart.transport.resume('completed');
    await until(() => restart.transport.turns.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(record(restart).id, paused.id);
    assert.equal(record(restart).status, 'kept-paused');
    assert.equal(channelRow(restart).status, 'paused');
    const sent = restart.transport.sent.length;
    const current = await restart.restart();
    stopScheduler(current);
    await until(() => current.store.get<any>('native_bindings', current.channel.id)?.lastSyncedAt);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = current.store.all<AppResumeRecord>('app_resumes').at(-1)!;
    assert.equal(after.status, 'kept-paused');
    assert.equal(current.store.get<Channel>('channels', current.channel.id)!.status, 'paused');
    assert.equal(current.engine.control(current.channel.id).enabled, false);
    assert.equal(restart.transport.sent.length, sent);
  } finally {
    await restart.cleanup();
  }
});

test('new guidance, a rebind, a permission or direction change, automatic work already off and a manual single run all invalidate the candidate', async () => {
  const guidance = await setup();
  try {
    const run = await orchestratedTurn(guidance);
    guidance.transport.finish(run.nativeTurnId, 'interrupted');
    await until(() => record(guidance).status === 'observing');
    await guidance.api('POST', `/api/channels/${guidance.channel.id}/native/messages`, {
      text: '先别继续，我换个方向',
      requestId: randomUUID(),
    });
    assert.equal(record(guidance).status, 'kept-paused');
    assert.ok(record(guidance).exclusions.some((reason) => reason.startsWith('intent-guidance')));
    assert.equal(guidance.engine.control(guidance.channel.id).enabled, false);
  } finally {
    await guidance.cleanup();
  }
  // Guidance that arrived inside the task after the App finished is the newer instruction.
  const later = await setup();
  try {
    const run = await orchestratedTurn(later);
    later.transport.finish(run.nativeTurnId, 'interrupted');
    await until(() => record(later).status === 'observing');
    later.transport.resume('completed', false);
    later.transport.append(chatTemplate, { status: 'completed' });
    await until(() => record(later).exclusions.includes('later-guidance'));
    assert.equal(record(later).status, 'kept-paused');
    assert.equal(channelRow(later).status, 'paused');
  } finally {
    await later.cleanup();
  }
  // Steering typed into the App's own continuation turn counts as guidance too.
  const steered = await setup();
  try {
    const run = await orchestratedTurn(steered);
    steered.transport.finish(run.nativeTurnId, 'interrupted');
    await until(() => record(steered).status === 'observing');
    const resume = steered.transport.resume('completed', false);
    resume.items = [
      ...resume.items,
      {
        id: randomUUID(),
        type: 'steeringUserMessage',
        status: 'accepted',
        content: [{ type: 'text', text: '先停一下' }],
      },
    ];
    steered.transport.emit();
    await until(() => record(steered).exclusions.includes('later-guidance'));
    assert.equal(record(steered).status, 'kept-paused');
    assert.equal(channelRow(steered).status, 'paused');
    assert.equal(steered.engine.control(steered.channel.id).enabled, false);
  } finally {
    await steered.cleanup();
  }
  // A changed work direction, project brief or permission is the user's own new intent.
  for (const change of ['direction', 'brief', 'permission'] as const) {
    const s = await setup();
    try {
      const run = await orchestratedTurn(s);
      s.transport.finish(run.nativeTurnId, 'interrupted');
      await until(() => record(s).status === 'observing');
      if (change === 'direction') await s.api('PATCH', `/api/channels/${s.channel.id}`, { goal: '换一个持续职责' });
      if (change === 'brief')
        await s.api('PATCH', `/api/projects/${s.project.id}`, { brief: '新的项目说明', revision: 0 });
      if (change === 'permission') await s.api('PATCH', `/api/channels/${s.channel.id}`, { permission: 'read-only' });
      s.transport.resume('completed');
      await until(() => record(s).status === 'kept-paused');
      assert.equal(channelRow(s).status, 'paused');
      assert.equal(s.engine.control(s.channel.id).enabled, false);
      assert.equal(s.transport.sent.length, 1);
    } finally {
      await s.cleanup();
    }
  }
  // Rebinding to another App task is the user choosing what this channel continues.
  const rebound = await setup();
  try {
    const run = await orchestratedTurn(rebound);
    rebound.transport.finish(run.nativeTurnId, 'interrupted');
    await until(() => record(rebound).status === 'observing');
    await rebound.api('POST', `/api/channels/${rebound.channel.id}/native/bind`, {
      threadId: rebound.transport.otherThreadId,
    });
    assert.equal(record(rebound).status, 'kept-paused');
    assert.ok(record(rebound).exclusions.includes('intent-bind'));
    assert.equal(channelRow(rebound).status, 'paused');
    assert.equal(rebound.engine.control(rebound.channel.id).enabled, false);
  } finally {
    await rebound.cleanup();
  }
  // A manual single run never had automatic work on, so its interruption never restores it.
  const manual = await setup();
  try {
    await manual.engine.action(manual.channel.id, 'run');
    const run = await until(() =>
      manual.store.all<Run>('runs').find((row) => row.source === 'morrow-schedule' && row.status === 'running')
    );
    assert.equal(run.trigger, 'manual');
    assert.equal(run.workIntent!.autonomyEnabled, false);
    manual.transport.finish(run.nativeTurnId, 'interrupted');
    await until(() => record(manual).status === 'observing');
    manual.transport.resume('completed');
    await until(() => record(manual).status === 'kept-paused');
    assert.ok(record(manual).exclusions.includes('autonomy-was-off'));
    assert.equal(channelRow(manual).status, 'paused');
    assert.equal(manual.engine.control(manual.channel.id).enabled, false);
  } finally {
    await manual.cleanup();
  }
});

test('a continuation that fails or is interrupted keeps the failure and the observation without resuming', async () => {
  for (const status of ['interrupted', 'failed'] as const) {
    const s = await setup();
    try {
      const run = await orchestratedTurn(s);
      s.transport.finish(run.nativeTurnId, 'interrupted');
      await until(() => record(s).status === 'observing');
      const resume = s.transport.resume(status);
      await until(() => record(s).status === 'kept-paused');
      assert.ok(record(s).exclusions.includes(`resume-turn-${status}`));
      assert.equal(record(s).relation, 'inferred-sequence');
      assert.equal(record(s).resumeNativeTurnId, resume.turnId);
      const resumeRun = s.store.get<Run>('runs', record(s).resumeRunId!)!;
      assert.equal(resumeRun.status, status);
      assert.equal(resumeRun.source, 'native-app');
      assert.equal(channelRow(s).status, 'paused');
      assert.equal(s.engine.control(s.channel.id).enabled, false);
      // Another marked turn after a failed continuation is a chain this version does not follow.
      s.transport.resume('completed');
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(record(s).status, 'kept-paused');
      assert.equal(channelRow(s).status, 'paused');
    } finally {
      await s.cleanup();
    }
  }
});

test('repeated, out-of-order and reconnect-completed history apply the recovery at most once, and history with no intent snapshot starts nothing', async () => {
  const s = await setup();
  try {
    const run = await orchestratedTurn(s);
    s.transport.finish(run.nativeTurnId, 'interrupted');
    await until(() => record(s).status === 'observing');
    const resume = s.transport.resume('completed');
    await until(() => record(s).status === 'resumed');
    const appliedAt = record(s).appliedAt;
    const waiting = channelRow(s).nextRunAt;
    // The same terminal state published again, and a whole-history reconnect, change nothing.
    for (let attempt = 0; attempt < 3; attempt++) s.transport.emit();
    await s.native.sync(s.transport.threadId);
    s.transport.complete = false;
    s.transport.emit();
    s.transport.complete = true;
    s.transport.emit();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(records(s).filter((row) => row.status === 'resumed').length, 1);
    assert.equal(record(s).appliedAt, appliedAt);
    assert.equal(channelRow(s).nextRunAt, waiting);
    assert.equal(
      s.store.all<any>('events').filter((event) => event.action === 'channel.app-resume-restored').length,
      1
    );
    assert.equal(s.store.all<any>('events').filter((event) => event.action === 'channel.app-resume-linked').length, 1);
    assert.equal(s.transport.sent.length, 1);
    assert.equal(record(s).resumeNativeTurnId, resume.turnId);
    // A person pausing after the recovery is the last word, and the replayed state cannot undo it.
    await s.engine.action(s.channel.id, 'pause');
    s.transport.emit();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(channelRow(s).status, 'paused');
    assert.equal(s.engine.control(s.channel.id).enabled, false);
    assert.equal(record(s).appliedAt, appliedAt);
  } finally {
    await s.cleanup();
  }
  // An interrupted turn with no intent snapshot is the shape of older rows: observed, never revived.
  const historical = await setup();
  try {
    const run = await orchestratedTurn(historical);
    historical.store.put('runs', { ...historical.store.get<Run>('runs', run.id)!, workIntent: undefined });
    delete (historical.native as any).scheduled.get(historical.channel.id).run.workIntent;
    historical.transport.finish(run.nativeTurnId, 'interrupted');
    await until(() => historical.store.get<Run>('runs', run.id)!.status === 'interrupted');
    historical.transport.resume('completed');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(records(historical).length, 0);
    assert.equal(channelRow(historical).status, 'paused');
    assert.equal(historical.engine.control(historical.channel.id).enabled, false);
    assert.equal(historical.store.snapshot([]).channels[0].appResume, undefined);
  } finally {
    await historical.cleanup();
  }
});

test("the interrupted turn's grant and request ids stay refused, and the App's report never reaches the board by itself", async () => {
  const s = await setup();
  try {
    const run = await orchestratedTurn(s);
    const grant = grantOf(s, run.id);
    const requestId = randomUUID();
    assert.equal((await callWith(grant, 'context', requestId)).status, 200);
    s.transport.finish(run.nativeTurnId, 'interrupted');
    await until(() => record(s).status === 'observing');
    // Every call on the finished run is refused, including a repeat of a request id it already used.
    for (const id of [requestId, randomUUID()]) {
      const refused = await callWith(grant, 'item.note', id);
      assert.equal(refused.status, 409);
      assert.match(refused.body.error, /本轮已结束/);
    }
    const items = s.store.all<any>('items').length;
    s.transport.resume('completed');
    await until(() => record(s).status === 'resumed');
    // The App's own turn stays native history: no board change, no report of its own.
    assert.equal(s.store.all<any>('items').length, items);
    const resumeRun = s.store.get<Run>('runs', record(s).resumeRunId!)!;
    assert.equal(resumeRun.reportStatus, 'missing');
    assert.equal(s.store.get('results', resumeRun.id), undefined);
    assert.equal((await callWith(grant, 'context', randomUUID())).status, 409);
  } finally {
    await s.cleanup();
  }
});

test('the restored wait still passes through the budget, review, upgrade-drain and working-tree gates', async () => {
  // Budget: the restored wait is an ordinary wait, so the daily cap still parks the channel.
  const budget = await setup();
  try {
    const run = await orchestratedTurn(budget);
    await budget.api('PATCH', `/api/channels/${budget.channel.id}`, { maxRunsPerDay: 1 });
    budget.transport.finish(run.nativeTurnId, 'interrupted');
    await until(() => record(budget).status === 'observing');
    // The direction and permission are untouched, so only the budget is in the way.
    budget.transport.resume('completed');
    await until(() => record(budget).status === 'resumed');
    dueNow(budget);
    budget.engine.tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(budget.transport.sent.length, 1);
    assert.equal(channelRow(budget).status, 'waiting');
    assert.ok(
      budget.store.all<any>('events').some((event) => /已达到每日预算/.test(event.text)),
      '预算门禁应写下等待原因'
    );
  } finally {
    await budget.cleanup();
  }
  // A queued review owns the frozen source, and a pending version switch drains first.
  const gated = await setup();
  try {
    const run = await orchestratedTurn(gated);
    gated.transport.finish(run.nativeTurnId, 'interrupted');
    await until(() => record(gated).status === 'observing');
    gated.transport.resume('completed');
    await until(() => record(gated).status === 'resumed');
    gated.store.put('loop_verifications', {
      id: randomUUID(),
      projectId: gated.project.id,
      channelId: gated.channel.id,
      runId: run.id,
      status: 'queued',
      startedAt: new Date().toISOString(),
    });
    dueNow(gated);
    gated.engine.tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(gated.transport.sent.length, 1);
    assert.equal(channelRow(gated).status, 'waiting');
    gated.store.db.exec('DELETE FROM loop_verifications');
    // A newly installed version drains first: the restored wait parks again instead of starting.
    gated.store.put('upgrades', {
      id: 'app-resume-upgrade',
      targetCommit: 'a'.repeat(40),
      targetFingerprint: 'app-resume-upgrade',
      fromBootId: gated.engine.upgrade.identity.bootId,
      phase: 'pending',
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    dueNow(gated);
    gated.engine.tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(gated.transport.sent.length, 1);
    assert.equal(channelRow(gated).status, 'waiting');
    assert.ok(
      gated.store.all<any>('events').some((event) => /新版本已安装/.test(event.text)),
      '升级排空应写下等待原因'
    );
  } finally {
    await gated.cleanup();
  }
  // Another channel's uncommitted changes in the one shared working tree still block the start.
  const tree = await setup();
  try {
    git(tree.path, 'init', '-q');
    git(tree.path, 'config', 'user.email', 'fixture@example.com');
    git(tree.path, 'config', 'user.name', 'Morrow Fixture');
    git(tree.path, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(tree.path, 'baseline.txt'), '基线\n');
    git(tree.path, 'add', '-A');
    git(tree.path, 'commit', '-q', '-m', 'fixture baseline');
    const run = await orchestratedTurn(tree);
    tree.transport.finish(run.nativeTurnId, 'interrupted');
    await until(() => record(tree).status === 'observing');
    tree.transport.resume('completed');
    await until(() => record(tree).status === 'resumed');
    const other = await tree.api(
      'POST',
      '/api/channels',
      { projectId: tree.project.id, name: '另一条方向', goal: '另一条方向的持续职责', runtime: 'codex' },
      201
    );
    tree.store.put('runs', {
      ...tree.store.get<Run>('runs', run.id)!,
      id: randomUUID(),
      channelId: other.id,
      source: 'morrow-schedule',
      status: 'completed',
      treeState: { dirty: true, files: ['work.txt'] },
    });
    writeFileSync(join(tree.path, 'work.txt'), '另一条方向未提交的改动');
    dueNow(tree);
    tree.engine.tick();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(tree.transport.sent.length, 1);
    assert.equal(channelRow(tree).status, 'waiting');
  } finally {
    await tree.cleanup();
  }
});

test('the durable intent generation survives a restart, so a pause before it cannot be forgotten', async () => {
  const s = await setup();
  try {
    const run = await orchestratedTurn(s);
    const generation = s.engine.appResume.intent(s.channel.id).generation;
    assert.equal(run.workIntent!.generation, generation);
    s.transport.finish(run.nativeTurnId, 'interrupted');
    await until(() => record(s).status === 'observing');
    await s.engine.action(s.channel.id, 'pause');
    const stored = s.store.get<ChannelIntent>('channel_intents', s.channel.id)!;
    assert.equal(stored.generation, generation + 1);
    assert.equal(stored.lastAction, 'pause');
    assert.ok(stored.pausedAt);
    const current = await s.restart();
    stopScheduler(current);
    // In-memory activation counters are gone after a restart; the record is not.
    assert.equal(current.engine.activationVersions.size, 0);
    assert.equal(current.engine.appResume.intent(current.channel.id).generation, generation + 1);
    assert.equal(current.store.get<ChannelIntent>('channel_intents', current.channel.id)!.lastAction, 'pause');
  } finally {
    await s.cleanup();
  }
});
