import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { NativeDesktopError } from '../service/codex-desktop-transport.ts';
import { ensureAppTaskFirstTurn, type NativeSnapshot, type NativeTransport } from '../service/native-conversations.ts';
import { codexAppLink } from '../desktop/main/codex-link.ts';
import { startIsolated } from './harness/service.ts';

class EnsureTransport implements NativeTransport {
  connected = true;
  cwd = '';
  threadId = randomUUID();
  catalog: Array<{ id: string; title: string; cwd: string; updatedAt: number }> = [];
  ownerReady = false;
  sent: string[] = [];
  snapshot: NativeSnapshot = {
    threadId: this.threadId,
    ownerClientId: 'app-owner',
    revision: 1,
    syncedAt: new Date().toISOString(),
    state: { turns: [], requests: [] },
  };
  async connect() {}
  status() {
    return { connected: this.connected, socketPath: '/isolated-ensure.sock', lastError: null };
  }
  threadStatus(threadId: string) {
    return {
      ready: this.ownerReady && threadId === this.threadId,
      detail: this.ownerReady ? '已同步原生任务。' : '尚未收到当前原生任务快照。',
    };
  }
  async listThreads(cwd: string) {
    return realpathSync(cwd) === realpathSync(this.cwd) ? this.catalog.map((row) => ({ ...row, cwd })) : [];
  }
  async readThread(id: string) {
    if (id !== this.threadId) throw new Error('not found');
    if (!this.ownerReady)
      throw new NativeDesktopError('请先在 Codex App 中打开此对话，再连接同步。', 'no-client-found');
    return structuredClone(this.snapshot);
  }
  async subscribe() {
    return () => {};
  }
  async sendMessage(_id: string, text: string, clientMessageId?: string) {
    this.sent.push(text);
    const turnId = randomUUID();
    this.snapshot = {
      ...this.snapshot,
      revision: this.snapshot.revision + 1,
      state: {
        ...this.snapshot.state,
        turns: [
          {
            turnId,
            status: 'completed',
            items: [
              { id: randomUUID(), type: 'userMessage', clientId: clientMessageId, content: [{ type: 'text', text }] },
            ],
          },
        ],
      },
    };
    return { turn: { id: turnId } };
  }
  async interrupt() {
    return {};
  }
  async respond() {
    return {};
  }
  close() {
    this.connected = false;
  }
}

async function setup() {
  const transport = new EnsureTransport();
  const opened: string[] = [];
  const s = await startIsolated({
    nativeTransport: ({ path }) => Object.assign(transport, { cwd: path }),
    openAppLink: async (url) => {
      opened.push(url);
    },
    project: { name: 'Ensure', goal: 'Prepare an App task' },
  });
  s.native.ensureTimeoutMs = 80;
  s.native.ensurePollMs = 10;
  return { ...s, transport, opened };
}

test('ensureAppTask deep-links a new task, binds the catalog row, waits for the owner, and sends the first turn', async () => {
  const s = await setup();
  try {
    const status = await s.api('GET', '/api/native/status');
    assert.equal(status.capabilities.create, false);
    assert.equal(s.native.transport.createThread, undefined);
    s.native.openAppLink = async (url) => {
      s.opened.push(url);
      s.transport.catalog = [{ id: s.transport.threadId, title: '新任务', cwd: s.project.path, updatedAt: Date.now() }];
      s.transport.ownerReady = true;
    };
    const conversation = await s.api('POST', `/api/channels/${s.channel.id}/native/ensure`, {});
    assert.equal(conversation.threadId, s.transport.threadId);
    assert.equal(s.opened.length, 1);
    assert.equal(s.opened[0], codexAppLink({ projectPath: s.project.path }));
    assert.match(s.opened[0], /^codex:\/\/threads\/new\?/);
    assert.equal(s.store.get<any>('native_bindings', s.channel.id).createdByMorrow, true);
    assert.deepEqual(s.transport.sent, [ensureAppTaskFirstTurn]);
    const actions = s.store.all<any>('events').map((event) => event.action);
    assert(actions.includes('native.ensure-requested'));
    assert(actions.includes('native.bound'));
  } finally {
    await s.cleanup();
  }
});

test('ensureAppTask times out clearly when the catalog never gains a row', async () => {
  const s = await setup();
  try {
    const failed = await s.api('POST', `/api/channels/${s.channel.id}/native/ensure`, {}, 504);
    assert.match(failed.error, /未在限定时间内写出此项目的任务目录/);
    assert.equal(s.store.get<any>('native_bindings', s.channel.id), undefined);
    assert.equal(s.opened.length, 1);
    assert.equal(s.transport.sent.length, 0);
  } finally {
    await s.cleanup();
  }
});

test('already-bound no-client-found restores via thread deep link and still sends an empty-task first turn', async () => {
  const s = await setup();
  try {
    s.transport.catalog = [{ id: s.transport.threadId, title: '已有任务', cwd: s.project.path, updatedAt: Date.now() }];
    s.transport.ownerReady = true;
    await s.native.bind(s.channel.id, s.transport.threadId);
    s.transport.ownerReady = false;
    s.transport.sent = [];
    s.native.openAppLink = async (url) => {
      s.opened.push(url);
      s.transport.ownerReady = true;
    };
    const conversation = await s.api('POST', `/api/channels/${s.channel.id}/native/ensure`, {});
    assert.equal(conversation.threadId, s.transport.threadId);
    assert.equal(s.opened.length, 1);
    assert.equal(s.opened[0], codexAppLink({ threadId: s.transport.threadId, projectPath: s.project.path }));
    assert.equal(s.opened[0], `codex://threads/${s.transport.threadId}`);
    assert.deepEqual(s.transport.sent, [ensureAppTaskFirstTurn]);
    const actions = s.store.all<any>('events').map((event) => event.action);
    assert(actions.includes('native.ensure-restore'));
  } finally {
    await s.cleanup();
  }
});

test('ensureAppTask times out clearly when the owner never becomes ready', async () => {
  const s = await setup();
  try {
    s.native.openAppLink = async (url) => {
      s.opened.push(url);
      s.transport.catalog = [{ id: s.transport.threadId, title: '新任务', cwd: s.project.path, updatedAt: Date.now() }];
    };
    const failed = await s.api('POST', `/api/channels/${s.channel.id}/native/ensure`, {}, 504);
    assert.match(failed.error, /未在限定时间内成为 owner/);
    assert.equal(s.transport.sent.length, 0);
    assert.equal(s.store.get<any>('native_bindings', s.channel.id)?.threadId, s.transport.threadId);
  } finally {
    await s.cleanup();
  }
});

test('CLI-direct channels still 409 on /native/ensure', async () => {
  const s = await setup();
  try {
    const cli = await s.api(
      'POST',
      '/api/channels',
      { projectId: s.project.id, name: 'CLI 直连', goal: '不走 App', runtime: 'codex', transport: 'cli' },
      201
    );
    const failed = await s.api('POST', `/api/channels/${cli.id}/native/ensure`, {}, 409);
    assert.match(failed.error, /直连 Codex CLI/);
    assert.equal(s.opened.length, 0);
    assert.equal(s.engine.native?.binding(cli.id), undefined);
  } finally {
    await s.cleanup();
  }
});
