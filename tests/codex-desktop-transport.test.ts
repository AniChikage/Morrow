import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CodexDesktopTransport, applyDesktopPatches, encodeDesktopFrame } from '../service/codex-desktop-transport.ts';

const threadId = 'native-thread-fixture';
const state = { id: threadId, cwd: '/fixture', latestModel: 'native-model', latestThreadSettings: { model: 'native-model', sandboxPolicy: { type: 'readOnly' } }, threadRuntimeStatus: { type: 'idle' }, turns: [{ turnId: 'turn-old', status: 'completed', items: [{ type: 'agentMessage', id: 'reply', text: 'native answer' }] }], requests: [{ id: 12, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: 'turn-new' } }] };
async function fixture(options: { dropMutation?: boolean; rejectMutation?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nohuman-desktop-ipc-')); chmodSync(dir, 0o700); const path = join(dir, 'ipc.sock');
  const messages: any[] = []; const sockets = new Set<Socket>(); let revision = 10, latest: Socket | null = null;
  const broadcast = (socket: Socket, change: any, version = 11) => socket.write(encodeDesktopFrame({ type: 'broadcast', method: 'thread-stream-state-changed', version, sourceClientId: 'app-owner', targetClientIds: ['nohuman-client'], params: { hostId: 'local', conversationId: threadId, change } }));
  const server = createServer(socket => { sockets.add(socket); latest = socket; let buffer: Buffer = Buffer.alloc(0); socket.on('close', () => sockets.delete(socket)); socket.on('data', chunk => { buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]); while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) { const size = buffer.readUInt32LE(0), message = JSON.parse(buffer.subarray(4, size + 4).toString()); buffer = buffer.subarray(size + 4); messages.push(message);
    const result = (body: any) => { const frame = encodeDesktopFrame({ type: 'response', requestId: message.requestId, resultType: 'success', method: message.method, handledByClientId: message.method === 'initialize' ? 'nohuman-client' : 'app-owner', result: body }); socket.write(frame.subarray(0, 3)); socket.write(frame.subarray(3)); };
    if (message.method === 'initialize') result({ clientId: 'nohuman-client' });
    else if (message.method === 'thread-owner-discovery') result({ supportsUntrustedAppInput: true });
    else if (message.method === 'thread-stream-following-changed' && message.params.following) broadcast(socket, { type: 'snapshot', revision: revision++, conversationState: state });
    else if (message.type === 'request') {
      if (message.method === 'thread-follower-steer-turn') {
        // Real desktop fun + Crn access this context before turn/steer dispatch.
        try { const restore = message.params.restoreMessage; const roots = restore.context.workspaceRoots; const comments = restore.context.commentAttachments; if (!Array.isArray(roots) || !Array.isArray(comments) || typeof restore.text !== 'string' || typeof restore.createdAt !== 'number') throw Error('Invalid native composer restore context'); }
        catch (error) { socket.write(encodeDesktopFrame({ type: 'response', requestId: message.requestId, resultType: 'error', error: (error as Error).message })); continue; }
      }
      if (options.dropMutation) socket.destroy(); else if (options.rejectMutation) socket.write(encodeDesktopFrame({ type: 'response', requestId: message.requestId, resultType: 'error', error: 'no-client-found' })); else result(message.method === 'thread-follower-start-turn' ? { result: { turn: { id: 'native-turn-accepted' } } } : { ok: true }); }
  } }); });
  await new Promise<void>(resolve => server.listen(path, resolve)); chmodSync(path, 0o600);
  const client = new CodexDesktopTransport({ socketPath: path, codexHome: dir, requestTimeoutMs: 1500, reconnectDelayMs: 5000 });
  return { client, messages, dir, patch: (change: any, version?: number) => broadcast(latest!, change, version), close: async () => { client.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); } };
}
const until = async (predicate: () => boolean) => { for (let i = 0; i < 50; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('fixture update timed out'); };

test('desktop follower attaches to the real owner protocol and applies ordered patches', async () => {
  const f = await fixture(); try {
    const snapshots: any[] = []; const unsubscribe = await f.client.subscribe(threadId, snapshot => snapshots.push(snapshot)); assert.equal(f.client.status().connected, true); assert.equal(snapshots.at(-1).state.turns[0].items[0].text, 'native answer');
    const base = snapshots.at(-1).revision; f.patch({ type: 'patches', baseRevision: base, revision: base + 1, patches: [{ op: 'replace', path: ['turns', 0, 'items', 0, 'text'], value: 'streamed update' }] }); await until(() => snapshots.at(-1).revision === base + 1); assert.equal(snapshots.at(-1).state.turns[0].items[0].text, 'streamed update');
    assert.equal(f.messages.some(message => message.method === 'thread-follower-start-turn'), false);
    unsubscribe(); await until(() => f.messages.some(message => message.method === 'thread-stream-following-changed' && !message.params.following));
  } finally { await f.close(); }
});

test('desktop send inherits native settings and approval responses match actual pending requests', async () => {
  const f = await fixture(); try {
    const result = await f.client.sendMessage(threadId, 'literal user input', 'user-message-stable'); assert.deepEqual(result, { turn: { id: 'native-turn-accepted' } });
    const message = f.messages.find(message => message.method === 'thread-follower-start-turn'); assert.equal(message.targetClientId, 'app-owner'); assert.equal(message.version, 2); assert.deepEqual(message.params.turnStart, { request: { threadId, input: [{ type: 'text', text: 'literal user input', text_elements: [] }], clientUserMessageId: 'user-message-stable' }, context: { inheritThreadSettings: true } });
    await f.client.respond(threadId, 12, 'command', 'decline'); const response = f.messages.find(message => message.method === 'thread-follower-command-approval-decision'); assert.equal(response.params.decision, 'decline'); await assert.rejects(() => f.client.respond(threadId, 12, 'file', 'accept'), /类型不匹配/);
    await f.client.interrupt(threadId, 'turn-exact'); const interruption = f.messages.find(message => message.method === 'thread-follower-interrupt-turn'); assert.equal(interruption.params.expectedTurnId, 'turn-exact'); assert.equal(interruption.version, 4);
  } finally { await f.close(); }
});

test('desktop transport resynchronizes revision gaps', async () => {
  const f = await fixture(); try {
    const snapshots: any[] = []; await f.client.subscribe(threadId, snapshot => snapshots.push(snapshot)); const before = f.messages.filter(message => message.params?.following === true).length;
    f.patch({ type: 'patches', baseRevision: 999, revision: 1000, patches: [] }); await until(() => f.messages.filter(message => message.params?.following === true).length > before); await until(() => snapshots.at(-1).revision > 10); assert.equal(snapshots.at(-1).state.turns[0].items[0].text, 'native answer');
  } finally { await f.close(); }
});

test('chat during an active native turn uses the existing App steer path', async () => {
  const f = await fixture(); try {
    let snapshot: any; await f.client.subscribe(threadId, value => { snapshot = value; });
    const base = snapshot.revision; f.patch({ type: 'patches', baseRevision: base, revision: base + 1, patches: [{ op: 'replace', path: ['threadRuntimeStatus'], value: { type: 'active' } }] }); await until(() => snapshot.revision === base + 1);
    await f.client.sendMessage(threadId, 'follow up while running', 'stable-followup');
    const steer = f.messages.find(message => message.method === 'thread-follower-steer-turn'); assert.equal(steer.params.conversationId, threadId); assert.equal(steer.params.clientUserMessageId, 'stable-followup'); assert.equal(steer.params.input[0].text, 'follow up while running'); assert.deepEqual(steer.params.restoreMessage.context.workspaceRoots, ['/fixture']); assert.equal(steer.params.restoreMessage.text, 'follow up while running'); assert.deepEqual(steer.params.restoreMessage.context.commentAttachments, []); assert.equal(f.messages.some(message => message.method === 'thread-follower-start-turn'), false);
  } finally { await f.close(); }
});

test('native image-only messages retain localImage input for both start and steer', async () => {
  const f = await fixture(); try {
    let snapshot: any; await f.client.subscribe(threadId, value => { snapshot = value; });
    await f.client.sendMessage(threadId, '', 'image-start', [{ path: '/private/fixture.png' }]);
    const start = f.messages.find(message => message.method === 'thread-follower-start-turn'); assert.deepEqual(start.params.turnStart.request.input, [{ type: 'localImage', path: '/private/fixture.png' }]);
    const base = snapshot.revision; f.patch({ type: 'patches', baseRevision: base, revision: base + 1, patches: [{ op: 'replace', path: ['threadRuntimeStatus'], value: { type: 'active' } }] }); await until(() => snapshot.revision === base + 1);
    await f.client.sendMessage(threadId, '', 'image-steer', [{ path: '/private/fixture.png' }]);
    const steer = f.messages.find(message => message.method === 'thread-follower-steer-turn'); assert.deepEqual(steer.params.input, [{ type: 'localImage', path: '/private/fixture.png' }]); assert.equal(steer.params.restoreMessage.context.imageAttachments[0].localPath, '/private/fixture.png');
    await assert.rejects(() => f.client.sendMessage(threadId, '', 'bad-path', [{ path: 'relative.png' }]), (error: any) => error.code === 'invalid_image');
  } finally { await f.close(); }
});

test('protocol mismatch invalidates the cached thread and prevents stale sends', async () => {
  const f = await fixture(); try {
    await f.client.subscribe(threadId, () => {}); assert.equal(f.client.threadStatus(threadId).ready, true);
    f.patch({ type: 'snapshot', revision: 100, conversationState: state }, 12); await until(() => !f.client.threadStatus(threadId).ready);
    assert.equal(f.client.status().connected, true); await assert.rejects(() => f.client.sendMessage(threadId, 'must not send'), (error: any) => error.code === 'protocol_mismatch'); assert.equal(f.messages.some(message => message.method === 'thread-follower-start-turn'), false);
  } finally { await f.close(); }
});

test('disconnect after native submission remains unknown and is never retried', async () => {
  const f = await fixture({ dropMutation: true }); try { await assert.rejects(() => f.client.sendMessage(threadId, 'one attempt'), (error: any) => error.outcomeUnknown === true); assert.equal(f.messages.filter(message => message.method === 'thread-follower-start-turn').length, 1); } finally { await f.close(); }
});

test('explicit native rejection is not misclassified as unknown delivery', async () => {
  const f = await fixture({ rejectMutation: true }); try { await assert.rejects(() => f.client.sendMessage(threadId, 'one attempt'), (error: any) => error.outcomeUnknown === false && error.code === 'no-client-found'); } finally { await f.close(); }
});

test('catalog stays read-only and only lists user tasks in the selected project', async () => {
  const f = await fixture(); try {
    const db = new DatabaseSync(join(f.dir, 'state_5.sqlite')); db.exec('CREATE TABLE threads (id TEXT,title TEXT,cwd TEXT,updated_at INTEGER,created_at INTEGER,archived INTEGER,source TEXT,model TEXT,agent_path TEXT)'); const insert = db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?)'); insert.run('right', 'Native', f.dir, 2, 1, 0, 'vscode', 'native-model', null); insert.run('other', 'Other', '/elsewhere', 2, 1, 0, 'vscode', 'native-model', null); insert.run('agent', 'Agent', f.dir, 2, 1, 0, 'subagent', 'native-model', '/root/research'); db.close();
    const rows = await f.client.listThreads(f.dir); assert.equal(rows.length, 1); assert.equal(rows[0].id, 'right'); assert.equal(rows[0].updatedAt, 2000);
  } finally { await f.close(); }
});

