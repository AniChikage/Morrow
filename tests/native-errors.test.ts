import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startIsolated } from './harness/service.ts';
import { FakeReviewer } from './harness/fake-reviewer.ts';
import { NativeDesktopError } from '../service/codex-desktop-transport.ts';

test('unloaded native tasks have actionable API errors and redacted stacks; internal errors stay generic', async () => {
  const transport = new FakeReviewer();
  let failure: Error | undefined;
  const read = transport.readThread.bind(transport);
  transport.readThread = async (id) => {
    if (failure) throw failure;
    return read(id);
  };
  Object.assign(transport, { threadStatus: () => ({ ready: !failure }) });
  const s = await startIsolated({ nativeTransport: transport });
  const logs: string[] = [];
  const original = console.error;
  try {
    const thread = await transport.createThread(s.path);
    thread.state.currentPermissions = { sandboxPolicy: { type: 'readOnly' } };
    transport.listThreads = async () => [
      {
        id: thread.threadId,
        title: 'fixture',
        cwd: s.path,
        updatedAt: Date.now(),
        createdAt: Date.now(),
        archived: false,
        model: null,
        source: 'fixture',
      },
    ];
    await s.native.bind(s.channel.id, thread.threadId);
    console.error = (...args) => {
      logs.push(args.map(String).join(' '));
    };
    for (const [code, status] of [
      ['desktop_unavailable', 503],
      ['no-client-found', 409],
    ] as const) {
      failure = new NativeDesktopError(`请先在 Codex App 中打开此对话。${s.token}`, code);
      const native = await s.api('GET', '/api/native/status');
      assert.equal(native.boundThreadCount, 1);
      assert.equal(native.readyThreadCount, 0);
      for (const [path, body] of [
        ['action', { action: 'resume' }],
        ['native/messages', { text: 'private-message-body', requestId: randomUUID() }],
      ] as const) {
        const response = await s.api(
          'POST',
          `/api/channels/${s.channel.id}/${path}?private=private-query`,
          body,
          status
        );
        assert.equal(response.code, code);
        assert.equal(response.error, '请先在 Codex App 中打开此对话。[REDACTED]');
        assert.equal(response.outcomeUnknown, false);
      }
    }
    assert.equal(logs.length, 4);
    assert.ok(logs.every((log) => log.includes('[REDACTED]') && log.includes('\n') && log.includes('at ')));
    assert.ok(
      logs.every(
        (log) =>
          !log.includes(s.token) &&
          !log.includes('private-message-body') &&
          !log.includes('private-query') &&
          !log.includes('Bearer')
      )
    );
    assert.equal(transport.sent.length, 0);
    failure = new Error(`internal-fault ${s.token}`);
    const internal = await s.api(
      'POST',
      `/api/channels/${s.channel.id}/native/messages`,
      { text: 'fixture', requestId: randomUUID() },
      500
    );
    assert.equal(internal.error, '服务内部错误，请查看本机日志');
    assert.equal(logs.length, 5);
    assert.match(logs[4], /internal-fault \[REDACTED\]/);
    const count = logs.length;
    await s.api('POST', `/api/channels/${s.channel.id}/action`, { action: 'invalid' }, 400);
    assert.equal(logs.length, count);
    failure = undefined;
    const restored = await s.api('GET', `/api/channels/${s.channel.id}/native/conversation`);
    assert.equal(restored.threadId, thread.threadId);
    assert.equal(restored.syncError, undefined);
    assert.equal(transport.sent.length, 0);
  } finally {
    console.error = original;
    await s.cleanup();
  }
});
