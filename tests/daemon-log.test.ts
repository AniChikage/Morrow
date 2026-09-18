import './harness/env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { log, logError, setLogRedactor, setLogSink } from '../service/log.ts';
import { startIsolated } from './harness/service.ts';

/** The lines one stretch of work wrote, parsed, with the sink restored afterwards. */
async function captured(fn: () => Promise<void> | void): Promise<Array<Record<string, any>>> {
  const lines: string[] = [];
  setLogSink((line) => lines.push(line));
  try {
    await fn();
  } finally {
    setLogSink();
  }
  return lines.map((line) => JSON.parse(line));
}

test('the daemon log is one JSON line per lifecycle fact, redacted and bounded, and never fails a caller', async () => {
  const rows = await captured(() => {
    setLogRedactor((value) => value.replaceAll('a'.repeat(64), '[REDACTED]'));
    log('boot', { version: '0.9.6', port: 43821, storeMs: 12 });
    log('with.secret', { home: `/tmp/${'a'.repeat(64)}/Morrow` });
    log('bounded', { reason: 'x'.repeat(900) });
    log('dropped.undefined', { present: 1, absent: undefined });
    logError('schedule.failed', new Error('调度失败'), { channelId: 'c1' });
    logError('unhandled.rejection', 'a plain rejection value');
    // A field that cannot be serialized loses its own line and nothing else.
    const cyclic: any = {};
    cyclic.self = cyclic;
    log('unserializable', { cyclic });
    log('after.unserializable', {});
  });
  setLogRedactor((value) => value);
  assert.deepEqual(
    rows.map((row) => row.event),
    [
      'boot',
      'with.secret',
      'bounded',
      'dropped.undefined',
      'schedule.failed',
      'unhandled.rejection',
      'after.unserializable',
    ]
  );
  assert(rows.every((row) => typeof row.at === 'string' && !Number.isNaN(Date.parse(row.at))));
  assert.deepEqual(
    { version: rows[0].version, port: rows[0].port, storeMs: rows[0].storeMs },
    {
      version: '0.9.6',
      port: 43821,
      storeMs: 12,
    }
  );
  assert.equal(rows[1].home, '/tmp/[REDACTED]/Morrow');
  assert.equal(rows[2].reason.length, 501);
  assert.equal('absent' in rows[3], false);
  assert.deepEqual({ reason: rows[4].reason, channelId: rows[4].channelId }, { reason: '调度失败', channelId: 'c1' });
  assert.equal(rows[5].reason, 'a plain rejection value');
});

test('a booting daemon records its build, data directory and the runs recovery found interrupted', async () => {
  const rows = await captured(async () => {
    const s = await startIsolated({ project: { name: '日志', goal: '记录启动与关闭' } });
    try {
      // A run left running by a previous process is what recovery turns into `interrupted`.
      s.store.put('runs', {
        id: 'orphan-run',
        projectId: s.project.id,
        channelId: s.channel.id,
        status: 'running',
        startedAt: new Date().toISOString(),
      });
      const restarted = await s.restart();
      assert.equal(restarted.store.get<any>('runs', 'orphan-run').status, 'interrupted');
    } finally {
      await s.cleanup();
    }
  });
  const boots = rows.filter((row) => row.event === 'boot');
  assert.equal(boots.length, 2);
  for (const boot of boots) {
    assert(boot.home.length > 0);
    assert(boot.bootId.length > 0);
    assert.equal(typeof boot.storeMs, 'number');
    assert.equal(typeof boot.port, 'number');
  }
  // The first boot had nothing to recover; the second found the row the test left running.
  assert.equal(boots[0].interruptedRuns, 0);
  assert.equal(boots[1].interruptedRuns, 1);
  // No line carries a request body, query string or header — nothing here has a URL at all.
  assert(!rows.some((row) => JSON.stringify(row).includes('?')));
});

test('a native task that stops syncing leaves one line with its thread and reason', async () => {
  const rows = await captured(async () => {
    const s = await startIsolated({ project: { name: '日志', goal: '记录原生同步失败' }, scheduler: false });
    try {
      s.store.put('native_bindings', {
        id: s.channel.id,
        projectId: s.project.id,
        threadId: 'thread-that-stopped',
        cwd: s.path,
        createdAt: new Date().toISOString(),
      });
      s.native.recordError('thread-that-stopped', new Error('App disconnected'));
      // The channel timeline still carries it; the log is the second destination, not a move.
      assert.equal(s.store.get<any>('native_bindings', s.channel.id).syncError, 'App disconnected');
    } finally {
      await s.cleanup();
    }
  });
  const failed = rows.filter((row) => row.event === 'native.sync.failed');
  assert.equal(failed.length, 1);
  assert.deepEqual(
    { threadId: failed[0].threadId, reason: failed[0].reason },
    { threadId: 'thread-that-stopped', reason: 'App disconnected' }
  );
});

test('a scheduled channel that blocks itself, and an upgrade phase change, each leave one line', async () => {
  const rows = await captured(async () => {
    const s = await startIsolated({ project: { name: '日志', goal: '记录调度失败' }, scheduler: false });
    try {
      s.engine.failScheduled(s.channel.id, new Error('运行时不可用'));
      assert.equal(s.store.get<any>('channels', s.channel.id).status, 'blocked');
      // Phase changes are logged; a repeated save at the same phase is not.
      const record = {
        id: 'b'.repeat(64),
        releaseId: 'r1',
        targetCommit: 'c'.repeat(40),
        targetFingerprint: 'b'.repeat(64),
        installedBundle: '/Applications/Morrow.app',
        fromBootId: s.engine.upgrade.identity.bootId,
        phase: 'pending' as const,
        requestedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      s.engine.upgrade.save(record);
      s.engine.upgrade.save({ ...record, phase: 'draining' });
      s.engine.upgrade.save({ ...record, phase: 'draining', blockers: [{ kind: 'run', label: '频道正在执行' }] });
      s.engine.upgrade.save({ ...record, phase: 'blocked', error: '等待旧服务退出超时' });
    } finally {
      await s.cleanup();
    }
  });
  const scheduled = rows.filter((row) => row.event === 'schedule.failed');
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].reason, '运行时不可用');
  assert.deepEqual(
    rows.filter((row) => row.event === 'upgrade.phase').map((row) => row.phase),
    ['pending', 'draining', 'blocked']
  );
  assert.equal(
    rows.find((row) => row.event === 'upgrade.phase' && row.phase === 'blocked')?.error,
    '等待旧服务退出超时'
  );
});
