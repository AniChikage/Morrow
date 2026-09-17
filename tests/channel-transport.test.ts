import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { invocation } from '../service/runtimes.ts';
import { usesApp } from '../service/protocol.ts';
import type { Channel } from '../service/protocol.ts';
import type { NativeSnapshot, NativeTransport } from '../service/native-conversations.ts';
import type { Verification } from '../service/verification-types.ts';
import { startIsolated } from './harness/service.ts';
import { until } from './harness/wait.ts';

/**
 * A background that is ready to create App tasks. Its only job here is to be available: a CLI-direct
 * Codex channel must never reach for it, and an App one still must.
 */
class ReadyBackground implements NativeTransport {
  backgroundReady = true;
  connected = true;
  created: string[] = [];
  threadId = randomUUID();
  snapshot(threadId = this.threadId): NativeSnapshot {
    return {
      threadId,
      ownerClientId: 'app',
      revision: 1,
      syncedAt: new Date().toISOString(),
      state: { turns: [], requests: [] },
    };
  }
  async connect() {}
  status() {
    return { connected: this.connected, socketPath: '/tmp/fake.sock', lastError: null };
  }
  async listThreads() {
    return [];
  }
  async createThread(cwd: string) {
    this.created.push(cwd);
    this.threadId = randomUUID();
    return this.snapshot();
  }
  async readThread(threadId: string) {
    return this.snapshot(threadId);
  }
  async subscribe() {
    return () => {};
  }
  async sendMessage() {
    return {};
  }
  async interrupt() {
    return {};
  }
  async respond() {
    return {};
  }
  close() {}
}

/** A queued review whose material can never be current, so `start` concludes it without a model. */
const staleReview = (projectId: string, channelId: string): Verification => ({
  id: randomUUID(),
  projectId,
  channelId,
  runId: randomUUID(),
  itemId: randomUUID(),
  evidenceIds: [],
  subjectHash: 'stale-subject',
  version: { digest: 'stale-digest', head: '', files: 0, bytes: 0, coverage: 'folder' },
  status: 'queued',
  summary: '等待独立复核',
  findings: [],
  checks: [],
  limitations: [],
  createdAt: new Date().toISOString(),
  prompt: '',
  bytes: 0,
  commandCount: 0,
  timeoutSeconds: 300,
});

test('transport is a channel field: only Codex carries one, and cli cannot follow App permissions', async () => {
  const s = await startIsolated({ project: { name: '传输方式', goal: '验证频道传输方式' } });
  try {
    // The project's own channel predates any choice: no transport stored, and it still means App.
    assert.equal(s.channel.transport, undefined);
    assert.equal(s.channel.permission, 'native');
    assert.equal(usesApp(s.channel), true);
    const base = { projectId: s.project.id, name: 'CLI 直连', goal: '不依赖 App 常驻' };
    await s.api('POST', '/api/channels', { ...base, runtime: 'codex', transport: 'bridge' }, 400);
    await s.api('POST', '/api/channels', { ...base, runtime: 'claude', transport: 'cli' }, 400);
    await s.api('POST', '/api/channels', { ...base, runtime: 'trae', transport: 'app' }, 400);
    // `native` means "inherit the App task's settings"; a channel with no App task has none.
    await s.api('POST', '/api/channels', { ...base, runtime: 'codex', transport: 'cli', permission: 'native' }, 400);
    const cli = await s.api('POST', '/api/channels', { ...base, runtime: 'codex', transport: 'cli' }, 201);
    assert.equal(cli.transport, 'cli');
    // Same default a Claude Code or Trae channel gets, for the same reason.
    assert.equal(cli.permission, 'workspace-write');
    assert.equal(usesApp(cli), false);
    await s.api('PATCH', `/api/channels/${cli.id}`, { permission: 'native' }, 400);
    await s.api('PATCH', `/api/channels/${cli.id}`, { transport: 'app', permission: 'native' }, 200);
    await s.api('PATCH', `/api/channels/${cli.id}`, { runtime: 'claude', transport: 'cli' }, 400);
    // A runtime that is not Codex has no transport to keep, and the permission falls with it.
    const moved = await s.api('PATCH', `/api/channels/${cli.id}`, { runtime: 'claude', permission: 'read-only' }, 200);
    assert.equal(moved.transport, undefined);
  } finally {
    await s.cleanup();
  }
});

test('switching transport starts a new session and says so, and is refused mid-turn', async () => {
  const s = await startIsolated({ project: { name: '切换传输', goal: '验证切换语义' }, scheduler: false });
  try {
    const cli = await s.api(
      'POST',
      '/api/channels',
      { projectId: s.project.id, name: 'CLI 直连', goal: '不依赖 App 常驻', runtime: 'codex', transport: 'cli' },
      201
    );
    s.store.put('channels', { ...s.store.get<Channel>('channels', cli.id)!, sessionId: 'codex-exec-session' });
    const before = s.store.all<any>('events').length;
    const switched = await s.api('PATCH', `/api/channels/${cli.id}`, { transport: 'app' }, 200);
    assert.equal(switched.transport, 'app');
    // The App thread id and the `codex exec` session id share one field, so neither can be reused.
    assert.equal(switched.sessionId, '');
    const events = s.store.all<any>('events').slice(before);
    assert(events.some((event) => event.text.includes('执行方式已切换为 Codex App 任务')));
    // Same shape as the runtime rule: a turn in flight owns the setting until it ends.
    writeFileSync(join(s.path, '.fixture.json'), JSON.stringify({ sleep: true }));
    await s.api('PATCH', `/api/channels/${cli.id}`, { transport: 'cli' }, 200);
    await s.api('POST', `/api/channels/${cli.id}/action`, { action: 'run' });
    await until(() => s.engine.active.has(cli.id));
    await s.api('PATCH', `/api/channels/${cli.id}`, { transport: 'app' }, 409);
    await s.api('POST', `/api/channels/${cli.id}/action`, { action: 'pause' });
  } finally {
    await s.cleanup();
  }
});

