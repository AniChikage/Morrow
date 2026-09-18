import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Event, Runtime } from '../service/protocol.ts';
import type { BridgeRestore } from '../service/native-conversations.ts';
import { startIsolated } from './harness/service.ts';

/**
 * The two maintenance routes the desktop calls and nothing else exercised: re-detecting the Codex
 * runtime, and undoing the retired `CODEX_CLI_PATH` bridge. The restoration runs `launchctl`
 * against the user's login session, so the service takes it as an injected function and this file
 * supplies its own — the real one is never called here, and the route is still the one under test.
 */
type Restore = BridgeRestore & { calls: string[] };
/** A stand-in for the real restoration that records the home it was given. */
const fakeRestore = (result: { restartRequired: boolean; detail: string }): Restore => {
  const calls: string[] = [];
  const restore = ((home: string) => {
    calls.push(home);
    return result;
  }) as Restore;
  restore.calls = calls;
  return restore;
};

test('refreshing runtimes re-detects the CLI and replaces the reported list', async () => {
  const s = await startIsolated({ project: false });
  try {
    const before: Runtime[] = await s.api('POST', '/api/runtimes/refresh', {});
    assert.deepEqual(
      before.map((runtime) => runtime.id),
      ['codex', 'claude', 'trae']
    );
    const [codex] = before;
    assert.equal(codex.available, true);
    assert.equal(codex.canWrite, true);
    assert.equal(codex.version, 'fixture-runtime 1.0.0');
    assert.equal(codex.path, process.env.MORROW_TEST_CODEX_PATH);
    assert(before.every((runtime) => runtime.available && runtime.canWrite));
    // The route discovers again rather than returning what the daemon read at boot.
    s.engine.runtimes = [];
    const after: Runtime[] = await s.api('POST', '/api/runtimes/refresh', {});
    assert.deepEqual(after, before);
    assert.deepEqual(s.engine.runtimes, before);
    // And the polled snapshot serves the refreshed list, not a copy taken at boot.
    const state = await s.api('GET', '/api/state');
    assert.deepEqual(state.runtimes, before);
    await s.api('POST', '/api/runtimes/refresh', { id: 'codex' }, 400);
    await s.api('POST', '/api/runtimes/refresh', {}, 401, 'not-the-token');
  } finally {
    await s.cleanup();
  }
});

test('the retired background setup route stays refused while restoring reports what it undid', async () => {
  const restore = fakeRestore({ restartRequired: true, detail: '已撤销旧转接设置。' });
  const s = await startIsolated({ project: false, restoreBridge: restore });
  try {
    // Starting the service in test mode must not touch the login session on its own.
    assert.deepEqual(restore.calls, []);
    const refused = await s.api('POST', '/api/native/background/setup', {}, 410);
    assert.match(refused.error, /旧后台转接已退役/);
    assert.equal(s.store.get('migrations', 'codex-background-bridge'), undefined);

    const result = await s.api('POST', '/api/native/background/restore', {});
    assert.deepEqual(result, { restartRequired: true, detail: '已撤销旧转接设置。' });
    assert.deepEqual(restore.calls, [s.home]);
    const marker = s.store.get<{ enabled: boolean; restoredAt: string }>('migrations', 'codex-background-bridge')!;
    assert.equal(marker.enabled, false);
    assert.ok(marker.restoredAt);
    const audits = s.store
      .all<Event>('events')
      .filter((row) => row.action === 'native.background-restored')
      .map((row) => ({ actor: row.actor, projectId: row.projectId, channelId: row.channelId }));
    assert.deepEqual(audits, [{ actor: 'human', projectId: '', channelId: '' }]);
    await s.api('POST', '/api/native/background/restore', { confirm: true }, 400);
  } finally {
    await s.cleanup();
  }
});

test('restoring when nothing was configured still answers and records the human request', async () => {
  const restore = fakeRestore({
    restartRequired: false,
    detail: '未检测到 Morrow 旧转接启动设置，App 使用原连接方式。',
  });
  const s = await startIsolated({ project: false, restoreBridge: restore });
  try {
    const result = await s.api('POST', '/api/native/background/restore', {});
    assert.equal(result.restartRequired, false);
    assert.match(result.detail, /未检测到/);
    // Nothing changed on this Mac, but the person asked, so the marker and the audit row are written.
    assert.equal(s.store.get<{ enabled: boolean }>('migrations', 'codex-background-bridge')?.enabled, false);
    assert.equal(s.store.all<Event>('events').filter((row) => row.action === 'native.background-restored').length, 1);
    // Asking again is answered the same way; the one marker row is rewritten and each request is audited.
    await s.api('POST', '/api/native/background/restore', {});
    assert.deepEqual(restore.calls, [s.home, s.home]);
    assert.equal(s.store.all<Event>('events').filter((row) => row.action === 'native.background-restored').length, 2);
  } finally {
    await s.cleanup();
  }
});
