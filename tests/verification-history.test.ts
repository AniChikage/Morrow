import './harness/env.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { startIsolated } from './harness/service.ts';

test('desktop work includes quiet subjects and pages all review history with preserved evidence and scoped cursors', async () => {
  const s = await startIsolated();
  try {
    const itemA = randomUUID(),
      itemB = randomUUID();
    for (const id of [itemA, itemB])
      s.store.put('items', {
        id,
        projectId: s.project.id,
        channelId: s.channel.id,
        title: id,
        summary: '',
        status: 'open',
      });
    const add = (itemId: string, index: number) => {
      const id = randomUUID(),
        evidenceId = randomUUID();
      s.store.put('loop_evidence', {
        id: evidenceId,
        projectId: s.project.id,
        channelId: s.channel.id,
        itemId,
        runId: 'run',
        origin: 'file',
        summary: '历史证据',
        source: 'history.txt',
        data: `原文 ${index}`,
        createdAt: '2026-09-10T00:00:00Z',
      });
      const row = {
        id,
        projectId: s.project.id,
        channelId: s.channel.id,
        itemId,
        runId: 'run',
        status: 'failed',
        summary: `复核 ${index}`,
        evidenceIds: [evidenceId],
        subjectHash: 'unchanged',
        version: { digest: 'old-source', files: 1 },
        findings: [],
        checks: [],
        limitations: [],
        prompt: '不应返回的复核提示词',
        createdAt: new Date(Date.UTC(2026, 8, 10, 0, index)).toISOString(),
      };
      s.store.put('loop_verifications', row);
      return row;
    };
    const a = add(itemA, 0);
    const bs = Array.from({ length: 65 }, (_, i) => add(itemB, i + 1));
    const first = await s.api('GET', `/api/projects/${s.project.id}/work`);
    assert.ok(first.verifications.some((r: any) => r.id === a.id));
    assert.ok(first.verifications.some((r: any) => r.id === bs.at(-1)!.id));
    assert.equal(first.verifications.length, 31);
    assert.equal(first.verificationHistory.hasMore, true);
    assert.ok(first.verifications.every((r: any) => !('prompt' in r)));
    // The agent context/default view remains capped; the desktop explicitly opts into latest subjects.
    assert.equal(s.engine.loop.view(s.project.id).verifications!.length, 30);
    const found = new Set(first.verifications.map((r: any) => r.id));
    let page = first;
    while (page.verificationHistory.hasMore) {
      const before = page.verificationHistory.cursor;
      page = await s.api('GET', `/api/projects/${s.project.id}/work?verificationBefore=${before}`);
      assert.ok(page.verifications.length <= 30);
      assert.notEqual(page.verificationHistory.cursor, before);
      for (const row of page.verifications) {
        found.add(row.id);
        assert.ok(page.evidence.some((e: any) => e.id === row.evidenceIds[0] && e.data.startsWith('原文 ')));
      }
    }
    assert.equal(found.size, 66);
    assert.deepEqual(s.store.get('loop_verifications', a.id), a);
    await s.api('GET', `/api/projects/${s.project.id}/work?itemId=${itemB}&verificationBefore=${a.id}`, undefined, 404);
    await s.api('GET', `/api/projects/${s.project.id}/work?verificationBefore=${randomUUID()}`, undefined, 404);
    await s.api('GET', `/api/projects/${s.project.id}/work?verificationBefore=bad`, undefined, 400);
    const foreign = randomUUID();
    s.store.put('loop_verifications', { ...a, id: foreign, projectId: randomUUID() });
    await s.api('GET', `/api/projects/${s.project.id}/work?verificationBefore=${foreign}`, undefined, 404);
    await s.api(
      'GET',
      `/api/projects/${s.project.id}/work?verificationBefore=${a.id}&verificationBefore=${bs[0].id}`,
      undefined,
      400
    );
    s.engine.audit({ projectId: s.project.id, actor: 'human', action: 'test.changed', text: '项目记录更新' });
    const updated = await s.api('GET', `/api/projects/${s.project.id}/work`);
    assert.notEqual(updated.verificationHistory.revision, first.verificationHistory.revision);
  } finally {
    await s.cleanup();
  }
});

