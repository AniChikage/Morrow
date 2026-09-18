import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeDesktopError } from '../service/codex-desktop-transport.ts';
import { FakeReviewer } from './harness/fake-reviewer.ts';
import { startIsolated } from './harness/service.ts';
import { until } from './harness/wait.ts';

async function setup() {
  const transport = new FakeReviewer();
  let failure: Error | undefined;
  const read = transport.readThread.bind(transport);
  transport.readThread = async (id) => {
    if (failure) throw failure;
    return read(id);
  };
  const s = await startIsolated({ nativeTransport: transport, scheduler: false });
  const thread = await transport.createThread(s.path);
  thread.state.currentPermissions = { sandboxPolicy: { type: 'readOnly' } };
  transport.listThreads = async () => [
    { id: thread.threadId, title: 'retry fixture', cwd: s.path, updatedAt: Date.now() },
  ];
  await s.native.bind(s.channel.id, thread.threadId);
  const due = () => {
    const channel = s.store.get<any>('channels', s.channel.id);
    s.store.put('channels', { ...channel, nextRunAt: new Date(Date.now() - 1000).toISOString() });
  };
  return {
    s,
    transport,
    thread,
    due,
    fail: (error?: Error) => {
      failure = error;
    },
  };
}

test('a disconnected scheduled preflight backs off without spending turns, then resumes the same task once', async () => {
  const f = await setup();
  const { s } = f;
  try {
    f.fail(new NativeDesktopError('App disconnected'));
    const start = Date.now();
    await s.engine.action(s.channel.id, 'resume');
    assert.equal(s.engine.control(s.channel.id).enabled, true);
    assert.equal(s.engine.control(s.channel.id).startRetry?.attempts, 1);
    let next = s.store.get<any>('channels', s.channel.id);
    assert.equal(next.status, 'waiting');
    assert(Date.parse(next.nextRunAt) >= start + 5000);
    for (let attempt = 2; attempt <= 8; attempt++) {
      await s.engine.start(s.channel.id, true);
      assert.equal(s.engine.control(s.channel.id).startRetry?.attempts, Math.min(attempt, 7));
      next = s.store.get<any>('channels', s.channel.id);
      assert(Date.parse(next.nextRunAt) - Date.now() <= 300000);
    }
    assert.equal(s.engine.budgetCount(s.channel.id), 0);
    assert.equal(s.store.all('native_outbox').length, 0);
    assert.equal(f.transport.sent.length, 0);
    assert.equal(s.store.all<any>('events').filter((e) => e.text.includes('连接暂不可用')).length, 1);
    f.fail();
    f.due();
    s.engine.tick();
    await until(() => f.transport.sent.length === 1);
    assert.equal(f.transport.sent[0].threadId, f.thread.threadId);
    assert.equal(s.native.binding(s.channel.id)?.threadId, f.thread.threadId);
    assert.equal(s.engine.control(s.channel.id).startRetry, undefined);
    s.engine.tick();
    assert.equal(f.transport.sent.length, 1);
    assert.equal(s.engine.budgetCount(s.channel.id), 1);
  } finally {
    await s.cleanup();
  }
});

test('native preflight backoff survives restart and manual pause cancels it', async () => {
  const f = await setup();
  const { s } = f;
  try {
    f.fail(new NativeDesktopError('read timed out', 'request_timeout'));
    await s.engine.action(s.channel.id, 'resume');
    const nextRunAt = s.store.get<any>('channels', s.channel.id).nextRunAt;
    await s.restart();
    assert.equal(s.engine.control(s.channel.id).enabled, true);
    assert.equal(s.engine.control(s.channel.id).startRetry?.attempts, 1);
    assert.equal(s.store.get<any>('channels', s.channel.id).nextRunAt, nextRunAt);
    await s.engine.action(s.channel.id, 'pause');
    f.fail();
    f.due();
    s.engine.tick();
    assert.equal(s.engine.control(s.channel.id).enabled, false);
    assert.equal(s.engine.control(s.channel.id).startRetry, undefined);
    assert.equal(f.transport.sent.length, 0);
  } finally {
    await s.cleanup();
  }
});

for (const outcome of ['connected', 'disconnected'] as const) {
  test(`a pause while the preflight is pending wins over its ${outcome} result`, async () => {
    const f = await setup();
    const { s } = f;
    let release!: () => void;
    try {
      const read = f.transport.readThread.bind(f.transport);
      let entered = false;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.transport.readThread = async (id) => {
        entered = true;
        await held;
        if (outcome === 'disconnected') throw new NativeDesktopError('App disconnected');
        return read(id);
      };
      const starting = s.engine.action(s.channel.id, 'resume');
      await until(() => entered);
      await s.engine.action(s.channel.id, 'pause');
      release();
      await starting;
      assert.equal(f.transport.sent.length, 0);
      assert.equal(s.engine.control(s.channel.id).enabled, false);
      assert.equal(s.store.get<any>('channels', s.channel.id).status, 'paused');
      assert.equal(s.store.get<any>('channels', s.channel.id).nextRunAt, '');
      assert.equal(s.engine.control(s.channel.id).startRetry, undefined);
    } finally {
      release?.();
      await s.cleanup();
    }
  });
}

test('only known read failures retry; permission, protocol, unknown and manual starts keep their refusal', async () => {
  const f = await setup();
  const { s } = f;
  try {
    for (const error of [
      new NativeDesktopError('not supported', 'protocol_mismatch'),
      new NativeDesktopError('permission denied', 'permission_denied'),
      new NativeDesktopError('connect EACCES /fixture.sock'),
      new NativeDesktopError('unknown result', 'request_timeout', true),
      new Error('unclassified internal error'),
    ]) {
      f.fail(error);
      s.engine.setControl(s.channel.id, { enabled: true });
      f.due();
      s.engine.tick();
      await until(() => !s.engine.control(s.channel.id).enabled);
      assert.equal(s.store.get<any>('channels', s.channel.id).status, 'blocked');
      assert.equal(s.engine.control(s.channel.id).startRetry, undefined);
    }
    f.fail(new NativeDesktopError('App disconnected'));
    await assert.rejects(s.engine.action(s.channel.id, 'run'), /App disconnected/);
    assert.equal(s.engine.control(s.channel.id).enabled, false);
    assert.equal(f.transport.sent.length, 0);
  } finally {
    await s.cleanup();
  }
});

test('a lost send acknowledgement after recovery stays unknown and is never resent', async () => {
  const f = await setup();
  const { s } = f;
  try {
    f.fail(new NativeDesktopError('App disconnected'));
    await s.engine.action(s.channel.id, 'resume');
    f.fail();
    let sends = 0;
    f.transport.sendMessage = async () => {
      sends++;
      throw new NativeDesktopError('ack lost', 'request_timeout', true);
    };
    f.due();
    s.engine.tick();
    await until(() => !s.engine.control(s.channel.id).enabled);
    assert.equal(sends, 1);
    assert.equal(s.store.all<any>('native_outbox')[0].state, 'unknown');
    assert.equal(s.store.get<any>('channels', s.channel.id).status, 'blocked');
    assert.equal(s.engine.control(s.channel.id).startRetry, undefined);
    f.due();
    s.engine.tick();
    assert.equal(sends, 1);
  } finally {
    await s.cleanup();
  }
});