test('patch application guards prototype paths and handles native array operations', () => {
  const original = { items: ['a', 'c'] }; assert.deepEqual(applyDesktopPatches(original, [{ op: 'add', path: ['items', 1], value: 'b' }, { op: 'remove', path: ['items', 0] }]), { items: ['b', 'c'] }); assert.deepEqual(original.items, ['a', 'c']); assert.throws(() => applyDesktopPatches({}, [{ op: 'replace', path: ['__proto__', 'polluted'], value: true }])); assert.equal(({} as any).polluted, undefined);
});

test('copy-on-write patches retain old revisions and unchanged history object identity', () => {
  const olderItems = Array.from({ length: 1066 }, (_, index) => ({ id: `item-${index}`, text: `message ${index}` }));
  const initial = { history: { items: olderItems }, requests: [{ id: 'pending-request' }] };
  let current: any = initial;
  for (let revision = 0; revision < 100; revision++) {
    const previous = current;
    current = applyDesktopPatches(previous, [{ op: 'replace', path: ['history', 'items', 1065, 'text'], value: `delta ${revision}` }]);
    assert.equal(current.history.items[0], initial.history.items[0]);
    assert.equal(current.requests, initial.requests);
    assert.notEqual(current.history.items[1065], previous.history.items[1065]);
    assert.equal(previous.history.items[1065].text, revision ? `delta ${revision - 1}` : 'message 1065');
  }
  assert.equal(initial.history.items[1065].text, 'message 1065');
});