test('a CLI-direct Codex channel runs its own bounded turn and never creates an App task', async () => {
  const background = new ReadyBackground();
  const s = await startIsolated({
    nativeTransport: background,
    project: { name: 'CLI 直连轮次', goal: '验证直连路由' },
    scheduler: false,
  });
  try {
    const cli = await s.api(
      'POST',
      '/api/channels',
      { projectId: s.project.id, name: 'CLI 直连', goal: '不依赖 App 常驻', runtime: 'codex', transport: 'cli' },
      201
    );
    await s.api('POST', `/api/channels/${cli.id}/action`, { action: 'run' });
    await until(() => s.store.all<any>('runs').some((run) => run.channelId === cli.id && run.status === 'completed'));
    // The background was ready the whole time and was never asked for a task.
    assert.deepEqual(background.created, []);
    assert.equal(s.engine.native?.binding(cli.id), undefined);
    const run = s.store.all<any>('runs').find((row) => row.channelId === cli.id);
    // It spends the Codex account like any Codex turn, and it is not an App turn.
    assert.equal(run.runtime, 'codex');
    assert.notEqual(run.executionOwner, 'codex-app');
    const capture = JSON.parse(readFileSync(join(s.path, '.fixture-capture.json'), 'utf8'));
    assert(capture.args.includes('exec'));
    assert(capture.args.includes('sandbox_mode="workspace-write"'));
    assert(!capture.args.some((arg: string) => arg.includes('danger-full-access')));
    // Notes are this channel's only way in, so they stay open; the App routes have nothing to act on.
    await s.api('POST', `/api/channels/${cli.id}/messages`, { text: '先看导入流程' }, 201);
    await s.api('GET', `/api/channels/${cli.id}/native/conversation`, undefined, 409);
    await s.api('POST', `/api/channels/${cli.id}/native/bind`, { threadId: 'some-thread' }, 409);
    await s.api('POST', `/api/channels/${cli.id}/native/ensure`, {}, 409);
    // The App-transport channel of the same project still goes to the background for its task.
    await s.api('POST', `/api/channels/${s.channel.id}/action`, { action: 'run' }).catch(() => {});
    assert.equal(background.created.length, 1);
  } finally {
    await s.cleanup();
  }
});

test('an idle CLI-direct Codex channel does not hold its own review hostage', async () => {
  const s = await startIsolated({ project: { name: '复核门禁', goal: '验证空闲频道的复核' }, scheduler: false });
  try {
    const cli = await s.api(
      'POST',
      '/api/channels',
      { projectId: s.project.id, name: 'CLI 直连', goal: '不依赖 App 常驻', runtime: 'codex', transport: 'cli' },
      201
    );
    // Neither channel is running and neither has autonomy on — the state a CLI channel sits in
    // between turns, and the state an App channel is deliberately made to wait in.
    assert.equal(s.engine.control(cli.id).enabled, false);
    assert.equal(s.engine.control(s.channel.id).enabled, false);
    const direct = staleReview(s.project.id, cli.id);
    const app = staleReview(s.project.id, s.channel.id);
    s.store.put('loop_verifications', direct);
    s.store.put('loop_verifications', app);
    s.engine.loop.verification.tick();
    await Promise.allSettled([...s.engine.loop.pending]);
    // The turn that asked for this review is over and already paid for, so it starts; with stale
    // material it concludes at once, which is enough to show the gate let it through.
    assert.equal(s.store.get<Verification>('loop_verifications', direct.id)!.status, 'unknown');
    // The App channel keeps the old behaviour: its review waits until the channel is working again.
    assert.equal(s.store.get<Verification>('loop_verifications', app.id)!.status, 'queued');
  } finally {
    await s.cleanup();
  }
});

test('the full-access sandbox stays with the App transport', () => {
  const channel = { runtime: 'codex', permission: 'native', model: '', sessionId: '' } as Channel;
  const app = invocation(channel, 'run', 'output');
  assert(app.includes('sandbox_mode="danger-full-access"'));
  // A row that somehow carried both falls back to the sandbox, never to full access.
  const direct = invocation({ ...channel, transport: 'cli' }, 'run', 'output');
  assert(direct.includes('sandbox_mode="workspace-write"'));
  assert(direct.includes('sandbox_workspace_write.network_access=false'));
  assert(!direct.some((arg) => arg.includes('danger-full-access')));
});