test('more than thirty independent subjects remain reachable beyond the bounded first page', async () => {
  const s = await startIsolated();
  try {
    const ids = [];
    for (let i = 0; i < 75; i++) {
      const row = {
        id: randomUUID(),
        projectId: s.project.id,
        channelId: s.channel.id,
        decisionId: randomUUID(),
        runId: 'run',
        status: 'unknown',
        summary: '历史',
        evidenceIds: [],
        subjectHash: 'old',
        version: { digest: 'old' },
        findings: [],
        checks: [],
        limitations: [],
        createdAt: '2026-09-10T00:00:00Z',
      };
      s.store.put('loop_verifications', row);
      ids.push(row.id);
    }
    const found = new Set();
    let before = '';
    for (let i = 0; i < 3; i++) {
      const page = await s.api(
        'GET',
        `/api/projects/${s.project.id}/work${before ? '?verificationBefore=' + before : ''}`
      );
      assert.ok(page.verifications.length <= 60);
      page.verifications.forEach((r: any) => found.add(r.id));
      before = page.verificationHistory.cursor;
      assert.equal(page.verificationHistory.hasMore, i < 2);
    }
    assert.equal(found.size, ids.length);
  } finally {
    await s.cleanup();
  }
});

test('release review groups cannot evict quiet item reviews from the first page', async () => {
  const s = await startIsolated();
  try {
    const itemA = randomUUID(),
      itemB = randomUUID();
    for (const id of [itemA, itemB])
      s.store.put('items', { id, projectId: s.project.id, channelId: s.channel.id, title: id, status: 'open' });
    const quiet = {
      id: randomUUID(),
      projectId: s.project.id,
      channelId: s.channel.id,
      itemId: itemA,
      runId: 'run',
      status: 'passed',
      summary: '低频事项',
      evidenceIds: [],
      subjectHash: 'old',
      version: { digest: 'old' },
      findings: [],
      checks: [],
      limitations: [],
      createdAt: '2026-09-10T00:00:00Z',
    };
    s.store.put('loop_verifications', quiet);
    const releases = Array.from({ length: 35 }, (_, i) => ({
      ...quiet,
      id: randomUUID(),
      itemId: undefined,
      kind: 'release',
      itemIds: [itemB, randomUUID()],
      createdAt: new Date(Date.UTC(2026, 8, 10, 0, i + 1)).toISOString(),
    }));
    for (const row of releases) s.store.put('loop_verifications', row);
    let page = await s.api('GET', `/api/projects/${s.project.id}/work`);
    assert(page.verifications.some((r: any) => r.id === quiet.id));
    assert.equal(page.verifications.length, 31);
    const found = new Set(page.verifications.map((r: any) => r.id));
    while (page.verificationHistory.hasMore) {
      page = await s.api(
        'GET',
        `/api/projects/${s.project.id}/work?verificationBefore=${page.verificationHistory.cursor}`
      );
      assert(page.verifications.length <= 30);
      page.verifications.forEach((r: any) => found.add(r.id));
    }
    assert.equal(found.size, 36);
    const pinned = s.engine.loop.verification.page(s.project.id, undefined, [releases[0].id], { includeLatest: true });
    assert(pinned.verifications.some((r) => r.id === quiet.id));
    assert(pinned.verifications.some((r) => r.id === releases[0].id));
    const scoped = await s.api('GET', `/api/projects/${s.project.id}/work?itemId=${itemA}`);
    assert.deepEqual(
      scoped.verifications.map((r: any) => r.id),
      [quiet.id]
    );
    assert.deepEqual(s.store.get('loop_verifications', quiet.id), quiet);
    for (const row of releases)
      assert.deepEqual(s.store.get('loop_verifications', row.id), JSON.parse(JSON.stringify(row)));
  } finally {
    await s.cleanup();
  }
});