test('change subscriptions deliver every native patch in order without cloning unchanged history', async () => {
  const f = await fixture(); try {
    const received: Array<{ snapshot: any; change: any }> = [];
    const unsubscribe = await f.client.subscribeChanges(threadId, (snapshot, change) => received.push({ snapshot, change }));
    assert.equal(received.length, 1); const initial = received[0].snapshot;
    for (let index = 0; index < 25; index++) f.patch({ type: 'patches', baseRevision: 10 + index, revision: 11 + index, patches: [{ op: 'replace', path: ['turns', 0, 'items', 0, 'text'], value: `delta ${index}` }] });
    await until(() => received.length === 26);
    assert.deepEqual(received.slice(1).map(item => item.change.revision), Array.from({ length: 25 }, (_, index) => index + 11));
    assert.equal(received[25].snapshot.state.requests, initial.state.requests);
    assert.equal(initial.state.turns[0].items[0].text, 'native answer');
    assert.equal(received[1].snapshot.state.turns[0].items[0].text, 'delta 0');
    const publicCopy = await f.client.readThread(threadId); publicCopy.state.turns[0].items[0].text = 'caller mutation';
    assert.equal(received[25].snapshot.state.turns[0].items[0].text, 'delta 24');
    unsubscribe(); await until(() => f.messages.some(message => message.method === 'thread-stream-following-changed' && !message.params.following));
  } finally { await f.close(); }
});

test('large Unicode snapshots and following patches decode across native socket chunks', async () => {
  const f = await fixture(); try {
    const received: any[] = []; await f.client.subscribeChanges(threadId, snapshot => received.push(snapshot));
    const text = '原生流式记录🙂'.repeat(100_000);
    f.patch({ type: 'snapshot', revision: 11, conversationState: { ...state, largeOutput: text } });
    f.patch({ type: 'patches', baseRevision: 11, revision: 12, patches: [{ op: 'replace', path: ['turns', 0, 'items', 0, 'text'], value: 'after large frame' }] });
    await until(() => received.at(-1)?.revision === 12);
    assert.equal(received.find(snapshot => snapshot.revision === 11).state.largeOutput, text);
    assert.equal(received.at(-1).state.largeOutput, text);
    assert.equal(received.at(-1).state.turns[0].items[0].text, 'after large frame');
  } finally { await f.close(); }
});
