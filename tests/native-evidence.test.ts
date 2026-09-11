import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startIsolated } from './harness/service.ts';
import { FakeReviewer } from './harness/fake-reviewer.ts';
import { grantFor } from './harness/grant.ts';

async function setup() {
  const native = new FakeReviewer();
  const s = await startIsolated({ nativeTransport: native });
  const snapshot = await native.createThread(s.path);
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZAAAAABJRU5ErkJggg==';
  snapshot.state.turns = [
    {
      id: 'own-turn',
      status: 'completed',
      items: [
        {
          id: 'mcp-native-id',
          type: 'mcpToolCall',
          server: 'browser',
          tool: 'screenshot',
          arguments: { target: 'http://127.0.0.1/fixture', secret: 'hidden' },
          result: {
            content: [
              { type: 'text', text: 'fixture result' },
              { type: 'image', mimeType: 'image/png', data: image },
            ],
          },
          status: 'completed',
        },
      ],
    },
  ] as any;
  native.listThreads = async () => [
    {
      id: snapshot.threadId,
      title: 'fixture',
      cwd: s.path,
      updatedAt: Date.now(),
      createdAt: Date.now(),
      archived: false,
      model: null,
      source: 'fixture',
    },
  ];
  await s.native.bind(s.channel.id, snapshot.threadId);
  const row = s.store.nativeRows<any>('native_items', snapshot.threadId)[0];
  const grant = grantFor(s, {
    projectId: s.project.id,
    channelId: s.channel.id,
    overrides: { sessionId: snapshot.threadId, nativeTurnId: 'current-turn' },
  });
  return { ...s, grant, row, image };
}

test('native evidence copies actual projected MCP receipts, preserves inline images and survives projection removal and restart', async () => {
  const s = await setup();
  try {
    const feature = await s.grant.call('feature.upsert', {
      title: 'native evidence',
      summary: 'fixture',
      kind: 'feature',
      status: 'investigating',
      evidenceIds: [],
      nextStep: 'check',
    });
    const list = await s.grant.call('evidence.native');
    assert.equal(list.items[0].id, s.row.id);
    assert.equal(list.items[0].tool, 'browser/screenshot');
    const input = { itemId: feature.id, summary: 'MCP receipt', nativeItemIds: [s.row.id] };
    const linked = await s.grant.call('evidence.link', input, 200, 'link-one');
    assert.equal(linked.origin, 'native');
    assert.equal(linked.data, undefined);
    const evidence = await s.grant.call('evidence.read', { id: linked.id });
    assert.equal(evidence.data.items[0].tool, 'browser/screenshot');
    assert(evidence.source.includes('http://127.0.0.1/fixture'));
    assert(!evidence.data.items[0].input.text.includes('hidden'));
    assert.equal(evidence.data.images[0].dataUrl, `data:image/png;base64,${s.image}`);
    assert(s.store.get<any>('items', feature.id).evidence.some((v: string) => v.includes(linked.id)));
    s.store.put('native_items', { ...s.row, present: false, output: { content: [] } });
    assert.deepEqual(await s.grant.call('evidence.link', input, 200, 'link-one'), linked);
    await s.grant.call('evidence.link', input, 404, 'new-link-removed');
    const restarted = await s.restart();
    const next = grantFor(restarted, {
      projectId: s.project.id,
      channelId: s.channel.id,
      overrides: { sessionId: s.row.threadId, nativeTurnId: 'later-turn' },
    });
    assert.deepEqual(await next.call('evidence.read', { id: linked.id }), evidence);
  } finally {
    await s.cleanup();
  }
});

test('native discovery and linking reject foreign turns, tasks, invalid ranges and caller-supplied provenance atomically', async () => {
  const s = await setup();
  try {
    const other = await s.api(
      'POST',
      '/api/channels',
      { projectId: s.project.id, name: 'other', goal: 'other', runtime: 'codex' },
      201
    );
    const foreign = { ...s.row, id: randomUUID(), turnId: 'foreign-turn' };
    s.store.put('runs', { ...s.grant.run, id: randomUUID(), channelId: other.id, nativeTurnId: foreign.turnId });
    s.store.put('native_items', foreign);
    const otherTask = { ...s.row, id: randomUUID(), threadId: 'another-task' };
    s.store.put('native_items', otherTask);
    const initial = s.store.all('loop_evidence').length;
    for (const id of [foreign.id, otherTask.id, 'missing']) {
      await s.grant.call('evidence.link', { summary: 'invalid', nativeItemIds: [s.row.id, id] }, 404);
      await s.grant.call('evidence.native', { before: id }, 404);
    }
    assert.equal(s.store.all('loop_evidence').length, initial);
    const list = await s.grant.call('evidence.native');
    assert.deepEqual(
      list.items.map((i: any) => i.id),
      [s.row.id]
    );
    for (const ids of [[], Array(21).fill(s.row.id), [s.row.id, s.row.id]])
      await s.grant.call('evidence.link', { summary: 'invalid', nativeItemIds: ids }, 400);
    await s.grant.call('evidence.link', { summary: 'fake', nativeItemIds: [s.row.id], origin: 'execution' }, 400);
    s.store.put('native_bindings', { id: s.channel.id, threadId: 'changed-task' });
    await s.grant.call('evidence.native', {}, 404);
  } finally {
    await s.cleanup();
  }
});

test('native discovery filters before pagination and snapshots explicitly bound large output and images', async () => {
  const s = await setup();
  try {
    for (let i = 0; i < 25; i++) s.store.put('native_items', { ...s.row, id: `own-${i}` });
    for (let i = 0; i < 40; i++) s.store.put('native_items', { ...s.row, id: `foreign-${i}`, turnId: 'unassociated' });
    const first = await s.grant.call('evidence.native', { limit: 20 });
    assert.equal(first.items.length, 20);
    assert.equal(first.hasMore, true);
    const second = await s.grant.call('evidence.native', { before: first.cursor, limit: 20 });
    assert.equal(second.items.length, 6);
    assert.equal(second.hasMore, false);
    const long = { ...s.row, id: 'long', output: { text: 'x'.repeat(10000), token: s.token } };
    s.store.put('native_items', long);
    const linked = await s.grant.call('evidence.link', { summary: 'bounded', nativeItemIds: [long.id] });
    const data = (await s.grant.call('evidence.read', { id: linked.id })).data;
    assert.equal(data.items[0].output.truncated, true);
    assert.equal(data.items[0].output.text.length, 6000);
    assert(!JSON.stringify(data).includes(s.token));
    s.store.put('native_items', {
      ...s.row,
      id: 'huge-image',
      output: { content: [{ type: 'image', mimeType: 'image/png', data: 'a'.repeat(384 * 1024 + 1) }] },
    });
    await s.grant.call('evidence.link', { summary: 'too big', nativeItemIds: ['huge-image'] }, 413);
  } finally {
    await s.cleanup();
  }
});
